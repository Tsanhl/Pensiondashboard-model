import {recordProvenance, snapshotIdentity} from './services/portfolioEvidenceService.js';
import { projectPension } from "./services/projectionMath.js";
const formatter = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0
});

import { readPortfolio, readRiskProfile } from "./store/userDataStore.js";
import { daysSince, slugify } from "./utils/values.js";

function money(value) {
  return value == null || value === "" || !Number.isFinite(Number(value)) ? "Not recorded" : formatter.format(Math.round(Number(value)));
}

function percent(value, decimals = 0) {
  return value == null || value === "" || !Number.isFinite(Number(value)) ? "Not recorded" : `${Number(value).toFixed(decimals).replace(/\.0$/, "")}%`;
}

const portfolio = {
  userId: "alex-morgan",
  profile: {
    name: "Alex Morgan",
    source: "Authenticated backend profile",
    employer: "Northbridge Retail Ltd",
    previousEmployer: "Harbour Logistics",
    jurisdiction: "England and Wales"
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
      charges: 0.45,
      employerName: "Northbridge Retail Ltd",
      schemeName: "Northbridge Retail Workplace Pension",
      schemeType: "Group personal pension",
      schemeStatus: "Active",
      employeeContributionPct: 5,
      employerContributionPct: 7,
      employeeContributionAnnual: 2250,
      employerContributionAnnual: 3150,
      style: "Balanced",
      allocation: [
        { label: "UK equity", value: "26%" },
        { label: "Global equity", value: "36%" },
        { label: "Bonds", value: "28%" },
        { label: "Cash", value: "10%" }
      ]
    },
    {
      name: "Standard Life Pension",
      provider: "Standard Life",
      policy: "SL87654321",
      pot: 32150,
      type: "Workplace pension",
      source: "Provider-linked",
      lastUpdated: "12 May 2026",
      charges: 0.55,
      employerName: "Harbour Logistics",
      schemeName: "Harbour Logistics Workplace Pension",
      schemeType: "Group personal pension",
      schemeStatus: "Deferred",
      employeeContributionPct: 0,
      employerContributionPct: 0,
      employeeContributionAnnual: 0,
      employerContributionAnnual: 0,
      style: "Balanced",
      allocation: [
        { label: "UK equity", value: "30%" },
        { label: "Global equity", value: "32%" },
        { label: "Bonds", value: "30%" },
        { label: "Cash", value: "8%" }
      ]
    },
    {
      name: "Nest Workplace Pension",
      provider: "Nest",
      policy: "NE11223344",
      pot: 15200,
      type: "Workplace pension",
      source: "Provider-linked",
      lastUpdated: "08 May 2026",
      charges: 0.30,
      employerName: "Northbridge Retail Ltd",
      schemeName: "Northbridge Nest Workplace Pension",
      schemeType: "Master trust",
      schemeStatus: "Active",
      employeeContributionPct: 4,
      employerContributionPct: 5,
      employeeContributionAnnual: 1800,
      employerContributionAnnual: 2250,
      style: "Balanced",
      allocation: [
        { label: "UK equity", value: "24%" },
        { label: "Global equity", value: "38%" },
        { label: "Bonds", value: "28%" },
        { label: "Cash", value: "10%" }
      ]
    },
    {
      name: "OneLife Personal Plan",
      provider: "OneLife",
      policy: "OL99887766",
      pot: 7650,
      type: "Personal pension",
      source: "Manual entry",
      lastUpdated: "18 Apr 2026",
      charges: 0.80,
      employerName: "",
      schemeName: "OneLife Personal Plan",
      schemeType: "Personal pension",
      schemeStatus: "Active",
      employeeContributionPct: null,
      employerContributionPct: null,
      employeeContributionAnnual: 960,
      employerContributionAnnual: 0,
      style: "Cautious",
      allocation: [
        { label: "UK equity", value: "18%" },
        { label: "Global equity", value: "22%" },
        { label: "Bonds", value: "45%" },
        { label: "Cash", value: "15%" }
      ]
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
      name: "Aviva Annual Statement 2026",
      type: "Pension statement",
      provider: "Aviva",
      date: "12 May 2026",
      status: "Checked",
      confidence: "High",
      source: "Provider portal",
      extracted: {
        provider: "Aviva",
        scheme: "Northbridge Retail Workplace Pension",
        employer: "Northbridge Retail Ltd",
        potValue: 68450,
        employeeContribution: "5%",
        employerContribution: "7%",
        chargePct: 0.45,
        statementDate: "12 May 2026",
        policy: "AW12345678"
      }
    },
    {
      name: "Nest Annual Statement 2026",
      type: "Pension statement",
      provider: "Nest",
      date: "08 May 2026",
      status: "Checked",
      confidence: "High",
      source: "Provider portal",
      extracted: {
        provider: "Nest",
        scheme: "Northbridge Nest Workplace Pension",
        employer: "Northbridge Retail Ltd",
        potValue: 15200,
        employeeContribution: "4%",
        employerContribution: "5%",
        chargePct: 0.30,
        statementDate: "08 May 2026",
        policy: "NE11223344"
      }
    },
    {
      name: "OneLife Policy Document",
      type: "Policy document",
      provider: "OneLife",
      date: "18 Apr 2026",
      status: "Review",
      confidence: "Medium",
      source: "Manual upload",
      extracted: {
        provider: "OneLife",
        scheme: "OneLife Personal Plan",
        potValue: 7650,
        employeeContribution: "£80 / month",
        employerContribution: "None",
        chargePct: 0.80,
        statementDate: "18 Apr 2026",
        policy: "OL99887766"
      }
    },
    {
      name: "State Pension Forecast",
      type: "State Pension forecast",
      provider: "UK Government",
      date: "21 Jan 2026",
      status: "Checked",
      confidence: "High",
      source: "GOV.UK",
      extracted: {
        provider: "UK Government",
        statePensionMonthly: 550,
        statementDate: "21 Jan 2026"
      }
    },
    {
      name: "Northbridge Workplace Scheme Booklet",
      type: "Scheme booklet",
      provider: "Aviva",
      date: "04 Jan 2026",
      status: "Checked",
      confidence: "High",
      source: "Employer",
      extracted: {
        provider: "Aviva",
        employer: "Northbridge Retail Ltd",
        scheme: "Northbridge Retail Workplace Pension",
        schemeType: "Group personal pension",
        defaultFund: "Balanced",
        memberAction: "Read the booklet before any scheme change request",
        statementDate: "04 Jan 2026",
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
    source: "Empty demo profile",
    employer: "",
    previousEmployer: "",
    jurisdiction: ""
  },
  assumptions: {
    currentAge: null,
    retirementAge: null,
    monthlyTarget: null,
    salary: null,
    totalContributionPct: null,
    extraMonthlyContribution: 0,
    growthPct: null,
    inflationPct: null,
    chargePct: null,
    drawdownPct: null,
    dbMonthly: null
  },
  accounts: [],
  statePension: {
    name: "State Pension Forecast",
    monthlyIncome: null,
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
  return slugify(userId || "") === "alex-morgan" ? getPortfolioSeed() : { ...clone(emptyPortfolio),userId };
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

function projectableCurrentPot(state) {
  const dcAccounts = (state.accounts || []).filter((account) =>
    account.potStatus !== "NOT_APPLICABLE"
    && !/defined benefit/i.test(`${account.type || ""} ${account.schemeType || ""}`)
  );
  if (!dcAccounts.length || dcAccounts.some((account) => account.pot == null || account.pot === "")) return null;
  return dcAccounts.reduce((sum, account) => sum + Number(account.pot), 0);
}

export function calculateProjection(state) {
  const a = state.assumptions || {};
  const recordedMonthlyContribution = a.grossMonthlyContribution == null || a.grossMonthlyContribution === ""
    ? null : Number(a.grossMonthlyContribution);
  const baseMonthlyContribution = recordedMonthlyContribution ?? (a.salary == null || a.totalContributionPct == null ? null
    : Number(a.salary) * Number(a.totalContributionPct) / 100 / 12);
  const monthlyContribution = baseMonthlyContribution == null ? null
    : baseMonthlyContribution + Number(a.extraMonthlyContribution ?? 0);
  return projectPension({ ...a,currentPot:projectableCurrentPot(state),monthlyContribution,
    stateMonthly:state.statePension.monthlyIncome,dbMonthly:a.dbMonthly,
    stateStartAge:state.statePension.startAge,dbStartAge:a.dbIncomeStartAge });
}

function calculateContributionScenarios(state, increments = [50, 100, 200]) {
  const baseProjection = calculateProjection(state);
  if (baseProjection.status !== "ready") return [];
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

function formatContributionRate(value) {
  if (value == null || value === "") return "";
  return percent(value, 1);
}

function formatYearlyContribution(value) {
  if (value == null || value === "") return "";
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "—";
  return `${money(amount)} /yr`;
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
    ...clone(emptyPortfolio),
    ...clone(rawState || {}),
    profile: { ...emptyPortfolio.profile, ...(rawState?.profile || {}) },
    assumptions: { ...emptyPortfolio.assumptions, ...(rawState?.assumptions || {}) },
    statePension: { ...emptyPortfolio.statePension, ...(rawState?.statePension || {}) },
    savings: { ...emptyPortfolio.savings, ...(rawState?.savings || {}) },
    investmentProfile: { ...emptyPortfolio.investmentProfile, ...(rawState?.investmentProfile || {}) }
  };
  state.accounts = (rawState?.accounts || emptyPortfolio.accounts).map((account, index) => ({
    id: account.id || `acct_${slugify(account.provider || account.name || "pension")}_${index + 1}`,
    ...account
  }));
  state.documents = (rawState?.documents || emptyPortfolio.documents).map((documentItem, index) => ({
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
    projection,
    projectionMethod: "Amounts are in today's money with total gross contributions credited at the start of each month and kept constant after inflation, without additional tax relief or employer matching; recorded State Pension and DB income is included only from its recorded start age; if no start age is recorded, the legacy assumption is the selected retirement age, so confirm eligibility and payment dates.",
    dataSource: "Authenticated portfolio snapshot; verification is record-specific",
    snapshotId: snapshotIdentity(state),
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
      contributionBasis: "Illustrative aggregate salary percentage, not the sum of individual account rates",
      moneyBasis: "today",
      contributionTiming: "start_of_month",
      drawdownPct: percent(state.assumptions.drawdownPct, 1)
    },
    pensionPotValue: money(pensionPotValue),
    potBreakdown: {
      workplacePensions: money(workplacePotValue),
      personalPensions: money(personalPotValue)
    },
    investmentProfile: clone(state.investmentProfile),
    riskProfile: readRiskProfile(state.userId),
    largestAccount: largestAccount ? {
      id: largestAccount.id,
      name: largestAccount.name,
      provider: largestAccount.provider,
      policy: largestAccount.policy,
      pot: money(largestAccount.pot),
      charges: percent(largestAccount.charges, 2),
      source: largestAccount.source,
      employerName: largestAccount.employerName || "",
      schemeName: largestAccount.schemeName || "",
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
      lastUpdated: account.lastUpdated,
      employerName: account.employerName || "",
      schemeName: account.schemeName || "",
      schemeType: account.schemeType || "",
      schemeStatus: account.schemeStatus || "",
      provenance: recordProvenance(account),
      facts: Object.fromEntries(["pot","charges","employeeContributionPct","employerContributionPct","employeeContributionAnnual","employerContributionAnnual"].map(key => [key, account[key] == null || account[key] === "" ? null : Number(account[key])])),
      rawFacts: clone(account.recordFacts || {}),
      employee: formatContributionRate(account.employeeContributionPct) || (account.employeeContributionAnnual ? "Personal" : "—"),
      employer: formatContributionRate(account.employerContributionPct) || "—",
      employeeYearly: formatYearlyContribution(account.employeeContributionAnnual),
      employerYearly: formatYearlyContribution(account.employerContributionAnnual),
      style: account.style || "",
      allocation: Array.isArray(account.allocation) ? clone(account.allocation) : []
    })),
    statePension: {
      monthlyIncome: money(state.statePension.monthlyIncome),
      startAge: state.statePension.startAge ?? null,
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
      source: documentItem.source || "",
      confirmedAt: documentItem.confirmedAt || null,
      fieldEvidence: documentItem.fieldEvidence || {},
      reviewFields: documentItem.reviewFields || [],
      extracted: documentItem.extracted || {}
    })),
    supplementalRecords: clone(state.supplementalRecords || {}),
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
    dataSource: "Authenticated portfolio snapshot; verification is record-specific",
    snapshotId: snapshotIdentity(state),
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
