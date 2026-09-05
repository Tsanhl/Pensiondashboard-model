import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join } from "node:path";
import { aggregateDualReviews, codexExecutionReceiptClean, codexReviewProvidersValid, inspectCodexJsonEvents, prepareReviewCases, reviewerReceiptFilesValid } from "../aiReview.mjs";
import { discoverTransitiveLocalImports, validateArtifactRecords } from "../artifactManifest.mjs";
import { validateAiGate, validateCaseAttemptLedgers, validateConfig, validateT4Summary, validateTopic161Summary } from "../gateValidators.mjs";
import { assertCommandAllowed, assertNoProtectedCredentials, assertPathAllowed } from "../protectedPaths.mjs";
import { createExclusive, fileRecord, sha256Buffer, sha256File } from "../utils.mjs";
import { auditConsumedCapabilities,EXECUTABLE_ENTRY_PATHS, qualificationStageSandboxProfile } from "../stageRegistry.mjs";
import { bindCaseEvidence,mergeCaseEvidenceCatalog } from "../trustedEvidence.mjs";
import { combineGenerationTelemetry } from "../liveAttemptTelemetry.mjs";
import { qualificationChildEnvironment, REQUIRED_QUALIFICATION_CHILD_ENV } from "../qualificationChildEnvironment.mjs";
import { qualificationRuntimeChildSandboxProfile, runtimeChildEnvironment } from "../runtimeChildEnvironment.mjs";

const permissions = { allow_training: false, allow_sealed_unseen: false, allow_release: false, allow_git_push: false, allow_origin_change: false, allow_narrow_product_repairs: true };
const hardGates = { all_material_claims_supported: true, citations_entail_claims: true, correct_jurisdiction: true, no_unsafe_instruction: true, no_unsupported_outcome: true, no_wrong_personal_fact: true, no_absolute_certainty_claim:true };
const dimensions = { factual_support: 32, citation_entailment: 15, law_and_jurisdiction: 12, completeness: 8, safety_and_boundary: 8, clarity: 4 };
const review = (overrides = {}) => ({ cases: [{ case_id: "case-1", verdict: "PASS", quality_score: 79, dimensions, hard_gates: hardGates, claims: [{ proposition_id:"PROP:001",claim: "I cannot perform this action", claim_type:"POLICY_BOUNDARY", evidence_ids: ["POLICY:DETERMINISTIC_ROUTE"], supported: true, reason: "supported" }], failure_classes: [], rationale: "supported", limitations: [], ...overrides }] });
const withServedCommitment = (input) => ({ ...input,served_response_verified:true,served_answer_sha256:sha256Buffer(String(input.rendered_answer || input.answer || "")) });

test("worker policy keeps training, unseen, release and push closed", () => {
  const config = { permissions };
  assert.throws(() => assertPathAllowed("/tmp/project", "evaluation/sealed-unseen/gold.json", ["sealed-unseen"]));
  assert.throws(() => assertNoProtectedCredentials({ SEALED_UNSEEN_KEY: "present" }));
  assert.throws(() => assertCommandAllowed("git", ["push", "origin"], config));
  assert.throws(() => assertCommandAllowed("node", ["scripts/t4TrainCleanCumulative.mjs"], config));
  assert.throws(() => assertCommandAllowed("node", ["scripts/fooTrainAdapter.mjs"], config));
  assert.doesNotThrow(() => assertCommandAllowed("node", ["scripts/t4PostTrainingDevelopmentEval.mjs"], config));
});

test("qualification launcher forwards the complete fail-closed child contract", () => {
  const source = {
    QUALIFICATION_SOURCE_BINDINGS_SHA256:"a".repeat(64),QUALIFICATION_CANONICAL_USER_ID:"alex-morgan",
    QUALIFICATION_RUN_ID:"post-t4-20260904010101-abcdef12",QUALIFICATION_CONTEXT_HMAC_KEY:"b".repeat(64),
    QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM:"-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
    QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_SHA256:sha256Buffer("-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n"),
    QUALIFICATION_ATTEMPT_TELEMETRY:"true",LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY:"false",
    LOCAL_LLM_MAX_ATTEMPTS:"2",LOCAL_LLM_RETRY_READY_TIMEOUT_MS:"90000",CYCLE_V2_RETRY_RUN_ERRORS:"false",
  };
  const forwarded = qualificationChildEnvironment(source,true);
  assert.deepEqual(Object.keys(forwarded).sort(),[...REQUIRED_QUALIFICATION_CHILD_ENV].sort());
  assert.deepEqual(forwarded,source);
  assert.throws(() => qualificationChildEnvironment({ ...source,QUALIFICATION_SOURCE_BINDINGS_SHA256:"" },true),/missing/);
  assert.throws(() => qualificationChildEnvironment({ ...source,LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY:"true" },true),/fail-closed/);
});

