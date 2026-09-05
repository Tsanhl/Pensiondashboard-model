import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { canonicalHash, createExclusive, durableMkdir, fsyncDirectory, now, sha256Buffer, sha256File } from "./qualification-worker/utils.mjs";
import { verifyQualificationResponseBodySignature, verifyQualificationServerResponseReceipt } from "../../server/services/qualificationContextService.js";

function safeLeaf(value) {
  const leaf = String(value || "response").replace(/[^a-zA-Z0-9._-]/g,"-").slice(0,180);
  if (!leaf) throw new Error("Served-response receipt ID is invalid.");
  return leaf;
}

function inside(root,path) {
  const rel = relative(resolve(root),resolve(path));
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes("../") && resolve(root,rel) === resolve(path);
}

function writeRawExclusive(path,bytes) {
  durableMkdir(dirname(path));
  const fd = openSync(path,"wx",0o600);
  try { writeFileSync(fd,Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); fsyncSync(fd); }
  finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
}

export function persistServedResponseReceipt({ outputRoot,caseId,endpoint,clientRequestId,message,requestBodyText,rawResponseBytes,httpStatus,responseBodySha256 = null,responseBodySignature = null,qualificationContextSha256 = null,qualificationCapability = null }) {
  const root = resolve(outputRoot);
  const leaf = safeLeaf(clientRequestId || caseId);
  const rawPath = resolve(root,"served-response-receipts",`${leaf}.response.raw.json`);
  const receiptPath = resolve(root,"served-response-receipts",`${leaf}.receipt.json`);
  if (!inside(root,rawPath) || !inside(root,receiptPath) || existsSync(rawPath) || existsSync(receiptPath)) throw new Error("Served-response receipt path is unsafe or already exists.");
  if (!Buffer.isBuffer(rawResponseBytes)) throw new Error("Served response must be persisted from the exact HTTP response bytes.");
  writeRawExclusive(rawPath,rawResponseBytes);
  let parsed = null;
  try { parsed = JSON.parse(rawResponseBytes.toString("utf8")); } catch {}
  const response = typeof parsed?.response === "string" ? parsed.response : null;
  const answer = typeof parsed?.answer === "string" ? parsed.answer : null;
  const receipt = {
    version:"canonical-chat-served-response-receipt-v1",recorded_at:now(),
    endpoint:String(endpoint),case_id:String(caseId),client_request_id:String(clientRequestId),
    message_sha256:sha256Buffer(String(message)),request_body_sha256:sha256Buffer(String(requestBodyText)),
    http_status:Number(httpStatus),raw_response_path:relative(root,rawPath),raw_response_sha256:sha256File(rawPath),
    server_response_body_sha256:String(responseBodySha256 || ""),server_response_body_signature:String(responseBodySignature || ""),
    response_answer_equal:response != null && response === answer,
    served_answer_sha256:response == null ? null : sha256Buffer(response),
    response_route:parsed?.response_route || null,jurisdiction_scope:parsed?.jurisdiction_scope || null,
    sources_sha256:canonicalHash(parsed?.sources || []),qualification_attempts_sha256:canonicalHash(parsed?.qualification_attempts || null),
    qualification_context_sha256:qualificationContextSha256,
    qualification_capability_payload:qualificationCapability?.payload || null,
    qualification_capability_payload_sha256:qualificationCapability?.payload ? sha256Buffer(JSON.stringify(qualificationCapability.payload)) : null,
    qualification_server_receipt_payload_sha256:parsed?.qualification_server_receipt?.payload ? sha256Buffer(JSON.stringify(parsed.qualification_server_receipt.payload)) : null,
    qualification_server_receipt_signature:parsed?.qualification_server_receipt?.signature || null,
  };
  createExclusive(receiptPath,receipt);
  return {
    path:relative(root,receiptPath),sha256:sha256File(receiptPath),
    raw_path:receipt.raw_response_path,raw_sha256:receipt.raw_response_sha256,
    endpoint:receipt.endpoint,client_request_id:receipt.client_request_id,
    served_answer_sha256:receipt.served_answer_sha256,
    server_response_body_sha256:receipt.server_response_body_sha256,server_response_body_signature:receipt.server_response_body_signature,
    server_receipt_payload_sha256:receipt.qualification_server_receipt_payload_sha256,
  };
}

