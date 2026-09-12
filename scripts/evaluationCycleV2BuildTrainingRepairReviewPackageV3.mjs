import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, resolve } from "node:path";

const WORKSPACE = resolve(".");
const SOURCE_ROOT = resolve(
  process.env.TRAINING_REPAIR_REVIEW_SOURCE_ROOT ||
    "training/evaluation-cycle-v2/07-training-data-double-check-v3-20260901",
);
const OUTPUT_ROOT = resolve(
  process.env.TRAINING_REPAIR_REVIEW_OUT ||
    "wave4-wave2-wave3-double-check-final-review-v3-2026-09-01",
);
const ZIP_PATH = resolve(
  process.env.TRAINING_REPAIR_REVIEW_ZIP || `${OUTPUT_ROOT}.zip`,
);
const V1_DATASET_ROOT = resolve(
  process.env.TRAINING_REPAIR_V1_DATASET_ROOT ||
    "training-data/private/evaluation-cycle-v1-lora",
);
const BASELINE_ROOT = resolve(
  process.env.TRAINING_REPAIR_BASELINE_ROOT ||
    "training/evaluation-cycle-v2/06-training-data-repair-revision-v2-20260901",
);
const CHANGE_FEED_CANDIDATES = process.env.TRAINING_REPAIR_SECOND_PASS_CHANGES
  ? [resolve(process.env.TRAINING_REPAIR_SECOND_PASS_CHANGES)]
  : [
      resolve(SOURCE_ROOT, "second-pass-change-register.json"),
      resolve(SOURCE_ROOT, "SECOND-PASS-CHANGE-REGISTER.json"),
      resolve(SOURCE_ROOT, "second-pass-change-register.md"),
      resolve(SOURCE_ROOT, "SECOND-PASS-CHANGE-REGISTER.md"),
    ];
const CHANGE_FEED_PATH = CHANGE_FEED_CANDIDATES.find((path) => existsSync(path)) || null;

const LEGACY_V2_OUTPUT = resolve(
  "wave4-wave2-wave3-repair-review-v2-2026-09-01",
);
const LEGACY_V2_ZIP = `${LEGACY_V2_OUTPUT}.zip`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileSha = (path) => sha256(readFileSync(path));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const stripCitations = (value) =>
  String(value).replace(/\s*\{\{cite:[^}]+\}\}/g, "").trim();
