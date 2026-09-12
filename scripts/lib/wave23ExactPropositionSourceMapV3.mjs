const D=(...source_ids)=>({source_ids,support_relationship:"direct_textual_support"});
const S=(...source_ids)=>({source_ids,support_relationship:"multi_source_synthesis"});
const I=(...source_ids)=>({source_ids,support_relationship:"application_inference_from_cited_rule"});
const B=(...source_ids)=>({source_ids,support_relationship:"evidence_gap_or_scope_boundary"});
const Q=(...source_ids)=>({source_ids,support_relationship:"question_fact_calculation_with_source_context"});

// Array position is the position of the material proposition created by the
// Wave 2–3 composer. These are owner-authorised developer/source-review
// determinations for this draft, not independent legal entailment approvals.
export const EXACT_PROPOSITION_SOURCE_MAP={
  "v2-w2-t01-train-001":[D("review-v3-hmrc-ptm023300"),D("review-v3-hmrc-ptm023300"),D("review-v3-hmrc-ptm023300"),B("review-v3-hmrc-ptm023200","review-v3-hmrc-ptm023300")],
  "v2-w2-t01-train-002":[I("official-pension-schemes-act-1993_chunk_3"),D("official-pension-schemes-act-1993_chunk_3"),B("official-pension-schemes-act-1993_chunk_3")],
  "v2-w2-t01-train-003":[D("official-pension-schemes-act-2017_chunk_3"),D("official-hmrc-ptm-ptm020000_chunk_41"),B("official-hmrc-ptm-ptm020000_chunk_41","review-v3-hmrc-ptm023200")],
  "v2-w2-t01-train-004":[B("review-pinned-gb-dashboard-regulations-sch3-p4"),D("review-pinned-gb-dashboard-regulations-sch3-p4"),D("review-pinned-gb-dashboard-regulations-sch3-p4"),B("review-pinned-gb-dashboard-regulations-sch3-p4")],
  "v2-w2-t01-train-005":[B("review-v3-psa1993-s1","review-v3-pspa2013-ss1-8"),D("review-v3-pspa2013-ss1-8"),S("review-v3-psa1993-s1","review-v3-pspa2013-ss1-8")],
  "v2-w2-t01-train-006":[D("review-v3-dwp-gar-classification-valuation"),D("review-v3-dwp-gar-classification-valuation"),S("review-v3-dwp-gar-classification-valuation","official-pension-schemes-act-2015_chunk_57"),B("review-v3-dwp-gar-classification-valuation")],
  "v2-w2-t02-train-001":[D("review-pinned-tpr-general-code-conflicts"),S("review-pinned-tpr-general-code-conflicts","review-v3-tpr-managing-service-providers-full")],
  "v2-w2-t02-train-002":[D("review-v3-tpr-managing-service-providers-full"),S("review-v3-tpr-managing-service-providers-full","review-v3-tpr-dispute-resolution-full"),B("review-v3-tpr-managing-service-providers-full")],
  "v2-w2-t02-train-003":[D("official-tpo-cas-92123-h9g1_chunk_6"),D("official-tpo-cas-92123-h9g1_chunk_6")],
  "v2-w2-t02-train-004":[I("review-pinned-edge-discretion-principle"),S("review-pinned-edge-discretion-principle","review-v3-tpr-dispute-resolution-full")],
  "v2-w2-t02-train-005":[S("review-v3-investment-regulations-2005-reg4","review-pinned-tpr-general-code-conflicts"),S("review-v3-investment-regulations-2005-reg4","official-pensions-act-1995_chunk_43"),D("official-pensions-act-1995_chunk_45"),D("review-v3-investment-regulations-2005-reg4"),D("official-pensions-act-1995_chunk_51"),D("review-pinned-tpr-general-code-conflicts"),D("review-pinned-tpr-general-code-conflicts")],
  "v2-w2-t02-train-006":[I("official-tpr-scheme-continuity-planning_chunk_3"),D("official-tpr-scheme-continuity-planning_chunk_3"),D("official-tpr-scheme-continuity-planning_chunk_3")],
  "v2r-w2-t02-train-001":[D("review-v3-tpr-managing-service-providers-full"),S("official-pensions-act-2004_chunk_356","review-v3-tpr-own-risk-assessment"),S("review-v3-tpr-own-risk-assessment","review-v3-tpr-cyber-controls","review-v3-tpr-managing-service-providers-full"),D("review-v3-tpr-managing-service-providers-full")],
  "v2-w2-t03-train-001":[D("official-pensions-act-2004_chunk_314"),I("official-pensions-act-2004_chunk_314","review-v3-pa1995-s67"),S("official-pensions-act-2004_chunk_314","official-pensions-act-2004_chunk_318","review-v3-pa2004-s227-228"),D("review-v3-pa1995-s67")],
  "v2-w2-t03-train-002":[S("review-pinned-pa2004-corporate-transaction-powers","official-pensions-regulator-notifiable-events-regulations-2005_chunk_3","review-v3-tpr-employer-covenant-transaction"),B("review-pinned-pa2004-corporate-transaction-powers","review-v3-tpr-employer-covenant-transaction")],
  "v2-w2-t03-train-003":[S("review-v3-employer-debt-regulations-reg6e","review-v3-pa1995-s75"),S("review-v3-employer-debt-regulations-reg6e","review-v3-employer-debt-regulations-reg6za"),D("review-v3-employer-debt-regulations-reg6za"),S("review-v3-employer-debt-regulations-reg6e","review-v3-employer-debt-regulations-reg6za","review-v3-pa1995-s75")],
  "v2-w2-t03-train-004":[S("official-pensions-act-2004_chunk_314","official-pensions-act-2004_chunk_318"),B("official-pensions-act-2004_chunk_314","official-pensions-act-2004_chunk_318"),S("official-pensions-act-2004_chunk_314","official-pensions-act-2004_chunk_317","official-pensions-act-2004_chunk_318")],
  "v2-w2-t03-train-005":[B("official-pensions-act-1995_chunk_140","review-v3-pa2004-s227-228"),B("official-pensions-act-1995_chunk_140","review-v3-pa2004-s227-228"),D("official-pensions-act-1995_chunk_140"),D("review-v3-pa2004-s227-228"),B("official-pensions-act-1995_chunk_140","review-v3-pa2004-s227-228"),S("official-pensions-act-1995_chunk_140","official-pensions-act-1995_chunk_141","review-v3-pa2004-s227-228"),S("official-pensions-act-1995_chunk_141","review-v3-pa2004-s227-228","review-v4-tpr-reporting-breaches-complete")],
  "v2-w2-t03-train-006":[B("review-v3-ni-order-2005-arts34-38","review-pinned-pa2004-corporate-transaction-powers"),B("review-v3-ni-order-2005-arts34-38","review-pinned-pa2004-corporate-transaction-powers"),D("review-v3-ni-order-2005-arts34-38"),D("review-v3-ni-order-2005-arts39-47"),D("review-v3-ni-order-2005-arts64-65"),B("review-pinned-pa2004-corporate-transaction-powers")],
  "v2r-w2-t03-train-001":[D("review-v3-funding-regulations-2024-reg20","review-v3-tpr-db-recovery-plans"),D("review-v3-funding-regulations-2024-reg20","review-v3-tpr-db-recovery-plans"),I("review-v3-funding-regulations-2024-reg20","review-v3-tpr-db-recovery-plans"),S("review-v3-funding-regulations-2024-reg20","review-v3-tpr-db-recovery-plans"),B("review-v3-funding-regulations-2024-reg20","review-v3-tpr-db-recovery-plans"),B("review-v3-funding-regulations-2024-reg20","review-v3-tpr-db-recovery-plans")],
  "v2-w2-t04-train-001":[I("review-pinned-equality-act-2010-s20","review-pinned-equality-act-2010-ss61-63"),S("review-pinned-equality-act-2010-s20","review-pinned-equality-act-2010-ss61-63")],
  "v2-w2-t04-train-002":[D("review-pinned-equality-act-2010-s13"),D("review-v3-equality-age-exceptions-order-2010"),S("review-pinned-equality-act-2010-s13","review-pinned-equality-act-2010-ss61-63"),I("review-pinned-equality-act-2010-s13","review-v3-equality-age-exceptions-order-2010")],
  "v2-w2-t04-train-003":[S("review-pinned-equality-act-2010-s20","review-pinned-equality-act-2010-ss61-63","review-v3-tpr-dispute-resolution-full"),S("review-pinned-equality-act-2010-s20","review-v3-tpr-dispute-resolution-full"),B("review-v3-tpr-dispute-resolution-full")],
  "v2-w2-t04-train-004":[S("review-pinned-part-time-workers-regs-2000","review-pinned-preston-c78-98"),D("review-pinned-part-time-workers-regs-2000"),D("review-pinned-preston-c78-98"),S("review-pinned-part-time-workers-regs-2000","review-pinned-preston-c78-98")],
  "v2-w2-t04-train-005":[B("official-equality-act-2010_chunk_454","review-v3-walker-v-innospec"),S("official-equality-act-2010_chunk_454","review-v3-walker-v-innospec"),S("official-equality-act-2010_chunk_454","official-equal-treatment-occupational-pension-schemes-regulations-2023_chunk_5","official-equal-treatment-occupational-pension-schemes-regulations-2023_chunk_6","review-v3-walker-v-innospec"),B("official-equality-act-2010_chunk_454","official-equal-treatment-occupational-pension-schemes-regulations-2023_chunk_6","review-v3-walker-v-innospec")],
  "v2-w2-t04-train-006":[B("review-pinned-dda1995-s4h-ni"),D("review-pinned-dda1995-s4h-ni"),S("official-pensions-northern-ireland-order-1995_chunk_51","official-pensions-northern-ireland-order-1995_chunk_54","review-v3-ni-idrp-regulations-reg2"),S("review-pinned-dda1995-s4h-ni","review-v3-ni-idrp-regulations-reg2")],
  "v2r-w2-t04-train-001":[B("review-v3-hmrc-remedy-adjustment-service","review-v3-hmrc-mccloud-scheme-pays-july-2026"),D("review-v3-hmrc-remedy-adjustment-service"),D("review-v3-mccloud-si-2026-673","review-v3-hmrc-mccloud-scheme-pays-july-2026"),D("review-v3-mccloud-si-2026-673","review-v3-hmrc-mccloud-scheme-pays-july-2026"),B("review-v3-hmrc-remedy-adjustment-service","review-v3-mccloud-si-2026-673","review-v3-hmrc-mccloud-scheme-pays-july-2026")],
  "v2r-w2-t05-train-001":[S("official-pension-schemes-act-2026_chunk_212","official-tpr-pension-schemes-act-2026-status-page_chunk_2"),D("official-pension-schemes-act-2026_chunk_212"),D("official-tpr-pension-schemes-act-2026-status-page_chunk_2"),B("official-pension-schemes-act-2026_chunk_212","official-tpr-pension-schemes-act-2026-status-page_chunk_2")],
  "v2r-w2-t05-train-002":[S("official-pension-schemes-act-2026_chunk_20","official-pension-schemes-act-2026_chunk_22","official-tpr-pension-schemes-act-2026-status-page_chunk_4"),S("review-v3-psa2026-s133","official-tpr-pension-schemes-act-2026-status-page_chunk_4"),S("official-pension-schemes-act-2026_chunk_20","official-pension-schemes-act-2026_chunk_22","official-tpr-pension-schemes-act-2026-status-page_chunk_4","review-v3-psa2026-s133")],
  "v2r-w2-t05-train-003":[S("official-pension-schemes-act-2026_chunk_212","official-tpr-pension-schemes-act-2026-status-page_chunk_13"),S("review-v3-pa1995-s37","official-tpr-pension-schemes-act-2026-status-page_chunk_13"),S("official-pension-schemes-act-2026_chunk_16","official-pension-schemes-act-2026_chunk_212","official-tpr-pension-schemes-act-2026-status-page_chunk_13","review-v3-pa1995-s37")],
  "v2r-w2-t06-train-001":[D("review-v3-tpr-dashboard-post-connection","official-tpr-pensions-dashboards-guidance-2026_chunk_13"),D("official-tpr-pensions-dashboards-guidance-2026_chunk_12","official-tpr-pensions-dashboards-guidance-2026_chunk_13"),D("review-v4-tpr-reporting-breaches-complete"),D("official-tpr-pensions-dashboards-guidance-2026_chunk_13","review-v3-tpr-dashboard-post-connection"),D("official-tpr-pensions-dashboards-guidance-2026_chunk_13"),D("official-tpr-pensions-dashboards-guidance-2026_chunk_13"),D("official-tpr-pensions-dashboards-guidance-2026_chunk_13","review-v3-tpr-dashboard-post-connection"),S("review-v4-tpr-reporting-breaches-complete","review-v3-tpr-dispute-resolution-full")],
  "v2r-w2-t06-train-002":[D("review-v3-tpr-dashboard-public-status","review-v3-tpr-dashboard-post-connection"),D("official-gb-pensions-dashboards-regulations-2022_chunk_7","review-v3-tpr-dashboard-public-status"),D("review-v3-tpr-dashboard-post-connection")],
  "v2r-w2-t06-train-003":[S("official-gb-pensions-dashboards-regulations-2022_chunk_30","official-gb-pensions-dashboards-regulations-2022_chunk_36"),D("review-v4-tpr-reporting-breaches-complete"),I("review-v4-tpr-reporting-breaches-complete"),S("review-pinned-tpr-dispute-resolution-process","review-v4-tpr-reporting-breaches-complete")],
  "v2-w3-t01-train-001":[B("review-v3-hmrc-protected-pension-age"),D("review-v3-hmrc-protected-pension-age"),D("review-v3-hmrc-protected-pension-age"),D("review-v3-hmrc-protected-pension-age"),D("review-v3-hmrc-protected-pension-age")],
  "v2-w3-t01-train-002":[D("review-v3-govuk-early-retirement"),B("review-v3-govuk-early-retirement"),B("review-v3-govuk-early-retirement")],
  "v2-w3-t01-train-003":[D("review-v3-hmrc-late-retirement"),B("review-v3-hmrc-late-retirement")],
  "v2-w3-t01-train-004":[D("official-hmrc-ptm-ptm070000_chunk_4","review-v3-tpo-death-benefit-lump-sums"),D("official-hmrc-ptm-ptm070000_chunk_4","review-v3-tpo-death-benefit-lump-sums"),S("official-hmrc-ptm-ptm070000_chunk_4","review-v3-tpo-death-benefit-lump-sums"),B("review-v3-tpo-death-benefit-lump-sums")],
  "v2-w3-t01-train-005":[D("official-hmrc-ptm-ptm060000_chunk_501"),B("official-hmrc-ptm-ptm060000_chunk_501"),B("official-hmrc-ptm-ptm060000_chunk_501"),D("review-v3-fca-authorisation-check")],
  "v2-w3-t01-train-006":[D("official-hmrc-ptm-ptm120000_chunk_79"),I("official-hmrc-ptm-ptm120000_chunk_79"),S("official-tpr-avoid-and-report-pension-scams_chunk_5","official-tpr-avoid-and-report-pension-scams_chunk_8","review-v3-fca-authorisation-check")],
  "v2r-w3-t01-train-001":[D("review-v3-hmrc-protected-pension-age"),I("review-v3-hmrc-protected-pension-age"),D("review-v3-hmrc-protected-pension-age"),D("review-v3-hmrc-protected-pension-age")],
  "v2r-w3-t01-train-002":[D("review-v3-hmrc-ptm063700"),D("review-v3-hmrc-ptm063500"),B("review-v3-hmrc-ptm063500","review-v3-hmrc-ptm063700")],
  "v2-w3-t02-train-001":[S("official-hmrc-pension-schemes-rates-2026-27_chunk_5","official-hmrc-pension-schemes-rates-2026-27_chunk_7"),S("official-hmrc-pension-schemes-rates-2026-27_chunk_5","official-hmrc-pension-schemes-rates-2026-27_chunk_6","review-v3-hmrc-ptm057100"),S("official-hmrc-pension-schemes-rates-2026-27_chunk_8","review-v3-hmrc-ptm057100")],
  "v2-w3-t02-train-002":[I("official-hmrc-pension-schemes-rates-2026-27_chunk_5","review-v3-hmrc-ptm057100"),S("official-hmrc-pension-schemes-rates-2026-27_chunk_5","review-v3-hmrc-ptm057100"),D("review-v3-hmrc-ptm057100")],
  "v2-w3-t02-train-003":[B("review-pinned-hmrc-ptm056520-current"),S("review-pinned-hmrc-ptm056520-current","official-hmrc-ptm-ptm060000_chunk_367"),B("review-pinned-hmrc-ptm056520-current")],
  "v2-w3-t02-train-004":[D("review-v3-hmrc-ptm174700"),D("review-v3-hmrc-ptm174700"),B("review-v3-hmrc-ptm174700"),B("review-v3-hmrc-ptm174700")],
  "v2-w3-t02-train-005":[B("review-v3-hmrc-ptm102200","review-v3-hmrc-ptm102300"),S("review-v3-hmrc-ptm102200","review-v3-hmrc-ptm102300"),S("review-v3-hmrc-ptm102400","review-v3-hmrc-ptm102900"),D("review-v3-hmrc-ptm102200")],
  "v2-w3-t02-train-006":[D("review-v3-hmrc-ptm174100"),D("review-v3-hmrc-ptm174100"),B("review-v3-hmrc-ptm174100")],
  "v2r-w3-t02-train-001":[S("review-v3-hmrc-ptm055100","review-v3-hmrc-ptm113310-350"),D("review-v3-hmrc-ptm113310-350"),S("review-v3-hmrc-ptm055100","review-v3-hmrc-ptm113310-350"),D("review-v3-hmrc-ptm055100")],
  "v2r-w3-t02-train-002":[D("review-v3-hmrc-ptm056540"),S("review-v3-hmrc-ptm056510-method-only","review-v3-hmrc-ptm056540"),S("review-v3-hmrc-ptm056510-method-only","review-v3-hmrc-ptm056540","official-hmrc-pension-schemes-rates-2026-27_chunk_8"),D("review-v3-hmrc-ptm056510-method-only"),D("review-v3-hmrc-ptm056510-method-only"),D("review-v3-hmrc-ptm056510-method-only")],
  "v2r-w3-t02-train-003":[B("review-v3-hmrc-ptm102300"),D("review-v3-hmrc-ptm102300"),D("review-v3-hmrc-ptm102300"),D("review-v3-hmrc-ptm102200")],
  "v2r-w3-t03-train-001":[I("review-v3-finance-act-2026-ss66-71"),D("review-v3-finance-act-2026-ss66-71"),B("review-v3-finance-act-2026-ss66-71")],
  "v2r-w3-t03-train-002":[D("review-v3-finance-act-2026-ss66-71"),D("review-v3-hmrc-iht-technical-note-2"),D("review-v3-hmrc-iht-technical-note-2")],
};

export function exactSourceMap(trainingId,propositions,evidence){
  const mappings=EXACT_PROPOSITION_SOURCE_MAP[trainingId];
  if(!mappings)throw new Error(`No exact proposition map for ${trainingId}`);
  if(mappings.length!==propositions.length)throw new Error(`Exact proposition map count mismatch for ${trainingId}: ${mappings.length} mappings for ${propositions.length} propositions`);
  const evidenceIds=new Set(evidence.map((source)=>source.source_id));
  return propositions.map((proposition,index)=>{
    const mapping=mappings[index];
    if(!mapping.source_ids.length||mapping.source_ids.some((sourceId)=>!evidenceIds.has(sourceId)))throw new Error(`Invalid exact proposition map for ${trainingId} proposition ${index+1}: ${mapping.source_ids.join(", ")}`);
    return {
      proposition,
      source_ids:mapping.source_ids,
      assignment_method:"owner_authorised_developer_source_review",
      support_relationship:mapping.support_relationship,
      support_determination:"developer_source_reviewed_relationship_not_independent_legal_entailment",
      mapping_review_authority:"owner_authorised",
      independent_legal_approval:false,
    };
  });
}
