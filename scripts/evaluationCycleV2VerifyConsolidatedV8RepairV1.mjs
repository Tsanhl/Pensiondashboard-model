import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(
  process.env.TRAINING_REPAIR_V8_ROOT ||
    "training/evaluation-cycle-v2/22-training-data-double-check-v8-final-20260901",
);
const PREVIOUS_ROOT = resolve(
  process.env.TRAINING_REPAIR_V7_ROOT ||
    "training/evaluation-cycle-v2/18-training-data-double-check-v7-final-20260901",
);
const DEFECT_REGISTER_PATH = resolve(
  process.env.WAVE3_V8_DEFECT_REGISTER ||
    "training/evaluation-cycle-v2/19-cumulative-visible-qualification-v7-final-full-20260901/independent-agent-audits/wave-3-consolidated-upstream-defects-for-v8.json",
);
const WAVE2_RECOMMENDATIONS_PATH = resolve(
  process.env.WAVE2_RECOMMENDATIONS ||
    "training/evaluation-cycle-v2/19-cumulative-visible-qualification-v7-final-full-20260901/independent-agent-audits/wave-2-compact-substantive-retention-recommendations.provisional-v1.json",
);

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const canonicalSha256 = (value) => sha256(JSON.stringify(value));
const readBoundJson = (path) => {
  const bytes = readFileSync(path);
  return { bytes, sha256: sha256(bytes), data: JSON.parse(bytes) };
};
const sameSet = (left, right) => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const pack = readBoundJson(resolve(ROOT, "repaired-training-items-draft.json"));
const allocation = readBoundJson(resolve(ROOT, "global-allocation-draft.json"));
const preflight = readBoundJson(resolve(ROOT, "integrity-and-review-preflight.json"));
const previousPack = readBoundJson(
  resolve(PREVIOUS_ROOT, "repaired-training-items-draft.json"),
);
const defectRegister = readBoundJson(DEFECT_REGISTER_PATH);
const wave2Recommendations = readBoundJson(WAVE2_RECOMMENDATIONS_PATH);

const wave3Mappings = pack.data.items
  .filter((item) => item.wave === 3)
  .flatMap((item) =>
    item.proposition_source_candidates.map((mapping) => ({
      training_id: item.training_id,
      ...mapping,
    })),
  );

const acceptedPunctuationAdaptations = {
  65: {
    reason:
      "The composer treats semicolons as proposition boundaries. A comma-plus-'but' preserves the reviewed scope boundary as one material proposition and retains the audited 68-mapping Wave 3 cardinality.",
    proposition:
      "A death on 1 March 2027 is outside that commencement rule, but this does not resolve any liability under law applying before that date, which requires a separate facts-based check.",
    ideal_answer:
      "No, not under the new notional-pension-property rule merely because payment occurs after 6 April 2027. Section 66 of the Finance Act 2026 inserts section 150A into the Inheritance Tax Act 1984, and section 71 applies the change to deaths on or after 6 April 2027. A death on 1 March 2027 is outside that commencement rule, but this does not resolve any liability under law applying before that date, which requires a separate facts-based check.",
  },
};

