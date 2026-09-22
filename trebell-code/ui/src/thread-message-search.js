export function searchableThreadMessage(item={}){
  if(item?.type!=="userMessage"&&item?.type!=="agentMessage")return "";
  if(typeof item.text==="string")return item.text.trim();
  if(Array.isArray(item.content))return item.content.map(part=>part?.text||part?.input_text||"").join("").trim();
  return "";
}

export function matchingMessageExcerpt(items,query,{maxLength=120}={}){
  const needle=String(query||"").trim().toLowerCase();if(needle.length<2)return null;
  for(const entry of items||[]){
    const text=searchableThreadMessage(entry?.item||entry);if(!text||!text.toLowerCase().includes(needle))continue;
    const normalized=text.replace(/\s+/g," ").trim();const lower=normalized.toLowerCase();const index=lower.indexOf(needle);
    const start=Math.max(0,index-35);const end=Math.min(normalized.length,start+Math.max(40,Number(maxLength)||120));
    return (start>0?"…":"")+normalized.slice(start,end)+(end<normalized.length?"…":"");
  }
  return null;
}
