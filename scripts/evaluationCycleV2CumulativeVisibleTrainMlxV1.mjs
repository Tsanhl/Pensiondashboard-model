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
import { assertTrainingDatasetIntegrity } from "./lib/trainingEvidenceIntegrity.mjs";

const QUALIFICATION_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_QUALIFICATION_ROOT ||
    "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901",
);
const DATASET_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_DATASET_ROOT ||
    "training-data/private/evaluation-cycle-v2-cumulative-visible-compact-v8",
);
const RUN_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_RUN_ROOT ||
    "training/evaluation-cycle-v2/25-cumulative-visible-training-v8-20260901",
);
const MODEL_ROOT = resolve("models/mlx/Qwen3-8B-4bit");
const ADAPTER_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_ADAPTER_ROOT ||
    "adapters/pension-assistant-cumulative-visible-compact-v8",
);
const PYTHON = resolve(".training-venv/bin/python");
const CONFIG = resolve("training/cumulative_visible_mlx_config_v1.yaml");
const TRAINING_WRAPPER = resolve("training/train_mlx.sh");
const CHECKPOINT_SELECTOR = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleSelectCheckpointV1.mjs",
);
const OWNER_AUTHORISATION_PATH = resolve(
  QUALIFICATION_ROOT,
  "owner-development-authorisation.json",
);
const GATE_PATH = resolve(QUALIFICATION_ROOT, "qualification-status.json");
const PROVENANCE_PATH = resolve(
  QUALIFICATION_ROOT,
  "clean-checkpoint-provenance.json",
);
const CHECKPOINT_POLICY_PATH = resolve(
  QUALIFICATION_ROOT,
  "checkpoint-selection-policy.json",
);
const DATASET_MANIFEST_PATH = resolve(DATASET_ROOT, "dataset-manifest.json");
const MEMORY_SMOKE_PATH = resolve(
  QUALIFICATION_ROOT,
  "mlx-memory-smoke-preflight.json",
);
const MEMORY_SMOKE_RUNNER = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleSmokeMlxV1.mjs",
);
const FINAL_TOKEN_PATH = resolve(
  QUALIFICATION_ROOT,
  "final-token-and-loss-mask-preflight.json",
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
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

if (
  process.env.CUMULATIVE_VISIBLE_TRAINING_CONFIRM !==
  "approved_94_visible_clean_start"
) {
  throw new Error(
    "Training is locked. Supply the explicit clean cumulative confirmation only after the owner-authorised development gate and all mechanical/token checks authorise it.",
  );
}
for (const path of [
  OWNER_AUTHORISATION_PATH,
  GATE_PATH,
  PROVENANCE_PATH,
  CHECKPOINT_POLICY_PATH,
  DATASET_MANIFEST_PATH,
  MEMORY_SMOKE_PATH,
  FINAL_TOKEN_PATH,
  MEMORY_SMOKE_RUNNER,
  resolve(DATASET_ROOT, "train.jsonl"),
  resolve(DATASET_ROOT, "valid.jsonl"),
  resolve(MODEL_ROOT, "model.safetensors"),
  PYTHON,
  CONFIG,
  TRAINING_WRAPPER,
  CHECKPOINT_SELECTOR,
]) {
  if (!existsSync(path)) throw new Error(`Training prerequisite is missing: ${path}`);
}

const ownerAuthorisation = readJson(OWNER_AUTHORISATION_PATH);
const gate = readJson(GATE_PATH);
const provenance = readJson(PROVENANCE_PATH);
const checkpointPolicy = readJson(CHECKPOINT_POLICY_PATH);
const dataset = readJson(DATASET_MANIFEST_PATH);
const memorySmoke = readJson(MEMORY_SMOKE_PATH);
const finalTokens = readJson(FINAL_TOKEN_PATH);
if (
  ownerAuthorisation.owner_authorisation_recorded !== true ||
  ownerAuthorisation.conditionally_authorised_after_all_mechanical_gates !== true ||
  ownerAuthorisation.release_authorised !== false ||
  gate.status !== "approved_for_owner_authorised_clean_cumulative_development_training" ||
  gate.training_authorised !== true ||
  gate.passed !== true
) {
  throw new Error("The owner-authorised cumulative development gate does not authorise training");
}
if (
  provenance.passed !== true ||
  provenance.clean_start_policy?.historical_v1_wave2_wave3_adapters_used !== false ||
  provenance.config?.sha256 !== hashFile(CONFIG) ||
  provenance.training_wrapper?.sha256 !== hashFile(TRAINING_WRAPPER) ||
  provenance.checkpoint_policy?.selector_sha256 !== hashFile(CHECKPOINT_SELECTOR) ||
  checkpointPolicy.selector_sha256 !== hashFile(CHECKPOINT_SELECTOR) ||
  checkpointPolicy.config_sha256 !== hashFile(CONFIG) ||
  checkpointPolicy.training_wrapper_sha256 !== hashFile(TRAINING_WRAPPER)
) {
  throw new Error("Clean base, exact cumulative config or training-wrapper provenance is not verified");
}
if (
  dataset.status !== "final_hash_bound_qualification_candidate" ||
  dataset.training_authorised !== false ||
  dataset.owner_authorised_development !== true ||
  dataset.release_authorised !== false ||
  dataset.total_count !== 94 ||
  dataset.train?.count + dataset.validation?.count !== 94 ||
  dataset.validation?.count < 14 ||
  dataset.validation?.count > 18 ||
  dataset.protected_sets?.sealed_unseen_accessed !== false
) {
  throw new Error("The final 94-record dataset manifest is incomplete or not approved");
}
if (
  hashFile(resolve(DATASET_ROOT, "train.jsonl")) !== dataset.train.sha256 ||
  hashFile(resolve(DATASET_ROOT, "valid.jsonl")) !== dataset.validation.sha256
) {
  throw new Error("Final dataset hashes no longer match its approved manifest");
}
if (
  finalTokens.passed !== true ||
  finalTokens.scope !== "final_hash_bound_dataset" ||
  finalTokens.training_authorised !== false ||
  finalTokens.unseen_accessed !== false ||
  memorySmoke.passed !== true ||
  memorySmoke.status !== "passed_quarantined_smoke_only" ||
  memorySmoke.training_started !== true ||
  memorySmoke.production_training_started !== false ||
  memorySmoke.training_authorised !== false ||
  memorySmoke.release_authorised !== false ||
  memorySmoke.unseen_accessed !== false ||
  memorySmoke.quarantine?.permitted_use !==
    "memory_smoke_only_never_inference_evaluation_or_resume" ||
  memorySmoke.bindings?.qualification_gate_sha256 !== hashFile(GATE_PATH) ||
  memorySmoke.bindings?.final_token_preflight_sha256 !==
    hashFile(FINAL_TOKEN_PATH) ||
  memorySmoke.bindings?.dataset_manifest_sha256 !==
    hashFile(DATASET_MANIFEST_PATH) ||
  memorySmoke.bindings?.config_sha256 !== hashFile(CONFIG) ||
  memorySmoke.bindings?.training_wrapper_sha256 !== hashFile(TRAINING_WRAPPER) ||
  memorySmoke.bindings?.base_model_sha256 !== provenance.base_model?.model_sha256 ||
  memorySmoke.bindings?.memory_smoke_runner_sha256 !==
    hashFile(MEMORY_SMOKE_RUNNER) ||
  provenance.memory_smoke_runner?.sha256 !== hashFile(MEMORY_SMOKE_RUNNER) ||
  !Number.isFinite(memorySmoke.runtime?.peak_memory_gb) ||
  memorySmoke.runtime.peak_memory_gb > memorySmoke.runtime?.safety_ceiling_gb ||
  memorySmoke.runtime?.max_sequence_length !==
    provenance.config?.max_sequence_length ||
  memorySmoke.exact_longest_rows?.train?.training_id !==
    [...(finalTokens.rows || [])]
      .filter((entry) => entry.partition === "train" && entry.passed === true)
      .sort(
        (left, right) =>
          right.total_tokens - left.total_tokens ||
          left.training_id.localeCompare(right.training_id),
      )[0]?.training_id ||
  memorySmoke.exact_longest_rows?.validation?.training_id !==
    [...(finalTokens.rows || [])]
      .filter(
        (entry) => entry.partition === "validation" && entry.passed === true,
      )
      .sort(
        (left, right) =>
          right.total_tokens - left.total_tokens ||
          left.training_id.localeCompare(right.training_id),
      )[0]?.training_id
) {
  throw new Error("The exact longest-row 16 GB MLX memory smoke has not passed");
}
if (
  dataset.owner_development_authorisation_sha256 !==
  hashFile(OWNER_AUTHORISATION_PATH)
) {
  throw new Error("Final dataset is not bound to the recorded owner development authorisation");
}
assertTrainingDatasetIntegrity(DATASET_ROOT);

const currentModelHash = await hashLargeFile(resolve(MODEL_ROOT, "model.safetensors"));
if (currentModelHash !== provenance.base_model?.model_sha256) {
  throw new Error("Pinned original base-model weights changed after provenance preflight");
}
if (existsSync(ADAPTER_ROOT) && readdirSync(ADAPTER_ROOT).length) {
  throw new Error(`Versioned adapter output is not empty: ${ADAPTER_ROOT}`);
}
if (existsSync(RUN_ROOT) && readdirSync(RUN_ROOT).length) {
  throw new Error(`Versioned run output is not empty: ${RUN_ROOT}`);
}

mkdirSync(ADAPTER_ROOT, { recursive: true });
mkdirSync(RUN_ROOT, { recursive: true });
const iterations = dataset.train.count * 3;
const configText = readFileSync(CONFIG, "utf8");
const configNumber = (key) =>
  Number(configText.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m"))?.[1]);
const stepsPerEval = configNumber("steps_per_eval");
const saveEvery = configNumber("save_every");
const maxSequenceLength = configNumber("max_seq_length");
const configuredIterations = configNumber("iters");
if (
  !Number.isInteger(stepsPerEval) ||
  !Number.isInteger(saveEvery) ||
  stepsPerEval <= 0 ||
  saveEvery !== stepsPerEval ||
  !Number.isInteger(maxSequenceLength) ||
  maxSequenceLength <= 0 ||
  configuredIterations !== iterations ||
  provenance.config?.max_sequence_length !== maxSequenceLength
) {
  throw new Error(
    "Cumulative config must match the exact run iterations/context and save a checkpoint at every validation interval",
  );
}
const startedAt = new Date().toISOString();
const manifest = {
  version: "cumulative-visible-clean-mlx-run-v1",
  status: "running",
  started_at: startedAt,
  completed_at: null,
  clean_start: true,
  base_model: provenance.base_model,
  historical_adapter_input: null,
  output_adapter: { path: ADAPTER_ROOT, sha256: null },
  qualification: {
    owner_authorisation_path: OWNER_AUTHORISATION_PATH,
    owner_authorisation_sha256: hashFile(OWNER_AUTHORISATION_PATH),
    gate_path: GATE_PATH,
    gate_sha256: hashFile(GATE_PATH),
    provenance_path: PROVENANCE_PATH,
    provenance_sha256: hashFile(PROVENANCE_PATH),
    checkpoint_policy_path: CHECKPOINT_POLICY_PATH,
    checkpoint_policy_sha256: hashFile(CHECKPOINT_POLICY_PATH),
    memory_smoke_path: MEMORY_SMOKE_PATH,
    memory_smoke_sha256: hashFile(MEMORY_SMOKE_PATH),
  },
  dataset: {
    path: DATASET_ROOT,
    manifest_sha256: hashFile(DATASET_MANIFEST_PATH),
    total_count: 94,
    train_count: dataset.train.count,
    validation_count: dataset.validation.count,
    train_sha256: dataset.train.sha256,
    validation_sha256: dataset.validation.sha256,
  },
  hyperparameters: {
    iterations,
    estimated_passes: 3,
    seed: 42,
    config_path: CONFIG,
    config_sha256: hashFile(CONFIG),
    training_wrapper_path: TRAINING_WRAPPER,
    training_wrapper_sha256: hashFile(TRAINING_WRAPPER),
    checkpoint_selector_path: CHECKPOINT_SELECTOR,
    checkpoint_selector_sha256: hashFile(CHECKPOINT_SELECTOR),
    mask_prompt: true,
    max_sequence_length: maxSequenceLength,
    steps_per_eval: stepsPerEval,
    save_every: saveEvery,
    checkpoint_selection_policy:
      "lowest validation loss among exact persisted validation-interval checkpoints; ties prefer earlier iteration",
  },
  evaluation_access: {
    protected_regression_used_for_training: false,
    sealed_unseen_questions_used_for_training: false,
    sealed_unseen_answers_accessed: false,
  },
};
writeJson(resolve(RUN_ROOT, "training-run-manifest.json"), manifest);

const logPath = resolve(RUN_ROOT, "training-output.log");
const log = createWriteStream(logPath, { flags: "wx" });
const child = spawn("bash", ["training/train_mlx.sh", DATASET_ROOT], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PENSION_TRAINING_PYTHON: PYTHON,
    PENSION_MLX_MODEL_PATH: MODEL_ROOT,
    PENSION_ADAPTER_PATH: ADAPTER_ROOT,
    PENSION_TRAINING_CONFIG: CONFIG,
    PENSION_TRAINING_ITERS: String(iterations),
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

const adapterFile = resolve(ADAPTER_ROOT, "adapters.safetensors");
const trainLoss = [...output.matchAll(/Iter\s+(\d+): Train loss\s+([0-9.]+)/g)].map(
  (match) => ({ iteration: Number(match[1]), loss: Number(match[2]) }),
);
const validationLoss = [
  ...output.matchAll(/Iter\s+(\d+): Val loss\s+([0-9.]+)/g),
].map((match) => ({ iteration: Number(match[1]), loss: Number(match[2]) }));
const persistedCheckpoints = readdirSync(ADAPTER_ROOT)
  .map((filename) => {
    const match = filename.match(/^(\d{7})_adapters\.safetensors$/);
    if (!match) return null;
    const path = resolve(ADAPTER_ROOT, filename);
    return {
      iteration: Number(match[1]),
      path,
      sha256: hashFile(path),
      size_bytes: statSync(path).size,
    };
  })
  .filter(Boolean)
  .sort((left, right) => left.iteration - right.iteration);
const completed =
  exitCode === 0 &&
  existsSync(adapterFile) &&
  trainLoss.at(-1)?.iteration === iterations;
manifest.status = completed ? "completed_selection_pending" : "failed";
manifest.completed_at = new Date().toISOString();
manifest.output_adapter.sha256 = existsSync(adapterFile)
  ? hashFile(adapterFile)
  : null;
manifest.output_adapter.size_bytes = existsSync(adapterFile)
  ? statSync(adapterFile).size
  : null;
manifest.metrics = {
  exit_code: exitCode,
  final_train_loss: trainLoss.at(-1)?.loss ?? null,
  final_validation_loss: validationLoss.at(-1)?.loss ?? null,
  train_loss: trainLoss,
  validation_loss: validationLoss,
  persisted_checkpoints: persistedCheckpoints,
  log_sha256: hashFile(logPath),
};
writeJson(resolve(RUN_ROOT, "training-run-manifest.json"), manifest);
console.log(JSON.stringify({ status: manifest.status, adapter: ADAPTER_ROOT }, null, 2));
if (!completed) process.exitCode = 1;
