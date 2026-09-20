import { randomUUID } from "node:crypto";

function textContent(content){
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return "";
  return content.map(part=>{
    if(typeof part==="string")return part;
    if(part?.type==="text")return part.text||"";
    return "";
  }).join("");
}

function safeJson(value){
  if(value&&typeof value==="object")return value;
  try{return JSON.parse(String(value||"{}"))}catch{return{}}
}

function pushMessage(messages,role,content){
  if(!content?.length)return;
  const previous=messages.at(-1);
  if(previous?.role===role&&Array.isArray(previous.content)){
    previous.content.push(...content);
    return;
  }
  messages.push({role,content});
}

export function chatToAnthropic(body={}){
  const system=[];
  const messages=[];
  for(const message of Array.isArray(body.messages)?body.messages:[]){
    if(!message||typeof message!=="object")continue;
    if(message.role==="system"||message.role==="developer"){
      const text=textContent(message.content).trim();
      if(text)system.push(text);
      continue;
    }
    if(message.role==="tool"){
      pushMessage(messages,"user",[{
        type:"tool_result",
        tool_use_id:String(message.tool_call_id||""),
        content:textContent(message.content),
      }]);
      continue;
    }
    if(message.role==="assistant"){
      const blocks=[];
      const text=textContent(message.content);
      if(text)blocks.push({type:"text",text});
      for(const call of Array.isArray(message.tool_calls)?message.tool_calls:[]){
        if(call?.type!=="function")continue;
        blocks.push({
          type:"tool_use",
          id:String(call.id||`toolu_${randomUUID()}`),
          name:String(call.function?.name||"tool"),
          input:safeJson(call.function?.arguments),
        });
      }
      pushMessage(messages,"assistant",blocks);
      continue;
    }
    const blocks=[];
    if(typeof message.content==="string"){
      if(message.content)blocks.push({type:"text",text:message.content});
    }else if(Array.isArray(message.content)){
      for(const part of message.content){
        if(part?.type==="text"&&typeof part.text==="string")blocks.push({type:"text",text:part.text});
        else if(part?.type==="image_url"&&typeof part.image_url?.url==="string"){
          const match=part.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);
          if(match)blocks.push({type:"image",source:{type:"base64",media_type:match[1],data:match[2]}});
        }
      }
    }
    pushMessage(messages,"user",blocks);
  }

  const out={
    model:body.model,
    max_tokens:Number.isFinite(body.max_tokens)?body.max_tokens:8192,
    messages,
    stream:body.stream!==false,
  };
  if(system.length)out.system=system.join("\n\n");
  if(Array.isArray(body.tools)&&body.tools.length){
    out.tools=body.tools.filter(t=>t?.type==="function"&&t.function?.name).map(t=>({
      name:t.function.name,
      description:t.function.description||"",
      input_schema:t.function.parameters||{type:"object",properties:{}},
    }));
  }
  if(body.tool_choice){
    if(body.tool_choice==="auto")out.tool_choice={type:"auto"};
    else if(body.tool_choice==="required")out.tool_choice={type:"any"};
    else if(body.tool_choice?.type==="function"&&body.tool_choice.function?.name)out.tool_choice={type:"tool",name:body.tool_choice.function.name};
  }
  if(typeof body.temperature==="number")out.temperature=body.temperature;
  if(typeof body.top_p==="number")out.top_p=body.top_p;
  if(Array.isArray(body.stop))out.stop_sequences=body.stop;
  return out;
}

function openAiChunk({id,model,delta={},finish_reason=null,usage}={}){
  return {
    id,
    object:"chat.completion.chunk",
    created:Math.floor(Date.now()/1000),
    model:model||"",
    choices:[{index:0,delta,finish_reason}],
    ...(usage?{usage}:{}),
  };
}

function mapStopReason(reason){
  if(reason==="tool_use")return"tool_calls";
  if(reason==="max_tokens")return"length";
  return reason?"stop":null;
}

