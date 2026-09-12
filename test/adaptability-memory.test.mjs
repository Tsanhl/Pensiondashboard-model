import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
test('memory-bounded Qwen3 keeps full-context loss, QKV gradients and two Adam updates',()=>{
 const r=spawnSync(resolve('.training-venv/bin/python'),['-I','-B',resolve('ml/test_adaptability_memory.py')],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.equal(r.status,0,r.stderr||r.error?.message);
 const v=JSON.parse(r.stdout);assert.equal(v.passed,true);assert.equal(v.full_model_proof,false);
 assert.equal(v.qkv_gradient_equivalence,true);assert.equal(v.suffix_loss_gradient_equivalence,true);
 assert.equal(v.trainable_prefix_rejected,true);assert.equal(v.adam_updates,2);
});
