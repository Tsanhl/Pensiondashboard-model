import { createHash,randomUUID } from "node:crypto";
import { identityDifferences } from "./postTrainingVisibleQualificationV1.mjs";
import { mintCustodianCapability,verifyCustodianBodySignature } from "../../server/services/custodianContextService.js";

const GENERATION_CONFIG = Object.freeze({ temperature:0,topP:1,maxTokens:400,seed:42 });
const MODEL_CONTEXT_CONFIG = Object.freeze({ sourceLimit:3,snippetChars:800 });
const PUBLIC_USER_ID = "evaluation-cycle-v1-sealed-one-shot";

function runnerError(code) {
  return Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function parseConversationContext(context = []) {
  return context.map((entry) => {
    if (typeof entry === "object" && entry && ["user", "assistant"].includes(entry.role)) {
      return { role:entry.role,content:String(entry.content || "") };
    }
    const value = String(entry || "");
    if (/^assistant\s*:/i.test(value)) return { role:"assistant",content:value.replace(/^assistant\s*:\s*/i, "") };
    return { role:"user",content:value.replace(/^user\s*:\s*/i, "") };
  }).filter((entry) => entry.content);
}

function jurisdictionFromFixture(values = {}, declared = null) {
  const known = new Set(["GREAT_BRITAIN", "NORTHERN_IRELAND", "ENGLAND_AND_WALES", "SCOTLAND", "GB_AND_NI", "UK_TAX"]);
  if (known.has(declared)) return declared;
  const candidates = [
    values.user_jurisdiction,values.jurisdiction,values.work_location,values.employment_location,
    values.divorce_jurisdiction,values.proceedings_location,values.company_location,
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
    ...(Array.isArray(values.providers) ? values.providers : []),
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function sanitisedContext(item) {
  const messages = parseConversationContext(item.conversation_context || []);
  const values = item.synthetic_fixture?.values || {};
  const resolvedEntities = {};
  const jurisdiction = jurisdictionFromFixture(values,item.jurisdiction);
  if (jurisdiction) resolvedEntities.jurisdiction = jurisdiction;
  if (values.resolved_provider) resolvedEntities.provider = values.resolved_provider;
  if (values.policy_number) resolvedEntities.policyNumber = values.policy_number;
  return {
    summary:"",resolvedEntities,providers:fixtureProviders(values),latestMessages:messages,
    lastUserMessage:[...messages].reverse().find((entry) => entry.role === "user")?.content || String(item.question || ""),
  };
}

function fixtureSource(item) {
  const fixture = item.synthetic_fixture;
  if (!fixture?.evidence_id) return null;
  return {
    sourceId:fixture.evidence_id,
    title:fixture.title || "Synthetic evaluation fixture",
    section:"Permitted synthetic dashboard fixture",
    scope:"USER_PORTFOLIO",
    score:1,
    effectiveDate:fixture.as_of_date || null,
    updatedAt:fixture.as_of_date || null,
    snippet:JSON.stringify(fixture.values || {}),
    authority:"Synthetic evaluation fixture",
    jurisdiction:jurisdictionFromFixture(fixture.values || {},item.jurisdiction) || "not specified",
    canonicalLocation:null,
    documentId:`synthetic-${sha256(item.id).slice(0,16)}`,
    version:1,
    sourceType:"verified_synthetic_fixture",
    sourceRole:"fixture",
    authorityRank:1,
    oscolaCitation:"Synthetic evaluation fixture",
  };
}

function publicOnlyPlan(query) {
  const personalScopes = new Set(["USER_PORTFOLIO", "USER_DOCUMENTS"]);
  const personalLookups = new Set(["account", "charges", "document_status", "projection", "investment_profile"]);
  return {
    ...query,
    source_scopes:(query.source_scopes || []).filter((scope) => !personalScopes.has(scope)),
    structured_lookups:(query.structured_lookups || []).filter((lookup) => !personalLookups.has(lookup)),
  };
}

export function filterPinnedCorpusSources(sources,{ documentIds = new Set(),structuredFactIds = new Set() } = {}) {
  return (sources || []).filter((source) => {
    if (source?.sourceType === "official_structured_tax_fact") {
      return structuredFactIds.has(String(source.sourceId || "").replace(/^structured_public_/, ""));
    }
    return documentIds.has(String(source?.documentId || ""));
  });
}

function minimalValidation(value) {
  return { valid:value?.valid === true,reason:String(value?.reason || (value?.valid ? "valid" : "invalid")) };
}

function baseResult(fixture) {
  return {
    selectedRoute:null,
    selectedJurisdiction:"UNSPECIFIED",
    finalAnswer:"",
    reviewAnswer:"",
    generatedCitations:[],
    claimCitations:[],
    retrievedChunkIds:[],
    structuredFactIds:[],
    evidenceIds:fixture?.sourceId ? [fixture.sourceId] : [],
    groundingValidation:{ valid:false,reason:"not_run" },
    handoffDecision:"none",
    actionDecision:"read_only_no_tool_call",
    toolCalls:[],
  };
}

function assertFailClosedEnvironment() {
  const truthy = (name) => String(process.env[name] || "").toLowerCase() === "true";
  if (truthy("ALLOW_DEGRADED_EMBEDDINGS") || !truthy("REQUIRE_CROSS_ENCODER_RERANK") ||
    !truthy("DISABLE_DEBUG_LOGGING") || !truthy("DISABLE_RETRIEVAL_METRICS") ||
    !truthy("SEALED_UNSEEN_CUSTODIAN_MODE") ||
    String(process.env.DEBUG_LOG_INCLUDE_TEXT || "").toLowerCase() !== "false") {
    throw runnerError("SEALED_RUNNER_ENVIRONMENT_NOT_FAIL_CLOSED");
  }
}

export async function createSealedUnseenCaseRunner() {
  assertFailClosedEnvironment();
  const endpoint=String(process.env.SEALED_UNSEEN_CANONICAL_ENDPOINT || "");
  const runId=String(process.env.SEALED_UNSEEN_RUN_ID || "");
  const key=String(process.env.SEALED_UNSEEN_CONTEXT_HMAC_KEY || "");
  const timeoutMs=Number(process.env.SEALED_UNSEEN_CHAT_TIMEOUT_MS || 320_000);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(runId) || !/^[0-9a-f]{64}$/.test(key)) {
    throw runnerError("SEALED_CUSTODIAN_RUNTIME_NOT_CONFIGURED");
  }

  return async function runSealedCase(item,{ wave,expectedIdentity }) {
    const caseId=String(item.id || "");
    const clientRequestId=`sealed-${sha256(`${wave}:${caseId}`).slice(0,20)}-${randomUUID()}`;
    const fixture=item.synthetic_fixture || { evidence_id:`sealed-fixture-${sha256(caseId).slice(0,16)}`,title:"Synthetic sealed evaluation fixture",values:{} };
    const context={ version:"sealed-unseen-synthetic-context-v1",case_id:caseId,declared_jurisdiction:jurisdictionFromFixture(fixture.values || {},item.jurisdiction) || "UNSPECIFIED",conversation_context:item.conversation_context || [],synthetic_fixture:fixture };
    const capability=mintCustodianCapability({ key,runId,caseId,clientRequestId,message:item.question,context });
    const response=await fetch(`${endpoint}/chat`,{
      method:"POST",signal:AbortSignal.timeout(timeoutMs),
      headers:{ "content-type":"application/json","x-demo-user-id":PUBLIC_USER_ID,"x-sealed-unseen-run-id":runId,"x-sealed-unseen-case-id":caseId },
      body:JSON.stringify({ client_request_id:clientRequestId,message:item.question,custodian_context:context,custodian_capability:{ payload:capability.payload,signature:capability.signature } }),
    });
    const rawBytes=Buffer.from(await response.arrayBuffer());
    const signature=verifyCustodianBodySignature({ key,signature:response.headers.get("x-sealed-unseen-body-signature"),runId,caseId,clientRequestId,rawBody:rawBytes });
    if (!response.ok || !signature.passed || response.headers.get("x-sealed-unseen-body-sha256")!==signature.body_sha256) throw runnerError("SEALED_CANONICAL_RESPONSE_INVALID");
    const data=JSON.parse(rawBytes.toString("utf8"));
    if (typeof data.response!=="string" || data.answer!==data.response || data.qualification_context_applied!==true || data.qualification_context_sha256!==capability.payload.context_sha256) throw runnerError("SEALED_CANONICAL_RESPONSE_INVALID");
    if (data.qualification_attempts?.model_call_attempted===true && identityDifferences(data.runtime_identity,expectedIdentity).length) throw runnerError("CASE_RUNTIME_IDENTITY_MISMATCH");
    const sources=Array.isArray(data.sources) ? data.sources : [];
    const sourceIds=sources.map((source) => String(source.sourceId || source.source_id || source.id || "")).filter(Boolean);
    const generatedCitations=[...new Set((data.claim_citations || []).flatMap((entry) => entry.source_ids || []).map(String).filter(Boolean))];
    const deterministic=["REFUSE_ACTION","HUMAN_HANDOFF","CLARIFY_THEN_ANSWER"].includes(data.response_route);
    const grounded=deterministic || generatedCitations.length>0;
    return {
      selectedRoute:String(data.response_route || ""),selectedJurisdiction:String(data.jurisdiction_scope || "UNSPECIFIED"),
      finalAnswer:data.response,reviewAnswer:String(data.review_answer || data.response),generatedCitations,claimCitations:data.claim_citations || [],
      retrievedChunkIds:sourceIds.filter((id) => !id.startsWith("structured_public_") && id!==fixture.evidence_id),
      structuredFactIds:sourceIds.filter((id) => id.startsWith("structured_public_")),evidenceIds:[...new Set([fixture.evidence_id,...sourceIds,...generatedCitations])],
      groundingValidation:{ valid:grounded,reason:grounded ? "canonical_product_path" : String(data.response_route || "insufficient_evidence").toLowerCase() },
      handoffDecision:String(data.handoff?.reason || data.handoff?.type || (data.handoff ? "human_review" : "none")),
      actionDecision:data.response_route==="REFUSE_ACTION" ? "refused_prohibited_action" : "read_only_no_tool_call",toolCalls:[],
      servedViaCanonicalChat:true,servedResponseSha256:signature.body_sha256,
    };
  };
}
