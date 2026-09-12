import {readFileSync,writeFileSync,createWriteStream,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {collectTelemetry} from './lib/adaptabilityTelemetry.mjs';
import {resourceLimitViolation} from './lib/adaptabilityResourceLimits.mjs';
import {validateCheckpointedPlan,stageDeadlineExceeded,cleanupOwnedGroup} from './lib/checkpointedContinuation.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Fresh bound proof root required');
const plan=JSON.parse(readFileSync(resolve(root,'plan.json')));
const segment=plan.checkpointed_segment?validateCheckpointedPlan(plan):null;
const mainMode=segment?.mode==='main',maximum=segment?.maximum_updates??2;
for(const item of plan.bound_inputs)if(hash(item.path)!==item.sha256)throw Error('Proof binding changed: '+item.path);
if(plan.maximum_disposable_updates!==(mainMode?0:2)||!plan.owner_authorized_training)throw Error('Invalid proof allowance');
if(existsSync(resolve(root,'attempt.json')))throw Error('Proof already attempted; no automatic retry');
const started=Date.now();
const initial=collectTelemetry({});
initial.swap_delta_mb=0; // Baseline is the observed host state, not zero swap.
const prestart=resourceLimitViolation(plan.resource_limits,initial,{prestart:true});
writeFileSync(resolve(root,'attempt.json'),JSON.stringify({started:new Date(started).toISOString(),initial,prestart,maximum_disposable_updates:mainMode?0:2,maximum_main_updates:mainMode?maximum:0}),{flag:'wx',mode:0o600});
if(prestart)throw Error('No model child: '+prestart);
const log=createWriteStream(resolve(root,'output.jsonl'),{flags:'wx',mode:0o600});
const metrics=createWriteStream(resolve(root,'metrics.jsonl'),{flags:'wx',mode:0o600});
let failed=null,completedUpdates=0;const exits=[];
for(const phase of [...Array.from({length:maximum},(_,i)=>String(i+1)),'verify']){
  if(Date.now()-started>=plan.resource_limits.total_seconds*1000){failed='TOTAL_TIMEOUT';break;}
  let previousVm=initial.vm,stage={phase,stage:'launch'},stageStarted=Date.now(),buffer='',closed=false,aborted=null,killTimer;
  const child=spawn('/usr/bin/sandbox-exec',['-f',resolve(root,'training.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/prove_adaptability_resume.py'),root,phase],
    {detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false',PYTHONUNBUFFERED:'1'}});
  writeFileSync(resolve(root,`ownership-${phase}.json`),JSON.stringify({pid:child.pid,supervisor_pid:process.pid,phase,started:new Date().toISOString()}),{flag:'wx',mode:0o600});
  const stop=reason=>{if(aborted||closed)return;aborted=reason;try{process.kill(-child.pid,'SIGTERM')}catch{};killTimer=setTimeout(()=>{if(!closed)try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);};
  const interrupt=()=>stop('OWNER_OR_SUPERVISOR_INTERRUPT');process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const timer=setInterval(()=>{
    if(closed||child.exitCode!==null||child.signalCode!==null)return;
    const sample=collectTelemetry({pid:child.pid,nativeProbe:plan.native_probe,initialSwap:initial.swap_used_mb,previousVm,stage});
    previousVm=sample.vm;metrics.write(JSON.stringify(sample)+'\n');
    const failure=resourceLimitViolation(plan.resource_limits,sample);
    if(failure)stop(failure);
    if(Number(stage.mlx_peak_gb)>plan.resource_limits.mlx_peak_max_decimal_gb)stop('MLX_MEMORY_LIMIT');
  },5000);
  const timeout=setTimeout(()=>stop('TOTAL_TIMEOUT'),Math.max(1,plan.resource_limits.total_seconds*1000-(Date.now()-started)));
  const stageTimer=segment?setInterval(()=>{if(!closed&&stageDeadlineExceeded(stage.stage,Date.now()-stageStarted,plan.stage_seconds))stop('STAGE_TIMEOUT_'+stage.stage)},1000):null;
  child.stdout.on('data',bytes=>{
    log.write(bytes);process.stdout.write(bytes);buffer+=bytes.toString();
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines)try{const value=JSON.parse(line);if(value.event==='resume_proof_stage'){
      if(value.stage!==stage.stage)stageStarted=Date.now();stage=value;
      if(value.stage==='save'&&Number.isInteger(value.completed_updates))completedUpdates=Math.max(completedUpdates,value.completed_updates);
    }}catch{}
  });
  child.stderr.on('data',bytes=>{log.write(bytes);process.stderr.write(bytes);});
  const exit=await new Promise(accept=>{
    child.once('error',error=>accept({exit_code:null,error:error.message}));
    child.once('close',(exit_code,signal)=>accept({exit_code,signal}));
  });
  closed=true;clearInterval(timer);clearInterval(stageTimer);clearTimeout(timeout);clearTimeout(killTimer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  // Detached process-group ownership remains valid when a leader exits first.
  if(child.pid&&await cleanupOwnedGroup(child.pid))aborted=aborted||'UNEXPECTED_SURVIVING_DESCENDANT';
  exits.push({phase,...exit,aborted});
  writeFileSync(resolve(root,`exit-${phase}.json`),JSON.stringify(exits.at(-1)),{flag:'wx',mode:0o600});
  if(exit.exit_code!==0||aborted||!existsSync(resolve(root,`phase-${phase}.json`))){failed=aborted||'CHILD_FAILED';break;}
}
await Promise.all([new Promise(r=>log.end(r)),new Promise(r=>metrics.end(r))]);
writeFileSync(resolve(root,'result.json'),JSON.stringify({status:failed?'FAILED':(mainMode?'CHECKPOINTED_MAIN_COMPLETE':'RUNTIME_RESUME_PROOF_COMPLETE'),failed,exits,
  elapsed_seconds:(Date.now()-started)/1000,workload_identity:plan.workload_identity??null,completed_updates:completedUpdates,
  formal_credit:false,main_updates:mainMode?completedUpdates:0,disposable_updates:mainMode?0:completedUpdates,promotion:false,
  note:mainMode?'Bounded main segment; not semantic acceptance or promotion.':'Disposable runtime proof only; not product acceptance or semantic improvement.'},null,2),{flag:'wx',mode:0o600});
if(failed)process.exitCode=1;
