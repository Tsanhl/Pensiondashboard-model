import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { contentHash } from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_QUALIFICATION_ROOT ||
    "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901",
);
const DATASET_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_DATASET_ROOT ||
    "training-data/private/evaluation-cycle-v2-cumulative-visible-compact-v8",
);
const COMPACT_RENDERER_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleCompactPrepareV1.mjs",
);
const TOKEN_PREFLIGHT_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleTokenPreflightV1.py",
);
const EXPORTER_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleExportV1.mjs",
);
const QUALIFIER_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleQualifyV1.mjs",
);
const paths = {
  items: resolve(ROOT, "cumulative-visible-item-register.json"),
  sources: resolve(ROOT, "cumulative-visible-source-register.json"),
  allocation: resolve(ROOT, "global-visible-allocation-draft.json"),
  contamination: resolve(ROOT, "contamination-and-echo-preflight.json"),
  provenance: resolve(ROOT, "clean-checkpoint-provenance.json"),
  compactMap: resolve(ROOT, "compact-evidence-map.json"),
  topicCoverage: resolve(ROOT, "global-visible-topic-coverage-feasibility.json"),
  wave2RetentionAudit: resolve(
    ROOT,
    "wave-2-compact-substantive-retention-audit.json",
  ),
  wave3RetentionAudit: resolve(
    ROOT,
    "independent-agent-audits/wave-3-compact-substantive-retention-audit.json",
  ),
  independentVisibleAudit: resolve(
    ROOT,
    "independent-agent-audits/independent-agent-visible-technical-legal-semantic-audit-v1.json",
  ),
  independentVisibleReport: resolve(
    ROOT,
    "independent-agent-audits/INDEPENDENT-AGENT-VISIBLE-TECHNICAL-LEGAL-SEMANTIC-AUDIT-v1.md",
  ),
  independentFinalAudit: resolve(
    ROOT,
    "independent-agent-audits/independent-agent-final-cumulative-visible-qualification-audit-v1.json",
  ),
  independentFinalReport: resolve(
    ROOT,
    "independent-agent-audits/INDEPENDENT-AGENT-FINAL-CUMULATIVE-VISIBLE-QUALIFICATION-AUDIT-v1.md",
  ),
  independentVisibleVerifier: resolve(
    ROOT,
    "independent-agent-audits/verify-root24-visible.mjs",
  ),
  custodianAttestation: resolve(
    ROOT,
    "independent-agent-audits/authorised-protected-set-custodian-attestation.json",
  ),
  candidateManifest: resolve(ROOT, "rendered-candidate/candidate-manifest.json"),
  candidateTrain: resolve(ROOT, "rendered-candidate/train.review.jsonl"),
  candidateValid: resolve(ROOT, "rendered-candidate/valid.review.jsonl"),
  candidateTokens: resolve(ROOT, "token-and-loss-mask-preflight.json"),
  owner: resolve(ROOT, "owner-development-authorisation.json"),
  checkpointPolicy: resolve(ROOT, "checkpoint-selection-policy.json"),
  approvedRepairedItems: resolve(
    "training/evaluation-cycle-v2/22-training-data-double-check-v8-final-20260901/repaired-training-items-draft.json",
  ),
  root22RepairApplicationAudit: resolve(
    "training/evaluation-cycle-v2/22-training-data-double-check-v8-final-20260901/consolidated-v8-repair-application-audit.json",
  ),
  approval: resolve(ROOT, "qualification-approval.json"),
  finalManifest: resolve(DATASET_ROOT, "dataset-manifest.json"),
  finalTrain: resolve(DATASET_ROOT, "train.jsonl"),
  finalValid: resolve(DATASET_ROOT, "valid.jsonl"),
  finalTokens: resolve(ROOT, "final-token-and-loss-mask-preflight.json"),
  compactRenderer: COMPACT_RENDERER_PATH,
  tokenPreflight: TOKEN_PREFLIGHT_PATH,
  exporter: EXPORTER_PATH,
  qualifier: QUALIFIER_PATH,
  status: resolve(ROOT, "qualification-status.json"),
};
const requiredBasePaths = Object.values(paths).filter(
  (path) =>
    ![
      paths.approval,
      paths.finalManifest,
      paths.finalTokens,
      paths.status,
    ].includes(path),
);
for (const path of requiredBasePaths) {
  if (!existsSync(path)) throw new Error(`Qualification prerequisite is missing: ${path}`);
}
const read = (path) => JSON.parse(readFileSync(path));
const sha = (path) => contentHash(readFileSync(path));
if (existsSync(paths.status)) {
  const existingStatus = read(paths.status);
  if (existingStatus.passed === true) {
    throw new Error(
      `Refusing to overwrite a passed immutable owner-development qualification gate: ${paths.status}`,
    );
  }
}
const items = read(paths.items);
const sources = read(paths.sources);
const allocation = read(paths.allocation);
const contamination = read(paths.contamination);
const provenance = read(paths.provenance);
const compactMap = read(paths.compactMap);
const topicCoverage = read(paths.topicCoverage);
const wave2RetentionAudit = read(paths.wave2RetentionAudit);
const wave3RetentionAudit = read(paths.wave3RetentionAudit);
const independentVisibleAudit = read(paths.independentVisibleAudit);
const independentFinalAudit = read(paths.independentFinalAudit);
const custodianAttestation = read(paths.custodianAttestation);
const candidateManifest = read(paths.candidateManifest);
const candidateTokens = read(paths.candidateTokens);
const owner = read(paths.owner);
const approval = existsSync(paths.approval) ? read(paths.approval) : null;
const finalManifest = existsSync(paths.finalManifest) ? read(paths.finalManifest) : null;
const finalTokens = existsSync(paths.finalTokens) ? read(paths.finalTokens) : null;
const workspaceRelativePath = (path) =>
  relative(resolve("."), path).replaceAll("\\", "/");
