import {readFileSync} from 'node:fs';
import {boundedFileDigest as hash} from './boundedFileDigest.mjs';
import {validateResourceLimits} from './adaptabilityResourceLimits.mjs';

export function validateCheckpointedPlan(plan,{verifyFiles=true}={}){
 const s=plan.checkpointed_segment;
 if(!s||!['proof','main'].includes(s.mode)||s.maximum_updates!==(s.mode==='proof'?2:12))throw Error('Invalid bounded segment');
 if(s.max_seq_length!==3680||s.expected_longest_tokens>3680||s.expected_longest_tokens<=3584)throw Error('Unexpected workload');
 const layers=s.trainable_layers??4;
 if(![2,4].includes(layers)||plan.workload?.trainable_layers!==layers)throw Error('Trainable workload mismatch');
 if(s.memory_strategy!==plan.workload?.memory_strategy||
    (s.memory_strategy!==undefined&&(s.memory_strategy!=='frozen-prefix-query128'||layers!==2)))throw Error('Memory strategy mismatch');
 if(plan.owner_authorized_training!==true||plan.automatic_retry!==false||plan.preserve_checkpoint!==104)throw Error('Invalid authority or retry boundary');
 if(s.parent_lineage_updates!==19||s.confirmed_main_updates_before!==30||s.maximum_updates+30>48)throw Error('Invalid lineage/accounting');
 validateResourceLimits(plan.resource_limits);
 const expected={prestart_swap_max_mib:6144,system_swap_absolute_max_mib:8192,swap_growth_max_mib:2048,system_free_min_percent:10,process_physical_footprint_max_gib:12,mlx_peak_max_decimal_gb:14,total_seconds:s.mode==='proof'?1800:7200};
 for(const [key,value] of Object.entries(expected))if(plan.resource_limits[key]!==value)throw Error('Changed resource limit: '+key);
 const stages={launch:90,load:90,restored:30,compile_and_update:150,save:45,full_validation:180,generation:90,complete:30};
 for(const [key,value] of Object.entries(stages))if(plan.stage_seconds?.[key]!==value)throw Error('Changed stage budget');
 if(!/^[a-f0-9]{64}$/.test(plan.workload_identity))throw Error('Missing workload identity');
 if(verifyFiles){
  for(const item of plan.bound_inputs)if(hash(item.path)!==item.sha256)throw Error('Bound input changed: '+item.path);
  if(s.mode==='main'){
   if(!plan.runtime_proof)throw Error('Compatible runtime proof required');
   const p=plan.runtime_proof,r=JSON.parse(readFileSync(p.result_path)),v=JSON.parse(readFileSync(p.verification_path));
   if(hash(p.result_path)!==p.result_sha256||hash(p.verification_path)!==p.verification_sha256)throw Error('Proof receipt changed');
   if(r.status!=='RUNTIME_RESUME_PROOF_COMPLETE'||r.failed||r.completed_updates!==2||r.main_updates!==0||r.workload_identity!==plan.workload_identity||r.exits.length!==3||r.exits.some(x=>x.exit_code!==0||x.signal||x.aborted)||v.completed_updates!==2||v.validation_items!==8||!Number.isFinite(v.full_validation_loss)||v.finish_reason!=='stop')throw Error('Incomplete/incompatible runtime proof');
  }
 }
 return s;
}

export function stageDeadlineExceeded(stage,elapsedMs,limits){
 return !Object.hasOwn(limits,stage)||elapsedMs>limits[stage]*1000;
}

// Caller supplies only the detached group it just created, never a searched PID.
export async function cleanupOwnedGroup(pid,{graceMs=5000}={}){
 if(!Number.isInteger(pid)||pid<=1)throw Error('Invalid owned process group');
 const alive=()=>{try{process.kill(-pid,0);return true}catch{return false}};
 if(!alive())return false;
 try{process.kill(-pid,'SIGTERM')}catch{}
 await new Promise(r=>setTimeout(r,graceMs));
 if(alive())try{process.kill(-pid,'SIGKILL')}catch{}
 return true;
}
