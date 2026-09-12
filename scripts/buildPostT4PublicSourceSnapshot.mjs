import { cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync } from "node:fs";
import { basename,dirname,join,relative,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile,requireAbsentOutput,scanReleaseTree,writeArtifactManifest } from "./lib/finalReleasePackaging.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)),"..");
const OUTPUT_ROOT = requireAbsentOutput(process.argv[2],"Post-T4 public source snapshot");
const BUILD_ID = String(process.env.POST_T4_PUBLIC_BUILD_ID || "").trim();
if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(BUILD_ID)) throw new Error("POST_T4_PUBLIC_BUILD_ID is required and must be a safe lowercase build identifier.");

function source(path) { return resolve(PROJECT_ROOT,path); }
function destination(path) { return resolve(OUTPUT_ROOT,path); }
function assertRegular(path) {
  const absolute = source(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`Required public source is missing or unsafe: ${path}`);
  return absolute;
}
function copyFile(path,target = path) {
  const output = destination(target);
  mkdirSync(dirname(output),{ recursive:true });
  cpSync(assertRegular(path),output,{ errorOnExist:true,preserveTimestamps:false });
}
function copyTree(path,target = path) {
  const root = source(path);
  if (!existsSync(root) || !statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`Required public source directory is missing or unsafe: ${path}`);
  const visit = (current,prefix) => {
    for (const entry of readdirSync(current,{ withFileTypes:true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store") continue;
      const absolute = join(current,entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink is forbidden in public source: ${relative(PROJECT_ROOT,absolute)}`);
      if (entry.isDirectory()) visit(absolute,rel);
      else if (entry.isFile()) {
        const output = destination(`${target}/${rel}`);
        mkdirSync(dirname(output),{ recursive:true });
        cpSync(absolute,output,{ errorOnExist:true,preserveTimestamps:false });
      }
    }
  };
  visit(root,"");
}
function readJson(path) { return JSON.parse(readFileSync(assertRegular(path),"utf8")); }
function writeJson(path,value) {
  const output = destination(path);
  mkdirSync(dirname(output),{ recursive:true });
  writeFileSync(output,`${JSON.stringify(value,null,2)}\n`,{ flag:"wx",mode:0o644 });
}

mkdirSync(OUTPUT_ROOT,{ recursive:true,mode:0o755 });

for (const path of [
  ".env.example",".gitattributes","app.js","index.html","render.yaml","server.js","styles.css",
  "answering/answer-policy-v1.md","answering/PRIVATE-MATERIAL-ADMISSION.md","answering/source-priority.md",
  "ml/cache_pinned_retrieval.py","ml/embedding_server.py","ml/pinned_mlx_worker.py","ml/pinned_prompt_cache.py","ml/requirements-embedding.txt",
  "models/model-manifest.json","runtime/runtime-manifest.json",
  "scripts/bootstrapApprovedCorpus.mjs","scripts/checkProject.mjs","scripts/liveLocal.mjs","scripts/liveLogStore.mjs","scripts/mlServe.mjs","scripts/modelServe.mjs","scripts/modelServePinned.mjs","scripts/resetDemoData.mjs","scripts/runScheduledAgent.mjs","scripts/setupModels.mjs","scripts/setupRuntime.mjs","scripts/smokePinnedModelCancellation.mjs",
  "scripts/evaluationCycleV1Common.mjs","scripts/evaluationCycleV1PostFixRegression.mjs","scripts/evaluationCycleV1PostFixScore.mjs",
  "scripts/refreezeTopic161ReplacementV2Ids.mjs","scripts/verifyTopic161ReplacementV2Refreeze.mjs",
  "scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs","scripts/evaluationCycleV2PostTrainingVisibleQualificationV1.mjs","scripts/evaluationCycleV2Wave1Run.mjs","scripts/evaluationCycleV2Wave1Score.mjs",
  "scripts/installQualificationWorkerLaunchd.mjs","scripts/isolatedPythonLauncher.py","scripts/processArgvDarwin.py","scripts/pythonEnvironmentFingerprint.py","scripts/qualificationPersonalEvidence.mjs","scripts/qualificationWorker.mjs","scripts/qualificationWorkerLaunchdEntrypoint.mjs","scripts/qualificationWorkerStatus.mjs","scripts/runLiveQuestionSet.mjs","scripts/t4PostTrainingDevelopmentEval.mjs","scripts/createPythonEnvironmentManifest.mjs","scripts/createRuntimeArtifactManifests.mjs",
  "scripts/lib/postTrainingVisibleQualificationV1.mjs","scripts/lib/releaseContentChecks.mjs","scripts/lib/releaseEvidence.mjs","scripts/lib/servedResponseReceipt.mjs","scripts/lib/temporalScoring.mjs",
  "test/auth-routes.test.mjs","test/backend.test.mjs","test/chat-rag.test.mjs","test/custodian-context.test.mjs","test/evidence-excerpt.test.mjs","test/live-demo-repair.test.mjs","test/local-model-identity.test.mjs","test/model-context.test.mjs","test/pinned-model-server.test.mjs","test/pinned-retrieval-identity.test.mjs","test/pinned_prompt_cache_test.py","test/qualification-active-reliability.test.mjs","test/qualification-review-calibration.test.mjs","test/readiness.test.mjs","test/release-content.test.mjs","test/release-evidence.test.mjs","test/temporal-scoring.test.mjs","test/fixtures/pinned-worker.mjs",
  "tools/visual-baseline.json","tools/visual-regression.mjs","config/qualification-worker.json","docs/manual-live-owner-checks.md","docs/post-t4-qualification-worker.md","evaluation/qualification-review-calibration-v2.json","approved-materials/approved-corpus-manifest.json",
]) copyFile(path);
for (const path of ["server","scripts/lib/qualification-worker"]) copyTree(path);

const historicalEvidence = String(process.env.POST_T4_PUBLIC_HISTORICAL_EVIDENCE_DIR || "").trim();
if (historicalEvidence) {
  const root = resolve(historicalEvidence);
  if (!existsSync(root) || !statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Historical aggregate evidence directory is missing or unsafe.");
  for (const entry of readdirSync(root,{ withFileTypes:true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "POST-T4-STATUS.json") continue;
    const output = destination(`release-evidence/${entry.name}`);
    mkdirSync(dirname(output),{ recursive:true });
    cpSync(join(root,entry.name),output,{ errorOnExist:true,preserveTimestamps:false });
  }
}

const packageSource = readJson("package.json");
const packageJson = {
  name:"pensiondashboard-model",version:packageSource.version,private:true,
  description:"Fail-closed UK pensions dashboard source with the post-T4 qualification controller. This is not a live-qualified model release.",
  type:"module",main:"server.js",
  scripts:{
    start:"node server.js","live:local":"node scripts/liveLocal.mjs","live:questions":"node scripts/runLiveQuestionSet.mjs",
    "qualification:plan":"node scripts/qualificationWorker.mjs --plan","qualification:preflight":"node scripts/qualificationWorker.mjs --preflight","qualification:run":"node scripts/qualificationWorker.mjs","qualification:status":"node scripts/qualificationWorkerStatus.mjs","qualification:install-launchd":"node scripts/installQualificationWorkerLaunchd.mjs","qualification:test":"node --test --test-concurrency=1 scripts/lib/qualification-worker/__tests__/*.test.mjs",
    "setup:models":"node scripts/setupModels.mjs","setup:runtime":"node scripts/setupRuntime.mjs","model:serve":"node scripts/modelServe.mjs","model:serve:pinned":"node scripts/modelServePinned.mjs","retrieval:serve":"node scripts/mlServe.mjs","materials:bootstrap-approved-corpus":"node scripts/bootstrapApprovedCorpus.mjs","reset:demo-data":"node scripts/resetDemoData.mjs",
    check:"node scripts/checkProject.mjs",test:"PENSIONS_DB_PATH=/private/tmp/pensions-dashboard-public-test.sqlite node --test --test-concurrency=1 test/*.test.mjs","visual:check":"node tools/visual-regression.mjs",
  },
  dependencies:packageSource.dependencies,
};
writeJson("package.json",packageJson);
const lock = readJson("package-lock.json");
lock.name = packageJson.name;
lock.version = packageJson.version;
if (lock.packages?.[""]) {
  lock.packages[""].name = packageJson.name;
  lock.packages[""].version = packageJson.version;
  lock.packages[""].dependencies = packageJson.dependencies;
}
writeJson("package-lock.json",lock);

writeFileSync(destination(".gitignore"),`# Secrets and local configuration
.env
.env.*
!.env.example

# Dependencies and local runtimes
node_modules/
.training-venv/
.retrieval-venv/
.venv/
runtime/bin/
runtime/downloads/
runtime/runtime-lock.json
runtime/qualification-allowed-contexts/

# Base models, adapters and raw approved corpus
models/*
!models/model-manifest.json
adapters/
approved-materials/index/
approved-materials/originals/
approved-materials/structured-facts/

# Evaluation/training inputs and local evidence
training/
evaluation/
!evaluation/
evaluation/*
!evaluation/qualification-review-calibration-v2.json
training-data/private/
Log/
Logging/
data/
uploads/
tmp/
temp/
*.log
*.sqlite*
*.db*

# Qualification secrets and holdouts
**/controller-integrity-private.pem
**/runtime-qualification-context.key
**/runtime-response-signing-private.pem
**/gold-answers.sealed.json
**/unseen-question-set.json
**/unseen/

# Caches
__pycache__/
*.py[cod]
.DS_Store
`,{ flag:"wx",mode:0o644 });

const selection = readJson("training/evaluation-cycle-v2/30-cumulative-legal-training-20260902/checkpoint-selection.json");
const workerState = readJson("Log/qualification-worker/worker-state.json");
const repair = readJson("Log/2026-09-03/live-round-53-repair/results.json");
const replacementManifest = readJson("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/frozen-suite-manifest.json");
const replacementReport = readJson("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/ID-REFREEZE-REPORT.json");
const replacementVerification = readJson("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/INDEPENDENT-REFREEZE-VERIFICATION.json");
const qualificationRoute = ["VERIFY_RUNTIME","T4_TARGETED_REGRESSION","TOPIC161_ORIGINAL_DEVELOPMENT","LIVE50_FULL_REGRESSION","RELIABILITY_GATE","VISIBLE_CRITICAL4","VISIBLE_FULL69","VISIBLE_TOPIC161_REPLACEMENT_V2","VISIBLE_FROZEN13","CANDIDATE_FREEZE"];
const repairedIds = repair.items?.filter((item) => item.ok === true).map((item) => item.id).sort() || [];
if (
  selection.selected_iteration !== 104 ||
  selection.adapter_sha256 !== "b370306a3078abd79af14e14c4690a4f394800f1096592ca6528e213cf5a6337" ||
  JSON.stringify(repairedIds) !== JSON.stringify(["L19","L23","L26","L38","L43"]) ||
  replacementManifest.state !== "REPLACEMENT_QUALIFICATION_REFROZEN_ID_ONLY" ||
  replacementManifest.item_count !== 161 ||
  replacementManifest.unique_item_ids !== 161 ||
  replacementManifest.id_remediation?.changed_occurrences !== 25 ||
  replacementManifest.id_remediation?.substantive_content_equal !== true ||
  replacementReport.unique_ids !== 161 ||
  replacementReport.question_gold_position_aligned !== true ||
  replacementReport.substantive_content_equal !== true ||
  replacementVerification.passed !== true ||
  replacementVerification.unique_ids !== 161 ||
  replacementVerification.substantive_content_equal !== true ||
  replacementVerification.manifest_sha256 !== hashFile(source("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/frozen-suite-manifest.json")) ||
  workerState.version !== "qualification-worker-state-v1" ||
  !/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(workerState.run_id || "")) ||
  ![...qualificationRoute,"READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION","BLOCKED_NOT_QUALIFIED"].includes(workerState.state) ||
  !Array.isArray(workerState.completed_stages) ||
  workerState.completed_stages.some((stage,index) => stage !== qualificationRoute[index])
) {
  throw new Error("Post-T4 status inputs do not match the fail-closed public status contract.");
}
const completedStages = workerState.completed_stages;
const activeOrLastStage = qualificationRoute.includes(workerState.state) ? workerState.state : (completedStages.at(-1) || "VERIFY_RUNTIME");
const currentGate = workerState.stage_results?.[activeOrLastStage] || null;
const currentCalibrationPath = `Log/qualification-worker/runs/${workerState.run_id}/reports/evaluator-calibration.json`;
const currentCalibration = existsSync(source(currentCalibrationPath)) ? readJson(currentCalibrationPath) : null;
writeJson("release-evidence/POST-T4-STATUS.json",{
  schema_version:3,status_as_at:new Date().toISOString(),state:workerState.state,live_qualified:false,production_or_public_deployment_authorised:false,
  training:{ completed:true,model_version:selection.model_version,selected_iteration:selection.selected_iteration,forbidden_iteration:312,selected_validation_loss:selection.selected_validation_loss,selected_adapter_sha256:selection.adapter_sha256 },
  product_repair:{ live50_round53_regressions_repaired:repairedIds,isolated_regression_verified:true,full_live50_rerun_completed:completedStages.includes("LIVE50_FULL_REGRESSION") },
  replacement_v2_refreeze:{ completed:true,id_only:true,changed_occurrences:25,item_count:161,unique_ids:161,substantive_content_equal:true,question_gold_position_aligned:true,independently_verified:true },
  worker:{ implemented:true,fixed_route:qualificationRoute,minimum_score_floor:70,hard_factual_gates_required:true,independent_codex_reviews_required:2,evaluator_calibration:{version:"qualification-review-calibration-v2",supported_cases:8,deliberate_negative_cases:8,false_approvals_allowed:0,false_rejections_allowed:0,completed:currentCalibration?.passed === true},active_reliability:{sustained_requests:15,concurrent_requests:4,repaired_live_journeys:5,controlled_model_worker_outage:true,cancellation_and_recovery:true},source_snapshot_test_receipt:null,source_snapshot_test_evidence:"unavailable; this build does not infer test counts from environment variables" },
  formal_post_repair_gates_completed:completedStages,
  latest_run:{ run_id:workerState.run_id,stage:activeOrLastStage,runtime_identity_completed:completedStages.includes("VERIFY_RUNTIME"),reviewer_calibration_cases_run:currentCalibration ? 16 : 0,development_stages_completed:completedStages.filter((stage) => ["T4_TARGETED_REGRESSION","TOPIC161_ORIGINAL_DEVELOPMENT","LIVE50_FULL_REGRESSION","RELIABILITY_GATE"].includes(stage)),visible_qualification_stages_completed:completedStages.filter((stage) => stage.startsWith("VISIBLE_")) },
  blocker:workerState.state === "BLOCKED_NOT_QUALIFIED" ? { stage:activeOrLastStage,detail:String(workerState.blocker || currentGate?.blockers?.join("; ") || "blocked without a recorded detail"),automatic_rerun_authorised:false } : null,
  sealed_unseen:{ accessed:false,run:false,scored:false },
  next_step:String(workerState.next_authorised_action || "Continue only through the controller's declared route; sealed unseen remains separately authorised."),
  source_evidence_sha256:{ checkpoint_selection:hashFile(source("training/evaluation-cycle-v2/30-cumulative-legal-training-20260902/checkpoint-selection.json")),current_worker_state:hashFile(source("Log/qualification-worker/worker-state.json")),isolated_repair_results:hashFile(source("Log/2026-09-03/live-round-53-repair/results.json")),replacement_manifest:hashFile(source("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/frozen-suite-manifest.json")),replacement_refreeze_report:hashFile(source("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/ID-REFREEZE-REPORT.json")),replacement_independent_verification:hashFile(source("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/INDEPENDENT-REFREEZE-VERIFICATION.json")) },
});

writeFileSync(destination("README.md"),`# Pensiondashboard-model

This is the current fail-closed source snapshot of the UK pensions dashboard and its post-T4 qualification controller.

**It is not a live-qualified model release.** T4 training completed and checkpoint 104 was selected. Five Live-50 Round-53 product-path regressions were repaired. The 25 repeated replacement-v2 IDs were corrected under an ID-only owner authorization and independently refrozen with 161 unique IDs; substantive content was unchanged. The latest recorded controller state is \`${workerState.state}\`, with ${completedStages.length} of ${qualificationRoute.length} ordered gates complete. The sealed unseen set has not been opened or run.

## Current gate

| Item | Status |
| --- | --- |
| T4 training | Complete |
| Selected checkpoint | Iteration 104 |
| Product-path repair | Complete and regression-tested |
| Replacement-v2 ID-only refreeze | Complete and independently verified |
| Runtime verification | ${completedStages.includes("VERIFY_RUNTIME") ? "Passed in the latest recorded run" : "Not passed in the latest recorded run"} |
| Post-repair development evaluation | ${completedStages.includes("RELIABILITY_GATE") ? "Complete" : "Incomplete"} |
| Visible qualification | ${completedStages.includes("VISIBLE_FROZEN13") ? "Complete" : "Incomplete"} |
| Live-qualified release | No |
| Sealed unseen | Closed and not accessed |

The controller route is:

\`VERIFY_RUNTIME → T4_TARGETED_REGRESSION → TOPIC161_ORIGINAL_DEVELOPMENT → LIVE50_FULL_REGRESSION → RELIABILITY_GATE → VISIBLE_CRITICAL4 → VISIBLE_FULL69 → VISIBLE_TOPIC161_REPLACEMENT_V2 → VISIBLE_FROZEN13 → CANDIDATE_FREEZE\`

A score of 70 is a floor. Every factual, citation-entailment, jurisdiction, safety, outcome, and personal-fact gate must pass, together with two independent isolated Codex reviews. “Fact checked” means checked against the pinned evidence supplied for that run; it is not a claim of universal or error-free truth.

The worker first calibrates both isolated reviewers against eight supported and eight deliberately incorrect synthetic cases. It then records immutable raw response bytes, server signatures, runtime identities, sources, citations, attempts, retries, dual-review receipts, failure classifications, stage gates, and hash manifests. Its reliability gate performs 15 sequential and four concurrent product-path requests, five fixed repaired journeys, one controlled model-worker outage, cancellation, restart recovery, and user/session separation checks. Training, legal-gold changes, sealed unseen, release, and Git push remain outside worker authority.

The sealed-unseen custodian is a separate owner-controlled process. It uses a separate one-use HMAC capability and nonce ledger and sends each protected question through the same canonical \`/chat\` route. The qualification worker never receives the custodian key. The custodian runner exists for later owner authorization; this snapshot does not authorize or perform an unseen run.

## Public snapshot boundary

Included: application source and tests, qualification-controller source, its machine-bound configuration, approved-corpus manifest metadata, and aggregate historical/current status evidence.

Excluded: model weights, adapters, raw corpus text, private training/evaluation inputs, databases, logs, credentials, sealed unseen questions, sealed unseen gold, and per-case unseen output.

The checked-in qualification configuration records the local candidate identity and fails closed on another machine until the omitted local artifacts and exact pinned dependencies are restored.

## Install and verify

\`\`\`bash
npm install
cp .env.example .env
npm run check
npm test
npm run qualification:test
\`\`\`

\`npm run qualification:preflight\` is expected to fail in this public snapshot because protected and machine-local candidate inputs are deliberately excluded. The same preflight passes on the controlled owner machine with all 41 pinned inputs present.

Development serving is not a qualification pass:

\`\`\`bash
npm run model:serve:pinned
npm run retrieval:serve
npm start
\`\`\`

Use \`docs/manual-live-owner-checks.md\` for the development-versus-frozen-smoke boundary, evidence checklist and failure route.

The assistant is read-only and provides information and routing support. It cannot transfer money, change contributions, submit forms, provide regulated financial advice, or replace a solicitor, regulated adviser, scheme administrator, HMRC, a regulator, or an ombudsman.
`,{ flag:"wx",mode:0o644 });

const publicChatTest = destination("test/chat-rag.test.mjs");
let chatTestSource = readFileSync(publicChatTest,"utf8");
const priorImport = 'import { mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from "node:fs";';
const publicImport = 'import { existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from "node:fs";';
const priorTest = 'test("all 69 visible fixtures have an exact scenario-only projection", () => {';
const publicTest = 'test("all 69 visible fixtures have an exact scenario-only projection", { skip:!existsSync(new URL("../training/gold-answer-review.json",import.meta.url)) }, () => {';
const priorCaseTreatmentTest = 'test("case-treatment graph is conservative, valid and annotates later treatment", () => {';
const publicCaseTreatmentTest = 'test("case-treatment graph is conservative, valid and annotates later treatment", { skip:!existsSync(new URL("../approved-materials/index/case-treatment-graph.json",import.meta.url)) }, () => {';
if (!chatTestSource.includes(priorImport) || !chatTestSource.includes(priorTest) || !chatTestSource.includes(priorCaseTreatmentTest)) throw new Error("Public chat-test redaction hook did not match the current source.");
chatTestSource = chatTestSource.replace(priorImport,publicImport).replace(priorTest,publicTest).replace(priorCaseTreatmentTest,publicCaseTreatmentTest);
writeFileSync(publicChatTest,chatTestSource);

scanReleaseTree(OUTPUT_ROOT);
writeArtifactManifest(OUTPUT_ROOT,{
  manifest_type:"pensiondashboard-model-post-t4-fail-closed-source-v2",build_id:BUILD_ID,adapter_destinations:[],
  source_artifact_hashes:{ checkpoint_selection:hashFile(source("training/evaluation-cycle-v2/30-cumulative-legal-training-20260902/checkpoint-selection.json")),current_worker_state:hashFile(source("Log/qualification-worker/worker-state.json")),isolated_repair_results:hashFile(source("Log/2026-09-03/live-round-53-repair/results.json")),replacement_manifest:hashFile(source("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/frozen-suite-manifest.json")),replacement_refreeze_report:hashFile(source("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/ID-REFREEZE-REPORT.json")),replacement_independent_verification:hashFile(source("training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/INDEPENDENT-REFREEZE-VERIFICATION.json")) },
});

process.stdout.write(`${JSON.stringify({ status:"built",output_root:OUTPUT_ROOT,build_id:BUILD_ID,file_count:scanReleaseTree(OUTPUT_ROOT).length },null,2)}\n`);
