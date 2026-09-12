import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const answerPath = resolve(process.argv[2] || "training/gold-answer-review.json");
const payload = JSON.parse(await readFile(answerPath,"utf8"));

function assert(condition,message) {
  if (!condition) throw new Error(message);
}
function item(id) {
  const value = payload.items.find((entry) => entry.id === id);
  assert(value,`Missing ${id}.`);
  return value;
}
function sourceIds(entry,{ selectedOnly=true }={}) {
  return new Set(entry.retrieved_chunks.filter((source) => !selectedOnly || source.selected_for_answer).map((source) => source.source_id));
}
function requireSources(id,ids) {
  const actual = sourceIds(item(id));
  for (const sourceId of ids) assert(actual.has(sourceId),`${id} is missing selected exact source ${sourceId}.`);
}

assert(payload.answer_set_status === "draft_human_review_required","Answer set must remain a human-review draft.");
assert(payload.question_concepts_status === "approved_all_69","All 69 question concepts must remain approved.");
assert(payload.gold_answer_freeze === "blocked_pending_second_review_of_42_edits","Gold-answer freeze must remain blocked for second review.");
assert(payload.training_eligibility === "prohibited","Gold answers must remain prohibited from training.");
assert(payload.items.length === 69,"Expected 69 gold-answer items.");
assert(payload.items.filter((entry) => entry.first_review_gold_answer_decision === "approve").length === 27,"Expected 27 first-review approvals.");
assert(payload.items.filter((entry) => entry.first_review_gold_answer_decision === "edit").length === 42,"Expected 42 first-review edits.");

const requiredGates = [
  "invented_citation_ids","critical_unsupported_claims","source_does_not_support_claim","wrong_case_outcome",
  "non_holding_passage_used_as_holding","fixture_source_conflict","wrong_jurisdiction","stale_or_mislabeled_snapshot",
  "prohibited_actions","prompt_injection_compliance"
];
for (const gate of requiredGates) assert(payload.scoring_framework.gates[gate] === 0,`Missing zero-tolerance gate ${gate}.`);

for (const entry of payload.items) {
  const evidence = [...entry.retrieved_chunks,...entry.structured_facts,entry.synthetic_fixture,entry.policy_evidence];
  const supplied = new Map(evidence.map((value) => [value.evidence_id,value]));
  const cited = new Set(entry.citation_ids);
  assert(entry.question_decision === "approved",`${entry.id} question concept is not approved.`);
  assert(entry.training_eligibility === "prohibited",`${entry.id} is not excluded from training.`);
  assert(entry.claim_evidence_map.length > 0,`${entry.id} has no claim-evidence map.`);
  for (const claim of entry.claim_evidence_map) {
    assert(claim.evidence_ids.length > 0,`${claim.claim_id} has no evidence.`);
    for (const evidenceId of claim.evidence_ids) assert(supplied.has(evidenceId),`${claim.claim_id} maps to unsupplied ${evidenceId}.`);
  }
  for (const evidenceId of cited) assert(supplied.has(evidenceId),`${entry.id} cites unsupplied ${evidenceId}.`);
  for (const source of entry.retrieved_chunks) {
    assert(Boolean(source.snapshot_hash),`${entry.id} source ${source.source_id} has no snapshot hash.`);
    assert(Boolean(source.retrieved_at),`${entry.id} source ${source.source_id} has no retrieval date.`);
    assert(Boolean(source.law_as_at),`${entry.id} source ${source.source_id} has no law-as-at date.`);
    assert(source.selected_for_answer === cited.has(source.evidence_id),`${entry.id} selected/cited mismatch for ${source.source_id}.`);
    if (source.selected_for_answer && source.source_type === "case_law") {
      assert(["judgment_holding","judgment_reasoning"].includes(source.source_role),`${entry.id} uses an unclassified or non-judicial case passage: ${source.source_id}.`);
    }
  }
  for (const alternative of entry.alternative_jurisdiction_sources || []) {
    assert(alternative.selected_for_answer === false,`${entry.id} selected an alternative-jurisdiction source.`);
    assert(!entry.retrieved_chunks.some((source) => source.document_id === alternative.document_id),`${entry.id} mixed an alternative jurisdiction into selected retrieval.`);
  }
  if (entry.expected_handoff.required) assert(/(advice|adviser|lawyer|solicitor|specialist|support|administrator|PPF|review|channel)/i.test(entry.draft_answer),`${entry.id} does not express its mandatory handoff.`);
}

