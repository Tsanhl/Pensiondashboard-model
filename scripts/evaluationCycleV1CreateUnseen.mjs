import { createCipheriv,createHash,randomBytes } from "node:crypto";
import { chmodSync,existsSync,mkdirSync,readFileSync,writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname,resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CYCLE_ROOT,INPUTS,countBy,hashFile,isoNow,markdownTable,normaliseQuestion,readJson,sha256,
  writeJsonAtomic,writeTextAtomic
} from "./evaluationCycleV1Common.mjs";
import { cosineSimilarity,embedTexts } from "../server/services/embeddingService.js";
import { unseenItems } from "./evaluationCycleV1UnseenData.mjs";

const OUTPUT_ROOT = resolve(CYCLE_ROOT,"04-unseen");
const STATUS_PATH = resolve(CYCLE_ROOT,"stage-status.json");
const DATABASE_PATH = process.env.PENSIONS_DB_PATH || resolve("data/pensions-dashboard.sqlite");
const KEY_PATH = process.env.EVALUATION_SEAL_KEY_PATH || resolve(homedir(),".pension-assistant-evaluation","evaluation-cycle-v1-unseen.key");
const GENERATED_AT = isoNow();
const FORCE = String(process.env.PHASE4_REBUILD || "false").toLowerCase() === "true";
const SEMANTIC_THRESHOLD = Number(process.env.UNSEEN_SEMANTIC_DUPLICATE_THRESHOLD || 0.92);
const LEXICAL_THRESHOLD = Number(process.env.UNSEEN_LEXICAL_DUPLICATE_THRESHOLD || 0.84);
const phaseManifestPath = resolve(OUTPUT_ROOT,"phase-4-manifest.json");
if (existsSync(phaseManifestPath) && !FORCE) throw new Error("Phase 4 is already sealed. Set PHASE4_REBUILD=true only before any unseen run or developer inspection.");

function tokenSet(value) {
  const stop = new Set(["a","an","and","are","as","at","be","but","by","can","could","do","does","for","from","has","have","how","i","if","in","is","it","may","my","of","on","or","should","that","the","this","to","was","what","when","which","why","will","with"]);
  return new Set(normaliseQuestion(value).split(" ").filter((token) => token && !stop.has(token)));
}

