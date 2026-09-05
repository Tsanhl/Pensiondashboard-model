#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const specifications = {
  model: {
    executable:".training-venv/bin/python",
    requirements_path:"training/requirements-mac.txt",
    roots:["mlx","mlx-lm","safetensors","tokenizers","transformers"],
  },
  retrieval: {
    executable:".retrieval-venv/bin/python",
    requirements_path:"ml/requirements-embedding.txt",
    roots:["fastapi","numpy","sentence-transformers","torch","transformers","uvicorn"],
  },
};

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fingerprintScript = resolve("scripts/pythonEnvironmentFingerprint.py");
const environments = {};
for (const [name,specification] of Object.entries(specifications)) {
  const executable = resolve(specification.executable);
  const probe = spawnSync(executable,["-I","-B",fingerprintScript,"--roots",specification.roots.join(",")],{
    cwd:resolve("."),encoding:"utf8",timeout:600_000,maxBuffer:16 * 1024 * 1024,
  });
  if (probe.status !== 0) throw new Error(`${name} fingerprint failed: ${String(probe.stderr || probe.stdout || "").slice(0,1000)}`);
  environments[name] = {
    executable,
    requirements_path:specification.requirements_path,
    requirements_sha256:sha256File(specification.requirements_path),
    fingerprint:JSON.parse(probe.stdout),
  };
}
writeFileSync("runtime/python-environments.json",`${JSON.stringify({ version:"qualification-python-environments-v2",environments },null,2)}\n`);
console.log("Wrote runtime/python-environments.json with complete import-tree fingerprints.");
