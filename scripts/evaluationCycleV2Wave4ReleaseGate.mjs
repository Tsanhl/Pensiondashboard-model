import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { assessFrozenSlice } from "./lib/releaseEvidence.mjs";
import { auditTrainingDataset } from "./lib/trainingEvidenceIntegrity.mjs";

const BASE = resolve("training/evaluation-cycle-v2/03-wave-4-release-gate");
const RUN_LABEL = process.env.WAVE4_REPAIR_LABEL || "wave4-runtime-repair-20260831-v2";
if (!/^[a-zA-Z0-9._-]+$/.test(RUN_LABEL)) throw new Error("Invalid release run label");
const ROOT = resolve(BASE, RUN_LABEL);
mkdirSync(ROOT, { recursive: true });
const checkpoint = readJson(resolve("training/evaluation-cycle-v2/02-wave-3-execution/training/cumulative-lora-v1/checkpoint-selection.json"));
const training = readJson(resolve("training/evaluation-cycle-v2/02-wave-3-execution/training/cumulative-lora-v1/training-run-manifest.json"));
const expectedIdentity = { id: `${checkpoint.model_version}-step${checkpoint.selected_iteration}`, adapter_sha256: checkpoint.adapter_sha256, base_sha256: training.base_model.model_sha256 };
const trainingLineage = [2, 3].map((wave) => {
  const manifestPath = resolve(`training/evaluation-cycle-v2/02-wave-${wave}-execution/training/cumulative-lora-v1/training-run-manifest.json`);
  const run = readJson(manifestPath);
  if (!run?.dataset?.path) return { wave, passed:false, error:"training_dataset_provenance_missing" };
  const audit = auditTrainingDataset(run.dataset.path);
  const manifestMatches = hashFile(resolve(run.dataset.path, "dataset-manifest.json")) === run.dataset.manifest_sha256;
  const datasetManifest = readJson(resolve(run.dataset.path, "dataset-manifest.json"));
  const partitionsMatch = audit.partitions.every((part) => part.sha256 === datasetManifest?.[part.partition === "valid" ? "validation" : "train"]?.sha256);
  return { wave, manifest_path:manifestPath, dataset_manifest_matches:manifestMatches, partition_hashes_match:partitionsMatch,
    ...audit, passed:audit.passed && manifestMatches && partitionsMatch };
});
const selection = JSON.parse(readFileSync(resolve(BASE, "selection.json"), "utf8"));
const waveRuns = new Map([
  ...[1, 2, 3].map((n) => [`wave-${n}`, resolve(`training/evaluation-cycle-v2/02-wave-${n}-execution/diagnostic/${RUN_LABEL}`)]),
]);

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function hashFile(path) { return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null; }

const diagnostics = selection.waves.map((wave) => {
  const runRoot = waveRuns.get(wave.wave);
  const scorecard = readJson(resolve(runRoot, "scorecard.json"));
  const results = readJson(resolve(runRoot, "results.json"));
  const expected = new Set(wave.question_ids);
  const actual = new Set((results?.results || []).map((item) => item.question_id));
  const evidence = assessFrozenSlice({ expectedIds: wave.question_ids, results, scorecard,
    manifest: readJson(resolve(runRoot, "run-manifest.json")), resultsSha256: hashFile(resolve(runRoot, "results.json")), expectedIdentity });
  return {
    wave: wave.wave,
    expected: expected.size,
    processed: actual.size,
    pass: scorecard?.outcomes?.pass || 0,
    critical_failures: scorecard?.outcomes?.critical_fail || 0,
    run_errors: scorecard?.run_errors ?? null,
    ...evidence,
    run_root: runRoot,
  };
});

const criticalRoot = resolve(`training/evaluation-cycle-v1/06-regression/${RUN_LABEL}`);
const criticalPath = resolve(criticalRoot, "post-fix-scorecard.json");
const critical = readJson(criticalPath);
const criticalEvidence = assessFrozenSlice({ expectedIds: ["gold-011", "gold-041", "gold-047", "gold-063"], scorecard: critical,
  results: readJson(resolve(criticalRoot, "post-fix-results.json")), manifest: readJson(resolve(criticalRoot, "post-fix-run-manifest.json")),
  resultsSha256: hashFile(resolve(criticalRoot, "post-fix-results.json")), expectedIdentity });
