import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { assertTrainingDatasetIntegrity } from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT = resolve("training/evaluation-cycle-v2/02-wave-2-execution");
const DATASET = resolve("training-data/private/evaluation-cycle-v2-wave-2-lora");
const DATASET_MANIFEST = resolve(DATASET, "dataset-manifest.json");
const APPROVAL = resolve(ROOT, "training/training-approval.json");
const RUN_ROOT = resolve(ROOT, "training/cumulative-lora-v1");
const MODEL = resolve("models/mlx/Qwen3-8B-4bit");
const BASE_ADAPTER = resolve("adapters/pension-assistant-v1-targeted-behaviour-selected/adapters.safetensors");
const ADAPTER = resolve("adapters/pension-assistant-v2-wave2-cumulative");
const PYTHON = resolve(".training-venv/bin/python");
const CONFIG = resolve("training/phase6_mlx_config.yaml");
assertTrainingDatasetIntegrity(DATASET);

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function hashFile(path) { return hash(readFileSync(path)); }
function hashLargeFile(path) {
  return new Promise((resolveHash, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(digest.digest("hex")));
  });
}
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

for (const path of [DATASET_MANIFEST, APPROVAL, resolve(MODEL, "model.safetensors"), BASE_ADAPTER, PYTHON, CONFIG]) {
  if (!existsSync(path)) throw new Error(`Wave 2 training prerequisite is missing: ${path}`);
}
const dataset = readJson(DATASET_MANIFEST);
const approval = readJson(APPROVAL);
if (approval.status !== "approved_for_cumulative_training" || approval.dataset_manifest_sha256 !== hashFile(DATASET_MANIFEST)) throw new Error("Wave 2 training approval does not match the frozen dataset manifest.");
if (dataset.train.count !== 27 || dataset.validation.count !== 6 || dataset.source_id_overlap.length) throw new Error("Wave 2 training dataset must be a 27/6 source-ID-disjoint split.");
if (dataset.protected_partitions.diagnostic_gold !== "excluded" || dataset.protected_partitions.sealed_unseen_questions !== "excluded") throw new Error("Protected partition exclusion failed.");
if (hashFile(resolve(DATASET, "train.jsonl")) !== dataset.train.sha256 || hashFile(resolve(DATASET, "valid.jsonl")) !== dataset.validation.sha256) throw new Error("Wave 2 JSONL hashes no longer match the manifest.");
if (existsSync(ADAPTER) && readdirSync(ADAPTER).length) throw new Error(`Wave 2 adapter path is not empty: ${ADAPTER}`);
mkdirSync(ADAPTER, { recursive: true });
mkdirSync(RUN_ROOT, { recursive: true });

const manifest = {
  version: "evaluation-cycle-v2-wave-2-cumulative-lora-run-v1",
  status: "running",
  started_at: new Date().toISOString(),
  completed_at: null,
  base_model: { path: MODEL, quantisation: "4-bit", model_sha256: await hashLargeFile(resolve(MODEL, "model.safetensors")) },
  resumed_adapter: { path: BASE_ADAPTER, sha256: hashFile(BASE_ADAPTER), selected_wave_1_iteration: 68 },
  output_adapter: { path: ADAPTER, sha256: null },
  dataset: { path: DATASET, manifest_sha256: hashFile(DATASET_MANIFEST), train_count: 27, validation_count: 6, diagnostic_excluded: true, unseen_excluded: true },
  approval: { path: APPROVAL, sha256: hashFile(APPROVAL) },
  hyperparameters: { framework: "mlx-lm", framework_version: "0.31.3", method: "cumulative QLoRA", iterations: 27, estimated_train_passes: 1, learning_rate: 0.00001, rank: 8, layers: 16, dropout: 0.05, scale: 20, max_sequence_length: 768, seed: 42, validation_every: 9, save_every: 9, early_stop_rationale: "Inherited adapter validation loss was already 0.072; one complete pass limits overfitting while preserving three post-update selection points." },
  hardware: { platform: os.platform(), architecture: os.arch(), memory_bytes: os.totalmem() },
  evaluation_access: { diagnostic_questions_used_as_training: false, diagnostic_gold_used_as_training: false, unseen_questions_accessed: false, unseen_gold_accessed: false },
};
writeJson(resolve(RUN_ROOT, "training-run-manifest.json"), manifest);

const logPath = resolve(RUN_ROOT, "training-output.log");
const log = createWriteStream(logPath, { flags: "wx" });
const args = ["-m", "mlx_lm", "lora", "--config", CONFIG, "--model", MODEL, "--train", "--data", DATASET, "--adapter-path", ADAPTER, "--resume-adapter-file", BASE_ADAPTER, "--iters", "27", "--steps-per-eval", "9", "--save-every", "9", "--seed", "42"];
const child = spawn(PYTHON, args, { cwd: resolve("."), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { const value = chunk.toString(); output += value; log.write(value); process.stdout.write(value); });
const exitCode = await new Promise((resolveExit, reject) => { child.on("error", reject); child.on("exit", (code) => resolveExit(code ?? 1)); });
await new Promise((resolveLog) => log.end(resolveLog));
const trainLoss = [...output.matchAll(/Iter\s+(\d+): Train loss\s+([0-9.]+)/g)].map((match) => ({ iteration: Number(match[1]), loss: Number(match[2]) }));
const validationLoss = [...output.matchAll(/Iter\s+(\d+): Val loss\s+([0-9.]+)/g)].map((match) => ({ iteration: Number(match[1]), loss: Number(match[2]) }));
const peakMemory = [...output.matchAll(/Peak mem\s+([0-9.]+)\s+GB/g)].map((match) => Number(match[1]));
const adapterFile = resolve(ADAPTER, "adapters.safetensors");
const completed = exitCode === 0 && existsSync(adapterFile) && trainLoss.at(-1)?.iteration === 27;
const metrics = { exit_code: exitCode, train_loss: trainLoss, validation_loss: validationLoss, final_train_loss: trainLoss.at(-1)?.loss ?? null, final_validation_loss: validationLoss.at(-1)?.loss ?? null, peak_memory_gb: peakMemory.length ? Math.max(...peakMemory) : null, output_sha256: hashFile(logPath) };
writeJson(resolve(RUN_ROOT, "training-log.json"), metrics);
manifest.status = completed ? "completed_checkpoint_selection_pending" : "failed";
manifest.completed_at = new Date().toISOString();
manifest.metrics = { final_train_loss: metrics.final_train_loss, final_validation_loss: metrics.final_validation_loss, peak_memory_gb: metrics.peak_memory_gb };
manifest.output_adapter.sha256 = existsSync(adapterFile) ? hashFile(adapterFile) : null;
writeJson(resolve(RUN_ROOT, "training-run-manifest.json"), manifest);
console.log(JSON.stringify({ status: manifest.status, train_reports: trainLoss.length, validation_reports: validationLoss.length, final_train_loss: metrics.final_train_loss, final_validation_loss: metrics.final_validation_loss, peak_memory_gb: metrics.peak_memory_gb, adapter: ADAPTER }, null, 2));
if (!completed) process.exitCode = 1;
