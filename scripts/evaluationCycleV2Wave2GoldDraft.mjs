import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const INPUT = resolve("training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-2/development-question-set.json");
const OUTPUT = resolve("training/evaluation-cycle-v2/02-wave-2-execution/gold/evaluation-gold.json");
const REVIEW = resolve("training/evaluation-cycle-v2/02-wave-2-execution/gold/EVALUATION-GOLD-REVIEW.md");
const pack = JSON.parse(readFileSync(INPUT, "utf8"));
const questions = pack.topics.flatMap((topic) => topic.diagnostic_evaluation.map((item) => ({ ...item, topic_id: topic.topic_id })));

const CHECKS = {
  hybrid_and_avc: ["The final-salary promise is a defined benefit, while the separately administered contribution-and-return AVC is a money-purchase benefit.", "Classification and the applicable valuation, retirement and transfer rules must be applied benefit by benefit; one rule cannot be assumed to govern both."],
  occupational_vs_personal: ["An individual investment account describes benefit design, not the legal vehicle.", "Establish whether the arrangement is an occupational scheme or a contract-based personal pension from the governing instrument, provider contract and statutory status; dashboard presentation is not decisive."],
  cash_balance: ["A guaranteed capital sum can be a cash-balance benefit: a benefit calculated by reference to a promised amount rather than solely by investment performance.", "Confirm the guarantee and calculation in the governing rules before classifying it or applying cash-balance rules."],
  collective_money_purchase: ["The authorised collective design, target rather than guaranteed benefits, collective adjustment and absence of individual pots support collective money-purchase classification.", "It is not DB merely because it targets an income, and authorisation and the actual rules must still be verified."],
  public_service_misclassification: ["A dashboard label cannot classify a council pension conclusively.", "Check the statutory scheme regulations, administering authority, membership/service dates and any separate AVC or section before deciding whether the benefit is DB, DC or mixed."],
  group_personal_pension: ["A group personal pension is ordinarily a contract-based personal pension arrangement, not an occupational scheme merely because the employer uses payroll and contributes.", "Confirm the policy/provider contract and statutory arrangement rather than relying on the workplace label."],
  master_trust_dc: ["A master trust can be an occupational defined-contribution scheme holding individual money-purchase pots.", "Trust-based governance does not make the benefit defined benefit; the promise in the rules and method of benefit calculation control."],
  section_specific_classification: ["Classify the rights being transferred and the section in which they arise rather than the scheme's overall label.", "Final-salary and money-purchase sections can engage different valuation, transfer and advice rules, including safeguarded-benefit checks."],
  dc_with_guarantee: ["The invested fund can remain money purchase while a guaranteed annuity rate is a safeguarded feature or safeguarded benefit.", "Identify the guarantee's terms and value separately and apply any statutory advice or transfer protection triggered by that feature."],
  statutory_public_service_scheme: ["A statutory public-service scheme is governed by its establishing legislation and scheme regulations, not automatically by private trust-deed assumptions.", "Apply a trust principle only if the statutory framework or another valid governing instrument makes it relevant."],
  label_vs_rules: ["The executed governing rules and applicable legislation control classification, not a dashboard's informal label.", "Employer credits plus investment returns without a salary-related promise indicate money purchase, subject to checking for guarantees or other safeguarded features."],
  state_vs_private_pension: ["State Pension is a statutory social-security benefit and should not be treated as a trust-based occupational scheme with trustees or an ordinary CETV.", "The occupational pension must be analysed separately under its own governing rules and transfer regime."],

  trustee_powers_and_purpose: ["A broad amendment power is constrained by its wording, procedural formalities, proper purpose, fiduciary duties and statutory or protected-right restrictions.", "The executed deed, amendments, member protections and decision process must be checked before concluding that an amendment is valid."],
  delegation_and_monitoring: ["Authorised delegation does not eliminate trustee responsibility for a proper selection process and lawful terms of delegation.", "Trustees must monitor performance and suitability, review the arrangement and take action where needed."],
  conflict_management: ["Disclosure alone does not necessarily manage a material conflict involving a bidder owned by a trustee's spouse.", "Apply the scheme's conflict policy and governing rules, consider recusal or independent decision-makers, document the process and act in members' interests."],
  employer_direction_vs_duty: ["Trustees must exercise their own investment powers and duties; an employer direction cannot override the governing power, prudent process, diversification, conflicts and member-interest duties.", "Employer-related investments are subject to the aggregate percentage restriction, while specified forms such as a loan to the employer can be absolutely prohibited; each proposed asset must be classified under the 1995 Act and 2005 Regulations."],
  member_communications: ["A summary communication does not normally amend or override an executed scheme rule and cannot safely determine entitlement where it omits a material restriction.", "Check the governing documents and amendment history separately, while preserving the communication as evidence relevant to maladministration, reliance or remedy."],
  decision_records: ["Missing minutes weaken evidence that the correct decision-maker applied the rules, considered relevant evidence, ignored irrelevant matters and gave adequate reasons.", "Reconstruct the audit trail without inventing reasons, preserve evidence and consider IDRP or legal review rather than substituting a fresh undocumented conclusion."],
  advice_not_abdication: ["Trustees may obtain and rely on appropriate professional advice but must understand its remit and exercise their own powers and judgment.", "Record the advice, relevant factors, questions, conflicts and reasons for the board's decision; advice is not an automatic defence or delegation of every duty."],
  internal_controls_and_cyber: ["Contain and investigate the incident, protect payroll and member data, preserve evidence and activate incident, continuity and internal-control plans.", "Assess TPR breach-of-law materiality, UK GDPR personal-data-breach risk and ICO timing separately, then make accurate member communications without assuming one report satisfies every route."],
  trustee_knowledge: ["Appointment alone does not establish the statutory knowledge and understanding needed for a complex buyout decision.", "Assess the trustee's actual knowledge, training and access to advice, address the gap and ensure a properly informed board decision rather than automatically validating or voiding it."],
  decision_maker_authority: ["A chair acting alone cannot be assumed to exercise a discretion assigned by the rules to the trustee board.", "Check delegation powers, quorum, ratification, conflicts, evidence and the actual decision record; seek scheme-specific legal review before treating the decision as valid."],
  investment_process: ["Considering climate risk alone is not enough; trustees must consider the scheme's liabilities, liquidity, diversification, financially material risks and appropriate advice over the relevant horizon.", "The answer should assess the decision process and governing documents, not prescribe a particular investment or guarantee the outcome."],
  record_retention: ["A generic seven-year period does not by itself justify deleting records needed to calculate still-payable deferred benefits or determine an open complaint.", "Balance data minimisation against legal, regulatory, limitation, litigation-hold and evidential needs; retain an adequate benefit history and document a reasoned retention decision."],
  general_code_esog_ora_threshold: ["A scheme required to operate an effective system of governance with 100 or more members must carry out and document an own-risk assessment under the applicable cycle and timing rules.", "Proportionality affects the depth and complexity of the assessment; it does not remove the ORA requirement for this 120-member scheme."],
  employer_related_investment_limits: ["Four per cent in employer securities is tested against the five per cent aggregate employer-related investment ceiling and still requires a prudent, conflict-managed investment process.", "A direct loan to the employer is a separately prohibited form and is not made permissible by remaining below the percentage ceiling."],

  funding_not_member_account: ["A technical-provisions deficit is a scheme funding measure and does not reduce each member's accrued promise by the same percentage immediately.", "Trustees and employer must address valuation, funding strategy, contributions and recovery planning; benefit outcomes change only through a lawful route such as amendment limits, transfer, wind-up or PPF process."],
  recovery_plan_not_guarantee: ["For a valuation effective on 22 September 2024 the 2024 funding regime and Code apply, including the funding and investment strategy and employer-covenant assessment.", "A recovery plan must eliminate the deficit as soon as the employer can reasonably afford; the proposed £3m versus stated £8m affordability and ten-year period require evidence and justification, not an assumed guarantee."],
  schedule_of_contributions: ["Identify the certified schedule, amount and due date, explanation for non-payment and whether the shortfall is material or reportable.", "Trustees should pursue recovery and consider breach reporting and TPR powers under the applicable statutory process; do not invent a grace period or enforcement outcome."],
  section_75_trigger: ["Cessation of participation after a reorganisation does not by itself establish the precise section 75 trigger or debt amount.", "Check whether an employment-cessation or other statutory event occurred, continuing active members, exemptions or apportionment arrangements, timing and the prescribed buy-out-basis valuation."],
  corporate_transaction_covenant: ["A profitable-subsidiary sale requires evidence of the employer covenant, transaction value and destination of proceeds, mitigation, scheme funding and counterfactual effect.", "Do not declare material detriment or a regulatory offence from the sale fact alone; escalate transaction-specific legal, actuarial and covenant analysis."],
  contribution_notice: ["Establish the act or failure, timing, target person's connection, purpose and effects relevant to the statutory employer-insolvency, employer-resources or material-detriment tests.", "A contribution notice also depends on statutory defences and whether it is reasonable to impose one; the assistant must not predict TPR's discretionary outcome without evidence."],
  clearance_boundary: ["TPR clearance is a voluntary transaction-specific assurance concerning specified moral-hazard powers on disclosed facts.", "It is not a guarantee against section 75 debt, funding duties, private claims, future facts or every regulatory power; obtain transaction-specific advice and comply with separate duties."],
  notifiable_event_fact_gap: ["Identify separately the grant of security and proposed material business sale, and establish scheme/employer scope, transaction stage, decision or agreement date, value thresholds and any relevant exceptions.", "Check the provisions actually in force on 10 August 2026 and the applicable notification or accompanying-statement deadline before concluding a breach; do not apply an uncommenced proposal."],
  accounting_vs_statutory_funding: ["The older DB funding code applies to a valuation effective on 21 September 2024; the 2024 Code applies from effective dates on or after 22 September 2024.", "Scheme B must determine a funding and investment strategy and prepare the chair-signed statement of strategy containing that strategy and prescribed supplementary information."],
  dividend_and_covenant: ["A large dividend while extending recovery contributions is relevant covenant and reasonable-affordability evidence but does not automatically prove a breach.", "Compare shareholder distributions, available cash, scheme needs, mitigation, decision timing and reporting duties under the applicable funding regime."],
  insolvency_ppf_process: ["Administration may be a qualifying insolvency event and can start a PPF assessment process, but it does not automatically mean the PPF has assumed responsibility.", "Check scheme eligibility, insolvency notices, funding determination and assessment outcome; section 75 debt and creditor-proof issues remain relevant rather than disappearing."],
  ni_employer_debt: ["Do not apply the Great Britain employer-debt regulations as the governing instrument to a Belfast/NI scheme without establishing territorial scope.", "Retrieve and apply the Northern Ireland counterpart and check the scheme connection, trigger, exceptions, arrangements and valuation under that regime."],
  db_code_transition_exact: ["The pre-2024 DB funding code applies to the 21 September 2024 effective date.", "The 2024 DB Funding Code applies to the 22 September 2024 effective date; the transition turns on valuation effective date, not completion or submission date."],
  db_fis_statement_strategy: ["The funding and investment strategy is the trustees' long-term strategy for benefits and planned asset allocation at the relevant date, developed with the employer as required.", "The statement of strategy records that strategy plus prescribed supplementary matters, is signed by the chair and is submitted with the valuation; the documents are related but not interchangeable."],
  db_significant_maturity_low_dependency: ["At significant maturity the strategy must target low dependency on employer support and a low-dependency investment allocation at the relevant date.", "High risk is not automatically forbidden today, but the journey plan, risk support, covenant reliability and evidence must show how the statutory objective will be reached and risks supported."],
  db_fast_track_bespoke: ["Fast Track and Bespoke are TPR regulatory-assessment approaches, not different bodies of statutory funding law.", "Bespoke does not exempt trustees from the 2004 Act, 2024 Regulations or Code; it requires evidence and explanation of risks and support under the same underlying duties."],

  sex_equality_temporal: ["Identify service before and after the 17 May 1990 Barber date and the scheme's effective equalisation date, including any Barber-window service.", "Apply the sex-equality rule, governing amendments and relevant case law to each service period; do not assume today's normal pension age resolves the historical calculation."],
  age_discrimination_justification: ["An age threshold is not automatically unlawful: direct age discrimination can be justified by a legitimate aim pursued through proportionate means.", "Require evidence for the aim, alternatives, impact and consistency, and also check the scheme rules and any specific pension exception rather than asserting justification."],
  disability_adjustments: ["A standard portal does not end the duty to consider reasonable adjustments for a disabled member who cannot access it effectively.", "Assess disability and substantial disadvantage, practicable accessible formats, cost/resources and communication needs; provide an effective alternative unless refusal is objectively supportable."],
  civil_partnership_survivor: ["Compare the civil partner with the relevant opposite-sex spouse under current equality law and the governing survivor-benefit rule.", "Check relationship, accrual and payment dates, historic exclusions, amendments and controlling case law before limiting service or promising a result."],
  part_time_historical_service: ["Today's rules alone cannot determine exclusion from pension membership for historical part-time service.", "Check contemporaneous eligibility and employment facts, sex/comparator evidence, applicable EU-derived and domestic law, claim timing and remedy limits for each service period."],
  same_sex_survivor_temporal: ["Walker v Innospec prevents the paragraph 18 exclusion from restricting a future same-sex spouse's survivor pension to service after 5 December 2005 on these facts.", "Subject to the actual scheme terms and comparator, calculate the survivor benefit on the same basis as for an opposite-sex spouse, including relevant pre-2005 service."],
  gmp_equalisation_outcome: ["Schemes must equalise the overall effect of sex-based GMP inequalities for affected service, using a lawful method.", "Equalisation does not mean every member receives an increase: compare outcomes, offsets, method, data and any past transfers or conversion consequences without inventing an amount."],
  disability_process: ["Telephone-only evidence may substantially disadvantage a member with a mental-health condition and requires consideration of reasonable adjustments and alternative evidence routes.", "The decision-maker must apply the ill-health rule fairly, obtain relevant evidence and record reasons; disability law does not guarantee the benefit outcome."],
  age_access: ["Identify the age rule, affected workers, comparator, aim, evidence and less discriminatory alternatives.", "An age-based closure requires objective justification as a proportionate means of achieving a legitimate aim and compliance with the governing scheme and employment rules; do not presume it valid or invalid."],
  status_and_comparator: ["Cohabitation alone does not establish unlawful discrimination or survivor entitlement.", "Check scheme wording, nomination, dependency, marital or civil-partner status, protected characteristic, appropriate comparator, service dates and any objective justification or statutory override."],
  gender_reassignment_and_records: ["Correct and reconcile the member's service and benefit record so a name or gender-marker change does not split or reduce entitlement.", "Restrict and secure historical identity data under necessity, minimisation and access controls, preserve confidentiality and avoid less favourable treatment while meeting lawful evidential needs."],
  ni_equality_authority: ["The Equality Act 2010 is generally a Great Britain instrument and must not be assumed to govern Northern Ireland service.", "Identify and apply the Northern Ireland equality and part-time-worker legislation and the correct NI institutions, while checking employment location, dates and scheme connection."],
  mccloud_cohort_period: ["The ordinary McCloud remedy period for Chapter 1 schemes is 1 April 2015 to 31 March 2022, not every year from 2014 to 2023.", "Eligibility also depends on the scheme's closing date, qualifying legacy and reformed-scheme service and cohort facts; identify scheme-specific exceptions before confirming covered service."],
  mccloud_rpss_tax: ["Use the remedial pension savings statement to compare corrected pension input amounts and recalculate affected annual-allowance positions for the relevant historic tax years under HMRC's McCloud process.", "Check prior charges, deadlines, compensation or refunds, and whether a mandatory or voluntary scheme-pays election must be made, varied or reduced; obtain tax and scheme-specific advice rather than inventing liability."],

  psa2026_virgin_media_in_force: ["Chapter 1 of Part 4 of the Pension Schemes Act 2026 was brought into force on Royal Assent and the statutory Virgin Media remediation route is in force on 28 August 2026.", "For a potentially remediable alteration, trustees request written confirmation from the scheme actuary that it is reasonable to conclude the alteration would not have prevented continued satisfaction of the contemporaneous statutory standard, subject to scope and litigation exclusions."],
  psa2026_vfm_status: ["The 2026 Act enacts regulation-making powers and the statutory architecture for value-for-money assessments, metrics, ratings and consequences.", "The complete operative assessment is not due merely because the Act received Royal Assent: scope, metrics, periods, benchmarks, process and commencement depend on regulations, FCA alignment, guidance and implementation."],
  psa2026_surplus_status: ["The new statutory surplus override is not operative on 28 August 2026; TPR expects commencement in April 2027.", "Later regulations and guidance must set funding conditions and process, and trustees must still check scheme power, funding evidence, employer request, member interests and advice before any payment."],
  psa2026_small_pots_status: ["The Act establishes the small-pots consolidation framework and regulation-making powers but does not itself authorise automatic transfer of every dormant £900 pot next week.", "Regulations must define qualifying pots, dormancy, exemptions, destinations or consolidator authorisation, notices, member safeguards, process and commencement."],
  psa2026_guided_retirement_status: ["The Act creates the guided-retirement or default-pension framework and related rule-making powers.", "An operative solution still depends on commencement, regulations, any corresponding FCA rules, scheme design, communications and implementation; trustees must not promise that the statutory default already exists."],
  psa2026_superfund_status: ["The Act creates a statutory authorisation, supervision and individual-transfer approval framework, but Part 3 requires commencement and does not automatically authorise a named vehicle or transfer.", "A transaction requires TPR authorisation and approval under the operative regime plus scheme-specific covenant, funding, member-interest and legal advice; statutory status is not a suitability recommendation."],

  dashboards_scope_relevant_members: ["The GB Regulations apply where the scheme had at least 100 relevant members at the reference date; relevant members are active, deferred and pension-credit members, not pensioner members.", "The stated 105 active and deferred members meet the threshold, subject to the statutory scheme and territorial exceptions; the 30 pensioners do not count toward it."],
  dashboards_guidance_date_vs_deadline: ["The 28 February 2026 date is a staged connect-by date in DWP guidance to which trustees must have regard and against which TPR may assess conduct.", "The statutory connection deadline is 31 October 2026, but connecting before the long-stop does not erase delay against guidance; document reasons, remediation and breach or reporting considerations."],
  dashboards_all_sections_avcs: ["Connection and information duties apply across relevant memberships and benefits in all sections, including in-scope money-purchase AVCs; connecting only the DB section is incomplete.", "Coordinate each administrator or provider, connect omitted records promptly and provide the correct methodology and value data for each benefit type."],
  dashboards_matching_controls: ["Treat partial surname/address alignment as a possible match, provide only the limited permitted administrative data and do not return view data until identity and consent are resolved to a match made.", "Apply documented matching criteria, data-quality work, UK GDPR security, minimisation and DPIA controls, maintain records and follow the statutory possible-match process."],
  dashboards_value_data_recency: ["Trustees must provide accurate value data within the regulatory timescales using the applicable benefit methodology and an appropriate illustration date.", "A newer annual benefit statement is evidence that a 2022 value may not be sufficiently recent; verify source data and recalculate or explain and cure delay rather than silently returning stale data."],
  dashboards_outsourcing_accountability: ["The dashboard duties remain with the trustees or scheme managers even when an administrator or connection provider performs every operational function.", "Trustees must allocate roles contractually, oversee connection, matching, data quality, reporting and ongoing compliance, monitor providers and remedy breaches; outsourcing does not transfer statutory accountability."],
};

