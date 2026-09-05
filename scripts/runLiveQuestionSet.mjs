import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processQuery } from "../server/services/queryProcessorService.js";
import { mintQualificationRequestCapability } from "../server/services/qualificationContextService.js";
import { combineGenerationTelemetry } from "./lib/qualification-worker/liveAttemptTelemetry.mjs";
import { persistServedResponseReceipt } from "./lib/servedResponseReceipt.mjs";
import { atomicWrite, createExclusive, durableMkdir, fsyncDirectory } from "./lib/qualification-worker/utils.mjs";
import {
  allocateNextSet,
  autoVerdict,
  completeSet,
  hongKongDay,
  questionFolderName,
  refreshSetSummary,
  writeQuestionLog
} from "./liveLogStore.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");
const DEFAULT_BANK = join(PROJECT_ROOT, "training/live-demo-round-50-20260902/questions.json");

function arg(name, fallback = "") {
  const prefix = `--${name}`;
  const index = process.argv.indexOf(prefix);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const found = process.argv.find((item) => item.startsWith(`${prefix}=`));
  return found ? found.slice(prefix.length + 1) : fallback;
}

const BANK_PATH = arg("questions", process.env.LIVE_QUESTIONS || DEFAULT_BANK);
const BANK = JSON.parse(readFileSync(BANK_PATH, "utf8"));
const BASE = process.env.LIVE_BASE_URL || "http://127.0.0.1:3000";
const USER = process.env.LIVE_USER_ID || BANK.user || "alex-morgan";
const TIMEOUT_MS = Number(process.env.LIVE_CHAT_TIMEOUT_MS || 320_000);
const MODEL = process.env.LIVE_MODEL || BANK.model || "";
const MAX_ATTEMPTS = Math.max(1, Number(process.env.LIVE_MAX_ATTEMPTS || 2));
const RETRY_BACKOFF_MS = Number(process.env.LIVE_RETRY_BACKOFF_MS || 2_500);
if (!Number.isInteger(RETRY_BACKOFF_MS) || RETRY_BACKOFF_MS < 1) throw new Error("LIVE_RETRY_BACKOFF_MS must be a positive integer.");
const EXPECTED_SET = String(process.env.LIVE_EXPECTED_SET || "").trim();
const OWNED_OUTPUT_DIR = String(process.env.LIVE_OUTPUT_DIR || "").trim();
const RUN_ID = String(process.env.LIVE_RUN_ID || "").trim();
const BANK_SHA256 = createHash("sha256").update(readFileSync(BANK_PATH)).digest("hex");

