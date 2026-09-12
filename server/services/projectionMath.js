export const PROJECTION_VERSION = 'real-cashflows-v3-benefit-starts';

// Constant real contributions, credited at the start of each month. Growth is
// nominal, fees are a percentage of assets, and outputs are in today's money.
// The caller supplies the TOTAL gross credit; do not add account rates or tax relief.
// Optional benefit start ages default to retirementAge for backwards compatibility.
export function projectPension(input) {
  const required = ['currentAge','retirementAge','currentPot','monthlyContribution','growthPct','inflationPct','chargePct','drawdownPct','stateMonthly','dbMonthly','monthlyTarget'];
  const missing = required.filter(key => input[key] == null || input[key] === '' || !Number.isFinite(Number(input[key])));
  if (missing.length) return { version:PROJECTION_VERSION,status:'missing_inputs',missing,points:[] };
  const v = Object.fromEntries(required.map(key=>[key,Number(input[key])]));
  const optionalAges = Object.fromEntries(['stateStartAge','dbStartAge'].map((key)=>[
    key,
    input[key] == null || input[key] === '' ? v.retirementAge : Number(input[key])
  ]));
  const invalid = v.retirementAge < v.currentAge || v.retirementAge - v.currentAge > 125
    || v.growthPct <= -100 || v.inflationPct <= -100 || v.chargePct < 0 || v.chargePct >= 100
    || ['currentAge','currentPot','monthlyContribution','drawdownPct','stateMonthly','dbMonthly','monthlyTarget'].some(key=>v[key]<0)
    || Object.values(optionalAges).some((age)=>!Number.isFinite(age)||age<0||age>125);
  if (invalid) return { version:PROJECTION_VERSION,status:'invalid_inputs',points:[] };
  const years = v.retirementAge - v.currentAge, months = Math.round(years * 12);
  const realAnnualFactor = (1 + v.growthPct / 100) * (1 - v.chargePct / 100) / (1 + v.inflationPct / 100);
  const factor = realAnnualFactor ** (1 / 12);
  let pot = v.currentPot;
  const points = [{age:v.currentAge,pot}];
  for (let month = 1; month <= months; month++) {
    pot = (pot + v.monthlyContribution) * factor;
    if (month % 12 === 0 || month === months) points.push({age:v.currentAge + month / 12,pot});
  }
  const dcMonthly = pot * v.drawdownPct / 100 / 12;
  const stateMonthlyIncluded = v.retirementAge >= optionalAges.stateStartAge ? v.stateMonthly : 0;
  const dbMonthlyIncluded = v.retirementAge >= optionalAges.dbStartAge ? v.dbMonthly : 0;
  const monthlyIncome = dcMonthly + stateMonthlyIncluded + dbMonthlyIncluded;
  const monthlyGap = Math.max(0,v.monthlyTarget-monthlyIncome);
  return {version:PROJECTION_VERSION,status:'ready',moneyBasis:'today',contributionTiming:'start_of_month',
    contributionBasis:'constant_real_total_gross_credit',years,months,currentAge:v.currentAge,retirementAge:v.retirementAge,
    currentPot:v.currentPot,monthlyContribution:v.monthlyContribution,finalPot:pot,dcMonthly,monthlyIncome,monthlyGap,
    stateStartAge:optionalAges.stateStartAge,dbStartAge:optionalAges.dbStartAge,stateMonthlyIncluded,dbMonthlyIncluded,
    annualGap:monthlyGap*12,coverage:v.monthlyTarget>0?monthlyIncome/v.monthlyTarget*100:0,
    points:points.map(point=>{const state=point.age>=optionalAges.stateStartAge?v.stateMonthly:0;const db=point.age>=optionalAges.dbStartAge?v.dbMonthly:0;const income=point.pot*v.drawdownPct/100/12+state+db;return {...point,stateMonthlyIncluded:state,dbMonthlyIncluded:db,monthlyIncome:income,monthlyGap:Math.max(0,v.monthlyTarget-income)};})};
}
