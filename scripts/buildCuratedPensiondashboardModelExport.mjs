import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  CURATED_EXPORT_CONFIRMATION,
  assertOutputSeparated,
  artifactRecord,
  copyExact,
  hashFile,
  portableRuntimeArtifacts,
  readJson,
  requireAbsentOutput,
  requireBuildId,
  requireExistingDirectory,
  requireExistingFile,
  scanReleaseTree,
  validateCheckpointArtifacts,
  validateLiveSmoke,
  validateLocalRelease,
  validateUnseenAggregate,
  validateVisibleGate,
  writeArtifactManifest,
  writeCanonicalJson,
} from "./lib/finalReleasePackaging.mjs";

if (process.argv.includes("--help")) {
  process.stdout.write(`Build a fail-closed, Git-metadata-free export for the new Pensiondashboard-model repository.\n\nRequired environment:\n  CURATED_EXPORT_BUILD_ID\n  CURATED_EXPORT_PROJECT_ROOT (optional; defaults to current directory)\n  CURATED_EXPORT_TRAINING_RUN_MANIFEST\n  CURATED_EXPORT_CHECKPOINT_SELECTION\n  CURATED_EXPORT_ADAPTER_ROOT\n  CURATED_EXPORT_VISIBLE_DATA_APPROVAL\n  CURATED_EXPORT_VISIBLE_GATE\n  CURATED_EXPORT_UNSEEN_AGGREGATE\n  CURATED_EXPORT_LOCAL_RELEASE_MANIFEST\n  CURATED_EXPORT_LIVE_SMOKE_EVIDENCE\n  CURATED_EXPORT_APPROVED_CORPUS_MANIFEST\n  CURATED_EXPORT_OUTPUT_DIR (must not exist)\n\nWithout CURATED_EXPORT_BUILD_CONFIRMATION=${CURATED_EXPORT_CONFIRMATION}, the script validates only and writes nothing. This builder never initializes Git, changes a remote, commits or pushes.\n`);
  process.exit(0);
}

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const projectRoot = requireExistingDirectory(process.env.CURATED_EXPORT_PROJECT_ROOT || resolve("."), "Application project root");
const buildId = requireBuildId(required("CURATED_EXPORT_BUILD_ID"));
const trainingManifestPath = requireExistingFile(required("CURATED_EXPORT_TRAINING_RUN_MANIFEST"), "Training-run manifest");
const checkpointSelectionPath = requireExistingFile(required("CURATED_EXPORT_CHECKPOINT_SELECTION"), "Checkpoint selection");
const adapterRoot = requireExistingDirectory(required("CURATED_EXPORT_ADAPTER_ROOT"), "Selected adapter root");
const qualificationApprovalPath = requireExistingFile(required("CURATED_EXPORT_VISIBLE_DATA_APPROVAL"), "Visible data/split approval");
const visibleGatePath = requireExistingFile(required("CURATED_EXPORT_VISIBLE_GATE"), "Visible qualification final gate");
const unseenAggregatePath = requireExistingFile(required("CURATED_EXPORT_UNSEEN_AGGREGATE"), "Sealed unseen aggregate");
const localReleasePath = requireExistingFile(required("CURATED_EXPORT_LOCAL_RELEASE_MANIFEST"), "Owner-local release manifest");
const liveSmokePath = requireExistingFile(required("CURATED_EXPORT_LIVE_SMOKE_EVIDENCE"), "Owner-local live smoke evidence");
const corpusManifestPath = requireExistingFile(required("CURATED_EXPORT_APPROVED_CORPUS_MANIFEST"), "Approved corpus manifest metadata");
const outputRoot = requireAbsentOutput(required("CURATED_EXPORT_OUTPUT_DIR"), "Curated GitHub export directory");
assertOutputSeparated(outputRoot, [adapterRoot, resolve(projectRoot, "server")], "Curated GitHub export");

