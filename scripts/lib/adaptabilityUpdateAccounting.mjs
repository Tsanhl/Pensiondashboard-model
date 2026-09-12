const positiveInteger=(value,name)=>{
  if(!Number.isInteger(value)||value<1)throw new Error(`${name} must be a positive integer`);
  return value;
};

// mlx-lm 0.31.3 uses `iters` for microbatches. The optimiser is updated only
// when iteration % grad_accumulation_steps === 0; a trailing partial
// accumulation is not applied by the pinned loop.
export function interpretPinnedTrainerUpdates({
  iters,
  batch_size:batchSize,
  grad_accumulation_steps:accumulationSteps,
  train_examples:trainExamples,
  scheduled_checkpoint_updates:scheduledUpdates=[]
}){
  positiveInteger(iters,'iters');
  positiveInteger(batchSize,'batch_size');
  positiveInteger(accumulationSteps,'grad_accumulation_steps');
  positiveInteger(trainExamples,'train_examples');
  const completedOptimizerUpdates=Math.floor(iters/accumulationSteps);
  const trailingMicrobatches=iters%accumulationSteps;
  const presentedExamples=iters*batchSize;
  const effectiveExamplesPerCompletedUpdate=batchSize*accumulationSteps;
  const checkpointMicrosteps=scheduledUpdates.map((update)=>{
    if(!Number.isInteger(update)||update<0)throw new Error('scheduled checkpoint updates must be non-negative integers');
    return {additional_update_count:update,microbatch_iteration:update*accumulationSteps};
  });
  return {
    trainer:'mlx-lm',
    pinned_version:'0.31.3',
    cli_iters_meaning:'microbatch_iterations',
    iters,
    microbatches:iters,
    completed_optimizer_updates:completedOptimizerUpdates,
    trailing_unapplied_microbatches:trailingMicrobatches,
    batch_size:batchSize,
    gradient_accumulation_steps:accumulationSteps,
    effective_examples_per_completed_update:effectiveExamplesPerCompletedUpdate,
    presented_examples:presentedExamples,
    eligible_training_examples:trainExamples,
    example_exposure_equivalents:presentedExamples/trainExamples,
    checkpoint_microsteps:checkpointMicrosteps
  };
}

export function assertOneTrajectoryStudyAccounting(plan,{trainExamples=24}={}){
  const scheduled=plan.scheduled_checkpoint_updates||[0,12,24,36,48];
  const accounting=interpretPinnedTrainerUpdates({
    ...plan.hyperparameters,
    train_examples:trainExamples,
    scheduled_checkpoint_updates:scheduled
  });
  if(plan.update_cap!==48)throw new Error('The initial duration study update cap must remain 48');
  if(JSON.stringify(scheduled)!==JSON.stringify([0,12,24,36,48]))throw new Error('Unexpected duration-study checkpoint schedule');
  if(accounting.trailing_unapplied_microbatches)throw new Error('Training plan leaves unapplied accumulated gradients');
  if(accounting.completed_optimizer_updates!==plan.update_cap)throw new Error('CLI iters do not map to the declared optimiser-update cap');
  const saveEvery=positiveInteger(plan.hyperparameters.save_every,'save_every');
  if(accounting.checkpoint_microsteps.slice(1).some(({microbatch_iteration})=>microbatch_iteration%saveEvery!==0)){
    throw new Error('Pinned save cadence does not cover every scheduled optimiser checkpoint');
  }
  return accounting;
}
