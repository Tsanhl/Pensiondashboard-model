import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ANSWER_POLICY_VERSION, ANSWER_SYSTEM_POLICY } from "../server/prompts/answerPolicy.js";

const ROOT = resolve(".");
const OUT = resolve(ROOT, "training/evaluation-cycle-v2/26-step130-rejected-topic161-20260902");
const ORIG = resolve(ROOT, "evaluation/topic161-original");
const VISQ7 = resolve(
  ROOT,
  "training/evaluation-cycle-v2/10-post-training-visible-qualification-v1-20260901/20260902-r51-step130-v7",
);

if (existsSync(OUT) && readdirSync(OUT).length) {
  throw new Error(`Rejected-candidate freeze directory is not empty: ${OUT}`);
}

const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => hashBytes(readFileSync(path));
const hashText = (value) => hashBytes(Buffer.from(String(value), "utf8"));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`);
};
const fileMeta = (rel) => {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) return { path: rel, missing: true };
  const st = statSync(path);
  return { path: rel, abs: path, bytes: st.size, sha256: hashFile(path), mtime: st.mtime.toISOString() };
};

const git = (args) =>
  spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 20_000_000 });
const origin = git(["remote", "get-url", "origin"]);
if (origin.status !== 0) throw new Error("Unable to read origin remote");
const originUrl = origin.stdout.trim();
if (originUrl !== "https://github.com/Tsanhl/Pensions-dashboard-.git") {
  throw new Error(`Origin remote must remain unchanged; found ${originUrl}`);
}
const head = git(["rev-parse", "HEAD"]).stdout.trim();
const status = git(["status", "--porcelain"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
const diffStat = git(["diff", "--stat", "HEAD", "--",
  "server/services/localModelService.js",
  "server/services/citationRendererService.js",
  "server/services/groundingService.js",
  "server/services/queryProcessorService.js",
  "server/services/retrievalService.js",
  "server/prompts/answerPolicy.js",
  "server/services/chatService.js",
  "scripts/evaluationCycleV1PostFixRegression.mjs",
  "scripts/evaluationCycleV2Wave1Run.mjs",
]).stdout;

const visq7 = readJson(resolve(VISQ7, "orchestration-manifest.json"));
const gateCritical4 = readJson(resolve(VISQ7, "gate-critical4.json"));
const gateFull69 = readJson(resolve(VISQ7, "gate-full69.json"));
const gateTopic161 = readJson(resolve(VISQ7, "gate-topic161.json"));
const r51 = readJson(resolve(ROOT, "Log/2026-09-02/live-round-51-adjudicated/immutable-round51-manifest.json"));
const r52Gate = readJson(resolve(ROOT, "Log/2026-09-02/live-round-52-final/development-gate.json"));
const r52Adj = readJson(resolve(ROOT, "Log/2026-09-02/live-round-52-final/adjudicated-results.json"));
const checkpoint = readJson(resolve(ROOT, "training/evaluation-cycle-v2/25-cumulative-visible-training-v8-20260901/checkpoint-selection.json"));

const waves = ["wave-1", "wave-2", "wave-3"].map((wave) => {
  const scorecardPath = resolve(ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/scorecard.json`);
  const resultsPath = resolve(ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/results.json`);
  const goldPath = resolve(ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/gold/evaluation-gold.json`);
  const scorecard = readJson(scorecardPath);
  return {
    wave,
    pass_rate: scorecard.pass_rate,
    outcomes: scorecard.outcomes,
    run_errors: scorecard.run_errors,
    topics: scorecard.topics,
    results_sha256: hashFile(resultsPath),
    scorecard_sha256: hashFile(scorecardPath),
    gold_sha256: hashFile(goldPath),
    results_path: resultsPath,
    scorecard_path: scorecardPath,
    gold_path: goldPath,
  };
});

const currentCode = Object.fromEntries([
  "server/prompts/answerPolicy.js",
  "server/services/localModelService.js",
  "server/services/citationRendererService.js",
  "server/services/groundingService.js",
  "server/services/queryProcessorService.js",
  "server/services/retrievalService.js",
  "server/services/chatService.js",
  "server/services/modelContextService.js",
  "server/services/evidenceExcerptService.js",
  "server/services/pinnedRetrievalIdentity.js",
  "ml/pinned_mlx_worker.py",
  "ml/embedding_server.py",
  "models/model-manifest.json",
  "scripts/evaluationCycleV1PostFixRegression.mjs",
  "scripts/evaluationCycleV2Wave1Run.mjs",
].map((rel) => [rel, fileMeta(rel)]));

