import { createHash } from "node:crypto";
import { getPortfolioSeedForUser } from "../portfolioStore.js";
import { addDocumentConfidence, deleteDocumentRecord, storeScannedDocument } from "../services/documentService.js";
import { indexDocument, listKnowledgeDocuments, removeIndexedDocument } from "../services/knowledgeService.js";
import { completeWorkerJob, enqueueWorkerJob, failWorkerJob, startWorkerJob } from "../services/jobQueueService.js";
import {
  acceptLocalUpload,
  createUploadIntent,
  deleteUploadRecord,
  deleteStoredObject,
  extractReadableText,
  getUploadRecord,
  markUploadComplete,
  objectStorageStatus,
  readObject,
  scanDocumentBuffer,
  signatureMatches,
  writeNormalizedText
} from "../services/objectStorageService.js";

function match(pathname, expression) {
  const result = pathname.match(expression);
  return result ? result.slice(1).map(decodeURIComponent) : null;
}

function factsFromText(text = "") {
  const oneLine = text.replace(/\s+/g, " ");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lineValue = (pattern) => lines.map((line) => line.match(pattern)?.[1]?.trim()).find(Boolean);
  const provider = lineValue(/^(?:provider|scheme(?: administrator)?)\s*[:\-]\s*(.+)$/i);
  const policy = oneLine.match(/(?:policy|plan|account)(?: number| no\.?| #)?\s*[:\-]?\s*([A-Z]{1,8}[- ]?\d{4,})/i)?.[1];
  const potValue = oneLine.match(/(?:pot value|fund value|current value|balance)\s*[:\-]?\s*£\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1];
  const chargePct = oneLine.match(/(?:annual(?: management)? charge|management charge|charge)[^\d%]{0,60}(\d+(?:\.\d+)?)\s*%/i)?.[1];
  const statementDate = oneLine.match(/(?:statement date|as at|dated)\s*[:\-]?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
  return {
    ...(provider ? { provider } : {}),
    ...(policy ? { policy } : {}),
    ...(potValue ? { potValue:Number(potValue.replace(/,/g, "")) } : {}),
    ...(chargePct ? { chargePct:Number(chargePct) } : {}),
    ...(statementDate ? { statementDate } : {}),
    documentCategory:"Pension document"
  };
}

export async function handleDocumentMemoryRoute({ req, res, url, json, readBody, readBuffer, userId }) {
  if (url.pathname === "/api/documents/upload-intents") {
    if (req.method !== "POST") return json(res, 405, { error:"Method not allowed" });
    const raw = await readBody(req);
    const origin = `${req.socket?.encrypted ? "https" : "http"}://${req.headers.host}`;
    return json(res, 201, await createUploadIntent(userId, raw ? JSON.parse(raw) : {}, origin));
  }
  const uploadMatch = match(url.pathname, /^\/api\/documents\/uploads\/([^/]+)$/);
  if (uploadMatch) {
    if (req.method !== "PUT") return json(res, 405, { error:"Method not allowed" });
    const buffer = await readBuffer(req);
    const record = await acceptLocalUpload(userId, uploadMatch[0], url.searchParams.get("token"), buffer, req.headers["content-type"]);
    return json(res, 200, { document_id:record.id,checksum:record.checksum,status:record.status });
  }
  const completeMatch = match(url.pathname, /^\/api\/documents\/([^/]+)\/complete$/);
  if (completeMatch) {
    if (req.method !== "POST") return json(res, 405, { error:"Method not allowed" });
    const bodyRaw = await readBody(req);
    const body = bodyRaw ? JSON.parse(bodyRaw) : {};
    const allowedPrivateSourceTypes = new Set(["scheme_rules","provider_policy","statement_of_investment_principles","user_pension_document"]);
    const privateSourceType = body.source_type || "user_pension_document";
    if (!allowedPrivateSourceTypes.has(privateSourceType)) return json(res, 400, { error:"source_type must be scheme_rules, provider_policy, statement_of_investment_principles, or user_pension_document." });
    const record = await getUploadRecord(userId, completeMatch[0]);
    const directS3Upload = objectStorageStatus().mode === "s3" && record?.status === "pending";
    if (!record || (record.status !== "uploaded" && !directS3Upload)) return json(res, 409, { error:"Document upload is not complete." });
    const buffer = await readObject(record);
    if (buffer.length !== Number(record.sizeBytes) || !signatureMatches(buffer, record.mimeType)) return json(res, 415, { error:"Stored object size or file signature is invalid." });
    await scanDocumentBuffer(buffer, record.mimeType);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    if (record.checksum && checksum !== record.checksum) return json(res, 400, { error:"Stored document checksum validation failed." });
    if (body.checksum && body.checksum !== checksum) return json(res, 400, { error:"Document checksum does not match the uploaded object." });
    record.checksum = checksum;
    const job = await enqueueWorkerJob(userId, { type:"document_ingestion",payload:{ documentId:record.id,checksum } });
    await startWorkerJob(userId, job.id);
    try {
      const text = await extractReadableText(buffer, record.mimeType);
      const normalizedTextKey = await writeNormalizedText(userId, record.id, text);
      const indexed = await indexDocument(userId, {
        id:record.id,title:body.title || record.filename,authority:body.authority || "User upload",jurisdiction:body.jurisdiction || "UK",
        publishedAt:body.publication_date || null,effectiveDate:body.effective_date || null,expiryDate:body.expiry_date || null,
        canonicalLocation:body.canonical_location || null,licence:"private-user-document",checksum,mimeType:record.mimeType,
        objectKey:record.objectKey,normalizedTextKey,scope:"USER_DOCUMENTS",documentType:body.document_type || "policy",text,
        metadata:{ filename:record.filename,ingestionStatus:"validated",sourceType:privateSourceType,
          approvalStatus:"pending_review",issuer:body.issuer || body.authority || "Unconfirmed user upload",
          private:true,fineTuningEligible:false,admissionScope:"USER_DOCUMENTS" }
      });
      const extraction = addDocumentConfidence(factsFromText(text), { name:record.filename,text });
      const portfolioDocument = storeScannedDocument(userId, getPortfolioSeedForUser(userId), { name:record.filename,text }, extraction, { provider:"local-ingestion",model:"deterministic-facts-v1",summary:`Indexed ${indexed.chunkCount} searchable sections.`,documentId:record.id });
      await markUploadComplete(userId, record, { normalizedTextKey,knowledgeDocumentId:indexed.document.id });
      await completeWorkerJob(userId, job.id, { documentId:record.id,chunkCount:indexed.chunkCount });
      return json(res, 200, { job_id:job.id,document:indexed.document,portfolio_document:portfolioDocument,chunk_count:indexed.chunkCount,quarantined_chunk_count:indexed.quarantinedChunkCount,embedding_model:indexed.embeddingModel,degraded_embedding:indexed.degradedEmbedding,extraction });
    } catch (error) {
      await failWorkerJob(userId, job.id, error);
      throw error;
    }
  }
  if (url.pathname === "/api/knowledge/documents") {
    if (req.method === "GET") return json(res, 200, { documents:await listKnowledgeDocuments(userId),storage:objectStorageStatus() });
    return json(res, 405, { error:"Method not allowed" });
  }
  const knowledgeMatch = match(url.pathname, /^\/api\/knowledge\/documents\/([^/]+)$/);
  if (knowledgeMatch) {
    if (req.method !== "DELETE") return json(res, 405, { error:"Method not allowed" });
    const removed = await removeIndexedDocument(userId, knowledgeMatch[0]);
    if (!removed) return json(res, 404, { error:"Indexed document not found" });
    await Promise.all([deleteStoredObject(removed.objectKey), deleteStoredObject(removed.normalizedTextKey)]);
    await deleteUploadRecord(userId, knowledgeMatch[0]);
    deleteDocumentRecord(userId, getPortfolioSeedForUser(userId), knowledgeMatch[0]);
    return json(res, 200, { deleted:true,document_id:knowledgeMatch[0] });
  }
  return false;
}
