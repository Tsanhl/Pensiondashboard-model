// A legislative title is not evidence that a chunk contains the operative rule.
export function isAnnotationOnlyPassage(source, query = '') {
  if (/commencement|amendment history|when.*(?:inserted|substituted|repealed)|legislative history/i.test(query)) return false;
  const body = String(source.content || source.snippet || '').replace(/^#{1,6}[^\n]*\n/gm,'');
  const amendments = body.match(/\b(?:inserted|substituted|omitted|repealed|in force|specified purposes)\b/gi) || [];
  const operative = /(?:^|\n)\s*\(\d+[A-Za-z]?\)\s*(?:\([a-z]+\))?\s*[A-Z]|\b(?:must|shall|may not|is void|voidable|does not apply|requirements? (?:apply|are))\b/.test(body);
  return amendments.length >= 3 && !operative;
}
