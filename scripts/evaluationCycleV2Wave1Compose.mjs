import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WAVE = String(process.env.CYCLE_V2_WAVE || "wave-1").replace(/[^a-zA-Z0-9_-]/g, "-");
const ROOT = resolve(`training/evaluation-cycle-v2/02-${WAVE}-execution/diagnostic`);
const QUESTION_PATH = resolve(`training/evaluation-cycle-v2/01-question-set-review-revision-v2/${WAVE}/development-question-set.json`);
const OUTPUT_LABEL = String(process.env.CYCLE_V2_COMPOSITE_LABEL || process.env.CYCLE_V2_WAVE1_COMPOSITE_LABEL || "diagnostic-step68-remediation-composite-v1").replace(/[^a-zA-Z0-9._-]/g, "-");
const OUTPUT_PATH = resolve(ROOT, OUTPUT_LABEL, "results.json");
const defaultSources = [
  "diagnostic-step68-remediation-critical-v1",
  "diagnostic-step68-remediation-noncritical-v1",
  "diagnostic-step68-remediation-nine-v2",
  "diagnostic-step68-remediation-ordinary-work-v3",
];
const sources = String(process.env.CYCLE_V2_COMPOSITE_SOURCES || process.env.CYCLE_V2_WAVE1_COMPOSITE_SOURCES || "").split(",").map((value) => value.trim()).filter(Boolean);
if (!sources.length) sources.push(...defaultSources);

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

const requestedIds = new Set(String(process.env.CYCLE_V2_QUESTION_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
const allQuestions = readJson(QUESTION_PATH).topics.flatMap((topic) => topic.diagnostic_evaluation);
const questions = requestedIds.size ? allQuestions.filter((item) => requestedIds.has(item.id)) : allQuestions;
if (requestedIds.size && questions.length !== requestedIds.size) throw new Error(`One or more requested ${WAVE} question IDs do not exist.`);
const questionIds = new Set(questions.map((item) => item.id));
const latest = new Map();
const provenance = [];
for (const label of sources) {
  const path = resolve(ROOT, label, "results.json");
  const payload = readJson(path);
  provenance.push({ run_label: label, path, sha256: sha256(path), result_count: payload.results.length });
  for (const result of payload.results) latest.set(result.question_id, { ...result, composite_source_run: label });
}
const missing = [...questionIds].filter((id) => !latest.has(id));
const extra = [...latest.keys()].filter((id) => !questionIds.has(id));
if (missing.length || extra.length) throw new Error(`Composite coverage mismatch. Missing: ${missing.join(", ")}; extra: ${extra.join(", ")}`);
const results = questions.map((question) => latest.get(question.id));
const output = {
  version: `evaluation-cycle-v2-${WAVE}-remediation-composite-v1`,
  status: "completed_composite_development_diagnosis",
  generated_at: new Date().toISOString(),
  partition: "diagnostic",
  run_label: OUTPUT_LABEL,
  official_scoring_eligible: false,
  composite: true,
  provenance,
  results,
  summary: {
    processed: results.length,
    grounding_valid: results.filter((item) => item.grounding_validation?.valid).length,
    grounding_fallbacks: results.filter((item) => item.selected_route === "GROUNDING_FALLBACK").length,
    run_errors: results.filter((item) => item.selected_route === "RUN_ERROR").length,
  },
};
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT_PATH, summary: output.summary, provenance }, null, 2));
