import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentHash } from "./lib/trainingEvidenceIntegrity.mjs";
await import("../server/loadEnv.js");
const { initialiseDataStore } = await import("../server/store/userDataStore.js");
const { processQuery } = await import("../server/services/queryProcessorService.js");
const { retrieveForQuery } = await import("../server/services/retrievalService.js");

const INPUT = resolve("training/evaluation-cycle-v2/04-training-data-repair-20260901/source-review-candidates.json");
const ROOT = resolve(process.env.TRAINING_REPAIR_V2_ROOT || "training/evaluation-cycle-v2/05-training-data-repair-revision-20260901");
const OUTPUT = resolve(ROOT, "source-retrieval-v2.json");

const HINTS = {
  "v2-w2-t01-train-001":"Finance Act 2004 section 152 defined benefits money purchase separate arrangements AVC",
  "v2-w2-t01-train-002":"Pension Schemes Act 1993 definition occupational pension scheme personal pension scheme policy classification",
  "v2-w2-t01-train-003":"Pension Schemes Act money purchase benefits cash balance definition individual account master trust",
  "v2-w2-t01-train-004":"Pensions Dashboards Regulations 2022 Schedule 3 collective money purchase value data annualised accrued value",
  "v2-w2-t01-train-005":"Public Service Pensions Act 2013 scheme regulations establish scheme benefits classification",
  "v2-w2-t01-train-006":"Pension Schemes Act 2015 section 48 safeguarded benefits guaranteed annuity rate advice valuation £30000",
  "v2-w2-t02-train-001":"TPR General Code conflicts of interest appointments trustee recusal record decision",
  "v2-w2-t02-train-002":"TPR General Code managing advisers service providers retains ultimate accountability KPI SLA complaints outsourcing",
  "v2-w2-t02-train-003":"pension scheme executed rules member booklet incorrect information maladministration entitlement estoppel",
  "v2-w2-t02-train-004":"pension trustee discretionary decision relevant considerations reasons evidence Pensions Ombudsman Edge",
  "v2-w2-t02-train-005":"Pensions Act 1995 investment duties employer-related investment conflicts trustee powers diversification advice",
  "v2-w2-t02-train-006":"TPR General Code scheme continuity planning pension payments payroll business continuity tested annually",
  "v2r-w2-t02-train-001":"Pensions Act 2004 section 249A effective system governance own risk assessment outsourcing cyber controls accountability",
  "v2-w2-t03-train-001":"Pensions Act 2004 statutory funding objective technical provisions deficit recovery plan promised benefits",
  "v2-w2-t03-train-002":"TPR corporate transaction employer covenant notifiable events contribution notice clearance mitigation",
  "v2-w2-t03-train-003":"Occupational Pension Schemes Employer Debt Regulations flexible apportionment arrangement employment cessation event",
  "v2-w2-t03-train-004":"Pensions Act 2004 technical provisions statutory valuation recovery plan accounting deficit",
  "v2-w2-t03-train-005":"Pensions Act 1995 schedule contributions payment due TPR late contributions material significance reporting",
  "v2-w2-t03-train-006":"Pensions Northern Ireland Order contribution notices financial support corporate transaction regulator powers",
  "v2r-w2-t03-train-001":"TPR DB funding code reasonable affordability recovery plan employer covenant member risk",
  "v2-w2-t04-train-001":"Equality Act 2010 reasonable adjustments services accessible format pension member disability",
  "v2-w2-t04-train-002":"Equality Act 2010 occupational pension age discrimination objective justification early retirement enhancement",
  "v2-w2-t04-train-003":"Equality Act 2010 reasonable adjustments accessible digital complaint portal pension scheme",
  "v2-w2-t04-train-004":"part-time workers pension scheme exclusion Preston limitation periods historical membership",
  "v2-w2-t04-train-005":"Equality Act 2010 Schedule 9 paragraph 18 civil partner survivor pension same sex spouse Walker",
  "v2-w2-t04-train-006":"Northern Ireland Disability Discrimination Act reasonable adjustment occupational pension internal dispute resolution Article 50",
  "v2r-w2-t04-train-001":"public service pensions remedy McCloud annual allowance remedial pension savings statement scheme pays adjustment service",
  "v2r-w2-t05-train-001":"Pension Schemes Act 2026 commencement regulations Royal Assent DC reforms not yet in force",
  "v2r-w2-t05-train-002":"Pension Schemes Act 2026 value for money framework regulations commencement prepare data governance",
  "v2r-w2-t05-train-003":"Pension Schemes Act 2026 DB surplus override commencement April 2027 scheme rules",
  "v2r-w2-t06-train-001":"Pensions Dashboards Regulations ongoing duties error codes records value data connection compliance",
  "v2r-w2-t06-train-002":"pensions dashboards connection public launch availability Money and Pensions Service",
  "v2r-w2-t06-train-003":"Pensions Dashboards Regulations matching records breach reporting complaints TPR hundreds find requests",
  "v2-w3-t01-train-001":"HMRC PTM protected pension age 5 April 2006 unqualified right transfer conditions loss protection",
  "v2-w3-t01-train-002":"early retirement scheme rules actuarial reduction factors consent exact quote evidence missing",
  "v2-w3-t01-train-003":"late retirement DB pension scheme rules actuarial uplift preservation requirements components",
  "v2-w3-t01-train-004":"expression of wish death benefit trustee discretion beneficiary nomination scheme rules",
  "v2-w3-t01-train-005":"pension commencement lump sum commutation scheme rules survivor increases authorised financial advice",
  "v2-w3-t01-train-006":"HMRC PTM123300 pension scheme loan member unauthorised payment pension scam report",
  "v2r-w3-t01-train-001":"HMRC normal minimum pension age 57 6 April 2028 protected pension age ill health",
  "v2r-w3-t01-train-002":"HMRC PTM063700 small pension payments £10000 three non occupational PTM063500 trivial commutation eligible rights",
  "v2-w3-t02-train-001":"HMRC pension schemes rates 2026 2027 annual allowance MPAA taper threshold adjusted income alternative allowance",
  "v2-w3-t02-train-002":"HMRC tapered annual allowance threshold income 200000 adjusted income 260000 2026 2027",
  "v2-w3-t02-train-003":"HMRC MPAA trigger event PCLS UFPLS flexi access drawdown taxable income",
  "v2-w3-t02-train-004":"HMRC lump sum allowance lifetime allowance protection transitional tax free amount certificate",
  "v2-w3-t02-train-005":"HMRC QROPS overseas transfer charge exclusions residence country overseas transfer allowance relevant period",
  "v2-w3-t02-train-006":"HMRC transitional lump sum allowance pre 6 April 2024 benefit crystallisation event lifetime allowance used",
  "v2r-w3-t02-train-001":"HMRC annual allowance carry forward member registered pension scheme previous tax year membership",
  "v2r-w3-t02-train-002":"HMRC MPAA trigger year pre trigger post trigger inputs alternative chargeable amount £10000 £50000",
  "v2r-w3-t02-train-003":"HMRC PTM102300 EEA exclusion requested before 30 October 2024 completed before 30 April 2025 tax residence QROPS",
  "v2r-w3-t03-train-001":"Finance Act 2026 pension inheritance tax deaths on after 6 April 2027 death date payment date transitional",
  "v2r-w3-t03-train-002":"Finance Act 2026 unused pension funds inheritance tax notional pension property 6 April 2027 exclusions implementation guidance"
};

