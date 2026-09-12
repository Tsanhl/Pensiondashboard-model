import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

await import("../server/loadEnv.js");
const [{ initialiseDataStore }, { processQuery }, { retrieveForQuery }] = await Promise.all([
  import("../server/store/userDataStore.js"),
  import("../server/services/queryProcessorService.js"),
  import("../server/services/retrievalService.js"),
]);

const QUESTION_PATH = resolve("training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-2/development-question-set.json");
const GOLD_PATH = resolve("training/evaluation-cycle-v2/02-wave-2-execution/gold/evaluation-gold.json");
const OUTPUT_PATH = resolve("training/evaluation-cycle-v2/02-wave-2-execution/retrieval/repaired-routing-audit.json");
const questionsPayload = JSON.parse(readFileSync(QUESTION_PATH, "utf8"));
const allQuestions = questionsPayload.topics.flatMap((topic) => topic.diagnostic_evaluation.map((item) => ({ ...item, topic_id: topic.topic_id })));
const requestedIds = new Set(String(process.env.CYCLE_V2_QUESTION_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
const questions = requestedIds.size ? allQuestions.filter((item) => requestedIds.has(item.id)) : allQuestions;
if (requestedIds.size && questions.length !== requestedIds.size) throw new Error("One or more CYCLE_V2_QUESTION_IDS do not exist in the Wave 2 diagnostic set.");
const topK = Math.max(1, Number(process.env.CYCLE_V2_RETRIEVAL_TOP_K || 5));
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8"));
const goldById = new Map(gold.items.map((item) => [item.id, item]));
const personalScopes = new Set(["USER_PORTFOLIO", "USER_DOCUMENTS"]);
const personalLookups = new Set(["account", "charges", "document_status", "projection", "investment_profile"]);

function publicOnlyPlan(query) {
  return {
    ...query,
    source_scopes: query.source_scopes.filter((scope) => !personalScopes.has(scope)),
    structured_lookups: query.structured_lookups.filter((lookup) => !personalLookups.has(lookup)),
  };
}

function targetDocuments(item) {
  return [...new Set(item.proposition_citation_targets.flatMap((target) => target.source_targets || []))];
}

function documentForSource(sourceId, targets) {
  return targets.find((target) => sourceId === target || sourceId.startsWith(`${target}_chunk_`)) || null;
}

await initialiseDataStore();
const rows = new Array(questions.length);
let nextIndex = 0;
async function worker() {
  while (nextIndex < questions.length) {
    const index = nextIndex;
    nextIndex += 1;
    const question = questions[index];
    const item = goldById.get(question.id);
    if (!item) throw new Error(`Missing Wave 2 gold item for ${question.id}`);
    const query = processQuery(question.question, { summary: "", resolvedEntities: {}, providers: [], latestMessages: [], lastUserMessage: question.question });
    const plan = publicOnlyPlan(query);
    let retrieval;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        retrieval = await retrieveForQuery({
          userId: "evaluation-cycle-v2-wave-2-retrieval-audit",
          sessionId: `retrieval-audit-${question.id}`,
          requestId: `retrieval-audit-${question.id}`,
          queryPlan: plan,
          limit: 8,
        });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        console.log(`[${index + 1}/${questions.length}] ${question.id} RETRY ${attempt}`);
      }
    }
    const targets = targetDocuments(item);
    const topFive = retrieval.sources.slice(0, topK).map((source) => ({
      source_id: source.sourceId,
      title: source.title,
      matched_target_document: documentForSource(source.sourceId, targets),
      rerank_score: Number(source.rerankScore || 0),
    }));
    const matched = topFive.map((source) => source.matched_target_document).filter(Boolean);
    rows[index] = {
      question_id: question.id,
      topic_id: question.topic_id,
      review_focus: question.review_focus,
      retrieval_query: query.retrieval_query || query.self_contained_query,
      target_documents: targets,
      top_five: topFive,
      target_document_hit: matched.length > 0,
      matched_target_documents: [...new Set(matched)],
    };
    console.log(`[${index + 1}/${questions.length}] ${question.id} ${matched.length ? "HIT" : "MISS"}`);
  }
}
await worker();

const topics = [...new Set(rows.map((row) => row.topic_id))].map((topicId) => {
  const topicRows = rows.filter((row) => row.topic_id === topicId);
  const hits = topicRows.filter((row) => row.target_document_hit).length;
  return { topic_id: topicId, total: topicRows.length, hits, hit_rate: Number((100 * hits / topicRows.length).toFixed(1)) };
});
const hits = rows.filter((row) => row.target_document_hit).length;
const output = {
  version: "evaluation-cycle-v2-wave-2-repaired-retrieval-audit-v1",
  generated_at: new Date().toISOString(),
  status: "development_retrieval_audit_not_model_scoring",
  top_k: topK,
  summary: { total: rows.length, hits, misses: rows.length - hits, hit_rate: Number((100 * hits / rows.length).toFixed(1)), topics },
  rows,
};
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.summary, null, 2));
