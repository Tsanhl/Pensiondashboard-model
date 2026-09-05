import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const fallback = process.platform === "win32" ? [join(".venv","Scripts","python.exe"),"python"] : [join(".venv","bin","python"),"python3","python"];
const executable = String(process.env.PINNED_RETRIEVAL_PYTHON || (process.env.QUALIFICATION_RUNTIME_MODE === "true" ? "" : fallback.find((item) => item.includes(".venv") ? existsSync(item) : true))).trim();
if (!executable || !existsSync(executable)) throw new Error("PINNED_RETRIEVAL_PYTHON must name the verified qualification interpreter.");
if (process.env.QUALIFICATION_RUNTIME_MODE === "true" &&
    [process.env.QUALIFICATION_RUNTIME_CONFIGURATION_SHA256,process.env.QUALIFICATION_PYTHON_ENVIRONMENT_SHA256].some((value) => !/^[0-9a-f]{64}$/.test(String(value || "")))) {
  throw new Error("Qualification retrieval runtime bindings are missing or malformed.");
}
const embeddingModule = resolve("ml/embedding_server.py");
const child = spawn(executable, ["-I","-B",resolve("scripts/isolatedPythonLauncher.py"),"--root",resolve("."),"--verify-module",`ml.embedding_server=${embeddingModule}`,"--module","uvicorn","ml.embedding_server:app","--host",process.env.ML_HOST || "127.0.0.1","--port",process.env.ML_PORT || "8090"], { stdio:"inherit",shell:false });
child.on("error", (error) => {
  console.error(`Could not start the retrieval-model service with ${executable}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code || 0; });
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => child.kill(signal));