const checkpoint = validateCheckpointArtifacts({ trainingManifestPath, checkpointSelectionPath, adapterRoot });
if (artifactRecord(checkpoint.adapterPath).bytes >= 100_000_000) {
  throw new Error("Selected adapter reaches GitHub's 100 MB single-file limit; use an approved artifact-release strategy instead of this Git export.");
}
const checkpointSha = hashFile(checkpointSelectionPath);
const modelId = `${checkpoint.selection.model_version}-step${checkpoint.selection.selected_iteration}`;
const checkpointBindings = {
  training_run_manifest: hashFile(trainingManifestPath),
  adapter: checkpoint.adapterSha,
  adapter_config: checkpoint.configSha,
  base_model: checkpoint.training.base_model?.model_sha256,
};
const visible = validateVisibleGate(visibleGatePath, checkpointSha, checkpointBindings);
const visibleSha = hashFile(visibleGatePath);
const unseen = validateUnseenAggregate(unseenAggregatePath, checkpointSha, checkpointBindings);
const unseenSha = hashFile(unseenAggregatePath);
const corpus = readJson(corpusManifestPath, "Approved corpus manifest metadata");
const corpusSha = hashFile(corpusManifestPath);
if (corpus.approval_status !== "approved" || !Array.isArray(corpus.documents) || corpus.documents.length < 1) throw new Error("Approved corpus manifest metadata is not approved and non-empty.");
const qualification = readJson(qualificationApprovalPath, "Visible data/split approval");
if (qualification.status !== "approved_for_clean_cumulative_visible_training" || qualification.training_authorised !== true || qualification.release_authorised !== false || qualification.unseen_accessed !== false) throw new Error("Visible data/split approval is not the clean controlled-training approval.");
const release = validateLocalRelease(localReleasePath, {
  checkpointSha256: checkpointSha,
  visibleSha256: visibleSha,
  unseenSha256: unseenSha,
  corpusSha256: corpusSha,
  modelVersion: checkpoint.selection.model_version,
  selectedIteration: checkpoint.selection.selected_iteration,
});
const releaseSha = hashFile(localReleasePath);
const smoke = validateLiveSmoke(liveSmokePath, {
  releaseSha256: releaseSha,
  checkpointSha256: checkpointSha,
  corpusSha256: corpusSha,
  modelId,
});

if (String(process.env.CURATED_EXPORT_BUILD_CONFIRMATION || "") !== CURATED_EXPORT_CONFIRMATION) {
  process.stdout.write(`${JSON.stringify({
    status: "validated_dry_run_no_files_written",
    required_confirmation: CURATED_EXPORT_CONFIRMATION,
    output_root: outputRoot,
    build_id: buildId,
    selected_iteration: checkpoint.selection.selected_iteration,
    visible_gate: visible.gate.status,
    unseen_gate: unseen.aggregate.overall_release_gate,
    local_release: release.release.status,
    live_smoke: smoke.smoke.status,
  }, null, 2)}\n`);
  process.exit(0);
}

const partialRoot = resolve(dirname(outputRoot), `.${basename(outputRoot)}.partial-${process.pid}`);
requireAbsentOutput(partialRoot, "Curated export partial directory");
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
      if (entry.isSymbolicLink()) throw new Error(`Symlink is forbidden in curated application source: ${absolute}`);
      if (entry.isDirectory()) visit(absolute, rel);
      else if (entry.isFile()) rows.push(`${prefix}${rel}`);
    }
  };
  visit(root, "");
  return rows;
};

// The server is application code, not evaluation material; copy its exact source tree.
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
  description: "Owner-local, grounded UK pensions information and routing application with a pinned Qwen3-8B adapter.",
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

const gitignore = `# Secrets and local configuration\n.env\n.env.*\n!.env.example\n\n# Dependencies and runtimes\nnode_modules/\n.training-venv/\n.venv/\nruntime/bin/\nruntime/downloads/\n\n# Base models and raw approved corpus (selected adapter is deliberately retained)\nmodels/*\n!models/model-manifest.json\napproved-materials/index/\napproved-materials/originals/\napproved-materials/structured-facts/\n\n# Private/protected data and local state\ntraining-data/private/\ntraining/evaluation-cycle-v1/04-unseen/\n**/gold-answers.sealed.json\n**/unseen-question-set.json\ndata/\nuploads/\nLogging/\n*.log\n*.sqlite*\n*.db*\n\n# Caches\n__pycache__/\n*.py[cod]\n.DS_Store\n`;
writeFileSync(resolve(partialRoot, ".gitignore"), gitignore, { flag: "wx" });

