// Explicit owner-delegated control amendment, without modifying proven model code.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {validateCheckpointedPlan} from './lib/checkpointedContinuation.mjs';
import {delegatedValidationSupervisor} from './lib/delegatedValidation.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Prepared main root required');
const plan=JSON.parse(readFileSync(resolve(root,'plan.json')));validateCheckpointedPlan(plan);
if(plan.checkpointed_segment.mode!=='main'||plan.checkpointed_segment.memory_strategy!=='frozen-prefix-query128'||
   existsSync(resolve(root,'attempt.json'))||existsSync(resolve(root,'delegated-control.json')))throw Error('Fresh bounded-memory main required');
const proof=JSON.parse(readFileSync(plan.runtime_proof.result_path));
if(!proof.supplemented_proof||proof.new_gradient_updates!==0)throw Error('Exact completed verification supplement required');
const script=resolve('scripts/runAdaptabilityResumeProof.mjs'),target=resolve(root,'delegated-supervisor.mjs');
const generated=delegatedValidationSupervisor(readFileSync(script,'utf8'),resolve('.'));
writeFileSync(target,generated,{flag:'wx',mode:0o600});
const authority=resolve('docs/live-repair/RESOURCE-ADJUSTMENT-DELEGATION-20260912.md');
const control={version:1,scope:'ONE_PREVIOUSLY_AUTHORIZED_MAIN12',plan_sha256:hash(resolve(root,'plan.json')),
 original_supervisor:{path:script,sha256:hash(script)},executed_supervisor:{path:target,sha256:hash(target)},
 authority:{path:authority,sha256:hash(authority)},wrapper_sha256:hash(resolve('scripts/runDelegatedValidationMain.mjs')),
 transformer_sha256:hash(resolve('scripts/lib/delegatedValidation.mjs')),effective_stage_seconds:{...plan.stage_seconds,full_validation:420},
 unchanged_memory_limits:plan.resource_limits,maximum_updates:12,maximum_total_main_work:42,automatic_retry:false,
 compatibility:'Model, data, optimizer, full-state engine and numerical workload unchanged; only supervisor validation watchdog180->420, justified by verification280s and slowest case45s times8 with margin. Original workload identity remains valid for computation; executed control identity is recorded separately.'};
writeFileSync(resolve(root,'delegated-control.json'),JSON.stringify(control,null,2),{flag:'wx',mode:0o600});
const child=spawn(process.execPath,[target,root],{stdio:'inherit'});
const interrupt=()=>{try{child.kill('SIGTERM')}catch{}};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
const exit=await new Promise(done=>{child.once('error',e=>done({exit_code:null,error:e.message}));child.once('close',(exit_code,signal)=>done({exit_code,signal}))});
process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
writeFileSync(resolve(root,'delegated-exit.json'),JSON.stringify({...exit,control_sha256:hash(resolve(root,'delegated-control.json')),executed_supervisor_sha256:hash(target)}),{flag:'wx',mode:0o600});
process.exitCode=exit.exit_code??1;
