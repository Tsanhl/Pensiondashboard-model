import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {requireAdaptabilityRuntimeProof} from './lib/adaptabilityRuntimeProof.mjs';
const [bindingArg,outputArg]=process.argv.slice(2);
if(!bindingArg||!outputArg)throw Error('Completed diagnostic binding and fresh main output required');
const bindingPath=resolve(bindingArg),root=resolve(outputArg),binding=JSON.parse(readFileSync(bindingPath));
if(existsSync(root))throw Error('Refusing existing main trajectory');
for(const x of binding.bound_inputs)if(hash(x.path)!==x.sha256)throw Error('Completed diagnostic input changed: '+x.path);
const plan=JSON.parse(readFileSync(binding.original_plan));
const proof={training_runner_sha256:hash(resolve('ml/train_adaptability.py')),longest_example_sha256:plan.longest_example_sha256};
for(const [name,path] of Object.entries({binding:bindingPath,receipt:resolve(binding.output,'receipt.json'),exit:resolve(dirname(bindingPath),'exit.json')})){
 proof[name+'_path']=path;proof[name+'_sha256']=hash(path);
}
plan.runtime_proof=proof;
requireAdaptabilityRuntimeProof(plan);
// Keep the proof's original plan immutable. Only relocate main output and attach proof.
plan.train.adapter_path=resolve(root,'adapters');
plan.authorization.compatible_two_update_proof=proof.binding_sha256;
if(process.argv[4]==='--host-validation'){
 const compatibilityPath=resolve('docs/live-repair/HOST-VALIDATION-COMPATIBILITY-20260912.json');
 const compatibility=JSON.parse(readFileSync(compatibilityPath));
 const previous=compatibility.previous_start;
 const previousExit=JSON.parse(readFileSync(resolve(previous,'training-exit.json')));
 const previousLog=readFileSync(resolve(previous,'training-output.log'),'utf8');
 if(previousExit.exit_code===0||previousLog.includes('optimizer_update_accounted')||compatibility.synthetic_test.passed!==true||compatibility.main_update_cap!==48)throw Error('Not a tested zero-update validation-only repair');
 const paths=[compatibilityPath,resolve(previous,'training-exit.json'),resolve(previous,'training-output.log'),resolve('ml/adaptability_validation.py'),resolve('ml/train_adaptability_host_validation.py'),resolve('ml/test_adaptability_validation.py'),resolve('scripts/runAdaptabilityTrainingHostValidation.mjs')];
 const records=paths.map(path=>({path,sha256:hash(path)}));
 plan.validation_aggregation={mode:'host_scalar_token_weighted',compatibility_receipt:compatibilityPath,bound_inputs:records};
 plan.bound_inputs.push(...records);
}
if(process.argv[5]==='--free-memory-10'){
 const path=resolve('docs/live-repair/TRAINING-FREE-MEMORY-AMENDMENT-20260912.json');
 const amendment=JSON.parse(readFileSync(path));
 const previous=amendment.previous_start;
 const exit=JSON.parse(readFileSync(resolve(previous,'training-exit.json')));
 if(exit.aborted!=='HOST_FREE_MEMORY_LIMIT'||readFileSync(resolve(previous,'training-output.log'),'utf8').includes('optimizer_update_accounted')||amendment.system_free_min_percent!==10)throw Error('Not the declared zero-update free-memory repair');
 plan.resource_limits={...plan.resource_limits,system_free_min_percent:10};
 plan.resource_amendment={path,sha256:hash(path)};
 for(const file of [path,resolve(previous,'training-exit.json'),resolve(previous,'training-output.log')])plan.bound_inputs.push({path:file,sha256:hash(file)});
}
mkdirSync(root,{mode:0o700});
copyFileSync(binding.profile,resolve(root,'training.sb'));
writeFileSync(resolve(root,'training-plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,runtime_proof_pass:true,child_started:false}));
