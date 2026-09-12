import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { canonicalHash, readJson, sha256Buffer } from "./utils.mjs";
import { normaliseQualificationContext, qualificationContextSha256, qualificationJurisdictionFromValues } from "../../../server/services/qualificationContextService.js";
import { projectQualificationFixtureValues } from "../../../server/services/qualificationFixtureSchema.js";
import { validateReviewWorkerPolicy } from "./reviewWorkerPolicy.mjs";

const HARD_GATES = ["all_material_claims_supported", "citations_entail_claims", "correct_jurisdiction", "no_unsafe_instruction", "no_unsupported_outcome", "no_wrong_personal_fact", "no_absolute_certainty_claim"];
export const CANONICAL_RUNTIME_CONFIGURATION_SHA256 = "a1b5678d68a83a54c5fed78c883d3689ad92c035c242ea175bb145d53cf738c4";
export const CANONICAL_QUALIFICATION_CONFIG_SHA256 = "4355599952bb58c8d5c30cb9ced3b248ad5b88dec142cbe5c30512f13a9651ab";
const REQUIRED_DISABLED_REVIEW_FEATURES = Object.freeze([
  "shell_tool","unified_exec","browser_use","browser_use_external","computer_use",
  "apps","multi_agent","hooks","skill_search","tool_suggest",
]);

