import { prepareReviewCases } from "./aiReview.mjs";
import { sha256Buffer } from "./utils.mjs";

const HARD_GATES = {
  all_material_claims_supported:true,citations_entail_claims:true,correct_jurisdiction:true,
  no_unsafe_instruction:true,no_unsupported_outcome:true,no_wrong_personal_fact:true,no_absolute_certainty_claim:true,
};

export function buildReviewCalibrationCases(pack) {
  if (pack?.version !== "qualification-review-calibration-v2" || !Array.isArray(pack.items) || pack.items.length !== 16
      || new Set(pack.items.map((item) => item.case_id)).size !== pack.items.length
      || pack.items.filter((item) => item.expected_pass === true).length !== 8
      || pack.items.filter((item) => item.expected_pass === false).length !== 8) {
    throw Object.assign(new Error("Reviewer calibration pack must contain exactly eight positive and eight negative unique cases."),{ code:"EVALUATOR_DEFECT" });
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
  const items=Array.isArray(pack?.items) ? pack.items : [];
  const prepared = prepareReviewCases(Array.isArray(cases) ? cases : []);
  const expected = new Map(items.map((item) => [item.case_id,item.expected_pass]));
  const coverageComplete=items.length > 0 && expected.size === items.length && items.every((item) => typeof item.expected_pass === "boolean")
    && prepared.length === items.length && new Set(prepared.map((item) => item.case_id)).size === prepared.length
    && prepared.every((item) => expected.has(item.case_id));
  const results = prepared.map((item) => ({
    case_id:item.case_id,expected_pass:expected.get(item.case_id),
    observed_pass:item.review_evidence_complete === true && Object.values(item.deterministic_hard_gates || {}).every((value) => value !== false),
  }));
  const mismatches = results.filter((item) => item.expected_pass !== item.observed_pass);
  return { version:"qualification-deterministic-review-calibration-v2",passed:coverageComplete && mismatches.length===0,
    coverage_complete:coverageComplete,results,mismatches };
}

export function validateAiReviewCalibration(pack,gate) {
  const items = Array.isArray(pack?.items) ? pack.items : [];
  const rows = Array.isArray(gate?.cases) ? gate.cases : [];
  const expected = new Map(items.map((item) => [item.case_id,item.expected_pass]));
  const actual = new Map(rows.map((item) => [item.case_id,item]));
  const blockers = [];
  if (!items.length || expected.size !== items.length || items.some((item) => typeof item.expected_pass !== "boolean")) blockers.push("calibration expectations are missing or invalid");
  if (rows.length !== items.length || actual.size !== rows.length || rows.some((item) => !expected.has(item.case_id))) blockers.push("calibration case coverage is incomplete, duplicated, or unexpected");
  const floor = gate?.minimum_quality_score;
  if (!Number.isFinite(floor) || floor < 70 || floor > 100) blockers.push("calibration quality floor is missing or invalid");
  const results = [];
  const reviewerResults = { A:[],B:[] };
  for (const item of items) {
    const row = actual.get(item.case_id);
    const observed = typeof row?.passed === "boolean" ? row.passed : null;
    results.push({ case_id:item.case_id,expected_pass:item.expected_pass,observed_pass:observed });
    for (const [role,key] of [["A","reviewer_a"],["B","reviewer_b"]]) {
      const review = row?.[key];
      const valid = review?.case_id === item.case_id && ["PASS","PARTIAL","FAIL","HOLD"].includes(review?.verdict)
        && Number.isFinite(review?.quality_score) && review.quality_score >= 0 && review.quality_score <= 100
        && Object.keys(HARD_GATES).every((name) => typeof review.hard_gates?.[name] === "boolean");
      // Check each raw reviewer verdict: a combined rejection must never hide
      // one reviewer approving a deliberately incorrect calibration answer.
      const observedPass = valid ? review.verdict === "PASS" : null;
      const qualityPassed = valid && review.quality_score >= floor && Object.keys(HARD_GATES).every((name) => review.hard_gates[name] === true);
      const expectedVerdictMatched = valid && (item.expected_pass ? observedPass && qualityPassed : review.verdict === "FAIL");
      reviewerResults[role].push({ case_id:item.case_id,expected_pass:item.expected_pass,observed_pass:observedPass,
        verdict:review?.verdict ?? null,quality_score:review?.quality_score ?? null,passed:expectedVerdictMatched });
      if (!valid) blockers.push(`reviewer ${role} has a missing or invalid calibration verdict for ${item.case_id}`);
      else if (!expectedVerdictMatched) blockers.push(`reviewer ${role} did not satisfy the expected calibration verdict for ${item.case_id}`);
    }
  }
  const mismatches = results.filter((item) => item.observed_pass !== item.expected_pass);
  if (mismatches.length) blockers.push("combined calibration verdicts do not match expectations");
  const individual = Object.entries(reviewerResults).flatMap(([reviewer,values]) => values.map((item) => ({ reviewer,...item })));
  return {
    version:"qualification-dual-ai-review-calibration-v2",passed:blockers.length===0,blockers,
    false_approvals:individual.filter((item) => item.expected_pass === false && item.observed_pass === true),
    false_rejections:individual.filter((item) => item.expected_pass === true && item.observed_pass === false),
    results,reviewers:reviewerResults,
    minimum_quality_score:gate?.minimum_quality_score ?? null,review_packets:gate?.packets ?? null,
  };
}
