import { mkdir,readFile,writeFile } from "node:fs/promises";
import { dirname,resolve } from "node:path";

const inputPath = resolve(process.argv[2] || "training/gold-answer-review.json");
const jsonPath = resolve(process.argv[3] || "training/gold-answer-second-review.json");
const markdownPath = resolve(process.argv[4] || "training/GOLD-ANSWER-SECOND-REVIEW.md");
const payload = JSON.parse(await readFile(inputPath,"utf8"));
const items = payload.items.filter((item) => item.first_review_gold_answer_decision === "edit");
if (items.length !== 42) throw new Error(`Expected 42 edited items for second review, found ${items.length}.`);

const reviewPayload = {
  version:"pension-gold-answer-second-review-v1",
  generated_at:payload.created_at,
  source_version:payload.version,
  answer_set_status:payload.answer_set_status,
  question_concepts_status:payload.question_concepts_status,
  gold_answer_freeze:payload.gold_answer_freeze,
  training_eligibility:payload.training_eligibility,
  item_count:items.length,
  review_instruction:"Review the edited fixture, answer, sentence-level claim-evidence map, selected exact chunks, handoff and prohibited behaviour. Mark each item approve, edit or reject. Do not use this evaluation asset for training.",
  scoring_framework:payload.scoring_framework,
  items
};

const lines = [
  "# Pension gold answers — second review of 42 edited items",
  "",
  `Status: \`${reviewPayload.answer_set_status}\`  `,
  `Question concepts: \`${reviewPayload.question_concepts_status}\`  `,
  `Gold-answer freeze: \`${reviewPayload.gold_answer_freeze}\`  `,
  `Training eligibility: \`${reviewPayload.training_eligibility}\`  `,
  `Items for second review: **${items.length}**`,
  "",
  "Review only the corrected gold-answer integrity. The question concepts are already approved. For each item, check the fixture, concise answer, sentence-level OSCOLA citation, exact source passage, handoff and prohibited behaviour.",
  "",
  "## Zero-tolerance gates",
  "",
  Object.keys(payload.scoring_framework.gates).map((gate) => `- \`${gate}\``).join("\n")
];

for (const item of items) {
  lines.push(
    "",
    `## ${item.id}`,
    "",
    `**Question:** ${item.question}`,
    "",
    `**Jurisdiction / route:** \`${item.jurisdiction}\` / \`${item.expected_route}\``,
    "",
    `**Handoff:** ${item.expected_handoff.required ? `Required — ${item.expected_handoff.reason}` : "Not mandatory"}`,
    "",
    "### Synthetic fixture",
    "",
    "```json",
    JSON.stringify(item.synthetic_fixture.values,null,2),
    "```",
    "",
    "### Corrected draft answer",
    "",
    item.draft_answer,
    "",
    "### Sentence-level claim-evidence map",
    "",
    "| Claim | Sentence | Evidence IDs |",
    "|---|---|---|"
  );
  for (const claim of item.claim_evidence_map) lines.push(`| ${claim.claim_id} | ${claim.claim_text.replaceAll("|","\\|")} | ${claim.evidence_ids.join("; ")} |`);
  lines.push("","### Selected exact evidence","","| Evidence ID | Source / pinpoint | Role | Updated | Snapshot | OSCOLA |","|---|---|---|---|---|---|");
  const selected = [...item.retrieved_chunks,...item.structured_facts].filter((evidence) => evidence.selected_for_answer);
  for (const evidence of selected) lines.push(`| ${evidence.evidence_id} | ${(evidence.title || "").replaceAll("|","\\|")} — ${(evidence.section || "").replaceAll("|","\\|")} | ${evidence.source_role} | ${evidence.source_updated_at || "—"} | ${(evidence.snapshot_hash || "—").slice(0,12)} | ${(evidence.oscola_citation || "").replaceAll("|","\\|")} |`);
  if (!selected.length) lines.push("| — | Synthetic fixture and/or system policy only | — | — | — | — |");
  lines.push("","<details><summary>Show selected source text</summary>","");
  for (const evidence of item.retrieved_chunks.filter((entry) => entry.selected_for_answer)) lines.push(`**${evidence.evidence_id} — ${evidence.section}**`,"","```text",evidence.content,"```","");
  lines.push("</details>","",`Required checks: ${item.scoring.required_checks.join("; ")}`,"",`Prohibited: ${item.scoring.prohibited_checks.join("; ")}`,"","Second-review decision: `approve` / `edit` / `reject`  ","Second-review notes:");
}

await Promise.all([mkdir(dirname(jsonPath),{recursive:true}),mkdir(dirname(markdownPath),{recursive:true})]);
await Promise.all([
  writeFile(jsonPath,`${JSON.stringify(reviewPayload,null,2)}\n`),
  writeFile(markdownPath,`${lines.join("\n")}\n`)
]);
console.log(JSON.stringify({items:items.length,jsonPath,markdownPath,freeze:reviewPayload.gold_answer_freeze},null,2));
