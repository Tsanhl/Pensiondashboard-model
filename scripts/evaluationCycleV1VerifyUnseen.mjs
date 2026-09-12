import { createDecipheriv,createHash } from "node:crypto";
import { readFileSync,statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CYCLE_ROOT,hashFile,readJson } from "./evaluationCycleV1Common.mjs";

const root = resolve(CYCLE_ROOT,"04-unseen");
const keyPath = process.env.EVALUATION_SEAL_KEY_PATH || resolve(homedir(),".pension-assistant-evaluation","evaluation-cycle-v1-unseen.key");
const key = readFileSync(keyPath);
if (key.length !== 32) throw new Error("Invalid evaluation seal key length.");
if ((statSync(keyPath).mode & 0o077) !== 0) throw new Error("Evaluation seal key must not be group/world accessible.");

function decrypt(envelope) {
  const decipher = createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.iv,"base64"));
  decipher.setAuthTag(Buffer.from(envelope.auth_tag,"base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]);
  const digest = createHash("sha256").update(plaintext).digest("hex");
  if (digest !== envelope.plaintext_sha256) throw new Error("Sealed plaintext hash mismatch.");
  return JSON.parse(plaintext.toString("utf8"));
}

let questionCount = 0;
let goldCount = 0;
const questionIds = new Set();
for (let waveNumber=1; waveNumber<=6; waveNumber += 1) {
  const wave = `wave-${waveNumber}`;
  const waveRoot = resolve(root,wave);
  const questionsPath = resolve(waveRoot,"questions.json");
  const sealedPath = resolve(waveRoot,"gold-answers.sealed.json");
  const manifest = readJson(resolve(waveRoot,"manifest.json"));
  const questions = readJson(questionsPath);
  const envelope = readJson(sealedPath);
  if (hashFile(questionsPath) !== manifest.questions_sha256 || hashFile(sealedPath) !== manifest.sealed_gold_sha256) throw new Error(`${wave} file hash mismatch.`);
  if (envelope.algorithm !== "AES-256-GCM" || envelope.key_id !== manifest.seal.key_id) throw new Error(`${wave} seal metadata mismatch.`);
  const gold = decrypt(envelope);
  if (questions.questions.length !== 10 || gold.items.length !== 10 || envelope.item_count !== 10) throw new Error(`${wave} must contain 10 questions and 10 gold items.`);
  const goldById = new Map(gold.items.map((item) => [item.id,item]));
  for (const question of questions.questions) {
    if (questionIds.has(question.id)) throw new Error(`Duplicate unseen ID ${question.id}.`);
    questionIds.add(question.id);
    if (question.training_eligibility !== "prohibited") throw new Error(`${question.id} is not training-prohibited.`);
    const item = goldById.get(question.id);
    if (!item) throw new Error(`${question.id} has no sealed gold item.`);
    if (!item.ideal_answer || !item.claim_evidence_map?.length || !item.evidence?.length) throw new Error(`${question.id} has incomplete sealed gold.`);
    const evidenceIds = new Set(item.evidence.map((row) => row.evidence_id));
    for (const claim of item.claim_evidence_map) {
      if (!claim.citation || !claim.evidence_ids?.length || claim.evidence_ids.some((id) => !evidenceIds.has(id))) throw new Error(`${question.id} has an invalid claim-evidence map.`);
    }
    if (item.training_eligibility !== "prohibited") throw new Error(`${question.id} sealed gold is not training-prohibited.`);
  }
  questionCount += questions.questions.length;
  goldCount += gold.items.length;
}

const phaseManifest = readJson(resolve(root,"phase-4-manifest.json"));
if (questionCount !== 60 || goldCount !== 60 || questionIds.size !== 60) throw new Error("Phase 4 count validation failed.");
if (phaseManifest.status !== "completed" || phaseManifest.contamination_status !== "passed") throw new Error("Phase 4 manifest is not complete and contamination-passed.");
console.log(JSON.stringify({ status:"verified",questions:questionCount,sealed_gold_items:goldCount,waves:6,key_permissions:"owner_only",gold_content_emitted:false },null,2));
