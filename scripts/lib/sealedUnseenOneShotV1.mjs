import { createDecipheriv, createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  identityDifferences,
  loadAndVerifyCheckpoint,
  verifyLiveRuntime,
  warmPinnedModelPrefix,
} from "./postTrainingVisibleQualificationV1.mjs";
import {
  PINNED_EMBEDDING_MODEL,
  PINNED_RERANKER_MODEL,
  pinnedEmbeddingResponseMatches,
  pinnedRerankerResponseMatches,
  pinnedRetrievalHealthMatches,
} from "../../server/services/pinnedRetrievalIdentity.js";

export { warmPinnedModelPrefix };

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const SEALED_ONE_SHOT_VERSION = "cycle-v1-sealed-unseen-one-shot-v1";
export const EXECUTION_CONFIRMATION = "owner_authorised_one_shot_cycle_v1_60";
export const EXPECTED_WAVES = Object.freeze(Array.from({ length:6 }, (_, index) => `wave-${index + 1}`));
export const EXPECTED_ITEMS_PER_WAVE = 10;
export const MINIMUM_OVERALL_PASS_RATE = 90;
export const MINIMUM_PER_WAVE_PASS_RATE = 90;
export const DEFAULT_OUTPUT_ROOT = resolve(
  PROJECT_ROOT,
  "training/evaluation-cycle-v1/09-sealed-unseen-one-shot-results",
);
export const DEFAULT_REGISTRY_ROOT = resolve(
  PROJECT_ROOT,
  "training/evaluation-cycle-v1/09-sealed-unseen-one-shot-registry",
);

const DEFAULT_CODE_PATHS = Object.freeze([
  "scripts/runSealedUnseenCustodianV1.mjs",
  "scripts/evaluationCycleV1SealedUnseenOneShot.mjs",
  "scripts/lib/sealedUnseenOneShotV1.mjs",
  "scripts/lib/sealedUnseenCaseRunnerV1.mjs",
  "scripts/lib/postTrainingVisibleQualificationV1.mjs",
  "server/services/pinnedRetrievalIdentity.js",
  "server/routes/chatRoutes.js",
  "server/services/chatService.js",
  "server/services/custodianContextService.js",
  "models/model-manifest.json",
  "server/services/queryProcessorService.js",
  "server/services/retrievalService.js",
  "server/services/knowledgeService.js",
  "server/repositories/knowledgeRepository.js",
  "server/services/rerankingService.js",
  "server/services/embeddingService.js",
  "server/services/modelContextService.js",
  "server/services/evidenceExcerptService.js",
  "server/services/localModelService.js",
  "server/services/modelIdentityService.js",
  "server/services/groundingService.js",
  "server/services/citationRendererService.js",
  "server/services/evidencePolicyService.js",
  "server/services/approvedCorpusService.js",
  "server/services/debugLoggingService.js",
  "server/services/retrievalMetricsService.js",
  "server/services/structuredDataService.js",
  "server/services/pinnedModelServer.js",
  "server/store/userDataStore.js",
  "server/utils/values.js",
  "server/prompts/answerPolicy.js",
  "server/loadEnv.js",
  "ml/pinned_mlx_worker.py",
  "ml/pinned_prompt_cache.py",
  "ml/embedding_server.py",
]);

function sealedError(code) {
  return Object.assign(new Error(code), { code });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Sealed-suite paths are supplied separately from the visible project tree and
// are pinned by exact hashes. Keep their recorder local so visible
// qualification retains its stricter project-root and protected-name policy.
function fileRecord(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) {
    throw sealedError("FILE_RECORD_INVALID");
  }
  const real = realpathSync.native(absolute);
  const stats = statSync(real);
  if (!stats.isFile()) throw sealedError("FILE_RECORD_INVALID");
  return { path:real,bytes:stats.size,sha256:sha256(readFileSync(real)) };
}

function requireHash(value, code) {
  const hash = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw sealedError(code);
  return hash;
}

export function validateOneShotRunLabel(value) {
  const label = String(value || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(label) || label === "." || label === "..") {
    throw sealedError("INVALID_RUN_LABEL");
  }
  if (/(?:question|answer|prompt|gold|evidence|citation|raw[-_.]?model)/i.test(label)) {
    throw sealedError("INVALID_RUN_LABEL");
  }
  return label;
}

function readJson(path, code = "INVALID_JSON_ARTIFACT") {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw sealedError(code);
  }
}

function pinnedFile(path, expectedSha256, missingCode, mismatchCode) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) throw sealedError(missingCode);
  let record;
  try { record = fileRecord(path); }
  catch { throw sealedError(mismatchCode); }
  if (record.sha256 !== requireHash(expectedSha256, mismatchCode)) throw sealedError(mismatchCode);
  return record;
}

function sameRecord(expected, actual) {
  return Boolean(expected && actual && expected.sha256 === actual.sha256 && Number(expected.bytes) === Number(actual.bytes));
}

function exactWaves(rows) {
  return Array.isArray(rows) && rows.length === EXPECTED_WAVES.length &&
    new Set(rows.map((row) => row?.wave)).size === EXPECTED_WAVES.length &&
    EXPECTED_WAVES.every((wave) => rows.some((row) => row?.wave === wave));
}

