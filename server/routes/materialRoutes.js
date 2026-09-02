import { enqueueMaterialChange, knowledgeFreshnessReport, materialWebhookAuthorised, processMaterialQueueOnce } from "../services/materialFreshnessService.js";
import { listMaterialReviewItems } from "../repositories/materialReviewRepository.js";

export async function handleMaterialRoute({ req,res,url,json,readBody }) {
  if (!url.pathname.startsWith("/api/materials/")) return false;
  if (!materialWebhookAuthorised(req)) return json(res, 401, { error:"Material webhook authentication failed." });
  if (url.pathname === "/api/materials/change-events") {
    if (req.method !== "POST") return json(res, 405, { error:"Method not allowed" });
    const raw = await readBody(req);
    const job = await enqueueMaterialChange(raw ? JSON.parse(raw) : {});
    processMaterialQueueOnce().catch(() => {});
    return json(res, 202, { job_id:job.id,status:job.status });
  }
  if (url.pathname === "/api/materials/freshness") {
    if (req.method !== "GET") return json(res, 405, { error:"Method not allowed" });
    return json(res, 200, await knowledgeFreshnessReport());
  }
  if (url.pathname === "/api/materials/review-items") {
    if (req.method !== "GET") return json(res, 405, { error:"Method not allowed" });
    return json(res, 200, { items:await listMaterialReviewItems(url.searchParams.get("status") || "pending_legal_review") });
  }
  return false;
}
