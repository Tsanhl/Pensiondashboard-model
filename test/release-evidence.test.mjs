import assert from "node:assert/strict";
import test from "node:test";
import { assessFrozenSlice } from "../scripts/lib/releaseEvidence.mjs";

function fixture() {
  const identity = { id: "pinned", adapter_sha256: "adapter", base_sha256: "base", worker_sha256: "worker", supervisor_sha256: "supervisor" };
  return { expectedIds: ["a", "b"], expectedIdentity: { id: "pinned", adapter_sha256: "adapter", base_sha256: "base" },
    resultsSha256: "result-hash", manifest: { results_sha256: "result-hash", model: { service_health: { body: { data: [identity] } } } },
    results: { results: ["a", "b"].map((question_id) => ({ question_id, model_call_attempted: true, runtime_identity: { ...identity }, selected_route: "ANSWER" })) },
    scorecard: { results_sha256: "result-hash", items: ["a", "b"].map((question_id) => ({ question_id, status: "pass" })) } };
}
test("release evidence requires exact IDs, bound score artifacts and actual pinned runtime", () => {
  assert.equal(assessFrozenSlice(fixture()).passed, true);
  for (const mutate of [
    (f) => { f.results.results[1].question_id = "a"; },
    (f) => { f.scorecard.items[1].question_id = "c"; },
    (f) => { delete f.scorecard.results_sha256; },
    (f) => { f.manifest.results_sha256 = "old-run"; },
    (f) => { delete f.results.results[0].runtime_identity; },
    (f) => { delete f.results.results[0].model_call_attempted; },
    (f) => { f.results.results[0].runtime_identity.adapter_sha256 = "other"; },
    (f) => { f.results.results[0].selected_route = "RUN_ERROR"; },
    (f) => { f.scorecard.items[0].status = "critical_fail"; },
  ]) { const f = fixture(); mutate(f); assert.equal(assessFrozenSlice(f).passed, false); }
});
