// One changed-workload diagnostic, then at most twelve main updates; no retry.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {revalidateDevelopmentTrainingReview} from './lib/qualification-worker/aiReview.mjs';
import {validateCheckpointedPlan} from './lib/checkpointedContinuation.mjs';
const cli=process.argv.slice(2),twoLayer=cli.includes('--two-layer'),boundedMemory=cli.includes('--bounded-memory');
if(boundedMemory&&!twoLayer)throw Error('Memory experiment requires explicit two-layer configuration');
const [dataArg,reviewArg,rootArg,mode,proofArg]=cli.filter(x=>!['--two-layer','--bounded-memory'].includes(x));
const trainableLayers=twoLayer?2:4;
if(!dataArg||!reviewArg||!rootArg||!['proof','main'].includes(mode)||(mode==='main'&&!proofArg))throw Error('dataset review fresh-output proof|main [proof-root] required');
const dataset=resolve(dataArg),reviewRoot=resolve(reviewArg),root=resolve(rootArg);
if(existsSync(root))throw Error('Fresh output required');
const historical=resolve('/Users/hltsang/.codex/private/pension-adaptability/20260912/recovery-from12');
const source=JSON.parse(readFileSync(resolve(historical,'training-plan.json')));
for(const item of source.bound_inputs)if(hash(item.path)!==item.sha256)throw Error('Historical source binding changed: '+item.path);
const status=JSON.parse(readFileSync('docs/live-repair/STATUS.json'));
if(status.training_continuation.main_updates_completed!==30||status.training_continuation.durable_weight_lineage_updates!==19)throw Error('Reconcile changed main accounting before preparation');
const config=JSON.parse(readFileSync('config/qualification-worker.json'));config.__project_root=resolve('.');
const packet=JSON.parse(readFileSync(resolve(dataset,'review-packet.json')));
const review=revalidateDevelopmentTrainingReview({packet,config,outputDir:reviewRoot});
if(!review.passed)throw Error('Exact dataset lacks two passing reviews');
const preflightPath=resolve(dataset,'serving-wrapper-preflight-3680.json'),preflight=JSON.parse(readFileSync(preflightPath));
if(!preflight.passed||preflight.max_seq_length!==3680||preflight.maximum_observed_tokens!==3625)throw Error('Exact untruncated shape proof missing');
for(const partition of ['train','valid'])if(hash(resolve(dataset,partition+'.jsonl'))!==preflight.dataset_hashes[partition])throw Error('Data changed after tokenizer check');
const parent=resolve(historical,'durable-updates/007/adapters.safetensors');
if(hash(parent)!=='7acdd70dbb9eaf6b9e12c985a77b61f13c445abc8ed99887b86c30dcf1a2e5ba')throw Error('Latest durable lineage19 changed');
const parentConfig=dirname(source.parent_adapter);source.parent_adapter=parent;
const code=['ml/prove_adaptability_resume.py','ml/adaptability_resume.py','ml/adaptability_trainables.py','ml/train_adaptability.py','ml/assistant_target_loss.py','ml/adaptability_validation.py','scripts/runAdaptabilityResumeProof.mjs','scripts/continueAdaptabilityStudy.mjs','scripts/lib/adaptabilityTelemetry.mjs','scripts/lib/adaptabilityResourceLimits.mjs','scripts/lib/checkpointedContinuation.mjs','scripts/lib/boundedFileDigest.mjs'];
if(boundedMemory)code.push('ml/adaptability_memory.py');
const workload={base_sha256:hash(resolve(source.base_path,'model.safetensors')),parent_sha256:hash(parent),
 dataset_hashes:preflight.dataset_hashes,max_seq_length:3680,trainable_layers:trainableLayers,batch:1,accumulation:1,optimizer:'Adam',learning_rate:1e-5,seed:42,
 runtime:{mlx:'0.32.2','mlx-lm':'0.31.3',transformers:'5.16.1'},code:code.map(p=>({path:resolve(p),sha256:hash(resolve(p))}))};
