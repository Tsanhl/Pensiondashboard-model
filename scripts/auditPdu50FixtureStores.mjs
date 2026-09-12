// Read-only, harness-role audit. No evaluator/gold or model/reviewer invocation.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadPdu50HarnessRole} from './lib/pdu50Pack.mjs';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const [batchArg,outputArg]=process.argv.slice(2);if(!batchArg||!outputArg)throw Error('Existing batch receipt and fresh output required');
const batchPath=resolve(batchArg),output=resolve(outputArg);if(existsSync(output))throw Error('Preserve prior audit');
const batch=JSON.parse(readFileSync(batchPath)),harness=loadPdu50HarnessRole();
if(batch.scope!=='PDU50_FIXTURE_CASE_PREPARATION_NOT_ACCEPTANCE'||batch.cases.length!==12)throw Error('Unexpected batch');
const results=[];
for(const entry of batch.cases){
 if(hash(entry.receipt)!==entry.receipt_sha256||hash(entry.database)!==entry.database_sha256)throw Error('Seed artifact changed: '+entry.case_id);
 const receipt=JSON.parse(readFileSync(entry.receipt)),setup=harness.setup.find(x=>x.case_id===entry.case_id);
 if(!setup||setup.fixture_id!==receipt.fixture_id||receipt.evaluator_material_loaded!==false)throw Error('Harness binding mismatch');
 const fixtures=[harness.fixturePack.fixtures[setup.fixture_id]];
 if(entry.case_id==='PDU50-046')fixtures.push(harness.fixturePack.fixtures.F_OTHER_USER);
 const db=new DatabaseSync(entry.database,{readOnly:true});let records,integrity;
 try{integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;records=db.prepare('SELECT user_id,record_name,json FROM user_records').all();}finally{db.close()}
 const findings=[],users=fixtures.map(x=>x.user_id.toLowerCase());
 const check=(pass,message)=>{if(!pass)findings.push(message)};
 check(integrity==='ok','SQLite integrity');
 check(records.every(x=>users.includes(x.user_id)),'Unexpected stored user');
 let documents=0,spans=0,quarantined=0;
 for(const fixture of fixtures){
  const record=name=>{const matches=records.filter(x=>x.user_id===fixture.user_id.toLowerCase()&&x.record_name===name);if(matches.length!==1)throw Error('Missing/duplicate record '+name);return JSON.parse(matches[0].json)};
  const portfolio=record('portfolio.json'),storedDocs=record('knowledge-documents.json'),chunks=record('knowledge-chunks.json');
  check(portfolio.userId===fixture.user_id,'Portfolio owner binding');
  check(portfolio.accounts.length===fixture.accounts.length,'Account cardinality');
  check(portfolio.supplementalRecords.fixture_record.record_version===fixture.record_version,'Record version');
  for(const account of fixture.accounts){
   const actual=portfolio.accounts.find(x=>x.id==='acct_pdu_'+account.scheme_id);
   check(Boolean(actual),'Missing account '+account.scheme_id);if(!actual)continue;
   check(JSON.stringify(actual.recordFacts)===JSON.stringify(account),'Original typed account facts changed '+account.scheme_id);
   check(actual.policy===account.policy_id,'Policy identity '+account.scheme_id);
   check(actual.pot===(account.balance?.value??null),'Balance/missing binding '+account.scheme_id);
   check(actual.employerContributionPct===(account.employer_percent?.value??null),'Employer rate binding '+account.scheme_id);
  }
  check(storedDocs.length===fixture.documents.length,'Document cardinality');
  check(chunks.length===fixture.documents.reduce((n,x)=>n+x.spans.length,0),'Span cardinality');
  for(const document of fixture.documents){
   const actual=storedDocs.find(x=>x.id===document.document_id);documents++;
   check(Boolean(actual),'Missing document '+document.document_id);if(!actual)continue;
   const text=document.spans.map(x=>x.text).join('\n\n');
   check(actual.checksum===createHash('sha256').update(text).digest('hex'),'Document checksum '+document.document_id);
   check(actual.userId===fixture.user_id&&actual.scope==='USER_DOCUMENTS'&&actual.metadata.publicLegalAuthority===false,'Private document owner/scope');
   check(actual.metadata.recordStatus===document.record_status,'Document confirmation status');
   for(const span of document.spans){
    spans++;const stored=chunks.find(x=>x.id===span.span_id);
    check(Boolean(stored),'Missing span '+span.span_id);if(!stored)continue;
    check(stored.content===span.text&&stored.documentId===document.document_id&&stored.userId===fixture.user_id,'Span text/owner binding '+span.span_id);
    check(stored.metadata.locator===span.locator,'Locator invented/changed '+span.span_id);
    if(stored.metadata.quarantined)quarantined++;
   }
  }
 }
 check(hash(entry.database)===entry.database_sha256,'Read-only audit changed DB');
 const degraded=receipt.seed_receipts.some(x=>x.degraded_embedding);
 results.push({case_id:entry.case_id,database_sha256:entry.database_sha256,stored_users:users.length,documents,spans,quarantined,checks_passed:findings.length===0,findings,
  vector_readiness:degraded?'NOT_READY_DEGRADED_EMBEDDING':'REQUIRES_PINNED_INDEX_VERIFICATION',
  independent_fixture_label_review:'PENDING',authentication_session_browser:'NOT_RUN',case_status:'CASE_NOT_READY'});
}
mkdirSync(output,{mode:0o700});
const result={scope:'READ_ONLY_PDU50_SEED_INTEGRITY_NOT_ACCEPTANCE',batch_sha256:hash(batchPath),cases:results,passed:results.every(x=>x.checks_passed),
 degraded_embedding_cases:results.filter(x=>x.vector_readiness==='NOT_READY_DEGRADED_EMBEDDING').length,databases_modified:false,model_inputs_constructed:false,evaluator_material_loaded:false,formal_credit:false};
writeFileSync(resolve(output,'receipt.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,passed:result.passed,cases:results.length,degraded_embedding_cases:result.degraded_embedding_cases,case_status:'CASE_NOT_READY'}));
if(!result.passed)process.exitCode=1;
