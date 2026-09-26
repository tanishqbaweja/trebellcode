function textContent(content){
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return "";
  return content.map(part=>{
    if(typeof part==="string")return part;
    if(["text","input_text","output_text"].includes(part?.type)&&typeof part.text==="string")return part.text;
    return "";
  }).join("");
}

function jsonArguments(value){
  if(typeof value==="string")return value||"{}";
  try{return JSON.stringify(value??{})}catch{return "{}"}
}

function splitToolName(value){
  const raw=String(value||"tool"),marker=raw.indexOf("__");
  if(marker<=0||marker>=raw.length-2)return {namespace:null,name:raw};
  return {namespace:raw.slice(0,marker),name:raw.slice(marker+2)};
}

function flatToolName(namespace,name){return namespace?String(namespace)+"__"+String(name||"tool"):String(name||"tool")}

function normalizeToolCall(call={}){
  const source=call.function||call,split=splitToolName(source.name||call.name||"tool"),namespace=call.namespace||split.namespace;
  return {
    id:String(call.id||call.call_id||""),
    namespace:namespace?String(namespace):null,
    name:String(call.name||split.name||"tool"),
    arguments:jsonArguments(source.arguments??call.arguments??{}),
  };
}

function normalizeUsage(value={}){
  const inputTokens=Number(value.input_tokens??value.prompt_tokens??0)||0,outputTokens=Number(value.output_tokens??value.completion_tokens??0)||0;
  const cachedInputTokens=Number(value.input_tokens_details?.cached_tokens??value.prompt_tokens_details?.cached_tokens??value.cache_read_input_tokens??0)||0;
  const cacheWriteInputTokens=Number(value.cache_creation_input_tokens??0)||0;
  const reasoningOutputTokens=Number(value.output_tokens_details?.reasoning_tokens??value.completion_tokens_details?.reasoning_tokens??value.reasoning_tokens??0)||0;
  return {inputTokens,outputTokens,totalTokens:Number(value.total_tokens??inputTokens+outputTokens)||inputTokens+outputTokens,cachedInputTokens,cacheWriteInputTokens,reasoningOutputTokens};
}

function openAiContent(content){
  if(typeof content==="string"||content==null)return content??"";
  if(!Array.isArray(content))return String(content);
  return content.map(part=>{
    if(typeof part==="string")return {type:"text",text:part};
    if(["text","input_text","output_text"].includes(part?.type))return {type:"text",text:String(part.text||"")};
    if(part?.type==="input_image"&&part.image_url)return {type:"image_url",image_url:{url:String(part.image_url)}};
    if(part?.type==="image_url")return part;
    return null;
  }).filter(Boolean);
}

function toolDefinitionsToChat(tools=[]){
  const out=[];
  for(const entry of Array.isArray(tools)?tools:[]){
    if(entry?.type==="function"){
      const name=entry.function?.name||entry.name;if(!name)continue;
      out.push({type:"function",function:{name:String(name),description:entry.function?.description||entry.description||"",parameters:entry.function?.parameters||entry.parameters||entry.inputSchema||{type:"object",properties:{}}}});
      continue;
    }
    if(entry?.type!=="namespace"||!entry.name||!Array.isArray(entry.tools))continue;
    for(const child of entry.tools){
      if(!child?.name)continue;
      out.push({type:"function",function:{name:flatToolName(entry.name,child.name),description:child.description||entry.description||"",parameters:child.parameters||child.inputSchema||{type:"object",properties:{}}}});
    }
  }
  return out;
}

export function providerTurnToChat({model,messages=[],tools=[],toolChoice="auto",maxOutputTokens=null,temperature=null,parallelToolCalls=true}={}){
  const chatMessages=[];
  for(const message of Array.isArray(messages)?messages:[]){
    if(!message||typeof message!=="object")continue;
    if(message.role==="tool"){
      chatMessages.push({role:"tool",tool_call_id:String(message.toolCallId||message.tool_call_id||""),content:openAiContent(message.content)});continue;
    }
    if(message.role==="assistant"){
      const calls=(message.toolCalls||message.tool_calls||[]).map(call=>{
        const normalized=normalizeToolCall(call);
        return {id:normalized.id||undefined,type:"function",function:{name:flatToolName(normalized.namespace,normalized.name),arguments:normalized.arguments}};
      });
      chatMessages.push({role:"assistant",content:openAiContent(message.content),...(calls.length?{tool_calls:calls}:{})});continue;
    }
    if(["system","developer","user"].includes(message.role))chatMessages.push({role:message.role,content:openAiContent(message.content)});
  }
  const result={model:String(model||""),messages:chatMessages,stream:false,parallel_tool_calls:Boolean(parallelToolCalls)};
  const chatTools=toolDefinitionsToChat(tools);if(chatTools.length)result.tools=chatTools;
  if(toolChoice&&chatTools.length){
    if(typeof toolChoice==="string")result.tool_choice=toolChoice;
    else if(toolChoice.name)result.tool_choice={type:"function",function:{name:flatToolName(toolChoice.namespace,toolChoice.name)}};
    else result.tool_choice=toolChoice;
  }
  if(Number.isFinite(Number(maxOutputTokens)))result.max_tokens=Math.max(1,Math.trunc(Number(maxOutputTokens)));
  if(Number.isFinite(Number(temperature)))result.temperature=Number(temperature);
  return result;
}

