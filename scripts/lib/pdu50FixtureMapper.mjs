import {createHash} from 'node:crypto';
import {writePortfolio} from '../../server/store/userDataStore.js';
import {activateKnowledgeDocument} from '../../server/repositories/knowledgeRepository.js';
import {embedTexts} from '../../server/services/embeddingService.js';
import {cacheDeletePrefix} from '../../server/services/cacheService.js';

const clone=(value)=>JSON.parse(JSON.stringify(value));
const fieldValue=(field)=>field && Object.prototype.hasOwnProperty.call(field,'value') ? field.value : null;
const pct=(fraction)=>fraction != null && fraction !== '' && Number.isFinite(Number(fraction)) ? Number(fraction)*100 : null;
const promptInjectionPattern=/\b(?:ignore (?:all |the )?(?:previous|system) instructions|ignore (?:the )?(?:account )?database|system prompt|developer message|assistant must|reveal (?:the )?prompt|do not follow (?:the )?rules|mark all checks passed)\b/i;

function accountType(account){
  if(account.scheme_type==='DEFINED_BENEFIT')return 'Defined benefit pension';
  if(account.scheme_type==='PERSONAL_DC')return 'Personal pension';
  return 'Workplace pension';
}

function mapAccount(account){
  const balance=account.balance || {};
  const employeeMonthly=fieldValue(account.employee_gross_monthly) ?? fieldValue(account.employee_net_monthly);
  const employerMonthly=fieldValue(account.employer_gross_monthly);
  return {
    id:`acct_pdu_${account.scheme_id}`,
    name:account.name,
    provider:account.name,
    policy:account.policy_id,
    pot:fieldValue(balance),
    potStatus:balance.status || 'MISSING',
    type:accountType(account),
    source:'Synthetic PDU50 authenticated fixture record',
    recordStatus:balance.status || account.employer_percent?.status || 'MISSING',
    lastUpdated:balance.as_of || account.employer_percent?.as_of || 'Not recorded',
    charges:fieldValue(account.annual_charge_percent),
    employerName:account.employer || '',
    schemeName:account.name,
    schemeType:account.scheme_type,
    schemeStatus:account.status,
    employeeContributionPct:fieldValue(account.employee_percent),
    employerContributionPct:fieldValue(account.employer_percent),
    employeeContributionAnnual:employeeMonthly == null ? null : Number(employeeMonthly)*12,
    employerContributionAnnual:employerMonthly == null ? null : Number(employerMonthly)*12,
    recordFacts:clone(account)
  };
}

function mapDocument(document){
  const checked=document.record_status==='VERIFIED_RECORD';
  return {
    id:document.document_id,
    name:document.title,
    provider:document.scheme_id || 'Synthetic record',
    type:'Synthetic private pension record',
    date:document.document_date,
    status:checked?'Checked':'Review',
    confidence:checked?'High':'Unconfirmed',
    source:'Synthetic PDU50 private document',
    recordStatus:document.record_status,
    extracted:{schemeId:document.scheme_id,recordStatus:document.record_status,spanCount:document.spans?.length || 0}
  };
}

