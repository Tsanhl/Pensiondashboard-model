import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { auditTrainingRows, contentHash } from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_QUALIFICATION_ROOT ||
    "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901",
);
const CANDIDATE_ROOT = resolve(ROOT, "rendered-candidate");
const OUTPUT_ROOT = resolve(
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
  owner: resolve(ROOT, "owner-development-authorisation.json"),
  candidateManifest: resolve(CANDIDATE_ROOT, "candidate-manifest.json"),
  candidateTokens: resolve(ROOT, "token-and-loss-mask-preflight.json"),
  candidateTrain: resolve(CANDIDATE_ROOT, "train.review.jsonl"),
  candidateValid: resolve(CANDIDATE_ROOT, "valid.review.jsonl"),
  compactRenderer: COMPACT_RENDERER_PATH,
  tokenPreflight: TOKEN_PREFLIGHT_PATH,
  exporter: EXPORTER_PATH,
};
for (const path of Object.values(paths)) {
  if (!existsSync(path)) throw new Error(`Final export prerequisite is missing: ${path}`);
}
const read = (path) => JSON.parse(readFileSync(path));
const sha = (path) => contentHash(readFileSync(path));
const parseJsonl = (path) =>
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(JSON.parse);
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
const owner = read(paths.owner);
const candidateManifest = read(paths.candidateManifest);
const candidateTokens = read(paths.candidateTokens);

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

const checks = {
  owner_development_authorisation_bound:
    owner.owner_authorisation_recorded === true &&
    owner.conditionally_authorised_after_all_mechanical_gates === true &&
    owner.independent_legal_review === false &&
    owner.release_authorised === false &&
    owner.bindings?.item_register_sha256 === sha(paths.items) &&
    owner.bindings?.source_register_sha256 === sha(paths.sources) &&
    owner.bindings?.global_allocation_sha256 === sha(paths.allocation) &&
    owner.bindings?.contamination_preflight_sha256 === sha(paths.contamination) &&
    owner.bindings?.rendered_candidate_manifest_sha256 === sha(paths.candidateManifest) &&
    owner.bindings?.clean_checkpoint_provenance_sha256 === sha(paths.provenance),
  exact_94_and_global_split:
    items.counts?.total === 94 &&
    allocation.train?.count + allocation.validation?.count === 94 &&
    allocation.validation?.count >= 14 &&
    allocation.validation?.count <= 18 &&
    allocation.isolation?.passed === true &&
    allocation.isolation?.canonical_url_overlap?.length === 0 &&
    allocation.compact_partition_isolation?.passed === true &&
    Object.values(
      allocation.compact_partition_isolation?.overlap || {},
    ).every((values) => Array.isArray(values) && values.length === 0),
  source_register_clean: sources.identity_conflicts?.length === 0,
  compact_renderer_provenance_bound:
    items.upstream_bindings?.compact_renderer_sha256 ===
      sha(paths.compactRenderer) &&
    compactMap.compact_renderer?.sha256 === sha(paths.compactRenderer) &&
    allocation.compact_renderer_sha256 === sha(paths.compactRenderer) &&
    contamination.compact_renderer_sha256 === sha(paths.compactRenderer) &&
    candidateManifest.compact_renderer_sha256 === sha(paths.compactRenderer) &&
    provenance.compact_renderer?.sha256 === sha(paths.compactRenderer) &&
    owner.bindings?.compact_renderer_sha256 === sha(paths.compactRenderer),
  compact_map_exact_and_complete:
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
  target_echo_and_json_contract_passed:
    contamination.passed === true &&
    contamination.answer_input_echo?.passed === true &&
    contamination.json_target_contract_checks?.every((item) => item.passed) === true,
  real_candidate_token_and_loss_mask_preflight_passed:
    candidateTokens.passed === true &&
    candidateTokens.runtime_contract?.preflight_script_sha256 ===
      sha(paths.tokenPreflight) &&
    candidateTokens.global_checks?.all_rows_fit_without_truncation === true &&
    candidateTokens.global_checks?.all_rows_retain_full_completion_target === true &&
    candidateTokens.global_checks?.no_row_loses_all_supervised_tokens === true,
  clean_base_provenance_passed:
    provenance.passed === true &&
    provenance.clean_start_policy?.resume_adapter === null &&
    provenance.clean_start_policy?.historical_v1_wave2_wave3_adapters_used === false,
  candidate_hashes_match:
    candidateManifest.train?.sha256 === sha(paths.candidateTrain) &&
    candidateManifest.validation?.sha256 === sha(paths.candidateValid),
  unseen_not_accessed:
    items.unseen_accessed === false &&
    allocation.unseen_accessed === false &&
    contamination.unseen_accessed === false &&
    candidateTokens.unseen_accessed === false &&
    owner.unseen_accessed === false &&
    wave2RetentionAudit.unseen_accessed === false &&
    wave3RetentionAudit.unseen_accessed === false,
};
if (!Object.values(checks).every(Boolean)) {
  throw new Error(`Final owner-authorised development export is blocked: ${JSON.stringify(checks)}`);
}
if (existsSync(OUTPUT_ROOT) && readdirSync(OUTPUT_ROOT).length) {
  throw new Error(`Preserve the existing dataset; versioned output is not empty: ${OUTPUT_ROOT}`);
}