const expectedCustodianCandidateMembers = [
  paths.items,
  paths.sources,
  paths.compactMap,
  paths.allocation,
  paths.contamination,
  paths.candidateManifest,
  paths.candidateTrain,
  paths.candidateValid,
  paths.finalTokens,
  paths.finalManifest,
  paths.finalTrain,
  paths.finalValid,
].map((path) => ({
  path: workspaceRelativePath(path),
  sha256: sha(path),
}));
const custodianCandidateMembers =
  custodianAttestation.hash_bindings?.candidate_binding_members || [];
const custodianProtectedFiles =
  custodianAttestation.hash_bindings?.protected_question_files || [];
const canonicalPathHash = (members) =>
  contentHash(
    JSON.stringify(
      members.map(({ path, sha256 }) => ({ path, sha256 })),
    ),
  );
const custodianAccess = custodianAttestation.access_and_isolation || {};
const custodianCounts = custodianAttestation.counts || {};
const custodianCollisions =
  custodianAttestation.aggregate_results?.collisions || {};
const custodianChecks = {
  exact_schema_role_scope_and_pass:
    custodianAttestation.schema_version ===
      "authorised-protected-set-custodian-attestation-v1" &&
    custodianAttestation.custodian_role ===
      "isolated_authorised_protected_set_custodian" &&
    custodianAttestation.scope ===
      "frozen_root24_94_record_visible_train_validation_allocation_against_protected_visible_regression_and_original_60_sealed_unseen_questions" &&
    custodianAttestation.status === "pass" &&
    custodianAttestation.passed === true &&
    custodianAttestation.clean === true &&
    custodianAttestation.no_collisions === true &&
    custodianAttestation.training_qualification_may_proceed === true,
  attestation_does_not_authorise_training_or_release:
    custodianAttestation.training_start_authorised_by_this_attestation ===
      false &&
    custodianAttestation.release_authorised_by_this_attestation === false,
  isolated_question_access_without_pipeline_exposure:
    custodianAccess.protected_question_access_for_this_comparison ===
      "isolated_custodian_only" &&
    custodianAccess.protected_questions_accessed_by_training_or_export_pipeline ===
      false &&
    custodianAccess.protected_questions_disclosed === false &&
    custodianAccess.protected_question_text_printed === false &&
    custodianAccess.protected_question_text_persisted === false &&
    custodianAccess.protected_question_text_quoted_or_summarised === false &&
    custodianAccess.protected_ids_or_pair_details_persisted === false &&
    custodianAccess.protected_content_exposed === false,
  sealed_gold_answers_never_opened_hashed_or_used:
    custodianAccess.sealed_gold_answer_files_opened === false &&
    custodianAccess.sealed_gold_answer_files_hashed === false &&
    custodianAccess.sealed_gold_answers_accessed === false &&
    custodianAccess.gold_answer_content_used === false &&
    custodianAttestation.hash_bindings
      ?.sealed_gold_answer_files_excluded_from_hashing_and_access === true,
  no_model_adapter_or_training_activity:
    custodianAccess.model_inference_run === false &&
    custodianAccess.learned_embedding_inference_run === false &&
    custodianAccess.model_outputs_accessed === false &&
    custodianAccess.adapters_accessed === false &&
    custodianAccess.training_started === false,
  exact_candidate_and_protected_counts:
    custodianCounts.candidate_records === 94 &&
    custodianCounts.train_records === 76 &&
    custodianCounts.validation_records === 18 &&
    custodianCounts.protected_visible_regression_questions === 69 &&
    custodianCounts.protected_sealed_unseen_questions === 60 &&
    custodianCounts.protected_questions_total === 129 &&
    custodianCounts.primary_question_pairs === 94 * 129 &&
    custodianCounts.candidate_questions_missing_from_rendered_user_prompt === 0,
  exact_frozen_candidate_member_bindings:
    JSON.stringify(custodianCandidateMembers) ===
      JSON.stringify(expectedCustodianCandidateMembers) &&
    custodianAttestation.hash_bindings?.candidate_binding_sha256 ===
      canonicalPathHash(expectedCustodianCandidateMembers),
  protected_binding_is_aggregate_and_self_consistent_without_reopening_files:
    custodianProtectedFiles.length === 7 &&
    custodianProtectedFiles.reduce(
      (count, entry) => count + Number(entry.question_count || 0),
      0,
    ) === 129 &&
    custodianProtectedFiles.every(
      (entry) =>
        typeof entry.path === "string" &&
        /^[a-f0-9]{64}$/.test(entry.sha256 || "") &&
        Number.isInteger(entry.question_count) &&
        entry.question_count > 0,
    ) &&
    custodianAttestation.hash_bindings?.protected_binding_sha256 ===
      canonicalPathHash(custodianProtectedFiles),
  all_cross_bindings_passed:
    custodianAttestation.hash_bindings?.cross_binding_checks?.checks_run ===
      19 &&
    custodianAttestation.hash_bindings?.cross_binding_checks?.checks_passed ===
      19 &&
    custodianAttestation.hash_bindings?.cross_binding_checks?.checks_failed ===
      0 &&
    custodianAttestation.hash_bindings?.cross_binding_checks
      ?.item_source_map_allocation_contamination_candidate_manifest_review_partitions_final_dataset_and_final_token_preflight_consistent ===
      true &&
    custodianAttestation.hash_bindings?.additional_supporting_hashes
      ?.token_and_loss_mask_preflight_sha256 === sha(paths.candidateTokens) &&
    custodianAttestation.hash_bindings?.additional_supporting_hashes
      ?.global_visible_topic_coverage_feasibility_sha256 ===
      sha(paths.topicCoverage),
  zero_collisions_and_complete_surface_scan:
    Object.keys(custodianCollisions).length > 0 &&
    Object.values(custodianCollisions).every((count) => count === 0) &&
    custodianAttestation.aggregate_results?.review_rows_scanned === 94 &&
    custodianAttestation.aggregate_results?.final_rows_scanned === 94,
  projection_alerts_adjudicated_without_substantive_collision:
    custodianAttestation.projection_alert_adjudication
      ?.classified_as_substantive_collisions === 0 &&
    custodianAttestation.projection_alert_adjudication?.classification ===
      "non_substantive_topic_family_projection_only" &&
    custodianAttestation.projection_alert_adjudication?.aggregate_basis
      ?.answer_controlling_construct_collisions === 0 &&
    custodianAttestation.projection_alert_adjudication?.aggregate_basis
      ?.projection_alerts_surviving_all_tested_scenario_projections === 0,
  qualification_fields_pass_without_expanding_scope:
    custodianAttestation.qualification
      ?.protected_visible_regression_contamination_gate === "passed" &&
    custodianAttestation.qualification
      ?.sealed_unseen_question_contamination_gate === "passed" &&
    custodianAttestation.qualification?.frozen_hash_binding_gate === "passed" &&
    custodianAttestation.qualification?.training_qualification_may_proceed ===
      true &&
    custodianAttestation.qualification?.training_or_release_authority_granted ===
      false &&
    custodianAttestation.qualification?.remaining_non_custodian_gates_unchanged ===
      true,
};