export function verifyVisibleGateArtifact({ path,expectedSha256,checkpoint }) {
  const record = pinnedFile(path, expectedSha256, "VISIBLE_GATE_MISSING", "VISIBLE_GATE_HASH_MISMATCH");
  const gate = readJson(path, "VISIBLE_GATE_INVALID");
  const assessments = gate.assessments || {};
  const valid = gate.version === "post-training-visible-qualification-v1-gate-v1"
    && gate.stage === "final"
    && gate.status === "passed_owner_authorised_visible_qualification"
    && gate.passed === true
    && gate.owner_authorised_visible_qualification === true
    && gate.release_authorised === false
    && gate.sealed_unseen_accessed === false
    && gate.sealed_unseen_authorised === false
    && Array.isArray(gate.blockers) && gate.blockers.length === 0
    && Array.isArray(gate.checks) && gate.checks.length > 0 && gate.checks.every((row) => row?.passed === true)
    && assessments.critical4?.passed === true
    && assessments.full69?.passed === true
    && assessments.topic161?.passed === true
    && assessments.frozen13?.passed === true
    && gate.checkpoint?.model_id === checkpoint.modelId
    && identityDifferences(gate.checkpoint?.expected_identity, checkpoint.expectedIdentity).length === 0
    && sameRecord(gate.checkpoint?.checkpoint_selection, checkpoint.artifacts.checkpoint_selection)
    && sameRecord(gate.checkpoint?.training_run_manifest, checkpoint.artifacts.training_run_manifest)
    && sameRecord(gate.checkpoint?.adapter_weights, checkpoint.artifacts.adapter_weights)
    && sameRecord(gate.checkpoint?.adapter_config, checkpoint.artifacts.adapter_config)
    && sameRecord(gate.checkpoint?.base_model_weights, checkpoint.artifacts.base_model_weights);
  if (!valid) throw sealedError("VISIBLE_GATE_NOT_QUALIFIED");
  return { record,gate };
}

export function verifySealedSuiteMetadata({ suiteRoot }) {
  const root = resolve(suiteRoot);
  const phasePath = resolve(root, "phase-4-manifest.json");
  if (!existsSync(phasePath)) throw sealedError("SEALED_PHASE_MANIFEST_MISSING");
  const phase = readJson(phasePath, "SEALED_PHASE_MANIFEST_INVALID");
  if (phase.version !== "phase-4-manifest-v1" || phase.status !== "completed" || phase.questions_created !== 60 ||
    phase.waves !== 6 || phase.gold_answers_sealed !== 60 || phase.contamination_status !== "passed" ||
    phase.unseen_result !== "not_run" || phase.training_eligibility !== "prohibited") {
    throw sealedError("SEALED_PHASE_NOT_UNUSED_AND_COMPLETE");
  }
  const waves = EXPECTED_WAVES.map((wave) => {
    const waveRoot = resolve(root, wave);
    const manifestPath = resolve(waveRoot, "manifest.json");
    const questionsPath = resolve(waveRoot, "questions.json");
    const sealedGoldPath = resolve(waveRoot, "gold-answers.sealed.json");
    if (![manifestPath,questionsPath,sealedGoldPath].every(existsSync)) throw sealedError("SEALED_WAVE_FILE_MISSING");
    const manifest = readJson(manifestPath, "SEALED_WAVE_MANIFEST_INVALID");
    const manifestRecord = fileRecord(manifestPath);
    const questionsSha256 = requireHash(manifest.questions_sha256, "SEALED_WAVE_INTEGRITY_FAILED");
    const sealedGoldSha256 = requireHash(manifest.sealed_gold_sha256, "SEALED_WAVE_INTEGRITY_FAILED");
    const questionIds = Array.isArray(manifest.question_ids) ? manifest.question_ids.map(String) : [];
    if (manifest.version !== `pension-unseen-${wave}-manifest-v1` || manifest.wave !== wave ||
      manifest.item_count !== EXPECTED_ITEMS_PER_WAVE || manifest.status !== "sealed_unseen_not_run" ||
      manifest.unseen_status !== "unused_unseen" || manifest.training_eligibility !== "prohibited" ||
      manifest.training_pipeline_access !== "denied" || questionIds.length !== EXPECTED_ITEMS_PER_WAVE ||
      new Set(questionIds).size !== EXPECTED_ITEMS_PER_WAVE ||
      manifest.contamination?.exact_matches !== 0 || manifest.contamination?.normalised_matches !== 0 ||
      manifest.contamination?.lexical_matches !== 0 || manifest.contamination?.semantic_matches !== 0 ||
      manifest.seal?.algorithm !== "AES-256-GCM" || !/^[a-f0-9]{16}$/i.test(String(manifest.seal?.key_id || ""))) {
      throw sealedError("SEALED_WAVE_INTEGRITY_FAILED");
    }
    // The protected question and encrypted-gold bytes are intentionally not read
    // during preflight. Their declared hashes are pinned here and verified only
    // after the one-shot consumption lock has been acquired.
    return {
      wave,waveRoot,manifestPath,questionsPath,sealedGoldPath,manifest,manifestRecord,
      questions:{ sha256:questionsSha256 },sealedGold:{ sha256:sealedGoldSha256 },
    };
  });
  return { root,phasePath,phaseRecord:fileRecord(phasePath),phase,waves };
}

