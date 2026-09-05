const supportContact = String(process.env.HUMAN_SUPPORT_EMAIL || "").trim();

export const SAFE_TEMPLATES = Object.freeze({
  MODEL_UNAVAILABLE: "The local pension model is unavailable, so I cannot produce a pension answer safely. Start the Qwen3-8B service and try again. Your question and session were saved.",
  INSUFFICIENT_EVIDENCE: "I do not have enough verified, current evidence to answer that safely. Upload or confirm the relevant document, or ask for a human review.",
  SECURITY_FALLBACK: "This has pension-scam warning signs. Do not pay the fee, share credentials, sign documents or transfer the pension. Stop contact and contact your pension provider through independently verified details; use the official fraud-reporting route for your jurisdiction and ask for urgent human scam review.",
  SECURITY_LEAD: "This has pension-scam warning signs. Stop contact and do not transfer the pension, pay money or share further information while it is checked urgently.",
  REFUSE_ACTION: "I cannot submit, sign, transfer, change records, or help conceal or misdescribe information. I have taken no action. I can help draft truthful wording or a checklist, but you or an authorised representative must verify and submit or sign it. If a scam warning is involved, stop and contact the pension provider through independently verified details and use the official fraud-reporting route for your jurisdiction.",
  HUMAN_HANDOFF: `This question is outside the assistant's scope and will be referred for human review. I have not made or submitted any pension change.${supportContact ? ` Please contact ${supportContact}.` : " Please contact your pension support team."}`
});

function numericTokens(text = "") {
  return [...String(text).matchAll(/(?:£\s*)?\d[\d,]*(?:\.\d+)?%?/g)].map((item) => {
    const value = Number(item[0].replace(/[^0-9.]/g, ""));
    return Number.isFinite(value) ? String(value) : null;
  }).filter(Boolean);
}

function isLegalSchemeChangeQuestion(text) {
  const value = String(text || "");
  if (/\b(?:legal route|official legal process|legal process)\b/i.test(value) && /\b(?:chang(?:e|ing|ed)|scheme is changed)\b/i.test(value) && /\bscheme\b/i.test(value)) return true;
  if (/\bworkplace pension scheme is changed\b/i.test(value)) return true;
  return false;
}

function sourceBlob(source) {
  return `${source?.title || ""} ${source?.oscolaCitation || source?.oscola || ""} ${source?.section || ""} ${source?.snippet || ""} ${source?.evidence_excerpt || ""} ${source?.excerpt || ""} ${source?.text || ""} ${source?.content || ""}`;
}

const CLAIM_STOP_WORDS = new Set([
  "about","after","again","against","also","and","are","because","been","before","being","between","both","but","can","could","does","from","have","into","more","must","not","only","other","pension","pensions","scheme","should","than","that","the","their","them","then","there","these","they","this","those","through","under","what","when","where","which","while","with","would","your",
  "answer","benefit","benefits","current","information","member","members","recorded","rule","rules","source","value",
]);

