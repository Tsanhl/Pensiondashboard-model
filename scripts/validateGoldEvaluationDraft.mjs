import "../server/loadEnv.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialiseDataStore } from "../server/store/userDataStore.js";
import { listKnowledgeDocuments } from "../server/services/knowledgeService.js";

const path = resolve(process.argv[2] || "training/gold-evaluation-draft.json");
const draft = JSON.parse(await readFile(path,"utf8"));
const rows = draft.questions;
if (!Array.isArray(rows) || rows.length < 50 || rows.length > 75) throw new Error("The reviewed gold evaluation set must contain 50 to 75 questions.");
if (draft.human_review_status !== "approved_subject_to_answer_review") throw new Error("Question review must be approved subject to answer review.");
if (draft.question_set_status !== "approved_and_frozen") throw new Error("The reviewed question set must be frozen.");
if (draft.training_eligibility !== "prohibited") throw new Error("Gold evaluation questions must be prohibited from training.");
await initialiseDataStore();
const active = new Set((await listKnowledgeDocuments("__public__")).map((item) => item.id));
const ids = new Set();
const categories = new Map();
const outcomes = new Map();
const suites = new Map();
const allowedSuites = new Set(["consumer_dashboard_gold","advanced_pensions_law_gold","adversarial_and_action_safety_gold"]);
const allowedJurisdictions = new Set(draft.jurisdiction_taxonomy || []);
const allowedRoutes = new Set(["ANSWER","CLARIFY_THEN_ANSWER","ANSWER_AND_HANDOFF","HANDOFF","REFUSE_ACTION","SECURITY_FALLBACK"]);
for (const [index,row] of rows.entries()) {
  for (const field of ["id","category","question","jurisdiction","intent","expected_outcome","expected_route","primary_behavior","response_mode","jurisdiction_behavior","evidence_basis","as_of_date","suite","persona","review_status","human_review_status","training_eligibility"]) {
    if (!row[field]) throw new Error(`Question ${index + 1} is missing ${field}.`);
  }
  if (ids.has(row.id)) throw new Error(`Duplicate question id: ${row.id}`);
  ids.add(row.id);
  if (!allowedSuites.has(row.suite)) throw new Error(`${row.id} has unknown suite ${row.suite}.`);
  if (!allowedJurisdictions.has(row.jurisdiction)) throw new Error(`${row.id} has unknown jurisdiction ${row.jurisdiction}.`);
  if (!allowedRoutes.has(row.expected_route)) throw new Error(`${row.id} has unknown expected route ${row.expected_route}.`);
  if (row.review_status !== "approved_subject_to_answer_review" || row.human_review_status !== "approved_subject_to_answer_review") throw new Error(`${row.id} is not approved subject to answer review.`);
  if (row.training_eligibility !== "prohibited") throw new Error(`${row.id} must be prohibited from training.`);
  if (typeof row.handoff_required !== "boolean" || typeof row.action_allowed !== "boolean") throw new Error(`${row.id} needs boolean handoff_required and action_allowed fields.`);
  if (!Array.isArray(row.answer_rubric) || row.answer_rubric.length < 2) throw new Error(`${row.id} needs at least two answer-rubric points.`);
  if (!Array.isArray(row.must_include) || row.must_include.length < 2) throw new Error(`${row.id} needs at least two must_include checks.`);
  if (!Array.isArray(row.must_not) || !row.must_not.length) throw new Error(`${row.id} needs a must_not guardrail.`);
  if (!Array.isArray(row.fixture_requirements)) throw new Error(`${row.id} needs a fixture_requirements array.`);
  for (const sourceId of row.required_source_ids || []) {
    if (/^(?:fca|moneyhelper)-/.test(sourceId)) throw new Error(`${row.id} references a licence-gated FCA/MoneyHelper source.`);
    if (!active.has(sourceId)) throw new Error(`${row.id} references inactive source ${sourceId}.`);
  }
  categories.set(row.category,(categories.get(row.category) || 0) + 1);
  outcomes.set(row.expected_outcome,(outcomes.get(row.expected_outcome) || 0) + 1);
  suites.set(row.suite,(suites.get(row.suite) || 0) + 1);
}
console.log(JSON.stringify({ valid:true,path,questions:rows.length,suites:Object.fromEntries([...suites].sort()),categories:Object.fromEntries([...categories].sort()),outcomes:Object.fromEntries([...outcomes].sort()),status:draft.status,training_eligibility:draft.training_eligibility },null,2));
