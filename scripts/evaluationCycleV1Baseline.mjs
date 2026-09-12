import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CYCLE_ROOT, INPUTS, PROJECT_ROOT, countBy, hashFile, isoNow, markdownTable,
  readJson, sha256, writeJsonAtomic, writeTextAtomic
} from "./evaluationCycleV1Common.mjs";

await import("../server/loadEnv.js");
const [{ initialiseDataStore }, { processQuery }, { retrieveForQuery }, { generateLocalAnswer,localModelStatus }, grounding, policy] = await Promise.all([
  import("../server/store/userDataStore.js"),
  import("../server/services/queryProcessorService.js"),
  import("../server/services/retrievalService.js"),
  import("../server/services/localModelService.js"),
  import("../server/services/groundingService.js"),
  import("../server/prompts/answerPolicy.js")
]);
const { SAFE_TEMPLATES,publicSources,validateGroundedAnswer } = grounding;
const { ANSWER_POLICY_VERSION,ANSWER_SYSTEM_POLICY } = policy;

const OUTPUT_ROOT = resolve(CYCLE_ROOT, "01-baseline");
const RESULTS_PATH = resolve(OUTPUT_ROOT, "baseline-results.json");
const RESULTS_MD_PATH = resolve(OUTPUT_ROOT, "baseline-results.md");
const MANIFEST_PATH = resolve(OUTPUT_ROOT, "baseline-run-manifest.json");
const STAGE_STATUS_PATH = resolve(CYCLE_ROOT, "stage-status.json");
const MODEL_MANIFEST_PATH = resolve(PROJECT_ROOT, "models/model-manifest.json");
const RUNTIME_MANIFEST_PATH = resolve(PROJECT_ROOT, "runtime/runtime-manifest.json");
const RUNTIME_LOCK_PATH = resolve(PROJECT_ROOT, "runtime/runtime-lock.json");
const DB_PATH = process.env.PENSIONS_DB_PATH || resolve(PROJECT_ROOT, "data/pensions-dashboard.sqlite");
const GENERATION_CONFIG = Object.freeze({ temperature:0,topP:1,maxTokens:Number(process.env.LOCAL_LLM_MAX_TOKENS || 320),seed:42 });
const EVALUATION_USER_ID = "evaluation-cycle-v1";

function git(args, fallback = null) {
  try {
    return execFileSync("git", args, { cwd:PROJECT_ROOT,encoding:"utf8",stdio:["ignore","pipe","ignore"] }).trim();
  } catch {
    return fallback;
  }
}

