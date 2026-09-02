// Lexical assistance for provisional diagnostic scoring, not legal sign-off.
// Resolve an abbreviated date ONLY where the question gives exactly one year
// for that day/month. Never rewrite an explicit year, including an incorrect one.
export function resolveQuestionDateEllipsis(answer, question) {
  const months = "January|February|March|April|May|June|July|August|September|October|November|December";
  const years = new Map();
  for (const match of String(question).matchAll(new RegExp(`\\b(\\d{1,2}) (${months}) (\\d{4})\\b`, "gi"))) {
    const key = `${match[1]} ${match[2].toLowerCase()}`;
    if (!years.has(key)) years.set(key, new Set());
    years.get(key).add(match[3]);
  }
  return String(answer).replace(new RegExp(`\\b(\\d{1,2}) (${months})(?! \\d{4}\\b)\\b`, "gi"), (text, day, month) => {
    const candidates = years.get(`${day} ${month.toLowerCase()}`);
    return candidates?.size === 1 ? `${text} ${[...candidates][0]}` : text;
  });
}

export function deathBeforePensionIhtCommencement(answer, question) {
  const text = resolveQuestionDateEllipsis(answer, question);
  const dateRule = /deaths? on or after 6 April 2027/i.test(text);
  const outside = /5 April 2027[^.]{0,100}(?:outside|not within|does not (?:fall|come)|not subject)/i.test(text)
    || /(?:outside|does not apply)[^.]{0,100}5 April 2027/i.test(text);
  const dateRatherThanPayment = /(?:death date|date of death)[^.]{0,120}(?:not|rather than)[^.]{0,50}(?:payment|paid)/i.test(text)
    || /(?:payment date|date of payment)[^.]{0,80}(?:does not|not affect|not control)/i.test(text)
    || /5 April 2027[^.]{0,100}(?:outside|not within|not subject)[^.]{0,100}(?:even if|even though|despite|regardless of)[^.]{0,80}(?:payment|paid)/i.test(text);
  const contradiction = /(?:^|[.!?;]\s*|\bbut\s+|\bbecause\s+)(?:the )?(?:payment date|date of payment)\s+(?:alone |still )?(?:controls|determines|governs)/i.test(text)
    || /5 April 2027[^.]{0,40}(?:is within|is subject to|falls within)/i.test(text);
  return dateRule && outside && dateRatherThanPayment && !contradiction;
}
