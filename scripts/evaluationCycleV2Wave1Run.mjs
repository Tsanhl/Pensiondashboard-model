import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertModelIdentity } from "../server/services/modelIdentityService.js";
import { buildModelContext } from "../server/services/modelContextService.js";
import { mintQualificationRequestCapability } from "../server/services/qualificationContextService.js";
import { persistServedResponseReceipt } from "./lib/servedResponseReceipt.mjs";
import { atomicWrite, createExclusive, durableMkdir, fsyncDirectory } from "./lib/qualification-worker/utils.mjs";

await import("../server/loadEnv.js");
const [{ initialiseDataStore }, queryModule, retrievalModule, modelModule, grounding, policy, citationRenderer] = await Promise.all([
  import("../server/store/userDataStore.js"),
  import("../server/services/queryProcessorService.js"),
  import("../server/services/retrievalService.js"),
  import("../server/services/localModelService.js"),
  import("../server/services/groundingService.js"),
  import("../server/prompts/answerPolicy.js"),
  import("../server/services/citationRendererService.js"),
]);
const { evidencePolicyResponse } = await import("../server/services/evidencePolicyService.js");

const { processQuery } = queryModule;
const { retrieveForQuery } = retrievalModule;
const { generateLocalAnswerWithRetry, localModelStatus } = modelModule;
const { SAFE_TEMPLATES, publicSources, validateGroundedAnswer } = grounding;
const { ANSWER_POLICY_VERSION, ANSWER_SYSTEM_POLICY } = policy;
const { renderCitationMarkers } = citationRenderer;
const { selectModelSources } = await import("../server/services/chatService.js");

const PROJECT_ROOT = resolve(".");
const CYCLE_ROOT = resolve("training/evaluation-cycle-v2");
const PACK_ROOT = resolve(process.env.CYCLE_V2_PACK_ROOT || resolve(CYCLE_ROOT, "01-question-set-review-revision-v2"));
const WAVE = String(process.env.CYCLE_V2_WAVE || "wave-1").replace(/[^a-zA-Z0-9_-]/g, "-");
const WAVE_NUMBER = WAVE.match(/(\d+)/)?.[1] || "1";
const EXECUTION_ROOT = resolve(CYCLE_ROOT, `02-${WAVE}-execution`);
const PREFLIGHT_PATH = resolve(EXECUTION_ROOT, "preflight.json");
const CHECKPOINT_PATH = resolve(process.env.CYCLE_V2_CHECKPOINT_PATH || "training/evaluation-cycle-v1/05-training-runs/pension-assistant-v1-targeted-behaviour/checkpoint-selection.json");
const PARTITION = String(process.env.CYCLE_V2_PARTITION || process.env.CYCLE_V2_WAVE1_PARTITION || "diagnostic").toLowerCase();
const RUN_LABEL = String(process.env.CYCLE_V2_RUN_LABEL || process.env.CYCLE_V2_WAVE1_RUN_LABEL || `${PARTITION}-step68-v1`).replace(/[^a-zA-Z0-9._-]/g, "-");
const OUTPUT_ROOT = resolve(EXECUTION_ROOT, PARTITION, RUN_LABEL);
const RESULTS_PATH = resolve(OUTPUT_ROOT, "results.json");
const MANIFEST_PATH = resolve(OUTPUT_ROOT, "run-manifest.json");
const ATTEMPT_LEDGER_PATH = resolve(OUTPUT_ROOT, "generation-attempt-ledger.jsonl");
const GENERATION_CONFIG = Object.freeze({
  temperature:Number(process.env.LOCAL_LLM_TEMPERATURE ?? 0),
  topP:Number(process.env.LOCAL_LLM_TOP_P ?? 1),
  maxTokens:Number(process.env.LOCAL_LLM_MAX_TOKENS || 320),
  seed:Number(process.env.LOCAL_LLM_SEED ?? 42),
});
const MODEL_CONTEXT_CONFIG = Object.freeze({
  sourceLimit: Math.max(1, Number(process.env.LLM_CONTEXT_SOURCE_LIMIT || 6)),
  sourceSnippetChars: Math.max(200, Number(process.env.LLM_SOURCE_SNIPPET_CHARS || 1800)),
  contextLimitTokens:Math.max(1,Number(process.env.LOCAL_LLM_CONTEXT_TOKENS || 8192)),
});
const USER_ID = `evaluation-cycle-v2-${WAVE}-${PARTITION}`;
const QUALIFICATION_CHAT_ENDPOINT = String(process.env.QUALIFICATION_CANONICAL_CHAT_ENDPOINT || "").replace(/\/$/,"");
const QUALIFICATION_RUNTIME_MODE = String(process.env.QUALIFICATION_RUNTIME_MODE || "false").toLowerCase() === "true";

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function hashFile(path) { return sha256(readFileSync(path)); }
function writeJson(path, value) { atomicWrite(path,value); }
function writeText(path, value) { atomicWrite(path,String(value)); }
function now() { return new Date().toISOString(); }
function countBy(values) { return values.reduce((out, value) => ({ ...out, [String(value)]: (out[String(value)] || 0) + 1 }), {}); }
function git(args, fallback = null) { try { return execFileSync("git", args, { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return fallback; } }
async function healthJson(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(Number(process.env.EVALUATION_HEALTH_TIMEOUT_MS || 5_000)) }); return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) }; } catch (error) { return { ok: false, status: null, error: error.message }; } }

