import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  approvedCorpusReadiness,
  bootstrapApprovedCorpus,
  loadApprovedCorpusManifest
} from "../server/services/approvedCorpusService.js";
import {
  evaluateReadiness,
  productionConfigurationReadiness
} from "../server/services/readinessService.js";
import { rerankSources } from "../server/services/rerankingService.js";
import { structuralChunk } from "../server/services/chunkingService.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function indexedChunks(input) {
  return structuralChunk(input.text,{ documentType:input.documentType }).map((chunk,index) => ({
    id:`${input.id}_chunk_${index + 1}`,documentId:input.id,sectionPath:chunk.sectionPath,
    ordinal:chunk.ordinal,tokenCount:chunk.tokenCount,content:chunk.content,
    metadata:{ quarantined:false },embedding:[0.1,0.2],
  }));
}

function allReadyProbes(overrides = {}) {
  const ready = (code) => async () => ({ ready:true,code });
  return {
    configuration:ready("CONFIG_READY"),
    model:ready("MODEL_READY"),
    embeddings:ready("EMBEDDING_READY"),
    reranker:ready("RERANK_READY"),
    datastore:ready("DATASTORE_READY"),
    cache:ready("CACHE_READY"),
    objectStorage:ready("OBJECT_STORAGE_READY"),
    malwareScanner:ready("MALWARE_SCAN_READY"),
    approvedCorpus:ready("CORPUS_READY"),
    ...overrides
  };
}

test("readiness succeeds only when every required probe succeeds", async () => {
  const ready = await evaluateReadiness({ probes:allReadyProbes() });
  assert.equal(ready.ready, true);
  assert.equal(ready.status, "ready");

  const blocked = await evaluateReadiness({ probes:allReadyProbes({
    reranker:async () => ({ ready:false,code:"RERANK_UNAVAILABLE" })
  }) });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.status, "not_ready");
  assert.equal(blocked.checks.find((check) => check.name === "reranker").code, "RERANK_UNAVAILABLE");
});

test("production readiness configuration requires fail-closed services and full hash pins", async () => {
  const complete = {
    NODE_ENV:"production",
    REQUIRE_AUTH:"true",
    REQUIRE_2FA:"true",
    LOCAL_LLM_BASE_URL:"https://model.internal",
    LOCAL_LLM_EXPECTED_ADAPTER_SHA256:"a".repeat(64),
    LOCAL_LLM_EXPECTED_BASE_SHA256:"b".repeat(64),
    EMBEDDING_SERVICE_URL:"https://retrieval.internal",
    ALLOW_DEGRADED_EMBEDDINGS:"false",
    RERANK_SERVICE_URL:"https://retrieval.internal",
    REQUIRE_CROSS_ENCODER_RERANK:"true",
    PENSIONS_STORAGE:"postgres",
    DATABASE_URL:"postgres://configured",
    REDIS_URL:"redis://configured",
    OBJECT_STORAGE_MODE:"s3",
    S3_BUCKET:"configured",
    REQUIRE_MALWARE_SCAN:"true",
    MALWARE_SCAN_HEALTH_URL:"https://scanner.internal/health",
    APPROVED_CORPUS_MANIFEST_PATH:"/srv/approved/manifest.json",
    APPROVED_CORPUS_MANIFEST_SHA256:"c".repeat(64)
  };
  assert.deepEqual(await productionConfigurationReadiness(complete), { ready:true,code:"PRODUCTION_CONFIG_READY" });
  const weakened = await productionConfigurationReadiness({ ...complete,ALLOW_DEGRADED_EMBEDDINGS:"true",LOCAL_LLM_EXPECTED_ADAPTER_SHA256:"placeholder" });
  assert.equal(weakened.ready, false);
  assert.equal(weakened.code, "PRODUCTION_CONFIG_INCOMPLETE");
  assert.equal(weakened.missingCount, 2);
});

test("approved-corpus bootstrap validates hashes and is idempotent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "approved-corpus-test-"));
  t.after(() => rm(directory, { recursive:true,force:true }));
  const text = "Section 1\nA synthetic approved source used only by this unit test.";
  await writeFile(join(directory, "source.txt"), text);
  const manifest = {
    schema_version:1,
    corpus_id:"synthetic-unit-test",
    approval_status:"approved",
    approved_by:"Unit Test Reviewer",
    approved_at:"2026-09-01T00:00:00.000Z",
    documents:[{
      id:"synthetic-approved-source",
      title:"Synthetic approved source",
      authority:"Unit Test Authority",
      jurisdiction:"United Kingdom",
      canonical_location:"https://example.invalid/source",
      version:1,
      effective_date:"2026-09-01",
      licence:"Synthetic test fixture",
      reviewer:"Unit Test Reviewer",
      approval_status:"approved",
      source_type:"official_guidance",
      text_path:"source.txt",
      text_sha256:sha256(text)
    }]
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, manifestBytes);
  const environment = {
    APPROVED_CORPUS_MANIFEST_PATH:manifestPath,
    APPROVED_CORPUS_MANIFEST_SHA256:sha256(manifestBytes),
    APPROVED_CORPUS_MIN_DOCUMENTS:"1"
  };

  const loaded = await loadApprovedCorpusManifest({ environment });
  assert.equal(loaded.documents.length, 1);
  const active = [];
  const chunks = [];
  const listDocumentsFn = async () => active;
  const listChunksFn = async () => chunks;
  const indexDocumentFn = async (_userId, input) => {
    const document = {
      id:input.id,version:input.version,checksum:input.checksum,status:"active",scope:input.scope,
      metadata:{ approvalStatus:input.metadata.approvalStatus,reviewer:input.metadata.reviewer }
    };
    active.push(document);
    chunks.push(...indexedChunks(input));
    return { document,chunkCount:1 };
  };
  const first = await bootstrapApprovedCorpus({ environment,listDocumentsFn,listChunksFn,indexDocumentFn });
  const second = await bootstrapApprovedCorpus({ environment,listDocumentsFn,listChunksFn,indexDocumentFn });
  assert.equal(first.indexed, 1);
  assert.equal(first.skipped, 0);
  assert.equal(second.indexed, 0);
  assert.equal(second.skipped, 1);
});

