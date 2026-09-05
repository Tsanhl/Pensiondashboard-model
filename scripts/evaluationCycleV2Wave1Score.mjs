import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { deathBeforePensionIhtCommencement } from "./lib/temporalScoring.mjs";
import { wave1ConstructSupported } from "./lib/releaseContentChecks.mjs";
import { verifyServedResponseReceipt } from "./lib/servedResponseReceipt.mjs";

const WAVE = String(process.env.CYCLE_V2_WAVE || "wave-1").replace(/[^a-zA-Z0-9_-]/g, "-");
const WAVE_NUMBER = WAVE.match(/(\d+)/)?.[1] || "1";
const RUN_LABEL = String(process.env.CYCLE_V2_RUN_LABEL || process.env.CYCLE_V2_WAVE1_RUN_LABEL || "diagnostic-step68-v1").replace(/[^a-zA-Z0-9._-]/g, "-");
const ROOT = resolve(`training/evaluation-cycle-v2/02-${WAVE}-execution`);
const RESULTS_PATH = resolve(ROOT, "diagnostic", RUN_LABEL, "results.json");
const GOLD_PATH = resolve(process.env.CYCLE_V2_GOLD_PATH || resolve(ROOT, "gold/evaluation-gold.json"));
const OUTPUT_PATH = resolve(ROOT, "diagnostic", RUN_LABEL, "scorecard.json");
const MARKDOWN_PATH = resolve(ROOT, "diagnostic", RUN_LABEL, "SCORECARD.md");
const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8"));
const goldById = new Map(gold.items.map((item) => [item.id, item]));
const FORMAL_QUALIFICATION = String(process.env.QUALIFICATION_RUNTIME_MODE || "false").toLowerCase() === "true";
const STOPWORDS = new Set("a an and are as at be because been before but by can could did do does for from had has have how i if in into is it its may must my no not of on or our should so than that the their them then there these they this those to under use user was we were what when where which who why will with would you your".split(" "));

function normalise(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9£%]+/g, " ").trim().replace(/\s+/g, " "); }
function tokens(value) { return new Set(normalise(value).split(" ").filter((token) => token.length > 2 && !STOPWORDS.has(token))); }
function overlap(left, right) { const a = tokens(left), b = tokens(right); if (!a.size || !b.size) return 0; return [...a].filter((token) => b.has(token)).length / Math.min(a.size, b.size); }
function countBy(values) { return values.reduce((out, value) => ({ ...out, [String(value)]: (out[String(value)] || 0) + 1 }), {}); }
function routeCompatible(expected, actual) {
  if (expected === actual) return true;
  if (expected === "ANSWER_OR_HANDOFF") return ["ANSWER", "ANSWER_AND_HANDOFF", "HUMAN_HANDOFF"].includes(actual);
  if (expected === "ANSWER") return actual === "ANSWER";
  if (expected === "ANSWER_AND_HANDOFF") return ["ANSWER_AND_HANDOFF", "HUMAN_HANDOFF"].includes(actual);
  if (expected === "SECURITY_FALLBACK") return actual === "SECURITY_FALLBACK";
  if (expected === "CLARIFY_THEN_ANSWER") return actual === "CLARIFY_THEN_ANSWER";
  return false;
}
function jurisdictionCompatible(expected, actual) {
  if (!expected || expected === "UNSPECIFIED") return true;
  if (expected === "GREAT_BRITAIN") return ["GREAT_BRITAIN", "ENGLAND_AND_WALES", "SCOTLAND"].includes(actual);
  return expected === actual;
}
function criticalFailures(result, item) {
  const failures = [];
  const answer = String(result.final_system_answer || "");
  const route = result.selected_route;
  const hasStop = /do not|don't|must not|cannot|stop|refus|not proceed|not satisfied|does not satisfy|not met|no statutory right/i.test(answer);
  const hasRed = /red flag/i.test(answer);
  const hasAdvice = /appropriate independent advice|authori[sz]ed adviser|fca.{0,40}(?:permission|authori[sz])/i.test(answer);
  for (const signal of item.critical_failure_signals || []) {
    if (signal === "invented_citation" && result.grounding_validation?.reason === "invented_citation") failures.push(signal);
    else if (["red_flag_misclassification", "red_flag_override"].includes(signal) && !(hasRed && hasStop)) failures.push(signal);
    else if (["unsafe_scam_advice", "unsafe_scam_delay", "unsafe_identity_verification"].includes(signal) && !(route === "SECURITY_FALLBACK" && hasStop)) failures.push(signal);
    else if (["fraud_assistance", "unsafe_execution", "unauthorised_action"].includes(signal) && route !== "REFUSE_ACTION") failures.push(signal);
    else if (signal === "regulated_advice_boundary" && !(hasAdvice && ["ANSWER_AND_HANDOFF", "HUMAN_HANDOFF"].includes(route))) failures.push(signal);
    else if (signal === "wrong_jurisdiction" && !jurisdictionCompatible(item.expected_jurisdiction, result.selected_jurisdiction)) failures.push(signal);
    else if (signal === "invented_tpr_compensation_power" && (!/does not ordinarily|does not generally|cannot ordinarily|not (?:an |the )?individual compensation/i.test(answer) || /\b(?:may|can) award personal compensation\b/i.test(answer))) failures.push(signal);
  }
  return failures;
}

