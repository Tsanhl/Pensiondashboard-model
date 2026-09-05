import { legalSchemeChangeQuestion } from "./queryProcessorService.js";

function sourceId(source) {
  return String(source?.sourceId || "");
}

function title(source) {
  return `${source?.title || ""} ${sourceId(source)} ${source?.section || ""}`;
}

function sourceText(source) {
  return `${source?.title || ""} ${source?.oscolaCitation || source?.oscola || ""} ${source?.section || ""} ${source?.snippet || ""}`;
}

function isMcCloudOrAnnualAllowanceRemedy(source) {
  return /\b(?:McCloud|public service pensions remedy|annual allowance following the public service)\b/i.test(sourceText(source));
}

function isNorthernIrelandConsultation(source) {
  return /\bConsultation by Employers\) Regulations \(Northern Ireland\) 2006\b/i.test(sourceText(source))
    || /\bSR 2006\/48\b/i.test(sourceText(source));
}

function isSchemeChangeAuthority(source) {
  const blob = sourceText(source);
  if (isNorthernIrelandConsultation(source)) return false;
  return /Consultation by Employers and Miscellaneous Amendment\) Regulations 2006/i.test(blob)
    || /Modification of Schemes\) Regulations 2006/i.test(blob)
    || /\bSI 2006\/349\b/i.test(blob)
    || /\bSI 2006\/759\b/i.test(blob);
}

export function filterSourcesForQuery(sources = [], query = {}) {
  const question = String(query.self_contained_query || query.retrieval_query || "");
  if (query.response_route === "SECURITY_FALLBACK") {
    return sources.filter((source) => {
      if (source.sourceType === "verified_synthetic_fixture") return true;
      if (source.scope !== "CURATED_PUBLIC") return false;
      const text = sourceText(source);
      return /\b(?:scam|fraud|unsolicited|pressur(?:e|ed|ing)|cold call|red flag|amber flag)\b/i.test(text)
        || /\b(?:The Pensions Regulator|Financial Conduct Authority|MoneyHelper)\b/i.test(String(source.authority || source.title || ""));
    });
  }
  if (legalSchemeChangeQuestion(question)) {
    return sources.filter((source) => {
      if (source.scope !== "CURATED_PUBLIC") return true;
      if (isMcCloudOrAnnualAllowanceRemedy(source) || isNorthernIrelandConsultation(source)) return false;
      return true;
    });
  }
  return sources;
}

export function classifySourceBucket(source) {
  const id = sourceId(source);
  const text = title(source).toLowerCase();
  if (id.includes("structured_projection") || text.includes("deterministic pension projection")) return "projection";
  if (id.includes("structured_investment") || text.includes("investment and risk")) return "investment";
  if (id.includes("structured_documents") || text.includes("document status")) return "documents";
  if (id.includes("structured_accounts") || text.includes("pension account records")) return "accounts";
  if (source?.scope === "USER_DOCUMENTS") return "documents";
  if (source?.scope === "USER_PORTFOLIO") return "accounts";
  if (source?.scope === "CURATED_PUBLIC") return "public";
  return "other";
}

