import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PINNED_EMBEDDING_MODEL,
  PINNED_RERANKER_MODEL,
  PINNED_RETRIEVAL_MANIFEST_SHA256,
  PINNED_RETRIEVAL_SERVER_SHA256,
  pinnedRetrievalHealthMatches,
  pinnedRetrievalIdentity,
} from "../server/services/pinnedRetrievalIdentity.js";
import {
  CRITICAL_IDS,
  EXPECTED_WAVE_COUNTS,
  PROJECT_ROOT,
  STAGE_ORDER,
  V1_SUITE_GATES,
  V2_DIAGNOSTIC_GATE,
  VISIBLE_QUALIFICATION_VERSION,
  assessV1SuiteThresholds,
  assessV2DiagnosticThresholds,
  countBy,
  exactIdSet,
  fileRecord,
  hashFile,
  identityDifferences,
  loadAndVerifyCheckpoint,
  loadAndVerifyVisibleAssets,
  now,
  qualificationPaths,
  readJson,
  validateRunLabel,
  writeJsonAtomic,
  writeTextAtomic,
} from "./lib/postTrainingVisibleQualificationV1.mjs";
import { canonicalHash, sha256Buffer } from "./lib/qualification-worker/utils.mjs";
import { verifyServedResponseReceipt } from "./lib/servedResponseReceipt.mjs";

const label = validateRunLabel(process.env.VISIBLE_QUALIFICATION_RUN_LABEL);
const checkpointPath = resolve(String(process.env.VISIBLE_QUALIFICATION_CHECKPOINT_PATH || ""));
const outputParent = resolve(process.env.VISIBLE_QUALIFICATION_OUTPUT_PARENT ||
  "training/evaluation-cycle-v2/10-post-training-visible-qualification-v1-20260901");
const stage = String(process.env.VISIBLE_QUALIFICATION_GATE_STAGE || "final");
if (!STAGE_ORDER.includes(stage)) throw new Error(`Unknown visible qualification gate stage: ${stage}`);
const paths = qualificationPaths(label, outputParent);
const gatePath = paths.gates[stage];
if (existsSync(gatePath)) throw new Error(`Gate evidence already exists and will not be overwritten: ${gatePath}`);
if (!existsSync(paths.manifest)) throw new Error("Visible qualification orchestration manifest is missing.");

const checkpoint = loadAndVerifyCheckpoint(checkpointPath, { verifyLargeBaseModel: stage === "final" });
const assets = loadAndVerifyVisibleAssets();
const orchestration = readJson(paths.manifest);
const workerConfig = readJson(resolve(PROJECT_ROOT,"config/qualification-worker.json"));
const expectedEvaluation = {
  temperature:workerConfig.runtime.generation_temperature,top_p:workerConfig.runtime.generation_top_p,seed:workerConfig.runtime.generation_seed,
  max_tokens:workerConfig.runtime.model_max_tokens,max_attempts:workerConfig.runtime.model_max_attempts,
  model_context_limit_tokens:workerConfig.runtime.model_context_limit_tokens,model_prefill_step_size:workerConfig.runtime.model_prefill_step_size,
  model_cache_limit_bytes:workerConfig.runtime.model_cache_limit_bytes,model_enable_thinking:workerConfig.runtime.model_enable_thinking,
  model_system_prefix_cache:workerConfig.runtime.model_system_prefix_cache,model_trust_remote_code:workerConfig.runtime.model_trust_remote_code,
  model_add_generation_prompt:workerConfig.runtime.model_add_generation_prompt,
  source_limit:workerConfig.runtime.context_source_limit,source_snippet_characters:workerConfig.runtime.source_snippet_chars,
  model_timeout_ms:workerConfig.runtime.model_timeout_ms,embedding_timeout_ms:workerConfig.runtime.embedding_timeout_ms,
  rerank_timeout_ms:workerConfig.runtime.rerank_timeout_ms,
  retrieval_min_score:workerConfig.runtime.retrieval_min_score,
  degraded_retrieval_min_score:workerConfig.runtime.degraded_retrieval_min_score,
  live_chat_timeout_ms:workerConfig.runtime.live_chat_timeout_ms,
  model_retry_ready_timeout_ms:workerConfig.runtime.model_retry_ready_timeout_ms,
  model_retry_health_probe_timeout_ms:workerConfig.runtime.model_retry_health_probe_timeout_ms,
  model_retry_poll_ms:workerConfig.runtime.model_retry_poll_ms,
  model_status_timeout_ms:workerConfig.runtime.model_status_timeout_ms,
  live_retry_backoff_ms:workerConfig.runtime.live_retry_backoff_ms,
  evaluation_health_timeout_ms:workerConfig.runtime.evaluation_health_timeout_ms,
  embedding_warmup_timeout_ms:workerConfig.runtime.embedding_warmup_timeout_ms,
  embedding_retry_backoff_ms:workerConfig.runtime.embedding_retry_backoff_ms,
  reranker_warmup_timeout_ms:workerConfig.runtime.reranker_warmup_timeout_ms,
  model_warmup_timeout_ms:workerConfig.runtime.model_warmup_timeout_ms,
  python_environment_manifest_sha256:workerConfig.runtime.python_environment_manifest_sha256,
  timezone:workerConfig.runtime.timezone,
  retrieval_device:workerConfig.runtime.retrieval_device,
  retrieval_threads:workerConfig.runtime.retrieval_threads,
};
const blockers = [];
const checks = [];

