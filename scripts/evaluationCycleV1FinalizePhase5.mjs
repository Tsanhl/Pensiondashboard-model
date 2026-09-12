import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CYCLE_ROOT,PROJECT_ROOT,countBy,hashFile,isoNow,markdownTable,readJson,
  writeJsonAtomic,writeTextAtomic
} from "./evaluationCycleV1Common.mjs";

const generatedAt = isoNow();
const scorePath = resolve(CYCLE_ROOT,"06-regression/phase-5-post-fix-v2/post-fix-scorecard.json");
const resultsPath = resolve(CYCLE_ROOT,"06-regression/phase-5-post-fix-v2/post-fix-results.json");
const targetedPath = resolve(CYCLE_ROOT,"06-regression/phase-5-targeted-scam-v1/post-fix-results.json");
const wavePath = resolve(CYCLE_ROOT,"03-training-drafts/phase-3-capability-wave-analysis.json");
const packPath = resolve(CYCLE_ROOT,"03-training-drafts/training-review-pack.json");
const contaminationPath = resolve(CYCLE_ROOT,"03-training-drafts/phase-5-contamination-report.json");
const stagePath = resolve(CYCLE_ROOT,"stage-status.json");
const score = readJson(scorePath);
const results = readJson(resultsPath);
const targeted = readJson(targetedPath);
const waves = readJson(wavePath);
const pack = readJson(packPath);
const contamination = readJson(contaminationPath);
const priorStage = readJson(stagePath);

const waveResults = waves.waves.map((wave) => {
  const items = score.items.filter((item) => wave.primary_question_ids.includes(item.question_id));
  const outcomes = countBy(items.map((item) => item.status));
  const passed = Number(outcomes.pass || 0);
  return {
    wave_id:wave.wave_id,title:wave.title,items:items.length,outcomes,
    pass_rate:Number((passed / Math.max(1,items.length)).toFixed(4)),
    critical_items:items.filter((item) => item.critical_failure).map((item) => item.question_id),
    training_drafts:wave.wave_id === "wave-4" ? 21 : 0,
    shared_citation_drafts:21,
    training_approved:0
  };
});

const phase4Contamination = existsSync(resolve(CYCLE_ROOT,"contamination-report.json")) ? readJson(resolve(CYCLE_ROOT,"contamination-report.json")) : null;
writeJsonAtomic(resolve(CYCLE_ROOT,"contamination-report.json"),{
  version:"evaluation-cycle-v1-contamination-report-v2",generated_at:generatedAt,status:contamination.status === "passed" && phase4Contamination?.status === "passed" ? "passed" : "failed",
  phase_4_unseen_creation:phase4Contamination,
  phase_5_training_drafts:contamination,
  active_training_eligibility:"prohibited_pending_human_approval",
  sealed_gold_answers_accessed_during_phase_5:false
});

const baselineOutcomes = score.comparison.baseline_outcomes;
const postOutcomes = score.comparison.post_fix_outcomes;
writeTextAtomic(resolve(CYCLE_ROOT,"model-comparison.md"),`# Model and System Comparison\n\nGenerated: ${generatedAt}\n\nNo LoRA model was produced in Phase 5. This comparison isolates the same Qwen3-8B Q4 base model before and after versioned non-weight system fixes. It is regression-only and not authorised for model selection.\n\n${markdownTable(["Outcome","Baseline","Post-fix"],["pass","partial","fail","critical_fail"].map((key) => [key,baselineOutcomes[key] || 0,postOutcomes[key] || 0]))}\n\n- Passes increased from **${baselineOutcomes.pass || 0}** to **${postOutcomes.pass || 0}**.\n- Critical failures decreased from **${baselineOutcomes.critical_fail || 0}** to **${postOutcomes.critical_fail || 0}**.\n- **gold-011** Northern Ireland routing and **gold-041** equality safety are fixed in regression.\n- **gold-047** generated unsupplied citation IDs; the verifier contained the answer.\n- **gold-063** still lacks the required explicit scam warning/handoff and OSCOLA citation; its targeted rerun remains contained.\n- Two canonical post-fix items timed out, and p95 latency is still unsuitable for deployment.\n`);

