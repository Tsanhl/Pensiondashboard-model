import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {boundedFileDigest} from './boundedFileDigest.mjs';

// An owner flag or submitted smoke operation cannot replace completed updates.
export function requireAdaptabilityRuntimeProof(plan){
 const reject=message=>{throw Object.assign(Error(message),{code:'TRAINING_RUNTIME_NOT_PROVEN'});};
 const proof=plan.runtime_proof;
 if(!proof)reject('Main training requires a separately completed two-update/save-reload runtime proof');
 for(const name of ['binding','receipt','exit']){
  if(!proof[name+'_path']||!proof[name+'_sha256']||boundedFileDigest(proof[name+'_path'])!==proof[name+'_sha256'])reject('Runtime proof file binding mismatch: '+name);
 }
 const binding=JSON.parse(readFileSync(proof.binding_path)),receipt=JSON.parse(readFileSync(proof.receipt_path)),exit=JSON.parse(readFileSync(proof.exit_path));
 if(exit.exit_code!==0||exit.signal||exit.abort_reason||exit.aborted||exit.updates_confirmed<2
    ||receipt.updates<2||receipt.main_updates!==0||receipt.save_reload_verified!==true)reject('Runtime diagnostic did not complete two disposable updates and save/reload');
 if(receipt.binding_sha256!==proof.binding_sha256||exit.binding_sha256!==proof.binding_sha256)reject('Runtime completion belongs to different inputs');
 const completed=(receipt.events||[]).filter(x=>x.event==='update_completed');
 if(receipt.clean_interpreter_reload!==true||receipt.clean_validation?.length!==8||receipt.initial_validation_examples!==8||!receipt.clean_generation_sha256||!(receipt.changed_adapter_tensors>0)||!receipt.frozen_before_sha256||receipt.frozen_before_sha256!==receipt.frozen_after_sha256||completed.some(x=>x.finite_gradients!==true))reject('Full finite-gradient, frozen-base, clean reload/validation/generation proof missing');
 if(completed.length!==2||completed.some((x,i)=>x.update!==i+1||x.optimizer_step!==i+1||x.main_run_credit!==false)
    ||!receipt.events?.some(x=>x.event==='diagnostic_completed'&&x.updates===2&&x.save_reload_verified===true))reject('Measured optimiser/update/save-reload events are missing');
 if(!plan.execution||plan.execution.mode!==binding.mode||plan.execution.loss_implementation!==(binding.loss_implementation||'pinned_default_loss'))reject('Runtime proof does not exercise the intended training execution/loss');
 if(!proof.training_runner_sha256||boundedFileDigest(resolve('ml/train_adaptability.py'))!==proof.training_runner_sha256)reject('Training implementation changed after runtime proof');
 for(const path of [plan.parent_adapter,resolve(plan.base_path,'model.safetensors')]){
  const bound=binding.bound_inputs.find(x=>x.path===path);
  if(!bound||boundedFileDigest(path)!==bound.sha256)reject('Runtime proof model lineage mismatch');
 }
 const saved=resolve(binding.output,'adapters.safetensors');
 if(boundedFileDigest(saved)!==receipt.adapter_sha256)reject('Disposable saved adapter bytes changed');
 if(!proof.longest_example_sha256||proof.longest_example_sha256!==plan.longest_example_sha256)reject('Longest supported example is not bound to runtime proof');
 const tokens=JSON.parse(readFileSync(resolve(plan.dataset,'tokenizer-preflight.json')));
 const longest=tokens.rows.filter(x=>x.part==='train').sort((a,b)=>b.total-a.total)[0];
 const row=readFileSync(resolve(plan.dataset,'train.jsonl'),'utf8').trim().split('\n').find(line=>JSON.parse(line).metadata.training_id===longest?.id);
 const actualLongest=row&&createHash('sha256').update(row+'\n').digest('hex');
 if(actualLongest!==proof.longest_example_sha256||!binding.bound_inputs.some(x=>x.sha256===actualLongest))reject('Proof does not bind the actual longest training row');
 return {updates:receipt.updates,main_updates:0,binding_sha256:proof.binding_sha256};
}