function loadQuestions() {
  if (PARTITION === "diagnostic") {
    const path = resolve(PACK_ROOT, `${WAVE}/development-question-set.json`);
    const payload = readJson(path);
    return { path, payload, questions: payload.topics.flatMap((topic) => topic.diagnostic_evaluation.map((item) => ({ ...item, topic_id: topic.topic_id }))) };
  }
  if (PARTITION === "unseen") {
    const path = resolve(PACK_ROOT, `${WAVE}/unseen-question-set.json`);
    const payload = readJson(path);
    return { path, payload, questions: payload.topics.flatMap((topic) => topic.questions.map((item) => ({ ...item, topic_id: topic.topic_id }))) };
  }
  throw new Error("CYCLE_V2_PARTITION must be diagnostic or unseen.");
}

function publicOnlyPlan(query) {
  const personalScopes = new Set(["USER_PORTFOLIO", "USER_DOCUMENTS"]);
  const personalLookups = new Set(["account", "charges", "document_status", "projection", "investment_profile"]);
  return { ...query, source_scopes: query.source_scopes.filter((scope) => !personalScopes.has(scope)), structured_lookups: query.structured_lookups.filter((lookup) => !personalLookups.has(lookup)) };
}

function skeleton(item, modelVersion) {
  return {
    question_id: item.id, topic_id: item.topic_id, question: item.question, construct_id: item.construct_id,
    model_version: modelVersion, raw_model_answer: null, raw_model_output: null, final_system_answer: null,
    selected_jurisdiction: "UNSPECIFIED", selected_route: null, retrieved_chunk_ids: [], structured_fact_ids: [],
    generated_citations: [], claim_citations: [], review_answer: null, final_public_sources: [], handoff_decision: "none", action_or_tool_decision: "read_only_no_tool_call",
    latency_ms: 0, model_call_attempted: false, token_usage: {}, run_timestamp: now(), retrieval_trace: null, grounding_validation: null,
    training_eligibility: "prohibited", official_scoring_eligible: false,
    served_via_canonical_chat:false,served_response_sha256:null,response_route_source:null,
  };
}

