#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, TERMINAL_STATES, nextStage } from "./lib/qualification-worker/constants.mjs";
import { classifyFailure, trainingProposal } from "./lib/qualification-worker/failureTriage.mjs";
import { writeStatus } from "./lib/qualification-worker/reporting.mjs";
import { assertPathAllowed } from "./lib/qualification-worker/protectedPaths.mjs";
import { qualificationStaticPreflight,STAGE_HANDLERS, stageArtifactPath } from "./lib/qualification-worker/stageRegistry.mjs";
import { createDarwinProcessObserver, StateStore } from "./lib/qualification-worker/stateStore.mjs";
import { removeQualificationContextKey, stopOwnedRuntime } from "./lib/qualification-worker/runtimeSupervisor.mjs";
import { compareBindings, validateArtifactRecords } from "./lib/qualification-worker/artifactManifest.mjs";
import { validateConfig } from "./lib/qualification-worker/gateValidators.mjs";
import { atomicWrite, canonicalHash, createExclusive, now, readJson, runId, sha256Buffer, sha256File } from "./lib/qualification-worker/utils.mjs";
import { terminateProcessGroup } from "./lib/qualification-worker/childProcessGroup.mjs";
import { hasStickyWorkerInterruption } from "./lib/qualification-worker/resumeIntegrity.mjs";
import { ensureQualificationTerminalSeal } from "./lib/qualification-worker/terminalSeal.mjs";
import { stageGateCommitment,verifyCommittedStageTransitions } from "./lib/qualification-worker/transitionIntegrity.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || fallback;
  const prefixed = argv.find((value) => value.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

const canonicalConfigPath = resolve(PROJECT_ROOT, "config/qualification-worker.json");
const configPath = resolve(PROJECT_ROOT, option("--config", "config/qualification-worker.json"));
if (configPath !== canonicalConfigPath) throw new Error("Only the canonical qualification-worker config is accepted.");
const configBytes = readFileSync(configPath);
const configSha256 = sha256Buffer(configBytes);
const config = JSON.parse(configBytes.toString("utf8"));
const startupConfigGate = validateConfig(config);
if (!startupConfigGate.passed) throw new Error(`Canonical qualification config rejected: ${startupConfigGate.blockers.join("; ")}`);
Object.defineProperty(config, "__project_root", { value:PROJECT_ROOT,enumerable:false });
for (const value of [
  config.paths.log_root, config.paths.live50_bank, config.paths.round52_baseline,
  config.paths.t4_target_ids,config.paths.review_calibration_pack, config.paths.visible_output_parent,
  config.runtime.approved_corpus_manifest_path,
  config.runtime.database_path,
  config.candidate.checkpoint_path, config.candidate.adapter_path, config.candidate.adapter_config_path,
  config.candidate.base_model_path, config.candidate.model_config_path,
  config.candidate.tokenizer_path, config.candidate.tokenizer_config_path,
  ...config.bound_source_paths,
  ...Object.keys(config.qualification_input_sha256 || {}),
]) assertPathAllowed(PROJECT_ROOT, value, config.protected_path_patterns);
const logRoot = resolve(PROJECT_ROOT, config.paths.log_root);
const pythonManifestPath = assertPathAllowed(PROJECT_ROOT,config.runtime.python_environment_manifest_path,config.protected_path_patterns);
if (sha256File(pythonManifestPath) !== config.runtime.python_environment_manifest_sha256) throw new Error("Cannot establish the pinned Python identity needed for worker-lock ownership checks.");
const pythonManifest = readJson(pythonManifestPath);
const lockProcessObserver = createDarwinProcessObserver({
  pythonExecutable:resolve(PROJECT_ROOT,pythonManifest.environments?.retrieval?.executable || "__missing_python__"),
  probeScript:assertPathAllowed(PROJECT_ROOT,"scripts/processArgvDarwin.py",config.protected_path_patterns),
  timeoutMs:config.runtime.argv_probe_timeout_ms,
});
const store = new StateStore(logRoot,{ processObserver:lockProcessObserver });
const planOnly = argv.includes("--plan");
const preflightOnly = argv.includes("--preflight");
const statusOnly = argv.includes("--status");
const newRun = argv.includes("--new-run");

function initialState() {
  const id = runId("post-t4");
  return {
    version: "qualification-worker-state-v1",
    worker_id: config.worker_id,
    run_id: id,
    config_sha256: configSha256,
    state: config.start_state,
    status: "ACTIVE",
    started_at: now(),
    updated_at: now(),
    completed_stages: [],
    stage_results: {},
    active_stage_pid: null,
    active_child_token:null,
    active_child_kind:null,
    active_child_identity:null,
    interruption:null,
    runtime_supervisor_pid: null,
    corpus_integrity_sha256: null,
    canonical_facts_sha256: null,
    runtime_configuration_sha256:null,
    python_environment_sha256:null,
    retries_used: 0,
    repairs_used: 0,
    selected_iteration: config.candidate.selected_iteration,
    candidate_id: null,
    configured_endpoint:config.runtime.canonical_endpoint,
    active_endpoint:null,
    next_authorised_action: config.start_state,
    blocker: null,
    factual_status: "PENDING — no absolute truth claim",
    sealed_unseen_accessed: false,
    permissions: config.permissions,
  };
}

function printPlan() {
  console.log(JSON.stringify({
    worker_id: config.worker_id,
    candidate: config.candidate,
    endpoint: config.runtime.canonical_endpoint,
    stages: Object.keys(STAGE_HANDLERS),
    terminal_states: TERMINAL_STATES,
    quality: config.quality,
    permissions: config.permissions,
    sealed_unseen: "closed",
  }, null, 2));
}

if (planOnly) {
  printPlan();
  process.exit(0);
}
if (preflightOnly) {
  const preflight = qualificationStaticPreflight(PROJECT_ROOT,config);
  console.log(JSON.stringify({ ...preflight,worker_id:config.worker_id,terminal_states:TERMINAL_STATES },null,2));
  process.exit(preflight.passed ? 0 : 2);
}

mkdirSync(logRoot, { recursive: true });
if (statusOnly) {
  const state = store.load(initialState());
  writeStatus(logRoot, state);
  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

store.acquireLock();
try {
let state = store.load(initialState());
if (!/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(state.run_id || ""))) throw new Error("Persisted qualification run_id is invalid.");
let startupEventAuditError = null;
try { store.auditEventChain({ allowAnchorBootstrap:false }); }
catch (error) { startupEventAuditError = error; }
let stopping = false;
let activeChildRegistration = null;
let interruptionSignal = null;
let interruptionStagePid = null;
let interruptionChildToken = null;
let interruptionCleanupPromise = null;

function save() {
  store.save(state);
  writeStatus(logRoot, state);
}

const stop = (signal) => {
  const requestedAt = now();
  const prior = state.interruption || {};
  const count = Number(prior.signal_count || 0) + 1;
  const interruptionRunRoot = resolve(logRoot,"runs",String(state.run_id || "invalid-run"));
  const failureRoot = join(interruptionRunRoot,"failure-triage");
  mkdirSync(failureRoot,{ recursive:true });
  state.interruption = {
    status:"REQUESTED",
    signal:prior.signal || signal,
    observed_signals:[...new Set([...(prior.observed_signals || []),signal])],
    requested_at:prior.requested_at || requestedAt,
    last_signal_at:requestedAt,
    signal_count:count,
    active_stage_pid:activeChildRegistration?.pid || state.active_stage_pid || null,
    active_child_token:activeChildRegistration?.token || state.active_child_token || null,
    active_child_identity:activeChildRegistration || state.active_child_identity || null,
  };
  state.status = "INTERRUPTING";
  state.blocker = `received ${state.interruption.signal}; bounded stage process-group cleanup is running`;
  const intentPath = prior.intent_report || join(failureRoot,`WORKER_INTERRUPTION-INTENT-${Date.now()}.json`);
  state.interruption.intent_report = intentPath;
  if (!existsSync(intentPath)) createExclusive(intentPath,{ version:"qualification-worker-interruption-intent-v1",run_id:state.run_id,...state.interruption,sealed_unseen_accessed:false });
  save();
  store.event(count === 1 ? "worker_interruption_requested" : "worker_interruption_signal_repeated",{ run_id:state.run_id,signal,count,intent_report:intentPath });
  if (stopping) return;
  stopping = true;
  interruptionSignal = state.interruption.signal;
  const currentChild = activeChildRegistration;
  interruptionStagePid = currentChild?.pid || null;
  interruptionChildToken = currentChild?.token || null;
  interruptionCleanupPromise = interruptionStagePid
    ? terminateProcessGroup(interruptionStagePid,{
        reason:"WORKER_INTERRUPTION",terminationGraceMs:config.runtime.stage_child_termination_grace_ms,
        killSettleMs:config.runtime.stage_child_kill_settle_ms,pollMs:Math.min(100,config.runtime.stage_child_kill_settle_ms),
      })
    : Promise.resolve({ stopped:true,reason:"WORKER_INTERRUPTION",detail:"no_child_spawned_by_this_worker_process",pid:null,completed_at:now() });
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

if (newRun && !startupEventAuditError) {
  if (!TERMINAL_STATES.includes(state.state)) throw new Error("--new-run is accepted only after the prior run reached a terminal state.");
  if (!/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(state.run_id || ""))) throw new Error("Prior qualification run_id is invalid.");
  const priorRunRoot = resolve(logRoot,"runs",state.run_id);
  mkdirSync(priorRunRoot,{ recursive:true });
  const finalStatePath = join(priorRunRoot,"worker-state-final.json");
  if (!existsSync(finalStatePath)) createExclusive(finalStatePath,state);
  const priorRunId = state.run_id;
  const priorRuntimeJsonPaths = [
    join(priorRunRoot,"runtime-process.json"),join(priorRunRoot,"runtime-identity.json"),
    join(priorRunRoot,"runtime-startup-cleanup.json"),join(priorRunRoot,"runtime-stop.json"),
  ];
  const priorRuntimeArtifactPaths = [...priorRuntimeJsonPaths,join(priorRunRoot,"runtime.log"),join(priorRunRoot,"corpus-integrity.json")];
  const priorRuntimePids = [state.runtime_supervisor_pid];
  let runtimeRecordError = null;
  for (const path of priorRuntimeJsonPaths) {
    if (!existsSync(path)) continue;
    try {
      const value = readJson(path);
      if (value.run_id && value.run_id !== priorRunId) throw new Error(`run_id ${value.run_id} does not match ${priorRunId}`);
      priorRuntimePids.push(value.pid || value.supervisor_pid || value.cleanup?.pid || null);
    } catch (error) { runtimeRecordError = `Cannot read persisted runtime identity ${path}: ${error.message}`; }
  }
  const resolvedPids = [...new Set(priorRuntimePids.filter((pid) => Number.isInteger(Number(pid)) && Number(pid) > 0).map(Number))];
  const priorRuntimeExpected = priorRuntimeArtifactPaths.some(existsSync) || Boolean(state.runtime_supervisor_pid) || (state.completed_stages || []).includes("VERIFY_RUNTIME");
  let runtimeStop;
  if (runtimeRecordError || resolvedPids.length > 1) {
    runtimeStop = { stopped:false,reason:"prior_runtime_identity_invalid",error:runtimeRecordError || `Conflicting prior runtime PIDs: ${resolvedPids.join(", ")}` };
  } else if (resolvedPids.length === 1) {
    try { runtimeStop = await stopOwnedRuntime({ projectRoot:PROJECT_ROOT,runRoot:priorRunRoot,expectedPid:resolvedPids[0],expectedRunId:priorRunId,config }); }
    catch (error) { runtimeStop = { stopped:false,reason:error.code || "RUNTIME_CLEANUP_ERROR",error:error.message,pid:resolvedPids[0] }; }
  } else if (priorRuntimeExpected) {
    runtimeStop = { stopped:false,reason:"prior_runtime_identity_has_no_pid" };
  } else {
    runtimeStop = { stopped:true,reason:"no_runtime_was_started" };
  }
  if (runtimeStop.stopped) {
    const keyCleanup = removeQualificationContextKey(priorRunRoot);
    runtimeStop = { ...runtimeStop,qualification_context_key_cleanup:keyCleanup,stopped:keyCleanup.removed === true };
  }
  if (!runtimeStop.stopped) {
    const cleanupReportPath = join(priorRunRoot,"failure-triage",`new-run-runtime-cleanup-blocked-${Date.now()}.json`);
    createExclusive(cleanupReportPath,{ version:"qualification-new-run-cleanup-v1",prior_run_id:priorRunId,detected_at:now(),runtime_cleanup:runtimeStop,new_run_created:false,sealed_unseen_accessed:false });
    store.event("new_run_blocked_by_runtime_cleanup",{ prior_run_id:priorRunId,report:cleanupReportPath,runtime_cleanup:runtimeStop });
    throw Object.assign(new Error(`Cannot create a new run until prior runtime cleanup is positively complete: ${runtimeStop.error || runtimeStop.reason}`),{ code:"RUNTIME_CLEANUP_INCOMPLETE" });
  }
  if (!stopping) {
    state = initialState();
    store.save(state);
    store.event("new_run_created",{ prior_run_id:priorRunId,run_id:state.run_id,reason:"explicit_terminal_restart",prior_runtime_stop:runtimeStop });
  }
}
if (!/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(state.run_id || ""))) throw new Error("Persisted qualification run_id is invalid.");
const runsRoot = resolve(logRoot, "runs");
const runRoot = resolve(runsRoot, state.run_id);
const runRelative = relative(runsRoot, runRoot);
if (!runRelative || runRelative.startsWith("..") || resolve(runsRoot, runRelative) !== runRoot) throw new Error("Qualification run directory leaves the configured runs root.");
assertPathAllowed(PROJECT_ROOT, relative(PROJECT_ROOT, runRoot), config.protected_path_patterns);
for (const path of [runRoot, join(runRoot, "stage-manifests"), join(runRoot, "development-results"), join(runRoot, "visible-qualification-results"), join(runRoot, "repair-diffs"), join(runRoot, "failure-triage"), join(runRoot, "reports")]) mkdirSync(path, { recursive: true });

const configChangedAfterRead = sha256File(configPath) !== configSha256;
const resumeConfigMismatch = state.config_sha256 !== configSha256 || configChangedAfterRead
  ? Object.assign(new Error("Qualification config changed after this run was created; refusing resume."),{ code:"QUALIFICATION_CONFIG_IDENTITY_MISMATCH" })
  : null;

function terminalSealPath() {
  return join(runRoot,"candidate-freeze","TERMINAL-SEAL.json");
}

function ensureTerminalSeal(allowCreate) {
  verifyCommittedTransitions();
  return ensureQualificationTerminalSeal({
    runRoot,runId:state.run_id,stages:STAGES,stagePath:(stage) => stageArtifactPath(runRoot,stage),
    eventAudit:store.auditEventChain({ allowAnchorBootstrap:false }),allowCreate,
    integritySigner:(payload) => store.signIntegrity(payload),
    integrityVerifier:(payload,signature) => store.verifyIntegrity(payload,signature),
  }).seal;
}

function verifyCommittedTransitions() {
  return verifyCommittedStageTransitions({
    projectRoot:PROJECT_ROOT,runId:state.run_id,completedStages:state.completed_stages,
    stagePath:(stage) => stageArtifactPath(runRoot,stage),
    eventAudit:store.auditEventChain({ allowAnchorBootstrap:false }),
  });
}

function reconstructFromGateChain() {
  const failureDir = join(runRoot,"failure-triage");
  const failureReports = existsSync(failureDir) ? readdirSync(failureDir) : [];
  if (hasStickyWorkerInterruption(state,failureReports)) {
    throw Object.assign(new Error("A persisted worker interruption remains terminal until an explicit --new-run."),{ code:"PERSISTED_WORKER_INTERRUPTION" });
  }
  const baseline = existsSync(join(runRoot, "source-baseline.json")) ? readJson(join(runRoot, "source-baseline.json")) : null;
  const runtime = existsSync(join(runRoot, "runtime-identity.json")) ? readJson(join(runRoot, "runtime-identity.json")) : null;
  const corpus = existsSync(join(runRoot, "corpus-integrity.json")) ? readJson(join(runRoot, "corpus-integrity.json")) : null;
  const completed = [];
  const existingGatePaths = STAGES.map((stage) => stageArtifactPath(runRoot, stage)).filter(existsSync);
  const preRuntimeFailure = existingGatePaths.length === 1 && readJson(existingGatePaths[0]).stage === "VERIFY_RUNTIME" && readJson(existingGatePaths[0]).passed === false;
  if (existingGatePaths.length && !preRuntimeFailure) {
    if (!baseline || !runtime || !corpus) throw new Error("A persisted gate chain requires immutable source, runtime, and indexed-corpus identities.");
    const changed = compareBindings(PROJECT_ROOT, baseline.bindings || {});
    if (changed.length) throw new Error(`Persisted source baseline no longer matches the project: ${changed[0].path}`);
    if (runtime.endpoint !== config.runtime.canonical_endpoint || runtime.expected_identity?.adapter_sha256 !== config.candidate.adapter_sha256 ||
        runtime.expected_identity?.base_sha256 !== config.candidate.base_sha256 || !String(runtime.expected_identity?.id || "").endsWith(`-step${config.candidate.selected_iteration}`) ||
        runtime.expected_identity?.adapter_sha256 === config.candidate.forbidden_adapter_sha256 || !/^[0-9a-f]{64}$/.test(String(runtime.corpus_integrity_sha256 || "")) ||
        runtime.runtime_configuration_sha256 !== canonicalHash(config.runtime) || !/^[0-9a-f]{64}$/.test(String(runtime.python_environment_sha256 || "")) ||
        !/^[0-9a-f]{64}$/.test(String(runtime.qualification_response_public_key_sha256 || "")) ||
        runtime.expected_identity?.runtime_configuration_sha256 !== runtime.runtime_configuration_sha256 || runtime.expected_identity?.python_environment_sha256 !== runtime.python_environment_sha256) {
      throw new Error("Persisted runtime identity does not match the canonical candidate and endpoint.");
    }
  }
  if (baseline && runtime && runtime.source_bindings_sha256 !== canonicalHash(baseline.bindings)) throw new Error("Runtime identity is not bound to the immutable source baseline.");
  if (runtime && (!corpus || runtime.corpus_integrity_sha256 !== corpus.corpus_integrity_sha256 || corpus.source_bindings_sha256 !== runtime.source_bindings_sha256)) throw new Error("Runtime identity is not bound to the immutable indexed-corpus snapshot.");
  if (runtime && (!/^[0-9a-f]{64}$/.test(String(runtime.canonical_facts_sha256 || "")) || runtime.canonical_facts_sha256 !== corpus?.canonical_facts_sha256)) throw new Error("Runtime identity is not bound to the canonical personal-fact snapshot.");
  if (runtime && (runtime.runtime_configuration_sha256 !== corpus?.runtime_configuration_sha256 || runtime.python_environment_sha256 !== corpus?.python_environment_sha256)) throw new Error("Runtime identity is not bound to the configuration and Python environment snapshot.");
  if (runtime && runtime.qualification_response_public_key_sha256 !== corpus?.qualification_response_public_key_sha256) throw new Error("Runtime identity is not bound to the response-signing public key.");
  let predecessor = null;
  let failed = null;
  let gap = false;
  for (const stage of STAGES) {
    const path = stageArtifactPath(runRoot, stage);
    if (!existsSync(path)) { gap = true; continue; }
    if (gap) throw new Error(`Gate chain has a gap before ${stage}.`);
    const gate = readJson(path);
    if (gate.version !== "qualification-stage-gate-v1" || gate.stage !== stage || gate.inputs?.config_sha256 !== configSha256 || typeof gate.passed !== "boolean" || gate.sealed_unseen_accessed !== false) throw new Error(`Gate identity or schema mismatch at ${stage}.`);
    if (gate.passed === true && (!Array.isArray(gate.artifacts) || gate.artifacts.length === 0)) throw new Error(`Passing gate has no immutable evidence artifacts at ${stage}.`);
    if (baseline && gate.inputs?.source_bindings_sha256 !== canonicalHash(baseline.bindings)) throw new Error(`Source binding mismatch at ${stage}.`);
    if (runtime && gate.inputs?.corpus_integrity_sha256 !== runtime.corpus_integrity_sha256) throw new Error(`Indexed-corpus binding mismatch at ${stage}.`);
    if (runtime && gate.inputs?.canonical_facts_sha256 !== runtime.canonical_facts_sha256) throw new Error(`Canonical personal-fact binding mismatch at ${stage}.`);
    if (runtime && gate.inputs?.runtime_configuration_sha256 !== runtime.runtime_configuration_sha256) throw new Error(`Runtime-configuration binding mismatch at ${stage}.`);
    if (runtime && gate.inputs?.python_environment_sha256 !== runtime.python_environment_sha256) throw new Error(`Python-environment binding mismatch at ${stage}.`);
    if (runtime && gate.inputs?.candidate_identity_sha256 !== canonicalHash(runtime.expected_identity)) throw new Error(`Candidate binding mismatch at ${stage}.`);
    if (gate.artifacts_sha256 !== canonicalHash(gate.artifacts || [])) throw new Error(`Artifact manifest digest mismatch at ${stage}.`);
    const artifactFailures = validateArtifactRecords(PROJECT_ROOT, gate.artifacts || []);
    if (artifactFailures.length) throw new Error(`Evidence artifact changed after ${stage}: ${artifactFailures[0].path}`);
    if (predecessor) {
      if (gate.inputs?.predecessor?.stage !== predecessor.stage || gate.inputs?.predecessor?.sha256 !== sha256File(predecessor.path)) {
        throw new Error(`Gate predecessor hash mismatch at ${stage}.`);
      }
    } else if (gate.inputs?.predecessor !== null) throw new Error("VERIFY_RUNTIME has an unexpected predecessor.");
    if (gate.passed !== true) { failed = gate; break; }
    completed.push(stage);
    predecessor = { stage, path };
  }
  state.completed_stages = completed;
  verifyCommittedTransitions();
  if (failed) {
    state.state = "BLOCKED_NOT_QUALIFIED";
    state.status = "BLOCKED";
    state.blocker = failed.blockers?.join("; ") || `${failed.stage} failed`;
    return;
  }
  if (completed.length === STAGES.length) {
    const freezeGate = readJson(stageArtifactPath(runRoot, "CANDIDATE_FREEZE"));
    if (!(freezeGate.artifacts || []).some((record) => /candidate-freeze\//.test(record.path || ""))) throw new Error("Completed gate chain lacks frozen-candidate artifacts.");
    ensureTerminalSeal(false);
    state.state = "READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION";
    state.status = "COMPLETE";
    return;
  }
  state.state = completed.length ? nextStage(completed.at(-1)) : config.start_state;
  if (completed.includes("VERIFY_RUNTIME")) {
    if (!runtime || !baseline) throw new Error("Verified gate chain is missing immutable runtime/source identities.");
    state.expected_runtime_identity = runtime.expected_identity;
    state.runtime_supervisor_pid = runtime.supervisor_pid;
    state.source_bindings = baseline.bindings;
    state.corpus_integrity_sha256 = runtime.corpus_integrity_sha256;
    state.canonical_facts_sha256 = runtime.canonical_facts_sha256;
    state.runtime_configuration_sha256 = runtime.runtime_configuration_sha256;
    state.python_environment_sha256 = runtime.python_environment_sha256;
    state.candidate_id = runtime.expected_identity.id;
    state.active_endpoint = runtime.endpoint;
  }
}

async function recoverPersistedActiveChild() {
  const pid = Number(state.active_stage_pid || state.active_child_identity?.pid || 0);
  if (!pid) return null;
  const expected = state.active_child_identity;
  let cleanup;
  if (!expected || expected.pid !== pid || !expected.executable || !Array.isArray(expected.argv) ||
      expected.identity_sha256 !== canonicalHash({ pid,executable:expected.executable,argv:expected.argv })) {
    cleanup = { stopped:false,reason:"persisted_stage_child_identity_incomplete",pid };
  } else {
    const observed = lockProcessObserver(pid);
    if (!observed) {
      try { process.kill(pid,0); cleanup = { stopped:false,reason:"live_persisted_stage_child_cannot_be_observed_exactly",pid }; }
      catch { cleanup = { stopped:true,reason:"persisted_stage_child_already_absent",pid,completed_at:now() }; }
    } else if (canonicalHash({ pid:Number(observed.pid),executable:observed.executable,argv:observed.argv }) !== expected.identity_sha256) {
      cleanup = { stopped:false,reason:"persisted_stage_child_identity_mismatch",pid };
    } else {
      cleanup = await terminateProcessGroup(pid,{
        reason:"PERSISTED_STAGE_CHILD_RECOVERY",terminationGraceMs:config.runtime.stage_child_termination_grace_ms,
        killSettleMs:config.runtime.stage_child_kill_settle_ms,pollMs:Math.min(100,config.runtime.stage_child_kill_settle_ms),
      });
    }
  }
  if (cleanup.stopped) {
    state.active_stage_pid = null;
    state.active_child_token = null;
    state.active_child_kind = null;
    state.active_child_identity = null;
  }
  const reportPath = join(runRoot,"failure-triage",`PERSISTED_STAGE_CHILD_RECOVERY-${Date.now()}.json`);
  createExclusive(reportPath,{ version:"qualification-persisted-stage-child-recovery-v1",run_id:state.run_id,expected_identity:expected || null,cleanup,completed_at:now(),sealed_unseen_accessed:false });
  save();
  store.event("persisted_stage_child_recovery",{ run_id:state.run_id,report:reportPath,cleanup });
  return Object.assign(new Error(`A persisted active stage child required recovery (${cleanup.reason || cleanup.detail}); this run cannot resume.`),{ code:"PERSISTED_STAGE_CHILD_RECOVERY" });
}

let reconstructionError = startupEventAuditError || resumeConfigMismatch;
if (!reconstructionError) reconstructionError = await recoverPersistedActiveChild();
if (!reconstructionError) {
  try { reconstructFromGateChain(); }
  catch (error) { reconstructionError = error; }
}

if (!reconstructionError && state.state === "BLOCKED_NOT_QUALIFIED" && state.reconstructed_failure_runtime_cleanup?.stopped !== true) {
  const reconstructedCleanup = await persistTerminalRuntimeCleanup("RECONSTRUCTED_FAILED_GATE");
  state.reconstructed_failure_runtime_cleanup = { ...reconstructedCleanup.cleanup,report:reconstructedCleanup.path };
  if (!reconstructedCleanup.cleanup.stopped) {
    state.blocker = `${state.blocker || "Persisted stage gate failed"}; owned runtime cleanup did not complete after reconstruction`;
    state.next_authorised_action = "Review failed-gate and runtime-cleanup evidence; do not open unseen";
  }
  save();
}

async function blockOnResumeIntegrity(error) {
  const terminalCleanup = await persistTerminalRuntimeCleanup("RESUME_INTEGRITY_ERROR");
  const runtimeCleanup = terminalCleanup.cleanup;
  if (runtimeCleanup.stopped) {
    state.runtime_supervisor_pid = null;
    state.active_endpoint = null;
  }
  state.completed_stages = [];
  state.state = "BLOCKED_NOT_QUALIFIED";
  state.status = "BLOCKED";
  state.completed_at = now();
  state.blocker = `RESUME_INTEGRITY_ERROR; ${error.message}${runtimeCleanup.stopped ? "" : `; runtime cleanup failed: ${runtimeCleanup.error || runtimeCleanup.reason}`}`;
  state.next_authorised_action = "Review the immutable gate chain and runtime-cleanup evidence; do not open unseen";
  state.factual_status = "NOT FACTUALLY CLEARED";
  const report = {
    version:"qualification-resume-integrity-failure-v1",
    run_id:state.run_id,
    detected_at:now(),
    error:{ code:error.code || "RESUME_INTEGRITY_ERROR",message:error.message },
    runtime_cleanup:runtimeCleanup,
    sealed_unseen_accessed:false,
  };
  const reportPath = join(runRoot,"failure-triage",`RESUME_INTEGRITY_ERROR-${Date.now()}.json`);
  createExclusive(reportPath,report);
  try { store.event("resume_integrity_blocked",{ run_id:state.run_id,report:reportPath,runtime_cleanup:runtimeCleanup }); }
  catch (eventError) { report.event_chain_append_error = eventError.message; }
  save();
}

async function cleanupOwnedRuntimeForTerminal() {
  const processPath = join(runRoot,"runtime-process.json");
  const stopPath = join(runRoot,"runtime-stop.json");
  let processRecord = null;
  let priorStop = null;
  try { processRecord = existsSync(processPath) ? readJson(processPath) : null; }
  catch (error) { return { stopped:false,reason:"runtime_process_record_unreadable",error:error.message }; }
  try { priorStop = existsSync(stopPath) ? readJson(stopPath) : null; }
  catch (error) { return { stopped:false,reason:"runtime_stop_record_unreadable",error:error.message }; }
  if (priorStop?.stopped === true && priorStop.run_id === state.run_id && (!processRecord?.pid || priorStop.pid === processRecord.pid)) {
    return { ...priorStop,reason:"owned_runtime_already_stopped" };
  }
  const pid = state.runtime_supervisor_pid || processRecord?.pid || null;
  if (!pid) {
    const runtimeWasExpected = Boolean(processRecord || (state.completed_stages || []).includes("VERIFY_RUNTIME"));
    return runtimeWasExpected ? { stopped:false,reason:"runtime_identity_has_no_pid" } : { stopped:true,reason:"no_runtime_was_started" };
  }
  try {
    return await stopOwnedRuntime({ projectRoot:PROJECT_ROOT,runRoot,expectedPid:pid,expectedRunId:state.run_id,config });
  } catch (error) {
    return { stopped:false,reason:error.code || "RUNTIME_CLEANUP_ERROR",error:error.message,pid:Number(pid),completed_at:now() };
  }
}

async function persistTerminalRuntimeCleanup(reason) {
  let cleanup = await cleanupOwnedRuntimeForTerminal();
  if (cleanup.stopped) {
    const keyCleanup = removeQualificationContextKey(runRoot);
    cleanup = { ...cleanup,qualification_context_key_cleanup:keyCleanup,stopped:keyCleanup.removed === true };
  }
  if (cleanup.stopped) {
    state.runtime_supervisor_pid = null;
    state.active_endpoint = null;
  }
  const path = join(runRoot,"failure-triage",`terminal-runtime-cleanup-${Date.now()}.json`);
  createExclusive(path,{
    version:"qualification-terminal-runtime-cleanup-v1",run_id:state.run_id,reason,completed_at:now(),
    runtime_cleanup:cleanup,sealed_unseen_accessed:false,
  });
  let eventChainAppendError = null;
  try { store.event("terminal_runtime_cleanup",{ run_id:state.run_id,reason,report:path,runtime_cleanup:cleanup }); }
  catch (error) { eventChainAppendError = error.message; }
  return { cleanup,path,event_chain_append_error:eventChainAppendError };
}

async function runCurrentStage() {
  const stage = state.state;
  const handler = STAGE_HANDLERS[stage];
  if (!handler) throw new Error(`No handler for state ${stage}`);
  try { verifyCommittedTransitions(); }
  catch (error) {
    await blockOnResumeIntegrity(error);
    return null;
  }
  state.status = "RUNNING_STAGE";
  state.stage_started_at = now();
  state.blocker = null;
  state.next_authorised_action = stage;
  save();
  store.event("stage_started", { run_id: state.run_id, stage });

  const context = {
    projectRoot: PROJECT_ROOT,
    config,
    configPath,
    logRoot,
    runRoot,
    state,
    onChildSpawn(details) {
      if (stopping) throw Object.assign(new Error("Worker interruption rejected stage-child registration."),{ code:"WORKER_INTERRUPTED" });
      if (activeChildRegistration) throw Object.assign(new Error("A second stage child cannot be registered while another is active."),{ code:"ACTIVE_CHILD_CONFLICT" });
      const registration = { ...details,token:randomUUID(),registered_at:now() };
      registration.identity_sha256 = canonicalHash({ pid:Number(registration.pid),executable:registration.executable,argv:registration.argv });
      activeChildRegistration = registration;
      state.active_stage_pid = registration.pid;
      state.active_child_token = registration.token;
      state.active_child_kind = registration.kind;
      state.active_child_identity = registration;
      save();
      store.event("child_started", { run_id:state.run_id,stage,...registration });
      return registration.token;
    },
    onChildSettled(details) {
      if (!activeChildRegistration || activeChildRegistration.pid !== details.pid || activeChildRegistration.token !== details.registration_token ||
          state.active_stage_pid !== details.pid || state.active_child_token !== details.registration_token) {
        store.event("child_settlement_identity_mismatch",{ run_id:state.run_id,stage,pid:details.pid,registration_token:details.registration_token });
        return;
      }
      const groupCleanupIncomplete = details.result?.termination && details.result.termination.stopped !== true;
      if (!groupCleanupIncomplete) {
        activeChildRegistration = null;
        state.active_stage_pid = null;
        state.active_child_token = null;
        state.active_child_kind = null;
        state.active_child_identity = null;
      }
      save();
      store.event("child_settled",{ run_id:state.run_id,stage,pid:details.pid,registration_token:details.registration_token,group_cleanup_incomplete:Boolean(groupCleanupIncomplete) });
    },
    shouldStop() { return stopping; },
    onRuntimeSpawn(pid) {
      if (stopping) throw Object.assign(new Error("Worker interruption rejected runtime registration."),{ code:"WORKER_INTERRUPTED" });
      state.runtime_supervisor_pid = pid;
      save();
      store.event("runtime_supervisor_started", { run_id:state.run_id,stage, pid });
    },
    onSourceBaseline(bindings) {
      state.source_bindings = bindings;
      save();
      store.event("source_baseline_persisted", { run_id:state.run_id,stage,source_bindings_sha256:canonicalHash(bindings) });
    },
  };
  let gate;
  try {
    gate = await handler(context);
  } catch (error) {
    gate = {
      version: "qualification-stage-gate-v1",
      stage,
      completed_at: now(),
      passed: false,
      blockers: [error.code || "UNCAUGHT_STAGE_ERROR", error.message],
      artifacts: [],
      artifacts_sha256: canonicalHash([]),
      sealed_unseen_accessed: false,
    };
    const stagePath = stageArtifactPath(runRoot, stage);
    if (!existsSync(stagePath)) {
      const predecessor = state.completed_stages.at(-1);
      gate.inputs = {
        config_sha256: configSha256,
        source_bindings_sha256: canonicalHash(state.source_bindings || {}),
        corpus_integrity_sha256:state.corpus_integrity_sha256 || null,
        canonical_facts_sha256:state.canonical_facts_sha256 || null,
        runtime_configuration_sha256:state.runtime_configuration_sha256 || null,
        python_environment_sha256:state.python_environment_sha256 || null,
        candidate_identity_sha256: canonicalHash(state.expected_runtime_identity || {}),
        predecessor: predecessor ? { stage: predecessor, path: stageArtifactPath(runRoot, predecessor), sha256: sha256File(stageArtifactPath(runRoot, predecessor)) } : null,
      };
      createExclusive(stagePath, gate);
    } else {
      atomicWrite(join(runRoot, "failure-triage", `${stage}-uncaught-${Date.now()}.json`), gate);
    }
  } finally {
    if (!activeChildRegistration) {
      state.active_stage_pid = null;
      state.active_child_token = null;
      state.active_child_kind = null;
      state.active_child_identity = null;
    }
  }
  try {
    // The child is untrusted. Revalidate every previously signed transition
    // after it exits and before accepting or signing any new gate.
    verifyCommittedTransitions();
  } catch (error) {
    await blockOnResumeIntegrity(error);
    return gate;
  }
  state.stage_results[stage] = gate;
  if (stage === "RELIABILITY_GATE" && gate.counts) state.retries_used = Number(gate.counts.retries_used || 0);
  if (stage === "VERIFY_RUNTIME" && gate.passed) state.candidate_id = state.expected_runtime_identity?.id || null;
  if (gate.passed) {
    try {
      const commitment = stageGateCommitment({ projectRoot:PROJECT_ROOT,runId:state.run_id,stage,gatePath:stageArtifactPath(runRoot,stage) });
      store.event("stage_passed",commitment);
      if (!state.completed_stages.includes(stage)) state.completed_stages.push(stage);
      verifyCommittedTransitions();
    } catch (error) {
      await blockOnResumeIntegrity(error);
      return gate;
    }
    const next = nextStage(stage);
    if (!next) {
      const terminalSeal = ensureTerminalSeal(true);
      store.event("terminal_sealed",{ run_id:state.run_id,terminal_seal:terminalSealPath(),terminal_seal_sha256:sha256File(terminalSealPath()),event_chain_root:terminalSeal.event_chain_root });
      state.state = "READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION";
      state.status = "COMPLETE";
      state.completed_at = now();
      state.next_authorised_action = "Separate owner authorisation is required before one sealed unseen run";
      state.factual_status = "FACT_CHECKED_AGAINST_PINNED_EVIDENCE — no absolute truth claim";
      store.event("terminal_ready", { run_id: state.run_id, state: state.state });
    } else {
      state.state = next;
      state.status = "ACTIVE";
      state.next_authorised_action = next;
      if (["LIVE50_FULL_REGRESSION", "VISIBLE_CRITICAL4", "VISIBLE_FULL69", "VISIBLE_TOPIC161_REPLACEMENT_V2", "VISIBLE_FROZEN13"].includes(stage)) {
        state.factual_status = "PASSED STAGES FACT-CHECKED AGAINST PINNED EVIDENCE — no absolute truth claim";
      }
    }
  } else {
    const terminalRuntime = await persistTerminalRuntimeCleanup(`${stage}_FAILED`);
    const reportedClass = (gate.confirmed_failure_classes || []).find((value) => /^MODEL_/.test(value)) || gate.confirmed_failure_classes?.[0] || gate.failure_classes?.[0] || gate.blockers?.[0];
    const triage = classifyFailure({ code:reportedClass,detail:gate,evidence_reached_model:/^MODEL_/.test(String(reportedClass || "")) });
    state.state = "BLOCKED_NOT_QUALIFIED";
    state.status = "BLOCKED";
    state.completed_at = now();
    state.blocker = `${gate.blockers?.join("; ") || `${stage} failed`}${terminalRuntime.cleanup.stopped ? "" : "; owned runtime cleanup did not complete"}`;
    state.next_authorised_action = gate.next_owner_action || (triage.training_candidate_eligible ? "Owner review of NEXT-TRAINING-PROPOSAL.json" : "Review failure triage and repair evidence; do not open unseen");
    state.factual_status = "NOT FACTUALLY CLEARED";
    atomicWrite(join(runRoot, "failure-triage", `${stage}.json`), { stage, gate, triage,terminal_runtime_cleanup:terminalRuntime, generated_at: now() });
    if (triage.training_candidate_eligible) atomicWrite(join(runRoot, "NEXT-TRAINING-PROPOSAL.json"), trainingProposal([{ ...triage, case_id: null }], config.candidate));
    store.event("terminal_blocked", { run_id: state.run_id, stage, blocker: state.blocker, triage });
  }
  save();
  return gate;
}

if (reconstructionError) {
  await blockOnResumeIntegrity(reconstructionError);
} else {
  save();
  while (!stopping && !TERMINAL_STATES.includes(state.state)) {
    await runCurrentStage();
  }
}
if (interruptionCleanupPromise) {
  const interruptionCleanup = await interruptionCleanupPromise;
  const sameRegisteredChild = activeChildRegistration?.pid === interruptionStagePid && activeChildRegistration?.token === interruptionChildToken;
  if (interruptionCleanup.stopped && sameRegisteredChild) activeChildRegistration = null;
  state.active_stage_pid = interruptionCleanup.stopped ? null : interruptionStagePid;
  state.active_child_token = interruptionCleanup.stopped ? null : interruptionChildToken;
  state.active_child_kind = interruptionCleanup.stopped ? null : activeChildRegistration?.kind || state.active_child_kind;
  state.active_child_identity = interruptionCleanup.stopped ? null : activeChildRegistration || state.active_child_identity;
  const terminalRuntime = await persistTerminalRuntimeCleanup("WORKER_INTERRUPTION");
  state.state = "BLOCKED_NOT_QUALIFIED";
  state.status = "BLOCKED";
  state.completed_at = now();
  state.blocker = `received ${interruptionSignal}; stage process-group cleanup ${interruptionCleanup.stopped ? "completed" : "did not complete"}; runtime cleanup ${terminalRuntime.cleanup.stopped ? "completed" : "did not complete"}`;
  state.next_authorised_action = "Review interruption and cleanup evidence; start a fresh run only after cleanup is positively complete";
  state.factual_status = "NOT FACTUALLY CLEARED";
  const interruptionReportPath = join(runRoot,"failure-triage",`WORKER_INTERRUPTION-${Date.now()}.json`);
  createExclusive(interruptionReportPath,{ version:"qualification-worker-interruption-v1",run_id:state.run_id,signal:interruptionSignal,recorded_stage_pid:interruptionStagePid,cleanup:interruptionCleanup,runtime_cleanup:terminalRuntime,completed_at:now(),sealed_unseen_accessed:false });
  state.interruption = { ...(state.interruption || {}),status:"COMPLETED",completed_at:now(),completion_report:interruptionReportPath,stage_cleanup:interruptionCleanup,runtime_cleanup:terminalRuntime.cleanup };
  store.event("worker_interruption_completed",{ run_id:state.run_id,report:interruptionReportPath,cleanup:interruptionCleanup });
  save();
}
console.log(JSON.stringify({ run_id: state.run_id, state: state.state, status_file: join(logRoot, "STATUS.md"), sealed_unseen_accessed: false }, null, 2));
} finally {
  store.releaseLock();
}
