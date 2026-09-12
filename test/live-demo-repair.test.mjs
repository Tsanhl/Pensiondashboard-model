// Projection expectations below use real-cashflows-v2 (independently checked in projection-oracle.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { processQuery } from "../server/services/queryProcessorService.js";
import { buildCanonicalFacts } from "../server/services/canonicalFactService.js";
import { lookupStructuredData } from "../server/services/structuredDataService.js";
import { selectMandatorySources } from "../server/services/evidenceContractService.js";
import { runChat,selectModelSources } from "../server/services/chatService.js";
import { deterministicDashboardAnswer } from "../server/services/deterministicAnswerService.js";
import { validateGroundedAnswer, stripUnsupportedLegalCycles, completePresentLegalFacts } from "../server/services/groundingService.js";
import { sanitizeSafetyWording, containsUnsafeScamWording, deathBenefitOutcomeUnsafe } from "../server/services/safetyWordingService.js";

const PROFILE = { providers: ["Aviva", "Standard Life", "Nest", "OneLife"], profileJurisdiction: "England and Wales" };

test("canonical fact oracle records authenticated demo totals and projection gaps", () => {
  const registry = buildCanonicalFacts("alex-morgan");
  assert.equal(registry.facts["derivedFacts.totalPots"].value, 123450);
  assert.equal(registry.facts["derivedFacts.workplacePotsTotal"].value, 115800);
  assert.equal(registry.facts["derivedFacts.personalPotsTotal"].value, 7650);
  assert.equal(registry.facts["statePension.forecastMonthly"].value, 550);
  assert.equal(registry.facts["projection.monthlyGap"].value, 816);
  assert.equal(registry.facts["projection.scenarios.extra50.remainingGap"].value, 751);
  assert.equal(registry.facts["projection.scenarios.extra100.remainingGap"].value, 686);
  assert.equal(registry.facts["projection.scenarios.extra200.remainingGap"].value, 556);
  assert.equal(registry.facts["accounts.aviva.policyNumber"].value, "AW12345678");
  assert.equal(registry.facts["documents.oneLife.status"].value, "Review");
  assert.equal(registry.facts["profile.currentEmployer"].value, "Northbridge Retail Ltd");
  assert.equal(registry.facts["derivedFacts.totalPots"].original, false);
  assert.equal(registry.facts["accounts.aviva.pot"].source_type, "AUTHENTICATED_INFO_DB");
});

test("P1 personal dashboard questions request USER_PORTFOLIO and do not require stale public law", () => {
  const total = processQuery("How much have I got in pensions altogether if you add all the pots up?", PROFILE);
  assert.ok(total.source_scopes.includes("USER_PORTFOLIO"));
  assert.equal(total.freshness_required, false);
  assert.equal(total.personal_dashboard_primary, true);
  assert.ok(total.structured_lookups.includes("account"));

  const forecast = processQuery("How much State Pension am I forecast to get?", PROFILE);
  assert.ok(forecast.source_scopes.includes("USER_PORTFOLIO"));
  assert.equal(forecast.freshness_required, false);
  assert.equal(forecast.legal_evidence_required, false);

  const extra = processQuery("If I pay an extra £50 a month, how much does that shrink the gap?", PROFILE);
  assert.ok(extra.structured_lookups.includes("projection"));
  assert.equal(extra.intent, "PROJECTION");
  assert.equal(extra.freshness_required, false);
});

test("P2 mandatory buckets keep projection when the live cap is two", () => {
  const query = processQuery("What retirement age and monthly income target are you using for me?", PROFILE);
  const structured = lookupStructuredData("alex-morgan", query);
  const crowded = [
    ...structured.sources,
    { sourceId: "public-stale", scope: "CURATED_PUBLIC", title: "Unrelated public law", snippet: "Finance Act 2004", effectiveDate: "2004-01-01" }
  ];
  const selected = selectMandatorySources(crowded, query, 2);
  assert.ok(selected.some((source) => /projection/i.test(source.sourceId) || /projection/i.test(source.title)));
  assert.ok(selected.some((source) => /accounts/i.test(source.sourceId) || /account records/i.test(source.title)));
  assert.equal(selected.some((source) => source.sourceId === "public-stale"), false);
});

