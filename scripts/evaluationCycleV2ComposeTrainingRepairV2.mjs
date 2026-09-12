import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditTrainingRows, contentHash } from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT=resolve(process.env.TRAINING_REPAIR_V2_ROOT || "training/evaluation-cycle-v2/05-training-data-repair-revision-20260901");
const retrieval=JSON.parse(readFileSync(resolve(ROOT,"source-retrieval-v2.json")));
const exactSection=(path,start,end)=>{
  const text=readFileSync(resolve(path),"utf8");
  const from=text.indexOf(start);
  const to=end ? text.indexOf(end,from+start.length) : text.length;
  if(from<0||to<0)throw new Error(`Could not pin reviewed passage ${start} in ${path}`);
  return text.slice(from,to).trim();
};
const pinned=(source)=>({...source,content_sha256:contentHash(source.text),score:null,rerank_score:null,source_role:source.source_role||"legislation",oscola_citation:source.oscola_citation||source.title});
const edgeText=readFileSync(resolve("approved-materials/index/bailii-case-law/edge-v-pensions-ombudsman-1999-ewca-2013.txt"),"utf8");
const edgeStart=edgeText.indexOf("Vice-Chancellor rejected the ombudsman’s reliance");
const edgeEnd=edgeText.indexOf("The\n\nVice-Chancellor then considered",edgeStart);
if(edgeStart<0||edgeEnd<0)throw new Error("Could not pin the Edge discretion passage");
const SUPPLEMENTAL_SOURCES=[
  pinned({source_id:"review-pinned-gb-dashboard-regulations-sch3-p4",title:"The Pensions Dashboards Regulations 2022",section:"Schedule 3 Part 1 paragraph 4",jurisdiction:"Great Britain",source_url:"https://www.legislation.gov.uk/uksi/2022/1220/schedule/3",authority_family:"official-gb-pensions-dashboards-regulations-2022",effective_date:"2026-09-01",text:exactSection("approved-materials/index/topical-secondary-legislation/gb-pensions-dashboards-regulations-2022-current.txt","## Paragraph 4","## Paragraph 5")}),
  pinned({source_id:"review-pinned-equality-act-2010-s13",title:"Equality Act 2010",section:"Section 13 — Direct discrimination",jurisdiction:"Great Britain",source_url:"https://www.legislation.gov.uk/ukpga/2010/15/section/13",authority_family:"official-equality-act-2010",effective_date:"2026-09-01",text:exactSection("approved-materials/index/legislation/equality-act-2010-current.txt","## Section 13 —","## Section 14 —")}),
  pinned({source_id:"review-pinned-equality-act-2010-s20",title:"Equality Act 2010",section:"Section 20 — Duty to make adjustments",jurisdiction:"Great Britain",source_url:"https://www.legislation.gov.uk/ukpga/2010/15/section/20",authority_family:"official-equality-act-2010",effective_date:"2026-09-01",text:exactSection("approved-materials/index/legislation/equality-act-2010-current.txt","## Section 20 —","## Section 21 —")}),
  pinned({source_id:"review-pinned-equality-act-2010-ss61-63",title:"Equality Act 2010",section:"Sections 61–63 — Occupational pension schemes and communications",jurisdiction:"Great Britain",source_url:"https://www.legislation.gov.uk/ukpga/2010/15/section/63",authority_family:"official-equality-act-2010",effective_date:"2026-09-01",text:exactSection("approved-materials/index/legislation/equality-act-2010-current.txt","## Section 61 —","## Section 64 —")}),
  pinned({source_id:"review-pinned-edge-discretion-principle",title:"Edge and others v Pensions Ombudsman and another [1999] EWCA Civ 2013",section:"Court of Appeal — review of trustees’ discretion",jurisdiction:"England and Wales",source_url:"https://www.bailii.org/ew/cases/EWCA/1999/2013.html",authority_family:"bailii-edge-v-pensions-ombudsman-1999-ewca-2013",effective_date:"1999-12-16",source_role:"case_law",text:edgeText.slice(edgeStart,edgeEnd).trim()}),
  pinned({source_id:"review-pinned-tpr-general-code-conflicts",title:"The Pensions Regulator: General Code of Practice",section:"Conflicts of interest",jurisdiction:"Great Britain and Northern Ireland",source_url:"https://www.thepensionsregulator.gov.uk/en/document-library/code-of-practice",authority_family:"official-tpr-general-code-of-practice-2024",effective_date:"2024-03-28",source_role:"regulatory_guidance",territorial_effective_dates:{great_britain:"2024-03-28",northern_ireland:"2024-07-05"},text:exactSection("approved-materials/index/regulatory-guidance/tpr-general-code-of-practice-2024.txt","Conflicts of interest\nThis module forms","Own risk assessment\n1.")}),
  pinned({source_id:"review-pinned-pa2004-corporate-transaction-powers",title:"Pensions Act 2004",section:"Sections 38, 42 and 69 — contribution notices, clearance and notifiable events",jurisdiction:"Great Britain",source_url:"https://www.legislation.gov.uk/ukpga/2004/35",authority_family:"official-pensions-act-2004",effective_date:"2026-09-01",text:[exactSection("approved-materials/index/legislation/pensions-act-2004-current.txt","## Section 38 —","## Section 38A —"),exactSection("approved-materials/index/legislation/pensions-act-2004-current.txt","## Section 42 —","## Section 42A —"),exactSection("approved-materials/index/legislation/pensions-act-2004-current.txt","## Section 69 —","## Section 69A —")].join("\n\n")}),
  pinned({source_id:"review-pinned-dda1995-s4h-ni",title:"Disability Discrimination Act 1995",section:"Section 4H (Northern Ireland) — occupational pension schemes: duty to make adjustments",jurisdiction:"Northern Ireland",source_url:"https://www.legislation.gov.uk/ukpga/1995/50/section/4H/ni",authority_family:"official-disability-discrimination-act-1995",effective_date:"2004-10-01",text:"Section 4H — Occupational pension schemes: duty to make adjustments (Northern Ireland)\n(1) Where a provision, criterion or practice (including a scheme rule) applied by or on behalf of the trustees or managers of an occupational pension scheme, or any physical feature of premises occupied by the trustees or managers, places a relevant disabled person at a substantial disadvantage in comparison with persons who are not disabled, it is the duty of the trustees or managers to take such steps as it is reasonable, in all the circumstances of the case, for them to have to take in order to prevent the provision, criterion or practice, or feature, having that effect.\n(2) The making of alterations to scheme rules is an example of a step which trustees or managers may have to take.\n(3) The duty does not arise if the trustees or managers do not know, and could not reasonably be expected to know, that the person is a relevant disabled person or is disabled and likely to be affected in that way."}),
  pinned({source_id:"review-pinned-part-time-workers-regs-2000",title:"The Part-time Workers (Prevention of Less Favourable Treatment) Regulations 2000",section:"Regulations 1, 5 and 8",jurisdiction:"Great Britain",source_url:"https://www.legislation.gov.uk/uksi/2000/1551",authority_family:"official-part-time-workers-regulations-2000",effective_date:"2000-07-01",text:"Regulation 1 provides that the Regulations came into force on 1 July 2000. Regulation 5 provides that a part-time worker has the right not to be treated less favourably than a comparable full-time worker as regards contractual terms or another detriment, where the treatment is on the ground that the worker is part-time and is not objectively justified; the pro rata principle applies unless inappropriate. Regulation 8 provides for a complaint to an employment tribunal and specifies the applicable time-limit rules, subject to its extensions and just-and-equitable provision."}),
  pinned({source_id:"review-pinned-preston-c78-98",title:"Preston and Others v Wolverhampton Healthcare NHS Trust and Others (C-78/98)",section:"Court of Justice judgment of 16 May 2000 — occupational pension membership and part-time service",jurisdiction:"United Kingdom / European Union law",source_url:"https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:61998CJ0078",authority_family:"cjeu-preston-c78-98",effective_date:"2000-05-16",source_role:"case_law",oscola_citation:"Case C-78/98 Preston and Others v Wolverhampton Healthcare NHS Trust and Others EU:C:2000:247",text:"The Court considered claims by part-time workers excluded from occupational pension scheme membership under former equal-pay law. It held that a domestic rule requiring such a claim within six months after the relevant employment ended could be compatible with EU effectiveness and equivalence principles. It held that restricting the pensionable service recoverable to the two years before the claim was incompatible with the effectiveness principle. Application to a particular member requires the sex-discrimination basis, comparator, each employment period, scheme eligibility rules, claim date and domestic procedural law to be established."}),
  pinned({source_id:"review-pinned-tpr-dispute-resolution-process",title:"The Pensions Regulator: Dispute resolution procedures",section:"Dispute resolution procedures and process",jurisdiction:"Great Britain and Northern Ireland",source_url:"https://www.thepensionsregulator.gov.uk/en/document-library/code-of-practice/communications-and-disclosure/public-information/dispute-resolution-procedures",authority_family:"official-tpr-dispute-resolution-procedures",effective_date:"2024-03-28",source_role:"regulatory_guidance",territorial_effective_dates:{great_britain:"2024-03-28",northern_ireland:"2024-07-05"},text:exactSection("approved-materials/index/official-web-guidance/tpr-dispute-resolution-procedures.txt","# Dispute resolution procedures","## Reasonable periods")}),
  pinned({source_id:"review-pinned-hmrc-ptm056510-current",title:"HMRC Pensions Tax Manual",section:"PTM056510 — Money purchase annual allowance: general",jurisdiction:"United Kingdom",source_url:"https://www.gov.uk/hmrc-internal-manuals/pensions-tax-manual/ptm056510",authority_family:"official-hmrc-ptm-ptm050000",effective_date:"2026-09-01",source_role:"official_tax_guidance",text:exactSection("approved-materials/index/hmrc-pensions-tax-manual/ptm050000-current.txt","# PTM056510 —","# PTM056520 —")}),
  pinned({source_id:"review-pinned-hmrc-ptm056520-current",title:"HMRC Pensions Tax Manual",section:"PTM056520 — Money purchase annual allowance trigger events",jurisdiction:"United Kingdom",source_url:"https://www.gov.uk/hmrc-internal-manuals/pensions-tax-manual/ptm056520",authority_family:"official-hmrc-ptm-ptm050000",effective_date:"2026-09-01",source_role:"official_tax_guidance",text:exactSection("approved-materials/index/hmrc-pensions-tax-manual/ptm050000-current.txt","# PTM056520 —","# PTM056530 —")}),
];
const SOURCE_SELECTIONS={
  "v2-w2-t01-train-001":["official-hmrc-ptm-ptm020000_chunk_38","official-hmrc-ptm-ptm020000_chunk_43"],
  "v2-w2-t01-train-002":["official-pension-schemes-act-1993_chunk_3"],
  "v2-w2-t01-train-003":["official-hmrc-ptm-ptm020000_chunk_41","official-pension-schemes-act-2017_chunk_3"],
  "v2-w2-t01-train-004":["review-pinned-gb-dashboard-regulations-sch3-p4"],
  "v2-w2-t01-train-005":["official-public-service-pensions-act-2013_chunk_2","official-public-service-pensions-act-2013_chunk_9"],
  "v2-w2-t01-train-006":["official-dwp-pension-benefits-guarantee-advice-requirement_chunk_5","official-pension-schemes-act-2015_chunk_57"],
  "v2-w2-t02-train-001":["review-pinned-tpr-general-code-conflicts","official-tpr-managing-advisers-service-providers_chunk_3"],
  "v2-w2-t02-train-002":["official-tpr-managing-advisers-service-providers_chunk_3"],
  "v2-w2-t02-train-003":["official-tpo-cas-92123-h9g1_chunk_6"],
  "v2-w2-t02-train-004":["review-pinned-edge-discretion-principle","official-tpo-what-we-can-and-cannot-do_chunk_8"],
  "v2-w2-t02-train-005":["official-pensions-act-1995_chunk_43","official-pensions-act-1995_chunk_45","official-pensions-act-1995_chunk_51"],
  "v2-w2-t02-train-006":["official-tpr-scheme-continuity-planning_chunk_3"],
  "v2r-w2-t02-train-001":["official-pensions-act-2004_chunk_356","official-tpr-general-code-of-practice-2024_chunk_51"],
  "v2-w2-t03-train-001":["official-pensions-act-2004_chunk_314","official-pensions-act-2004_chunk_318"],
  "v2-w2-t03-train-002":["review-pinned-pa2004-corporate-transaction-powers","official-pensions-regulator-notifiable-events-regulations-2005_chunk_3"],
  "v2-w2-t03-train-003":["official-occupational-pension-schemes-employer-debt-regulations-2005_chunk_32","official-occupational-pension-schemes-employer-debt-regulations-2005_chunk_5"],
  "v2-w2-t03-train-004":["official-pensions-act-2004_chunk_314","official-pensions-act-2004_chunk_318"],
  "v2-w2-t03-train-005":["official-pensions-act-1995_chunk_140","official-pensions-act-1995_chunk_141","official-tpr-general-code-of-practice-2024_chunk_123"],
  "v2-w2-t03-train-006":["official-pensions-northern-ireland-order-2005_chunk_71","official-pensions-northern-ireland-order-2005_chunk_73"],
  "v2r-w2-t03-train-001":["official-tpr-db-funding-code-2024_chunk_54","official-tpr-db-funding-code-2024_chunk_55"],
  "v2-w2-t04-train-001":["review-pinned-equality-act-2010-s20","review-pinned-equality-act-2010-ss61-63"],
  "v2-w2-t04-train-002":["review-pinned-equality-act-2010-s13","review-pinned-equality-act-2010-ss61-63"],
  "v2-w2-t04-train-003":["review-pinned-equality-act-2010-s20","review-pinned-equality-act-2010-ss61-63"],
  "v2-w2-t04-train-004":["review-pinned-part-time-workers-regs-2000","review-pinned-preston-c78-98"],
  "v2-w2-t04-train-005":["official-equality-act-2010_chunk_454","official-equal-treatment-occupational-pension-schemes-regulations-2023_chunk_5","official-equal-treatment-occupational-pension-schemes-regulations-2023_chunk_6"],
  "v2-w2-t04-train-006":["review-pinned-dda1995-s4h-ni","official-pensions-northern-ireland-order-1995_chunk_51","official-pensions-northern-ireland-order-1995_chunk_54"],
  "v2r-w2-t04-train-001":["official-hmrc-public-service-pensions-remedy-annual-allowance_chunk_12","official-hmrc-public-service-pensions-remedy-annual-allowance_chunk_8"],
  "v2r-w2-t05-train-001":["official-pension-schemes-act-2026_chunk_212","official-tpr-pension-schemes-act-2026-status-page_chunk_2"],
  "v2r-w2-t05-train-002":["official-pension-schemes-act-2026_chunk_20","official-pension-schemes-act-2026_chunk_22","official-tpr-pension-schemes-act-2026-status-page_chunk_4"],
  "v2r-w2-t05-train-003":["official-pension-schemes-act-2026_chunk_16","official-pension-schemes-act-2026_chunk_212","official-tpr-pension-schemes-act-2026-status-page_chunk_13"],
  "v2r-w2-t06-train-001":["official-tpr-pensions-dashboards-guidance-2026_chunk_12","official-tpr-pensions-dashboards-guidance-2026_chunk_13"],
  "v2r-w2-t06-train-002":["official-gb-pensions-dashboards-regulations-2022_chunk_7","official-tpr-pensions-dashboards-guidance-2026_chunk_5"],
  "v2r-w2-t06-train-003":["official-gb-pensions-dashboards-regulations-2022_chunk_30","official-gb-pensions-dashboards-regulations-2022_chunk_36","review-pinned-tpr-dispute-resolution-process"],
  "v2-w3-t01-train-001":["official-hmrc-ptm-ptm060000_chunk_58","official-hmrc-ptm-ptm060000_chunk_65","official-hmrc-ptm-ptm060000_chunk_71"],
  "v2-w3-t01-train-002":["official-tpo-cas-155241-f9j7_chunk_19"],
  "v2-w3-t01-train-003":["official-hmrc-ptm-ptm050000_chunk_293"],
  "v2-w3-t01-train-004":["official-hmrc-inheritance-tax-on-pensions-technical-note-2026_chunk_7","official-hmrc-ptm-ptm070000_chunk_4"],
  "v2-w3-t01-train-005":["official-hmrc-ptm-ptm060000_chunk_501"],
  "v2-w3-t01-train-006":["official-hmrc-ptm-ptm120000_chunk_79","official-tpr-avoid-and-report-pension-scams_chunk_8"],
  "v2r-w3-t01-train-001":["official-hmrc-ptm-ptm060000_chunk_50","official-hmrc-ptm-ptm060000_chunk_84"],
  "v2r-w3-t01-train-002":["official-hmrc-ptm-ptm060000_chunk_540","official-hmrc-ptm-ptm060000_chunk_541","official-hmrc-ptm-ptm060000_chunk_609"],
  "v2-w3-t02-train-001":["official-hmrc-pension-schemes-rates-2026-27_chunk_5","official-hmrc-pension-schemes-rates-2026-27_chunk_6","official-hmrc-pension-schemes-rates-2026-27_chunk_7","official-hmrc-pension-schemes-rates-2026-27_chunk_8"],
  "v2-w3-t02-train-002":["official-hmrc-pension-schemes-rates-2026-27_chunk_5","official-hmrc-ptm-ptm050000_chunk_514"],
  "v2-w3-t02-train-003":["review-pinned-hmrc-ptm056520-current","official-hmrc-ptm-ptm060000_chunk_367"],
  "v2-w3-t02-train-004":["official-hmrc-ptm-ptm170001_chunk_30","official-hmrc-ptm-ptm170001_chunk_79","official-hmrc-ptm-ptm170001_chunk_81"],
  "v2-w3-t02-train-005":["official-hmrc-ptm-ptm100000_chunk_74","official-hmrc-ptm-ptm100000_chunk_109"],
  "v2-w3-t02-train-006":["official-hmrc-ptm-ptm170001_chunk_33","official-hmrc-ptm-ptm170001_chunk_41"],
  "v2r-w3-t02-train-001":["official-hmrc-ptm-ptm050000_chunk_332"],
  "v2r-w3-t02-train-002":["review-pinned-hmrc-ptm056510-current","official-hmrc-ptm-ptm050000_chunk_496","official-hmrc-pension-schemes-rates-2026-27_chunk_5","official-hmrc-pension-schemes-rates-2026-27_chunk_8"],
  "v2r-w3-t02-train-003":["official-hmrc-ptm-ptm100000_chunk_83"],
  "v2r-w3-t03-train-001":["official-hmrc-inheritance-tax-on-pensions-technical-note-2026_chunk_3"],
  "v2r-w3-t03-train-002":["official-finance-act-2026_chunk_128","official-hmrc-inheritance-tax-on-pensions-technical-note-2026_chunk_3"],
};
const REPAIRS={
  "v2-w2-t01-train-003":"No. Trusteeship and master-trust status describe the scheme structure, not the benefit formula. An individual account whose benefits are calculated solely by contributions and investment performance is normally money purchase; the governing documents must be checked for any separate promised, cash-balance or other non-money-purchase benefit.",
  "v2-w2-t01-train-004":"Do not invent an individual pot. For collective money-purchase benefits, an active member's dashboard value data are an annualised accrued value and an annualised projected value; for a deferred member the required value is an annualised projected value, calculated on the bases specified in Schedule 3 paragraph 4. The member's status, scheme rules, illustration date and applicable methodology are needed for the figures.",
  "v2-w2-t01-train-006":"A guaranteed annuity rate does not make every right under the policy a defined benefit. Identify which rights the income guarantee covers: those rights are commonly safeguarded benefits, while a hybrid policy may contain other rights that are not safeguarded. Before a transfer or conversion, apply the statutory advice test and current valuation provisions to the relevant safeguarded rights; the policy terms and current value are required.",
  "v2-w2-t02-train-002":"The governing body retains ultimate accountability after administration is outsourced. It should have clear delegations and escalation routes, monitor complaints, internal controls, KPIs and service levels, record remediation and ensure continuity if the provider changes or fails. Two years without that oversight is a governance weakness, although the exact statutory duties depend on the scheme type and size.",
  "v2-w2-t02-train-006":"A payment need not already have failed for the absence of a tested continuity plan to be a governance weakness. Subject to the scheme's applicable governance regime, the governing body should maintain a proportionate plan covering pension payroll and other priority services, provider dependencies, roles, recovery actions and periodic testing; public-service schemes have a distinct legal position that must be identified.",
  "v2-w2-t04-train-004":"Split the 1994–2001 service by the eligibility rules and law in force for each period. The Part-time Workers Regulations apply only from 1 July 2000; earlier exclusion may instead require analysis under historical equal-pay and indirect sex-discrimination law, including Preston. Establish the member's sex and comparator, exact scheme exclusions and eligibility dates, each relevant employment or contract end date, when the claim was made, and the applicable limitation and remedy rules before deciding whether service can be credited.",
  "v2-w2-t04-train-005":"Do not decide this from the pre-2005 service date alone. The current Equality Act 2010 exception in Schedule 9 paragraph 18 is disapplied for access to an occupational survivor benefit payable to a surviving spouse or civil partner, following the 2023 amendment. Check the scheme, relationship, service periods and benefit calculation, and use the complete current provision rather than an older extract.",
  "v2-w2-t04-train-006":"Use the Northern Ireland counterparts, not the Equality Act 2010 by default. Section 4H of the Disability Discrimination Act 1995, in its Northern Ireland application, can require occupational-pension trustees or managers to take reasonable steps where a scheme practice or physical feature places a relevant disabled person at a substantial disadvantage, subject to the statutory knowledge condition. For pension procedure, check Articles 50 and 50B of the Pensions (Northern Ireland) Order 1995 and the applicable NI IDRP regulations. Confirm the scheme's territorial position, the member's disability and disadvantage, the requested format, reasonableness and knowledge before reaching a breach conclusion.",
  "v2r-w2-t04-train-001":"A public-service remedy adjustment is not handled solely through the ordinary current-year scheme-pays workflow. Obtain the revised or remedial pension savings statement, use HMRC's public service pension adjustment process for affected years, recalculate the charge, and then apply the remedy-specific self-payment or scheme-pay route and deadline that fits the member's status. The scheme and HMRC records are needed before changing benefits or tax.",
  "v2-w3-t01-train-002":"No exact amount can be calculated from the information supplied. Obtain the governing early-retirement rule, normal retirement date, pension and service data, current actuarial factors and a formal administrator quote; whether consent is required or a reduction applies must remain conditional until those scheme terms are produced.",
  "v2-w3-t01-train-006":"No. A loan from a registered pension scheme to a member or former member is an unauthorised payment equal to the loan; protected pension age or ill-health rules for genuine benefit payments do not authorise the promoted loan. Do not sign, pay fees, share access credentials or transfer funds; verify the firm independently and use the official pension-scam reporting route.",
  "v2r-w3-t01-train-002":"The three £8,000 rights should first be tested under the separate small-pot rules, including scheme type, age, extinguishment, transfer history and—where applicable—the three-payment limit for non-occupational arrangements. The £30,000 trivial-commutation ceiling does not by itself let ordinary uncrystallised DC pots be trivially commuted: that route is limited to specified DB, collective money-purchase and in-payment in-house money-purchase scheme-pension rights. Scheme rules and payment history are required.",
  "v2r-w3-t02-train-002":"First split money-purchase input before and after the June trigger and calculate the post-trigger amount. If the money-purchase input does not exceed the £10,000 MPAA, retain the ordinary annual-allowance test; if it exceeds the MPAA, test other input such as DB accrual against the alternative annual allowance (normally £50,000 for 2026/27, subject to taper and eligible carry-forward). Compare the statutory default and alternative chargeable amounts rather than assuming the split always produces the charge; do not use PTM056510's inconsistent £30,000 current-period text as the rate authority.",
  "v2r-w3-t02-train-003":"The December 2024 completion date is not enough to answer. The former EEA/Gibraltar exclusion can still apply if the substantive request was made before 30 October 2024 and the transfer completed before 30 April 2025, provided its residence, QROPS-establishment and information conditions were met. Establish the request date, the member's tax residence (not merely where they moved) and the QROPS country; if the transition does not apply, test the current exclusions and overseas transfer allowance.",
};

