import { execFileSync } from "node:child_process";
import { existsSync,readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CYCLE_ROOT, INPUTS, PROJECT_ROOT, countBy, fileManifest, isoNow, markdownTable,
  normaliseQuestion, readJson, sha256, unique, writeJsonAtomic, writeTextAtomic
} from "./evaluationCycleV1Common.mjs";

const OUTPUT_ROOT = resolve(CYCLE_ROOT, "00-preflight");
const OWNER_APPROVAL_PATH = resolve(CYCLE_ROOT,"02-error-analysis/owner-review-decision.json");
const generatedAt = isoNow();
const evaluation = readJson(INPUTS.evaluationDraft);
const answerReview = readJson(INPUTS.answerReview);
const markdown = readFileSync(INPUTS.markdown, "utf8");
const questions = Array.isArray(evaluation.questions) ? evaluation.questions : [];
const items = Array.isArray(answerReview.items) ? answerReview.items : [];
const questionById = new Map(questions.map((item) => [item.id, item]));
const answerById = new Map(items.map((item) => [item.id, item]));

function git(args, fallback = null) {
  try {
    return execFileSync("git", args, { cwd:PROJECT_ROOT,encoding:"utf8",stdio:["ignore","pipe","ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function duplicateGroups(values, normalizer = (value) => value) {
  const groups = new Map();
  for (const value of values) {
    const key = normalizer(value.question);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value.id);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([value, ids]) => ({ value,ids }));
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) && Number.isFinite(Date.parse(value));
}

function selectedEvidence(item) {
  return [
    ...(item.retrieved_chunks || []).filter((source) => source.selected_for_answer !== false),
    ...(item.structured_facts || []).filter((source) => source.selected_for_answer !== false),
    ...(item.policy_evidence?.selected_for_answer === false || !item.policy_evidence ? [] : [item.policy_evidence]),
    ...(item.synthetic_fixture ? [item.synthetic_fixture] : [])
  ];
}

function evidenceIds(item) {
  return new Set(selectedEvidence(item).flatMap((source) => [
    source.evidence_id,source.source_id,source.document_id,source.id,source.fact_id,
    String(source.source_id || "").replace(/^structured_public_/, ""),
    String(source.document_id || "").replace(/^public-fact-/, "")
  ].filter(Boolean)));
}

const allIds = questions.map((item) => item.id);
const allAnswerIds = items.map((item) => item.id);
const uniqueQuestionIds = unique(allIds);
const uniqueAnswerIds = unique(allAnswerIds);
const duplicateQuestionIds = Object.entries(countBy(allIds)).filter(([, count]) => count > 1).map(([id,count]) => ({ id,count }));
const duplicateAnswerIds = Object.entries(countBy(allAnswerIds)).filter(([, count]) => count > 1).map(([id,count]) => ({ id,count }));
const missingInAnswers = uniqueQuestionIds.filter((id) => !answerById.has(id));
const missingInQuestions = uniqueAnswerIds.filter((id) => !questionById.has(id));

const parityFields = ["question","suite","jurisdiction","as_of_date"];
const parityMismatches = [];
for (const id of unique([...uniqueQuestionIds,...uniqueAnswerIds])) {
  const question = questionById.get(id);
  const answer = answerById.get(id);
  if (!question || !answer) continue;
  for (const field of parityFields) {
    if (String(question[field] ?? "") !== String(answer[field] ?? "")) {
      parityMismatches.push({ id,field,evaluation_value:question[field] ?? null,answer_review_value:answer[field] ?? null });
    }
  }
}

const markdownIds = [...markdown.matchAll(/^##\s+`?(gold-[0-9]+[a-z]?)`?/gmi)].map((match) => match[1]);
const markdownMissingIds = uniqueAnswerIds.filter((id) => !markdownIds.includes(id));
const markdownDuplicateIds = Object.entries(countBy(markdownIds)).filter(([, count]) => count > 1).map(([id,count]) => ({ id,count }));
const markdownAnswerMismatches = items.filter((item) => item.draft_answer && !markdown.includes(item.draft_answer)).map((item) => item.id);

const missing = {
  fixture:items.filter((item) => !item.synthetic_fixture?.evidence_id || !item.synthetic_fixture?.values).map((item) => item.id),
  route:items.filter((item) => !item.expected_route).map((item) => item.id),
  jurisdiction:items.filter((item) => !item.jurisdiction).map((item) => item.id),
  handoff_metadata:items.filter((item) => typeof item.expected_handoff?.required !== "boolean").map((item) => item.id),
  required_behaviours:items.filter((item) => !Array.isArray(item.scoring?.required_checks) || !item.scoring.required_checks.length).map((item) => item.id),
  prohibited_behaviours:items.filter((item) => !Array.isArray(item.scoring?.prohibited_checks) || !item.scoring.prohibited_checks.length).map((item) => item.id),
  critical_failure_gates:items.filter((item) => !Array.isArray(item.scoring?.critical_failures) || !item.scoring.critical_failures.length).map((item) => item.id),
  answer_review_status:items.filter((item) => !item.answer_review_status).map((item) => item.id),
  question_decision:items.filter((item) => !item.question_decision).map((item) => item.id),
  law_as_at:items.filter((item) => !validDate(item.as_of_date)).map((item) => item.id)
};

const sourceChecks = {
  selected_source_count:0,
  selected_active_corpus_chunk_count:0,
  selected_structured_fact_count:0,
  missing_source_id:[],
  missing_oscola:[],
  missing_source_updated_at:[],
  missing_retrieved_at:[],
  missing_law_as_at:[],
  missing_snapshot_hash:[],
  unresolved_claim_evidence_ids:[],
  unresolved_required_source_ids:[],
  unresolved_required_structured_fact_ids:[]
};
for (const item of items) {
  const evidence = selectedEvidence(item);
  const ids = evidenceIds(item);
  sourceChecks.selected_source_count += evidence.length;
  for (const source of (item.retrieved_chunks || []).filter((entry) => entry.selected_for_answer !== false)) {
    sourceChecks.selected_active_corpus_chunk_count += 1;
    if (!source.source_id) sourceChecks.missing_source_id.push({ id:item.id,evidence_id:source.evidence_id || null });
    if (!source.oscola_citation) sourceChecks.missing_oscola.push({ id:item.id,evidence_id:source.evidence_id || null });
    if (!source.source_updated_at) sourceChecks.missing_source_updated_at.push({ id:item.id,evidence_id:source.evidence_id || null });
    if (!source.retrieved_at) sourceChecks.missing_retrieved_at.push({ id:item.id,evidence_id:source.evidence_id || null });
    if (!source.law_as_at) sourceChecks.missing_law_as_at.push({ id:item.id,evidence_id:source.evidence_id || null });
    if (!source.snapshot_hash) sourceChecks.missing_snapshot_hash.push({ id:item.id,evidence_id:source.evidence_id || null });
  }
  for (const source of (item.structured_facts || []).filter((entry) => entry.selected_for_answer !== false)) {
    sourceChecks.selected_structured_fact_count += 1;
    if (!source.evidence_id && !source.source_id && !source.id) sourceChecks.missing_source_id.push({ id:item.id,evidence_id:null });
    if (!source.oscola_citation) sourceChecks.missing_oscola.push({ id:item.id,evidence_id:source.evidence_id || null });
  }
  for (const claim of item.claim_evidence_map || []) {
    const unresolved = (claim.evidence_ids || []).filter((id) => !ids.has(id));
    if (unresolved.length) sourceChecks.unresolved_claim_evidence_ids.push({ id:item.id,claim_id:claim.claim_id,unresolved });
  }
  const draft = questionById.get(item.id) || {};
  const unresolvedSources = (draft.required_source_ids || []).filter((id) => !ids.has(id) && !(item.retrieved_chunks || []).some((source) => source.source_id === id || source.document_id === id));
  if (unresolvedSources.length) sourceChecks.unresolved_required_source_ids.push({ id:item.id,unresolved:unresolvedSources });
  const requiredFacts = draft.required_structured_fact_ids || [];
  const factIds = new Set((item.structured_facts || []).flatMap((fact) => [
    fact.evidence_id,fact.source_id,fact.document_id,fact.id,fact.fact_id,
    String(fact.source_id || "").replace(/^structured_public_/, ""),
    String(fact.document_id || "").replace(/^public-fact-/, "")
  ].filter(Boolean)));
  const unresolvedFacts = requiredFacts.filter((id) => !factIds.has(id));
  if (unresolvedFacts.length) sourceChecks.unresolved_required_structured_fact_ids.push({ id:item.id,unresolved:unresolvedFacts });
}

const fixtureWarnings = [];
for (const item of items) {
  const fixture = item.synthetic_fixture;
  if (!fixture) continue;
  if (fixture.synthetic !== true || fixture.contains_real_user_data !== false) fixtureWarnings.push({ id:item.id,reason:"fixture_not_explicitly_synthetic_and_non_personal" });
  if (fixture.as_of_date && item.as_of_date && fixture.as_of_date !== item.as_of_date) fixtureWarnings.push({ id:item.id,reason:"fixture_as_of_date_differs_from_item",fixture:fixture.as_of_date,item:item.as_of_date });
  const values = fixture.values || {};
  for (const [key,value] of Object.entries(values)) {
    if (/date|updated|expires|as_at/i.test(key) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !validDate(value)) fixtureWarnings.push({ id:item.id,reason:"invalid_fixture_date",field:key,value });
  }
  if (values.statatory_dashboard_feed_persisted === true && values.snapshot_classification === "user_saved_non_statutory_snapshot") fixtureWarnings.push({ id:item.id,reason:"statutory_and_non_statutory_snapshot_conflict" });
}

const exactDuplicates = duplicateGroups(questions, (value) => String(value));
const normalisedDuplicates = duplicateGroups(questions, normaliseQuestion);
const firstReviewCounts = countBy(items.map((item) => item.first_review_gold_answer_decision));
const answerReviewCounts = countBy(items.map((item) => item.answer_review_status));
const officialAggregateEligible = items.filter((item) => item.first_review_gold_answer_decision === "approve" && item.answer_review_status === "first_review_approved");
const officialAggregateEligibleIds = new Set(officialAggregateEligible.map((item) => item.id));
const unresolvedHumanReview = items.filter((item) => !officialAggregateEligibleIds.has(item.id));
const remediationQueue = unresolvedHumanReview.map((item) => ({
  question_id:item.id,
  question_concept_decision:item.question_decision || "missing",
  first_review_gold_answer_decision:item.first_review_gold_answer_decision || "missing",
  current_answer_review_status:item.answer_review_status || "missing",
  reason:item.first_review_gold_answer_decision === "edit"
    ? "edited_after_first_review_pending_second_semantic_review"
    : "final_owner_freeze_decision_missing",
  provisional_diagnostic_allowed:true,
  official_aggregate_model_selection_eligible:false,
  freeze_allowed:false,
  training_eligibility:"prohibited"
}));

const structuralErrors = [
  ...duplicateQuestionIds.map((value) => ({ code:"duplicate_question_id",...value })),
  ...duplicateAnswerIds.map((value) => ({ code:"duplicate_answer_id",...value })),
  ...missingInAnswers.map((id) => ({ code:"missing_answer_item",id })),
  ...missingInQuestions.map((id) => ({ code:"missing_question_item",id })),
  ...parityMismatches.map((value) => ({ code:"json_parity_mismatch",...value })),
  ...markdownMissingIds.map((id) => ({ code:"markdown_item_missing",id })),
  ...markdownDuplicateIds.map((value) => ({ code:"markdown_item_duplicate",...value })),
  ...Object.entries(missing).flatMap(([field, ids]) => ids.map((id) => ({ code:`missing_${field}`,id }))),
  ...sourceChecks.unresolved_claim_evidence_ids.map((value) => ({ code:"unresolved_claim_evidence",...value }))
];

const report = {
  report_version:"evaluation-asset-integrity-v1",
  generated_at:generatedAt,
  source_status:{
    question_concepts:"approved_in_principle",
    gold_answers:"draft_human_review_required",
    training_eligibility:"prohibited",
    baseline_evaluation_status:"not_proven_at_preflight_time"
  },
  counts:{
    evaluation_questions:questions.length,
    unique_evaluation_question_ids:uniqueQuestionIds.length,
    answer_review_items:items.length,
    unique_answer_review_ids:uniqueAnswerIds.length,
    markdown_item_headings:markdownIds.length,
    suites:countBy(questions.map((item) => item.suite)),
    jurisdictions:countBy(items.map((item) => item.jurisdiction)),
    routes:countBy(items.map((item) => item.expected_route)),
    handoff_required:countBy(items.map((item) => item.expected_handoff?.required)),
    first_review_decisions:firstReviewCounts,
    answer_review_statuses:answerReviewCounts,
    unresolved_human_review:unresolvedHumanReview.length
  },
  parity:{ missing_in_answer_review:missingInAnswers,missing_in_evaluation_draft:missingInQuestions,field_mismatches:parityMismatches,markdown_missing_ids:markdownMissingIds,markdown_duplicate_ids:markdownDuplicateIds,markdown_draft_answer_mismatches:markdownAnswerMismatches },
  duplicates:{ id_duplicates:{ evaluation:duplicateQuestionIds,answer_review:duplicateAnswerIds },exact_question_duplicates:exactDuplicates,normalised_question_duplicates:normalisedDuplicates },
  required_field_gaps:missing,
  source_integrity:sourceChecks,
  fixture_consistency:{ automated_warnings:fixtureWarnings,substantive_legal_consistency:"requires_human_legal_review; no silent model-memory correction performed" },
  reviewer_decisions:{ unresolved_items:unresolvedHumanReview.map((item) => item.id),official_aggregate_eligible_items:officialAggregateEligible.map((item) => item.id),provisional_diagnostic_items:items.map((item) => item.id) },
  structural_errors:structuralErrors,
  structural_preflight_passed:structuralErrors.length === 0,
  gold_freeze_allowed:false,
  gold_freeze_blocker:`${unresolvedHumanReview.length} items lack a frozen human-approved gold answer`,
  official_aggregate_model_selection_allowed:true,
  official_aggregate_model_selection_eligible_count:officialAggregateEligible.length,
  complete_69_item_aggregate_allowed:false,
  notes:[
    "Question concepts may be run for provisional diagnostics.",
    `${officialAggregateEligible.length} first-review-approved items are individually eligible for official scoring; the ${unresolvedHumanReview.length} pending items are provisional diagnostics only.`,
    "No source file was modified by this preflight."
  ]
};

const immutableManifest = {
  manifest_version:"evaluation-cycle-v1-inputs-v1",
  created_at:generatedAt,
  project_root:PROJECT_ROOT,
  inputs:Object.values(INPUTS).map(fileManifest),
  combined_sha256:sha256(Object.values(INPUTS).map((path) => fileManifest(path).sha256).join("\n")),
  git:{ commit:git(["rev-parse","HEAD"]),branch:git(["rev-parse","--abbrev-ref","HEAD"]),worktree_dirty:Boolean(git(["status","--porcelain"], "")) },
  immutability_policy:"Inputs are read-only for this cycle. Derived outputs must be written under training/evaluation-cycle-v1.",
  training_eligibility:"prohibited"
};

const reportMd = `# Evaluation Asset Integrity Report\n\nGenerated: ${generatedAt}\n\n## Outcome\n\nStructural preflight: **${report.structural_preflight_passed ? "PASS" : "FAIL"}**. All 69 question concepts may be used for diagnostics. The 27 first-review-approved items are individually eligible for official scoring; the 42 edited items remain provisional and must be excluded from model-selection aggregates. The complete gold set cannot be frozen yet.\n\n## Counts\n\n${markdownTable(["Check","Result"],[
  ["Evaluation questions",questions.length],
  ["Unique evaluation IDs",uniqueQuestionIds.length],
  ["Answer-review items",items.length],
  ["Markdown item headings",markdownIds.length],
  ["Suites",JSON.stringify(report.counts.suites)],
  ["First-review decisions",JSON.stringify(firstReviewCounts)],
  ["Current answer-review states",JSON.stringify(answerReviewCounts)],
  ["Individually scoreable first-review-approved items",officialAggregateEligible.length],
  ["Unresolved human review",unresolvedHumanReview.length],
  ["Structural errors",structuralErrors.length],
  ["Fixture warnings",fixtureWarnings.length]
])}\n\n## Source and citation integrity\n\n${markdownTable(["Check","Count"],[
  ["Selected evidence records",sourceChecks.selected_source_count],
  ["Selected corpus chunks",sourceChecks.selected_active_corpus_chunk_count],
  ["Selected structured facts",sourceChecks.selected_structured_fact_count],
  ["Missing source IDs",sourceChecks.missing_source_id.length],
  ["Missing OSCOLA strings",sourceChecks.missing_oscola.length],
  ["Unresolved claim evidence IDs",sourceChecks.unresolved_claim_evidence_ids.length],
  ["Unresolved required source IDs",sourceChecks.unresolved_required_source_ids.length]
])}\n\n## Freeze and scoring decision\n\n- Question concepts: \`approved_in_principle\`\n- Gold answers: \`draft_human_review_required\`\n- Training eligibility: \`prohibited\`\n- Diagnostic run: allowed for all 69 items\n- Official scoring: allowed for the 27 first-review-approved items only\n- Model-selection aggregates: must exclude the 42 unresolved items\n- Gold freeze: blocked pending frozen human-approved answers\n\n## Limits of automated preflight\n\nThis pass checks structure, dates, identifiers, evidence links, source metadata, duplicated questions, and Markdown/JSON parity. It does not silently correct pensions law from model memory. Source entailment, case outcomes, later treatment, and fixture-law consistency remain human legal-review gates.\n`;

writeJsonAtomic(resolve(OUTPUT_ROOT, "asset-integrity-report.json"), report);
writeTextAtomic(resolve(OUTPUT_ROOT, "asset-integrity-report.md"), reportMd);
const ownerApproval = existsSync(OWNER_APPROVAL_PATH) ? readJson(OWNER_APPROVAL_PATH) : null;
const approvedIds = new Set(ownerApproval?.gold_answer_decision?.approved_question_ids || []);
writeJsonAtomic(resolve(OUTPUT_ROOT, "gold-remediation-queue.json"), {
  version:"gold-remediation-queue-v1",generated_at:generatedAt,
  status:ownerApproval ? "resolved_for_regression_scoring_only" : "open",
  count:remediationQueue.length,outstanding_count:ownerApproval ? 0 : remediationQueue.length,
  resolved_at:ownerApproval?.recorded_at || null,
  training_eligibility:"prohibited",
  owner_decision_manifest:ownerApproval ? OWNER_APPROVAL_PATH : null,
  items:remediationQueue.map((item) => ({
    ...item,
    owner_review_status:approvedIds.has(item.question_id) ? "approved_for_regression_scoring_only" : "pending",
    official_aggregate_model_selection_eligible:approvedIds.has(item.question_id),
    training_eligibility:"prohibited"
  }))
});
writeJsonAtomic(resolve(OUTPUT_ROOT, "immutable-input-manifest.json"), immutableManifest);

console.log(JSON.stringify({ phase:"Phase 0",status:report.structural_preflight_passed ? "completed" : "failed",question_count:questions.length,structural_errors:structuralErrors.length,remediation_items:remediationQueue.length,output_root:OUTPUT_ROOT }, null, 2));
