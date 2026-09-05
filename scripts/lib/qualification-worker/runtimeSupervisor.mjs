import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { CRITICAL_IDS,loadAndVerifyCheckpoint, verifyLiveRuntime } from "../postTrainingVisibleQualificationV1.mjs";
import { normaliseQualificationContext,qualificationContextSha256,qualificationJurisdictionFromValues } from "../../../server/services/qualificationContextService.js";
import { projectQualificationFixtureValues } from "../../../server/services/qualificationFixtureSchema.js";
import { assertPathAllowed } from "./protectedPaths.mjs";
import { safeHostEnvironment } from "./processEnvironment.mjs";
import { verifyPythonEnvironments } from "./pythonEnvironment.mjs";
import { verifyRuntimeArtifactManifests } from "./runtimeArtifactManifests.mjs";
import { atomicWrite, canonicalHash, createExclusive, durableMkdir, durableUnlink, now, readJson, sha256File, sleep } from "./utils.mjs";

export const QUALIFICATION_CONTEXT_KEY_FILE = "runtime-qualification-context.key";
export const QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE = "runtime-response-signing-public.pem";
export const QUALIFICATION_NONCE_STORE_DIRECTORY = "runtime-consumed-capability-nonces";
export const QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_DIRECTORY = "runtime/qualification-allowed-contexts";

function allowedContextManifestPath(projectRoot,runId) {
  return resolve(projectRoot,QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_DIRECTORY,`${runId}.json`);
}