const mappingKey = (entry) => `${entry.training_id}\u0000${entry.proposition}`;
const retentionDecisionFor = (supportRelationship) =>
  `retained_complete_${supportRelationship}_for_owner_authorised_development`;
const validateRetentionAudit = (audit, wave, expectedCount) => {
  const expectedMappings = compactMap.proposition_mappings.filter((entry) =>
    entry.training_id.includes(`-${wave}-`),
  );
  const expectedByKey = new Map(
    expectedMappings.map((entry) => [mappingKey(entry), entry]),
  );
  const decisions = audit.decisions || [];
  const seen = new Set();
  const decisionsMatch =
    decisions.length === expectedCount &&
    decisions.every((decision) => {
      const key = mappingKey(decision);
      const expected = expectedByKey.get(key);
      if (!expected || seen.has(key)) return false;
      seen.add(key);
      return (
        decision.support_relationship === expected.support_relationship &&
        decision.decision ===
          retentionDecisionFor(expected.support_relationship) &&
        decision.passed === true &&
        JSON.stringify([...(decision.excerpt_ids || [])].sort()) ===
          JSON.stringify([...(expected.excerpt_ids || [])].sort())
      );
    });
  return (
    expectedMappings.length === expectedCount &&
    audit.status ===
      "passed_owner_authorised_developer_substantive_retention_audit" &&
    audit.passed === true &&
    audit.training_authorised === false &&
    audit.release_authorised === false &&
    audit.independent_legal_review === false &&
    audit.unseen_accessed === false &&
    audit.bindings?.item_register_sha256 === sha(paths.items) &&
    audit.bindings?.full_source_register_sha256 === sha(paths.sources) &&
    audit.bindings?.compact_evidence_map_sha256 === sha(paths.compactMap) &&
    audit.counts?.expected_mappings === expectedCount &&
    audit.counts?.reviewed_mappings === expectedCount &&
    audit.counts?.retained_complete === expectedCount &&
    audit.counts?.unresolved === 0 &&
    decisionsMatch &&
    seen.size === expectedCount
  );
};

