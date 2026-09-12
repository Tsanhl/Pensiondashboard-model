import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";

const ROOT=resolve(process.env.TRAINING_REPAIR_V2_ROOT||"training/evaluation-cycle-v2/06-training-data-repair-revision-v2-20260901");
const OUT=resolve(process.env.TRAINING_REPAIR_REVIEW_OUT||"wave4-wave2-wave3-repair-review-v2-2026-09-01");
const readJson=(name)=>JSON.parse(readFileSync(resolve(ROOT,name),"utf8"));
const sha256=(value)=>createHash("sha256").update(value).digest("hex");
const fileSha=(path)=>sha256(readFileSync(path));
const stripCitations=(value)=>String(value).replace(/\s*\{\{cite:[^}]+\}\}/g,"").trim();
const pack=readJson("repaired-training-items-draft.json");
const allocation=readJson("global-allocation-draft.json");
const audit=readJson("integrity-and-review-preflight.json");

if(!audit.passed||pack.item_count!==52||allocation.train.count!==42||allocation.validation.count!==10){
  throw new Error("Refusing to package a failed or incomplete repair preflight");
}
if(pack.training_authorised!==false||pack.unseen_accessed!==false||allocation.training_authorised!==false){
  throw new Error("Review package must remain non-authorising and must not contain accessed unseen material");
}

rmSync(OUT,{recursive:true,force:true});
mkdirSync(OUT,{recursive:true});

const partitionById=new Map([
  ...allocation.train.ids.map((id)=>[id,"proposed_train"]),
  ...allocation.validation.ids.map((id)=>[id,"proposed_validation"]),
]);
const sourceMap=new Map();
for(const item of pack.items){
  for(const source of item.retrieved_evidence){
    const existing=sourceMap.get(source.source_id);
    if(existing&&existing.content_sha256!==source.content_sha256){
      throw new Error(`Source ID ${source.source_id} has inconsistent content`);
    }
    if(!existing)sourceMap.set(source.source_id,{...source,used_by:[]});
    sourceMap.get(source.source_id).used_by.push(item.training_id);
  }
}
const sourceRegister={
  version:"wave4-wave2-wave3-selected-source-register-v2",
  generated_at:new Date().toISOString(),
  status:"selected_evidence_pending_independent_proposition_review",
  training_authorised:false,
  unseen_accessed:false,
  source_count:sourceMap.size,
  sources:[...sourceMap.values()].sort((a,b)=>a.source_id.localeCompare(b.source_id)),
};
writeFileSync(resolve(OUT,"SOURCE-EVIDENCE-REGISTER.json"),JSON.stringify(sourceRegister,null,2)+"\n");

