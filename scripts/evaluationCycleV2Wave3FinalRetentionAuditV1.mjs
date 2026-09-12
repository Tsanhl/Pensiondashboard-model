import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const fullRoot = path.resolve(
  process.env.WAVE3_FULL_ROOT ||
    path.join(
      workspaceRoot,
      "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901",
    ),
);
const reviewedFullRoot = path.resolve(
  process.env.WAVE3_REVIEWED_FULL_ROOT ||
    path.join(
      workspaceRoot,
      "training/evaluation-cycle-v2/23-cumulative-visible-qualification-v8-final-full-20260901",
    ),
);
const compactRoot = process.env.WAVE3_FINAL_COMPACT_ROOT
  ? path.resolve(process.env.WAVE3_FINAL_COMPACT_ROOT)
  : null;

if (!compactRoot) {
  throw new Error(
    "WAVE3_FINAL_COMPACT_ROOT is required. Refusing to bind an audit to an inferred or provisional compact root.",
  );
}

const itemRegisterPath = path.join(fullRoot, "cumulative-visible-item-register.json");
const sourceRegisterPath = path.join(
  fullRoot,
  "cumulative-visible-source-register.json",
);
const reviewedItemRegisterPath = path.join(
  reviewedFullRoot,
  "cumulative-visible-item-register.json",
);
const reviewedSourceRegisterPath = path.join(
  reviewedFullRoot,
  "cumulative-visible-source-register.json",
);
const compactMapPath = path.resolve(
  process.env.WAVE3_FINAL_COMPACT_MAP ||
    path.join(compactRoot, "compact-evidence-map.json"),
);
const weakExcerptPath = path.join(compactRoot, "weak-compact-excerpts.json");
const unmappablePath = path.join(compactRoot, "unmappable-propositions.json");
const recommendationsPath = path.resolve(
  process.env.WAVE3_REVIEWED_RECOMMENDATIONS ||
    path.join(
      reviewedFullRoot,
      "independent-agent-audits/wave-3-compact-substantive-retention-recommendations.v8-provisional-v3.json",
    ),
);
const auditDirectory = path.resolve(
  process.env.WAVE3_FINAL_AUDIT_DIRECTORY ||
    path.join(compactRoot, "independent-agent-audits"),
);
// The qualifier/exporter consume the JSON from the compact-root top level.
const outputJsonPath = path.join(
  compactRoot,
  "wave-3-compact-substantive-retention-audit.json",
);
const outputMarkdownPath = path.join(
  auditDirectory,
  "WAVE-3-COMPACT-SUBSTANTIVE-RETENTION-AUDIT.md",
);

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const readJsonWithBytes = (filePath) => {
  const bytes = fs.readFileSync(filePath);
  return { bytes, value: JSON.parse(bytes) };
};
const sameSet = (left, right) => {
  const uniqueLeft = [...new Set(left || [])].sort();
  const uniqueRight = [...new Set(right || [])].sort();
  return (
    uniqueLeft.length === uniqueRight.length &&
    uniqueLeft.join("\u0000") === uniqueRight.join("\u0000")
  );
};
const mappingKey = (trainingId, proposition) =>
  `${trainingId}\u0000${proposition}`;

const EXPECTED = {
  item_register_sha256:
    "ef6351a1d56d1a1cab58ed818d0bac8301477b1780f71deea1a77527d172d8e4",
  full_source_register_sha256:
    "d7fa814045b30a626029452a72bec621e318bc29f7bcf3d2bbdd7e0830477056",
  compact_evidence_map_sha256:
    "3b1a24ba381086d01584b9e258c4dc4adc6e1abccd5272ac4ebc52698e8ba9ea",
  reviewed_recommendations_sha256:
    "940cb16c8b60c103536dac1b10b04f01d6b243570a0921c945208e82524dbfd5",
};

const itemRegisterRecord = readJsonWithBytes(itemRegisterPath);
const sourceRegisterRecord = readJsonWithBytes(sourceRegisterPath);
const compactMapRecord = readJsonWithBytes(compactMapPath);
const recommendationsRecord = readJsonWithBytes(recommendationsPath);
const reviewedItemRegisterRecord = readJsonWithBytes(reviewedItemRegisterPath);
const reviewedSourceRegisterRecord = readJsonWithBytes(reviewedSourceRegisterPath);
const weakExcerptRecord = readJsonWithBytes(weakExcerptPath);
const unmappableRecord = readJsonWithBytes(unmappablePath);