function check(id, passed, detail = null) {
  checks.push({ id, passed: Boolean(passed), detail });
  if (!passed) blockers.push(id);
  return Boolean(passed);
}

function sameFileRecord(record, current) {
  return Boolean(record && current && record.path === current.path && record.bytes === current.bytes && record.sha256 === current.sha256);
}

check("orchestration_version_mismatch", orchestration.version === VISIBLE_QUALIFICATION_VERSION, {
  expected: VISIBLE_QUALIFICATION_VERSION,
  actual: orchestration.version || null,
});
check("run_label_mismatch", orchestration.run_label === label, { expected: label, actual: orchestration.run_label || null });
const stageIndex = STAGE_ORDER.indexOf(stage);
check("execution_contract_changed", JSON.stringify(orchestration.execution_order) === JSON.stringify(STAGE_ORDER) &&
  orchestration.total_case_executions === 247 &&
  orchestration.runtime_configuration_sha256 === canonicalHash(workerConfig.runtime) &&
  /^[0-9a-f]{64}$/.test(String(orchestration.python_environment_sha256 || "")) &&
  orchestration.runtime_preflight?.identity?.runtime_configuration_sha256 === orchestration.runtime_configuration_sha256 &&
  orchestration.runtime_preflight?.identity?.python_environment_sha256 === orchestration.python_environment_sha256 &&
  orchestration.runtime_preflight?.embedding_health?.body?.runtime_configuration_sha256 === orchestration.runtime_configuration_sha256 &&
  orchestration.runtime_preflight?.embedding_health?.body?.python_environment_sha256 === orchestration.python_environment_sha256 &&
  orchestration.runtime_preflight?.embedding_health?.body?.device === workerConfig.runtime.retrieval_device &&
  orchestration.runtime_preflight?.embedding_health?.body?.threads === workerConfig.runtime.retrieval_threads &&
  Object.entries(expectedEvaluation).every(([key,value]) => orchestration.fixed_evaluation_configuration?.[key] === value) &&
  orchestration.fixed_evaluation_configuration?.embedding_model === PINNED_EMBEDDING_MODEL.repository &&
  orchestration.fixed_evaluation_configuration?.embedding_revision === PINNED_EMBEDDING_MODEL.revision &&
  orchestration.fixed_evaluation_configuration?.degraded_embeddings_allowed === false &&
  orchestration.fixed_evaluation_configuration?.reranker_model === PINNED_RERANKER_MODEL.repository &&
  orchestration.fixed_evaluation_configuration?.reranker_revision === PINNED_RERANKER_MODEL.revision &&
  orchestration.fixed_evaluation_configuration?.retrieval_server_sha256 === PINNED_RETRIEVAL_SERVER_SHA256 &&
  orchestration.fixed_evaluation_configuration?.retrieval_model_manifest_sha256 === PINNED_RETRIEVAL_MANIFEST_SHA256 &&
  orchestration.fixed_evaluation_configuration?.cross_encoder_reranker_required === true);
check("stage_order_or_state_invalid", STAGE_ORDER.slice(0, stageIndex).every((name) =>
  orchestration.stages?.[name]?.status === "passed" &&
  existsSync(paths.gates[name]) && sameFileRecord(orchestration.stages[name].gate, fileRecord(paths.gates[name]))) &&
  orchestration.stages?.[stage]?.status === "running" &&
  STAGE_ORDER.slice(stageIndex + 1).every((name) => orchestration.stages?.[name] == null));
