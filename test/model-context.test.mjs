import assert from "node:assert/strict";
import test from "node:test";
import { buildModelContext, expandCitationAliases } from "../server/services/modelContextService.js";
import { renderCitationMarkers } from "../server/services/citationRendererService.js";

const query = { self_contained_query:"Explain the rule", jurisdiction_scope:"GREAT_BRITAIN", response_route:"ANSWER", response_requirements:["Apply the supplied facts"] };
const source = { sourceId:"official-long-document-id_chunk_42", title:"Test Act", scope:"CURATED_PUBLIC", jurisdiction:"Great Britain", sourceRole:"legislation", snippet:"The actual source text.", oscolaCitation:"Test Act, s 1", caseTreatment:{ related:[{ direction:"incoming", relationship:"overruled", relatedDocumentId:"later-case", note:"Do not apply the earlier rule" }] } };

test("verified portfolio JSON is not excerpt-truncated for the model", () => {
  const longJson = JSON.stringify({
    accounts: Array.from({ length: 4 }, (_, index) => ({
      provider: ["Aviva", "Standard Life", "Nest", "OneLife"][index],
      charges: ["0.45%", "0.55%", "0.30%", "0.80%"][index],
      schemeName: "Scheme ".repeat(20) + index
    }))
  });
  assert.ok(longJson.length > 350);
  const structured = {
    sourceId:"structured_accounts_demo",
    title:"Verified pension account records",
    scope:"USER_PORTFOLIO",
    snippet:longJson
  };
  const { messages, sourceExcerpts } = buildModelContext(query, [structured], { snippetChars:350 });
  assert.equal(sourceExcerpts[0].truncated, false);
  assert.ok(messages[0].content.includes("0.30%"));
  assert.ok(messages[0].content.includes("0.80%"));
});

test("compact source IDs preserve all evidence, scope and later treatment", () => {
  const { messages, citationAliases } = buildModelContext(query, [source]);
  assert.equal(citationAliases.S1, source.sourceId);
  assert.match(messages[0].content, /SOURCE S1\nCitation token: \{\{cite:S1\}\}/);
  for (const value of [source.snippet, source.jurisdiction, source.sourceRole, "overruled", "Do not apply the earlier rule", "Apply the supplied facts"]) assert.ok(messages[0].content.includes(value));
  assert.ok(!messages[0].content.includes(source.sourceId));
});

test("aliases expand only in citation syntax and lists, not in prose", () => {
  const { citationAliases } = buildModelContext(query, [source]);
  const parsed = expandCitationAliases({ answer:"S1 is prose. The rule. {{cite:S1}} Another rule. [S1]", citationIds:["S1"] }, citationAliases);
  assert.equal(parsed.answer, `S1 is prose. The rule. {{cite:${source.sourceId}}} Another rule. [${source.sourceId}]`);
  assert.deepEqual(parsed.citationIds, [source.sourceId]);
  assert.equal(renderCitationMarkers({ ...parsed, sources:[source] }).valid, true);
});

test("invented or prototype-property aliases stay unknown and fail the renderer", () => {
  const { citationAliases } = buildModelContext(query, [source]);
  for (const unknown of ["S2", "constructor", "__proto__"]) {
    const parsed = expandCitationAliases({ answer:`Unsupported. {{cite:${unknown}}}`, citationIds:[unknown] }, citationAliases);
    assert.deepEqual(parsed.citationIds, [unknown]);
    assert.equal(renderCitationMarkers({ ...parsed, sources:[source] }).valid, false);
  }
});

test("the same alias maps independently per request; prior messages are unchanged", () => {
  const history = [{ role:"assistant", content:"Earlier answer {{cite:old-id}}" }];
  const first = buildModelContext(query, [source], { history });
  const second = buildModelContext(query, [{ ...source, sourceId:"other-document" }]);
  assert.equal(first.citationAliases.S1, source.sourceId);
  assert.equal(second.citationAliases.S1, "other-document");
  assert.equal(first.messages[0].content, history[0].content);
  assert.throws(() => buildModelContext(query, [source, source]), /duplicate/);
});

test("the model and verifier receive the same bounded evidence, with original source preserved", () => {
  const full = { ...source, snippet:"Unrelated introduction. ".repeat(45) + "A possible match requires further identity checks before returning view data. " + "Following provision. ".repeat(35) };
  const context = buildModelContext({ ...query, self_contained_query:"What happens for a possible match before returning view data?" }, [full], { snippetChars:300 });
  const excerpt = context.evidenceSources[0].snippet;
  assert.ok(excerpt.length <= 300);
  assert.ok(context.sourceExcerpts[0].start > 0);
  assert.ok(context.messages[0].content.includes(excerpt));
  assert.equal(full.snippet.length > 1000, true);
  assert.match(context.messages[0].content, /Correct any false premise/);
});

test("territorial commencement dates are kept separate in model evidence", () => {
  const territorialSource = {
    ...source,
    effectiveDate:"2024-03-28",
    sourceMetadata:{ northernIrelandEffectiveDate:"2024-07-05" },
  };
  const { messages } = buildModelContext(query, [territorialSource]);
  assert.match(messages[0].content, /Great Britain: 2024-03-28; Northern Ireland: 2024-07-05/);
  assert.doesNotMatch(messages[0].content, /Effective\/current-check date\(s\): 2024-03-28\n/);
});
