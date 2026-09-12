// Automatic continuation from a completed proof; never repeat a consumed run.
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const [bindingArg,rootArg]=process.argv.slice(2);
if(!bindingArg||!rootArg)throw Error('Successful diagnostic binding and dedicated main root required');
const binding=resolve(bindingArg),root=resolve(rootArg);
async function phase(script,args){
 console.log(JSON.stringify({event:'study_phase_start',script,at:new Date().toISOString()}));
 const child=spawn(process.execPath,[resolve(script),...args],{stdio:'inherit'});
 const interrupt=()=>child.kill('SIGTERM');process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
 const result=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>accept({code,signal}));});
 process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);
 if(result.code!==0||result.signal)throw Error('Study stopped at '+script+'; inspect receipts, no automatic retry');
}
if(bindingArg==='--checkpointed'){
 const {validateCheckpointedPlan}=await import('./lib/checkpointedContinuation.mjs');
 const p=JSON.parse(readFileSync(resolve(root,'plan.json')));
 if(validateCheckpointedPlan(p).mode!=='main')throw Error('Main segment plan required');
 await phase('scripts/runAdaptabilityResumeProof.mjs',[root]);
 console.log(JSON.stringify({event:'checkpointed_main_completed',root,selection:'NOT_PERFORMED',qualified:false}));
 process.exit(0);
}
if(!existsSync(root))await phase('scripts/prepareAdaptabilityMain.mjs',[binding,root,...(process.argv[4]==='--host-validation'?['--host-validation']:[]),...(process.argv[5]==='--free-memory-10'?['--free-memory-10']:[])]);
const plan=JSON.parse(readFileSync(resolve(root,'training-plan.json')));
if(resolve(plan.runtime_proof.binding_path)!==binding)throw Error('Main root belongs to a different proof');
if(!existsSync(resolve(root,'training-exit.json'))){
 if(existsSync(resolve(root,'training-output.log')))throw Error('Main trajectory already started; reconcile its owned process before resuming');
 await phase(plan.validation_aggregation?'scripts/runAdaptabilityTrainingHostValidation.mjs':'scripts/runAdaptabilityTraining.mjs',[root]);
}
const exit=JSON.parse(readFileSync(resolve(root,'training-exit.json')));
if(exit.exit_code!==0||exit.signal||exit.aborted)throw Error('Existing main run did not finish cleanly; do not restart it');
if(!existsSync(resolve(root,'checkpoint-semantic-review.json')))await phase('scripts/runAdaptabilitySelection.mjs',[root]);
if(!existsSync(resolve(root,'checkpoint-selection.json')))await phase('scripts/finalizeAdaptabilityTraining.mjs',[root]);
console.log(JSON.stringify({event:'study_completed',root,qualified:false}));