const itemRegisterSha256 = sha256(itemRegisterRecord.bytes);
const sourceRegisterSha256 = sha256(sourceRegisterRecord.bytes);
const compactMapSha256 = sha256(compactMapRecord.bytes);
const recommendations = recommendationsRecord.value;
const compactMap = compactMapRecord.value;

if (
  recommendations.bindings?.item_register_sha256 !==
    sha256(reviewedItemRegisterRecord.bytes) ||
  recommendations.bindings?.full_source_register_sha256 !==
    sha256(reviewedSourceRegisterRecord.bytes)
) {
  throw new Error(
    "Reviewed recommendations are not bound to the supplied reviewed full item/source registers.",
  );
}

const recommendationsSha256 = sha256(recommendationsRecord.bytes);
for (const [name, expected] of Object.entries(EXPECTED)) {
  const actual = {
    item_register_sha256: itemRegisterSha256,
    full_source_register_sha256: sourceRegisterSha256,
    compact_evidence_map_sha256: compactMapSha256,
    reviewed_recommendations_sha256: recommendationsSha256,
  }[name];
  if (actual !== expected) {
    throw new Error(
      `Immutable root-24 binding changed for ${name}: ${actual} != ${expected}.`,
    );
  }
}
if (
  itemRegisterRecord.value.upstream_bindings?.item_register_sha256 !==
    sha256(reviewedItemRegisterRecord.bytes) ||
  itemRegisterRecord.value.upstream_bindings?.source_register_sha256 !==
    sha256(reviewedSourceRegisterRecord.bytes) ||
  itemRegisterRecord.value.upstream_bindings?.wave_3_span_recommendations_sha256 !==
    recommendationsSha256 ||
  compactMap.span_recommendation_bindings?.wave_3_sha256 !==
    recommendationsSha256
) {
  throw new Error(
    "Final compact item/map bytes are not bound to the reviewed full registers and Wave 3 recommendations.",
  );
}

const wave3TrainingIds = new Set(
  itemRegisterRecord.value.items
    .filter((item) => item.wave === 3)
    .map((item) => item.training_id),
);
if (wave3TrainingIds.size !== 19) {
  throw new Error(
    `Expected 19 Wave 3 training IDs; found ${wave3TrainingIds.size}.`,
  );
}

if (
  recommendations.decisions?.length !== 68 ||
  recommendations.counts?.exact_span_decisions !== 68 ||
  recommendations.passed !== false ||
  recommendations.training_authorised !== false ||
  recommendations.release_authorised !== false ||
  recommendations.unseen_accessed !== false
) {
  throw new Error(
    "Reviewed recommendations must contain exactly 68 fail-closed exact-span decisions.",
  );
}

const sourceById = new Map();
for (const item of itemRegisterRecord.value.items) {
  for (const source of item.retrieved_evidence || []) {
    const existing = sourceById.get(source.source_id);
    if (existing && sha256(existing.text) !== sha256(source.text)) {
      throw new Error(
        `Parent source ${source.source_id} has inconsistent text occurrences in the item register.`,
      );
    }
    sourceById.set(source.source_id, source);
  }
}

for (const identity of sourceRegisterRecord.value.sources) {
  const parent = sourceById.get(identity.source_id);
  if (!parent || sha256(parent.text) !== identity.content_sha256) {
    throw new Error(
      `Canonical source identity ${identity.source_id} is missing or does not match item-register text.`,
    );
  }
}
const excerptById = new Map(
  compactMap.excerpts.map((excerpt) => [excerpt.excerpt_id, excerpt]),
);
const finalMappings = compactMap.proposition_mappings.filter((mapping) =>
  wave3TrainingIds.has(mapping.training_id),
);
const finalMappingByKey = new Map(
  finalMappings.map((mapping) => [
    mappingKey(mapping.training_id, mapping.proposition),
    mapping,
  ]),
);
const itemMappingByKey = new Map(
  itemRegisterRecord.value.items
    .filter((item) => item.wave === 3)
    .flatMap((item) =>
      item.proposition_source_candidates.map((mapping) => [
        mappingKey(item.training_id, mapping.proposition),
        mapping,
      ]),
    ),
);
const propositionCheckByKey = new Map(
  compactMap.proposition_checks
    .filter((check) => wave3TrainingIds.has(check.training_id))
    .map((check) => [
      mappingKey(check.training_id, check.proposition),
      check,
    ]),
);

