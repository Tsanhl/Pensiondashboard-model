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

function isInternalCitationToken(token, allowed) {
  return allowed.has(token) || /_/.test(token) || /^(?:source|law|doc|official|structured|fixture|chunk|cas|gold)-/i.test(token);
}

export function validateGroundedAnswer({ answer, citationIds = [], sources = [], intent,legalEvidenceRequired = null,userSuppliedText = "" }) {
  const allowed = new Set(sources.map((source) => source.sourceId));
  const bracketed = [...String(answer).matchAll(/\[([a-zA-Z0-9_-]+)\]/g)].map((item) => item[1]).filter((token) => isInternalCitationToken(token, allowed));
  const referenced = new Set([...citationIds, ...bracketed]);
  const invented = [...referenced].filter((id) => !allowed.has(id));
  if (invented.length) return { valid:false, reason:"invented_citation", inventedCitationIds:invented };
  const knownBodyMisnamings = [...String(answer).matchAll(/\b(?:Independent Disability Review Panel|Transfer Protection Office|Pension Protection Fund Ombudsman)\b/gi)].map((item) => item[0]);
  if (knownBodyMisnamings.length) return { valid:false, reason:"known_pension_body_misnaming", knownBodyMisnamings:[...new Set(knownBodyMisnamings)] };
  if (!referenced.size) return { valid:false, reason:"missing_citation" };
  const evidence = sources.map((source) => `${source.title || ""}\n${source.oscolaCitation || ""}\n${source.section || ""}\n${source.snippet || ""}`).join("\n");
  let answerWithoutCitationIds = String(answer);
  for (const source of sources) answerWithoutCitationIds = answerWithoutCitationIds.replaceAll(String(source.sourceId), "");
  answerWithoutCitationIds = answerWithoutCitationIds.replace(/\[([a-zA-Z0-9_-]+)\]/g, (whole, token) => isInternalCitationToken(token, allowed) ? "" : whole);
  const evidenceFigures = new Set([...numericTokens(evidence), ...numericTokens(userSuppliedText)]);
  const unsupportedFigures = numericTokens(answerWithoutCitationIds).filter((token) => !evidenceFigures.has(token));
  if (unsupportedFigures.length) return { valid:false, reason:"unsupported_figure", unsupportedFigures:[...new Set(unsupportedFigures)] };
  const applyLegalGate = legalEvidenceRequired == null ? intent === "PENSION_LAW" : Boolean(legalEvidenceRequired);
  if (applyLegalGate) {
    const citedSources = sources.filter((source) => referenced.has(source.sourceId));
    if (!citedSources.some((source) => source.scope === "CURATED_PUBLIC" && source.effectiveDate)) return { valid:false, reason:"law_source_not_current" };
    const normalizedAnswer = String(answer).toLowerCase();
    const hasOsca = citedSources.some((source) => source.oscolaCitation && (
      normalizedAnswer.includes(String(source.oscolaCitation).toLowerCase())
      || (source.title && normalizedAnswer.includes(String(source.title).toLowerCase()))
    ));
    if (!hasOsca) return { valid:false,reason:"missing_oscola_citation" };
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
