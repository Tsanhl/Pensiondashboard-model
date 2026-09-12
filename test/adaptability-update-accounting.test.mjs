import test from 'node:test';
import assert from 'node:assert/strict';
import {assertOneTrajectoryStudyAccounting,interpretPinnedTrainerUpdates} from '../scripts/lib/adaptabilityUpdateAccounting.mjs';
import {selectDurationCandidate} from '../scripts/lib/adaptabilityDurationSelection.mjs';

test('pinned batch-one accumulation-one maps 48 microbatches to 48 optimiser updates',()=>{
  const result=interpretPinnedTrainerUpdates({iters:48,batch_size:1,grad_accumulation_steps:1,train_examples:24,scheduled_checkpoint_updates:[0,12,24,36,48]});
  assert.equal(result.completed_optimizer_updates,48);
  assert.equal(result.presented_examples,48);
  assert.equal(result.example_exposure_equivalents,2);
  assert.deepEqual(result.checkpoint_microsteps.map((item)=>item.microbatch_iteration),[0,12,24,36,48]);
});

test('iters are not silently relabelled as optimiser updates under accumulation',()=>{
  const result=interpretPinnedTrainerUpdates({iters:48,batch_size:1,grad_accumulation_steps:2,train_examples:24,scheduled_checkpoint_updates:[0,12,24]});
  assert.equal(result.microbatches,48);
  assert.equal(result.completed_optimizer_updates,24);
  assert.equal(result.effective_examples_per_completed_update,2);
  assert.deepEqual(result.checkpoint_microsteps.map((item)=>item.microbatch_iteration),[0,24,48]);
  assert.throws(()=>assertOneTrajectoryStudyAccounting({update_cap:48,scheduled_checkpoint_updates:[0,12,24,36,48],hyperparameters:{iters:48,batch_size:1,grad_accumulation_steps:2,save_every:12}}));
});

test('duration selector applies hard gates and semantic outcomes before loss',()=>{
  const base={assessment_status:'ASSESSED',identity_valid:true,review_complete:true,hard_failures:[],material_omissions:0,unnecessary_or_repeated_questions:0};
  const result=selectDurationCandidate([
    {...base,additional_update_count:0,correct_complete_or_justified_clarification:6,validation_loss:1.01},
    {...base,additional_update_count:12,correct_complete_or_justified_clarification:5,validation_loss:.50},
    {...base,additional_update_count:24,correct_complete_or_justified_clarification:7,validation_loss:1.005},
    {...base,additional_update_count:36,correct_complete_or_justified_clarification:8,validation_loss:.4,hard_failures:['unsupported_legal_scope']}
  ]);
  assert.equal(result.selected.additional_update_count,24);
});

test('duration selector keeps baseline when a new checkpoint has no semantic benefit',()=>{
  const base={assessment_status:'ASSESSED',identity_valid:true,review_complete:true,hard_failures:[],correct_complete_or_justified_clarification:6,material_omissions:0,unnecessary_or_repeated_questions:0};
  const result=selectDurationCandidate([
    {...base,additional_update_count:0,validation_loss:1},
    {...base,additional_update_count:12,validation_loss:.5}
  ]);
  assert.equal(result.selected.additional_update_count,0);
  assert.equal(result.reason,'NO_OBSERVED_SEMANTIC_BENEFIT_OVER_BASELINE');
});