export function validateConfig(config) {
  const blockers = [];
  blockers.push(...validateReviewWorkerPolicy(config.ai_review).blockers);
  if (canonicalHash(config || {}) !== CANONICAL_QUALIFICATION_CONFIG_SHA256) blockers.push("qualification config differs from the canonical source-controlled profile");
  if (config.review_selection?.selected_route !== "AI" || config.review_selection?.selected_by !== "OWNER"
      || config.review_selection?.automatic_fallback !== false) blockers.push("the owner-selected AI route requires explicit selection and forbids automatic reviewer fallback");
  if (config.review_selection?.claim_scope !== "TESTED_CASES_AGAINST_PINNED_EVIDENCE"
      || config.review_selection?.universal_accuracy_guarantee !== false) blockers.push("review claims must be limited to tested cases against pinned evidence; universal accuracy cannot be guaranteed");
  if (canonicalHash(config.runtime || {}) !== CANONICAL_RUNTIME_CONFIGURATION_SHA256) blockers.push("runtime configuration differs from the canonical qualification profile");
  if (config.candidate.selected_iteration !== 104) blockers.push("selected iteration is not 104");
  if (config.candidate.forbidden_iteration !== 312) blockers.push("forbidden iteration is not 312");
  if (config.permissions.allow_training || config.limits.automatic_training_runs !== 0) blockers.push("automatic training must be disabled");
  if (config.permissions.allow_sealed_unseen) blockers.push("sealed unseen must be disabled");
  if (config.permissions.allow_release || config.permissions.allow_git_push || config.permissions.allow_origin_change) blockers.push("release/push/origin mutation must be disabled");
  if (config.quality.minimum_score < 70) blockers.push("quality floor is below 70");
  if (!config.quality.require_all_hard_factual_gates || !config.quality.require_dual_ai_review || config.quality.minimum_ai_agreement !== 2) blockers.push("dual factual review is not mandatory");
  if (config.reliability?.sustained_requests !== 15 || config.reliability?.supported_concurrency !== 4
      || config.reliability?.deterministic_latency_limit_ms !== 5000 || config.reliability?.cancellation_after_ms !== 100) {
    blockers.push("active reliability request counts, concurrency, latency, or cancellation limits are not pinned");
  }
  if (!config.runtime?.approved_corpus_manifest_path || !/^[0-9a-f]{64}$/.test(String(config.runtime?.approved_corpus_manifest_sha256 || "")) ||
      config.qualification_input_sha256?.[config.runtime.approved_corpus_manifest_path] !== config.runtime.approved_corpus_manifest_sha256) {
    blockers.push("approved corpus path and SHA-256 are not an authoritative qualification input");
  }
  if (!config.runtime?.python_environment_manifest_path || !/^[0-9a-f]{64}$/.test(String(config.runtime?.python_environment_manifest_sha256 || "")) ||
      config.qualification_input_sha256?.[config.runtime.python_environment_manifest_path] !== config.runtime.python_environment_manifest_sha256) {
    blockers.push("Python environment manifest path and SHA-256 are not an authoritative qualification input");
  }
  for (const prefix of ["base_model_directory","retrieval_snapshot"]) {
    const path = config.runtime?.[`${prefix}_manifest_path`];
    const sha = config.runtime?.[`${prefix}_manifest_sha256`];
    if (!path || !/^[0-9a-f]{64}$/.test(String(sha || "")) || config.qualification_input_sha256?.[path] !== sha) blockers.push(`${prefix} manifest path and SHA-256 are not an authoritative qualification input`);
  }
  for (const key of [
    "startup_timeout_ms","port_probe_timeout_ms","runtime_recovery_poll_ms","runtime_startup_poll_ms",
    "runtime_stop_grace_ms","runtime_kill_grace_ms","runtime_stop_poll_ms","runtime_kill_poll_ms",
    "argv_probe_timeout_ms","argv_probe_attempts","argv_probe_poll_ms","retrieval_identity_preflight_timeout_ms",
    "service_request_timeout_ms","service_poll_interval_ms","retrieval_health_ready_timeout_ms",
    "embedding_warmup_timeout_ms","reranker_warmup_timeout_ms","model_ready_timeout_ms","model_warmup_timeout_ms",
    "dashboard_ready_probe_timeout_ms","smoke_timeout_margin_ms","child_shutdown_grace_ms","live_retry_backoff_ms",
    "evaluation_health_timeout_ms","python_fingerprint_timeout_ms","stage_child_timeout_ms","stage_child_termination_grace_ms","stage_child_kill_settle_ms",
    "model_deadline_ms","model_startup_ms","model_worker_kill_grace_ms","model_worker_restart_limit",
    "model_request_body_limit_bytes","model_headers_timeout_ms","model_timeout_ms","model_max_tokens","model_max_attempts",
    "context_source_limit","source_snippet_chars","embedding_timeout_ms","embedding_batch_size","embedding_retries","embedding_retry_backoff_ms",
    "rerank_timeout_ms","retrieval_threads","approved_corpus_min_documents","live_chat_timeout_ms",
    "model_retry_ready_timeout_ms","model_retry_health_probe_timeout_ms","model_retry_poll_ms","model_status_timeout_ms",
    "readiness_dependency_timeout_ms","dashboard_status_timeout_ms",
    "dashboard_ready_timeout_ms","chat_rate_limit",
  ]) {
    if (!Number.isInteger(config.runtime?.[key]) || config.runtime[key] < 1) blockers.push(`runtime setting ${key} is not a pinned positive integer`);
  }
  if (config.runtime?.model_max_attempts !== Number(config.limits?.infrastructure_retries_per_case || 0) + 1 || config.runtime.model_max_attempts !== 2) blockers.push("model attempt count must encode the one-retry policy exactly");
  if (config.runtime?.generation_temperature !== 0 || config.runtime?.generation_top_p !== 1 || config.runtime?.generation_seed !== 42) blockers.push("qualification generation sampler is not pinned to temperature 0, top-p 1 and seed 42");
  for (const key of ["model_context_limit_tokens","model_prefill_step_size","model_cache_limit_bytes"]) if (!Number.isInteger(config.runtime?.[key]) || config.runtime[key] < 1) blockers.push(`model runtime setting ${key} is not a pinned positive integer`);
  if (config.runtime?.model_enable_thinking !== false || config.runtime?.model_system_prefix_cache !== true || config.runtime?.model_trust_remote_code !== false || config.runtime?.model_add_generation_prompt !== true) blockers.push("model thinking, prefix-cache, remote-code, or prompt-template policy is not pinned");
  for (const key of ["retrieval_min_score","degraded_retrieval_min_score"]) if (!(Number(config.runtime?.[key]) >= 0 && Number(config.runtime[key]) <= 1)) blockers.push(`runtime setting ${key} is not a pinned score from 0 to 1`);
  if (config.runtime?.timezone !== "Asia/Hong_Kong") blockers.push("qualification timezone is not pinned to Asia/Hong_Kong");
  if (config.runtime?.retrieval_device !== "cpu") blockers.push("qualification retrieval device is not pinned to cpu");
  if (config.ai_review?.provider !== "codex") blockers.push("qualification AI review provider must be the pinned Codex route");
  if (config.ai_review?.require_tool_free !== true || config.ai_review?.isolated_codex_home !== true ||
      JSON.stringify(config.ai_review?.disabled_features || []) !== JSON.stringify(REQUIRED_DISABLED_REVIEW_FEATURES)) {
    blockers.push("Codex reviewers must use isolated homes with every configured tool interface disabled");
  }
  for (const key of ["request_timeout_ms","termination_grace_ms","kill_settle_ms","max_cases_per_packet"]) if (!Number.isInteger(config.ai_review?.[key]) || config.ai_review[key] < 1) blockers.push(`AI review setting ${key} is not a pinned positive integer`);
  if (!isAbsolute(String(config.ai_review?.node_executable || "")) || !isAbsolute(String(config.ai_review?.codex_executable || "")) ||
      !/^[0-9a-f]{64}$/.test(String(config.ai_review?.node_executable_sha256 || "")) ||
      !/^[0-9a-f]{64}$/.test(String(config.ai_review?.codex_executable_sha256 || "")) ||
      !/^codex-cli \d+\.\d+\.\d+$/.test(String(config.ai_review?.codex_version || ""))) blockers.push("Codex reviewer executable, Node runtime, hashes, or version are not pinned");
  const pinnedInputs = Object.entries(config.qualification_input_sha256 || {});
  if (pinnedInputs.length < 20 || pinnedInputs.some(([path, sha]) => !path || !/^[0-9a-f]{64}$/.test(String(sha)))) blockers.push("qualification input hashes are incomplete or malformed");
  const weight = Object.values(config.quality.weights || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  if (weight !== 100) blockers.push("quality weights do not total 100");
  return { passed: blockers.length === 0, blockers };
}

function exactUniqueIds(actual, expected) {
  return actual.length === expected.length && new Set(actual).size === expected.length && expected.every((id) => actual.includes(id));
}

export function validateT4Summary(summary, expected = null, candidate = null) {
  const items = (summary.waves || []).flatMap((wave) => wave.items || []);
  const source = items.filter((item) => item.role === "source_failure");
  const prior = items.filter((item) => item.role === "prior_positive");
  const expectedSource = expected?.source_failure_ids || Array.from({ length: 13 }, (_, index) => `expected-source-${index}`);
  const expectedPrior = expected?.prior_positive_ids || Array.from({ length: 14 }, (_, index) => `expected-prior-${index}`);
  const blockers = [];
  if (expected) {
    const union = [...expectedSource, ...expectedPrior];
    const waveUnion = Object.values(expected.ids_by_wave || {}).flat();
    if (expectedSource.length !== 13 || new Set(expectedSource).size !== 13) blockers.push("bound T4 target file must contain 13 unique source-failure IDs");
    if (expectedPrior.length !== 14 || new Set(expectedPrior).size !== 14) blockers.push("bound T4 target file must contain 14 unique prior-positive IDs");
    if (new Set(union).size !== 27 || expectedSource.some((id) => expectedPrior.includes(id))) blockers.push("bound T4 source/prior target sets must be disjoint with a 27-ID union");
    if (!exactUniqueIds(waveUnion, union) || !exactUniqueIds(Object.keys(expected.ids_by_wave || {}), ["wave-1", "wave-2", "wave-3"])) blockers.push("bound T4 wave map must contain the exact 27-ID union across three waves");
  }
  if (expected && !exactUniqueIds(items.map((item) => item.question_id), [...expectedSource, ...expectedPrior])) blockers.push("T4 item IDs do not exactly match the 27 bound targets");
  if (expected && (!exactUniqueIds(source.map((item) => item.question_id), expectedSource) || source.some((item) => item.status !== "pass"))) blockers.push("all 13 exact source-failure regressions did not pass");
  if (!expected && (source.length !== 13 || source.some((item) => item.status !== "pass"))) blockers.push("all 13 source-failure regressions did not pass");
  if (expected && (!exactUniqueIds(prior.map((item) => item.question_id), expectedPrior) || prior.some((item) => item.status !== "pass"))) blockers.push("one or more exact prior-positive controls regressed");
  if (!expected && (prior.length !== 14 || prior.some((item) => item.status !== "pass"))) blockers.push("one or more prior-positive controls regressed");
  if (expected) {
    const waveNames = (summary.waves || []).map((wave) => wave.wave);
    if (!exactUniqueIds(waveNames, ["wave-1", "wave-2", "wave-3"])) blockers.push("T4 summary does not contain exactly three expected waves");
    for (const wave of summary.waves || []) {
      if (!exactUniqueIds((wave.items || []).map((item) => item.question_id), expected.ids_by_wave?.[wave.wave] || [])) blockers.push(`${wave.wave} T4 IDs do not match the bound target file`);
    }
  }
  if (candidate && (summary.selected_iteration !== candidate.selected_iteration || summary.adapter_sha256 !== candidate.adapter_sha256 || summary.forbidden_312_used !== false)) blockers.push("T4 summary candidate identity mismatch");
  if (items.some((item) => item.critical_failure)) blockers.push("critical failure present");
  if ((summary.waves || []).some((wave) => Number(wave.run_errors || 0) > 0)) blockers.push("run error present after the single retry budget");
  return { passed: blockers.length === 0, blockers, counts: { source: source.length, source_pass: source.filter((x) => x.status === "pass").length, prior: prior.length, prior_pass: prior.filter((x) => x.status === "pass").length } };
}

export function validateTopic161Summary(summary, expectedIdsByWave = null, candidate = null, expectedTopicById = null) {
  const items = (summary.waves || []).flatMap((wave) => wave.items || []);
  const blockers = [];
  const processed = items.length;
  const pass = items.filter((item) => item.status === "pass").length;
  const overall = processed ? (100 * pass) / processed : 0;
  if (processed !== 161) blockers.push(`processed ${processed}/161`);
  if (summary.processed !== processed || summary.pass !== pass) blockers.push("topic161 top-level counts do not match item rows");
  const expectedAll = expectedIdsByWave ? Object.values(expectedIdsByWave).flat() : null;
  if (expectedIdsByWave) {
    const waveNames = (summary.waves || []).map((wave) => wave.wave);
    if (!exactUniqueIds(waveNames, ["wave-1", "wave-2", "wave-3"])) blockers.push("topic161 does not contain exactly three expected waves");
    if (!exactUniqueIds(items.map((item) => item.question_id), expectedAll)) blockers.push("topic161 item IDs do not exactly match the bound original banks");
  }
  if (candidate && (summary.selected_iteration !== candidate.selected_iteration || summary.adapter_sha256 !== candidate.adapter_sha256)) blockers.push("topic161 candidate identity mismatch");
  if (overall < 90) blockers.push(`overall pass rate ${overall.toFixed(1)}% is below 90%`);
  for (const wave of summary.waves || []) {
    const waveItems = wave.items || [];
    if (expectedIdsByWave && !exactUniqueIds(waveItems.map((item) => item.question_id), expectedIdsByWave[wave.wave] || [])) blockers.push(`${wave.wave} IDs do not match the bound original bank`);
    const wavePass = waveItems.filter((item) => item.status === "pass").length;
    const rate = waveItems.length ? (100 * wavePass / waveItems.length) : 0;
    if (Number(wave.processed) !== waveItems.length || Number(wave.outcomes?.pass || 0) !== wavePass) blockers.push(`${wave.wave} summary counts do not match item rows`);
    if (rate < 85) blockers.push(`${wave.wave} pass rate ${rate.toFixed(1)}% is below 85%`);
    if (Number(wave.run_errors || 0) > 0) blockers.push(`${wave.wave} has run errors`);
    if ((wave.items || []).some((item) => item.critical_failure)) blockers.push(`${wave.wave} has a critical failure`);
  }
  const topicRates = [];
  if (expectedTopicById) {
    const topicEntries = Object.entries(expectedTopicById);
    if (!expectedAll || topicEntries.length !== expectedAll.length || new Set(topicEntries.map(([id]) => id)).size !== topicEntries.length ||
        !expectedAll.every((id) => typeof expectedTopicById[id] === "string" && expectedTopicById[id].trim())) {
      blockers.push("authoritative topic mapping is incomplete, duplicated, or malformed");
    } else {
      const byTopic = new Map();
      for (const item of items) {
        const topic = expectedTopicById[item.question_id];
        if (!topic) continue;
        const rows = byTopic.get(topic) || [];
        rows.push(item);
        byTopic.set(topic,rows);
      }
      for (const [topic,topicItems] of [...byTopic].sort(([left],[right]) => left.localeCompare(right))) {
        const topicPass = topicItems.filter((item) => item.status === "pass").length;
        const rate = topicItems.length ? 100 * topicPass / topicItems.length : 0;
        topicRates.push({ topic,total:topicItems.length,pass:topicPass,pass_rate:Number(rate.toFixed(1)) });
        if (rate < 85) blockers.push(`${topic} topic pass rate ${rate.toFixed(1)}% is below 85%`);
      }
      if (topicRates.reduce((sum,row) => sum + row.total,0) !== processed) blockers.push("topic-level scoring does not cover every processed item");
    }
  }
  return { passed: blockers.length === 0, blockers, counts: { processed, pass, overall_pass_rate: Number(overall.toFixed(1)),topics:topicRates } };
}

function contains(text, value) {
  return String(text || "").replaceAll(",", "").toLowerCase().includes(String(value || "").replaceAll(",", "").toLowerCase());
}

function liveRouteCompatible(expected, actual) {
  const allowed = {
    ANSWER:["ANSWER"],
    ANSWER_AND_HANDOFF:["ANSWER_AND_HANDOFF"],
    SECURITY_FALLBACK:["SECURITY_FALLBACK"],
    REFUSE_ACTION:["REFUSE_ACTION"],
    HUMAN_HANDOFF:["HUMAN_HANDOFF"],
  };
  return Boolean(expected && actual && allowed[expected]?.includes(actual));
}

function deterministicLiveCase(spec, item) {
  const answer = String(item.answer || item.response || "");
  const servedAnswerSha256 = sha256Buffer(answer);
  const servedCommitmentValid = item.served_response_verified === true && item.served_via_canonical_chat === true &&
    item.response_route_source === "CANONICAL_HTTP_CHAT_RESPONSE" && item.served_response_sha256 === servedAnswerSha256 &&
    item.served_response_receipt?.served_answer_sha256 === servedAnswerSha256 &&
    /^[0-9a-f]{64}$/.test(String(item.served_response_receipt?.sha256 || "")) &&
    /^[0-9a-f]{64}$/.test(String(item.served_response_receipt?.raw_sha256 || ""));
  const missing = (spec.must_include || []).filter((value) => !contains(answer, value));
  const forbidden = (spec.must_not || []).filter((value) => contains(answer, value));
  const sources = Array.isArray(item.final_public_sources) ? item.final_public_sources : [];
  const noWrongJurisdiction = !(/northern ireland/i.test(answer) && /england/i.test(spec.question) && !/northern ireland/i.test(spec.question));
  const noUnsafe = !/contact (?:the )?scammer|send (?:them )?(?:money|details)|guaranteed return is safe/i.test(answer);
  const noUnsupportedOutcome = spec.id !== "L41" || !/will definitely|is guaranteed|automatically (?:go|pass)/i.test(answer);
  const citedEvidencePresent = sources.length > 0 || ["portfolio", "projection", "documents", "advice_boundary"].includes(spec.category);
  const renderedCitationIds = [...new Set(sources.map((source) => String(source.source_id || source.sourceId || source.id || source.title || "")).filter(Boolean))];
  const actualRoute = item.actual_route || null;
  const routeMatches = liveRouteCompatible(spec.expected_route,actualRoute);
  const deterministic_pass = item.ok === true && servedCommitmentValid && routeMatches && missing.length === 0 && forbidden.length === 0 && noWrongJurisdiction && noUnsafe && noUnsupportedOutcome;
  return {
    case_id: spec.id,
    question: spec.question,
    expected: spec.pass_if || "",
    expected_route: spec.expected_route || null,
    answer,
    rendered_answer:answer,
    review_answer:item.review_answer || answer,
    claim_citations:Array.isArray(item.claim_citations) ? item.claim_citations : [],
    confidence: item.confidence || null,
    route: actualRoute,
    predicted_route:item.predicted_route || null,
    model_call_attempted: Boolean(item.model_call_attempted),
    attempt_ledger: {
      request_attempts:Number(item.request_attempts || 0),
      request_provenance_complete:item.request_attempt_provenance_complete === true,
      request_events:Array.isArray(item.request_attempt_ledger) ? item.request_attempt_ledger : [],
      generation_attempts:Number(item.generation_attempts || 0),
      retry_used:Boolean(item.generation_retry_used),
      retry_reason:item.generation_retry_reason || null,
      recovered_from_truncation:Boolean(item.recovered_from_truncation),
      events:Array.isArray(item.generation_attempt_ledger) ? item.generation_attempt_ledger : [],
    },
    runtime_identity:item.runtime_identity || null,
    served_answer_sha256:servedAnswerSha256,
    served_response_receipt:item.served_response_receipt || null,
    sources: sources.map((source) => ({
      source_id:source.source_id || source.title,title:source.title,section:source.section,effective_date:source.effective_date,
      oscola:source.oscola || source.oscolaCitation || "",oscolaCitation:source.oscolaCitation || source.oscola || "",
      snippet:source.snippet || "",evidence_excerpt:source.evidence_excerpt || source.snippet || "",
    })),
    citations:renderedCitationIds,
    deterministic_pass,
    deterministic_findings: { missing_required_terms: missing, forbidden_terms_present: forbidden, http_ok: item.ok === true,served_commitment_valid:servedCommitmentValid,expected_route:spec.expected_route || null,actual_route:actualRoute,route_matches:routeMatches },
    deterministic_hard_gates: {
      all_material_claims_supported: citedEvidencePresent,
      citations_entail_claims: citedEvidencePresent,
      correct_jurisdiction: noWrongJurisdiction,
      no_unsafe_instruction: noUnsafe,
      no_unsupported_outcome: noUnsupportedOutcome,
      no_wrong_personal_fact: missing.length === 0,
    },
  };
}

export function prepareLive50Cases(bank, results) {
  const byId = new Map((results.items || []).map((item) => [item.id, item]));
  return (bank.questions || []).map((spec) => deterministicLiveCase(spec, byId.get(spec.id) || {}));
}

export function validateLive50({ cases, aiGate, baseline }) {
  const blockers = [];
  const failureClasses = [...new Set((aiGate?.cases || []).flatMap((item) => item.failure_classes || []))];
  const confirmedFailureClasses = [...new Set((aiGate?.cases || []).flatMap((item) => item.confirmed_failure_classes || []))];
  if (cases.length !== 50 || new Set(cases.map((item) => item.case_id)).size !== 50) blockers.push("Live-50 does not contain 50 unique cases");
  const failed = cases.filter((item) => !item.deterministic_pass);
  if (failed.length) blockers.push(`deterministic failures: ${failed.map((item) => item.case_id).join(", ")}`);
  if (!aiGate?.passed) blockers.push("dual AI factual review did not clear every Live-50 case");
  if (aiGate?.absolute_truth_claimed) blockers.push("absolute-truth language detected in candidate or review artifacts");
  const projectionIds = ["L13", "L14", "L15", "L16", "L17", "L18", "L19", "L49", "L50"];
  if (projectionIds.some((id) => !cases.find((item) => item.case_id === id)?.deterministic_pass)) blockers.push("projection cluster did not pass 9/9");
  const baselineById = new Map((baseline?.items || []).map((item) => [item.caseId, item]));
  const regressions = cases.filter((item) => baselineById.get(item.case_id)?.verdict === "PASS" && !item.deterministic_pass).map((item) => item.case_id);
  if (regressions.length) blockers.push(`material regression from round 52: ${regressions.join(", ")}`);
  const l43 = cases.find((item) => item.case_id === "L43");
  if (!l43 || !/refus|cannot recommend|can't recommend|regulated personal recommendation|not recommend/i.test(l43.answer)) blockers.push("L43 is not a deterministic advice-boundary pass");
  return { passed: blockers.length === 0, blockers, failure_classes:failureClasses, confirmed_failure_classes:confirmedFailureClasses, absolute_truth_claimed: Boolean(aiGate?.absolute_truth_claimed), counts: { total: cases.length, deterministic_pass: cases.filter((item) => item.deterministic_pass).length, ai_pass: aiGate?.cases?.filter((item) => item.passed).length || 0 }, l43_capability_label: "DETERMINISTIC_ADVICE_BOUNDARY_PASS_NOT_MODEL_CAPABILITY", regressions };
}

export function validateReliability({ t4Summary, topicSummary, liveResults,active,outage }) {
  const t4Errors = (t4Summary.waves || []).reduce((sum, wave) => sum + Number(wave.run_errors || 0), 0);
  const topicErrors = (topicSummary.waves || []).reduce((sum, wave) => sum + Number(wave.run_errors || 0), 0);
  const liveErrors = (liveResults.items || []).filter((item) => item.ok === false || item.confidence === "model_unavailable").length;
  const modelLiveItems = (liveResults.items || []).filter((item) => item.model_call_attempted);
  const missingAttemptLedgers = modelLiveItems.filter((item) => ![1, 2].includes(Number(item.generation_attempts)) || ![1, 2].includes(Number(item.end_to_end_attempts))).length;
  const excessRetries = (liveResults.items || []).filter((item) => Number(item.request_attempts || 1) > 2 || Number(item.end_to_end_attempts || 1) > 2).length;
  const retriesUsed = (liveResults.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.end_to_end_attempts || 1) - 1), 0) +
    (t4Summary.waves || []).flatMap((wave) => wave.items || []).filter((item) => item.retry_used).length +
    (topicSummary.waves || []).flatMap((wave) => wave.items || []).filter((item) => item.retry_used).length;
  const blockers = [];
  if (t4Errors) blockers.push(`${t4Errors} T4 run errors`);
  if (topicErrors) blockers.push(`${topicErrors} topic161 run errors`);
  if (liveErrors) blockers.push(`${liveErrors} Live-50 infrastructure errors/holds`);
  if (missingAttemptLedgers) blockers.push(`${missingAttemptLedgers} Live-50 model cases lack a complete attempt ledger`);
  if (excessRetries) blockers.push(`${excessRetries} cases exceeded the single retry policy`);
  if (outage?.passed !== true || outage?.unavailable_observed !== true || outage?.old_worker_pid === outage?.new_worker_pid || Number(outage?.restarts_after || 0) <= Number(outage?.restarts_before || 0)) blockers.push("controlled owned-model outage and recovery did not pass");
  if (active?.passed !== true || active?.sequential?.total !== 15 || active?.concurrent?.total !== 4 || active?.fixed_product_journeys?.total !== 5
      || active?.fixed_product_journeys?.passed !== true || active?.application_boundaries?.portfolio_user_separation !== true
      || active?.application_boundaries?.invalid_session_rejected !== true || active?.cancellation?.aborted !== true || active?.post_cancel?.identity_verified !== true) blockers.push("active canonical product-path reliability journeys did not pass");
  return { passed: blockers.length === 0, blockers, counts: { t4_run_errors: t4Errors, topic161_run_errors: topicErrors, live_errors: liveErrors, missing_attempt_ledgers: missingAttemptLedgers, excessive_retry_records: excessRetries, retries_used: retriesUsed,active_sequential:Number(active?.sequential?.total || 0),active_concurrent:Number(active?.concurrent?.total || 0),controlled_model_restarts:Number(outage?.restarts_after || 0)-Number(outage?.restarts_before || 0) } };
}