const criticalPassed = criticalEvidence.passed;
const waveManifests = [...waveRuns.values()].map((path) => readJson(resolve(path, "run-manifest.json")));
const waveFingerprints = waveManifests.filter(Boolean).map((manifest) => JSON.stringify({ prompt: manifest.prompt, generation: manifest.generation, context: manifest.model_context, code: manifest.code,
  runtime: manifest.model.service_health?.body?.data?.find((item) => item.id === expectedIdentity.id) }));
const sameWaveConfiguration = waveFingerprints.length === 3 && new Set(waveFingerprints).size === 1;
// The legacy server's adapter omission also invalidates the earlier full-suite
// tuned-model claims. A 13-case spot check cannot replace that lost evidence.
const fullLabel = process.env.WAVE4_FULL_REQUALIFICATION_LABEL || RUN_LABEL;
if (!/^[a-zA-Z0-9._-]+$/.test(fullLabel)) throw new Error("Invalid requalification label");
const fullSuiteRequalification = [1, 2, 3].map((n) => {
  const bank = readJson(resolve(`training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-${n}/development-question-set.json`));
  const expectedIds = bank.topics.flatMap((topic) => topic.diagnostic_evaluation.map((item) => item.id));
  const path = resolve(`training/evaluation-cycle-v2/02-wave-${n}-execution/diagnostic/${fullLabel}`);
  const fullScore = readJson(resolve(path, "scorecard.json"));
  const evidence = assessFrozenSlice({ expectedIds, results: readJson(resolve(path, "results.json")), scorecard: fullScore,
    manifest: readJson(resolve(path, "run-manifest.json")), resultsSha256: hashFile(resolve(path, "results.json")), expectedIdentity });
  return { wave: `wave-${n}`, expected: expectedIds.length, run_root: path,
    ...evidence, passed: evidence.complete && evidence.artifacts_match && evidence.runtime_verified && evidence.run_errors === 0 && fullScore?.diagnostic_gate === "passed_provisionally" };
});
const modelRows = [...waveRuns.values()].flatMap((path) => readJson(resolve(path, "results.json"))?.results || [])
  .concat(readJson(resolve(criticalRoot, "post-fix-results.json"))?.results || []).filter((item) => item.model_call_attempted);
