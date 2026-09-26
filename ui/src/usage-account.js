export function codexRateLimitEntries(response){
  const byId=response?.rateLimitsByLimitId;
  if(byId&&typeof byId==="object"&&!Array.isArray(byId)){
    const entries=Object.entries(byId).filter(([,value])=>value&&typeof value==="object");
    if(entries.length)return entries.map(([id,value])=>({id,label:value.limitName||id,snapshot:value}));
  }
  const snapshot=response?.rateLimits;
  if(!snapshot||typeof snapshot!=="object")return [];
  return [{id:snapshot.limitId||"default",label:snapshot.limitName||snapshot.normalModelSlug||"Codex",snapshot}];
}

export function rateLimitRemainingPercent(window){
  if(!window)return null;
  const used=Number(window.usedPercent);
  if(!Number.isFinite(used))return null;
  return Math.max(0,Math.min(100,100-used));
}

export function unixSecondsToDate(value){
  const seconds=Number(value);
  return Number.isFinite(seconds)&&seconds>0?new Date(seconds*1000):null;
}

export function formatRateReset(value,now=Date.now()){
  const date=unixSecondsToDate(value);if(!date)return "reset time unavailable";
  const diff=date.getTime()-now;
  if(diff<=0)return "reset due";
  const mins=Math.ceil(diff/60000);
  if(mins<60)return `resets in ${mins}m`;
  const hours=Math.floor(mins/60),remaining=mins%60;
  if(hours<48)return `resets in ${hours}h${remaining?` ${remaining}m`:""}`;
  return `resets ${date.toLocaleString()}`;
}

export function microsToCurrency(value){
  if(value==null)return null;
  const micros=Number(value);
  return Number.isFinite(micros)?micros/1_000_000:null;
}

export function rateLimitReachedLabel(value){
  return ({
    rate_limit_reached:"Rate limit reached",
    rateLimitReached:"Rate limit reached",
    workspace_owner_credits_depleted:"Workspace credits depleted",
    workspaceOwnerCreditsDepleted:"Workspace credits depleted",
    workspace_member_credits_depleted:"Workspace credits depleted",
    workspaceMemberCreditsDepleted:"Workspace credits depleted",
    workspace_owner_usage_limit_reached:"Workspace usage limit reached",
    workspaceOwnerUsageLimitReached:"Workspace usage limit reached",
    workspace_member_usage_limit_reached:"Workspace usage limit reached",
    workspaceMemberUsageLimitReached:"Workspace usage limit reached",
  })[value]||String(value||"");
}
