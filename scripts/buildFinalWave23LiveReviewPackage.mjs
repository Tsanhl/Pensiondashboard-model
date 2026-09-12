import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  REVIEW_CONFIRMATION,
  assertOutputSeparated,
  artifactRecord,
  copyExact,
  copyTree,
  createDeterministicZip,
  hashFile,
  readJson,
  requireAbsentOutput,
  requireBuildId,
  requireExistingDirectory,
  requireExistingFile,
  scanReleaseTree,
  validateCheckpointArtifacts,
  validateCumulativeRoot,
  validateLiveSmoke,
  validateLocalRelease,
  validateRepairedVisibleRoot,
  validateUnseenAggregate,
  validateVisibleGate,
  writeArtifactManifest,
} from "./lib/finalReleasePackaging.mjs";

if (process.argv.includes("--help")) {
  process.stdout.write(`Build a fail-closed final Wave 2–3/live review directory and deterministic ZIP.\n\nRequired environment:\n  FINAL_REVIEW_BUILD_ID\n  FINAL_REVIEW_REPAIRED_VISIBLE_ROOT\n  FINAL_REVIEW_ROOT23\n  FINAL_REVIEW_ROOT24\n  FINAL_REVIEW_TRAINING_RUN_MANIFEST\n  FINAL_REVIEW_CHECKPOINT_SELECTION\n  FINAL_REVIEW_VISIBLE_QUALIFICATION_ROOT\n  FINAL_REVIEW_VISIBLE_GATE\n  FINAL_REVIEW_UNSEEN_AGGREGATE\n  FINAL_REVIEW_LOCAL_RELEASE_MANIFEST\n  FINAL_REVIEW_LIVE_SMOKE_EVIDENCE\n  FINAL_REVIEW_ADAPTER_ROOT\n  FINAL_REVIEW_APPROVED_CORPUS_MANIFEST\n  FINAL_REVIEW_OUTPUT_DIR (must not exist)\n  FINAL_REVIEW_ZIP_PATH (must not exist; .zip)\n\nWithout FINAL_REVIEW_BUILD_CONFIRMATION=${REVIEW_CONFIRMATION}, the script validates only and writes nothing.\n`);
  process.exit(0);
}

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const buildId = requireBuildId(required("FINAL_REVIEW_BUILD_ID"));
const repairedRoot = requireExistingDirectory(required("FINAL_REVIEW_REPAIRED_VISIBLE_ROOT"), "Repaired visible Wave 2–3 root");
const root23 = requireExistingDirectory(required("FINAL_REVIEW_ROOT23"), "Root 23 full cumulative review");
const root24 = requireExistingDirectory(required("FINAL_REVIEW_ROOT24"), "Root 24 compact cumulative review");
const trainingManifestPath = requireExistingFile(required("FINAL_REVIEW_TRAINING_RUN_MANIFEST"), "Training-run manifest");
const checkpointSelectionPath = requireExistingFile(required("FINAL_REVIEW_CHECKPOINT_SELECTION"), "Checkpoint selection");
const visibleRoot = requireExistingDirectory(required("FINAL_REVIEW_VISIBLE_QUALIFICATION_ROOT"), "Visible qualification root");
const visibleGatePath = requireExistingFile(required("FINAL_REVIEW_VISIBLE_GATE"), "Visible qualification final gate");
const unseenAggregatePath = requireExistingFile(required("FINAL_REVIEW_UNSEEN_AGGREGATE"), "Sealed unseen aggregate");
const localReleasePath = requireExistingFile(required("FINAL_REVIEW_LOCAL_RELEASE_MANIFEST"), "Owner-local release manifest");
const liveSmokePath = requireExistingFile(required("FINAL_REVIEW_LIVE_SMOKE_EVIDENCE"), "Owner-local live smoke evidence");
const adapterRoot = requireExistingDirectory(required("FINAL_REVIEW_ADAPTER_ROOT"), "Selected adapter root");
const corpusManifestPath = requireExistingFile(required("FINAL_REVIEW_APPROVED_CORPUS_MANIFEST"), "Approved corpus manifest metadata");
const outputRoot = requireAbsentOutput(required("FINAL_REVIEW_OUTPUT_DIR"), "Final review output directory");
const zipPath = requireAbsentOutput(required("FINAL_REVIEW_ZIP_PATH"), "Final review ZIP", { suffix: ".zip" });
assertOutputSeparated(outputRoot, [repairedRoot, root23, root24, visibleRoot, adapterRoot], "Final review output");
assertOutputSeparated(zipPath, [repairedRoot, root23, root24, visibleRoot, adapterRoot], "Final review ZIP");

