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

function pullRequestSearchText(link={}){
  const identity=link.identity||{};
  const snapshot=link.snapshot||{};
  return [
    link.url,link.title,link.state,link.headRefName,link.baseRefName,
    snapshot.title,snapshot.state,snapshot.headBranch,snapshot.baseBranch,
    identity.host,identity.repository,
    identity.number?String(identity.number):"",
    identity.number?"#"+String(identity.number):"",
  ].filter(Boolean).join(" ").toLowerCase();
}

export function matchingPullRequestExcerpt(meta={},query){
  const needle=String(query||"").trim().toLowerCase();if(needle.length<2)return null;
  const attachments=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{});
  const legacy=Array.isArray(meta.linkedPullRequests)?meta.linkedPullRequests:[];
  const seen=new Set();
  for(const link of [...attachments,...legacy]){
    const identity=link.identity||{};const key=[identity.host,identity.repository,identity.number,link.url].filter(Boolean).join("|");
    if(seen.has(key))continue;seen.add(key);
    if(!pullRequestSearchText(link).includes(needle))continue;
    const number=identity.number||link.number;const title=link.snapshot?.title||link.title||"Pull request";
    const repository=identity.repository?identity.repository+" · ":"";
    return repository+(number?"#"+number+" ":"")+title;
  }
  return null;
}
