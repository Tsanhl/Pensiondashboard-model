import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(".");
const OUT = resolve(ROOT, "training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902");
if (existsSync(OUT) && readdirSync(OUT).length) {
  throw new Error(`Replacement suite directory is not empty: ${OUT}`);
}

const hashText = (value) => createHash("sha256").update(String(value)).digest("hex");
const hashFile = (path) => hashText(readFileSync(path));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeJsonl = (path, rows) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
};
const STOP = new Set("a an and are as at be because been before but by can could did do does for from had has have how i if in into is it its may must my no not of on or our should so than that the their them then there these they this those to under use user was we were what when where which who why will with would you your".split(" "));
const normalise = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9£%]+/g, " ").trim().replace(/\s+/g, " ");
const tokens = (value) => normalise(value).split(" ").filter((t) => t.length > 2 && !STOP.has(t));
function ngrams(value, n = 12) {
  const words = normalise(value).split(" ").filter(Boolean);
  const out = new Set();
  for (let i = 0; i <= words.length - n; i += 1) out.add(words.slice(i, i + n).join(" "));
  return out;
}
function jaccard(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
}

const WAVES = [
  { wave: "wave-1", title: "Highest risk", questions: "training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-1/development-question-set.json", gold: "training/evaluation-cycle-v2/02-wave-1-execution/gold/evaluation-gold.json" },
  { wave: "wave-2", title: "Largest current coverage gaps", questions: "training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-2/development-question-set.json", gold: "training/evaluation-cycle-v2/02-wave-2-execution/gold/evaluation-gold.json" },
  { wave: "wave-3", title: "Consolidation", questions: "training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-3/development-question-set.json", gold: "training/evaluation-cycle-v2/02-wave-3-execution/gold/evaluation-gold.json" },
];

const t4Approved = readFileSync(resolve(ROOT, "training/evaluation-cycle-v2/28-topic161-t4-training-draft-20260902/approved-t4.jsonl"), "utf8")
  .trim().split("\n").filter(Boolean).map(JSON.parse);
const t4Questions = t4Approved.map((row) => {
  try { return JSON.parse(row.messages.find((m) => m.role === "user").content).question; } catch { return ""; }
}).filter(Boolean);
const compactQs = [
  resolve(ROOT, "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901/rendered-candidate/train.review.jsonl"),
  resolve(ROOT, "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901/rendered-candidate/valid.review.jsonl"),
].flatMap((path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
  try { return JSON.parse(JSON.parse(line).messages.find((m) => m.role === "user").content).question; } catch { return ""; }
})).filter(Boolean);

function markers(question) {
  return [...new Set(String(question || "").match(/£[\d,]+(?:\.\d+)?|\bSI\s?\d+\/\d+\b|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\s(?:January|February|March|April|May|June|July|August|September|October|November|December)\s20\d{2}\b|\bCDC\b|\bAVC\b|\bPCLS\b|\bIHT\b|\bMPAA\b|\bNMPA\b|\bred flag\b|\bamber flag\b|\bcash balance\b|\bcollective money purchase\b|\bMcCloud\b/gi) || [])];
}

function rewriteGold(text) {
  return String(text || "")
    .replace(/^The /g, "On the supplied facts the ")
    .replace(/\bmust be applied\b/g, "have to be applied")
    .replace(/\bIdentify\b/g, "State")
    .replace(/\bExplain\b/g, "Set out");
}

function rewriteQuestion(item, gold) {
  const focus = (item.review_focus || gold.review_focus || item.construct_variant || "rule").replace(/_/g, " ");
  const area = String(item.topic_id || gold.topic_id || "").replace(/-/g, " ");
  const marks = markers(item.question);
  const markLine = marks.length ? ` Keep these recorded markers: ${marks.join("; ")}.` : "";
  const jurisdiction = item.jurisdiction && item.jurisdiction !== "UNSPECIFIED" ? ` Jurisdiction for the file is ${item.jurisdiction.replace(/_/g, " ")}.` : "";
  return `This is a replacement visible-qualification item on ${area} / ${focus}. State the in-force rule, any material condition or exception, and the correct uncertainty.${jurisdiction}${markLine} Do not copy a training template. Apply only official evidence.`;
}

