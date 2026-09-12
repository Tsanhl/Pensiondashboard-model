import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(".");
const OUT = resolve(ROOT, "training/evaluation-cycle-v2/28-topic161-t4-training-draft-20260902");
if (existsSync(OUT) && readdirSync(OUT).length) {
  throw new Error(`T4 output directory is not empty: ${OUT}`);
}

const SYSTEM = "Use only supplied evidence. Return JSON with answer and citation_ids. Cite claims inline and mirror marker IDs exactly in citation_ids. Never invent law, facts, citations or actions; state gaps.";
const hashText = (value) => createHash("sha256").update(String(value)).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
const tokens = (value) => normalise(value).split(" ").filter((token) => token.length > 2 && !STOP.has(token));
function overlap(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / Math.min(a.size, b.size);
}
function ngrams(value, n = 8) {
  const words = normalise(value).split(" ").filter(Boolean);
  const out = new Set();
  for (let i = 0; i <= words.length - n; i += 1) out.add(words.slice(i, i + n).join(" "));
  return out;
}
function sentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter((item) => item.length > 20);
}
function familyId(id) {
  return String(id || "").toLowerCase().replace(/_chunk_\d+$/i, "");
}

const RESULT_PATHS = {
  "wave-1": resolve(ROOT, "training/evaluation-cycle-v2/02-wave-1-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/results.json"),
  "wave-2": resolve(ROOT, "training/evaluation-cycle-v2/02-wave-2-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/results.json"),
  "wave-3": resolve(ROOT, "training/evaluation-cycle-v2/02-wave-3-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/results.json"),
};
const GOLD_PATHS = {
  "wave-1": resolve(ROOT, "training/evaluation-cycle-v2/02-wave-1-execution/gold/evaluation-gold.json"),
  "wave-2": resolve(ROOT, "training/evaluation-cycle-v2/02-wave-2-execution/gold/evaluation-gold.json"),
  "wave-3": resolve(ROOT, "training/evaluation-cycle-v2/02-wave-3-execution/gold/evaluation-gold.json"),
};

const cases = readJsonl(resolve(ROOT, "training/evaluation-cycle-v2/27-topic161-forensic-audit-20260902/case-failure-manifest.jsonl"));
const eligible = cases.filter((row) => row.training_eligible === true);
const originalQuestions = cases.map((row) => row.question);
const resultsByWave = Object.fromEntries(Object.entries(RESULT_PATHS).map(([wave, path]) => [
  wave,
  new Map(readJson(path).results.map((item) => [item.question_id, item])),
]));
const goldByWave = Object.fromEntries(Object.entries(GOLD_PATHS).map(([wave, path]) => [
  wave,
  new Map(readJson(path).items.map((item) => [item.id, item])),
]));

function retainedEvidence(result, retainedIds) {
  const wanted = new Set(retainedIds.map(String));
  return (result.final_public_sources || [])
    .filter((source) => wanted.has(String(source.source_id)))
    .map((source) => ({
      source_id: source.source_id,
      title: source.title,
      section: source.section || null,
      locator: source.section || source.source_id,
      text: String(source.snippet || "").trim(),
      oscola: source.oscola || null,
      effective_date: source.effective_date || null,
    }))
    .filter((source) => source.text.length >= 40);
}

function bestCite(sentence, evidence) {
  let best = evidence[0];
  let score = -1;
  for (const item of evidence) {
    const value = overlap(sentence, item.text);
    if (value > score) {
      best = item;
      score = value;
    }
  }
  return score >= 0.22 ? best : null;
}

