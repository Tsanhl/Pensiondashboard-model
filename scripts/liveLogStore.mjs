import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, durableMkdir } from "./lib/qualification-worker/utils.mjs";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOG_ROOT = join(PROJECT_ROOT, "Log");
const SETS_PATH = join(LOG_ROOT, "sets.json");

export function hongKongDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

export function slug(text, limit = 48) {
  const value = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (value || "question").slice(0, limit).replace(/-$/, "");
}

export function questionFolderName(item) {
  return `${item.id}-${slug(item.issue || item.id)}`;
}

function defaultSets() {
  return {
    layout: "Log/YYYY-MM-DD/live-round-N/Lxx-issue/",
    timezone: "Asia/Hong_Kong",
    next_set_number: 51,
    sets: []
  };
}

export function readSets() {
  if (!existsSync(SETS_PATH)) return defaultSets();
  try { return { ...defaultSets(), ...JSON.parse(readFileSync(SETS_PATH, "utf8")) }; }
  catch { return defaultSets(); }
}

export function writeSets(sets) {
  durableMkdir(LOG_ROOT);
  atomicWrite(SETS_PATH,sets);
}

export function setDir(day, setName) {
  return join(LOG_ROOT, day, setName);
}

function writeJson(path, value) {
  atomicWrite(path,value);
}

export function ensureSetFolder({ day, setName, status = "ready", model = "", user = "alex-morgan", note = "" }) {
  const dir = setDir(day, setName);
  durableMkdir(dir);
  const statusPath = join(dir, "status.json");
  if (!existsSync(statusPath)) {
    writeJson(statusPath, {
      day,
      set: setName,
      status,
      model,
      user,
      note: note || "Question folders are created when this live set is run.",
      updated_at: new Date().toISOString()
    });
  }
  return dir;
}

export function allocateNextSet({ day = hongKongDay(), model = "", user = "alex-morgan" } = {}) {
  durableMkdir(LOG_ROOT);
  const sets = readSets();
  const dayDir = join(LOG_ROOT, day);
  if (existsSync(dayDir)) {
    const open = readdirSync(dayDir)
      .filter((name) => name.startsWith("live-round-"))
      .sort((left, right) => Number(left.replace("live-round-", "")) - Number(right.replace("live-round-", "")));
    for (const name of open) {
      const statusPath = join(dayDir, name, "status.json");
      if (!existsSync(statusPath)) continue;
      const current = JSON.parse(readFileSync(statusPath, "utf8"));
      if (current.status === "in_progress") {
        return { day, setName: name, dir: join(dayDir, name) };
      }
    }
  }
  const setName = `live-round-${sets.next_set_number}`;
  const dir = ensureSetFolder({
    day,
    setName,
    status: "in_progress",
    model,
    user,
    note: "Live question set in progress. Each question writes its own folder."
  });
  const existing = sets.sets.find((item) => item.day === day && item.set === setName);
  if (!existing) sets.sets.push({ day, set: setName, status: "in_progress", n: 0 });
  else existing.status = "in_progress";
  sets.next_set_number = Math.max(Number(sets.next_set_number) || 1, Number(String(setName).replace("live-round-", "")) + 1);
  writeSets(sets);
  writeJson(join(dir, "status.json"), {
    day,
    set: setName,
    status: "in_progress",
    model,
    user,
    started_at: new Date().toISOString(),
    note: "Live question set in progress. Each question writes its own folder."
  });
  return { day, setName, dir };
}

export function writeQuestionLog(dir, record) {
  const folder = questionFolderName(record);
  const qdir = join(dir, folder);
  durableMkdir(qdir);
  const payload = { ...record, folder, logged_at: record.logged_at || new Date().toISOString() };
  writeJson(join(qdir, "record.json"), payload);
  atomicWrite(join(qdir, "question.txt"),`${record.question || ""}\n`);
  atomicWrite(join(qdir, "answer.txt"),`${record.answer || record.response || ""}\n`);
  const review = [
    `Verdict: ${record.verdict || "unscored"}`,
    `Issue: ${record.issue || ""}`,
    `Category: ${record.category || ""}`,
    `Confidence: ${record.confidence || ""}`,
    "",
    "Expected:",
    record.expected || record.pass_if || "",
    "",
    "Review:",
    record.review || record.auto_note || "Not yet human-scored. See auto flags in record.json.",
    ""
  ].join("\n");
  atomicWrite(join(qdir, "review.txt"),`${review}\n`);
  return folder;
}

export function refreshSetSummary(dir, { day, setName, model, user } = {}) {
  const folders = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const questions = [];
  const wrongs = [];
  const counts = { pass: 0, partial: 0, fail: 0, unscored: 0, "auto-pass": 0, "auto-fail": 0 };
  for (const entry of folders) {
    const recordPath = join(dir, entry.name, "record.json");
    if (!existsSync(recordPath)) continue;
    const rec = JSON.parse(readFileSync(recordPath, "utf8"));
    const verdict = rec.verdict || "unscored";
    questions.push({
      id: rec.id,
      folder: entry.name,
      verdict,
      category: rec.category,
      issue: rec.issue,
      question: rec.question
    });
    if (counts[verdict] == null) counts[verdict] = 0;
    counts[verdict] += 1;
    if (["fail", "partial", "auto-fail"].includes(verdict)) wrongs.push(rec);
  }
  questions.sort((left, right) => String(left.id).localeCompare(String(right.id), undefined, { numeric: true }));
  const summary = {
    day: day || "",
    set: setName || "",
    logged_at: new Date().toISOString(),
    model: model || "",
    user: user || "alex-morgan",
    n: questions.length,
    counts,
    questions,
    wrong_folders: wrongs.map((item) => item.folder || questionFolderName(item))
  };
  writeJson(join(dir, "summary.json"), summary);
  atomicWrite(join(dir, "wrongs.jsonl"),wrongs.map((item) => JSON.stringify(item)).join("\n") + (wrongs.length ? "\n" : ""));
  return summary;
}

export function completeSet(dir, meta) {
  const summary = refreshSetSummary(dir, meta);
  writeJson(join(dir, "status.json"), {
    day: meta.day,
    set: meta.setName,
    status: "complete",
    model: meta.model,
    user: meta.user,
    completed_at: new Date().toISOString(),
    n: summary.n,
    counts: summary.counts
  });
  const sets = readSets();
  const found = sets.sets.find((item) => item.day === meta.day && item.set === meta.setName);
  if (found) {
    found.status = "complete";
    found.n = summary.n;
    found.counts = summary.counts;
  }
  writeSets(sets);
  return summary;
}

export function autoVerdict(spec, record) {
  if (record.auto?.hit_must_not) return "auto-fail";
  if (Array.isArray(spec.must_include) && spec.must_include.length) {
    if (record.auto?.has_must_include) return "auto-pass";
    return "auto-fail";
  }
  return "unscored";
}
