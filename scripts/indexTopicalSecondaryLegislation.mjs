import "../server/loadEnv.js";
import { readdir,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const directory = resolve("approved-materials","index","topical-secondary-legislation");
await initialiseDataStore(); await initialiseCache();
for (const filename of (await readdir(directory)).filter((name)=>name.endsWith("-metadata.json")).sort()) {
  const metadata = JSON.parse(await readFile(resolve(directory,filename),"utf8"));
  const text = await readFile(metadata.files.text.path,"utf8");
  const result = await indexDocument("__public__",{
    id:metadata.id,title:metadata.title,authority:metadata.authority,jurisdiction:metadata.jurisdiction,
    canonicalLocation:metadata.canonical_location,version:metadata.version,publishedAt:metadata.publication_date,
    effectiveDate:metadata.effective_date,expiryDate:metadata.expiry_date,licence:metadata.licence,checksum:metadata.files.text.sha256,
    scope:"CURATED_PUBLIC",documentType:"law",text,
    metadata:{ reviewer:metadata.reviewer,approvalStatus:metadata.approval_status,sourceType:metadata.source_type,
      authorityRank:metadata.authority_rank,oscolaCitation:metadata.oscola_citation,retrievedAt:metadata.retrieved_at,
      snapshotValidFrom:metadata.snapshot_valid_from,documentStatus:metadata.document_status,unappliedEffects:metadata.unapplied_effects,
      jurisdictionPair:metadata.jurisdiction_pair,textExtraction:metadata.text_extraction,topics:metadata.topics,
      statusNote:metadata.status_note,originalSource:metadata.files.original.path,originalFormat:metadata.files.original.format,
      currentXml:metadata.files.xml.path,updateCycleDays:30 }
  });
  console.log(`${metadata.title}: ${result.chunkCount} chunks`);
}
