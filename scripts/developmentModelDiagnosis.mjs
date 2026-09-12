// Development-only CLI. No HTTP evidence override, no evaluation banks or gold.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [output,mode='B',question='can my employer change my scheme']=process.argv.slice(2);
if(!output||existsSync(output)||!['A','B'].includes(mode))throw Error('Fresh private output and A/B required');
mkdirSync(output,{recursive:true,mode:0o700});
const health=await (await fetch('http://127.0.0.1:8080/v1/models')).json();
const selectionPath=process.env.DEVELOPMENT_CHECKPOINT_PATH || 'training/evaluation-cycle-v2/30-cumulative-legal-training-20260902/checkpoint-selection.json';
const selectionBytes=readFileSync(selectionPath),selection=JSON.parse(selectionBytes);
const expectedId=`${selection.model_version}-step${selection.selected_iteration}`;
const identity=health.data.find(x=>x.id===expectedId);
if(selection.adapter_sha256==='5ae76a0e16e7985c8e01d2a3d6fff2bff177d73bc5705608d6c59101998bd379'
 || !identity || identity.adapter_sha256!==selection.adapter_sha256
 || identity.checkpoint_sha256!==createHash('sha256').update(selectionBytes).digest('hex'))throw Error('Explicit development checkpoint identity unavailable or forbidden');
for(const [key,value] of Object.entries({LOCAL_LLM_MODEL:identity.id,LOCAL_LLM_EXPECTED_ADAPTER_SHA256:identity.adapter_sha256,LOCAL_LLM_EXPECTED_BASE_SHA256:identity.base_sha256,LOCAL_LLM_EXPECTED_CHECKPOINT_SHA256:identity.checkpoint_sha256,LOCAL_LLM_MAX_TOKENS:process.env.LOCAL_LLM_MAX_TOKENS||'192',LOCAL_LLM_TIMEOUT_MS:'305000',LOCAL_LLM_CONTEXT_TOKENS:'8192',LOCAL_LLM_TEMPERATURE:'0',LOCAL_LLM_TOP_P:'1',LOCAL_LLM_SEED:'42',EMBEDDING_SERVICE_URL:'http://127.0.0.1:8090',RERANK_SERVICE_URL:'http://127.0.0.1:8090',RERANK_TIMEOUT_MS:'60000',REQUIRE_CROSS_ENCODER_RERANK:'true',ALLOW_DEGRADED_EMBEDDINGS:'false',DISABLE_DEBUG_LOGGING:'true'}))process.env[key]=value;
const {processQuery}=await import('../server/services/queryProcessorService.js');
const {retrieveForQuery}=await import('../server/services/retrievalService.js');
const {selectMandatorySources}=await import('../server/services/evidenceContractService.js');
const {buildModelContext}=await import('../server/services/modelContextService.js');
const {generateValidatedAnswer}=await import('../server/services/validatedGenerationService.js');
const {ANSWER_SYSTEM_POLICY}=await import('../server/prompts/answerPolicy.js');
const system=process.env.DEVELOPMENT_SYSTEM_PROMPT_PATH ? readFileSync(process.env.DEVELOPMENT_SYSTEM_PROMPT_PATH,'utf8') : ANSWER_SYSTEM_POLICY;
const {structuralChunk}=await import('../server/services/chunkingService.js');
const query=processQuery(question,{jurisdiction:'England and Wales'});
let sources,trace;
if(mode==='A'){
 const result=await retrieveForQuery({userId:'development-diagnosis-empty',queryPlan:query,limit:8});
 sources=selectMandatorySources(result.sources,query,4);trace=result.trace;
}else{
 const manifest=JSON.parse(readFileSync(process.env.APPROVED_CORPUS_MANIFEST_PATH));
 const selectors=[['live-repair-tpr-scheme-changes-20260908',()=>true],['live-repair-pa1995-s67-20260908',s=>/Section 67\b/.test(s)],['live-repair-gb-consultation-20260908',s=>/Regulation 6\b/.test(s)]];
 sources=selectors.map(([id,pick])=>{
  const d=manifest.documents.find(x=>x.id===id);const text=readFileSync(resolve('approved-materials',d.text_path),'utf8');
  if(createHash('sha256').update(text).digest('hex')!==d.text_sha256)throw Error('Source bytes changed');
  const c=structuralChunk(text,{documentType:d.document_type}).find(c=>pick(c.sectionPath));
  return {sourceId:`${id}_chunk_${c.ordinal+1}`,documentId:id,title:d.title,section:c.sectionPath,snippet:c.content,scope:'CURATED_PUBLIC',sourceType:d.source_type,authority:d.authority,jurisdiction:d.jurisdiction,effectiveDate:d.effective_date,oscolaCitation:d.title,canonicalLocation:d.canonical_location,version:d.version,sourceMetadata:{scopeNote:d.scope_note,retrievedAt:d.retrieved_at,dateBasis:d.effective_date_basis,unappliedEffects:d.unapplied_effects}};
 });trace={classification:'DEVELOPMENT_VERIFIED_SOURCE_PACK',expected_answer_supplied:false,source_review:'approved-materials/live-repair-20260908/review-v3/source-admission-review.json'};
}
const modelContext=buildModelContext(query,sources,{snippetChars:1800});
if(process.env.DEVELOPMENT_INPUT_FORMAT==='json') {
 modelContext.messages=[{role:'user',content:JSON.stringify({question:query.self_contained_query,context:{jurisdiction:query.jurisdiction_scope,response_route:query.response_route,response_requirements:query.response_requirements},evidence:modelContext.evidenceSources.map((source,index)=>({source_id:`S${index+1}`,title:source.title,section:source.section,jurisdiction:source.jurisdiction,scope:source.scope,effective_date:source.effectiveDate,limitations:source.sourceMetadata,text:source.snippet}))})}];
}
const save=(name,value)=>writeFileSync(resolve(output,name),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
save('input.json',{classification:'DEVELOPMENT_ONLY',mode,question,query,trace,sources,modelContext,system,identity});
console.log('GENERATING',mode,query.intent,sources.map(x=>[x.sourceId,x.section]));
const start=Date.now();
try{
 const {generated,...result}=await generateValidatedAnswer({system,question,query,modelSources:sources,modelContext,maxAttempts:2,allowDevelopmentRepair:process.env.DEVELOPMENT_SEMANTIC_REPAIR === "true"});
 // Only the declared answer output is retained. Never request internal reasoning.
 const safeGenerated={...generated,rawContent:String(generated.rawContent||'').replace(/<think>[\s\S]*?<\/think>/gi,'[reasoning omitted]')};
 save('result.json',{classification:'DEVELOPMENT_ONLY',mode,ms:Date.now()-start,generated:safeGenerated,...result});console.log(JSON.stringify({ms:Date.now()-start,...result},null,2));
}catch(error){save('failure.json',{code:error.code||error.name,message:error.message,ms:Date.now()-start});process.exitCode=1;}
