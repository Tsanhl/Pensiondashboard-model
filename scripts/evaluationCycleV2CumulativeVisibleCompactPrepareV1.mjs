import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  auditTrainingPartitionIsolation,
  auditTrainingRows,
  contentHash,
} from "./lib/trainingEvidenceIntegrity.mjs";

const WORKSPACE = resolve(".");
const UPSTREAM_ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_UPSTREAM_ROOT ||
    "training/evaluation-cycle-v2/23-cumulative-visible-qualification-v8-final-full-20260901",
);
const ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_QUALIFICATION_ROOT ||
    "training/evaluation-cycle-v2/24-cumulative-visible-qualification-v8-final-compact-20260901",
);
const CANDIDATE_ROOT = resolve(ROOT, "rendered-candidate");
const CONFIG_PATH = resolve("training/cumulative_visible_mlx_config_v1.yaml");
const RUNNER_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleTrainMlxV1.mjs",
);
const TRAINING_WRAPPER_PATH = resolve("training/train_mlx.sh");
const CHECKPOINT_SELECTOR_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleSelectCheckpointV1.mjs",
);
const COMPACT_RENDERER_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleCompactPrepareV1.mjs",
);
const FULL_PREPARE_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisiblePrepareV1.mjs",
);
const MEMORY_SMOKE_RUNNER_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleSmokeMlxV1.mjs",
);
const REPAIRED_V8_ROOT = resolve(
  "training/evaluation-cycle-v2/22-training-data-double-check-v8-final-20260901",
);

const paths = {
  upstreamItems: resolve(UPSTREAM_ROOT, "cumulative-visible-item-register.json"),
  upstreamSources: resolve(UPSTREAM_ROOT, "cumulative-visible-source-register.json"),
  upstreamAllocation: resolve(UPSTREAM_ROOT, "global-visible-allocation-draft.json"),
  upstreamContamination: resolve(UPSTREAM_ROOT, "contamination-and-echo-preflight.json"),
  upstreamProvenance: resolve(UPSTREAM_ROOT, "clean-checkpoint-provenance.json"),
  upstreamOwner: resolve(UPSTREAM_ROOT, "owner-development-authorisation.json"),
  wave2SpanRecommendations: resolve(
    UPSTREAM_ROOT,
    "independent-agent-audits/wave-2-compact-substantive-retention-recommendations.v8-root23-provisional-v1.json",
  ),
  wave3SpanRecommendations: resolve(
    UPSTREAM_ROOT,
    "independent-agent-audits/wave-3-compact-substantive-retention-recommendations.v8-provisional-v3.json",
  ),
  independentVisibleAudit: resolve(
    REPAIRED_V8_ROOT,
    "independent-agent-audits/independent-agent-visible-technical-legal-semantic-audit-v1.json",
  ),
  independentVisibleReport: resolve(
    REPAIRED_V8_ROOT,
    "independent-agent-audits/INDEPENDENT-AGENT-VISIBLE-TECHNICAL-LEGAL-SEMANTIC-AUDIT-v1.md",
  ),
  repairedV8Pack: resolve(REPAIRED_V8_ROOT, "repaired-training-items-draft.json"),
  repairedV8ApplicationAudit: resolve(
    REPAIRED_V8_ROOT,
    "consolidated-v8-repair-application-audit.json",
  ),
  topicCoverageFeasibility: resolve(
    UPSTREAM_ROOT,
    "independent-agent-audits/global-visible-topic-coverage-feasibility.json",
  ),
  config: CONFIG_PATH,
  runner: RUNNER_PATH,
  trainingWrapper: TRAINING_WRAPPER_PATH,
  checkpointSelector: CHECKPOINT_SELECTOR_PATH,
  compactRenderer: COMPACT_RENDERER_PATH,
  fullPrepare: FULL_PREPARE_PATH,
  memorySmokeRunner: MEMORY_SMOKE_RUNNER_PATH,
};
for (const path of Object.values(paths)) {
  if (!existsSync(path)) throw new Error(`Compact renderer prerequisite missing: ${path}`);
}
if (existsSync(ROOT) && statSync(ROOT).isFile()) {
  throw new Error(`Compact qualification root is a file: ${ROOT}`);
}
if (existsSync(ROOT) && readdirSync(ROOT).length) {
  throw new Error(`Versioned compact qualification root is not empty: ${ROOT}`);
}

const readBytes = (path) => readFileSync(path);
const readJson = (path) => JSON.parse(readFileSync(path));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const sha = (path) => contentHash(readBytes(path));
const sameSet = (left, right) => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
const sameOrderedUniqueValues = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === new Set(left).size &&
  right.length === new Set(right).size &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const citationIds = (value) => [
  ...new Set(
    [...String(value || "").matchAll(/\{\{cite:([^}]+)\}\}/g)].map(
      (match) => match[1],
    ),
  ),
];
const stripMarkers = (value) =>
  String(value || "")
    .replace(/\s*\{\{cite:[^}]+\}\}/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
