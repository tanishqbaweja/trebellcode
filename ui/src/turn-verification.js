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

// The row shows the assessment made when the turn ended. Checks the turn already ran count toward it, so a turn that ran them
// reads as verified or failed rather than as a plan still waiting.
export function verificationPlanEvent(result,turnId){
  if(!result?.record)return null;
  const assessment=result.record.assessment||{},summary=assessment.summary||{},count=key=>Math.max(0,Number(summary[key])||0),required=count("required");
  const risk=String(result.record.risk||assessment.risk||result.record.plan?.risk||"unknown");
  const nextId=result.nextAction?.nextStep?.id?String(result.nextAction.nextStep.id):null,next=nextId?" · next "+nextId:"";
  const checks=n=>`${n} required check${n===1?"":"s"}`,outcome=String(assessment.status||result.record.status||"");
  const row=outcome==="verified"?{title:`Verified · ${risk} risk · ${required?checks(required)+" passed":"no required checks"}`,status:"done"}
    :outcome==="failed"?{title:`Verification failed · ${risk} risk · ${count("failed")} of ${checks(required)} failed`,status:"failed"}
    :outcome==="blocked"?{title:`Verification blocked · ${risk} risk · ${count("blocked")} of ${checks(required)} blocked${next}`,status:"warning"}
    :{title:`Verification planned · ${risk} risk · ${checks(required)}${count("passed")?` · ${count("passed")} passed`:""}${next}`,status:"incomplete"};
  return {
    id:"verification-plan-"+String(turnId||result.record.turnId||Date.now()),
    kind:"verification",
    ...row,
    raw:{recordId:result.record.id||null,risk,required,outcome:outcome||null,nextAction:result.nextAction?.action||null,nextStepId:nextId,changedPaths:result.changedPaths||[]},
  };
}
