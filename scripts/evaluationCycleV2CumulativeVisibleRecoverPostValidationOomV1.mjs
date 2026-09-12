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
import { fileURLToPath } from "node:url";

const CONFIRMATION =
  "owner_authorised_select_verified_pre_oom_checkpoint_v1";
if (
  process.env.CUMULATIVE_VISIBLE_POST_VALIDATION_OOM_SELECTION_CONFIRM !==
  CONFIRMATION
) {
  throw new Error(
    "Post-validation OOM recovery is locked. Supply the exact owner confirmation only after reviewing the failed execution.",
  );
}

const RUN_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_RUN_ROOT ||
    "training/evaluation-cycle-v2/25-cumulative-visible-training-v8-20260901",
);
const RUN_MANIFEST_PATH = resolve(RUN_ROOT, "training-run-manifest.json");
const LOG_PATH = resolve(RUN_ROOT, "training-output.log");
const ORIGINAL_SELECTOR_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleSelectCheckpointV1.mjs",
);
const RECOVERY_SCRIPT_PATH = fileURLToPath(import.meta.url);
const OWNER_RECOVERY_AUTHORISATION_PATH = resolve(
  RUN_ROOT,
  "owner-post-final-validation-oom-selection-authorisation-v2.json",
);
const EXACT_POSTHOC_VALIDATION_PATH = resolve(
  RUN_ROOT,
  "exact-posthoc-checkpoint-validation-v2/exact-posthoc-validation.json",
);
const FAILED_MANIFEST_SNAPSHOT_PATH = resolve(
  RUN_ROOT,
  "training-run-manifest.failed-preselection.json",
);
const RECOVERY_RECORD_PATH = resolve(
  RUN_ROOT,
  "post-final-validation-oom-selection-authorisation.json",
);
const SELECTION_PATH = resolve(RUN_ROOT, "checkpoint-selection.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const hashFile = (path) => sha256(readFileSync(path));
const writeJsonExclusive = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};
const requireFile = (path, label) => {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
};

for (const [path, label] of [
  [RUN_MANIFEST_PATH, "Failed training-run manifest"],
  [LOG_PATH, "Failed training log"],
  [ORIGINAL_SELECTOR_PATH, "Original approved checkpoint selector"],
  [RECOVERY_SCRIPT_PATH, "Recovery selector"],
  [OWNER_RECOVERY_AUTHORISATION_PATH, "Owner recovery authorisation"],
  [EXACT_POSTHOC_VALIDATION_PATH, "Exact post-hoc checkpoint validation"],
]) {
  requireFile(path, label);
}
for (const path of [
  FAILED_MANIFEST_SNAPSHOT_PATH,
  RECOVERY_RECORD_PATH,
  SELECTION_PATH,
]) {
  if (existsSync(path)) throw new Error(`Immutable recovery output already exists: ${path}`);
}

const manifestPreselectionSha = hashFile(RUN_MANIFEST_PATH);
const manifest = readJson(RUN_MANIFEST_PATH);
if (
  manifest.version !== "cumulative-visible-clean-mlx-run-v1" ||
  manifest.status !== "failed" ||
  manifest.clean_start !== true ||
  manifest.metrics?.exit_code !== 1 ||
  manifest.evaluation_access?.sealed_unseen_questions_used_for_training !== false ||
  manifest.evaluation_access?.sealed_unseen_answers_accessed !== false
) {
  throw new Error("Recovery requires the exact failed clean cumulative-visible run contract.");
}

