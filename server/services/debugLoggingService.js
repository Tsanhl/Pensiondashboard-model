import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(process.env.LOGGING_ROOT || "Logging");
const CATEGORIES = new Set(["grounding-failures", "fallbacks", "retrieval-quality", "freshness"]);

function dateFolder(now = new Date()) {
  const timezone = process.env.LOG_TIMEZONE || "Asia/Hong_Kong";
  return new Intl.DateTimeFormat("en-CA", { timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit" }).format(now);
}

export function privacyHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function sanitise(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitise(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 1000) : value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|api.?key|raw.?text|snippet/i.test(key))
    .map(([key, item]) => [key, sanitise(item, depth + 1)]));
}

export async function writeDebugLog(category, event = {}) {
  if (!CATEGORIES.has(category)) throw new Error(`Unsupported debug log category: ${category}`);
  const folder = resolve(ROOT, dateFolder());
  await mkdir(folder, { recursive:true });
  const entry = sanitise({ timestamp:new Date().toISOString(),category,...event });
  await appendFile(resolve(folder, `${category}.jsonl`), `${JSON.stringify(entry)}\n`, { encoding:"utf8",mode:0o600 });
  return entry;
}

export function safeLog(category, event) {
  if (String(process.env.DISABLE_DEBUG_LOGGING || "false").toLowerCase() === "true") return;
  writeDebugLog(category, event).catch((error) => console.warn(`Debug logging failed: ${error.message}`));
}

export function requestLogContext({ userId, sessionId, requestId, query } = {}) {
  const includeText = String(process.env.DEBUG_LOG_INCLUDE_TEXT || "false").toLowerCase() === "true";
  return {
    userHash:privacyHash(userId).slice(0, 16),sessionId,requestId,intent:query?.intent,
    queryHash:privacyHash(query?.self_contained_query || ""),
    ...(includeText ? { queryPreview:String(query?.self_contained_query || "").slice(0, 300) } : {})
  };
}

export function loggingStatus() {
  return { root:ROOT,datePartitioned:true,format:"jsonl",rawTextIncluded:String(process.env.DEBUG_LOG_INCLUDE_TEXT || "false").toLowerCase() === "true" };
}
