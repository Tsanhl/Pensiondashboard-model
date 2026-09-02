import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const candidates = process.platform === "win32"
  ? [join(".venv","Scripts","python.exe"), "python"]
  : [join(".venv","bin","python"), "python3", "python"];
const executable = candidates.find((item) => item.includes(".venv") ? existsSync(item) : true);
const child = spawn(executable, ["-m","uvicorn","ml.embedding_server:app","--host",process.env.ML_HOST || "127.0.0.1","--port",process.env.ML_PORT || "8090"], { stdio:"inherit",shell:false });
child.on("error", (error) => {
  console.error(`Could not start the retrieval-model service with ${executable}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code || 0; });
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => child.kill(signal));