const config = manifest.hyperparameters || {};
const iterations = Number(config.iterations);
const stepsPerEval = Number(config.steps_per_eval);
const saveEvery = Number(config.save_every);
if (
  iterations !== 228 ||
  stepsPerEval !== 26 ||
  saveEvery !== 26 ||
  config.estimated_passes !== 3 ||
  config.seed !== 42 ||
  config.mask_prompt !== true ||
  config.max_sequence_length !== 2112
) {
  throw new Error("Failed run is not the exact approved 228-step/26-step-validation training schedule.");
}
if (
  config.checkpoint_selector_sha256 !== hashFile(ORIGINAL_SELECTOR_PATH) ||
  resolve(config.checkpoint_selector_path || "") !== ORIGINAL_SELECTOR_PATH ||
  manifest.dataset?.total_count !== 94 ||
  manifest.dataset?.train_count !== 76 ||
  manifest.dataset?.validation_count !== 18 ||
  manifest.historical_adapter_input !== null ||
  manifest.evaluation_access?.protected_regression_used_for_training !== false
) {
  throw new Error("Failed run provenance no longer matches its approved selector or 94-record split.");
}

const expectedIntervals = [26, 52, 78, 104, 130, 156, 182, 208];
const finalPlannedValidationIteration = expectedIntervals.at(-1);
const expectedValidationIterations = [1, ...expectedIntervals];
const expectedTrainIterations = Array.from({ length: 44 }, (_, index) =>
  (index + 1) * 5,
);

const boundFile = (record, label) => {
  const path = resolve(record?.path || "");
  requireFile(path, label);
  if (hashFile(path) !== record?.sha256) {
    throw new Error(`${label} no longer matches the failed-run manifest.`);
  }
  return { path, value: readJson(path) };
};
const ownerDevelopment = boundFile(
  {
    path: manifest.qualification?.owner_authorisation_path,
    sha256: manifest.qualification?.owner_authorisation_sha256,
  },
  "Original owner development authorisation",
);
const qualificationGate = boundFile(
  {
    path: manifest.qualification?.gate_path,
    sha256: manifest.qualification?.gate_sha256,
  },
  "Original cumulative qualification gate",
);
const provenance = boundFile(
  {
    path: manifest.qualification?.provenance_path,
    sha256: manifest.qualification?.provenance_sha256,
  },
  "Clean-start provenance",
);
const checkpointPolicy = boundFile(
  {
    path: manifest.qualification?.checkpoint_policy_path,
    sha256: manifest.qualification?.checkpoint_policy_sha256,
  },
  "Original checkpoint policy",
);
const memorySmoke = boundFile(
  {
    path: manifest.qualification?.memory_smoke_path,
    sha256: manifest.qualification?.memory_smoke_sha256,
  },
  "Longest-row memory smoke",
);
if (
  ownerDevelopment.value.owner_authorisation_recorded !== true ||
  ownerDevelopment.value.release_authorised !== false ||
  qualificationGate.value.passed !== true ||
  qualificationGate.value.training_authorised !== true ||
  qualificationGate.value.release_authorised !== false ||
  provenance.value.passed !== true ||
  provenance.value.clean_start_policy?.historical_v1_wave2_wave3_adapters_used !== false ||
  checkpointPolicy.value.iterations !== 228 ||
  checkpointPolicy.value.steps_per_eval !== 26 ||
  checkpointPolicy.value.save_every !== 26 ||
  memorySmoke.value.passed !== true ||
  memorySmoke.value.status !== "passed_quarantined_smoke_only" ||
  memorySmoke.value.runtime?.max_sequence_length !== 2112 ||
  memorySmoke.value.unseen_accessed !== false
) {
  throw new Error("The original owner, clean-start, checkpoint or memory-smoke qualification chain is not intact.");
}

