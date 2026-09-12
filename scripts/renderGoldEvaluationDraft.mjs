import { mkdir,readFile,writeFile } from "node:fs/promises";
import { dirname,resolve } from "node:path";

const inputPath = resolve(process.argv[2] || "training/gold-evaluation-draft.json");
const outputPath = resolve(process.argv[3] || "training/GOLD-EVALUATION-DRAFT.md");
const draft = JSON.parse(await readFile(inputPath,"utf8"));
const lines = [
  "# Pension assistant gold evaluation set",
  "",
  `Status: \`${draft.status}\`  `,
  `Version: \`${draft.version}\`  `,
  `Questions: ${draft.questions.length}  `,
  `Answer review: \`${draft.answer_set_status}\`  `,
  `Training eligibility: \`${draft.training_eligibility}\``,
  "",
  "This is a frozen evaluation set, not training data. Exact matches and semantic near-duplicates must remain outside LoRA training and development splits. Course and handbook files were used only as a topic map. Expected answers must use the active official sources, dated structured facts and synthetic dashboard fixtures listed in the JSON file.",
  "",
  "Question review is complete. Gold answers and sentence-level OSCOLA citations still require separate human review."
];
for (const [suite,description] of Object.entries(draft.suites)) {
  const rows = draft.questions.filter((row) => row.suite === suite);
  lines.push("",`## ${suite}`,"",description,"","| ID | User question | Jurisdiction | Route | Handoff |","|---|---|---|---|---|");
  for (const row of rows) {
    const context = row.conversation_context?.length ? ` _Context: ${row.conversation_context.join(" / ")}_` : "";
    const question = `${row.question}${context}`.replaceAll("|","\\|").replace(/\s+/g," ");
    lines.push(`| ${row.id} | ${question} | ${row.jurisdiction} | ${row.expected_route} | ${row.handoff_required ? row.handoff_reason : "No"} |`);
  }
}
lines.push(
  "",
  "## Answer-review method",
  "",
  "For each future gold answer, mark `approve`, `edit` or `reject` and check:",
  "",
  "1. Does every legal or financial proposition have exact active evidence?",
  "2. Are the required jurisdiction and law-as-at date applied?",
  "3. Are dashboard facts taken only from the named synthetic fixture?",
  "4. Does the response comply with the handoff and action boundaries?",
  "5. Are OSCOLA citations placed after the supported sentence?",
  "6. Does the answer remain concise and address only the question asked?",
  "",
  "After answer approval, freeze the answer set and run the same held-out questions against the base model and adapter."
);
await mkdir(dirname(outputPath),{recursive:true});
await writeFile(outputPath,`${lines.join("\n")}\n`);

const suiteDirectory = resolve(dirname(inputPath),"gold-suites");
await mkdir(suiteDirectory,{recursive:true});
for (const suite of Object.keys(draft.suites)) {
  const suitePath = resolve(suiteDirectory,`${suite.replaceAll("_","-")}.json`);
  const payload = {
    parent_version:draft.version,
    question_set_status:draft.question_set_status,
    training_eligibility:draft.training_eligibility,
    suite,
    description:draft.suites[suite],
    questions:draft.questions.filter((row) => row.suite === suite)
  };
  await writeFile(suitePath,`${JSON.stringify(payload,null,2)}\n`);
}
console.log(`Rendered ${draft.questions.length} questions and ${Object.keys(draft.suites).length} suite files to ${outputPath}`);
