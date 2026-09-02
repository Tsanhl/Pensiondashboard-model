const formatter = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0
});

import { readPortfolio } from "./store/userDataStore.js";
import { daysSince, slugify } from "./utils/values.js";

function money(value) {
  return formatter.format(Math.round(Number(value) || 0));
}

function percent(value, decimals = 0) {
  return `${Number(value || 0).toFixed(decimals).replace(/\.0$/, "")}%`;
}

const portfolio = {
  userId: "alex-morgan",
  profile: {
    name: "Alex Morgan",
    source: "Authenticated backend profile"
  },
  assumptions: {
    currentAge: 45,
    retirementAge: 67,
    monthlyTarget: 2500,
    salary: 45000,
    totalContributionPct: 8,
    extraMonthlyContribution: 0,
    growthPct: 4.5,
    inflationPct: 2.5,
    chargePct: 0.65,
    drawdownPct: 5.1,
    dbMonthly: 50
  },
  accounts: [
    {
      name: "Aviva Workplace Pension",
      provider: "Aviva",
      policy: "AW12345678",
      pot: 68450,
      type: "Workplace pension",
      source: "Provider-linked",
      lastUpdated: "12 May 2026",
      charges: 0.45
    },
    {
      name: "Standard Life Pension",
      provider: "Standard Life",
      policy: "SL87654321",
      pot: 32150,
      type: "Workplace pension",
      source: "Provider-linked",
      lastUpdated: "12 May 2026",
      charges: 0.55
    },
    {
      name: "Nest Workplace Pension",
      provider: "Nest",
      policy: "NE11223344",
      pot: 15200,
      type: "Workplace pension",
      source: "Provider-linked",
      lastUpdated: "08 May 2026",
      charges: 0.30
    },
    {
      name: "OneLife Personal Plan",
      provider: "OneLife",
      policy: "OL99887766",
      pot: 7650,
      type: "Personal pension",
      source: "Manual entry",
      lastUpdated: "18 Apr 2026",
      charges: 0.80
    }
  ],
  statePension: {
    name: "State Pension Forecast",
    monthlyIncome: 550,
    source: "Official forecast",
    lastUpdated: "12 May 2026"
  },
  savings: {
    currentSavings: 8750,
    monthlyExpenses: 1700,
    targetMonths: 3,
    lastUpdated: "12 May 2026"
  },
  investmentProfile: {
    currentStyle: "Balanced",
    equityExposure: "62%",
    bondExposure: "28%",
    cashOther: "10%",
    allocation: [
      { label: "UK equity", value: "28%" },
      { label: "Global equity", value: "34%" },
      { label: "Bonds", value: "28%" },
      { label: "Cash", value: "8%" },
      { label: "Alternatives", value: "2%" }
    ],
    accountsByStrategy: [
      { account: "Aviva Workplace Pension", provider: "Aviva", style: "Balanced" },
      { account: "Standard Life Pension", provider: "Standard Life", style: "Balanced" },
      { account: "Nest Workplace Pension", provider: "Nest", style: "Balanced" },
      { account: "OneLife Personal Plan", provider: "OneLife", style: "Cautious" }
    ]
  },
  documents: [
    {
      name: "Annual Statement 2024",
      type: "Pension statement",
      provider: "Aviva",
      date: "12 May 2024",
      status: "Checked",
      confidence: "High",
      extracted: {
        provider: "Aviva",
        scheme: "Workplace Pension",
        potValue: 68450,
        contribution: 300,
        statementDate: "12 May 2024",
        policy: "AW12345678"
      }
    },
    {
      name: "Welcome Letter",
      type: "Letter",
      provider: "Standard Life",
      date: "03 Apr 2024",
      status: "Checked",
      confidence: "Medium",
      extracted: {
        provider: "Standard Life",
        scheme: "Workplace Pension",
        potValue: 32150,
        contribution: 225,
        statementDate: "03 Apr 2024",
        policy: "SL87654321"
      }
    },
    {
      name: "Policy Document",
      type: "Policy document",
      provider: "OneLife",
      date: "18 Mar 2024",
      status: "Review",
      confidence: "Medium",
      extracted: {
        provider: "OneLife",
        scheme: "Personal Plan",
        potValue: 7650,
        contribution: 80,
        statementDate: "18 Mar 2024",
        policy: "OL99887766"
      }
    },
    {
      name: "Benefits Illustration",
      type: "Illustration",
      provider: "Aviva",
      date: "10 Feb 2024",
      status: "Checked",
      confidence: "High",
      extracted: {
        provider: "Aviva",
        scheme: "Workplace Pension",
        potValue: 68450,
        contribution: 300,
        statementDate: "10 Feb 2024",
        policy: "AW12345678"
      }
    }
  ],
  systemUpdate: {
    date: "12 May 2026",
    label: "Latest provider update",
    note: "Provider values received and projection recalculated."
  }
};

