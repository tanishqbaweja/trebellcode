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

function normalizedServiceTier(value){
  const tier=String(value??"").trim().toLowerCase();
  if(!tier)return null;
  return tier==="priority"?"fast":tier;
}

function normalizedAllowedToolChoice(value,{chat=false}={}){
  if(String(value?.type||"").trim().toLowerCase()!=="allowed_tools")return null;
  const mode=String(value?.mode||value?.allowed_tools?.mode||"auto").trim().toLowerCase()==="required"?"required":"auto";
  const source=Array.isArray(value?.tools)?value.tools:Array.isArray(value?.allowed_tools?.tools)?value.allowed_tools.tools:[];
  const tools=[];
  for(const item of source){
    if(!item||typeof item!=="object")continue;
    const fn=item.function&&typeof item.function==="object"?item.function:item;
    const split=splitToolName(fn.name||item.name||""),namespace=item.namespace||fn.namespace||split.namespace,name=split.name;
    if(!name)continue;
    const flat=flatToolName(namespace,name);
    tools.push(chat?{type:"function",function:{name:flat}}:{type:"function",name:flat});
  }
  if(!tools.length)return null;
  return chat?{type:"allowed_tools",allowed_tools:{mode,tools}}:{type:"allowed_tools",mode,tools};
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
    // Responses function_call items have both an item id ("fc_...") and a
    // continuation call_id ("call_..."). Tool outputs must reference call_id;
    // using the item id makes previous_response_id continuation fail with
    // "No tool output found for function call ...". Chat tool calls normally
    // expose only id, so the fallback preserves Chat compatibility.
    id:String(call.call_id||call.id||""),
    namespace:namespace?String(namespace):null,
    name:String(split.name||call.name||"tool"),
    arguments:jsonArguments(source.arguments??call.arguments??{}),
  };
}