const normalise = (value) =>
  stripMarkers(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const upstreamItems = readJson(paths.upstreamItems);
const upstreamSources = readJson(paths.upstreamSources);
const upstreamAllocation = readJson(paths.upstreamAllocation);
const upstreamContamination = readJson(paths.upstreamContamination);
const upstreamProvenance = readJson(paths.upstreamProvenance);
const upstreamOwner = readJson(paths.upstreamOwner);
const wave2SpanRecommendations = readJson(paths.wave2SpanRecommendations);
const wave3SpanRecommendations = readJson(paths.wave3SpanRecommendations);
const topicCoverageFeasibility = readJson(paths.topicCoverageFeasibility);
const independentVisibleAudit = readJson(paths.independentVisibleAudit);

const upstreamChecks = {
  exact_visible_counts:
    upstreamItems.counts?.total === 94 &&
    upstreamItems.counts?.v1 === 42 &&
    upstreamItems.counts?.wave_2 === 33 &&
    upstreamItems.counts?.wave_3 === 19 &&
    upstreamItems.items?.length === 94,
  upstream_full_source_identity_clean:
    upstreamSources.item_register_sha256 === sha(paths.upstreamItems) &&
    upstreamSources.identity_conflicts?.length === 0,
  upstream_global_allocation_passed:
    upstreamAllocation.item_register_sha256 === sha(paths.upstreamItems) &&
    upstreamAllocation.source_register_sha256 === sha(paths.upstreamSources) &&
    upstreamAllocation.isolation?.passed === true &&
    upstreamAllocation.isolation?.canonical_url_overlap?.length === 0 &&
    upstreamAllocation.train?.count + upstreamAllocation.validation?.count === 94,
  upstream_target_echo_and_contract_passed:
    upstreamContamination.item_register_sha256 === sha(paths.upstreamItems) &&
    upstreamContamination.allocation_sha256 === sha(paths.upstreamAllocation) &&
    upstreamContamination.passed === true,
  clean_base_provenance_passed:
    upstreamProvenance.passed === true &&
    upstreamProvenance.training_started === false &&
    upstreamProvenance.clean_start_policy?.resume_adapter === null,
  owner_development_authority_is_not_independent_review:
    upstreamOwner.owner_authorisation_recorded === true &&
    upstreamOwner.independent_legal_review === false &&
    upstreamOwner.release_authorised === false &&
    upstreamOwner.unseen_accessed === false,
  sealed_unseen_excluded:
    upstreamItems.unseen_accessed === false &&
    upstreamAllocation.unseen_accessed === false &&
    upstreamContamination.unseen_accessed === false,
  maximum_topic_coverage_proved_under_frozen_constraints:
    topicCoverageFeasibility.passed === true &&
    topicCoverageFeasibility.training_authorised === false &&
    topicCoverageFeasibility.release_authorised === false &&
    topicCoverageFeasibility.independent_legal_review === false &&
    topicCoverageFeasibility.unseen_accessed === false &&
    topicCoverageFeasibility.bindings?.item_register_sha256 ===
      sha(paths.upstreamItems) &&
    topicCoverageFeasibility.bindings?.source_register_sha256 ===
      sha(paths.upstreamSources) &&
    topicCoverageFeasibility.bindings?.global_allocation_sha256 ===
      sha(paths.upstreamAllocation) &&
    topicCoverageFeasibility.bindings?.qualification_builder_sha256 ===
      sha(paths.fullPrepare) &&
    topicCoverageFeasibility.exhaustive_dynamic_programming_result
      ?.maximum_validation_topic_count ===
      upstreamAllocation.topic_coverage?.count &&
    topicCoverageFeasibility.exhaustive_dynamic_programming_result
      ?.all_11_topics_feasible === false &&
    topicCoverageFeasibility.unavoidably_absent_topics?.length ===
      upstreamAllocation.topic_coverage?.missing?.length &&
    topicCoverageFeasibility.avoidable_selected_split_gaps?.length === 0 &&
    topicCoverageFeasibility.unavoidably_absent_topics.every(
      (entry) =>
        upstreamAllocation.topic_coverage.missing.includes(entry.topic) &&
        entry.feasible_state_count_with_topic === 0 &&
      entry.component_size > upstreamAllocation.validation.count,
    ),
  independent_visible_52_item_195_mapping_development_review_passed:
    independentVisibleAudit.status ===
      "approved_for_controlled_local_development_training_only" &&
    independentVisibleAudit.passed === true &&
    independentVisibleAudit.training_authorised === true &&
    independentVisibleAudit.release_authorised === false &&
    independentVisibleAudit.bindings?.repaired_training_pack_sha256 ===
      sha(paths.repairedV8Pack) &&
    independentVisibleAudit.bindings?.repair_application_audit_sha256 ===
      sha(paths.repairedV8ApplicationAudit) &&
    upstreamItems.input_hashes?.repaired_wave_2_3_pack ===
      sha(paths.repairedV8Pack) &&
    independentVisibleAudit.counts?.visible_items_reviewed === 52 &&
    independentVisibleAudit.counts?.proposition_source_mappings_reviewed ===
      195 &&
    independentVisibleAudit.counts?.passed_items === 52 &&
    independentVisibleAudit.counts?.passed_mappings === 195 &&
    independentVisibleAudit.counts?.substantive_defects === 0 &&
    independentVisibleAudit.counts?.citation_span_defects === 0 &&
    independentVisibleAudit.counts?.unresolved_conflicts === 0 &&
    independentVisibleAudit.limitations?.some((entry) =>
      /does not authorise release, production use or any sealed-unseen evaluation/i.test(
        entry,
      ),
    ) === true,
};
if (!Object.values(upstreamChecks).every(Boolean)) {
  throw new Error(`Compact renderer intake failed: ${JSON.stringify(upstreamChecks)}`);
}

const mappingKey = (trainingId, proposition) =>
  `${trainingId}\u0000${proposition}`;
const expectedRepairMappings = upstreamItems.items
  .filter((item) => item.cohort === "wave_2" || item.cohort === "wave_3")
  .flatMap((item) =>
    (item.proposition_source_candidates || []).map((mapping) => ({
      training_id: item.training_id,
      cohort: item.cohort,
      proposition: mapping.proposition,
      source_ids: mapping.source_ids,
      support_relationship: mapping.support_relationship,
      source_by_id: new Map(
        (item.retrieved_evidence || []).map((source) => [source.source_id, source]),
      ),
    })),
  );
const expectedRepairByKey = new Map(
  expectedRepairMappings.map((mapping) => [
    mappingKey(mapping.training_id, mapping.proposition),
    mapping,
  ]),
);
const validatedSpanRecommendationByKey = new Map();
const validateSpanRecommendations = (audit, cohort, expectedCount, path) => {
  const decisions = audit.decisions || [];
  const seen = new Set();
  const failures = [];
  if (
    audit.passed !== false ||
    audit.training_authorised !== false ||
    audit.release_authorised !== false ||
    audit.independent_legal_review !== false ||
    audit.unseen_accessed !== false ||
    audit.bindings?.item_register_sha256 !== sha(paths.upstreamItems) ||
    audit.bindings?.full_source_register_sha256 !== sha(paths.upstreamSources) ||
    decisions.length !== expectedCount
  ) {
    failures.push("top_level_fail_closed_binding_or_count");
  }
  for (const decision of decisions) {
    const key = mappingKey(decision.training_id, decision.proposition);
    const expected = expectedRepairByKey.get(key);
    if (!expected || expected.cohort !== cohort || seen.has(key)) {
      failures.push(`${decision.training_id}:unexpected_or_duplicate_mapping`);
      continue;
    }
    seen.add(key);
    const mappedSourceIds = decision.mapped_source_ids || [];
    const selectedSourceIds = decision.selected_parent_source_ids || [];
    const spans = decision.recommended_spans || [];
    const exactMapping = sameSet(mappedSourceIds, expected.source_ids || []);
    const selectedValid =
      selectedSourceIds.length > 0 &&
      selectedSourceIds.length === new Set(selectedSourceIds).size &&
      selectedSourceIds.every((sourceId) => mappedSourceIds.includes(sourceId));
    const spansValid =
      spans.length > 0 &&
      spans.every((span) => {
        const source = expected.source_by_id.get(span.parent_source_id);
        return (
          selectedSourceIds.includes(span.parent_source_id) &&
          source &&
          source.content_sha256 === span.full_source_sha256 &&
          Number.isInteger(span.start) &&
          Number.isInteger(span.end) &&
          span.start >= 0 &&
          span.end > span.start &&
          span.end <= source.text.length &&
          source.text.slice(span.start, span.end) === span.text &&
          contentHash(span.text) === span.excerpt_sha256
        );
      }) &&
      selectedSourceIds.every((sourceId) =>
        spans.some((span) => span.parent_source_id === sourceId),
      );
    const decisionValid =
      decision.proposition_sha256 === contentHash(decision.proposition) &&
      decision.support_relationship === expected.support_relationship &&
      exactMapping &&
      selectedValid &&
      spansValid &&
      decision.passed === false;
    if (!decisionValid) {
      failures.push(`${decision.training_id}:invalid_mapping_source_or_span_binding`);
      continue;
    }
    validatedSpanRecommendationByKey.set(key, decision);
  }
  const expectedKeys = expectedRepairMappings
    .filter((mapping) => mapping.cohort === cohort)
    .map((mapping) => mappingKey(mapping.training_id, mapping.proposition));
  if (
    expectedKeys.length !== expectedCount ||
    expectedKeys.some((key) => !seen.has(key))
  ) {
    failures.push("missing_expected_mappings");
  }
  if (failures.length) {
    throw new Error(
      `Hash-bound ${cohort} span recommendations failed: ${path}: ${failures.join(",")}`,
    );
  }
};
validateSpanRecommendations(
  wave2SpanRecommendations,
  "wave_2",
  127,
  paths.wave2SpanRecommendations,
);
validateSpanRecommendations(
  wave3SpanRecommendations,
  "wave_3",
  68,
  paths.wave3SpanRecommendations,
);
if (validatedSpanRecommendationByKey.size !== 195) {
  throw new Error(
    `Expected 195 hash-bound repaired proposition span recommendations; got ${validatedSpanRecommendationByKey.size}`,
  );
}

const STOPWORDS = new Set(
  "a an and are as at be been being but by can could did do does for from had has have if in into is it its may might must no not of on only or should so than that the their them then there these they this those to under until use used using was were what when where which who will with would you your also any each own before after separately likely relevant establish check treat apply start first".split(
    /\s+/,
  ),
);
const stem = (word) => {
  if (/^\d+$/.test(word) || word.length <= 4) return word;
  return word.replace(/(ingly|edly|ation|ments|ment|ings|ing|ies|ied|ed|es|s)$/i, "");
};
const terms = (value) =>
  [...String(value || "").toLowerCase().matchAll(/[a-z0-9£]+/g)]
    .map((match) => stem(match[0]))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
const uniqueTerms = (value) => [...new Set(terms(value))];

const REVIEW_QUERY_OVERRIDES = {
  "v2-w2-t01-train-002|Payroll deductions and a dashboard label do not determine the legal classification.":
    "categories occupational pension scheme personal pension scheme definition",
  "v2-w2-t01-train-002|if those documents are missing, say the classification is not established.":
    "categories occupational pension scheme personal pension scheme definition instrument rules",
  "v2-w2-t01-train-001|A separately invested AVC may be a money-purchase arrangement where the benefit is calculated by reference to the capital amount available at entitlement, but the amount received may also depend on how the pot is used, including payments into the arrangement, investment returns and prevailing annuity rates":
    "money purchase capital amount available calculated entitlement payments investment returns annuity rates",
  "v2-w2-t01-train-001|check whether the AVC instead buys a promised or guaranteed benefit.":
    "defined benefits calculated earnings service factor AVC pre arranged grant additional pension",
  "v2-w2-t01-train-001|The selected classification sources do not supply a common valuation method, so present the annual pension and capital fund separately unless a stated, sourced conversion method is available, and apply each component's own benefit, transfer and tax rules.":
    "benefits different variety separate arrangements tax rules separate rules restrictions",
  "v2-w2-t01-train-004|Do not invent an individual pot.":
    "annualised accrued value calculated retirement date illustration date",
  "v2-w2-t02-train-002|It should have clear delegations and escalation routes, monitor complaints, internal controls, KPIs and service levels, record remediation and ensure continuity if the provider changes or fails.":
    "clear documented procedures continuous consistent service provider changes fails dispute procedures governance administration internal dispute resolution",
  "v2-w2-t02-train-004|Missing reasons do not automatically prove that the discretionary decision is void, but they create a serious evidential and governance problem.":
    "trustees discretionary power improper purpose irrelevant irrational factors decision",
  "v2-w2-t02-train-004|Reconstruct what the authorised decision-maker considered, check the rules, relevant evidence, conflicts and process, and use IDRP or legal review rather than inventing reasons.":
    "trustees considering decision irrelevant irrational factors dispute process advice decision making",
  "v2-w2-t03-train-001|it is not an amount already deducted from individual promised pensions.":
    "technical provisions amount actuarial calculation scheme liabilities sufficient appropriate assets",
  "v2-w2-t03-train-002|This is transaction-specific legal, actuarial and covenant work: the assistant should explain the framework but refer the proposed terms and evidence to qualified advisers before implementation.":
    "employer covenant assessment transaction mitigation trustees advisers legal actuarial",
  "v2-w2-t03-train-005|retrieve the applicable rules before answering.":
    "schedule payments contributions due payment failure trustees managers",
  "v2-w2-t03-train-005|A missing dashboard month is evidence to investigate, not proof of a statutory late payment.":
    "schedule contributions payments due paid trustees managers failure payment",
  "v2-w2-t03-train-006|Do not apply Great Britain moral-hazard provisions as the sole governing law.":
    "Northern Ireland Article contribution notice Pensions Order Great Britain section contribution notice Pensions Act",
  "v2-w2-t03-train-006|Analyse any Great Britain group entity or scheme separately under the corresponding Great Britain legislation.":
    "Section 38 contribution notices occupational pension scheme employer debt",
  "v2r-w2-t03-train-001|retrieve the applicable earlier or Northern Ireland framework before answering.":
    "valuation effective date 22 September 2024 recovery plan trustees Great Britain",
  "v2-w2-t04-train-002|The over-60 exclusion is direct age treatment.":
    "protected characteristic age treatment proportionate legitimate aim less favourable",
  "v2-w2-t04-train-002|If not, it is lawful only if the scheme can evidence a legitimate aim and show that the exclusion is a proportionate means of achieving it":
    "non discrimination rule occupational pension scheme age proportionate legitimate aim",
  "v2-w2-t04-train-003|Offer and document a reasonable accessible alternative to the digital portal, agree the format with the member, preserve the same substantive treatment and route the complaint through the applicable internal procedure.":
    "reasonable adjustments accessible format occupational pension non discrimination scheme dispute procedure internal",
  "v2-w2-t04-train-003|If the portal problem threatens a procedural deadline, preserve the complaint date and consider any power or duty to extend, waive or treat the step as satisfied":
    "reasonable adjustment duty dispute procedure time limit extend six months",
  "v2-w2-t04-train-004|Split the 1994–2001 service by the eligibility rules and law in force for each period.":
    "part time worker less favourable pensionable service July 2000 calculated service",
  "v2-w2-t04-train-006|Use the Northern Ireland counterparts, not the Equality Act 2010 by default.":
    "occupational pension scheme disabled person reasonable adjustment Northern Ireland",
  "v2-w2-t04-train-006|Confirm the scheme's territorial position, the member's disability and disadvantage, the requested format, reasonableness and knowledge before reaching a breach conclusion.":
    "occupational pension scheme disabled person substantial disadvantage reasonable steps internal dispute resolution application member",
  "v2-w2-t04-train-001|It should discuss the member's needs, preserve an equivalent valid election and deadline, and not treat a PDF-only process as conclusive.":
    "reasonable steps substantial disadvantage provision criterion practice adjustments occupational pension scheme non discrimination rule trustees",
  "v2r-w2-t06-train-001|investigate root cause":
    "data matching records errors advisers providers dashboard standards",
  "v2r-w2-t06-train-001|monitor service levels":
    "reporting standards monitor effectiveness dashboards compliance service provider performance",
  "v2r-w2-t06-train-003|hundreds of misses are serious but do not replace that documented assessment.":
    "breach reasonable cause material significance report regulator decision",
  "v2-w3-t01-train-001|Do not rely on the label alone.":
    "protected pension age conditions entitlement relevant employment",
  "v2-w3-t01-train-002|The selected general guidance does not provide this member's scheme terms or actuarial factors, so it cannot support an exact amount.":
    "ask pension provider scheme right take pension before age pension pot smaller retire early",
  "v2-w3-t01-train-002|whether consent is required or a reduction applies must remain conditional until those scheme terms are produced.":
    "ask pension provider scheme right take pension before age pension pot smaller retire early",
  "v2-w3-t01-train-004|The old expression of wish does not by itself guarantee a recipient.":
    "not required follow wishes letter nomination form decision process",
  "v2-w3-t01-train-004|The selected sources do not permit a guaranteed beneficiary outcome.":
    "cannot direct decision maker specific outcome who pay death benefit",
  "v2-w3-t01-train-005|That arithmetic does not determine suitability.":
    "pension commencement lump sum applicable amount authorised firm permissions advice",
  "v2-w3-t02-train-004|The selected sources do not provide a member-specific amount":
    "transitional tax free amount certificate available lump sum allowance calculate",
  "v2r-w3-t02-train-003|The December 2024 completion date is not enough to answer.":
    "transfer requested before 30 October 2024 completed before 30 April 2025 exclusion",
  "v2r-w2-t05-train-002|Track the regulations, guidance and commencement position.":
    "regulations appoint day value for money assessment",
  "v2r-w2-t05-train-002|Preparation is prudent, but do not perform or publish a purported statutory rating until the regulations, scope, metrics, timetable and service are operative.":
    "regulations appoint day value for money assessment rating metric service",
};
const REVIEW_SOURCE_SELECTION_OVERRIDES = {
  "v2-w3-t02-train-001|For 2026/27 the standard annual allowance is £60,000 and the MPAA is £10,000.": [
    "official-hmrc-pension-schemes-rates-2026-27_chunk_5",
    "official-hmrc-pension-schemes-rates-2026-27_chunk_7",
  ],
  "v2r-w3-t02-train-002|If post-trigger money-purchase input does not exceed the £10,000 MPAA, test total pension input under the ordinary annual allowance.": [
    "review-v3-hmrc-ptm056510-method-only",
  ],
  "v2-w3-t02-train-004|A valid lifetime-allowance protection can alter the post-6 April 2024 lump-sum allowance and lump-sum-and-death-benefit allowance.": [
    "review-v3-hmrc-ptm174700",
    "official-hmrc-ptm-ptm170001_chunk_79",
  ],
  "v2-w3-t02-train-004|Identify the exact protection—such as enhanced, primary, fixed or individual protection—apply the current provision for that protection, confirm it has not been lost, and reconcile all pre- and post-6 April 2024 benefit events and any transitional tax-free amount certificate.": [
    "review-v3-hmrc-ptm174700",
    "official-hmrc-ptm-ptm170001_chunk_79",
  ],
  "v2-w3-t02-train-004|The selected sources do not provide a member-specific amount": [
    "review-v3-hmrc-ptm174700",
  ],
  "v2-w3-t02-train-004|obtain an administrator or pensions-tax calculation before payment.": [
    "review-v3-hmrc-ptm174700",
  ],
  "v2-w2-t03-train-003|In the ordinary regulation 6E(1)(b)(i) branch, the employment-cessation event occurs before the regulation 6E(2) conditions are met": [
    "review-v3-employer-debt-regulations-reg6e",
  ],
  "v2-w2-t02-train-004|Missing reasons do not automatically prove that the discretionary decision is void, but they create a serious evidential and governance problem.": [
    "review-pinned-edge-discretion-principle",
  ],
  "v2-w2-t03-train-006|Do not apply Great Britain moral-hazard provisions as the sole governing law.": [
    "review-v3-ni-order-2005-arts34-38",
    "review-pinned-pa2004-corporate-transaction-powers",
  ],
  "v2-w2-t03-train-003|Check that the scheme and employers qualify, the funding test or permitted exception, a legally enforceable assumption of the leaving employer's liabilities by the replacement employer, written consent from trustees and all affected employers, scheme and insolvency status, any required additional payment and liability reduction, and the exact effective sequence before concluding that no debt is treated as due for the event.": [
    "review-v3-employer-debt-regulations-reg6e",
    "review-v3-employer-debt-regulations-reg6za",
  ],
  "v2-w2-t04-train-005|The current Equality Act 2010 exception in Schedule 9 paragraph 18 is disapplied for access to an occupational survivor benefit payable to a surviving spouse or civil partner, and Walker v Innospec is material to service-based quantum for a same-sex spouse.": [
    "official-equality-act-2010_chunk_454",
    "review-v3-walker-v-innospec",
  ],
  "v2r-w2-t05-train-002|Trustees can map default arrangements, data owners and systems for investment performance, costs, charges and service-quality metrics, and assess their ability to compare metrics against other schemes and relevant benchmarks.": [
    "official-pension-schemes-act-2026_chunk_22",
    "official-tpr-pension-schemes-act-2026-status-page_chunk_4",
  ],
  "v2r-w2-t05-train-002|Preparation is prudent, but do not perform or publish a purported statutory rating until the regulations, scope, metrics, timetable and service are operative.": [
    "official-tpr-pension-schemes-act-2026-status-page_chunk_4",
    "review-v3-psa2026-s133",
  ],
};
const REVIEW_EXACT_SPAN_OVERRIDES = {
  "v2-w2-t01-train-001|Treat the final-salary promise as defined benefit.|review-v3-hmrc-ptm023300": [
    {
      start_text: "Final salary or career average arrangements are common examples",
      end_text: "Final salary or career average arrangements are common examples of defined benefits arrangements.",
    },
  ],
  "v2-w2-t01-train-001|A separately invested AVC may be a money-purchase arrangement where the benefit is calculated by reference to the capital amount available at entitlement, but the amount received may also depend on how the pot is used, including payments into the arrangement, investment returns and prevailing annuity rates|review-v3-hmrc-ptm023300": [
    {
      start_text: "The precise amount of benefits the member receives under a money purchase arrangement",
      end_text: "- prevailing annuity rates, for instance how much an amount of money will buy as an annual pension.",
    },
  ],
  "v2-w2-t01-train-001|check whether the AVC instead buys a promised or guaranteed benefit.|review-v3-hmrc-ptm023300": [
    {
      start_text: "- case D - the payment by a member of an AVC",
      end_text: "additional pension of £10,000 per year.",
    },
  ],
  "v2-w2-t01-train-001|The selected classification sources do not supply a common valuation method, so present the annual pension and capital fund separately unless a stated, sourced conversion method is available, and apply each component's own benefit, transfer and tax rules.|review-v3-hmrc-ptm023200": [
    {
      start_text: "Benefits of a different variety",
      end_text: "for the purposes of the tax rules as being within separate arrangements.",
    },
    {
      start_text: "When considering other issues such as the annual allowance or lifetime allowance",
      end_text: "the five different types of arrangements are often each subject to separate rules and restrictions.",
    },
  ],
  "v2-w2-t01-train-003|No. Trusteeship and master-trust status describe the scheme structure, not the benefit formula.|official-pension-schemes-act-2017_chunk_3": [
    {
      start_text: "(1) In this Act, “Master Trust scheme” means an occupational pension scheme which—",
      end_text: "(1)(e) is not a collective money purchase scheme.",
    },
  ],
  "v2-w2-t01-train-004|For collective money-purchase benefits, an active member's dashboard value data are an annualised accrued value and an annualised projected value|review-pinned-gb-dashboard-regulations-sch3-p4": [
    {
      start_text: "For members with collective money purchase benefits, trustees or managers of the pension scheme must provide the following value data—",
      end_text: "and without regard to future increases in earnings;",
    },
  ],
  "v2-w2-t01-train-005|those materials determine whether it is an occupational, personal or public-service scheme and whether the benefits are defined benefit, money purchase or mixed.|review-v3-pspa2013-ss1-8": [
    {
      start_text: "(1) Scheme regulations may establish a scheme under section 1 as—",
      end_text: "(1)(c) a scheme of any other description.",
    },
  ],
  "v2-w2-t02-train-001|The relationship creates a material conflict that disclosure alone may not cure.|review-pinned-tpr-general-code-conflicts": [
    {
      start_text: "9.  Governing bodies should have processes in place to ensure that their decision-making",
      end_text: "could resign.",
    },
  ],
  "v2-w2-t02-train-001|Apply the governing rules and conflicts policy, consider recusal and independent decision-makers, obtain any needed advice and record how the appointment was made in members' interests.|review-pinned-tpr-general-code-conflicts": [
    {
      start_text: "12.  In cases where resignation is deemed appropriate, careful consideration needs to",
      end_text: "eliminated (and if so, the best way of achieving it).",
    },
    {
      start_text: "13.  Where conflicts of interest are not eliminated, depending on the situation, the options",
      end_text: "A conflicted individual who simply\nabstains may still unduly influence an outcome.",
    },
  ],
  "v2-w2-t02-train-004|Missing reasons do not automatically prove that the discretionary decision is void, but they create a serious evidential and governance problem.|review-pinned-edge-discretion-principle": [
    {
      start_text: "The judge may\n\ndisagree with the manner in which the trustees have exercised their discretion",
      end_text: "opinion undue.",
    },
  ],
  "v2-w2-t02-train-004|Reconstruct what the authorised decision-maker considered, check the rules, relevant evidence, conflicts and process, and use IDRP or legal review rather than inventing reasons.|review-pinned-edge-discretion-principle": [
    {
      start_text: "The judge may\n\ndisagree with the manner in which the trustees have exercised their discretion",
      end_text: "opinion undue.",
    },
  ],
  "v2-w2-t02-train-005|manage the employer conflict|review-pinned-tpr-general-code-conflicts": [
    {
      start_text: "13.  Where conflicts of interest are not eliminated, depending on the situation, the options",
      end_text: "A conflicted individual who simply\nabstains may still unduly influence an outcome.",
    },
  ],
  "v2r-w2-t02-train-001|First establish whether the scheme is within the effective-system-of-governance regime and whether the statutory own-risk-assessment requirement applies, including the 100-member threshold and any scheme-specific exception.|review-v3-tpr-own-risk-assessment": [
    {
      start_text: "1.  If a scheme required to operate an effective system of governance (ESOG)",
      end_text: "nature, scale, and complexity of the activities of the scheme.",
    },
  ],
  "v2-w2-t03-train-002|Assess the sale's effect on the employer covenant, scheme funding, cash flows, security and recoverability, together with mitigation, notifiable-event duties, moral-hazard powers and any clearance question.|review-v3-tpr-employer-covenant-transaction": [
    {
      start_text: "16.Nonetheless, trustees may find it appropriate to hold unsupported investment risk",
      end_text: "d.provide contingent assets and formalise wider group support",
    },
  ],
  "v2r-w2-t03-train-001|a one-year affordability estimate is not automatically a flat contribution promise for every later year.|review-v3-tpr-db-recovery-plans": [
    {
      start_text: "Trustees should assess future reasonable affordability at least",
      end_text: "and the pace of funding below.",
    },
  ],
  "v2r-w2-t03-train-001|The proposed £3 million therefore needs year-by-year cash-flow and covenant evidence, sustainable-growth evidence, investment and member-risk analysis, mitigation and a documented explanation.|review-v3-tpr-db-recovery-plans": [
    {
      start_text: "3.The matters that trustees must consider are:",
      end_text: "the recommendations of that third-party must be taken\ninto account",
    },
  ],
  "v2-w2-t04-train-005|Separate access to a survivor pension from the amount payable.|review-v3-walker-v-innospec": [
    {
      start_text: "PARAGRAPH 65\nPut simply, Mr Römer could not claim pension payments before 2003",
      end_text: "even those which preceded the date of the transposition.",
    },
    {
      start_text: "PARAGRAPH 72\nI would therefore hold that Mr Walker’s husband",
      end_text: "what I consider to be the plain effect of the Directive.",
    },
  ],
  "v2-w2-t04-train-006|Use the Northern Ireland counterparts, not the Equality Act 2010 by default.|review-pinned-dda1995-s4h-ni": [
    {
      start_text: "(1) Where—",
      end_text: "that person has a disability and is likely to be affected in the way mentioned in subsection (1).",
    },
  ],
  "v2-w2-t04-train-006|Section 4H of the Disability Discrimination Act 1995, in its Northern Ireland application, can require occupational-pension trustees or managers to take reasonable steps where a scheme practice or physical feature places a relevant disabled person at a substantial disadvantage, subject to the statutory knowledge condition.|review-pinned-dda1995-s4h-ni": [
    {
      start_text: "(1) Where—",
      end_text: "that person has a disability and is likely to be affected in the way mentioned in subsection (1).",
    },
  ],
  "v2-w2-t04-train-006|Confirm the scheme's territorial position, the member's disability and disadvantage, the requested format, reasonableness and knowledge before reaching a breach conclusion.|review-pinned-dda1995-s4h-ni": [
    {
      start_text: "(1) Where—",
      end_text: "that person has a disability and is likely to be affected in the way mentioned in subsection (1).",
    },
  ],
  "v2-w2-t04-train-006|Confirm the scheme's territorial position, the member's disability and disadvantage, the requested format, reasonableness and knowledge before reaching a breach conclusion.|review-v3-ni-idrp-regulations-reg2": [
    {
      start_text: "(1) When the trustees or managers of an occupational pension scheme receive",
      end_text: "give the applicant the contact details for the Money and Pensions Service.",
    },
  ],
  "v2r-w2-t05-train-001|As at 1 September 2026, Royal Assent has enacted the Pension Schemes Act 2026 but has not made every DC reform operative.|official-pension-schemes-act-2026_chunk_212": [
    {
      start_text: "(2) So far as not brought into force under subsection (1), this Act comes into force as follows.",
      end_text: "(4)(f) Chapter 6 comes into force on such day as the Secretary of State may by regulations appoint.",
    },
  ],
  "v2r-w2-t05-train-002|Trustees can map default arrangements, data owners and systems for investment performance, costs, charges and service-quality metrics, and assess their ability to compare metrics against other schemes and relevant benchmarks.|official-pension-schemes-act-2026_chunk_22": [
    {
      start_text: "(1) Value for money regulations made by virtue of section 11(2)(a) may—",
      end_text: "(1)(b)(iii) the use and evaluation of evidence;",
    },
  ],
  "v2r-w2-t05-train-003|After commencement, section 9 of the 2026 Act inserts section 36B into the 1995 Act, but the operative conditions and regulations must then be checked before acting.|official-pension-schemes-act-2026_chunk_212": [
    {
      start_text: "(3) Part 1 comes into force on such day as the Secretary of State may by regulations appoint.",
      end_text: "(3) Part 1 comes into force on such day as the Secretary of State may by regulations appoint.",
    },
  ],
  "v2r-w2-t06-train-001|Separately assess whether the breach is materially significant for reporting to TPR, using cause, effect, reaction and wider implications, and route any affected member's complaint through the applicable procedure.|review-v4-tpr-reporting-breaches-complete": [
    {
      start_text: "How to report\n1. Those responsible for reporting breaches",
      end_text: "h. a process for reviewing reporting procedures following any important changes to\nthe scheme’s governance arrangements",
    },
  ],
  "v2r-w2-t06-train-003|Assess whether the breach is materially significant for reporting to TPR, considering cause, effect, reaction and wider implications|review-v4-tpr-reporting-breaches-complete": [
    {
      start_text: "How to report\n1. Those responsible for reporting breaches",
      end_text: "h. a process for reviewing reporting procedures following any important changes to\nthe scheme’s governance arrangements",
    },
  ],
  "v2r-w2-t06-train-003|hundreds of misses are serious but do not replace that documented assessment.|review-v4-tpr-reporting-breaches-complete": [
    {
      start_text: "How to report\n1. Those responsible for reporting breaches",
      end_text: "h. a process for reviewing reporting procedures following any important changes to\nthe scheme’s governance arrangements",
    },
  ],
  "v2r-w2-t06-train-003|Route individual administration complaints through the scheme's complaint or IDRP process as well: complaint handling and regulatory reporting are separate controls.|review-v4-tpr-reporting-breaches-complete": [
    {
      start_text: "How to report\n1. Those responsible for reporting breaches",
      end_text: "h. a process for reviewing reporting procedures following any important changes to\nthe scheme’s governance arrangements",
    },
  ],
  "v2-w3-t01-train-006|No. A loan from a registered pension scheme to a member or former member is an unauthorised payment equal to the loan|official-hmrc-ptm-ptm120000_chunk_79": [
    {
      start_text: "Any loan made by a registered pension scheme to:",
      end_text: "A scheme sanction charge (see PTM135000 ) will also be made on the scheme administrator.",
    },
  ],
  "v2-w3-t01-train-006|protected pension age or ill-health rules for genuine benefit payments do not convert that loan into an authorised benefit.|official-hmrc-ptm-ptm120000_chunk_79": [
    {
      start_text: "Any loan made by a registered pension scheme to:",
      end_text: "A scheme sanction charge (see PTM135000 ) will also be made on the scheme administrator.",
    },
  ],
  "v2r-w3-t01-train-001|From 6 April 2028 the normal minimum pension age is 57.|review-v3-hmrc-protected-pension-age": [
    {
      start_text: "Since 6 April 2010 the normal minimum pension age is 55.",
      end_text: "- has a protected pension age.",
    },
  ],
  "v2r-w3-t01-train-001|On the facts given, a payment at age 56 in August 2029 would not ordinarily be an authorised age-based pension payment.|review-v3-hmrc-protected-pension-age": [
    {
      start_text: "Since 6 April 2010 the normal minimum pension age is 55.",
      end_text: "- has a protected pension age.",
    },
  ],
  "v2r-w3-t01-train-001|Check, however, whether the pension is under a uniformed-services pension scheme, which is exempt from the 2028 increase, or whether another statutory exception such as ill health applies|review-v3-hmrc-protected-pension-age": [
    {
      start_text: "Since 6 April 2010 the normal minimum pension age is 55.",
      end_text: "- has a protected pension age.",
    },
    {
      start_text: "The normal minimum pension age will increase from age 55 to age 57 from 6 April 2028.",
      end_text: "There are no changes for those members who already have an existing 6 April 2006 protected pension age of 55.",
    },
  ],
  "v2r-w3-t01-train-002|The three £8,000 rights should first be tested under the separate small-pot rules, including scheme type, age, extinguishment, transfer history and—where applicable—the three-payment limit for non-occupational arrangements.|review-v3-hmrc-ptm063700": [
    {
      start_text: "If a\nmember has a small amount of benefit rights (whether the rights are\nuncrystallised or comprise a pension in payment) in a registered pension\nscheme, and that scheme is not a public service pension scheme or an occupational\npension scheme",
      end_text: "member has not previously received more than 2 payments under\nregulation 11A.",
    },
    {
      start_text: "The last\ncondition means that an individual can be given more than one small lump sum",
      end_text: "two/three different arrangements under\nthat scheme.",
    },
  ],
  "v2r-w3-t01-train-002|Scheme rules and payment history are required.|review-v3-hmrc-ptm063700": [
    {
      start_text: "The last\ncondition means that an individual can be given more than one small lump sum",
      end_text: "two/three different arrangements under\nthat scheme.",
    },
    {
      start_text: "A member\nmay have a large number of arrangements",
      end_text: "either one or each of two/three arrangements under the scheme.",
    },
  ],
  "v2-w3-t02-train-001|For 2026/27 the standard annual allowance is £60,000 and the MPAA is £10,000.|official-hmrc-pension-schemes-rates-2026-27_chunk_5": [
    {
      start_text: "## Annual allowance",
      end_text: "| 2026 to 2027\n| £60,000",
    },
  ],
  "v2-w3-t02-train-001|For 2026/27 the standard annual allowance is £60,000 and the MPAA is £10,000.|official-hmrc-pension-schemes-rates-2026-27_chunk_7": [
    {
      start_text: "## Money purchase annual allowance",
      end_text: "| 2026 to 2027\n| £10,000",
    },
  ],
  "v2-w3-t02-train-003|Obtain the provider's payment type, crystallisation record and first taxable-payment date before fixing the trigger date.|review-pinned-hmrc-ptm056520-current": [
    {
      start_text: "The trigger events are set out as follows.",
      end_text: "The earliest of any of those events is when the individual first flexibly accesses a money purchase arrangement.",
    },
    {
      start_text: "If an individual has a member’s flexi-access drawdown fund that came into effect as a result of:",
      end_text: "- payment of a short-term annuity purchased with funds from the member’s flexi-access drawdown fund.",
    },
  ],
  "v2-w3-t02-train-005|keep the overseas-transfer-charge test distinct from any excess-overseas-transfer-allowance charge.|review-v3-hmrc-ptm102200": [
    {
      start_text: "Sections 244IA to 244IC Finance Act 2004\n\nWhere an individual’s total transfers to a QROPS",
      end_text: "section 244IA.",
    },
  ],
  "v2-w3-t02-train-005|keep the overseas-transfer-charge test distinct from any excess-overseas-transfer-allowance charge.|review-v3-hmrc-ptm102300": [
    {
      start_text: "Where a recognised transfer or relieved relevant non-UK scheme transfer has been made to a QROPS",
      end_text: "if certain conditions are met, as set out below.",
    },
  ],
  "v2-w3-t02-train-006|Without that history, the selected source cannot support a conclusion that the standard allowance is wholly unused.|review-v3-hmrc-ptm174100": [
    {
      start_text: "From 6 April 2024, individuals will be entitled to a new lump sum allowance.",
      end_text: "These transitional rules apply from the 2024-25 tax year.",
    },
  ],
  "v2r-w3-t02-train-002|Also calculate the default amount from total input and the available ordinary allowance|review-v3-hmrc-ptm056510-method-only": [
    {
      start_text: "The individual’s total pension input amount for the tax year",
      end_text: "potentially subject to the annual allowance charge (‘the default chargeable amount’).",
    },
  ],
  "v2r-w3-t02-train-002|Unused MPAA is not carried forward.|review-v3-hmrc-ptm056510-method-only": [
    {
      start_text: "If the individual’s money purchase pension input amounts do not exceed the money purchase annual allowance:",
      end_text: "- any unused money purchase annual allowance cannot be carried forward to later tax years.",
    },
  ],
  "v2r-w3-t02-train-003|The December 2024 completion date is not enough to answer.|review-v3-hmrc-ptm102300": [
    {
      start_text: "Note that this\nexclusion only applies to transfers requested before 30 October 2024",
      end_text: "the member is UK resident or resident in a country within the EEA or Gibraltar.",
    },
  ],
  "v2r-w3-t02-train-003|The former EEA/Gibraltar exclusion can still apply if the substantive request was made before 30 October 2024 and the transfer completed before 30 April 2025, provided its residence, QROPS-establishment and information conditions were met.|review-v3-hmrc-ptm102300": [
    {
      start_text: "Where the member has given the scheme administrator or scheme manager the required information before the transfer",
      end_text: "the member is UK resident or resident in a country within the EEA or Gibraltar.",
    },
  ],
  "v2r-w3-t02-train-003|if the transition does not apply, test the current exclusions and overseas transfer allowance.|review-v3-hmrc-ptm102200": [
    {
      start_text: "The transferred value of a recognised transfer will be subject to an overseas transfer charge under section 244AC",
      end_text: "Go to PTM102300 to see full details on how to satisfy these exclusion conditions and if a transfer is excluded from an overseas transfer charge under section 244AC.",
    },
    {
      start_text: "## The overseas transfer allowance",
      end_text: "the original transfer was a block transfer from a relieved RNUKS.",
    },
  ],
  "v2r-w3-t02-train-003|if the transition does not apply, test the current exclusions and overseas transfer allowance.|review-v3-hmrc-ptm102300": [
    {
      start_text: "Where the member has given the scheme administrator or scheme manager the required information before the transfer",
      end_text: "PTM102350 provides examples of where a transfer is excluded from an overseas transfer charge under section 244AC.",
    },
  ],
};

// Mapping-by-mapping substantive audits may identify several non-contiguous
// passages within one frozen parent source. Numeric offsets are unambiguous only
// when bound to that source's exact SHA-256, so every entry must carry the hash
// reviewed by the auditor. These overrides take precedence over string anchors.
const REVIEW_EXACT_OFFSET_OVERRIDES = {
};

const trimSpan = (text, start, end) => {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
};
const sourceSegments = (text) => {
  const boundarySet = new Set([0, text.length]);
  const separator = /\n+|[.!?;:](?=\s|$)/g;
  let match;
  while ((match = separator.exec(text))) {
    if (/^\n+$/.test(match[0])) {
      boundarySet.add(match.index);
      boundarySet.add(match.index + match[0].length);
    } else {
      boundarySet.add(match.index + match[0].length);
    }
  }
  const provisionMarker = /(?:^|\s)(\(\d+[A-Za-z]?\)(?:\([a-zivx]+\))?)/gim;
  while ((match = provisionMarker.exec(text))) {
    boundarySet.add(match.index + match[0].indexOf(match[1]));
  }
  const boundaries = [...boundarySet].sort((left, right) => left - right);
  const atomic = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const span = trimSpan(text, boundaries[index], boundaries[index + 1]);
    if (span.end <= span.start) continue;
    atomic.push(span);
  }
  const candidates = [...atomic];
  for (let index = 0; index < atomic.length - 1; index += 1) {
    const merged = trimSpan(text, atomic[index].start, atomic[index + 1].end);
    if (merged.end - merged.start <= 600) candidates.push(merged);
  }
  const seen = new Set();
  return candidates
    .filter((span) => {
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((span) => ({ ...span, text: text.slice(span.start, span.end) }))
    .filter((span) => {
      const trimmed = span.text.trim();
      const markdownHeadingOnly = /^#{1,6}\s+[^\n]+$/.test(trimmed);
      const shortUnpunctuatedHeadingLike =
        trimmed.length < 100 &&
        !/[.!?;:]$/.test(trimmed) &&
        !/^(?:[-*|]|\(\d+[A-Za-z]?\))/.test(trimmed);
      const contentTerms = uniqueTerms(trimmed);
      return !markdownHeadingOnly && !shortUnpunctuatedHeadingLike && contentTerms.length >= 2;
    });
};

const scoreSpan = ({ span, proposition, context, overrideQuery, section }) => {
  const spanTerms = new Set(terms(span.text));
  const propositionTerms = uniqueTerms(proposition);
  const queryTerms = uniqueTerms(overrideQuery || proposition);
  const contextTerms = uniqueTerms(context);
  const sectionTerms = uniqueTerms(section);
  const propositionHits = propositionTerms.filter((term) => spanTerms.has(term));
  const queryHits = queryTerms.filter((term) => spanTerms.has(term));
  const contextHits = contextTerms.filter((term) => spanTerms.has(term));
  const sectionHits = sectionTerms.filter((term) => spanTerms.has(term));
  const numericTerms = queryTerms.filter((term) => /^\d+$/.test(term));
  const numericHits = numericTerms.filter((term) => spanTerms.has(term));
  const raw =
    propositionHits.length * 12 +
    queryHits.length * 8 +
    numericHits.length * 15 +
    Math.min(contextHits.length, 5) * 2 +
    Math.min(sectionHits.length, 3);
  const density = raw / Math.sqrt(Math.max(30, span.text.length));
  return {
    raw,
    density,
    signal_hits: [...new Set([...propositionHits, ...queryHits])],
    proposition_hits: propositionHits,
    query_hits: queryHits,
    context_hits: contextHits.slice(0, 8),
    section_hits: sectionHits,
  };
};

const fullSourceMap = new Map();
const fullSourceConflicts = [];
const fullSourceIdentity = (source, fullHash) =>
  JSON.stringify({
    content_sha256: fullHash,
    title: source.title,
    section: source.section,
    jurisdiction: source.jurisdiction,
    source_url: source.source_url || null,
    authority_family: source.authority_family,
    source_role: source.source_role,
    source_snapshot_as_of: source.source_snapshot_as_of || null,
    provision_effective_from: source.provision_effective_from || null,
    provision_status: source.provision_status || null,
    territorial_effective_dates: source.territorial_effective_dates || null,
    oscola_citation: source.oscola_citation || null,
    text_origin: source.text_origin || null,
    citation_metadata: source.citation_metadata || null,
    recorded_snapshot_hash: source.recorded_snapshot_hash || null,
    user_visible: source.user_visible,
  });
for (const item of upstreamItems.items) {
  for (const source of item.retrieved_evidence || []) {
    const fullHash = source.content_sha256 || contentHash(source.text);
    if (fullHash !== contentHash(source.text)) {
      throw new Error(`${item.training_id}/${source.source_id}: full source hash mismatch`);
    }
    const prior = fullSourceMap.get(source.source_id);
    const identity = fullSourceIdentity(source, fullHash);
    if (prior && prior._full_source_identity !== identity) {
      fullSourceConflicts.push({
        source_id: source.source_id,
        type: "same_source_id_conflicting_metadata_or_text",
        hashes: [prior.full_content_sha256, fullHash],
        item_ids: [...new Set([...prior.used_by, item.training_id])],
      });
      continue;
    }
    if (!prior) {
      fullSourceMap.set(source.source_id, {
        ...source,
        source_id: source.source_id,
        text: source.text,
        full_text: source.text,
        content_sha256: fullHash,
        full_content_sha256: fullHash,
        _full_source_identity: identity,
        used_by: [item.training_id],
      });
    } else {
      prior.used_by.push(item.training_id);
    }
  }
}
if (fullSourceConflicts.length) {
  throw new Error(`Full source identity conflicts: ${JSON.stringify(fullSourceConflicts)}`);
}

let nextExcerpt = 1;
const compactItems = [];
const excerptEntries = [];
const mappingEntries = [];
const unmappable = [];

const insertMarkers = (answer, propositionMappings) => {
  const clean = stripMarkers(answer);
  const insertions = propositionMappings.map((mapping) => {
    const start = clean.indexOf(mapping.proposition);
    if (start < 0) {
      throw new Error(
        `${mapping.training_id}: mapped proposition is absent from the target answer: ${mapping.proposition}`,
      );
    }
    return {
      offset: start + mapping.proposition.length,
      marker: mapping.excerpt_ids
        .map((excerptId) => `{{cite:${excerptId}}}`)
        .join(" "),
    };
  });
  let output = clean;
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    output = `${output.slice(0, insertion.offset)} ${insertion.marker}${output.slice(insertion.offset)}`;
  }
  return output.replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
};

for (const item of upstreamItems.items) {
  if (item.cohort === "v1") {
    compactItems.push({
      ...item,
      compact_render_mode: "historical_v1_evidence_retained_verbatim",
      compact_target_answer: item.target_answer,
      compact_target_citation_ids: item.target_citation_ids,
      compact_retrieved_evidence: item.retrieved_evidence,
      compact_proposition_mappings: [],
    });
    continue;
  }
  const sourceById = new Map(
    (item.retrieved_evidence || []).map((source) => [source.source_id, source]),
  );
  const itemMappings = [];
  const selections = [];
  for (const propositionEntry of item.proposition_source_candidates || []) {
    const key = `${item.training_id}|${propositionEntry.proposition}`;
    const auditedSpanRecommendation = validatedSpanRecommendationByKey.get(
      mappingKey(item.training_id, propositionEntry.proposition),
    );
    if (!auditedSpanRecommendation) {
      throw new Error(`${key}: complete hash-bound span recommendation is missing`);
    }
    const overrideQuery = REVIEW_QUERY_OVERRIDES[key] || null;
    const sourceSelectionOverride =
      auditedSpanRecommendation.selected_parent_source_ids;
    if (
      sourceSelectionOverride?.some(
        (sourceId) => !(propositionEntry.source_ids || []).includes(sourceId),
      )
    ) {
      throw new Error(`${key}: source-selection override is outside the frozen mapping`);
    }
    const sourceIdsToReview =
      sourceSelectionOverride || propositionEntry.source_ids || [];
    const context = `${item.user_question} ${stripMarkers(item.ideal_answer)}`;
    const rankedSources = [];
    for (const sourceId of sourceIdsToReview) {
      const source = sourceById.get(sourceId);
      if (!source) continue;
      const exactOffsetOverrides =
        auditedSpanRecommendation.recommended_spans.filter(
          (span) => span.parent_source_id === sourceId,
        ) || REVIEW_EXACT_OFFSET_OVERRIDES[`${key}|${sourceId}`] || null;
      const exactSpanOverrides =
        REVIEW_EXACT_SPAN_OVERRIDES[`${key}|${sourceId}`] || null;
      if (exactOffsetOverrides) {
        for (const exact of exactOffsetOverrides) {
          if (
            exact.full_source_sha256 !== source.content_sha256 ||
            !Number.isInteger(exact.start) ||
            !Number.isInteger(exact.end) ||
            exact.start < 0 ||
            exact.end <= exact.start ||
            exact.end > source.text.length
          ) {
            throw new Error(
              `${key}/${sourceId}: exact offset override is out of bounds or bound to different source bytes`,
            );
          }
          const span = {
            start: exact.start,
            end: exact.end,
            text: source.text.slice(exact.start, exact.end),
          };
          if (contentHash(span.text) !== exact.excerpt_sha256) {
            throw new Error(
              `${key}/${sourceId}: exact offset override excerpt hash mismatch`,
            );
          }
          rankedSources.push({
            source,
            span,
            scoring: scoreSpan({
              span,
              proposition: propositionEntry.proposition,
              context,
              overrideQuery,
              section: `${source.title || ""} ${source.section || ""}`,
            }),
            exact_span_override: true,
            offset_hash_override: true,
          });
        }
        continue;
      }
      if (exactSpanOverrides) {
        for (const exact of exactSpanOverrides) {
          const start = source.text.indexOf(exact.start_text);
          const endStart = source.text.indexOf(exact.end_text, start);
          if (
            start < 0 ||
            endStart < 0 ||
            source.text.indexOf(exact.start_text, start + 1) >= 0
          ) {
            throw new Error(`${key}/${sourceId}: exact span override is absent or ambiguous`);
          }
          const span = {
            start,
            end: endStart + exact.end_text.length,
            text: source.text.slice(start, endStart + exact.end_text.length),
          };
          rankedSources.push({
            source,
            span,
            scoring: scoreSpan({
              span,
              proposition: propositionEntry.proposition,
              context,
              overrideQuery,
              section: `${source.title || ""} ${source.section || ""}`,
            }),
            exact_span_override: true,
          });
        }
        continue;
      }
      let best = null;
      for (const span of sourceSegments(source.text)) {
        const scoring = scoreSpan({
          span,
          proposition: propositionEntry.proposition,
          context,
          overrideQuery,
          section: `${source.title || ""} ${source.section || ""}`,
        });
        const candidate = { source, span, scoring };
        if (
          !best ||
          candidate.scoring.signal_hits.length > best.scoring.signal_hits.length ||
          (candidate.scoring.signal_hits.length === best.scoring.signal_hits.length &&
            candidate.scoring.raw > best.scoring.raw) ||
          (candidate.scoring.signal_hits.length === best.scoring.signal_hits.length &&
            candidate.scoring.raw === best.scoring.raw &&
            candidate.scoring.density > best.scoring.density) ||
          (candidate.scoring.signal_hits.length === best.scoring.signal_hits.length &&
            candidate.scoring.raw === best.scoring.raw &&
            candidate.scoring.density === best.scoring.density &&
            candidate.span.text.length < best.span.text.length) ||
          (candidate.scoring.signal_hits.length === best.scoring.signal_hits.length &&
            candidate.scoring.raw === best.scoring.raw &&
            candidate.scoring.density === best.scoring.density &&
            candidate.span.text.length === best.span.text.length &&
            candidate.span.start < best.span.start)
        ) {
          best = candidate;
        }
      }
      if (best) rankedSources.push(best);
    }
    rankedSources.sort(
      (left, right) =>
        right.scoring.signal_hits.length - left.scoring.signal_hits.length ||
        right.scoring.raw - left.scoring.raw ||
        right.scoring.density - left.scoring.density ||
        left.span.text.length - right.span.text.length ||
        left.source.source_id.localeCompare(right.source.source_id),
    );
    // The frozen owner-reviewed mapping is the provenance boundary. A
    // deterministic lexical score may choose spans within those sources, but it
    // must not silently discard one of several mapped sources. Only a named,
    // proposition-specific reviewed source-selection override may narrow them.
    const requireAllSources = sourceIdsToReview.length > 1;
    const selectedSourceIds = requireAllSources
      ? new Set(sourceIdsToReview)
      : new Set(rankedSources.length ? [rankedSources[0].source.source_id] : []);
    const selected = rankedSources.filter((candidate) =>
      selectedSourceIds.has(candidate.source.source_id),
    );
    const requiredSignal = Math.min(
      2,
      Math.max(1, uniqueTerms(overrideQuery || propositionEntry.proposition).length),
    );
    const viable = selected.filter(
      (candidate) =>
        candidate.exact_span_override === true ||
        candidate.scoring.signal_hits.length >= requiredSignal,
    );
    const viableSourceIds = new Set(
      viable.map((candidate) => candidate.source.source_id),
    );
    if (
      !viable.length ||
      [...selectedSourceIds].some((sourceId) => !viableSourceIds.has(sourceId))
    ) {
      unmappable.push({
        training_id: item.training_id,
        proposition: propositionEntry.proposition,
        support_relationship: propositionEntry.support_relationship,
        mapped_source_ids: propositionEntry.source_ids,
        source_selection_override: sourceSelectionOverride,
        override_query: overrideQuery,
        minimum_required_signal_hits: requiredSignal,
        ranked_sources: rankedSources.map((candidate) => ({
          source_id: candidate.source.source_id,
          start: candidate.span.start,
          end: candidate.span.end,
          excerpt: candidate.span.text,
          scoring: candidate.scoring,
          exact_span_override: candidate.exact_span_override === true,
        })),
        reason: "no_non_forced_verbatim_excerpt_for_every_required_source",
      });
      continue;
    }
    const selectionKeys = [];
    for (const candidate of viable) {
      const selectionKey = `${candidate.source.source_id}:${candidate.span.start}:${candidate.span.end}`;
      selectionKeys.push(selectionKey);
      selections.push({
        selection_key: selectionKey,
        parent_source_id: candidate.source.source_id,
        full_source_sha256: candidate.source.content_sha256,
        start: candidate.span.start,
        end: candidate.span.end,
        text: candidate.span.text,
        excerpt_sha256: contentHash(candidate.span.text),
        scoring: candidate.scoring,
        minimum_required_signal_hits: requiredSignal,
        exact_span_override: candidate.exact_span_override === true,
        selection_method: overrideQuery
          ? candidate.offset_hash_override
            ? "owner_authorised_substantive_audit_hash_bound_exact_offset_override"
            : candidate.exact_span_override
            ? "owner_authorised_developer_exact_verbatim_span_override"
            : "owner_authorised_developer_query_override_then_deterministic_verbatim_span_score"
          : candidate.offset_hash_override
            ? "owner_authorised_substantive_audit_hash_bound_exact_offset_override"
            : candidate.exact_span_override
            ? "owner_authorised_developer_exact_verbatim_span_override"
            : "owner_authorised_developer_mapping_then_deterministic_verbatim_span_score",
      });
    }
    itemMappings.push({
      training_id: item.training_id,
      proposition: propositionEntry.proposition,
      support_relationship: propositionEntry.support_relationship,
      original_source_ids: propositionEntry.source_ids,
      selected_parent_source_ids: [
        ...new Set(viable.map((candidate) => candidate.source.source_id)),
      ],
      selection_keys: selectionKeys,
      excerpt_ids: [],
      override_query: overrideQuery,
      minimum_required_signal_hits: requiredSignal,
      source_selection_override: sourceSelectionOverride,
      span_recommendation_source:
        item.cohort === "wave_2"
          ? paths.wave2SpanRecommendations
          : paths.wave3SpanRecommendations,
      span_recommendation_sha256:
        item.cohort === "wave_2"
          ? sha(paths.wave2SpanRecommendations)
          : sha(paths.wave3SpanRecommendations),
      span_recommendation_mapping_index:
        auditedSpanRecommendation.mapping_index,
      independent_legal_approval: false,
    });
  }
  const uniqueSelections = new Map();
  for (const selection of selections) {
    if (!uniqueSelections.has(selection.selection_key)) {
      uniqueSelections.set(selection.selection_key, selection);
    }
  }
  const itemExcerpts = [...uniqueSelections.values()]
    .sort(
      (left, right) =>
        left.parent_source_id.localeCompare(right.parent_source_id) ||
        left.start - right.start ||
        left.end - right.end,
    )
    .map((selection) => ({
      ...selection,
      excerpt_id: `x${(nextExcerpt++).toString(36)}`,
    }));
  const excerptIdByKey = new Map(
    itemExcerpts.map((entry) => [entry.selection_key, entry.excerpt_id]),
  );
  for (const mapping of itemMappings) {
    mapping.excerpt_ids = mapping.selection_keys.map((key) => excerptIdByKey.get(key));
    delete mapping.selection_keys;
  }
  const targetAnswer = insertMarkers(item.ideal_answer, itemMappings);
  const targetCitationIds = citationIds(targetAnswer);
  const compactEvidence = itemExcerpts.map((entry) => {
    const parent = sourceById.get(entry.parent_source_id);
    return {
      source_id: entry.excerpt_id,
      parent_source_id: entry.parent_source_id,
      source_role: parent.source_role,
      jurisdiction: parent.jurisdiction,
      authority_family: parent.authority_family,
      text: entry.text,
      excerpt_sha256: entry.excerpt_sha256,
    };
  });
  excerptEntries.push(
    ...itemExcerpts.map((entry) => ({
      training_id: item.training_id,
      excerpt_id: entry.excerpt_id,
      parent_source_id: entry.parent_source_id,
      full_source_sha256: entry.full_source_sha256,
      start: entry.start,
      end: entry.end,
      text: entry.text,
      excerpt_sha256: entry.excerpt_sha256,
      selection_method: entry.selection_method,
      minimum_required_signal_hits: entry.minimum_required_signal_hits,
      exact_span_override: entry.exact_span_override,
      scoring: entry.scoring,
    })),
  );
  mappingEntries.push(...itemMappings);
  compactItems.push({
    ...item,
    compact_render_mode: "verbatim_offset_bound_excerpts",
    compact_target_answer: targetAnswer,
    compact_target_citation_ids: targetCitationIds,
    compact_retrieved_evidence: compactEvidence,
    compact_proposition_mappings: itemMappings,
  });
}

const excerptStructuralChecks = excerptEntries.map((entry) => {
  const full = fullSourceMap.get(entry.parent_source_id);
  const trimmed = entry.text.trim();
  const prior = entry.start > 0 ? full?.full_text[entry.start - 1] || "" : "";
  const priorNonWhitespace =
    full?.full_text.slice(0, entry.start).match(/\S(?=\s*$)/)?.[0] || "";
  const first = trimmed[0] || "";
  const last = trimmed.at(-1) || "";
  const rawFirst = entry.text[0] || "";
  const rawLast = entry.text.at(-1) || "";
  const following =
    full && entry.end < full.full_text.length ? full.full_text[entry.end] : "";
  // Normalised legislation chunks can contain a Markdown heading followed by
  // the entire provision on the same physical line. Treat only a genuinely
  // short heading as heading-only; a multi-thousand-character statutory
  // provision must instead be judged by its clause boundaries below.
  const markdownHeadingOnly =
    trimmed.length <= 240 && /^#{1,6}\s+[^\n]+$/.test(trimmed);
  const plainHeadingLike =
    trimmed.length < 100 &&
    !trimmed.includes("\n") &&
    !/[.!?;:]$/.test(trimmed) &&
    !/^(?:[-*|]|\(\d+[A-Za-z]?\))/.test(trimmed);
  // Whitespace deliberately retained at an exact offset is a real lexical
  // boundary. Comparing the trimmed first/last characters to the parent byte
  // immediately outside the span falsely classified excerpts ending in a
  // newline before the next paragraph as mid-word.
  const startsMidWord =
    /[\p{L}\p{N}]/u.test(prior) && /[\p{L}\p{N}]/u.test(rawFirst);
  const endsMidWord =
    /[\p{L}\p{N}]/u.test(rawLast) && /[\p{L}\p{N}]/u.test(following);
  const parentRemainder = full?.full_text.slice(entry.end).trimStart() || "";
  const trailingOpenClause =
    /,$/.test(trimmed) ||
    /\b(?:and|or|the|of|to|against|with|for|under)$/i.test(trimmed) ||
    // A colon is only a complete boundary when the parent source has no
    // following content. Otherwise it normally introduces conditions or a
    // list which the excerpt has omitted.
    (/:$/.test(trimmed) && Boolean(parentRemainder)) ||
    (/;$/.test(trimmed) &&
      /^(?:and\b|or\b|[-*•]|\(?[a-z0-9]+\)?[.)])/i.test(parentRemainder));
  const unexplainedLowercaseStart =
    entry.start > 0 && /^[a-z]/.test(first) && !/[.!?;:]/.test(priorNonWhitespace);
  const lastNonemptyLine = trimmed.split(/\r?\n/).filter(Boolean).at(-1) || "";
  const structurallyCompleteEnding =
    /[.!?;:]$/.test(trimmed) ||
    /^(?:[-*|]|\(\d+[A-Za-z]?\))/.test(trimmed) ||
    /^(?:[-*|]|\(\d+[A-Za-z]?\))/.test(lastNonemptyLine) ||
    (entry.exact_span_override === true &&
      /(?:^|\n)\d+\.\s*[^\n]+/.test(trimmed) &&
      /(?:^|\n)[a-z]\.\s*[^\n]+/.test(trimmed) &&
      !trailingOpenClause &&
      !endsMidWord) ||
    entry.end === full?.full_text.length;
  const lowSignal =
    entry.exact_span_override !== true &&
    (entry.scoring?.signal_hits?.length || 0) < entry.minimum_required_signal_hits;
  const checks = {
    not_heading_only: !markdownHeadingOnly && !plainHeadingLike,
    not_mid_word: !startsMidWord && !endsMidWord,
    no_open_trailing_clause: !trailingOpenClause,
    no_unexplained_lowercase_fragment: !unexplainedLowercaseStart,
    structurally_complete_ending: structurallyCompleteEnding,
    exact_reviewed_complete_list_or_ordinary_ending: structurallyCompleteEnding,
    minimum_review_signal_or_exact_override: !lowSignal,
    minimum_substantive_length: trimmed.length >= 25,
  };
  return {
    excerpt_id: entry.excerpt_id,
    training_id: entry.training_id,
    parent_source_id: entry.parent_source_id,
    start: entry.start,
    end: entry.end,
    passed: Object.values(checks).every(Boolean),
    checks,
    text: entry.text,
    selection_method: entry.selection_method,
  };
});
const weakExcerpts = excerptStructuralChecks.filter((entry) => !entry.passed);

