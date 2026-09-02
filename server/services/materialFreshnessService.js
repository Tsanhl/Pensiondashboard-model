import { createHash, timingSafeEqual } from "node:crypto";
import { indexDocument, listKnowledgeDocuments, removeIndexedDocument } from "./knowledgeService.js";
import { completeWorkerJob, enqueueWorkerJob, failWorkerJob, listJobsAsync, startWorkerJob } from "./jobQueueService.js";
import { retrievalMetrics } from "./retrievalMetricsService.js";
import { safeLog } from "./debugLoggingService.js";

export const PUBLIC_KNOWLEDGE_USER = "__public__";
const REQUIRED_METADATA = ["title","authority","jurisdiction","canonical_location","version","licence"];

export function materialWebhookAuthorised(req) {
  const expected = String(process.env.MATERIAL_WEBHOOK_SECRET || "");
  if (!expected) return process.env.NODE_ENV !== "production";
  const supplied = String(req.headers["x-material-webhook-secret"] || "");
  if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function validateDate(value, label) {
  if (value && !Number.isFinite(Date.parse(value))) throw Object.assign(new Error(`${label} must be an ISO date.`), { status:400 });
}

export function validateMaterialChange(input = {}) {
  const operation = String(input.operation || "UPSERT").toUpperCase();
  if (!["UPSERT","DELETE"].includes(operation)) throw Object.assign(new Error("operation must be UPSERT or DELETE."), { status:400 });
  const documentId = String(input.document_id || "").trim();
  if (!documentId) throw Object.assign(new Error("document_id is required."), { status:400 });
  if (operation === "DELETE") return { operation,documentId };
  const metadata = input.metadata || {};
  const missing = REQUIRED_METADATA.filter((field) => metadata[field] === undefined || metadata[field] === null || String(metadata[field]).trim() === "");
  if (missing.length) throw Object.assign(new Error(`Missing approved material metadata: ${missing.join(", ")}.`), { status:400 });
  if (!String(input.text || "").trim()) throw Object.assign(new Error("text is required for an UPSERT change event."), { status:400 });
  validateDate(metadata.publication_date, "publication_date");
  validateDate(metadata.effective_date, "effective_date");
  validateDate(metadata.expiry_date, "expiry_date");
  if (metadata.expiry_date && metadata.effective_date && Date.parse(metadata.expiry_date) <= Date.parse(metadata.effective_date)) {
    throw Object.assign(new Error("expiry_date must be later than effective_date."), { status:400 });
  }
  return { operation,documentId,text:String(input.text),documentType:input.document_type || "policy",metadata };
}

export async function enqueueMaterialChange(input) {
  const change = validateMaterialChange(input);
  return enqueueWorkerJob(PUBLIC_KNOWLEDGE_USER, { type:"knowledge_change",payload:change,maxAttempts:5 });
}

async function processChange(change) {
  if (change.operation === "DELETE") return { deleted:Boolean(await removeIndexedDocument(PUBLIC_KNOWLEDGE_USER, change.documentId)),documentId:change.documentId };
  const metadata = change.metadata;
  const checksum = metadata.checksum || createHash("sha256").update(change.text).digest("hex");
  const indexed = await indexDocument(PUBLIC_KNOWLEDGE_USER, {
    id:change.documentId,version:Number(metadata.version),title:metadata.title,authority:metadata.authority,jurisdiction:metadata.jurisdiction,
    canonicalLocation:metadata.canonical_location,publishedAt:metadata.publication_date || null,effectiveDate:metadata.effective_date || null,
    expiryDate:metadata.expiry_date || null,checksum,licence:metadata.licence,scope:"CURATED_PUBLIC",documentType:change.documentType,text:change.text,
    metadata:{ sourceFamily:metadata.source_family || null,reviewedBy:metadata.reviewed_by || null,approvedAt:metadata.approved_at || null,updateCycleDays:Number(metadata.update_cycle_days || 90),ingestionStatus:"approved_change_event" }
  });
  return { documentId:indexed.document.id,version:indexed.document.version,chunkCount:indexed.chunkCount,checksum };
}

export async function processMaterialQueueOnce() {
  const jobs = [...await listJobsAsync(PUBLIC_KNOWLEDGE_USER, { status:"queued",limit:10 }),...await listJobsAsync(PUBLIC_KNOWLEDGE_USER, { status:"retry",limit:10 })]
    .filter((job) => job.type === "knowledge_change" && (!job.runAfter || Date.parse(job.runAfter) <= Date.now())).slice(0, 5);
  for (const job of jobs) {
    try {
      await startWorkerJob(PUBLIC_KNOWLEDGE_USER, job.id, `material-worker-${process.pid}`);
      const result = await processChange(job.payload);
      await completeWorkerJob(PUBLIC_KNOWLEDGE_USER, job.id, result);
    } catch (error) {
      await failWorkerJob(PUBLIC_KNOWLEDGE_USER, job.id, error);
    }
  }
  return jobs.length;
}

export async function knowledgeFreshnessReport() {
  const now = Date.now();
  const documents = (await listKnowledgeDocuments(PUBLIC_KNOWLEDGE_USER)).filter((item) => item.scope === "CURATED_PUBLIC");
  const rows = documents.map((item) => {
    const ageDays = Math.floor((now - Date.parse(item.updatedAt || item.createdAt)) / 86400000);
    const updateCycleDays = Math.max(1, Number(item.metadata?.updateCycleDays || 90));
    const expired = Boolean(item.expiryDate && Date.parse(item.expiryDate) <= now);
    return { documentId:item.id,title:item.title,version:item.version,status:item.status,lastUpdated:item.updatedAt,ageDays,updateCycleDays,stale:ageDays > updateCycleDays,expiresAt:item.expiryDate || null,expired };
  });
  const metrics = await retrievalMetrics();
  return { generatedAt:new Date().toISOString(),documents:rows,stale:rows.filter((item) => item.stale),expired:rows.filter((item) => item.expired),retrieval:metrics };
}

let workerTimer = null;
let monitorTimer = null;
export function startKnowledgeFreshnessServices() {
  if (!workerTimer) {
    workerTimer = setInterval(() => processMaterialQueueOnce().catch((error) => console.warn(`Material worker failed: ${error.message}`)), Number(process.env.MATERIAL_WORKER_INTERVAL_MS || 5000));
    workerTimer.unref?.();
  }
  if (!monitorTimer) {
    monitorTimer = setInterval(async () => {
      const report = await knowledgeFreshnessReport();
      if (report.stale.length || report.expired.length || report.retrieval.noResultRate >= Number(process.env.RETRIEVAL_NO_RESULT_ALERT_RATE || 0.25)) {
        safeLog("freshness", { stale:report.stale,expired:report.expired,retrieval:report.retrieval,alert:true });
      }
    }, Number(process.env.FRESHNESS_MONITOR_INTERVAL_MS || 3600000));
    monitorTimer.unref?.();
  }
  processMaterialQueueOnce().catch(() => {});
}