const mechanicalChecks = {
  exact_94_visible_records:
    items.counts?.total === 94 &&
    items.counts?.v1 === 42 &&
    items.counts?.wave_2 === 33 &&
    items.counts?.wave_3 === 19 &&
    items.items?.length === 94,
  source_register_bound:
    sources.item_register_sha256 === sha(paths.items) &&
    sources.identity_conflicts?.length === 0,
  compact_renderer_provenance_bound:
    items.upstream_bindings?.compact_renderer_sha256 ===
      sha(paths.compactRenderer) &&
    compactMap.compact_renderer?.sha256 === sha(paths.compactRenderer) &&
    allocation.compact_renderer_sha256 === sha(paths.compactRenderer) &&
    contamination.compact_renderer_sha256 === sha(paths.compactRenderer) &&
    candidateManifest.compact_renderer_sha256 === sha(paths.compactRenderer) &&
    provenance.compact_renderer?.sha256 === sha(paths.compactRenderer) &&
    owner.bindings?.compact_renderer_sha256 === sha(paths.compactRenderer),
  compact_map_bound_and_complete:
    compactMap.item_register_sha256 === sha(paths.items) &&
    compactMap.full_source_register_sha256 === sha(paths.sources) &&
    compactMap.passed === true &&
    compactMap.counts?.mapped_propositions === 195 &&
    compactMap.counts?.unmappable_propositions === 0,
  validation_topic_coverage_gap_proved_unavoidable:
    topicCoverage.passed === true &&
    topicCoverage.training_authorised === false &&
    topicCoverage.release_authorised === false &&
    topicCoverage.independent_legal_review === false &&
    topicCoverage.unseen_accessed === false &&
    items.upstream_bindings?.topic_coverage_feasibility_sha256 ===
      sha(paths.topicCoverage) &&
    allocation.topic_coverage_feasibility_sha256 === sha(paths.topicCoverage) &&
    compactMap.topic_coverage_feasibility_sha256 === sha(paths.topicCoverage) &&
    topicCoverage.exhaustive_dynamic_programming_result
      ?.maximum_validation_topic_count === allocation.topic_coverage?.count &&
    topicCoverage.exhaustive_dynamic_programming_result
      ?.all_11_topics_feasible === false &&
    topicCoverage.avoidable_selected_split_gaps?.length === 0 &&
    topicCoverage.unavoidably_absent_topics?.every(
      (entry) => entry.feasible_state_count_with_topic === 0,
    ) === true,
  complete_wave_2_substantive_retention_audit:
    validateRetentionAudit(wave2RetentionAudit, "w2", 127),
  complete_wave_3_substantive_retention_audit:
    validateRetentionAudit(wave3RetentionAudit, "w3", 68),
  independent_visible_52_item_195_mapping_development_review_bound:
    independentVisibleAudit.status ===
      "approved_for_controlled_local_development_training_only" &&
    independentVisibleAudit.passed === true &&
    independentVisibleAudit.training_authorised === true &&
    independentVisibleAudit.release_authorised === false &&
    independentVisibleAudit.counts?.visible_items_reviewed === 52 &&
    independentVisibleAudit.counts?.proposition_source_mappings_reviewed ===
      195 &&
    independentVisibleAudit.counts?.passed_items === 52 &&
    independentVisibleAudit.counts?.passed_mappings === 195 &&
    independentVisibleAudit.counts?.substantive_defects === 0 &&
    independentVisibleAudit.counts?.citation_span_defects === 0 &&
    independentVisibleAudit.counts?.unresolved_conflicts === 0 &&
    compactMap.independent_visible_development_review?.audit_sha256 ===
      sha(paths.independentVisibleAudit) &&
    compactMap.independent_visible_development_review?.report_sha256 ===
      sha(paths.independentVisibleReport) &&
    candidateManifest.independent_visible_development_audit_sha256 ===
      sha(paths.independentVisibleAudit) &&
    owner.bindings?.independent_visible_development_audit_sha256 ===
      sha(paths.independentVisibleAudit),
  allocation_bound:
    allocation.item_register_sha256 === sha(paths.items) &&
    allocation.source_register_sha256 === sha(paths.sources) &&
    allocation.train?.count + allocation.validation?.count === 94 &&
    allocation.validation?.count >= 14 &&
    allocation.validation?.count <= 18 &&
    allocation.isolation?.passed === true &&
    allocation.isolation?.canonical_url_overlap?.length === 0 &&
    allocation.compact_partition_isolation?.passed === true &&
    Object.values(
      allocation.compact_partition_isolation?.overlap || {},
    ).every((values) => Array.isArray(values) && values.length === 0),
  contamination_bound_and_passed:
    contamination.item_register_sha256 === sha(paths.items) &&
    contamination.allocation_sha256 === sha(paths.allocation) &&
    contamination.passed === true,
  candidate_render_bound:
    candidateManifest.item_register_sha256 === sha(paths.items) &&
    candidateManifest.allocation_sha256 === sha(paths.allocation) &&
    candidateManifest.training_authorised === false &&
    candidateManifest.final_mlx_filenames_present === false,
  candidate_token_preflight_bound:
    candidateTokens.partitions?.every((partition) => partition.manifest_match) === true &&
    candidateTokens.runtime_contract?.preflight_script_sha256 ===
      sha(paths.tokenPreflight) &&
    candidateTokens.training_authorised === false,
  checkpoint_provenance_passed:
    provenance.passed === true &&
    provenance.training_started === false &&
    provenance.clean_start_policy?.resume_adapter === null &&
    provenance.clean_start_policy?.historical_v1_wave2_wave3_adapters_used === false,
  protected_set_custodian_attestation_exact_clean_and_bound:
    Object.values(custodianChecks).every(Boolean),
  unseen_not_accessed:
    items.unseen_accessed === false &&
    allocation.unseen_accessed === false &&
    contamination.unseen_accessed === false &&
    candidateTokens.unseen_accessed === false &&
    owner.unseen_accessed === false &&
    wave2RetentionAudit.unseen_accessed === false &&
    wave3RetentionAudit.unseen_accessed === false &&
    custodianAccess.sealed_gold_answers_accessed === false &&
    custodianAccess.protected_content_exposed === false,
};

const ownerDevelopmentChecks = {
  owner_authorisation_recorded:
    owner.owner_authorisation_recorded === true &&
    owner.conditionally_authorised_after_all_mechanical_gates === true,
  owner_scope_is_development_only:
    owner.scope === "controlled_development_training_and_visible_qualification_only" &&
    owner.independent_legal_review === false &&
    owner.independent_citation_support_review === false &&
    owner.release_authorised === false &&
    owner.sealed_unseen_execution_authorised_now === false,
  owner_bindings:
    owner.bindings?.item_register_sha256 === sha(paths.items) &&
    owner.bindings?.source_register_sha256 === sha(paths.sources) &&
    owner.bindings?.global_allocation_sha256 === sha(paths.allocation) &&
    owner.bindings?.contamination_preflight_sha256 === sha(paths.contamination) &&
    owner.bindings?.rendered_candidate_manifest_sha256 === sha(paths.candidateManifest) &&
    owner.bindings?.clean_checkpoint_provenance_sha256 === sha(paths.provenance),
};

