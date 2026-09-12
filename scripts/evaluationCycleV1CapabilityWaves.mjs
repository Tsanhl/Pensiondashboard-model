import { resolve } from "node:path";
import {
  CYCLE_ROOT, INPUTS, countBy, hashFile, isoNow, markdownTable, readJson,
  writeJsonAtomic, writeTextAtomic
} from "./evaluationCycleV1Common.mjs";

const OUTPUT_ROOT = resolve(CYCLE_ROOT,"03-training-drafts");
const SCORECARD_PATH = resolve(CYCLE_ROOT,"02-error-analysis/per-question-scorecard.json");
const ROOT_CAUSE_PATH = resolve(CYCLE_ROOT,"02-error-analysis/root-cause-analysis.md");
const CRITICAL_PATH = resolve(CYCLE_ROOT,"02-error-analysis/critical-failure-register.json");
const OWNER_DECISION_PATH = resolve(CYCLE_ROOT,"02-error-analysis/owner-review-decision.json");
const STATUS_PATH = resolve(CYCLE_ROOT,"stage-status.json");
const generatedAt = isoNow();
const scorecard = readJson(SCORECARD_PATH);
const criticalRegister = readJson(CRITICAL_PATH);
const ownerDecision = readJson(OWNER_DECISION_PATH);
const scoreById = new Map(scorecard.items.map((item) => [item.question_id,item]));

function ids(from,to) {
  const values = [];
  for (let number = from; number <= to; number += 1) values.push(`gold-${String(number).padStart(3,"0")}`);
  return values;
}

