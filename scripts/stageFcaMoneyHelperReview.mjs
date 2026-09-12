import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stageMaterialReviewItem } from "../server/repositories/materialReviewRepository.js";
import { flushDataStore,initialiseDataStore } from "../server/store/userDataStore.js";

const proposal = JSON.parse(await readFile(resolve("approved-materials","review","fca-moneyhelper-proposed-sources.json"),"utf8"));
await initialiseDataStore();
for (const source of proposal.sources) {
  const checksum = createHash("sha256").update(`${source.url}|${proposal.created_at}`).digest("hex");
  await stageMaterialReviewItem({
    id:`review-${source.id}`,sourceDocumentId:source.id,sourceChecksum:checksum,sourceType:"proposed_official_guidance",
    title:source.title,content:source.proposed_use,citations:[source.url],status:"pending_legal_review",
    metadata:{ userApprovalStatus:"pending_user_review",authority:source.authority,proposedAuthorityRank:source.proposed_authority_rank,
      freshnessDays:source.freshness_days,recommendation:source.recommendation,activationAllowed:false }
  });
}
await flushDataStore();
console.log(`Staged ${proposal.sources.length} FCA/MoneyHelper sources for user review; none activated.`);
