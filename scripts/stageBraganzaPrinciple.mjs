import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseDataStore } from "../server/store/userDataStore.js";
import { initialiseCache } from "../server/services/cacheService.js";
import { indexDocument } from "../server/services/knowledgeService.js";
import { stageMaterialReviewItem } from "../server/repositories/materialReviewRepository.js";

const judgmentPath = resolve("approved-materials","index","case-law","braganza-v-bp-shipping-2015-uksc-17-judgment.txt");
const draftPath = resolve("approved-materials","index","case-law","braganza-v-bp-shipping-2015-uksc-17-principle-draft.md");
const [judgment,draft] = await Promise.all([readFile(judgmentPath,"utf8"),readFile(draftPath,"utf8")]);
const checksum = createHash("sha256").update(judgment).digest("hex");
await initialiseDataStore();
await initialiseCache();
const indexed = await indexDocument("__public__", {
  id:"official-braganza-v-bp-shipping-2015-uksc-17",title:"Braganza v BP Shipping Ltd [2015] UKSC 17",authority:"UK Supreme Court",jurisdiction:"England and Wales",
  canonicalLocation:"https://www.supremecourt.uk/cases/uksc-2013-0099",version:20150318,publishedAt:"2015-03-18",effectiveDate:"2015-03-18",licence:"Official public judgment",checksum,
  scope:"CURATED_PUBLIC",documentType:"case",text:judgment,
  metadata:{ sourceType:"case_law",authorityRank:0.85,oscolaCitation:"Braganza v BP Shipping Ltd [2015] UKSC 17",reviewer:"official-source-import",approvalStatus:"approved_original_judgment",updateCycleDays:180,statusNote:"Check subsequent judicial treatment before relying on the proposition." }
});
const review = await stageMaterialReviewItem({
  id:"review-braganza-v-bp-shipping-2015-uksc-17",sourceDocumentId:indexed.document.id,sourceChecksum:checksum,sourceType:"derived_case_principle",title:"Braganza v BP Shipping Ltd - principle draft",content:draft,
  citations:["Braganza v BP Shipping Ltd [2015] UKSC 17, [18], [24], [29]-[32]","Braganza v BP Shipping Ltd [2015] UKSC 17, [36], [39]-[42], [64]"],
  metadata:{ derivedFrom:"official UK Supreme Court judgment",activeEvidence:false,requiresReviewerRole:"pensions_law_reviewer" }
});
console.log(JSON.stringify({ judgmentChunks:indexed.chunkCount,reviewItem:{ id:review.id,status:review.status,title:review.title } },null,2));
