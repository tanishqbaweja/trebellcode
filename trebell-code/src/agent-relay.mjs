import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { WebSocketServer } from "ws";
import { AcpAgentSession } from "./acp-agent-session.mjs";
import { OpenCodeAgentSession } from "./opencode-agent-session.mjs";
import { ClaudeAgentSession } from "./claude-agent-session.mjs";

const IMAGE_MIME={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".bmp":"image/bmp"};

function textOfInput(input=[]){return input.filter(item=>item?.type==="text").map(item=>item.text||"").join("\n")}

async function acpPrompt(input=[]){
  const out=[];
  for(const item of input){
    if(item?.type==="text")out.push({type:"text",text:String(item.text||"")});
    else if(item?.type==="localImage"){
      const mime=IMAGE_MIME[extname(String(item.path||"")).toLowerCase()]||"image/png";
      const data=await readFile(item.path);
      out.push({type:"image",mimeType:mime,data:data.toString("base64")});
    }else if(item?.type==="mention"){
      out.push({type:"resource_link",uri:`file://${String(item.path||"").replace(/\\/g,"/")}`,name:String(item.name||item.path||"file")});
    }
  }
  return out;
}

function acpToolItem(update){
  const id=String(update.toolCallId||randomUUID());
  const status=update.status==="completed"?"completed":update.status==="failed"?"failed":"inProgress";
  if(update.kind==="execute")return {type:"commandExecution",id,command:update.title||"Command",cwd:"",processId:null,source:"agent",status,commandActions:[],aggregatedOutput:typeof update.rawOutput==="string"?update.rawOutput:null,exitCode:null,durationMs:null,rawInput:update.rawInput,locations:update.locations||[]};
  if(update.kind==="edit"||update.kind==="delete"||update.kind==="move")return {type:"fileChange",id,status,changes:(update.locations||[]).map(location=>({path:location.path||location.uri||"",kind:update.kind})),rawInput:update.rawInput,rawOutput:update.rawOutput};
  return {type:"dynamicToolCall",id,namespace:"agent",tool:update.title||update.kind||"tool",arguments:update.rawInput??{},status,contentItems:update.content||null,success:update.status==="completed"?true:update.status==="failed"?false:null,durationMs:null,locations:update.locations||[],rawOutput:update.rawOutput};
}

function planSteps(update){return (update.entries||update.plan||[]).map(entry=>({step:entry.content||entry.step||entry.text||"Plan step",status:entry.status==="in_progress"?"inProgress":entry.status||"pending",priority:entry.priority||null}))}

function usageFromPromptResult(result,fallback=null){
  const openCode=result?.raw?.info?.tokens;
  if(openCode){
    const input=Number(openCode.input||0),output=Number(openCode.output||0),reasoning=Number(openCode.reasoning||0),cached=Number(openCode.cache?.read||0),cacheWrite=Number(openCode.cache?.write||0);
    return {usage:{totalTokens:Number(openCode.total)||(input+output+reasoning+cached+cacheWrite),inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:cacheWrite,outputTokens:output,reasoningOutputTokens:reasoning},cost:result.raw?.info?.cost!=null?{amount:Number(result.raw.info.cost),currency:"USD"}:null,at:Date.now()};
  }
  const claude=result?.raw?.usage;
  if(claude){
    const input=Number(claude.input_tokens||0),output=Number(claude.output_tokens||0),cached=Number(claude.cache_read_input_tokens||0),cacheWrite=Number(claude.cache_creation_input_tokens||0);
    return {usage:{totalTokens:input+output+cached+cacheWrite,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:cacheWrite,outputTokens:output,reasoningOutputTokens:0},cost:result.raw?.total_cost_usd!=null?{amount:Number(result.raw.total_cost_usd),currency:"USD"}:null,at:Date.now()};
  }
  return fallback;
}

