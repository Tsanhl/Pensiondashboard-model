import { resolve } from "node:path";

await import("../server/loadEnv.js");

// These controls are set before any retrieval/model service is imported.
process.env.DEBUG_LOG_INCLUDE_TEXT = "false";
process.env.DISABLE_DEBUG_LOGGING = "true";
process.env.DISABLE_RETRIEVAL_METRICS = "true";
process.env.ALLOW_DEGRADED_EMBEDDINGS = "false";
process.env.REQUIRE_CROSS_ENCODER_RERANK = "true";
process.env.LLM_CONTEXT_SOURCE_LIMIT = "3";
process.env.LLM_SOURCE_SNIPPET_CHARS = "800";
process.env.LOCAL_LLM_MAX_TOKENS = "400";
process.env.EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
process.env.RERANK_MODEL = "BAAI/bge-reranker-base";

const {
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_REGISTRY_ROOT,
  PROJECT_ROOT,
  executePreparedOneShot,
  prepareOneShotPreflight,
  warmPinnedModelPrefix,
} = await import("./lib/sealedUnseenOneShotV1.mjs");

function environment(name) {
  return String(process.env[name] || "").trim();
}

function safeBlocker(error) {
  const code = String(error?.code || "SEALED_ONE_SHOT_BLOCKED");
  return /^[A-Z0-9_]{3,80}$/.test(code) ? code : "SEALED_ONE_SHOT_BLOCKED";
}

try {
  const modelBaseUrl = environment("LOCAL_LLM_BASE_URL") || "http://127.0.0.1:8080";
  const embeddingBaseUrl = environment("EMBEDDING_SERVICE_URL") || "http://127.0.0.1:8090";
  const canonicalEndpoint = environment("SEALED_UNSEEN_CANONICAL_ENDPOINT");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(canonicalEndpoint) || environment("SEALED_UNSEEN_CUSTODIAN_MODE") !== "true") {
    throw Object.assign(new Error("SEALED_CUSTODIAN_RUNTIME_NOT_CONFIGURED"),{ code:"SEALED_CUSTODIAN_RUNTIME_NOT_CONFIGURED" });
  }
  process.env.LOCAL_LLM_BASE_URL = modelBaseUrl;
  process.env.EMBEDDING_SERVICE_URL = embeddingBaseUrl;
  process.env.RERANK_SERVICE_URL = embeddingBaseUrl;

  const preflight = await prepareOneShotPreflight({
    executionConfirmation:environment("SEALED_UNSEEN_EXECUTION_CONFIRMATION"),
    runLabel:environment("SEALED_UNSEEN_RUN_LABEL"),
    checkpointPath:environment("SEALED_UNSEEN_CHECKPOINT_PATH"),
    expectedCheckpointSha256:environment("SEALED_UNSEEN_CHECKPOINT_SHA256"),
    visibleGatePath:environment("SEALED_UNSEEN_VISIBLE_GATE_PATH"),
    expectedVisibleGateSha256:environment("SEALED_UNSEEN_VISIBLE_GATE_SHA256"),
    reviewApprovalPath:environment("SEALED_UNSEEN_REVIEW_APPROVAL_PATH"),
    expectedReviewApprovalSha256:environment("SEALED_UNSEEN_REVIEW_APPROVAL_SHA256"),
    expectedCodeBundleSha256:environment("SEALED_UNSEEN_CODE_BUNDLE_SHA256"),
    corpusManifestPath:environment("APPROVED_CORPUS_MANIFEST_PATH"),
    expectedCorpusManifestSha256:environment("APPROVED_CORPUS_MANIFEST_SHA256"),
    modelBaseUrl,
    embeddingBaseUrl,
    // This entry point is intentionally fixed to the original Cycle-v1 suite.
    suiteRoot:resolve(PROJECT_ROOT,"training/evaluation-cycle-v1/04-unseen"),
    outputRoot:DEFAULT_OUTPUT_ROOT,
    registryRoot:DEFAULT_REGISTRY_ROOT,
  });

  const canonicalReady = await fetch(`${canonicalEndpoint}/api/ready?force=1`,{ signal:AbortSignal.timeout(30_000) });
  const canonicalStatus = await canonicalReady.json().catch(() => null);
  if (!canonicalReady.ok || canonicalStatus?.ready !== true || !Array.isArray(canonicalStatus?.checks) || canonicalStatus.checks.some((check) => check.ready !== true)) {
    throw Object.assign(new Error("SEALED_CANONICAL_RUNTIME_NOT_READY"),{ code:"SEALED_CANONICAL_RUNTIME_NOT_READY" });
  }

  // Warm only the immutable system prefix before acquiring the irreversible
  // one-shot lock. No protected question, answer or evidence is loaded here.
  await warmPinnedModelPrefix({
    modelBaseUrl,
    modelId:preflight.checkpoint.modelId,
    expectedIdentity:preflight.checkpoint.expectedIdentity,
  });

  process.env.LOCAL_LLM_MODEL = preflight.checkpoint.expectedIdentity.id;
  process.env.LOCAL_LLM_EXPECTED_BASE_SHA256 = preflight.checkpoint.expectedIdentity.base_sha256;
  process.env.LOCAL_LLM_EXPECTED_ADAPTER_SHA256 = preflight.checkpoint.expectedIdentity.adapter_sha256;
  process.env.LOCAL_LLM_EXPECTED_ADAPTER_CONFIG_SHA256 = preflight.checkpoint.expectedIdentity.adapter_config_sha256;
  process.env.LOCAL_LLM_EXPECTED_CHECKPOINT_SHA256 = preflight.checkpoint.expectedIdentity.checkpoint_sha256;

  const { createSealedUnseenCaseRunner } = await import("./lib/sealedUnseenCaseRunnerV1.mjs");
  const runCase = await createSealedUnseenCaseRunner();
  const summary = await executePreparedOneShot({
    preflight,
    keyPath:environment("EVALUATION_SEAL_KEY_PATH"),
    runCase,
  });
  process.stdout.write(`${JSON.stringify(summary,null,2)}\n`);
  if (summary.overall_release_gate !== "PASS") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status:"BLOCKED",blocker:safeBlocker(error) })}\n`);
  process.exitCode = 1;
}
