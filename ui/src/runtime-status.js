export function runtimeStatusForKind(agentInfo,kind,{preferSelected=false}={}){
  const wanted=String(kind||"");
  if(!wanted)return null;
  const statuses=Array.isArray(agentInfo?.statuses)?agentInfo.statuses:[];
  const selected=statuses.find(item=>item?.kind===wanted&&item?.id===agentInfo?.selectedInstanceId)||null;
  if(preferSelected&&selected)return selected;
  return statuses.find(item=>item?.kind===wanted&&item?.available)||selected||statuses.find(item=>item?.kind===wanted)||null;
}
