import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditTrainingPartitionIsolation, loadReviewedTrainingItems } from "./lib/trainingEvidenceIntegrity.mjs";

const INPUT = resolve("training/evaluation-cycle-v2/01-question-set-review-revision-v2/wave-3/development-question-set.json");
const OUTPUT_ROOT = resolve(process.env.CYCLE_V2_TRAINING_OUTPUT_ROOT || "training-data/private/evaluation-cycle-v2-wave-3-lora");
const REVIEW_ROOT = resolve(process.env.CYCLE_V2_TRAINING_REVIEW_ROOT || "training/evaluation-cycle-v2/02-wave-3-execution/training");
const pack = JSON.parse(readFileSync(INPUT, "utf8"));
const candidates = pack.topics.flatMap((topic) => topic.training_candidates.map((item) => ({ ...item, topic_id: topic.topic_id })));
const reviewed = loadReviewedTrainingItems(resolve(process.env.CYCLE_V2_TRAINING_REVIEW_PATH || `${REVIEW_ROOT}/reviewed-source-training-items.json`), candidates, {
  reviewReturnPath:resolve("training/evaluation-cycle-v2/05-training-data-repair-revision-20260901/review-return-record.json"),
});
if (existsSync(resolve(OUTPUT_ROOT, "dataset-manifest.json"))) throw new Error("Preserve the historical dataset; choose a new versioned CYCLE_V2_TRAINING_OUTPUT_ROOT");
if (existsSync(resolve(REVIEW_ROOT, "training-review-pack.json"))) throw new Error("Preserve historical reviews; choose a new versioned CYCLE_V2_TRAINING_REVIEW_ROOT");

