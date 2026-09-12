import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const fullRoot = path.resolve(
  process.env.WAVE2_FULL_ROOT ||
    path.join(
      workspaceRoot,
      "training/evaluation-cycle-v2/19-cumulative-visible-qualification-v7-final-full-20260901",
    ),
);
const provisionalRoot = path.resolve(
  process.env.WAVE2_PROVISIONAL_COMPACT_ROOT ||
    path.join(
      workspaceRoot,
      "training/evaluation-cycle-v2/20-provisional-compact-span-check-v7-20260901",
    ),
);
const itemRegisterPath = path.join(fullRoot, "cumulative-visible-item-register.json");
const sourceRegisterPath = path.join(fullRoot, "cumulative-visible-source-register.json");
const provisionalPath = path.join(
  provisionalRoot,
  "provisional-compact-evidence-selection.json",
);
const outputPath = path.resolve(
  process.env.WAVE2_SPAN_RECOMMENDATIONS_OUTPUT ||
    path.join(
      fullRoot,
      "independent-agent-audits/wave-2-compact-substantive-retention-recommendations.provisional-v1.json",
    ),
);
const priorFullRoot = process.env.WAVE2_PRIOR_FULL_ROOT
  ? path.resolve(process.env.WAVE2_PRIOR_FULL_ROOT)
  : null;
const expectedItemRegisterSha256 =
  process.env.WAVE2_EXPECTED_ITEM_REGISTER_SHA256 ||
  "7a27375a80af281bc66e1a071f238c6ae7e8fa22305ea4197ba9eb4652eefebd";
const expectedSourceRegisterSha256 =
  process.env.WAVE2_EXPECTED_SOURCE_REGISTER_SHA256 ||
  "c93c3a02b5802c23c489fbf73334517d81b53d710470fed10d10eb17ebb03b19";
const recommendationVersion =
  process.env.WAVE2_RECOMMENDATION_VERSION ||
  "wave-2-compact-substantive-retention-recommendations-provisional-v1";
const recommendationStatus =
  process.env.WAVE2_RECOMMENDATION_STATUS ||
  "provisional_fail_closed_root19_parent_span_recommendations_pending_compact_rebuild_and_fresh_review";
const bindingLabel = process.env.WAVE2_BINDING_LABEL || "root-19";

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const key = (trainingId, proposition) => `${trainingId}\u0000${proposition}`;
const expandToCompleteStructuralBlocks = (text, start, end) => {
  if (start === 0 && end === text.length) return [start, end];
  const precedingBreak = text.lastIndexOf("\n\n", Math.max(0, start - 1));
  const followingBreak = text.indexOf("\n\n", end);
  return [
    precedingBreak < 0 ? 0 : precedingBreak + 2,
    followingBreak < 0 ? text.length : followingBreak + 2,
  ];
};