check("visible_only_declaration_missing", orchestration.scope?.sealed_unseen_accessed === false &&
  orchestration.scope?.sealed_unseen_authorised === false && orchestration.scope?.release_authorised === false);
const expectedTrainingExecution = {
  mode: checkpoint.trainingExecutionMode,
  status: checkpoint.training.status,
  exit_code: checkpoint.training.metrics?.exit_code ?? null,
  training_execution_completed: checkpoint.trainingExecutionMode === "completed_training_run",
  full_scheduled_iterations_completed: checkpoint.trainingExecutionMode === "completed_training_run",
  failure_classification: checkpoint.checkpoint.execution_recovery?.failure_classification ?? null,
};
check("training_execution_boundary_changed",
  JSON.stringify(orchestration.checkpoint?.training_execution) === JSON.stringify(expectedTrainingExecution), {
    expected: expectedTrainingExecution,
    actual: orchestration.checkpoint?.training_execution || null,
  });
const expectedArtifactKeys = Object.keys(checkpoint.artifacts).sort();
const orchestrationArtifactKeys = Object.keys(orchestration.checkpoint?.artifacts || {}).sort();
check("checkpoint_artifact_chain_changed",
  JSON.stringify(orchestrationArtifactKeys) === JSON.stringify(expectedArtifactKeys) &&
  expectedArtifactKeys.every((key) => sameFileRecord(
    orchestration.checkpoint?.artifacts?.[key],
    checkpoint.artifacts[key],
  )), {
    expected_keys: expectedArtifactKeys,
    actual_keys: orchestrationArtifactKeys,
  });
check("checkpoint_selection_changed", sameFileRecord(
  orchestration.checkpoint?.artifacts?.checkpoint_selection,
  checkpoint.artifacts.checkpoint_selection,
));
check("training_manifest_changed", sameFileRecord(
  orchestration.checkpoint?.artifacts?.training_run_manifest,
  checkpoint.artifacts.training_run_manifest,
));
check("adapter_weights_changed", sameFileRecord(
  orchestration.checkpoint?.artifacts?.adapter_weights,
  checkpoint.artifacts.adapter_weights,
));
check("adapter_config_changed", sameFileRecord(
  orchestration.checkpoint?.artifacts?.adapter_config,
  checkpoint.artifacts.adapter_config,
));
check("base_model_weights_changed", sameFileRecord(
  orchestration.checkpoint?.artifacts?.base_model_weights,
  checkpoint.artifacts.base_model_weights,
));
check("checkpoint_model_identity_changed", orchestration.checkpoint?.model_id === checkpoint.modelId &&
  identityDifferences(orchestration.checkpoint?.expected_identity, checkpoint.expectedIdentity).length === 0);
check("wave4_selection_changed", sameFileRecord(orchestration.visible_assets?.frozen13?.selection, assets.frozen13.selection));
check("visible_asset_counts_changed", orchestration.visible_assets?.v1?.count === 69 &&
  Object.entries(EXPECTED_WAVE_COUNTS).every(([wave, count]) => orchestration.visible_assets?.waves?.[wave]?.count === count) &&
  orchestration.visible_assets?.frozen13?.count === 13);
check("visible_assets_changed", ["question_bank", "answer_review", "baseline_scorecard"].every((key) =>
  sameFileRecord(orchestration.visible_assets?.v1?.[key], assets.v1[key])) &&
  Object.keys(EXPECTED_WAVE_COUNTS).every((wave) => ["question_bank", "evaluation_gold"].every((key) =>
    sameFileRecord(orchestration.visible_assets?.waves?.[wave]?.[key], assets.waves[wave][key]))));

const initialRuntimeIdentity = orchestration.runtime_preflight?.identity;
check("runtime_preflight_identity_missing_or_changed", identityDifferences(initialRuntimeIdentity, checkpoint.expectedIdentity).length === 0 &&
  initialRuntimeIdentity?.worker_sha256 === orchestration.code_artifacts?.["ml/pinned_mlx_worker.py"]?.sha256 &&
  initialRuntimeIdentity?.cache_helper_sha256 === orchestration.code_artifacts?.["ml/pinned_prompt_cache.py"]?.sha256 &&
  initialRuntimeIdentity?.supervisor_sha256 === orchestration.code_artifacts?.["server/services/pinnedModelServer.js"]?.sha256 &&
  orchestration.code_artifacts?.["ml/embedding_server.py"]?.sha256 === PINNED_RETRIEVAL_SERVER_SHA256 &&
  orchestration.code_artifacts?.["models/model-manifest.json"]?.sha256 === PINNED_RETRIEVAL_MANIFEST_SHA256 &&
  JSON.stringify(orchestration.runtime_preflight?.retrieval_identity) === JSON.stringify(pinnedRetrievalIdentity()) &&
  typeof orchestration.runtime_preflight?.embedding_probe_sha256 === "string" &&
  typeof orchestration.runtime_preflight?.reranker_probe_sha256 === "string");

