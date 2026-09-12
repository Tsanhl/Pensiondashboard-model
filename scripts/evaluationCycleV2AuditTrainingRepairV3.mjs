import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditTrainingPartitionIsolation,
  auditTrainingRows,
  contentHash,
} from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT = resolve(
  process.env.TRAINING_REPAIR_V3_ROOT ||
    "training/evaluation-cycle-v2/07-training-data-double-check-v3-20260901",
);
const packPath = resolve(ROOT, "repaired-training-items-draft.json");
const allocationPath = resolve(ROOT, "global-allocation-draft.json");
const packBytes = readFileSync(packPath);
const allocationBytes = readFileSync(allocationPath);
const pack = JSON.parse(packBytes);
const allocation = JSON.parse(allocationBytes);

const failures = [];
const seenQuestions = new Set();
const seenIds = new Set();
const itemChecks = [];
const sourceOccurrences = [];
const stripCitations = (value) =>
  String(value || "")
    .replace(/\s*\{\{cite:[^}]+\}\}/g, "")
    .trim();
const normalise = (value) =>
  stripCitations(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const materialSentences = (answer) => {
  const split = stripCitations(answer)
    .split(/(?<=[.!?])\s+(?=[A-Z£])|;\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const merged = [];
  for (let index = 0; index < split.length; index += 1) {
    if (/^(?:No|Yes)\.$/.test(split[index]) && split[index + 1]) {
      merged.push(`${split[index]} ${split[index + 1]}`);
      index += 1;
    } else {
      merged.push(split[index]);
    }
  }
  return merged;
};
const isIsoDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const topicOf = (item) => {
  const parts = String(item.construct_id || item.legal_rule_id || "").split(".");
  return parts.length >= 2 ? parts.slice(0, 2).join(".") : parts[0] || "unclassified";
};
const sameSet = (left, right) => {
  const leftValues = [...new Set(left)].sort();
  const rightValues = [...new Set(right)].sort();
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
};

for (const item of pack.items || []) {
  const evidence = Array.isArray(item.retrieved_evidence) ? item.retrieved_evidence : [];
  const evidenceIds = evidence.map((source) => source.source_id).filter(Boolean);
  const evidenceIdSet = new Set(evidenceIds);
  const citations = [
    ...String(item.ideal_answer || "").matchAll(/\{\{cite:([^}]+)\}\}/g),
  ].map((match) => match[1]);
  const citationSet = new Set(citations);
  const propositionCandidates = Array.isArray(item.proposition_source_candidates)
    ? item.proposition_source_candidates
    : [];
  const sentences = materialSentences(item.ideal_answer);
  const mappedPropositions = new Set(
    propositionCandidates.map((entry) => normalise(entry.proposition)).filter(Boolean),
  );
  const mappedSourceIds = new Set(
    propositionCandidates.flatMap((entry) =>
      Array.isArray(entry.source_ids) ? entry.source_ids : [],
    ),
  );
  const normalizedAnswer = normalise(item.ideal_answer);
  const answerIsSubstantial = normalizedAnswer.split(" ").filter(Boolean).length >= 12;

  for (const source of evidence) {
    sourceOccurrences.push({ training_id: item.training_id, source });
  }

  const metadataComplete = evidence.every(
    (source) =>
      source.source_id &&
      source.title?.trim() &&
      source.section?.trim() &&
      source.jurisdiction?.trim() &&
      /^https:\/\//.test(source.source_url || "") &&
      source.authority_family?.trim() &&
      source.source_role?.trim() &&
      source.text_origin?.trim() &&
      isIsoDate(source.source_snapshot_as_of) &&
      source.provision_status?.trim() &&
      !("effective_date" in source) &&
      (!source.provision_effective_from || isIsoDate(source.provision_effective_from)),
  );
  const territorialDatesValid = evidence.every((source) => {
    if (!source.territorial_effective_dates) return true;
    const entries = Object.entries(source.territorial_effective_dates);
    return entries.length > 0 && entries.every(([, value]) => isIsoDate(value));
  });
  const generalCodeDatesCorrect = evidence.every((source) => {
    if (source.authority_family !== "official-tpr-general-code-of-practice-2024") {
      return true;
    }
    return (
      source.territorial_effective_dates?.great_britain === "2024-03-28" &&
      source.territorial_effective_dates?.northern_ireland === "2024-07-05"
    );
  });
  const checks = {
    unique_id: Boolean(item.training_id) && !seenIds.has(item.training_id),
    unique_question:
      Boolean(item.user_question?.trim()) && !seenQuestions.has(normalise(item.user_question)),
    wave_valid: item.wave === 2 || item.wave === 3,
    question_hash: item.question_sha256 === contentHash(item.user_question || ""),
    evidence_present: evidence.length > 0,
    evidence_ids_unique: evidenceIds.length === evidenceIdSet.size,
    evidence_content_hashes: evidence.every(
      (source) =>
        source.text?.trim() && source.content_sha256 === contentHash(source.text),
    ),
    evidence_metadata_complete: metadataComplete,
    verified_excerpt_locators_present: evidence.every(
      (source) =>
        !source.text_origin?.startsWith("verified_") ||
        source.verification_locator?.trim(),
    ),
    territorial_dates_valid: territorialDatesValid,
    general_code_territorial_dates_correct: generalCodeDatesCorrect,
    no_unapproved_citation_tokens: citations.length === 0 && citationSet.size === 0,
    no_synthetic_citations: citations.every((id) => !/^w[23]-/.test(id)),
    proposition_count_exact:
      sentences.length > 0 && propositionCandidates.length === sentences.length,
    proposition_sentence_alignment:
      propositionCandidates.length === sentences.length &&
      sentences.every(
        (sentence, index) =>
          normalise(propositionCandidates[index]?.proposition) === normalise(sentence),
      ) &&
      mappedPropositions.size === sentences.length,
    proposition_mapping_ids_mechanical:
      propositionCandidates.length > 0 &&
      propositionCandidates.every(
        (entry) => {
          const allowedRelationships = new Set([
            "direct_textual_support",
            "multi_source_synthesis",
            "application_inference_from_cited_rule",
            "evidence_gap_or_scope_boundary",
            "question_fact_calculation_with_source_context",
          ]);
          return Boolean(
            entry.proposition?.trim() &&
            Array.isArray(entry.source_ids) &&
            entry.source_ids.length > 0 &&
            new Set(entry.source_ids).size === entry.source_ids.length &&
            entry.source_ids.every((id) => evidenceIdSet.has(id)) &&
            entry.assignment_method ===
              "owner_authorised_developer_source_review" &&
            allowedRelationships.has(entry.support_relationship) &&
            entry.support_determination ===
              "developer_source_reviewed_relationship_not_independent_legal_entailment" &&
            entry.mapping_review_authority === "owner_authorised" &&
            entry.independent_legal_approval === false &&
            entry.lexical_score === undefined &&
            entry.candidate_basis === undefined,
          );
        },
      ),
    proposition_candidate_source_ids_nonempty: propositionCandidates.every(
      (entry) => Array.isArray(entry.source_ids) && entry.source_ids.length > 0,
    ),
    every_selected_source_used_in_exact_mapping:
      evidenceIds.length === mappedSourceIds.size &&
      evidenceIds.every((sourceId) => mappedSourceIds.has(sourceId)),
    proposition_mapping_scope_honest: propositionCandidates.every(
      (entry) =>
        entry.mapping_review_authority === "owner_authorised" &&
        entry.independent_legal_approval === false &&
        !/independent.*approved|legal.*approved/i.test(
          `${entry.support_determination || ""} ${entry.approval_status || ""}`,
        ),
    ),
    no_answer_echo_in_question:
      !answerIsSubstantial || !normalise(item.user_question).includes(normalizedAnswer),
    review_only:
      item.training_authorised === false &&
      item.review_status ===
        "owner_authorised_developer_source_review_complete_pending_independent_legal_approval",
  };

  seenIds.add(item.training_id);
  seenQuestions.add(normalise(item.user_question));
  const passed = Object.values(checks).every(Boolean);
  if (!passed) failures.push({ training_id: item.training_id, checks });
  itemChecks.push({
    training_id: item.training_id,
    wave: item.wave,
    topic: topicOf(item),
    passed,
    checks,
    evidence_ids: evidenceIds,
    material_sentence_count: sentences.length,
    proposition_candidate_count: propositionCandidates.length,
  });
}

const sourceIdGroups = new Map();
const contentGroups = new Map();
const locatorGroups = new Map();
for (const occurrence of sourceOccurrences) {
  const { source } = occurrence;
  if (!sourceIdGroups.has(source.source_id)) sourceIdGroups.set(source.source_id, []);
  sourceIdGroups.get(source.source_id).push(occurrence);
  const textHash = source.text?.trim() ? contentHash(source.text) : "missing-text";
  if (!contentGroups.has(textHash)) contentGroups.set(textHash, []);
  contentGroups.get(textHash).push(occurrence);
  const locator = [source.source_url, source.section].join("|");
  if (!locatorGroups.has(locator)) locatorGroups.set(locator, []);
  locatorGroups.get(locator).push(occurrence);
}

const sourceIdentityConflicts = [];
for (const [sourceId, occurrences] of sourceIdGroups) {
  const variants = new Set(
    occurrences.map(({ source }) =>
      JSON.stringify({
        title: source.title,
        section: source.section,
        jurisdiction: source.jurisdiction,
        source_url: source.source_url,
        authority_family: source.authority_family,
        source_role: source.source_role,
        source_snapshot_as_of: source.source_snapshot_as_of,
        provision_status: source.provision_status,
        provision_effective_from: source.provision_effective_from,
        territorial_effective_dates: source.territorial_effective_dates,
        content_sha256: source.content_sha256,
      }),
    ),
  );
  if (variants.size > 1) {
    sourceIdentityConflicts.push({
      type: "same_source_id_conflicting_metadata_or_text",
      source_id: sourceId,
      training_ids: [...new Set(occurrences.map((entry) => entry.training_id))],
      variant_count: variants.size,
    });
  }
}
for (const [textHash, occurrences] of contentGroups) {
  if (textHash === "missing-text") continue;
  const authorities = [
    ...new Set(occurrences.map(({ source }) => source.authority_family).filter(Boolean)),
  ];
  if (authorities.length > 1) {
    sourceIdentityConflicts.push({
      type: "identical_passage_assigned_to_multiple_authority_families",
      content_sha256: textHash,
      authority_families: authorities,
      source_ids: [...new Set(occurrences.map(({ source }) => source.source_id))],
      training_ids: [...new Set(occurrences.map((entry) => entry.training_id))],
    });
  }
}
for (const [locator, occurrences] of locatorGroups) {
  if (locator.startsWith("undefined|")) continue;
  const hashes = [
    ...new Set(
      occurrences
        .map(({ source }) => source.content_sha256)
        .filter(Boolean),
    ),
  ];
  if (hashes.length > 1) {
    sourceIdentityConflicts.push({
      type: "same_url_and_section_conflicting_passages",
      locator,
      content_sha256_values: hashes,
      source_ids: [...new Set(occurrences.map(({ source }) => source.source_id))],
      training_ids: [...new Set(occurrences.map((entry) => entry.training_id))],
    });
  }
}

const echoAudit = auditTrainingRows(pack.items || []);
const counts = {
  wave_2: (pack.items || []).filter((item) => item.wave === 2).length,
  wave_3: (pack.items || []).filter((item) => item.wave === 3).length,
};
const textOriginCounts = sourceOccurrences.reduce((result, { source }) => {
  const origin = source.text_origin || "missing";
  result[origin] = (result[origin] || 0) + 1;
  return result;
}, {});
const curatorSummarySourceIds = [
  ...new Set(
    sourceOccurrences
      .filter(
        ({ source }) =>
          source.text_origin ===
          "curator_summary_of_official_source_pending_verbatim_replacement",
      )
      .map(({ source }) => source.source_id),
  ),
].sort();
const emptyPropositionCandidates = (pack.items || []).flatMap((item) =>
  (item.proposition_source_candidates || [])
    .filter((entry) => !Array.isArray(entry.source_ids) || entry.source_ids.length === 0)
    .map((entry) => ({
      training_id: item.training_id,
      proposition: entry.proposition,
      assignment_method: entry.assignment_method,
    })),
);
const exactMappingCount = (pack.items || []).reduce(
  (count, item) => count + (item.proposition_source_candidates || []).length,
  0,
);
const supportRelationshipCounts = (pack.items || []).reduce((countsByType, item) => {
  for (const entry of item.proposition_source_candidates || []) {
    const relationship = entry.support_relationship || "missing";
    countsByType[relationship] = (countsByType[relationship] || 0) + 1;
  }
  return countsByType;
}, {});
const requiredFindingRepairs = [
  "v2r-w3-t02-train-003",
  "v2r-w3-t02-train-002",
  "v2-w3-t01-train-006",
  "v2-w3-t01-train-002",
  "v2r-w3-t01-train-002",
  "v2-w2-t01-train-006",
  "v2-w2-t02-train-002",
  "v2-w2-t02-train-006",
  "v2-w2-t01-train-004",
  "v2r-w2-t04-train-001",
  "v2-w2-t04-train-006",
  "v2-w2-t04-train-005",
];
const findingRepairs = requiredFindingRepairs.map((trainingId) => {
  const item = (pack.items || []).find(
    (candidate) => candidate.training_id === trainingId,
  );
  return {
    training_id: trainingId,
    present: Boolean(item),
    explicit_repair:
      item?.repair_basis === "explicit_second_pass_legal_or_drafting_repair" ||
      item?.repair_basis === "explicit_screening_finding_repaired",
    evidence_ids:
      item?.retrieved_evidence?.map((source) => source.source_id) || [],
  };
});

const packIds = (pack.items || []).map((item) => item.training_id);
const packIdSet = new Set(packIds);
const trainIds = Array.isArray(allocation.train?.ids) ? allocation.train.ids : [];
const validationIds = Array.isArray(allocation.validation?.ids)
  ? allocation.validation.ids
  : [];
const allocatedIds = [...trainIds, ...validationIds];
const trainIdSet = new Set(trainIds);
const validationIdSet = new Set(validationIds);
const byId = new Map((pack.items || []).map((item) => [item.training_id, item]));
const canonicalise = (item) => ({
  ...item,
  construct_id:
    allocation.semantic_rule_overrides?.[item.training_id] ||
    item.legal_rule_id ||
    item.construct_id,
});
const localTrain = trainIds.map((id) => byId.get(id)).filter(Boolean);
const localValidation = validationIds.map((id) => byId.get(id)).filter(Boolean);
const recomputedLocalIsolation = auditTrainingPartitionIsolation(
  localTrain.map(canonicalise),
  localValidation.map(canonicalise),
);
const validationWaveCounts = {
  wave_2: localValidation.filter((item) => item.wave === 2).length,
  wave_3: localValidation.filter((item) => item.wave === 3).length,
};
const availableTopics = [...new Set((pack.items || []).map(topicOf))].sort();
const validationTopics = [...new Set(localValidation.map(topicOf))].sort();
const sourcePackHash = contentHash(packBytes);
const requiredPendingFlags = [
  "independent_proposition_and_full_passage_review",
  "rendered_export_token_length_and_loss_mask_audit",
  "cumulative_training_history_isolation_audit",
  "protected_regression_and_sealed_unseen_custodian_comparison",
  "clean_starting_checkpoint_provenance",
];
const allocationChecks = {
  hash_bound: allocation.source_pack_sha256 === sourcePackHash,
  local_scope_only:
    allocation.scope === "local_wave_2_3_visible_candidate_only" &&
    allocation.isolation?.scope === "local_wave_2_3_only" &&
    !String(allocation.version || "").includes("global"),
  count_range:
    Number.isInteger(allocation.validation?.count) &&
    allocation.validation.count >= 8 &&
    allocation.validation.count <= 12 &&
    Number.isInteger(allocation.train?.count) &&
    allocation.train.count + allocation.validation.count === 52,
  count_fields_match_ids:
    allocation.train?.count === trainIds.length &&
    allocation.validation?.count === validationIds.length,
  exact_partition:
    trainIdSet.size === trainIds.length &&
    validationIdSet.size === validationIds.length &&
    allocatedIds.length === 52 &&
    new Set(allocatedIds).size === 52 &&
    allocatedIds.every((id) => packIdSet.has(id)) &&
    packIds.every((id) => trainIdSet.has(id) || validationIdSet.has(id)),
  both_waves_represented:
    validationWaveCounts.wave_2 > 0 && validationWaveCounts.wave_3 > 0,
  wave_balance_report_consistent:
    allocation.wave_balance?.wave_2 === validationWaveCounts.wave_2 &&
    allocation.wave_balance?.wave_3 === validationWaveCounts.wave_3 &&
    allocation.wave_balance?.absolute_difference ===
      Math.abs(validationWaveCounts.wave_2 - validationWaveCounts.wave_3),
  topic_coverage_report_consistent:
    sameSet(allocation.coverage?.available_topics || [], availableTopics) &&
    sameSet(allocation.coverage?.validation_topics || [], validationTopics) &&
    allocation.coverage?.available_topic_count === availableTopics.length &&
    allocation.coverage?.validation_topic_count === validationTopics.length,
  topic_and_wave_selection_objective_recorded:
    allocation.selection_objective?.[0] === "maximise_topic_coverage" &&
    allocation.selection_objective?.[1] === "minimise_wave_count_difference",
  locally_isolated:
    allocation.isolation?.passed === true &&
    recomputedLocalIsolation.passed === true &&
    Object.values(recomputedLocalIsolation.overlap || {}).every(
      (values) => values.length === 0,
    ),
  review_only:
    allocation.training_authorised === false &&
    allocation.release_authorised === false &&
    allocation.unseen_included === false &&
    allocation.unseen_accessed === false &&
    !/approved_for_training|training_approved/i.test(
      `${allocation.status || ""} ${allocation.caveat || ""}`,
    ),
  external_gates_explicitly_pending: requiredPendingFlags.every(
    (flag) => allocation.pending_checks?.[flag] === true,
  ),
  local_limit_explicit:
    /does not establish cumulative-history/i.test(allocation.caveat || "") &&
    /does not authorise training/i.test(allocation.caveat || ""),
};

const packChecks = {
  exact_item_count:
    pack.item_count === 52 &&
    (pack.items || []).length === 52 &&
    counts.wave_2 === 33 &&
    counts.wave_3 === 19,
  items_hash_bound: pack.items_sha256 === contentHash(JSON.stringify(pack.items || [])),
  review_only:
    pack.training_authorised === false &&
    pack.release_authorised === false &&
    pack.unseen_included === false &&
    pack.unseen_accessed === false &&
    !/approved_for_training|training_approved/i.test(pack.status || ""),
  unique_ids: packIds.length === packIdSet.size,
  no_answer_echo: echoAudit.passed,
  no_source_identity_conflicts: sourceIdentityConflicts.length === 0,
  no_curator_summary_sources: curatorSummarySourceIds.length === 0,
  no_empty_proposition_source_candidates: emptyPropositionCandidates.length === 0,
  exact_owner_authorised_developer_mapping_recorded:
    pack.citation_mapping_status?.includes(
      "owner-authorised developer/source-review mapping",
    ) &&
    (pack.items || []).every(
      (item) =>
        item.citation_status ===
          "owner_authorised_developer_source_mapping_complete_not_independent_legal_approval",
    ),
  screening_repairs_present: findingRepairs.every(
    (item) => item.present && item.explicit_repair,
  ),
};

const passed =
  Object.values(packChecks).every(Boolean) &&
  failures.length === 0 &&
  Object.values(allocationChecks).every(Boolean);
const report = {
  version: "wave4-wave2-wave3-repair-integrity-preflight-v8",
  generated_at: new Date().toISOString(),
  status: passed
    ? "machine_draft_preflight_passed_with_mandatory_external_gates_pending"
    : "machine_draft_preflight_failed",
  scope: "visible_wave_2_3_review_draft_only",
  training_authorised: false,
  unseen_accessed: false,
  passed,
  item_count: pack.item_count,
  counts,
  pack_checks: packChecks,
  source_pack_sha256: sourcePackHash,
  allocation_sha256: contentHash(allocationBytes),
  answer_input_echo_audit: echoAudit,
  source_metadata_audit: {
    occurrence_count: sourceOccurrences.length,
    unique_source_id_count: sourceIdGroups.size,
    text_origin_counts: textOriginCounts,
    curator_summary_source_ids: curatorSummarySourceIds,
    identity_conflicts: sourceIdentityConflicts,
    passed:
      sourceIdentityConflicts.length === 0 && curatorSummarySourceIds.length === 0,
  },
  proposition_map_audit: {
    item_count: itemChecks.length,
    failed_item_ids: itemChecks.filter((item) => !item.passed).map((item) => item.training_id),
    exact_mapping_count: exactMappingCount,
    empty_mapping_count: emptyPropositionCandidates.length,
    empty_mappings: emptyPropositionCandidates,
    support_relationship_counts: supportRelationshipCounts,
    review_authority: "owner_authorised_developer_source_review",
    independent_legal_approval: false,
    minimum_rule:
      "Every material answer proposition must have one position-aligned, non-empty source mapping drawn only from that item's selected evidence, with an explicit support relationship. Unsupported propositions must be narrowed or expressed as an evidence/scope boundary rather than force-cited.",
    citation_rule:
      "Draft ideal answers contain no rendered citation tokens. The recorded mappings are owner-authorised developer/source-review determinations and are machine-usable, but are not independent legal entailment approval; approved_citation_ids remain empty pending that separate gate.",
  },
  allocation_checks: allocationChecks,
  local_partition_isolation_recomputed: recomputedLocalIsolation,
  allocation_summary: {
    train: trainIds.length,
    validation: validationIds.length,
    validation_wave_counts: validationWaveCounts,
    validation_topics: validationTopics,
  },
  screening_findings: findingRepairs,
  mandatory_external_gates_pending: {
    independent_legal_and_semantic_proposition_review: true,
    actual_rendered_export_token_lengths_and_loss_masks: true,
    cumulative_training_history_and_checkpoint_provenance: true,
    authorised_custodian_protected_regression_and_sealed_unseen_comparison: true,
  },
  machine_preflight_limit:
    "A passing result establishes structural integrity, complete recorded source metadata, absence of curator-summary source text, an exact non-empty owner-authorised developer/source-review mapping for every material proposition, deliberate absence of draft citation tokens, absence of verbatim target echo, and local Wave 2–3 recorded-field isolation. It does not establish independent legal entailment approval, cumulative split approval, training authority, checkpoint qualification, sealed-unseen clearance or release authority.",
  failures,
  item_checks: itemChecks,
};

writeFileSync(
  resolve(ROOT, "integrity-and-review-preflight.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      passed,
      items: pack.item_count,
      wave_2: counts.wave_2,
      wave_3: counts.wave_3,
      failures: failures.length,
      source_identity_conflicts: sourceIdentityConflicts.length,
      curator_summary_sources: curatorSummarySourceIds.length,
      exact_proposition_mappings: exactMappingCount,
      empty_proposition_mappings: emptyPropositionCandidates.length,
      validation: validationIds.length,
      local_isolation: recomputedLocalIsolation.passed,
      external_gates_pending: true,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
