import { isSecretCliArgument, isSecretCliFlag, isSecretEnvironmentName } from "./secret-redactor.mjs";

const ACP_MCP_RUNTIMES=new Set(["cursor","grok","antigravity"]);
const STDIO_MCP_RUNTIMES=new Set(["native","claude",...ACP_MCP_RUNTIMES]);

function text(value,max){return String(value??"").trim().slice(0,max)}
function environmentId(value){const next=text(value,200);return next||null}

export function normalizeMcpServers(value){
  if(!Array.isArray(value))return [];
  const out=[];const ids=new Set();
  for(const raw of value.slice(0,50)){
    if(!raw||typeof raw!=="object")continue;
    const runtime=text(raw.runtime,40).toLowerCase();
    if(!STDIO_MCP_RUNTIMES.has(runtime))continue;
    const name=text(raw.name,120),command=text(raw.command,4000);
    if(!name||!command)continue;
    let id=text(raw.id,160)||`${runtime}:${environmentId(raw.environmentId)||"local"}:${name}`;
    if(ids.has(id))id=id+":"+(out.length+1);ids.add(id);
    const args=[];const rawArgs=Array.isArray(raw.args)?raw.args.slice(0,64):[];
    for(let index=0;index<rawArgs.length;index++){
      const arg=String(rawArgs[index]??"").slice(0,4000);
      if(isSecretCliArgument(arg)){
        if(isSecretCliFlag(arg)&&index+1<rawArgs.length)index++;
        continue;
      }
      args.push(arg);
    }
    const env=[];const envNames=new Set();
    for(const item of Array.isArray(raw.env)?raw.env.slice(0,64):[]){
      if(!item||typeof item!=="object")continue;
      const envName=text(item.name,160);if(!envName||envNames.has(envName))continue;envNames.add(envName);
      if(isSecretEnvironmentName(envName))continue;
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

export function claudeMcpServersForSession(value,{environmentId:targetEnvironmentId=null}={}){
  const targetEnvironment=environmentId(targetEnvironmentId),servers={};
  for(const item of normalizeMcpServers(value)){
    if(!item.enabled||item.runtime!=="claude"||item.environmentId!==targetEnvironment)continue;
    servers[item.name]={type:"stdio",command:item.command,args:[...item.args],env:Object.fromEntries(item.env.map(entry=>[entry.name,entry.value]))};
  }
  return servers;
}

export function nativeMcpServersForSession(value,{environmentId:targetEnvironmentId=null}={}){
  const targetEnvironment=environmentId(targetEnvironmentId);
  return normalizeMcpServers(value)
    .filter(item=>item.enabled&&item.runtime==="native"&&item.environmentId===targetEnvironment)
    .map(item=>({...item,args:[...item.args],env:item.env.map(entry=>({...entry}))}));
}

export function supportsAcpMcpInjection(runtime){return ACP_MCP_RUNTIMES.has(text(runtime,40).toLowerCase())}
export function supportsMcpInjection(runtime){return STDIO_MCP_RUNTIMES.has(text(runtime,40).toLowerCase())}
