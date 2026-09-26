import { performance } from "node:perf_hooks";

function abortError(signal){
  const reason=signal?.reason;if(reason?.name==="AbortError")return reason;
  const error=new Error(reason instanceof Error?(reason.message||"Native agent turn was cancelled."):String(reason||"Native agent turn was cancelled."));error.name="AbortError";return error;
}
function throwIfAborted(signal){if(signal?.aborted)throw abortError(signal)}

function boundedInteger(value,fallback,{min=1,max=10_000}={}){
  const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;
}

function safeArguments(value){
  if(value&&typeof value==="object"&&!Array.isArray(value))return value;
  try{const parsed=JSON.parse(String(value||"{}"));return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{}}
  catch{return {}}
}

function resultContent(value){
  if(typeof value==="string")return value;
  if(value==null)return "";
  if(typeof value?.content==="string")return value.content;
  if(Array.isArray(value?.contentItems)){
    const parts=[];let hasImage=false;
    for(const item of value.contentItems){
      if(typeof item==="string")parts.push({type:"text",text:item});
      else if(["inputText","outputText","text"].includes(item?.type)&&typeof item.text==="string")parts.push({type:"text",text:item.text});
      else if((item?.type==="inputImage"||item?.type==="image")&&(item.imageUrl||item.dataUrl)){
        hasImage=true;parts.push({type:"image_url",image_url:{url:String(item.imageUrl||item.dataUrl)}});
      }
    }
    if(parts.length)return hasImage?parts:parts.map(part=>part.text).join("\n");
  }
  try{return JSON.stringify(value)}catch{return String(value)}
}

function aggregateUsage(total,value={}){
  return {
    inputTokens:total.inputTokens+(Number(value.inputTokens)||0),
    outputTokens:total.outputTokens+(Number(value.outputTokens)||0),
    totalTokens:total.totalTokens+(Number(value.totalTokens)||0),
    cachedInputTokens:total.cachedInputTokens+(Number(value.cachedInputTokens)||0),
    cacheWriteInputTokens:total.cacheWriteInputTokens+(Number(value.cacheWriteInputTokens)||0),
  };
}

function nowMs(){return performance.now()}
function duration(start){return Number((performance.now()-start).toFixed(3))}

function emit(onEvent,event){
  try{onEvent?.({...event,at:Date.now()})}catch{}
}

function steeringMessages(consumeSteering){
  if(typeof consumeSteering!=="function")return [];
  const value=consumeSteering();return (Array.isArray(value)?value:[]).filter(message=>message&&typeof message==="object"&&message.role);
}

function applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn,toolCalls,stage}={}){
  const messages=steeringMessages(consumeSteering);if(!messages.length)return false;
  conversation.push(...messages);
  emit(onEvent,{name:"native.steering.applied",status:"completed",model:String(model||""),provider:provider||null,data:{stage,messageCount:messages.length,modelTurn,toolCalls}});
  return true;
}

export function nativeProviderRetryable(error){
  if(!error||error?.name==="AbortError")return false;
  if(typeof error.retryable==="boolean")return error.retryable;
  const status=Number(error.status||error.statusCode||0);
  if(status)return [408,409,425,429].includes(status)||(status>=500&&status<=599);
  const code=String(error.code||"").toUpperCase();
  if(["ETIMEDOUT","ESOCKETTIMEDOUT","ECONNRESET","ECONNREFUSED","EPIPE","EAI_AGAIN","ENETDOWN","ENETUNREACH","EHOSTUNREACH"].includes(code))return true;
  const message=String(error.message||error).toLowerCase();
  return /\b(?:timeout|timed out|fetch failed|network error|socket hang up|connection reset|temporar(?:y|ily) unavailable|rate limit(?:ed)?)\b/.test(message);
}

async function retryDelay(ms,signal){
  if(ms<=0){throwIfAborted(signal);return}
  await new Promise((resolve,reject)=>{
    let settled=false;
    const done=()=>{if(settled)return;settled=true;cleanup();resolve()};
    const aborted=()=>{if(settled)return;settled=true;cleanup();reject(abortError(signal))};
    const timer=setTimeout(done,ms),cleanup=()=>{clearTimeout(timer);signal?.removeEventListener?.("abort",aborted)};
    if(signal?.aborted)return aborted();signal?.addEventListener?.("abort",aborted,{once:true});
  });
}

