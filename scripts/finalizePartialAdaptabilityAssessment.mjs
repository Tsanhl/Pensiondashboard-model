import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {selectDurationCandidate} from './lib/adaptabilityDurationSelection.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Partial assessment root required');
const read=name=>JSON.parse(readFileSync(resolve(root,name)));
const plan=read('training-plan.json'),binding=read('selection-binding.json'),generation=read('validation-generation/receipt.json'),semantic=read('checkpoint-semantic-review.json');
for(const x of [...plan.bound_inputs,...binding.bound_inputs])if(hash(x.path)!==x.sha256)throw Error('Assessment binding changed: '+x.path);
if(!plan.partial_assessment||generation.completed_generations!==16||generation.partial_interrupted_study!==true)throw Error('Partial assessment identity mismatch');
const validationHash=hash(resolve(plan.dataset,'valid.jsonl'));
if(generation.validation_sha256!==validationHash||semantic.validation_sha256!==validationHash)throw Error('Validation identity mismatch');
for(const records of [generation.exact_loss_records,semantic.records])if(JSON.stringify(records.map(x=>x.additional_update_count).sort((a,b)=>a-b))!==JSON.stringify([0,12]))throw Error('Partial candidate set mismatch');
const candidates=semantic.records.map(record=>{
 const loss=generation.exact_loss_records.find(x=>x.additional_update_count===record.additional_update_count);
 const path=record.additional_update_count===0?plan.parent_adapter:resolve(root,'reconstructed-parent/adapters.safetensors');
 if(record.adapter_sha256!==hash(path)||loss.adapter_sha256!==hash(path)||!Number.isFinite(loss.validation_loss)||record.review_receipt_sha256!==hash(record.review_receipt))throw Error('Partial candidate evidence mismatch');
 return {...record,validation_loss:loss.validation_loss};
});
const decision=selectDurationCandidate(candidates);
const report={status:'PARTIAL_ASSESSMENT_COMPLETE_FULL_STUDY_INCOMPLETE',completed_at:new Date().toISOString(),candidates,decision,
  new_optimizer_updates:0,full_training_completed:false,automatically_promoted:false,formal_credit:false,browser_acceptance:false,sealed_unseen_accessed:false};
writeFileSync(resolve(root,'partial-assessment-result.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:report.status,decision_reason:decision.reason,preferred_lineage_updates:decision.selected?.additional_update_count??null,qualified:false,promoted:false}));