const uniqueSorted = (values) => [...new Set(values)].sort();
const intersection = (left, right) => {
  const rightSet = new Set(right);
  return uniqueSorted(left.filter((value) => rightSet.has(value)));
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const tableText = (value) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();

function assertSafePaths() {
  if (!existsSync(SOURCE_ROOT) || !statSync(SOURCE_ROOT).isDirectory()) {
    throw new Error(`Review source root does not exist: ${SOURCE_ROOT}`);
  }
  if (OUTPUT_ROOT === SOURCE_ROOT || OUTPUT_ROOT === WORKSPACE || OUTPUT_ROOT === "/") {
    throw new Error("Refusing to use a source, workspace, or filesystem root as package output");
  }
  if (OUTPUT_ROOT === LEGACY_V2_OUTPUT || ZIP_PATH === LEGACY_V2_ZIP) {
    throw new Error("Refusing to overwrite the preserved v2 review package");
  }
  if (ZIP_PATH === OUTPUT_ROOT || ZIP_PATH === WORKSPACE || ZIP_PATH === "/") {
    throw new Error("Unsafe ZIP output path");
  }
}

function parseJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error.message}`);
      }
    });
}

function parseV1Record(record, partition) {
  const userMessage = asArray(record.messages).find((message) => message.role === "user");
  if (!userMessage) throw new Error("v1 record is missing its user message");
  let payload;
  try {
    payload = JSON.parse(userMessage.content);
  } catch (error) {
    throw new Error(`v1 user payload is not JSON: ${error.message}`);
  }
  const trainingId = record.metadata?.training_id;
  if (!trainingId) throw new Error("v1 record is missing metadata.training_id");
  return {
    training_id: trainingId,
    partition,
    question: String(payload.question || ""),
    capability: record.metadata?.capability || null,
    sources: asArray(payload.evidence).map((source) => ({
      source_id: source.source_id,
      content_sha256: sha256(String(source.text || "")),
    })),
  };
}

function parseCurrentRecord(item, partition) {
  return {
    training_id: item.training_id,
    partition,
    question: String(item.user_question || ""),
    construct_id: item.construct_id || null,
    sources: asArray(item.retrieved_evidence).map((source) => ({
      source_id: source.source_id,
      content_sha256:
        source.content_sha256 || sha256(String(source.passage_text || source.text || "")),
    })),
  };
}

function inventory(records) {
  return {
    record_ids: records.map((record) => record.training_id),
    source_ids: records.flatMap((record) => record.sources.map((source) => source.source_id)),
    source_text_sha256: records.flatMap((record) =>
      record.sources.map((source) => source.content_sha256),
    ),
  };
}

function compareInventories(left, right) {
  const leftInventory = inventory(left);
  const rightInventory = inventory(right);
  return {
    record_id_overlap: intersection(leftInventory.record_ids, rightInventory.record_ids),
    source_id_overlap: intersection(leftInventory.source_ids, rightInventory.source_ids),
    source_text_sha256_overlap: intersection(
      leftInventory.source_text_sha256,
      rightInventory.source_text_sha256,
    ),
  };
}

function buildCumulativeAudit(pack, allocation, audit) {
  const manifestPath = resolve(V1_DATASET_ROOT, "dataset-manifest.json");
  const trainPath = resolve(V1_DATASET_ROOT, "train.jsonl");
  const validationPath = resolve(V1_DATASET_ROOT, "valid.jsonl");
  for (const path of [manifestPath, trainPath, validationPath]) {
    if (!existsSync(path)) throw new Error(`Missing v1 cumulative-history input: ${path}`);
  }

  const v1Manifest = readJson(manifestPath);
  const v1Train = parseJsonl(trainPath).map((record) => parseV1Record(record, "v1_train"));
  const v1Validation = parseJsonl(validationPath).map((record) =>
    parseV1Record(record, "v1_validation"),
  );
  const itemById = new Map(pack.items.map((item) => [item.training_id, item]));
  const currentTrain = allocation.train.ids.map((id) => {
    const item = itemById.get(id);
    if (!item) throw new Error(`Allocation references unknown training item: ${id}`);
    return parseCurrentRecord(item, "proposed_wave_2_3_train");
  });
  const currentValidation = allocation.validation.ids.map((id) => {
    const item = itemById.get(id);
    if (!item) throw new Error(`Allocation references unknown validation item: ${id}`);
    return parseCurrentRecord(item, "proposed_wave_2_3_validation");
  });

  const v1HashChecks = {
    train_jsonl: {
      expected_sha256: v1Manifest.train?.sha256 || null,
      actual_sha256: fileSha(trainPath),
    },
    validation_jsonl: {
      expected_sha256: v1Manifest.validation?.sha256 || null,
      actual_sha256: fileSha(validationPath),
    },
  };
  for (const check of Object.values(v1HashChecks)) {
    check.matches_manifest = Boolean(
      check.expected_sha256 && check.expected_sha256 === check.actual_sha256,
    );
  }

  const allVisibleRecords = [
    ...v1Train,
    ...v1Validation,
    ...currentTrain,
    ...currentValidation,
  ];
  const knownIds = new Set(allVisibleRecords.map((record) => record.training_id));
  const recordById = new Map(allVisibleRecords.map((record) => [record.training_id, record]));
  const expectedRecordCount =
    v1Train.length + v1Validation.length + currentTrain.length + currentValidation.length;
  if (
    v1Manifest.train?.count !== v1Train.length ||
    v1Manifest.validation?.count !== v1Validation.length
  ) {
    throw new Error("v1 JSONL record counts do not match the v1 dataset manifest");
  }
  if (!Object.values(v1HashChecks).every((check) => check.matches_manifest)) {
    throw new Error("v1 JSONL hashes do not match the v1 dataset manifest");
  }
  if (knownIds.size !== expectedRecordCount) {
    throw new Error("Visible cumulative history contains duplicate training IDs");
  }

  const semanticPairCandidates = [
    {
      historical_v1_ids: ["train-cite-009"],
      wave_2_3_ids: ["v2-w2-t04-train-005"],
      review_reason: "survivor-benefit and equality rule family",
    },
    {
      historical_v1_ids: ["train-cite-013"],
      wave_2_3_ids: ["v2-w2-t04-train-006"],
      review_reason: "Northern Ireland territorial-routing rule family",
    },
    {
      historical_v1_ids: ["train-scam-016"],
      wave_2_3_ids: ["v2-w2-t02-train-005"],
      review_reason: "pension-investment and diversification duty family",
    },
    {
      historical_v1_ids: ["train-cite-007"],
      wave_2_3_ids: ["v2-w2-t01-train-006"],
      review_reason: "safeguarded-benefit advice checkpoint family",
    },
  ];
  const visibleQuestionRiskCandidates = semanticPairCandidates.flatMap((entry) => {
    if (![...entry.historical_v1_ids, ...entry.wave_2_3_ids].every((id) => knownIds.has(id))) {
      return [];
    }
    const historicalPartitions = uniqueSorted(
      entry.historical_v1_ids.map((id) => recordById.get(id).partition),
    );
    const currentPartitions = uniqueSorted(
      entry.wave_2_3_ids.map((id) => recordById.get(id).partition),
    );
    let direction = null;
    if (
      historicalPartitions.includes("v1_validation") &&
      currentPartitions.includes("proposed_wave_2_3_train")
    ) {
      direction = "later_training_may_retire_historical_validation";
    } else if (
      historicalPartitions.includes("v1_train") &&
      currentPartitions.includes("proposed_wave_2_3_validation")
    ) {
      direction = "historical_training_may_preexpose_new_validation";
    }
    return direction ? [{ ...entry, direction }] : [];
  });

  return {
    version: "wave4-wave2-wave3-cumulative-training-history-audit-v3",
    generated_at: new Date().toISOString(),
    status: "not_globally_qualified",
    purpose: "visible_history_review_only",
    training_authorised: false,
    release_authorised: false,
    unseen_included: false,
    unseen_accessed: false,
    conclusion: {
      local_wave_2_3_machine_isolation_passed: Boolean(
        audit.passed && allocation.isolation?.passed,
      ),
      cumulative_global_qualification_passed: false,
      statement: `The proposed ${currentTrain.length} train / ${currentValidation.length} validation allocation is locally assessed only within the visible Wave 2–3 candidate records. It is not a globally qualified split across v1, cumulative training history, protected regressions or sealed unseen material.`,
    },
    visible_history: {
      v1_train: v1Train.length,
      v1_validation: v1Validation.length,
      proposed_wave_2_3_train: currentTrain.length,
      proposed_wave_2_3_validation: currentValidation.length,
      total_visible_records: expectedRecordCount,
      unique_record_ids: knownIds.size,
    },
    v1_dataset_manifest: {
      version: v1Manifest.version,
      status: v1Manifest.status,
      split_policy: v1Manifest.split_policy,
      manifest_sha256: fileSha(manifestPath),
      file_hash_checks: v1HashChecks,
    },
    exact_identity_checks: {
      limitation:
        "These checks detect exact record IDs, exact source IDs and exact passage-text hashes only. Zero exact overlap does not establish semantic or canonical-authority independence.",
      historical_v1_train_vs_proposed_wave_2_3_validation: compareInventories(
        v1Train,
        currentValidation,
      ),
      proposed_wave_2_3_train_vs_historical_v1_validation: compareInventories(
        currentTrain,
        v1Validation,
      ),
      combined_candidate_train_vs_combined_candidate_validation: compareInventories(
        [...v1Train, ...currentTrain],
        [...v1Validation, ...currentValidation],
      ),
    },
    visible_question_semantic_review_candidates: {
      exhaustive: false,
      adjudicated: false,
      entries: visibleQuestionRiskCandidates,
    },
    unresolved_global_controls: [
      "v1 exports do not carry canonical authority-family identities compatible with the Wave 2–3 graph",
      "v1 and Wave 2–3 records do not yet have one independently approved substantive-construct taxonomy",
      "visible-question review has identified plausible cross-history semantic overlaps that may retire old validation or pre-expose new validation",
      "the clean starting checkpoint and its complete training lineage have not been requalified",
      "the authorised custodian has not compared the candidate with protected regression and sealed unseen constructs",
      "the actual rendered cumulative export, token lengths and loss masks have not been verified",
    ],
    acceptable_next_designs: [
      "Start from the original base model and independently review a fully cumulative repartition of all approved visible records.",
      "Or explicitly retire affected historical validation evidence and create a fresh independently approved validation set before training.",
    ],
    prohibited_inference: `Do not treat local ${currentTrain.length}/${currentValidation.length} isolation, v1 file-hash integrity or zero exact-identity overlap as authority to train or as clean qualification evidence.`,
  };
}

function renderCumulativeAudit(report) {
  const localTrainCount = report.visible_history.proposed_wave_2_3_train;
  const localValidationCount = report.visible_history.proposed_wave_2_3_validation;
  const localIsolationText = report.conclusion.local_wave_2_3_machine_isolation_passed
    ? "passed its local machine isolation check"
    : "has not passed its local machine isolation check";
  const exact = report.exact_identity_checks;
  const rows = Object.entries(exact)
    .filter(([, value]) => typeof value === "object")
    .map(([name, value]) =>
      `| ${name.replaceAll("_", " ")} | ${value.record_id_overlap.length} | ${value.source_id_overlap.length} | ${value.source_text_sha256_overlap.length} |`,
    );
  const riskRows = report.visible_question_semantic_review_candidates.entries.map(
    (entry) =>
      `| ${entry.direction.replaceAll("_", " ")} | ${entry.historical_v1_ids.map((id) => `\`${id}\``).join(", ")} | ${entry.wave_2_3_ids.map((id) => `\`${id}\``).join(", ")} | ${entry.review_reason} |`,
  );
  return `# Cumulative training-history audit