function lexicalAnchors(text) {
  return new Set((String(text || "").toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [])
    .map((word) => word.replace(/(?:'s|s)$/i, ""))
    .filter((word) => word.length >= 3 && !CLAIM_STOP_WORDS.has(word)));
}

function materialClaim(text) {
  const claim = String(text || "").trim();
  if (!/[a-z0-9]/i.test(claim)) return false;
  return !/^(?:i cannot|i can help|i have taken no action|check\b|contact\b|ask\b|review\b|seek\b|do not\b|stop\b|please\b|a human adviser would need\b)/i.test(claim);
}

function validateClaimCitations(claimCitations, sourceMap, userSuppliedText) {
  if (!Array.isArray(claimCitations)) return { valid:false,reason:"citation_claim_map_missing" };
  for (const entry of claimCitations) {
    const claim = String(entry?.claim || "").trim();
    if (!materialClaim(claim)) continue;
    const ids = [...new Set((entry?.source_ids || []).map(String))];
    if (!ids.length) return { valid:false,reason:"citation_claim_unmapped",claim };
    const attached = ids.map((id) => sourceMap.get(id)).filter(Boolean);
    if (attached.length !== ids.length) return { valid:false,reason:"citation_claim_unmapped",claim,source_ids:ids };
    const attachedText = attached.map(sourceBlob).join("\n");
    const claimFigures = numericTokens(claim);
    const evidenceFigures = new Set([...numericTokens(attachedText),...numericTokens(userSuppliedText)]);
    if (claimFigures.some((value) => !evidenceFigures.has(value))) {
      return { valid:false,reason:"citation_entailment_failed",claim,source_ids:ids,detail:"attached source does not contain the claim's figures" };
    }
    const claimAnchors = lexicalAnchors(claim);
    const evidenceAnchors = lexicalAnchors(attachedText);
    if (!claimAnchors.size && !claimFigures.length) {
      return { valid:false,reason:"citation_entailment_failed",claim,source_ids:ids,detail:"claim has no deterministic figure or distinctive lexical anchor" };
    }
    const overlap = [...claimAnchors].filter((anchor) => evidenceAnchors.has(anchor)).length;
    const requiredOverlap = Math.max(1,Math.ceil(Math.min(claimAnchors.size,6) / 2));
    if (claimAnchors.size && overlap < requiredOverlap) {
      return { valid:false,reason:"citation_entailment_failed",claim,source_ids:ids,detail:`attached source has insufficient distinctive lexical support (${overlap}/${requiredOverlap})` };
    }
  }
  return { valid:true };
}

export function stripUnsupportedLegalCycles(answer, evidence) {
  const text = String(answer || "");
  if (!/\bre-enrol\b/i.test(text) || !/\b12-month\b/i.test(text)) return text;
  if (/\bre-enrol[\s\S]{0,120}12-month|12-month[\s\S]{0,120}re-enrol/i.test(String(evidence || ""))) return text;
  return text
    .replace(/[^.?!]*re-enrol[^.?!]*12-month[^.?!]*[.?!]/gi, " ")
    .replace(/[^.?!]*once in any 12-month[^.?!]*[.?!]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function completePresentLegalFacts(question, answer, sources = []) {
  let text = String(answer || "").trim();
  const addedCitationIds = [];
  if (/\bopt(?:ing)?\s+out\b/i.test(question) && !/\bopt(?:ing)?\s+out\b/i.test(text)) {
    const source = sources.find((item) => /\bopt(?:ing)?\s+out\b/i.test(sourceBlob(item)));
    if (source?.sourceId) {
      text = `${text} A worker may opt out. {{cite:${source.sourceId}}}`.trim();
      addedCitationIds.push(source.sourceId);
    }
  }
  return { answer: text, addedCitationIds };
}

function isInternalCitationToken(token, allowed) {
  return allowed.has(token) || /_/.test(token) || /^(?:source|law|doc|official|structured|fixture|chunk|cas|gold)-/i.test(token);
}

export function validateGroundedAnswer({ answer, citationIds = [], sources = [], intent,legalEvidenceRequired = null,userSuppliedText = "", claimLevel = false,claimCitations = null }) {
  const allowed = new Set(sources.map((source) => source.sourceId));
  const sourceMap = new Map(sources.map((source) => [String(source.sourceId),source]));
  const bracketed = [...String(answer).matchAll(/\[([a-zA-Z0-9_-]+)\]/g)].map((item) => item[1]).filter((token) => isInternalCitationToken(token, allowed));
  const referenced = new Set([...citationIds, ...bracketed]);
  const invented = [...referenced].filter((id) => !allowed.has(id));
  if (invented.length) return { valid:false, reason:"invented_citation", inventedCitationIds:invented };
  const knownBodyMisnamings = [...String(answer).matchAll(/\b(?:Independent Disability Review Panel|Transfer Protection Office|Pension Protection Fund Ombudsman)\b/gi)].map((item) => item[0]);
  if (knownBodyMisnamings.length) return { valid:false, reason:"known_pension_body_misnaming", knownBodyMisnamings:[...new Set(knownBodyMisnamings)] };
  if (!referenced.size) return { valid:false, reason:"missing_citation" };
  if (claimCitations != null) {
    const claimValidation = validateClaimCitations(claimCitations,sourceMap,userSuppliedText);
    if (!claimValidation.valid) return claimValidation;
  }
  const evidence = sources.map(sourceBlob).join("\n");
  let answerWithoutCitationIds = String(answer);
  for (const source of sources) answerWithoutCitationIds = answerWithoutCitationIds.replaceAll(String(source.sourceId), "");
  answerWithoutCitationIds = answerWithoutCitationIds.replace(/\[([a-zA-Z0-9_-]+)\]/g, (whole, token) => isInternalCitationToken(token, allowed) ? "" : whole);
  const evidenceFigures = new Set([...numericTokens(evidence), ...numericTokens(userSuppliedText)]);
  const unsupportedFigures = numericTokens(answerWithoutCitationIds).filter((token) => !evidenceFigures.has(token));
  if (unsupportedFigures.length) return { valid:false, reason:"unsupported_figure", unsupportedFigures:[...new Set(unsupportedFigures)] };
  if (isLegalSchemeChangeQuestion(userSuppliedText)) {
    const citedSources = sources.filter((source) => referenced.has(source.sourceId));
    const publicCited = citedSources.filter((source) => source.scope === "CURATED_PUBLIC");
    const hasSchemeChangeLaw = publicCited.some((source) => /Consultation by Employers and Miscellaneous Amendment\) Regulations 2006|Modification of Schemes\) Regulations 2006|SI 2006\/349|SI 2006\/759/i.test(sourceBlob(source))
      && !/\bNorthern Ireland\b/i.test(sourceBlob(source)));
    if (publicCited.some((source) => /\b(?:McCloud|public service pensions remedy)\b/i.test(sourceBlob(source))) || !hasSchemeChangeLaw) {
      return { valid:false, reason:"irrelevant_public_source" };
    }
  }
  const applyLegalGate = legalEvidenceRequired == null ? intent === "PENSION_LAW" : Boolean(legalEvidenceRequired);
  if (applyLegalGate) {
    const citedSources = sources.filter((source) => referenced.has(source.sourceId));
    const hasCurrentPublic = citedSources.some((source) => source.scope === "CURATED_PUBLIC" && source.effectiveDate);
    const personalCited = citedSources.some((source) => source.scope === "USER_PORTFOLIO" || source.scope === "USER_DOCUMENTS" || String(source.sourceId || "").startsWith("structured_"));
    if (!hasCurrentPublic) {
      if (claimLevel && personalCited && !isLegalSchemeChangeQuestion(userSuppliedText)) {
        return { valid:true, reason:"grounded_personal_facts", legalUnresolved:true, citationIds:[...referenced] };
      }
      return { valid:false, reason:"law_source_not_current" };
    }
    const normalizedAnswer = String(answer).toLowerCase();
    const hasOsca = citedSources.some((source) => source.oscolaCitation && (
      normalizedAnswer.includes(String(source.oscolaCitation).toLowerCase())
      || (source.title && normalizedAnswer.includes(String(source.title).toLowerCase()))
    ));
    if (!hasOsca) {
      if (claimLevel && personalCited && !isLegalSchemeChangeQuestion(userSuppliedText)) {
        return { valid:true, reason:"grounded_personal_facts", legalUnresolved:true, citationIds:[...referenced] };
      }
      return { valid:false,reason:"missing_oscola_citation" };
    }
  }
  return { valid:true, reason:"grounded", citationIds:[...referenced] };
}

export function publicSources(sources = [], citationIds = []) {
  const used = new Set(citationIds);
  return sources.filter((source) => used.has(source.sourceId)).map((source) => ({
    source_id: source.sourceId,
    title: source.title,
    section: source.section || null,
    snippet: String(source.snippet || "").slice(0, 600),
    effective_date: source.effectiveDate || null,
    oscola:source.oscolaCitation || source.title
  }));
}
