// Pure checks: a pass total alone is not proof that the frozen release set ran.
export function assessFrozenSlice({ expectedIds, results, scorecard, manifest, resultsSha256, expectedIdentity }) {
  const rows = results?.results || [], scores = scorecard?.items || [];
  const exactIds = (items) => items.length === expectedIds.length && new Set(items.map((item) => item.question_id)).size === expectedIds.length && expectedIds.every((id) => items.some((item) => item.question_id === id));
  const complete = exactIds(rows) && exactIds(scores);
  const artifacts_match = Boolean(resultsSha256 && (manifest?.results_sha256 || manifest?.result_sha256) === resultsSha256 && scorecard?.results_sha256 === resultsSha256);
  const identityMatches = (identity) => Boolean(identity && Object.entries(expectedIdentity).every(([key, value]) => identity[key] === value));
  const serviceIdentity = manifest?.model?.service_health?.body?.data?.find((item) => item.id === expectedIdentity.id);
  const runtime_verified = identityMatches(serviceIdentity) && rows.every((item) => typeof item.model_call_attempted === "boolean" && (!(item.model_call_attempted || item.raw_model_answer != null) || (identityMatches(item.runtime_identity) && item.runtime_identity.worker_sha256 === serviceIdentity.worker_sha256 && item.runtime_identity.supervisor_sha256 === serviceIdentity.supervisor_sha256)));
  const errors = rows.filter((item) => item.selected_route === "RUN_ERROR" || item.run_error).length;
  const all_scored_pass = scores.length > 0 && scores.every((item) => item.status === "pass");
  return { complete, artifacts_match, runtime_verified, run_errors: errors,
    passed: complete && artifacts_match && runtime_verified && errors === 0 && all_scored_pass };
}
