import { createHash } from "node:crypto";
import { approvedCorpusReadiness } from "./approvedCorpusService.js";
import { cacheReadiness } from "./cacheService.js";
import { EMBEDDING_DIMENSIONS } from "./embeddingService.js";
import { localModelStatus } from "./localModelService.js";
import { objectStorageReadiness } from "./objectStorageService.js";
import { getPortfolioSeedForUser } from "../portfolioStore.js";
import { dataStoreReadiness, getRiskProfileSeedForUser, readPortfolio, readRiskProfile } from "../store/userDataStore.js";
import {
  PINNED_EMBEDDING_MODEL,
  PINNED_RERANKER_MODEL,
  pinnedEmbeddingResponseMatches,
  pinnedRerankerResponseMatches,
} from "./pinnedRetrievalIdentity.js";

let cachedReadiness = null;
let cachedAt = 0;
let pendingReadiness = null;

function enabled(value) {
  return String(value || "").toLowerCase() === "true";
}

function production(environment) {
  return String(environment.NODE_ENV || "").toLowerCase() === "production";
}

function fullSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key,stableValue(value[key])]));
  return value;
}

export function canonicalQualificationFactsReadiness(environment = process.env) {
  const userId = String(environment.QUALIFICATION_CANONICAL_USER_ID || "").trim();
  if (!userId) return { ready:true,code:"QUALIFICATION_CANONICAL_FACTS_NOT_REQUIRED" };
  const expected = { portfolio:getPortfolioSeedForUser(userId),riskProfile:getRiskProfileSeedForUser(userId) };
  const actual = { portfolio:readPortfolio(userId, expected.portfolio),riskProfile:readRiskProfile(userId) };
  const expectedJson = JSON.stringify(stableValue(expected));
  const actualJson = JSON.stringify(stableValue(actual));
  const expectedSha256 = createHash("sha256").update(expectedJson).digest("hex");
  const actualSha256 = createHash("sha256").update(actualJson).digest("hex");
  return { ready:expectedJson === actualJson,code:expectedJson === actualJson ? "QUALIFICATION_CANONICAL_FACTS_READY" : "QUALIFICATION_CANONICAL_FACTS_CHANGED",canonicalFactsSha256:expectedSha256,actualCanonicalFactsSha256:actualSha256,canonicalUserId:userId };
}

async function postJson(url, payload, environment) {
  const response = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(Number(environment.READINESS_DEPENDENCY_TIMEOUT_MS || 3_000))
  });
  if (!response.ok) throw new Error("dependency returned a non-success response");
  return response.json();
}

