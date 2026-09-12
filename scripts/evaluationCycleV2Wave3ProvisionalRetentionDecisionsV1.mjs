import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const fullRoot = path.resolve(
  process.env.WAVE3_FULL_ROOT ||
    path.join(
      workspaceRoot,
      "training/evaluation-cycle-v2/23-cumulative-visible-qualification-v8-final-full-20260901",
    ),
);
const itemRegisterPath = path.join(fullRoot, "cumulative-visible-item-register.json");
const sourceRegisterPath = path.join(fullRoot, "cumulative-visible-source-register.json");
const outputPath = path.resolve(
  process.env.WAVE3_PROVISIONAL_DECISIONS_OUTPUT ||
    path.join(
      fullRoot,
      "independent-agent-audits/wave-3-compact-substantive-retention-recommendations.v8-provisional-v3.json",
    ),
);

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const retained = new Set([2, 9, 11, 14, 18, 22, 32, 36, 38, 40, 42, 46, 59, 65]);

// Offsets are exact JavaScript string offsets in the root-19 parent text:
// start inclusive, end exclusive. These are substantive-review recommendations,
// not instructions to approve or train.
const spans = {
  1: [["review-v3-hmrc-protected-pension-age", 1720, 1962], ["review-v3-hmrc-protected-pension-age", 2573, 2763]],
  2: [["review-v3-hmrc-protected-pension-age", 2573, 2762]],
  3: [["review-v3-hmrc-protected-pension-age", 9037, 9476], ["review-v3-hmrc-protected-pension-age", 11250, 12106]],
  4: [["review-v3-hmrc-protected-pension-age", 6776, 7387]],
  5: [["review-v3-hmrc-protected-pension-age", 2281, 2447], ["review-v3-hmrc-protected-pension-age", 29501, 29971], ["review-v3-hmrc-protected-pension-age", 39118, 40984], ["review-v3-hmrc-protected-pension-age", 47433, 47891]],
  6: [["review-v3-govuk-early-retirement", 0, 514]],
  7: [["review-v3-govuk-early-retirement", 0, 514]],
  8: [["review-v3-govuk-early-retirement", 0, 385]],
  9: [["review-v3-hmrc-late-retirement", 124, 436]],
  10: [["review-v3-hmrc-late-retirement", 438, 858]],
  11: [["review-v3-tpo-death-benefit-lump-sums", 162, 306]],
  12: [["review-v3-tpo-death-benefit-lump-sums", 0, 306]],
  13: [["official-hmrc-ptm-ptm070000_chunk_4", 220, 1179], ["review-v3-tpo-death-benefit-lump-sums", 406, 741]],
  14: [["review-v3-tpo-death-benefit-lump-sums", 933, 1043]],
  15: [["official-hmrc-ptm-ptm060000_chunk_501", 1039, 1478]],
  16: [["official-hmrc-ptm-ptm060000_chunk_501", 0, 1478]],
  17: [["official-hmrc-ptm-ptm060000_chunk_501", 0, 1478]],
  18: [["review-v3-fca-authorisation-check", 0, 189]],
  19: [["official-hmrc-ptm-ptm120000_chunk_79", 270, 633]],
  20: [["official-hmrc-ptm-ptm120000_chunk_79", 270, 633]],
  21: [["official-tpr-avoid-and-report-pension-scams_chunk_5", 1161, 1310], ["review-v3-fca-authorisation-check", 0, 189], ["official-tpr-avoid-and-report-pension-scams_chunk_8", 0, 350]],
  22: [["review-v3-hmrc-protected-pension-age", 929, 1344]],
  23: [["review-v3-hmrc-protected-pension-age", 929, 1344]],
  24: [["review-v3-hmrc-protected-pension-age", 929, 1344], ["review-v3-hmrc-protected-pension-age", 3536, 3841]],
  25: [["review-v3-hmrc-protected-pension-age", 2281, 2447]],
  26: [["review-v3-hmrc-ptm063700", 18586, 21222], ["review-v3-hmrc-ptm063700", 27653, 29403]],
  27: [["review-v3-hmrc-ptm063500", 2996, 3630]],
  28: [["review-v3-hmrc-ptm063700", 29145, 29403], ["review-v3-hmrc-ptm063700", 30988, 31311]],
  29: [["official-hmrc-pension-schemes-rates-2026-27_chunk_5", 0, 67], ["official-hmrc-pension-schemes-rates-2026-27_chunk_7", 0, 208]],
  30: [["official-hmrc-pension-schemes-rates-2026-27_chunk_5", 521, 758], ["review-v3-hmrc-ptm057100", 587, 1312], ["review-v3-hmrc-ptm057100", 1655, 2020]],
  31: [["official-hmrc-pension-schemes-rates-2026-27_chunk_8", 0, 461], ["review-v3-hmrc-ptm057100", 13349, 14851], ["review-v3-hmrc-ptm057100", 14941, 16186]],
  32: [["review-v3-hmrc-ptm057100", 1655, 2020]],
  33: [["official-hmrc-pension-schemes-rates-2026-27_chunk_5", 0, 67], ["review-v3-hmrc-ptm057100", 1845, 2020]],
  34: [["review-v3-hmrc-ptm057100", 1655, 1844]],
  35: [["review-pinned-hmrc-ptm056520-current", 701, 1286]],
  36: [["official-hmrc-ptm-ptm060000_chunk_367", 294, 607], ["review-pinned-hmrc-ptm056520-current", 4713, 4904]],
  37: [["review-pinned-hmrc-ptm056520-current", 701, 1286], ["review-pinned-hmrc-ptm056520-current", 1357, 2108], ["review-pinned-hmrc-ptm056520-current", 4713, 4904]],
  38: [["review-v3-hmrc-ptm174700", 1029, 1369]],
  39: [["review-v3-hmrc-ptm174700", 4985, 6102], ["review-v3-hmrc-ptm174700", 7317, 7800], ["review-v3-hmrc-ptm174700", 8953, 10068], ["review-v3-hmrc-ptm174700", 11048, 11529]],
  40: [["review-v3-hmrc-ptm174700", 11048, 11529]],
  41: [["review-v3-hmrc-ptm174700", 0, 1029], ["review-v3-hmrc-ptm174700", 1029, 1369], ["review-v3-hmrc-ptm174700", 4890, 5206], ["review-v3-hmrc-ptm174700", 8852, 9174]],
  42: [["review-v3-hmrc-ptm102200", 6746, 7036]],
  43: [["review-v3-hmrc-ptm102200", 258, 594], ["review-v3-hmrc-ptm102200", 9283, 10017], ["review-v3-hmrc-ptm102300", 3957, 4547], ["review-v3-hmrc-ptm102300", 5180, 5635], ["review-v3-hmrc-ptm102300", 6125, 6409], ["review-v3-hmrc-ptm102300", 6827, 7231], ["review-v3-hmrc-ptm102300", 7432, 7736]],
  44: [["review-v3-hmrc-ptm102900", 956, 1252], ["review-v3-hmrc-ptm102400", 820, 1200], ["review-v3-hmrc-ptm102400", 7151, 7783]],
  45: [["review-v3-hmrc-ptm102200", 1947, 3673], ["review-v3-hmrc-ptm102200", 3715, 4131]],
  46: [["review-v3-hmrc-ptm174100", 2974, 3485]],
  47: [["review-v3-hmrc-ptm174100", 1791, 2061], ["review-v3-hmrc-ptm174100", 2974, 3485], ["review-v3-hmrc-ptm174100", 6104, 6605], ["review-v3-hmrc-ptm174100", 9106, 9535]],
  48: [["review-v3-hmrc-ptm174100", 1791, 2061], ["review-v3-hmrc-ptm174100", 2974, 3485]],
  49: [["review-v3-hmrc-ptm055100", 10074, 10892], ["review-v3-hmrc-ptm113310-350", 12915, 13261]],
  50: [["review-v3-hmrc-ptm113310-350", 11036, 12091], ["review-v3-hmrc-ptm113310-350", 15711, 17448]],
  51: [["review-v3-hmrc-ptm055100", 10074, 10892], ["review-v3-hmrc-ptm113310-350", 15847, 16457]],
  52: [["review-v3-hmrc-ptm055100", 6266, 6402], ["review-v3-hmrc-ptm055100", 27757, 28027]],
  53: [["review-v3-hmrc-ptm056540", 1247, 2494]],
  54: [["review-v3-hmrc-ptm056510-method-only", 3951, 4618], ["review-v3-hmrc-ptm056540", 1247, 2494]],
  55: [["review-v3-hmrc-ptm056510-method-only", 514, 1089], ["review-v3-hmrc-ptm056510-method-only", 1758, 2425], ["review-v3-hmrc-ptm056540", 1247, 2494], ["review-v3-hmrc-ptm056540", 2495, 2798], ["official-hmrc-pension-schemes-rates-2026-27_chunk_8", 0, 461]],
  56: [["review-v3-hmrc-ptm056510-method-only", 2426, 3340]],
  57: [["review-v3-hmrc-ptm056510-method-only", 3341, 3643]],
  58: [["review-v3-hmrc-ptm056510-method-only", 4084, 4618]],
  59: [["review-v3-hmrc-ptm102300", 5180, 5300]],
  60: [["review-v3-hmrc-ptm102300", 2180, 2554], ["review-v3-hmrc-ptm102300", 3045, 3764], ["review-v3-hmrc-ptm102300", 3880, 5960]],
  61: [["review-v3-hmrc-ptm102300", 2180, 2554], ["review-v3-hmrc-ptm102300", 3880, 5300]],
  62: [["review-v3-hmrc-ptm102200", 1947, 3673], ["review-v3-hmrc-ptm102200", 9283, 10017]],
  63: [["review-v3-finance-act-2026-ss66-71", 0, 2246], ["review-v3-finance-act-2026-ss66-71", 5209, 5451]],
  64: [["review-v3-finance-act-2026-ss66-71", 0, 2246], ["review-v3-finance-act-2026-ss66-71", 5209, 5451]],
  65: [["review-v3-finance-act-2026-ss66-71", 5209, 5451]],
  66: [["review-v3-finance-act-2026-ss66-71", 0, 2246], ["review-v3-finance-act-2026-ss66-71", 2741, 4253], ["review-v3-finance-act-2026-ss66-71", 5209, 5451]],
  67: [["review-v3-hmrc-iht-technical-note-2", 488, 2125]],
  68: [["review-v3-hmrc-iht-technical-note-2", 0, 487], ["review-v3-hmrc-iht-technical-note-2", 2126, 2584]],
};

