import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {ANSWER_SYSTEM_POLICY,ANSWER_POLICY_VERSION} from '../server/prompts/answerPolicy.js';
import {buildModelContext} from '../server/services/modelContextService.js';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const [sourceArg,rootArg]=process.argv.slice(2);if(!sourceArg||!rootArg)throw Error('Recovery source and fresh comparison root required');
const sourceRoot=resolve(sourceArg),root=resolve(rootArg);if(existsSync(root))throw Error('Fresh comparison required');
const source=JSON.parse(readFileSync(resolve(sourceRoot,'training-plan.json')));
for(const item of source.bound_inputs)if(hash(item.path)!==item.sha256)throw Error('Source binding changed: '+item.path);
const packetPath=resolve(source.dataset,'review-packet.json');
const items=JSON.parse(readFileSync(packetPath)).items.filter(x=>x.partition==='valid');
if(items.length!==8)throw Error('Eight existing validation items required');
const cases=items.map(item=>{
 const context=buildModelContext({self_contained_query:item.question,jurisdiction_scope:'Fictional exercise; no legal jurisdiction asserted',response_route:'ANSWER',response_requirements:[]},[item.source],{snippetChars:1000});
 if(context.sourceExcerpts.some(x=>x.truncated))throw Error('Validation evidence truncated');
 return {id:item.item_id,messages:[{role:'system',content:ANSWER_SYSTEM_POLICY},...context.messages],
   question:item.question,evidence:context.evidenceSources,citation_aliases:context.citationAliases};
});
mkdirSync(root,{mode:0o700});copyFileSync(resolve(sourceRoot,'training.sb'),resolve(root,'model.sb'));
writeFileSync(resolve(root,'cases.json'),JSON.stringify(cases,null,2),{flag:'wx',mode:0o600});
const candidates=[{id:'baseline104',path:source.parent_adapter},{id:'lineage12',path:resolve(sourceRoot,'reconstructed-parent/adapters.safetensors')}].map(x=>({...x,sha256:hash(x.path)}));
const files=['server/prompts/answerPolicy.js','server/services/modelContextService.js','server/services/evidenceExcerptService.js',
 'scripts/prepareEvidenceBoundaryComparison.mjs','scripts/runEvidenceBoundaryComparison.mjs','ml/compare_evidence_boundaries.py',
 'scripts/lib/adaptabilityTelemetry.mjs','scripts/lib/adaptabilitySelectionControls.mjs','scripts/lib/qualification-worker/aiReview.mjs','config/qualification-worker.json',packetPath,resolve(root,'cases.json'),resolve(root,'model.sb')];
const plan={scope:'VALIDATION_REPLAY_CURRENT_PRODUCT_PROMPT_NOT_BROWSER',policy_version:ANSWER_POLICY_VERSION,
 base_path:source.base_path,candidates,maximum_generations:16,maximum_tokens:256,maximum_reviewer_calls:4,
 automatic_retry:false,training_updates:0,resource_limits:{...source.resource_limits,total_seconds:1800},native_probe:source.recovery.native_probe,
 bound_inputs:[...source.bound_inputs,...files.map(path=>({path:resolve(path),sha256:hash(resolve(path))})),...candidates.map(x=>({path:x.path,sha256:x.sha256}))]};
writeFileSync(resolve(root,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,cases:8,candidates:2,generations:16,targets_in_prompt:false,model_started:false}));
