import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { indexDocument } from "./knowledgeService.js";
import { structuralChunk } from "./chunkingService.js";
import { listKnowledgeChunksForIntegrity, listKnowledgeDocuments } from "../repositories/knowledgeRepository.js";
import { upsertPublicFactCollection } from "../repositories/publicFactRepository.js";
import { readPublicFacts } from "../store/userDataStore.js";

const PUBLIC_USER = "__public__";
let sourcePolicyCache = null;
const REQUIRED_DOCUMENT_FIELDS = [
  "id",
  "title",
  "authority",
  "jurisdiction",
  "canonical_location",
  "version",
  "effective_date",
  "licence",
  "reviewer",
  "approval_status",
  "source_type",
  "text_path",
  "text_sha256"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function configuration(environment = process.env) {
  return {
    manifestPath: String(environment.APPROVED_CORPUS_MANIFEST_PATH || "").trim(),
    expectedManifestSha256: String(environment.APPROVED_CORPUS_MANIFEST_SHA256 || "").trim().toLowerCase(),
    minimumDocuments: Math.max(1, Number(environment.APPROVED_CORPUS_MIN_DOCUMENTS || 1))
  };
}

function configurationError(message, code = "CORPUS_CONFIG_ERROR") {
  return Object.assign(new Error(message), { code });
}

function assertSha256(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ""))) {
    throw configurationError(`${label} must be a complete SHA-256 digest.`);
  }
}

function containedTextPath(manifestPath, textPath) {
  if (isAbsolute(textPath)) throw configurationError("Approved-corpus text_path values must be relative to the manifest.");
  const manifestDirectory = dirname(manifestPath);
  const target = resolve(manifestDirectory, textPath);
  const rel = relative(manifestDirectory, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw configurationError("Approved-corpus text_path escapes the manifest directory.");
  }
  return target;
}

function normalisedTextBytes(bytes,mode = null) {
  if (!mode || mode === "none") return bytes;
  if (mode === "strip_one_trailing_lf") {
    return bytes.length && bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0,bytes.length - 1) : bytes;
  }
  throw configurationError(`Unsupported approved-corpus text_normalization: ${mode}.`);
}

function validateManifestShape(manifest, { minimumDocuments }) {
  if (manifest?.schema_version !== 1) throw configurationError("Approved-corpus manifest schema_version must be 1.");
  if (manifest.approval_status !== "approved") throw configurationError("Approved-corpus manifest is not approved.");
  if (!String(manifest.approved_by || "").trim() || !Number.isFinite(Date.parse(manifest.approved_at || ""))) {
    throw configurationError("Approved-corpus manifest requires approved_by and a valid approved_at timestamp.");
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length < minimumDocuments) {
    throw configurationError(`Approved-corpus manifest must contain at least ${minimumDocuments} approved documents.`);
  }
  const ids = new Set();
  for (const [index, document] of manifest.documents.entries()) {
    for (const field of REQUIRED_DOCUMENT_FIELDS) {
      if (field === 'effective_date' && document.source_type === 'official_guidance' && document.date_basis === 'guidance_no_legal_effective_date' && document.effective_date === null) continue;
      if (document?.[field] === undefined || document?.[field] === null || String(document[field]).trim() === "") {
        throw configurationError(`Approved-corpus document ${index + 1} is missing ${field}.`);
      }
    }
    if (document.approval_status !== "approved") throw configurationError(`Approved-corpus document ${document.id} is not approved.`);
    if (!Number.isInteger(Number(document.version)) || Number(document.version) < 1) throw configurationError(`Approved-corpus document ${document.id} has an invalid version.`);
    if (!(document.source_type === 'official_guidance' && document.date_basis === 'guidance_no_legal_effective_date' && document.effective_date === null)
      && !Number.isFinite(Date.parse(document.effective_date))) throw configurationError(`Approved-corpus document ${document.id} has an invalid effective_date.`);
    if (document.expiry_date && !Number.isFinite(Date.parse(document.expiry_date))) throw configurationError(`Approved-corpus document ${document.id} has an invalid expiry_date.`);
    assertSha256(document.text_sha256, `Approved-corpus document ${document.id} text_sha256`);
    normalisedTextBytes(Buffer.alloc(0),document.text_normalization || null);
    if (ids.has(document.id)) throw configurationError(`Approved-corpus document id ${document.id} is duplicated.`);
    ids.add(document.id);
  }
  const collectionIds = new Set();
  for (const [index, collection] of (manifest.structured_fact_collections || []).entries()) {
    for (const field of ["collection_id", "path", "sha256", "reviewer", "approval_status"]) {
      if (collection?.[field] === undefined || collection?.[field] === null || String(collection[field]).trim() === "") {
        throw configurationError(`Approved-corpus structured fact collection ${index + 1} is missing ${field}.`);
      }
    }
    if (collection.approval_status !== "approved") {
      throw configurationError(`Approved-corpus structured fact collection ${collection.collection_id} is not approved.`);
    }
    assertSha256(collection.sha256, `Approved-corpus structured fact collection ${collection.collection_id} sha256`);
    if (collectionIds.has(collection.collection_id)) {
      throw configurationError(`Approved-corpus structured fact collection ${collection.collection_id} is duplicated.`);
    }
    collectionIds.add(collection.collection_id);
  }
  return manifest;
}

