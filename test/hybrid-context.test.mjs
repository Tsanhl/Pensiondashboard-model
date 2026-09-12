import test from 'node:test';
import assert from 'node:assert/strict';
import {recordProvenance,resolvePortfolioAccounts} from '../server/services/portfolioEvidenceService.js';
import {processQuery} from '../server/services/queryProcessorService.js';
import {getVerifiedDashboardContext} from '../server/portfolioStore.js';
import {lookupStructuredData} from '../server/services/structuredDataService.js';
import {writePortfolio,writeKnowledgeDocuments,writeKnowledgeChunks} from '../server/store/userDataStore.js';
import {searchKnowledge} from '../server/repositories/knowledgeRepository.js';
import {answerOutcome} from '../server/services/answerOutcomeService.js';
import {validateGroundedAnswer} from '../server/services/groundingService.js';
import {isAnnotationOnlyPassage} from '../server/services/legalPassageService.js';
import {selectEvidenceExcerpt} from '../server/services/evidenceExcerptService.js';
import {buildCanonicalFacts} from '../server/services/canonicalFactService.js';
import {runChat} from '../server/services/chatService.js';

const accounts=[{id:'a1',provider:'Provider A',policy:'PA12345',type:'Workplace pension',schemeType:'Master trust'},
 {id:'a2',provider:'Provider A',policy:'PA67890',type:'Workplace pension',schemeType:'Group personal pension'},
 {id:'a3',provider:'Provider B',policy:'PB12345',type:'Personal pension'}];