for (const [path, expectedSha, label] of [
  [config.config_path, config.config_sha256, "Training config"],
  [config.training_wrapper_path, config.training_wrapper_sha256, "Training wrapper"],
]) {
  const resolved = resolve(path || "");
  requireFile(resolved, label);
  if (hashFile(resolved) !== expectedSha) {
    throw new Error(`${label} no longer matches the failed run.`);
  }
}
const datasetRoot = resolve(manifest.dataset?.path || "");
const datasetManifestPath = resolve(datasetRoot, "dataset-manifest.json");
const trainPath = resolve(datasetRoot, "train.jsonl");
const validPath = resolve(datasetRoot, "valid.jsonl");
for (const [path, expectedSha, label] of [
  [datasetManifestPath, manifest.dataset?.manifest_sha256, "Dataset manifest"],
  [trainPath, manifest.dataset?.train_sha256, "Training split"],
  [validPath, manifest.dataset?.validation_sha256, "Validation split"],
]) {
  requireFile(path, label);
  if (hashFile(path) !== expectedSha) throw new Error(`${label} hash changed after training.`);
}
const datasetManifest = readJson(datasetManifestPath);
if (
  datasetManifest.total_count !== 94 ||
  datasetManifest.train?.count !== 76 ||
  datasetManifest.validation?.count !== 18 ||
  datasetManifest.protected_sets?.sealed_unseen_accessed !== false
) {
  throw new Error("The clean cumulative dataset manifest is no longer the approved 94/76/18 split.");
}
const baseRoot = resolve(manifest.base_model?.path || "");
for (const [path, expectedSha, label] of [
  [resolve(baseRoot, "config.json"), manifest.base_model?.config_sha256, "Base model config"],
  [resolve(baseRoot, "tokenizer.json"), manifest.base_model?.tokenizer_sha256, "Base tokenizer"],
]) {
  requireFile(path, label);
  if (hashFile(path) !== expectedSha) throw new Error(`${label} changed after training.`);
}
const baseWeights = resolve(baseRoot, "model.safetensors");
requireFile(baseWeights, "Base model weights");
if (statSync(baseWeights).size !== manifest.base_model?.model_size_bytes) {
  throw new Error("Base model weight size changed after training.");
}

const persisted = new Map();
for (const entry of manifest.metrics?.persisted_checkpoints || []) {
  const path = resolve(entry.path || "");
  if (
    !Number.isInteger(entry.iteration) ||
    !existsSync(path) ||
    hashFile(path) !== entry.sha256 ||
    statSync(path).size !== entry.size_bytes ||
    persisted.has(entry.iteration)
  ) {
    throw new Error(`Persisted checkpoint mismatch at iteration ${entry.iteration}`);
  }
  persisted.set(entry.iteration, { ...entry, path });
}
const validation = new Map();
for (const entry of manifest.metrics?.validation_loss || []) {
  if (
    !Number.isInteger(entry.iteration) ||
    !Number.isFinite(entry.loss) ||
    validation.has(entry.iteration)
  ) {
    throw new Error("Validation-loss history is malformed or duplicated.");
  }
  validation.set(entry.iteration, entry.loss);
}
if (
  JSON.stringify([...validation.keys()]) !==
    JSON.stringify(expectedValidationIterations)
) {
  throw new Error("Validation-loss history is not exactly baseline plus all eight planned intervals.");
}
for (const iteration of expectedIntervals) {
  if (!persisted.has(iteration) || !validation.has(iteration)) {
    throw new Error(
      `Recovery refuses an incomplete planned validation interval: ${iteration}`,
    );
  }
}
if (
  persisted.size !== expectedIntervals.length ||
  [...persisted.keys()].some((iteration) => !expectedIntervals.includes(iteration))
) {
  throw new Error("Persisted checkpoint set is not exactly the planned interval set.");
}

const trainHistory = manifest.metrics?.train_loss || [];
const trainIterations = [];
const seenTrainIterations = new Set();
for (const entry of trainHistory) {
  if (
    !Number.isInteger(entry?.iteration) ||
    !Number.isFinite(entry?.loss) ||
    seenTrainIterations.has(entry.iteration)
  ) {
    throw new Error("Train-loss history is malformed, non-finite or duplicated.");
  }
  seenTrainIterations.add(entry.iteration);
  trainIterations.push(entry.iteration);
}
if (JSON.stringify(trainIterations) !== JSON.stringify(expectedTrainIterations)) {
  throw new Error("Train-loss history is not exactly the 44 reports from step 5 through step 220.");
}
const lastTrain = trainHistory.at(-1);
if (
  lastTrain.iteration !== 220 ||
  lastTrain.iteration < finalPlannedValidationIteration ||
  lastTrain.iteration >= iterations ||
  manifest.metrics?.final_train_loss !== lastTrain.loss ||
  validation.get(finalPlannedValidationIteration) !==
    manifest.metrics?.final_validation_loss
) {
  throw new Error("OOM did not occur strictly after the complete planned validation schedule.");
}

