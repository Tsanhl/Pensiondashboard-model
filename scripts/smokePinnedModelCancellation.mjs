import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const base = "http://127.0.0.1:8080";
const health = async () => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).json();
const before = await health();
assert.ok(before.ready && !before.busy, "Run only on an idle local pinned model service");
const controller = new AbortController();
const started = performance.now();
const pending = fetch(`${base}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
  body: JSON.stringify({ model: before.identity.id, max_tokens: 512, temperature: 0,
    messages: [{ role: "system", content: "Cancellation smoke test. ".repeat(800) },
      { role: "user", content: "Write a very long explanation of sorting algorithms." }] }),
}).then((response) => ({ status: response.status }), (error) => ({ error: error.name }));
let active = false;
for (let i = 0; i < 50; i++) {
  if ((await health()).busy) { active = true; break; }
  await delay(100);
}
controller.abort();
const aborted = await pending;
assert.ok(active, "Request must be observed active before cancellation");
assert.equal(aborted.error, "AbortError");
let after = null, observedNotReady = false;
for (let i = 0; i < 300; i++) {
  const state = await health();
  observedNotReady ||= !state.ready;
  if (state.ready && state.worker_pid !== before.worker_pid) { after = state; break; }
  await delay(100);
}
assert.ok(after, "Cancelled MLX worker must exit and a new pinned worker must become ready");
assert.equal(after.busy, false);
assert.deepEqual(after.identity, before.identity);
const recoveredMs = Math.round(performance.now() - started);
const response = await fetch(`${base}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
  body: JSON.stringify({ model: after.identity.id, temperature: 0, max_tokens: 64,
    messages: [{ role: "system", content: "Return JSON only." },
      { role: "user", content: 'Return exactly {"answer":"ready","citation_ids":[]}.' }] }),
});
assert.equal(response.status, 200);
const recovered = await response.json();
assert.equal(recovered.runtime_identity.adapter_sha256, before.identity.adapter_sha256);
assert.ok(recovered.choices?.[0]?.message?.content);
console.log(JSON.stringify({ passed: true, completed_at: new Date().toISOString(),
  active_request_observed: active, client_abort: aborted.error,
  old_worker_pid: before.worker_pid, new_worker_pid: after.worker_pid,
  worker_replaced_and_ready_ms: recoveredMs, not_ready_observed: observedNotReady,
  recovery_request_http_status: response.status, adapter_sha256: before.identity.adapter_sha256,
  recovery_usage: recovered.usage, recovery_runtime_metrics: recovered.runtime_metrics,
  scope: "Local cancellation smoke only; no pension cases or unseen data" }, null, 2));
