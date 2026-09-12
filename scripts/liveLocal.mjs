import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {localCheckpointDescriptor} from './lib/localCheckpointDescriptor.mjs';
import { ANSWER_SYSTEM_POLICY } from "../server/prompts/answerPolicy.js";
import { deriveQualificationStageCapabilityKey, mintQualificationRequestCapability } from "../server/services/qualificationContextService.js";
import { safeHostEnvironment } from "./lib/qualification-worker/processEnvironment.mjs";
import { qualificationChildEnvironment } from "./lib/qualification-worker/qualificationChildEnvironment.mjs";
import { qualificationRuntimeChildSandboxProfile, runtimeChildEnvironment } from "./lib/qualification-worker/runtimeChildEnvironment.mjs";
import {
  PINNED_EMBEDDING_MODEL,
  PINNED_RERANKER_MODEL,
  PINNED_RETRIEVAL_MANIFEST_SHA256,
  PINNED_RETRIEVAL_SERVER_SHA256,
  pinnedEmbeddingResponseMatches,
  pinnedRerankerResponseMatches,
  pinnedRetrievalHealthMatches,
  pinnedRetrievalIdentity,
} from "../server/services/pinnedRetrievalIdentity.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_RELEASE_MANIFEST = resolve(PROJECT_ROOT, "runtime/local-live-release.json");
const DEFAULT_CORPUS_MANIFEST = resolve(PROJECT_ROOT, "approved-materials/approved-corpus-manifest.json");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

const qualificationRunId = option("--qualification-run-id");
const qualificationOwnerToken = option("--qualification-owner-token");
if ((qualificationRunId || qualificationOwnerToken) &&
    (!/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(qualificationRunId || "")) ||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(qualificationOwnerToken || "")))) {
  throw new Error("Qualification runtime ownership arguments are incomplete or invalid.");
}

function pinnedTiming(name, fallback) {
  const raw = process.env[name];
  if (qualificationRunId && (raw == null || raw === "")) throw new Error(`${name} is required in qualification mode.`);
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const TIMING = Object.freeze({
  retrievalIdentityPreflight:pinnedTiming("QUALIFICATION_RETRIEVAL_IDENTITY_PREFLIGHT_TIMEOUT_MS",60_000),
  serviceRequest:pinnedTiming("QUALIFICATION_SERVICE_REQUEST_TIMEOUT_MS",10_000),
  servicePoll:pinnedTiming("QUALIFICATION_SERVICE_POLL_INTERVAL_MS",1_000),
  retrievalHealth:pinnedTiming("QUALIFICATION_RETRIEVAL_HEALTH_READY_TIMEOUT_MS",300_000),
  embeddingWarmup:pinnedTiming("QUALIFICATION_EMBEDDING_WARMUP_TIMEOUT_MS",120_000),
  rerankerWarmup:pinnedTiming("QUALIFICATION_RERANKER_WARMUP_TIMEOUT_MS",300_000),
  modelReady:pinnedTiming("QUALIFICATION_MODEL_READY_TIMEOUT_MS",300_000),
  modelWarmup:pinnedTiming("QUALIFICATION_MODEL_WARMUP_TIMEOUT_MS",180_000),
  smokeMargin:pinnedTiming("QUALIFICATION_SMOKE_TIMEOUT_MARGIN_MS",15_000),
  childShutdown:pinnedTiming("QUALIFICATION_CHILD_SHUTDOWN_GRACE_MS",5_000),
});

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function fullSha(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ""))) {
    throw new Error(`${label} must be a full SHA-256 digest.`);
  }
  return String(value).toLowerCase();
}

function projectPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
  return resolve(PROJECT_ROOT, value);
}

function verifySmallArtifact(path, expected, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
  const actual = sha256File(path);
  if (actual !== fullSha(expected, `${label} hash`)) throw new Error(`${label} hash mismatch.`);
  return actual;
}

function retrievalPython() {
  const pinned = String(process.env.PINNED_RETRIEVAL_PYTHON || "").trim();
  if (qualificationRunId || pinned) {
    if (!pinned || !existsSync(pinned)) throw new Error("Qualification retrieval Python executable is not pinned or is missing.");
    return pinned;
  }
  const local = process.platform === "win32"
    ? join(PROJECT_ROOT, ".retrieval-venv", "Scripts", "python.exe")
    : join(PROJECT_ROOT, ".retrieval-venv", "bin", "python");
  if (existsSync(local)) return local;
  return process.platform === "win32" ? "python" : "python3";
}

