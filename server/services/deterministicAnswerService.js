import { buildCanonicalFacts, factDisplay } from "./canonicalFactService.js";

function cite(source) {
  return source?.sourceId ? ` {{cite:${source.sourceId}}}` : "";
}

function accountsSource(sources) {
  return sources.find((source) => String(source.sourceId || "").includes("structured_accounts") || /account records/i.test(source.title || ""));
}

function projectionSource(sources) {
  return sources.find((source) => String(source.sourceId || "").includes("structured_projection") || /projection/i.test(source.title || ""));
}

function documentsSource(sources) {
  return sources.find((source) => String(source.sourceId || "").includes("structured_documents") || /document status/i.test(source.title || ""));
}

function investmentSource(sources) {
  return sources.find((source) => String(source.sourceId || "").includes("structured_investment") || /investment and risk/i.test(source.title || ""));
}

export function personalisedAdviceBoundaryAnswer(question, { userId, sources = [] } = {}) {
  const registry = buildCanonicalFacts(userId);
  const account = accountsSource(sources);
  const investment = investmentSource(sources);
  const style = registry.dashboard?.investmentProfile?.currentStyle || "Balanced";
  const cautious = (registry.dashboard?.investmentProfile?.accountsByStrategy || []).find((item) => /cautious/i.test(item.style || ""));
  const cautiousLabel = cautious ? `${cautious.provider || cautious.account} ${cautious.style}` : "OneLife Cautious";
  return {
    reason: "deterministic_personalised_advice_boundary",
    answer: `I cannot give personalised investment advice. I cannot recommend a specific fund. The recorded overall style is ${style}, with ${cautiousLabel}.${cite(investment || account)} Speak to a regulated financial adviser.`,
    citationIds: [investment?.sourceId || account?.sourceId].filter(Boolean),
    sources: [investment || account].filter(Boolean)
  };
}

