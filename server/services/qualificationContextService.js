import { createHash, createHmac, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  QUALIFICATION_FIXTURE_CASE_IDS,
  qualificationAllowedValueKeys,
  qualificationExpectedValueType,
} from "./qualificationFixtureSchema.js";

const FORBIDDEN_KEY = /(?:^|_)(?:answer|gold|rubric|score|threshold|verdict|pass_if|must_include|must_not|expected_outcome)(?:$|_)/i;
const JURISDICTIONS = new Set(["UNSPECIFIED", "GREAT_BRITAIN", "NORTHERN_IRELAND", "ENGLAND_AND_WALES", "SCOTLAND", "GB_AND_NI", "UK_TAX"]);
const SCORING_TEXT = /\b(?:gold answer|answer rubric|scoring rubric|quality score|pass[_ -]?if|must[_ -]?include|must[_ -]?not|expected outcome|expected route|scoring threshold|qualification verdict)\b/i;
const INSTRUCTION_TEXT = /(?:\b(?:ignore|disregard|override|bypass|supersede|forget)\b.{0,48}\b(?:previous|prior|earlier|above|system|developer|instructions?|directions?|rules?|prompts?|messages?)\b|\b(?:system|developer)\s+(?:prompt|message|instructions?)\b|\bfollow\s+(?:these|this|the\s+following)\s+(?:instructions?|directions?|commands?)\b|\b(?:use|obey|execute|apply)\s+(?:this|these|the\s+following)?\s*(?:instructions?|directions?|commands?|prompts?)\b|\brespond\s+(?:only\s+)?with\b|\byou\s+are\s+(?:chatgpt|an?\s+assistant)\b|\bdo\s+not\s+(?:mention|reveal|disclose)\b|\b(?:mark|grade|rate|classify|set)\s+(?:the\s+)?(?:result|answer|response|case)\s+(?:as\s+)?(?:pass|fail|partial|hold)\b|<\|(?:system|assistant|user)\|>)/i;
const MODEL_CONTROL_TEXT = /(?:\b(?:act|behave|pretend)\s+(?:on|as|according\s+to)\b.{0,80}\b(?:command|instruction|prompt|message|system|developer)\b|\b(?:return|output|emit|print|write|reply|respond|say|state|declare|report|answer|tell)\b.{0,80}\b(?:pass|fail|partial|hold|safe|unsafe|nothing\s+else|the\s+word|exactly|only)\b|\b(?:treat|regard|consider)\b.{0,80}\b(?:message|text|instruction|command|prompt|rule)\b.{0,60}\b(?:higher|highest|priority|authoritative|controlling|system|developer)\b|\b(?:higher|highest)\s+priority\b|\b(?:instruction|command|prompt|message)\b.{0,60}\b(?:must|should|shall|requires?|directs?|orders?)\b|\band\s+nothing\s+else\b)/i;
const ALLOWED_CONTEXT_MANIFEST_VERSION = "qualification-allowed-context-manifest-v1";
const QUALIFICATION_STAGES = new Set([
  "VERIFY_RUNTIME",
  "T4_TARGETED_REGRESSION","TOPIC161_ORIGINAL_DEVELOPMENT","LIVE50_FULL_REGRESSION",
  "VISIBLE_CRITICAL4","VISIBLE_FULL69","VISIBLE_TOPIC161_REPLACEMENT_V2","VISIBLE_FROZEN13",
]);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status, code:"INVALID_QUALIFICATION_CONTEXT" });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsInstructionText(value) {
  const normalized = String(value || "").normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,"").replace(/[_-]+/g," ").replace(/\s+/g," ");
  return INSTRUCTION_TEXT.test(normalized) || MODEL_CONTROL_TEXT.test(normalized);
}

function assertNoScoringMaterial(value, path = "qualification_context") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoScoringMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "string" && SCORING_TEXT.test(value)) fail(`${path} contains prohibited scoring or answer material.`);
  if (!plainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) fail(`${path}.${key} is prohibited; qualification context may contain scenario facts only.`);
    assertNoScoringMaterial(entry, `${path}.${key}`);
  }
}