const adaptRows = (rows) =>
  rows.map((row) => ({
    ...row,
    metadata: {
      ...row.metadata,
      review_only_candidate: false,
      owner_authorised_development: true,
      independent_legal_review: false,
      training_authorised: false,
    },
  }));
const trainRows = adaptRows(parseJsonl(paths.candidateTrain));
const validRows = adaptRows(parseJsonl(paths.candidateValid));
const renderedIds = [...trainRows, ...validRows].map(
  (row) => row.metadata.training_id,
);
if (
  renderedIds.length !== 94 ||
  new Set(renderedIds).size !== 94 ||
  !allocation.train.ids.every((id) =>
    trainRows.some((row) => row.metadata.training_id === id),
  ) ||
  !allocation.validation.ids.every((id) =>
    validRows.some((row) => row.metadata.training_id === id),
  )
) {
  throw new Error("Final rendered rows do not reproduce the approved 94-record allocation");
}
const echoAudit = auditTrainingRows([...trainRows, ...validRows]);
if (!echoAudit.passed) throw new Error("Completion answer appears in a final rendered input");

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const trainJsonl = jsonl(trainRows);
const validJsonl = jsonl(validRows);
mkdirSync(OUTPUT_ROOT, { recursive: true });
writeFileSync(resolve(OUTPUT_ROOT, "train.jsonl"), trainJsonl);
writeFileSync(resolve(OUTPUT_ROOT, "valid.jsonl"), validJsonl);
const manifest = {
  version: "cumulative-visible-owner-authorised-development-dataset-v1",
  generated_at: new Date().toISOString(),
  status: "final_hash_bound_qualification_candidate",
  training_authorised: false,
  release_authorised: false,
  independent_legal_review: false,
  owner_authorised_development: true,
  total_count: 94,
  item_register_sha256: sha(paths.items),
  source_register_sha256: sha(paths.sources),
  global_allocation_sha256: sha(paths.allocation),
  contamination_preflight_sha256: sha(paths.contamination),
  candidate_token_preflight_sha256: sha(paths.candidateTokens),
  clean_checkpoint_provenance_sha256: sha(paths.provenance),
  compact_evidence_map_sha256: sha(paths.compactMap),
  compact_renderer_sha256: sha(paths.compactRenderer),
  token_preflight_script_sha256: sha(paths.tokenPreflight),
  dataset_exporter_path: EXPORTER_PATH,
  dataset_exporter_sha256: sha(paths.exporter),
  topic_coverage_feasibility_sha256: sha(paths.topicCoverage),
  wave_2_substantive_retention_audit_sha256: sha(paths.wave2RetentionAudit),
  wave_3_substantive_retention_audit_sha256: sha(paths.wave3RetentionAudit),
  independent_visible_development_audit_sha256: sha(
    paths.independentVisibleAudit,
  ),
  independent_visible_development_report_sha256: sha(
    paths.independentVisibleReport,
  ),
  owner_development_authorisation_sha256: sha(paths.owner),
  completion_target_contract: {
    assistant_content: "JSON string",
    exact_keys: ["answer", "citation_ids"],
    answer:
      "string with live inline citation markers placed after supported propositions",
    citation_ids:
      "unique array exactly matching inline marker IDs and containing only supplied source_id values",
    prompt_and_evidence: "must not contain inline citation markers",
  },
  train: {
    count: trainRows.length,
    ids: trainRows.map((row) => row.metadata.training_id),
    sha256: contentHash(trainJsonl),
  },
  validation: {
    count: validRows.length,
    ids: validRows.map((row) => row.metadata.training_id),
    sha256: contentHash(validJsonl),
  },
  partition_isolation: {
    upstream_full_source: allocation.isolation,
    compact_render: allocation.compact_partition_isolation,
  },
  answer_input_echo_audit: echoAudit,
  protected_sets: {
    development_regression_used_as_training: false,
    sealed_unseen_used_as_training: false,
    sealed_unseen_accessed: false,
  },
  remaining_gate:
    "Run the real tokenizer/loss-mask preflight against these exact final files, then run the qualification gate. This manifest does not itself authorise training.",
};
writeFileSync(
  resolve(OUTPUT_ROOT, "dataset-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      output: OUTPUT_ROOT,
      total: 94,
      train: trainRows.length,
      validation: validRows.length,
      status: manifest.status,
      training_authorised: false,
      release_authorised: false,
      unseen_accessed: false,
    },
    null,
    2,
  ),
);
