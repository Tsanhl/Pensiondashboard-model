import { createHash } from "node:crypto";
import { getVerifiedDashboardContext } from "../portfolioStore.js";
import { appendAuditEvent, readRiskProfile } from "../store/userDataStore.js";
import {
  appendConversationMessage,
  createConversation,
  findMessageByRequest,
  getConversation,
  updateConversation
} from "../repositories/conversationRepository.js";
import { retrieveForQuery } from "./retrievalService.js";
import { lookupStructuredData } from "./structuredDataService.js";
import { processQuery } from "./queryProcessorService.js";
import { generateLocalAnswerWithRetry } from "./localModelService.js";
import { buildModelContext } from "./modelContextService.js";
import { publicSources, SAFE_TEMPLATES, validateGroundedAnswer, stripUnsupportedLegalCycles, completePresentLegalFacts } from "./groundingService.js";
import { requestLogContext, safeLog } from "./debugLoggingService.js";
import { ANSWER_POLICY_VERSION, ANSWER_SYSTEM_POLICY } from "../prompts/answerPolicy.js";
import { attachCitationMarkers,renderCitationMarkers } from "./citationRendererService.js";
import { evidencePolicyResponse } from "./evidencePolicyService.js";
import { selectMandatorySources, isSchemeChangeAuthority, filterSourcesForQuery } from "./evidenceContractService.js";
import { deterministicDashboardAnswer, personalisedAdviceBoundaryAnswer } from "./deterministicAnswerService.js";
import { sanitizeSafetyWording, deathBenefitOutcomeUnsafe, DEATH_BENEFIT_FAIL_CLOSED } from "./safetyWordingService.js";
import { legalSchemeChangeQuestion } from "./queryProcessorService.js";
import {
  qualificationFixtureSource,
  qualificationPublicOnlyPlan,
  qualificationQueryContext,
  qualificationRuntimeEnabled,
} from "./qualificationContextService.js";

const POLICY_VERSION = ANSWER_POLICY_VERSION;

function providersFromDashboard(dashboard = {}) {
  return (dashboard.pensionAccounts || []).map((item) => item.provider).filter(Boolean);
}

function summarise(messages = [], previousSummary = "") {
  const earlier = messages.length > 20 ? messages.slice(0, -20) : [];
  const selected = earlier.length ? earlier.slice(-8) : messages.slice(-6);
  return [previousSummary, ...selected.map((item) => `${item.role}: ${String(item.content).slice(0,180)}`)].filter(Boolean).join(" | ").slice(-1400);
}

export function requiresRiskProfileClarification(question, riskProfile) {
  if (riskProfile?.completed) return false;
  // "fund" is too broad in this domain (PPF, pension fund, fund documents).
  return /\b(invest|allocation|risk|switch|growth|balanced|cautious)\b/i.test(String(question || ""));
}

function riskClarification(question, dashboard, riskProfile) {
  if (!requiresRiskProfileClarification(question, riskProfile)) return null;
  return `Before I can ground an investment-style explanation in your circumstances, please provide: preferred style (cautious, balanced, or growth), years until you expect to use the pension, temporary loss tolerance, main goal, and any guarantees, transfer concerns, or charges that must be checked. Your current verified allocation remains unchanged.`;
}

export function selectModelSources(sources = [], query = {}, limit = 6) {
  return selectMandatorySources(sources, query, limit);
}

function hasPersonalEvidence(sources = []) {
  return sources.some((source) => source.scope === "USER_PORTFOLIO" || source.scope === "USER_DOCUMENTS" || String(source.sourceId || "").startsWith("structured_"));
}

function hasCurrentPublic(sources = []) {
  return sources.some((source) => source.scope === "CURATED_PUBLIC" && source.effectiveDate);
}

function finishAnswer(text) {
  return sanitizeSafetyWording(text);
}

function qualificationAttempts({ modelCallAttempted = false, attempts = 0, retryUsed = false, retryReason = null, runtimeIdentity = null, generationAttemptLedger = [], recoveredFromTruncation = false } = {}) {
  if (String(process.env.QUALIFICATION_ATTEMPT_TELEMETRY || "false").toLowerCase() !== "true") return {};
  return { qualification_attempts: {
    model_call_attempted:modelCallAttempted,generation_attempts:attempts,retry_used:retryUsed,retry_reason:retryReason,
    generation_attempt_ledger:Array.isArray(generationAttemptLedger) ? generationAttemptLedger : [],
    recovered_from_truncation:Boolean(recoveredFromTruncation),
  },runtime_identity:runtimeIdentity };
}

