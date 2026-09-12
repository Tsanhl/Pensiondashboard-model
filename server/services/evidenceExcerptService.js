const STOP = new Set("a an and are as at be before by can could for from has have how i if in is it its may member must of on or pension scheme should that the their then this to under was what when whether which who will with would".split(" "));
const words = (value) => (String(value).toLowerCase().match(/[a-z0-9]+/g) || []).filter((word) => word.length > 2 && !STOP.has(word));

// Select one contiguous, verbatim passage. This changes presentation, not the
// source text, and exposes offsets so reviewers can check surrounding conditions.
export function selectEvidenceExcerpt(text, query, maxChars = 1000) {
  text = String(text || "");
  const limit = Math.max(200, Math.floor(Number(maxChars) || 1000));
  if (text.length <= limit) return { text, start:0, end:text.length, truncated:false };
  const terms = [...new Set(words(query))];
  const queryWords = words(query);
  const pairs = new Set(queryWords.slice(1).map((word, i) => `${queryWords[i]} ${word}`));
  const starts = new Set([0]);
  // Prefer paragraph, sentence and numbered-subprovision boundaries to arbitrary
  // token positions. Do not concatenate non-adjacent clauses into a new rule.
  for (const match of text.matchAll(/\n+|[.!?]\s+|\s+(?=\(\d+\)(?:\([a-z]+\))?)/g)) starts.add(match.index + match[0].length);
  let best = { start:0, score:-1 };
  for (const start of starts) {
    const passage = text.slice(start, start + limit);
    const tokens = words(passage);
    const present = new Set(tokens);
    const joined = tokens.join(" ");
    const score = terms.filter((term) => present.has(term)).length
      + 2 * [...pairs].filter((pair) => joined.includes(pair)).length;
    if (score > best.score) best = { start, score };
  }
  let end = Math.min(text.length, best.start + limit);
  if (end < text.length) {
    const passage = text.slice(best.start,end);
    const boundaries = [...passage.matchAll(/(?:[.;]\s+|\n(?=\(\d+\)))/g)];
    const last = boundaries.at(-1);
    if (last && last.index > 0) end = best.start + last.index + (last[0].startsWith('\n') ? 0 : 1);
    else { const space = text.lastIndexOf(" ", end); if (space > best.start) end = space; }
  }
  return { text:text.slice(best.start, end), start:best.start, end, truncated:true };
}
