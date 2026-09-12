import { existsSync,readdirSync,readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cosineSimilarity,embedTexts } from "../server/services/embeddingService.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run training:validate -- path/to/examples.jsonl");
const resolvedTrainingPath = resolve(path);
const protectedRoots = [
  resolve("training/evaluation-cycle-v1/04-unseen"),
  resolve("training/evaluation-cycle-v1/07-final-gold"),
  resolve("training/evaluation-cycle-v1/08-blind-validation")
];
if (protectedRoots.some((root) => resolvedTrainingPath === root || resolvedTrainingPath.startsWith(`${root}/`))) {
  throw new Error("Evaluation, unseen, final-gold and blind-validation assets are prohibited training inputs.");
}
const goldPath = resolve(process.env.PENSION_GOLD_EVAL_PATH || "training/gold-evaluation-draft.json");
const forbidden = /(?:api[_ -]?key|password|secret|real user|policy number\s*:\s*[A-Z0-9-]+|£\s*\d{4,})/i;
const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
const examples = rows.map((line) => JSON.parse(line));
const gold = JSON.parse(readFileSync(goldPath,"utf8"));
if (gold.training_eligibility !== "prohibited") throw new Error("Gold set must be marked prohibited from training before leakage checks run.");

function loadQuestionPack(questionPath,setName) {
  const payload = JSON.parse(readFileSync(questionPath,"utf8"));
  if (payload.training_eligibility !== "prohibited") throw new Error(`${setName} must be marked prohibited from training.`);
  const questions = payload.questions || [];
  return questions.map((item) => ({ id:item.id,question:item.question,set:setName }));
}

const protectedQuestions = gold.questions.map((item) => ({ id:item.id,question:item.question,set:"development_regression" }));
const unseenRoot = resolve("training/evaluation-cycle-v1/04-unseen");
if (existsSync(unseenRoot)) {
  for (const entry of readdirSync(unseenRoot,{ withFileTypes:true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("wave-")) continue;
    const questionPath = resolve(unseenRoot,entry.name,"questions.json");
    if (existsSync(questionPath)) protectedQuestions.push(...loadQuestionPack(questionPath,`unseen/${entry.name}`));
  }
}
for (const [questionPath,setName] of [
  [resolve("training/evaluation-cycle-v1/07-final-gold/questions.json"),"final_gold"],
  [resolve("training/evaluation-cycle-v1/08-blind-validation/questions.sealed.json"),"blind_validation"]
]) {
  if (existsSync(questionPath)) protectedQuestions.push(...loadQuestionPack(questionPath,setName));
}

const stopWords = new Set(["a","an","and","are","as","at","be","but","by","can","could","do","does","for","from","has","have","how","i","if","in","is","it","may","my","of","on","or","should","that","the","this","to","was","what","when","which","why","will","with"]);
function normaliseQuestion(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9£%]+/g," ").trim().replace(/\s+/g," ");
}
function tokens(value) {
  return new Set(normaliseQuestion(value).split(" ").filter((token) => token && !stopWords.has(token)).map((token) => token.length > 5 && token.endsWith("s") ? token.slice(0,-1) : token));
}
function dice(left,right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

const protectedExact = new Map(protectedQuestions.map((item) => [normaliseQuestion(item.question),item]));
const protectedTokens = protectedQuestions.map((item) => ({ ...item,tokens:tokens(item.question) }));
const sourceFamilies = new Map();
for (const [index,row] of examples.entries()) {
  for (const field of ["id","split","source_family","topic","question","answer","review_status"]) if (!row[field]) throw new Error(`Row ${index + 1} is missing ${field}.`);
  if (!Array.isArray(row.evidence) || !row.evidence.length) throw new Error(`Row ${index + 1} requires evidence.`);
  if (!row.evidence.every((item) => item.id && item.text)) throw new Error(`Row ${index + 1} has invalid evidence IDs.`);
  if (row.review_status !== "approved") throw new Error(`Row ${index + 1} is not approved.`);
  if (forbidden.test(JSON.stringify(row))) throw new Error(`Row ${index + 1} may contain restricted or real-user data.`);
  const previous = sourceFamilies.get(row.source_family);
  if (previous && previous !== row.split) throw new Error(`Source family ${row.source_family} crosses dataset splits.`);
  sourceFamilies.set(row.source_family, row.split);
  const exactMatch = protectedExact.get(normaliseQuestion(row.question));
  if (exactMatch) throw new Error(`Row ${index + 1} duplicates protected ${exactMatch.set} question ${exactMatch.id}.`);
  const rowTokens = tokens(row.question);
  const lexicalMatch = protectedTokens.map((item) => ({ id:item.id,set:item.set,score:dice(rowTokens,item.tokens) })).sort((a,b) => b.score - a.score)[0];
  if (lexicalMatch?.score >= Number(process.env.GOLD_LEXICAL_DUPLICATE_THRESHOLD || 0.86)) {
    throw new Error(`Row ${index + 1} is a lexical near-duplicate of protected ${lexicalMatch.set} item ${lexicalMatch.id} (${lexicalMatch.score.toFixed(3)}).`);
  }
}

const allQuestions = [...protectedQuestions.map((item) => item.question),...examples.map((item) => item.question)];
const embedded = await embedTexts(allQuestions);
const requireSemantic = String(process.env.REQUIRE_SEMANTIC_GOLD_LEAKAGE_CHECK || "false").toLowerCase() === "true";
if (embedded.degraded && requireSemantic) throw new Error("Semantic gold leakage check requires the configured BGE embedding service; deterministic fallback is not accepted for a training release.");
if (!embedded.degraded) {
  const protectedVectors = embedded.embeddings.slice(0,protectedQuestions.length);
  const trainingVectors = embedded.embeddings.slice(protectedQuestions.length);
  const threshold = Number(process.env.GOLD_SEMANTIC_DUPLICATE_THRESHOLD || 0.92);
  for (const [index,vector] of trainingVectors.entries()) {
    const match = protectedVectors.map((candidate,protectedIndex) => ({ id:protectedQuestions[protectedIndex].id,set:protectedQuestions[protectedIndex].set,score:cosineSimilarity(vector,candidate) })).sort((a,b) => b.score - a.score)[0];
    if (match?.score >= threshold) throw new Error(`Row ${index + 1} is a semantic near-duplicate of protected ${match.set} item ${match.id} (${match.score.toFixed(3)}).`);
  }
}
console.log(`Validated ${rows.length} reviewed examples against ${protectedQuestions.length} protected evaluation questions with source-family split isolation and leakage checks (${embedded.degraded ? "exact + lexical; semantic BGE required for release" : embedded.model}).`);
