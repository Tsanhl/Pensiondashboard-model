import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {boundedFileDigest} from '../scripts/lib/boundedFileDigest.mjs';
import {requireAdaptabilityRuntimeProof} from '../scripts/lib/adaptabilityRuntimeProof.mjs';
test('owner authorisation and one-step smoke configuration do not authorise main execution without runtime proof',()=>{
 assert.throws(()=>requireAdaptabilityRuntimeProof({authorization:{owner_authorized_training:true},smoke:{iters:1}}),{code:'TRAINING_RUNTIME_NOT_PROVEN'});
});
test('hash-bound failed gradient probe cannot be counted as a completed training prerequisite',()=>{
 const root=mkdtempSync(join(tmpdir(),'pension-synthetic-runtime-proof-'));
 try{
  const proof={};for(const [name,value] of Object.entries({binding:{updates:2},receipt:{updates:0,main_updates:0,save_reload_verified:false},exit:{exit_code:null,signal:'SIGTERM',updates_confirmed:0,abort_reason:'HOST_MEMORY_PRESSURE_LIMIT'}})){
   const p=join(root,name+'.json');writeFileSync(p,JSON.stringify(value));proof[name+'_path']=p;proof[name+'_sha256']=boundedFileDigest(p);
  }
  assert.throws(()=>requireAdaptabilityRuntimeProof({runtime_proof:proof}),{code:'TRAINING_RUNTIME_NOT_PROVEN'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
