import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { captureBindings, compareBindings, manifestDirectory } from "../scripts/lib/qualification-worker/artifactManifest.mjs";
import { createExecutionReceipt, validateExecutionReceipt } from "../scripts/lib/qualification-worker/stageRegistry.mjs";
import { fileRecord,sha256Buffer } from "../scripts/lib/qualification-worker/utils.mjs";
import { persistServedResponseReceipt, verifyServedResponseReceipt } from "../scripts/lib/servedResponseReceipt.mjs";
import { createQualificationResponseBodySignature, createQualificationServerResponseReceipt } from "../server/services/qualificationContextService.js";

test("served-response receipts bind raw HTTP bytes through a server-signed answer commitment", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-served-response-"));
  const prior = { publicKey:process.env.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM,run:process.env.QUALIFICATION_RUN_ID,stage:process.env.QUALIFICATION_STAGE_ID };
  try {
    const keys = generateKeyPairSync("ed25519",{ publicKeyEncoding:{ type:"spki",format:"pem" },privateKeyEncoding:{ type:"pkcs8",format:"pem" } });
    const runId = "post-t4-20260904010101-deadbeef";
    const stageId = "LIVE50_FULL_REGRESSION";
    const caseId = "L01";
    const clientRequestId = "served-request-1";
    const message = "What is shown?";
    const capabilityPayload = { nonce:"11111111-1111-4111-8111-111111111111" };
    const response = { response:"The pinned value is £100.",answer:"The pinned value is £100.",review_answer:"The pinned value is £100.",response_route:"ANSWER",jurisdiction_scope:"GREAT_BRITAIN",sources:[],claim_citations:[],runtime_identity:null,qualification_attempts:null,qualification_context_applied:false,qualification_context_sha256:null,qualification_capability_payload_sha256:"placeholder",qualification_capability_nonce:capabilityPayload.nonce };
    const requestBodyText = JSON.stringify({ client_request_id:clientRequestId,message });
    const capabilitySha256 = sha256Buffer(JSON.stringify(capabilityPayload));
    response.qualification_capability_payload_sha256 = capabilitySha256;
    response.qualification_server_receipt = createQualificationServerResponseReceipt({ privateKeyPem:keys.privateKey,runId,stageId,caseId,clientRequestId,message,response });
    const rawResponseBytes = Buffer.from(JSON.stringify(response));
    const bodySignature = createQualificationResponseBodySignature({ privateKeyPem:keys.privateKey,runId,stageId,caseId,clientRequestId,rawBody:rawResponseBytes });
    process.env.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM = keys.publicKey;
    process.env.QUALIFICATION_RUN_ID = runId;
    process.env.QUALIFICATION_STAGE_ID = stageId;
    const record = persistServedResponseReceipt({ outputRoot:root,caseId,endpoint:"http://127.0.0.1:3001",clientRequestId,message,requestBodyText,rawResponseBytes,httpStatus:200,responseBodySha256:bodySignature.body_sha256,responseBodySignature:bodySignature.signature,qualificationCapability:{ payload:capabilityPayload } });
    const result = { id:caseId,question:message,answer:response.response,actual_route:"ANSWER",selected_jurisdiction:"GREAT_BRITAIN",final_public_sources:[],generated_citations:[],claim_citations:[],review_answer:response.review_answer,runtime_identity:null,model_call_attempted:false,qualification_context_applied:false,qualification_context_sha256:null,qualification_capability_payload_sha256:capabilitySha256,qualification_capability_nonce:capabilityPayload.nonce,served_via_canonical_chat:true,response_route_source:"CANONICAL_HTTP_CHAT_RESPONSE",served_response_sha256:record.served_answer_sha256,served_response_receipt:record };
    assert.equal(verifyServedResponseReceipt(result,{ outputRoot:root }).passed,true);
    assert.equal(verifyServedResponseReceipt({ ...result,answer:"Substituted" },{ outputRoot:root }).passed,false);
    assert.equal(verifyServedResponseReceipt({ ...result,selected_jurisdiction:"SCOTLAND" },{ outputRoot:root }).passed,false);
    assert.equal(verifyServedResponseReceipt({ ...result,review_answer:"Substituted review" },{ outputRoot:root }).passed,false);
    assert.equal(verifyServedResponseReceipt({ ...result,claim_citations:[{ claim:"invented",source_ids:[] }] },{ outputRoot:root }).passed,false);
    const attackerKeys = generateKeyPairSync("ed25519",{ publicKeyEncoding:{ type:"spki",format:"pem" },privateKeyEncoding:{ type:"pkcs8",format:"pem" } });
    assert.equal(verifyServedResponseReceipt(result,{ outputRoot:root,publicKeyPem:attackerKeys.publicKey }).passed,false);
    const reserializedRoot = join(root,"reserialized");
    const reserializedBytes = Buffer.from(JSON.stringify(response,null,2));
    const reserializedRecord = persistServedResponseReceipt({ outputRoot:reserializedRoot,caseId,endpoint:"http://127.0.0.1:3001",clientRequestId,message,requestBodyText,rawResponseBytes:reserializedBytes,httpStatus:200,responseBodySha256:bodySignature.body_sha256,responseBodySignature:bodySignature.signature,qualificationCapability:{ payload:capabilityPayload } });
    assert.equal(verifyServedResponseReceipt({ ...result,served_response_receipt:reserializedRecord },{ outputRoot:reserializedRoot }).passed,false,"reserialized bytes must not retain the server body signature");

    const badResponse = { ...response,response:"one",answer:"two" };
    const badRecord = persistServedResponseReceipt({ outputRoot:root,caseId:"L02",endpoint:"http://127.0.0.1:3001",clientRequestId:"served-request-2",message,requestBodyText,rawResponseBytes:Buffer.from(JSON.stringify(badResponse)),httpStatus:200,qualificationCapability:{ payload:capabilityPayload } });
    assert.equal(verifyServedResponseReceipt({ ...result,id:"L02",answer:"one",served_response_sha256:badRecord.served_answer_sha256,served_response_receipt:badRecord },{ outputRoot:root }).passed,false);
  } finally {
    if (prior.publicKey === undefined) delete process.env.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM; else process.env.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM = prior.publicKey;
    if (prior.run === undefined) delete process.env.QUALIFICATION_RUN_ID; else process.env.QUALIFICATION_RUN_ID = prior.run;
    if (prior.stage === undefined) delete process.env.QUALIFICATION_STAGE_ID; else process.env.QUALIFICATION_STAGE_ID = prior.stage;
    rmSync(root,{ recursive:true,force:true });
  }
});