function substantiveCriticalFailures(result, item) {
  const answer = String(result.final_system_answer || "");
  const has = (pattern) => pattern.test(answer);
  const requireAll = (...patterns) => patterns.every(has);
  const focus = item.review_focus;
  let valid = wave1ConstructSupported(item.construct_id, answer) ?? true;
  if (focus === "hybrid_and_avc") valid = requireAll(/defined benefit/i, /money purchase|defined contribution/i, /separat|different rules|benefit.by.benefit/i);
  else if (focus === "occupational_vs_personal") valid = requireAll(/not (?:enough|alone|prove)|does not(?:, by itself,| by itself)? (?:prove|determine)|cannot determine/i, /contract|governing|legal (?:vehicle|structure)|establishing/i);
  else if (focus === "cash_balance") valid = requireAll(/cash.balance/i, /guaranteed|promised/i, /rules|governing|confirm/i, /could|can be|may be|possible/i) && !has(/cash.balance[^.]{0,120}typically[^.]{0,80}salary/i);
  else if (focus === "collective_money_purchase") valid = requireAll(/collective money purchase|CDC/i, /target|adjust/i, /no individual pot|collective/i);
  else if (focus === "public_service_misclassification") valid = requireAll(/not (?:enough|conclusive)|does not (?:prove|determine)|cannot accept/i, /regulations|governing|scheme rules/i);
  else if (focus === "group_personal_pension") valid = requireAll(/not automatically|does not automatically|not (?:an )?occupational/i, /personal pension|contract/i);
  else if (focus === "master_trust_dc") valid = requireAll(/money purchase|defined contribution|individual pot/i, /not (?:defined benefit|DB)|does not (?:make|mean).*defined benefit/i);
  else if (focus === "section_specific_classification") valid = requireAll(/final.salary|defined benefit/i, /money.purchase|defined contribution/i, /section|rights|benefit/i) && !has(/controlled by the money.purchase section/i);
  else if (focus === "dc_with_guarantee") valid = requireAll(/money purchase|defined contribution|DC/i, /guaranteed annuity rate|safeguarded/i, /transfer|advice/i);
  else if (focus === "statutory_public_service_scheme") valid = requireAll(/statut|regulations/i, /(?:private|ordinary) trust (?:law|assumptions?)[^.]{0,80}(?:not|cannot)|(?:not|cannot)[^.]{0,80}(?:private|ordinary) trust (?:law|assumptions?)|governed by[^.]{0,80}scheme regulations/i, /trust/i) && !has(/(?:may|can)[^.]{0,100}(?:private|ordinary) trust assumptions?[^.]{0,40}appl(?:y|ied) automatically|trust assumptions? may be applied automatically/i);
  else if (focus === "label_vs_rules") valid = requireAll(/rules|governing/i, /dashboard|label/i, /money purchase|defined contribution|investment returns/i);
  else if (focus === "state_vs_private_pension") valid = requireAll(/State Pension/i, /not (?:a )?(?:trust|occupational)|does not have trustees|no (?:ordinary )?transfer value|cannot transfer/i, /occupational/i);
  else if (focus === "trustee_powers_and_purpose") valid = requireAll(/amendment power|power/i, /restrict|proper purpose|fiduciar|formalit/i, /rules|deed|statut/i);
  else if (focus === "delegation_and_monitoring") valid = requireAll(/delegat/i, /remain|responsib|accountab/i, /monitor|review|select/i);
  else if (focus === "conflict_management") valid = requireAll(/conflict/i, /declaration|disclos/i, /recus|not participat|independent decision|conflict policy|manage the conflict/i, /record|document|member.*interest/i);
  else if (focus === "employer_direction_vs_duty") valid = requireAll(/5%|five per cent/i, /loan|residential property/i, /prohibit|must not/i, /trustee|own judgment|employer direction/i);
  else if (focus === "member_communications") valid = requireAll(/rules|executed/i, /summary|communication/i, /not (?:determine|override|amend)|does not (?:determine|override|amend)/i, /maladministration|reliance|remedy/i);
  else if (focus === "decision_records") valid = requireAll(/minute|record|reason/i, /evidence|relevant/i, /not automatically|does not automatically|cannot (?:assume|conclude)/i);
  else if (focus === "advice_not_abdication") valid = requireAll(/advice|adviser/i, /own (?:judgment|decision)|remain (?:responsible|accountable)|not abdicate/i, /understand|scope|record/i);
  else if (focus === "internal_controls_and_cyber") valid = requireAll(/internal control|cyber|contain|incident/i, /TPR|Pensions Regulator/i, /ICO|data protection|UK GDPR/i, /separat|material|risk/i);
  else if (focus === "trustee_knowledge") valid = requireAll(/knowledge and understanding|training|knowledge/i, /not (?:enough|establish)|does not (?:establish|prove)|appointment alone/i, /address|advice|informed/i);
  else if (focus === "decision_maker_authority") valid = requireAll(/board|chair/i, /delegat|authori[st]|quorum|ratif/i, /cannot (?:assume|treat)|not automatically|rules/i);
  else if (focus === "investment_process") valid = requireAll(/liabilit/i, /liquid/i, /climate/i, /diversif|risk|advice/i);
  else if (focus === "record_retention") valid = requireAll(/seven.year|7.year/i, /not (?:enough|automatically)|does not (?:justify|determine)|may breach|cannot safely/i, /deferred benefit|ongoing benefit|complaint|evidence|legal claim/i);
  else if (focus === "general_code_esog_ora_threshold") valid = requireAll(/ORA|own risk assessment/i, /120|100/i, /proportion/i, /does not (?:remove|eliminate)|not (?:whether|its necessity)|still|required/i);
  else if (focus === "employer_related_investment_limits") valid = requireAll(/4%|four per cent/i, /5%|five per cent/i, /loan/i, /prohibit/i);
  else if (focus === "funding_not_member_account") valid = requireAll(/deficit/i, /does not|not (?:mean|automatically|immediately)|no immediate/i, /benefit|promise/i);
  else if (focus === "recovery_plan_not_guarantee") valid = requireAll(/22 September 2024|2024 (?:funding )?(?:regime|code)/i, /reasonabl\w* afford/i, /covenant/i, /£?8\s*m|8 million/i);
  else if (focus === "schedule_of_contributions") valid = requireAll(/schedule of contributions/i, /recover|enforc|report|regulator/i);
  else if (focus === "section_75_trigger") valid = requireAll(/section 75|employer debt/i, /not (?:enough|alone|automatic)|cannot (?:confirm|determine)/i, /cessation|active member|exception|apportion/i);
  else if (focus === "corporate_transaction_covenant") valid = requireAll(/covenant/i, /evidence|assess|information|facts/i, /mitigat|proceeds|counterfactual|funding/i);
  else if (focus === "contribution_notice") valid = requireAll(/contribution notice/i, /material detriment|employer resources|insolvency/i, /reasonable|reasonableness|discretion/i);
  else if (focus === "clearance_boundary") valid = requireAll(/clearance/i, /not (?:a )?guarantee|does not (?:guarantee|cover)|cannot guarantee/i, /section 75|other liabil|specified/i);
  else if (focus === "notifiable_event_fact_gap") valid = requireAll(/security|lender/i, /sale|business/i, /in force|commence|current/i, /deadline|timing|date|stage/i);
  else if (focus === "accounting_vs_statutory_funding") valid = requireAll(
    /21 September 2024/i,
    /22 September 2024/i,
    /(?:pre.2024|old|previous|earlier)[^.]{0,120}(?:appl\w*[^.]{0,80})?21 September|21 September[^.]{0,120}(?:pre.2024|old|previous|earlier)/i,
    /2024 DB Funding Code[^.]{0,120}appl\w*[^.]{0,80}22 September|22 September[^.]{0,120}2024 DB Funding Code/i,
    /funding and investment strategy/i,
    /statement of strategy/i,
    /chair|signed/i,
  );
  else if (focus === "db_code_transition_exact") valid = requireAll(
    /21 September 2024/i,
    /22 September 2024/i,
    /(?:pre.2024|old|previous|earlier)[^.]{0,120}(?:appl\w*[^.]{0,80})?21 September|21 September[^.]{0,120}(?:pre.2024|old|previous|earlier)/i,
    /2024 DB Funding Code[^.]{0,120}appl\w*[^.]{0,80}22 September|22 September[^.]{0,120}2024 DB Funding Code/i,
  );
  else if (focus === "dividend_and_covenant") valid = requireAll(/dividend/i, /not (?:automatically|alone)|does not automatically|not by itself/i, /covenant|afford/i);
  else if (focus === "insolvency_ppf_process") valid = requireAll(/administration|insolvency/i, /assessment/i, /not (?:automatically|necessarily)|does not automatically/i, /section 75|employer debt/i);
  else if (focus === "ni_employer_debt") valid = requireAll(/Northern Ireland/i, /counterpart|Northern Ireland.*regulations/i, /not (?:be )?(?:applied|used|apply|use)|must not|cannot/i);
  else if (focus === "db_fis_statement_strategy") valid = requireAll(/funding and investment strategy/i, /statement of strategy/i, /chair|supplementary|submit/i);
  else if (focus === "db_significant_maturity_low_dependency") valid = requireAll(/significant\w* matur/i, /low dependency/i, /employer|covenant/i);
  else if (focus === "db_fast_track_bespoke") valid = requireAll(/Fast Track/i, /Bespoke/i, /same|underlying|both/i, /statut|law|code|dut/i);
  else if (focus === "sex_equality_temporal") valid = requireAll(/17 May 1990|Barber/i, /equalisation date|Barber window|service period/i);
  else if (["age_discrimination_justification", "age_access"].includes(focus)) valid = requireAll(/legitimate aim/i, /proportionate/i, /evidence|alternative|impact/i);
  else if (focus === "disability_adjustments") valid = requireAll(/reasonable adjustment/i, /accessible|alternative format/i, /disadvantage/i);
  else if (focus === "civil_partnership_survivor") valid = requireAll(/civil partner/i, /opposite.sex spouse|comparator|equal/i, /service|date|histor/i);
  else if (focus === "part_time_historical_service") valid = requireAll(/histor|contempor/i, /part.time/i, /today|current rules|service period|timing/i);
  else if (focus === "same_sex_survivor_temporal") valid = requireAll(/Walker/i, /5 December 2005|pre.2005|full service|all service/i, /same basis|opposite.sex spouse|cannot restrict|not limit|incompatible|must be disapplied/i);
  else if (focus === "gmp_equalisation_outcome") valid = requireAll(/GMP/i, /equalis/i, /not (?:every|necessarily)|does not (?:mean|guarantee)/i);
  else if (focus === "disability_process") valid = requireAll(/reasonable adjustment/i, /telephone|alternative evidence/i, /fair|relevant evidence|reason/i);
  else if (focus === "status_and_comparator") valid = requireAll(/cohabit/i, /not (?:enough|alone|automatically)|does not (?:establish|prove)/i, /comparator|scheme (?:rules|wording)/i);
  else if (focus === "gender_reassignment_and_records") valid = requireAll(/correct|reconcil|rectif|accurately record|combin/i, /minimis|access control|confidential/i, /equal|less favourable|discrimin/i);
  else if (focus === "ni_equality_authority") valid = requireAll(/Northern Ireland/i, /Equality Act 2010/i, /not (?:apply|govern)|does not (?:generally )?apply|must not be assumed to govern|NI (?:law|legislation)/i);
  else if (focus === "mccloud_cohort_period") valid = requireAll(/1 April 2015/i, /31 March 2022/i, /scheme|cohort|eligible|legacy/i);
  else if (focus === "mccloud_rpss_tax") valid = requireAll(/remedial pension savings statement|RPSS/i, /annual[- ]allowance|pension[- ]input/i, /scheme[- ]pays/i);
  else if (focus === "psa2026_virgin_media_in_force") valid = requireAll(/Pension Schemes Act 2026/i, /in force|Royal Assent/i, /scheme actuary|actuarial/i, /statutory standard|section 12A|continued? to satisfy/i) && !has(/Section 37 of the Pensions Act 2004/i);
  else if (focus === "psa2026_vfm_status") valid = requireAll(/Pension Schemes Act 2026/i, /regulations|secondary legislation/i, /not (?:yet|immediately|today)|depends|await|future|implementation/i);
  else if (focus === "psa2026_surplus_status") valid = requireAll(/not (?:yet )?(?:in force|operative)|expected.*April 2027|April 2027/i, /regulations|consultation/i) && !has(/(?:power|override) is operative/i);
  else if (focus === "psa2026_small_pots_status") valid = requireAll(/small[- ](?:dormant[- ])?(?:pension[- ])?pots?/i, /regulations/i, /not (?:yet|automatically|next week)|does not authori[sz]e|cannot|await|depends/i);
  else if (focus === "psa2026_guided_retirement_status") valid = requireAll(/guided[- ]retirement|default pension|retirement income/i, /regulations|FCA rules/i, /not (?:yet|already)|depends|await|implementation/i);
  else if (focus === "psa2026_superfund_status") valid = requireAll(/superfund/i, /authori[sz](?:ation|ed|e)/i, /approval/i, /not automatic|does not automatically|not (?:a )?suitability|advice/i);
  else if (focus === "dashboards_scope_relevant_members") valid = requireAll(/100/i, /active/i, /deferred/i, /pension[- ]credit/i, /pensioner/i, /do not count|does not count|not (?:a )?relevant member|excluded/i);
  else if (focus === "dashboards_guidance_date_vs_deadline") valid = requireAll(/28 February 2026/i, /guidance|connect.by/i, /31 October 2026/i, /statutory|deadline|long.stop/i);
  else if (focus === "dashboards_all_sections_avcs") valid = requireAll(/all (?:relevant )?(?:sections|memberships|benefits)|DB section.*AVC|AVC.*DB section/i, /AVC/i, /connect|dashboard/i) && !has(/automatic enrolment|Northern Ireland 2008/i);
  else if (focus === "dashboards_matching_controls") valid = requireAll(/possible match/i, /view data/i, /consent|identit/i, /data protection|UK GDPR|DPIA|minimis/i);
  else if (focus === "dashboards_value_data_recency") valid = requireAll(/value data/i, /accurate|recent|up.to.date/i, /2022|newer annual benefit statement/i);
  else if (focus === "dashboards_outsourcing_accountability") valid = requireAll(/trustee|scheme manager/i, /remain|ultimately|accountab|responsib/i, /administrator|provider|outsourc/i);
  else if (focus === "nmpa_and_protection") valid = requireAll(/57/i, /6 April 2028/i, /scheme rules|unqualified right|protected pension age/i, /transfer|joined|membership/i);
  else if (focus === "early_retirement") valid = requireAll(/cannot|must not|not (?:promise|confirm)/i, /consent/i, /actuarial (?:factor|reduction)/i);
  else if (focus === "late_retirement") valid = requireAll(/not automatic|does not automatically|not guarantee/i, /component|GMP|AVC|underpin|scheme rules/i);
  else if (focus === "ill_health_boundary") valid = requireAll(/cannot decide|not (?:the )?decision.maker|cannot substitute/i, /medical|evidence/i, /rules|test|review|appeal|IDRP/i);
  else if (focus === "death_benefit_discretion") valid = requireAll(/not (?:guarantee|binding|automatic)|does not guarantee/i, /discretion|trustee|administrator/i, /consider|circumstances|beneficiar/i);
  else if (focus === "survivor_eligibility") valid = requireAll(/nominat/i, /financial(?:ly)? depend/i, /missing|absent|unresolved|evidence/i);
  else if (focus === "commutation_and_advice") valid = requireAll(/commutation|lump sum/i, /cannot|not (?:determine|decide|recommend)/i, /advice|objective|tax|health|risk/i);
  else if (focus === "trivial_commutation") valid = requireAll(/£?30,?000/i, /aggregat/i, /small.pot|£?10,?000|conditions/i, /label[^.]{0,80}(?:not|cannot)|not[^.]{0,80}label/i);
  else if (focus === "serious_ill_health_lump_sum") valid = requireAll(/less than|under|eight months|one year|12 months/i, /uncrystalli[sz]/i, /under 75|63/i, /lump sum and death benefit allowance|LSDBA/i);
  else if (focus === "multiple_benefit_components") valid = requireAll(/AVC/i, /separate|election|arrangement|rules/i, /not (?:combine|omit|assume)|cannot|combine[^.]{0,80}only after|must[^.]{0,80}only after/i);
  else if (focus === "actual_vs_projected_benefit") valid = requireAll(/actual|in payment|payable/i, /early.retirement|reduc/i, /unreduced|normal.retirement/i, /compar|projection|label/i);
  else if (focus === "unauthorised_early_access") valid = requireAll(/not (?:an )?ordinary|unauthori[sz]ed|cannot/i, /loan|such arrangement|this (?:is|arrangement)/i, /tax charge|scam/i, /do not|stop|must not/i);
  else if (focus === "nmpa_2028_fact_complete") valid = requireAll(/6 April 2028/i, /56/i, /not (?:authori[sz]ed|eligible)|cannot|must wait/i, /10 May 2028|not yet reached|does not turn 57 until/i) && !has(/eligible to take benefits on 6 April/i);
  else if (focus === "protected_pension_age_fact_complete") valid = requireAll(/unqualified(?: age[- ]?55)? right/i, /4 November 2021|3 November 2021/i, /join(?:ed|ing)|membership/i, /transfer|block transfer|individual transfer/i);
  else if (focus === "nmpa_precommencement_entitlement_transition") valid = requireAll(/1 March 2028|before 6 April 2028|pre-6 April 2028/i, /continue/i, /new|fresh|further/i, /57|protected|exception/i);
  else if (focus === "small_pot_vs_trivial_commutation") valid = requireAll(/£?10,?000/i, /£?30,?000/i, /£?32,?000/i, /aggregat/i);
  else if (focus === "serious_ill_health_complete") valid = requireAll(/nine.month|under (?:one year|12 months)/i, /uncrystalli[sz]/i, /70|under 75/i, /£?120,?000/i, /lump sum and death benefit allowance|LSDBA/i);

  else if (focus === "annual_allowance_dated_fact") valid = requireAll(/£?60,?000/i, /2026\/?27|2026\s+(?:to|–|-)\s+2027/i, /MPAA|money purchase/i, /taper|adjusted income|threshold income/i);
  else if (focus === "taper_fact_gap") valid = requireAll(/salary[^.]{0,100}(?:not enough|insufficient|cannot)|cannot[^.]{0,100}salary/i, /threshold income/i, /adjusted income/i, /£?200,?000/i, /£?260,?000/i);
  else if (focus === "mpaa_trigger") valid = requireAll(/1 June 2026/i, /not (?:trigger|start)|did not/i, /1 September 2026/i, /trigger/i);
  else if (focus === "carry_forward") valid = requireAll(/previous.three|3 previous|three prior|3 prior/i, /pension input/i, /member|membership/i, /oldest/i);
  else if (focus === "lump_sum_allowance_usage") valid = requireAll(/£?268,?275/i, /not (?:prove|mean)|does not (?:prove|mean)|cannot assume/i, /pre.2024|6 April 2024|lifetime allowance/i, /protection|certificate/i);
  else if (focus === "lsdba_fact_gap") valid = requireAll(/age at death|death age/i, /payment type|lump sum/i, /prior|history|allowance usage/i, /protection|certificate|remaining/i);
  else if (focus === "transitional_protection") valid = requireAll(/cannot ignore|not ignore|still (?:affect|relevant)|may (?:affect|increase)/i, /protection/i, /lump sum allowance|LSA|LSDBA/i);
  else if (focus === "overseas_transfer_charge") valid = requireAll(/QROPS/i, /residen/i, /destination|country/i, /overseas transfer allowance/i, /25%|25 per cent/i);
  else if (focus === "tax_year_allocation") valid = requireAll(/2025\/?26/i, /4 April 2026/i, /provider receive|received/i, /employer contribution/i, /actual payment date|paid/i);
  else if (focus === "employer_vs_member_contribution") valid = requireAll(/not (?:the )?same|cannot assume|different/i, /relevant UK earnings|relief at source|personal contribution/i, /wholly and exclusively|employer|deduct/i, /annual[- ]allowance/i);
  else if (focus === "provider_label_vs_tax_facts") valid = requireAll(/label[^.]{0,100}(?:not|cannot)|not[^.]{0,100}label/i, /crystalli[sz]ation/i, /allowance|protection|payment type/i);
  else if (focus === "personal_tax_calculation_boundary") valid = requireAll(/£?54,?000/i, /£?12,?570/i, /£?41,?430/i, /£?10,?662\.05/i, /PAYE/i, /prior pay|pay period|tax already/i);
  else if (focus === "tax_2026_27_direct_figures") valid = requireAll(/£?60,?000/i, /£?10,?000/i, /£?200,?000/i, /£?260,?000/i, /£?50,?000/i);
  else if (focus === "carry_forward_fact_complete") valid = requireAll(/£?40,?000/i, /£?30,?000/i, /£?10,?000/i, /£?80,?000/i, /(?:nil|zero|no) (?:amount|excess)|£?0/i);
  else if (focus === "db_pension_input_calculation") valid = requireAll(/16/i, /3\.8%|3\.8 per cent|1\.038/i, /£?398,?592/i, /£?440,?000/i, /£?41,?408/i);
  else if (focus === "mpaa_trigger_matrix") valid = requireAll(/PCLS/i, /taxable drawdown/i, /UFPLS/i, /small.pot/i, /lifetime annuity/i, /does not|not trigger/i);
  else if (focus === "alternative_annual_allowance_application") valid = requireAll(/£?14,?000/i, /£?10,?000/i, /£?4,?000/i, /£?46,?000/i, /£?50,?000/i, /no (?:DB|separate) excess|within/i);
  else if (focus === "scheme_pays_mandatory_voluntary") valid = requireAll(/mandatory/i, /voluntary/i, /£?2,?000|threshold/i, /election|notice/i, /deadline|31 July/i);
  else if (focus === "overseas_transfer_charge_post_2024_change") valid = requireAll(/30 October 2024/i, /EEA|Gibraltar/i, /removed|no longer/i, /25%|25 per cent/i);
  else if (focus === "lump_sum_allowance_prior_event_conversion") valid = requireAll(/40%|40 per cent/i, /£?107,?310/i, /£?268,?275/i, /£?160,?965/i, /transitional tax.free amount certificate/i);

  else if (focus === "iht_death_before_commencement") valid = deathBeforePensionIhtCommencement(answer, result.question);
  else if (focus === "iht_death_on_commencement") valid = requireAll(/6 April 2027/i, /notional pension property|estate/i, /unused/i, /secondary legislation|regulations/i, /guidance/i);
  else if (focus === "iht_income_tax_interaction") valid = requireAll(/inheritance tax|IHT/i, /estate/i, /income tax/i, /beneficiar/i, /separate|different/i);
  else if (focus === "iht_secondary_legislation_status") valid = requireAll(/Finance Act 2026/i, /enacted|high.level|scope/i, /secondary legislation|regulations/i, /form|information/i, /not final|forthcoming|cannot.*final/i);
  return valid ? [] : ["material_legal_or_commencement_error"];
}

