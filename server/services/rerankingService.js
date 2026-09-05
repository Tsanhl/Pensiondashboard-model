function tokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9£%]+/g) || []);
}

function legalReferenceCoverage(query, evidence) {
  const references = [...String(query || "").matchAll(/\b(?:section|regulation|article|rule|schedule|paragraph)\s+\d+[a-z]?(?:\([0-9a-z]+\))*/gi)]
    .map((match) => match[0].toLowerCase());
  if (!references.length) return 0;
  const normalizedEvidence = String(evidence || "").toLowerCase();
  return references.filter((reference) => normalizedEvidence.includes(reference)).length / references.length;
}

function legalMatchSignals(query, source) {
  const titleMatch = source.title && String(query).toLowerCase().includes(String(source.title).toLowerCase()) ? 1 : 0;
  return {
    referenceCoverage:legalReferenceCoverage(query, `${source.title} ${source.section} ${source.snippet}`),
    directReferenceCoverage:legalReferenceCoverage(query, source.section),
    titleMatch
  };
}

function sourceRoleScore(source) {
  const role = String(source.sourceRole || source.source_role || "").toLowerCase();
  const type = String(source.sourceType || "").toLowerCase();
  if (["operative_legislation","judgment_holding"].includes(role)) return 1;
  if (type.includes("legislation") || type === "primary_legislation" || type === "secondary_legislation") return 1;
  if (type.includes("case_law") && !type.includes("summary")) return 0.75;
  if (["official_guidance","official_structured_fact"].includes(role) || type.startsWith("official_") || type === "regulatory_guidance") return 0.82;
  if (["judgment_facts","explanatory_note"].includes(role)) return 0.45;
  if (["party_submission","secondary_summary"].includes(role)) return 0.25;
  return 0.5;
}

function topicMatchScore(query,source) {
  const text = `${source.title || ""} ${source.section || ""} ${source.snippet || ""}`;
  if (/\b(?:scam|unlock|release fee|transfer today|urgent(?:ly)?[^.!?]{0,40}transfer|unsolicited|pressur(?:e|ed|ing)|incentive)\b/i.test(query)
    && /\b(?:scam|unauthorised|red flag|amber flag|unsolicited|pressure|incentive|specified guidance|moneyhelper)\b/i.test(text)) return 1;
  if (/\b(?:same[- ]sex|survivor pension)\b/i.test(query) && /\b(?:sex equality|same[- ]sex|walker|survivor)\b/i.test(text)) return 1;
  if (/\bopt(?:ing)?\s+out\b/i.test(query) && /\bopt(?:ing)?\s+out\b/i.test(text)) return 1;
  return 0;
}

function fallbackScore(query, source, entities = {}) {
  const queryTerms = tokens(query);
  const evidence = `${source.title} ${source.section} ${source.snippet}`;
  const evidenceTerms = tokens(evidence);
  const coverage = queryTerms.size ? [...queryTerms].filter((term) => evidenceTerms.has(term)).length / queryTerms.size : 0;
  const entityTerms = tokens(Object.values(entities).join(" "));
  const entityCoverage = entityTerms.size ? [...entityTerms].filter((term) => evidenceTerms.has(term)).length / entityTerms.size : 0;
  const { referenceCoverage,directReferenceCoverage,titleMatch } = legalMatchSignals(query, source);
  return Math.min(1,
    0.47 * Number(source.score || 0)
    + 0.15 * coverage
    + 0.08 * entityCoverage
    + 0.15 * Number(source.authorityRank || 0.5)
    + 0.08 * sourceRoleScore(source)
    + 0.25 * topicMatchScore(query,source)
    + 0.10 * referenceCoverage
    + 0.18 * directReferenceCoverage
    + 0.10 * titleMatch
  );
}

function sourceDocumentKey(source) {
  if (source.documentId) return String(source.documentId);
  return String(source.sourceId || "").replace(/_chunk_\d+$/, "");
}

function diversifySources(sources, limit, maxPerDocument = 2) {
  const selected = [];
  const counts = new Map();
  for (const source of sources) {
    const key = sourceDocumentKey(source);
    const count = counts.get(key) || 0;
    if (count >= maxPerDocument) continue;
    selected.push(source);
    counts.set(key, count + 1);
    if (selected.length >= limit) break;
  }
  if (selected.length < limit) {
    const selectedIds = new Set(selected.map((source) => source.sourceId));
    for (const source of sources) {
      if (selectedIds.has(source.sourceId)) continue;
      selected.push(source);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export async function rerankSources(query, sources = [], { entities = {},limit = 8 } = {}) {
  if (!sources.length) return { sources:[],mode:"none",model:null,degraded:false };
  const baseUrl = String(process.env.RERANK_SERVICE_URL || "").replace(/\/$/, "");
  const crossEncoderRequired = String(process.env.REQUIRE_CROSS_ENCODER_RERANK || "false").toLowerCase() === "true";
  if (!baseUrl && crossEncoderRequired) {
    throw Object.assign(new Error("RERANK_SERVICE_URL is required when cross-encoder reranking is mandatory."), { code:"RERANK_CONFIG_ERROR" });
  }
  if (baseUrl) {
    try {
      const response = await fetch(`${baseUrl}/rerank`, {
        method:"POST",headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ model:process.env.RERANK_MODEL || "BAAI/bge-reranker-base",query,documents:sources.map((source) => `${source.title}\n${source.section || ""}\n${source.snippet}`),top_n:limit }),
        signal:AbortSignal.timeout(Number(process.env.RERANK_TIMEOUT_MS || 20_000))
      });
      if (!response.ok) throw new Error(`reranker returned ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.results)) throw new Error("reranker results are invalid");
      const ranked = payload.results.map((item) => {
        const source = sources[Number(item.index)];
        if (!source) return null;
        const { referenceCoverage,directReferenceCoverage,titleMatch } = legalMatchSignals(query, source);
        const rerankScore = Math.min(1,
          0.65 * Number(item.score)
          + 0.12 * Number(source.authorityRank || 0.5)
          + 0.08 * sourceRoleScore(source)
          + 0.25 * topicMatchScore(query,source)
          + 0.07 * referenceCoverage
          + 0.18 * directReferenceCoverage
          + 0.13 * titleMatch
        );
        return { ...source,crossEncoderScore:Number(item.score),rerankScore };
      }).filter(Boolean).sort((left,right) => right.rerankScore - left.rerankScore);
      return { sources:diversifySources(ranked, limit),mode:"cross_encoder",model:payload.model || process.env.RERANK_MODEL,degraded:false };
    } catch (error) {
      if (crossEncoderRequired) throw error;
    }
  }
  return {
    sources:diversifySources(sources.map((source) => ({ ...source,rerankScore:fallbackScore(query, source, entities) })).sort((a,b) => b.rerankScore - a.rerankScore), limit),
    mode:"deterministic_fallback",model:null,degraded:true
  };
}