const log = readFileSync(LOG_PATH, "utf8");
const logTrainHistory = [
  ...log.matchAll(/Iter\s+(\d+): Train loss\s+([0-9.]+)/g),
].map((match) => ({ iteration: Number(match[1]), loss: Number(match[2]) }));
const logValidationHistory = [
  ...log.matchAll(/Iter\s+(\d+): Val loss\s+([0-9.]+)/g),
].map((match) => ({ iteration: Number(match[1]), loss: Number(match[2]) }));
const logSaveIterations = [
  ...log.matchAll(/Iter\s+(\d+): Saved adapter weights to\s+/g),
].map((match) => Number(match[1]));
const exactOom =
  /RuntimeError: \[METAL\] Command buffer execution failed: Insufficient Memory \(00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory\)\./;
if (
  hashFile(LOG_PATH) !== manifest.metrics?.log_sha256 ||
  JSON.stringify(logTrainHistory) !== JSON.stringify(trainHistory) ||
  JSON.stringify(logValidationHistory) !==
    JSON.stringify(manifest.metrics?.validation_loss) ||
  JSON.stringify(logSaveIterations) !== JSON.stringify(expectedIntervals) ||
  !exactOom.test(log) ||
  !log.trimEnd().endsWith(
    "RuntimeError: [METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory).",
  )
) {
  throw new Error("Failed log is not the exact hash-bound post-validation Metal OOM failure.");
}

const adapterRoot = resolve(manifest.output_adapter?.path || "");
const finalAdapter = resolve(adapterRoot, "adapters.safetensors");
const adapterConfig = resolve(adapterRoot, "adapter_config.json");
for (const [path, label] of [
  [finalAdapter, "Last saved adapter"],
  [adapterConfig, "Adapter config"],
]) {
  requireFile(path, label);
}
const finalPersisted = persisted.get(finalPlannedValidationIteration);
const adapterConfigValue = readJson(adapterConfig);
if (
  hashFile(finalAdapter) !== finalPersisted.sha256 ||
  manifest.output_adapter?.sha256 !== finalPersisted.sha256 ||
  statSync(finalAdapter).size !== finalPersisted.size_bytes
) {
  throw new Error("Post-failure adapter is not byte-identical to the final planned validation checkpoint.");
}
if (
  resolve(adapterConfigValue.adapter_path || "") !== adapterRoot ||
  resolve(adapterConfigValue.data || "") !== datasetRoot ||
  resolve(adapterConfigValue.model || "") !== baseRoot ||
  resolve(adapterConfigValue.config || "") !== resolve(config.config_path) ||
  adapterConfigValue.resume_adapter_file !== null ||
  adapterConfigValue.iters !== 228 ||
  adapterConfigValue.seed !== 42 ||
  adapterConfigValue.max_seq_length !== 2112 ||
  adapterConfigValue.mask_prompt !== true ||
  adapterConfigValue.save_every !== 26 ||
  adapterConfigValue.steps_per_eval !== 26 ||
  adapterConfigValue.num_layers !== 16 ||
  adapterConfigValue.lora_parameters?.rank !== 8 ||
  adapterConfigValue.lora_parameters?.dropout !== 0.05 ||
  adapterConfigValue.lora_parameters?.scale !== 20
) {
  throw new Error("Adapter config does not prove the exact clean-start cumulative run with no resume adapter.");
}