test("NM-DROP: public legal context keeps distinct document families instead of three chunks from one Act", () => {
  const selected = selectMandatorySources([
    { sourceId: "official-pensions-act-2004_chunk_1", documentId: "official-pensions-act-2004", scope: "CURATED_PUBLIC", title: "Pensions Act 2004", snippet: "knowledge duty" },
    { sourceId: "official-pensions-act-2004_chunk_2", documentId: "official-pensions-act-2004", scope: "CURATED_PUBLIC", title: "Pensions Act 2004", snippet: "funding" },
    { sourceId: "official-pensions-act-2004_chunk_3", documentId: "official-pensions-act-2004", scope: "CURATED_PUBLIC", title: "Pensions Act 2004", snippet: "notifiable events" },
    { sourceId: "official-tpr-general-code-of-practice-2024_chunk_1", documentId: "official-tpr-general-code-of-practice-2024", scope: "CURATED_PUBLIC", title: "TPR General Code", snippet: "conflicts" },
    { sourceId: "official-finance-act-2004_chunk_1", documentId: "official-finance-act-2004", scope: "CURATED_PUBLIC", title: "Finance Act 2004", snippet: "annual allowance" }
  ], { intent: "PENSION_LAW", self_contained_query: "What is the trustee knowledge duty and the annual allowance?" }, 3);
  const families = selected.map((source) => String(source.documentId || source.sourceId).replace(/_chunk_\d+$/i, ""));
  assert.equal(new Set(families).size, 3);
});

test("P2 claim-level grounding keeps authenticated dashboard figures when public law is stale", () => {
  const sources = [
    { sourceId: "structured_accounts_1", scope: "USER_PORTFOLIO", snippet: "Current pot £123,450. monthly gap £804.", title: "Verified pension account records" }
  ];
  const kept = validateGroundedAnswer({
    answer: "The recorded pots total £123,450 and the monthly gap is £804.",
    citationIds: ["structured_accounts_1"],
    sources,
    intent: "HYBRID",
    legalEvidenceRequired: true,
    claimLevel: true
  });
  assert.equal(kept.valid, true);
  assert.equal(kept.legalUnresolved, true);
  const rejected = validateGroundedAnswer({
    answer: "The recorded pots total £123,450 and the monthly gap is £804.",
    citationIds: ["structured_accounts_1"],
    sources,
    intent: "HYBRID",
    legalEvidenceRequired: true
  });
  assert.equal(rejected.reason, "law_source_not_current");
});

test("P3 strips contact-the-scammer wording", () => {
  const cleaned = sanitizeSafetyWording("Stop contact. Contact the scammer through independently verified details.");
  assert.equal(containsUnsafeScamWording(cleaned), false);
  assert.match(cleaned, /contact the provider through independently verified details/i);
});

test("P5 profile residence alone does not establish scheme amendment jurisdiction", () => {
  const booklet = processQuery("What does the Northbridge workplace scheme booklet say I should do before asking to change scheme?", PROFILE);
  assert.equal(booklet.intent, "USER_DOCUMENT");
  assert.ok(booklet.source_scopes.includes("USER_DOCUMENTS"));
  assert.ok(booklet.source_scopes.includes("USER_PORTFOLIO"));
  assert.equal(booklet.jurisdiction_scope, "UNSPECIFIED");
  const specified = processQuery("What does my workplace scheme booklet say about changes in England?", PROFILE);
  assert.equal(specified.jurisdiction_scope, "GREAT_BRITAIN");
  const generic = processQuery("What does pension law say?", {});
  assert.equal(generic.jurisdiction_scope, "UNSPECIFIED");
});

test("P6 document confirmation retrieves document status including OneLife Review / Medium", () => {
  const query = processQuery("Review the document facts that need confirmation.", PROFILE);
  assert.ok(query.structured_lookups.includes("document_status"));
  const structured = lookupStructuredData("alex-morgan", query);
  const snippet = structured.sources.map((source) => source.snippet).join(" ");
  assert.match(snippet, /OneLife/i);
  assert.match(snippet, /Review/i);
  assert.match(snippet, /Medium/i);
});

test("deterministic answers cover totals, gap, extra £100 and OneLife status", () => {
  const sources = lookupStructuredData("alex-morgan", { structured_lookups: ["account", "charges", "document_status", "projection"] }).sources;
  const total = deterministicDashboardAnswer("How much have I got in pensions altogether if you add all the pots up?", { userId: "alex-morgan", sources });
  assert.match(total.answer, /123,450/);
  const gap = deterministicDashboardAnswer("Explain my £804 monthly gap and what I can review.", { userId: "alex-morgan", sources });
  assert.match(gap.answer, /816/);
  const extra = deterministicDashboardAnswer("What happens to my monthly gap if I add £100 a month?", { userId: "alex-morgan", sources });
  assert.match(extra.answer, /686/);
  assert.match(extra.answer, /1,814|1814/);
  const projected = deterministicDashboardAnswer("How much monthly income am I projected to have in retirement on the current dashboard figures?", { userId: "alex-morgan", sources });
  assert.match(projected.answer, /1,684|1684/);
  const oldPot = deterministicDashboardAnswer("What's left in my old Standard Life pension from when I worked at Harbour Logistics?", { userId: "alex-morgan", sources });
  assert.match(oldPot.answer, /32,150/);
  const buffer = deterministicDashboardAnswer("Do I have enough emergency savings, or should I stop pension contributions to build a cash buffer?", { userId: "alex-morgan", sources });
  assert.match(buffer.answer, /8,750|8750/);
  assert.match(buffer.answer, /cannot tell you whether to stop/i);
  const onelife = deterministicDashboardAnswer("Is my OneLife personal plan fully checked, and what figures are sitting on it?", { userId: "alex-morgan", sources });
  assert.match(onelife.answer, /Review/);
  assert.match(onelife.answer, /Medium/);
  assert.match(onelife.answer, /not fully checked/);
});

