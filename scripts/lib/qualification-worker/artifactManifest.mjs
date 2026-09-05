import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { atomicWrite, canonicalHash, fileRecord, now } from "./utils.mjs";

export function captureBindings(root, paths) {
  return Object.fromEntries(paths.map((path) => [path, fileRecord(root, path)]));
}

export function compareBindings(root, bindings) {
  const changed = [];
  for (const [path, expected] of Object.entries(bindings || {})) {
    try {
      const actual = fileRecord(root, path);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) changed.push({ path, expected, actual });
    } catch (error) {
      changed.push({ path, expected, actual: null, error: error.message });
    }
  }
  return changed;
}

function walk(root, current, rows) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact symlink refused: ${relative(root, path)}`);
    if (entry.isDirectory()) walk(root, path, rows);
    else if (entry.isFile()) rows.push(fileRecord(root, relative(root, path)));
  }
}

export function manifestDirectory(projectRoot, directory, outputPath, extra = {}) {
  const absolute = resolve(projectRoot, directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`Artifact directory missing: ${directory}`);
  const files = [];
  walk(projectRoot, absolute, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { version: "qualification-artifact-manifest-v1", generated_at: now(), root: relative(projectRoot, absolute), files, files_sha256: canonicalHash(files), ...extra };
  atomicWrite(outputPath, manifest);
  return manifest;
}

export function ensureAttemptDirectory(path) {
  if (existsSync(path)) throw new Error(`Immutable attempt directory already exists: ${path}`);
  mkdirSync(path, { recursive: false });
}

export function directoryRecords(projectRoot, directory) {
  const absolute = resolve(projectRoot, directory);
  const files = [];
  walk(projectRoot, absolute, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, join(base, "index.js"), join(base, "index.mjs"), join(base, "index.cjs")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Local import could not be resolved from ${importer}: ${specifier}`);
}

export function discoverTransitiveLocalImports(projectRoot, entryPaths) {
  const root = resolve(projectRoot);
  const pending = entryPaths.map((path) => resolve(root, path));
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Executable dependency is missing or a symlink: ${relative(root, path)}`);
    const rel = relative(root, path);
    if (rel.startsWith("..")) throw new Error(`Executable dependency leaves project root: ${path}`);
    visited.add(path);
    if (![".js", ".mjs", ".cjs"].includes(extname(path))) continue;
    const source = readFileSync(path, "utf8");
    const patterns = [/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g, /import\(\s*["']([^"']+)["']\s*\)/g, /require\(\s*["']([^"']+)["']\s*\)/g];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const dependency = resolveImport(path, match[1]);
        if (dependency && !visited.has(dependency)) pending.push(dependency);
      }
    }
  }
  return [...visited].map((path) => relative(root, path)).sort();
}

export function validateArtifactRecords(projectRoot, records = []) {
  const failures = [];
  for (const expected of records) {
    try {
      const actual = fileRecord(projectRoot, expected.path);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) failures.push({ path: expected.path, expected, actual });
    } catch (error) { failures.push({ path: expected.path, expected, error: error.message }); }
  }
  return failures;
}