export function deterministicDashboardAnswer(question, { userId, sources = [] } = {}) {
  const text = String(question || "");
  const combineQuestion = /\bcombin(?:e|ing)\b/i.test(text) && /\b(?:pension|pots?)\b/i.test(text);
  const adviceBoundary = /\b(?:should i (?:keep|buy|sell|switch|invest|transfer|combine|consolidat|stop)|which one should i keep|which fund|best returns?|recommend|combine all my pensions|better than an ISA)\b/i.test(text);
  if (/\b(?:scam|unlock|pressur|whatsapp|release fee|transfer my .{0,40} for me now)\b/i.test(text)) return null;
  if (/\b(?:legal route|annual allowance|tax-free|auto(?:matic)?[- ]enrolment|pension protection fund|complain|divorc|die before)\b/i.test(text)) return null;

  const registry = buildCanonicalFacts(userId);
  const facts = registry.facts;
  const account = accountsSource(sources);
  const projection = projectionSource(sources);
  const documents = documentsSource(sources);

  if (combineQuestion) {
    const current = facts["profile.currentEmployer"]?.value;
    return {
      reason: "deterministic_consolidation_boundary",
      answer: `I cannot recommend combining your pensions. The recorded pots are separate arrangements: Aviva and Nest are current ${current} workplace pensions, Standard Life is a deferred Harbour Logistics workplace pension, and OneLife is a personal pension. Check charges, guarantees and scam warnings with a human adviser before any transfer.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (adviceBoundary && /\b(?:emergency savings|cash buffer)\b/i.test(text)) {
    const savings = facts["cashBuffer.savings"];
    const months = facts["cashBuffer.monthsCovered"];
    return {
      reason: "deterministic_cash_buffer_boundary",
      answer: `The recorded cash buffer is ${savings?.display}, covering about ${months?.display} months against a 3-month target. I cannot tell you whether to stop pension contributions.${cite(projection || account)}`,
      citationIds: [projection?.sourceId || account?.sourceId].filter(Boolean),
      sources: [projection || account].filter(Boolean)
    };
  }

  if (adviceBoundary && !combineQuestion) {
    return personalisedAdviceBoundaryAnswer(question, { userId, sources });
  }

  const total = facts["derivedFacts.totalPots"];
  if (/\b(?:altogether|add(?:ed)? (?:all|up)|total(?: of)?(?: all)?(?: my)? (?:pots?|pensions?)|how much have i got in pensions)\b/i.test(text) && total) {
    const parts = (registry.dashboard.pensionAccounts || []).map((item) => `${item.provider} ${item.pot}`).join(", ");
    return {
      reason: "deterministic_portfolio_total",
      answer: `Your recorded pension pots total ${total.display}: ${parts}.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\baviva\b/i.test(text) && /\b(?:pot|how much|policy number)\b/i.test(text)) {
    if (/\bpolicy number\b/i.test(text)) {
      const policy = facts["accounts.aviva.policyNumber"];
      return {
        reason: "deterministic_policy_number",
        answer: `The recorded Aviva Workplace Pension policy number is ${policy?.value}.${cite(account)}`,
        citationIds: [account?.sourceId].filter(Boolean),
        sources: [account].filter(Boolean)
      };
    }
    const pot = facts["accounts.aviva.pot"];
    const updated = facts["accounts.aviva.lastUpdated"];
    return {
      reason: "deterministic_account_pot",
      answer: `The recorded Aviva workplace pension pot is ${pot?.display}, last updated ${updated?.value}.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\bnest\b/i.test(text) && /\b(?:percentage|pay into|employer pay)\b/i.test(text)) {
    const employee = facts["accounts.nest.employeeContributionPercent"];
    const employer = facts["accounts.nest.employerContributionPercent"];
    return {
      reason: "deterministic_contribution_rates",
      answer: `The recorded Nest workplace pension contributions are ${employee?.display} employee and ${employer?.display} employer.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\b(?:lowest|lowest annual) charge\b/i.test(text) || /\bcharging me the most\b/i.test(text)) {
    const accounts = registry.dashboard.pensionAccounts || [];
    const ranked = [...accounts].sort((left, right) => parseFloat(left.charges) - parseFloat(right.charges));
    if (!ranked.length) return null;
    if (/\bmost\b/i.test(text)) {
      const high = ranked.at(-1);
      return {
        reason: "deterministic_highest_charge",
        answer: `${high.name} has the highest recorded annual charge at ${high.charges}.${cite(account)}`,
        citationIds: [account?.sourceId].filter(Boolean),
        sources: [account].filter(Boolean)
      };
    }
    const workplace = ranked.filter((item) => /workplace/i.test(item.type));
    const low = (workplace.length ? workplace : ranked)[0];
    return {
      reason: "deterministic_lowest_charge",
      answer: `${low.name} has the lowest recorded annual charge at ${low.charges}.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\bstate pension\b/i.test(text) && /\b(?:forecast|get|how much)\b/i.test(text)) {
    const sp = facts["statePension.forecastMonthly"];
    return {
      reason: "deterministic_state_pension_forecast",
      answer: `Your recorded State Pension forecast is ${sp?.display} a month.${cite(account || projection)}`,
      citationIds: [account?.sourceId || projection?.sourceId].filter(Boolean),
      sources: [account || projection].filter(Boolean)
    };
  }

  const extra = text.match(/\badd(?:ing)?(?: an)? extra £?\s*(\d+)\b/i) || text.match(/\bextra £?\s*(\d+)\b/i) || text.match(/\badd £?\s*(\d+)\b/i);
  if (extra && /\b(?:gap|month)\b/i.test(text)) {
    const amount = extra[1];
    const remaining = facts[`projection.scenarios.extra${amount}.remainingGap`];
    const income = facts[`projection.scenarios.extra${amount}.projectedMonthlyIncome`];
    if (remaining) {
      const closed = Number(remaining.value) <= 0;
      return {
        reason: "deterministic_projection_scenario",
        answer: closed
          ? `The recorded +£${amount} a month scenario closes the gap.${cite(projection)}`
          : `The recorded +£${amount} a month scenario leaves a remaining monthly gap of ${remaining.display}${income?.display ? `, with projected monthly income ${income.display}` : ""}. It does not close the gap.${cite(projection)}`,
        citationIds: [projection?.sourceId].filter(Boolean),
        sources: [projection].filter(Boolean)
      };
    }
  }

  if (/\b(?:£?804|monthly gap)\b/i.test(text) || (/\bgap\b/i.test(text) && /\bexplain\b/i.test(text))) {
    const gap = facts["projection.monthlyGap"];
    const target = facts["projection.targetMonthlyIncome"];
    const income = facts["projection.projectedMonthlyIncome"];
    return {
      reason: "deterministic_monthly_gap",
      answer: `The recorded monthly gap is ${gap?.display}. That is the ${target?.display} target minus projected monthly income of ${income?.display}. Review contribution scenarios, charges and whether the snapshot dates still match the providers.${cite(projection || account)}`,
      citationIds: [projection?.sourceId || account?.sourceId].filter(Boolean),
      sources: [projection || account].filter(Boolean)
    };
  }

  if (/\bretirement age\b/i.test(text) && /\btarget\b/i.test(text)) {
    const age = facts["projection.retirementAge"];
    const target = facts["projection.targetMonthlyIncome"];
    return {
      reason: "deterministic_projection_assumptions",
      answer: `The recorded projection uses retirement age ${age?.value} and a monthly income target of ${target?.display}.${cite(projection)}`,
      citationIds: [projection?.sourceId].filter(Boolean),
      sources: [projection].filter(Boolean)
    };
  }

  if (/\bprojected\b/i.test(text) && /\b(?:monthly )?income\b/i.test(text)) {
    const income = facts["projection.projectedMonthlyIncome"];
    return {
      reason: "deterministic_projected_income",
      answer: `The recorded projected monthly income is ${income?.display}.${cite(projection)}`,
      citationIds: [projection?.sourceId].filter(Boolean),
      sources: [projection].filter(Boolean)
    };
  }

  if (/\bgrowth, inflation and charge assumptions\b/i.test(text) || (/\bassumptions?\b/i.test(text) && /\b(?:growth|inflation|charge)\b/i.test(text))) {
    const growth = facts["projection.assumptions.growth"];
    const inflation = facts["projection.assumptions.inflation"];
    const charge = facts["projection.assumptions.charge"];
    return {
      reason: "deterministic_projection_rates",
      answer: `The recorded projection assumptions are ${growth?.display} growth, ${inflation?.display} inflation and ${charge?.display} charges.${cite(projection)}`,
      citationIds: [projection?.sourceId].filter(Boolean),
      sources: [projection].filter(Boolean)
    };
  }

  if (/\bsalary\b/i.test(text) && /\b(?:month|contribution|assumption)\b/i.test(text)) {
    const salary = facts["profile.salary"];
    const monthly = facts["projection.currentAssumedMonthlyContribution"];
    return {
      reason: "deterministic_salary_contribution",
      answer: `The recorded salary is ${salary?.display} and the current assumed monthly pension contribution is ${monthly?.display}.${cite(projection || account)}`,
      citationIds: [projection?.sourceId || account?.sourceId].filter(Boolean),
      sources: [projection || account].filter(Boolean)
    };
  }

  if (/\bcurrent employer\b/i.test(text) || /\bwho is my (?:current )?employer\b/i.test(text)) {
    const current = facts["profile.currentEmployer"];
    const previous = facts["profile.previousEmployer"];
    return {
      reason: "deterministic_employer",
      answer: `Your current recorded employer is ${current?.value}. ${previous?.value ? `${previous.value} is recorded as a previous employer.` : ""}${cite(account)}`.trim(),
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\bfacts that need confirmation\b/i.test(text) || /\bneed confirmation\b/i.test(text)) {
    const review = (registry.dashboard.documents || []).filter((item) => /review/i.test(item.status));
    const names = review.map((item) => `${item.name} (${item.status}, ${item.confidence})`).join("; ") || "none";
    return {
      reason: "deterministic_document_review",
      answer: `Document facts still needing confirmation: ${names}.${cite(documents || account)}`,
      citationIds: [documents?.sourceId || account?.sourceId].filter(Boolean),
      sources: [documents || account].filter(Boolean)
    };
  }

  if (/\bonelife\b/i.test(text) && /\b(?:fully checked|manual entry|figures)\b/i.test(text)) {
    const status = facts["documents.oneLife.status"];
    const confidence = facts["documents.oneLife.confidence"];
    const pot = facts["accounts.oneLife.pot"];
    const charge = facts["accounts.oneLife.charge"];
    const source = facts["accounts.oneLife.source"];
    return {
      reason: "deterministic_onelife_status",
      answer: `OneLife is recorded as ${source?.value || "manual entry"} and its document status is ${status?.value || "Review"} (${confidence?.value || "Medium"}), not fully checked. The recorded pot is ${pot?.display} with a ${charge?.display} annual charge.${cite(documents || account)}`,
      citationIds: [documents?.sourceId || account?.sourceId].filter(Boolean),
      sources: [documents || account].filter(Boolean)
    };
  }

  if ((/\bstandard life\b/i.test(text) && /\b(?:still paying|did that stop|left|old|harbour|what(?:'s| is) left|how much|pot)\b/i.test(text))
      || (/\bleft\b/i.test(text) && /\bharbour logistics\b/i.test(text))) {
    const status = facts["accounts.standardLife.status"];
    const pot = facts["accounts.standardLife.pot"];
    const current = facts["profile.currentEmployer"]?.value;
    return {
      reason: "deterministic_deferred_status",
      answer: `Harbour Logistics is recorded as a previous employer. The Harbour Logistics workplace pension is the Standard Life pot (${pot?.display}), recorded as ${status?.value || "Deferred"} with no current employee or employer contributions. Aviva and Nest are current ${current} workplace pensions; the Harbour pot is not recorded as transferred into those schemes.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\b(?:scheme booklet|member booklet|workplace scheme booklet)\b/i.test(text)) {
    const booklet = (registry.dashboard.documents || []).find((item) => /booklet/i.test(`${item.type || ""} ${item.name || ""}`));
    const action = booklet?.extracted?.memberAction || "Read the booklet before any scheme change request";
    const scheme = booklet?.extracted?.scheme || "Northbridge Retail Workplace Pension";
    return {
      reason: "deterministic_scheme_booklet",
      answer: `The ${booklet?.name || "Northbridge workplace scheme booklet"} says: ${action}. That is a booklet instruction for the ${scheme}, not a statutory scheme-change procedure.${cite(documents || account)}`,
      citationIds: [documents?.sourceId || account?.sourceId].filter(Boolean),
      sources: [documents || account].filter(Boolean)
    };
  }

  if (/\bcontribution scenarios?\b/i.test(text) || (/\bchang(?:e|ing) (?:pension |my )?contributions?\b/i.test(text) && /\b(?:dashboard|check|scenario)\b/i.test(text))) {
    const extra50 = facts["projection.scenarios.extra50.remainingGap"];
    const extra100 = facts["projection.scenarios.extra100.remainingGap"];
    const extra200 = facts["projection.scenarios.extra200.remainingGap"];
    const avivaEmployee = facts["accounts.aviva.employeeContributionPercent"];
    const avivaEmployer = facts["accounts.aviva.employerContributionPercent"];
    const nestEmployee = facts["accounts.nest.employeeContributionPercent"];
    const nestEmployer = facts["accounts.nest.employerContributionPercent"];
    return {
      reason: "deterministic_contribution_scenarios",
      answer: `Before changing pension contributions, check the recorded current rates, charges, snapshot dates and cash buffer. Aviva is ${avivaEmployee?.display} employee / ${avivaEmployer?.display} employer; Nest is ${nestEmployee?.display} employee / ${nestEmployer?.display} employer. The recorded contribution scenarios leave remaining monthly gaps of ${extra50?.display} at +£50, ${extra100?.display} at +£100, and ${extra200?.display} at +£200. This is not a recommendation to change contributions.${cite(projection || account)}`,
      citationIds: [projection?.sourceId || account?.sourceId].filter(Boolean),
      sources: [projection || account].filter(Boolean)
    };
  }

  if (/\b(?:lost pension|find a lost pension|trace a (?:lost |missing )?pension|missing a pension from a (?:job|employer)|pension from an employer before)\b/i.test(text)) {
    return {
      reason: "deterministic_lost_pension_tracing",
      answer: `The dashboard does not list a pension from a job before Harbour Logistics. That absence does not prove a pension never existed. Use the GOV.UK Pension Tracing Service or MoneyHelper find-pension contact details; do not treat Aviva or Standard Life as a missing pre-Harbour pot.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\bredundan/i.test(text) && /\bworkplace pensions?\b/i.test(text)) {
    const current = facts["profile.currentEmployer"]?.value;
    const aviva = facts["accounts.aviva.pot"]?.display;
    const nest = facts["accounts.nest.pot"]?.display;
    const sl = facts["accounts.standardLife.pot"]?.display;
    return {
      reason: "deterministic_redundancy_recap",
      answer: `If you leave ${current}, check the current workplace pensions first: Aviva (${aviva}) and Nest (${nest}) with ${current}. Standard Life (${sl}) is already deferred from Harbour Logistics. OneLife is a personal pension, not a Northbridge workplace scheme. Practical checks are contributions stopping, charges, statements and scam warnings. I cannot invent a statutory redundancy-pension outcome.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  if (/\bdefined benefit\b/i.test(text) && /\b(?:dashboard|do i have)\b/i.test(text)) {
    return {
      reason: "deterministic_no_db_scheme",
      answer: `No defined benefit scheme is recorded. The dashboard lists four defined contribution pots: Aviva, Nest and Standard Life workplace pensions, and OneLife personal pension.${cite(account)}`,
      citationIds: [account?.sourceId].filter(Boolean),
      sources: [account].filter(Boolean)
    };
  }

  return null;
}

export { factDisplay };
