import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run eval:answers -- answer-results.jsonl");
const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
let compliant = 0;
let invented = 0;
let criticalUnsupported = 0;
for (const row of rows) {
  const allowed = new Set((row.supplied_sources || []).map((source) => source.source_id));
  const cited = new Set([...(row.citation_ids || []), ...[...String(row.answer || "").matchAll(/\[([a-zA-Z0-9_-]+)\]/g)].map((match) => match[1])]);
  const inventedForRow = [...cited].filter((id) => !allowed.has(id));
  invented += inventedForRow.length;
  const formatOk = typeof row.answer === "string" && row.answer.trim() && (cited.size > 0 || ["model_unavailable","insufficient_verified_evidence","handoff"].includes(row.confidence));
  if (formatOk && !inventedForRow.length) compliant += 1;
  if (row.critical_unsupported_claim === true) criticalUnsupported += 1;
}
const formatCompliance = rows.length ? compliant / rows.length : 0;
const result = { examples:rows.length,format_compliance:formatCompliance,format_gate:0.95,invented_citation_ids:invented,critical_unsupported_claims:criticalUnsupported,passed:formatCompliance >= 0.95 && invented === 0 && criticalUnsupported === 0 };
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