export function nativeAgentBudget(options={}){
  const wallTime=Number(options.maxWallTimeMs);
  return {
    maxModelTurns:boundedInteger(options.maxModelTurns,24,{min:1,max:500}),
    maxToolCalls:boundedInteger(options.maxToolCalls,100,{min:0,max:5000}),
    maxWallTimeMs:Number.isFinite(wallTime)&&wallTime>0?Math.floor(wallTime):null,
  };
}

export async function runNativeAgentTurn({
  providerTurn,executeTool,model,messages=[],tools=[],provider=null,toolChoice="auto",
  maxOutputTokens=null,temperature=null,parallelToolCalls=true,maxModelTurns=24,maxToolCalls=100,maxWallTimeMs=null,
  maxProviderAttempts=3,retryBaseDelayMs=250,consumeSteering=null,signal=null,onEvent=null,metadata=null,
}={}){
  if(typeof providerTurn!=="function")throw new Error("Native agent loop requires a providerTurn function.");
  if(typeof executeTool!=="function")throw new Error("Native agent loop requires an executeTool function.");
  if(!String(model||"").trim())throw new Error("Native agent loop requires a model.");
  const budget=nativeAgentBudget({maxModelTurns,maxToolCalls,maxWallTimeMs}),conversation=[...(Array.isArray(messages)?messages:[])];
  let modelTurns=0,toolCalls=0,usage={inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0},lastResponse=null;
  const startedAt=Date.now(),started=nowMs(),wallController=budget.maxWallTimeMs!=null?new AbortController():null,deadlineAt=budget.maxWallTimeMs==null?null:Date.now()+budget.maxWallTimeMs;
  let wallTimer=null;
  const armWallTimer=()=>{
    if(!wallController||wallController.signal.aborted||deadlineAt==null)return;
    const remaining=deadlineAt-Date.now();if(remaining<=0){wallController.abort("native-wall-time-budget");return}
    wallTimer=setTimeout(armWallTimer,Math.min(remaining,2_147_000_000));
  };
  armWallTimer();
  const turnSignal=wallController?(signal?AbortSignal.any([signal,wallController.signal]):wallController.signal):signal;
  emit(onEvent,{name:"native.turn.started",status:"running",model:String(model),provider:provider||null,data:{...metadata,maxModelTurns:budget.maxModelTurns,maxToolCalls:budget.maxToolCalls,maxWallTimeMs:budget.maxWallTimeMs}});
  try{for(;;){
    throwIfAborted(turnSignal);
    applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_model"});
    if(modelTurns>=budget.maxModelTurns){
      const error=new Error(`Native agent model-turn budget exhausted (${modelTurns}/${budget.maxModelTurns}).`);error.code="native_model_turn_budget";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
    }
    modelTurns++;
    const requestStarted=nowMs();
    emit(onEvent,{name:"native.model.requested",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,messageCount:conversation.length,toolCount:Array.isArray(tools)?tools.length:0}});
    const providerAttempts=boundedInteger(maxProviderAttempts,3,{min:1,max:8});let response=null;
    for(let attempt=1;attempt<=providerAttempts;attempt++){
      try{
        response=await providerTurn({model,provider,messages:conversation,tools,toolChoice,maxOutputTokens,temperature,parallelToolCalls,signal:turnSignal});break;
      }catch(error){
        if(error?.nativeSteered){
          if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"model_request_interrupted"})){
            modelTurns=Math.max(0,modelTurns-1);
            emit(onEvent,{name:"native.model.interrupted",status:"steered",model:String(model),provider:provider||null,data:{attempt,reason:"steering"}});
            response=null;break;
          }
          throw error;
        }
        if(turnSignal?.aborted||error?.name==="AbortError")throw abortError(turnSignal);
        const retryable=nativeProviderRetryable(error),last=attempt>=providerAttempts;
        if(!retryable||last)throw error;
        const delay=Math.max(0,Math.min(10_000,Math.trunc(Number(retryBaseDelayMs)||0)*2**(attempt-1)));
        emit(onEvent,{name:"native.model.retrying",status:"retrying",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,attempt,nextAttempt:attempt+1,maxAttempts:providerAttempts,delayMs:delay,status:Number(error.status||error.statusCode||0)||null,code:error.code||null,message:String(error.message||error).slice(0,500)}});
        await retryDelay(delay,turnSignal);
      }
    }
    if(response==null)continue;
    throwIfAborted(turnSignal);lastResponse=response||{};usage=aggregateUsage(usage,lastResponse.usage||{});
    const calls=Array.isArray(lastResponse.toolCalls)?lastResponse.toolCalls:[];
    emit(onEvent,{name:"native.model.completed",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,durationMs:duration(requestStarted),toolCallCount:calls.length,finishReason:lastResponse.finishReason||null,usage:lastResponse.usage||null}});
    if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_model"}))continue;
    conversation.push({role:"assistant",content:String(lastResponse.text||""),toolCalls:calls});
    if(!calls.length){
      if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_completion"}))continue;
      const result={
        text:String(lastResponse.text||""),model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,
        messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse,
      };
      emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage}});
      return result;
    }
    let redirected=false;
    for(let callIndex=0;callIndex<calls.length;callIndex++){
      const call=calls[callIndex];
      throwIfAborted(turnSignal);
      const steerNow=steeringMessages(consumeSteering);
      if(steerNow.length){
        for(const skipped of calls.slice(callIndex)){
          const skippedId=String(skipped?.id||"");
          conversation.push({role:"tool",toolCallId:skippedId,content:"Tool call cancelled before execution because the user steered the active turn."});
          emit(onEvent,{name:"native.tool.skipped",status:"skipped",model:String(model),provider:provider||null,data:{callId:skippedId,namespace:skipped?.namespace||null,name:skipped?.name||"tool",reason:"steering"}});
        }
        conversation.push(...steerNow);
        emit(onEvent,{name:"native.steering.applied",status:"completed",model:String(model||""),provider:provider||null,data:{stage:"before_tool",messageCount:steerNow.length,modelTurn:modelTurns,toolCalls,skippedToolCalls:calls.length-callIndex}});
        redirected=true;break;
      }
      if(toolCalls>=budget.maxToolCalls){
        const error=new Error(`Native agent tool-call budget exhausted (${toolCalls}/${budget.maxToolCalls}).`);error.code="native_tool_call_budget";
        emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
      }
      toolCalls++;
      const callId=String(call?.id||`native-tool-${toolCalls}`),namespace=call?.namespace?String(call.namespace):null,name=String(call?.name||"tool"),args=safeArguments(call?.arguments);
      const toolStarted=nowMs();
      emit(onEvent,{name:"native.tool.requested",status:"running",model:String(model),provider:provider||null,data:{toolCall:toolCalls,callId,namespace,name}});
      let output,success=true,errorMessage=null;
      try{
        output=await executeTool({id:callId,namespace,name,arguments:args,rawArguments:call?.arguments??"{}",signal:turnSignal,modelTurn:modelTurns,toolCall:toolCalls});
        throwIfAborted(turnSignal);
        if(output?.success===false){success=false;errorMessage=String(output.error||output.message||"Tool execution failed.")}
      }catch(error){
        if(turnSignal?.aborted||error?.name==="AbortError")throw abortError(turnSignal);
        success=false;errorMessage=error?.message||String(error);output={success:false,error:errorMessage};
      }
      const content=resultContent(output)||(!success?errorMessage||"Tool execution failed.":"Tool completed without text output.");
      emit(onEvent,{name:"native.tool.completed",status:success?"completed":"failed",model:String(model),provider:provider||null,data:{toolCall:toolCalls,callId,namespace,name,durationMs:duration(toolStarted),success,error:errorMessage}});
      conversation.push({role:"tool",toolCallId:callId,content});
    }
    if(redirected)continue;
  }}catch(caught){
    let error=caught;
    if(wallController?.signal.aborted&&!signal?.aborted){
      error=new Error(`Native agent wall-time budget exhausted (${budget.maxWallTimeMs}ms).`);error.code="native_wall_time_budget";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls,maxWallTimeMs:budget.maxWallTimeMs}});
    }
    if(error&&typeof error==="object"){
      error.nativeUsage={...usage};error.nativeModelTurns=modelTurns;error.nativeToolCalls=toolCalls;
    }
    throw error;
  }finally{if(wallTimer)clearTimeout(wallTimer)}
}
