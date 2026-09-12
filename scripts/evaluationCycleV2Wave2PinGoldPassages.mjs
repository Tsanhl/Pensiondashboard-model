import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const GOLD_PATH = resolve("training/evaluation-cycle-v2/02-wave-2-execution/gold/evaluation-gold.json");
const REVIEW_PATH = resolve("training/evaluation-cycle-v2/02-wave-2-execution/gold/PASSAGE-PIN-REVIEW.md");
const VALIDATION_PATH = resolve("training/evaluation-cycle-v2/02-wave-2-execution/gold/VALIDATION.json");
const DB_PATH = resolve(process.env.PENSIONS_DB_PATH || "data/pensions-dashboard.sqlite");
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8"));
const sourceIds = [...new Set(gold.items.flatMap((item) => item.proposition_citation_targets.flatMap((target) => target.source_targets)))].sort();
const database = new DatabaseSync(DB_PATH, { readOnly: true });
const placeholders = sourceIds.map(() => "?").join(",");
const rows = database.prepare(`
  SELECT json_extract(j.value,'$.id') AS id,
         json_extract(j.value,'$.documentId') AS document_id,
         json_extract(j.value,'$.sectionPath') AS section,
         json_extract(j.value,'$.content') AS content
  FROM user_records r, json_each(r.json) j
  WHERE r.user_id='public'
    AND r.record_name='knowledge-chunks.json'
    AND json_extract(j.value,'$.documentId') IN (${placeholders})
`).all(...sourceIds);

const foundDocuments = new Set(rows.map((row) => row.document_id));
const missingDocuments = sourceIds.filter((id) => !foundDocuments.has(id));
if (missingDocuments.length) throw new Error(`Gold source IDs are not indexed: ${missingDocuments.join(", ")}`);

const STOPWORDS = new Set("a an and are as at be been before being between but by can could did do does doing each for from had has have having how if in into is it its may might more most must no nor not of on only or other our should so some such than that the their them then there these they this those through to under until up very was we were what when where which while who why will with would".split(" "));
function terms(value) {
  return String(value || "").normalize("NFKC").toLowerCase().match(/[a-z0-9£%]+/g)?.filter((term) => term.length > 2 && !STOPWORDS.has(term)) || [];
}
function score(proposition, row) {
  const query = [...new Set(terms(proposition))];
  const sectionTerms = new Set(terms(row.section));
  const contentTerms = new Set(terms(row.content));
  if (!query.length) return 0;
  const weighted = query.reduce((sum, term) => sum + (sectionTerms.has(term) ? 2 : contentTerms.has(term) ? 1 : 0), 0);
  const exactNumbers = [...new Set(String(proposition).match(/\b\d+(?:\.\d+)?%?\b/g) || [])];
  const numberBonus = exactNumbers.reduce((sum, number) => sum + (`${row.section} ${row.content}`.includes(number) ? 0.25 : 0), 0);
  return weighted / query.length + numberBonus;
}

for (const item of gold.items) {
  for (const target of item.proposition_citation_targets) {
    const candidates = rows.filter((row) => target.source_targets.includes(row.document_id))
      .map((row) => ({ ...row, score: score(target.proposition, row) }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const selected = [];
    const usedDocuments = new Set();
    for (const candidate of candidates) {
      if (candidate.score <= 0 || usedDocuments.has(candidate.document_id)) continue;
      selected.push({ chunk_id: candidate.id, document_id: candidate.document_id, section: candidate.section, lexical_pin_score: Number(candidate.score.toFixed(4)) });
      usedDocuments.add(candidate.document_id);
      if (selected.length === 3) break;
    }
    target.chunk_targets = selected;
    target.status = selected.length ? "passage_pinned_pending_independent_entailment_confirmation" : "no_passage_pin_found";
  }
}

gold.generated_at = new Date().toISOString();
gold.status = "draft_with_passage_pins_pending_independent_legal_semantic_review";
gold.passage_pin_method = "Deterministic lexical candidate selection over the frozen approved corpus; pins must be independently checked for exact entailment before official scoring.";
writeFileSync(GOLD_PATH, `${JSON.stringify(gold, null, 2)}\n`);
const targets = gold.items.flatMap((item) => item.proposition_citation_targets.map((target) => ({ item, target })));
const rowsMarkdown = targets.map(({ item, target }) => `| ${item.id} | ${target.proposition_id} | ${target.proposition.replaceAll("|", "\\|")} | ${target.chunk_targets.map((pin) => `${pin.chunk_id} (${pin.lexical_pin_score})`).join("<br>") || "NO PIN"} |`).join("\n");
writeFileSync(REVIEW_PATH, `# Wave 2 proposition passage-pin review\n\nThese are deterministic candidate pins, not a substitute for independent legal/semantic entailment review.\n\n| Item | Proposition | Proposition text | Candidate passage pins |\n|---|---|---|---|\n${rowsMarkdown}\n`);
writeFileSync(VALIDATION_PATH, `${JSON.stringify({
  version: "wave-2-development-gold-validation-v1",
  generated_at: new Date().toISOString(),
  item_count: gold.items.length,
  proposition_count: targets.length,
  unique_item_ids: new Set(gold.items.map((item) => item.id)).size === gold.items.length,
  source_ids_indexed: missingDocuments.length === 0,
  indexed_source_count: sourceIds.length,
  propositions_with_candidate_passage_pins: targets.filter(({ target }) => target.chunk_targets.length).length,
  propositions_without_candidate_passage_pins: targets.filter(({ target }) => !target.chunk_targets.length).length,
  diagnostic_gold_training_eligibility: "prohibited",
  independent_legal_semantic_review: "pending",
  exact_passage_entailment_review: "pending",
  official_scoring_authorised: false,
  provisional_development_scoring_authorised: true,
}, null, 2)}\n`);
console.log(JSON.stringify({ items: gold.items.length, propositions: targets.length, indexed_sources: sourceIds.length, chunk_rows_considered: rows.length, propositions_with_pins: targets.filter(({ target }) => target.chunk_targets.length).length, propositions_without_pins: targets.filter(({ target }) => !target.chunk_targets.length).length, output: GOLD_PATH, review: REVIEW_PATH }, null, 2));
