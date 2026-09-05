import { createHash,createHmac,randomUUID,timingSafeEqual } from "node:crypto";
import { closeSync,existsSync,fsyncSync,lstatSync,openSync,readFileSync,writeFileSync } from "node:fs";
import { isAbsolute,join } from "node:path";

const FORBIDDEN_KEY = /(?:^|_)(?:answer|gold|rubric|score|threshold|verdict|pass_if|must_include|must_not|expected_outcome)(?:$|_)/i;
const FORBIDDEN_TEXT = /\b(?:gold answer|answer rubric|scoring rubric|qualification verdict|ignore previous|system prompt|developer message)\b/i;
const JURISDICTIONS = new Set(["UNSPECIFIED","GREAT_BRITAIN","NORTHERN_IRELAND","ENGLAND_AND_WALES","SCOTLAND","GB_AND_NI","UK_TAX"]);

function fail(message,status=400) { throw Object.assign(new Error(message),{ status,code:"INVALID_CUSTODIAN_CONTEXT" }); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)); }
const sha256 = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""))).digest("hex");

function secret(value) {
  const key = String(value || "");
  if (!/^[0-9a-f]{64}$/.test(key)) fail("Custodian capability secret is invalid.",403);
  return key;
}

function safeValue(value,path,depth=0) {
  if (depth > 3) fail(`${path} is too deeply nested.`);
  if (value == null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") {
    if (!value.trim() || value.length > 2000 || FORBIDDEN_TEXT.test(value)) fail(`${path} contains prohibited or invalid text.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) fail(`${path} has too many values.`);
    return value.map((entry,index) => safeValue(entry,`${path}[${index}]`,depth+1));
  }
  if (!plain(value) || Object.keys(value).length > 100) fail(`${path} is not a bounded plain object.`);
  return Object.fromEntries(Object.entries(value).map(([key,entry]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || FORBIDDEN_KEY.test(key)) fail(`${path}.${key} is prohibited.`);
    return [key,safeValue(entry,`${path}.${key}`,depth+1)];
  }));
}

export function custodianRuntimeEnabled() {
  return String(process.env.SEALED_UNSEEN_CUSTODIAN_MODE || "false").toLowerCase() === "true";
}

export function normaliseCustodianContext(value) {
  if (!plain(value) || Buffer.byteLength(JSON.stringify(value)) > 50_000) fail("Custodian context is invalid or too large.");
  const allowed = new Set(["version","case_id","declared_jurisdiction","conversation_context","synthetic_fixture"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== "sealed-unseen-synthetic-context-v1") fail("Custodian context shape is invalid.");
  const caseId = String(value.case_id || "");
  const jurisdiction = String(value.declared_jurisdiction || "UNSPECIFIED");
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(caseId) || !JURISDICTIONS.has(jurisdiction)) fail("Custodian case or jurisdiction identity is invalid.");
  const conversation = Array.isArray(value.conversation_context) ? value.conversation_context : [];
  if (conversation.length > 20) fail("Custodian conversation context is too long.");
  const conversation_context = conversation.map((entry,index) => {
    const row = typeof entry === "string"
      ? { role:/^assistant\s*:/i.test(entry) ? "assistant" : "user",content:String(entry).replace(/^(?:assistant|user)\s*:\s*/i,"").trim() }
      : entry;
    if (!plain(row) || !["user","assistant"].includes(row.role)) fail(`Custodian conversation item ${index} is invalid.`);
    return { role:row.role,content:safeValue(String(row.content || ""),`conversation_context[${index}].content`) };
  });
  const fixture = value.synthetic_fixture;
  if (!plain(fixture)) fail("Custodian synthetic fixture is required.");
  const fixtureAllowed = new Set(["evidence_id","title","as_of_date","values"]);
  if (Object.keys(fixture).some((key) => !fixtureAllowed.has(key))) fail("Custodian synthetic fixture shape is invalid.");
  const evidenceId = String(fixture.evidence_id || "");
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(evidenceId)) fail("Custodian evidence identity is invalid.");
  return {
    version:"qualification-synthetic-context-v1",case_id:caseId,declared_jurisdiction:jurisdiction,conversation_context,
    synthetic_fixture:{ evidence_id:evidenceId,title:safeValue(String(fixture.title || "Synthetic sealed evaluation fixture"),"synthetic_fixture.title"),as_of_date:fixture.as_of_date ? safeValue(String(fixture.as_of_date),"synthetic_fixture.as_of_date") : null,values:safeValue(fixture.values || {},"synthetic_fixture.values") },
  };
}

function payloadText(payload) {
  return JSON.stringify({ version:payload.version,run_id:payload.run_id,case_id:payload.case_id,client_request_id:payload.client_request_id,message_sha256:payload.message_sha256,context_sha256:payload.context_sha256,nonce:payload.nonce,issued_at:payload.issued_at,expires_at:payload.expires_at });
}

export function mintCustodianCapability({ key,runId,caseId,clientRequestId,message,context,ttlMs=300_000,nowMs=Date.now(),nonce=randomUUID() }) {
  const normalized = normaliseCustodianContext(context);
  const payload = {
    version:"sealed-unseen-custodian-capability-v1",run_id:String(runId || ""),case_id:String(caseId || ""),client_request_id:String(clientRequestId || ""),
    message_sha256:sha256(message),context_sha256:sha256(JSON.stringify(normalized)),nonce:String(nonce),issued_at:new Date(nowMs).toISOString(),expires_at:new Date(nowMs+Math.min(600_000,Math.max(1_000,ttlMs))).toISOString(),
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(payload.run_id) || payload.case_id !== normalized.case_id || !payload.client_request_id || payload.client_request_id.length > 160) fail("Custodian capability identity is invalid.");
  return { payload,signature:createHmac("sha256",secret(key)).update(payloadText(payload)).digest("hex"),normalized_context:normalized };
}

function consumeNonce(payload) {
  const root = String(process.env.SEALED_UNSEEN_NONCE_STORE_PATH || "");
  if (!isAbsolute(root) || !existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) fail("Custodian nonce store is missing or unsafe.",500);
  const path = join(root,`${sha256(payload.nonce)}.json`);
  let fd;
  try {
    fd=openSync(path,"wx",0o600);
    writeFileSync(fd,JSON.stringify({ version:"sealed-unseen-consumed-capability-v1",consumed_at:new Date().toISOString(),run_id:payload.run_id,case_id:payload.case_id,client_request_id:payload.client_request_id,nonce:payload.nonce,payload_sha256:sha256(payloadText(payload)) }));
    fsyncSync(fd);
  } catch (error) {
    if (error?.code === "EEXIST") fail("Custodian capability nonce has already been consumed.",409);
    fail(`Custodian nonce could not be persisted: ${error.message}`,500);
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function verifyAndConsumeCustodianCapability({ capability,key,runId,caseId,clientRequestId,message,context,nowMs=Date.now() }) {
  if (!plain(capability) || !plain(capability.payload) || !/^[0-9a-f]{64}$/.test(String(capability.signature || ""))) fail("Custodian capability is missing or malformed.",403);
  const supplied=capability.payload;
  const normalized=normaliseCustodianContext(context);
  const expected=createHmac("sha256",secret(key)).update(payloadText(supplied)).digest();
  const actual=Buffer.from(String(capability.signature),"hex");
  const issued=Date.parse(String(supplied.issued_at || ""));
  const expires=Date.parse(String(supplied.expires_at || ""));
  if (actual.length!==expected.length || !timingSafeEqual(actual,expected) || supplied.version!=="sealed-unseen-custodian-capability-v1"
      || supplied.run_id!==runId || supplied.case_id!==caseId || supplied.case_id!==normalized.case_id || supplied.client_request_id!==clientRequestId
      || supplied.message_sha256!==sha256(message) || supplied.context_sha256!==sha256(JSON.stringify(normalized))
      || !Number.isFinite(issued) || !Number.isFinite(expires) || issued>nowMs+5_000 || expires<=nowMs || expires-issued>600_000
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(supplied.nonce || ""))) fail("Custodian capability does not match this one-shot request.",403);
  consumeNonce(supplied);
  return { normalized_context:normalized,context_sha256:supplied.context_sha256,capability_payload_sha256:sha256(payloadText(supplied)),nonce:supplied.nonce };
}

function bodySignatureText({ runId,caseId,clientRequestId,bodySha256 }) {
  return JSON.stringify({ version:"sealed-unseen-response-body-signature-v1",run_id:runId,case_id:caseId,client_request_id:clientRequestId,body_sha256:bodySha256 });
}

export function createCustodianBodySignature({ key,runId,caseId,clientRequestId,rawBody }) {
  const body_sha256=sha256(rawBody);
  return { body_sha256,signature:createHmac("sha256",secret(key)).update(bodySignatureText({ runId,caseId,clientRequestId,bodySha256:body_sha256 })).digest("hex") };
}

export function verifyCustodianBodySignature({ key,signature,runId,caseId,clientRequestId,rawBody }) {
  const expected=createCustodianBodySignature({ key,runId,caseId,clientRequestId,rawBody });
  const left=Buffer.from(String(signature || ""),"hex");
  const right=Buffer.from(expected.signature,"hex");
  return { passed:left.length===right.length && timingSafeEqual(left,right),body_sha256:expected.body_sha256 };
}