const ALIASES = {
  "pension-schemes-act-2026": "official-pension-schemes-act-2026",
  "public-service-pensions-and-judicial-offices-act-2022": "official-public-service-pensions-and-judicial-offices-act-2022",
  "tpr-db-funding-code-2024": "official-tpr-db-funding-code-2024",
  "tpr-general-code-of-practice-2024": "official-tpr-general-code-of-practice-2024",
  "gb-pensions-dashboards-regulations-2022": "official-gb-pensions-dashboards-regulations-2022",
  "ni-pensions-dashboards-no-2-regulations-2023": "official-ni-pensions-dashboards-no-2-regulations-2023",
};
const EXTRA_SOURCES = {
  employer_direction_vs_duty: ["official-pensions-act-1995", "official-occupational-pension-schemes-investment-regulations-2005"],
  employer_related_investment_limits: ["official-pensions-act-1995", "official-occupational-pension-schemes-investment-regulations-2005"],
  sex_equality_temporal: ["official-eu-barber-v-guardian-c-262-88", "official-eu-coloroll-v-russell-c-200-91"],
  part_time_historical_service: ["official-equality-act-2010"],
  gmp_equalisation_outcome: ["official-lloyds-gmp-equalisation-2018-ewhc-2839-ch", "official-lloyds-gmp-equalisation-2020-ewhc-3135-ch"],
  ni_employer_debt: ["official-ni-occupational-pension-schemes-employer-debt-regulations-2005"],
  ni_equality_authority: ["official-ni-equal-treatment-occupational-pension-schemes-regulations-2023"],
  mccloud_rpss_tax: ["official-hmrc-ptm-ptm050000"],
  public_service_misclassification: ["official-public-service-pensions-act-2013"],
  state_vs_private_pension: ["official-pensions-act-2014", "official-dwp-state-pension-explained-2026", "official-pension-schemes-act-1993"],
  gender_reassignment_and_records: ["official-ico-uk-gdpr-data-protection-principles-2026", "official-equality-act-2010"],
  internal_controls_and_cyber: ["official-ico-uk-gdpr-data-protection-principles-2026", "official-tpr-general-code-of-practice-2024"],
  record_retention: ["official-ico-uk-gdpr-data-protection-principles-2026", "official-tpr-general-code-of-practice-2024"],
  dashboards_matching_controls: ["official-ico-uk-gdpr-data-protection-principles-2026", "official-tpr-pensions-dashboards-guidance-2026"],
  dashboards_guidance_date_vs_deadline: ["official-dwp-pensions-dashboards-staged-timetable-2025", "official-tpr-pensions-dashboards-guidance-2026"],
};