if(boundedMemory)workload.memory_strategy='frozen-prefix-query128';
const workloadIdentity=createHash('sha256').update(JSON.stringify(workload)).digest('hex');
let proof=null;
if(mode==='main'){
 const p=resolve(proofArg),result=resolve(p,'result.json'),verification=resolve(p,'phase-verify.json');
 const completed=JSON.parse(readFileSync(result));
 if(completed.status!=='RUNTIME_RESUME_PROOF_COMPLETE'||completed.failed||completed.completed_updates!==2)throw Error('Runtime proof failed or incomplete; no main directory or process created');
 proof={result_path:result,result_sha256:hash(result),verification_path:verification,verification_sha256:hash(verification)};
 if(JSON.parse(readFileSync(result)).workload_identity!==workloadIdentity)throw Error('Proof is for different workload');
}
const cpu=spawnSync('/usr/bin/sandbox-exec',['-f',resolve(historical,'training.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/test_adaptability_resume.py')],{encoding:'utf8',timeout:60000});
if(cpu.status!==0)throw Error('CPU resume test failed: '+cpu.stderr);
const cpuReceipt=JSON.parse(cpu.stdout);if(!cpuReceipt.model_optimizer_rng_bit_exact||!cpuReceipt.fresh_process_resume)throw Error('CPU resume equivalence incomplete');
if(boundedMemory){
 const check=spawnSync('/usr/bin/sandbox-exec',['-f',resolve(historical,'training.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/test_adaptability_memory.py')],{encoding:'utf8',timeout:60000});
 if(check.status!==0)throw Error('Memory correctness test failed: '+check.stderr);
 cpuReceipt.memory_equivalence=JSON.parse(check.stdout);
 if(!cpuReceipt.memory_equivalence.passed)throw Error('Memory equivalence incomplete');
}
mkdirSync(root,{mode:0o700});copyFileSync(resolve(historical,'training.sb'),resolve(root,'training.sb'));
writeFileSync(resolve(root,'cpu-equivalence.json'),JSON.stringify(cpuReceipt,null,2),{flag:'wx',mode:0o600});
let runData=dataset;
if(mode==='proof'){
 runData=resolve(root,'smoke-data');mkdirSync(runData,{mode:0o700});
 const rows=readFileSync(resolve(dataset,'train.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const inventory=preflight.rows.filter(x=>x.partition==='train').sort((a,b)=>b.tokens-a.tokens);
 const padded=x=>Math.min(3680,1+32*Math.ceil(x.tokens/32));
 const longest=inventory[0],second=inventory.find(x=>padded(x)!==padded(longest));
 if(!second)throw Error('Second supported padded shape missing');
 const chosen=[longest,second].map(x=>rows.find(r=>r.metadata.training_id===x.id));
 writeFileSync(resolve(runData,'train.jsonl'),chosen.map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx',mode:0o600});
 copyFileSync(resolve(dataset,'valid.jsonl'),resolve(runData,'valid.jsonl'));
 writeFileSync(resolve(root,'smoke-selection.json'),JSON.stringify({longest,second,full_validation:8,validation_training_overlap:false}),{flag:'wx',mode:0o600});
}
const paths=[...code,'scripts/prepareCheckpointedContinuation.mjs','scripts/preflightCurrentPromptDraft.py','docs/live-repair/CHECKPOINTED-CONTINUATION-20260912.md','docs/live-repair/OWNER-TRAINING-AMENDMENT-20260912.json',resolve(root,'training.sb'),resolve(root,'cpu-equivalence.json'),parent,resolve(parentConfig,'adapter_config.json'),source.recovery.native_probe,preflightPath,
 ...['train.jsonl','valid.jsonl','review-packet.json'].map(x=>resolve(dataset,x)),resolve(reviewRoot,'training-data-review.json'),
 ...['model.safetensors','config.json','tokenizer.json','tokenizer_config.json'].map(x=>resolve(source.base_path,x)),
 ...['train.jsonl','valid.jsonl'].map(x=>resolve(runData,x))];
if(twoLayer)paths.push('docs/live-repair/TWO-LAYER-CONTINUATION-20260912.md');
if(boundedMemory)paths.push('docs/live-repair/BOUNDED-MEMORY-20260912.md','ml/test_adaptability_memory.py');
if(proof)paths.push(proof.result_path,proof.verification_path);
const plan={version:'checkpointed-continuation-v1',owner_authorized_training:true,
 authority:'User explicitly requested necessary training amendments and then continued the source correction/new workload/main-resume work. One changed-workload two-update proof and one twelve-update main segment; no automatic retry or expansion.',
 preserve_checkpoint:104,automatic_retry:false,maximum_disposable_updates:mode==='proof'?2:0,
 checkpointed_segment:{mode,trainable_layers:trainableLayers,maximum_updates:mode==='proof'?2:12,max_seq_length:3680,expected_longest_tokens:3625,parent_lineage_updates:19,confirmed_main_updates_before:30,maximum_total_main_work:42,main_weight_lineage_limit:31,optimizer_reset_reason:'Legacy19 lacks RNG/order; revised dataset starts fresh Adam. Subsequent updates restore complete state.'},
 source,smoke_data:runData,full_dataset:dataset,parent_config_directory:parentConfig,versions:workload.runtime,workload_identity:workloadIdentity,workload,
 runtime_proof:proof,native_probe:source.recovery.native_probe,
 resource_limits:{...source.resource_limits,total_seconds:mode==='proof'?1800:7200},
 stage_seconds:{launch:90,load:90,restored:30,compile_and_update:150,save:45,full_validation:180,generation:90,complete:30},
 comparison:{candidates:['baseline104','parent19','segment12_lineage31'],maximum_generations:24,maximum_reviewer_calls:6,max_tokens:320,temperature:0.1,automatic_retry:false,scope:'Fixed supplied-evidence validation, not browser qualification',selection:'All hard gates clean; semantic PASS count first, then omissions/questions, loss secondary with1% tie; no automatic promotion'},
 bound_inputs:[...new Set(paths.map(x=>resolve(x)))].map(path=>({path,sha256:hash(path)}))};
if(boundedMemory)plan.checkpointed_segment.memory_strategy='frozen-prefix-query128';
validateCheckpointedPlan(plan);
writeFileSync(resolve(root,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,mode,plan_sha256:hash(resolve(root,'plan.json')),workload_identity:workloadIdentity,child_started:false}));