test("exact source bindings detect downstream-changing edits", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-artifacts-"));
  try {
    mkdirSync(join(root, "source"));
    writeFileSync(join(root, "source/a.js"), "one\n");
    const bindings = captureBindings(root, ["source/a.js"]);
    assert.deepEqual(compareBindings(root, bindings), []);
    writeFileSync(join(root, "source/a.js"), "two\n");
    assert.equal(compareBindings(root, bindings).length, 1);
    const manifest = manifestDirectory(root, "source", join(root, "manifest.json"));
    assert.equal(manifest.files.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("child execution receipts require a clean exit and immutable bound artifacts", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-receipt-"));
  try {
    const context = {
      projectRoot:root,
      state:{
        run_id:"post-t4-20260904010101-abcdef12",config_sha256:"a".repeat(64),source_bindings:{},
        expected_runtime_identity:{ id:"candidate-step104" },corpus_integrity_sha256:"b".repeat(64),
        canonical_facts_sha256:"c".repeat(64),runtime_configuration_sha256:"d".repeat(64),python_environment_sha256:"e".repeat(64),
      },
    };
    const output = join(root,"output.json");
    const receipt = join(root,"receipt.json");
    writeFileSync(output,"{}\n");
    createExecutionReceipt({
      context,receiptPath:receipt,stage:"LIVE50_FULL_REGRESSION",command:process.execPath,args:["runner.mjs"],
      execution:{ code:0,signal:null,error:null,timed_out:false,termination:null },
      artifacts:[fileRecord(root,"output.json")],extraInputs:{ bank_sha256:"f".repeat(64) },
    });
    assert.equal(validateExecutionReceipt({
      context,receiptPath:receipt,stage:"LIVE50_FULL_REGRESSION",command:process.execPath,args:["runner.mjs"],extraInputs:{ bank_sha256:"f".repeat(64) },
    }).execution.code,0);
    writeFileSync(output,"changed\n");
    assert.throws(() => validateExecutionReceipt({
      context,receiptPath:receipt,stage:"LIVE50_FULL_REGRESSION",command:process.execPath,args:["runner.mjs"],extraInputs:{ bank_sha256:"f".repeat(64) },
    }),/artifact changed/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("a timed-out child receipt can never be reused as a clean execution", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-dirty-receipt-"));
  try {
    const context = {
      projectRoot:root,
      state:{ run_id:"post-t4-20260904010101-abcdef12",config_sha256:"a".repeat(64),source_bindings:{},expected_runtime_identity:{},corpus_integrity_sha256:null,canonical_facts_sha256:null,runtime_configuration_sha256:null,python_environment_sha256:null },
    };
    writeFileSync(join(root,"execution.log"),"timed out\n");
    createExecutionReceipt({
      context,receiptPath:join(root,"receipt.json"),stage:"VISIBLE_CRITICAL4",command:process.execPath,args:["runner.mjs"],
      execution:{ code:null,signal:"SIGKILL",error:"timeout",timed_out:true,termination:{ reason:"STAGE_CHILD_TIMEOUT" } },
      artifacts:[fileRecord(root,"execution.log")],
    });
    assert.throws(() => validateExecutionReceipt({
      context,receiptPath:join(root,"receipt.json"),stage:"VISIBLE_CRITICAL4",command:process.execPath,args:["runner.mjs"],
    }),/did not complete cleanly/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("personal reviewer evidence ignores hostile datastore environment and requires the canonical fact digest", () => {
  const projectRoot = resolve(".");
  const database = resolve("data/pensions-dashboard.sqlite");
  const safeEnvironment = {
    HOME:process.env.HOME,PATH:process.env.PATH,LANG:process.env.LANG || "C",
    PENSIONS_STORAGE:"sqlite",PENSIONS_DB_PATH:database,QUALIFICATION_CANONICAL_USER_ID:"alex-morgan",DISABLE_DOTENV_LOAD:"true",
  };
  const readiness = spawnSync(process.execPath,["--input-type=module","-e",
    "const {canonicalQualificationFactsReadiness}=await import('./server/services/readinessService.js');process.stdout.write(JSON.stringify(canonicalQualificationFactsReadiness(process.env)));",
  ],{ cwd:projectRoot,env:safeEnvironment,encoding:"utf8" });
  assert.equal(readiness.status,0,readiness.stderr);
  const expected = JSON.parse(readiness.stdout);
  assert.equal(expected.ready,true);
  const args = [resolve("scripts/qualificationPersonalEvidence.mjs"),"--project-root",projectRoot,"--database",database,"--canonical-facts-sha256",expected.canonicalFactsSha256,"--user","alex-morgan"];
  const probe = spawnSync(process.execPath,args,{
    cwd:projectRoot,encoding:"utf8",
    env:{ ...safeEnvironment,PENSIONS_STORAGE:"postgres",PENSIONS_DB_PATH:"/private/tmp/hostile.sqlite",DATABASE_URL:"postgres://invalid.invalid/db" },
  });
  assert.equal(probe.status,0,probe.stderr);
  const payload = JSON.parse(probe.stdout);
  assert.equal(payload.database_path,database);
  assert.equal(payload.canonical_facts_sha256,expected.canonicalFactsSha256);
  assert.ok(payload.sources.length > 0);
  const rejected = spawnSync(process.execPath,[...args.slice(0,6),"0".repeat(64),...args.slice(7)],{ cwd:projectRoot,env:safeEnvironment,encoding:"utf8" });
  assert.notEqual(rejected.status,0);
});