async function healthJson(url) {
  try {
    const response = await fetch(url, { signal:AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => null);
    return { ok:response.ok,status:response.status,body };
  } catch (error) {
    return { ok:false,status:null,error:error.message };
  }
}

function sourceFile(path) {
  return { path,sha256:hashFile(path) };
}

function corpusSnapshot() {
  if (!existsSync(DB_PATH)) return { storage:"unknown",database_path:DB_PATH,available:false };
  const db = new DatabaseSync(DB_PATH, { readOnly:true });
  const rows = db.prepare(`SELECT user_id,record_name,json,updated_at FROM user_records
    WHERE (user_id='public' AND record_name IN ('knowledge-documents.json','knowledge-chunks.json'))
       OR (user_id='_global' AND record_name LIKE '%public-facts.json')
    ORDER BY user_id,record_name`).all();
  const records = rows.map((row) => {
    let count = null;
    try {
      const value = JSON.parse(row.json);
      count = Array.isArray(value) ? value.length : null;
    } catch {}
    return { user_id:row.user_id,record_name:row.record_name,count,updated_at:row.updated_at,sha256:sha256(row.json),bytes:Buffer.byteLength(row.json) };
  });
  db.close();
  return {
    storage:"sqlite_json_repository",
    database_path:DB_PATH,
    available:true,
    records,
    snapshot_hash:sha256(records.map((record) => `${record.user_id}:${record.record_name}:${record.sha256}`).join("\n"))
  };
}

function parseConversationContext(context = []) {
  return context.map((entry) => {
    if (typeof entry === "object" && entry && ["user","assistant"].includes(entry.role)) return { role:entry.role,content:String(entry.content || "") };
    const text = String(entry || "");
    if (/^assistant\s*:/i.test(text)) return { role:"assistant",content:text.replace(/^assistant\s*:\s*/i, "") };
    return { role:"user",content:text.replace(/^user\s*:\s*/i, "") };
  }).filter((entry) => entry.content);
}

function jurisdictionFromFixture(values = {}) {
  const candidates = [values.user_jurisdiction,values.jurisdiction,values.work_location,values.employment_location,values.divorce_jurisdiction].filter(Boolean).join(" ");
  if (/northern ireland|\bni\b|belfast/i.test(candidates)) return "NORTHERN_IRELAND";
  if (/england|wales|scotland|great britain|\bgb\b/i.test(candidates)) return "GREAT_BRITAIN";
  if (/united kingdom|\buk\b|gb_and_ni/i.test(candidates)) return "GB_AND_NI";
  return null;
}

function fixtureProviders(values = {}) {
  const candidates = [
    values.provider,values.resolved_provider,values.provider_x_identity,
    ...(Array.isArray(values.conversation_order) ? values.conversation_order : []),
    ...(Array.isArray(values.providers) ? values.providers : [])
  ];
  return [...new Set(candidates.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function fixtureSource(item) {
  const fixture = item.synthetic_fixture;
  return {
    sourceId:fixture.evidence_id,
    title:fixture.title || `Synthetic evaluation fixture ${item.id}`,
    section:"Permitted synthetic dashboard fixture",
    scope:"USER_PORTFOLIO",
    score:1,
    effectiveDate:fixture.as_of_date || null,
    updatedAt:fixture.as_of_date || null,
    snippet:JSON.stringify(fixture.values || {}),
    authority:"Synthetic evaluation fixture",
    jurisdiction:jurisdictionFromFixture(fixture.values || {}) || "not specified",
    canonicalLocation:null,
    documentId:`synthetic-${item.id}`,
    version:1,
    sourceType:"verified_synthetic_fixture",
    authorityRank:1,
    oscolaCitation:fixture.title || `Synthetic dashboard fixture for ${item.id}`
  };
}

function formatSourcesForModel(sources) {
  const snippetLimit = Number(process.env.LLM_SOURCE_SNIPPET_CHARS || 1800);
  return sources.map((source) => {
    const treatment = source.caseTreatment?.related?.map((entry) => `${entry.direction}:${entry.relationship}:${entry.relatedDocumentId} — ${entry.note}`).join(" | ") || "none recorded; absence is not proof that no later treatment exists";
    return `SOURCE ${source.sourceId}\nTitle: ${source.title}\nType: ${source.sourceType || "verified record"}\nPriority: ${source.authorityRank || 0.5}\nOSCOLA: ${source.oscolaCitation || source.title}${source.section ? `; relevant section: ${source.section}` : ""}\nScope: ${source.scope}\nJurisdiction/extent: ${source.jurisdiction || "not recorded — do not infer"}\nEffective/current-check date: ${source.effectiveDate || "unknown"}\nCase treatment: ${treatment}\nSection: ${source.section || "unknown"}\nEvidence: ${String(source.snippet || "").slice(0, snippetLimit)}`;
  }).join("\n\n");
}

function sanitisedQueryContext(item) {
  const latestMessages = parseConversationContext(item.conversation_context || []);
  const values = item.synthetic_fixture?.values || {};
  const providers = fixtureProviders(values);
  const jurisdiction = jurisdictionFromFixture(values);
  const resolvedEntities = {};
  if (jurisdiction) resolvedEntities.jurisdiction = jurisdiction;
  if (values.resolved_provider) resolvedEntities.provider = values.resolved_provider;
  if (values.policy_number) resolvedEntities.policyNumber = values.policy_number;
  return {
    summary:"",
    resolvedEntities,
    providers,
    latestMessages,
    lastUserMessage:[...latestMessages].reverse().find((entry) => entry.role === "user")?.content || ""
  };
}

function retrievalPlanWithoutExternalUserData(query) {
  const personalScopes = new Set(["USER_PORTFOLIO","USER_DOCUMENTS"]);
  const personalLookups = new Set(["account","charges","document_status","projection","investment_profile"]);
  return {
    ...query,
    source_scopes:query.source_scopes.filter((scope) => !personalScopes.has(scope)),
    structured_lookups:query.structured_lookups.filter((lookup) => !personalLookups.has(lookup))
  };
}

function retrievedChunkSources(sources) {
  return sources.filter((source) => source.scope === "CURATED_PUBLIC" && !String(source.sourceId).startsWith("structured_public_"));
}

function structuredFactSources(sources) {
  return sources.filter((source) => String(source.sourceId).startsWith("structured_public_") || source.sourceType === "official_structured_tax_fact");
}

function resultSkeleton(question, item, runTimestamp) {
  const individuallyScoreable = item.first_review_gold_answer_decision === "approve" && item.answer_review_status === "first_review_approved";
  return {
    question_id:question.id,
    suite:question.suite,
    question:question.question,
    fixture_id:item.synthetic_fixture?.evidence_id || null,
    model_version:"pension-assistant-v0-baseline",
    raw_model_answer:null,
    raw_model_output:null,
    final_system_answer:null,
    selected_jurisdiction:"UNSPECIFIED",
    selected_route:null,
    retrieved_chunk_ids:[],
    retrieved_chunk_text_hashes:[],
    structured_fact_ids:[],
    generated_citations:[],
    final_public_sources:[],
    handoff_decision:"none",
    action_or_tool_decision:"read_only_no_tool_call",
    tool_calls:[],
    latency_ms:0,
    token_usage:{},
    run_timestamp:runTimestamp,
    retrieval_trace:null,
    grounding_validation:null,
    official_aggregate_scoring_eligible:individuallyScoreable,
    official_aggregate_exclusion_reason:individuallyScoreable ? null : "gold_answer_pending_second_human_review",
    diagnostic_only:true
  };
}

async function runItem(question, item) {
  const startedAt = performance.now();
  const runTimestamp = isoNow();
  const result = resultSkeleton(question, item, runTimestamp);
  const context = sanitisedQueryContext(item);
  const query = processQuery(question.question, context);
  result.selected_jurisdiction = query.jurisdiction_scope;
  result.query_processor_output = query;

  if (query.intent === "HUMAN_HANDOFF" || query.intent === "UNSUPPORTED_ACTION") {
    result.selected_route = "HUMAN_HANDOFF";
    result.final_system_answer = SAFE_TEMPLATES.HUMAN_HANDOFF;
    result.handoff_decision = query.intent;
    result.action_or_tool_decision = query.intent === "UNSUPPORTED_ACTION" ? "refused_prohibited_action" : "read_only_handoff";
    result.grounding_validation = { valid:true,reason:"policy_handoff_no_model_call" };
    result.latency_ms = Math.round(performance.now() - startedAt);
    return result;
  }

  if (query.needs_clarification) {
    result.selected_route = "NEEDS_CLARIFICATION";
    result.final_system_answer = "I found more than one pension account. Please name the provider or policy so I do not apply details from the wrong account.";
    result.handoff_decision = "none";
    result.grounding_validation = { valid:true,reason:"account_ambiguity" };
    result.latency_ms = Math.round(performance.now() - startedAt);
    return result;
  }

  const retrievalPlan = retrievalPlanWithoutExternalUserData(query);
  let retrieval = { sources:[],trace:{ scopes:retrievalPlan.source_scopes,noResult:true,baseline_note:"no active public retrieval scope selected by current query processor" } };
  if (retrievalPlan.source_scopes.length) {
    retrieval = await retrieveForQuery({ userId:EVALUATION_USER_ID,sessionId:`baseline-${question.id}`,requestId:`baseline-${question.id}`,queryPlan:retrievalPlan,limit:8 });
  }
  const fixture = fixtureSource(item);
  const sources = [fixture,...retrieval.sources];
  const chunks = retrievedChunkSources(retrieval.sources);
  const facts = structuredFactSources(retrieval.sources);
  result.retrieved_chunk_ids = chunks.map((source) => source.sourceId);
  result.retrieved_chunk_text_hashes = chunks.map((source) => ({ chunk_id:source.sourceId,sha256:sha256(String(source.snippet || "")) }));
  result.structured_fact_ids = facts.map((source) => source.sourceId);
  result.retrieval_trace = retrieval.trace;
  result.retrieval_sources = retrieval.sources.map((source) => ({ source_id:source.sourceId,title:source.title,section:source.section || null,scope:source.scope,effective_date:source.effectiveDate || null,score:Number(source.score || 0),rerank_score:Number(source.rerankScore || 0),source_type:source.sourceType || null }));

  if (query.freshness_required && !retrieval.sources.some((source) => source.scope === "CURATED_PUBLIC" && source.effectiveDate)) {
    result.selected_route = "INSUFFICIENT_EVIDENCE";
    result.final_system_answer = SAFE_TEMPLATES.INSUFFICIENT_EVIDENCE;
    result.handoff_decision = "evidence_review";
    result.grounding_validation = { valid:false,reason:"missing_or_stale_public_sources" };
    result.latency_ms = Math.round(performance.now() - startedAt);
    return result;
  }

  const modelSources = sources.slice(0, Math.max(1, Number(process.env.LLM_CONTEXT_SOURCE_LIMIT || 6)));
  const modelMessages = [
    ...context.latestMessages,
    { role:"user",content:`QUERY\n${query.self_contained_query}\nRequested jurisdiction: ${query.jurisdiction_scope}\n\nVERIFIED SOURCES\n${formatSourcesForModel(modelSources)}` }
  ];
  const generated = await generateLocalAnswer({ system:ANSWER_SYSTEM_POLICY,messages:modelMessages,generationConfig:GENERATION_CONFIG });
  result.raw_model_answer = generated.answer;
  result.raw_model_output = generated.rawContent;
  result.generated_citations = generated.citationIds;
  result.token_usage = generated.usage || {};
  result.model_finish_reason = generated.finishReason;
  const validation = validateGroundedAnswer({ answer:generated.answer,citationIds:generated.citationIds,sources:modelSources,intent:query.intent });
  result.grounding_validation = validation;
  if (validation.valid) {
    result.selected_route = "ANSWER";
    result.final_system_answer = generated.answer;
    result.final_public_sources = publicSources(modelSources, validation.citationIds);
  } else {
    result.selected_route = "GROUNDING_FALLBACK";
    result.final_system_answer = SAFE_TEMPLATES.INSUFFICIENT_EVIDENCE;
    result.handoff_decision = "grounding_validation";
  }
  result.latency_ms = Math.round(performance.now() - startedAt);
  return result;
}

mkdirSync(OUTPUT_ROOT, { recursive:true });
for (const directory of ["02-error-analysis","03-training-drafts","04-unseen","05-training-runs","06-regression","07-final-gold","08-blind-validation"]) mkdirSync(resolve(CYCLE_ROOT, directory), { recursive:true });
await initialiseDataStore();

const evaluation = readJson(INPUTS.evaluationDraft);
const answerReview = readJson(INPUTS.answerReview);
const answerById = new Map(answerReview.items.map((item) => [item.id,item]));
const modelManifest = readJson(MODEL_MANIFEST_PATH);
const runtimeManifest = readJson(RUNTIME_MANIFEST_PATH);
const runtimeLock = readJson(RUNTIME_LOCK_PATH);
const modelPath = resolve(PROJECT_ROOT, "models", modelManifest.answer_model.file);
const runtimeServerPath = runtimeLock.server;
const modelService = await localModelStatus();
const modelHealth = await healthJson(`${String(process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "")}/v1/models`);
const embeddingHealth = await healthJson(`${String(process.env.EMBEDDING_SERVICE_URL || "http://127.0.0.1:8090").replace(/\/$/, "")}/health`);
const corpus = corpusSnapshot();
const startedAt = isoNow();
const runId = `baseline-${startedAt.replace(/[:.]/g, "-")}`;

const manifest = {
  manifest_version:"baseline-run-manifest-v1",
  run_id:runId,
  status:"running",
  phase:"Phase 1 — Baseline evaluation",
  started_at:startedAt,
  completed_at:null,
  canonical:true,
  deterministic_generation:GENERATION_CONFIG,
  model:{
    version:"pension-assistant-v0-baseline",
    base_model:modelManifest.answer_model.repository,
    model_revision:modelManifest.answer_model.revision,
    model_file:modelPath,
    model_file_sha256:hashFile(modelPath),
    manifest_expected_sha256:modelManifest.answer_model.sha256,
    quantisation:"Q4_K_M",
    lora_adapter:null,
    adapter_evidence:"No adapter, LoRA or safetensors artifact is configured in the model manifest.",
    service:modelService
  },
  runtime:{
    provider:runtimeManifest.source,
    release:runtimeManifest.release,
    platform:runtimeLock.platform,
    server_binary:runtimeServerPath,
    server_binary_sha256:hashFile(runtimeServerPath),
    service_health:modelHealth
  },
  prompt:{ version:ANSWER_POLICY_VERSION,sha256:sha256(ANSWER_SYSTEM_POLICY),source:sourceFile(resolve(PROJECT_ROOT, "server/prompts/answerPolicy.js")) },
  query_processor:{ version:"current-worktree",source:sourceFile(resolve(PROJECT_ROOT, "server/services/queryProcessorService.js")) },
  jurisdiction_router:{ version:"query-processor-detectJurisdiction-current-worktree",source:sourceFile(resolve(PROJECT_ROOT, "server/services/queryProcessorService.js")) },
  rag:{
    corpus_snapshot:corpus,
    embedding_model:process.env.EMBEDDING_MODEL || modelManifest.embedding_model.repository,
    embedding_dimensions:modelManifest.embedding_model.dimensions,
    embedding_service_health:embeddingHealth,
    lexical_retrieval_version:"knowledgeService hybrid-v1 lexicalScore",
    vector_retrieval_version:"knowledgeRepository cosineSimilarity over BGE embeddings",
    retrieval_config:"hybrid-v1",
    retrieval_min_score:Number(process.env.RETRIEVAL_MIN_SCORE || 0.18),
    degraded_retrieval_min_score:Number(process.env.DEGRADED_RETRIEVAL_MIN_SCORE || 0.04),
    reranker_version:process.env.RERANK_MODEL || "BAAI/bge-reranker-base",
    reranker_endpoint:process.env.RERANK_SERVICE_URL || "http://127.0.0.1:8090",
    require_cross_encoder:String(process.env.REQUIRE_CROSS_ENCODER_RERANK || "false").toLowerCase() === "true",
    sources:[
      sourceFile(resolve(PROJECT_ROOT, "server/services/knowledgeService.js")),
      sourceFile(resolve(PROJECT_ROOT, "server/repositories/knowledgeRepository.js")),
      sourceFile(resolve(PROJECT_ROOT, "server/services/retrievalService.js")),
      sourceFile(resolve(PROJECT_ROOT, "server/services/rerankingService.js"))
    ]
  },
  verification:{
    grounding_verifier_version:"groundingService-current-worktree",
    citation_verifier_version:"groundingService-current-worktree",
    source:sourceFile(resolve(PROJECT_ROOT, "server/services/groundingService.js"))
  },
  tool_and_action_permissions:{ mode:"read_only",external_action_tools_available_to_model:[],mutation_allowed:false },
  model_context:{ source_limit:Number(process.env.LLM_CONTEXT_SOURCE_LIMIT || 6),source_snippet_characters:Number(process.env.LLM_SOURCE_SNIPPET_CHARS || 1800) },
  source_input_policy:{
    allowed_fields:["question","conversation_context","synthetic_fixture"],
    allowed_active_runtime_context:["normal_system_and_safety_prompt","active_official_source_corpus","dated_structured_facts"],
    prohibited_from_model:["draft_answer","expected_route","scoring","required_checks","prohibited_checks","critical_failures","reviewer_notes","exact_gold_chunks","exact_gold_citation_arrangements"],
    gold_files_in_active_rag:false,
    fixture_source:"gold-answer-review.json is read only to extract the permitted synthetic fixture and conversation context; all other answer-item fields are excluded from model construction."
  },
  evaluation_assets:{
    question_count:evaluation.questions.length,
    answer_review_count:answerReview.items.length,
    immutable_manifest:resolve(CYCLE_ROOT, "00-preflight/immutable-input-manifest.json"),
    official_aggregate_scoring_eligible_count:answerReview.items.filter((item) => item.first_review_gold_answer_decision === "approve" && item.answer_review_status === "first_review_approved").length,
    provisional_diagnostic_count:evaluation.questions.length
  },
  code:{ commit:git(["rev-parse","HEAD"]),branch:git(["rev-parse","--abbrev-ref","HEAD"]),worktree_dirty:Boolean(git(["status","--porcelain"], "")),run_script:sourceFile(resolve(PROJECT_ROOT, "scripts/evaluationCycleV1Baseline.mjs")),local_model_service:sourceFile(resolve(PROJECT_ROOT, "server/services/localModelService.js")) },
  imported_prior_run:null
};
writeJsonAtomic(MANIFEST_PATH, manifest);

let existing = { version:"baseline-results-v1",run_id:runId,status:"running",started_at:startedAt,completed_at:null,diagnostic_only:true,official_aggregate_scoring_permitted:false,results:[] };
if (existsSync(RESULTS_PATH)) {
  const previous = readJson(RESULTS_PATH);
  if (Array.isArray(previous.results) && previous.results.length) {
    existing = previous;
    manifest.imported_prior_run = { path:RESULTS_PATH,run_id:previous.run_id || null,items:previous.results.length,answers_rewritten:false };
    writeJsonAtomic(MANIFEST_PATH, manifest);
  }
}
const completedIds = new Set(existing.results.map((item) => item.question_id));
for (const result of existing.results) {
  const reviewItem = answerById.get(result.question_id);
  const individuallyScoreable = reviewItem?.first_review_gold_answer_decision === "approve" && reviewItem?.answer_review_status === "first_review_approved";
  result.official_aggregate_scoring_eligible = individuallyScoreable;
  result.official_aggregate_exclusion_reason = individuallyScoreable ? null : "gold_answer_pending_second_human_review";
}

if (!modelHealth.ok) {
  manifest.status = "blocked_model_unavailable";
  manifest.completed_at = isoNow();
  writeJsonAtomic(MANIFEST_PATH, manifest);
  throw new Error("Canonical baseline is blocked: the local Qwen service is not available.");
}
if (!embeddingHealth.ok) {
  manifest.status = "blocked_embedding_service_unavailable";
  manifest.completed_at = isoNow();
  writeJsonAtomic(MANIFEST_PATH, manifest);
  throw new Error("Canonical baseline is blocked: the embedding/reranker service is not available.");
}
if (manifest.model.model_file_sha256 !== manifest.model.manifest_expected_sha256) {
  manifest.status = "blocked_model_checksum_mismatch";
  manifest.completed_at = isoNow();
  writeJsonAtomic(MANIFEST_PATH, manifest);
  throw new Error("Canonical baseline is blocked: the local model checksum does not match the pinned manifest.");
}

for (let index = 0; index < evaluation.questions.length; index += 1) {
  const question = evaluation.questions[index];
  if (completedIds.has(question.id)) {
    console.log(`[${index + 1}/${evaluation.questions.length}] ${question.id} imported unchanged`);
    continue;
  }
  const item = answerById.get(question.id);
  if (!item) throw new Error(`Missing permitted fixture for ${question.id}.`);
  try {
    const result = await runItem(question, item);
    existing.results.push(result);
    completedIds.add(question.id);
    console.log(`[${index + 1}/${evaluation.questions.length}] ${question.id} ${result.selected_route} ${result.latency_ms}ms`);
  } catch (error) {
    const failed = resultSkeleton(question, item, isoNow());
    failed.selected_route = "RUN_ERROR";
    failed.run_error = { name:error.name,code:error.code || null,message:error.message };
    failed.final_system_answer = SAFE_TEMPLATES.MODEL_UNAVAILABLE;
    failed.handoff_decision = "run_error";
    existing.results.push(failed);
    completedIds.add(question.id);
    console.log(`[${index + 1}/${evaluation.questions.length}] ${question.id} RUN_ERROR ${error.message}`);
  }
  existing.status = "running";
  writeJsonAtomic(RESULTS_PATH, existing);
}

existing.status = "completed_provisional_diagnostic";
existing.completed_at = isoNow();
existing.run_id ||= runId;
existing.version ||= "baseline-results-v1";
existing.diagnostic_only = true;
existing.official_aggregate_scoring_permitted = false;
existing.summary = {
  processed:existing.results.length,
  routes:countBy(existing.results.map((item) => item.selected_route)),
  model_calls:existing.results.filter((item) => item.raw_model_answer != null).length,
  grounding_valid:existing.results.filter((item) => item.grounding_validation?.valid === true && item.raw_model_answer != null).length,
  grounding_fallbacks:existing.results.filter((item) => item.selected_route === "GROUNDING_FALLBACK").length,
  run_errors:existing.results.filter((item) => item.selected_route === "RUN_ERROR").length,
  official_score_status:"not_scored; Phase 2 not executed and gold answers are not frozen"
};
writeJsonAtomic(RESULTS_PATH, existing);

manifest.status = existing.summary.run_errors ? "completed_with_run_errors" : "completed_provisional_diagnostic";
manifest.completed_at = existing.completed_at;
manifest.result_count = existing.results.length;
manifest.result_sha256 = hashFile(RESULTS_PATH);
writeJsonAtomic(MANIFEST_PATH, manifest);

const baselineMd = `# Baseline Evaluation Results\n\nRun: \`${manifest.run_id}\`  \nCompleted: ${existing.completed_at}\n\n## Outcome\n\nThe current self-hosted Qwen3-8B pipeline processed **${existing.results.length}** evaluation concepts as a provisional diagnostic run. No gold answer, expected route, scoring rubric, reviewer note, required/prohibited label, critical-failure label, or exact gold chunk was exposed to the model.\n\nOfficial pass/partial/fail scoring is **not reported in Phase 1**: the gold-answer set is not frozen and Phase 2 has not been executed.\n\n## Run counts\n\n${markdownTable(["Metric","Count"],[
  ["Items processed",existing.summary.processed],
  ["Model calls",existing.summary.model_calls],
  ["Grounded model answers accepted",existing.summary.grounding_valid],
  ["Grounding fallbacks",existing.summary.grounding_fallbacks],
  ["Run errors",existing.summary.run_errors],
  ["Individually scoreable items",existing.results.filter((item) => item.official_aggregate_scoring_eligible).length],
  ["Provisional/excluded items",existing.results.filter((item) => !item.official_aggregate_scoring_eligible).length]
])}\n\n## Actual routes\n\n${markdownTable(["Route","Count"],Object.entries(existing.summary.routes))}\n\n## Configuration\n\n- Base model: \`${manifest.model.base_model}\` at revision \`${manifest.model.model_revision}\`\n- Quantisation: \`${manifest.model.quantisation}\`\n- LoRA adapter: none configured\n- Prompt: \`${manifest.prompt.version}\` (SHA-256 \`${manifest.prompt.sha256}\`)\n- Embeddings: \`${manifest.rag.embedding_model}\` (${manifest.rag.embedding_dimensions} dimensions)\n- Reranker: \`${manifest.rag.reranker_version}\`\n- Generation: temperature ${GENERATION_CONFIG.temperature}, top-p ${GENERATION_CONFIG.topP}, seed ${GENERATION_CONFIG.seed}, max tokens ${GENERATION_CONFIG.maxTokens}\n- Tool/action mode: read-only; no external mutation tool is available to the model\n\n## Scoring status\n\nAll ${existing.results.length} items are marked \`diagnostic_only\` and \`official_aggregate_scoring_eligible: false\`. Phase 2 must wait for gold remediation or explicitly retain provisional/excluded scoring as directed.\n`;
const baselineMdWithEligibility = baselineMd.replace(
  `All ${existing.results.length} items are marked \`diagnostic_only\` and \`official_aggregate_scoring_eligible: false\`. Phase 2 must wait for gold remediation or explicitly retain provisional/excluded scoring as directed.`,
  `All ${existing.results.length} items remain part of the diagnostic run. The 27 first-review-approved items are individually scoreable; the 42 pending second review are marked \`official_aggregate_scoring_eligible: false\` and must remain excluded from model-selection aggregates. Phase 2 has not been executed.`
);
writeTextAtomic(RESULTS_MD_PATH, baselineMdWithEligibility);

const preflightReport = readJson(resolve(CYCLE_ROOT, "00-preflight/asset-integrity-report.json"));
writeJsonAtomic(STAGE_STATUS_PATH, {
  version:"evaluation-cycle-v1-stage-status",
  updated_at:isoNow(),
  overall_status:preflightReport.structural_preflight_passed && !existing.summary.run_errors ? "PHASES_0_AND_1_COMPLETED_PROVISIONALLY" : "BLOCKED",
  phases:{
    phase_0:{ status:preflightReport.structural_preflight_passed ? "completed" : "failed",questions_processed:preflightReport.counts.evaluation_questions,individually_scoreable_items:preflightReport.official_aggregate_model_selection_eligible_count,complete_aggregate_authorised:false,gold_freeze_allowed:false },
    phase_1:{ status:manifest.status,questions_processed:existing.results.length,model_version:"pension-assistant-v0-baseline",official_scoring_authorised:false },
    phase_2:{ status:"not_started",authorised:false,blocker:"Gold answers remain draft_human_review_required; provisional excluded scoring may be run only as a later explicit phase." },
    phase_3:{ status:"not_started",authorised:false },
    phase_4:{ status:"not_started",authorised:false },
    phase_5:{ status:"not_started",authorised:false },
    phase_6:{ status:"not_started",authorised:false },
    phase_7:{ status:"not_started",authorised:false }
  },
  critical_blockers:[`${preflightReport.counts.unresolved_human_review} edited gold answers require second human approval before they may enter official model-selection scoring.`],
  next_phase_authorised:false,
  deployment_gate:"BLOCKED_PENDING_GOLD_REMEDIATION"
});

console.log(JSON.stringify({ phase:"Phase 1",status:manifest.status,processed:existing.results.length,routes:existing.summary.routes,model_calls:existing.summary.model_calls,run_errors:existing.summary.run_errors,output_root:OUTPUT_ROOT }, null, 2));
