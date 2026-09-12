import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { auditTrainingRows } from "./lib/trainingEvidenceIntegrity.mjs";

const QUALIFICATION_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_QUALIFICATION_ROOT ||
    "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901",
);
const DATASET_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_DATASET_ROOT ||
    "training-data/private/evaluation-cycle-v2-cumulative-visible-compact-v8",
);
const SMOKE_RUN_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_SMOKE_RUN_ROOT ||
    resolve(QUALIFICATION_ROOT, "mlx-memory-smoke-run-v1"),
);
const SMOKE_DATASET_ROOT = resolve(SMOKE_RUN_ROOT, "longest-row-dataset");
const SMOKE_ADAPTER_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_SMOKE_ADAPTER_ROOT ||
    "adapters/quarantined-pension-assistant-cumulative-visible-memory-smoke-v1",
);
const REPORT_PATH = resolve(
  process.env.CUMULATIVE_VISIBLE_SMOKE_REPORT_PATH ||
    resolve(QUALIFICATION_ROOT, "mlx-memory-smoke-preflight.json"),
);
const MODEL_ROOT = resolve("models/mlx/Qwen3-8B-4bit");
const CONFIG = resolve("training/cumulative_visible_mlx_config_v1.yaml");
const TRAINING_WRAPPER = resolve("training/train_mlx.sh");
const PYTHON = resolve(".training-venv/bin/python");
const GATE_PATH = resolve(QUALIFICATION_ROOT, "qualification-status.json");
const PROVENANCE_PATH = resolve(
  QUALIFICATION_ROOT,
  "clean-checkpoint-provenance.json",
);
const FINAL_TOKEN_PATH = resolve(
  QUALIFICATION_ROOT,
  "final-token-and-loss-mask-preflight.json",
);
const DATASET_MANIFEST_PATH = resolve(DATASET_ROOT, "dataset-manifest.json");
const MAX_MEMORY_GB = Number(
  process.env.CUMULATIVE_VISIBLE_SMOKE_MAX_MEMORY_GB || "14",
);
const SMOKE_SCRIPT_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleSmokeMlxV1.mjs",
);

const hash = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = (path) => hash(readFileSync(path));
const hashLargeFile = (path) =>
  new Promise((resolveHash, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(digest.digest("hex")));
  });
const readJson = (path) => JSON.parse(readFileSync(path));
const readJsonl = (path) =>
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(JSON.parse);
const writeJsonExclusive = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

if (
  process.env.CUMULATIVE_VISIBLE_MEMORY_SMOKE_CONFIRM !==
  "approved_quarantined_longest_row_memory_smoke"
) {
  throw new Error(
    "Memory smoke is locked. Supply the exact quarantined-smoke confirmation only after the owner-authorised qualification gate passes.",
  );
}
for (const path of [
  GATE_PATH,
  PROVENANCE_PATH,
  FINAL_TOKEN_PATH,
  DATASET_MANIFEST_PATH,
  resolve(DATASET_ROOT, "train.jsonl"),
  resolve(DATASET_ROOT, "valid.jsonl"),
  resolve(MODEL_ROOT, "model.safetensors"),
  CONFIG,
  TRAINING_WRAPPER,
  PYTHON,
]) {
  if (!existsSync(path)) throw new Error(`Memory-smoke prerequisite is missing: ${path}`);
}
if (!Number.isFinite(MAX_MEMORY_GB) || MAX_MEMORY_GB <= 0 || MAX_MEMORY_GB >= 16) {
  throw new Error("Memory-smoke safety ceiling must be greater than 0 and below 16 GB");
}
if (existsSync(REPORT_PATH)) {
  throw new Error(`Immutable memory-smoke report already exists: ${REPORT_PATH}`);
}
for (const path of [SMOKE_RUN_ROOT, SMOKE_ADAPTER_ROOT]) {
  if (existsSync(path) && readdirSync(path).length) {
    throw new Error(`Versioned memory-smoke output is not empty: ${path}`);
  }
}

