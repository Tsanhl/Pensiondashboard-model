import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CYCLE_ROOT,PROJECT_ROOT,hashFile,isoNow,readJson,sha256,writeJsonAtomic,writeTextAtomic } from "./evaluationCycleV1Common.mjs";

const draftRoot = resolve(CYCLE_ROOT,"03-training-drafts");
const manifestPath = resolve(draftRoot,"approved-training-manifest.json");
const packPath = resolve(draftRoot,"training-review-pack.json");
const contractPath = resolve(draftRoot,"training-export-contract.json");
const datasetRoot = resolve(PROJECT_ROOT,"training-data/private/evaluation-cycle-v1-lora");
const manifest = readJson(manifestPath);
const pack = readJson(packPath);
const contract = readJson(contractPath);

if (!manifest.phase_6_authorised || !manifest.training_run_authorised || manifest.training_started) throw new Error("Phase 6 training export is not authorised or has already started.");
if (manifest.source_pack.sha256 !== hashFile(packPath)) throw new Error("Approved source-pack hash changed after approval.");
if (manifest.export_contract.sha256 !== hashFile(contractPath)) throw new Error("Training export contract changed after approval.");
if (contract.completion_target_field !== "ideal_answer" || contract.allowed_completion_fields.length !== 1) throw new Error("Completion target isolation failed.");

const approved = new Map(manifest.approved_items.map((item) => [item.training_id,item]));
if (approved.size !== 42 || pack.items.length !== 42) throw new Error("Expected exactly 42 approved items.");
for (const item of pack.items) {
  const approval = approved.get(item.training_id);
  if (!approval || approval.item_sha256 !== sha256(JSON.stringify(item))) throw new Error(`${item.training_id} does not match its approved hash.`);
  if (item.human_review_status !== "approved_for_phase_6" || item.gold_similarity_check !== "passed") throw new Error(`${item.training_id} is not fully approved and contamination-cleared.`);
}

const validationIds = new Set([
  "train-cite-005","train-cite-009","train-cite-013","train-cite-017",
  "train-scam-011","train-scam-015","train-scam-016","train-scam-020"
]);
const trainItems = pack.items.filter((item) => !validationIds.has(item.training_id));
const validItems = pack.items.filter((item) => validationIds.has(item.training_id));
if (trainItems.length !== 34 || validItems.length !== 8) throw new Error("Expected a 34/8 source-family split.");

function sourceIds(items) {
  return new Set(items.flatMap((item) => item.retrieved_evidence.map((source) => source.source_id)));
}
const trainSourceIds = sourceIds(trainItems);
const overlap = [...sourceIds(validItems)].filter((id) => trainSourceIds.has(id));
if (overlap.length) throw new Error(`Validation source IDs leak into training: ${overlap.join(", ")}`);

const systemBase = [
  "You are a read-only UK pensions assistant.",
  "Answer only from the supplied synthetic fixture and evidence. Never invent facts, dates, figures, law, citations, actions or tool results.",
  "Cite supported propositions with the supplied {{cite:source_id}} token. Do not create citation IDs.",
  "If evidence is missing, stale, conflicting or from the wrong jurisdiction, say what is missing and use the required clarification or human-review route.",
  "Never provide personalised DB-transfer or investment recommendations and never claim to transfer funds, submit forms, call, refresh or change records."
].join(" ");

function row(item) {
  const internalControls = item.retrieved_evidence
    .filter((source) => source.citation_metadata?.user_visible === false || ["system_policy","internal_hidden"].includes(source.source_role))
    .map((source) => source.text);
  const evidence = item.retrieved_evidence
    .filter((source) => source.citation_metadata?.user_visible !== false && !["system_policy","internal_hidden"].includes(source.source_role))
    .map((source) => ({ source_id:source.source_id,source_role:source.source_role,jurisdiction:source.jurisdiction,text:source.text,citation_token:`{{cite:${source.source_id}}}` }));
  const prompt = {
    question:item.user_question,conversation_context:item.conversation_context,synthetic_fixture:item.synthetic_fixture,
    evidence,response_route:item.response_route,handoff_required:item.handoff_required,action_allowed:item.action_allowed
  };
  return {
    messages:[
      { role:"system",content:[systemBase,...internalControls.map((control) => `Internal control: ${control}`)].join("\n") },
      { role:"user",content:JSON.stringify(prompt) },
      { role:"assistant",content:item.ideal_answer }
    ],
    metadata:{ training_id:item.training_id,capability:item.capability,failure_cluster:item.failure_cluster,example_kind:item.example_kind,jurisdiction:item.jurisdiction,completion_target_field:"ideal_answer",approved_item_sha256:approved.get(item.training_id).item_sha256 }
  };
}

function jsonl(items) { return `${items.map((item) => JSON.stringify(row(item))).join("\n")}\n`; }
mkdirSync(datasetRoot,{ recursive:true });
writeTextAtomic(resolve(datasetRoot,"train.jsonl"),jsonl(trainItems));
writeTextAtomic(resolve(datasetRoot,"valid.jsonl"),jsonl(validItems));
writeJsonAtomic(resolve(datasetRoot,"dataset-manifest.json"),{
  version:"pension-assistant-phase-6-dataset-v1",generated_at:isoNow(),status:"approved_export_not_trained",
  source_manifest:{ path:manifestPath,sha256:hashFile(manifestPath) },source_pack:{ path:packPath,sha256:hashFile(packPath) },export_contract:{ path:contractPath,sha256:hashFile(contractPath) },
  split_policy:"source_id_disjoint_topic_and_source_family_holdout",train:{ count:trainItems.length,ids:trainItems.map((item) => item.training_id),sha256:hashFile(resolve(datasetRoot,"train.jsonl")) },
  validation:{ count:validItems.length,ids:validItems.map((item) => item.training_id),sha256:hashFile(resolve(datasetRoot,"valid.jsonl")) },
  source_id_overlap:[],completion_target_field:"ideal_answer",rendered_previews_exported:false,access_dates_exported_as_targets:false,
  protected_sets:{ development_regression_69:"excluded",sealed_unseen_60:"excluded",sealed_gold_answers_accessed:false },personal_data:"synthetic_only"
});
console.log(JSON.stringify({ dataset_root:datasetRoot,train:trainItems.length,validation:validItems.length,source_id_overlap:0,completion_target:"ideal_answer",sealed_gold_accessed:false },null,2));
