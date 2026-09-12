import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {selectDurationCandidate} from './lib/adaptabilityDurationSelection.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Recovery root required');
const read=name=>JSON.parse(readFileSync(resolve(root,name)));
const plan=read('training-plan.json'),exit=read('recovery-exit.json'),completion=read('recovery-completion.json');
for(const x of plan.bound_inputs)if(hash(x.path)!==x.sha256)throw Error('Recovery binding changed: '+x.path);
if(exit.exit_code!==0||exit.signal||exit.aborted||completion.segment_updates!==24||completion.total_confirmed_main_work!==47||completion.weight_lineage_updates!==36)throw Error('Recovery not complete');
for(let step=1;step<=24;step++){
 const base=resolve(root,'durable-updates',String(step).padStart(3,'0'));
 const record=JSON.parse(readFileSync(resolve(base,'receipt.json')));
 if(record.segment_updates!==step||record.weight_lineage_updates!==12+step||record.total_confirmed_main_work!==23+step||record.adapter_sha256!==hash(resolve(base,'adapters.safetensors'))||record.optimizer_sha256!==hash(resolve(base,'optimizer.safetensors')))throw Error('Durable recovery accounting mismatch');
}
const generation=read('validation-generation/receipt.json'),semantic=read('checkpoint-semantic-review.json');
const validationHash=hash(resolve(plan.dataset,'valid.jsonl'));
if(generation.completed_generations!==32||generation.validation_sha256!==validationHash||semantic.validation_sha256!==validationHash)throw Error('Selection evidence mismatch');
const updates=[0,12,24,36];
for(const records of [generation.exact_loss_records,semantic.records])if(JSON.stringify(records.map(x=>x.additional_update_count).sort((a,b)=>a-b))!==JSON.stringify(updates))throw Error('Missing recovery candidate');
const adapterFor=update=>update===0?plan.parent_adapter:update===12?resolve(root,'reconstructed-parent/adapters.safetensors'):resolve(root,'durable-updates',String(update-12).padStart(3,'0'),'adapters.safetensors');
const candidates=semantic.records.map(record=>{
 const loss=generation.exact_loss_records.find(x=>x.additional_update_count===record.additional_update_count);
 const adapterHash=hash(adapterFor(record.additional_update_count));
 if(record.adapter_sha256!==adapterHash||loss.adapter_sha256!==adapterHash||!Number.isFinite(loss.validation_loss))throw Error('Candidate identity/loss mismatch');
 if(record.review_receipt_sha256!==hash(record.review_receipt))throw Error('Review receipt changed');
 return {...record,validation_loss:loss.validation_loss};
});
const decision=selectDurationCandidate(candidates);
const report={status:decision.selected?'DEVELOPMENT_SELECTION_COMPLETE':'NO_HARD_GATE_CLEAN_CANDIDATE',completed_at:new Date().toISOString(),
  original_main_status:'INTERRUPTED_RESOURCE_METRICS_UNAVAILABLE',original_confirmed_updates:23,recovery_updates:24,total_confirmed_main_work:47,
  final_weight_lineage_updates:36,optimizer_reset_at_lineage12:true,discarded_confirmed_updates:11,candidates,decision,
  formal_credit:false,sealed_unseen_accessed:false,product_browser_acceptance:false};
writeFileSync(resolve(root,'recovery-evaluation-result.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
if(decision.selected){
 const update=decision.selected.additional_update_count,source=adapterFor(update),selected=update===0?null:resolve(root,'selected-adapter');
 if(selected){if(existsSync(selected))throw Error('Refusing existing selected adapter');mkdirSync(selected);copyFileSync(source,resolve(selected,'adapters.safetensors'));copyFileSync(resolve(root,'reconstructed-parent/adapter_config.json'),resolve(selected,'adapter_config.json'));}
 const config=update===0?resolve(dirname(source),'adapter_config.json'):resolve(root,'reconstructed-parent/adapter_config.json');
 writeFileSync(resolve(root,'checkpoint-selection.json'),JSON.stringify({version:'adaptability-checkpoint-selection-v3',model_version:'pension-assistant-weight-only-recovery-v3',
   parent_checkpoint:104,selected_additional_update_count:update,selected_adapter_path:selected,source_checkpoint:source,adapter_sha256:hash(source),adapter_config_sha256:hash(config),
   selected_validation_loss:decision.selected.validation_loss,decision_reason:decision.reason,optimizer_reset_at_lineage12:true,total_confirmed_main_work:47,
   candidates,development_only:true},null,2),{flag:'wx',mode:0o600});
}
console.log(JSON.stringify({status:report.status,decision_reason:decision.reason,selected_lineage_updates:decision.selected?.additional_update_count??null,qualified:false}));
