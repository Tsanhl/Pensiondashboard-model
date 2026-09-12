import { createHash } from "node:crypto";
import { cacheDeletePrefix, cacheGet, cacheSet } from "./cacheService.js";
import { structuralChunk } from "./chunkingService.js";
import { embedTexts } from "./embeddingService.js";
import { activateKnowledgeDocument, deleteKnowledgeDocument, listKnowledgeDocuments, searchKnowledge } from "../repositories/knowledgeRepository.js";
import { newId } from "../store/userDataStore.js";

function corpusVersion(documents = []) {
  return createHash("sha256").update(documents.map((item) => `${item.id}:${item.version}:${item.updatedAt}`).sort().join("|")).digest("hex").slice(0, 16);
}

function normalizedAuthorityTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/^(?:the|tpr)\s+/, '').replace(/\s+paragraphs?\s+[0-9 ].*$/, '');
}

export function selectTitlePinnedCandidates(candidates = [], query = "", limit = 8) {
  const maximum = Math.max(1, Number(limit) || 1);
  const normalizedQuery = normalizedAuthorityTitle(query);
  const namedTitles = [...new Set(candidates.map((item) => item.title).filter((title) => {
    const normalized = normalizedAuthorityTitle(title);
    return normalized.split(" ").length >= 3 && normalizedQuery.includes(normalized);
  }))];
  const selected = [];
  const selectedIds = new Set();
  for (const title of namedTitles) {
    for (const item of candidates.filter((candidate) => candidate.title === title).slice(0, 2)) {
      if (!selectedIds.has(item.sourceId) && selected.length < maximum) {
        selected.push(item);
        selectedIds.add(item.sourceId);
      }
    }
  }
  for (const item of candidates) {
    if (!selectedIds.has(item.sourceId) && selected.length < maximum) {
      selected.push(item);
      selectedIds.add(item.sourceId);
    }
  }
  return selected;
}