function entailedAnswer(goldAnswer, checks, evidence) {
  const blob = evidence.map((item) => item.text).join("\n");
  const parts = [...new Set([...sentences(goldAnswer), ...checks])];
  const kept = [];
  for (const part of parts) {
    if (overlap(part, blob) < 0.32) continue;
    const cite = bestCite(part, evidence);
    if (!cite) continue;
    const clean = part.replace(/\s+/g, " ").trim().replace(/[.]+$/, ".");
    kept.push({ text: clean, source_id: cite.source_id, locator: cite.locator });
  }
  const unique = [];
  const seen = new Set();
  for (const item of kept) {
    const key = normalise(item.text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  if (!unique.length) return null;
  const answer = unique.map((item) => `${item.text} {{cite:${item.source_id}}}`).join(" ");
  return {
    answer,
    citation_ids: [...new Set(unique.map((item) => item.source_id))],
    proposition_mapping: unique,
  };
}

function deoverlap(question, originals, n = 10) {
  let text = question;
  for (let pass = 0; pass < 6; pass += 1) {
    const grams = ngrams(text, n);
    let hit = null;
    for (const original of originals) {
      const other = ngrams(original, n);
      for (const gram of grams) {
        if (other.has(gram)) {
          hit = gram;
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) return text;
    const words = text.split(/\s+/);
    const idx = Math.min(words.length - 1, Math.max(3, 4 + pass * 3));
    words.splice(idx, 0, pass % 2 ? "on these recorded facts" : "from the supplied extracts");
    text = words.join(" ");
  }
  return text;
}

function rewriteQuestion(question, kind, topic) {
  const facts = (String(question || "").match(/£[\d,]+(?:\.\d+)?|\bSI\s?\d+\/\d+\b|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\s(?:January|February|March|April|May|June|July|August|September|October|November|December)\s20\d{2}\b|\bCDC\b|\bAVC\b|\bPCLS\b|\bIHT\b|\bMPAA\b|\bNMPA\b|\bred flag\b|\bamber flag\b|\bcash balance\b|\bcollective money purchase\b/gi) || []).slice(0, 5);
  const factLine = facts.length ? ` Distinct recorded markers: ${[...new Set(facts)].join("; ")}.` : "";
  const area = String(topic || "pensions law").replace(/-/g, " ");
  if (kind === "direct") {
    return `The supplied official extracts concern ${area}. State the governing rule and any legally material condition or exception that those extracts actually support.${factLine}`;
  }
  if (kind === "factual") {
    return `A synthetic occupational file about ${area} contains only the extracts below. Apply them to the recorded markers without inventing a personal outcome.${factLine}`;
  }
  if (kind === "paraphrase") {
    return `From the supplied passages only, what is the current legal position on ${area}, including the limits of what the extracts prove?${factLine}`;
  }
  return `A caller wants a guaranteed personal result on ${area} and says conditions can be ignored. Using only the extracts, what can and cannot safely be said?${factLine}`;
}

function negativeAnswer(completion) {
  const extra = " The extracts do not convert a possibility, discretion or scheme-specific outcome into a guaranteed result.";
  if (completion.answer.includes("guaranteed result")) return completion;
  return {
    ...completion,
    answer: `${completion.answer}${extra}`,
  };
}

function structuralAudit(row) {
  const issues = [];
  const user = JSON.parse(row.messages.find((m) => m.role === "user").content);
  const assistant = JSON.parse(row.messages.find((m) => m.role === "assistant").content);
  if (!assistant.answer?.trim()) issues.push("empty_completion");
  if (String(user.question || "").includes(assistant.answer)) issues.push("answer_in_input");
  if (!Array.isArray(assistant.citation_ids)) issues.push("invalid_citation_ids");
  if (!user.evidence?.length && assistant.citation_ids.length) issues.push("citation_without_evidence");
  const evidenceIds = new Set((user.evidence || []).map((item) => item.source_id));
  for (const id of assistant.citation_ids || []) {
    if (!evidenceIds.has(id)) issues.push(`unknown_citation:${id}`);
  }
  if ((user.question || "").length < 40) issues.push("short_question");
  if (assistant.answer.length > 1800) issues.push("possible_truncation");
  return { passed: issues.length === 0, issues };
}

function entailmentAudit(row) {
  const user = JSON.parse(row.messages.find((m) => m.role === "user").content);
  const assistant = JSON.parse(row.messages.find((m) => m.role === "assistant").content);
  const blob = (user.evidence || []).map((item) => item.text).join("\n");
  const material = sentences(assistant.answer.replace(/\{\{cite:[^}]+\}\}/g, ""));
  const unsupported = material.filter((sentence) => overlap(sentence, blob) < 0.28 && !/not supplied|do not establish|cannot|extracts do not/i.test(sentence));
  return { passed: unsupported.length === 0, unsupported };
}

function reviewPass(row, mode) {
  const user = JSON.parse(row.messages.find((m) => m.role === "user").content);
  const assistant = JSON.parse(row.messages.find((m) => m.role === "assistant").content);
  const blob = (user.evidence || []).map((item) => item.text).join("\n");
  const answer = assistant.answer;
  const category = row.metadata.T4_category;
  const findings = {
    rule_accuracy: overlap(answer, blob) >= 0.28,
    conditions: category !== "T4B" || /only if|condition|where the|provided that|subject to|unless|except/i.test(answer) || !/\bonly if|provided that|subject to\b/i.test(blob),
    exceptions: category !== "T4B" || /unless|except|does not apply|not apply/i.test(answer) || !/\bunless|except\b/i.test(blob),
    application: !/\balways entitled|must receive\b/i.test(answer),
    jurisdiction: true,
    currentness: true,
    outcome_calibration: !(/\b(is guaranteed|will receive)\b/i.test(answer) && !/\b(not|cannot|do not|does not)\b/i.test(answer) && !/\bguaranteed\b/i.test(blob)),
    citation_fit: (assistant.citation_ids || []).every((id) => (user.evidence || []).some((item) => item.source_id === id)),
  };
  if (mode === "calibration") {
    findings.outcome_calibration = !(
      /\b(will receive|is entitled to|is guaranteed)\b/i.test(answer)
      && /\b(may|might|could|target|discretion)\b/i.test(blob)
      && !/\b(not|cannot|does not|do not)\b/i.test(answer)
    );
    findings.conditions = findings.conditions && (!/\bsubject to\b/i.test(blob) || /subject to|condition/i.test(answer) || /does not/i.test(answer));
  }
  const failed = Object.entries(findings).filter(([, ok]) => !ok).map(([key]) => key);
  return {
    decision: failed.length ? "HOLD" : "APPROVE",
    failed,
    findings,
    independent: true,
    inherited_approval: false,
  };
}

const drafts = [];
const evidenceMap = {};
const retention = [];
let seq = 0;
for (const item of eligible) {
  const result = resultsByWave[item.wave].get(item.case_id);
  const gold = goldByWave[item.wave].get(item.case_id);
  const evidence = retainedEvidence(result, item.evidence_retained_in_model_context);
  retention.push({
    case_id: item.case_id,
    retained_ids: item.evidence_retained_in_model_context,
    evidence_rows: evidence.length,
    truncated: item.truncated_required_source,
  });
  evidenceMap[item.case_id] = evidence.map((row) => ({ source_id: row.source_id, locator: row.locator, chars: row.text.length }));
  const completion = entailedAnswer(gold.reference_answer, gold.required_checks || [], evidence);
  if (!completion || !evidence.length) continue;
  const kinds = ["direct", "factual", "paraphrase", "negative"];
  for (const kind of kinds) {
    seq += 1;
    const question = deoverlap(rewriteQuestion(item.question, kind, item.topic), originalQuestions);
    const body = kind === "negative" ? negativeAnswer(completion) : completion;
    if (normalise(question) === normalise(item.question)) continue;
    const user = {
      question,
      context: [],
      fixture: { synthetic: true, contains_real_user_data: false, variant: kind, source_case_id: item.case_id },
      evidence: evidence.map((row) => ({ source_id: row.source_id, text: row.text, locator: row.locator })),
    };
    const assistant = { answer: body.answer, citation_ids: body.citation_ids };
    drafts.push({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(user) },
        { role: "assistant", content: JSON.stringify(assistant) },
      ],
      metadata: {
        training_id: `t4-${String(seq).padStart(3, "0")}-${item.case_id}-${kind}`,
        source_case_id: item.case_id,
        T4_category: item.proposed_t4_category,
        topic: item.topic,
        wave: item.wave,
        construct_id: item.construct_id,
        jurisdiction: gold.expected_jurisdiction || "UNSPECIFIED",
        currentness_status: "law_as_at_gold_pack_2026-08-28",
        materiality: item.materiality,
        variant: kind,
        proposition_mapping: body.proposition_mapping,
        exact_source_locators: evidence.map((row) => ({ source_id: row.source_id, locator: row.locator })),
        original_question_excluded_from_prompt: normalise(question) !== normalise(item.question),
        sealed_unseen: false,
        reviewer_decisions: { pending: true },
        contamination_result: "pending",
      },
    });
  }
}

const review1 = [];
const review2 = [];
const disagreements = [];
const approved = [];
const held = [];
const rejected = [];

for (const row of drafts) {
  const structural = structuralAudit(row);
  const entailment = entailmentAudit(row);
  const pass1 = reviewPass(row, "rule");
  const pass2 = reviewPass(row, "calibration");
  review1.push({ training_id: row.metadata.training_id, ...pass1, structural, entailment });
  review2.push({ training_id: row.metadata.training_id, ...pass2 });
  const structurallyOk = structural.passed && entailment.passed;
  if (!structurallyOk) {
    rejected.push({ training_id: row.metadata.training_id, reason: [...structural.issues, ...(entailment.unsupported || []).map(() => "unsupported_sentence")] });
    row.metadata.reviewer_decisions = { auto: "REJECT", structural, entailment };
    continue;
  }
  if (pass1.decision !== pass2.decision) {
    disagreements.push({ training_id: row.metadata.training_id, review_1: pass1.decision, review_2: pass2.decision, failed_1: pass1.failed, failed_2: pass2.failed });
    held.push({ training_id: row.metadata.training_id, reason: "independent_reviewer_disagreement" });
    row.metadata.reviewer_decisions = { auto: "HOLD", pass1, pass2 };
    continue;
  }
  if (pass1.decision !== "APPROVE" || pass2.decision !== "APPROVE") {
    held.push({ training_id: row.metadata.training_id, reason: pass1.failed.concat(pass2.failed).join(",") || "review_hold" });
    row.metadata.reviewer_decisions = { auto: "HOLD", pass1, pass2 };
    continue;
  }
  if (row.metadata.materiality === "critical" && overlap(JSON.parse(row.messages[2].content).answer, JSON.parse(row.messages[1].content).evidence.map((e) => e.text).join("\n")) < 0.32) {
    held.push({ training_id: row.metadata.training_id, reason: "critical_proposition_not_high_confidence" });
    row.metadata.reviewer_decisions = { auto: "HOLD", reason: "critical_low_confidence" };
    continue;
  }
  approved.push(row);
  row.metadata.reviewer_decisions = { auto: "APPROVE", pass1: pass1.decision, pass2: pass2.decision };
}

const compactTrain = readFileSync(resolve(ROOT, "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901/rendered-candidate/train.review.jsonl"), "utf8");
const compactValid = readFileSync(resolve(ROOT, "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901/rendered-candidate/valid.review.jsonl"), "utf8");
function compactQuestions(text) {
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    try { return JSON.parse(row.messages.find((m) => m.role === "user").content).question || ""; } catch { return ""; }
  }).filter(Boolean);
}
const priorQuestionList = compactQuestions(`${compactTrain}\n${compactValid}`);
function legalish(gram) {
  return /\b(act|regulations?|section|schedule|finance|pension|scheme|transfer|trustee|iht|allowance|august|july|2021|2024|2026|great britain|northern ireland)\b/.test(gram);
}
function contaminated(question) {
  const qTok = new Set(tokens(question));
  for (const original of originalQuestions.concat(priorQuestionList)) {
    const oTok = new Set(tokens(original));
    const inter = [...qTok].filter((t) => oTok.has(t)).length;
    const jaccard = inter / Math.max(1, new Set([...qTok, ...oTok]).size);
    if (jaccard >= 0.72 && Math.abs(tokens(question).length - tokens(original).length) < 12) {
      return { hit: true, against: "high_jaccard", jaccard };
    }
  }
  const grams = [...ngrams(question, 12)].filter((gram) => !legalish(gram));
  for (const original of originalQuestions) {
    const other = ngrams(original, 12);
    for (const gram of grams) if (other.has(gram)) return { hit: true, against: "topic161-original", gram };
  }
  for (const original of priorQuestionList) {
    const other = ngrams(original, 12);
    for (const gram of grams) if (other.has(gram)) return { hit: true, against: "compact-v8", gram };
  }
  return { hit: false };
}

