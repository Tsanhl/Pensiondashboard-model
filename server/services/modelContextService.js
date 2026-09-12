import { selectEvidenceExcerpt } from "./evidenceExcerptService.js";

// Request-local aliases reduce generation cost without changing the evidence or
// public citations. Never reuse an alias map across requests/conversations.
export function buildModelContext(query, sources, { history = [], snippetChars = 1000 } = {}) {
  const citationAliases = Object.create(null);
  const ids = new Set();
  const sourceExcerpts = [];
  const evidenceSources = sources.map((source) => {
    const isStructured = String(source.scope || "").toUpperCase() === "USER_PORTFOLIO"
      || String(source.sourceId || "").startsWith("structured_")
      || /^\s*[\[{]/.test(String(source.snippet || ""));
    const excerpt = isStructured
      ? { text:String(source.snippet || ""), start:0, end:String(source.snippet || "").length, truncated:false }
      : selectEvidenceExcerpt(source.snippet, query.self_contained_query, snippetChars);
    sourceExcerpts.push({ sourceId:source.sourceId, start:excerpt.start, end:excerpt.end, truncated:excerpt.truncated });
    return { ...source, snippet:excerpt.text };
  });
  const text = evidenceSources.map((source, index) => {
    if (!source.sourceId || ids.has(source.sourceId)) throw new Error("Missing or duplicate model source ID");
    ids.add(source.sourceId);
    const alias = `S${index + 1}`;
    citationAliases[alias] = source.sourceId;
    const treatment = source.caseTreatment?.related?.map((item) => `${item.direction}:${item.relationship}:${item.relatedDocumentId} — ${item.note}`).join(" | ") || "none recorded; absence is not proof that no later treatment exists";
    const territorialDates = source.sourceMetadata?.northernIrelandEffectiveDate
      ? `Great Britain: ${source.effectiveDate || "unknown"}; Northern Ireland: ${source.sourceMetadata.northernIrelandEffectiveDate}`
      : source.effectiveDate || "unknown";
    const provenance = source.sourceMetadata || {};
    return `SOURCE ${alias}\nCitation token: {{cite:${alias}}}\nTitle: ${source.title}\nType: ${source.sourceType || "record with unverified provenance"}\nSource role: ${source.sourceRole || "not recorded"}\nPriority: ${source.authorityRank || 0.5}\nScope: ${source.scope}\nJurisdiction/extent: ${source.jurisdiction || "not recorded — do not infer"}\nEffective date(s): ${territorialDates}\nDate basis: ${provenance.dateBasis || "not recorded"}\nRetrieved: ${provenance.retrievedAt || "not recorded"} (not an effective date)\nSource scope limitation: ${provenance.scopeNote || "not recorded"}\nUnapplied effects: ${provenance.unappliedEffects ?? "not recorded"}\nCase treatment: ${treatment}\nSection: ${source.section || "unknown"}\nEvidence${sourceExcerpts[index].truncated ? " (verbatim excerpt; surrounding text omitted)" : ""}: ${source.snippet}`;
  }).join("\n\n");
  return {
    citationAliases,
    evidenceSources,
    sourceExcerpts,
    messages: [...history.map(({ role, content }) => ({ role, content })), {
      role: "user",
      content: `QUERY\n${query.self_contained_query}\nRequested jurisdiction: ${query.jurisdiction_scope}\nRequired response route: ${query.response_route}\nHandoff reason: ${query.handoff_reason || "none"}\nResponse requirements: ${(query.response_requirements || []).join(" ") || "answer every material fact in the query"}\n\nSUPPLIED EVIDENCE (record confirmation status is explicit)\n${text}\nEND SUPPLIED EVIDENCE\n\nANSWER TASK\nAnswer the QUERY in your own words. Use up to six concise sentences as needed; retain material conditions and only necessary follow-up questions. Correct any false premise; do not repeat the question as an assertion or copy source paragraphs. Apply the supplied dates and figures. Use the latest user statement as their current assertion, not as independent verification; explicitly qualify unresolved conflicts with records. Record absence is not zero. An account source supports personal facts, never legal rules. Speak as the information assistant, not as a regulator, judge or trustee. Follow the response route and make any required human handoff visible. Cite each material sentence using only its supporting tokens, once per sentence. Do not combine a general permission with a list of source conditions. If authority to decide the individual case is absent, state the limitation and explain the supported conditional rules. Return the complete JSON object with answer and citation_ids, then stop.`,
    }],
  };
}

export function expandCitationAliases(parsed, aliases = {}) {
  const expand = (id) => Object.hasOwn(aliases, id) ? aliases[id] : id;
  return {
    ...parsed,
    answer: parsed.answer
      .replace(/\{\{cite:([^{}]+)\}\}/g, (_, id) => `{{cite:${expand(id.trim())}}}`)
      .replace(/\[([a-zA-Z0-9_.:-]+)\]/g, (_, id) => `[${expand(id)}]`),
    citationIds: parsed.citationIds.map(expand),
  };
}
