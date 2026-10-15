import { OpenCode } from "@opencode/client";
import { randomUUID } from "node:crypto";
import { OpenCodeAgentSession, inferOpenCodeDefaultVariant, openCode2ModelId, openCodePermissionDisposition, openCodePermissionRules, openCodePrimaryAgents, openCodeRefusal, startOpenCode2Server, waitForOpenCode2Models } from "./opencode-agent-session.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { normalizePermissionKind, normalizePermissionMode } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";

const STOPPED=Symbol("opencode2-stopped");

function authHeader(password=""){
  return "Basic "+Buffer.from("opencode:"+String(password),"utf8").toString("base64");
}
function clientFor(server){
  return OpenCode.make({baseUrl:server.url,headers:{Authorization:authHeader(server.password)}});
}
function modelKey(model){return openCode2ModelId(model)}
function modelRef(id,variant=null){
  const raw=String(id||""),slash=raw.indexOf("/");if(slash<=0)return null;
  return {providerID:raw.slice(0,slash),id:raw.slice(slash+1),...(variant?{variant}:{})};
}
function variantsOf(model){
  return (Array.isArray(model?.variants)?model.variants:[]).map(item=>String(item?.id||"").trim()).filter(Boolean);
}
function v2Action(permission){const value=String(permission||"*");return value==="bash"?"shell":value==="task"?"subagent":value}
function v2Rules(mode,{repositoryMcp=null,grants=[]}={}){
  const rules=openCodePermissionRules(mode,{allowedTools:repositoryMcp?.name?[`${repositoryMcp.name}_*`]:[]});
  return [...rules.map(rule=>({action:v2Action(rule.permission),resource:String(rule.pattern||"*"),effect:rule.action==="allow"?"allow":rule.action==="deny"?"deny":"ask"})),...(Array.isArray(grants)?grants:[])];
}
function promptParts(parts=[]){
  const text=[],files=[];
  for(const part of Array.isArray(parts)?parts:[]){
    if(part?.type==="text")text.push(String(part.text||""));
    else if(part?.type==="resource_link"&&part.uri)files.push({data:"",mime:String(part.mimeType||"application/octet-stream"),source:{type:"uri",uri:String(part.uri)},...(part.name?{name:String(part.name)}:{})});
    else if(part?.type==="image"&&part.data)files.push({data:String(part.data),mime:String(part.mimeType||"image/png"),source:{type:"inline"}});
  }
  return {text:text.join("\n"),files};
}
function errorText(error){
  if(!error)return "OpenCode request failed";
  return String(error?.message||error?.data?.message||error?._tag||error).slice(0,2000);
}
function permissionDecision(value){return value==="accept"||value==="acceptForSession"?"once":"reject"}
function permissionTitle(data){
  const action=String(data?.action||"tool"),resources=(Array.isArray(data?.resources)?data.resources:[]).map(String).filter(Boolean);
  return data?.message||(`OpenCode · ${action}`+(resources.length?` · ${resources.slice(0,2).join(", ")}`:""));
}
function outputText(content){
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return "";
  return content.map(item=>typeof item==="string"?item:typeof item?.text==="string"?item.text:"").join("");
}

export class OpenCode2AgentSession extends OpenCodeAgentSession{
  constructor(options={}){
    super(options);
    this.version=String(options.version||"");
    this.appliedSelection=null;
    this.sessionRules=[];
    this.messageText=new Map();
    this.reasoningText=new Map();
    this.toolNames=new Map();
    this.sessionParents=new Map();
    this.sessionGrants=[];
    this.agentIds=new Map();
  }

