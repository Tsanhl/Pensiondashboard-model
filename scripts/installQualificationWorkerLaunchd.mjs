#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./lib/qualification-worker/utils.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const label = "com.hltsang.pensions-qualification-worker";
const plist = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const logRoot = resolve(PROJECT_ROOT, "Log/qualification-worker");
mkdirSync(dirname(plist), { recursive: true });
mkdirSync(logRoot, { recursive: true });
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${resolve(PROJECT_ROOT, "scripts/qualificationWorker.mjs")}</string>
    <string>--config</string><string>${resolve(PROJECT_ROOT, "config/qualification-worker.json")}</string>
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
console.log(JSON.stringify({ installed: true, label, plist, log: resolve(logRoot, "worker.log"), secrets_embedded: false }, null, 2));