function verifyPinnedRetrievalCache() {
  const serverPath = resolve(PROJECT_ROOT, "ml/embedding_server.py");
  const manifestPath = resolve(PROJECT_ROOT, "models/model-manifest.json");
  const isolatedLauncher = resolve(PROJECT_ROOT,"scripts/isolatedPythonLauncher.py");
  if (sha256File(serverPath) !== PINNED_RETRIEVAL_SERVER_SHA256 ||
    sha256File(manifestPath) !== PINNED_RETRIEVAL_MANIFEST_SHA256) {
    throw new Error("Pinned retrieval source or model manifest changed.");
  }
  const probe = spawnSync(retrievalPython(), ["-I","-B",isolatedLauncher,"--root",PROJECT_ROOT,"--verify-module",`ml.embedding_server=${serverPath}`,"--module","ml.embedding_server","--identity-preflight"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: TIMING.retrievalIdentityPreflight,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (probe.status !== 0) {
    throw new Error(`Pinned retrieval cache preflight failed: ${(probe.stderr || probe.stdout || "unknown error").trim().slice(0, 300)}`);
  }
  let identity;
  try { identity = JSON.parse(String(probe.stdout || "").trim()); }
  catch { throw new Error("Pinned retrieval cache preflight returned invalid JSON."); }
  const expected = pinnedRetrievalIdentity();
  if (Object.entries(expected).some(([key, value]) => identity?.[key] !== value) ||
    identity?.embedding_snapshot_revision !== PINNED_EMBEDDING_MODEL.revision ||
    identity?.reranker_snapshot_revision !== PINNED_RERANKER_MODEL.revision) {
    throw new Error("Pinned retrieval cache preflight returned the wrong snapshot identity.");
  }
  return expected;
}

function loadReleaseManifest(path) {
  if (!existsSync(path)) return null;
  const manifest = readJson(path, "Local-live release manifest");
  if (manifest.status !== "approved_for_owner_local_live" || manifest.release_authorised !== true) {
    throw new Error("The local-live release manifest does not authorise this checkpoint.");
  }
  const checkpointPath = projectPath(manifest.checkpoint_path, "release checkpoint_path");
  verifySmallArtifact(
    checkpointPath,
    manifest.checkpoint_sha256,
    "Release checkpoint selection",
  );
  for (const [name, record] of Object.entries(manifest.bound_gates || {})) {
    const boundPath = projectPath(record?.path, `${name}.path`);
    verifySmallArtifact(boundPath, record?.sha256, `Release gate ${name}`);
  }
  const corpusRecord = manifest.approved_corpus_manifest;
  const corpusPath = projectPath(corpusRecord?.path, "approved_corpus_manifest.path");
  const corpusSha = verifySmallArtifact(corpusPath,corpusRecord?.sha256,"Approved corpus manifest");
  const retrieval = manifest.pinned_retrieval_runtime;
  for (const [name, record] of Object.entries({
    model_manifest:retrieval?.model_manifest,
    server_source:retrieval?.server_source,
    identity_module:retrieval?.identity_module,
  })) {
    const boundPath = projectPath(record?.path, `pinned_retrieval_runtime.${name}.path`);
    verifySmallArtifact(boundPath,record?.sha256,`Pinned retrieval ${name}`);
  }
  if (JSON.stringify(retrieval?.identity) !== JSON.stringify(pinnedRetrievalIdentity())) {
    throw new Error("The local-live release manifest identifies a different retrieval runtime.");
  }
  return { manifest, checkpointPath, path,corpusPath,corpusSha,retrievalIdentity:retrieval.identity };
}

function loadCheckpoint(path) {
  const checkpointPath = resolve(path);
  const descriptor=localCheckpointDescriptor(readJson(checkpointPath, "Checkpoint selection"));
  const checkpoint=descriptor.checkpoint;
  const trainingManifestPath = resolve(checkpointPath, "../training-run-manifest.json");
  const training = readJson(trainingManifestPath, "Training run manifest");
  const adapterPath = projectPath(checkpoint.selected_adapter_path, "selected_adapter_path");
  const basePath = projectPath(training.base_model?.path, "base_model.path");
  const adapterSha = verifySmallArtifact(
    resolve(adapterPath, "adapters.safetensors"),
    checkpoint.adapter_sha256,
    "Selected adapter",
  );
  const adapterConfigSha = verifySmallArtifact(
    resolve(adapterPath, "adapter_config.json"),
    checkpoint.adapter_config_sha256,
    "Selected adapter config",
  );
  const baseWeights = resolve(basePath, "model.safetensors");
  if (!existsSync(baseWeights) || !statSync(baseWeights).isFile()) {
    throw new Error(`Pinned base-model weights are missing: ${baseWeights}`);
  }
  const baseSha = fullSha(
    training.base_model?.model_sha256 || training.base_model?.sha256,
    "base-model hash",
  );
  if (!Number.isInteger(checkpoint.selected_iteration) || checkpoint.selected_iteration < 0) {
    throw new Error("Checkpoint selected_iteration is invalid.");
  }
  if (typeof checkpoint.model_version !== "string" || !checkpoint.model_version.trim()) {
    throw new Error("Checkpoint model_version is missing.");
  }
  return {
    checkpoint,
    training,
    checkpointPath,
    checkpointSha: sha256File(checkpointPath),
    adapterSha,
    adapterConfigSha,
    baseSha,
    modelId: `${checkpoint.model_version}-${descriptor.modelIdSuffix}`,
  };
}

const explicitCheckpoint = option("--checkpoint") || process.env.PENSION_CHECKPOINT_PATH;
const releaseManifestPath = resolve(
  option("--release-manifest") ||
    process.env.PENSION_LIVE_RELEASE_PATH ||
    DEFAULT_RELEASE_MANIFEST,
);
const smokeQuestion = option("--smoke-question");
const release = explicitCheckpoint ? null : loadReleaseManifest(releaseManifestPath);
const checkpointPath = explicitCheckpoint
  ? resolve(PROJECT_ROOT, explicitCheckpoint)
  : release?.checkpointPath;
if (!checkpointPath) {
  throw new Error(
    "No approved local-live release is installed. Supply --checkpoint /absolute/path/checkpoint-selection.json for an owner-local development run.",
  );
}
const pinned = loadCheckpoint(checkpointPath);
const mode = release ? "approved owner-local live" : "owner-local development";
const explicitCorpusPath = option("--corpus-manifest");
const explicitCorpusSha = option("--corpus-sha256");
if (Boolean(explicitCorpusPath) !== Boolean(explicitCorpusSha)) throw new Error("--corpus-manifest and --corpus-sha256 must be supplied together.");
const corpusPath = release?.corpusPath || (explicitCorpusPath ? resolve(PROJECT_ROOT, explicitCorpusPath) : resolve(process.env.APPROVED_CORPUS_MANIFEST_PATH || DEFAULT_CORPUS_MANIFEST));
if (!existsSync(corpusPath)) throw new Error(`Approved-corpus manifest is missing: ${corpusPath}`);
const corpusSha = release?.corpusSha || (explicitCorpusSha
  ? verifySmallArtifact(corpusPath, explicitCorpusSha, "Qualification approved corpus manifest")
  : sha256File(corpusPath));
const retrievalPreflight = verifyPinnedRetrievalCache();
if (release && JSON.stringify(release.retrievalIdentity) !== JSON.stringify(retrievalPreflight)) {
  throw new Error("Pinned retrieval runtime changed after owner-local release approval.");
}

if (args.includes("--preflight")) {
  console.log(JSON.stringify({
    ok: true,
    mode,
    model_id: pinned.modelId,
    checkpoint_path: pinned.checkpointPath,
    checkpoint_sha256: pinned.checkpointSha,
    adapter_sha256: pinned.adapterSha,
    base_sha256: pinned.baseSha,
    approved_corpus_manifest:corpusPath,
    approved_corpus_manifest_sha256:corpusSha,
    pinned_retrieval_runtime:retrievalPreflight,
    release_manifest: release?.path || null,
  }, null, 2));
  process.exit(0);
}

const modelPort = Number(option("--model-port") || process.env.PINNED_MODEL_PORT || 8080);
const retrievalPort = Number(option("--retrieval-port") || process.env.ML_PORT || 8090);
const appPort = Number(option("--port") || process.env.PORT || 3000);
for (const [label, value] of Object.entries({ modelPort, retrievalPort, appPort })) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} is invalid.`);
}

const modelUrl = `http://127.0.0.1:${modelPort}`;
const retrievalUrl = `http://127.0.0.1:${retrievalPort}`;
const appUrl = `http://127.0.0.1:${appPort}`;
const environment = {
  ...(qualificationRunId ? safeHostEnvironment(process.env) : process.env),
  NODE_ENV: "development",
  PORT: String(appPort),
  PINNED_MODEL_PORT: String(modelPort),
  ML_PORT: String(retrievalPort),
  PENSION_CHECKPOINT_PATH: pinned.checkpointPath,
  LOCAL_LLM_TRANSPORT: "openai",
  LOCAL_LLM_BASE_URL: modelUrl,
  LOCAL_LLM_MODEL: pinned.modelId,
  LOCAL_LLM_EXPECTED_ADAPTER_SHA256: pinned.adapterSha,
  LOCAL_LLM_EXPECTED_ADAPTER_CONFIG_SHA256: pinned.adapterConfigSha,
  LOCAL_LLM_EXPECTED_BASE_SHA256: pinned.baseSha,
  LOCAL_LLM_EXPECTED_CHECKPOINT_SHA256: pinned.checkpointSha,
  LOCAL_LLM_EXPECTED_RUNTIME_CONFIGURATION_SHA256:process.env.LOCAL_LLM_EXPECTED_RUNTIME_CONFIGURATION_SHA256 || "",
  LOCAL_LLM_EXPECTED_PYTHON_ENVIRONMENT_SHA256:process.env.LOCAL_LLM_EXPECTED_PYTHON_ENVIRONMENT_SHA256 || "",
  PINNED_MODEL_DEADLINE_MS: process.env.PENSION_LIVE_MODEL_DEADLINE_MS || "300000",
  PINNED_MODEL_STARTUP_MS: process.env.PENSION_LIVE_MODEL_STARTUP_MS || "180000",
  LOCAL_LLM_TIMEOUT_MS: process.env.PENSION_LIVE_MODEL_TIMEOUT_MS || "305000",
  LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS:process.env.LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS || "2000",
  LOCAL_LLM_RETRY_POLL_MS:process.env.LOCAL_LLM_RETRY_POLL_MS || "1000",
  LOCAL_LLM_STATUS_TIMEOUT_MS:process.env.LOCAL_LLM_STATUS_TIMEOUT_MS || "1200",
  LOCAL_LLM_MAX_TOKENS: process.env.PENSION_LIVE_MAX_TOKENS || "192",
  LOCAL_LLM_TEMPERATURE:process.env.PENSION_LIVE_GENERATION_TEMPERATURE || "0",
  LOCAL_LLM_TOP_P:process.env.PENSION_LIVE_GENERATION_TOP_P || "1",
  LOCAL_LLM_SEED:process.env.PENSION_LIVE_GENERATION_SEED || "42",
  LOCAL_LLM_CONTEXT_TOKENS:process.env.PENSION_MODEL_CONTEXT_LIMIT_TOKENS || "8192",
  PINNED_MODEL_CONTEXT_LIMIT_TOKENS:process.env.PENSION_MODEL_CONTEXT_LIMIT_TOKENS || "8192",
  PINNED_MODEL_PREFILL_STEP_SIZE:process.env.PENSION_MODEL_PREFILL_STEP_SIZE || "256",
  PINNED_MODEL_CACHE_LIMIT_BYTES:process.env.PENSION_MODEL_CACHE_LIMIT_BYTES || String(128 * 1024 * 1024),
  PINNED_MODEL_ENABLE_THINKING:process.env.PENSION_MODEL_ENABLE_THINKING || "false",
  PINNED_MODEL_SYSTEM_PREFIX_CACHE:process.env.PENSION_MODEL_SYSTEM_PREFIX_CACHE || "true",
  PINNED_MODEL_TRUST_REMOTE_CODE:process.env.PENSION_MODEL_TRUST_REMOTE_CODE || "false",
  PINNED_MODEL_ADD_GENERATION_PROMPT:process.env.PENSION_MODEL_ADD_GENERATION_PROMPT || "true",
  PINNED_MODEL_WORKER_KILL_GRACE_MS:process.env.PINNED_MODEL_WORKER_KILL_GRACE_MS || "1000",
  PINNED_MODEL_WORKER_RESTART_LIMIT:process.env.PINNED_MODEL_WORKER_RESTART_LIMIT || "3",
  PINNED_MODEL_REQUEST_BODY_LIMIT_BYTES:process.env.PINNED_MODEL_REQUEST_BODY_LIMIT_BYTES || "100000",
  PINNED_MODEL_HEADERS_TIMEOUT_MS:process.env.PINNED_MODEL_HEADERS_TIMEOUT_MS || "10000",
  LLM_CONTEXT_SOURCE_LIMIT: process.env.PENSION_LIVE_SOURCE_LIMIT || "4",
  LLM_SOURCE_SNIPPET_CHARS: process.env.PENSION_LIVE_SNIPPET_CHARS || "1800",
  EMBEDDING_SERVICE_URL: retrievalUrl,
  EMBEDDING_MODEL: PINNED_EMBEDDING_MODEL.repository,
  EMBEDDING_TIMEOUT_MS: process.env.PENSION_LIVE_EMBEDDING_TIMEOUT_MS || "60000",
  EMBEDDING_BATCH_SIZE: process.env.EMBEDDING_BATCH_SIZE || "8",
  EMBEDDING_RETRIES: process.env.EMBEDDING_RETRIES || "4",
  EMBEDDING_RETRY_BACKOFF_MS:process.env.EMBEDDING_RETRY_BACKOFF_MS || "750",
  RERANK_SERVICE_URL: retrievalUrl,
  RERANK_MODEL: PINNED_RERANKER_MODEL.repository,
  RERANK_TIMEOUT_MS: process.env.PENSION_LIVE_RERANK_TIMEOUT_MS || "60000",
  ALLOW_DEGRADED_EMBEDDINGS: "false",
  REQUIRE_CROSS_ENCODER_RERANK: "true",
  APPROVED_CORPUS_BOOTSTRAP_ON_START: process.env.APPROVED_CORPUS_BOOTSTRAP_ON_START || (release ? "false" : "true"),
  READINESS_DEPENDENCY_TIMEOUT_MS: process.env.READINESS_DEPENDENCY_TIMEOUT_MS || "20000",
  PENSIONS_STORAGE: "sqlite",
  PENSIONS_DB_PATH: process.env.PENSIONS_DB_PATH || resolve(PROJECT_ROOT, "data/pensions-dashboard.sqlite"),
  APPROVED_CORPUS_MANIFEST_PATH: corpusPath,
  APPROVED_CORPUS_MANIFEST_SHA256: corpusSha,
  APPROVED_CORPUS_MIN_DOCUMENTS: process.env.PENSION_LIVE_CORPUS_MIN_DOCUMENTS || "200",
  RETRIEVAL_MIN_SCORE:process.env.RETRIEVAL_MIN_SCORE || "0.18",
  DEGRADED_RETRIEVAL_MIN_SCORE:process.env.DEGRADED_RETRIEVAL_MIN_SCORE || "0.04",
  CHAT_RATE_LIMIT:process.env.CHAT_RATE_LIMIT || "1000",
  AUTHENTICATED_USER_ID:process.env.AUTHENTICATED_USER_ID || "alex-morgan",
  HUMAN_SUPPORT_EMAIL:process.env.HUMAN_SUPPORT_EMAIL || "",
  DISABLE_DOTENV_LOAD:qualificationRunId ? "true" : String(process.env.DISABLE_DOTENV_LOAD || "false"),
  QUALIFICATION_RUNTIME_MODE:qualificationRunId ? "true" : "false",
  QUALIFICATION_RUNTIME_CONFIGURATION_SHA256:process.env.QUALIFICATION_RUNTIME_CONFIGURATION_SHA256 || "",
  QUALIFICATION_PYTHON_ENVIRONMENT_SHA256:process.env.QUALIFICATION_PYTHON_ENVIRONMENT_SHA256 || "",
  QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_SHA256:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_SHA256 || "",
  QUALIFICATION_BASE_MODEL_DIRECTORY_SHA256:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_SHA256 || "",
  QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_PATH:process.env.QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_PATH || "",
  QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256:process.env.QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256 || "",
  QUALIFICATION_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256:process.env.QUALIFICATION_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256 || "",
  QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_PATH:process.env.QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_PATH || "",
  PINNED_MODEL_PYTHON:process.env.PINNED_MODEL_PYTHON || "",
  PINNED_RETRIEVAL_PYTHON:retrievalPython(),
  PENSION_RETRIEVAL_DEVICE:process.env.PENSION_RETRIEVAL_DEVICE || "cpu",
  PENSION_RETRIEVAL_THREADS:process.env.PENSION_RETRIEVAL_THREADS || "2",
  TZ:process.env.TZ || "Asia/Hong_Kong",
  REQUIRE_AUTH: process.env.REQUIRE_AUTH || "false",
  AGENT_SCHEDULER_ENABLED: process.env.AGENT_SCHEDULER_ENABLED || "false",
};
const qualificationDashboardEnvironment = qualificationRunId ? {
  ...qualificationChildEnvironment(process.env,true),
  QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM:process.env.QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM || "",
  QUALIFICATION_NONCE_STORE_PATH:process.env.QUALIFICATION_NONCE_STORE_PATH || "",
  QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH:process.env.QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH || "",
  QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256:process.env.QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256 || "",
} : {};

const children = new Map();
let stopping = false;

function start(name, script) {
  const childScript = resolve(PROJECT_ROOT,script);
  const sandboxed = Boolean(qualificationRunId);
  if (sandboxed && !existsSync("/usr/bin/sandbox-exec")) throw new Error("Qualification runtime child sandbox is unavailable.");
  const runRoot = qualificationDashboardEnvironment.QUALIFICATION_NONCE_STORE_PATH
    ? dirname(qualificationDashboardEnvironment.QUALIFICATION_NONCE_STORE_PATH)
    : null;
  const command = sandboxed ? "/usr/bin/sandbox-exec" : process.execPath;
  const childArgs = sandboxed ? ["-p",qualificationRuntimeChildSandboxProfile({
    runRoot,projectRoot:PROJECT_ROOT,
    nonceStorePath:qualificationDashboardEnvironment.QUALIFICATION_NONCE_STORE_PATH,
    allowedContextManifestPath:qualificationDashboardEnvironment.QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH,
    childName:name,databasePath:environment.PENSIONS_DB_PATH,
  }),process.execPath,childScript] : [childScript];
  const child = spawn(command, childArgs, {
    cwd: PROJECT_ROOT,
    env: runtimeChildEnvironment(environment,qualificationDashboardEnvironment,name),
    stdio: "inherit",
  });
  children.set(name, child);
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      console.error(`${name} stopped unexpectedly (${signal || code}).`);
      void stopAll(1);
    }
  });
  child.once("error", (error) => {
    console.error(`${name} could not start: ${error.message}`);
  });
  return child;
}

