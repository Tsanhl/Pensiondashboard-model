import assert from "node:assert/strict";
import test from "node:test";

process.env.LOCAL_LLM_MODEL = "test-pinned";
process.env.LOCAL_LLM_TRANSPORT = "openai";
process.env.LOCAL_LLM_EXPECTED_ADAPTER_SHA256 = "selected-adapter";
process.env.LOCAL_LLM_EXPECTED_BASE_SHA256 = "selected-base";
const { generateLocalAnswer, localModelStatus } = await import("../server/services/localModelService.js");
const identity = { id: "test-pinned", adapter_sha256: "selected-adapter", base_sha256: "selected-base" };
function mockFetch(t, payload) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json(payload);
  t.after(() => { globalThis.fetch = original; });
}

test("model health does not advertise a mismatched adapter as available", async (t) => {
  mockFetch(t, { data: [{ ...identity, adapter_sha256: "wrong" }] });
  assert.equal((await localModelStatus()).available, false);
});

test("malformed JSON fails closed while preserving raw output and finish metadata for audit", async (t) => {
  const raw = '{"answer":"unfinished';
  mockFetch(t, { runtime_identity: identity, choices: [{ message: { content: raw }, finish_reason: "length" }], usage: { completion_tokens: 400 } });
  await assert.rejects(generateLocalAnswer({ system: "Test", messages: [] }), (error) => {
    assert.equal(error.code, "MODEL_INVALID_OUTPUT");
    assert.equal(error.modelResponse.rawContent, raw);
    assert.equal(error.modelResponse.finishReason, "length");
    assert.equal(error.modelResponse.runtimeIdentity.adapter_sha256, "selected-adapter");
    return true;
  });
});

test("a model response from a different adapter is rejected even if its JSON is valid", async (t) => {
  mockFetch(t, { runtime_identity: { ...identity, adapter_sha256: "wrong" }, choices: [{ message: { content: '{"answer":"ok","citation_ids":[]}' } }] });
  await assert.rejects(generateLocalAnswer({ system: "Test", messages: [] }), { code: "MODEL_IDENTITY_MISMATCH" });
});

test("the client expands request-local aliases but retains the exact raw model output", async (t) => {
  const raw = '{"answer":"Supported. {{cite:S1}}","citation_ids":["S1"]}';
  mockFetch(t, { runtime_identity: identity, choices: [{ message: { content: raw }, finish_reason:"stop" }] });
  const result = await generateLocalAnswer({ system:"Test", messages:[], citationAliases:{ S1:"canonical-chunk" } });
  assert.equal(result.rawContent, raw);
  assert.equal(result.answer, "Supported. {{cite:canonical-chunk}}");
  assert.deepEqual(result.citationIds, ["canonical-chunk"]);
});