const requiredDecisions = [
  "all_52_repaired_items_independently_approved",
  "every_compact_excerpt_preserves_material_conditions",
  "every_material_proposition_support_determined",
  "exact_citation_ids_inserted_and_approved",
  "global_94_record_semantic_construct_map_approved",
  "global_94_record_allocation_approved",
  "cumulative_visible_rendered_export_approved",
  "token_length_and_loss_mask_preflight_passed",
  "clean_base_checkpoint_provenance_approved",
  "protected_set_custodian_comparison_passed",
];
const expectedIndependentFinalChecks = [
  "aggregate_protected_set_custodian_gate_passed",
  "all_146_full_source_text_hashes_match",
  "all_195_proposition_mappings_match_item_local_maps",
  "all_256_excerpt_parent_hashes_offsets_text_and_excerpt_hashes_match",
  "all_52_repaired_items_have_complete_excerpt_sets",
  "all_94_completion_targets_are_exact_json",
  "all_94_completion_targets_fully_retained",
  "all_94_inline_marker_arrays_are_unique_ordered_exact_and_in_evidence",
  "all_94_prompt_loss_mask_boundaries_exact",
  "all_bound_input_hashes_match",
  "answer_input_echo_count_zero",
  "candidate_and_final_messages_identical",
  "candidate_and_final_partition_row_order_exact",
  "canonical_nested_wave_3_retention_audit_exactly_matches_68_mappings",
  "checkpoint_policy_228_iterations_and_26_step_eval_save_cadence_verified",
  "citation_markers_absent_from_prompts_and_evidence",
  "clean_original_base_revision_and_no_resume_adapter_verified",
  "compact_parent_source_excerpt_text_authority_and_construct_isolation",
  "config_runner_wrapper_selector_renderer_exporter_and_smoke_hashes_match",
  "exact_94_unique_visible_records",
  "exact_ordered_76_train_18_validation_partition",
  "final_mlx_preflight_semantically_matches_frozen_report",
  "final_mlx_token_loss_preflight_independently_reproduced",
  "full_source_construct_text_authority_and_url_isolation",
  "no_unmappable_propositions",
  "no_weak_compact_excerpts",
  "owner_scope_is_controlled_local_development_only",
  "pre_full_training_longest_row_memory_smoke_is_mandatory",
  "protected_content_not_accessed_by_this_reviewer",
  "release_remains_unauthorised",
  "root22_independent_52_item_195_mapping_technical_legal_semantic_review_bound",
  "validation_cohort_counts_8_5_5",
  "validation_topic_coverage_is_provable_maximum_8_of_11",
  "wave_2_retention_audit_exactly_matches_127_mappings",
  "zero_over_limit_rows",
  "zero_zero_loss_rows",
];
const independentFinalBindings = independentFinalAudit.bindings || {};
const independentFinalCounts = independentFinalAudit.counts || {};
const independentFinalScope = independentFinalAudit.scope || {};
const independentFinalToken = independentFinalAudit.token_and_loss_mask || {};
const independentFinalProvenance = independentFinalAudit.provenance || {};
const independentFinalDecision = independentFinalAudit.decision || {};
const approvalChecks = {
  approval_present: Boolean(approval),
  approval_status:
    Object.keys(approval || {}).length === 13 &&
    approval?.version ===
      "cumulative-visible-compact-independent-qualification-approval-v1" &&
    Number.isFinite(Date.parse(approval?.generated_at || "")) &&
    approval?.status === "approved_for_clean_cumulative_visible_training" &&
    approval?.training_authorised === true &&
    approval?.release_authorised === false &&
    approval?.unseen_accessed === false,
  independent_reviewer_recorded:
    typeof approval?.independent_reviewer === "string" &&
    approval.independent_reviewer.trim().length >= 8 &&
    Number.isFinite(Date.parse(approval?.approved_at || "")),
  controlled_scope_and_execution_conditions:
    approval?.qualification_scope ===
      "controlled_local_development_training_only" &&
    approval?.execution_conditions?.exact_hash_bound_final_dataset_only ===
      true &&
    approval?.execution_conditions?.clean_start_no_resume_adapter === true &&
    approval?.execution_conditions
      ?.pre_full_training_longest_row_memory_smoke_must_pass === true &&
    approval?.execution_conditions?.release_authorised === false &&
    approval?.execution_conditions?.sealed_unseen_execution_authorised ===
      false &&
    typeof approval?.protected_set_gate_interpretation === "string" &&
    approval.protected_set_gate_interpretation.length >= 80,
  visible_bindings:
    approval?.bindings?.item_register_sha256 === sha(paths.items) &&
    approval?.bindings?.source_register_sha256 === sha(paths.sources) &&
    approval?.bindings?.global_allocation_sha256 === sha(paths.allocation) &&
    approval?.bindings?.contamination_preflight_sha256 === sha(paths.contamination) &&
    approval?.bindings?.clean_checkpoint_provenance_sha256 === sha(paths.provenance),
  all_required_decisions: requiredDecisions.every(
    (decision) => approval?.required_decisions?.[decision] === true,
  ) && Object.keys(approval?.required_decisions || {}).length === 12,
  approved_repaired_items_bound:
    approval?.required_decisions?.approved_repaired_items_sha256 ===
      sha(paths.approvedRepairedItems),
  custodian_attestation_bound:
    approval?.required_decisions?.authorised_custodian_attestation_sha256 ===
      sha(paths.custodianAttestation),
  independent_final_review_files_bound:
    approval?.bindings?.independent_final_qualification_audit_sha256 ===
      sha(paths.independentFinalAudit) &&
    approval?.bindings?.independent_final_qualification_report_sha256 ===
      sha(paths.independentFinalReport) &&
    approval?.bindings?.independent_visible_verifier_sha256 ===
      sha(paths.independentVisibleVerifier),
  complete_approval_artifact_bindings:
    Object.keys(approval?.bindings || {}).length === 22 &&
    approval?.bindings?.rendered_candidate_manifest_sha256 ===
      sha(paths.candidateManifest) &&
    approval?.bindings?.compact_evidence_map_sha256 ===
      sha(paths.compactMap) &&
    approval?.bindings?.checkpoint_selection_policy_sha256 ===
      sha(paths.checkpointPolicy) &&
    approval?.bindings?.compact_renderer_sha256 ===
      sha(paths.compactRenderer) &&
    approval?.bindings?.independent_visible_development_audit_sha256 ===
      sha(paths.independentVisibleAudit) &&
    approval?.bindings?.independent_visible_development_report_sha256 ===
      sha(paths.independentVisibleReport) &&
    approval?.bindings?.wave_2_substantive_retention_audit_sha256 ===
      sha(paths.wave2RetentionAudit) &&
    approval?.bindings?.wave_3_substantive_retention_audit_sha256 ===
      sha(paths.wave3RetentionAudit) &&
    approval?.bindings?.token_and_loss_mask_preflight_sha256 ===
      sha(paths.finalTokens) &&
    approval?.bindings?.final_dataset_manifest_sha256 ===
      sha(paths.finalManifest) &&
    approval?.bindings?.final_train_jsonl_sha256 === sha(paths.finalTrain) &&
    approval?.bindings?.final_validation_jsonl_sha256 ===
      sha(paths.finalValid) &&
    approval?.bindings?.owner_development_authorisation_sha256 ===
      sha(paths.owner) &&
    approval?.bindings?.authorised_custodian_attestation_sha256 ===
      sha(paths.custodianAttestation),
  independent_final_review_passed_and_bound:
    Object.keys(independentFinalAudit).length === 18 &&
    independentFinalAudit.version ===
      "independent-agent-final-cumulative-visible-qualification-audit-v1" &&
    Number.isFinite(Date.parse(independentFinalAudit.generated_at || "")) &&
    independentFinalAudit.status ===
      "approved_for_controlled_local_development_training_only" &&
    independentFinalAudit.passed === true &&
    independentFinalAudit.training_authorised === true &&
    independentFinalAudit.release_authorised === false &&
    independentFinalAudit.unseen_accessed === false &&
    independentFinalAudit.independent_reviewer?.role ===
      "isolated independent-agent technical/legal/semantic reviewer" &&
    independentFinalAudit.independent_reviewer
      ?.not_involved_in_authoring_training_span_repair_or_model_outputs ===
      true &&
    independentFinalAudit.independent_reviewer?.licensed_legal_advice ===
      false &&
    independentFinalBindings.qualification_gate_script_reviewed_sha256 ===
      sha(paths.qualifier) &&
    independentFinalBindings.authorised_protected_set_custodian_attestation_sha256 ===
      sha(paths.custodianAttestation) &&
    independentFinalBindings.final_dataset_manifest_sha256 ===
      sha(paths.finalManifest) &&
    independentFinalBindings.final_train_jsonl_sha256 ===
      sha(paths.finalTrain) &&
    independentFinalBindings.final_validation_jsonl_sha256 ===
      sha(paths.finalValid) &&
    independentFinalBindings.final_token_preflight_sha256 ===
      sha(paths.finalTokens) &&
    independentFinalBindings.independent_visible_verifier_sha256 ===
      sha(paths.independentVisibleVerifier),
  independent_final_review_complete_bindings:
    Object.keys(independentFinalBindings).length === 27 &&
    independentFinalBindings.item_register_sha256 === sha(paths.items) &&
    independentFinalBindings.full_source_register_sha256 ===
      sha(paths.sources) &&
    independentFinalBindings.compact_evidence_map_sha256 ===
      sha(paths.compactMap) &&
    independentFinalBindings.global_allocation_sha256 ===
      sha(paths.allocation) &&
    independentFinalBindings.contamination_preflight_sha256 ===
      sha(paths.contamination) &&
    independentFinalBindings.rendered_candidate_manifest_sha256 ===
      sha(paths.candidateManifest) &&
    independentFinalBindings.candidate_token_preflight_sha256 ===
      sha(paths.candidateTokens) &&
    independentFinalBindings.clean_checkpoint_provenance_sha256 ===
      sha(paths.provenance) &&
    independentFinalBindings.checkpoint_selection_policy_sha256 ===
      sha(paths.checkpointPolicy) &&
    independentFinalBindings.topic_coverage_feasibility_sha256 ===
      sha(paths.topicCoverage) &&
    independentFinalBindings.wave_2_substantive_retention_audit_sha256 ===
      sha(paths.wave2RetentionAudit) &&
    independentFinalBindings
      .canonical_nested_wave_3_substantive_retention_audit_sha256 ===
      sha(paths.wave3RetentionAudit) &&
    independentFinalBindings.root22_independent_visible_audit_sha256 ===
      sha(paths.independentVisibleAudit) &&
    independentFinalBindings.root22_independent_visible_report_sha256 ===
      sha(paths.independentVisibleReport) &&
    independentFinalBindings.root22_repaired_training_pack_sha256 ===
      sha(paths.approvedRepairedItems) &&
    independentFinalBindings.root22_repair_application_audit_sha256 ===
      sha(paths.root22RepairApplicationAudit) &&
    independentFinalBindings.owner_development_authorisation_sha256 ===
      sha(paths.owner) &&
    independentFinalBindings.dataset_exporter_sha256 === sha(paths.exporter) &&
    independentFinalBindings.compact_renderer_sha256 ===
      sha(paths.compactRenderer) &&
    independentFinalBindings.token_preflight_script_sha256 ===
      sha(paths.tokenPreflight),
  independent_final_review_scope_counts_and_checks:
    Object.keys(independentFinalScope).length === 7 &&
    Object.keys(independentFinalCounts).length === 18 &&
    resolve(independentFinalScope.reviewed_root || "") === ROOT &&
    resolve(independentFinalScope.final_dataset_root || "") === DATASET_ROOT &&
    independentFinalScope.visible_records_only === true &&
    independentFinalScope.protected_content_accessed_by_this_reviewer ===
      false &&
    independentFinalScope.protected_gate_basis ===
      "content-free aggregate custodian attestation only" &&
    independentFinalScope.model_outputs_or_adapters_accessed === false &&
    independentFinalScope.training_execution_performed === false &&
    independentFinalCounts.visible_records === 94 &&
    independentFinalCounts.v1_records === 42 &&
    independentFinalCounts.wave_2_records === 33 &&
    independentFinalCounts.wave_3_records === 19 &&
    independentFinalCounts.train_records === 76 &&
    independentFinalCounts.validation_records === 18 &&
    independentFinalCounts.validation_v1_records === 8 &&
    independentFinalCounts.validation_wave_2_records === 5 &&
    independentFinalCounts.validation_wave_3_records === 5 &&
    independentFinalCounts.full_sources === 146 &&
    independentFinalCounts.repaired_items === 52 &&
    independentFinalCounts.mapped_propositions === 195 &&
    independentFinalCounts.verbatim_excerpts === 256 &&
    independentFinalCounts.wave_2_retention_decisions === 127 &&
    independentFinalCounts.wave_3_retention_decisions === 68 &&
    independentFinalCounts.substantive_defects === 0 &&
    independentFinalCounts.citation_span_defects === 0 &&
    independentFinalCounts.unresolved_conflicts === 0 &&
    expectedIndependentFinalChecks.every(
      (check) => independentFinalAudit.checks?.[check] === true,
    ) &&
    Object.keys(independentFinalAudit.checks || {}).length ===
      expectedIndependentFinalChecks.length &&
    Array.isArray(independentFinalAudit.defects) &&
    independentFinalAudit.defects.length === 0 &&
    Array.isArray(independentFinalAudit.limitations) &&
    independentFinalAudit.limitations.length === 5,
  independent_final_review_token_provenance_and_decision:
    Object.keys(independentFinalToken).length === 13 &&
    Object.keys(independentFinalProvenance).length === 12 &&
    Object.keys(independentFinalDecision).length === 5 &&
    independentFinalToken.implementation ===
      "mlx_lm.tuner.datasets.ChatDataset.process" &&
    independentFinalToken.mask_prompt === true &&
    independentFinalToken.max_sequence_length === 2112 &&
    independentFinalToken.minimum_tokens === 147 &&
    independentFinalToken.median_tokens === 459 &&
    independentFinalToken.p95_tokens === 1750 &&
    independentFinalToken.maximum_tokens === 2066 &&
    independentFinalToken.prompt_maximum_tokens === 1865 &&
    independentFinalToken.supervised_maximum_tokens === 328 &&
    independentFinalToken.failed_rows === 0 &&
    independentFinalToken.over_limit_rows === 0 &&
    independentFinalToken.zero_effective_loss_rows === 0 &&
    typeof independentFinalToken.independent_rerun_method === "string" &&
    independentFinalToken.independent_rerun_method.length >= 120 &&
    independentFinalProvenance.resume_adapter === null &&
    independentFinalProvenance.base_repository ===
      "mlx-community/Qwen3-8B-4bit" &&
    independentFinalProvenance.base_revision ===
      "545dc4251c05440727734bcd94334791f6ab0192" &&
    independentFinalProvenance.historical_adapters_used === false &&
    independentFinalProvenance.training_started === false &&
    independentFinalProvenance.max_sequence_length === 2112 &&
    independentFinalProvenance.mask_prompt === true &&
    independentFinalProvenance.iterations === 228 &&
    independentFinalProvenance.steps_per_eval === 26 &&
    independentFinalProvenance.save_every === 26 &&
    independentFinalProvenance.checkpoint_selection ===
      "lowest validation loss among persisted validation-interval checkpoints; exact ties prefer the earlier iteration" &&
    independentFinalProvenance.pre_full_training_gate ===
      "one quarantined longest-train/longest-validation-row memory smoke must pass before the full controlled local run" &&
    independentFinalDecision.qualification ===
      "approved_for_clean_cumulative_visible_training" &&
    independentFinalDecision.authorised_scope ===
      "controlled local development training only" &&
    independentFinalDecision.release === false &&
    independentFinalDecision.unseen_execution === false &&
    independentFinalDecision.safe_handoff ===
      "Use only the exact hash-bound final dataset and clean-start runner. Run and pass the bound longest-row memory smoke before full training. Any bound-file change invalidates this approval.",
  independent_final_review_protected_gate:
    Object.keys(independentFinalAudit.protected_set_gate || {}).length === 10 &&
    independentFinalAudit.protected_set_gate?.attestation_path ===
      workspaceRelativePath(paths.custodianAttestation) &&
    independentFinalAudit.protected_set_gate?.attestation_sha256 ===
      sha(paths.custodianAttestation) &&
    independentFinalAudit.protected_set_gate?.custodian_status === "pass" &&
    independentFinalAudit.protected_set_gate?.candidate_records === 94 &&
    independentFinalAudit.protected_set_gate?.protected_questions === 129 &&
    independentFinalAudit.protected_set_gate?.primary_question_pairs === 12126 &&
    independentFinalAudit.protected_set_gate?.substantive_collisions === 0 &&
    independentFinalAudit.protected_set_gate
      ?.reviewer_accessed_protected_content === false &&
    typeof independentFinalAudit.protected_set_gate?.reviewer_basis ===
      "string" &&
    independentFinalAudit.protected_set_gate.reviewer_basis.length >= 120 &&
    typeof independentFinalAudit.protected_set_gate
      ?.legacy_qualification_field_interpretation === "string" &&
    independentFinalAudit.protected_set_gate
      .legacy_qualification_field_interpretation.length >= 120,
};