await initialiseDataStore();
mkdirSync(ROOT, { recursive:true });
const source = JSON.parse(readFileSync(INPUT));
const output = existsSync(OUTPUT)
  ? JSON.parse(readFileSync(OUTPUT))
  : { version:"wave4-source-retrieval-v2",generated_at:new Date().toISOString(),status:"retrieved_candidates_pending_proposition_review",training_authorised:false,unseen_accessed:false,items:[] };
if (output.training_authorised !== false || output.unseen_accessed !== false) {
  throw new Error("Refusing to resume a retrieval file with incompatible safety flags");
}
const completedIds = new Set(output.items.map((item) => item.training_id));
for (const item of source.items) {
  if (completedIds.has(item.training_id)) continue;
  const retrievalQuestion = HINTS[item.training_id];
  if (!retrievalQuestion) throw new Error(`Missing construct query for ${item.training_id}`);
  const parsed = processQuery(retrievalQuestion, { resolvedEntities:{ jurisdiction:item.jurisdiction } });
  const queryPlan = { ...parsed,self_contained_query:retrievalQuestion,retrieval_query:retrievalQuestion,source_scopes:["CURATED_PUBLIC"],structured_lookups:[] };
  const found = await retrieveForQuery({ userId:"training-source-repair-v2",sessionId:item.training_id,requestId:`v2-${item.training_id}`,queryPlan,limit:8 });
  output.items.push({ training_id:item.training_id,wave:item.wave,previous_partition:item.partition,construct_id:item.construct_id,
    user_question:item.user_question,question_sha256:item.question_sha256,retrieval_query:retrievalQuestion,
    legacy_answer_for_comparison_only:item.legacy_ideal_answer_for_review_only,review_status:"pending_proposition_review",
    candidates:found.sources.map((s) => ({ source_id:s.sourceId,title:s.title,section:s.section,jurisdiction:s.jurisdiction,
      source_url:s.canonicalLocation,authority_family:s.documentId,effective_date:s.effectiveDate,text:s.snippet,content_sha256:contentHash(s.snippet),
      score:s.score,rerank_score:s.rerankScore,source_role:s.sourceRole,oscola_citation:s.oscolaCitation,
      territorial_effective_dates:s.sourceMetadata?.northernIrelandEffectiveDate ? { great_britain:s.effectiveDate,northern_ireland:s.sourceMetadata.northernIrelandEffectiveDate } : null })),trace:found.trace });
  writeFileSync(OUTPUT, JSON.stringify(output,null,2)+"\n");
  console.log(`${output.items.length}/52 ${item.training_id}: ${found.sources.length}`);
}
output.completed_at=new Date().toISOString();
writeFileSync(OUTPUT, JSON.stringify(output,null,2)+"\n");