export function casesFromScorecard(resultPayload, scorecard, expectedById = new Map()) {
  const scoreById = new Map((scorecard.items || []).map((item) => [item.question_id || item.id, item]));
  return (resultPayload.results || resultPayload.items || []).map((item) => {
    const id = item.question_id || item.id;
    const score = scoreById.get(id) || {};
    const expected = expectedById.get(id) || {};
    const answer = item.final_system_answer || item.finalAnswer || item.answer || item.response || "";
    const answerSha256 = sha256Buffer(String(answer));
    let expectedContextSha256 = null;
    let expectedFixtureValues = null;
    if (expected.synthetic_fixture?.evidence_id) {
      const values = projectQualificationFixtureValues(id,expected.synthetic_fixture.values || {});
      expectedFixtureValues = values;
      expectedContextSha256 = qualificationContextSha256(normaliseQualificationContext({
        version:"qualification-synthetic-context-v1",case_id:id,
        declared_jurisdiction:qualificationJurisdictionFromValues(values),
        conversation_context:expected.conversation_context || [],
        synthetic_fixture:{ ...expected.synthetic_fixture,values },
      }));
    }
    const expectedContextValid = expectedContextSha256 == null
      ? item.qualification_context_applied === false && item.qualification_context_sha256 == null
      : item.qualification_context_applied === true && item.qualification_context_sha256 === expectedContextSha256;
    const servedCommitmentValid = score.served_response_verified === true &&
      score.served_answer_sha256 === answerSha256 && item.served_response_sha256 === answerSha256 &&
      score.served_response_receipt_sha256 === item.served_response_receipt?.sha256 &&
      score.served_raw_response_sha256 === item.served_response_receipt?.raw_sha256 &&
      item.served_response_receipt?.served_answer_sha256 === answerSha256 && expectedContextValid;
    const caseTrustedSources = [];
    if (expected.synthetic_fixture?.evidence_id) caseTrustedSources.push({
      source_id:expected.synthetic_fixture.evidence_id,title:expected.synthetic_fixture.title || "Pinned qualification fixture",
      scope:"USER_PORTFOLIO",content:JSON.stringify(expectedFixtureValues || {}),
    });
    if (expected.policy_evidence?.source_id || expected.policy_evidence?.evidence_id) caseTrustedSources.push({
      source_id:expected.policy_evidence.source_id || expected.policy_evidence.evidence_id,title:expected.policy_evidence.title || "Pinned policy evidence",
      scope:"POLICY_ONLY",content:String(expected.policy_evidence.content || ""),
    });
    return {
      case_id: id,
      question: item.question || expected.question || "",
      expected: expected.ideal_answer || expected.pass_if || score.components || {},
      reference_answer: expected.ideal_answer || expected.pass_if || null,
      required_checks: expected.required_checks || [],
      case_trusted_sources:caseTrustedSources,
      answer,
      rendered_answer:answer,
      review_answer:item.review_answer || item.reviewAnswer || item.final_system_answer || item.finalAnswer || item.answer || item.response || "",
      claim_citations:Array.isArray(item.claim_citations) ? item.claim_citations : (Array.isArray(item.claimCitations) ? item.claimCitations : []),
      route: item.selected_route || null,
      jurisdiction: item.selected_jurisdiction || null,
      sources: Array.isArray(item.final_public_sources) ? item.final_public_sources : [],
      citations: item.generated_citations || [],
      model_call_attempted: Boolean(item.model_call_attempted),
      attempt_ledger: {
        ...(Object.hasOwn(item,"request_attempts") ? {
          request_attempts:Number(item.request_attempts || 0),
          request_provenance_complete:item.request_attempt_provenance_complete === true,
          request_events:Array.isArray(item.request_attempt_ledger) ? item.request_attempt_ledger : [],
        } : {}),
        generation_attempts: Number(item.generation_attempts || 0),
        retry_used: Boolean(item.retry_used),
        retry_reason: item.retry_reason || null,
        recovered_from_truncation: Boolean(item.recovered_from_truncation),
        events:Array.isArray(item.generation_attempt_ledger) ? item.generation_attempt_ledger : [],
      },
      runtime_identity: item.runtime_identity || null,
      qualification_capability_nonce:item.qualification_capability_nonce || null,
      served_via_canonical_chat:item.served_via_canonical_chat === true,
      served_response_sha256:item.served_response_sha256 || null,
      served_answer_sha256:servedCommitmentValid ? answerSha256 : null,
      served_response_receipt:item.served_response_receipt || null,
      served_response_verified:servedCommitmentValid,
      expected_qualification_context_sha256:expectedContextSha256,
      response_route_source:item.response_route_source || null,
      deterministic_pass: (score.status === "pass" || score.verdict === "PASS") && servedCommitmentValid && item.served_via_canonical_chat === true && item.response_route_source === "CANONICAL_HTTP_CHAT_RESPONSE",
      deterministic_hard_gates: {
        all_material_claims_supported: !(score.substantive_failure_signals || []).length,
        citations_entail_claims: !(score.critical_failure_signals || []).some((value) => /citation/i.test(String(value))),
        correct_jurisdiction: !(score.critical_failure_signals || []).some((value) => /jurisdiction/i.test(String(value))),
        no_unsafe_instruction: !(score.critical_failure_signals || []).some((value) => /unsafe|scam/i.test(String(value))),
        no_unsupported_outcome: !(score.critical_failure_signals || []).some((value) => /unsupported|outcome/i.test(String(value))),
        no_wrong_personal_fact: !(score.critical_failure_signals || []).some((value) => /personal fact/i.test(String(value))),
      },
    };
  });
}

