import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditTrainingPartitionIsolation, loadReviewedTrainingItems } from "./lib/trainingEvidenceIntegrity.mjs";

const INPUT = resolve("training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-2/development-question-set.json");
const OUTPUT_ROOT = resolve(process.env.CYCLE_V2_TRAINING_OUTPUT_ROOT || "training-data/private/evaluation-cycle-v2-wave-2-lora");
const REVIEW_ROOT = resolve(process.env.CYCLE_V2_TRAINING_REVIEW_ROOT || "training/evaluation-cycle-v2/02-wave-2-execution/training");
const pack = JSON.parse(readFileSync(INPUT, "utf8"));
const candidates = pack.topics.flatMap((topic) => topic.training_candidates.map((item) => ({ ...item, topic_id: topic.topic_id })));
const reviewed = loadReviewedTrainingItems(resolve(process.env.CYCLE_V2_TRAINING_REVIEW_PATH || `${REVIEW_ROOT}/reviewed-source-training-items.json`), candidates, {
  reviewReturnPath:resolve("training/evaluation-cycle-v2/05-training-data-repair-revision-20260901/review-return-record.json"),
});
if (existsSync(resolve(OUTPUT_ROOT, "dataset-manifest.json"))) throw new Error("Preserve the historical dataset; choose a new versioned CYCLE_V2_TRAINING_OUTPUT_ROOT");
if (existsSync(resolve(REVIEW_ROOT, "training-review-pack.json"))) throw new Error("Preserve historical reviews; choose a new versioned CYCLE_V2_TRAINING_REVIEW_ROOT");

