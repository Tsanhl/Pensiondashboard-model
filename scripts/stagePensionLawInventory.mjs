import "../server/loadEnv.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseDataStore } from "../server/store/userDataStore.js";
import { stageMaterialReviewItem } from "../server/repositories/materialReviewRepository.js";

const inventoryPath = resolve("approved-materials","index","source-inventory.jsonl");
const rows = (await readFile(inventoryPath,"utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const excluded = new Set(["excluded","excluded_from_answer_corpus","excluded_pending_rights_review"]);
await initialiseDataStore();
let staged = 0;
for (const row of rows) {
  if (excluded.has(row.status)) continue;
  await stageMaterialReviewItem({
    id:`inventory-${row.id}`,sourceDocumentId:`inventory-${row.id}`,sourceChecksum:row.sha256,sourceType:row.sourceType,title:row.relativePath,
    content:"Inventory record only. Original content has not been added to the active answer corpus pending source, rights and legal review.",citations:[],
    metadata:{ absolutePath:row.absolutePath,bytes:row.bytes,extension:row.extension,inventoryStatus:row.status,activeEvidence:false,reviewKind:row.status }
  });
  staged += 1;
}
console.log(JSON.stringify({ total:rows.length,staged,excluded:rows.length-staged },null,2));
