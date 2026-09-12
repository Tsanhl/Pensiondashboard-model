import { mkdir,readFile,writeFile } from "node:fs/promises";
import { dirname,resolve } from "node:path";

const inputPath = resolve(process.argv[2] || "training/gold-answer-review.json");
const outputPath = resolve(process.argv[3] || "training/GOLD-ANSWER-REVIEW.md");
const payload = JSON.parse(await readFile(inputPath,"utf8"));
const lines = [
  "# Pension assistant gold-answer review",
  "",
  `Status: \`${payload.answer_set_status}\`  `,
  `Version: \`${payload.version}\`  `,
  `Questions: ${payload.items.length}  `,
  `Question concepts: \`${payload.question_concepts_status}\`  `,
  `Gold-answer freeze: \`${payload.gold_answer_freeze}\`  `,
  `Training eligibility: \`${payload.training_eligibility}\``,
  "",
  "Review the synthetic facts, answer, sentence-level citations, handoff and prohibited behaviour. These drafts are held-out evaluation assets and are not training data.",
  "",
  "## Review summary",
  "",
  "| Suite | Items |",
  "|---|---:|"
];
for (const suite of [...new Set(payload.items.map((item) => item.suite))]) lines.push(`| ${suite} | ${payload.items.filter((item) => item.suite === suite).length} |`);
lines.push(
  "",
  "| First-review gold-answer decision | Items |",
  "|---|---:|",
  `| approve | ${payload.items.filter((item) => item.first_review_gold_answer_decision === "approve").length} |`,
  `| edit | ${payload.items.filter((item) => item.first_review_gold_answer_decision === "edit").length} |`,
  "| reject | 0 |"
);
lines.push(
  "",
  "## Scoring framework",
  "",
  "| Dimension | Points | Review standard |",
  "|---|---:|---|",
  "| Grounding | 4 | Every material proposition is supported by the fixture, a selected chunk or a structured fact. |",
  "| Sentence-level citations | 2 | Each legal or factual proposition carries the matching OSCOLA citation; no invented source or pinpoint. |",
  "| Required content | 2 | The answer includes the question-specific rubric and remains within the requested topic. |",
  "| Handoff and action boundary | 1 | Required handoff is explicit and the assistant does not claim to take an unavailable action. |",
  "| Concision and scope | 1 | The answer is direct, clear and no broader than needed. |",
  "",
  `Pass mark: **${payload.scoring_framework.pass_score}/${payload.scoring_framework.maximum_points}**. Any critical failure is an automatic fail, regardless of the numeric score.`,
  "",
  `Critical gates (all must remain zero): ${Object.keys(payload.scoring_framework.gates).join("; ")}.`
);
for (const item of payload.items) {
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
    `**Review state:** question \`${item.question_decision}\`; first-review answer \`${item.first_review_gold_answer_decision}\`; current \`${item.answer_review_status}\``,
    "",
    "### Synthetic fixture",
    "",
    "```json",
    JSON.stringify(item.synthetic_fixture.values,null,2),
    "```",
    "",
    "### Draft gold answer",
    "",
    item.draft_answer,
    "",
    "### Claim-to-evidence map",
    "",
    "| Claim | Sentence | Evidence IDs | Status |",
    "|---|---|---|---|"
  );
  for (const claim of item.claim_evidence_map) {
    lines.push(`| ${claim.claim_id} | ${claim.claim_text.replaceAll("|","\\|")} | ${claim.evidence_ids.join("; ")} | ${claim.review_status} |`);
  }
  lines.push(
    "",
    "### Exact evidence used",
    "",
    "| Evidence ID | Source / section | Role | Source updated / retrieved | Snapshot | OSCOLA | Selected |",
    "|---|---|---|---|---|---|---|"
  );
  for (const evidence of [...item.retrieved_chunks,...item.structured_facts]) {
    lines.push(`| ${evidence.evidence_id} | ${(evidence.title || "").replaceAll("|","\\|")} — ${(evidence.section || "").replaceAll("|","\\|")} | ${evidence.source_role || "—"} | ${evidence.source_updated_at || "—"} / ${evidence.retrieved_at || "—"} | ${(evidence.snapshot_hash || "—").slice(0,12)} | ${(evidence.oscola_citation || "").replaceAll("|","\\|")} | ${evidence.selected_for_answer ? "Yes" : "Candidate"} |`);
  }
  if (!item.retrieved_chunks.length && !item.structured_facts.length) lines.push("| — | Synthetic fixture and/or system policy only | — | — | — | — | Yes |");
  if (item.alternative_jurisdiction_sources?.length) {
    lines.push("","### Alternative-jurisdiction sources (not selected)","","| Document | Jurisdiction | Location |","|---|---|---|");
    for (const source of item.alternative_jurisdiction_sources) lines.push(`| ${source.title.replaceAll("|","\\|")} | ${source.jurisdiction} | ${source.canonical_location} |`);
  }
  lines.push("","<details><summary>Show retrieved chunk text</summary>","");
  for (const evidence of item.retrieved_chunks) lines.push(`**${evidence.evidence_id} — ${evidence.section}**`,"","```text",evidence.content,"```","");
  lines.push("</details>","","### Scoring review","",`- Required: ${item.scoring.required_checks.join("; ")}`,`- Prohibited: ${item.scoring.prohibited_checks.join("; ")}`,`- Critical failures: ${item.scoring.critical_failures.join("; ")}`,"",`First-review answer decision: \`${item.first_review_gold_answer_decision}\`  `,"Second-review decision: `approve` / `edit` / `reject`  ","Second-review notes:");
}
await mkdir(dirname(outputPath),{recursive:true});
await writeFile(outputPath,`${lines.join("\n")}\n`);
console.log(`Rendered ${payload.items.length} gold-answer drafts to ${outputPath}`);
