import assert from "node:assert/strict";
import { createCipheriv,createHash,randomBytes } from "node:crypto";
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join,resolve } from "node:path";
import test from "node:test";
import {
  EXECUTION_CONFIRMATION,
  EXPECTED_WAVES,
  acquireOneShotLock,
  assertAggregateOnly,
  assertLoopbackServiceUrl,
  codeBundleHash,
  decryptSealedEnvelope,
  executePreparedOneShot,
  loadProtectedWave,
  prepareOneShotPreflight,
  sha256,
  verifyRetrievalRuntime,
  verifySealedSuiteMetadata,
} from "../scripts/lib/sealedUnseenOneShotV1.mjs";
import { filterPinnedCorpusSources } from "../scripts/lib/sealedUnseenCaseRunnerV1.mjs";
import {
  PINNED_EMBEDDING_MODEL,
  PINNED_RERANKER_MODEL,
  PINNED_RETRIEVAL_MANIFEST_SHA256,
  PINNED_RETRIEVAL_SERVER_SHA256,
  PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
  PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
} from "../server/services/pinnedRetrievalIdentity.js";

const SECRET_QUESTION = "SYNTHETIC SECRET QUESTION MUST NEVER BE EMITTED";
const SECRET_ANSWER = "SYNTHETIC SECRET ANSWER MUST NEVER BE EMITTED";
const SECRET_RAW = "SYNTHETIC RAW MODEL PAYLOAD MUST NEVER BE EMITTED";

test("sealed retrieval drops unpinned documents and structured facts",() => {
  const sources = [
    { sourceId:"chunk-approved",documentId:"doc-approved",sourceType:"primary_legislation" },
    { sourceId:"chunk-extra",documentId:"doc-extra",sourceType:"official_guidance" },
    { sourceId:"structured_public_fact-approved",documentId:"public-fact-fact-approved",sourceType:"official_structured_tax_fact" },
    { sourceId:"structured_public_fact-extra",documentId:"public-fact-fact-extra",sourceType:"official_structured_tax_fact" },
  ];
  assert.deepEqual(filterPinnedCorpusSources(sources,{
    documentIds:new Set(["doc-approved"]),structuredFactIds:new Set(["fact-approved"]),
  }).map((source) => source.sourceId),["chunk-approved","structured_public_fact-approved"]);
});

function writeJson(path,value,mode = 0o600) {
  mkdirSync(dirname(path), { recursive:true });
  writeFileSync(path,`${JSON.stringify(value,null,2)}\n`, { mode });
  return path;
}

function record(path) {
  const bytes = readFileSync(path);
  return { path:resolve(path),bytes:bytes.length,sha256:sha256(bytes) };
}

function envelope(payload,key) {
  const plaintext = Buffer.from(`${JSON.stringify(payload,null,2)}\n`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm",key,iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return {
    envelope_version:"pension-assistant-sealed-json-v1",
    algorithm:"AES-256-GCM",
    key_id:createHash("sha256").update(key).digest("hex").slice(0,16),
    iv:iv.toString("base64"),
    auth_tag:cipher.getAuthTag().toString("base64"),
    ciphertext:ciphertext.toString("base64"),
    plaintext_sha256:sha256(plaintext),
    plaintext_bytes:plaintext.length,
    item_count:payload.items.length,
    training_eligibility:"prohibited",
    access:"evaluation_runner_only",
  };
}

function syntheticWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(),"sealed-one-shot-synthetic-"));
  t.after(() => rmSync(root,{ recursive:true,force:true }));
  const suiteRoot = join(root,"protected-synthetic-suite");
  const key = randomBytes(32);
  const keyPath = join(root,"synthetic.key");
  writeFileSync(keyPath,key,{ mode:0o600 });
  chmodSync(keyPath,0o600);
  const waveHashes = [];
  for (const wave of EXPECTED_WAVES) {
    const number = Number(wave.split("-")[1]);
    const questions = Array.from({ length:10 },(_,index) => ({
      id:`synthetic-w${number}-${index + 1}`,
      wave,
      question:`${SECRET_QUESTION} ${wave} ${index + 1}`,
      jurisdiction:"UNSPECIFIED",
      synthetic_fixture:{
        evidence_id:`fixture-w${number}-${index + 1}`,
        values:{ synthetic:true },
      },
      training_eligibility:"prohibited",
    }));
    const goldRows = questions.map((question) => ({
      id:question.id,
      training_eligibility:"prohibited",
      ideal_answer:`${SECRET_ANSWER} ${question.id}`,
      expected_route:"ANSWER",
      jurisdiction:"UNSPECIFIED",
      required_behaviour:["synthetic safe response"],
      evidence:[{ evidence_id:question.synthetic_fixture.evidence_id,content:"synthetic public-free fixture" }],
      claim_evidence_map:[{
        text:"synthetic safe response",
        citation:"Synthetic fixture",
        evidence_ids:[question.synthetic_fixture.evidence_id],
      }],
      scoring:{ pass_mark:8 },
    }));
    const waveRoot = join(suiteRoot,wave);
    const questionsPath = writeJson(join(waveRoot,"questions.json"),{
      version:`pension-unseen-${wave}-questions-v1`,
      status:"sealed_unseen_not_run",
      wave,item_count:10,training_eligibility:"prohibited",access:"evaluation_runner_only",questions,
    });
    const sealedPath = writeJson(join(waveRoot,"gold-answers.sealed.json"),envelope({
      version:`pension-unseen-${wave}-gold-v1`,wave,status:"sealed_unseen_independent_review_required",
      training_eligibility:"prohibited",items:goldRows,
    },key));
    const questionsSha256 = record(questionsPath).sha256;
    const sealedGoldSha256 = record(sealedPath).sha256;
    writeJson(join(waveRoot,"manifest.json"),{
      version:`pension-unseen-${wave}-manifest-v1`,wave,status:"sealed_unseen_not_run",
      item_count:10,question_ids:questions.map((row) => row.id),
      questions_sha256:questionsSha256,sealed_gold_sha256:sealedGoldSha256,
      contamination:{ exact_matches:0,normalised_matches:0,lexical_matches:0,semantic_matches:0 },
      seal:{ algorithm:"AES-256-GCM",key_id:createHash("sha256").update(key).digest("hex").slice(0,16) },
      training_eligibility:"prohibited",training_pipeline_access:"denied",unseen_status:"unused_unseen",
    });
    waveHashes.push({ wave,questions_sha256:questionsSha256,sealed_gold_sha256:sealedGoldSha256 });
  }
  writeJson(join(suiteRoot,"phase-4-manifest.json"),{
    version:"phase-4-manifest-v1",status:"completed",questions_created:60,waves:6,gold_answers_sealed:60,
    contamination_status:"passed",unseen_result:"not_run",training_eligibility:"prohibited",
  });

  const checkpointPath = writeJson(join(root,"checkpoint-selection.json"),{ synthetic:true });
  const selection = record(checkpointPath);
  const artifactPath = writeJson(join(root,"synthetic-artifact.json"),{ frozen:true });
  const artifact = record(artifactPath);
  const hash = (character) => character.repeat(64);
  const expectedIdentity = {
    id:"synthetic-frozen-step1",
    base_sha256:hash("a"),adapter_sha256:hash("b"),adapter_config_sha256:hash("c"),
    checkpoint_sha256:selection.sha256,model_config_sha256:hash("d"),tokenizer_sha256:hash("e"),tokenizer_config_sha256:hash("f"),
  };
  const checkpoint = {
    modelId:expectedIdentity.id,
    expectedIdentity,
    artifacts:{
      checkpoint_selection:selection,training_run_manifest:artifact,adapter_weights:artifact,
      adapter_config:artifact,base_model_weights:artifact,
    },
  };
  const visiblePath = writeJson(join(root,"visible-gate.json"),{
    version:"post-training-visible-qualification-v1-gate-v1",stage:"final",
    status:"passed_owner_authorised_visible_qualification",passed:true,
    owner_authorised_visible_qualification:true,release_authorised:false,
    sealed_unseen_accessed:false,sealed_unseen_authorised:false,blockers:[],
    checks:[{ id:"synthetic",passed:true }],
    assessments:{ critical4:{ passed:true },full69:{ passed:true },topic161:{ passed:true },frozen13:{ passed:true } },
    checkpoint:{
      model_id:checkpoint.modelId,expected_identity:expectedIdentity,checkpoint_selection:selection,
      training_run_manifest:artifact,adapter_weights:artifact,adapter_config:artifact,base_model_weights:artifact,
    },
  });
  const reviewPath = writeJson(join(root,"independent-review.json"),{
    version:"unseen-independent-review-approval-v1",status:"approved_for_unseen_execution_and_model_selection",
    reviewer_independence_attestation:"Synthetic reviewer was independent of all synthetic training, tuning and model-output work for this fixture.",
    signature_or_reviewer_id:"synthetic-reviewer",authorised_at:"2026-09-01T00:00:00.000Z",overall_decision:"approved",
    sealed_gold_hashes:waveHashes,
    waves:EXPECTED_WAVES.map((wave) => ({
      wave,question_count:10,question_decision:"approved",gold_answer_decision:"approved",
      legal_content_reviewed:true,semantic_evidence_support_reviewed:true,jurisdiction_reviewed:true,
      handoff_and_action_boundary_reviewed:true,approved_for_unseen_execution_and_model_selection:true,
      reviewed_at:"2026-09-01T00:00:00.000Z",
    })),
  });
  const corpusPath = writeJson(join(root,"approved-corpus-manifest.json"),{ synthetic:true });
  const codeRecords = { "synthetic_runner.mjs":artifact };
  const config = {
    executionConfirmation:EXECUTION_CONFIRMATION,
    runLabel:"synthetic-candidate-v1",
    checkpointPath,expectedCheckpointSha256:selection.sha256,
    visibleGatePath:visiblePath,expectedVisibleGateSha256:record(visiblePath).sha256,
    reviewApprovalPath:reviewPath,expectedReviewApprovalSha256:record(reviewPath).sha256,
    expectedCodeBundleSha256:codeBundleHash(codeRecords),
    corpusManifestPath:corpusPath,expectedCorpusManifestSha256:record(corpusPath).sha256,
    modelBaseUrl:"http://127.0.0.1:18080",embeddingBaseUrl:"http://localhost:18090",
    suiteRoot,outputRoot:join(root,"aggregate-output"),registryRoot:join(root,"one-shot-registry"),
  };
  const dependencies = {
    checkpointLoader:() => checkpoint,
    codeRecords:() => codeRecords,
    runtimeVerifier:async () => ({
      identity:expectedIdentity,model_health_sha256:hash("1"),embedding_health_sha256:hash("2"),
    }),
    retrievalVerifier:async () => ({ probe_sha256:hash("3") }),
  };
  return { root,suiteRoot,key,keyPath,checkpoint,config,dependencies };
}

