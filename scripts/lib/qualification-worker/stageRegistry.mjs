import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CRITICAL_IDS, loadAndVerifyVisibleAssets, qualificationPaths } from "../postTrainingVisibleQualificationV1.mjs";
import { revalidateDualAiReview, runDualAiReview,verifyReviewerExecutable } from "./aiReview.mjs";
import { runActiveReliabilityJourneys } from "./activeReliability.mjs";
import {
  captureBindings,
  compareBindings,
  directoryRecords,
  discoverTransitiveLocalImports,
  manifestDirectory,
  validateArtifactRecords,
} from "./artifactManifest.mjs";
import {
  casesFromScorecard,
  prepareLive50Cases,
  validateAiGate,
  validateCaseAttemptLedgers,
  validateConfig,
  validateLive50,
  validateReliability,
  validateT4Summary,
  validateTopic161Summary,
} from "./gateValidators.mjs";
import { assertCommandAllowed, assertNoProtectedCredentials, assertPathAllowed } from "./protectedPaths.mjs";
import { ensureRuntime,interruptOwnedModelWorkerAndWait, QUALIFICATION_CONTEXT_KEY_FILE, QUALIFICATION_NONCE_STORE_DIRECTORY, QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE, removeQualificationContextKey, stopOwnedRuntime, verifyOwnedRuntimeProcess,verifyRuntimeStillBound } from "./runtimeSupervisor.mjs";
import { safeHostEnvironment } from "./processEnvironment.mjs";
import { atomicWrite, canonicalHash, createExclusive, fileRecord, now, readJson, sha256Buffer, sha256File } from "./utils.mjs";
import { bindCaseEvidence, buildTrustedEvidenceCatalog,mergeCaseEvidenceCatalog } from "./trustedEvidence.mjs";
import { processGroupAlive, terminateProcessGroup } from "./childProcessGroup.mjs";
import { verifyServedResponseReceipt } from "../servedResponseReceipt.mjs";
import { combineGenerationTelemetry } from "./liveAttemptTelemetry.mjs";
import { buildReviewCalibrationCases,validateAiReviewCalibration,validateDeterministicReviewCalibration } from "./reviewCalibration.mjs";
import { deriveQualificationStageCapabilityKey } from "../../../server/services/qualificationContextService.js";

export const EXECUTABLE_ENTRY_PATHS = Object.freeze([
  "app.js",
  "server.js",
  "server/services/pinnedModelServer.js",
  "scripts/qualificationWorker.mjs",
  "scripts/qualificationWorkerStatus.mjs",
  "scripts/installQualificationWorkerLaunchd.mjs",
  "scripts/liveLocal.mjs",
  "scripts/modelServePinned.mjs",
  "scripts/mlServe.mjs",
  "scripts/isolatedPythonLauncher.py",
  "scripts/processArgvDarwin.py",
  "scripts/qualificationPersonalEvidence.mjs",
  "scripts/pythonEnvironmentFingerprint.py",
  "ml/embedding_server.py",
  "ml/pinned_mlx_worker.py",
  "ml/pinned_prompt_cache.py",
  "scripts/runLiveQuestionSet.mjs",
  "scripts/t4PostTrainingDevelopmentEval.mjs",
  "scripts/evaluationCycleV2Wave1Run.mjs",
  "scripts/evaluationCycleV2Wave1Score.mjs",
  "scripts/evaluationCycleV1PostFixRegression.mjs",
  "scripts/evaluationCycleV1PostFixScore.mjs",
  "scripts/evaluationCycleV2PostTrainingVisibleQualificationV1.mjs",
  "scripts/evaluationCycleV2PostTrainingVisibleQualificationGateV1.mjs",
]);

function uniqueRecords(...groups) {
  const byPath = new Map();
  for (const record of groups.flat(Infinity).filter(Boolean)) byPath.set(record.path, record);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function sandboxLiteral(path) {
  return JSON.stringify(String(path));
}

function pathAncestors(path) {
  const values = [];
  let cursor = resolve(path);
  while (true) {
    values.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return values;
}

function stageWritableDirectories({ projectRoot,env,logPath }) {
  const candidates = [dirname(logPath)];
  if (env?.T4_DEV_OUT) {
    candidates.push(resolve(env.T4_DEV_OUT));
    for (const wave of ["wave-1","wave-2","wave-3"]) {
      candidates.push(resolve(projectRoot,`training/evaluation-cycle-v2/02-${wave}-execution/diagnostic/${env.T4_DEV_LABEL_PREFIX}-${wave}`));
    }
  }
  if (env?.LIVE_OUTPUT_DIR) candidates.push(resolve(env.LIVE_OUTPUT_DIR));
  if (env?.VISIBLE_QUALIFICATION_OUTPUT_PARENT && env?.VISIBLE_QUALIFICATION_RUN_LABEL && env?.VISIBLE_QUALIFICATION_STAGE) {
    const paths = qualificationPaths(env.VISIBLE_QUALIFICATION_RUN_LABEL,env.VISIBLE_QUALIFICATION_OUTPUT_PARENT);
    candidates.push(paths.root);
    const key = env.VISIBLE_QUALIFICATION_STAGE;
    if (key === "critical4" || key === "full69") candidates.push(paths[key].root);
    else if (key === "topic161" || key === "frozen13") candidates.push(...Object.values(paths[key]).map((item) => item.root));
  }
  const result = [];
  for (const candidate of [...new Set(candidates.map((value) => resolve(value)))]) {
    mkdirSync(candidate,{ recursive:true });
    const canonical = realpathSync.native(candidate);
    const rel = relative(projectRoot,canonical);
    if (!rel || rel.startsWith("..") || resolve(projectRoot,rel) !== canonical) throw new Error(`Stage writable path leaves the project or resolves to its root: ${candidate}`);
    result.push(canonical);
  }
  return result;
}

function reportedCapabilityNonces(item) {
  const values = [item.qualification_capability_nonce];
  const requestEvents = item.attempt_ledger?.request_events || item.request_attempt_ledger || [];
  for (const event of requestEvents) {
    values.push(event?.qualification_capability_nonce,event?.data?.qualification_capability_nonce,event?.telemetry?.qualification_capability_nonce);
  }
  return values.filter((value) => typeof value === "string" && value.length > 0);
}

export function auditConsumedCapabilities({ runRoot,stage,cases }) {
  const nonceRoot = join(runRoot,QUALIFICATION_NONCE_STORE_DIRECTORY);
  const expectedRunId = String(runRoot).split(/[\\/]/).at(-1);
  const blockers = [];
  let records = [];
  let quotaRecords = [];
  try {
    records = readdirSync(nonceRoot).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).map((name) => readJson(join(nonceRoot,name)));
    quotaRecords = readdirSync(nonceRoot).filter((name) => /^quota-[0-9a-f]{64}-[12]\.json$/.test(name)).map((name) => ({ name,...readJson(join(nonceRoot,name)) }));
  } catch (error) { return { passed:false,blockers:[`consumed capability ledger is unavailable: ${error.message}`],counts:{ consumed:0,reported:0 } }; }
  const stageRecords = records.filter((record) => record.stage_id === stage);
  const stageQuotaRecords = quotaRecords.filter((record) => record.stage_id === stage);
  if (stageRecords.some((record) => record.version !== "qualification-consumed-capability-v1" || record.run_id !== expectedRunId || record.case_id == null || record.nonce == null || ![1,2].includes(record.quota_slot))) blockers.push("consumed capability ledger contains a malformed or cross-run stage record");
  if (stageQuotaRecords.some((record) => {
    const key = sha256Buffer(`${record.run_id}\0${record.stage_id}\0${record.case_id}`);
    return record.version !== "qualification-capability-quota-slot-v1" || record.run_id !== expectedRunId || ![1,2].includes(record.slot) ||
      record.name !== `quota-${key}-${record.slot}.json` || record.case_id == null || record.nonce == null;
  })) blockers.push("capability quota ledger contains a malformed or cross-run stage record");
  const byCase = new Map();
  for (const record of stageRecords) byCase.set(record.case_id,(byCase.get(record.case_id) || 0) + 1);
  for (const [caseId,count] of byCase) if (count > 2) blockers.push(`${caseId} exceeded the two-request capability quota`);
  const consumed = [...new Set(stageRecords.map((record) => record.nonce))].sort();
  const reserved = [...new Set(stageQuotaRecords.map((record) => record.nonce))].sort();
  const reported = [...new Set((cases || []).flatMap(reportedCapabilityNonces))].sort();
  if (consumed.length !== stageRecords.length) blockers.push("consumed capability ledger contains duplicate nonces");
  if (stageRecords.some((record) => !stageQuotaRecords.some((slot) => slot.case_id === record.case_id && slot.slot === record.quota_slot && slot.nonce === record.nonce))) blockers.push("consumed capability does not match its reserved quota slot");
  if (reserved.length !== stageQuotaRecords.length || canonicalHash(reserved) !== canonicalHash(consumed)) blockers.push("capability quota slots do not exactly match consumed capabilities");
  if (canonicalHash(consumed) !== canonicalHash(reported)) blockers.push("consumed capabilities do not exactly match the final attempt ledger");
  return { passed:blockers.length === 0,blockers,counts:{ consumed:consumed.length,reserved:reserved.length,reported:reported.length },consumed_nonce_sha256:canonicalHash(consumed) };
}

function evaluationSummaryRecords(context, outputDirectory, summary) {
  const external = (summary.waves || []).flatMap((wave) => directoryRecords(
    context.projectRoot,
    resolve(context.projectRoot, `training/evaluation-cycle-v2/02-${wave.wave}-execution/diagnostic/${wave.label}`),
  ));
  return uniqueRecords(directoryRecords(context.projectRoot, outputDirectory), external);
}

function developmentCases(context, summary) {
  const cases = [];
  for (const wave of summary.waves || []) {
    const root = resolve(context.projectRoot, `training/evaluation-cycle-v2/02-${wave.wave}-execution/diagnostic/${wave.label}`);
    cases.push(...casesFromScorecard(
      readJson(join(root, "results.json")),
      readJson(join(root, "scorecard.json")),
      loadV2Expected(context.projectRoot, false, wave.wave),
    ));
  }
  return cases;
}

export function qualificationStageSandboxProfile({ projectRoot,config,logPath,env = {} }) {
  const canonicalProjectRoot = realpathSync.native(projectRoot);
  const lexicalLogRoot = resolve(projectRoot,config.paths?.log_root || "Log/qualification-worker");
  const logRoot = existsSync(lexicalLogRoot) ? realpathSync.native(lexicalLogRoot) : lexicalLogRoot;
  const runRelative = relative(join(logRoot,"runs"),resolve(logPath));
  const runId = runRelative && !runRelative.startsWith("..") ? runRelative.split(/[\\/]/)[0] : null;
  const runRoot = runId ? join(logRoot,"runs",runId) : null;
  const denied = [
    join(logRoot,"controller-integrity-private.pem"),join(logRoot,"controller-integrity-public.pem"),
    join(logRoot,"worker-state.json"),join(logRoot,"worker-events.jsonl"),join(logRoot,"worker-events.anchor.json"),
    join(logRoot,"worker.lock"),join(logRoot,"worker.lock.reclaim"),
    ...(runRoot ? [join(runRoot,"runtime-qualification-context.key"),join(runRoot,"candidate-freeze","TERMINAL-SEAL.json")] : []),
  ];
  const writable = stageWritableDirectories({ projectRoot:canonicalProjectRoot,env,logPath });
  return [
    "(version 1)","(allow default)",
    `(deny file-write* (subpath ${sandboxLiteral(canonicalProjectRoot)}))`,
    `(deny file-read* file-write* (subpath ${sandboxLiteral(logRoot)}))`,
    ...pathAncestors(canonicalProjectRoot).map((path) => `(deny file-write* (literal ${sandboxLiteral(path)}))`),
    ...writable.map((path) => `(allow file-read* file-write* (subpath ${sandboxLiteral(path)}))`),
    ...denied.map((path) => `(deny file-read* file-write* (literal ${sandboxLiteral(path)}))`),
    "(deny process-info*)",
    "(allow process-info* (target self))",
  ].join("\n");
}

export function runChild({ projectRoot, config, command, args, env, logPath, onSpawn,onSettled,shouldStop }) {
  assertCommandAllowed(command, args, config);
  assertPathAllowed(projectRoot, relative(projectRoot, logPath), config.protected_path_patterns);
  if (shouldStop?.()) throw Object.assign(new Error("Qualification worker interruption prevented a child-process launch."),{ code:"WORKER_INTERRUPTED" });
  mkdirSync(dirname(logPath), { recursive: true });
  const inherited = safeHostEnvironment(process.env);
  for (const key of Object.keys(inherited)) {
    if (/^(?:CYCLE_V2_(?:PACK_ROOT|GOLD_PATH|QUESTION_IDS|WAVE1_QUESTION_IDS)|VISIBLE_QUALIFICATION_(?:OUTPUT_PARENT|CHECKPOINT_PATH|RUN_LABEL|STAGE|EXECUTE))$/.test(key) || /(?:SEALED|UNSEEN).*(?:PATH|FILE|DIR|GOLD|KEY|TOKEN)/i.test(key)) delete inherited[key];
  }
  const sandboxProfile = qualificationStageSandboxProfile({ projectRoot,config,logPath,env });
  const sandboxed = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  if (process.platform === "darwin" && !sandboxed) throw Object.assign(new Error("Qualification stage sandbox is unavailable."),{ code:"WORKER_SANDBOX_UNAVAILABLE" });
  const spawnCommand = sandboxed ? "/usr/bin/sandbox-exec" : command;
  const spawnArgs = sandboxed ? ["-p",sandboxProfile,command,...args] : args;
  return new Promise((accept) => {
    if (shouldStop?.()) {
      accept({ code:null,signal:null,error:"WORKER_INTERRUPTED before child-process spawn",timed_out:false,termination:null });
      return;
    }
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: projectRoot,
      env: { ...inherited, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let registrationToken = null;
    const chunks = [];
    const errors = [];
    let settled = false;
    let timedOut = false;
    let termination = null;
    let leaderResult = null;
    let leaderSettlementStarted = false;
    let deadlineTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const output = Buffer.concat([...chunks, ...errors]).toString();
      atomicWrite(logPath, output);
      onSettled?.({ pid:child.pid,registration_token:registrationToken,result:{ ...result,timed_out:timedOut,termination } });
      accept({ ...result,timed_out:timedOut,termination });
    };
    child.stdout.on("data", (data) => { chunks.push(data); process.stdout.write(data); });
    child.stderr.on("data", (data) => { errors.push(data); process.stderr.write(data); });
    const rejectSpawnBoundary = async (error) => {
      termination = await terminateProcessGroup(child.pid,{
        reason:"WORKER_INTERRUPTION_AT_STAGE_SPAWN",terminationGraceMs:config.runtime.stage_child_termination_grace_ms,
        killSettleMs:config.runtime.stage_child_kill_settle_ms,pollMs:50,
      });
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code:null,signal:termination.kill_sent ? "SIGKILL" : "SIGTERM",error:`${error.code || "WORKER_INTERRUPTED"}: ${error.message}` });
    };
    try {
      if (shouldStop?.()) throw Object.assign(new Error("Qualification worker interruption reached the child spawn boundary."),{ code:"WORKER_INTERRUPTED" });
      registrationToken = onSpawn?.({ pid:child.pid,kind:"stage_runner",executable:spawnCommand,argv:[spawnCommand,...spawnArgs] }) || null;
      if (shouldStop?.()) throw Object.assign(new Error("Qualification worker interruption followed child registration."),{ code:"WORKER_INTERRUPTED" });
    } catch (error) {
      void rejectSpawnBoundary(error);
      return;
    }
    deadlineTimer = setTimeout(async () => {
      timedOut = true;
      termination = await terminateProcessGroup(child.pid,{
        reason:"STAGE_CHILD_TIMEOUT",terminationGraceMs:config.runtime.stage_child_termination_grace_ms,
        killSettleMs:config.runtime.stage_child_kill_settle_ms,pollMs:Math.min(100,config.runtime.stage_child_kill_settle_ms),
      });
      termination.timeout_ms = config.runtime.stage_child_timeout_ms;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({
        code:leaderResult?.code ?? null,signal:leaderResult?.signal ?? (termination.kill_sent ? "SIGKILL" : "SIGTERM"),
        error:`STAGE_CHILD_TIMEOUT after ${config.runtime.stage_child_timeout_ms}ms${termination.stopped ? "" : "; process group remains after forced termination"}`,
      });
    },config.runtime.stage_child_timeout_ms);
    child.once("error", async (error) => {
      leaderResult = { code:null,signal:null,error:error.message };
      if (!timedOut && !leaderSettlementStarted) {
        leaderSettlementStarted = true;
        if (processGroupAlive(child.pid)) termination = await terminateProcessGroup(child.pid,{ reason:"STAGE_CHILD_ERROR_DESCENDANT_CLEANUP",terminationGraceMs:config.runtime.stage_child_termination_grace_ms,killSettleMs:config.runtime.stage_child_kill_settle_ms,pollMs:50 });
        finish({ ...leaderResult,error:termination ? `${error.message}; stage process-group cleanup was required` : error.message });
      }
    });
    child.once("close", async (code, signal) => {
      leaderResult = { code,signal,error:null };
      if (!timedOut && !leaderSettlementStarted) {
        leaderSettlementStarted = true;
        if (processGroupAlive(child.pid)) termination = await terminateProcessGroup(child.pid,{ reason:"STAGE_DESCENDANTS_AFTER_LEADER_EXIT",terminationGraceMs:config.runtime.stage_child_termination_grace_ms,killSettleMs:config.runtime.stage_child_kill_settle_ms,pollMs:50 });
        finish(termination ? { ...leaderResult,error:"Stage leader exited while descendants remained; process-group cleanup was required" } : leaderResult);
      }
    });
  });
}

