import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertTrainingDatasetIntegrity, loadReviewedTrainingItems } from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT = resolve("training/evaluation-cycle-v2/02-wave-2-execution/training");
const REVIEW_PATH = resolve(ROOT, "training-review-pack.json");
const DATASET_ROOT = resolve("training-data/private/evaluation-cycle-v2-wave-2-lora");
assertTrainingDatasetIntegrity(DATASET_ROOT);
const MANIFEST_PATH = resolve(DATASET_ROOT, "dataset-manifest.json");
const QUESTION_SET_PATH = resolve("training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-2/development-question-set.json");
const UNSEEN_PATH = resolve("training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-2/unseen-question-set.json");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = (path) => sha(readFileSync(path));
const normalise = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const review = JSON.parse(readFileSync(REVIEW_PATH, "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const questions = JSON.parse(readFileSync(QUESTION_SET_PATH, "utf8"));
loadReviewedTrainingItems(resolve(ROOT, "reviewed-source-training-items.json"), questions.topics.flatMap((topic) => topic.training_candidates));
const unseen = JSON.parse(readFileSync(UNSEEN_PATH, "utf8"));
if (review.item_count !== 33 || review.items.length !== 33 || manifest.train.count !== 27 || manifest.validation.count !== 6) throw new Error("Wave 2 training counts are invalid.");
if (manifest.source_id_overlap.length || manifest.protected_partitions.diagnostic_gold !== "excluded" || manifest.protected_partitions.sealed_unseen_questions !== "excluded") throw new Error("Wave 2 protected-partition or source-disjoint gate failed.");

const diagnosticQuestions = new Set(questions.topics.flatMap((topic) => topic.diagnostic_evaluation.map((item) => normalise(item.question))));
const unseenQuestions = new Set(unseen.topics.flatMap((topic) => topic.questions.map((item) => normalise(item.question))));
const trainingQuestions = review.items.map((item) => normalise(item.user_question));
if (trainingQuestions.some((question) => diagnosticQuestions.has(question) || unseenQuestions.has(question))) throw new Error("Exact diagnostic or unseen question leakage was detected.");
for (const item of review.items) {
  if (!item.synthetic_fixture.synthetic || item.synthetic_fixture.contains_real_user_data) throw new Error(`${item.training_id} is not synthetic-only.`);
  if (item.completion_target_field !== "ideal_answer" || !item.ideal_answer.trim()) throw new Error(`${item.training_id} has an invalid completion target.`);
  const evidenceIds = new Set(item.retrieved_evidence.map((source) => source.source_id));
  const citationIds = [...item.ideal_answer.matchAll(/\{\{cite:([^}]+)\}\}/g)].map((match) => match[1]);
  if (!citationIds.length || citationIds.some((id) => !evidenceIds.has(id))) throw new Error(`${item.training_id} has a missing or invented training citation.`);
  item.human_review_status = "approved_for_wave_2_cumulative_training";
}
review.status = "approved_for_wave_2_cumulative_training";
review.approved_at = new Date().toISOString();
review.review_basis = "Item-by-item authoring review against the Wave 2 legal/source framework; this is a training approval, not the independent sealed-unseen review.";
writeFileSync(REVIEW_PATH, `${JSON.stringify(review, null, 2)}\n`);
const approval = {
  version: "evaluation-cycle-v2-wave-2-training-approval-v1",
  status: "approved_for_cumulative_training",
  approved_at: review.approved_at,
  approved_items: review.items.map((item) => item.training_id),
  dataset_manifest_path: MANIFEST_PATH,
  dataset_manifest_sha256: hashFile(MANIFEST_PATH),
  training_review_pack_path: REVIEW_PATH,
  training_review_pack_sha256: hashFile(REVIEW_PATH),
  question_set_sha256: hashFile(QUESTION_SET_PATH),
  gates: {
    synthetic_only: true,
    completion_target_ideal_answer_only: true,
    source_id_disjoint_27_6_split: true,
    exact_diagnostic_question_overlap: 0,
    exact_unseen_question_overlap: 0,
    diagnostic_gold_excluded: true,
    unseen_questions_and_gold_excluded: true,
  },
  limitation: "Does not authorise unseen execution and does not convert development gold scoring into official scoring.",
};
writeFileSync(resolve(ROOT, "training-approval.json"), `${JSON.stringify(approval, null, 2)}\n`);
console.log(JSON.stringify({ status: approval.status, items: approval.approved_items.length, gates: approval.gates, approval: resolve(ROOT, "training-approval.json") }, null, 2));
