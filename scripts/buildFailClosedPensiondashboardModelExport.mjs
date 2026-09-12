import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  assertOutputSeparated,
  copyExact,
  hashFile,
  readJson,
  requireAbsentOutput,
  requireBuildId,
  requireExistingDirectory,
  requireExistingFile,
  scanReleaseTree,
  writeArtifactManifest,
  writeCanonicalJson,
} from "./lib/finalReleasePackaging.mjs";

export const FAIL_CLOSED_EXPORT_CONFIRMATION = "build_fail_closed_pensiondashboard_model_export";

if (process.argv.includes("--help")) {
  process.stdout.write(`Build a fail-closed, Git-metadata-free application snapshot for the public Pensiondashboard-model repository after a real visible-qualification failure.\n\nRequired environment:\n  FAIL_CLOSED_EXPORT_BUILD_ID\n  FAIL_CLOSED_EXPORT_PROJECT_ROOT (optional; defaults to current directory)\n  FAIL_CLOSED_EXPORT_VISIBLE_CLOSED_RECORD\n  FAIL_CLOSED_EXPORT_VISIBLE_ORCHESTRATION\n  FAIL_CLOSED_EXPORT_VISIBLE_GATE_TOPIC161\n  FAIL_CLOSED_EXPORT_APPROVED_CORPUS_MANIFEST\n  FAIL_CLOSED_EXPORT_OUTPUT_DIR (must not exist)\n\nWithout FAIL_CLOSED_EXPORT_BUILD_CONFIRMATION=${FAIL_CLOSED_EXPORT_CONFIRMATION}, the script validates only and writes nothing. This builder never initialises Git, changes a remote, commits or pushes. It never includes adapter weights, the base model, sealed unseen material, or a live-qualified label.\n`);
  process.exit(0);
}

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const projectRoot = requireExistingDirectory(process.env.FAIL_CLOSED_EXPORT_PROJECT_ROOT || resolve("."), "Application project root");
const buildId = requireBuildId(required("FAIL_CLOSED_EXPORT_BUILD_ID"));
const closedRecordPath = requireExistingFile(required("FAIL_CLOSED_EXPORT_VISIBLE_CLOSED_RECORD"), "Visible qualification closed record");
const orchestrationPath = requireExistingFile(required("FAIL_CLOSED_EXPORT_VISIBLE_ORCHESTRATION"), "Visible qualification orchestration manifest");
const topic161GatePath = requireExistingFile(required("FAIL_CLOSED_EXPORT_VISIBLE_GATE_TOPIC161"), "Visible topic161 gate");
const corpusManifestPath = requireExistingFile(required("FAIL_CLOSED_EXPORT_APPROVED_CORPUS_MANIFEST"), "Approved corpus manifest metadata");
const outputRoot = requireAbsentOutput(required("FAIL_CLOSED_EXPORT_OUTPUT_DIR"), "Fail-closed GitHub export directory");
assertOutputSeparated(outputRoot, [resolve(projectRoot, "server"), resolve(projectRoot, "adapters")], "Fail-closed GitHub export");

const closed = readJson(closedRecordPath, "Visible qualification closed record");
if (closed.version !== "post-training-visible-qualification-v1-closed-record-v1" || closed.passed !== false || closed.live_qualified !== false || closed.release_authorised !== false || closed.sealed_unseen_accessed !== false || closed.sealed_unseen_executed !== false || closed.stages?.topic161?.passed !== false) {
  throw new Error("Closed record is not an honest visible-qualification failure.");
}
const orchestration = readJson(orchestrationPath, "Visible qualification orchestration manifest");
if (orchestration.run_label !== closed.run_label || orchestration.status !== "failed_use_new_run_label" || orchestration.scope?.release_authorised !== false || orchestration.scope?.sealed_unseen_accessed !== false) {
  throw new Error("Orchestration manifest is not the failed visible run bound by the closed record.");
}
const topic161 = readJson(topic161GatePath, "Visible topic161 gate");
if (topic161.run_label !== closed.run_label || topic161.stage !== "topic161" || topic161.passed !== false || topic161.release_authorised !== false || topic161.sealed_unseen_accessed !== false) {
  throw new Error("topic161 gate is not the failed visible gate bound by the closed record.");
}
const corpus = readJson(corpusManifestPath, "Approved corpus manifest metadata");
if (corpus.approval_status !== "approved" || !Array.isArray(corpus.documents) || corpus.documents.length < 1) {
  throw new Error("Approved corpus manifest metadata is not approved and non-empty.");
}