export function anthropicSseToChatStream(source,{model=""}={}){
  const decoder=new TextDecoder();
  const encoder=new TextEncoder();
  const id=`chatcmpl_${randomUUID()}`;
  let buffer="";
  let finishReason=null;
  let inputTokens=0;
  let outputTokens=0;
  const toolIndexes=new Map();
  let nextToolIndex=0;

  const line=(value)=>encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  return new ReadableStream({
    async start(controller){
      const reader=source.getReader();
      try{
        for(;;){
          const {done,value}=await reader.read();
          if(done)break;
          buffer+=decoder.decode(value,{stream:true});
          const blocks=buffer.split(/\r?\n\r?\n/);
          buffer=blocks.pop()||"";
          for(const block of blocks){
            const dataLines=block.split(/\r?\n/).filter(v=>v.startsWith("data:"));
            if(!dataLines.length)continue;
            const raw=dataLines.map(v=>v.slice(5).trimStart()).join("\n");
            if(!raw||raw==="[DONE]")continue;
            let event;try{event=JSON.parse(raw)}catch{continue}
            if(event.type==="error")throw new Error(event.error?.message||"Anthropic provider stream error");
            if(event.type==="message_start"){
              inputTokens=Number(event.message?.usage?.input_tokens||0)||0;
              if(event.message?.model)model=event.message.model;
            }else if(event.type==="content_block_start"){
              const blockValue=event.content_block||{};
              if(blockValue.type==="text"&&blockValue.text){
                controller.enqueue(line(openAiChunk({id,model,delta:{content:blockValue.text}})));
              }else if(blockValue.type==="tool_use"){
                const toolIndex=nextToolIndex++;
                toolIndexes.set(event.index,toolIndex);
                controller.enqueue(line(openAiChunk({id,model,delta:{tool_calls:[{
                  index:toolIndex,
                  id:blockValue.id||`call_${randomUUID()}`,
                  type:"function",
                  function:{name:blockValue.name||"tool",arguments:""},
                }]}})));
              }
            }else if(event.type==="content_block_delta"){
              const delta=event.delta||{};
              if(delta.type==="text_delta"&&delta.text){
                controller.enqueue(line(openAiChunk({id,model,delta:{content:delta.text}})));
              }else if(delta.type==="input_json_delta"){
                const toolIndex=toolIndexes.get(event.index)??0;
                controller.enqueue(line(openAiChunk({id,model,delta:{tool_calls:[{index:toolIndex,function:{arguments:delta.partial_json||""}}]}})));
              }
            }else if(event.type==="message_delta"){
              finishReason=mapStopReason(event.delta?.stop_reason)||finishReason;
              outputTokens=Number(event.usage?.output_tokens||outputTokens)||outputTokens;
            }
          }
        }
        controller.enqueue(line(openAiChunk({
          id,model,delta:{},finish_reason:finishReason||"stop",
          usage:{prompt_tokens:inputTokens,completion_tokens:outputTokens,total_tokens:inputTokens+outputTokens},
        })));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }catch(error){controller.error(error)}
      finally{reader.releaseLock()}
    },
  });
}

export function anthropicMessageToChatCompletion(message={},fallbackModel=""){
  const content=[];
  const tool_calls=[];
  for(const block of Array.isArray(message.content)?message.content:[]){
    if(block?.type==="text"&&typeof block.text==="string")content.push(block.text);
    else if(block?.type==="tool_use"){
      tool_calls.push({
        id:block.id||`call_${randomUUID()}`,
        type:"function",
        function:{name:block.name||"tool",arguments:JSON.stringify(block.input||{})},
      });
    }
  }
  const prompt=Number(message.usage?.input_tokens||0)||0;
  const completion=Number(message.usage?.output_tokens||0)||0;
  return {
    id:message.id||`chatcmpl_${randomUUID()}`,
    object:"chat.completion",
    created:Math.floor(Date.now()/1000),
    model:message.model||fallbackModel,
    choices:[{
      index:0,
      message:{role:"assistant",content:content.join(""),...(tool_calls.length?{tool_calls}:{})},
      finish_reason:mapStopReason(message.stop_reason)||"stop",
    }],
    usage:{prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion},
  };
}

export async function adaptAnthropicResponse(upstream,{stream,model}={}){
  if(!upstream.ok)return upstream;
  const contentType=upstream.headers.get("content-type")||"";
  if(stream&&upstream.body&&!contentType.includes("application/json")){
    return new Response(anthropicSseToChatStream(upstream.body,{model}),{
      status:upstream.status,
      headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache","connection":"keep-alive"},
    });
  }
  const json=await upstream.json();
  const converted=anthropicMessageToChatCompletion(json,model);
  if(stream){
    const encoder=new TextEncoder();
    const text=converted.choices?.[0]?.message?.content||"";
    const calls=converted.choices?.[0]?.message?.tool_calls||[];
    const id=converted.id;
    const streamBody=new ReadableStream({start(controller){
      if(text)controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk({id,model:converted.model,delta:{content:text}}))}\n\n`));
      if(calls.length)controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk({id,model:converted.model,delta:{tool_calls:calls.map((call,index)=>({...call,index}))}}))}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk({id,model:converted.model,delta:{},finish_reason:converted.choices?.[0]?.finish_reason||"stop",usage:converted.usage}))}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }});
    return new Response(streamBody,{status:200,headers:{"content-type":"text/event-stream; charset=utf-8"}});
  }
  return Response.json(converted,{status:upstream.status});
}
