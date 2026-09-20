import { randomUUID } from "node:crypto";

function splitNamespacedTool(name) {
  const raw=String(name||"");
  const marker=raw.indexOf("__");
  if(marker<=0||marker>=raw.length-2)return{name:raw||"tool"};
  return{namespace:raw.slice(0,marker),name:raw.slice(marker+2)};
}

function responsesToolName(tool) {
  if(typeof tool?.namespace==="string"&&tool.namespace&&typeof tool?.name==="string")return `${tool.namespace}__${tool.name}`;
  return typeof tool?.name==="string"?tool.name:"tool";
}

function contentToChat(content) {
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return"";
  const parts=[];
  for(const part of content){
    if(!part||typeof part!=="object")continue;
    if(part.type==="input_text"||part.type==="output_text"||part.type==="text"){
      if(typeof part.text==="string")parts.push({type:"text",text:part.text});
    }else if(part.type==="input_image"&&typeof part.image_url==="string"){
      parts.push({type:"image_url",image_url:{url:part.image_url}});
    }
  }
  if(!parts.length)return"";
  if(parts.every(part=>part.type==="text"))return parts.map(part=>part.text).join("");
  return parts;
}

function toolOutputToString(output) {
  if(typeof output==="string")return output;
  if(Array.isArray(output))return output.map(item=>typeof item==="string"?item:item&&typeof item.text==="string"?item.text:JSON.stringify(item)).join("\n");
  if(output==null)return"";
  return typeof output==="object"?JSON.stringify(output):String(output);
}

export function responsesRequestToChat(body={}) {
  const messages=[];
  if(typeof body.instructions==="string"&&body.instructions.trim())messages.push({role:"system",content:body.instructions});

  for(const item of Array.isArray(body.input)?body.input:[]){
    if(!item||typeof item!=="object")continue;
    if(item.type==="message"){
      messages.push({
        role:item.role==="assistant"?"assistant":item.role==="developer"?"system":"user",
        content:contentToChat(item.content),
      });
    }else if(item.type==="function_call"){
      messages.push({
        role:"assistant",
        content:null,
        tool_calls:[{
          id:item.call_id||item.id||randomUUID(),
          type:"function",
          function:{name:responsesToolName(item),arguments:typeof item.arguments==="string"?item.arguments:JSON.stringify(item.arguments??{})},
        }],
      });
    }else if(item.type==="function_call_output"){
      messages.push({role:"tool",tool_call_id:item.call_id||item.id||"",content:toolOutputToString(item.output)});
    }
  }

  const tools=[];
  for(const tool of Array.isArray(body.tools)?body.tools:[]){
    if(!tool||typeof tool!=="object")continue;
    if(tool.type==="function"){
      tools.push({type:"function",function:{name:tool.name,description:tool.description,parameters:tool.parameters||{}}});
    }else if(tool.type==="namespace"&&Array.isArray(tool.tools)){
      for(const child of tool.tools){
        if(!child||typeof child!=="object")continue;
        tools.push({type:"function",function:{name:`${tool.name}__${child.name}`,description:child.description||tool.description,parameters:child.parameters||child.inputSchema||{}}});
      }
    }
  }

  const chat={model:body.model,messages,stream:body.stream!==false};
  if(tools.length)chat.tools=tools;
  if(body.tool_choice){
    if(typeof body.tool_choice==="string")chat.tool_choice=body.tool_choice;
    else if(body.tool_choice.type==="function"&&body.tool_choice.name)chat.tool_choice={type:"function",function:{name:body.tool_choice.name}};
  }
  if(typeof body.temperature==="number")chat.temperature=body.temperature;
  if(typeof body.top_p==="number")chat.top_p=body.top_p;
  if(typeof body.max_output_tokens==="number")chat.max_tokens=body.max_output_tokens;
  if(typeof body.parallel_tool_calls==="boolean")chat.parallel_tool_calls=body.parallel_tool_calls;
  return chat;
}

function responseUsage(usage) {
  const input=Number(usage?.prompt_tokens??usage?.input_tokens??0)||0;
  const output=Number(usage?.completion_tokens??usage?.output_tokens??0)||0;
  return{
    input_tokens:input,
    input_tokens_details:null,
    output_tokens:output,
    output_tokens_details:null,
    total_tokens:Number(usage?.total_tokens??input+output)||input+output,
  };
}

function responseShell({id,model,status="in_progress",output=[],usage=null}={}){
  return{
    id,
    object:"response",
    created_at:Math.floor(Date.now()/1000),
    status,
    error:null,
    incomplete_details:null,
    instructions:null,
    model:model||"",
    output,
    parallel_tool_calls:true,
    previous_response_id:null,
    reasoning:{effort:null,summary:null},
    store:false,
    temperature:null,
    text:{format:{type:"text"}},
    tool_choice:"auto",
    tools:[],
    top_p:null,
    truncation:"disabled",
    usage,
    metadata:{},
  };
}