Status: **not globally qualified**. This is a visible-history review artifact, not training authority.

The current **${localTrainCount} train / ${localValidationCount} validation** Wave 2–3 proposal ${localIsolationText}. It has **not** established independence across v1 or the complete cumulative training history. Sealed unseen content was not included or accessed.

## Visible history inspected

| Partition | Records |
| --- | ---: |
| v1 historical train | ${report.visible_history.v1_train} |
| v1 historical validation | ${report.visible_history.v1_validation} |
| Wave 2–3 proposed train | ${report.visible_history.proposed_wave_2_3_train} |
| Wave 2–3 proposed validation | ${report.visible_history.proposed_wave_2_3_validation} |
| **Total visible records** | **${report.visible_history.total_visible_records}** |

Both v1 JSONL hashes match their recorded manifest: **${Object.values(report.v1_dataset_manifest.file_hash_checks).every((check) => check.matches_manifest) ? "yes" : "no"}**. This confirms file identity only; it does not approve the v1 checkpoint or the cumulative split.

## Exact-identity checks

${exact.limitation}

| Comparison | Record-ID overlap | Source-ID overlap | Passage-hash overlap |
| --- | ---: | ---: | ---: |
${rows.join("\n")}

## Visible semantic risks requiring adjudication

This list is **non-exhaustive and not an adjudicated construct map**. It identifies visible-question pairs that make a global pass unsafe without a human-approved taxonomy.

| Direction | Historical v1 | Wave 2–3 | Review reason |
| --- | --- | --- | --- |
${riskRows.length ? riskRows.join("\n") : "| None auto-listed | — | — | A complete semantic review is still required |"}

## Why the global gate fails

${report.unresolved_global_controls.map((item) => `- ${item}`).join("\n")}

## Safe next design

${report.acceptable_next_designs.map((item) => `- ${item}`).join("\n")}

