export function answerOutcome(confidence, validation = {}, query = {}) {
  const status = confidence === 'needs_clarification' ? 'needs_clarification'
    : confidence === 'model_unavailable' ? 'service_unavailable'
      : validation.reason === 'missing_or_stale_sources' ? 'missing_evidence'
        : validation.valid === false ? 'answer_not_verified' : 'completed';
  return {status,reason:validation.reason || null,missing_facts:query.missing_facts || []};
}
export const ANSWER_NOT_VERIFIED = 'I found relevant records or sources, but could not verify the generated explanation against them. I cannot present that draft as a completed legal answer. You can retry this question or ask for human review; you do not need to re-enter information already saved in your dashboard.';
