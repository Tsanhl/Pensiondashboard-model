import { createHash } from "node:crypto";
import { existsSync,readFileSync,writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)),"..");
const SUITE = resolve(ROOT,"training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileSha256 = (path) => sha256(readFileSync(path));
const json = (path) => JSON.parse(readFileSync(path,"utf8"));
const jsonl = (path) => readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const failures = [];
const manifest = json(join(SUITE,"frozen-suite-manifest.json"));
const report = json(join(SUITE,"ID-REFREEZE-REPORT.json"));
const authorisation = json(join(SUITE,"OWNER-AUTHORISATION-ID-ONLY.json"));

if (manifest.version !== "topic161-replacement-v2-frozen-suite-manifest-v2" || manifest.state !== "REPLACEMENT_QUALIFICATION_REFROZEN_ID_ONLY") failures.push("manifest version/state is not the independently refrozen identity");
if (report.substantive_content_equal !== true || report.substantive_content_digest_before !== report.substantive_content_digest_after) failures.push("substantive-content equality receipt is invalid");
if (authorisation.substantive_changes_authorised !== false || authorisation.sealed_unseen_authorised !== false) failures.push("owner authorization exceeds ID-only scope");
if (manifest.id_remediation?.owner_authorisation_sha256 !== fileSha256(join(SUITE,"OWNER-AUTHORISATION-ID-ONLY.json")) || manifest.id_remediation?.report_sha256 !== fileSha256(join(SUITE,"ID-REFREEZE-REPORT.json"))) failures.push("manifest does not bind authorization/report bytes");

const aggregateQuestionIds = [];
const aggregateGoldIds = [];
for (const [wave,count] of Object.entries(manifest.waves || {})) {
  const bank = json(join(SUITE,wave,"development-question-set.json"));
  const questions = bank.topics.flatMap((topic) => topic.diagnostic_evaluation || []);
  const gold = json(join(SUITE,wave,"evaluation-gold.json")).items || [];
  const questionIds = questions.map((item) => item.id);
  const goldIds = gold.map((item) => item.id);
  aggregateQuestionIds.push(...questionIds);
  aggregateGoldIds.push(...goldIds);
  if (questions.length !== count || gold.length !== count || new Set(questionIds).size !== count || JSON.stringify(questionIds) !== JSON.stringify(goldIds)) failures.push(`${wave} count, uniqueness, or positional question/gold alignment failed`);
  if (!questions.every((item,index) => item.question_sha256 === gold[index]?.question_sha256)) failures.push(`${wave} question hashes are not positionally aligned`);
  if (manifest.hashes?.[wave]?.questions !== fileSha256(join(SUITE,wave,"development-question-set.json")) || manifest.hashes?.[wave]?.gold !== fileSha256(join(SUITE,wave,"evaluation-gold.json"))) failures.push(`${wave} manifest hashes do not match`);
}
const questions = jsonl(join(SUITE,"questions.jsonl"));
const gold = jsonl(join(SUITE,"gold-answers.jsonl"));
const propositions = jsonl(join(SUITE,"proposition-map.jsonl"));
const sourceMap = json(join(SUITE,"source-map.json"));
if (aggregateQuestionIds.length !== 161 || new Set(aggregateQuestionIds).size !== 161 || JSON.stringify(aggregateQuestionIds) !== JSON.stringify(aggregateGoldIds)) failures.push("aggregate wave IDs are not exactly 161 unique aligned IDs");
if (JSON.stringify(questions.map((item) => item.case_id)) !== JSON.stringify(aggregateQuestionIds) || JSON.stringify(gold.map((item) => item.case_id)) !== JSON.stringify(aggregateGoldIds)) failures.push("aggregate JSONL rows do not match wave order");
if (new Set(propositions.map((item) => item.proposition_id)).size !== propositions.length || propositions.some((item) => !aggregateQuestionIds.includes(item.case_id) || !String(item.proposition_id).startsWith(`${item.case_id}-p`))) failures.push("proposition IDs are not unique and bound to valid case IDs");
if (JSON.stringify(Object.keys(sourceMap).sort()) !== JSON.stringify([...aggregateQuestionIds].sort())) failures.push("source-map keys are not the exact 161 case IDs");
for (const [name,path] of Object.entries({ questions:"questions.jsonl",gold:"gold-answers.jsonl",propositions:"proposition-map.jsonl",source_map:"source-map.json",competency_matrix:"competency-matrix.json",independence_audit:"independence-audit.json" })) {
  if (manifest.hashes?.aggregate?.[name] !== fileSha256(join(SUITE,path))) failures.push(`aggregate ${name} hash mismatch`);
}
if (json(join(SUITE,"independence-audit.json")).passed !== true) failures.push("independence audit is not passed");

const result = { version:"topic161-replacement-v2-independent-refreeze-verification-v1",verified_at:new Date().toISOString(),passed:failures.length===0,failures,item_count:aggregateQuestionIds.length,unique_ids:new Set(aggregateQuestionIds).size,substantive_content_equal:report.substantive_content_equal,sealed_unseen_accessed:false,manifest_sha256:fileSha256(join(SUITE,"frozen-suite-manifest.json")) };
const receiptPath = join(SUITE,"INDEPENDENT-REFREEZE-VERIFICATION.json");
if (process.argv.includes("--write-receipt")) {
  if (existsSync(receiptPath)) throw new Error("Independent verification receipt already exists and is immutable.");
  writeFileSync(receiptPath,`${JSON.stringify(result,null,2)}\n`,{ mode:0o444,flag:"wx" });
} else if (existsSync(receiptPath)) {
  const receipt = json(receiptPath);
  for (const key of ["version","passed","item_count","unique_ids","substantive_content_equal","sealed_unseen_accessed","manifest_sha256"]) {
    if (receipt[key] !== result[key]) failures.push(`persisted independent verification receipt mismatch: ${key}`);
  }
  result.persistent_receipt_sha256 = fileSha256(receiptPath);
}
result.passed = failures.length === 0;
result.failures = failures;
console.log(JSON.stringify(result,null,2));
if (failures.length) process.exitCode = 1;