  async start({providerSessionId=null,model=null}={}){
    this.server=await startOpenCode2Server({command:this.command,cwd:this.cwd,env:this.env,serverUrl:this.serverUrl});
    if(this.closed){this.server.close?.();throw new Error("OpenCode was stopped while it started.")}
    this.server.child?.once?.("exit",(code,signal)=>{this.serverExit={code,signal}});
    this.client=clientFor(this.server);
    await this.client.server.info();
    const location={directory:this.cwd};
    if(this.repositoryMcp){
      const config=this.repositoryMcp.openCode||{};
      try{
        await this.client.mcp.add({server:String(this.repositoryMcp.name),location,config:{
          type:"local",command:Array.isArray(config.command)?config.command.map(String):[String(this.repositoryMcp.command),...(this.repositoryMcp.args||[])],
          ...(config.environment?{environment:Object.fromEntries(Object.entries(config.environment).map(([key,value])=>[key,String(value)]))}:{}),
          disabled:config.enabled===false,
          ...(Number(config.timeout)>0?{timeout:{startup:Number(config.timeout)}}:{}),
        }});
        this.repositoryMcpStatus=[{name:String(this.repositoryMcp.name),configured:true,status:"connected"}];
      }catch(error){this.repositoryMcpStatus=[{name:String(this.repositoryMcp.name),configured:false,error:errorText(error)}]}
    }
    const [modelResult,defaultResult,commands,skills,agents]=await Promise.all([
      waitForOpenCode2Models(this.client,location,{requiredModel:model}),
      this.client.model.default({location}).catch(()=>({data:null})),
      this.client.command.list({location}).then(result=>result?.data||[]).catch(()=>[]),
      this.client.skill.list({location}).then(result=>result?.data||[]).catch(()=>[]),
      this.client.agent.list({location}).then(result=>result?.data||[]).catch(()=>[]),
    ]);
    for(const entry of Array.isArray(modelResult?.data)?modelResult.data:[]){
      if(entry?.enabled===false)continue;
      const id=modelKey(entry);if(!id)continue;
      const variants=variantsOf(entry);
      this.modelMap.set(id,modelRef(id));
      this.modelNames.set(id,String(entry.name||id));this.modelVariants.set(id,variants);
      if(Number(entry.limit?.context)>0)this.contextByModel.set(id,Number(entry.limit.context));
    }
    for(const entry of Array.isArray(agents)?agents:[]){const id=String(entry?.id||"").trim(),name=String(entry?.name||"").trim();if(id){this.agentIds.set(id,id);if(name)this.agentIds.set(name,id)}}
    const requestedId=String(model||"").trim(),requested=this.modelMap.has(requestedId)?requestedId:null;
    if(requestedId&&!requested)throw new Error(`Model unavailable: ${requestedId}`);
    const defaultId=modelKey(defaultResult?.data);
    this.model=requested||(this.modelMap.has(defaultId)?defaultId:[...this.modelMap.keys()][0]||null);
    let info=null;
    if(providerSessionId){
      try{info=await this.client.session.get({sessionID:String(providerSessionId)})}
      catch(error){
        if(error?._tag==="SessionNotFoundError"||/not found/i.test(errorText(error)))throw new HarnessSessionLostError(`OpenCode could not resume this conversation: ${errorText(error)}`,{harness:"opencode",sessionId:providerSessionId});
        throw error;
      }
    }
    this.sessionRules=v2Rules(this.permissionMode,{repositoryMcp:this.repositoryMcp,grants:this.sessionGrants});
    if(!info)info=await this.client.session.create({location,permissions:this.sessionRules});
    this.sessionId=String(info.id);
    if(providerSessionId)await this.#applyPermissionRules();
    try{await this.client.session.instructions.entry.put({sessionID:this.sessionId,key:"trebell.runtime",value:runtimeInstructions({harness:"OpenCode",model:this.model})})}catch{}
    const availableModels=[...this.modelMap.keys()];
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:availableModels.map(modelId=>({modelId,name:this.modelNames.get(modelId)||modelId}))},configOptions:[],modes:{currentModeId:String(info.agent||"build"),availableModes:[]},trebellRepositoryMcp:this.repositoryMcpStatus[0]||null};
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"session_info_update",commands:Array.isArray(commands)?commands:[],skills:Array.isArray(skills)?skills:[],agents:openCodePrimaryAgents((Array.isArray(agents)?agents:[]).map(agent=>({...agent,name:agent?.name||agent?.id}))),status:{type:"idle"}}});
    this.#startEvents();
    return {initialize:this.initializeResult,session:this.sessionSetup};
  }

  #selection(){
    const selected=modelRef(this.model);if(!selected)return null;
    const variants=this.modelVariants.get(this.model)||[],variant=this.variant&&variants.includes(this.variant)?this.variant:null;
    return {...selected,...(variant?{variant}:{})};
  }
  async #applySelection(){
    const selected=this.#selection();if(!selected||!this.client||!this.sessionId)return;
    const fingerprint=JSON.stringify(selected);if(fingerprint===this.appliedSelection)return;
    await this.client.session.switchModel({sessionID:this.sessionId,model:selected});
    this.appliedSelection=fingerprint;
  }
  async #applyPermissionRules(){
    if(!this.client||!this.sessionId)return;
    this.sessionRules=v2Rules(this.permissionMode,{repositoryMcp:this.repositoryMcp,grants:this.sessionGrants});
    await this.client.session.update({sessionID:this.sessionId,permissions:this.sessionRules});
  }
  async setPermissionMode(mode){
    this.permissionMode=normalizePermissionMode(mode||"supervised");
    if(this.client&&this.sessionId)await this.#applyPermissionRules();
    return this.permissionMode;
  }
  setReasoningEffort(value){this.variant=typeof value==="string"&&value.trim()?value.trim():null;this.appliedSelection=null;return this.variant}
  async setModel(model){if(this.modelMap.has(String(model||""))){this.model=String(model);this.appliedSelection=null}return {modelId:this.model}}

  async prompt(parts,{agent=null,onDelivered=null}={}){
    if(!this.client||!this.sessionId)throw new Error("OpenCode session is not started.");
    if(this.activePrompt)throw new Error("OpenCode already has a running turn.");
    await this.#applySelection();await this.#applyPermissionRules();
    if(agent){const agentId=this.agentIds.get(String(agent))||String(agent);await this.client.session.switchAgent({sessionID:this.sessionId,agent:agentId})}
    try{await this.client.session.instructions.entry.put({sessionID:this.sessionId,key:"trebell.runtime",value:runtimeInstructions({harness:"OpenCode",model:this.model})})}catch{}
    let settleTurn=()=>{};const completion=new Promise(resolve=>{settleTurn=resolve});
    const input=promptParts(parts),turn={done:false,cancelled:false,error:null,text:"",assistantMessageId:null,startedAt:Date.now(),completion,settle:settleTurn};
    this.activePrompt=turn;
    try{
      const accepted=await this.client.session.prompt({sessionID:this.sessionId,text:input.text,...(input.files.length?{files:input.files}:{})});
      if(typeof onDelivered==="function")try{onDelivered()}catch{}
      await turn.completion;
      if(turn.cancelled)return {stopReason:"cancelled",providerMessageId:null,assistantMessageId:turn.assistantMessageId,raw:accepted};
      if(turn.error)throw new Error(turn.error);
      const messages=await this.client.message.list({sessionID:this.sessionId,order:"desc",limit:20}).catch(()=>({data:[]}));
      const list=Array.isArray(messages?.data)?messages.data:[];
      const user=list.find(item=>item?.type==="user"),assistant=list.find(item=>item?.type==="assistant");
      if(assistant?.id)turn.assistantMessageId=assistant.id;
      if(assistant?.error)throw new Error(errorText(assistant.error));
      if(assistant?.finish==="error")throw new Error("OpenCode reported that the model turn failed.");
      const full=assistant?.type==="assistant"?(assistant.content||[]).filter(item=>item?.type==="text").map(item=>item.text||"").join(""):"";
      if(full&&full!==turn.text){const suffix=full.startsWith(turn.text)?full.slice(turn.text.length):full;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:suffix}}});turn.text=full}
      return {stopReason:"end_turn",providerMessageId:user?.id||accepted?.id||null,assistantMessageId:turn.assistantMessageId,raw:assistant||accepted};
    }finally{turn.done=true;turn.settle?.();if(this.activePrompt===turn)this.activePrompt=null}
  }

  async steer(parts){
    if(!this.client||!this.sessionId||!this.activePrompt)throw new Error("OpenCode has no running turn to steer.");
    const input=promptParts(parts);const accepted=await this.client.session.prompt({sessionID:this.sessionId,text:input.text,...(input.files.length?{files:input.files}:{}),delivery:"steer"});
    return {accepted:true,pending:0,providerMessageId:accepted?.id||null};
  }
  async cancel(){
    const turn=this.activePrompt;if(turn)turn.cancelled=true;
    if(this.client&&this.sessionId)await this.client.session.interrupt({sessionID:this.sessionId}).catch(()=>{});
    turn?.settle?.();
  }
  async compact(){
    if(!this.client||!this.sessionId)throw new Error("OpenCode session is not started.");
    return await this.client.session.compact({sessionID:this.sessionId});
  }
  async fork(){
    if(this.activePrompt)throw new Error("Stop the running OpenCode turn before forking this thread.");
    const before=await this.client.message.list({sessionID:this.sessionId,order:"asc",limit:1000});
    const forked=await this.client.session.fork({sessionID:this.sessionId});
    const after=await this.client.message.list({sessionID:forked.id,order:"asc",limit:1000});
    const source=Array.isArray(before?.data)?before.data:[],copies=Array.isArray(after?.data)?after.data:[];
    return {...forked,sessionId:forked.id,messageIds:source.map((item,index)=>[String(item?.id||""),String(copies[index]?.id||"")]).filter(([a,b])=>a&&b),tailId:null};
  }
  async rewind(messageID){
    if(this.activePrompt)throw new Error("Stop the running OpenCode turn before rewinding this thread.");
    const boundary=String(messageID||"");if(!boundary)throw Object.assign(new Error("OpenCode could not rewind to this turn."),{code:"OPENCODE_REWIND_TARGET_MISSING"});
    const forked=await this.client.session.fork({sessionID:this.sessionId,boundary:{type:"before",messageID:boundary}});
    this.sessionId=String(forked.id);if(this.sessionSetup)this.sessionSetup.sessionId=this.sessionId;
    await this.#applyPermissionRules();this.appliedSelection=null;await this.#applySelection();
    return {sessionId:this.sessionId,messageIds:[],tailId:null};
  }
  async close(){
    if(this.closed)return;this.closed=true;
    if(this.activePrompt){this.activePrompt.cancelled=true;this.activePrompt.settle?.()}
    this.eventAbort.abort();
    if(this.client&&this.sessionId)await this.client.session.interrupt({sessionID:this.sessionId}).catch(()=>{});
    this.server?.close?.();
    await Promise.race([this.eventTask||Promise.resolve(),new Promise(resolve=>setTimeout(resolve,1000))]).catch(()=>{});
  }

  async #belongs(sessionID){
    const id=String(sessionID||"");if(!id)return false;if(id===this.sessionId)return true;
    if(this.sessionParents.has(id))return this.sessionParents.get(id);
    let current=id;
    for(let depth=0;depth<8;depth++){
      try{
        const session=await this.client.session.get({sessionID:current}),parent=String(session?.parentID||"");
        if(parent===this.sessionId){this.sessionParents.set(id,true);return true}
        if(!parent)break;current=parent;
      }catch{break}
    }
    this.sessionParents.set(id,false);return false;
  }
  async #permission(data){
    if(!(await this.#belongs(data?.sessionID)))return;
    const kind=String(data?.action||""),disposition=openCodePermissionDisposition(this.permissionMode,kind);
    let decision=disposition==="allow"?"accept":disposition==="deny"?"decline":"decline";
    if(disposition==="ask"&&this.onPermission){
      const options=[{optionId:"once",name:"Allow once",kind:"allow_once"},...(Array.isArray(data?.save)&&data.save.length?[{optionId:"always",name:"Allow session",kind:"allow_always"}]:[]),{optionId:"reject",name:"Reject",kind:"reject_once"}];
      const toolCall={title:permissionTitle(data),toolCallId:String(data?.id||""),rawInput:{...(data?.metadata||{}),resources:Array.isArray(data?.resources)?data.resources:[]},kind:normalizePermissionKind(kind)};
      decision=await Promise.resolve().then(()=>this.onPermission({method:"permission",params:{toolCall,permissionType:kind,options}})).then(value=>value||"decline",()=>"decline");
    }
    if(decision==="acceptForSession"&&String(data.sessionID)===this.sessionId){
      const resources=(Array.isArray(data?.save)&&data.save.length?data.save:data?.resources)||[];
      for(const resource of resources.map(String).filter(Boolean))if(!this.sessionGrants.some(grant=>grant.action===kind&&grant.resource===resource))this.sessionGrants.push({action:kind,resource,effect:"allow"});
      await this.#applyPermissionRules().catch(()=>{});
    }
    const refusal=openCodeRefusal(decision,{disposition,mode:this.permissionMode,action:kind,resources:data?.resources});
    // A refused shell call reaches the model only as "Unable to execute command", which it retries, so the reason is steered into the
    // session before the refusal (as T3 Code does); the refusal stands without it.
    if(refusal)await this.client.session.synthetic({sessionID:String(data.sessionID),text:refusal.note,delivery:"steer",resume:false}).catch(()=>{});
    await this.client.permission.reply({sessionID:String(data.sessionID),requestID:String(data.id),decision:permissionDecision(decision),...(refusal?{message:refusal.reason}:{})}).catch(()=>{});
  }
  #startEvents(){
    this.eventTask=(async()=>{
      try{
        for await(const event of this.client.event.subscribe({signal:this.eventAbort.signal})){
          if(this.closed)break;
          try{await this.#event(event)}catch(error){if(!this.closed)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:errorText(error)}})}
        }
      }catch(error){if(!this.closed&&error?.name!=="AbortError"){if(this.activePrompt){this.activePrompt.error=errorText(error);this.activePrompt.settle?.()}this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:errorText(error)}})}}
    })();
  }
  async #event(event){
    const data=event?.data||{},sessionID=String(data.sessionID||"");
    if(sessionID&&!(await this.#belongs(sessionID)))return;
    const turn=this.activePrompt;
    if(event.type==="permission.asked")return await this.#permission(data);
    if(event.type==="session.text.delta"&&turn&&sessionID===this.sessionId){
      const delta=String(data.delta||"");if(!delta)return;turn.text+=delta;turn.assistantMessageId=String(data.assistantMessageID||turn.assistantMessageId||"")||null;
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:delta}}});return;
    }
    if(event.type==="session.reasoning.delta"&&turn&&sessionID===this.sessionId){
      const delta=String(data.delta||"");if(delta)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:delta},messageId:String(data.assistantMessageID||"reasoning")}});return;
    }
    if(event.type==="session.usage.updated"&&sessionID===this.sessionId){
      const tokens=data.tokens||{},used=Number(tokens.input||0)+Number(tokens.output||0)+Number(tokens.reasoning||0);
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used,size:this.contextByModel.get(this.model)||0,cost:data.cost!=null?{amount:Number(data.cost),currency:"USD"}:null,usage:{input_tokens:Number(tokens.input||0),output_tokens:Number(tokens.output||0),reasoning_tokens:Number(tokens.reasoning||0),cache_read_input_tokens:Number(tokens.cache?.read||0),cache_write_input_tokens:Number(tokens.cache?.write||0)}}});return;
    }
    if(event.type==="session.tool.input.started"){this.toolNames.set(String(data.id),String(data.name||"tool"));this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call",toolCallId:String(data.id),title:String(data.name||"Tool"),kind:normalizePermissionKind(data.name),status:"in_progress",rawInput:{}}});return}
    if(event.type==="session.tool.called"){const id=String(data.id),name=this.toolNames.get(id)||"tool";this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:id,title:name,kind:normalizePermissionKind(name),status:"in_progress",rawInput:data.input||{}}});return}
    if(event.type==="session.tool.success"){const id=String(data.id),name=this.toolNames.get(id)||"tool";this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:id,title:name,kind:normalizePermissionKind(name),status:"completed",rawOutput:outputText(data.content)}});return}
    if(event.type==="session.tool.failed"){const id=String(data.id),name=this.toolNames.get(id)||"tool";this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:id,title:name,kind:normalizePermissionKind(name),status:"failed",rawOutput:errorText(data.error)}});return}
    if(event.type==="session.execution.succeeded"&&turn&&sessionID===this.sessionId){turn.settle?.();return}
    if(event.type==="session.execution.failed"&&turn&&sessionID===this.sessionId){turn.error=errorText(data.error);turn.settle?.();return}
    if(event.type==="session.execution.interrupted"&&turn&&sessionID===this.sessionId){turn.cancelled=true;turn.settle?.();return}
  }
}