async function runServedProductItem(item,modelVersion,result,query,started) {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(QUALIFICATION_CHAT_ENDPOINT)) throw new Error("Formal qualification chat endpoint must be a pinned loopback origin.");
  const stageId = String(process.env.QUALIFICATION_STAGE_ID || "");
  if (!/^[A-Z0-9_]{3,80}$/.test(stageId)) throw new Error("QUALIFICATION_STAGE_ID is required for formal served-response provenance.");
  const clientRequestId = `${RUN_LABEL}-${item.id}-${sha256(item.question).slice(0,16)}`;
  const capability = mintQualificationRequestCapability({
    secret:process.env.QUALIFICATION_CONTEXT_HMAC_KEY,runId:process.env.QUALIFICATION_RUN_ID,
    stageId,caseId:item.id,clientRequestId,message:item.question,
  });
  const requestBodyText = JSON.stringify({ client_request_id:clientRequestId,message:item.question,qualification_capability:{ payload:capability.payload,signature:capability.signature } });
  const response = await fetch(`${QUALIFICATION_CHAT_ENDPOINT}/chat`,{
    method:"POST",
    headers:{ "content-type":"application/json","x-demo-user-id":process.env.QUALIFICATION_CANONICAL_USER_ID || "alex-morgan","x-qualification-model-attempt-limit":"2","x-qualification-stage-id":stageId,"x-qualification-case-id":item.id },
    body:requestBodyText,
    signal:AbortSignal.timeout(Number(process.env.LOCAL_LLM_TIMEOUT_MS || 300_000) * 2),
  });
  const rawBytes = Buffer.from(await response.arrayBuffer());
  const raw = rawBytes.toString("utf8");
  const servedReceipt = persistServedResponseReceipt({
    outputRoot:OUTPUT_ROOT,caseId:item.id,endpoint:QUALIFICATION_CHAT_ENDPOINT,clientRequestId,
    message:item.question,requestBodyText,rawResponseBytes:rawBytes,httpStatus:response.status,
    responseBodySha256:response.headers.get("x-qualification-body-sha256"),responseBodySignature:response.headers.get("x-qualification-body-signature"),
    qualificationCapability:{ payload:capability.payload },
  });
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`Canonical /chat returned non-JSON HTTP ${response.status}.`); }
  if (!response.ok) throw new Error(`Canonical /chat returned HTTP ${response.status}: ${String(data?.error || raw).slice(0,300)}`);
  if (typeof data.response !== "string" || data.answer !== data.response) throw new Error("Canonical /chat response and answer fields are absent or different.");
  const telemetry = data.qualification_attempts;
  if (!telemetry || typeof telemetry.model_call_attempted !== "boolean" || !Array.isArray(telemetry.generation_attempt_ledger)) {
    throw new Error("Canonical /chat response omitted qualification attempt telemetry.");
  }
  const answer = String(data.response || data.answer || "");
  if (!answer || !data.response_route) throw new Error("Canonical /chat response omitted the served answer or actual route.");
  result.selected_route = data.response_route;
  result.selected_jurisdiction = data.jurisdiction_scope || "UNSPECIFIED";
  result.response_route_source = "CANONICAL_HTTP_CHAT_RESPONSE";
  result.served_via_canonical_chat = true;
  result.served_response_sha256 = sha256(answer);
  result.served_response_receipt = servedReceipt;
  result.qualification_context_applied = false;
  result.qualification_context_sha256 = null;
  result.qualification_capability_payload_sha256 = data.qualification_capability_payload_sha256;
  result.qualification_capability_nonce = data.qualification_capability_nonce;
  result.final_system_answer = answer;
  result.review_answer = String(data.review_answer || answer);
  result.claim_citations = Array.isArray(data.claim_citations) ? data.claim_citations : [];
  result.final_public_sources = Array.isArray(data.sources) ? data.sources : [];
  result.generated_citations = result.final_public_sources.map((source) => String(source.source_id || source.sourceId || "")).filter(Boolean);
  result.retrieved_chunk_ids = [...result.generated_citations];
  result.handoff_decision = data.handoff?.reason || "none";
  result.model_call_attempted = telemetry.model_call_attempted;
  result.generation_attempts = Number(telemetry.generation_attempts || 0);
  result.retry_used = Boolean(telemetry.retry_used);
  result.retry_reason = telemetry.retry_reason || null;
  result.generation_attempt_ledger = telemetry.generation_attempt_ledger;
  result.recovered_from_truncation = Boolean(telemetry.recovered_from_truncation);
  result.runtime_identity = data.runtime_identity || null;
  result.grounding_validation = {
    valid:["grounded","grounded_with_handoff","handoff","needs_clarification"].includes(String(data.confidence || "")),
    reason:telemetry.model_call_attempted ? "served_product_model_path" : "served_product_deterministic_path",
  };
  result.query_processor_output = { ...query,response_route_actual:data.response_route };
  for (const event of telemetry.generation_attempt_ledger) appendAttemptEvent(item.id,event);
  result.latency_ms = Math.round(performance.now() - started);
  return result;
}