const visq7Code = visq7.code_artifacts || {};
const codeDiffs = Object.entries(currentCode)
  .filter(([rel, meta]) => visq7Code[rel] && !meta.missing && visq7Code[rel].sha256 !== meta.sha256)
  .map(([rel, meta]) => ({
    path: rel,
    visq_v7_sha256: visq7Code[rel].sha256,
    current_sha256: meta.sha256,
  }));

const identity = visq7.checkpoint.expected_identity;
const adapterPath = resolve(ROOT, "adapters/pension-assistant-cumulative-visible-compact-v8-selected/adapters.safetensors");
const adapterSha = hashFile(adapterPath);
if (adapterSha !== identity.adapter_sha256) {
  throw new Error("Rejected adapter hash no longer matches the visq-v7 identity; freeze aborted");
}

const manifest = {
  version: "step130-rejected-candidate-manifest-v1",
  generated_at: new Date().toISOString(),
  state: "STEP130_REJECTION_FREEZE",
  candidate_status: "REJECTED_VISIBLE_QUALIFICATION_TOPIC161",
  candidate_release_eligible: false,
  candidate_unseen_eligible: false,
  this_is_not_live_qualification: true,
  sealed_unseen: { opened: false, run: false, decrypted: false, must_remain_closed: true },
  origin_remote: { url: originUrl, unchanged: true },
  git: {
    head,
    branch,
    working_tree_dirty: Boolean(status.stdout.trim()),
    working_tree_status_sha256: hashText(status.stdout),
    working_tree_path_count: status.stdout.split("\n").filter(Boolean).length,
    relevant_diff_stat: diffStat.trim() || "none",
  },
  candidate: {
    id: "pension-assistant-cumulative-visible-compact-v8-step130",
    selected_iteration: checkpoint.selected_iteration,
    selected_validation_loss: checkpoint.selected_validation_loss,
    labelled_use: "development_demo_baseline_not_legally_qualified",
  },
  hashes: {
    base_model: identity.base_sha256,
    adapter: identity.adapter_sha256,
    selected_checkpoint: identity.checkpoint_sha256,
    tokenizer: identity.tokenizer_sha256,
    tokenizer_config: identity.tokenizer_config_sha256,
    model_configuration: identity.model_config_sha256,
    adapter_config: identity.adapter_config_sha256,
    system_prompt: hashText(ANSWER_SYSTEM_POLICY),
    system_prompt_policy_version: ANSWER_POLICY_VERSION,
    visq_v7_system_policy_sha256: visq7.runtime_preflight?.system_prefix_warmup?.system_policy_sha256 || null,
    routing_policy: currentCode["server/services/queryProcessorService.js"].sha256,
    retrieval_policy: currentCode["server/services/retrievalService.js"].sha256,
    structured_data_manifest: r51.hashes.canonical_facts_registry,
    approved_public_corpus: r51.hashes.approved_corpus_manifest,
    embedding_model: {
      repository: "BAAI/bge-small-en-v1.5",
      revision: visq7.runtime_preflight.retrieval_identity.embedding_revision,
    },
    reranker_model: {
      repository: "BAAI/bge-reranker-base",
      revision: visq7.runtime_preflight.retrieval_identity.reranker_revision,
    },
    retrieval_model_manifest: visq7.runtime_preflight.retrieval_identity.model_manifest_sha256,
    retrieval_server: visq7.runtime_preflight.retrieval_identity.server_sha256,
    grounding_validator: currentCode["server/services/groundingService.js"].sha256,
    citation_renderer: currentCode["server/services/citationRendererService.js"].sha256,
    retry_policy: currentCode["server/services/localModelService.js"].sha256,
    visq_v7_code: Object.fromEntries(Object.entries(visq7Code).map(([k, v]) => [k, v.sha256])),
    current_code: Object.fromEntries(Object.entries(currentCode).map(([k, v]) => [k, v.sha256 || null])),
    code_changed_since_visq_v7: codeDiffs,
    critical4: {
      gate: hashFile(resolve(VISQ7, "gate-critical4.json")),
      results: hashFile(visq7.output_contract.critical4.results),
      scorecard: hashFile(visq7.output_contract.critical4.scorecard),
    },
    full69: {
      gate: hashFile(resolve(VISQ7, "gate-full69.json")),
      results: hashFile(visq7.output_contract.full69.results),
      scorecard: hashFile(visq7.output_contract.full69.scorecard),
    },
    topic161: Object.fromEntries(waves.map((w) => [w.wave, {
      results: w.results_sha256,
      scorecard: w.scorecard_sha256,
      gold: w.gold_sha256,
    }])),
    topic161_gate: hashFile(resolve(VISQ7, "gate-topic161.json")),
    visq_v7_orchestration: hashFile(resolve(VISQ7, "orchestration-manifest.json")),
    round51_immutable_manifest: hashFile(resolve(ROOT, "Log/2026-09-02/live-round-51-adjudicated/immutable-round51-manifest.json")),
    round51_results: r51.hashes.round51_results,
    round52_adjudicated_results: hashFile(resolve(ROOT, "Log/2026-09-02/live-round-52-final/adjudicated-results.json")),
    round52_development_gate: hashFile(resolve(ROOT, "Log/2026-09-02/live-round-52-final/development-gate.json")),
    round52_immutable_results: existsSync(resolve(ROOT, "Log/2026-09-02/live-round-52-final/results.round52-immutable.json"))
      ? hashFile(resolve(ROOT, "Log/2026-09-02/live-round-52-final/results.round52-immutable.json"))
      : null,
  },
  no_op_unchanged_rejected_candidate: {
    rule: "Any attempted topic161 rerun against this adapter with identical relevant hashes must return NO_OP_UNCHANGED_REJECTED_CANDIDATE",
    adapter_sha256: identity.adapter_sha256,
    base_sha256: identity.base_sha256,
    checkpoint_sha256: identity.checkpoint_sha256,
  },
  preservation: {
    rejected_adapter_not_deleted: true,
    rejected_results_not_overwritten: true,
    visq_v7_label: "20260902-r51-step130-v7",
  },
};