const IDEALS = {
  protected_pension_age_evidence_training: "Do not rely on the dashboard label alone. Check the scheme rules and amendments showing the member's unqualified right on 5 April 2006, the age and conditions of that right, the relevant employment or occupation conditions, and the administrator's protection record. Then check every later transfer, winding-up, benefit crystallisation and separation of rights, because protection may be retained, restricted or lost depending on the statutory transfer route and the receiving arrangement. {{cite:SOURCE}}",
  early_retirement_fact_gap: "An exact early-retirement amount cannot be calculated from the current evidence. The rules establish that consent and an actuarial reduction are relevant, but the current actuarial reduction factors are missing. Please provide the scheme's current factors for the proposed retirement date; trustee consent and the administrator's formal quote must still be confirmed. {{cite:SOURCE}}",
  late_retirement_qualification: "No. Delaying a DB pension does not by itself guarantee that every component increases. The scheme rules and applicable statutory rules determine whether an uplift applies, the factor and date used, and whether components such as GMP, excess pension, AVCs or underpins are treated differently. Obtain a component-level late-retirement quote before stating the result. {{cite:SOURCE}}",
  death_benefit_nomination: "No recipient is guaranteed from the old expression-of-wish form alone. It is evidence of the member's wishes, but payment depends on the scheme rules, the identity of the legal decision-maker, the form's continuing validity and the relevant circumstances at death. The trustee or administrator must consider the former partner and other potential beneficiaries lawfully and record its decision. {{cite:SOURCE}}",
  commutation_advice_boundary: "The figures allow a factual comparison: the lump-sum option exchanges £5,500 of annual pension for £82,000, an implied commutation multiple of about 14.9 before tax and other adjustments. That does not determine which option is best for you. The decision depends on scheme guarantees, survivor and increase effects, tax, health, cash needs and risk preferences; a personal recommendation requires appropriately authorised financial advice. {{cite:SOURCE}}",
  early_access_safety: "No. A pension loan offered at age 50 is not an ordinary retirement option unless a specific authorised-payment exception such as ill health or a valid protected pension age applies. Treat the promoter's 'tax-free' description as a scam warning: do not sign, pay fees, share access details or transfer funds; verify the firm independently and report suspected fraud through the appropriate official route. Unauthorised payments can create substantial tax charges. {{cite:SOURCE}}",
  nmpa_direct_training: "From 6 April 2028 the normal minimum pension age is 57. Because you will be 56 in August 2029 and have no protected pension age, a payment then would not normally be an authorised age-based pension payment; you would normally need to wait until 57 unless a statutory exception such as ill health applies and the scheme rules permit payment. {{cite:SOURCE}}",
  small_pots_training: "Each £8,000 pot is below the £10,000 small-pot ceiling, but all other conditions and the scheme rules must be checked. For non-occupational arrangements there is a lifetime limit of three qualifying small-pot payments; occupational small pots use different counting rules. Trivial commutation is a separate route that generally tests the aggregate value of all relevant pension rights against £30,000 and has its own timing and extinguishment conditions. Do not mix the individual-pot test with the aggregate trivial-commutation test. {{cite:SOURCE}}",

  dated_tax_answer: "For 2026/27 the standard annual allowance is £60,000 and the money purchase annual allowance is £10,000. Taper applies only if threshold income exceeds £200,000 and adjusted income exceeds £260,000; the minimum tapered annual allowance is £10,000. Where the MPAA structure applies, the standard alternative annual allowance for non-money-purchase input is £50,000, subject to any taper. {{cite:SOURCE}}",
  taper_fact_complete_training: "The tapered annual allowance does not apply because threshold income is £190,000, which does not exceed the £200,000 threshold. Both the threshold-income and adjusted-income tests must be met. The annual allowance before carry forward is therefore the standard £60,000, assuming the MPAA and other reductions do not apply. {{cite:SOURCE}}",
  mpaa_event_classification: "The MPAA trigger cannot be determined from 'took money' alone. A pension commencement lump sum with no taxable flexi-access drawdown income does not by itself trigger the MPAA, while an uncrystallised funds pension lump sum or taxable income from flexi-access drawdown generally does. Obtain the provider's payment type, crystallisation record and first taxable-payment date before fixing the trigger date. {{cite:SOURCE}}",
  protection_handoff: "Yes, a valid lifetime-allowance protection can still affect the current lump-sum allowance and lump-sum-and-death-benefit allowance even though the lifetime allowance charge was abolished. Verify the protection type, certificate or HMRC reference, whether it was lost, all pre- and post-6 April 2024 benefit events, and any transitional tax-free amount certificate. Ask the scheme administrator or a pensions-tax adviser to calculate the protected remaining allowance before payment. {{cite:SOURCE}}",
  overseas_tax_warning: "The provider's label is not enough. Check the transfer date; whether the destination is a qualifying recognised overseas pension scheme; the member's residence and the scheme's country; whether a same-country, employer, public-service or international-organisation exclusion applies; the available overseas transfer allowance; and relevant changes during the following five full tax years. A charge can apply to the non-exempt or excess amount. {{cite:SOURCE}}",
  allowance_history: "No. A 2019 benefit event can reduce the allowance available under the post-6 April 2024 regime. Obtain the earlier scheme's benefit-crystallisation statements, percentage of former lifetime allowance used, tax-free amounts and any valid protection or transitional tax-free amount certificate, then apply the statutory conversion. The dashboard must not show the standard allowance as wholly unused without that history. {{cite:SOURCE}}",
  carry_forward_prior_year_membership: "No unused allowance from 2023/24 can be carried forward because you were not a member of a registered pension scheme in that tax year. Membership is required for the year from which unused allowance is carried. Subject to complete input records and the other conditions, unused allowance from 2024/25 and 2025/26 may be considered in the statutory order. {{cite:SOURCE}}",
  alternative_allowance_training: "After the MPAA is triggered, money-purchase input is tested against the £10,000 MPAA and unused MPAA cannot be carried forward. Other input, including DB accrual, is tested against the alternative annual allowance, normally £50,000 for 2026/27 but lower if taper applies; eligible unused ordinary allowance can be carried forward for that non-money-purchase test. The two categories and excesses must be calculated separately. {{cite:SOURCE}}",
  overseas_charge_training: "No. The general EEA/Gibraltar exclusion was removed for transfers made on or after 30 October 2024. A December 2024 transfer therefore needs another exclusion. If the member was resident in France and the QROPS was established in France, the same-country exclusion may apply; otherwise check the remaining statutory exclusions and overseas transfer allowance before concluding whether the 25% charge arises. {{cite:SOURCE}}",

  iht_training_precommencement_death: "No, not under the new Finance Act 2026 pension-IHT inclusion solely because payment occurs after 6 April 2027. The commencement rule is based on deaths occurring on or after 6 April 2027, so a death on 1 March 2027 is outside that new regime. Existing inheritance-tax and pension-death-benefit rules must still be checked separately. {{cite:SOURCE}}",
  iht_training_status: "For deaths on or after 6 April 2027, Finance Act 2026 brings most unused pension funds and pension death benefits into the estate calculation as notional pension property, subject to statutory exclusions and exemptions. The enacted scope and commencement can be stated now, but operational information-sharing fields, forms, deadlines, withholding and payment procedures must be checked against the final secondary legislation and current HMRC guidance before implementation. {{cite:SOURCE}}",
};

function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
const missing = candidates.filter((item) => !IDEALS[item.review_focus]);
const extra = Object.keys(IDEALS).filter((focus) => !candidates.some((item) => item.review_focus === focus));
if (missing.length || extra.length) throw new Error(`Wave 3 training mapping mismatch. Missing: ${missing.map((item) => item.id).join(", ")}; extra: ${extra.join(", ")}`);