const findings = [];
const provisionalDecisions = [];
const recordFinding = (decision, code, detail) => {
  findings.push({
    mapping_index: decision.mapping_index,
    training_id: decision.training_id,
    proposition: decision.proposition,
    code,
    detail,
  });
};

if (finalMappings.length !== 68 || finalMappingByKey.size !== 68) {
  findings.push({
    mapping_index: null,
    training_id: null,
    proposition: null,
    code: "wave_3_mapping_count_mismatch",
    detail: `Expected 68 unique final mappings; found ${finalMappings.length} rows and ${finalMappingByKey.size} unique keys.`,
  });
}
if (itemMappingByKey.size !== 68 || propositionCheckByKey.size !== 68) {
  findings.push({
    mapping_index: null,
    training_id: null,
    proposition: null,
    code: "wave_3_item_or_check_count_mismatch",
    detail: `Expected 68 unique item/check mappings; found ${itemMappingByKey.size}/${propositionCheckByKey.size}.`,
  });
}
if (
  compactMap.passed !== true ||
  compactMap.training_authorised !== false ||
  compactMap.release_authorised !== false ||
  compactMap.independent_legal_approval !== false ||
  compactMap.unseen_accessed !== false ||
  compactMap.item_register_sha256 !== itemRegisterSha256 ||
  compactMap.full_source_register_sha256 !== sourceRegisterSha256
) {
  findings.push({
    mapping_index: null,
    training_id: null,
    proposition: null,
    code: "compact_map_scope_or_binding_failure",
    detail:
      "The compact map's scope flags or item/source bindings do not satisfy the fail-closed development contract.",
  });
}
if (
  weakExcerptRecord.value.passed !== true ||
  weakExcerptRecord.value.counts?.weak_excerpts !== 0 ||
  unmappableRecord.value.passed !== true ||
  unmappableRecord.value.count !== 0
) {
  findings.push({
    mapping_index: null,
    training_id: null,
    proposition: null,
    code: "structural_or_unmappable_failure",
    detail: `Weak excerpts: ${weakExcerptRecord.value.counts?.weak_excerpts}; unmappable propositions: ${unmappableRecord.value.count}.`,
  });
}

