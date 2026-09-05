import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(".");
const EXPECTED_ADAPTER_SHA = "b370306a3078abd79af14e14c4690a4f394800f1096592ca6528e213cf5a6337";
const FORBIDDEN_312_SHA = "5ae76a0e16e7985c8e01d2a3d6fff2bff177d73bc5705608d6c59101998bd379";
const CYCLE31 = resolve(ROOT, process.env.T4_DEV_OUT || "training/evaluation-cycle-v2/31-post-training-development-regression-20260903");
const CHECKPOINT = resolve(ROOT, "training/evaluation-cycle-v2/30-cumulative-legal-training-20260902/checkpoint-selection.json");
const SELECTED = resolve(ROOT, "adapters/pension-assistant-cumulative-t4-legal-v1-selected/adapters.safetensors");
const ORIGINAL_PACK = resolve(ROOT, "training/evaluation-cycle-v2/01-question-set-review-revision-v2");
const STAGE = String(process.env.T4_DEV_STAGE || "t4-targeted");
const LABEL_PREFIX = String(process.env.T4_DEV_LABEL_PREFIX || (STAGE === "t4-targeted" ? "devreg-20260903-t4-targeted" : "devreg-20260903-topic161-original"));
const T4_IDS_PATH = resolve(ROOT, process.env.T4_DEV_IDS || "training/evaluation-cycle-v2/31-post-training-development-regression-20260903/t4-targeted-ids.json");
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

if (!process.env.QUALIFICATION_ATTEMPT_MANIFEST || !/^[0-9a-f]{64}$/.test(String(process.env.QUALIFICATION_ATTEMPT_MANIFEST_SHA256 || ""))) {
  throw new Error("A hash-bound qualification attempt manifest is required.");
}
const ATTEMPT_MANIFEST_PATH = resolve(process.env.QUALIFICATION_ATTEMPT_MANIFEST);
if (hashFile(ATTEMPT_MANIFEST_PATH) !== process.env.QUALIFICATION_ATTEMPT_MANIFEST_SHA256) throw new Error("Qualification attempt manifest SHA-256 mismatch.");
const attemptManifest = readJson(ATTEMPT_MANIFEST_PATH);
const expectedWorkerStage = STAGE === "t4-targeted" ? "T4_TARGETED_REGRESSION" : STAGE === "topic161-original" ? "TOPIC161_ORIGINAL_DEVELOPMENT" : null;
if (!expectedWorkerStage || attemptManifest.version !== "qualification-development-attempt-v1" ||
    attemptManifest.worker_stage !== expectedWorkerStage || attemptManifest.runner_stage !== STAGE ||
    resolve(attemptManifest.output_directory || "") !== CYCLE31 || resolve(attemptManifest.summary_path || "") !== resolve(CYCLE31,STAGE === "t4-targeted" ? "t4-targeted-summary.json" : "topic161-original-summary.json") ||
    attemptManifest.label_prefix !== LABEL_PREFIX || resolve(attemptManifest.command?.executable || "") !== resolve(process.execPath) ||
    resolve(attemptManifest.command?.args?.[0] || "") !== resolve(ROOT,"scripts/t4PostTrainingDevelopmentEval.mjs") ||
    resolve(attemptManifest.t4_target_ids?.path || "") !== T4_IDS_PATH || attemptManifest.t4_target_ids?.sha256 !== hashFile(T4_IDS_PATH)) {
  throw new Error("Qualification attempt manifest does not bind this exact development run.");
}
const attemptBinding = {
  run_id:attemptManifest.run_id,
  worker_stage:attemptManifest.worker_stage,
  runner_stage:attemptManifest.runner_stage,
  label_prefix:attemptManifest.label_prefix,
  attempt_manifest_path:ATTEMPT_MANIFEST_PATH,
  attempt_manifest_sha256:process.env.QUALIFICATION_ATTEMPT_MANIFEST_SHA256,
};

