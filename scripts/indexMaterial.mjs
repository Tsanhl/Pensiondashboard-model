import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const [textPath,metadataPath] = process.argv.slice(2);
if (!textPath || !metadataPath) throw new Error("Usage: npm run materials:index -- source.txt metadata.json");
const text = readFileSync(resolve(textPath), "utf8");
const metadata = JSON.parse(readFileSync(resolve(metadataPath), "utf8"));
for (const field of ["id","title","authority","jurisdiction","canonical_location","version","publication_date","effective_date","expiry_date","licence","reviewer","approval_status"]) {
  if (!metadata[field]) throw new Error(`Approved material metadata is missing ${field}.`);
}
if (metadata.approval_status !== "approved") throw new Error("Material must be administrator approved before indexing.");
if (Date.parse(metadata.expiry_date) <= Date.now()) throw new Error("Expired material cannot be activated.");
await initialiseDataStore();
await initialiseCache();
const checksum = createHash("sha256").update(text).digest("hex");
const result = await indexDocument("__public__", {
  id:metadata.id,title:metadata.title,authority:metadata.authority,jurisdiction:metadata.jurisdiction,
  canonicalLocation:metadata.canonical_location,version:metadata.version,publishedAt:metadata.publication_date,
  effectiveDate:metadata.effective_date,expiryDate:metadata.expiry_date,licence:metadata.licence,checksum,
  scope:"CURATED_PUBLIC",documentType:metadata.document_type || "law",text,
  metadata:{ reviewer:metadata.reviewer,approvalStatus:metadata.approval_status,sourceVersion:metadata.version }
});
console.log(JSON.stringify({ id:result.document.id,status:result.document.status,chunks:result.chunkCount,checksum }, null, 2));
