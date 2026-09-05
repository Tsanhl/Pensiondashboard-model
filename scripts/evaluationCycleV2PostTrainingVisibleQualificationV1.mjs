import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PINNED_EMBEDDING_MODEL,
  PINNED_RERANKER_MODEL,
  PINNED_RETRIEVAL_MANIFEST_SHA256,
  PINNED_RETRIEVAL_SERVER_SHA256,
} from "../server/services/pinnedRetrievalIdentity.js";
import {
  CRITICAL_IDS,
  EXECUTION_CONFIRMATION,
  PROJECT_ROOT,
  VISIBLE_QUALIFICATION_VERSION,
  codeArtifactRecords,
  fileRecord,
  git,
  loadAndVerifyCheckpoint,
  loadAndVerifyVisibleAssets,
  now,
  qualificationPaths,
  validateRunLabel,
  verifyLiveRuntime,
  warmPinnedModelPrefix,
  writeJsonAtomic,
} from "./lib/postTrainingVisibleQualificationV1.mjs";
import { canonicalHash } from "./lib/qualification-worker/utils.mjs";

const runLabel = validateRunLabel(process.env.VISIBLE_QUALIFICATION_RUN_LABEL);
const checkpointInput = String(process.env.VISIBLE_QUALIFICATION_CHECKPOINT_PATH || "").trim();
if (!checkpointInput) throw new Error("VISIBLE_QUALIFICATION_CHECKPOINT_PATH is required.");
if (process.env.VISIBLE_QUALIFICATION_EXECUTE !== EXECUTION_CONFIRMATION) {
  throw new Error(`Execution is locked. Set VISIBLE_QUALIFICATION_EXECUTE=${EXECUTION_CONFIRMATION} only for the owner-authorised visible qualification.`);
}

const checkpointPath = resolve(checkpointInput);
const outputParent = resolve(process.env.VISIBLE_QUALIFICATION_OUTPUT_PARENT ||
  "training/evaluation-cycle-v2/10-post-training-visible-qualification-v1-20260901");