function leakFlags(text) {
  const hay = String(text || "");
  const flags = [];
  if (/\bInfo DB\b/i.test(hay)) flags.push("info_db_label");
  if (/\bUSER_PORTFOLIO\b/.test(hay)) flags.push("user_portfolio_token");
  if (/\bstructured_/i.test(hay)) flags.push("structured_token");
  if (/\{\{cite:/i.test(hay)) flags.push("raw_cite_token");
  return flags;
}

function includesAll(text, needles = []) {
  const hay = String(text || "").replaceAll(",", "");
  return needles.every((needle) => hay.toLowerCase().includes(String(needle).replaceAll(",", "").toLowerCase()));
}

function includesAny(text, needles = []) {
  const hay = String(text || "");
  return needles.some((needle) => hay.toLowerCase().includes(String(needle).toLowerCase()));
}

async function postChat(message, { caseId,attempt = 1, logicalRequestId = randomUUID(), onAttempt = () => {}, onAttemptFinished = () => {}, retryReason = null, generationRecords = [], requestRecords = [] } = {}) {
  if (!caseId) throw new Error("Live request caseId is required for served-response provenance.");
  const requestId = `${logicalRequestId}-attempt-${attempt}`;
  onAttempt(attempt, requestId);
  const stageId = String(process.env.QUALIFICATION_STAGE_ID || "");
  const capability = mintQualificationRequestCapability({
    secret:process.env.QUALIFICATION_CONTEXT_HMAC_KEY,runId:process.env.QUALIFICATION_RUN_ID,
    stageId,caseId,clientRequestId:requestId,message,
  });
  const body = { client_request_id: requestId, message,qualification_capability:{ payload:capability.payload,signature:capability.signature } };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const requestBodyText = JSON.stringify(body);
    const response = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-demo-user-id": USER, "x-qualification-model-attempt-limit": "1", "x-qualification-stage-id":process.env.QUALIFICATION_STAGE_ID || "", "x-qualification-case-id":caseId },
      body: requestBodyText,
      signal: controller.signal
    });
    const elapsedMs = Date.now() - started;
    const rawBytes = Buffer.from(await response.arrayBuffer());
    const raw = rawBytes.toString("utf8");
    const servedReceipt = persistServedResponseReceipt({
      outputRoot:allocated.dir,caseId,endpoint:BASE,clientRequestId:requestId,message,
      requestBodyText,rawResponseBytes:rawBytes,httpStatus:response.status,
      responseBodySha256:response.headers.get("x-qualification-body-sha256"),responseBodySignature:response.headers.get("x-qualification-body-signature"),
      qualificationCapability:{ payload:capability.payload },
    });
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 800) }; }
    const canonicalResponseValid = typeof data?.response === "string" && data.answer === data.response;
    const telemetryPresent = Boolean(data?.qualification_attempts && typeof data.qualification_attempts.model_call_attempted === "boolean");
    const requestRecord = {
      request_attempt:attempt,client_request_id:requestId,outcome:"RESPONSE",http_status:response.status,
      generation_reconciled:telemetryPresent,model_call_attempted:telemetryPresent ? data.qualification_attempts.model_call_attempted : null,
      retry_reason:retryReason,telemetry:telemetryPresent ? data.qualification_attempts : null,
      canonical_response_valid:canonicalResponseValid,served_response_receipt:servedReceipt,data,
    };
    onAttemptFinished(requestRecord);
    const nextRequestRecords = [...requestRecords,requestRecord];
    const nextGenerationRecords = data?.qualification_attempts?.model_call_attempted
      ? [...generationRecords,{ request_attempt:attempt,request_retry_reason:retryReason,telemetry:data.qualification_attempts }]
      : generationRecords;
    const modelUnavailable = data?.confidence === "model_unavailable";
    if (!telemetryPresent) {
      return { ok:false,status:response.status,elapsedMs,data:{ ...data,error:data?.error || "REQUEST_ATTEMPT_TELEMETRY_MISSING" },attempts:attempt,requestId,logicalRequestId,retryReason,generationRecords:nextGenerationRecords,requestRecords:nextRequestRecords,attemptProvenanceComplete:false,servedReceipt,canonicalResponseValid };
    }
    if ((response.status === 429 || response.status >= 500 || modelUnavailable) && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * attempt));
      return postChat(message, { caseId,attempt:attempt + 1,logicalRequestId,onAttempt,onAttemptFinished,retryReason:modelUnavailable ? "MODEL_UNAVAILABLE" : `HTTP_${response.status}`,generationRecords:nextGenerationRecords,requestRecords:nextRequestRecords });
    }
    if (!canonicalResponseValid) data = { ...data,error:data?.error || "CANONICAL_RESPONSE_ANSWER_MISMATCH" };
    return { ok:response.ok && !modelUnavailable && canonicalResponseValid,status:response.status,elapsedMs,data,attempts:attempt,requestId,logicalRequestId,retryReason,generationRecords:nextGenerationRecords,requestRecords:nextRequestRecords,attemptProvenanceComplete:nextRequestRecords.length === attempt && nextRequestRecords.every((item) => item.generation_reconciled),servedReceipt,canonicalResponseValid };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const requestRecord = { request_attempt:attempt,client_request_id:requestId,outcome:"TRANSPORT_ERROR",http_status:0,generation_reconciled:false,model_call_attempted:null,retry_reason:retryReason,error:error.message || String(error) };
    onAttemptFinished(requestRecord);
    return { ok:false,status:0,elapsedMs,data:{ error:error.message || String(error) },attempts:attempt,requestId,logicalRequestId,retryReason:error.name || "FETCH_ERROR",generationRecords,requestRecords:[...requestRecords,requestRecord],attemptProvenanceComplete:false,servedReceipt:null,canonicalResponseValid:false };
  } finally {
    clearTimeout(timer);
  }
}

