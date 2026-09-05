import { FAILURE_CLASSES } from "./constants.mjs";

export function classifyFailure(input = {}) {
  const text = JSON.stringify(input).toLowerCase();
  let primary = input.code && FAILURE_CLASSES.includes(input.code) ? input.code : null;
  if (!primary && /(?:frozen|pinned|protected).*(?:qualification|replacement).*(?:duplicate|cardinality|identifier)|(?:duplicate|cardinality|identifier).*(?:frozen|pinned|protected).*(?:qualification|replacement)/.test(text)) primary = "FROZEN_QUALIFICATION_INPUT_DEFECT";
  if (!primary && /timeout|timed out|econnreset|503|model not ready|temporar/.test(text)) primary = "INFRASTRUCTURE_TEMPORARY";
  if (!primary && /invalid output|malformed json|empty answer|truncat/.test(text)) primary = "MODEL_INVALID_OUTPUT";
  if (!primary && /wrong jurisdiction|northern ireland.*england|england.*northern ireland/.test(text)) primary = "WRONG_JURISDICTION";
  if (!primary && /citation.*entail|irrelevant citation|citation mismatch/.test(text)) primary = "CITATION_ENTAILMENT_DEFECT";
  if (!primary && /validator.*replac|grounding.*false reject/.test(text)) primary = "VALIDATOR_FALSE_REJECTION";
  if (!primary && /source.*dropped|context.*missing source/.test(text)) primary = "REQUIRED_SOURCE_DROPPED";
  if (!primary && /source.*missing|not retrieved|no evidence/.test(text)) primary = "REQUIRED_SOURCE_MISSING";
  if (!primary && /router|route mismatch|scope/.test(text)) primary = "ROUTER_SCOPE_ERROR";
  if (!primary && /unsupported outcome|invented outcome|death benefit/.test(text)) primary = "MODEL_UNSUPPORTED_OUTCOME";
  if (!primary && input.evidence_reached_model === true) primary = "MODEL_FACT_APPLICATION_FAILURE";
  if (!primary) primary = "EVALUATOR_DEFECT";
  const modelFailure = primary.startsWith("MODEL_") && primary !== "MODEL_INVALID_OUTPUT";
  const repairable = [
    "ROUTER_SCOPE_ERROR", "REQUIRED_LOOKUP_MISSING", "REQUIRED_SOURCE_MISSING", "REQUIRED_SOURCE_DROPPED",
    "WRONG_SOURCE_PRIORITY", "WRONG_JURISDICTION", "VALIDATOR_FALSE_REJECTION", "CITATION_FORMAT_DEFECT",
    "CITATION_ENTAILMENT_DEFECT", "DETERMINISTIC_RECAP_DEFECT", "SAFETY_TEMPLATE_DEFECT", "EVALUATOR_DEFECT",
  ].includes(primary);
  return {
    primary_cause: primary,
    model_failure: modelFailure,
    product_repair_eligible: repairable,
    training_candidate_eligible: modelFailure && input.evidence_reached_model === true,
    sealed_data_used: false,
  };
}

export function trainingProposal(failures, candidate) {
  return {
    version: "next-training-proposal-v1",
    status: "DRAFT_NOT_AUTHORISED_FOR_EXECUTION",
    candidate,
    sealed_unseen_used: false,
    failures: failures.filter((item) => item.training_candidate_eligible).map((item) => ({
      case_id: item.case_id || null,
      proposition: item.proposition || "Requires proposition-level owner and legal review",
      evidence_map: item.evidence_map || [],
      proposed_training_category: item.primary_cause,
      draft_ideal_answer: item.draft_ideal_answer || null,
      contamination_check: "REQUIRED_BEFORE_APPROVAL",
    })),
    required_owner_actions: ["Review legal proposition and evidence", "Approve any gold", "Approve a separate training run", "Create a new independent replacement qualification set if consumed"],
  };
}
