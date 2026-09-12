import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentHash } from "./lib/trainingEvidenceIntegrity.mjs";
await import("../server/loadEnv.js");
const { initialiseDataStore } = await import("../server/store/userDataStore.js");
const { processQuery } = await import("../server/services/queryProcessorService.js");
const { retrieveForQuery } = await import("../server/services/retrievalService.js");

const ROOT = resolve(process.env.TRAINING_REPAIR_REVIEW_ROOT || "training/evaluation-cycle-v2/04-training-data-repair-20260901");
if (existsSync(resolve(ROOT, "source-review-candidates.json"))) throw new Error("Preserve the existing review pack; choose a new versioned output directory");
await initialiseDataStore();
mkdirSync(ROOT, { recursive:true });
const output = { version:"training-source-repair-candidates-v1", generated_at:new Date().toISOString(), status:"pending_independent_source_and_answer_review", training_authorised:false, unseen_accessed:false, contains_diagnostic_questions:false, items:[] };
for (const wave of [2, 3]) {
  const original = JSON.parse(readFileSync(`training/evaluation-cycle-v2/02-wave-${wave}-execution/training/training-review-pack.json`));
  const manifest = JSON.parse(readFileSync(`training-data/private/evaluation-cycle-v2-wave-${wave}-lora/dataset-manifest.json`));
  for (const item of original.items) {
    const query = processQuery(item.user_question, { resolvedEntities:{ jurisdiction:item.jurisdiction } });
    const plan = { ...query, source_scopes:["CURATED_PUBLIC"], structured_lookups:[] };
    const found = await retrieveForQuery({ userId:"training-source-repair-review", sessionId:`w${wave}-${item.training_id}`, requestId:`repair-${item.training_id}`, queryPlan:plan, limit:5 });
    const sources = found.sources.slice(0, 3).map((source) => ({ source_id:source.sourceId, source_role:source.sourceRole || source.sourceType,
      title:source.title, section:source.section, jurisdiction:source.jurisdiction, source_url:source.canonicalLocation,
      authority_family:source.documentId, effective_date:source.effectiveDate, text:source.snippet,
      content_sha256:contentHash(source.snippet), citation_metadata:{ user_visible:true } }));
    output.items.push({ training_id:item.training_id, wave, partition:manifest.validation.ids.includes(item.training_id) ? "validation" : "train",
      construct_id:item.construct_id, user_question:item.user_question, question_sha256:contentHash(item.user_question),
      legacy_ideal_answer_for_review_only:item.ideal_answer, ideal_answer:null, review_status:"pending",
      retrieved_evidence:sources, retrieval_trace:found.trace,
      required_review:["Confirm jurisdiction, event date and operative status", "Check each answer proposition against exact source passages and surrounding conditions", "Replace synthetic citation tokens with supporting real source IDs", "Check source-family/construct partition isolation", "Approve the revised answer and evidence separately; do not copy the answer into evidence"] });
    writeFileSync(resolve(ROOT, "source-review-candidates.json"), JSON.stringify(output, null, 2) + "\n");
    console.log(`${output.items.length}/52 ${item.training_id}: ${sources.length} candidate sources; NOT approved`);
  }
}
output.status = "retrieval_complete_pending_independent_source_and_answer_review";
output.completed_at = new Date().toISOString();
writeFileSync(resolve(ROOT, "source-review-candidates.json"), JSON.stringify(output, null, 2) + "\n");
const sections = output.items.map((item) => `## ${item.training_id} — Wave ${item.wave}, ${item.partition}\n\n${item.user_question}\n\nLegacy answer (draft only; old synthetic citations must be replaced):\n\n${item.legacy_ideal_answer_for_review_only}\n\nCandidate sources — relevance and entailment NOT approved:\n\n${item.retrieved_evidence.map((s) => `- [${s.title}](${s.source_url}) — ${s.section}\n\n  ${s.text.slice(0, 400).replace(/\n/g, " ")}…`).join("\n\n")}\n\nReview status: pending. Approved answer: not yet supplied.\n`).join("\n");
writeFileSync(resolve(ROOT, "SOURCE-REVIEW.md"), `# Wave 2–3 replacement training-source review\n\n52 training candidates only. No diagnostic or unseen questions included. This pack is NOT training data and grants no training approval. Full passages and content hashes are in source-review-candidates.json. Retrieval does not establish legal support.\n\n${sections}`);
console.log(JSON.stringify({ root:ROOT, items:output.items.length, training_authorised:false }));