function cleanExecution(execution) {
  return execution?.code === 0 && execution?.signal == null && execution?.error == null &&
    execution?.timed_out === false && execution?.termination == null;
}

function normalizedExecution(execution) {
  return {
    code:execution?.code ?? null,
    signal:execution?.signal ?? null,
    error:execution?.error ?? null,
    timed_out:Boolean(execution?.timed_out),
    termination:execution?.termination ?? null,
  };
}

function executionReceiptInputs(context,stage,command,args,extraInputs = {}) {
  return {
    run_id:context.state.run_id,
    stage,
    config_sha256:context.state.config_sha256,
    source_bindings_sha256:canonicalHash(context.state.source_bindings || {}),
    candidate_identity_sha256:canonicalHash(context.state.expected_runtime_identity || {}),
    corpus_integrity_sha256:context.state.corpus_integrity_sha256,
    canonical_facts_sha256:context.state.canonical_facts_sha256,
    runtime_configuration_sha256:context.state.runtime_configuration_sha256,
    python_environment_sha256:context.state.python_environment_sha256,
    command:{ executable:command,args },
    ...extraInputs,
  };
}

export function createExecutionReceipt({ context,receiptPath,stage,command,args,execution,artifacts,extraInputs = {} }) {
  const records = uniqueRecords(artifacts || []);
  const receipt = {
    version:"qualification-child-execution-receipt-v1",
    completed_at:now(),
    inputs:executionReceiptInputs(context,stage,command,args,extraInputs),
    execution:normalizedExecution(execution),
    artifacts:records,
    artifacts_sha256:canonicalHash(records),
  };
  createExclusive(receiptPath,receipt);
  return receipt;
}

export function validateExecutionReceipt({ context,receiptPath,stage,command,args,extraInputs = {},requireClean = true }) {
  if (!existsSync(receiptPath)) throw Object.assign(new Error(`Execution receipt is absent for ${stage}.`),{ code:"EVALUATOR_DEFECT" });
  const receipt = readJson(receiptPath);
  const expectedInputs = executionReceiptInputs(context,stage,command,args,extraInputs);
  if (receipt.version !== "qualification-child-execution-receipt-v1" || canonicalHash(receipt.inputs || {}) !== canonicalHash(expectedInputs)) {
    throw Object.assign(new Error(`Execution receipt input or command binding mismatch for ${stage}.`),{ code:"EVALUATOR_DEFECT" });
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0 || receipt.artifacts_sha256 !== canonicalHash(receipt.artifacts)) {
    throw Object.assign(new Error(`Execution receipt artifact manifest is invalid for ${stage}.`),{ code:"EVALUATOR_DEFECT" });
  }
  const failures = validateArtifactRecords(context.projectRoot,receipt.artifacts);
  if (failures.length) throw Object.assign(new Error(`Execution receipt artifact changed for ${stage}: ${failures[0].path}`),{ code:"EVALUATOR_DEFECT" });
  if (requireClean && !cleanExecution(receipt.execution)) {
    throw Object.assign(new Error(`Stored execution did not complete cleanly for ${stage}.`),{ code:"INFRASTRUCTURE_TEMPORARY",execution:receipt.execution });
  }
  return receipt;
}

function stageGatePath(context, stage) {
  return join(context.runRoot, "stage-manifests", `${stage}.json`);
}

function writeGate(context, stage, gate, extra = {}) {
  const priorStage = context.state.completed_stages.at(-1) || null;
  const priorGate = priorStage ? stageGatePath(context, priorStage) : null;
  const runtimeOwnerArtifacts = (context.runtimeOwnerArtifacts?.get(stage) || [])
    .filter(existsSync)
    .map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path)));
  const artifacts = uniqueRecords(extra.artifacts || [],runtimeOwnerArtifacts);
  const payload = {
    version: "qualification-stage-gate-v1", stage, completed_at: now(), ...gate, ...extra,
    artifacts,
    artifacts_sha256: canonicalHash(artifacts),
    inputs: {
      config_sha256: context.state.config_sha256,
      source_bindings_sha256: canonicalHash(context.state.source_bindings || {}),
      corpus_integrity_sha256: context.state.corpus_integrity_sha256 || null,
      canonical_facts_sha256: context.state.canonical_facts_sha256 || null,
      runtime_configuration_sha256:context.state.runtime_configuration_sha256 || null,
      python_environment_sha256:context.state.python_environment_sha256 || null,
      candidate_identity_sha256: canonicalHash(context.state.expected_runtime_identity || {}),
      predecessor: priorGate ? { stage: priorStage, path: priorGate, sha256: sha256File(priorGate) } : null,
    },
    sealed_unseen_accessed: false,
  };
  createExclusive(stageGatePath(context, stage), payload);
  return payload;
}

function readIf(path) {
  return existsSync(path) ? readJson(path) : null;
}

function developmentAttemptManifest(context,{ stage,runnerStage,out,summaryPath,labelPrefix }) {
  const runner = resolve(context.projectRoot,"scripts/t4PostTrainingDevelopmentEval.mjs");
  const idsPath = resolve(context.projectRoot,context.config.paths.t4_target_ids);
  return {
    version:"qualification-development-attempt-v1",
    run_id:context.state.run_id,
    worker_stage:stage,
    runner_stage:runnerStage,
    output_directory:out,
    summary_path:summaryPath,
    label_prefix:labelPrefix,
    command:{ executable:process.execPath,args:[runner] },
    config_sha256:context.state.config_sha256,
    source_bindings_sha256:canonicalHash(context.state.source_bindings || {}),
    runtime_identity_sha256:canonicalHash(context.state.expected_runtime_identity || {}),
    corpus_integrity_sha256:context.state.corpus_integrity_sha256,
    canonical_facts_sha256:context.state.canonical_facts_sha256,
    runtime_configuration_sha256:context.state.runtime_configuration_sha256,
    python_environment_sha256:context.state.python_environment_sha256,
    t4_target_ids:{ path:idsPath,sha256:sha256File(idsPath) },
  };
}

function prepareDevelopmentAttempt(context,options) {
  const outExisted = existsSync(options.out);
  const attemptPath = join(options.out,"attempt-manifest.json");
  const receiptPath = join(options.out,"completion-receipt.json");
  const expected = developmentAttemptManifest(context,options);
  if (outExisted && !existsSync(attemptPath)) throw Object.assign(new Error(`Immutable development attempt has no manifest: ${options.out}`),{ code:"EVALUATOR_DEFECT" });
  mkdirSync(options.out,{ recursive:true });
  if (existsSync(attemptPath)) {
    if (canonicalHash(readJson(attemptPath)) !== canonicalHash(expected)) throw Object.assign(new Error(`Development attempt manifest mismatch: ${options.stage}`),{ code:"EVALUATOR_DEFECT" });
  } else createExclusive(attemptPath,expected);
  const attemptSha256 = sha256File(attemptPath);
  const summary = readIf(options.summaryPath);
  const receipt = readIf(receiptPath);
  if ((summary && !receipt) || (!summary && receipt)) throw Object.assign(new Error(`Incomplete immutable development attempt: ${options.stage}`),{ code:"EVALUATOR_DEFECT" });
  if (summary || receipt) validateDevelopmentCompletion({ options,expected,attemptPath,attemptSha256,summary,receipt });
  return { attemptPath,attemptSha256,receiptPath,expected,resumed:Boolean(summary && receipt) };
}

function validateDevelopmentCompletion({ options,expected,attemptPath,attemptSha256,summary,receipt }) {
  const expectedBinding = {
    run_id:expected.run_id,worker_stage:expected.worker_stage,runner_stage:expected.runner_stage,
    label_prefix:expected.label_prefix,attempt_manifest_path:attemptPath,attempt_manifest_sha256:attemptSha256,
  };
  if (canonicalHash(summary?.attempt_binding || {}) !== canonicalHash(expectedBinding)) throw Object.assign(new Error(`Development summary attempt binding mismatch: ${options.stage}`),{ code:"EVALUATOR_DEFECT" });
  const expectedReceipt = {
    version:"qualification-development-completion-v1",run_id:expected.run_id,worker_stage:expected.worker_stage,
    runner_stage:expected.runner_stage,attempt_manifest_path:attemptPath,attempt_manifest_sha256:attemptSha256,
    summary_path:options.summaryPath,summary_sha256:sha256File(options.summaryPath),runner_exit_code:0,
  };
  const actualReceipt = Object.fromEntries(Object.keys(expectedReceipt).map((key) => [key,receipt?.[key]]));
  if (canonicalHash(actualReceipt) !== canonicalHash(expectedReceipt)) throw Object.assign(new Error(`Development completion receipt mismatch: ${options.stage}`),{ code:"EVALUATOR_DEFECT" });
}

function completeDevelopmentAttempt(attempt,options,execution) {
  if (execution.code !== 0 || execution.signal || execution.error) throw Object.assign(new Error(`Development runner did not complete cleanly for ${options.stage}.`),{ code:"INFRASTRUCTURE_TEMPORARY" });
  const summary = readJson(options.summaryPath);
  const receipt = {
    version:"qualification-development-completion-v1",run_id:attempt.expected.run_id,worker_stage:attempt.expected.worker_stage,
    runner_stage:attempt.expected.runner_stage,attempt_manifest_path:attempt.attemptPath,attempt_manifest_sha256:attempt.attemptSha256,
    summary_path:options.summaryPath,summary_sha256:sha256File(options.summaryPath),runner_exit_code:0,completed_at:now(),
  };
  createExclusive(attempt.receiptPath,receipt);
  validateDevelopmentCompletion({ options,expected:attempt.expected,attemptPath:attempt.attemptPath,attemptSha256:attempt.attemptSha256,summary,receipt });
}

async function aiInChunks(cases, context, stage) {
  if (!context.trustedEvidenceCatalog) {
    const evidence = await buildTrustedEvidenceCatalog({
      manifestPath:resolve(context.projectRoot,context.config.runtime.approved_corpus_manifest_path),
      manifestSha256:context.config.runtime.approved_corpus_manifest_sha256,
      projectRoot:context.projectRoot,
      databasePath:resolve(context.projectRoot,context.config.runtime.database_path),
      expectedCanonicalFactsSha256:context.state.canonical_facts_sha256,
      timeoutMs:context.config.runtime.service_request_timeout_ms,
      userId:"alex-morgan",
    });
    context.trustedEvidenceCatalog = evidence.catalog;
    context.trustedEvidenceDatabasePath = evidence.database_path;
  }
  const completeEvidence = mergeCaseEvidenceCatalog(cases,context.trustedEvidenceCatalog);
  cases = bindCaseEvidence(cases,completeEvidence.catalog);
  const root = join(context.runRoot, "ai-review", stage);
  const evidenceManifestPath = join(root,"trusted-evidence-catalog.json");
  const evidenceManifest = {
    version:"qualification-trusted-evidence-catalog-v1",catalog_sha256:completeEvidence.catalog_sha256,
    canonical_facts_sha256:context.state.canonical_facts_sha256,database_path:context.trustedEvidenceDatabasePath,
    records:completeEvidence.manifest,sealed_unseen_accessed:false,
  };
  if (existsSync(evidenceManifestPath)) {
    if (canonicalHash(readJson(evidenceManifestPath)) !== canonicalHash(evidenceManifest)) throw Object.assign(new Error("Stored trusted-evidence catalog identity changed."),{ code:"EVALUATOR_DEFECT" });
  } else createExclusive(evidenceManifestPath,evidenceManifest);
  const complete = join(root, "dual-review-gate.json");
  const size = Math.max(1, Number(context.config.ai_review.max_cases_per_packet || 10));
  const chunks = [];
  for (let index = 0; index < cases.length; index += size) {
    if (context.shouldStop?.()) throw Object.assign(new Error("Qualification worker interruption stopped additional AI review packets."),{ code:"WORKER_INTERRUPTED" });
    const packet = cases.slice(index, index + size);
    const outputDir = join(root, `packet-${String(index / size + 1).padStart(3, "0")}`);
    const gatePath = join(outputDir, "dual-review-gate.json");
    if (existsSync(outputDir) && !existsSync(gatePath)) {
      throw Object.assign(new Error(`Incomplete immutable AI review packet: ${outputDir}`), { code: "EVALUATOR_DEFECT" });
    }
    context.config.__candidate_id = context.state.candidate_id;
    context.config.__config_sha256 = context.state.config_sha256;
    context.config.__candidate_identity_sha256 = canonicalHash(context.state.expected_runtime_identity || {});
    context.config.__runtime_configuration_sha256 = context.state.runtime_configuration_sha256;
    context.config.__corpus_integrity_sha256 = context.state.corpus_integrity_sha256;
    context.config.__canonical_facts_sha256 = context.state.canonical_facts_sha256;
    context.config.__trusted_evidence_catalog_sha256 = completeEvidence.catalog_sha256;
    const gate = existsSync(gatePath)
      ? revalidateDualAiReview({ cases: packet, config: context.config, outputDir })
      : await runDualAiReview({ cases: packet, config: context.config, outputDir,onSpawn:context.onChildSpawn,onSettled:context.onChildSettled,shouldStop:context.shouldStop });
    chunks.push(gate);
  }
  const gate = {
    version: "dual-ai-qualification-review-batch-v1",
    generated_at: now(),
    minimum_quality_score: context.config.quality.minimum_score,
    packets: chunks.length,
    cases: chunks.flatMap((chunk) => chunk.cases || []),
    passed: chunks.length > 0 && chunks.every((chunk) => chunk.passed) && !chunks.some((chunk) => chunk.absolute_truth_claimed),
    fact_check_scope: "SUPPLIED_PINNED_EVIDENCE_AND_VISIBLE_ACCEPTANCE_CRITERIA",
    absolute_truth_claimed: chunks.some((chunk) => chunk.absolute_truth_claimed === true),
    trusted_evidence_catalog_sha256:completeEvidence.catalog_sha256,
  };
  if (existsSync(complete)) {
    const stored = readJson(complete);
    if (canonicalHash(stored.cases) !== canonicalHash(gate.cases) || stored.passed !== gate.passed || stored.packets !== gate.packets || stored.absolute_truth_claimed !== gate.absolute_truth_claimed) {
      throw Object.assign(new Error("Stored batched AI gate does not match its revalidated packets."), { code: "EVALUATOR_DEFECT" });
    }
    return stored;
  }
  createExclusive(complete, gate);
  return gate;
}

