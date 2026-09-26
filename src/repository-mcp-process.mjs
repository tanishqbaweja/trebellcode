import { fileURLToPath } from "node:url";
import { trebellHome } from "./paths.mjs";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";

const REPOSITORY_MCP_NAME="trebell_repository";
const entrypoint=fileURLToPath(new URL("./repository-mcp-stdio.mjs",import.meta.url));

function environmentObject(env=process.env){
  const environment=buildRuntimeEnvironment("native",{parent:env});
  environment.TREBELL_REPOSITORY_ROOT=String(env.TREBELL_REPOSITORY_ROOT||"");
  if(env.TREBELL_HOME)environment.TREBELL_HOME=String(env.TREBELL_HOME);
  return environment;
}

export function repositoryMcpProcessConfig({root,env=process.env,execPath=process.execPath,electron=Boolean(process.versions?.electron)}={}){
  const workspace=String(root||"").trim();if(!workspace)throw new Error("Trebell repository MCP requires a workspace root.");
  const environment={...environmentObject({...env,TREBELL_REPOSITORY_ROOT:workspace,TREBELL_HOME:trebellHome(env)})};
  if(electron)environment.ELECTRON_RUN_AS_NODE="1";
  return {
    name:REPOSITORY_MCP_NAME,
    command:String(execPath),
    args:[entrypoint],
    env:Object.entries(environment).map(([name,value])=>({name,value:String(value)})),
    openCode:{type:"local",command:[String(execPath),entrypoint],environment,enabled:true,timeout:15_000},
  };
}

export function mergeAcpMcpServers(servers=[],repositoryServer=null){
  const rows=(Array.isArray(servers)?servers:[]).map(server=>({...server,args:[...(server.args||[])],env:(server.env||[]).map(item=>({...item}))}));
  if(!repositoryServer)return rows;
  const next={name:repositoryServer.name,command:repositoryServer.command,args:[...(repositoryServer.args||[])],env:(repositoryServer.env||[]).map(item=>({...item}))};
  const index=rows.findIndex(server=>String(server?.name||"")===next.name);if(index>=0)rows[index]=next;else rows.push(next);return rows;
}

export const repositoryMcpEntrypoint=entrypoint;
export const repositoryMcpName=REPOSITORY_MCP_NAME;