const visqSummary = {
  version: "step130-rejected-visible-qualification-summary-v1",
  generated_at: manifest.generated_at,
  candidate_status: manifest.candidate_status,
  controlling_qualification_result: "FAIL_TOPIC161",
  frozen13: "not_reached",
  sealed_unseen: "closed_not_run",
  critical4: {
    passed: gateCritical4.passed === true,
    note: "JSON retry/recovery was required and recorded on the visq path",
  },
  full69: {
    passed: gateFull69.passed === true,
    note: "68 PASS / 1 PARTIAL; official-tax OSCOLA repair was applied and recorded",
  },
  topic161: {
    passed: false,
    required_gate: { overall: 90, per_topic: 85, zero_critical_fail: true, zero_run_errors: true },
    waves: waves.map((w) => ({
      wave: w.wave,
      pass_rate: w.pass_rate,
      outcomes: w.outcomes,
      run_errors: w.run_errors,
      topics: w.topics,
    })),
    converting_run_errors_to_pass_would_still_fail: true,
  },
  visq_path_product_repairs_already_used: 2,
  further_topic161_rerun_on_unchanged_step130: "not_authorised",
};

const live50Summary = {
  version: "step130-live50-development-summary-v1",
  generated_at: manifest.generated_at,
  this_is_development_regression_not_qualification: true,
  round_51_snapshot: {
    unique_ids: 50,
    auto_pass: 28,
    auto_fail: 4,
    unscored: 18,
    adjudicated: { PASS: 36, FAIL: 8, PARTIAL: 4, HOLD: 2 },
    original_auto_fail: ["L06", "L18", "L20", "L31"],
  },
  round_52_final: {
    PASS: r52Adj.counts.PASS,
    PARTIAL: r52Adj.counts.PARTIAL,
    HOLD: r52Adj.counts.HOLD_EVALUATION_INFRA,
    FAIL: 0,
    UNSCORED: 0,
    partials: [
      { id: "L38", why: "automatic enrolment stated but opt-out omitted" },
      { id: "L40", why: "general 25% PCLS explanation" },
    ],
    hold: [{ id: "L42", why: "model_unavailable after the one authorised retry" }],
    projection_cluster: "9/9 PASS",
    development_gate_pass: r52Gate.pass === true,
  },
  training_in_completed_cycle: {
    T1: "not_eligible",
    T2: "not_eligible",
    T3: "not_eligible",
    T4: "not_previously_authorised",
    training_run: false,
  },
};

