import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./lib/qualification-worker/utils.mjs";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const TRAINING_ROOT = resolve(PROJECT_ROOT, "training");
export const CYCLE_ROOT = resolve(TRAINING_ROOT, "evaluation-cycle-v1");
export const INPUTS = Object.freeze({
  markdown:resolve(TRAINING_ROOT, "GOLD-ANSWER-REVIEW.md"),
  answerReview:resolve(TRAINING_ROOT, "gold-answer-review.json"),
  evaluationDraft:resolve(TRAINING_ROOT, "gold-evaluation-draft.json")
});

export function isoNow() {
  return new Date().toISOString();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFile(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function fileManifest(path) {
  const stat = statSync(path);
  return {
    path,
    bytes:stat.size,
    modified_at:stat.mtime.toISOString(),
    sha256:hashFile(path)
  };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJsonAtomic(path, value) {
  atomicWrite(path,value);
}

export function writeTextAtomic(path, value) {
  atomicWrite(path,String(value));
}

export function normaliseQuestion(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9£%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function countBy(values) {
  return values.reduce((counts, value) => {
    const key = String(value ?? "missing");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

export function unique(values) {
  return [...new Set(values)];
}

export function markdownTable(headers, rows) {
  const escape = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`)
  ].join("\n");
}