test("only the dashboard runtime child receives capability and response-signing secrets", () => {
  const shared = { PATH:"/bin",QUALIFICATION_CONTEXT_HMAC_KEY:"leaked",QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM:"leaked",QUALIFICATION_NONCE_STORE_PATH:"leaked",QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH:"leaked",QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256:"leaked" };
  const dashboardOnly = { QUALIFICATION_CONTEXT_HMAC_KEY:"master",QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM:"private",QUALIFICATION_NONCE_STORE_PATH:"/nonce",QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH:"/allowed-contexts.json",QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256:"a".repeat(64) };
  for (const name of ["model","retrieval"]) {
    const child = runtimeChildEnvironment(shared,dashboardOnly,name);
    assert.equal(child.QUALIFICATION_CONTEXT_HMAC_KEY,undefined);
    assert.equal(child.QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM,undefined);
    assert.equal(child.QUALIFICATION_NONCE_STORE_PATH,undefined);
    assert.equal(child.QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_PATH,undefined);
    assert.equal(child.QUALIFICATION_ALLOWED_CONTEXT_MANIFEST_SHA256,undefined);
  }
  assert.equal(runtimeChildEnvironment(shared,dashboardOnly,"dashboard").QUALIFICATION_RESPONSE_SIGNING_PRIVATE_KEY_PEM,"private");
});