export function verifyServedResponseReceipt(result,{ outputRoot,publicKeyPem = process.env.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM,runId = process.env.QUALIFICATION_RUN_ID,stageId = process.env.QUALIFICATION_STAGE_ID,skipGenerationTelemetry = false } = {}) {
  const root = resolve(outputRoot || ".");
  const record = result?.served_response_receipt;
  const failures = [];
  if (!record?.path || !record?.raw_path || !/^[0-9a-f]{64}$/.test(String(record.sha256 || "")) || !/^[0-9a-f]{64}$/.test(String(record.raw_sha256 || ""))) {
    return { passed:false,failures:["served-response receipt reference is missing or malformed"] };
  }
  const receiptPath = resolve(root,record.path);
  const rawPath = resolve(root,record.raw_path);
  if (!inside(root,receiptPath) || !inside(root,rawPath)) return { passed:false,failures:["served-response receipt leaves its output root"] };
  if (!existsSync(receiptPath) || !existsSync(rawPath) || lstatSync(receiptPath).isSymbolicLink() || lstatSync(rawPath).isSymbolicLink()) return { passed:false,failures:["served-response receipt file is missing or unsafe"] };
  if (sha256File(receiptPath) !== record.sha256) failures.push("served-response receipt hash mismatch");
  if (sha256File(rawPath) !== record.raw_sha256) failures.push("raw served-response hash mismatch");
  let receipt = null;
  let data = null;
  try { receipt = JSON.parse(readFileSync(receiptPath,"utf8")); } catch { failures.push("served-response receipt JSON is invalid"); }
  try { data = JSON.parse(readFileSync(rawPath,"utf8")); } catch { failures.push("raw served-response JSON is invalid"); }
  const servedAnswer = typeof data?.response === "string" ? data.response : null;
  if (servedAnswer == null || data?.answer !== servedAnswer) failures.push("canonical response and answer fields are absent or different");
  const answerSha = servedAnswer == null ? null : sha256Buffer(servedAnswer);
  const resultAnswer = result.final_system_answer ?? result.answer ?? result.response;
  const resultRoute = result.selected_route ?? result.actual_route;
  if (receipt?.version !== "canonical-chat-served-response-receipt-v1" || receipt.raw_response_path !== record.raw_path || receipt.raw_response_sha256 !== record.raw_sha256) failures.push("receipt does not bind its raw response");
  if (receipt?.endpoint !== record.endpoint || receipt?.client_request_id !== record.client_request_id || receipt?.response_answer_equal !== true) failures.push("receipt endpoint, request, or response equality is invalid");
  if (receipt?.served_answer_sha256 !== answerSha || record.served_answer_sha256 !== answerSha || result.served_response_sha256 !== answerSha) failures.push("served-answer commitment mismatch");
  if (receipt?.server_response_body_sha256 !== record.server_response_body_sha256 || receipt?.server_response_body_signature !== record.server_response_body_signature ||
      receipt?.server_response_body_sha256 !== sha256Buffer(readFileSync(rawPath))) failures.push("server response-body commitment mismatch");
  if (String(resultAnswer ?? "") !== servedAnswer) failures.push("scored answer differs from the canonical served answer");
  if (receipt?.response_route !== data?.response_route || resultRoute !== data?.response_route) failures.push("scored route differs from the canonical served route");
  if (receipt?.sources_sha256 !== canonicalHash(data?.sources || []) || receipt?.qualification_attempts_sha256 !== canonicalHash(data?.qualification_attempts || null)) failures.push("receipt response fields are not bound");
  const resultSources = Array.isArray(result.final_public_sources) ? result.final_public_sources : (Array.isArray(result.retrieval_sources) ? result.retrieval_sources : []);
  const servedSources = Array.isArray(data?.sources) ? data.sources : [];
  if (canonicalHash(resultSources) !== canonicalHash(servedSources)) failures.push("scored sources differ from the canonical served sources");
  const resultClaims = Array.isArray(result.claim_citations) ? result.claim_citations : [];
  const servedClaims = Array.isArray(data?.claim_citations) ? data.claim_citations : [];
  if (canonicalHash(resultClaims) !== canonicalHash(servedClaims)) failures.push("scored claim citations differ from the canonical served claim citations");
  const servedReviewAnswer = String(data?.review_answer || servedAnswer || "");
  if (String(result.review_answer ?? resultAnswer ?? "") !== servedReviewAnswer) failures.push("review answer differs from the canonical served review answer");
  if (String(result.selected_jurisdiction ?? result.jurisdiction ?? "UNSPECIFIED") !== String(data?.jurisdiction_scope || "UNSPECIFIED")) failures.push("scored jurisdiction differs from the canonical served jurisdiction");
  if (Object.hasOwn(result,"confidence") && String(result.confidence || "") !== String(data?.confidence || "")) failures.push("scored confidence differs from the canonical served confidence");
  if (Object.hasOwn(result,"handoff") && canonicalHash(result.handoff || null) !== canonicalHash(data?.handoff || null)) failures.push("scored handoff differs from the canonical served handoff");
  if (Object.hasOwn(result,"handoff_decision") && String(result.handoff_decision || "none") !== String(data?.handoff?.reason || "none")) failures.push("scored handoff decision differs from the canonical served handoff");
  if (canonicalHash(result.runtime_identity || null) !== canonicalHash(data?.runtime_identity || null)) failures.push("scored runtime identity differs from the canonical served runtime identity");
  if (Boolean(result.model_call_attempted) !== Boolean(data?.qualification_attempts?.model_call_attempted)) failures.push("scored model-call flag differs from canonical telemetry");
  const servedTelemetry = data?.qualification_attempts || {};
  if (!skipGenerationTelemetry && (Number(result.generation_attempts || 0) !== Number(servedTelemetry.generation_attempts || 0) ||
      Boolean(result.retry_used ?? result.generation_retry_used) !== Boolean(servedTelemetry.retry_used) ||
      (result.retry_reason ?? result.generation_retry_reason ?? null) !== (servedTelemetry.retry_reason ?? null) ||
      canonicalHash(result.generation_attempt_ledger || []) !== canonicalHash(servedTelemetry.generation_attempt_ledger || []) ||
      Boolean(result.recovered_from_truncation) !== Boolean(servedTelemetry.recovered_from_truncation))) {
    failures.push("scored generation telemetry differs from the canonical served telemetry");
  }
  if (result.grounding_validation && canonicalHash(result.grounding_validation) !== canonicalHash({
    valid:["grounded","grounded_with_handoff","handoff","needs_clarification"].includes(String(data?.confidence || "")),
    reason:servedTelemetry.model_call_attempted ? "served_product_model_path" : "served_product_deterministic_path",
  })) failures.push("scored grounding status differs from the canonical served confidence");
  const generatedCitations = Array.isArray(result.generated_citations) ? result.generated_citations.map(String) : [];
  const servedCitationIds = servedSources.map((source) => String(source.source_id || source.sourceId || "")).filter(Boolean);
  if (canonicalHash(generatedCitations) !== canonicalHash(servedCitationIds)) failures.push("scored generated citations differ from canonical served sources");
  const serverReceiptPayloadSha256 = data?.qualification_server_receipt?.payload ? sha256Buffer(JSON.stringify(data.qualification_server_receipt.payload)) : null;
  if (receipt?.qualification_server_receipt_payload_sha256 !== serverReceiptPayloadSha256 || record.server_receipt_payload_sha256 !== serverReceiptPayloadSha256 ||
      receipt?.qualification_server_receipt_signature !== data?.qualification_server_receipt?.signature) failures.push("client receipt does not bind the server response receipt");
  const capabilityPayloadSha256 = receipt?.qualification_capability_payload ? sha256Buffer(JSON.stringify(receipt.qualification_capability_payload)) : null;
  if (!capabilityPayloadSha256 || receipt?.qualification_capability_payload_sha256 !== capabilityPayloadSha256 ||
      data?.qualification_capability_payload_sha256 !== capabilityPayloadSha256 || data?.qualification_capability_nonce !== receipt?.qualification_capability_payload?.nonce) {
    failures.push("formal request capability is absent or not bound to the canonical response");
  }
  if (result.qualification_capability_payload_sha256 !== data?.qualification_capability_payload_sha256 || result.qualification_capability_nonce !== data?.qualification_capability_nonce) {
    failures.push("scored request capability differs from the canonical response");
  }
  const serverVerification = verifyQualificationServerResponseReceipt({
    receipt:data?.qualification_server_receipt,publicKeyPem,
    runId,stageId,
    caseId:result.question_id || result.id,clientRequestId:record.client_request_id,
    message:result.question,response:data,
  });
  if (!serverVerification.passed) failures.push(...serverVerification.failures);
  const bodyVerification = verifyQualificationResponseBodySignature({
    signature:receipt?.server_response_body_signature,publicKeyPem,runId,stageId,caseId:result.question_id || result.id,
    clientRequestId:record.client_request_id,rawBody:readFileSync(rawPath),
  });
  if (!bodyVerification.passed) failures.push(...bodyVerification.failures);
  if (result.response_route_source !== "CANONICAL_HTTP_CHAT_RESPONSE" || result.served_via_canonical_chat !== true || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(String(record.endpoint || ""))) failures.push("canonical HTTP route marker or endpoint is invalid");
  if (receipt?.qualification_context_sha256) {
    if (data?.qualification_context_applied !== true || data?.qualification_context_sha256 !== receipt.qualification_context_sha256 ||
        data?.qualification_capability_payload_sha256 !== receipt.qualification_capability_payload_sha256 ||
        data?.qualification_capability_nonce !== receipt.qualification_capability_payload?.nonce) failures.push("qualification context capability receipt mismatch");
    if (result.qualification_context_applied !== true || result.qualification_context_sha256 !== receipt.qualification_context_sha256 ||
        result.qualification_capability_payload_sha256 !== data?.qualification_capability_payload_sha256 || result.qualification_capability_nonce !== data?.qualification_capability_nonce) {
      failures.push("scored qualification context differs from the canonical served context");
    }
  } else if (data?.qualification_context_applied !== false || data?.qualification_context_sha256 != null) {
    failures.push("canonical response unexpectedly applied qualification context");
  }
  return { passed:failures.length === 0,failures,receipt,data,served_answer_sha256:answerSha };
}
