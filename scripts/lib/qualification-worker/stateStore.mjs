import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { atomicWrite, canonicalHash, createExclusive, fsyncDirectory, now, readJson, sha256Buffer } from "./utils.mjs";
import { safeHostEnvironment } from "./processEnvironment.mjs";

function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function validOwnerToken(token) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(token || ""));
}

function validProcessIdentity(value) {
  return value && Number.isInteger(Number(value.pid)) && Number(value.pid) > 0 &&
    typeof value.executable === "string" && isAbsolute(value.executable) &&
    Array.isArray(value.argv) && value.argv.length > 0 && value.argv.every((item) => typeof item === "string");
}

function sameProcessIdentity(record,observation) {
  if (!validProcessIdentity(record) || !validProcessIdentity(observation) || Number(record.pid) !== Number(observation.pid)) return false;
  let executableMatches = false;
  try { executableMatches = realpathSync.native(record.executable) === realpathSync.native(observation.executable); } catch {}
  return executableMatches && canonicalHash(record.argv) === canonicalHash(observation.argv);
}

function processIdentityDigestValid(record) {
  return validProcessIdentity(record) && record.identity_sha256 === canonicalHash({ pid:Number(record.pid),executable:record.executable,argv:record.argv });
}

function defaultProcessObserver(pid) {
  if (Number(pid) !== process.pid) return null;
  return { pid:process.pid,executable:realpathSync.native(process.execPath),argv:[...process.argv] };
}

export function createDarwinProcessObserver({ pythonExecutable,probeScript,timeoutMs = 10_000 }) {
  return (pid) => {
    const result = spawnSync(pythonExecutable,["-I","-B",probeScript,String(pid)],{
      encoding:"utf8",timeout:timeoutMs,env:{ ...safeHostEnvironment(),PYTHONDONTWRITEBYTECODE:"1",PYTHONHASHSEED:"0" },
    });
    if (result.status !== 0) return null;
    try {
      const observed = JSON.parse(result.stdout);
      if (!validProcessIdentity(observed)) return null;
      return { pid:Number(observed.pid),executable:realpathSync.native(observed.executable),argv:observed.argv };
    } catch { return null; }
  };
}

export class StateStore {
  constructor(root,{ processObserver = defaultProcessObserver } = {}) {
    this.root = root;
    this.statePath = join(root, "worker-state.json");
    this.eventsPath = join(root, "worker-events.jsonl");
    this.eventsAnchorPath = join(root,"worker-events.anchor.json");
    this.integrityPrivateKeyPath = join(root,"controller-integrity-private.pem");
    this.integrityPublicKeyPath = join(root,"controller-integrity-public.pem");
    this.lockPath = join(root, "worker.lock");
    this.reclaimPath = join(root, "worker.lock.reclaim");
    this.locked = false;
    this.lockToken = null;
    this.processObserver = processObserver;
  }

