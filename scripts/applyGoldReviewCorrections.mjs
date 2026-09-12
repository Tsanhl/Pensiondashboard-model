import { readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] || "training/gold-evaluation-draft.json");
const payload = JSON.parse(await readFile(path,"utf8"));
const approved = new Set([
  "gold-002","gold-003","gold-004","gold-005","gold-008","gold-010","gold-011","gold-012","gold-013","gold-015",
  "gold-028","gold-033","gold-034","gold-036","gold-041","gold-042","gold-047","gold-048","gold-050a","gold-050b",
  "gold-052","gold-053","gold-054","gold-056","gold-057","gold-059","gold-066"
]);
const edits = new Set(payload.questions.map((row) => row.id).filter((id) => !approved.has(id)));
if (approved.size !== 27 || edits.size !== 42) throw new Error(`Reviewer decision count mismatch: ${approved.size} approve, ${edits.size} edit.`);

const overrides = {
  "gold-001": {required_source_ids:[]},
  "gold-006": {required_source_ids:["official-pension-schemes-act-1993","official-gb-conditions-for-transfers-regulations-2021","official-tpr-dealing-with-transfer-requests"]},
  "gold-007": {required_source_ids:["official-pension-schemes-act-1993"]},
  "gold-009": {required_structured_fact_ids:["automatic-enrolment-earnings-trigger-2026-27"]},
  "gold-018": {required_source_ids:["official-pension-schemes-act-1993"]},
  "gold-019": {required_source_ids:["official-pension-schemes-northern-ireland-act-1993"]},
  "gold-020": {required_source_ids:["official-pension-schemes-act-1993","official-pensions-act-1995"]},
  "gold-021": {required_source_ids:["official-pension-schemes-act-1993"]},
  "gold-022": {required_source_ids:["official-gb-conditions-for-transfers-regulations-2021","official-tpr-dealing-with-transfer-requests"]},
  "gold-023": {required_source_ids:["official-ni-conditions-for-transfers-regulations-2021"]},
  "gold-024": {required_source_ids:["official-pension-schemes-act-1993","official-occupational-pension-schemes-transfer-values-regulations-1996"]},
  "gold-026": {required_source_ids:["official-pensions-act-1995"]},
  "gold-027": {required_source_ids:["official-barnardos-v-buckinghamshire-2018-uksc-55","official-qinetiq-v-qinetiq-trustees-2012-ewhc-570-ch"]},
  "gold-029": {required_source_ids:["official-ibm-v-dalgleish-2014-ewhc-980-ch","official-ibm-v-dalgleish-2017-ewca-1212"]},
  "gold-030": {required_source_ids:["bailii-edge-v-pensions-ombudsman-1999-ewca-2013"]},
  "gold-031": {required_source_ids:["official-trustee-act-2000","official-pensions-act-2004"]},
  "gold-032": {required_source_ids:["official-occupational-pension-schemes-investment-regulations-2005"]},
  "gold-037": {required_source_ids:["official-eu-hampshire-v-ppf-c-17-17","official-sswp-ppf-v-hughes-2021-ewca-1093","official-ppf-hampshire-hughes-bauer-s143-note"]},
  "gold-039": {expected_route:"ANSWER_AND_HANDOFF",handoff_required:true,handoff_reason:"point_of_law_appeal_and_court_deadline",required_source_ids:["official-tpo-how-to-appeal"]},
  "gold-040": {required_source_ids:["official-tpo-cas-81099-b2p1"]},
  "gold-043": {required_source_ids:["official-welfare-reform-and-pensions-act-1999"]},
  "gold-045a": {required_source_ids:["official-tupe-regulations-2006","official-transfer-of-employment-pension-protection-regulations-2005","official-eu-beckmann-v-dynamco-c-164-00"]},
  "gold-045b": {expected_route:"ANSWER_AND_HANDOFF",handoff_required:true,handoff_reason:"northern_ireland_service_provision_change_and_pension_protection_application",required_source_ids:["official-ni-service-provision-change-protection-of-employment-regulations-2006","official-ni-transfer-of-employment-pension-protection-regulations-2005"]},
  "gold-049": {required_source_ids:[]},
  "gold-051": {jurisdiction:"GREAT_BRITAIN",required_source_ids:["official-gb-pensions-dashboards-regulations-2022","official-govuk-pension-tracing-service"]},
  "gold-055": {jurisdiction:"GREAT_BRITAIN",required_source_ids:["official-gb-pensions-dashboards-regulations-2022"]},
  "gold-058": {jurisdiction:"GREAT_BRITAIN",required_source_ids:["official-tpr-report-missing-pension-payments"]},
  "gold-060": {required_source_ids:[]},
  "gold-063": {jurisdiction:"GREAT_BRITAIN",required_source_ids:["official-gb-conditions-for-transfers-regulations-2021","official-tpr-dealing-with-transfer-requests"],alternative_jurisdiction_source_ids:["official-ni-conditions-for-transfers-regulations-2021"]},
  "gold-064": {required_source_ids:["official-tpo-cas-102413-h1m7"]}
};

for (const row of payload.questions) {
  Object.assign(row,overrides[row.id] || {});
  row.question_decision = "approved";
  row.first_review_gold_answer_decision = approved.has(row.id) ? "approve" : "edit";
  row.gold_answer_review_status = approved.has(row.id) ? "first_review_approved" : "edited_after_first_review_pending_second_review";
  row.training_eligibility = "prohibited";
}
payload.question_concepts_status = "approved_all_69";
payload.gold_answer_freeze = "blocked_pending_second_review_of_42_edits";
payload.question_set_status = "approved_and_frozen";
payload.training_eligibility = "prohibited";
payload.first_review = {completed_at:"2026-08-26",approve_count:27,edit_count:42,reject_count:0};
await writeFile(path,`${JSON.stringify(payload,null,2)}\n`);
console.log(JSON.stringify({path,questions:payload.questions.length,approve:approved.size,edit:edits.size,freeze:payload.gold_answer_freeze},null,2));