const workerConfig = readJson(resolve(ROOT,"config/qualification-worker.json"));
const evaluationConfiguration = {
  model_timeout_ms:workerConfig.runtime.model_timeout_ms,
  max_tokens:workerConfig.runtime.model_max_tokens,
  max_attempts:workerConfig.runtime.model_max_attempts,
  model_retry_ready_timeout_ms:workerConfig.runtime.model_retry_ready_timeout_ms,
  model_retry_health_probe_timeout_ms:workerConfig.runtime.model_retry_health_probe_timeout_ms,
  model_retry_poll_ms:workerConfig.runtime.model_retry_poll_ms,
  model_status_timeout_ms:workerConfig.runtime.model_status_timeout_ms,
  temperature:workerConfig.runtime.generation_temperature,
  top_p:workerConfig.runtime.generation_top_p,
  seed:workerConfig.runtime.generation_seed,
  model_context_limit_tokens:workerConfig.runtime.model_context_limit_tokens,
  model_prefill_step_size:workerConfig.runtime.model_prefill_step_size,
  model_cache_limit_bytes:workerConfig.runtime.model_cache_limit_bytes,
  model_enable_thinking:workerConfig.runtime.model_enable_thinking,
  model_system_prefix_cache:workerConfig.runtime.model_system_prefix_cache,
  model_trust_remote_code:workerConfig.runtime.model_trust_remote_code,
  model_add_generation_prompt:workerConfig.runtime.model_add_generation_prompt,
  source_limit:workerConfig.runtime.context_source_limit,
  source_snippet_characters:workerConfig.runtime.source_snippet_chars,
  embedding_timeout_ms:workerConfig.runtime.embedding_timeout_ms,
  embedding_retry_backoff_ms:workerConfig.runtime.embedding_retry_backoff_ms,
  rerank_timeout_ms:workerConfig.runtime.rerank_timeout_ms,
  retrieval_min_score:workerConfig.runtime.retrieval_min_score,
  degraded_retrieval_min_score:workerConfig.runtime.degraded_retrieval_min_score,
  live_retry_backoff_ms:workerConfig.runtime.live_retry_backoff_ms,
  evaluation_health_timeout_ms:workerConfig.runtime.evaluation_health_timeout_ms,
  timezone:workerConfig.runtime.timezone,
};
for (const [name,expected] of Object.entries({
  LOCAL_LLM_TIMEOUT_MS:evaluationConfiguration.model_timeout_ms,
  LOCAL_LLM_MAX_TOKENS:evaluationConfiguration.max_tokens,
  LOCAL_LLM_MAX_ATTEMPTS:evaluationConfiguration.max_attempts,
  LOCAL_LLM_RETRY_READY_TIMEOUT_MS:evaluationConfiguration.model_retry_ready_timeout_ms,
  LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS:evaluationConfiguration.model_retry_health_probe_timeout_ms,
  LOCAL_LLM_RETRY_POLL_MS:evaluationConfiguration.model_retry_poll_ms,
  LOCAL_LLM_STATUS_TIMEOUT_MS:evaluationConfiguration.model_status_timeout_ms,
  LOCAL_LLM_TEMPERATURE:evaluationConfiguration.temperature,
  LOCAL_LLM_TOP_P:evaluationConfiguration.top_p,
  LOCAL_LLM_SEED:evaluationConfiguration.seed,
  LOCAL_LLM_CONTEXT_TOKENS:evaluationConfiguration.model_context_limit_tokens,
  LLM_CONTEXT_SOURCE_LIMIT:evaluationConfiguration.source_limit,
  LLM_SOURCE_SNIPPET_CHARS:evaluationConfiguration.source_snippet_characters,
  EMBEDDING_TIMEOUT_MS:evaluationConfiguration.embedding_timeout_ms,
  EMBEDDING_RETRY_BACKOFF_MS:evaluationConfiguration.embedding_retry_backoff_ms,
  RERANK_TIMEOUT_MS:evaluationConfiguration.rerank_timeout_ms,
  RETRIEVAL_MIN_SCORE:evaluationConfiguration.retrieval_min_score,
  DEGRADED_RETRIEVAL_MIN_SCORE:evaluationConfiguration.degraded_retrieval_min_score,
  LIVE_RETRY_BACKOFF_MS:evaluationConfiguration.live_retry_backoff_ms,
  EVALUATION_HEALTH_TIMEOUT_MS:evaluationConfiguration.evaluation_health_timeout_ms,
  TZ:evaluationConfiguration.timezone,
})) {
  if (String(process.env[name] || "") !== String(expected)) throw new Error(`${name} must equal the canonical qualification-worker value ${expected}.`);
}