**Do not treat the local ${localTrainCount}/${localValidationCount} result, the v1 hash check, or zero exact overlap as authority to train.**
`;
}

function buildChangeRegister(pack) {
  const baselinePath = resolve(BASELINE_ROOT, "repaired-training-items-draft.json");
  let machineDiff = [];
  let baseline = {
    available: false,
    path: BASELINE_ROOT,
    pack_sha256: null,
  };
  if (existsSync(baselinePath)) {
    const previousPack = readJson(baselinePath);
    const priorById = new Map(asArray(previousPack.items).map((item) => [item.training_id, item]));
    machineDiff = pack.items.flatMap((item) => {
      const prior = priorById.get(item.training_id);
      if (!prior) {
        return [{ training_id: item.training_id, changes: ["new_record"] }];
      }
      const changes = [];
      if (item.user_question !== prior.user_question) changes.push("question_changed");
      if (item.ideal_answer !== prior.ideal_answer) changes.push("answer_changed");
      if (item.construct_id !== prior.construct_id) changes.push("construct_changed");
      if (
        JSON.stringify(item.proposition_source_candidates) !==
        JSON.stringify(prior.proposition_source_candidates || prior.proposition_review)
      ) {
        changes.push("proposition_map_changed");
      }
      if (item.legal_rule_id !== prior.legal_rule_id) changes.push("legal_rule_id_changed");
      const currentSources = uniqueSorted(
        asArray(item.retrieved_evidence).map((source) => source.source_id),
      );
      const priorSources = uniqueSorted(
        asArray(prior.retrieved_evidence).map((source) => source.source_id),
      );
      const added = currentSources.filter((id) => !priorSources.includes(id));
      const removed = priorSources.filter((id) => !currentSources.includes(id));
      if (added.length) changes.push("sources_added");
      if (removed.length) changes.push("sources_removed");
      return changes.length
        ? [{
            training_id: item.training_id,
            changes,
            source_ids_added: added,
            source_ids_removed: removed,
          }]
        : [];
    });
    baseline = {
      available: true,
      path: BASELINE_ROOT,
      pack_sha256: fileSha(baselinePath),
    };
  }

  let feed = null;
  if (CHANGE_FEED_PATH && existsSync(CHANGE_FEED_PATH)) {
    const extension = extname(CHANGE_FEED_PATH).toLowerCase();
    if (extension === ".json") {
      const parsed = readJson(CHANGE_FEED_PATH);
      feed = Array.isArray(parsed)
        ? { version: null, complete: false, changes: parsed, format: "json" }
        : {
            version: parsed.version || null,
            complete: parsed.complete === true,
            changes: asArray(parsed.changes),
            format: "json",
          };
    } else if (extension === ".md") {
      feed = {
        version: null,
        complete: false,
        changes: [],
        format: "markdown",
      };
    } else {
      throw new Error(`Unsupported second-pass change-register format: ${CHANGE_FEED_PATH}`);
    }
  }
  const sourceCopyName = feed
    ? `SECOND-PASS-CHANGE-REGISTER-SUPPLIED${extname(CHANGE_FEED_PATH).toLowerCase()}`
    : null;
  return {
    version: "wave4-wave2-wave3-second-pass-change-register-v3",
    generated_at: new Date().toISOString(),
    status: feed?.complete
      ? "curated_feed_supplied"
      : feed
        ? "supplied_register_pending_independent_completion"
        : "scaffold_pending_curated_completion",
    training_authorised: false,
    unseen_included: false,
    unseen_accessed: false,
    curated_feed: {
      supplied: Boolean(feed),
      complete: Boolean(feed?.complete),
      source_path: feed ? CHANGE_FEED_PATH : null,
      source_format: feed?.format || null,
      source_sha256: feed ? fileSha(CHANGE_FEED_PATH) : null,
      packaged_copy: sourceCopyName,
      source_version: feed?.version || null,
      changes: feed?.changes || [],
    },
    machine_field_diff: {
      baseline,
      changed_item_count: machineDiff.length,
      unchanged_item_count: pack.item_count - machineDiff.length,
      entries: machineDiff,
      limitation:
        "This is a field-level comparison only. It cannot establish that a legal answer or its evidence is correct.",
    },
    reviewer_instruction:
      "Use the curated entries and machine diff as navigation aids only; review every retained proposition and full source passage independently.",
  };
}

function renderChangeRegister(register) {
  const suppliedRegisterNote = register.curated_feed.supplied
    ? register.curated_feed.source_format === "json"
      ? `Second-pass register supplied: **yes** (JSON); explicitly marked complete in that input: **${register.curated_feed.complete ? "yes" : "no"}**. The exact supplied file is preserved as \`${register.curated_feed.packaged_copy}\`.`
      : `Second-pass register supplied: **yes** (Markdown). No machine-readable completion flag is inferred. The exact supplied file is preserved as \`${register.curated_feed.packaged_copy}\`.`
    : "No second-pass change register was supplied to the packaging step. The section below is therefore a clear scaffold, not evidence that no repairs were made.";
  const curatedRows = register.curated_feed.changes.map((entry, index) => {
    const ids = asArray(entry.training_ids).length
      ? entry.training_ids
      : asArray(entry.item_ids).length
      ? entry.item_ids
      : entry.item_id
        ? [entry.item_id]
        : entry.training_id
          ? [entry.training_id]
          : [];
    return `| ${index + 1} | ${ids.map((id) => `\`${id}\``).join(", ") || "—"} | ${tableText(entry.issue || entry.finding || entry.reason) || "—"} | ${tableText(entry.amendment || entry.change || entry.repair) || "—"} | ${tableText(entry.verification || entry.status) || "pending independent review"} |`;
  });
  const diffRows = register.machine_field_diff.entries.map(
    (entry) =>
      `| \`${entry.training_id}\` | ${entry.changes.join(", ")} | ${asArray(entry.source_ids_added).map((id) => `\`${id}\``).join(", ") || "—"} | ${asArray(entry.source_ids_removed).map((id) => `\`${id}\``).join(", ") || "—"} |`,
  );
  return `# Second-pass change register

