#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot=resolve(fileURLToPath(new URL("../",import.meta.url)));
const required=(name) => {
  const value=String(process.env[name] || "").trim();
  if (!value) throw Object.assign(new Error(`${name} is required`),{ code:"SEALED_CUSTODIAN_CONFIGURATION_MISSING" });
  return value;
};
const runId=required("SEALED_UNSEEN_RUN_LABEL");
if (required("SEALED_UNSEEN_EXECUTION_CONFIRMATION")!=="owner_authorised_one_shot_cycle_v1_60") throw Object.assign(new Error("Owner one-shot authorisation is absent"),{ code:"OWNER_AUTHORISATION_REQUIRED" });
required("EVALUATION_SEAL_KEY_PATH");
required("SEALED_UNSEEN_VISIBLE_GATE_PATH");
required("SEALED_UNSEEN_VISIBLE_GATE_SHA256");
required("SEALED_UNSEEN_REVIEW_APPROVAL_PATH");
required("SEALED_UNSEEN_REVIEW_APPROVAL_SHA256");

const appPort=Number(process.env.SEALED_UNSEEN_APP_PORT || 3002);
const modelPort=Number(process.env.SEALED_UNSEEN_MODEL_PORT || 8082);
const retrievalPort=Number(process.env.SEALED_UNSEEN_RETRIEVAL_PORT || 8092);
const endpoint=`http://127.0.0.1:${appPort}`;
const contextKey=randomBytes(32).toString("hex");
const nonceRoot=mkdtempSync(join(tmpdir(),"sealed-custodian-nonces-"));
const safeRuntimeEnvironment={};
for (const [key,value] of Object.entries(process.env)) {
  if (!/(?:SEALED|UNSEEN|GOLD|EVALUATION_SEAL|TOKEN|SECRET|KEY)/i.test(key)) safeRuntimeEnvironment[key]=value;
}
Object.assign(safeRuntimeEnvironment,{
  SEALED_UNSEEN_CUSTODIAN_MODE:"true",SEALED_UNSEEN_RUN_ID:runId,
  SEALED_UNSEEN_CONTEXT_HMAC_KEY:contextKey,SEALED_UNSEEN_NONCE_STORE_PATH:nonceRoot,
  QUALIFICATION_ATTEMPT_TELEMETRY:"true",DISABLE_DOTENV_LOAD:"true",DISABLE_DEBUG_LOGGING:"true",
  DEBUG_LOG_INCLUDE_TEXT:"false",DISABLE_RETRIEVAL_METRICS:"true",ALLOW_DEGRADED_EMBEDDINGS:"false",REQUIRE_CROSS_ENCODER_RERANK:"true",
});
const checkpoint=required("SEALED_UNSEEN_CHECKPOINT_PATH");
const corpus=required("APPROVED_CORPUS_MANIFEST_PATH");
const corpusSha=required("APPROVED_CORPUS_MANIFEST_SHA256");
const runtime=spawn(process.execPath,[resolve(projectRoot,"scripts/liveLocal.mjs"),"--checkpoint",checkpoint,"--port",String(appPort),"--model-port",String(modelPort),"--retrieval-port",String(retrievalPort),"--corpus-manifest",corpus,"--corpus-sha256",corpusSha],{
  cwd:projectRoot,env:safeRuntimeEnvironment,stdio:"inherit",detached:process.platform!=="win32",
});

async function stopRuntime() {
  try { process.kill(process.platform==="win32" ? runtime.pid : -runtime.pid,"SIGTERM"); } catch {}
  await Promise.race([new Promise((resolve) => runtime.once("close",resolve)),new Promise((resolve) => setTimeout(resolve,15_000))]);
  try { process.kill(process.platform==="win32" ? runtime.pid : -runtime.pid,"SIGKILL"); } catch {}
}

async function waitReady() {
  const deadline=Date.now()+420_000;
  while (Date.now()<deadline) {
    if (runtime.exitCode!=null) throw Object.assign(new Error("Custodian runtime stopped during startup"),{ code:"SEALED_CANONICAL_RUNTIME_NOT_READY" });
    try {
      const response=await fetch(`${endpoint}/api/ready?force=1`,{ signal:AbortSignal.timeout(5_000) });
      const body=await response.json();
      if (response.ok && body?.ready===true && body.checks?.every((check) => check.ready===true)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve,1_000));
  }
  throw Object.assign(new Error("Custodian runtime startup timed out"),{ code:"SEALED_CANONICAL_RUNTIME_NOT_READY" });
}

let exitCode=1;
try {
  await waitReady();
  const child=spawn(process.execPath,[resolve(projectRoot,"scripts/evaluationCycleV1SealedUnseenOneShot.mjs")],{
    cwd:projectRoot,env:{ ...process.env,SEALED_UNSEEN_CUSTODIAN_MODE:"true",SEALED_UNSEEN_RUN_ID:runId,SEALED_UNSEEN_CONTEXT_HMAC_KEY:contextKey,SEALED_UNSEEN_NONCE_STORE_PATH:nonceRoot,SEALED_UNSEEN_CANONICAL_ENDPOINT:endpoint,LOCAL_LLM_BASE_URL:`http://127.0.0.1:${modelPort}`,EMBEDDING_SERVICE_URL:`http://127.0.0.1:${retrievalPort}` },stdio:"inherit",
  });
  exitCode=await new Promise((resolve) => child.once("close",(code) => resolve(code ?? 1)));
} finally {
  await stopRuntime();
  rmSync(nonceRoot,{ recursive:true,force:true });
}
process.exitCode=exitCode;