const itemRegisterBytes = fs.readFileSync(itemRegisterPath);
const sourceRegisterBytes = fs.readFileSync(sourceRegisterPath);
const itemRegister = JSON.parse(itemRegisterBytes);
const wave3Items = itemRegister.items.filter((item) => item.wave === 3);
const mappings = wave3Items.flatMap((item) =>
  item.proposition_source_candidates.map((mapping) => ({ item, mapping })),
);

if (wave3Items.length !== 19 || mappings.length !== 68) {
  throw new Error(
    `Expected 19 Wave 3 items and 68 mappings; found ${wave3Items.length} and ${mappings.length}.`,
  );
}

const covered = new Set([...retained, ...Object.keys(spans).map(Number)]);
if (covered.size !== 68 || [...covered].some((index) => index < 1 || index > 68)) {
  throw new Error(`Review specification does not cover exactly indices 1–68.`);
}

const decisions = mappings.map(({ item, mapping }, offset) => {
  const mappingIndex = offset + 1;
  const sourceById = new Map(
    item.retrieved_evidence.map((source) => [source.source_id, source]),
  );
  const recommendedSpans = (spans[mappingIndex] || []).map(
    ([parentSourceId, start, end]) => {
      const parent = sourceById.get(parentSourceId);
      if (!parent) {
        throw new Error(
          `Mapping ${mappingIndex} (${item.training_id}) does not contain parent ${parentSourceId}.`,
        );
      }
      if (!mapping.source_ids.includes(parentSourceId)) {
        throw new Error(
          `Mapping ${mappingIndex} (${item.training_id}) does not map selected parent ${parentSourceId}.`,
        );
      }
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > parent.text.length
      ) {
        throw new Error(
          `Invalid span ${parentSourceId} [${start},${end}] for mapping ${mappingIndex}.`,
        );
      }
      const text = parent.text.slice(start, end);
      return {
        parent_source_id: parentSourceId,
        full_source_sha256: sha256(parent.text),
        start,
        end,
        excerpt_sha256: sha256(text),
        text,
      };
    },
  );

  return {
    mapping_index: mappingIndex,
    training_id: item.training_id,
    proposition: mapping.proposition,
    proposition_sha256: sha256(mapping.proposition),
    mapped_source_ids: mapping.source_ids,
    support_relationship: mapping.support_relationship,
    selected_parent_source_ids: [...new Set(
      recommendedSpans.map((span) => span.parent_source_id),
    )],
    provisional_decision: retained.has(mappingIndex)
      ? "reviewed_exact_span_selection_for_previously_retained_mapping"
      : "reviewed_exact_span_replacement",
    recommended_spans: recommendedSpans,
    passed: false,
  };
});