function normaliseConversation(entries = []) {
  if (!Array.isArray(entries) || entries.length > 20) fail("qualification_context.conversation_context must contain at most 20 messages.");
  return entries.map((entry, index) => {
    if (typeof entry === "string") {
      const role = /^assistant\s*:/i.test(entry) ? "assistant" : "user";
      const content = entry.replace(/^(?:assistant|user)\s*:\s*/i, "").trim();
      if (!content || content.length > 2000) fail(`qualification_context.conversation_context[${index}] is invalid.`);
      if (containsInstructionText(content)) fail(`qualification_context.conversation_context[${index}] contains instruction-like content.`);
      return { role, content };
    }
    if (!plainObject(entry) || !["user", "assistant"].includes(entry.role)) fail(`qualification_context.conversation_context[${index}] has an invalid role.`);
    const content = String(entry.content || "").trim();
    if (!content || content.length > 2000) fail(`qualification_context.conversation_context[${index}] is invalid.`);
    if (containsInstructionText(content)) fail(`qualification_context.conversation_context[${index}] contains instruction-like content.`);
    return { role:entry.role, content };
  });
}

export function qualificationRuntimeEnabled() {
  return String(process.env.QUALIFICATION_RUNTIME_MODE || "false").toLowerCase() === "true"
    && String(process.env.QUALIFICATION_ATTEMPT_TELEMETRY || "false").toLowerCase() === "true";
}

