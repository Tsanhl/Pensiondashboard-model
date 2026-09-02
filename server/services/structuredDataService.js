import { createHash } from "node:crypto";
import { getVerifiedDashboardContext } from "../portfolioStore.js";

function sourceId(label, value) {
  return `structured_${label}_${createHash("sha256").update(String(value)).digest("hex").slice(0, 10)}`;
}

function selectedAccounts(dashboard, entities = {}) {
  const accounts = dashboard.pensionAccounts || [];
  if (entities.provider) return accounts.filter((item) => String(item.provider).toLowerCase() === String(entities.provider).toLowerCase());
  if (entities.policyNumber) return accounts.filter((item) => String(item.policy).replace(/\s/g, "").toLowerCase() === String(entities.policyNumber).replace(/\s/g, "").toLowerCase());
  return accounts;
}

export function lookupStructuredData(userId, queryPlan = {}) {
  const dashboard = getVerifiedDashboardContext({ userId });
  const lookups = new Set(queryPlan.structured_lookups || []);
  const accounts = selectedAccounts(dashboard, queryPlan.entities);
  const sources = [];
  if (lookups.has("account") || lookups.has("charges")) {
    sources.push({
      sourceId:sourceId("accounts", `${userId}:${accounts.map((item) => item.id || item.policy).join("|")}`),
      title:"Verified pension account records",section:"Authenticated Info DB lookup",scope:"USER_PORTFOLIO",score:1,
      effectiveDate:dashboard.systemUpdate?.date || null,
      snippet:JSON.stringify(accounts.map((item) => ({ provider:item.provider,policy:item.policy,name:item.name,type:item.type,pot:item.pot,charges:item.charges,source:item.source,lastUpdated:item.lastUpdated,isStale:item.isStale })))
    });
  }
  if (lookups.has("document_status")) sources.push({
    sourceId:sourceId("documents", userId),title:"Verified document status records",section:"Authenticated Info DB lookup",scope:"USER_PORTFOLIO",score:1,effectiveDate:dashboard.systemUpdate?.date || null,
    snippet:JSON.stringify((dashboard.documents || []).filter((item) => !queryPlan.entities?.provider || String(item.provider).toLowerCase() === String(queryPlan.entities.provider).toLowerCase()).map((item) => ({ name:item.name,provider:item.provider,status:item.status,date:item.date,confidence:item.confidence })))
  });
  if (lookups.has("projection")) sources.push({
    sourceId:sourceId("projection", userId),title:"Deterministic pension projection",section:"Verified calculation service",scope:"USER_PORTFOLIO",score:1,effectiveDate:dashboard.systemUpdate?.date || null,
    snippet:JSON.stringify({ pensionPotValue:dashboard.pensionPotValue,monthlyTarget:dashboard.monthlyTarget,projectedMonthlyIncome:dashboard.projectedMonthlyIncome,monthlyGap:dashboard.monthlyGap,coverage:dashboard.coverage,assumptions:dashboard.assumptions })
  });
  if (lookups.has("investment_profile")) sources.push({
    sourceId:sourceId("investment_profile", userId),title:"Verified investment and risk profile",section:"Authenticated Info DB lookup",scope:"USER_PORTFOLIO",score:1,effectiveDate:dashboard.systemUpdate?.date || null,
    snippet:JSON.stringify({ investmentProfile:dashboard.investmentProfile,riskProfile:dashboard.riskProfile })
  });
  return { sources,trace:{ requested:[...lookups],matchedAccounts:accounts.length,ambiguous:!queryPlan.entities?.provider && accounts.length > 1 } };
}
