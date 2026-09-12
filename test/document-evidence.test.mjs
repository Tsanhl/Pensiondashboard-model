import test from 'node:test';
import assert from 'node:assert/strict';
import {describeDocumentEvidence} from '../server/services/documentEvidenceService.js';
test('document evidence distinguishes confirmation, conflict, missing values and locators',()=>{
 const text=describeDocumentEvidence({extracted:{potValue:12345,chargePct:.4,provider:'Provider Z',reviewFields:[{field:'salaryAnnual'},{field:'chargePct'}]},fieldEvidence:{potValue:{confirmedAt:'2026-09-08',locator:'page 2, benefits'},chargePct:{status:'conflict',locator:'page 4, fees'}}});
 assert.match(text,/potValue: 12345 \(confirmed; source locator page 2, benefits\)/);
 assert.match(text,/chargePct: 0.4 \(conflict; pending review/);
 assert.match(text,/provider: Provider Z \(unconfirmed; source locator not recorded/);
 assert.match(text,/Missing fields requiring review: salaryAnnual/);
 assert.doesNotMatch(text,/reviewFields:|fieldConfidence:/);
});
