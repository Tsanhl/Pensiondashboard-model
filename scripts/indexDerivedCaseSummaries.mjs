import "../server/loadEnv.js";
import { readdir,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const directory = resolve("approved-materials","index","derived-case-summaries");
const metadataFiles = (await readdir(directory)).filter((name)=>name.endsWith("-metadata.json")).sort();
await initialiseDataStore();
await initialiseCache();
for (const filename of metadataFiles) {
  const metadata = JSON.parse(await readFile(resolve(directory,filename),"utf8"));
  const text = await readFile(metadata.files.text.path,"utf8");
  const result = await indexDocument("__public__",{
    id:metadata.id,title:metadata.title,authority:metadata.authority,jurisdiction:metadata.jurisdiction,
    canonicalLocation:null,version:metadata.version,publishedAt:metadata.publication_date,
    effectiveDate:metadata.effective_date,expiryDate:null,licence:metadata.licence,checksum:metadata.files.text.sha256,
    scope:"CURATED_PUBLIC",documentType:"case_law_summary",text,
    metadata:{ reviewer:metadata.reviewer,approvalStatus:metadata.approval_status,sourceType:metadata.source_type,
      authorityRank:metadata.authority_rank,oscolaCitation:metadata.oscola_citation,generatedAt:metadata.generated_at,
      court:metadata.court,seminars:metadata.seminars,topics:metadata.topics,inventoryIds:metadata.inventory_ids,
      sourceChecksums:metadata.source_checksums,relatedActiveAuthorities:metadata.related_active_authorities,
      statusNote:metadata.status_note,updateCycleDays:180 }
  });
  console.log(`${metadata.title}: ${result.chunkCount} chunks (${result.embeddingModel})`);
}
