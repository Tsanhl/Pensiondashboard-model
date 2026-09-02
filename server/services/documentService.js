import { appendAuditEvent, newId, readPortfolio, writePortfolio } from "../store/userDataStore.js";
import { clone, isoNow, slugify } from "../utils/values.js";

const FIELD_LABELS = {
  provider: "Provider",
  scheme: "Scheme",
  policy: "Policy number",
  statementDate: "Statement date",
  potValue: "Pot value",
  salaryMonthly: "Monthly salary",
  salaryAnnual: "Annual salary",
  contributionEmployee: "Employee contribution",
  contributionEmployer: "Employer contribution",
  contribution: "Total contribution",
  chargePct: "Annual charge",
  statePensionMonthly: "State Pension monthly"
};

function fieldConfidence(field, value, file = {}) {
  if (value == null || value === "") return "needs_review";
  const hasReadableText = Boolean(String(file.text || "").trim());
  if (["provider", "policy", "statementDate"].includes(field)) return hasReadableText ? "high" : "medium";
  if (["potValue", "chargePct", "statePensionMonthly"].includes(field)) return hasReadableText ? "high" : "medium";
  if (["contributionEmployee", "contributionEmployer", "contribution", "salaryMonthly", "salaryAnnual"].includes(field)) return hasReadableText ? "medium" : "needs_review";
  return hasReadableText ? "medium" : "needs_review";
}

function aggregateConfidence(fieldConfidenceMap) {
  const values = Object.values(fieldConfidenceMap || {});
  if (!values.length) return "Needs review";
  const known = values.filter((value) => value !== "needs_review");
  if (!known.length) return "Needs review";
  if (known.every((value) => value === "high")) return "High";
  if (known.some((value) => value === "high" || value === "medium")) return "Medium";
  return "Needs review";
}

export function addDocumentConfidence(extraction = {}, file = {}) {
  const fieldConfidenceMap = {};
  for (const field of Object.keys(FIELD_LABELS)) {
    fieldConfidenceMap[field] = fieldConfidence(field, extraction[field], file);
  }
  const reviewFields = Object.entries(fieldConfidenceMap)
    .filter(([, confidence]) => confidence === "needs_review")
    .map(([field]) => ({ field, label: FIELD_LABELS[field] }));
  return {
    ...extraction,
    fieldConfidence: fieldConfidenceMap,
    confidence: aggregateConfidence(fieldConfidenceMap),
    reviewFields
  };
}

function normaliseDocuments(documents = []) {
  return documents.map((documentItem, index) => ({
    id: documentItem.id || `doc_${slugify(documentItem.provider || documentItem.name || "document")}_${index + 1}`,
    ...documentItem
  }));
}

export function listDocuments(userId, seedPortfolio = {}) {
  const portfolio = readPortfolio(userId, seedPortfolio);
  return normaliseDocuments(portfolio.documents || []);
}

export function storeScannedDocument(userId, seedPortfolio, file = {}, extraction = {}, meta = {}) {
  const portfolio = readPortfolio(userId, seedPortfolio);
  const documents = normaliseDocuments(portfolio.documents || []);
  const enhanced = extraction.fieldConfidence ? extraction : addDocumentConfidence(extraction, file);
  const documentRecord = {
    id: meta.documentId || newId("doc"),
    name: file.fileName || file.name || `Uploaded document ${documents.length + 1}`,
    type: enhanced.documentCategory || "Uploaded document",
    provider: enhanced.provider || "Needs review",
    date: enhanced.statementDate || new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    status: "Review",
    source: "Upload",
    confidence: enhanced.confidence || "Needs review",
    extracted: enhanced,
    scan: {
      provider: meta.provider || "local",
      model: meta.model || "unknown",
      summary: meta.summary || "",
      scannedAt: isoNow()
    }
  };
  const nextPortfolio = {
    ...portfolio,
    documents: [documentRecord, ...documents]
  };
  writePortfolio(userId, nextPortfolio);
  appendAuditEvent(userId, {
    type: "document_scanned",
    documentId: documentRecord.id,
    provider: documentRecord.provider,
    confidence: documentRecord.confidence,
    scanProvider: meta.provider || "local",
    model: meta.model || "unknown"
  });
  return clone(documentRecord);
}

export function updateDocumentFacts(userId, seedPortfolio, documentId, facts = {}) {
  const portfolio = readPortfolio(userId, seedPortfolio);
  const documents = normaliseDocuments(portfolio.documents || []);
  const documentRecord = documents.find((item) => item.id === documentId);
  if (!documentRecord) {
    const error = new Error("Document not found");
    error.status = 404;
    throw error;
  }
  documentRecord.extracted = {
    ...(documentRecord.extracted || {}),
    ...facts,
    fieldConfidence: {
      ...(documentRecord.extracted?.fieldConfidence || {}),
      ...(facts.fieldConfidence || {})
    }
  };
  documentRecord.status = "Review";
  documentRecord.updatedAt = isoNow();
  writePortfolio(userId, { ...portfolio, documents });
  appendAuditEvent(userId, {
    type: "document_facts_updated",
    documentId,
    fields: Object.keys(facts).filter((key) => key !== "fieldConfidence")
  });
  return clone(documentRecord);
}

export function confirmDocumentFacts(userId, seedPortfolio, documentId, confirmation = {}) {
  const portfolio = readPortfolio(userId, seedPortfolio);
  const documents = normaliseDocuments(portfolio.documents || []);
  const documentRecord = documents.find((item) => item.id === documentId);
  if (!documentRecord) {
    const error = new Error("Document not found");
    error.status = 404;
    throw error;
  }
  documentRecord.status = confirmation.status || "Checked";
  documentRecord.confirmedAt = isoNow();
  documentRecord.confirmedBy = confirmation.confirmedBy || userId;
  documentRecord.reviewNote = String(confirmation.note || "").trim();
  writePortfolio(userId, { ...portfolio, documents });
  appendAuditEvent(userId, {
    type: "document_confirmed",
    documentId,
    status: documentRecord.status,
    confirmedBy: documentRecord.confirmedBy
  });
  return clone(documentRecord);
}

export function deleteDocumentRecord(userId, seedPortfolio, documentId) {
  const portfolio = readPortfolio(userId, seedPortfolio);
  const documents = normaliseDocuments(portfolio.documents || []);
  const next = documents.filter((item) => item.id !== documentId);
  if (next.length === documents.length) return false;
  writePortfolio(userId, { ...portfolio,documents:next });
  appendAuditEvent(userId, { type:"document_deleted",documentId });
  return true;
}