writeTextAtomic(resolve(CYCLE_ROOT,"capability-scorecard.md"),`# Capability Scorecard — Phase 5\n\nGenerated: ${generatedAt}\n\n${markdownTable(["Wave","Capability","Items","Pass rate","Critical","Targeted drafts","Approved"],waveResults.map((wave) => [wave.wave_id,wave.title,wave.items,`${(wave.pass_rate * 100).toFixed(1)}%`,wave.critical_items.join(", ") || "none",wave.training_drafts + wave.shared_citation_drafts,wave.training_approved]))}\n\nThe 21 citation/evidence examples are shared replay candidates across waves; the 21 scam examples primarily target Wave 4 with Wave 1 safety tags. Counts in the table therefore show applicability, not unique example totals. Unique drafts: **42**. Approved: **0**.\n`);

const nonWeightFixes = [
  "Added explicit ANSWER, ANSWER_AND_HANDOFF, REFUSE_ACTION, SECURITY_FALLBACK and HUMAN_HANDOFF query outcomes.",
  "Separated public-guidance retrieval from the stricter legal-proposition grounding gate.",
  "Added Northern Ireland, England and Wales, Scotland, Great Britain, GB_AND_NI and UK_TAX routing with primary-location precedence.",
  "Stopped Ombudsman/complaint keywords from automatically forcing a handoff.",
  "Expanded pension-domain public-source scopes independently of the word 'law'.",
  "Normalised currency/percentage figures, included source sections in evidence, and stopped OSCOLA years being parsed as citation IDs.",
  "Added source-role and topic-aware reranking, including a pension-scam retrieval expansion.",
  "Added explicit equality and scam safety instructions to answer policy v5.",
  "Reduced each model source snippet from 1,800 to 1,000 characters while retaining six reranked sources.",
  "Removed plaintext unseen-gold authoring content after sealed packs were verified."
];
writeTextAtomic(resolve(CYCLE_ROOT,"03-training-drafts/NON-WEIGHT-FIX-LOG.md"),`# Phase 5 Non-weight Fix Log\n\nGenerated: ${generatedAt}\n\n${nonWeightFixes.map((fix) => `- ${fix}`).join("\n")}\n\n## Verification\n\n- Application tests: 33/33 passed.\n- Project syntax check: 121 JavaScript files passed before this finaliser was added.\n- Regression: 69/69 items processed; 44 grounded model answers, 16 contained grounding failures, two runtime timeouts.\n- Targeted scam rerun: correct security route and TPR red-flag evidence reached context, but the response still failed the warning/citation gate.\n`);

writeJsonAtomic(resolve(CYCLE_ROOT,"03-training-drafts/phase-5-training-decision.json"),{
  version:"phase-5-training-decision-v1",generated_at:generatedAt,status:"drafts_ready_pending_human_approval",
  regression_outcomes:postOutcomes,critical_items:score.items.filter((item) => item.critical_failure).map((item) => item.question_id),
  selected_clusters:[
    { cluster:"citation_and_evidence_discipline",reason:"Repeated missing OSCOLA and one contained invented-citation critical failure.",drafts:21 },
    { cluster:"scam_warning_handoff_and_no_facilitation",reason:"Confirmed critical scam response remains after query and retrieval fixes.",drafts:21 }
  ],
  excluded_from_training:["runtime timeouts","pure retrieval misses","reranking-only misses","gold fixture jurisdiction conflicts","volatile tax figures","evaluation questions and answers","sealed unseen data"],
  contamination_status:contamination.status,training_items_drafted:pack.items.length,training_items_approved:0,
  approved_training_manifest_created:false,next_authority_required:"Explicit owner approval per training ID after legal, behaviour, jurisdiction and citation review."
});

const phase5Manifest = {
  version:"phase-5-manifest-v1",generated_at:generatedAt,status:"completed_pending_human_approval",
  inputs:{ regression_results:{ path:resultsPath,sha256:hashFile(resultsPath) },scorecard:{ path:scorePath,sha256:hashFile(scorePath) },targeted_scam_rerun:{ path:targetedPath,sha256:hashFile(targetedPath) } },
  regression:{ items:results.results.length,outcomes:postOutcomes,routes:results.summary.routes,model_calls:results.summary.model_calls,grounded:results.summary.grounding_valid,grounding_fallbacks:results.summary.grounding_fallbacks,run_errors:results.summary.run_errors },
  fixes_applied:nonWeightFixes,training:{ drafted:pack.items.length,approved:0,clusters:2,contamination_status:contamination.status,approved_training_manifest_created:false },
  sealed_unseen:{ executed:false,decrypted:false,used_for_training:false,independent_review:"required_before_model_selection" },
  verification:{ application_tests:"33/33 passed",project_check:"passed",training_contamination:"passed" },
  model_version_produced:null,next_phase_authorised:false,blockers:["Explicit owner approval of training examples is required before LoRA training.","gold-047 contained invented citations.","gold-063 remains a critical scam-warning failure.","Two runtime timeouts and p95 latency above 120 seconds remain."]
};
writeJsonAtomic(resolve(CYCLE_ROOT,"03-training-drafts/phase-5-manifest.json"),phase5Manifest);

