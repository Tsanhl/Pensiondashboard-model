import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createCustodianBodySignature,mintCustodianCapability,normaliseCustodianContext,verifyAndConsumeCustodianCapability,verifyCustodianBodySignature } from "../server/services/custodianContextService.js";

const context={ version:"sealed-unseen-synthetic-context-v1",case_id:"opaque-01",declared_jurisdiction:"GREAT_BRITAIN",conversation_context:[],synthetic_fixture:{ evidence_id:"fixture-01",title:"Synthetic fixture",as_of_date:"2026-09-05",values:{ age:55,status:"active" } } };

test("separate custodian capability binds one context and rejects replay or scoring material",() => {
  const prior=process.env.SEALED_UNSEEN_NONCE_STORE_PATH;
  process.env.SEALED_UNSEEN_NONCE_STORE_PATH=mkdtempSync(join(tmpdir(),"custodian-nonces-"));
  try {
    const key=randomBytes(32).toString("hex");
    const capability=mintCustodianCapability({ key,runId:"sealed-run-01",caseId:"opaque-01",clientRequestId:"request-01",message:"Question",context });
    const verified=verifyAndConsumeCustodianCapability({ capability,key,runId:"sealed-run-01",caseId:"opaque-01",clientRequestId:"request-01",message:"Question",context });
    assert.equal(verified.context_sha256,capability.payload.context_sha256);
    assert.throws(() => verifyAndConsumeCustodianCapability({ capability,key,runId:"sealed-run-01",caseId:"opaque-01",clientRequestId:"request-01",message:"Question",context }),/already been consumed/);
    assert.throws(() => normaliseCustodianContext({ ...context,synthetic_fixture:{ ...context.synthetic_fixture,values:{ gold_answer:"pass" } } }),/prohibited/);
    const raw=Buffer.from('{"ok":true}');
    const signed=createCustodianBodySignature({ key,runId:"sealed-run-01",caseId:"opaque-01",clientRequestId:"request-01",rawBody:raw });
    assert.equal(verifyCustodianBodySignature({ key,signature:signed.signature,runId:"sealed-run-01",caseId:"opaque-01",clientRequestId:"request-01",rawBody:raw }).passed,true);
    assert.equal(verifyCustodianBodySignature({ key,signature:signed.signature,runId:"sealed-run-01",caseId:"opaque-01",clientRequestId:"request-01",rawBody:Buffer.from("changed") }).passed,false);
  } finally {
    if (prior===undefined) delete process.env.SEALED_UNSEEN_NONCE_STORE_PATH;
    else process.env.SEALED_UNSEEN_NONCE_STORE_PATH=prior;
  }
});