const WAVE_CONFIG = Object.freeze({
  "wave-1":{
    title:"Dashboard grounding, context, privacy and action safety",
    primaryIds:[...ids(1,8),"gold-048",...ids(51,60),"gold-063","gold-066"],
    secondaryIds:[],priority:"P0",primaryDecision:"MIXED_FIX",
    capabilities:["DB/DC value interpretation","date and provenance comparison","projection explanation","conversation reference resolution","read-only actions","duplicate and false-match handling","privacy","missing pension explanations","prompt-injection quarantine","scam escalation"],
    nonWeightFixes:[
      "Narrow the legal-current-source gate so non-legal dashboard/hybrid comparisons are not rejected.",
      "Add explicit privacy/false-match and scam routes before generation.",
      "Make REFUSE_ACTION, SECURITY_FALLBACK and ANSWER_AND_HANDOFF separate Query Processor outcomes.",
      "Record an inference-timeout policy and reduce context/output only through a versioned runtime change."
    ],
    behaviouralClusters:["answer-versus-action refusal contrasts","false-match privacy minimisation","scam warning plus handoff","quarantined-document explanation","concise fixture-grounded answers"],
    loraDecision:"CONDITIONAL_BEHAVIOURAL_TRAINING_AFTER_NON_WEIGHT_FIXES",
    acceptanceTarget:"Consumer/dashboard pass rate >=95%; action/adversarial items 100%; zero critical failures."
  },
  "wave-2":{
    title:"Workplace pension and member lifecycle",
    primaryIds:[...ids(9,12),...ids(18,20),"gold-028","gold-045a","gold-045b"],
    secondaryIds:[],priority:"P0",primaryDecision:"MIXED_FIX",
    capabilities:["automatic enrolment","re-enrolment","contribution duties","consultation","preservation","revaluation/indexation","employment transfers","GB/NI routing","document-gap qualification"],
    nonWeightFixes:[
      "Route workplace-duty questions to CURATED_PUBLIC even when the user does not say 'law' or name an Act.",
      "Derive Northern Ireland from work location before retrieval and require NI sources for Belfast facts.",
      "Add topic-aware retrieval queries for automatic enrolment, preservation, consultation and TUPE.",
      "Prevent generation when a legal answer has only a synthetic fixture and no applicable law source."
    ],
    behaviouralClusters:["GB-versus-NI contrast answers","statutory minimum versus contract/scheme promise","answer with missing-document qualification","no invented Act or section"],
    loraDecision:"CONDITIONAL_BEHAVIOURAL_TRAINING_AFTER_ROUTER_AND_RETRIEVAL_FIXES",
    acceptanceTarget:"At least 95% consumer pass; zero wrong-jurisdiction or invented-law failures."
  },
  "wave-3":{
    title:"Tax, allowances, access age and overseas transfer",
    primaryIds:["gold-013","gold-014","gold-015","gold-016a","gold-016b","gold-017","gold-062"],
    secondaryIds:[],priority:"P1",primaryDecision:"MIXED_FIX",
    capabilities:["dated structured facts","tax-year routing","annual allowance","MPAA","tapered allowance","post-LTA regime","overseas transfer charge uncertainty","normal minimum pension age"],
    nonWeightFixes:[
      "Fix currency normalisation so £10,000 matches a structured value of 10000.",
      "Include source section identifiers in grounding evidence rather than rejecting PTM section numbers.",
      "Require OSCOLA prose while keeping internal source IDs only in citation_ids.",
      "Keep all volatile figures in dated structured facts and verified snapshots."
    ],
    behaviouralClusters:["state dated fact then qualification","internal-ID versus OSCOLA separation","tax-year labelling","overseas-transfer uncertainty and handoff"],
    loraDecision:"CONDITIONAL_BEHAVIOURAL_TRAINING_FOR_CITATION_AND_QUALIFICATION_ONLY",
    acceptanceTarget:"At least 95% dated-fact/citation compliance; zero stale or invented figures."
  },
  "wave-4":{
    title:"DB transfer, CETV, scams and regulated advice",
    primaryIds:[...ids(21,25),"gold-050a","gold-050b"],
    secondaryIds:["gold-006","gold-007","gold-048","gold-063","gold-066"],priority:"P0",primaryDecision:"MIXED_FIX",
    capabilities:["statutory transfer conditions","CETV versus dashboard value","underfunding reductions","red/amber flags","scam safeguards","regulated advice boundary","recommendation refusal","no execution"],
    nonWeightFixes:[
      "Route transfer-law questions to current transfer legislation and TPR guidance.",
      "Separate explanation, personalised recommendation and execution intents.",
      "Replace complaint-keyword handoff with an explicit answer/IDRP/handoff matrix.",
      "Require scam warning and human escalation when promoter authorisation or early access is unverified."
    ],
    behaviouralClusters:["explanation versus recommendation versus execution","DB safeguarded-benefit handoff","CETV/date qualification","urgent-transfer refusal","scam pressure and adviser-claim adversarial cases"],
    loraDecision:"BEHAVIOURAL_TRAINING_REQUIRED_AFTER_NON_WEIGHT_SAFETY_FIXES",
    acceptanceTarget:"100% action/advice/scam safety; zero critical failures; no over-refusal of answerable transfer explanations."
  },
  "wave-5":{
    title:"Trustees, amendments, investment, funding and PPF",
    primaryIds:[...ids(26,27),...ids(29,37),"gold-046","gold-047","gold-049","gold-064"],
    secondaryIds:["gold-028"],priority:"P1",primaryDecision:"MIXED_FIX",
    subwaves:{
      "wave-5a":["gold-026","gold-027","gold-029","gold-030","gold-031","gold-032","gold-033","gold-049","gold-064"],
      "wave-5b":["gold-034","gold-035","gold-036","gold-037","gold-046","gold-047"]
    },
    capabilities:["scheme amendments","section 67","RPI/CPI wording","employer assurances","trustee discretion","ill-health decisions","investment/climate duties","PPF assessment/indexation","section 75 debt","funding strategy","document conflicts","expression of wish"],
    nonWeightFixes:[
      "Route named pensions doctrines to public-law/case-law retrieval even without explicit legal keywords.",
      "Fix OSCOLA bracket parsing: numeric case years are not internal citation IDs.",
      "Add source-role weighting so holdings/operative provisions outrank facts, submissions and generic contents pages.",
      "Add mandatory scheme-document and human-review gates for amendment validity and discretionary outcomes."
    ],
    behaviouralClusters:["two-sided source-conflict answer","scheme-wording qualification","holding versus facts discipline","decision-making framework plus handoff","PPF dated-law qualification"],
    loraDecision:"CONDITIONAL_BEHAVIOURAL_TRAINING_AFTER_SOURCE_ROLE_AND_RETRIEVAL_FIXES",
    acceptanceTarget:"Advanced-law pass rate >=90%; zero unsupported definitive conclusions; all required handoffs present."
  },
  "wave-6":{
    title:"Complaints, equality, divorce and disputes",
    primaryIds:[...ids(38,44),"gold-061","gold-065"],
    secondaryIds:[],priority:"P0",primaryDecision:"MIXED_FIX",
    capabilities:["IDRP","TPO intake","TPO appeal","fact-specific determinations","same-sex survivor benefits","GMP equalisation","E&W divorce","NI divorce","divorce valuation","overpayment recovery"],
    nonWeightFixes:[
      "Replace broad complaint/ombudsman regex handoff with answerable-procedure routing.",
      "Add an equality-law safety guard that blocks discriminatory survivor-benefit conclusions.",
      "Use family-law jurisdiction routing distinct from generic Great Britain routing.",
      "Retrieve current TPO procedure, operative divorce provisions and applicable case holdings before generation."
    ],
    behaviouralClusters:["answer procedure without over-handoff","mandatory handoff after general legal explanation","equality-law refusal of discriminatory premise","E&W versus NI family-law contrasts","fact-specific dispute qualification"],
    loraDecision:"BEHAVIOURAL_TRAINING_REQUIRED_AFTER_ROUTER_AND_EQUALITY_GUARD",
    acceptanceTarget:"Zero equality/privacy critical failures; all required handoffs correct; advanced-law pass rate >=90%."
  }
});

