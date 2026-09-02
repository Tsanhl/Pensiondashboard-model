import assert from "node:assert/strict";
import test from "node:test";
import { selectEvidenceExcerpt } from "../server/services/evidenceExcerptService.js";

test("short evidence is retained exactly", () => {
  assert.deepEqual(selectEvidenceExcerpt("Exact source.", "question", 800), { text:"Exact source.", start:0, end:13, truncated:false });
});

test("a relevant later provision survives the prompt budget with traceable contiguous offsets", () => {
  const text = `(1) ${"Routine administrative records. ".repeat(30)}(4) In a possible match, check consent and provide limited administrative data. Further information is required to resolve the possible match. (5) After a match is made, check consent before returning view data. ${"Other requirements. ".repeat(20)}`;
  const result = selectEvidenceExcerpt(text, "Possible match: what happens before returning view data?", 350);
  assert.ok(result.start > 0);
  assert.match(result.text, /possible match/);
  assert.match(result.text, /limited administrative data/);
  assert.equal(result.text, text.slice(result.start, result.end));
  assert.ok(result.text.length <= 350);
});

test("no matching terms preserves the beginning rather than inventing an excerpt", () => {
  const text = "First paragraph. " + "Other content. ".repeat(100);
  const result = selectEvidenceExcerpt(text, "unmatched zebra", 300);
  assert.equal(result.start, 0);
  assert.equal(result.text, text.slice(0, result.end));
});
