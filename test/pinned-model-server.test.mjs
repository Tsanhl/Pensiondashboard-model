import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createPinnedModelServer } from "../server/services/pinnedModelServer.js";
import { assertModelIdentity } from "../server/services/modelIdentityService.js";

async function setup(t, deadlineMs = 1000) {
  const service = createPinnedModelServer({ command: process.execPath, args: [resolve("test/fixtures/pinned-worker.mjs")], deadlineMs, startupMs: 5000 });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(() => service.stop());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const health = async () => (await fetch(`${url}/health`)).json();
  const waitReady = async (oldPid) => {
    for (let i = 0; i < 200; i++) {
      const value = await health();
      if (value.ready && (!oldPid || value.worker_pid !== oldPid)) return value;
      await delay(10);
    }
    throw new Error("Worker did not become ready");
  };
  await waitReady();
  const post = (content = "ok", overrides = {}, signal) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: "test-pinned", messages: [{ role: "user", content }], ...overrides }),
  });
  return { post, health, waitReady, url };
}

test("pinned runtime advertises and returns actual identity; rejects overrides", async (t) => {
  const { post, url } = await setup(t);
  const models = await (await fetch(`${url}/v1/models`)).json();
  assert.equal(models.data.length, 1);
  assert.equal(models.data[0].adapter_sha256, "test-adapter");
  for (const override of [{ model: "base-only" }, { adapters: "other" }, { stream: true }, { max_tokens: 9000 }, { temperature: "bad" }]) {
    assert.equal((await post("ok", override)).status, 400);
  }
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runtime_identity.adapter_sha256, "test-adapter");
});

test("deadline terminates worker, rejects a concurrent request, then recovers", async (t) => {
  const { post, health, waitReady } = await setup(t, 200);
  const before = await health();
  const hanging = post("hang");
  for (let i = 0; i < 50 && !(await health()).busy; i++) await delay(5);
  assert.equal((await post()).status, 503);
  assert.equal((await hanging).status, 504);
  const after = await waitReady(before.worker_pid);
  assert.notEqual(after.worker_pid, before.worker_pid);
  assert.equal((await post()).status, 200);
});

test("client disconnect cancels the active worker instead of leaving queued generation", async (t) => {
  const { post, health, waitReady } = await setup(t, 5000);
  const before = await health();
  const controller = new AbortController();
  const request = post("hang", {}, controller.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  for (let i = 0; i < 50 && !(await health()).busy; i++) await delay(5);
  controller.abort();
  await rejected;
  const after = await waitReady(before.worker_pid);
  assert.equal(after.busy, false);
  assert.equal((await post()).status, 200);
});

test("missing or mismatched adapter identity fails closed", () => {
  assert.throws(() => assertModelIdentity(null, { adapter_sha256: "selected" }), { code: "MODEL_IDENTITY_MISMATCH" });
  assert.throws(() => assertModelIdentity({ adapter_sha256: "base" }, { adapter_sha256: "selected" }), /identity mismatch/);
  assertModelIdentity({ adapter_sha256: "selected" }, { adapter_sha256: "selected" });
});