const closedSha = hashFile(closedRecordPath);
const orchestrationSha = hashFile(orchestrationPath);
const topic161Sha = hashFile(topic161GatePath);
const corpusSha = hashFile(corpusManifestPath);

if (String(process.env.FAIL_CLOSED_EXPORT_BUILD_CONFIRMATION || "") !== FAIL_CLOSED_EXPORT_CONFIRMATION) {
  process.stdout.write(`${JSON.stringify({
    status: "validated_dry_run_no_files_written",
    required_confirmation: FAIL_CLOSED_EXPORT_CONFIRMATION,
    output_root: outputRoot,
    build_id: buildId,
    visible_qualification_passed: false,
    live_qualified: false,
    sealed_unseen_executed: false,
    closed_record_sha256: closedSha,
    topic161_gate_sha256: topic161Sha,
  }, null, 2)}\n`);
  process.exit(0);
}

const partialRoot = resolve(dirname(outputRoot), `.${basename(outputRoot)}.partial-${process.pid}`);
requireAbsentOutput(partialRoot, "Fail-closed export partial directory");
mkdirSync(partialRoot, { recursive: true, mode: 0o755 });

const exactProjectFiles = [
  ".env.example",
  ".gitattributes",
  "app.js",
  "index.html",
  "render.yaml",
  "models/model-manifest.json",
  "runtime/runtime-manifest.json",
  "server.js",
  "styles.css",
  "ml/embedding_server.py",
  "ml/cache_pinned_retrieval.py",
  "ml/pinned_mlx_worker.py",
  "ml/pinned_prompt_cache.py",
  "ml/requirements-embedding.txt",
  "answering/answer-policy-v1.md",
  "answering/PRIVATE-MATERIAL-ADMISSION.md",
  "answering/source-priority.md",
  "tools/visual-baseline.json",
  "tools/visual-regression.mjs",
  "scripts/bootstrapApprovedCorpus.mjs",
  "scripts/checkProject.mjs",
  "scripts/liveLocal.mjs",
  "scripts/mlServe.mjs",
  "scripts/modelServe.mjs",
  "scripts/modelServePinned.mjs",
  "scripts/resetDemoData.mjs",
  "scripts/runScheduledAgent.mjs",
  "scripts/setupModels.mjs",
  "scripts/setupRuntime.mjs",
  "scripts/smokePinnedModelCancellation.mjs",
  "scripts/lib/releaseContentChecks.mjs",
  "scripts/lib/releaseEvidence.mjs",
  "scripts/lib/temporalScoring.mjs",
];

