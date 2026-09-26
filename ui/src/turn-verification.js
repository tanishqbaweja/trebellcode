function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

export async function requestTurnVerificationPlan({request,threadId,turnId,retries=3,sleep=wait}={}){
  if(typeof request!=="function")throw new Error("Verification planner request function is required.");
  const thread=String(threadId||"").trim(),turn=String(turnId||"").trim();
  if(!thread||!turn)return null;
  let result=null;
  for(let attempt=0;attempt<=Math.max(0,Number(retries)||0);attempt++){
    result=await request("/api/verification/plan-turn",{method:"POST",body:{threadId:thread,turnId:turn}});
    if(result?.supported!==false||result?.reason!=="checkpoint_unavailable"||attempt>=retries)return result;
    await sleep(100*(attempt+1));
  }
  return result;
}

export function verificationPlanEvent(result,turnId){
  if(!result?.record)return null;
  const assessment=result.record.assessment||{},summary=assessment.summary||{},required=Math.max(0,Number(summary.required)||0);
  const risk=String(result.record.risk||assessment.risk||result.record.plan?.risk||"unknown");
  const nextId=result.nextAction?.nextStep?.id?String(result.nextAction.nextStep.id):null;
  return {
    id:"verification-plan-"+String(turnId||result.record.turnId||Date.now()),
    kind:"verification",
    title:`Verification planned · ${risk} risk · ${required} required check${required===1?"":"s"}${nextId?" · next "+nextId:""}`,
    status:"pending",
    raw:{recordId:result.record.id||null,risk,required,nextAction:result.nextAction?.action||null,nextStepId:nextId,changedPaths:result.changedPaths||[]},
  };
}