function compactSources(sources = []) {
  return sources.map((source) => ({
    source_id: source.sourceId || source.source_id || source.id || "",
    title: source.title || "",
    oscola: source.oscola || "",
    scope: source.scope || "",
    authority: source.authority || "",
    section: source.section || "",
    effective_date: source.effectiveDate || source.effective_date || null,
    url: source.url || "",
    evidence_excerpt: String(source.snippet || source.excerpt || source.text || "").slice(0, 2400)
  }));
}

if (OWNED_OUTPUT_DIR && (!EXPECTED_SET || !RUN_ID)) {
  throw new Error("LIVE_OUTPUT_DIR requires LIVE_EXPECTED_SET and LIVE_RUN_ID.");
}
const allocated = OWNED_OUTPUT_DIR
  ? { day: hongKongDay(), setName: EXPECTED_SET, dir: resolve(OWNED_OUTPUT_DIR) }
  : allocateNextSet({ day: hongKongDay(), model: MODEL, user: USER });
durableMkdir(allocated.dir);
if (EXPECTED_SET && allocated.setName !== EXPECTED_SET) {
  throw new Error(`Allocated ${allocated.setName}, expected ${EXPECTED_SET}. Refusing to mix formal run identities.`);
}
const runBinding = {
  run_id: RUN_ID || null,
  bank_path: resolve(BANK_PATH),
  bank_sha256: BANK_SHA256,
  endpoint: BASE,
  model: MODEL,
  user: USER,
  set_name: allocated.setName,
  total: (BANK.questions || []).length,
};
const resultsPath = join(allocated.dir, "results.json");
const ledgerPath = join(allocated.dir, "attempt-ledger.jsonl");
let prior = null;
if (existsSync(resultsPath)) {
  const priorBytes = readFileSync(resultsPath);
  try { prior = JSON.parse(priorBytes.toString("utf8")); }
  catch (error) {
    if (!OWNED_OUTPUT_DIR) throw error;
    const recoveryPath = join(allocated.dir,`results-torn-${createHash("sha256").update(priorBytes).digest("hex").slice(0,16)}.raw`);
    if (!existsSync(recoveryPath)) createExclusive(recoveryPath,priorBytes);
  }
}
if (prior && OWNED_OUTPUT_DIR && JSON.stringify(prior.run_binding) !== JSON.stringify(runBinding)) {
  throw new Error("Existing Live result does not match this formal run binding.");
}
const items = prior?.set === allocated.setName && Array.isArray(prior.items) ? prior.items : [];
const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
if (OWNED_OUTPUT_DIR && ledger.some((event) => event.run_id !== RUN_ID)) throw new Error("Attempt ledger contains a foreign run identity.");
const startsByCase = new Map();
for (const event of ledger) if (event.event === "ATTEMPT_STARTED") startsByCase.set(event.case_id, (startsByCase.get(event.case_id) || 0) + 1);
const finishedByCase = new Map();
for (const event of ledger) if (event.event === "REQUEST_FINISHED") finishedByCase.set(event.case_id,(finishedByCase.get(event.case_id) || 0) + 1);
for (const event of ledger) {
  if (event.event !== "RESULT_COMMITTED" || !event.record || items.some((item) => item.id === event.case_id)) continue;
  items.push(event.record);
}
const completedIds = new Set(items.map((item) => item.id));

