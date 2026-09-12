import {readFileSync,writeFileSync,mkdirSync,createWriteStream,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {processFootprintGiB} from './lib/adaptabilityProcessFootprint.mjs';
import {resourceLimitViolation} from './lib/adaptabilityResourceLimits.mjs';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {runDevelopmentAnswerReview} from './lib/qualification-worker/aiReview.mjs';
import {selectionControls,selectionCounts,requireSelectionControls,selectionControlIds} from './lib/adaptabilitySelectionControls.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Completed main root required');
const plan=JSON.parse(readFileSync(resolve(root,'training-plan.json')));
const limits=plan.resource_limits;
const recovery=Boolean(plan.recovery),partial=Boolean(plan.partial_assessment),updates=partial?[0,12]:recovery?[0,12,24,36]:[0,12,24,36,48];
if(recovery){
 const binding=JSON.parse(readFileSync(resolve(root,'selection-binding.json')));
 if(binding.maximum_generations!==updates.length*8||binding.maximum_reviewer_calls!==updates.length*2)throw Error('Recovery selection budget mismatch');
 for(const record of binding.bound_inputs)if(hash(record.path)!==record.sha256)throw Error('Selection binding changed: '+record.path);
}
const adapterFor=update=>update===0?plan.parent_adapter:recovery?(update===12?resolve(root,'reconstructed-parent/adapters.safetensors'):resolve(root,'durable-updates',String(update-12).padStart(3,'0'),'adapters.safetensors')):resolve(plan.train.adapter_path,String(update).padStart(7,'0')+'_adapters.safetensors');
const footprint=pid=>{
 if(!recovery)return {value:processFootprintGiB(pid)};
 const probe=spawnSync(plan.recovery.native_probe,[String(pid)],{encoding:'utf8',timeout:3000});
 let value=NaN;try{const result=JSON.parse(probe.stdout);if(probe.status===0&&result.pid===pid)value=result.physical_footprint_gib;}catch{}
 return {value,status:probe.status,signal:probe.signal,error:probe.error?.code||null,stderr:probe.stderr||''};
};
const host=()=>({swap_used_mb:Number(spawnSync('/usr/sbin/sysctl',['vm.swapusage'],{encoding:'utf8',timeout:3000}).stdout?.match(/used = ([\d.]+)M/)?.[1]??NaN),system_free_percent:Number(spawnSync('/usr/bin/memory_pressure',['-Q'],{encoding:'utf8',timeout:3000}).stdout?.match(/free percentage:\s*(\d+)/)?.[1]??NaN)});
if(!existsSync(resolve(root,'validation-generation','receipt.json'))){
 const initial=host(),violation=resourceLimitViolation(limits,initial,{prestart:true});if(violation)throw Error('No selection model child: '+violation);
 const log=createWriteStream(resolve(root,'selection-generation.log'),{flags:'wx',mode:0o600});
 const metrics=createWriteStream(resolve(root,'selection-resource-metrics.jsonl'),{flags:'wx',mode:0o600});
 const child=spawn('/usr/bin/sandbox-exec',['-f',resolve(root,'training.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/evaluate_adaptability_checkpoints.py'),root],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},detached:true,stdio:['ignore','pipe','pipe']});
 let aborted=null;const started=new Date().toISOString();
 writeFileSync(resolve(root,'selection-process-ownership.json'),JSON.stringify({pid:child.pid,supervisor_pid:process.pid,started}),{flag:'wx',mode:0o600});
 const stop=reason=>{if(aborted)return;aborted=reason;try{process.kill(-child.pid,'SIGTERM')}catch{};setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},5000).unref();};
 const interrupt=()=>stop('OWNER_OR_SUPERVISOR_INTERRUPT');process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 const timeout=setTimeout(()=>stop('SELECTION_TIMEOUT'),7200000);
 const timer=setInterval(()=>{const sample=host();sample.swap_delta_mb=sample.swap_used_mb-initial.swap_used_mb;const probe=footprint(child.pid);sample.physical_footprint_gib=probe.value;sample.footprint_probe=probe;metrics.write(JSON.stringify({at:new Date().toISOString(),...sample})+'\n');const fail=resourceLimitViolation(limits,sample);if(fail)stop(fail);},5000);
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);});
 const exit=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',(exit_code,signal)=>accept({exit_code,signal}));});
 clearTimeout(timeout);clearInterval(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
 await Promise.all([new Promise(r=>log.end(r)),new Promise(r=>metrics.end(r))]);
 writeFileSync(resolve(root,'selection-generation-exit.json'),JSON.stringify({...exit,aborted,started,completed_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
 if(exit.exit_code!==0||exit.signal||aborted)throw Error('Selection generation failed; no automatic retry');
}
const generation=JSON.parse(readFileSync(resolve(root,'validation-generation','receipt.json')));
if(generation.completed_generations!==updates.length*8||generation.validation_sha256!==hash(resolve(plan.dataset,'valid.jsonl')))throw Error('Incomplete or mismatched validation replay');
const data=JSON.parse(readFileSync(resolve(plan.dataset,'review-packet.json'))).items.filter(x=>x.partition==='valid');
const config=JSON.parse(readFileSync('config/qualification-worker.json'));config.__project_root=resolve('.');
const records=[];
for(const update of updates){
 const candidate=generation.results.filter(x=>x.additional_update_count===update);
 const adapter=adapterFor(update);
 const adapterHash=hash(adapter);
 if(candidate.length!==8||candidate.some(x=>x.adapter_sha256!==adapterHash))throw Error('Candidate identity mismatch');
 const output=resolve(root,'selection-review-'+update);if(existsSync(output))throw Error('Review already attempted; inspect receipt instead of retrying');mkdirSync(output,{mode:0o700});
 const packet={scope:'DEVELOPMENT_GENERATION_REVIEW_ONLY',candidate_sha256:adapterHash,selection_counts_required:true,cases:candidate.map(answer=>{
  const item=data.find(x=>x.item_id===answer.id);if(!item)throw Error('Unexpected validation ID');let parsed;try{parsed=JSON.parse(answer.raw);}catch{}
  return {case_id:answer.id,question:item.question,generated_answer:parsed?.answer||answer.raw,raw_json_complete:Boolean(parsed&&typeof parsed.answer==='string'&&Array.isArray(parsed.citation_ids)&&answer.finish_reason==='stop'),evidence:[{...item.source,evidence_id:'S1'}],citation_aliases:item.citation_aliases,limitations:['Validation supplied-evidence replay, not product retrieval or legal qualification'],raw_receipt_sha256:hash(resolve(root,'validation-generation',update+'-'+answer.id+'.json'))};
 })};
 packet.cases.push(...selectionControls());
 writeFileSync(resolve(output,'packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
 const result=await runDevelopmentAnswerReview({packet,config,outputDir:output});
 for(const reviewer of result.reviewer_outputs)requireSelectionControls(reviewer);
 const counts=result.reviewer_outputs.map(reviewer=>reviewer.cases.map(c=>({id:c.case_id,...selectionCounts(c)})));
 const hard=[];
 for(const c of packet.cases)if(!c.raw_json_complete)hard.push(c.case_id+':INCOMPLETE_JSON');
 for(const reviewer of result.reviewer_outputs)for(const c of reviewer.cases.filter(x=>!selectionControlIds.includes(x.case_id)))for(const [gate,passed]of Object.entries(c.hard_gates))if(passed!==true)hard.push(c.case_id+':'+gate);
 const sum=key=>data.reduce((n,item)=>n+Math.max(...counts.map(reviewer=>reviewer.find(x=>x.id===item.item_id)[key])),0);
 records.push({additional_update_count:update,adapter_sha256:adapterHash,assessment_status:result.complete?'ASSESSED':'UNASSESSED',identity_valid:true,review_complete:result.complete,hard_failures:[...new Set(hard)],correct_complete_or_justified_clarification:result.results.filter(x=>x.passed&&!selectionControlIds.includes(x.case_id)).length,material_omissions:sum('material_omissions'),unnecessary_or_repeated_questions:sum('unnecessary_questions'),review_receipt:resolve(output,'development-answer-review.json'),review_receipt_sha256:hash(resolve(output,'development-answer-review.json'))});
 console.log(JSON.stringify({event:'candidate_semantic_review',...records.at(-1)}));
}
writeFileSync(resolve(root,'checkpoint-semantic-review.json'),JSON.stringify({validation_sha256:generation.validation_sha256,records,formal_credit:false},null,2),{flag:'wx',mode:0o600});