const missing = questions.filter((item) => !CHECKS[item.review_focus]).map((item) => `${item.id}:${item.review_focus}`);
const extra = Object.keys(CHECKS).filter((focus) => !questions.some((item) => item.review_focus === focus));
if (missing.length || extra.length) throw new Error(`Wave 2 gold mapping mismatch. Missing: ${missing.join(", ")}; extra: ${extra.join(", ")}`);

function expectedJurisdiction(item) {
  if (item.jurisdiction === "GREAT_BRITAIN") return "GREAT_BRITAIN";
  if (item.jurisdiction === "NORTHERN_IRELAND") return "NORTHERN_IRELAND";
  return "UNSPECIFIED";
}

const items = questions.map((question) => {
  const required = CHECKS[question.review_focus];
  let sources = [...new Set([...(question.primary_source_targets || []).map((id) => ALIASES[id] || id), ...(EXTRA_SOURCES[question.review_focus] || [])])];
  if (question.jurisdiction === "GREAT_BRITAIN") sources = sources.filter((id) => !id.startsWith("official-ni-"));
  if (question.review_focus === "ni_employer_debt") sources = ["official-ni-occupational-pension-schemes-employer-debt-regulations-2005"];
  if (question.review_focus === "ni_equality_authority") sources = ["official-equality-act-2010", "official-ni-equal-treatment-occupational-pension-schemes-regulations-2023"];
  if (question.review_focus === "state_vs_private_pension") sources = EXTRA_SOURCES.state_vs_private_pension;
  const highStakesHandoff = ["corporate_transaction_covenant", "contribution_notice", "clearance_boundary", "psa2026_superfund_status", "decision_maker_authority"].includes(question.review_focus);
  return {
    id: question.id,
    topic_id: question.topic_id,
    construct_id: question.construct_id,
    review_focus: question.review_focus,
    question_sha256: createHash("sha256").update(question.question).digest("hex"),
    law_as_at: question.law_as_at,
    event_date: question.event_date,
    risk_tier: question.risk_tier,
    expected_route: highStakesHandoff ? "ANSWER_OR_HANDOFF" : "ANSWER",
    expected_jurisdiction: expectedJurisdiction(question),
    reference_answer: required.join(" "),
    required_checks: required,
    must_not: ["Invent a fact, date, legal effect, source or citation.", "Treat an enacted but uncommenced framework as an operative duty.", "Replace the governing rule and application with a generic disclaimer."],
    critical_failure_signals: question.risk_tier === "critical" ? ["material_legal_or_commencement_error"] : [],
    expected_handoff: { required: false, permitted: highStakesHandoff, reason: highStakesHandoff ? "transaction_or_scheme_specific_legal_advice" : null },
    proposition_citation_targets: required.map((proposition, index) => ({ proposition_id: `${question.id}-p${index + 1}`, proposition, source_targets: sources, status: "source_level_pinned_pending_independent_passage_confirmation" })),
    review_status: "draft_source_grounded_pending_independent_legal_semantic_review",
    training_eligibility: "prohibited",
  };
});

