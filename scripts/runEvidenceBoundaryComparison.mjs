import {readFileSync,writeFileSync,mkdirSync,existsSync,createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {collectTelemetry} from './lib/adaptabilityTelemetry.mjs';
import {resourceLimitViolation} from './lib/adaptabilityResourceLimits.mjs';
import {runDevelopmentAnswerReview} from './lib/qualification-worker/aiReview.mjs';
import {selectionControls,requireSelectionControls,selectionControlIds,selectionCounts} from './lib/adaptabilitySelectionControls.mjs';
import {selectDurationCandidate} from './lib/adaptabilityDurationSelection.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Frozen comparison root required');
const plan=JSON.parse(readFileSync(resolve(root,'plan.json')));
for(const item of plan.bound_inputs)if(hash(item.path)!==item.sha256)throw Error('Comparison binding changed: '+item.path);
if(![2,3].includes(plan.candidates.length)||plan.maximum_generations!==8*plan.candidates.length||plan.maximum_reviewer_calls!==2*plan.candidates.length)throw Error('Budget mismatch');
if(existsSync(resolve(root,'attempt.json')))throw Error('Comparison already attempted; no automatic retry');
const initial=collectTelemetry({});initial.swap_delta_mb=0;
const failure=resourceLimitViolation(plan.resource_limits,initial,{prestart:true});
writeFileSync(resolve(root,'attempt.json'),JSON.stringify({at:new Date().toISOString(),initial,prestart:failure}),{flag:'wx',mode:0o600});
if(failure)throw Error('No comparison model child: '+failure);
const log=createWriteStream(resolve(root,'output.jsonl'),{flags:'wx',mode:0o600}),metrics=createWriteStream(resolve(root,'metrics.jsonl'),{flags:'wx',mode:0o600});
const child=spawn('/usr/bin/sandbox-exec',['-f',resolve(root,'model.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/compare_evidence_boundaries.py'),root],
 {detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false',PYTHONUNBUFFERED:'1'}});
writeFileSync(resolve(root,'ownership.json'),JSON.stringify({pid:child.pid,supervisor_pid:process.pid,started:new Date().toISOString()}),{flag:'wx',mode:0o600});
let aborted=null,closed=false,killTimer,previousVm=initial.vm;
const stop=reason=>{if(aborted||closed)return;aborted=reason;try{process.kill(-child.pid,'SIGTERM')}catch{};killTimer=setTimeout(()=>{if(!closed)try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);};
const interrupt=()=>stop('OWNER_OR_SUPERVISOR_INTERRUPT');process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
const timer=setInterval(()=>{if(closed||child.exitCode!==null||child.signalCode!==null)return;
 const sample=collectTelemetry({pid:child.pid,nativeProbe:plan.native_probe,initialSwap:initial.swap_used_mb,previousVm,stage:'generation'});previousVm=sample.vm;
 metrics.write(JSON.stringify(sample)+'\n');const reason=resourceLimitViolation(plan.resource_limits,sample);if(reason)stop(reason);
},5000);
const timeout=setTimeout(()=>stop('COMPARISON_TIMEOUT'),plan.resource_limits.total_seconds*1000);
for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);});
const exit=await new Promise(accept=>{child.once('error',error=>accept({exit_code:null,error:error.message}));child.once('close',(exit_code,signal)=>accept({exit_code,signal}));});
closed=true;clearInterval(timer);clearTimeout(timeout);clearTimeout(killTimer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
await Promise.all([new Promise(r=>log.end(r)),new Promise(r=>metrics.end(r))]);
writeFileSync(resolve(root,'exit.json'),JSON.stringify({...exit,aborted}),{flag:'wx',mode:0o600});
if(exit.exit_code!==0||aborted)throw Error('Comparison model failed; no retry');
const generation=JSON.parse(readFileSync(resolve(root,'generation/receipt.json'))),cases=JSON.parse(readFileSync(resolve(root,'cases.json')));
if(generation.completed_generations!==plan.maximum_generations)throw Error('Incomplete generation');
const config=JSON.parse(readFileSync('config/qualification-worker.json'));config.__project_root=resolve('.');
const records=[];
for(const candidate of plan.candidates){
 const answers=generation.results.filter(x=>x.candidate===candidate.id);
 if(answers.length!==8||answers.some(x=>x.adapter_sha256!==candidate.sha256))throw Error('Candidate mismatch');
 const output=resolve(root,'review-'+candidate.id);mkdirSync(output,{mode:0o700});
 const packet={scope:'DEVELOPMENT_GENERATION_REVIEW_ONLY',candidate_sha256:candidate.sha256,selection_counts_required:true,
  cases:answers.map(answer=>{
   const item=cases.find(x=>x.id===answer.id);let parsed;try{parsed=JSON.parse(answer.raw);}catch{}
   return {case_id:item.id,question:item.question,generated_answer:parsed?.answer||answer.raw,
    raw_json_complete:Boolean(parsed&&typeof parsed.answer==='string'&&Array.isArray(parsed.citation_ids)&&answer.finish_reason==='stop'),
    evidence:item.evidence.map((x,i)=>({...x,evidence_id:'S'+(i+1)})),citation_aliases:item.citation_aliases,
    limitations:['Visible validation replay with current shared product prompt. Not product retrieval, browser acceptance or legal qualification.'],
    raw_receipt_sha256:hash(resolve(root,'generation',candidate.id+'-'+answer.id+'.json'))};
  })};
 packet.cases.push(...selectionControls());writeFileSync(resolve(output,'packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
 const review=await runDevelopmentAnswerReview({packet,config,outputDir:output});
 for(const reviewer of review.reviewer_outputs)requireSelectionControls(reviewer);
 const hard=packet.cases.filter(x=>!selectionControlIds.includes(x.case_id)&&!x.raw_json_complete).map(x=>x.case_id+':INCOMPLETE_JSON');
 const omissions=new Map(),questions=new Map();
 for(const reviewer of review.reviewer_outputs)for(const item of reviewer.cases.filter(x=>!selectionControlIds.includes(x.case_id))){
  const count=selectionCounts(item);omissions.set(item.case_id,Math.max(omissions.get(item.case_id)??0,count.material_omissions));questions.set(item.case_id,Math.max(questions.get(item.case_id)??0,count.unnecessary_questions));
  for(const [gate,passed] of Object.entries(item.hard_gates))if(passed!==true)hard.push(item.case_id+':'+gate);
 }
 const loss=generation.validation_losses?.find(x=>x.candidate===candidate.id&&x.adapter_sha256===candidate.sha256);
 records.push({candidate:candidate.id,adapter_sha256:candidate.sha256,review_complete:review.complete,
  dual_review_pass:review.results.filter(x=>x.passed&&!selectionControlIds.includes(x.case_id)).length,denominator:8,hard_failures:[...new Set(hard)],
  validation_loss:loss?.validation_loss??null,additional_update_count:candidate.lineage_updates??null,
  material_omissions:[...omissions.values()].reduce((a,b)=>a+b,0),unnecessary_or_repeated_questions:[...questions.values()].reduce((a,b)=>a+b,0),
  review_receipt:resolve(output,'development-answer-review.json')});
 console.log(JSON.stringify({event:'semantic_comparison',...records.at(-1)}));
}
const selection=plan.validation_dataset?selectDurationCandidate(records.map(x=>({...x,assessment_status:x.review_complete?'ASSESSED':'UNASSESSED',identity_valid:true,correct_complete_or_justified_clarification:x.dual_review_pass})),{lossTieTolerance:0.01}):null;
writeFileSync(resolve(root,'result.json'),JSON.stringify({scope:plan.scope,policy_version:plan.policy_version,records,
 selection,training_updates:0,formal_credit:false,promotion:false,browser_acceptance:false},null,2),{flag:'wx',mode:0o600});
