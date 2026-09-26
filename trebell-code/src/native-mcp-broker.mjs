import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MAX_TOOLS_PER_SERVER=100;
const MAX_TOTAL_TOOLS=200;
const MAX_TOOL_TEXT=128*1024;
const DISCOVERY_NAMESPACE="trebell_mcp";
const DISCOVERY_TOOL="discover";
const DISCOVERY_DEFINITION=Object.freeze({
  namespace:DISCOVERY_NAMESPACE,name:DISCOVERY_TOOL,description:"Search configured MCP capabilities and expose only matching tool schemas for the next model step.",source:"mcp-discovery",
  inputSchema:{type:"object",properties:{query:{type:"string",description:"What capability or action is needed."},limit:{type:"integer",minimum:1,maximum:20}},required:["query"],additionalProperties:false},
  policy:{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,externalSideEffect:false,asyncSafe:true},
  requirements:{desktop:false,workspace:false,project:false,fullAccess:false,deviceAccess:false,delegation:false},rawDefinition:{discovery:true},
});

function safeName(value,{prefix="tool",max=64}={}){
  let text=String(value||"").trim().replace(/[^A-Za-z0-9_-]+/g,"_").replace(/^_+|_+$/g,"");
  if(!text)text=prefix;
  if(!/^[A-Za-z_]/.test(text))text=prefix+"_"+text;
  return text.slice(0,max);
}

function uniqueName(base,used,max=64){
  let candidate=base,index=2;
  while(used.has(candidate)){const suffix="_"+index++;candidate=base.slice(0,Math.max(1,max-suffix.length))+suffix}
  used.add(candidate);return candidate;
}

function boundedText(value,max=MAX_TOOL_TEXT){const text=String(value??"");return text.length>max?text.slice(0,max)+"\n[truncated]":text}
function searchTerms(value){return String(value||"").toLowerCase().split(/[^a-z0-9_+-]+/).filter(Boolean).slice(0,20)}

function toolSearchScore({tool,originalName,serverName},query){
  const terms=searchTerms(query),name=String(originalName||"").toLowerCase(),description=String(tool?.description||tool?.title||"").toLowerCase(),server=String(serverName||"").toLowerCase(),haystack=`${name} ${description} ${server}`;
  if(!terms.length)return 1;
  let score=0;for(const term of terms){if(name===term)score+=100;else if(name.startsWith(term))score+=45;else if(name.includes(term))score+=30;if(description.includes(term))score+=12;if(server.includes(term))score+=8;if(haystack.includes(term))score+=2}
  return score;
}

export function mcpToolPolicy(tool={}){
  const annotations=tool.annotations&&typeof tool.annotations==="object"?tool.annotations:{};
  if(annotations.readOnlyHint===true)return {kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,externalSideEffect:false,asyncSafe:true};
  const destructive=annotations.destructiveHint===true;
  return {
    kind:"other",riskLevel:"high",reversibility:destructive?"none":"partial",
    idempotent:annotations.idempotentHint===true,externalSideEffect:true,asyncSafe:false,
  };
}

export function mcpResultContent(result={}){
  const contentItems=[];
  for(const item of Array.isArray(result.content)?result.content.slice(0,100):[]){
    if(item?.type==="text")contentItems.push({type:"inputText",text:boundedText(item.text)});
    else if(item?.type==="image"&&item.data&&item.mimeType)contentItems.push({type:"inputImage",imageUrl:`data:${item.mimeType};base64,${item.data}`});
    else if(item?.type==="audio"&&item.data&&item.mimeType)contentItems.push({type:"inputText",text:`[MCP audio result · ${item.mimeType} · ${String(item.data).length} base64 chars]`});
    else if(item?.type==="resource")contentItems.push({type:"inputText",text:boundedText(JSON.stringify(item.resource??item))});
    else if(item!=null)contentItems.push({type:"inputText",text:boundedText(JSON.stringify(item))});
  }
  if(result.structuredContent!=null)contentItems.push({type:"inputText",text:boundedText(JSON.stringify({structuredContent:result.structuredContent}))});
  if(!contentItems.length)contentItems.push({type:"inputText",text:result.isError?"MCP tool failed without an error payload.":"MCP tool completed without content."});
  return {success:result.isError!==true,contentItems,...(result.isError===true?{error:contentItems.map(item=>item.text||"").filter(Boolean).join("\n")||"MCP tool failed."}:{})};
}