function baseEnvironment(context,stageId) {
  const capabilityKeyPath = join(context.runRoot,QUALIFICATION_CONTEXT_KEY_FILE);
  const capabilityKey = readFileSync(capabilityKeyPath,"utf8");
  const responsePublicKeyPath = join(context.runRoot,QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE);
  const responsePublicKeyPem = readFileSync(responsePublicKeyPath,"utf8");
  const processRecord = readJson(join(context.runRoot,"runtime-process.json"));
  if (!/^[0-9a-f]{64}$/.test(capabilityKey) || !responsePublicKeyPem.includes("PUBLIC KEY") || processRecord.run_id !== context.state.run_id ||
      processRecord.qualification_context_key_sha256 !== sha256File(capabilityKeyPath) || processRecord.qualification_response_public_key_sha256 !== sha256File(responsePublicKeyPath)) {
    throw Object.assign(new Error("Owned runtime qualification-context or response-signing identity is missing or changed."),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
  }
  const qualificationStageId = String(stageId || "");
  if (!/^[A-Z0-9_]{3,80}$/.test(qualificationStageId)) throw Object.assign(new Error("Qualification stage identity is missing or malformed."),{ code:"EVALUATOR_DEFECT" });
  const stageCapabilityKey = deriveQualificationStageCapabilityKey(capabilityKey,qualificationStageId);
  return {
    LOCAL_LLM_BASE_URL: context.config.runtime.model_endpoint,
    EMBEDDING_SERVICE_URL: context.config.runtime.retrieval_endpoint,
    RERANK_SERVICE_URL: context.config.runtime.retrieval_endpoint,
    LIVE_BASE_URL: context.config.runtime.canonical_endpoint,
    QUALIFICATION_CANONICAL_CHAT_ENDPOINT:context.config.runtime.canonical_endpoint,
    LOCAL_LLM_MAX_ATTEMPTS:String(context.config.runtime.model_max_attempts),
    LOCAL_LLM_RETRY_READY_TIMEOUT_MS:String(context.config.runtime.model_retry_ready_timeout_ms),
    LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS:String(context.config.runtime.model_retry_health_probe_timeout_ms),
    LOCAL_LLM_RETRY_POLL_MS:String(context.config.runtime.model_retry_poll_ms),
    LOCAL_LLM_STATUS_TIMEOUT_MS:String(context.config.runtime.model_status_timeout_ms),
    LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY: "false",
    LOCAL_LLM_TIMEOUT_MS:String(context.config.runtime.model_timeout_ms),
    LOCAL_LLM_MAX_TOKENS:String(context.config.runtime.model_max_tokens),
    LOCAL_LLM_TEMPERATURE:String(context.config.runtime.generation_temperature),
    LOCAL_LLM_TOP_P:String(context.config.runtime.generation_top_p),
    LOCAL_LLM_SEED:String(context.config.runtime.generation_seed),
    LOCAL_LLM_CONTEXT_TOKENS:String(context.config.runtime.model_context_limit_tokens),
    LLM_CONTEXT_SOURCE_LIMIT:String(context.config.runtime.context_source_limit),
    LLM_SOURCE_SNIPPET_CHARS:String(context.config.runtime.source_snippet_chars),
    EMBEDDING_TIMEOUT_MS:String(context.config.runtime.embedding_timeout_ms),
    EMBEDDING_BATCH_SIZE:String(context.config.runtime.embedding_batch_size),
    EMBEDDING_RETRIES:String(context.config.runtime.embedding_retries),
    EMBEDDING_RETRY_BACKOFF_MS:String(context.config.runtime.embedding_retry_backoff_ms),
    RERANK_TIMEOUT_MS:String(context.config.runtime.rerank_timeout_ms),
    PENSIONS_DB_PATH:resolve(context.projectRoot,context.config.runtime.database_path),
    QUALIFICATION_ATTEMPT_TELEMETRY: "true",
    QUALIFICATION_RUN_ID:context.state.run_id,
    QUALIFICATION_STAGE_ID:qualificationStageId,
    QUALIFICATION_CONTEXT_HMAC_KEY:stageCapabilityKey,
    QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM:responsePublicKeyPem,
    QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_SHA256:sha256File(responsePublicKeyPath),
    CYCLE_V2_RETRY_RUN_ERRORS: "false",
    LIVE_MAX_ATTEMPTS:String(context.config.runtime.model_max_attempts),
    LIVE_CHAT_TIMEOUT_MS:String(context.config.runtime.live_chat_timeout_ms),
    LIVE_RETRY_BACKOFF_MS:String(context.config.runtime.live_retry_backoff_ms),
    EVALUATION_HEALTH_TIMEOUT_MS:String(context.config.runtime.evaluation_health_timeout_ms),
    ALLOW_DEGRADED_EMBEDDINGS: "false",
    REQUIRE_CROSS_ENCODER_RERANK: "true",
    APPROVED_CORPUS_MANIFEST_PATH: resolve(context.projectRoot, context.config.runtime.approved_corpus_manifest_path),
    APPROVED_CORPUS_MANIFEST_SHA256: context.config.runtime.approved_corpus_manifest_sha256,
    RETRIEVAL_MIN_SCORE:String(context.config.runtime.retrieval_min_score),
    DEGRADED_RETRIEVAL_MIN_SCORE:String(context.config.runtime.degraded_retrieval_min_score),
    AUTHENTICATED_USER_ID:"alex-morgan",
    QUALIFICATION_CANONICAL_USER_ID:"alex-morgan",
    HUMAN_SUPPORT_EMAIL:"",
    CHAT_RATE_LIMIT:String(context.config.runtime.chat_rate_limit),
    TZ:context.config.runtime.timezone,
    DISABLE_DOTENV_LOAD:"true",
    QUALIFICATION_RUNTIME_MODE:"true",
    QUALIFICATION_RUNTIME_CONFIGURATION_SHA256:canonicalHash(context.config.runtime),
  };
}

function expectedEvaluationConfiguration(config) {
  return {
    model_timeout_ms:config.runtime.model_timeout_ms,
    max_tokens:config.runtime.model_max_tokens,
    max_attempts:config.runtime.model_max_attempts,
    model_retry_ready_timeout_ms:config.runtime.model_retry_ready_timeout_ms,
    model_retry_health_probe_timeout_ms:config.runtime.model_retry_health_probe_timeout_ms,
    model_retry_poll_ms:config.runtime.model_retry_poll_ms,
    model_status_timeout_ms:config.runtime.model_status_timeout_ms,
    temperature:config.runtime.generation_temperature,
    top_p:config.runtime.generation_top_p,
    seed:config.runtime.generation_seed,
    model_context_limit_tokens:config.runtime.model_context_limit_tokens,
    model_prefill_step_size:config.runtime.model_prefill_step_size,
    model_cache_limit_bytes:config.runtime.model_cache_limit_bytes,
    model_enable_thinking:config.runtime.model_enable_thinking,
    model_system_prefix_cache:config.runtime.model_system_prefix_cache,
    model_trust_remote_code:config.runtime.model_trust_remote_code,
    model_add_generation_prompt:config.runtime.model_add_generation_prompt,
    source_limit:config.runtime.context_source_limit,
    source_snippet_characters:config.runtime.source_snippet_chars,
    embedding_timeout_ms:config.runtime.embedding_timeout_ms,
    embedding_retry_backoff_ms:config.runtime.embedding_retry_backoff_ms,
    rerank_timeout_ms:config.runtime.rerank_timeout_ms,
    retrieval_min_score:config.runtime.retrieval_min_score,
    degraded_retrieval_min_score:config.runtime.degraded_retrieval_min_score,
    live_retry_backoff_ms:config.runtime.live_retry_backoff_ms,
    evaluation_health_timeout_ms:config.runtime.evaluation_health_timeout_ms,
    timezone:config.runtime.timezone,
  };
}

export function inspectReplacementV2Identity(projectRoot) {
  const root = "training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902";
  const paths = [
    `${root}/frozen-suite-manifest.json`,
    ...["wave-1","wave-2","wave-3"].flatMap((wave) => [`${root}/${wave}/development-question-set.json`,`${root}/${wave}/evaluation-gold.json`]),
    ...["questions.jsonl","gold-answers.jsonl","proposition-map.jsonl","source-map.json","competency-matrix.json","independence-audit.json","OWNER-AUTHORISATION-ID-ONLY.json","ID-REFREEZE-REPORT.json","INDEPENDENT-REFREEZE-VERIFICATION.json"].map((name) => `${root}/${name}`),
  ];
  const manifest = readJson(resolve(projectRoot,paths[0]));
  const expectedCounts = { "wave-1":52,"wave-2":68,"wave-3":41 };
  const waveCounts = {};
  const allIds = [];
  let waveParity = true;
  for (const [wave,expectedCount] of Object.entries(expectedCounts)) {
    const questions = readJson(resolve(projectRoot,`${root}/${wave}/development-question-set.json`));
    const questionIds = (questions.topics || []).flatMap((topic) => (topic.diagnostic_evaluation || []).map((item) => item.id));
    const goldIds = (readJson(resolve(projectRoot,`${root}/${wave}/evaluation-gold.json`)).items || []).map((item) => item.id);
    const uniqueQuestions = new Set(questionIds).size;
    const uniqueGold = new Set(goldIds).size;
    const parity = questionIds.length === expectedCount && goldIds.length === expectedCount && manifest.waves?.[wave] === expectedCount &&
      uniqueQuestions === expectedCount && uniqueGold === expectedCount && questionIds.every((id) => goldIds.includes(id));
    waveCounts[wave] = { rows:questionIds.length,unique_ids:uniqueQuestions,gold_rows:goldIds.length,unique_gold_ids:uniqueGold,parity };
    waveParity &&= parity;
    allIds.push(...questionIds);
  }
  const authorisation = readJson(resolve(projectRoot,`${root}/OWNER-AUTHORISATION-ID-ONLY.json`));
  const remediation = readJson(resolve(projectRoot,`${root}/ID-REFREEZE-REPORT.json`));
  const independent = readJson(resolve(projectRoot,`${root}/INDEPENDENT-REFREEZE-VERIFICATION.json`));
  const passed = waveParity && manifest.version === "topic161-replacement-v2-frozen-suite-manifest-v2"
    && manifest.state === "REPLACEMENT_QUALIFICATION_REFROZEN_ID_ONLY" && manifest.item_count === 161 && manifest.sealed_unseen_accessed === false
    && allIds.length === 161 && new Set(allIds).size === 161
    && authorisation.substantive_changes_authorised === false && authorisation.sealed_unseen_authorised === false
    && remediation.substantive_content_equal === true && independent.passed === true && independent.unique_ids === 161
    && independent.substantive_content_equal === true && independent.sealed_unseen_accessed === false
    && independent.manifest_sha256 === sha256File(resolve(projectRoot,paths[0]));
  return { passed,paths,item_count:allIds.length,unique_ids:new Set(allIds).size,waves:waveCounts,sealed_unseen_accessed:manifest.sealed_unseen_accessed };
}

export function qualificationStaticPreflight(projectRoot,config) {
  const blockers = [];
  const failureClasses = [];
  const inputRecords = [];
  try {
    const configGate = validateConfig(config);
    blockers.push(...configGate.blockers);
    for (const [path,expectedSha256] of Object.entries(config.qualification_input_sha256 || {})) {
      const absolute = assertPathAllowed(projectRoot,path,config.protected_path_patterns);
      if (!existsSync(absolute)) { blockers.push(`Pinned qualification input is missing: ${path}`); continue; }
      const actualSha256 = sha256File(absolute);
      inputRecords.push({ path,sha256:actualSha256 });
      if (actualSha256 !== expectedSha256) blockers.push(`Pinned qualification input SHA-256 mismatch: ${path}`);
    }
    const selection = readJson(resolve(projectRoot,config.candidate.checkpoint_path));
    if (selection.selected_iteration !== config.candidate.selected_iteration || selection.adapter_sha256 !== config.candidate.adapter_sha256 ||
        selection.candidates?.find((item) => item.iteration === config.candidate.forbidden_iteration)?.sha256 !== config.candidate.forbidden_adapter_sha256) {
      blockers.push("Checkpoint selection does not bind selected iteration 104 and forbidden iteration 312 exactly");
    }
    if (sha256File(resolve(projectRoot,config.candidate.adapter_path)) !== config.candidate.adapter_sha256 ||
        sha256File(resolve(projectRoot,config.candidate.base_model_path)) !== config.candidate.base_sha256 ||
        sha256File(resolve(projectRoot,config.candidate.adapter_config_path)) !== selection.adapter_config_sha256) {
      blockers.push("Candidate adapter, adapter configuration, or base-model identity mismatch");
    }
    for (const path of [config.candidate.model_config_path,config.candidate.tokenizer_path,config.candidate.tokenizer_config_path]) {
      if (!existsSync(resolve(projectRoot,path))) blockers.push(`Candidate identity file is missing: ${path}`);
    }
    verifyReviewerExecutable(config.ai_review);
    const calibrationPack = readJson(resolve(projectRoot,config.paths.review_calibration_pack));
    const deterministicCalibration = validateDeterministicReviewCalibration(calibrationPack,buildReviewCalibrationCases(calibrationPack));
    if (!deterministicCalibration.passed) {
      blockers.push("finite reviewer calibration pack failed its deterministic false-approval/false-rejection checks");
      failureClasses.push("EVALUATOR_DEFECT");
    }
    const replacement = inspectReplacementV2Identity(projectRoot);
    if (!replacement.passed) {
      blockers.push(`Frozen replacement topic161 has ${replacement.item_count} rows and ${replacement.unique_ids} unique IDs; 161 unique IDs with per-wave question/gold parity are required`);
      failureClasses.push("FROZEN_QUALIFICATION_INPUT_DEFECT");
    }
  } catch (error) {
    blockers.push(`${error.code || "PREFLIGHT_ERROR"}: ${error.message}`);
  }
  return {
    version:"qualification-static-preflight-v1",checked_at:now(),passed:blockers.length === 0,blockers,
    failure_classes:[...new Set(failureClasses)],candidate_iteration:config.candidate.selected_iteration,
    checked_qualification_inputs:inputRecords.length,reviewer_identity_checked:blockers.every((item) => !/reviewer|Codex/i.test(item)),
    sealed_unseen_accessed:false,
  };
}

async function verifyRuntimeStage(context) {
  assertNoProtectedCredentials();
  const configGate = validateConfig(context.config);
  if (!configGate.passed) return writeGate(context, "VERIFY_RUNTIME", configGate);
  const pinnedInputRecords = [];
  for (const [path, expectedSha256] of Object.entries(context.config.qualification_input_sha256 || {})) {
    assertPathAllowed(context.projectRoot, path, context.config.protected_path_patterns);
    const record = fileRecord(context.projectRoot, path);
    if (record.sha256 !== expectedSha256) return writeGate(context, "VERIFY_RUNTIME", { passed:false,blockers:[`Pinned qualification input SHA-256 mismatch: ${path}`] });
    pinnedInputRecords.push(record);
  }
  const identityPaths = [
    context.config.candidate.checkpoint_path,
    context.config.candidate.adapter_path,
    context.config.candidate.adapter_config_path,
    context.config.candidate.base_model_path,
    context.config.candidate.model_config_path,
    context.config.candidate.tokenizer_path,
    context.config.candidate.tokenizer_config_path,
    relative(context.projectRoot, resolve(context.projectRoot, context.config.candidate.checkpoint_path, "../training-run-manifest.json")),
  ];
  const visibleAssets = loadAndVerifyVisibleAssets();
  const visibleAssetPaths = [
    visibleAssets.v1.question_bank,
    visibleAssets.v1.answer_review,
    visibleAssets.v1.baseline_scorecard,
    ...Object.values(visibleAssets.waves).flatMap((wave) => [wave.question_bank, wave.evaluation_gold]),
    visibleAssets.frozen13.selection,
  ].map((record) => relative(context.projectRoot, record.path));
  const replacement = inspectReplacementV2Identity(context.projectRoot);
  const replacementPaths = replacement.paths;
  if (!replacement.passed) {
    return writeGate(context, "VERIFY_RUNTIME", {
      passed:false,
      blockers:["Pinned replacement topic161 manifest/cardinality/ID uniqueness is invalid"],
      failure_classes:["FROZEN_QUALIFICATION_INPUT_DEFECT"],
      next_owner_action:"Review the ID-only remediation proposal and independently refreeze replacement-v2; do not alter questions, gold, sources, scores, thresholds, or ordering",
    });
  }
  const dataPaths = ["config/qualification-worker.json", ...Object.keys(context.config.qualification_input_sha256 || {}), context.config.paths.live50_bank, context.config.paths.round52_baseline, context.config.paths.t4_target_ids,context.config.paths.review_calibration_pack, ...visibleAssetPaths, ...replacementPaths];
  const unpinnedQualificationInputs = dataPaths.filter((path) => path !== "config/qualification-worker.json" && !Object.hasOwn(context.config.qualification_input_sha256 || {}, path));
  if (unpinnedQualificationInputs.length) return writeGate(context, "VERIFY_RUNTIME", { passed:false,blockers:[`Qualification inputs lack authoritative hashes: ${unpinnedQualificationInputs.join(", ")}`] });
  const transitivePaths = discoverTransitiveLocalImports(context.projectRoot, EXECUTABLE_ENTRY_PATHS);
  const allPaths = [...new Set([...context.config.bound_source_paths, ...transitivePaths, ...identityPaths, ...dataPaths])].sort();
  for (const path of allPaths) assertPathAllowed(context.projectRoot, path, context.config.protected_path_patterns);
  const bindings = context.state.source_bindings || captureBindings(context.projectRoot, allPaths);
  const changed = compareBindings(context.projectRoot, bindings);
  if (changed.length) return writeGate(context, "VERIFY_RUNTIME", { passed: false, blockers: ["source bindings changed before runtime verification"], changed });
  const baselinePath = join(context.runRoot, "source-baseline.json");
  const baseline = { version:"qualification-source-baseline-v1",created_at:context.state.started_at,bindings,exact_paths_only:true,dirty_worktree_is_not_identity_evidence:true };
  if (existsSync(baselinePath)) {
    if (canonicalHash(readJson(baselinePath).bindings) !== canonicalHash(bindings)) throw Object.assign(new Error("Existing source baseline does not match current bindings."), { code:"SOURCE_IDENTITY_MISMATCH" });
  } else createExclusive(baselinePath, baseline);
  context.state.source_bindings = bindings;
  context.onSourceBaseline?.(bindings);
  const sourceBindingsSha256 = canonicalHash(bindings);
  let runtime;
  try {
    runtime = await ensureRuntime({
      projectRoot:context.projectRoot,config:context.config,runRoot:context.runRoot,
      runId:context.state.run_id,
      priorRuntimePid:context.state.runtime_supervisor_pid,onSupervisorSpawn:context.onRuntimeSpawn,
      sourceBindingsSha256,shouldStop:context.shouldStop,
    });
  } catch (error) {
    if (error.cleanup?.stopped) {
      context.state.runtime_supervisor_pid = null;
      context.state.active_endpoint = null;
    }
    const cleanupPaths = [join(context.runRoot,"runtime-process.json"),join(context.runRoot,"runtime-startup-cleanup.json"),error.cleanup?.stop_record_path].filter((path) => path && existsSync(path));
    return writeGate(context,"VERIFY_RUNTIME",{
      passed:false,blockers:[error.code || "INFRASTRUCTURE_TEMPORARY",error.message,...(error.cleanup && !error.cleanup.stopped ? ["owned runtime cleanup did not complete"] : [])],
    },{ runtime_cleanup:error.cleanup || null,artifacts:cleanupPaths.map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path))) });
  }
  const changedAfterReadiness = compareBindings(context.projectRoot, bindings);
  if (changedAfterReadiness.length) {
    let runtimeCleanup;
    try {
      runtimeCleanup = await stopOwnedRuntime({
        projectRoot:context.projectRoot,runRoot:context.runRoot,expectedPid:runtime.supervisor_pid,
        expectedRunId:context.state.run_id,config:context.config,
      });
    } catch (error) {
      runtimeCleanup = { stopped:false,code:error.code || null,error:error.message,completed_at:now() };
    }
    if (runtimeCleanup.stopped) context.state.runtime_supervisor_pid = null;
    if (runtimeCleanup.stopped) context.state.active_endpoint = null;
    const cleanupPaths = [join(context.runRoot,"runtime-process.json"),runtimeCleanup.stop_record_path].filter((path) => path && existsSync(path));
    const cleanupArtifacts = cleanupPaths.map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path)));
    return writeGate(context, "VERIFY_RUNTIME", {
      passed:false,
      blockers:["source bindings changed while runtime started",...(runtimeCleanup.stopped ? [] : ["owned runtime cleanup did not complete"])],
      changed:changedAfterReadiness,
    },{ runtime_cleanup:runtimeCleanup,artifacts:cleanupArtifacts });
  }
  context.state.runtime_supervisor_pid = runtime.supervisor_pid;
  context.state.active_endpoint = context.config.runtime.canonical_endpoint;
  context.state.expected_runtime_identity = runtime.expected_identity;
  context.state.corpus_integrity_sha256 = runtime.corpus_integrity_sha256;
  context.state.canonical_facts_sha256 = runtime.canonical_facts_sha256;
  context.state.runtime_configuration_sha256 = runtime.runtime_configuration_sha256;
  context.state.python_environment_sha256 = runtime.python_environment_sha256;
  atomicWrite(join(context.logRoot, "runtime-identity.json"), runtime);
  const corpusIntegrityPath = join(context.runRoot, "corpus-integrity.json");
  const corpusIntegrity = {
    version:"qualification-corpus-integrity-v1",
    created_at:context.state.started_at,
    source_bindings_sha256:sourceBindingsSha256,
    corpus_integrity_sha256:runtime.corpus_integrity_sha256,
    canonical_facts_sha256:runtime.canonical_facts_sha256,
    runtime_configuration_sha256:runtime.runtime_configuration_sha256,
    python_environment_sha256:runtime.python_environment_sha256,
    qualification_response_public_key_sha256:runtime.qualification_response_public_key_sha256,
    approved_corpus_readiness:runtime.runtime?.dashboard?.checks?.find((check) => check.name === "approvedCorpus") || null,
  };
  if (existsSync(corpusIntegrityPath)) {
    if (canonicalHash(readJson(corpusIntegrityPath)) !== canonicalHash(corpusIntegrity)) throw Object.assign(new Error("Immutable corpus integrity snapshot changed during resume."), { code:"SOURCE_IDENTITY_MISMATCH" });
  } else createExclusive(corpusIntegrityPath, corpusIntegrity);
  const immutableRuntimePath = join(context.runRoot, "runtime-identity.json");
  const immutableRuntime = {
    version: "qualification-runtime-identity-v1",
    endpoint: context.config.runtime.canonical_endpoint,
    model_endpoint: context.config.runtime.model_endpoint,
    retrieval_endpoint: context.config.runtime.retrieval_endpoint,
    supervisor_pid: runtime.supervisor_pid,
    source_bindings_sha256:sourceBindingsSha256,
    corpus_integrity_sha256:runtime.corpus_integrity_sha256,
    canonical_facts_sha256:runtime.canonical_facts_sha256,
    runtime_configuration_sha256:runtime.runtime_configuration_sha256,
    python_environment_sha256:runtime.python_environment_sha256,
    qualification_response_public_key_sha256:runtime.qualification_response_public_key_sha256,
    expected_identity: runtime.expected_identity,
  };
  if (existsSync(immutableRuntimePath)) {
    if (canonicalHash(readJson(immutableRuntimePath)) !== canonicalHash(immutableRuntime)) throw Object.assign(new Error("Immutable runtime identity changed during resume."), { code: "CANDIDATE_IDENTITY_MISMATCH" });
  } else createExclusive(immutableRuntimePath, immutableRuntime);
  const calibrationPack = readJson(resolve(context.projectRoot,context.config.paths.review_calibration_pack));
  const calibrationCases = buildReviewCalibrationCases(calibrationPack);
  const deterministicCalibration = validateDeterministicReviewCalibration(calibrationPack,calibrationCases);
  if (!deterministicCalibration.passed) return writeGate(context,"VERIFY_RUNTIME",{ passed:false,blockers:["EVALUATOR_DEFECT","deterministic reviewer calibration failed"] });
  let aiCalibrationGate;
  try { aiCalibrationGate = await aiInChunks(calibrationCases,context,"EVALUATOR_CALIBRATION"); }
  catch (error) { return writeGate(context,"VERIFY_RUNTIME",{ passed:false,blockers:[error.code || "AI_REVIEW_UNAVAILABLE",error.message] }); }
  const aiCalibration = validateAiReviewCalibration(calibrationPack,aiCalibrationGate);
  const calibrationResult = {
    version:"qualification-review-calibration-result-v1",completed_at:now(),passed:deterministicCalibration.passed && aiCalibration.passed,
    deterministic:deterministicCalibration,dual_ai:aiCalibration,pack_sha256:sha256File(resolve(context.projectRoot,context.config.paths.review_calibration_pack)),
    bounded_batches:1,iterative_repair:false,sealed_unseen_accessed:false,
  };
  const calibrationResultPath = join(context.runRoot,"reports","evaluator-calibration.json");
  if (existsSync(calibrationResultPath)) {
    const stored = readJson(calibrationResultPath);
    const stable = (value) => ({ ...value,completed_at:null });
    if (canonicalHash(stable(stored)) !== canonicalHash(stable(calibrationResult))) throw Object.assign(new Error("Stored evaluator calibration result changed."),{ code:"EVALUATOR_DEFECT" });
  } else createExclusive(calibrationResultPath,calibrationResult);
  if (!calibrationResult.passed) return writeGate(context,"VERIFY_RUNTIME",{
    passed:false,blockers:["EVALUATOR_DEFECT",`reviewer calibration produced ${aiCalibration.false_approvals.length} false approvals and ${aiCalibration.false_rejections.length} false rejections`,...aiCalibration.blockers],
  },{ artifacts:uniqueRecords(fileRecord(context.projectRoot,relative(context.projectRoot,calibrationResultPath)),directoryRecords(context.projectRoot,join(context.runRoot,"ai-review","EVALUATOR_CALIBRATION"))) });
  const artifacts = uniqueRecords(
    fileRecord(context.projectRoot, relative(context.projectRoot, immutableRuntimePath)),
    fileRecord(context.projectRoot, relative(context.projectRoot, baselinePath)),
    fileRecord(context.projectRoot, relative(context.projectRoot, corpusIntegrityPath)),
    existsSync(join(context.runRoot, "runtime-process.json")) ? fileRecord(context.projectRoot, relative(context.projectRoot, join(context.runRoot, "runtime-process.json"))) : null,
    existsSync(join(context.runRoot,QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE)) ? fileRecord(context.projectRoot,relative(context.projectRoot,join(context.runRoot,QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE))) : null,
    fileRecord(context.projectRoot,relative(context.projectRoot,calibrationResultPath)),
    directoryRecords(context.projectRoot,join(context.runRoot,"ai-review","EVALUATOR_CALIBRATION")),
  );
  return writeGate(context, "VERIFY_RUNTIME", { passed: true, blockers: [] }, { runtime_started: runtime.started, runtime_identity: runtime.expected_identity, source_binding_count: Object.keys(bindings).length, executable_dependency_count: transitivePaths.length, qualification_input_count:pinnedInputRecords.length,qualification_input_manifest_sha256:canonicalHash(pinnedInputRecords),artifacts });
}

