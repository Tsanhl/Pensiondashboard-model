import "../server/loadEnv.js";
import { readdir,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const directory = resolve("approved-materials","index","regulatory-guidance");
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((id)=>id.trim()).filter(Boolean));
const metadataFiles = (await readdir(directory)).filter((name)=>name.endsWith("-metadata.json"))
  .filter((name)=>!requestedIds.size || requestedIds.has(name.slice(0,-"-metadata.json".length))).sort();
if (requestedIds.size && metadataFiles.length !== requestedIds.size) throw new Error("One or more MATERIAL_IDS did not match downloaded regulatory guidance metadata");
await initialiseDataStore();
await initialiseCache();
for (const filename of metadataFiles) {
  const metadata = JSON.parse(await readFile(resolve(directory,filename),"utf8"));
  const text = await readFile(metadata.files.text.path,"utf8");
  const result = await indexDocument("__public__",{
    id:metadata.id,title:metadata.title,authority:metadata.authority,jurisdiction:metadata.jurisdiction,
    canonicalLocation:metadata.canonical_location,version:metadata.version,publishedAt:metadata.publication_date,
    effectiveDate:metadata.effective_date,expiryDate:null,licence:metadata.licence,checksum:metadata.files.text.sha256,
    scope:"CURATED_PUBLIC",documentType:"law",text,
    metadata:{ reviewer:metadata.reviewer,approvalStatus:metadata.approval_status,sourceType:metadata.source_type,
      authorityRank:metadata.authority_rank,oscolaCitation:metadata.oscola_citation,retrievedAt:metadata.retrieved_at,
      seminars:metadata.seminars,topics:metadata.topics,licenceUrl:metadata.licence_url,statusNote:metadata.status_note,
      northernIrelandEffectiveDate:metadata.northern_ireland_effective_date,appliesToValuationsFrom:metadata.applies_to_valuations_from,
      originalPdf:metadata.files.pdf.path,updateCycleDays:30 }
  });
  console.log(`${metadata.title}: ${result.chunkCount} chunks (${result.embeddingModel})`);
}
