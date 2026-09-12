import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {boundedFileDigest as hash} from '../scripts/lib/boundedFileDigest.mjs';
import {validateCheckpointedPlan,stageDeadlineExceeded,cleanupOwnedGroup} from '../scripts/lib/checkpointedContinuation.mjs';
const plan=()=>({workload:{trainable_layers:4},checkpointed_segment:{mode:'proof',maximum_updates:2,max_seq_length:3680,expected_longest_tokens:3625,parent_lineage_updates:19,confirmed_main_updates_before:30},owner_authorized_training:true,automatic_retry:false,preserve_checkpoint:104,workload_identity:'a'.repeat(64),resource_limits:{prestart_swap_max_mib:6144,system_swap_absolute_max_mib:8192,swap_growth_max_mib:2048,system_free_min_percent:10,process_physical_footprint_max_gib:12,mlx_peak_max_decimal_gb:14,total_seconds:1800},stage_seconds:{launch:90,load:90,restored:30,compile_and_update:150,save:45,full_validation:180,generation:90,complete:30}});
test('two-layer work must be explicitly bound and cannot reuse four-layer identity settings',()=>{
 const p=plan();p.checkpointed_segment.trainable_layers=2;
 assert.throws(()=>validateCheckpointedPlan(p,{verifyFiles:false}),/Trainable workload/);
 p.workload.trainable_layers=2;
 assert.equal(validateCheckpointedPlan(p,{verifyFiles:false}).trainable_layers,2);
 for(const layers of [0,1,3,8,16,'2']){
  p.checkpointed_segment.trainable_layers=layers;p.workload.trainable_layers=layers;
  assert.throws(()=>validateCheckpointedPlan(p,{verifyFiles:false}),/Trainable workload/);
 }
});
test('checkpointed continuation separates disposable updates and bounded main work',()=>{
 assert.equal(validateCheckpointedPlan(plan(),{verifyFiles:false}).mode,'proof');
 const p=plan();p.checkpointed_segment.mode='main';p.checkpointed_segment.maximum_updates=12;p.resource_limits.total_seconds=7200;
 assert.equal(validateCheckpointedPlan(p,{verifyFiles:false}).maximum_updates,12);
 p.checkpointed_segment.maximum_updates=18;assert.throws(()=>validateCheckpointedPlan(p,{verifyFiles:false}),/bounded/);
});
test('memory strategy requires matching workload and declared two-layer tail',()=>{
 const p=plan();p.checkpointed_segment.memory_strategy='frozen-prefix-query128';
 assert.throws(()=>validateCheckpointedPlan(p,{verifyFiles:false}),/Memory strategy/);
 p.workload.memory_strategy='frozen-prefix-query128';
 assert.throws(()=>validateCheckpointedPlan(p,{verifyFiles:false}),/Memory strategy/);
 p.checkpointed_segment.trainable_layers=2;p.workload.trainable_layers=2;
 assert.equal(validateCheckpointedPlan(p,{verifyFiles:false}).memory_strategy,'frozen-prefix-query128');
 p.workload.memory_strategy='short-context';assert.throws(()=>validateCheckpointedPlan(p,{verifyFiles:false}),/Memory strategy/);
});
test('checkpointed plan rejects drift in guard, lineage, sequence and retry settings',()=>{
 for(const change of [p=>p.resource_limits.swap_growth_max_mib=4096,p=>p.resource_limits.system_free_min_percent=5,p=>p.automatic_retry=true,p=>p.checkpointed_segment.parent_lineage_updates=12,p=>p.checkpointed_segment.max_seq_length=4096,p=>p.owner_authorized_training=false,p=>p.stage_seconds.compile_and_update=999]){
  const p=plan();change(p);assert.throws(()=>validateCheckpointedPlan(p,{verifyFiles:false}));
 }
});
test('stage watchdog bounds silent model work and rejects unknown stages',()=>{
 const limits=plan().stage_seconds;
 assert.equal(stageDeadlineExceeded('compile_and_update',149999,limits),false);
 assert.equal(stageDeadlineExceeded('compile_and_update',150001,limits),true);
 assert.equal(stageDeadlineExceeded('untrusted-stage',0,limits),true);
});
test('main requires exact hash-bound complete proof, not an approval boolean',()=>{
 const p=plan();p.checkpointed_segment.mode='main';p.checkpointed_segment.maximum_updates=12;p.resource_limits.total_seconds=7200;p.bound_inputs=[];
 assert.throws(()=>validateCheckpointedPlan(p),/proof required/);
 const root=mkdtempSync(join(tmpdir(),'synthetic-resume-proof-')),r=join(root,'result.json'),v=join(root,'verify.json');
 const result={status:'RUNTIME_RESUME_PROOF_COMPLETE',failed:null,completed_updates:2,main_updates:0,workload_identity:p.workload_identity,exits:[1,2,3].map(()=>({exit_code:0,signal:null,aborted:null}))};
 writeFileSync(r,JSON.stringify(result));writeFileSync(v,JSON.stringify({completed_updates:2,validation_items:8,full_validation_loss:1,finish_reason:'stop'}));
 p.runtime_proof={result_path:r,result_sha256:hash(r),verification_path:v,verification_sha256:hash(v)};
 assert.equal(validateCheckpointedPlan(p).mode,'main');
 result.workload_identity='b'.repeat(64);writeFileSync(r,JSON.stringify(result));
 assert.throws(()=>validateCheckpointedPlan(p),/receipt changed/);
 p.runtime_proof.result_sha256=hash(r);assert.throws(()=>validateCheckpointedPlan(p),/incompatible/);
});
test('cleanup stops the created group after leader exit without stopping another group',async()=>{
 const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 const leader=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref();`],{detached:true,stdio:['ignore','pipe','ignore']});
 let output='';leader.stdout.on('data',x=>output+=x);
 try{
  await new Promise((yes,no)=>{leader.once('error',no);leader.once('close',yes)});
  assert.ok(Number(output.trim())>1);
  assert.equal(await cleanupOwnedGroup(leader.pid,{graceMs:100}),true);
  assert.doesNotThrow(()=>process.kill(other.pid,0));
 }finally{
  await cleanupOwnedGroup(leader.pid,{graceMs:100});await cleanupOwnedGroup(other.pid,{graceMs:100});
 }
});
