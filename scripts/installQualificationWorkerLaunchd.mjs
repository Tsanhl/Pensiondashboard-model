#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync,spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./lib/qualification-worker/utils.mjs";
import { fileSha256 } from "./lib/qualification-worker/launchdLifecycle.mjs";
import { safeHostEnvironment } from "./lib/qualification-worker/processEnvironment.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const label = "com.hltsang.pensions-qualification-worker";
const plist = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const logRoot = resolve(PROJECT_ROOT, "Log/qualification-worker");
const requestPath = resolve(logRoot, "launchd-run-request.json");
const configPath = resolve(PROJECT_ROOT,"config/qualification-worker.json");
const workerPath = resolve(PROJECT_ROOT,"scripts/qualificationWorker.mjs");
const entrypointPath = resolve(PROJECT_ROOT,"scripts/qualificationWorkerLaunchdEntrypoint.mjs");
const newRunRequested = process.argv.slice(2).includes("--new-run");
mkdirSync(dirname(plist), { recursive: true });
mkdirSync(logRoot, { recursive: true });
const statePath = resolve(logRoot, "worker-state.json");
const priorState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;

const preflight=spawnSync(process.execPath,[workerPath,"--config",configPath,"--preflight"],{
  cwd:PROJECT_ROOT,encoding:"utf8",env:safeHostEnvironment(process.env),
});
if (preflight.status!==0) throw new Error(`Qualification preflight failed before launchd mutation: ${(preflight.stderr || preflight.stdout || "no output").trim().slice(0,1000)}`);
if (newRunRequested && (!priorState || !["READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION","BLOCKED_NOT_QUALIFIED"].includes(priorState.state))) {
  throw new Error("--new-run requires an existing terminal qualification state.");
}

const request = {
  version: "qualification-launchd-run-request-v2",
  request_id:randomUUID(),
  mode: newRunRequested ? "ONE_FRESH_RUN_THEN_RESUME" : "RESUME_ONLY",
  created_at: new Date().toISOString(),
  prior_run_id: priorState?.run_id || null,
  prior_state: priorState?.state || null,
  fresh_start_consumed: false,
  config_sha256:fileSha256(configPath),
  worker_sha256:fileSha256(workerPath),
  sealed_unseen_authorised: false,
};
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${entrypointPath}</string>
    <string>--config</string><string>${configPath}</string>
    <string>--request</string><string>${requestPath}</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_ROOT}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${resolve(logRoot, "worker.log")}</string>
  <key>StandardErrorPath</key><string>${resolve(logRoot, "worker.log")}</string>
</dict></plist>
`;

if (existsSync(plist) && readFileSync(plist,"utf8")!==xml) {
  throw new Error("Existing launchd plist differs from the exact owned qualification definition; refusing replacement.");
}
let registered=false;
const printed=spawnSync("launchctl",["print",`gui/${process.getuid()}/${label}`],{ encoding:"utf8" });
if (printed.status===0) {
  registered=true;
  const details=String(printed.stdout || "");
  if (!details.includes(entrypointPath) || !details.includes(configPath)) throw new Error("Registered launchd job is not the exact owned qualification entrypoint and config.");
}
atomicWrite(requestPath,request);
atomicWrite(plist, xml);
if (registered) execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "inherit" });
execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { stdio: "inherit" });
execFileSync("launchctl", ["enable", `gui/${process.getuid()}/${label}`], { stdio: "inherit" });
console.log(JSON.stringify({ installed: true,label,plist,log:resolve(logRoot,"worker.log"),request:requestPath,
  request_id:request.request_id,mode:request.mode,prior_run_id:request.prior_run_id,prior_state:request.prior_state,
  preflight_passed:true,one_fresh_run_only:newRunRequested,secrets_embedded:false },null,2));