test("formal deterministic chat responses expose reconciled no-model telemetry", async () => {
  const prior = process.env.QUALIFICATION_ATTEMPT_TELEMETRY;
  process.env.QUALIFICATION_ATTEMPT_TELEMETRY = "true";
  const clientRequestId = `qualification-deterministic-${Date.now()}`;
  try {
    const result = await runChat({ userId:"alex-morgan",clientRequestId,message:"Explain my £804 monthly gap and what I can review?",maxModelAttempts:2 });
    assert.equal(result.response_route,"ANSWER");
    assert.equal(result.qualification_attempts.model_call_attempted,false);
    assert.equal(result.qualification_attempts.generation_attempts,0);
    assert.deepEqual(result.qualification_attempts.generation_attempt_ledger,[]);
    const replay = await runChat({ userId:"alex-morgan",clientRequestId,message:"Explain my £804 monthly gap and what I can review?",maxModelAttempts:2 });
    assert.equal(replay.idempotent,true);
    assert.equal(replay.qualification_attempts.model_call_attempted,false);
  } finally {
    if (prior == null) delete process.env.QUALIFICATION_ATTEMPT_TELEMETRY;
    else process.env.QUALIFICATION_ATTEMPT_TELEMETRY = prior;
  }
});

test("death-benefit invented survivor outcomes are flagged without training", () => {
  assert.equal(deathBenefitOutcomeUnsafe(
    "What happens to my pensions if I die before I retire?",
    "the surviving spouse or nominated beneficiary receives the benefit under the same terms as a living member"
  ), true);
  assert.equal(deathBenefitOutcomeUnsafe(
    "What happens to my pensions if I die before I retire?",
    "Death benefits are scheme-specific. Ask the provider and keep any nomination under review."
  ), false);
});

test("R51 product repairs cover redundancy, lost pension, consolidation, DB recap and scheme-change routing", () => {
  const sources = lookupStructuredData("alex-morgan", { structured_lookups: ["account", "charges", "document_status", "projection"] }).sources;
  const redundancy = deterministicDashboardAnswer("I am being made redundant. What should I check about my workplace pensions?", { userId: "alex-morgan", sources });
  assert.match(redundancy.answer, /Northbridge/);
  assert.match(redundancy.answer, /Aviva/);
  assert.match(redundancy.answer, /Nest/);
  assert.match(redundancy.answer, /personal pension/i);

  const lost = deterministicDashboardAnswer("I think I am missing a pension from a job before Harbour Logistics. How do I find a lost pension?", { userId: "alex-morgan", sources });
  assert.equal(lost, null, "Public tracing claims must use public retrieval, not account-only citations");

  const combine = deterministicDashboardAnswer("Would combining every pension I have into one pot be the right move for me?", { userId: "alex-morgan", sources });
  assert.match(combine.answer, /cannot recommend combining/i);
  assert.equal(processQuery("Should I combine all my pensions into one pot to make them easier to manage?", PROFILE).response_route, "ANSWER_AND_HANDOFF");
  const lostPara = deterministicDashboardAnswer("How do I trace a pension from an employer before Harbour Logistics that is not on the dashboard?", { userId: "alex-morgan", sources });
  assert.equal(lostPara, null);
  assert.ok(processQuery("How do I trace a lost pension?", PROFILE).source_scopes.includes("CURATED_PUBLIC"));
  const schemePara = processQuery("What official legal process applies if my workplace pension scheme is changed?", PROFILE);
  assert.equal(schemePara.personal_dashboard_primary, false);
  assert.equal(schemePara.legal_evidence_required, true);

  const db = deterministicDashboardAnswer("Do I have a defined benefit pension on this dashboard?", { userId: "alex-morgan", sources });
  assert.equal(db, null, "A generic workplace label cannot establish every scheme is DC");

  const schemeChange = processQuery("Check the legal route for changing my workplace pension scheme.", PROFILE);
  assert.equal(schemeChange.legal_evidence_required, true);
  assert.equal(schemeChange.personal_dashboard_primary, false);
  assert.match(schemeChange.retrieval_query, /Consultation by Employers/);
  assert.doesNotMatch(schemeChange.retrieval_query, /Northern Ireland/);
  assert.doesNotMatch(schemeChange.retrieval_query, /McCloud/);
});