for (const recommendation of recommendations.decisions) {
  const key = mappingKey(
    recommendation.training_id,
    recommendation.proposition,
  );
  const mapping = finalMappingByKey.get(key);
  const itemMapping = itemMappingByKey.get(key);
  const propositionCheck = propositionCheckByKey.get(key);
  if (!mapping || !itemMapping || !propositionCheck) {
    recordFinding(
      recommendation,
      "reviewed_mapping_missing",
      "The exact reviewed training-ID/proposition pair is absent from the final compact map, item map, or proposition checks.",
    );
    continue;
  }

  if (
    sha256(mapping.proposition) !== recommendation.proposition_sha256
  ) {
    recordFinding(
      recommendation,
      "proposition_hash_mismatch",
      "The proposition bytes changed after substantive review.",
    );
  }
  if (
    mapping.support_relationship !== recommendation.support_relationship ||
    itemMapping.support_relationship !== recommendation.support_relationship ||
    propositionCheck.support_relationship !== recommendation.support_relationship
  ) {
    recordFinding(
      recommendation,
      "support_relationship_changed",
      `Reviewed ${recommendation.support_relationship}; final/item/check relationships were ${mapping.support_relationship}/${itemMapping.support_relationship}/${propositionCheck.support_relationship}.`,
    );
  }
  if (!sameSet(mapping.original_source_ids, recommendation.mapped_source_ids)) {
    recordFinding(
      recommendation,
      "original_source_scope_changed",
      "The final mapping does not preserve the reviewed proposition-level source scope.",
    );
  }
  if (!sameSet(itemMapping.source_ids, recommendation.mapped_source_ids)) {
    recordFinding(
      recommendation,
      "item_source_scope_changed",
      "The root-24 item mapping does not preserve the reviewed proposition-level source scope.",
    );
  }
  if (
    !sameSet(
      mapping.selected_parent_source_ids || [],
      recommendation.selected_parent_source_ids || [],
    )
  ) {
    recordFinding(
      recommendation,
      "selected_parent_sources_changed",
      `Reviewed ${JSON.stringify(recommendation.selected_parent_source_ids)}; final ${JSON.stringify(mapping.selected_parent_source_ids)}.`,
    );
  }
  if (
    !propositionCheck.passed ||
    !sameSet(propositionCheck.excerpt_ids, mapping.excerpt_ids)
  ) {
    recordFinding(
      recommendation,
      "proposition_check_failure",
      "The final proposition check failed or names different compact excerpts.",
    );
  }

  const finalExcerpts = [];
  for (const excerptId of mapping.excerpt_ids || []) {
    const excerpt = excerptById.get(excerptId);
    if (!excerpt) {
      recordFinding(
        recommendation,
        "referenced_excerpt_missing",
        `Final mapping references missing excerpt ${excerptId}.`,
      );
      continue;
    }
    finalExcerpts.push(excerpt);

    const parent = sourceById.get(excerpt.parent_source_id);
    if (!parent) {
      recordFinding(
        recommendation,
        "parent_source_missing",
        `Excerpt ${excerptId} references missing parent ${excerpt.parent_source_id}.`,
      );
      continue;
    }
    const parentSha256 = sha256(parent.text);
    if (
      !mapping.selected_parent_source_ids.includes(excerpt.parent_source_id) ||
      excerpt.full_source_sha256 !== parentSha256 ||
      !Number.isInteger(excerpt.start) ||
      !Number.isInteger(excerpt.end) ||
      excerpt.start < 0 ||
      excerpt.end <= excerpt.start ||
      excerpt.end > parent.text.length ||
      excerpt.text !== parent.text.slice(excerpt.start, excerpt.end) ||
      excerpt.excerpt_sha256 !== sha256(excerpt.text)
    ) {
      recordFinding(
        recommendation,
        "excerpt_integrity_failure",
        `Excerpt ${excerptId} is not an exact, hash-bound substring of ${excerpt.parent_source_id}.`,
      );
    }
  }

  if (
    !sameSet(
      finalExcerpts.map((excerpt) => excerpt.parent_source_id),
      mapping.selected_parent_source_ids,
    )
  ) {
    recordFinding(
      recommendation,
      "selected_parent_without_final_excerpt",
      "At least one reviewed selected parent lacks a final compact excerpt, or an unreviewed parent was added.",
    );
  }

  for (const reviewedSpan of recommendation.recommended_spans) {
    const parent = sourceById.get(reviewedSpan.parent_source_id);
    if (
      !parent ||
      sha256(parent.text) !== reviewedSpan.full_source_sha256 ||
      parent.text.slice(reviewedSpan.start, reviewedSpan.end) !==
        reviewedSpan.text ||
      sha256(reviewedSpan.text) !== reviewedSpan.excerpt_sha256
    ) {
      recordFinding(
        recommendation,
        "reviewed_parent_or_span_changed",
        `Reviewed span ${reviewedSpan.parent_source_id} [${reviewedSpan.start},${reviewedSpan.end}) no longer matches its hash-bound parent bytes.`,
      );
      continue;
    }
    const coveringExcerpt = finalExcerpts.find(
      (excerpt) =>
        excerpt.parent_source_id === reviewedSpan.parent_source_id &&
        excerpt.start <= reviewedSpan.start &&
        excerpt.end >= reviewedSpan.end,
    );
    if (!coveringExcerpt) {
      recordFinding(
        recommendation,
        "reviewed_substantive_span_not_retained",
        `No final excerpt covers reviewed span ${reviewedSpan.parent_source_id} [${reviewedSpan.start},${reviewedSpan.end}).`,
      );
    }
  }

  provisionalDecisions.push({
    training_id: mapping.training_id,
    proposition: mapping.proposition,
    support_relationship: mapping.support_relationship,
    excerpt_ids: mapping.excerpt_ids,
    decision: `retained_complete_${mapping.support_relationship}_for_owner_authorised_development`,
    passed: true,
  });
}

const passed =
  findings.length === 0 &&
  provisionalDecisions.length === 68 &&
  new Set(
    provisionalDecisions.map((decision) =>
      mappingKey(decision.training_id, decision.proposition),
    ),
  ).size === 68;