if (unmappable.length || weakExcerpts.length) {
  mkdirSync(ROOT, { recursive: true });
  writeJson(resolve(ROOT, "provisional-compact-evidence-selection.json"), {
    version: "cumulative-visible-provisional-compact-evidence-selection-v1",
    generated_at: new Date().toISOString(),
    passed: false,
    training_authorised: false,
    unseen_accessed: false,
    resolved_proposition_count: mappingEntries.length,
    verbatim_excerpt_count: excerptEntries.length,
    unresolved_proposition_count: unmappable.length,
    structurally_weak_excerpt_count: weakExcerpts.length,
    proposition_mappings: mappingEntries,
    excerpts: excerptEntries,
    excerpt_structural_checks: excerptStructuralChecks,
    unmappable,
    weak_excerpts: weakExcerpts,
    limitation:
      "Provisional read-only review aid. It is deliberately not a candidate manifest or training dataset and cannot authorise export or training.",
  });
  writeJson(resolve(ROOT, "unmappable-propositions.json"), {
    version: "cumulative-visible-compact-unmappable-propositions-v1",
    generated_at: new Date().toISOString(),
    passed: false,
    training_authorised: false,
    unseen_accessed: false,
    count: unmappable.length,
    items: unmappable,
  });
  writeJson(resolve(ROOT, "weak-compact-excerpts.json"), {
    version: "cumulative-visible-weak-compact-excerpts-v1",
    generated_at: new Date().toISOString(),
    passed: weakExcerpts.length === 0,
    training_authorised: false,
    unseen_accessed: false,
    counts: {
      total_excerpts: excerptEntries.length,
      weak_excerpts: weakExcerpts.length,
      heading_only: weakExcerpts.filter(
        (entry) => !entry.checks.not_heading_only,
      ).length,
      mid_word: weakExcerpts.filter((entry) => !entry.checks.not_mid_word).length,
      open_trailing_clause: weakExcerpts.filter(
        (entry) => !entry.checks.no_open_trailing_clause,
      ).length,
      lowercase_fragment: weakExcerpts.filter(
        (entry) => !entry.checks.no_unexplained_lowercase_fragment,
      ).length,
      incomplete_ending: weakExcerpts.filter(
        (entry) => !entry.checks.structurally_complete_ending,
      ).length,
      low_signal: weakExcerpts.filter(
        (entry) => !entry.checks.minimum_review_signal_or_exact_override,
      ).length,
    },
    items: weakExcerpts,
  });
  throw new Error(
    `${unmappable.length} proposition mappings are unmappable and ${weakExcerpts.length} excerpts fail structural retention checks; see provisional reports`,
  );
}
writeJson(resolve(ROOT, "unmappable-propositions.json"), {
  version: "cumulative-visible-compact-unmappable-propositions-v1",
  generated_at: new Date().toISOString(),
  passed: true,
  training_authorised: false,
  unseen_accessed: false,
  count: 0,
  items: [],
});
writeJson(resolve(ROOT, "weak-compact-excerpts.json"), {
  version: "cumulative-visible-weak-compact-excerpts-v1",
  generated_at: new Date().toISOString(),
  passed: true,
  training_authorised: false,
  unseen_accessed: false,
  counts: {
    total_excerpts: excerptEntries.length,
    weak_excerpts: 0,
    heading_only: 0,
    mid_word: 0,
    open_trailing_clause: 0,
    lowercase_fragment: 0,
    incomplete_ending: 0,
    low_signal: 0,
  },
  items: [],
});