const items = results.results.map((result) => {
  const served = FORMAL_QUALIFICATION ? verifyServedResponseReceipt(result,{ outputRoot:resolve(ROOT,"diagnostic",RUN_LABEL) }) : null;
  if (FORMAL_QUALIFICATION && !served.passed) throw new Error(`Served-response receipt failed for ${result.question_id}: ${served.failures.join("; ")}`);
  const item = goldById.get(result.question_id);
  if (!item) throw new Error(`Missing gold draft for ${result.question_id}`);
  const checks = item.required_checks.map((check) => Number(overlap(result.final_system_answer, check).toFixed(4)));
  const average = checks.length ? checks.reduce((sum, value) => sum + value, 0) / checks.length : 0;
  let content = average >= 0.42 ? 4 : average >= 0.30 ? 3 : average >= 0.18 ? 2 : 1;
  const route = routeCompatible(item.expected_route, result.selected_route) ? 1.5 : 0;
  const jurisdiction = jurisdictionCompatible(item.expected_jurisdiction, result.selected_jurisdiction) ? 0.5 : 0;
  const deterministic = ["REFUSE_ACTION", "HUMAN_HANDOFF", "CLARIFY_THEN_ANSWER"].includes(result.selected_route) || ["deterministic_evidence_policy","served_product_deterministic_path"].includes(result.grounding_validation?.reason);
  const grounding = result.grounding_validation?.valid ? 3 : ["SECURITY_FALLBACK", "INSUFFICIENT_EVIDENCE", "GROUNDING_FALLBACK"].includes(result.selected_route) ? 1.5 : 0;
  const targetDocuments = new Set(item.proposition_citation_targets.flatMap((target) => target.source_targets || []));
  const citedTargetDocument = (result.generated_citations || []).some((citation) => [...targetDocuments].some((documentId) => citation === documentId || citation.startsWith(`${documentId}_chunk_`)));
  const citations = deterministic ? 1 : result.grounding_validation?.valid && citedTargetDocument ? 1 : result.grounding_validation?.valid && (result.generated_citations || []).length ? 0.5 : 0;
  const policyCritical = criticalFailures(result, item);
  const substantive = substantiveCriticalFailures(result, item);
  if (item.review_focus && !substantive.length && content < 3) content = 3;
  const total = Number((content + route + jurisdiction + grounding + citations).toFixed(1));
  const critical = [...new Set(item.risk_tier === "critical" ? [...policyCritical, ...substantive] : policyCritical)];
  const materialCriticalFailure = item.risk_tier === "critical" && total < 8;
  const status = critical.length || materialCriticalFailure ? "critical_fail" : substantive.length ? "fail" : result.selected_route === "RUN_ERROR" ? "fail" : total >= 8 ? "pass" : total >= 5 ? "partial" : "fail";
  return {
    question_id: result.question_id,
    topic_id: result.topic_id,
    status,
    total_score: total,
    components: { legal_and_required_content: content, expected_route: route, jurisdiction, grounding, citations },
    required_check_overlap: checks,
    expected_route: item.expected_route,
    actual_route: result.selected_route,
    expected_jurisdiction: item.expected_jurisdiction,
    actual_jurisdiction: result.selected_jurisdiction,
    critical_failure_signals: critical,
    substantive_failure_signals: substantive,
    grounding_reason: result.grounding_validation?.reason || null,
    latency_ms: result.latency_ms,
    review_status: "provisional_automated_score_pending_independent_gold_review",
    served_response_verified:FORMAL_QUALIFICATION,
    served_answer_sha256:served?.served_answer_sha256 || null,
    served_response_receipt_sha256:result.served_response_receipt?.sha256 || null,
    served_raw_response_sha256:result.served_response_receipt?.raw_sha256 || null,
  };
});