function responsesContent(content,{assistant=false}={}){
  if(typeof content==="string")return content?[{type:assistant?"output_text":"input_text",text:content}]:[];
  if(!Array.isArray(content))return [];
  const out=[];
  for(const part of content){
    if(typeof part==="string"){if(part)out.push({type:assistant?"output_text":"input_text",text:part});continue}
    if(["text","input_text","output_text"].includes(part?.type)&&part.text)out.push({type:assistant?"output_text":"input_text",text:String(part.text)});
    else if(!assistant&&part?.type==="image_url"&&part.image_url?.url)out.push({type:"input_image",image_url:String(part.image_url.url)});
    else if(!assistant&&part?.type==="input_image"&&part.image_url)out.push({type:"input_image",image_url:String(part.image_url)});
  }
  return out;
}

export function providerTurnToResponses({model,messages=[],tools=[],toolChoice="auto",maxOutputTokens=null,temperature=null,parallelToolCalls=true}={}){
  const instructions=[],input=[];
  for(const message of Array.isArray(messages)?messages:[]){
    if(!message||typeof message!=="object")continue;
    if(message.role==="system"||message.role==="developer"){
      const text=textContent(message.content).trim();if(text)instructions.push(text);continue;
    }
    if(message.role==="tool"){
      const output=typeof message.content==="string"?message.content:responsesContent(message.content);
      input.push({type:"function_call_output",call_id:String(message.toolCallId||message.tool_call_id||""),output});continue;
    }
    if(message.role==="assistant"){
      const content=responsesContent(message.content,{assistant:true});if(content.length)input.push({type:"message",role:"assistant",content});
      for(const call of message.toolCalls||message.tool_calls||[]){
        const normalized=normalizeToolCall(call);
        input.push({type:"function_call",call_id:normalized.id||undefined,...(normalized.namespace?{namespace:normalized.namespace}:{}),name:normalized.name,arguments:normalized.arguments});
      }
      continue;
    }
    if(message.role==="user")input.push({type:"message",role:"user",content:responsesContent(message.content)});
  }
  const result={model:String(model||""),input,tools:Array.isArray(tools)?tools:[],stream:false,parallel_tool_calls:Boolean(parallelToolCalls)};
  if(instructions.length)result.instructions=instructions.join("\n\n");
  if(toolChoice&&result.tools.length){
    if(typeof toolChoice==="string")result.tool_choice=toolChoice;
    else if(toolChoice.name)result.tool_choice={type:"function",name:flatToolName(toolChoice.namespace,toolChoice.name)};
    else result.tool_choice=toolChoice;
  }
  if(Number.isFinite(Number(maxOutputTokens)))result.max_output_tokens=Math.max(1,Math.trunc(Number(maxOutputTokens)));
  if(Number.isFinite(Number(temperature)))result.temperature=Number(temperature);
  return result;
}

export function normalizeChatTurnResponse(body={},provider=null,fallbackModel=""){
  const choice=body?.choices?.[0]||{},message=choice.message||{},toolCalls=(message.tool_calls||[]).filter(call=>call?.type==="function").map(normalizeToolCall);
  return {
    id:String(body.id||""),provider:provider?String(provider):null,model:String(body.model||fallbackModel||""),text:textContent(message.content),toolCalls,
    finishReason:String(choice.finish_reason||"")||null,status:"completed",usage:normalizeUsage(body.usage||{}),raw:body,
  };
}

export function normalizeResponsesTurnResponse(body={},provider=null,fallbackModel=""){
  const text=[],toolCalls=[];
  for(const item of Array.isArray(body.output)?body.output:[]){
    if(item?.type==="message"){
      for(const part of Array.isArray(item.content)?item.content:[])if(part?.type==="output_text"&&typeof part.text==="string")text.push(part.text);
    }else if(item?.type==="function_call")toolCalls.push(normalizeToolCall(item));
  }
  return {
    id:String(body.id||""),provider:provider?String(provider):null,model:String(body.model||fallbackModel||""),text:text.join(""),toolCalls,
    finishReason:toolCalls.length?"tool_calls":String(body.status||"completed"),status:String(body.status||"completed"),usage:normalizeUsage(body.usage||{}),raw:body,
  };
}