const excerptById = new Map(excerptEntries.map((entry) => [entry.excerpt_id, entry]));
const excerptChecks = excerptEntries.map((entry) => {
  const full = fullSourceMap.get(entry.parent_source_id);
  const exactSlice = full?.full_text.slice(entry.start, entry.end);
  return {
    excerpt_id: entry.excerpt_id,
    training_id: entry.training_id,
    passed:
      Boolean(full) &&
      full.full_content_sha256 === entry.full_source_sha256 &&
      exactSlice === entry.text &&
      contentHash(entry.text) === entry.excerpt_sha256,
    parent_source_present: Boolean(full),
    full_source_hash_matches: full?.full_content_sha256 === entry.full_source_sha256,
    exact_character_slice_matches: exactSlice === entry.text,
    excerpt_hash_matches: contentHash(entry.text) === entry.excerpt_sha256,
    structural_retention_check_passed:
      excerptStructuralChecks.find((check) => check.excerpt_id === entry.excerpt_id)
        ?.passed === true,
  };
});
const propositionChecks = mappingEntries.map((mapping) => ({
  training_id: mapping.training_id,
  proposition: mapping.proposition,
  passed:
    mapping.excerpt_ids.length > 0 &&
    mapping.excerpt_ids.every((excerptId) => excerptById.has(excerptId)),
  excerpt_ids: mapping.excerpt_ids,
  support_relationship: mapping.support_relationship,
  independent_legal_approval: false,
}));
if (
  !excerptChecks.every((entry) => entry.passed) ||
  !propositionChecks.every((entry) => entry.passed)
) {
  throw new Error("Compact excerpt offset/hash or proposition coverage audit failed");
}