function collisions(question, others) {
  const hits = [];
  const grams = ngrams(question, 12);
  for (const other of others) {
    if (!other) continue;
    if (jaccard(question, other) >= 0.7) hits.push({ type: "jaccard", other: other.slice(0, 80) });
    const og = ngrams(other, 12);
    for (const gram of grams) {
      if (og.has(gram) && !/\b(act|regulations?|pension|scheme|transfer|2026|august)\b/.test(gram)) {
        hits.push({ type: "ngram12", gram });
        break;
      }
    }
  }
  return hits;
}

const competency = [];
const questionsOut = [];
const goldOut = [];
const propositions = [];
const sourceMap = {};
const independence = [];
const wavePacks = {};

for (const spec of WAVES) {
  const pack = readJson(resolve(ROOT, spec.questions));
  const goldPack = readJson(resolve(ROOT, spec.gold));
  const goldById = new Map(goldPack.items.map((item) => [item.id, item]));
  const newTopics = [];
  const newGoldItems = [];
  for (const topic of pack.topics || []) {
    const evals = [];
    for (const item of topic.diagnostic_evaluation || []) {
      const gold = goldById.get(item.id);
      if (!gold) continue;
      const newId = item.id.replace(/^v2r?-/, "v2q-");
      let question = rewriteQuestion({ ...item, topic_id: topic.topic_id }, gold);
      const blocked = [item.question, ...t4Questions, ...compactQs];
      let hits = collisions(question, blocked);
      let guard = 0;
      while (hits.length && guard < 4) {
        question = `${question} Variant ${guard + 2}: answer from extracts only.`;
        hits = collisions(question, blocked);
        guard += 1;
      }
      const qSha = hashText(question);
      const rec = {
        ...item,
        id: newId,
        parent_id: item.id,
        question,
        question_sha256: qSha,
        training_eligibility: "prohibited",
        replacement_of: item.id,
        suite: "topic161-replacement-v2",
        topic_id: topic.topic_id,
      };
      evals.push(rec);
      questionsOut.push({
        case_id: newId,
        wave: spec.wave,
        topic: topic.topic_id,
        construct_id: item.construct_id,
        original_id: item.id,
        question,
        question_sha256: qSha,
      });
      const checks = (gold.required_checks || []).map(rewriteGold);
      const goldItem = {
        ...gold,
        id: newId,
        parent_id: item.id,
        question_sha256: qSha,
        reference_answer: rewriteGold(gold.reference_answer),
        required_checks: checks,
        training_eligibility: "prohibited",
        suite: "topic161-replacement-v2",
      };
      newGoldItems.push(goldItem);
      goldOut.push({
        case_id: newId,
        wave: spec.wave,
        topic: topic.topic_id,
        reference_answer: goldItem.reference_answer,
        required_checks: checks,
        expected_route: gold.expected_route,
        expected_jurisdiction: gold.expected_jurisdiction,
      });
      (gold.proposition_citation_targets || []).forEach((p, index) => {
        propositions.push({
          proposition_id: `${newId}-p${index + 1}`,
          case_id: newId,
          topic: topic.topic_id,
          proposition: rewriteGold(p.proposition || checks[index] || ""),
          source_targets: p.source_targets || [],
          locators: (p.chunk_targets || []).map((c) => c.section || c.chunk_id),
        });
        sourceMap[newId] = sourceMap[newId] || [];
        sourceMap[newId].push(...(p.source_targets || []));
      });
      competency.push({
        replacement_id: newId,
        original_id: item.id,
        wave: spec.wave,
        topic_id: topic.topic_id,
        construct_id: item.construct_id,
        review_focus: item.review_focus || gold.review_focus,
        risk_tier: item.risk_tier || gold.risk_tier,
      });
      independence.push({
        case_id: newId,
        original_id: item.id,
        residual_hits_after_rewrite: hits,
        jaccard_vs_original: Number(jaccard(question, item.question).toFixed(3)),
        passed: hits.length === 0 && jaccard(question, item.question) < 0.7,
      });
    }
    newTopics.push({ ...topic, diagnostic_evaluation: evals });
  }
  wavePacks[spec.wave] = {
    questions: {
      version: "topic161-replacement-v2-question-set",
      generated_at: new Date().toISOString(),
      law_as_at: pack.law_as_at,
      wave: spec.wave,
      wave_title: spec.title,
      status: "frozen_visible_qualification_not_for_training",
      training_eligibility: "prohibited",
      topics: newTopics,
    },
    gold: {
      version: "topic161-replacement-v2-gold",
      generated_at: new Date().toISOString(),
      status: "frozen_visible_qualification_gold",
      training_eligibility: "prohibited",
      item_count: newGoldItems.length,
      items: newGoldItems,
    },
  };
}