const repaired = validateRepairedVisibleRoot(repairedRoot);
const full = validateCumulativeRoot(root23);
const compact = validateCumulativeRoot(root24, { compact: true });
const repairedSha = hashFile(repaired.path);
if (full.items.input_hashes?.repaired_wave_2_3_pack !== repairedSha || compact.items.input_hashes?.repaired_wave_2_3_pack !== repairedSha) {
  throw new Error("Root 23/24 cumulative records are not bound to the supplied 52 repaired Wave 2–3 records.");
}
const fullBindings = {
  item_register_sha256: hashFile(full.itemPath),
  source_register_sha256: hashFile(full.sourcePath),
  global_allocation_sha256: hashFile(full.allocationPath),
};
for (const [name, expected] of Object.entries(fullBindings)) {
  if (compact.items.upstream_bindings?.[name] !== expected) throw new Error(`Root 24 is not bound to Root 23 ${name}.`);
}
const checkpoint = validateCheckpointArtifacts({ trainingManifestPath, checkpointSelectionPath, adapterRoot });
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
if (corpus.approval_status !== "approved" || !Array.isArray(corpus.documents) || corpus.documents.length < 1) {
  throw new Error("Approved corpus manifest metadata is not an approved, non-empty corpus manifest.");
}
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

const inputSummary = {
  build_id: buildId,
  repaired_visible_records: repaired.pack.item_count,
  cumulative_visible_records: full.items.counts.total,
  split: `${full.allocation.train.count}/${full.allocation.validation.count}`,
  training_status: checkpoint.training.status,
  selected_iteration: checkpoint.selection.selected_iteration,
  selected_validation_loss: checkpoint.selection.selected_validation_loss,
  visible_gate: visible.gate.status,
  unseen_gate: unseen.aggregate.overall_release_gate,
  owner_local_release: release.release.status,
  live_smoke: smoke.smoke.status,
  corpus_documents: corpus.documents.length,
};

if (String(process.env.FINAL_REVIEW_BUILD_CONFIRMATION || "") !== REVIEW_CONFIRMATION) {
  process.stdout.write(`${JSON.stringify({
    status: "validated_dry_run_no_files_written",
    required_confirmation: REVIEW_CONFIRMATION,
    output_root: outputRoot,
    zip_path: zipPath,
    ...inputSummary,
  }, null, 2)}\n`);
  process.exit(0);
}

const partialRoot = resolve(dirname(outputRoot), `.${basename(outputRoot)}.partial-${process.pid}`);
requireAbsentOutput(partialRoot, "Final review partial directory");
mkdirSync(partialRoot, { recursive: true, mode: 0o755 });

const reviewExtensions = [".json", ".jsonl", ".md", ".mjs", ".txt"];
const sections = [];
sections.push({
  name: "repaired-visible-wave2-wave3",
  ...copyTree(repairedRoot, partialRoot, "01-repaired-visible-wave2-wave3", { allowedExtensions: reviewExtensions }),
});
sections.push({
  name: "root23-full-cumulative",
  ...copyTree(root23, partialRoot, "02-root23-full-cumulative", { allowedExtensions: reviewExtensions, omitBasenames: ["training-output.log"] }),
});
sections.push({
  name: "root24-compact-cumulative",
  ...copyTree(root24, partialRoot, "03-root24-compact-cumulative", { allowedExtensions: reviewExtensions, omitBasenames: ["training-output.log"] }),
});
sections.push({
  name: "visible-qualification",
  ...copyTree(visibleRoot, partialRoot, "05-visible-qualification", { allowedExtensions: reviewExtensions, omitBasenames: ["training-output.log"] }),
});

copyExact(trainingManifestPath, partialRoot, "04-training-and-checkpoint/training-run-manifest.json");
copyExact(checkpointSelectionPath, partialRoot, "04-training-and-checkpoint/checkpoint-selection.json");
copyExact(visibleGatePath, partialRoot, "05-visible-qualification/final-gate.json");
copyExact(unseenAggregatePath, partialRoot, "evidence/sealed-unseen/aggregate-result.json");
copyExact(localReleasePath, partialRoot, "06-local-live/local-live-release.json");
copyExact(liveSmokePath, partialRoot, "06-local-live/live-smoke-evidence.json");
copyExact(corpusManifestPath, partialRoot, "06-local-live/approved-corpus-manifest-metadata.json");
copyExact(checkpoint.adapterPath, partialRoot, "07-selected-adapter/adapters.safetensors", { allowAdapter: true });
copyExact(checkpoint.configPath, partialRoot, "07-selected-adapter/adapter_config.json");