const copiedIndependentVisibleAuditPath = resolve(
  ROOT,
  "independent-agent-audits/independent-agent-visible-technical-legal-semantic-audit-v1.json",
);
const copiedIndependentVisibleReportPath = resolve(
  ROOT,
  "independent-agent-audits/INDEPENDENT-AGENT-VISIBLE-TECHNICAL-LEGAL-SEMANTIC-AUDIT-v1.md",
);
mkdirSync(dirname(copiedIndependentVisibleAuditPath), { recursive: true });
writeFileSync(
  copiedIndependentVisibleAuditPath,
  readBytes(paths.independentVisibleAudit),
  { flag: "wx" },
);
writeFileSync(
  copiedIndependentVisibleReportPath,
  readBytes(paths.independentVisibleReport),
  { flag: "wx" },
);

const compactItemRegister = {
  ...upstreamItems,
  version: "cumulative-visible-compact-item-register-v1",
  generated_at: new Date().toISOString(),
  status: "owner_authorised_development_compact_candidate_not_training_approved",
  training_authorised: false,
  release_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  upstream_bindings: {
    item_register_sha256: sha(paths.upstreamItems),
    source_register_sha256: sha(paths.upstreamSources),
    global_allocation_sha256: sha(paths.upstreamAllocation),
    contamination_preflight_sha256: sha(paths.upstreamContamination),
    clean_checkpoint_provenance_sha256: sha(paths.upstreamProvenance),
    owner_development_authorisation_sha256: sha(paths.upstreamOwner),
    wave_2_span_recommendations_sha256: sha(paths.wave2SpanRecommendations),
    wave_3_span_recommendations_sha256: sha(paths.wave3SpanRecommendations),
    topic_coverage_feasibility_sha256: sha(paths.topicCoverageFeasibility),
    independent_visible_development_audit_sha256: sha(
      copiedIndependentVisibleAuditPath,
    ),
    independent_visible_development_report_sha256: sha(
      copiedIndependentVisibleReportPath,
    ),
    compact_renderer_sha256: sha(paths.compactRenderer),
    full_qualification_builder_sha256: sha(paths.fullPrepare),
  },
  items: compactItems,
};
mkdirSync(ROOT, { recursive: true });
const topicCoveragePath = resolve(
  ROOT,
  "global-visible-topic-coverage-feasibility.json",
);
writeFileSync(topicCoveragePath, readBytes(paths.topicCoverageFeasibility));
writeJson(resolve(ROOT, "cumulative-visible-item-register.json"), compactItemRegister);
const itemRegisterPath = resolve(ROOT, "cumulative-visible-item-register.json");

