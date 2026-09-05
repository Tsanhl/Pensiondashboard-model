import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { assertPathAllowed } from "./protectedPaths.mjs";
import { safeHostEnvironment } from "./processEnvironment.mjs";
import { canonicalHash, readJson, sha256File } from "./utils.mjs";

function executablePath(projectRoot, value) {
  const path = isAbsolute(value) ? value : resolve(projectRoot,value);
  if (!existsSync(path)) throw Object.assign(new Error(`Pinned Python executable is missing: ${path}`), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
  return path;
}

export function verifyPythonEnvironments(projectRoot, config) {
  const manifestPath = assertPathAllowed(projectRoot,config.runtime.python_environment_manifest_path,config.protected_path_patterns);
  if (sha256File(manifestPath) !== config.runtime.python_environment_manifest_sha256 ||
      config.qualification_input_sha256?.[config.runtime.python_environment_manifest_path] !== config.runtime.python_environment_manifest_sha256) {
    throw Object.assign(new Error("Pinned Python environment manifest identity mismatch."), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
  }
  const manifest = readJson(manifestPath);
  if (manifest.version !== "qualification-python-environments-v2") throw Object.assign(new Error("Pinned Python environment manifest version mismatch."), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
  const fingerprintScript = assertPathAllowed(projectRoot,"scripts/pythonEnvironmentFingerprint.py",config.protected_path_patterns);
  const verified = {};
  for (const name of ["model","retrieval"]) {
    const expected = manifest.environments?.[name];
    if (!expected?.executable || !expected?.fingerprint?.roots?.length || !expected.requirements_path) throw Object.assign(new Error(`Pinned ${name} Python environment record is incomplete.`), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
    const requirementsPath = assertPathAllowed(projectRoot,expected.requirements_path,config.protected_path_patterns);
    if (sha256File(requirementsPath) !== expected.requirements_sha256) throw Object.assign(new Error(`Pinned ${name} Python requirements changed.`), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
    const executable = executablePath(projectRoot,expected.executable);
    const probe = spawnSync(executable,["-I","-B",fingerprintScript,"--roots",expected.fingerprint.roots.join(",")],{
      cwd:projectRoot,encoding:"utf8",timeout:config.runtime.python_fingerprint_timeout_ms,
      env:{ ...safeHostEnvironment(),PYTHONDONTWRITEBYTECODE:"1",PYTHONHASHSEED:"0" },
    });
    if (probe.status !== 0) throw Object.assign(new Error(`Pinned ${name} Python environment probe failed: ${String(probe.stderr || probe.stdout || "").slice(0,500)}`), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
    let actual;
    try { actual = JSON.parse(probe.stdout); } catch { throw Object.assign(new Error(`Pinned ${name} Python environment probe returned invalid JSON.`), { code:"PYTHON_ENVIRONMENT_MISMATCH" }); }
    if (actual.startup_contract?.isolated !== true || actual.startup_contract?.no_user_site !== true || actual.startup_contract?.ignore_environment !== true || actual.startup_contract?.safe_path !== true || actual.startup_contract?.dont_write_bytecode !== true || actual.startup_contract?.user_site_enabled !== false) {
      throw Object.assign(new Error(`Pinned ${name} Python environment is not isolated from environment and user-site startup.`), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
    }
    if (!Array.isArray(actual.import_trees) || actual.import_trees.length !== actual.startup_contract.sys_path.length ||
        actual.import_trees.some((tree,index) => tree.root !== actual.startup_contract.sys_path[index] || !Number.isInteger(tree.entries) || !/^[0-9a-f]{64}$/.test(String(tree.records_sha256 || "")))) {
      throw Object.assign(new Error(`Pinned ${name} Python import trees are not completely fingerprinted.`), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
    }
    if (canonicalHash(actual) !== canonicalHash(expected.fingerprint)) throw Object.assign(new Error(`Pinned ${name} Python interpreter or dependency content mismatch.`), { code:"PYTHON_ENVIRONMENT_MISMATCH" });
    verified[name] = { executable,environment_sha256:canonicalHash(actual),requirements_sha256:expected.requirements_sha256 };
  }
  return { manifest_path:manifestPath,manifest_sha256:config.runtime.python_environment_manifest_sha256,environments:verified,environment_sha256:canonicalHash(verified) };
}