function runtimeOwnerReceiptIdentity(value) {
  return {
    version:value?.version,stage:value?.stage,phase:value?.phase,run_id:value?.run_id,pid:value?.pid,
    owner_token_sha256:value?.owner_token_sha256,argv_sha256:value?.argv_sha256,
    source_bindings_sha256:value?.source_bindings_sha256,
    candidate_identity_sha256:value?.candidate_identity_sha256,
    corpus_integrity_sha256:value?.corpus_integrity_sha256,
  };
}

function persistRuntimeOwnerReceipt(context,stage,phase,before,after) {
  const root = join(context.runRoot,"runtime-owner-revalidation");
  mkdirSync(root,{ recursive:true });
  const path = join(root,`${stage}-${phase}.json`);
  const receipt = {
    version:"qualification-stage-live-runtime-owner-v1",stage,phase,verified_at:now(),run_id:context.state.run_id,
    pid:after.pid,owner_token_sha256:after.owner_token_sha256,argv_sha256:after.argv_sha256,
    source_bindings_sha256:after.source_bindings_sha256,
    candidate_identity_sha256:canonicalHash(context.state.expected_runtime_identity || {}),
    corpus_integrity_sha256:context.state.corpus_integrity_sha256,
    before_observation_sha256:before.observation_sha256,
    after_observation_sha256:after.observation_sha256,
    sealed_unseen_accessed:false,
  };
  if (existsSync(path)) {
    if (canonicalHash(runtimeOwnerReceiptIdentity(readJson(path))) !== canonicalHash(runtimeOwnerReceiptIdentity(receipt))) {
      throw Object.assign(new Error(`Stored runtime-owner receipt changed for ${stage}/${phase}.`),{ code:"RUNTIME_OWNERSHIP_MISMATCH" });
    }
  } else createExclusive(path,receipt);
  if (!context.runtimeOwnerArtifacts) context.runtimeOwnerArtifacts = new Map();
  const paths = context.runtimeOwnerArtifacts.get(stage) || [];
  if (!paths.includes(path)) context.runtimeOwnerArtifacts.set(stage,[...paths,path]);
  return path;
}