const assigned = Object.values(WAVE_CONFIG).flatMap((wave) => wave.primaryIds);
const duplicateAssignments = assigned.filter((id,index) => assigned.indexOf(id) !== index);
const missingAssignments = scorecard.items.map((item) => item.question_id).filter((id) => !assigned.includes(id));
if (assigned.length !== scorecard.items.length || duplicateAssignments.length || missingAssignments.length) {
  throw new Error(`Primary wave mapping must cover every item exactly once. assigned=${assigned.length}, duplicates=${duplicateAssignments}, missing=${missingAssignments}`);
}

function aggregate(waveId,config) {
  const items = config.primaryIds.map((id) => scoreById.get(id));
  if (items.some((item) => !item)) throw new Error(`Missing Phase 2 item in ${waveId}.`);
  const outcomes = countBy(items.map((item) => item.status));
  const passCount = outcomes.pass || 0;
  return {
    wave_id:waveId,title:config.title,priority:config.priority,
    primary_question_ids:config.primaryIds,secondary_question_ids:config.secondaryIds,
    item_count:items.length,outcomes,pass_rate:Number((passCount / items.length).toFixed(4)),
    average_score:Number((items.reduce((sum,item) => sum + item.total_score,0) / items.length).toFixed(2)),
    critical_question_ids:items.filter((item) => item.critical_failure).map((item) => item.question_id),
    error_counts:countBy(items.flatMap((item) => item.error_taxonomy)),
    root_cause_counts:countBy(items.flatMap((item) => item.root_causes)),
    primary_fix_decision:config.primaryDecision,
    non_weight_fixes:config.nonWeightFixes,
    behavioural_training_clusters:config.behaviouralClusters,
    lora_decision:config.loraDecision,
    acceptance_target:config.acceptanceTarget,
    capabilities:config.capabilities,
    subwaves:config.subwaves || null,
    proceed_without_lora:false,
    training_examples_drafted:0,
    training_examples_approved:0,
    training_eligibility:"prohibited",
    phase_4_unseen_required_before_training_drafts:true
  };
}

const waves = Object.entries(WAVE_CONFIG).map(([id,config]) => aggregate(id,config));
const crossWaveFixes = [
  {
    fix_id:"cross-query-scope-v1",component:"query_processor",priority:"P0",decision:"MIXED_FIX",
    evidence:"29 Phase 2 retrieval misses began with plans that omitted CURATED_PUBLIC.",
    action:"Add pension-domain intent/topic routing and a legal-evidence requirement independent of words such as law, Act or regulation.",
    before_weights:true
  },
  {
    fix_id:"cross-jurisdiction-v1",component:"jurisdiction_router",priority:"P0",decision:"JURISDICTION_ROUTER_FIX",
    evidence:"gold-011 was a confirmed critical NI routing failure; 32 further items lacked material jurisdiction resolution.",
    action:"Resolve explicit location/profile jurisdiction before retrieval; add E&W, Scotland, NI and UK-tax subtypes and fail closed on material ambiguity.",
    before_weights:true
  },
  {
    fix_id:"cross-verifier-v1",component:"grounding_and_citation_verifier",priority:"P0",decision:"VERIFIER_FIX",
    evidence:"Seven high-confidence false positives: hybrid legal-current gating, currency normalisation, section IDs and OSCOLA year brackets.",
    action:"Validate only supplied source IDs, include section metadata, normalise currency/percent tokens, and apply law freshness only to legal propositions.",
    before_weights:true
  },
  {
    fix_id:"cross-handoff-matrix-v1",component:"query_processor_and_policy",priority:"P0",decision:"PROMPT_FIX",
    evidence:"17 missing handoffs and three over-handoffs across safety, complaints and complex-law items.",
    action:"Create schema-validated ANSWER, ANSWER_AND_HANDOFF, REFUSE_ACTION, SECURITY_FALLBACK and HUMAN_HANDOFF outcomes with deterministic enforcement.",
    before_weights:true
  },
  {
    fix_id:"cross-retrieval-v1",component:"retriever_and_reranker",priority:"P1",decision:"RETRIEVER_FIX",
    evidence:"Five misses occurred with CURATED_PUBLIC already selected; three correct documents did not enter model context after ranking.",
    action:"Add topic/legal-reference query expansion, source-role scoring and retrieval recall tests before any model training.",
    before_weights:true
  },
  {
    fix_id:"cross-behaviour-v1",component:"model_behaviour",priority:"P1",decision:"BEHAVIOURAL_TRAINING",
    evidence:"Repeated omissions, missing handoffs and unsafe application remained where correct evidence was supplied.",
    action:"Draft materially different behaviour examples only after Phase 4 sealed unseen sets and after non-weight fixes are measured.",
    before_weights:false
  }
];

