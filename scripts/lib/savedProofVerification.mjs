import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {boundedFileDigest as hash} from './boundedFileDigest.mjs';
export function validateSavedProof(root){
 const read=name=>JSON.parse(readFileSync(resolve(root,name)));
 const plan=read('plan.json'),result=read('result.json');
 if(plan.checkpointed_segment?.mode!=='proof'||plan.checkpointed_segment.maximum_updates!==2||
    plan.workload.memory_strategy!=='frozen-prefix-query128'||result.failed!=='STAGE_TIMEOUT_full_validation'||
    result.completed_updates!==2||result.main_updates!==0||result.workload_identity!==plan.workload_identity||
    result.exits.length!==3||result.exits.slice(0,2).some((x,i)=>x.phase!==String(i+1)||x.exit_code!==0||x.signal||x.aborted)||
    result.exits[2].phase!=='verify'||result.exits[2].aborted!=='STAGE_TIMEOUT_full_validation')throw Error('Only completed two-update proof with validation timeout may be supplemented');
 for(const item of plan.bound_inputs)if(hash(item.path)!==item.sha256)throw Error('Original proof input changed: '+item.path);
 for(const i of [1,2]){
  const phase=read(`phase-${i}.json`),meta=read(`checkpoints/${i}/complete.json`);
  if(phase.completed_updates!==i||!phase.finite_gradients||!phase.frozen_adapter_tensors_unchanged||
     hash(resolve(root,`checkpoints/${i}/complete.json`))!==phase.checkpoint_metadata_sha256||meta.completed_updates!==i||meta.identity?.plan_sha256!==hash(resolve(root,'plan.json')))throw Error('Incomplete saved update');
  for(const file of ['adapter.safetensors','state.safetensors'])if(hash(resolve(root,`checkpoints/${i}/${file}`))!==phase.checkpoint_hashes[file])throw Error('Saved checkpoint changed');
 }
 return {plan,result};
}
