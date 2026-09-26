export async function probeCompatibleRuntimeProfiles({runtimeManager,runtime="claude",environmentId=null,withTimeout=promise=>promise}={}){
  if(!runtimeManager)throw new Error("Runtime manager is required");
  const instances=runtimeManager.instances().filter(item=>item?.enabled!==false&&item?.kind===runtime);
  const probes=[];
  for(const instance of instances){
    const status=await withTimeout(runtimeManager.probe(instance,{environmentId}),`probe ${runtime} profile ${instance.id}`).catch(error=>({available:false,authenticated:null,version:null,message:error?.message||String(error)}));
    probes.push({id:instance.id,displayName:instance.displayName||instance.id,available:Boolean(status?.available),authenticated:status?.authenticated??null,version:status?.version||null,message:status?.message||null});
  }
  const byId=new Map(probes.map(item=>[item.id,item])),eligible=instances.filter(instance=>{const probe=byId.get(instance.id);return probe?.available&&probe?.authenticated!==false});
  let pair=null;
  for(const source of eligible){
    const compatible=new Set(runtimeManager.compatibleInstanceIds(source));
    const target=eligible.find(candidate=>candidate.id!==source.id&&compatible.has(candidate.id));
    if(target){pair={source,target};break}
  }
  return {
    runtime,
    probes,
    compatiblePair:pair?{sourceId:pair.source.id,targetId:pair.target.id}:null,
    skipReason:pair?null:(instances.length<2?`Fewer than two configured ${runtime} profiles are available.`:`No two available ${runtime} profiles share continuation identity.`),
  };
}

export function publicRuntimeProfileSmokeResult(result={},switchResult=null){
  return {
    runtime:String(result.runtime||"unknown"),
    profiles:(result.probes||[]).map(item=>({id:String(item.id||""),displayName:String(item.displayName||item.id||""),available:Boolean(item.available),authenticated:item.authenticated??null,version:item.version||null})),
    compatiblePair:result.compatiblePair||null,
    switched:Boolean(switchResult?.switched),
    fromInstanceId:switchResult?.fromInstanceId||result.compatiblePair?.sourceId||null,
    toInstanceId:switchResult?.toInstanceId||result.compatiblePair?.targetId||null,
    skipReason:result.skipReason||switchResult?.skipReason||null,
    inferenceTurns:0,
  };
}
