// A stand-in for an OpenCode 1.x server (`opencode serve`): the HTTP API and event stream (/event) that OpenCodeAgentSession drives
// through @opencode-ai/sdk, answered as OpenCode 1.x answers them. An OpenCode profile's own server (its serverUrl) is pointed here.
// OpenCode 1.x answers a prompt (POST /session/{id}/message) once the turn has ended, with the assistant's message: onPrompt({body,
// sessionID, messageID, emit, part, answered}) plays the turn, its events in between, and returns the reply's text. part(part) sends
// one of the assistant message's parts (message.part.updated); answered(requestID) resolves with the reply to a question or a
// permission once Trebell sends it. Without onPrompt a prompt is answered "OK" at once.
import { createServer } from "node:http";

// Polls check every 20 ms until it gives a value, for at most timeoutMs.
export async function eventuallyReal(check,{timeoutMs=8000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await new Promise(resolve=>setTimeout(resolve,20))}
}

export const FAKE_OPENCODE1_MODEL="opencode/big-pickle";
export const FAKE_OPENCODE1_PROVIDERS=Object.freeze({connected:["opencode"],default:{opencode:"big-pickle"},all:[{id:"opencode",name:"OpenCode Zen",models:{"big-pickle":{id:"big-pickle",name:"Big Pickle",limit:{context:200000}}}}]});

export async function startFakeOpenCode1({providers=FAKE_OPENCODE1_PROVIDERS,onPrompt=null,routes={}}={}){
  const calls=[],streams=new Set(),replies=new Map(),waiting=new Map(),pending=new Set();let turns=0;
  const emit=event=>{for(const res of streams)res.write(`data: ${JSON.stringify(event)}\n\n`);return event};
  const replied=(requestID,body)=>{replies.set(requestID,body);for(const resolve of waiting.get(requestID)||[])resolve(body);waiting.delete(requestID)};
  const answered=requestID=>replies.has(requestID)?Promise.resolve(replies.get(requestID)):new Promise(resolve=>waiting.set(requestID,[...(waiting.get(requestID)||[]),resolve]));
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");let text="";for await(const chunk of req)text+=chunk;
    let body=null;try{body=text?JSON.parse(text):null}catch{body=text}
    const key=`${req.method} ${url.pathname}`,json=(status,value)=>{if(res.writableEnded)return;res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    calls.push({key,body});
    if(routes[key])return routes[key]({req,res,body,json});
    if(key==="GET /event"){
      res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});res.write(`data: ${JSON.stringify({type:"server.connected",properties:{}})}\n\n`);
      streams.add(res);res.on("close",()=>streams.delete(res));return;
    }
    if(key==="GET /provider")return json(200,providers);
    if(key==="GET /config")return json(200,{});
    if(["GET /command","GET /agent","GET /skill"].includes(key))return json(200,[]);
    if(key==="POST /session")return json(200,{id:"ses_main",...(Array.isArray(body?.permission)?{permission:body.permission}:{})});
    const question=/^\/(question|permission)\/([^/]+)\/(reply|reject)$/.exec(url.pathname);
    if(req.method==="POST"&&question){replied(decodeURIComponent(question[2]),{kind:question[3],...(body&&typeof body==="object"?body:{})});return json(200,true)}
    const match=/^\/session\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if(match){
      const sessionID=decodeURIComponent(match[1]),rest=match[2]||"";
      if(req.method==="GET"&&!rest)return json(200,{id:sessionID});
      if(req.method==="PATCH"&&!rest)return json(200,{id:sessionID,permission:Array.isArray(body?.permission)?body.permission:[]});
      if(req.method==="GET"&&rest==="/message")return json(200,[]);
      if(req.method==="GET"&&/^\/message\/[^/]+$/.test(rest))return json(200,{info:{id:decodeURIComponent(rest.slice(9)),sessionID,role:"assistant"},parts:[]});
      if(req.method==="POST"&&rest==="/abort"){for(const stop of pending)stop();return json(200,true)}
      if(req.method==="POST"&&rest==="/message"){
        const messageID=`msg_a${++turns}`,reply=(said,extra={})=>({info:{id:messageID,parentID:body?.messageID||"msg_u1",role:"assistant",tokens:{input:3,output:1},...extra},parts:said?[{id:`prt_${messageID}`,type:"text",text:said}]:[]});
        if(typeof onPrompt!=="function")return json(200,reply("OK"));
        emit({type:"message.updated",properties:{sessionID,info:{id:messageID,sessionID,role:"assistant"}}});
        const part=value=>emit({type:"message.part.updated",properties:{sessionID,part:{id:`prt_${messageID}_${Math.random().toString(36).slice(2,8)}`,sessionID,messageID,...value}}});
        // Stop answers the prompt at once with OpenCode's aborted message.
        const stop=()=>json(200,reply("",{error:{name:"MessageAbortedError",data:{message:"The operation was aborted."}}}));pending.add(stop);
        try{const said=await onPrompt({body,sessionID,messageID,emit,part,answered});json(200,reply(String(said??"")))}
        catch(error){json(500,{name:"UnknownError",data:{message:String(error?.message||error)}})}
        finally{pending.delete(stop)}
        return;
      }
    }
    json(404,{name:"NotFoundError",data:{message:`No fake route for ${key}`}});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {
    url:`http://127.0.0.1:${server.address().port}`,calls,emit,streams,
    called:key=>calls.filter(call=>call.key===key),
    prompts:()=>calls.filter(call=>/^POST \/session\/[^/]+\/message$/.test(call.key)).map(call=>call.body),
    close:()=>{for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))},
  };
}
