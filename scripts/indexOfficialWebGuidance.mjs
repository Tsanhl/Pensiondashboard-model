import "../server/loadEnv.js";
import { readdir,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const directory = resolve("approved-materials","index","official-web-guidance");
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
const metadataFiles = (await readdir(directory)).filter((name) => name.endsWith("-metadata.json"))
  .filter((name) => !requestedIds.size || requestedIds.has(name.slice(0,-"-metadata.json".length))).sort();
if (requestedIds.size && metadataFiles.length !== requestedIds.size) throw new Error("One or more MATERIAL_IDS did not match downloaded web-guidance metadata");
await initialiseDataStore();
await initialiseCache();
for (const filename of metadataFiles) {
  const metadata = JSON.parse(await readFile(resolve(directory,filename),"utf8"));
  const text = await readFile(metadata.files.text.path,"utf8");
  const result = await indexDocument("__public__",{
    id:metadata.id,title:metadata.title,authority:metadata.authority,jurisdiction:metadata.jurisdiction,
    canonicalLocation:metadata.canonical_location,version:metadata.version,publishedAt:metadata.published_at,
    effectiveDate:metadata.source_updated_at || metadata.current_checked_at,expiryDate:null,licence:metadata.licence,checksum:metadata.files.text.sha256,
    scope:"CURATED_PUBLIC",documentType:"official_guidance",text,
    metadata:{reviewer:metadata.reviewer,approvalStatus:metadata.approval_status,sourceType:metadata.source_type,
      authorityRank:metadata.authority_rank,oscolaCitation:metadata.oscola_citation,retrievedAt:metadata.retrieved_at,
      sourceUpdatedAt:metadata.source_updated_at,currentCheckedAt:metadata.current_checked_at,licenceUrl:metadata.licence_url,topics:metadata.topics,
      originalSource:metadata.files.original.path,updateCycleDays:30}
  });
  console.log(`${metadata.title}: ${result.chunkCount} chunks`);
}
