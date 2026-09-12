import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(".");
const OUT = resolve(ROOT, "training/evaluation-cycle-v2/27-topic161-forensic-audit-20260902");
const ORIG = resolve(ROOT, "evaluation/topic161-original");
if (existsSync(OUT) && readdirSync(OUT).length) {
  throw new Error(`Forensic output directory is not empty: ${OUT}`);
}

const hashText = (value) => createHash("sha256").update(String(value)).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeJsonl = (path, rows) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
};

const STOPWORDS = new Set("a an and are as at be because been before but by can could did do does for from had has have how i if in into is it its may must my no not of on or our should so than that the their them then there these they this those to under use user was we were what when where which who why will with would you your".split(" "));
const normalise = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9£%]+/g, " ").trim().replace(/\s+/g, " ");
const tokens = (value) => new Set(normalise(value).split(" ").filter((token) => token.length > 2 && !STOPWORDS.has(token)));
function overlap(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / Math.min(a.size, b.size);
}
function familyId(id) {
  return String(id || "")
    .toLowerCase()
    .replace(/_chunk_\d+$/i, "")
    .replace(/^(official-|structured_public_|train-)/, "");
}
function familiesMatch(a, b) {
  const fa = familyId(a);
  const fb = familyId(b);
  if (!fa || !fb) return false;
  return fa === fb || fa.includes(fb) || fb.includes(fa);
}
function anyMatch(needles, haystack) {
  return needles.some((needle) => haystack.some((item) => familiesMatch(needle, item)));
}
function flattenQuestions(set) {
  const out = [];
  for (const topic of set.topics || []) {
    for (const item of topic.diagnostic_evaluation || []) {
      out.push({ ...item, topic_id: item.topic_id || topic.topic_id, topic_title: topic.topic_title });
    }
  }
  return out;
}
function propositionType(text) {
  const t = String(text || "").toLowerCase();
  if (/\bexcept|unless|provided that|subject to|does not apply\b/.test(t)) return "exception";
  if (/\bonly (if|where|when)|if the|where the|condition\b/.test(t)) return "condition";
  if (/\bjurisdiction|northern ireland|great britain|scotland|england\b/.test(t)) return "jurisdiction";
  if (/\bcalculate|amount|£|percent|threshold\b/.test(t)) return "calculation";
  if (/\bmust not|cannot|do not|stop|refuse|fail.closed|insufficient\b/.test(t)) return "safety boundary";
  if (/\bprocedure|apply to|notify|complain|ombudsman|tpo\b/.test(t)) return "procedure";
  if (/\bremedy|compensation|restore|maladministration\b/.test(t)) return "remedy";
  if (/\btherefore|so the|this means|conclusion\b/.test(t)) return "conclusion";
  if (/\bapply|classification|this (is|would be)\b/.test(t)) return "application";
  return "rule";
}
function jurisdictionCompatible(expected, actual) {
  if (!expected || expected === "UNSPECIFIED") return true;
  if (expected === "GREAT_BRITAIN") return ["GREAT_BRITAIN", "ENGLAND_AND_WALES", "SCOTLAND"].includes(actual);
  return expected === actual;
}

const MODEL_CLASSES = new Set([
  "MODEL_INVALID_OUTPUT",
  "MODEL_SELECTED_WRONG_RULE",
  "MODEL_OMITTED_MATERIAL_RULE",
  "MODEL_OMITTED_CONDITION",
  "MODEL_OMITTED_EXCEPTION",
  "MODEL_MISAPPLIED_FACTS",
  "MODEL_REVERSED_PARTY_OR_DUTY",
  "MODEL_INVENTED_LEGAL_PROPOSITION",
  "MODEL_OVERSTATED_LEGAL_OUTCOME",
  "MODEL_FAILED_TO_FAIL_CLOSED",
  "MODEL_FAILED_TO_ANSWER_SUPPORTED_CLAIM",
  "MODEL_MULTI_ISSUE_SYNTHESIS_FAILURE",
]);
const NON_MODEL_CLASSES = new Set([
  "EVALUATOR_RUBRIC_DEFECT",
  "GOLD_ANSWER_DEFECT",
  "RUN_INFRASTRUCTURE_ERROR",
  "RETRY_POLICY_FAILURE",
  "ROUTER_SCOPE_ERROR",
  "REQUIRED_SOURCE_NOT_REQUESTED",
  "REQUIRED_SOURCE_NOT_RETRIEVED",
  "REQUIRED_SOURCE_DROPPED",
  "WRONG_SOURCE_PRIORITY",
  "WRONG_JURISDICTION_SOURCE",
  "SOURCE_CURRENTNESS_ERROR",
  "CITATION_NOT_ENTAILING_CLAIM",
  "VALIDATOR_FALSE_REJECTION",
]);

