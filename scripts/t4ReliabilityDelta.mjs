import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CYCLE31 = resolve(ROOT, "training/evaluation-cycle-v2/31-post-training-development-regression-20260903");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function collectResults(labelPrefix) {
  const rows = [];
  for (const wave of ["wave-1", "wave-2", "wave-3"]) {
    const dir = resolve(ROOT, `training/evaluation-cycle-v2/02-${wave}-execution/diagnostic/${labelPrefix}-${wave}`);
    const resultsPath = join(dir, "results.json");
    if (!existsSync(resultsPath)) continue;
    const payload = readJson(resultsPath);
    for (const item of payload.results || []) {
      rows.push({
        wave,
        question_id: item.question_id,
        selected_route: item.selected_route,
        run_error: item.run_error || null,
        retry_used: Boolean(item.retry_used),
        retry_reason: item.retry_reason || null,
        recovered_from_truncation: Boolean(item.recovered_from_truncation),
        model_call_attempted: Boolean(item.model_call_attempted),
        finish_reason: item.model_finish_reason || null,
        latency_ms: item.latency_ms || null,
      });
    }
  }
  return rows;
}

function tally(rows) {
  return {
    n: rows.length,
    model_calls: rows.filter((row) => row.model_call_attempted).length,
    run_errors: rows.filter((row) => row.selected_route === "RUN_ERROR" || row.run_error).length,
    retries: rows.filter((row) => row.retry_used).length,
    json_recovered: rows.filter((row) => row.recovered_from_truncation).length,
    model_unavailable: rows.filter((row) => /MODEL_UNAVAILABLE|model_unavailable/i.test(JSON.stringify(row.run_error || ""))).length,
    timeouts: rows.filter((row) => /timeout|timed out|deadline/i.test(JSON.stringify(row))).length,
  };
}

const t4 = collectResults("devreg-20260903-t4-targeted");
const original = collectResults("devreg-20260903-topic161-original");
const livePath = resolve(ROOT, "Log/2026-09-03/live-round-53/results.json");
const live = existsSync(livePath) ? readJson(livePath).items || [] : [];
const liveTally = {
  n: live.length,
  http_fail: live.filter((item) => item.ok === false).length,
  model_unavailable: live.filter((item) => item.confidence === "model_unavailable").length,
  timeouts: live.filter((item) => /timeout|timed out|deadline/i.test(JSON.stringify(item))).length,
};

const report = {
  version: "t4-runtime-reliability-delta-v1",
  generated_at: new Date().toISOString(),
  this_is_not_qualification: true,
  sealed_unseen_accessed: false,
  infra_hold_is_not_model_pass: true,
  t4_targeted: tally(t4),
  topic161_original: tally(original),
  live50_round53: liveTally,
  round52_live_holds: ["L42"],
  gate: {
    t4_zero_run_errors: tally(t4).run_errors === 0 && t4.length > 0,
    original_zero_run_errors: tally(original).run_errors === 0 && original.length === 161,
    live_http_failures: liveTally.http_fail,
    live_model_unavailable_holds: liveTally.model_unavailable,
    live_infra_hold_not_counted_as_model_pass: true,
  },
};
report.passed = report.gate.t4_zero_run_errors && report.gate.original_zero_run_errors && liveTally.http_fail === 0;
writeFileSync(join(CYCLE31, "reliability-delta.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
