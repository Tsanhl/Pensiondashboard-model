import assert from "node:assert/strict";
import test from "node:test";
import { aggregateDualReviews, inspectCodexJsonEvents, prepareReviewCases } from "../scripts/lib/qualification-worker/aiReview.mjs";
import { sha256Buffer } from "../scripts/lib/qualification-worker/utils.mjs";

const gates = { all_material_claims_supported: true, citations_entail_claims: true, correct_jurisdiction: true, no_unsafe_instruction: true, no_unsupported_outcome: true, no_wrong_personal_fact: true, no_absolute_certainty_claim: true };
const dimensions = { factual_support: 32, citation_entailment: 15, law_and_jurisdiction: 12, completeness: 8, safety_and_boundary: 8, clarity: 4 };
function served(input) {
  const rendered = String(input.rendered_answer || input.answer || "");
  return { ...input,served_response_verified:true,served_answer_sha256:sha256Buffer(rendered) };
}
function review(overrides = {}) {
  const verdict = overrides.verdict || "PASS";
  return { cases: [{
    case_id: "case-1", verdict, quality_score: 79, dimensions, hard_gates: gates,
    claims: [{ proposition_id:"PROP:001",claim:"The pinned fact is present",claim_type:"FACTUAL_LEGAL",evidence_ids:["SRC:pinned"],supported:true,reason:"The source states the fact." }],
    failure_classes: verdict === "PASS" ? [] : ["MODEL_FACT_APPLICATION_FAILURE"], rationale: "supported", limitations: [], ...overrides,
  }] };
}

test("dual AI gate requires both reviewers, score 70 and every hard gate", () => {
  const cases = [served({
    case_id: "case-1", answer:"The pinned fact is present", deterministic_pass: true,
    deterministic_hard_gates: gates,
    sources:[{ source_id:"pinned",title:"Pinned evidence",evidence_excerpt:"The pinned fact is present" }],
    citations:["pinned"],
    claim_citations:[{ claim:"The pinned fact is present",source_ids:["pinned"] }],
    trusted_evidence_records:[{ evidence_id:"SRC:pinned",source_id:"pinned",title:"Pinned evidence",content:"The pinned fact is present",content_sha256:"a".repeat(64),scope:"CURATED_PUBLIC" }],
  })];
  const quality = { minimum_score: 70, minimum_ai_agreement: 2 };
  assert.equal(aggregateDualReviews(cases, review(), review(), quality).passed, true);
  assert.equal(aggregateDualReviews(cases, review(), review({ verdict: "FAIL" }), quality).passed, false);
  assert.equal(aggregateDualReviews(cases, review(), review({ quality_score: 69, dimensions: { ...dimensions, factual_support: 22 } }), quality).passed, false);
  assert.equal(aggregateDualReviews(cases, review(), review({ hard_gates: { ...gates, citations_entail_claims: false } }), quality).passed, false);
  assert.equal(aggregateDualReviews([{ ...cases[0], deterministic_pass: false }], review(), review(), quality).passed, false);
  assert.throws(() => aggregateDualReviews([{ ...cases[0], citations:[] }], review(), review(), quality),/complete supported claim map/);
  const unrelated = [{
    ...cases[0],answer:"Your pension transfer is legally guaranteed",citations:["pinned"],
    claim_citations:[{ claim:"Your pension transfer is legally guaranteed",source_ids:["pinned"] }],
    sources:[{ source_id:"pinned",title:"Transfer information",evidence_excerpt:"The provider has a transfer-information page." }],
    trusted_evidence_records:[{ evidence_id:"SRC:pinned",source_id:"pinned",title:"Transfer information",content:"The provider has a transfer-information page.",content_sha256:"b".repeat(64),scope:"CURATED_PUBLIC" }],
  }];
  const unrelatedReview = review({ claims:[{ proposition_id:"PROP:001",claim:"Your pension transfer is legally guaranteed",claim_type:"FACTUAL_LEGAL",evidence_ids:["SRC:pinned"],supported:true,reason:"asserted support" }] });
  assert.throws(() => aggregateDualReviews(unrelated,unrelatedReview,unrelatedReview,quality),/complete supported claim map/);

  const mixed = prepareReviewCases([served({
    case_id:"mixed-citations",answer:"A worker may opt out.",citations:["supporting","unrelated"],
    claim_citations:[{ claim:"A worker may opt out",source_ids:["supporting","unrelated"] }],
    trusted_evidence_records:[
      { evidence_id:"SRC:supporting",source_id:"supporting",content:"A worker may opt out.",scope:"CURATED_PUBLIC" },
      { evidence_id:"SRC:unrelated",source_id:"unrelated",content:"Trustees publish annual reports.",scope:"CURATED_PUBLIC" },
    ],
  })])[0];
  assert.equal(mixed.answer_propositions[0].deterministic_evidence_binding.supported,false);
  assert.deepEqual(mixed.answer_propositions[0].deterministic_evidence_binding.unsupported_source_ids,["unrelated"]);
  assert.equal(mixed.review_evidence_complete,false);
  assert.equal(mixed.deterministic_hard_gates.citations_entail_claims,false);

  const globallyUnmapped = prepareReviewCases([served({
    case_id:"globally-unmapped",answer:"A worker may opt out.",citations:["supporting","unmapped"],
    claim_citations:[{ claim:"A worker may opt out",source_ids:["supporting"] }],
    trusted_evidence_records:[
      { evidence_id:"SRC:supporting",source_id:"supporting",content:"A worker may opt out.",scope:"CURATED_PUBLIC" },
      { evidence_id:"SRC:unmapped",source_id:"unmapped",content:"Trustees publish annual reports.",scope:"CURATED_PUBLIC" },
    ],
  })])[0];
  assert.equal(globallyUnmapped.review_evidence_complete,false);
  assert.equal(globallyUnmapped.deterministic_hard_gates.citations_entail_claims,false);
});