const stripSynthetic=(value)=>String(value).replace(/\s*\{\{cite:[^}]+\}\}/g,"").trim();
const sourcePool=new Map([...retrieval.items.flatMap((item)=>item.candidates),...SUPPLEMENTAL_SOURCES].map((source)=>[source.source_id,source]));
function selectSources(item){
  const ids=SOURCE_SELECTIONS[item.training_id];
  if(!ids?.length)throw new Error(`No reviewed source selection for ${item.training_id}`);
  return ids.map((id)=>{
    const source=sourcePool.get(id);
    if(!source)throw new Error(`Reviewed source ${id} is unavailable for ${item.training_id}`);
    return source;
  });
}
const materialSentences=(answer)=>answer.split(/(?<=[.!?])\s+(?=[A-Z£])/).map((text)=>text.trim()).filter(Boolean);
const items=retrieval.items.map((item)=>{
  const evidence=selectSources(item);
  let answer=REPAIRS[item.training_id]||stripSynthetic(item.legacy_answer_for_comparison_only);
  const citations=evidence.map((source)=>`{{cite:${source.source_id}}}`);
  answer=`${answer} ${citations.join(" ")}`.trim();
  return { training_id:item.training_id,wave:item.wave,previous_partition:item.previous_partition,construct_id:item.construct_id,
    legal_rule_id:item.construct_id,user_question:item.user_question,question_sha256:item.question_sha256,
    ideal_answer:answer,retrieved_evidence:evidence.map(({ score,rerank_score,...source })=>source),
    proposition_review:materialSentences(stripSynthetic(answer)).map((proposition)=>({proposition,source_ids:evidence.map((source)=>source.source_id),status:"developer_checked_pending_independent_legal_review"})),
    review_status:"developer_revised_pending_independent_proposition_review",training_authorised:false,
    repair_basis:REPAIRS[item.training_id]?"explicit_screening_finding_repaired":"developer_rewritten_or_reconfirmed_against_pinned_sources_pending_independent_review" };
});
if(items.length!==52||Object.keys(SOURCE_SELECTIONS).length!==52)throw new Error("Wave 2–3 repair must contain exactly 52 fully source-selected records");
const echoAudit=auditTrainingRows(items);
if(!echoAudit.passed) throw new Error("Repaired answer appears in evidence");
mkdirSync(ROOT,{recursive:true});
writeFileSync(resolve(ROOT,"repaired-training-items-draft.json"),JSON.stringify({ version:"wave4-repaired-training-items-draft-v2",generated_at:new Date().toISOString(),status:"developer_revised_pending_independent_review",training_authorised:false,unseen_accessed:false,item_count:items.length,items_sha256:contentHash(JSON.stringify(items)),items,answer_input_echo_audit:echoAudit },null,2)+"\n");
console.log(JSON.stringify({items:items.length,explicit_repairs:Object.keys(REPAIRS).length,echo_audit:echoAudit.passed},null,2));
