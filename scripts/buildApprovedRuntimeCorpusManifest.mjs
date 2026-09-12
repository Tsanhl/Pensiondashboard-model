import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { readdirSync,readFileSync,statSync,writeFileSync } from "node:fs";
import { dirname,relative,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listKnowledgeDocuments } from "../server/repositories/knowledgeRepository.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATERIALS_ROOT = resolve(WORKSPACE, "approved-materials");
const OUTPUT_PATH = resolve(process.env.APPROVED_CORPUS_BUILD_OUT || resolve(MATERIALS_ROOT, "approved-corpus-manifest.json"));
const APPROVED_AT = String(process.env.APPROVED_CORPUS_APPROVED_AT || "2026-09-01T00:00:00.000Z");
const APPROVED_BY = String(process.env.APPROVED_CORPUS_APPROVED_BY || "Tsanhl (project owner) — local runtime snapshot approval");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function filesBelow(directory) {
  const records = [];
  for (const name of readdirSync(directory)) {
    const path = resolve(directory,name);
    const stat = statSync(path);
    if (stat.isDirectory()) records.push(...filesBelow(path));
    else records.push(path);
  }
  return records;
}

function sourceCandidates() {
  return [
    ...filesBelow(resolve(MATERIALS_ROOT,"index")),
    ...filesBelow(resolve(MATERIALS_ROOT,"structured-facts")),
  ].filter((path) => !path.endsWith("-metadata.json") && !path.endsWith("source-inventory.jsonl") && !path.endsWith(".DS_Store"));
}

function exclusionReason(document,matchedPath) {
  if (document.status !== "active" || document.scope !== "CURATED_PUBLIC") return "not_active_curated_public";
  if (document.metadata?.approvalStatus !== "approved") return "document_metadata_not_approved";
  if (!String(document.metadata?.reviewer || "").trim()) return "document_reviewer_missing";
  if (!/^[a-f0-9]{64}$/.test(String(document.checksum || ""))) return "document_checksum_invalid";
  if (!matchedPath) return "indexed_source_bytes_not_exactly_reproducible";
  return null;
}

await initialiseDataStore();
const documents = await listKnowledgeDocuments("__public__",{ includeChunkCounts:false });
const hashPaths = new Map();
const stripLfHashPaths = new Map();
for (const path of sourceCandidates()) {
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  if (hashPaths.has(digest)) throw new Error(`Duplicate approved source bytes are ambiguous: ${path}`);
  hashPaths.set(digest,path);
  if (bytes.length && bytes[bytes.length - 1] === 0x0a) {
    const strippedDigest = sha256(bytes.subarray(0,bytes.length - 1));
    if (stripLfHashPaths.has(strippedDigest)) throw new Error(`Duplicate normalized source bytes are ambiguous: ${path}`);
    stripLfHashPaths.set(strippedDigest,path);
  }
}

const included = [];
const excluded = [];
for (const document of documents.sort((left,right) => String(left.id).localeCompare(String(right.id)))) {
  const checksum = String(document.checksum || "").toLowerCase();
  const exactPath = hashPaths.get(checksum);
  const strippedPath = exactPath ? null : stripLfHashPaths.get(checksum);
  const matchedPath = exactPath || strippedPath;
  const reason = exclusionReason(document,matchedPath);
  if (reason) {
    excluded.push({ id:document.id,title:document.title,reason });
    continue;
  }
  included.push({
    id:document.id,
    title:document.title,
    authority:document.authority,
    jurisdiction:document.jurisdiction,
    canonical_location:document.canonicalLocation,
    version:Number(document.version),
    published_at:document.publishedAt || undefined,
    effective_date:document.effectiveDate,
    expiry_date:document.expiryDate || undefined,
    licence:document.licence,
    reviewer:document.metadata.reviewer,
    approval_status:"approved",
    source_type:document.metadata.sourceType,
    source_role:document.metadata.sourceRole || undefined,
    authority_rank:Number(document.metadata.authorityRank || 0.8),
    oscola_citation:document.metadata.oscolaCitation || document.title,
    text_path:relative(dirname(OUTPUT_PATH),matchedPath),
    text_sha256:document.checksum.toLowerCase(),
    text_normalization:strippedPath ? "strip_one_trailing_lf" : undefined,
  });
}

if (included.length < 150) throw new Error(`Only ${included.length} byte-reproducible approved documents were found.`);

const structuredFactCollections = filesBelow(resolve(MATERIALS_ROOT,"structured-facts"))
  .filter((path) => path.endsWith(".json"))
  .sort()
  .map((path) => {
    const collection = JSON.parse(readFileSync(path,"utf8"));
    if (!collection.collection_id || !Array.isArray(collection.facts) || !collection.facts.length) {
      throw new Error(`Invalid structured fact collection: ${path}`);
    }
    return {
      collection_id:collection.collection_id,
      path:relative(dirname(OUTPUT_PATH),path),
      sha256:sha256(readFileSync(path)),
      reviewer:APPROVED_BY,
      approval_status:"approved",
    };
  });

const manifest = {
  schema_version:1,
  corpus_id:"pensions-dashboard-runtime-corpus-2026-09-01",
  approval_status:"approved",
  approved_by:APPROVED_BY,
  approved_at:APPROVED_AT,
  approval_scope:"Owner-authorised, byte-pinned local runtime corpus assembled from records already marked approved by their named source reviewer. This is operational approval, not legal advice or a claim of independent legal certification.",
  selection_policy:"Only active CURATED_PUBLIC documents with approved metadata, a named reviewer, a complete checksum, and an exact matching local source-text byte stream are admitted.",
  documents:included,
  structured_fact_collections:structuredFactCollections,
  exclusions:excluded,
};

writeFileSync(OUTPUT_PATH,`${JSON.stringify(manifest,null,2)}\n`);
const bytes = readFileSync(OUTPUT_PATH);
console.log(JSON.stringify({
  path:OUTPUT_PATH,
  sha256:sha256(bytes),
  bytes:bytes.length,
  documents:included.length,
  structuredFactCollections:structuredFactCollections.length,
  excluded:excluded.length,
},null,2));