export function isLoopbackAddress(address = "") {
  const value = String(address || "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

export function qualificationContextSha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertAllowedQualificationContext({ runId,stageId,caseId,contextSha256 }) {
  const path = String(process.env.QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH || "");
  const expectedFileSha256 = String(process.env.QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256 || "");
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/.test(expectedFileSha256) || !existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    fail("Qualification allowed-context manifest is missing or unsafe.",500);
  }
  let raw;
  let manifest;
  try {
    raw = readFileSync(path);
    if (createHash("sha256").update(raw).digest("hex") !== expectedFileSha256) fail("Qualification allowed-context manifest identity mismatch.",500);
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (error?.code === "INVALID_QUALIFICATION_CONTEXT") throw error;
    fail(`Qualification allowed-context manifest could not be verified: ${error.message}`,500);
  }
  if (!plainObject(manifest) || manifest.version !== ALLOWED_CONTEXT_MANIFEST_VERSION || manifest.run_id !== runId || !Array.isArray(manifest.entries)) {
    fail("Qualification allowed-context manifest has an invalid identity.",500);
  }
  const matches = manifest.entries.filter((entry) => plainObject(entry) && entry.stage_id === stageId && entry.case_id === caseId && entry.context_sha256 === contextSha256);
  if (matches.length !== 1) fail("Qualification synthetic context is not in the controller-pinned allowlist.",403);
}

export function deriveQualificationStageCapabilityKey(masterSecret,stageId) {
  const secret = capabilitySecret(masterSecret);
  const stage = String(stageId || "");
  if (!QUALIFICATION_STAGES.has(stage)) fail("Qualification stage is not authorised.",403);
  return createHmac("sha256",secret).update(`qualification-stage-capability-v1:${stage}`).digest("hex");
}

function stageAllowsCase(stageId,caseId) {
  if (stageId === "VISIBLE_FULL69") return QUALIFICATION_FIXTURE_CASE_IDS.includes(caseId);
  if (stageId === "VISIBLE_CRITICAL4") return ["gold-011","gold-041","gold-047","gold-063"].includes(caseId);
  if (stageId === "VERIFY_RUNTIME") return caseId === "runtime-smoke";
  if (stageId === "LIVE50_FULL_REGRESSION") return /^L(?:0[1-9]|[1-4][0-9]|50)$/.test(caseId);
  if (["T4_TARGETED_REGRESSION","TOPIC161_ORIGINAL_DEVELOPMENT","VISIBLE_TOPIC161_REPLACEMENT_V2","VISIBLE_FROZEN13"].includes(stageId)) {
    return /^(?:v2|v2r|v2q)-[a-z0-9._-]{3,150}$/i.test(caseId);
  }
  return false;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function assertScenarioValue(value,path) {
  if (typeof value === "string") {
    if (!value.trim() || value.length > 4_000) fail(`${path} is empty or too long.`);
    if (containsInstructionText(value)) fail(`${path} contains instruction-like content that is not permitted in a qualification fixture.`);
    return;
  }
  if (["number","boolean"].includes(typeof value) || value === null) {
    if (typeof value === "number" && !Number.isFinite(value)) fail(`${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail(`${path} contains too many entries.`);
    value.forEach((entry,index) => assertScenarioValue(entry,`${path}[${index}]`));
    return;
  }
  if (plainObject(value)) {
    if (Object.keys(value).length > 100) fail(`${path} contains too many fields.`);
    for (const [key,entry] of Object.entries(value)) {
      if (!/^[a-zA-Z0-9 ._()/%&+-]{1,160}$/.test(key) || FORBIDDEN_KEY.test(key)) fail(`${path}.${key} is not a permitted scenario field.`);
      assertScenarioValue(entry,`${path}.${key}`);
    }
    return;
  }
  fail(`${path} has an unsupported value type.`);
}

export function qualificationJurisdictionFromValues(values = {}) {
  const candidates = [
    values.user_jurisdiction,values.jurisdiction,values.work_location,values.employment_location,
    values.divorce_jurisdiction,values.proceedings_location,values.company_location,
  ].filter((value) => value && value !== "not supplied").join(" ");
  if (/northern ireland|\bni\b|belfast|newry|derry|londonderry/i.test(candidates)) return "NORTHERN_IRELAND";
  if (/england and wales|cardiff|swansea/i.test(candidates) || values.jurisdiction_England_and_Wales === true) return "ENGLAND_AND_WALES";
  if (/scotland|glasgow|edinburgh/i.test(candidates)) return "SCOTLAND";
  if (/great britain|england|wales|\bgb\b/i.test(candidates)) return "GREAT_BRITAIN";
  if (/united kingdom|\buk\b|gb_and_ni/i.test(candidates)) return "GB_AND_NI";
  return "UNSPECIFIED";
}

export function normaliseQualificationContext(value) {
  if (!plainObject(value)) fail("qualification_context must be an object.");
  if (Buffer.byteLength(JSON.stringify(value)) > 50_000) fail("qualification_context exceeds 50,000 bytes.");
  assertNoScoringMaterial(value);
  const allowed = new Set(["version", "case_id", "declared_jurisdiction", "conversation_context", "synthetic_fixture"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`qualification_context.${key} is not permitted.`);
  if (value.version !== "qualification-synthetic-context-v1") fail("qualification_context.version is not supported.");
  const caseId = String(value.case_id || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(caseId)) fail("qualification_context.case_id is invalid.");
  const jurisdiction = String(value.declared_jurisdiction || "UNSPECIFIED").toUpperCase();
  if (!JURISDICTIONS.has(jurisdiction)) fail("qualification_context.declared_jurisdiction is invalid.");
  const fixture = value.synthetic_fixture;
  if (!plainObject(fixture) || fixture.synthetic !== true || fixture.contains_real_user_data !== false || !plainObject(fixture.values)) {
    fail("qualification_context.synthetic_fixture must be explicitly synthetic, contain no real user data, and supply a values object.");
  }
  const fixtureAllowed = new Set(["evidence_id", "evidence_type", "title", "as_of_date", "synthetic", "contains_real_user_data", "values"]);
  for (const key of Object.keys(fixture)) if (!fixtureAllowed.has(key)) fail(`qualification_context.synthetic_fixture.${key} is not permitted.`);
  const evidenceId = String(fixture.evidence_id || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(evidenceId)) fail("qualification_context.synthetic_fixture.evidence_id is invalid.");
  const expectedValueKeys = qualificationAllowedValueKeys(caseId);
  const actualValueKeys = Object.keys(fixture.values).sort();
  if (JSON.stringify(actualValueKeys) !== JSON.stringify([...expectedValueKeys].sort())) {
    fail("qualification_context.synthetic_fixture.values does not exactly match the audited per-case scenario schema.");
  }
  for (const [key,entry] of Object.entries(fixture.values)) {
    const expectedType = qualificationExpectedValueType(caseId,key);
    if (valueType(entry) !== expectedType) fail(`qualification_context.synthetic_fixture.values.${key} must have pinned type ${expectedType}.`);
    assertScenarioValue(entry,`qualification_context.synthetic_fixture.values.${key}`);
  }
  const title = String(fixture.title || `Synthetic qualification fixture ${caseId}`).trim().slice(0, 240);
  if (!title || containsInstructionText(title) || SCORING_TEXT.test(title)) fail("qualification_context.synthetic_fixture.title contains prohibited instruction or scoring material.");
  const derivedJurisdiction = qualificationJurisdictionFromValues(fixture.values);
  if (jurisdiction !== derivedJurisdiction) fail("qualification_context.declared_jurisdiction must be derived only from the synthetic fixture values.");
  return {
    version:value.version,
    case_id:caseId,
    declared_jurisdiction:jurisdiction,
    conversation_context:normaliseConversation(value.conversation_context || []),
    synthetic_fixture:{
      evidence_id:evidenceId,
      evidence_type:"synthetic_fixture",
      title,
      as_of_date:fixture.as_of_date ? String(fixture.as_of_date).slice(0, 40) : null,
      synthetic:true,
      contains_real_user_data:false,
      values:structuredClone(fixture.values),
    },
  };
}

function capabilityPayloadText(payload) {
  return JSON.stringify({
    version:payload.version,run_id:payload.run_id,stage_id:payload.stage_id,case_id:payload.case_id,client_request_id:payload.client_request_id,
    message_sha256:payload.message_sha256,context_sha256:payload.context_sha256,
    nonce:payload.nonce,issued_at:payload.issued_at,expires_at:payload.expires_at,
  });
}

function capabilitySecret(secret) {
  const value = String(secret || "");
  if (!/^[0-9a-f]{64}$/.test(value)) fail("Qualification capability secret is invalid.", 403);
  return value;
}

export function mintQualificationRequestCapability({ secret,runId,stageId,caseId,clientRequestId,message,context = null,ttlMs = 300_000,nowMs = Date.now(),nonce = randomUUID() }) {
  const normalized = context == null ? null : normaliseQualificationContext(context);
  const duration = Math.max(1_000,Math.min(600_000,Number(ttlMs) || 300_000));
  const payload = {
    version:"qualification-context-capability-v1",
    run_id:String(runId || ""),stage_id:String(stageId || ""),case_id:String(normalized?.case_id || caseId || ""),client_request_id:String(clientRequestId || ""),
    message_sha256:createHash("sha256").update(String(message || "")).digest("hex"),
    context_sha256:normalized ? qualificationContextSha256(normalized) : null,nonce:String(nonce || ""),
    issued_at:new Date(nowMs).toISOString(),expires_at:new Date(nowMs + duration).toISOString(),
  };
  if (!/^post-t4-\d{14}-[0-9a-f]{8}$/.test(payload.run_id) || !stageAllowsCase(payload.stage_id,payload.case_id) || !payload.client_request_id || payload.client_request_id.length > 160 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.nonce)) fail("Qualification capability inputs are invalid.");
  const signature = createHmac("sha256",capabilitySecret(secret)).update(capabilityPayloadText(payload)).digest("hex");
  return { payload,signature,normalized_context:normalized };
}

export function mintQualificationContextCapability(args) {
  if (args?.context == null) fail("Qualification context is required for a context capability.");
  return mintQualificationRequestCapability(args);
}

function consumeCapabilityNonce(nonce,payload) {
  const root = String(process.env.QUALIFICATION_NONCE_STORE_PATH || "");
  if (!isAbsolute(root) || !existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) fail("Qualification nonce store is missing or unsafe.",500);
  const quotaKey = createHash("sha256").update(`${payload.run_id}\0${payload.stage_id}\0${payload.case_id}`).digest("hex");
  let priorCaseAttempts = [];
  let priorQuotaSlots = [];
  let ledgerConsistent = false;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  for (let auditAttempt = 0; auditAttempt < 100; auditAttempt += 1) {
    try {
      const names = readdirSync(root);
      const consumed = names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).map((name) => JSON.parse(readFileSync(join(root,name),"utf8")));
      const quotaRecords = names.filter((name) => /^quota-[0-9a-f]{64}-[12]\.json$/.test(name)).map((name) => ({ name,...JSON.parse(readFileSync(join(root,name),"utf8")) }));
      priorCaseAttempts = consumed.filter((record) => record.run_id === payload.run_id && record.stage_id === payload.stage_id && record.case_id === payload.case_id);
      priorQuotaSlots = quotaRecords.filter((record) => record.run_id === payload.run_id && record.stage_id === payload.stage_id && record.case_id === payload.case_id);
    } catch (error) { fail(`Qualification nonce ledger could not be audited: ${error.message}`,500); }
    const priorNonces = [...new Set(priorCaseAttempts.map((record) => record.nonce))].sort();
    const quotaNonces = [...new Set(priorQuotaSlots.map((record) => record.nonce))].sort();
    const validSlots = priorQuotaSlots.every((record) => record.version === "qualification-capability-quota-slot-v1" && [1,2].includes(record.slot) && record.name === `quota-${quotaKey}-${record.slot}.json`);
    const validConsumed = priorCaseAttempts.every((record) => record.version === "qualification-consumed-capability-v1" && [1,2].includes(record.quota_slot) &&
      priorQuotaSlots.some((slot) => slot.slot === record.quota_slot && slot.nonce === record.nonce));
    ledgerConsistent = priorCaseAttempts.length === priorNonces.length && priorQuotaSlots.length === quotaNonces.length && JSON.stringify(priorNonces) === JSON.stringify(quotaNonces) && validSlots && validConsumed;
    if (ledgerConsistent) break;
    Atomics.wait(waitCell,0,0,10);
  }
  if (!ledgerConsistent) fail("Qualification capability quota ledger is inconsistent.",500);
  if (priorCaseAttempts.some((record) => record.nonce === nonce)) fail("Qualification capability nonce has already been consumed.",409);
  if (priorCaseAttempts.length >= 2) fail("Qualification case attempt quota has been exhausted.",429);
  let quotaSlot = null;
  for (const slot of [1,2]) {
    const quotaPath = join(root,`quota-${quotaKey}-${slot}.json`);
    let quotaFd;
    try {
      quotaFd = openSync(quotaPath,"wx",0o600);
      writeFileSync(quotaFd,JSON.stringify({
        version:"qualification-capability-quota-slot-v1",reserved_at:new Date().toISOString(),slot,
        run_id:payload.run_id,stage_id:payload.stage_id,case_id:payload.case_id,client_request_id:payload.client_request_id,
        nonce:payload.nonce,payload_sha256:qualificationContextSha256(payload),
      }));
      fsyncSync(quotaFd);
      quotaSlot = slot;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") fail(`Qualification quota slot could not be persisted: ${error.message}`,500);
    } finally { if (quotaFd !== undefined) closeSync(quotaFd); }
  }
  if (quotaSlot == null) fail("Qualification case attempt quota has been exhausted.",429);
  const path = join(root,`${createHash("sha256").update(String(nonce)).digest("hex")}.json`);
  let fd;
  try {
    fd = openSync(path,"wx",0o600);
    writeFileSync(fd,JSON.stringify({
      version:"qualification-consumed-capability-v1",consumed_at:new Date().toISOString(),payload_sha256:qualificationContextSha256(payload),
      run_id:payload.run_id,stage_id:payload.stage_id,case_id:payload.case_id,client_request_id:payload.client_request_id,
      message_sha256:payload.message_sha256,context_sha256:payload.context_sha256,nonce:payload.nonce,quota_slot:quotaSlot,
    }));
    fsyncSync(fd);
  } catch (error) {
    if (error?.code === "EEXIST") fail("Qualification capability nonce has already been consumed.",409);
    fail(`Qualification nonce could not be persisted: ${error.message}`,500);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let directoryFd;
  try { directoryFd = openSync(root,"r"); fsyncSync(directoryFd); }
  catch (error) { fail(`Qualification nonce directory could not be durably committed: ${error.message}`,500); }
  finally { if (directoryFd !== undefined) closeSync(directoryFd); }
}

export function verifyAndConsumeQualificationRequestCapability({ capability,secret,runId,stageId,caseId,clientRequestId,message,context = null,nowMs = Date.now() }) {
  if (!plainObject(capability) || !plainObject(capability.payload) || !/^[0-9a-f]{64}$/.test(String(capability.signature || ""))) fail("Qualification capability is missing or malformed.",403);
  const supplied = capability.payload;
  const allowed = new Set(["version","run_id","stage_id","case_id","client_request_id","message_sha256","context_sha256","nonce","issued_at","expires_at"]);
  if (Object.keys(supplied).some((key) => !allowed.has(key)) || supplied.version !== "qualification-context-capability-v1") fail("Qualification capability payload is invalid.",403);
  const stageSecret = deriveQualificationStageCapabilityKey(secret,supplied.stage_id);
  const expectedSignature = createHmac("sha256",stageSecret).update(capabilityPayloadText(supplied)).digest();
  const actualSignature = Buffer.from(capability.signature,"hex");
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature,expectedSignature)) fail("Qualification capability signature is invalid.",403);
  const normalized = context == null ? null : normaliseQualificationContext(context);
  const issued = Date.parse(String(supplied.issued_at || ""));
  const expires = Date.parse(String(supplied.expires_at || ""));
  const expectedMessageSha = createHash("sha256").update(String(message || "")).digest("hex");
  const expectedCaseId = String(normalized?.case_id || caseId || "");
  const expectedContextSha256 = normalized ? qualificationContextSha256(normalized) : null;
  if (supplied.run_id !== runId || supplied.stage_id !== stageId || supplied.case_id !== expectedCaseId || !stageAllowsCase(supplied.stage_id,supplied.case_id) || supplied.client_request_id !== clientRequestId || supplied.message_sha256 !== expectedMessageSha ||
      supplied.context_sha256 !== expectedContextSha256 || !Number.isFinite(issued) || !Number.isFinite(expires) ||
      issued > nowMs + 5_000 || expires <= nowMs || expires - issued > 600_000 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(supplied.nonce || ""))) {
    fail("Qualification capability does not match this run, request, question, context, or validity window.",403);
  }
  if (normalized) assertAllowedQualificationContext({ runId:supplied.run_id,stageId:supplied.stage_id,caseId:supplied.case_id,contextSha256:supplied.context_sha256 });
  consumeCapabilityNonce(supplied.nonce,supplied);
  return { normalized_context:normalized,context_sha256:supplied.context_sha256,capability_payload_sha256:qualificationContextSha256(supplied),nonce:supplied.nonce };
}

export function verifyAndConsumeQualificationContextCapability(args) {
  if (args?.context == null) fail("Qualification context is required for context-capability verification.");
  return verifyAndConsumeQualificationRequestCapability(args);
}

function responseReceiptPayloadText(payload) {
  return JSON.stringify({
    version:payload.version,run_id:payload.run_id,stage_id:payload.stage_id,case_id:payload.case_id,
    client_request_id:payload.client_request_id,message_sha256:payload.message_sha256,
    served_answer_sha256:payload.served_answer_sha256,response_route:payload.response_route,
    jurisdiction_scope:payload.jurisdiction_scope,sources_sha256:payload.sources_sha256,
    review_answer_sha256:payload.review_answer_sha256,claim_citations_sha256:payload.claim_citations_sha256,
    runtime_identity_sha256:payload.runtime_identity_sha256,confidence:payload.confidence,handoff_sha256:payload.handoff_sha256,
    qualification_attempts_sha256:payload.qualification_attempts_sha256,
    qualification_context_sha256:payload.qualification_context_sha256,
    qualification_capability_payload_sha256:payload.qualification_capability_payload_sha256,
    qualification_capability_nonce:payload.qualification_capability_nonce,issued_at:payload.issued_at,
  });
}

function responseReceiptPayload({ runId,stageId,caseId,clientRequestId,message,response,issuedAt = new Date().toISOString() }) {
  if (!/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(runId || "")) || !QUALIFICATION_STAGES.has(String(stageId || "")) ||
      !/^[a-zA-Z0-9._-]{1,160}$/.test(String(caseId || "")) || !String(clientRequestId || "")) fail("Qualification response-receipt identity is invalid.",403);
  if (typeof response?.response !== "string" || response.answer !== response.response || !response.response_route) fail("Qualification response cannot be signed because its canonical answer or route is invalid.",500);
  return {
    version:"qualification-server-response-receipt-v1",run_id:String(runId),stage_id:String(stageId),case_id:String(caseId),
    client_request_id:String(clientRequestId),message_sha256:createHash("sha256").update(String(message || "")).digest("hex"),
    served_answer_sha256:createHash("sha256").update(response.response).digest("hex"),
    response_route:String(response.response_route),jurisdiction_scope:String(response.jurisdiction_scope || "UNSPECIFIED"),
    sources_sha256:qualificationContextSha256(response.sources || []),
    review_answer_sha256:createHash("sha256").update(String(response.review_answer || response.response)).digest("hex"),
    claim_citations_sha256:qualificationContextSha256(response.claim_citations || []),
    runtime_identity_sha256:qualificationContextSha256(response.runtime_identity || null),
    confidence:String(response.confidence || ""),handoff_sha256:qualificationContextSha256(response.handoff || null),
    qualification_attempts_sha256:qualificationContextSha256(response.qualification_attempts || null),
    qualification_context_sha256:response.qualification_context_sha256 || null,
    qualification_capability_payload_sha256:response.qualification_capability_payload_sha256 || null,
    qualification_capability_nonce:response.qualification_capability_nonce || null,issued_at:String(issuedAt),
  };
}

export function createQualificationServerResponseReceipt({ privateKeyPem,runId,stageId,caseId,clientRequestId,message,response,issuedAt }) {
  const payload = responseReceiptPayload({ runId,stageId,caseId,clientRequestId,message,response,issuedAt });
  if (!String(privateKeyPem || "").includes("PRIVATE KEY")) fail("Qualification response-signing private key is absent.",500);
  return { payload,signature:sign(null,Buffer.from(responseReceiptPayloadText(payload)),privateKeyPem).toString("hex") };
}

export function verifyQualificationServerResponseReceipt({ receipt,publicKeyPem,runId,stageId,caseId,clientRequestId,message,response }) {
  const failures = [];
  if (!plainObject(receipt) || !plainObject(receipt.payload) || !/^[0-9a-f]{128}$/.test(String(receipt.signature || ""))) return { passed:false,failures:["server response receipt is missing or malformed"] };
  let expectedPayload;
  try { expectedPayload = responseReceiptPayload({ runId,stageId,caseId,clientRequestId,message,response,issuedAt:receipt.payload.issued_at }); }
  catch (error) { return { passed:false,failures:[error.message] }; }
  if (JSON.stringify(receipt.payload) !== JSON.stringify(expectedPayload)) failures.push("server response receipt payload differs from the served response");
  try {
    if (!String(publicKeyPem || "").includes("PUBLIC KEY") || !verify(null,Buffer.from(responseReceiptPayloadText(receipt.payload)),publicKeyPem,Buffer.from(receipt.signature,"hex"))) {
      failures.push("server response receipt signature is invalid");
    }
  } catch (error) { failures.push(`server response receipt signature is invalid: ${error.message}`); }
  return { passed:failures.length === 0,failures,payload:expectedPayload };
}

function responseBodySignatureText({ runId,stageId,caseId,clientRequestId,bodySha256 }) {
  return JSON.stringify({
    version:"qualification-response-body-signature-v1",run_id:String(runId || ""),stage_id:String(stageId || ""),
    case_id:String(caseId || ""),client_request_id:String(clientRequestId || ""),body_sha256:String(bodySha256 || ""),
  });
}

export function createQualificationResponseBodySignature({ privateKeyPem,runId,stageId,caseId,clientRequestId,rawBody }) {
  if (!String(privateKeyPem || "").includes("PRIVATE KEY")) fail("Qualification response-signing private key is absent.",500);
  const bodySha256 = createHash("sha256").update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "")).digest("hex");
  const text = responseBodySignatureText({ runId,stageId,caseId,clientRequestId,bodySha256 });
  return { body_sha256:bodySha256,signature:sign(null,Buffer.from(text),privateKeyPem).toString("hex") };
}

export function verifyQualificationResponseBodySignature({ signature,publicKeyPem,runId,stageId,caseId,clientRequestId,rawBody }) {
  const bodySha256 = createHash("sha256").update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "")).digest("hex");
  const failures = [];
  if (!/^[0-9a-f]{128}$/.test(String(signature || ""))) failures.push("server response-body signature is missing or malformed");
  try {
    const text = responseBodySignatureText({ runId,stageId,caseId,clientRequestId,bodySha256 });
    if (!String(publicKeyPem || "").includes("PUBLIC KEY") || !verify(null,Buffer.from(text),publicKeyPem,Buffer.from(String(signature || ""),"hex"))) failures.push("server response-body signature is invalid");
  } catch (error) { failures.push(`server response-body signature is invalid: ${error.message}`); }
  return { passed:failures.length === 0,failures,body_sha256:bodySha256 };
}

export function qualificationFixtureSource(context) {
  const fixture = context.synthetic_fixture;
  return {
    sourceId:fixture.evidence_id,
    title:fixture.title,
    section:"Permitted synthetic qualification fixture",
    scope:"USER_PORTFOLIO",
    score:1,
    effectiveDate:fixture.as_of_date,
    updatedAt:fixture.as_of_date,
    snippet:JSON.stringify(fixture.values),
    authority:"Synthetic qualification fixture",
    jurisdiction:context.declared_jurisdiction,
    canonicalLocation:null,
    documentId:`synthetic-${context.case_id}`,
    version:1,
    sourceType:"verified_synthetic_fixture",
    sourceRole:"fixture",
    authorityRank:1,
    oscolaCitation:fixture.title,
  };
}

export function qualificationQueryContext(context, question) {
  const values = context.synthetic_fixture.values || {};
  const providers = [...new Set([
    values.provider, values.resolved_provider, values.provider_x_identity,
    ...(Array.isArray(values.providers) ? values.providers : []),
    ...(Array.isArray(values.conversation_order) ? values.conversation_order : []),
  ].filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()))];
  const resolvedEntities = context.declared_jurisdiction === "UNSPECIFIED" ? {} : { jurisdiction:context.declared_jurisdiction };
  if (values.resolved_provider) resolvedEntities.provider = String(values.resolved_provider);
  if (values.policy_number) resolvedEntities.policyNumber = String(values.policy_number);
  return {
    summary:"",
    resolvedEntities,
    lastUserMessage:String(question || ""),
    providers,
    latestMessages:context.conversation_context,
    profileJurisdiction:context.declared_jurisdiction === "UNSPECIFIED" ? "" : context.declared_jurisdiction,
  };
}

export function qualificationPublicOnlyPlan(query) {
  const personalScopes = new Set(["USER_PORTFOLIO", "USER_DOCUMENTS"]);
  const personalLookups = new Set(["account", "charges", "document_status", "projection", "investment_profile"]);
  return {
    ...query,
    source_scopes:(query.source_scopes || []).filter((scope) => !personalScopes.has(scope)),
    structured_lookups:(query.structured_lookups || []).filter((lookup) => !personalLookups.has(lookup)),
  };
}
