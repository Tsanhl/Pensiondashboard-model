import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertOutputSeparated,
  assertSafeArtifactPath,
  copyTree,
  hashFile,
  portableRuntimeArtifacts,
  scanReleaseTree,
  secretFindings,
  validateCheckpointArtifacts,
  validateLiveSmoke,
  validateLocalRelease,
  validateUnseenAggregate,
  validateVisibleGate,
  writeArtifactManifest,
} from "../scripts/lib/finalReleasePackaging.mjs";

const digest = (character) => character.repeat(64);
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

test("release path policy permits only aggregate unseen evidence and rejects protected/private paths", () => {
  assert.equal(assertSafeArtifactPath("release-evidence/sealed-unseen-aggregate.json"), "release-evidence/sealed-unseen-aggregate.json");
  assert.equal(assertSafeArtifactPath(".env.example"), ".env.example");
  assert.throws(() => assertSafeArtifactPath("training-data/private/train.jsonl"), /Protected/);
  assert.throws(() => assertSafeArtifactPath("training/evaluation-cycle-v1/04-unseen/questions.json"), /Protected/);
  assert.throws(() => assertSafeArtifactPath("release-evidence/sealed-unseen-case-results.json"), /Protected/);
  assert.throws(() => assertSafeArtifactPath("models/mlx/model.safetensors", { allowAdapter: true }), /forbidden/i);
  assert.throws(() => assertSafeArtifactPath("release-artifacts/selected-adapter/adapters.safetensors"), /selected-adapter slot/i);
  assert.doesNotThrow(() => assertSafeArtifactPath("release-artifacts/selected-adapter/adapters.safetensors", { allowAdapter: true }));
  assert.doesNotThrow(() => assertSafeArtifactPath("models/model-manifest.json"));
  assert.throws(() => assertOutputSeparated("/tmp/source/output", ["/tmp/source"]), /separate/);
  assert.throws(() => assertOutputSeparated("/tmp/source", ["/tmp/source/input"]), /separate/);
  assert.doesNotThrow(() => assertOutputSeparated("/tmp/output", ["/tmp/source"]));
});

test("secret scanner accepts example placeholders and rejects real-looking credentials", () => {
  assert.deepEqual(secretFindings("API_KEY=\nPASSWORD=change-me-local-only\nTOKEN=${TOKEN}\n", ".env.example"), []);
  assert.ok(secretFindings("GITHUB_TOKEN=github_pat_abcdefghijklmnopqrstuvwxyz123456", "bad.env").length >= 1);
  assert.ok(secretFindings("-----BEGIN PRIVATE KEY-----\nabc", "key.txt").some((row) => row.kind === "private_key"));
});

test("manifest and checksum files are deterministic and cover the payload", () => {
  const roots = [mkdtempSync(resolve(tmpdir(), "release-manifest-a-")), mkdtempSync(resolve(tmpdir(), "release-manifest-b-"))];
  for (const root of roots) {
    mkdirSync(resolve(root, "nested"));
    writeFileSync(resolve(root, "nested/a.txt"), "alpha\n");
    writeFileSync(resolve(root, "b.json"), "{\"ok\":true}\n");
    writeArtifactManifest(root, { manifest_type: "test-manifest", build_id: "test-build-001", source_artifact_hashes: {} });
  }
  assert.equal(readFileSync(resolve(roots[0], "ARTIFACT-MANIFEST.json"), "utf8"), readFileSync(resolve(roots[1], "ARTIFACT-MANIFEST.json"), "utf8"));
  assert.equal(readFileSync(resolve(roots[0], "SHA256SUMS"), "utf8"), readFileSync(resolve(roots[1], "SHA256SUMS"), "utf8"));
  assert.equal(scanReleaseTree(roots[0]).length, 4);
});

test("tree copy fails on protected material even when its extension is not selected", () => {
  const source = mkdtempSync(resolve(tmpdir(), "protected-copy-source-"));
  const output = mkdtempSync(resolve(tmpdir(), "protected-copy-output-"));
  writeFileSync(resolve(source, "sealed-unseen-case-output.bin"), "protected");
  assert.throws(() => copyTree(source, output, "review", { allowedExtensions: [".json"] }), /Protected/);
});