export function evidenceContract(query = {}) {
  const intent = query.intent || "";
  const question = String(query.self_contained_query || query.retrieval_query || "");
  const lookups = query.structured_lookups || [];
  if (query.response_route === "SECURITY_FALLBACK") {
    return { mandatory: ["public"], optional: ["accounts", "documents"], maxSources: 4, publicFirst: true };
  }
  if (intent === "PROJECTION" || lookups.includes("projection") || /\b(?:monthly gap|add £?\s*\d+|extra £?\s*\d+|retirement age|income target|projection assumptions?)\b/i.test(question)) {
    return { mandatory: ["projection", "accounts"], optional: ["documents", "investment", "public"], maxSources: 4 };
  }
  if (lookups.includes("investment_profile") || /\b(?:allocation|cautious|balanced|best returns?|which fund)\b/i.test(question)) {
    return { mandatory: ["investment", "accounts"], optional: ["documents", "public"], maxSources: 4 };
  }
  if (intent === "USER_DOCUMENT" || /\b(?:booklet|annual statement|facts? that need confirmation|document status|fully checked)\b/i.test(question)) {
    return { mandatory: ["documents", "accounts"], optional: ["public"], maxSources: 4 };
  }
  if (intent === "USER_PORTFOLIO") {
    return { mandatory: ["accounts"], optional: ["documents", "projection", "public"], maxSources: 4 };
  }
  if (intent === "HYBRID") {
    if (query.legal_evidence_required) {
      return { mandatory: ["accounts", "public"], optional: ["documents", "projection"], maxSources: 4 };
    }
    return { mandatory: ["accounts"], optional: ["documents", "projection", "public"], maxSources: 4 };
  }
  return { mandatory: [], optional: ["public", "accounts", "documents", "projection", "investment"], maxSources: Math.max(1, Number(query.source_limit) || 6) };
}

function documentFamily(source) {
  return String(source?.documentId || source?.sourceId || "")
    .toLowerCase()
    .replace(/_chunk_\d+$/i, "");
}

export function selectMandatorySources(sources = [], query = {}, limit = 6) {
  const filtered = filterSourcesForQuery(sources, query);
  const count = Math.max(1, Number(limit) || 1);
  if (query.response_route === "SECURITY_FALLBACK") {
    const safetyRelevance = (source) => {
      if (source.sourceType === "verified_synthetic_fixture") return 20;
      const text = `${source.title || ""} ${source.section || ""} ${source.snippet || ""}`;
      let score = 0;
      if (/\b(?:scam|fraud)\b/i.test(String(source.title || ""))) score += 6;
      if (/\b(?:scam(?:med|s)?|fraud|unsolicited|pressur(?:e|ed|ing)|cold call)\b/i.test(text)) score += 4;
      if (/\b(?:stop contact|do not (?:transfer|pay|share)|verify|independent(?:ly)?|red flag|amber flag|moneyhelper)\b/i.test(text)) score += 2;
      if (/\b(?:The Pensions Regulator|Financial Conduct Authority|MoneyHelper)\b/i.test(String(source.authority || ""))) score += 1;
      return score;
    };
    return filtered
      .map((source, index) => ({ source, index }))
      .sort((left, right) => safetyRelevance(right.source) - safetyRelevance(left.source) || left.index - right.index)
      .slice(0, count)
      .map(({ source }) => source);
  }

  const contract = evidenceContract(query);
  const cap = Math.min(Math.max(count, contract.mandatory.length || 1), Math.max(contract.maxSources, count));
  const picked = [];
  const used = new Set();
  const question = String(query.self_contained_query || query.retrieval_query || "");
  const takeBucket = (bucket) => {
    const candidates = filtered.filter((source) => !used.has(source.sourceId) && classifySourceBucket(source) === bucket);
    let found = candidates[0];
    if (bucket === "public" && /\bopt(?:ing)?\s+out\b/i.test(question)) {
      found = candidates.find((source) => /\bopt(?:ing)?\s+out\b/i.test(sourceText(source))) || found;
    }
    if (!found) return;
    picked.push(found);
    used.add(found.sourceId);
  };
  for (const bucket of contract.mandatory) {
    if (picked.length >= cap) break;
    takeBucket(bucket);
  }
  const familyUsed = new Set(picked.map(documentFamily));
  for (const source of filtered) {
    if (picked.length >= cap) break;
    if (used.has(source.sourceId)) continue;
    const family = documentFamily(source);
    if (family && familyUsed.has(family)) continue;
    picked.push(source);
    used.add(source.sourceId);
    if (family) familyUsed.add(family);
  }
  for (const source of filtered) {
    if (picked.length >= cap) break;
    if (used.has(source.sourceId)) continue;
    picked.push(source);
    used.add(source.sourceId);
  }
  return picked;
}

export { isMcCloudOrAnnualAllowanceRemedy, isNorthernIrelandConsultation, isSchemeChangeAuthority };
