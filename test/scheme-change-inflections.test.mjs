import test from 'node:test';
import assert from 'node:assert/strict';
import {processQuery,legalSchemeChangeQuestion} from '../server/services/queryProcessorService.js';

test('ordinary employer-change verb forms retain mandatory public legal retrieval',()=>{
 for(const phrase of ['reduces future contributions','is reducing future contributions','reduced future contributions','lowers future contributions','stops future accrual','closes future membership','alters future benefits']){
  const question=`The employer ${phrase} in an occupational pension scheme in England. What should members check?`;
  assert.equal(legalSchemeChangeQuestion(question),true,phrase);
  const query=processQuery(question);
  assert.equal(query.legal_evidence_required,true,phrase);
  assert.equal(query.public_evidence_required,true,phrase);
  assert.ok(query.source_scopes.includes('CURATED_PUBLIC'),phrase);
  assert.match(query.retrieval_query,/section 67|regulation 6/i,phrase);
 }
});
test('unrelated record and interface changes do not become employer amendment questions',()=>{
 for(const question of ['What is the current pension scheme balance?','The company changes my mailing address.','Can I change the text size in my dashboard?'])assert.equal(legalSchemeChangeQuestion(question),false,question);
});
