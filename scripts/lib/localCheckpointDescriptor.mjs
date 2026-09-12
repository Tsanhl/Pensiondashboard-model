import {dirname,isAbsolute} from 'node:path';
const baseline104='b370306a3078abd79af14e14c4690a4f394800f1096592ca6528e213cf5a6337';
export function localCheckpointDescriptor(checkpoint){
 if(checkpoint.version!=='adaptability-checkpoint-selection-v3')return {checkpoint,modelIdSuffix:`step${checkpoint.selected_iteration}`};
 const update=checkpoint.selected_additional_update_count;
 if(checkpoint.parent_checkpoint!==104||checkpoint.development_only!==true||![0,12,24,36,48].includes(update)||checkpoint.selected_iteration!==undefined)throw Error('Invalid or ambiguous duration checkpoint identity');
 if(!isAbsolute(checkpoint.source_checkpoint||''))throw Error('Duration source checkpoint must be absolute');
 let adapterPath=checkpoint.selected_adapter_path;
 if(update===0){
  if(checkpoint.adapter_sha256!==baseline104||adapterPath!==null)throw Error('Additional update zero must retain the exact104 baseline');
  adapterPath=dirname(checkpoint.source_checkpoint);
 }else if(typeof adapterPath!=='string'||!isAbsolute(adapterPath))throw Error('Selected duration adapter directory missing');
 return {checkpoint:{...checkpoint,selected_adapter_path:adapterPath,selected_iteration:update===0?104:update,iteration_semantics:update===0?'BASELINE_CHECKPOINT':'ADDITIONAL_OPTIMIZER_UPDATES_FROM_PARENT'},modelIdSuffix:update===0?'step104':`parent104-plus${update}`};
}