const gate = readJson(GATE_PATH);
const provenance = readJson(PROVENANCE_PATH);
const tokens = readJson(FINAL_TOKEN_PATH);
const dataset = readJson(DATASET_MANIFEST_PATH);
if (
  gate.passed !== true ||
  gate.training_authorised !== true ||
  gate.release_authorised !== false ||
  tokens.passed !== true ||
  tokens.scope !== "final_hash_bound_dataset" ||
  tokens.global_checks?.all_rows_fit_without_truncation !== true ||
  tokens.global_checks?.all_rows_retain_full_completion_target !== true ||
  dataset.status !== "final_hash_bound_qualification_candidate" ||
  dataset.training_authorised !== false ||
  provenance.passed !== true ||
  provenance.training_started !== false ||
  provenance.clean_start_policy?.resume_adapter !== null
) {
  throw new Error("Owner-authorised qualification/token/provenance gates do not permit the memory smoke");
}
if (
  provenance.memory_smoke_runner?.sha256 !== hashFile(SMOKE_SCRIPT_PATH)
) {
  throw new Error("The longest-row memory-smoke runner is not bound to compact provenance");
}
if (
  hashFile(resolve(DATASET_ROOT, "train.jsonl")) !== dataset.train?.sha256 ||
  hashFile(resolve(DATASET_ROOT, "valid.jsonl")) !== dataset.validation?.sha256 ||
  provenance.config?.sha256 !== hashFile(CONFIG) ||
  tokens.runtime_contract?.config_sha256 !== hashFile(CONFIG)
) {
  throw new Error("Memory-smoke dataset or config no longer matches its frozen provenance");
}
const actualModelHash = await hashLargeFile(resolve(MODEL_ROOT, "model.safetensors"));
if (actualModelHash !== provenance.base_model?.model_sha256) {
  throw new Error("Pinned base weights changed before the memory smoke");
}

const rowsById = new Map(
  [
    ...readJsonl(resolve(DATASET_ROOT, "train.jsonl")),
    ...readJsonl(resolve(DATASET_ROOT, "valid.jsonl")),
  ].map((row) => [row.metadata?.training_id, row]),
);
const longest = (partition) =>
  [...(tokens.rows || [])]
    .filter((entry) => entry.partition === partition && entry.passed === true)
    .sort(
      (left, right) =>
        right.total_tokens - left.total_tokens ||
        left.training_id.localeCompare(right.training_id),
    )[0];
const longestTrain = longest("train");
const longestValidation = longest("validation");
if (
  !longestTrain ||
  !longestValidation ||
  !rowsById.has(longestTrain.training_id) ||
  !rowsById.has(longestValidation.training_id)
) {
  throw new Error("Could not bind the longest train and validation rows from the exact token report");
}
const smokeTrain = jsonl([rowsById.get(longestTrain.training_id)]);
const smokeValidation = jsonl([rowsById.get(longestValidation.training_id)]);
mkdirSync(SMOKE_DATASET_ROOT, { recursive: true });
writeFileSync(resolve(SMOKE_DATASET_ROOT, "train.jsonl"), smokeTrain, { flag: "wx" });
writeFileSync(resolve(SMOKE_DATASET_ROOT, "valid.jsonl"), smokeValidation, {
  flag: "wx",
});
if (
  !auditTrainingRows([
    rowsById.get(longestTrain.training_id),
    rowsById.get(longestValidation.training_id),
  ]).passed
) {
  throw new Error("Longest-row smoke subset failed the answer-input echo audit");
}

