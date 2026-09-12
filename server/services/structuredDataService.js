import {resolvePortfolioAccounts} from './portfolioEvidenceService.js';
import { describeDocumentEvidence } from "./documentEvidenceService.js";
import { createHash } from "node:crypto";
import { getVerifiedDashboardContext } from "../portfolioStore.js";

function sourceId(label, value) {
  return `structured_${label}_${createHash("sha256").update(String(value)).digest("hex").slice(0, 10)}`;
}

export function lookupStructuredData(userId, queryPlan = {}, snapshot = null) {
  const dashboard = snapshot || getVerifiedDashboardContext({ userId });
  if (dashboard.userId !== userId) throw new Error('Portfolio snapshot user mismatch');
  const lookups = new Set(queryPlan.structured_lookups || []);
  const selection = resolvePortfolioAccounts(dashboard, queryPlan.entities, queryPlan.self_contained_query);
  const accounts = selection.accounts;
  const sources = [];
  if (lookups.has("account") || lookups.has("charges")) {
    sources.push({
      sourceId:sourceId("accounts", `${userId}:${dashboard.snapshotId}:${accounts.map((item) => item.id || item.policy).join("|")}`),
      title:"Pension account records with source status",section:"Authenticated Info DB lookup",scope:"USER_PORTFOLIO",score:1,
      effectiveDate:dashboard.systemUpdate?.date || null,
      snapshotId:dashboard.snapshotId, sourceType:"authenticated_record",
      facts:accounts.map(item=>({accountId:item.id,...item.facts,rawFacts:item.rawFacts,provenance:item.provenance})),
      snippet:(accounts.length ? "" : "No pension accounts are recorded. Contribution amounts, rates and account inputs are missing. ") + accounts.map((item) => queryPlan.legal_evidence_required ? [
        `${item.name} (${item.provider}); account ID ${item.id}`,
        `arrangement ${item.type}; scheme type ${item.schemeType || "not recorded"}; status ${item.schemeStatus || "not recorded"}`,
        `employee contribution ${item.employee}; employer contribution ${item.employer}`,
        `employer ${item.employerName || "not recorded"}; scheme ${item.schemeName || "not recorded"}`,
        `source ${item.source || "unknown"}; record status ${item.provenance?.status || "unknown"}; updated ${item.lastUpdated || "unknown"}`,
        "These records do not establish amendment powers, contractual terms or governing law."
      ].join("; ") : [
        `${item.name} (${item.provider})`,
        item.type,
        item.schemeStatus,
        `policy ${item.policy}`,
        `pot ${item.pot}`,
        `annual charge ${item.charges}`,
        item.employerName ? `employer ${item.employerName}` : "",
        dashboard.profile?.employer ? `current employer ${dashboard.profile.employer}` : "",
        dashboard.profile?.previousEmployer ? `previous employer ${dashboard.profile.previousEmployer}` : "",
        dashboard.profile?.jurisdiction ? `profile jurisdiction ${dashboard.profile.jurisdiction}` : "",
        item.schemeName ? `scheme ${item.schemeName}` : "",
        item.schemeType ? `scheme type ${item.schemeType}` : "",
        item.employee ? `employee contribution ${item.employee}${item.employeeYearly ? ` (${item.employeeYearly})` : ""}` : "",
        item.employer && item.employer !== "—" ? `employer contribution ${item.employer}${item.employerYearly ? ` (${item.employerYearly})` : ""}` : "",
        item.style ? `style ${item.style}` : "",
        Array.isArray(item.allocation) && item.allocation.length ? `allocation ${item.allocation.map((part) => `${part.label} ${part.value}`).join(", ")}` : "",
        `account ID ${item.id}`,
        `record status ${item.provenance?.status || "unknown"}; not independently verified unless a verification receipt is present`,
        `raw facts ${JSON.stringify({...(item.facts || {}),...(item.rawFacts || {})})}`,
        `source ${item.source}`,
        `last updated ${item.lastUpdated}`
      ].filter(Boolean).join("; ")).join("\n") + (!queryPlan.legal_evidence_required && dashboard.statePension?.monthlyIncome != null ? `\nState Pension forecast ${dashboard.statePension.monthlyIncome} a month` : "")
    });
  }
  if (lookups.has("document_status")) sources.push({
    sourceId:sourceId("documents", userId),title:"Document status records",section:"Authenticated Info DB lookup",scope:"USER_PORTFOLIO",score:1,effectiveDate:dashboard.systemUpdate?.date || null,
    snippet:(dashboard.documents || []).filter((item) => !queryPlan.entities?.provider || String(item.provider).toLowerCase() === String(queryPlan.entities.provider).toLowerCase()).map((item) => {
      const extracted = item.extracted || {};
      return [
        item.name,
        describeDocumentEvidence(item),
        item.provider,
        item.type,
        `status ${item.status}`,
        item.confidence ? `confidence ${item.confidence}` : "",
        item.date ? `date ${item.date}` : "",
        extracted.policy ? `policy ${extracted.policy}` : "",
        extracted.potValue != null ? `pot ${extracted.potValue}` : "",
        extracted.employeeContribution ? `employee ${extracted.employeeContribution}` : "",
        extracted.employerContribution ? `employer ${extracted.employerContribution}` : "",
        extracted.chargePct != null ? `charge ${extracted.chargePct}%` : "",
        extracted.scheme ? `scheme ${extracted.scheme}` : "",
        extracted.employer ? `employer ${extracted.employer}` : "",
        extracted.memberAction ? `member action ${extracted.memberAction}` : "",
        extracted.defaultFund ? `default fund ${extracted.defaultFund}` : "",
        extracted.schemeType ? `scheme type ${extracted.schemeType}` : ""
      ].filter(Boolean).join("; ");
    }).join("\n")
  });
  if (lookups.has("projection")) sources.push({
    sourceId:sourceId("projection", JSON.stringify({userId,projection:dashboard.projection})),title:"Deterministic pension projection",section:"Verified calculation service",scope:"USER_PORTFOLIO",score:1,effectiveDate:dashboard.systemUpdate?.date || null,
    snippet:[
      dashboard.projectionMethod || "",
      dashboard.assumptions?.contributionBasis || "",
      `Current pot ${dashboard.pensionPotValue}`,
      `monthly target ${dashboard.monthlyTarget}`,
      `projected monthly income ${dashboard.projectedMonthlyIncome}`,
      `monthly gap ${dashboard.monthlyGap}`,
      `coverage ${dashboard.coverage}`,
      dashboard.statePension?.monthlyIncome != null ? `state pension forecast ${dashboard.statePension.monthlyIncome} a month` : "",
      dashboard.savings?.currentSavings ? `cash buffer ${dashboard.savings.currentSavings}, ${dashboard.savings.monthsCovered} months covered, target 3 months` : "",
      dashboard.assumptions ? `assumptions age ${dashboard.assumptions.currentAge}, retire ${dashboard.assumptions.retirementAge}, salary ${dashboard.assumptions.salary}, contribution ${dashboard.assumptions.monthlyContribution} (${dashboard.assumptions.totalContributionPct}), growth ${dashboard.assumptions.growthPct}, inflation ${dashboard.assumptions.inflationPct}, charges ${dashboard.assumptions.chargePct}` : "",
      Array.isArray(dashboard.contributionScenarios) ? dashboard.contributionScenarios.map((item) => `add ${item.extraMonthlyContribution}/month: final pot ${item.projectedFinalPot}, monthly income ${item.projectedMonthlyIncome}, gap ${item.monthlyGap}`).join("; ") : ""
    ].filter(Boolean).join(". ")
  });
  if (lookups.has("supplemental_records")) sources.push({
    sourceId:sourceId("supplemental_records", `${userId}:${dashboard.snapshotId}`),title:"Authenticated supplemental pension records",section:"Authenticated Info DB lookup",scope:"USER_PORTFOLIO",score:1,
    effectiveDate:dashboard.systemUpdate?.date || null,snapshotId:dashboard.snapshotId,sourceType:"authenticated_record",
    facts:dashboard.supplementalRecords || {},
    snippet:Object.keys(dashboard.supplementalRecords || {}).length
      ? `Supplemental record fields: ${JSON.stringify(dashboard.supplementalRecords)}`
      : "No supplemental pension records are recorded."
  });
  if (lookups.has("investment_profile")) sources.push({
    sourceId:sourceId("investment_profile", userId),title:"Recorded investment and risk profile",section:"Authenticated Info DB lookup",scope:"USER_PORTFOLIO",score:1,effectiveDate:dashboard.systemUpdate?.date || null,
    snippet:[
      dashboard.investmentProfile?.currentStyle ? `current style ${dashboard.investmentProfile.currentStyle}` : "",
      dashboard.investmentProfile?.equityExposure ? `equity ${dashboard.investmentProfile.equityExposure}` : "",
      dashboard.investmentProfile?.bondExposure ? `bonds ${dashboard.investmentProfile.bondExposure}` : "",
      dashboard.investmentProfile?.cashOther ? `cash/other ${dashboard.investmentProfile.cashOther}` : "",
      Array.isArray(dashboard.investmentProfile?.allocation) ? `allocation ${dashboard.investmentProfile.allocation.map((part) => `${part.label} ${part.value}`).join(", ")}` : "",
      Array.isArray(dashboard.investmentProfile?.accountsByStrategy) ? `pots ${dashboard.investmentProfile.accountsByStrategy.map((item) => `${item.account || item[0]} ${item.style || item[1]}`).join("; ")}` : "",
      dashboard.riskProfile?.completed ? `risk profile completed, preferred style ${dashboard.riskProfile.preferredStyle}, horizon ${dashboard.riskProfile.timeHorizonYears} years, loss tolerance ${dashboard.riskProfile.lossTolerancePct}%, goal ${dashboard.riskProfile.mainGoal}` : "risk profile incomplete"
    ].filter(Boolean).join(". ")
  });
  return { sources,trace:{ requested:[...lookups],matchedAccounts:accounts.length,ambiguous:selection.ambiguous,selectedAccountId:selection.selectedAccountId,snapshotId:dashboard.snapshotId } };
}
