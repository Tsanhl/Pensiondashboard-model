import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { processQuery } from "../server/services/queryProcessorService.js";
import { autoVerdict } from "./liveLogStore.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "Log/2026-09-02/live-round-51-adjudicated/targeted-delta");
const BANK = JSON.parse(readFileSync(join(ROOT, "training/live-demo-round-50-20260902/questions.json"), "utf8"));
const MAP = JSON.parse(readFileSync(join(ROOT, "Log/2026-09-02/live-round-51-adjudicated/late-patch-dependency-map.json"), "utf8"));
const BASE = process.env.LIVE_BASE_URL || "http://127.0.0.1:3000";
const USER = "alex-morgan";
const TIMEOUT_MS = Number(process.env.LIVE_CHAT_TIMEOUT_MS || 320_000);

const PARAPHRASES = {
  L06: "How much remains in the deferred Standard Life pot from Harbour Logistics?",
  L18: "What is my current projected monthly retirement income on the dashboard?",
  L20: "How much emergency savings do I have recorded, and should I stop pension contributions?",
  L27: "Would combining every pension I have into one pot be the right move for me?",
  L29: "How do I trace a pension from an employer before Harbour Logistics that is not on the dashboard?",
  L31: "If Northbridge makes me redundant, which workplace pensions should I review?",
  L37: "What official legal process applies if my workplace pension scheme is changed?",
  L41: "If I die before retirement, who is guaranteed to receive my pensions?",
  L47: "Is there a defined benefit scheme among the pensions shown on my dashboard?"
};