async function persistAssistant({ userId, sessionId, requestId, response, sources, confidence, query, validation, retrievalTrace = null, handoff = null, claimCitations = [], reviewAnswer = null, qualificationAttemptEvidence = qualificationAttempts() }) {
  const assistant = await appendConversationMessage(userId, sessionId, {
    role:"assistant", content:response, sources, metadata:{
      requestId,confidence,query,validation,retrievalTrace,handoff,claimCitations,reviewAnswer,policyVersion:POLICY_VERSION,
      qualificationAttempts:qualificationAttemptEvidence.qualification_attempts || null,
      qualificationRuntimeIdentity:qualificationAttemptEvidence.runtime_identity || null,
    }
  });
  const conversation = await getConversation(userId, sessionId);
  await updateConversation(userId, sessionId, {
    summary:summarise(conversation.messages, conversation.summary),
    resolvedEntities:{ ...(conversation.resolvedEntities || {}), ...(query?.entities || {}) },
    state:{ ...(conversation.state || {}), pendingClarification:confidence === "needs_clarification" ? "risk_profile" : null, handoff }
  });
  return assistant;
}

export async function runChat({ userId, sessionId, clientRequestId, message, onEvent = () => {}, abortSignal, maxModelAttempts, qualificationContext = null, qualificationContextSha256 = null }) {
  const requestId = String(clientRequestId || "").trim();
  const question = String(message || "").trim();
  const requestMessageSha256 = createHash("sha256").update(question).digest("hex");
  if (qualificationContext && (!qualificationRuntimeEnabled() || !/^[0-9a-f]{64}$/.test(String(qualificationContextSha256 || "")))) {
    throw Object.assign(new Error("Qualification context requires the formal qualification runtime and its bound SHA-256."), { status:403,code:"INVALID_QUALIFICATION_CONTEXT" });
  }
  if (!qualificationContext && qualificationContextSha256) {
    throw Object.assign(new Error("A qualification context SHA-256 was supplied without qualification context."), { status:400,code:"INVALID_QUALIFICATION_CONTEXT" });
  }
  if (!requestId || requestId.length > 160) throw Object.assign(new Error("client_request_id is required and must be at most 160 characters."), { status:400 });
  if (!question || question.length > 6000) throw Object.assign(new Error("message is required and must be at most 6000 characters."), { status:400 });
  const prior = await findMessageByRequest(userId, requestId);
  if (prior) {
    const storedQualificationContextSha256 = prior.metadata?.qualificationContextSha256 || null;
    const storedMessageSha256 = prior.metadata?.requestMessageSha256 || createHash("sha256").update(String(prior.content || "").trim()).digest("hex");
    if (storedQualificationContextSha256 !== qualificationContextSha256 || storedMessageSha256 !== requestMessageSha256) {
      throw Object.assign(new Error("client_request_id was already used with a different message or qualification context."), { status:409,code:"QUALIFICATION_CONTEXT_REPLAY_MISMATCH" });
    }
    const conversation = await getConversation(userId, prior.sessionId);
    const answer = conversation?.messages?.find((item) => item.role === "assistant" && item.metadata?.requestId === requestId);
    if (answer) {
      const storedAttemptEvidence = answer.metadata?.qualificationAttempts
        ? { qualification_attempts:answer.metadata.qualificationAttempts,runtime_identity:answer.metadata?.qualificationRuntimeIdentity || null }
        : qualificationAttempts();
      return { session_id:prior.sessionId,message_id:answer.id,response:answer.content,sources:answer.sources || [],confidence:answer.metadata?.confidence || "grounded",handoff:answer.metadata?.handoff || null,response_route:answer.metadata?.query?.response_route || answer.metadata?.handoff?.response_route || null,jurisdiction_scope:answer.metadata?.query?.jurisdiction_scope || null,claim_citations:answer.metadata?.claimCitations || [],review_answer:answer.metadata?.reviewAnswer || answer.content,idempotent:true,...storedAttemptEvidence };
    }
  }
  let conversation = sessionId ? await getConversation(userId, sessionId) : null;
  if (sessionId && !conversation) throw Object.assign(new Error("Conversation not found."), { status:404 });
  if (!conversation) conversation = await createConversation(userId);
  await appendConversationMessage(userId, conversation.id, {
    role:"user",content:question,clientRequestId:requestId,
    metadata:{ requestMessageSha256,...(qualificationContextSha256 ? { qualificationContextSha256 } : {}) },
  });
  onEvent("chat.accepted", { session_id:conversation.id,request_id:requestId });
  onEvent("chat.status", { status:"processing_query" });
  const dashboard = getVerifiedDashboardContext({ userId });
  const latestMessages = qualificationContext ? qualificationContext.conversation_context : conversation.messages.slice(-20);
  const queryContext = qualificationContext ? qualificationQueryContext(qualificationContext, question) : {
    summary:conversation.summary,
    resolvedEntities:conversation.resolvedEntities,
    lastUserMessage:[...latestMessages].reverse().find((item) => item.role === "user")?.content || "",
    providers:providersFromDashboard(dashboard),
    latestMessages,
    profileJurisdiction:dashboard.profile?.jurisdiction || ""
  };
  const query = processQuery(question, queryContext);
  const policyResponse = evidencePolicyResponse(question);
  if (policyResponse) {
    const handoff = query.response_route === "ANSWER_AND_HANDOFF" ? { reason:query.handoff_reason || "scheme_document_review",response_route:query.response_route } : null;
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:finishAnswer(policyResponse),sources:[],confidence:handoff ? "grounded_with_handoff" : "grounded",query,validation:{ valid:true,reason:"deterministic_evidence_policy" },handoff });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:handoff ? "grounded_with_handoff" : "grounded",handoff,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,...qualificationAttempts() };
  }
  if (["HUMAN_HANDOFF","REFUSE_ACTION"].includes(query.response_route)) {
    const reason = query.handoff_reason || query.intent;
    safeLog("fallbacks", { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason,template:"HUMAN_HANDOFF",responseRoute:query.response_route });
    const actionDecision = query.response_route === "REFUSE_ACTION" ? "refused_prohibited_action" : "read_only_handoff";
    const response = query.response_route === "REFUSE_ACTION" ? SAFE_TEMPLATES.REFUSE_ACTION : SAFE_TEMPLATES.HUMAN_HANDOFF;
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:finishAnswer(response),sources:[],confidence:"handoff",query,validation:{ valid:true,reason:actionDecision },handoff:{ reason,response_route:query.response_route } });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"handoff",handoff:{ reason,response_route:query.response_route },response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,...qualificationAttempts() };
  }
  const riskPrompt = !qualificationContext && query.response_route === "ANSWER" ? riskClarification(question, dashboard, readRiskProfile(userId)) : null;
  if (riskPrompt) {
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:riskPrompt,sources:[],confidence:"needs_clarification",query,validation:{ valid:true,reason:"risk_profile_required" } });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"needs_clarification",handoff:null,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,...qualificationAttempts() };
  }
  if (query.needs_clarification) {
    const response = query.clarification_reason === "jurisdiction_ambiguity"
      ? (query.clarification_prompt || "Please tell me whether this concerns Great Britain or Northern Ireland, because the applicable pension legislation may differ.")
      : "I found more than one pension account. Please name the provider or policy so I do not apply details from the wrong account.";
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response,sources:[],confidence:"needs_clarification",query,validation:{ valid:true,reason:query.clarification_reason || "ambiguity" } });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"needs_clarification",handoff:null,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,...qualificationAttempts() };
  }
  const structured = qualificationContext
    ? { sources:[qualificationFixtureSource(qualificationContext)] }
    : lookupStructuredData(userId, {
      ...query,
      structured_lookups:[...new Set([...(query.structured_lookups || []), "account", "charges", "document_status", "projection", "investment_profile"])]
    });
  const deterministic = !qualificationContext && ["ANSWER", "ANSWER_AND_HANDOFF"].includes(query.response_route)
    ? deterministicDashboardAnswer(question, { userId, sources:structured.sources })
    : null;
  if (deterministic?.answer) {
    const deterministicSources = deterministic.sources?.length ? deterministic.sources : structured.sources;
    const renderedDeterministic = renderCitationMarkers({
      answer:attachCitationMarkers(deterministic.answer,deterministic.citationIds || []),
      citationIds:deterministic.citationIds || [],
      sources:deterministicSources
    });
    const deterministicValidation = renderedDeterministic.valid
      ? validateGroundedAnswer({ answer:renderedDeterministic.answer,citationIds:renderedDeterministic.citationIds,sources:deterministicSources,intent:query.intent,legalEvidenceRequired:false,userSuppliedText:query.self_contained_query,claimLevel:true,claimCitations:renderedDeterministic.claimCitations })
      : { valid:false,reason:"citation_render_failure" };
    if (!deterministicValidation.valid) {
      safeLog("grounding-failures",{ ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:deterministicValidation.reason,deterministicReason:deterministic.reason });
    } else {
    const response = finishAnswer(renderedDeterministic.answer);
    const cited = publicSources(deterministicSources, renderedDeterministic.citationIds);
    const handoff = query.response_route === "ANSWER_AND_HANDOFF"
      ? { reason:query.handoff_reason || "regulated_personalised_advice",response_route:query.response_route }
      : null;
    const assistant = await persistAssistant({
      userId,sessionId:conversation.id,requestId,response,sources:cited,
      confidence:handoff ? "grounded_with_handoff" : "grounded",query,
      validation:{ ...deterministicValidation,reason:deterministic.reason || deterministicValidation.reason },
      handoff,claimCitations:renderedDeterministic.claimCitations,
      reviewAnswer:renderedDeterministic.claimCitations.map((entry) => entry.claim).join(" ")
    });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:cited,confidence:handoff ? "grounded_with_handoff" : "grounded",handoff,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,claim_citations:renderedDeterministic.claimCitations,review_answer:renderedDeterministic.claimCitations.map((entry) => entry.claim).join(" "),...qualificationAttempts() };
    }
  }
  if (query.handoff_reason === "regulated_personalised_advice") {
    const boundary = personalisedAdviceBoundaryAnswer(question, { userId, sources:structured.sources });
    if (boundary?.answer) {
      const boundarySources = boundary.sources?.length ? boundary.sources : structured.sources;
      const renderedBoundary = renderCitationMarkers({
        answer:attachCitationMarkers(boundary.answer,boundary.citationIds || []),
        citationIds:boundary.citationIds || [],
        sources:boundarySources
      });
      const boundaryValidation = renderedBoundary.valid
        ? validateGroundedAnswer({ answer:renderedBoundary.answer,citationIds:renderedBoundary.citationIds,sources:boundarySources,intent:query.intent,legalEvidenceRequired:false,userSuppliedText:query.self_contained_query,claimLevel:true,claimCitations:renderedBoundary.claimCitations })
        : { valid:false,reason:"citation_render_failure" };
      if (!boundaryValidation.valid) {
        safeLog("grounding-failures",{ ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:boundaryValidation.reason,deterministicReason:boundary.reason });
      } else {
      const response = finishAnswer(renderedBoundary.answer);
      const cited = publicSources(boundarySources, renderedBoundary.citationIds);
      const handoff = { reason:query.handoff_reason,response_route:query.response_route };
      const assistant = await persistAssistant({
        userId,sessionId:conversation.id,requestId,response,sources:cited,
        confidence:"grounded_with_handoff",query,
        validation:{ ...boundaryValidation,reason:boundary.reason || boundaryValidation.reason },
        handoff,claimCitations:renderedBoundary.claimCitations,
        reviewAnswer:renderedBoundary.claimCitations.map((entry) => entry.claim).join(" ")
      });
      return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:cited,confidence:"grounded_with_handoff",handoff,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,claim_citations:renderedBoundary.claimCitations,review_answer:renderedBoundary.claimCitations.map((entry) => entry.claim).join(" "),...qualificationAttempts() };
      }
    }
  }
  onEvent("chat.status", { status:"retrieving" });
  const retrievalPlan = qualificationContext ? qualificationPublicOnlyPlan(query) : query;
  const retrieval = retrievalPlan.source_scopes.length
    ? await retrieveForQuery({ userId,sessionId:conversation.id,requestId,queryPlan:retrievalPlan,limit:8 })
    : { sources:[],trace:{ scopes:[],noResult:true,qualification_fixture_only:Boolean(qualificationContext) } };
  const sources = filterSourcesForQuery(qualificationContext ? [...structured.sources,...retrieval.sources] : retrieval.sources, query);
  const personalPresent = hasPersonalEvidence(sources);
  const publicPresent = hasCurrentPublic(sources);
  const schemeChangeAuthorityPresent = sources.some((source) => source.scope === "CURATED_PUBLIC" && isSchemeChangeAuthority(source));
  const missingRequiredEvidence = !sources.length
    || (query.response_route === "SECURITY_FALLBACK" && !publicPresent)
    || (query.freshness_required && !publicPresent && !personalPresent)
    || (legalSchemeChangeQuestion(question) && !schemeChangeAuthorityPresent);
  if (missingRequiredEvidence) {
    const missingEvidenceTemplate = query.response_route === "SECURITY_FALLBACK" ? "SECURITY_FALLBACK" : "INSUFFICIENT_EVIDENCE";
    const missingEvidenceHandoff = { reason:query.response_route === "SECURITY_FALLBACK" ? (query.handoff_reason || "possible_pension_scam") : "evidence_review",response_route:query.response_route };
    safeLog("fallbacks", { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:"missing_or_stale_sources",template:missingEvidenceTemplate,retrievalTrace:retrieval.trace });
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:finishAnswer(SAFE_TEMPLATES[missingEvidenceTemplate]),sources:[],confidence:"insufficient_verified_evidence",query,validation:{ valid:false,reason:"missing_or_stale_sources" },retrievalTrace:retrieval.trace,handoff:missingEvidenceHandoff });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"insufficient_verified_evidence",handoff:missingEvidenceHandoff,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,...qualificationAttempts() };
  }
  onEvent("chat.status", { status:"generating" });
  const modelSources = selectModelSources(
    sources,
    query,
    Number(process.env.LLM_CONTEXT_SOURCE_LIMIT || 6),
  );
  const modelContext = buildModelContext(query, modelSources, { history:latestMessages, snippetChars:Number(process.env.LLM_SOURCE_SNIPPET_CHARS || 1000) });
  let generated;
  try {
    generated = await generateLocalAnswerWithRetry({ system:ANSWER_SYSTEM_POLICY,...modelContext,signal:abortSignal,maxAttempts:maxModelAttempts });
  } catch (error) {
    if (abortSignal?.aborted) throw Object.assign(new Error("Chat generation was cancelled."), { status:499,code:"CHAT_CANCELLED" });
    const modelError = typeof error.code === "string" ? error.code : error.name || "model_unavailable";
    safeLog("fallbacks", { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:modelError,template:"MODEL_UNAVAILABLE" });
    const qualificationAttemptEvidence = qualificationAttempts({ modelCallAttempted:true,attempts:Number(error.attempts || 1),retryUsed:Number(error.attempts || 1) > 1,retryReason:error.retry_reason || null,runtimeIdentity:error.modelResponse?.runtimeIdentity || null,generationAttemptLedger:error.generation_attempt_ledger || [],recoveredFromTruncation:false });
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:finishAnswer(SAFE_TEMPLATES.MODEL_UNAVAILABLE),sources:[],confidence:"model_unavailable",query,validation:{ valid:false,reason:modelError },retrievalTrace:retrieval.trace,qualificationAttemptEvidence });
    appendAuditEvent(userId, { type:"assistant_model_unavailable",requestId,message:error.message });
    return {
      session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"model_unavailable",handoff:null,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,
      ...qualificationAttemptEvidence,
    };
  }
  onEvent("chat.status", { status:"validating" });
  const completed = completePresentLegalFacts(question, generated.answer, modelSources);
  const evidenceText = modelSources.map((source) => `${source.title || ""}\n${source.oscolaCitation || ""}\n${source.snippet || ""}`).join("\n");
  const cycleCheckedRaw = stripUnsupportedLegalCycles(completed.answer,evidenceText);
  const rendered = renderCitationMarkers({
    answer:cycleCheckedRaw,
    citationIds:[...new Set([...(generated.citationIds || []), ...(completed.addedCitationIds || [])])],
    sources:modelSources
  });
  const cycleChecked = rendered.answer;
  const validation = rendered.valid
    ? validateGroundedAnswer({ answer:cycleChecked,citationIds:rendered.citationIds,sources:modelContext.evidenceSources,intent:query.intent,legalEvidenceRequired:query.legal_evidence_required,userSuppliedText:query.self_contained_query,claimLevel:Boolean(query.personal_dashboard_primary),claimCitations:rendered.claimCitations })
    : { valid:false,reason:rendered.inventedCitationIds.length ? "invented_citation" : "citation_render_failure",inventedCitationIds:rendered.inventedCitationIds,hiddenCitationIds:rendered.hiddenCitationIds,missingCitationMetadataIds:rendered.missingCitationMetadataIds };
  const grounded = validation.valid;
  const fallbackTemplate = query.response_route === "SECURITY_FALLBACK" ? "SECURITY_FALLBACK" : "INSUFFICIENT_EVIDENCE";
  let response = grounded
    ? query.response_route === "SECURITY_FALLBACK" ? `${SAFE_TEMPLATES.SECURITY_LEAD} ${cycleChecked}` : cycleChecked
    : SAFE_TEMPLATES[fallbackTemplate];
  if (grounded && deathBenefitOutcomeUnsafe(question, response)) {
    response = DEATH_BENEFIT_FAIL_CLOSED;
  }
  response = finishAnswer(response);
  const claimCitations = grounded && response !== finishAnswer(DEATH_BENEFIT_FAIL_CLOSED) ? rendered.claimCitations : [];
  const reviewAnswer = claimCitations.length
    ? `${query.response_route === "SECURITY_FALLBACK" ? `${SAFE_TEMPLATES.SECURITY_LEAD} ` : ""}${claimCitations.map((entry) => entry.claim).join(" ")}`.trim()
    : response;
  const cited = grounded ? publicSources(modelContext.evidenceSources, validation.citationIds) : [];
  if (!grounded) {
    const category = ["invented_citation","missing_citation"].includes(validation.reason) ? "grounding-failures" : "grounding-failures";
    safeLog(category, { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:validation.reason,inventedCitationIds:validation.inventedCitationIds,unsupportedFigures:validation.unsupportedFigures,allowedSourceIds:modelSources.map((source) => source.sourceId),retrievalTrace:retrieval.trace });
    safeLog("fallbacks", { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:"grounding_validation",validationReason:validation.reason,template:fallbackTemplate });
  }
  const requiredHandoff = grounded && ["ANSWER_AND_HANDOFF","SECURITY_FALLBACK"].includes(query.response_route)
    ? { reason:query.handoff_reason || "human_review",response_route:query.response_route }
    : grounded ? null : { reason:query.response_route === "SECURITY_FALLBACK" ? (query.handoff_reason || "possible_pension_scam") : "grounding_validation",response_route:query.response_route };
  const confidence = grounded ? (requiredHandoff ? "grounded_with_handoff" : "grounded") : "insufficient_verified_evidence";
  const qualificationAttemptEvidence = qualificationAttempts({ modelCallAttempted:true,attempts:Number(generated.generation_attempts || (generated.retry_used ? 2 : 1)),retryUsed:Boolean(generated.retry_used),retryReason:generated.retry_reason || null,runtimeIdentity:generated.runtimeIdentity || null,generationAttemptLedger:generated.generation_attempt_ledger || [],recoveredFromTruncation:Boolean(generated.recoveredFromTruncation) });
  const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response,sources:cited,confidence,query,validation,retrievalTrace:retrieval.trace,handoff:requiredHandoff,claimCitations,reviewAnswer,qualificationAttemptEvidence });
  appendAuditEvent(userId, { type:"assistant_answer",requestId,sessionId:conversation.id,model:generated.model,policyVersion:POLICY_VERSION,intent:query.intent,responseRoute:query.response_route,confidence,retrievalHash:createHash("sha256").update(sources.map((source)=>source.sourceId).join("|")).digest("hex") });
  return {
    session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:cited,confidence,handoff:requiredHandoff,response_route:query.response_route,jurisdiction_scope:query.jurisdiction_scope,claim_citations:claimCitations,review_answer:reviewAnswer,
    ...qualificationAttemptEvidence,
  };
}
