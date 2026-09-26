export async function maybeStartAutomaticVerificationRepair({rpc,threadId,result,seen}={}){
  const recordId=String(result?.record?.id||"").trim();
  if(!rpc||!threadId||!recordId||result?.nextAction?.action!=="repair")return {started:false,reason:"not-required"};
  if(seen?.has?.(recordId))return {started:false,reason:"already-attempted"};
  seen?.add?.(recordId);
  if(seen?.size>500){const oldest=seen.values().next().value;if(oldest&&oldest!==recordId)seen.delete(oldest)}
  try{
    const response=await rpc.request("thread/verification/repair",{threadId,recordId,auto:true});
    return {started:Boolean(response?.turn?.id),recordId,turn:response?.turn||null,response};
  }catch(error){seen?.delete?.(recordId);throw error}
}