const emptyPortfolio = {
  userId: "empty-demo",
  profile: {
    name: "New user",
    source: "Empty demo profile"
  },
  assumptions: {
    currentAge: 45,
    retirementAge: 67,
    monthlyTarget: 0,
    salary: 0,
    totalContributionPct: 0,
    extraMonthlyContribution: 0,
    growthPct: 4.5,
    inflationPct: 2.5,
    chargePct: 0,
    drawdownPct: 5,
    dbMonthly: 0
  },
  accounts: [],
  statePension: {
    name: "State Pension Forecast",
    monthlyIncome: 0,
    source: "Not added",
    lastUpdated: "Not added"
  },
  savings: {
    currentSavings: 0,
    monthlyExpenses: 0,
    targetMonths: 3,
    lastUpdated: "Not added"
  },
  investmentProfile: {
    currentStyle: "Not set",
    equityExposure: "0%",
    bondExposure: "0%",
    cashOther: "0%",
    allocation: [
      { label: "UK equity", value: "0%" },
      { label: "Global equity", value: "0%" },
      { label: "Bonds", value: "0%" },
      { label: "Cash", value: "0%" },
      { label: "Alternatives", value: "0%" }
    ],
    accountsByStrategy: []
  },
  documents: [],
  systemUpdate: {
    date: "Not added",
    label: "No provider update yet",
    note: "This empty demo profile is ready for manual data entry or document uploads."
  }
};

export function getPortfolioSeed() {
  return clone(portfolio);
}

