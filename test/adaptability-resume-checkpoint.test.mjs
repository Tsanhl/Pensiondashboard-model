import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('real checkpoint helper resumes stochastic CPU training bit-exactly across a fresh process',()=>{
  // The development entrypoint's protected-read boundary is inherited by Python
  // and all three workers. This loads no base-model weights and uses no network.
  const result=spawnSync(resolve('.training-venv/bin/python'),['-I','-B',resolve('ml/test_adaptability_resume.py')],
    {encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.device,'CPU');
  assert.equal(receipt.full_model_proof,false);
  for(const key of ['passed','fresh_process_resume','sample_order_exact','model_optimizer_rng_bit_exact','wrong_identity_and_corruption_rejected'])assert.equal(receipt[key],true,key);
  assert.deepEqual(receipt.split_updates,[5,7]);
});
