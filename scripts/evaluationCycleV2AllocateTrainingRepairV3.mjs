import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditTrainingPartitionIsolation,
  contentHash,
} from "./lib/trainingEvidenceIntegrity.mjs";

const ROOT = resolve(
  process.env.TRAINING_REPAIR_V3_ROOT ||
    "training/evaluation-cycle-v2/07-training-data-double-check-v3-20260901",
);
const PACK_PATH = resolve(ROOT, "repaired-training-items-draft.json");
const OUTPUT_PATH = resolve(ROOT, "global-allocation-draft.json");
const packBytes = readFileSync(PACK_PATH);
const pack = JSON.parse(packBytes);

if (
  pack.training_authorised !== false ||
  pack.release_authorised !== false ||
  pack.unseen_included !== false ||
  pack.unseen_accessed !== false ||
  !Array.isArray(pack.items)
) {
  throw new Error(
    "Allocation is permitted only for the explicit review-only Wave 2–3 draft; training authority and unseen access must both remain false",
  );
}

const counts = {
  wave_2: pack.items.filter((item) => item.wave === 2).length,
  wave_3: pack.items.filter((item) => item.wave === 3).length,
};
if (pack.items.length !== 52 || counts.wave_2 !== 33 || counts.wave_3 !== 19) {
  throw new Error(
    `Expected the complete visible Wave 2–3 draft (52 items: 33 Wave 2 and 19 Wave 3); received ${pack.items.length}: ${counts.wave_2}/${counts.wave_3}`,
  );
}

// These groups are intentionally conservative. They keep obvious applications of
// the same substantive rule in one partition even where record IDs, facts or
// source passages differ. This is a local draft aid, not an independent semantic
// review and not a substitute for the cumulative-history/custodian checks.
const SEMANTIC_RULE_GROUPS = {
  "scheme-classification.rights-not-product-label": [
    "v2-w2-t01-train-001",
    "v2-w2-t01-train-003",
    "v2-w2-t01-train-006",
  ],
  "governance.outsourcing-accountability": [
    "v2-w2-t02-train-002",
    "v2r-w2-t02-train-001",
  ],
  "funding.recovery-plan-and-affordability": [
    "v2-w2-t03-train-001",
    "v2-w2-t03-train-004",
    "v2r-w2-t03-train-001",
  ],
  "equality.disability-adjustments-and-access": [
    "v2-w2-t04-train-001",
    "v2-w2-t04-train-003",
    "v2-w2-t04-train-006",
  ],
  "dashboards.operational-failure-recording-and-escalation": [
    "v2r-w2-t06-train-001",
    "v2r-w2-t06-train-003",
  ],
  "member-benefits.protected-pension-age": [
    "v2-w3-t01-train-001",
    "v2r-w3-t01-train-001",
  ],
  "member-benefits.retirement-timing-scheme-terms": [
    "v2-w3-t01-train-002",
    "v2-w3-t01-train-003",
  ],
  "tax.annual-allowance-rate-taper-and-carry-forward": [
    "v2-w3-t02-train-001",
    "v2-w3-t02-train-002",
    "v2r-w3-t02-train-001",
  ],
  "tax.money-purchase-annual-allowance": [
    "v2-w3-t02-train-003",
    "v2r-w3-t02-train-002",
  ],
  "tax.lump-sum-allowance-and-protection": [
    "v2-w3-t02-train-004",
    "v2-w3-t02-train-006",
  ],
  "tax.overseas-transfer-charge": [
    "v2-w3-t02-train-005",
    "v2r-w3-t02-train-003",
  ],
  "iht.pension-property-death-boundary": [
    "v2r-w3-t03-train-001",
    "v2r-w3-t03-train-002",
  ],
};

const RULE = {};
for (const [rule, ids] of Object.entries(SEMANTIC_RULE_GROUPS)) {
  for (const id of ids) {
    if (RULE[id] && RULE[id] !== rule) {
      throw new Error(`Conflicting canonical semantic rule overrides for ${id}`);
    }
    RULE[id] = rule;
  }
}
const knownIds = new Set(pack.items.map((item) => item.training_id));
const unknownOverrides = Object.keys(RULE).filter((id) => !knownIds.has(id));
if (unknownOverrides.length) {
  throw new Error(`Semantic rule overrides refer to unknown items: ${unknownOverrides.join(", ")}`);
}

