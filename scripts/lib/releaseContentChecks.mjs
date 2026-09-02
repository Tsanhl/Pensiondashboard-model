// Checks for already-required propositions that token-overlap scoring misses.
// These remain provisional checks, not a substitute for entailment review.
export function wave1ConstructSupported(construct, answer) {
  const has = (pattern) => pattern.test(String(answer || ""));
  if (construct?.endsWith(".current_law_vs_consultation")) return has(/2021/)
    && has(/conditions for transfers|transfer.condition/i)
    && has(/consultation/i) && has(/propos|not (?:yet )?(?:law|in force|operative)/i)
    && has(/guidance/i) && has(/non.binding|not legislation|not (?:the )?law|does not (?:override|replace)|no (?:binding|legislative) force/i);
  if (construct?.endsWith(".red_flag_stop")) return has(/red flag/i)
    && has(/second condition[^.]{0,90}(?:not satisfied|not met)|(?:not satisfied|not met)[^.]{0,90}second condition/i)
    && has(/(?:consent|waiver|indemnity|accept.{0,20}risk)[^.]{0,100}(?:cannot|does not|not override)|(?:cannot|does not|must not)[^.]{0,100}(?:consent|waiver|indemnity|accept.{0,20}risk)/i);
  if (construct?.endsWith(".ni_cross_border_transfer")) return has(/Northern Ireland|\bNI\b/i)
    && has(/\bUK\b[^.]{0,100}(?:tax|QROPS)|(?:tax|QROPS)[^.]{0,100}\bUK\b/i)
    && has(/Irish|Dublin|destination.country/i) && has(/separat|distinct/i);
  if (construct?.endsWith(".tpo_vs_fos")) return has(/FOS|Financial Ombudsman Service/i)
    && has(/TPO|Pensions Ombudsman/i) && has(/advi[cs]e|suitability/i)
    && has(/administrat|delay/i) && has(/complaint|IDRP/i);
  return null;
}

export function assertsSameGbNiLegislation(answer) {
  return String(answer || "").split(/(?<=[.!?])\s+/).some((sentence) =>
    !/\?|\bnot\b|\bcannot\b|\bdoesn't\b|\bdifferent\b|\bseparate\b/i.test(sentence)
    && /same[^.]{0,60}(?:legislation|regulations?|Act|laws?)[^.]{0,60}(?:England|Great Britain|\bGB\b)|(?:England|Great Britain|\bGB\b)[^.]{0,60}(?:legislation|regulations?|Act|laws?)[^.]{0,60}(?:apply unchanged|applies unchanged)/i.test(sentence));
}
