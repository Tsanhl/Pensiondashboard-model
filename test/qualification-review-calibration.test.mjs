import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildReviewCalibrationCases,validateAiReviewCalibration,validateDeterministicReviewCalibration } from "../scripts/lib/qualification-worker/reviewCalibration.mjs";

const pack=JSON.parse(readFileSync(new URL("../evaluation/qualification-review-calibration-v2.json",import.meta.url),"utf8"));

const gateNames = ["all_material_claims_supported","citations_entail_claims","correct_jurisdiction","no_unsafe_instruction","no_unsupported_outcome","no_wrong_personal_fact","no_absolute_certainty_claim"];
function review(item,pass=item.expected_pass) {
  return { case_id:item.case_id,verdict:pass ? "PASS" : "FAIL",quality_score:pass ? 90 : 30,
    hard_gates:Object.fromEntries(gateNames.map((key) => [key,pass])) };
}
function calibratedGate() {
  return { minimum_quality_score:70,packets:1,cases:pack.items.map((item) => ({
    case_id:item.case_id,passed:item.expected_pass,reviewer_a:review(item),reviewer_b:review(item),
  })) };
}

test("finite reviewer calibration catches false approvals without rejecting supported cases",() => {
  const cases=buildReviewCalibrationCases(pack);
  const deterministic=validateDeterministicReviewCalibration(pack,cases);
  assert.equal(deterministic.passed,true);
  assert.deepEqual(deterministic.results.map((item) => item.observed_pass),[
    true,true,true,true,true,true,true,true,
    false,false,false,false,false,false,false,false,
  ]);
  const dual=calibratedGate();
  assert.equal(validateAiReviewCalibration(pack,dual).passed,true);
  dual.cases.at(-1).passed=true;
  const unsafe=validateAiReviewCalibration(pack,dual);
  assert.equal(unsafe.passed,false);
  assert.match(unsafe.blockers.join(";"),/combined calibration verdicts/);
});

test("one reviewer approving a negative cannot hide behind the other reviewer's rejection",() => {
  for (const [role,key] of [["A","reviewer_a"],["B","reviewer_b"]]) {
    const dual=calibratedGate();
    dual.cases.at(-1)[key]=review(pack.items.at(-1),true);
    assert.equal(dual.cases.at(-1).passed,false,"combined result still rejects the bad answer");
    const result=validateAiReviewCalibration(pack,dual);
    assert.equal(result.passed,false);
    assert.equal(result.false_approvals.length,1);
    assert.equal(result.false_approvals[0].reviewer,role);
  }
});

test("each reviewer must accept supported controls and meet every hard gate and the score floor",() => {
  for (const mutate of [
    (row) => { row.reviewer_a.verdict="FAIL"; },
    (row) => { row.reviewer_b.quality_score=69; },
    (row) => { row.reviewer_a.hard_gates.citations_entail_claims=false; },
  ]) {
    const dual=calibratedGate();
    mutate(dual.cases[0]);
    assert.equal(validateAiReviewCalibration(pack,dual).passed,false);
  }
});

test("missing, duplicated, unexpected or unidentifiable reviewer evidence cannot calibrate",() => {
  for (const mutate of [
    (gate) => { delete gate.cases[0].reviewer_b; },
    (gate) => { gate.cases.pop(); },
    (gate) => { gate.cases.push(structuredClone(gate.cases[0])); },
    (gate) => { gate.cases.at(-1).case_id="unknown"; },
    (gate) => { gate.cases[0].reviewer_a.case_id="another-answer"; },
    (gate) => { gate.minimum_quality_score=69; },
    (gate) => { delete gate.cases[0].reviewer_a.hard_gates.no_wrong_personal_fact; },
  ]) {
    const dual=calibratedGate();
    mutate(dual);
    assert.equal(validateAiReviewCalibration(pack,dual).passed,false);
  }
  assert.equal(validateAiReviewCalibration(null,null).passed,false);
});

test("HOLD and PARTIAL are unresolved calibration, not correct negative classifications",() => {
  for (const verdict of ["HOLD","PARTIAL"]) {
    const dual=calibratedGate();
    dual.cases.at(-1).reviewer_a.verdict=verdict;
    assert.equal(validateAiReviewCalibration(pack,dual).passed,false);
  }
});

test("deterministic calibration cannot omit or duplicate supported or negative controls",() => {
  const cases=buildReviewCalibrationCases(pack);
  assert.equal(validateDeterministicReviewCalibration(pack,cases).coverage_complete,true);
  for (const incomplete of [[],cases.slice(0,3),cases.slice(0,-1),[...cases.slice(0,-1),cases[0]],
    [...cases,{ ...cases[0],case_id:"unexpected" }]]) {
    const result=validateDeterministicReviewCalibration(pack,incomplete);
    assert.equal(result.passed,false);
    assert.equal(result.coverage_complete,false);
  }
});