  ensureIntegrityIdentity({ allowCreate = false } = {}) {
    const privateExists = existsSync(this.integrityPrivateKeyPath);
    const publicExists = existsSync(this.integrityPublicKeyPath);
    if (privateExists !== publicExists) throw Object.assign(new Error("Controller integrity key pair is incomplete."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
    if (!privateExists) {
      if (!allowCreate) throw Object.assign(new Error("Controller integrity key pair is missing."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
      const existingEvents = existsSync(this.eventsPath) && readFileSync(this.eventsPath,"utf8").trim().length > 0;
      if (existingEvents || existsSync(this.eventsAnchorPath)) throw Object.assign(new Error("Controller integrity identity cannot be created for an existing event chain."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
      const keys = generateKeyPairSync("ed25519",{
        publicKeyEncoding:{ type:"spki",format:"pem" },privateKeyEncoding:{ type:"pkcs8",format:"pem" },
      });
      createExclusive(this.integrityPrivateKeyPath,keys.privateKey);
      createExclusive(this.integrityPublicKeyPath,keys.publicKey,{ mode:0o444 });
    }
    if (lstatSync(this.integrityPrivateKeyPath).isSymbolicLink() || lstatSync(this.integrityPublicKeyPath).isSymbolicLink()) throw Object.assign(new Error("Controller integrity key path is unsafe."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
    const privateKey = readFileSync(this.integrityPrivateKeyPath,"utf8");
    const publicKey = readFileSync(this.integrityPublicKeyPath,"utf8");
    const challenge = Buffer.from("qualification-controller-integrity-key-v1");
    if (!privateKey.includes("PRIVATE KEY") || !publicKey.includes("PUBLIC KEY") || !verify(null,challenge,publicKey,sign(null,challenge,privateKey))) {
      throw Object.assign(new Error("Controller integrity key pair does not match."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
    }
    return { privateKey,publicKey,publicKeySha256:sha256Buffer(publicKey) };
  }

  signIntegrity(payload) {
    const keys = this.ensureIntegrityIdentity({ allowCreate:true });
    return {
      integrity_public_key_sha256:keys.publicKeySha256,
      integrity_signature:sign(null,Buffer.from(canonicalHash(payload)),keys.privateKey).toString("hex"),
    };
  }

  verifyIntegrity(payload,{ integrity_public_key_sha256:publicKeySha256,integrity_signature:signature } = {}) {
    const keys = this.ensureIntegrityIdentity({ allowCreate:false });
    return publicKeySha256 === keys.publicKeySha256 && /^[0-9a-f]{128}$/.test(String(signature || "")) &&
      verify(null,Buffer.from(canonicalHash(payload)),keys.publicKey,Buffer.from(signature,"hex"));
  }

  writeEventAnchor(payload) {
    atomicWrite(this.eventsAnchorPath,{ ...payload,...this.signIntegrity(payload) });
  }

  acquireLock() {
    const token = randomUUID();
    const self = this.processObserver(process.pid);
    if (!sameProcessIdentity(self,self)) throw Object.assign(new Error("Cannot establish the qualification worker's executable and full argv identity."),{ code:"WORKER_LOCK_INTEGRITY_ERROR" });
    const owner = { pid:process.pid,token,executable:self.executable,argv:self.argv,identity_sha256:canonicalHash({ pid:process.pid,executable:self.executable,argv:self.argv }),acquired_at:now() };
    try {
      createExclusive(this.lockPath,owner);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const prior = (() => { try { return readJson(this.lockPath); } catch { return null; } })();
      if (!validOwnerToken(prior?.token) || !processIdentityDigestValid(prior)) {
        throw Object.assign(new Error("Qualification worker lock has no complete token/PID/executable/argv identity; refusing automatic recovery."), { code:"WORKER_LOCK_INTEGRITY_ERROR" });
      }
      const priorObservation = processAlive(prior.pid) ? this.processObserver(prior.pid) : null;
      if (processAlive(prior.pid) && !priorObservation) throw Object.assign(new Error("Live qualification lock owner could not be observed exactly; refusing recovery."),{ code:"WORKER_LOCK_INTEGRITY_ERROR" });
      if (priorObservation && sameProcessIdentity(prior,priorObservation)) throw Object.assign(new Error(`Qualification worker already runs as PID ${prior.pid}.`), { code: "WORKER_ALREADY_RUNNING" });
      try { createExclusive(this.reclaimPath, { ...owner,prior_identity_sha256:prior.identity_sha256,prior_token:prior.token }); }
      catch (reclaimError) {
        if (reclaimError?.code === "EEXIST") throw Object.assign(new Error("Qualification worker lock is being recovered by another process."), { code:"WORKER_ALREADY_RUNNING" });
        throw reclaimError;
      }
      try {
        const current = (() => { try { return readJson(this.lockPath); } catch { return null; } })();
        const currentObservation = current?.pid && processAlive(current.pid) ? this.processObserver(current.pid) : null;
        if (canonicalHash(current || {}) !== canonicalHash(prior) || (current?.pid && processAlive(current.pid) && (!currentObservation || sameProcessIdentity(current,currentObservation)))) {
          throw Object.assign(new Error("Qualification worker lock changed during stale-lock recovery."), { code:"WORKER_ALREADY_RUNNING" });
        }
        rmSync(this.lockPath, { force:true });
        createExclusive(this.lockPath, { ...owner,recovered_stale_lock:true,recovered_identity_sha256:prior.identity_sha256 });
      } finally {
        const reclaim = (() => { try { return readJson(this.reclaimPath); } catch { return null; } })();
        if (reclaim?.token === token) rmSync(this.reclaimPath, { force:true });
      }
    }
    this.lockToken = token;
    this.locked = true;
  }

  releaseLock() {
    if (this.locked) {
      const current = (() => { try { return readJson(this.lockPath); } catch { return null; } })();
      const self = this.processObserver(process.pid);
      if (current?.token === this.lockToken && validOwnerToken(current.token) && processIdentityDigestValid(current) && sameProcessIdentity(current,self)) rmSync(this.lockPath, { force:true });
    }
    this.locked = false;
    this.lockToken = null;
  }

  load(initial) {
    return existsSync(this.statePath) ? readJson(this.statePath) : initial;
  }

  save(state) {
    atomicWrite(this.statePath, { ...state, updated_at: now() });
  }

  lastEventHash() {
    return this.auditEventChain({ allowAnchorBootstrap:false }).head_hash;
  }

  auditEventChain({ allowAnchorBootstrap = false } = {}) {
    const text = existsSync(this.eventsPath) ? readFileSync(this.eventsPath,"utf8") : "";
    if (text && !text.endsWith("\n")) throw Object.assign(new Error("Worker event log has a malformed or truncated tail."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
    const rows = text.split("\n").filter(Boolean);
    let previous = null;
    let activeRunId = null;
    const hashes = [];
    const events = [];
    for (const [index,row] of rows.entries()) {
      let event;
      try { event = JSON.parse(row); } catch { throw Object.assign(new Error(`Worker event ${index + 1} is not valid JSON.`),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" }); }
      const { event_hash:storedHash,...payload } = event || {};
      if (!/^[0-9a-f]{64}$/.test(String(storedHash || "")) || canonicalHash(payload) !== storedHash || payload.previous_event_hash !== previous) {
        throw Object.assign(new Error(`Worker event chain is invalid at sequence ${index + 1}.`),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
      }
      if (payload.chain_version !== 2) throw Object.assign(new Error(`Worker event chain version is unsupported at sequence ${index + 1}.`),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
      if (!Number.isInteger(payload.sequence) || payload.sequence !== index + 1) throw Object.assign(new Error(`Worker event sequence is discontinuous at ${index + 1}.`),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
      const eventRunId = payload.data?.run_id || null;
      if (payload.type === "new_run_created") {
        if (!eventRunId || (activeRunId && payload.data?.prior_run_id !== activeRunId)) throw Object.assign(new Error(`Worker event run boundary is invalid at ${index + 1}.`),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
        activeRunId = eventRunId;
      } else if (eventRunId) {
        if (activeRunId && eventRunId !== activeRunId) throw Object.assign(new Error(`Worker event crosses run boundaries at ${index + 1}.`),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
        activeRunId ||= eventRunId;
      }
      previous = storedHash;
      hashes.push(storedHash);
      events.push({ ...payload,event_hash:storedHash });
    }
    const audit = { version:"qualification-worker-event-chain-audit-v2",event_count:rows.length,head_hash:previous,hashes,events,active_run_id:activeRunId };
    if (existsSync(this.eventsAnchorPath)) {
      const anchor = readJson(this.eventsAnchorPath);
      const { integrity_public_key_sha256,integrity_signature,...anchorPayload } = anchor || {};
      if (anchorPayload.version !== "qualification-worker-event-chain-anchor-v2" || anchorPayload.event_count !== audit.event_count || anchorPayload.head_hash !== audit.head_hash ||
          !this.verifyIntegrity(anchorPayload,{ integrity_public_key_sha256,integrity_signature })) {
        throw Object.assign(new Error("Worker event log differs from its persisted chain anchor."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
      }
      audit.anchor_sha256 = canonicalHash(anchor);
      audit.anchor_signature = integrity_signature;
      audit.integrity_public_key_sha256 = integrity_public_key_sha256;
    } else if (rows.length) {
      throw Object.assign(new Error(allowAnchorBootstrap ? "Worker event-chain anchor requires an explicit signed migration." : "Worker event-chain anchor is missing."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
    }
    return audit;
  }

  event(type, data = {}) {
    const prior = this.auditEventChain({ allowAnchorBootstrap:false });
    this.ensureIntegrityIdentity({ allowCreate:true });
    if (type === "new_run_created") {
      if (!data.run_id || (prior.active_run_id && data.prior_run_id !== prior.active_run_id)) throw Object.assign(new Error("New-run event does not match the active event-chain run."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
    } else if (data.run_id && prior.active_run_id && data.run_id !== prior.active_run_id) {
      throw Object.assign(new Error("Event run_id crosses the active event-chain boundary."),{ code:"WORKER_EVENT_CHAIN_INTEGRITY_ERROR" });
    }
    const payload = { chain_version:2,sequence:prior.event_count + 1,sequence_time: now(), type, data, previous_event_hash: prior.head_hash };
    const event = { ...payload, event_hash: canonicalHash(payload) };
    const fd = openSync(this.eventsPath,"a",0o600);
    try { writeFileSync(fd,`${JSON.stringify(event)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    fsyncDirectory(this.root);
    this.writeEventAnchor({ version:"qualification-worker-event-chain-anchor-v2",event_count:payload.sequence,head_hash:event.event_hash,anchored_at:now() });
    return event;
  }
}
