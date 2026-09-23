function humanize(value){
  return String(value||"")
    .replace(/([a-z0-9])([A-Z])/g,"$1 $2")
    .replace(/[_-]+/g," ")
    .trim()
    .toLowerCase();
}

function compactStrings(values,max=6){
  return [...new Set((values||[]).map(value=>String(value||"").trim()).filter(Boolean))].slice(0,max);
}

export function codexModelEvent(message,modelLabel=id=>String(id||"")){
  const method=message?.method,params=message?.params||{};
  if(!params.threadId||!params.turnId)return null;

  if(method==="model/rerouted"){
    const fromModel=String(params.fromModel||""),toModel=String(params.toModel||"");
    if(!fromModel||!toModel)return null;
    const reason=humanize(params.reason);
    return {
      id:"model-rerouted-"+params.turnId,
      kind:"modelRouting",
      title:"Model rerouted: "+modelLabel(fromModel)+" → "+modelLabel(toModel)+(reason?" · "+reason:""),
      status:"done",
      raw:{fromModel,toModel,reason:params.reason||null},
    };
  }

  if(method==="model/safetyBuffering/updated"){
    const model=String(params.model||"");
    const active=Boolean(params.showBufferingUi);
    const fasterModel=params.fasterModel?String(params.fasterModel):null;
    const suffix=active&&fasterModel?" · faster option "+modelLabel(fasterModel):"";
    return {
      id:"model-safety-buffer-"+params.turnId,
      kind:"modelSafety",
      title:(active?"Safety buffering active":"Safety buffering cleared")+(model?" · "+modelLabel(model):"")+suffix,
      status:active?"running":"done",
      raw:{
        model:model||null,
        useCases:compactStrings(params.useCases),
        reasons:compactStrings(params.reasons),
        showBufferingUi:active,
        fasterModel,
      },
    };
  }

  if(method==="model/verification"){
    const verifications=compactStrings(params.verifications);
    if(!verifications.length)return null;
    return {
      id:"model-verification-"+params.turnId,
      kind:"modelSafety",
      title:"Model verification: "+verifications.map(humanize).join(", "),
      status:"done",
      raw:{verifications},
    };
  }

  if(method==="turn/moderationMetadata"){
    return {
      id:"moderation-"+params.turnId,
      kind:"modelSafety",
      title:"Moderation state updated for this turn",
      status:"done",
      raw:{metadataAvailable:params.metadata!=null},
    };
  }

  return null;
}