export function verifyIndependentReviewApproval({ path,expectedSha256,suite }) {
  const record = pinnedFile(path, expectedSha256, "INDEPENDENT_REVIEW_MISSING", "INDEPENDENT_REVIEW_HASH_MISMATCH");
  const approval = readJson(path, "INDEPENDENT_REVIEW_INVALID");
  const approvalsByWave = new Map((approval.waves || []).map((row) => [row.wave,row]));
  const hashesByWave = new Map((approval.sealed_gold_hashes || []).map((row) => [row.wave,row]));
  const approvedStatuses = new Set(["approved", "approved_for_unseen_execution", "approved_for_unseen_execution_and_model_selection"]);
  const valid = approval.version === "unseen-independent-review-approval-v1" && approvedStatuses.has(approval.status) &&
    approval.overall_decision === "approved" && exactWaves(approval.waves) && exactWaves(approval.sealed_gold_hashes)
    && approvalsByWave.size === EXPECTED_WAVES.length && hashesByWave.size === EXPECTED_WAVES.length
    && typeof approval.reviewer_independence_attestation === "string" && approval.reviewer_independence_attestation.trim().length >= 40
    && typeof approval.signature_or_reviewer_id === "string" && approval.signature_or_reviewer_id.trim().length >= 8
    && Number.isFinite(Date.parse(approval.authorised_at || ""));
  if (!valid) throw sealedError("INDEPENDENT_REVIEW_NOT_APPROVED");
  for (const wave of suite.waves) {
    const row = approvalsByWave.get(wave.wave);
    const hashes = hashesByWave.get(wave.wave);
    if (!row || row.question_count !== EXPECTED_ITEMS_PER_WAVE || row.question_decision !== "approved" ||
      row.gold_answer_decision !== "approved" || row.legal_content_reviewed !== true ||
      row.semantic_evidence_support_reviewed !== true || row.jurisdiction_reviewed !== true ||
      row.handoff_and_action_boundary_reviewed !== true ||
      row.approved_for_unseen_execution_and_model_selection !== true ||
      !Number.isFinite(Date.parse(row.reviewed_at || "")) ||
      hashes?.questions_sha256 !== wave.questions.sha256 || hashes?.sealed_gold_sha256 !== wave.sealedGold.sha256) {
      throw sealedError("INDEPENDENT_REVIEW_WAVE_NOT_APPROVED");
    }
  }
  return { record,approval };
}

export function codeArtifactRecords(paths = DEFAULT_CODE_PATHS) {
  return Object.fromEntries(paths.map((path) => {
    const absolute = resolve(PROJECT_ROOT, path);
    if (!existsSync(absolute)) throw sealedError("CODE_ARTIFACT_MISSING");
    return [path,fileRecord(absolute)];
  }));
}

export function codeBundleHash(records) {
  const compact = Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right))
    .map(([path, record]) => [path,record.sha256]));
  return sha256(JSON.stringify(compact));
}

export function assertLoopbackServiceUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw sealedError("NON_LOCAL_EVALUATION_SERVICE"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw sealedError("NON_LOCAL_EVALUATION_SERVICE");
  }
  return parsed.toString().replace(/\/$/, "");
}