test('provider ambiguity, policy precedence and workplace filtering use account identity',()=>{
 assert.equal(resolvePortfolioAccounts({pensionAccounts:accounts},{provider:'Provider A'}).ambiguous,true);
 assert.equal(resolvePortfolioAccounts({pensionAccounts:accounts},{provider:'Provider A',policyNumber:'PA67890'}).selectedAccountId,'a2');
 assert.deepEqual(resolvePortfolioAccounts({pensionAccounts:accounts},{},'my workplace scheme').accountIds,['a1','a2']);
 const q=processQuery('Check the legal route for changing my workplace pension scheme.',{accounts,providers:['Provider A','Provider B'],profileJurisdiction:'England'});
 assert.equal(q.jurisdiction_scope,'UNSPECIFIED');
 assert.ok(q.missing_facts.includes('account_selection'));assert.equal(q.needs_clarification,false);
 assert.equal(processQuery('I live in England. Can my employer change my scheme?',{accounts}).jurisdiction_scope,'UNSPECIFIED');
});
test('explicit account change replaces stale conversation selection',()=>{
 const q=processQuery('Use policy PA67890 instead. Can my employer change future contributions?',{accounts,providers:['Provider A','Provider B'],resolvedEntities:{accountId:'a1',provider:'Provider A',policyNumber:'PA12345'}});
 assert.equal(q.entities.accountId,'a2');assert.equal(q.entities.policyNumber,'PA67890');
});
test('rewritten follow-up retains semantic history as well as jurisdiction for retrieval',()=>{
 const q=processQuery('And if it reduces them to 4%?',{accounts:[],lastUserMessage:'An employer proposes to reduce future pension contributions in an occupational defined-contribution scheme in England.',resolvedEntities:{jurisdiction:'GREAT_BRITAIN'}});
 assert.match(q.retrieval_query,/occupational defined-contribution/);assert.equal(q.legal_evidence_required,true);
 assert.equal(q.missing_facts.includes('scheme_type'),false);assert.equal(q.missing_facts.includes('applicable_jurisdiction'),false);
});
test('record labels never imply provider verification; confirmations retain their distinct provenance',()=>{
 assert.equal(recordProvenance({source:'Provider-linked'}).status,'unknown');
 assert.equal(recordProvenance({source:'Manual entry'}).status,'user_entered');
 assert.equal(recordProvenance({confirmedAt:'2026-09-09'}).status,'user_confirmed');
 assert.equal(recordProvenance({source:'Upload'}).status,'extracted');
 assert.equal(recordProvenance({verification:{status:'provider_verified',receiptId:'receipt1',verifiedAt:'2026-09-09'}}).status,'provider_verified');
});
test('request snapshot is stable while subsequent requests see updates; zero differs from missing',()=>{
 const user='hybrid-synthetic-user';
 writePortfolio(user,{accounts:[{...accounts[0],source:'Manual entry',employerContributionPct:0,employerContributionAnnual:0}],profile:{}});
 const before=getVerifiedDashboardContext({userId:user});
 assert.equal(before.pensionAccounts[0].facts.employerContributionPct,0);
 assert.equal(before.pensionAccounts[0].facts.employeeContributionPct,null);
 assert.equal(before.pensionAccounts[0].employerYearly,'£0 /yr');
 writePortfolio(user,{accounts:[{...accounts[0],employerContributionPct:7}],profile:{}});
 const query={structured_lookups:['account']};
 const old=lookupStructuredData(user,query,before),latest=lookupStructuredData(user,query);
 assert.equal(old.sources[0].facts[0].employerContributionPct,0);assert.equal(latest.sources[0].facts[0].employerContributionPct,7);
 assert.notEqual(old.sources[0].sourceId,latest.sources[0].sourceId);
 assert.equal(buildCanonicalFacts(user,before).facts['accountsById.a1.employerContributionPercent'].value,0);
 assert.throws(()=>lookupStructuredData('different-user',query,before),/mismatch/);
});
test('canonical facts retain two accounts at the same provider without overwriting values',()=>{
 const user='hybrid-two-accounts';writePortfolio(user,{accounts:[{...accounts[0],pot:100},{...accounts[1],pot:900}]});
 const facts=buildCanonicalFacts(user).facts;
 assert.equal(facts['accountsById.a1.pot'].value,100);assert.equal(facts['accountsById.a2.pot'].value,900);
 assert.equal(facts['accounts.provider_a.pot'],undefined);
});
test('canonical total is cited to calculation evidence without falling through to model arithmetic',async()=>{
 const user='hybrid-total-user';writePortfolio(user,{accounts:[{...accounts[0],pot:2200},{...accounts[1],pot:8800}]});
 const original=global.fetch;global.fetch=async()=>{throw Error('Unexpected model or retrieval call')};
 try {
  const result=await runChat({userId:user,message:'How much have I got in pensions altogether?',clientRequestId:'hybrid-total-1'});
  assert.equal(result.confidence,'grounded');assert.match(result.response,/£11,000/);
  assert.ok(result.sources.some(s=>/projection/.test(s.source_id)));assert.equal(result.answer_outcome.status,'completed');
 } finally {global.fetch=original;}
});
test('knowledge eligibility is applied before top-K and document IDs cannot cross tenant ownership',async()=>{
 const user='hybrid-retrieval-user';
 writeKnowledgeDocuments(user,[{id:'eligible',status:'active',scope:'USER_DOCUMENTS',title:'Allowed'},{id:'noise',status:'active',scope:'USER_DOCUMENTS',title:'Noise'}]);
 writeKnowledgeChunks(user,[{id:'e',documentId:'eligible',content:'pension conditions',embedding:[0.7,0.3]},{id:'n',documentId:'noise',content:'pension conditions',embedding:[1,0]}]);
 writeKnowledgeDocuments('other-hybrid-user',[{id:'eligible',status:'active',scope:'USER_DOCUMENTS',title:'Secret'}]);
 writeKnowledgeChunks('other-hybrid-user',[{id:'private',documentId:'eligible',content:'private',embedding:[1,0]}]);
 assert.deepEqual((await searchKnowledge(user,[1,0],1,'pension',{documentIds:['eligible']})).map(s=>s.sourceId),['e']);
 assert.deepEqual(await searchKnowledge(user,[1,0],1,'pension',{documentIds:[]}),[]);
});
test('terminal outcomes distinguish retrieved-but-rejected answers from missing evidence',()=>{
 assert.equal(answerOutcome('insufficient_verified_evidence',{valid:false,reason:'citation_entailment_failed'}).status,'answer_not_verified');
 assert.equal(answerOutcome('insufficient_verified_evidence',{valid:false,reason:'missing_or_stale_sources'}).status,'missing_evidence');
 assert.equal(answerOutcome('needs_clarification',{valid:true}).status,'needs_clarification');
 assert.equal(answerOutcome('model_unavailable',{valid:false}).status,'service_unavailable');
});
test('complete applicability facts permit a qualified statement without an artificial question',()=>{
 const source={sourceId:'law',scope:'CURATED_PUBLIC',title:'The Occupational and Personal Pension Schemes (Consultation by Employers and Miscellaneous Amendment) Regulations 2006',effectiveDate:'2006-04-06',snippet:'Consultation is required before a listed change, subject to exceptions.'};
 const args={answer:'Consultation may be required before a listed change, subject to exceptions. Check the governing scheme rules and contractual terms.',citationIds:['law'],sources:[source],intent:'GENERAL',legalEvidenceRequired:false,userSuppliedText:'Can my employer reduce future pension contributions?',clarificationContext:{missingFacts:[],schemeDocumentsPresent:false}};
 assert.equal(validateGroundedAnswer(args).valid,true);
 assert.equal(validateGroundedAnswer({...args,clarificationContext:{missingFacts:['account_selection'],schemeDocumentsPresent:false}}).valid,false);
 assert.equal(validateGroundedAnswer({...args,answer:'Consultation may be required before a listed change, subject to exceptions.'}).valid,false);
});
test('operative retrieval excludes annotation-only text without excluding legal history requests',()=>{
 const note={content:'Section 12 inserted in 2010. Words substituted in 2020. Provision omitted in 2022 for specified purposes.'};
 assert.equal(isAnnotationOnlyPassage(note,'What conditions apply?'),true);
 assert.equal(isAnnotationOnlyPassage(note,'Explain its amendment history'),false);
 assert.equal(isAnnotationOnlyPassage({content:'(1) The requirements apply only to occupational schemes. '+note.content},'What conditions apply?'),false);
});
test('verbatim evidence excerpts end at complete clauses where available',()=>{
 const body='The consultation requirement applies subject to these exceptions. '+('Further contextual background explains this subject. '.repeat(10));
 const excerpt=selectEvidenceExcerpt(body,'consultation requirement',220);
 assert.equal(body.slice(excerpt.start,excerpt.end),excerpt.text);assert.match(excerpt.text,/[.;]$/);
});
