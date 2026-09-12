import { spawn } from "node:child_process";

const commands = [["npm",["run","infra:up"]]];
if (process.env.SKIP_LOCAL_MODEL !== "true") commands.push(["npm",["run","model:serve"]]);
if (process.env.SKIP_RETRIEVAL_MODELS !== "true") commands.push(["npm",["run","retrieval:serve"]]);
commands.push(["npm",["start"]]);
const children = commands.map(([command,args]) => spawn(command,args,{ stdio:"inherit",shell:process.platform === "win32" }));
const stop = () => children.forEach((child) => child.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => { if (code && code !== 0) { stop(); process.exitCode = code; } });