const paths = qualificationPaths(runLabel, outputParent);
const modelBaseUrl = String(process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const embeddingBaseUrl = String(process.env.EMBEDDING_SERVICE_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
const ORIGINAL_PACK_ROOT = resolve(PROJECT_ROOT, "training/evaluation-cycle-v2/01-question-set-review-revision-v2");
const REPLACEMENT_TOPIC161_ROOT = resolve(PROJECT_ROOT, "training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902");
const requestedStage = String(process.env.VISIBLE_QUALIFICATION_STAGE || "all");
const allowedRequestedStages = new Set(["all", "critical4", "full69", "topic161", "frozen13", "final"]);
if (!allowedRequestedStages.has(requestedStage)) throw new Error(`Unknown VISIBLE_QUALIFICATION_STAGE: ${requestedStage}`);
const workerConfig = JSON.parse(readFileSync(resolve(PROJECT_ROOT,"config/qualification-worker.json"),"utf8"));
const fixedEvaluationConfiguration = {
  max_tokens:workerConfig.runtime.model_max_tokens,
  max_attempts:workerConfig.runtime.model_max_attempts,
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
  model_timeout_ms:workerConfig.runtime.model_timeout_ms,
  embedding_timeout_ms:workerConfig.runtime.embedding_timeout_ms,
  rerank_timeout_ms:workerConfig.runtime.rerank_timeout_ms,
  retrieval_min_score:workerConfig.runtime.retrieval_min_score,
  degraded_retrieval_min_score:workerConfig.runtime.degraded_retrieval_min_score,
  live_chat_timeout_ms:workerConfig.runtime.live_chat_timeout_ms,
  model_retry_ready_timeout_ms:workerConfig.runtime.model_retry_ready_timeout_ms,
  model_retry_health_probe_timeout_ms:workerConfig.runtime.model_retry_health_probe_timeout_ms,
  model_retry_poll_ms:workerConfig.runtime.model_retry_poll_ms,
  model_status_timeout_ms:workerConfig.runtime.model_status_timeout_ms,
  live_retry_backoff_ms:workerConfig.runtime.live_retry_backoff_ms,
  evaluation_health_timeout_ms:workerConfig.runtime.evaluation_health_timeout_ms,
  embedding_warmup_timeout_ms:workerConfig.runtime.embedding_warmup_timeout_ms,
  embedding_retry_backoff_ms:workerConfig.runtime.embedding_retry_backoff_ms,
  reranker_warmup_timeout_ms:workerConfig.runtime.reranker_warmup_timeout_ms,
  model_warmup_timeout_ms:workerConfig.runtime.model_warmup_timeout_ms,
  python_environment_manifest_sha256:workerConfig.runtime.python_environment_manifest_sha256,
  timezone:workerConfig.runtime.timezone,
  retrieval_device:workerConfig.runtime.retrieval_device,
  retrieval_threads:workerConfig.runtime.retrieval_threads,
};
for (const [name,expected] of Object.entries({
  LOCAL_LLM_TIMEOUT_MS:fixedEvaluationConfiguration.model_timeout_ms,
  LOCAL_LLM_MAX_TOKENS:fixedEvaluationConfiguration.max_tokens,
  LOCAL_LLM_MAX_ATTEMPTS:fixedEvaluationConfiguration.max_attempts,
  LOCAL_LLM_TEMPERATURE:fixedEvaluationConfiguration.temperature,
  LOCAL_LLM_TOP_P:fixedEvaluationConfiguration.top_p,
  LOCAL_LLM_SEED:fixedEvaluationConfiguration.seed,
  LOCAL_LLM_CONTEXT_TOKENS:fixedEvaluationConfiguration.model_context_limit_tokens,
  LLM_CONTEXT_SOURCE_LIMIT:fixedEvaluationConfiguration.source_limit,
  LLM_SOURCE_SNIPPET_CHARS:fixedEvaluationConfiguration.source_snippet_characters,
  EMBEDDING_TIMEOUT_MS:fixedEvaluationConfiguration.embedding_timeout_ms,
  RERANK_TIMEOUT_MS:fixedEvaluationConfiguration.rerank_timeout_ms,
  RETRIEVAL_MIN_SCORE:fixedEvaluationConfiguration.retrieval_min_score,
  DEGRADED_RETRIEVAL_MIN_SCORE:fixedEvaluationConfiguration.degraded_retrieval_min_score,
  LIVE_CHAT_TIMEOUT_MS:fixedEvaluationConfiguration.live_chat_timeout_ms,
  LOCAL_LLM_RETRY_READY_TIMEOUT_MS:fixedEvaluationConfiguration.model_retry_ready_timeout_ms,
  LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS:fixedEvaluationConfiguration.model_retry_health_probe_timeout_ms,
  LOCAL_LLM_RETRY_POLL_MS:fixedEvaluationConfiguration.model_retry_poll_ms,
  LOCAL_LLM_STATUS_TIMEOUT_MS:fixedEvaluationConfiguration.model_status_timeout_ms,
  LIVE_RETRY_BACKOFF_MS:fixedEvaluationConfiguration.live_retry_backoff_ms,
  EVALUATION_HEALTH_TIMEOUT_MS:fixedEvaluationConfiguration.evaluation_health_timeout_ms,
  EMBEDDING_RETRY_BACKOFF_MS:fixedEvaluationConfiguration.embedding_retry_backoff_ms,
  TZ:fixedEvaluationConfiguration.timezone,
})) {
  if (String(process.env[name] || "") !== String(expected)) throw new Error(`${name} must equal the canonical qualification-worker value ${expected}.`);
}

const stageTargets = {
  critical4: [paths.root, paths.critical4.root],
  full69: [paths.full69.root],
  topic161: Object.values(paths.topic161).map((item) => item.root),
  frozen13: Object.values(paths.frozen13).map((item) => item.root),
  final: [paths.gates.final],
};
const requestedTargets = requestedStage === "all"
  ? [paths.root, paths.critical4.root, paths.full69.root, ...stageTargets.topic161, ...stageTargets.frozen13]
  : stageTargets[requestedStage];
const collisions = requestedTargets.filter((path) => existsSync(path));
if (collisions.length) {
  throw new Error(`Visible qualification stage is already represented by preserved evidence: ${collisions.join(", ")}`);
}

// Perform all expensive and mutable-environment checks before creating any run output.
const checkpoint = loadAndVerifyCheckpoint(checkpointPath, { verifyLargeBaseModel: requestedStage === "all" || requestedStage === "critical4" || requestedStage === "final" });
const visibleAssets = loadAndVerifyVisibleAssets();
const runtime = await verifyLiveRuntime({
  modelBaseUrl,
  embeddingBaseUrl,
  expectedIdentity: checkpoint.expectedIdentity,
  healthTimeoutMs:workerConfig.runtime.evaluation_health_timeout_ms,
  embeddingProbeTimeoutMs:workerConfig.runtime.embedding_warmup_timeout_ms,
  rerankerProbeTimeoutMs:workerConfig.runtime.reranker_warmup_timeout_ms,
  expectedRetrievalDevice:workerConfig.runtime.retrieval_device,
  expectedRetrievalThreads:workerConfig.runtime.retrieval_threads,
});
const runtimeConfigurationSha256 = canonicalHash(workerConfig.runtime);
const pythonEnvironmentSha256 = runtime.identity?.python_environment_sha256;
if (runtime.identity?.runtime_configuration_sha256 !== runtimeConfigurationSha256 || !/^[0-9a-f]{64}$/.test(String(pythonEnvironmentSha256 || "")) ||
    runtime.embedding_health?.body?.runtime_configuration_sha256 !== runtimeConfigurationSha256 || runtime.embedding_health?.body?.python_environment_sha256 !== pythonEnvironmentSha256) {
  throw new Error("Visible qualification runtime does not expose the bound configuration and Python environment identities.");
}
runtime.system_prefix_warmup = await warmPinnedModelPrefix({
  modelBaseUrl,
  modelId:checkpoint.modelId,
  expectedIdentity:checkpoint.expectedIdentity,
  timeoutMs:workerConfig.runtime.model_warmup_timeout_ms,
});
const codeArtifacts = codeArtifactRecords();

const startedAt = now();
let manifest;
if (requestedStage === "all" || requestedStage === "critical4") {
  mkdirSync(paths.root, { recursive: true });
  manifest = {
    version: VISIBLE_QUALIFICATION_VERSION,
    status: "running",
    run_label: runLabel,
    started_at: startedAt,
    completed_at: null,
    purpose: "Owner-authorised post-training qualification on visible development and regression suites only.",
    scope: {
      owner_authorised_visible_qualification: true,
      independent_legal_semantic_review: false,
      sealed_unseen_accessed: false,
      sealed_unseen_authorised: false,
      release_authorised: false,
      production_slo_certified: false,
    },
    execution_order: ["critical4", "full69", "topic161", "frozen13", "final"],
    total_case_executions: 247,
    checkpoint: {
      path: checkpoint.checkpointPath,
      model_id: checkpoint.modelId,
      selected_iteration: checkpoint.checkpoint.selected_iteration,
      selected_validation_loss: checkpoint.checkpoint.selected_validation_loss ?? null,
      adapter_path: checkpoint.checkpoint.selected_adapter_path,
      training_execution: {
        mode: checkpoint.trainingExecutionMode,
        status: checkpoint.training.status,
        exit_code: checkpoint.training.metrics?.exit_code ?? null,
        training_execution_completed: checkpoint.trainingExecutionMode === "completed_training_run",
        full_scheduled_iterations_completed: checkpoint.trainingExecutionMode === "completed_training_run",
        failure_classification: checkpoint.checkpoint.execution_recovery?.failure_classification ?? null,
      },
      expected_identity: checkpoint.expectedIdentity,
      artifacts: checkpoint.artifacts,
    },
    runtime_preflight: runtime,
    runtime_configuration_sha256:runtimeConfigurationSha256,
    python_environment_sha256:pythonEnvironmentSha256,
    visible_assets: visibleAssets,
    fixed_evaluation_configuration: {
      ...fixedEvaluationConfiguration,
      embedding_model: PINNED_EMBEDDING_MODEL.repository,
      embedding_revision: PINNED_EMBEDDING_MODEL.revision,
      degraded_embeddings_allowed: false,
      reranker_model: PINNED_RERANKER_MODEL.repository,
      reranker_revision: PINNED_RERANKER_MODEL.revision,
      retrieval_server_sha256: PINNED_RETRIEVAL_SERVER_SHA256,
      retrieval_model_manifest_sha256: PINNED_RETRIEVAL_MANIFEST_SHA256,
      cross_encoder_reranker_required: true,
    },
    code_artifacts: codeArtifacts,
    repository: {
      commit: git(["rev-parse", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      worktree_dirty: Boolean(git(["status", "--porcelain"], "")),
    },
    output_contract: {
      orchestration_root: paths.root,
      prior_results_preserved: true,
      interrupted_or_failed_runs_must_use_a_new_label: true,
      critical4: paths.critical4, full69: paths.full69,
      topic161: paths.topic161, frozen13: paths.frozen13,
    },
    stages: {}, failure: null,
  };
  writeJsonAtomic(paths.manifest, manifest);
} else {
  if (!existsSync(paths.manifest)) throw new Error("Visible qualification orchestration manifest is missing for staged continuation.");
  manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  const expectedPrevious = { full69: ["critical4"], topic161: ["critical4", "full69"], frozen13: ["critical4", "full69", "topic161"], final: ["critical4", "full69", "topic161", "frozen13"] }[requestedStage] || [];
  if (manifest.version !== VISIBLE_QUALIFICATION_VERSION || manifest.run_label !== runLabel || manifest.status !== "running" ||
      manifest.checkpoint?.model_id !== checkpoint.modelId || manifest.checkpoint?.expected_identity?.adapter_sha256 !== checkpoint.expectedIdentity.adapter_sha256 ||
      manifest.runtime_configuration_sha256 !== runtimeConfigurationSha256 || manifest.python_environment_sha256 !== pythonEnvironmentSha256 ||
      Object.entries(fixedEvaluationConfiguration).some(([key,value]) => manifest.fixed_evaluation_configuration?.[key] !== value) ||
      !expectedPrevious.every((name) => manifest.stages?.[name]?.status === "passed" && existsSync(paths.gates[name])) ||
      Object.keys(manifest.stages || {}).some((name) => !expectedPrevious.includes(name))) {
    throw new Error("Visible qualification staged continuation failed its ordered predecessor and identity checks.");
  }
  manifest.runtime_preflight = runtime;
}

const baseEnvironment = {
  ...process.env,
  CYCLE_V2_PARTITION: "diagnostic",
  CYCLE_V2_CHECKPOINT_PATH: checkpoint.checkpointPath,
  CYCLE_V2_RETRY_RUN_ERRORS: "false",
  CYCLE_V2_LIMIT: "0",
  CYCLE_V2_WAVE1_LIMIT: "0",
  LOCAL_LLM_BASE_URL: modelBaseUrl,
  LOCAL_LLM_TRANSPORT: "openai",
  LOCAL_LLM_MODEL: checkpoint.modelId,
  LOCAL_LLM_EXPECTED_ADAPTER_SHA256: checkpoint.checkpoint.adapter_sha256,
  LOCAL_LLM_EXPECTED_ADAPTER_CONFIG_SHA256: checkpoint.checkpoint.adapter_config_sha256,
  LOCAL_LLM_EXPECTED_BASE_SHA256: checkpoint.training.base_model.model_sha256,
  LOCAL_LLM_EXPECTED_CHECKPOINT_SHA256: checkpoint.artifacts.checkpoint_selection.sha256,
  EMBEDDING_SERVICE_URL: embeddingBaseUrl,
  EMBEDDING_MODEL: PINNED_EMBEDDING_MODEL.repository,
  ALLOW_DEGRADED_EMBEDDINGS: "false",
  RERANK_SERVICE_URL: embeddingBaseUrl,
  RERANK_MODEL: PINNED_RERANKER_MODEL.repository,
  REQUIRE_CROSS_ENCODER_RERANK: "true",
  EVALUATION_MODEL_VERSION: checkpoint.modelId,
  EVALUATION_MODEL_REPOSITORY: checkpoint.training.base_model.repository || "mlx-community/Qwen3-8B-4bit",
  EVALUATION_MODEL_REVISION: checkpoint.training.base_model.revision || "",
  EVALUATION_MODEL_QUANTISATION: checkpoint.training.base_model.quantisation || "MLX-4bit",
  EVALUATION_LORA_ADAPTER: checkpoint.checkpoint.selected_adapter_path,
  VISIBLE_QUALIFICATION_RUN_LABEL: runLabel,
  VISIBLE_QUALIFICATION_CHECKPOINT_PATH: checkpoint.checkpointPath,
  VISIBLE_QUALIFICATION_OUTPUT_PARENT: outputParent,
  LIVE_RETRY_BACKOFF_MS:String(workerConfig.runtime.live_retry_backoff_ms),
  EVALUATION_HEALTH_TIMEOUT_MS:String(workerConfig.runtime.evaluation_health_timeout_ms),
  LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS:String(workerConfig.runtime.model_retry_health_probe_timeout_ms),
  LOCAL_LLM_RETRY_POLL_MS:String(workerConfig.runtime.model_retry_poll_ms),
  LOCAL_LLM_STATUS_TIMEOUT_MS:String(workerConfig.runtime.model_status_timeout_ms),
  EMBEDDING_RETRY_BACKOFF_MS:String(workerConfig.runtime.embedding_retry_backoff_ms),
  QUALIFICATION_RUNTIME_MODE:"true",
  QUALIFICATION_RUNTIME_CONFIGURATION_SHA256:runtimeConfigurationSha256,
};

let activeChild = null;
let interruptedSignal = null;
function forwardSignal(signal) {
  interruptedSignal = signal;
  activeChild?.kill("SIGTERM");
}
const onSigint = () => forwardSignal("SIGINT");
const onSigterm = () => forwardSignal("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

async function runScript(script, extraEnvironment = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(PROJECT_ROOT, script)], {
      cwd: PROJECT_ROOT,
      env: { ...baseEnvironment, ...extraEnvironment },
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      activeChild = null;
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeChild = null;
      if (code === 0 && !signal) accept();
      else reject(new Error(`${script} exited with ${signal || code}`));
    });
  });
}

function beginStage(name, commands) {
  manifest.stages[name] = {
    status: "running",
    started_at: now(),
    completed_at: null,
    commands,
    gate: null,
  };
  writeJsonAtomic(paths.manifest, manifest);
}

function completeStage(name) {
  manifest.stages[name].status = "passed";
  manifest.stages[name].completed_at = now();
  if (paths.gates[name] && existsSync(paths.gates[name])) manifest.stages[name].gate = fileRecord(paths.gates[name]);
  writeJsonAtomic(paths.manifest, manifest);
}

async function runGate(stage) {
  await runScript("scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs", {
    VISIBLE_QUALIFICATION_GATE_STAGE: stage,
  });
}

async function executeStage(stage) {
  if (stage === "critical4") {
    beginStage("critical4", [
      { script: "scripts/evaluationCycleV1PostFixRegression.mjs", question_ids: CRITICAL_IDS },
      { script: "scripts/evaluationCycleV1PostFixScore.mjs" },
      { script: "scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs", stage: "critical4" },
    ]);
    await runScript("scripts/evaluationCycleV1PostFixRegression.mjs", { POST_FIX_RUN_LABEL: paths.critical4.label, EVALUATION_QUESTION_IDS: CRITICAL_IDS.join(",") });
    await runScript("scripts/evaluationCycleV1PostFixScore.mjs", { POST_FIX_RUN_LABEL: paths.critical4.label, EVALUATION_QUESTION_IDS: CRITICAL_IDS.join(",") });
    await runGate("critical4");
    completeStage("critical4");
    return;
  }
  if (stage === "full69") {
    beginStage("full69", [
      { script: "scripts/evaluationCycleV1PostFixRegression.mjs", question_ids: "all_69_visible" },
      { script: "scripts/evaluationCycleV1PostFixScore.mjs" },
      { script: "scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs", stage: "full69" },
    ]);
    await runScript("scripts/evaluationCycleV1PostFixRegression.mjs", { POST_FIX_RUN_LABEL: paths.full69.label, EVALUATION_QUESTION_IDS: "" });
    await runScript("scripts/evaluationCycleV1PostFixScore.mjs", { POST_FIX_RUN_LABEL: paths.full69.label, EVALUATION_QUESTION_IDS: "" });
    await runGate("full69");
    completeStage("full69");
    return;
  }
  if (stage === "topic161") {
    beginStage("topic161", Object.entries(paths.topic161).flatMap(([wave, run]) => [
      { script: "scripts/evaluationCycleV2Wave1Run.mjs", wave, question_ids: `all_${visibleAssets.waves[wave].count}_visible`, run_label: run.label },
      { script: "scripts/evaluationCycleV2Wave1Score.mjs", wave, run_label: run.label },
    ]).concat([{ script: "scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs", stage: "topic161" }]));
    for (const [wave, run] of Object.entries(paths.topic161)) {
      const env = {
        CYCLE_V2_WAVE: wave, CYCLE_V2_RUN_LABEL: run.label,
        CYCLE_V2_QUESTION_IDS: "", CYCLE_V2_WAVE1_QUESTION_IDS: "",
        CYCLE_V2_PACK_ROOT: REPLACEMENT_TOPIC161_ROOT,
        CYCLE_V2_GOLD_PATH: resolve(REPLACEMENT_TOPIC161_ROOT, `${wave}/evaluation-gold.json`),
      };
      await runScript("scripts/evaluationCycleV2Wave1Run.mjs", env);
      await runScript("scripts/evaluationCycleV2Wave1Score.mjs", env);
    }
    await runGate("topic161");
    completeStage("topic161");
    return;
  }
  if (stage === "frozen13") {
    beginStage("frozen13", Object.entries(paths.frozen13).flatMap(([wave, run]) => [
      { script: "scripts/evaluationCycleV2Wave1Run.mjs", wave, question_ids: visibleAssets.frozen13.ids_by_wave[wave], run_label: run.label },
      { script: "scripts/evaluationCycleV2Wave1Score.mjs", wave, run_label: run.label },
    ]).concat([{ script: "scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs", stage: "frozen13" }]));
    for (const [wave, run] of Object.entries(paths.frozen13)) {
      const ids = visibleAssets.frozen13.ids_by_wave[wave];
      const env = {
        CYCLE_V2_WAVE: wave, CYCLE_V2_RUN_LABEL: run.label,
        CYCLE_V2_QUESTION_IDS: ids.join(","), CYCLE_V2_WAVE1_QUESTION_IDS: "",
        CYCLE_V2_PACK_ROOT: ORIGINAL_PACK_ROOT,
        CYCLE_V2_GOLD_PATH: resolve(PROJECT_ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/gold/evaluation-gold.json`),
      };
      await runScript("scripts/evaluationCycleV2Wave1Run.mjs", env);
      await runScript("scripts/evaluationCycleV2Wave1Score.mjs", env);
    }
    await runGate("frozen13");
    completeStage("frozen13");
    return;
  }
  if (stage === "final") {
    beginStage("final", [{ script: "scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs", stage: "final" }]);
    await runGate("final");
    completeStage("final");
    manifest.status = "completed_owner_authorised_visible_qualification_passed";
    manifest.completed_at = now();
    manifest.final_gate = fileRecord(paths.gates.final);
    manifest.scope.sealed_unseen_accessed = false;
    writeJsonAtomic(paths.manifest, manifest);
  }
}

async function executeRequestedStage() {
  const order = requestedStage === "all" ? ["critical4", "full69", "topic161", "frozen13", "final"] : [requestedStage];
  for (const stage of order) await executeStage(stage);
}

try {
  await executeRequestedStage();
  console.log(JSON.stringify({
    status: manifest.status,
    run_label: runLabel,
    model_id: checkpoint.modelId,
    orchestration_manifest: paths.manifest,
    final_gate: paths.gates.final,
    sealed_unseen_accessed: false,
  }, null, 2));
} catch (error) {
  const activeStage = Object.entries(manifest.stages).find(([, value]) => value.status === "running")?.[0] || null;
  if (activeStage) {
    manifest.stages[activeStage].status = interruptedSignal ? "interrupted" : "failed";
    manifest.stages[activeStage].completed_at = now();
    manifest.stages[activeStage].error = error.message;
  }
  manifest.status = interruptedSignal ? "interrupted_use_new_run_label" : "failed_use_new_run_label";
  manifest.completed_at = now();
  manifest.failure = { stage: activeStage, message: error.message, signal: interruptedSignal };
  manifest.scope.sealed_unseen_accessed = false;
  writeJsonAtomic(paths.manifest, manifest);
  throw error;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
