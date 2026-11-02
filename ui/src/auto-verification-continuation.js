const AUTOMATIC_KINDS=new Set(["command","tests","behavioral"]);

// stopped: the reading of a check turn whose check the person did not allow (the server's plan-turn), after which checking waits for them.
export function automaticVerificationContinuationSupported(result={}){
  return !result?.stopped&&result?.nextAction?.action==="verify"&&Boolean(result?.nextAction?.nextStep?.id)&&AUTOMATIC_KINDS.has(String(result?.nextAction?.nextStep?.kind||""));
}

// The automatic repair or check a plan asks for, asked of the harness once per key by this window (seen keeps the last 500): a key
// is given back when the ask failed, so the next plan may ask again.
async function startAutomatic({rpc,threadId,seen},method,key,recordId){
  if(seen?.has?.(key))return {started:false,reason:"already-attempted"};
  seen?.add?.(key);if(seen?.size>500){const oldest=seen.values().next().value;if(oldest&&oldest!==key)seen.delete(oldest)}
  try{
    const response=await rpc.request(method,{threadId,recordId,auto:true});
    return {started:Boolean(response?.turn?.id),recordId,turn:response?.turn||null,response};
  }catch(error){seen?.delete?.(key);throw error}
}

// One repair per failed record.
export async function maybeStartAutomaticVerificationRepair(options={}){
  const recordId=String(options.result?.record?.id||"").trim();
  if(!options.rpc||!options.threadId||!recordId||options.result?.nextAction?.action!=="repair")return {started:false,reason:"not-required"};
  return startAutomatic(options,"thread/verification/repair",recordId,recordId);
}

// One check turn per step of a chain: each check turn's reading is a record of its own, so the key is the chain's first record
// (rootRecordId) and the step, and a step its check turn left unchecked is not checked again by itself.
export async function maybeStartAutomaticVerificationContinuation(options={}){
  const result=options.result,recordId=String(result?.record?.id||"").trim(),nextStepId=String(result?.nextAction?.nextStep?.id||"").trim();
  if(!options.rpc||!options.threadId||!recordId||!nextStepId||!automaticVerificationContinuationSupported(result))return {started:false,reason:"not-supported"};
  return {...await startAutomatic(options,"thread/verification/continue",String(result.rootRecordId||recordId)+":"+nextStepId,recordId),nextStepId};
}