async function waitForJson(url, validate, timeoutMs, label, init = undefined) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMING.serviceRequest) });
      const body = await response.json();
      if (response.ok && validate(body)) return body;
      last = `${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((accept) => setTimeout(accept, TIMING.servicePoll));
  }
  throw new Error(`${label} did not become ready (${last}).`);
}

async function warmRetrieval() {
  await waitForJson(
    `${retrievalUrl}/health`,
    (body) => pinnedRetrievalHealthMatches(body),
    TIMING.retrievalHealth,
    "Retrieval service",
  );
  await waitForJson(
    `${retrievalUrl}/embed`,
    (body) => pinnedEmbeddingResponseMatches(body),
    TIMING.embeddingWarmup,
    "Embedding model",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model:PINNED_EMBEDDING_MODEL.repository,texts: ["pension assistant local-live warm-up"], normalize: true }),
    },
  );
  await waitForJson(
    `${retrievalUrl}/rerank`,
    (body) => pinnedRerankerResponseMatches(body),
    TIMING.rerankerWarmup,
    "Cross-encoder reranker",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model:PINNED_RERANKER_MODEL.repository,
        query: "pension assistant local-live warm-up",
        documents: ["pension assistant local-live warm-up"],
        top_n: 1,
      }),
    },
  );
}

async function warmModelPrefix() {
  const response = await fetch(`${modelUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: pinned.modelId,
      temperature: Number(environment.LOCAL_LLM_TEMPERATURE),
      top_p: Number(environment.LOCAL_LLM_TOP_P),
      max_tokens: Number(environment.LOCAL_LLM_MAX_TOKENS),
      seed: Number(environment.LOCAL_LLM_SEED),
      messages: [
        { role: "system", content: `/no_think\n${ANSWER_SYSTEM_POLICY}` },
        { role: "user", content: "Local-live system-prefix warm-up. Return JSON only." },
      ],
    }),
    signal: AbortSignal.timeout(TIMING.modelWarmup),
  });
  if (!response.ok) {
    throw new Error(`Pinned answer-model warm-up failed with ${response.status}.`);
  }
  const payload = await response.json();
  if (payload?.runtime_identity?.id !== pinned.modelId) {
    throw new Error("Pinned answer-model warm-up returned the wrong identity.");
  }
}