const exactPosthoc = readJson(EXACT_POSTHOC_VALIDATION_PATH);
if (
  exactPosthoc.version !==
    "cumulative-visible-exact-posthoc-checkpoint-validation-v1" ||
  exactPosthoc.status !== "passed_selection_ready" ||
  exactPosthoc.passed !== true ||
  exactPosthoc.training_execution_completed !== false ||
  exactPosthoc.full_scheduled_iterations_completed !== false ||
  exactPosthoc.selection_authorised !== false ||
  exactPosthoc.visible_evaluation_authorised !== false ||
  exactPosthoc.sealed_unseen_authorised !== false ||
  exactPosthoc.release_authorised !== false ||
  exactPosthoc.training_time_validation_used_for_selection !== false ||
  exactPosthoc.sealed_unseen_accessed !== false ||
  exactPosthoc.bindings?.failed_training_manifest_sha256 !==
    manifestPreselectionSha ||
  exactPosthoc.bindings?.failed_training_log_sha256 !== hashFile(LOG_PATH) ||
  exactPosthoc.bindings?.validation_sha256 !==
    manifest.dataset.validation_sha256 ||
  exactPosthoc.bindings?.base_model_sha256 !==
    manifest.base_model.model_sha256 ||
  exactPosthoc.bindings?.base_config_sha256 !==
    manifest.base_model.config_sha256 ||
  exactPosthoc.bindings?.tokenizer_sha256 !==
    manifest.base_model.tokenizer_sha256 ||
  exactPosthoc.bindings?.adapter_config_sha256 !== hashFile(adapterConfig) ||
  exactPosthoc.runtime?.mlx_lm_version !== "0.31.3" ||
  exactPosthoc.runtime?.examples !== 18 ||
  exactPosthoc.runtime?.completion_tokens !== 2077 ||
  exactPosthoc.runtime?.max_total_tokens !== 1958 ||
  exactPosthoc.runtime?.max_seq_length !== 2112 ||
  exactPosthoc.runtime?.mask_prompt !== true ||
  exactPosthoc.runtime?.batch_size !== 1 ||
  !Array.isArray(exactPosthoc.results) ||
  exactPosthoc.results.length !== expectedIntervals.length ||
  JSON.stringify(exactPosthoc.results.map((entry) => entry.iteration)) !==
    JSON.stringify(expectedIntervals)
) {
  throw new Error("Exact post-hoc checkpoint validation is incomplete, overbroad or bound to different bytes.");
}
const exactByIteration = new Map();
for (const entry of exactPosthoc.results) {
  const checkpoint = persisted.get(entry.iteration);
  const resultPath = resolve(
    dirname(EXACT_POSTHOC_VALIDATION_PATH),
    `checkpoint-${String(entry.iteration).padStart(7, "0")}.json`,
  );
  requireFile(resultPath, `Exact checkpoint ${entry.iteration} result`);
  const result = readJson(resultPath);
  if (
    entry.checkpoint_sha256 !== checkpoint.sha256 ||
    entry.result_sha256 !== hashFile(resultPath) ||
    result.status !== "passed" ||
    result.iteration !== entry.iteration ||
    result.checkpoint_sha256 !== checkpoint.sha256 ||
    result.validation_sha256 !== manifest.dataset.validation_sha256 ||
    result.evaluator_sha256 !== exactPosthoc.bindings.evaluator_sha256 ||
    result.log_sha256 !== entry.log_sha256 ||
    result.exact_validation_loss !== entry.exact_validation_loss ||
    result.exact_validation_loss_decimal !==
      entry.exact_validation_loss_decimal ||
    result.runtime?.examples !== 18 ||
    result.runtime?.completion_tokens !== 2077 ||
    result.runtime?.max_total_tokens !== 1958 ||
    !Number.isFinite(entry.exact_validation_loss) ||
    exactByIteration.has(entry.iteration)
  ) {
    throw new Error(`Exact checkpoint ${entry.iteration} result failed its hash/runtime contract.`);
  }
  exactByIteration.set(entry.iteration, entry);
}

