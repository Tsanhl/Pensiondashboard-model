import { randomUUID } from "node:crypto";
import {
  mintQualificationRequestCapability,
  verifyQualificationResponseBodySignature,
  verifyQualificationServerResponseReceipt,
} from "../../../server/services/qualificationContextService.js";
import { canonicalHash,now,sleep } from "./utils.mjs";

async function waitForReady(modelEndpoint,timeoutMs,pollMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${modelEndpoint}/health`,{ signal:AbortSignal.timeout(2_000) });
      last = await response.json().catch(() => null);
      if (response.ok && last?.ready === true) return last;
    } catch (error) { last = { error:error.message }; }
    await sleep(pollMs);
  }
  throw Object.assign(new Error(`Model did not recover after cancellation: ${JSON.stringify(last)}`),{ code:"INFRASTRUCTURE_TEMPORARY" });
}

function exactResponseIdentity({ data,rawBytes,response,publicKeyPem,runId,caseId,clientRequestId,message }) {
  const body = verifyQualificationResponseBodySignature({
    signature:response.headers.get("x-qualification-body-signature"),publicKeyPem,
    runId,stageId:"RELIABILITY_GATE",caseId,clientRequestId,rawBody:rawBytes,
  });
  const receipt = verifyQualificationServerResponseReceipt({
    receipt:data?.qualification_server_receipt,publicKeyPem,runId,stageId:"RELIABILITY_GATE",
    caseId,clientRequestId,message,response:data,
  });
  return body.passed && receipt.passed && response.headers.get("x-qualification-body-sha256") === body.body_sha256
    && data?.qualification_context_applied === false && data?.qualification_context_sha256 == null
    && typeof data?.response === "string" && data.answer === data.response
    && typeof data?.qualification_attempts?.model_call_attempted === "boolean";
}

async function postCanonical({ endpoint,runId,secret,publicKeyPem,caseId,message,signal }) {
  const clientRequestId = `${caseId}-${randomUUID()}`;
  const capability = mintQualificationRequestCapability({ secret,runId,stageId:"RELIABILITY_GATE",caseId,clientRequestId,message });
  const started = Date.now();
  const response = await fetch(`${endpoint}/chat`,{
    method:"POST",signal,
    headers:{
      "content-type":"application/json","x-demo-user-id":"alex-morgan",
      "x-qualification-stage-id":"RELIABILITY_GATE","x-qualification-case-id":caseId,
      "x-qualification-model-attempt-limit":"2",
    },
    body:JSON.stringify({ client_request_id:clientRequestId,message,qualification_capability:{ payload:capability.payload,signature:capability.signature } }),
  });
  const rawBytes = Buffer.from(await response.arrayBuffer());
  const data = JSON.parse(rawBytes.toString("utf8"));
  return {
    case_id:caseId,client_request_id:clientRequestId,http_status:response.status,elapsed_ms:Date.now()-started,
    answer:data.response,response_route:data.response_route,confidence:data.confidence,
    model_call_attempted:data.qualification_attempts?.model_call_attempted,
    generation_attempts:data.qualification_attempts?.generation_attempts,
    retry_used:data.qualification_attempts?.retry_used,
    identity_verified:response.ok && exactResponseIdentity({ data,rawBytes,response,publicKeyPem,runId,caseId,clientRequestId,message }),
    canonical_fingerprint:canonicalHash({ answer:data.response,response_route:data.response_route,sources:data.sources || [],claim_citations:data.claim_citations || [] }),
  };
}

async function getJson(endpoint,path,userId,headers={}) {
  const response=await fetch(`${endpoint}${path}`,{ headers:{ "x-demo-user-id":userId,...headers },signal:AbortSignal.timeout(10_000) });
  return { ok:response.ok,status:response.status,body:await response.json().catch(() => null) };
}

export async function runActiveReliabilityJourneys({ endpoint,modelEndpoint,runId,secret,publicKeyPem,modelReadyTimeoutMs,pollMs,limits }) {
  const stableMessage = "Which specific pension fund is best for me?";
  const repeat = [];
  for (let index=1; index<=limits.sustained_requests; index+=1) repeat.push(await postCanonical({
    endpoint,runId,secret,publicKeyPem,caseId:`reliability-repeat-${String(index).padStart(2,"0")}`,message:stableMessage,
  }));
  const concurrent = await Promise.all(Array.from({ length:limits.supported_concurrency },(_,index) => postCanonical({
    endpoint,runId,secret,publicKeyPem,caseId:`reliability-concurrent-${String(index+1).padStart(2,"0")}`,message:stableMessage,
  })));
  const journeySpecs=[
    { message:"Show how adding £50, £100, or £200 monthly changes my remaining retirement income gap.",must_include:["£50","£100","£200","£738","£673","£542"] },
    { message:"What should I read before asking to change my Northbridge workplace pension scheme?",must_include:["booklet","scheme change"] },
    { message:"What happened to my Harbour Logistics pension after I left?",must_include:["Standard Life","Deferred","£32,150"] },
    { message:"Can a worker opt out of automatic enrolment?",must_include:["may opt out"] },
    { message:stableMessage,must_include:["cannot recommend","Balanced","OneLife","Cautious"] },
  ];
  const journeys=[];
  for (const [index,spec] of journeySpecs.entries()) {
    const item=await postCanonical({ endpoint,runId,secret,publicKeyPem,caseId:`reliability-journey-${String(index+1).padStart(2,"0")}`,message:spec.message });
    const normalized=String(item.answer || "").replaceAll(",","").toLowerCase();
    journeys.push({ ...item,required_terms_present:spec.must_include.every((term) => normalized.includes(String(term).replaceAll(",","").toLowerCase())) });
  }
  const cancelController = new AbortController();
  const cancelTimer = setTimeout(() => cancelController.abort(),limits.cancellation_after_ms);
  let cancellation;
  try {
    const response = await postCanonical({
      endpoint,runId,secret,publicKeyPem,caseId:"reliability-cancel",
      message:"Explain how UK pension trustees should exercise a discretionary power, including relevant legal duties and limits.",
      signal:cancelController.signal,
    });
    cancellation = { aborted:false,unexpected_response:response };
  } catch (error) {
    cancellation = { aborted:error?.name === "AbortError",error_name:error?.name || null,error:String(error?.message || error) };
  } finally { clearTimeout(cancelTimer); }
  const modelAfterCancellation = await waitForReady(modelEndpoint,modelReadyTimeoutMs,pollMs);
  const postCancel = await postCanonical({ endpoint,runId,secret,publicKeyPem,caseId:"reliability-post-cancel",message:stableMessage });
  const alexPortfolio=await getJson(endpoint,"/api/portfolio","alex-morgan");
  const emptyPortfolio=await getJson(endpoint,"/api/portfolio","empty-demo");
  const invalidSession=await getJson(endpoint,"/api/auth/session","alex-morgan",{ authorization:"Bearer invalid-session-token" });
  const alexAccounts=alexPortfolio.body?.pensionAccounts || alexPortfolio.body?.accounts || [];
  const emptyAccounts=emptyPortfolio.body?.pensionAccounts || emptyPortfolio.body?.accounts || [];
  const applicationBoundaries={
    portfolio_user_separation:alexPortfolio.ok && emptyPortfolio.ok && alexAccounts.length>0 && emptyAccounts.length===0,
    invalid_session_rejected:invalidSession.ok && invalidSession.body?.authenticated===false,
    alex_account_count:alexAccounts.length,empty_account_count:emptyAccounts.length,invalid_session_status:invalidSession.status,
  };
  const repeatFingerprint = new Set(repeat.map((item) => item.canonical_fingerprint));
  const concurrentFingerprint = new Set(concurrent.map((item) => item.canonical_fingerprint));
  const allResponses = [...repeat,...concurrent,...journeys,postCancel];
  const blockers = [];
  if (allResponses.some((item) => !item.identity_verified || item.http_status !== 200 || item.confidence === "model_unavailable")) blockers.push("one or more canonical live journeys lacked a valid signed response");
  if (repeatFingerprint.size !== 1) blockers.push(`${limits.sustained_requests} sequential deterministic journeys were not stable`);
  if (concurrentFingerprint.size !== 1 || [...concurrentFingerprint][0] !== [...repeatFingerprint][0]) blockers.push(`${limits.supported_concurrency} concurrent deterministic journeys were not stable`);
  if (journeys.some((item) => !item.required_terms_present)) blockers.push("one or more fixed repaired product journeys omitted required dashboard facts or boundaries");
  if (allResponses.some((item) => item.elapsed_ms>limits.deterministic_latency_limit_ms)) blockers.push("a deterministic live journey exceeded the declared latency limit");
  if (!cancellation.aborted) blockers.push("product-path request cancellation was not observed");
  if (!postCancel.identity_verified || modelAfterCancellation?.ready !== true) blockers.push("runtime did not recover after request cancellation");
  if (!applicationBoundaries.portfolio_user_separation || !applicationBoundaries.invalid_session_rejected) blockers.push("user separation or invalid-session application checks failed");
  return {
    version:"qualification-active-live-reliability-v1",completed_at:now(),passed:blockers.length===0,blockers,
    declared_limits:limits,sequential:{ total:repeat.length,stable:repeatFingerprint.size===1,items:repeat },
    concurrent:{ total:concurrent.length,stable:concurrentFingerprint.size===1,items:concurrent },
    fixed_product_journeys:{ total:journeys.length,passed:journeys.every((item) => item.required_terms_present && item.identity_verified),items:journeys },
    application_boundaries:applicationBoundaries,cancellation,post_cancel:postCancel,model_after_cancellation:{ ready:modelAfterCancellation.ready,worker_pid:modelAfterCancellation.worker_pid,restarts:modelAfterCancellation.restarts,model_id:modelAfterCancellation.identity?.id || null },
    retry_policy:{ max_end_to_end_attempts:2,automatic_retries_per_case:1 },sealed_unseen_accessed:false,
  };
}
