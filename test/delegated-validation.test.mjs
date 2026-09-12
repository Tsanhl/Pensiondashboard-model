import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {delegatedValidationSupervisor} from '../scripts/lib/delegatedValidation.mjs';
test('delegated supervisor changes only validation watchdog and relocated import paths',()=>{
 const source=readFileSync(resolve('scripts/runAdaptabilityResumeProof.mjs'),'utf8');
 const generated=delegatedValidationSupervisor(source,resolve('.'));
 const normalized=generated.replace('{...plan.stage_seconds,full_validation:420}','plan.stage_seconds')
  .replace(/from 'file:[^']+\/scripts\/(lib\/[^']+)'/g,(_,p)=>`from './${p}'`);
 assert.equal(normalized,source);
 assert.throws(()=>delegatedValidationSupervisor('changed supervisor','/tmp'),/template changed/);
 assert.ok(generated.includes("resourceLimitViolation(plan.resource_limits,sample)"));
 assert.ok(generated.includes('maximum=segment?.maximum_updates??2'));
});