const candidates = expectedIntervals.map((iteration) => ({
  iteration,
  validation_loss: exactByIteration.get(iteration).exact_validation_loss,
  validation_loss_decimal:
    exactByIteration.get(iteration).exact_validation_loss_decimal,
  validation_method:
    "direct_post_update_checkpoint_full_precision_masked_completion_loss",
  training_log_pre_update_validation_loss: validation.get(iteration),
  source_checkpoint: persisted.get(iteration).path,
  sha256: persisted.get(iteration).sha256,
  size_bytes: persisted.get(iteration).size_bytes,
}));
candidates.sort(
  (left, right) =>
    left.validation_loss - right.validation_loss ||
    left.iteration - right.iteration,
);
const selected = candidates[0];
if (
  !Number.isFinite(selected.validation_loss) ||
  selected.iteration !== exactPosthoc.selected_iteration ||
  selected.validation_loss !== exactPosthoc.selected_exact_validation_loss ||
  selected.validation_loss_decimal !==
    exactPosthoc.selected_exact_validation_loss_decimal
) {
  throw new Error("Recovery did not identify a finite validated checkpoint.");
}

const ownerRecovery = readJson(OWNER_RECOVERY_AUTHORISATION_PATH);
const expectedOwnerBindings = {
  failed_training_run_manifest_sha256: manifestPreselectionSha,
  failed_training_log_sha256: hashFile(LOG_PATH),
  recovery_selector_sha256: hashFile(RECOVERY_SCRIPT_PATH),
  exact_posthoc_validation_sha256: hashFile(EXACT_POSTHOC_VALIDATION_PATH),
  exact_posthoc_evaluator_sha256:
    exactPosthoc.bindings.evaluator_sha256,
  original_approved_selector_sha256: hashFile(ORIGINAL_SELECTOR_PATH),
  owner_development_authorisation_sha256:
    manifest.qualification.owner_authorisation_sha256,
  qualification_gate_sha256: manifest.qualification.gate_sha256,
  clean_start_provenance_sha256: manifest.qualification.provenance_sha256,
  checkpoint_policy_sha256:
    manifest.qualification.checkpoint_policy_sha256,
  memory_smoke_sha256: manifest.qualification.memory_smoke_sha256,
  dataset_manifest_sha256: manifest.dataset.manifest_sha256,
  training_split_sha256: manifest.dataset.train_sha256,
  validation_split_sha256: manifest.dataset.validation_sha256,
  config_sha256: config.config_sha256,
  training_wrapper_sha256: config.training_wrapper_sha256,
  selected_source_checkpoint_sha256: selected.sha256,
  final_planned_validation_checkpoint_sha256: finalPersisted.sha256,
};
if (
  ownerRecovery.version !==
    "owner-post-final-validation-oom-selection-authorisation-v2" ||
  ownerRecovery.status !==
    "owner_authorised_selection_only_from_failed_post_validation_oom" ||
  ownerRecovery.selection_authorised !== true ||
  ownerRecovery.visible_evaluation_authorised !== false ||
  ownerRecovery.sealed_unseen_authorised !== false ||
  ownerRecovery.release_authorised !== false ||
  ownerRecovery.training_execution_completed !== false ||
  ownerRecovery.full_scheduled_iterations_completed !== false ||
  ownerRecovery.unseen_accessed !== false ||
  ownerRecovery.planned_iterations !== 228 ||
  ownerRecovery.last_reported_train_iteration !== 220 ||
  ownerRecovery.final_planned_validation_iteration !== 208 ||
  ownerRecovery.selected_iteration !== selected.iteration ||
  ownerRecovery.selected_validation_loss !== selected.validation_loss ||
  ownerRecovery.selected_validation_loss_decimal !==
    selected.validation_loss_decimal ||
  JSON.stringify(ownerRecovery.expected_validation_intervals) !==
    JSON.stringify(expectedIntervals) ||
  Object.entries(expectedOwnerBindings).some(
    ([name, expected]) => ownerRecovery.bindings?.[name] !== expected,
  )
) {
  throw new Error("Owner recovery authorisation is absent, overbroad or not bound to this exact failed run.");
}

