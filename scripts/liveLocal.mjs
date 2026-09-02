import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_SYSTEM_POLICY } from "../server/prompts/answerPolicy.js";
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
  const local = process.platform === "win32"
    ? join(PROJECT_ROOT, ".venv", "Scripts", "python.exe")
    : join(PROJECT_ROOT, ".venv", "bin", "python");
  if (existsSync(local)) return local;
  return process.platform === "win32" ? "python" : "python3";
}

function verifyPinnedRetrievalCache() {
  const serverPath = resolve(PROJECT_ROOT, "ml/embedding_server.py");
  const manifestPath = resolve(PROJECT_ROOT, "models/model-manifest.json");
  if (sha256File(serverPath) !== PINNED_RETRIEVAL_SERVER_SHA256 ||
    sha256File(manifestPath) !== PINNED_RETRIEVAL_MANIFEST_SHA256) {
    throw new Error("Pinned retrieval source or model manifest changed.");
  }
  const probe = spawnSync(retrievalPython(), [serverPath, "--identity-preflight"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 60_000,
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
  const checkpoint = readJson(checkpointPath, "Checkpoint selection");
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
  const baseSha = fullSha(training.base_model?.model_sha256, "base-model hash");
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
    modelId: `${checkpoint.model_version}-step${checkpoint.selected_iteration}`,
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
const corpusPath = release?.corpusPath || resolve(process.env.APPROVED_CORPUS_MANIFEST_PATH || DEFAULT_CORPUS_MANIFEST);
if (!existsSync(corpusPath)) throw new Error(`Approved-corpus manifest is missing: ${corpusPath}`);
const corpusSha = release?.corpusSha || sha256File(corpusPath);
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
  ...process.env,
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
  PINNED_MODEL_DEADLINE_MS: process.env.PENSION_LIVE_MODEL_DEADLINE_MS || "300000",
  PINNED_MODEL_STARTUP_MS: process.env.PENSION_LIVE_MODEL_STARTUP_MS || "180000",
  LOCAL_LLM_TIMEOUT_MS: process.env.PENSION_LIVE_MODEL_TIMEOUT_MS || "305000",
  LOCAL_LLM_MAX_TOKENS: process.env.PENSION_LIVE_MAX_TOKENS || "192",
  LLM_CONTEXT_SOURCE_LIMIT: process.env.PENSION_LIVE_SOURCE_LIMIT || "2",
  LLM_SOURCE_SNIPPET_CHARS: process.env.PENSION_LIVE_SNIPPET_CHARS || "350",
  EMBEDDING_SERVICE_URL: retrievalUrl,
  EMBEDDING_MODEL: PINNED_EMBEDDING_MODEL.repository,
  EMBEDDING_TIMEOUT_MS: process.env.PENSION_LIVE_EMBEDDING_TIMEOUT_MS || "60000",
  RERANK_SERVICE_URL: retrievalUrl,
  RERANK_MODEL: PINNED_RERANKER_MODEL.repository,
  RERANK_TIMEOUT_MS: process.env.PENSION_LIVE_RERANK_TIMEOUT_MS || "60000",
  ALLOW_DEGRADED_EMBEDDINGS: "false",
  REQUIRE_CROSS_ENCODER_RERANK: "true",
  PENSIONS_STORAGE: "sqlite",
  PENSIONS_DB_PATH: process.env.PENSIONS_DB_PATH || resolve(PROJECT_ROOT, "data/pensions-dashboard.sqlite"),
  APPROVED_CORPUS_MANIFEST_PATH: corpusPath,
  APPROVED_CORPUS_MANIFEST_SHA256: corpusSha,
  APPROVED_CORPUS_MIN_DOCUMENTS: process.env.PENSION_LIVE_CORPUS_MIN_DOCUMENTS || "200",
  REQUIRE_AUTH: process.env.REQUIRE_AUTH || "false",
  AGENT_SCHEDULER_ENABLED: process.env.AGENT_SCHEDULER_ENABLED || "false",
};

const children = new Map();
let stopping = false;

function start(name, script) {
  const child = spawn(process.execPath, [resolve(PROJECT_ROOT, script)], {
    cwd: PROJECT_ROOT,
    env: environment,
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
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      const body = await response.json();
      if (response.ok && validate(body)) return body;
      last = `${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((accept) => setTimeout(accept, 1_000));
  }
  throw new Error(`${label} did not become ready (${last}).`);
}

async function warmRetrieval() {
  await waitForJson(
    `${retrievalUrl}/health`,
    (body) => pinnedRetrievalHealthMatches(body),
    300_000,
    "Retrieval service",
  );
  await waitForJson(
    `${retrievalUrl}/embed`,
    (body) => pinnedEmbeddingResponseMatches(body),
    120_000,
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
    300_000,
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
      temperature: 0,
      top_p: 1,
      max_tokens: 1,
      seed: 42,
      messages: [
        { role: "system", content: `/no_think\n${ANSWER_SYSTEM_POLICY}` },
        { role: "user", content: "Local-live system-prefix warm-up. Return JSON only." },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
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
  const response = await fetch(`${appUrl}/chat`,{
    method:"POST",
    headers:{ "content-type":"application/json","x-demo-user-id":"local-live-smoke" },
    body:JSON.stringify({
      message:question,
      client_request_id:`local-live-smoke-${Date.now()}`,
    }),
    signal:AbortSignal.timeout(Number(environment.LOCAL_LLM_TIMEOUT_MS) + 15_000),
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
  }, 5_000);
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
      300_000,
      "Pinned answer model",
    ),
    warmRetrieval(),
  ]);
  await warmModelPrefix();
  start("dashboard", "server.js");
  await waitForJson(
    `${appUrl}/api/status`,
    (body) => body?.status === "ok" && body?.model?.available === true,
    60_000,
    "Dashboard",
  );
  await waitForJson(
    `${appUrl}/api/ready?force=1`,
    (body) => body?.ready === true && body?.checks?.every((check) => check.ready === true),
    120_000,
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
