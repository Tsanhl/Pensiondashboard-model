import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDevelopmentTrainingVerdicts} from '../scripts/lib/qualification-worker/aiReview.mjs';
const checks={source_supported:true,scope_and_conditions:true,complete_for_question:true,clarification_appropriate:true,citation_mapping:true,no_fabricated_facts:true,input_target_separation:true};
const packet={items:[{item_id:'one'},{item_id:'two'}]};
const output=()=>({items:packet.items.map(x=>({...x,verdict:'PASS',checks:{...checks}}))});
test('development training requires two complete passing independent outputs',()=>{
 assert.equal(validateDevelopmentTrainingVerdicts(packet,[output(),output()]),true);
 assert.equal(validateDevelopmentTrainingVerdicts(packet,[output()]),false);
 const missing=output();missing.items.pop();assert.equal(validateDevelopmentTrainingVerdicts(packet,[output(),missing]),false);
 const duplicate=output();duplicate.items[1].item_id='one';assert.equal(validateDevelopmentTrainingVerdicts(packet,[output(),duplicate]),false);
 const wrong=output();wrong.items[0].checks.scope_and_conditions=false;assert.equal(validateDevelopmentTrainingVerdicts(packet,[output(),wrong]),false);
 const hold=output();hold.items[0].verdict='HOLD';assert.equal(validateDevelopmentTrainingVerdicts(packet,[hold,output()]),false);
});