export function mapPduFixtureToPortfolio(fixture){
  if(fixture?.data_kind!=='SYNTHETIC_DEVELOPMENT_ONLY_NOT_OWNER_DATA')throw new Error('Only explicitly synthetic PDU50 fixtures may be mapped');
  if(!fixture.user_id)throw new Error('Fixture user_id is required');
  const projection=fixture.projection || {};
  const dbAccount=(fixture.accounts || []).find((account)=>account.scheme_type==='DEFINED_BENEFIT');
  const allocation=fixture.allocation || {};
  const state=fixture.state_pension || {};
  return {
    userId:fixture.user_id,
    profile:{name:fixture.profile?.display_name || 'New user',source:'Synthetic PDU50 authenticated fixture record',employer:fixture.profile?.current_employer || '',previousEmployer:fixture.profile?.previous_employer || '',jurisdiction:fixture.profile?.employment_jurisdiction || ''},
    assumptions:{
      currentAge:projection.current_age ?? fixture.profile?.current_age_years_for_projection ?? null,
      retirementAge:projection.retirement_age ?? null,
      monthlyTarget:projection.target_monthly_income_today_money_gbp ?? null,
      salary:fieldValue(fixture.profile?.annual_salary),
      totalContributionPct:null,
      grossMonthlyContribution:projection.total_gross_monthly_credit_gbp ?? null,
      extraMonthlyContribution:0,
      growthPct:pct(projection.annual_nominal_growth),inflationPct:pct(projection.annual_inflation),chargePct:pct(projection.annual_fee_rate),drawdownPct:pct(projection.annual_drawdown_rate),
      dbMonthly:projection.db_annual_income_today_money_gbp == null ? (fieldValue(dbAccount?.annual_pension)==null?null:Number(fieldValue(dbAccount.annual_pension))/12) : Number(projection.db_annual_income_today_money_gbp)/12,
      dbIncomeStartAge:projection.db_income_start_age ?? fieldValue(dbAccount?.normal_pension_age)
    },
    accounts:(fixture.accounts || []).map(mapAccount),
    statePension:{name:'State Pension Forecast',monthlyIncome:projection.state_monthly_income_today_money_gbp ?? fieldValue(state.forecast_monthly_today_money),startAge:projection.state_income_start_age ?? fieldValue(state.forecast_start_age),source:'Synthetic PDU50 stored forecast',lastUpdated:state.forecast_monthly_today_money?.as_of || fixture.case_as_of},
    savings:{currentSavings:fieldValue(fixture.cash_buffer?.balance) ?? 0,monthlyExpenses:fieldValue(fixture.cash_buffer?.monthly_expenses) ?? 0,targetMonths:3,lastUpdated:fixture.cash_buffer?.balance?.as_of || fixture.case_as_of},
    investmentProfile:{currentStyle:'Not assessed',equityExposure:allocation.equity_percent==null?'Not recorded':`${allocation.equity_percent}%`,bondExposure:allocation.bonds_percent==null?'Not recorded':`${allocation.bonds_percent}%`,cashOther:allocation.cash_percent==null?'Not recorded':`${allocation.cash_percent}%`,allocation:[['Equity',allocation.equity_percent],['Bonds',allocation.bonds_percent],['Cash',allocation.cash_percent]].filter(([,value])=>value!=null).map(([label,value])=>({label,value:`${value}%`})),accountsByStrategy:[]},
    documents:(fixture.documents || []).map(mapDocument),
    supplementalRecords:{annual_inputs:fixture.annual_inputs ?? null,withdrawals:fixture.withdrawals ?? null,leave:fixture.leave ?? null,enrolment:fixture.enrolment ?? null,family_status:fixture.family_status ?? null,security:fixture.security ?? null,fixture_record:{record_version:fixture.record_version,case_as_of:fixture.case_as_of,data_kind:fixture.data_kind}},
    systemUpdate:{date:fixture.case_as_of,label:'Synthetic PDU50 fixture version',note:`Development-only record ${fixture.record_version}; not owner or customer data.`}
  };
}