mkdirSync(CYCLE31, { recursive: true });
if (!existsSync(SELECTED)) throw new Error("Selected T4 adapter is missing");
const adapterSha = hashFile(SELECTED);
if (adapterSha !== EXPECTED_ADAPTER_SHA) throw new Error(`Selected adapter SHA mismatch: ${adapterSha}`);
if (adapterSha === FORBIDDEN_312_SHA) throw new Error("Refusing iteration 312 weights");
const checkpoint = readJson(CHECKPOINT);
if (checkpoint.selected_iteration !== 104) throw new Error("Checkpoint is not iteration 104");
if (checkpoint.adapter_sha256 !== EXPECTED_ADAPTER_SHA) throw new Error("Checkpoint adapter SHA mismatch");
const training = readJson(resolve(CHECKPOINT, "../training-run-manifest.json"));
const modelId = `${checkpoint.model_version}-step${checkpoint.selected_iteration}`;
const ids = existsSync(T4_IDS_PATH) ? readJson(T4_IDS_PATH) : readJson(resolve(CYCLE31, "t4-targeted-ids.json"));

const evalEnv = {
  ...process.env,
  CYCLE_V2_PARTITION: "diagnostic",
  CYCLE_V2_CHECKPOINT_PATH: CHECKPOINT,
  CYCLE_V2_RETRY_RUN_ERRORS: "false",
  LOCAL_LLM_MAX_ATTEMPTS: String(evaluationConfiguration.max_attempts),
  LOCAL_LLM_RETRY_READY_TIMEOUT_MS: String(evaluationConfiguration.model_retry_ready_timeout_ms),
  CYCLE_V2_LIMIT: "0",
  CYCLE_V2_WAVE1_LIMIT: "0",
  CYCLE_V2_PACK_ROOT: ORIGINAL_PACK,
  LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080",
  LOCAL_LLM_TRANSPORT: "openai",
  LOCAL_LLM_MODEL: modelId,
  LOCAL_LLM_EXPECTED_ADAPTER_SHA256: checkpoint.adapter_sha256,
  LOCAL_LLM_EXPECTED_ADAPTER_CONFIG_SHA256: checkpoint.adapter_config_sha256,
  LOCAL_LLM_EXPECTED_BASE_SHA256: training.base_model.model_sha256 || training.base_model.sha256,
  LOCAL_LLM_EXPECTED_CHECKPOINT_SHA256: hashFile(CHECKPOINT),
  EMBEDDING_SERVICE_URL: process.env.EMBEDDING_SERVICE_URL || "http://127.0.0.1:8090",
  RERANK_SERVICE_URL: process.env.RERANK_SERVICE_URL || "http://127.0.0.1:8090",
  ALLOW_DEGRADED_EMBEDDINGS: "false",
  REQUIRE_CROSS_ENCODER_RERANK: "true",
  EVALUATION_MODEL_VERSION: modelId,
  EVALUATION_LORA_ADAPTER: checkpoint.selected_adapter_path,
};

function runScript(script, extra = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(ROOT, script)], {
      cwd: ROOT,
      env: { ...evalEnv, ...extra },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && !signal) accept();
      else reject(new Error(`${script} exited with ${signal || code}`));
    });
  });
}

function scorecardPath(wave, label) {
  return resolve(ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/diagnostic/${label}/scorecard.json`);
}

function summariseWave(wave, label, roleById = {}) {
  const score = readJson(scorecardPath(wave, label));
  const raw = readJson(resolve(ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/diagnostic/${label}/results.json`));
  const rawById = new Map((raw.results || []).map((item) => [item.question_id, item]));
  const items = (score.items || []).map((item) => ({
    question_id: item.question_id,
    status: item.status,
    critical_failure: Boolean(item.critical_failure || (item.critical_failure_signals || []).length),
    role: roleById[item.question_id] || "original_topic161",
    retry_used: Boolean(rawById.get(item.question_id)?.retry_used),
    retry_reason: rawById.get(item.question_id)?.retry_reason || null,
  }));
  return {
    wave,
    label,
    processed: items.length,
    outcomes: score.outcomes || {},
    pass_rate: score.pass_rate ?? null,
    run_errors: score.run_errors ?? items.filter((item) => item.status === "run_error").length,
    items,
  };
}

