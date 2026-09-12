import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CONFIRMATION =
  "owner_authorised_exact_posthoc_checkpoint_validation_v1";
if (
  process.env.CUMULATIVE_VISIBLE_POSTHOC_VALIDATION_CONFIRM !== CONFIRMATION
) {
  throw new Error(
    "Exact post-hoc validation is locked. Supply the owner confirmation for the eight saved checkpoints only.",
  );
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_RUN_ROOT ||
    join(
      PROJECT_ROOT,
      "training/evaluation-cycle-v2/25-cumulative-visible-training-v8-20260901",
    ),
);
const MANIFEST_PATH = resolve(RUN_ROOT, "training-run-manifest.json");
const LOG_PATH = resolve(RUN_ROOT, "training-output.log");
const OUTPUT_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_POSTHOC_VALIDATION_ROOT ||
    join(RUN_ROOT, "exact-posthoc-checkpoint-validation-v2"),
);
const FINAL_PATH = resolve(OUTPUT_ROOT, "exact-posthoc-validation.json");
const PYTHON = resolve(PROJECT_ROOT, ".training-venv/bin/python");
const EVALUATOR = resolve(
  PROJECT_ROOT,
  "training/evaluate_mlx_adapter_exact.py",
);
const EXPECTED_FAILED_MANIFEST_SHA =
  "7104db1d811cd35fb7cd205e229bf69a921f2d0293ccafa30e4749427b1c05f2";
const EXPECTED_FAILED_LOG_SHA =
  "f7f629a928774145a8a707fee5a7fbd0082a7875403f38ed29041f6a4826ffb8";
const EXPECTED_ITERATIONS = [26, 52, 78, 104, 130, 156, 182, 208];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const hashFile = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const writeJsonExclusive = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};
const requireFile = (path, label) => {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
};
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

for (const [path, label] of [
  [MANIFEST_PATH, "Failed training manifest"],
  [LOG_PATH, "Failed training log"],
  [PYTHON, "Pinned training Python"],
  [EVALUATOR, "Exact MLX evaluator"],
]) {
  requireFile(path, label);
}
if (existsSync(FINAL_PATH)) {
  throw new Error(`Immutable exact validation already exists: ${FINAL_PATH}`);
}
if (
  hashFile(MANIFEST_PATH) !== EXPECTED_FAILED_MANIFEST_SHA ||
  hashFile(LOG_PATH) !== EXPECTED_FAILED_LOG_SHA
) {
  throw new Error("Failed training evidence changed before exact post-hoc validation.");
}

const training = readJson(MANIFEST_PATH);
if (
  training.version !== "cumulative-visible-clean-mlx-run-v1" ||
  training.status !== "failed" ||
  training.clean_start !== true ||
  training.metrics?.exit_code !== 1 ||
  training.hyperparameters?.iterations !== 228 ||
  training.hyperparameters?.steps_per_eval !== 26 ||
  training.hyperparameters?.save_every !== 26 ||
  training.hyperparameters?.max_sequence_length !== 2112 ||
  training.dataset?.total_count !== 94 ||
  training.dataset?.train_count !== 76 ||
  training.dataset?.validation_count !== 18 ||
  training.evaluation_access?.sealed_unseen_answers_accessed !== false
) {
  throw new Error("Post-hoc validation requires the exact failed clean 94-record run.");
}
const validationPath = resolve(training.dataset.path, "valid.jsonl");
const adapterConfigPath = resolve(
  training.output_adapter.path,
  "adapter_config.json",
);
const modelRoot = resolve(training.base_model.path);
for (const [path, expectedSha, label] of [
  [validationPath, training.dataset.validation_sha256, "Exact 18-row validation split"],
  [resolve(modelRoot, "config.json"), training.base_model.config_sha256, "Base model config"],
  [resolve(modelRoot, "tokenizer.json"), training.base_model.tokenizer_sha256, "Base tokenizer"],
]) {
  requireFile(path, label);
  if (hashFile(path) !== expectedSha) throw new Error(`${label} hash changed.`);
}
requireFile(adapterConfigPath, "Original adapter config");
const baseWeights = resolve(modelRoot, "model.safetensors");
requireFile(baseWeights, "Base model weights");
if (statSync(baseWeights).size !== training.base_model.model_size_bytes) {
  throw new Error("Base model weight size changed.");
}

