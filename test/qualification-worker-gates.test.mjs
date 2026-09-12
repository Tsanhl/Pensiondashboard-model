import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { casesFromScorecard,prepareLive50Cases, validateConfig, validateLive50, validateT4Summary, validateTopic161Summary } from "../scripts/lib/qualification-worker/gateValidators.mjs";
import { inspectReplacementV2Identity } from "../scripts/lib/qualification-worker/stageRegistry.mjs";
import { sha256Buffer } from "../scripts/lib/qualification-worker/utils.mjs";

test("70 score floor cannot override mandatory factual gates", async () => {
  const config = JSON.parse(readFileSync(new URL("../config/qualification-worker.json",import.meta.url),"utf8"));
  assert.equal(validateConfig(config).passed, true);
  for (const [key,value] of [["model_max_tokens",191],["context_source_limit",5],["retrieval_threads",7],["embedding_warmup_timeout_ms",1]]) {
    const changed = structuredClone(config);
    changed.runtime[key] = value;
    assert.equal(validateConfig(changed).passed,false,`${key} must be exact, not merely positive`);
  }
  config.quality.minimum_score = 69;
  assert.equal(validateConfig(config).passed, false);
});

test("visible cases qualify only when the exact answer came from canonical HTTP chat", () => {
  const answerSha = sha256Buffer("Served answer");
  const receipt = { sha256:"b".repeat(64),raw_sha256:"c".repeat(64),served_answer_sha256:answerSha };
  const scorecard = { items:[{ question_id:"q1",status:"pass",critical_failure_signals:[],substantive_failure_signals:[],served_response_verified:true,served_answer_sha256:answerSha,served_response_receipt_sha256:receipt.sha256,served_raw_response_sha256:receipt.raw_sha256 }] };
  const base = { question_id:"q1",question:"Question",final_system_answer:"Served answer",review_answer:"Served answer",selected_route:"ANSWER" };
  assert.equal(casesFromScorecard({ results:[base] },scorecard)[0].deterministic_pass,false);
  const served = { ...base,qualification_context_applied:false,qualification_context_sha256:null,served_via_canonical_chat:true,served_response_sha256:answerSha,served_response_receipt:receipt,response_route_source:"CANONICAL_HTTP_CHAT_RESPONSE" };
  assert.equal(casesFromScorecard({ results:[served] },scorecard)[0].deterministic_pass,true);
  assert.equal(casesFromScorecard({ results:[{ ...served,final_system_answer:"Changed answer" }] },scorecard)[0].deterministic_pass,false);
});


test("T4 gate requires every source failure and prior-positive control", () => {
  const items = [
    ...Array.from({ length: 13 }, (_, i) => ({ question_id: `s${i}`, role: "source_failure", status: "pass" })),
    ...Array.from({ length: 14 }, (_, i) => ({ question_id: `p${i}`, role: "prior_positive", status: "pass" })),
  ];
  const summary = { waves: [{ items, run_errors: 0 }] };
  assert.equal(validateT4Summary(summary).passed, true);
  items[20].status = "partial";
  assert.equal(validateT4Summary(summary).passed, false);
});

test("topic161 requires 90 overall, 85 per wave, 85 per topic and zero errors", () => {
  const wave = (name, total, passing) => {
    const items = Array.from({ length:total },(_, index) => ({ question_id:`${name}-${index + 1}`,status:index < passing ? "pass" : "fail" }));
    return { wave:name,processed:total,outcomes:{ pass:passing },run_errors:0,items };
  };
  const summary = { processed: 161, pass: 150, waves: [wave("wave-1",52,48),wave("wave-2",68,62),wave("wave-3",41,40)] };
  assert.equal(validateTopic161Summary(summary).passed, true);
  const expectedIdsByWave=Object.fromEntries(summary.waves.map((row) => [row.wave,row.items.map((item) => item.question_id)]));
  const expectedTopicById=Object.fromEntries(summary.waves.flatMap((row) => row.items.map((item) => [item.question_id,`${row.wave}-strong-topic`])));
  const weakIds=summary.waves[0].items.slice(-10).map((item) => item.question_id);
  for (const id of weakIds) expectedTopicById[id]="weak-topic";
  const topicGate=validateTopic161Summary(summary,expectedIdsByWave,null,expectedTopicById);
  assert.equal(topicGate.passed,false,"a weak topic must not be hidden by the wave average");
  assert.match(topicGate.blockers.join(";"),/weak-topic topic pass rate/);
  summary.waves[1] = wave("wave-2",68,57);
  summary.pass = 145;
  assert.equal(validateTopic161Summary(summary).passed, false);
});