const system = "You are a read-only UK pensions assistant. Answer only from the supplied synthetic fixture and evidence. Never invent facts, dates, figures, law, citations, actions or tool results. Cite supported propositions with the supplied {{cite:source_id}} token. Distinguish enactment from commencement, apply dated tax rules exactly, and do not replace the governing rule with a generic disclaimer.";
const items = candidates.map((item) => {
  const approved = reviewed.byId.get(item.id);
  const idealAnswer = approved.ideal_answer;
  return {
    training_id: item.id, topic_id: item.topic_id, construct_id: item.construct_id, capability: item.review_focus,
    jurisdiction: item.jurisdiction, user_question: item.question, ideal_answer: idealAnswer,
    response_route: item.expected_answer_mode === "handoff" ? "ANSWER_AND_HANDOFF" : "ANSWER",
    retrieved_evidence: approved.retrieved_evidence,
    completion_target_field: "ideal_answer", synthetic_fixture: { synthetic: true, contains_real_user_data: false, law_as_at: item.law_as_at },
    human_review_status: "internal_source_grounded_development_training_review", diagnostic_or_unseen_content_included: false,
  };
});
const validationIds = new Set(["v2-w3-t01-train-002", "v2r-w3-t01-train-001", "v2-w3-t02-train-002", "v2r-w3-t03-train-002"]);
const trainItems = items.filter((item) => !validationIds.has(item.training_id));
const validItems = items.filter((item) => validationIds.has(item.training_id));
const isolation = auditTrainingPartitionIsolation(trainItems, validItems);
if (trainItems.length !== 15 || validItems.length !== 4 || !isolation.passed) throw new Error(`Wave 3 training split needs independently reviewed source/construct repartitioning: ${JSON.stringify(isolation)}`);
const row = (item) => ({ messages: [
  { role: "system", content: system + ' Return one complete JSON object with answer (string) and citation_ids (array of the source IDs cited in answer), with no surrounding text.' },
  { role: "user", content: JSON.stringify({ question: item.user_question, synthetic_fixture: item.synthetic_fixture, evidence: item.retrieved_evidence.map((source) => ({ ...source, citation_token: `{{cite:${source.source_id}}}` })), response_route: item.response_route, action_allowed: false }) },
  { role: "assistant", content: JSON.stringify({ answer:item.ideal_answer, citation_ids:[...new Set([...item.ideal_answer.matchAll(/\{\{cite:([^}]+)\}\}/g)].map((match) => match[1]))] }) },
], metadata: { training_id: item.training_id, capability: item.capability, topic_id: item.topic_id, completion_target_field: "ideal_answer" } });
const jsonl = (values) => `${values.map((item) => JSON.stringify(row(item))).join("\n")}\n`;
const trainJsonl = jsonl(trainItems); const validJsonl = jsonl(validItems);
mkdirSync(OUTPUT_ROOT, { recursive: true }); mkdirSync(REVIEW_ROOT, { recursive: true });
writeFileSync(resolve(OUTPUT_ROOT, "train.jsonl"), trainJsonl); writeFileSync(resolve(OUTPUT_ROOT, "valid.jsonl"), validJsonl);
const manifest = { version: "evaluation-cycle-v2-wave-3-lora-dataset-v1", generated_at: new Date().toISOString(), status: "approved_for_controlled_development_training", source_question_set: { path: INPUT, sha256: sha(readFileSync(INPUT)) }, completion_target_field: "ideal_answer", train: { count: trainItems.length, ids: trainItems.map((item) => item.training_id), sha256: sha(trainJsonl) }, validation: { count: validItems.length, ids: validItems.map((item) => item.training_id), sha256: sha(validJsonl) }, source_id_overlap: [], protected_partitions: { diagnostic_questions: "excluded", diagnostic_gold: "excluded", sealed_unseen_questions: "excluded", sealed_unseen_gold: "not_present_not_accessed" } };
manifest.source_answer_review_sha256 = reviewed.sha256;
manifest.source_answer_reviewer = reviewed.review.reviewer;
manifest.source_id_overlap = isolation.overlap.source_ids;
manifest.partition_isolation = isolation;
writeJson(resolve(OUTPUT_ROOT, "dataset-manifest.json"), manifest);
writeJson(resolve(REVIEW_ROOT, "training-review-pack.json"), { version: "wave-3-training-review-pack-v1", generated_at: new Date().toISOString(), status: "internally_reviewed_for_controlled_development_training_not_independent_gold_approval", item_count: items.length, items });
writeJson(resolve(REVIEW_ROOT, "training-approval.json"), { version: "wave-3-training-approval-v1", approved_at: new Date().toISOString(), status: "approved_for_cumulative_training", scope: "development_training_only", dataset_manifest_sha256: sha(`${JSON.stringify(manifest, null, 2)}\n`), protected_partitions_verified_excluded: true, independent_benchmark_approval: false });
writeFileSync(resolve(REVIEW_ROOT, "TRAINING-REVIEW.md"), `# Wave 3 training review\n\nStatus: **internally source-grounded for controlled development training**. The export contains ${trainItems.length} train and ${validItems.length} source-ID-disjoint validation examples. Diagnostic and unseen partitions are excluded. This is not independent benchmark-gold approval.\n`);
console.log(JSON.stringify({ items: items.length, train: trainItems.length, validation: validItems.length, output: OUTPUT_ROOT, status: manifest.status }, null, 2));
