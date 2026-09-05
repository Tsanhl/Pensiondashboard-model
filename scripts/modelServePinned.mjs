import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPinnedModelServer } from "../server/services/pinnedModelServer.js";

const checkpoint = resolve(process.env.PENSION_CHECKPOINT_PATH || "training/evaluation-cycle-v2/02-wave-3-execution/training/cumulative-lora-v1/checkpoint-selection.json");
const python = String(process.env.PINNED_MODEL_PYTHON || (process.env.QUALIFICATION_RUNTIME_MODE === "true" ? "" : resolve(".training-venv/bin/python"))).trim();
const qualificationMode = process.env.QUALIFICATION_RUNTIME_MODE === "true";
if (!python || !existsSync(python)) throw new Error("PINNED_MODEL_PYTHON must name the verified qualification interpreter.");
if (qualificationMode &&
    [process.env.QUALIFICATION_RUNTIME_CONFIGURATION_SHA256,process.env.QUALIFICATION_PYTHON_ENVIRONMENT_SHA256,
      process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_SHA256,process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_SHA256,
      process.env.QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,process.env.QUALIFICATION_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256].some((value) => !/^[0-9a-f]{64}$/.test(String(value || "")))) {
  throw new Error("Qualification model runtime bindings are missing or malformed.");
}
if (qualificationMode && (!process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_PATH || !existsSync(process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_PATH))) throw new Error("Qualification base-model directory manifest path is missing.");
const numberSetting = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric.`);
  return value;
};
const booleanSetting = (name, fallback) => {
  const value = String(process.env[name] ?? fallback);
  if (!new Set(["true","false"]).has(value)) throw new Error(`${name} must be true or false.`);
  return value === "true";
};
const inference = {
  max_tokens:numberSetting("LOCAL_LLM_MAX_TOKENS",320),temperature:numberSetting("LOCAL_LLM_TEMPERATURE",0),
  top_p:numberSetting("LOCAL_LLM_TOP_P",1),seed:numberSetting("LOCAL_LLM_SEED",42),
  context_limit_tokens:numberSetting("PINNED_MODEL_CONTEXT_LIMIT_TOKENS",8192),prefill_step_size:numberSetting("PINNED_MODEL_PREFILL_STEP_SIZE",256),
  cache_limit_bytes:numberSetting("PINNED_MODEL_CACHE_LIMIT_BYTES",128 * 1024 * 1024),enable_thinking:booleanSetting("PINNED_MODEL_ENABLE_THINKING","false"),
  system_prefix_cache:booleanSetting("PINNED_MODEL_SYSTEM_PREFIX_CACHE","true"),trust_remote_code:booleanSetting("PINNED_MODEL_TRUST_REMOTE_CODE","false"),
  add_generation_prompt:booleanSetting("PINNED_MODEL_ADD_GENERATION_PROMPT","true"),
  base_model_directory_manifest_path:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_PATH || "",
  base_model_directory_manifest_sha256:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_SHA256 || "",
  base_model_directory_sha256:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_SHA256 || "",
};
if (!Number.isInteger(inference.max_tokens) || !Number.isInteger(inference.seed) || !Number.isInteger(inference.context_limit_tokens) || !Number.isInteger(inference.prefill_step_size) || !Number.isInteger(inference.cache_limit_bytes)) throw new Error("Pinned integer inference settings are invalid.");
const serverPolicy = {
  worker_kill_grace_ms:numberSetting("PINNED_MODEL_WORKER_KILL_GRACE_MS",1_000),
  worker_restart_limit:numberSetting("PINNED_MODEL_WORKER_RESTART_LIMIT",3),
  request_body_limit_bytes:numberSetting("PINNED_MODEL_REQUEST_BODY_LIMIT_BYTES",100_000),
  headers_timeout_ms:numberSetting("PINNED_MODEL_HEADERS_TIMEOUT_MS",10_000),
};
if (Object.values(serverPolicy).some((value) => !Number.isInteger(value) || value < 1)) throw new Error("Pinned model-server policy is invalid.");
if (qualificationMode && ["PINNED_MODEL_WORKER_KILL_GRACE_MS","PINNED_MODEL_WORKER_RESTART_LIMIT","PINNED_MODEL_REQUEST_BODY_LIMIT_BYTES","PINNED_MODEL_HEADERS_TIMEOUT_MS"].some((name) => !process.env[name])) throw new Error("Qualification model-server policy must be explicitly pinned.");
const isolatedLauncher = resolve("scripts/isolatedPythonLauncher.py");
const modelWorker = resolve("ml/pinned_mlx_worker.py");
const service = createPinnedModelServer({
  command: python,
  args: ["-I","-B",isolatedLauncher,"--root",resolve("ml"),"--verify-module",`pinned_prompt_cache=${resolve("ml/pinned_prompt_cache.py")}`,"--script",modelWorker,checkpoint,JSON.stringify(inference)],
  // Evaluation clients retain their own 120-second case timeout. The slightly
  // longer supervisor window permits one non-scored system-prefix warm-up on
  // slower 16 GB Macs; a client timeout/disconnect still cancels immediately.
  deadlineMs: Number(process.env.PINNED_MODEL_DEADLINE_MS || 180_000),
  startupMs: Number(process.env.PINNED_MODEL_STARTUP_MS || 120_000),
  workerKillGraceMs:serverPolicy.worker_kill_grace_ms,
  workerRestartLimit:serverPolicy.worker_restart_limit,
  requestBodyLimitBytes:serverPolicy.request_body_limit_bytes,
  headersTimeoutMs:serverPolicy.headers_timeout_ms,
  generationPolicy:qualificationMode ? { enforce_exact:true,max_tokens:inference.max_tokens,temperature:inference.temperature,top_p:inference.top_p,seed:inference.seed } : null,
  runtimeBindings:qualificationMode ? {
    runtime_configuration_sha256:process.env.QUALIFICATION_RUNTIME_CONFIGURATION_SHA256,
    python_environment_sha256:process.env.QUALIFICATION_PYTHON_ENVIRONMENT_SHA256,
    generation_temperature:inference.temperature,generation_top_p:inference.top_p,generation_seed:inference.seed,
    model_max_tokens:inference.max_tokens,model_context_limit_tokens:inference.context_limit_tokens,
    model_prefill_step_size:inference.prefill_step_size,model_cache_limit_bytes:inference.cache_limit_bytes,
    model_enable_thinking:inference.enable_thinking,model_system_prefix_cache:inference.system_prefix_cache,
    model_trust_remote_code:inference.trust_remote_code,model_add_generation_prompt:inference.add_generation_prompt,
    python_isolated:true,python_no_user_site:true,python_ignore_environment:true,python_safe_path:true,python_dont_write_bytecode:true,
    base_model_directory_manifest_sha256:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_SHA256,
    base_model_directory_sha256:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_SHA256,
    retrieval_snapshot_manifest_sha256:process.env.QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
    retrieval_snapshot_contents_sha256:process.env.QUALIFICATION_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
  } : {},
});
service.server.listen(Number(process.env.PINNED_MODEL_PORT || 8080), "127.0.0.1", () => console.log("Local pinned MLX service starting (not a production server)"));
service.server.on("error", async (error) => { console.error(error.message); await service.stop(); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await service.stop(); });
