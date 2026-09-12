import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditCumulativeTrainingIsolation, contentHash } from "./lib/trainingEvidenceIntegrity.mjs";
const ROOT=resolve(process.env.TRAINING_REPAIR_V2_ROOT || "training/evaluation-cycle-v2/06-training-data-repair-revision-v2-20260901");
const pack=JSON.parse(readFileSync(resolve(ROOT,"repaired-training-items-draft.json")));
const RULE={
  "v2-w2-t02-train-002":"governance.outsourcing-accountability",
  "v2r-w2-t02-train-001":"governance.outsourcing-accountability",
  "v2-w3-t02-train-003":"tax.mpaa",
  "v2r-w3-t02-train-002":"tax.mpaa",
  "v2-w3-t02-train-001":"tax.mpaa",
  "v2r-w3-t03-train-001":"iht.pension-property-death-boundary",
  "v2r-w3-t03-train-002":"iht.pension-property-death-boundary",
};
const values=(item)=>new Set([RULE[item.training_id]||item.legal_rule_id,...item.retrieved_evidence.flatMap(s=>[s.source_id,s.content_sha256,s.authority_family])].filter(Boolean));
const parent=new Map(pack.items.map(x=>[x.training_id,x.training_id]));
const find=x=>parent.get(x)===x?x:(parent.set(x,find(parent.get(x))),parent.get(x));
const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(b,a)};
const owners=new Map();
for(const item of pack.items) for(const value of values(item)){if(owners.has(value))union(item.training_id,owners.get(value));else owners.set(value,item.training_id)}
const groups=new Map();
for(const item of pack.items){const root=find(item.training_id);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(item)}
const components=[...groups.values()].sort((a,b)=>a.length-b.length||a[0].training_id.localeCompare(b[0].training_id));
let choices=new Map([["0:0:0",[]]]);
for(const component of components){
  const next=new Map(choices);
  const wave2=component.filter((item)=>item.wave===2).length;
  const wave3=component.filter((item)=>item.wave===3).length;
  for(const [key,picked] of choices){
    const [n,w2,w3]=key.split(":").map(Number);
    const total=n+component.length;
    if(total<=12){const nextKey=`${total}:${w2+wave2}:${w3+wave3}`;if(!next.has(nextKey))next.set(nextKey,[...picked,component]);}
  }
  choices=next;
}
const preferredKeys=["10:5:5","10:4:6","10:6:4","9:4:5","9:5:4","11:5:6","11:6:5","8:4:4","12:6:6"];
const selectedKey=preferredKeys.find((key)=>choices.has(key));
if(!selectedKey)throw new Error(`No balanced isolated 8–12 item validation allocation is possible; component sizes: ${components.map(x=>x.length)}`);
const validationIds=new Set(choices.get(selectedKey).flat().map(x=>x.training_id));
const train=pack.items.filter(x=>!validationIds.has(x.training_id));
const validation=pack.items.filter(x=>validationIds.has(x.training_id));
const isolation=auditCumulativeTrainingIsolation([{wave:"wave-2-and-3",train,validation}],{legalRuleById:RULE});
if(!isolation.passed)throw new Error(`Allocation failed isolation: ${JSON.stringify(isolation)}`);
const allocation={version:"wave4-global-training-validation-allocation-draft-v2",generated_at:new Date().toISOString(),status:"proposed_pending_independent_construct_and_custodian_review",training_authorised:false,unseen_accessed:false,
  source_pack_sha256:contentHash(readFileSync(resolve(ROOT,"repaired-training-items-draft.json"))),train:{count:train.length,ids:train.map(x=>x.training_id)},validation:{count:validation.length,ids:validation.map(x=>x.training_id)},
  semantic_rule_overrides:RULE,component_sizes:components.map(x=>({size:x.length,ids:x.map(i=>i.training_id)})),isolation,
  caveat:"This graph proves separation only for the source IDs, passage hashes, authority families and canonical rule IDs recorded here. The authorised custodian must compare protected constructs without exposing sealed questions or answers."};
writeFileSync(resolve(ROOT,"global-allocation-draft.json"),JSON.stringify(allocation,null,2)+"\n");
console.log(JSON.stringify({train:train.length,validation:validation.length,isolation:isolation.passed},null,2));