async function runWaves(labelPrefix, idsByWave) {
  const summaries = [];
  for (const wave of ["wave-1", "wave-2", "wave-3"]) {
    const questionIds = (idsByWave?.[wave] || []).filter(Boolean);
    if (idsByWave && !questionIds.length) continue;
    const label = idsByWave ? `${labelPrefix}-${wave}` : `${labelPrefix}-${wave}`;
    const gold = resolve(ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/gold/evaluation-gold.json`);
    const env = {
      CYCLE_V2_WAVE: wave,
      CYCLE_V2_RUN_LABEL: label,
      CYCLE_V2_QUESTION_IDS: questionIds.join(","),
      CYCLE_V2_WAVE1_QUESTION_IDS: "",
      CYCLE_V2_GOLD_PATH: gold,
      CYCLE_V2_PACK_ROOT: ORIGINAL_PACK,
    };
    await runScript("scripts/evaluationCycleV2Wave1Run.mjs", env);
    await runScript("scripts/evaluationCycleV2Wave1Score.mjs", env);
    summaries.push(summariseWave(wave, label, ids.roles || {}));
  }
  return summaries;
}

if (STAGE === "t4-targeted") {
  const summaries = await runWaves(LABEL_PREFIX, ids.ids_by_wave);
  const source = summaries.flatMap((wave) => wave.items).filter((item) => item.role === "source_failure");
  const sourcePass = source.filter((item) => item.status === "pass");
  const critical = summaries.flatMap((wave) => wave.items).filter((item) => item.critical_failure);
  const runErrors = summaries.reduce((sum, wave) => sum + Number(wave.run_errors || 0), 0);
  const report = {
    version: "t4-targeted-development-regression-v1",
    generated_at: new Date().toISOString(),
    role: "DEVELOPMENT_REGRESSION_NOT_QUALIFICATION",
    adapter_sha256: adapterSha,
    selected_iteration: 104,
    forbidden_312_used: false,
    sealed_unseen_accessed: false,
    attempt_binding:attemptBinding,
    evaluation_configuration:evaluationConfiguration,
    source_failures: { expected: ids.source_failure_ids.length, processed: source.length, pass: sourcePass.length },
    prior_positives: summaries.flatMap((wave) => wave.items).filter((item) => item.role === "prior_positive"),
    waves: summaries,
    gate: {
      all_source_failures_pass: source.length === ids.source_failure_ids.length && sourcePass.length === ids.source_failure_ids.length,
      zero_critical_failure: critical.length === 0,
      zero_run_errors: runErrors === 0,
    },
  };
  report.passed = report.gate.all_source_failures_pass && report.gate.zero_critical_failure && report.gate.zero_run_errors;
  writeJson(resolve(CYCLE31, "t4-targeted-summary.json"), report);
  console.log(JSON.stringify({ stage: STAGE, passed: report.passed, gate: report.gate, source: report.source_failures }, null, 2));
} else if (STAGE === "topic161-original") {
  const summaries = await runWaves(LABEL_PREFIX, null);
  const processed = summaries.reduce((sum, wave) => sum + wave.processed, 0);
  const pass = summaries.reduce((sum, wave) => sum + Number(wave.outcomes.pass || 0), 0);
  const report = {
    version: "topic161-original-development-regression-v1",
    generated_at: new Date().toISOString(),
    role: "DEVELOPMENT_REGRESSION_CONSUMED_NOT_INDEPENDENT_QUALIFICATION",
    adapter_sha256: adapterSha,
    selected_iteration: 104,
    sealed_unseen_accessed: false,
    attempt_binding:attemptBinding,
    evaluation_configuration:evaluationConfiguration,
    processed,
    pass,
    waves: summaries,
    rejected_step130_baseline: { wave1: 0.654, wave2: 0.426, wave3: 0.415 },
    note: "Original topic161 is development regression only. Visible qualification uses topic161-replacement-v2.",
  };
  const overallPassRate = processed ? (100 * pass) / processed : 0;
  report.gate = {
    all_161_processed: processed === 161,
    overall_at_least_90: overallPassRate >= 90,
    every_wave_at_least_85: summaries.every((wave) => Number(wave.pass_rate || 0) >= 85),
    zero_critical_failure: summaries.flatMap((wave) => wave.items).every((item) => !item.critical_failure),
    zero_run_errors: summaries.every((wave) => Number(wave.run_errors || 0) === 0),
  };
  report.overall_pass_rate = Number(overallPassRate.toFixed(1));
  report.passed = Object.values(report.gate).every(Boolean);
  writeJson(resolve(CYCLE31, "topic161-original-summary.json"), report);
  writeJson(resolve(ROOT, "evaluation/topic161-original/regression-results-new-candidate/STATUS.json"), {
    status: report.passed ? "completed_development_regression" : "completed_with_run_errors",
    original_suite_role: "DEVELOPMENT_REGRESSION_CONSUMED",
    candidate: modelId,
    summary: resolve(CYCLE31, "topic161-original-summary.json"),
  });
  console.log(JSON.stringify({ stage: STAGE, passed: report.passed, processed, pass, waves: report.waves }, null, 2));
} else {
  throw new Error(`Unknown T4_DEV_STAGE: ${STAGE}`);
}