async function smokeChat(question) {
  const clientRequestId = `local-live-smoke-${Date.now()}`;
  const qualificationCapability = qualificationRunId ? mintQualificationRequestCapability({
    secret:deriveQualificationStageCapabilityKey(process.env.QUALIFICATION_CONTEXT_HMAC_KEY,"VERIFY_RUNTIME"),
    runId:qualificationRunId,stageId:"VERIFY_RUNTIME",caseId:"runtime-smoke",clientRequestId,message:question,
  }) : null;
  const response = await fetch(`${appUrl}/chat`,{
    method:"POST",
    headers:{ "content-type":"application/json","x-demo-user-id":"local-live-smoke",...(qualificationRunId ? { "x-qualification-stage-id":"VERIFY_RUNTIME","x-qualification-case-id":"runtime-smoke" } : {}) },
    body:JSON.stringify({
      message:question,
      client_request_id:clientRequestId,
      ...(qualificationCapability ? { qualification_capability:{ payload:qualificationCapability.payload,signature:qualificationCapability.signature } } : {}),
    }),
    signal:AbortSignal.timeout(Number(environment.LOCAL_LLM_TIMEOUT_MS) + TIMING.smokeMargin),
  });
  const payload = await response.json();
  if (!response.ok || typeof payload?.answer !== "string" || !payload.answer.trim()) {
    throw new Error(`Dashboard chat smoke failed with ${response.status}.`);
  }
  return payload;
}