function dice(left,right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function loadFacts() {
  const paths = [
    resolve("approved-materials/structured-facts/uk-pension-tax-facts-2026-27.json"),
    resolve("approved-materials/structured-facts/uk-pension-operational-facts-2026-27.json")
  ];
  const facts = new Map();
  for (const path of paths) {
    const collection = readJson(path);
    for (const fact of collection.facts || []) facts.set(fact.id,{ ...fact,collection_id:collection.id || collection.version || path });
  }
  return { facts,paths };
}

function loadCorpusEvidence() {
  const database = new DatabaseSync(DATABASE_PATH,{ readonly:true });
  const sourceRefs = [...new Map(unseenItems.flatMap((item) => item.gold.source_refs).map((ref) => [ref.chunk_id,ref])).values()];
  const chunkIds = sourceRefs.map((ref) => ref.chunk_id);
  const documentIds = [...new Set(sourceRefs.map((ref) => ref.source_id))];
  const chunkPlaceholders = chunkIds.map(() => "?").join(",");
  const documentPlaceholders = documentIds.map(() => "?").join(",");
  const documents = database.prepare(`
    SELECT json_extract(value,'$.id') id,json_extract(value,'$.title') title,
      json_extract(value,'$.authority') authority,json_extract(value,'$.jurisdiction') jurisdiction,
      json_extract(value,'$.canonicalLocation') canonical_location,json_extract(value,'$.checksum') checksum,
      json_extract(value,'$.version') version,json_extract(value,'$.updatedAt') updated_at,
      json_extract(value,'$.metadata.oscolaCitation') oscola_citation,
      json_extract(value,'$.metadata.sourceType') source_type,
      json_extract(value,'$.metadata.sourceUpdatedAt') source_updated_at,
      json_extract(value,'$.metadata.retrievedAt') retrieved_at
    FROM user_records,json_each(user_records.json)
    WHERE user_id='public' AND record_name='knowledge-documents.json'
      AND json_extract(value,'$.id') IN (${documentPlaceholders})
  `).all(...documentIds);
  const chunks = database.prepare(`
    SELECT json_extract(value,'$.id') id,json_extract(value,'$.documentId') document_id,
      json_extract(value,'$.sectionPath') section_path,json_extract(value,'$.ordinal') ordinal,
      json_extract(value,'$.content') content,json_extract(value,'$.metadata.documentVersion') document_version,
      json_extract(value,'$.metadata.lastUpdated') last_updated
    FROM user_records,json_each(user_records.json)
    WHERE user_id='public' AND record_name='knowledge-chunks.json'
      AND json_extract(value,'$.id') IN (${chunkPlaceholders})
  `).all(...chunkIds);
  database.close();
  const documentMap = new Map(documents.map((row) => [row.id,row]));
  const chunkMap = new Map(chunks.map((row) => [row.id,row]));
  const missingDocuments = documentIds.filter((id) => !documentMap.has(id));
  const missingChunks = chunkIds.filter((id) => !chunkMap.has(id));
  if (missingDocuments.length || missingChunks.length) {
    throw new Error(`Unseen evidence is missing from active corpus. documents=${missingDocuments.join(",")} chunks=${missingChunks.join(",")}`);
  }
  return { documentMap,chunkMap,sourceRefs };
}

function sourceRole(sourceType) {
  if (["legislation","secondary_legislation","eu_legislation"].includes(sourceType)) return "operative_legislation";
  if (sourceType === "case_law") return "judgment_passage";
  if (sourceType === "ombudsman_determination") return "ombudsman_determination";
  if (["official_guidance","official_tax_guidance","regulatory_guidance","ombudsman_procedure","ppf_operational_guidance"].includes(sourceType)) return "official_guidance";
  return "official_source";
}

function systemPolicyEvidence() {
  return {
    evidence_id:"system-policy-boundaries",evidence_type:"system_policy",source_role:"system_policy",
    title:"Pension Assistant Answer Policy v4",section:"Boundaries",
    content:"The assistant is read-only. It must not recommend a pension transfer or personalised investment, reveal third-party data, or claim to submit, merge, refresh, change or contact without an authorised tool and confirmed result.",
    oscola_citation:"Pension Assistant Answer Policy v4, 'Boundaries'"
  };
}

function renderClaim(claim) {
  const body = String(claim.text).trim().replace(/[.]+$/," ").trim();
  return `${body} (${claim.citation}).`;
}

function encryptJson(payload,key) {
  const plaintext = Buffer.from(`${JSON.stringify(payload,null,2)}\n`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm",key,iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return {
    envelope_version:"pension-assistant-sealed-json-v1",algorithm:"AES-256-GCM",
    key_id:createHash("sha256").update(key).digest("hex").slice(0,16),
    iv:iv.toString("base64"),auth_tag:cipher.getAuthTag().toString("base64"),
    ciphertext:ciphertext.toString("base64"),plaintext_sha256:createHash("sha256").update(plaintext).digest("hex"),
    plaintext_bytes:plaintext.length,item_count:payload.items.length,
    training_eligibility:"prohibited",access:"evaluation_runner_only"
  };
}

function loadOrCreateKey() {
  mkdirSync(dirname(KEY_PATH),{ recursive:true,mode:0o700 });
  chmodSync(dirname(KEY_PATH),0o700);
  if (!existsSync(KEY_PATH)) writeFileSync(KEY_PATH,randomBytes(32),{ mode:0o600,flag:"wx" });
  chmodSync(KEY_PATH,0o600);
  const key = readFileSync(KEY_PATH);
  if (key.length !== 32) throw new Error("Evaluation seal key must contain exactly 32 bytes.");
  return key;
}

function validateComposition(items,wave) {
  const tags = countBy(items.flatMap((item) => item.gold.composition_tags));
  const requirements = {
    answerable:2,missing_fact:2,cross_capability:2
  };
  if (["wave-1","wave-3","wave-4","wave-6"].includes(wave)) requirements.adversarial = 2;
  if (["wave-1","wave-3","wave-4","wave-5","wave-6"].includes(wave)) requirements.handoff = 2;
  if (["wave-1","wave-2","wave-4","wave-5","wave-6"].includes(wave)) requirements.jurisdiction_contrast = 2;
  const failures = Object.entries(requirements).filter(([tag,count]) => (tags[tag] || 0) < count);
  if (items.length < 10 || items.length > 15 || failures.length) {
    throw new Error(`${wave} composition failed: items=${items.length}; ${failures.map(([tag,count]) => `${tag}<${count}`).join(",")}`);
  }
  return { tags,requirements };
}

const ids = unseenItems.map((item) => item.question.id);
if (ids.length !== 60 || new Set(ids).size !== ids.length) throw new Error("Phase 4 requires exactly 60 unique question IDs.");
for (const item of unseenItems) {
  if (item.question.training_eligibility !== "prohibited" || item.gold.training_eligibility !== "prohibited") throw new Error(`${item.question.id} is not training-prohibited.`);
  if (!item.gold.claims?.length || !item.gold.required_behaviour?.length || !item.gold.prohibited_behaviour?.length) throw new Error(`${item.question.id} has an incomplete sealed rubric.`);
}

const regression = readJson(INPUTS.evaluationDraft).questions;
const regressionExact = new Map(regression.map((item) => [item.question,item.id]));
const regressionNormal = new Map(regression.map((item) => [normaliseQuestion(item.question),item.id]));
const exactMatches = [];
const normalisedMatches = [];
const lexicalMatches = [];
for (const item of unseenItems) {
  const question = item.question.question;
  if (regressionExact.has(question)) exactMatches.push({ unseen_id:item.question.id,regression_id:regressionExact.get(question) });
  if (regressionNormal.has(normaliseQuestion(question))) normalisedMatches.push({ unseen_id:item.question.id,regression_id:regressionNormal.get(normaliseQuestion(question)) });
  const left = tokenSet(question);
  const best = regression.map((row) => ({ id:row.id,score:dice(left,tokenSet(row.question)) })).sort((a,b) => b.score-a.score)[0];
  if (best.score >= LEXICAL_THRESHOLD) lexicalMatches.push({ unseen_id:item.question.id,regression_id:best.id,score:Number(best.score.toFixed(4)) });
}
if (exactMatches.length || normalisedMatches.length || lexicalMatches.length) {
  throw new Error(`Unseen contamination precheck failed. exact=${exactMatches.length} normalised=${normalisedMatches.length} lexical=${lexicalMatches.length}`);
}

const allQuestions = [...regression.map((item) => item.question),...unseenItems.map((item) => item.question.question)];
const embedded = await embedTexts(allQuestions);
if (embedded.degraded) throw new Error("Phase 4 sealing requires the configured BGE embedding service; deterministic fallback is not accepted.");
const regressionVectors = embedded.embeddings.slice(0,regression.length);
const unseenVectors = embedded.embeddings.slice(regression.length);
const semanticPairs = [];
const closestPairs = [];
for (const [index,vector] of unseenVectors.entries()) {
  const match = regressionVectors.map((candidate,regressionIndex) => ({
    id:regression[regressionIndex].id,score:cosineSimilarity(vector,candidate)
  })).sort((a,b) => b.score-a.score)[0];
  const pair = { unseen_id:unseenItems[index].question.id,regression_id:match.id,score:Number(match.score.toFixed(4)) };
  closestPairs.push(pair);
  if (match.score >= SEMANTIC_THRESHOLD) semanticPairs.push(pair);
}
if (semanticPairs.length) throw new Error(`Semantic near-duplicate check failed for ${semanticPairs.map((item) => `${item.unseen_id}:${item.regression_id}:${item.score}`).join(", ")}`);

const { facts,paths:factPaths } = loadFacts();
const { documentMap,chunkMap,sourceRefs } = loadCorpusEvidence();
const sourceSnapshot = sourceRefs.map((ref) => {
  const document = documentMap.get(ref.source_id);
  const chunk = chunkMap.get(ref.chunk_id);
  return { source_id:ref.source_id,chunk_id:ref.chunk_id,document_checksum:document.checksum,chunk_hash:sha256(chunk.content) };
}).sort((a,b) => a.chunk_id.localeCompare(b.chunk_id));
const sourceSnapshotHash = sha256(JSON.stringify(sourceSnapshot));
const key = loadOrCreateKey();

const waveRows = [];
const outputFiles = [];
for (let waveNumber=1; waveNumber<=6; waveNumber += 1) {
  const wave = `wave-${waveNumber}`;
  const items = unseenItems.filter((item) => item.question.wave === wave);
  const composition = validateComposition(items,wave);
  const questionPack = {
    version:`pension-unseen-${wave}-questions-v1`,generated_at:GENERATED_AT,status:"sealed_unseen_not_run",
    wave,item_count:items.length,training_eligibility:"prohibited",access:"evaluation_runner_only",
    questions:items.map((item) => item.question)
  };
  const goldItems = items.map((item) => {
    const fixtureEvidence = {
      evidence_id:`${item.question.id}-fixture`,evidence_type:"synthetic_fixture",source_role:"fixture",
      title:`Synthetic evaluation fixture ${item.question.id}`,content:JSON.stringify(item.question.synthetic_fixture.values),
      oscola_citation:`Synthetic evaluation fixture ${item.question.id}`
    };
    const evidence = [fixtureEvidence,systemPolicyEvidence()];
    for (const factId of item.gold.structured_fact_ids) {
      const fact = facts.get(factId);
      if (!fact) throw new Error(`${item.question.id} references missing structured fact ${factId}.`);
      evidence.push({ evidence_id:factId,evidence_type:"dated_structured_fact",source_role:"structured_fact",...fact });
    }
    for (const ref of item.gold.source_refs) {
      const document = documentMap.get(ref.source_id);
      const chunk = chunkMap.get(ref.chunk_id);
      evidence.push({
        evidence_id:chunk.id,evidence_type:"retrieved_chunk",source_id:document.id,document_id:document.id,
        title:document.title,authority:document.authority,jurisdiction:document.jurisdiction,
        section:chunk.section_path,content:chunk.content,content_hash:sha256(chunk.content),
        canonical_location:document.canonical_location,source_updated_at:document.source_updated_at,
        retrieved_at:document.retrieved_at,oscola_citation:document.oscola_citation || document.title,
        source_role:sourceRole(document.source_type)
      });
    }
    const evidenceIds = new Set(evidence.map((row) => row.evidence_id));
    for (const claim of item.gold.claims) {
      const missing = claim.evidence_ids.filter((id) => !evidenceIds.has(id));
      if (missing.length) throw new Error(`${item.question.id} claim has unresolved evidence: ${missing.join(",")}`);
    }
    return {
      ...item.gold,ideal_answer:item.gold.claims.map(renderClaim).join(" "),
      evidence,claim_evidence_map:item.gold.claims.map((row,index) => ({ claim_id:`${item.question.id}-claim-${index+1}`,...row })),
      scoring:{ maximum_points:10,grounding:4,sentence_level_citations:2,required_content:2,handoff_action_boundary:1,concision_scope:1,pass_mark:8,critical_failure_auto_fail:true }
    };
  });
  const sealedPayload = {
    version:`pension-unseen-${wave}-gold-v1`,generated_at:GENERATED_AT,wave,
    status:"sealed_unseen_independent_review_required",law_as_at:"2026-08-27",
    active_corpus_snapshot_sha256:sourceSnapshotHash,training_eligibility:"prohibited",items:goldItems
  };
  const waveRoot = resolve(OUTPUT_ROOT,wave);
  const questionsPath = resolve(waveRoot,"questions.json");
  const sealedPath = resolve(waveRoot,"gold-answers.sealed.json");
  const manifestPath = resolve(waveRoot,"manifest.json");
  writeJsonAtomic(questionsPath,questionPack);
  writeJsonAtomic(sealedPath,encryptJson(sealedPayload,key));
  const manifest = {
    version:`pension-unseen-${wave}-manifest-v1`,generated_at:GENERATED_AT,wave,status:"sealed_unseen_not_run",
    item_count:items.length,question_ids:ids.filter((id) => id.startsWith(`unseen-w${waveNumber}-`)),
    composition,questions_sha256:hashFile(questionsPath),sealed_gold_sha256:hashFile(sealedPath),
    active_corpus_snapshot_sha256:sourceSnapshotHash,embedding_model:embedded.model,
    contamination:{ exact_matches:0,normalised_matches:0,lexical_matches:0,semantic_matches:0,semantic_threshold:SEMANTIC_THRESHOLD },
    seal:{ algorithm:"AES-256-GCM",key_id:createHash("sha256").update(key).digest("hex").slice(0,16),key_location:"external_not_recorded",required_env:"EVALUATION_SEAL_KEY_PATH" },
    training_eligibility:"prohibited",training_pipeline_access:"denied",
    review_status:"independent_legal_and_semantic_review_required_before_model_selection",
    unseen_status:"unused_unseen"
  };
  writeJsonAtomic(manifestPath,manifest);
  outputFiles.push(questionsPath,sealedPath,manifestPath);
  waveRows.push([wave,items.length,composition.tags.answerable || 0,composition.tags.missing_fact || 0,composition.tags.handoff || 0,composition.tags.adversarial || 0,composition.tags.jurisdiction_contrast || 0,composition.tags.cross_capability || 0]);
}

const contaminationReport = {
  version:"phase-4-unseen-contamination-report-v1",generated_at:GENERATED_AT,status:"passed",
  regression_set:{ path:INPUTS.evaluationDraft,sha256:hashFile(INPUTS.evaluationDraft),items:regression.length },
  unseen_items:unseenItems.length,checks:{
    exact:{ threshold:"identical",matches:exactMatches },normalised:{ threshold:"identical after NFKC/lower/punctuation normalisation",matches:normalisedMatches },
    lexical:{ threshold:LEXICAL_THRESHOLD,matches:lexicalMatches },semantic:{ model:embedded.model,threshold:SEMANTIC_THRESHOLD,matches:semanticPairs }
  },
  closest_semantic_pairs:closestPairs.sort((a,b) => b.score-a.score).slice(0,12),
  intra_unseen_unique_ids:new Set(ids).size === ids.length,training_eligibility:"prohibited"
};
writeJsonAtomic(resolve(CYCLE_ROOT,"contamination-report.json"),contaminationReport);

const freshnessAudit = {
  version:"phase-4-source-freshness-audit-v1",checked_at:"2026-08-27",status:"verified_against_official_primary_pages",
  checks:[
    {
      topic:"pensions_dashboards_matching_and_value_data",authority:"The Pensions Regulator",
      url:"https://www.thepensionsregulator.gov.uk/en/trustees/contributions-data-and-transfers/dashboards-guidance",
      result:"current official guidance checked; matching accuracy, recent value data and privacy/false-match risks remain applicable"
    },
    {
      topic:"transfer_red_and_amber_flags",authority:"The Pensions Regulator",
      url:"https://www.thepensionsregulator.gov.uk/en/document-library/scheme-management-detailed-guidance/administration-detailed-guidance/dealing-with-transfer-requests",
      result:"current official guidance checked; red/amber safeguards and MoneyHelper-guidance routing remain applicable"
    },
    {
      topic:"tax_rates_and_normal_minimum_pension_age",authority:"HM Revenue & Customs",
      urls:[
        "https://www.gov.uk/government/publications/rates-and-allowances-pension-schemes/pension-schemes-rates",
        "https://www.gov.uk/hmrc-internal-manuals/pensions-tax-manual/ptm028000"
      ],
      result:"2026/27 dated rates and the age-57 change from 6 April 2028 checked; volatile figures remain structured facts, not weights"
    },
    {
      topic:"complaint_and_idrp_route",authority:"The Pensions Ombudsman",
      url:"https://www.pensions-ombudsman.org.uk/how-we-handle-complaints",
      result:"current official intake and formal-complaint/IDRP route checked"
    },
    {
      topic:"ppf_pre_1997_indexation",authority:"Pension Protection Fund",
      url:"https://www.ppf.co.uk/our-members/Will-my-payments-increase/pre-97",
      result:"2026 legislation, eligibility qualification and implementation timing checked; exact current guidance chunk selected"
    },
    {
      topic:"regulated_transfer_advice",authority:"Financial Conduct Authority",
      url:"https://handbook.fca.org.uk/handbook/COBS/19/1.html",
      result:"official boundary checked, but FCA full text remains excluded from active RAG pending reuse permission; unseen gold uses system policy and active primary legislation instead"
    }
  ],
  prohibited_sources:"course, seminar and handbook files were not used as legal authority",
  training_eligibility:"prohibited"
};
const freshnessAuditPath = resolve(OUTPUT_ROOT,"source-freshness-audit.json");
writeJsonAtomic(freshnessAuditPath,freshnessAudit);

const reportMd = `# Phase 4 — Sealed unseen-set creation\n\nGenerated: ${GENERATED_AT}\n\n## Outcome\n\nCreated 60 unused unseen questions across six capability waves. Questions are separated from AES-256-GCM sealed gold answers. The seal key is external to the project and is not recorded in any manifest.\n\n${markdownTable(["Wave","Items","Answerable","Missing fact","Handoff/refusal","Adversarial","Jurisdiction contrast","Cross-capability"],waveRows)}\n\n## Contamination\n\n- Exact matches against the 69-item regression set: 0\n- Normalised matches: 0\n- Lexical near-duplicates at ${LEXICAL_THRESHOLD}: 0\n- BGE semantic near-duplicates at ${SEMANTIC_THRESHOLD}: 0\n- Embedding model: ${embedded.model}\n\n## Isolation\n\n- Every question and gold item is marked \`training_eligibility: prohibited\`.\n- Gold answers, routes, rubrics, evidence targets and handoff labels exist only inside encrypted envelopes.\n- The training validator treats \`04-unseen\`, \`07-final-gold\` and \`08-blind-validation\` as protected input roots.\n- Independent legal/semantic review is required before these gold answers may be used for model selection. Review must not expose the set to training or prompt-development processes.\n`;
writeTextAtomic(resolve(OUTPUT_ROOT,"phase-4-unseen-report.md"),reportMd);

const phaseManifest = {
  version:"phase-4-manifest-v1",generated_at:GENERATED_AT,status:"completed",phase:"Phase 4 — sealed unseen sets",
  inputs:[
    { path:INPUTS.evaluationDraft,sha256:hashFile(INPUTS.evaluationDraft) },
    { path:resolve(CYCLE_ROOT,"03-training-drafts/phase-3-capability-wave-analysis.json"),sha256:hashFile(resolve(CYCLE_ROOT,"03-training-drafts/phase-3-capability-wave-analysis.json")) },
    ...factPaths.map((path) => ({ path,sha256:hashFile(path) }))
  ],questions_created:60,waves:6,gold_answers_sealed:60,active_corpus_evidence_chunks:sourceRefs.length,
  active_corpus_snapshot_sha256:sourceSnapshotHash,contamination_status:"passed",training_items_drafted:0,training_items_approved:0,
  model_version_produced:null,unseen_result:"not_run",regression_result:"not_run",
  independent_gold_review:"required_before_model_selection",next_phase:"Phase 5 — targeted training drafts after non-weight fix implementation and owner authorisation",
  output_files:[...outputFiles,resolve(OUTPUT_ROOT,"phase-4-unseen-report.md"),resolve(CYCLE_ROOT,"contamination-report.json"),freshnessAuditPath],
  training_eligibility:"prohibited"
};
writeJsonAtomic(phaseManifestPath,phaseManifest);

const status = readJson(STATUS_PATH);
status.updated_at = GENERATED_AT;
status.overall_status = "phase_4_completed";
status.phases.phase_4 = {
  status:"completed",authorised:true,questions_created:60,waves:6,gold_answers_sealed:60,
  contamination_status:"passed",unseen_status:"unused_unseen",independent_gold_review:"required_before_model_selection"
};
status.phases.phase_5 = { status:"not_started",authorised:false,ready_for_authorisation:true,requirement:"Apply P0 non-weight fixes, then draft only targeted behaviour examples; owner approval remains mandatory." };
status.next_phase_ready = "phase_5";
status.next_phase_authorised = false;
status.training_eligibility = "prohibited";
status.deployment_gate = "APPROVED_FOR_NEXT_DEVELOPMENT_PHASE";
status.critical_blockers = ["Sealed unseen gold requires independent legal/semantic review before model-selection scoring."];
writeJsonAtomic(STATUS_PATH,status);

console.log(JSON.stringify({
  phase:"Phase 4",status:"completed",questions_created:60,waves:6,gold_answers_sealed:60,
  contamination:"passed",semantic_model:embedded.model,training_items_drafted:0,next_phase:"Phase 5"
},null,2));