const IDEALS = {
  mixed_benefits: "They are different benefit types: the final-salary promise is defined benefit, while the separately invested AVC account is money purchase. {{cite:SOURCE}} They may be shown together for communication, but each component must be valued and tested under its own retirement and transfer rules; do not add unlike figures without explaining the valuation basis.",
  classification_evidence: "Payroll deductions and a dashboard label do not determine the legal classification. Check the policy contract, provider, establishing instrument and statutory status to decide whether this is a contract-based personal pension or an occupational scheme; if those documents are missing, say the classification is not established. {{cite:SOURCE}}",
  cash_balance_distinction: "Trustees operating a master trust does not make an individual invested account defined benefit. A benefit determined by contributions and investment returns is ordinarily money purchase; a cash-balance or DB classification requires a separate promised amount or formula in the governing rules. {{cite:SOURCE}}",
  cdc_explanation: "For collective money-purchase benefits, the dashboard should return the value data required for that benefit type, reflecting the member's target collective benefit rather than inventing an individual pot. {{cite:SOURCE}} The scheme's current rules, actuarial methodology and required contextual information are needed for the actual figure.",
  public_service_evidence_gap: "No. A scheme name is not enough to classify a public-service pension. Please identify the particular scheme and supply its establishing regulations or governing rules, because those materials determine the benefit design and any separate section or AVC. {{cite:SOURCE}}",
  safeguarded_feature: "The invested fund can remain a DC or money-purchase benefit while the guaranteed annuity rate is a safeguarded feature. {{cite:SOURCE}} The guarantee must be valued and checked separately because it can affect transfer disclosures and the statutory safeguarded-benefit advice process; it does not convert every benefit into DB.",

  conflict_process: "The relationship creates a material conflict that disclosure alone may not cure. Apply the governing rules and conflicts policy, consider recusal and independent decision-makers, obtain any needed advice and record how the appointment was made in members' interests. {{cite:SOURCE}}",
  delegation_oversight: "The governing body remains accountable after outsourcing administration. It must set clear contractual responsibilities, monitor complaints, service levels, controls and risks, challenge poor performance and document remedial action; two years without oversight is a governance concern. {{cite:SOURCE}}",
  communication_vs_entitlement: "The executed rules normally determine the contractual entitlement, so the booklet cannot simply replace age 65 with age 60. {{cite:SOURCE}} Preserve and investigate the booklet because it may still matter to maladministration, reliance or remedy, and obtain scheme-specific legal review of the documents and amendment history.",
  reasoned_decision: "Missing reasons do not automatically prove that the discretionary decision is void, but they create a serious evidential and governance problem. Reconstruct what the authorised decision-maker considered, check the rules, relevant evidence, conflicts and process, and use IDRP or legal review rather than inventing reasons. {{cite:SOURCE}}",
  fiduciary_conflict: "Trustees must exercise their own investment power for proper purposes and through a prudent, conflict-managed process focused on scheme and member interests. {{cite:SOURCE}} They should assess authority, expected return and risk, liquidity, diversification, employer-related-investment restrictions and independent advice; improving employer cash flow is not itself a sufficient trustee purpose.",
  operational_resilience: "Yes, the absence of a tested continuity plan can be an internal-control and governance weakness even before a payment fails. {{cite:SOURCE}} The governing body should assess payroll dependencies, cyber and supplier risks, recovery objectives, testing, escalation and reporting, then document and test a proportionate continuity plan.",
  esog_outsourcing: "No. Outsourcing performance of the ORA or cyber controls does not transfer the governing body's ESOG duties or accountability. {{cite:SOURCE}} The board must understand the assessment, approve and document it as required, oversee the provider, test evidence and remedy gaps on a proportionate basis.",

  member_funding_explanation: "No. A £40 million funding deficit measures the shortfall between scheme assets and the statutory funding measure; it is not £40 million deducted from members' individual promised pensions. {{cite:SOURCE}} Trustees and the employer address it through valuation, strategy, contributions and a recovery plan, while benefit changes require a separate lawful route.",
  transaction_handoff: "Assess the sale's effect on the employer covenant, scheme funding, cash flows, security and recoverability, together with mitigation, notifiable-event duties, moral-hazard powers and any clearance question. {{cite:SOURCE}} This is transaction-specific legal, actuarial and covenant work: the assistant should explain the framework but refer the proposed terms and evidence to qualified advisers before implementation.",
  section_75_flexible_apportionment_arrangement: "Stopping employment of active members may trigger employer-debt analysis, but a qualifying flexible apportionment arrangement can alter which employer assumes responsibility if the statutory conditions are met before the relevant event. {{cite:SOURCE}} Check the employment-cessation facts, scheme status, funding test, receiving employer, trustee consent, required notices, timing and actuarial/legal evidence before concluding whether or when debt falls due.",
  valuation_basis: "The recovery plan addresses the deficit against technical provisions shown by the statutory funding valuation, so the £20 million figure is the relevant starting measure on the stated facts. {{cite:SOURCE}} The £12 million accounting deficit remains relevant context but uses a different purpose and basis; confirm dates, assumptions and the certified valuation before fixing contributions.",
  contribution_evidence: "No. A dashboard gap is a warning, not proof of a missed statutory payment. Compare the signed schedule or payment due rules with payroll, employer and scheme bank records for the exact amount and due date, then investigate, recover and assess reporting obligations if a shortfall is established. {{cite:SOURCE}}",
  territorial_regulatory_power: "Great Britain materials should not be used as the sole governing authority without establishing the scheme and employer's territorial connection. Retrieve the Northern Ireland pensions legislation and regulatory counterparts for the relevant moral-hazard or transaction power, while separating any group entities or schemes governed in Great Britain. {{cite:SOURCE}}",
  db_reasonable_affordability: "The recovery plan should eliminate the deficit as soon as the employer can reasonably afford, taking account of covenant reliability and the risks borne by members. {{cite:SOURCE}} A proposal of £3 million where £10 million is reasonably affordable needs evidence and justification, including competing sustainable-growth needs, investment risk, mitigation and why a longer period is appropriate.",

  survivor_equality: "The scheme should consider a reasonable adjustment so the visually impaired member can understand and complete the election, such as an accessible electronic, large-print, audio or supported route. {{cite:SOURCE}} It should discuss the member's needs, preserve an equivalent valid election and deadline, and not treat a PDF-only process as conclusive.",
  age_framework: "The exclusion is direct age treatment, but age distinctions can be lawful if they pursue a legitimate aim through proportionate means or fall within a specific lawful pension exception. {{cite:SOURCE}} Obtain evidence for the aim, impact and less discriminatory alternatives and check the governing rules before deciding lawfulness.",
  accessible_process: "The scheme should make a reasonable adjustment to accept and progress the complaint through an accessible alternative rather than rejecting it for failure to use the digital portal. {{cite:SOURCE}} Agree the format, keep the same substantive and timing protections, record the adjustment and route the complaint through the applicable internal procedure.",
  historical_entitlement: "Analyse each service period using the contemporaneous eligibility rules, employment status and part-time treatment, including when the member sought or could have joined and the applicable historical equality law. {{cite:SOURCE}} Current rules alone do not determine 1994–2001 service; limitation, knowledge, comparator and remedy evidence also need review.",
  civil_partnership_comparator: "Compare the civil partner with an opposite-sex spouse under the governing survivor rule and current equality law. {{cite:SOURCE}} Check relationship and benefit-payment dates, all service periods, scheme amendments, dependency or nomination terms and any historical exclusion before accepting the smaller pension or promising full equality.",
  ni_routing: "Use Northern Ireland equality legislation and the applicable Northern Ireland pension complaint or IDRP provisions; do not default to the Equality Act 2010 as the governing instrument. {{cite:SOURCE}} The scheme should still consider an accessible adjustment and confirm employment, scheme and complaint connections before selecting the exact NI sources and forum.",
  mccloud_scheme_pays: "A McCloud correction can require a remedy-specific tax recalculation using the remedial pension savings statement, not just the ordinary current-year scheme-pays workflow. {{cite:SOURCE}} Check the affected historic tax years, revised annual-allowance charge, HMRC process and deadlines, and whether an existing mandatory or voluntary scheme-pays election must be made or adjusted with the scheme.",

  psa2026_royal_assent_not_full_commencement: "No. Royal Assent enacted the Pension Schemes Act 2026, but its commencement section brings different provisions into force at different times and many DC duties depend on later regulations, FCA rules and implementation. {{cite:SOURCE}} Identify the particular reform and check its commencement and operative secondary legislation before treating it as a current duty.",
  psa2026_vfm_prepare_now: "Trustees can map default arrangements, data owners and systems for investment performance, costs, charges and service-quality metrics; assess governance, benchmarking capability and provider contracts; and monitor DWP, FCA and TPR implementation. {{cite:SOURCE}} Preparation is prudent, but do not perform or publish a purported statutory rating until the regulations, scope, metrics, timetable and service are operative.",
  psa2026_surplus_precommencement: "No. On the supplied status, the statutory surplus override is expected to commence in April 2027 and cannot be used early merely because the Act received Royal Assent. {{cite:SOURCE}} Trustees must wait for commencement and regulations and meanwhile act only under existing scheme powers and law with actuarial and legal advice.",

  dashboards_ongoing_errors: "Connection is an ongoing duty. Record the errors, affected requests, downtime, provider actions and decisions; investigate root cause, restore accurate value-data responses promptly, monitor service levels and retain the required compliance records. {{cite:SOURCE}} Assess materiality for breach-of-law reporting and any member complaint or data issue rather than treating initial connection as full compliance.",
  dashboards_connection_vs_public_launch: "No. A scheme's technical connection does not itself establish that a qualifying dashboard service is available to the public. {{cite:SOURCE}} Public availability depends on the statutory dashboards-available point and service launch, while the scheme must use the pre-launch period to remain connected, test matching and return accurate data.",
  dashboards_breach_reporting: "Investigate the failed find requests, affected members, duration, causes, data quality, provider controls and remedial action, and preserve the required records. {{cite:SOURCE}} Assess material significance under breach-of-law reporting for TPR and route individual administration complaints through the scheme's complaint or IDRP process; one route does not replace the other.",
};

