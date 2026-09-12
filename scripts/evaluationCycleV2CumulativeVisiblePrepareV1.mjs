import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  auditTrainingPartitionIsolation,
  auditTrainingRows,
  contentHash,
} from "./lib/trainingEvidenceIntegrity.mjs";

const WORKSPACE = resolve(".");
const ROOT = resolve(
  process.env.CUMULATIVE_VISIBLE_QUALIFICATION_ROOT ||
    "training/evaluation-cycle-v2/23-cumulative-visible-qualification-v8-final-full-20260901",
);
const CANDIDATE_ROOT = resolve(ROOT, "rendered-candidate");
const V1_PACK_PATH = resolve(
  "training/evaluation-cycle-v1/03-training-drafts/training-review-pack.json",
);
const V1_APPROVAL_PATH = resolve(
  "training/evaluation-cycle-v1/03-training-drafts/approved-training-manifest.json",
);
const V1_CONTAMINATION_PATH = resolve(
  "training/evaluation-cycle-v1/03-training-drafts/phase-5-contamination-report.json",
);
const V1_EXPORT_CONTRACT_PATH = resolve(
  "training/evaluation-cycle-v1/03-training-drafts/training-export-contract.json",
);
const V3_ROOT = resolve(
  process.env.TRAINING_REPAIR_V3_ROOT ||
    "training/evaluation-cycle-v2/22-training-data-double-check-v8-final-20260901",
);
const V3_PACK_PATH = resolve(V3_ROOT, "repaired-training-items-draft.json");
const V3_LOCAL_ALLOCATION_PATH = resolve(V3_ROOT, "global-allocation-draft.json");
const V3_PREFLIGHT_PATH = resolve(V3_ROOT, "integrity-and-review-preflight.json");
const MODEL_ROOT = resolve("models/mlx/Qwen3-8B-4bit");
const MODEL_REVISION = "545dc4251c05440727734bcd94334791f6ab0192";
const MODEL_TREE_PATH = resolve(
  MODEL_ROOT,
  `.cache/huggingface/trees/${MODEL_REVISION}.json`,
);
const MODEL_METADATA_PATH = resolve(
  MODEL_ROOT,
  ".cache/huggingface/download/model.safetensors.metadata",
);
const PYTHON = resolve(".training-venv/bin/python");
const CONFIG_PATH = resolve("training/cumulative_visible_mlx_config_v1.yaml");
const RUNNER_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisibleTrainMlxV1.mjs",
);
const PREPARE_PATH = resolve(
  "scripts/evaluationCycleV2CumulativeVisiblePrepareV1.mjs",
);

if (existsSync(ROOT) && readdirSync(ROOT).length) {
  throw new Error(`Versioned cumulative full qualification root is not empty: ${ROOT}`);
}

const readJsonWithBytes = (path) => {
  const bytes = readFileSync(path);
  return { bytes, sha256: contentHash(bytes), value: JSON.parse(bytes) };
};
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const hashLargeFile = (path) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
const slug = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unclassified";
const normalise = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/\{\{cite:[^}]+\}\}/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const citationIdsFromText = (value) => [
  ...new Set(
    [...String(value || "").matchAll(/\{\{cite:([^}]+)\}\}/g)].map(
      (match) => match[1],
    ),
  ),
];
const citeMarkers = (sourceIds) =>
  [...new Set(sourceIds)].map((sourceId) => `{{cite:${sourceId}}}`).join(" ");
