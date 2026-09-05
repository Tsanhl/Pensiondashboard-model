import { execFileSync } from "node:child_process";
import { appendFileSync,closeSync,existsSync,fsyncSync,openSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { assertModelIdentity, configuredModelIdentity } from "../server/services/modelIdentityService.js";
import { buildModelContext } from "../server/services/modelContextService.js";
import {
  CYCLE_ROOT,INPUTS,PROJECT_ROOT,countBy,hashFile,isoNow,readJson,sha256,
  writeJsonAtomic,writeTextAtomic,markdownTable
} from "./evaluationCycleV1Common.mjs";
import {
  mintQualificationContextCapability,
  qualificationJurisdictionFromValues,
} from "../server/services/qualificationContextService.js";
import { projectQualificationFixtureValues } from "../server/services/qualificationFixtureSchema.js";
import { persistServedResponseReceipt } from "./lib/servedResponseReceipt.mjs";
import { createExclusive,durableMkdir,fsyncDirectory } from "./lib/qualification-worker/utils.mjs";

await import("../server/loadEnv.js");
const [{ initialiseDataStore },queryModule,retrievalModule,modelModule,grounding,policy,citationRenderer,chatModule] = await Promise.all([
  import("../server/store/userDataStore.js"),
  import("../server/services/queryProcessorService.js"),
  import("../server/services/retrievalService.js"),
  import("../server/services/localModelService.js"),
  import("../server/services/groundingService.js"),
  import("../server/prompts/answerPolicy.js"),
  import("../server/services/citationRendererService.js"),
  import("../server/services/chatService.js")
]);

const { processQuery } = queryModule;
const { retrieveForQuery } = retrievalModule;
const { generateLocalAnswerWithRetry,localModelStatus } = modelModule;
const { SAFE_TEMPLATES,publicSources,validateGroundedAnswer } = grounding;
const { ANSWER_POLICY_VERSION,ANSWER_SYSTEM_POLICY } = policy;
const { renderCitationMarkers } = citationRenderer;
const { selectModelSources } = chatModule;
const RUN_LABEL = String(process.env.POST_FIX_RUN_LABEL || "phase-5-post-fix-v2").replace(/[^a-zA-Z0-9._-]/g,"-");
const QUALIFICATION_CHAT_ENDPOINT = String(process.env.QUALIFICATION_CANONICAL_CHAT_ENDPOINT || "").replace(/\/$/,"");
const QUALIFICATION_RUNTIME_MODE = String(process.env.QUALIFICATION_RUNTIME_MODE || "false").toLowerCase() === "true";
const OUTPUT_ROOT = resolve(CYCLE_ROOT,`06-regression/${RUN_LABEL}`);
const RESULTS_PATH = resolve(OUTPUT_ROOT,"post-fix-results.json");
const MANIFEST_PATH = resolve(OUTPUT_ROOT,"post-fix-run-manifest.json");
const ATTEMPT_LEDGER_PATH = resolve(OUTPUT_ROOT,"generation-attempt-ledger.jsonl");
const MODEL_MANIFEST_PATH = resolve(PROJECT_ROOT,"models/model-manifest.json");
const GENERATION_CONFIG = Object.freeze({
  temperature:Number(process.env.LOCAL_LLM_TEMPERATURE ?? 0),topP:Number(process.env.LOCAL_LLM_TOP_P ?? 1),
  maxTokens:Number(process.env.LOCAL_LLM_MAX_TOKENS || 320),seed:Number(process.env.LOCAL_LLM_SEED ?? 42),
});
const USER_ID = "evaluation-cycle-v1-post-fix";
const EVALUATION_MODEL = Object.freeze({
  version:process.env.EVALUATION_MODEL_VERSION || "pension-assistant-v0-post-non-weight-fixes",
  repository:process.env.EVALUATION_MODEL_REPOSITORY || null,
  revision:process.env.EVALUATION_MODEL_REVISION || null,
  quantisation:process.env.EVALUATION_MODEL_QUANTISATION || "Q4_K_M",
  loraAdapter:process.env.EVALUATION_LORA_ADAPTER || null
});

function git(args, fallback = null) {
  try { return execFileSync("git",args,{ cwd:PROJECT_ROOT,encoding:"utf8",stdio:["ignore","pipe","ignore"] }).trim(); }
  catch { return fallback; }
}

async function healthJson(url) {
  try {
    const response = await fetch(url,{ signal:AbortSignal.timeout(Number(process.env.EVALUATION_HEALTH_TIMEOUT_MS || 5_000)) });
    return { ok:response.ok,status:response.status,body:await response.json().catch(() => null) };
  } catch (error) { return { ok:false,status:null,error:error.message }; }
}

function parseConversationContext(context = []) {
  return context.map((entry) => {
    if (typeof entry === "object" && entry && ["user","assistant"].includes(entry.role)) return { role:entry.role,content:String(entry.content || "") };
    const value = String(entry || "");
    if (/^assistant\s*:/i.test(value)) return { role:"assistant",content:value.replace(/^assistant\s*:\s*/i,"") };
    return { role:"user",content:value.replace(/^user\s*:\s*/i,"") };
  }).filter((entry) => entry.content);
}

function jurisdictionFromFixture(values = {}) {
  const candidates = [
    values.user_jurisdiction,values.jurisdiction,values.work_location,values.employment_location,
    values.divorce_jurisdiction,values.proceedings_location,values.company_location
  ].filter((value) => value && value !== "not supplied").join(" ");
  if (/northern ireland|\bni\b|belfast|newry|derry|londonderry/i.test(candidates)) return "NORTHERN_IRELAND";
  if (/england and wales|cardiff|swansea/i.test(candidates) || values.jurisdiction_England_and_Wales === true) return "ENGLAND_AND_WALES";
  if (/scotland|glasgow|edinburgh/i.test(candidates)) return "SCOTLAND";
  if (/england|wales|great britain|\bgb\b/i.test(candidates)) return "GREAT_BRITAIN";
  if (/united kingdom|\buk\b|gb_and_ni/i.test(candidates)) return "GB_AND_NI";
  return null;
}

function fixtureProviders(values = {}) {
  return [...new Set([
    values.provider,values.resolved_provider,values.provider_x_identity,
    ...(Array.isArray(values.conversation_order) ? values.conversation_order : []),
    ...(Array.isArray(values.providers) ? values.providers : [])
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function sanitisedContext(item, question) {
  const messages = parseConversationContext(item.conversation_context || []);
  const values = projectQualificationFixtureValues(item.id,item.synthetic_fixture?.values || {});
  const resolvedEntities = {};
  const jurisdiction = jurisdictionFromFixture(values);
  if (jurisdiction) resolvedEntities.jurisdiction = jurisdiction;
  if (values.resolved_provider) resolvedEntities.provider = values.resolved_provider;
  if (values.policy_number) resolvedEntities.policyNumber = values.policy_number;
  return {
    summary:"",resolvedEntities,providers:fixtureProviders(values),latestMessages:messages,
    lastUserMessage:[...messages].reverse().find((entry) => entry.role === "user")?.content || ""
  };
}

function fixtureSource(item) {
  const fixture = item.synthetic_fixture;
  const projectedValues = projectQualificationFixtureValues(item.id,fixture.values || {});
  return {
    sourceId:fixture.evidence_id,title:fixture.title || `Synthetic evaluation fixture ${item.id}`,
    section:"Permitted synthetic dashboard fixture",scope:"USER_PORTFOLIO",score:1,
    effectiveDate:fixture.as_of_date || null,updatedAt:fixture.as_of_date || null,
    snippet:JSON.stringify(projectedValues),authority:"Synthetic evaluation fixture",
    jurisdiction:jurisdictionFromFixture(projectedValues) || "not specified",canonicalLocation:null,
    documentId:`synthetic-${item.id}`,version:1,sourceType:"verified_synthetic_fixture",sourceRole:"fixture",
    authorityRank:1,oscolaCitation:fixture.title || `Synthetic dashboard fixture for ${item.id}`
  };
}

function publicOnlyPlan(query) {
  const personalScopes = new Set(["USER_PORTFOLIO","USER_DOCUMENTS"]);
  const personalLookups = new Set(["account","charges","document_status","projection","investment_profile"]);
  return {
    ...query,
    source_scopes:query.source_scopes.filter((scope) => !personalScopes.has(scope)),
    structured_lookups:query.structured_lookups.filter((lookup) => !personalLookups.has(lookup))
  };
}

function skeleton(question,item) {
  return {
    question_id:question.id,suite:question.suite,question:question.question,fixture_id:item.synthetic_fixture?.evidence_id || null,
    model_version:EVALUATION_MODEL.version,raw_model_answer:null,raw_model_output:null,final_system_answer:null,
    selected_jurisdiction:"UNSPECIFIED",selected_route:null,retrieved_chunk_ids:[],retrieved_chunk_text_hashes:[],
    structured_fact_ids:[],generated_citations:[],claim_citations:[],review_answer:null,final_public_sources:[],handoff_decision:"none",
    action_or_tool_decision:"read_only_no_tool_call",tool_calls:[],latency_ms:0,model_call_attempted:false,token_usage:{},run_timestamp:isoNow(),
    retrieval_trace:null,grounding_validation:null,training_eligibility:"prohibited",regression_scoring_only:true,
    served_via_canonical_chat:false,served_response_sha256:null,response_route_source:null,
    qualification_context_applied:false,qualification_context_sha256:null,
  };
}

async function runServedProductItem(question,item,result,query,started) {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(QUALIFICATION_CHAT_ENDPOINT)) throw new Error("Formal qualification chat endpoint must be a pinned loopback origin.");
  const fixtureValues = projectQualificationFixtureValues(question.id,item.synthetic_fixture?.values || {});
  const fixtureJurisdiction = qualificationJurisdictionFromValues(fixtureValues);
  const stageId = String(process.env.QUALIFICATION_STAGE_ID || "");
  if (!/^VISIBLE_(?:CRITICAL4|FULL69)$/.test(stageId)) throw new Error("QUALIFICATION_STAGE_ID does not authorise this synthetic-context run.");
  const qualificationContext = {
    version:"qualification-synthetic-context-v1",
    case_id:question.id,
    declared_jurisdiction:fixtureJurisdiction,
    conversation_context:item.conversation_context || question.conversation_context || [],
    synthetic_fixture:{ ...item.synthetic_fixture,values:fixtureValues },
  };
  const contextSha256 = sha256(JSON.stringify(qualificationContext));
  const clientRequestId = `${RUN_LABEL}-${question.id}-${sha256(`${question.question}\n${contextSha256}`).slice(0,16)}`;
  const capability = mintQualificationContextCapability({
    secret:process.env.QUALIFICATION_CONTEXT_HMAC_KEY,
    runId:process.env.QUALIFICATION_RUN_ID,
    stageId,
    clientRequestId,message:question.question,context:qualificationContext,
  });
  const normalizedContext = capability.normalized_context;
  const normalizedContextSha256 = sha256(JSON.stringify(normalizedContext));
  const requestBodyText = JSON.stringify({ client_request_id:clientRequestId,message:question.question,qualification_context:normalizedContext,qualification_capability:{ payload:capability.payload,signature:capability.signature } });
  const response = await fetch(`${QUALIFICATION_CHAT_ENDPOINT}/chat`,{
    method:"POST",
    headers:{
      "content-type":"application/json",
      "x-demo-user-id":process.env.QUALIFICATION_CANONICAL_USER_ID || "alex-morgan",
      "x-qualification-model-attempt-limit":"2",
      "x-qualification-stage-id":stageId,
      "x-qualification-case-id":question.id,
    },
    body:requestBodyText,
    signal:AbortSignal.timeout(Number(process.env.LOCAL_LLM_TIMEOUT_MS || 300_000) * 2),
  });
  const rawBytes = Buffer.from(await response.arrayBuffer());
  const raw = rawBytes.toString("utf8");
  const servedReceipt = persistServedResponseReceipt({
    outputRoot:OUTPUT_ROOT,caseId:question.id,endpoint:QUALIFICATION_CHAT_ENDPOINT,clientRequestId,
    message:question.question,requestBodyText,rawResponseBytes:rawBytes,httpStatus:response.status,
    responseBodySha256:response.headers.get("x-qualification-body-sha256"),responseBodySignature:response.headers.get("x-qualification-body-signature"),
    qualificationContextSha256:normalizedContextSha256,qualificationCapability:{ payload:capability.payload },
  });
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`Canonical /chat returned non-JSON HTTP ${response.status}.`); }
  if (!response.ok) throw new Error(`Canonical /chat returned HTTP ${response.status}: ${String(data?.error || raw).slice(0,300)}`);
  if (typeof data.response !== "string" || data.answer !== data.response) throw new Error("Canonical /chat response and answer fields are absent or different.");
  if (data.qualification_context_applied !== true || data.qualification_context_sha256 !== normalizedContextSha256 ||
      data.qualification_capability_payload_sha256 !== sha256(JSON.stringify(capability.payload)) || data.qualification_capability_nonce !== capability.payload.nonce) {
    throw new Error("Canonical /chat did not bind the supplied synthetic qualification context.");
  }
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
  result.qualification_context_applied = true;
  result.qualification_context_sha256 = normalizedContextSha256;
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
  for (const event of telemetry.generation_attempt_ledger) appendAttemptEvent(question.id,event);
  result.latency_ms = Math.round(performance.now() - started);
  return result;
}

async function runItem(question,item) {
  const started = performance.now();
  const result = skeleton(question,item);
  const context = sanitisedContext(item, question);
  const query = processQuery(question.question,context);
  result.selected_jurisdiction = query.jurisdiction_scope;
  result.query_processor_output = query;

  if (QUALIFICATION_RUNTIME_MODE) {
    return runServedProductItem(question,item,result,query,started);
  }

  if (["HUMAN_HANDOFF","REFUSE_ACTION"].includes(query.response_route)) {
    result.selected_route = query.response_route;
    result.final_system_answer = query.response_route === "REFUSE_ACTION" ? SAFE_TEMPLATES.REFUSE_ACTION : SAFE_TEMPLATES.HUMAN_HANDOFF;
    result.handoff_decision = query.handoff_reason || query.response_route;
    result.action_or_tool_decision = query.response_route === "REFUSE_ACTION" ? "refused_prohibited_action" : "read_only_handoff";
    result.grounding_validation = { valid:true,reason:"deterministic_policy_route" };
    result.latency_ms = Math.round(performance.now() - started);
    return result;
  }

  if (query.needs_clarification) {
    result.selected_route = "CLARIFY_THEN_ANSWER";
    result.final_system_answer = query.clarification_reason === "jurisdiction_ambiguity"
      ? "Please tell me whether this concerns Great Britain or Northern Ireland, because the applicable pension legislation may differ."
      : "Please name the provider or policy so I do not apply details from the wrong account.";
    result.grounding_validation = { valid:true,reason:query.clarification_reason || "ambiguity" };
    result.latency_ms = Math.round(performance.now() - started);
    return result;
  }

  const plan = publicOnlyPlan(query);
  let retrieval = { sources:[],trace:{ scopes:plan.source_scopes,noResult:true } };
  if (plan.source_scopes.length) retrieval = await retrieveForQuery({ userId:USER_ID,sessionId:`postfix-${question.id}`,requestId:`postfix-${question.id}`,queryPlan:plan,limit:8 });
  const fixture = fixtureSource(item);
  const sources = [fixture,...retrieval.sources];
  const chunks = retrieval.sources.filter((source) => source.scope === "CURATED_PUBLIC" && !String(source.sourceId).startsWith("structured_public_"));
  const facts = retrieval.sources.filter((source) => String(source.sourceId).startsWith("structured_public_") || source.sourceType === "official_structured_tax_fact");
  result.retrieved_chunk_ids = chunks.map((source) => source.sourceId);
  result.retrieved_chunk_text_hashes = chunks.map((source) => ({ chunk_id:source.sourceId,sha256:sha256(String(source.snippet || "")) }));
  result.structured_fact_ids = facts.map((source) => source.sourceId);
  result.retrieval_trace = retrieval.trace;
  result.retrieval_sources = retrieval.sources.map((source) => ({ source_id:source.sourceId,title:source.title,section:source.section || null,scope:source.scope,effective_date:source.effectiveDate || null,score:Number(source.score || 0),rerank_score:Number(source.rerankScore || 0),source_type:source.sourceType || null,source_role:source.sourceRole || null }));

  if (query.freshness_required && !retrieval.sources.some((source) => source.scope === "CURATED_PUBLIC" && source.effectiveDate)) {
    result.selected_route = "INSUFFICIENT_EVIDENCE";
    result.final_system_answer = query.response_route === "SECURITY_FALLBACK" ? SAFE_TEMPLATES.SECURITY_FALLBACK : SAFE_TEMPLATES.INSUFFICIENT_EVIDENCE;
    result.handoff_decision = query.response_route === "SECURITY_FALLBACK" ? (query.handoff_reason || "possible_pension_scam") : "evidence_review";
    result.grounding_validation = { valid:false,reason:"missing_or_stale_public_sources" };
    result.latency_ms = Math.round(performance.now() - started);
    return result;
  }

  const modelSources = selectModelSources(sources, query, Math.max(1,Number(process.env.LLM_CONTEXT_SOURCE_LIMIT || 6)));
  const modelContext = buildModelContext(query, modelSources, { history:context.latestMessages, snippetChars:Number(process.env.LLM_SOURCE_SNIPPET_CHARS || 1000) });
  result.citation_aliases = modelContext.citationAliases;
  result.source_excerpts = modelContext.sourceExcerpts;
  result.model_call_attempted = true;
  const modelStarted = performance.now();
  const generated = await generateLocalAnswerWithRetry({ system:ANSWER_SYSTEM_POLICY,...modelContext,generationConfig:GENERATION_CONFIG,onAttemptEvent:(event) => appendAttemptEvent(question.id,event) })
    .catch((error) => { error.evaluationResult = result; throw error; })
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
  const rendered = renderCitationMarkers({ answer:generated.answer,citationIds:generated.citationIds,sources:modelSources });
  result.generated_citations = rendered.citationIds;
  result.token_usage = generated.usage || {};
  result.model_finish_reason = generated.finishReason;
  const validation = rendered.valid
    ? validateGroundedAnswer({ answer:rendered.answer,citationIds:rendered.citationIds,sources:modelContext.evidenceSources,intent:query.intent,legalEvidenceRequired:query.legal_evidence_required,userSuppliedText:query.self_contained_query,claimCitations:rendered.claimCitations })
    : { valid:false,reason:rendered.inventedCitationIds.length ? "invented_citation" : "citation_render_failure",inventedCitationIds:rendered.inventedCitationIds,hiddenCitationIds:rendered.hiddenCitationIds,missingCitationMetadataIds:rendered.missingCitationMetadataIds };
  result.grounding_validation = validation;
  if (validation.valid) {
    result.selected_route = query.response_route;
    result.final_system_answer = rendered.answer;
    result.claim_citations = rendered.claimCitations;
    result.review_answer = rendered.claimCitations.map((entry) => entry.claim).join(" ");
    result.final_public_sources = publicSources(modelContext.evidenceSources,validation.citationIds);
    if (["ANSWER_AND_HANDOFF","SECURITY_FALLBACK"].includes(query.response_route)) result.handoff_decision = query.handoff_reason || "human_review";
  } else {
    result.selected_route = "GROUNDING_FALLBACK";
    result.final_system_answer = query.response_route === "SECURITY_FALLBACK" ? SAFE_TEMPLATES.SECURITY_FALLBACK : SAFE_TEMPLATES.INSUFFICIENT_EVIDENCE;
    result.review_answer = result.final_system_answer;
    result.handoff_decision = query.response_route === "SECURITY_FALLBACK" ? (query.handoff_reason || "possible_pension_scam") : "grounding_validation";
  }
  result.latency_ms = Math.round(performance.now() - started);
  return result;
}

function appendAttemptEvent(questionId,event) {
  const fd = openSync(ATTEMPT_LEDGER_PATH,"a",0o600);
  try {
    appendFileSync(fd,`${JSON.stringify({ run_label:RUN_LABEL,question_id:questionId,...event })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(ATTEMPT_LEDGER_PATH));
}

durableMkdir(OUTPUT_ROOT);
if (!QUALIFICATION_RUNTIME_MODE) await initialiseDataStore();
const evaluation = readJson(INPUTS.evaluationDraft);
const review = readJson(INPUTS.answerReview);
const byId = new Map(review.items.map((item) => [item.id,item]));
const requestedIds = new Set(String(process.env.EVALUATION_QUESTION_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
const questionsToRun = requestedIds.size ? evaluation.questions.filter((question) => requestedIds.has(question.id)) : evaluation.questions;
if (requestedIds.size && questionsToRun.length !== requestedIds.size) throw new Error("One or more EVALUATION_QUESTION_IDS do not exist in the regression set.");
const modelManifest = readJson(MODEL_MANIFEST_PATH);
const modelHealth = await healthJson(`${String(process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/,"")}/v1/models`);
const retrievalHealth = await healthJson(`${String(process.env.EMBEDDING_SERVICE_URL || "http://127.0.0.1:8090").replace(/\/$/,"")}/health`);
if (!modelHealth.ok) throw new Error("Post-fix regression blocked: local Qwen service is unavailable.");
if (!retrievalHealth.ok) throw new Error("Post-fix regression blocked: embedding/reranker service is unavailable.");
assertModelIdentity(modelHealth.body?.data?.find((item) => item.id === process.env.LOCAL_LLM_MODEL), configuredModelIdentity());
if (EVALUATION_MODEL.loraAdapter && !process.env.LOCAL_LLM_EXPECTED_ADAPTER_SHA256) throw new Error("Adapter regression requires an expected adapter hash, not just a label.");
if (existsSync(RESULTS_PATH)) throw new Error("Run label already exists; choose a new label to preserve prior evidence.");
if (existsSync(ATTEMPT_LEDGER_PATH)) throw new Error("Run label has a prior generation-attempt ledger; choose a new label.");
createExclusive(ATTEMPT_LEDGER_PATH,"");

const startedAt = isoNow();
const manifest = {
  version:"phase-5-post-fix-run-manifest-v1",phase:"Phase 5 — non-weight fix regression",status:"running",
  started_at:startedAt,completed_at:null,canonical:false,model_selection_authorised:false,
  purpose:"Measure non-weight fixes before targeted behavioural training. Sealed unseen data is not accessed.",
  model:{
    version:EVALUATION_MODEL.version,
    base_model:EVALUATION_MODEL.repository || modelManifest.answer_model.repository,
    revision:EVALUATION_MODEL.revision || (EVALUATION_MODEL.repository ? null : modelManifest.answer_model.revision),
    quantisation:EVALUATION_MODEL.quantisation,
    lora_adapter:EVALUATION_MODEL.loraAdapter,
    status:await localModelStatus(),
    service_health:modelHealth
  },
  generation:GENERATION_CONFIG,model_context:{ source_limit:Number(process.env.LLM_CONTEXT_SOURCE_LIMIT || 6),source_snippet_characters:Number(process.env.LLM_SOURCE_SNIPPET_CHARS || 1000),context_limit_tokens:Number(process.env.LOCAL_LLM_CONTEXT_TOKENS || 8192) },prompt:{ version:ANSWER_POLICY_VERSION,sha256:sha256(ANSWER_SYSTEM_POLICY) },
  rag:{ embedding_model:modelManifest.embedding_model.repository,embedding_dimensions:modelManifest.embedding_model.dimensions,service_health:retrievalHealth },
  evaluation:{ items:questionsToRun.length,question_ids:questionsToRun.map((question) => question.id),training_eligibility:"prohibited",owner_approved_for_regression_scoring_only:true,sealed_unseen_accessed:false },
  source_hashes:Object.fromEntries(["server/routes/chatRoutes.js", "server/services/chatService.js", "server/services/qualificationContextService.js", "server/services/qualificationFixtureSchema.js", "server/services/queryProcessorService.js", "server/services/groundingService.js", "server/services/knowledgeService.js", "server/repositories/knowledgeRepository.js", "server/services/retrievalService.js", "server/services/rerankingService.js", "server/prompts/answerPolicy.js", "server/services/modelContextService.js", "server/services/evidenceExcerptService.js", "server/services/localModelService.js", "server/services/deterministicAnswerService.js", "server/services/safetyWordingService.js", "scripts/lib/servedResponseReceipt.mjs"].map((path) => [path,hashFile(resolve(PROJECT_ROOT,path))])),
  code:{ commit:git(["rev-parse","HEAD"]),branch:git(["rev-parse","--abbrev-ref","HEAD"]),worktree_dirty:Boolean(git(["status","--porcelain"],"")),runner:hashFile(resolve(PROJECT_ROOT,"scripts/evaluationCycleV1PostFixRegression.mjs")) }
};
writeJsonAtomic(MANIFEST_PATH,manifest);

let output = { version:"phase-5-post-fix-results-v1",status:"running",started_at:startedAt,completed_at:null,model_selection_authorised:false,sealed_unseen_accessed:false,training_eligibility:"prohibited",results:[] };
if (existsSync(RESULTS_PATH)) {
  const prior = readJson(RESULTS_PATH);
  if (Array.isArray(prior.results)) output = prior;
}
const completed = new Set(output.results.map((item) => item.question_id));
for (let index = 0; index < questionsToRun.length; index += 1) {
  const question = questionsToRun[index];
  if (completed.has(question.id)) {
    console.log(`[${index + 1}/${questionsToRun.length}] ${question.id} imported unchanged`);
    continue;
  }
  const item = byId.get(question.id);
  const itemStarted = performance.now();
  try {
    const result = await runItem(question,item);
    output.results.push(result);
    console.log(`[${index + 1}/${questionsToRun.length}] ${question.id} ${result.selected_route} ${result.latency_ms}ms`);
  } catch (error) {
    const failed = error.evaluationResult || skeleton(question,item);
    failed.latency_ms = Math.round(performance.now() - itemStarted);
    if (error.modelResponse) {
      failed.raw_model_output = error.modelResponse.rawContent;
      failed.runtime_identity = error.modelResponse.runtimeIdentity;
      failed.runtime_metrics = error.modelResponse.runtimeMetrics;
      failed.token_usage = error.modelResponse.usage;
      failed.model_finish_reason = error.modelResponse.finishReason;
    }
    failed.selected_route = "RUN_ERROR";
    failed.run_error = { name:error.name,code:error.code || null,message:error.message };
    failed.generation_attempts = Number(error.attempts || error.generation_attempt_ledger?.filter((entry) => entry.event === "ATTEMPT_STARTED").length || 0);
    failed.generation_attempt_ledger = error.generation_attempt_ledger || [];
    failed.retry_used = failed.generation_attempts === 2;
    failed.retry_reason = error.retry_reason || null;
    failed.final_system_answer = SAFE_TEMPLATES.MODEL_UNAVAILABLE;
    failed.handoff_decision = "run_error";
    output.results.push(failed);
    console.log(`[${index + 1}/${questionsToRun.length}] ${question.id} RUN_ERROR ${error.message}`);
  }
  completed.add(question.id);
  writeJsonAtomic(RESULTS_PATH,output);
}
output.status = "completed_regression_diagnostic";
output.completed_at = isoNow();
output.summary = {
  processed:output.results.length,routes:countBy(output.results.map((item) => item.selected_route)),
  model_calls:output.results.filter((item) => item.model_call_attempted).length,
  successful_model_calls:output.results.filter((item) => item.raw_model_answer != null).length,
  grounding_valid:output.results.filter((item) => item.grounding_validation?.valid && item.raw_model_answer != null).length,
  grounding_fallbacks:output.results.filter((item) => item.selected_route === "GROUNDING_FALLBACK").length,
  run_errors:output.results.filter((item) => item.selected_route === "RUN_ERROR").length
};
writeJsonAtomic(RESULTS_PATH,output);
manifest.status = output.summary.run_errors ? "completed_with_run_errors" : "completed_regression_diagnostic";
manifest.completed_at = output.completed_at;
manifest.result_sha256 = hashFile(RESULTS_PATH);
manifest.generation_attempt_ledger_sha256 = hashFile(ATTEMPT_LEDGER_PATH);
writeJsonAtomic(MANIFEST_PATH,manifest);
writeTextAtomic(resolve(OUTPUT_ROOT,"post-fix-results.md"),`# Phase 5 Post-fix Regression\n\nCompleted: ${output.completed_at}\n\nThis run used the 69 owner-approved regression items. No gold answer, rubric, expected route or sealed unseen answer was supplied to the model. This is diagnostic regression, not model-selection scoring.\n\n${markdownTable(["Metric","Count"],[["Processed",output.summary.processed],["Model calls",output.summary.model_calls],["Grounded model answers",output.summary.grounding_valid],["Grounding fallbacks",output.summary.grounding_fallbacks],["Run errors",output.summary.run_errors]])}\n\n## Routes\n\n${markdownTable(["Route","Count"],Object.entries(output.summary.routes))}\n`);
console.log(JSON.stringify({ phase:"Phase 5 post-fix regression",status:manifest.status,summary:output.summary,output_root:OUTPUT_ROOT },null,2));
