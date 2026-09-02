import { getVerifiedDashboardContext } from "../portfolioStore.js";
import { readActions, readRiskProfile, appendAuditEvent } from "../store/userDataStore.js";
import { moneyToNumber, normaliseStyle, percentToNumber, daysSince, isoNow } from "../utils/values.js";
import { syncActionsFromAgent, sortActions } from "./actionService.js";
import { syncNotificationsFromAgent } from "./notificationService.js";

function check(id, category, severity, title, detail, linkedView = "overview", meta = {}) {
  return { id, category, severity, title, detail, linkedView, meta };
}

function priorityForSeverity(severity) {
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

function actionCandidateFromCheck(item) {
  return {
    sourceKey: item.id,
    category: item.category,
    priority: priorityForSeverity(item.severity),
    title: item.title,
    detail: item.detail,
    linkedView: item.linkedView
  };
}

function notificationCandidateFromCheck(item) {
  const preferenceKey = item.category === "documents"
    ? "documentReview"
    : item.category === "investment"
      ? "investmentReview"
      : item.category === "projection"
        ? "projectionUpdates"
        : "actionNeeded";
  return {
    sourceKey: item.id,
    category: item.category,
    preferenceKey,
    priority: priorityForSeverity(item.severity),
    title: item.title,
    body: item.detail,
    linkedView: item.linkedView
  };
}

function currentStyle(dashboard) {
  return normaliseStyle(dashboard?.investmentProfile?.currentStyle || "");
}

function buildAssistantContext({ dashboard, riskProfile, checks, nextBestAction }) {
  const profile = dashboard.investmentProfile || {};
  const issueCounts = checks.reduce((counts, item) => {
    counts[item.severity] = (counts[item.severity] || 0) + 1;
    return counts;
  }, {});
  const riskStatus = riskProfile?.completed ? "completed" : "missing";
  const summary = [
    `Current investment style: ${profile.currentStyle || "not available"}`,
    `Allocation: ${profile.equityExposure || "not available"} equity, ${profile.bondExposure || "not available"} bonds, ${profile.cashOther || "not available"} cash/other`,
    `Target gap: ${dashboard.monthlyGap || "not available"} per month`,
    `Risk profile: ${riskStatus}`,
    `Documents needing review: ${dashboard.dataQuality?.reviewDocs ?? 0}`,
    `High-charge flags: ${dashboard.dataQuality?.highCharge ?? 0}`,
    `Next best action: ${nextBestAction?.title || "No urgent action"}`
  ].join(". ");

  return {
    generatedAt: isoNow(),
    summary,
    currentInvestmentStyle: profile.currentStyle || "",
    allocation: {
      equity: profile.equityExposure || "",
      bonds: profile.bondExposure || "",
      cashOther: profile.cashOther || ""
    },
    monthlyGap: dashboard.monthlyGap || "",
    riskProfileStatus: riskStatus,
    preferredRiskStyle: riskProfile?.preferredStyle || "",
    issueCounts,
    nextBestAction
  };
}

function actionStillOpen(existingActions = [], candidate) {
  const existing = existingActions.find((action) => action.sourceKey === candidate.sourceKey);
  return !existing || existing.status === "open";
}

export function buildAgentSummaryForDashboard({ dashboard, riskProfile = {}, existingActions = [], now = new Date() } = {}) {
  const checks = [];
  const accounts = Array.isArray(dashboard?.pensionAccounts) ? dashboard.pensionAccounts : [];
  const documents = Array.isArray(dashboard?.documents) ? dashboard.documents : [];
  const monthlyGap = moneyToNumber(dashboard?.monthlyGap);
  const current = currentStyle(dashboard);
  const preferred = normaliseStyle(riskProfile?.preferredStyle || "");
  const reviewDocs = documents.filter((documentItem) => /review|needs|pending/i.test(String(documentItem.status || "")));
  const highChargeAccounts = accounts.filter((account) => percentToNumber(account.charges) >= 0.75);
  const manualAccounts = accounts.filter((account) => !/provider-linked|connected/i.test(String(account.source || "")));
  const manualAccountsUsedInCalculations = manualAccounts.filter((account) => moneyToNumber(account.pot) > 0 || percentToNumber(account.charges) > 0);
  const manualAccountsMissingValues = manualAccounts.filter((account) => moneyToNumber(account.pot) <= 0 && percentToNumber(account.charges) <= 0);
  const staleAccounts = accounts.filter((account) => {
    const age = daysSince(account.lastUpdated, now);
    return age != null && age >= 90;
  });
  const staleStatePension = daysSince(dashboard?.statePension?.lastUpdated, now);

  if (!accounts.length) {
    checks.push(check(
      "pension_accounts_missing",
      "data_quality",
      "high",
      "Add your first pension account",
      "Start with provider, pot value, annual charge and last-updated date so the dashboard can calculate useful projections.",
      "pensions",
      { accountCount: 0 }
    ));
  }

  if (reviewDocs.length) {
    checks.push(check(
      "document_review_required",
      "documents",
      "high",
      reviewDocs.length === 1 ? "Confirm uploaded document facts" : `Confirm facts for ${reviewDocs.length} uploaded documents`,
      "Confirm extracted facts before relying on pot values, charges, policy numbers or contribution figures.",
      "documents",
      { documentCount: reviewDocs.length, documents: reviewDocs.map((doc) => doc.name) }
    ));
  }

  if (highChargeAccounts.length) {
    const providers = highChargeAccounts.map((account) => account.provider).filter(Boolean);
    checks.push(check(
      "high_charge_account",
      "charges",
      "medium",
      providers.length === 1 ? `Check ${providers[0]} charge` : "Check account charges",
      `Review annual charges for ${highChargeAccounts.map((account) => `${account.provider} (${account.charges})`).join(", ")}.`,
      "pensions",
      { accounts: providers, actionable: false }
    ));
  }

  if (manualAccountsUsedInCalculations.length) {
    checks.push(check(
      "manual_account_review",
      "data_quality",
      "high",
      manualAccountsUsedInCalculations.length === 1 ? "Upload statement for manually entered pension" : "Upload statements for manually entered pensions",
      "These values are used in calculations but are not backed by a confirmed provider statement.",
      "documents",
      { accounts: manualAccountsUsedInCalculations.map((account) => account.provider), affectsCalculation: true }
    ));
  }

  if (manualAccountsMissingValues.length) {
    checks.push(check(
      "manual_account_values_missing",
      "data_quality",
      "medium",
      manualAccountsMissingValues.length === 1 ? "Add details for manually entered pension" : "Add details for manually entered pensions",
      "Add pot value, charge and latest statement before using these records in projections.",
      "pensions",
      { accounts: manualAccountsMissingValues.map((account) => account.provider), affectsCalculation: false }
    ));
  }

  if (staleAccounts.length) {
    checks.push(check(
      "provider_data_stale",
      "data_quality",
      "medium",
      staleAccounts.length === 1 ? "Upload recent provider statement" : "Upload recent provider statements",
      "Provider data has not been updated for at least 90 days, so current calculation inputs may be stale.",
      "documents",
      { accounts: staleAccounts.map((account) => ({ provider: account.provider, lastUpdated: account.lastUpdated })) }
    ));
  }

  if (staleStatePension != null && staleStatePension >= 365) {
    checks.push(check(
      "state_pension_forecast_stale",
      "projection",
      "medium",
      "Add updated State Pension forecast",
      "The State Pension forecast is over a year old and should be updated before relying on income projections.",
      "target",
      { lastUpdated: dashboard?.statePension?.lastUpdated }
    ));
  }

  if (monthlyGap > 0) {
    checks.push(check(
      "target_gap_open",
      "projection",
      "medium",
      "Review target gap",
      "The projection still falls short of the monthly target, so contributions, retirement age, investment route and assumptions should be reviewed.",
      "target",
      { monthlyGap: dashboard.monthlyGap, monthlyTarget: dashboard.monthlyTarget, actionable: false }
    ));
  }

  if (riskProfile?.completed && preferred && current && preferred !== current) {
    checks.push(check(
      "style_risk_mismatch",
      "investment",
      "high",
      "Review investment style",
      `Current style is ${dashboard.investmentProfile?.currentStyle}; stored risk preference is ${riskProfile.preferredStyle}. Review whether the portfolio route still fits.`,
      "investments",
      { currentStyle: current, preferredStyle: preferred }
    ));
  }

  if (!checks.length) {
    checks.push(check(
      "dashboard_checked",
      "overview",
      "low",
      "Dashboard checks are currently clear",
      "No urgent document, charge or stale-data issue was detected.",
      "overview"
    ));
  }

  const actionCandidates = checks
    .filter((item) => item.severity !== "low" && item.meta?.actionable !== false)
    .map(actionCandidateFromCheck);
  const notificationCandidates = checks
    .filter((item) => item.meta?.actionable !== false && (item.severity === "high" || item.severity === "medium"))
    .map(notificationCandidateFromCheck)
    .filter((candidate) => actionStillOpen(existingActions, candidate));
  const candidateActions = sortActions(actionCandidates.filter((candidate) => actionStillOpen(existingActions, candidate)).map((candidate) => ({
    ...candidate,
    id: candidate.sourceKey,
    status: "open",
    updatedAt: isoNow()
  })));
  const nextBestAction = candidateActions[0]
    ? {
      title: candidateActions[0].title,
      detail: candidateActions[0].detail,
      priority: candidateActions[0].priority,
      linkedView: candidateActions[0].linkedView,
      sourceKey: candidateActions[0].sourceKey
    }
    : {
      title: "Review dashboard progress",
      detail: "Open the dashboard summary and confirm the latest pension figures are still correct.",
      priority: "low",
      linkedView: "overview",
      sourceKey: "dashboard_checked"
    };

  return {
    generatedAt: isoNow(),
    agentVersion: "agent-1.0",
    status: checks.some((item) => item.severity === "high") ? "action_needed" : checks.some((item) => item.severity === "medium") ? "review_recommended" : "checked",
    watchedAreas: [
      "pension_pots",
      "providers",
      "charges",
      "contributions",
      "state_pension",
      "savings_buffer",
      "target_gap",
      "documents",
      "scan_results",
      "update_history",
      "investment_style",
      "risk_profile"
    ],
    dashboardChecks: checks,
    nextBestAction,
    actionCandidates,
    notificationCandidates,
    assistantContext: buildAssistantContext({ dashboard, riskProfile, checks, nextBestAction }),
    existingOpenActions: existingActions.filter((action) => action.status === "open").length,
    dashboardSnapshot: {
      monthlyGap: dashboard.monthlyGap,
      projectedMonthlyIncome: dashboard.projectedMonthlyIncome,
      pensionPotValue: dashboard.pensionPotValue,
      currentInvestmentStyle: dashboard.investmentProfile?.currentStyle || "",
      riskProfileStatus: riskProfile.completed ? "completed" : "missing",
      documentsNeedingReview: dashboard.dataQuality?.reviewDocs ?? 0,
      highChargeAccounts: dashboard.dataQuality?.highCharge ?? 0
    }
  };
}

export function runAgentForUser({ userId, persist = true, reason = "manual" } = {}) {
  const dashboard = getVerifiedDashboardContext({ userId });
  const riskProfile = readRiskProfile(userId);
  const existingActions = readActions(userId);
  const summary = buildAgentSummaryForDashboard({ dashboard, riskProfile, existingActions });
  let actions = existingActions;
  let notifications = [];

  if (persist) {
    actions = syncActionsFromAgent(userId, summary);
    notifications = syncNotificationsFromAgent(userId, summary);
    appendAuditEvent(userId, {
      type: "agent_run",
      reason,
      agentVersion: summary.agentVersion,
      status: summary.status,
      nextBestAction: summary.nextBestAction,
      checks: summary.dashboardChecks.map((item) => ({ id: item.id, severity: item.severity, title: item.title }))
    });
  }

  return {
    ...summary,
    dashboard,
    riskProfile,
    actions: sortActions(actions.filter((action) => action.status === "open")),
    notifications: notifications.filter((notification) => notification.status !== "dismissed").slice(0, 12)
  };
}
