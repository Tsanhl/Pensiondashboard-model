import { closeSync, lstatSync, openSync, readlinkSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { assertPathAllowed } from "./protectedPaths.mjs";
import { canonicalHash, readJson, sha256File } from "./utils.mjs";

function hashFile(path) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path,"r");
  try {
    for (;;) {
      const bytes = readSync(descriptor,buffer,0,buffer.length,null);
      if (!bytes) break;
      digest.update(buffer.subarray(0,bytes));
    }
  } finally { closeSync(descriptor); }
  return digest.digest("hex");
}

function walk(root,current,records) {
  for (const entry of readdirSync(current,{ withFileTypes:true }).sort((a,b) => Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)))) {
    const path = join(current,entry.name);
    const rel = relative(root,path);
    const lstat = lstatSync(path);
    if (lstat.isSymbolicLink()) {
      const targetRealpath = realpathSync.native(path);
      const targetStat = statSync(targetRealpath);
      if (!targetStat.isFile()) throw new Error(`Runtime artifact symlink does not resolve to a file: ${path}`);
      records.push({ path:rel,type:"symlink",link_target:readlinkSync(path),target_realpath:targetRealpath,bytes:targetStat.size,sha256:hashFile(targetRealpath) });
    } else if (lstat.isDirectory()) {
      records.push({ path:rel,type:"directory" });
      walk(root,path,records);
    } else if (lstat.isFile()) {
      records.push({ path:rel,type:"file",bytes:lstat.size,sha256:hashFile(path) });
    } else throw new Error(`Unsupported runtime artifact type: ${path}`);
  }
}

export function captureRuntimeDirectory(rootPath) {
  const root = realpathSync.native(resolve(rootPath));
  const records = [];
  walk(root,root,records);
  records.sort((a,b) => Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  return { root,records,records_sha256:canonicalHash(records) };
}

function verifyManifestIdentity(projectRoot,config,pathKey,shaKey) {
  const relativePath = config.runtime[pathKey];
  const expectedSha = config.runtime[shaKey];
  const path = assertPathAllowed(projectRoot,relativePath,config.protected_path_patterns);
  if (sha256File(path) !== expectedSha || config.qualification_input_sha256?.[relativePath] !== expectedSha) throw Object.assign(new Error(`Runtime artifact manifest identity mismatch: ${relativePath}`),{ code:"RUNTIME_ARTIFACT_MISMATCH" });
  return { path,manifest:readJson(path),sha256:expectedSha };
}

export function verifyRuntimeArtifactManifests(projectRoot,config) {
  const baseRecord = verifyManifestIdentity(projectRoot,config,"base_model_directory_manifest_path","base_model_directory_manifest_sha256");
  const base = baseRecord.manifest;
  const expectedBaseRoot = realpathSync.native(resolve(projectRoot,config.candidate.base_model_path,".."));
  const actualBase = captureRuntimeDirectory(expectedBaseRoot);
  if (base.version !== "base-model-directory-manifest-v1" || base.root !== expectedBaseRoot || base.records_sha256 !== canonicalHash(base.records || []) ||
      actualBase.records_sha256 !== base.records_sha256 || canonicalHash(actualBase.records) !== canonicalHash(base.records || [])) {
    throw Object.assign(new Error("Complete base-model directory identity mismatch."),{ code:"CANDIDATE_IDENTITY_MISMATCH" });
  }

  const retrievalRecord = verifyManifestIdentity(projectRoot,config,"retrieval_snapshot_manifest_path","retrieval_snapshot_manifest_sha256");
  const retrieval = retrievalRecord.manifest;
  const snapshotRows = [];
  if (retrieval.version !== "retrieval-snapshot-manifest-v1") throw Object.assign(new Error("Retrieval snapshot manifest version mismatch."),{ code:"RUNTIME_ARTIFACT_MISMATCH" });
  for (const name of ["embedding","reranker"]) {
    const expected = retrieval.snapshots?.[name];
    if (!expected?.root || expected.records_sha256 !== canonicalHash(expected.records || [])) throw Object.assign(new Error(`Retrieval ${name} snapshot manifest is incomplete.`),{ code:"RUNTIME_ARTIFACT_MISMATCH" });
    const actual = captureRuntimeDirectory(expected.root);
    if (actual.root !== expected.root || actual.records_sha256 !== expected.records_sha256 || canonicalHash(actual.records) !== canonicalHash(expected.records)) {
      throw Object.assign(new Error(`Retrieval ${name} snapshot content mismatch.`),{ code:"RUNTIME_ARTIFACT_MISMATCH" });
    }
    snapshotRows.push({ name,repository:expected.repository,revision:expected.revision,root:expected.root,records_sha256:expected.records_sha256 });
  }
  const snapshotContentsSha256 = canonicalHash(snapshotRows);
  if (retrieval.snapshot_contents_sha256 !== snapshotContentsSha256) throw Object.assign(new Error("Retrieval snapshot combined digest mismatch."),{ code:"RUNTIME_ARTIFACT_MISMATCH" });
  return {
    base_model_directory_manifest_sha256:baseRecord.sha256,base_model_directory_sha256:base.records_sha256,
    retrieval_snapshot_manifest_sha256:retrievalRecord.sha256,retrieval_snapshot_contents_sha256:snapshotContentsSha256,
  };
}
