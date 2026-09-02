import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "models/model-manifest.json"), "utf8"));
const model = manifest.answer_model;
const target = resolve(root, "models", model.file);
const temporary = `${target}.partial`;
const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.file}`;

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ url,target,expectedBytes:model.size_bytes,sha256:model.sha256 }, null, 2));
    return;
  }
  mkdirSync(dirname(target), { recursive:true });
  if (existsSync(target) && statSync(target).size === model.size_bytes && await sha256(target) === model.sha256) {
    console.log(`${model.file} is already installed and checksum verified.`);
    return;
  }
  if (existsSync(temporary)) unlinkSync(temporary);
  console.log(`Downloading pinned ${model.repository}@${model.revision} (${(model.size_bytes / 1e9).toFixed(1)} GB)…`);
  const response = await fetch(url, { redirect:"follow" });
  if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}).`);
  await pipeline(response.body, createWriteStream(temporary, { flags:"wx" }));
  if (statSync(temporary).size !== model.size_bytes) throw new Error("Downloaded model size does not match the manifest.");
  const digest = await sha256(temporary);
  if (digest !== model.sha256) throw new Error(`Checksum mismatch: expected ${model.sha256}, received ${digest}.`);
  renameSync(temporary, target);
  console.log(`Installed and verified ${target}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
