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

export function nativeAgentBudget(options={}){
  return {
    maxModelTurns:boundedInteger(options.maxModelTurns,24,{min:1,max:500}),
    maxToolCalls:boundedInteger(options.maxToolCalls,100,{min:0,max:5000}),
  };
}

export async function runNativeAgentTurn({
  providerTurn,executeTool,model,messages=[],tools=[],provider=null,toolChoice="auto",
  maxOutputTokens=null,temperature=null,parallelToolCalls=true,maxModelTurns=24,maxToolCalls=100,
  signal=null,onEvent=null,metadata=null,
}={}){
  if(typeof providerTurn!=="function")throw new Error("Native agent loop requires a providerTurn function.");
  if(typeof executeTool!=="function")throw new Error("Native agent loop requires an executeTool function.");
  if(!String(model||"").trim())throw new Error("Native agent loop requires a model.");
  const budget=nativeAgentBudget({maxModelTurns,maxToolCalls}),conversation=[...(Array.isArray(messages)?messages:[])];
  let modelTurns=0,toolCalls=0,usage={inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0},lastResponse=null;
  const startedAt=Date.now(),started=nowMs();
  emit(onEvent,{name:"native.turn.started",status:"running",model:String(model),provider:provider||null,data:{...metadata,maxModelTurns:budget.maxModelTurns,maxToolCalls:budget.maxToolCalls}});
  for(;;){
    throwIfAborted(signal);
    if(modelTurns>=budget.maxModelTurns){
      const error=new Error(`Native agent model-turn budget exhausted (${modelTurns}/${budget.maxModelTurns}).`);error.code="native_model_turn_budget";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
    }
    modelTurns++;
    const requestStarted=nowMs();
    emit(onEvent,{name:"native.model.requested",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,messageCount:conversation.length,toolCount:Array.isArray(tools)?tools.length:0}});
    const response=await providerTurn({model,provider,messages:conversation,tools,toolChoice,maxOutputTokens,temperature,parallelToolCalls,signal});
    throwIfAborted(signal);lastResponse=response||{};usage=aggregateUsage(usage,lastResponse.usage||{});
    const calls=Array.isArray(lastResponse.toolCalls)?lastResponse.toolCalls:[];
    emit(onEvent,{name:"native.model.completed",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,durationMs:duration(requestStarted),toolCallCount:calls.length,finishReason:lastResponse.finishReason||null,usage:lastResponse.usage||null}});
    conversation.push({role:"assistant",content:String(lastResponse.text||""),toolCalls:calls});
    if(!calls.length){
      const result={
        text:String(lastResponse.text||""),model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,
        messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse,
      };
      emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage}});
      return result;
    }
    for(const call of calls){
      throwIfAborted(signal);
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
        output=await executeTool({id:callId,namespace,name,arguments:args,rawArguments:call?.arguments??"{}",signal,modelTurn:modelTurns,toolCall:toolCalls});
        throwIfAborted(signal);
        if(output?.success===false){success=false;errorMessage=String(output.error||output.message||"Tool execution failed.")}
      }catch(error){
        if(signal?.aborted||error?.name==="AbortError")throw abortError(signal);
        success=false;errorMessage=error?.message||String(error);output={success:false,error:errorMessage};
      }
      const content=resultContent(output)||(!success?errorMessage||"Tool execution failed.":"Tool completed without text output.");
      emit(onEvent,{name:"native.tool.completed",status:success?"completed":"failed",model:String(model),provider:provider||null,data:{toolCall:toolCalls,callId,namespace,name,durationMs:duration(toolStarted),success,error:errorMessage}});
      conversation.push({role:"tool",toolCallId:callId,content});
    }
  }
}
