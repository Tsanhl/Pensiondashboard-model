import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadTrainingAuthorization} from '../scripts/lib/adaptabilityTrainingAuthorization.mjs';
test('bounded authority is read from a receipt, not an unconditional preparation flag',()=>{
 const root=mkdtempSync(join(tmpdir(),'pension-authority-'));
 try{
  const path=join(root,'receipt.json');
  const authority={owner_authorized_training:true,training_execution_authorized:true,main_trajectories:1,main_update_cap:48,disposable_updates:2};
  writeFileSync(path,JSON.stringify(authority));
  assert.equal(loadTrainingAuthorization(path).owner_authorized_training,true);
  assert.equal(loadTrainingAuthorization(path).receipt_sha256.length,64);
  writeFileSync(path,JSON.stringify({...authority,owner_authorized_training:false}));
  assert.throws(()=>loadTrainingAuthorization(path));
 }finally{rmSync(root,{recursive:true,force:true});}
});