const missing = candidates.filter((item) => !IDEALS[item.review_focus]).map((item) => `${item.id}:${item.review_focus}`);
const extra = Object.keys(IDEALS).filter((focus) => !candidates.some((item) => item.review_focus === focus));
if (missing.length || extra.length) throw new Error(`Wave 2 training mapping mismatch. Missing: ${missing.join(", ")}; extra: ${extra.join(", ")}`);

const system = "You are a read-only UK pensions assistant. Answer only from the supplied synthetic fixture and evidence. Never invent facts, dates, figures, law, citations, actions or tool results. Cite supported propositions with the supplied {{cite:source_id}} token. If evidence is missing, stale, conflicting or from the wrong jurisdiction, say what is missing and use the required clarification or professional-review route. Distinguish enactment from commencement and do not replace a governing rule with a generic disclaimer.";
const items = candidates.map((item) => {
  const approved = reviewed.byId.get(item.id);
  const answer = approved.ideal_answer;
  return {
    training_id: item.id,
    topic_id: item.topic_id,
    construct_id: item.construct_id,
    capability: item.review_focus,
    failure_cluster: item.topic_id,
    example_kind: "positive_source_conditioned",
    jurisdiction: item.jurisdiction,
    user_question: item.question,
    synthetic_fixture: { synthetic: true, contains_real_user_data: false, law_as_at: item.law_as_at },
    retrieved_evidence: approved.retrieved_evidence,
    response_route: item.expected_answer_mode === "handoff" ? "ANSWER_AND_HANDOFF" : "ANSWER",
    handoff_required: item.expected_answer_mode === "handoff",
    action_allowed: false,
    ideal_answer: answer,
    completion_target_field: "ideal_answer",
    human_review_status: "source_grounded_draft_pending_independent_training_review",
    diagnostic_or_unseen_content_included: false,
  };
});