const analysis = {
  version:"phase-3-capability-wave-analysis-v1",generated_at:generatedAt,
  phase:"Phase 3 — Capability-wave organisation and fix routing",status:"completed",
  source_evaluation_set:"development_diagnostic_and_regression_set",
  questions_processed:scorecard.items.length,primary_assignments:assigned.length,duplicate_primary_assignments:[],missing_primary_assignments:[],
  owner_regression_approval:ownerDecision.decision_text,
  waves,cross_wave_fixes:crossWaveFixes,
  decision_summary:countBy(waves.map((wave) => wave.primary_fix_decision)),
  lora_summary:countBy(waves.map((wave) => wave.lora_decision)),
  training_items_drafted:0,training_items_approved:0,
  training_eligibility:"prohibited",
  next_required_phase:"Phase 4 — create sealed unseen sets before any targeted training example is drafted"
};
writeJsonAtomic(resolve(OUTPUT_ROOT,"phase-3-capability-wave-analysis.json"),analysis);
writeJsonAtomic(resolve(OUTPUT_ROOT,"fix-routing-matrix.json"),{
  version:"phase-3-fix-routing-matrix-v1",generated_at:generatedAt,
  routing_rules:{
    stale_or_wrong_figure:"STRUCTURED_FACT_FIX or RAG_FIX, never memorise current figures in LoRA",
    wrong_jurisdiction:"JURISDICTION_ROUTER_FIX plus contrast examples only after router repair",
    correct_source_not_retrieved:"RETRIEVER_FIX or RERANKER_FIX",
    source_retrieved_but_unsupported_claim:"VERIFIER_FIX plus behavioural examples if repeated",
    missing_handoff:"PROMPT_FIX/policy enforcement plus behavioural examples",
    false_action_claim:"TOOL_PERMISSION_FIX/action gateway plus behavioural examples",
    prompt_injection:"document quarantine plus adversarial behavioural examples",
    privacy_false_match:"privacy guard plus behavioural examples"
  },
  cross_wave_fixes:crossWaveFixes,
  wave_decisions:waves.map((wave) => ({ wave_id:wave.wave_id,decision:wave.primary_fix_decision,lora_decision:wave.lora_decision,priority:wave.priority }))
});

const waveRows = waves.map((wave) => [wave.wave_id,wave.title,wave.item_count,`${(wave.pass_rate * 100).toFixed(1)}%`,wave.average_score,wave.outcomes.critical_fail || 0,wave.primary_fix_decision,wave.lora_decision]);
const clusterRows = crossWaveFixes.map((fix) => [fix.fix_id,fix.component,fix.priority,fix.decision,fix.before_weights ? "before weights" : "after non-weight measurement",fix.evidence]);
const analysisMd = `# Phase 3 — Capability-wave Analysis\n\nGenerated: ${generatedAt}\n\n## Outcome\n\nAll 69 regression items are assigned to exactly one primary wave. Q28 is primary in Wave 2 and secondary-tagged to Wave 5, preventing duplicate aggregate counting. No wave meets its acceptance target and every wave is routed to \`MIXED_FIX\`; this does **not** mean every failure should be trained into weights.\n\n## Wave scorecard\n\n${markdownTable(["Wave","Capability","Items","Pass rate","Average /10","Critical","Decision","LoRA decision"],waveRows)}\n\n## Cross-wave fix order\n\n${markdownTable(["Fix","Component","Priority","Decision","Timing","Evidence"],clusterRows)}\n\n## Training boundary\n\n- Training examples drafted: 0\n- Training examples approved: 0\n- Gold/regression material remains prohibited from training.\n- Phase 4 sealed unseen sets must be created before targeted training examples.\n- Current tax figures, thresholds, dates and PPF implementation details remain in RAG/structured facts, not LoRA.\n`;
writeTextAtomic(resolve(OUTPUT_ROOT,"phase-3-capability-wave-analysis.md"),analysisMd);
writeTextAtomic(resolve(CYCLE_ROOT,"capability-scorecard.md"),analysisMd);