const insertMappedCitationMarkers = (answer, propositionCandidates) => {
  const original = String(answer || "").trim();
  const insertions = [];
  for (const entry of propositionCandidates) {
    const proposition = String(entry.proposition || "");
    const start = original.indexOf(proposition);
    if (start < 0) {
      throw new Error(
        `Cannot place exact proposition citation marker; proposition is absent from answer: ${proposition}`,
      );
    }
    const sourceIds = [...new Set(entry.source_ids || [])];
    if (!sourceIds.length) continue;
    insertions.push({ offset: start + proposition.length, marker: citeMarkers(sourceIds) });
  }
  let rendered = original;
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    rendered = `${rendered.slice(0, insertion.offset)} ${insertion.marker}${rendered.slice(insertion.offset)}`;
  }
  return rendered.replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
};
const normaliseUrl = (value) =>
  value
    ? String(value).replace(/#.*$/, "").replace(/\/$/, "").toLowerCase()
    : null;
const sameSet = (left, right) => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
const sameOrderedUniqueValues = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === new Set(left).size &&
  right.length === new Set(right).size &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

for (const path of [
  V1_PACK_PATH,
  V1_APPROVAL_PATH,
  V1_CONTAMINATION_PATH,
  V1_EXPORT_CONTRACT_PATH,
  V3_PACK_PATH,
  V3_LOCAL_ALLOCATION_PATH,
  V3_PREFLIGHT_PATH,
  resolve(MODEL_ROOT, "model.safetensors"),
  resolve(MODEL_ROOT, "config.json"),
  resolve(MODEL_ROOT, "tokenizer.json"),
  MODEL_TREE_PATH,
  MODEL_METADATA_PATH,
  PYTHON,
  CONFIG_PATH,
  RUNNER_PATH,
  PREPARE_PATH,
]) {
  if (!existsSync(path)) throw new Error(`Cumulative qualification prerequisite is missing: ${path}`);
}

const v1PackFile = readJsonWithBytes(V1_PACK_PATH);
const v1ApprovalFile = readJsonWithBytes(V1_APPROVAL_PATH);
const v1ContaminationFile = readJsonWithBytes(V1_CONTAMINATION_PATH);
const v1ContractFile = readJsonWithBytes(V1_EXPORT_CONTRACT_PATH);
const v3PackFile = readJsonWithBytes(V3_PACK_PATH);
const v3LocalAllocationFile = readJsonWithBytes(V3_LOCAL_ALLOCATION_PATH);
const v3PreflightFile = readJsonWithBytes(V3_PREFLIGHT_PATH);
const v1Pack = v1PackFile.value;
const v1Approval = v1ApprovalFile.value;
const v1Contamination = v1ContaminationFile.value;
const v1Contract = v1ContractFile.value;
const v3Pack = v3PackFile.value;
const v3LocalAllocation = v3LocalAllocationFile.value;
const v3Preflight = v3PreflightFile.value;

const v1ApprovedById = new Map(
  (v1Approval.approved_items || []).map((item) => [item.training_id, item]),
);
const v1ApprovalChecks = {
  exact_42_items:
    v1Pack.items?.length === 42 &&
    v1ApprovedById.size === 42 &&
    v1Approval.approved_items?.length === 42,
  source_pack_hash_bound: v1Approval.source_pack?.sha256 === v1PackFile.sha256,
  contamination_hash_bound:
    v1Approval.contamination_report?.sha256 === v1ContaminationFile.sha256,
  contamination_record_passed:
    v1Approval.contamination_report?.status === "passed" &&
    v1Contamination.status === "passed",
  export_contract_hash_bound:
    v1Approval.export_contract?.sha256 === v1ContractFile.sha256,
  completion_target_isolated:
    v1Contract.completion_target_field === "ideal_answer" &&
    sameSet(v1Contract.allowed_completion_fields || [], ["ideal_answer"]),
  all_items_hash_bound: (v1Pack.items || []).every((item) => {
    const approved = v1ApprovedById.get(item.training_id);
    return (
      approved?.item_sha256 === contentHash(JSON.stringify(item)) &&
      approved.review_status === "approved_for_phase_6" &&
      item.human_review_status === "approved_for_phase_6" &&
      item.gold_similarity_check === "passed"
    );
  }),
  protected_assets_recorded_excluded:
    v1Approval.protected_evaluation_assets_excluded === true &&
    v1Approval.sealed_unseen_accessed === false,
};
if (!Object.values(v1ApprovalChecks).every(Boolean)) {
  throw new Error(`Historical v1 approval chain failed: ${JSON.stringify(v1ApprovalChecks)}`);
}

const v3InputChecks = {
  exact_52_items: v3Pack.item_count === 52 && v3Pack.items?.length === 52,
  wave_counts:
    v3Pack.items?.filter((item) => item.wave === 2).length === 33 &&
    v3Pack.items?.filter((item) => item.wave === 3).length === 19,
  items_hash_bound:
    v3Pack.items_sha256 === contentHash(JSON.stringify(v3Pack.items || [])),
  structural_preflight_hash_bound:
    v3Preflight.source_pack_sha256 === v3PackFile.sha256,
  structural_preflight_passed: v3Preflight.passed === true,
  review_only:
    v3Pack.training_authorised === false &&
    v3Pack.release_authorised === false &&
    v3Pack.unseen_included === false &&
    v3Pack.unseen_accessed === false,
  local_allocation_not_global:
    v3LocalAllocation.scope === "local_wave_2_3_visible_candidate_only" &&
    v3LocalAllocation.training_authorised === false,
};
if (!Object.values(v3InputChecks).every(Boolean)) {
  throw new Error(`Wave 2–3 repaired draft failed structural intake: ${JSON.stringify(v3InputChecks)}`);
}

const V1_CONSTRUCT_GROUPS = {
  "governance.trustee-knowledge-duty": ["train-cite-001"],
  "benefits.accrued-rights-modification": ["train-cite-002"],
  "governance.trustee-statutory-duty-of-care": ["train-cite-003"],
  "benefits.short-service-framework": ["train-cite-004"],
  "disputes.pensions-ombudsman-point-of-law-appeal": ["train-cite-005"],
  "equality.sex-equality-scheme-rule": ["train-cite-006"],
  "transfers.safeguarded-benefit-advice-boundary": ["train-cite-007"],
  "tax.annual-allowance-missing-operative-evidence": ["train-cite-008"],
  "equality.same-sex-survivor-pension": ["train-cite-009"],
  "governance.scheme-rule-construction": ["train-cite-010"],
  "evidence.case-facts-versus-holding": ["train-cite-011"],
  "governance.investment-principles": ["train-cite-012"],
  "jurisdiction.gb-versus-northern-ireland-routing": ["train-cite-013"],
  "evidence.party-submission-versus-holding": ["train-cite-014"],
  "evidence.factual-record-versus-legal-authority": ["train-cite-015"],
  "evidence.general-rule-and-specific-exception": ["train-cite-016"],
  "evidence.stale-guidance": ["train-cite-017"],
  "handoff.answer-supported-general-definition": ["train-cite-018"],
  "evidence.invented-citation-refusal": ["train-cite-019"],
  "security.untrusted-document-instruction": ["train-cite-020", "train-scam-020"],
  "evidence.title-only-support-mismatch": ["train-cite-021"],
  "scams.remote-access-request": ["train-scam-001"],
  "scams.secret-or-security-code-disclosure": ["train-scam-002", "train-scam-012"],
  "scams.blank-transfer-or-pension-form": ["train-scam-003", "train-scam-007"],
  "scams.deepfake-or-regulator-impersonation": ["train-scam-004"],
  "scams.payment-redirection-phishing": ["train-scam-005"],
  "scams.pension-tracing-credential-request": ["train-scam-006"],
  "scams.recovery-room-scam": ["train-scam-008"],
  "scams.qr-credential-phishing": ["train-scam-009"],
  "scams.lookalike-channel-and-login-approval": ["train-scam-010"],
  "scams.gift-card-payment": ["train-scam-011"],
  "scams.independent-fca-authorisation-check": ["train-scam-013"],
  "scams.avoid-routine-portal-false-positive": ["train-scam-014"],
  "transfers.due-diligence-general-explanation": ["train-scam-015"],
  "governance.investment-diversification": ["train-scam-016"],
  "scams.verified-provider-support-channel": ["train-scam-017"],
  "transfers.db-advice-boundary-not-automatic-scam": ["train-scam-018"],
  "scams.personal-information-does-not-prove-authority": ["train-scam-019"],
  "scams.relationship-does-not-displace-checks": ["train-scam-021"],
};
const v1ConstructById = {};
for (const [construct, ids] of Object.entries(V1_CONSTRUCT_GROUPS)) {
  for (const id of ids) {
    if (v1ConstructById[id]) throw new Error(`Duplicate v1 construct assignment: ${id}`);
    v1ConstructById[id] = construct;
  }
}
const v1Ids = (v1Pack.items || []).map((item) => item.training_id);
const unmappedV1 = v1Ids.filter((id) => !v1ConstructById[id]);
const extraV1Mappings = Object.keys(v1ConstructById).filter((id) => !v1Ids.includes(id));
if (unmappedV1.length || extraV1Mappings.length) {
  throw new Error(
    `Canonical v1 constructs are incomplete; missing=${unmappedV1.join(",")} extra=${extraV1Mappings.join(",")}`,
  );
}

const CROSS_CONSTRUCT_GROUPS = {
  "transfers.safeguarded-benefit-advice-boundary": [
    "train-cite-007",
    "train-scam-018",
    "v2-w2-t01-train-006",
  ],
  "tax.annual-allowance-operative-rules": [
    "train-cite-008",
    "v2-w3-t02-train-001",
    "v2-w3-t02-train-002",
    "v2r-w3-t02-train-001",
  ],
  "equality.same-sex-survivor-pension": [
    "train-cite-009",
    "v2-w2-t04-train-005",
  ],
  "governance.investment-principles-and-diversification": [
    "train-cite-012",
    "train-scam-016",
    "v2-w2-t02-train-005",
  ],
  "jurisdiction.northern-ireland-routing": [
    "train-cite-013",
    "v2-w2-t03-train-006",
    "v2-w2-t04-train-006",
  ],
  "security.untrusted-document-instruction": ["train-cite-020", "train-scam-020"],
};
const crossConstructById = {};
for (const [construct, ids] of Object.entries(CROSS_CONSTRUCT_GROUPS)) {
  for (const id of ids) crossConstructById[id] = construct;
}

const AUTHORITY_ALIASES = {
  "official-fca-authorisation-check": "official-fca-authorisation-register-check",
  "official-tpr-avoid-and-report-pension-scams":
    "official-tpr-avoid-and-report-pension-scams",
};
function v1AuthorityFamily(source) {
  const title = `${source.citation_metadata?.title || ""} ${source.title || ""}`;
  const tests = [
    [/Pensions Act 2004/i, "official-pensions-act-2004"],
    [/Pensions Act 1995/i, "official-pensions-act-1995"],
    [/Pension Schemes Act 1993/i, "official-pension-schemes-act-1993"],
    [/Pension Schemes Act 2015/i, "official-pension-schemes-act-2015"],
    [/Trustee Act 2000/i, "official-trustee-act-2000"],
    [/Equality Act 2010/i, "official-equality-act-2010"],
    [/Finance Act 2004/i, "official-finance-act-2004"],
    [/Walker v Innospec/i, "official-uksc-walker-v-innospec-2017-uksc-47"],
    [/Barnardo'?s v Buckinghamshire/i, "official-uksc-barnardos-v-buckinghamshire-2018"],
    [/FCA Firm Checker/i, "official-fca-authorisation-register-check"],
    [/Avoid and report pension scams/i, "official-tpr-avoid-and-report-pension-scams"],
  ];
  return tests.find(([pattern]) => pattern.test(title))?.[1] || `v1-${slug(source.title)}`;
}
const canonicalAuthority = (source, cohort) => {
  const family =
    cohort === "v1" ? v1AuthorityFamily(source) : source.authority_family;
  return AUTHORITY_ALIASES[family] || family;
};

function normaliseV1Item(item) {
  const canonicalConstruct =
    crossConstructById[item.training_id] || v1ConstructById[item.training_id];
  return {
    training_id: item.training_id,
    cohort: "v1",
    wave: 1,
    topic:
      item.failure_cluster === "citation_and_evidence_discipline"
        ? "v1.evidence-and-citation-discipline"
        : "v1.transfer-and-scam-safety",
    canonical_construct: canonicalConstruct,
    original_construct: item.capability,
    user_question: item.user_question,
    question_sha256: contentHash(item.user_question),
    ideal_answer: item.ideal_answer,
    target_answer: String(item.ideal_answer || "").trim(),
    target_citation_ids: citationIdsFromText(item.ideal_answer),
    target_citation_basis: "historical_v1_hash_approved_inline_tokens",
    unmapped_material_propositions: [],
    response_route: item.response_route,
    handoff_required: item.handoff_required,
    action_allowed: item.action_allowed,
    conversation_context: item.conversation_context || [],
    synthetic_fixture: item.synthetic_fixture,
    retrieved_evidence: (item.retrieved_evidence || []).map((source) => ({
      source_id: source.source_id,
      title: source.title,
      section: source.citation_metadata?.pinpoint || null,
      jurisdiction: source.jurisdiction,
      source_role: source.source_role,
      source_url: source.canonical_url || null,
      authority_family: canonicalAuthority(source, "v1"),
      text: source.text,
      content_sha256: contentHash(source.text),
      recorded_snapshot_hash: source.snapshot_hash || null,
      source_snapshot_as_of: source.effective_date || null,
      citation_metadata: source.citation_metadata,
      user_visible: source.citation_metadata?.user_visible !== false,
      source_metadata_provenance: "historical_v1_approved_record_normalised_for_cumulative_graph",
    })),
    source_item_sha256: contentHash(JSON.stringify(item)),
    approval_status: "historical_v1_item_hash_approved",
    training_authorised_in_this_qualification: false,
  };
}

function normaliseV3Item(item) {
  const canonicalConstruct =
    crossConstructById[item.training_id] ||
    v3LocalAllocation.semantic_rule_overrides?.[item.training_id] ||
    item.legal_rule_id ||
    item.construct_id;
  const topicParts = String(item.construct_id || "").split(".");
  const propositionCandidates = Array.isArray(item.proposition_source_candidates)
    ? item.proposition_source_candidates
    : [];
  const targetAnswer = insertMappedCitationMarkers(
    item.ideal_answer,
    propositionCandidates,
  );
  const mappedCitationIds = citationIdsFromText(targetAnswer);
  const unmappedMaterialPropositions = propositionCandidates
    .filter(
      (entry) =>
        !Array.isArray(entry.source_ids) || !entry.source_ids.length,
    )
    .map((entry) => entry.proposition);
  return {
    training_id: item.training_id,
    cohort: item.wave === 2 ? "wave_2" : "wave_3",
    wave: item.wave,
    topic: topicParts.slice(0, 2).join(".") || `wave-${item.wave}.unclassified`,
    canonical_construct: canonicalConstruct,
    original_construct: item.construct_id,
    user_question: item.user_question,
    question_sha256: item.question_sha256,
    ideal_answer: item.ideal_answer,
    target_answer: targetAnswer,
    target_citation_ids: mappedCitationIds,
    target_citation_basis:
      "owner_authorised_development_candidate_from_frozen_proposition_source_map_not_independent_support_review",
    unmapped_material_propositions: unmappedMaterialPropositions,
    response_route: null,
    handoff_required: null,
    action_allowed: false,
    conversation_context: [],
    synthetic_fixture: { synthetic: true, contains_real_user_data: false },
    retrieved_evidence: (item.retrieved_evidence || []).map((source) => ({
      ...source,
      authority_family: canonicalAuthority(source, "v3"),
      content_sha256: contentHash(source.text),
      user_visible: !["system_policy", "internal_hidden"].includes(source.source_role),
    })),
    proposition_source_candidates: propositionCandidates,
    source_item_sha256: contentHash(JSON.stringify(item)),
    approval_status: "pending_independent_legal_proposition_and_citation_review",
    training_authorised_in_this_qualification: false,
  };
}

const items = [
  ...(v1Pack.items || []).map(normaliseV1Item),
  ...(v3Pack.items || []).map(normaliseV3Item),
];
const itemIds = items.map((item) => item.training_id);
if (items.length !== 94 || new Set(itemIds).size !== 94) {
  throw new Error(`Cumulative visible register must contain 94 unique records; got ${items.length}/${new Set(itemIds).size}`);
}

const sourceIdentityConflicts = [];
const sourceById = new Map();
for (const item of items) {
  for (const source of item.retrieved_evidence) {
    const identity = JSON.stringify({
      content_sha256: source.content_sha256,
      authority_family: source.authority_family,
      source_url: normaliseUrl(source.source_url),
      title: source.title,
      section: source.section,
      jurisdiction: source.jurisdiction,
      source_role: source.source_role,
      source_snapshot_as_of: source.source_snapshot_as_of,
      provision_effective_from: source.provision_effective_from || null,
      provision_status: source.provision_status || null,
      territorial_effective_dates: source.territorial_effective_dates || null,
      oscola_citation: source.oscola_citation || null,
      text_origin: source.text_origin || null,
      citation_metadata: source.citation_metadata || null,
      recorded_snapshot_hash: source.recorded_snapshot_hash || null,
      user_visible: source.user_visible,
    });
    if (!sourceById.has(source.source_id)) {
      sourceById.set(source.source_id, { source, identity, used_by: [item.training_id] });
    } else {
      const existing = sourceById.get(source.source_id);
      existing.used_by.push(item.training_id);
      if (existing.identity !== identity) {
        sourceIdentityConflicts.push({
          source_id: source.source_id,
          type: "same_source_id_conflicting_identity",
          used_by: existing.used_by,
        });
      }
    }
  }
}
if (sourceIdentityConflicts.length) {
  throw new Error(`Visible source identities conflict: ${JSON.stringify(sourceIdentityConflicts)}`);
}

const graphValues = (item) =>
  new Set(
    [
      item.canonical_construct && `construct:${item.canonical_construct}`,
      ...item.retrieved_evidence.flatMap((source) => [
        source.source_id && `source:${source.source_id}`,
        source.content_sha256 && `text:${source.content_sha256}`,
        source.authority_family && `authority:${source.authority_family}`,
        normaliseUrl(source.source_url) && `url:${normaliseUrl(source.source_url)}`,
      ]),
    ].filter(Boolean),
  );
const parent = new Map(items.map((item) => [item.training_id, item.training_id]));
const find = (id) => {
  const current = parent.get(id);
  if (current === id) return id;
  const root = find(current);
  parent.set(id, root);
  return root;
};
const union = (left, right) => {
  const a = find(left);
  const b = find(right);
  if (a !== b) parent.set(b, a);
};
const ownerByValue = new Map();
for (const item of items) {
  for (const value of graphValues(item)) {
    if (ownerByValue.has(value)) union(item.training_id, ownerByValue.get(value));
    else ownerByValue.set(value, item.training_id);
  }
}
const grouped = new Map();
for (const item of items) {
  const root = find(item.training_id);
  if (!grouped.has(root)) grouped.set(root, []);
  grouped.get(root).push(item);
}
const topics = [...new Set(items.map((item) => item.topic))].sort();
const topicBits = new Map(topics.map((topic, index) => [topic, 1n << BigInt(index)]));
const components = [...grouped.values()]
  .map((componentItems) => {
    const sortedItems = componentItems.sort((a, b) =>
      a.training_id.localeCompare(b.training_id),
    );
    const values = new Set(sortedItems.flatMap((item) => [...graphValues(item)]));
    return {
      items: sortedItems,
      size: sortedItems.length,
      v1: sortedItems.filter((item) => item.cohort === "v1").length,
      wave_2: sortedItems.filter((item) => item.cohort === "wave_2").length,
      wave_3: sortedItems.filter((item) => item.cohort === "wave_3").length,
      topic_mask: sortedItems.reduce(
        (mask, item) => mask | topicBits.get(item.topic),
        0n,
      ),
      topics: [...new Set(sortedItems.map((item) => item.topic))].sort(),
      graph_values: [...values].sort(),
    };
  })
  .sort(
    (a, b) =>
      a.size - b.size || a.items[0].training_id.localeCompare(b.items[0].training_id),
  );

let choices = new Map([["0:0:0:0:0", []]]);
for (const component of components) {
  const next = new Map(choices);
  for (const [key, selected] of choices) {
    const [total, v1, wave2, wave3, maskText] = key.split(":");
    const nextTotal = Number(total) + component.size;
    if (nextTotal > 18) continue;
    const nextMask = BigInt(maskText) | component.topic_mask;
    const nextKey = `${nextTotal}:${Number(v1) + component.v1}:${Number(wave2) + component.wave_2}:${Number(wave3) + component.wave_3}:${nextMask}`;
    const candidate = [...selected, component];
    const signature = candidate
      .flatMap((entry) => entry.items.map((item) => item.training_id))
      .sort()
      .join("|");
    const existing = next.get(nextKey);
    const existingSignature = existing
      ?.flatMap((entry) => entry.items.map((item) => item.training_id))
      .sort()
      .join("|");
    if (!existing || signature.localeCompare(existingSignature) < 0) {
      next.set(nextKey, candidate);
    }
  }
  choices = next;
}
const bitCount = (value) => {
  let count = 0;
  for (let mask = value; mask; mask >>= 1n) count += Number(mask & 1n);
  return count;
};
const cohortDeviation = (candidate) =>
  Math.abs(candidate.v1 * 94 - candidate.total * 42) +
  Math.abs(candidate.wave_2 * 94 - candidate.total * 33) +
  Math.abs(candidate.wave_3 * 94 - candidate.total * 19);
const candidates = [...choices.entries()]
  .map(([key, selected]) => {
    const [total, v1, wave2, wave3, maskText] = key.split(":");
    return {
      selected,
      total: Number(total),
      v1: Number(v1),
      wave_2: Number(wave2),
      wave_3: Number(wave3),
      topic_mask: BigInt(maskText),
      signature: selected
        .flatMap((entry) => entry.items.map((item) => item.training_id))
        .sort()
        .join("|"),
    };
  })
  .filter(
    (candidate) =>
      candidate.total >= 14 &&
      candidate.total <= 18 &&
      candidate.v1 > 0 &&
      candidate.wave_2 > 0 &&
      candidate.wave_3 > 0,
  )
  .sort(
    (a, b) =>
      bitCount(b.topic_mask) - bitCount(a.topic_mask) ||
      cohortDeviation(a) - cohortDeviation(b) ||
      Math.abs(a.total - 16) - Math.abs(b.total - 16) ||
      a.signature.localeCompare(b.signature),
  );
if (!candidates.length) {
  throw new Error(
    `No globally source/authority/construct-isolated 14–18 item visible validation split is feasible; component sizes=${components.map((component) => component.size).join(",")}`,
  );
}
const selected = candidates[0];
const validationIds = new Set(
  selected.selected.flatMap((component) =>
    component.items.map((item) => item.training_id),
  ),
);
const trainItems = items.filter((item) => !validationIds.has(item.training_id));
const validationItems = items.filter((item) => validationIds.has(item.training_id));
const isolation = auditTrainingPartitionIsolation(
  trainItems.map((item) => ({
    ...item,
    construct_id: item.canonical_construct,
  })),
  validationItems.map((item) => ({
    ...item,
    construct_id: item.canonical_construct,
  })),
);
const trainUrls = new Set(
  trainItems.flatMap((item) =>
    item.retrieved_evidence.map((source) => normaliseUrl(source.source_url)).filter(Boolean),
  ),
);
const urlOverlap = [
  ...new Set(
    validationItems.flatMap((item) =>
      item.retrieved_evidence
        .map((source) => normaliseUrl(source.source_url))
        .filter((url) => url && trainUrls.has(url)),
    ),
  ),
];
if (!isolation.passed || urlOverlap.length) {
  throw new Error(
    `Global visible allocation failed isolation: ${JSON.stringify({ isolation, urlOverlap })}`,
  );
}

const systemBase = [
  "You are a read-only UK pensions assistant.",
  "Answer only from the supplied synthetic fixture and evidence. Never invent facts, dates, figures, law, citations, actions or tool results.",
  "Return exactly one JSON object with fields answer and citation_ids. Put a live inline citation marker after each supported proposition in answer and mirror exactly the marker source IDs in citation_ids. Use only supplied source_id values; do not create IDs.",
  "If evidence is missing, stale, conflicting or from the wrong jurisdiction, say what is missing and use the required clarification or human-review route.",
  "Never provide personalised DB-transfer or investment recommendations and never claim to transfer funds, submit forms, call, refresh or change records.",
].join(" ");
function renderRow(item) {
  const internalControls = item.retrieved_evidence
    .filter(
      (source) =>
        source.user_visible === false ||
        ["system_policy", "internal_hidden"].includes(source.source_role),
    )
    .map((source) => source.text);
  const evidence = item.retrieved_evidence
    .filter(
      (source) =>
        source.user_visible !== false &&
        !["system_policy", "internal_hidden"].includes(source.source_role),
    )
    .map((source) => ({
      source_id: source.source_id,
      source_role: source.source_role,
      jurisdiction: source.jurisdiction,
      authority_family: source.authority_family,
      text: source.text,
    }));
  const prompt = {
    question: item.user_question,
    conversation_context: item.conversation_context,
    synthetic_fixture: item.synthetic_fixture,
    evidence,
    response_route: item.response_route,
    handoff_required: item.handoff_required,
    action_allowed: item.action_allowed,
  };
  return {
    messages: [
      {
        role: "system",
        content: [
          systemBase,
          ...internalControls.map((control) => `Internal control: ${control}`),
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify(prompt) },
      {
        role: "assistant",
        content: JSON.stringify({
          answer: item.target_answer,
          citation_ids: item.target_citation_ids,
        }),
      },
    ],
    metadata: {
      training_id: item.training_id,
      cohort: item.cohort,
      topic: item.topic,
      canonical_construct: item.canonical_construct,
      completion_target_field: "ideal_answer",
      completion_target_contract:
        "json_answer_with_inline_markers_and_exact_mirrored_citation_ids",
      source_item_sha256: item.source_item_sha256,
      source_approval_status: item.approval_status,
      review_only_candidate: true,
      training_authorised: false,
    },
  };
}
const trainRows = trainItems.map(renderRow);
const validationRows = validationItems.map(renderRow);
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const trainJsonl = jsonl(trainRows);
const validationJsonl = jsonl(validationRows);
const echoAudit = auditTrainingRows([...trainRows, ...validationRows]);
const trainQuestions = new Set(trainItems.map((item) => normalise(item.user_question)));
const trainAnswers = new Set(trainItems.map((item) => normalise(item.target_answer)));
const crossPartitionQuestionDuplicates = validationItems
  .filter((item) => trainQuestions.has(normalise(item.user_question)))
  .map((item) => item.training_id);
const crossPartitionAnswerDuplicates = validationItems
  .filter((item) => trainAnswers.has(normalise(item.target_answer)))
  .map((item) => item.training_id);
const answerInQuestion = items
  .filter((item) => {
    const answer = normalise(item.target_answer);
    return answer.split(" ").length >= 12 && normalise(item.user_question).includes(answer);
  })
  .map((item) => item.training_id);
const jsonTargetChecks = [...trainRows, ...validationRows].map((row) => {
  const id = row.metadata.training_id;
  const item = items.find((candidate) => candidate.training_id === id);
  const evidenceIds = new Set(
    item.retrieved_evidence
      .filter(
        (source) =>
          source.user_visible !== false &&
          !["system_policy", "internal_hidden"].includes(source.source_role),
      )
      .map((source) => source.source_id),
  );
  let target;
  try {
    target = JSON.parse(row.messages.at(-1).content);
  } catch {
    target = null;
  }
  const exactKeys = target
    ? Object.keys(target).sort().join(",") === "answer,citation_ids"
    : false;
  const markerIds = target ? citationIdsFromText(target.answer) : [];
  const promptContainsCitationMarkers = row.messages
    .slice(0, -1)
    .some((message) => /\{\{cite:[^}]+\}\}/.test(message.content));
  const matchesFrozenItemMapping =
    target &&
    sameOrderedUniqueValues(
      target.citation_ids || [],
      item.target_citation_ids,
    );
  const markersMirrorCitationIds =
    target && sameOrderedUniqueValues(markerIds, target.citation_ids || []);
  return {
    training_id: id,
    passed:
      exactKeys &&
      typeof target.answer === "string" &&
      target.answer.trim().length > 0 &&
      Array.isArray(target.citation_ids) &&
      target.citation_ids.length === new Set(target.citation_ids).size &&
      target.citation_ids.every((sourceId) => evidenceIds.has(sourceId)) &&
      markersMirrorCitationIds &&
      matchesFrozenItemMapping &&
      !promptContainsCitationMarkers &&
      item.unmapped_material_propositions.length === 0,
    exact_keys: exactKeys,
    matches_frozen_item_mapping: matchesFrozenItemMapping,
    inline_marker_ids: markerIds,
    inline_markers_mirror_citation_ids: markersMirrorCitationIds,
    prompt_and_evidence_contain_no_citation_markers: !promptContainsCitationMarkers,
    citation_ids: target?.citation_ids || [],
    unmapped_material_propositions: item.unmapped_material_propositions,
  };
});
const citationCounts = {
  v1_targets_with_citation_ids: items.filter(
    (item) => item.cohort === "v1" && item.target_citation_ids.length,
  ).length,
  repaired_wave_2_3_targets_with_citation_ids: items.filter(
    (item) => item.cohort !== "v1" && item.target_citation_ids.length,
  ).length,
  repaired_wave_2_3_unmapped_propositions: items
    .filter((item) => item.cohort !== "v1")
    .reduce((count, item) => count + item.unmapped_material_propositions.length, 0),
};
const contaminationPassed =
  echoAudit.passed &&
  crossPartitionQuestionDuplicates.length === 0 &&
  crossPartitionAnswerDuplicates.length === 0 &&
  answerInQuestion.length === 0 &&
  jsonTargetChecks.every((check) => check.passed) &&
  isolation.passed &&
  urlOverlap.length === 0;

mkdirSync(CANDIDATE_ROOT, { recursive: true });
writeText(resolve(CANDIDATE_ROOT, "train.review.jsonl"), trainJsonl);
writeText(resolve(CANDIDATE_ROOT, "valid.review.jsonl"), validationJsonl);

const itemRegister = {
  version: "cumulative-visible-item-register-v1",
  generated_at: new Date().toISOString(),
  status: "review_only_candidate_not_training_approved",
  training_authorised: false,
  release_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  counts: { total: 94, v1: 42, wave_2: 33, wave_3: 19 },
  input_hashes: {
    v1_pack: v1PackFile.sha256,
    v1_approval: v1ApprovalFile.sha256,
    v1_contamination: v1ContaminationFile.sha256,
    v1_export_contract: v1ContractFile.sha256,
    repaired_wave_2_3_pack: v3PackFile.sha256,
    repaired_wave_2_3_local_allocation: v3LocalAllocationFile.sha256,
    repaired_wave_2_3_preflight: v3PreflightFile.sha256,
  },
  v1_approval_checks: v1ApprovalChecks,
  repaired_wave_2_3_intake_checks: v3InputChecks,
  canonical_construct_overrides: {
    v1: v1ConstructById,
    cross_history: crossConstructById,
    repaired_wave_2_3_local: v3LocalAllocation.semantic_rule_overrides,
  },
  items,
};
writeJson(resolve(ROOT, "cumulative-visible-item-register.json"), itemRegister);
const itemRegisterBytes = readFileSync(resolve(ROOT, "cumulative-visible-item-register.json"));

const sourceRegister = {
  version: "cumulative-visible-source-register-v1",
  generated_at: new Date().toISOString(),
  status: "mechanically_normalised_pending_independent_semantic_review",
  item_register_sha256: contentHash(itemRegisterBytes),
  source_occurrences: items.reduce(
    (count, item) => count + item.retrieved_evidence.length,
    0,
  ),
  unique_source_ids: sourceById.size,
  identity_conflicts: sourceIdentityConflicts,
  sources: [...sourceById.entries()]
    .map(([sourceId, entry]) => ({
      source_id: sourceId,
      authority_family: entry.source.authority_family,
      title: entry.source.title,
      section: entry.source.section,
      jurisdiction: entry.source.jurisdiction,
      source_role: entry.source.source_role,
      source_url: entry.source.source_url,
      source_snapshot_as_of: entry.source.source_snapshot_as_of,
      content_sha256: entry.source.content_sha256,
      recorded_snapshot_hash: entry.source.recorded_snapshot_hash || null,
      used_by: [...new Set(entry.used_by)].sort(),
    }))
    .sort((a, b) => a.source_id.localeCompare(b.source_id)),
  note:
    "Historical v1 recorded_snapshot_hash values are retained as historical snapshot identifiers. content_sha256 is separately computed over the exact passage rendered into this candidate.",
};
writeJson(resolve(ROOT, "cumulative-visible-source-register.json"), sourceRegister);
const sourceRegisterBytes = readFileSync(resolve(ROOT, "cumulative-visible-source-register.json"));

const validationTopics = [...new Set(validationItems.map((item) => item.topic))].sort();
const allocation = {
  version: "cumulative-visible-global-allocation-draft-v1",
  generated_at: new Date().toISOString(),
  status: "globally_computed_across_94_visible_records_pending_independent_semantic_and_custodian_approval",
  scope: "all_94_visible_v1_wave2_wave3_candidate_records",
  training_authorised: false,
  release_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  item_register_sha256: contentHash(itemRegisterBytes),
  source_register_sha256: contentHash(sourceRegisterBytes),
  train: { count: trainItems.length, ids: trainItems.map((item) => item.training_id) },
  validation: {
    count: validationItems.length,
    ids: validationItems.map((item) => item.training_id),
  },
  validation_cohorts: {
    v1: validationItems.filter((item) => item.cohort === "v1").length,
    wave_2: validationItems.filter((item) => item.cohort === "wave_2").length,
    wave_3: validationItems.filter((item) => item.cohort === "wave_3").length,
  },
  selection_objective: [
    "maximise_visible_topic_coverage",
    "minimise_deviation_from_42_33_19_cohort_proportions",
    "prefer_16_validation_records_within_14_to_18",
    "deterministic_training_id_tiebreak",
  ],
  topic_coverage: {
    available: topics,
    validation: validationTopics,
    missing: topics.filter((topic) => !validationTopics.includes(topic)),
    count: validationTopics.length,
    available_count: topics.length,
  },
  canonical_construct_groups: {
    v1: V1_CONSTRUCT_GROUPS,
    cross_history: CROSS_CONSTRUCT_GROUPS,
    repaired_wave_2_3_local: v3LocalAllocation.semantic_rule_overrides,
  },
  components: components.map((component) => ({
    size: component.size,
    cohorts: {
      v1: component.v1,
      wave_2: component.wave_2,
      wave_3: component.wave_3,
    },
    topics: component.topics,
    ids: component.items.map((item) => item.training_id),
    graph_values: component.graph_values,
  })),
  isolation: {
    ...isolation,
    canonical_url_overlap: urlOverlap,
    graph_fields: [
      "canonical_construct",
      "source_id",
      "exact_passage_content_sha256",
      "canonical_authority_family",
      "canonical_source_url",
    ],
  },
  limitation:
    "The allocation is global only across the 94 visible candidate records. Its semantic group map still requires independent review, and protected regression/sealed-unseen construct comparison remains exclusively with the authorised custodian.",
};
writeJson(resolve(ROOT, "global-visible-allocation-draft.json"), allocation);
const allocationBytes = readFileSync(resolve(ROOT, "global-visible-allocation-draft.json"));

const maximumValidationTopicCount = Math.max(
  ...candidates.map((candidate) => bitCount(candidate.topic_mask)),
);
const selectedMissingTopicAnalysis = allocation.topic_coverage.missing.map(
  (topic) => {
    const bit = topicBits.get(topic);
    const containingComponents = components
      .map((component, index) => ({ component, index: index + 1 }))
      .filter(({ component }) => component.topics.includes(topic));
    const feasibleStateCount = candidates.filter(
      (candidate) => (candidate.topic_mask & bit) !== 0n,
    ).length;
    const onlyComponent =
      containingComponents.length === 1 ? containingComponents[0] : null;
    return {
      topic,
      feasible_state_count_with_topic: feasibleStateCount,
      only_component_index: onlyComponent?.index ?? null,
      component_size:
        onlyComponent?.component.size ??
        Math.min(...containingComponents.map(({ component }) => component.size)),
      component_indexes: containingComponents.map(({ index }) => index),
      component_sizes: containingComponents.map(({ component }) => component.size),
      topic_record_ids: items
        .filter((item) => item.topic === topic)
        .map((item) => item.training_id)
        .sort(),
      reason:
        feasibleStateCount === 0 && onlyComponent
          ? `Every visible record for this topic belongs to one ${onlyComponent.component.size}-record connected isolation component; holding out any of them requires holding out all ${onlyComponent.component.size}, exceeding the frozen 18-record validation maximum.`
          : feasibleStateCount === 0
            ? "No 14-to-18-record globally isolated validation state containing this topic also represents all three visible cohorts."
            : "At least one feasible validation state contains this topic, so its absence from the deterministic selected split is not individually unavoidable.",
    };
  },
);
const unavoidablyAbsentTopics = selectedMissingTopicAnalysis.filter(
  (entry) => entry.feasible_state_count_with_topic === 0,
);
const avoidableSelectionGaps = selectedMissingTopicAnalysis.filter(
  (entry) => entry.feasible_state_count_with_topic > 0,
);
const topicFeasibilityPassed =
  maximumValidationTopicCount === allocation.topic_coverage.count &&
  avoidableSelectionGaps.length === 0;
const topicFeasibility = {
  version: "cumulative-visible-topic-coverage-feasibility-v1",
  generated_at: new Date().toISOString(),
  status: topicFeasibilityPassed
    ? "mechanically_proved_maximum_topic_coverage_under_frozen_isolation_constraints"
    : "selected_split_has_unproved_or_avoidable_topic_coverage_gap",
  passed: topicFeasibilityPassed,
  training_authorised: false,
  release_authorised: false,
  independent_legal_review: false,
  unseen_accessed: false,
  bindings: {
    item_register_sha256: contentHash(itemRegisterBytes),
    source_register_sha256: contentHash(sourceRegisterBytes),
    global_allocation_sha256: contentHash(allocationBytes),
    qualification_builder_path: PREPARE_PATH,
    qualification_builder_sha256: contentHash(readFileSync(PREPARE_PATH)),
  },
  constraints: {
    visible_record_count: items.length,
    validation_minimum: 14,
    validation_maximum: 18,
    each_cohort_required: true,
    component_graph_fields: allocation.isolation.graph_fields,
    component_count: components.length,
  },
  exhaustive_dynamic_programming_result: {
    reachable_aggregate_states_at_or_below_18_records: choices.size,
    feasible_states_with_14_to_18_records_and_all_three_cohorts:
      candidates.length,
    available_topic_count: topics.length,
    maximum_validation_topic_count: maximumValidationTopicCount,
    selected_validation_topic_count: allocation.topic_coverage.count,
    all_topics_feasible_together: candidates.some(
      (candidate) => bitCount(candidate.topic_mask) === topics.length,
    ),
    all_11_topics_feasible:
      topics.length === 11 &&
      candidates.some((candidate) => bitCount(candidate.topic_mask) === 11),
  },
  unavoidably_absent_topics: unavoidablyAbsentTopics,
  avoidable_selected_split_gaps: avoidableSelectionGaps,
  conclusion: topicFeasibilityPassed
    ? `The selected ${allocation.validation.count}-record validation allocation attains the provable maximum of ${maximumValidationTopicCount} of ${topics.length} visible topic groups under the frozen construct/source/text/authority/URL component-isolation policy. Every selected missing topic is absent from every feasible 14-to-18-record, three-cohort validation state.`
    : "The selected validation split does not yet prove that every omitted topic is unavoidable. Reallocate or document an explicit owner choice before compact export.",
};
writeJson(
  resolve(
    ROOT,
    "independent-agent-audits/global-visible-topic-coverage-feasibility.json",
  ),
  topicFeasibility,
);
writeText(
  resolve(
    ROOT,
    "independent-agent-audits/GLOBAL-VISIBLE-TOPIC-COVERAGE-FEASIBILITY.md",
  ),
  `# Global visible validation-topic feasibility\n\nThe frozen ${items.length}-record allocation has **${allocation.train.count} training / ${allocation.validation.count} validation** records and covers **${allocation.topic_coverage.count} of ${topics.length}** visible topic groups in validation. The exhaustive aggregate-state search found ${choices.size.toLocaleString("en-GB")} reachable states at or below 18 records and ${candidates.length.toLocaleString("en-GB")} states satisfying the 14–18 range with all three cohorts represented. The provable maximum is ${maximumValidationTopicCount} topics.\n\nUnavoidably absent topics: ${unavoidablyAbsentTopics.map((entry) => entry.topic).join(", ") || "none"}. Avoidable selected-split gaps: ${avoidableSelectionGaps.map((entry) => entry.topic).join(", ") || "none"}.\n\nThe result is mechanically bound to item register \`${contentHash(itemRegisterBytes)}\`, source register \`${contentHash(sourceRegisterBytes)}\`, allocation \`${contentHash(allocationBytes)}\`, and qualification builder \`${contentHash(readFileSync(PREPARE_PATH))}\`. It does not authorise training, release, or unseen access.\n`,
);
if (!topicFeasibilityPassed) {
  throw new Error(
    `Selected global allocation has avoidable or unproved topic gaps: ${JSON.stringify(avoidableSelectionGaps)}`,
  );
}

const contaminationReport = {
  version: "cumulative-visible-contamination-and-echo-preflight-v1",
  generated_at: new Date().toISOString(),
  status: contaminationPassed
    ? "mechanical_visible_preflight_passed_external_checks_pending"
    : "mechanical_visible_preflight_failed",
  passed: contaminationPassed,
  scope: "94_visible_training_candidates_only",
  training_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  item_register_sha256: contentHash(itemRegisterBytes),
  allocation_sha256: contentHash(allocationBytes),
  answer_input_echo: echoAudit,
  cross_partition_question_duplicates: crossPartitionQuestionDuplicates,
  cross_partition_answer_duplicates: crossPartitionAnswerDuplicates,
  answer_verbatim_in_question: answerInQuestion,
  partition_isolation: allocation.isolation,
  source_identity_conflicts: sourceIdentityConflicts,
  citation_counts: citationCounts,
  json_target_contract_checks: jsonTargetChecks,
  citation_gate:
    "Targets use the live JSON {answer,citation_ids} contract: answer retains inline citation markers and citation_ids mirrors exactly those marker IDs; citation markers are absent from prompts and evidence. Wave 2–3 IDs come from the frozen proposition-source candidate map under owner development authorisation; they are not represented as independent legal support approval.",
  protected_comparison:
    "Not performed here. The authorised custodian must compare protected regression and sealed-unseen constructs without exposing their questions or answers.",
};
writeJson(resolve(ROOT, "contamination-and-echo-preflight.json"), contaminationReport);
const contaminationBytes = readFileSync(resolve(ROOT, "contamination-and-echo-preflight.json"));

const candidateManifest = {
  version: "cumulative-visible-rendered-review-candidate-v1",
  generated_at: new Date().toISOString(),
  status: "review_only_non_trainable_candidate",
  training_authorised: false,
  final_mlx_filenames_present: false,
  completion_target_field: "ideal_answer",
  completion_target_contract:
    "json_answer_with_inline_markers_and_exact_mirrored_citation_ids",
  item_register_sha256: contentHash(itemRegisterBytes),
  allocation_sha256: contentHash(allocationBytes),
  contamination_preflight_sha256: contentHash(contaminationBytes),
  train: {
    count: trainRows.length,
    filename: "train.review.jsonl",
    sha256: contentHash(trainJsonl),
  },
  validation: {
    count: validationRows.length,
    filename: "valid.review.jsonl",
    sha256: contentHash(validationJsonl),
  },
  blocked_final_files: ["train.jsonl", "valid.jsonl", "dataset-manifest.json"],
  reason:
    "This rendering exists only for exact live-contract prompt, token-length and loss-mask inspection. Wave 2–3 mappings are owner-authorised development candidates, not independent legal approval, and these filenames cannot be passed directly to MLX-LM.",
};
writeJson(resolve(CANDIDATE_ROOT, "candidate-manifest.json"), candidateManifest);

const modelTree = JSON.parse(readFileSync(MODEL_TREE_PATH));
const recordedModelRevision = readFileSync(MODEL_METADATA_PATH, "utf8")
  .split(/\r?\n/)[0]
  .trim();
const modelPath = resolve(MODEL_ROOT, "model.safetensors");
const modelSha256 = await hashLargeFile(modelPath);
const packageResult = spawnSync(
  PYTHON,
  [
    "-c",
    "import importlib.metadata as m,json,platform; print(json.dumps({'python':platform.python_version(),'mlx_lm':m.version('mlx-lm'),'mlx':m.version('mlx'),'transformers':m.version('transformers')}))",
  ],
  { encoding: "utf8" },
);
if (packageResult.status !== 0) {
  throw new Error(`Could not inspect pinned training runtime: ${packageResult.stderr}`);
}
const packages = JSON.parse(packageResult.stdout);
const configText = readFileSync(CONFIG_PATH, "utf8");
const maxSequenceLength = Number(
  configText.match(/^max_seq_length:\s*(\d+)\s*$/m)?.[1],
);
const provenanceChecks = {
  revision_metadata_matches: recordedModelRevision === MODEL_REVISION,
  revision_tree_present: existsSync(MODEL_TREE_PATH),
  model_size_matches_tree:
    statSync(modelPath).size === modelTree.files?.["model.safetensors"]?.lfs_size,
  model_sha256_matches_tree:
    modelSha256 === modelTree.files?.["model.safetensors"]?.lfs_sha256,
  tokenizer_sha256_matches_tree:
    contentHash(readFileSync(resolve(MODEL_ROOT, "tokenizer.json"))) ===
    modelTree.files?.["tokenizer.json"]?.lfs_sha256,
  mask_prompt_enabled: /^mask_prompt:\s*true\s*$/m.test(configText),
  max_sequence_length_recorded: Number.isInteger(maxSequenceLength),
  clean_base_contains_no_adapter_files:
    !existsSync(resolve(MODEL_ROOT, "adapters.safetensors")) &&
    !existsSync(resolve(MODEL_ROOT, "adapter_config.json")),
  runner_declares_no_resume_adapter:
    !/resume-adapter|resume_adapter/i.test(readFileSync(RUNNER_PATH, "utf8")),
};
const provenancePassed = Object.values(provenanceChecks).every(Boolean);
const provenance = {
  version: "cumulative-visible-clean-checkpoint-provenance-v1",
  generated_at: new Date().toISOString(),
  status: provenancePassed
    ? "clean_base_checkpoint_identity_verified_training_not_started"
    : "checkpoint_provenance_failed",
  passed: provenancePassed,
  training_started: false,
  training_authorised: false,
  base_model: {
    repository: "mlx-community/Qwen3-8B-4bit",
    revision: MODEL_REVISION,
    source_model: "Qwen/Qwen3-8B",
    quantisation: "4-bit",
    path: MODEL_ROOT,
    model_sha256: modelSha256,
    model_size_bytes: statSync(modelPath).size,
    config_sha256: contentHash(readFileSync(resolve(MODEL_ROOT, "config.json"))),
    tokenizer_sha256: contentHash(readFileSync(resolve(MODEL_ROOT, "tokenizer.json"))),
  },
  clean_start_policy: {
    resume_adapter: null,
    historical_v1_wave2_wave3_adapters_used: false,
    rationale:
      "Historical Wave 2–3 answer-containing validation results cannot qualify a starting adapter. Any authorised cumulative run must begin from this pinned original base model.",
  },
  runtime: packages,
  config: {
    path: CONFIG_PATH,
    sha256: contentHash(configText),
    max_sequence_length: maxSequenceLength,
    mask_prompt: true,
  },
  runner: { path: RUNNER_PATH, sha256: contentHash(readFileSync(RUNNER_PATH)) },
  checks: provenanceChecks,
};
writeJson(resolve(ROOT, "clean-checkpoint-provenance.json"), provenance);
const provenanceBytes = readFileSync(resolve(ROOT, "clean-checkpoint-provenance.json"));

const ownerDevelopmentAuthorisation = {
  version: "cumulative-visible-owner-development-authorisation-v1",
  generated_at: new Date().toISOString(),
  status: "owner_authorised_development_path_pending_mechanical_gates",
  owner_authorisation_recorded: true,
  authorisation_basis:
    "The owner explicitly instructed 'all approve' and directed the evaluation-training-unseen path through live in the current task.",
  scope: "controlled_development_training_and_visible_qualification_only",
  conditionally_authorised_after_all_mechanical_gates: true,
  training_authorised_now: false,
  independent_legal_review: false,
  independent_citation_support_review: false,
  release_authorised: false,
  sealed_unseen_execution_authorised_now: false,
  unseen_accessed: false,
  bindings: {
    item_register_sha256: contentHash(itemRegisterBytes),
    source_register_sha256: contentHash(sourceRegisterBytes),
    global_allocation_sha256: contentHash(allocationBytes),
    contamination_preflight_sha256: contentHash(contaminationBytes),
    rendered_candidate_manifest_sha256: contentHash(
      readFileSync(resolve(CANDIDATE_ROOT, "candidate-manifest.json")),
    ),
    clean_checkpoint_provenance_sha256: contentHash(provenanceBytes),
  },
  citation_mapping_basis:
    "For the controlled development candidate only, v1 citation IDs come from the historical hash-approved targets and Wave 2–3 IDs come from the frozen proposition-source mapping. This owner decision is not described as independent entailment review.",
  mandatory_remaining_gates: [
    "no_unmapped_material_proposition",
    "live_json_answer_with_inline_markers_and_exact_mirrored_citation_ids_contract",
    "target_not_in_input",
    "global_construct_source_text_authority_and_url_isolation",
    "full_target_retention_under_real_tokenizer_and_loss_mask",
    "final_dataset_hash_binding",
    "clean_original_base_checkpoint_identity",
  ],
  release_evidence_limit:
    "Independent legal/source review, protected-set custodian comparison, visible evaluation, sealed unseen and a separate release decision remain required for live release.",
};
writeJson(
  resolve(ROOT, "owner-development-authorisation.json"),
  ownerDevelopmentAuthorisation,
);

const approvalTemplate = {
  version: "cumulative-visible-independent-qualification-approval-v1",
  status: "template_not_approved",
  generated_at: new Date().toISOString(),
  training_authorised: false,
  release_authorised: false,
  unseen_accessed: false,
  bindings: {
    item_register_sha256: contentHash(itemRegisterBytes),
    source_register_sha256: contentHash(sourceRegisterBytes),
    global_allocation_sha256: contentHash(allocationBytes),
    contamination_preflight_sha256: contentHash(contaminationBytes),
    rendered_candidate_manifest_sha256: contentHash(
      readFileSync(resolve(CANDIDATE_ROOT, "candidate-manifest.json")),
    ),
    clean_checkpoint_provenance_sha256: contentHash(provenanceBytes),
    token_and_loss_mask_preflight_sha256: null,
  },
  required_decisions: {
    all_52_repaired_items_independently_approved: false,
    approved_repaired_items_sha256: null,
    every_material_proposition_support_determined: false,
    exact_citation_ids_inserted_and_approved: false,
    global_94_record_semantic_construct_map_approved: false,
    global_94_record_allocation_approved: false,
    cumulative_visible_rendered_export_approved: false,
    token_length_and_loss_mask_preflight_passed: false,
    clean_base_checkpoint_provenance_approved: false,
    protected_set_custodian_comparison_passed: false,
    authorised_custodian_attestation_sha256: null,
  },
  independent_reviewer: null,
  approved_at: null,
  note:
    "Copy this template to qualification-approval.json only after independent review. The final exporter requires every decision and hash binding; this template itself can never authorise training.",
};
writeJson(resolve(ROOT, "independent-approval-template.json"), approvalTemplate);

const initialBlockers = [
  "The real tokenizer and exact MLX completion-loss-mask preflight has not yet run against this review rendering; final export must remain blocked until it passes without truncating any target.",
  "Independent semantic and citation-support review remains pending for release evidence; owner development authorisation must not be represented as that independent review.",
  "The authorised custodian has not compared protected regression and sealed-unseen constructs.",
  "The current files are review-only train.review.jsonl/valid.review.jsonl, not a final MLX-LM dataset.",
  "Any approved answer/evidence change invalidates downstream hashes and requires the tokenizer/loss-mask preflight to be repeated.",
];
writeText(
  resolve(ROOT, "README.md"),
  `# Cumulative visible-data qualification — v1\n\nStatus: **owner-authorised development path; mechanical gates pending; training not started**.\n\nThis path combines all 94 visible candidates: 42 historically approved v1 records, 33 repaired Wave 2 records and 19 repaired Wave 3 records. The computed candidate split is **${trainItems.length} train / ${validationItems.length} validation** and is disjoint across recorded canonical constructs, source IDs, exact passage hashes, authority families and canonical URLs.\n\nThe owner instruction to approve and continue through training is recorded separately from independent legal review. The rendered files under \`rendered-candidate/\` use deliberately non-trainable filenames and live-format JSON assistant targets. They exist only for target, token and mask inspection. Sealed unseen questions and answers were not included or accessed.\n\n## Current blockers\n\n${initialBlockers.map((blocker) => `- ${blocker}`).join("\n")}\n\nA future clean run must start from the pinned original Qwen3-8B 4-bit base at revision \`${MODEL_REVISION}\`; no historical adapter may be resumed.\n`,
);

console.log(
  JSON.stringify(
    {
      root: ROOT,
      total: items.length,
      train: trainItems.length,
      validation: validationItems.length,
      validation_cohorts: allocation.validation_cohorts,
      validation_topic_coverage: `${validationTopics.length}/${topics.length}`,
      isolation: isolation.passed && urlOverlap.length === 0,
      contamination_echo: contaminationPassed,
      checkpoint_provenance: provenancePassed,
      training_authorised: false,
      unseen_accessed: false,
      blockers: initialBlockers,
    },
    null,
    2,
  ),
);