const fullSourceRegister = {
  version: "cumulative-visible-full-source-register-with-compact-offset-map-v1",
  generated_at: new Date().toISOString(),
  status: "full_frozen_sources_preserved_compact_excerpts_owner_development_review_only",
  training_authorised: false,
  release_authorised: false,
  unseen_accessed: false,
  item_register_sha256: sha(itemRegisterPath),
  upstream_source_register_sha256: sha(paths.upstreamSources),
  source_count: fullSourceMap.size,
  identity_conflicts: fullSourceConflicts,
  sources: [...fullSourceMap.values()]
    .map((source) => {
      const { _full_source_identity: identity, ...preservedSource } = source;
      return {
        ...preservedSource,
        source_identity_sha256: contentHash(identity),
        used_by: [...new Set(source.used_by)].sort(),
      };
    })
    .sort((left, right) => left.source_id.localeCompare(right.source_id)),
};
writeJson(resolve(ROOT, "cumulative-visible-source-register.json"), fullSourceRegister);
const sourceRegisterPath = resolve(ROOT, "cumulative-visible-source-register.json");

const compactEvidenceMap = {
  version: "cumulative-visible-compact-verbatim-evidence-map-v1",
  generated_at: new Date().toISOString(),
  status:
    "mechanical_offset_and_structural_checks_passed_substantive_retention_audits_pending",
  passed: excerptChecks.every((entry) => entry.passed) && propositionChecks.every((entry) => entry.passed),
  training_authorised: false,
  release_authorised: false,
  independent_legal_approval: false,
  unseen_accessed: false,
  item_register_sha256: sha(itemRegisterPath),
  full_source_register_sha256: sha(sourceRegisterPath),
  span_recommendation_bindings: {
    wave_2_sha256: sha(paths.wave2SpanRecommendations),
    wave_3_sha256: sha(paths.wave3SpanRecommendations),
    recommendation_count: validatedSpanRecommendationByKey.size,
    status: "fail_closed_span_selection_inputs_not_final_pass_audits",
  },
  independent_visible_development_review: {
    status: independentVisibleAudit.status,
    passed: independentVisibleAudit.passed,
    scope: "52_repaired_wave_2_3_visible_items_and_195_proposition_source_mappings",
    independent_legal_advice: false,
    release_authorised: false,
    sealed_unseen_authorised: false,
    audit_sha256: sha(copiedIndependentVisibleAuditPath),
    report_sha256: sha(copiedIndependentVisibleReportPath),
    repaired_v8_pack_sha256: sha(paths.repairedV8Pack),
    repaired_v8_application_audit_sha256: sha(
      paths.repairedV8ApplicationAudit,
    ),
    counts: independentVisibleAudit.counts,
  },
  topic_coverage_feasibility_sha256: sha(paths.topicCoverageFeasibility),
  compact_renderer: {
    path: COMPACT_RENDERER_PATH,
    sha256: sha(paths.compactRenderer),
  },
  counts: {
    repaired_wave_2_3_items: compactItems.filter((item) => item.cohort !== "v1").length,
    mapped_propositions: mappingEntries.length,
    verbatim_excerpts: excerptEntries.length,
    unmappable_propositions: 0,
    offset_or_hash_failures: excerptChecks.filter((entry) => !entry.passed).length,
  },
  proposition_checks: propositionChecks,
  excerpt_checks: excerptChecks,
  proposition_mappings: mappingEntries,
  excerpts: excerptEntries,
  limitations: [
    "Selection is an owner-authorised developer candidate, not completed Wave 2–3 substantive-retention review or independent legal entailment approval.",
    "Every excerpt is a contiguous verbatim slice; omitted surrounding text is preserved in the bound full-source register and no ellipsis or bridging text is inserted.",
    "Independent review must check whether each compact span retains every legally material condition before release.",
  ],
};
writeJson(resolve(ROOT, "compact-evidence-map.json"), compactEvidenceMap);
const compactEvidenceMapPath = resolve(ROOT, "compact-evidence-map.json");