function inspectRun({ id, kind, run, expectedIds, expectedInputSha256 = null, expectedGoldSha256 = null }) {
  const localBlockers = [];
  const fail = (reason) => { localBlockers.push(reason); };
  for (const [name, path] of Object.entries({ manifest: run.manifest, results: run.results, scorecard: run.scorecard,attempt_ledger:run.attemptLedger })) {
    if (!existsSync(path)) fail(`missing_${name}`);
  }
  if (localBlockers.length) return { id, kind, passed: false, blockers: localBlockers, root: run.root };

  const manifest = readJson(run.manifest);
  const results = readJson(run.results);
  const scorecard = readJson(run.scorecard);
  const attemptEvents = readFileSync(run.attemptLedger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const rows = Array.isArray(results.results) ? results.results : [];
  const scores = Array.isArray(scorecard.items) ? scorecard.items : [];
  const rowIds = rows.map((item) => item.question_id);
  const scoreIds = scores.map((item) => item.question_id);
  const scoreById = new Map(scores.map((item) => [item.question_id,item]));
  const resultsSha = hashFile(run.results);
  const manifestResultSha = manifest.results_sha256 || manifest.result_sha256 || null;

  for (const row of rows) {
    const verification = verifyServedResponseReceipt(row,{ outputRoot:run.root });
    if (!verification.passed) fail(`served_response_receipt_invalid:${row.question_id}:${verification.failures.join("|")}`);
  }

  if (!exactIdSet(rowIds, expectedIds)) fail("result_ids_not_exact");
  if (!exactIdSet(scoreIds, expectedIds)) fail("score_ids_not_exact");
  const manifestIds = kind === "v1" ? manifest.evaluation?.question_ids : manifest.input?.question_ids;
  if (!Array.isArray(manifestIds) || !exactIdSet(manifestIds, expectedIds)) fail("manifest_question_ids_not_exact");
  if (results.summary?.processed !== expectedIds.length) fail("processed_count_mismatch");
  if (manifestResultSha !== resultsSha) fail("manifest_results_hash_mismatch");
  if (scorecard.results_sha256 !== resultsSha) fail("scorecard_results_hash_mismatch");
  for (const row of rows) {
    const score = scoreById.get(row.question_id) || {};
    const answerSha256 = sha256Buffer(String(row.final_system_answer || ""));
    if (score.served_response_verified !== true || score.served_answer_sha256 !== answerSha256 ||
        row.served_response_sha256 !== answerSha256 || score.served_response_receipt_sha256 !== row.served_response_receipt?.sha256 ||
        score.served_raw_response_sha256 !== row.served_response_receipt?.raw_sha256 ||
        row.served_response_receipt?.served_answer_sha256 !== answerSha256) {
      fail(`served_response_commitment_mismatch:${row.question_id}`);
    }
  }
  if (manifest.generation_attempt_ledger_sha256 !== hashFile(run.attemptLedger)) fail("manifest_attempt_ledger_hash_mismatch");
  const expectedAttemptEvents = rows.flatMap((item) => (item.generation_attempt_ledger || []).map((event) => ({ run_label:manifest.run_label,question_id:item.question_id,...event })));
  if (JSON.stringify(attemptEvents) !== JSON.stringify(expectedAttemptEvents)) fail("attempt_ledger_does_not_match_result_provenance");
  if (results.summary?.run_errors !== 0 || rows.some((item) => item.selected_route === "RUN_ERROR" || item.run_error)) {
    fail("run_errors_present");
  }
  if (rows.some((item) => item.model_version !== checkpoint.modelId)) fail("result_model_version_mismatch");
  if (manifest.model?.version !== checkpoint.modelId) fail("manifest_model_version_mismatch");
  if (kind === "v2" && (manifest.partition !== "diagnostic" || results.partition !== "diagnostic" ||
    manifest.integrity?.unseen_accessed !== false || manifest.integrity?.gold_supplied_to_model !== false)) {
    fail("diagnostic_partition_integrity_mismatch");
  }
  if (kind === "v1" && (manifest.evaluation?.sealed_unseen_accessed !== false || results.sealed_unseen_accessed !== false)) {
    fail("cycle_v1_visible_integrity_mismatch");
  }
  if (manifest.rag?.service_health?.ok !== true) fail("retrieval_runtime_health_missing");
  if (!pinnedRetrievalHealthMatches(manifest.rag?.service_health?.body)) {
    fail("retrieval_runtime_identity_mismatch");
  }
  if (manifest.generation?.maxTokens !== expectedEvaluation.max_tokens || manifest.generation?.temperature !== expectedEvaluation.temperature ||
    manifest.generation?.topP !== expectedEvaluation.top_p || manifest.generation?.seed !== expectedEvaluation.seed) {
    fail("generation_configuration_mismatch");
  }
  const contextLimit = kind === "v1" ? manifest.model_context?.source_limit : manifest.model_context?.sourceLimit;
  const snippetChars = kind === "v1" ? manifest.model_context?.source_snippet_characters : manifest.model_context?.sourceSnippetChars;
  const contextTokens = kind === "v1" ? manifest.model_context?.context_limit_tokens : manifest.model_context?.contextLimitTokens;
  if (contextLimit !== expectedEvaluation.source_limit || snippetChars !== expectedEvaluation.source_snippet_characters || contextTokens !== expectedEvaluation.model_context_limit_tokens) fail("model_context_configuration_mismatch");
  if (kind === "v1") {
    if (scorecard.scoring_policy?.pass_mark !== 8 ||
      scorecard.scoring_policy?.critical_failure_automatic_fail !== true) {
      fail("cycle_v1_scoring_policy_mismatch");
    }
    if (manifest.code?.runner !== orchestration.code_artifacts?.["scripts/evaluationCycleV1PostFixRegression.mjs"]?.sha256) {
      fail("cycle_v1_runner_hash_mismatch");
    }
    if (scorecard.scoring_evidence?.scorer_sha256 !==
        orchestration.code_artifacts?.["scripts/evaluationCycleV1PostFixScore.mjs"]?.sha256 ||
      scorecard.scoring_evidence?.content_checks_sha256 !==
        orchestration.code_artifacts?.["scripts/lib/releaseContentChecks.mjs"]?.sha256) {
      fail("cycle_v1_scorer_hash_mismatch");
    }
    if (scorecard.status !== "regression_only_not_model_selection") fail("cycle_v1_scorecard_status_mismatch");
  } else {
    if (manifest.input?.sha256 !== expectedInputSha256) fail("cycle_v2_question_bank_hash_mismatch");
    if (manifest.code?.runner_sha256 !== orchestration.code_artifacts?.["scripts/evaluationCycleV2Wave1Run.mjs"]?.sha256) {
      fail("cycle_v2_runner_hash_mismatch");
    }
    if (manifest.code?.embedding_service_sha256 !== PINNED_RETRIEVAL_SERVER_SHA256) {
      fail("cycle_v2_retrieval_server_hash_mismatch");
    }
    if (scorecard.scoring_evidence?.["scripts/evaluationCycleV2Wave1Score.mjs"] !==
      orchestration.code_artifacts?.["scripts/evaluationCycleV2Wave1Score.mjs"]?.sha256) {
      fail("cycle_v2_scorer_hash_mismatch");
    }
    if (!Object.values(scorecard.scoring_evidence || {}).includes(expectedGoldSha256)) {
      fail("cycle_v2_gold_hash_mismatch");
    }
    if (scorecard.status !== "provisional_development_scoring_pending_independent_gold_review") {
      fail("cycle_v2_scorecard_status_mismatch");
    }
  }

  const serviceIdentity = manifest.model?.service_health?.body?.data?.find((item) => item.id === checkpoint.modelId);
  if (identityDifferences(serviceIdentity, checkpoint.expectedIdentity).length) fail("manifest_runtime_identity_mismatch");
  if (serviceIdentity?.worker_sha256 !== initialRuntimeIdentity?.worker_sha256 ||
    serviceIdentity?.cache_helper_sha256 !== initialRuntimeIdentity?.cache_helper_sha256 ||
    serviceIdentity?.supervisor_sha256 !== initialRuntimeIdentity?.supervisor_sha256) {
    fail("runtime_code_identity_changed");
  }
  for (const item of rows) {
    if (item.retrieval_trace?.reranker?.degraded === true ||
      item.retrieval_trace?.reranker?.mode === "deterministic_fallback") {
      fail(`degraded_retrieval_present:${item.question_id}`);
    }
    if (typeof item.model_call_attempted !== "boolean") {
      fail(`model_call_attempt_flag_missing:${item.question_id}`);
      continue;
    }
    if (item.model_call_attempted) {
      const attempts = Number(item.generation_attempts);
      const events = item.generation_attempt_ledger || [];
      const expectedEvents = attempts === 1
        ? [["ATTEMPT_STARTED",1],["ATTEMPT_SUCCEEDED",1]]
        : attempts === 2 ? [["ATTEMPT_STARTED",1],["ATTEMPT_FAILED",1],["ATTEMPT_STARTED",2],["ATTEMPT_SUCCEEDED",2]] : [];
      if (!expectedEvents.length || events.length !== expectedEvents.length || expectedEvents.some(([event, attempt], index) => events[index]?.event !== event || Number(events[index]?.attempt) !== attempt) ||
          (attempts === 2 && (!["MODEL_INVALID_OUTPUT","MODEL_UNAVAILABLE"].includes(item.retry_reason) || events[1]?.reason !== item.retry_reason || events[2]?.retry_reason !== item.retry_reason)) ||
          Boolean(item.recovered_from_truncation)) fail(`invalid_generation_attempt_provenance:${item.question_id}`);
    }
    if ((item.model_call_attempted || item.raw_model_answer != null) &&
      (identityDifferences(item.runtime_identity, checkpoint.expectedIdentity).length ||
       item.runtime_identity?.worker_sha256 !== serviceIdentity?.worker_sha256 ||
       item.runtime_identity?.cache_helper_sha256 !== serviceIdentity?.cache_helper_sha256 ||
       item.runtime_identity?.supervisor_sha256 !== serviceIdentity?.supervisor_sha256)) {
      fail(`result_runtime_identity_mismatch:${item.question_id}`);
    }
  }

  return {
    id,
    kind,
    root: run.root,
    expected: expectedIds.length,
    processed: rows.length,
    outcomes: scorecard.outcomes || {},
    run_errors: rows.filter((item) => item.selected_route === "RUN_ERROR" || item.run_error).length,
    files: {
      manifest: fileRecord(run.manifest),
      results: fileRecord(run.results),
      scorecard: fileRecord(run.scorecard),
      attempt_ledger: fileRecord(run.attemptLedger),
    },
    manifest,
    results,
    scorecard,
    passed: localBlockers.length === 0,
    blockers: [...new Set(localBlockers)],
  };
}

function criticalAssessment() {
  const run = inspectRun({ id: "critical4", kind: "v1", run: paths.critical4, expectedIds: CRITICAL_IDS });
  const scores = run.scorecard?.items || [];
  const criticalFailures = scores.filter((item) => item.critical_failure || item.status === "critical_fail");
  const timeoutErrors = (run.results?.results || []).filter((item) => /timeout|timed out|deadline/i.test(
    `${item.run_error?.code || ""} ${item.run_error?.message || ""}`,
  ));
  const passed = run.passed && scores.length === 4 && scores.every((item) => item.status === "pass") &&
    criticalFailures.length === 0 && timeoutErrors.length === 0 && Number(run.scorecard?.outcomes?.pass || 0) === 4;
  return {
    ...stripPayloads(run),
    policy: "4/4 pass with zero critical failure, timeout, or run error",
    pass: Number(run.scorecard?.outcomes?.pass || 0),
    critical_failures: criticalFailures.map((item) => item.question_id),
    timeout_errors: timeoutErrors.map((item) => item.question_id),
    passed,
    blockers: [...new Set([...run.blockers, ...(passed ? [] : ["critical4_gate_failed"])])],
  };
}

function full69Assessment() {
  const run = inspectRun({ id: "full69", kind: "v1", run: paths.full69, expectedIds: assets.v1.ids });
  const items = run.scorecard?.items || [];
  const threshold = assessV1SuiteThresholds(items);
  const passed = run.passed && threshold.passed;
  return {
    ...stripPayloads(run),
    policy: { suites: V1_SUITE_GATES, zero_critical_failures: true, zero_run_errors: true },
    outcomes: countBy(items.map((item) => item.status)),
    critical_failures: threshold.critical_failure_ids,
    suites: threshold.suites,
    passed,
    blockers: [...new Set([...run.blockers, ...(passed ? [] : ["full69_suite_gate_failed"])])],
  };
}

function waveAssessment(wave, run, expectedIds, id, hashOverrides = {}) {
  const inspected = inspectRun({
    id,
    kind: "v2",
    run,
    expectedIds,
    expectedInputSha256: hashOverrides.questionSha256 || assets.waves[wave].question_bank.sha256,
    expectedGoldSha256: hashOverrides.goldSha256 || assets.waves[wave].evaluation_gold.sha256,
  });
  const score = inspected.scorecard || {};
  const threshold = assessV2DiagnosticThresholds(score);
  const passed = inspected.passed && threshold.passed;
  return {
    ...stripPayloads(inspected),
    wave,
    policy: V2_DIAGNOSTIC_GATE,
    pass_rate: score.pass_rate ?? null,
    critical_risk_items: score.critical_risk_items ?? null,
    critical_risk_passes: score.critical_risk_passes ?? null,
    topics: score.topics || [],
    critical_failures: threshold.critical_failure_ids,
    diagnostic_gate: score.diagnostic_gate || null,
    passed,
    blockers: [...new Set([...inspected.blockers, ...(passed ? [] : [`${id}_gate_failed`])])],
  };
}

function topic161Assessment() {
  const replacementRoot = resolve(PROJECT_ROOT, "training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902");
  const usingReplacement = true;
  const replacementManifest = existsSync(resolve(replacementRoot, "frozen-suite-manifest.json"))
    ? readJson(resolve(replacementRoot, "frozen-suite-manifest.json"))
    : null;
  const waves = Object.fromEntries(Object.entries(EXPECTED_WAVE_COUNTS).map(([wave]) => {
    const expectedIds = usingReplacement
      ? (readJson(resolve(replacementRoot, `${wave}/development-question-set.json`)).topics || [])
        .flatMap((topic) => (topic.diagnostic_evaluation || []).map((item) => item.id))
      : assets.waves[wave].ids;
    const hashes = usingReplacement && replacementManifest ? {
      questionSha256: replacementManifest.hashes[wave].questions,
      goldSha256: replacementManifest.hashes[wave].gold,
    } : {};
    return [wave, waveAssessment(wave, paths.topic161[wave], expectedIds, `${wave}-topic-full`, hashes)];
  }));
  const replacementIdsByWave = Object.fromEntries(Object.keys(EXPECTED_WAVE_COUNTS).map((wave) => [wave,
    (readJson(resolve(replacementRoot, `${wave}/development-question-set.json`)).topics || []).flatMap((topic) => (topic.diagnostic_evaluation || []).map((item) => item.id)),
  ]));
  const allReplacementIds = Object.values(replacementIdsByWave).flat();
  const replacementIdentityValid = replacementManifest?.version === "topic161-replacement-v2-frozen-suite-manifest-v1" &&
    replacementManifest.item_count === 161 && replacementManifest.sealed_unseen_accessed === false &&
    Object.entries(EXPECTED_WAVE_COUNTS).every(([wave, count]) => replacementManifest.waves?.[wave] === count && replacementIdsByWave[wave].length === count) &&
    allReplacementIds.length === 161 && new Set(allReplacementIds).size === 161;
  const processed = Object.values(waves).reduce((sum, item) => sum + Number(item.processed || 0), 0);
  const passed = replacementIdentityValid && processed === 161 && Object.values(waves).every((item) => item.passed);
  return {
    expected: 161,
    processed,
    waves,
    replacement_identity_valid:replacementIdentityValid,
    passed,
    blockers: [...Object.values(waves).flatMap((item) => item.blockers), ...(replacementIdentityValid ? [] : ["replacement_manifest_or_cardinality_invalid"]), ...(processed === 161 ? [] : ["replacement_processed_count_not_161"])],
  };
}

function frozen13Assessment() {
  const waves = Object.fromEntries(Object.entries(assets.frozen13.ids_by_wave).map(([wave, ids]) => [
    wave,
    waveAssessment(wave, paths.frozen13[wave], ids, `${wave}-frozen13`),
  ]));
  const scores = Object.values(waves).flatMap((item) => {
    const scorecard = readJson(paths.frozen13[item.wave].scorecard);
    return scorecard.items || [];
  });
  const passed = Object.values(waves).every((item) => item.passed) && scores.length === 13 &&
    scores.every((item) => item.status === "pass" && !(item.critical_failure_signals || []).length);
  return {
    expected: 13,
    processed: Object.values(waves).reduce((sum, item) => sum + Number(item.processed || 0), 0),
    policy: "13/13 pass with zero critical failure and zero run error",
    waves,
    passed,
    blockers: [...new Set([...Object.values(waves).flatMap((item) => item.blockers), ...(passed ? [] : ["frozen13_gate_failed"])])],
  };
}

function stripPayloads(run) {
  const { manifest, results, scorecard, ...compact } = run;
  return compact;
}

const assessments = {};
const requiredIndex = STAGE_ORDER.indexOf(stage);
if (requiredIndex >= STAGE_ORDER.indexOf("critical4")) assessments.critical4 = criticalAssessment();
if (requiredIndex >= STAGE_ORDER.indexOf("full69")) assessments.full69 = full69Assessment();
if (requiredIndex >= STAGE_ORDER.indexOf("topic161")) assessments.topic161 = topic161Assessment();
if (requiredIndex >= STAGE_ORDER.indexOf("frozen13")) assessments.frozen13 = frozen13Assessment();
for (const [name, assessment] of Object.entries(assessments)) {
  check(`${name}_failed`, assessment.passed, { blockers: assessment.blockers });
}

const passed = blockers.length === 0;
const report = {
  version: `${VISIBLE_QUALIFICATION_VERSION}-gate-v1`,
  generated_at: now(),
  run_label: label,
  stage,
  status: passed ? (stage === "final" ? "passed_owner_authorised_visible_qualification" : "stage_passed") : "failed",
  passed,
  owner_authorised_visible_qualification: true,
  independent_legal_semantic_review: false,
  release_authorised: false,
  sealed_unseen_accessed: false,
  sealed_unseen_authorised: false,
  checkpoint: {
    model_id: checkpoint.modelId,
    training_execution: expectedTrainingExecution,
    expected_identity: checkpoint.expectedIdentity,
    artifacts: checkpoint.artifacts,
    checkpoint_selection: checkpoint.artifacts.checkpoint_selection,
    training_run_manifest: checkpoint.artifacts.training_run_manifest,
    adapter_weights: checkpoint.artifacts.adapter_weights,
    adapter_config: checkpoint.artifacts.adapter_config,
    base_model_weights: checkpoint.artifacts.base_model_weights,
  },
  thresholds: {
    critical4: "4/4 pass; zero critical failures, timeouts and run errors",
    full69: { suites: V1_SUITE_GATES, zero_critical_failures: true, zero_run_errors: true },
    topic161: V2_DIAGNOSTIC_GATE,
    frozen13: "13/13 pass; zero critical failures and run errors",
  },
  checks,
  assessments,
  blockers: [...new Set(blockers)],
  qualification_boundary: "Visible development qualification only. This is not independent legal review, sealed-unseen evaluation, production-SLO certification, or a release decision.",
};
writeJsonAtomic(gatePath, report);

if (stage === "final") {
  const rows = [
    ["Critical 4", assessments.critical4?.pass ?? 0, 4, assessments.critical4?.passed],
    ["Cycle v1 full", assessments.full69?.outcomes?.pass ?? 0, 69, assessments.full69?.passed],
    ["Wave 1–3 diagnostics", Object.values(assessments.topic161?.waves || {}).reduce((sum, item) => sum + Number(item.outcomes?.pass || 0), 0), 161, assessments.topic161?.passed],
    ["Frozen Wave 4 slice", Object.values(assessments.frozen13?.waves || {}).reduce((sum, item) => sum + Number(item.outcomes?.pass || 0), 0), 13, assessments.frozen13?.passed],
  ];
  writeTextAtomic(paths.summary, `# Post-training visible qualification — ${label}\n\nStatus: **${report.status}**.\n\n| Gate | Passed items | Expected | Result |\n|---|---:|---:|---|\n${rows.map(([name, pass, expected, ok]) => `| ${name} | ${pass} | ${expected} | ${ok ? "PASS" : "FAIL"} |`).join("\n")}\n\nThis is an owner-authorised visible development qualification. It did not access sealed-unseen material and is not an independent legal review, production-SLO certification, or release decision.\n\n${report.blockers.length ? `Blockers: ${report.blockers.join(", ")}.\n` : ""}`);
}

console.log(JSON.stringify({
  stage,
  status: report.status,
  passed: report.passed,
  blockers: report.blockers,
  gate_path: gatePath,
}, null, 2));
if (!passed) process.exitCode = 1;