export class EnvironmentStdioClientTransport{
  constructor({environments,environmentId,command,args=[],cwd=null,environmentNames=[],environment={}}={}){
    if(!environments||!environmentId)throw new Error("Remote MCP stdio transport requires a Trebell environment.");
    this.environments=environments;this.environmentId=environmentId;this.command=command;this.args=[...args];this.cwd=cwd;this.environmentNames=[...environmentNames];this.environment={...environment};this.buffer=new ReadBuffer({maxBufferSize:10*1024*1024});this.process=null;this.closed=false;
  }
  async start(){
    if(this.process)throw new Error("MCP stdio transport is already started.");
    const child=this.environments.spawnArgv(this.environmentId,{command:this.command,args:this.args,cwd:this.cwd,stdio:["pipe","pipe","pipe"],environmentNames:this.environmentNames,environment:this.environment});this.process=child;
    child.stdout?.on("data",chunk=>{try{this.buffer.append(chunk);for(;;){const message=this.buffer.readMessage();if(message==null)break;this.onmessage?.(message)}}catch(error){this.onerror?.(error)}});
    child.stdout?.on("error",error=>this.onerror?.(error));child.stdin?.on("error",error=>this.onerror?.(error));child.stderr?.on("data",chunk=>{this.onstderr?.(String(chunk))});
    child.once("close",()=>{this.process=null;if(!this.closed)this.onclose?.()});
    await new Promise((resolve,reject)=>{const onSpawn=()=>{cleanup();resolve()},onError=error=>{cleanup();reject(error)},cleanup=()=>{child.off("spawn",onSpawn);child.off("error",onError)};child.once("spawn",onSpawn);child.once("error",onError);if(child.pid){cleanup();resolve()}});
  }
  async send(message){
    if(!this.process?.stdin)throw new Error("MCP stdio transport is not connected.");
    const payload=serializeMessage(message);await new Promise((resolve,reject)=>{const stdin=this.process.stdin;const onError=error=>{cleanup();reject(error)},cleanup=()=>stdin.off("error",onError);stdin.once("error",onError);if(stdin.write(payload)){cleanup();resolve()}else stdin.once("drain",()=>{cleanup();resolve()})});
  }
  async close(){
    if(this.closed)return;this.closed=true;const child=this.process;this.process=null;if(!child){this.buffer.clear();this.onclose?.();return}
    try{child.stdin?.end()}catch{}
    const closed=new Promise(resolve=>child.once("close",resolve));await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,1000))]);
    if(child.exitCode==null)try{child.kill("SIGTERM")}catch{}
    await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,1000))]);if(child.exitCode==null)try{child.kill("SIGKILL")}catch{}
    this.buffer.clear();this.onclose?.();
  }
}

function environmentObject(entries=[]){return Object.fromEntries((Array.isArray(entries)?entries:[]).filter(item=>item?.name).map(item=>[String(item.name),String(item.value??"")]))}

function definitionFor(serverEntry,toolEntry){
  return {
    namespace:serverEntry.namespace,name:toolEntry.safeName,description:toolEntry.tool.description||toolEntry.tool.title||toolEntry.originalName,
    inputSchema:toolEntry.tool.inputSchema||{type:"object",properties:{}},source:"mcp",policy:mcpToolPolicy(toolEntry.tool),
    requirements:{desktop:false,workspace:false,project:false,fullAccess:false,deviceAccess:false,delegation:false},
    rawDefinition:{serverId:serverEntry.server.id,serverName:serverEntry.server.name,toolName:toolEntry.originalName,annotations:toolEntry.tool.annotations||null},
  };
}