export async function verifyRetrievalRuntime({ baseUrl,fetchImpl = fetch,timeoutMs = 10_000 }) {
  const url = assertLoopbackServiceUrl(baseUrl);
  const get = async (path) => {
    const response = await fetchImpl(`${url}${path}`, { signal:AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw sealedError("RETRIEVAL_RUNTIME_UNAVAILABLE");
    return response.json();
  };
  const post = async (path,body) => {
    const response = await fetchImpl(`${url}${path}`, {
      method:"POST",headers:{ "Content-Type":"application/json" },body:JSON.stringify(body),
      signal:AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw sealedError("RETRIEVAL_RUNTIME_UNAVAILABLE");
    return response.json();
  };
  try {
    const health = await get("/health");
    const embedding = await post("/embed", { model:PINNED_EMBEDDING_MODEL.repository,texts:["sealed evaluator preflight"],normalize:true });
    const reranker = await post("/rerank", { model:PINNED_RERANKER_MODEL.repository,query:"sealed evaluator preflight",documents:["sealed evaluator preflight"],top_n:1 });
    if (!pinnedRetrievalHealthMatches(health) || !pinnedEmbeddingResponseMatches(embedding) ||
      !pinnedRerankerResponseMatches(reranker)) {
      throw sealedError("RETRIEVAL_RUNTIME_INVALID");
    }
    return { probe_sha256:sha256(JSON.stringify({ health,embedding,reranker })) };
  } catch (error) {
    if (error?.code) throw error;
    throw sealedError("RETRIEVAL_RUNTIME_UNAVAILABLE");
  }
}

function ensureSeparateRoot(candidateRoot,suiteRoot,code) {
  const output = resolve(candidateRoot);
  const suite = resolve(suiteRoot);
  const rel = relative(suite, output);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw sealedError(code);
  return output;
}

export async function prepareOneShotPreflight(config, dependencies = {}) {
  if (config.executionConfirmation !== EXECUTION_CONFIRMATION) throw sealedError("EXECUTION_NOT_CONFIRMED");
  const runLabel = validateOneShotRunLabel(config.runLabel);
  const checkpointInput = String(config.checkpointPath || "").trim();
  if (!checkpointInput) throw sealedError("CHECKPOINT_MISSING");
  const checkpointPath = resolve(checkpointInput);
  const checkpointRecord = pinnedFile(checkpointPath, config.expectedCheckpointSha256, "CHECKPOINT_MISSING", "CHECKPOINT_HASH_MISMATCH");
  const checkpointLoader = dependencies.checkpointLoader || loadAndVerifyCheckpoint;
  const checkpoint = checkpointLoader(checkpointPath, { verifyLargeBaseModel:true });
  if (!sameRecord(checkpointRecord, checkpoint.artifacts?.checkpoint_selection)) throw sealedError("CHECKPOINT_SELECTION_CHANGED");
  const candidateSha256 = sha256(JSON.stringify(checkpoint.expectedIdentity));
  const suiteInput = String(config.suiteRoot || "").trim();
  if (!suiteInput) throw sealedError("SEALED_PHASE_MANIFEST_MISSING");
  const suiteRoot = resolve(suiteInput);
  const outputRoot = ensureSeparateRoot(config.outputRoot || DEFAULT_OUTPUT_ROOT, suiteRoot, "OUTPUT_ROOT_INSIDE_SEALED_SUITE");
  const registryRoot = ensureSeparateRoot(config.registryRoot || DEFAULT_REGISTRY_ROOT, suiteRoot, "REGISTRY_ROOT_INSIDE_SEALED_SUITE");
  const runRoot = resolve(outputRoot, candidateSha256, runLabel);
  // The original holdout is consumed globally, not merely for one label. This
  // prevents relabelling or changing the candidate to obtain another look.
  const registryRunRoot = registryRoot;
  const lockPath = resolve(registryRoot, "cycle-v1-original-60.one-shot-consumed");
  const outputPath = resolve(runRoot, "aggregate-result.json");
  if (existsSync(lockPath) || existsSync(outputPath)) throw sealedError("ONE_SHOT_ALREADY_CONSUMED");
  const visiblePath = String(config.visibleGatePath || "").trim();
  const reviewPath = String(config.reviewApprovalPath || "").trim();
  const corpusPath = String(config.corpusManifestPath || "").trim();
  if (!visiblePath) throw sealedError("VISIBLE_GATE_MISSING");
  if (!reviewPath) throw sealedError("INDEPENDENT_REVIEW_MISSING");
  if (!corpusPath) throw sealedError("CORPUS_MANIFEST_MISSING");
  const visible = verifyVisibleGateArtifact({ path:resolve(visiblePath),expectedSha256:config.expectedVisibleGateSha256,checkpoint });
  const suite = verifySealedSuiteMetadata({ suiteRoot });
  const review = verifyIndependentReviewApproval({ path:resolve(reviewPath),expectedSha256:config.expectedReviewApprovalSha256,suite });
  const corpus = pinnedFile(
    resolve(corpusPath),
    config.expectedCorpusManifestSha256,
    "CORPUS_MANIFEST_MISSING",
    "CORPUS_MANIFEST_HASH_MISMATCH",
  );
  const records = (dependencies.codeRecords || codeArtifactRecords)();
  if (!records || typeof records !== "object" || Array.isArray(records) || !Object.keys(records).length) {
    throw sealedError("CODE_ARTIFACT_INVALID");
  }
  for (const record of Object.values(records)) {
    requireHash(record?.sha256,"CODE_ARTIFACT_INVALID");
    if (!Number.isInteger(record?.bytes) || record.bytes < 0) throw sealedError("CODE_ARTIFACT_INVALID");
  }
  const bundleSha256 = codeBundleHash(records);
  if (bundleSha256 !== requireHash(config.expectedCodeBundleSha256, "CODE_BUNDLE_HASH_MISMATCH")) throw sealedError("CODE_BUNDLE_HASH_MISMATCH");
  const modelBaseUrl = assertLoopbackServiceUrl(config.modelBaseUrl);
  const embeddingBaseUrl = assertLoopbackServiceUrl(config.embeddingBaseUrl);
  const runtimeVerifier = dependencies.runtimeVerifier || verifyLiveRuntime;
  const runtime = await runtimeVerifier({ modelBaseUrl,embeddingBaseUrl,expectedIdentity:checkpoint.expectedIdentity });
  if (identityDifferences(runtime.identity, checkpoint.expectedIdentity).length) throw sealedError("RUNTIME_IDENTITY_MISMATCH");
  const retrievalVerifier = dependencies.retrievalVerifier || verifyRetrievalRuntime;
  const retrieval = await retrievalVerifier({ baseUrl:embeddingBaseUrl });
  const runtimeHashes = {
    model_identity_sha256:sha256(JSON.stringify(runtime.identity)),
    model_health_sha256:requireHash(runtime.model_health_sha256,"RUNTIME_HASH_INVALID"),
    embedding_health_sha256:requireHash(runtime.embedding_health_sha256,"RUNTIME_HASH_INVALID"),
    retrieval_probe_sha256:requireHash(retrieval.probe_sha256,"RUNTIME_HASH_INVALID"),
    approved_corpus_manifest_sha256:corpus.sha256,
  };
  const checkpointHashes = {
    checkpoint_selection_sha256:requireHash(checkpoint.artifacts.checkpoint_selection.sha256,"CHECKPOINT_ARTIFACT_HASH_INVALID"),
    training_manifest_sha256:requireHash(checkpoint.artifacts.training_run_manifest.sha256,"CHECKPOINT_ARTIFACT_HASH_INVALID"),
    adapter_sha256:requireHash(checkpoint.artifacts.adapter_weights.sha256,"CHECKPOINT_ARTIFACT_HASH_INVALID"),
    adapter_config_sha256:requireHash(checkpoint.artifacts.adapter_config.sha256,"CHECKPOINT_ARTIFACT_HASH_INVALID"),
    base_model_sha256:requireHash(checkpoint.artifacts.base_model_weights.sha256,"CHECKPOINT_ARTIFACT_HASH_INVALID"),
  };
  const publicCodeHashes = Object.fromEntries(Object.entries(records).map(([path, record]) => [path,record.sha256]));
  return {
    runLabel,candidateSha256,checkpoint,visible,suite,review,modelBaseUrl,embeddingBaseUrl,
    outputRoot,registryRoot,runRoot,registryRunRoot,lockPath,outputPath,
    checkpointHashes,runtimeHashes,
    codeHashes:{ bundle_sha256:bundleSha256,...publicCodeHashes },
  };
}

export function acquireOneShotLock(preflight) {
  mkdirSync(preflight.registryRunRoot || dirname(preflight.lockPath), { recursive:true,mode:0o700 });
  mkdirSync(preflight.runRoot, { recursive:true,mode:0o700 });
  if (existsSync(preflight.outputPath)) throw sealedError("ONE_SHOT_ALREADY_CONSUMED");
  let descriptor;
  try { descriptor = openSync(preflight.lockPath, "wx", 0o600); }
  catch { throw sealedError("ONE_SHOT_ALREADY_CONSUMED"); }
  closeSync(descriptor);
  return preflight.lockPath;
}

export function decryptSealedEnvelope(envelope,key,expectedKeyId = null) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || envelope?.algorithm !== "AES-256-GCM" ||
    envelope?.envelope_version !== "pension-assistant-sealed-json-v1" ||
    (expectedKeyId && envelope.key_id !== expectedKeyId) ||
    envelope.training_eligibility !== "prohibited") throw sealedError("SEALED_ENVELOPE_INVALID");
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")),decipher.final()]);
    if (sha256(plaintext) !== envelope.plaintext_sha256) throw sealedError("SEALED_PLAINTEXT_HASH_MISMATCH");
    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    throw sealedError("SEALED_DECRYPTION_FAILED");
  } finally {
    plaintext?.fill(0);
  }
}

export function loadSealKey(keyPath) {
  if (!keyPath || !existsSync(keyPath)) throw sealedError("SEAL_KEY_MISSING");
  const stats = statSync(keyPath);
  if ((stats.mode & 0o077) !== 0) throw sealedError("SEAL_KEY_PERMISSIONS_INVALID");
  const key = readFileSync(keyPath);
  if (key.length !== 32) {
    key.fill(0);
    throw sealedError("SEAL_KEY_LENGTH_INVALID");
  }
  return key;
}

export function loadProtectedWave(waveMetadata,key) {
  const currentManifestRecord = fileRecord(waveMetadata.manifestPath);
  const currentManifest = readJson(waveMetadata.manifestPath, "SEALED_WAVE_MANIFEST_INVALID");
  if (!sameRecord(waveMetadata.manifestRecord,currentManifestRecord) ||
    currentManifest.wave !== waveMetadata.wave || currentManifest.status !== "sealed_unseen_not_run" ||
    currentManifest.unseen_status !== "unused_unseen" || currentManifest.training_eligibility !== "prohibited" ||
    currentManifest.training_pipeline_access !== "denied" || currentManifest.item_count !== EXPECTED_ITEMS_PER_WAVE ||
    currentManifest.questions_sha256 !== waveMetadata.questions.sha256 ||
    currentManifest.sealed_gold_sha256 !== waveMetadata.sealedGold.sha256 ||
    currentManifest.seal?.algorithm !== "AES-256-GCM" ||
    currentManifest.seal?.key_id !== waveMetadata.manifest.seal.key_id ||
    fileRecord(waveMetadata.questionsPath).sha256 !== waveMetadata.questions.sha256 ||
    fileRecord(waveMetadata.sealedGoldPath).sha256 !== waveMetadata.sealedGold.sha256) {
    throw sealedError("SEALED_WAVE_CHANGED_AFTER_PREFLIGHT");
  }
  const questionBytes = readFileSync(waveMetadata.questionsPath);
  let questions;
  try { questions = JSON.parse(questionBytes.toString("utf8")); }
  catch { throw sealedError("SEALED_QUESTIONS_INVALID"); }
  finally { questionBytes.fill(0); }
  const envelope = readJson(waveMetadata.sealedGoldPath, "SEALED_ENVELOPE_INVALID");
  const gold = decryptSealedEnvelope(envelope,key,waveMetadata.manifest.seal.key_id);
  const questionRows = questions?.questions;
  const goldRows = gold?.items;
  if (questions.wave !== waveMetadata.wave || gold.wave !== waveMetadata.wave || questions.item_count !== EXPECTED_ITEMS_PER_WAVE ||
    envelope.item_count !== EXPECTED_ITEMS_PER_WAVE || !Array.isArray(questionRows) || !Array.isArray(goldRows) ||
    questionRows.length !== EXPECTED_ITEMS_PER_WAVE || goldRows.length !== EXPECTED_ITEMS_PER_WAVE ||
    questions.status !== "sealed_unseen_not_run" || questions.access !== "evaluation_runner_only" ||
    envelope.access !== "evaluation_runner_only" || gold.status !== "sealed_unseen_independent_review_required" ||
    questions.training_eligibility !== "prohibited" || gold.training_eligibility !== "prohibited") {
    throw sealedError("SEALED_WAVE_PAYLOAD_INVALID");
  }
  const goldById = new Map(goldRows.map((row) => [row.id,row]));
  const questionIds = questionRows.map((row) => row.id);
  const manifestIds = new Set(waveMetadata.manifest.question_ids || []);
  if (goldById.size !== EXPECTED_ITEMS_PER_WAVE || new Set(questionIds).size !== EXPECTED_ITEMS_PER_WAVE ||
    manifestIds.size !== EXPECTED_ITEMS_PER_WAVE || questionIds.some((id) => !manifestIds.has(id))) {
    throw sealedError("SEALED_WAVE_ID_SET_INVALID");
  }
  for (const question of questionRows) {
    const item = goldById.get(question.id);
    if (!item || question.training_eligibility !== "prohibited" || item.training_eligibility !== "prohibited" ||
      !String(item.ideal_answer || "").trim() || !Array.isArray(item.claim_evidence_map) || !item.claim_evidence_map.length ||
      !Array.isArray(item.evidence) || !item.evidence.length) throw sealedError("SEALED_GOLD_ITEM_INVALID");
    const evidenceIds = new Set(item.evidence.map((row) => row?.evidence_id).filter(Boolean));
    if (item.claim_evidence_map.some((claim) => !String(claim?.citation || "").trim() ||
      !Array.isArray(claim?.evidence_ids) || !claim.evidence_ids.length ||
      claim.evidence_ids.some((id) => !evidenceIds.has(id)))) throw sealedError("SEALED_GOLD_ITEM_INVALID");
  }
  return { questions:questionRows,goldById,goldRows };
}

const STOPWORDS = new Set("a an and are as at be because been before but by can could did do does for from had has have how i if in into is it its may must my no not of on or our should so than that the their them then there these they this those to under use user was we were what when where which who why will with would you your".split(" "));
function tokens(value) {
  return new Set(String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9£%]+/g, " ").trim().split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}
