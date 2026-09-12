import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertAggregateOnly } from "./sealedUnseenOneShotV1.mjs";

export const REVIEW_CONFIRMATION = "build_hash_bound_final_review_package";
export const CURATED_EXPORT_CONFIRMATION = "build_curated_pensiondashboard_model_export";

const HASH = /^[a-f0-9]{64}$/i;
const BUILD_ID = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const TEXT_EXTENSIONS = new Set([
  "", ".css", ".csv", ".example", ".html", ".js", ".json", ".jsonl",
  ".md", ".mjs", ".py", ".sh", ".sql", ".txt", ".yaml", ".yml",
]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".db", ".key", ".log", ".p12", ".pem", ".sqlite", ".sqlite3",
]);
const PROTECTED_PATH_PATTERNS = [
  /(^|\/)training-data\/private(\/|$)/i,
  /(^|\/)evaluation-cycle-v1\/04-unseen(\/|$)/i,
  /(^|\/)gold-answers\.sealed\.json$/i,
  /(^|\/)unseen-question-set\.json$/i,
  /(^|\/)unseen\/(?:questions|gold|answers|cases|results)(\/|\.|$)/i,
  /(^|\/)(?:raw|per-case)[-_. ]?unseen(\/|\.|$)/i,
];
const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.training-venv(\/|$)/,
  /(^|\/)models(?:\/|$)/i,
  /(^|\/)approved-materials\/(?:index|originals)(\/|$)/i,
  /(^|\/)Logging(\/|$)/,
  /(^|\/)(?:data|uploads|tmp|temp|runtime\/downloads|runtime\/bin)(\/|$)/i,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.DS_Store$/,
];
const FIXED_ZIP_DATETIME = "(1980, 1, 1, 0, 0, 0)";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFile(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let count;
    do {
      count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count) hash.update(buffer.subarray(0, count));
    } while (count);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function canonicalRelative(value) {
  const normalized = String(value || "").split(sep).join("/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || isAbsolute(normalized)) {
    throw new Error(`Unsafe relative artifact path: ${value}`);
  }
  return normalized;
}

export function requireBuildId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!BUILD_ID.test(id)) throw new Error("Build ID must be 3–80 lowercase letters, digits, dots, underscores or hyphens.");
  return id;
}

export function requireExistingFile(value, label) {
  const path = resolve(String(value || ""));
  if (!value || !existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} must be an existing file: ${path}`);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${path}`);
  return path;
}

export function requireExistingDirectory(value, label) {
  const path = resolve(String(value || ""));
  if (!value || !existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} must be an existing directory: ${path}`);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${path}`);
  return path;
}

export function requireAbsentOutput(value, label, { suffix = null } = {}) {
  const path = resolve(String(value || ""));
  if (!value || path === "/" || path === resolve(".")) throw new Error(`${label} is unsafe: ${path}`);
  if (suffix && !path.toLowerCase().endsWith(suffix.toLowerCase())) throw new Error(`${label} must end with ${suffix}: ${path}`);
  if (existsSync(path)) throw new Error(`${label} already exists; refusing to overwrite: ${path}`);
  return path;
}

export function assertOutputSeparated(output, sources, label = "Output") {
  const target = resolve(output);
  for (const sourceValue of sources) {
    const source = resolve(sourceValue);
    const fromSource = relative(source, target);
    const fromTarget = relative(target, source);
    const targetInsideSource = !fromSource || (!fromSource.startsWith("..") && !isAbsolute(fromSource));
    const sourceInsideTarget = !fromTarget || (!fromTarget.startsWith("..") && !isAbsolute(fromTarget));
    if (targetInsideSource || sourceInsideTarget) throw new Error(`${label} must be separate from source tree: ${source}`);
  }
  return target;
}

export function readJson(path, label = basename(path)) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function writeCanonicalJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

function isAllowedAggregateDestination(path) {
  return [
    "evidence/sealed-unseen/aggregate-result.json",
    "release-evidence/sealed-unseen-aggregate.json",
  ].includes(path);
}

