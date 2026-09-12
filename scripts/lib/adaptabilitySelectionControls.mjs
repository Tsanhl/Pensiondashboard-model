export const selectionControlIds=['selection-control-record-answer','selection-control-redundant-question'];
export function selectionControls(){
 const source={evidence_id:'S1',sourceId:'selection-control-fee-record',title:'Synthetic calibration record',snippet:'FICTIONAL CALIBRATION RECORD: the recorded annual fee is £8. This is an invented account record, not legislation.',scope:'USER_DOCUMENTS',sourceType:'SYNTHETIC_RECORD'};
 return selectionControlIds.map((case_id,index)=>({case_id,question:'What annual fee is recorded?',generated_answer:index===0?'The recorded annual fee is £8. {{cite:S1}}':'What annual fee is recorded?',raw_json_complete:true,evidence:[source],citation_aliases:{S1:source.sourceId},limitations:['Static evaluator calibration answer, not model generation and not a selection candidate outcome']}));
}
export function selectionCounts(review){
 const entries=review.limitations.filter(x=>x.startsWith('SELECTION_COUNTS='));
 if(entries.length!==1)throw Error('Missing independent selection counts; candidate unassessed');
 const n=JSON.parse(entries[0].slice('SELECTION_COUNTS='.length));
 if(!Number.isInteger(n.material_omissions)||n.material_omissions<0||!Number.isInteger(n.unnecessary_questions)||n.unnecessary_questions<0)throw Error('Invalid selection counts');
 return n;
}
export function requireSelectionControls(reviewer){
 const positive=reviewer.cases.find(x=>x.case_id===selectionControlIds[0]);
 const negative=reviewer.cases.find(x=>x.case_id===selectionControlIds[1]);
 if(!positive||!negative)throw Error('Selection calibration controls missing');
 const good=selectionCounts(positive),bad=selectionCounts(negative);
 if(positive.verdict!=='PASS'||good.material_omissions!==0||good.unnecessary_questions!==0||negative.verdict==='PASS'||bad.material_omissions<1||bad.unnecessary_questions<1)throw Error('Independent selection-count calibration failed');
 return true;
}