function approvalOption(options,decision){
  const find=kind=>options.find(option=>option.kind===kind)?.optionId;
  if(decision==="acceptForSession")return find("allow_always")||find("allow_once")||null;
  if(decision==="accept")return find("allow_once")||find("allow_always")||null;
  return find("reject_once")||find("reject_always")||null;
}

function formQuestions(params){
  const schema=params?.requestedSchema||params?.schema||params?.form||{};
  const properties=schema.properties||{};
  const required=new Set(schema.required||[]);
  return Object.entries(properties).map(([id,def])=>({
    id,header:def.title||id,question:def.description||def.title||id,required:required.has(id),allowMultiple:Array.isArray(def.items?.enum),
    options:(def.enum||def.items?.enum||def.oneOf?.map(item=>item.const).filter(Boolean)||[]).map(value=>({label:String(value),description:""})),
  }));
}

export function attachAgentRelay(server,{runtimeManager,threadStore,terminals,state,environments=null,version="0.0.0",path="/api/agent/ws",log=()=>{},onThreadDeleted=null}={}){
  const wss=new WebSocketServer({noServer:true});
  const sessions=new Map();
  const socketContexts=new Set();
  const recoveryInFlight=new Set();

  async function ensureSession(thread,context,{permissionMode="supervised",model=null}={}){
    let session=sessions.get(thread.id);
    if(session)return session;
    const instances=runtimeManager.instances();
    const instance=instances.find(item=>item.id===thread.runtimeInstanceId)||instances.find(item=>item.kind===thread.runtime)||runtimeManager.activeInstance();
    if(instance.kind==="codex")throw new Error("Codex uses the native Codex relay");
    const environmentId=thread.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null;
    const status=await runtimeManager.probe(instance,{environmentId});if(!status.available)throw new Error(status.message||`${status.name} is unavailable`);
    const runtimeCwd=runtimeManager.runtimeCwd(thread.cwd,environmentId);const spawnProcess=runtimeManager.processSpawner(instance,environmentId);const remoteIo=runtimeManager.remoteIo(runtimeCwd,environmentId);
    const common={cwd:runtimeCwd,env:runtimeManager.childEnv(instance),permissionMode,onPermission:request=>context.permission(thread,request),onQuestion:request=>context.userQuestion(thread,request),onUpdate:params=>handleUpdate(thread.id,params),version};
    const runtime=instance.kind==="claude"
      ?new ClaudeAgentSession({...common,command:runtimeManager.executable(instance),spawnProcess})
      :instance.kind==="opencode"
      ?(remoteIo
        ?new AcpAgentSession({...common,runtime:"opencode",command:runtimeManager.executable(instance),args:["acp"],terminals,spawnProcess,remoteIo,version,onElicitation:request=>context.elicitation(thread,request)})
        :new OpenCodeAgentSession({...common,command:runtimeManager.executable(instance),serverUrl:instance.serverUrl||null}))
      :new AcpAgentSession({...common,runtime:instance.kind,command:runtimeManager.executable(instance),args:runtimeManager.acpArgs(instance,permissionMode,runtimeCwd),terminals,spawnProcess,remoteIo,version,onElicitation:request=>context.elicitation(thread,request)});
    const started=await runtime.start({providerSessionId:thread.providerSessionId||null,model:model||thread.model||null});
    const discoveredMeta=threadStore.get(thread.id)?.providerMeta||{};
    threadStore.update(thread.id,{providerSessionId:started.session.sessionId,providerMeta:{...discoveredMeta,initialize:started.initialize,setup:started.session},model:model||started.session.models?.currentModelId||thread.model||null});
    sessions.set(thread.id,runtime);return runtime;
  }

  function emit(method,params){for(const context of socketContexts)if(context.ws.readyState===context.ws.OPEN)context.ws.send(JSON.stringify({method,params}))}

  function settlePrompt({thread,turn,session,promptPromise,model=null}){
    const persistUsage=result=>{
      const usage=usageFromPromptResult(result,session.__usage);if(!usage)return;const current=threadStore.get(thread.id)||thread;
      state?.recordUsage?.({runtime:current.runtime||runtimeManager.activeRuntime(),provider:current.providerMeta?.runtimeInstanceId||null,model:current.model||model||null,environmentId:current.providerMeta?.environmentId??null,threadId:thread.id,turnId:turn.id,usage:usage.usage,cost:usage.cost,at:usage.at||Date.now()});
    };
    promptPromise.then(result=>{
      persistUsage(result);
      const providerMessageId=result?.providerMessageId||result?.userMessageId||null;if(providerMessageId)threadStore.updateTurn(thread.id,turn.id,{providerMessageId});
      const assistant=String(session.__assistant||"").trim();if(assistant){const item={type:"agentMessage",id:`assistant-${turn.id}`,text:assistant,phase:null,memoryCitation:null,delivery:null,questions:null};threadStore.addItem(thread.id,turn.id,item);emit("item/completed",{threadId:thread.id,turnId:turn.id,item,completedAtMs:Date.now()})}
      const status=result?.stopReason==="cancelled"?"cancelled":result?.stopReason==="refusal"?"failed":"completed";const completed=threadStore.finishTurn(thread.id,turn.id,{status,error:status==="failed"?{message:"Agent refused the turn"}:null});
      emit("turn/completed",{threadId:thread.id,turn:completed});emit("thread/status/changed",{threadId:thread.id,status:threadStore.get(thread.id).status});
    }).catch(error=>{
      persistUsage(null);
      const completed=threadStore.finishTurn(thread.id,turn.id,{status:"failed",error:{message:error.message}});emit("error",{threadId:thread.id,turnId:turn.id,message:error.message});emit("turn/completed",{threadId:thread.id,turn:completed});
    }).finally(()=>recoveryInFlight.delete(thread.id));
  }

  async function recoverPending(context){
    if(!state?.settings?.().continueThreadsAfterRestart)return;
    for(const thread of threadStore.list()){
      const recovery=thread.recovery;if(!recovery?.pending||!thread.providerSessionId||recoveryInFlight.has(thread.id))continue;
      recoveryInFlight.add(thread.id);
      try{
        const session=await ensureSession(thread,context,{model:thread.model||null});const turn=threadStore.restartTurn(thread.id,recovery.turnId);
        if(!turn)throw new Error("Interrupted turn was not found");
        session.__assistant="";session.__usage=null;emit("turn/started",{threadId:thread.id,turn});emit("thread/status/changed",{threadId:thread.id,status:{type:"active",activeFlags:[]}});
        const prompt=[{type:"text",text:"Continue where you left off."}];
        settlePrompt({thread,turn,session,promptPromise:session.prompt(prompt,{messageId:randomUUID(),agent:thread.agent||null}),model:thread.model||null});
      }catch(error){
        const failed=threadStore.finishTurn(thread.id,recovery.turnId,{status:"failed",error:{message:`Could not continue after restart: ${error.message}`}});emit("error",{threadId:thread.id,turnId:recovery.turnId,message:error.message});if(failed)emit("turn/completed",{threadId:thread.id,turn:failed});recoveryInFlight.delete(thread.id);
      }
    }
  }

  function handleUpdate(threadId,params){
    const update=params?.update||{};const thread=threadStore.get(threadId);if(!thread)return;const turnId=thread.turns?.at(-1)?.id||null;
    const type=update.sessionUpdate;
    if(type==="agent_message_chunk"){
      const text=update.content?.type==="text"?update.content.text||"":"";
      if(text&&turnId)emit("item/agentMessage/delta",{threadId,turnId,delta:text});
      const session=sessions.get(threadId);if(session)session.__assistant=(session.__assistant||"")+text;
    }else if(type==="agent_thought_chunk"){
      if(turnId)emit("item/reasoning/activity",{threadId,turnId,active:true});
    }else if(type==="tool_call"){
      const item=acpToolItem(update);if(turnId)threadStore.addItem(threadId,turnId,item);emit("item/started",{threadId,turnId,item,startedAtMs:Date.now()});
    }else if(type==="tool_call_update"){
      const item=acpToolItem(update);if(turnId)threadStore.addItem(threadId,turnId,item);
      if(update.status==="completed"||update.status==="failed")emit("item/completed",{threadId,turnId,item,completedAtMs:Date.now()});
      else emit("item/tool/progress",{threadId,turnId,item});
    }else if(type==="plan"){
      if(turnId)emit("turn/plan/updated",{threadId,turnId,plan:planSteps(update)});
    }else if(type==="usage_update"){
      const usage=update.usage||{};
      const input=Number(usage.input_tokens??usage.inputTokens??0)||0;
      const output=Number(usage.output_tokens??usage.outputTokens??0)||0;
      const cached=Number(usage.cache_read_input_tokens??usage.cacheReadInputTokens??0)||0;
      const cacheWrite=Number(usage.cache_write_input_tokens??usage.cache_creation_input_tokens??usage.cacheWriteInputTokens??0)||0;
      const reasoning=Number(usage.reasoning_tokens??usage.reasoningOutputTokens??0)||0;
      const used=Number(update.used)||(input+output+cached+cacheWrite+reasoning),size=Number(update.size)||0;
      const snapshot={totalTokens:used,inputTokens:input||Math.max(0,used-output-reasoning),cachedInputTokens:cached,cacheWriteInputTokens:cacheWrite,outputTokens:output,reasoningOutputTokens:reasoning};
      const runtimeSession=sessions.get(threadId);if(runtimeSession)runtimeSession.__usage={usage:snapshot,cost:update.cost||null,at:Date.now()};
      emit("thread/tokenUsage/updated",{threadId,turnId,tokenUsage:{total:snapshot,last:snapshot,modelContextWindow:size||null,cost:update.cost||null}});
    }else if(type==="diff"){
      emit("turn/diff/updated",{threadId,turnId,diff:update.diff||[]});
    }else if(type==="available_commands_update"||type==="config_option_update"||type==="current_mode_update"||type==="session_info_update"){
      const current=threadStore.get(threadId)?.providerMeta||{};threadStore.update(threadId,{providerMeta:{...current,[type]:update}});
      emit("thread/providerMetadata/updated",{threadId,type,update});
    }else if(type==="runtime_error"){
      emit("error",{threadId,turnId,message:update.message||"Agent runtime stopped"});
    }
  }

  async function request(context,method,params={}){
    if(method==="initialize")return {userAgent:"trebell-agent-relay",capabilities:{experimentalApi:true}};
    const runtime=runtimeManager.activeRuntime();
    if(method==="thread/list")return {data:threadStore.list(runtime).filter(thread=>!thread.archived).slice(0,params.limit||100),nextCursor:null};
    if(method==="thread/read"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");
      return {thread:params.includeTurns===false?{...thread,turns:[]}:thread};
    }
    if(method==="thread/start"){
      const instance=runtimeManager.activeInstance();const environmentId=state?.settings?.().activeEnvironmentId||null;const effectiveCwd=runtimeManager.runtimeCwd(params.cwd||process.cwd(),environmentId);const seed=threadStore.create({runtime,cwd:effectiveCwd,providerSessionId:"",model:params.model||null,agent:params.agent||null,providerMeta:{runtimeInstanceId:instance.id,environmentId}});
      threadStore.update(seed.id,{runtimeInstanceId:instance.id});
      const session=await ensureSession(threadStore.get(seed.id),context,{permissionMode:params.approvalPolicy==="never"?"full":"supervised",model:params.model||null});
      const thread=threadStore.update(seed.id,{providerSessionId:session.sessionId,model:params.model||session.sessionSetup?.models?.currentModelId||null});
      emit("thread/started",{thread});return {thread};
    }
    if(method==="thread/resume"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");
      await ensureSession(thread,context,{model:params.model||thread.model});return {thread:threadStore.get(thread.id)};
    }
    if(method==="thread/items/list"){
      const thread=threadStore.get(params.threadId);const data=[];for(const turn of thread?.turns||[])for(const item of turn.items||[])data.push({turnId:turn.id,item});return {data:data.slice(-(params.limit||150)).reverse()};
    }
    if(method==="thread/name/set"){
      const runtimeSession=sessions.get(params.threadId);if(runtimeSession instanceof ClaudeAgentSession)await runtimeSession.rename(params.name).catch(()=>{});
      const thread=threadStore.rename(params.threadId,params.name);emit("thread/name/updated",{threadId:params.threadId,name:thread?.name||null});return {thread}
    }
    if(method==="thread/delete"){
      const deletedThread=threadStore.get(params.threadId);
      const runtimeSession=sessions.get(params.threadId);if(runtimeSession instanceof ClaudeAgentSession)await runtimeSession.delete().catch(()=>{});else await runtimeSession?.close().catch(()=>{});
      sessions.delete(params.threadId);threadStore.delete(params.threadId);state?.updateThreadMeta?.(params.threadId,{deletedAt:Date.now(),archived:true});if(onThreadDeleted)try{await onThreadDeleted(deletedThread)}catch{}return {ok:true}
    }
    if(method==="thread/section/move"){return {thread:threadStore.update(params.threadId,{section:params.sectionId?{id:params.sectionId,name:params.sectionId}:null})}}
    if(method==="thread/settings/update"){
      const current=threadStore.get(params.threadId);const nextSettings={...(current?.settings||{}),...(params.settings||{})};
      return {thread:threadStore.update(params.threadId,{settings:nextSettings,...(Object.prototype.hasOwnProperty.call(params.settings||{},"agent")?{agent:params.settings.agent||null}:{})})}
    }
    if(method==="thread/goal/get")return {goal:state.threadMeta(params.threadId)?.goal||null};
    if(method==="thread/goal/set"){const meta=state.updateThreadMeta(params.threadId,{goal:{...(state.threadMeta(params.threadId)?.goal||{}),...params}});emit("thread/goal/updated",{threadId:params.threadId,goal:meta.goal});return {goal:meta.goal}}
    if(method==="thread/goal/clear"){state.updateThreadMeta(params.threadId,{goal:null});emit("thread/goal/cleared",{threadId:params.threadId});return {ok:true}}
    if(method==="thread/attachment/list")return {data:state.threadMeta(params.threadId)?.attachments||[]};
    if(method==="thread/attachment/add"){
      const meta=state.threadMeta(params.threadId);const attachments=[...(meta.attachments||[]),{attachmentType:params.attachmentType,identityKey:params.identityKey,payload:params.payload}];state.updateThreadMeta(params.threadId,{attachments});return {data:attachments};
    }
    if(method==="thread/attachment/remove"){
      const meta=state.threadMeta(params.threadId);const attachments=(meta.attachments||[]).filter(item=>!(item.attachmentType===params.attachmentType&&item.identityKey===params.identityKey));state.updateThreadMeta(params.threadId,{attachments});return {data:attachments};
    }
    if(method==="thread/archive"){await sessions.get(params.threadId)?.close().catch(()=>{});sessions.delete(params.threadId);return {thread:threadStore.update(params.threadId,{archived:true})}}
    if(method==="thread/unarchive"){const thread=threadStore.update(params.threadId,{archived:false});if(!thread)throw new Error("Thread not found");return {thread}}
    if(method==="thread/fork"){
      const source=threadStore.get(params.threadId);if(!source)throw new Error("Thread not found");const runtimeSession=sessions.get(source.id)||await ensureSession(source,context,{});
      let fork;
      if(runtimeSession instanceof OpenCodeAgentSession)fork=await runtimeSession.fork();
      else if(runtimeSession instanceof ClaudeAgentSession)fork=await runtimeSession.fork();
      else{
        const init=runtimeSession.initializeResult?.agentCapabilities?.sessionCapabilities||{};if(init.fork==null)throw Object.assign(new Error(`${runtime} does not advertise session forking`),{code:-32601});
        fork=await runtimeSession.client.forkSession({sessionId:source.providerSessionId,cwd:source.cwd,mcpServers:[]});
      }
      const providerSessionId=fork.sessionId||fork.id;const thread=threadStore.create({runtime,cwd:source.cwd,providerSessionId,model:source.model,agent:source.agent||null,name:source.name?`${source.name} (fork)`:null,providerMeta:{...(source.providerMeta||{}),setup:fork}});return {thread};
    }
    if(method==="turn/start"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");const session=await ensureSession(thread,context,{model:params.model||thread.model});
      if(params.model&&params.model!==thread.model){await session.setModel(params.model).catch(()=>{});threadStore.update(thread.id,{model:params.model})}
      const turn=threadStore.addTurn(thread.id,{inputText:textOfInput(params.input),status:"inProgress"});session.__assistant="";
      session.__usage=null;
      emit("turn/started",{threadId:thread.id,turn});
      const prompt=await acpPrompt(params.input||[]);
      const selectedAgent=Object.prototype.hasOwnProperty.call(params,"agent")?(params.agent||null):(thread.agent||null);
      if(selectedAgent!==thread.agent)threadStore.update(thread.id,{agent:selectedAgent});
      settlePrompt({thread,turn,session,promptPromise:session.prompt(prompt,{messageId:randomUUID(),agent:selectedAgent}),model:params.model||thread.model||null});
      return {turn};
    }
    if(method==="turn/interrupt"){sessions.get(params.threadId)?.cancel();return {ok:true}}
    if(method==="turn/steer"){throw Object.assign(new Error(`${runtime} does not expose in-flight steering through ACP`),{code:-32601})}
    if(method==="thread/compact/start"){
      const thread=threadStore.get(params.threadId);const session=thread&&(sessions.get(thread.id)||await ensureSession(thread,context,{}));if(session instanceof OpenCodeAgentSession||session instanceof ClaudeAgentSession){await session.compact();emit("thread/compacted",{threadId:thread.id});return {ok:true}}
      throw Object.assign(new Error(`${runtime} does not expose a generic compaction RPC`),{code:-32601});
    }
    if(method==="thread/revert"){
      const thread=threadStore.get(params.threadId);const session=thread&&(sessions.get(thread.id)||await ensureSession(thread,context,{}));if(session instanceof OpenCodeAgentSession){
        const turn=thread.turns?.find(item=>item.id===params.beforeTurnId);const providerMessageId=turn?.providerMessageId||turn?.items?.find(item=>item.providerMessageId)?.providerMessageId;if(!providerMessageId)throw new Error("This OpenCode turn does not have a provider message checkpoint yet");
        await session.revert(providerMessageId);const index=thread.turns.findIndex(item=>item.id===params.beforeTurnId);threadStore.update(thread.id,{turns:index>=0?thread.turns.slice(0,index):thread.turns});emit("thread/reverted",{threadId:thread.id});return {thread:threadStore.get(thread.id)};
      }
      if(session instanceof ClaudeAgentSession){
        const index=thread.turns.findIndex(item=>item.id===params.beforeTurnId);const prior=index>0?thread.turns[index-1]:null;const providerMessageId=prior?.providerMessageId||null;
        if(!providerMessageId)throw new Error("Claude Code cannot rewind before the first persisted user message in this thread.");
        const forked=await session.rewindConversation(providerMessageId);threadStore.update(thread.id,{providerSessionId:forked.sessionId,turns:thread.turns.slice(0,index)});emit("thread/reverted",{threadId:thread.id});return {thread:threadStore.get(thread.id)};
      }
      throw Object.assign(new Error(`${runtime} does not expose conversation rewind`),{code:-32601});
    }
    if(method==="review/start"){
      return request(context,"turn/start",{threadId:params.threadId,input:[{type:"text",text:"Review the current workspace changes. Focus on correctness, regressions, security and missing tests. Return actionable findings."}]});
    }
    if(method==="collaborationMode/list")return {data:[]};
    throw Object.assign(new Error(`Unsupported external-agent RPC method: ${method}`),{code:-32601});
  }

  const upgrade=(req,socket,head)=>{
    const url=new URL(req.url||"/","http://127.0.0.1");if(url.pathname!==path)return;
    wss.handleUpgrade(req,socket,head,ws=>{
      const pendingServer=new Map();let nextServerId=1;
      const context={
        ws,
        serverRequest(method,params){
          const id=`agent-${nextServerId++}`;ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingServer.delete(id);reject(new Error(`${method} user response timed out`))},5*60_000);pendingServer.set(id,{resolve,reject,timer})});
        },
        async permission(thread,{params,options}){
          const result=await context.serverRequest("item/tool/requestApproval",{threadId:thread.id,reason:params.toolCall?.title||"Agent requests permission",toolCall:params.toolCall,options});return result?.decision||"decline";
        },
        async userQuestion(thread,{input}){
          const questions=(input?.questions||[]).map((question,index)=>({
            id:String(question.id||`q${index+1}`),
            header:String(question.header||question.question||`Question ${index+1}`),
            question:String(question.question||question.header||"Provide input"),
            required:true,
            allowMultiple:Boolean(question.multiSelect||question.allowMultiple),
            options:(question.options||[]).map(option=>typeof option==="string"?{label:option,description:""}:{label:String(option.label||option.value||""),description:String(option.description||"")}),
          }));
          if(!questions.length)return {};
          const result=await context.serverRequest("item/tool/requestUserInput",{threadId:thread.id,questions});
          const answers={};for(const [id,value] of Object.entries(result?.answers||{}))answers[id]=Array.isArray(value?.answers)?value.answers:value;
          return answers;
        },
        async elicitation(thread,{params}){
          const questions=formQuestions(params);if(!questions.length)return {action:"cancel"};const result=await context.serverRequest("item/tool/requestUserInput",{threadId:thread.id,questions});
          const content={};for(const [id,value] of Object.entries(result?.answers||{}))content[id]=Array.isArray(value?.answers)?value.answers.join(", "):value;return {action:"accept",content};
        },
      };
      socketContexts.add(context);
      ws.on("message",async raw=>{
        let message;try{message=JSON.parse(String(raw))}catch{return}
        if(Object.prototype.hasOwnProperty.call(message,"id")&&!message.method&&typeof message.id==="string"&&pendingServer.has(message.id)){
          const pending=pendingServer.get(message.id);pendingServer.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error(message.error.message||"Request declined")):pending.resolve(message.result);return;
        }
        if(!message.method)return;
        if(!Object.prototype.hasOwnProperty.call(message,"id")){
          if(message.method==="initialized")recoverPending(context).catch(error=>log(error?.stack||String(error)));
          return;
        }
        try{const result=await request(context,message.method,message.params||{});ws.send(JSON.stringify({id:message.id,result}))}
        catch(error){log(error?.stack||String(error));ws.send(JSON.stringify({id:message.id,error:{code:Number(error?.code)||-32000,message:error instanceof Error?error.message:String(error)}}))}
      });
      ws.on("close",()=>{socketContexts.delete(context);for(const pending of pendingServer.values()){clearTimeout(pending.timer);pending.reject(new Error("Agent client disconnected"))}pendingServer.clear()});
    });
  };
  server.on("upgrade",upgrade);
  async function closeSessions(){for(const session of sessions.values())await session.close().catch(()=>{});sessions.clear()}
  return {reset:closeSessions,close:async()=>{
    server.off("upgrade",upgrade);
    for(const context of socketContexts){try{context.ws.terminate()}catch{}}
    socketContexts.clear();
    for(const client of wss.clients){try{client.terminate()}catch{}}
    await closeSessions();
    try{wss.close()}catch{}
  }};
}
