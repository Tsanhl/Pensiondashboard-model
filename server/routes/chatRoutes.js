import { deleteConversation, getConversation, listConversations } from "../repositories/conversationRepository.js";
import { runChat } from "../services/chatService.js";
import { checkRateLimitAsync } from "../services/rateLimitService.js";
import {
  isLoopbackAddress,
  createQualificationResponseBodySignature,
  createQualificationServerResponseReceipt,
  qualificationRuntimeEnabled,
  verifyAndConsumeQualificationRequestCapability,
} from "../services/qualificationContextService.js";
import {
  createCustodianBodySignature,
  custodianRuntimeEnabled,
  verifyAndConsumeCustodianCapability,
} from "../services/custodianContextService.js";

function match(pathname, expression) {
  const result = pathname.match(expression);
  return result ? result.slice(1).map(decodeURIComponent) : null;
}

export async function handleChatRoute({ req, res, url, json, readBody, userId }) {
  const chatPath = url.pathname === "/chat" || url.pathname === "/api/assistant";
  if (chatPath) {
    if (req.method !== "POST") return json(res, 405, { error:"Method not allowed" });
    await checkRateLimitAsync({ key:`chat:${userId}`,limit:Number(process.env.CHAT_RATE_LIMIT || 30),windowMs:60_000 });
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const clientRequestId = body.client_request_id || body.clientRequestId;
    const message = body.message || body.question;
    const formalQualification = qualificationRuntimeEnabled();
    const sealedCustodian = custodianRuntimeEnabled();
    if (formalQualification && sealedCustodian) throw Object.assign(new Error("Qualification and sealed custodian modes cannot share one runtime."),{ status:500 });
    const qualificationStageId = String(req.headers["x-qualification-stage-id"] || "");
    const qualificationCaseId = String(req.headers["x-qualification-case-id"] || body.qualification_context?.case_id || "");
    if (formalQualification && (!qualificationStageId || !qualificationCaseId || !isLoopbackAddress(req.socket?.remoteAddress))) {
      throw Object.assign(new Error("Formal qualification requests require a loopback stage and case identity."),{ status:403 });
    }
    let qualificationContext = null;
    let qualificationContextHash = null;
    let qualificationCapabilityReceipt = null;
    const custodianRunId = String(req.headers["x-sealed-unseen-run-id"] || "");
    const custodianCaseId = String(req.headers["x-sealed-unseen-case-id"] || body.custodian_context?.case_id || "");
    if (formalQualification) {
      if (body.custodian_capability !== undefined || body.custodian_context !== undefined) throw Object.assign(new Error("Custodian material is forbidden in qualification mode."),{ status:400 });
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        throw Object.assign(new Error("Qualification context is restricted to the local formal qualification runtime."), { status:403 });
      }
      qualificationCapabilityReceipt = verifyAndConsumeQualificationRequestCapability({
        capability:body.qualification_capability,
        secret:process.env.QUALIFICATION_CONTEXT_HMAC_KEY,
        runId:process.env.QUALIFICATION_RUN_ID,
        stageId:qualificationStageId,
        caseId:qualificationCaseId,clientRequestId,message,context:body.qualification_context ?? null,
      });
      qualificationContext = qualificationCapabilityReceipt.normalized_context;
      qualificationContextHash = qualificationCapabilityReceipt.context_sha256;
      if (qualificationContext && qualificationContext.case_id !== qualificationCaseId) {
        throw Object.assign(new Error("Qualification case header does not match the signed synthetic context."),{ status:403 });
      }
    } else if (sealedCustodian) {
      if (body.qualification_capability !== undefined || body.qualification_context !== undefined) throw Object.assign(new Error("Qualification material is forbidden in custodian mode."),{ status:400 });
      if (!isLoopbackAddress(req.socket?.remoteAddress) || !custodianRunId || !custodianCaseId) {
        throw Object.assign(new Error("Sealed custodian requests require loopback run and case identity."),{ status:403 });
      }
      qualificationCapabilityReceipt = verifyAndConsumeCustodianCapability({
        capability:body.custodian_capability,key:process.env.SEALED_UNSEEN_CONTEXT_HMAC_KEY,
        runId:process.env.SEALED_UNSEEN_RUN_ID,caseId:custodianCaseId,clientRequestId,message,context:body.custodian_context,
      });
      if (custodianRunId !== process.env.SEALED_UNSEEN_RUN_ID) throw Object.assign(new Error("Sealed custodian run identity mismatch."),{ status:403 });
      qualificationContext=qualificationCapabilityReceipt.normalized_context;
      qualificationContextHash=qualificationCapabilityReceipt.context_sha256;
    } else if (body.qualification_capability !== undefined || body.qualification_context !== undefined || body.custodian_capability !== undefined || body.custodian_context !== undefined) {
      throw Object.assign(new Error("Qualification capability and context are restricted to a formal qualification runtime."), { status:400 });
    }
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      const result = await runChat({
        userId,
        sessionId:body.session_id,
        clientRequestId,
        message,
        abortSignal:controller.signal,
        qualificationContext,
        qualificationContextSha256:qualificationContextHash,
        maxModelAttempts:String(process.env.QUALIFICATION_ATTEMPT_TELEMETRY || "false").toLowerCase() === "true"
          ? Math.max(1, Math.min(2, Number(req.headers["x-qualification-model-attempt-limit"] || 2)))
          : undefined,
      });
      const qualificationTelemetryEnabled = String(process.env.QUALIFICATION_ATTEMPT_TELEMETRY || "false").toLowerCase() === "true";
      const qualificationTelemetry = qualificationTelemetryEnabled && !result.qualification_attempts
        ? { qualification_attempts:{ model_call_attempted:false,generation_attempts:0,retry_used:false,retry_reason:null,generation_attempt_ledger:[],recovered_from_truncation:false },runtime_identity:null }
        : {};
      const responsePayload = {
        ...result,...qualificationTelemetry,answer:result.response,
        qualification_context_applied:Boolean(qualificationContext),
        qualification_context_sha256:qualificationContextHash,
        qualification_capability_payload_sha256:qualificationCapabilityReceipt?.capability_payload_sha256 || null,
        qualification_capability_nonce:qualificationCapabilityReceipt?.nonce || null,
      };
      const qualificationServerReceipt = formalQualification ? createQualificationServerResponseReceipt({
        privateKeyPem:process.env.QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM,runId:process.env.QUALIFICATION_RUN_ID,
        stageId:qualificationStageId,caseId:qualificationCaseId,clientRequestId,message,response:responsePayload,
      }) : null;
      const finalPayload = { ...responsePayload,qualification_server_receipt:qualificationServerReceipt };
      if (formalQualification || sealedCustodian) {
        const rawBody = Buffer.from(JSON.stringify(finalPayload));
        const bodySignature = formalQualification
          ? createQualificationResponseBodySignature({
            privateKeyPem:process.env.QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM,runId:process.env.QUALIFICATION_RUN_ID,
            stageId:qualificationStageId,caseId:qualificationCaseId,clientRequestId,rawBody,
          })
          : createCustodianBodySignature({
            key:process.env.SEALED_UNSEEN_CONTEXT_HMAC_KEY,runId:process.env.SEALED_UNSEEN_RUN_ID,
            caseId:custodianCaseId,clientRequestId,rawBody,
          });
        res.writeHead(200,{
          "Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",
          [formalQualification ? "X-Qualification-Body-SHA256" : "X-Sealed-Unseen-Body-SHA256"]:bodySignature.body_sha256,
          [formalQualification ? "X-Qualification-Body-Signature" : "X-Sealed-Unseen-Body-Signature"]:bodySignature.signature,
        });
        res.end(rawBody);
        return true;
      }
      return json(res,200,finalPayload);
    } finally {
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
  }
  if (url.pathname === "/api/conversations") {
    if (req.method !== "GET") return json(res, 405, { error:"Method not allowed" });
    return json(res, 200, { conversations:await listConversations(userId, Number(url.searchParams.get("limit") || 20)) });
  }
  const conversationMatch = match(url.pathname, /^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch) {
    if (req.method === "GET") {
      const conversation = await getConversation(userId, conversationMatch[0]);
      return conversation ? json(res, 200, { conversation }) : json(res, 404, { error:"Conversation not found" });
    }
    if (req.method === "DELETE") {
      const deleted = await deleteConversation(userId, conversationMatch[0]);
      return json(res, deleted ? 204 : 404, deleted ? {} : { error:"Conversation not found" });
    }
    return json(res, 405, { error:"Method not allowed" });
  }
  return false;
}