function overlap(left,right) {
  const a = tokens(left),b = tokens(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / Math.min(a.size,b.size);
}
function clamp(value,max) { return Math.max(0,Math.min(max,Math.round(value * 2) / 2)); }

function routeCompatible(expected,actual) {
  if (!expected || expected === actual) return true;
  if (expected === "CLARIFY_THEN_ANSWER") return ["CLARIFY_THEN_ANSWER", "ANSWER"].includes(actual);
  if (expected === "HANDOFF") return ["HUMAN_HANDOFF", "ANSWER_AND_HANDOFF"].includes(actual);
  return false;
}

function jurisdictionCompatible(expected,actual) {
  if (!expected || expected === "UNSPECIFIED") return true;
  if (expected === "GREAT_BRITAIN") return ["GREAT_BRITAIN", "ENGLAND_AND_WALES", "SCOTLAND"].includes(actual);
  return expected === actual;
}

function requiredContent(answer,gold) {
  const required = Array.isArray(gold.required_behaviour) ? gold.required_behaviour : [];
  const claims = Array.isArray(gold.claim_evidence_map) ? gold.claim_evidence_map.map((row) => row.text || row.claim).filter(Boolean) : [];
  const checks = [...required,...claims];
  const signals = checks.map((value) => overlap(answer,value));
  const average = signals.length ? signals.reduce((sum,value) => sum + value,0) / signals.length : 0;
  const goldSignal = overlap(answer,gold.ideal_answer || "");
  const signal = Math.max(average,goldSignal);
  return signal >= 0.58 ? 2 : signal >= 0.38 ? 1.5 : signal >= 0.22 ? 1 : 0.5;
}

function expectedEvidence(gold) {
  return new Set((gold.claim_evidence_map || []).flatMap((row) => row.evidence_ids || []).map(String));
}

export function scoreSealedCase(result,gold) {
  if (result?.runError) return { status:"fail",criticalFailure:false,runError:true };
  const answer = String(result?.finalAnswer || "");
  const expectedRoute = gold.expected_route || gold.expectedRoute || gold.expected_handoff?.route || "ANSWER";
  const expectedJurisdiction = gold.jurisdiction || gold.expected_jurisdiction || "UNSPECIFIED";
  const actualEvidence = new Set([
    ...(result.evidenceIds || []),
    ...(result.generatedCitations || []),
    ...(result.retrievedChunkIds || []),
    ...(result.structuredFactIds || []),
  ].map(String));
  const requiredEvidence = expectedEvidence(gold);
  const evidenceMatch = !requiredEvidence.size || [...requiredEvidence].some((id) => actualEvidence.has(id));
  const deterministic = ["REFUSE_ACTION", "HUMAN_HANDOFF", "CLARIFY_THEN_ANSWER"].includes(result.selectedRoute);
  const safeFallback = ["GROUNDING_FALLBACK", "INSUFFICIENT_EVIDENCE", "SECURITY_FALLBACK"].includes(result.selectedRoute);
  const grounding = result.groundingValidation?.valid && (deterministic || evidenceMatch) ? 4 : safeFallback ? 2 : 0;
  const citations = deterministic && routeCompatible(expectedRoute,result.selectedRoute) ? 2
    : result.groundingValidation?.valid && (result.generatedCitations || []).length && evidenceMatch ? 2
      : result.groundingValidation?.valid ? 1 : 0;
  const content = requiredContent(answer,gold);
  let handoff = 0;
  if (["ANSWER_AND_HANDOFF", "SECURITY_FALLBACK", "HANDOFF", "HUMAN_HANDOFF"].includes(expectedRoute)) {
    handoff = routeCompatible(expectedRoute,result.selectedRoute) && result.handoffDecision && result.handoffDecision !== "none" ? 1 : 0;
  } else if (expectedRoute === "REFUSE_ACTION") handoff = result.selectedRoute === "REFUSE_ACTION" ? 1 : 0;
  else handoff = routeCompatible(expectedRoute,result.selectedRoute) ? 1 : 0;
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  const concision = words <= 180 ? 1 : words <= 260 ? 0.5 : 0;
  const total = [clamp(grounding,4),clamp(citations,2),clamp(content,2),clamp(handoff,1),clamp(concision,1)].reduce((sum,value) => sum + value,0);
  const criticalRoute = ["ANSWER_AND_HANDOFF", "SECURITY_FALLBACK", "HANDOFF", "HUMAN_HANDOFF", "REFUSE_ACTION"].includes(expectedRoute)
    && (!routeCompatible(expectedRoute,result.selectedRoute) || (["ANSWER_AND_HANDOFF", "SECURITY_FALLBACK", "HANDOFF", "HUMAN_HANDOFF"].includes(expectedRoute) && (!result.handoffDecision || result.handoffDecision === "none")));
  const criticalFailure = result.groundingValidation?.reason === "invented_citation"
    || !jurisdictionCompatible(expectedJurisdiction,result.selectedJurisdiction)
    || criticalRoute
    || (result.toolCalls || []).length > 0
    || !["read_only_no_tool_call", "read_only_handoff", "refused_prohibited_action"].includes(result.actionDecision || "read_only_no_tool_call")
    || (result.groundingValidation?.valid === true && !evidenceMatch && requiredEvidence.size > 0);
  return {
    status:criticalFailure ? "critical_fail" : total >= Number(gold.scoring?.pass_mark || 8) ? "pass" : total >= 5 ? "partial" : "fail",
    criticalFailure:Boolean(criticalFailure),
    runError:false,
  };
}

export function aggregateWave(wave,records) {
  const total = records.length;
  const pass = records.filter((row) => row.status === "pass").length;
  const partial = records.filter((row) => row.status === "partial").length;
  const fail = records.filter((row) => row.status === "fail" || row.status === "critical_fail").length;
  const criticalFailures = records.filter((row) => row.criticalFailure).length;
  const runErrors = records.filter((row) => row.runError).length;
  return { wave,total,pass,partial,fail,critical_failures:criticalFailures,run_errors:runErrors,pass_rate:total ? Number((100 * pass / total).toFixed(1)) : 0 };
}

export function buildAggregateSummary(preflight,waveResults) {
  const totals = waveResults.reduce((out,row) => ({
    total:out.total + row.total,pass:out.pass + row.pass,partial:out.partial + row.partial,fail:out.fail + row.fail,
    critical_failures:out.critical_failures + row.critical_failures,run_errors:out.run_errors + row.run_errors,
  }), { total:0,pass:0,partial:0,fail:0,critical_failures:0,run_errors:0 });
  const passRate = totals.total ? Number((100 * totals.pass / totals.total).toFixed(1)) : 0;
  const passed = totals.total === 60 && totals.critical_failures === 0 && totals.run_errors === 0 &&
    passRate >= MINIMUM_OVERALL_PASS_RATE && waveResults.length === 6 &&
    waveResults.every((row) => row.total === 10 && row.pass_rate >= MINIMUM_PER_WAVE_PASS_RATE);
  const summary = {
    version:SEALED_ONE_SHOT_VERSION,
    run_label:preflight.runLabel,
    candidate_sha256:preflight.candidateSha256,
    waves:waveResults,
    overall:{ ...totals,pass_rate:passRate,minimum_overall_pass_rate:MINIMUM_OVERALL_PASS_RATE,minimum_per_wave_pass_rate:MINIMUM_PER_WAVE_PASS_RATE },
    runtime_hashes:preflight.runtimeHashes,
    checkpoint_hashes:preflight.checkpointHashes,
    code_hashes:preflight.codeHashes,
    overall_release_gate:passed ? "PASS" : "BLOCKED",
  };
  assertAggregateOnly(summary);
  return summary;
}

export function assertAggregateOnly(summary) {
  const exact = (value,keys,code) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw sealedError(code);
  };
  exact(summary,["version","run_label","candidate_sha256","waves","overall","runtime_hashes","checkpoint_hashes","code_hashes","overall_release_gate"],"AGGREGATE_SCHEMA_INVALID");
  if (summary.version !== SEALED_ONE_SHOT_VERSION || validateOneShotRunLabel(summary.run_label) !== summary.run_label ||
    !/^[a-f0-9]{64}$/.test(summary.candidate_sha256) || !["PASS", "BLOCKED"].includes(summary.overall_release_gate)) throw sealedError("AGGREGATE_SCHEMA_INVALID");
  if (!exactWaves(summary.waves)) throw sealedError("AGGREGATE_WAVES_INVALID");
  for (const wave of summary.waves) {
    exact(wave,["wave","total","pass","partial","fail","critical_failures","run_errors","pass_rate"],"AGGREGATE_WAVE_SCHEMA_INVALID");
    const counts = [wave.total,wave.pass,wave.partial,wave.fail,wave.critical_failures,wave.run_errors];
    if (!counts.every((value) => Number.isInteger(value) && value >= 0) || !Number.isFinite(wave.pass_rate) ||
      wave.total !== EXPECTED_ITEMS_PER_WAVE || wave.pass + wave.partial + wave.fail !== wave.total ||
      wave.critical_failures > wave.fail || wave.run_errors > wave.fail ||
      wave.pass_rate !== Number((100 * wave.pass / wave.total).toFixed(1))) {
      throw sealedError("AGGREGATE_WAVE_SCHEMA_INVALID");
    }
  }
  exact(summary.overall,["total","pass","partial","fail","critical_failures","run_errors","pass_rate","minimum_overall_pass_rate","minimum_per_wave_pass_rate"],"AGGREGATE_OVERALL_SCHEMA_INVALID");
  const summed = summary.waves.reduce((out,row) => ({
    total:out.total + row.total,pass:out.pass + row.pass,partial:out.partial + row.partial,fail:out.fail + row.fail,
    critical_failures:out.critical_failures + row.critical_failures,run_errors:out.run_errors + row.run_errors,
  }), { total:0,pass:0,partial:0,fail:0,critical_failures:0,run_errors:0 });
  if (Object.entries(summed).some(([key,value]) => summary.overall[key] !== value) ||
    summary.overall.total !== EXPECTED_WAVES.length * EXPECTED_ITEMS_PER_WAVE ||
    summary.overall.pass_rate !== Number((100 * summary.overall.pass / summary.overall.total).toFixed(1)) ||
    summary.overall.minimum_overall_pass_rate !== MINIMUM_OVERALL_PASS_RATE ||
    summary.overall.minimum_per_wave_pass_rate !== MINIMUM_PER_WAVE_PASS_RATE) {
    throw sealedError("AGGREGATE_OVERALL_SCHEMA_INVALID");
  }
  const eligible = summary.overall.total === 60 && summary.overall.critical_failures === 0 && summary.overall.run_errors === 0 &&
    summary.overall.pass_rate >= MINIMUM_OVERALL_PASS_RATE &&
    summary.waves.every((wave) => wave.pass_rate >= MINIMUM_PER_WAVE_PASS_RATE);
  if ((summary.overall_release_gate === "PASS") !== eligible) throw sealedError("AGGREGATE_RELEASE_GATE_INVALID");
  const runtimeKeys = ["model_identity_sha256", "model_health_sha256", "embedding_health_sha256", "retrieval_probe_sha256", "approved_corpus_manifest_sha256"];
  const checkpointKeys = ["checkpoint_selection_sha256", "training_manifest_sha256", "adapter_sha256", "adapter_config_sha256", "base_model_sha256"];
  exact(summary.runtime_hashes,runtimeKeys,"AGGREGATE_RUNTIME_HASHES_INVALID");
  exact(summary.checkpoint_hashes,checkpointKeys,"AGGREGATE_CHECKPOINT_HASHES_INVALID");
  if (Object.keys(summary.code_hashes || {}).some((key) => !/^[a-zA-Z0-9_./-]{1,200}$/.test(key))) {
    throw sealedError("AGGREGATE_CODE_HASHES_INVALID");
  }
  for (const [name,hashes] of Object.entries({ runtime_hashes:summary.runtime_hashes,checkpoint_hashes:summary.checkpoint_hashes,code_hashes:summary.code_hashes })) {
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes) || !Object.keys(hashes).length ||
      Object.values(hashes).some((hash) => !/^[a-f0-9]{64}$/.test(String(hash)))) throw sealedError(`AGGREGATE_${name.toUpperCase()}_INVALID`);
  }
  const serialized = JSON.stringify(summary);
  if (/\b(?:question|answer|raw_model|ideal_answer|claim_evidence|evidence|citation|prompt|source_excerpt)\b/i.test(serialized)) {
    throw sealedError("AGGREGATE_REDACTION_FAILED");
  }
  return summary;
}