async function runItem(item, modelVersion) {
  const started = performance.now();
  const result = skeleton(item, modelVersion);
  const contextJurisdiction = ["GREAT_BRITAIN", "NORTHERN_IRELAND", "ENGLAND_AND_WALES", "SCOTLAND", "GB_AND_NI", "UK_TAX"].includes(item.jurisdiction)
    ? item.jurisdiction
    : null;
  const context = { summary: "", resolvedEntities: contextJurisdiction ? { jurisdiction: contextJurisdiction } : {}, providers: [], latestMessages: [], lastUserMessage: item.question };
  const query = processQuery(item.question, context);
  result.selected_jurisdiction = query.jurisdiction_scope;
  result.query_processor_output = query;

  if (QUALIFICATION_RUNTIME_MODE) {
    return runServedProductItem(item,modelVersion,result,query,started);
  }

  const policyResponse = evidencePolicyResponse(item.question);
  if (policyResponse) {
    result.selected_route = query.response_route;
    result.final_system_answer = policyResponse;
    result.handoff_decision = query.response_route === "ANSWER_AND_HANDOFF" ? (query.handoff_reason || "scheme_document_review") : "none";
    result.grounding_validation = { valid: true, reason: "deterministic_evidence_policy" };
    result.latency_ms = Math.round(performance.now() - started);
    return result;
  }

  if (["HUMAN_HANDOFF", "REFUSE_ACTION"].includes(query.response_route)) {
    result.selected_route = query.response_route;
    result.final_system_answer = query.response_route === "REFUSE_ACTION" ? SAFE_TEMPLATES.REFUSE_ACTION : SAFE_TEMPLATES.HUMAN_HANDOFF;
    result.handoff_decision = query.handoff_reason || query.response_route;
    result.action_or_tool_decision = query.response_route === "REFUSE_ACTION" ? "refused_prohibited_action" : "read_only_handoff";
    result.grounding_validation = { valid: true, reason: "deterministic_policy_route" };
    result.latency_ms = Math.round(performance.now() - started);
    return result;
  }
  if (query.needs_clarification) {
    result.selected_route = "CLARIFY_THEN_ANSWER";
    result.final_system_answer = query.clarification_reason === "jurisdiction_ambiguity"
      ? (query.clarification_prompt || "Please tell me whether this concerns Great Britain or Northern Ireland, because the applicable pension legislation may differ.")
      : "Please provide the missing scheme or provider fact so I do not apply details from the wrong arrangement.";
    result.grounding_validation = { valid: true, reason: query.clarification_reason || "ambiguity" };
    result.latency_ms = Math.round(performance.now() - started);
    return result;
  }

  const plan = publicOnlyPlan(query);
  const retrieval = plan.source_scopes.length
    ? await retrieveForQuery({ userId: USER_ID, sessionId: `${RUN_LABEL}-${item.id}`, requestId: `${RUN_LABEL}-${item.id}`, queryPlan: plan, limit: 8 })
    : { sources: [], trace: { scopes: [], noResult: true } };
  const sources = retrieval.sources;
  const chunks = sources.filter((source) => source.scope === "CURATED_PUBLIC" && !String(source.sourceId).startsWith("structured_public_"));
  const facts = sources.filter((source) => String(source.sourceId).startsWith("structured_public_") || source.sourceType === "official_structured_tax_fact");
  result.retrieved_chunk_ids = chunks.map((source) => source.sourceId);
  result.structured_fact_ids = facts.map((source) => source.sourceId);
  result.retrieval_trace = retrieval.trace;
  result.retrieval_sources = sources.map((source) => ({ source_id: source.sourceId, title: source.title, section: source.section || null, effective_date: source.effectiveDate || null, score: Number(source.score || 0), rerank_score: Number(source.rerankScore || 0), source_type: source.sourceType || null, source_role: source.sourceRole || null }));

  if (!sources.length || (query.freshness_required && !sources.some((source) => source.scope === "CURATED_PUBLIC" && source.effectiveDate))) {
    result.selected_route = query.response_route === "SECURITY_FALLBACK" ? "SECURITY_FALLBACK" : "INSUFFICIENT_EVIDENCE";
    result.final_system_answer = query.response_route === "SECURITY_FALLBACK" ? SAFE_TEMPLATES.SECURITY_FALLBACK : SAFE_TEMPLATES.INSUFFICIENT_EVIDENCE;
    result.handoff_decision = query.response_route === "SECURITY_FALLBACK" ? (query.handoff_reason || "possible_pension_scam") : "evidence_review";
    result.grounding_validation = { valid: false, reason: "missing_or_stale_public_sources" };
    result.latency_ms = Math.round(performance.now() - started);
    return result;
  }

  const modelSources = selectModelSources(sources, query, MODEL_CONTEXT_CONFIG.sourceLimit);
  const modelContext = buildModelContext(query, modelSources, { snippetChars:MODEL_CONTEXT_CONFIG.sourceSnippetChars });
  result.citation_aliases = modelContext.citationAliases;
  result.source_excerpts = modelContext.sourceExcerpts;
  result.model_call_attempted = true;
  const modelStarted = performance.now();
  const generated = await generateLocalAnswerWithRetry({
    system: ANSWER_SYSTEM_POLICY,
    ...modelContext,
    generationConfig: GENERATION_CONFIG,
    onAttemptEvent:(event) => appendAttemptEvent(item.id, event),
  }).catch((error) => { error.evaluationResult = result; throw error; })
    .finally(() => { result.model_latency_ms = Math.round(performance.now() - modelStarted); });
  result.runtime_identity = generated.runtimeIdentity;
  result.runtime_metrics = generated.runtimeMetrics;
  result.retry_used = Boolean(generated.retry_used);
  result.retry_reason = generated.retry_reason || null;
  result.generation_attempts = Number(generated.generation_attempts);
  result.generation_attempt_ledger = generated.generation_attempt_ledger || [];
  result.recovered_from_truncation = Boolean(generated.recoveredFromTruncation);
  result.raw_model_answer = generated.answer;
  result.raw_model_output = generated.rawContent;
  result.token_usage = generated.usage || {};
  result.model_finish_reason = generated.finishReason;
  const rendered = renderCitationMarkers({ answer: generated.answer, citationIds: generated.citationIds, sources: modelSources });
  result.generated_citations = rendered.citationIds;
  const validation = rendered.valid
    ? validateGroundedAnswer({
        answer: rendered.answer,
        citationIds: rendered.citationIds,
        sources: modelContext.evidenceSources,
        intent: query.intent,
        legalEvidenceRequired: query.legal_evidence_required,
        // Deterministic response requirements contain reviewed arithmetic and
        // date-derived outputs. Treat those figures as trusted calculation
        // inputs while still requiring current public-law citations.
        userSuppliedText: [query.self_contained_query, ...(query.response_requirements || [])].join("\n"),
        claimCitations: rendered.claimCitations,
      })
    : { valid: false, reason: rendered.inventedCitationIds.length ? "invented_citation" : "citation_render_failure", inventedCitationIds: rendered.inventedCitationIds };
  result.grounding_validation = validation;
  if (validation.valid) {
    result.selected_route = query.response_route;
    result.final_system_answer = query.response_route === "SECURITY_FALLBACK" ? `${SAFE_TEMPLATES.SECURITY_LEAD} ${rendered.answer}` : rendered.answer;
    result.claim_citations = rendered.claimCitations;
    result.review_answer = `${query.response_route === "SECURITY_FALLBACK" ? `${SAFE_TEMPLATES.SECURITY_LEAD} ` : ""}${rendered.claimCitations.map((entry) => entry.claim).join(" ")}`.trim();
    result.final_public_sources = publicSources(modelContext.evidenceSources, validation.citationIds);
    if (["ANSWER_AND_HANDOFF", "SECURITY_FALLBACK"].includes(query.response_route)) result.handoff_decision = query.handoff_reason || "human_review";
  } else {
    result.selected_route = "GROUNDING_FALLBACK";
    result.final_system_answer = query.response_route === "SECURITY_FALLBACK" ? SAFE_TEMPLATES.SECURITY_FALLBACK : SAFE_TEMPLATES.INSUFFICIENT_EVIDENCE;
    result.review_answer = result.final_system_answer;
    result.handoff_decision = query.response_route === "SECURITY_FALLBACK" ? (query.handoff_reason || "possible_pension_scam") : "grounding_validation";
  }
  result.latency_ms = Math.round(performance.now() - started);
  return result;
}