const omitted = sections.flatMap((section) => section.omitted.map((row) => ({ section: section.name, ...row })));
writeFileSync(resolve(partialRoot, "OMITTED-FILES.json"), `${JSON.stringify({
  schema_version: 1,
  policy: "Only review-safe text/JSON artifacts and the exact selected adapter/config are admitted. Logs, caches, private training exports, raw corpus, base weights and protected unseen detail are excluded.",
  entries: omitted,
}, null, 2)}\n`, { flag: "wx" });

const readme = `# Final Wave 2–3, qualification and owner-local live review\n\nBuild ID: **${buildId}**\n\nThis package is ready for external review of the completed visible-repair, training, qualification and owner-local-live evidence chain. It contains no sealed unseen question, gold answer or per-case output. The unseen evidence is the one-shot aggregate only.\n\n## Bound outcome\n\n- Repaired visible Wave 2–3 records: **52**\n- Cumulative visible allocation: **76 train / 18 validation (94 total)**\n- Training run: **${checkpoint.training.status}**\n- Selected checkpoint: **iteration ${checkpoint.selection.selected_iteration}**, validation loss **${checkpoint.selection.selected_validation_loss}**\n- Visible qualification: **PASS** (critical 4, retained 69, topic 161 and frozen 13)\n- Sealed unseen: **${unseen.aggregate.overall_release_gate}**, aggregate-only record\n- Owner-local release: **approved for single-user loopback use only**\n- Live smoke: **${smoke.smoke.questions_answered} answered question(s), passed**\n- Approved runtime corpus metadata: **${corpus.documents.length} documents**; source text itself is excluded\n\n## Boundaries\n\nThis is not approval for public or production deployment, and the application is an information and routing tool—not a substitute for legal or regulated financial advice. The selected adapter is included; the base model, raw approved corpus, private training exports, databases, logs, caches, secrets and all protected unseen detail are excluded.\n\nVerify every file with \`SHA256SUMS\` and the deterministic \`ARTIFACT-MANIFEST.json\`.\n`;
writeFileSync(resolve(partialRoot, "README.md"), readme, { flag: "wx" });

const sourceArtifactHashes = {
  repaired_visible_pack: repairedSha,
  root23_item_register: hashFile(full.itemPath),
  root23_allocation: hashFile(full.allocationPath),
  root23_source_register: hashFile(full.sourcePath),
  root24_item_register: hashFile(compact.itemPath),
  root24_allocation: hashFile(compact.allocationPath),
  root24_source_register: hashFile(compact.sourcePath),
  training_run_manifest: hashFile(trainingManifestPath),
  checkpoint_selection: checkpointSha,
  visible_qualification_gate: visibleSha,
  sealed_unseen_aggregate: unseenSha,
  owner_local_release: releaseSha,
  owner_local_live_smoke: hashFile(liveSmokePath),
  approved_corpus_manifest: corpusSha,
  selected_adapter: checkpoint.adapterSha,
  selected_adapter_config: checkpoint.configSha,
};
writeArtifactManifest(partialRoot, {
  manifest_type: "pensions-dashboard-final-review-package-v1",
  build_id: buildId,
  source_artifact_hashes: sourceArtifactHashes,
  adapter_destinations: ["07-selected-adapter/adapters.safetensors"],
});
scanReleaseTree(partialRoot, { adapterDestinations: ["07-selected-adapter/adapters.safetensors"] });
renameSync(partialRoot, outputRoot);
const zip = createDeterministicZip(outputRoot, zipPath, basename(outputRoot));

process.stdout.write(`${JSON.stringify({
  status: "built",
  output_root: outputRoot,
  zip,
  ...inputSummary,
  output_manifest: artifactRecord(resolve(outputRoot, "ARTIFACT-MANIFEST.json")),
  sha256sums: artifactRecord(resolve(outputRoot, "SHA256SUMS")),
}, null, 2)}\n`);
