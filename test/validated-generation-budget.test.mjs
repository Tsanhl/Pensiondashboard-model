import test from 'node:test';
import assert from 'node:assert/strict';
import {generateValidatedAnswer} from '../server/services/validatedGenerationService.js';
import {buildModelContext} from '../server/services/modelContextService.js';
import {generateLocalAnswerWithRetry,recoverTruncatedJsonAnswer} from '../server/services/localModelService.js';
const query={self_contained_query:'What is the recorded balance?',intent:'USER_PORTFOLIO',legal_evidence_required:false};
const modelSources=[{sourceId:'record_balance',title:'Recorded balance',scope:'USER_PORTFOLIO',snippet:'The recorded balance is £200.'}];
const modelContext=buildModelContext(query,modelSources);
const response=value=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:`The recorded balance is £${value}. {{cite:S1}}`,citation_ids:['S1']})},finish_reason:'stop'}]}),{status:200});
test('a rejected draft can be repaired once, sharing the overall two-attempt budget',async()=>{
 const original=global.fetch;let calls=0;
 global.fetch=async()=>response(++calls===1?300:200);
 try{const result=await generateValidatedAnswer({system:'Use supplied evidence.',question:query.self_contained_query,query,modelSources,modelContext,maxAttempts:2,allowDevelopmentRepair:true});assert.equal(calls,2);assert.equal(result.validation.valid,true);assert.equal(result.generated.generation_attempts,2);assert.equal(result.generated.candidateAttempts.length,2);assert.deepEqual(result.generated.generation_attempt_ledger.filter(x=>x.event==='ATTEMPT_STARTED').map(x=>x.attempt),[1,2]);}finally{global.fetch=original;}
});
test('a repeated semantic failure stops after two calls and remains rejected',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;return response(300)};
 try{const result=await generateValidatedAnswer({system:'Use supplied evidence.',question:query.self_contained_query,query,modelSources,modelContext,maxAttempts:2,allowDevelopmentRepair:true});assert.equal(calls,2);assert.equal(result.validation.valid,false);}finally{global.fetch=original;}
});
test('a one-attempt allowance cannot be silently expanded by semantic repair',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;return response(300)};
 try{const result=await generateValidatedAnswer({system:'Use supplied evidence.',question:query.self_contained_query,query,modelSources,modelContext,maxAttempts:1,allowDevelopmentRepair:true});assert.equal(calls,1);assert.equal(result.validation.valid,false);}finally{global.fetch=original;}
});

test('production does not silently expand approved retry reasons',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;return response(300)};
 try{const result=await generateValidatedAnswer({system:'Use evidence.',question:query.self_contained_query,query,modelSources,modelContext,maxAttempts:2});assert.equal(calls,1);assert.equal(result.validation.valid,false);}finally{global.fetch=original;}
});
test('opt-in development evidence retains both malformed and successful raw attempts',async()=>{
 const original=global.fetch,prior=process.env.PENSION_DEVELOPMENT_TRACE_ROOT;let calls=0;
 process.env.PENSION_DEVELOPMENT_TRACE_ROOT='/tmp/synthetic-trace-not-written';
 global.fetch=async()=>++calls===1 ? new Response(JSON.stringify({choices:[{message:{content:'{"answer":"unfinished'},finish_reason:'length'}]})) : response(200);
 try {
  const result=await generateLocalAnswerWithRetry({system:'Use evidence.',...modelContext,maxAttempts:2});
  assert.equal(calls,2);assert.deepEqual(result.developmentAttemptOutputs.map(x=>x.attempt),[1,2]);
  assert.equal(result.developmentAttemptOutputs[0].finishReason,'length');
  assert.equal(result.generation_attempt_ledger.some(x=>Object.hasOwn(x,'rawContent')),false,'Private drafts must not enter public attempt telemetry');
 } finally {global.fetch=original;if(prior===undefined)delete process.env.PENSION_DEVELOPMENT_TRACE_ROOT;else process.env.PENSION_DEVELOPMENT_TRACE_ROOT=prior;}
});


test('truncated JSON retains only existing complete citations after the last complete sentence',()=>{
 const recovered=recoverTruncatedJsonAnswer('{"answer":"The recorded pension balance in this statement is £200. {{cite:S1}} {{cite:S1}} {{cite:S');
 assert.deepEqual(recovered,{answer:'The recorded pension balance in this statement is £200. {{cite:S1}} {{cite:S1}}',citationIds:['S1']});
 assert.deepEqual(recoverTruncatedJsonAnswer('{"answer":"The recorded pension balance in this statement is £200. Next unfinished claim {{cite:S2'),{answer:'The recorded pension balance in this statement is £200.',citationIds:[]});
 assert.equal(recoverTruncatedJsonAnswer('{"answer":"There is no completed sentence or supporting source'),null);
});

test('citation recovery restores a supported record but does not legalize the observed overbroad claim',async()=>{
 const original=global.fetch;
 const law={sourceId:'live-repair-pa1995-s67-20260908_chunk_2',title:'Pensions Act 1995 — section 67',scope:'CURATED_PUBLIC',sourceType:'primary_legislation',jurisdiction:'GREAT_BRITAIN',effectiveDate:'2006-04-06',snippet:'The subsisting rights provisions apply to occupational pension scheme modifications. Consent requirements apply to protected modifications; other regulated modifications require consent or actuarial equivalence. Trustee approval and reporting requirements also apply. Exceptions apply.'};
 const q={self_contained_query:'Can my employer change my scheme?',intent:'USER_PORTFOLIO',legal_evidence_required:true};
 try {
  global.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'{"answer":"The recorded pension balance in this statement is £200. {{cite:S1}} {{cite:S'},finish_reason:'length'}]}));
  const goodSources=[{...modelSources[0],snippet:'The recorded pension balance in this statement is £200.'}];
  const good=await generateValidatedAnswer({system:'Use supplied evidence.',question:query.self_contained_query,query,modelSources:goodSources,modelContext:buildModelContext(query,goodSources),maxAttempts:2});
  assert.equal(good.validation.valid,true);assert.equal(good.generated.recoveredFromTruncation,true);
  global.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'{"answer":"An employer may change the scheme rules or agreements, subject to statutory consultation, trustee approval and member consent. {{cite:S1}} {{cite:S'},finish_reason:'length'}]}));
  const bad=await generateValidatedAnswer({system:'Use supplied evidence.',question:q.self_contained_query,query:q,modelSources:[law],modelContext:buildModelContext(q,[law]),maxAttempts:2});
  assert.equal(bad.validation.valid,false);assert.equal(bad.generated.citationIds[0],law.sourceId);
 } finally {global.fetch=original;}
});