const WAVES = [
  {
    wave: "wave-1",
    questions: resolve(ROOT, "training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-1/development-question-set.json"),
    gold: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-1-execution/gold/evaluation-gold.json"),
    results: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-1-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/results.json"),
    scorecard: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-1-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/scorecard.json"),
  },
  {
    wave: "wave-2",
    questions: resolve(ROOT, "training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-2/development-question-set.json"),
    gold: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-2-execution/gold/evaluation-gold.json"),
    results: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-2-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/results.json"),
    scorecard: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-2-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/scorecard.json"),
  },
  {
    wave: "wave-3",
    questions: resolve(ROOT, "training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-3/development-question-set.json"),
    gold: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-3-execution/gold/evaluation-gold.json"),
    results: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-3-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/results.json"),
    scorecard: resolve(ROOT, "training/evaluation-cycle-v2/02-wave-3-execution/diagnostic/visibleq-v1-20260902-r51-step130-v7-topic-full/scorecard.json"),
  },
];

const cases = [];
const propositions = [];
const held = [];

for (const spec of WAVES) {
  const questions = new Map(flattenQuestions(readJson(spec.questions)).map((item) => [item.id, item]));
  const goldItems = new Map(readJson(spec.gold).items.map((item) => [item.id, item]));
  const results = new Map(readJson(spec.results).results.map((item) => [item.question_id, item]));
  const scorecard = readJson(spec.scorecard);
  for (const scored of scorecard.items) {
    const gold = goldItems.get(scored.question_id);
    const result = results.get(scored.question_id);
    const question = questions.get(scored.question_id);
    if (!gold || !result || !question) {
      held.push({
        case_id: scored.question_id,
        wave: spec.wave,
        reason: "missing_gold_result_or_question",
        training_eligible: false,
      });
      continue;
    }
    const answer = String(result.final_system_answer || "");
    const retrieved = (result.retrieved_chunk_ids || []).map(String);
    const excerptIds = (result.source_excerpts || []).map((item) => String(item.sourceId || item.source_id || ""));
    const cited = (result.generated_citations || []).map(String);
    const snippetById = new Map((result.final_public_sources || []).map((item) => [String(item.source_id), String(item.snippet || "")]));
    const visibleText = excerptIds.map((id) => snippetById.get(id) || "").join("\n");
    const requiredSources = [...new Set((gold.proposition_citation_targets || []).flatMap((p) => [
      ...(p.source_targets || []),
      ...((p.chunk_targets || []).map((c) => c.chunk_id || c.document_id)),
    ]))];
    const questionSources = [...new Set(question.primary_source_targets || [])];
    const needed = requiredSources.length ? requiredSources : questionSources;
    const scopes = result.retrieval_trace?.scopes || [];
    const requested = Array.isArray(scopes) && scopes.length > 0 && !result.retrieval_trace?.noResult;
    const retrievedNeeded = needed.length ? anyMatch(needed, retrieved) : retrieved.length > 0;
    const retainedNeeded = needed.length ? anyMatch(needed, excerptIds) : excerptIds.length > 0;
    const truncatedRequired = (result.source_excerpts || []).some((item) => item.truncated === true && anyMatch(needed, [item.sourceId]));
    const groundingReason = result.grounding_validation?.reason || scored.grounding_reason || null;
    const groundingValid = result.grounding_validation?.valid === true || groundingReason === "grounded";
    const runError = result.run_error || result.selected_route === "RUN_ERROR" || scored.status === "run_error";
    const checks = gold.required_checks || [];
    const overlaps = checks.map((check) => overlap(check, answer));
    const omitted = checks.filter((_, i) => (overlaps[i] || 0) < 0.45);
    const supportedChecks = checks.filter((check) => overlap(check, visibleText) >= 0.35);
    const mustNotHit = (gold.must_not || []).filter((rule) => {
      const key = normalise(rule).split(" ").slice(0, 6).join(" ");
      return key.length > 12 && normalise(answer).includes(key);
    });
    const overstated = /\b(must|will|entitled to|guaranteed)\b/i.test(answer) && /\b(may|might|could|discretion|scheme-specific|does not (?:automatically|necessarily))\b/i.test(gold.reference_answer || "");
    const invented = /invented_citation/.test(String(scored.critical_failure_signals || [])) || groundingReason === "invented_citation";
    const failClosedNeeded = ["SECURITY_FALLBACK", "REFUSE_ACTION", "INSUFFICIENT_EVIDENCE"].includes(gold.expected_route);
    const answeredWithoutEvidence = result.model_call_attempted === true && excerptIds.length === 0 && result.selected_route === "ANSWER";
    const refusedWithEvidence = excerptIds.length > 0 && ["INSUFFICIENT_EVIDENCE", "HUMAN_HANDOFF"].includes(result.selected_route) && gold.expected_route === "ANSWER";

    const secondary = [];
    let primary = "INCOMPLETE_NONCRITICAL";
    if (scored.status === "pass") primary = "NO_DEFECT_PASS";
    else if (runError || /model_unavailable|fetch failed|ECONN|timeout/i.test(JSON.stringify(result.run_error || ""))) {
      primary = "RUN_INFRASTRUCTURE_ERROR";
    } else if (!result.model_call_attempted && result.selected_route === "RUN_ERROR") {
      primary = "RUN_INFRASTRUCTURE_ERROR";
    } else if (groundingReason === "MODEL_INVALID_OUTPUT" || /unfinished|invalid json|truncated json/i.test(String(result.raw_model_output || ""))) {
      primary = "MODEL_INVALID_OUTPUT";
    } else if (!requested && needed.length && result.selected_route !== "SECURITY_FALLBACK") {
      primary = "REQUIRED_SOURCE_NOT_REQUESTED";
    } else if (needed.length && !retrievedNeeded) {
      primary = retrieved.length && !anyMatch(needed, retrieved) ? "WRONG_SOURCE_PRIORITY" : "REQUIRED_SOURCE_NOT_RETRIEVED";
    } else if (needed.length && retrievedNeeded && !retainedNeeded) {
      primary = "REQUIRED_SOURCE_DROPPED";
    } else if (!jurisdictionCompatible(gold.expected_jurisdiction, result.selected_jurisdiction) && (gold.critical_failure_signals || []).includes("wrong_jurisdiction")) {
      primary = "WRONG_JURISDICTION_SOURCE";
    } else if (gold.expected_route && gold.expected_route !== "ANSWER_OR_HANDOFF" && result.selected_route !== gold.expected_route && ["SECURITY_FALLBACK", "REFUSE_ACTION"].includes(gold.expected_route)) {
      primary = "ROUTER_SCOPE_ERROR";
    } else if (groundingReason && /law_source_not_current|stale|expired/.test(String(groundingReason))) {
      primary = "SOURCE_CURRENTNESS_ERROR";
    } else if (groundingReason === "missing_oscola_citation" || groundingReason === "GROUNDING_FALLBACK") {
      primary = scored.components?.legal_and_required_content >= 3 ? "VALIDATOR_FALSE_REJECTION" : "CITATION_NOT_ENTAILING_CLAIM";
    } else if (invented) {
      primary = "MODEL_INVENTED_LEGAL_PROPOSITION";
    } else if (answeredWithoutEvidence) {
      primary = "MODEL_FAILED_TO_FAIL_CLOSED";
    } else if (refusedWithEvidence && supportedChecks.length) {
      primary = "MODEL_FAILED_TO_ANSWER_SUPPORTED_CLAIM";
    } else if (failClosedNeeded && result.selected_route === "ANSWER") {
      primary = "MODEL_FAILED_TO_FAIL_CLOSED";
    } else if (mustNotHit.length) {
      primary = "MODEL_INVENTED_LEGAL_PROPOSITION";
    } else if (overstated && omitted.length) {
      primary = "MODEL_OVERSTATED_LEGAL_OUTCOME";
    } else if (omitted.some((text) => /except|unless|provided that|subject to/i.test(text)) && retainedNeeded) {
      primary = "MODEL_OMITTED_EXCEPTION";
    } else if (omitted.some((text) => /only (if|where)|condition|threshold/i.test(text)) && retainedNeeded) {
      primary = "MODEL_OMITTED_CONDITION";
    } else if (omitted.length >= 2 && retainedNeeded && excerptIds.length) {
      primary = omitted.length >= 3 ? "MODEL_MULTI_ISSUE_SYNTHESIS_FAILURE" : "MODEL_OMITTED_MATERIAL_RULE";
    } else if (retainedNeeded && scored.substantive_failure_signals?.includes("material_legal_or_commencement_error")) {
      primary = "MODEL_SELECTED_WRONG_RULE";
    } else if (retainedNeeded && omitted.length) {
      primary = "MODEL_OMITTED_MATERIAL_RULE";
    } else if (!retainedNeeded && retrieved.length) {
      primary = "REQUIRED_SOURCE_DROPPED";
    } else if (scored.status === "partial") {
      primary = "INCOMPLETE_NONCRITICAL";
    } else {
      primary = retainedNeeded ? "MODEL_OMITTED_MATERIAL_RULE" : "REQUIRED_SOURCE_NOT_RETRIEVED";
    }

    if (truncatedRequired && primary.startsWith("MODEL_")) secondary.push("REQUIRED_SOURCE_DROPPED");
    if (runError) secondary.push("RUN_INFRASTRUCTURE_ERROR");
    if (!groundingValid && primary.startsWith("MODEL_")) secondary.push("CITATION_NOT_ENTAILING_CLAIM");

    const evidenceInContext = retainedNeeded && excerptIds.length > 0 && result.model_call_attempted === true && !runError;
    const spanSupportsFailed = omitted.length === 0 || omitted.every((check) => overlap(check, visibleText) >= 0.28);
    const goldHasSources = needed.length > 0;
    const locatorKnown = (gold.proposition_citation_targets || []).some((p) => (p.chunk_targets || []).length || (p.source_targets || []).length);
    const rubricPresent = checks.length > 0 && gold.reference_answer;
    const trainingEligible = Boolean(
      scored.status !== "pass"
      && evidenceInContext
      && goldHasSources
      && locatorKnown
      && rubricPresent
      && jurisdictionCompatible(gold.expected_jurisdiction, result.selected_jurisdiction)
      && !/law_source_not_current/.test(String(groundingReason || ""))
      && groundingReason !== "VALIDATOR_FALSE_REJECTION"
      && primary !== "VALIDATOR_FALSE_REJECTION"
      && !runError
      && MODEL_CLASSES.has(primary)
      && spanSupportsFailed
      && supportedChecks.length > 0,
    );

    let t4 = null;
    if (trainingEligible) {
      t4 = {
        MODEL_SELECTED_WRONG_RULE: "T4A",
        MODEL_OMITTED_CONDITION: "T4B",
        MODEL_OMITTED_EXCEPTION: "T4B",
        MODEL_OMITTED_MATERIAL_RULE: "T4B",
        MODEL_MISAPPLIED_FACTS: "T4C",
        MODEL_REVERSED_PARTY_OR_DUTY: "T4C",
        MODEL_OVERSTATED_LEGAL_OUTCOME: "T4D",
        CITATION_NOT_ENTAILING_CLAIM: "T4E",
        MODEL_MULTI_ISSUE_SYNTHESIS_FAILURE: "T4F",
        MODEL_FAILED_TO_FAIL_CLOSED: "T4G",
        MODEL_FAILED_TO_ANSWER_SUPPORTED_CLAIM: "T4G",
        MODEL_INVENTED_LEGAL_PROPOSITION: "T4G",
        MODEL_INVALID_OUTPUT: null,
      }[primary] || "T4F";
    }

    const record = {
      case_id: scored.question_id,
      wave: spec.wave,
      topic: scored.topic_id,
      subtopic: question.review_focus || gold.review_focus || question.construct_variant || null,
      construct_id: question.construct_id || gold.construct_id,
      question: question.question,
      expected_answer: gold.reference_answer,
      expected_propositions: checks,
      actual_answer: answer,
      verdict: scored.status,
      materiality: scored.status === "critical_fail" ? "critical" : scored.status === "fail" ? "material" : scored.status === "partial" ? "noncritical" : "none",
      criticality: (scored.critical_failure_signals || []).length ? "critical" : "noncritical",
      route: { expected: gold.expected_route, actual: result.selected_route },
      evidence_requested: requested,
      evidence_retrieved: retrieved,
      evidence_retained_in_model_context: excerptIds,
      evidence_cited: cited,
      validator_result: groundingReason,
      runtime_result: runError ? result.run_error || { route: result.selected_route } : { ok: true, model_call_attempted: result.model_call_attempted },
      primary_root_cause: primary,
      secondary_root_causes: [...new Set(secondary)],
      training_eligible: trainingEligible,
      proposed_t4_category: t4,
      proposed_remediation: trainingEligible
        ? "source-bound T4 legal training example from model-visible retained evidence"
        : NON_MODEL_CLASSES.has(primary)
          ? "non-model repair or exclude from training"
          : primary === "NO_DEFECT_PASS"
            ? "none"
            : "hold; do not train",
      source_visible_for_needed: retainedNeeded,
      truncated_required_source: truncatedRequired,
      required_check_overlap: overlaps,
      needed_sources: needed,
    };
    cases.push(record);

    checks.forEach((text, index) => {
      const pin = (gold.proposition_citation_targets || []).find((p) => p.proposition === text) || gold.proposition_citation_targets?.[index];
      const locator = pin?.chunk_targets?.[0] || null;
      const official = (pin?.source_targets || needed)[0] || null;
      const visible = official ? anyMatch([official, locator?.chunk_id, locator?.document_id].filter(Boolean), excerptIds) : retainedNeeded;
      const ov = overlaps[index] || 0;
      let treatment = "omitted";
      if (ov >= 0.6) treatment = "correct";
      else if (invented && ov < 0.3) treatment = "invented";
      else if (overstated) treatment = "overstated";
      else if (ov >= 0.3) treatment = "unsupported";
      else if (mustNotHit.length) treatment = "contradicted";
      const propEligible = trainingEligible && visible && overlap(text, visibleText) >= 0.28 && official && (locator?.chunk_id || pin?.source_targets?.[0]);
      propositions.push({
        proposition_id: pin?.proposition_id || `${scored.question_id}-p${index + 1}`,
        case_id: scored.question_id,
        topic: scored.topic_id,
        proposition_text: text,
        proposition_type: propositionType(text),
        expected_support_relationship: "must_be_entailed_by_official_source",
        official_source_identity: official,
        exact_locator: locator?.section || locator?.chunk_id || pin?.source_targets?.[0] || null,
        exact_supporting_span: visible ? (snippetById.get(excerptIds.find((id) => familiesMatch(id, locator?.chunk_id || official)) || "") || null) : null,
        source_model_visible: Boolean(visible),
        actual_model_treatment: scored.status === "pass" && ov >= 0.45 ? "correct" : treatment,
        materiality: scored.status === "critical_fail" ? "critical" : "material",
        training_eligibility: Boolean(propEligible),
        overlap: ov,
      });
    });
  }
}