export function getPortfolioSeedForUser(userId = "alex-morgan") {
  return slugify(userId || "alex-morgan") === "empty-demo" ? clone(emptyPortfolio) : getPortfolioSeed();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function totalPensionValue(state) {
  return state.accounts.reduce((sum, account) => sum + Number(account.pot || 0), 0);
}

function totalPotFor(state, type) {
  return state.accounts
    .filter((account) => account.type === type)
    .reduce((sum, account) => sum + Number(account.pot || 0), 0);
}

function calculateProjection(state) {
  const assumptions = state.assumptions;
  const years = Math.max(0, assumptions.retirementAge - assumptions.currentAge);
  const months = Math.round(years * 12);
  const currentPot = totalPensionValue(state);
  const baseMonthlyContribution = (assumptions.salary * (assumptions.totalContributionPct / 100)) / 12;
  const monthlyContribution = baseMonthlyContribution + Number(assumptions.extraMonthlyContribution || 0);
  const realAnnualGrowth = (Number(assumptions.growthPct) - Number(assumptions.inflationPct) - Number(assumptions.chargePct)) / 100;
  const monthlyGrowth = Math.pow(Math.max(0.0001, 1 + realAnnualGrowth), 1 / 12) - 1;
  let pot = currentPot;

  for (let month = 0; month < months; month += 1) {
    pot = Math.max(0, (pot + monthlyContribution) * (1 + monthlyGrowth));
  }

  const dcMonthly = (pot * (assumptions.drawdownPct / 100)) / 12;
  const monthlyIncome = dcMonthly + state.statePension.monthlyIncome + assumptions.dbMonthly;
  const monthlyGap = Math.max(0, assumptions.monthlyTarget - monthlyIncome);
  const coverage = assumptions.monthlyTarget > 0 ? (monthlyIncome / assumptions.monthlyTarget) * 100 : 0;

  return {
    years,
    months,
    currentPot,
    finalPot: pot,
    monthlyContribution,
    dcMonthly,
    monthlyIncome,
    monthlyGap,
    annualGap: monthlyGap * 12,
    coverage
  };
}

function calculateContributionScenarios(state, increments = [50, 100, 200]) {
  const baseProjection = calculateProjection(state);
  return increments.map((increment) => {
    const amount = Math.max(0, Number(increment) || 0);
    const scenarioState = clone(state);
    scenarioState.assumptions = {
      ...(scenarioState.assumptions || {}),
      extraMonthlyContribution: Number(state.assumptions.extraMonthlyContribution || 0) + amount
    };
    const projection = calculateProjection(scenarioState);
    const finalPotDelta = Math.max(0, projection.finalPot - baseProjection.finalPot);
    const monthlyIncomeDelta = Math.max(0, projection.monthlyIncome - baseProjection.monthlyIncome);
    const monthlyGapReduction = Math.max(0, baseProjection.monthlyGap - projection.monthlyGap);
    return {
      extraMonthlyContribution: money(amount),
      extraMonthlyContributionValue: amount,
      projectedFinalPot: money(projection.finalPot),
      projectedMonthlyIncome: money(projection.monthlyIncome),
      monthlyGap: money(projection.monthlyGap),
      finalPotDelta: money(finalPotDelta),
      monthlyIncomeDelta: money(monthlyIncomeDelta),
      monthlyGapReduction: money(monthlyGapReduction),
      retirementAge: scenarioState.assumptions.retirementAge
    };
  });
}

function calculateSavings(state) {
  const target = state.savings.monthlyExpenses * state.savings.targetMonths;
  const monthsCovered = state.savings.monthlyExpenses > 0 ? state.savings.currentSavings / state.savings.monthlyExpenses : 0;
  let status = "On track";
  if (monthsCovered < 1) status = "Urgent";
  else if (monthsCovered < state.savings.targetMonths) status = "Building";
  return { target, monthsCovered, status };
}

function dataQuality(state) {
  const connected = state.accounts.filter((account) => account.source === "Provider-linked").length;
  const reviewDocs = state.documents.filter((documentItem) => documentItem.status === "Review").length;
  const highCharge = state.accounts.filter((account) => Number(account.charges || 0) >= 0.75).length;
  const manualAccounts = state.accounts.filter((account) => !/provider-linked|connected/i.test(String(account.source || ""))).length;
  const missingAccounts = state.accounts.length === 0;
  const staleAccounts = state.accounts.filter((account) => {
    const age = daysSince(account.lastUpdated);
    return age != null && age >= 90;
  }).length;
  return {
    connected,
    totalAccounts: state.accounts.length,
    reviewDocs,
    highCharge,
    manualAccounts,
    missingAccounts,
    staleAccounts,
    status: missingAccounts ? "Needs setup" : reviewDocs || highCharge || connected < state.accounts.length || staleAccounts ? "Needs review" : "Checked"
  };
}

function accountConnectionStatus(account) {
  const age = daysSince(account.lastUpdated);
  if (/provider-linked|connected/i.test(String(account.source || "")) && !(age != null && age >= 90)) return "Connected";
  if (/provider-linked|connected/i.test(String(account.source || ""))) return "Data stale";
  if (/manual/i.test(String(account.source || ""))) return "Manual entry";
  return "Needs review";
}

function normaliseState(rawState) {
  const state = {
    ...clone(portfolio),
    ...clone(rawState || {}),
    profile: { ...portfolio.profile, ...(rawState?.profile || {}) },
    assumptions: { ...portfolio.assumptions, ...(rawState?.assumptions || {}) },
    statePension: { ...portfolio.statePension, ...(rawState?.statePension || {}) },
    savings: { ...portfolio.savings, ...(rawState?.savings || {}) },
    investmentProfile: { ...portfolio.investmentProfile, ...(rawState?.investmentProfile || {}) }
  };
  state.accounts = (rawState?.accounts || portfolio.accounts).map((account, index) => ({
    id: account.id || `acct_${slugify(account.provider || account.name || "pension")}_${index + 1}`,
    ...account
  }));
  state.documents = (rawState?.documents || portfolio.documents).map((documentItem, index) => ({
    id: documentItem.id || `doc_${slugify(documentItem.provider || documentItem.name || "document")}_${index + 1}`,
    ...documentItem
  }));
  return state;
}

export function getVerifiedDashboardContext({ userId = "alex-morgan" } = {}) {
  const state = normaliseState(readPortfolio(userId, getPortfolioSeedForUser(userId)));
  state.userId = userId || state.userId;
  const projection = calculateProjection(state);
  const contributionScenarios = calculateContributionScenarios(state);
  const savings = calculateSavings(state);
  const quality = dataQuality(state);
  const pensionPotValue = totalPensionValue(state);
  const workplacePotValue = totalPotFor(state, "Workplace pension");
  const personalPotValue = totalPotFor(state, "Personal pension");
  const largestAccount = [...state.accounts].sort((a, b) => Number(b.pot || 0) - Number(a.pot || 0))[0] || null;

  return {
    userId: state.userId,
    profile: state.profile,
    dataSource: "Backend verified portfolio snapshot",
    readOnly: true,
    snapshotDate: state.systemUpdate.date,
    monthlyTarget: money(state.assumptions.monthlyTarget),
    projectedMonthlyIncome: money(projection.monthlyIncome),
    monthlyGap: money(projection.monthlyGap),
    annualGap: money(projection.annualGap),
    coverage: percent(Math.min(100, projection.coverage)),
    finalPot: money(projection.finalPot),
    assumptions: {
      currentAge: state.assumptions.currentAge,
      retirementAge: state.assumptions.retirementAge,
      salary: money(state.assumptions.salary),
      totalContributionPct: percent(state.assumptions.totalContributionPct, 1),
      monthlyContribution: money(projection.monthlyContribution),
      growthPct: percent(state.assumptions.growthPct, 1),
      inflationPct: percent(state.assumptions.inflationPct, 1),
      chargePct: percent(state.assumptions.chargePct, 2),
      drawdownPct: percent(state.assumptions.drawdownPct, 1)
    },
    pensionPotValue: money(pensionPotValue),
    potBreakdown: {
      workplacePensions: money(workplacePotValue),
      personalPensions: money(personalPotValue)
    },
    investmentProfile: clone(state.investmentProfile),
    largestAccount: largestAccount ? {
      id: largestAccount.id,
      name: largestAccount.name,
      provider: largestAccount.provider,
      policy: largestAccount.policy,
      pot: money(largestAccount.pot),
      charges: percent(largestAccount.charges, 2),
      source: largestAccount.source,
      connectionStatus: accountConnectionStatus(largestAccount),
      lastUpdated: largestAccount.lastUpdated
    } : null,
    pensionAccounts: state.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      provider: account.provider,
      policy: account.policy,
      type: account.type,
      pot: money(account.pot),
      source: account.source,
      connectionStatus: accountConnectionStatus(account),
      isStale: (daysSince(account.lastUpdated) ?? 0) >= 90,
      charges: percent(account.charges, 2),
      lastUpdated: account.lastUpdated
    })),
    statePension: {
      monthlyIncome: money(state.statePension.monthlyIncome),
      source: state.statePension.source,
      lastUpdated: state.statePension.lastUpdated
    },
    savings: {
      currentSavings: money(state.savings.currentSavings),
      monthlyExpenses: money(state.savings.monthlyExpenses),
      target: money(savings.target),
      monthsCovered: savings.monthsCovered.toFixed(1),
      status: savings.status,
      lastUpdated: state.savings.lastUpdated
    },
    documents: state.documents.map((documentItem) => ({
      id: documentItem.id,
      name: documentItem.name,
      provider: documentItem.provider,
      type: documentItem.type,
      status: documentItem.status,
      date: documentItem.date,
      confidence: documentItem.confidence,
      extracted: documentItem.extracted || {}
    })),
    dataQuality: quality,
    contributionScenarios,
    systemUpdate: state.systemUpdate,
    dataUsedSummary: {
      pensionAccounts: `${state.accounts.length} pension accounts`,
      statePension: `${money(state.statePension.monthlyIncome)} monthly State Pension forecast`,
      targetGap: `${money(projection.monthlyGap)} monthly gap`,
      contributionScenarios: contributionScenarios.map((scenario) => `Add ${scenario.extraMonthlyContribution}/month: final pot ${scenario.projectedFinalPot}, monthly gap ${scenario.monthlyGap}`).join("; "),
      documents: `${state.documents.length} document records, ${quality.reviewDocs} needing review`,
      savings: `${savings.monthsCovered.toFixed(1)} months emergency cover`,
      investmentProfile: `${state.investmentProfile.currentStyle}; ${state.investmentProfile.equityExposure} equity, ${state.investmentProfile.bondExposure} bonds, ${state.investmentProfile.cashOther} cash / other`,
      source: "Backend read-only portfolio snapshot"
    }
  };
}