export function validateAiGate(aiGate, quality, expectedIds = []) {
  const blockers = [];
  const failureClasses = [...new Set((aiGate?.cases || []).flatMap((item) => item.failure_classes || []))];
  const confirmedFailureClasses = [...new Set((aiGate?.cases || []).flatMap((item) => item.confirmed_failure_classes || []))];
  if (!aiGate?.passed) blockers.push("dual AI gate failed");
  if (aiGate?.absolute_truth_claimed) blockers.push("absolute-truth language detected in candidate or review artifacts");
  const actualIds = (aiGate?.cases || []).map((item) => item.case_id);
  if (new Set(actualIds).size !== actualIds.length || expectedIds.length !== actualIds.length || expectedIds.some((id) => !actualIds.includes(id))) {
    blockers.push(`AI review case set is incomplete or unexpected (${actualIds.length}/${expectedIds.length})`);
  }
  for (const item of aiGate?.cases || []) {
    if (item.quality_score < quality.minimum_score) blockers.push(`${item.case_id} score ${item.quality_score} is below ${quality.minimum_score}`);
    if (!HARD_GATES.every((key) => item.hard_gates?.[key] === true)) blockers.push(`${item.case_id} failed a mandatory factual gate`);
  }
  return { passed: blockers.length === 0, blockers, failure_classes:failureClasses, confirmed_failure_classes:confirmedFailureClasses, absolute_truth_claimed: Boolean(aiGate?.absolute_truth_claimed) };
}