test("preflight fails before dependency access without exact owner confirmation",async () => {
  let touched = false;
  await assert.rejects(
    prepareOneShotPreflight({ executionConfirmation:"not-authorised" },{
      checkpointLoader:() => { touched = true; },
    }),
    (error) => error.code === "EXECUTION_NOT_CONFIRMED",
  );
  assert.equal(touched,false);
});

test("synthetic AES envelope decrypts in memory and rejects a wrong key",() => {
  const key = randomBytes(32);
  const payload = { training_eligibility:"prohibited",items:[{ id:"synthetic-only" }] };
  const sealed = envelope(payload,key);
  assert.deepEqual(decryptSealedEnvelope(sealed,key,sealed.key_id),payload);
  assert.throws(() => decryptSealedEnvelope(sealed,randomBytes(32),sealed.key_id),(error) => error.code === "SEALED_DECRYPTION_FAILED");
});

test("model and retrieval endpoints must stay on loopback",() => {
  assert.equal(assertLoopbackServiceUrl("http://127.0.0.1:8080"),"http://127.0.0.1:8080");
  assert.equal(assertLoopbackServiceUrl("http://localhost:8090/"),"http://localhost:8090");
  for (const value of ["https://example.test", "http://192.168.1.50:8080", "not-a-url"]) {
    assert.throws(() => assertLoopbackServiceUrl(value),(error) => error.code === "NON_LOCAL_EVALUATION_SERVICE");
  }
});