export function getContributionScenarios({ userId = "alex-morgan", increments = [50, 100, 200] } = {}) {
  const state = normaliseState(readPortfolio(userId, getPortfolioSeedForUser(userId)));
  state.userId = userId || state.userId;
  const projection = calculateProjection(state);
  return {
    currentMonthlyContribution: money(projection.monthlyContribution),
    retirementAge: state.assumptions.retirementAge,
    scenarios: calculateContributionScenarios(state, increments)
  };
}


export function getDocumentScanContext({ userId = "alex-morgan" } = {}) {
  const state = normaliseState(readPortfolio(userId, getPortfolioSeedForUser(userId)));
  state.userId = userId || state.userId;
  return {
    userId: state.userId,
    dataSource: "Backend verified portfolio snapshot",
    accounts: state.accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      policy: account.policy,
      name: account.name,
      type: account.type,
      source: account.source,
      lastUpdated: account.lastUpdated
    })),
    statePension: {
      source: state.statePension.source,
      lastUpdated: state.statePension.lastUpdated
    },
    documents: state.documents.map((documentItem) => ({
      id: documentItem.id,
      name: documentItem.name,
      provider: documentItem.provider,
      type: documentItem.type,
      date: documentItem.date,
      status: documentItem.status
    }))
  };
}