async function verifyRuntimeAndOwner(context,stage,phase) {
  if (context.shouldStop?.()) throw Object.assign(new Error("Qualification worker interruption prevented runtime revalidation."),{ code:"WORKER_INTERRUPTED" });
  const sourceBindingsSha256 = canonicalHash(context.state.source_bindings || {});
  const ownerOptions = {
    projectRoot:context.projectRoot,runRoot:context.runRoot,expectedPid:context.state.runtime_supervisor_pid,
    expectedRunId:context.state.run_id,config:context.config,sourceBindingsSha256,
  };
  const before = verifyOwnedRuntimeProcess(ownerOptions);
  if (context.shouldStop?.()) throw Object.assign(new Error("Qualification worker interruption stopped runtime endpoint revalidation."),{ code:"WORKER_INTERRUPTED" });
  const runtime = await verifyRuntimeStillBound(context.config, context.state.expected_runtime_identity,sourceBindingsSha256,
    context.state.corpus_integrity_sha256,context.state.canonical_facts_sha256,context.state.python_environment_sha256,context.state.runtime_configuration_sha256,
    context.state.run_id,readJson(join(context.runRoot,"runtime-process.json")).qualification_context_key_sha256);
  if (context.shouldStop?.()) throw Object.assign(new Error("Qualification worker interruption followed runtime endpoint revalidation."),{ code:"WORKER_INTERRUPTED" });
  const after = verifyOwnedRuntimeProcess(ownerOptions);
  persistRuntimeOwnerReceipt(context,stage,phase,before,after);
  return runtime;
}

async function assertRuntimeAndSource(context, stage) {
  assertPathAllowed(context.projectRoot, relative(context.projectRoot, context.runRoot), context.config.protected_path_patterns);
  assertPathAllowed(context.projectRoot, context.config.paths.visible_output_parent, context.config.protected_path_patterns);
  const changed = compareBindings(context.projectRoot, context.state.source_bindings);
  if (changed.length) return sourceMismatchGate(context,stage,changed,"before runtime revalidation");
  try {
    await verifyRuntimeAndOwner(context,stage,"initial");
  } catch (error) {
    return runtimeMismatchGate(context,stage,error);
  }
  const changedAfterRuntimeCheck = compareBindings(context.projectRoot,context.state.source_bindings);
  if (changedAfterRuntimeCheck.length) return sourceMismatchGate(context,stage,changedAfterRuntimeCheck,"during runtime revalidation");
  return null;
}

async function assertRuntimeAndSourceAtCompletion(context,stage) {
  const changed = compareBindings(context.projectRoot,context.state.source_bindings || {});
  if (changed.length) return sourceMismatchGate(context,stage,changed,"before stage-completion runtime revalidation");
  try {
    await verifyRuntimeAndOwner(context,stage,"completion");
  } catch (error) {
    return runtimeMismatchGate(context,stage,error);
  }
  const changedAfter = compareBindings(context.projectRoot,context.state.source_bindings || {});
  if (changedAfter.length) return sourceMismatchGate(context,stage,changedAfter,"during stage-completion runtime revalidation");
  return null;
}

async function stopRuntimeForGate(context) {
  let runtimeCleanup;
  try {
    runtimeCleanup = await stopOwnedRuntime({
      projectRoot:context.projectRoot,runRoot:context.runRoot,expectedPid:context.state.runtime_supervisor_pid,
      expectedRunId:context.state.run_id,config:context.config,
    });
  } catch (error) {
    runtimeCleanup = { stopped:false,code:error.code || null,error:error.message,completed_at:now() };
  }
  if (runtimeCleanup.stopped) {
    const keyCleanup = removeQualificationContextKey(context.runRoot);
    runtimeCleanup = { ...runtimeCleanup,qualification_context_key_cleanup:keyCleanup,stopped:keyCleanup.removed === true };
  }
  if (runtimeCleanup.stopped) context.state.runtime_supervisor_pid = null;
  if (runtimeCleanup.stopped) context.state.active_endpoint = null;
  return runtimeCleanup;
}

async function runtimeMismatchGate(context,stage,error,extraArtifacts = []) {
  const runtimeCleanup = await stopRuntimeForGate(context);
  const cleanupPaths = [join(context.runRoot,"runtime-process.json"),runtimeCleanup.stop_record_path].filter((path) => path && existsSync(path));
  return writeGate(context,stage,{
    passed:false,blockers:[error.code || "CANDIDATE_IDENTITY_MISMATCH",error.message,...(runtimeCleanup.stopped ? [] : ["owned runtime cleanup did not complete"])],
  },{
    runtime_cleanup:runtimeCleanup,
    artifacts:uniqueRecords(extraArtifacts,cleanupPaths.map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path)))),
  });
}

async function sourceMismatchGate(context,stage,changed,phase,extraArtifacts = []) {
  const runtimeCleanup = await stopRuntimeForGate(context);
  const cleanupPaths = [join(context.runRoot,"runtime-process.json"),runtimeCleanup.stop_record_path].filter((path) => path && existsSync(path));
  return writeGate(context,stage,{
    passed:false,blockers:["SOURCE_IDENTITY_MISMATCH",...(runtimeCleanup.stopped ? [] : ["owned runtime cleanup did not complete"])],changed,
  },{
    source_change_phase:phase,runtime_cleanup:runtimeCleanup,
    artifacts:uniqueRecords(extraArtifacts,cleanupPaths.map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path)))),
  });
}

async function t4Targeted(context) {
  const rejected = await assertRuntimeAndSource(context, "T4_TARGETED_REGRESSION");
  if (rejected) return rejected;
  const out = join(context.runRoot, "development-results", "t4-targeted");
  const summaryPath = join(out, "t4-targeted-summary.json");
  const labelPrefix = `${context.state.run_id}-t4`;
  const attemptOptions = { stage:"T4_TARGETED_REGRESSION",runnerStage:"t4-targeted",out,summaryPath,labelPrefix };
  let attempt;
  try { attempt = prepareDevelopmentAttempt(context,attemptOptions); }
  catch (error) { return writeGate(context,"T4_TARGETED_REGRESSION",{ passed:false,blockers:[error.code || "EVALUATOR_DEFECT",error.message] }); }
  let execution = { code: 0, resumed_from_artifact: true };
  if (!attempt.resumed) {
    execution = await runChild({
      projectRoot: context.projectRoot, config: context.config, command: process.execPath,
      args: [resolve(context.projectRoot, "scripts/t4PostTrainingDevelopmentEval.mjs")],
      env: { ...baseEnvironment(context,"T4_TARGETED_REGRESSION"), T4_DEV_OUT: out, T4_DEV_STAGE: "t4-targeted", T4_DEV_IDS: resolve(context.projectRoot, context.config.paths.t4_target_ids), T4_DEV_LABEL_PREFIX: labelPrefix, QUALIFICATION_ATTEMPT_MANIFEST:attempt.attemptPath,QUALIFICATION_ATTEMPT_MANIFEST_SHA256:attempt.attemptSha256 },
      logPath: join(out, "execution.log"), onSpawn: context.onChildSpawn,onSettled:context.onChildSettled,shouldStop:context.shouldStop,
    });
  }
  if (!existsSync(summaryPath)) return writeGate(context, "T4_TARGETED_REGRESSION", { passed: false, blockers: [`T4 runner did not produce its gate artifact (exit ${execution.code ?? execution.error})`] });
  if (!attempt.resumed) {
    try { completeDevelopmentAttempt(attempt,attemptOptions,execution); }
    catch (error) { return writeGate(context,"T4_TARGETED_REGRESSION",{ passed:false,blockers:[error.code || "EVALUATOR_DEFECT",error.message] },{ artifacts:directoryRecords(context.projectRoot,out) }); }
  }
  const summary = readJson(summaryPath);
  const expected = readJson(resolve(context.projectRoot, context.config.paths.t4_target_ids));
  const deterministic = validateT4Summary(summary, expected, context.config.candidate);
  if (canonicalHash(summary.evaluation_configuration) !== canonicalHash(expectedEvaluationConfiguration(context.config))) {
    deterministic.passed = false;
    deterministic.blockers.push("T4 summary is not bound to the canonical evaluation configuration");
  }
  const cases = developmentCases(context, summary);
  const expectedIds = Object.values(expected.ids_by_wave || {}).flat();
  const attempts = validateCaseAttemptLedgers(cases, context.state.expected_runtime_identity);
  const capabilities = auditConsumedCapabilities({ runRoot:context.runRoot,stage:"T4_TARGETED_REGRESSION",cases });
  let aiGate = null;
  if (deterministic.passed && attempts.passed && capabilities.passed) {
    try { aiGate = await aiInChunks(cases, context, "T4_TARGETED_REGRESSION"); }
    catch (error) { return writeGate(context, "T4_TARGETED_REGRESSION", { passed: false, blockers: [error.code || "AI_REVIEW_UNAVAILABLE", error.message] }, { artifacts: evaluationSummaryRecords(context, out, summary) }); }
  }
  const aiValidation = aiGate ? validateAiGate(aiGate, context.config.quality, expectedIds) : { passed:false,blockers:["dual AI review was not run because deterministic or attempt-ledger checks failed"] };
  const gate = { passed:deterministic.passed && attempts.passed && capabilities.passed && aiValidation.passed,blockers:[...deterministic.blockers,...attempts.blockers,...capabilities.blockers,...aiValidation.blockers],failure_classes:aiValidation.failure_classes || [],confirmed_failure_classes:aiValidation.confirmed_failure_classes || [],counts:{ ...deterministic.counts,...capabilities.counts,ai_pass:aiGate?.cases?.filter((item) => item.passed).length || 0 },absolute_truth_claimed:Boolean(aiValidation.absolute_truth_claimed) };
  if (gate.passed) {
    const completionRejected = await assertRuntimeAndSourceAtCompletion(context,"T4_TARGETED_REGRESSION");
    if (completionRejected) return completionRejected;
  }
  const artifacts = uniqueRecords(evaluationSummaryRecords(context, out, summary), aiGate ? directoryRecords(context.projectRoot, join(context.runRoot, "ai-review", "T4_TARGETED_REGRESSION")) : []);
  return writeGate(context, "T4_TARGETED_REGRESSION", gate, { runner_exit_code: execution.code, summary_path: summaryPath, summary_sha256: sha256File(summaryPath), artifacts });
}

async function topic161(context) {
  const rejected = await assertRuntimeAndSource(context, "TOPIC161_ORIGINAL_DEVELOPMENT");
  if (rejected) return rejected;
  const out = join(context.runRoot, "development-results", "topic161-original");
  const summaryPath = join(out, "topic161-original-summary.json");
  const labelPrefix = `${context.state.run_id}-topic161`;
  const attemptOptions = { stage:"TOPIC161_ORIGINAL_DEVELOPMENT",runnerStage:"topic161-original",out,summaryPath,labelPrefix };
  let attempt;
  try { attempt = prepareDevelopmentAttempt(context,attemptOptions); }
  catch (error) { return writeGate(context,"TOPIC161_ORIGINAL_DEVELOPMENT",{ passed:false,blockers:[error.code || "EVALUATOR_DEFECT",error.message] }); }
  let execution = { code: 0, resumed_from_artifact: true };
  if (!attempt.resumed) {
    execution = await runChild({
      projectRoot: context.projectRoot, config: context.config, command: process.execPath,
      args: [resolve(context.projectRoot, "scripts/t4PostTrainingDevelopmentEval.mjs")],
      env: { ...baseEnvironment(context,"TOPIC161_ORIGINAL_DEVELOPMENT"), T4_DEV_OUT: out, T4_DEV_STAGE: "topic161-original", T4_DEV_IDS: resolve(context.projectRoot, context.config.paths.t4_target_ids), T4_DEV_LABEL_PREFIX: labelPrefix, QUALIFICATION_ATTEMPT_MANIFEST:attempt.attemptPath,QUALIFICATION_ATTEMPT_MANIFEST_SHA256:attempt.attemptSha256 },
      logPath: join(out, "execution.log"), onSpawn: context.onChildSpawn,onSettled:context.onChildSettled,shouldStop:context.shouldStop,
    });
  }
  if (!existsSync(summaryPath)) return writeGate(context, "TOPIC161_ORIGINAL_DEVELOPMENT", { passed: false, blockers: [`topic161 runner did not produce its gate artifact (exit ${execution.code ?? execution.error})`] });
  if (!attempt.resumed) {
    try { completeDevelopmentAttempt(attempt,attemptOptions,execution); }
    catch (error) { return writeGate(context,"TOPIC161_ORIGINAL_DEVELOPMENT",{ passed:false,blockers:[error.code || "EVALUATOR_DEFECT",error.message] },{ artifacts:directoryRecords(context.projectRoot,out) }); }
  }
  const summary = readJson(summaryPath);
  const assets = loadAndVerifyVisibleAssets();
  const expectedIdsByWave = Object.fromEntries(Object.entries(assets.waves).map(([wave, value]) => [wave, value.ids]));
  const expectedTopicById = Object.assign({},...Object.values(assets.waves).map((value) => value.topic_by_id));
  const deterministic = validateTopic161Summary(summary, expectedIdsByWave, context.config.candidate,expectedTopicById);
  if (canonicalHash(summary.evaluation_configuration) !== canonicalHash(expectedEvaluationConfiguration(context.config))) {
    deterministic.passed = false;
    deterministic.blockers.push("topic161 summary is not bound to the canonical evaluation configuration");
  }
  const cases = developmentCases(context, summary);
  const expectedIds = Object.values(expectedIdsByWave).flat();
  const attempts = validateCaseAttemptLedgers(cases, context.state.expected_runtime_identity);
  const capabilities = auditConsumedCapabilities({ runRoot:context.runRoot,stage:"TOPIC161_ORIGINAL_DEVELOPMENT",cases });
  let aiGate = null;
  if (deterministic.passed && attempts.passed && capabilities.passed) {
    try { aiGate = await aiInChunks(cases, context, "TOPIC161_ORIGINAL_DEVELOPMENT"); }
    catch (error) { return writeGate(context, "TOPIC161_ORIGINAL_DEVELOPMENT", { passed: false, blockers: [error.code || "AI_REVIEW_UNAVAILABLE", error.message] }, { artifacts: evaluationSummaryRecords(context, out, summary) }); }
  }
  const aiValidation = aiGate ? validateAiGate(aiGate, context.config.quality, expectedIds) : { passed:false,blockers:["dual AI review was not run because deterministic or attempt-ledger checks failed"] };
  const gate = { passed:deterministic.passed && attempts.passed && capabilities.passed && aiValidation.passed,blockers:[...deterministic.blockers,...attempts.blockers,...capabilities.blockers,...aiValidation.blockers],failure_classes:aiValidation.failure_classes || [],confirmed_failure_classes:aiValidation.confirmed_failure_classes || [],counts:{ ...deterministic.counts,...capabilities.counts,ai_pass:aiGate?.cases?.filter((item) => item.passed).length || 0 },absolute_truth_claimed:Boolean(aiValidation.absolute_truth_claimed) };
  if (gate.passed) {
    const completionRejected = await assertRuntimeAndSourceAtCompletion(context,"TOPIC161_ORIGINAL_DEVELOPMENT");
    if (completionRejected) return completionRejected;
  }
  const artifacts = uniqueRecords(evaluationSummaryRecords(context, out, summary), aiGate ? directoryRecords(context.projectRoot, join(context.runRoot, "ai-review", "TOPIC161_ORIGINAL_DEVELOPMENT")) : []);
  return writeGate(context, "TOPIC161_ORIGINAL_DEVELOPMENT", gate, { runner_exit_code: execution.code, summary_path: summaryPath, summary_sha256: sha256File(summaryPath), role: "DEVELOPMENT_REGRESSION_CONSUMED", artifacts });
}