test("Live-50 deterministic miss blocks even when AI says pass", () => {
  const bank = { questions: Array.from({ length: 50 }, (_, i) => ({ id: `L${String(i + 1).padStart(2, "0")}`, question: "q", category: "portfolio", expected_route:"ANSWER", must_include: ["fact"], must_not: [] })) };
  const answerSha = sha256Buffer("fact");
  const results = { items: bank.questions.map((item) => ({ id: item.id, ok: true, actual_route:"ANSWER", answer: "fact", sources: [{ title: "Mutable compact source" }],final_public_sources:[{ source_id:"signed-source",title:"Signed raw source",section:null,snippet:"fact",effective_date:"2026-09-04",oscola:"Signed raw source" }],served_response_verified:true,served_via_canonical_chat:true,response_route_source:"CANONICAL_HTTP_CHAT_RESPONSE",served_response_sha256:answerSha,served_response_receipt:{ sha256:"a".repeat(64),raw_sha256:"b".repeat(64),served_answer_sha256:answerSha } })) };
  const cases = prepareLive50Cases(bank, results);
  assert.equal(cases[0].sources[0].title,"Signed raw source","AI review must use the signed raw source representation");
  assert.equal(cases[0].sources[0].evidence_excerpt,"fact","the exact server snippet must become reviewer evidence");
  const aiGate = { passed: true, cases: cases.map((item) => ({ case_id: item.case_id, passed: true })) };
  assert.equal(validateLive50({ cases, aiGate, baseline: { items: [] } }).passed, false, "L43 must also satisfy the advice boundary");
  cases.find((item) => item.case_id === "L43").answer = "I cannot recommend a fund; seek a regulated personal recommendation.";
  assert.equal(validateLive50({ cases, aiGate, baseline: { items: [] } }).passed, true);
  results.items[0].actual_route = "REFUSE_ACTION";
  assert.equal(prepareLive50Cases(bank,results)[0].deterministic_pass,false,"the actual runtime route must match the expected route");
  cases[0].deterministic_pass = false;
  assert.equal(validateLive50({ cases, aiGate, baseline: { items: [] } }).passed, false);
});

test("visible cases never fall back from an empty signed source list to retrieval traces", () => {
  const payload = { results:[{ question_id:"gold-001",question:"q",final_system_answer:"A factual claim.",review_answer:"A factual claim.",selected_route:"ANSWER",selected_jurisdiction:"GREAT_BRITAIN",final_public_sources:[],retrieval_sources:[{ source_id:"forged",snippet:"A factual claim." }],generated_citations:[],claim_citations:[],served_via_canonical_chat:true,response_route_source:"CANONICAL_HTTP_CHAT_RESPONSE",served_response_sha256:sha256Buffer("A factual claim."),served_response_receipt:{ served_answer_sha256:sha256Buffer("A factual claim."),sha256:"a".repeat(64),raw_sha256:"b".repeat(64) } }] };
  const scorecard = { items:[{ question_id:"gold-001",status:"pass",served_response_verified:true,served_answer_sha256:sha256Buffer("A factual claim."),served_response_receipt_sha256:"a".repeat(64),served_raw_response_sha256:"b".repeat(64) }] };
  const cases = casesFromScorecard(payload,scorecard,new Map([["gold-001",{ question:"q" }]]));
  assert.deepEqual(cases[0].sources,[]);
});
