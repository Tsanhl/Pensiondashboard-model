import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import {
  PINNED_EMBEDDING_MODEL,
  PINNED_RERANKER_MODEL,
  PINNED_RETRIEVAL_MANIFEST_PATH,
  PINNED_RETRIEVAL_MANIFEST_SHA256,
  PINNED_RETRIEVAL_SERVER_SHA256,
  PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
  PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
  pinnedEmbeddingResponseMatches,
  pinnedRerankerResponseMatches,
  pinnedRetrievalHealthMatches,
} from "../server/services/pinnedRetrievalIdentity.js";
import { verifyLiveRuntime } from "../scripts/lib/postTrainingVisibleQualificationV1.mjs";

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const vector = Array(PINNED_EMBEDDING_MODEL.dimensions).fill(0);

function retrievalFixtures() {
  const common = {
    server_sha256:PINNED_RETRIEVAL_SERVER_SHA256,
    model_manifest_sha256:PINNED_RETRIEVAL_MANIFEST_SHA256,
    snapshot_manifest_sha256:PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
    snapshot_contents_sha256:PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
  };
  return {
    health:{
      ok:true,model:PINNED_EMBEDDING_MODEL.repository,model_revision:PINNED_EMBEDDING_MODEL.revision,
      dimensions:PINNED_EMBEDDING_MODEL.dimensions,reranker_model:PINNED_RERANKER_MODEL.repository,
      reranker_revision:PINNED_RERANKER_MODEL.revision,local_files_only:true,
      retrieval_snapshot_manifest_sha256:PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
      retrieval_snapshot_contents_sha256:PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
      device:"cpu",threads:2,...common,
    },
    embedding:{
      model:PINNED_EMBEDDING_MODEL.repository,model_revision:PINNED_EMBEDDING_MODEL.revision,
      embeddings:[vector],...common,
    },
    reranker:{
      model:PINNED_RERANKER_MODEL.repository,model_revision:PINNED_RERANKER_MODEL.revision,
      results:[{ index:0,score:0.9 }],...common,
    },
  };
}

test("pinned retrieval manifest binds exact local model revisions and server source",() => {
  assert.match(PINNED_EMBEDDING_MODEL.revision,/^[a-f0-9]{40}$/);
  assert.match(PINNED_RERANKER_MODEL.revision,/^[a-f0-9]{40}$/);
  assert.equal(sha256File(PINNED_RETRIEVAL_MANIFEST_PATH),PINNED_RETRIEVAL_MANIFEST_SHA256);
  assert.equal(sha256File(new URL("../ml/embedding_server.py",import.meta.url)),PINNED_RETRIEVAL_SERVER_SHA256);
  const fixtures = retrievalFixtures();
  assert.equal(pinnedRetrievalHealthMatches(fixtures.health),true);
  assert.equal(pinnedEmbeddingResponseMatches(fixtures.embedding),true);
  assert.equal(pinnedRerankerResponseMatches(fixtures.reranker),true);
  assert.equal(pinnedRetrievalHealthMatches({ ...fixtures.health,model_revision:"0".repeat(40) }),false);
  assert.equal(pinnedEmbeddingResponseMatches({ ...fixtures.embedding,server_sha256:"0".repeat(64) }),false);
  assert.equal(pinnedRerankerResponseMatches({ ...fixtures.reranker,model_manifest_sha256:"0".repeat(64) }),false);
});

test("visible runtime preflight accepts exact retrieval identity and rejects a revision change",async (t) => {
  const expectedIdentity = {
    id:"synthetic-visible-model",base_sha256:"a".repeat(64),adapter_sha256:"b".repeat(64),
    adapter_config_sha256:"c".repeat(64),checkpoint_sha256:"d".repeat(64),
    model_config_sha256:"e".repeat(64),tokenizer_sha256:"f".repeat(64),tokenizer_config_sha256:"0".repeat(64),
  };
  const answerIdentity = {
    ...expectedIdentity,
    worker_sha256:sha256File(new URL("../ml/pinned_mlx_worker.py",import.meta.url)),
    cache_helper_sha256:sha256File(new URL("../ml/pinned_prompt_cache.py",import.meta.url)),
    supervisor_sha256:sha256File(new URL("../server/services/pinnedModelServer.js",import.meta.url)),
    mlx_lm_version:"0.31.3",lora_modules_loaded:1,
  };
  const fixtures = retrievalFixtures();
  let wrongRevision = false;
  const server = createServer(async (request,response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.setHeader("content-type","application/json");
    if (request.url === "/v1/models") return response.end(JSON.stringify({ ready:true,data:[answerIdentity] }));
    if (request.url === "/health") return response.end(JSON.stringify(wrongRevision
      ? { ...fixtures.health,reranker_revision:"0".repeat(40) }
      : fixtures.health));
    if (request.url === "/embed") return response.end(JSON.stringify(fixtures.embedding));
    if (request.url === "/rerank") return response.end(JSON.stringify(fixtures.reranker));
    response.statusCode = 404;
    return response.end("{}");
  });
  await new Promise((accept) => server.listen(0,"127.0.0.1",accept));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const passed = await verifyLiveRuntime({ modelBaseUrl:baseUrl,embeddingBaseUrl:baseUrl,expectedIdentity,expectedRetrievalDevice:"cpu",expectedRetrievalThreads:2 });
  assert.deepEqual(passed.retrieval_identity,{
    embedding_model:PINNED_EMBEDDING_MODEL.repository,embedding_revision:PINNED_EMBEDDING_MODEL.revision,
    dimensions:PINNED_EMBEDDING_MODEL.dimensions,reranker_model:PINNED_RERANKER_MODEL.repository,
    reranker_revision:PINNED_RERANKER_MODEL.revision,server_sha256:PINNED_RETRIEVAL_SERVER_SHA256,
    model_manifest_sha256:PINNED_RETRIEVAL_MANIFEST_SHA256,
    snapshot_manifest_sha256:PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
    snapshot_contents_sha256:PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,local_files_only:true,
  });
  wrongRevision = true;
  await assert.rejects(
    verifyLiveRuntime({ modelBaseUrl:baseUrl,embeddingBaseUrl:baseUrl,expectedIdentity }),
    /wrong identity/,
  );
  wrongRevision = false;
  await assert.rejects(
    verifyLiveRuntime({ modelBaseUrl:baseUrl,embeddingBaseUrl:baseUrl,expectedIdentity,expectedRetrievalDevice:"cpu",expectedRetrievalThreads:1 }),
    /device or thread count/,
  );
});