function expectedLiveSet(projectRoot) {
  const sets = readJson(resolve(projectRoot, "Log/sets.json"));
  return `live-round-${sets.next_set_number}`;
}

async function live50(context) {
  const rejected = await assertRuntimeAndSource(context, "LIVE50_FULL_REGRESSION");
  if (rejected) return rejected;
  const liveRoot = join(context.runRoot, "development-results", "live50");
  const metaPath = join(liveRoot, "run-meta.json");
  const outputDir = join(liveRoot, "run");
  const bankPath = resolve(context.projectRoot, context.config.paths.live50_bank);
  const proposedMeta = {
    version: "qualification-live50-run-v1",
    run_id: context.state.run_id,
    set_name: expectedLiveSet(context.projectRoot),
    output_dir: outputDir,
    bank_path: bankPath,
    bank_sha256: sha256File(bankPath),
    endpoint: context.config.runtime.canonical_endpoint,
    model: context.state.expected_runtime_identity.id,
    user: "alex-morgan",
    started_at: now(),
  };
  const existingMeta = readIf(metaPath);
  const meta = existingMeta || proposedMeta;
  const expectedMetaIdentity = {
    version:proposedMeta.version,run_id:proposedMeta.run_id,output_dir:proposedMeta.output_dir,
    bank_path:proposedMeta.bank_path,bank_sha256:proposedMeta.bank_sha256,endpoint:proposedMeta.endpoint,
    model:proposedMeta.model,user:proposedMeta.user,
  };
  const actualMetaIdentity = Object.fromEntries(Object.keys(expectedMetaIdentity).map((key) => [key, meta[key]]));
  if (existingMeta && (canonicalHash(actualMetaIdentity) !== canonicalHash(expectedMetaIdentity) || !/^live-round-\d+$/.test(meta.set_name || ""))) {
    return writeGate(context, "LIVE50_FULL_REGRESSION", { passed: false, blockers: ["Live-50 immutable run metadata mismatch"] });
  }
  if (!existsSync(metaPath)) createExclusive(metaPath, meta);
  const resultPath = join(outputDir, "results.json");
  const ledgerPath = join(outputDir, "attempt-ledger.jsonl");
  const executionLogPath = join(liveRoot,"execution.log");
  const receiptPath = join(liveRoot,"execution-receipt.json");
  const command = process.execPath;
  const commandArgs = [resolve(context.projectRoot, "scripts/runLiveQuestionSet.mjs"), "--questions", resolve(context.projectRoot, context.config.paths.live50_bank)];
  const receiptInputs = { run_metadata_sha256:sha256File(metaPath),output_directory:outputDir };
  let execution;
  const existing = readIf(resultPath);
  if (existsSync(receiptPath)) {
    try {
      const receipt = validateExecutionReceipt({ context,receiptPath,stage:"LIVE50_FULL_REGRESSION",command,args:commandArgs,extraInputs:receiptInputs });
      execution = { ...receipt.execution,resumed_from_artifact:true };
    } catch (error) {
      return writeGate(context,"LIVE50_FULL_REGRESSION",{ passed:false,blockers:[error.code || "EVALUATOR_DEFECT",error.message] },{ artifacts:directoryRecords(context.projectRoot,liveRoot) });
    }
  } else {
    if (existing || existsSync(ledgerPath) || existsSync(executionLogPath)) {
      return writeGate(context,"LIVE50_FULL_REGRESSION",{ passed:false,blockers:["EVALUATOR_DEFECT","Live-50 output exists without an immutable clean-exit receipt"] },{ artifacts:directoryRecords(context.projectRoot,liveRoot) });
    }
    execution = await runChild({
      projectRoot: context.projectRoot, config: context.config, command,
      args: commandArgs,
      env: {
        ...baseEnvironment(context,"LIVE50_FULL_REGRESSION"), LIVE_EXPECTED_SET: meta.set_name, LIVE_MODEL: meta.model,
        LIVE_USER_ID: meta.user, LIVE_OUTPUT_DIR: outputDir, LIVE_RUN_ID: context.state.run_id,
      },
      logPath: executionLogPath, onSpawn: context.onChildSpawn,onSettled:context.onChildSettled,shouldStop:context.shouldStop,
    });
    const receiptArtifacts = uniqueRecords(
      existsSync(outputDir) ? directoryRecords(context.projectRoot,outputDir) : [],
      existsSync(executionLogPath) ? fileRecord(context.projectRoot,relative(context.projectRoot,executionLogPath)) : null,
    );
    createExecutionReceipt({ context,receiptPath,stage:"LIVE50_FULL_REGRESSION",command,args:commandArgs,execution,artifacts:receiptArtifacts,extraInputs:receiptInputs });
  }
  if (!cleanExecution(execution)) {
    return writeGate(context,"LIVE50_FULL_REGRESSION",{ passed:false,blockers:[execution.error || `Live-50 runner exited with ${execution.signal || execution.code}`] },{ runner_execution:execution,artifacts:directoryRecords(context.projectRoot,liveRoot) });
  }
  if (!existsSync(resultPath)) return writeGate(context, "LIVE50_FULL_REGRESSION", { passed: false, blockers: [`Live-50 runner did not produce results (exit ${execution.code ?? execution.error})`] });
  const bank = readJson(bankPath);
  const results = readJson(resultPath);
  const expectedBinding = { run_id:context.state.run_id,bank_path:bankPath,bank_sha256:meta.bank_sha256,endpoint:meta.endpoint,model:meta.model,user:meta.user,set_name:meta.set_name,total:50 };
  const requestIds = (results.items || []).map((item) => item.client_request_id);
  const logicalRequestIds = (results.items || []).map((item) => item.logical_request_id);
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const ledgerStarts = new Map();
  for (const event of ledger) if (event.event === "ATTEMPT_STARTED") ledgerStarts.set(event.case_id, (ledgerStarts.get(event.case_id) || 0) + 1);
  const ledgerStartEvents = ledger.filter((event) => event.event === "ATTEMPT_STARTED");
  const ledgerFinishedEvents = ledger.filter((event) => event.event === "REQUEST_FINISHED");
  const ledgerResults = ledger.filter((event) => event.event === "RESULT_COMMITTED");
  const modelRuntimeBound = (results.items || []).filter((item) => item.model_call_attempted).every((item) =>
    Object.entries(context.state.expected_runtime_identity || {}).every(([key, value]) => value == null || item.runtime_identity?.[key] === value));
  const ledgerBound = ledger.length > 0 && ledger.every((event) => event.run_id === context.state.run_id && event.set_name === meta.set_name) &&
    ledgerResults.length === 50 && new Set(ledgerResults.map((event) => event.case_id)).size === 50 &&
    new Set(ledgerStartEvents.map((event) => event.client_request_id)).size === ledgerStartEvents.length &&
    (results.items || []).every((item) => {
      const starts = ledgerStartEvents.filter((event) => event.case_id === item.id);
      const finishes = ledgerFinishedEvents.filter((event) => event.case_id === item.id);
      const commit = ledgerResults.find((event) => event.case_id === item.id);
      const finalRequest = item.request_attempt_ledger?.[item.request_attempt_ledger.length - 1];
      const combinedGeneration = combineGenerationTelemetry((item.request_attempt_ledger || []).filter((attempt) => attempt.data?.qualification_attempts?.model_call_attempted).map((attempt) => ({
        request_retry_reason:attempt.retry_reason,telemetry:attempt.data.qualification_attempts,
      })));
      return ledgerStarts.get(item.id) === Number(item.request_attempts) && ledgerStarts.get(item.id) <= 2 &&
        starts.every((event, index) => event.attempt === index + 1 && event.logical_request_id === item.logical_request_id && event.client_request_id === `${item.logical_request_id}-attempt-${event.attempt}`) &&
        finishes.length === starts.length && finishes.every((event,index) => event.attempt === starts[index].attempt && event.client_request_id === starts[index].client_request_id && canonicalHash(event.request_record) === canonicalHash(item.request_attempt_ledger?.[index])) &&
        commit?.logical_request_id === item.logical_request_id && commit?.client_request_id === item.client_request_id && canonicalHash(commit?.record) === canonicalHash(item) &&
        finalRequest?.client_request_id === item.client_request_id && finalRequest?.canonical_response_valid === true &&
        canonicalHash(finalRequest?.served_response_receipt) === canonicalHash(item.served_response_receipt) &&
        Number(item.generation_attempts || 0) === combinedGeneration.attempts && canonicalHash(item.generation_attempt_ledger || []) === canonicalHash(combinedGeneration.events) &&
        Boolean(item.generation_retry_used) === combinedGeneration.retryUsed && (item.generation_retry_reason || null) === combinedGeneration.retryReason &&
        Boolean(item.recovered_from_truncation) === combinedGeneration.recoveredFromTruncation;
    });
  if (canonicalHash(results.run_binding) !== canonicalHash(expectedBinding) || results.items?.length !== 50 ||
      requestIds.some((id) => !id) || logicalRequestIds.some((id) => !id) || new Set(logicalRequestIds).size !== 50 || !ledgerBound || !modelRuntimeBound) {
    return writeGate(context, "LIVE50_FULL_REGRESSION", { passed: false, blockers: ["Live-50 result is not bound to this exact run, bank, endpoint, model, user and 50 unique requests"] }, { artifacts: directoryRecords(context.projectRoot, liveRoot) });
  }
  const liveReceiptEnvironment = baseEnvironment(context,"LIVE50_FULL_REGRESSION");
  const receiptVerifications = (results.items || []).flatMap((item) => (item.request_attempt_ledger || []).filter((attempt) => attempt.outcome === "RESPONSE").map((attempt) => {
    const data = attempt.data || {};
    const answer = typeof data.response === "string" ? data.response : "";
    const projected = {
      id:item.id,question:item.question,answer,actual_route:data.response_route || null,
      selected_jurisdiction:data.jurisdiction_scope || "UNSPECIFIED",
      final_public_sources:Array.isArray(data.sources) ? data.sources : [],
      generated_citations:(data.sources || []).map((source) => String(source.source_id || source.sourceId || "")).filter(Boolean),
      review_answer:data.review_answer || answer,claim_citations:Array.isArray(data.claim_citations) ? data.claim_citations : [],
      runtime_identity:data.runtime_identity || null,model_call_attempted:Boolean(data.qualification_attempts?.model_call_attempted),
      generation_attempts:Number(data.qualification_attempts?.generation_attempts || 0),retry_used:Boolean(data.qualification_attempts?.retry_used),
      retry_reason:data.qualification_attempts?.retry_reason || null,generation_attempt_ledger:data.qualification_attempts?.generation_attempt_ledger || [],
      recovered_from_truncation:Boolean(data.qualification_attempts?.recovered_from_truncation),
      qualification_context_applied:false,qualification_context_sha256:null,
      qualification_capability_payload_sha256:data.qualification_capability_payload_sha256 || null,
      qualification_capability_nonce:data.qualification_capability_nonce || null,
      served_response_receipt:attempt.served_response_receipt,served_response_sha256:sha256Buffer(answer),
      served_via_canonical_chat:true,response_route_source:"CANONICAL_HTTP_CHAT_RESPONSE",
    };
    return { id:item.id,attempt:attempt.request_attempt,...verifyServedResponseReceipt(projected,{
      outputRoot:outputDir,publicKeyPem:liveReceiptEnvironment.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM,
      runId:context.state.run_id,stageId:"LIVE50_FULL_REGRESSION",
    }) };
  }));
  const finalReceiptVerifications = (results.items || []).map((item) => ({ id:item.id,attempt:"final",...verifyServedResponseReceipt(item,{
    outputRoot:outputDir,publicKeyPem:liveReceiptEnvironment.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM,
    runId:context.state.run_id,stageId:"LIVE50_FULL_REGRESSION",skipGenerationTelemetry:true,
  }) }));
  const receiptFailures = [...receiptVerifications,...finalReceiptVerifications].filter((item) => !item.passed);
  if (receiptFailures.length) {
    return writeGate(context,"LIVE50_FULL_REGRESSION",{ passed:false,blockers:receiptFailures.map((item) => `${item.id} attempt ${item.attempt}: ${item.failures.join("; ")}`) },{ artifacts:directoryRecords(context.projectRoot,liveRoot) });
  }
  const verifiedResults = { ...results,items:(results.items || []).map((item) => ({
    ...item,served_response_verified:(item.request_attempt_ledger || []).filter((attempt) => attempt.outcome === "RESPONSE").length > 0 &&
      (item.request_attempt_ledger || []).filter((attempt) => attempt.outcome === "RESPONSE").every((attempt) => receiptVerifications.some((record) => record.id === item.id && record.attempt === attempt.request_attempt && record.passed)),
      ...(finalReceiptVerifications.find((record) => record.id === item.id)?.passed !== true ? { served_response_verified:false } : {}),
  })) };
  const cases = prepareLive50Cases(bank, verifiedResults);
  const attemptValidation = validateCaseAttemptLedgers(cases, context.state.expected_runtime_identity);
  const capabilities = auditConsumedCapabilities({ runRoot:context.runRoot,stage:"LIVE50_FULL_REGRESSION",cases });
  if (!attemptValidation.passed || !capabilities.passed) {
    return writeGate(context, "LIVE50_FULL_REGRESSION", { passed:false,blockers:[...attemptValidation.blockers,...capabilities.blockers] }, { artifacts:directoryRecords(context.projectRoot, liveRoot) });
  }
  const factPacket = join(liveRoot, "fact-check-packet.json");
  if (!existsSync(factPacket)) createExclusive(factPacket, { cases, absolute_truth_claimed: false });
  else if (canonicalHash(readJson(factPacket).cases) !== canonicalHash(cases)) return writeGate(context, "LIVE50_FULL_REGRESSION", { passed: false, blockers: ["Immutable Live-50 fact-check packet changed"] });
  let aiGate;
  try { aiGate = await aiInChunks(cases, context, "LIVE50_FULL_REGRESSION"); }
  catch (error) { return writeGate(context, "LIVE50_FULL_REGRESSION", { passed: false, blockers: [error.code || "AI_REVIEW_UNAVAILABLE", error.message] }, { results_path: resultPath }); }
  const baseline = readJson(resolve(context.projectRoot, context.config.paths.round52_baseline));
  const gate = validateLive50({ cases, aiGate, baseline });
  if (gate.passed) {
    const completionRejected = await assertRuntimeAndSourceAtCompletion(context,"LIVE50_FULL_REGRESSION");
    if (completionRejected) return completionRejected;
  }
  const artifacts = uniqueRecords(directoryRecords(context.projectRoot, liveRoot), directoryRecords(context.projectRoot, join(context.runRoot, "ai-review", "LIVE50_FULL_REGRESSION")));
  return writeGate(context, "LIVE50_FULL_REGRESSION", gate, { runner_exit_code: execution.code, set_name: meta.set_name, results_path: resultPath, results_sha256: sha256File(resultPath), ai_review_path: join(context.runRoot, "ai-review", "LIVE50_FULL_REGRESSION", "dual-review-gate.json"), artifacts });
}

