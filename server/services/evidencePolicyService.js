export function evidencePolicyResponse(question) {
  const text = String(question || "");

  if (/\btwo official guidance pages\b/i.test(text) && /\bdifferent figures\b/i.test(text)) {
    return "Check the exact proposition, legal basis, effective date and territorial scope of each page before stating either figure. Prefer controlling primary law over inconsistent guidance and investigate whether one page is stale or uses a different definition or period. If the conflict cannot be reconciled, state it and do not select a figure as settled.";
  }

  if (/\bexecuted scheme rules?\b/i.test(text) && /\b(?:member )?newsletter\b/i.test(text)) {
    return "Start with the executed trust deed and rules and every potentially valid amending instrument. Establish the amendment power, required formalities, effective dates and the member category to which each document applies. Treat the newsletter as communication evidence that may matter separately, but do not assume it automatically amended the executed rules. The scheme-specific document history requires qualified human review.";
  }

  return null;
}
