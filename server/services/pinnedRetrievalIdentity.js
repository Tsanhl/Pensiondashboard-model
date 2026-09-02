import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = fileURLToPath(new URL("../../models/model-manifest.json", import.meta.url));
const manifestBytes = readFileSync(MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes);
const fullSha = (value) => /^[a-f0-9]{64}$/i.test(String(value || ""));

if (manifest?.schema_version !== 1 ||
  manifest.embedding_model?.repository !== "BAAI/bge-small-en-v1.5" ||
  !/^[a-f0-9]{40}$/i.test(String(manifest.embedding_model?.revision || "")) ||
  manifest.embedding_model?.dimensions !== 384 ||
  manifest.reranker_model?.repository !== "BAAI/bge-reranker-base" ||
  !/^[a-f0-9]{40}$/i.test(String(manifest.reranker_model?.revision || "")) ||
  manifest.retrieval_runtime?.local_files_only !== true ||
  !fullSha(manifest.retrieval_runtime?.embedding_server_sha256)) {
  throw new Error("Pinned retrieval identity is missing or invalid in models/model-manifest.json.");
}

export const PINNED_RETRIEVAL_MANIFEST_PATH = MANIFEST_PATH;
export const PINNED_RETRIEVAL_MANIFEST_SHA256 = createHash("sha256").update(manifestBytes).digest("hex");
export const PINNED_EMBEDDING_MODEL = Object.freeze({
  repository: manifest.embedding_model.repository,
  revision: manifest.embedding_model.revision,
  dimensions: manifest.embedding_model.dimensions,
});
export const PINNED_RERANKER_MODEL = Object.freeze({
  repository: manifest.reranker_model.repository,
  revision: manifest.reranker_model.revision,
});
export const PINNED_RETRIEVAL_SERVER_SHA256 = manifest.retrieval_runtime.embedding_server_sha256;

export function pinnedRetrievalHealthMatches(body) {
  return body?.ok === true && body?.model === PINNED_EMBEDDING_MODEL.repository &&
    body?.model_revision === PINNED_EMBEDDING_MODEL.revision &&
    body?.dimensions === PINNED_EMBEDDING_MODEL.dimensions &&
    body?.reranker_model === PINNED_RERANKER_MODEL.repository &&
    body?.reranker_revision === PINNED_RERANKER_MODEL.revision &&
    body?.server_sha256 === PINNED_RETRIEVAL_SERVER_SHA256 &&
    body?.model_manifest_sha256 === PINNED_RETRIEVAL_MANIFEST_SHA256 &&
    body?.local_files_only === true;
}

export function pinnedEmbeddingResponseMatches(body) {
  const vector = body?.embeddings?.[0];
  return body?.model === PINNED_EMBEDDING_MODEL.repository &&
    body?.model_revision === PINNED_EMBEDDING_MODEL.revision &&
    body?.server_sha256 === PINNED_RETRIEVAL_SERVER_SHA256 &&
    body?.model_manifest_sha256 === PINNED_RETRIEVAL_MANIFEST_SHA256 &&
    Array.isArray(vector) && vector.length === PINNED_EMBEDDING_MODEL.dimensions &&
    vector.every((value) => typeof value === "number" && Number.isFinite(value));
}

export function pinnedRerankerResponseMatches(body) {
  const first = body?.results?.[0];
  return body?.model === PINNED_RERANKER_MODEL.repository &&
    body?.model_revision === PINNED_RERANKER_MODEL.revision &&
    body?.server_sha256 === PINNED_RETRIEVAL_SERVER_SHA256 &&
    body?.model_manifest_sha256 === PINNED_RETRIEVAL_MANIFEST_SHA256 &&
    Number.isInteger(first?.index) && first.index === 0 &&
    typeof first.score === "number" && Number.isFinite(first.score);
}

export function pinnedRetrievalIdentity() {
  return {
    embedding_model: PINNED_EMBEDDING_MODEL.repository,
    embedding_revision: PINNED_EMBEDDING_MODEL.revision,
    dimensions: PINNED_EMBEDDING_MODEL.dimensions,
    reranker_model: PINNED_RERANKER_MODEL.repository,
    reranker_revision: PINNED_RERANKER_MODEL.revision,
    server_sha256: PINNED_RETRIEVAL_SERVER_SHA256,
    model_manifest_sha256: PINNED_RETRIEVAL_MANIFEST_SHA256,
    local_files_only: true,
  };
}
