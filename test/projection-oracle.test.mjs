import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPension } from '../server/services/projectionMath.js';
const base = {currentAge:40,retirementAge:41,currentPot:10000,monthlyContribution:100,growthPct:0,inflationPct:0,chargePct:0,drawdownPct:4,stateMonthly:500,dbMonthly:100,monthlyTarget:1000};
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('analytical oracle: zero return conserves contributions and includes each income once',()=>{
  const p=projectPension(base);near(p.finalPot,11200);near(p.monthlyIncome,11200*.04/12+600);near(p.monthlyGap,1000-p.monthlyIncome);
});
test('analytical annuity-due oracle verifies monthly timing, fees and real-money conversion',()=>{
  const input={...base,retirementAge:55.5,growthPct:6,inflationPct:3,chargePct:.8};
  const p=projectPension(input), n=186, annual=(1.06*.992)/1.03, q=annual**(1/12);
  const expected=10000*annual**15.5+100*q*((annual**15.5-1)/(q-1));
  near(p.finalPot,expected);assert.equal(p.months,n);assert.equal(p.moneyBasis,'today');
});
test('zero horizon applies no contribution, growth or repeated state/DB income',()=>{
  const p=projectPension({...base,retirementAge:40});near(p.finalPot,10000);near(p.monthlyIncome,10000*.04/12+600);
});
test('explicit zeros remain valid, missing inputs and invalid horizons do not become zeros',()=>{
  const zero=Object.fromEntries(Object.keys(base).map(key=>[key,0]));assert.equal(projectPension(zero).status,'ready');
  for(const key of Object.keys(base)){assert.equal(projectPension({...base,[key]:null}).status,'missing_inputs');}
  assert.equal(projectPension({...base,retirementAge:39}).status,'invalid_inputs');
});
test('incremental gross credit has no invented relief or employer matching',()=>{
  const a=projectPension(base),b=projectPension({...base,monthlyContribution:150});near(b.finalPot-a.finalPot,600);
});
test('recorded DB and State Pension start ages gate benefits independently',()=>{
  const before=projectPension({...base,retirementAge:60,dbStartAge:65,stateStartAge:68});
  near(before.dbMonthlyIncluded,0);near(before.stateMonthlyIncluded,0);near(before.monthlyIncome,before.dcMonthly);
  const between=projectPension({...base,retirementAge:67,dbStartAge:65,stateStartAge:68});
  near(between.dbMonthlyIncluded,100);near(between.stateMonthlyIncluded,0);near(between.monthlyIncome,between.dcMonthly+100);
  const after=projectPension({...base,retirementAge:68,dbStartAge:65,stateStartAge:68});
  near(after.dbMonthlyIncluded,100);near(after.stateMonthlyIncluded,500);near(after.monthlyIncome,after.dcMonthly+600);
});
test('portfolio adapter preserves missing account values and missing assumptions',async()=>{
 const {calculateProjection,getVerifiedDashboardContext}=await import('../server/portfolioStore.js');
 const unknown=getVerifiedDashboardContext({userId:'oracle-empty-independent'});
 assert.equal(unknown.projection.status,'missing_inputs');assert.equal(unknown.assumptions.currentAge,null);assert.equal(unknown.projectedMonthlyIncome,'Not recorded');assert.deepEqual(unknown.contributionScenarios,[]);
 const state={assumptions:{...base,salary:12000,totalContributionPct:10,extraMonthlyContribution:0},accounts:[{pot:null}],statePension:{monthlyIncome:500}};
 assert.equal(calculateProjection(state).status,'missing_inputs');
 state.accounts[0]={pot:0,employee:99,employer:99,employeeYearly:999999,employerYearly:999999};const calculated=calculateProjection(state);assert.equal(calculated.status,'ready');near(calculated.monthlyContribution,100);near(calculated.finalPot,1200);
});
