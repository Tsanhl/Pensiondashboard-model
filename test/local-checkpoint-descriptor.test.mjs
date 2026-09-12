import test from 'node:test';
import assert from 'node:assert/strict';
import {localCheckpointDescriptor} from '../scripts/lib/localCheckpointDescriptor.mjs';
const baseline='b370306a3078abd79af14e14c4690a4f394800f1096592ca6528e213cf5a6337';
const candidate={version:'adaptability-checkpoint-selection-v3',parent_checkpoint:104,development_only:true,selected_additional_update_count:12,selected_adapter_path:'/synthetic/selected',source_checkpoint:'/synthetic/run/0000012_adapters.safetensors',adapter_sha256:'a'.repeat(64)};
test('local duration identity separates parent104 from twelve additional updates',()=>{
 const value=localCheckpointDescriptor(candidate);
 assert.equal(value.modelIdSuffix,'parent104-plus12');
 assert.equal(value.checkpoint.iteration_semantics,'ADDITIONAL_OPTIMIZER_UPDATES_FROM_PARENT');
 assert.equal(candidate.selected_iteration,undefined);
 assert.throws(()=>localCheckpointDescriptor({...candidate,selected_iteration:116}));
 assert.throws(()=>localCheckpointDescriptor({...candidate,parent_checkpoint:312}));
});
test('duration zero loads the exact baseline directory and is never mislabeled step0',()=>{
 const value=localCheckpointDescriptor({...candidate,selected_additional_update_count:0,selected_adapter_path:null,source_checkpoint:'/synthetic/baseline/adapters.safetensors',adapter_sha256:baseline});
 assert.equal(value.modelIdSuffix,'step104');assert.equal(value.checkpoint.selected_adapter_path,'/synthetic/baseline');
 assert.throws(()=>localCheckpointDescriptor({...candidate,selected_additional_update_count:0,selected_adapter_path:null}));
 const legacy={version:'cumulative-visible-checkpoint-selection-v1',selected_iteration:104};assert.equal(localCheckpointDescriptor(legacy).checkpoint,legacy);
});
