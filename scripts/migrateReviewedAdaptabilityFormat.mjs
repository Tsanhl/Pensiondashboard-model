// Explicit format migration: preserve every source block, history turn and target.
// Approval of the old rows is not approval of the migrated rows.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ANSWER_SYSTEM_POLICY,ANSWER_POLICY_VERSION} from '../server/prompts/answerPolicy.js';
import {buildModelContext} from '../server/services/modelContextService.js';
const [sourceArg,rootArg]=process.argv.slice(2);if(!sourceArg||!rootArg)throw Error('Reviewed source and fresh migration root required');
const source=resolve(sourceArg),root=resolve(rootArg);if(existsSync(root))throw Error('Fresh migration required');
const hash=value=>createHash('sha256').update(value).digest('hex');
const packetBytes=readFileSync(resolve(source,'review-packet.json'));
const oldPacket=JSON.parse(packetBytes),items=[],audit=[];
const answerTask=buildModelContext({self_contained_query:'format sentinel',jurisdiction_scope:'not applicable',response_route:'ANSWER'},[]).messages[0].content.split('\n\nANSWER TASK\n')[1];
if(!answerTask)throw Error('Current answer task boundary missing');
const system='/no_think\n'+ANSWER_SYSTEM_POLICY;
const marker='\n\nVERIFIED SOURCES\n',end='\nEND VERIFIED SOURCES\n\nANSWER TASK\n';
const newMarker='\n\nSUPPLIED EVIDENCE (record confirmation status is explicit)\n',newEnd='\nEND SUPPLIED EVIDENCE\n\nANSWER TASK\n';
const partitions={};
for(const partition of ['train','valid']){
 const oldRows=readFileSync(resolve(source,partition+'.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 if(oldRows.length!==(partition==='train'?24:8))throw Error('Split changed');
 partitions[partition]=oldRows.map(old=>{
  const item=oldPacket.items.find(x=>x.item_id===old.metadata.training_id&&x.partition===partition);if(!item)throw Error('Missing reviewed item');
  const messages=structuredClone(old.messages),index=messages.length-2,last=messages[index];
  if(messages[0].role!=='system'||last.role!=='user'||messages.at(-1).role!=='assistant')throw Error('Unexpected role topology');
  if(last.content.split(marker).length!==2||last.content.split(end).length!==2)throw Error('Ambiguous source boundary');
  const [head,remainder]=last.content.split(marker),[evidence]=remainder.split(end);
  messages[0].content=system;last.content=head+newMarker+evidence+newEnd+answerTask;
  if(last.content.split(newMarker)[1].split(newEnd)[0]!==evidence)throw Error('Source block changed');
  if(JSON.stringify(messages.slice(1,index))!==JSON.stringify(old.messages.slice(1,index))||JSON.stringify(messages.at(-1))!==JSON.stringify(old.messages.at(-1)))throw Error('History or target changed');
  const row={...old,messages};
  items.push({...item,row_sha256:hash(JSON.stringify(row)),previous_row_sha256:hash(JSON.stringify(old)),input_messages_without_shared_system:messages.slice(1,-1)});
  audit.push({id:item.item_id,partition,source_block_sha256:hash(evidence),source_blocks_preserved:true,
    source_count:(evidence.match(/^SOURCE S\d+$/gm)||[]).length,history_turns_preserved:index-1,target_preserved:true});
  return row;
 });
}
mkdirSync(root,{mode:0o700});
for(const [partition,rows] of Object.entries(partitions))writeFileSync(resolve(root,partition+'.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx',mode:0o600});
const packet={scope:'DEVELOPMENT_TRAINING_DATA_ONLY',version:'v5-format-migration-review-pending',
 provenance:'Migration of original reviewed v4 only; no PDU50 or sealed material. Every source block, history turn and target is byte-preserved.',
 previous_packet_sha256:hash(packetBytes),source_manifest_sha256:oldPacket.source_manifest_sha256,partition_audit:oldPacket.partition_audit,
 shared_system_input:system,policy_version:ANSWER_POLICY_VERSION,
 review_scope:'Review the targets, supplied input messages and shared system together, including useful explicit uncertainty and recognition of supplied fictional terms. Original approval is not a new approval.',
 limitations:[...oldPacket.limitations,'Full-source training context is intentionally preserved rather than clipped to the product default1000-character excerpt setting. Actual browser/retrieval remains a separate gate.','New input-format and shape workload needs its own preflight/proof; no gradients are authorized by this review receipt alone.'],items};
writeFileSync(resolve(root,'review-packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
writeFileSync(resolve(root,'migration-receipt.json'),JSON.stringify({status:'DRAFT_REVIEW_AND_WORKLOAD_PROOF_REQUIRED',audit,
 source_dataset:source,maximum_reviewer_calls:2,training_started:false,formal_credit:false,
 hashes:Object.fromEntries(['train.jsonl','valid.jsonl','review-packet.json'].map(name=>[name,hash(readFileSync(resolve(root,name)))]))},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,train:24,valid:8,source_blocks_history_targets_preserved:true,review:'PENDING',training_started:false}));
