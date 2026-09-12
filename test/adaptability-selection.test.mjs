import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'synthetic-checkpoint-selection-'));const data=join(root,'data'),adapter=join(root,'adapters');mkdirSync(data);mkdirSync(adapter);
 const write=(p,v)=>writeFileSync(p,typeof v==='string'?v:JSON.stringify(v));
 write(join(data,'valid.jsonl'),'synthetic validation only');write(join(adapter,'adapter_config.json'),'{}');
 const records=[12,24,36,48].map((iteration,i)=>{const bytes='SYNTHETIC WEIGHT '+iteration;const path=join(adapter,String(iteration).padStart(7,'0')+'_adapters.safetensors');write(path,bytes);return {iteration,path,sha256:sha(bytes),validation_loss:[1.1,0.6,0.8,1.2][i]};});
 write(join(root,'training-plan.json'),{bound_inputs:[],dataset:data,train:{adapter_path:adapter},memory_limit_gb:14,base_path:root,base_sha256:sha('base'),parent_adapter:'parent',hyperparameters:{},selection_policy:'exact saved weights',review:root});
 const plan=JSON.parse(readFileSync(join(root,'training-plan.json')));plan.bound_inputs=[{path:join(data,'valid.jsonl'),sha256:sha('synthetic validation only')}];plan.parent_adapter=join(data,'valid.jsonl');write(join(root,'training-plan.json'),plan);
 write(join(root,'training-output.log'),'Iter 12: Val loss 0.001\nIter 24: Val loss 4.000\nIter 48: Train loss 0.8, Peak mem 8.000 GB\n{"event": "training_finished"}\n');
 write(join(root,'training-exit.json'),{exit_code:0});
 const exact={records,validation_sha256:sha('synthetic validation only'),training_validation_events:[{iteration:0,val_loss:1.3}]};write(join(root,'exact-checkpoint-validation.json'),exact);
 write(join(root,'optimizer-update-accounting.json'),{completed_optimizer_updates:48,microbatches:48,all_final_trainable_parameters_finite:true,changed_trainable_tensors:1});
 const reviewed=[0,12,24,36,48].map((additional_update_count)=>({additional_update_count,assessment_status:'ASSESSED',identity_valid:true,review_complete:true,hard_failures:[],correct_complete_or_justified_clarification:additional_update_count===24?7:6,material_omissions:0,unnecessary_or_repeated_questions:0}));
 write(join(root,'checkpoint-semantic-review.json'),{validation_sha256:exact.validation_sha256,records:reviewed});
 return {root,exact,write};
}
test('selection uses losses bound to exact saved bytes, not pre-update log labels',()=>{
 const {root}=fixture();const r=spawnSync(process.execPath,[resolve('scripts/finalizeAdaptabilityTraining.mjs'),root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const selection=JSON.parse(readFileSync(join(root,'checkpoint-selection.json')));assert.equal(selection.selected_additional_update_count,24);assert.equal(selection.selected_validation_loss,0.6);
});
test('selection rejects duplicate checkpoint evidence',()=>{
 const {root,exact,write}=fixture();exact.records.push(exact.records[0]);write(join(root,'exact-checkpoint-validation.json'),exact);
 const r=spawnSync(process.execPath,[resolve('scripts/finalizeAdaptabilityTraining.mjs'),root],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/each candidate once/);
});
