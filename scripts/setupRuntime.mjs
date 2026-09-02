import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "runtime/runtime-manifest.json"), "utf8"));
const platformKey = `${process.platform}-${process.arch}`;
const artifact = manifest.platforms[platformKey];
if (!artifact) throw new Error(`No pinned llama.cpp runtime is configured for ${platformKey}.`);
const archive = resolve(root, "runtime/downloads", artifact.file);
const binDir = resolve(root, "runtime/bin", platformKey);

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function findServer(path) {
  for (const entry of readdirSync(path, { withFileTypes:true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) { const found = findServer(next); if (found) return found; }
    else if (entry.name === (process.platform === "win32" ? "llama-server.exe" : "llama-server")) return next;
  }
  return null;
}

async function main() {
  mkdirSync(dirname(archive), { recursive:true });
  mkdirSync(binDir, { recursive:true });
  if (!existsSync(archive) || statSync(archive).size !== artifact.size_bytes || await sha256(archive) !== artifact.sha256) {
    console.log(`Downloading pinned llama.cpp ${manifest.release} for ${platformKey}…`);
    const response = await fetch(artifact.url, { redirect:"follow" });
    if (!response.ok || !response.body) throw new Error(`Runtime download failed (${response.status}).`);
    await pipeline(response.body, createWriteStream(archive));
  }
  if (statSync(archive).size !== artifact.size_bytes || await sha256(archive) !== artifact.sha256) throw new Error("llama.cpp runtime checksum validation failed.");
  if (artifact.file.endsWith(".zip")) execFileSync("powershell", ["-NoProfile","-Command",`Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${binDir.replaceAll("'", "''")}' -Force`], { stdio:"inherit" });
  else execFileSync("tar", ["-xzf",archive,"-C",binDir], { stdio:"inherit" });
  const server = findServer(binDir);
  if (!server) throw new Error("The verified archive did not contain llama-server.");
  writeFileSync(resolve(root, "runtime/runtime-lock.json"), `${JSON.stringify({ release:manifest.release,platform:platformKey,server,sha256:artifact.sha256 }, null, 2)}\n`);
  console.log(`Installed verified llama-server: ${server}`);
}

main().catch((error) => { console.error(error.message); process.exitCode=1; });