const result = {
  version: "wave-3-compact-substantive-retention-recommendations-v8-provisional-v3",
  generated_at: new Date().toISOString(),
  status: "provisional_fail_closed_pending_final_compact_rebuild_and_fresh_review",
  passed: false,
  training_authorised: false,
  release_authorised: false,
  independent_legal_review: false,
  unseen_accessed: false,
  bindings: {
    item_register_path: path.relative(workspaceRoot, itemRegisterPath),
    item_register_sha256: sha256(itemRegisterBytes),
    full_source_register_path: path.relative(workspaceRoot, sourceRegisterPath),
    full_source_register_sha256: sha256(sourceRegisterBytes),
    compact_evidence_map_sha256: null,
  },
  counts: {
    wave_3_items: wave3Items.length,
    expected_mappings: 68,
    reviewed_mappings: decisions.length,
    provisionally_retained_current_excerpt: retained.size,
    replacement_span_recommendations: decisions.length - retained.size,
    exact_span_decisions: decisions.filter(
      (decision) => decision.recommended_spans.length > 0,
    ).length,
    unresolved: decisions.length,
  },
  decisions,
  limitation:
    "Machine-readable recommendations against root-23 v8 parent bytes only. Every final compact excerpt remains unpassed until independently rebound and reviewed; this file cannot authorise training or release.",
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output: path.relative(workspaceRoot, outputPath),
      output_sha256: sha256(fs.readFileSync(outputPath)),
      counts: result.counts,
      bindings: result.bindings,
    },
    null,
    2,
  ),
);