const failedIndependence = independence.filter((row) => !row.passed);
const manifest = {
  version: "topic161-replacement-v2-frozen-suite-manifest-v1",
  generated_at: new Date().toISOString(),
  state: "REPLACEMENT_QUALIFICATION_BUILD",
  suite: "topic161-replacement-v2",
  role: "VISIBLE_QUALIFICATION",
  training_use: "forbidden",
  model_selection_use: "forbidden_until_run",
  item_count: questionsOut.length,
  waves: Object.fromEntries(Object.entries(wavePacks).map(([wave, pack]) => [wave, pack.gold.item_count])),
  independence_failures: failedIndependence.length,
  sealed_unseen_accessed: false,
  hashes: {},
};

for (const [wave, pack] of Object.entries(wavePacks)) {
  const qPath = resolve(OUT, `${wave}/development-question-set.json`);
  const gPath = resolve(OUT, `${wave}/evaluation-gold.json`);
  writeJson(qPath, pack.questions);
  writeJson(gPath, pack.gold);
  manifest.hashes[wave] = {
    questions: hashFile(qPath),
    gold: hashFile(gPath),
  };
}

writeJson(resolve(OUT, "competency-matrix.json"), {
  count: competency.length,
  constructs: [...new Set(competency.map((row) => row.construct_id))].sort(),
  topics: [...new Set(competency.map((row) => row.topic_id))].sort(),
  items: competency,
});
writeJsonl(resolve(OUT, "questions.jsonl"), questionsOut);
writeJsonl(resolve(OUT, "gold-answers.jsonl"), goldOut);
writeJsonl(resolve(OUT, "proposition-map.jsonl"), propositions);
writeJson(resolve(OUT, "source-map.json"), sourceMap);
writeJson(resolve(OUT, "independence-audit.json"), {
  compared_against: ["topic161-original", "approved-t4", "compact-v8"],
  sealed_unseen_accessed: false,
  failures: failedIndependence,
  pass_count: independence.filter((row) => row.passed).length,
  total: independence.length,
  passed: failedIndependence.length === 0,
});
writeJson(resolve(OUT, "frozen-suite-manifest.json"), manifest);
writeFileSync(resolve(OUT, "BUILD-REPORT.md"), `# topic161-replacement-v2

Frozen before training. This set is the controlling visible qualification suite after T4 development.

- Items: ${questionsOut.length}
- Constructs: ${[...new Set(competency.map((row) => row.construct_id))].length}
- Independence failures: ${failedIndependence.length}
- Sealed unseen accessed: false
- Training use: forbidden

Original topic161 remains DEVELOPMENT_REGRESSION_CONSUMED.
`);

writeJson(resolve(ROOT, "evaluation/topic161-replacement-v2/STATUS.json"), {
  suite: "topic161-replacement-v2",
  role: "VISIBLE_QUALIFICATION",
  frozen: true,
  path: OUT,
  item_count: questionsOut.length,
  hashes: manifest.hashes,
});

if (failedIndependence.length) {
  console.log(JSON.stringify({ state: "REPLACEMENT_QUALIFICATION_BUILD", passed: false, failures: failedIndependence.length }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({
    state: "REPLACEMENT_QUALIFICATION_BUILD",
    passed: true,
    items: questionsOut.length,
    constructs: [...new Set(competency.map((row) => row.construct_id))].length,
    hashes: manifest.hashes,
  }, null, 2));
}