export class NativeMcpBroker{
  constructor({servers=[],cwd=null,environments=null,environmentId=null,localEnvironment={},remoteEnvironmentNames=[],version="0.0.0",onElicitation=null,onEvent=null,onToolsDiscovered=null}={}){
    this.servers=(Array.isArray(servers)?servers:[]).slice(0,50);this.cwd=cwd;this.environments=environments;this.environmentId=environmentId;this.localEnvironment={...localEnvironment};this.remoteEnvironmentNames=[...remoteEnvironmentNames];this.version=version;this.onElicitation=onElicitation;this.onEvent=onEvent;this.onToolsDiscovered=onToolsDiscovered;this.entries=[];this.definitions=new Map();this.started=false;
  }
  event(name,status,data={}){try{this.onEvent?.({name,status,data,at:Date.now()})}catch{}}
  async connect(){
    if(this.started)return this.namespaces();this.started=true;const namespaceNames=new Set();let remaining=MAX_TOTAL_TOOLS;
    for(const server of this.servers){
      if(remaining<=0)break;
      const namespace=uniqueName(safeName("mcp_"+(server.id||server.name),{prefix:"mcp",max:60}),namespaceNames,60),entry={server,namespace,client:null,transport:null,tools:[],error:null};this.entries.push(entry);
      try{
        const explicit=environmentObject(server.env),profile=this.environmentId&&this.environments?this.environments.get(this.environmentId):null;
        const transport=profile&&profile.type!=="local"
          ?new EnvironmentStdioClientTransport({environments:this.environments,environmentId:this.environmentId,command:server.command,args:server.args||[],cwd:this.cwd,environmentNames:this.remoteEnvironmentNames,environment:explicit})
          :new StdioClientTransport({command:server.command,args:server.args||[],cwd:this.cwd||undefined,env:{...this.localEnvironment,...explicit},stderr:"pipe"});
        const client=new Client({name:"trebell-native",version:this.version},{capabilities:{elicitation:{form:{},url:{}}}});entry.transport=transport;entry.client=client;
        client.setRequestHandler(ElicitRequestSchema,async request=>{
          if(typeof this.onElicitation!=="function")return {action:"cancel"};
          const response=await this.onElicitation({server:{id:server.id,name:server.name},params:request.params});
          const action=["accept","decline","cancel"].includes(String(response?.action))?String(response.action):"cancel";
          return {action,...(action==="accept"&&response?.content&&typeof response.content==="object"?{content:response.content}:{})};
        });
        transport.onstderr=text=>this.event("native.mcp.stderr","info",{serverId:server.id,message:boundedText(text,2000)});
        await client.connect(transport);this.event("native.mcp.connected","completed",{serverId:server.id,serverName:server.name});
        const usedToolNames=new Set();let cursor=null,count=0;
        do{
          const page=await client.listTools(cursor?{cursor}:undefined),tools=Array.isArray(page.tools)?page.tools:[];
          for(const tool of tools){
            if(count>=MAX_TOOLS_PER_SERVER||remaining<=0)break;
            const originalName=String(tool?.name||"").trim();if(!originalName)continue;
            const safe=uniqueName(safeName(originalName,{prefix:"tool",max:64}),usedToolNames,64),toolEntry={tool,originalName,safeName:safe};entry.tools.push(toolEntry);this.definitions.set(namespace+"\0"+safe,definitionFor(entry,toolEntry));count++;remaining--;
          }
          cursor=count<MAX_TOOLS_PER_SERVER&&remaining>0?page.nextCursor||null:null;
        }while(cursor);
        this.event("native.mcp.discovered","completed",{serverId:server.id,toolCount:entry.tools.length,truncated:count>=MAX_TOOLS_PER_SERVER||remaining<=0});
      }catch(error){entry.error=error?.message||String(error);this.event("native.mcp.connection_failed","error",{serverId:server.id,serverName:server.name,message:boundedText(entry.error,1000)});try{await entry.client?.close()}catch{}}
    }
    return this.namespaces();
  }
  namespaces(){
    return this.entries.filter(entry=>entry.client&&entry.tools.length).map(entry=>({
      type:"namespace",name:entry.namespace,description:`MCP server: ${entry.server.name}`,
      tools:entry.tools.map(item=>({type:"function",name:item.safeName,description:item.tool.description||item.tool.title||item.originalName,inputSchema:item.tool.inputSchema||{type:"object",properties:{}}})),
    }));
  }
  discoveryNamespace(){
    if(!this.definitions.size)return null;
    return {type:"namespace",name:DISCOVERY_NAMESPACE,description:"Discover configured MCP capabilities on demand instead of loading every MCP schema into each model request.",tools:[{type:"function",name:DISCOVERY_TOOL,description:DISCOVERY_DEFINITION.description,inputSchema:DISCOVERY_DEFINITION.inputSchema}]};
  }
  discover({query="",limit=8}={}){
    const max=Math.max(1,Math.min(20,Math.trunc(Number(limit)||8))),matches=[];
    for(const entry of this.entries){
      if(!entry.client)continue;
      for(const toolEntry of entry.tools){
        const score=toolSearchScore({tool:toolEntry.tool,originalName:toolEntry.originalName,serverName:entry.server.name},query);if(score<=0)continue;
        matches.push({score,entry,toolEntry});
      }
    }
    matches.sort((a,b)=>b.score-a.score||String(a.entry.server.name).localeCompare(String(b.entry.server.name))||String(a.toolEntry.originalName).localeCompare(String(b.toolEntry.originalName)));
    const selected=matches.slice(0,max),grouped=new Map();
    for(const match of selected){const list=grouped.get(match.entry.namespace)||[];list.push(match.toolEntry);grouped.set(match.entry.namespace,list)}
    const namespaces=[];
    for(const [namespace,tools] of grouped){const entry=selected.find(item=>item.entry.namespace===namespace)?.entry;if(!entry)continue;namespaces.push({type:"namespace",name:namespace,description:`MCP server: ${entry.server.name}`,tools:tools.map(item=>({type:"function",name:item.safeName,description:item.tool.description||item.tool.title||item.originalName,inputSchema:item.tool.inputSchema||{type:"object",properties:{}}}))})}
    const publicMatches=selected.map(({entry,toolEntry})=>({namespace:entry.namespace,name:toolEntry.safeName,originalName:toolEntry.originalName,server:entry.server.name,description:String(toolEntry.tool.description||toolEntry.tool.title||"").slice(0,500)}));
    return {query:String(query||""),matches:publicMatches,namespaces};
  }
  toolDefinition(namespace,name){
    if(String(namespace||"")===DISCOVERY_NAMESPACE&&String(name||"")===DISCOVERY_TOOL&&this.definitions.size)return DISCOVERY_DEFINITION;
    return this.definitions.get(String(namespace||"")+"\0"+String(name||""))||null;
  }
  hasTool(namespace,name){return Boolean(this.toolDefinition(namespace,name))}
  async call({namespace,name,arguments:args={},signal=null}={}){
    if(String(namespace||"")===DISCOVERY_NAMESPACE&&String(name||"")===DISCOVERY_TOOL){
      const result=this.discover(args||{});try{this.onToolsDiscovered?.(result.namespaces)}catch{}
      this.event("native.mcp.progressive_discovery","completed",{query:String(args?.query||"").slice(0,500),matchCount:result.matches.length,namespaces:result.namespaces.map(item=>item.name)});
      return {success:true,contentItems:[{type:"inputText",text:JSON.stringify({query:result.query,tools:result.matches,note:result.matches.length?"Matching MCP tool schemas are now available for the next model step.":"No configured MCP tools matched this query."})}]};
    }
    const definition=this.toolDefinition(namespace,name);if(!definition)throw new Error(`Unknown Native MCP tool: ${namespace}/${name}`);
    const entry=this.entries.find(item=>item.server.id===definition.rawDefinition.serverId&&item.namespace===namespace);if(!entry?.client)throw new Error("Native MCP server is not connected.");
    this.event("native.mcp.tool_started","running",{serverId:entry.server.id,namespace,name,toolName:definition.rawDefinition.toolName});
    const result=await entry.client.callTool({name:definition.rawDefinition.toolName,arguments:args},undefined,signal?{signal}:undefined),normalized=mcpResultContent(result);
    this.event("native.mcp.tool_completed",normalized.success?"completed":"failed",{serverId:entry.server.id,namespace,name,toolName:definition.rawDefinition.toolName,success:normalized.success});return normalized;
  }
  failures(){return this.entries.filter(entry=>entry.error).map(entry=>({serverId:entry.server.id,serverName:entry.server.name,error:entry.error}))}
  async close(){for(const entry of this.entries){try{await entry.client?.close()}catch{}try{await entry.transport?.close()}catch{}}this.entries=[];this.definitions.clear();this.started=false}
}
