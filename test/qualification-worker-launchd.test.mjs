import assert from "node:assert/strict";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STAGES } from "../scripts/lib/qualification-worker/constants.mjs";
import { chooseLaunchAction,validateLaunchRequest,verifyTerminalWorkerState } from "../scripts/lib/qualification-worker/launchdLifecycle.mjs";
import { StateStore } from "../scripts/lib/qualification-worker/stateStore.mjs";
import { ensureQualificationTerminalSeal } from "../scripts/lib/qualification-worker/terminalSeal.mjs";

const runId="post-t4-20260905010101-abcdef12";
const request=(overrides={}) => ({
  version:"qualification-launchd-run-request-v2",request_id:"11111111-1111-4111-8111-111111111111",
  mode:"ONE_FRESH_RUN_THEN_RESUME",prior_run_id:runId,fresh_start_consumed:false,
  config_sha256:"a".repeat(64),worker_sha256:"b".repeat(64),sealed_unseen_authorised:false,...overrides,
});

test("launch request is identity-bound and never authorises sealed unseen",() => {
  const expected={ configSha256:"a".repeat(64),workerSha256:"b".repeat(64) };
  assert.equal(validateLaunchRequest(request(),expected).passed,true);
  for (const changed of [request({ config_sha256:"c".repeat(64) }),request({ sealed_unseen_authorised:true }),request({ mode:"FOREVER" })]) {
    assert.equal(validateLaunchRequest(changed,expected).passed,false);
  }
});

test("fresh launch is consumed only by a changed run and terminal states require verification",() => {
  const terminal={ run_id:runId,state:"BLOCKED_NOT_QUALIFIED" };
  assert.equal(chooseLaunchAction({ request:request(),state:terminal,stateSha256:"x" }),"START_NEW_RUN");
  assert.equal(chooseLaunchAction({ request:request({ fresh_start_consumed:true }),state:terminal,stateSha256:"x" }),"VERIFY_TERMINAL");
  assert.equal(chooseLaunchAction({ request:request(),state:{ run_id:"post-t4-20260905020202-fedcba98",state:"BLOCKED_NOT_QUALIFIED" },stateSha256:"x" }),"VERIFY_TERMINAL");
  assert.equal(chooseLaunchAction({ request:request({ blocked_same_state_sha256:"x" }),state:null,stateSha256:"x" }),"STOP_BLOCKED_SAME_STATE");
});

test("launchd accepts READY only with a signed terminal seal and event chain",() => {
  const root=mkdtempSync(join(tmpdir(),"qualification-launchd-ready-"));
  const runRoot=join(root,"runs",runId);
  const gates=join(runRoot,"stage-manifests");
  const freeze=join(runRoot,"candidate-freeze");
  mkdirSync(gates,{ recursive:true });
  mkdirSync(freeze,{ recursive:true });
  try {
    for (const stage of STAGES) writeFileSync(join(gates,`${stage}.json`),JSON.stringify({ stage,passed:true }));
    writeFileSync(join(freeze,"SHA256-MANIFEST.json"),"{}\n");
    writeFileSync(join(freeze,"candidate-manifest.json"),"{}\n");
    const store=new StateStore(root);
    store.event("new_run_created",{ run_id:runId,prior_run_id:null });
    const audit=store.auditEventChain({ allowAnchorBootstrap:false });
    ensureQualificationTerminalSeal({ runRoot,runId,stages:STAGES,stagePath:(stage) => join(gates,`${stage}.json`),eventAudit:audit,
      integritySigner:(payload) => store.signIntegrity(payload),integrityVerifier:(payload,signature) => store.verifyIntegrity(payload,signature) });
    store.event("terminal_ready",{ run_id:runId,state:"READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION" });
    const state={ run_id:runId,state:"READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION",status:"COMPLETE",completed_stages:[...STAGES] };
    writeFileSync(join(root,"worker-state.json"),JSON.stringify(state));
    assert.equal(verifyTerminalWorkerState({ projectRoot:root,logRoot:root,state }).state,state.state);
    writeFileSync(join(gates,"CANDIDATE_FREEZE.json"),JSON.stringify({ stage:"CANDIDATE_FREEZE",passed:false }));
    assert.throws(() => verifyTerminalWorkerState({ projectRoot:root,logRoot:root,state }),/binding mismatch/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("launchd accepts BLOCKED only with a signed terminal failure and failed gate",() => {
  const root=mkdtempSync(join(tmpdir(),"qualification-launchd-blocked-"));
  const runRoot=join(root,"runs",runId);
  const gates=join(runRoot,"stage-manifests");
  mkdirSync(gates,{ recursive:true });
  try {
    writeFileSync(join(gates,"VERIFY_RUNTIME.json"),JSON.stringify({ stage:"VERIFY_RUNTIME",passed:false }));
    const store=new StateStore(root);
    store.event("new_run_created",{ run_id:runId,prior_run_id:null });
    store.event("terminal_blocked",{ run_id:runId,stage:"VERIFY_RUNTIME",blocker:"startup" });
    const state={ run_id:runId,state:"BLOCKED_NOT_QUALIFIED",status:"BLOCKED",blocker:"startup",completed_stages:[] };
    writeFileSync(join(root,"worker-state.json"),JSON.stringify(state));
    assert.equal(verifyTerminalWorkerState({ projectRoot:root,logRoot:root,state }).state,"BLOCKED_NOT_QUALIFIED");
    writeFileSync(join(gates,"VERIFY_RUNTIME.json"),JSON.stringify({ stage:"VERIFY_RUNTIME",passed:true }));
    assert.throws(() => verifyTerminalWorkerState({ projectRoot:root,logRoot:root,state }),/failed stage gate/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});
