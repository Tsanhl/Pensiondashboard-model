import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildReviewCalibrationCases,validateAiReviewCalibration,validateDeterministicReviewCalibration } from "../scripts/lib/qualification-worker/reviewCalibration.mjs";

const pack=JSON.parse(readFileSync(new URL("../evaluation/qualification-review-calibration-v1.json",import.meta.url),"utf8"));

test("finite reviewer calibration catches false approvals without rejecting supported cases",() => {
  const cases=buildReviewCalibrationCases(pack);
  const deterministic=validateDeterministicReviewCalibration(pack,cases);
  assert.equal(deterministic.passed,true);
  assert.deepEqual(deterministic.results.map((item) => item.observed_pass),[true,true,true,false,false,false]);
  const dual={ minimum_quality_score:70,packets:1,cases:pack.items.map((item) => ({ case_id:item.case_id,passed:item.expected_pass })) };
  assert.equal(validateAiReviewCalibration(pack,dual).passed,true);
  dual.cases.at(-1).passed=true;
  const unsafe=validateAiReviewCalibration(pack,dual);
  assert.equal(unsafe.passed,false);
  assert.equal(unsafe.false_approvals.length,1);
});