const validationIds = new Set(["v2-w2-t01-train-006", "v2r-w2-t02-train-001", "v2r-w2-t03-train-001", "v2r-w2-t04-train-001", "v2r-w2-t05-train-003", "v2r-w2-t06-train-003"]);
const trainItems = items.filter((item) => !validationIds.has(item.training_id));
const validItems = items.filter((item) => validationIds.has(item.training_id));
const isolation = auditTrainingPartitionIsolation(trainItems, validItems);
const overlap = isolation.overlap.source_ids;
if (trainItems.length !== 27 || validItems.length !== 6 || !isolation.passed) throw new Error(`Wave 2 training split needs independently reviewed source/construct repartitioning: ${JSON.stringify(isolation)}`);

function row(item) {
  const evidence = item.retrieved_evidence.map((source) => ({ ...source, citation_token: `{{cite:${source.source_id}}}` }));
  return {
    messages: [
      { role: "system", content: system + ' Return one complete JSON object with answer (string) and citation_ids (array of the source IDs cited in answer), with no surrounding text.' },
      { role: "user", content: JSON.stringify({ question: item.user_question, conversation_context: [], synthetic_fixture: item.synthetic_fixture, evidence, response_route: item.response_route, handoff_required: item.handoff_required, action_allowed: false }) },
      { role: "assistant", content: JSON.stringify({ answer:item.ideal_answer, citation_ids:[...new Set([...item.ideal_answer.matchAll(/\{\{cite:([^}]+)\}\}/g)].map((match) => match[1]))] }) },
    ],
    metadata: { training_id: item.training_id, capability: item.capability, failure_cluster: item.failure_cluster, example_kind: item.example_kind, jurisdiction: item.jurisdiction, completion_target_field: "ideal_answer" },
  };
}
function jsonl(values) { return `${values.map((item) => JSON.stringify(row(item))).join("\n")}\n`; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }

mkdirSync(OUTPUT_ROOT, { recursive: true });
mkdirSync(REVIEW_ROOT, { recursive: true });
const trainJsonl = jsonl(trainItems);
const validJsonl = jsonl(validItems);
writeFileSync(resolve(OUTPUT_ROOT, "train.jsonl"), trainJsonl);
writeFileSync(resolve(OUTPUT_ROOT, "valid.jsonl"), validJsonl);
writeFileSync(resolve(REVIEW_ROOT, "training-review-pack.json"), `${JSON.stringify({ version: "wave-2-training-review-pack-v1", generated_at: new Date().toISOString(), status: "source_grounded_draft_pending_independent_training_review", item_count: items.length, protected_partitions: { diagnostic: "excluded", unseen: "excluded" }, items }, null, 2)}\n`);
const manifest = {
  version: "evaluation-cycle-v2-wave-2-lora-dataset-v1",
  generated_at: new Date().toISOString(),
  status: "exported_pending_training_gate",
  source_answer_review_sha256:reviewed.sha256,
  source_answer_reviewer:reviewed.review.reviewer,
  source_question_set: { path: INPUT, sha256: sha(readFileSync(INPUT)) },
  completion_target_field: "ideal_answer",
  train: { count: trainItems.length, ids: trainItems.map((item) => item.training_id), sha256: sha(trainJsonl) },
  validation: { count: validItems.length, ids: validItems.map((item) => item.training_id), sha256: sha(validJsonl) },
  source_id_overlap: overlap,
  partition_isolation:isolation,
  protected_partitions: { diagnostic_questions: "excluded", diagnostic_gold: "excluded", sealed_unseen_questions: "excluded", sealed_unseen_gold: "not_present_not_accessed" },
};
writeFileSync(resolve(OUTPUT_ROOT, "dataset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(REVIEW_ROOT, "TRAINING-REVIEW.md"), `# Wave 2 training review\n\nStatus: **source-grounded draft pending independent training review**. The export contains ${trainItems.length} train and ${validItems.length} validation examples with no source-ID overlap. Diagnostic and unseen partitions are excluded.\n\nTraining must not start until the diagnostic failure analysis confirms that an adapter change is needed and these ideal answers are approved.\n`);
console.log(JSON.stringify({ items: items.length, train: trainItems.length, validation: validItems.length, source_id_overlap: overlap.length, output: OUTPUT_ROOT, status: manifest.status }, null, 2));