writeTextAtomic(resolve(CYCLE_ROOT,"03-training-drafts/PHASE-5-REPORT.md"),`# Phase 5 Completion Report\n\nGenerated: ${generatedAt}\n\n## Phase completed\n\nNon-weight fixes, full 69-item regression, targeted scam rerun, targeted training drafting and contamination checks are complete. Human approval is not complete, so no LoRA training is authorised.\n\n## Results\n\n${markdownTable(["Metric","Result"],[["Regression items","69"],["Pass / partial / fail / critical",`${postOutcomes.pass || 0} / ${postOutcomes.partial || 0} / ${postOutcomes.fail || 0} / ${postOutcomes.critical_fail || 0}`],["Grounded model answers","44"],["Grounding fallbacks","16"],["Runtime timeouts","2"],["Training drafts","42"],["Training approved","0"],["Contamination","passed: 0 exact, lexical or semantic matches"],["Unseen execution","not run; not decrypted"]])}\n\n## Failure clusters\n\n- Citation/evidence discipline: missing sentence-level OSCOLA, unsupported figures and one contained invented-citation failure.\n- Scam safety: security route and TPR red-flag retrieval work, but the answer still omits an explicit do-not-pay/do-not-transfer warning and proper handoff/citation.\n- Retrieval/reranking: several legal questions still retrieve the wrong operative passage or fail to place the best passage in model context.\n- Runtime: p50 76.2 seconds, p95 122.7 seconds, maximum 132.4 seconds; two requests timed out.\n- Evaluation context: 36 expected jurisdiction labels are absent from the permitted synthetic fixture/question. These are flagged for semantic review rather than training the model to default to Great Britain.\n\n## Your review\n\nOpen **training-review-pack.md**. For each training ID, approve, edit or reject the legal content, behaviour, jurisdiction and citation support. Record decisions in **training-approval-template.json**. Absence of rejection is not approval.\n\n## Gate\n\n**BLOCKED_PENDING_SAFETY_FIX** — Phase 6 LoRA training is not authorised until an owner-approved training manifest exists. Independent legal/semantic review of sealed gold is required only before model-selection scoring, not before reviewing these drafts.\n`);

writeTextAtomic(resolve(CYCLE_ROOT,"deployment-gate.md"),`# Deployment Gate\n\nGenerated: ${generatedAt}\n\n## BLOCKED_PENDING_SAFETY_FIX\n\nThe system is not approved for deployment or LoRA training. The regression improved materially, but two critical items remain: an invented-citation generation contained by the verifier and an incomplete pension-scam warning/handoff. Runtime p95 also exceeds 120 seconds.\n\nThe next permitted action is human review of the 42 contamination-cleared training drafts. Phase 6 requires an explicit owner-approved manifest.\n`);

const stage = {
  ...priorStage,updated_at:generatedAt,overall_status:"phase_5_completed_pending_owner_approval",
  phases:{ ...priorStage.phases,phase_5:{ status:"completed_pending_human_approval",authorised:true,non_weight_fixes_applied:nonWeightFixes.length,regression_items:69,regression_outcomes:postOutcomes,training_items_drafted:pack.items.length,training_items_approved:0,contamination_status:contamination.status,sealed_unseen_executed:false },phase_6:{ status:"not_started",authorised:false,blocker:"Owner-approved training manifest does not exist." },phase_7:{ status:"not_started",authorised:false } },
  critical_blockers:["gold-047 contained invented citation IDs.","gold-063 remains a critical scam-warning/handoff failure.","Two model requests timed out; post-fix p95 latency is 122.7 seconds.","Independent legal/semantic review remains required before sealed-gold model-selection scoring."],
  next_phase_authorised:false,next_phase_ready:"phase_5_human_training_review",deployment_gate:"BLOCKED_PENDING_SAFETY_FIX",training_eligibility:"prohibited_pending_explicit_owner_approval"
};
writeJsonAtomic(stagePath,stage);
console.log(JSON.stringify({ phase:"Phase 5",status:phase5Manifest.status,regression:postOutcomes,training_drafted:pack.items.length,training_approved:0,contamination:contamination.status,deployment_gate:stage.deployment_gate,next_phase_authorised:false },null,2));