test("portable checkpoint artifacts remove absolute paths and retain weight identity", () => {
  const result = portableRuntimeArtifacts({
    training: {
      version: "run-v1",
      status: "completed_checkpoint_selected",
      clean_start: true,
      base_model: { repository: "repo", revision: "rev", source_model: "base", quantisation: "4-bit", path: "/private/base", model_sha256: digest("a"), model_size_bytes: 12 },
      output_adapter: { path: "/private/adapter" },
    },
    selection: {
      version: "selection-v1",
      policy: "lowest validation loss",
      model_version: "model-v1",
      selected_iteration: 26,
      selected_validation_loss: 1.25,
      source_checkpoint: "/private/checkpoint",
      selected_adapter_path: "/private/selected",
      adapter_sha256: digest("b"),
      adapter_config_sha256: digest("c"),
    },
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /\/private\//);
  assert.equal(result.portableSelection.selected_adapter_path, "release-artifacts/selected-adapter");
  assert.equal(result.portableTraining.base_model.path, "models/mlx/Qwen3-8B-4bit");
});

test("checkpoint, visible, aggregate, release and smoke validators require one hash-bound chain", () => {
  const root = mkdtempSync(resolve(tmpdir(), "release-chain-"));
  const adapter = resolve(root, "adapter");
  mkdirSync(adapter);
  writeFileSync(resolve(adapter, "adapters.safetensors"), "selected-weights");
  json(resolve(adapter, "adapter_config.json"), { rank: 8 });
  const adapterSha = hashFile(resolve(adapter, "adapters.safetensors"));
  const configSha = hashFile(resolve(adapter, "adapter_config.json"));
  const selectionPath = resolve(root, "checkpoint-selection.json");
  json(selectionPath, {
    version: "cumulative-visible-checkpoint-selection-v1",
    model_version: "candidate",
    selected_iteration: 26,
    selected_validation_loss: 1.1,
    adapter_sha256: adapterSha,
    adapter_config_sha256: configSha,
  });
  const checkpointSha = hashFile(selectionPath);
  const trainingPath = resolve(root, "training-run-manifest.json");
  json(trainingPath, {
    version: "run-v1",
    status: "completed_checkpoint_selected",
    base_model: { revision: "rev", model_sha256: digest("a") },
    adapter_selection: { checkpoint_selection_sha256: checkpointSha, adapter_sha256: adapterSha },
  });
  assert.equal(validateCheckpointArtifacts({ trainingManifestPath: trainingPath, checkpointSelectionPath: selectionPath, adapterRoot: adapter }).adapterSha, adapterSha);

  const visiblePath = resolve(root, "visible-gate.json");
  json(visiblePath, {
    version: "post-training-visible-qualification-v1-gate-v1",
    stage: "final",
    status: "passed_owner_authorised_visible_qualification",
    passed: true,
    owner_authorised_visible_qualification: true,
    release_authorised: false,
    sealed_unseen_accessed: false,
    sealed_unseen_authorised: false,
    blockers: [],
    assessments: Object.fromEntries(["critical4", "full69", "topic161", "frozen13"].map((name) => [name, { passed: true }])),
    checkpoint: { checkpoint_selection: { sha256: checkpointSha } },
  });
  validateVisibleGate(visiblePath, checkpointSha);

  const wave = (number) => ({ wave: `wave-${number}`, total: 10, pass: 10, partial: 0, fail: 0, critical_failures: 0, run_errors: 0, pass_rate: 100 });
  const unseenPath = resolve(root, "aggregate-result.json");
  json(unseenPath, {
    version: "cycle-v1-sealed-unseen-one-shot-v1",
    run_label: "release-test-001",
    candidate_sha256: digest("b"),
    waves: [1, 2, 3, 4, 5, 6].map(wave),
    overall: { total: 60, pass: 60, partial: 0, fail: 0, critical_failures: 0, run_errors: 0, pass_rate: 100, minimum_overall_pass_rate: 90, minimum_per_wave_pass_rate: 90 },
    runtime_hashes: { model_identity_sha256: digest("c"), model_health_sha256: digest("d"), embedding_health_sha256: digest("e"), retrieval_probe_sha256: digest("f"), approved_corpus_manifest_sha256: digest("1") },
    checkpoint_hashes: { checkpoint_selection_sha256: checkpointSha, training_manifest_sha256: hashFile(trainingPath), adapter_sha256: adapterSha, adapter_config_sha256: configSha, base_model_sha256: digest("a") },
    code_hashes: { "server.js": digest("2") },
    overall_release_gate: "PASS",
  });
  validateUnseenAggregate(unseenPath, checkpointSha);

  const visibleSha = hashFile(visiblePath);
  const unseenSha = hashFile(unseenPath);
  const corpusSha = digest("1");
  const releasePath = resolve(root, "local-live-release.json");
  json(releasePath, {
    status: "approved_for_owner_local_live",
    release_authorised: true,
    deployment_scope: "single-user loopback local application only",
    production_or_public_deployment_authorised: false,
    checkpoint_sha256: checkpointSha,
    approved_corpus_manifest: { sha256: corpusSha },
    bound_gates: { visible_qualification: { sha256: visibleSha }, sealed_unseen_aggregate: { sha256: unseenSha } },
  });
  validateLocalRelease(releasePath, { checkpointSha256: checkpointSha, visibleSha256: visibleSha, unseenSha256: unseenSha, corpusSha256: corpusSha });

  const smokePath = resolve(root, "live-smoke.json");
  json(smokePath, {
    version: "owner-local-live-smoke-v1",
    status: "passed",
    loopback_only: true,
    production_or_public_deployment_authorised: false,
    questions_answered: 2,
    release_manifest_sha256: hashFile(releasePath),
    checkpoint_sha256: checkpointSha,
    approved_corpus_manifest_sha256: corpusSha,
    model_id: "candidate-step26",
  });
  validateLiveSmoke(smokePath, { releaseSha256: hashFile(releasePath), checkpointSha256: checkpointSha, corpusSha256: corpusSha });

  const broken = JSON.parse(readFileSync(smokePath, "utf8"));
  broken.checkpoint_sha256 = digest("9");
  json(resolve(root, "broken-smoke.json"), broken);
  assert.throws(() => validateLiveSmoke(resolve(root, "broken-smoke.json"), { releaseSha256: hashFile(releasePath), checkpointSha256: checkpointSha, corpusSha256: corpusSha }), /smoke/i);
  const contentBearing = JSON.parse(readFileSync(smokePath, "utf8"));
  contentBearing.answer = "content must stay out of the smoke attestation";
  json(resolve(root, "content-bearing-smoke.json"), contentBearing);
  assert.throws(() => validateLiveSmoke(resolve(root, "content-bearing-smoke.json"), { releaseSha256: hashFile(releasePath), checkpointSha256: checkpointSha, corpusSha256: corpusSha }), /outcome metadata/i);
});
