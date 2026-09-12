import { existsSync,readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cosineSimilarity,embedTexts } from "../server/services/embeddingService.js";
import { CYCLE_ROOT,INPUTS,hashFile,isoNow,readJson,writeJsonAtomic } from "./evaluationCycleV1Common.mjs";

await import("../server/loadEnv.js");

const ROOT = resolve(CYCLE_ROOT,"03-training-drafts");
const PACK_PATH = resolve(ROOT,"training-review-pack.json");
const REPORT_PATH = resolve(ROOT,"phase-5-contamination-report.json");
const pack = readJson(PACK_PATH);
const development = readJson(INPUTS.evaluationDraft);
const answerReview = readJson(INPUTS.answerReview);

function normalise(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9£%]+/g," ").trim().replace(/\s+/g," ");
}
const stopWords = new Set("a an and are as at be but by can could do does for from has have how i if in is it may my of on or should that the this to was what when which why will with".split(" "));
function tokens(value) { return new Set(normalise(value).split(" ").filter((token) => token && !stopWords.has(token))); }
function dice(a,b) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return 2 * overlap / (a.size + b.size);
}

function loadQuestionPack(path,set) {
  if (!existsSync(path)) return [];
  const payload = readJson(path);
  if (payload.training_eligibility !== "prohibited") throw new Error(`${set} is not marked training-prohibited.`);
  return (payload.questions || []).map((item) => ({ id:item.id,set,question:item.question }));
}

const protectedQuestions = development.questions.map((item) => ({ id:item.id,set:"development_regression",question:item.question }));
const unseenRoot = resolve(CYCLE_ROOT,"04-unseen");
if (existsSync(unseenRoot)) {
  for (const entry of readdirSync(unseenRoot,{ withFileTypes:true })) {
    if (entry.isDirectory() && entry.name.startsWith("wave-")) protectedQuestions.push(...loadQuestionPack(resolve(unseenRoot,entry.name,"questions.json"),`sealed_unseen_${entry.name}`));
  }
}
protectedQuestions.push(...loadQuestionPack(resolve(CYCLE_ROOT,"07-final-gold/questions.json"),"final_gold"));

const exactQuestions = new Map(protectedQuestions.map((item) => [normalise(item.question),item]));
const exactAnswers = new Map(answerReview.items.map((item) => [normalise(item.draft_answer),item.id]).filter(([value]) => value));
const exactChunks = new Map(answerReview.items.flatMap((item) => (item.retrieved_chunks || []).map((chunk) => [normalise(chunk.content),`${item.id}:${chunk.source_id}`])).filter(([value]) => value));
const questionMatches = [];
const answerMatches = [];
const chunkMatches = [];
const lexicalMatches = [];
const lexicalThreshold = Number(process.env.GOLD_LEXICAL_DUPLICATE_THRESHOLD || 0.86);
for (const entry of pack.items) {
  const exact = exactQuestions.get(normalise(entry.user_question));
  if (exact) questionMatches.push({ training_id:entry.training_id,protected_id:exact.id,set:exact.set });
  const answer = exactAnswers.get(normalise(entry.ideal_answer));
  if (answer) answerMatches.push({ training_id:entry.training_id,protected_id:answer });
  for (const source of entry.retrieved_evidence || []) {
    const chunk = exactChunks.get(normalise(source.text));
    if (chunk) chunkMatches.push({ training_id:entry.training_id,protected_chunk:chunk });
  }
  const rowTokens = tokens(entry.user_question);
  const match = protectedQuestions.map((candidate) => ({ id:candidate.id,set:candidate.set,score:dice(rowTokens,tokens(candidate.question)) })).sort((a,b) => b.score - a.score)[0];
  if (match?.score >= lexicalThreshold) lexicalMatches.push({ training_id:entry.training_id,...match });
}

const semanticThreshold = Number(process.env.GOLD_SEMANTIC_DUPLICATE_THRESHOLD || 0.92);
const allQuestions = [...protectedQuestions.map((item) => item.question),...pack.items.map((item) => item.user_question)];
const embedded = await embedTexts(allQuestions);
const semanticMatches = [];
const closest = [];
if (!embedded.degraded) {
  const protectedVectors = embedded.embeddings.slice(0,protectedQuestions.length);
  const trainingVectors = embedded.embeddings.slice(protectedQuestions.length);
  for (let index = 0; index < trainingVectors.length; index += 1) {
    const match = protectedVectors.map((vector,protectedIndex) => ({ id:protectedQuestions[protectedIndex].id,set:protectedQuestions[protectedIndex].set,score:cosineSimilarity(trainingVectors[index],vector) })).sort((a,b) => b.score - a.score)[0];
    const pair = { training_id:pack.items[index].training_id,protected_id:match.id,set:match.set,score:Number(match.score.toFixed(4)) };
    closest.push(pair);
    if (match.score >= semanticThreshold) semanticMatches.push(pair);
  }
}

const passed = !embedded.degraded && !questionMatches.length && !answerMatches.length && !chunkMatches.length && !lexicalMatches.length && !semanticMatches.length;
const report = {
  version:"phase-5-training-contamination-report-v1",generated_at:isoNow(),status:passed ? "passed" : "failed",
  training_pack:{ path:PACK_PATH,sha256:hashFile(PACK_PATH),items:pack.items.length },
  protected_sets:{ development_regression:development.questions.length,sealed_unseen:protectedQuestions.filter((item) => item.set.startsWith("sealed_unseen_")).length,total_questions:protectedQuestions.length,sealed_answers_accessed:false },
  checks:{
    exact_question:{ matches:questionMatches },exact_gold_answer:{ matches:answerMatches },exact_gold_chunk:{ matches:chunkMatches },
    lexical:{ threshold:lexicalThreshold,matches:lexicalMatches },
    semantic:{ model:embedded.model,degraded:embedded.degraded,threshold:semanticThreshold,matches:semanticMatches }
  },
  closest_semantic_pairs:closest.sort((a,b) => b.score - a.score).slice(0,20),
  training_eligibility:"approved_manifest_only_pending_phase_6_gate_application"
};
writeJsonAtomic(REPORT_PATH,report);
if (passed) {
  pack.contamination_check = { status:"passed",report:REPORT_PATH,checked_at:report.generated_at };
  pack.items = pack.items.map((item) => ({ ...item,gold_similarity_check:"passed" }));
  writeJsonAtomic(PACK_PATH,pack);
  for (const path of [resolve(ROOT,"shared/citation-and-evidence-discipline.draft.json"),resolve(ROOT,"wave-4/scam-warning-and-handoff.draft.json"),resolve(ROOT,"revised-22-second-review.json")]) {
    const payload = readJson(path);
    payload.contamination_check = { status:"passed",report:REPORT_PATH,checked_at:report.generated_at };
    payload.items = payload.items.map((item) => ({ ...item,gold_similarity_check:"passed" }));
    writeJsonAtomic(path,payload);
  }
}
console.log(JSON.stringify({ status:report.status,items:pack.items.length,protected_questions:protectedQuestions.length,exact:questionMatches.length,answer_exact:answerMatches.length,chunk_exact:chunkMatches.length,lexical:lexicalMatches.length,semantic:semanticMatches.length,degraded:embedded.degraded,closest:report.closest_semantic_pairs.slice(0,5) },null,2));
if (!passed) process.exitCode = 1;