test("qualification child sandboxes deny controller secrets and process-environment inspection", () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(),"qualification-sandbox-"));
  try {
    const logRoot = join(root,"Log","qualification-worker");
    const runRoot = join(logRoot,"runs","post-t4-20260904010101-abcdef12");
    mkdirSync(runRoot,{ recursive:true });
    const currentOutput = join(runRoot,"development-results","t4-targeted");
    mkdirSync(currentOutput,{ recursive:true });
    const privatePath = join(logRoot,"controller-integrity-private.pem");
    writeFileSync(privatePath,"SECRET-MARKER\n");
    const stageProfile = qualificationStageSandboxProfile({ projectRoot:root,config:{ paths:{ log_root:"Log/qualification-worker" } },logPath:join(currentOutput,"stage.log") });
    const allowed = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/sh","-c",`echo evidence > ${JSON.stringify(join(currentOutput,"allowed.txt"))}`],{ encoding:"utf8" });
    assert.equal(allowed.status,0,allowed.stderr);
    const cat = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/cat",privatePath],{ encoding:"utf8" });
    assert.notEqual(cat.status,0,"a stage child must not read the controller integrity key");
    const overwrite = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/sh","-c",`echo forged > ${JSON.stringify(join(logRoot,"worker-events.anchor.json"))}`],{ encoding:"utf8" });
    assert.notEqual(overwrite.status,0,"a stage child must not rewrite the signed event anchor");
    const priorGate = join(runRoot,"stage-manifests","VERIFY_RUNTIME.json");
    mkdirSync(join(runRoot,"stage-manifests"),{ recursive:true });
    writeFileSync(priorGate,"prior\n");
    const priorGateWrite = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/sh","-c",`echo forged > ${JSON.stringify(priorGate)}`],{ encoding:"utf8" });
    assert.notEqual(priorGateWrite.status,0,"a stage child must not rewrite a predecessor gate");
    const publicKey = join(runRoot,"runtime-response-signing-public.pem");
    writeFileSync(publicKey,"PUBLIC\n");
    const publicKeyWrite = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/sh","-c",`echo forged > ${JSON.stringify(publicKey)}`],{ encoding:"utf8" });
    assert.notEqual(publicKeyWrite.status,0,"a stage child must not replace the response-verification key");
    const nonceStore = join(runRoot,"runtime-consumed-capability-nonces");
    mkdirSync(nonceStore,{ recursive:true });
    const noncePath = join(nonceStore,"consumed.json");
    writeFileSync(noncePath,"nonce\n");
    const nonceDelete = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/rm",noncePath],{ encoding:"utf8" });
    assert.notEqual(nonceDelete.status,0,"a stage child must not delete consumed capabilities");
    const sourcePath = join(root,"server-source.js");
    writeFileSync(sourcePath,"original\n");
    const sourceWrite = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/sh","-c",`echo forged > ${JSON.stringify(sourcePath)}`],{ encoding:"utf8" });
    assert.notEqual(sourceWrite.status,0,"a stage child must not rewrite project source");
    const ps = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/ps","eww","-p",String(process.pid)],{ encoding:"utf8" });
    assert.notEqual(ps.status,0,"a stage child must not inspect another process environment");
    const allowedContextManifest = join(root,"runtime","qualification-allowed-contexts","post-t4-20260904010101-abcdef12.json");
    mkdirSync(dirname(allowedContextManifest),{ recursive:true });
    writeFileSync(allowedContextManifest,"allowed\n");
    const runtimeProfile = qualificationRuntimeChildSandboxProfile({ runRoot,projectRoot:root,childName:"model",nonceStorePath:null,allowedContextManifestPath:allowedContextManifest,databasePath:join(root,"data","test.sqlite") });
    const runtimeCat = spawnSync("/usr/bin/sandbox-exec",["-p",runtimeProfile,"/bin/cat",privatePath],{ encoding:"utf8" });
    assert.notEqual(runtimeCat.status,0,"model and retrieval children must not read controller integrity material");
    const runtimePs = spawnSync("/usr/bin/sandbox-exec",["-p",runtimeProfile,"/bin/ps","eww","-p",String(process.pid)],{ encoding:"utf8" });
    assert.notEqual(runtimePs.status,0,"model and retrieval children must not inspect another process environment");
    const runtimeNode = spawnSync("/usr/bin/sandbox-exec",["-p",runtimeProfile,process.execPath,"-e",'console.log(JSON.stringify(require("node:os").userInfo()))'],{ encoding:"utf8" });
    assert.equal(runtimeNode.status,0,`runtime Node must be able to resolve its own identity: ${runtimeNode.stderr}`);
    assert.doesNotThrow(() => JSON.parse(runtimeNode.stdout));
    const aliasRoot = join(root,"..",`qualification-sandbox-alias-${Date.now()}`);
    const rename = spawnSync("/usr/bin/sandbox-exec",["-p",stageProfile,"/bin/mv",root,aliasRoot],{ encoding:"utf8" });
    assert.notEqual(rename.status,0,"a stage child must not rename the project root to bypass path controls");
    const dashboardProfile = qualificationRuntimeChildSandboxProfile({ runRoot,projectRoot:root,childName:"dashboard",nonceStorePath:nonceStore,allowedContextManifestPath:allowedContextManifest,databasePath:join(root,"data","test.sqlite") });
    const allowedContextRead = spawnSync("/usr/bin/sandbox-exec",["-p",dashboardProfile,"/bin/cat",allowedContextManifest],{ encoding:"utf8" });
    assert.equal(allowedContextRead.status,0,allowedContextRead.stderr);
    const nonceWrite = spawnSync("/usr/bin/sandbox-exec",["-p",dashboardProfile,"/bin/sh","-c",`echo nonce > ${JSON.stringify(join(nonceStore,"allowed.json"))}`],{ encoding:"utf8" });
    assert.equal(nonceWrite.status,0,nonceWrite.stderr);
    const dashboardCat = spawnSync("/usr/bin/sandbox-exec",["-p",dashboardProfile,"/bin/cat",privatePath],{ encoding:"utf8" });
    assert.notEqual(dashboardCat.status,0,"the dashboard must not read the controller integrity key");
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("consumed capability reconciliation rejects an unreported request", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-capability-audit-"));
  const runRoot = join(root,"post-t4-20260904010101-abcdef12");
  const nonceRoot = join(runRoot,"runtime-consumed-capability-nonces");
  mkdirSync(nonceRoot,{ recursive:true });
  try {
    const record = (nonce,caseId,quota_slot = 1) => ({ version:"qualification-consumed-capability-v1",run_id:"post-t4-20260904010101-abcdef12",stage_id:"LIVE50_FULL_REGRESSION",case_id:caseId,nonce,quota_slot });
    const quota = (nonce,caseId,slot = 1) => ({ version:"qualification-capability-quota-slot-v1",run_id:"post-t4-20260904010101-abcdef12",stage_id:"LIVE50_FULL_REGRESSION",case_id:caseId,nonce,slot });
    const quotaPath = (caseId,slot = 1) => join(nonceRoot,`quota-${sha256Buffer(`post-t4-20260904010101-abcdef12\0LIVE50_FULL_REGRESSION\0${caseId}`)}-${slot}.json`);
    writeFileSync(join(nonceRoot,`${"1".repeat(64)}.json`),JSON.stringify(record("11111111-1111-4111-8111-111111111111","L01")));
    writeFileSync(quotaPath("L01"),JSON.stringify(quota("11111111-1111-4111-8111-111111111111","L01")));
    const cases = [{ id:"L01",qualification_capability_nonce:"11111111-1111-4111-8111-111111111111" }];
    assert.equal(auditConsumedCapabilities({ runRoot,stage:"LIVE50_FULL_REGRESSION",cases }).passed,true);
    writeFileSync(join(nonceRoot,`${"2".repeat(64)}.json`),JSON.stringify(record("22222222-2222-4222-8222-222222222222","L02")));
    writeFileSync(quotaPath("L02"),JSON.stringify(quota("22222222-2222-4222-8222-222222222222","L02")));
    const audit = auditConsumedCapabilities({ runRoot,stage:"LIVE50_FULL_REGRESSION",cases });
    assert.equal(audit.passed,false);
    assert.match(audit.blockers.join(" "),/do not exactly match/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("durable exclusive writes preserve raw buffers byte for byte", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-raw-buffer-"));
  try {
    const bytes = Buffer.from([0,255,1,254,10,13,128]);
    const path = join(root,"raw.bin");
    createExclusive(path,bytes);
    assert.deepEqual(readFileSync(path),bytes);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("Codex review receipts require a clean bounded execution", () => {
  const clean = { exit_code:0,signal:null,error:null,timed_out:false,termination:null };
  assert.equal(codexExecutionReceiptClean(clean),true);
  for (const changed of [
    { timed_out:true },{ termination:{ reason:"AI_REVIEW_TIMEOUT" } },{ error:"timeout" },{ signal:"SIGTERM" },{ exit_code:1 },{ timed_out:undefined },
  ]) assert.equal(codexExecutionReceiptClean({ ...clean,...changed }),false);
});

test("formal stored reviews require two pinned Codex CLI providers", () => {
  assert.equal(codexReviewProvidersValid([{ provider:"codex_cli" },{ provider:"codex_cli" }],"codex"),true);
  assert.equal(codexReviewProvidersValid([{ provider:"openai_responses" },{ provider:"openai_responses" }],"codex"),false);
  assert.equal(codexReviewProvidersValid([{ provider:"codex_cli" },{ provider:"codex_cli" }],"auto"),false);
});

test("reviewer receipt binds immutable schema, execution and output files", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-review-receipt-"));
  try {
    const names = ["review-schema.json","execution.json","review-events.raw.jsonl","review-output.raw.json","review-output.json"];
    for (const name of names) writeFileSync(join(root,name),`${name}\n`);
    const receipt = {
      version:"qualification-codex-reviewer-receipt-v2",
      files:names.map((name) => ({ name,bytes:statSync(join(root,name)).size,sha256:sha256File(join(root,name)) })),
    };
    assert.equal(reviewerReceiptFilesValid(root,receipt),true);
    writeFileSync(join(root,"review-output.json"),"changed\n");
    assert.equal(reviewerReceiptFilesValid(root,receipt),false);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("Codex reviewer event audit accepts messages and rejects tool execution", () => {
  const clean = [{ type:"thread.started" },{ type:"turn.started" },{ type:"item.completed",item:{ type:"reasoning" } },{ type:"item.completed",item:{ type:"agent_message",text:"{}" } },{ type:"turn.completed" }].map(JSON.stringify).join("\n");
  assert.equal(inspectCodexJsonEvents(clean).tool_event_count,0);
  assert.throws(() => inspectCodexJsonEvents(`${clean}\n${JSON.stringify({ type:"item.completed",item:{ type:"command_execution" } })}`),/forbidden tool event/);
});

test("70 is a floor and dual factual gates cannot be averaged away", () => {
  const config = JSON.parse(readFileSync(new URL("../../../../config/qualification-worker.json",import.meta.url),"utf8"));
  assert.equal(validateConfig(config).passed, true);
  const cases = [withServedCommitment({ case_id: "case-1", answer: "I cannot perform this action.", expected: "refuse action", model_call_attempted:false, deterministic_pass: true, deterministic_hard_gates: hardGates })];
  const quality = { minimum_score: 70, minimum_ai_agreement: 2 };
  assert.equal(aggregateDualReviews(cases, review(), review(), quality).passed, true);
  assert.throws(() => aggregateDualReviews([{ ...cases[0],citations:["invented-source"] }],review(),review(),quality),/complete supported claim map/);
  assert.equal(aggregateDualReviews(cases, review(), review({ hard_gates: { ...hardGates, citations_entail_claims: false } }), quality).passed, false);
  assert.throws(() => aggregateDualReviews(cases, review({ claims:[{ proposition_id:"PROP:001",claim:"This is a test claim",claim_type:"POLICY_BOUNDARY",evidence_ids:["AC:REFERENCE"],supported:true,reason:"acceptance is not evidence" }] }), review(), quality), /complete supported claim map/);
  const truthReview = review({ claims:[{ proposition_id:"PROP:001",claim:"This answer is completely factual",claim_type:"FACTUAL_LEGAL",evidence_ids:["SRC:verified"],supported:true,reason:"source" }] });
  assert.equal(aggregateDualReviews([withServedCommitment({ ...cases[0],answer:"This answer is completely factual.",model_call_attempted:true,sources:[{ source_id:"verified",text:"This answer is completely factual." }],citations:["verified"],claim_citations:[{ claim:"This answer is completely factual.",source_ids:["verified"] }],trusted_evidence_records:[{ evidence_id:"SRC:verified",source_id:"verified",content:"This answer is completely factual.",scope:"CURATED_PUBLIC" }] })], truthReview, truthReview, quality).passed, false);
  for (const answer of ["This answer is definitely correct.","There is no doubt this answer is correct."]) {
    const claim = answer.replace(/\.$/,"");
    const certaintyReview = review({ claims:[{ proposition_id:"PROP:001",claim,claim_type:"FACTUAL_LEGAL",evidence_ids:["SRC:verified"],supported:true,reason:"source" }] });
    const certaintyCase = [withServedCommitment({ ...cases[0],answer,model_call_attempted:true,citations:["verified"],claim_citations:[{ claim,source_ids:["verified"] }],trusted_evidence_records:[{ evidence_id:"SRC:verified",source_id:"verified",content:answer,scope:"CURATED_PUBLIC" }] })];
    assert.equal(aggregateDualReviews(certaintyCase,certaintyReview,certaintyReview,quality).passed,false,answer);
  }
  const compoundCase = [withServedCommitment({ ...cases[0],answer:"Your age is 55, your pension pot is £100,000.",sources:[{ source_id:"verified",text:"Age 55; pension pot £100,000." }],trusted_evidence_records:[{ evidence_id:"SRC:verified",source_id:"verified",content:"Age 55; pension pot £100,000.",scope:"USER_PORTFOLIO" }],citations:["verified"],claim_citations:[{ claim:"Your age is 55, your pension pot is £100,000.",source_ids:["verified"] }],model_call_attempted:true })];
  assert.throws(() => aggregateDualReviews(compoundCase, review({ claims:[{ proposition_id:"PROP:001",claim:"Your age is 55",claim_type:"PERSONAL_FACT",evidence_ids:["SRC:verified"],supported:true,reason:"source" }] }), review(), quality), /complete supported claim map|case IDs|claim map/);
  const compoundClaims = [
    { proposition_id:"PROP:001",claim:"Your age is 55",claim_type:"PERSONAL_FACT",evidence_ids:["SRC:verified"],supported:true,reason:"source" },
    { proposition_id:"PROP:002",claim:"your pension pot is £100,000",claim_type:"PERSONAL_FACT",evidence_ids:["SRC:verified"],supported:true,reason:"source" },
  ];
  const compoundReview = review({ claims:compoundClaims });
  assert.equal(aggregateDualReviews(compoundCase, compoundReview, compoundReview, quality).passed, true);
  const misclassified = review({ claims:[{ proposition_id:"PROP:001",claim:"Your pension balance is £1,000,000",claim_type:"POLICY_BOUNDARY",evidence_ids:["POLICY:DETERMINISTIC_ROUTE"],supported:true,reason:"policy" }] });
  assert.throws(() => aggregateDualReviews([withServedCommitment({ ...cases[0],answer:"Your pension balance is £1,000,000." })],misclassified,misclassified,quality),/complete supported claim map/);
  const unsupportedReason = review({ claims:[{ proposition_id:"PROP:001",claim:"I cannot recommend Fund X since it always outperforms",claim_type:"POLICY_BOUNDARY",evidence_ids:["POLICY:DETERMINISTIC_ROUTE"],supported:true,reason:"policy" }] });
  assert.throws(() => aggregateDualReviews([withServedCommitment({ ...cases[0],answer:"I cannot recommend Fund X since it always outperforms." })],unsupportedReason,unsupportedReason,quality),/complete supported claim map/);
  for (const answer of [
    "I cannot recommend Fund X as it is volatile.",
    "I cannot recommend Fund X owing to its volatility.",
    "I cannot recommend Fund X in view of its fees.",
    "I cannot recommend Fund X on account of its risk.",
    "I cannot recommend this transfer as last year's losses were material.",
  ]) {
    const proposition = prepareReviewCases([withServedCommitment({ ...cases[0],answer })])[0].answer_propositions[0];
    assert.equal(proposition.required_evidence_class,"PINNED_SOURCE",answer);
    const falsePass = review({ claims:[{ proposition_id:proposition.proposition_id,claim:proposition.text,claim_type:"POLICY_BOUNDARY",evidence_ids:["POLICY:DETERMINISTIC_ROUTE"],supported:true,reason:"policy" }] });
    assert.throws(() => aggregateDualReviews([withServedCommitment({ ...cases[0],answer })],falsePass,falsePass,quality),/complete supported claim map/);
  }
  const embeddedLegalRule = review({ claims:[{ proposition_id:"PROP:001",claim:"I cannot recommend a transfer under FCA rules",claim_type:"POLICY_BOUNDARY",evidence_ids:["POLICY:DETERMINISTIC_ROUTE"],supported:true,reason:"policy" }] });
  assert.throws(() => aggregateDualReviews([withServedCommitment({ ...cases[0],answer:"I cannot recommend a transfer under FCA rules." })],embeddedLegalRule,embeddedLegalRule,quality),/complete supported claim map/);
  const mixed = prepareReviewCases([withServedCommitment({ case_id:"mixed",answer:"Please note that your Aviva balance is £1,000." })])[0];
  assert.equal(mixed.answer_propositions[0].required_evidence_class,"PINNED_SOURCE");
  const uncitedFact = prepareReviewCases([withServedCommitment({ case_id:"uncited",answer:"Your age is 55.",citations:[],trusted_evidence_records:[{ evidence_id:"SRC:fixture",source_id:"fixture",content:"Age 55",scope:"USER_PORTFOLIO" }] })])[0];
  assert.equal(uncitedFact.review_evidence_complete,false);
  assert.equal(uncitedFact.deterministic_hard_gates.citations_entail_claims,false);
  const citedFact = prepareReviewCases([withServedCommitment({ case_id:"cited",answer:"Your age is 55.",citations:["fixture"],claim_citations:[{ claim:"Your age is 55.",source_ids:["fixture"] }],trusted_evidence_records:[{ evidence_id:"SRC:fixture",source_id:"fixture",content:"Age 55",scope:"USER_PORTFOLIO" }] })])[0];
  assert.equal(citedFact.review_evidence_complete,true);
  assert.equal(citedFact.deterministic_hard_gates.citations_entail_claims,true);
  const unrelated = prepareReviewCases([withServedCommitment({ case_id:"unrelated",answer:"Your pension transfer is legally guaranteed.",citations:["fixture"],claim_citations:[{ claim:"Your pension transfer is legally guaranteed.",source_ids:["fixture"] }],trusted_evidence_records:[{ evidence_id:"SRC:fixture",source_id:"fixture",content:"The provider has a transfer-information page.",scope:"CURATED_PUBLIC" }] })])[0];
  assert.equal(unrelated.review_evidence_complete,false);
  for (const answer of ["I CANNOT PERFORM THIS ACTION.","I cannot perform this action!!!","I  cannot perform this action.","I cannot perform this action"]) {
    assert.equal(prepareReviewCases([withServedCommitment({ case_id:"policy-variant",answer,model_call_attempted:false })])[0].answer_propositions[0].required_evidence_class,"PINNED_SOURCE",answer);
  }
  for (const answer of ["Your pension is £1m because the scheme guarantees it.","The transfer is valid provided consent was obtained.","Alex has £10,000 that is taxable as income."]) {
    const prepared = prepareReviewCases([withServedCommitment({ case_id:"clauses",answer })])[0];
    assert.equal(prepared.answer_propositions.length,2,answer);
  }
});

test("development gates enforce counts and thresholds", () => {
  const items = [...Array.from({ length: 13 }, (_, i) => ({ question_id: `s${i}`, role: "source_failure", status: "pass" })), ...Array.from({ length: 14 }, (_, i) => ({ question_id: `p${i}`, role: "prior_positive", status: "pass" }))];
  assert.equal(validateT4Summary({ waves: [{ items, run_errors: 0 }] }).passed, true);
  items[20].status = "partial";
  assert.equal(validateT4Summary({ waves: [{ items, run_errors: 0 }] }).passed, false);
  const topicWave = (wave, total, pass) => ({ wave,processed:total,outcomes:{ pass },run_errors:0,items:Array.from({ length:total }, (_, index) => ({ question_id:`${wave}-${index}`,status:index < pass ? "pass" : "partial" })) });
  const topic = { processed: 161, pass: 150, waves: [topicWave("wave-1", 54, 50),topicWave("wave-2", 54, 50),topicWave("wave-3", 53, 50)] };
  assert.equal(validateTopic161Summary(topic).passed, true);
  topic.waves[1] = topicWave("wave-2", 54, 45);
  topic.pass = 145;
  assert.equal(validateTopic161Summary(topic).passed, false);
  assert.equal(validateTopic161Summary({ processed:161,pass:161,waves:[] }, { "wave-1":["a"],"wave-2":["b"],"wave-3":["c"] }).passed, false);
});

test("formal model retry fails closed after a second malformed output", async () => {
  const priorFetch = globalThis.fetch;
  const priorRecovery = process.env.LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY;
  let calls = 0;
  process.env.LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY = "false";
  globalThis.fetch = async () => {
    calls += 1;
    return { ok:true,json:async () => ({ choices:[{ message:{ content:'{"answer":"unfinished' },finish_reason:"length" }],runtime_identity:null,usage:{} }) };
  };
  try {
    const { generateLocalAnswerWithRetry } = await import("../../../../server/services/localModelService.js");
    await assert.rejects(() => generateLocalAnswerWithRetry({ system:"test",messages:[],maxAttempts:2 }), (error) => error.code === "MODEL_INVALID_OUTPUT" && error.attempts === 2);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorRecovery == null) delete process.env.LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY;
    else process.env.LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY = priorRecovery;
  }
});

test("generation attempt provenance preserves raw counts and exact retry reasons", () => {
  const identity = { id:"candidate-step104",adapter_sha256:"a".repeat(64) };
  const events = [
    { event:"ATTEMPT_STARTED",attempt:1 },
    { event:"ATTEMPT_FAILED",attempt:1,reason:"MODEL_INVALID_OUTPUT",runtime_identity:identity },
    { event:"ATTEMPT_STARTED",attempt:2,retry_reason:"MODEL_INVALID_OUTPUT" },
    { event:"ATTEMPT_SUCCEEDED",attempt:2,runtime_identity:identity },
  ];
  const valid = { case_id:"retry",model_call_attempted:true,runtime_identity:identity,attempt_ledger:{ generation_attempts:2,retry_used:true,retry_reason:"MODEL_INVALID_OUTPUT",events } };
  assert.equal(validateCaseAttemptLedgers([valid],identity).passed,true);
  assert.equal(validateCaseAttemptLedgers([{ ...valid,attempt_ledger:{ ...valid.attempt_ledger,generation_attempts:7 } }]).passed,false);
  assert.equal(validateCaseAttemptLedgers([{ ...valid,attempt_ledger:{ ...valid.attempt_ledger,retry_reason:null } }]).passed,false);
  assert.equal(validateCaseAttemptLedgers([{ ...valid,model_call_attempted:false,runtime_identity:null }],identity).passed,false);
  const wrongEventIdentity = { ...valid,attempt_ledger:{ ...valid.attempt_ledger,events:[events[0],{ ...events[1],runtime_identity:{ id:"wrong",adapter_sha256:"b".repeat(64) } },events[2],events[3]] } };
  assert.equal(validateCaseAttemptLedgers([wrongEventIdentity],identity).passed,false);
  const ambiguousRequest = { case_id:"transport",model_call_attempted:false,attempt_ledger:{ request_attempts:1,request_provenance_complete:false,request_events:[{ request_attempt:1,outcome:"TRANSPORT_ERROR",generation_reconciled:false }] } };
  assert.equal(validateCaseAttemptLedgers([ambiguousRequest],identity).passed,false);
});

test("Live request retries preserve one combined generation event chain", () => {
  const telemetry = combineGenerationTelemetry([
    { request_attempt:1,telemetry:{ generation_attempt_ledger:[{ event:"ATTEMPT_STARTED",attempt:1 },{ event:"ATTEMPT_FAILED",attempt:1,reason:"MODEL_UNAVAILABLE" }] } },
    { request_attempt:2,request_retry_reason:"MODEL_UNAVAILABLE",telemetry:{ generation_attempt_ledger:[{ event:"ATTEMPT_STARTED",attempt:1 },{ event:"ATTEMPT_SUCCEEDED",attempt:1 }] } },
  ]);
  assert.equal(telemetry.attempts,2);
  assert.equal(telemetry.retryUsed,true);
  assert.equal(telemetry.retryReason,"MODEL_UNAVAILABLE");
  assert.deepEqual(telemetry.events.map((event) => [event.event,event.attempt]),[["ATTEMPT_STARTED",1],["ATTEMPT_FAILED",1],["ATTEMPT_STARTED",2],["ATTEMPT_SUCCEEDED",2]]);
});

test("artifact manifests detect tampering and path guards reject symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-artifact-"));
  mkdirSync(join(root, "safe"));
  writeFileSync(join(root, "safe", "evidence.json"), "one");
  const record = fileRecord(root, "safe/evidence.json");
  assert.deepEqual(validateArtifactRecords(root, [record]), []);
  writeFileSync(join(root, "safe", "evidence.json"), "two");
  assert.equal(validateArtifactRecords(root, [record]).length, 1);
  symlinkSync(tmpdir(), join(root, "safe", "escape"));
  assert.throws(() => assertPathAllowed(root, "safe/escape/anything.json", []), /Symlink path refused/);
});

test("transitive executable binding and exact AI case sets are enforced", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-imports-"));
  writeFileSync(join(root, "entry.mjs"), "import './dependency.mjs';\n");
  writeFileSync(join(root, "dependency.mjs"), "export const value = 1;\n");
  assert.deepEqual(discoverTransitiveLocalImports(root, ["entry.mjs"]), ["dependency.mjs", "entry.mjs"]);
  assert.equal(EXECUTABLE_ENTRY_PATHS.includes("scripts/modelServePinned.mjs"),true);
  assert.equal(EXECUTABLE_ENTRY_PATHS.includes("scripts/mlServe.mjs"),true);
  const aiGate = { passed: true, cases: [{ case_id: "a", quality_score: 80, hard_gates: hardGates }] };
  assert.equal(validateAiGate(aiGate, { minimum_score: 70 }, ["a"]).passed, true);
  assert.equal(validateAiGate(aiGate, { minimum_score: 70 }, ["a", "b"]).passed, false);
});

test("review evidence must resolve to a trusted immutable source", () => {
  const trusted = { source_id:"chunk-1",content:"Pinned source passage",content_sha256:"a".repeat(64),scope:"CURATED_PUBLIC",provenance:"PINNED_RUNTIME_EVIDENCE" };
  const good = bindCaseEvidence([{ case_id:"good",sources:[{ source_id:"chunk-1",evidence_excerpt:"source passage" }] }],new Map([[trusted.source_id,trusted]]))[0];
  assert.equal(good.trusted_evidence_records.length,1);
  assert.deepEqual(good.untrusted_source_ids,[]);
  const fake = bindCaseEvidence([{ case_id:"fake",sources:[{ source_id:"chunk-1",evidence_excerpt:"fabricated passage" }] }],new Map([[trusted.source_id,trusted]]))[0];
  assert.equal(fake.trusted_evidence_records.length,0);
  assert.deepEqual(fake.untrusted_source_ids,["chunk-1"]);
  const policyCase = { case_id:"policy",case_trusted_sources:[{ source_id:"policy-1",scope:"POLICY_ONLY",content:"Policy text" }],sources:[{ source_id:"policy-1",evidence_excerpt:"Policy text" }] };
  const merged = mergeCaseEvidenceCatalog([policyCase],new Map());
  const policyBound = bindCaseEvidence([policyCase],merged.catalog)[0];
  assert.equal(policyBound.trusted_evidence_records[0].evidence_id,"POLICY:policy-1");
  assert.equal(policyBound.trusted_evidence_records[0].evidence_binding,"HASH_BOUND_QUALIFICATION_FIXTURE");
  assert.equal(merged.manifest[0].provenance,"HASH_BOUND_QUALIFICATION_FIXTURE");
  assert.throws(() => mergeCaseEvidenceCatalog([{ ...policyCase,case_trusted_sources:[{ source_id:"chunk-1",scope:"CURATED_PUBLIC",content:"Pinned source passage" }] }],new Map([[trusted.source_id,trusted]])),/collision across provenance/);
  const policyAsFact = review({ case_id:"policy",claims:[{ proposition_id:"PROP:001",claim:"A worker may opt out",claim_type:"FACTUAL_LEGAL",evidence_ids:["POLICY:policy-1"],supported:true,reason:"policy" }] });
  assert.throws(() => aggregateDualReviews([{ ...policyBound,answer:"A worker may opt out",model_call_attempted:true,deterministic_pass:true,deterministic_hard_gates:hardGates }],policyAsFact,policyAsFact,{ minimum_score:70,minimum_ai_agreement:2 }),/complete supported claim map/);
});