const output = {
  version: "evaluation-cycle-v2-wave-2-development-gold-draft-v1",
  generated_at: new Date().toISOString(),
  status: "draft_source_grounded_pending_independent_legal_semantic_review",
  question_set_path: INPUT,
  question_set_sha256: createHash("sha256").update(readFileSync(INPUT)).digest("hex"),
  item_count: items.length,
  source_policy: "Primary legislation and official regulatory/court materials as at 2026-08-28; source IDs pinned per proposition; exact passage confirmation remains an independent-review gate.",
  training_eligibility: "prohibited",
  scoring_authorisation: "provisional_development_diagnosis_only",
  items,
};
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
const rows = items.map((item) => `| ${item.id} | ${item.topic_id} | ${item.risk_tier} | ${item.expected_jurisdiction} | ${item.required_checks.join(" / ")} |`).join("\n");
writeFileSync(REVIEW, `# Wave 2 development-gold review\n\nStatus: **draft, source-grounded, pending independent legal/semantic and exact-passage review**. Gold targets were not supplied to the model.\n\n| ID | Topic | Risk | Jurisdiction | Required checks |\n|---|---|---|---|---|\n${rows}\n`);
console.log(JSON.stringify({ status: output.status, items: items.length, critical: items.filter((item) => item.risk_tier === "critical").length, output: OUTPUT, review: REVIEW }, null, 2));