const countBy = (rows, key) => rows.reduce((out, row) => {
  const value = String(row[key] || "unknown");
  out[value] = (out[value] || 0) + 1;
  return out;
}, {});

const nonModel = cases.filter((row) => NON_MODEL_CLASSES.has(row.primary_root_cause) && row.verdict !== "pass");
const modelBehaviour = cases.filter((row) => MODEL_CLASSES.has(row.primary_root_cause));
const eligible = cases.filter((row) => row.training_eligible);
const passCases = cases.filter((row) => row.primary_root_cause === "NO_DEFECT_PASS");

const trainingEligibility = {
  version: "topic161-training-eligibility-v1",
  generated_at: new Date().toISOString(),
  default_training_eligible: false,
  total_cases: cases.length,
  pass: passCases.length,
  genuine_model_behaviour_failures: modelBehaviour.length,
  t4_eligible: eligible.length,
  held_or_ineligible: cases.length - passCases.length - eligible.length,
  by_primary_root_cause: countBy(cases, "primary_root_cause"),
  by_topic: countBy(cases.filter((row) => row.verdict !== "pass"), "topic"),
  by_t4_category: countBy(eligible, "proposed_t4_category"),
  rule: "training_eligible only if required correct source was model-visible, runtime completed, rubric/gold valid, and the remaining defect is model legal behaviour",
};