test("review binds the exact served answer and rejects semantic evidence conflicts", () => {
  const divergent = prepareReviewCases([served({
    case_id:"divergent",rendered_answer:"Transfer now; approval is guaranteed.",review_answer:"Please ask the administrator.",
    citations:["src"],claim_citations:[{ claim:"Transfer now; approval is guaranteed.",source_ids:["src"] }],
    trusted_evidence_records:[{ evidence_id:"SRC:src",source_id:"src",content:"Please ask the administrator.",scope:"CURATED_PUBLIC" }],
  })])[0];
  assert.equal(divergent.review_answer_consistent,false);
  assert.equal(divergent.review_evidence_complete,false);

  const citedServed = prepareReviewCases([served({
    case_id:"cited-served",rendered_answer:"A worker may opt out (The Pensions Regulator, 'Opting out').",review_answer:"A worker may opt out.",
    citations:["src"],claim_citations:[{ claim:"A worker may opt out.",source_ids:["src"] }],
    sources:[{ source_id:"src",oscola:"The Pensions Regulator, 'Opting out'" }],
    trusted_evidence_records:[{ evidence_id:"SRC:src",source_id:"src",content:"A worker may opt out.",scope:"CURATED_PUBLIC" }],
  })])[0];
  assert.equal(citedServed.review_answer_consistent,true);
  assert.equal(citedServed.review_evidence_complete,true);

  const wrongSubject = prepareReviewCases([served({
    case_id:"wrong-subject",answer:"The Northbridge pension is Deferred and has a recorded value of £32,150.",
    citations:["src"],claim_citations:[{ claim:"The Northbridge pension is Deferred and has a recorded value of £32,150.",source_ids:["src"] }],
    trusted_evidence_records:[{ evidence_id:"SRC:src",source_id:"src",content:"The Standard Life pension is Deferred and has a recorded value of £32,150. Northbridge is a separate active pension.",scope:"USER_PORTFOLIO" }],
  })])[0];
  assert.equal(wrongSubject.review_evidence_complete,false,"matching status and amount must not support a different pension subject");

  for (const [answer,evidence] of [
    ["A worker may opt out.","A worker may not opt out."],
    ["The contribution is £100.","The contribution rate is 100%."],
    ["The employer pays no contribution.","The employer pays a contribution."],
    ["The employer should pay a contribution.","The employer may pay a contribution."],
    ["A worker could opt out.","A worker may opt out."],
    ["The member is entitled to payment.","The member may receive payment."],
    ["The trustee can transfer without consent.","The trustee can transfer with consent."],
    ["The member may withdraw before age 55.","The member may withdraw after age 55."],
    ["The scheme covers all employees.","The scheme covers some employees."],
    ["The contribution is £100 per month.","The contribution is £100 per year."],
    ["The pot is £1.5m.","The pot is £1.5."],
    ["A worker may opt out.","A worker may opt in."],
    ["A worker can remain opted out.","A worker can remain opted in."],
    ["A worker is opting out.","A worker is opting in."],
    ["A worker opts out.","A worker opts in."],
    ["The opt-out status continues.","The opt-in status continues."],
    ["The pot was transferred out of the scheme.","The pot was transferred into the scheme."],
    ["The member is transferring out.","The member is transferring in."],
    ["A worker is prohibited from opting out.","A worker is not prohibited from opting out."],
    ["The transfer is excluded.","The transfer is not excluded."],
    ["A worker is ineligible.","A worker is not ineligible."],
    ["A worker is permitted to opt out.","A worker is not permitted to opt out."],
    ["A worker may opt out.","A worker may opt out only after age 60."],
    ["A worker may opt out.","A worker may opt out unless the notice is late."],
    ["A worker may opt out.","A worker may opt out after 1 January 2030."],
    ["A worker may opt out.","A worker may opt out in Northern Ireland."],
    ["The worker is prohibited.","The worker is not legally prohibited."],
    ["The worker is prohibited.","The worker is not as a matter of law prohibited."],
    ["A worker may opt out.","A worker may opt out if they are age 60."],
    ["A worker may opt out.","A worker may opt out when active membership ends."],
    ["A worker may opt out.","A worker may opt out within one month of enrolment."],
    ["A worker may opt out.","A worker may opt out on condition that written notice is given."],
    ["A worker may opt out.","A worker may opt out conditional upon active membership ending."],
    ["A worker may opt out.","A worker may opt out on 01/01/2030."],
    ["A worker may opt out.","A worker may opt out on 2030-01-01."],
    ["A worker may opt out.","Eligibility begins on 01/01/2030. A worker may opt out from then on."],
    ["A member may transfer out.","A member may transfer out under £30,000."],
    ["A member may transfer £30,000.","A member may transfer under £30,000."],
    ["A member may transfer £30,000.","A member may transfer up to £30,000."],
    ["A member may transfer £30,000.","A member may transfer < £30,000."],
    ["A member may transfer £30,000.","A member may transfer ≤ £30,000."],
    ["A member may transfer £30,000.","A member may transfer ≥ £30,000."],
    ["A member may transfer £30,000.","A member may transfer about £30,000."],
    ["The investment may return 5%.","The investment may return -5%."],
    ["The investment may return 5%.","The investment may return −5%."],
    ["The investment may return 5%.","The investment may return –5%."],
    ["The investment may return 5%.","The investment may return —5%."],
    ["The investment may return 5%.","The investment may return 5%-"],
    ["The member may receive £100.","The member may receive (£100)."],
    ["A benefit may start on 01/01/2030.","A benefit may start by 01/01/2030."],
    ["A benefit may start on 01/01/2030.","A benefit may start as of 01/01/2030."],
    ["A benefit may start on 1 January 2030.","A benefit may start by 1 January 2030."],
    ["A benefit may start on 1 Jan 2030.","A benefit may start by 1 Jan 2030."],
    ["A benefit may start on January 1, 2030.","A benefit may start by January 1, 2030."],
    ["A benefit may start on 1st January 2030.","A benefit may start by 1st January 2030."],
    ["A benefit may start on 01.01.2030.","A benefit may start by 01.01.2030."],
    ["The allowance may apply from April 2030.","The allowance may apply by April 2030."],
    ["The allowance may apply from the 2030/31 tax year.","The allowance may apply by the 2030/31 tax year."],
    ["The allowance may apply from Q1 2030.","The allowance may apply by Q1 2030."],
    ["A member may retire from age 55.","A member may retire by age 55."],
    ["The member may apply within 30 days.","The member may apply after 30 days."],
    ["A pension may be paid from retirement.","A pension may be paid by retirement."],
    ["The member may apply within a period of 30 days.","The member may apply after a period of 30 days."],
    ["The member may apply within a statutory period of 30 days.","The member may apply after a statutory period of 30 days."],
    ["The member may apply within one month.","The member may apply after one month."],
    ["The member may apply within thirty days.","The member may apply after thirty days."],
    ["The member may apply within twelve calendar months.","The member may apply after twelve calendar months."],
    ["The member may retire from attainment of age 55.","The member may retire by attainment of age 55."],
    ["A pension may be paid from the date of retirement.","A pension may be paid by the date of retirement."],
    ["A pension may be paid from the member’s death.","A pension may be paid by the member’s death."],
    ["A pension may be paid from the member's death.","A pension may be paid by the member's death."],
    ["A pension may be paid from benefit crystallisation.","A pension may be paid by benefit crystallisation."],
    ["A pension may be paid from the member’s normal retirement date.","A pension may be paid by the member’s normal retirement date."],
    ["A pension may be paid from a date after retirement.","A pension may be paid by a date after retirement."],
    ["A pension may be paid from the date immediately following retirement.","A pension may be paid by the date immediately following retirement."],
    ["A member may transfer £30,000.","A member may transfer c £30,000."],
    ["A member may transfer £30,000.","A member may transfer ~ £30,000."],
    ["A member may transfer £30,000.","A member may transfer ≈ £30,000."],
    ["A member may transfer £30,000.","A member may transfer ≦ £30,000."],
    ["A member may transfer £30,000.","A member may transfer ≧ £30,000."],
  ]) {
    const prepared = prepareReviewCases([served({ case_id:"conflict",answer,citations:["src"],claim_citations:[{ claim:answer.replace(/\.$/,""),source_ids:["src"] }],trusted_evidence_records:[{ evidence_id:"SRC:src",source_id:"src",content:evidence,scope:"CURATED_PUBLIC" }] })])[0];
    assert.equal(prepared.review_evidence_complete,false,`${answer} must not be supported by ${evidence}`);
  }
});

