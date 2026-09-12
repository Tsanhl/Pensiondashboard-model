// Explicit retained development inputs only. This never queries a protected bank
// and is supplied-context diagnosis, not browser/normal-retrieval acceptance.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [manifestPath,outputPath]=process.argv.slice(2);
if(!manifestPath||!outputPath||existsSync(outputPath))throw Error('Explicit manifest and fresh private output required');
const manifest=JSON.parse(readFileSync(manifestPath));
if(manifest.scope!=='DEVELOPMENT_ONLY'||manifest.cases.length!==5)throw Error('Fixed five development traces required');
const expected='b370306a3078abd79af14e14c4690a4f394800f1096592ca6528e213cf5a6337';
const health=await(await fetch('http://127.0.0.1:8080/v1/models')).json();
const identity=health.data?.find(x=>x.adapter_sha256===expected);
if(!health.ready||health.busy||!identity)throw Error('Idle baseline104 required');
for(const [key,value]of Object.entries({LOCAL_LLM_MODEL:identity.id,LOCAL_LLM_EXPECTED_ADAPTER_SHA256:expected,LOCAL_LLM_EXPECTED_BASE_SHA256:identity.base_sha256,LOCAL_LLM_EXPECTED_CHECKPOINT_SHA256:identity.checkpoint_sha256,LOCAL_LLM_MAX_TOKENS:'192',LOCAL_LLM_TIMEOUT_MS:'305000',LOCAL_LLM_CONTEXT_TOKENS:'8192',LOCAL_LLM_TEMPERATURE:'0',LOCAL_LLM_TOP_P:'1',LOCAL_LLM_SEED:'42',DISABLE_DEBUG_LOGGING:'true',PENSION_DEVELOPMENT_TRACE_ROOT:resolve(outputPath)}))process.env[key]=value;
const {buildModelContext}=await import('../server/services/modelContextService.js');
const {ANSWER_SYSTEM_POLICY,ANSWER_POLICY_VERSION}=await import('../server/prompts/answerPolicy.js');
const {generateValidatedAnswer}=await import('../server/services/validatedGenerationService.js');
const sha=x=>createHash('sha256').update(x).digest('hex');
mkdirSync(outputPath,{recursive:true,mode:0o700});
const save=(name,x)=>writeFileSync(join(outputPath,name),JSON.stringify(x,null,2),{flag:'wx',mode:0o600});
const inputs=manifest.cases.map(c=>{const bytes=readFileSync(c.trace),trace=JSON.parse(bytes);if(trace.classification!=='DEVELOPMENT_ONLY')throw Error('Development trace required');return{...c,trace,prior_trace:c.trace,prior_sha256:sha(bytes)}});
save('binding.json',{scope:'SUPPLIED_CONTEXT_DEVELOPMENT_ONLY',candidate_policy:ANSWER_POLICY_VERSION,identity,expected_answers_supplied:false,case_inputs:inputs.map(({trace,...x})=>x),files:Object.fromEntries(['server/services/modelContextService.js','server/prompts/answerPolicy.js','server/services/localModelService.js','server/services/answerValidationService.js','server/services/groundingService.js'].map(p=>[p,sha(readFileSync(p))]))});
const results=[],reviewCases=[];
for(const c of inputs){
 const t=c.trace,query=t.query,modelSources=t.modelSources;
 const modelContext=buildModelContext(query,modelSources,{history:t.modelContext.messages.slice(0,-1),snippetChars:1800});
 if(JSON.stringify(modelContext.evidenceSources.map(s=>[s.sourceId,s.snippet]))!==JSON.stringify(t.modelContext.evidenceSources.map(s=>[s.sourceId,s.snippet])))throw Error('Supplied source bytes changed');
 const started=Date.now(),request_id='development-replay-'+c.id;
 try {
  const result=await generateValidatedAnswer({system:ANSWER_SYSTEM_POLICY,question:query.original_query||query.self_contained_query,query,modelSources,modelContext,maxAttempts:2,allowDevelopmentRepair:false});
  save(c.id+'.json',{classification:'DEVELOPMENT_ONLY',request_id,query,retrievalTrace:{...t.retrievalTrace,reused_supplied_context:true,prior_trace_sha256:c.prior_sha256},modelSources,modelContext,...result,ms:Date.now()-started,system:ANSWER_SYSTEM_POLICY});
  results.push({id:c.id,valid:result.validation.valid,reason:result.validation.reason,ms:Date.now()-started,usage:result.generated.usage,finishReason:result.generated.finishReason,attempts:result.generated.generation_attempts});
  reviewCases.push({id:c.id,trace:resolve(outputPath,c.id+'.json')});
 } catch(e){save(c.id+'-error.json',{code:e.code,message:e.message,attempts:e.developmentAttemptOutputs,ms:Date.now()-started});results.push({id:c.id,valid:false,error:e.code||e.message});}
 console.log(JSON.stringify(results.at(-1)));
}
save('review-manifest.json',{scope:'DEVELOPMENT_ONLY',adapter_sha256:expected,cases:reviewCases});
save('receipt.json',{scope:'SUPPLIED_CONTEXT_DEVELOPMENT_ONLY',formal_credit:false,results});
if(results.some(x=>!x.valid))process.exitCode=1;
