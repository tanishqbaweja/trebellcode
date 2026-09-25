function unsupported(error){
  return Number(error?.code)===-32601||/unsupported|not found|does not expose/i.test(String(error?.message||""));
}

async function json(response){
  const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||("Verification repair context failed ("+response.status+")"));return body;
}

export async function startSameThreadVerificationRepair({rpc,thread,fetcher=fetch}={}){
  if(!rpc)throw new Error("Agent harness is not connected.");
  const threadId=String(thread?.id||"").trim();if(!threadId)throw new Error("Open a thread before starting verification repair.");
  if(thread?.status?.type==="active")throw new Error("Stop the running turn before starting verification repair.");
  try{return await rpc.request("thread/verification/repair",{threadId})}
  catch(error){
    if(!unsupported(error))throw error;
  }
  const prepared=await json(await fetcher("/api/verification-records/repair-context",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId})}));
  const turn=await rpc.request("turn/start",{
    threadId,
    input:[{type:"text",text:prepared.prompt}],
    additionalContext:{"trebell.verification_repair":{kind:"application",value:prepared.context}},
  });
  return {record:prepared.record,nextAction:prepared.nextAction,turn:turn?.turn||null,fallback:true};
}
