export const FAILURE_OWNERS = [
  "ROUTER_SCOPE_ERROR",
  "REQUIRED_LOOKUP_NOT_REQUESTED",
  "REQUIRED_SOURCE_NOT_RETRIEVED",
  "REQUIRED_SOURCE_DROPPED_FROM_CONTEXT",
  "WRONG_JURISDICTION_SOURCE",
  "IRRELEVANT_PUBLIC_SOURCE",
  "VALIDATOR_FALSE_REJECTION",
  "MODEL_CONTRADICTED_PRESENT_EVIDENCE",
  "MODEL_INVENTED_UNSUPPORTED_OUTCOME",
  "UNSAFE_WORDING",
  "MODEL_INVALID_OUTPUT",
  "APPROPRIATE_FAIL_CLOSED",
  "INCOMPLETE_BUT_SAFE",
  "CITATION_NOT_ENTAILING_CLAIM"
];

const ROUND50_PRIMARY = {
  L05: { rootCause: "ROUTER_SCOPE_ERROR", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P1", trainingEligible: false },
  L11: { rootCause: "ROUTER_SCOPE_ERROR", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P1", trainingEligible: false },
  L12: { rootCause: "VALIDATOR_FALSE_REJECTION", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P2", trainingEligible: false },
  L13: { rootCause: "REQUIRED_PROJECTION_LOOKUP_NOT_REQUESTED", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P1", trainingEligible: false },
  L14: { rootCause: "REQUIRED_SOURCE_DROPPED_FROM_CONTEXT", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P2", trainingEligible: false },
  L15: { rootCause: "ROUTER_SCOPE_ERROR", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P1", trainingEligible: false },
  L16: { rootCause: "REQUIRED_SOURCE_DROPPED_FROM_CONTEXT", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P2", trainingEligible: false },
  L17: { rootCause: "REQUIRED_SOURCE_DROPPED_FROM_CONTEXT", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P2", trainingEligible: false },
  L18: { rootCause: "VALIDATOR_FALSE_REJECTION", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P2", trainingEligible: false },
  L19: { rootCause: "REQUIRED_SOURCE_DROPPED_FROM_CONTEXT", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P2", trainingEligible: false },
  L21: { rootCause: "REQUIRED_LOOKUP_NOT_REQUESTED", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P6", trainingEligible: false },
  L23: { rootCause: "WRONG_JURISDICTION_SOURCE", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P5", trainingEligible: false },
  L25: { rootCause: "REQUIRED_LOOKUP_NOT_REQUESTED", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P6", trainingEligible: false },
  L28: { rootCause: "MODEL_CONTRADICTED_PRESENT_EVIDENCE", owner: "MODEL_AND_VERIFIER", recommendedFixId: "T3", trainingEligible: true, note: "Eligible only after P1–P2 prove Aviva and Nest both reached the model." },
  L30: { rootCause: "MODEL_INVALID_OUTPUT", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P4", trainingEligible: false },
  L32: { rootCause: "UNSAFE_WORDING", owner: "PRODUCT_RETRIEVAL", recommendedFixId: "P3", trainingEligible: false },
  L37: { rootCause: "APPROPRIATE_FAIL_CLOSED", owner: "NONE", recommendedFixId: null, trainingEligible: false },
  L39: { rootCause: "APPROPRIATE_FAIL_CLOSED", owner: "NONE", recommendedFixId: null, trainingEligible: false },
  L40: { rootCause: "APPROPRIATE_FAIL_CLOSED", owner: "NONE", recommendedFixId: null, trainingEligible: false },
  L41: { rootCause: "MODEL_INVENTED_UNSUPPORTED_OUTCOME", owner: "MODEL_AND_VERIFIER", recommendedFixId: "T2", trainingEligible: true, forbiddenClaim: "A spouse or nominee receives benefits on the same terms as a living member", safeBehaviour: "State that the outcome is scheme-specific and requires scheme rules or human review" }
};

export function classifyFailure({ caseId, verdict, question = "", answer = "", confidence = "", query = {}, sources = [], evidenceReachedModel = false } = {}) {
  const text = `${question}\n${answer}`;
  const known = ROUND50_PRIMARY[caseId];
  if (verdict === "pass" && /insufficient_verified_evidence/i.test(confidence) && /\b(?:legal route|annual allowance|tax-free)\b/i.test(question)) {
    return { caseId, verdict, rootCause: "APPROPRIATE_FAIL_CLOSED", owner: "NONE", trainingEligible: false, recommendedFixId: null, sealedDataUsed: false };
  }
  if (/\bcontact the scammers?\b/i.test(answer)) {
    return { caseId, verdict, rootCause: "UNSAFE_WORDING", owner: "PRODUCT_RETRIEVAL", trainingEligible: false, recommendedFixId: "P3", sealedDataUsed: false };
  }
  if (confidence === "model_unavailable") {
    return { caseId, verdict, rootCause: "MODEL_INVALID_OUTPUT", owner: "PRODUCT_RETRIEVAL", trainingEligible: false, recommendedFixId: "P4", sealedDataUsed: false };
  }
  if (/\bnorthern ireland\b/i.test(answer) && /england and wales|great_britain/i.test(query.jurisdiction_scope || "") && !/\bnorthern ireland\b/i.test(question)) {
    return { caseId, verdict, rootCause: "WRONG_JURISDICTION_SOURCE", owner: "PRODUCT_RETRIEVAL", trainingEligible: false, recommendedFixId: "P5", sealedDataUsed: false };
  }
  if (known) {
    return {
      caseId,
      verdict,
      ...known,
      trainingEligible: Boolean(known.trainingEligible && evidenceReachedModel),
      sealedDataUsed: false
    };
  }
  if (verdict === "pass") {
    return { caseId, verdict, rootCause: "NONE", owner: "NONE", trainingEligible: false, recommendedFixId: null, sealedDataUsed: false };
  }
  if (verdict === "partial") {
    return { caseId, verdict, rootCause: "INCOMPLETE_BUT_SAFE", owner: "PROMPT_OR_COMPLETENESS", trainingEligible: false, recommendedFixId: null, sealedDataUsed: false };
  }
  if (!query.source_scopes?.includes("USER_PORTFOLIO") && /\b(?:my|i have|altogether|forecast|gap)\b/i.test(question)) {
    return { caseId, verdict, rootCause: "ROUTER_SCOPE_ERROR", owner: "PRODUCT_RETRIEVAL", trainingEligible: false, recommendedFixId: "P1", sealedDataUsed: false };
  }
  if ((query.structured_lookups || []).includes("projection") === false && /\b(?:gap|extra £|add £|retirement age)\b/i.test(question)) {
    return { caseId, verdict, rootCause: "REQUIRED_LOOKUP_NOT_REQUESTED", owner: "PRODUCT_RETRIEVAL", trainingEligible: false, recommendedFixId: "P1", sealedDataUsed: false };
  }
  if (sources.length && evidenceReachedModel) {
    return { caseId, verdict, rootCause: "MODEL_CONTRADICTED_PRESENT_EVIDENCE", owner: "MODEL_AND_VERIFIER", trainingEligible: true, recommendedFixId: null, sealedDataUsed: false, note: text.slice(0, 180) };
  }
  return { caseId, verdict, rootCause: "REQUIRED_SOURCE_NOT_RETRIEVED", owner: "PRODUCT_RETRIEVAL", trainingEligible: false, recommendedFixId: "P1", sealedDataUsed: false };
}