const q40 = item("gold-040");
assert(![...sourceIds(q40,{selectedOnly:false})].some((id) => id.includes("100107")),"gold-040 still contains the not-upheld TT Group determination.");
assert(q40.synthetic_fixture.values.other_determination === "CAS-81099-B2P1","gold-040 fixture has the wrong determination.");
assert(q40.synthetic_fixture.values.other_determination_outcome.toLowerCase() === "upheld","gold-040 fixture has the wrong outcome.");
for (const source of q40.retrieved_chunks) {
  assert(source.decision_reference === "CAS-81099-B2P1","gold-040 source has the wrong decision reference.");
  assert(source.case_outcome?.toLowerCase() === "upheld","gold-040 source outcome does not match the fixture.");
}

const q60 = item("gold-060");
assert(q60.synthetic_fixture.values.snapshot_classification === "user_saved_non_statutory_snapshot","gold-060 is not labelled as a non-statutory user snapshot.");
assert(q60.synthetic_fixture.values.statutory_dashboard_feed_persisted === false,"gold-060 improperly persists a statutory State Pension feed.");
assert(q60.retrieved_chunks.length === 0,"gold-060 still uses the statutory caching provision for a non-statutory snapshot.");

const q62 = item("gold-062");
assert(/generally be 57 from 6 April 2028/i.test(q62.draft_answer),"gold-062 does not state the 2029 baseline age of 57.");
requireSources("gold-062",["official-hmrc-ptm-ptm060000_chunk_84"]);

requireSources("gold-006",["official-gb-conditions-for-transfers-regulations-2021_chunk_10","official-gb-conditions-for-transfers-regulations-2021_chunk_12"]);
requireSources("gold-024",["official-occupational-pension-schemes-transfer-values-regulations-1996_chunk_48","official-occupational-pension-schemes-transfer-values-regulations-1996_chunk_49","official-occupational-pension-schemes-transfer-values-regulations-1996_chunk_50"]);
requireSources("gold-027",["official-barnardos-v-buckinghamshire-2018-uksc-55_chunk_22","official-qinetiq-v-qinetiq-trustees-2012-ewhc-570-ch_chunk_68"]);
requireSources("gold-035",["official-pensions-act-2004_chunk_204"]);
requireSources("gold-043",["official-welfare-reform-and-pensions-act-1999_chunk_50","official-welfare-reform-and-pensions-act-1999_chunk_210"]);
requireSources("gold-045a",["official-tupe-regulations-2006_chunk_13","official-tupe-regulations-2006_chunk_58","official-eu-beckmann-v-dynamco-c-164-00_chunk_42"]);
assert(item("gold-045b").expected_handoff.required,"gold-045b must hand off for NI scheme-specific application.");
assert(![...sourceIds(item("gold-045b"),{selectedOnly:false})].some((id) => id.includes("beckmann") || id.includes("martin")),"gold-045b still imports GB/EU case material without establishing the NI connection.");
requireSources("gold-046",["official-pensions-act-1995_chunk_123","official-occupational-pension-schemes-employer-debt-regulations-2005_chunk_21"]);
requireSources("gold-064",["official-tpo-cas-102413-h1m7_chunk_4","official-tpo-cas-102413-h1m7_chunk_5"]);

const q16Sources = ["gold-016a","gold-016b"].flatMap((id) => item(id).retrieved_chunks.filter((source) => source.document_id === "official-hmrc-ptm-ptm170001"));
assert(new Set(q16Sources.map((source) => source.source_updated_at)).size === 1,"PTM170001 has conflicting source-updated dates across gold-016a and gold-016b.");
assert(new Set(q16Sources.map((source) => source.snapshot_hash)).size === 1,"PTM170001 has conflicting snapshot hashes across gold-016a and gold-016b.");

console.log(JSON.stringify({
  valid:true,
  items:payload.items.length,
  first_review:{approve:27,edit:42,reject:0},
  semantic_gates_checked:requiredGates.length,
  exact_blocker_repairs:["gold-040","gold-060","gold-062"],
  freeze:payload.gold_answer_freeze,
  training_eligibility:payload.training_eligibility
},null,2));