copyExact(checkpoint.adapterPath, partialRoot, "release-artifacts/selected-adapter/adapters.safetensors", { allowAdapter: true });
copyExact(checkpoint.configPath, partialRoot, "release-artifacts/selected-adapter/adapter_config.json");
copyExact(corpusManifestPath, partialRoot, "approved-materials/approved-corpus-manifest.json");
copyExact(qualificationApprovalPath, partialRoot, "release-evidence/visible-data-split-approval.json");
copyExact(unseenAggregatePath, partialRoot, "release-evidence/sealed-unseen-aggregate.json");
copyExact(localReleasePath, partialRoot, "release-evidence/canonical-owner-local-release.json");
copyExact(liveSmokePath, partialRoot, "release-evidence/live-smoke-evidence.json");

const portable = portableRuntimeArtifacts({ training: checkpoint.training, selection: checkpoint.selection });
portable.portableTraining.portable_export.canonical_training_manifest_sha256 = hashFile(trainingManifestPath);
portable.portableSelection.portable_export.canonical_checkpoint_selection_sha256 = checkpointSha;
writeCanonicalJson(resolve(partialRoot, "runtime/training-run-manifest.json"), portable.portableTraining);
writeCanonicalJson(resolve(partialRoot, "runtime/checkpoint-selection.json"), portable.portableSelection);

const releaseEvidence = {
  schema_version: 1,
  build_id: buildId,
  scope: "owner-local-loopback-only",
  production_or_public_deployment_authorised: false,
  legal_boundary: "Information and routing support only; not legal advice or regulated financial advice.",
  canonical_artifacts: {
    training_run_manifest_sha256: hashFile(trainingManifestPath),
    checkpoint_selection_sha256: checkpointSha,
    selected_adapter_sha256: checkpoint.adapterSha,
    selected_adapter_config_sha256: checkpoint.configSha,
    visible_data_split_approval_sha256: hashFile(qualificationApprovalPath),
    visible_qualification_gate_sha256: visibleSha,
    sealed_unseen_aggregate_sha256: unseenSha,
    owner_local_release_sha256: releaseSha,
    live_smoke_evidence_sha256: hashFile(liveSmokePath),
    approved_corpus_manifest_sha256: corpusSha,
  },
  outcome: {
    model_version: checkpoint.selection.model_version,
    selected_iteration: checkpoint.selection.selected_iteration,
    selected_validation_loss: checkpoint.selection.selected_validation_loss,
    visible_qualification_passed: true,
    visible_stages: Object.fromEntries(["critical4", "full69", "topic161", "frozen13"].map((name) => [name, { passed: visible.gate.assessments[name].passed === true }])),
    sealed_unseen: unseen.aggregate,
    owner_local_release_status: release.release.status,
    live_smoke_status: smoke.smoke.status,
    live_smoke_questions_answered: smoke.smoke.questions_answered,
    approved_corpus_id: corpus.corpus_id,
    approved_corpus_document_count: corpus.documents.length,
  },
  portability_note: "runtime/checkpoint-selection.json and runtime/training-run-manifest.json rebind only local paths and therefore have different byte hashes from the qualified canonical artifacts. The exact canonical hashes remain above.",
};
writeCanonicalJson(resolve(partialRoot, "release-evidence/QUALIFICATION-SUMMARY.json"), releaseEvidence);