copyFileSync(
  RUN_MANIFEST_PATH,
  FAILED_MANIFEST_SNAPSHOT_PATH,
  fsConstants.COPYFILE_EXCL,
);
if (hashFile(FAILED_MANIFEST_SNAPSHOT_PATH) !== manifestPreselectionSha) {
  throw new Error("Immutable failed-manifest snapshot does not match the preselection bytes.");
}

const selectedAdapterRoot = resolve(
  process.env.CUMULATIVE_VISIBLE_SELECTED_ADAPTER_ROOT ||
    `${adapterRoot}-selected`,
);
if (
  existsSync(selectedAdapterRoot) &&
  readdirSync(selectedAdapterRoot).length
) {
  throw new Error(`Selected adapter output is not empty: ${selectedAdapterRoot}`);
}
mkdirSync(selectedAdapterRoot, { recursive: true });
const selectedWeights = resolve(selectedAdapterRoot, "adapters.safetensors");
const selectedConfig = resolve(selectedAdapterRoot, "adapter_config.json");
copyFileSync(
  selected.source_checkpoint,
  selectedWeights,
  fsConstants.COPYFILE_EXCL,
);
copyFileSync(adapterConfig, selectedConfig, fsConstants.COPYFILE_EXCL);
if (
  hashFile(selectedWeights) !== selected.sha256 ||
  hashFile(selectedConfig) !== hashFile(adapterConfig)
) {
  throw new Error("Copied pre-OOM selected adapter failed immutable hash verification.");
}

const recoveryRecord = {
  version: "cumulative-visible-post-validation-oom-selection-authorisation-v2",
  recorded_at: new Date().toISOString(),
  status: "owner_authorised_checkpoint_selection_from_failed_execution",
  training_execution_completed: false,
  full_scheduled_iterations_completed: false,
  selection_authorised: true,
  visible_evaluation_authorised: false,
  sealed_unseen_authorised: false,
  release_authorised: false,
  failure_classification: "metal_oom_after_complete_planned_validation_schedule",
  planned_iterations: iterations,
  last_reported_train_iteration: lastTrain.iteration,
  final_planned_validation_iteration: finalPlannedValidationIteration,
  selected_iteration: selected.iteration,
  selected_validation_loss: selected.validation_loss,
  selected_validation_loss_decimal: selected.validation_loss_decimal,
  rationale:
    "Every saved interval checkpoint was directly re-evaluated after training on the unchanged 18-record masked-completion validation split because MLX-LM training-time labels measure pre-update state. The selected saved checkpoint has the lowest exact post-hoc loss. The execution remains recorded as failed and incomplete.",
  bindings: {
    failed_training_run_manifest_sha256: manifestPreselectionSha,
    failed_training_run_manifest_snapshot_sha256: hashFile(
      FAILED_MANIFEST_SNAPSHOT_PATH,
    ),
    failed_training_log_sha256: hashFile(LOG_PATH),
    owner_recovery_authorisation_sha256: hashFile(
      OWNER_RECOVERY_AUTHORISATION_PATH,
    ),
    exact_posthoc_validation_sha256: hashFile(
      EXACT_POSTHOC_VALIDATION_PATH,
    ),
    exact_posthoc_evaluator_sha256:
      exactPosthoc.bindings.evaluator_sha256,
    original_approved_selector_sha256: hashFile(ORIGINAL_SELECTOR_PATH),
    recovery_selector_sha256: hashFile(RECOVERY_SCRIPT_PATH),
    owner_development_authorisation_sha256:
      manifest.qualification.owner_authorisation_sha256,
    qualification_gate_sha256: manifest.qualification.gate_sha256,
    clean_start_provenance_sha256: manifest.qualification.provenance_sha256,
    checkpoint_policy_sha256:
      manifest.qualification.checkpoint_policy_sha256,
    memory_smoke_sha256: manifest.qualification.memory_smoke_sha256,
    dataset_manifest_sha256: manifest.dataset.manifest_sha256,
    training_split_sha256: manifest.dataset.train_sha256,
    validation_split_sha256: manifest.dataset.validation_sha256,
    config_sha256: config.config_sha256,
    training_wrapper_sha256: config.training_wrapper_sha256,
    selected_source_checkpoint_sha256: selected.sha256,
    final_planned_validation_checkpoint_sha256: finalPersisted.sha256,
  },
  expected_validation_intervals: expectedIntervals,
  exact_posthoc_validation_losses: Object.fromEntries(
    expectedIntervals.map((iteration) => [
      String(iteration),
      exactByIteration.get(iteration).exact_validation_loss_decimal,
    ]),
  ),
  unseen_accessed: false,
};
writeJsonExclusive(RECOVERY_RECORD_PATH, recoveryRecord);