const outcomes = countBy(items.map((item) => item.status));
const topics = [...new Set(items.map((item) => item.topic_id))].map((topicId) => {
  const topicItems = items.filter((item) => item.topic_id === topicId);
  const passed = topicItems.filter((item) => item.status === "pass").length;
  return { topic_id: topicId, total: topicItems.length, pass: passed, pass_rate: Number((100 * passed / topicItems.length).toFixed(1)), critical_failures: topicItems.filter((item) => item.status === "critical_fail").length };
});
const passCount = outcomes.pass || 0;
const passRate = Number((100 * passCount / items.length).toFixed(1));
const runErrors = results.results.filter((item) => item.selected_route === "RUN_ERROR").length;
const criticalCount = outcomes.critical_fail || 0;
const scoredItemIds = new Set(items.map((item) => item.question_id));
const criticalRiskItems = new Set(gold.items.filter((item) => scoredItemIds.has(item.id) && item.critical_failure_signals.length).map((item) => item.id));
const criticalRiskPasses = items.filter((item) => criticalRiskItems.has(item.question_id) && item.status === "pass").length;
const gatePassed = runErrors === 0 && criticalCount === 0 && passRate >= 90 && topics.every((topic) => topic.pass_rate >= 85) && criticalRiskPasses === criticalRiskItems.size;
const scorecard = {
  results_sha256: createHash("sha256").update(readFileSync(RESULTS_PATH)).digest("hex"),
  version: `evaluation-cycle-v2-${WAVE}-provisional-scorecard-v2`,
  scoring_evidence: Object.fromEntries(["scripts/evaluationCycleV2Wave1Score.mjs", "scripts/lib/temporalScoring.mjs", "scripts/lib/releaseContentChecks.mjs", GOLD_PATH].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
  generated_at: new Date().toISOString(),
  status: "provisional_development_scoring_pending_independent_gold_review",
  official_model_selection_eligible: false,
  scoring_policy: { total: 10, pass_mark: 8, overall_gate_pass_rate: 90, per_topic_gate_pass_rate: 85, zero_critical_failures: true, zero_run_errors: true, all_critical_risk_items_must_pass: true },
  outcomes,
  pass_rate: passRate,
  run_errors: runErrors,
  critical_risk_items: criticalRiskItems.size,
  critical_risk_passes: criticalRiskPasses,
  topics,
  diagnostic_gate: gatePassed ? "passed_provisionally" : "failed",
  items,
};
writeFileSync(OUTPUT_PATH, `${JSON.stringify(scorecard, null, 2)}\n`);
const topicRows = topics.map((topic) => `| ${topic.topic_id} | ${topic.pass}/${topic.total} | ${topic.pass_rate}% | ${topic.critical_failures} |`).join("\n");
const failureRows = items.filter((item) => item.status !== "pass").map((item) => `| ${item.question_id} | ${item.topic_id} | ${item.status} | ${item.total_score} | ${item.expected_route} | ${item.actual_route} | ${item.critical_failure_signals.join(", ") || "—"} |`).join("\n") || "| — | — | — | — | — | — | — |";
writeFileSync(MARKDOWN_PATH, `# Cycle v2 Wave ${WAVE_NUMBER} provisional diagnostic scorecard\n\nGate: **${scorecard.diagnostic_gate}**. Pass rate: **${passRate}%**. Critical failures: **${criticalCount}**. Run errors: **${runErrors}**.\n\nThis is a development diagnosis only. Gold/rubric and proposition-level source targets still require independent review before the scores become official or unseen execution is authorised.\n\n## Topic gates\n\n| Topic | Pass | Rate | Critical |\n|---|---:|---:|---:|\n${topicRows}\n\n## Items not passed\n\n| ID | Topic | Status | Score | Expected route | Actual route | Critical signal |\n|---|---|---|---:|---|---|---|\n${failureRows}\n`);
console.log(JSON.stringify({ diagnostic_gate: scorecard.diagnostic_gate, outcomes, pass_rate: passRate, critical_failures: criticalCount, run_errors: runErrors, topics }, null, 2));
