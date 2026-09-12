import "../server/loadEnv.js";
import { readdir,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const directory = resolve("approved-materials","index","ppf-guidance");
await initialiseDataStore();
await initialiseCache();
for (const filename of (await readdir(directory)).filter((name)=>name.endsWith("-metadata.json")).sort()) {
  const metadata = JSON.parse(await readFile(resolve(directory,filename),"utf8"));
  const text = await readFile(metadata.files.text.path,"utf8");
  const result = await indexDocument("__public__",{
    id:metadata.id,title:metadata.title,authority:metadata.authority,jurisdiction:metadata.jurisdiction,
    canonicalLocation:metadata.canonical_location,version:metadata.version,publishedAt:metadata.publication_date,
    effectiveDate:metadata.effective_date,expiryDate:null,licence:metadata.licence,checksum:metadata.files.text.sha256,
    scope:"CURATED_PUBLIC",documentType:metadata.document_type,text,
    metadata:{ reviewer:metadata.reviewer,approvalStatus:metadata.approval_status,sourceType:metadata.source_type,
      authorityRank:metadata.authority_rank,oscolaCitation:metadata.oscola_citation,retrievedAt:metadata.retrieved_at,
      updateCycleDays:metadata.update_cycle_days,topics:metadata.topics,statusNote:metadata.status_note,
      originalSource:metadata.files.original.path,originalFormat:metadata.files.original.format }
  });
  console.log(`${metadata.title}: ${result.chunkCount} chunks`);
}
