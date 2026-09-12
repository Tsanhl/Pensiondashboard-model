import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTitlePinnedCandidates} from '../server/services/knowledgeService.js';
import {selectMandatorySources} from '../server/services/evidenceContractService.js';
import {validateGroundedAnswer} from '../server/services/groundingService.js';

test('named authority normalization preserves issuer-prefixed guidance and pinpointed legislation',()=>{
 const sources=[{sourceId:'noise',title:'Other pensions document'},{sourceId:'guide',title:'TPR Pension schemes under the employer duties — paragraphs 97–99'},{sourceId:'law',title:'Pensions Act 1995 — section 67'}];
 const chosen=selectTitlePinnedCandidates(sources,'Pension schemes under the employer duties; Pensions Act 1995 section 67',2);
 assert.deepEqual(chosen.map(x=>x.sourceId),['guide','law']);
});
test('scheme issue selection keeps overview and operative duty rather than unrelated provision of same statute',()=>{
 const sources=[{sourceId:'exceptions',title:'The Occupational and Personal Pension Schemes (Consultation by Employers and Miscellaneous Amendment) Regulations 2006',section:'Regulation 10 — excluded changes'}, {sourceId:'duty',title:'The Occupational and Personal Pension Schemes (Consultation by Employers and Miscellaneous Amendment) Regulations 2006',section:'Regulation 6 — Consultation required'}, {sourceId:'guide',title:'TPR Pension schemes under the employer duties'}, {sourceId:'rights',title:'Pensions Act 1995',section:'Section 67 — subsisting rights'}].map(x=>({...x,scope:'CURATED_PUBLIC'}));
 assert.deepEqual(selectMandatorySources(sources,{self_contained_query:'Does my employer need approval to change pension benefits?'},3).map(x=>x.sourceId),['guide','duty','rights']);
});
test('lexical match cannot validate unconditional consent from a conditional statute',()=>{
 const source={sourceId:'conditional_law',title:'Pensions Act 1995',scope:'CURATED_PUBLIC',effectiveDate:'2006-04-06',snippet:'If the modification is protected, the consent requirements apply. Otherwise either the consent requirements or actuarial equivalence requirements apply; the trustee approval requirement applies.'};
 const result=validateGroundedAnswer({answer:'An employer cannot change the scheme without the trustees decision and member consent.',citationIds:[source.sourceId],sources:[source],intent:'GENERAL'});
 assert.equal(result.valid,false);assert.equal(result.reason,'unqualified_legal_requirement');
 const bounded=validateGroundedAnswer({answer:'For a protected modification, the consent requirements apply.',citationIds:[source.sourceId],sources:[source],intent:'GENERAL'});
 assert.equal(bounded.valid,true);
});
test('occupational subsisting-rights rules cannot be applied to every arrangement',()=>{
 const source={sourceId:'conditional_law',title:'Pensions Act 1995',section:'Section 67 — subsisting rights',scope:'CURATED_PUBLIC',effectiveDate:'2006-04-06',snippet:'Occupational schemes: if a modification is protected consent requirements apply, otherwise either consent or actuarial equivalence requirements apply.'};
 const result=validateGroundedAnswer({answer:'An employer may change the scheme subject to trustee approval and member consent or actuarial equivalence conditions.',citationIds:[source.sourceId],sources:[source],intent:'GENERAL'});
 assert.equal(result.valid,false);assert.equal(result.reason,'legal_source_scope_exceeded');
});
test('an explanatory-note pseudo-heading is not treated as the operative regulation',async()=>{
 const {filterSourcesForQuery}=await import('../server/services/evidenceContractService.js');
 const sources=[{sourceId:'note',scope:'CURATED_PUBLIC',section:'Miscellaneous > Regulation 6 prohibits the making of listed changes without consultation.'},{sourceId:'operative',scope:'CURATED_PUBLIC',section:'Restriction > Regulation 6 — Consultation required before decisions'}];
 assert.deepEqual(filterSourcesForQuery(sources,{self_contained_query:'Can my employer change my pension scheme?'}).map(x=>x.sourceId),['operative']);
});