const latencies = modelRows.map((item) => item.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
const modelLatencies = modelRows.map((item) => item.model_latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
const localRuntime = {
  model_calls_attempted: modelRows.length,
  run_errors: modelRows.filter((item) => item.selected_route === "RUN_ERROR").length,
  total_latency_min_ms: latencies[0] ?? null,
  total_latency_max_ms: latencies.at(-1) ?? null,
  total_latency_p95_ms: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null,
  model_latency_max_ms: modelLatencies.at(-1) ?? null,
  application_model_timeout_ms: 120000,
  note: "Local diagnostic timing only; not production SLO certification. Includes failed attempts and retrieval time in total latency.",
};
const appChecks = readJson(resolve(ROOT, "application-checks.json"));
const applicationPassed = Boolean(appChecks?.tests?.passed && appChecks?.syntax?.passed && appChecks?.npm_audit?.passed && appChecks?.local_application_smoke?.passed && appChecks?.visual_static_check?.passed);
const productionChecks = readJson(resolve(BASE, "production-checks.json"));
const productionDependenciesPassed = Boolean(productionChecks?.production_model_endpoint_verified && productionChecks?.production_retrieval_endpoint_verified && productionChecks?.production_secret_configuration_verified && productionChecks?.final_adapter_available_to_production_runtime && productionChecks?.clean_release_commit);
const productionLatencyPassed = Boolean(productionChecks?.latency_slo_met);
const replacementReviewReturn = readJson(resolve("training/evaluation-cycle-v2/05-training-data-repair-revision-20260901/review-return-record.json"));
const preflights = [1, 2, 3].map((wave) => readJson(resolve(`training/evaluation-cycle-v2/02-wave-${wave}-execution/preflight.json`)));
const independentReviewPassed = preflights.every((item) => item?.authorisation?.official_diagnostic_pass_fail === true);
const unseenAuthorisedAndRun = preflights.every((item) => item?.authorisation?.unseen_execution === true) && preflights.every((item) => item?.unseen_result?.status === "completed");

const blockers = [];
if (replacementReviewReturn?.status === "returned_for_revision") blockers.push("replacement_training_review_returned_for_substantive_revision");
if (!trainingLineage.every((item) => item.passed)) blockers.push("selected_adapter_training_lineage_failed_answer_in_input_audit");
if (!diagnostics.every((item) => item.passed)) blockers.push("wave4_cross_wave_diagnostics_not_all_passed");
if (!sameWaveConfiguration) blockers.push("cross_wave_runtime_prompt_or_code_evidence_incomplete_or_mismatched");
if (!fullSuiteRequalification.every((item) => item.passed)) blockers.push("full_topic_suites_require_verified_adapter_requalification");
if (!criticalPassed) blockers.push("cycle_v1_critical_regression_not_passed_on_final_adapter");
if (!applicationPassed) blockers.push("application_release_checks_not_complete");
if (!independentReviewPassed) blockers.push("independent_legal_semantic_gold_review_missing");
if (!unseenAuthorisedAndRun) blockers.push("authorised_one_shot_unseen_evaluation_missing");
if (!productionDependenciesPassed) blockers.push("production_model_retrieval_secrets_adapter_or_release_commit_not_verified");
if (!productionLatencyPassed) blockers.push("production_latency_slo_not_met_or_not_verified");

const report = {
  version: "evaluation-cycle-v2-wave4-release-gate-v4",
  training_lineage_audit:trainingLineage,
  replacement_training_review:returnReviewSummary(replacementReviewReturn),
  run_label: RUN_LABEL,
  expected_runtime: expectedIdentity,
  same_wave_configuration: sameWaveConfiguration,
  full_suite_requalification: fullSuiteRequalification,
  local_runtime: localRuntime,
  generated_at: new Date().toISOString(),
  status: blockers.length ? "blocked" : "passed",
  production_deployment_authorised: blockers.length === 0,
  unseen_accessed_by_this_script: false,
  diagnostics,
  cycle_v1_critical: { path: criticalPath, ...criticalEvidence },
  application_checks: appChecks,
  production_checks: productionChecks,
  independent_review_passed: independentReviewPassed,
  unseen_authorised_and_run: unseenAuthorisedAndRun,
  blockers,
};

function returnReviewSummary(value) {
  if (!value) return null;
  return { status:value.status, reviewed_records:value.reviewed_records, training_items_approved:value.training_items_approved,
    allocation_approved:value.allocation_approved, unseen_accessed:value.unseen_accessed };
}
writeFileSync(resolve(ROOT, "release-gate.json"), `${JSON.stringify(report, null, 2)}\n`);

const rows = diagnostics.map((item) => `| ${item.wave} | ${item.pass}/${item.expected} | ${item.critical_failures} | ${item.run_errors ?? "—"} | ${item.passed ? "PASS" : "BLOCKED"} |`).join("\n");
writeFileSync(resolve(ROOT, "RELEASE-GATE.md"), `# Wave 4 release gate\n\nStatus: **${report.status.toUpperCase()}**. Production deployment authorised: **${report.production_deployment_authorised ? "yes" : "no"}**.\n\nThis report does not read or execute sealed-unseen material.\n\n| Wave | Passed | Critical failures | Run errors | Gate |\n|---|---:|---:|---:|---|\n${rows}\n\n## Blocking conditions\n\n${blockers.map((item) => `- ${item}`).join("\n") || "- None"}\n`);
console.log(JSON.stringify({ status: report.status, production_deployment_authorised: report.production_deployment_authorised, diagnostics, blockers }, null, 2));