async function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const running = [...children.values()];
  for (const child of running.reverse()) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of running) if (child.exitCode == null) child.kill("SIGKILL");
  }, TIMING.childShutdown);
  timer.unref();
  await Promise.all(running.map((child) => child.exitCode == null
    ? new Promise((accept) => child.once("exit", accept))
    : Promise.resolve()));
  process.exitCode = exitCode;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void stopAll(0));
}

try {
  console.log(`Starting ${mode} with ${pinned.modelId}.`);
  start("pinned answer model", "scripts/modelServePinned.mjs");
  start("retrieval models", "scripts/mlServe.mjs");
  await Promise.all([
    waitForJson(
      `${modelUrl}/v1/models`,
      (body) => body?.ready === true && body?.data?.some((item) =>
        item.id === pinned.modelId &&
        item.adapter_sha256 === pinned.adapterSha &&
        item.base_sha256 === pinned.baseSha),
      TIMING.modelReady,
      "Pinned answer model",
    ),
    warmRetrieval(),
  ]);
  await warmModelPrefix();
  start("dashboard", "server.js");
  await waitForJson(
    `${appUrl}/api/status`,
    (body) => body?.status === "ok" && body?.model?.available === true,
    Number(process.env.PENSION_LIVE_DASHBOARD_STATUS_MS || 900_000),
    "Dashboard",
  );
  await waitForJson(
    `${appUrl}/api/ready?force=1`,
    (body) => body?.ready === true && body?.checks?.every((check) => check.ready === true),
    Number(process.env.PENSION_LIVE_DASHBOARD_READY_MS || 180_000),
    "Dashboard readiness",
  );
  console.log(`Pension dashboard is running at ${appUrl}`);
  console.log(`Mode: ${mode}; model: ${pinned.modelId}`);
  if (smokeQuestion) {
    const smoke = await smokeChat(smokeQuestion);
    console.log("Local-live answer smoke passed.");
    console.log(smoke.answer);
  }
  console.log("Press Ctrl-C to stop all three local services.");
} catch (error) {
  console.error(`Local-live startup failed: ${error.message}`);
  await stopAll(1);
}
