import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const contentHash = (value) => createHash("sha256").update(value).digest("hex");
const normalise = (value) => String(value || "").normalize("NFKC").replace(/\{\{cite:[^}]+\}\}/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function answerText(content) {
  try { const parsed = JSON.parse(content); return typeof parsed.answer === "string" ? parsed.answer : content; } catch { return content; }
}

export function auditTrainingRows(rows) {
  const items = rows.map((row, index) => {
    const target = answerText(row.messages?.at(-1)?.content || row.ideal_answer || "");
    let input = {};
    try { input = JSON.parse(row.messages?.find((message) => message.role === "user")?.content || "{}"); } catch { /* Non-JSON prompts are also checked below. */ }
    const evidence = (input.evidence || input.retrieved_evidence || row.retrieved_evidence || []).map((source) => source.text || source.snippet || source.content || "").join("\n");
    const normalized = normalise(target);
    const hasSubstantialTarget = normalized.split(" ").length >= 12;
    const exact = hasSubstantialTarget && normalise(evidence).includes(normalized);
    const literalPromptEcho = hasSubstantialTarget && (row.messages || []).filter((m) => m.role !== "assistant").some((m) => normalise(m.content).includes(normalized));
    let jsonTarget = false;
    try { const parsed = JSON.parse(row.messages?.at(-1)?.content); jsonTarget = typeof parsed.answer === "string" && Array.isArray(parsed.citation_ids); } catch { /* Recorded as format mismatch, not silently converted. */ }
    return { id:row.metadata?.training_id || row.training_id || row.id || `row-${index + 1}`, target_verbatim_in_evidence:exact, target_verbatim_in_prompt:exact || literalPromptEcho, json_answer_contract:jsonTarget };
  });
  return { total:items.length, target_in_evidence:items.filter((x) => x.target_verbatim_in_evidence).length,
    target_in_prompt:items.filter((x) => x.target_verbatim_in_prompt).length,
    json_answer_contract:items.filter((x) => x.json_answer_contract).length,
    passed:items.length > 0 && items.every((x) => !x.target_verbatim_in_prompt), items };
}

export function auditTrainingDataset(directory) {
  const partitions = ["train", "valid"].map((partition) => {
    const path = resolve(directory, `${partition}.jsonl`);
    if (!existsSync(path)) return { partition, path, passed:false, error:"missing_partition" };
    const data = readFileSync(path, "utf8");
    return { partition, path, sha256:contentHash(data), ...auditTrainingRows(data.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)) };
  });
  return { directory:resolve(directory), passed:partitions.every((x) => x.passed), partitions };
}

export function assertTrainingDatasetIntegrity(directory) {
  const audit = auditTrainingDataset(directory);
  if (!audit.passed) throw new Error(`Training blocked: completion targets appear in the inputs or a partition is missing: ${audit.directory}. Replace answer-derived evidence and obtain a new source/answer review; do not reuse the affected validation-loss selection.`);
  return audit;
}

// IDs alone are insufficient: renaming a copied source must not make it a
// held-out validation example. Source families and constructs need review too.
export function auditTrainingPartitionIsolation(train, validation) {
  const fields = {
    source_ids: (item) => (item.retrieved_evidence || []).map((source) => source.source_id),
    source_text: (item) => (item.retrieved_evidence || []).map((source) => contentHash(normalise(source.text))),
    authority_families: (item) => (item.retrieved_evidence || []).map((source) => source.authority_family),
    constructs: (item) => [item.construct_id],
  };
  const overlap = Object.fromEntries(Object.entries(fields).map(([key, values]) => {
    const trainingValues = new Set(train.flatMap(values).filter(Boolean));
    return [key, [...new Set(validation.flatMap(values).filter(Boolean))].filter((value) => trainingValues.has(value))];
  }));
  const missing = [...train, ...validation].filter((item) => !item.construct_id || !item.retrieved_evidence?.length || item.retrieved_evidence.some((source) => !source.source_id || !source.text?.trim() || !source.authority_family)).map((item) => item.training_id);
  return { passed:train.length > 0 && validation.length > 0 && missing.length === 0 && Object.values(overlap).every((values) => values.length === 0), overlap, missing };
}

export function auditCumulativeTrainingIsolation(waves, { legalRuleById = {} } = {}) {
  const training = waves.flatMap((wave) => wave.train.map((item) => ({ ...item, construct_id:legalRuleById[item.training_id] || item.legal_rule_id || item.construct_id })));
  const validation = waves.flatMap((wave) => wave.validation.map((item) => ({ ...item, construct_id:legalRuleById[item.training_id] || item.legal_rule_id || item.construct_id })));
  const audit = auditTrainingPartitionIsolation(training, validation);
  return { ...audit, waves:waves.map((wave) => wave.wave), train_count:training.length, validation_count:validation.length };
}

// Review is external input. Exporters may not manufacture approval from counts,
// citation-ID membership, or a source made by stripping tokens from the answer.
export function loadReviewedTrainingItems(path, candidates, { reviewReturnPath } = {}) {
  if (!existsSync(path)) throw new Error(`Training export blocked: independently reviewed source-backed training items are required at ${path}`);
  const review = JSON.parse(readFileSync(path, "utf8"));
  if (reviewReturnPath && existsSync(reviewReturnPath)) {
    const returnedReview = readFileSync(reviewReturnPath);
    if (review.supersedes_review_return_sha256 !== contentHash(returnedReview) || review.repairs_verified !== true) {
      throw new Error("Training export blocked: the independent review was returned for revision and its hash-bound repairs have not been verified");
    }
  }
  if (review.status !== "approved_for_training" || !review.reviewer || !review.approved_at || review.items_sha256 !== contentHash(JSON.stringify(review.items))) throw new Error("Training source/answer review is missing or not hash-bound to these items");
  const byId = new Map((review.items || []).map((item) => [item.training_id, item]));
  if (byId.size !== candidates.length || review.items.length !== candidates.length) throw new Error("Reviewed training item IDs do not match the candidate set");
  for (const candidate of candidates) {
    const item = byId.get(candidate.id);
    if (!item || item.review_status !== "approved" || item.question_sha256 !== contentHash(candidate.question) || !item.ideal_answer?.trim()) throw new Error(`Training item ${candidate.id} needs question-bound source/answer approval`);
    if (!item.retrieved_evidence?.length) throw new Error(`Training item ${candidate.id} lacks source passages`);
    for (const source of item.retrieved_evidence) {
      if (!source.source_id || !source.text || !/^https:\/\//.test(source.source_url || "") || source.content_sha256 !== contentHash(source.text) || !source.authority_family) throw new Error(`Training source ${source.source_id || "unknown"} lacks pinned provenance`);
    }
    if (!auditTrainingRows([item]).passed) throw new Error(`Training item ${candidate.id} copies its completion target into evidence`);
    const ids = new Set(item.retrieved_evidence.map((source) => source.source_id));
    const citations = [...item.ideal_answer.matchAll(/\{\{cite:([^}]+)\}\}/g)].map((match) => match[1]);
    if (!citations.length || citations.some((id) => !ids.has(id))) throw new Error(`Training item ${candidate.id} has unreviewed citation mapping`);
  }
  return { review, byId, sha256:contentHash(readFileSync(path)) };
}