function allowedContextManifestRecord(path) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw Object.assign(new Error("Qualification allowed-context manifest is missing or unsafe."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  const manifest = readJson(path);
  if (manifest.version !== "qualification-allowed-context-manifest-v1" || !/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(manifest.run_id || "")) || !Array.isArray(manifest.entries)) {
    throw Object.assign(new Error("Qualification allowed-context manifest has an invalid identity."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  }
  const identities = manifest.entries.map((entry) => `${entry.stage_id}\0${entry.case_id}\0${entry.context_sha256}`);
  if (identities.length !== new Set(identities).size || manifest.entries.some((entry) => !["VISIBLE_CRITICAL4","VISIBLE_FULL69"].includes(entry.stage_id) || !/^[a-f0-9]{64}$/.test(String(entry.context_sha256 || "")))) {
    throw Object.assign(new Error("Qualification allowed-context manifest entries are invalid or duplicated."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  }
  return { path,manifest,sha256:sha256File(path) };
}

function createAllowedContextManifest(projectRoot,runId,config) {
  const reviewRelative = "training/gold-answer-review.json";
  const reviewPath = assertPathAllowed(projectRoot,reviewRelative,config.protected_path_patterns);
  const expectedReviewSha = config.qualification_input_sha256?.[reviewRelative];
  if (!/^[a-f0-9]{64}$/.test(String(expectedReviewSha || "")) || sha256File(reviewPath) !== expectedReviewSha) {
    throw Object.assign(new Error("Visible synthetic-fixture review pack identity mismatch."),{ code:"SOURCE_IDENTITY_MISMATCH" });
  }
  const review = readJson(reviewPath);
  if (!Array.isArray(review.items) || review.items.length !== 69) throw Object.assign(new Error("Visible synthetic-fixture review pack must contain exactly 69 items."),{ code:"FROZEN_QUALIFICATION_INPUT_DEFECT" });
  const entries = [];
  for (const item of review.items) {
    const values = projectQualificationFixtureValues(item.id,item.synthetic_fixture?.values || {});
    const normalized = normaliseQualificationContext({
      version:"qualification-synthetic-context-v1",
      case_id:item.id,
      declared_jurisdiction:qualificationJurisdictionFromValues(values),
      conversation_context:item.conversation_context || [],
      synthetic_fixture:{ ...item.synthetic_fixture,values },
    });
    const contextSha256 = qualificationContextSha256(normalized);
    entries.push({ stage_id:"VISIBLE_FULL69",case_id:item.id,context_sha256:contextSha256 });
    if (CRITICAL_IDS.includes(item.id)) entries.push({ stage_id:"VISIBLE_CRITICAL4",case_id:item.id,context_sha256:contextSha256 });
  }
  entries.sort((left,right) => `${left.stage_id}\0${left.case_id}`.localeCompare(`${right.stage_id}\0${right.case_id}`));
  const path = allowedContextManifestPath(projectRoot,runId);
  durableMkdir(dirname(path),{ mode:0o700 });
  createExclusive(path,{
    version:"qualification-allowed-context-manifest-v1",
    created_at:now(),
    run_id:runId,
    source_path:reviewRelative,
    source_sha256:expectedReviewSha,
    entries,
    entries_sha256:canonicalHash(entries),
  },{ mode:0o444 });
  return allowedContextManifestRecord(path);
}

function readQualificationContextKey(runRoot) {
  const path = join(runRoot,QUALIFICATION_CONTEXT_KEY_FILE);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw Object.assign(new Error("Qualification context capability key is missing or unsafe."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  const key = readFileSync(path,"utf8");
  if (!/^[0-9a-f]{64}$/.test(key)) throw Object.assign(new Error("Qualification context capability key is invalid."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  return { path,key,sha256:sha256File(path) };
}

function readQualificationResponsePublicKey(runRoot) {
  const path = join(runRoot,QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw Object.assign(new Error("Qualification response-signing public key is missing or unsafe."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  const pem = readFileSync(path,"utf8");
  if (!pem.includes("PUBLIC KEY")) throw Object.assign(new Error("Qualification response-signing public key is invalid."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  return { path,pem,sha256:sha256File(path) };
}

export function removeQualificationContextKey(runRoot) {
  const path = join(runRoot,QUALIFICATION_CONTEXT_KEY_FILE);
  if (!existsSync(path)) return { removed:true,reason:"already_absent",path };
  if (lstatSync(path).isSymbolicLink()) return { removed:false,reason:"key_path_is_symlink",path };
  durableUnlink(path);
  return { removed:!existsSync(path),reason:existsSync(path) ? "removal_failed" : "removed",path };
}

async function portOpen(port, timeoutMs) {
  return new Promise((accept) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); accept(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function fetchJson(url, timeoutMs = 5_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, body: null, error: error.message };
  }
}

export function verifyCandidate(projectRoot, config, { verifyLargeBaseModel = true } = {}) {
  const checkpointPath = resolve(projectRoot, config.candidate.checkpoint_path);
  const loaded = loadAndVerifyCheckpoint(checkpointPath, { verifyLargeBaseModel });
  const exactConfiguredArtifacts = {
    checkpoint_selection:config.candidate.checkpoint_path,
    adapter_weights:config.candidate.adapter_path,
    adapter_config:config.candidate.adapter_config_path,
    base_model_weights:config.candidate.base_model_path,
    model_config:config.candidate.model_config_path,
    tokenizer:config.candidate.tokenizer_path,
    tokenizer_config:config.candidate.tokenizer_config_path,
  };
  for (const [name, configuredPath] of Object.entries(exactConfiguredArtifacts)) {
    const safeConfigured = assertPathAllowed(projectRoot, configuredPath, config.protected_path_patterns);
    if (safeConfigured !== loaded.artifacts[name]?.path) {
      throw Object.assign(new Error(`Manifest-derived ${name} does not equal the configured candidate path.`), { code:"CANDIDATE_IDENTITY_MISMATCH" });
    }
  }
  const selected = loaded.checkpoint;
  if (selected.selected_iteration !== config.candidate.selected_iteration || selected.selected_iteration === config.candidate.forbidden_iteration) {
    throw Object.assign(new Error(`Checkpoint iteration mismatch: ${selected.selected_iteration}`), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  }
  if (selected.adapter_sha256 !== config.candidate.adapter_sha256 || selected.adapter_sha256 === config.candidate.forbidden_adapter_sha256) {
    throw Object.assign(new Error("Selected adapter SHA-256 mismatch or forbidden iteration-312 adapter."), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  }
  if (loaded.expectedIdentity.base_sha256 !== config.candidate.base_sha256) {
    throw Object.assign(new Error("Base model SHA-256 mismatch."), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  }
  if (sha256File(resolve(projectRoot, config.candidate.adapter_path)) !== config.candidate.adapter_sha256) {
    throw Object.assign(new Error("Adapter file does not match the selected checkpoint."), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  }
  return loaded;
}

async function verifyApp(config, expectedIdentity, sourceBindingsSha256, expectedCorpusIntegritySha256 = null, expectedCanonicalFactsSha256 = null,expectedPythonEnvironmentSha256 = null,expectedRunId = null,expectedCapabilityKeySha256 = null,expectedResponsePublicKeySha256 = null) {
  const [runtime, app] = await Promise.all([
    verifyLiveRuntime({
      modelBaseUrl: config.runtime.model_endpoint,
      embeddingBaseUrl: config.runtime.retrieval_endpoint,
      expectedIdentity,
      healthTimeoutMs:config.runtime.evaluation_health_timeout_ms,
      embeddingProbeTimeoutMs:config.runtime.embedding_warmup_timeout_ms,
      rerankerProbeTimeoutMs:config.runtime.reranker_warmup_timeout_ms,
      expectedRetrievalDevice:config.runtime.retrieval_device,
      expectedRetrievalThreads:config.runtime.retrieval_threads,
    }),
    fetchJson(`${config.runtime.canonical_endpoint}/api/ready?force=1`, config.runtime.dashboard_ready_probe_timeout_ms),
  ]);
  if (!app.ok || app.body?.ready !== true || !app.body?.checks?.every((check) => check.ready === true)) {
    throw new Error("Canonical dashboard endpoint is not fully ready.");
  }
  if (expectedPythonEnvironmentSha256 && (runtime.embedding_health?.body?.python_environment_sha256 !== expectedPythonEnvironmentSha256 ||
      runtime.embedding_health?.body?.runtime_configuration_sha256 !== canonicalHash(config.runtime) ||
      ["python_isolated","python_no_user_site","python_ignore_environment","python_safe_path","python_dont_write_bytecode"].some((key) => runtime.embedding_health?.body?.[key] !== true))) {
    throw new Error("Retrieval health does not expose the pinned Python environment and runtime configuration.");
  }
  if (!sourceBindingsSha256 || app.body?.qualification_source_bindings_sha256 !== sourceBindingsSha256) {
    throw new Error("Canonical dashboard endpoint does not expose the bound application-source digest.");
  }
  if (expectedRunId && (app.body?.qualification_run_id !== expectedRunId || app.body?.qualification_context_key_sha256 !== expectedCapabilityKeySha256 ||
      app.body?.qualification_response_public_key_sha256 !== expectedResponsePublicKeySha256)) {
    throw new Error("Canonical dashboard qualification run, context capability, or response-signing identity is not bound to the owned runtime.");
  }
  const approvedCorpus = app.body.checks.find((check) => check.name === "approvedCorpus");
  const corpusIntegritySha256 = String(approvedCorpus?.corpusIntegritySha256 || "");
  if (!/^[0-9a-f]{64}$/.test(corpusIntegritySha256) || approvedCorpus?.indexedChunksMatch !== true) {
    throw new Error("Canonical dashboard endpoint does not expose a verified indexed-corpus digest.");
  }
  if (approvedCorpus?.manifestSha256 !== config.runtime.approved_corpus_manifest_sha256) {
    throw new Error("Canonical dashboard loaded a corpus manifest other than the authoritative qualification input.");
  }
  if (expectedCorpusIntegritySha256 && corpusIntegritySha256 !== expectedCorpusIntegritySha256) {
    throw new Error("Canonical dashboard indexed-corpus digest changed after runtime verification.");
  }
  const canonicalFacts = app.body.checks.find((check) => check.name === "canonicalFacts");
  const canonicalFactsSha256 = String(canonicalFacts?.canonicalFactsSha256 || "");
  if (!/^[0-9a-f]{64}$/.test(canonicalFactsSha256) || canonicalFacts?.ready !== true || canonicalFacts?.actualCanonicalFactsSha256 !== canonicalFactsSha256) {
    throw new Error("Canonical qualification personal facts do not match the bound demo fixture.");
  }
  if (expectedCanonicalFactsSha256 && canonicalFactsSha256 !== expectedCanonicalFactsSha256) throw new Error("Canonical qualification personal-fact digest changed after runtime verification.");
  return { ...runtime,dashboard:app.body,corpus_integrity_sha256:corpusIntegritySha256,canonical_facts_sha256:canonicalFactsSha256 };
}

function processAlive(pid) {
  try { process.kill(Number(pid),0); return true; } catch { return false; }
}

function processGroupAlive(pid) {
  if (process.platform === "win32") return processAlive(pid);
  try { process.kill(-Number(pid),0); return true; } catch { return false; }
}

function signalSpawnedProcessGroup(pid, signal) {
  try { process.kill(-Number(pid),signal); return true; } catch {}
  try { process.kill(Number(pid),signal); return true; } catch {}
  return false;
}

async function stopDirectSpawnedRuntime(pid, config) {
  const result = { pid:Number(pid),started_at:now(),term_sent:false,kill_sent:false,stopped:false };
  if (!processGroupAlive(pid)) return { ...result,stopped:true,reason:"runtime_already_stopped",completed_at:now() };
  result.term_sent = signalSpawnedProcessGroup(pid,"SIGTERM");
  const termDeadline = Date.now() + config.runtime.runtime_stop_grace_ms;
  while (Date.now() < termDeadline && processGroupAlive(pid)) await sleep(config.runtime.runtime_stop_poll_ms);
  if (processGroupAlive(pid)) {
    result.kill_sent = signalSpawnedProcessGroup(pid,"SIGKILL");
    const killDeadline = Date.now() + config.runtime.runtime_kill_grace_ms;
    while (Date.now() < killDeadline && processGroupAlive(pid)) await sleep(config.runtime.runtime_kill_poll_ms);
  }
  result.stopped = !processGroupAlive(pid);
  result.completed_at = now();
  if (!result.stopped) result.reason = "spawned_runtime_did_not_stop";
  return result;
}

function processObservation(pid,pythonExecutable,probeScript,timeoutMs) {
  const result = spawnSync(pythonExecutable,["-I","-B",probeScript,String(pid)],{ encoding:"utf8",timeout:timeoutMs,env:{ ...safeHostEnvironment(),PYTHONHASHSEED:"0" } });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function ownedRuntimeRecordValid({ record,observation,expectedLauncher,expectedPid,expectedRunId }) {
  if (!record || record.pid !== Number(expectedPid) || record.run_id !== expectedRunId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(record.owner_token || "")) ||
      record.executable !== process.execPath || !observation || observation.pid !== Number(expectedPid) ||
      !Array.isArray(record.argv) || record.argv.some((value) => typeof value !== "string") || !Array.isArray(observation.argv)) return false;
  const runFlags = record.argv.reduce((rows,value,index) => value === "--qualification-run-id" ? [...rows,record.argv[index + 1]] : rows,[]);
  const tokenFlags = record.argv.reduce((rows,value,index) => value === "--qualification-owner-token" ? [...rows,record.argv[index + 1]] : rows,[]);
  let executableMatches = false;
  try { executableMatches = realpathSync.native(observation.executable) === realpathSync.native(record.executable); } catch {}
  return executableMatches && record.argv[0] === process.execPath && record.argv[1] === expectedLauncher &&
    canonicalHash(observation.argv) === canonicalHash(record.argv) &&
    runFlags.length === 1 && runFlags[0] === expectedRunId && tokenFlags.length === 1 && tokenFlags[0] === record.owner_token;
}

function interruptionError(message, cleanup = null) {
  return Object.assign(new Error(message),{ code:"WORKER_INTERRUPTED",...(cleanup ? { cleanup } : {}) });
}

function assertRuntimeLaunchAllowed(shouldStop, message) {
  if (shouldStop?.()) throw interruptionError(message);
}

export function verifyOwnedRuntimeProcess({ projectRoot,runRoot,expectedPid,expectedRunId,config,sourceBindingsSha256 }) {
  if (!expectedPid) throw Object.assign(new Error("No owned runtime PID is recorded for live-owner verification."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  const recordPath = join(runRoot,"runtime-process.json");
  if (!existsSync(recordPath)) throw Object.assign(new Error("Owned runtime process record is absent."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  if (!processAlive(expectedPid) || !processGroupAlive(expectedPid)) throw Object.assign(new Error("Recorded runtime process group is not live."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  const record = readJson(recordPath);
  const contextKey = readQualificationContextKey(runRoot);
  const responsePublicKey = readQualificationResponsePublicKey(runRoot);
  const allowedContexts = allowedContextManifestRecord(allowedContextManifestPath(projectRoot,expectedRunId));
  const python = verifyPythonEnvironments(projectRoot,config);
  const probeScript = resolve(projectRoot,"scripts/processArgvDarwin.py");
  const observation = processObservation(expectedPid,python.environments.retrieval.executable,probeScript,config.runtime.argv_probe_timeout_ms);
  const expectedLauncher = resolve(projectRoot,"scripts/liveLocal.mjs");
  if (!ownedRuntimeRecordValid({ record,observation,expectedLauncher,expectedPid,expectedRunId }) || record.source_bindings_sha256 !== sourceBindingsSha256 ||
      record.qualification_context_key_sha256 !== contextKey.sha256 || record.qualification_response_public_key_sha256 !== responsePublicKey.sha256 ||
      record.qualification_allowed_context_manifest_sha256 !== allowedContexts.sha256) {
    throw Object.assign(new Error("Live runtime does not match the recorded PID, run, owner token, launcher argv and source binding."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  }
  return {
    version:"qualification-live-runtime-owner-v1",
    verified_at:now(),
    pid:Number(expectedPid),
    run_id:expectedRunId,
    owner_token_sha256:canonicalHash(record.owner_token),
    executable:record.executable,
    argv_sha256:canonicalHash(record.argv),
    observation_sha256:canonicalHash(observation),
    source_bindings_sha256:sourceBindingsSha256,
    qualification_context_key_sha256:contextKey.sha256,
    qualification_response_public_key_sha256:responsePublicKey.sha256,
    qualification_allowed_context_manifest_sha256:allowedContexts.sha256,
  };
}

export async function stopOwnedRuntime({ projectRoot,runRoot,expectedPid,expectedRunId,timeoutMs = null,config = null,argvProbeExecutable = null,argvProbeScript = null }) {
  if (!expectedPid) return { stopped:false,reason:"no_recorded_runtime" };
  const recordPath = join(runRoot,"runtime-process.json");
  const record = existsSync(recordPath) ? readJson(recordPath) : null;
  if (!processAlive(expectedPid) && !processGroupAlive(expectedPid)) return { stopped:true,reason:"runtime_already_stopped",pid:Number(expectedPid) };
  if (!processAlive(expectedPid)) return { stopped:false,reason:"runtime_leader_stopped_but_group_remains",pid:Number(expectedPid) };
  if (config) {
    const python = verifyPythonEnvironments(projectRoot,config);
    argvProbeExecutable = python.environments.retrieval.executable;
    argvProbeScript = resolve(projectRoot,"scripts/processArgvDarwin.py");
  }
  if (!argvProbeExecutable || !argvProbeScript) throw Object.assign(new Error("A verified boundary-preserving process argv probe is required."), { code:"RUNTIME_OWNERSHIP_MISMATCH" });
  const contextKey = readQualificationContextKey(runRoot);
  const responsePublicKey = readQualificationResponsePublicKey(runRoot);
  const allowedContexts = allowedContextManifestRecord(allowedContextManifestPath(projectRoot,expectedRunId));
  const observation = processObservation(expectedPid,argvProbeExecutable,argvProbeScript,config?.runtime?.argv_probe_timeout_ms ?? 10_000);
  const expectedLauncher = resolve(projectRoot,"scripts/liveLocal.mjs");
  if (!ownedRuntimeRecordValid({ record,observation,expectedLauncher,expectedPid,expectedRunId }) || record.qualification_context_key_sha256 !== contextKey.sha256 ||
      record.qualification_response_public_key_sha256 !== responsePublicKey.sha256 || record.qualification_allowed_context_manifest_sha256 !== allowedContexts.sha256) {
    throw Object.assign(new Error("Refusing to stop a runtime without an exact owner token, run identity, PID, and launcher match."), { code:"RUNTIME_OWNERSHIP_MISMATCH" });
  }
  signalSpawnedProcessGroup(expectedPid,"SIGTERM");
  const stopGraceMs = timeoutMs ?? config?.runtime?.runtime_stop_grace_ms ?? 15_000;
  const stopPollMs = config?.runtime?.runtime_stop_poll_ms ?? 250;
  const killGraceMs = config?.runtime?.runtime_kill_grace_ms ?? 5_000;
  const killPollMs = config?.runtime?.runtime_kill_poll_ms ?? 100;
  const deadline = Date.now() + stopGraceMs;
  while (Date.now() < deadline && processGroupAlive(expectedPid)) await sleep(stopPollMs);
  if (processGroupAlive(expectedPid)) {
    signalSpawnedProcessGroup(expectedPid,"SIGKILL");
    const killDeadline = Date.now() + killGraceMs;
    while (Date.now() < killDeadline && processGroupAlive(expectedPid)) await sleep(killPollMs);
  }
  if (processGroupAlive(expectedPid)) throw Object.assign(new Error("Owned runtime process group did not stop."), { code:"INFRASTRUCTURE_TEMPORARY" });
  const stopRecordPath = join(runRoot,"runtime-stop.json");
  const result = { stopped:true,pid:Number(expectedPid),owner_token:record.owner_token,run_id:expectedRunId,completed_at:now(),stop_record_path:stopRecordPath };
  if (existsSync(stopRecordPath)) {
    const stored = readJson(stopRecordPath);
    const identity = ({ stopped,pid,owner_token,run_id }) => ({ stopped,pid,owner_token,run_id });
    if (canonicalHash(identity(stored)) !== canonicalHash(identity(result))) throw Object.assign(new Error("Existing runtime stop record has a different owner identity."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  } else createExclusive(stopRecordPath,result);
  return result;
}

export async function ensureRuntime({ projectRoot, config, runRoot, runId, priorRuntimePid = null, onSupervisorSpawn = null, sourceBindingsSha256,shouldStop = null }) {
  assertRuntimeLaunchAllowed(shouldStop,"Qualification worker interruption prevented runtime verification and launch.");
  const loaded = verifyCandidate(projectRoot, config, { verifyLargeBaseModel: true });
  const pythonEnvironments = verifyPythonEnvironments(projectRoot,config);
  const runtimeArtifacts = verifyRuntimeArtifactManifests(projectRoot,config);
  const argvProbeExecutable = pythonEnvironments.environments.retrieval.executable;
  const argvProbeScript = resolve(projectRoot,"scripts/processArgvDarwin.py");
  const runtimeConfigurationSha256 = canonicalHash(config.runtime);
  const expectedIdentity = {
    ...loaded.expectedIdentity,runtime_configuration_sha256:runtimeConfigurationSha256,python_environment_sha256:pythonEnvironments.environment_sha256,
    generation_temperature:config.runtime.generation_temperature,generation_top_p:config.runtime.generation_top_p,generation_seed:config.runtime.generation_seed,
    model_max_tokens:config.runtime.model_max_tokens,model_context_limit_tokens:config.runtime.model_context_limit_tokens,
    model_prefill_step_size:config.runtime.model_prefill_step_size,model_cache_limit_bytes:config.runtime.model_cache_limit_bytes,
    model_enable_thinking:config.runtime.model_enable_thinking,model_system_prefix_cache:config.runtime.model_system_prefix_cache,
    model_trust_remote_code:config.runtime.model_trust_remote_code,model_add_generation_prompt:config.runtime.model_add_generation_prompt,
    request_deadline_ms:config.runtime.model_deadline_ms,worker_startup_ms:config.runtime.model_startup_ms,
    worker_kill_grace_ms:config.runtime.model_worker_kill_grace_ms,worker_restart_limit:config.runtime.model_worker_restart_limit,
    request_body_limit_bytes:config.runtime.model_request_body_limit_bytes,headers_timeout_ms:Math.min(config.runtime.model_deadline_ms,config.runtime.model_headers_timeout_ms),
    python_isolated:true,python_no_user_site:true,python_ignore_environment:true,python_safe_path:true,python_dont_write_bytecode:true,
    ...runtimeArtifacts,
  };
  const corpusManifestPath = assertPathAllowed(projectRoot, config.runtime.approved_corpus_manifest_path, config.protected_path_patterns);
  if (sha256File(corpusManifestPath) !== config.runtime.approved_corpus_manifest_sha256 ||
      config.qualification_input_sha256?.[config.runtime.approved_corpus_manifest_path] !== config.runtime.approved_corpus_manifest_sha256) {
    throw Object.assign(new Error("Authoritative approved-corpus manifest identity mismatch."), { code:"SOURCE_IDENTITY_MISMATCH" });
  }
  const processRecordPath = join(runRoot, "runtime-process.json");
  const processRecord = existsSync(processRecordPath) ? readJson(processRecordPath) : null;
  const contextKeyPath = join(runRoot,QUALIFICATION_CONTEXT_KEY_FILE);
  let contextKeyRecord = null;
  if (existsSync(contextKeyPath)) contextKeyRecord = readQualificationContextKey(runRoot);
  const responsePublicKeyPath = join(runRoot,QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE);
  let responsePublicKeyRecord = null;
  if (existsSync(responsePublicKeyPath)) responsePublicKeyRecord = readQualificationResponsePublicKey(runRoot);
  const allowedContextPath = allowedContextManifestPath(projectRoot,runId);
  let allowedContextManifest = null;
  if (existsSync(allowedContextPath)) allowedContextManifest = allowedContextManifestRecord(allowedContextPath);
  const recoveredRuntimePid = priorRuntimePid || processRecord?.pid || null;
  const expectedLauncher = resolve(projectRoot, "scripts/liveLocal.mjs");
  const recoveredObservation = recoveredRuntimePid && processAlive(recoveredRuntimePid) ? processObservation(recoveredRuntimePid,argvProbeExecutable,argvProbeScript,config.runtime.argv_probe_timeout_ms) : null;
  const recordedCommandValid = ownedRuntimeRecordValid({ record:processRecord,observation:recoveredObservation,expectedLauncher,expectedPid:recoveredRuntimePid,expectedRunId:runId }) &&
    processRecord.source_bindings_sha256 === sourceBindingsSha256 && contextKeyRecord?.sha256 === processRecord.qualification_context_key_sha256 &&
    responsePublicKeyRecord?.sha256 === processRecord.qualification_response_public_key_sha256 &&
    allowedContextManifest?.sha256 === processRecord.qualification_allowed_context_manifest_sha256 && allowedContextManifest?.manifest?.run_id === runId;
  if (recoveredRuntimePid && !recordedCommandValid && (processAlive(recoveredRuntimePid) || processGroupAlive(recoveredRuntimePid))) {
    throw Object.assign(new Error("A persisted runtime process or process group remains but exact live ownership cannot be established; refusing cleanup or replacement."),{
      code:"RUNTIME_OWNERSHIP_MISMATCH",cleanup:{ stopped:false,reason:"persisted_runtime_ownership_unverified",pid:Number(recoveredRuntimePid) },
    });
  }
  if (recoveredRuntimePid && recordedCommandValid) {
    const recoveryDeadline = Date.now() + config.runtime.startup_timeout_ms;
    let lastRecoveryError = "runtime is still starting";
    while (Date.now() < recoveryDeadline) {
      if (shouldStop?.()) {
        let cleanup;
        try { cleanup = await stopOwnedRuntime({ projectRoot,runRoot,expectedPid:recoveredRuntimePid,expectedRunId:runId,config }); }
        catch (error) { cleanup = { stopped:false,code:error.code || null,error:error.message,completed_at:now() }; }
        throw interruptionError("Qualification worker interruption stopped owned-runtime recovery.",cleanup);
      }
      try {
        const runtime = await verifyApp(config,expectedIdentity,sourceBindingsSha256,processRecord?.corpus_integrity_sha256 || null,processRecord?.canonical_facts_sha256 || null,pythonEnvironments.environment_sha256,runId,contextKeyRecord.sha256,responsePublicKeyRecord.sha256);
        atomicWrite(processRecordPath, { ...processRecord,pid:recoveredRuntimePid,verified_at:now(),source_bindings_sha256:sourceBindingsSha256,corpus_integrity_sha256:runtime.corpus_integrity_sha256,canonical_facts_sha256:runtime.canonical_facts_sha256 });
        return { started:false,supervisor_pid:recoveredRuntimePid,verified_at:now(),runtime,expected_identity:expectedIdentity,corpus_integrity_sha256:runtime.corpus_integrity_sha256,canonical_facts_sha256:runtime.canonical_facts_sha256,runtime_configuration_sha256:runtimeConfigurationSha256,python_environment_sha256:pythonEnvironments.environment_sha256,qualification_response_public_key_sha256:responsePublicKeyRecord.sha256,recovered_after_interruption:true };
      } catch (error) {
        lastRecoveryError = error.message;
        if (!processAlive(recoveredRuntimePid)) break;
        await sleep(config.runtime.runtime_recovery_poll_ms);
      }
    }
    let cleanup;
    try {
      cleanup = await stopOwnedRuntime({ projectRoot,runRoot,expectedPid:recoveredRuntimePid,expectedRunId:runId,config });
    } catch (error) {
      cleanup = { stopped:false,error:error.message,code:error.code || null,completed_at:now() };
    }
    atomicWrite(processRecordPath,{ ...readJson(processRecordPath),recovery_cleanup:cleanup });
    throw Object.assign(new Error(`Owned runtime did not recover: ${lastRecoveryError}`), { code:"INFRASTRUCTURE_TEMPORARY",cleanup });
  }
  assertRuntimeLaunchAllowed(shouldStop,"Qualification worker interruption prevented runtime port preflight.");
  const ports = [config.runtime.app_port, config.runtime.model_port, config.runtime.retrieval_port];
  const occupancy = await Promise.all(ports.map((port) => portOpen(port,config.runtime.port_probe_timeout_ms)));
  assertRuntimeLaunchAllowed(shouldStop,"Qualification worker interruption occurred during runtime port preflight.");
  if (occupancy.some(Boolean)) {
    throw Object.assign(new Error("Required ports are occupied by a runtime not owned by this qualification run."), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  }

  durableMkdir(runRoot);
  if (contextKeyRecord || responsePublicKeyRecord || allowedContextManifest) throw Object.assign(new Error("Qualification capability, response-signing, or allowed-context material exists without a recoverable owned runtime."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  allowedContextManifest = createAllowedContextManifest(projectRoot,runId,config);
  createExclusive(contextKeyPath,randomBytes(32).toString("hex"));
  contextKeyRecord = readQualificationContextKey(runRoot);
  const responseKeyPair = generateKeyPairSync("ed25519",{
    publicKeyEncoding:{ type:"spki",format:"pem" },privateKeyEncoding:{ type:"pkcs8",format:"pem" },
  });
  createExclusive(responsePublicKeyPath,responseKeyPair.publicKey,{ mode:0o444 });
  responsePublicKeyRecord = readQualificationResponsePublicKey(runRoot);
  const nonceStorePath = join(runRoot,QUALIFICATION_NONCE_STORE_DIRECTORY);
  durableMkdir(nonceStorePath,{ mode:0o700 });
  const logPath = join(runRoot, "runtime.log");
  const ownerToken = randomUUID();
  const fd = openSync(logPath, "a");
  const childArgs = [
    resolve(projectRoot, "scripts/liveLocal.mjs"),
    "--checkpoint", resolve(projectRoot, config.candidate.checkpoint_path),
    "--port", String(config.runtime.app_port),
    "--model-port", String(config.runtime.model_port),
    "--retrieval-port", String(config.runtime.retrieval_port),
    "--corpus-manifest", corpusManifestPath,
    "--corpus-sha256", config.runtime.approved_corpus_manifest_sha256,
    "--qualification-run-id", runId,
    "--qualification-owner-token", ownerToken,
  ];
  assertRuntimeLaunchAllowed(shouldStop,"Qualification worker interruption prevented runtime spawn.");
  const child = spawn(process.execPath, childArgs, {
    cwd: projectRoot,
    env: {
      ...safeHostEnvironment(process.env),
      PORT: String(config.runtime.app_port),
      PINNED_MODEL_PORT: String(config.runtime.model_port),
      ML_PORT: String(config.runtime.retrieval_port),
      LOCAL_LLM_MAX_ATTEMPTS:String(config.runtime.model_max_attempts),
      LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY: "false",
      QUALIFICATION_ATTEMPT_TELEMETRY: "true",
      QUALIFICATION_RUN_ID:runId,
      QUALIFICATION_CONTEXT_HMAC_KEY:contextKeyRecord.key,
      QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM:responseKeyPair.privateKey,
      QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM:responsePublicKeyRecord.pem,
      QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_SHA256:responsePublicKeyRecord.sha256,
      QUALIFICATION_NONCE_STORE_PATH:nonceStorePath,
      QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH:allowedContextManifest.path,
      QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256:allowedContextManifest.sha256,
      QUALIFICATION_SOURCE_BINDINGS_SHA256: sourceBindingsSha256,
      QUALIFICATION_CANONICAL_USER_ID: "alex-morgan",
      CYCLE_V2_RETRY_RUN_ERRORS: "false",
      LIVE_MAX_ATTEMPTS:String(config.runtime.model_max_attempts),
      LIVE_CHAT_TIMEOUT_MS:String(config.runtime.live_chat_timeout_ms),
      LOCAL_LLM_RETRY_READY_TIMEOUT_MS:String(config.runtime.model_retry_ready_timeout_ms),
      LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS:String(config.runtime.model_retry_health_probe_timeout_ms),
      LOCAL_LLM_RETRY_POLL_MS:String(config.runtime.model_retry_poll_ms),
      LOCAL_LLM_STATUS_TIMEOUT_MS:String(config.runtime.model_status_timeout_ms),
      ALLOW_DEGRADED_EMBEDDINGS: "false",
      REQUIRE_CROSS_ENCODER_RERANK: "true",
      APPROVED_CORPUS_MANIFEST_PATH: corpusManifestPath,
      APPROVED_CORPUS_MANIFEST_SHA256: config.runtime.approved_corpus_manifest_sha256,
      APPROVED_CORPUS_BOOTSTRAP_ON_START: "true",
      PENSIONS_DB_PATH: assertPathAllowed(projectRoot,config.runtime.database_path,config.protected_path_patterns),
      PENSION_LIVE_MODEL_DEADLINE_MS:String(config.runtime.model_deadline_ms),
      PENSION_LIVE_MODEL_STARTUP_MS:String(config.runtime.model_startup_ms),
      PENSION_LIVE_MODEL_TIMEOUT_MS:String(config.runtime.model_timeout_ms),
      PENSION_LIVE_MAX_TOKENS:String(config.runtime.model_max_tokens),
      PENSION_LIVE_GENERATION_TEMPERATURE:String(config.runtime.generation_temperature),
      PENSION_LIVE_GENERATION_TOP_P:String(config.runtime.generation_top_p),
      PENSION_LIVE_GENERATION_SEED:String(config.runtime.generation_seed),
      PENSION_MODEL_CONTEXT_LIMIT_TOKENS:String(config.runtime.model_context_limit_tokens),
      PENSION_MODEL_PREFILL_STEP_SIZE:String(config.runtime.model_prefill_step_size),
      PENSION_MODEL_CACHE_LIMIT_BYTES:String(config.runtime.model_cache_limit_bytes),
      PENSION_MODEL_ENABLE_THINKING:String(config.runtime.model_enable_thinking),
      PENSION_MODEL_SYSTEM_PREFIX_CACHE:String(config.runtime.model_system_prefix_cache),
      PENSION_MODEL_TRUST_REMOTE_CODE:String(config.runtime.model_trust_remote_code),
      PENSION_MODEL_ADD_GENERATION_PROMPT:String(config.runtime.model_add_generation_prompt),
      PINNED_MODEL_WORKER_KILL_GRACE_MS:String(config.runtime.model_worker_kill_grace_ms),
      PINNED_MODEL_WORKER_RESTART_LIMIT:String(config.runtime.model_worker_restart_limit),
      PINNED_MODEL_REQUEST_BODY_LIMIT_BYTES:String(config.runtime.model_request_body_limit_bytes),
      PINNED_MODEL_HEADERS_TIMEOUT_MS:String(config.runtime.model_headers_timeout_ms),
      PENSION_LIVE_SOURCE_LIMIT:String(config.runtime.context_source_limit),
      PENSION_LIVE_SNIPPET_CHARS:String(config.runtime.source_snippet_chars),
      PENSION_LIVE_EMBEDDING_TIMEOUT_MS:String(config.runtime.embedding_timeout_ms),
      EMBEDDING_BATCH_SIZE:String(config.runtime.embedding_batch_size),
      EMBEDDING_RETRIES:String(config.runtime.embedding_retries),
      EMBEDDING_RETRY_BACKOFF_MS:String(config.runtime.embedding_retry_backoff_ms),
      PENSION_LIVE_RERANK_TIMEOUT_MS:String(config.runtime.rerank_timeout_ms),
      PENSION_LIVE_CORPUS_MIN_DOCUMENTS:String(config.runtime.approved_corpus_min_documents),
      RETRIEVAL_MIN_SCORE:String(config.runtime.retrieval_min_score),
      DEGRADED_RETRIEVAL_MIN_SCORE:String(config.runtime.degraded_retrieval_min_score),
      READINESS_DEPENDENCY_TIMEOUT_MS:String(config.runtime.readiness_dependency_timeout_ms),
      PENSION_LIVE_DASHBOARD_STATUS_MS:String(config.runtime.dashboard_status_timeout_ms),
      PENSION_LIVE_DASHBOARD_READY_MS:String(config.runtime.dashboard_ready_timeout_ms),
      CHAT_RATE_LIMIT:String(config.runtime.chat_rate_limit),
      AUTHENTICATED_USER_ID:"alex-morgan",
      HUMAN_SUPPORT_EMAIL:"",
      TZ:config.runtime.timezone,
      DISABLE_DOTENV_LOAD:"true",
      QUALIFICATION_RUNTIME_MODE:"true",
      PINNED_MODEL_PYTHON:pythonEnvironments.environments.model.executable,
      PINNED_RETRIEVAL_PYTHON:pythonEnvironments.environments.retrieval.executable,
      PENSION_RETRIEVAL_DEVICE:config.runtime.retrieval_device,
      PENSION_RETRIEVAL_THREADS:String(config.runtime.retrieval_threads),
      QUALIFICATION_RUNTIME_CONFIGURATION_SHA256:runtimeConfigurationSha256,
      QUALIFICATION_PYTHON_ENVIRONMENT_SHA256:pythonEnvironments.environment_sha256,
      QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_SHA256:runtimeArtifacts.base_model_directory_manifest_sha256,
      QUALIFICATION_BASE_MODEL_DIRECTORY_SHA256:runtimeArtifacts.base_model_directory_sha256,
      QUALIFICATION_BASE_MODEL_DIRECTORY_MANIFEST_PATH:resolve(projectRoot,config.runtime.base_model_directory_manifest_path),
      QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256:runtimeArtifacts.retrieval_snapshot_manifest_sha256,
      QUALIFICATION_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256:runtimeArtifacts.retrieval_snapshot_contents_sha256,
      QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_PATH:resolve(projectRoot,config.runtime.retrieval_snapshot_manifest_path),
      LOCAL_LLM_EXPECTED_RUNTIME_CONFIGURATION_SHA256:runtimeConfigurationSha256,
      LOCAL_LLM_EXPECTED_PYTHON_ENVIRONMENT_SHA256:pythonEnvironments.environment_sha256,
      REQUIRE_AUTH:"false",
      AGENT_SCHEDULER_ENABLED:"false",
      QUALIFICATION_RETRIEVAL_IDENTITY_PREFLIGHT_TIMEOUT_MS:String(config.runtime.retrieval_identity_preflight_timeout_ms),
      QUALIFICATION_SERVICE_REQUEST_TIMEOUT_MS:String(config.runtime.service_request_timeout_ms),
      QUALIFICATION_SERVICE_POLL_INTERVAL_MS:String(config.runtime.service_poll_interval_ms),
      QUALIFICATION_RETRIEVAL_HEALTH_READY_TIMEOUT_MS:String(config.runtime.retrieval_health_ready_timeout_ms),
      QUALIFICATION_EMBEDDING_WARMUP_TIMEOUT_MS:String(config.runtime.embedding_warmup_timeout_ms),
      QUALIFICATION_RERANKER_WARMUP_TIMEOUT_MS:String(config.runtime.reranker_warmup_timeout_ms),
      QUALIFICATION_MODEL_READY_TIMEOUT_MS:String(config.runtime.model_ready_timeout_ms),
      QUALIFICATION_MODEL_WARMUP_TIMEOUT_MS:String(config.runtime.model_warmup_timeout_ms),
      QUALIFICATION_SMOKE_TIMEOUT_MARGIN_MS:String(config.runtime.smoke_timeout_margin_ms),
      QUALIFICATION_CHILD_SHUTDOWN_GRACE_MS:String(config.runtime.child_shutdown_grace_ms),
    },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  try {
    if (shouldStop?.()) throw interruptionError("Qualification worker interruption reached the runtime spawn boundary.");
    onSupervisorSpawn?.(child.pid);
    if (shouldStop?.()) throw interruptionError("Qualification worker interruption followed runtime registration.");
  } catch (error) {
    const cleanup = await stopDirectSpawnedRuntime(child.pid,config);
    atomicWrite(join(runRoot,"runtime-startup-cleanup.json"),{ reason:"WORKER_INTERRUPTED_AT_RUNTIME_SPAWN",run_id:runId,cleanup });
    throw interruptionError(error.message,cleanup);
  }
  const argv = [process.execPath,...childArgs];
  let initialObservation = null;
  for (let attempt = 0; attempt < config.runtime.argv_probe_attempts && !initialObservation; attempt += 1) {
    if (shouldStop?.()) {
      const cleanup = await stopDirectSpawnedRuntime(child.pid,config);
      atomicWrite(join(runRoot,"runtime-startup-cleanup.json"),{ reason:"WORKER_INTERRUPTED_DURING_ARGV_PROOF",run_id:runId,cleanup });
      throw interruptionError("Qualification worker interruption stopped runtime argv verification.",cleanup);
    }
    initialObservation = processObservation(child.pid,argvProbeExecutable,argvProbeScript,config.runtime.argv_probe_timeout_ms);
    if (!initialObservation) await sleep(config.runtime.argv_probe_poll_ms);
  }
  if (!ownedRuntimeRecordValid({ record:{ pid:child.pid,run_id:runId,owner_token:ownerToken,executable:process.execPath,argv },observation:initialObservation,expectedLauncher,expectedPid:child.pid,expectedRunId:runId })) {
    const cleanup = await stopDirectSpawnedRuntime(child.pid,config);
    atomicWrite(join(runRoot,"runtime-startup-cleanup.json"),{ reason:"ARGV_IDENTITY_NOT_PROVEN",run_id:runId,cleanup });
    throw Object.assign(new Error("New runtime did not expose its exact boundary-preserving argv identity."), { code:"RUNTIME_OWNERSHIP_MISMATCH",cleanup });
  }
  atomicWrite(processRecordPath, { pid:child.pid,run_id:runId,owner_token:ownerToken,executable:process.execPath,argv,started_at:now(),command:argv.join(" "),observed_executable:initialObservation.executable,observed_argv:initialObservation.argv,observation_sha256:canonicalHash(initialObservation),source_bindings_sha256:sourceBindingsSha256,qualification_context_key_sha256:contextKeyRecord.sha256,qualification_response_public_key_sha256:responsePublicKeyRecord.sha256,qualification_response_public_key_path:responsePublicKeyPath,qualification_allowed_context_manifest_path:allowedContextManifest.path,qualification_allowed_context_manifest_sha256:allowedContextManifest.sha256,nonce_store_path:nonceStorePath,log_path:logPath });

  const deadline = Date.now() + config.runtime.startup_timeout_ms;
  let lastError = "starting";
  while (Date.now() < deadline) {
    if (shouldStop?.()) {
      const cleanup = await stopDirectSpawnedRuntime(child.pid,config);
      atomicWrite(processRecordPath,{ ...readJson(processRecordPath),startup_cleanup:cleanup });
      throw interruptionError("Qualification worker interruption stopped runtime readiness verification.",cleanup);
    }
    try {
      const runtime = await verifyApp(config,expectedIdentity,sourceBindingsSha256,null,null,pythonEnvironments.environment_sha256,runId,contextKeyRecord.sha256,responsePublicKeyRecord.sha256);
      atomicWrite(processRecordPath, { ...readJson(processRecordPath),verified_at:now(),corpus_integrity_sha256:runtime.corpus_integrity_sha256,canonical_facts_sha256:runtime.canonical_facts_sha256 });
      return { started:true,supervisor_pid:child.pid,verified_at:now(),runtime,expected_identity:expectedIdentity,corpus_integrity_sha256:runtime.corpus_integrity_sha256,canonical_facts_sha256:runtime.canonical_facts_sha256,runtime_configuration_sha256:runtimeConfigurationSha256,python_environment_sha256:pythonEnvironments.environment_sha256,qualification_response_public_key_sha256:responsePublicKeyRecord.sha256 };
    } catch (error) {
      lastError = error.message;
      try { process.kill(child.pid, 0); } catch {
        const cleanup = await stopDirectSpawnedRuntime(child.pid,config);
        cleanup.reason = cleanup.stopped ? "runtime_process_group_cleaned_after_supervisor_exit" : cleanup.reason;
        atomicWrite(processRecordPath,{ ...readJson(processRecordPath),startup_cleanup:cleanup });
        throw Object.assign(new Error(`Runtime supervisor exited during startup. See ${logPath}`), { code: "INFRASTRUCTURE_TEMPORARY",cleanup });
      }
      await sleep(config.runtime.runtime_startup_poll_ms);
    }
  }
  let cleanup;
  try {
    // This is the child spawned and initially argv-verified by this invocation.
    // Direct group cleanup avoids leaving it behind if a later argv probe is
    // unavailable while readiness itself has already failed.
    cleanup = await stopDirectSpawnedRuntime(child.pid,config);
  } catch (error) {
    cleanup = { stopped:false,error:error.message,code:error.code || null,completed_at:now() };
  }
  atomicWrite(processRecordPath,{ ...readJson(processRecordPath),startup_cleanup:cleanup });
  throw Object.assign(new Error(`Runtime did not become ready: ${lastError}. See ${logPath}`), { code: "INFRASTRUCTURE_TEMPORARY",cleanup });
}

export async function verifyRuntimeStillBound(config, expectedIdentity, sourceBindingsSha256, expectedCorpusIntegritySha256, expectedCanonicalFactsSha256,expectedPythonEnvironmentSha256,expectedRuntimeConfigurationSha256,expectedRunId,expectedCapabilityKeySha256) {
  const python = verifyPythonEnvironments(config.__project_root,config);
  const runtimeArtifacts = verifyRuntimeArtifactManifests(config.__project_root,config);
  const runRoot = resolve(config.__project_root,config.paths.log_root,"runs",expectedRunId);
  const responsePublicKey = readQualificationResponsePublicKey(runRoot);
  const allowedContexts = allowedContextManifestRecord(allowedContextManifestPath(config.__project_root,expectedRunId));
  const processRecord = readJson(join(runRoot,"runtime-process.json"));
  if (processRecord.qualification_allowed_context_manifest_sha256 !== allowedContexts.sha256 || allowedContexts.manifest.run_id !== expectedRunId) throw Object.assign(new Error("Qualification allowed-context manifest changed after verification."),{ code:"CANDIDATE_IDENTITY_MISMATCH" });
  if (python.environment_sha256 !== expectedPythonEnvironmentSha256 || canonicalHash(config.runtime) !== expectedRuntimeConfigurationSha256) throw Object.assign(new Error("Runtime configuration or Python dependency identity changed after verification."), { code:"CANDIDATE_IDENTITY_MISMATCH" });
  for (const [key,value] of Object.entries(runtimeArtifacts)) if (expectedIdentity?.[key] !== value) throw Object.assign(new Error(`Runtime artifact identity changed after verification: ${key}`),{ code:"CANDIDATE_IDENTITY_MISMATCH" });
  return verifyApp(config,expectedIdentity,sourceBindingsSha256,expectedCorpusIntegritySha256,expectedCanonicalFactsSha256,expectedPythonEnvironmentSha256,expectedRunId,expectedCapabilityKeySha256,responsePublicKey.sha256);
}