const selection = {
  version: "cumulative-visible-checkpoint-selection-v1",
  selected_at: new Date().toISOString(),
  policy:
    "lowest exact full-precision direct post-hoc validation loss among all eight hash-verified saved post-update checkpoints; ties prefer earlier iteration; MLX-LM training-time pre-update loss labels are audit-only",
  model_version: "pension-assistant-cumulative-visible-compact-v8",
  selected_iteration: selected.iteration,
  selected_validation_loss: selected.validation_loss,
  source_checkpoint: selected.source_checkpoint,
  selected_adapter_path: selectedAdapterRoot,
  adapter_config_sha256: hashFile(selectedConfig),
  adapter_sha256: hashFile(selectedWeights),
  training_run_manifest_preselection_sha256: manifestPreselectionSha,
  expected_validation_intervals: expectedIntervals,
  candidates,
  execution_recovery: {
    status: "selected_from_failed_post_final_validation_oom_execution",
    failed_training_manifest_path: RUN_MANIFEST_PATH,
    failed_training_manifest_sha256: manifestPreselectionSha,
    failed_training_manifest_snapshot_path: FAILED_MANIFEST_SNAPSHOT_PATH,
    failed_training_manifest_snapshot_sha256: hashFile(
      FAILED_MANIFEST_SNAPSHOT_PATH,
    ),
    training_execution_completed: false,
    full_scheduled_iterations_completed: false,
    failure_classification: recoveryRecord.failure_classification,
    owner_authorisation_path: OWNER_RECOVERY_AUTHORISATION_PATH,
    owner_authorisation_sha256: hashFile(
      OWNER_RECOVERY_AUTHORISATION_PATH,
    ),
    recovery_authorisation_path: RECOVERY_RECORD_PATH,
    recovery_authorisation_sha256: hashFile(RECOVERY_RECORD_PATH),
    exact_posthoc_validation_path: EXACT_POSTHOC_VALIDATION_PATH,
    exact_posthoc_validation_sha256: hashFile(
      EXACT_POSTHOC_VALIDATION_PATH,
    ),
    visible_evaluation_authorised: false,
    sealed_unseen_authorised: false,
    release_authorised: false,
  },
};
writeJsonExclusive(SELECTION_PATH, selection);

console.log(
  JSON.stringify(
    {
      status: "checkpoint_selected_from_failed_post_final_validation_oom_execution",
      training_execution_status: manifest.status,
      training_execution_completed: false,
      selected_iteration: selected.iteration,
      selected_validation_loss: selected.validation_loss,
      selected_adapter_path: selectedAdapterRoot,
      checkpoint_selection_sha256: hashFile(SELECTION_PATH),
      recovery_authorisation_sha256: hashFile(RECOVERY_RECORD_PATH),
    },
    null,
    2,
  ),
);