test("R51 scheme-change grounding rejects McCloud substitution and strips unsupported re-enrol cycles", () => {
  const sources = [
    { sourceId: "structured_accounts_1", scope: "USER_PORTFOLIO", snippet: "Aviva pot £68,450", title: "Verified pension account records" },
    { sourceId: "mccloud", scope: "CURATED_PUBLIC", effectiveDate: "2026-01-01", title: "Changes in your annual allowance following the public service pensions remedy", oscolaCitation: "HM Revenue & Customs, 'Changes in your annual allowance following the public service pensions remedy'", snippet: "McCloud remedy annual allowance" }
  ];
  const rejected = validateGroundedAnswer({
    answer: "The verified figure is £68,450 (HM Revenue & Customs, 'Changes in your annual allowance following the public service pensions remedy').",
    citationIds: ["structured_accounts_1", "mccloud"],
    sources,
    intent: "HYBRID",
    legalEvidenceRequired: true,
    userSuppliedText: "Check the legal route for changing my workplace pension scheme.",
    claimLevel: true
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.reason, "irrelevant_public_source");
  assert.match(
    stripUnsupportedLegalCycles(
      "Automatic enrolment requires a qualifying scheme. The employer may re-enrol the worker once in any 12-month period.",
      "Automatic enrolment qualifying workplace pension scheme. A worker may opt out."
    ),
    /Automatic enrolment requires a qualifying scheme/i
  );
  assert.doesNotMatch(
    stripUnsupportedLegalCycles(
      "Automatic enrolment requires a qualifying scheme. The employer may re-enrol the worker once in any 12-month period.",
      "Automatic enrolment qualifying workplace pension scheme. A worker may opt out."
    ),
    /12-month/
  );
});

test("Live-50 L19/L23/L26/L38/L43 product repairs stay on dashboard facts and advice boundaries", () => {
  const sources = lookupStructuredData("alex-morgan", { structured_lookups: ["account", "charges", "document_status", "projection", "investment_profile"] }).sources;
  const contribution = processQuery("Use my dashboard and explain what I should check before changing pension contributions. Include the current contribution scenarios.", PROFILE);
  assert.equal(contribution.intent, "PROJECTION");
  assert.equal(contribution.legal_evidence_required, false);
  assert.equal(contribution.personal_dashboard_primary, true);
  assert.ok(contribution.structured_lookups.includes("projection"));
  const contributionAnswer = deterministicDashboardAnswer("Use my dashboard and explain what I should check before changing pension contributions. Include the current contribution scenarios.", { userId: "alex-morgan", sources });
  assert.match(contributionAnswer.answer, /£50|50/);
  assert.match(contributionAnswer.answer, /751/);
  assert.match(contributionAnswer.answer, /100/);
  assert.match(contributionAnswer.answer, /200/);
  assert.match(contributionAnswer.answer, /not a recommendation/i);

  const booklet = deterministicDashboardAnswer("What does the Northbridge workplace scheme booklet say I should do before asking to change scheme?", { userId: "alex-morgan", sources });
  assert.match(booklet.answer, /booklet/i);
  assert.match(booklet.answer, /read the booklet before any scheme change request/i);
  const bookletSnippet = sources.map((source) => source.snippet).join(" ");
  assert.match(bookletSnippet, /Read the booklet before any scheme change request/i);

  const left = deterministicDashboardAnswer("I left Harbour Logistics. What happens to that workplace pension now?", { userId: "alex-morgan", sources });
  assert.match(left.answer, /Standard Life/);
  assert.match(left.answer, /Deferred/i);
  assert.doesNotMatch(left.answer, /transferred to the Northbridge/i);

  const optOut = completePresentLegalFacts(
    "What is automatic enrolment and can I opt out of my workplace pension?",
    "Automatic enrolment is the statutory duty to offer a qualifying pension scheme.",
    [{ sourceId: "official-ae", title: "Automatic Enrolment Regulations 2010", snippet: "A worker may opt out.", oscolaCitation: "SI 2010/772" }]
  );
  assert.match(optOut.answer, /opt out/i);
  assert.deepEqual(optOut.addedCitationIds, ["official-ae"]);
  assert.doesNotMatch(optOut.answer, /12-month/);

  const fund = processQuery("Which fund should I switch to to get the best returns?", PROFILE);
  assert.equal(fund.response_route, "ANSWER_AND_HANDOFF");
  assert.equal(fund.handoff_reason, "regulated_personalised_advice");
  const fundAnswer = deterministicDashboardAnswer("Which fund should I switch to to get the best returns?", { userId: "alex-morgan", sources });
  assert.match(fundAnswer.answer, /cannot (?:give personalised investment advice|recommend)/i);
  assert.match(fundAnswer.answer, /Balanced/);
  assert.match(fundAnswer.answer, /Cautious/);
  assert.doesNotMatch(fundAnswer.answer, /switch to Growth/i);
  assert.doesNotMatch(fundAnswer.answer, /I recommend the/i);
});

test("security fallback still puts official safety evidence ahead of account metadata", () => {
  const selected = selectModelSources([
    { sourceId: "account", scope: "USER_PORTFOLIO" },
    { sourceId: "official-tax", scope: "CURATED_PUBLIC", title: "Overseas transfer tax", snippet: "Information must be supplied within 60 days." },
    { sourceId: "official-scam", scope: "CURATED_PUBLIC", title: "Avoid pension scams", snippet: "Do not be pressured into transferring; verify the firm independently." }
  ], { response_route: "SECURITY_FALLBACK" }, 2);
  assert.deepEqual(selected.map((source) => source.sourceId), ["official-scam"]);
});

test("truncated citation-loop JSON recovers a complete equality answer without inventing an ending", async () => {
  const { recoverTruncatedJsonAnswer } = await import("../server/services/localModelService.js");
  const loop = Array.from({ length: 20 }, () => "{{cite:S2}} {{cite:S3}} {{cite:S1}}").join(" ");
  const raw = `{"answer":"Same-sex status alone is not a lawful basis for a smaller survivor pension. {{cite:S2}} {{cite:S3}} {{cite:S1}} The Equality Act 2010 and the 2023 occupational-pension amendment establish that sexual orientation is not a permitted occupational-pension benefit-difference ground. ${loop} {{cite`;
  const recovered = recoverTruncatedJsonAnswer(raw);
  assert.ok(recovered);
  assert.match(recovered.answer, /same-sex status alone is not a lawful basis/i);
  assert.match(recovered.answer, /Equality Act 2010/);
  assert.doesNotMatch(recovered.answer, /\{\{cite:S2\}\} \{\{cite:S3\}\} \{\{cite:S1\}\} \{\{cite:S2\}\}/);
  assert.equal(recoverTruncatedJsonAnswer('{"answer":"unfinished'), null);
});

test("official structured tax facts keep a visible HMRC citation instead of being stripped as portfolio metadata", async () => {
  const { renderCitationMarkers } = await import("../server/services/citationRendererService.js");
  const { validateGroundedAnswer } = await import("../server/services/groundingService.js");
  const sources = [{
    sourceId: "structured_public_standard-annual-allowance-2026-27",
    title: "HMRC dated fact: Standard annual allowance",
    oscolaCitation: "HM Revenue & Customs, 'Pension schemes rates' (2026/27)",
    scope: "CURATED_PUBLIC",
    effectiveDate: "2026-04-06",
    sourceType: "official_structured_tax_fact",
    snippet: "The standard annual allowance is £60,000 for 2026/27."
  }];
  const rendered = renderCitationMarkers({
    answer: "The standard annual allowance for the 2026/27 tax year is £60,000. {{cite:structured_public_standard-annual-allowance-2026-27}}",
    citationIds: ["structured_public_standard-annual-allowance-2026-27"],
    sources
  });
  assert.equal(rendered.valid, true);
  assert.match(rendered.answer, /HM Revenue & Customs/);
  const validation = validateGroundedAnswer({
    answer: rendered.answer,
    citationIds: rendered.citationIds,
    sources,
    intent: "PENSION_LAW",
    legalEvidenceRequired: true,
    userSuppliedText: "What is the standard annual allowance for the 2026/27 tax year?"
  });
  assert.equal(validation.valid, true);
});

test("NM-FETCH: local model transport failures are MODEL_UNAVAILABLE so one authorised retry can run", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    const { generateLocalAnswer } = await import("../server/services/localModelService.js");
    await assert.rejects(
      () => generateLocalAnswer({ system: "policy", messages: [{ role: "user", content: "query" }] }),
      (error) => error.code === "MODEL_UNAVAILABLE"
    );
  } finally {
    globalThis.fetch = previous;
  }
});