async function reliability(context) {
  const rejected = await assertRuntimeAndSource(context, "RELIABILITY_GATE");
  if (rejected) return rejected;
  const t4 = readJson(join(context.runRoot, "development-results", "t4-targeted", "t4-targeted-summary.json"));
  const topic = readJson(join(context.runRoot, "development-results", "topic161-original", "topic161-original-summary.json"));
  const meta = readJson(join(context.runRoot, "development-results", "live50", "run-meta.json"));
  const livePath = join(meta.output_dir, "results.json");
  const reliabilityRoot = join(context.runRoot,"development-results","reliability");
  mkdirSync(reliabilityRoot,{ recursive:true });
  const outagePath = join(reliabilityRoot,"owned-model-outage.json");
  const activePath = join(reliabilityRoot,"active-live-journeys.json");
  let outage;
  let active;
  try {
    outage = existsSync(outagePath) ? readJson(outagePath) : await interruptOwnedModelWorkerAndWait({
      projectRoot:context.projectRoot,runRoot:context.runRoot,expectedPid:context.state.runtime_supervisor_pid,
      expectedRunId:context.state.run_id,config:context.config,sourceBindingsSha256:canonicalHash(context.state.source_bindings || {}),
      expectedIdentity:context.state.expected_runtime_identity,
    });
    if (!existsSync(outagePath)) createExclusive(outagePath,outage);
    active = existsSync(activePath) ? readJson(activePath) : await runActiveReliabilityJourneys({
      endpoint:context.config.runtime.canonical_endpoint,modelEndpoint:context.config.runtime.model_endpoint,
      runId:context.state.run_id,
      secret:deriveQualificationStageCapabilityKey(
        readFileSync(join(context.runRoot,QUALIFICATION_CONTEXT_KEY_FILE),"utf8"),
        "RELIABILITY_GATE",
      ),
      publicKeyPem:readFileSync(join(context.runRoot,QUALIFICATION_RESPONSE_PUBLIC_KEY_FILE),"utf8"),
      modelReadyTimeoutMs:context.config.runtime.model_ready_timeout_ms,pollMs:context.config.runtime.model_retry_poll_ms,
      limits:context.config.reliability,
    });
    if (!existsSync(activePath)) createExclusive(activePath,active);
  } catch (error) {
    return writeGate(context,"RELIABILITY_GATE",{ passed:false,blockers:[error.code || "INFRASTRUCTURE_TEMPORARY",error.message] },{
      artifacts:existsSync(reliabilityRoot) ? directoryRecords(context.projectRoot,reliabilityRoot) : [],
    });
  }
  const gate = validateReliability({ t4Summary: t4, topicSummary: topic, liveResults: readJson(livePath),active,outage });
  if (gate.passed) {
    const completionRejected = await assertRuntimeAndSourceAtCompletion(context,"RELIABILITY_GATE");
    if (completionRejected) return completionRejected;
  }
  const artifacts = uniqueRecords(
    fileRecord(context.projectRoot, relative(context.projectRoot, join(context.runRoot, "development-results", "t4-targeted", "t4-targeted-summary.json"))),
    fileRecord(context.projectRoot, relative(context.projectRoot, join(context.runRoot, "development-results", "topic161-original", "topic161-original-summary.json"))),
    fileRecord(context.projectRoot, relative(context.projectRoot, livePath)),
    fileRecord(context.projectRoot, relative(context.projectRoot, outagePath)),
    fileRecord(context.projectRoot, relative(context.projectRoot, activePath)),
  );
  return writeGate(context, "RELIABILITY_GATE", gate, { artifacts });
}

function visibleContext(context) {
  const label = context.state.visible_run_label || `${context.state.run_id}-visible`;
  context.state.visible_run_label = label;
  const parent = resolve(context.projectRoot, context.config.paths.visible_output_parent);
  return { label, parent, paths: qualificationPaths(label, parent) };
}

function visibleRunFiles(run) {
  return [run.manifest, run.results, run.scorecard,run.attemptLedger].map((path) => resolve(path));
}

function expectedVisibleEvidencePaths(visible, stage) {
  const paths = [];
  if (["critical4", "full69", "topic161", "frozen13", "final"].includes(stage)) paths.push(...visibleRunFiles(visible.paths.critical4));
  if (["full69", "topic161", "frozen13", "final"].includes(stage)) paths.push(...visibleRunFiles(visible.paths.full69));
  if (["topic161", "frozen13", "final"].includes(stage)) {
    for (const run of Object.values(visible.paths.topic161)) paths.push(...visibleRunFiles(run));
  }
  if (["frozen13", "final"].includes(stage)) {
    for (const run of Object.values(visible.paths.frozen13)) paths.push(...visibleRunFiles(run));
  }
  return paths.sort();
}

function visibleAssessmentFileRecords(value, records = []) {
  if (!value || typeof value !== "object") return records;
  if (value.files && ["manifest", "results", "scorecard", "attempt_ledger"].every((key) => value.files[key])) {
    records.push(value.files.manifest, value.files.results, value.files.scorecard,value.files.attempt_ledger);
    return records;
  }
  for (const child of Object.values(value)) visibleAssessmentFileRecords(child, records);
  return records;
}

function validateVisibleDeterministicEvidence(context, visible, stage, manifest) {
  const blockers = [];
  const gatePath = visible.paths.gates[stage];
  if (!manifest || manifest.run_label !== visible.label || manifest.stages?.[stage]?.status !== "passed" || !existsSync(gatePath)) {
    return ["visible orchestration stage or deterministic gate is absent"];
  }
  const gate = readJson(gatePath);
  if (gate.run_label !== visible.label || gate.stage !== stage || gate.passed !== true || gate.sealed_unseen_accessed !== false ||
      (gate.checks || []).some((check) => check.passed !== true)) blockers.push("deterministic gate identity or checks are invalid");
  const manifestGate = manifest.stages[stage].gate;
  const currentGate = fileRecord(context.projectRoot, relative(context.projectRoot, gatePath));
  if (!manifestGate || resolve(manifestGate.path) !== resolve(gatePath) || manifestGate.sha256 !== currentGate.sha256 || manifestGate.bytes !== currentGate.bytes) {
    blockers.push("orchestration manifest does not hash-bind the deterministic gate");
  }
  const embedded = visibleAssessmentFileRecords(gate.assessments || []);
  const embeddedPaths = embedded.map((record) => resolve(record.path || "")).sort();
  const expectedPaths = expectedVisibleEvidencePaths(visible, stage);
  if (canonicalHash(embeddedPaths) !== canonicalHash(expectedPaths) || new Set(embeddedPaths).size !== embeddedPaths.length) {
    blockers.push("deterministic gate does not contain the exact expected run artifact set");
  }
  for (const record of embedded) {
    try {
      const current = fileRecord(context.projectRoot, relative(context.projectRoot, resolve(record.path || "")));
      if (resolve(context.projectRoot, current.path) !== resolve(record.path) || current.sha256 !== record.sha256 || current.bytes !== record.bytes) {
        blockers.push(`visible run artifact changed: ${record.path}`);
      }
    } catch (error) {
      blockers.push(`visible run artifact invalid: ${record.path || "missing path"}: ${error.message}`);
    }
  }
  return [...new Set(blockers)];
}

async function ensureVisibleExecution(context, requestedStage) {
  const visible = visibleContext(context);
  const receiptStage = {
    critical4:"VISIBLE_CRITICAL4",
    full69:"VISIBLE_FULL69",
    topic161:"VISIBLE_TOPIC161_REPLACEMENT_V2",
    frozen13:"VISIBLE_FROZEN13",
    final:"CANDIDATE_FREEZE_FINAL_CLOSURE",
  }[requestedStage];
  if (!receiptStage) throw Object.assign(new Error(`Unknown visible execution stage: ${requestedStage}`),{ code:"EVALUATOR_DEFECT" });
  const receiptPath = join(context.runRoot,"visible-qualification-results",`${requestedStage}-execution-receipt.json`);
  const executionLogPath = join(context.runRoot,"visible-qualification-results",`${requestedStage}-execution.log`);
  const command = process.execPath;
  const commandArgs = [resolve(context.projectRoot, "scripts/evaluationCycleV2PostTrainingVisibleQualificationV1.mjs")];
  const receiptInputs = {
    visible_run_label:visible.label,
    visible_stage:requestedStage,
    visible_output_parent:visible.parent,
    checkpoint_path:resolve(context.projectRoot,context.config.candidate.checkpoint_path),
    checkpoint_sha256:context.config.candidate.adapter_sha256,
    declared_output_paths:[...expectedVisibleEvidencePaths(visible,requestedStage),visible.paths.gates[requestedStage]].sort(),
  };
  const manifest = readIf(visible.paths.manifest);
  if (existsSync(receiptPath)) {
    const receipt = validateExecutionReceipt({ context,receiptPath,stage:receiptStage,command,args:commandArgs,extraInputs:receiptInputs });
    if (manifest?.stages?.[requestedStage]?.status !== "passed" || !existsSync(visible.paths.gates[requestedStage])) {
      throw Object.assign(new Error(`Stored visible execution receipt has no passing ${requestedStage} deterministic gate.`),{ code:"EVALUATOR_DEFECT" });
    }
    const blockers = validateVisibleDeterministicEvidence(context, visible, requestedStage, manifest);
    if (blockers.length) throw Object.assign(new Error(`Stored visible stage evidence failed validation: ${blockers.join("; ")}`), { code:"EVALUATOR_DEFECT" });
    return { visible, execution: { ...receipt.execution,resumed_from_artifact:true }, manifest,receiptPath,executionLogPath };
  }
  if (manifest?.stages?.[requestedStage] || existsSync(visible.paths.gates[requestedStage]) || existsSync(executionLogPath)) {
    throw Object.assign(new Error(`Visible ${requestedStage} output exists without an immutable execution receipt.`),{ code:"EVALUATOR_DEFECT" });
  }
  const execution = await runChild({
    projectRoot: context.projectRoot, config: context.config, command,
    args: commandArgs,
    env: {
      ...baseEnvironment(context,receiptStage),
      VISIBLE_QUALIFICATION_EXECUTE: "owner_authorised_visible_qualification_v1",
      VISIBLE_QUALIFICATION_RUN_LABEL: visible.label,
      VISIBLE_QUALIFICATION_CHECKPOINT_PATH: resolve(context.projectRoot, context.config.candidate.checkpoint_path),
      VISIBLE_QUALIFICATION_OUTPUT_PARENT: visible.parent,
      VISIBLE_QUALIFICATION_STAGE: requestedStage,
    },
    logPath: executionLogPath, onSpawn: context.onChildSpawn,onSettled:context.onChildSettled,shouldStop:context.shouldStop,
  });
  const requestedRunRoots = requestedStage === "critical4" || requestedStage === "full69"
    ? [visible.paths[requestedStage].root]
    : requestedStage === "topic161" || requestedStage === "frozen13"
      ? Object.values(visible.paths[requestedStage]).map((run) => run.root)
      : [];
  const completedManifest = readIf(visible.paths.manifest);
  const receiptArtifacts = uniqueRecords(
    receiptInputs.declared_output_paths.filter(existsSync).map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path))),
    requestedRunRoots.filter(existsSync).flatMap((path) => directoryRecords(context.projectRoot,path)),
    existsSync(executionLogPath) ? fileRecord(context.projectRoot,relative(context.projectRoot,executionLogPath)) : null,
  );
  createExecutionReceipt({ context,receiptPath,stage:receiptStage,command,args:commandArgs,execution,artifacts:receiptArtifacts,extraInputs:receiptInputs });
  if (!cleanExecution(execution)) {
    throw Object.assign(new Error(execution.error || `Visible qualification runner exited with ${execution.signal || execution.code}`),{ code:"INFRASTRUCTURE_TEMPORARY",execution });
  }
  if (completedManifest?.stages?.[requestedStage]?.status === "passed") {
    const blockers = validateVisibleDeterministicEvidence(context, visible, requestedStage, completedManifest);
    if (blockers.length) throw Object.assign(new Error(`Visible stage evidence failed validation: ${blockers.join("; ")}`), { code:"EVALUATOR_DEFECT" });
  }
  return { visible, execution, manifest: completedManifest,receiptPath,executionLogPath };
}

function loadV1Expected(projectRoot) {
  const payload = readJson(resolve(projectRoot, "training/gold-answer-review.json"));
  return new Map((payload.items || []).map((item) => [item.id, { question: item.question, ideal_answer: item.draft_answer, required_checks: item.scoring?.required_checks,synthetic_fixture:item.synthetic_fixture,conversation_context:item.conversation_context || [],policy_evidence:item.policy_evidence }]));
}