const topicOf = (item) => {
  const parts = String(item.construct_id || item.legal_rule_id || "").split(".");
  return parts.length >= 2 ? parts.slice(0, 2).join(".") : parts[0] || "unclassified";
};
const topics = [...new Set(pack.items.map(topicOf))].sort();
const topicBit = new Map(topics.map((topic, index) => [topic, 1n << BigInt(index)]));

const values = (item) => {
  const canonicalRule =
    RULE[item.training_id] || item.legal_rule_id || item.construct_id;
  return new Set(
    [
      canonicalRule && `rule:${canonicalRule}`,
      ...(item.retrieved_evidence || []).flatMap((source) => [
        source.source_id && `source:${source.source_id}`,
        source.text?.trim() && `text:${contentHash(source.text)}`,
        source.authority_family && `authority:${source.authority_family}`,
      ]),
    ].filter(Boolean),
  );
};

const parent = new Map(pack.items.map((item) => [item.training_id, item.training_id]));
const find = (id) => {
  const current = parent.get(id);
  if (current === id) return id;
  const root = find(current);
  parent.set(id, root);
  return root;
};
const union = (left, right) => {
  const leftRoot = find(left);
  const rightRoot = find(right);
  if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
};
const owners = new Map();
for (const item of pack.items) {
  for (const value of values(item)) {
    if (owners.has(value)) union(item.training_id, owners.get(value));
    else owners.set(value, item.training_id);
  }
}

const groups = new Map();
for (const item of pack.items) {
  const root = find(item.training_id);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(item);
}
const components = [...groups.values()]
  .map((items) => items.sort((left, right) => left.training_id.localeCompare(right.training_id)))
  .sort(
    (left, right) =>
      left.length - right.length ||
      left[0].training_id.localeCompare(right[0].training_id),
  );

const componentDetails = components.map((items) => ({
  items,
  size: items.length,
  wave_2: items.filter((item) => item.wave === 2).length,
  wave_3: items.filter((item) => item.wave === 3).length,
  topic_mask: items.reduce((mask, item) => mask | topicBit.get(topicOf(item)), 0n),
  topics: [...new Set(items.map(topicOf))].sort(),
}));

