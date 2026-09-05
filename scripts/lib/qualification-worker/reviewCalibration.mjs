import { prepareReviewCases } from "./aiReview.mjs";
import { sha256Buffer } from "./utils.mjs";

const HARD_GATES = {
  all_material_claims_supported:true,citations_entail_claims:true,correct_jurisdiction:true,
  no_unsafe_instruction:true,no_unsupported_outcome:true,no_wrong_personal_fact:true,no_absolute_certainty_claim:true,
};

export function buildReviewCalibrationCases(pack) {
  if (pack?.version !== "qualification-review-calibration-v1" || !Array.isArray(pack.items) || pack.items.length !== 6
      || new Set(pack.items.map((item) => item.case_id)).size !== pack.items.length
      || pack.items.filter((item) => item.expected_pass === true).length !== 3
      || pack.items.filter((item) => item.expected_pass === false).length !== 3) {
    throw Object.assign(new Error("Reviewer calibration pack must contain exactly three positive and three negative unique cases."),{ code:"EVALUATOR_DEFECT" });
  }
  return pack.items.map((item) => ({
    case_id:item.case_id,answer:item.answer,rendered_answer:item.answer,review_answer:item.answer,
    served_response_verified:true,served_answer_sha256:sha256Buffer(item.answer),
    deterministic_pass:true,deterministic_hard_gates:{ ...HARD_GATES },
    model_call_attempted:item.model_call_attempted,
    sources:[{ source_id:item.source_id,title:"Frozen reviewer calibration evidence",scope:"CURATED_PUBLIC",evidence_excerpt:item.evidence }],
    citations:[item.source_id],claim_citations:[{ claim:item.answer,source_ids:[item.source_id] }],
    case_trusted_sources:[{ source_id:item.source_id,title:"Frozen reviewer calibration evidence",scope:"CURATED_PUBLIC",content:item.evidence }],
    trusted_evidence_records:[{ evidence_id:`SRC:${item.source_id}`,source_id:item.source_id,title:"Frozen reviewer calibration evidence",scope:"CURATED_PUBLIC",content:item.evidence,content_sha256:sha256Buffer(item.evidence) }],
  }));
}

export function validateDeterministicReviewCalibration(pack,cases) {
  const prepared = prepareReviewCases(cases);
  const expected = new Map(pack.items.map((item) => [item.case_id,item.expected_pass]));
  const results = prepared.map((item) => ({
    case_id:item.case_id,expected_pass:expected.get(item.case_id),
    observed_pass:item.review_evidence_complete === true && Object.values(item.deterministic_hard_gates || {}).every((value) => value !== false),
  }));
  const mismatches = results.filter((item) => item.expected_pass !== item.observed_pass);
  return { version:"qualification-deterministic-review-calibration-v1",passed:mismatches.length===0,results,mismatches };
}

export function validateAiReviewCalibration(pack,gate) {
  const expected = new Map(pack.items.map((item) => [item.case_id,item.expected_pass]));
  const actual = new Map((gate?.cases || []).map((item) => [item.case_id,item.passed === true]));
  const results = pack.items.map((item) => ({ case_id:item.case_id,expected_pass:expected.get(item.case_id),observed_pass:actual.get(item.case_id) }));
  const mismatches = results.filter((item) => item.observed_pass !== item.expected_pass);
  return {
    version:"qualification-dual-ai-review-calibration-v1",passed:mismatches.length===0 && actual.size===pack.items.length,
    false_approvals:mismatches.filter((item) => item.expected_pass === false),
    false_rejections:mismatches.filter((item) => item.expected_pass === true),results,
    minimum_quality_score:gate?.minimum_quality_score ?? null,review_packets:gate?.packets ?? null,
  };
}
