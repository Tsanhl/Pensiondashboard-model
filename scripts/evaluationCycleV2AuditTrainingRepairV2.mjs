import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditTrainingRows, contentHash } from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT=resolve(process.env.TRAINING_REPAIR_V2_ROOT||"training/evaluation-cycle-v2/06-training-data-repair-revision-v2-20260901");
const packPath=resolve(ROOT,"repaired-training-items-draft.json");
const allocationPath=resolve(ROOT,"global-allocation-draft.json");
const pack=JSON.parse(readFileSync(packPath));
const allocation=JSON.parse(readFileSync(allocationPath));
const failures=[];
const seenQuestions=new Set();
const seenIds=new Set();
const itemChecks=[];

for(const item of pack.items||[]){
  const evidenceIds=new Set((item.retrieved_evidence||[]).map((source)=>source.source_id));
  const citations=[...item.ideal_answer.matchAll(/\{\{cite:([^}]+)\}\}/g)].map((match)=>match[1]);
  const checks={
    unique_id:!seenIds.has(item.training_id),
    unique_question:!seenQuestions.has(item.user_question),
    question_hash:item.question_sha256===contentHash(item.user_question),
    evidence_present:evidenceIds.size>0,
    evidence_provenance:(item.retrieved_evidence||[]).every((source)=>source.source_id&&source.text?.trim()&&source.content_sha256===contentHash(source.text)&&/^https:\/\//.test(source.source_url||"")&&source.authority_family),
    citations_exact:citations.length===evidenceIds.size&&citations.every((id)=>evidenceIds.has(id))&&[...evidenceIds].every((id)=>citations.includes(id)),
    no_synthetic_citations:citations.every((id)=>!/^w[23]-/.test(id)),
    proposition_map:(item.proposition_review||[]).length>0&&(item.proposition_review||[]).every((entry)=>entry.proposition&&entry.source_ids?.length&&entry.source_ids.every((id)=>evidenceIds.has(id))),
    review_only:item.training_authorised===false&&item.review_status==="developer_revised_pending_independent_proposition_review",
  };
  seenIds.add(item.training_id);seenQuestions.add(item.user_question);
  const passed=Object.values(checks).every(Boolean);
  if(!passed)failures.push({training_id:item.training_id,checks});
  itemChecks.push({training_id:item.training_id,wave:item.wave,passed,checks,evidence_ids:[...evidenceIds]});
}
const echoAudit=auditTrainingRows(pack.items||[]);
const counts={wave_2:pack.items.filter((item)=>item.wave===2).length,wave_3:pack.items.filter((item)=>item.wave===3).length};
const requiredFindingRepairs=[
  "v2r-w3-t02-train-003","v2r-w3-t02-train-002","v2-w3-t01-train-006","v2-w3-t01-train-002",
  "v2r-w3-t01-train-002","v2-w2-t01-train-006","v2-w2-t02-train-002","v2-w2-t02-train-006",
  "v2-w2-t01-train-004","v2r-w2-t04-train-001","v2-w2-t04-train-006","v2-w2-t04-train-005",
];
const findingRepairs=requiredFindingRepairs.map((trainingId)=>{
  const item=pack.items.find((candidate)=>candidate.training_id===trainingId);
  return {training_id:trainingId,present:Boolean(item),explicit_repair:item?.repair_basis==="explicit_screening_finding_repaired",evidence_ids:item?.retrieved_evidence.map((source)=>source.source_id)||[]};
});
const sourcePackHash=contentHash(readFileSync(packPath));
const allocationChecks={
  hash_bound:allocation.source_pack_sha256===sourcePackHash,
  balanced:allocation.validation.ids.filter((id)=>id.includes("-w2-")).length===5&&allocation.validation.ids.filter((id)=>id.includes("-w3-")).length===5,
  count:allocation.train.count===42&&allocation.validation.count===10,
  isolated:allocation.isolation?.passed===true&&Object.values(allocation.isolation.overlap||{}).every((values)=>values.length===0),
  review_only:allocation.training_authorised===false&&allocation.unseen_accessed===false,
};
const passed=pack.item_count===52&&counts.wave_2===33&&counts.wave_3===19&&failures.length===0&&echoAudit.passed&&findingRepairs.every((item)=>item.present&&item.explicit_repair)&&Object.values(allocationChecks).every(Boolean);
const report={version:"wave4-wave2-wave3-repair-integrity-preflight-v2",generated_at:new Date().toISOString(),status:passed?"machine_preflight_passed_pending_independent_legal_review":"machine_preflight_failed",training_authorised:false,unseen_accessed:false,passed,item_count:pack.item_count,counts,source_pack_sha256:sourcePackHash,allocation_sha256:contentHash(readFileSync(allocationPath)),answer_input_echo_audit:echoAudit,allocation_checks:allocationChecks,screening_findings: findingRepairs,
  legal_review_limit:"This machine preflight proves data integrity, provenance fields, citation membership and recorded split isolation. It does not approve the legal propositions; an independent reviewer must inspect every proposition and full passage.",failures,item_checks:itemChecks};
writeFileSync(resolve(ROOT,"integrity-and-review-preflight.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({passed,items:pack.item_count,wave_2:counts.wave_2,wave_3:counts.wave_3,failures:failures.length,balanced:allocationChecks.balanced,isolation:allocationChecks.isolated},null,2));
if(!passed)process.exitCode=1;
