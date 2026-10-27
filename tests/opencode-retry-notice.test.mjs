import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=5000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(20)}
}
const PROVIDERS={all:[{id:"opencode",name:"OpenCode Zen",models:{pickle:{id:"big-pickle",name:"Big Pickle"}}}],connected:["opencode"],default:{opencode:"big-pickle"}};

// A stand-in for an OpenCode 1.x server (its HTTP API and /event stream) whose prompt answer the test holds until it says so.
async function fakeOpenCode1(){
  const streams=new Set(),held=[],calls=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");let text="";for await(const chunk of req)text+=chunk;
    const key=`${req.method} ${url.pathname}`,json=(status,value)=>{if(res.writableEnded)return;res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    calls.push(key);
    if(key==="GET /event"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});res.write(`data: ${JSON.stringify({type:"server.connected",properties:{}})}\n\n`);streams.add(res);res.on("close",()=>streams.delete(res));return}
    if(key==="GET /provider")return json(200,PROVIDERS);
    if(key==="GET /config")return json(200,{});
    if(["GET /command","GET /agent","GET /skill"].includes(key))return json(200,[]);
    if(key==="POST /session")return json(200,{id:"ses_retry"});
    if(key==="GET /session/ses_retry")return json(200,{id:"ses_retry"});
    if(key==="POST /session/ses_retry/message"){held.push(answer=>json(200,answer));return}
    if(key==="POST /session/ses_retry/abort")return json(200,true);
    json(404,{name:"NotFoundError",data:{message:`No fixture route for ${key}`}});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {
    url:`http://127.0.0.1:${server.address().port}`,held,calls,
    emit:event=>{for(const res of streams)res.write(`data: ${JSON.stringify(event)}\n\n`)},
    close:()=>{for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))},
  };
}

test("an OpenCode retry Trebell waits for says so in Trebell's words: what failed, which model, in how long and which retry",async()=>{
  const {openCodeRetryNotice}=await import("../src/opencode-agent-session.mjs");
  assert.equal(typeof openCodeRetryNotice,"function");
  assert.equal(openCodeRetryNotice({message:"429 Too Many Requests",model:"opencode/big-pickle",retry:1,waitMs:30_000}),"429 Too Many Requests. OpenCode retries opencode/big-pickle in 30 s (retry 1).");
  assert.equal(openCodeRetryNotice({message:{name:"APIError",data:{message:"Provider is overloaded."}},model:"nvidia/z-ai/glm-5.3-flash",retry:3,waitMs:1_400}),"Provider is overloaded. OpenCode retries nvidia/z-ai/glm-5.3-flash in 1 s (retry 3).");
  assert.equal(openCodeRetryNotice({message:"Rate limited",retry:2,waitMs:8_000,subagent:true}),"A subagent's model request failed: Rate limited. OpenCode retries it in 8 s (retry 2).");
  assert.equal(openCodeRetryNotice({retry:0,waitMs:-5}),"The model provider request failed. OpenCode retries the model in 1 s (retry 1).");
});

test("an OpenCode 1.x retry shows as the turn's retry row, and the turn ends as OpenCode answers it",async()=>{
  const fixture=await fakeOpenCode1(),updates=[];
  const session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fixture.url,onUpdate:params=>updates.push(params.update)});
  try{
    await session.start({model:"opencode/big-pickle"});
    const turn=session.prompt([{type:"text",text:"Fix the parser"}]);
    await eventually(()=>fixture.held.length===1);
    // OpenCode 1.x counts its retries from 1, and names when it sends the request again.
    fixture.emit({type:"session.status",properties:{sessionID:"ses_retry",status:{type:"retry",attempt:2,message:"Rate limited",next:Date.now()+20_000}}});
    await eventually(()=>updates.some(update=>update.sessionUpdate==="runtime_error"));
    const notices=updates.filter(update=>update.sessionUpdate==="runtime_error");
    assert.equal(notices.length,1);assert.equal(notices[0].willRetry,true);
    // The wait is counted when the event arrives, so a busy machine that takes seconds to deliver it shows fewer of the 20 s.
    const [,seconds]=notices[0].message.match(/^Rate limited\. OpenCode retries opencode\/big-pickle in (\d+) s \(retry 2\)\.$/)||[];
    assert.ok(Number(seconds)>=10&&Number(seconds)<=20,notices[0].message);
    fixture.held[0]({info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",tokens:{input:3,output:1}},parts:[{id:"prt_1",type:"text",text:"Fixed."}]});
    assert.equal((await turn).stopReason,"end_turn");
  }finally{await session.close();await fixture.close()}
});