Status: **${register.status.replaceAll("_", " ")}**. This register does not approve any item for training.

${suppliedRegisterNote}

## Curated legal/evidence amendments

| # | Item(s) | Issue | Amendment | Verification |
| ---: | --- | --- | --- | --- |
${curatedRows.length ? curatedRows.join("\n") : "| — | — | Curated legal rationale not supplied | Add the independent second-pass findings and resulting amendment | pending |"}

## Machine-detected field changes from preserved v2

Baseline available: **${register.machine_field_diff.baseline.available ? "yes" : "no"}**
Changed records detected: **${register.machine_field_diff.changed_item_count}**
Unchanged records detected: **${register.machine_field_diff.unchanged_item_count}**

| Item | Changed fields | Source IDs added | Source IDs removed |
| --- | --- | --- | --- |
${diffRows.length ? diffRows.join("\n") : "| — | No field changes detected against the configured baseline | — | — |"}

${register.machine_field_diff.limitation} ${register.reviewer_instruction}
`;
}

function renderStatusDocument(cumulativeAudit) {
  const localTrainCount = cumulativeAudit.visible_history.proposed_wave_2_3_train;
  const localValidationCount = cumulativeAudit.visible_history.proposed_wave_2_3_validation;
  return `# Current evaluation, training and unseen status

Review date: **1 September 2026**

## Evaluation — current step

**Visible Wave 2–3 replacement-data double-check and independent review.** The historical Wave 2–3 adapters and answer-containing validation inputs are preserved for audit, but their results are not clean qualification evidence. The proposed ${localTrainCount}/${localValidationCount} allocation is only a local Wave 2–3 candidate; it is not globally approved across the ${cumulativeAudit.visible_history.total_visible_records} visible v1 plus Wave 2–3 records.

After all 52 revised answers and full evidence passages are independently approved, approve a cumulative split and then run visible qualification gates: critical safety cases, the retained 69-case regression suite, and the approved topic/Wave 4 diagnostic slices. Existing gold suites should remain as regression assets; new topic suites supplement rather than silently replace them.

## Training — current step

**Not started and not authorised.** The project is still at replacement-data, evidence and validation-design review. Before any replacement run:

1. Approve each visible answer and proposition-to-source mapping.
2. Approve a globally checked cumulative train/validation design or formally retire affected historical validation items and create a fresh holdout.
3. Verify the actual rendered export, token lengths and loss masks.
4. Verify the clean starting checkpoint and its full provenance.
5. Obtain separate training authorisation and run a new versioned replacement job.

## Sealed unseen — current step

**Excluded, sealed and not accessed by this packaging process.** Do not run unseen while answers, evidence, allocation or visible gates are still changing. After a candidate passes visible gates, freeze its model, runtime, prompt, renderer, retrieval corpus and scoring rules. Then the authorised custodian may run the independently approved sealed unseen set once. Any unseen item used for repair must be retired from unseen status and replaced with a fresh sealed holdout.

## Release

Release remains blocked until the visible qualification gates and the separately authorised sealed unseen evaluation both pass, followed by a distinct release decision.
`;
}

function renderResponseRegister(cumulativeAudit) {
  const localTrainCount = cumulativeAudit.visible_history.proposed_wave_2_3_train;
  const localValidationCount = cumulativeAudit.visible_history.proposed_wave_2_3_validation;
  return `# Repair response and decision register

Status: **second-pass developer candidate; independent legal approval still required**. Training, unseen scoring and release remain blocked.