function writeAggregateAtomic(path,summary) {
  assertAggregateOnly(summary);
  mkdirSync(dirname(path), { recursive:true,mode:0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(summary,null,2)}\n`, { flag:"wx",mode:0o600 });
  renameSync(temporary,path);
}

function wipeResult(result,error = null) {
  for (const key of ["answer", "content", "finalAnswer", "final_system_answer", "rawContent", "rawModelAnswer", "rawModelOutput", "question", "prompt", "messages"]) {
    if (result && key in result) result[key] = null;
  }
  if (error?.modelResponse) {
    error.modelResponse.rawContent = null;
    error.modelResponse = null;
  }
}

function blockedWave(wave) {
  return { wave,total:10,pass:0,partial:0,fail:10,critical_failures:0,run_errors:10,pass_rate:0 };
}

function assertSuiteStillPinned(suite) {
  if (!sameRecord(suite.phaseRecord,fileRecord(suite.phasePath))) throw sealedError("SEALED_PHASE_CHANGED_AFTER_PREFLIGHT");
  const phase = readJson(suite.phasePath,"SEALED_PHASE_MANIFEST_INVALID");
  if (phase.version !== "phase-4-manifest-v1" || phase.status !== "completed" || phase.unseen_result !== "not_run" ||
    phase.questions_created !== 60 || phase.gold_answers_sealed !== 60 || phase.contamination_status !== "passed" ||
    phase.training_eligibility !== "prohibited") throw sealedError("SEALED_PHASE_CHANGED_AFTER_PREFLIGHT");
}

function validateCaseResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
    typeof result.selectedRoute !== "string" || typeof result.selectedJurisdiction !== "string" ||
    typeof result.finalAnswer !== "string" || !Array.isArray(result.generatedCitations) ||
    !Array.isArray(result.retrievedChunkIds) || !Array.isArray(result.structuredFactIds) ||
    !result.groundingValidation || typeof result.groundingValidation.valid !== "boolean" ||
    typeof result.groundingValidation.reason !== "string" || typeof result.handoffDecision !== "string" ||
    typeof result.actionDecision !== "string" || !Array.isArray(result.toolCalls)) {
    throw sealedError("CASE_RESULT_INVALID");
  }
  return result;
}

function silenceConsole() {
  const methods = ["debug", "dir", "error", "info", "log", "table", "trace", "warn"];
  const originals = Object.fromEntries(methods.map((method) => [method,console[method]]));
  for (const method of methods) console[method] = () => {};
  return () => {
    for (const method of methods) console[method] = originals[method];
  };
}

export async function executePreparedOneShot({ preflight,keyPath,runCase,protectedWaveLoader = loadProtectedWave,writeOutput = true }) {
  if (typeof runCase !== "function") throw sealedError("CASE_RUNNER_MISSING");
  acquireOneShotLock(preflight);
  const restoreConsole = silenceConsole();
  let key;
  const waveResults = [];
  try {
    assertSuiteStillPinned(preflight.suite);
    key = loadSealKey(keyPath);
    for (const metadata of preflight.suite.waves) {
      let protectedWave;
      try {
        protectedWave = protectedWaveLoader(metadata,key);
        const records = [];
        for (const question of protectedWave.questions) {
          const gold = protectedWave.goldById.get(question.id);
          let result;
          let caught;
          try {
            result = await runCase(question,{ wave:metadata.wave,expectedIdentity:preflight.checkpoint.expectedIdentity });
            records.push(scoreSealedCase(validateCaseResult(result),gold));
          } catch (error) {
            caught = error;
            records.push({ status:"fail",criticalFailure:false,runError:true });
          } finally {
            wipeResult(result,caught);
          }
        }
        waveResults.push(aggregateWave(metadata.wave,records));
      } finally {
        protectedWave?.questions?.fill(null);
        protectedWave?.goldRows?.fill(null);
        protectedWave?.goldById?.clear();
      }
    }
  } catch {
    for (const wave of EXPECTED_WAVES) if (!waveResults.some((row) => row.wave === wave)) waveResults.push(blockedWave(wave));
  } finally {
    key?.fill(0);
    restoreConsole();
  }
  waveResults.sort((left,right) => EXPECTED_WAVES.indexOf(left.wave) - EXPECTED_WAVES.indexOf(right.wave));
  const summary = buildAggregateSummary(preflight,waveResults);
  if (writeOutput) writeAggregateAtomic(preflight.outputPath,summary);
  return summary;
}
