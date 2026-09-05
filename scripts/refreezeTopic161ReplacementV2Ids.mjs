import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_ROOT = resolve(PROJECT_ROOT,"training/evaluation-cycle-v2/29-topic161-replacement-visible-qualification-20260902");
const PROPOSAL_PATH = resolve(PROJECT_ROOT,"Log/qualification-worker/reports/topic161-replacement-v2-id-remediation-proposal.json");
const AUTHORISATION_FLAG = "--owner-authorised-id-only-refreeze";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileSha256 = (path) => sha256(readFileSync(path));
const canonical = (value) => JSON.stringify(value,Object.keys(value || {}).sort());
const readJson = (path) => JSON.parse(readFileSync(path,"utf8"));
const writeJson = (path,value) => writeFileSync(path,`${JSON.stringify(value,null,2)}\n`);
const readJsonl = (path) => readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const writeJsonl = (path,rows) => writeFileSync(path,`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

function fail(message) { throw new Error(message); }
function flattenQuestions(bank) { return bank.topics.flatMap((topic) => topic.diagnostic_evaluation || []); }

function normalizedContentDigest({ waveBanks,waveGold,questions,gold,propositions,sourceMap },mappings) {
  const reverse = new Map(mappings.map((item) => [item.proposed_id,item.old_id]));
  const normalizeId = (value) => reverse.get(value) || value;
  const normalizedBanks = Object.fromEntries(Object.entries(waveBanks).map(([wave,bank]) => [wave,{
    ...bank,
    topics:bank.topics.map((topic) => ({
      ...topic,
      diagnostic_evaluation:(topic.diagnostic_evaluation || []).map((item) => ({ ...item,id:"__CASE_ID__" })),
    })),
  }]));
  const normalizedGold = Object.fromEntries(Object.entries(waveGold).map(([wave,payload]) => [wave,{
    ...payload,items:payload.items.map((item) => ({ ...item,id:"__CASE_ID__" })),
  }]));
  const normalizedQuestions = questions.map((item) => ({ ...item,case_id:"__CASE_ID__" }));
  const normalizedRootGold = gold.map((item) => ({ ...item,case_id:"__CASE_ID__" }));
  const normalizedPropositions = propositions.map((item) => ({
    ...item,
    case_id:"__CASE_ID__",
    proposition_id:String(item.proposition_id).replace(String(item.case_id),"__CASE_ID__"),
  }));
  const normalizedSources = {};
  for (const [caseId,sources] of Object.entries(sourceMap)) {
    const key = normalizeId(caseId);
    normalizedSources[key] = [...(normalizedSources[key] || []),...sources];
  }
  return sha256(JSON.stringify({
    waveBanks:normalizedBanks,waveGold:normalizedGold,questions:normalizedQuestions,gold:normalizedRootGold,
    propositions:normalizedPropositions,sourceMap:normalizedSources,
  }));
}

if (!process.argv.includes(AUTHORISATION_FLAG)) {
  fail(`This protected metadata refreeze requires ${AUTHORISATION_FLAG}.`);
}

const proposalBytes = readFileSync(PROPOSAL_PATH);
const proposal = JSON.parse(proposalBytes);
if (proposal.version !== "topic161-replacement-v2-id-remediation-proposal-v1" || proposal.status !== "PROPOSAL_ONLY_NOT_APPLIED" ||
    proposal.legal_content_changed !== false || proposal.totals?.renamed_occurrences !== 25) fail("ID remediation proposal identity or scope is invalid.");

const waveBanks = {};
const waveGold = {};
for (const [wave,detail] of Object.entries(proposal.waves)) {
  const questionPath = resolve(detail.question_path);
  const goldPath = resolve(detail.gold_path);
  if (!questionPath.startsWith(`${SUITE_ROOT}/`) || !goldPath.startsWith(`${SUITE_ROOT}/`)) fail(`${wave} proposal path leaves the suite root.`);
  if (fileSha256(questionPath) !== detail.question_file_sha256 || fileSha256(goldPath) !== detail.gold_file_sha256) fail(`${wave} inputs changed after the proposal.`);
  waveBanks[wave] = readJson(questionPath);
  waveGold[wave] = readJson(goldPath);
  const questions = flattenQuestions(waveBanks[wave]);
  if (questions.length !== detail.rows || waveGold[wave].items.length !== detail.rows) fail(`${wave} row count changed.`);
  if (!questions.every((item,index) => item.id === waveGold[wave].items[index].id && item.question_sha256 === waveGold[wave].items[index].question_sha256)) fail(`${wave} question/gold alignment is invalid.`);
}

const questionsPath = join(SUITE_ROOT,"questions.jsonl");
const goldPath = join(SUITE_ROOT,"gold-answers.jsonl");
const propositionsPath = join(SUITE_ROOT,"proposition-map.jsonl");
const sourceMapPath = join(SUITE_ROOT,"source-map.json");
const questions = readJsonl(questionsPath);
const gold = readJsonl(goldPath);
const propositions = readJsonl(propositionsPath);
const sourceMap = readJson(sourceMapPath);
const mappings = Object.values(proposal.waves).flatMap((wave) => wave.mapping);
const beforeDigest = normalizedContentDigest({ waveBanks,waveGold,questions,gold,propositions,sourceMap },mappings);

let globalOffset = 0;
for (const [wave,detail] of Object.entries(proposal.waves)) {
  const bankRows = flattenQuestions(waveBanks[wave]);
  const goldRows = waveGold[wave].items;
  for (const mapping of detail.mapping) {
    const localIndex = mapping.index - 1;
    const globalIndex = globalOffset + localIndex;
    const bankRow = bankRows[localIndex];
    const goldRow = goldRows[localIndex];
    if (bankRow.id !== mapping.old_id || goldRow.id !== mapping.old_id || bankRow.construct_id !== mapping.construct_id ||
        bankRow.question_sha256 !== mapping.question_sha256 || goldRow.question_sha256 !== mapping.question_sha256) fail(`${wave} mapping does not match row ${mapping.index}.`);
    if (questions[globalIndex]?.case_id !== mapping.old_id || questions[globalIndex]?.construct_id !== mapping.construct_id || questions[globalIndex]?.question_sha256 !== mapping.question_sha256) fail(`${wave} root question row ${mapping.index} is not aligned.`);
    if (gold[globalIndex]?.case_id !== mapping.old_id || gold[globalIndex]?.reference_answer !== goldRow.reference_answer) fail(`${wave} root gold row ${mapping.index} is not aligned.`);
    bankRow.id = mapping.proposed_id;
    goldRow.id = mapping.proposed_id;
    questions[globalIndex].case_id = mapping.proposed_id;
    gold[globalIndex].case_id = mapping.proposed_id;
    const required = new Set(goldRow.required_checks || []);
    const matched = propositions.filter((item) => item.case_id === mapping.old_id && required.has(item.proposition));
    if (matched.length !== required.size || matched.length === 0) fail(`${wave} proposition rows for ${mapping.construct_id} are not uniquely identifiable.`);
    for (const item of matched) {
      const suffix = String(item.proposition_id).slice(mapping.old_id.length);
      item.case_id = mapping.proposed_id;
      item.proposition_id = `${mapping.proposed_id}${suffix}`;
    }
  }
  globalOffset += detail.rows;
}

const rebuiltSourceMap = {};
for (const item of propositions) rebuiltSourceMap[item.case_id] = [...(rebuiltSourceMap[item.case_id] || []),...(item.source_targets || [])];
const afterDigest = normalizedContentDigest({ waveBanks,waveGold,questions,gold,propositions,sourceMap:rebuiltSourceMap },mappings);
if (beforeDigest !== afterDigest) fail("A non-identifier qualification value changed during remediation.");

for (const [wave,detail] of Object.entries(proposal.waves)) {
  const ids = flattenQuestions(waveBanks[wave]).map((item) => item.id);
  const goldIds = waveGold[wave].items.map((item) => item.id);
  if (new Set(ids).size !== detail.rows || JSON.stringify(ids) !== JSON.stringify(goldIds)) fail(`${wave} does not have exact unique question/gold IDs after remediation.`);
  writeJson(resolve(detail.question_path),waveBanks[wave]);
  writeJson(resolve(detail.gold_path),waveGold[wave]);
}
writeJsonl(questionsPath,questions);
writeJsonl(goldPath,gold);
writeJsonl(propositionsPath,propositions);
writeJson(sourceMapPath,rebuiltSourceMap);

const authorisationPath = join(SUITE_ROOT,"OWNER-AUTHORISATION-ID-ONLY.json");
writeJson(authorisationPath,{
  version:"topic161-replacement-v2-owner-authorisation-v1",
  authorised_at:new Date().toISOString(),
  authority:"repository_owner_instruction",
  scope:"Apply the 25 proposal-listed second-occurrence ID renames and independently refreeze replacement-v2.",
  substantive_changes_authorised:false,
  sealed_unseen_authorised:false,
  proposal_sha256:sha256(proposalBytes),
});

const reportPath = join(SUITE_ROOT,"ID-REFREEZE-REPORT.json");
const report = {
  version:"topic161-replacement-v2-id-refreeze-report-v1",
  completed_at:new Date().toISOString(),
  owner_authorisation_sha256:fileSha256(authorisationPath),
  proposal_sha256:sha256(proposalBytes),
  changed_fields:["question.id","gold.id","questions.jsonl.case_id","gold-answers.jsonl.case_id","proposition-map.case_id","proposition-map.proposition_id","source-map object key"],
  changed_occurrences:25,
  substantive_content_digest_before:beforeDigest,
  substantive_content_digest_after:afterDigest,
  substantive_content_equal:true,
  question_gold_position_aligned:true,
  unique_ids:161,
  sealed_unseen_accessed:false,
};
writeJson(reportPath,report);

const manifestPath = join(SUITE_ROOT,"frozen-suite-manifest.json");
const manifest = {
  version:"topic161-replacement-v2-frozen-suite-manifest-v2",
  generated_at:new Date().toISOString(),
  state:"REPLACEMENT_QUALIFICATION_REFROZEN_ID_ONLY",
  suite:"topic161-replacement-v2",
  role:"VISIBLE_QUALIFICATION",
  training_use:"forbidden",
  model_selection_use:"forbidden_until_run",
  item_count:161,
  unique_item_ids:161,
  waves:Object.fromEntries(Object.entries(proposal.waves).map(([wave,detail]) => [wave,detail.rows])),
  independence_failures:0,
  sealed_unseen_accessed:false,
  id_remediation:{ proposal_sha256:sha256(proposalBytes),owner_authorisation_sha256:fileSha256(authorisationPath),report_sha256:fileSha256(reportPath),changed_occurrences:25,substantive_content_equal:true },
  hashes:{
    ...Object.fromEntries(Object.keys(proposal.waves).map((wave) => [wave,{
      questions:fileSha256(join(SUITE_ROOT,wave,"development-question-set.json")),
      gold:fileSha256(join(SUITE_ROOT,wave,"evaluation-gold.json")),
    }])),
    aggregate:{
      questions:fileSha256(questionsPath),gold:fileSha256(goldPath),propositions:fileSha256(propositionsPath),source_map:fileSha256(sourceMapPath),
      competency_matrix:fileSha256(join(SUITE_ROOT,"competency-matrix.json")),independence_audit:fileSha256(join(SUITE_ROOT,"independence-audit.json")),
    },
  },
};
writeJson(manifestPath,manifest);

console.log(JSON.stringify({ status:"REFROZEN_ID_ONLY",suite_root:SUITE_ROOT,manifest_sha256:fileSha256(manifestPath),report_sha256:fileSha256(reportPath),unique_ids:161,substantive_content_equal:true,sealed_unseen_accessed:false },null,2));
