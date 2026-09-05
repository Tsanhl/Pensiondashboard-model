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
    return `SOURCE ${alias}\nCitation token: {{cite:${alias}}}\nTitle: ${source.title}\nType: ${source.sourceType || "verified record"}\nSource role: ${source.sourceRole || "not recorded"}\nPriority: ${source.authorityRank || 0.5}\nScope: ${source.scope}\nJurisdiction/extent: ${source.jurisdiction || "not recorded — do not infer"}\nEffective/current-check date(s): ${territorialDates}\nCase treatment: ${treatment}\nSection: ${source.section || "unknown"}\nEvidence${sourceExcerpts[index].truncated ? " (verbatim excerpt; surrounding text omitted)" : ""}: ${source.snippet}`;
  }).join("\n\n");
  return {
    citationAliases,
    evidenceSources,
    sourceExcerpts,
    messages: [...history.map(({ role, content }) => ({ role, content })), {
      role: "user",
      content: `QUERY\n${query.self_contained_query}\nRequested jurisdiction: ${query.jurisdiction_scope}\nRequired response route: ${query.response_route}\nHandoff reason: ${query.handoff_reason || "none"}\nResponse requirements: ${(query.response_requirements || []).join(" ") || "answer every material fact in the query"}\n\nVERIFIED SOURCES\n${text}\nEND VERIFIED SOURCES\n\nANSWER TASK\nAnswer the QUERY in your own words, usually in 2–4 short sentences. Correct any false premise; do not repeat the question as an assertion or copy source paragraphs. Apply the supplied dates and figures. Speak as the information assistant, not as a regulator, judge or trustee. Follow the response route and make any required human handoff visible. Cite each material sentence using only the supplied tokens. Return the complete JSON object with answer and citation_ids, then stop.`,
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
