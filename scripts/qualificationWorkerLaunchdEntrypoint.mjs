#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./lib/qualification-worker/utils.mjs";

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

if (realpathSync.native(dirname(configPath)) !== realpathSync.native(resolve(PROJECT_ROOT, "config"))) throw new Error("Launch request config must be inside the project config directory.");
if (realpathSync.native(dirname(requestPath)) !== realpathSync.native(resolve(PROJECT_ROOT, "Log/qualification-worker"))) throw new Error("Launch request must be inside the qualification log directory.");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readState = () => existsSync(statePath) ? readJson(statePath) : null;
const hashState = () => existsSync(statePath) ? createHash("sha256").update(readFileSync(statePath)).digest("hex") : null;
const saveRequest = (request) => atomicWrite(requestPath, request);
const request = readJson(requestPath);
if (request.version !== "qualification-launchd-run-request-v1" || request.mode !== "ONE_FRESH_RUN_THEN_RESUME") throw new Error("Invalid qualification launch request.");

let state = readState();
if (state && TERMINAL_STATES.has(state.state) && state.run_id !== request.prior_run_id) process.exit(0);
if (request.blocked_same_state_sha256 && request.blocked_same_state_sha256 === hashState()) process.exit(0);

const workerArgs = [workerPath, "--config", configPath];
if (state && TERMINAL_STATES.has(state.state) && state.run_id === request.prior_run_id) {
  if (request.fresh_start_consumed === true) process.exit(0);
  request.fresh_start_consumed = true;
  request.fresh_start_consumed_at = new Date().toISOString();
  saveRequest(request);
  workerArgs.push("--new-run");
}

const beforeStateSha256 = hashState();
const freshAttempt = workerArgs.includes("--new-run");
request.last_attempt_started_at = new Date().toISOString();
request.last_attempt_state_sha256 = beforeStateSha256;
request.last_attempt_worker_args = workerArgs.slice(1);
saveRequest(request);

const result = spawnSync(process.execPath, workerArgs, { cwd: PROJECT_ROOT, stdio: "inherit", env: process.env });
state = readState();
const afterStateSha256 = hashState();
request.last_attempt_completed_at = new Date().toISOString();
request.last_attempt_exit_status = result.status;
request.last_attempt_signal = result.signal || null;
request.last_attempt_after_state_sha256 = afterStateSha256;

if (state && TERMINAL_STATES.has(state.state) && (!freshAttempt || state.run_id !== request.prior_run_id)) {
  request.completed_run_id = state.run_id;
  request.completed_state = state.state;
  saveRequest(request);
  process.exit(0);
}
if (beforeStateSha256 === afterStateSha256) {
  request.blocked_same_state_sha256 = afterStateSha256;
  request.blocked_reason = "Worker exited without a state change; automatic relaunch stopped.";
  saveRequest(request);
  process.exit(0);
}
if (result.status === 0) {
  saveRequest(request);
  process.exit(0);
}

saveRequest(request);
process.exit(Number.isInteger(result.status) ? result.status : 1);