function sseEvent(type,value,sequenceNumber){
  return `event: ${type}\ndata: ${JSON.stringify({...value,sequence_number:sequenceNumber})}\n\n`;
}

export function chatCompletionToResponse(body,responseId=`resp_${randomUUID()}`,model="") {
  const choice=body?.choices?.[0]??{};
  const message=choice.message??{};
  const output=[];
  if(typeof message.content==="string"&&message.content){
    output.push({type:"message",role:"assistant",id:`msg_${randomUUID()}`,status:"completed",content:[{type:"output_text",text:message.content,annotations:[]}]});
  }
  for(const call of Array.isArray(message.tool_calls)?message.tool_calls:[]){
    if(call?.type!=="function")continue;
    const split=splitNamespacedTool(call.function?.name||"tool");
    output.push({type:"function_call",id:`fc_${randomUUID()}`,call_id:call.id||`call_${randomUUID()}`,...split,arguments:call.function?.arguments||"{}",status:"completed"});
  }
  return responseShell({id:responseId,model:body?.model||model,status:"completed",output,usage:responseUsage(body?.usage)});
}

function responseObjectToSse(response){
  const encoder=new TextEncoder();
  let seq=0;
  const emit=(controller,type,payload)=>controller.enqueue(encoder.encode(sseEvent(type,{type,...payload},seq++)));
  return new ReadableStream({start(controller){
    const inProgress={...response,status:"in_progress",output:[],usage:null};
    emit(controller,"response.created",{response:inProgress});
    emit(controller,"response.in_progress",{response:inProgress});
    for(let outputIndex=0;outputIndex<(response.output||[]).length;outputIndex++){
      const item=response.output[outputIndex];
      if(item.type==="message"){
        const pending={...item,status:"in_progress",content:[]};
        emit(controller,"response.output_item.added",{output_index:outputIndex,item:pending});
        const text=item.content?.find(part=>part.type==="output_text")?.text||"";
        emit(controller,"response.content_part.added",{item_id:item.id,output_index:outputIndex,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
        if(text)emit(controller,"response.output_text.delta",{item_id:item.id,output_index:outputIndex,content_index:0,delta:text});
        emit(controller,"response.output_text.done",{item_id:item.id,output_index:outputIndex,content_index:0,text});
        emit(controller,"response.content_part.done",{item_id:item.id,output_index:outputIndex,content_index:0,part:{type:"output_text",text,annotations:[]}});
        emit(controller,"response.output_item.done",{output_index:outputIndex,item});
      }else if(item.type==="function_call"){
        const pending={...item,status:"in_progress",arguments:""};
        emit(controller,"response.output_item.added",{output_index:outputIndex,item:pending});
        if(item.arguments)emit(controller,"response.function_call_arguments.delta",{item_id:item.id,output_index:outputIndex,delta:item.arguments});
        emit(controller,"response.function_call_arguments.done",{item_id:item.id,output_index:outputIndex,arguments:item.arguments||"{}"});
        emit(controller,"response.output_item.done",{output_index:outputIndex,item});
      }
    }
    emit(controller,"response.completed",{response});
    controller.close();
  }});
}

export function chatSseToResponsesStream(source,{model=""}={}) {
  const decoder=new TextDecoder();
  const encoder=new TextEncoder();
  const responseId=`resp_${randomUUID()}`;
  const messageId=`msg_${randomUUID()}`;
  let seq=0;
  let buffer="";
  let fullText="";
  let textStarted=false;
  let usage=null;
  const toolCalls=new Map();
  const outputItems=[];

  const emit=(controller,type,payload)=>controller.enqueue(encoder.encode(sseEvent(type,{type,...payload},seq++)));
  const ensureTextStarted=(controller)=>{
    if(textStarted)return;
    textStarted=true;
    emit(controller,"response.output_item.added",{output_index:0,item:{type:"message",role:"assistant",id:messageId,status:"in_progress",content:[]}});
    emit(controller,"response.content_part.added",{item_id:messageId,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
  };
  const ensureToolStarted=(controller,current)=>{
    if(current.started)return;
    current.started=true;
    const split=splitNamespacedTool(current.name||"tool");
    emit(controller,"response.output_item.added",{output_index:current.outputIndex,item:{type:"function_call",id:current.itemId,call_id:current.id,...split,arguments:"",status:"in_progress"}});
  };

  return new ReadableStream({
    async start(controller){
      const base=responseShell({id:responseId,model,status:"in_progress",output:[],usage:null});
      emit(controller,"response.created",{response:base});
      emit(controller,"response.in_progress",{response:base});
      const reader=source.getReader();
      try{
        for(;;){
          const {done,value}=await reader.read();
          if(done)break;
          buffer+=decoder.decode(value,{stream:true});
          const blocks=buffer.split(/\r?\n\r?\n/);
          buffer=blocks.pop()||"";
          for(const block of blocks){
            const dataLines=block.split(/\r?\n/).filter(line=>line.startsWith("data:"));
            if(!dataLines.length)continue;
            const data=dataLines.map(line=>line.slice(5).trimStart()).join("\n");
            if(!data||data==="[DONE]")continue;
            let chunk;try{chunk=JSON.parse(data)}catch{continue}
            if(chunk.error){
              emit(controller,"error",{error:chunk.error});
              throw new Error(chunk.error?.message||"Upstream chat stream failed");
            }
            if(chunk.model)model=chunk.model;
            if(chunk.usage)usage=chunk.usage;
            const delta=chunk?.choices?.[0]?.delta??{};
            if(typeof delta.content==="string"&&delta.content){
              ensureTextStarted(controller);
              fullText+=delta.content;
              emit(controller,"response.output_text.delta",{item_id:messageId,output_index:0,content_index:0,delta:delta.content});
            }
            if(Array.isArray(delta.tool_calls)){
              for(const part of delta.tool_calls){
                const index=Number.isInteger(part.index)?part.index:0;
                let current=toolCalls.get(index);
                if(!current){
                  current={id:part.id||`call_${randomUUID()}`,itemId:`fc_${randomUUID()}`,name:"",arguments:"",started:false,outputIndex:(textStarted?1:0)+toolCalls.size};
                  toolCalls.set(index,current);
                }
                if(part.id)current.id=part.id;
                if(part.function?.name)current.name+=part.function.name;
                if(current.name)ensureToolStarted(controller,current);
                if(part.function?.arguments){
                  ensureToolStarted(controller,current);
                  current.arguments+=part.function.arguments;
                  emit(controller,"response.function_call_arguments.delta",{item_id:current.itemId,output_index:current.outputIndex,delta:part.function.arguments});
                }
              }
            }
          }
        }

        if(textStarted){
          const item={type:"message",role:"assistant",id:messageId,status:"completed",content:[{type:"output_text",text:fullText,annotations:[]}]};
          emit(controller,"response.output_text.done",{item_id:messageId,output_index:0,content_index:0,text:fullText});
          emit(controller,"response.content_part.done",{item_id:messageId,output_index:0,content_index:0,part:{type:"output_text",text:fullText,annotations:[]}});
          emit(controller,"response.output_item.done",{output_index:0,item});
          outputItems.push(item);
        }

        let nextIndex=textStarted?1:0;
        for(const current of [...toolCalls.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value)){
          current.outputIndex=nextIndex++;
          ensureToolStarted(controller,current);
          const split=splitNamespacedTool(current.name||"tool");
          emit(controller,"response.function_call_arguments.done",{item_id:current.itemId,output_index:current.outputIndex,arguments:current.arguments||"{}"});
          const item={type:"function_call",id:current.itemId,call_id:current.id,...split,arguments:current.arguments||"{}",status:"completed"};
          emit(controller,"response.output_item.done",{output_index:current.outputIndex,item});
          outputItems.push(item);
        }

        const completed=responseShell({id:responseId,model,status:"completed",output:outputItems,usage:responseUsage(usage)});
        emit(controller,"response.completed",{response:completed});
        controller.close();
      }catch(error){
        try{controller.error(error)}catch{}
      }finally{reader.releaseLock()}
    },
  });
}

export async function adaptResponsesBody(body,forwardChat) {
  const chatBody=responsesRequestToChat(body);
  const upstream=await forwardChat(chatBody);
  if(!upstream.ok)return upstream;

  const contentType=(upstream.headers.get("content-type")||"").toLowerCase();
  if(chatBody.stream){
    if(contentType.includes("application/json")){
      const json=await upstream.json();
      const response=chatCompletionToResponse(json,undefined,body.model);
      return new Response(responseObjectToSse(response),{status:200,headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache","connection":"keep-alive"}});
    }
    if(upstream.body){
      return new Response(chatSseToResponsesStream(upstream.body,{model:body.model}),{
        status:upstream.status,
        headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache","connection":"keep-alive"},
      });
    }
  }

  const json=await upstream.json();
  return Response.json(chatCompletionToResponse(json,undefined,body.model),{status:upstream.status});
}