test("retrieval preflight pins embedding and reranker model identities",async () => {
  const vector = Array(384).fill(0);
  const health = {
    ok:true,model:PINNED_EMBEDDING_MODEL.repository,model_revision:PINNED_EMBEDDING_MODEL.revision,
    dimensions:384,reranker_model:PINNED_RERANKER_MODEL.repository,reranker_revision:PINNED_RERANKER_MODEL.revision,
    server_sha256:PINNED_RETRIEVAL_SERVER_SHA256,model_manifest_sha256:PINNED_RETRIEVAL_MANIFEST_SHA256,
    retrieval_snapshot_manifest_sha256:PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
    retrieval_snapshot_contents_sha256:PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
    local_files_only:true,
  };
  const embedding = {
    model:PINNED_EMBEDDING_MODEL.repository,model_revision:PINNED_EMBEDDING_MODEL.revision,
    server_sha256:PINNED_RETRIEVAL_SERVER_SHA256,model_manifest_sha256:PINNED_RETRIEVAL_MANIFEST_SHA256,
    snapshot_manifest_sha256:PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
    snapshot_contents_sha256:PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
    embeddings:[vector],
  };
  const reranker = {
    model:PINNED_RERANKER_MODEL.repository,model_revision:PINNED_RERANKER_MODEL.revision,
    server_sha256:PINNED_RETRIEVAL_SERVER_SHA256,model_manifest_sha256:PINNED_RETRIEVAL_MANIFEST_SHA256,
    snapshot_manifest_sha256:PINNED_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256,
    snapshot_contents_sha256:PINNED_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256,
    results:[{ index:0,score:1 }],
  };
  const fetchImpl = async (url) => ({
    ok:true,
    json:async () => String(url).endsWith("/health") ? health : String(url).endsWith("/embed") ? embedding : reranker,
  });
  const good = await verifyRetrievalRuntime({ baseUrl:"http://localhost:8090",fetchImpl });
  assert.match(good.probe_sha256,/^[a-f0-9]{64}$/);
  const wrongModel = async (url) => ({
    ok:true,
    json:async () => String(url).endsWith("/health") ? health : String(url).endsWith("/embed")
      ? { ...embedding,model_revision:"0".repeat(40) }
      : reranker,
  });
  await assert.rejects(
    verifyRetrievalRuntime({ baseUrl:"http://localhost:8090",fetchImpl:wrongModel }),
    (error) => error.code === "RETRIEVAL_RUNTIME_INVALID",
  );
});

test("preflight hash-verifies synthetic checkpoint and visible gate",async (t) => {
  const fixture = syntheticWorkspace(t);
  const badCheckpoint = { ...fixture.config,expectedCheckpointSha256:"0".repeat(64) };
  await assert.rejects(prepareOneShotPreflight(badCheckpoint,fixture.dependencies),(error) => error.code === "CHECKPOINT_HASH_MISMATCH");

  const gate = JSON.parse(readFileSync(fixture.config.visibleGatePath,"utf8"));
  gate.passed = false;
  writeJson(fixture.config.visibleGatePath,gate);
  const badGate = { ...fixture.config,expectedVisibleGateSha256:record(fixture.config.visibleGatePath).sha256 };
  await assert.rejects(prepareOneShotPreflight(badGate,fixture.dependencies),(error) => error.code === "VISIBLE_GATE_NOT_QUALIFIED");
});