| Control | Current position | Decision required |
| --- | --- | --- |
| Historical answer-in-input leakage | Historical Wave 2–3 data, weights and results remain preserved but disqualified as clean qualification evidence. Candidate replacement records must retain question-only model inputs. | Confirm the actual rendered export and loss masks before training. |
| Answer and evidence repairs | The 52 candidate records and full selected passages are provided for proposition-level review. | Approve or return every proposition; source membership alone is not support. |
| Wave 2–3 ${localTrainCount}/${localValidationCount} allocation | Assessed only within the current Wave 2–3 graph; this is not cumulative qualification. | Do not approve globally until v1/cumulative constructs and canonical authorities are reconciled. |
| Cumulative history | Exact visible-identity checks are recorded, together with unresolved semantic risks. | Approve a full cumulative design or retire affected historical validation and create a fresh holdout. |
| Protected material | No sealed unseen content is included or accessed. | Authorised custodian must compare constructs without disclosing protected questions or answers. |
| Training | Not started; no checkpoint is selected by this package. | Separate authorisation only after data, split, export and checkpoint preflight. |
| Release | Blocked. | Separate decision after visible gates and one-shot sealed unseen pass. |
`;
}

function buildPackage() {
  assertSafePaths();
  const packPath = resolve(SOURCE_ROOT, "repaired-training-items-draft.json");
  const allocationPath = resolve(SOURCE_ROOT, "global-allocation-draft.json");
  const auditPath = resolve(SOURCE_ROOT, "integrity-and-review-preflight.json");
  for (const path of [packPath, allocationPath, auditPath]) {
    if (!existsSync(path)) throw new Error(`Missing review input: ${path}`);
  }
  const pack = readJson(packPath);
  const allocation = readJson(allocationPath);
  const audit = readJson(auditPath);
  const localTrainIds = asArray(allocation.train?.ids);
  const localValidationIds = asArray(allocation.validation?.ids);
  const localTrainCount = allocation.train?.count;
  const localValidationCount = allocation.validation?.count;
  const localAllocationShapeValid =
    Number.isInteger(localTrainCount) &&
    Number.isInteger(localValidationCount) &&
    localValidationCount >= 8 &&
    localValidationCount <= 12 &&
    localTrainCount + localValidationCount === 52 &&
    localTrainIds.length === localTrainCount &&
    localValidationIds.length === localValidationCount &&
    (allocation.isolation?.train_count === undefined ||
      allocation.isolation.train_count === localTrainCount) &&
    (allocation.isolation?.validation_count === undefined ||
      allocation.isolation.validation_count === localValidationCount);

  if (
    !audit.passed ||
    pack.item_count !== 52 ||
    audit.counts?.wave_2 !== 33 ||
    audit.counts?.wave_3 !== 19 ||
    !localAllocationShapeValid
  ) {
    throw new Error(
      "Refusing to package a failed or incomplete 52-item review preflight; local validation must contain 8–12 items and the train/validation counts must cover all 52 records",
    );
  }
  if (
    pack.training_authorised !== false ||
    pack.unseen_accessed !== false ||
    allocation.training_authorised !== false ||
    allocation.unseen_accessed !== false ||
    audit.training_authorised !== false ||
    audit.unseen_accessed !== false
  ) {
    throw new Error("Review inputs must explicitly deny training authority and unseen access");
  }
  const allIds = pack.items.map((item) => item.training_id);
  if (new Set(allIds).size !== 52) throw new Error("Training IDs are not unique");
  const allocatedIds = [...localTrainIds, ...localValidationIds];
  if (
    new Set(allocatedIds).size !== 52 ||
    allocatedIds.some((id) => !allIds.includes(id)) ||
    allIds.some((id) => !allocatedIds.includes(id))
  ) {
    throw new Error("The proposed allocation does not cover the 52 items exactly once");
  }

  rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  mkdirSync(OUTPUT_ROOT, { recursive: true });

  const partitionById = new Map([
    ...localTrainIds.map((id) => [id, "proposed_train"]),
    ...localValidationIds.map((id) => [id, "proposed_validation"]),
  ]);
  const sourceMap = new Map();
  for (const item of pack.items) {
    for (const source of item.retrieved_evidence) {
      const existing = sourceMap.get(source.source_id);
      if (existing && existing.content_sha256 !== source.content_sha256) {
        throw new Error(`Source ID ${source.source_id} has inconsistent content`);
      }
      if (!existing) sourceMap.set(source.source_id, { ...source, used_by: [] });
      sourceMap.get(source.source_id).used_by.push(item.training_id);
    }
  }
  const curatorSummarySourceCount = [...sourceMap.values()].filter(
    (source) =>
      source.text_origin ===
      "curator_summary_of_official_source_pending_verbatim_replacement",
  ).length;
  const unmappedLexicalCandidateCount = pack.items
    .flatMap((item) => item.proposition_source_candidates || [])
    .filter((entry) => !entry.source_ids?.length).length;
  const sourceRegister = {
    version: "wave4-wave2-wave3-selected-source-register-v3",
    generated_at: new Date().toISOString(),
    status: "selected_evidence_pending_independent_proposition_review",
    training_authorised: false,
    release_authorised: false,
    unseen_included: false,
    unseen_accessed: false,
    source_count: sourceMap.size,
    curator_summary_source_count_pending_verbatim_replacement: curatorSummarySourceCount,
    sources: [...sourceMap.values()].sort((a, b) => a.source_id.localeCompare(b.source_id)),
  };
  writeJson(resolve(OUTPUT_ROOT, "SOURCE-EVIDENCE-REGISTER.json"), sourceRegister);

  const itemReview = [
    "# Wave 2–3: 52-item second-pass answer and evidence review",
    "",
    "> Review-only. These are developer-revised candidate records, not approved training data. No sealed unseen question or answer is included.",
    "",
    `Items: **${pack.item_count}** (Wave 2: **${audit.counts.wave_2}**; Wave 3: **${audit.counts.wave_3}**)  `,
    `Local candidate allocation: **${allocation.train.count} train / ${allocation.validation.count} validation** — **not globally qualified**  `,
    `Selected evidence sources: **${sourceRegister.source_count}**; curator summaries still requiring verbatim-source replacement: **${curatorSummarySourceCount}**  `,
    `Lexical proposition candidates with no source match: **${unmappedLexicalCandidateCount}**`,
    "",
    "For each proposition, the listed source set is a candidate mapping for independent review. Confirm exact support against the selected source records in `SOURCE-EVIDENCE-REGISTER.json`; citation membership and machine preflight are not legal approval. A record labelled `curator_summary_of_official_source_pending_verbatim_replacement` cannot be approved until it is replaced with a verified verbatim official passage.",
    "",
  ];
  for (const wave of [2, 3]) {
    itemReview.push(`# Wave ${wave}`, "");
    for (const item of pack.items.filter((entry) => entry.wave === wave)) {
      itemReview.push(`## ${item.training_id}`, "");
      itemReview.push(`- Construct: \`${item.construct_id}\``);
      itemReview.push(`- Previous partition: \`${item.previous_partition}\``);
      itemReview.push(`- Local proposed partition: \`${partitionById.get(item.training_id)}\``);
      itemReview.push(`- Repair basis: \`${item.repair_basis}\``);
      itemReview.push(
        "",
        `**Question:** ${item.user_question}`,
        "",
        `**Revised answer:** ${stripCitations(item.ideal_answer)}`,
        "",
      );
      itemReview.push("**Selected evidence:**", "");
      for (const source of item.retrieved_evidence) {
        const territorial = source.territorial_effective_dates
          ? ` — GB ${source.territorial_effective_dates.great_britain}; NI ${source.territorial_effective_dates.northern_ireland}`
          : "";
        itemReview.push(
          `- \`${source.source_id}\` — [${source.title}](${source.source_url}), ${source.section}; ${source.jurisdiction}; source snapshot ${source.source_snapshot_as_of}${source.provision_effective_from ? `; provision effective from ${source.provision_effective_from}` : ""}${territorial}; text origin \`${source.text_origin || "not_recorded"}\`; SHA-256 \`${source.content_sha256}\``,
        );
      }
      itemReview.push("", "**Lexical proposition/source candidates (triage only; not a support determination):**", "");
      for (const [index, entry] of item.proposition_source_candidates.entries()) {
        itemReview.push(`${index + 1}. ${entry.proposition}`);
        itemReview.push(
          `   - Candidate sources: ${entry.source_ids.length ? entry.source_ids.map((id) => `\`${id}\``).join(", ") : "none — evidence mapping gap exposed"}; lexical score: ${entry.lexical_score}; support determination: **pending**`,
        );
      }
      itemReview.push("");
    }
  }
  writeFileSync(
    resolve(OUTPUT_ROOT, "52-ITEM-ANSWER-EVIDENCE-REVIEW.md"),
    `${itemReview.join("\n")}\n`,
  );

  const cumulativeAudit = buildCumulativeAudit(pack, allocation, audit);
  writeJson(resolve(OUTPUT_ROOT, "CUMULATIVE-TRAINING-HISTORY-AUDIT.json"), cumulativeAudit);
  writeFileSync(
    resolve(OUTPUT_ROOT, "CUMULATIVE-TRAINING-HISTORY-AUDIT.md"),
    renderCumulativeAudit(cumulativeAudit),
  );

  const changeRegister = buildChangeRegister(pack);
  writeJson(resolve(OUTPUT_ROOT, "SECOND-PASS-CHANGE-REGISTER.json"), changeRegister);
  writeFileSync(
    resolve(OUTPUT_ROOT, "SECOND-PASS-CHANGE-REGISTER.md"),
    renderChangeRegister(changeRegister),
  );
  if (changeRegister.curated_feed.packaged_copy) {
    cpSync(
      changeRegister.curated_feed.source_path,
      resolve(OUTPUT_ROOT, changeRegister.curated_feed.packaged_copy),
    );
  }
  writeFileSync(
    resolve(OUTPUT_ROOT, "CURRENT-EVALUATION-TRAINING-UNSEEN-STATUS.md"),
    renderStatusDocument(cumulativeAudit),
  );
  writeFileSync(
    resolve(OUTPUT_ROOT, "REPAIR-RESPONSE-REGISTER.md"),
    renderResponseRegister(cumulativeAudit),
  );

  for (const name of [
    "repaired-training-items-draft.json",
    "global-allocation-draft.json",
    "integrity-and-review-preflight.json",
  ]) {
    cpSync(resolve(SOURCE_ROOT, name), resolve(OUTPUT_ROOT, name));
  }

  const suppliedChangeRegisterReadmeLine = changeRegister.curated_feed.packaged_copy
    ? `- \`${changeRegister.curated_feed.packaged_copy}\` — exact preserved copy of the supplied second-pass register; inclusion is not approval.\n`
    : "";
  const readme = `# Wave 2–3 double-check review package v3

This package presents the second-pass developer candidate for all **52 visible Wave 2–3 records**: **33 Wave 2** and **19 Wave 3**. It is for independent review only.

## Decision status

- Developer second pass: **packaged for review**
- Machine integrity preflight: **passed for the supplied candidate files**
- Independent legal/proposition review: **pending**
- Local Wave 2–3 ${localTrainCount}/${localValidationCount} allocation: **candidate only**
- Cumulative/global allocation approval: **not established**
- Protected-set custodian comparison: **pending**
- Training authorisation: **not granted**
- Sealed unseen included or accessed: **no**
- Release authorisation: **not granted**

The local ${localTrainCount}/${localValidationCount} graph does not qualify a cumulative training run. See \`CUMULATIVE-TRAINING-HISTORY-AUDIT.md\` for the v1 cross-history limitation and visible semantic-risk candidates. Historical data, adapters and results remain preserved, but answer-containing Wave 2–3 validation results are not clean qualification evidence.

## Package contents

- \`52-ITEM-ANSWER-EVIDENCE-REVIEW.md\` — every visible question, revised answer, selected source records and candidate proposition mappings.
- \`SOURCE-EVIDENCE-REGISTER.json\` — deduplicated selected passages, metadata, hashes and item usage.
- \`SECOND-PASS-CHANGE-REGISTER.md\` / \`.json\` — curated change-feed status plus machine field diff from preserved v2.
${suppliedChangeRegisterReadmeLine}- \`CUMULATIVE-TRAINING-HISTORY-AUDIT.md\` / \`.json\` — exact visible-history checks and the reasons global qualification still fails.
- \`CURRENT-EVALUATION-TRAINING-UNSEEN-STATUS.md\` — the current and next pipeline gates.
- \`REPAIR-RESPONSE-REGISTER.md\` — control-level response and decisions still required.
- \`repaired-training-items-draft.json\` — 52-record review draft; not training-authorised.
- \`global-allocation-draft.json\` — local candidate allocation; not globally approved.
- \`integrity-and-review-preflight.json\` — machine checks; not legal approval.
- \`REVIEW-MANIFEST.json\` — package controls and SHA-256 hashes.

## Reviewer action

Review all 52 answers proposition by proposition against verified full passages. The package currently exposes **${curatorSummarySourceCount} curator-summary source records requiring verbatim replacement** and **${unmappedLexicalCandidateCount} lexical candidate gaps**; neither is an approval. Confirm jurisdiction, effective date, completeness, current/repealed status, source hierarchy and answer abstention boundaries. Then approve or return each item. Separately approve a cumulative split across all visible training history and obtain the protected-set custodian comparison without exposing sealed content.

No replacement training, unseen scoring or release decision may start from this package alone.
`;
  writeFileSync(resolve(OUTPUT_ROOT, "REVIEW-README.md"), readme);

  const manifestNames = [
    "REVIEW-README.md",
    "52-ITEM-ANSWER-EVIDENCE-REVIEW.md",
    "SOURCE-EVIDENCE-REGISTER.json",
    "SECOND-PASS-CHANGE-REGISTER.md",
    "SECOND-PASS-CHANGE-REGISTER.json",
    "CUMULATIVE-TRAINING-HISTORY-AUDIT.md",
    "CUMULATIVE-TRAINING-HISTORY-AUDIT.json",
    "CURRENT-EVALUATION-TRAINING-UNSEEN-STATUS.md",
    "REPAIR-RESPONSE-REGISTER.md",
    "repaired-training-items-draft.json",
    "global-allocation-draft.json",
    "integrity-and-review-preflight.json",
  ];
  if (changeRegister.curated_feed.packaged_copy) {
    manifestNames.push(changeRegister.curated_feed.packaged_copy);
  }
  const manifest = {
    version: "wave4-wave2-wave3-review-manifest-v3",
    generated_at: new Date().toISOString(),
    package_name: basename(OUTPUT_ROOT),
    purpose: "independent_review_only",
    training_authorised: false,
    release_authorised: false,
    unseen_included: false,
    unseen_accessed: false,
    counts: {
      items: 52,
      wave_2: 33,
      wave_3: 19,
      local_proposed_train: localTrainCount,
      local_proposed_validation: localValidationCount,
      selected_sources: sourceRegister.source_count,
      curator_summary_sources_pending_verbatim_replacement: curatorSummarySourceCount,
      unmapped_lexical_proposition_candidates: unmappedLexicalCandidateCount,
      cumulative_visible_records: cumulativeAudit.visible_history.total_visible_records,
    },
    controls: {
      local_candidate_machine_preflight_passed: true,
      independent_legal_review_pending: true,
      local_wave_2_3_isolation_passed: Boolean(allocation.isolation?.passed),
      cumulative_global_qualification_passed: false,
      allocation_review_pending: true,
      curated_second_pass_register_complete: changeRegister.curated_feed.complete,
      protected_set_custodian_check_pending: true,
      rendered_export_preflight_pending: true,
      clean_checkpoint_provenance_pending: true,
    },
    source_inputs: {
      repaired_items_sha256: fileSha(packPath),
      allocation_sha256: fileSha(allocationPath),
      integrity_preflight_sha256: fileSha(auditPath),
      v1_dataset_manifest_sha256: cumulativeAudit.v1_dataset_manifest.manifest_sha256,
    },
    files: manifestNames.map((name) => ({
      name,
      sha256: fileSha(resolve(OUTPUT_ROOT, name)),
    })),
  };
  writeJson(resolve(OUTPUT_ROOT, "REVIEW-MANIFEST.json"), manifest);

  const reloadedManifest = readJson(resolve(OUTPUT_ROOT, "REVIEW-MANIFEST.json"));
  for (const file of reloadedManifest.files) {
    const path = resolve(OUTPUT_ROOT, file.name);
    if (!existsSync(path) || fileSha(path) !== file.sha256) {
      throw new Error(`Manifest validation failed for ${file.name}`);
    }
  }
  const expectedPackageFiles = uniqueSorted([
    ...manifestNames,
    "REVIEW-MANIFEST.json",
  ]);
  const actualPackageFiles = uniqueSorted(
    readdirSync(OUTPUT_ROOT).filter((name) => statSync(resolve(OUTPUT_ROOT, name)).isFile()),
  );
  if (JSON.stringify(expectedPackageFiles) !== JSON.stringify(actualPackageFiles)) {
    throw new Error("Package contains unmanifested or missing top-level files");
  }

  rmSync(ZIP_PATH, { force: true });
  mkdirSync(dirname(ZIP_PATH), { recursive: true });
  const zip = spawnSync("zip", ["-q", "-r", ZIP_PATH, basename(OUTPUT_ROOT)], {
    cwd: dirname(OUTPUT_ROOT),
    encoding: "utf8",
  });
  if (zip.status !== 0) {
    throw new Error(`ZIP creation failed: ${zip.stderr || zip.stdout}`);
  }
  const zipTest = spawnSync("unzip", ["-tq", ZIP_PATH], { encoding: "utf8" });
  if (zipTest.status !== 0) {
    throw new Error(`ZIP integrity test failed: ${zipTest.stderr || zipTest.stdout}`);
  }

  console.log(
    JSON.stringify(
      {
        output: OUTPUT_ROOT,
        zip: ZIP_PATH,
        zip_sha256: fileSha(ZIP_PATH),
        items: 52,
        wave_2: 33,
        wave_3: 19,
        selected_sources: sourceRegister.source_count,
        local_candidate_split: `${localTrainCount}/${localValidationCount}`,
        cumulative_global_qualification_passed: false,
        training_authorised: false,
        unseen_accessed: false,
        package_files: expectedPackageFiles.length,
        manifest_entries_validated: reloadedManifest.files.length,
      },
      null,
      2,
    ),
  );
}

buildPackage();