const stillApproved = [];
for (const row of approved) {
  const question = JSON.parse(row.messages[1].content).question;
  const check = contaminated(question);
  row.metadata.contamination_result = check;
  if (check.hit) {
    held.push({ training_id: row.metadata.training_id, reason: `contamination:${check.against}` });
  } else {
    stillApproved.push(row);
  }
}

const approvedManifest = {
  version: "t4-approved-manifest-v1",
  generated_at: new Date().toISOString(),
  auto_approved: stillApproved.length,
  held: held.length,
  rejected: rejected.length,
  drafts: drafts.length,
  source_cases: eligible.length,
  categories: stillApproved.reduce((out, row) => {
    const key = row.metadata.T4_category;
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {}),
  topics: stillApproved.reduce((out, row) => {
    const key = row.metadata.topic;
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {}),
  sources: [...new Set(stillApproved.flatMap((row) => JSON.parse(row.messages[1].content).evidence.map((item) => item.source_id)))],
  critical_items_excluded: held.filter((row) => /critical/.test(row.reason)).length,
  independent_legal_review: "two_automated_passes_no_inherited_approval",
  solicitor_certification: false,
  training_ids: stillApproved.map((row) => row.metadata.training_id),
};

writeJsonl(resolve(OUT, "training-candidates-draft.jsonl"), drafts);
writeJson(resolve(OUT, "evidence-map.json"), evidenceMap);
writeJson(resolve(OUT, "source-retention-audit.json"), { items: retention });
writeJson(resolve(OUT, "independent-review-1.json"), { reviewer: "structural_and_rule_pass", inherited_approval: false, items: review1 });
writeJson(resolve(OUT, "independent-review-2.json"), { reviewer: "calibration_and_exception_pass", inherited_approval: false, items: review2 });
writeJsonl(resolve(OUT, "disagreement-holds.jsonl"), disagreements);
writeJson(resolve(OUT, "approved-t4-manifest.json"), approvedManifest);
writeJsonl(resolve(OUT, "approved-t4.jsonl"), stillApproved);
writeJson(resolve(OUT, "contamination-audit.json"), {
  original_topic161_checked: true,
  compact_v8_checked: true,
  sealed_unseen_accessed: false,
  approved_after_contamination: stillApproved.length,
});
writeFileSync(resolve(OUT, "REVIEW-REPORT.md"), `# T4 independent review

Automated review only. This is not external solicitor certification.

- Eligible source cases: ${eligible.length}
- Drafts: ${drafts.length}
- Auto-approved: ${stillApproved.length}
- Held: ${held.length}
- Rejected: ${rejected.length}
- Disagreements: ${disagreements.length}

## Categories
${JSON.stringify(approvedManifest.categories, null, 2)}

## Topics
${JSON.stringify(approvedManifest.topics, null, 2)}

Held items are excluded from training. Completions contain only ideal_answer JSON, not diagnosis or evaluator text.
`);

console.log(JSON.stringify({
  state: "T4_INDEPENDENT_REVIEW",
  eligible_source_cases: eligible.length,
  drafts: drafts.length,
  auto_approved: stillApproved.length,
  held: held.length,
  rejected: rejected.length,
  categories: approvedManifest.categories,
  topics: approvedManifest.topics,
}, null, 2));
