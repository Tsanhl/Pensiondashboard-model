// One bounded correction of development targets, based on both v5 reviews.
// Original evidence, questions, history and partition membership remain intact.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [sourceArg,rootArg]=process.argv.slice(2);
if(!sourceArg||!rootArg)throw Error('Source and fresh destination required');
const source=resolve(sourceArg),root=resolve(rootArg);
if(existsSync(root))throw Error('Destination must be fresh');
const hash=x=>createHash('sha256').update(x).digest('hex');
const initialReplacements={
 'adapt-train-003':'No. Within this occupational scheme regime, a protected modification requires consent; the consent-or-actuarial-equivalence alternative applies where the specified consent-only category does not apply, and trustee approval and reporting requirements also apply to regulated modifications. {{cite:S1}} The proposed modification must be classified before using either route.',
 'adapt-train-005':'The extract makes required consultation a condition before a covered person decides on a listed change, defines scope through further regulations and exceptions, and does not itself establish a general permission to change scheme terms. {{cite:S1}} Which proposal and scheme type are involved, and are any exclusions relevant?',
 'adapt-train-006':'Required consultation precedes a covered listed-change decision; for personal pensions, an exception covers a reduction proposed as a result of earlier consultation on ceasing employer contributions, but this extract alone does not establish member consent or a contractual amendment power. {{cite:S1}} Are the employer and proposal covered, and did that earlier consultation occur?',
 'adapt-train-007':'No. It applies to covered persons making listed changes, as defined by scheme type, subject to exclusions and four stated exceptions; it is not a rule for every adjustment. {{cite:S1}}',
 'adapt-train-008':'The stated sequence matches the specified exception: consultation already occurred on preventing future accrual, and the resulting further proposal reduces that accrual rate; this is not a general exemption for all later changes. {{cite:S1}}',
 'adapt-train-009':'In that DC automatic-enrolment context, the guidance discusses increasing employer or jobholder contributions, changing pensionable pay definitions, or changing rules to meet certification criteria, with amendments and their process discussed with the trustees, manager or provider; it does not establish a universal power to alter every pension promise. {{cite:S1}}',
 'adapt-train-012':'No. This passage discusses changes to meet DC automatic-enrolment requirements, including contributions and pensionable pay; it does not establish a general rule permitting reductions to benefits already earned. {{cite:S1}}',
 'adapt-train-014':'Yes, under the fictional Cedar terms, additional payments qualify for matching because the current exercise record confirms both permanent status and completed probation. {{cite:S1}} This conclusion is limited to the supplied fictional matching terms.',
 'adapt-train-016':'No. The Marigold exercise uses basic salary and excludes bonuses and overtime, so its supplied breakdown establishes a £1,200 contribution base rather than the £1,500 total pay. {{cite:S1}} No further pay breakdown is needed to identify that base.',
 'adapt-train-018':'No. The Rowan pause option is limited to active members after written notice and excludes retired members, so the supplied retired status means this member cannot use that option. {{cite:S1}}',
 'adapt-train-020':'The confirmed Elm exercise statement dated 1 September 2026 records a 0.7% annual fee for this account, resolving the older unverified conflicting extracts for that statement date without establishing that the fee will never change. {{cite:S1}}',
 'adapt-train-021':'The Hazel exercise records a zero monthly contribution but a missing pension value, not a zero value, and neither is a live provider update. {{cite:S1}} Can you provide the current value from a dated statement?',
 'adapt-train-022':'No. The newer Hazel exercise statement dated 1 September 2026 records a £12,000 pension value and a £150 monthly contribution, superseding the earlier missing value and recorded zero contribution for that statement date; it is not a live provider update. {{cite:S1}}',
 'adapt-train-024':'No. In the Willow exercise, the interface records £80 monthly but is read-only and has no mechanism to submit contribution changes. {{cite:S1}} I can explain the record, but cannot carry out an update.',
 'adapt-valid-001':'I cannot determine whether your bonus is already vested because completed service years are missing; the fictional Juniper terms require five completed service years. {{cite:S1}} How many completed service years are recorded?',
 'adapt-valid-002':'No. This fictional Juniper bonus vests only after five completed service years, not automatically for every participant. {{cite:S1}}',
 'adapt-valid-003':'I cannot determine whether you can rejoin immediately without the exit reason and request month; under the fictional Birch terms, March rejoining follows a voluntary exit, while other months require administrator review. {{cite:S1}} Was the exit voluntary, and in which month is rejoining requested?'
};
const dcOnly=process.argv[4]==='--dc-condition-only';
const effectOnly=process.argv[4]==='--consultation-effect-only';
if(process.argv[4]&&!dcOnly&&!effectOnly)throw Error('Unknown correction mode');
const replacements=effectOnly?{'adapt-train-008':'The described sequence falls within regulation 6(5): consultation under these Regulations on preventing future accrual leads to a proposal to reduce its rate, so regulation 6(1) does not require another consultation for that resulting proposal. {{cite:S1}} This is not a general exemption for later changes or proof of authority to amend scheme terms. {{cite:S1}}'}:dcOnly?{'adapt-train-009':'If the described checks cannot meet minimum or alternative DC requirements, the guidance discusses increasing employer/jobholder contributions, widening pensionable pay, adopting qualifying earnings with at least 3% employer and 8% total contributions, or changing rules to meet certification criteria. {{cite:S1}} Discuss amendments and their process with trustees, managers or providers; these options are not universal amendment powers. {{cite:S1}}'}:initialReplacements;
const priorBytes=readFileSync(resolve(source,'review-packet.json'));
const packet=JSON.parse(priorBytes),audit=[],partitions={};
for(const partition of ['train','valid']){
 const rows=readFileSync(resolve(source,partition+'.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 if(rows.length!==(partition==='train'?24:8))throw Error('Split changed');
 partitions[partition]=rows.map(old=>{
  const row=structuredClone(old),id=row.metadata.training_id,item=packet.items.find(x=>x.item_id===id&&x.partition===partition);
  if(!item)throw Error('Missing packet item');
  const before=JSON.parse(row.messages.at(-1).content);
  if(replacements[id])row.messages.at(-1).content=JSON.stringify({...before,answer:replacements[id]});
  if(JSON.stringify(row.messages.slice(0,-1))!==JSON.stringify(old.messages.slice(0,-1)))throw Error('Input changed');
  item.proposed_completion=JSON.parse(row.messages.at(-1).content);
  item.previous_row_sha256=hash(JSON.stringify(old));item.row_sha256=hash(JSON.stringify(row));
  audit.push({id,partition,input_sha256:hash(JSON.stringify(row.messages.slice(0,-1))),input_preserved:true,target_changed:!!replacements[id],before_target_sha256:hash(old.messages.at(-1).content),after_target_sha256:hash(row.messages.at(-1).content)});
  return row;
 });
}
if(audit.filter(x=>x.target_changed).length!==Object.keys(replacements).length)throw Error('Correction IDs missing');
packet.version=effectOnly?'v8-consultation-effect-correction-review-pending':dcOnly?'v7-dc-condition-correction-review-pending':'v6-development-target-correction-review-pending';
packet.previous_packet_sha256=hash(priorBytes);
packet.provenance=dcOnly?'One source-checked correction of train009 following the terminal v6 review and the owner continuation request. All other rows, validation targets, questions, sources and history preserved. No PDU50/formal/sealed material. This is a new bounded two-call review, not reuse or relabeling of the v6 HOLD.':'One correction of v5 development targets following two isolated reviews. All questions, source blocks, history and split membership preserved; no PDU50/formal/sealed targets modified. Validation remains excluded from gradients. Historical comparisons retain their original reference version.';
if(effectOnly)packet.provenance='One source-checked correction of train008 following v7 reviewerA finding: state the operative effect of regulation6(5), not merely its conditions. All other rows, validation targets and every input message remain identical. This is the final corrective review in this continuation: two calls, no further until-green retries. V7 HOLD is preserved.';
mkdirSync(root,{mode:0o700});
for(const [partition,rows] of Object.entries(partitions))writeFileSync(resolve(root,partition+'.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx',mode:0o600});
writeFileSync(resolve(root,'review-packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
writeFileSync(resolve(root,'correction-receipt.json'),JSON.stringify({status:'REVIEW_AND_WORKLOAD_PROOF_REQUIRED',source,audit,maximum_reviewer_calls:2,training_started:false,validation_gradient_items:0,formal_credit:false,hashes:Object.fromEntries(['train.jsonl','valid.jsonl','review-packet.json'].map(n=>[n,hash(readFileSync(resolve(root,n)))]))},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,corrected_targets:audit.filter(x=>x.target_changed).length,inputs_preserved:true,training_started:false}));