test("post-preflight manifest mutation is caught after consuming the one-shot",async (t) => {
  const fixture = syntheticWorkspace(t);
  const preflight = await prepareOneShotPreflight(fixture.config,fixture.dependencies);
  const manifestPath = join(fixture.suiteRoot,"wave-1","manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath,"utf8"));
  manifest.status = "synthetically-mutated";
  writeJson(manifestPath,manifest);
  let calls = 0;
  const summary = await executePreparedOneShot({
    preflight,keyPath:fixture.keyPath,protectedWaveLoader:loadProtectedWave,
    runCase:async () => { calls += 1;return {}; },
  });
  assert.equal(calls,0);
  assert.equal(summary.overall_release_gate,"BLOCKED");
  assert.equal(summary.overall.run_errors,60);
  await assert.rejects(
    executePreparedOneShot({ preflight,keyPath:fixture.keyPath,runCase:async () => ({}) }),
    (error) => error.code === "ONE_SHOT_ALREADY_CONSUMED",
  );
  await assert.rejects(
    prepareOneShotPreflight({ ...fixture.config,runLabel:"synthetic-candidate-v3" },fixture.dependencies),
    (error) => error.code === "ONE_SHOT_ALREADY_CONSUMED",
  );
});

test("synthetic run emits only aggregate data and cannot be rerun",async (t) => {
  const fixture = syntheticWorkspace(t);
  fixture.config.runLabel = "synthetic-candidate-v2";
  const preflight = await prepareOneShotPreflight(fixture.config,fixture.dependencies);
  const captured = [];
  const originalLog = console.log;
  console.log = (...values) => captured.push(values.join(" "));
  let summary;
  try {
    summary = await executePreparedOneShot({
      preflight,keyPath:fixture.keyPath,
      runCase:async (question) => {
        console.log(SECRET_QUESTION,SECRET_ANSWER,SECRET_RAW);
        return {
          selectedRoute:"ANSWER",selectedJurisdiction:"UNSPECIFIED",
          finalAnswer:`synthetic safe response ${SECRET_RAW}`,
          generatedCitations:[question.synthetic_fixture.evidence_id],
          retrievedChunkIds:[],structuredFactIds:[],evidenceIds:[question.synthetic_fixture.evidence_id],
          groundingValidation:{ valid:true,reason:"valid" },handoffDecision:"none",
          actionDecision:"read_only_no_tool_call",toolCalls:[],rawModelOutput:SECRET_RAW,
        };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(captured.length,0);
  assert.equal(summary.overall_release_gate,"PASS");
  assert.equal(summary.overall.total,60);
  assert.equal(summary.overall.pass,60);
  const output = readFileSync(preflight.outputPath,"utf8");
  for (const secret of [SECRET_QUESTION,SECRET_ANSWER,SECRET_RAW,"synthetic-w1-1"]) assert.equal(output.includes(secret),false);
  assert.deepEqual(JSON.parse(output),summary);
  assert.equal(statSync(preflight.outputPath).mode & 0o077,0);
  await assert.rejects(
    executePreparedOneShot({ preflight,keyPath:fixture.keyPath,runCase:async () => ({}) }),
    (error) => error.code === "ONE_SHOT_ALREADY_CONSUMED",
  );
});

test("aggregate validator rejects extra or protected-content fields",async (t) => {
  const fixture = syntheticWorkspace(t);
  const preflight = await prepareOneShotPreflight(fixture.config,fixture.dependencies);
  acquireOneShotLock(preflight);
  const waveResults = EXPECTED_WAVES.map((wave) => ({
    wave,total:10,pass:10,partial:0,fail:0,critical_failures:0,run_errors:0,pass_rate:100,
  }));
  const base = {
    version:"cycle-v1-sealed-unseen-one-shot-v1",run_label:preflight.runLabel,candidate_sha256:preflight.candidateSha256,
    waves:waveResults,overall:{ total:60,pass:60,partial:0,fail:0,critical_failures:0,run_errors:0,pass_rate:100,minimum_overall_pass_rate:90,minimum_per_wave_pass_rate:90 },
    runtime_hashes:preflight.runtimeHashes,checkpoint_hashes:preflight.checkpointHashes,code_hashes:preflight.codeHashes,overall_release_gate:"PASS",
  };
  assert.equal(assertAggregateOnly(base),base);
  assert.throws(() => assertAggregateOnly({ ...base,question:SECRET_QUESTION }),(error) => error.code === "AGGREGATE_SCHEMA_INVALID");
  assert.throws(() => assertAggregateOnly({
    ...base,
    code_hashes:{ ...base.code_hashes,question:"a".repeat(64) },
  }),(error) => error.code === "AGGREGATE_REDACTION_FAILED");
});

test("synthetic suite metadata pin detects manifest record changes",(t) => {
  const fixture = syntheticWorkspace(t);
  const suite = verifySealedSuiteMetadata({ suiteRoot:fixture.suiteRoot });
  const first = suite.waves[0];
  const manifest = JSON.parse(readFileSync(first.manifestPath,"utf8"));
  manifest.synthetic_note = "mutation";
  writeJson(first.manifestPath,manifest);
  assert.notEqual(record(first.manifestPath).sha256,first.manifestRecord.sha256);
  assert.throws(() => loadProtectedWave(first,fixture.key),(error) => error.code === "SEALED_WAVE_CHANGED_AFTER_PREFLIGHT");
});
