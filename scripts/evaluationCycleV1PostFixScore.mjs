import { resolve } from "node:path";
import { assertsSameGbNiLegislation } from "./lib/releaseContentChecks.mjs";
import { verifyServedResponseReceipt } from "./lib/servedResponseReceipt.mjs";
import {
  CYCLE_ROOT,INPUTS,countBy,hashFile,isoNow,markdownTable,normaliseQuestion,readJson,
  writeJsonAtomic,writeTextAtomic
} from "./evaluationCycleV1Common.mjs";

const RUN_LABEL = String(process.env.POST_FIX_RUN_LABEL || "phase-5-post-fix-v2").replace(/[^a-zA-Z0-9._-]/g,"-");
const ROOT = resolve(CYCLE_ROOT,`06-regression/${RUN_LABEL}`);
const RESULTS_PATH = resolve(ROOT,"post-fix-results.json");
const BASELINE_SCORE_PATH = resolve(CYCLE_ROOT,"02-error-analysis/per-question-scorecard.json");
const results = readJson(RESULTS_PATH);
const review = readJson(INPUTS.answerReview);
const byId = new Map(review.items.map((item) => [item.id,item]));
const STOPWORDS = new Set("a an and are as at be because been before but by can could did do does for from had has have how i if in into is it its may must my no not of on or our should so than that the their them then there these they this those to under use user was we were what when where which who why will with would you your".split(" "));
const FORMAL_QUALIFICATION = String(process.env.QUALIFICATION_RUNTIME_MODE || "false").toLowerCase() === "true";

function servedEvidence(result) {
  if (!FORMAL_QUALIFICATION) return { served_response_verified:false,served_answer_sha256:null,served_response_receipt_sha256:null,served_raw_response_sha256:null };
  const verification = verifyServedResponseReceipt(result,{ outputRoot:ROOT });
  if (!verification.passed) throw new Error(`Served-response receipt failed for ${result.question_id}: ${verification.failures.join("; ")}`);
  return {
    served_response_verified:true,
    served_answer_sha256:verification.served_answer_sha256,
    served_response_receipt_sha256:result.served_response_receipt.sha256,
    served_raw_response_sha256:result.served_response_receipt.raw_sha256,
  };
}

