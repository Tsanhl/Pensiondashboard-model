import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPdu50EvaluatorRole,loadPdu50HarnessRole,loadPdu50ProductRole,reconcilePdu50SourceCatalog} from '../scripts/lib/pdu50Pack.mjs';
import {applyAuthorisedPduMutation,mapPduFixtureToPortfolio,seedPduFixture} from '../scripts/lib/pdu50FixtureMapper.mjs';
import {getVerifiedDashboardContext,calculateProjection} from '../server/portfolioStore.js';
import {readKnowledgeChunks,readPortfolio} from '../server/store/userDataStore.js';

const harness=loadPdu50HarnessRole();
const fixture=(id)=>structuredClone(harness.fixturePack.fixtures[id]);
const near=(left,right)=>assert.ok(Math.abs(left-right)<0.01,`${left} != ${right}`);

test('PDU50 trust-role loaders keep model-visible messages free of setup and gold fields',()=>{
  const product=loadPdu50ProductRole();
  const evaluator=loadPdu50EvaluatorRole();
  assert.equal(product.role,'MODEL_VISIBLE_PRODUCT_MESSAGES');
  assert.equal(product.messages.length,50);
  assert.equal(product.messages.reduce((sum,row)=>sum+row.user_turns.length,0),60);
  assert.ok(product.messages.every((row)=>Object.keys(row).sort().join(',')==='case_id,user_turns'));
  assert.equal(evaluator.role,'EVALUATOR_ONLY_NOT_MODEL_INPUT');
  assert.equal(evaluator.cases.length,50);
  assert.ok(!Object.hasOwn(product,'cases'));
  assert.ok(!Object.hasOwn(product,'numericReference'));
  const sourceReadiness=reconcilePdu50SourceCatalog();
  assert.equal(sourceReadiness.source_leads,24);
  assert.equal(sourceReadiness.exact_canonical_matches,2);
  assert.equal(sourceReadiness.automatically_admitted_for_pdu50,0);
  assert.deepEqual(sourceReadiness.records.filter((record)=>record.exact_local_match_count).map((record)=>record.source_id),['PUB_MODIFY_GB','PUB_TPR']);
});

test('F_MAIN maps through the real portfolio shape without capitalising DB income',()=>{
  const mapped=mapPduFixtureToPortfolio(fixture('F_MAIN'));
  assert.equal(mapped.userId,'pdu-user-A');
  assert.equal(mapped.accounts.filter((account)=>!/defined benefit/i.test(account.type)).reduce((sum,account)=>sum+account.pot,0),100000);
  assert.equal(mapped.accounts.find((account)=>account.schemeType==='DEFINED_BENEFIT').pot,null);
  assert.equal(mapped.assumptions.grossMonthlyContribution,580);
  assert.equal(mapped.assumptions.dbMonthly,200);
  assert.equal(mapped.assumptions.dbIncomeStartAge,65);
  assert.equal(mapped.statePension.startAge,68);
  assert.equal(mapped.supplementalRecords.fixture_record.data_kind,'SYNTHETIC_DEVELOPMENT_ONLY_NOT_OWNER_DATA');
});

test('PDU numeric reference agrees with the product projection and later-benefit gates',()=>{
  const mapped=mapPduFixtureToPortfolio(fixture('F_MAIN'));
  const reference=loadPdu50EvaluatorRole().numericReference;
  const current=calculateProjection(mapped);
  near(current.finalPot,reference.main_scenarios[0].dc_pot_unrounded);
  near(current.monthlyIncome,reference.main_scenarios[0].monthly_income_unrounded);
  assert.equal(current.dbMonthlyIncluded,200);
  assert.equal(current.stateMonthlyIncluded,0);
  const early=calculateProjection({...mapped,assumptions:{...mapped.assumptions,retirementAge:60}});
  near(early.finalPot,reference.retire60.dc_pot_unrounded);
  near(early.monthlyIncome,reference.retire60.monthly_income_unrounded);
  assert.equal(early.dbMonthlyIncluded,0);
  assert.equal(early.stateMonthlyIncluded,0);
});

test('seeding uses user-scoped stores, preserves span locators and quarantines instruction-like text',async()=>{
  const injected=fixture('F_INJECTION');
  const receipt=await seedPduFixture(injected);
  assert.equal(receipt.evaluator_material_loaded,false);
  assert.equal(readPortfolio(injected.user_id).userId,injected.user_id);
  const chunks=readKnowledgeChunks(injected.user_id);
  const bad=chunks.filter((chunk)=>chunk.documentId==='bad-guide');
  assert.ok(bad.length>0);
  assert.ok(bad.every((chunk)=>chunk.userId===injected.user_id));
  assert.ok(bad.some((chunk)=>chunk.metadata.quarantined===true));
  const located=chunks.find((chunk)=>chunk.id==='fern-terms:s1');
  assert.equal(located.metadata.spanId,'fern-terms:s1');
  assert.equal(located.sectionPath,'Synthetic text section 1');
});

test('real user namespaces remain isolated and the authorised turn-two mutation replaces only current facts',async()=>{
  await seedPduFixture(fixture('F_MAIN'));
  await seedPduFixture(fixture('F_OTHER_USER'));
  const owner=getVerifiedDashboardContext({userId:'pdu-user-A'});
  const other=getVerifiedDashboardContext({userId:'pdu-user-B'});
  assert.equal(owner.pensionPotValue,'£100,000');
  assert.equal(other.pensionPotValue,'£912,345');
  assert.notEqual(owner.snapshotId,other.snapshotId);
  const original=fixture('F_UPDATE_AFTER_TURN');
  const changed=applyAuthorisedPduMutation(original,harness.fixturePack.authorised_harness_mutations.M_FERN_VERIFIED_8);
  assert.equal(original.projection.total_gross_monthly_credit_gbp,580);
  assert.equal(changed.projection.total_gross_monthly_credit_gbp,620);
  assert.equal(mapPduFixtureToPortfolio(changed).assumptions.grossMonthlyContribution,620);
  assert.ok(calculateProjection(mapPduFixtureToPortfolio(changed)).finalPot>calculateProjection(mapPduFixtureToPortfolio(original)).finalPot);
  const missing=structuredClone(harness.fixturePack.authorised_harness_mutations.M_FERN_VERIFIED_8);
  missing.account_updates.employer_gross_monthly.value=null;
  assert.equal(applyAuthorisedPduMutation(original,missing).projection.total_gross_monthly_credit_gbp,null);
  await seedPduFixture(changed);
  const updated=getVerifiedDashboardContext({userId:'pdu-user-A'});
  const fern=updated.pensionAccounts.find((account)=>account.rawFacts.scheme_id==='fern');
  assert.equal(fern.facts.employerContributionPct,8);
  assert.equal(fern.facts.employerContributionAnnual,3840);
  assert.equal(fern.provenance.status,'verified_record');
  assert.equal(updated.supplementalRecords.fixture_record.record_version,'pdu-after-payroll-correction-v2');
});
