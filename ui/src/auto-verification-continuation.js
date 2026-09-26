const AUTOMATIC_KINDS=new Set(["command","tests"]);

export function automaticVerificationContinuationSupported(result={}){
  return result?.nextAction?.action==="verify"&&Boolean(result?.nextAction?.nextStep?.id)&&AUTOMATIC_KINDS.has(String(result?.nextAction?.nextStep?.kind||""));
}

export async function maybeStartAutomaticVerificationContinuation({rpc,threadId,result,seen}={}){
  const recordId=String(result?.record?.id||"").trim(),nextStepId=String(result?.nextAction?.nextStep?.id||"").trim();
  if(!rpc||!threadId||!recordId||!nextStepId||!automaticVerificationContinuationSupported(result))return {started:false,reason:"not-supported"};
  const key=recordId+":"+nextStepId;if(seen?.has?.(key))return {started:false,reason:"already-attempted"};
  seen?.add?.(key);if(seen?.size>500){const oldest=seen.values().next().value;if(oldest&&oldest!==key)seen.delete(oldest)}
  try{
    const response=await rpc.request("thread/verification/continue",{threadId,recordId,auto:true});
    return {started:Boolean(response?.turn?.id),recordId,nextStepId,turn:response?.turn||null,response};
  }catch(error){seen?.delete?.(key);throw error}
}