const LEGAL_QUERY_EXPANSIONS = [
  [/\bESG\b/i, "environmental social governance financially material considerations"],
  [/\bPPF\b/i, "Pension Protection Fund"],
  [/\bTPR\b/i, "The Pensions Regulator"],
  [/\bTUPE\b/i, "Transfer of Undertakings Protection of Employment"],
  [/\bGMPs?\b/i, "guaranteed minimum pension"],
  [/\bDB\b/i, "defined benefit"],
  [/\bDC\b/i, "defined contribution"],
  [/\bautomatic[- ]enrolment|re[- ]enrolment|opt(?:ed)? out\b/i, "automatic enrolment jobholder employer duty opt out opting out Regulation 9 re-enrolment"],
  [/\b(?:normally|ordinarily) work(?:ed|ing)?\b|\bhead office\b[^.!?]{0,100}\bautomatic[- ]enrolment\b/i, "automatic enrolment territorial scope worker ordinarily works Northern Ireland employer head office not determinative"],
  [/\bexecuted scheme rules?\b[^.!?]{0,120}\bnewsletter\b|\bnewsletter\b[^.!?]{0,120}\bexecuted scheme rules?\b/i, "executed trust deed scheme rules amendment power formalities effective date member announcement newsletter communication"],
  [/\b(?:red|amber) flags?|transfer scam checks?\b/i, "conditions for transfers red flags amber flags specified guidance"],
  [/\b(?:incentive|gift card|shopping voucher|hotel|flight reimbursement|commission)\b[^.!?]{0,160}\btransfer\b|\btransfer\b[^.!?]{0,160}\b(?:incentive|gift card|shopping voucher|hotel|flight reimbursement|commission)\b/i, "Occupational and Personal Pension Schemes Conditions for Transfers Regulations 2021 regulation 8 incentives red flag Second Condition not satisfied"],
  [/\bMoneyHelper\b|\bsafeguarding appointment\b/i, "Conditions for Transfers Regulations 2021 regulation 9 amber flag specified MoneyHelper guidance prescribed evidence completion does not prove transfer safe"],
  [/\bsafeguarded benefits?\b|\bappropriate independent advice\b/i, "Pension Schemes Act 2015 section 48 appropriate independent advice safeguarded benefits transfer conversion trustees check FCA permission thirty thousand pounds"],
  [/\bcomplain|complaint|ombudsman|\bIDRP\b/i, "internal dispute resolution procedure Pensions Ombudsman complaint determination"],
  [/\b(?:FOS|Financial Ombudsman Service|regulated adviser|suitability complaint)\b/i, "Financial Ombudsman Service pension transfer regulated advice suitability complaint final response eight weeks"],
  [/\b(?:appeal|point of law|Court of Session|Court of Appeal)\b[^.!?]{0,100}\b(?:Pensions Ombudsman|determination)\b|\b(?:Pensions Ombudsman|determination)\b[^.!?]{0,100}\b(?:appeal|point of law|Court of Session|Court of Appeal)\b/i, "Pensions Ombudsman appeal point of law High Court Court of Session Northern Ireland Court of Appeal time limit"],
  [/\bsame[- ]sex|survivor(?:'s)? pension\b/i, "sex equality survivor benefit Walker Innospec"],
  [/\bRPI\b|\bCPI\b/i, "pension increase index scheme wording retail prices consumer prices"],
  [/\bassessment period|administration\b/i, "Pension Protection Fund assessment period scheme administration payments"],
  [/\bmissing pension|appears twice|duplicate|surname|false match\b/i, "pensions dashboards matching criteria possible match pension not found data accuracy"],
  [/\bState Pension forecast\b/i, "pensions dashboards State Pension information current session forecast"],
  [/\bnormal pension age|take this pension at|early access|unlock (?:my |a )?pension\b/i, "normal minimum pension age protected pension age unauthorised pension access tax"],
  [/\bunlock|release fee|transfer today|pension scam|safe\b/i, "The Pensions Regulator Avoid and report pension scams pension scam warning signs pension liberation early access unsolicited contact pressure incentive fee verify authorised firm do not transfer"],
  [/\boverseas scheme|overseas transfer\b/i, "qualifying recognised overseas pension scheme overseas transfer charge allowance"]
];

export function expandRetrievalQuery(query) {
  const original = String(query || "").trim();
  const expansions = LEGAL_QUERY_EXPANSIONS
    .filter(([pattern]) => pattern.test(original))
    .map(([, expansion]) => expansion);
  return [...new Set([original, ...expansions])].filter(Boolean).join(" ");
}

export function matchesJurisdiction(source, jurisdictionScope) {
  if (!jurisdictionScope || jurisdictionScope === "UNSPECIFIED" || jurisdictionScope === "GB_AND_NI") return true;
  const jurisdiction = String(source.jurisdiction || "").toLowerCase();
  const title = String(source.title || "").toLowerCase();
  if (["GREAT_BRITAIN","ENGLAND_AND_WALES","SCOTLAND","UK_TAX"].includes(jurisdictionScope)) return jurisdiction !== "northern ireland" && !title.includes("northern ireland");
  if (jurisdictionScope !== "NORTHERN_IRELAND") return true;
  if (jurisdiction.includes("northern ireland") || title.includes("northern ireland")) return true;
  if (["case_law","case_law_opinion","case_law_summary"].includes(source.sourceType) && jurisdiction === "united kingdom") return true;
  return false;
}

async function embedInBatches(texts, size = 64) {
  const embeddings = [];
  let model = null;
  let degraded = false;
  for (let index = 0; index < texts.length; index += size) {
    const batch = await embedTexts(texts.slice(index, index + size));
    embeddings.push(...batch.embeddings);
    model ||= batch.model;
    degraded ||= batch.degraded;
  }
  return { embeddings,model,degraded };
}

export async function indexDocument(userId, input = {}) {
  const text = String(input.text || "").trim();
  if (!text) throw Object.assign(new Error("No readable text was found in the document."), { status: 422 });
  const baseChunks = structuralChunk(text, { documentType: input.documentType || "policy" });
  if (!baseChunks.length) throw Object.assign(new Error("Document produced no searchable sections."), { status: 422 });
  const embedded = await embedInBatches(baseChunks.map((item) => item.content));
  const documentId = input.id || newId("doc");
  if (input.effectiveDate && !Number.isFinite(Date.parse(input.effectiveDate))) throw Object.assign(new Error("effectiveDate must be a valid date."), { status:400 });
  if (input.expiryDate && !Number.isFinite(Date.parse(input.expiryDate))) throw Object.assign(new Error("expiryDate must be a valid date."), { status:400 });
  if (input.effectiveDate && input.expiryDate && Date.parse(input.expiryDate) <= Date.parse(input.effectiveDate)) throw Object.assign(new Error("expiryDate must be later than effectiveDate."), { status:400 });
  const existing = (await listKnowledgeDocuments(userId)).find((item) => item.id === documentId && item.userId === userId);
  if (existing && Number(input.version || 1) < Number(existing.version || 1)) throw Object.assign(new Error("A newer document version is already active."), { status:409 });
  const now = new Date().toISOString();
  const document = {
    id: documentId,
    userId,
    version: Number(input.version || 1),
    title: String(input.title || "Uploaded pension document").trim(),
    authority: String(input.authority || "User upload").trim(),
    jurisdiction: String(input.jurisdiction || "UK").trim(),
    canonicalLocation: input.canonicalLocation || null,
    publishedAt: input.publishedAt || null,
    effectiveDate: input.effectiveDate || null,
    expiryDate: input.expiryDate || null,
    checksum: input.checksum || createHash("sha256").update(text).digest("hex"),
    licence: input.licence || "private-user-document",
    mimeType: input.mimeType || "text/plain",
    objectKey: input.objectKey || null,
    normalizedTextKey: input.normalizedTextKey || null,
    scope: input.scope || "USER_DOCUMENTS",
    status: "processing",
    createdAt: now,
    updatedAt: now,
    metadata: { ...(input.metadata || {}), embeddingModel: embedded.model, degradedEmbedding: embedded.degraded }
  };
  const promptInjectionPattern = /\b(?:ignore (?:all |the )?(?:previous|system) instructions|system prompt|developer message|assistant must|reveal (?:the )?prompt|do not follow (?:the )?rules)\b/i;
  const chunks = baseChunks.map((chunk, index) => ({
    id: `${documentId}_chunk_${index + 1}`,
    documentId,
    userId,
    ...chunk,
    embedding: embedded.embeddings[index],
    metadata: { documentVersion:document.version,lastUpdated:now,expiresAt:document.expiryDate || null,scope:document.scope,quarantined:promptInjectionPattern.test(chunk.content),quarantineReason:promptInjectionPattern.test(chunk.content) ? "prompt_injection_signal" : null }
  }));
  const active = await activateKnowledgeDocument(userId, document, chunks);
  await cacheDeletePrefix(`retrieval:${userId}:`);
  return { document: active,chunkCount:chunks.length,quarantinedChunkCount:chunks.filter((chunk) => chunk.metadata.quarantined).length,embeddingModel:embedded.model,degradedEmbedding:embedded.degraded };
}

export async function retrieveKnowledge(userId, query, { limit = 8, scopes = [], jurisdictionScope = "UNSPECIFIED", retrievalConfig = "hybrid-v1",signal,approvedDocumentIds = null } = {}) {
  const documents = await listKnowledgeDocuments(userId, { includeChunkCounts:false });
  const eligibleDocuments = documents.filter(d => d.status === 'active' && (!d.expiryDate || Date.parse(d.expiryDate) > Date.now())
    && (!scopes.length || scopes.includes(d.scope))
    && (d.scope !== 'CURATED_PUBLIC' || !approvedDocumentIds || approvedDocumentIds.has(d.id))
    && matchesJurisdiction({...d,sourceType:d.metadata?.sourceType},jurisdictionScope));
  const eligibleIds = eligibleDocuments.map(d=>d.id);
  const version = corpusVersion(eligibleDocuments);
  const retrievalQuery = expandRetrievalQuery(query);
  const queryHash = createHash("sha256").update(retrievalQuery).digest("hex");
  const key = `retrieval:${userId}:${version}:${queryHash}:${retrievalConfig}:${jurisdictionScope}:${scopes.sort().join(",")}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (!eligibleIds.length) return {sources:[],corpusVersion:version,degradedEmbedding:false,retrievalQuery};
  const { embeddings, degraded } = await embedTexts([retrievalQuery],{signal});
  const safetyCritical = /\b(?:pension scam|scam|fraud|unlock|release fee|transfer today|early access|incentive|gift card|caller|authorised)\b/i.test(retrievalQuery);
  const normalizedQuery = normalizedAuthorityTitle(retrievalQuery);
  const namesAuthority = documents.some((document) => {
    const normalized = normalizedAuthorityTitle(document.title);
    return normalized.split(" ").length >= 3 && normalizedQuery.includes(normalized);
  });
  const candidateLimit = safetyCritical
    ? Math.max(limit * 12, 100)
    : namesAuthority ? Math.max(limit * 12, 200)
      : jurisdictionScope && jurisdictionScope !== "UNSPECIFIED" ? Math.max(limit * 6, 40) : Math.max(limit * 2, 8);
  signal?.throwIfAborted();
  const all = await searchKnowledge(userId, embeddings[0], candidateLimit, retrievalQuery, {documentIds:eligibleIds});
  // Resolve an explicitly named authority within its own document family before
  // global top-K can erase it. This is metadata-based recall, not an answer override.
  const namedDocuments = eligibleDocuments.filter((document) => {
    const name = normalizedAuthorityTitle(document.title);
    return name.split(" ").length >= 3 && normalizedQuery.includes(name);
  }).slice(0, 12);
  const familyCandidates = (await Promise.all(namedDocuments.map((document) =>
    searchKnowledge(userId, embeddings[0], 4, retrievalQuery.split(";").find(part => normalizedAuthorityTitle(part).includes(normalizedAuthorityTitle(document.title))) || retrievalQuery, { documentIds:[document.id] })
  ))).flat();
  const unique = [...new Map([...familyCandidates, ...all].map((source) => [source.sourceId,source])).values()];
  const eligible = unique
    .filter((item) => !scopes.length || scopes.includes(item.scope))
    .filter((item) => matchesJurisdiction(item, jurisdictionScope));
  const filtered = selectTitlePinnedCandidates(eligible.filter(item=>!/(?:^| > )Regulation \d+ (?:prohibits|requires|specifies|provides|sets|amends)\b/i.test(item.section || "")), retrievalQuery, limit);
  const result = { sources: filtered, corpusVersion: version, degradedEmbedding: degraded,retrievalQuery };
  await cacheSet(key, result, 300);
  return result;
}

export async function removeIndexedDocument(userId, documentId) {
  const removed = await deleteKnowledgeDocument(userId, documentId);
  await cacheDeletePrefix(`retrieval:${userId}:`);
  return removed;
}

export { listKnowledgeDocuments };
