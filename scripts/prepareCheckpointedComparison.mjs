import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {validateCheckpointedPlan} from './lib/checkpointedContinuation.mjs';
import {ANSWER_POLICY_VERSION,ANSWER_SYSTEM_POLICY} from '../server/prompts/answerPolicy.js';
const [mainArg,rootArg]=process.argv.slice(2);if(!mainArg||!rootArg)throw Error('Completed main root and fresh comparison root required');
const main=resolve(mainArg),root=resolve(rootArg);if(existsSync(root))throw Error('Fresh output required');
const p=JSON.parse(readFileSync(resolve(main,'plan.json')));validateCheckpointedPlan(p);
const result=JSON.parse(readFileSync(resolve(main,'result.json')));
if(result.status!=='CHECKPOINTED_MAIN_COMPLETE'||result.main_updates!==12||result.failed)throw Error('Main did not complete; no automatic partial-candidate substitution');
const packet=JSON.parse(readFileSync(resolve(p.full_dataset,'review-packet.json'))),rows=readFileSync(resolve(p.full_dataset,'valid.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
if(rows.length!==8)throw Error('Validation changed');
const cases=rows.map(row=>{
 const item=packet.items.find(x=>x.item_id===row.metadata.training_id&&x.partition==='valid');
 if(!item||row.messages[0].content!=='/no_think\n'+ANSWER_SYSTEM_POLICY||row.messages.at(-2).role!=='user'||row.messages.at(-1).role!=='assistant')throw Error('Unexpected validation topology/policy');
 const messages=row.messages.slice(0,-1);
 if((messages.at(-1).content.match(/^SOURCE S\d+$/gm)||[]).length!==1)throw Error('Review evidence inventory mismatch');
 return {id:item.item_id,question:item.question,messages,evidence:[item.source],citation_aliases:item.citation_aliases};
});
const candidates=[{id:'baseline104',path:resolve(p.parent_config_directory,'adapters.safetensors'),lineage_updates:0},{id:'parent19',path:p.source.parent_adapter,lineage_updates:19},{id:'segment12_lineage31',path:resolve(main,'checkpoints/12/adapter.safetensors'),lineage_updates:31}].map(x=>({...x,sha256:hash(x.path)}));
const last=JSON.parse(readFileSync(resolve(main,'phase-12.json')));
if(candidates[2].sha256!==last.checkpoint_hashes['adapter.safetensors'])throw Error('Saved candidate changed');
mkdirSync(root,{mode:0o700});copyFileSync(resolve(main,'training.sb'),resolve(root,'model.sb'));
writeFileSync(resolve(root,'cases.json'),JSON.stringify(cases,null,2),{flag:'wx',mode:0o600});
const files=['scripts/prepareCheckpointedComparison.mjs','scripts/runEvidenceBoundaryComparison.mjs','ml/compare_evidence_boundaries.py','scripts/lib/adaptabilitySelectionControls.mjs','scripts/lib/adaptabilityDurationSelection.mjs','scripts/lib/qualification-worker/aiReview.mjs','config/qualification-worker.json','server/prompts/answerPolicy.js',resolve(main,'result.json'),resolve(main,'phase-12.json'),resolve(root,'cases.json'),resolve(root,'model.sb')];
const plan={scope:'FULL_CONTEXT_VALIDATION_REPLAY_NOT_BROWSER_OR_QUALIFICATION',policy_version:ANSWER_POLICY_VERSION,
 base_path:p.source.base_path,candidates,validation_dataset:p.full_dataset,maximum_generations:24,maximum_tokens:320,temperature:0.1,maximum_reviewer_calls:6,automatic_retry:false,
 resource_limits:{...p.resource_limits,total_seconds:3600},native_probe:p.native_probe,
 limitations:['Full reviewed validation messages, not product retrieval or transport/recovery. No targets in generation. Candidate selection is development-only; no model promotion.'],
 bound_inputs:[...p.bound_inputs,...files.map(x=>({path:resolve(x),sha256:hash(resolve(x))})),...candidates.map(x=>({path:x.path,sha256:x.sha256}))]};
writeFileSync(resolve(root,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({root,candidates:3,generations:24,reviewer_calls:6,model_started:false}));
