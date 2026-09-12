import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionCounts,requireSelectionControls,selectionControlIds} from '../scripts/lib/adaptabilitySelectionControls.mjs';
test('selection counts cannot silently default unreviewed omissions and questions to zero',()=>{
 assert.throws(()=>selectionCounts({limitations:[]}));
 assert.throws(()=>selectionCounts({limitations:['SELECTION_COUNTS={"material_omissions":-1,"unnecessary_questions":0}']}));
 const reviewer={cases:selectionControlIds.map((case_id,i)=>({case_id,verdict:i?'PARTIAL':'PASS',limitations:['SELECTION_COUNTS='+JSON.stringify({material_omissions:i,unnecessary_questions:i})]}))};
 assert.equal(requireSelectionControls(reviewer),true);
 reviewer.cases[1].verdict='PASS';assert.throws(()=>requireSelectionControls(reviewer));
});
