import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "models/model-manifest.json"), "utf8"));
const modelPath = resolve(root, "models", manifest.answer_model.file);
const runtimeLockPath = resolve(root, "runtime/runtime-lock.json");
const runtimeLock = existsSync(runtimeLockPath) ? JSON.parse(readFileSync(runtimeLockPath, "utf8")) : null;
const runtime = String(process.env.MODEL_RUNTIME || (runtimeLock ? "llama.cpp" : "ollama")).toLowerCase();

if (runtime === "llama.cpp" || runtime === "llama-server") {
  if (!existsSync(modelPath)) throw new Error("Model file is missing. Run npm run setup:models first.");
  const serverBin = process.env.LLAMA_SERVER_BIN || runtimeLock?.server || "llama-server";
  const child = spawn(serverBin, ["-m",modelPath,"--host","127.0.0.1","--port",String(process.env.LOCAL_LLM_PORT || 8080),"-c","8192","-ngl","99"], { stdio:"inherit" });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else if (runtime === "ollama") {
  const child = spawn("ollama", ["serve"], { stdio:"inherit" });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  throw new Error("MODEL_RUNTIME must be ollama or llama.cpp.");
}
