import { getVerifiedDashboardContext } from "../portfolioStore.js";

function parseMoney(value) {
  const number = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parsePercent(value) {
  const number = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parsePercentRate(value) {
  const number = parsePercent(value);
  return number == null ? null : number / 100;
}

function fact({ factId, value, display, sourceRecordId, sourceScope = "USER_PORTFOLIO", verifiedAt, original = true, jurisdiction = null }) {
  return {
    fact_id: factId,
    value,
    display: display ?? value,
    source_type: "AUTHENTICATED_INFO_DB",
    source_record_id: sourceRecordId,
    source_scope: sourceScope,
    verification_status: "authenticated",
    verified_at: verifiedAt || null,
    original,
    jurisdiction
  };
}

function accountKey(account) {
  const provider = String(account.provider || account.name || "account").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (provider.includes("aviva")) return "aviva";
  if (provider.includes("nest")) return "nest";
  if (provider.includes("standard")) return "standardLife";
  if (provider.includes("onelife") || provider.includes("one_life")) return "oneLife";
  return provider;
}

export function buildCanonicalFacts(userId = "alex-morgan") {
  const dashboard = getVerifiedDashboardContext({ userId });
  const verifiedAt = dashboard.snapshotDate || dashboard.systemUpdate?.date || null;
  const jurisdiction = dashboard.profile?.jurisdiction || null;
  const facts = {};
  const put = (entry) => { facts[entry.fact_id] = entry; };

  put(fact({ factId:"profile.jurisdiction", value:jurisdiction, sourceRecordId:"profile", verifiedAt, jurisdiction }));
  put(fact({ factId:"profile.currentEmployer", value:dashboard.profile?.employer || "", sourceRecordId:"profile", verifiedAt, jurisdiction }));
  put(fact({ factId:"profile.previousEmployer", value:dashboard.profile?.previousEmployer || "", sourceRecordId:"profile", verifiedAt, jurisdiction }));
  put(fact({ factId:"profile.salary", value:parseMoney(dashboard.assumptions?.salary), display:dashboard.assumptions?.salary, sourceRecordId:"assumptions", verifiedAt }));

  for (const account of dashboard.pensionAccounts || []) {
    const key = accountKey(account);
    const prefix = `accounts.${key}`;
    put(fact({ factId:`${prefix}.name`, value:account.name, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.provider`, value:account.provider, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.type`, value:account.type, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.status`, value:account.schemeStatus, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.employer`, value:account.employerName || "", sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.pot`, value:parseMoney(account.pot), display:account.pot, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.charge`, value:parsePercentRate(account.charges), display:account.charges, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.employeeContributionPercent`, value:parsePercent(account.employee), display:account.employee, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.employerContributionPercent`, value:parsePercent(account.employer), display:account.employer, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.policyNumber`, value:account.policy, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.lastUpdated`, value:account.lastUpdated, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.style`, value:account.style, sourceRecordId:account.id, verifiedAt }));
    put(fact({ factId:`${prefix}.source`, value:account.source, sourceRecordId:account.id, verifiedAt }));
  }

  for (const document of dashboard.documents || []) {
    const key = accountKey(document);
    put(fact({ factId:`documents.${key}.name`, value:document.name, sourceRecordId:document.id, verifiedAt }));
    put(fact({ factId:`documents.${key}.status`, value:document.status, sourceRecordId:document.id, verifiedAt }));
    put(fact({ factId:`documents.${key}.confidence`, value:document.confidence, sourceRecordId:document.id, verifiedAt }));
  }

  put(fact({ factId:"derivedFacts.totalPots", value:parseMoney(dashboard.pensionPotValue), display:dashboard.pensionPotValue, sourceRecordId:"projection", verifiedAt, original:false }));
  put(fact({ factId:"derivedFacts.workplacePotsTotal", value:parseMoney(dashboard.potBreakdown?.workplacePensions), display:dashboard.potBreakdown?.workplacePensions, sourceRecordId:"projection", verifiedAt, original:false }));
  put(fact({ factId:"derivedFacts.personalPotsTotal", value:parseMoney(dashboard.potBreakdown?.personalPensions), display:dashboard.potBreakdown?.personalPensions, sourceRecordId:"projection", verifiedAt, original:false }));
  put(fact({ factId:"statePension.forecastMonthly", value:parseMoney(dashboard.statePension?.monthlyIncome), display:dashboard.statePension?.monthlyIncome, sourceRecordId:"statePension", verifiedAt }));
  put(fact({ factId:"projection.retirementAge", value:dashboard.assumptions?.retirementAge, sourceRecordId:"projection", verifiedAt }));
  put(fact({ factId:"projection.targetMonthlyIncome", value:parseMoney(dashboard.monthlyTarget), display:dashboard.monthlyTarget, sourceRecordId:"projection", verifiedAt, original:false }));
  put(fact({ factId:"projection.projectedMonthlyIncome", value:parseMoney(dashboard.projectedMonthlyIncome), display:dashboard.projectedMonthlyIncome, sourceRecordId:"projection", verifiedAt, original:false }));
  put(fact({ factId:"projection.monthlyGap", value:parseMoney(dashboard.monthlyGap), display:dashboard.monthlyGap, sourceRecordId:"projection", verifiedAt, original:false }));
  put(fact({ factId:"projection.currentAssumedMonthlyContribution", value:parseMoney(dashboard.assumptions?.monthlyContribution), display:dashboard.assumptions?.monthlyContribution, sourceRecordId:"projection", verifiedAt, original:false }));
  put(fact({ factId:"projection.assumptions.growth", value:parsePercentRate(dashboard.assumptions?.growthPct), display:dashboard.assumptions?.growthPct, sourceRecordId:"projection", verifiedAt }));
  put(fact({ factId:"projection.assumptions.inflation", value:parsePercentRate(dashboard.assumptions?.inflationPct), display:dashboard.assumptions?.inflationPct, sourceRecordId:"projection", verifiedAt }));
  put(fact({ factId:"projection.assumptions.charge", value:parsePercentRate(dashboard.assumptions?.chargePct), display:dashboard.assumptions?.chargePct, sourceRecordId:"projection", verifiedAt }));
  put(fact({ factId:"projection.assumptions.drawdown", value:parsePercentRate(dashboard.assumptions?.drawdownPct), display:dashboard.assumptions?.drawdownPct, sourceRecordId:"projection", verifiedAt }));

  for (const scenario of dashboard.contributionScenarios || []) {
    const extra = Number(scenario.extraMonthlyContributionValue || parseMoney(scenario.extraMonthlyContribution));
    put(fact({ factId:`projection.scenarios.extra${extra}.remainingGap`, value:parseMoney(scenario.monthlyGap), display:scenario.monthlyGap, sourceRecordId:"projection", verifiedAt, original:false }));
    put(fact({ factId:`projection.scenarios.extra${extra}.projectedMonthlyIncome`, value:parseMoney(scenario.projectedMonthlyIncome), display:scenario.projectedMonthlyIncome, sourceRecordId:"projection", verifiedAt, original:false }));
  }

  put(fact({ factId:"cashBuffer.savings", value:parseMoney(dashboard.savings?.currentSavings), display:dashboard.savings?.currentSavings, sourceRecordId:"savings", verifiedAt }));
  put(fact({ factId:"cashBuffer.monthsCovered", value:Number(dashboard.savings?.monthsCovered), display:dashboard.savings?.monthsCovered, sourceRecordId:"savings", verifiedAt, original:false }));
  put(fact({ factId:"cashBuffer.targetMonths", value:3, sourceRecordId:"savings", verifiedAt }));

  const reviewDocs = (dashboard.documents || []).filter((item) => /review/i.test(item.status));
  put(fact({ factId:"documents.reviewCount", value:reviewDocs.length, sourceRecordId:"documents", verifiedAt, original:false }));

  return {
    version: "canonical-facts-v1",
    userId: dashboard.userId,
    verifiedAt,
    jurisdiction,
    facts,
    dashboard
  };
}

export function factDisplay(registry, factId) {
  return registry?.facts?.[factId]?.display ?? registry?.facts?.[factId]?.value ?? null;
}
