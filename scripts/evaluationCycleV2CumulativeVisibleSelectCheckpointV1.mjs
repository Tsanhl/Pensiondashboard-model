import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const RUN_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_RUN_ROOT ||
    "training/evaluation-cycle-v2/25-cumulative-visible-training-v8-20260901",
);
const RUN_MANIFEST_PATH = resolve(RUN_ROOT, "training-run-manifest.json");
if (!existsSync(RUN_MANIFEST_PATH)) {
  throw new Error(`Training run manifest is missing: ${RUN_MANIFEST_PATH}`);
}
const readJson = (path) => JSON.parse(readFileSync(path));
const hashFile = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};

const manifest = readJson(RUN_MANIFEST_PATH);
if (manifest.status !== "completed_selection_pending") {
  throw new Error(`Checkpoint selection refuses run status: ${manifest.status}`);
}
const adapterRoot = resolve(manifest.output_adapter?.path || "");
const selectedAdapterRoot = resolve(
  process.env.CUMULATIVE_VISIBLE_SELECTED_ADAPTER_ROOT || `${adapterRoot}-selected`,
);
const selectionPath = resolve(RUN_ROOT, "checkpoint-selection.json");
if (existsSync(selectionPath)) {
  throw new Error(`Immutable checkpoint selection already exists: ${selectionPath}`);
}
if (existsSync(selectedAdapterRoot) && readdirSync(selectedAdapterRoot).length) {
  throw new Error(`Selected adapter output is not empty: ${selectedAdapterRoot}`);
}

const config = manifest.hyperparameters || {};
const iterations = Number(config.iterations);
const stepsPerEval = Number(config.steps_per_eval);
const saveEvery = Number(config.save_every);
if (
  !Number.isInteger(iterations) ||
  !Number.isInteger(stepsPerEval) ||
  !Number.isInteger(saveEvery) ||
  iterations <= 0 ||
  stepsPerEval <= 0 ||
  saveEvery !== stepsPerEval
) {
  throw new Error("Run manifest does not save at every validation interval");
}
const adapterConfig = resolve(adapterRoot, "adapter_config.json");
const finalAdapter = resolve(adapterRoot, "adapters.safetensors");
for (const path of [adapterConfig, finalAdapter]) {
  if (!existsSync(path)) throw new Error(`Adapter artifact is missing: ${path}`);
}
if (
  manifest.output_adapter?.sha256 !== hashFile(finalAdapter) ||
  manifest.output_adapter?.size_bytes !== statSync(finalAdapter).size
) {
  throw new Error("Final adapter no longer matches the completed training-run manifest");
}

const persisted = new Map();
for (const entry of manifest.metrics?.persisted_checkpoints || []) {
  const path = resolve(entry.path);
  if (
    !Number.isInteger(entry.iteration) ||
    !existsSync(path) ||
    hashFile(path) !== entry.sha256 ||
    statSync(path).size !== entry.size_bytes
  ) {
    throw new Error(`Persisted checkpoint manifest mismatch at iteration ${entry.iteration}`);
  }
  if (persisted.has(entry.iteration)) {
    throw new Error(`Duplicate persisted checkpoint iteration ${entry.iteration}`);
  }
  persisted.set(entry.iteration, { ...entry, path });
}
const expectedIntervals = [];
for (let iteration = stepsPerEval; iteration < iterations; iteration += stepsPerEval) {
  expectedIntervals.push(iteration);
}
const missingIntervalArtifacts = expectedIntervals.filter(
  (iteration) => !persisted.has(iteration),
);
if (missingIntervalArtifacts.length) {
  throw new Error(
    `Saved artifacts are missing for validation intervals: ${missingIntervalArtifacts.join(",")}`,
  );
}

const validationByIteration = new Map();
for (const entry of manifest.metrics?.validation_loss || []) {
  if (!Number.isInteger(entry.iteration) || !Number.isFinite(entry.loss)) continue;
  if (validationByIteration.has(entry.iteration)) {
    throw new Error(`Duplicate validation loss for iteration ${entry.iteration}`);
  }
  validationByIteration.set(entry.iteration, entry.loss);
}
const missingIntervalLosses = expectedIntervals.filter(
  (iteration) => !validationByIteration.has(iteration),
);
if (missingIntervalLosses.length) {
  throw new Error(
    `Validation loss is missing for saved intervals: ${missingIntervalLosses.join(",")}`,
  );
}

const candidates = expectedIntervals.map((iteration) => ({
  iteration,
  validation_loss: validationByIteration.get(iteration),
  source_checkpoint: persisted.get(iteration).path,
  sha256: persisted.get(iteration).sha256,
  size_bytes: persisted.get(iteration).size_bytes,
}));
if (validationByIteration.has(iterations)) {
  candidates.push({
    iteration: iterations,
    validation_loss: validationByIteration.get(iterations),
    source_checkpoint: finalAdapter,
    sha256: hashFile(finalAdapter),
    size_bytes: statSync(finalAdapter).size,
  });
}
if (!candidates.length) throw new Error("No persisted checkpoint has a validation loss");
candidates.sort(
  (left, right) =>
    left.validation_loss - right.validation_loss || left.iteration - right.iteration,
);
const selected = candidates[0];

mkdirSync(selectedAdapterRoot, { recursive: true });
const selectedWeights = resolve(selectedAdapterRoot, "adapters.safetensors");
const selectedConfig = resolve(selectedAdapterRoot, "adapter_config.json");
copyFileSync(selected.source_checkpoint, selectedWeights, fsConstants.COPYFILE_EXCL);
copyFileSync(adapterConfig, selectedConfig, fsConstants.COPYFILE_EXCL);
if (
  hashFile(selectedWeights) !== selected.sha256 ||
  hashFile(selectedConfig) !== hashFile(adapterConfig)
) {
  throw new Error("Copied selected adapter failed immutable hash verification");
}

const selection = {
  version: "cumulative-visible-checkpoint-selection-v1",
  selected_at: new Date().toISOString(),
  policy:
    "lowest validation loss among exact persisted validation-interval checkpoints; ties prefer earlier iteration",
  model_version:
    process.env.CUMULATIVE_VISIBLE_MODEL_VERSION ||
    "pension-assistant-cumulative-visible-compact-v8",
  selected_iteration: selected.iteration,
  selected_validation_loss: selected.validation_loss,
  source_checkpoint: selected.source_checkpoint,
  selected_adapter_path: selectedAdapterRoot,
  adapter_config_sha256: hashFile(selectedConfig),
  adapter_sha256: hashFile(selectedWeights),
  training_run_manifest_preselection_sha256: hashFile(RUN_MANIFEST_PATH),
  expected_validation_intervals: expectedIntervals,
  candidates,
};
writeJson(selectionPath, selection);

manifest.status = "completed_checkpoint_selected";
manifest.adapter_selection = {
  ...selection,
  checkpoint_selection_sha256: hashFile(selectionPath),
};
writeFileSync(RUN_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      status: manifest.status,
      selected_iteration: selection.selected_iteration,
      selected_validation_loss: selection.selected_validation_loss,
      selected_adapter_path: selection.selected_adapter_path,
      checkpoint_selection_sha256: hashFile(selectionPath),
    },
    null,
    2,
  ),
);
