import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const KEY_ENV_PATTERN = /(?:SEALED|UNSEEN).*(?:KEY|TOKEN)|(?:KEY|TOKEN).*(?:SEALED|UNSEEN)/i;

export function assertNoProtectedCredentials(environment = process.env) {
  const exposed = Object.keys(environment).filter((key) => KEY_ENV_PATTERN.test(key) && String(environment[key] || "").trim());
  if (exposed.length) throw Object.assign(new Error(`Protected unseen credential present in worker environment: ${exposed.join(", ")}`), { code: "PROTECTED_DATA_BOUNDARY" });
}

export function assertPathAllowed(root, candidate, patterns = []) {
  const absoluteRoot = realpathSync.native(resolve(root));
  const absolute = resolve(absoluteRoot, candidate);
  const rel = relative(absoluteRoot, absolute);
  if (rel.startsWith("..") || resolve(absoluteRoot, rel) !== absolute) {
    throw Object.assign(new Error(`Path leaves the project root: ${candidate}`), { code: "PROTECTED_DATA_BOUNDARY" });
  }
  const normalized = rel.toLowerCase();
  const match = patterns.find((pattern) => normalized.includes(String(pattern).toLowerCase()));
  if (match) throw Object.assign(new Error(`Protected path refused (${match}): ${rel}`), { code: "PROTECTED_DATA_BOUNDARY" });
  const parts = rel.split(sep).filter(Boolean);
  let cursor = absoluteRoot;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw Object.assign(new Error(`Symlink path refused: ${relative(absoluteRoot, cursor)}`), { code: "PROTECTED_DATA_BOUNDARY" });
  }
  if (existsSync(absolute)) {
    const real = realpathSync.native(absolute);
    const realRelative = relative(absoluteRoot, real);
    if (realRelative.startsWith("..") || resolve(absoluteRoot, realRelative) !== real) {
      throw Object.assign(new Error(`Real path leaves the project root: ${candidate}`), { code: "PROTECTED_DATA_BOUNDARY" });
    }
    const realNormalized = realRelative.toLowerCase();
    const realMatch = patterns.find((pattern) => realNormalized.includes(String(pattern).toLowerCase()));
    if (realMatch) throw Object.assign(new Error(`Protected real path refused (${realMatch}): ${realRelative}`), { code: "PROTECTED_DATA_BOUNDARY" });
  }
  return absolute;
}

export function assertCommandAllowed(command, args = [], config) {
  const joined = [command, ...args].join(" ").toLowerCase();
  const denied = [
    [/(?:^|\s)(?:git\s+)?push(?:\s|$)/, "git push"],
    [/remote\s+(?:set-url|add|remove|rename)/, "origin change"],
    [/sealed[-_ ]?unseen|unseen[-_ ]?gold|gold-answers\.sealed/, "sealed unseen"],
    [/(?:^|[\s/_.-])(?:train|training)(?:[\s/_.-]|[a-z0-9_-])*(?:mlx|adapter)|(?:t4train|trainmlx|trainadapter|adaptertrain)/i, "training"],
    [/\b(?:deploy|release:approve|publish)\b/, "release"],
  ];
  for (const [pattern, label] of denied) {
    if (!pattern.test(joined)) continue;
    const permitted = label === "training" ? config.permissions.allow_training
      : label === "sealed unseen" ? config.permissions.allow_sealed_unseen
        : label === "git push" ? config.permissions.allow_git_push
          : label === "origin change" ? config.permissions.allow_origin_change
            : config.permissions.allow_release;
    if (!permitted) throw Object.assign(new Error(`Worker policy refused ${label} command.`), { code: "PROTECTED_DATA_BOUNDARY" });
  }
}
