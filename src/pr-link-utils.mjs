function clean(value){return String(value??"").trim()}
function host(value){return clean(value).toLowerCase().replace(/^www\./,"")}
function repository(value){return clean(value).replace(/^\/+|\/+$/g,"").replace(/\.git$/i,"")}
function positive(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null}

export function parsePullRequestUrl(value){
  let url;try{url=new URL(clean(value))}catch{return null}
  const pathname=url.pathname.replace(/\/+$/,"");const hostname=host(url.hostname);
  let match;
  if((match=pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i))){
    return {provider:"github",host:hostname,repository:repository(match[1]+"/"+match[2]),number:positive(match[3]),url:url.href};
  }
  if((match=pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)$/i))){
    return {provider:"gitlab",host:hostname,repository:repository(match[1]),number:positive(match[2]),url:url.href};
  }
  if((match=pathname.match(/^\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/i))){
    return {provider:"forgejo",host:hostname,repository:repository(match[1]+"/"+match[2]),number:positive(match[3]),url:url.href};
  }
  if((match=pathname.match(/^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)$/i))){
    return {provider:"bitbucket",host:hostname,repository:repository(match[1]+"/"+match[2]),number:positive(match[3]),url:url.href};
  }
  if((match=pathname.match(/^\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/i))){
    return {provider:"azure-devops",host:hostname,repository:repository(match[1]+"/"+match[2]+"/"+match[3]),number:positive(match[4]),url:url.href};
  }
  if(hostname.endsWith(".visualstudio.com")&&(match=pathname.match(/^\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/i))){
    return {provider:"azure-devops",host:hostname,repository:repository(match[1]+"/"+match[2]),number:positive(match[3]),url:url.href};
  }
  return null;
}

export function normalizePullRequestIdentity(value={}){
  const parsed=value.url?parsePullRequestUrl(value.url):null;
  const provider=clean(value.provider||parsed?.provider).toLowerCase();
  const hostname=host(value.host||parsed?.host);
  const repo=repository(value.repository||parsed?.repository);
  const number=positive(value.number??parsed?.number);
  if(!hostname||!repo||!number)return null;
  return {provider:provider||null,host:hostname,repository:repo,number};
}

export function pullRequestIdentityKey(value={}){
  const identity=normalizePullRequestIdentity(value.identity||value);
  return identity?[identity.host,identity.repository.toLowerCase(),identity.number].join("|"):null;
}

export function pullRequestSnapshot(pr={}){
  const files=Array.isArray(pr.files)?pr.files:[];
  const additions=files.reduce((sum,file)=>sum+Number(file?.additions||0),0);
  const deletions=files.reduce((sum,file)=>sum+Number(file?.deletions||0),0);
  return {
    state:clean(pr.state||"OPEN").toUpperCase(),title:clean(pr.title||("PR #"+String(pr.number||""))),
    headBranch:clean(pr.headRefName),baseBranch:clean(pr.baseRefName),isDraft:Boolean(pr.isDraft),
    updatedAt:pr.updatedAt||pr.updated_at||null,syncedAt:new Date().toISOString(),closedAt:pr.closedAt||pr.closed_at||null,
    mergedAt:pr.mergedAt||pr.merged_at||null,author:pr.author||null,additions,deletions,changedFiles:files.length,
    reviewDecision:pr.reviewDecision||null,checksState:pr.checksState||null,mergeability:pr.mergeability||null,
  };
}

export function pullRequestStackSnapshot(stack){
  if(!stack||typeof stack!=="object")return null;
  const layers=(Array.isArray(stack.layers)?stack.layers:[]).map(layer=>({
    number:positive(layer.number),headBranch:clean(layer.headRefName||layer.headBranch),state:clean(layer.state||"OPEN").toUpperCase(),
  })).filter(layer=>layer.number&&layer.headBranch);
  const number=positive(stack.number);if(!number)return null;
  return {kind:"native",id:clean(stack.id||String(number)),number,url:clean(stack.url),base:clean(stack.baseRefName||stack.base),layers};
}

export function buildPullRequestLink(pr={},options={}){
  const identity=normalizePullRequestIdentity(pr.identity||{...pr,url:pr.url});if(!identity)throw new Error("Could not determine pull request host/repository identity");
  return {
    identity,url:clean(pr.url),source:clean(options.source||pr.source||"manual")||"manual",
    linkedAt:pr.linkedAt||new Date().toISOString(),snapshot:pullRequestSnapshot(pr),stack:pullRequestStackSnapshot(pr.stack),
    number:identity.number,title:clean(pr.title),state:clean(pr.state||"OPEN").toUpperCase(),
    headRefName:clean(pr.headRefName),baseRefName:clean(pr.baseRefName),provider:identity.provider,
  };
}

export function linkedPullRequestTerminalStatus(links=[]){
  const items=Array.isArray(links)?links.filter(Boolean):[];
  if(!items.length)return {terminal:false,reason:"no-links",signature:null};
  const normalized=items.map(link=>{
    const state=clean(link.snapshot?.state||link.state).toUpperCase();
    const syncedAt=link.snapshot?.syncedAt||null;
    const key=pullRequestIdentityKey(link)||clean(link.url)||String(link.number||"");
    const terminal=Boolean(syncedAt)&&["MERGED","CLOSED"].includes(state);
    return {key,state,syncedAt,terminal,closedAt:link.snapshot?.mergedAt||link.snapshot?.closedAt||null};
  });
  const unsynced=normalized.find(item=>!item.syncedAt);
  if(unsynced)return {terminal:false,reason:"unsynced",signature:null};
  const active=normalized.find(item=>!item.terminal);
  if(active)return {terminal:false,reason:"active",signature:null};
  const signature=normalized
    .map(item=>[item.key,item.state,item.closedAt||""].join(":"))
    .sort()
    .join("|");
  return {terminal:true,reason:"terminal",signature};
}

export function branchPullRequestSnapshot(pr={}){
  const identity=normalizePullRequestIdentity(pr.identity||pr);if(!identity)return null;
  return {
    identity,number:identity.number,title:clean(pr.title||("PR #"+identity.number)),
    state:clean(pr.state||"OPEN").toUpperCase(),url:clean(pr.url),
    headRefName:clean(pr.headRefName),baseRefName:clean(pr.baseRefName),
    isDraft:Boolean(pr.isDraft),stack:pullRequestStackSnapshot(pr.stack),detectedAt:new Date().toISOString(),
  };
}

export function pullRequestForBranch(branch,items=[]){
  const ref=clean(branch);if(!ref)return null;
  const match=(Array.isArray(items)?items:[]).find(pr=>clean(pr?.headRefName)===ref&&clean(pr?.state||"OPEN").toUpperCase()==="OPEN");
  return match?branchPullRequestSnapshot(match):null;
}