const validationIds=new Set(allocation.validation.ids);
const itemReview=[
  "# Wave 2–3: 52-item answer and evidence review",
  "",
  "> Review-only. These are developer-revised candidate records, not approved training data. No sealed unseen question or answer is included.",
  "",
  `Items: **${pack.item_count}** (Wave 2: **${audit.counts.wave_2}**; Wave 3: **${audit.counts.wave_3}**)  `,
  `Proposed allocation: **${allocation.train.count} train / ${allocation.validation.count} validation**  `,
  `Selected evidence sources: **${sourceRegister.source_count}**`,
  "",
  "For each proposition, the listed source set is a candidate mapping for independent review. The reviewer must confirm exact support against the full passages in `SOURCE-EVIDENCE-REGISTER.json`; citation membership alone is not legal approval.",
  "",
];
for(const wave of [2,3]){
  itemReview.push(`# Wave ${wave}`,"");
  for(const item of pack.items.filter((entry)=>entry.wave===wave)){
    itemReview.push(`## ${item.training_id}`,"");
    itemReview.push(`- Construct: \`${item.construct_id}\``);
    itemReview.push(`- Previous partition: \`${item.previous_partition}\``);
    itemReview.push(`- Proposed partition: \`${partitionById.get(item.training_id)}\``);
    itemReview.push(`- Repair basis: \`${item.repair_basis}\``);
    itemReview.push("",`**Question:** ${item.user_question}`,"",`**Revised answer:** ${stripCitations(item.ideal_answer)}`,"");
    itemReview.push("**Selected evidence:**","");
    for(const source of item.retrieved_evidence){
      const territorial=source.territorial_effective_dates?` — GB ${source.territorial_effective_dates.great_britain}; NI ${source.territorial_effective_dates.northern_ireland}`:"";
      itemReview.push(`- \`${source.source_id}\` — [${source.title}](${source.source_url}), ${source.section}; ${source.jurisdiction}; effective ${source.effective_date}${territorial}; SHA-256 \`${source.content_sha256}\``);
    }
    itemReview.push("","**Proposition map (pending independent approval):**","");
    for(const [index,entry] of item.proposition_review.entries()){
      itemReview.push(`${index+1}. ${entry.proposition}`);
      itemReview.push(`   - Sources: ${entry.source_ids.map((id)=>`\`${id}\``).join(", ")}`);
    }
    itemReview.push("");
  }
}
writeFileSync(resolve(OUT,"52-ITEM-ANSWER-EVIDENCE-REVIEW.md"),itemReview.join("\n")+"\n");

const responseRegister=`# Response to the 1 September 2026 screening review

Status: **developer repairs completed; independent legal approval still required**. Training and release remain blocked.

| Screening finding | Repair in this package | Verification state |
| --- | --- | --- |
| 51/52 historical records exposed target answers in their inputs | Replacement records were rebuilt with question-only prompts and separately selected evidence. The exact-answer echo audit reports 0/52 in evidence and 0/52 in prompts. Historical data, adapters and results are preserved but are not qualification evidence. | Machine check passed; rendered export has not been authorised or produced. |
| QROPS EEA transition omitted | \`v2r-w3-t02-train-003\` now requires the request date, completion before 30 April 2025, tax residence and QROPS country before applying or rejecting the transition. | Pending independent proposition review. |
| MPAA decision tree incomplete and PTM056510 rate conflict | \`v2r-w3-t02-train-002\` now separates pre/post-trigger inputs, branches on whether MPAA is exceeded, tests default versus alternative chargeable amounts, and uses the HMRC 2026/27 rates table for £50,000 rather than the inconsistent £30,000 PTM passage. | Conflict expressly retained for reviewer visibility. |
| Pension-loan answer suggested an unsafe loophole | \`v2-w3-t01-train-006\` now separates genuine early benefits from a member loan and gives a direct unauthorised-payment warning and protective action. | Pending independent proposition review. |
| Early-retirement answer invented consent/reduction evidence | \`v2-w3-t01-train-002\` now abstains from calculation and makes consent and actuarial reduction conditional on the missing scheme rules and quote. | Pending independent proposition review. |
| Small-pot and trivial-commutation routes conflated | \`v2r-w3-t01-train-002\` now applies the separate small-pot route first and limits trivial commutation to the specified eligible benefit categories. | Pending independent proposition review. |
| GAR classification and valuation imprecise | \`v2-w2-t01-train-006\` now identifies the particular guaranteed rights, separates safeguarded from other rights and requires the current statutory advice/valuation test. | Pending independent proposition review. |
| Outsourcing, continuity, CDC and McCloud evidence was off-topic | Each item now uses topic-matched TPR, dashboard Schedule 3 or HMRC public-service remedy sources. | Selected-source register included for full-passage review. |
| NI accessible IDRP had no equality evidence | \`v2-w2-t04-train-006\` now uses DDA 1995 s4H in its Northern Ireland application plus NI pension-procedure provisions, with the factual conditions stated. | Pending independent proposition review. |
| Civil-partner analysis omitted Schedule 9 paragraph 18(1C) | \`v2-w2-t04-train-005\` now applies the complete current exception after the 2023 amendment rather than the truncated preview. | Pending independent proposition review. |
| Historical part-time service source was unrelated | \`v2-w2-t04-train-004\` now uses the Part-time Workers Regulations 2000 and Preston (C-78/98), and splits the analysis at 1 July 2000. | Pending independent proposition review. |
| Dashboard complaint evidence was only a navigation fragment | \`v2r-w2-t06-train-003\` now uses the substantive TPR dispute-resolution process passage. | Pending independent proposition review. |
| Per-wave split was not genuinely independent | A global graph repartition groups exact source IDs, full-text hashes, canonical authority families and semantic legal rules across Waves 2–3. The proposed 42/10 split has zero detected overlaps in all four dimensions and contains five validation items from each wave. | Independent construct review and protected-set custodian comparison still required. |
| General Code commencement date conflated GB and NI | Relevant source metadata now records GB 28 March 2024 and NI 5 July 2024 separately. | Machine metadata check passed where the source is selected. |
| Section 75A authority identity was duplicated | The normalized Pensions Act 2004 source now records s272 as inserting s75A into the Pensions Act 1995, preserving amendment provenance and the governing-provision identity. | Rebuilt and re-indexed; reviewer should confirm downstream canonical identity before training. |

## Deliberately not done

- No replacement training or checkpoint selection.
- No rendered training export, token-length check or loss-mask qualification.
- No sealed unseen access, scoring or comparison.
- No release decision.
- No self-approval of any legal proposition or allocation.
`;
writeFileSync(resolve(OUT,"REPAIR-RESPONSE-REGISTER.md"),responseRegister);

const readme=`# Wave 2–3 repair review package v2

This package responds to the 1 September 2026 return-for-revision decision for all 52 visible Wave 2–3 records.

## Decision status

- Developer revision: **complete for review**
- Machine integrity preflight: **passed**
- Independent legal/proposition review: **pending**
- Proposed allocation approval: **pending**
- Protected-set custodian comparison: **pending**
- Training authorisation: **not granted**
- Sealed unseen access: **none**
- Release authorisation: **not granted**

The old Wave 2–3 datasets, weights and results must remain preserved for audit, but their answer-containing validation results must not be represented as clean qualification evidence.

## Package contents

- \`52-ITEM-ANSWER-EVIDENCE-REVIEW.md\` — all visible questions, revised answers, selected sources and proposition mappings.
- \`SOURCE-EVIDENCE-REGISTER.json\` — deduplicated full selected passages, source URLs, authority identities, hashes and item usage.
- \`REPAIR-RESPONSE-REGISTER.md\` — response to each material screening finding.
- \`repaired-training-items-draft.json\` — hashable 52-record review draft; not training-authorised.
- \`global-allocation-draft.json\` — proposed global 42/10 allocation and overlap audit.
- \`integrity-and-review-preflight.json\` — machine checks; explicitly not a legal approval.
- \`REVIEW-MANIFEST.json\` — file hashes and review controls.

## Reviewer decision required

Review all 52 answers proposition by proposition against each full source passage. Confirm jurisdiction, effective date, completeness, current/repealed status and source hierarchy. Then approve or return each item and approve or replace the global allocation. The protected-set custodian must separately compare the proposed allocation with all protected and previously used evaluation material without disclosing sealed content.

Only after those approvals should a separate process render the actual training export, inspect token lengths and loss masks, verify a clean starting checkpoint, and seek authority to train.
`;
writeFileSync(resolve(OUT,"REVIEW-README.md"),readme);

for(const name of ["repaired-training-items-draft.json","global-allocation-draft.json","integrity-and-review-preflight.json"]){
  cpSync(resolve(ROOT,name),resolve(OUT,name));
}

const manifestNames=[
  "REVIEW-README.md",
  "52-ITEM-ANSWER-EVIDENCE-REVIEW.md",
  "SOURCE-EVIDENCE-REGISTER.json",
  "REPAIR-RESPONSE-REGISTER.md",
  "repaired-training-items-draft.json",
  "global-allocation-draft.json",
  "integrity-and-review-preflight.json",
];
const manifest={
  version:"wave4-wave2-wave3-review-manifest-v2",
  generated_at:new Date().toISOString(),
  package_name:basename(OUT),
  purpose:"independent_review_only",
  training_authorised:false,
  release_authorised:false,
  unseen_included:false,
  unseen_accessed:false,
  counts:{items:52,wave_2:33,wave_3:19,proposed_train:42,proposed_validation:10,selected_sources:sourceRegister.source_count},
  controls:{machine_preflight_passed:true,independent_legal_review_pending:true,allocation_review_pending:true,protected_set_custodian_check_pending:true,rendered_export_preflight_pending:true,clean_checkpoint_provenance_pending:true},
  files:manifestNames.map((name)=>({name,sha256:fileSha(resolve(OUT,name))})),
};
writeFileSync(resolve(OUT,"REVIEW-MANIFEST.json"),JSON.stringify(manifest,null,2)+"\n");

console.log(JSON.stringify({output:OUT,items:52,sources:sourceRegister.source_count,validation_ids:[...validationIds],files:manifest.files.length+1},null,2));
