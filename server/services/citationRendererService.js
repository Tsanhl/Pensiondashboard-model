const CITATION_MARKER = /([.!?])?\s*\{\{cite:([a-zA-Z0-9._:-]+)\}\}/g;

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

export function renderCitationMarkers({ answer, citationIds = [], sources = [] }) {
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
    return `${punctuation ? " " : marker.startsWith(" ") ? " " : ""}(${citation})${punctuation || ""}`;
  });
  const combinedIds = [...new Set([...citationIds.map(String),...markerIds])];
  const inventedCitationIds = combinedIds.filter((sourceId) => !sourceMap.has(sourceId));
  const malformedCitationMarkers = /\{\{cite:/i.test(renderedAnswer);
  return {
    answer:renderedAnswer,
    citationIds:combinedIds,
    markerIds:[...new Set(markerIds)],
    inventedCitationIds,
    hiddenCitationIds:[...new Set(hiddenCitationIds)],
    missingCitationMetadataIds:[...new Set(missingCitationMetadataIds)],
    malformedCitationMarkers,
    valid:inventedCitationIds.length === 0 && hiddenCitationIds.length === 0 && missingCitationMetadataIds.length === 0 && !malformedCitationMarkers
  };
}