const compactItemById = new Map(
  compactItems.map((item) => [item.training_id, item]),
);
const compactIsolationItem = (item) => ({
  training_id: item.training_id,
  construct_id: item.canonical_construct,
  retrieved_evidence: (item.compact_retrieved_evidence || []).map((source) => ({
    ...source,
    // Excerpt IDs are unique rendering IDs. Parent IDs retain the legal-source
    // identity needed for a meaningful cross-partition isolation check.
    source_id: source.parent_source_id || source.source_id,
  })),
});
const compactPartitionIsolation = auditTrainingPartitionIsolation(
  upstreamAllocation.train.ids.map((id) =>
    compactIsolationItem(compactItemById.get(id)),
  ),
  upstreamAllocation.validation.ids.map((id) =>
    compactIsolationItem(compactItemById.get(id)),
  ),
);
if (!compactPartitionIsolation.passed) {
  throw new Error(
    `Compact parent-source/text/authority/construct isolation failed: ${JSON.stringify(compactPartitionIsolation)}`,
  );
}

const allocation = {
  ...upstreamAllocation,
  version: "cumulative-visible-global-allocation-compact-v1",
  generated_at: new Date().toISOString(),
  status: "owner_authorised_development_global_visible_split_mechanically_isolated",
  training_authorised: false,
  release_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  item_register_sha256: sha(itemRegisterPath),
  source_register_sha256: sha(sourceRegisterPath),
  compact_evidence_map_sha256: sha(compactEvidenceMapPath),
  upstream_allocation_sha256: sha(paths.upstreamAllocation),
  wave_2_span_recommendations_sha256: sha(paths.wave2SpanRecommendations),
  wave_3_span_recommendations_sha256: sha(paths.wave3SpanRecommendations),
  independent_visible_development_audit_sha256: sha(
    copiedIndependentVisibleAuditPath,
  ),
  independent_visible_development_report_sha256: sha(
    copiedIndependentVisibleReportPath,
  ),
  topic_coverage_feasibility_sha256: sha(paths.topicCoverageFeasibility),
  compact_renderer_sha256: sha(paths.compactRenderer),
  compact_partition_isolation: compactPartitionIsolation,
};
writeJson(resolve(ROOT, "global-visible-allocation-draft.json"), allocation);
const allocationPath = resolve(ROOT, "global-visible-allocation-draft.json");

const itemById = compactItemById;
const compactSystem = [
  "Use only supplied evidence.",
  "Return JSON with answer and citation_ids.",
  "Cite claims inline and mirror marker IDs exactly in citation_ids.",
  "Never invent law, facts, citations or actions; state gaps.",
].join(" ");
const renderRow = (item) => {
  if (item.cohort === "v1") {
    const internalControls = item.retrieved_evidence
      .filter(
        (source) =>
          source.user_visible === false ||
          ["system_policy", "internal_hidden"].includes(source.source_role),
      )
      .map((source) => source.text);
    const evidence = item.retrieved_evidence
      .filter(
        (source) =>
          source.user_visible !== false &&
          !["system_policy", "internal_hidden"].includes(source.source_role),
      )
      .map((source) => ({ source_id: source.source_id, text: source.text }));
    return {
      messages: [
        {
          role: "system",
          content: [compactSystem, ...internalControls.map((text) => `Control: ${text}`)].join(
            "\n",
          ),
        },
        {
          role: "user",
          content: JSON.stringify({
            question: item.user_question,
            context: item.conversation_context,
            fixture: item.synthetic_fixture,
            evidence,
          }),
        },
        {
          role: "assistant",
          content: JSON.stringify({
            answer: item.compact_target_answer,
            citation_ids: item.compact_target_citation_ids,
          }),
        },
      ],
      metadata: {
        training_id: item.training_id,
        cohort: item.cohort,
        topic: item.topic,
        canonical_construct: item.canonical_construct,
        review_only_candidate: true,
        owner_authorised_development: true,
        independent_legal_review: false,
        training_authorised: false,
        evidence_render_mode: item.compact_render_mode,
      },
    };
  }
  return {
    messages: [
      { role: "system", content: compactSystem },
      {
        role: "user",
        content: JSON.stringify({
          question: item.user_question,
          evidence: item.compact_retrieved_evidence.map((source) => ({
            source_id: source.source_id,
            text: source.text,
          })),
        }),
      },
      {
        role: "assistant",
        content: JSON.stringify({
          answer: item.compact_target_answer,
          citation_ids: item.compact_target_citation_ids,
        }),
      },
    ],
    metadata: {
      training_id: item.training_id,
      cohort: item.cohort,
      topic: item.topic,
      canonical_construct: item.canonical_construct,
      review_only_candidate: true,
      owner_authorised_development: true,
      independent_legal_review: false,
      training_authorised: false,
      evidence_render_mode: item.compact_render_mode,
      compact_evidence_map_sha256: sha(compactEvidenceMapPath),
    },
  };
};
const trainRows = allocation.train.ids.map((id) => renderRow(itemById.get(id)));
const validationRows = allocation.validation.ids.map((id) => renderRow(itemById.get(id)));
const allRows = [...trainRows, ...validationRows];
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const trainJsonl = jsonl(trainRows);
const validationJsonl = jsonl(validationRows);

const targetContractChecks = allRows.map((row) => {
  const item = itemById.get(row.metadata.training_id);
  const prompt = row.messages.slice(0, -1).map((message) => message.content).join("\n");
  const user = JSON.parse(row.messages.at(-2).content);
  const target = JSON.parse(row.messages.at(-1).content);
  const evidenceIds = new Set((user.evidence || []).map((source) => source.source_id));
  const markerIds = citationIds(target.answer);
  const expectedIds = item.compact_target_citation_ids;
  const substantial = normalise(target.answer).split(" ").length >= 12;
  return {
    training_id: item.training_id,
    passed:
      Object.keys(target).sort().join(",") === "answer,citation_ids" &&
      Array.isArray(target.citation_ids) &&
      target.citation_ids.length === new Set(target.citation_ids).size &&
      sameOrderedUniqueValues(markerIds, target.citation_ids) &&
      sameOrderedUniqueValues(target.citation_ids, expectedIds) &&
      target.citation_ids.every((sourceId) => evidenceIds.has(sourceId)) &&
      !/\{\{cite:[^}]+\}\}/.test(prompt) &&
      !(substantial && normalise(prompt).includes(normalise(target.answer))),
    marker_ids: markerIds,
    citation_ids: target.citation_ids,
    expected_ids: expectedIds,
    supplied_evidence_ids: [...evidenceIds],
    markers_absent_from_prompt: !/\{\{cite:[^}]+\}\}/.test(prompt),
    target_not_in_prompt: !(substantial && normalise(prompt).includes(normalise(target.answer))),
  };
});
const echoAudit = auditTrainingRows(allRows);
const contaminationPassed =
  echoAudit.passed &&
  targetContractChecks.every((entry) => entry.passed) &&
  excerptChecks.every((entry) => entry.passed) &&
  propositionChecks.every((entry) => entry.passed) &&
  compactPartitionIsolation.passed;
if (!contaminationPassed) {
  throw new Error("Compact rendered target/echo/evidence contract failed");
}

mkdirSync(CANDIDATE_ROOT, { recursive: true });
writeText(resolve(CANDIDATE_ROOT, "train.review.jsonl"), trainJsonl);
writeText(resolve(CANDIDATE_ROOT, "valid.review.jsonl"), validationJsonl);

const contamination = {
  version: "cumulative-visible-compact-contamination-and-echo-preflight-v1",
  generated_at: new Date().toISOString(),
  status: "mechanical_compact_visible_preflight_passed_token_preflight_pending",
  passed: contaminationPassed,
  scope: "94_visible_training_candidates_only",
  training_authorised: false,
  release_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  item_register_sha256: sha(itemRegisterPath),
  allocation_sha256: sha(allocationPath),
  compact_evidence_map_sha256: sha(compactEvidenceMapPath),
  wave_2_span_recommendations_sha256: sha(paths.wave2SpanRecommendations),
  wave_3_span_recommendations_sha256: sha(paths.wave3SpanRecommendations),
  independent_visible_development_audit_sha256: sha(
    copiedIndependentVisibleAuditPath,
  ),
  independent_visible_development_report_sha256: sha(
    copiedIndependentVisibleReportPath,
  ),
  topic_coverage_feasibility_sha256: sha(paths.topicCoverageFeasibility),
  compact_renderer_sha256: sha(paths.compactRenderer),
  answer_input_echo: echoAudit,
  json_target_contract_checks: targetContractChecks,
  excerpt_offset_and_hash_checks: excerptChecks,
  proposition_excerpt_coverage_checks: propositionChecks,
  compact_partition_isolation: compactPartitionIsolation,
  protected_comparison:
    "Pending with the authorised custodian; sealed questions and answers were neither included nor accessed.",
};
writeJson(resolve(ROOT, "contamination-and-echo-preflight.json"), contamination);
const contaminationPath = resolve(ROOT, "contamination-and-echo-preflight.json");

