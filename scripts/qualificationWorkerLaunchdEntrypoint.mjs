#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite,canonicalHash } from "./lib/qualification-worker/utils.mjs";
import { chooseLaunchAction,fileSha256,validateLaunchRequest,verifyTerminalWorkerState } from "./lib/qualification-worker/launchdLifecycle.mjs";
import { createDarwinProcessObserver } from "./lib/qualification-worker/stateStore.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const TERMINAL_STATES = new Set(["READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION", "BLOCKED_NOT_QUALIFIED"]);
const argv = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1]) throw new Error(`${flag} is required.`);
  return resolve(argv[index + 1]);
};
const configPath = valueAfter("--config");
const requestPath = valueAfter("--request");
const workerPath = resolve(PROJECT_ROOT, "scripts/qualificationWorker.mjs");
const statePath = resolve(PROJECT_ROOT, "Log/qualification-worker/worker-state.json");
const logRoot = resolve(PROJECT_ROOT,"Log/qualification-worker");

if (realpathSync.native(dirname(configPath)) !== realpathSync.native(resolve(PROJECT_ROOT, "config"))) throw new Error("Launch request config must be inside the project config directory.");
if (realpathSync.native(dirname(requestPath)) !== realpathSync.native(resolve(PROJECT_ROOT, "Log/qualification-worker"))) throw new Error("Launch request must be inside the qualification log directory.");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readState = () => existsSync(statePath) ? readJson(statePath) : null;
const hashState = () => existsSync(statePath) ? fileSha256(statePath) : null;
const saveRequest = (request) => atomicWrite(requestPath, request);
const request = readJson(requestPath);
const requestValidation=validateLaunchRequest(request,{ configSha256:fileSha256(configPath),workerSha256:fileSha256(workerPath) });
if (!requestValidation.passed) throw new Error(`Invalid qualification launch request: ${requestValidation.blockers.join("; ")}`);

const config=readJson(configPath);
const pythonManifest=readJson(resolve(PROJECT_ROOT,config.runtime.python_environment_manifest_path));
const observeProcess=createDarwinProcessObserver({
  pythonExecutable:resolve(PROJECT_ROOT,pythonManifest.environments.retrieval.executable),
  probeScript:resolve(PROJECT_ROOT,"scripts/processArgvDarwin.py"),timeoutMs:config.runtime.argv_probe_timeout_ms,
});
const processAlive=(pid) => { try { process.kill(Number(pid),0); return true; } catch { return false; } };
if (request.active_worker?.pid) {
  const observed=observeProcess(request.active_worker.pid);
  const observedIdentity=observed ? canonicalHash({ pid:Number(observed.pid),executable:observed.executable,argv:observed.argv }) : null;
  if (observedIdentity===request.active_worker.identity_sha256) process.exit(0);
  if (processAlive(request.active_worker.pid)) {
    request.blocked_same_state_sha256=hashState();
    request.blocked_reason="Recorded launchd child PID is live with a different or unobservable executable/argv identity.";
    saveRequest(request);
    process.exit(0);
  }
  request.active_worker=null;
  request.last_worker_reconciled_at=new Date().toISOString();
  saveRequest(request);
}

let state = readState();
const persistTerminalReceipt = () => {
  const receipt=verifyTerminalWorkerState({ projectRoot:PROJECT_ROOT,logRoot,state });
  atomicWrite(resolve(logRoot,"launchd-terminal-receipt.json"),receipt);
  request.completed_run_id=state.run_id;
  request.completed_state=state.state;
  request.completed_terminal_receipt_sha256=fileSha256(resolve(logRoot,"launchd-terminal-receipt.json"));
  request.completed_at=new Date().toISOString();
  saveRequest(request);
  return receipt;
};
const action=chooseLaunchAction({ request,state,stateSha256:hashState() });
if (action==="STOP_BLOCKED_SAME_STATE") process.exit(0);
if (action==="VERIFY_TERMINAL") {
  try { persistTerminalReceipt(); }
  catch (error) {
    request.blocked_same_state_sha256=hashState();
    request.blocked_reason=`Terminal state validation failed: ${error.message}`;
    saveRequest(request);
  }
  process.exit(0);
}

const workerArgs = [workerPath, "--config", configPath];
if (action==="START_NEW_RUN") workerArgs.push("--new-run");

const beforeStateSha256 = hashState();
const freshAttempt = workerArgs.includes("--new-run");
request.last_attempt_started_at = new Date().toISOString();
request.last_attempt_state_sha256 = beforeStateSha256;
request.last_attempt_worker_args = workerArgs.slice(1);
if (freshAttempt) request.fresh_start_dispatched_at=request.last_attempt_started_at;
saveRequest(request);

const result = await new Promise((accept) => {
  const child=spawn(process.execPath,workerArgs,{ cwd:PROJECT_ROOT,stdio:"inherit",env:process.env });
  const argv=[process.execPath,...workerArgs];
  request.active_worker={ pid:child.pid,executable:realpathSync.native(process.execPath),argv,
    identity_sha256:canonicalHash({ pid:Number(child.pid),executable:realpathSync.native(process.execPath),argv }),started_at:new Date().toISOString() };
  saveRequest(request);
  let settled=false;
  const done=(value) => { if (!settled) { settled=true; accept(value); } };
  child.once("error",(error) => done({ status:null,signal:null,error:error.message }));
  child.once("exit",(status,signal) => done({ status,signal:signal || null,error:null }));
});
request.active_worker=null;
state = readState();
const afterStateSha256 = hashState();
request.last_attempt_completed_at = new Date().toISOString();
request.last_attempt_exit_status = result.status;
request.last_attempt_signal = result.signal || null;
request.last_attempt_error = result.error || null;
request.last_attempt_after_state_sha256 = afterStateSha256;
if (freshAttempt && state?.run_id && state.run_id!==request.prior_run_id) {
  request.fresh_start_consumed=true;
  request.fresh_start_consumed_at=new Date().toISOString();
  request.fresh_run_id=state.run_id;
}

if (state && TERMINAL_STATES.has(state.state) && (!freshAttempt || state.run_id!==request.prior_run_id)) {
  try { persistTerminalReceipt(); }
  catch (error) {
    request.blocked_same_state_sha256=afterStateSha256;
    request.blocked_reason=`Worker reported terminal without a valid signed terminal receipt: ${error.message}`;
    saveRequest(request);
  }
  process.exit(0);
}
if (beforeStateSha256 === afterStateSha256) {
  request.blocked_same_state_sha256 = afterStateSha256;
  request.blocked_reason = "Worker exited without a state change; automatic relaunch stopped.";
  saveRequest(request);
  process.exit(0);
}
if (result.status === 0) {
  request.blocked_same_state_sha256=afterStateSha256;
  request.blocked_reason="Worker exited successfully without a validated terminal receipt.";
  saveRequest(request);
  process.exit(0);
}

saveRequest(request);
process.exit(Number.isInteger(result.status) ? result.status : 1);