writeJson(resolve(OUT, "rejected-candidate-manifest.json"), manifest);
writeJson(resolve(OUT, "visible-qualification-summary.json"), visqSummary);
writeJson(resolve(OUT, "live50-development-summary.json"), live50Summary);

const report = `# Step130 rejection report

Date: 2 September 2026
Candidate: \`pension-assistant-cumulative-visible-compact-v8-step130\`
Status: **REJECTED_VISIBLE_QUALIFICATION_TOPIC161**

This candidate is preserved as a labelled development/demo baseline. It is not live-qualified, not release-eligible, and not eligible for sealed unseen.

## Why the cycle closed

Visible qualification failed on topic161. Live-50 development regression is strong (47 PASS, 2 PARTIAL, 1 infrastructure HOLD, 0 FAIL) but is not qualification. Two visible-qualification-path product repairs were already used. A further topic161 rerun against the unchanged adapter is not authorised.

| Gate | Result |
| --- | --- |
| Live-50 development | 47 PASS / 2 PARTIAL / 1 HOLD / 0 FAIL (not qualification) |
| critical4 | PASS 4/4 (JSON retry/recovery recorded) |
| full69 | PASS (68 PASS / 1 PARTIAL; OSCOLA repair recorded) |
| topic161 wave 1 | 65.4% |
| topic161 wave 2 | 42.6% |
| topic161 wave 3 | 41.5% |
| frozen13 | not reached |
| sealed unseen | closed |

Required topic gate: 90% overall and 85% per topic, with zero critical legal failures and zero unexplained run errors. Converting residual run errors into passes would still not satisfy the gate.

## Bound identities

- Base model SHA-256: \`${identity.base_sha256}\`
- Adapter SHA-256: \`${identity.adapter_sha256}\`
- Selected checkpoint SHA-256: \`${identity.checkpoint_sha256}\`
- Git HEAD: \`${head}\`
- Origin remote unchanged: \`${originUrl}\`

## What happens next

Original topic161 is relabelled \`DEVELOPMENT_REGRESSION_CONSUMED\`. A forensic audit of existing traces follows. Training, if any, starts from the pinned original base model, not by stacking onto step130. A fresh untouched replacement set becomes the controlling visible qualification suite.

Do not claim solicitor certification, sealed-unseen performance, or legal qualification from this rejected candidate.
`;
writeText(resolve(OUT, "REJECTION-REPORT.md"), report);

writeJson(resolve(ORIG, "STATUS.json"), {
  topic161_original_status: "DEVELOPMENT_REGRESSION_CONSUMED",
  may_be_used_as: "known-failure development regression after a new candidate exists",
  must_not_be_described_as: [
    "unseen",
    "untouched",
    "independent qualification",
    "sealed qualification",
    "final legal-generalisation evidence",
  ],
  original_results_paths: Object.fromEntries(waves.map((w) => [w.wave, {
    results: w.results_path,
    scorecard: w.scorecard_path,
    gold: w.gold_path,
    results_sha256: w.results_sha256,
    scorecard_sha256: w.scorecard_sha256,
    gold_sha256: w.gold_sha256,
  }])),
  rejected_candidate: "pension-assistant-cumulative-visible-compact-v8-step130",
  freeze_dir: OUT,
});
writeJson(resolve(ORIG, "original-results/pointers.json"), {
  note: "Original outputs remain in place and are not overwritten. This directory records hashes and paths only.",
  waves: waves.map((w) => ({
    wave: w.wave,
    results_sha256: w.results_sha256,
    scorecard_sha256: w.scorecard_sha256,
    gold_sha256: w.gold_sha256,
    results_path: w.results_path,
    scorecard_path: w.scorecard_path,
  })),
});

console.log(JSON.stringify({
  state: "STEP130_REJECTION_FREEZE",
  candidate_status: manifest.candidate_status,
  out: OUT,
  adapter_sha256: identity.adapter_sha256,
  topic161_pass_rates: waves.map((w) => ({ wave: w.wave, pass_rate: w.pass_rate })),
  origin_unchanged: true,
  sealed_unseen_closed: true,
}, null, 2));
