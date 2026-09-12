import { createHash } from "node:crypto";
import { existsSync,mkdirSync,readFileSync,writeFileSync } from "node:fs";
import { dirname,relative,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAggregateOnly } from "./lib/sealedUnseenOneShotV1.mjs";
import {
  PINNED_RETRIEVAL_MANIFEST_SHA256,
  PINNED_RETRIEVAL_SERVER_SHA256,
  pinnedRetrievalIdentity,
} from "../server/services/pinnedRetrievalIdentity.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../",import.meta.url)));
const CONFIRMATION = "owner_authorised_local_live_after_visible_and_unseen_pass";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function projectFile(name) {
  const path = resolve(required(name));
  const rel = relative(PROJECT_ROOT,path);
  if (!rel || rel.startsWith("..") || !existsSync(path)) throw new Error(`${name} must name an existing file inside the project.`);
  return path;
}

function artifact(path) {
  const bytes = readFileSync(path);
  return { path:relative(PROJECT_ROOT,path),sha256:sha256(bytes),bytes:bytes.length };
}

function json(path,label) {
  try { return JSON.parse(readFileSync(path,"utf8")); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}

if (required("LOCAL_LIVE_RELEASE_CONFIRMATION") !== CONFIRMATION) {
  throw new Error(`LOCAL_LIVE_RELEASE_CONFIRMATION must equal ${CONFIRMATION}.`);
}

const checkpointPath = projectFile("LOCAL_LIVE_CHECKPOINT_PATH");
const visiblePath = projectFile("LOCAL_LIVE_VISIBLE_GATE_PATH");
const unseenPath = projectFile("LOCAL_LIVE_UNSEEN_AGGREGATE_PATH");
const corpusPath = projectFile("APPROVED_CORPUS_MANIFEST_PATH");
const checkpointRecord = artifact(checkpointPath);
const visibleRecord = artifact(visiblePath);
const unseenRecord = artifact(unseenPath);
const corpusRecord = artifact(corpusPath);
const retrievalManifestRecord = artifact(resolve(PROJECT_ROOT,"models/model-manifest.json"));
const retrievalServerRecord = artifact(resolve(PROJECT_ROOT,"ml/embedding_server.py"));
const retrievalIdentityModuleRecord = artifact(resolve(PROJECT_ROOT,"server/services/pinnedRetrievalIdentity.js"));
const checkpoint = json(checkpointPath,"Checkpoint selection");
const visible = json(visiblePath,"Visible qualification gate");
const unseen = assertAggregateOnly(json(unseenPath,"Sealed unseen aggregate"));
const corpus = json(corpusPath,"Approved corpus manifest");

if (visible.version !== "post-training-visible-qualification-v1-gate-v1" || visible.stage !== "final" ||
  visible.passed !== true || visible.owner_authorised_visible_qualification !== true || visible.release_authorised !== false ||
  visible.sealed_unseen_accessed !== false || visible.sealed_unseen_authorised !== false ||
  visible.status !== "passed_owner_authorised_visible_qualification" || !Array.isArray(visible.blockers) || visible.blockers.length ||
  !Array.isArray(visible.checks) || !visible.checks.length || visible.checks.some((row) => row?.passed !== true) ||
  !["critical4","full69","topic161","frozen13"].every((name) => visible.assessments?.[name]?.passed === true) ||
  visible.checkpoint?.checkpoint_selection?.sha256 !== checkpointRecord.sha256 ||
  visible.checkpoint?.checkpoint_selection?.bytes !== checkpointRecord.bytes) {
  throw new Error("Visible qualification gate has not passed in the required pre-release state.");
}
if (unseen.overall_release_gate !== "PASS" || unseen.checkpoint_hashes.checkpoint_selection_sha256 !== checkpointRecord.sha256) {
  throw new Error("Sealed unseen did not pass against this exact checkpoint.");
}
if (unseen.runtime_hashes.approved_corpus_manifest_sha256 !== corpusRecord.sha256 || corpus.approval_status !== "approved") {
  throw new Error("The approved corpus does not match the one-shot runtime pin.");
}
if (retrievalManifestRecord.sha256 !== PINNED_RETRIEVAL_MANIFEST_SHA256 ||
  retrievalServerRecord.sha256 !== PINNED_RETRIEVAL_SERVER_SHA256 ||
  unseen.code_hashes?.["models/model-manifest.json"] !== retrievalManifestRecord.sha256 ||
  unseen.code_hashes?.["ml/embedding_server.py"] !== retrievalServerRecord.sha256 ||
  unseen.code_hashes?.["server/services/pinnedRetrievalIdentity.js"] !== retrievalIdentityModuleRecord.sha256) {
  throw new Error("The owner-local release is not bound to the pinned retrieval runtime used by sealed unseen.");
}
if (!checkpoint.selected_adapter_path || !Number.isInteger(checkpoint.selected_iteration)) {
  throw new Error("Checkpoint selection is incomplete.");
}

const outputPath = resolve(process.env.LOCAL_LIVE_RELEASE_OUT || resolve(PROJECT_ROOT,"runtime/local-live-release.json"));
const manifest = {
  version:"owner-local-live-release-v1",
  status:"approved_for_owner_local_live",
  release_authorised:true,
  deployment_scope:"single-user loopback local application only",
  production_or_public_deployment_authorised:false,
  legal_advice_status:"The application remains an information and routing tool, not a substitute for regulated financial or legal advice.",
  approved_by:"Tsanhl (project owner)",
  approved_at:new Date().toISOString(),
  checkpoint_path:checkpointRecord.path,
  checkpoint_sha256:checkpointRecord.sha256,
  model_version:checkpoint.model_version,
  selected_iteration:checkpoint.selected_iteration,
  approved_corpus_manifest:corpusRecord,
  pinned_retrieval_runtime:{
    identity:pinnedRetrievalIdentity(),
    model_manifest:retrievalManifestRecord,
    server_source:retrievalServerRecord,
    identity_module:retrievalIdentityModuleRecord,
  },
  bound_gates:{ visible_qualification:visibleRecord,sealed_unseen_aggregate:unseenRecord },
};

mkdirSync(dirname(outputPath),{ recursive:true });
writeFileSync(outputPath,`${JSON.stringify(manifest,null,2)}\n`);
console.log(JSON.stringify({ ...artifact(outputPath),status:manifest.status,model_version:manifest.model_version },null,2));
