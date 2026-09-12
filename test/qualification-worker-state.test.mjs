import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join, resolve } from "node:path";
import test from "node:test";
import { stopOwnedRuntime } from "../scripts/lib/qualification-worker/runtimeSupervisor.mjs";
import { StateStore } from "../scripts/lib/qualification-worker/stateStore.mjs";
import { canonicalHash, sha256File } from "../scripts/lib/qualification-worker/utils.mjs";
import { runChild } from "../scripts/lib/qualification-worker/stageRegistry.mjs";
import { processGroupAlive, terminateProcessGroup } from "../scripts/lib/qualification-worker/childProcessGroup.mjs";
import { hasStickyWorkerInterruption } from "../scripts/lib/qualification-worker/resumeIntegrity.mjs";
import { ensureQualificationTerminalSeal } from "../scripts/lib/qualification-worker/terminalSeal.mjs";
import { stageGateCommitment,verifyCommittedStageTransitions } from "../scripts/lib/qualification-worker/transitionIntegrity.mjs";
import { fileRecord } from "../scripts/lib/qualification-worker/utils.mjs";

test("a recorded worker interruption stays terminal across reconstruction", () => {
  assert.equal(hasStickyWorkerInterruption({ state:"BLOCKED_NOT_QUALIFIED",blocker:"received SIGTERM; cleanup completed" },[]),true);
  assert.equal(hasStickyWorkerInterruption({ state:"READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION" },["WORKER_INTERRUPTION-1788520000000.json"]),true);
  assert.equal(hasStickyWorkerInterruption({ state:"BLOCKED_NOT_QUALIFIED",blocker:"visible gate failed" },[]),false);
  assert.equal(hasStickyWorkerInterruption({ status:"INTERRUPTING",interruption:{ status:"REQUESTED",signal_count:2 } },[]),true);
  assert.equal(hasStickyWorkerInterruption({ state:"VERIFY_RUNTIME" },["WORKER_INTERRUPTION-INTENT-1788520000000.json"]),true);
});

test("preflight is read-only and freeze markers follow runtime cleanup", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"),"utf8"));
  assert.equal(packageJson.scripts["qualification:preflight"],"node scripts/qualificationWorker.mjs --preflight");
  const controller = readFileSync(resolve("scripts/qualificationWorker.mjs"),"utf8");
  assert.doesNotMatch(controller,/\bconst once\b|argv\.includes\("--once"\)/);
  const registry = readFileSync(resolve("scripts/lib/qualification-worker/stageRegistry.mjs"),"utf8");
  const freezeStart = registry.indexOf("async function freeze(context)");
  const cleanup = registry.indexOf("await stopRuntimeForGate(context)",freezeStart);
  const readyWrite = registry.indexOf("createExclusive(readyPath,readyText)",freezeStart);
  assert.ok(cleanup > freezeStart && readyWrite > cleanup,"READY must be written only after final runtime cleanup");
});


