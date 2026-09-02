import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const graphPath = fileURLToPath(new URL("../../approved-materials/index/case-treatment-graph.json", import.meta.url));

function loadGraph() {
  try {
    return JSON.parse(readFileSync(graphPath, "utf8"));
  } catch {
    return { schema_version:1,verified_at:null,edges:[] };
  }
}

const graph = loadGraph();

export function getCaseTreatment(documentId) {
  if (!documentId) return null;
  const related = graph.edges.filter((edge) => edge.from === documentId || edge.to === documentId).map((edge) => ({
    direction:edge.from === documentId ? "outgoing" : "incoming_later_treatment",
    relationship:edge.relationship,
    relatedDocumentId:edge.from === documentId ? edge.to : edge.from,
    assertionSource:edge.assertion_source,
    note:edge.note,
    verified:Boolean(edge.verified)
  }));
  if (!related.length) return null;
  return { graphVersion:graph.schema_version,verifiedAt:graph.verified_at,related };
}

export function annotateCaseTreatment(sources = []) {
  return sources.map((source) => {
    const caseTreatment = getCaseTreatment(source.documentId);
    return caseTreatment ? { ...source,caseTreatment } : source;
  });
}

export function readCaseTreatmentGraph() {
  return structuredClone(graph);
}