const candidateManifest = {
  version: "cumulative-visible-rendered-compact-review-candidate-v1",
  generated_at: new Date().toISOString(),
  status: "review_only_non_trainable_candidate",
  training_authorised: false,
  release_authorised: false,
  independent_legal_review: false,
  final_mlx_filenames_present: false,
  completion_target_contract:
    "json_answer_with_inline_markers_and_exact_mirrored_compact_excerpt_ids",
  item_register_sha256: sha(itemRegisterPath),
  allocation_sha256: sha(allocationPath),
  contamination_preflight_sha256: sha(contaminationPath),
  compact_evidence_map_sha256: sha(compactEvidenceMapPath),
  independent_visible_development_audit_sha256: sha(
    copiedIndependentVisibleAuditPath,
  ),
  independent_visible_development_report_sha256: sha(
    copiedIndependentVisibleReportPath,
  ),
  compact_renderer_sha256: sha(paths.compactRenderer),
  train: {
    count: trainRows.length,
    filename: "train.review.jsonl",
    sha256: contentHash(trainJsonl),
  },
  validation: {
    count: validationRows.length,
    filename: "valid.review.jsonl",
    sha256: contentHash(validationJsonl),
  },
  blocked_final_files: ["train.jsonl", "valid.jsonl", "dataset-manifest.json"],
  reason:
    "Review-only compact rendering. Exact tokenizer/loss-mask preflight and final hash-bound export remain mandatory.",
};
writeJson(resolve(CANDIDATE_ROOT, "candidate-manifest.json"), candidateManifest);
const candidateManifestPath = resolve(CANDIDATE_ROOT, "candidate-manifest.json");

const configText = readFileSync(CONFIG_PATH, "utf8");
const configNumber = (key) =>
  Number(configText.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m"))?.[1]);
const runnerText = readFileSync(RUNNER_PATH, "utf8");
const wrapperText = readFileSync(TRAINING_WRAPPER_PATH, "utf8");
const compactProvenanceChecks = {
  upstream_clean_base_identity_passed: upstreamProvenance.passed === true,
  clean_start_has_no_historical_adapter:
    upstreamProvenance.clean_start_policy?.resume_adapter === null &&
    upstreamProvenance.clean_start_policy?.historical_v1_wave2_wave3_adapters_used === false,
  completion_only_loss_enabled: /^mask_prompt:\s*true\s*$/m.test(configText),
  explicit_measured_context_limit:
    configNumber("max_seq_length") === 2112,
  exact_three_pass_iteration_count:
    configNumber("iters") === allocation.train.count * 3,
  checkpoint_saved_at_every_validation_interval:
    configNumber("steps_per_eval") > 0 &&
    configNumber("save_every") === configNumber("steps_per_eval"),
  wrapper_accepts_explicit_task_config:
    /PENSION_TRAINING_CONFIG/.test(wrapperText) &&
    /--config\s+"\$\{config_path\}"/.test(wrapperText),
  cumulative_runner_dispatches_bound_config:
    /PENSION_TRAINING_CONFIG:\s*CONFIG/.test(runnerText),
  checkpoint_selector_present: existsSync(CHECKPOINT_SELECTOR_PATH),
  longest_row_memory_smoke_runner_present: existsSync(
    MEMORY_SMOKE_RUNNER_PATH,
  ),
  compact_renderer_hash_recorded: /^[a-f0-9]{64}$/.test(
    sha(paths.compactRenderer),
  ),
  runner_declares_no_resume_adapter: !/resume-adapter|resume_adapter/i.test(runnerText),
};
const provenance = {
  ...upstreamProvenance,
  version: "cumulative-visible-compact-clean-checkpoint-provenance-v1",
  generated_at: new Date().toISOString(),
  status: Object.values(compactProvenanceChecks).every(Boolean)
    ? "clean_base_and_exact_training_dispatch_verified_training_not_started"
    : "training_dispatch_provenance_failed",
  passed: Object.values(compactProvenanceChecks).every(Boolean),
  training_started: false,
  training_authorised: false,
  config: {
    ...upstreamProvenance.config,
    path: CONFIG_PATH,
    sha256: sha(paths.config),
    max_sequence_length: configNumber("max_seq_length"),
    context_change_reason:
      "Raised from 2048 to 2112 only after exact pinned-MLX preflight measured one complete overseas-transition row at 2066 tokens; legally material clauses were preserved and the longest-row memory smoke remains mandatory.",
  },
  runner: { path: RUNNER_PATH, sha256: sha(paths.runner) },
  training_wrapper: {
    path: TRAINING_WRAPPER_PATH,
    sha256: sha(paths.trainingWrapper),
    explicit_config_environment_variable: "PENSION_TRAINING_CONFIG",
  },
  checkpoint_policy: {
    steps_per_eval: configNumber("steps_per_eval"),
    save_every: configNumber("save_every"),
    selection:
      "lowest validation loss among exact persisted validation-interval checkpoints; ties prefer earlier iteration",
    selector_path: CHECKPOINT_SELECTOR_PATH,
    selector_sha256: sha(paths.checkpointSelector),
    pinned_worker_compatible_output: "checkpoint-selection.json",
  },
  compact_renderer: {
    path: COMPACT_RENDERER_PATH,
    sha256: sha(paths.compactRenderer),
  },
  memory_smoke_runner: {
    path: MEMORY_SMOKE_RUNNER_PATH,
    sha256: sha(paths.memorySmokeRunner),
    policy:
      "one quarantined iteration using the exact longest train row and exact longest validation row; never resume, evaluate or serve the smoke adapter",
  },
  checks: compactProvenanceChecks,
  upstream_provenance_sha256: sha(paths.upstreamProvenance),
  independent_visible_development_review: {
    status: independentVisibleAudit.status,
    audit_sha256: sha(copiedIndependentVisibleAuditPath),
    report_sha256: sha(copiedIndependentVisibleReportPath),
    release_authorised: false,
    unseen_accessed: false,
  },
};
writeJson(resolve(ROOT, "clean-checkpoint-provenance.json"), provenance);
const provenancePath = resolve(ROOT, "clean-checkpoint-provenance.json");

writeJson(resolve(ROOT, "checkpoint-selection-policy.json"), {
  version: "cumulative-visible-checkpoint-selection-policy-v1",
  generated_at: new Date().toISOString(),
  status: "prepared_training_not_started",
  training_started: false,
  selector_path: CHECKPOINT_SELECTOR_PATH,
  selector_sha256: sha(paths.checkpointSelector),
  training_runner_sha256: sha(paths.runner),
  training_wrapper_sha256: sha(paths.trainingWrapper),
  config_sha256: sha(paths.config),
  compact_renderer_path: COMPACT_RENDERER_PATH,
  compact_renderer_sha256: sha(paths.compactRenderer),
  iterations: configNumber("iters"),
  max_sequence_length: configNumber("max_seq_length"),
  steps_per_eval: configNumber("steps_per_eval"),
  save_every: configNumber("save_every"),
  policy:
    "Require a hash-verified saved adapter at every validation interval; select the lowest validation loss and prefer the earlier iteration on an exact tie; copy the selected weights/config into a new immutable directory and emit checkpoint-selection.json for ml/pinned_mlx_worker.py.",
  overwrite_policy: "refuse_nonempty_selected_adapter_or_existing_selection_manifest",
  pre_full_training_memory_gate:
    "After the final qualification gate, run the bound one-iteration quarantined longest-train/longest-validation-row smoke and require peak memory at or below the recorded sub-16-GB ceiling. The full runner refuses to start without its hash-bound pass report.",
  unseen_accessed: false,
});

const owner = {
  version: "cumulative-visible-compact-owner-development-authorisation-v1",
  generated_at: new Date().toISOString(),
  status:
    "owner_authorised_compact_development_path_pending_substantive_retention_audits_and_token_preflight",
  owner_authorisation_recorded: true,
  authorisation_basis:
    "The owner explicitly approved the controlled development path; the parent task separately authorised a versioned verbatim compact-evidence renderer.",
  scope: "controlled_development_training_and_visible_qualification_only",
  conditionally_authorised_after_all_mechanical_gates: true,
  training_authorised_now: false,
  independent_legal_review: false,
  independent_citation_support_review: false,
  release_authorised: false,
  sealed_unseen_execution_authorised_now: false,
  unseen_accessed: false,
  bindings: {
    item_register_sha256: sha(itemRegisterPath),
    source_register_sha256: sha(sourceRegisterPath),
    global_allocation_sha256: sha(allocationPath),
    contamination_preflight_sha256: sha(contaminationPath),
    rendered_candidate_manifest_sha256: sha(candidateManifestPath),
    clean_checkpoint_provenance_sha256: sha(provenancePath),
    compact_evidence_map_sha256: sha(compactEvidenceMapPath),
    wave_2_span_recommendations_sha256: sha(paths.wave2SpanRecommendations),
    wave_3_span_recommendations_sha256: sha(paths.wave3SpanRecommendations),
    topic_coverage_feasibility_sha256: sha(paths.topicCoverageFeasibility),
    compact_renderer_sha256: sha(paths.compactRenderer),
    independent_visible_development_audit_sha256: sha(
      copiedIndependentVisibleAuditPath,
    ),
    independent_visible_development_report_sha256: sha(
      copiedIndependentVisibleReportPath,
    ),
  },
  release_evidence_limit:
    "Independent legal/source review, protected-set custodian comparison, visible evaluation, sealed unseen and a separate release decision remain required for release.",
};
writeJson(resolve(ROOT, "owner-development-authorisation.json"), owner);

const approvalTemplate = {
  version: "cumulative-visible-compact-independent-qualification-approval-v1",
  generated_at: new Date().toISOString(),
  status: "template_not_approved",
  training_authorised: false,
  release_authorised: false,
  unseen_accessed: false,
  bindings: {
    item_register_sha256: sha(itemRegisterPath),
    source_register_sha256: sha(sourceRegisterPath),
    global_allocation_sha256: sha(allocationPath),
    contamination_preflight_sha256: sha(contaminationPath),
    rendered_candidate_manifest_sha256: sha(candidateManifestPath),
    compact_evidence_map_sha256: sha(compactEvidenceMapPath),
    clean_checkpoint_provenance_sha256: sha(provenancePath),
    compact_renderer_sha256: sha(paths.compactRenderer),
    independent_visible_development_audit_sha256: sha(
      copiedIndependentVisibleAuditPath,
    ),
    independent_visible_development_report_sha256: sha(
      copiedIndependentVisibleReportPath,
    ),
    token_and_loss_mask_preflight_sha256: null,
  },
  required_decisions: {
    all_52_repaired_items_independently_approved: false,
    every_compact_excerpt_preserves_material_conditions: false,
    every_material_proposition_support_determined: false,
    exact_citation_ids_inserted_and_approved: false,
    global_94_record_semantic_construct_map_approved: false,
    global_94_record_allocation_approved: false,
    cumulative_visible_rendered_export_approved: false,
    token_length_and_loss_mask_preflight_passed: false,
    clean_base_checkpoint_provenance_approved: false,
    protected_set_custodian_comparison_passed: false,
  },
  independent_reviewer: null,
  approved_at: null,
};
writeJson(resolve(ROOT, "independent-approval-template.json"), approvalTemplate);

writeText(
  resolve(ROOT, "README.md"),
  `# Cumulative visible compact-evidence qualification — v1\n\nStatus: **owner-authorised development candidate; compact Wave 2–3 substantive-retention audits and tokenizer/loss-mask preflight pending; training not started**.\n\nThe bound independent-agent visible technical/legal-semantic audit passed all 52 repaired items and 195 full-source proposition mappings for controlled local development. Its exact JSON and Markdown report are preserved under \`independent-agent-audits/\`. That review is not licensed legal advice and does not authorise release, production use or sealed-unseen evaluation.\n\nThis version preserves all frozen full sources in \`cumulative-visible-source-register.json\`. Every compact passage is a contiguous verbatim slice with a parent source ID, full-source SHA-256, exact character offsets and excerpt SHA-256 in \`compact-evidence-map.json\`. No ellipsis or bridging text is inserted. All ${mappingEntries.length} repaired Wave 2–3 proposition mappings retain at least one mapped excerpt mechanically; the separate compact-retention audits must still establish that each shortened passage preserves every material condition.\n\nThe split remains ${trainRows.length} train / ${validationRows.length} validation across the same 94 visible records. Owner development authorisation is not release approval. Sealed unseen questions and answers were not accessed.\n\nNext gates: complete and hash-bind both full mapping-by-mapping compact substantive-retention audits, then run the installed MLX tokenizer and exact completion-loss-mask preflight at the configured ${configNumber("max_seq_length")}-token maximum. Final export must fail closed unless both audits pass and all 94 targets remain fully supervised. After final qualification, the full runner additionally requires the bound one-iteration quarantined longest-row memory smoke to pass below its sub-16-GB safety ceiling.\n`,
);

console.log(
  JSON.stringify(
    {
      root: ROOT,
      total: compactItems.length,
      train: trainRows.length,
      validation: validationRows.length,
      full_sources: fullSourceMap.size,
      repaired_propositions: mappingEntries.length,
      verbatim_excerpts: excerptEntries.length,
      unmappable_propositions: 0,
      target_contract_passed: targetContractChecks.every((entry) => entry.passed),
      echo_preflight_passed: echoAudit.passed,
      training_authorised: false,
      unseen_accessed: false,
    },
    null,
    2,
  ),
);