test("isolated Python launcher keeps project files behind verified dependencies", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-python-path-"));
  try {
    writeFileSync(join(root,"json.py"),"raise RuntimeError('project shadow loaded')\n");
    writeFileSync(join(root,"probe.py"),"import json\nprint(json.__file__)\n");
    const result = spawnSync("python3",[
      "-I","-B",resolve("scripts/isolatedPythonLauncher.py"),"--root",root,"--script",join(root,"probe.py"),
    ],{ encoding:"utf8" });
    assert.equal(result.status,0,result.stderr);
    assert.notEqual(resolve(String(result.stdout).trim()),resolve(root,"json.py"));
    writeFileSync(join(root,"bound_module.py"),"VALUE = 1\n");
    const wrongBinding = spawnSync("python3",[
      "-I","-B",resolve("scripts/isolatedPythonLauncher.py"),"--root",root,
      "--verify-module",`bound_module=${join(root,"probe.py")}`,"--script",join(root,"probe.py"),
    ],{ encoding:"utf8" });
    assert.notEqual(wrongBinding.status,0);
    assert.match(wrongBinding.stderr,/resolved outside its bound path/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("qualification state writes atomically and events form a hash chain", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-state-"));
  try {
    const store = new StateStore(root);
    store.acquireLock();
    store.save({ state: "VERIFY_RUNTIME" });
    const first = store.event("one", { value: 1 });
    const second = store.event("two", { value: 2 });
    assert.equal(second.previous_event_hash, first.event_hash);
    assert.equal(store.load({}).state, "VERIFY_RUNTIME");
    store.releaseLock();
    assert.equal(readFileSync(join(root, "worker-events.jsonl"), "utf8").trim().split("\n").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("signed stage transitions reject a coherently rewritten gate and evidence", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-transition-integrity-"));
  const runId = "post-t4-20260904010101-abcdef12";
  const runRoot = join(root,"runs",runId);
  const gatePath = join(runRoot,"stage-manifests","VERIFY_RUNTIME.json");
  const evidencePath = join(runRoot,"evidence.json");
  mkdirSync(join(runRoot,"stage-manifests"),{ recursive:true });
  try {
    writeFileSync(evidencePath,"original\n");
    const artifacts = [fileRecord(root,"runs/post-t4-20260904010101-abcdef12/evidence.json")];
    writeFileSync(gatePath,`${JSON.stringify({ version:"qualification-stage-gate-v1",stage:"VERIFY_RUNTIME",passed:true,artifacts,artifacts_sha256:canonicalHash(artifacts),inputs:{ predecessor:null },sealed_unseen_accessed:false })}\n`);
    const store = new StateStore(root);
    store.event("stage_passed",stageGateCommitment({ projectRoot:root,runId,stage:"VERIFY_RUNTIME",gatePath }));
    const eventAudit = store.auditEventChain();
    assert.equal(verifyCommittedStageTransitions({ projectRoot:root,runId,completedStages:["VERIFY_RUNTIME"],stagePath:() => gatePath,eventAudit }).passed,true);
    writeFileSync(evidencePath,"rewritten\n");
    const changedArtifacts = [fileRecord(root,"runs/post-t4-20260904010101-abcdef12/evidence.json")];
    writeFileSync(gatePath,`${JSON.stringify({ version:"qualification-stage-gate-v1",stage:"VERIFY_RUNTIME",passed:true,artifacts:changedArtifacts,artifacts_sha256:canonicalHash(changedArtifacts),inputs:{ predecessor:null },sealed_unseen_accessed:false })}\n`);
    assert.throws(() => verifyCommittedStageTransitions({ projectRoot:root,runId,completedStages:["VERIFY_RUNTIME"],stagePath:() => gatePath,eventAudit }),/commitment mismatch/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("event-chain audit rejects modification, deletion, malformed tails and cross-run events", () => {
  const make = () => {
    const root = mkdtempSync(join(tmpdir(),"qualification-event-audit-"));
    const store = new StateStore(root);
    store.event("one",{ run_id:"post-t4-20260904010101-abcdef12",value:1 });
    store.event("two",{ run_id:"post-t4-20260904010101-abcdef12",value:2 });
    store.event("three",{ run_id:"post-t4-20260904010101-abcdef12",value:3 });
    return { root,store };
  };
  let fixture = make();
  try {
    const rows = readFileSync(join(fixture.root,"worker-events.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    rows[1].data.value = 99;
    writeFileSync(join(fixture.root,"worker-events.jsonl"),`${rows.map(JSON.stringify).join("\n")}\n`);
    assert.throws(() => fixture.store.auditEventChain(),/invalid at sequence/);
  } finally { rmSync(fixture.root,{ recursive:true,force:true }); }
  fixture = make();
  try {
    const rows = readFileSync(join(fixture.root,"worker-events.jsonl"),"utf8").trim().split("\n");
    writeFileSync(join(fixture.root,"worker-events.jsonl"),`${[rows[0],rows[2]].join("\n")}\n`);
    assert.throws(() => fixture.store.auditEventChain(),/invalid at sequence|anchor/);
  } finally { rmSync(fixture.root,{ recursive:true,force:true }); }
  fixture = make();
  try {
    writeFileSync(join(fixture.root,"worker-events.jsonl"),`${readFileSync(join(fixture.root,"worker-events.jsonl"),"utf8")}truncated`);
    assert.throws(() => fixture.store.auditEventChain(),/malformed or truncated tail/);
  } finally { rmSync(fixture.root,{ recursive:true,force:true }); }
  fixture = make();
  try {
    assert.throws(() => fixture.store.event("wrong-run",{ run_id:"post-t4-20260904010101-deadbeef" }),/crosses/);
  } finally { rmSync(fixture.root,{ recursive:true,force:true }); }
  fixture = make();
  try {
    rmSync(join(fixture.root,"worker-events.anchor.json"));
    assert.throws(() => fixture.store.auditEventChain({ allowAnchorBootstrap:false }),/anchor is missing/);
    assert.equal(existsSync(join(fixture.root,"worker-events.anchor.json")),false);
  } finally { rmSync(fixture.root,{ recursive:true,force:true }); }
});

test("event-chain audit rejects missing, unknown, non-integer, duplicate and out-of-order version or sequence fields", () => {
  const variants = [
    (rows) => { delete rows[0].chain_version; },
    (rows) => { rows[0].chain_version = 999; },
    (rows) => { rows[0].sequence = 1.5; },
    (rows) => { rows[1].sequence = 1; },
    (rows) => { rows[1].sequence = 400; },
  ];
  for (const mutate of variants) {
    const root = mkdtempSync(join(tmpdir(),"qualification-event-version-"));
    try {
      const store = new StateStore(root);
      store.event("one",{ run_id:"post-t4-20260904010101-abcdef12" });
      store.event("two",{ run_id:"post-t4-20260904010101-abcdef12" });
      const rows = readFileSync(join(root,"worker-events.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
      mutate(rows);
      let previous = null;
      for (const row of rows) {
        delete row.event_hash;
        row.previous_event_hash = previous;
        row.event_hash = canonicalHash(row);
        previous = row.event_hash;
      }
      writeFileSync(join(root,"worker-events.jsonl"),`${rows.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root,"worker-events.anchor.json"),JSON.stringify({ version:"qualification-worker-event-chain-anchor-v2",event_count:rows.length,head_hash:previous }));
      assert.throws(() => store.auditEventChain({ allowAnchorBootstrap:false }),/version is unsupported|sequence is discontinuous/);
    } finally { rmSync(root,{ recursive:true,force:true }); }
  }
});

test("a consistently rehashed event log cannot replace its controller-signed anchor", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-event-anchor-signature-"));
  try {
    const store = new StateStore(root);
    store.event("one",{ run_id:"post-t4-20260904010101-abcdef12",value:1 });
    store.event("two",{ run_id:"post-t4-20260904010101-abcdef12",value:2 });
    const originalAnchor = JSON.parse(readFileSync(join(root,"worker-events.anchor.json"),"utf8"));
    const rows = readFileSync(join(root,"worker-events.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    rows[0].data.value = 999;
    let previous = null;
    for (const row of rows) {
      delete row.event_hash;
      row.previous_event_hash = previous;
      row.event_hash = canonicalHash(row);
      previous = row.event_hash;
    }
    writeFileSync(join(root,"worker-events.jsonl"),`${rows.map(JSON.stringify).join("\n")}\n`);
    writeFileSync(join(root,"worker-events.anchor.json"),JSON.stringify({
      version:"qualification-worker-event-chain-anchor-v2",event_count:rows.length,head_hash:previous,anchored_at:new Date().toISOString(),
      integrity_public_key_sha256:originalAnchor.integrity_public_key_sha256,integrity_signature:originalAnchor.integrity_signature,
    }));
    assert.throws(() => store.auditEventChain({ allowAnchorBootstrap:false }),/persisted chain anchor/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("terminal seal fails closed when the final gate changes", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-terminal-seal-"));
  const freezeRoot = join(root,"candidate-freeze");
  const gatesRoot = join(root,"gates");
  mkdirSync(freezeRoot,{ recursive:true });
  mkdirSync(gatesRoot,{ recursive:true });
  const stages = ["VERIFY_RUNTIME","CANDIDATE_FREEZE"];
  const stagePath = (stage) => join(gatesRoot,`${stage}.json`);
  try {
    writeFileSync(stagePath("VERIFY_RUNTIME"),JSON.stringify({ stage:"VERIFY_RUNTIME",passed:true }));
    writeFileSync(stagePath("CANDIDATE_FREEZE"),JSON.stringify({ stage:"CANDIDATE_FREEZE",passed:true }));
    writeFileSync(join(freezeRoot,"SHA256-MANIFEST.json"),JSON.stringify({ files:[] }));
    writeFileSync(join(freezeRoot,"candidate-manifest.json"),JSON.stringify({ candidate:"step104" }));
    const eventHash = "a".repeat(64);
    const store = new StateStore(root);
    store.ensureIntegrityIdentity({ allowCreate:true });
    const args = { runRoot:root,runId:"post-t4-20260904010101-abcdef12",stages,stagePath,eventAudit:{ event_count:1,head_hash:eventHash,hashes:[eventHash],anchor_sha256:"b".repeat(64) },integritySigner:(payload) => store.signIntegrity(payload),integrityVerifier:(payload,signature) => store.verifyIntegrity(payload,signature) };
    assert.equal(ensureQualificationTerminalSeal(args).seal.final_gate_sha256,sha256File(stagePath("CANDIDATE_FREEZE")));
    writeFileSync(stagePath("CANDIDATE_FREEZE"),JSON.stringify({ stage:"CANDIDATE_FREEZE",passed:false }));
    assert.throws(() => ensureQualificationTerminalSeal(args),/Terminal seal binding mismatch/);
    const sealPath = join(freezeRoot,"TERMINAL-SEAL.json");
    const forged = JSON.parse(readFileSync(sealPath,"utf8"));
    forged.final_gate_sha256 = sha256File(stagePath("CANDIDATE_FREEZE"));
    writeFileSync(sealPath,JSON.stringify(forged));
    assert.throws(() => ensureQualificationTerminalSeal(args),/signature is invalid/);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("resume verification never recreates a missing terminal seal", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-missing-terminal-seal-"));
  const freezeRoot = join(root,"candidate-freeze");
  const gatesRoot = join(root,"gates");
  mkdirSync(freezeRoot,{ recursive:true });
  mkdirSync(gatesRoot,{ recursive:true });
  const stages = ["VERIFY_RUNTIME","CANDIDATE_FREEZE"];
  const stagePath = (stage) => join(gatesRoot,`${stage}.json`);
  try {
    for (const stage of stages) writeFileSync(stagePath(stage),JSON.stringify({ stage,passed:true }));
    writeFileSync(join(freezeRoot,"SHA256-MANIFEST.json"),"{}\n");
    writeFileSync(join(freezeRoot,"candidate-manifest.json"),"{}\n");
    const eventHash = "a".repeat(64);
    assert.throws(() => ensureQualificationTerminalSeal({ runRoot:root,runId:"post-t4-20260904010101-abcdef12",stages,stagePath,eventAudit:{ event_count:1,head_hash:eventHash,hashes:[eventHash] },allowCreate:false }),/terminal seal is missing/i);
    assert.equal(existsSync(join(freezeRoot,"TERMINAL-SEAL.json")),false);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("qualification worker refuses a live second instance and recovers a stale lock", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-lock-"));
  try {
    const one = new StateStore(root);
    one.acquireLock();
    const completeIdentity = JSON.parse(readFileSync(join(root,"worker.lock"),"utf8"));
    const two = new StateStore(root);
    assert.throws(() => two.acquireLock(), /already runs/);
    one.releaseLock();
    writeFileSync(join(root, "worker.lock"), JSON.stringify({ pid: 99999999 }));
    assert.throws(() => two.acquireLock(), /complete token\/PID\/executable\/argv identity/);
    const stale = { ...completeIdentity,pid:99999999,token:randomUUID() };
    stale.identity_sha256 = canonicalHash({ pid:stale.pid,executable:stale.executable,argv:stale.argv });
    writeFileSync(join(root, "worker.lock"), JSON.stringify(stale));
    two.acquireLock();
    two.releaseLock();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a worker releases only the lock token it owns", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-lock-owner-"));
  try {
    const store = new StateStore(root);
    store.acquireLock();
    writeFileSync(join(root, "worker.lock"),JSON.stringify({ pid:process.pid,token:"replacement-owner" }));
    store.releaseLock();
    assert.equal(JSON.parse(readFileSync(join(root, "worker.lock"),"utf8")).token,"replacement-owner");
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("a worker does not release a lock with a tampered identity digest", () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-lock-digest-"));
  try {
    const store = new StateStore(root);
    store.acquireLock();
    const record = JSON.parse(readFileSync(join(root,"worker.lock"),"utf8"));
    writeFileSync(join(root,"worker.lock"),JSON.stringify({ ...record,identity_sha256:"0".repeat(64) }));
    store.releaseLock();
    assert.equal(JSON.parse(readFileSync(join(root,"worker.lock"),"utf8")).identity_sha256,"0".repeat(64));
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("fresh-run cleanup stops only an exactly token-owned runtime", async () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-runtime-owner-"));
  const runRoot = join(root,"run");
  const launcher = join(root,"scripts","liveLocal.mjs");
  const runId = "post-t4-20260904010101-abcdef12";
  const ownerToken = randomUUID();
  mkdirSync(join(root,"scripts"),{ recursive:true });
  mkdirSync(runRoot,{ recursive:true });
  writeFileSync(launcher,"process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);\n");
  const child = spawn(process.execPath,[launcher,"--qualification-run-id",runId,"--qualification-owner-token",ownerToken],{ stdio:"ignore",detached:true });
  try {
    await new Promise((accept) => setTimeout(accept,100));
    const argv = [process.execPath,launcher,"--qualification-run-id",runId,"--qualification-owner-token",ownerToken];
    const contextKeyPath = join(runRoot,"runtime-qualification-context.key");
    const responsePublicKeyPath = join(runRoot,"runtime-response-signing-public.pem");
    const allowedContextManifestPath = join(root,"runtime","qualification-allowed-contexts",`${runId}.json`);
    mkdirSync(dirname(allowedContextManifestPath),{ recursive:true });
    writeFileSync(contextKeyPath,"d".repeat(64),{ mode:0o600 });
    writeFileSync(responsePublicKeyPath,"-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n");
    writeFileSync(allowedContextManifestPath,JSON.stringify({ version:"qualification-allowed-context-manifest-v1",run_id:runId,entries:[] }));
    writeFileSync(join(runRoot,"runtime-process.json"),JSON.stringify({ pid:child.pid,run_id:runId,owner_token:ownerToken,executable:process.execPath,argv,command:argv.join(" "),qualification_context_key_sha256:sha256File(contextKeyPath),qualification_response_public_key_sha256:sha256File(responsePublicKeyPath),qualification_allowed_context_manifest_sha256:sha256File(allowedContextManifestPath) }));
    const result = await stopOwnedRuntime({
      projectRoot:root,runRoot,expectedPid:child.pid,expectedRunId:runId,
      argvProbeExecutable:resolve(".retrieval-venv/bin/python"),
      argvProbeScript:resolve("scripts/processArgvDarwin.py"),
    });
    assert.equal(result.stopped,true);
    assert.equal(result.pid,child.pid);
    assert.equal(JSON.parse(readFileSync(join(runRoot,"runtime-stop.json"),"utf8")).owner_token,ownerToken);
    assert.equal(JSON.parse(readFileSync(join(runRoot,"runtime-process.json"),"utf8")).stop,undefined);
  } finally {
    try { process.kill(-child.pid,"SIGKILL"); } catch {}
    rmSync(root,{ recursive:true,force:true });
  }
  assert.equal(resolve(root,"scripts/liveLocal.mjs"),resolve(launcher));
});

test("cleanup never signals an orphaned process group after its recorded leader exits", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(),"qualification-orphan-group-"));
  const childPidPath = join(root,"child.pid");
  const leader = spawn("/bin/sh",["-c",`nohup /bin/sleep 30 >/dev/null 2>&1 & echo $! > '${childPidPath}'`],{ stdio:"ignore",detached:true });
  let childPid = null;
  try {
    await new Promise((accept,reject) => {
      leader.once("error",reject);
      leader.once("close",accept);
    });
    for (let attempt = 0; attempt < 20 && childPid == null; attempt += 1) {
      try { childPid = Number(readFileSync(childPidPath,"utf8").trim()); } catch { await new Promise((accept) => setTimeout(accept,10)); }
    }
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    const result = await stopOwnedRuntime({ projectRoot:root,runRoot:root,expectedPid:leader.pid,expectedRunId:"post-t4-20260904010101-abcdef12" });
    assert.deepEqual(result,{ stopped:false,reason:"runtime_leader_stopped_but_group_remains",pid:leader.pid });
    assert.doesNotThrow(() => process.kill(childPid,0));
  } finally {
    try { process.kill(-leader.pid,"SIGKILL"); } catch {}
    if (childPid) try { process.kill(childPid,"SIGKILL"); } catch {}
    rmSync(root,{ recursive:true,force:true });
  }
});


test("stage child launch is rejected when interruption is already pending", async () => {
  const root = mkdtempSync(join(tmpdir(),"qualification-stage-stop-before-spawn-"));
  const marker = join(root,"should-not-exist");
  try {
    assert.throws(() => runChild({
      projectRoot:root,
      config:{ permissions:{ allow_training:false,allow_sealed_unseen:false,allow_release:false,allow_git_push:false,allow_origin_change:false },protected_path_patterns:[],runtime:{ stage_child_timeout_ms:100,stage_child_termination_grace_ms:25,stage_child_kill_settle_ms:100 } },
      command:process.execPath,args:["-e",`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`],env:{},
      logPath:join(root,"stage.log"),shouldStop:() => true,
    }),/prevented a child-process launch/);
    assert.equal(existsSync(marker),false);
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test("bounded group cleanup kills a descendant after the stage leader exits on SIGTERM", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(),"qualification-group-cleanup-"));
  const readyPath = join(root,"descendant-ready");
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(readyPath)},'ready');setInterval(()=>{},1000)`;
  const leader = spawn(process.execPath,["-e",`
    const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{},1000);
  `],{ stdio:"ignore",detached:true });
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) await new Promise((accept) => setTimeout(accept,10));
    assert.equal(existsSync(readyPath),true);
    assert.equal(processGroupAlive(leader.pid),true);
    const cleanup = await terminateProcessGroup(leader.pid,{ reason:"TEST",terminationGraceMs:25,killSettleMs:250,pollMs:10 });
    assert.equal(cleanup.term_sent,true);
    assert.equal(cleanup.kill_sent,true);
    assert.equal(cleanup.stopped,true);
    assert.equal(processGroupAlive(leader.pid),false);
  } finally {
    try { process.kill(-leader.pid,"SIGKILL"); } catch {}
    rmSync(root,{ recursive:true,force:true });
  }
});