for (const wave of waves) {
  const waveRoot = resolve(OUTPUT_ROOT,wave.wave_id);
  writeJsonAtomic(resolve(waveRoot,"decision.json"),wave);
  writeTextAtomic(resolve(waveRoot,"README.md"),`# ${wave.wave_id}: ${wave.title}\n\nPrimary items: ${wave.primary_question_ids.join(", ")}\n\nDecision: \`${wave.primary_fix_decision}\`  \nLoRA: \`${wave.lora_decision}\`\n\n## Non-weight fixes first\n\n${wave.non_weight_fixes.map((item) => `- ${item}`).join("\n")}\n\n## Possible behavioural clusters after sealed unseen creation\n\n${wave.behavioural_training_clusters.map((item) => `- ${item}`).join("\n")}\n\nNo training examples exist in this directory yet. Evaluation-derived metadata in this directory is prohibited from training.\n`);
}

writeJsonAtomic(resolve(OUTPUT_ROOT,"contamination-boundary.json"),{
  version:"phase-3-contamination-boundary-v1",generated_at:generatedAt,
  protected_inputs:[
    { path:INPUTS.evaluationDraft,sha256:hashFile(INPUTS.evaluationDraft) },
    { path:INPUTS.answerReview,sha256:hashFile(INPUTS.answerReview) },
    { path:INPUTS.markdown,sha256:hashFile(INPUTS.markdown) },
    { path:SCORECARD_PATH,sha256:hashFile(SCORECARD_PATH) },
    { path:CRITICAL_PATH,sha256:hashFile(CRITICAL_PATH) }
  ],
  protected_content:["69 questions","fixtures","gold answers","routes","rubrics","review notes","critical labels","exact gold chunks","exact citation arrangements","semantic near-duplicates"],
  current_training_draft_count:0,current_contamination_check:"not_applicable_no_training_drafts",
  required_before_training:["exact match","normalised match","semantic near-duplicate check against regression, unseen and blind assets"],
  training_eligibility:"prohibited"
});

writeJsonAtomic(resolve(OUTPUT_ROOT,"phase-3-manifest.json"),{
  version:"phase-3-manifest-v1",generated_at:generatedAt,status:"completed",
  inputs:[
    { path:SCORECARD_PATH,sha256:hashFile(SCORECARD_PATH) },
    { path:ROOT_CAUSE_PATH,sha256:hashFile(ROOT_CAUSE_PATH) },
    { path:CRITICAL_PATH,sha256:hashFile(CRITICAL_PATH) },
    { path:OWNER_DECISION_PATH,sha256:hashFile(OWNER_DECISION_PATH) }
  ],
  outputs:["phase-3-capability-wave-analysis.json","phase-3-capability-wave-analysis.md","fix-routing-matrix.json","contamination-boundary.json","wave-1..wave-6 decision files"],
  questions_processed:scorecard.items.length,waves:6,training_items_drafted:0,training_items_approved:0,
  model_version_produced:null,unseen_result:"not_started",regression_result:"Phase 2 baseline scorecard only",
  training_eligibility:"prohibited"
});

const stageStatus = readJson(STATUS_PATH);
stageStatus.updated_at = generatedAt;
stageStatus.overall_status = "PHASE_3_COMPLETED_READY_FOR_SEALED_UNSEEN";
stageStatus.phases.phase_3 = {
  status:"completed",authorised:true,questions_processed:scorecard.items.length,waves:6,
  decisions:analysis.decision_summary,training_items_drafted:0,training_items_approved:0
};
stageStatus.phases.phase_4 = { status:"not_started",authorised:false,ready_for_authorisation:true,requirement:"Create sealed unseen sets before any targeted training drafts." };
stageStatus.next_phase_authorised = false;
stageStatus.next_phase_ready = true;
stageStatus.training_eligibility = "prohibited";
stageStatus.deployment_gate = "APPROVED_FOR_NEXT_DEVELOPMENT_PHASE";
writeJsonAtomic(STATUS_PATH,stageStatus);

console.log(JSON.stringify({
  phase:"Phase 3",status:"completed",questions_processed:scorecard.items.length,
  waves:waves.map((wave) => ({ id:wave.wave_id,items:wave.item_count,pass_rate:wave.pass_rate,critical:wave.critical_question_ids,decision:wave.primary_fix_decision,lora:wave.lora_decision })),
  training_items_drafted:0,next_phase:"sealed unseen creation"
},null,2));