export function assertSafeArtifactPath(path, { allowAdapter = false } = {}) {
  const normalized = canonicalRelative(path);
  if ((PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized)) || /unseen/i.test(normalized)) && !isAllowedAggregateDestination(normalized)) {
    throw new Error(`Protected unseen/private path is forbidden: ${normalized}`);
  }
  const metadataException = normalized === ".env.example" || normalized === "models/model-manifest.json";
  if (!metadataException && FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error(`Local, generated or secret-bearing path is forbidden: ${normalized}`);
  }
  const extension = extname(normalized).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) throw new Error(`Forbidden artifact extension: ${normalized}`);
  if (extension === ".safetensors" && !allowAdapter) throw new Error(`Model weights are forbidden outside the selected-adapter slot: ${normalized}`);
  if (/\.(?:gguf|bin|onnx|pt|pth)$/i.test(normalized)) throw new Error(`Base-model/raw weight file is forbidden: ${normalized}`);
  return normalized;
}

function placeholderSecret(value) {
  const normalized = String(value || "").trim().replace(/[,'"]+$/g, "").replace(/^['"]/, "");
  return !normalized || /^(?:false|null|none|disabled|changeme(?:[-_].*)?|change-me(?:[-_].*)?|placeholder|example|your[-_].*|<[^>]+>|\$\{[^}]+\})$/i.test(normalized);
}

export function secretFindings(text, path = "artifact") {
  const value = String(text || "");
  const findings = [];
  const direct = [
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["github_token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
    ["openai_style_token", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["credentialed_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i],
  ];
  for (const [kind, pattern] of direct) if (pattern.test(value)) findings.push({ path, kind });
  const extension = extname(String(path)).toLowerCase();
  if (["", ".env", ".example", ".json", ".jsonl", ".yaml", ".yml"].includes(extension)) {
    for (const line of value.split(/\r?\n/)) {
      const match = line.match(/^\s*["']?([A-Z][A-Z0-9_]*)["']?\s*[:=]\s*(.*)$/i);
      const name = String(match?.[1] || "").toUpperCase();
      const isSecretName = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN)(?:_|$)/.test(name);
      if (match && isSecretName && !placeholderSecret(match[2])) findings.push({ path, kind: "assigned_secret", name: match[1] });
    }
  }
  return findings;
}

export function listTreeFiles(root) {
  const base = requireExistingDirectory(root, "Artifact tree");
  const rows = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in release artifacts: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) rows.push(path);
      else throw new Error(`Unsupported filesystem entry in release artifacts: ${path}`);
    }
  };
  visit(base);
  return rows;
}

export function scanReleaseTree(root, { adapterDestinations = [] } = {}) {
  const base = requireExistingDirectory(root, "Release tree");
  const allowedAdapters = new Set(adapterDestinations.map(canonicalRelative));
  const findings = [];
  const records = [];
  for (const absolute of listTreeFiles(base)) {
    const rel = canonicalRelative(relative(base, absolute));
    try {
      assertSafeArtifactPath(rel, { allowAdapter: allowedAdapters.has(rel) });
    } catch (error) {
      findings.push({ path: rel, kind: "forbidden_path", detail: error.message });
      continue;
    }
    const stats = statSync(absolute);
    const extension = extname(rel).toLowerCase();
    if (TEXT_EXTENSIONS.has(extension)) {
      if (stats.size > 100 * 1024 * 1024) {
        findings.push({ path: rel, kind: "oversized_text_file", bytes: stats.size });
      } else {
        findings.push(...secretFindings(readFileSync(absolute, "utf8"), rel));
      }
    }
    records.push({ path: rel, bytes: stats.size, sha256: hashFile(absolute) });
  }
  if (findings.length) throw new Error(`Release scan failed:\n${findings.map((row) => `- ${row.path}: ${row.kind}${row.detail ? ` (${row.detail})` : ""}`).join("\n")}`);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export function copyTree(source, destinationRoot, destinationPrefix, {
  allowedExtensions = null,
  allowAdapter = false,
  omitBasenames = [],
} = {}) {
  const root = requireExistingDirectory(source, destinationPrefix);
  const copied = [];
  const omitted = [];
  const extensionSet = allowedExtensions ? new Set(allowedExtensions.map((value) => value.toLowerCase())) : null;
  for (const path of listTreeFiles(root)) {
    const rel = canonicalRelative(relative(root, path));
    const outputRel = canonicalRelative(`${destinationPrefix}/${rel}`);
    const extension = extname(rel).toLowerCase();
    if (omitBasenames.includes(basename(rel))) {
      omitted.push({ source_relative_path: rel, reason: "not_in_section_allowlist" });
      continue;
    }
    assertSafeArtifactPath(outputRel, { allowAdapter });
    if (extensionSet && !extensionSet.has(extension)) {
      omitted.push({ source_relative_path: rel, reason: "not_in_section_allowlist" });
      continue;
    }
    const destination = resolve(destinationRoot, outputRel);
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination)) throw new Error(`Refusing to overwrite a package artifact: ${outputRel}`);
    copyFileSync(path, destination, fsConstants.COPYFILE_EXCL);
    copied.push({ path: outputRel, bytes: statSync(destination).size, sha256: hashFile(destination) });
  }
  if (!copied.length) throw new Error(`No files were admitted from ${source}`);
  return { copied, omitted };
}

export function copyExact(source, destinationRoot, destinationPath, { allowAdapter = false } = {}) {
  const input = requireExistingFile(source, destinationPath);
  const rel = assertSafeArtifactPath(destinationPath, { allowAdapter });
  const output = resolve(destinationRoot, rel);
  mkdirSync(dirname(output), { recursive: true });
  if (existsSync(output)) throw new Error(`Refusing to overwrite a package artifact: ${rel}`);
  copyFileSync(input, output, fsConstants.COPYFILE_EXCL);
  return { path: rel, bytes: statSync(output).size, sha256: hashFile(output) };
}

export function validateRepairedVisibleRoot(root) {
  const path = requireExistingFile(resolve(root, "repaired-training-items-draft.json"), "Repaired visible Wave 2–3 records");
  const pack = readJson(path);
  if (pack.item_count !== 52 || !Array.isArray(pack.items) || pack.items.length !== 52 || new Set(pack.items.map((row) => row.training_id)).size !== 52) {
    throw new Error("Repaired visible pack must contain exactly 52 unique Wave 2–3 records.");
  }
  if (pack.unseen_accessed !== false || pack.training_authorised !== false) throw new Error("Repaired visible pack must explicitly record no unseen access and no training authority.");
  return { path, pack };
}

export function validateCumulativeRoot(root, { compact = false } = {}) {
  const itemPath = requireExistingFile(resolve(root, "cumulative-visible-item-register.json"), `${compact ? "Compact" : "Full"} item register`);
  const allocationPath = requireExistingFile(resolve(root, "global-visible-allocation-draft.json"), `${compact ? "Compact" : "Full"} allocation`);
  const sourcePath = requireExistingFile(resolve(root, "cumulative-visible-source-register.json"), `${compact ? "Compact" : "Full"} source register`);
  const items = readJson(itemPath);
  const allocation = readJson(allocationPath);
  if (items.counts?.total !== 94 || items.counts?.v1 !== 42 || items.counts?.wave_2 !== 33 || items.counts?.wave_3 !== 19) {
    throw new Error(`${compact ? "Compact" : "Full"} cumulative register does not cover exactly 94 visible records.`);
  }
  if (items.unseen_accessed !== false || items.unseen_included !== false || allocation.unseen_accessed !== false || allocation.unseen_included !== false) {
    throw new Error(`${compact ? "Compact" : "Full"} cumulative artifacts do not explicitly exclude unseen material.`);
  }
  if (allocation.train?.count !== 76 || allocation.validation?.count !== 18 || allocation.isolation?.passed !== true) {
    throw new Error(`${compact ? "Compact" : "Full"} cumulative allocation is not the isolated 76/18 allocation.`);
  }
  if (allocation.item_register_sha256 !== hashFile(itemPath) || allocation.source_register_sha256 !== hashFile(sourcePath)) {
    throw new Error(`${compact ? "Compact" : "Full"} cumulative allocation is not hash-bound to its item/source registers.`);
  }
  if (compact) {
    const approvalPath = requireExistingFile(resolve(root, "qualification-approval.json"), "Compact qualification approval");
    const approval = readJson(approvalPath);
    if (approval.status !== "approved_for_clean_cumulative_visible_training" || approval.training_authorised !== true || approval.release_authorised !== false || approval.unseen_accessed !== false) {
      throw new Error("Compact qualification approval does not authorise only clean local-development training.");
    }
    const tokenPath = requireExistingFile(resolve(root, "final-token-and-loss-mask-preflight.json"), "Final token/loss-mask preflight");
    const token = readJson(tokenPath);
    if (token.passed !== true || token.status !== "passed" || token.unseen_accessed !== false) throw new Error("Final token/loss-mask preflight has not passed cleanly.");
    if (approval.bindings?.item_register_sha256 !== hashFile(itemPath) || approval.bindings?.source_register_sha256 !== hashFile(sourcePath) || approval.bindings?.global_allocation_sha256 !== hashFile(allocationPath) || approval.bindings?.token_and_loss_mask_preflight_sha256 !== hashFile(tokenPath)) {
      throw new Error("Compact qualification approval is not hash-bound to the final registers, allocation and loss-mask preflight.");
    }
  }
  return { itemPath, allocationPath, sourcePath, items, allocation };
}

export function validateCheckpointArtifacts({ trainingManifestPath, checkpointSelectionPath, adapterRoot }) {
  const trainingPath = requireExistingFile(trainingManifestPath, "Training-run manifest");
  const selectionPath = requireExistingFile(checkpointSelectionPath, "Checkpoint selection");
  const adapterDirectory = requireExistingDirectory(adapterRoot, "Selected adapter");
  const adapterPath = requireExistingFile(resolve(adapterDirectory, "adapters.safetensors"), "Selected adapter weights");
  const configPath = requireExistingFile(resolve(adapterDirectory, "adapter_config.json"), "Selected adapter config");
  const training = readJson(trainingPath);
  const selection = readJson(selectionPath);
  if (training.status !== "completed_checkpoint_selected") throw new Error(`Training is not complete with a selected checkpoint: ${training.status}`);
  if (!Number.isInteger(selection.selected_iteration) || selection.selected_iteration < 1 || !Number.isFinite(selection.selected_validation_loss)) {
    throw new Error("Checkpoint selection is incomplete.");
  }
  const adapterSha = hashFile(adapterPath);
  const configSha = hashFile(configPath);
  if (selection.adapter_sha256 !== adapterSha || selection.adapter_config_sha256 !== configSha) throw new Error("Selected adapter bytes do not match checkpoint selection.");
  if (training.adapter_selection?.checkpoint_selection_sha256 !== hashFile(selectionPath) || training.adapter_selection?.adapter_sha256 !== adapterSha) {
    throw new Error("Completed training manifest does not bind the selected checkpoint and adapter.");
  }
  return { trainingPath, selectionPath, adapterDirectory, adapterPath, configPath, training, selection, adapterSha, configSha };
}

export function validateVisibleGate(path, checkpointSha256, expectedHashes = {}) {
  const gatePath = requireExistingFile(path, "Visible qualification final gate");
  const gate = readJson(gatePath);
  const assessments = gate.assessments || {};
  if (gate.version !== "post-training-visible-qualification-v1-gate-v1" || gate.stage !== "final" || gate.status !== "passed_owner_authorised_visible_qualification" || gate.passed !== true || gate.owner_authorised_visible_qualification !== true || gate.release_authorised !== false || gate.sealed_unseen_accessed !== false || gate.sealed_unseen_authorised !== false || !Array.isArray(gate.blockers) || gate.blockers.length || !["critical4", "full69", "topic161", "frozen13"].every((name) => assessments[name]?.passed === true)) {
    throw new Error("Visible qualification final gate has not passed every required stage.");
  }
  if (checkpointSha256 && gate.checkpoint?.checkpoint_selection?.sha256 !== checkpointSha256) throw new Error("Visible gate is bound to a different checkpoint selection.");
  const bindings = {
    training_run_manifest: gate.checkpoint?.training_run_manifest?.sha256,
    adapter: gate.checkpoint?.adapter_weights?.sha256,
    adapter_config: gate.checkpoint?.adapter_config?.sha256,
    base_model: gate.checkpoint?.base_model_weights?.sha256,
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    if (expected && bindings[name] !== expected) throw new Error(`Visible gate ${name} hash does not match the selected checkpoint chain.`);
  }
  return { gatePath, gate };
}

export function validateUnseenAggregate(path, checkpointSha256, expectedHashes = {}) {
  const aggregatePath = requireExistingFile(path, "Sealed unseen aggregate");
  const aggregate = assertAggregateOnly(readJson(aggregatePath));
  if (aggregate.overall_release_gate !== "PASS") throw new Error("Sealed unseen aggregate is not PASS.");
  if (checkpointSha256 && aggregate.checkpoint_hashes?.checkpoint_selection_sha256 !== checkpointSha256) throw new Error("Sealed unseen aggregate is bound to a different checkpoint selection.");
  const bindings = {
    training_run_manifest: aggregate.checkpoint_hashes?.training_manifest_sha256,
    adapter: aggregate.checkpoint_hashes?.adapter_sha256,
    adapter_config: aggregate.checkpoint_hashes?.adapter_config_sha256,
    base_model: aggregate.checkpoint_hashes?.base_model_sha256,
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    if (expected && bindings[name] !== expected) throw new Error(`Sealed unseen ${name} hash does not match the selected checkpoint chain.`);
  }
  return { aggregatePath, aggregate };
}

export function validateLocalRelease(path, { checkpointSha256, visibleSha256, unseenSha256, corpusSha256, modelVersion = null, selectedIteration = null }) {
  const releasePath = requireExistingFile(path, "Owner-local release manifest");
  const release = readJson(releasePath);
  if (release.status !== "approved_for_owner_local_live" || release.release_authorised !== true || release.production_or_public_deployment_authorised !== false || release.deployment_scope !== "single-user loopback local application only") {
    throw new Error("Release manifest does not authorise only owner-local loopback use.");
  }
  const exact = release.checkpoint_sha256 === checkpointSha256 && release.bound_gates?.visible_qualification?.sha256 === visibleSha256 && release.bound_gates?.sealed_unseen_aggregate?.sha256 === unseenSha256 && release.approved_corpus_manifest?.sha256 === corpusSha256;
  if (!exact) throw new Error("Owner-local release manifest is not hash-bound to the supplied checkpoint, gates and corpus.");
  if ((modelVersion && release.model_version !== modelVersion) || (selectedIteration !== null && release.selected_iteration !== selectedIteration)) {
    throw new Error("Owner-local release manifest identifies a different selected model checkpoint.");
  }
  return { releasePath, release };
}

export function validateLiveSmoke(path, { releaseSha256, checkpointSha256, corpusSha256, modelId = null }) {
  const smokePath = requireExistingFile(path, "Owner-local live smoke evidence");
  const smoke = readJson(smokePath);
  if (smoke.version !== "owner-local-live-smoke-v1" || smoke.status !== "passed" || smoke.loopback_only !== true || smoke.production_or_public_deployment_authorised !== false || !Number.isInteger(smoke.questions_answered) || smoke.questions_answered < 1 || smoke.release_manifest_sha256 !== releaseSha256 || smoke.checkpoint_sha256 !== checkpointSha256 || smoke.approved_corpus_manifest_sha256 !== corpusSha256 || typeof smoke.model_id !== "string" || !smoke.model_id.trim()) {
    throw new Error("Owner-local smoke evidence is missing a passing, hash-bound loopback smoke record.");
  }
  if (modelId && smoke.model_id !== modelId) throw new Error("Owner-local smoke evidence identifies a different model checkpoint.");
  if (/"(?:question|answer|prompt|response|sources?|citations?|messages|user_id)"\s*:/i.test(JSON.stringify(smoke))) {
    throw new Error("Owner-local smoke evidence must contain outcome metadata only, not prompt, answer, source or user content.");
  }
  return { smokePath, smoke };
}

export function writeArtifactManifest(root, metadata) {
  const before = scanReleaseTree(root, { adapterDestinations: metadata.adapter_destinations || [] });
  const manifest = {
    schema_version: 1,
    manifest_type: metadata.manifest_type,
    build_id: metadata.build_id,
    deterministic: true,
    protected_content_included: false,
    sealed_unseen_detail_included: false,
    base_model_included: false,
    raw_corpus_included: false,
    files: before,
    source_artifact_hashes: metadata.source_artifact_hashes || {},
  };
  writeCanonicalJson(resolve(root, "ARTIFACT-MANIFEST.json"), manifest);
  const withManifest = scanReleaseTree(root, { adapterDestinations: metadata.adapter_destinations || [] });
  const sums = `${withManifest.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`;
  writeFileSync(resolve(root, "SHA256SUMS"), sums, { flag: "wx", mode: 0o644 });
  return { manifest, files: scanReleaseTree(root, { adapterDestinations: metadata.adapter_destinations || [] }) };
}

export function createDeterministicZip(root, zipPath, archiveRootName) {
  const source = requireExistingDirectory(root, "Review package staging root");
  const target = requireAbsentOutput(zipPath, "Review ZIP", { suffix: ".zip" });
  const prefix = canonicalRelative(archiveRootName);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  const program = `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
prefix = sys.argv[3]
files = sorted(p for p in root.rglob('*') if p.is_file())
with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        rel = path.relative_to(root).as_posix()
        info = zipfile.ZipInfo(f"{prefix}/{rel}", date_time=${FIXED_ZIP_DATETIME})
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (0o100644 & 0xFFFF) << 16
        with path.open('rb') as handle:
            archive.writestr(info, handle.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
`;
  const result = spawnSync(process.env.PYTHON || "python3", ["-c", program, source, temporary, prefix], { encoding: "utf8" });
  if (result.status !== 0 || !existsSync(temporary)) throw new Error(`Deterministic ZIP creation failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  renameSync(temporary, target);
  return { path: target, bytes: statSync(target).size, sha256: hashFile(target) };
}

export function portableRuntimeArtifacts({ training, selection }) {
  const portableTraining = {
    version: training.version,
    status: training.status,
    clean_start: training.clean_start,
    base_model: {
      repository: training.base_model?.repository,
      revision: training.base_model?.revision,
      source_model: training.base_model?.source_model,
      quantisation: training.base_model?.quantisation,
      path: "models/mlx/Qwen3-8B-4bit",
      model_sha256: training.base_model?.model_sha256,
      model_size_bytes: training.base_model?.model_size_bytes,
      config_sha256: training.base_model?.config_sha256,
      tokenizer_sha256: training.base_model?.tokenizer_sha256,
    },
    output_adapter: {
      path: "release-artifacts/selected-adapter",
      sha256: selection.adapter_sha256,
    },
    portable_export: {
    operational_paths_rebound: true,
    canonical_training_manifest_sha256: null,
    qualification_effect: "Path rebinding changes the manifest bytes. Use this with --checkpoint for owner-local development; canonical release evidence remains separately hash-bound.",
    },
  };
  const portableSelection = {
    version: selection.version,
    policy: selection.policy,
    model_version: selection.model_version,
    selected_iteration: selection.selected_iteration,
    selected_validation_loss: selection.selected_validation_loss,
    source_checkpoint: "release-artifacts/selected-adapter/adapters.safetensors",
    selected_adapter_path: "release-artifacts/selected-adapter",
    adapter_config_sha256: selection.adapter_config_sha256,
    adapter_sha256: selection.adapter_sha256,
    portable_export: {
    operational_paths_rebound: true,
    canonical_checkpoint_selection_sha256: null,
    qualification_effect: "This portable file is not the byte-identical checkpoint selection used for visible/unseen qualification.",
    },
  };
  return { portableTraining, portableSelection };
}

export function artifactRecord(path) {
  const file = requireExistingFile(path, basename(path));
  return { bytes: statSync(file).size, sha256: hashFile(file) };
}

export function validateHash(value, label) {
  if (!HASH.test(String(value || ""))) throw new Error(`${label} is not a SHA-256 digest.`);
  return String(value).toLowerCase();
}