test("deterministic advice boundary can bind policy sentences and its cited personal fact", () => {
  const answer = "I cannot recommend a specific fund. The recorded overall style is Balanced, with OneLife Cautious. Speak to a regulated financial adviser.";
  const prepared = prepareReviewCases([served({
    case_id:"L43",answer,model_call_attempted:false,citations:["profile"],
    claim_citations:[{ claim:"The recorded overall style is Balanced, with OneLife Cautious",source_ids:["profile"] }],
    trusted_evidence_records:[{ evidence_id:"SRC:profile",source_id:"profile",content:"The recorded overall style is Balanced, with OneLife Cautious.",scope:"USER_PORTFOLIO" }],
  })])[0];
  assert.equal(prepared.review_evidence_complete,true);
  assert.deepEqual(prepared.answer_propositions.map((item) => item.required_evidence_class),["POLICY_BOUNDARY","PINNED_SOURCE","POLICY_BOUNDARY"]);
});

test("Codex JSONL audit rejects every tool-bearing event", () => {
  const clean = [
    { type:"thread.started",thread_id:"x" },
    { type:"turn.started" },
    { type:"item.completed",item:{ type:"reasoning",text:"checked" } },
    { type:"item.completed",item:{ type:"agent_message",text:"{}" } },
    { type:"turn.completed" },
  ].map(JSON.stringify).join("\n");
  assert.equal(inspectCodexJsonEvents(clean).tool_event_count,0);
  const tool = `${clean}\n${JSON.stringify({ type:"item.started",item:{ type:"command_execution",command:"cat /etc/hosts" } })}`;
  assert.throws(() => inspectCodexJsonEvents(tool),/forbidden tool event/);
  assert.throws(() => inspectCodexJsonEvents("not-json"),/not valid JSON/);
});