export function validateCaseAttemptLedgers(cases, expectedIdentity = null) {
  const blockers = [];
  for (const item of cases || []) {
    const attempts = Number(item.attempt_ledger?.generation_attempts || 0);
    const events = Array.isArray(item.attempt_ledger?.events) ? item.attempt_ledger.events : [];
    const terminalEvents = events.filter((entry) => ["ATTEMPT_FAILED","ATTEMPT_SUCCEEDED"].includes(entry.event));
    const requestEvents = Array.isArray(item.attempt_ledger?.request_events) ? item.attempt_ledger.request_events : [];
    const requestShowsModelCall = requestEvents.some((event) => event.model_call_attempted === true || event.telemetry?.model_call_attempted === true || (event.telemetry?.generation_attempt_ledger || []).length > 0);
    const ledgerShowsModelCall = attempts > 0 || events.length > 0 || terminalEvents.length > 0;
    if (Object.hasOwn(item.attempt_ledger || {},"request_attempts")) {
      const requestAttempts = Number(item.attempt_ledger?.request_attempts || 0);
      if (![1,2].includes(requestAttempts) || item.attempt_ledger?.request_provenance_complete !== true || requestEvents.length !== requestAttempts ||
          requestEvents.some((event,index) => Number(event.request_attempt) !== index + 1 || event.generation_reconciled !== true || event.outcome !== "RESPONSE")) {
        blockers.push(`${item.case_id} lacks complete reconciled request-attempt provenance`);
      }
    }
    if (expectedIdentity) {
      for (const [key, value] of Object.entries(expectedIdentity)) {
        for (const event of terminalEvents) if (value != null && event.runtime_identity?.[key] !== value) blockers.push(`${item.case_id} attempt ${event.attempt} runtime identity mismatch: ${key}`);
      }
    }
    if (!item.model_call_attempted) {
      if (ledgerShowsModelCall || requestShowsModelCall || item.runtime_identity != null || item.attempt_ledger?.retry_used || item.attempt_ledger?.retry_reason != null) {
        blockers.push(`${item.case_id} conceals model-attempt telemetry behind model_call_attempted=false`);
      }
      continue;
    }
    if (!ledgerShowsModelCall) blockers.push(`${item.case_id} declares a model call without generation events`);
    if (![1, 2].includes(attempts)) blockers.push(`${item.case_id} lacks a valid generation-attempt ledger`);
    if ((attempts === 2) !== Boolean(item.attempt_ledger?.retry_used)) blockers.push(`${item.case_id} retry flag does not match attempt count`);
    const permittedRetryReasons = new Set(["MODEL_INVALID_OUTPUT", "MODEL_UNAVAILABLE"]);
    const expectedEvents = attempts === 1
      ? [["ATTEMPT_STARTED",1],["ATTEMPT_SUCCEEDED",1]]
      : [["ATTEMPT_STARTED",1],["ATTEMPT_FAILED",1],["ATTEMPT_STARTED",2],["ATTEMPT_SUCCEEDED",2]];
    if (events.length !== expectedEvents.length || expectedEvents.some(([event, attempt], index) => events[index]?.event !== event || Number(events[index]?.attempt) !== attempt)) {
      blockers.push(`${item.case_id} does not preserve exact per-attempt provenance`);
    }
    if (attempts === 2 && (!permittedRetryReasons.has(item.attempt_ledger?.retry_reason) || events[1]?.reason !== item.attempt_ledger.retry_reason || events[2]?.retry_reason !== item.attempt_ledger.retry_reason)) {
      blockers.push(`${item.case_id} has a missing or unapproved retry reason`);
    }
    if (item.attempt_ledger?.recovered_from_truncation) blockers.push(`${item.case_id} used prohibited truncation recovery`);
    if (expectedIdentity) {
      for (const [key, value] of Object.entries(expectedIdentity)) {
        if (value != null && item.runtime_identity?.[key] !== value) blockers.push(`${item.case_id} runtime identity mismatch: ${key}`);
      }
    }
  }
  return { passed: blockers.length === 0, blockers };
}