const finalDatasetChecks = {
  final_manifest_present: Boolean(finalManifest),
  final_manifest_shape:
    finalManifest?.status === "final_hash_bound_qualification_candidate" &&
    finalManifest?.training_authorised === false &&
    finalManifest?.owner_authorised_development === true &&
    finalManifest?.independent_legal_review === false &&
    finalManifest?.total_count === 94 &&
    finalManifest?.train?.count + finalManifest?.validation?.count === 94 &&
    finalManifest?.validation?.count >= 14 &&
    finalManifest?.validation?.count <= 18 &&
    finalManifest?.compact_evidence_map_sha256 === sha(paths.compactMap) &&
    finalManifest?.dataset_exporter_sha256 === sha(paths.exporter) &&
    finalManifest?.token_preflight_script_sha256 === sha(paths.tokenPreflight) &&
    finalManifest?.wave_2_substantive_retention_audit_sha256 ===
      sha(paths.wave2RetentionAudit) &&
    finalManifest?.wave_3_substantive_retention_audit_sha256 ===
      sha(paths.wave3RetentionAudit) &&
    finalManifest?.independent_visible_development_audit_sha256 ===
      sha(paths.independentVisibleAudit) &&
    finalManifest?.independent_visible_development_report_sha256 ===
      sha(paths.independentVisibleReport),
  final_files_present:
    existsSync(resolve(DATASET_ROOT, "train.jsonl")) &&
    existsSync(resolve(DATASET_ROOT, "valid.jsonl")),
  final_file_hashes:
    Boolean(finalManifest) &&
    existsSync(resolve(DATASET_ROOT, "train.jsonl")) &&
    existsSync(resolve(DATASET_ROOT, "valid.jsonl")) &&
    finalManifest.train?.sha256 === sha(resolve(DATASET_ROOT, "train.jsonl")) &&
    finalManifest.validation?.sha256 === sha(resolve(DATASET_ROOT, "valid.jsonl")),
  final_token_preflight_present: Boolean(finalTokens),
  final_token_preflight_passed:
    finalTokens?.passed === true &&
    finalTokens?.scope === "final_hash_bound_dataset" &&
    finalTokens?.runtime_contract?.preflight_script_sha256 ===
      sha(paths.tokenPreflight) &&
    finalTokens?.training_authorised === false,
  approval_binds_final_artifacts:
    Boolean(finalManifest && finalTokens) &&
    finalManifest.owner_development_authorisation_sha256 === sha(paths.owner),
};

