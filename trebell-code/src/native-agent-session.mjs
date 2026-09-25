import { randomUUID } from "node:crypto";
import { runNativeAgentTurn } from "./native-agent-loop.mjs";
import { platformToolDefinition } from "./platform-tool-catalog.mjs";

function itemText(content=[]){
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return "";
  return content.map(item=>item?.type==="text"?item.text||"":item?.type==="inputText"?item.text||"":"").join("");
}

function toolOutput(item={}){
  if(Array.isArray(item.contentItems)){
    const parts=[];let hasImage=false;
    for(const part of item.contentItems){
      if(typeof part==="string")parts.push({type:"text",text:part});
      else if(["inputText","outputText","text"].includes(part?.type)&&typeof part.text==="string")parts.push({type:"text",text:part.text});
      else if((part?.type==="inputImage"||part?.type==="image")&&(part.imageUrl||part.dataUrl)){
        hasImage=true;parts.push({type:"image_url",image_url:{url:String(part.imageUrl||part.dataUrl)}});
      }
    }
    if(parts.length)return hasImage?parts:parts.map(part=>part.text).join("\n");
  }
  if(typeof item.rawOutput==="string")return item.rawOutput;
  if(item.rawOutput!=null){try{return JSON.stringify(item.rawOutput)}catch{}}
  return item.success===false?"Tool execution failed.":"Tool completed.";
}

export function nativeMessagesFromThread(thread={}){
  const messages=[];
  for(const turn of Array.isArray(thread.turns)?thread.turns:[]){
    for(const item of Array.isArray(turn.items)?turn.items:[]){
      if(item?.type==="userMessage"){
        const text=itemText(item.content);if(text)messages.push({role:"user",content:text});
      }else if(item?.type==="dynamicToolCall"&&item.namespace&&item.tool){
        messages.push({role:"assistant",content:"",toolCalls:[{id:String(item.id||randomUUID()),namespace:String(item.namespace),name:String(item.tool),arguments:item.arguments||{}}]});
        messages.push({role:"tool",toolCallId:String(item.id||""),content:toolOutput(item)});
      }else if(item?.type==="agentMessage"&&item.text){
        messages.push({role:"assistant",content:String(item.text)});
      }
    }
  }
  return messages;
}

function promptMessage(prompt=[]){
  const content=[];
  for(const item of Array.isArray(prompt)?prompt:[]){
    if(item?.type==="text"&&item.text)content.push({type:"text",text:String(item.text)});
    else if(item?.type==="image"&&item.data&&item.mimeType)content.push({type:"image_url",image_url:{url:`data:${item.mimeType};base64,${item.data}`}});
    else if(item?.type==="resource_link"&&item.uri)content.push({type:"text",text:`Attached resource: ${item.name||item.uri} (${item.uri})`});
  }
  return {role:"user",content:content.length===1&&content[0].type==="text"?content[0].text:content};
}

function contentItems(value){
  if(Array.isArray(value?.contentItems))return value.contentItems;
  if(typeof value==="string")return [{type:"inputText",text:value}];
  if(value==null)return [];
  try{return [{type:"inputText",text:JSON.stringify(value)}]}catch{return [{type:"inputText",text:String(value)}]}
}

export class NativeAgentSession{
  constructor({cwd=process.cwd(),providerTurn,executeTool,provider=null,model=null,tools=[],permissionMode="supervised",onUpdate=()=>{},onEvent=null,initialMessages=[]}={}){
    if(typeof providerTurn!=="function")throw new Error("NativeAgentSession requires providerTurn");
    if(typeof executeTool!=="function")throw new Error("NativeAgentSession requires executeTool");
    this.cwd=cwd;this.providerTurn=providerTurn;this.executeTool=executeTool;this.provider=provider;this.model=model;this.tools=Array.isArray(tools)?tools:[];this.permissionMode=permissionMode;this.onUpdate=onUpdate;this.onEvent=onEvent;this.messages=[...(Array.isArray(initialMessages)?initialMessages:[])];this.sessionId=null;this.controller=null;this.closed=false;
  }
  async start({providerSessionId=null,model=null}={}){
    if(this.closed)throw new Error("Native session is closed");
    this.sessionId=String(providerSessionId||this.sessionId||`native_${randomUUID()}`);if(model)this.model=model;
    return {initialize:{protocolVersion:1,agentInfo:{name:"Trebell Native",version:"1"},agentCapabilities:{native:true}},session:{sessionId:this.sessionId,models:{currentModelId:this.model||null,availableModels:this.model?[this.model]:[]},modes:{currentModeId:this.permissionMode,availableModes:[]}}};
  }
  setProvider(provider){this.provider=provider?String(provider):null}
  async setModel(model){this.model=String(model||"")||null;return {model:this.model}}
  async prompt(prompt,{messageId=null,maxModelTurns=24,maxToolCalls=100,maxOutputTokens=null}={}){
    if(this.closed)throw new Error("Native session is closed");if(!this.model)throw new Error("Trebell Native requires a model");
    this.controller=new AbortController();const user=promptMessage(prompt),base=[...this.messages,user];
    const wrappedExecutor=async call=>{
      const definition=platformToolDefinition(call.namespace,call.name),kind=definition?.policy?.kind||"other";
      this.onUpdate({update:{sessionUpdate:"tool_call",toolCallId:call.id,namespace:call.namespace||"native",tool:call.name,title:(call.namespace?call.namespace+" / ":"")+call.name,kind,rawInput:call.arguments,status:"in_progress"}});
      const output=await this.executeTool(call);
      const failed=output?.success===false;
      this.onUpdate({update:{sessionUpdate:"tool_call_update",toolCallId:call.id,namespace:call.namespace||"native",tool:call.name,title:(call.namespace?call.namespace+" / ":"")+call.name,kind,rawInput:call.arguments,rawOutput:output,content:contentItems(output),status:failed?"failed":"completed"}});
      return output;
    };
    try{
      const result=await runNativeAgentTurn({
        provider:this.provider,model:this.model,messages:base,tools:this.tools,maxModelTurns,maxToolCalls,maxOutputTokens,signal:this.controller.signal,onEvent:this.onEvent,
        providerTurn:request=>this.providerTurn({...request,provider:this.provider}),executeTool:wrappedExecutor,
      });
      this.messages=result.messages;if(result.text)this.onUpdate({update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:result.text}}});
      this.onUpdate({update:{sessionUpdate:"usage_update",usage:{input_tokens:result.usage.inputTokens,output_tokens:result.usage.outputTokens,cache_read_input_tokens:result.usage.cachedInputTokens,cache_write_input_tokens:result.usage.cacheWriteInputTokens},used:result.usage.totalTokens,size:0}});
      return {stopReason:"end_turn",messageId,providerMessageId:result.lastResponse?.id||null,raw:{usage:result.usage,modelTurns:result.modelTurns,toolCalls:result.toolCalls,provider:result.provider,model:result.model}};
    }catch(error){
      if(error?.nativeUsage){
        const usage=error.nativeUsage;
        this.onUpdate({update:{sessionUpdate:"usage_update",usage:{input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,cache_read_input_tokens:usage.cachedInputTokens,cache_write_input_tokens:usage.cacheWriteInputTokens},used:usage.totalTokens,size:0}});
      }
      if(this.controller.signal.aborted||error?.name==="AbortError")return {stopReason:"cancelled",messageId,raw:{cancelled:true}};
      throw error;
    }finally{this.controller=null}
  }
  cancel(){if(this.controller&&!this.controller.signal.aborted)this.controller.abort()}
  async close(){this.cancel();this.closed=true}
}
