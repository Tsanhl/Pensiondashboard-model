import { selectMandatorySources } from "./evidenceContractService.js";
import { retrieveKnowledge } from "./knowledgeService.js";
import { lookupStructuredData } from "./structuredDataService.js";
import { rerankSources } from "./rerankingService.js";
import { recordRetrievalOutcome } from "./retrievalMetricsService.js";
import { requestLogContext, safeLog } from "./debugLoggingService.js";
import { findPublicFacts } from "../repositories/publicFactRepository.js";
import { annotateCaseTreatment } from "./caseTreatmentService.js";

function publicFactSource(fact) {
  return {
    sourceId:`structured_public_${fact.id}`,title:`HMRC dated fact: ${fact.label}`,
    section:fact.source_section || fact.sourceSection || "Dated structured fact",scope:"CURATED_PUBLIC",
    score:Math.min(0.99,0.88 + 0.02 * Number(fact.relevance || 1)),effectiveDate:fact.validFrom,expiresAt:fact.validTo,updatedAt:fact.lastVerifiedAt,
    snippet:JSON.stringify({ label:fact.label,value:fact.value,unit:fact.unit,operator:fact.operator || null,
      condition:fact.condition || null,validFrom:fact.validFrom,validTo:fact.validTo }),
    authority:"HM Revenue & Customs",jurisdiction:fact.jurisdiction,canonicalLocation:fact.source_url,
    documentId:`public-fact-${fact.id}`,version:Number(String(fact.lastVerifiedAt || "").replaceAll("-","") || 1),
    sourceType:"official_structured_tax_fact",authorityRank:0.85,
    oscolaCitation:`HMRC, '${fact.label}' (Pensions Tax Manual, accessed ${fact.lastVerifiedAt})`
  };
}

export function filterSourcesByApprovedPolicy(sources,policy) {
  if (!policy) return sources || [];
  return (sources || []).filter((source) => {
    if (source?.scope !== "CURATED_PUBLIC") return true;
    if (source.sourceType === "official_structured_tax_fact") {
      return policy.structuredFactIds.has(String(source.sourceId || "").replace(/^structured_public_/, ""));
    }
    return policy.documentIds.has(String(source.documentId || ""));
  });
}

async function configuredCorpusPolicy() {
  if (!String(process.env.APPROVED_CORPUS_MANIFEST_PATH || "").trim()) return null;
  const { approvedCorpusSourcePolicy } = await import("./approvedCorpusService.js");
  return approvedCorpusSourcePolicy();
}

export async function retrieveForQuery({ userId,sessionId,requestId,queryPlan,limit = 8,signal,dashboardSnapshot = null }) {
  signal?.throwIfAborted();
  const sources = [];
  const corpusPolicy = await configuredCorpusPolicy();
  const retrievalQuery = queryPlan.retrieval_query || queryPlan.self_contained_query;
  let structuredTrace = { requested:[],matchedAccounts:0 };
  if (queryPlan.source_scopes.includes("USER_PORTFOLIO") || (queryPlan.structured_lookups || []).some((lookup) => ["account","charges","document_status","projection","investment_profile"].includes(lookup))) {
    const structured = lookupStructuredData(userId, queryPlan, dashboardSnapshot);
    sources.push(...structured.sources);
    structuredTrace = structured.trace;
  }
  let publicFacts = [];
  if (queryPlan.source_scopes.includes("CURATED_PUBLIC") && (queryPlan.structured_lookups || []).includes("public_tax_facts")) {
    publicFacts = await findPublicFacts(queryPlan.self_contained_query,{ limit });
    sources.push(...filterSourcesByApprovedPolicy(publicFacts.map(publicFactSource),corpusPolicy));
  }
  const unstructuredScopes = queryPlan.source_scopes.filter((scope) => scope !== "USER_PORTFOLIO");
  let knowledge = { sources:[],corpusVersion:"empty",degradedEmbedding:false };
  let reranked = { sources:[],mode:"none",degraded:false };
  let threshold = null;
  if (unstructuredScopes.length) {
    knowledge = await retrieveKnowledge(userId, retrievalQuery, {
      signal,approvedDocumentIds:corpusPolicy?.documentIds || null,limit:Math.max(limit * 2, 8),scopes:unstructuredScopes,jurisdictionScope:queryPlan.retrieval_jurisdiction_scope || queryPlan.jurisdiction_scope || "UNSPECIFIED"
    });
    // Expansion aids recall; reranking must answer the user's actual issue, not
    // broad expansion terms that can promote an unrelated statutory provision.
    const permittedKnowledge = filterSourcesByApprovedPolicy(knowledge.sources,corpusPolicy);
    reranked = await rerankSources(queryPlan.self_contained_query || retrievalQuery, permittedKnowledge, { entities:queryPlan.entities,limit:permittedKnowledge.length,signal });
    threshold = knowledge.degradedEmbedding ? Number(process.env.DEGRADED_RETRIEVAL_MIN_SCORE || 0.04) : Number(process.env.RETRIEVAL_MIN_SCORE || 0.18);
    sources.push(...selectMandatorySources(reranked.sources.filter((source) => Number(source.score) >= threshold),queryPlan,limit));
  }
  const noResult = sources.length === 0;
  await recordRetrievalOutcome(noResult);
  const trace = {
    scopes:queryPlan.source_scopes,structured:{ ...structuredTrace,publicFacts:publicFacts.map((fact) => fact.id) },unstructuredCandidates:knowledge.sources.length,
    accepted:sources.length,threshold,corpusVersion:knowledge.corpusVersion,degradedEmbedding:knowledge.degradedEmbedding,
    approvedCorpusManifestSha256:corpusPolicy?.manifestSha256 || null,
    reranker:{ mode:reranked.mode,degraded:reranked.degraded },scores:reranked.sources.map((source) => ({ sourceId:source.sourceId,hybrid:Number(source.score || 0),rerank:Number(source.rerankScore || 0) })),noResult
  };
  safeLog("retrieval-quality", { ...requestLogContext({ userId,sessionId,requestId,query:queryPlan }),...trace });
  return { sources:annotateCaseTreatment(sources),trace };
}