function normalizedCollectionFacts(collection) {
  return (collection.facts || []).map((fact) => ({
    ...fact,
    collectionId:collection.collection_id,
    jurisdiction:collection.jurisdiction,
    validFrom:collection.valid_from,
    validTo:collection.valid_to,
    lastVerifiedAt:collection.last_verified_at,
    reviewCycleDays:Number(collection.review_cycle_days || 7),
    fineTuningEligible:false,
    status:"active"
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function expectedDocumentChunks(document) {
  const quarantinePattern = /\b(?:ignore (?:all |the )?(?:previous|system) instructions|system prompt|developer message|assistant must|reveal (?:the )?prompt|do not follow (?:the )?rules)\b/i;
  return structuralChunk(document.text, { documentType:document.document_type || document.source_type }).map((chunk, index) => ({
    id:`${document.id}_chunk_${index + 1}`,
    documentId:document.id,
    sectionPath:chunk.sectionPath,
    ordinal:chunk.ordinal,
    tokenCount:chunk.tokenCount,
    contentSha256:sha256(chunk.content),
    quarantined:quarantinePattern.test(chunk.content),
  }));
}

function actualDocumentChunks(chunks, documentIds) {
  return chunks.filter((chunk) => documentIds.has(chunk.documentId)).map((chunk) => ({
    id:chunk.id,
    documentId:chunk.documentId,
    sectionPath:chunk.sectionPath,
    ordinal:Number(chunk.ordinal),
    tokenCount:Number(chunk.tokenCount),
    contentSha256:sha256(String(chunk.content || "")),
    quarantined:Boolean(chunk.metadata?.quarantined),
    embeddingSha256:sha256(stableJson(chunk.embedding)),
    embeddingPresent:Array.isArray(chunk.embedding) ? chunk.embedding.length > 0 && chunk.embedding.every(Number.isFinite) : /^\[[^\]]+\]$/.test(String(chunk.embedding || "")),
  })).sort((left, right) => `${left.documentId}:${left.id}`.localeCompare(`${right.documentId}:${right.id}`));
}

function chunkContentView(chunks) {
  return chunks.map(({ embeddingSha256,embeddingPresent,...chunk }) => chunk);
}

function chunksMatchExpected(actual, expected) {
  return actual.length === expected.length && actual.every((chunk) => chunk.embeddingPresent) && stableJson(chunkContentView(actual)) === stableJson(expected);
}

export async function loadApprovedCorpusManifest({ environment = process.env,includeText = true } = {}) {
  const config = configuration(environment);
  if (!config.manifestPath) throw configurationError("APPROVED_CORPUS_MANIFEST_PATH is required.");
  assertSha256(config.expectedManifestSha256, "APPROVED_CORPUS_MANIFEST_SHA256");
  const manifestPath = resolve(config.manifestPath);
  const bytes = await readFile(manifestPath);
  const actualManifestSha256 = sha256(bytes);
  if (actualManifestSha256 !== config.expectedManifestSha256) {
    throw configurationError("Approved-corpus manifest hash does not match the pinned SHA-256.", "CORPUS_MANIFEST_HASH_MISMATCH");
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw configurationError("Approved-corpus manifest is not valid JSON.");
  }
  validateManifestShape(manifest, config);
  const documents = [];
  for (const document of manifest.documents) {
    const textPath = containedTextPath(manifestPath, String(document.text_path));
    if (!includeText) {
      documents.push({ ...document,textPath });
      continue;
    }
    const textBytes = normalisedTextBytes(await readFile(textPath),document.text_normalization || null);
    if (sha256(textBytes) !== String(document.text_sha256).toLowerCase()) throw configurationError(`Approved-corpus text hash mismatch for ${document.id}.`, "CORPUS_TEXT_HASH_MISMATCH");
    const text = textBytes.toString("utf8").trim();
    if (!text) throw configurationError(`Approved-corpus document ${document.id} has no readable text.`);
    documents.push({ ...document, textPath, text });
  }
  const structuredFactCollections = [];
  for (const record of manifest.structured_fact_collections || []) {
    const collectionPath = containedTextPath(manifestPath, String(record.path));
    const collectionBytes = await readFile(collectionPath);
    if (sha256(collectionBytes) !== String(record.sha256).toLowerCase()) {
      throw configurationError(`Approved-corpus structured fact hash mismatch for ${record.collection_id}.`, "CORPUS_STRUCTURED_FACT_HASH_MISMATCH");
    }
    let collection;
    try {
      collection = JSON.parse(collectionBytes.toString("utf8"));
    } catch {
      throw configurationError(`Approved-corpus structured fact collection ${record.collection_id} is not valid JSON.`);
    }
    if (collection.collection_id !== record.collection_id || !Array.isArray(collection.facts) || !collection.facts.length) {
      throw configurationError(`Approved-corpus structured fact collection ${record.collection_id} is invalid.`);
    }
    structuredFactCollections.push({ ...record,collectionPath,collection,facts:normalizedCollectionFacts(collection) });
  }
  return { manifestPath, manifestSha256: actualManifestSha256, manifest, documents,structuredFactCollections };
}

export async function approvedCorpusSourcePolicy({ environment = process.env } = {}) {
  const config = configuration(environment);
  const key = `${resolve(config.manifestPath || ".")}:${config.expectedManifestSha256}`;
  if (sourcePolicyCache?.key === key) return sourcePolicyCache.policy;
  const loaded = await loadApprovedCorpusManifest({ environment,includeText:false });
  const policy = Object.freeze({
    manifestSha256:loaded.manifestSha256,
    documentIds:new Set(loaded.documents.map((document) => document.id)),
    structuredFactIds:new Set(loaded.structuredFactCollections.flatMap((collection) => collection.facts.map((fact) => fact.id))),
  });
  sourcePolicyCache = { key,policy };
  return policy;
}

function matchingActiveDocument(existing, expected) {
  return existing?.status === "active"
    && existing.scope === "CURATED_PUBLIC"
    && Number(existing.version) === Number(expected.version)
    && String(existing.checksum || "").toLowerCase() === String(expected.text_sha256).toLowerCase()
    && existing.metadata?.approvalStatus === "approved"
    && String(existing.metadata?.reviewer || "").trim() === String(expected.reviewer).trim();
}

export async function bootstrapApprovedCorpus({
  environment = process.env,
  listDocumentsFn = listKnowledgeDocuments,
  listChunksFn = listKnowledgeChunksForIntegrity,
  indexDocumentFn = indexDocument,
  upsertPublicFactCollectionFn = upsertPublicFactCollection
} = {}) {
  const loaded = await loadApprovedCorpusManifest({ environment });
  const activeDocuments = await listDocumentsFn(PUBLIC_USER, { includeChunkCounts: false });
  const activeChunks = await listChunksFn(PUBLIC_USER);
  const byId = new Map(activeDocuments.map((document) => [document.id, document]));
  let indexed = 0;
  let skipped = 0;
  for (const document of loaded.documents) {
    const existing = byId.get(document.id);
    const expectedChunks = expectedDocumentChunks(document).sort((left, right) => `${left.documentId}:${left.id}`.localeCompare(`${right.documentId}:${right.id}`));
    const actualChunks = actualDocumentChunks(activeChunks, new Set([document.id]));
    if (matchingActiveDocument(existing, document) && chunksMatchExpected(actualChunks, expectedChunks)) {
      skipped += 1;
      continue;
    }
    if (existing && Number(existing.version) >= Number(document.version) && String(existing.checksum || "").toLowerCase() !== document.text_sha256.toLowerCase()) {
      throw configurationError(`Approved-corpus document ${document.id} conflicts with an existing immutable version.`, "CORPUS_IMMUTABILITY_CONFLICT");
    }
    const result = await indexDocumentFn(PUBLIC_USER, {
      id: document.id,
      title: document.title,
      authority: document.authority,
      jurisdiction: document.jurisdiction,
      canonicalLocation: document.canonical_location,
      version: Number(document.version),
      publishedAt: document.published_at || null,
      effectiveDate: document.effective_date,
      expiryDate: document.expiry_date || null,
      licence: document.licence,
      checksum: document.text_sha256.toLowerCase(),
      scope: "CURATED_PUBLIC",
      documentType: document.document_type || document.source_type,
      text: document.text,
      metadata: {
        reviewer: document.reviewer,
        approvalStatus: "approved",
        approvedAt: document.approved_at || loaded.manifest.approved_at,
        sourceType: document.source_type,
        sourceRole: document.source_role || null,
        retrievedAt:document.retrieved_at || null,
        dateBasis:document.date_basis || document.effective_date_basis || null,
        scopeNote:document.scope_note || null,
        snapshotValidFrom:document.snapshot_valid_from || null,
        sourceModifiedAt:document.source_modified_at || null,
        unappliedEffects:document.unapplied_effects ?? null,
        sourceReview:document.source_review || null,
        authorityRank: Number(document.authority_rank || 0.8),
        oscolaCitation: document.oscola_citation || document.title,
        bootstrapManifestSha256: loaded.manifestSha256
      }
    });
    byId.set(document.id, result.document || { ...document, checksum:document.text_sha256,status:"active",scope:"CURATED_PUBLIC",metadata:{ approvalStatus:"approved",reviewer:document.reviewer } });
    indexed += 1;
  }
  for (const collection of loaded.structuredFactCollections) {
    await upsertPublicFactCollectionFn(collection.collection);
  }
  return {
    ready: true,
    corpusId: loaded.manifest.corpus_id || null,
    manifestSha256: loaded.manifestSha256,
    expectedDocuments: loaded.documents.length,
    structuredFactCollections:loaded.structuredFactCollections.length,
    indexed,
    skipped
  };
}

export async function approvedCorpusReadiness({
  environment = process.env,
  listDocumentsFn = listKnowledgeDocuments,
  listChunksFn = listKnowledgeChunksForIntegrity,
  listPublicFactsFn = readPublicFacts
} = {}) {
  try {
    const loaded = await loadApprovedCorpusManifest({ environment,includeText:true });
    const activeDocuments = await listDocumentsFn(PUBLIC_USER, { includeChunkCounts: false });
    const byId = new Map(activeDocuments.map((document) => [document.id, document]));
    const missing = loaded.documents.filter((document) => !matchingActiveDocument(byId.get(document.id), document)).map((document) => document.id);
    const permittedDocumentIds = new Set(loaded.documents.map((document) => document.id));
    const expectedChunks = loaded.documents.flatMap(expectedDocumentChunks)
      .sort((left, right) => `${left.documentId}:${left.id}`.localeCompare(`${right.documentId}:${right.id}`));
    const activeChunks = actualDocumentChunks(await listChunksFn(PUBLIC_USER), permittedDocumentIds);
    const chunksMatch = chunksMatchExpected(activeChunks, expectedChunks);
    const expectedFacts = loaded.structuredFactCollections.flatMap((collection) => collection.facts);
    const permittedFactIds = new Set(expectedFacts.map((fact) => fact.id));
    const activeFacts = (await listPublicFactsFn()).filter((fact) => permittedFactIds.has(fact.id))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const factsMatch = stableJson(activeFacts) === stableJson(expectedFacts.sort((left, right) => String(left.id).localeCompare(String(right.id))));
    if (missing.length || !factsMatch || !chunksMatch) {
      return {
        ready:false,
        code:"CORPUS_INCOMPLETE",
        expected:loaded.documents.length,
        active:loaded.documents.length - missing.length,
        missingCount:missing.length,
        expectedStructuredFacts:expectedFacts.length,
        activeStructuredFacts:activeFacts.length,
        structuredFactsMatch:factsMatch,
        expectedChunks:expectedChunks.length,
        activeChunks:activeChunks.length,
        indexedChunksMatch:chunksMatch
      };
    }
    return {
      ready:true,code:"CORPUS_READY",expected:loaded.documents.length,active:loaded.documents.length,
      expectedStructuredFacts:expectedFacts.length,activeStructuredFacts:activeFacts.length,
      manifestSha256:loaded.manifestSha256,
      indexedChunks:activeChunks.length,
      indexedChunksMatch:true,
      corpusIntegritySha256:sha256(stableJson({
        manifestSha256:loaded.manifestSha256,
        documents:loaded.documents.map((document) => ({ id:document.id,version:Number(document.version),textSha256:document.text_sha256 })).sort((left,right)=>left.id.localeCompare(right.id)),
        chunks:activeChunks,
        structuredFacts:activeFacts,
      }))
    };
  } catch (error) {
    return { ready:false,code:error.code || "CORPUS_UNAVAILABLE" };
  }
}
