import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadPdu50HarnessRole,loadPdu50ProductRole} from './lib/pdu50Pack.mjs';

function option(name){
  const index=process.argv.indexOf(name);
  return index>=0?process.argv[index+1]:null;
}
const rawCase=option('--case');
const outputArg=option('--output');
if(!rawCase||!outputArg)throw new Error('Usage: npm run pdu50:prepare-case -- --case PDU50-001 --output /fresh/private/directory');
const caseId=/^\d+$/.test(rawCase)?`PDU50-${String(Number(rawCase)).padStart(3,'0')}`:rawCase;
if(!/^PDU50-(?:00[1-9]|0[1-4]\d|050)$/.test(caseId))throw new Error('Case must be PDU50-001 through PDU50-050');
const output=resolve(outputArg);
if(existsSync(output))throw new Error('A fresh, non-existing output directory is required');
mkdirSync(output,{recursive:true,mode:0o700});

process.env.PENSIONS_STORAGE='sqlite';
process.env.PENSIONS_DB_PATH=resolve(output,'pdu50.sqlite');
process.env.ALLOW_DEGRADED_EMBEDDINGS='true';

const product=loadPdu50ProductRole();
const harness=loadPdu50HarnessRole();
const setup=harness.setup.find((row)=>row.case_id===caseId);
const message=product.messages.find((row)=>row.case_id===caseId);
if(!setup||!message)throw new Error('Case material is incomplete');
const fixture=harness.fixturePack.fixtures[setup.fixture_id];
if(!fixture)throw new Error('Fixture is missing');
const {seedPduFixture}=await import('./lib/pdu50FixtureMapper.mjs');
const receipts=[await seedPduFixture(structuredClone(fixture))];
if(caseId==='PDU50-046')receipts.push(await seedPduFixture(structuredClone(harness.fixturePack.fixtures.F_OTHER_USER)));
const receipt={scope:'PDU50_VISIBLE_DEVELOPMENT_CASE_PREPARATION_ONLY',case_id:caseId,suite_id:product.suite.suite_id,database:process.env.PENSIONS_DB_PATH,fixture_id:setup.fixture_id,seed_receipts:receipts,product_message:message,harness_followup:{before_turn_2_mutation_ref:setup.before_turn_2_mutation_ref,harness_only_setup:setup.harness_only_setup},evaluator_material_loaded:false,model_generation:'NOT_RUN',browser_evaluation:'NOT_RUN',formal_credit:false,sealed_unseen_accessed:false};
writeFileSync(resolve(output,'preparation-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,case_id:caseId,database:process.env.PENSIONS_DB_PATH,users:receipts.map((item)=>item.user_id),model_generation:'NOT_RUN',evaluator_material_loaded:false}));
