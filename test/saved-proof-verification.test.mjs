import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {boundedFileDigest as hash} from '../scripts/lib/boundedFileDigest.mjs';
import {validateSavedProof} from '../scripts/lib/savedProofVerification.mjs';
test('verification supplement accepts completed updates, rejects failed training and changed checkpoint bytes',()=>{
 const root=mkdtempSync(join(tmpdir(),'synthetic-saved-proof-'));
 const write=(name,value)=>writeFileSync(join(root,name),JSON.stringify(value));
 write('plan.json',{checkpointed_segment:{mode:'proof',maximum_updates:2},workload:{memory_strategy:'frozen-prefix-query128'},workload_identity:'a'.repeat(64),bound_inputs:[]});
 const result={failed:'STAGE_TIMEOUT_full_validation',completed_updates:2,main_updates:0,workload_identity:'a'.repeat(64),exits:[{phase:'1',exit_code:0},{phase:'2',exit_code:0},{phase:'verify',exit_code:null,aborted:'STAGE_TIMEOUT_full_validation'}]};
 write('result.json',result);
 for(const i of [1,2]){
  mkdirSync(join(root,`checkpoints/${i}`),{recursive:true});
  for(const file of ['adapter.safetensors','state.safetensors'])write(`checkpoints/${i}/${file}`,{synthetic:true,i});
  write(`checkpoints/${i}/complete.json`,{completed_updates:i,identity:{plan_sha256:hash(join(root,'plan.json'))}});
  write(`phase-${i}.json`,{completed_updates:i,finite_gradients:true,frozen_adapter_tensors_unchanged:true,checkpoint_metadata_sha256:hash(join(root,`checkpoints/${i}/complete.json`)),checkpoint_hashes:Object.fromEntries(['adapter.safetensors','state.safetensors'].map(file=>[file,hash(join(root,`checkpoints/${i}/${file}`))]))});
 }
 assert.equal(validateSavedProof(root).result.completed_updates,2);
 result.exits[1].exit_code=1;write('result.json',result);assert.throws(()=>validateSavedProof(root),/Only completed/);
 result.exits[1].exit_code=0;result.failed='SWAP_GROWTH_LIMIT';write('result.json',result);assert.throws(()=>validateSavedProof(root),/Only completed/);
 result.failed='STAGE_TIMEOUT_full_validation';write('result.json',result);
 write('checkpoints/2/state.safetensors',{corrupt:true});assert.throws(()=>validateSavedProof(root),/checkpoint changed/);
});