// Dynamic programming retains alternatives with different topic coverage. A
// validation set may contain 8–12 records; no fixed 42/10 or 5/5 shape is assumed.
let choices = new Map([["0:0:0:0", []]]);
for (const component of componentDetails) {
  const next = new Map(choices);
  for (const [key, picked] of choices) {
    const [total, wave2, wave3, maskText] = key.split(":");
    const nextTotal = Number(total) + component.size;
    if (nextTotal > 12) continue;
    const nextMask = BigInt(maskText) | component.topic_mask;
    const nextKey = `${nextTotal}:${Number(wave2) + component.wave_2}:${Number(wave3) + component.wave_3}:${nextMask}`;
    const candidate = [...picked, component];
    const previous = next.get(nextKey);
    const signature = candidate
      .flatMap((entry) => entry.items.map((item) => item.training_id))
      .join("|");
    const previousSignature = previous
      ?.flatMap((entry) => entry.items.map((item) => item.training_id))
      .join("|");
    if (!previous || signature.localeCompare(previousSignature) < 0) {
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
const candidates = [...choices.entries()]
  .map(([key, picked]) => {
    const [total, wave2, wave3, maskText] = key.split(":");
    return {
      picked,
      total: Number(total),
      wave_2: Number(wave2),
      wave_3: Number(wave3),
      topic_mask: BigInt(maskText),
      signature: picked
        .flatMap((entry) => entry.items.map((item) => item.training_id))
        .sort()
        .join("|"),
    };
  })
  .filter((candidate) => candidate.total >= 8 && candidate.total <= 12)
  .sort(
    (left, right) =>
      bitCount(right.topic_mask) - bitCount(left.topic_mask) ||
      Math.abs(left.wave_2 - left.wave_3) - Math.abs(right.wave_2 - right.wave_3) ||
      Math.abs(left.total - 10) - Math.abs(right.total - 10) ||
      left.signature.localeCompare(right.signature),
  );

if (!candidates.length) {
  throw new Error(
    `No locally isolated 8–12 item validation allocation is possible; component sizes: ${componentDetails.map((entry) => entry.size).join(", ")}`,
  );
}

const selected = candidates[0];
const validationIds = new Set(
  selected.picked.flatMap((component) => component.items.map((item) => item.training_id)),
);
const train = pack.items.filter((item) => !validationIds.has(item.training_id));
const validation = pack.items.filter((item) => validationIds.has(item.training_id));
const withCanonicalRule = (item) => ({
  ...item,
  construct_id: RULE[item.training_id] || item.legal_rule_id || item.construct_id,
});
const isolation = auditTrainingPartitionIsolation(
  train.map(withCanonicalRule),
  validation.map(withCanonicalRule),
);
if (!isolation.passed) {
  throw new Error(`Local allocation failed recorded-field isolation: ${JSON.stringify(isolation)}`);
}

const validationTopics = [...new Set(validation.map(topicOf))].sort();
const allocation = {
  version: "wave4-local-wave2-wave3-training-validation-allocation-draft-v8",
  generated_at: new Date().toISOString(),
  status: "local_proposal_pending_independent_construct_cumulative_and_custodian_review",
  scope: "local_wave_2_3_visible_candidate_only",
  training_authorised: false,
  release_authorised: false,
  unseen_included: false,
  unseen_accessed: false,
  source_pack_sha256: contentHash(packBytes),
  train: { count: train.length, ids: train.map((item) => item.training_id) },
  validation: {
    count: validation.length,
    ids: validation.map((item) => item.training_id),
  },
  selection_objective: [
    "maximise_topic_coverage",
    "minimise_wave_count_difference",
    "prefer_validation_count_nearest_10_within_8_to_12",
    "deterministic_training_id_tiebreak",
  ],
  coverage: {
    available_topics: topics,
    validation_topics: validationTopics,
    missing_validation_topics: topics.filter((topic) => !validationTopics.includes(topic)),
    validation_topic_count: validationTopics.length,
    available_topic_count: topics.length,
  },
  wave_balance: {
    wave_2: validation.filter((item) => item.wave === 2).length,
    wave_3: validation.filter((item) => item.wave === 3).length,
    absolute_difference: Math.abs(selected.wave_2 - selected.wave_3),
  },
  semantic_rule_overrides: RULE,
  component_sizes: componentDetails.map((entry) => ({
    size: entry.size,
    wave_2: entry.wave_2,
    wave_3: entry.wave_3,
    topics: entry.topics,
    ids: entry.items.map((item) => item.training_id),
  })),
  isolation: {
    ...isolation,
    scope: "local_wave_2_3_only",
    train_count: train.length,
    validation_count: validation.length,
  },
  pending_checks: {
    independent_proposition_and_full_passage_review: true,
    rendered_export_token_length_and_loss_mask_audit: true,
    cumulative_training_history_isolation_audit: true,
    protected_regression_and_sealed_unseen_custodian_comparison: true,
    clean_starting_checkpoint_provenance: true,
  },
  filename_compatibility_note:
    "The legacy filename is retained for package compatibility. This file is not a global allocation or approval.",
  caveat:
    "This graph establishes isolation only within the 52 visible Wave 2–3 draft records and only for the recorded canonical rules, source IDs, passage hashes and authority families. It does not establish cumulative-history, protected-set or sealed-unseen separation and does not authorise training.",
};

writeFileSync(OUTPUT_PATH, `${JSON.stringify(allocation, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      train: train.length,
      validation: validation.length,
      wave_balance: allocation.wave_balance,
      topic_coverage: `${validationTopics.length}/${topics.length}`,
      local_isolation: isolation.passed,
      training_authorised: false,
    },
    null,
    2,
  ),
);
