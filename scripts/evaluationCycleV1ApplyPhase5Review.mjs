import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderCitationMarkers } from "../server/services/citationRendererService.js";
import { CYCLE_ROOT,hashFile,isoNow,readJson,sha256,writeJsonAtomic,writeTextAtomic } from "./evaluationCycleV1Common.mjs";

const generatedAt = isoNow();
const root = resolve(CYCLE_ROOT,"03-training-drafts");
const packPath = resolve(root,"training-review-pack.json");
const contaminationPath = resolve(root,"phase-5-contamination-report.json");
const exportContractPath = resolve(root,"training-export-contract.json");
const stagePath = resolve(CYCLE_ROOT,"stage-status.json");
const pack = readJson(packPath);
const contamination = readJson(contaminationPath);
const exportContract = readJson(exportContractPath);
const stage = readJson(stagePath);
const approved = pack.items.filter((item) => item.human_review_status === "approved_for_phase_6");
const byId = new Map(pack.items.map((item) => [item.training_id,item]));

const failures = [];
if (pack.items.length !== 42 || approved.length !== 42 || pack.counts?.pending !== 0 || pack.counts?.rejected !== 0) failures.push("reviewer_count_mismatch");
if (contamination.status !== "passed") failures.push("contamination_not_passed");
const oldTitles = ["Pension scams","Check a financial firm or service","Pension glossary","Diversifying investments"];
for (const item of pack.items) {
  if (/\(accessed\s+\d/i.test(item.ideal_answer)) failures.push(`${item.training_id}:memorised_access_date`);
  if (oldTitles.some((title) => item.retrieved_evidence.some((source) => source.citation_metadata?.title === title))) failures.push(`${item.training_id}:stale_title`);
  if (item.handoff_required && !/contact|refer|report|seek|review|security team|legal team|adviser|provider|payroll|bank|independently verified security guidance|FCA Firm Checker/i.test(item.ideal_answer)) failures.push(`${item.training_id}:hidden_handoff`);
  const sources = item.retrieved_evidence.map((source) => ({
    sourceId:source.source_id,title:source.title,
    citationMetadata:{ kind:source.citation_metadata?.kind,author:source.citation_metadata?.author,title:source.citation_metadata?.title,pinpoint:source.citation_metadata?.pinpoint,accessedAt:source.citation_metadata?.accessed_at,userVisible:source.citation_metadata?.user_visible }
  }));
  const rendered = renderCitationMarkers({ answer:item.ideal_answer,sources });
  if (!rendered.valid) failures.push(`${item.training_id}:citation_render_failure`);
  if (/\{\{cite:/.test(rendered.answer || "")) failures.push(`${item.training_id}:source_id_leaked_after_render`);
  const markerIds = [...item.ideal_answer.matchAll(/\{\{cite:([a-zA-Z0-9._:-]+)\}\}/g)].map((match) => match[1]);
  for (const markerId of markerIds) {
    const source = item.retrieved_evidence.find((candidate) => candidate.source_id === markerId);
    if (!source || source.citation_metadata?.user_visible === false || ["system_policy","internal_hidden"].includes(source.source_role)) failures.push(`${item.training_id}:invalid_visible_marker:${markerId}`);
  }
  if (item.retrieved_evidence.some((source) => ["system_policy","internal_hidden"].includes(source.source_role) && source.citation_metadata?.user_visible !== false)) failures.push(`${item.training_id}:internal_source_not_hidden`);
  if (item.gold_similarity_check !== "passed") failures.push(`${item.training_id}:contamination_status_not_propagated`);
}

const cite013 = byId.get("train-cite-013");
const cite013Source = cite013?.retrieved_evidence.find((source) => source.source_id === "train-gb-only-rule");
if (cite013Source?.source_role !== "synthetic_legal_fixture" || cite013Source?.is_synthetic !== true || cite013Source?.eligible_for_active_law_retrieval !== false || cite013Source?.authority_status !== "evaluation_or_training_fixture_only") failures.push("train-cite-013:synthetic_source_isolation_missing");
const scam001 = byId.get("train-scam-001")?.ideal_answer || "";
if (!(scam001.indexOf("training-ncsc-spot-phishing-v1") < scam001.indexOf("training-ncsc-shared-information-v1")) || !/full antivirus scan/i.test(scam001)) failures.push("train-scam-001:evidence_sequence_or_recovery_incorrect");
const scam002 = byId.get("train-scam-002")?.ideal_answer || "";
if (/wallet provider/i.test(scam002) || !/wallet software or hardware/i.test(scam002) || !/Never send the seed phrase to support staff/i.test(scam002)) failures.push("train-scam-002:wallet_recovery_wording_incorrect");
const scam007 = byId.get("train-scam-007")?.ideal_answer || "";
if (/signature collection/i.test(scam007) || !/material sections are blank/i.test(scam007) || !/pressed to sign before the form is complete/i.test(scam007)) failures.push("train-scam-007:signature_warning_overbroad");
for (const id of ["train-scam-008","train-scam-011"]) {
  const item = byId.get(id);
  if (/\bReport Fraud\b/i.test(item?.ideal_answer || "") || !/configured for your jurisdiction/i.test(item?.ideal_answer || "") || item?.synthetic_fixture?.user_jurisdiction !== "not supplied") failures.push(`${id}:jurisdiction_routing_not_fail_closed`);
}
const scam018 = byId.get("train-scam-018");
if (!/defined benefit pension transfer/i.test(scam018?.user_question || "") || !/relevant pension-transfer permission/i.test(scam018?.ideal_answer || "")) failures.push("train-scam-018:db_scope_not_aligned");
const scam020 = byId.get("train-scam-020");
if (/has been quarantined/i.test(scam020?.ideal_answer || "") || scam020?.synthetic_fixture?.quarantine_status !== "not supplied") failures.push("train-scam-020:false_quarantine_claim");

const structures = new Set(pack.items.filter((item) => item.training_id.startsWith("train-scam-") && item.handoff_required).map((item) => item.surface_structure).filter(Boolean));
if (structures.size < 4) failures.push("scam_surface_structures_below_four");
if (exportContract.completion_target_field !== "ideal_answer" || exportContract.allowed_completion_fields?.length !== 1 || exportContract.allowed_completion_fields[0] !== "ideal_answer") failures.push("completion_target_not_isolated");
for (const field of ["rendered_answer_preview","citation_metadata","accessed_at","policy_basis"]) if (!exportContract.excluded_from_completion?.includes(field)) failures.push(`missing_export_exclusion:${field}`);
if (exportContract.citation_contract?.final_user_output_must_not_contain_source_ids !== true || exportContract.citation_contract?.unknown_or_hidden_source_tokens !== "fail_closed") failures.push("final_output_citation_gate_missing");
if (failures.length) throw new Error(`Phase 5 second-review application failed: ${failures.join(", ")}`);

const itemEntries = approved.map((item) => ({
  training_id:item.training_id,capability:item.capability,failure_cluster:item.failure_cluster,example_kind:item.example_kind,
  item_sha256:sha256(JSON.stringify(item)),review_status:item.human_review_status,approval_basis:item.approval_basis,
  gold_similarity_check:item.gold_similarity_check,legal_content:"approved",behaviour_label:"approved",jurisdiction:"approved",
  citation_source_support:"approved",personal_data:"synthetic",completion_target_field:"ideal_answer"
}));
writeJsonAtomic(resolve(root,"approved-training-manifest.json"),{
  version:"phase-5-approved-training-manifest-v2",generated_at:generatedAt,status:"phase_6_authorised_not_started",
  phase_6_authorised:true,training_run_authorised:true,training_started:false,model_selection_authorised:false,
  training_eligibility:"approved_manifest_only",owner_decision:{ first_review_approved:20,second_review_direct_approved:14,preapproved_exact_edits_applied:8,total_approved:42,rejected:0,recorded_on:"2026-08-28" },
  source_pack:{ path:packPath,sha256:hashFile(packPath) },contamination_report:{ path:contaminationPath,sha256:hashFile(contaminationPath),status:"passed" },
  export_contract:{ path:exportContractPath,sha256:hashFile(exportContractPath),completion_target_field:"ideal_answer",rendered_preview_is_training_target:false },
  approved_items:itemEntries,pending_second_review_ids:[],rejected_items:[],protected_evaluation_assets_excluded:true,sealed_unseen_accessed:false
});

writeJsonAtomic(resolve(root,"phase-5-human-review-decision.json"),{
  version:"phase-5-human-review-decision-v2",recorded_at:generatedAt,
  first_review:{ approve:20,edit:22,reject:0 },second_review:{ approve:14,preapproved_exact_edits:8,reject:0,third_substantive_review_required:false },
  exact_edit_ids:["train-cite-013","train-scam-001","train-scam-002","train-scam-007","train-scam-008","train-scam-011","train-scam-018","train-scam-020"],
  final_decision:{ approved:42,pending:0,rejected:0 },global_export_conditions:{ completion_target_is_ideal_answer_only:"passed",rendered_preview_excluded:"passed",renderer_owns_oscola_and_access_dates:"passed",internal_sources_hidden:"passed",contamination_refresh:"passed" },
  phase_6_authorised:true,training_started:false,deployment_gate:"APPROVED_FOR_NEXT_DEVELOPMENT_PHASE"
});

const priorAggregateContamination = existsSync(resolve(CYCLE_ROOT,"contamination-report.json")) ? readJson(resolve(CYCLE_ROOT,"contamination-report.json")) : null;
writeJsonAtomic(resolve(CYCLE_ROOT,"contamination-report.json"),{
  version:"evaluation-cycle-v1-contamination-report-v4",generated_at:generatedAt,status:"passed",
  phase_4_unseen_creation:priorAggregateContamination?.phase_4_unseen_creation || null,phase_5_training_drafts:contamination,
  active_training_eligibility:"approved_manifest_only",protected_questions:contamination.protected_sets.total_questions,
  exact_matches:0,normalised_or_lexical_matches:0,semantic_near_duplicates:0,sealed_gold_answers_accessed_during_phase_5:false
});

writeJsonAtomic(resolve(root,"phase-5-training-decision.json"),{
  version:"phase-5-training-decision-v3",generated_at:generatedAt,status:"all_42_approved_phase_6_authorised_not_started",
  owner_decision:{ approved:42,pending:0,rejected:0 },training_items_drafted:42,training_items_approved:42,
  approved_training_manifest_created:true,approved_training_manifest_is_partial:false,training_run_authorised:true,training_started:false,
  contamination_status:"passed",next_step:"Run the narrow pre-training regression, then start the manifest-pinned cumulative LoRA when requested."
});

writeJsonAtomic(resolve(root,"phase-5-manifest.json"),{
  version:"phase-5-manifest-v3",generated_at:generatedAt,status:"completed_all_training_examples_approved",
  training:{ drafted:42,approved:42,pending:0,rejected:0,contamination_status:"passed",approved_training_manifest_created:true,manifest_is_partial:false,completion_target_field:"ideal_answer" },
  citation_system:{ policy_version:"pension-answer-policy-v6",renderer:"metadata_driven",model_outputs_citation_tokens:true,renderer_owns_titles_pinpoints_and_access_dates:true,fail_closed:true },
  sealed_unseen:{ executed:false,decrypted:false,used_for_training:false,independent_review:"required_before_model_selection" },
  model_version_produced:null,lora_training_started:false,next_phase_authorised:true,
  deployment_blockers:["Critical regression and latency findings remain; Phase 6 authorisation is not deployment approval.","Independent legal/semantic review is required before sealed unseen gold can be used for model selection."]
});

writeTextAtomic(resolve(root,"PHASE-5-HUMAN-REVIEW-APPLICATION.md"),`# Phase 5 Human Review Application\n\nGenerated: ${generatedAt}\n\n- First-review approvals: **20**\n- Second-review direct approvals: **14**\n- Pre-approved deterministic edits applied: **8**\n- Final approved total: **42**\n- Pending / rejected: **0 / 0**\n- Contamination: **passed**\n- Completion target: **ideal_answer only**\n- Citation rendering: **metadata-driven and fail-closed**\n- Phase 6: **authorised, not started**\n\nThe full manifest is hash-pinned. Any content change invalidates the affected approval. Rendered citation previews remain review-only and cannot become LoRA completion targets.\n`);

writeTextAtomic(resolve(CYCLE_ROOT,"capability-scorecard.md"),`# Capability Scorecard — Phase 5 Closed\n\nGenerated: ${generatedAt}\n\n| Cluster | Drafted | Approved | Pending | Rejected |\n|---|---:|---:|---:|---:|\n| Citation and evidence discipline | 21 | 21 | 0 | 0 |\n| Scam warning, handoff and no facilitation | 21 | 21 | 0 | 0 |\n| **Total** | **42** | **42** | **0** | **0** |\n\nPhase 6 is authorised but no LoRA run has started. The 69 development/regression items and all 60 sealed unseen questions remain excluded from training.\n`);

writeTextAtomic(resolve(root,"NON-WEIGHT-FIX-LOG.md"),`# Phase 5 Non-weight Fix Log\n\nGenerated: ${generatedAt}\n\n- Uses \`pension-answer-policy-v6\` and metadata-driven, fail-closed citation rendering.\n- Model completion targets contain citation tokens; rendered titles, pinpoints, punctuation and access dates are review/runtime output only.\n- Synthetic legal fixtures are excluded from active-law retrieval.\n- Fraud-reporting handoffs fail closed when jurisdiction is not supplied.\n- Uploaded document instructions are untrusted without falsely claiming a quarantine action occurred.\n- Required handoff destinations are visible; internal policies remain hidden.\n- No LoRA run was started and no sealed unseen answer was opened.\n`);

stage.updated_at = generatedAt;
stage.overall_status = "phase_6_authorised_not_started";
stage.phases.phase_5 = { ...stage.phases.phase_5,status:"completed_all_42_approved",training_items_drafted:42,training_items_approved:42,training_items_pending_second_review:0,training_items_rejected:0,contamination_status:"passed",citation_renderer:"metadata_driven_fail_closed" };
stage.phases.phase_6 = { status:"authorised_not_started",authorised:true,training_run_authorised:true,training_started:false,approved_training_items:42,manifest:"03-training-drafts/approved-training-manifest.json" };
stage.phases.phase_7 = { ...stage.phases.phase_7,status:"not_started",authorised:false };
stage.next_phase_authorised = true;
stage.next_phase_ready = "phase_6_pretraining_regression_then_cumulative_lora";
stage.deployment_gate = "APPROVED_FOR_NEXT_DEVELOPMENT_PHASE";
stage.training_eligibility = "approved_manifest_only";
writeJsonAtomic(stagePath,stage);

writeTextAtomic(resolve(CYCLE_ROOT,"deployment-gate.md"),`# Deployment Gate\n\nGenerated: ${generatedAt}\n\n## APPROVED_FOR_NEXT_DEVELOPMENT_PHASE\n\nAll 42 targeted examples are explicitly approved and contamination checks passed. Phase 6 is authorised but has not started. This is not model-selection or deployment approval: critical regression, latency and independent sealed-gold review requirements remain.\n`);

writeTextAtomic(resolve(root,"PHASE-5-REPORT.md"),`# Phase 5 Completion Report\n\nGenerated: ${generatedAt}\n\n## Phase completed\n\nAll 42 targeted training examples passed human review. Fourteen of the 22 second-review items were directly approved; the remaining eight exact replacements were applied under the reviewer's pre-approval and passed deterministic validation.\n\n## Counts\n\n- Drafted / approved / pending / rejected: 42 / 42 / 0 / 0\n- Contamination: passed\n- LoRA runs: 0\n- Model versions produced: 0\n- Sealed unseen execution: not run\n\n## Next step\n\nRun the narrow post-renderer pre-training regression, then start the manifest-pinned cumulative LoRA. After training, run critical safety regression, the complete 69-item regression set and the 60-item sealed unseen set.\n`);

console.log(JSON.stringify({ phase:"Phase 5 second-review closure",approved:42,pending:0,rejected:0,contamination:"passed",phase_6_authorised:true,training_started:false,deployment_gate:"APPROVED_FOR_NEXT_DEVELOPMENT_PHASE" },null,2));