function normalizeUsage(value={}){
  const inputTokens=Number(value.input_tokens??value.prompt_tokens??0)||0,outputTokens=Number(value.output_tokens??value.completion_tokens??0)||0;
  const cachedInputTokens=Number(value.input_tokens_details?.cached_tokens??value.prompt_tokens_details?.cached_tokens??value.cache_read_input_tokens??0)||0;
  const cacheWriteInputTokens=Number(value.input_tokens_details?.cache_write_tokens??value.prompt_tokens_details?.cache_write_tokens??value.cache_creation_input_tokens??0)||0;
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

export const NATIVE_CHAT_MESSAGE_CACHE_IDENTITY=Symbol.for("trebell.native.chat-message-cache-identity");
// The reasoning a Responses turn returned (its reasoningItems), kept on the reply the agent loop puts on the transcript so that
// an input rebuilt in full can carry it again (providerTurnToResponses' reasoningReplay). A symbol, so no transcript JSON holds it.
export const NATIVE_RESPONSES_REASONING=Symbol.for("trebell.native.responses-reasoning");

export function keepResponsesReasoning(message,response){
  const items=response?.reasoningItems;
  if(message&&typeof message==="object"&&Array.isArray(items)&&items.length)message[NATIVE_RESPONSES_REASONING]=items;
  return message;
}

// A later turn never carries a turn's reasoning again (reasoning.context=current_turn), so a history that outlives the turn drops it.
export function dropResponsesReasoning(messages=[]){
  for(const message of Array.isArray(messages)?messages:[])if(message&&typeof message==="object"&&Object.hasOwn(message,NATIVE_RESPONSES_REASONING))delete message[NATIVE_RESPONSES_REASONING];
  return messages;
}

// The turn a request continues: the messages after the last user message or the last reply without tool calls. Under
// reasoning.context=current_turn the server keeps reasoning back to the last user message only, and a reply without tool calls
// ends a turn there too (a gate's developer message after one saw none of the reasoning before it).
function currentTurnStart(messages){
  for(let index=messages.length-1;index>=0;index--){
    const message=messages[index];
    if(message?.role==="user"||(message?.role==="assistant"&&!(message.toolCalls||message.tool_calls||[]).length))return index+1;
  }
  return 0;
}

// Whether an input rebuilt with reasoningReplay would carry any kept reasoning.
export function responsesReasoningToReplay(messages=[]){
  const source=Array.isArray(messages)?messages:[];
  for(let index=currentTurnStart(source);index<source.length;index++){const kept=source[index]?.[NATIVE_RESPONSES_REASONING];if(Array.isArray(kept)&&kept.length)return true}
  return false;
}

// A kept reasoning item goes back without its id, as the reply text and function calls beside it go without theirs.
function replayReasoning(input,kept,matches){
  for(const entry of kept)if(matches(entry)&&typeof entry?.item?.encrypted_content==="string")input.push({type:"reasoning",summary:Array.isArray(entry.item.summary)?entry.item.summary:[],encrypted_content:entry.item.encrypted_content});
}

function chatMessage(message={}){
  if(!message||typeof message!=="object")return null;
  if(message.role==="tool")return {role:"tool",tool_call_id:String(message.toolCallId||message.tool_call_id||""),content:openAiContent(message.content)};
  if(message.role==="assistant"){
    const calls=(message.toolCalls||message.tool_calls||[]).map(call=>{
      const normalized=normalizeToolCall(call);
      return {id:normalized.id||undefined,type:"function",function:{name:flatToolName(normalized.namespace,normalized.name),arguments:normalized.arguments}};
    });
    return {role:"assistant",content:openAiContent(message.content),...(calls.length?{tool_calls:calls}:{})};
  }
  if(["system","developer","user"].includes(message.role))return {role:message.role,content:openAiContent(message.content)};
  return null;
}

function compactChatToolSchemaValue(value){
  if(Array.isArray(value))return value.map(compactChatToolSchemaValue);
  if(!value||typeof value!=="object")return value;
  const out={};
  for(const [key,child] of Object.entries(value)){
    if(key==="maximum"&&child===Number.MAX_SAFE_INTEGER)continue;
    out[key]=compactChatToolSchemaValue(child);
  }
  return out;
}

function compactChatToolSchema(value){
  const schema=compactChatToolSchemaValue(value);
  if(schema&&typeof schema==="object"&&!Array.isArray(schema)&&schema.additionalProperties===false)delete schema.additionalProperties;
  return schema;
}

export function providerToolsToChat(tools=[]){
  const out=[];
  for(const entry of Array.isArray(tools)?tools:[]){
    if(entry?.type==="function"){
      const name=entry.function?.name||entry.name;if(!name)continue;
      out.push({type:"function",function:{name:String(name),description:entry.function?.description||entry.description||"",parameters:compactChatToolSchema(entry.function?.parameters||entry.parameters||entry.inputSchema||{type:"object",properties:{}})}});
      continue;
    }
    if(entry?.type!=="namespace"||!entry.name||!Array.isArray(entry.tools))continue;
    for(const child of entry.tools){
      if(!child?.name)continue;
      out.push({type:"function",function:{name:flatToolName(entry.name,child.name),description:child.description||entry.description||"",parameters:compactChatToolSchema(child.parameters||child.inputSchema||{type:"object",properties:{}})}});
    }
  }
  return out;
}

function normalizedResponseJsonSchema(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const name=String(value.name||"").trim(),schema=value.schema;
  if(!name||!schema||typeof schema!=="object"||Array.isArray(schema))return null;
  return {name,schema,strict:value.strict!==false};
}

export function providerTurnToChat({model,messages=[],tools=[],toolChoice="auto",maxOutputTokens=null,temperature=null,reasoningEffort=null,serviceTier=null,parallelToolCalls=true,responseJsonSchema=null}={}, {preparedTools=null,messageCache=null}={}){
  const chatMessages=[];
  for(const message of Array.isArray(messages)?messages:[]){
    if(!message||typeof message!=="object")continue;
    let converted=messageCache&&typeof messageCache.get==="function"?messageCache.get(message):null;
    if(!converted){converted=chatMessage(message);if(converted&&messageCache&&typeof messageCache.set==="function")messageCache.set(message,converted)}
    if(converted)chatMessages.push(converted);
  }
  const result={model:String(model||""),messages:chatMessages,stream:false,parallel_tool_calls:Boolean(parallelToolCalls)};
  const chatTools=Array.isArray(preparedTools)?preparedTools:providerToolsToChat(tools);if(chatTools.length)result.tools=chatTools;
  if(toolChoice&&chatTools.length){
    const allowed=normalizedAllowedToolChoice(toolChoice,{chat:true});
    if(allowed)result.tool_choice=allowed;
    else if(typeof toolChoice==="string")result.tool_choice=toolChoice;
    else if(toolChoice.name)result.tool_choice={type:"function",function:{name:flatToolName(toolChoice.namespace,toolChoice.name)}};
    else result.tool_choice=toolChoice;
  }
  if(maxOutputTokens!=null&&Number.isFinite(Number(maxOutputTokens)))result.max_tokens=Math.max(1,Math.trunc(Number(maxOutputTokens)));
  if(temperature!=null&&Number.isFinite(Number(temperature)))result.temperature=Number(temperature);
  if(reasoningEffort!=null&&String(reasoningEffort).trim())result.reasoning_effort=String(reasoningEffort).trim();
  const structured=normalizedResponseJsonSchema(responseJsonSchema);
  if(structured)result.response_format={type:"json_schema",json_schema:{name:structured.name,strict:structured.strict,schema:structured.schema}};
  const normalizedTier=normalizedServiceTier(serviceTier);if(normalizedTier)result.service_tier=normalizedTier;
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

function responseToolOutput(content,{cacheBreakpoint=false}={}){
  let output=typeof content==="string"?content:responsesContent(content);
  if(cacheBreakpoint!==true)return output;
  if(typeof output==="string"){
    if(!output.length)return output;
    return [{type:"input_text",text:output,prompt_cache_breakpoint:{mode:"explicit"}}];
  }
  if(!Array.isArray(output))return output;
  for(let index=output.length-1;index>=0;index--){
    if(output[index]?.type!=="input_text")continue;
    output[index]={...output[index],prompt_cache_breakpoint:{mode:"explicit"}};break;
  }
  return output;
}

// reasoningReplay: the input is sent without previous_response_id, so the server no longer holds the current turn's reasoning
// for it. Each reasoning item a reply of that turn kept (NATIVE_RESPONSES_REASONING) goes back right before the reply text or
// function call it came before, in the order it came; one whose item the reply does not hold is left out.
export function providerTurnToResponses({model,messages=[],tools=[],toolChoice="auto",maxOutputTokens=null,temperature=null,reasoningEffort=null,reasoningContext=null,serviceTier=null,parallelToolCalls=true,responseJsonSchema=null,textVerbosity=null}={}, {preserveInstructionOrder=false,flattenToolCallNames=false,toolResultCacheBreakpoints=false,inputStartMessageIndex=0,reasoningReplay=false}={}){
  const instructions=[],input=[];let instructionPrefixOpen=true;
  const sourceMessages=Array.isArray(messages)?messages:[],inputStart=Math.max(0,Math.trunc(Number(inputStartMessageIndex)||0)),replayFrom=reasoningReplay?currentTurnStart(sourceMessages):sourceMessages.length;
  for(let messageIndex=0;messageIndex<sourceMessages.length;messageIndex++){
    const message=sourceMessages[messageIndex];
    if(!message||typeof message!=="object")continue;
    if(message.role==="system"||message.role==="developer"){
      const text=textContent(message.content).trim();
      if(!preserveInstructionOrder||(instructionPrefixOpen&&message?.trebellCompaction!==true)){
        if(text)instructions.push(text);continue;
      }
      instructionPrefixOpen=false;
      if(messageIndex<inputStart)continue;
      const content=responsesContent(message.content);if(content.length)input.push({type:"message",role:message.role,content});continue;
    }
    if(preserveInstructionOrder)instructionPrefixOpen=false;
    if(messageIndex<inputStart)continue;
    if(message.role==="tool"){
      const output=responseToolOutput(message.content,{cacheBreakpoint:toolResultCacheBreakpoints});
      input.push({type:"function_call_output",call_id:String(message.toolCallId||message.tool_call_id||""),output});continue;
    }
    if(message.role==="assistant"){
      const kept=messageIndex>=replayFrom&&Array.isArray(message[NATIVE_RESPONSES_REASONING])?message[NATIVE_RESPONSES_REASONING]:null;
      const content=responsesContent(message.content,{assistant:true});
      if(content.length){if(kept)replayReasoning(input,kept,entry=>entry?.before==="message");input.push({type:"message",role:"assistant",content})}
      for(const call of message.toolCalls||message.tool_calls||[]){
        const normalized=normalizeToolCall(call);
        if(kept&&normalized.id)replayReasoning(input,kept,entry=>entry?.before==="function_call"&&entry.callId===normalized.id);
        input.push({type:"function_call",call_id:normalized.id||undefined,...(!flattenToolCallNames&&normalized.namespace?{namespace:normalized.namespace}:{}),name:flattenToolCallNames?flatToolName(normalized.namespace,normalized.name):normalized.name,arguments:normalized.arguments});
      }
      continue;
    }
    if(message.role==="user")input.push({type:"message",role:"user",content:responsesContent(message.content)});
  }
  const result={model:String(model||""),input,tools:Array.isArray(tools)?tools:[],stream:false,parallel_tool_calls:Boolean(parallelToolCalls)};
  if(instructions.length)result.instructions=instructions.join("\n\n");
  if(toolChoice&&result.tools.length){
    const allowed=normalizedAllowedToolChoice(toolChoice);
    if(allowed)result.tool_choice=allowed;
    else if(typeof toolChoice==="string")result.tool_choice=toolChoice;
    else if(toolChoice.name)result.tool_choice={type:"function",name:flatToolName(toolChoice.namespace,toolChoice.name)};
    else result.tool_choice=toolChoice;
  }
  if(maxOutputTokens!=null&&Number.isFinite(Number(maxOutputTokens)))result.max_output_tokens=Math.max(1,Math.trunc(Number(maxOutputTokens)));
  if(temperature!=null&&Number.isFinite(Number(temperature)))result.temperature=Number(temperature);
  const reasoning={};
  if(reasoningEffort!=null&&String(reasoningEffort).trim())reasoning.effort=String(reasoningEffort).trim();
  const normalizedReasoningContext=String(reasoningContext||"").trim().toLowerCase();
  if(["auto","current_turn","all_turns"].includes(normalizedReasoningContext))reasoning.context=normalizedReasoningContext;
  if(Object.keys(reasoning).length)result.reasoning=reasoning;
  const structured=normalizedResponseJsonSchema(responseJsonSchema);
  if(structured)result.text={format:{type:"json_schema",name:structured.name,strict:structured.strict,schema:structured.schema}};
  const verbosity=String(textVerbosity||"").trim().toLowerCase();
  if(["low","medium","high"].includes(verbosity))result.text={...(result.text||{}),verbosity};
  const normalizedTier=normalizedServiceTier(serviceTier);if(normalizedTier)result.service_tier=normalizedTier;
  return result;
}

export function normalizeChatTurnResponse(body={},provider=null,fallbackModel=""){
  const choice=body?.choices?.[0]||{},message=choice.message||{},toolCalls=(message.tool_calls||[]).filter(call=>call?.type==="function").map(normalizeToolCall);
  return {
    id:String(body.id||""),provider:provider?String(provider):null,model:String(body.model||fallbackModel||""),text:textContent(message.content),toolCalls,
    serviceTier:normalizedServiceTier(body.service_tier??body.serviceTier),finishReason:String(choice.finish_reason||"")||null,status:"completed",usage:normalizeUsage(body.usage||{}),raw:body,
  };
}

// A Responses output item that carries the server-side compaction of the context (context_management): an opaque
// encrypted_content that stands for everything the request held. "compaction_summary" is its older name.
export function responsesCompactionItem(item){
  return (item?.type==="compaction"||item?.type==="compaction_summary")&&typeof item.encrypted_content==="string"&&item.encrypted_content.length>0;
}

// A response's reasoning output items that carry their encrypted_content (asked for with include), as the API returns them, each
// with the output item it came right before: the reply text ("message") or a function call (its call_id). Requests over the
// WebSocket go with store:false, so only these can be sent back once the server no longer holds the response, and one that came
// before nothing has no place in a rebuilt input.
function responsesReasoningItems(output){
  const kept=[];let pending=[];
  for(const item of Array.isArray(output)?output:[]){
    if(item?.type==="reasoning"){
      if(typeof item.encrypted_content==="string"&&item.encrypted_content)pending.push({type:"reasoning",...(item.id?{id:String(item.id)}:{}),summary:Array.isArray(item.summary)?item.summary:[],encrypted_content:item.encrypted_content});
      continue;
    }
    const before=item?.type==="message"?{before:"message"}:item?.type==="function_call"?{before:"function_call",callId:String(item.call_id||item.id||"")}:null;
    if(before)for(const reasoning of pending)kept.push({...before,item:reasoning});
    pending=[];
  }
  return kept;
}

export function normalizeResponsesTurnResponse(body={},provider=null,fallbackModel=""){
  const text=[],toolCalls=[];let compactions=0;
  for(const item of Array.isArray(body.output)?body.output:[]){
    if(item?.type==="message"){
      for(const part of Array.isArray(item.content)?item.content:[])if(part?.type==="output_text"&&typeof part.text==="string")text.push(part.text);
    }else if(item?.type==="function_call")toolCalls.push(normalizeToolCall(item));
    else if(responsesCompactionItem(item))compactions++;
  }
  const reasoningItems=responsesReasoningItems(body.output);
  return {
    id:String(body.id||""),provider:provider?String(provider):null,model:String(body.model||fallbackModel||""),text:text.join(""),toolCalls,
    serviceTier:normalizedServiceTier(body.service_tier??body.serviceTier),finishReason:toolCalls.length?"tool_calls":String(body.status||"completed"),status:String(body.status||"completed"),usage:normalizeUsage(body.usage||{}),
    // Only present when the server compacted the context during this response.
    ...(compactions?{serverCompaction:{items:compactions}}:{}),
    // Only present when the response returned reasoning that can be sent back.
    ...(reasoningItems.length?{reasoningItems}:{}),
    raw:body,
  };
}
