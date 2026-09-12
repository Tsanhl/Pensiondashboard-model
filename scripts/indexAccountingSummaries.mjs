import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const sources = JSON.parse(await readFile(resolve("approved-materials","accounting-summary-sources.json"),"utf8"));
await initialiseDataStore(); await initialiseCache();
for (const source of sources) {
  const text = await readFile(resolve(source.sourceFile),"utf8");
  const checksum = createHash("sha256").update(text).digest("hex");
  const result = await indexDocument("__public__",{
    id:`derived-${source.id}`,title:source.title,authority:source.authority,jurisdiction:source.jurisdiction,
    canonicalLocation:source.canonicalLocation,version:20260826,publishedAt:source.publishedAt,effectiveDate:source.publishedAt,
    expiryDate:null,licence:"Original summary; no licensed standard text stored",checksum,scope:"CURATED_PUBLIC",
    documentType:"derived_summary",text,
    metadata:{ reviewer:"source-grounded-summary",approvalStatus:"approved",sourceType:"derived_accounting_summary",
      authorityRank:0.45,oscolaCitation:source.oscolaCitation,retrievedAt:new Date().toISOString(),updateCycleDays:90,
      legalReliance:false,accountingReliance:false,fineTuningEligible:false,
      statusNote:"Secondary summary only. Refer to the licensed current standard and a qualified accountant or actuary for reporting decisions." }
  });
  console.log(`${source.title}: ${result.chunkCount} chunks`);
}