// These are exact JavaScript string offsets in root-19 parent-source text.
// Each range is start-inclusive/end-exclusive. The recommendations remain
// fail-closed until a fresh compact map is built and substantively reviewed.
const legacyReviewedSpans = {
  2: [["review-v3-hmrc-ptm023300", 3523, 4509]],
  4: [
    ["review-v3-hmrc-ptm023200", 333, 516],
    ["review-v3-hmrc-ptm023200", 1418, 2361],
    ["review-v3-hmrc-ptm023200", 4402, 4585],
  ],
  5: [["official-pension-schemes-act-1993_chunk_3", 0, 1956]],
  6: [["official-pension-schemes-act-1993_chunk_3", 0, 1956]],
  7: [["official-pension-schemes-act-1993_chunk_3", 0, 1956]],
  8: [["official-pension-schemes-act-2017_chunk_3", 0, 694]],
  10: [
    ["official-hmrc-ptm-ptm020000_chunk_41", 307, 535],
    ["official-hmrc-ptm-ptm020000_chunk_41", 2225, 3553],
    ["review-v3-hmrc-ptm023200", 3103, 3717],
  ],
  11: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  12: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  13: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  14: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  15: [
    ["review-v3-psa1993-s1", 0, 1956],
    ["review-v3-pspa2013-ss1-8", 0, 630],
  ],
  16: [["review-v3-pspa2013-ss1-8", 0, 2404]],
  17: [
    ["review-v3-psa1993-s1", 0, 1956],
    ["review-v3-pspa2013-ss1-8", 10855, 12200],
  ],
  18: [
    ["review-v3-dwp-gar-classification-valuation", 63, 600],
    ["review-v3-dwp-gar-classification-valuation", 7557, 8276],
  ],
  19: [["review-v3-dwp-gar-classification-valuation", 7557, 8414]],
  20: [
    ["review-v3-dwp-gar-classification-valuation", 9611, 10403],
    ["official-pension-schemes-act-2015_chunk_57", 0, 1110],
  ],
  21: [
    ["review-v3-dwp-gar-classification-valuation", 5814, 6162],
    ["review-v3-dwp-gar-classification-valuation", 9611, 10403],
  ],

  22: [
    ["review-pinned-tpr-general-code-conflicts", 2700, 5600],
    ["review-pinned-tpr-general-code-conflicts", 6200, 7817],
  ],
  23: [
    ["review-pinned-tpr-general-code-conflicts", 3500, 5600],
    ["review-pinned-tpr-general-code-conflicts", 6200, 9200],
  ],
  25: [
    ["review-v3-tpr-managing-service-providers-full", 2800, 5550],
    ["review-v3-tpr-dispute-resolution-full", 0, 1600],
  ],
  26: [["review-v3-tpr-managing-service-providers-full", 3600, 5550]],
  27: [["official-tpo-cas-92123-h9g1_chunk_6", 0, 2589]],
  28: [["official-tpo-cas-92123-h9g1_chunk_6", 0, 2589]],
  29: [["review-pinned-edge-discretion-principle", 900, 1600]],
  30: [
    ["review-pinned-edge-discretion-principle", 900, 1600],
    ["review-pinned-edge-discretion-principle", 2800, 3500],
    ["review-v3-tpr-dispute-resolution-full", 300, 1600],
  ],
  31: [
    ["review-v3-investment-regulations-2005-reg4", 0, 1400],
    ["review-pinned-tpr-general-code-conflicts", 2700, 5600],
    ["review-pinned-tpr-general-code-conflicts", 6200, 8000],
  ],
  32: [
    ["official-pensions-act-1995_chunk_43", 0, 700],
    ["review-v3-investment-regulations-2005-reg4", 0, 440],
  ],
  33: [["official-pensions-act-1995_chunk_45", 0, 1650]],
  34: [["review-v3-investment-regulations-2005-reg4", 441, 1400]],
  36: [
    ["review-pinned-tpr-general-code-conflicts", 2700, 5600],
    ["review-pinned-tpr-general-code-conflicts", 6200, 8000],
  ],
  37: [["review-pinned-tpr-general-code-conflicts", 3650, 5200]],
  38: [["official-tpr-scheme-continuity-planning_chunk_3", 0, 2710]],
  39: [["official-tpr-scheme-continuity-planning_chunk_3", 0, 2710]],
  40: [["official-tpr-scheme-continuity-planning_chunk_3", 0, 2710]],
  42: [["review-v3-tpr-own-risk-assessment", 0, 1300]],
  43: [
    ["review-v3-tpr-own-risk-assessment", 0, 2750],
    ["review-v3-tpr-cyber-controls", 0, 1350],
    ["review-v3-tpr-managing-service-providers-full", 993, 1200],
    ["review-v3-tpr-managing-service-providers-full", 3600, 5550],
  ],

  47: [
    ["official-pensions-act-2004_chunk_314", 0, 550],
    ["official-pensions-act-2004_chunk_318", 0, 760],
    ["review-v3-pa2004-s227-228", 0, 3029],
  ],
  48: [["review-v3-pa1995-s67", 0, 1900]],
  49: [
    ["review-v3-tpr-employer-covenant-transaction", 0, 2400],
    ["review-v3-tpr-employer-covenant-transaction", 3900, 5000],
    ["review-pinned-pa2004-corporate-transaction-powers", 0, 1500],
    ["review-pinned-pa2004-corporate-transaction-powers", 7709, 8500],
    ["review-pinned-pa2004-corporate-transaction-powers", 9458, 10300],
    ["official-pensions-regulator-notifiable-events-regulations-2005_chunk_3", 0, 2600],
  ],
  50: [
    ["review-v3-tpr-employer-covenant-transaction", 0, 2400],
    ["review-v3-tpr-employer-covenant-transaction", 3900, 5708],
  ],
  51: [["review-v3-employer-debt-regulations-reg6e", 0, 5104]],
  52: [["review-v3-employer-debt-regulations-reg6e", 0, 817]],
  53: [["review-v3-employer-debt-regulations-reg6za", 2431, 3199]],
  54: [
    ["review-v3-employer-debt-regulations-reg6e", 0, 5104],
    ["review-v3-employer-debt-regulations-reg6za", 2431, 3199],
  ],
  58: [
    ["official-pensions-act-1995_chunk_140", 0, 1253],
    ["review-v3-pa2004-s227-228", 0, 3779],
  ],
  59: [
    ["official-pensions-act-1995_chunk_140", 0, 1253],
    ["review-v3-pa2004-s227-228", 0, 3779],
  ],
  60: [["official-pensions-act-1995_chunk_140", 0, 1253]],
  61: [["review-v3-pa2004-s227-228", 0, 3029]],
  62: [
    ["official-pensions-act-1995_chunk_140", 0, 1253],
    ["review-v3-pa2004-s227-228", 0, 3779],
  ],
  63: [
    ["official-pensions-act-1995_chunk_140", 0, 1253],
    ["official-pensions-act-1995_chunk_141", 0, 1104],
    ["review-v3-pa2004-s227-228", 0, 3779],
  ],
  64: [
    ["official-pensions-act-1995_chunk_141", 473, 1104],
    ["review-v3-pa2004-s227-228", 3029, 3779],
    ["review-v4-tpr-reporting-breaches-complete", 0, 5600],
  ],
  65: [
    ["review-v3-ni-order-2005-arts34-38", 0, 1000],
    ["review-pinned-pa2004-corporate-transaction-powers", 0, 1000],
  ],
  66: [
    ["review-v3-ni-order-2005-arts34-38", 0, 1000],
    ["review-pinned-pa2004-corporate-transaction-powers", 0, 1000],
  ],
  67: [
    ["review-v3-ni-order-2005-arts34-38", 0, 1000],
    ["review-v3-ni-order-2005-arts34-38", 49234, 50984],
  ],
  68: [
    ["review-v3-ni-order-2005-arts39-47", 0, 1000],
    ["review-v3-ni-order-2005-arts39-47", 13171, 14650],
  ],
  69: [
    ["review-v3-ni-order-2005-arts64-65", 0, 1000],
    ["review-v3-ni-order-2005-arts64-65", 5503, 6700],
  ],
  70: [["review-pinned-pa2004-corporate-transaction-powers", 0, 1500]],
  71: [["review-v3-funding-regulations-2024-reg20", 2610, 4242]],
  72: [
    ["review-v3-funding-regulations-2024-reg20", 2610, 4242],
    ["review-v3-tpr-db-recovery-plans", 500, 1450],
  ],
  73: [["review-v3-tpr-db-recovery-plans", 500, 1000]],
  74: [
    ["review-v3-tpr-db-recovery-plans", 500, 1450],
    ["review-v3-funding-regulations-2024-reg20", 2610, 4242],
  ],
  75: [["review-v3-funding-regulations-2024-reg20", 2610, 4242]],
  76: [["review-v3-funding-regulations-2024-reg20", 2610, 4242]],

  77: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-pinned-equality-act-2010-ss61-63", 0, 900],
  ],
  78: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-pinned-equality-act-2010-ss61-63", 0, 900],
  ],
  80: [["review-v3-equality-age-exceptions-order-2010", 0, 1720]],
  81: [
    ["review-pinned-equality-act-2010-s13", 0, 365],
    ["review-pinned-equality-act-2010-ss61-63", 0, 900],
  ],
  82: [
    ["review-pinned-equality-act-2010-s13", 0, 365],
    ["review-v3-equality-age-exceptions-order-2010", 0, 1720],
  ],
  83: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-pinned-equality-act-2010-ss61-63", 0, 900],
  ],
  84: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-v3-tpr-dispute-resolution-full", 300, 1600],
  ],
  85: [["review-v3-tpr-dispute-resolution-full", 1051, 1600]],
  86: [
    ["review-pinned-part-time-workers-regs-2000", 0, 1689],
    ["review-pinned-preston-c78-98", 0, 1382],
  ],
  87: [["review-pinned-part-time-workers-regs-2000", 0, 1689]],
  88: [["review-pinned-preston-c78-98", 0, 1382]],
  89: [
    ["review-pinned-part-time-workers-regs-2000", 0, 1689],
    ["review-pinned-preston-c78-98", 0, 1382],
  ],
  90: [
    ["official-equality-act-2010_chunk_454", 0, 1491],
    ["review-v3-walker-v-innospec", 0, 562],
    ["review-v3-walker-v-innospec", 7413, 8029],
  ],
  91: [
    ["official-equality-act-2010_chunk_454", 0, 1491],
    ["review-v3-walker-v-innospec", 0, 562],
    ["review-v3-walker-v-innospec", 7413, 8029],
  ],
  92: [
    ["official-equality-act-2010_chunk_454", 0, 1491],
    ["review-v3-walker-v-innospec", 0, 562],
    ["review-v3-walker-v-innospec", 7413, 8029],
  ],
  93: [
    ["official-equality-act-2010_chunk_454", 0, 1491],
    ["review-v3-walker-v-innospec", 0, 562],
    ["review-v3-walker-v-innospec", 7413, 8029],
  ],
  94: [["review-pinned-dda1995-s4h-ni", 0, 1160]],
  95: [["review-pinned-dda1995-s4h-ni", 0, 1160]],
  96: [
    ["official-pensions-northern-ireland-order-1995_chunk_51", 0, 3515],
    ["official-pensions-northern-ireland-order-1995_chunk_54", 0, 2121],
    ["review-v3-ni-idrp-regulations-reg2", 0, 1366],
  ],
  97: [
    ["review-pinned-dda1995-s4h-ni", 0, 1160],
    ["review-v3-ni-idrp-regulations-reg2", 0, 1366],
  ],
  98: [
    ["review-v3-hmrc-remedy-adjustment-service", 0, 928],
    ["review-v3-hmrc-mccloud-scheme-pays-july-2026", 0, 892],
  ],
  99: [["review-v3-hmrc-remedy-adjustment-service", 0, 928]],
  100: [
    ["review-v3-hmrc-mccloud-scheme-pays-july-2026", 0, 892],
    ["review-v3-mccloud-si-2026-673", 0, 2406],
  ],
  101: [
    ["review-v3-hmrc-mccloud-scheme-pays-july-2026", 0, 892],
    ["review-v3-mccloud-si-2026-673", 0, 2406],
  ],
  102: [
    ["review-v3-hmrc-remedy-adjustment-service", 0, 928],
    ["review-v3-hmrc-mccloud-scheme-pays-july-2026", 0, 892],
    ["review-v3-mccloud-si-2026-673", 0, 2406],
  ],

  103: [
    ["official-pension-schemes-act-2026_chunk_212", 0, 1938],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_2", 39, 616],
  ],
  104: [["official-pension-schemes-act-2026_chunk_212", 0, 1938]],
  105: [["official-tpr-pension-schemes-act-2026-status-page_chunk_2", 39, 616]],
  106: [
    ["official-pension-schemes-act-2026_chunk_212", 0, 1938],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_2", 39, 616],
  ],
  107: [
    ["official-pension-schemes-act-2026_chunk_20", 0, 1650],
    ["official-pension-schemes-act-2026_chunk_22", 0, 576],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_4", 285, 576],
  ],
  108: [
    ["review-v3-psa2026-s133", 0, 1400],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_4", 0, 576],
  ],
  109: [
    ["official-pension-schemes-act-2026_chunk_20", 0, 1650],
    ["official-pension-schemes-act-2026_chunk_22", 0, 576],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_4", 0, 576],
    ["review-v3-psa2026-s133", 0, 1400],
  ],
  110: [
    ["official-pension-schemes-act-2026_chunk_212", 0, 650],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_13", 55, 627],
  ],
  111: [
    ["review-v3-pa1995-s37", 0, 3436],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_13", 55, 627],
  ],
  112: [
    ["official-pension-schemes-act-2026_chunk_16", 0, 1760],
    ["official-pension-schemes-act-2026_chunk_212", 0, 650],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_13", 55, 627],
    ["review-v3-pa1995-s37", 0, 3436],
  ],

  113: [["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 0, 700]],
  114: [
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_12", 128, 380],
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_12", 2368, 2768],
  ],
  115: [["review-v4-tpr-reporting-breaches-complete", 4024, 4900]],
  116: [
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 1100, 1687],
    ["review-v3-tpr-dashboard-post-connection", 0, 477],
  ],
  117: [["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 2099, 2740]],
  118: [["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 1687, 2099]],
  119: [
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 0, 700],
    ["review-v3-tpr-dashboard-post-connection", 0, 477],
  ],
  120: [
    ["review-v4-tpr-reporting-breaches-complete", 0, 5600],
    ["review-v3-tpr-dispute-resolution-full", 300, 1600],
  ],
  121: [
    ["review-v3-tpr-dashboard-public-status", 0, 413],
    ["review-v3-tpr-dashboard-post-connection", 0, 477],
  ],
  122: [
    ["official-gb-pensions-dashboards-regulations-2022_chunk_7", 0, 1392],
    ["review-v3-tpr-dashboard-public-status", 0, 413],
  ],
  123: [["review-v3-tpr-dashboard-post-connection", 0, 477]],
  124: [["official-gb-pensions-dashboards-regulations-2022_chunk_36", 0, 1841]],
  125: [["review-v4-tpr-reporting-breaches-complete", 0, 5600]],
  126: [["review-v4-tpr-reporting-breaches-complete", 1310, 5600]],
  127: [
    ["review-v4-tpr-reporting-breaches-complete", 0, 5600],
    ["review-pinned-tpr-dispute-resolution-process", 300, 1600],
  ],
};

// Consolidated 127/127 Wave 2 substantive-retention pass.  Only mappings whose
// lexical v7 excerpt was incomplete, misleadingly narrow, or structurally weak
// need an override here; all others retain the already-reviewed exact compact
// span.  Offsets are root-19 JavaScript string offsets, start-inclusive and
// end-exclusive.  Repeated exact ranges are intentional so the downstream
// renderer can de-duplicate them per item.
const reviewedSpans = {
  2: [["review-v3-hmrc-ptm023300", 3523, 4512]],
  4: [
    ["review-v3-hmrc-ptm023200", 333, 516],
    ["review-v3-hmrc-ptm023200", 1418, 2361],
    ["review-v3-hmrc-ptm023200", 4402, 4585],
  ],
  5: [["official-pension-schemes-act-1993_chunk_3", 0, 1955]],
  6: [["official-pension-schemes-act-1993_chunk_3", 0, 1955]],
  7: [["official-pension-schemes-act-1993_chunk_3", 0, 1955]],
  8: [["official-pension-schemes-act-2017_chunk_3", 0, 505]],
  10: [
    ["official-hmrc-ptm-ptm020000_chunk_41", 307, 535],
    ["official-hmrc-ptm-ptm020000_chunk_41", 2225, 2934],
    ["review-v3-hmrc-ptm023200", 3103, 3717],
  ],
  11: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  12: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  13: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  14: [["review-pinned-gb-dashboard-regulations-sch3-p4", 0, 709]],
  15: [
    ["review-v3-psa1993-s1", 0, 1955],
    ["review-v3-pspa2013-ss1-8", 0, 717],
  ],
  16: [["review-v3-pspa2013-ss1-8", 0, 717]],
  17: [
    ["review-v3-psa1993-s1", 0, 1955],
    ["review-v3-pspa2013-ss1-8", 10855, 11069],
  ],
  18: [
    ["review-v3-dwp-gar-classification-valuation", 63, 600],
    ["review-v3-dwp-gar-classification-valuation", 7557, 8414],
  ],
  19: [["review-v3-dwp-gar-classification-valuation", 7557, 8414]],
  20: [
    ["review-v3-dwp-gar-classification-valuation", 9611, 10403],
    ["official-pension-schemes-act-2015_chunk_57", 90, 809],
  ],
  21: [
    ["review-v3-dwp-gar-classification-valuation", 5814, 6162],
    ["review-v3-dwp-gar-classification-valuation", 9611, 10403],
  ],
  22: [
    ["review-pinned-tpr-general-code-conflicts", 2725, 3288],
    ["review-pinned-tpr-general-code-conflicts", 9493, 9723],
  ],
  23: [
    ["review-pinned-tpr-general-code-conflicts", 3774, 5169],
    ["review-pinned-tpr-general-code-conflicts", 5397, 6268],
    ["review-pinned-tpr-general-code-conflicts", 6616, 7369],
    ["review-pinned-tpr-general-code-conflicts", 7369, 7818],
    ["review-pinned-tpr-general-code-conflicts", 8773, 8957],
  ],
  25: [
    ["review-v3-tpr-managing-service-providers-full", 2786, 3046],
    ["review-v3-tpr-managing-service-providers-full", 3849, 4255],
    ["review-v3-tpr-managing-service-providers-full", 5115, 5281],
    ["review-v3-tpr-dispute-resolution-full", 2424, 2486],
  ],
  26: [
    ["review-v3-tpr-managing-service-providers-full", 993, 1268],
    ["review-v3-tpr-managing-service-providers-full", 1522, 1708],
  ],
  28: [
    ["official-tpo-cas-92123-h9g1_chunk_6", 152, 884],
    ["official-tpo-cas-92123-h9g1_chunk_6", 1559, 2205],
  ],
  29: [["review-pinned-edge-discretion-principle", 941, 1626]],
  30: [
    ["review-pinned-edge-discretion-principle", 941, 1626],
    ["review-v3-tpr-dispute-resolution-full", 2487, 2715],
  ],
  31: [
    ["review-v3-investment-regulations-2005-reg4", 41, 727],
    ["review-pinned-tpr-general-code-conflicts", 5397, 5785],
  ],
  36: [["review-pinned-tpr-general-code-conflicts", 5397, 5785]],
  37: [["review-pinned-tpr-general-code-conflicts", 3774, 5169]],
  38: [["official-tpr-scheme-continuity-planning_chunk_3", 0, 2710]],
  39: [["official-tpr-scheme-continuity-planning_chunk_3", 0, 2710]],
  40: [["official-tpr-scheme-continuity-planning_chunk_3", 0, 2710]],
  43: [
    ["review-v3-tpr-own-risk-assessment", 56, 407],
    ["review-v3-tpr-own-risk-assessment", 1682, 2468],
    ["review-v3-tpr-cyber-controls", 3123, 4244],
  ],
  47: [
    ["official-pensions-act-2004_chunk_314", 0, 358],
    ["official-pensions-act-2004_chunk_318", 0, 1008],
    ["review-v3-pa2004-s227-228", 0, 435],
  ],
  48: [["review-v3-pa1995-s67", 0, 1098]],
  49: [
    ["review-v3-tpr-employer-covenant-transaction", 55, 619],
    ["review-v3-tpr-employer-covenant-transaction", 4173, 4945],
    ["review-pinned-pa2004-corporate-transaction-powers", 0, 639],
    ["review-pinned-pa2004-corporate-transaction-powers", 7709, 8562],
    ["review-pinned-pa2004-corporate-transaction-powers", 9458, 9851],
    ["official-pensions-regulator-notifiable-events-regulations-2005_chunk_3", 1776, 3164],
  ],
  50: [
    ["review-v3-tpr-employer-covenant-transaction", 55, 619],
    ["review-v3-tpr-employer-covenant-transaction", 4173, 4945],
    ["review-v3-tpr-employer-covenant-transaction", 5397, 5664],
  ],
  51: [
    ["review-v3-employer-debt-regulations-reg6e", 0, 3922],
    ["review-v3-employer-debt-regulations-reg6e", 4158, 5104],
  ],
  52: [
    ["review-v3-employer-debt-regulations-reg6e", 0, 3922],
    ["review-v3-employer-debt-regulations-reg6e", 4158, 5104],
  ],
  53: [["review-v3-employer-debt-regulations-reg6za", 2762, 3199]],
  54: [
    ["review-v3-employer-debt-regulations-reg6e", 0, 3922],
    ["review-v3-employer-debt-regulations-reg6e", 4158, 5104],
    ["review-v3-employer-debt-regulations-reg6za", 2762, 3199],
  ],
  58: [
    ["official-pensions-act-1995_chunk_140", 0, 1177],
    ["review-v3-pa2004-s227-228", 0, 435],
  ],
  59: [
    ["official-pensions-act-1995_chunk_140", 0, 1177],
    ["review-v3-pa2004-s227-228", 0, 435],
  ],
  60: [["official-pensions-act-1995_chunk_140", 0, 1177]],
  61: [
    ["review-v3-pa2004-s227-228", 0, 435],
    ["review-v3-pa2004-s227-228", 908, 1135],
  ],
  62: [
    ["official-pensions-act-1995_chunk_140", 0, 1177],
    ["review-v3-pa2004-s227-228", 0, 435],
  ],
  63: [
    ["official-pensions-act-1995_chunk_140", 558, 1177],
    ["official-pensions-act-1995_chunk_141", 0, 890],
    ["review-v3-pa2004-s227-228", 0, 435],
    ["review-v3-pa2004-s227-228", 3028, 3779],
  ],
  64: [
    ["official-pensions-act-1995_chunk_141", 0, 647],
    ["review-v3-pa2004-s227-228", 3271, 3590],
    ["review-v4-tpr-reporting-breaches-complete", 19, 246],
    ["review-v4-tpr-reporting-breaches-complete", 1181, 1399],
  ],
  65: [
    ["review-v3-ni-order-2005-arts34-38", 0, 255],
    ["review-pinned-pa2004-corporate-transaction-powers", 0, 255],
  ],
  66: [
    ["review-v3-ni-order-2005-arts34-38", 0, 255],
    ["review-pinned-pa2004-corporate-transaction-powers", 0, 255],
  ],
  67: [
    ["review-v3-ni-order-2005-arts34-38", 0, 255],
    ["review-v3-ni-order-2005-arts34-38", 49234, 50088],
  ],
  68: [
    ["review-v3-ni-order-2005-arts39-47", 0, 1124],
    ["review-v3-ni-order-2005-arts39-47", 13171, 14009],
  ],
  69: [
    ["review-v3-ni-order-2005-arts64-65", 0, 845],
    ["review-v3-ni-order-2005-arts64-65", 5503, 6835],
  ],
  70: [["review-pinned-pa2004-corporate-transaction-powers", 0, 255]],
  71: [
    ["review-v3-funding-regulations-2024-reg20", 2571, 2717],
    ["review-v3-funding-regulations-2024-reg20", 3814, 4016],
  ],
  72: [
    ["review-v3-funding-regulations-2024-reg20", 2789, 3349],
    ["review-v3-tpr-db-recovery-plans", 340, 1825],
  ],
  73: [["review-v3-tpr-db-recovery-plans", 340, 1825]],
  74: [["review-v3-tpr-db-recovery-plans", 340, 1825]],
  75: [
    ["review-v3-funding-regulations-2024-reg20", 2571, 2717],
    ["review-v3-funding-regulations-2024-reg20", 3814, 4016],
  ],
  76: [
    ["review-v3-funding-regulations-2024-reg20", 2571, 2717],
    ["review-v3-funding-regulations-2024-reg20", 3814, 4016],
  ],
  77: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-pinned-equality-act-2010-ss61-63", 0, 2159],
  ],
  78: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-pinned-equality-act-2010-ss61-63", 0, 2159],
  ],
  81: [
    ["review-pinned-equality-act-2010-s13", 0, 365],
    ["review-pinned-equality-act-2010-ss61-63", 0, 2159],
  ],
  83: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-pinned-equality-act-2010-ss61-63", 0, 2159],
  ],
  84: [
    ["review-pinned-equality-act-2010-s20", 326, 1518],
    ["review-v3-tpr-dispute-resolution-full", 280, 869],
  ],
  85: [["review-v3-tpr-dispute-resolution-full", 870, 1542]],
  96: [
    ["official-pensions-northern-ireland-order-1995_chunk_51", 0, 1005],
    ["official-pensions-northern-ireland-order-1995_chunk_54", 0, 733],
    ["review-v3-ni-idrp-regulations-reg2", 0, 1366],
  ],
  97: [
    ["review-pinned-dda1995-s4h-ni", 0, 1160],
    ["review-v3-ni-idrp-regulations-reg2", 0, 1366],
  ],
  98: [
    ["review-v3-hmrc-remedy-adjustment-service", 104, 527],
    ["review-v3-hmrc-mccloud-scheme-pays-july-2026", 0, 782],
  ],
  99: [["review-v3-hmrc-remedy-adjustment-service", 104, 527]],
  100: [["review-v3-hmrc-mccloud-scheme-pays-july-2026", 0, 282]],
  101: [["review-v3-hmrc-mccloud-scheme-pays-july-2026", 283, 782]],
  102: [
    ["review-v3-hmrc-remedy-adjustment-service", 104, 527],
    ["review-v3-hmrc-mccloud-scheme-pays-july-2026", 0, 782],
  ],
  103: [
    ["official-pension-schemes-act-2026_chunk_212", 30, 391],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_2", 39, 616],
  ],
  104: [["official-pension-schemes-act-2026_chunk_212", 30, 391]],
  105: [["official-tpr-pension-schemes-act-2026-status-page_chunk_2", 423, 616]],
  106: [
    ["official-pension-schemes-act-2026_chunk_212", 30, 391],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_2", 423, 616],
  ],
  107: [["official-tpr-pension-schemes-act-2026-status-page_chunk_4", 46, 523]],
  108: [
    ["review-v3-psa2026-s133", 0, 391],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_4", 0, 824],
  ],
  109: [
    ["official-pension-schemes-act-2026_chunk_20", 0, 1650],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_4", 46, 523],
    ["review-v3-psa2026-s133", 0, 391],
  ],
  110: [["official-tpr-pension-schemes-act-2026-status-page_chunk_13", 55, 627]],
  111: [
    ["review-v3-pa1995-s37", 0, 1711],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_13", 55, 627],
  ],
  112: [
    ["official-pension-schemes-act-2026_chunk_16", 0, 1549],
    ["review-v3-pa1995-s37", 0, 1711],
    ["official-tpr-pension-schemes-act-2026-status-page_chunk_13", 55, 627],
  ],
  114: [
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_12", 128, 277],
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_12", 2366, 2768],
  ],
  115: [["review-v4-tpr-reporting-breaches-complete", 4047, 4283]],
  116: [
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 978, 1685],
    ["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 2363, 2740],
    ["review-v3-tpr-dashboard-post-connection", 0, 221],
  ],
  117: [["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 2363, 2740]],
  118: [["official-tpr-pensions-dashboards-guidance-2026_chunk_13", 1687, 2095]],
  119: [["review-v3-tpr-dashboard-post-connection", 0, 221]],
  120: [
    ["review-v4-tpr-reporting-breaches-complete", 19, 246],
    ["review-v4-tpr-reporting-breaches-complete", 1423, 2244],
    ["review-v4-tpr-reporting-breaches-complete", 4024, 5654],
    ["review-v3-tpr-dispute-resolution-full", 280, 535],
  ],
  124: [["official-gb-pensions-dashboards-regulations-2022_chunk_36", 0, 1841]],
  125: [
    ["review-v4-tpr-reporting-breaches-complete", 19, 246],
    ["review-v4-tpr-reporting-breaches-complete", 1423, 2244],
    ["review-v4-tpr-reporting-breaches-complete", 4024, 5654],
  ],
  126: [
    ["review-v4-tpr-reporting-breaches-complete", 19, 246],
    ["review-v4-tpr-reporting-breaches-complete", 1423, 2244],
  ],
  127: [
    ["review-v4-tpr-reporting-breaches-complete", 19, 246],
    ["review-pinned-tpr-dispute-resolution-process", 280, 869],
  ],
};

const itemRegisterBytes = fs.readFileSync(itemRegisterPath);
const sourceRegisterBytes = fs.readFileSync(sourceRegisterPath);
const itemRegister = JSON.parse(itemRegisterBytes);
const provisional = JSON.parse(fs.readFileSync(provisionalPath));
const wave2Items = itemRegister.items.filter((item) => item.wave === 2);
const mappings = wave2Items.flatMap((item) =>
  item.proposition_source_candidates.map((mapping) => ({ item, mapping })),
);
if (wave2Items.length !== 33 || mappings.length !== 127) {
  throw new Error(
    `Expected 33 Wave 2 items and 127 mappings; found ${wave2Items.length} and ${mappings.length}.`,
  );
}

const canonicalRecordSha256 = (value) => sha256(JSON.stringify(value));
const uniqueWave2EvidenceRecords = (items) => {
  const byId = new Map();
  for (const item of items) {
    for (const source of item.retrieved_evidence || []) {
      const prior = byId.get(source.source_id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(source)) {
        throw new Error(`Conflicting Wave 2 evidence record ${source.source_id}.`);
      }
      byId.set(source.source_id, source);
    }
  }
  return [...byId.entries()].sort(([left], [right]) => left.localeCompare(right));
};
const currentWave2ItemRecordsSha256 = canonicalRecordSha256(wave2Items);
const currentWave2EvidenceRecords = uniqueWave2EvidenceRecords(wave2Items);
const currentWave2EvidenceRecordsSha256 = canonicalRecordSha256(
  currentWave2EvidenceRecords,
);
let priorByteIdentity = null;
if (priorFullRoot) {
  const priorRegisterPath = path.join(
    priorFullRoot,
    "cumulative-visible-item-register.json",
  );
  const priorRegister = JSON.parse(fs.readFileSync(priorRegisterPath));
  const priorWave2Items = priorRegister.items.filter((item) => item.wave === 2);
  const priorWave2EvidenceRecords = uniqueWave2EvidenceRecords(priorWave2Items);
  priorByteIdentity = {
    prior_item_register_path: path.relative(workspaceRoot, priorRegisterPath),
    prior_wave_2_item_records_sha256: canonicalRecordSha256(priorWave2Items),
    current_wave_2_item_records_sha256: currentWave2ItemRecordsSha256,
    wave_2_item_records_identical:
      JSON.stringify(priorWave2Items) === JSON.stringify(wave2Items),
    prior_wave_2_unique_evidence_records_sha256:
      canonicalRecordSha256(priorWave2EvidenceRecords),
    current_wave_2_unique_evidence_records_sha256:
      currentWave2EvidenceRecordsSha256,
    wave_2_unique_evidence_records_identical:
      JSON.stringify(priorWave2EvidenceRecords) ===
      JSON.stringify(currentWave2EvidenceRecords),
    unique_evidence_record_count: currentWave2EvidenceRecords.length,
  };
  if (
    !priorByteIdentity.wave_2_item_records_identical ||
    !priorByteIdentity.wave_2_unique_evidence_records_identical
  ) {
    throw new Error(
      `Wave 2 records differ between ${bindingLabel} and the supplied prior root.`,
    );
  }
}

const provisionalMappingByKey = new Map(
  provisional.proposition_mappings.map((mapping) => [
    key(mapping.training_id, mapping.proposition),
    mapping,
  ]),
);
const provisionalExcerptById = new Map(
  provisional.excerpts.map((excerpt) => [excerpt.excerpt_id, excerpt]),
);

const decisions = mappings.map(({ item, mapping }, offset) => {
  const mappingIndex = offset + 1;
  const sourceById = new Map(
    item.retrieved_evidence.map((source) => [source.source_id, source]),
  );
  const explicit = reviewedSpans[mappingIndex];
  let rawSpans;
  let provisionalDecision;
  if (explicit) {
    rawSpans = explicit;
    provisionalDecision =
      "reviewed_exact_span_replacement_after_substantive_parent_source_audit";
  } else {
    const inherited = provisionalMappingByKey.get(
      key(item.training_id, mapping.proposition),
    );
    if (!inherited) {
      throw new Error(
        `Mapping ${mappingIndex} has no reviewed override or provisional span: ${item.training_id}`,
      );
    }
    rawSpans = inherited.excerpt_ids.map((excerptId) => {
      const excerpt = provisionalExcerptById.get(excerptId);
      if (!excerpt) throw new Error(`Missing provisional excerpt ${excerptId}.`);
      return [excerpt.parent_source_id, excerpt.start, excerpt.end];
    });
    provisionalDecision =
      "reviewed_exact_span_selection_retained_after_substantive_parent_source_audit";
  }

  const recommendedSpans = rawSpans.map(([parentSourceId, requestedStart, requestedEnd]) => {
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
    const start = requestedStart;
    const end = requestedEnd;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > parent.text.length
    ) {
      throw new Error(
        `Invalid span ${parentSourceId} [${start},${end}] of ${parent.text.length} for mapping ${mappingIndex}.`,
      );
    }
    const text = parent.text.slice(start, end);
    const fullSourceSha256 = sha256(parent.text);
    if (
      parent.content_sha256 &&
      parent.content_sha256 !== fullSourceSha256
    ) {
      throw new Error(
        `Parent hash mismatch for ${parentSourceId}: ${parent.content_sha256} != ${fullSourceSha256}.`,
      );
    }
    return {
      parent_source_id: parentSourceId,
      full_source_sha256: fullSourceSha256,
      start,
      end,
      excerpt_sha256: sha256(text),
      text,
    };
  });
  const selectedParentSourceIds = [
    ...new Set(recommendedSpans.map((span) => span.parent_source_id)),
  ];
  if (!selectedParentSourceIds.length) {
    throw new Error(`Mapping ${mappingIndex} has no selected parent source.`);
  }
  for (const sourceId of selectedParentSourceIds) {
    if (!mapping.source_ids.includes(sourceId)) {
      throw new Error(`Mapping ${mappingIndex} selected an unmapped source ${sourceId}.`);
    }
    if (!recommendedSpans.some((span) => span.parent_source_id === sourceId)) {
      throw new Error(`Mapping ${mappingIndex} lacks a span for ${sourceId}.`);
    }
  }

  return {
    mapping_index: mappingIndex,
    training_id: item.training_id,
    proposition: mapping.proposition,
    proposition_sha256: sha256(mapping.proposition),
    mapped_source_ids: mapping.source_ids,
    support_relationship: mapping.support_relationship,
    selected_parent_source_ids: selectedParentSourceIds,
    provisional_decision: provisionalDecision,
    recommended_spans: recommendedSpans,
    passed: false,
  };
});

const seen = new Set();
for (const decision of decisions) {
  const decisionKey = key(decision.training_id, decision.proposition);
  if (seen.has(decisionKey)) throw new Error(`Duplicate decision ${decisionKey}.`);
  seen.add(decisionKey);
  if (
    decision.proposition_sha256 !== sha256(decision.proposition) ||
    !decision.selected_parent_source_ids.length ||
    !decision.recommended_spans.length ||
    decision.passed !== false
  ) {
    throw new Error(`Fail-closed decision contract failed at mapping ${decision.mapping_index}.`);
  }
}

const result = {
  version: recommendationVersion,
  generated_at: new Date().toISOString(),
  status: recommendationStatus,
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
    wave_2_items: wave2Items.length,
    expected_mappings: 127,
    reviewed_mappings: decisions.length,
    exact_span_decisions: decisions.filter(
      (decision) => decision.recommended_spans.length > 0,
    ).length,
    substantively_replaced_selections: Object.keys(reviewedSpans).length,
    substantively_retained_selections:
      decisions.length - Object.keys(reviewedSpans).length,
    unresolved: decisions.length,
  },
  prior_root_byte_identity: priorByteIdentity,
  decisions,
  limitation:
    `Owner-authorised developer/source substantive-retention recommendations against immutable ${bindingLabel} parent bytes. They are not an independent legal review and do not approve a compact map, training, release, or unseen access. Every decision remains failed until the rebuilt compact excerpts receive a fresh bound review.`,
};

if (
  result.bindings.item_register_sha256 !== expectedItemRegisterSha256 ||
  result.bindings.full_source_register_sha256 !== expectedSourceRegisterSha256
) {
  throw new Error(`${bindingLabel} binding changed; refusing to write recommendations.`);
}

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