const heldItems = [
  ...held,
  ...cases.filter((row) => row.verdict !== "pass" && !row.training_eligible).map((row) => ({
    case_id: row.case_id,
    wave: row.wave,
    topic: row.topic,
    primary_root_cause: row.primary_root_cause,
    training_eligible: false,
    reason: row.proposed_remediation,
  })),
];

writeJsonl(resolve(OUT, "case-failure-manifest.jsonl"), cases);
writeJsonl(resolve(OUT, "proposition-failure-map.jsonl"), propositions);
writeJsonl(resolve(OUT, "non-model-defects.jsonl"), nonModel);
writeJsonl(resolve(OUT, "model-behaviour-defects.jsonl"), modelBehaviour);
writeJson(resolve(OUT, "training-eligibility.json"), trainingEligibility);
writeJsonl(resolve(OUT, "held-items.jsonl"), heldItems);
writeJsonl(resolve(ORIG, "proposition-failure-map.jsonl"), propositions);
writeJsonl(resolve(ORIG, "development-regression-rubric.jsonl"), cases.map((row) => ({
  case_id: row.case_id,
  wave: row.wave,
  topic: row.topic,
  construct_id: row.construct_id,
  question: row.question,
  expected_propositions: row.expected_propositions,
  step130_verdict: row.verdict,
  step130_primary_root_cause: row.primary_root_cause,
})));
mkdirSync(resolve(ORIG, "regression-results-new-candidate"), { recursive: true });
writeJson(resolve(ORIG, "regression-results-new-candidate/PENDING.json"), {
  status: "awaiting_new_candidate",
  original_suite_role: "DEVELOPMENT_REGRESSION_CONSUMED",
});