mkdirSync(SMOKE_ADAPTER_ROOT, { recursive: true });
const logPath = resolve(SMOKE_RUN_ROOT, "training-output.log");
const log = createWriteStream(logPath, { flags: "wx" });
const child = spawn("bash", [TRAINING_WRAPPER, SMOKE_DATASET_ROOT], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PENSION_TRAINING_PYTHON: PYTHON,
    PENSION_MLX_MODEL_PATH: MODEL_ROOT,
    PENSION_ADAPTER_PATH: SMOKE_ADAPTER_ROOT,
    PENSION_TRAINING_CONFIG: CONFIG,
    PENSION_TRAINING_ITERS: "1",
    PENSION_TRAINING_SEED: "42",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    log.write(text);
    process.stdout.write(text);
  });
}
const exitCode = await new Promise((resolveExit, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolveExit(code ?? 1));
});
await new Promise((resolveLog) => log.end(resolveLog));
const peakMemoryValues = [...output.matchAll(/Peak mem\s+([0-9.]+)\s+GB/g)].map(
  (match) => Number(match[1]),
);
const peakMemoryGb = peakMemoryValues.length
  ? Math.max(...peakMemoryValues)
  : null;
const finalAdapterPath = resolve(SMOKE_ADAPTER_ROOT, "adapters.safetensors");
const passed =
  exitCode === 0 &&
  /Iter\s+1:\s+Train loss/.test(output) &&
  existsSync(finalAdapterPath) &&
  Number.isFinite(peakMemoryGb) &&
  peakMemoryGb <= MAX_MEMORY_GB;
const report = {
  version: "cumulative-visible-quarantined-longest-row-mlx-memory-smoke-v1",
  generated_at: new Date().toISOString(),
  status: passed ? "passed_quarantined_smoke_only" : "failed_full_training_blocked",
  passed,
  training_started: true,
  production_training_started: false,
  training_authorised: false,
  release_authorised: false,
  unseen_accessed: false,
  quarantine: {
    adapter_path: SMOKE_ADAPTER_ROOT,
    permitted_use: "memory_smoke_only_never_inference_evaluation_or_resume",
    adapter_sha256: existsSync(finalAdapterPath)
      ? hashFile(finalAdapterPath)
      : null,
  },
  bindings: {
    qualification_gate_sha256: hashFile(GATE_PATH),
    final_token_preflight_sha256: hashFile(FINAL_TOKEN_PATH),
    dataset_manifest_sha256: hashFile(DATASET_MANIFEST_PATH),
    train_sha256: dataset.train.sha256,
    validation_sha256: dataset.validation.sha256,
    config_sha256: hashFile(CONFIG),
    training_wrapper_sha256: hashFile(TRAINING_WRAPPER),
    base_model_sha256: actualModelHash,
    memory_smoke_runner_sha256: hashFile(SMOKE_SCRIPT_PATH),
  },
  exact_longest_rows: {
    train: {
      training_id: longestTrain.training_id,
      total_tokens: longestTrain.total_tokens,
      smoke_jsonl_sha256: hash(smokeTrain),
    },
    validation: {
      training_id: longestValidation.training_id,
      total_tokens: longestValidation.total_tokens,
      smoke_jsonl_sha256: hash(smokeValidation),
    },
  },
  runtime: {
    max_sequence_length: tokens.runtime_contract.max_sequence_length,
    peak_memory_gb: peakMemoryGb,
    safety_ceiling_gb: MAX_MEMORY_GB,
    exit_code: exitCode,
    log_path: logPath,
    log_sha256: hashFile(logPath),
  },
  limitation:
    "This one-iteration adapter is quarantined and cannot be selected, resumed, evaluated or served. Passing authorises only the separate clean-base full runner's memory gate; it is not model qualification.",
};
writeJsonExclusive(REPORT_PATH, report);
console.log(
  JSON.stringify(
    {
      passed,
      peak_memory_gb: peakMemoryGb,
      safety_ceiling_gb: MAX_MEMORY_GB,
      longest_train: longestTrain.training_id,
      longest_validation: longestValidation.training_id,
      report: REPORT_PATH,
      production_training_started: false,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
