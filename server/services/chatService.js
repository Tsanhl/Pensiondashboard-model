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
import { processQuery } from "./queryProcessorService.js";
import { generateLocalAnswer } from "./localModelService.js";
import { buildModelContext } from "./modelContextService.js";
import { publicSources, SAFE_TEMPLATES, validateGroundedAnswer } from "./groundingService.js";
import { requestLogContext, safeLog } from "./debugLoggingService.js";
import { ANSWER_POLICY_VERSION, ANSWER_SYSTEM_POLICY } from "../prompts/answerPolicy.js";
import { renderCitationMarkers } from "./citationRendererService.js";
import { evidencePolicyResponse } from "./evidencePolicyService.js";

const POLICY_VERSION = ANSWER_POLICY_VERSION;

function providersFromDashboard(dashboard = {}) {
  return (dashboard.pensionAccounts || []).map((item) => item.provider).filter(Boolean);
}

function summarise(messages = [], previousSummary = "") {
  const earlier = messages.length > 20 ? messages.slice(0, -20) : [];
  const selected = earlier.length ? earlier.slice(-8) : messages.slice(-6);
  return [previousSummary, ...selected.map((item) => `${item.role}: ${String(item.content).slice(0,180)}`)].filter(Boolean).join(" | ").slice(-1400);
}

function riskClarification(question, dashboard, riskProfile) {
  if (!/\b(invest|allocation|fund|risk|switch|growth|balanced|cautious)\b/i.test(question) || riskProfile?.completed) return null;
  return `Before I can ground an investment-style explanation in your circumstances, please provide: preferred style (cautious, balanced, or growth), years until you expect to use the pension, temporary loss tolerance, main goal, and any guarantees, transfer concerns, or charges that must be checked. Your current verified allocation remains unchanged.`;
}

export function selectModelSources(sources = [], query = {}, limit = 6) {
  const count = Math.max(1, Number(limit) || 1);
  if (query.response_route !== "SECURITY_FALLBACK") return sources.slice(0, count);
  // A personal pronoun in a scam question must not put account metadata ahead
  // of the official safety evidence needed for the warning and handoff.
  const safetyRelevance = (source) => {
    const title = String(source.title || "");
    const text = `${title} ${source.section || ""} ${source.snippet || ""}`;
    let score = 0;
    if (/\b(?:scam|fraud)\b/i.test(title)) score += 6;
    if (/\b(?:scam(?:med|s)?|fraud|unsolicited|pressur(?:e|ed|ing)|cold call)\b/i.test(text)) score += 4;
    if (/\b(?:stop contact|do not (?:transfer|pay|share)|verify|independent(?:ly)?|red flag|amber flag|moneyhelper)\b/i.test(text)) score += 2;
    if (/\b(?:The Pensions Regulator|Financial Conduct Authority|MoneyHelper)\b/i.test(String(source.authority || ""))) score += 1;
    return score;
  };
  return sources
    .map((source, index) => ({ source, index }))
    .sort((left, right) => {
      const leftPublic = left.source.scope === "CURATED_PUBLIC" ? 1 : 0;
      const rightPublic = right.source.scope === "CURATED_PUBLIC" ? 1 : 0;
      return rightPublic - leftPublic ||
        safetyRelevance(right.source) - safetyRelevance(left.source) ||
        left.index - right.index;
    })
    .slice(0, count)
    .map(({ source }) => source);
}

async function persistAssistant({ userId, sessionId, requestId, response, sources, confidence, query, validation, retrievalTrace = null, handoff = null }) {
  const assistant = await appendConversationMessage(userId, sessionId, {
    role:"assistant", content:response, sources, metadata:{ requestId,confidence,query,validation,retrievalTrace,handoff,policyVersion:POLICY_VERSION }
  });
  const conversation = await getConversation(userId, sessionId);
  await updateConversation(userId, sessionId, {
    summary:summarise(conversation.messages, conversation.summary),
    resolvedEntities:{ ...(conversation.resolvedEntities || {}), ...(query?.entities || {}) },
    state:{ ...(conversation.state || {}), pendingClarification:confidence === "needs_clarification" ? "risk_profile" : null, handoff }
  });
  return assistant;
}

