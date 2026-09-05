import { createHash } from "node:crypto";
import { existsSync,readFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { STAGES,TERMINAL_STATES } from "./constants.mjs";
import { StateStore } from "./stateStore.mjs";
import { ensureQualificationTerminalSeal } from "./terminalSeal.mjs";
import { canonicalHash,readJson,sha256File } from "./utils.mjs";

const REQUEST_MODES=new Set(["RESUME_ONLY","ONE_FRESH_RUN_THEN_RESUME"]);

export function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateLaunchRequest(request,{ configSha256,workerSha256 }) {
  const blockers=[];
  if (request?.version!=="qualification-launchd-run-request-v2") blockers.push("launch request version is invalid");
  if (!REQUEST_MODES.has(request?.mode)) blockers.push("launch request mode is invalid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(request?.request_id || ""))) blockers.push("launch request ID is invalid");
  if (request?.config_sha256!==configSha256 || request?.worker_sha256!==workerSha256) blockers.push("launch request source identity changed");
  if (request?.sealed_unseen_authorised!==false) blockers.push("launch request must keep sealed unseen closed");
  if (request?.mode==="ONE_FRESH_RUN_THEN_RESUME" && !/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(request?.prior_run_id || ""))) blockers.push("fresh-run request has no exact prior run identity");
  return { passed:blockers.length===0,blockers };
}

export function chooseLaunchAction({ request,state,stateSha256 }) {
  if (request.blocked_same_state_sha256 && request.blocked_same_state_sha256===stateSha256) return "STOP_BLOCKED_SAME_STATE";
  if (state && TERMINAL_STATES.includes(state.state)) {
    if (state.run_id!==request.prior_run_id) return "VERIFY_TERMINAL";
    if (request.mode==="ONE_FRESH_RUN_THEN_RESUME" && request.fresh_start_consumed!==true) return "START_NEW_RUN";
    return "VERIFY_TERMINAL";
  }
  return "RESUME";
}

export function verifyTerminalWorkerState({ projectRoot,logRoot,state }) {
  if (!state || !TERMINAL_STATES.includes(state.state) || !/^post-t4-\d{14}-[0-9a-f]{8}$/.test(String(state.run_id || ""))) {
    throw new Error("Worker state is not a valid terminal run.");
  }
  const store=new StateStore(logRoot);
  const audit=store.auditEventChain({ allowAnchorBootstrap:false });
  if (audit.active_run_id!==state.run_id) throw new Error("Terminal state does not match the signed active event-chain run.");
  const runRoot=resolve(logRoot,"runs",state.run_id);
  if (state.state==="READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION") {
    if (state.status!=="COMPLETE" || canonicalHash(state.completed_stages || [])!==canonicalHash(STAGES)) throw new Error("Ready state does not contain the complete ordered gate chain.");
    const terminalReady=audit.events.filter((event) => event.type==="terminal_ready" && event.data?.run_id===state.run_id && event.data?.state===state.state);
    if (terminalReady.length!==1) throw new Error("Ready state lacks exactly one signed terminal-ready event.");
    ensureQualificationTerminalSeal({
      runRoot,runId:state.run_id,stages:STAGES,
      stagePath:(stage) => join(runRoot,"stage-manifests",`${stage}.json`),
      eventAudit:audit,allowCreate:false,
      integrityVerifier:(payload,signature) => store.verifyIntegrity(payload,signature),
    });
  } else {
    if (state.status!=="BLOCKED" || !String(state.blocker || "").trim()) throw new Error("Blocked state lacks a blocker and BLOCKED status.");
    const terminalEvents=audit.events.filter((event) => event.data?.run_id===state.run_id && ["terminal_blocked","resume_integrity_blocked"].includes(event.type));
    if (!terminalEvents.length) throw new Error("Blocked state lacks a signed terminal failure event.");
    const stage=terminalEvents.find((event) => event.type==="terminal_blocked")?.data?.stage;
    if (stage) {
      const gatePath=join(runRoot,"stage-manifests",`${stage}.json`);
      const gate=existsSync(gatePath) ? readJson(gatePath) : null;
      if (gate?.stage!==stage || gate?.passed!==false) throw new Error("Blocked state does not bind a failed stage gate.");
    }
  }
  const statePath=join(logRoot,"worker-state.json");
  return {
    version:"qualification-launchd-terminal-receipt-v1",run_id:state.run_id,state:state.state,
    state_sha256:sha256File(statePath),event_chain_anchor_sha256:audit.anchor_sha256,
    event_chain_root:audit.head_hash,verified_at:new Date().toISOString(),sealed_unseen_accessed:false,
  };
}