test("a failed or incomplete transcript and a changed final output cannot provide review provenance",() => {
  const events=[
    { type:"thread.started",thread_id:"test-review" },{ type:"turn.started" },
    { type:"item.completed",item:{ type:"agent_message",text:'{"cases":[]}' } },{ type:"turn.completed" },
  ];
  const encode=(values) => values.map(JSON.stringify).join("\n");
  assert.equal(inspectCodexJsonEvents(encode(events),{ rawOutput:'{"cases":[]}\n' }).successful_turn,true);
  assert.throws(() => inspectCodexJsonEvents(encode([{ type:"turn.failed" }])),/successful completed turn/);
  for (const values of [events.slice(0,-1),events.filter((event) => event.type !== "turn.started"),
    events.filter((event) => !event.item),[...events,{ type:"turn.completed" }],
    [...events.slice(0,-1),{ type:"error",message:"failed" },events.at(-1)]]) {
    assert.throws(() => inspectCodexJsonEvents(encode(values)),/successful completed turn/);
  }
  assert.throws(() => inspectCodexJsonEvents(encode(events),{ rawOutput:'{"cases":[{"verdict":"PASS"}]}' }),/does not match/);
});

test("runtime review validation enforces dimension maxima, types, hard-gate shape and nonempty cases",() => {
  const cases=[served({ case_id:"case-1",answer:"The pinned fact is present",deterministic_pass:true,deterministic_hard_gates:gates,
    sources:[{ source_id:"pinned",title:"Pinned evidence",evidence_excerpt:"The pinned fact is present" }],citations:["pinned"],
    claim_citations:[{ claim:"The pinned fact is present",source_ids:["pinned"] }],
    trusted_evidence_records:[{ evidence_id:"SRC:pinned",source_id:"pinned",content:"The pinned fact is present",scope:"CURATED_PUBLIC" }],
  })];
  const quality={ minimum_score:70,minimum_ai_agreement:2 };
  assert.equal(aggregateDualReviews(cases,review(),review(),quality).passed,true);
  for (const invalid of [
    { dimensions:{ factual_support:100 },quality_score:100 },
    { dimensions:{ ...dimensions,factual_support:41 },quality_score:88 },
    { dimensions:{ ...dimensions,clarity:-1 },quality_score:74 },
    { quality_score:"79" },{ quality_score:NaN },{ quality_score:Infinity },
    { hard_gates:{ ...gates,no_wrong_personal_fact:"true" } },
    { dimensions:{ ...dimensions,extra_credit:0 } },
  ]) assert.throws(() => aggregateDualReviews(cases,review(invalid),review(),quality),/Invalid AI review schema/);
  assert.throws(() => aggregateDualReviews([],{ cases:[] },{ cases:[] },quality),/nonempty unique case set/);
});
