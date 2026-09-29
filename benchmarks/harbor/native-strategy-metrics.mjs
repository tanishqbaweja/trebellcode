export function createNativeStrategyMetrics(){
  return {
    firstEditAtMs:null,
    editCount:0,
    convergenceCheckpoints:0,
    implementationPressureEvents:0,
    convergenceCallsBlocked:0,
    selfAdmittedVerificationGaps:0,
    selfAdmittedCompletionGaps:0,
  };
}

export function observeNativeStrategyEvent(metrics,event,atMs=null){
  const target=metrics&&typeof metrics==="object"?metrics:createNativeStrategyMetrics(),name=String(event?.name||""),data=event?.data||{};
  if(name==="native.tool.completed"&&event?.status==="completed"&&data?.namespace==="trebell_workspace"&&["write_file","replace_text"].includes(data?.name)){
    target.editCount=Number(target.editCount||0)+1;
    if(target.firstEditAtMs==null&&Number.isFinite(Number(atMs)))target.firstEditAtMs=Math.max(0,Math.round(Number(atMs)));
  }else if(name==="native.progress.convergence_checkpoint")target.convergenceCheckpoints=Number(target.convergenceCheckpoints||0)+1;
  else if(name==="native.progress.implementation_pressure")target.implementationPressureEvents=Number(target.implementationPressureEvents||0)+1;
  else if(name==="native.progress.convergence_call_blocked")target.convergenceCallsBlocked=Number(target.convergenceCallsBlocked||0)+1;
  else if(name==="native.verification.self_admitted_gap")target.selfAdmittedVerificationGaps=Number(target.selfAdmittedVerificationGaps||0)+1;
  else if(name==="native.completion.self_admitted_gap")target.selfAdmittedCompletionGaps=Number(target.selfAdmittedCompletionGaps||0)+1;
  return target;
}