export function applyAuthorisedPduMutation(fixture,mutation){
  if(!mutation || mutation.operation!=='APPLY_AUTHORISED_SYNTHETIC_RECORD_VERSION_BEFORE_TURN_2')throw new Error('Mutation is not authorised by the PDU50 harness');
  if(mutation.fixture_id!==fixture.fixture_id)throw new Error('Mutation fixture mismatch');
  const next=clone(fixture);
  const account=next.accounts.find((item)=>item.scheme_id===mutation.account_updates?.scheme_id);
  if(!account)throw new Error('Mutation target account is missing');
  const previousAccount=clone(account);
  for(const [key,value] of Object.entries(mutation.account_updates))if(key!=='scheme_id')account[key]=clone(value);
  if(mutation.invalidate_or_recompute?.includes('projection total gross monthly credit') && next.projection){
    // Apply only explicitly recorded gross-credit differences. Missing amounts
    // invalidate the derived total; percentages never imply a salary basis.
    const changedCredits=['employee_gross_monthly','employer_gross_monthly','total_gross_monthly'].filter((key)=>Object.hasOwn(mutation.account_updates,key));
    const total=next.projection.total_gross_monthly_credit_gbp;
    const known=changedCredits.length>0 && typeof total==='number' && Number.isFinite(total)
      && changedCredits.every((key)=>[fieldValue(previousAccount[key]),fieldValue(account[key])].every((value)=>typeof value==='number' && Number.isFinite(value)));
    const overlapping=changedCredits.includes('total_gross_monthly') && changedCredits.length>1;
    next.projection.total_gross_monthly_credit_gbp=known && !overlapping
      ? total+changedCredits.reduce((sum,key)=>sum+fieldValue(account[key])-fieldValue(previousAccount[key]),0)
      : null;
  }
  if(mutation.new_document)next.documents.push(clone(mutation.new_document));
  next.record_version=mutation.new_record_version;
  return next;
}

function knowledgeDocument(document,userId){
  const text=(document.spans || []).map((span)=>span.text).join('\n\n');
  return {id:document.document_id,userId,version:1,title:document.title,authority:'Synthetic user record',jurisdiction:'Not legal authority',canonicalLocation:null,publishedAt:document.document_date,effectiveDate:document.document_date,expiryDate:null,checksum:createHash('sha256').update(text).digest('hex'),licence:'synthetic-development-only',mimeType:'text/plain',objectKey:null,normalizedTextKey:null,scope:'USER_DOCUMENTS',status:'processing',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),metadata:{sourceType:'synthetic_private_record',sourceRole:'private_user_document',recordStatus:document.record_status,origin:document.origin,publicLegalAuthority:false}};
}

export async function seedPduFixture(fixture,{writePortfolioFn=writePortfolio,activateKnowledgeDocumentFn=activateKnowledgeDocument,embedTextsFn=embedTexts,cacheDeletePrefixFn=cacheDeletePrefix}={}){
  const portfolio=mapPduFixtureToPortfolio(fixture);
  const written=writePortfolioFn(fixture.user_id,portfolio);
  let chunkCount=0,quarantinedChunkCount=0,degradedEmbedding=false;
  for(const document of fixture.documents || []){
    const spans=document.spans || [];
    const embedded=await embedTextsFn(spans.map((span)=>span.text));
    degradedEmbedding ||= Boolean(embedded.degraded);
    const chunks=spans.map((span,index)=>{
      const quarantined=promptInjectionPattern.test(span.text);
      if(quarantined)quarantinedChunkCount+=1;
      return {id:span.span_id,documentId:document.document_id,userId:fixture.user_id,sectionPath:span.locator || 'Locator not recorded',ordinal:index,content:span.text,tokenCount:String(span.text).split(/\s+/).filter(Boolean).length,embedding:embedded.embeddings[index],metadata:{spanId:span.span_id,locator:span.locator,recordStatus:document.record_status,documentVersion:1,scope:'USER_DOCUMENTS',quarantined,quarantineReason:quarantined?'prompt_injection_signal':null}};
    });
    await activateKnowledgeDocumentFn(fixture.user_id,knowledgeDocument(document,fixture.user_id),chunks);
    chunkCount+=chunks.length;
  }
  await cacheDeletePrefixFn(`retrieval:${fixture.user_id}:`);
  return {scope:'PDU50_VISIBLE_DEVELOPMENT_ONLY',fixture_id:fixture.fixture_id,user_id:fixture.user_id,record_version:fixture.record_version,physical_store:'configured userDataStore',portfolio_written:Boolean(written),documents_written:(fixture.documents || []).length,chunks_written:chunkCount,quarantined_chunks:quarantinedChunkCount,degraded_embedding:degradedEmbedding,evaluator_material_loaded:false};
}
