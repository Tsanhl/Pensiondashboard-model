import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {revalidateDevelopmentTrainingReview} from './lib/qualification-worker/aiReview.mjs';
import {boundedFileDigest} from './lib/boundedFileDigest.mjs';
import {assertOneTrajectoryStudyAccounting} from './lib/adaptabilityUpdateAccounting.mjs';
import {loadTrainingAuthorization} from './lib/adaptabilityTrainingAuthorization.mjs';
const [dataset,review,output]=process.argv.slice(2).map(p=>resolve(p));
if(!dataset||!review||!output||existsSync(output))throw Error('Fresh training run directory required');
const hash=boundedFileDigest;
const lastLayers=Number(process.argv[5]||4);
if(![4,16].includes(lastLayers))throw Error('Only predeclared 4 or 16 last-layer configuration');
const authorization=loadTrainingAuthorization(resolve(lastLayers===4?'docs/live-repair/TRAINING-FOUR-LAYER-AMENDMENT-20260912.json':'docs/live-repair/OWNER-TRAINING-AMENDMENT-20260912.json'));
const config=JSON.parse(readFileSync('config/qualification-worker.json'));config.__project_root=resolve('.');
const packet=JSON.parse(readFileSync(resolve(dataset,'review-packet.json')));
revalidateDevelopmentTrainingReview({packet,config,outputDir:review});
const records=[];
for(const part of ['train','valid']){
 const p=resolve(dataset,part+'.jsonl'),rows=readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);
 const expected=packet.items.filter(x=>x.partition===part);
 if(rows.length!==expected.length||rows.some((r,i)=>createHash('sha256').update(JSON.stringify(r)).digest('hex')!==expected[i].row_sha256))throw Error('Rows differ from independent review packet');
 records.push({path:p,sha256:hash(p)});
}
const parent=resolve('adapters/pension-assistant-cumulative-t4-legal-v1-selected/adapters.safetensors');
if(hash(parent)!=='b370306a3078abd79af14e14c4690a4f394800f1096592ca6528e213cf5a6337')throw Error('Parent 104 mismatch');
const tokens=JSON.parse(readFileSync(resolve(dataset,'tokenizer-preflight.json')));
if(!tokens.prefix_all_match||tokens.max_completion>192||tokens.maximum_tokens>3584)throw Error('Serving length/masking preflight failed');
mkdirSync(output,{recursive:true,mode:0o700});
const smokeData=resolve(output,'smoke-data');mkdirSync(smokeData);
for(const part of ['train','valid']){
 const allRows=readFileSync(resolve(dataset,part+'.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const ordered=tokens.rows.filter(x=>x.part===part).sort((a,b)=>b.total-a.total);
 const selected=part==='valid' ? allRows : [ordered[0],ordered.at(-1)].map((tokenRow)=>allRows.find((row)=>row.metadata.training_id===tokenRow.id));
 writeFileSync(resolve(smokeData,part+'.jsonl'),selected.map(JSON.stringify).join('\n')+'\n',{flag:'wx',mode:0o600});
 records.push({path:resolve(smokeData,part+'.jsonl'),sha256:hash(resolve(smokeData,part+'.jsonl'))});
}
for(const p of [parent,resolve('adapters/pension-assistant-cumulative-t4-legal-v1-selected/adapter_config.json'),resolve('ml/train_adaptability.py'),resolve('ml/assistant_target_loss.py'),resolve('scripts/runAdaptabilityTraining.mjs'),resolve('scripts/lib/adaptabilityRuntimeProof.mjs'),resolve('scripts/lib/adaptabilityUpdateAccounting.mjs'),resolve('scripts/lib/adaptabilityDurationSelection.mjs'),resolve('scripts/lib/boundedFileDigest.mjs'),resolve('scripts/finalizeAdaptabilityTraining.mjs'),resolve(dataset,'review-packet.json'),resolve(review,'training-data-review.json')])records.push({path:p,sha256:hash(p)});
const base=resolve('models/mlx/Qwen3-8B-4bit');
const baseSha=hash(resolve(base,'model.safetensors'));
if(baseSha!=='f2d29621aab300336ad645567ff38c42aac755513006ef4e8a579cf7ef5256d8')throw Error('Base model mismatch');
records.push({path:resolve(base,'model.safetensors'),sha256:baseSha});
for(const name of ['config.json','tokenizer.json','tokenizer_config.json'])records.push({path:resolve(base,name),sha256:hash(resolve(base,name))});
const plan={version:'adaptability-duration-study-v3',runtime_proof:null,execution:{mode:'compiled',loss_implementation:'assistant_target_loss_v1'},created_at:new Date().toISOString(),authorization,base_path:base,base_sha256:baseSha,parent_adapter:parent,parent_checkpoint:104,iteration_312_forbidden:true,dataset,review,bound_inputs:records,why_48:'NOT_DOCUMENTED',update_cap:48,scheduled_checkpoint_updates:[0,12,24,36,48],trajectory_count:1,selection_policy:'Apply identity, complete-review and hard-failure gates first; compare reviewed semantic outcomes before validation loss; where loss differs by no more than 1%, prefer fewer additional updates; retain checkpoint 104 when no semantic benefit is observed.',hyperparameters:{fine_tune_type:'lora',optimizer:'adam',seed:42,num_layers:16,batch_size:1,iters:48,val_batches:-1,learning_rate:0.00001,steps_per_report:1,steps_per_eval:12,grad_accumulation_steps:1,save_every:12,max_seq_length:3584,grad_checkpoint:true,clear_cache_threshold:0,lora_parameters:{rank:8,dropout:0.05,scale:20}},smoke:{data:smokeData,adapter_path:resolve(output,'quarantined-smoke'),iters:2,val_batches:-1,steps_per_eval:1,save_every:1},train:{data:dataset,adapter_path:resolve(output,'adapters')},memory_limit_gb:14,formal_credit:false,sealed_unseen_accessed:false};
plan.update_accounting=assertOneTrajectoryStudyAccounting(plan,{trainExamples:24});
plan.authorization=authorization;
plan.hyperparameters.trainable_last_layers=lastLayers;
plan.trainable_subset_rationale=lastLayers===4?'Sixteen-layer longest-example backward reached 9.38GiB footprint, 2.84GiB swap growth and 9% free. Freeze earlier adapter layers while preserving all parent weights; reduce training graph without dropping context or changing reviewed data.':'Original sixteen-layer adapter training';
plan.resource_limits=authorization.resource_limits;
records.push({path:authorization.receipt_path,sha256:authorization.receipt_sha256});
for(const name of ['ml/adaptability_trainables.py','scripts/processFootprint.py','scripts/lib/adaptabilityProcessFootprint.mjs','scripts/lib/adaptabilityTrainingAuthorization.mjs','scripts/lib/adaptabilityResourceLimits.mjs']){const path=resolve(name);records.push({path,sha256:hash(path)});}
const longestPath=resolve(smokeData,'longest-example.jsonl');
writeFileSync(longestPath,readFileSync(resolve(smokeData,'train.jsonl'),'utf8').split('\n')[0]+'\n',{flag:'wx',mode:0o600});
plan.longest_example_sha256 = hash(longestPath);
records.push({path:longestPath,sha256:plan.longest_example_sha256});
writeFileSync(resolve(output,'training-plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
const protectedRoots=['training','training 2','Log','Logging','01-question-set-review-revision-v2','Pensiondashboard-model-failclosed-20260902','test/formal','answering/training-scenarios-draft.jsonl'].map(p=>resolve(p));
writeFileSync(resolve(output,'training.sb'),'(version 1)\n(allow default)\n(deny network*)\n(deny file-read-data\n'+protectedRoots.map(p=>' (subpath '+JSON.stringify(p)+')').join('\n')+'\n)\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,plan:resolve(output,'training-plan.json'),train:24,valid:8,steps:48,review_passed:true}));