const listFiles = (root, prefix = "") => {
  const rows = [];
  const visit = (directory, relativePrefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is forbidden in application source: ${absolute}`);
      if (entry.isDirectory()) visit(absolute, rel);
      else if (entry.isFile()) rows.push(`${prefix}${rel}`);
    }
  };
  visit(root, "");
  return rows;
};

for (const rel of listFiles(resolve(projectRoot, "server"), "server/")) exactProjectFiles.push(rel);

const applicationTests = [
  "test/auth-routes.test.mjs",
  "test/backend.test.mjs",
  "test/chat-rag.test.mjs",
  "test/evidence-excerpt.test.mjs",
  "test/local-model-identity.test.mjs",
  "test/model-context.test.mjs",
  "test/pinned-model-server.test.mjs",
  "test/pinned_prompt_cache_test.py",
  "test/readiness.test.mjs",
  "test/release-content.test.mjs",
  "test/release-evidence.test.mjs",
  "test/temporal-scoring.test.mjs",
  "test/fixtures/pinned-worker.mjs",
];
exactProjectFiles.push(...applicationTests);
for (const rel of [...new Set(exactProjectFiles)].sort()) copyExact(resolve(projectRoot, rel), partialRoot, rel);

const originalPackage = readJson(resolve(projectRoot, "package.json"), "Application package.json");
const curatedPackage = {
  name: "pensiondashboard-model",
  version: originalPackage.version,
  private: true,
  description: "Fail-closed UK pensions dashboard application snapshot. Visible qualification did not pass; this is not a live-qualified model release.",
  type: "module",
  main: "server.js",
  scripts: {
    start: "node server.js",
    "live:local": "node scripts/liveLocal.mjs",
    "setup:models": "node scripts/setupModels.mjs",
    "setup:runtime": "node scripts/setupRuntime.mjs",
    "model:serve": "node scripts/modelServe.mjs",
    "model:serve:pinned": "node scripts/modelServePinned.mjs",
    "retrieval:serve": "node scripts/mlServe.mjs",
    "materials:bootstrap-approved-corpus": "node scripts/bootstrapApprovedCorpus.mjs",
    "reset:demo-data": "node scripts/resetDemoData.mjs",
    check: "node scripts/checkProject.mjs",
    test: "PENSIONS_DB_PATH=/private/tmp/pensions-dashboard-test.sqlite node --test --test-concurrency=1 test/*.test.mjs",
    "visual:check": "node tools/visual-regression.mjs",
  },
  dependencies: originalPackage.dependencies,
};
writeCanonicalJson(resolve(partialRoot, "package.json"), curatedPackage);
const curatedLock = structuredClone(readJson(resolve(projectRoot, "package-lock.json"), "Application package-lock.json"));
curatedLock.name = curatedPackage.name;
curatedLock.version = curatedPackage.version;
if (curatedLock.packages?.[""]) {
  curatedLock.packages[""].name = curatedPackage.name;
  curatedLock.packages[""].version = curatedPackage.version;
  curatedLock.packages[""].dependencies = curatedPackage.dependencies;
}
writeCanonicalJson(resolve(partialRoot, "package-lock.json"), curatedLock);

const gitignore = `# Secrets and local configuration
.env
.env.*
!.env.example

# Dependencies and runtimes
node_modules/
.training-venv/
.venv/
runtime/bin/
runtime/downloads/

# Base models, adapters, and raw approved corpus
models/*
!models/model-manifest.json
adapters/
approved-materials/index/
approved-materials/originals/
approved-materials/structured-facts/

# Private/protected data and local state
training-data/private/
training/evaluation-cycle-v1/04-unseen/
**/gold-answers.sealed.json
**/unseen-question-set.json
**/unseen/
data/
uploads/
Logging/
*.log
*.sqlite*
*.db*

# Caches
__pycache__/
*.py[cod]
.DS_Store
`;
writeFileSync(resolve(partialRoot, ".gitignore"), gitignore, { flag: "wx" });

copyExact(corpusManifestPath, partialRoot, "approved-materials/approved-corpus-manifest.json");
copyExact(closedRecordPath, partialRoot, "release-evidence/VISIBLE-QUALIFICATION-CLOSED.json");
copyExact(orchestrationPath, partialRoot, "release-evidence/visible-qualification-orchestration-manifest.json");
copyExact(topic161GatePath, partialRoot, "release-evidence/visible-qualification-gate-topic161.json");
for (const [envName, dest] of [
  ["FAIL_CLOSED_EXPORT_VISIBLE_GATE_CRITICAL4", "release-evidence/visible-qualification-gate-critical4.json"],
  ["FAIL_CLOSED_EXPORT_VISIBLE_GATE_FULL69", "release-evidence/visible-qualification-gate-full69.json"],
]) {
  const extra = String(process.env[envName] || "").trim();
  if (extra) copyExact(requireExistingFile(extra, envName), partialRoot, dest);
}

const summary = {
  schema_version: 1,
  build_id: buildId,
  scope: "fail-closed public application snapshot",
  live_qualified: false,
  production_or_public_deployment_authorised: false,
  visible_qualification_passed: false,
  sealed_unseen_executed: false,
  legal_boundary: "Information and routing support only; not legal advice or regulated financial advice.",
  model_identity_hashes_only: {
    model_id: closed.model_id,
    checkpoint_selection_sha256: closed.checkpoint_selection_sha256,
    adapter_sha256: closed.adapter_sha256,
    note: "Adapter and 4.6 GB base-model weights are deliberately excluded from this public snapshot.",
  },
  canonical_artifacts: {
    visible_qualification_closed_sha256: closedSha,
    visible_qualification_orchestration_sha256: orchestrationSha,
    visible_qualification_gate_topic161_sha256: topic161Sha,
    approved_corpus_manifest_sha256: corpusSha,
  },
  outcome: {
    run_label: closed.run_label,
    critical4_passed: closed.stages.critical4.passed === true,
    full69_passed: closed.stages.full69.passed === true,
    topic161_passed: false,
    topic161_wave_pass_rates: {
      "wave-1": closed.stages.topic161.waves["wave-1"].pass_rate,
      "wave-2": closed.stages.topic161.waves["wave-2"].pass_rate,
      "wave-3": closed.stages.topic161.waves["wave-3"].pass_rate,
    },
    approved_corpus_document_count: corpus.documents.length,
  },
};
writeCanonicalJson(resolve(partialRoot, "release-evidence/QUALIFICATION-SUMMARY.json"), summary);

const readme = `# Pensiondashboard-model

Fail-closed public snapshot of the pensions dashboard application.

**This repository is not a live-qualified model release.** Visible development qualification run \`20260902-recovery-step130-v4\` failed at the 161-case topic gate. The sealed unseen set was not opened and was not executed. \`npm run live:local\` remains refused until a later run actually passes the authorised gates.

## What passed and what failed

| Stage | Result |
| --- | --- |
| critical4 | passed 4/4 |
| full69 consumer / adversarial / advanced-law suites | passed 69/69 |
| topic161 Wave 1 | failed 36/52 (69.2%), 2 critical, 2 run errors |
| topic161 Wave 2 | failed 33/68 (48.5%), 18 critical, 14 run errors |
| topic161 Wave 3 | failed 20/41 (48.8%), 13 critical, 3 run errors |
| frozen13 / final visible gate | not reached |
| sealed unseen | not run |
| owner-local live approval | not issued |

Hashes for the closed record and failed topic161 gate are in \`release-evidence/QUALIFICATION-SUMMARY.json\`. Thresholds were not lowered.

## Included and deliberately excluded

Included: runnable application source, application tests, fail-closed Render configuration, approved-corpus *manifest metadata*, and the visible-qualification failure evidence.

Excluded: the 4.6 GB Qwen3-8B-4bit base model, LoRA adapter weights, raw approved-corpus text, private training exports, databases, logs, secrets, sealed unseen questions/gold answers, and all per-case unseen output.

Public hosting on Render's free tier cannot serve the local 4.7 GB model. The checked-in \`render.yaml\` stays fail-closed and expects independently provisioned model, embedding, storage and scanning endpoints.

## Local development (not a qualification pass)

On an Apple Silicon Mac, after installing Node.js 22+ and Python 3:

\`\`\`bash
npm install
cp .env.example .env
npm run check
npm test
\`\`\`

The owner-local launcher will refuse an unapproved default release. That is intentional. Development serving uses a separately downloaded base model and a locally retained adapter, then:

\`\`\`bash
npm run model:serve:pinned
npm run retrieval:serve
npm start
\`\`\`

Open \`http://127.0.0.1:3000\`. Answers from this path are development output only.

## Safety and legal boundary

The assistant is read-only. It must abstain or hand off when evidence is missing, conflicting or outside scope. It cannot transfer money, change contributions, submit forms or provide regulated advice. Output is general information and routing support, not a substitute for a solicitor, regulated financial adviser, scheme administrator, HMRC or the relevant pensions regulator/ombudsman.
`;
writeFileSync(resolve(partialRoot, "README.md"), readme, { flag: "wx" });

writeArtifactManifest(partialRoot, {
  manifest_type: "pensiondashboard-model-fail-closed-github-export-v1",
  build_id: buildId,
  source_artifact_hashes: summary.canonical_artifacts,
  adapter_destinations: [],
});
scanReleaseTree(partialRoot, { adapterDestinations: [] });
renameSync(partialRoot, outputRoot);

process.stdout.write(`${JSON.stringify({
  status: "fail_closed_export_built_no_git_actions_performed",
  output_root: outputRoot,
  build_id: buildId,
  files: scanReleaseTree(outputRoot, { adapterDestinations: [] }).length,
  visible_qualification_passed: false,
  live_qualified: false,
  sealed_unseen_executed: false,
  closed_record_sha256: closedSha,
  topic161_gate_sha256: topic161Sha,
}, null, 2)}\n`);
