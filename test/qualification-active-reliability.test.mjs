import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync,randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createQualificationResponseBodySignature,createQualificationServerResponseReceipt } from "../server/services/qualificationContextService.js";
import { runActiveReliabilityJourneys } from "../scripts/lib/qualification-worker/activeReliability.mjs";

test("active reliability uses signed canonical chat for sequential, concurrent and cancellation recovery",async (t) => {
  const keys=generateKeyPairSync("ed25519",{ publicKeyEncoding:{ type:"spki",format:"pem" },privateKeyEncoding:{ type:"pkcs8",format:"pem" } });
  const runId="post-t4-20260905000000-1234abcd";
  const server=createServer(async (req,res) => {
    if (req.method==="GET" && req.url==="/health") {
      res.writeHead(200,{ "content-type":"application/json" });
      return res.end(JSON.stringify({ ready:true,worker_pid:123,restarts:1,identity:{ id:"model-104" } }));
    }
    if (req.method==="GET" && req.url==="/api/portfolio") {
      const accounts=req.headers["x-demo-user-id"]==="empty-demo" ? [] : [{ id:"account-1" }];
      res.writeHead(200,{ "content-type":"application/json" });
      return res.end(JSON.stringify({ pensionAccounts:accounts }));
    }
    if (req.method==="GET" && req.url==="/api/auth/session") {
      res.writeHead(200,{ "content-type":"application/json" });
      return res.end(JSON.stringify({ authenticated:false }));
    }
    let raw="";
    for await (const chunk of req) raw+=chunk;
    const body=JSON.parse(raw);
    const caseId=String(req.headers["x-qualification-case-id"] || "");
    if (caseId==="reliability-cancel") {
      await new Promise((resolve) => setTimeout(resolve,300));
      if (res.destroyed) return;
    }
    const journeyAnswers={
      "reliability-journey-01":"£50 leaves £738, £100 leaves £673, and £200 leaves £542.",
      "reliability-journey-02":"Read the booklet before a scheme change request.",
      "reliability-journey-03":"Standard Life is Deferred with £32,150.",
      "reliability-journey-04":"A worker may opt out.",
      "reliability-journey-05":"I cannot recommend a fund. The style is Balanced and OneLife is Cautious.",
    };
    const answer=journeyAnswers[caseId] || "I cannot recommend a specific fund.";
    const responsePayload={
      response:answer,answer,response_route:"REFUSE_ACTION",jurisdiction_scope:"UNSPECIFIED",
      sources:[],review_answer:answer,claim_citations:[],runtime_identity:null,confidence:"high",handoff:null,
      qualification_attempts:{ model_call_attempted:false,generation_attempts:0,retry_used:false,retry_reason:null,generation_attempt_ledger:[],recovered_from_truncation:false },
      qualification_context_applied:false,qualification_context_sha256:null,
      qualification_capability_payload_sha256:null,qualification_capability_nonce:null,
    };
    const receipt=createQualificationServerResponseReceipt({ privateKeyPem:keys.privateKey,runId,stageId:"RELIABILITY_GATE",caseId,clientRequestId:body.client_request_id,message:body.message,response:responsePayload });
    const final={ ...responsePayload,qualification_server_receipt:receipt };
    const bytes=Buffer.from(JSON.stringify(final));
    const signature=createQualificationResponseBodySignature({ privateKeyPem:keys.privateKey,runId,stageId:"RELIABILITY_GATE",caseId,clientRequestId:body.client_request_id,rawBody:bytes });
    res.writeHead(200,{ "content-type":"application/json","x-qualification-body-sha256":signature.body_sha256,"x-qualification-body-signature":signature.signature });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  const result=await runActiveReliabilityJourneys({ endpoint,modelEndpoint:endpoint,runId,secret:randomBytes(32).toString("hex"),publicKeyPem:keys.publicKey,modelReadyTimeoutMs:2_000,pollMs:10,limits:{ sustained_requests:15,supported_concurrency:4,deterministic_latency_limit_ms:5_000,cancellation_after_ms:100 } });
  assert.equal(result.passed,true);
  assert.equal(result.sequential.total,15);
  assert.equal(result.concurrent.total,4);
  assert.equal(result.cancellation.aborted,true);
  assert.equal(result.post_cancel.identity_verified,true);
});