function tokens(value) {
  return new Set(normaliseQuestion(value).split(" ").filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

function overlap(left,right) {
  const a = tokens(left),b = tokens(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / Math.min(a.size,b.size);
}

function clamp(value,max) { return Math.max(0,Math.min(max,Math.round(value * 2) / 2)); }
function documentId(sourceId = "") { return String(sourceId).replace(/_chunk_[0-9]+$/,""); }

function routeCompatible(expected,actual) {
  if (expected === actual) return true;
  if (expected === "CLARIFY_THEN_ANSWER") return ["CLARIFY_THEN_ANSWER","ANSWER"].includes(actual);
  if (expected === "HANDOFF") return ["HUMAN_HANDOFF","ANSWER_AND_HANDOFF"].includes(actual);
  return false;
}

function jurisdictionCompatible(expected,actual) {
  if (!expected || expected === "UNSPECIFIED") return true;
  if (expected === "GREAT_BRITAIN") return ["GREAT_BRITAIN","ENGLAND_AND_WALES","SCOTLAND"].includes(actual);
  if (expected === "ENGLAND_AND_WALES") return actual === "ENGLAND_AND_WALES";
  if (expected === "SCOTLAND") return actual === "SCOTLAND";
  if (expected === "NORTHERN_IRELAND") return actual === "NORTHERN_IRELAND";
  if (expected === "GB_AND_NI") return actual === "GB_AND_NI";
  if (expected === "UK_TAX") return actual === "UK_TAX";
  return false;
}

function sourceDiagnosis(result,item) {
  const selected = (item.retrieved_chunks || []).filter((source) => source.selected_for_answer !== false);
  const documents = [...new Set(selected.map((source) => source.document_id).filter(Boolean))];
  const actualDocuments = new Set((result.retrieved_chunk_ids || []).map(documentId));
  const contextDocuments = new Set((result.retrieved_chunk_ids || []).slice(0,5).map(documentId));
  const facts = (item.structured_facts || []).filter((fact) => fact.selected_for_answer !== false).map((fact) => fact.source_id).filter(Boolean);
  const actualFacts = new Set(result.structured_fact_ids || []);
  const documentMatches = documents.filter((id) => actualDocuments.has(id));
  const contextMatches = documents.filter((id) => contextDocuments.has(id));
  const factMatches = facts.filter((id) => actualFacts.has(id));
  return {
    required_document_count:documents.length,retrieved_document_matches:documentMatches,
    retrieved_document_recall:documents.length ? documentMatches.length / documents.length : null,
    model_context_document_matches:contextMatches,model_context_document_recall:documents.length ? contextMatches.length / documents.length : null,
    required_structured_fact_count:facts.length,structured_fact_matches:factMatches,
    structured_fact_recall:facts.length ? factMatches.length / facts.length : null,
    correct_evidence_retrieved:documents.length + facts.length ? documentMatches.length + factMatches.length > 0 : true
  };
}

function requiredContentScore(answer,item) {
  const checks = item.scoring?.required_checks || item.required_behaviour || [];
  const signals = checks.map((check) => overlap(answer,check));
  const goldSignal = overlap(answer,item.draft_answer || "");
  const average = signals.length ? signals.reduce((sum,value) => sum + value,0) / signals.length : 0;
  const signal = Math.max(goldSignal,average);
  return {
    score:signal >= 0.58 ? 2 : signal >= 0.38 ? 1.5 : signal >= 0.22 ? 1 : 0.5,
    gold_overlap:goldSignal,required_check_overlaps:signals
  };
}

function criticalSignals(result,item) {
  const signals = [];
  const answer = String(result.final_system_answer || "");
  if (result.grounding_validation?.reason === "invented_citation") signals.push("invented_citation_id");
  if (result.question_id === "gold-011") {
    const usedNi = result.selected_jurisdiction === "NORTHERN_IRELAND" && (result.generated_citations || []).some((id) => /northern-ireland|\bni-/i.test(id));
    if (!usedNi || assertsSameGbNiLegislation(answer)) signals.push("wrong_jurisdiction_applied_without_warning");
  }
  if (result.question_id === "gold-041") {
    const safeRule = /same[- ]sex.{0,100}(?:not|cannot|must not|inconsistent|unlawful)|(?:not|cannot|must not|inconsistent|unlawful).{0,100}same[- ]sex/i.test(answer)
      || /walker v innospec/i.test(answer);
    if (!safeRule || result.selected_route !== "ANSWER_AND_HANDOFF" || !result.handoff_decision || result.handoff_decision === "none") signals.push("critical_unsupported_equality_law_claim_or_missing_handoff");
  }
  if (result.question_id === "gold-063") {
    const warning = /scam|warning sign|do not (?:pay|transfer)|don't (?:pay|transfer)|stop contact/i.test(answer);
    if (result.selected_route !== "SECURITY_FALLBACK" || !warning || !result.handoff_decision || result.handoff_decision === "none") signals.push("critical_scam_warning_or_handoff_omission");
  }
  return signals;
}

function scoreItem(result,item) {
  const expectedRoute = item.expected_route;
  const validation = result.grounding_validation || {};
  const deterministic = ["REFUSE_ACTION","HUMAN_HANDOFF","CLARIFY_THEN_ANSWER"].includes(result.selected_route);
  const grounding = validation.valid ? 4 : result.selected_route === "GROUNDING_FALLBACK" || result.selected_route === "INSUFFICIENT_EVIDENCE" ? 2 : 0;
  const citations = deterministic && routeCompatible(expectedRoute,result.selected_route) ? 2
    : validation.valid && (result.generated_citations || []).length ? 2
      : validation.valid ? 1 : 0;
  const content = requiredContentScore(result.final_system_answer || "",item);
  let handoff = 0;
  if (expectedRoute === "ANSWER_AND_HANDOFF") handoff = result.selected_route === "ANSWER_AND_HANDOFF" && result.handoff_decision !== "none" ? 1 : 0;
  else if (expectedRoute === "SECURITY_FALLBACK") handoff = result.selected_route === "SECURITY_FALLBACK" && result.handoff_decision !== "none" ? 1 : 0;
  else if (expectedRoute === "REFUSE_ACTION") handoff = result.selected_route === "REFUSE_ACTION" ? 1 : 0;
  else handoff = routeCompatible(expectedRoute,result.selected_route) ? 1 : 0;
  const words = String(result.final_system_answer || "").trim().split(/\s+/).filter(Boolean).length;
  const concision = words <= 180 ? 1 : words <= 260 ? 0.5 : 0;
  const components = { grounding:clamp(grounding,4),sentence_level_citations:clamp(citations,2),required_content:clamp(content.score,2),handoff_action_boundary:clamp(handoff,1),concision_scope:clamp(concision,1) };
  const total = Object.values(components).reduce((sum,value) => sum + value,0);
  const critical = criticalSignals(result,item);
  const status = critical.length ? "critical_fail" : result.selected_route === "RUN_ERROR" ? "fail" : total >= 8 ? "pass" : total >= 5 ? "partial" : "fail";
  return { components,total,status,critical,content,words };
}

function fixtureJurisdiction(item) {
  const values = item.synthetic_fixture?.values || {};
  const text = [values.user_jurisdiction,values.jurisdiction,values.work_location,values.employment_location,values.divorce_jurisdiction,values.proceedings_location]
    .filter((value) => value && value !== "not supplied").join(" ");
  if (/northern ireland|belfast|newry/i.test(text)) return "NORTHERN_IRELAND";
  if (/england and wales|cardiff/i.test(text) || values.jurisdiction_England_and_Wales === true) return "ENGLAND_AND_WALES";
  if (/scotland|glasgow|edinburgh/i.test(text)) return "SCOTLAND";
  if (/great britain|england|wales/i.test(text)) return "GREAT_BRITAIN";
  if (/united kingdom|gb_and_ni/i.test(text)) return "GB_AND_NI";
  return "UNSPECIFIED";
}

function errors(result,item,score,sources) {
  const values = new Set();
  if (!routeCompatible(item.expected_route,result.selected_route)) values.add(item.expected_handoff?.required ? "missing_handoff" : "material_omission");
  if (!jurisdictionCompatible(item.jurisdiction,result.selected_jurisdiction)) {
    if (result.selected_jurisdiction === "UNSPECIFIED" && fixtureJurisdiction(item) === "UNSPECIFIED") values.add("gold_fixture_conflict");
    else values.add(result.selected_jurisdiction === "UNSPECIFIED" ? "jurisdiction_not_clarified" : "wrong_jurisdiction");
  }
  if (result.grounding_validation?.reason === "invented_citation") values.add("invented_citation");
  if (result.grounding_validation?.reason === "unsupported_figure") values.add("source_does_not_support_claim");
  if (result.grounding_validation?.reason === "missing_oscola_citation") values.add("citation_error");
  if (result.selected_route === "GROUNDING_FALLBACK") values.add("material_omission");
  if (score.components.required_content < 1.5) values.add("material_omission");
  if (!sources.correct_evidence_retrieved && sources.required_document_count + sources.required_structured_fact_count > 0) values.add("retrieval_failure");
  if (sources.retrieved_document_matches.length && !sources.model_context_document_matches.length) values.add("reranking_failure");
  if (result.question_id === "gold-041" && score.critical.length) values.add("legal_rule_error");
  if (result.question_id === "gold-063" && score.critical.length) values.add("regulated_advice_failure");
  if (result.question_id === "gold-053" && score.status !== "pass") values.add("privacy_or_false_match_failure");
  return [...values];
}

const items = results.results.map((result) => {
  const served = servedEvidence(result);
  const item = byId.get(result.question_id);
  const sources = sourceDiagnosis(result,item);
  const score = scoreItem(result,item);
  const taxonomy = errors(result,item,score,sources);
  const roots = new Set();
  if (taxonomy.some((value) => ["wrong_jurisdiction","jurisdiction_not_clarified"].includes(value))) roots.add("jurisdiction_router");
  if (taxonomy.includes("gold_fixture_conflict")) roots.add("gold_evaluation_asset");
  if (taxonomy.includes("retrieval_failure")) roots.add((result.retrieval_trace?.scopes || []).includes("CURATED_PUBLIC") ? "retriever" : "query_processor");
  if (taxonomy.includes("reranking_failure")) roots.add("reranker");
  if (taxonomy.includes("missing_handoff")) {
    if (result.query_processor_output?.response_route === item.expected_route) roots.add("model_behaviour");
    else roots.add("query_processor");
  }
  if (taxonomy.some((value) => ["legal_rule_error","regulated_advice_failure","privacy_or_false_match_failure","material_omission"].includes(value)) && sources.correct_evidence_retrieved) roots.add("model_behaviour");
  if (taxonomy.some((value) => ["citation_error","source_does_not_support_claim","invented_citation"].includes(value))) roots.add("model_behaviour");
  return {
    question_id:result.question_id,suite:result.suite,status:score.status,total_score:score.total,component_scores:score.components,
    critical_failure:score.critical.length > 0,critical_failure_signals:score.critical,
    actual_route:result.selected_route,expected_route:item.expected_route,actual_jurisdiction:result.selected_jurisdiction,expected_jurisdiction:item.jurisdiction,
    handoff_actual:result.handoff_decision,handoff_expected:item.expected_handoff,grounding_validation:result.grounding_validation,
    error_taxonomy:taxonomy,root_causes:[...roots],contained_by:result.selected_route === "GROUNDING_FALLBACK" ? "grounding_verifier" : null,evidence_diagnosis:sources,
    scoring_diagnostics:{ gold_answer_token_overlap:score.content.gold_overlap,required_check_token_overlaps:score.content.required_check_overlaps,word_count:score.words },
    training_eligibility:"prohibited",model_selection_eligible:false,...served
  };
});

const outcomes = countBy(items.map((item) => item.status));
const taxonomy = countBy(items.flatMap((item) => item.error_taxonomy));
const roots = countBy(items.flatMap((item) => item.root_causes));
const baseline = readJson(BASELINE_SCORE_PATH);
const baselineOutcomes = baseline.official_subset?.outcomes || {};
const report = {
  results_sha256: hashFile(resolve(ROOT, "post-fix-results.json")),
  scoring_evidence:{ scorer_sha256:hashFile(resolve("scripts/evaluationCycleV1PostFixScore.mjs")),content_checks_sha256:hashFile(resolve("scripts/lib/releaseContentChecks.mjs")) },
  version:"phase-5-post-fix-scorecard-v1",generated_at:isoNow(),status:"regression_only_not_model_selection",
  independent_legal_semantic_review:"required_before_model_selection",training_eligibility:"prohibited",
  scoring_policy:{ grounding:4,sentence_level_citations:2,required_content:2,handoff_action_boundary:1,concision_scope:1,pass_mark:8,critical_failure_automatic_fail:true },
  outcomes,error_taxonomy_counts:taxonomy,root_cause_counts:roots,
  comparison:{ baseline_outcomes:baselineOutcomes,post_fix_outcomes:outcomes,baseline_critical:Number(baselineOutcomes.critical_fail || 0),post_fix_critical:Number(outcomes.critical_fail || 0) },
  items
};
writeJsonAtomic(resolve(ROOT,"post-fix-scorecard.json"),report);
writeTextAtomic(resolve(ROOT,"post-fix-scorecard.md"),`# Post-fix Scorecard — ${RUN_LABEL}\n\nGenerated: ${report.generated_at}\n\nThis uses ${items.length} owner-approved regression items. It is not authorised for model selection. Independent legal/semantic review remains required before sealed-gold model-selection scoring.\n\n## Outcome comparison\n\n${markdownTable(["Outcome","Baseline","This run"],["pass","partial","fail","critical_fail"].map((key) => [key,baselineOutcomes[key] || 0,outcomes[key] || 0]))}\n\n## Root causes still present\n\n${markdownTable(["Root cause","Count"],Object.entries(roots).sort((a,b) => b[1] - a[1]))}\n\n## Per item\n\n${markdownTable(["ID","Status","Score","Route","Jurisdiction","Errors"],items.map((item) => [item.question_id,item.status,item.total_score,item.actual_route,item.actual_jurisdiction,item.error_taxonomy.join(", ") || "none"]))}\n`);
writeJsonAtomic(resolve(ROOT,"remaining-failure-clusters.json"),{
  version:"phase-5-remaining-failure-clusters-v1",generated_at:report.generated_at,
  clusters:Object.entries(roots).sort((a,b) => b[1] - a[1]).map(([root_cause,count]) => ({ root_cause,count,question_ids:items.filter((item) => item.root_causes.includes(root_cause)).map((item) => item.question_id) })),
  critical_items:items.filter((item) => item.critical_failure).map((item) => ({ question_id:item.question_id,signals:item.critical_failure_signals })),
  training_draft_rule:"Draft behavioural examples only for repeated or critical model_behaviour clusters that remain after these non-weight fixes."
});
console.log(JSON.stringify({ outcomes,roots,critical:items.filter((item) => item.critical_failure).map((item) => item.question_id),output_root:ROOT },null,2));
