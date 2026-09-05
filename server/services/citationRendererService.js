const CITATION_MARKER = /([.!?])?\s*\{\{cite:([a-zA-Z0-9._:-]+)\}\}/g;
const CITATION_TOKEN = /\{\{cite:([a-zA-Z0-9._:-]+)\}\}/g;

const INTERNAL_SOURCE_TITLES = new Set([
  "verified pension account records",
  "verified document status records",
  "deterministic pension projection",
  "verified investment and risk profile"
]);

export function isInternalPortfolioCitation(source = {}) {
  const sourceId = String(source.sourceId || source.source_id || "");
  const title = String(source.title || "").trim().toLowerCase();
  const section = String(source.section || "").trim().toLowerCase();
  const scope = String(source.scope || "").toUpperCase();
  if (sourceId.startsWith("structured_public_") || source.sourceType === "official_structured_tax_fact" || source.source_type === "official_structured_tax_fact") {
    return false;
  }
  return sourceId.startsWith("structured_")
    || scope === "USER_PORTFOLIO"
    || section.includes("authenticated info db")
    || INTERNAL_SOURCE_TITLES.has(title);
}

function formatAccessDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day:"numeric",month:"long",year:"numeric",timeZone:"UTC"
  }).format(date);
}

export function renderOscolaCitation(source = {}) {
  if (source.oscolaCitation) return String(source.oscolaCitation).trim();
  const metadata = source.citationMetadata || source.citation_metadata || {};
  const title = String(metadata.title || source.title || "").trim();
  const author = String(metadata.author || "").trim();
  const pinpoint = String(metadata.pinpoint || source.section || "").trim();
  const accessed = formatAccessDate(metadata.accessedAt || metadata.accessed_at);
  const kind = String(metadata.kind || metadata.citationKind || metadata.citation_kind || "").toLowerCase();
  if (!title) return null;
  if (kind === "website" || accessed) {
    const base = `${author ? `${author}, ` : ""}'${title}'`;
    return `${base}${accessed ? ` (accessed ${accessed})` : ""}`;
  }
  return `${title}${pinpoint ? `, ${pinpoint}` : ""}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(String))];
}

function sentenceSegments(text) {
  const segmenter = new Intl.Segmenter("en-GB",{ granularity:"sentence" });
  return [...segmenter.segment(String(text || ""))].map((entry) => entry.segment);
}

function claimCitationMap(answer) {
  // Move citations written immediately after sentence punctuation inside the
  // sentence before splitting. The renderer still accepts either form.
  const normalized = String(answer || "").replace(
    /([.!?])\s*((?:\{\{cite:[a-zA-Z0-9._:-]+\}\}\s*)+)/g,
    "$2$1 ",
  );
  const claims = [];
  for (const line of normalized.split(/\n+/)) {
    for (const segment of sentenceSegments(line)) {
      const raw = segment.trim();
      const claim = raw.replace(CITATION_TOKEN, " ").replace(/\s+/g, " ").replace(/\s+([.!?,;:])/g,"$1").trim();
      if (!/[a-z0-9]/i.test(claim)) continue;
      claims.push({ claim,source_ids:uniqueStrings([...raw.matchAll(CITATION_TOKEN)].map((item) => item[1])) });
    }
  }
  return claims;
}

export function attachCitationMarkers(answer, citationIds = []) {
  const ids = uniqueStrings(citationIds).filter(Boolean);
  const markerBlock = ids.map((id) => `{{cite:${id}}}`).join(" ");
  const clean = String(answer || "").replace(CITATION_TOKEN, " ").replace(/[ \t]+/g, " ").trim();
  if (!markerBlock || !clean) return clean;
  return clean.split("\n").map((line) => sentenceSegments(line).map((segment) => {
    const trailing = segment.match(/\s*$/)?.[0] || "";
    const core = segment.slice(0,segment.length - trailing.length);
    if (!/[a-z0-9]/i.test(core)) return segment;
    const punctuation = core.match(/[.!?]+$/)?.[0] || "";
    const body = punctuation ? core.slice(0,-punctuation.length) : core;
    return `${body.trimEnd()} ${markerBlock}${punctuation}${trailing}`;
  }).join("")).join("\n");
}

export function renderCitationMarkers(options = {}) {
  const { answer, citationIds = [], sources = [] } = options;
  const declaredCitationIds = uniqueStrings(citationIds);
  const citationIdsDeclared = Object.hasOwn(options, "citationIds");
  const sourceMap = new Map(sources.map((source) => [String(source.sourceId || source.source_id),source]));
  const markerIds = [];
  const hiddenCitationIds = [];
  const missingCitationMetadataIds = [];
  const renderedAnswer = String(answer || "").replace(CITATION_MARKER,(marker,punctuation,sourceId) => {
    markerIds.push(sourceId);
    const source = sourceMap.get(sourceId);
    if (!source) return marker;
    const metadata = source.citationMetadata || source.citation_metadata || {};
    if (metadata.userVisible === false || metadata.user_visible === false) {
      hiddenCitationIds.push(sourceId);
      return marker;
    }
    const citation = renderOscolaCitation(source);
    if (!citation) {
      missingCitationMetadataIds.push(sourceId);
      return marker;
    }
    if (isInternalPortfolioCitation(source)) return punctuation || "";
    return `${punctuation ? " " : marker.startsWith(" ") ? " " : ""}(${citation})${punctuation || ""}`;
  });
  const acceptedCitationIds = uniqueStrings(markerIds);
  const inventedCitationIds = acceptedCitationIds.filter((sourceId) => !sourceMap.has(sourceId));
  const declaredCitationMismatch = citationIdsDeclared
    && JSON.stringify(declaredCitationIds) !== JSON.stringify(acceptedCitationIds);
  const unrenderedDeclaredCitationIds = declaredCitationIds.filter((sourceId) => !acceptedCitationIds.includes(sourceId));
  const undeclaredMarkerCitationIds = acceptedCitationIds.filter((sourceId) => !declaredCitationIds.includes(sourceId));
  const malformedCitationMarkers = /\{\{cite:/i.test(renderedAnswer);
  return {
    answer:renderedAnswer,
    citationIds:acceptedCitationIds,
    markerIds:acceptedCitationIds,
    declaredCitationIds,
    declaredCitationMismatch,
    unrenderedDeclaredCitationIds,
    undeclaredMarkerCitationIds,
    claimCitations:claimCitationMap(answer),
    inventedCitationIds,
    hiddenCitationIds:[...new Set(hiddenCitationIds)],
    missingCitationMetadataIds:[...new Set(missingCitationMetadataIds)],
    malformedCitationMarkers,
    valid:inventedCitationIds.length === 0 && hiddenCitationIds.length === 0 && missingCitationMetadataIds.length === 0
      && !malformedCitationMarkers && !declaredCitationMismatch
  };
}