export async function runChat({ userId, sessionId, clientRequestId, message, onEvent = () => {}, abortSignal }) {
  const requestId = String(clientRequestId || "").trim();
  const question = String(message || "").trim();
  if (!requestId || requestId.length > 160) throw Object.assign(new Error("client_request_id is required and must be at most 160 characters."), { status:400 });
  if (!question || question.length > 6000) throw Object.assign(new Error("message is required and must be at most 6000 characters."), { status:400 });
  const prior = await findMessageByRequest(userId, requestId);
  if (prior) {
    const conversation = await getConversation(userId, prior.sessionId);
    const answer = conversation?.messages?.find((item) => item.role === "assistant" && item.metadata?.requestId === requestId);
    if (answer) return { session_id:prior.sessionId,message_id:answer.id,response:answer.content,sources:answer.sources || [],confidence:answer.metadata?.confidence || "grounded",handoff:answer.metadata?.handoff || null,idempotent:true };
  }
  let conversation = sessionId ? await getConversation(userId, sessionId) : null;
  if (sessionId && !conversation) throw Object.assign(new Error("Conversation not found."), { status:404 });
  if (!conversation) conversation = await createConversation(userId);
  await appendConversationMessage(userId, conversation.id, { role:"user",content:question,clientRequestId:requestId,metadata:{} });
  onEvent("chat.accepted", { session_id:conversation.id,request_id:requestId });
  onEvent("chat.status", { status:"processing_query" });
  const dashboard = getVerifiedDashboardContext({ userId });
  const latestMessages = conversation.messages.slice(-20);
  const query = processQuery(question, {
    summary:conversation.summary,
    resolvedEntities:conversation.resolvedEntities,
    lastUserMessage:[...latestMessages].reverse().find((item) => item.role === "user")?.content || "",
    providers:providersFromDashboard(dashboard),
    latestMessages
  });
  const policyResponse = evidencePolicyResponse(question);
  if (policyResponse) {
    const handoff = query.response_route === "ANSWER_AND_HANDOFF" ? { reason:query.handoff_reason || "scheme_document_review",response_route:query.response_route } : null;
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:policyResponse,sources:[],confidence:handoff ? "grounded_with_handoff" : "grounded",query,validation:{ valid:true,reason:"deterministic_evidence_policy" },handoff });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:handoff ? "grounded_with_handoff" : "grounded",handoff };
  }
  if (["HUMAN_HANDOFF","REFUSE_ACTION"].includes(query.response_route)) {
    const reason = query.handoff_reason || query.intent;
    safeLog("fallbacks", { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason,template:"HUMAN_HANDOFF",responseRoute:query.response_route });
    const actionDecision = query.response_route === "REFUSE_ACTION" ? "refused_prohibited_action" : "read_only_handoff";
    const response = query.response_route === "REFUSE_ACTION" ? SAFE_TEMPLATES.REFUSE_ACTION : SAFE_TEMPLATES.HUMAN_HANDOFF;
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response,sources:[],confidence:"handoff",query,validation:{ valid:true,reason:actionDecision },handoff:{ reason,response_route:query.response_route } });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"handoff",handoff:{ reason,response_route:query.response_route } };
  }
  const riskPrompt = query.response_route === "ANSWER" ? riskClarification(question, dashboard, readRiskProfile(userId)) : null;
  if (riskPrompt) {
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:riskPrompt,sources:[],confidence:"needs_clarification",query,validation:{ valid:true,reason:"risk_profile_required" } });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"needs_clarification",handoff:null };
  }
  if (query.needs_clarification) {
    const response = query.clarification_reason === "jurisdiction_ambiguity"
      ? (query.clarification_prompt || "Please tell me whether this concerns Great Britain or Northern Ireland, because the applicable pension legislation may differ.")
      : "I found more than one pension account. Please name the provider or policy so I do not apply details from the wrong account.";
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response,sources:[],confidence:"needs_clarification",query,validation:{ valid:true,reason:query.clarification_reason || "ambiguity" } });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"needs_clarification",handoff:null };
  }
  onEvent("chat.status", { status:"retrieving" });
  const retrieval = await retrieveForQuery({ userId,sessionId:conversation.id,requestId,queryPlan:query,limit:8 });
  const sources = retrieval.sources;
  if (!sources.length || (query.freshness_required && !sources.some((source) => source.scope === "CURATED_PUBLIC" && source.effectiveDate))) {
    const missingEvidenceTemplate = query.response_route === "SECURITY_FALLBACK" ? "SECURITY_FALLBACK" : "INSUFFICIENT_EVIDENCE";
    const missingEvidenceHandoff = { reason:query.response_route === "SECURITY_FALLBACK" ? (query.handoff_reason || "possible_pension_scam") : "evidence_review",response_route:query.response_route };
    safeLog("fallbacks", { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:"missing_or_stale_sources",template:missingEvidenceTemplate,retrievalTrace:retrieval.trace });
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:SAFE_TEMPLATES[missingEvidenceTemplate],sources:[],confidence:"insufficient_verified_evidence",query,validation:{ valid:false,reason:"missing_or_stale_sources" },retrievalTrace:retrieval.trace,handoff:missingEvidenceHandoff });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"insufficient_verified_evidence",handoff:missingEvidenceHandoff };
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
    generated = await generateLocalAnswer({ system:ANSWER_SYSTEM_POLICY,...modelContext,signal:abortSignal });
  } catch (error) {
    if (abortSignal?.aborted) throw Object.assign(new Error("Chat generation was cancelled."), { status:499,code:"CHAT_CANCELLED" });
    const modelError = typeof error.code === "string" ? error.code : error.name || "model_unavailable";
    safeLog("fallbacks", { ...requestLogContext({ userId,sessionId:conversation.id,requestId,query }),reason:modelError,template:"MODEL_UNAVAILABLE" });
    const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response:SAFE_TEMPLATES.MODEL_UNAVAILABLE,sources:[],confidence:"model_unavailable",query,validation:{ valid:false,reason:modelError },retrievalTrace:retrieval.trace });
    appendAuditEvent(userId, { type:"assistant_model_unavailable",requestId,message:error.message });
    return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:[],confidence:"model_unavailable",handoff:null };
  }
  onEvent("chat.status", { status:"validating" });
  const rendered = renderCitationMarkers({ answer:generated.answer,citationIds:generated.citationIds,sources:modelSources });
  const validation = rendered.valid
    ? validateGroundedAnswer({ answer:rendered.answer,citationIds:rendered.citationIds,sources:modelContext.evidenceSources,intent:query.intent,legalEvidenceRequired:query.legal_evidence_required,userSuppliedText:query.self_contained_query })
    : { valid:false,reason:rendered.inventedCitationIds.length ? "invented_citation" : "citation_render_failure",inventedCitationIds:rendered.inventedCitationIds,hiddenCitationIds:rendered.hiddenCitationIds,missingCitationMetadataIds:rendered.missingCitationMetadataIds };
  const grounded = validation.valid;
  const fallbackTemplate = query.response_route === "SECURITY_FALLBACK" ? "SECURITY_FALLBACK" : "INSUFFICIENT_EVIDENCE";
  const response = grounded
    ? query.response_route === "SECURITY_FALLBACK" ? `${SAFE_TEMPLATES.SECURITY_LEAD} ${rendered.answer}` : rendered.answer
    : SAFE_TEMPLATES[fallbackTemplate];
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
  const assistant = await persistAssistant({ userId,sessionId:conversation.id,requestId,response,sources:cited,confidence,query,validation,retrievalTrace:retrieval.trace,handoff:requiredHandoff });
  appendAuditEvent(userId, { type:"assistant_answer",requestId,sessionId:conversation.id,model:generated.model,policyVersion:POLICY_VERSION,intent:query.intent,responseRoute:query.response_route,confidence,retrievalHash:createHash("sha256").update(sources.map((source)=>source.sourceId).join("|")).digest("hex") });
  return { session_id:conversation.id,message_id:assistant.id,response:assistant.content,sources:cited,confidence,handoff:requiredHandoff };
}
