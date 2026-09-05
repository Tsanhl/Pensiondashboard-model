import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname,relative,resolve } from "node:path";

const DASHBOARD_ONLY_KEYS = Object.freeze([
  "QUALIFICATION_CONTEXT_HMAC_KEY",
  "QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM",
  "QUALIFICATION_NONCE_STORE_PATH",
  "QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH",
  "QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256",
]);

export function runtimeChildEnvironment(sharedEnvironment,qualificationDashboardEnvironment,childName) {
  const result = { ...sharedEnvironment };
  for (const key of DASHBOARD_ONLY_KEYS) delete result[key];
  if (childName === "dashboard") Object.assign(result,qualificationDashboardEnvironment || {});
  return result;
}

function sandboxLiteral(path) {
  return JSON.stringify(String(path));
}

function pathAncestors(path) {
  const values = [];
  let cursor = resolve(path);
  while (true) {
    values.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return values;
}

function canonicalDirectory(path,projectRoot,label) {
  const candidate = resolve(path);
  mkdirSync(candidate,{ recursive:true });
  const canonical = realpathSync.native(candidate);
  const rel = relative(projectRoot,canonical);
  if (!rel || rel.startsWith("..") || resolve(projectRoot,rel) !== canonical) throw new Error(`${label} leaves the project or resolves to its root.`);
  return canonical;
}

export function qualificationRuntimeChildSandboxProfile({ runRoot,projectRoot,nonceStorePath,allowedContextManifestPath,childName,databasePath }) {
  const canonicalProjectRoot = realpathSync.native(projectRoot);
  const protectedRoot = existsSync(runRoot) ? realpathSync.native(runRoot) : String(runRoot);
  const controllerRoot = dirname(dirname(protectedRoot));
  const writable = [];
  if (childName === "dashboard") {
    writable.push(canonicalDirectory(nonceStorePath,canonicalProjectRoot,"Qualification nonce store"));
    writable.push(canonicalDirectory(dirname(databasePath),canonicalProjectRoot,"Qualification database directory"));
  }
  return [
    "(version 1)","(allow default)",
    `(deny file-write* (subpath ${sandboxLiteral(canonicalProjectRoot)}))`,
    `(deny file-read* file-write* (subpath ${sandboxLiteral(controllerRoot)}))`,
    ...pathAncestors(canonicalProjectRoot).map((path) => `(deny file-write* (literal ${sandboxLiteral(path)}))`),
    ...writable.map((path) => `(allow file-read* file-write* (subpath ${sandboxLiteral(path)}))`),
    ...(childName === "dashboard" && allowedContextManifestPath ? [`(allow file-read* (literal ${sandboxLiteral(resolve(allowedContextManifestPath))}))`] : []),
    `(deny file-read* file-write* (literal ${sandboxLiteral(resolve(controllerRoot,"controller-integrity-private.pem"))}))`,
    "(deny process-info*)",
  ].join("\n");
}

export { DASHBOARD_ONLY_KEYS };
