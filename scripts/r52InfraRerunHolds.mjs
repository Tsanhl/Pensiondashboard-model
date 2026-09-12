import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANK = JSON.parse(readFileSync(join(ROOT, "training/live-demo-round-50-20260902/questions.json"), "utf8"));
const OUT = join(ROOT, "Log/2026-09-02/live-round-52-final/infra-rerun");
const BASE = process.env.LIVE_BASE_URL || "http://127.0.0.1:3000";
const USER = "alex-morgan";
const TIMEOUT_MS = Number(process.env.LIVE_CHAT_TIMEOUT_MS || 320_000);
const HOLD_IDS = ["L22", "L24", "L41", "L42", "L44"];

mkdirSync(OUT, { recursive: true });

function specById(id) {
  return (BANK.questions || []).find((item) => item.id === id);
}

async function postChat(message, attempt = 1) {
  const body = { client_request_id: randomUUID(), message };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-demo-user-id": USER },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const elapsedMs = Date.now() - started;
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 800) }; }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 4000 * attempt));
      return postChat(message, attempt + 1);
    }
    return { ok: response.ok, status: response.status, elapsedMs, data };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return postChat(message, attempt + 1);
    }
    return { ok: false, status: 0, elapsedMs, data: { error: error.message || String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

const items = [];
for (const id of HOLD_IDS) {
  const spec = specById(id);
  console.log(`infra-rerun ${id} …`);
  const posted = await postChat(spec.question);
  const answer = posted.data?.response || posted.data?.answer || posted.data?.error || "";
  const row = {
    id,
    variant: "infra_rerun_once",
    question: spec.question,
    ok: posted.ok,
    http_status: posted.status,
    elapsed_ms: posted.elapsedMs,
    confidence: posted.data?.confidence || null,
    sources: posted.data?.sources || [],
    answer,
    session_id: posted.data?.session_id || null
  };
  writeFileSync(join(OUT, `${id}.json`), `${JSON.stringify(row, null, 2)}\n`);
  items.push(row);
  console.log(`  conf=${row.confidence} ${row.elapsed_ms}ms ${String(answer).slice(0, 120).replaceAll("\n", " ")}`);
  await new Promise((resolve) => setTimeout(resolve, 8000));
}

writeFileSync(join(OUT, "summary.json"), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  authorised: "one exact-question rerun for HOLD_EVALUATION_INFRA against unchanged candidate",
  ids: HOLD_IDS,
  items
}, null, 2)}\n`);
console.log("wrote", OUT);
