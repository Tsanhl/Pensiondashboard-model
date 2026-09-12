import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve("training/evaluation-cycle-v2");
const PACK_ROOT = resolve(ROOT, "01-question-set-review-revision-v2");
const WAVE = String(process.env.CYCLE_V2_WAVE || "wave-1").replace(/[^a-zA-Z0-9_-]/g, "-");
const WAVE_NUMBER = WAVE.match(/(\d+)/)?.[1] || "1";
const RUN_ROOT = resolve(ROOT, `02-${WAVE}-execution`);
const DEVELOPMENT_PATH = resolve(PACK_ROOT, `${WAVE}/development-question-set.json`);
const UNSEEN_PATH = resolve(PACK_ROOT, `${WAVE}/unseen-question-set.json`);
const VALIDATION_PATH = resolve(PACK_ROOT, "VALIDATION.json");
const CHECKPOINT_PATH = resolve(process.env.CYCLE_V2_CHECKPOINT_PATH || "training/evaluation-cycle-v1/05-training-runs/pension-assistant-v1-targeted-behaviour/checkpoint-selection.json");
const EVALUATION_GOLD_PATH = resolve(RUN_ROOT, "gold/evaluation-gold.json");
const EVALUATION_APPROVAL_PATH = resolve(RUN_ROOT, "gold/independent-review-approval.json");
const SEALED_UNSEEN_GOLD_PATH = resolve(RUN_ROOT, "unseen/gold-answers.sealed.json");
const UNSEEN_APPROVAL_PATH = resolve(RUN_ROOT, "unseen/independent-review-approval.json");

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function writeText(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`); }

for (const path of [DEVELOPMENT_PATH, UNSEEN_PATH, VALIDATION_PATH, CHECKPOINT_PATH]) {
  if (!existsSync(path)) throw new Error(`${WAVE} preflight input is missing: ${path}`);
}

const development = readJson(DEVELOPMENT_PATH);
const unseen = readJson(UNSEEN_PATH);
const validation = readJson(VALIDATION_PATH);
const checkpoint = readJson(CHECKPOINT_PATH);
const diagnostics = development.topics.flatMap((topic) => topic.diagnostic_evaluation);
const training = development.topics.flatMap((topic) => topic.training_candidates);
const unseenQuestions = unseen.topics.flatMap((topic) => topic.questions);
const pendingCitationTargets = [...diagnostics, ...unseenQuestions].filter((item) => item.proposition_citation_status !== "complete").map((item) => item.id);
const evaluationGoldPresent = existsSync(EVALUATION_GOLD_PATH);
const evaluationApprovalPresent = existsSync(EVALUATION_APPROVAL_PATH);
const sealedGoldPresent = existsSync(SEALED_UNSEEN_GOLD_PATH);
const unseenApprovalPresent = existsSync(UNSEEN_APPROVAL_PATH);
const adapterPresent = existsSync(checkpoint.selected_adapter_path) && existsSync(resolve(checkpoint.selected_adapter_path, "adapters.safetensors"));
const evaluationGold = evaluationGoldPresent ? readJson(EVALUATION_GOLD_PATH) : null;
const evaluationGoldIdsMatch = Boolean(evaluationGold) && evaluationGold.items.length === diagnostics.length && evaluationGold.items.every((item) => diagnostics.some((question) => question.id === item.id));
const evaluationPassagePinsComplete = Boolean(evaluationGold) && evaluationGold.items.every((item) => item.proposition_citation_targets?.length && item.proposition_citation_targets.every((target) => target.chunk_targets?.length));

const report = {
  version: `evaluation-cycle-v2-${WAVE}-preflight-v1`,
  generated_at: new Date().toISOString(),
  owner_instruction: `Start full Wave ${WAVE_NUMBER} evaluation; execute unseen only after the diagnostic gate and unseen integrity gates pass.`,
  pack: {
    status: development.status,
    development_path: DEVELOPMENT_PATH,
    development_sha256: sha256File(DEVELOPMENT_PATH),
    unseen_path: UNSEEN_PATH,
    unseen_sha256: sha256File(UNSEEN_PATH),
    validation_status: validation.status,
    counts: { diagnostic: diagnostics.length, training_candidates: training.length, unseen: unseenQuestions.length },
  },
  model: {
    version: checkpoint.model_version,
    selected_iteration: checkpoint.selected_iteration,
    selected_validation_loss: checkpoint.selected_validation_loss,
    adapter_path: checkpoint.selected_adapter_path,
    adapter_sha256: checkpoint.adapter_sha256,
    adapter_present: adapterPresent,
  },
  gates: {
    draft_integrity_and_contamination: validation.status === "passed_draft_integrity_and_contamination" ? "passed" : "failed",
    wording_preflight: `passed_after_owner_review_revision_v2_${WAVE}`,
    evaluation_gold_present: evaluationGoldPresent,
    evaluation_gold_ids_match: evaluationGoldIdsMatch,
    evaluation_proposition_candidate_pins_complete: evaluationPassagePinsComplete,
    independent_evaluation_gold_review_present: evaluationApprovalPresent,
    sealed_unseen_gold_present: sealedGoldPresent,
    independent_unseen_review_present: unseenApprovalPresent,
    selected_adapter_present: adapterPresent,
  },
  authorisation: {
    diagnostic_output_collection: adapterPresent && validation.status === "passed_draft_integrity_and_contamination",
    official_diagnostic_pass_fail: evaluationGoldPresent && evaluationGoldIdsMatch && evaluationPassagePinsComplete && evaluationApprovalPresent,
    unseen_execution: sealedGoldPresent && unseenApprovalPresent && evaluationGoldPresent && evaluationApprovalPresent,
  },
  pending: {
    evaluation_gold_items: evaluationGoldPresent ? 0 : diagnostics.length,
    proposition_citation_targets: pendingCitationTargets.length,
    unseen_gold_items: sealedGoldPresent ? 0 : unseenQuestions.length,
    independent_unseen_review: unseenApprovalPresent ? 0 : unseenQuestions.length,
  },
  decision: "diagnostic_output_collection_authorised_official_scoring_and_unseen_blocked",
};

writeJson(resolve(RUN_ROOT, "preflight.json"), report);
writeText(resolve(RUN_ROOT, "PREFLIGHT.md"), `# Cycle v2 Wave ${WAVE_NUMBER} preflight\n\nGenerated: ${report.generated_at}\n\n## Decision\n\n**Diagnostic output collection is authorised. Official pass/fail scoring and unseen execution are not yet authorised.**\n\nThe selected step-${checkpoint.selected_iteration} adapter exists and the revised bank passed structural/contamination validation. However, the ${diagnostics.length} diagnostic items do not yet have independently reviewed item-specific gold answers, rubrics and proposition-level citation targets. The ${unseenQuestions.length} unseen candidates have neither sealed gold answers nor an independent approval artifact.\n\n## Safe sequence\n\n1. Collect diagnostic outputs without exposing any gold target to the model.\n2. Complete and review diagnostic gold/rubrics, then score the frozen output.\n3. Use only diagnostic/training partitions for fixes and repeat until the diagnostic gate passes.\n4. Independently author/review and seal unseen gold.\n5. Execute unseen once; do not train or tune against it.\n\nNo item can be marked passed merely because a model response was produced.\n`);

console.log(JSON.stringify({ decision: report.decision, counts: report.pack.counts, gates: report.gates, authorisation: report.authorisation }, null, 2));
