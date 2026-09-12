import {generateLocalAnswerWithRetry} from './localModelService.js';
import {evaluateGeneratedAnswer} from './answerValidationService.js';

// Production retains the established availability/JSON retry policy.
// The isolated development diagnostic may test one semantic repair within the
// same two-call ceiling; that experiment has no formal qualification credit.
export async function generateValidatedAnswer({system,question,query,modelSources,modelContext,signal,maxAttempts=2,allowDevelopmentRepair=false}) {
 const budget=Math.max(1,Math.min(2,Number(maxAttempts)||1));
 let generated=await generateLocalAnswerWithRetry({system,...modelContext,signal,maxAttempts:budget});
 let evaluation=evaluateGeneratedAnswer({question,query,generated,modelSources,modelContext});
 const candidates=[{answer:generated.answer,rawContent:String(generated.rawContent||" ").replace(/<think>[\s\S]*?<\/think>/gi,"[reasoning omitted]"),validation:evaluation.validation,usage:generated.usage,finishReason:generated.finishReason}];
 if(allowDevelopmentRepair && process.env.QUALIFICATION_RUNTIME_MODE !== "true" && !evaluation.validation.valid && generated.generation_attempts<budget){
  signal?.throwIfAborted();
  const reason=evaluation.validation.reason;
  const repairContext={...modelContext,messages:[...modelContext.messages,
   {role:'assistant',content:JSON.stringify({answer:generated.answer,citation_ids:generated.citationIds})},
   {role:'user',content:`The draft was rejected by evidence validation (${reason}). Rewrite it once using only the VERIFIED SOURCES above. Do not treat the rejected draft as evidence. Keep source-specific conditions and territorial/scheme scope explicit. Answer the supported part and identify missing facts or unsupported subissues. Fulfil every Response requirement, including the necessary clarification question. Cite material sentences with the original S1, S2, ... tokens. Return the complete answer/citation_ids JSON.`}]};
  try{
   const repaired=await generateLocalAnswerWithRetry({system,...repairContext,signal,maxAttempts:1});
   const ledger=[...generated.generation_attempt_ledger,...repaired.generation_attempt_ledger.map(event=>({...event,attempt:2,retry_reason:'GROUNDING_REJECTED:'+reason}))];
   generated={...repaired,retry_used:true,retry_reason:'GROUNDING_REJECTED:'+reason,generation_attempts:2,generation_attempt_ledger:ledger};
   evaluation=evaluateGeneratedAnswer({question,query,generated,modelSources,modelContext});
   candidates.push({answer:generated.answer,rawContent:String(generated.rawContent||" ").replace(/<think>[\s\S]*?<\/think>/gi,"[reasoning omitted]"),validation:evaluation.validation,usage:generated.usage,finishReason:generated.finishReason});
  }catch(error){
   error.attempts=2;error.retry_reason='GROUNDING_REJECTED:'+reason;
   error.generation_attempt_ledger=[...generated.generation_attempt_ledger,...(error.generation_attempt_ledger||[]).map(event=>({...event,attempt:2}))];
   throw error;
  }
 }
 return {generated:{...generated,candidateAttempts:candidates},...evaluation};
}
