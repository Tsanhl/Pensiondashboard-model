#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./lib/qualification-worker/utils.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const label = "com.hltsang.pensions-qualification-worker";
const plist = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const logRoot = resolve(PROJECT_ROOT, "Log/qualification-worker");
const requestPath = resolve(logRoot, "launchd-run-request.json");
mkdirSync(dirname(plist), { recursive: true });
mkdirSync(logRoot, { recursive: true });
const statePath = resolve(logRoot, "worker-state.json");
const priorState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
atomicWrite(requestPath, {
  version: "qualification-launchd-run-request-v1",
  mode: "ONE_FRESH_RUN_THEN_RESUME",
  created_at: new Date().toISOString(),
  prior_run_id: priorState?.run_id || null,
  prior_state: priorState?.state || null,
  fresh_start_consumed: false,
  sealed_unseen_authorised: false,
});
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${resolve(PROJECT_ROOT, "scripts/qualificationWorkerLaunchdEntrypoint.mjs")}</string>
    <string>--config</string><string>${resolve(PROJECT_ROOT, "config/qualification-worker.json")}</string>
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
atomicWrite(plist, xml);
try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" }); } catch {}
execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { stdio: "inherit" });
execFileSync("launchctl", ["enable", `gui/${process.getuid()}/${label}`], { stdio: "inherit" });
console.log(JSON.stringify({ installed: true, label, plist, log: resolve(logRoot, "worker.log"), request: requestPath, prior_run_id: priorState?.run_id || null, prior_state: priorState?.state || null, one_fresh_run_only: true, secrets_embedded: false }, null, 2));