test("approved-corpus manifest cannot read text outside its directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "approved-corpus-path-test-"));
  t.after(() => rm(directory, { recursive:true,force:true }));
  const manifest = {
    schema_version:1,approval_status:"approved",approved_by:"Reviewer",approved_at:"2026-09-01T00:00:00.000Z",
    documents:[{
      id:"escape",title:"Escape",authority:"Test",jurisdiction:"UK",canonical_location:"https://example.invalid",
      version:1,effective_date:"2026-09-01",licence:"Test",reviewer:"Reviewer",approval_status:"approved",
      source_type:"official_guidance",text_path:"../outside.txt",text_sha256:"d".repeat(64)
    }]
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, bytes);
  await assert.rejects(loadApprovedCorpusManifest({ environment:{
    APPROVED_CORPUS_MANIFEST_PATH:manifestPath,
    APPROVED_CORPUS_MANIFEST_SHA256:sha256(bytes)
  } }), /escapes the manifest directory/);
});

test("approved-corpus readiness pins the exact structured-fact snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "approved-corpus-facts-test-"));
  t.after(() => rm(directory, { recursive:true,force:true }));
  const text = "Synthetic approved source";
  await writeFile(join(directory,"source.txt"),`${text}\n`);
  const collection = {
    collection_id:"synthetic-facts",jurisdiction:"United Kingdom",valid_from:"2026-04-06",valid_to:"2027-04-05",
    last_verified_at:"2026-09-01",review_cycle_days:7,
    facts:[{ id:"synthetic-limit",topic:"limit",label:"Synthetic limit",value:10,unit:"GBP",source_url:"https://example.invalid",source_section:"Limit" }],
  };
  const collectionBytes = Buffer.from(`${JSON.stringify(collection,null,2)}\n`);
  await writeFile(join(directory,"facts.json"),collectionBytes);
  const manifest = {
    schema_version:1,approval_status:"approved",approved_by:"Reviewer",approved_at:"2026-09-01T00:00:00.000Z",
    documents:[{
      id:"doc",title:"Doc",authority:"Authority",jurisdiction:"United Kingdom",canonical_location:"https://example.invalid/doc",
      version:1,effective_date:"2026-09-01",licence:"Test",reviewer:"Reviewer",approval_status:"approved",
      source_type:"official_guidance",text_path:"source.txt",text_sha256:sha256(text),text_normalization:"strip_one_trailing_lf",
    }],
    structured_fact_collections:[{ collection_id:"synthetic-facts",path:"facts.json",sha256:sha256(collectionBytes),reviewer:"Reviewer",approval_status:"approved" }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
  const manifestPath = join(directory,"manifest.json");
  await writeFile(manifestPath,manifestBytes);
  const environment = { APPROVED_CORPUS_MANIFEST_PATH:manifestPath,APPROVED_CORPUS_MANIFEST_SHA256:sha256(manifestBytes) };
  const documents = [{ id:"doc",version:1,checksum:sha256(text),status:"active",scope:"CURATED_PUBLIC",metadata:{ approvalStatus:"approved",reviewer:"Reviewer" } }];
  const activeFact = {
    ...collection.facts[0],collectionId:"synthetic-facts",jurisdiction:"United Kingdom",validFrom:"2026-04-06",validTo:"2027-04-05",
    lastVerifiedAt:"2026-09-01",reviewCycleDays:7,fineTuningEligible:false,status:"active",
  };
  const chunks = indexedChunks({ id:"doc",text,documentType:"official_guidance" });
  const ready = await approvedCorpusReadiness({ environment,listDocumentsFn:async () => documents,listChunksFn:async () => chunks,listPublicFactsFn:() => [activeFact] });
  assert.equal(ready.ready,true);
  const changed = await approvedCorpusReadiness({ environment,listDocumentsFn:async () => documents,listChunksFn:async () => chunks,listPublicFactsFn:() => [{ ...activeFact,value:11 }] });
  assert.equal(changed.ready,false);
  assert.equal(changed.structuredFactsMatch,false);
});

test("required cross-encoder reranking rejects a missing service URL", async (t) => {
  const previousUrl = process.env.RERANK_SERVICE_URL;
  const previousRequired = process.env.REQUIRE_CROSS_ENCODER_RERANK;
  delete process.env.RERANK_SERVICE_URL;
  process.env.REQUIRE_CROSS_ENCODER_RERANK = "true";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.RERANK_SERVICE_URL;
    else process.env.RERANK_SERVICE_URL = previousUrl;
    if (previousRequired === undefined) delete process.env.REQUIRE_CROSS_ENCODER_RERANK;
    else process.env.REQUIRE_CROSS_ENCODER_RERANK = previousRequired;
  });
  await assert.rejects(rerankSources("test", [{ sourceId:"source",title:"Test",snippet:"Test",score:0.5 }]), { code:"RERANK_CONFIG_ERROR" });
});
