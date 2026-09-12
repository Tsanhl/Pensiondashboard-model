import {
  createReadStream,
  createWriteStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { assertTrainingDatasetIntegrity } from "./lib/trainingEvidenceIntegrity.mjs";

const CONFIRM = "owner_authorised_t4_clean_cumulative_20260902";
if (process.env.T4_LEGAL_TRAINING_CONFIRM !== CONFIRM) {
  throw new Error(`Training is locked. Set T4_LEGAL_TRAINING_CONFIRM=${CONFIRM}`);
}

const ROOT = resolve(".");
const RUN_ROOT = resolve(ROOT, "training/evaluation-cycle-v2/30-cumulative-legal-training-20260902");
const DATASET = resolve(ROOT, "training-data/private/evaluation-cycle-v2-cumulative-t4-legal-20260902");
const MODEL_ROOT = resolve(ROOT, "models/mlx/Qwen3-8B-4bit");
const CONFIG = resolve(ROOT, "training/cumulative_t4_legal_mlx_config_20260902.yaml");
const PYTHON = resolve(ROOT, ".training-venv/bin/python");
const WRAPPER = resolve(ROOT, "training/train_mlx.sh");
const ADAPTER_ROOT = resolve(ROOT, "adapters/pension-assistant-cumulative-t4-legal-v1");
const SMOKE_ADAPTER = resolve(ROOT, "adapters/quarantined-t4-legal-memory-smoke-20260902");
const SMOKE_DATA = resolve(RUN_ROOT, "mlx-memory-smoke-run-v1/longest-row-dataset");
const PINNED_BASE = "f2d29621aab300336ad645567ff38c42aac755513006ef4e8a579cf7ef5256d8";
const SELECTOR = resolve(ROOT, "scripts/evaluationCycleV2CumulativeVisibleSelectCheckpointV1.mjs");

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

const dataset = readJson(resolve(DATASET, "dataset-manifest.json"));
const tokens = readJson(resolve(RUN_ROOT, "final-token-and-loss-mask-preflight.json"));
const authorisation = readJson(resolve(RUN_ROOT, "training-authorisation.json"));
if (dataset.status !== "final_hash_bound_qualification_candidate" || dataset.training_authorised !== false) {
  throw new Error("Dataset is not a frozen pre-training candidate");
}
if (tokens.passed !== true || tokens.scope !== "final_hash_bound_dataset") {
  throw new Error("Tokenizer preflight has not passed");
}
if (authorisation.resume_step130 !== false || authorisation.sealed_unseen !== false) {
  throw new Error("Authorisation forbids resume-from-step130 or sealed unseen");
}
assertTrainingDatasetIntegrity(DATASET);
copyFileSync(resolve(RUN_ROOT, "final-token-and-loss-mask-preflight.json"), resolve(RUN_ROOT, "tokenizer-preflight.json"));

const baseHash = await hashLargeFile(resolve(MODEL_ROOT, "model.safetensors"));
if (baseHash !== PINNED_BASE) throw new Error("Pinned original base-model hash mismatch");

const abortStamp = new Date().toISOString().replace(/[:.]/g, "");
const abortArchive = resolve(RUN_ROOT, `aborted-incomplete-start-${abortStamp}`);
function archiveIncompleteProductionStart() {
  const adapterFiles = existsSync(ADAPTER_ROOT) ? readdirSync(ADAPTER_ROOT) : [];
  const weightFiles = adapterFiles.filter((name) => /adapters\.safetensors$/.test(name));
  if (weightFiles.length) {
    throw new Error(`Production adapter already has weights; refusing to restart: ${ADAPTER_ROOT}`);
  }
  const logPath = resolve(RUN_ROOT, "training-output.log");
  const manifestPath = resolve(RUN_ROOT, "training-run-manifest.json");
  const incomplete =
    adapterFiles.length > 0 ||
    existsSync(logPath) ||
    (existsSync(manifestPath) && readJson(manifestPath).status === "running");
  if (!incomplete) return false;
  mkdirSync(abortArchive, { recursive: true });
  const logTail = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").slice(-8).join("\n").slice(-500)
    : "";
  writeJson(resolve(abortArchive, "abort-record.json"), {
    version: "t4-legal-aborted-incomplete-start-v1",
    archived_at: new Date().toISOString(),
    reason: "tracked_shell_killed_before_any_train_checkpoint",
    not_a_second_training_run: true,
    resume_step130: false,
    weights_produced: false,
    last_observed: logTail,
  });
  if (existsSync(manifestPath)) copyFileSync(manifestPath, resolve(abortArchive, "training-run-manifest.json"));
  if (existsSync(logPath)) renameSync(logPath, resolve(abortArchive, "training-output.log"));
  for (const name of adapterFiles) {
    renameSync(resolve(ADAPTER_ROOT, name), resolve(abortArchive, name));
  }
  return true;
}
archiveIncompleteProductionStart();
if (existsSync(ADAPTER_ROOT) && readdirSync(ADAPTER_ROOT).length) {
  throw new Error(`Production adapter output is not empty: ${ADAPTER_ROOT}`);
}

const rowsById = new Map([
  ...readFileSync(resolve(DATASET, "train.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  ...readFileSync(resolve(DATASET, "valid.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
].map((row) => [row.metadata.training_id, row]));
const longest = (partition) =>
  [...(tokens.rows || [])]
    .filter((entry) => entry.partition === partition && entry.passed === true)
    .sort((a, b) => b.total_tokens - a.total_tokens || a.training_id.localeCompare(b.training_id))[0];
const longestTrain = longest("train");
const longestValid = longest("validation");
mkdirSync(SMOKE_DATA, { recursive: true });
const smokeTrainPath = resolve(SMOKE_DATA, "train.jsonl");
const smokeValidPath = resolve(SMOKE_DATA, "valid.jsonl");
if (!existsSync(smokeTrainPath)) {
  writeFileSync(smokeTrainPath, `${JSON.stringify(rowsById.get(longestTrain.training_id))}\n`, { flag: "wx" });
}
if (!existsSync(smokeValidPath)) {
  writeFileSync(smokeValidPath, `${JSON.stringify(rowsById.get(longestValid.training_id))}\n`, { flag: "wx" });
}
mkdirSync(SMOKE_ADAPTER, { recursive: true });

async function runMlx({ adapter, data, iters, logPath }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "wx" });
  const child = spawn("bash", [WRAPPER, data], {
    cwd: ROOT,
    env: {
      ...process.env,
      PENSION_TRAINING_PYTHON: PYTHON,
      PENSION_MLX_MODEL_PATH: MODEL_ROOT,
      PENSION_ADAPTER_PATH: adapter,
      PENSION_TRAINING_CONFIG: CONFIG,
      PENSION_TRAINING_ITERS: String(iters),
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
  await new Promise((done) => log.end(done));
  return { exitCode, output, logPath };
}

const smokeReportPath = resolve(RUN_ROOT, "memory-smoke.json");
const existingSmoke = existsSync(smokeReportPath) ? readJson(smokeReportPath) : null;
const smokeAlreadyPassed =
  existingSmoke?.passed === true &&
  existingSmoke?.status === "passed_quarantined_smoke_only" &&
  Number(existingSmoke.peak_memory_gb) > 0 &&
  Number(existingSmoke.peak_memory_gb) <= 14 &&
  existingSmoke.exit_code === 0;
if (!smokeAlreadyPassed) {
  const smoke = await runMlx({
    adapter: SMOKE_ADAPTER,
    data: SMOKE_DATA,
    iters: 1,
    logPath: resolve(RUN_ROOT, "mlx-memory-smoke-run-v1/training-output.log"),
  });
  const peak = Math.max(0, ...[...smoke.output.matchAll(/Peak mem\s+([0-9.]+)\s+GB/g)].map((m) => Number(m[1])));
  const smokePassed = smoke.exitCode === 0 && /Iter\s+1:\s+Train loss/.test(smoke.output) && peak > 0 && peak <= 14;
  writeJson(smokeReportPath, {
    version: "t4-legal-quarantined-memory-smoke-v1",
    passed: smokePassed,
    status: smokePassed ? "passed_quarantined_smoke_only" : "failed",
    training_started: true,
    production_training_started: false,
    training_authorised: false,
    release_authorised: false,
    unseen_accessed: false,
    peak_memory_gb: peak,
    safety_ceiling_gb: 14,
    exit_code: smoke.exitCode,
    longest_train: longestTrain.training_id,
    longest_validation: longestValid.training_id,
    quarantine: { adapter_path: SMOKE_ADAPTER, permitted_use: "memory_smoke_only_never_inference_evaluation_or_resume" },
    clean_start: true,
    resume_step130: false,
  });
  if (!smokePassed) throw new Error(`Memory smoke failed: exit ${smoke.exitCode} peak ${peak}`);
}

const iterations = dataset.train.count * 3;
mkdirSync(ADAPTER_ROOT, { recursive: true });
const trainManifest = {
  version: "t4-legal-clean-mlx-run-v1",
  status: "running",
  started_at: new Date().toISOString(),
  restart_after_incomplete_abort: existsSync(abortArchive),
  abort_archive: existsSync(abortArchive) ? abortArchive : null,
  clean_start: true,
  historical_adapter_input: null,
  resume_step130: false,
  base_model: { path: MODEL_ROOT, sha256: baseHash },
  dataset: {
    path: DATASET,
    total_count: dataset.total_count,
    train_count: dataset.train.count,
    validation_count: dataset.validation.count,
    train_sha256: dataset.train.sha256,
    validation_sha256: dataset.validation.sha256,
  },
  hyperparameters: {
    iterations,
    seed: 42,
    config_path: CONFIG,
    config_sha256: hashFile(CONFIG),
    steps_per_eval: 26,
    save_every: 26,
    max_sequence_length: 2112,
    mask_prompt: true,
    checkpoint_selection_policy: "lowest validation loss among exact persisted validation-interval checkpoints; ties prefer earlier iteration",
  },
  evaluation_access: {
    sealed_unseen_questions_used_for_training: false,
    sealed_unseen_answers_accessed: false,
  },
  output_adapter: { path: ADAPTER_ROOT, sha256: null },
};
writeJson(resolve(RUN_ROOT, "training-run-manifest.json"), trainManifest);

const trained = await runMlx({
  adapter: ADAPTER_ROOT,
  data: DATASET,
  iters: iterations,
  logPath: resolve(RUN_ROOT, "training-output.log"),
});
const adapterFile = resolve(ADAPTER_ROOT, "adapters.safetensors");
const trainLoss = [...trained.output.matchAll(/Iter\s+(\d+): Train loss\s+([0-9.]+)/g)].map((m) => ({ iteration: Number(m[1]), loss: Number(m[2]) }));
const validationLoss = [...trained.output.matchAll(/Iter\s+(\d+): Val loss\s+([0-9.]+)/g)].map((m) => ({ iteration: Number(m[1]), loss: Number(m[2]) }));
const persisted = readdirSync(ADAPTER_ROOT).map((filename) => {
  const match = filename.match(/^(\d{7})_adapters\.safetensors$/);
  if (!match) return null;
  const path = resolve(ADAPTER_ROOT, filename);
  return { iteration: Number(match[1]), path, sha256: hashFile(path), size_bytes: statSync(path).size };
}).filter(Boolean).sort((a, b) => a.iteration - b.iteration);
const nan = /nan/i.test(trained.output);
const oom = /out of memory|metal.*oom/i.test(trained.output);
const completed = trained.exitCode === 0 && existsSync(adapterFile) && trainLoss.at(-1)?.iteration === iterations && !nan;
trainManifest.status = completed ? "completed_selection_pending" : (oom ? "failed_oom_selection_pending_if_schedule_complete" : "failed");
trainManifest.completed_at = new Date().toISOString();
trainManifest.output_adapter.sha256 = existsSync(adapterFile) ? hashFile(adapterFile) : null;
trainManifest.output_adapter.size_bytes = existsSync(adapterFile) ? statSync(adapterFile).size : null;
trainManifest.metrics = {
  exit_code: trained.exitCode,
  nan,
  oom,
  train_loss: trainLoss,
  validation_loss: validationLoss,
  persisted_checkpoints: persisted,
  log_sha256: hashFile(resolve(RUN_ROOT, "training-output.log")),
};
writeJson(resolve(RUN_ROOT, "training-run-manifest.json"), trainManifest);
if (!completed && !persisted.length) throw new Error("Training produced no usable checkpoint");

if (completed) {
  process.env.CUMULATIVE_VISIBLE_RUN_ROOT = RUN_ROOT;
  process.env.CUMULATIVE_VISIBLE_SELECTED_ADAPTER_ROOT = `${ADAPTER_ROOT}-selected`;
  process.env.CUMULATIVE_VISIBLE_MODEL_VERSION = "pension-assistant-cumulative-t4-legal-v1";
  const select = spawn(process.execPath, [SELECTOR], { cwd: ROOT, env: process.env, stdio: "inherit" });
  const code = await new Promise((resolveExit) => select.on("exit", (c) => resolveExit(c ?? 1)));
  if (code !== 0) throw new Error(`Checkpoint selection failed: ${code}`);
}

console.log(JSON.stringify({
  state: completed ? "CHECKPOINT_SELECTION" : trainManifest.status,
  iterations,
  exit: trained.exitCode,
  checkpoints: persisted.map((item) => item.iteration),
  val_loss: validationLoss,
}, null, 2));