function appendLedger(event) {
  durableMkdir(allocated.dir);
  const fd = openSync(ledgerPath, "a", 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify({ ...event,run_id:RUN_ID || null,set_name:allocated.setName,logged_at:new Date().toISOString() })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(allocated.dir);
}

function persistResults() {
  atomicWrite(resultsPath, {
    generated_at: new Date().toISOString(), day:allocated.day,set:allocated.setName,base:BASE,user:USER,model:MODEL,
    complete:items.filter((item) => item.ok).length,total:(BANK.questions || []).length,run_binding:runBinding,items,
  });
}

if (items.length) {
  for (const record of items) writeQuestionLog(allocated.dir, record);
  persistResults();
}

console.log(`Live ${allocated.setName} → ${BASE} as ${USER}`);
console.log(`Log folder ${allocated.dir}`);

for (const spec of BANK.questions || []) {
  if (completedIds.has(spec.id)) {
    console.log(`skip ${spec.id} preserved completed result`);
    continue;
  }
  const predicted = processQuery(spec.question, {
    providers: ["Aviva", "Standard Life", "Nest", "OneLife"],
    latestMessages: []
  });
  console.log(`ask ${spec.id} ${spec.issue} …`);
  const logicalRequestId = RUN_ID
    ? `qualification-${createHash("sha256").update(`${RUN_ID}:${spec.id}`).digest("hex").slice(0, 32)}`
    : randomUUID();
  const priorAttempts = startsByCase.get(spec.id) || 0;
  const priorFinished = finishedByCase.get(spec.id) || 0;
  const result = priorAttempts > 0
    ? { ok:false,status:0,elapsedMs:0,data:{ error:priorFinished === priorAttempts ? "UNCOMMITTED_PRIOR_ATTEMPT" : "INTERRUPTED_PRIOR_ATTEMPT" },attempts:priorAttempts,requestId:`${logicalRequestId}-attempt-${priorAttempts}`,logicalRequestId,retryReason:"ATTEMPT_PROVENANCE_INCOMPLETE",generationRecords:[],requestRecords:ledger.filter((event) => event.case_id === spec.id && event.event === "REQUEST_FINISHED").map((event) => event.request_record),attemptProvenanceComplete:false }
    : await postChat(spec.question, {
        caseId:spec.id,
        attempt:1,
        logicalRequestId,
        retryReason:priorAttempts ? "INTERRUPTED_PRIOR_ATTEMPT" : null,
        onAttempt:(attempt, attemptRequestId) => {
          startsByCase.set(spec.id, attempt);
          appendLedger({ event:"ATTEMPT_STARTED",case_id:spec.id,attempt,logical_request_id:logicalRequestId,client_request_id:attemptRequestId });
        },
        onAttemptFinished:(requestRecord) => {
          finishedByCase.set(spec.id,(finishedByCase.get(spec.id) || 0) + 1);
          appendLedger({ event:"REQUEST_FINISHED",case_id:spec.id,attempt:requestRecord.request_attempt,logical_request_id:logicalRequestId,client_request_id:requestRecord.client_request_id,request_record:requestRecord });
        },
      });
  const answer = result.canonicalResponseValid ? result.data.response : "";
  const generation = combineGenerationTelemetry(result.generationRecords || []);
  const record = {
    id: spec.id,
    category: spec.category,
    issue: spec.issue,
    question: spec.question,
    expected: spec.pass_if,
    expected_route: spec.expected_route,
    predicted_route: predicted.response_route,
    actual_route: result.data?.response_route || null,
    predicted_intent: predicted.intent,
    predicted_reason: predicted.handoff_reason || predicted.reason || null,
    ok: result.ok,
    http_status: result.status,
    elapsed_ms: result.elapsedMs,
    confidence: result.data?.confidence || null,
    handoff: result.data?.handoff || null,
    sources: compactSources(result.data?.sources || []),
    cited: compactSources(result.data?.sources || []),
    final_public_sources:Array.isArray(result.data?.sources) ? result.data.sources : [],
    generated_citations:(result.data?.sources || []).map((source) => String(source.source_id || source.sourceId || "")).filter(Boolean),
    selected_jurisdiction:result.data?.jurisdiction_scope || "UNSPECIFIED",
    answer,
    response: answer,
    served_via_canonical_chat:result.ok === true && result.canonicalResponseValid === true,
    response_route_source:result.ok === true && result.canonicalResponseValid === true ? "CANONICAL_HTTP_CHAT_RESPONSE" : null,
    served_response_sha256:result.ok === true && result.canonicalResponseValid === true ? createHash("sha256").update(answer).digest("hex") : null,
    served_response_receipt:result.servedReceipt || null,
    qualification_context_applied:false,
    qualification_context_sha256:null,
    qualification_capability_payload_sha256:result.data?.qualification_capability_payload_sha256 || null,
    qualification_capability_nonce:result.data?.qualification_capability_nonce || null,
    review_answer: result.data?.review_answer || answer,
    claim_citations: Array.isArray(result.data?.claim_citations) ? result.data.claim_citations : [],
    error: result.ok ? null : (result.data?.error || `HTTP ${result.status}`),
    client_request_id: result.requestId,
    logical_request_id: result.logicalRequestId,
    request_attempt_limit: MAX_ATTEMPTS,
    request_attempts: result.attempts || 1,
    request_attempt_ledger:Array.isArray(result.requestRecords) ? result.requestRecords : [],
    request_attempt_provenance_complete:result.attemptProvenanceComplete === true,
    model_call_attempted: Boolean(result.data?.qualification_attempts?.model_call_attempted),
    generation_attempts: generation.attempts,
    generation_attempt_ledger: generation.events,
    generation_retry_used: generation.retryUsed,
    generation_retry_reason: generation.retryReason,
    recovered_from_truncation: generation.recoveredFromTruncation,
    runtime_identity: result.data?.runtime_identity || null,
    retry_used: Number(result.attempts || 1) > 1 || Boolean(result.data?.qualification_attempts?.retry_used),
    retry_reason: result.retryReason || result.data?.qualification_attempts?.retry_reason || null,
    auto: {
      leaks: leakFlags(answer),
      has_must_include: spec.must_include ? includesAll(answer, spec.must_include) : null,
      hit_must_not: spec.must_not ? includesAny(answer, spec.must_not) : false,
      missing_must_include: (spec.must_include || []).filter((needle) => !includesAll(answer, [needle])),
      pass_if: spec.pass_if
    }
  };
  record.verdict = autoVerdict(spec, record);
  record.end_to_end_attempts = Math.max(Number(record.request_attempts || 1),Number(record.generation_attempts || 0));
  appendLedger({ event:"RESULT_COMMITTED",case_id:spec.id,attempts:record.request_attempts,logical_request_id:logicalRequestId,client_request_id:record.client_request_id,record });
  items.push(record);
  completedIds.add(spec.id);
  writeQuestionLog(allocated.dir, record);
  persistResults();
  console.log(`${spec.id} ${result.ok ? "ok" : "FAIL"} ${result.elapsedMs}ms conf=${record.confidence} verdict=${record.verdict} log=${questionFolderName(record)}`);
}

const completionMeta = {
  day: allocated.day,
  setName: allocated.setName,
  model: MODEL,
  user: USER
};
const summary = OWNED_OUTPUT_DIR ? refreshSetSummary(allocated.dir, completionMeta) : completeSet(allocated.dir, completionMeta);
if (OWNED_OUTPUT_DIR) {
  atomicWrite(join(allocated.dir, "status.json"), {
    day: allocated.day,
    set: allocated.setName,
    status: "complete",
    model: MODEL,
    user: USER,
    completed_at: new Date().toISOString(),
    n: summary.n,
    counts: summary.counts,
    run_binding: runBinding,
  });
}
console.log(`DONE ${summary.n} logged under ${allocated.dir}`);
const failedHttp = items.filter((item) => !item.ok).length;
if (failedHttp) process.exit(1);
