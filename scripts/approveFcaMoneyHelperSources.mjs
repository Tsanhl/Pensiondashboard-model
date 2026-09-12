import "../server/loadEnv.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stageMaterialReviewItem } from "../server/repositories/materialReviewRepository.js";
import { flushDataStore,initialiseDataStore } from "../server/store/userDataStore.js";

const proposal = JSON.parse(await readFile(resolve("approved-materials","review","fca-moneyhelper-proposed-sources.json"),"utf8"));
const licenceGate = JSON.parse(await readFile(resolve("approved-materials","review","fca-moneyhelper-licence-gate.json"),"utf8"));
if (proposal.status !== "approved_by_user_pending_external_licence") throw new Error("The static approval record is not marked approved.");
const gates = new Map(licenceGate.sources.flatMap((group) => group.ids.map((id) => [id,group])));
await initialiseDataStore();
for (const source of proposal.sources) {
  const gate = gates.get(source.id);
  if (!gate) throw new Error(`Missing licence gate for ${source.id}`);
  const checksum = createHash("sha256").update(`${source.url}|${proposal.created_at}`).digest("hex");
  await stageMaterialReviewItem({
    id:`review-${source.id}`,sourceDocumentId:source.id,sourceChecksum:checksum,sourceType:"proposed_official_guidance",
    title:source.title,content:source.proposed_use,citations:[source.url],status:"approved",
    metadata:{ userApprovalStatus:"approved",userApprovedAt:proposal.user_approved_at,authority:source.authority,
      proposedAuthorityRank:source.proposed_authority_rank,freshnessDays:source.freshness_days,recommendation:source.recommendation,
      activationAllowed:false,activationStatus:gate.activation_status,termsUrl:gate.terms_url,
      licenceRequestUrl:gate.licence_request_url || gate.syndication_url }
  });
}
await flushDataStore();
console.log(`Approved ${proposal.sources.length} sources for content selection; active full text remains blocked by external licence gates.`);
