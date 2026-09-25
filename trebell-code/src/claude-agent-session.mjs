import { randomUUID } from "node:crypto";
import { deleteSession, forkSession, getSessionInfo, getSessionMessages, query, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { permissionDisposition } from "./permission-policy.mjs";

const MODEL_ALIASES=["sonnet","opus","haiku"];

function permissionMode(mode){
  if(mode==="full")return "bypassPermissions";
  if(mode==="auto")return "auto";
  if(mode==="edits")return "acceptEdits";
  if(mode==="read-only")return "dontAsk";
  return "default";
}

function readOnlyTool(name){
  return new Set(["Read","Glob","Grep","WebSearch","WebFetch","LS","TodoRead"]).has(String(name));
}

function editTool(name){
  return new Set(["Edit","Write","MultiEdit","NotebookEdit","TodoWrite"]).has(String(name));
}

function toolKind(name){
  const value=String(name||"").toLowerCase();
  if(["read","glob","grep","ls"].some(x=>value.includes(x)))return "read";
  if(["edit","write","notebook"].some(x=>value.includes(x)))return "edit";
  if(["bash","shell","powershell"].some(x=>value.includes(x)))return "execute";
  if(value.includes("web")||value.includes("fetch"))return "fetch";
  if(value.includes("task")||value.includes("agent"))return "other";
  return "other";
}

function usageTotal(usage={}){
  return Number(usage.input_tokens||0)+Number(usage.cache_creation_input_tokens||0)+Number(usage.cache_read_input_tokens||0)+Number(usage.output_tokens||0);
}

export class ClaudeAgentSession{
  constructor({command="claude",cwd=process.cwd(),env=process.env,permissionMode:mode="supervised",onUpdate,onPermission,onQuestion,version="0.0.0",spawnProcess=null,autoCompactWindow=null,forkFromSessionId=null,resumeSessionAt=null,resumeDropsTurn=null,mcpServers={},sdk=null}={}){
    this.command=command;this.cwd=cwd;this.env=env;this.permissionMode=mode;this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.version=version;this.spawnProcess=spawnProcess;
    this.autoCompactWindow=Number.isInteger(Number(autoCompactWindow))&&Number(autoCompactWindow)>=100_000&&Number(autoCompactWindow)<=1_000_000?Number(autoCompactWindow):null;
    this.mcpServers=mcpServers&&typeof mcpServers==="object"?{...mcpServers}:{};
    this.sdk=sdk||{query,getSessionInfo,forkSession,renameSession,getSessionMessages,deleteSession};
    this.helperSharesRuntime=!this.spawnProcess&&String(this.env.CLAUDE_CONFIG_DIR||"")===String(process.env.CLAUDE_CONFIG_DIR||"");
    this.sessionId=null;this.model="sonnet";this.currentQuery=null;this.currentAbort=null;this.closed=false;this.startedOnce=false;this.lastSystem=null;
    this.forkFromSessionId=forkFromSessionId||null;this.resumeSessionAt=resumeSessionAt||null;this.resumeDropsTurn=resumeDropsTurn||null;
    this.initializeResult={agentCapabilities:{loadSession:true,sessionCapabilities:{fork:{},resume:{},close:{}}},agentInfo:{name:"Claude Code"}};
    this.sessionSetup=null;
  }

  async start({providerSessionId=null,model=null}={}){
    this.sessionId=providerSessionId||randomUUID();
    this.model=model||"sonnet";
    if(providerSessionId&&!this.forkFromSessionId){
      const existing=this.helperSharesRuntime?await this.sdk.getSessionInfo(providerSessionId,{dir:this.cwd}).catch(()=>undefined):true;
      if(!existing)throw new Error(`Claude Code session ${providerSessionId} was not found in ${this.cwd}`);
      this.startedOnce=true;
    }
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:MODEL_ALIASES.map(modelId=>({modelId,name:modelId[0].toUpperCase()+modelId.slice(1)}))},configOptions:[],modes:{currentModeId:permissionMode(this.permissionMode),availableModes:[]}};
    return {initialize:this.initializeResult,session:this.sessionSetup};
  }

  async prompt(parts,{messageId=null,agent=null}={}){
    if(this.closed)throw new Error("Claude session is closed");
    const pendingFork=this.forkFromSessionId?{
      sourceSessionId:this.forkFromSessionId,
      targetSessionId:this.sessionId,
      resumeSessionAt:this.resumeSessionAt||null,
      resumeDropsTurn:this.resumeDropsTurn||null,
    }:null;
    const text=parts.map(part=>{
      if(part.type==="text")return String(part.text||"");
      if(part.type==="resource_link")return `Attached file: ${String(part.uri||"").replace(/^file:\/\//,"")}`;
      if(part.type==="image")return "[Image attachment supplied by Trebell]";
      return JSON.stringify(part);
    }).filter(Boolean).join("\n");
    const abortController=new AbortController();this.currentAbort=abortController;
    const canUseTool=async(toolName,input,options)=>{
      if(toolName==="AskUserQuestion"&&this.onQuestion){
        const answer=await this.onQuestion({toolName,input,options});
        if(answer&&typeof answer==="object")return {behavior:"allow",updatedInput:{...input,answers:answer},toolUseID:options.toolUseID};
      }
      const policyKind=editTool(toolName)?"edit":readOnlyTool(toolName)?"read":toolKind(toolName),disposition=permissionDisposition(this.permissionMode,policyKind,{action:toolName,rawInput:input,workspace:this.cwd});
      if(disposition==="allow")return {behavior:"allow",updatedInput:input,toolUseID:options.toolUseID};
      if(disposition==="deny")return {behavior:"deny",message:"Trebell read-only mode denied this tool.",toolUseID:options.toolUseID};
      const choices=[
        {optionId:"allow_once",name:"Allow once",kind:"allow_once"},
        ...((options.suggestions||[]).length?[{optionId:"allow_always",name:"Always allow",kind:"allow_always"}]:[]),
        {optionId:"reject_once",name:"Reject",kind:"reject_once"},
      ];
      const decision=await this.onPermission?.({
        method:"claude/canUseTool",
        params:{toolCall:{title:options.title||options.displayName||toolName,toolCallId:options.toolUseID,rawInput:input,kind:toolKind(toolName)},toolName,input},
        options:choices,
      });
      if(decision==="acceptForSession")return {behavior:"allow",updatedInput:input,updatedPermissions:options.suggestions,toolUseID:options.toolUseID};
      if(decision==="accept")return {behavior:"allow",updatedInput:input,toolUseID:options.toolUseID};
      return {behavior:"deny",message:"User denied this tool in Trebell Code.",toolUseID:options.toolUseID};
    };
    const options={
      cwd:this.cwd,
      model:this.model||undefined,
      pathToClaudeCodeExecutable:this.command,
      env:{...this.env,CLAUDE_AGENT_SDK_CLIENT_APP:`trebell-code/${this.version}`},
      permissionMode:permissionMode(this.permissionMode),
      ...(this.permissionMode==="full"?{allowDangerouslySkipPermissions:true}:{}),
      canUseTool,
      enableFileCheckpointing:true,
      settingSources:["user","project","local"],
      tools:{type:"preset",preset:"claude_code"},
      mcpServers:this.mcpServers,
      ...(this.autoCompactWindow?{autoCompactWindow:this.autoCompactWindow}:{}),
      ...(agent?{agent}:{}),
      includePartialMessages:false,
      abortController,
      ...(this.spawnProcess?{spawnClaudeCodeProcess:this.spawnProcess}:{}),
      ...(this.forkFromSessionId
        ?{resume:this.forkFromSessionId,forkSession:true,sessionId:this.sessionId,...(this.resumeSessionAt?{resumeSessionAt:this.resumeSessionAt}:{}),...(this.resumeDropsTurn?{resumeDropsTurn:this.resumeDropsTurn}:{})}
        :this.startedOnce?{resume:this.sessionId}:{sessionId:this.sessionId}),
    };
    const runtime=this.sdk.query({prompt:text,options});this.currentQuery=runtime;
    let result=null;let emittedText="";let lastChainEntryId=null;
    try{
      for await(const message of runtime){
        if((message.type==="user"||message.type==="assistant"||message.type==="system")&&message.uuid)lastChainEntryId=message.uuid;
        if(message.type==="system"&&message.subtype==="init"){
          this.sessionId=message.session_id||this.sessionId;this.startedOnce=true;this.lastSystem=message;
          const models=Array.isArray(message.models)?message.models:[];
          this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"session_info_update",model:message.model,tools:message.tools||[],mcpServers:message.mcp_servers||[],commands:message.slash_commands||[],agents:message.agents||[],capabilities:message.capabilities||[],models}});
          continue;
        }
        if(message.type==="assistant"){
          for(const block of message.message?.content||[]){
            if(block.type==="text"&&block.text){emittedText+=block.text;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:block.text},messageId:message.uuid}})}
            else if(block.type==="thinking"&&block.thinking)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:block.thinking},messageId:message.uuid}});
            else if(block.type==="tool_use")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call",toolCallId:block.id,title:block.name,kind:toolKind(block.name),status:"in_progress",rawInput:block.input}});
          }
          continue;
        }
        if(message.type==="tool_progress"){
          this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:message.tool_use_id||message.toolUseID||message.uuid,title:message.tool_name||"Tool",kind:toolKind(message.tool_name),status:"in_progress",rawOutput:message}});
          continue;
        }
        if(message.type==="system"&&message.subtype==="background_tasks_changed"){
          for(const task of message.tasks||[])if(!task.ambient)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:task.task_id,title:task.description||task.task_type||"Background task",kind:"other",status:"in_progress",rawOutput:task}});
          continue;
        }
        if(message.type==="system"&&message.subtype==="status"){
          this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"session_info_update",status:message.status,permissionMode:message.permissionMode,compactResult:message.compact_result}});continue;
        }
        if(message.type==="result"){
          result=message;this.sessionId=message.session_id||this.sessionId;this.startedOnce=true;
          const used=usageTotal(message.usage||{});if(used||message.total_cost_usd)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used,size:0,cost:{amount:Number(message.total_cost_usd||0),currency:"USD"},usage:message.usage||null,modelUsage:message.modelUsage||null}});
        }
      }
    }finally{this.currentQuery=null;this.currentAbort=null}
    if(!result)throw new Error("Claude Code ended without a result message");
    if(result.subtype!=="success"){
      const error=new Error(result.errors?.join?.("\n")||result.error||`Claude Code turn failed: ${result.subtype}`);
      if(String(error.message).startsWith("Resume rejected by --resume-drops-turn:")){
        error.code="CLAUDE_REWIND_REJECTED";error.claudeFork=pendingFork;
        if(pendingFork){
          this.sessionId=pendingFork.sourceSessionId;this.startedOnce=true;
          this.forkFromSessionId=null;this.resumeSessionAt=null;this.resumeDropsTurn=null;
        }
      }
      throw error;
    }
    if(pendingFork){
      this.forkFromSessionId=null;this.resumeSessionAt=null;this.resumeDropsTurn=null;
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"claude_fork_materialized",fork:{...pendingFork,targetSessionId:this.sessionId}}});
    }
    if(!emittedText&&result.result)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:result.result}}});
    return {stopReason:result.is_error?"refusal":"end_turn",providerMessageId:lastChainEntryId||null,userMessageId:result.user_message_uuid||messageId||null,raw:result};
  }

  async setModel(model){this.model=model||this.model;if(this.currentQuery)await this.currentQuery.setModel(this.model);return {modelId:this.model}}
  async cancel(){try{if(this.currentQuery)await this.currentQuery.interrupt();else this.currentAbort?.abort()}catch{this.currentAbort?.abort()}}
  async compact(){return this.prompt([{type:"text",text:"/compact"}])}
  async fork({upToMessageId=null}={}){
    const targetSessionId=randomUUID();
    return {sessionId:targetSessionId,lazyFork:{sourceSessionId:this.sessionId,targetSessionId,resumeSessionAt:upToMessageId||null}};
  }
  #requireHostSessionHelper(operation){
    if(!this.helperSharesRuntime)throw new Error(`Claude ${operation} is unavailable through the host session helper for this custom or remote Claude home.`);
  }
  async rename(name){this.#requireHostSessionHelper("rename");return this.sdk.renameSession(this.sessionId,name,{dir:this.cwd})}
  async history(){this.#requireHostSessionHelper("history");return this.sdk.getSessionMessages(this.sessionId,{dir:this.cwd,includeSystemMessages:false})}
  async rewindConversation(upToMessageId,{dropsTurn=null}={}){
    const sourceSessionId=this.sessionId,targetSessionId=randomUUID();
    this.sessionId=targetSessionId;this.startedOnce=false;this.forkFromSessionId=sourceSessionId;this.resumeSessionAt=upToMessageId||null;this.resumeDropsTurn=dropsTurn||null;
    return {sessionId:targetSessionId,lazyFork:{sourceSessionId,targetSessionId,resumeSessionAt:this.resumeSessionAt,resumeDropsTurn:this.resumeDropsTurn}};
  }
  async close(){if(this.closed)return;this.closed=true;await this.cancel().catch(()=>{});try{this.currentQuery?.close()}catch{}}
  async delete(){await this.close();this.#requireHostSessionHelper("delete");return this.sdk.deleteSession(this.sessionId,{dir:this.cwd})}
}