const ORIGINALS = [...new Set([
  ...(MAP.mandatory_targeted || []),
  "L38",
  "L42"
])].sort();

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
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2500 * attempt));
      return postChat(message, attempt + 1);
    }
    return { ok: response.ok, status: response.status, elapsedMs, data };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return postChat(message, attempt + 1);
    }
    return { ok: false, status: 0, elapsedMs, data: { error: error.message || String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

async function conversationTrace(sessionId) {
  if (!sessionId) return null;
  try {
    const response = await fetch(`${BASE}/api/conversations/${sessionId}`, {
      headers: { "x-demo-user-id": USER }
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const data = await response.json();
    const assistant = [...(data.conversation?.messages || [])].reverse().find((item) => item.role === "assistant");
    return {
      query: assistant?.metadata?.query || null,
      validation: assistant?.metadata?.validation || null,
      retrievalTrace: assistant?.metadata?.retrievalTrace || null,
      policyVersion: assistant?.metadata?.policyVersion || null
    };
  } catch (error) {
    return { error: error.message };
  }
}

function extraPass(spec, answer, confidence) {
  const text = String(answer || "");
  if (spec.id === "L37") {
    if (/public service pensions remedy|McCloud/i.test(text)) return { ok: false, why: "mccloud_substitution" };
    if (confidence === "insufficient_verified_evidence") return { ok: true, why: "appropriate_fail_closed" };
    if (/Consultation by Employers|section 67/i.test(text) && !/Northern Ireland/i.test(text)) return { ok: true, why: "scheme_change_authority" };
    return { ok: false, why: "missing_scheme_change_authority" };
  }
  if (spec.id === "L29") {
    return { ok: /tracing|MoneyHelper|find pension/i.test(text) && !/missing Harbour Logistics pot/i.test(text), why: "tracing" };
  }
  if (spec.id === "L27") {
    return { ok: !/already in the same scheme/i.test(text) && !/I recommend you transfer|you should combine/i.test(text), why: "no_personal_transfer" };
  }
  if (spec.id === "L47") {
    return { ok: /no defined benefit/i.test(text) && !/four workplace pensions/i.test(text), why: "no_db" };
  }
  if (spec.id === "L41") {
    if (confidence === "model_unavailable") return { ok: false, why: "HOLD_EVALUATION_INFRA" };
    return { ok: !/will definitely receive|same terms as a living member/i.test(text), why: "no_invented_survivor" };
  }
  if (spec.id === "L38") {
    return { ok: !/once in any 12-month/i.test(text), why: "no_invented_reenroll" };
  }
  return { ok: true, why: "n/a" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

mkdirSync(OUT, { recursive: true });
const cases = [];
for (const id of ORIGINALS) {
  const spec = specById(id);
  if (!spec) continue;
  cases.push({ id, variant: "original", spec, question: spec.question });
  if (PARAPHRASES[id]) cases.push({ id, variant: "paraphrase", spec, question: PARAPHRASES[id] });
}

const items = [];
console.log(`Targeted delta ${cases.length} prompts → ${BASE}`);
for (const item of cases) {
  const predicted = processQuery(item.question, {
    providers: ["Aviva", "Standard Life", "Nest", "OneLife"],
    profileJurisdiction: "England and Wales",
    latestMessages: []
  });
  console.log(`ask ${item.id}/${item.variant} …`);
  const result = await postChat(item.question);
  const answer = result.data?.response || result.data?.answer || "";
  const trace = await conversationTrace(result.data?.session_id);
  const autoVerdictResult = autoVerdict(item.spec, {
      response: answer,
      auto: {
        leaks: [],
        has_must_include: item.spec.must_include ? item.spec.must_include.every((needle) => String(answer).replaceAll(",", "").toLowerCase().includes(String(needle).replaceAll(",", "").toLowerCase())) : null,
        hit_must_not: (item.spec.must_not || []).some((needle) => String(answer).toLowerCase().includes(String(needle).toLowerCase())),
        missing_must_include: (item.spec.must_include || []).filter((needle) => !String(answer).replaceAll(",", "").toLowerCase().includes(String(needle).replaceAll(",", "").toLowerCase()))
      }
    });
  const extra = extraPass(item.spec, answer, result.data?.confidence);
  const record = {
    id: item.id,
    variant: item.variant,
    question: item.question,
    expected: item.spec.pass_if,
    expected_route: item.spec.expected_route,
    predicted_route: predicted.response_route,
    predicted_intent: predicted.intent,
    ok: result.ok,
    http_status: result.status,
    elapsed_ms: result.elapsedMs,
    confidence: result.data?.confidence || null,
    handoff: result.data?.handoff || null,
    sources: result.data?.sources || [],
    answer,
    session_id: result.data?.session_id || null,
    error: result.ok ? null : (result.data?.error || `HTTP ${result.status}`),
    auto_verdict: autoVerdictResult,
    extra,
    trace
  };
  if (result.data?.confidence === "model_unavailable") record.verdict = "HOLD_EVALUATION_INFRA";
  else if (autoVerdictResult === "auto-fail" || extra.ok === false) record.verdict = "FAIL";
  else if (autoVerdictResult === "auto-pass" || extra.ok) record.verdict = "PASS";
  else record.verdict = extra.ok ? "PASS" : "FAIL";
  items.push(record);
  writeFileSync(join(OUT, `${item.id}-${item.variant}.json`), `${JSON.stringify(record, null, 2)}\n`);
  await sleep(2200);
}

const counts = items.reduce((acc, item) => {
  acc[item.verdict] = (acc[item.verdict] || 0) + 1;
  return acc;
}, {});
const payload = {
  generated_at: new Date().toISOString(),
  base: BASE,
  user: USER,
  n: items.length,
  original_ids: ORIGINALS,
  counts,
  items: items.map((item) => ({
    id: item.id,
    variant: item.variant,
    verdict: item.verdict,
    confidence: item.confidence,
    elapsed_ms: item.elapsed_ms,
    extra: item.extra,
    answer: item.answer
  }))
};
writeFileSync(join(OUT, "late-patch-targeted-results.json"), `${JSON.stringify({ ...payload, full_items: items }, null, 2)}\n`);
writeFileSync(join(ROOT, "Log/2026-09-02/live-round-51-adjudicated/late-patch-targeted-results.json"), `${JSON.stringify(payload, null, 2)}\n`);

const fails = items.filter((item) => item.verdict !== "PASS");
const summary = `# Late-patch targeted summary

Prompts: ${items.length} (original + selected paraphrases)
Counts: ${JSON.stringify(counts)}

Non-pass:
${fails.map((item) => `- ${item.id}/${item.variant}: ${item.verdict} (${item.confidence || "n/a"}; ${item.extra?.why || ""})`).join("\n") || "- none"}
`;
writeFileSync(join(OUT, "late-patch-targeted-summary.md"), summary);
writeFileSync(join(ROOT, "Log/2026-09-02/live-round-51-adjudicated/late-patch-targeted-summary.md"), summary);
console.log(JSON.stringify({ out: OUT, counts, fails: fails.map((item) => `${item.id}/${item.variant}`) }, null, 2));
