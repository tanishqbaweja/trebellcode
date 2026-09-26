import { createServer as createNetServer } from "node:net";
import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createOpencodeClient as createOpencodeV2Client } from "@opencode-ai/sdk/v2";
import spawn from "cross-spawn";
import { normalizePermissionKind, permissionDisposition } from "./permission-policy.mjs";

const MIME={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".pdf":"application/pdf",".mp3":"audio/mpeg",".wav":"audio/wav",".m4a":"audio/mp4",".md":"text/markdown",".json":"application/json",".txt":"text/plain"};

function unwrap(result,label="OpenCode request"){
  if(result?.error)throw new Error(result.error?.data?.message||result.error?.message||`${label} failed`);
  return result?.data;
}

async function freePort(){
  const server=createNetServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

async function startServer({command="opencode",cwd,env=process.env,serverUrl=null}={}){
  if(serverUrl)return {url:serverUrl,close(){}};
  const port=await freePort();const args=["serve","--hostname=127.0.0.1",`--port=${port}`];
  const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let output="";
  const url=await new Promise((resolve,reject)=>{
    let settled=false;const timer=setTimeout(()=>finish(new Error(`OpenCode server did not start. ${output.slice(-2000)}`)),15_000);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
    child.stdout?.on("data",chunk=>{output+=String(chunk);for(const line of output.split(/\r?\n/)){const match=line.match(/opencode server listening.*on\s+(https?:\/\/[^\s]+)/i);if(match)return finish(null,match[1])}});
    child.stderr?.on("data",chunk=>{output+=String(chunk)});child.once("error",error=>finish(error));child.once("exit",code=>finish(new Error(`OpenCode server exited with code ${code}. ${output.slice(-2000)}`)));
  });
  return {url,child,close(){
    if(child.exitCode!==null)return;
    if(process.platform==="win32"&&child.pid){
      try{execFileSync("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});return}catch{}
    }
    try{child.kill()}catch{}
  }};
}

function toProviderModel(value,map){
  if(map.has(value))return map.get(value);
  const raw=String(value||"");const index=raw.indexOf("/");if(index>0)return {providerID:raw.slice(0,index),modelID:raw.slice(index+1)};
  return null;
}

function permissionResponse(decision){return decision==="acceptForSession"?"always":decision==="accept"?"once":"reject"}

export async function configureOpenCodeMcpServers(client,{cwd,servers=[]}={}){
  if(!client?.mcp?.add)return [];
  const results=[];
  for(const server of Array.isArray(servers)?servers:[]){
    if(!server?.name||!server?.config)continue;
    try{
      const response=unwrap(await client.mcp.add({query:{directory:cwd},body:{name:String(server.name),config:server.config}}),`MCP ${server.name}`),status=response?.[server.name]||null;
      results.push({name:String(server.name),configured:true,status});
    }catch(error){results.push({name:String(server.name),configured:false,error:String(error?.message||error).slice(0,2000)})}
  }
  return results;
}

export function openCodePermissionDisposition(mode,type){
  return permissionDisposition(mode,normalizePermissionKind(type),{readOnlyAllowsRead:false});
}

function toolTitle(tool,stateTitle){
  const id=String(tool||"").toLowerCase();
  if(id==="read")return "Read file";
  if(id==="write")return "Write file";
  if(id==="edit"||id==="patch")return "Edit files";
  if(id==="bash"||id==="shell")return stateTitle&&stateTitle.length<120?stateTitle:"Run command";
  if(id==="grep"||id==="search")return "Search workspace";
  if(id==="glob")return "Find files";
  if(id==="webfetch"||id==="fetch")return "Fetch URL";
  return stateTitle&&stateTitle.length<120?stateTitle:String(tool||"Tool");
}

export class OpenCodeAgentSession{
  constructor({command="opencode",cwd,env=process.env,serverUrl=null,permissionMode="supervised",onUpdate,onPermission,repositoryMcp=null}={}){
    this.command=command;this.cwd=cwd;this.env=env;this.serverUrl=serverUrl;this.permissionMode=permissionMode;this.onUpdate=onUpdate;this.onPermission=onPermission;
    this.server=null;this.client=null;this.v2Client=null;this.sessionId=null;this.sessionSetup=null;this.initializeResult={agentCapabilities:{loadSession:true,sessionCapabilities:{fork:{},resume:{},close:{}}},agentInfo:{name:"OpenCode"}};
    this.model=null;this.modelMap=new Map();this.contextByModel=new Map();this.partText=new Map();this.closed=false;this.eventAbort=new AbortController();this.eventTask=null;
    this.messageRoles=new Map();this.repositoryMcp=repositoryMcp;this.repositoryMcpStatus=[];
  }
  async start({providerSessionId=null,model=null}={}){
    this.server=await startServer({command:this.command,cwd:this.cwd,env:this.env,serverUrl:this.serverUrl});
    this.client=createOpencodeClient({baseUrl:this.server.url,directory:this.cwd});
    this.v2Client=createOpencodeV2Client({baseUrl:this.server.url,directory:this.cwd});
    if(this.repositoryMcp)this.repositoryMcpStatus=await configureOpenCodeMcpServers(this.client,{cwd:this.cwd,servers:[{name:this.repositoryMcp.name,config:this.repositoryMcp.openCode}]});
    const providers=unwrap(await this.client.provider.list({query:{directory:this.cwd}}),"provider list")||{};
    for(const provider of providers.all||[]){for(const entry of Object.values(provider.models||{})){const id=`${provider.id}/${entry.id}`;this.modelMap.set(id,{providerID:provider.id,modelID:entry.id});if(entry.limit?.context)this.contextByModel.set(id,Number(entry.limit.context))}}
    this.model=model&&toProviderModel(model,this.modelMap)?model:(providers.default?Object.entries(providers.default).map(([providerID,modelID])=>`${providerID}/${modelID}`)[0]:this.modelMap.keys().next().value||null);
    let info=null;
    if(providerSessionId)info=unwrap(await this.client.session.get({path:{id:providerSessionId},query:{directory:this.cwd}}),"session get");
    if(!info)info=unwrap(await this.client.session.create({query:{directory:this.cwd},body:{title:"Trebell task"}}),"session create");
    this.sessionId=info.id;
    const availableModels=[...this.modelMap.keys()];if(this.model&&!availableModels.includes(this.model))availableModels.push(this.model);
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:availableModels.map(modelId=>({modelId,name:modelId}))},configOptions:[],modes:{currentModeId:"build",availableModes:[]},trebellRepositoryMcp:this.repositoryMcpStatus[0]||null};
    const [commands,skills,agents]=await Promise.all([
      this.client.command.list({directory:this.cwd}).then(result=>unwrap(result,"command list")||[]).catch(()=>[]),
      this.v2Client.app.skills({directory:this.cwd}).then(result=>unwrap(result,"skill list")||[]).catch(()=>[]),
      this.client.app.agents({directory:this.cwd}).then(result=>unwrap(result,"agent list")||[]).catch(()=>[]),
    ]);
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"session_info_update",commands,skills,agents:agents.filter(agent=>!agent.hidden),status:{type:"idle"}}});
    this.#startEvents();return {initialize:this.initializeResult,session:this.sessionSetup};
  }
  async prompt(parts,{messageId=null,agent=null}={}){
    const bodyParts=parts.map(part=>{
      if(part.type==="text")return {type:"text",text:String(part.text||"")};
      if(part.type==="image")return {type:"file",mime:part.mimeType||"image/png",url:`data:${part.mimeType||"image/png"};base64,${part.data}`};
      if(part.type==="resource_link"){
        const path=String(part.uri||"").replace(/^file:\/\//,"");return {type:"file",mime:MIME[extname(path).toLowerCase()]||"text/plain",filename:part.name||undefined,url:part.uri};
      }
      return {type:"text",text:JSON.stringify(part)};
    });
    const selected=toProviderModel(this.model,this.modelMap);
    const result=unwrap(await this.client.session.prompt({path:{id:this.sessionId},query:{directory:this.cwd},body:{...(messageId?{messageID:messageId}:{}),...(selected?{model:selected}:{}),...(agent?{agent}:{}),parts:bodyParts}}),"session prompt");
    const info=result?.info||{};
    if(info.error)throw new Error(info.error?.data?.message||info.error?.name||"OpenCode model request failed");
    if(info.id)this.messageRoles.set(info.id,"assistant");
    if(info.parentID)this.messageRoles.set(info.parentID,"user");
    const responseTextParts=(result?.parts||[]).filter(part=>part.type==="text");
    const full=responseTextParts.map(part=>part.text||"").join("");
    const emitted=responseTextParts.map(part=>this.partText.get(part.id)||"").join("");
    if(full&&full!==emitted){const suffix=full.startsWith(emitted)?full.slice(emitted.length):full;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:suffix}}})}
    const tokens=info.tokens||{};if(tokens.input!=null){const modelId=`${info.providerID||selected?.providerID||""}/${info.modelID||selected?.modelID||""}`;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used:Number(tokens.input||0)+Number(tokens.output||0)+Number(tokens.reasoning||0),size:this.contextByModel.get(modelId)||0,cost:info.cost!=null?{amount:info.cost,currency:"USD"}:null,usage:{input_tokens:Number(tokens.input||0),output_tokens:Number(tokens.output||0),reasoning_tokens:Number(tokens.reasoning||0),cache_read_input_tokens:Number(tokens.cache?.read||0),cache_write_input_tokens:Number(tokens.cache?.write||0)}}})}
    return {stopReason:"end_turn",providerMessageId:info.parentID||null,assistantMessageId:info.id||null,raw:result};
  }
  async setModel(model){if(toProviderModel(model,this.modelMap))this.model=model;return {modelId:this.model}}
  async cancel(){if(this.client&&this.sessionId)await this.client.session.abort({path:{id:this.sessionId},query:{directory:this.cwd}}).catch(()=>{})}
  async fork(){return unwrap(await this.client.session.fork({path:{id:this.sessionId},query:{directory:this.cwd},body:{}}),"session fork")}
  async revert(messageID){return unwrap(await this.client.session.revert({path:{id:this.sessionId},query:{directory:this.cwd},body:{messageID}}),"session revert")}
  async compact(){const selected=toProviderModel(this.model,this.modelMap);if(!selected)throw new Error("Select a model before compacting");return unwrap(await this.client.session.summarize({path:{id:this.sessionId},query:{directory:this.cwd},body:{providerID:selected.providerID,modelID:selected.modelID}}),"session summarize")}
  async close(){
    if(this.closed)return;
    this.closed=true;
    this.eventAbort.abort();
    if(this.client&&this.sessionId)await this.client.session.abort({path:{id:this.sessionId},query:{directory:this.cwd}}).catch(()=>{});
    await this.client?.instance?.dispose?.({query:{directory:this.cwd}}).catch(()=>{});
    this.server?.close?.();
    await Promise.race([this.eventTask||Promise.resolve(),new Promise(resolve=>setTimeout(resolve,1000))]).catch(()=>{});
  }

  #startEvents(){
    this.eventTask=(async()=>{
      try{
        const result=await this.client.event.subscribe({query:{directory:this.cwd},signal:this.eventAbort.signal});
        for await(const event of result.stream){if(this.closed)break;await this.#event(event)}
      }catch(error){if(!this.closed)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:error?.message||String(error)}})}
    })();
  }
  async #event(event){
    const p=event?.properties||{};
    if(p.sessionID&&p.sessionID!==this.sessionId&&p.info?.sessionID!==this.sessionId)return;
    if(event.type==="message.updated"){
      if(p.info?.sessionID===this.sessionId&&p.info?.id&&p.info?.role)this.messageRoles.set(p.info.id,p.info.role);
      return;
    }
    if(event.type==="message.part.updated"){
      const part=p.part;if(!part||part.sessionID!==this.sessionId)return;
      let role=this.messageRoles.get(part.messageID);
      if(!role){
        try{
          const message=unwrap(await this.client.session.message({path:{id:this.sessionId,messageID:part.messageID},query:{directory:this.cwd}}),"session message");
          role=message?.info?.role||null;if(role)this.messageRoles.set(part.messageID,role);
        }catch{}
      }
      if(role!=="assistant")return;
      if(part.type==="text"){
        const previous=this.partText.get(part.id)||"";const delta=typeof p.delta==="string"?p.delta:part.text?.startsWith(previous)?part.text.slice(previous.length):part.text||"";this.partText.set(part.id,part.text||previous+delta);
        if(delta)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:delta}}});
      }else if(part.type==="reasoning")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:""}}});
      else if(part.type==="tool"){
        const status=part.state?.status==="running"?"in_progress":part.state?.status==="completed"?"completed":part.state?.status==="error"?"failed":"pending";
        const update={sessionUpdate:part.state?.status==="pending"?"tool_call":"tool_call_update",toolCallId:part.callID||part.id,title:toolTitle(part.tool,part.state?.title),kind:part.tool==="bash"||part.tool==="shell"?"execute":part.tool==="edit"||part.tool==="write"?"edit":part.tool==="read"?"read":"other",status,rawInput:part.state?.input||{},rawOutput:part.state?.output||part.state?.error||null};
        this.onUpdate?.({sessionId:this.sessionId,update});
      }else if(part.type==="subtask")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call",toolCallId:part.id,title:part.description||`Subtask · ${part.agent}`,kind:"other",status:"in_progress",rawInput:{prompt:part.prompt,agent:part.agent}}});
      else if(part.type==="step-finish")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used:Number(part.tokens?.input||0)+Number(part.tokens?.output||0)+Number(part.tokens?.reasoning||0),size:this.contextByModel.get(this.model)||0,cost:{amount:Number(part.cost||0),currency:"USD"},usage:{input_tokens:Number(part.tokens?.input||0),output_tokens:Number(part.tokens?.output||0),reasoning_tokens:Number(part.tokens?.reasoning||0),cache_read_input_tokens:Number(part.tokens?.cache?.read||0),cache_write_input_tokens:Number(part.tokens?.cache?.write||0)}}});
    }else if(event.type==="todo.updated")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"plan",entries:(p.todos||[]).map(todo=>({content:todo.content,status:todo.status,priority:todo.priority}))}});
    else if(event.type==="permission.updated"&&p.sessionID===this.sessionId){
      const options=[{optionId:"once",name:"Allow once",kind:"allow_once"},{optionId:"always",name:"Always allow",kind:"allow_always"},{optionId:"reject",name:"Reject",kind:"reject_once"}];
      const disposition=openCodePermissionDisposition(this.permissionMode,p.type);let decision="decline";
      if(disposition==="allow")decision=this.permissionMode==="full"||this.permissionMode==="auto"?"acceptForSession":"accept";
      else if(disposition==="ask"&&this.onPermission)decision=(await this.onPermission({method:"permission",params:{toolCall:{title:p.title,toolCallId:p.callID||p.id,rawInput:p.metadata,kind:normalizePermissionKind(p.type)},permissionType:p.type,options}}))||"decline";
      await this.client.postSessionIdPermissionsPermissionId({path:{id:this.sessionId,permissionID:p.id},query:{directory:this.cwd},body:{response:permissionResponse(decision)}}).catch(()=>{});
    }else if(event.type==="session.error"&&(!p.sessionID||p.sessionID===this.sessionId))this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:p.error?.data?.message||p.error?.name||"OpenCode session error"}});
    else if(event.type==="session.diff"&&p.sessionID===this.sessionId)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"diff",diff:p.diff||[]}});
    else if(event.type==="session.status"&&p.sessionID===this.sessionId)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"session_info_update",status:p.status}});
  }
}