const checkpoints = training.metrics.persisted_checkpoints;
if (
  !Array.isArray(checkpoints) ||
  !sameJson(
    checkpoints.map((entry) => entry.iteration),
    EXPECTED_ITERATIONS,
  )
) {
  throw new Error("Failed run does not contain exactly the eight planned saved checkpoints.");
}
for (const checkpoint of checkpoints) {
  requireFile(checkpoint.path, `Checkpoint ${checkpoint.iteration}`);
  if (
    hashFile(checkpoint.path) !== checkpoint.sha256 ||
    statSync(checkpoint.path).size !== checkpoint.size_bytes
  ) {
    throw new Error(`Checkpoint ${checkpoint.iteration} no longer matches its hash/size.`);
  }
}

mkdirSync(OUTPUT_ROOT, { recursive: true });
const evaluatorSha = hashFile(EVALUATOR);
const runOne = (checkpoint, temporaryAdapter) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      PYTHON,
      [
        EVALUATOR,
        "--model",
        modelRoot,
        "--adapter",
        temporaryAdapter,
        "--validation",
        validationPath,
        "--max-seq-length",
        "2112",
        "--expected-count",
        "18",
      ],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PYTHONHASHSEED: "42",
          TOKENIZERS_PARALLELISM: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        process.stdout.write(text);
      });
    }
    child.on("error", rejectRun);
    child.on("exit", (code) => resolveRun({ code: code ?? 1, output }));
  });

