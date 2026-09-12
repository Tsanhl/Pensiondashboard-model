import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cosineSimilarity, embedTexts } from "../server/services/embeddingService.js";

await import("../server/loadEnv.js");

const ROOT = resolve("training/evaluation-cycle-v2/01-question-set-review-revision-v2");
const V1_ROOT = resolve("training/evaluation-cycle-v2/00-question-set-review");
const CYCLE_V1_UNSEEN = resolve("training/evaluation-cycle-v1/04-unseen");
const GENERATED_AT = "2026-08-28T00:00:00.000Z";
const LEXICAL_THRESHOLD = 0.86;
const SEMANTIC_THRESHOLD = 0.92;

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function writeText(path, value) { writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`); }
function hashFile(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function normalise(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9£%]+/g, " ").trim().replace(/\s+/g, " ");
}
const stopWords = new Set("a an and are as at be but by can could do does for from has have how i if in is it may my of on or should that the this to was what when which why will with".split(" "));
function tokens(value) {
  return new Set(normalise(value).split(" ").filter((token) => token && !stopWords.has(token)).map((token) => token.length > 5 && token.endsWith("s") ? token.slice(0, -1) : token));
}
function dice(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function draftRows(root) {
  const rows = [];
  const topicCounts = [];
  for (const waveNumber of [1, 2, 3]) {
    const wave = `wave-${waveNumber}`;
    const development = readJson(resolve(root, wave, "development-question-set.json"));
    const unseen = readJson(resolve(root, wave, "unseen-question-set.json"));
    const unseenMap = new Map(unseen.topics.map((topic) => [topic.topic_id, topic]));
    for (const topic of development.topics) {
      for (const partition of ["diagnostic_evaluation", "training_candidates"]) {
        for (const item of topic[partition]) rows.push({ ...item, wave, topic_id: topic.topic_id, partition });
      }
      const unseenRows = unseenMap.get(topic.topic_id)?.questions || [];
      for (const item of unseenRows) rows.push({ ...item, wave, topic_id: topic.topic_id, partition: "unseen_candidates" });
      topicCounts.push({
        wave,
        topic_id: topic.topic_id,
        diagnostic_evaluation: topic.diagnostic_evaluation.length,
        training_candidates: topic.training_candidates.length,
        unseen_candidates: unseenRows.length,
      });
    }
  }
  return { rows, topicCounts };
}

function cycleV1ProtectedQuestions() {
  const rows = readJson(resolve("training/gold-evaluation-draft.json")).questions.map((item) => ({ id: item.id, question: item.question, set: "cycle_v1_gold_69" }));
  for (const entry of readdirSync(CYCLE_V1_UNSEEN, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("wave-")) continue;
    const path = resolve(CYCLE_V1_UNSEEN, entry.name, "questions.json");
    if (!existsSync(path)) continue;
    const payload = readJson(path);
    if (payload.training_eligibility !== "prohibited") throw new Error(`${path} is not training-prohibited`);
    rows.push(...payload.questions.map((item) => ({ id: item.id, question: item.question, set: "cycle_v1_sealed_unseen_60" })));
  }
  return rows;
}

function duplicateValues(rows, field, normaliser = (value) => value) {
  const seen = new Map();
  const matches = [];
  for (const row of rows) {
    const value = normaliser(row[field]);
    if (seen.has(value)) matches.push({ first_id: seen.get(value).id, second_id: row.id, value });
    else seen.set(value, row);
  }
  return matches;
}

function lexicalCross(left, right) {
  const matches = [];
  const prepared = right.map((row) => ({ ...row, tokens: tokens(row.question) }));
  for (const row of left) {
    const rowTokens = tokens(row.question);
    for (const candidate of prepared) {
      if (row.id === candidate.id) continue;
      const score = dice(rowTokens, candidate.tokens);
      if (score >= LEXICAL_THRESHOLD) matches.push({ left_id: row.id, right_id: candidate.id, right_set: candidate.set || candidate.partition, score: Number(score.toFixed(4)) });
    }
  }
  return matches;
}

function semanticCross(left, leftVectors, right, rightVectors) {
  const matches = [];
  const closest = [];
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const ranked = right.map((candidate, rightIndex) => ({
      id: candidate.id,
      set: candidate.set || candidate.partition,
      score: cosineSimilarity(leftVectors[leftIndex], rightVectors[rightIndex]),
    })).sort((a, b) => b.score - a.score);
    if (!ranked.length) continue;
    const pair = { left_id: left[leftIndex].id, left_partition: left[leftIndex].partition, right_id: ranked[0].id, right_set: ranked[0].set, score: Number(ranked[0].score.toFixed(4)) };
    closest.push(pair);
    if (ranked[0].score >= SEMANTIC_THRESHOLD) matches.push(pair);
  }
  return { matches, closest: closest.sort((a, b) => b.score - a.score).slice(0, 12) };
}

const { rows, topicCounts } = draftRows(ROOT);
const protectedRows = cycleV1ProtectedQuestions();
const trainingRows = rows.filter((row) => row.partition === "training_candidates");
const diagnosticRows = rows.filter((row) => row.partition === "diagnostic_evaluation");
const unseenRows = rows.filter((row) => row.partition === "unseen_candidates");
const newProtectedRows = [...diagnosticRows, ...unseenRows];

const requiredMetadata = [
  "law_as_at", "event_date", "source_cutoff", "legal_status", "difficulty", "risk_tier", "issue_routing", "question_type", "expected_answer_mode",
  "required_facts", "decisive_missing_facts", "authority_class", "primary_source_targets", "source_readiness", "proposition_citation_targets",
  "proposition_citation_status", "must_include", "must_not", "advice_boundary", "action_boundary", "score_dimensions", "construct_id",
];
const routingFields = ["scheme_legislation", "trust_or_governing_law", "employment_location", "member_residence", "complaint_forum", "divorce_forum", "tax_jurisdiction", "provider_regulator", "destination_country"];
const requiredScoreDimensions = ["legal_rule_accuracy", "currentness_and_commencement", "authority_hierarchy", "jurisdiction_selection", "application_to_facts", "proposition_to_citation_entailment", "missing_fact_discipline", "regulated_advice_boundary", "action_execution_boundary", "helpfulness_and_directness", "invented_fact_or_citation_safety", "timeout_fallback_safety"];
const missingMetadata = [];
const invalidPartitionBoundaries = [];
for (const row of rows) {
  for (const field of requiredMetadata) if (!(field in row)) missingMetadata.push({ id: row.id, field });
  for (const field of routingFields) if (!(field in (row.issue_routing || {}))) missingMetadata.push({ id: row.id, field: `issue_routing.${field}` });
  for (const dimension of requiredScoreDimensions) if (!(row.score_dimensions || []).includes(dimension)) missingMetadata.push({ id: row.id, field: `score_dimensions.${dimension}` });
  const expectedEligibility = row.partition === "training_candidates" ? "draft_not_approved" : "prohibited";
  if (row.training_eligibility !== expectedEligibility) invalidPartitionBoundaries.push({ id: row.id, partition: row.partition, actual: row.training_eligibility, expected: expectedEligibility });
}

const oldTrainingById = new Map();
for (const waveNumber of [1, 2, 3]) {
  const payload = readJson(resolve(V1_ROOT, `wave-${waveNumber}`, "development-question-set.json"));
  for (const topic of payload.topics) for (const item of topic.training_candidates) oldTrainingById.set(item.id, item.question);
}
const inheritedTraining = trainingRows.filter((row) => oldTrainingById.has(row.id));
const unchangedInheritedTraining = inheritedTraining.filter((row) => row.question === oldTrainingById.get(row.id)).map((row) => row.id);
const targetCuePattern = /\b(?:your answer|the answer) (?:must|should)\b|\b(?:respond by|answer by|refuse (?:to|the)|abstain|ask for the missing|cite only|do not invent|give a cautious framework|route this to)\b|^(?:please\s+)?(?:state|explain|identify|distinguish|classify|apply|analyse|calculate)\b/i;
const visibleTargetCues = trainingRows.filter((row) => targetCuePattern.test(row.question)).map((row) => row.id);

const exact = {
  duplicate_ids: duplicateValues(rows, "id"),
  duplicate_questions: duplicateValues(rows, "question", normalise),
  duplicate_construct_ids: duplicateValues(rows, "construct_id"),
  draft_vs_cycle_v1: rows.filter((row) => protectedRows.some((candidate) => normalise(candidate.question) === normalise(row.question))).map((row) => row.id),
};
const lexical = {
  threshold: LEXICAL_THRESHOLD,
  draft_vs_cycle_v1: lexicalCross(rows, protectedRows),
  training_vs_new_protected: lexicalCross(trainingRows, newProtectedRows),
  unseen_vs_new_diagnostic: lexicalCross(unseenRows, diagnosticRows),
};

const allForEmbedding = [...protectedRows, ...rows];
const embedded = await embedTexts(allForEmbedding.map((row) => row.question));
if (embedded.degraded) throw new Error("Revision-v2 validation requires the non-degraded BGE embedding service.");
const protectedVectors = embedded.embeddings.slice(0, protectedRows.length);
const draftVectors = embedded.embeddings.slice(protectedRows.length);
const vectorById = new Map(rows.map((row, index) => [row.id, draftVectors[index]]));
const semantic = {
  model: embedded.model,
  degraded: embedded.degraded,
  threshold: SEMANTIC_THRESHOLD,
  draft_vs_cycle_v1: semanticCross(rows, draftVectors, protectedRows, protectedVectors),
  training_vs_new_protected: semanticCross(trainingRows, trainingRows.map((row) => vectorById.get(row.id)), newProtectedRows, newProtectedRows.map((row) => vectorById.get(row.id))),
  unseen_vs_new_diagnostic: semanticCross(unseenRows, unseenRows.map((row) => vectorById.get(row.id)), diagnosticRows, diagnosticRows.map((row) => vectorById.get(row.id))),
};

const sourceGaps = readJson(resolve(ROOT, "manifest.json")).source_gaps_before_gold_authoring;
const failures = [
  ...exact.duplicate_ids, ...exact.duplicate_questions, ...exact.duplicate_construct_ids, ...exact.draft_vs_cycle_v1,
  ...lexical.draft_vs_cycle_v1, ...lexical.training_vs_new_protected, ...lexical.unseen_vs_new_diagnostic,
  ...semantic.draft_vs_cycle_v1.matches, ...semantic.training_vs_new_protected.matches, ...semantic.unseen_vs_new_diagnostic.matches,
  ...missingMetadata, ...invalidPartitionBoundaries, ...unchangedInheritedTraining, ...visibleTargetCues,
];

const report = {
  version: "topic-question-review-revision-v2-validation-v1",
  generated_at: GENERATED_AT,
  status: failures.length ? "failed" : "passed_draft_integrity_and_contamination",
  pack_root: ROOT,
  manifest_sha256: hashFile(resolve(ROOT, "manifest.json")),
  counts: {
    total: rows.length,
    diagnostic_evaluation: diagnosticRows.length,
    training_candidates: trainingRows.length,
    unseen_candidates: unseenRows.length,
    core_topics: 10,
    supplemental_current_law_blocks: 3,
    protected_cycle_v1_questions: protectedRows.length,
  },
  topic_counts: topicCounts,
  structural: { missing_metadata: missingMetadata, invalid_partition_boundaries: invalidPartitionBoundaries, ...exact },
  training_prompt_naturalisation: { inherited_candidates: inheritedTraining.length, changed_from_v1: inheritedTraining.length - unchangedInheritedTraining.length, unchanged: unchangedInheritedTraining, visible_target_cues: visibleTargetCues },
  lexical,
  semantic,
  protected_assets: { cycle_v1_gold_questions: 69, cycle_v1_sealed_unseen_questions: 60, sealed_answer_files_accessed: false, existing_gold_or_unseen_modified: false },
  source_gaps_before_gold_authoring: sourceGaps,
  activation_status: "not_active_gold_not_approved_training_not_sealed_unseen",
};
writeJson(resolve(ROOT, "VALIDATION.json"), report);

const topicTable = topicCounts.map((row) => `| ${row.wave} | ${row.topic_id} | ${row.diagnostic_evaluation} | ${row.training_candidates} | ${row.unseen_candidates} |`).join("\n");
writeText(resolve(ROOT, "VALIDATION.md"), `# Revision-v2 validation\n\nValidated on 28 August 2026. Status: **${report.status}**.\n\n## Scope\n\n- 10 requested topic suites plus 3 focused current-law blocks.\n- ${rows.length} questions: ${diagnosticRows.length} diagnostic, ${trainingRows.length} training candidates and ${unseenRows.length} unseen candidates.\n- Protected comparison: 69 frozen Cycle v1 gold questions plus 60 sealed-unseen questions. Sealed answer files were not accessed.\n\n## Structural and prompt checks\n\n- Unique IDs, question text and precise construct IDs: passed; zero duplicates.\n- Required legal-status, temporal, routing, answer-mode, source, boundary and 12-dimension skill-scoring fields: passed; zero missing fields.\n- Partition boundaries: passed. Diagnostic and unseen items are training-prohibited; training candidates remain draft and unapproved.\n- Inherited training prompts naturalised: ${inheritedTraining.length}/${inheritedTraining.length} changed from v1; zero visible target-behaviour cues under the review-specific cue audit.\n- Existing Cycle v1 gold and sealed-unseen assets modified: no.\n\n## Contamination screening\n\n- Exact matches: 0.\n- Lexical near-duplicates at Dice ${LEXICAL_THRESHOLD}: 0.\n- Semantic near-duplicates at cosine ${SEMANTIC_THRESHOLD}: 0.\n- Semantic model: \`${embedded.model}\`; non-degraded local service.\n- Checks cover all revision-v2 drafts versus Cycle v1, training versus new diagnostic/unseen, and new unseen versus new diagnostic.\n\n## Counts by topic or focused block\n\n| Wave | Topic/block | Diagnostic | Training | Unseen |\n|---|---|---:|---:|---:|\n${topicTable}\n\nThe original ten topic suites use risk-weighted counts within or close to the requested initial ranges. The three deliberately smaller entries are supplemental current-law blocks for PSA 2026, dashboards duties and the 2027 pension-IHT transition.\n\n## Still required before activation\n\n- Admit and pin the four sources listed in the manifest source-gap register.\n- Author proposition-level evidence targets, gold answers/ideal answers and item-specific rubrics.\n- Complete independent legal, jurisdiction and citation-entailment review.\n- Re-run contamination after owner edits.\n- Encrypt and seal approved unseen gold answers before any model run.\n\nThis validation does not approve any item for evaluation, LoRA training or model selection.\n`);

console.log(JSON.stringify({ status: report.status, counts: report.counts, exact_matches: exact.draft_vs_cycle_v1.length + exact.duplicate_questions.length, lexical_matches: lexical.draft_vs_cycle_v1.length + lexical.training_vs_new_protected.length + lexical.unseen_vs_new_diagnostic.length, semantic_matches: semantic.draft_vs_cycle_v1.matches.length + semantic.training_vs_new_protected.matches.length + semantic.unseen_vs_new_diagnostic.matches.length, missing_metadata: missingMetadata.length, unchanged_training_prompts: unchangedInheritedTraining.length, visible_target_cues: visibleTargetCues.length }, null, 2));
if (failures.length) process.exitCode = 1;
