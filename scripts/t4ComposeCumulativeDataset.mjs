import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditTrainingRows, contentHash } from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT = resolve(".");
const OUT = resolve(ROOT, "training/evaluation-cycle-v2/30-cumulative-legal-training-20260902");
const DATASET = resolve(ROOT, "training-data/private/evaluation-cycle-v2-cumulative-t4-legal-20260902");
if (existsSync(OUT) && readdirSync(OUT).length) throw new Error(`Cycle 30 is not empty: ${OUT}`);
if (existsSync(DATASET) && readdirSync(DATASET).length) throw new Error(`Dataset root is not empty: ${DATASET}`);

const hashFile = (path) => contentHash(readFileSync(path));
const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeJsonl = (path, rows) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
};
const ngrams = (value, n = 8) => {
  const words = String(value || "").toLowerCase().replace(/[^a-z0-9£%]+/g, " ").trim().split(/\s+/);
  const out = new Set();
  for (let i = 0; i <= words.length - n; i += 1) out.add(words.slice(i, i + n).join(" "));
  return out;
};
const questionOf = (row) => {
  try { return JSON.parse(row.messages.find((m) => m.role === "user").content).question || ""; } catch { return ""; }
};

function authoriseRow(row, extra = {}) {
  return {
    ...row,
    metadata: {
      ...(row.metadata || {}),
      review_only_candidate: false,
      owner_authorised_development: true,
      training_authorised: false,
      independent_legal_review: false,
      release_authorised: false,
      cohort: extra.cohort || row.metadata?.cohort || "t4-legal-20260902",
      ...extra,
    },
  };
}

const priorTrain = readJsonl(resolve(ROOT, "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901/rendered-candidate/train.review.jsonl")).map((row) => authoriseRow(row, { cohort: "compact-v8" }));
const priorValid = readJsonl(resolve(ROOT, "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901/rendered-candidate/valid.review.jsonl")).map((row) => authoriseRow(row, { cohort: "compact-v8" }));
const t4 = readJsonl(resolve(ROOT, "training/evaluation-cycle-v2/28-topic161-t4-training-draft-20260902/approved-t4.jsonl")).map((row) => authoriseRow(row, {
  cohort: "t4-legal-20260902",
  T4_category: row.metadata.T4_category,
}));

