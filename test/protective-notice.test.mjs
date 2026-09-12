import test from 'node:test';
import assert from 'node:assert/strict';
import {loadProtectiveNotice} from '../server/services/protectiveNoticeService.js';
test('source-bound safety notice works with no model/network and expires without claiming reviewed evidence',()=>{
 const notice=loadProtectiveNotice({now:Date.parse('2026-09-09')});assert.equal(notice.reviewed,true);assert.equal(notice.sources.length,4);assert.match(notice.response,/not proof/);
 const expired=loadProtectiveNotice({now:Date.parse('2026-10-09')});assert.equal(expired.reviewed,false);assert.match(expired.response,/Basic safety notice/);
 const corrupt=loadProtectiveNotice({read:()=>Buffer.from('{}')});assert.equal(corrupt.reviewed,false);assert.equal(corrupt.sources.length,0);
});
test('reviewed safety passages resolve through the controller evidence binder, without qualification credit',async()=>{
 const {protectiveNoticeEvidenceRecords,bindCaseEvidence}=await import('../scripts/lib/qualification-worker/trustedEvidence.mjs');
 const notice=loadProtectiveNotice();const records=protectiveNoticeEvidenceRecords();
 const bound=bindCaseEvidence([{case_id:'synthetic-safety-binding',sources:notice.sources}],new Map(records.map(x=>[x.source_id,x])))[0];
 assert.deepEqual(bound.untrusted_source_ids,[]);assert.equal(bound.trusted_evidence_records.length,4);assert.equal(notice.validation.formal_credit,false);
});