const blockers = [];
if (!candidateTokens.passed) {
  blockers.push({
    code: "candidate_token_or_loss_mask_preflight_failed",
    detail: `${candidateTokens.counts?.over_limit_rows || 0} rows exceed ${candidateTokens.runtime_contract?.max_sequence_length} tokens; ${candidateTokens.counts?.zero_effective_loss_rows || 0} rows lose all supervised tokens.`,
    affected_ids: candidateTokens.failed_ids || [],
  });
}
for (const [check, passed] of Object.entries(ownerDevelopmentChecks)) {
  if (!passed) blockers.push({ code: `owner_development_${check}_failed` });
}
for (const [check, passed] of Object.entries(finalDatasetChecks)) {
  if (!passed) blockers.push({ code: `final_dataset_${check}_failed` });
}
for (const [check, passed] of Object.entries(mechanicalChecks)) {
  if (!passed) blockers.push({ code: `mechanical_${check}_failed` });
}
for (const [check, passed] of Object.entries(approvalChecks)) {
  if (!passed) blockers.push({ code: `independent_approval_${check}_failed` });
}

const passed =
  Object.values(mechanicalChecks).every(Boolean) &&
  candidateTokens.passed === true &&
  Object.values(ownerDevelopmentChecks).every(Boolean) &&
  Object.values(finalDatasetChecks).every(Boolean) &&
  Object.values(approvalChecks).every(Boolean);