const groups = new Map();
for (const row of t4) {
  const key = row.metadata.source_case_id || row.metadata.training_id;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const groupKeys = [...groups.keys()].sort();
const validGroupCount = Math.max(1, Math.round(groupKeys.length * 0.2));
const validKeys = new Set(groupKeys.slice(0, validGroupCount));
const t4Train = [];
const t4Valid = [];
for (const key of groupKeys) {
  (validKeys.has(key) ? t4Valid : t4Train).push(...groups.get(key));
}

const train = [...priorTrain, ...t4Train];
const valid = [...priorValid, ...t4Valid];

const replacementQs = readJsonl(resolve(ROOT, "training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/questions.jsonl")).map((row) => row.question);
const originalQs = readJsonl(resolve(ROOT, "training/evaluation-cycle-v2/27-topic161-forensic-audit-20260902/case-failure-manifest.jsonl")).map((row) => row.question);
function leak(question, pool) {
  const grams = ngrams(question, 12);
  for (const other of pool) {
    const og = ngrams(other, 12);
    for (const gram of grams) if (og.has(gram)) return gram;
  }
  return null;
}
const leaks = [...train, ...valid].map((row) => {
  const q = questionOf(row);
  return { id: row.metadata.training_id, replacement: leak(q, replacementQs), original: row.metadata.cohort === "t4-legal-20260902" ? null : leak(q, originalQs) };
}).filter((row) => row.replacement);

const trainAudit = auditTrainingRows(train);
const validAudit = auditTrainingRows(valid);
if (!trainAudit.passed || !validAudit.passed) {
  throw new Error("Dataset blocked: completion target appears in an input");
}

const topicDist = {};
const catDist = {};
for (const row of [...train, ...valid]) {
  const topic = row.metadata.topic || "unknown";
  const cat = row.metadata.T4_category || row.metadata.cohort || "prior";
  topicDist[topic] = (topicDist[topic] || 0) + 1;
  catDist[cat] = (catDist[cat] || 0) + 1;
}

writeJsonl(resolve(OUT, "train.jsonl"), train);
writeJsonl(resolve(OUT, "valid.jsonl"), valid);
writeJsonl(resolve(DATASET, "train.jsonl"), train);
writeJsonl(resolve(DATASET, "valid.jsonl"), valid);

const manifest = {
  version: "cumulative-t4-legal-dataset-v1",
  generated_at: new Date().toISOString(),
  status: "final_hash_bound_qualification_candidate",
  training_authorised: false,
  owner_authorised_development: true,
  release_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  protected_sets: { sealed_unseen_accessed: false },
  total_count: train.length + valid.length,
  prior_compact_v8: priorTrain.length + priorValid.length,
  approved_t4: t4.length,
  train: { count: train.length, filename: "train.jsonl", sha256: hashFile(resolve(DATASET, "train.jsonl")) },
  validation: { count: valid.length, filename: "valid.jsonl", sha256: hashFile(resolve(DATASET, "valid.jsonl")) },
  topic_distribution: topicDist,
  category_distribution: catDist,
  t4_valid_source_cases: [...validKeys],
  replacement_question_leaks: leaks,
  clean_start: "pinned_original_base_qwen3_8b_4bit",
  resume_step130: false,
};

writeJson(resolve(OUT, "cumulative-dataset-manifest.json"), manifest);
writeJson(resolve(DATASET, "dataset-manifest.json"), manifest);
writeJson(resolve(OUT, "allocation-audit.json"), {
  train_ids: train.map((row) => row.metadata.training_id),
  valid_ids: valid.map((row) => row.metadata.training_id),
  grouped_t4_source_cases: Object.fromEntries([...groups].map(([key, rows]) => [key, rows.map((row) => row.metadata.training_id)])),
  lexical_overlap_train_valid_questions: (() => {
    const hits = [];
    for (const v of valid) {
      const g = ngrams(questionOf(v), 12);
      for (const t of train) {
        const tg = ngrams(questionOf(t), 12);
        for (const gram of g) if (tg.has(gram)) { hits.push({ valid: v.metadata.training_id, train: t.metadata.training_id, gram }); break; }
      }
    }
    return hits;
  })(),
  replacement_leaks: leaks,
  train_integrity: trainAudit,
  valid_integrity: validAudit,
});

const iters = train.length * 3;
const config = `fine_tune_type: lora
optimizer: adam
seed: 42
num_layers: 16
batch_size: 1
iters: ${iters}
val_batches: -1
learning_rate: 0.00001
steps_per_report: 5
steps_per_eval: 26
grad_accumulation_steps: 1
save_every: 26
max_seq_length: 2112
grad_checkpoint: true
clear_cache_threshold: 8000000000
mask_prompt: true
lora_parameters:
  rank: 8
  dropout: 0.05
  scale: 20.0
`;
writeFileSync(resolve(ROOT, "training/cumulative_t4_legal_mlx_config_20260902.yaml"), config);
writeJson(resolve(OUT, "training-authorisation.json"), {
  owner_authorisation_recorded: true,
  prompt: "OWNER AUTHORISATION — TOPIC161 MULTI-TOPIC LEGAL REPAIR",
  date: "2026-09-02",
  clean_start_from_pinned_base: true,
  resume_step130: false,
  sealed_unseen: false,
  training_authorised_after_mechanical_gates: true,
  release_authorised: false,
  confirmation: "owner_authorised_t4_clean_cumulative_20260902",
});

console.log(JSON.stringify({
  state: "CUMULATIVE_DATASET_FREEZE",
  train: train.length,
  valid: valid.length,
  total: train.length + valid.length,
  t4: t4.length,
  iters,
  replacement_leaks: leaks.length,
}, null, 2));
