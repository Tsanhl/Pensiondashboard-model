// Zero-gradient supplement. Original plan/checkpoint identity and failures stay immutable.
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {validateSavedProof} from './lib/savedProofVerification.mjs';
import {collectTelemetry} from './lib/adaptabilityTelemetry.mjs';
import {resourceLimitViolation} from './lib/adaptabilityResourceLimits.mjs';
import {stageDeadlineExceeded,cleanupOwnedGroup} from './lib/checkpointedContinuation.mjs';
const [sourceArg,outArg]=process.argv.slice(2);
if(!sourceArg||!outArg)throw Error('Source proof and fresh output required');
const source=resolve(sourceArg),root=resolve(outArg);
if(existsSync(root))throw Error('Fresh supplement root required');
const {plan,result:original}=validateSavedProof(source);
const stages={launch:90,load:90,restored:30,full_validation:300,generation:90,complete:30};
const limits={...plan.resource_limits,total_seconds:480};
mkdirSync(root,{mode:0o700});mkdirSync(resolve(root,'checkpoints'));mkdirSync(resolve(root,'checkpoints/2'));
for(const file of ['plan.json','training.sb','phase-2.json','checkpoints/2/complete.json','checkpoints/2/adapter.safetensors','checkpoints/2/state.safetensors'])copyFileSync(resolve(source,file),resolve(root,file));
const bound=[resolve(source,'result.json'),resolve(source,'plan.json'),resolve(root,'plan.json'),resolve(root,'phase-2.json'),...['complete.json','adapter.safetensors','state.safetensors'].map(x=>resolve(root,'checkpoints/2',x)),
 resolve('scripts/verifySavedAdaptabilityProof.mjs'),resolve('scripts/lib/savedProofVerification.mjs'),resolve('docs/live-repair/RESOURCE-ADJUSTMENT-DELEGATION-20260912.md')].map(path=>({path,sha256:hash(path)}));
const control={version:1,source,zero_gradient_updates:true,maximum_processes:1,stage_seconds:stages,resource_limits:limits,bound_inputs:bound};
writeFileSync(resolve(root,'verification-control.json'),JSON.stringify(control,null,2),{flag:'wx',mode:0o600});
const initial=collectTelemetry({});initial.swap_delta_mb=0;
const prestart=resourceLimitViolation(limits,initial,{prestart:true}),started=Date.now();
writeFileSync(resolve(root,'attempt.json'),JSON.stringify({started:new Date().toISOString(),initial,prestart,maximum_gradient_updates:0}),{flag:'wx',mode:0o600});
if(prestart)throw Error('No child: '+prestart);
const log=createWriteStream(resolve(root,'output.jsonl'),{flags:'wx',mode:0o600}),metrics=createWriteStream(resolve(root,'metrics.jsonl'),{flags:'wx',mode:0o600});
const child=spawn('/usr/bin/sandbox-exec',['-f',resolve(root,'training.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/prove_adaptability_resume.py'),root,'verify'],
 {detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false',PYTHONUNBUFFERED:'1'}});
writeFileSync(resolve(root,'ownership-verify.json'),JSON.stringify({pid:child.pid,supervisor_pid:process.pid,phase:'verify',started:new Date().toISOString()}),{flag:'wx',mode:0o600});
let stage={stage:'launch'},stageStarted=Date.now(),buffer='',previousVm=initial.vm,closed=false,aborted=null,killTimer;
const stop=reason=>{if(closed||aborted)return;aborted=reason;try{process.kill(-child.pid,'SIGTERM')}catch{};killTimer=setTimeout(()=>{if(!closed)try{process.kill(-child.pid,'SIGKILL')}catch{}},5000)};
const interrupt=()=>stop('OWNER_OR_SUPERVISOR_INTERRUPT');process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
const timer=setInterval(()=>{
 if(closed||child.exitCode!==null||child.signalCode!==null)return;
 const sample=collectTelemetry({pid:child.pid,nativeProbe:plan.native_probe,initialSwap:initial.swap_used_mb,previousVm,stage});previousVm=sample.vm;metrics.write(JSON.stringify(sample)+'\n');
 const failure=resourceLimitViolation(limits,sample);if(failure)stop(failure);
},5000);
const watchdog=setInterval(()=>{if(stageDeadlineExceeded(stage.stage,Date.now()-stageStarted,stages))stop('STAGE_TIMEOUT_'+stage.stage)},1000);
const deadline=setTimeout(()=>stop('TOTAL_TIMEOUT'),480000);
child.stdout.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);buffer+=bytes.toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines)try{
 const value=JSON.parse(line);if(value.event==='resume_proof_stage'){if(value.stage!==stage.stage)stageStarted=Date.now();stage=value;if(value.mlx_peak_gb>limits.mlx_peak_max_decimal_gb)stop('MLX_MEMORY_LIMIT')}
}catch{}});
child.stderr.on('data',bytes=>{log.write(bytes);process.stderr.write(bytes)});
const exit=await new Promise(done=>{child.once('error',e=>done({exit_code:null,error:e.message}));child.once('close',(exit_code,signal)=>done({exit_code,signal}))});
closed=true;clearInterval(timer);clearInterval(watchdog);clearTimeout(deadline);clearTimeout(killTimer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
if(child.pid&&await cleanupOwnedGroup(child.pid))aborted=aborted||'UNEXPECTED_SURVIVING_DESCENDANT';
await Promise.all([new Promise(r=>log.end(r)),new Promise(r=>metrics.end(r))]);
let failed=aborted||(exit.exit_code!==0?'CHILD_FAILED':null),verification=null;
if(!failed){
 for(const item of bound)if(hash(item.path)!==item.sha256)failed='INPUT_CHANGED';
 verification=JSON.parse(readFileSync(resolve(root,'phase-verify.json')));
 if(verification.completed_updates!==2||verification.validation_items!==8||!Number.isFinite(verification.full_validation_loss)||verification.finish_reason!=='stop')failed='INCOMPLETE_VERIFICATION';
}
const receipt={status:failed?'FAILED':'RUNTIME_RESUME_PROOF_COMPLETE',failed,workload_identity:plan.workload_identity,
 completed_updates:2,main_updates:0,disposable_updates:2,new_gradient_updates:0,promotion:false,formal_credit:false,
 exits:[...original.exits.slice(0,2),{phase:'verify',...exit,aborted}],elapsed_seconds:(Date.now()-started)/1000,
 supplemented_proof:{source,original_result_sha256:hash(resolve(source,'result.json')),control_sha256:hash(resolve(root,'verification-control.json')),original_failure_preserved:true,original_validation_failure:original.exits[2]},
 note:'Two original completed updates plus separately authorized verification; original failed verification remains preserved, not a new training attempt.'};
writeFileSync(resolve(root,'result.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify(receipt));if(failed)process.exitCode=1;