const report = {
  version: "cumulative-visible-qualification-gate-v1",
  generated_at: new Date().toISOString(),
  status: passed
    ? "approved_for_owner_authorised_clean_cumulative_development_training"
    : "blocked_training_not_authorised",
  passed,
  training_authorised: passed,
  release_authorised: false,
  training_started: false,
  unseen_included: false,
  unseen_accessed: false,
  counts: {
    total: 94,
    v1: 42,
    wave_2: 33,
    wave_3: 19,
    train: allocation.train?.count,
    validation: allocation.validation?.count,
  },
  hashes: {
    item_register: sha(paths.items),
    source_register: sha(paths.sources),
    global_allocation: sha(paths.allocation),
    contamination_preflight: sha(paths.contamination),
    checkpoint_provenance: sha(paths.provenance),
    compact_evidence_map: sha(paths.compactMap),
    compact_renderer: sha(paths.compactRenderer),
    token_preflight_script: sha(paths.tokenPreflight),
    dataset_exporter: sha(paths.exporter),
    qualification_gate_script: sha(paths.qualifier),
    topic_coverage_feasibility: sha(paths.topicCoverage),
    wave_2_substantive_retention_audit: sha(paths.wave2RetentionAudit),
    wave_3_substantive_retention_audit: sha(paths.wave3RetentionAudit),
    independent_visible_development_audit: sha(paths.independentVisibleAudit),
    independent_visible_development_report: sha(paths.independentVisibleReport),
    independent_final_qualification_audit: sha(paths.independentFinalAudit),
    independent_final_qualification_report: sha(paths.independentFinalReport),
    independent_visible_verifier: sha(paths.independentVisibleVerifier),
    authorised_protected_set_custodian_attestation: sha(
      paths.custodianAttestation,
    ),
    candidate_token_preflight: sha(paths.candidateTokens),
    final_dataset_manifest: existsSync(paths.finalManifest)
      ? sha(paths.finalManifest)
      : null,
    final_token_preflight: existsSync(paths.finalTokens) ? sha(paths.finalTokens) : null,
    independent_approval: existsSync(paths.approval) ? sha(paths.approval) : null,
  },
  mechanical_checks: mechanicalChecks,
  approval_checks: approvalChecks,
  custodian_attestation_checks: custodianChecks,
  owner_development_checks: ownerDevelopmentChecks,
  final_dataset_checks: finalDatasetChecks,
  release_evidence_pending: {
    independent_qualification_approval_present: approvalChecks.approval_present,
    independent_qualification_checks: approvalChecks,
    protected_set_custodian_comparison: Object.values(custodianChecks).every(
      Boolean,
    )
      ? "passed_hash_bound_aggregate_attestation_without_protected_content_exposure"
      : "failed_or_pending",
    independent_legal_and_citation_support_review: "pending",
    visible_evaluation: "pending",
    sealed_unseen_one_shot: "pending",
    release_decision: "pending",
  },
  blockers,
  next_safe_step: passed
    ? "Invoke the separate locked clean-start runner only with the explicit authorisation value."
    : "Resolve every blocker, regenerate any hash-dependent downstream artifact, and rerun this gate. Do not train or open sealed unseen material.",
};
writeFileSync(paths.status, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      passed,
      status: report.status,
      train: report.counts.train,
      validation: report.counts.validation,
      blockers: blockers.map((blocker) => blocker.code),
      training_authorised: report.training_authorised,
      unseen_accessed: false,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
