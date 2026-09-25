const ACP_MCP_RUNTIMES=new Set(["cursor","grok","antigravity"]);

function text(value,max){return String(value??"").trim().slice(0,max)}
function environmentId(value){const next=text(value,200);return next||null}

export function normalizeMcpServers(value){
  if(!Array.isArray(value))return [];
  const out=[];const ids=new Set();
  for(const raw of value.slice(0,50)){
    if(!raw||typeof raw!=="object")continue;
    const runtime=text(raw.runtime,40).toLowerCase();
    if(!ACP_MCP_RUNTIMES.has(runtime))continue;
    const name=text(raw.name,120),command=text(raw.command,4000);
    if(!name||!command)continue;
    let id=text(raw.id,160)||`${runtime}:${environmentId(raw.environmentId)||"local"}:${name}`;
    if(ids.has(id))id=id+":"+(out.length+1);ids.add(id);
    const args=Array.isArray(raw.args)?raw.args.slice(0,64).map(item=>String(item??"").slice(0,4000)):[];
    const env=[];const envNames=new Set();
    for(const item of Array.isArray(raw.env)?raw.env.slice(0,64):[]){
      if(!item||typeof item!=="object")continue;
      const envName=text(item.name,160);if(!envName||envNames.has(envName))continue;envNames.add(envName);
      env.push({name:envName,value:String(item.value??"").slice(0,12000)});
    }
    out.push({id,name,type:"stdio",runtime,environmentId:environmentId(raw.environmentId),enabled:raw.enabled!==false,command,args,env});
  }
  return out;
}

export function acpMcpServersForSession(value,{runtime,environmentId:targetEnvironmentId=null}={}){
  const targetRuntime=text(runtime,40).toLowerCase(),targetEnvironment=environmentId(targetEnvironmentId);
  return normalizeMcpServers(value)
    .filter(item=>item.enabled&&item.runtime===targetRuntime&&item.environmentId===targetEnvironment)
    .map(item=>({name:item.name,command:item.command,args:[...item.args],env:item.env.map(entry=>({...entry}))}));
}

export function supportsAcpMcpInjection(runtime){return ACP_MCP_RUNTIMES.has(text(runtime,40).toLowerCase())}
