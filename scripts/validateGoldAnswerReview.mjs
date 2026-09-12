import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const questionPath = resolve("training/gold-evaluation-draft.json");
const answerPath = resolve(process.argv[2] || "training/gold-answer-review.json");
const markdownPath = resolve(process.argv[3] || "training/GOLD-ANSWER-REVIEW.md");
const secondReviewJsonPath = resolve(process.argv[4] || "training/gold-answer-second-review.json");
const secondReviewMarkdownPath = resolve(process.argv[5] || "training/GOLD-ANSWER-SECOND-REVIEW.md");
const questions = JSON.parse(await readFile(questionPath,"utf8"));
const answers = JSON.parse(await readFile(answerPath,"utf8"));
const markdown = await readFile(markdownPath,"utf8");
const secondReview = JSON.parse(await readFile(secondReviewJsonPath,"utf8"));
const secondReviewMarkdown = await readFile(secondReviewMarkdownPath,"utf8");
if (answers.training_eligibility !== "prohibited") throw new Error("Gold answers must be prohibited from training.");
if (answers.answer_set_status !== "draft_human_review_required") throw new Error("Gold answers must remain draft pending human review.");
if (answers.items.length !== questions.questions.length) throw new Error("Answer and question counts differ.");
const questionById = new Map(questions.questions.map((row) => [row.id,row]));
const ids = new Set();
let chunkCount = 0;
let factCount = 0;
for (const item of answers.items) {
  const question = questionById.get(item.id);
  if (!question) throw new Error(`Unknown answer ID ${item.id}.`);
  if (ids.has(item.id)) throw new Error(`Duplicate answer ID ${item.id}.`);
  ids.add(item.id);
  if (!markdown.includes(`## ${item.id}\n`)) throw new Error(`Markdown is missing ${item.id}.`);
  if (!markdown.includes(item.draft_answer)) throw new Error(`Markdown answer differs from JSON for ${item.id}.`);
  if (!item.synthetic_fixture?.synthetic || item.synthetic_fixture.contains_real_user_data !== false) throw new Error(`${item.id} fixture is not marked synthetic and free of real-user data.`);
  for (const requirement of question.fixture_requirements || []) {
    const key = requirement.startsWith("embedded_text:") ? "embedded_text" : requirement;
    if (!(key in item.synthetic_fixture.values)) throw new Error(`${item.id} fixture is missing ${key}.`);
  }
  if (!item.draft_answer || /\{\{[^}]+\}\}/.test(item.draft_answer)) throw new Error(`${item.id} has an unresolved or empty answer.`);
  const evidence = [...item.retrieved_chunks,...item.structured_facts,item.synthetic_fixture,item.policy_evidence];
  const supplied = new Set(evidence.map((entry) => entry.evidence_id));
  const invented = item.citation_ids.filter((id) => !supplied.has(id));
  if (invented.length) throw new Error(`${item.id} cites unsupplied evidence: ${invented.join(", ")}.`);
  if (!item.citation_ids.length) throw new Error(`${item.id} has no citations.`);
  for (const sourceId of question.required_source_ids || []) {
    if (!item.retrieved_chunks.some((entry) => entry.document_id === sourceId && entry.content && entry.oscola_citation)) throw new Error(`${item.id} has no exact chunk for ${sourceId}.`);
  }
  for (const factId of question.required_structured_fact_ids || []) {
    if (!item.structured_facts.some((entry) => entry.document_id === `public-fact-${factId}`)) throw new Error(`${item.id} has no exact structured fact ${factId}.`);
  }
  if (question.handoff_required && !item.expected_handoff.required) throw new Error(`${item.id} lost its mandatory handoff.`);
  if (question.expected_route === "REFUSE_ACTION" && !/(cannot|can't|have taken no action|has been made|do not)/i.test(item.draft_answer)) throw new Error(`${item.id} does not clearly refuse the prohibited action.`);
  if (item.scoring.maximum_points !== 10 || !item.scoring.critical_failures.length) throw new Error(`${item.id} has invalid scoring rules.`);
  chunkCount += item.retrieved_chunks.length;
  factCount += item.structured_facts.length;
}
const markdownItemCount = [...markdown.matchAll(/^## gold-[^\n]+$/gm)].length;
if (markdownItemCount !== answers.items.length) throw new Error(`Markdown has ${markdownItemCount} item headings for ${answers.items.length} JSON items.`);
const editedItems = answers.items.filter((item) => item.first_review_gold_answer_decision === "edit");
if (secondReview.items.length !== 42 || editedItems.length !== 42) throw new Error("Second-review pack must contain exactly the 42 first-review edits.");
for (const edited of editedItems) {
  const second = secondReview.items.find((item) => item.id === edited.id);
  if (!second || JSON.stringify(second) !== JSON.stringify(edited)) throw new Error(`Second-review JSON differs from full JSON for ${edited.id}.`);
  if (!secondReviewMarkdown.includes(`## ${edited.id}\n`) || !secondReviewMarkdown.includes(edited.draft_answer)) throw new Error(`Second-review Markdown differs for ${edited.id}.`);
}
if ([...secondReviewMarkdown.matchAll(/^## gold-[^\n]+$/gm)].length !== 42) throw new Error("Second-review Markdown must contain exactly 42 item headings.");
console.log(JSON.stringify({valid:true,questions:answers.items.length,exact_chunks:chunkCount,structured_facts:factCount,markdown_json_parity:true,second_review_pack_parity:true,answer_set_status:answers.answer_set_status,training_eligibility:answers.training_eligibility},null,2));