const repairDecisions = defectRegister.data.repairs.map((repair) => {
  const actual = wave3Mappings[repair.mapping_index - 1];
  const item = pack.data.items.find(
    (candidate) => candidate.training_id === repair.training_id,
  );
  const adaptation = acceptedPunctuationAdaptations[repair.mapping_index];
  const expectedProposition = adaptation?.proposition || repair.proposed_proposition;
  const expectedAnswer = adaptation?.ideal_answer || repair.proposed_ideal_answer;
  const checks = {
    mapping_position_training_id:
      actual?.training_id === repair.training_id,
    proposition:
      actual?.proposition === expectedProposition,
    support_relationship:
      actual?.support_relationship === repair.proposed_support_relationship,
    source_ids: sameSet(actual?.source_ids || [], repair.proposed_source_ids || []),
    ideal_answer:
      !expectedAnswer || item?.ideal_answer === expectedAnswer,
  };
  return {
    mapping_index: repair.mapping_index,
    training_id: repair.training_id,
    proposition: actual?.proposition || null,
    proposition_sha256: actual?.proposition
      ? sha256(actual.proposition)
      : null,
    support_relationship: actual?.support_relationship || null,
    source_ids: actual?.source_ids || [],
    accepted_punctuation_adaptation: Boolean(adaptation),
    adaptation_reason: adaptation?.reason || null,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
});

const exactEvidenceUnionChecks = pack.data.items.map((item) => {
  const selected = item.retrieved_evidence.map((source) => source.source_id);
  const mapped = item.proposition_source_candidates.flatMap(
    (mapping) => mapping.source_ids,
  );
  return {
    training_id: item.training_id,
    passed: sameSet(selected, mapped),
    selected_source_ids: [...new Set(selected)].sort(),
    mapped_source_ids: [...new Set(mapped)].sort(),
  };
});

const previousWave2 = previousPack.data.items.filter((item) => item.wave === 2);
const currentWave2 = pack.data.items.filter((item) => item.wave === 2);
const previousWave2Sha256 = canonicalSha256(previousWave2);
const currentWave2Sha256 = canonicalSha256(currentWave2);
const changedWave3ItemIds = pack.data.items
  .filter((item) => item.wave === 3)
  .filter((item) => {
    const previous = previousPack.data.items.find(
      (candidate) => candidate.training_id === item.training_id,
    );
    return JSON.stringify(previous) !== JSON.stringify(item);
  })
  .map((item) => item.training_id)
  .sort();
const expectedChangedWave3ItemIds = [
  ...new Set(defectRegister.data.repairs.map((repair) => repair.training_id)),
].sort();

const checks = {
  defect_register_hash:
    defectRegister.sha256 ===
    "1848471fc9653fb4245cfa7a8753e88f23aeb38e82286c7fad46622441a62a99",
  defect_register_cardinality:
    defectRegister.data.repairs.length === 14,
  all_fourteen_repairs_applied:
    repairDecisions.length === 14 && repairDecisions.every((entry) => entry.passed),
  wave3_mapping_cardinality: wave3Mappings.length === 68,
  exact_evidence_union_all_items:
    exactEvidenceUnionChecks.length === 52 &&
    exactEvidenceUnionChecks.every((entry) => entry.passed),
  wave2_items_unchanged:
    previousWave2Sha256 === currentWave2Sha256,
  only_expected_wave3_items_changed: sameSet(
    changedWave3ItemIds,
    expectedChangedWave3ItemIds,
  ),
  pack_cardinality:
    pack.data.item_count === 52 && pack.data.items.length === 52,
  pack_version: pack.data.version === "wave4-repaired-training-items-draft-v8",
  allocation_version:
    allocation.data.version ===
    "wave4-local-wave2-wave3-training-validation-allocation-draft-v8",
  preflight_version:
    preflight.data.version ===
    "wave4-wave2-wave3-repair-integrity-preflight-v8",
  preflight_passed: preflight.data.passed === true,
  preflight_pack_binding:
    preflight.data.source_pack_sha256 === pack.sha256,
  preflight_allocation_binding:
    preflight.data.allocation_sha256 === allocation.sha256,
  no_unseen_access:
    pack.data.unseen_included === false &&
    pack.data.unseen_accessed === false &&
    allocation.data.unseen_included === false &&
    allocation.data.unseen_accessed === false &&
    preflight.data.unseen_accessed === false,
  no_training_or_release_authority:
    pack.data.training_authorised === false &&
    pack.data.release_authorised === false &&
    allocation.data.training_authorised === false &&
    allocation.data.release_authorised === false &&
    preflight.data.training_authorised === false,
  wave2_recommendations_complete_but_provisional:
    wave2Recommendations.data.counts?.reviewed_mappings === 127 &&
    wave2Recommendations.data.passed === false &&
    wave2Recommendations.data.training_authorised === false &&
    wave2Recommendations.data.unseen_accessed === false,
};

const passed = Object.values(checks).every(Boolean);
const report = {
  version: "wave2-wave3-consolidated-v8-repair-application-audit-v1",
  generated_at: new Date().toISOString(),
  status: passed
    ? "passed_owner_authorised_developer_source_scope_repair_application"
    : "blocked_consolidated_v8_repair_application",
  passed,
  training_authorised: false,
  release_authorised: false,
  independent_legal_review: false,
  unseen_accessed: false,
  bindings: {
    repaired_training_pack_path: resolve(
      ROOT,
      "repaired-training-items-draft.json",
    ),
    repaired_training_pack_sha256: pack.sha256,
    allocation_sha256: allocation.sha256,
    integrity_preflight_sha256: preflight.sha256,
    prior_v7_pack_sha256: previousPack.sha256,
    wave3_defect_register_sha256: defectRegister.sha256,
    wave2_recommendations_sha256: wave2Recommendations.sha256,
  },
  counts: {
    visible_items: pack.data.items.length,
    wave_2_items: currentWave2.length,
    wave_3_items: pack.data.items.filter((item) => item.wave === 3).length,
    wave_2_mappings: currentWave2.reduce(
      (total, item) => total + item.proposition_source_candidates.length,
      0,
    ),
    wave_3_mappings: wave3Mappings.length,
    repaired_wave_3_mappings: repairDecisions.length,
    exact_evidence_union_failures: exactEvidenceUnionChecks.filter(
      (entry) => !entry.passed,
    ).length,
  },
  wave_2_retention: {
    prior_items_sha256: previousWave2Sha256,
    current_items_sha256: currentWave2Sha256,
    unchanged: previousWave2Sha256 === currentWave2Sha256,
  },
  changed_wave_3_item_ids: changedWave3ItemIds,
  repair_decisions: repairDecisions,
  exact_evidence_union_failures: exactEvidenceUnionChecks.filter(
    (entry) => !entry.passed,
  ),
  checks,
  limitation:
    "This verifies application of the owner-authorised developer/source-scope repair register to visible Wave 2–3 data. It is not independent legal review, does not access sealed unseen material, and does not authorise training or release.",
};

writeFileSync(
  resolve(ROOT, "consolidated-v8-repair-application-audit.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
if (!passed) {
  throw new Error(
    `Consolidated v8 repair audit failed: ${JSON.stringify(checks)}`,
  );
}
console.log(
  JSON.stringify(
    {
      passed,
      repairs: repairDecisions.length,
      wave_2_unchanged: checks.wave2_items_unchanged,
      exact_evidence_union_failures:
        report.counts.exact_evidence_union_failures,
      output: resolve(ROOT, "consolidated-v8-repair-application-audit.json"),
    },
    null,
    2,
  ),
);