export async function productionConfigurationReadiness(environment = process.env) {
  if (!production(environment)) return { ready:true,code:"DEVELOPMENT_CONFIGURATION" };
  const failures = [];
  if (!enabled(environment.REQUIRE_AUTH)) failures.push("REQUIRE_AUTH");
  if (!enabled(environment.REQUIRE_2FA)) failures.push("REQUIRE_2FA");
  if (!fullSha256(environment.LOCAL_LLM_EXPECTED_ADAPTER_SHA256)) failures.push("LOCAL_LLM_EXPECTED_ADAPTER_SHA256");
  if (!fullSha256(environment.LOCAL_LLM_EXPECTED_BASE_SHA256)) failures.push("LOCAL_LLM_EXPECTED_BASE_SHA256");
  if (!String(environment.LOCAL_LLM_BASE_URL || "").trim()) failures.push("LOCAL_LLM_BASE_URL");
  if (!String(environment.EMBEDDING_SERVICE_URL || "").trim()) failures.push("EMBEDDING_SERVICE_URL");
  if (enabled(environment.ALLOW_DEGRADED_EMBEDDINGS)) failures.push("ALLOW_DEGRADED_EMBEDDINGS=false");
  if (!String(environment.RERANK_SERVICE_URL || "").trim()) failures.push("RERANK_SERVICE_URL");
  if (!enabled(environment.REQUIRE_CROSS_ENCODER_RERANK)) failures.push("REQUIRE_CROSS_ENCODER_RERANK");
  if (!["postgres", "postgresql"].includes(String(environment.PENSIONS_STORAGE || "").toLowerCase())) failures.push("PENSIONS_STORAGE=postgres");
  if (!String(environment.DATABASE_URL || "").trim()) failures.push("DATABASE_URL");
  if (!String(environment.REDIS_URL || "").trim()) failures.push("REDIS_URL");
  if (String(environment.OBJECT_STORAGE_MODE || "").toLowerCase() !== "s3") failures.push("OBJECT_STORAGE_MODE=s3");
  if (!String(environment.S3_BUCKET || "").trim()) failures.push("S3_BUCKET");
  if (!enabled(environment.REQUIRE_MALWARE_SCAN)) failures.push("REQUIRE_MALWARE_SCAN");
  if (!String(environment.MALWARE_SCAN_HEALTH_URL || "").trim()) failures.push("MALWARE_SCAN_HEALTH_URL");
  if (!String(environment.APPROVED_CORPUS_MANIFEST_PATH || "").trim()) failures.push("APPROVED_CORPUS_MANIFEST_PATH");
  if (!fullSha256(environment.APPROVED_CORPUS_MANIFEST_SHA256)) failures.push("APPROVED_CORPUS_MANIFEST_SHA256");
  return failures.length
    ? { ready:false,code:"PRODUCTION_CONFIG_INCOMPLETE",missingCount:failures.length }
    : { ready:true,code:"PRODUCTION_CONFIG_READY" };
}

export async function pinnedModelReadiness(environment = process.env) {
  if (!fullSha256(environment.LOCAL_LLM_EXPECTED_ADAPTER_SHA256) || !fullSha256(environment.LOCAL_LLM_EXPECTED_BASE_SHA256)) {
    return { ready:false,code:"MODEL_NOT_PINNED" };
  }
  const status = await localModelStatus();
  return status.available
    ? { ready:true,code:"MODEL_READY",model:status.model }
    : { ready:false,code:"MODEL_UNAVAILABLE",model:status.model };
}

export async function embeddingReadiness(environment = process.env) {
  const baseUrl = String(environment.EMBEDDING_SERVICE_URL || "").replace(/\/$/, "");
  if (!baseUrl) return { ready:false,code:"EMBEDDING_CONFIG_MISSING" };
  try {
    const payload = await postJson(`${baseUrl}/embed`, {
      model:PINNED_EMBEDDING_MODEL.repository,
      texts:["pension service readiness probe"],
      normalize:true
    }, environment);
    return pinnedEmbeddingResponseMatches(payload)
      ? { ready:true,code:"EMBEDDING_READY",dimensions:EMBEDDING_DIMENSIONS }
      : { ready:false,code:"EMBEDDING_INVALID_RESPONSE" };
  } catch {
    return { ready:false,code:"EMBEDDING_UNAVAILABLE" };
  }
}

export async function rerankerReadiness(environment = process.env) {
  const baseUrl = String(environment.RERANK_SERVICE_URL || "").replace(/\/$/, "");
  if (!baseUrl) return { ready:false,code:"RERANK_CONFIG_MISSING" };
  try {
    const payload = await postJson(`${baseUrl}/rerank`, {
      model:PINNED_RERANKER_MODEL.repository,
      query:"pension service readiness probe",
      documents:["pension service readiness probe"],
      top_n:1
    }, environment);
    return pinnedRerankerResponseMatches(payload)
      ? { ready:true,code:"RERANK_READY",model:payload.model }
      : { ready:false,code:"RERANK_INVALID_RESPONSE" };
  } catch {
    return { ready:false,code:"RERANK_UNAVAILABLE" };
  }
}