const readme = `# Pensiondashboard-model\n\nA grounded, read-only UK pensions information and routing application using the selected Qwen3-8B MLX adapter. The included release evidence passed the visible gates and the aggregate-only sealed unseen gate for the canonical checkpoint, followed by owner-local loopback approval and a live smoke check. **Public or production deployment is not authorised.**\n\n## Included and deliberately excluded\n\nIncluded: runnable application source, application tests/configuration, the exact selected adapter and adapter config, approved-corpus manifest metadata, visible approval evidence, aggregate-only unseen evidence, owner-local release/smoke evidence, and deterministic hashes.\n\nExcluded: the 4.6 GB base model, raw approved-corpus text, private training exports, databases, logs/caches, secrets, sealed unseen questions/gold answers, and all per-case unseen output.\n\n## Prerequisites\n\n- Apple Silicon Mac suitable for MLX (the qualified machine was a 16 GB M2)\n- Node.js 22+, Python 3, Docker Desktop\n- \`mlx-lm==0.31.3\` in \`.training-venv\`\n- Base model \`mlx-community/Qwen3-8B-4bit\`, revision \`${checkpoint.training.base_model.revision}\`, installed at \`models/mlx/Qwen3-8B-4bit\`; \`model.safetensors\` must hash to \`${checkpoint.training.base_model.model_sha256}\`\n- The approved corpus source text restored at every \`text_path\` named by \`approved-materials/approved-corpus-manifest.json\`, with exact recorded hashes. The manifest is metadata only; this repository intentionally cannot reconstruct the corpus without the separately obtained official-source files.\n\n## Install and verify\n\n\`\`\`bash\nnpm install\ncp .env.example .env\npython3 -m venv .training-venv\n.training-venv/bin/pip install mlx-lm==0.31.3\nshasum -a 256 release-artifacts/selected-adapter/adapters.safetensors\nshasum -a 256 -c SHA256SUMS\nnpm run check\nnpm test\n\`\`\`\n\nAfter restoring the approved corpus text and starting Docker services, bootstrap it with the exact manifest hash recorded in \`release-evidence/QUALIFICATION-SUMMARY.json\`.\n\n## Run the owner-local application\n\nThe portable checkpoint changes only filesystem paths, so use the explicit development-checkpoint route:\n\n\`\`\`bash\nnpm run infra:up\nAPPROVED_CORPUS_MANIFEST_PATH=approved-materials/approved-corpus-manifest.json \\\nAPPROVED_CORPUS_MANIFEST_SHA256=${corpusSha} \\\n  npm run materials:bootstrap-approved-corpus\nAPPROVED_CORPUS_MANIFEST_PATH=approved-materials/approved-corpus-manifest.json \\\nAPPROVED_CORPUS_MANIFEST_SHA256=${corpusSha} \\\n  npm run live:local -- --checkpoint runtime/checkpoint-selection.json\n\`\`\`\n\nOpen \`http://127.0.0.1:3000\`. The launcher remains loopback/local. Do not label the portable path-rebound checkpoint file as byte-identical to the canonical qualified checkpoint; its adapter and base-weight hashes are exact, while the canonical artifact hashes are retained in the evidence summary.\n\n## Safety and legal boundary\n\nThe assistant is read-only. It must abstain or hand off when evidence is missing, conflicting or outside scope. It cannot transfer money, change contributions, submit forms or provide regulated advice. Output is general information and routing support, not a substitute for a solicitor, regulated financial adviser, scheme administrator, HMRC or the relevant pensions regulator/ombudsman.\n\n## Publishing\n\nThis directory contains no Git metadata and the builder never changes remotes, commits or pushes. Review \`ARTIFACT-MANIFEST.json\`, \`SHA256SUMS\` and your repository visibility before creating the new \`Pensiondashboard-model\` repository history.\n`;
const curatedReadme = readme
  .replace("Node.js 22+, Python 3, Docker Desktop", "Node.js 22+ and Python 3")
  .replace(
    "After restoring the approved corpus text and starting Docker services, bootstrap it",
    "After restoring the approved corpus text, bootstrap it",
  )
  .replace(
    "recorded in `release-evidence/QUALIFICATION-SUMMARY.json`.",
    "recorded in `release-evidence/QUALIFICATION-SUMMARY.json`. The owner-local launcher uses SQLite, so Docker is not required for this loopback workflow.",
  )
  .replace("npm run infra:up\n", "");
writeFileSync(resolve(partialRoot, "README.md"), curatedReadme, { flag: "wx" });

writeArtifactManifest(partialRoot, {
  manifest_type: "pensiondashboard-model-curated-github-export-v1",
  build_id: buildId,
  source_artifact_hashes: releaseEvidence.canonical_artifacts,
  adapter_destinations: ["release-artifacts/selected-adapter/adapters.safetensors"],
});
scanReleaseTree(partialRoot, { adapterDestinations: ["release-artifacts/selected-adapter/adapters.safetensors"] });
renameSync(partialRoot, outputRoot);

process.stdout.write(`${JSON.stringify({
  status: "curated_export_built_no_git_actions_performed",
  output_root: outputRoot,
  build_id: buildId,
  files: scanReleaseTree(outputRoot, { adapterDestinations: ["release-artifacts/selected-adapter/adapters.safetensors"] }).length,
  selected_adapter_sha256: checkpoint.adapterSha,
  visible_gate: visible.gate.status,
  sealed_unseen_gate: unseen.aggregate.overall_release_gate,
  owner_local_release: release.release.status,
}, null, 2)}\n`);
