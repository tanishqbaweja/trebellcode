export function messageText(item){
  if(typeof item?.text==="string")return item.text;
  if(Array.isArray(item?.content))return item.content.map(entry=>entry?.text||entry?.input_text||"").join("");
  return "";
}

export function historyFromTurns(turns=[],checkpointByTurn={}){
  const out=[];
  for(const turn of turns||[]){
    for(const item of turn?.items||[]){
      if(item?.type==="userMessage"){
        const text=messageText(item).trim();
        if(text)out.push({id:item.id,role:"user",text,turnId:turn.id,checkpointId:checkpointByTurn[turn.id]?.id||null});
      }else if(item?.type==="agentMessage"&&item.text?.trim()){
        out.push({id:item.id,role:"assistant",text:item.text,turnId:turn.id});
      }
    }
  }
  return out;
}

export function mergeHistoryMessages(earlier=[],current=[]){
  const seen=new Set();const merged=[];
  for(const message of [...(earlier||[]),...(current||[])]){
    const key=String(message?.id||`${message?.turnId||""}:${message?.role||""}:${message?.text||""}`);
    if(seen.has(key))continue;seen.add(key);merged.push(message);
  }
  return merged;
}

