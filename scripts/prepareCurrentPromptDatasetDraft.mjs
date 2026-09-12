// Core-format size probe only. This does NOT migrate historical multi-turn or
// distractor coverage and must never be treated as a runnable training dataset.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {ANSWER_SYSTEM_POLICY,ANSWER_POLICY_VERSION} from '../server/prompts/answerPolicy.js';
import {buildModelContext} from '../server/services/modelContextService.js';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const [sourceArg,rootArg]=process.argv.slice(2);if(!sourceArg||!rootArg)throw Error('Reviewed v4 source and fresh draft root required');
const source=resolve(sourceArg),root=resolve(rootArg);if(existsSync(root))throw Error('Fresh draft required');
const packet=JSON.parse(readFileSync(resolve(source,'review-packet.json')));
mkdirSync(root,{mode:0o700});const counts={};
for(const partition of ['train','valid']){
 const original=readFileSync(resolve(source,partition+'.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const rows=original.map(row=>{
  const item=packet.items.find(x=>x.item_id===row.metadata.training_id&&x.partition===partition);if(!item)throw Error('Missing original reviewed item');
  const context=buildModelContext({self_contained_query:item.question,jurisdiction_scope:item.source.jurisdiction||'Not recorded; do not infer',response_route:'ANSWER',response_requirements:[]},[item.source],{snippetChars:Math.max(1000,item.source.snippet.length)});
  if(context.sourceExcerpts.some(x=>x.truncated)||row.messages.at(-1).role!=='assistant')throw Error('Source or target boundary mismatch');
  return {...row,messages:[{role:'system',content:ANSWER_SYSTEM_POLICY},...context.messages,row.messages.at(-1)]};
 });
 if(rows.length!==(partition==='train'?24:8))throw Error('Split changed');counts[partition]=rows.length;
 writeFileSync(resolve(root,partition+'.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx',mode:0o600});
}
writeFileSync(resolve(root,'draft-receipt.json'),JSON.stringify({status:'CORE_FORMAT_SIZE_PROBE_NOT_TRAINING_DATA',counts,policy_version:ANSWER_POLICY_VERSION,
 source_dataset:source,original_targets_unchanged:true,primary_source_text_unchanged:true,current_serving_system_and_context_builder_used:true,
 all_original_input_material_preserved:false,coverage_warning:'Historical secondary/distractor sources and multi-turn messages are not reconstructed here. A full migration must preserve and re-review them. This probe is not eligible for training.',
 serving_default_excerpt_limit_matched:false,excerpt_scope:'Prospective full-source training format; source-specific limits preserve all reviewed evidence. Production default is1000 chars, so this is not a byte-identical production workload.',
 required_before_gradient:['token/target-window preflight','independent target-policy compatibility review','changed-workload resource proof if existing proof no longer covers shapes','finite new main update budget'],
 permission:'Owner training authority already present; this is data/workload readiness, not an authorization request.',
 source_hashes:['train.jsonl','valid.jsonl','review-packet.json'].map(name=>({name,sha256:hash(resolve(source,name))})),
 output_hashes:['train.jsonl','valid.jsonl'].map(name=>({name,sha256:hash(resolve(root,name))})),formal_credit:false},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,counts,status:'CORE_FORMAT_SIZE_PROBE_NOT_TRAINING_DATA'}));