const result = {
  version: "wave-3-compact-substantive-retention-audit-v1",
  generated_at: new Date().toISOString(),
  status: passed
    ? "passed_owner_authorised_developer_substantive_retention_audit"
    : "blocked_substantive_retention_audit",
  passed,
  training_authorised: false,
  release_authorised: false,
  independent_legal_review: false,
  unseen_accessed: false,
  bindings: {
    item_register_sha256: itemRegisterSha256,
    full_source_register_sha256: sourceRegisterSha256,
    compact_evidence_map_sha256: compactMapSha256,
    reviewed_recommendations_sha256: recommendationsSha256,
  },
  counts: {
    expected_mappings: 68,
    reviewed_mappings: passed ? 68 : provisionalDecisions.length,
    retained_complete: passed ? 68 : 0,
    unresolved: passed ? 0 : findings.length,
  },
  decisions: passed
    ? provisionalDecisions
    : provisionalDecisions.map((decision) => ({
        ...decision,
        decision: `blocked_${decision.support_relationship}_pending_substantive_retention_repair`,
        passed: false,
      })),
  findings,
  limitation:
    "Owner-authorised developer substantive-retention audit only. It is not independent legal review, does not authorise training or release, and did not access sealed unseen material.",
};

const markdownLines = [
  "# Wave 3 compact substantive-retention audit",
  "",
  `Status: **${result.status}**`,
  "",
  "This audit checks all 68 Wave 3 proposition mappings against hash-bound parent-source spans that were substantively reviewed before the final compact rebuild. It is an owner-authorised developer evidence-retention check only.",
  "",
  `- Passed: ${result.passed}`,
  `- Reviewed mappings: ${result.counts.reviewed_mappings} / 68`,
  `- Retained complete: ${result.counts.retained_complete} / 68`,
  `- Unresolved findings: ${result.counts.unresolved}`,
  "- Training authorised: false",
  "- Release authorised: false",
  "- Independent legal review: false",
  "- Unseen accessed: false",
  "",
  "## Immutable bindings",
  "",
  `- Item register SHA-256: \`${itemRegisterSha256}\``,
  `- Full source register SHA-256: \`${sourceRegisterSha256}\``,
  `- Compact evidence map SHA-256: \`${compactMapSha256}\``,
  `- Reviewed recommendations SHA-256: \`${recommendationsSha256}\``,
  "",
];

if (findings.length > 0) {
  markdownLines.push("## Blocking findings", "");
  for (const finding of findings) {
    markdownLines.push(
      `- ${finding.training_id || "global"}: \`${finding.code}\` — ${finding.detail}`,
    );
  }
  markdownLines.push("");
} else {
  markdownLines.push(
    "## Mapping decisions",
    "",
    "| # | Training ID | Proposition | Relationship | Final excerpts | Decision |",
    "| -: | --- | --- | --- | --- | --- |",
  );
  provisionalDecisions.forEach((decision, index) => {
    const proposition = decision.proposition
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
    markdownLines.push(
      `| ${index + 1} | \`${decision.training_id}\` | ${proposition} | \`${decision.support_relationship}\` | ${decision.excerpt_ids.map((id) => `\`${id}\``).join(", ")} | retained complete |`,
    );
  });
  markdownLines.push("");
}

markdownLines.push(
  "## Limitations",
  "",
  "This artifact does not constitute independent legal review, training approval, release approval, or sealed-unseen evaluation. All such gates remain separate and fail closed.",
  "",
);

fs.mkdirSync(auditDirectory, { recursive: true });
fs.writeFileSync(outputJsonPath, `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(outputMarkdownPath, `${markdownLines.join("\n")}\n`);

console.log(
  JSON.stringify(
    {
      status: result.status,
      passed: result.passed,
      output_json: path.relative(workspaceRoot, outputJsonPath),
      output_json_sha256: sha256(fs.readFileSync(outputJsonPath)),
      output_markdown: path.relative(workspaceRoot, outputMarkdownPath),
      output_markdown_sha256: sha256(fs.readFileSync(outputMarkdownPath)),
      counts: result.counts,
      bindings: result.bindings,
    },
    null,
    2,
  ),
);

if (!passed) process.exitCode = 1;