export async function malwareScannerReadiness(environment = process.env) {
  if (!enabled(environment.REQUIRE_MALWARE_SCAN)) {
    return production(environment)
      ? { ready:false,code:"MALWARE_SCAN_REQUIRED" }
      : { ready:true,code:"MALWARE_SCAN_NOT_REQUIRED" };
  }
  const healthUrl = String(environment.MALWARE_SCAN_HEALTH_URL || "").trim();
  if (!healthUrl) return { ready:false,code:"MALWARE_SCAN_HEALTH_URL_MISSING" };
  try {
    const response = await fetch(healthUrl, { signal:AbortSignal.timeout(Number(environment.READINESS_DEPENDENCY_TIMEOUT_MS || 3_000)) });
    return response.ok
      ? { ready:true,code:"MALWARE_SCAN_READY" }
      : { ready:false,code:"MALWARE_SCAN_UNAVAILABLE" };
  } catch {
    return { ready:false,code:"MALWARE_SCAN_UNAVAILABLE" };
  }
}

function defaultProbes(environment) {
  const requireProductionServices = production(environment);
  return {
    configuration:() => productionConfigurationReadiness(environment),
    model:() => pinnedModelReadiness(environment),
    embeddings:() => embeddingReadiness(environment),
    reranker:() => rerankerReadiness(environment),
    datastore:() => dataStoreReadiness({ requirePostgres:requireProductionServices }),
    cache:() => cacheReadiness({ requireRedis:requireProductionServices }),
    objectStorage:() => objectStorageReadiness({ requireS3:requireProductionServices }),
    malwareScanner:() => malwareScannerReadiness(environment),
    approvedCorpus:() => approvedCorpusReadiness({ environment }),
    canonicalFacts:() => canonicalQualificationFactsReadiness(environment)
  };
}

function safeCheckResult(name, result) {
  return {
    name,
    ready:result?.ready === true,
    code:String(result?.code || (result?.ready ? "READY" : "NOT_READY")),
    ...Object.fromEntries(Object.entries(result || {}).filter(([key, value]) =>
      !["ready", "code", "endpoint", "url", "bucket", "manifestPath"].includes(key)
      && ["string", "number", "boolean"].includes(typeof value)
    ))
  };
}

export async function evaluateReadiness({ environment = process.env, probes = {} } = {}) {
  const runners = { ...defaultProbes(environment), ...probes };
  const checks = await Promise.all(Object.entries(runners).map(async ([name, run]) => {
    try {
      return safeCheckResult(name, await run());
    } catch {
      return { name,ready:false,code:"READINESS_CHECK_FAILED" };
    }
  }));
  const ready = checks.every((check) => check.ready);
  return {
    service:"pension-assistant",
    status:ready ? "ready" : "not_ready",
    ready,
    qualification_source_bindings_sha256:String(environment.QUALIFICATION_SOURCE_BINDINGS_SHA256 || "") || null,
    qualification_run_id:String(environment.QUALIFICATION_RUN_ID || "") || null,
    qualification_context_key_sha256:environment.QUALIFICATION_CONTEXT_HMAC_KEY
      ? createHash("sha256").update(String(environment.QUALIFICATION_CONTEXT_HMAC_KEY)).digest("hex")
      : null,
    qualification_response_public_key_sha256:environment.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM
      ? createHash("sha256").update(String(environment.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM)).digest("hex")
      : null,
    checkedAt:new Date().toISOString(),
    checks
  };
}

export async function getReadiness({ force = false } = {}) {
  const ttl = Math.max(0, Number(process.env.READINESS_CACHE_TTL_MS || 5_000));
  if (!force && cachedReadiness && Date.now() - cachedAt < ttl) return cachedReadiness;
  if (!force && pendingReadiness) return pendingReadiness;
  pendingReadiness = evaluateReadiness().then((result) => {
    cachedReadiness = result;
    cachedAt = Date.now();
    return result;
  }).finally(() => { pendingReadiness = null; });
  return pendingReadiness;
}

export function resetReadinessCache() {
  cachedReadiness = null;
  cachedAt = 0;
  pendingReadiness = null;
}