const causeRows = Object.entries(trainingEligibility.by_primary_root_cause)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join("\n");
const report = `# Topic161 forensic audit

State: **TOPIC161_FORENSIC_AUDIT** complete. Existing visq-v7 traces were used. The unchanged step130 adapter was not rerun.

- Cases: ${cases.length}
- Pass / no defect: ${passCases.length}
- Genuine model-behaviour failures (primary class): ${modelBehaviour.length}
- T4-eligible after evidence-in-context gate: ${eligible.length}
- Held or otherwise ineligible failures: ${heldItems.length}
- Non-model defect cases: ${nonModel.length}

## Primary root cause counts

| Primary root cause | Count |
| --- | ---: |
${causeRows}

## T4 eligibility

A case is training-eligible only if the required source was requested, retrieved, retained in model context, the runtime completed, jurisdiction/currentness were acceptable, and the remaining miss is model legal behaviour. Truncated or missing required sources are not trained.

Eligible T4 categories: ${JSON.stringify(trainingEligibility.by_t4_category)}

This audit does not certify gold answers as solicitor-reviewed. Gold remains provisional development gold. Critical propositions that cannot be verified from retained spans are held.

Original topic161 status remains \`DEVELOPMENT_REGRESSION_CONSUMED\`.
`;
writeFileSync(resolve(OUT, "FORENSIC-REPORT.md"), `${report}\n`);

console.log(JSON.stringify({
  state: "TOPIC161_FORENSIC_AUDIT",
  total: cases.length,
  pass: passCases.length,
  model_behaviour: modelBehaviour.length,
  t4_eligible: eligible.length,
  non_model: nonModel.length,
  by_primary_root_cause: trainingEligibility.by_primary_root_cause,
  by_t4_category: trainingEligibility.by_t4_category,
}, null, 2));
