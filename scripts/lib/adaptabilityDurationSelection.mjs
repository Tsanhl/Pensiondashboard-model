function assessed(candidate){
  return candidate.assessment_status==='ASSESSED'
    && candidate.identity_valid===true
    && candidate.review_complete===true
    && Array.isArray(candidate.hard_failures)
    && candidate.hard_failures.length===0
    && Number.isFinite(candidate.validation_loss)
    && Number.isInteger(candidate.additional_update_count);
}

function semanticTuple(candidate){
  return [
    Number(candidate.correct_complete_or_justified_clarification||0),
    -Number(candidate.material_omissions||0),
    -Number(candidate.unnecessary_or_repeated_questions||0)
  ];
}

function compareSemantics(left,right){
  const a=semanticTuple(left),b=semanticTuple(right);
  for(let index=0;index<a.length;index+=1)if(a[index]!==b[index])return b[index]-a[index];
  return 0;
}

export function selectDurationCandidate(candidates,{lossTieTolerance=0.01}={}){
  if(!Number.isFinite(lossTieTolerance)||lossTieTolerance<0)throw new Error('A finite non-negative loss tie tolerance is required');
  const eligible=candidates.filter(assessed).sort((left,right)=>{
    const semantic=compareSemantics(left,right);if(semantic)return semantic;
    const denominator=Math.max(Math.abs(left.validation_loss),Math.abs(right.validation_loss),Number.EPSILON);
    const relative=Math.abs(left.validation_loss-right.validation_loss)/denominator;
    if(relative<=lossTieTolerance)return left.additional_update_count-right.additional_update_count;
    return left.validation_loss-right.validation_loss;
  });
  if(!eligible.length)return {selected:null,reason:'NO_FULLY_ASSESSED_HARD_GATE_CLEAN_CANDIDATE',eligible:[]};
  const best=eligible[0];
  const baseline=eligible.find((item)=>item.additional_update_count===0);
  if(best.additional_update_count!==0&&baseline&&compareSemantics(best,baseline)>=0){
    return {selected:baseline,reason:'NO_OBSERVED_SEMANTIC_BENEFIT_OVER_BASELINE',eligible};
  }
  return {selected:best,reason:best.additional_update_count===0?'BASELINE_RETAINED':'OBSERVED_VALIDATION_BENEFIT_WITHOUT_HARD_FAILURE',eligible};
}
