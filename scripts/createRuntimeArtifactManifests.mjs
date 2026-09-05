#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { captureRuntimeDirectory } from "./lib/qualification-worker/runtimeArtifactManifests.mjs";
import { canonicalHash } from "./lib/qualification-worker/utils.mjs";

const base = captureRuntimeDirectory(resolve("models/mlx/Qwen3-8B-4bit"));
writeFileSync("models/base-model-directory-manifest.json",`${JSON.stringify({ version:"base-model-directory-manifest-v1",...base },null,2)}\n`);
const specifications = {
  embedding:{ repository:"BAAI/bge-small-en-v1.5",revision:"5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",root:"/Users/hltsang/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a" },
  reranker:{ repository:"BAAI/bge-reranker-base",revision:"2cfc18c9415c912f9d8155881c133215df768a70",root:"/Users/hltsang/.cache/huggingface/hub/models--BAAI--bge-reranker-base/snapshots/2cfc18c9415c912f9d8155881c133215df768a70" },
};
const snapshots = Object.fromEntries(Object.entries(specifications).map(([name,spec]) => [name,{ ...spec,...captureRuntimeDirectory(spec.root) }]));
const rows = Object.entries(snapshots).map(([name,value]) => ({ name,repository:value.repository,revision:value.revision,root:value.root,records_sha256:value.records_sha256 }));
const manifest = { version:"retrieval-snapshot-manifest-v1",snapshots,snapshot_contents_sha256:canonicalHash(rows) };
writeFileSync("models/retrieval-snapshot-manifest.json",`${JSON.stringify(manifest,null,2)}\n`);