function appendAttemptEvent(questionId, event) {
  const fd = openSync(ATTEMPT_LEDGER_PATH, "a", 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify({ run_label:RUN_LABEL,question_id:questionId,...event })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(ATTEMPT_LEDGER_PATH));
}

if (!existsSync(PREFLIGHT_PATH)) throw new Error(`Run the ${WAVE} preflight first.`);
const preflight = readJson(PREFLIGHT_PATH);
if (PARTITION === "diagnostic" && !preflight.authorisation.diagnostic_output_collection) throw new Error(`${WAVE} diagnostic output collection is not authorised by preflight.`);
if (PARTITION === "unseen" && !preflight.authorisation.unseen_execution) throw new Error(`${WAVE} unseen execution is blocked until sealed gold and independent-review gates pass.`);

const loaded = loadQuestions();
const requestedIds = new Set(String(process.env.CYCLE_V2_QUESTION_IDS || process.env.CYCLE_V2_WAVE1_QUESTION_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
let questions = requestedIds.size ? loaded.questions.filter((item) => requestedIds.has(item.id)) : loaded.questions;
const limit = Number(process.env.CYCLE_V2_LIMIT || process.env.CYCLE_V2_WAVE1_LIMIT || 0);
if (limit > 0) questions = questions.slice(0, limit);
if (requestedIds.size && questions.length !== requestedIds.size) throw new Error(`One or more requested ${WAVE} question IDs do not exist.`);

const checkpoint = readJson(CHECKPOINT_PATH);
const modelHealth = await healthJson(`${String(process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "")}/v1/models`);
const retrievalHealth = await healthJson(`${String(process.env.EMBEDDING_SERVICE_URL || "http://127.0.0.1:8090").replace(/\/$/, "")}/health`);
if (!modelHealth.ok) throw new Error(`${WAVE} run blocked: selected local model service is unavailable.`);
if (!retrievalHealth.ok) throw new Error(`${WAVE} run blocked: embedding/reranker service is unavailable.`);
assertModelIdentity(modelHealth.body?.data?.find((item) => item.id === process.env.LOCAL_LLM_MODEL), {
  id: `${checkpoint.model_version}-step${checkpoint.selected_iteration}`,
  adapter_sha256: checkpoint.adapter_sha256, adapter_config_sha256: checkpoint.adapter_config_sha256,
});
// Never relabel old outputs with a new manifest or silently retry failed cases.
if (existsSync(RESULTS_PATH)) throw new Error("Run label already exists; use a new label to preserve the frozen attempt.");
if (existsSync(ATTEMPT_LEDGER_PATH)) throw new Error("Run label has a prior generation-attempt ledger; use a new label.");

if (!QUALIFICATION_RUNTIME_MODE) await initialiseDataStore();
durableMkdir(OUTPUT_ROOT);
createExclusive(ATTEMPT_LEDGER_PATH,"");
const inputHash = hashFile(loaded.path);
const manifest = {
  version: `evaluation-cycle-v2-${WAVE}-run-manifest-v1`, status: "running", started_at: now(), completed_at: null,
  partition: PARTITION, run_label: RUN_LABEL, official_scoring_eligible: false, model_selection_authorised: false,
  input: { path: loaded.path, sha256: inputHash, questions: questions.length, question_ids: questions.map((item) => item.id) },
  model: { version: `${checkpoint.model_version}-step${checkpoint.selected_iteration}`, base_model: "mlx-community/Qwen3-8B-4bit", adapter_path: checkpoint.selected_adapter_path, adapter_sha256: checkpoint.adapter_sha256, selected_iteration: checkpoint.selected_iteration, service_health: modelHealth },
  generation: GENERATION_CONFIG, model_context: MODEL_CONTEXT_CONFIG, prompt: { version: ANSWER_POLICY_VERSION, sha256: sha256(ANSWER_SYSTEM_POLICY) },
  rag: { service_health: retrievalHealth },
  integrity: { gold_supplied_to_model: false, unseen_accessed: PARTITION === "unseen", training_eligibility: "prohibited" },
  code: {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    worktree_dirty: Boolean(git(["status", "--porcelain"], "")),
    runner_sha256: hashFile(resolve("scripts/evaluationCycleV2Wave1Run.mjs")),
    query_processor_sha256: hashFile(resolve("server/services/queryProcessorService.js")),
    retrieval_service_sha256: hashFile(resolve("server/services/retrievalService.js")),
    knowledge_service_sha256: hashFile(resolve("server/services/knowledgeService.js")),
    knowledge_repository_sha256: hashFile(resolve("server/repositories/knowledgeRepository.js")),
    reranking_service_sha256: hashFile(resolve("server/services/rerankingService.js")),
    grounding_service_sha256: hashFile(resolve("server/services/groundingService.js")),
    citation_renderer_sha256: hashFile(resolve("server/services/citationRendererService.js")),
    local_model_service_sha256: hashFile(resolve("server/services/localModelService.js")),
    model_context_service_sha256: hashFile(resolve("server/services/modelContextService.js")),
    evidence_excerpt_service_sha256: hashFile(resolve("server/services/evidenceExcerptService.js")),
    model_identity_service_sha256: hashFile(resolve("server/services/modelIdentityService.js")),
    chat_service_sha256:hashFile(resolve("server/services/chatService.js")),
    chat_route_sha256:hashFile(resolve("server/routes/chatRoutes.js")),
    qualification_context_service_sha256:hashFile(resolve("server/services/qualificationContextService.js")),
    served_response_receipt_sha256:hashFile(resolve("scripts/lib/servedResponseReceipt.mjs")),
    deterministic_answer_service_sha256:hashFile(resolve("server/services/deterministicAnswerService.js")),
    safety_wording_service_sha256:hashFile(resolve("server/services/safetyWordingService.js")),
    embedding_service_sha256: hashFile(resolve("ml/embedding_server.py")),
  },
};
writeJson(MANIFEST_PATH, manifest);

let output = { version: `evaluation-cycle-v2-${WAVE}-results-v1`, status: "running", started_at: manifest.started_at, completed_at: null, partition: PARTITION, run_label: RUN_LABEL, official_scoring_eligible: false, results: [] };
if (existsSync(RESULTS_PATH)) {
  const prior = readJson(RESULTS_PATH);
  if (prior.run_label === RUN_LABEL && Array.isArray(prior.results)) output = prior;
}
if (String(process.env.CYCLE_V2_RETRY_RUN_ERRORS || "true").toLowerCase() === "true") {
  output.results = output.results.filter((item) => item.selected_route !== "RUN_ERROR");
}
const completed = new Set(output.results.map((item) => item.question_id));
for (let index = 0; index < questions.length; index += 1) {
  const item = questions[index];
  if (completed.has(item.id)) { console.log(`[${index + 1}/${questions.length}] ${item.id} resumed`); continue; }
  const itemStarted = performance.now();
  try {
    const result = await runItem(item, manifest.model.version);
    output.results.push(result);
    console.log(`[${index + 1}/${questions.length}] ${item.id} ${result.selected_route} ${result.latency_ms}ms`);
  } catch (error) {
    const result = error.evaluationResult || skeleton(item, manifest.model.version);
    result.latency_ms = Math.round(performance.now() - itemStarted);
    if (error.modelResponse) {
      result.raw_model_output = error.modelResponse.rawContent;
      result.runtime_identity = error.modelResponse.runtimeIdentity;
      result.runtime_metrics = error.modelResponse.runtimeMetrics;
      result.token_usage = error.modelResponse.usage;
      result.model_finish_reason = error.modelResponse.finishReason;
    }
    result.selected_route = "RUN_ERROR";
    result.final_system_answer = SAFE_TEMPLATES.MODEL_UNAVAILABLE;
    result.handoff_decision = "run_error";
    result.run_error = { name: error.name, code: error.code || null, message: error.message };
    result.generation_attempts = Number(error.attempts || error.generation_attempt_ledger?.filter((entry) => entry.event === "ATTEMPT_STARTED").length || 0);
    result.generation_attempt_ledger = error.generation_attempt_ledger || [];
    result.retry_used = result.generation_attempts === 2;
    result.retry_reason = error.retry_reason || null;
    output.results.push(result);
    console.log(`[${index + 1}/${questions.length}] ${item.id} RUN_ERROR ${error.message}`);
  }
  completed.add(item.id);
  writeJson(RESULTS_PATH, output);
}

output.status = "completed_output_collection_pending_gold_scoring";
output.completed_at = now();
output.summary = { processed: output.results.length, routes: countBy(output.results.map((item) => item.selected_route)), model_calls: output.results.filter((item) => item.raw_model_answer != null).length, grounding_valid: output.results.filter((item) => item.grounding_validation?.valid).length, grounding_fallbacks: output.results.filter((item) => item.selected_route === "GROUNDING_FALLBACK").length, run_errors: output.results.filter((item) => item.selected_route === "RUN_ERROR").length };
output.summary.successful_model_calls = output.summary.model_calls;
output.summary.model_calls = output.results.filter((item) => item.model_call_attempted).length;
writeJson(RESULTS_PATH, output);
manifest.status = output.status;
manifest.completed_at = output.completed_at;
manifest.results_sha256 = hashFile(RESULTS_PATH);
manifest.generation_attempt_ledger_sha256 = hashFile(ATTEMPT_LEDGER_PATH);
writeJson(MANIFEST_PATH, manifest);
writeText(resolve(OUTPUT_ROOT, "RESULTS.md"), `# Cycle v2 Wave ${WAVE_NUMBER} ${PARTITION} output collection\n\nCompleted: ${output.completed_at}\n\nProcessed: ${output.summary.processed}. Model calls: ${output.summary.model_calls}. Grounding-valid routes: ${output.summary.grounding_valid}. Grounding fallbacks: ${output.summary.grounding_fallbacks}. Run errors: ${output.summary.run_errors}.\n\nThese outputs are frozen pending item-specific gold/rubric review. They are not pass/fail results and are not eligible for model selection.\n`);
console.log(JSON.stringify({ status: output.status, partition: PARTITION, summary: output.summary, output_root: OUTPUT_ROOT }, null, 2));