function loadV2Expected(projectRoot, replacement, wave) {
  const path = replacement
    ? resolve(projectRoot, `training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902/${wave}/evaluation-gold.json`)
    : resolve(projectRoot, `training/evaluation-cycle-v2/02-${wave}-execution/gold/evaluation-gold.json`);
  const payload = readJson(path);
  return new Map((payload.items || []).map((item) => [item.id, { question: item.question, ideal_answer: item.reference_answer || item.draft_answer, required_checks: item.required_checks,synthetic_fixture:item.synthetic_fixture,policy_evidence:item.policy_evidence }]));
}

async function visibleStage(context, stage) {
  const rejected = await assertRuntimeAndSource(context, stage);
  if (rejected) return rejected;
  let visible;
  let execution = { code: 0 };
  let executionArtifacts = [];
  const inner = { VISIBLE_CRITICAL4: "critical4", VISIBLE_FULL69: "full69", VISIBLE_TOPIC161_REPLACEMENT_V2: "topic161", VISIBLE_FROZEN13: "frozen13" }[stage];
  const visibleExecution = await ensureVisibleExecution(context, inner);
  ({ visible, execution } = visibleExecution);
  executionArtifacts = [visibleExecution.receiptPath,visibleExecution.executionLogPath]
    .filter((path) => path && existsSync(path))
    .map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path)));
  const manifest = readIf(visible.paths.manifest);
  const deterministicGatePath = visible.paths.gates[inner];
  if (manifest?.stages?.[inner]?.status !== "passed" || !existsSync(deterministicGatePath)) {
    return writeGate(context, stage, { passed: false, blockers: [`visible deterministic ${inner} gate did not pass`] }, { orchestration_status: manifest?.status || null, runner_exit_code: execution.code,artifacts:executionArtifacts });
  }
  let cases = [];
  const receiptEnvironment = baseEnvironment(context,stage);
  const verifyRunReceipts = (run) => {
    const payload = readJson(run.results);
    const failures = (payload.results || []).flatMap((item) => {
      const verification = verifyServedResponseReceipt(item,{
        outputRoot:run.root,publicKeyPem:receiptEnvironment.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM,
        runId:context.state.run_id,stageId:stage,
      });
      return verification.passed ? [] : [`${item.question_id}: ${verification.failures.join("; ")}`];
    });
    return { payload,failures };
  };
  if (inner === "critical4" || inner === "full69") {
    const run = visible.paths[inner];
    const verified = verifyRunReceipts(run);
    if (verified.failures.length) return writeGate(context,stage,{ passed:false,blockers:verified.failures },{ deterministic_gate:deterministicGatePath,artifacts:executionArtifacts });
    cases = casesFromScorecard(verified.payload, readJson(run.scorecard), loadV1Expected(context.projectRoot));
  } else {
    const replacement = inner === "topic161";
    for (const [wave, run] of Object.entries(visible.paths[inner])) {
      const verified = verifyRunReceipts(run);
      if (verified.failures.length) return writeGate(context,stage,{ passed:false,blockers:verified.failures },{ deterministic_gate:deterministicGatePath,artifacts:executionArtifacts });
      cases.push(...casesFromScorecard(verified.payload, readJson(run.scorecard), loadV2Expected(context.projectRoot, replacement, wave)));
    }
  }
  const capabilities = auditConsumedCapabilities({ runRoot:context.runRoot,stage,cases });
  if (!capabilities.passed) return writeGate(context,stage,{ passed:false,blockers:capabilities.blockers },{ deterministic_gate:deterministicGatePath,artifacts:executionArtifacts });
  let aiGate;
  try { aiGate = await aiInChunks(cases, context, stage); }
  catch (error) { return writeGate(context, stage, { passed: false, blockers: [error.code || "AI_REVIEW_UNAVAILABLE", error.message] }, { deterministic_gate: deterministicGatePath,artifacts:executionArtifacts }); }
  const assets = loadAndVerifyVisibleAssets();
  const expectedIds = inner === "critical4" ? CRITICAL_IDS
    : inner === "full69" ? assets.v1.ids
      : inner === "topic161" ? ["wave-1", "wave-2", "wave-3"].flatMap((wave) => [...loadV2Expected(context.projectRoot, true, wave).keys()])
        : Object.values(assets.frozen13.ids_by_wave).flat();
  const aiValidation = validateAiGate(aiGate, context.config.quality, expectedIds);
  const attemptValidation = validateCaseAttemptLedgers(cases, context.state.expected_runtime_identity);
  const combinedValidation = {
    passed: aiValidation.passed && attemptValidation.passed && capabilities.passed,
    blockers: [...aiValidation.blockers, ...attemptValidation.blockers, ...capabilities.blockers],
    failure_classes: aiValidation.failure_classes || [],
    confirmed_failure_classes: aiValidation.confirmed_failure_classes || [],
    absolute_truth_claimed: Boolean(aiValidation.absolute_truth_claimed),
  };
  if (combinedValidation.passed) {
    const completionRejected = await assertRuntimeAndSourceAtCompletion(context,stage);
    if (completionRejected) return completionRejected;
  }
  const runRecords = inner === "critical4" || inner === "full69"
    ? directoryRecords(context.projectRoot, visible.paths[inner].root)
    : Object.values(visible.paths[inner]).flatMap((run) => directoryRecords(context.projectRoot, run.root));
  const artifacts = uniqueRecords(
    fileRecord(context.projectRoot, relative(context.projectRoot, deterministicGatePath)),
    executionArtifacts,
    runRecords,
    directoryRecords(context.projectRoot, join(context.runRoot, "ai-review", stage)),
  );
  return writeGate(context, stage, combinedValidation, { deterministic_gate: deterministicGatePath, deterministic_gate_sha256: sha256File(deterministicGatePath), cases: cases.length, ai_review_path: join(context.runRoot, "ai-review", stage, "dual-review-gate.json"), artifacts });
}

async function freeze(context) {
  const rejected = await assertRuntimeAndSource(context, "CANDIDATE_FREEZE");
  if (rejected) return rejected;
  const requiredStages = ["VERIFY_RUNTIME", "T4_TARGETED_REGRESSION", "TOPIC161_ORIGINAL_DEVELOPMENT", "LIVE50_FULL_REGRESSION", "RELIABILITY_GATE", "VISIBLE_CRITICAL4", "VISIBLE_FULL69", "VISIBLE_TOPIC161_REPLACEMENT_V2", "VISIBLE_FROZEN13"];
  if (requiredStages.some((name) => !readIf(stageGatePath(context, name))?.passed)) return writeGate(context, "CANDIDATE_FREEZE", { passed: false, blockers: ["all ordered predecessor gates have not passed"] });
  const evidenceFailures = requiredStages.flatMap((name) => {
    const gate = readJson(stageGatePath(context, name));
    const failures = validateArtifactRecords(context.projectRoot, gate.artifacts || []);
    return failures.map((failure) => ({ stage:name, ...failure }));
  });
  if (evidenceFailures.length) {
    return writeGate(context, "CANDIDATE_FREEZE", { passed: false, blockers: ["qualification evidence changed before freeze"], evidence_failures: evidenceFailures });
  }
  const visibleBefore = visibleContext(context);
  const evaluatedRunRoots = [
    visibleBefore.paths.critical4.root,visibleBefore.paths.full69.root,
    ...Object.values(visibleBefore.paths.topic161).map((run) => run.root),
    ...Object.values(visibleBefore.paths.frozen13).map((run) => run.root),
  ];
  const evaluatedBefore = uniqueRecords(evaluatedRunRoots.flatMap((root) => directoryRecords(context.projectRoot, root)));
  const { visible, execution, manifest,receiptPath:finalReceiptPath,executionLogPath:finalExecutionLogPath } = await ensureVisibleExecution(context, "final");
  const evaluatedAfter = uniqueRecords(evaluatedRunRoots.flatMap((root) => directoryRecords(context.projectRoot, root)));
  if (execution.code !== 0 || manifest?.status !== "completed_owner_authorised_visible_qualification_passed" || !existsSync(visible.paths.gates.final) || canonicalHash(evaluatedBefore) !== canonicalHash(evaluatedAfter)) {
    return writeGate(context, "CANDIDATE_FREEZE", { passed: false, blockers: ["final visible closure failed or changed evaluated question outputs"] });
  }
  const finalClosureArtifacts = uniqueRecords(
    fileRecord(context.projectRoot, relative(context.projectRoot, visible.paths.gates.final)),
    fileRecord(context.projectRoot, relative(context.projectRoot, visible.paths.manifest)),
    existsSync(visible.paths.summary) ? fileRecord(context.projectRoot, relative(context.projectRoot, visible.paths.summary)) : null,
    [finalReceiptPath,finalExecutionLogPath].filter((path) => path && existsSync(path)).map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path))),
  );
  const freezeRoot = join(context.runRoot, "candidate-freeze");
  const candidateManifestPath = join(freezeRoot, "candidate-manifest.json");
  const readyPath = join(freezeRoot, "READY.md");
  const freezeManifestPath = join(freezeRoot, "SHA256-MANIFEST.json");
  if ([candidateManifestPath,readyPath,freezeManifestPath].some(existsSync)) {
    return writeGate(context,"CANDIDATE_FREEZE",{ passed:false,blockers:["Readiness artifacts existed before the current final runtime cleanup"] },{ artifacts:finalClosureArtifacts });
  }
  let artifacts = uniqueRecords(finalClosureArtifacts);
  try {
    await verifyRuntimeAndOwner(context,"CANDIDATE_FREEZE","final-preflight");
  } catch (error) {
    return runtimeMismatchGate(context,"CANDIDATE_FREEZE",error,artifacts);
  }
  // Close source drift after the awaited runtime probe, then repeat the check
  // after the awaited final cleanup before a passing gate can be written.
  const finalSourceChanges = compareBindings(context.projectRoot,context.state.source_bindings || {});
  if (finalSourceChanges.length) return sourceMismatchGate(context,"CANDIDATE_FREEZE",finalSourceChanges,"final freeze source comparison",artifacts);
  const runtimeCleanup = await stopRuntimeForGate(context);
  const cleanupPaths = [join(context.runRoot,"runtime-process.json"),runtimeCleanup.stop_record_path].filter((path) => path && existsSync(path));
  artifacts = uniqueRecords(artifacts,cleanupPaths.map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path))));
  if (!runtimeCleanup.stopped) {
    return writeGate(context,"CANDIDATE_FREEZE",{
      passed:false,blockers:["final technical preflight runtime cleanup did not complete"],
    },{ runtime_cleanup:runtimeCleanup,artifacts });
  }
  if (context.shouldStop?.()) {
    throw Object.assign(new Error("Qualification worker interruption occurred during final runtime cleanup; readiness cannot be written."),{ code:"WORKER_INTERRUPTED" });
  }
  // Cleanup is awaited, so bind one final synchronous source comparison before
  // declaring the frozen candidate ready with no qualification runtime left.
  const postCleanupSourceChanges = compareBindings(context.projectRoot,context.state.source_bindings || {});
  if (postCleanupSourceChanges.length) {
    return sourceMismatchGate(context,"CANDIDATE_FREEZE",postCleanupSourceChanges,"after final technical preflight cleanup",artifacts);
  }
  if (context.shouldStop?.()) {
    throw Object.assign(new Error("Qualification worker interruption prevented the final passing freeze gate."),{ code:"WORKER_INTERRUPTED" });
  }
  const files = {
    candidate_and_source: context.state.source_bindings,
    gates: Object.fromEntries(["VERIFY_RUNTIME", "T4_TARGETED_REGRESSION", "TOPIC161_ORIGINAL_DEVELOPMENT", "LIVE50_FULL_REGRESSION", "RELIABILITY_GATE", "VISIBLE_CRITICAL4", "VISIBLE_FULL69", "VISIBLE_TOPIC161_REPLACEMENT_V2", "VISIBLE_FROZEN13"].map((name) => [name, { path: stageGatePath(context, name), sha256: sha256File(stageGatePath(context, name)) }])),
    evidence: Object.fromEntries(requiredStages.map((name) => [name, readJson(stageGatePath(context, name)).artifacts || []])),
    visible_final_closure: finalClosureArtifacts,
    runtime_cleanup:cleanupPaths.map((path) => fileRecord(context.projectRoot,relative(context.projectRoot,path))),
  };
  const candidateManifest = { version:"post-t4-frozen-candidate-v1",created_at:now(),candidate_id:context.state.expected_runtime_identity.id,selected_iteration:104,runtime_configuration_sha256:context.state.runtime_configuration_sha256,python_environment_sha256:context.state.python_environment_sha256,qualification_response_public_key_sha256:readJson(join(context.runRoot,"runtime-identity.json")).qualification_response_public_key_sha256,files,permissions:context.config.permissions,sealed_unseen_accessed:false,next_state:"READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION" };
  const readyText = "# READY FOR SEALED UNSEEN OWNER AUTHORISATION\n\nVisible qualification and technical preflight passed. The exactly owned qualification runtime was stopped before this marker was written. Sealed unseen has not been accessed or authorised.\n";
  mkdirSync(freezeRoot,{ recursive:true });
  createExclusive(candidateManifestPath,candidateManifest);
  createExclusive(readyPath,readyText);
  const freezeManifest = manifestDirectory(context.projectRoot,freezeRoot,freezeManifestPath,{ candidate_id:context.state.expected_runtime_identity.id,runtime_cleanup_completed:true });
  const freezeFailures = validateArtifactRecords(context.projectRoot,freezeManifest.files || []);
  if (freezeFailures.length || freezeManifest.files_sha256 !== canonicalHash(freezeManifest.files || [])) {
    throw Object.assign(new Error("Newly written freeze SHA-256 manifest is invalid."),{ code:"EVALUATOR_DEFECT" });
  }
  artifacts = uniqueRecords(artifacts,directoryRecords(context.projectRoot,freezeRoot));
  return writeGate(context, "CANDIDATE_FREEZE", { passed: true, blockers: [] }, { freeze_manifest: freezeManifestPath, freeze_files_sha256: freezeManifest.files_sha256, runtime_cleanup:runtimeCleanup, artifacts });
}

export const STAGE_HANDLERS = Object.freeze({
  VERIFY_RUNTIME: verifyRuntimeStage,
  T4_TARGETED_REGRESSION: t4Targeted,
  TOPIC161_ORIGINAL_DEVELOPMENT: topic161,
  LIVE50_FULL_REGRESSION: live50,
  RELIABILITY_GATE: reliability,
  VISIBLE_CRITICAL4: (context) => visibleStage(context, "VISIBLE_CRITICAL4"),
  VISIBLE_FULL69: (context) => visibleStage(context, "VISIBLE_FULL69"),
  VISIBLE_TOPIC161_REPLACEMENT_V2: (context) => visibleStage(context, "VISIBLE_TOPIC161_REPLACEMENT_V2"),
  VISIBLE_FROZEN13: (context) => visibleStage(context, "VISIBLE_FROZEN13"),
  CANDIDATE_FREEZE: freeze,
});

export function stageArtifactPath(runRoot, stage) {
  return join(runRoot, "stage-manifests", `${stage}.json`);
}