const results = [];
for (const checkpoint of checkpoints) {
  const resultPath = resolve(
    OUTPUT_ROOT,
    `checkpoint-${String(checkpoint.iteration).padStart(7, "0")}.json`,
  );
  const logPath = resolve(
    OUTPUT_ROOT,
    `checkpoint-${String(checkpoint.iteration).padStart(7, "0")}.log`,
  );
  if (existsSync(resultPath)) {
    const existing = readJson(resultPath);
    requireFile(logPath, `Checkpoint ${checkpoint.iteration} exact-validation log`);
    if (
      existing.status !== "passed" ||
      existing.iteration !== checkpoint.iteration ||
      existing.checkpoint_sha256 !== checkpoint.sha256 ||
      existing.validation_sha256 !== training.dataset.validation_sha256 ||
      existing.evaluator_sha256 !== evaluatorSha ||
      existing.log_sha256 !== hashFile(logPath) ||
      existing.runtime?.examples !== 18 ||
      !Number.isFinite(existing.exact_validation_loss)
    ) {
      throw new Error(`Existing checkpoint ${checkpoint.iteration} result cannot be safely resumed.`);
    }
    results.push(existing);
    console.log(`Reused exact checkpoint ${checkpoint.iteration}: ${existing.exact_validation_loss}`);
    continue;
  }
  if (existsSync(logPath)) {
    throw new Error(`Orphan exact-validation log prevents resume: ${logPath}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "pension-posthoc-validation-"));
  const tempAdapter = resolve(tempRoot, "adapter");
  mkdirSync(tempAdapter);
  copyFileSync(adapterConfigPath, resolve(tempAdapter, "adapter_config.json"));
  copyFileSync(checkpoint.path, resolve(tempAdapter, "adapters.safetensors"));
  console.log(
    `Exact post-hoc validation ${results.length + 1}/${checkpoints.length}: checkpoint ${checkpoint.iteration}`,
  );
  const completed = await runOne(checkpoint, tempAdapter);
  if (completed.code !== 0) {
    throw new Error(
      `Exact validation failed for checkpoint ${checkpoint.iteration} (exit ${completed.code}).`,
    );
  }
  const matches = [
    ...completed.output.matchAll(/^EXACT_EVAL_JSON:(\{.*\})$/gm),
  ];
  if (matches.length !== 1) {
    throw new Error(`Checkpoint ${checkpoint.iteration} did not emit one exact result.`);
  }
  const runtime = JSON.parse(matches[0][1]);
  if (
    runtime.version !== "exact-mlx-adapter-validation-result-v1" ||
    runtime.examples !== 18 ||
    runtime.max_seq_length !== 2112 ||
    runtime.mask_prompt !== true ||
    runtime.batch_size !== 1 ||
    runtime.max_total_tokens > 2112 ||
    runtime.mlx_lm_version !== "0.31.3" ||
    !Number.isFinite(runtime.loss) ||
    runtime.loss <= 0
  ) {
    throw new Error(`Checkpoint ${checkpoint.iteration} exact runtime contract failed.`);
  }
  writeFileSync(logPath, completed.output, { flag: "wx" });
  const record = {
    version: "cumulative-visible-exact-checkpoint-validation-v1",
    status: "passed",
    iteration: checkpoint.iteration,
    checkpoint_path: resolve(checkpoint.path),
    checkpoint_sha256: checkpoint.sha256,
    checkpoint_size_bytes: checkpoint.size_bytes,
    exact_validation_loss: runtime.loss,
    exact_validation_loss_decimal: runtime.loss_decimal,
    validation_path: validationPath,
    validation_sha256: training.dataset.validation_sha256,
    evaluator_path: EVALUATOR,
    evaluator_sha256: evaluatorSha,
    log_path: logPath,
    log_sha256: hashFile(logPath),
    runtime,
    sealed_unseen_accessed: false,
  };
  writeJsonExclusive(resultPath, record);
  results.push(record);
  if (!tempRoot.startsWith(`${tmpdir()}/pension-posthoc-validation-`)) {
    throw new Error("Temporary validation directory failed its cleanup boundary check.");
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

const completionTokens = new Set(
  results.map((entry) => entry.runtime.completion_tokens),
);
const maxTokens = new Set(results.map((entry) => entry.runtime.max_total_tokens));
if (completionTokens.size !== 1 || maxTokens.size !== 1) {
  throw new Error("Exact checkpoint evaluations did not use one identical tokenized validation split.");
}
const ranked = [...results].sort(
  (left, right) =>
    left.exact_validation_loss - right.exact_validation_loss ||
    left.iteration - right.iteration,
);
const selected = ranked[0];
const final = {
  version: "cumulative-visible-exact-posthoc-checkpoint-validation-v1",
  generated_at: new Date().toISOString(),
  status: "passed_selection_ready",
  passed: true,
  purpose:
    "Directly measure each saved post-update checkpoint because MLX-LM 0.31.3 training-time validation labels pre-update weights.",
  training_execution_status: "failed_post_final_validation_metal_oom",
  training_execution_completed: false,
  full_scheduled_iterations_completed: false,
  selection_authorised: false,
  visible_evaluation_authorised: false,
  sealed_unseen_authorised: false,
  release_authorised: false,
  selection_policy:
    "lowest exact full-precision post-hoc loss over the eight hash-verified saved checkpoints on the unchanged 18-record masked-completion validation split; exact ties prefer earlier iteration",
  selected_iteration: selected.iteration,
  selected_exact_validation_loss: selected.exact_validation_loss,
  selected_exact_validation_loss_decimal:
    selected.exact_validation_loss_decimal,
  results: results.map((entry) => ({
    iteration: entry.iteration,
    checkpoint_sha256: entry.checkpoint_sha256,
    exact_validation_loss: entry.exact_validation_loss,
    exact_validation_loss_decimal: entry.exact_validation_loss_decimal,
    result_sha256: hashFile(
      resolve(
        OUTPUT_ROOT,
        `checkpoint-${String(entry.iteration).padStart(7, "0")}.json`,
      ),
    ),
    log_sha256: entry.log_sha256,
  })),
  bindings: {
    failed_training_manifest_sha256: hashFile(MANIFEST_PATH),
    failed_training_log_sha256: hashFile(LOG_PATH),
    validation_sha256: training.dataset.validation_sha256,
    evaluator_sha256: evaluatorSha,
    base_model_sha256: training.base_model.model_sha256,
    base_config_sha256: training.base_model.config_sha256,
    tokenizer_sha256: training.base_model.tokenizer_sha256,
    adapter_config_sha256: hashFile(adapterConfigPath),
  },
  runtime: {
    python_path: PYTHON,
    mlx_lm_version: results[0].runtime.mlx_lm_version,
    mlx_version: results[0].runtime.mlx_version,
    examples: 18,
    completion_tokens: results[0].runtime.completion_tokens,
    max_total_tokens: results[0].runtime.max_total_tokens,
    max_seq_length: 2112,
    mask_prompt: true,
    batch_size: 1,
  },
  training_time_validation_used_for_selection: false,
  sealed_unseen_accessed: false,
};
writeJsonExclusive(FINAL_PATH, final);
console.log(
  JSON.stringify(
    {
      status: final.status,
      selected_iteration: final.selected_iteration,
      selected_exact_validation_loss: final.selected_exact_validation_loss,
      exact_posthoc_validation_path: FINAL_PATH,
      exact_posthoc_validation_sha256: hashFile(FINAL_PATH),
    },
    null,
    2,
  ),
);
