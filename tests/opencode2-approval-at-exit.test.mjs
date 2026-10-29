import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { startFakeOpenCode2 } from "./fixtures/fake-opencode2-server.mjs";

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=8000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(20)}
}
const DEPLOY_REPLY="POST /api/session/ses_main/permission/per_deploy/reply";

// Quitting Trebell while a Supervised OpenCode 2 thread's approval card waits, with another thread's OpenCode 2 session open too. The
// relay rejects every wait it still holds ("The relay closed"), then closes the sessions one by one, the other thread's first. The deploy
// thread's session, still open while that one closed, took the rejection for the relay's own time-out: it stored the turn failed,
// saying OpenCode's shell request "was not answered in time", though nothing timed out. The turn is stored stopped, as the app's close
// stops it. The real relay and OpenCode 2 sessions run against the fake OpenCode 2 server, the profile's own (serverUrl).
test("quitting Trebell while an OpenCode 2 approval waits stores its turn stopped, not failed as an approval left unanswered in time",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode2-exit-"));
  let created=0;
  const fake=await startFakeOpenCode2({
    sessions:{ses_first:{id:"ses_first",agent:"build"}},
    routes:{
      // The first thread's OpenCode session, then the deploy thread's.
      "POST /api/session":({send})=>send(200,{data:{id:created++?"ses_main":"ses_first",agent:"build"}}),
      [DEPLOY_REPLY]:({send})=>send(204),
    },
    onPrompt:({sessionID,emit})=>{if(sessionID==="ses_main")emit({type:"permission.asked",data:{id:"per_deploy",sessionID,action:"shell",resources:["npm run deploy"],save:[],metadata:{command:"npm run deploy"}}})},
  });
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,serverUrl:fake.url};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"opencode",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version:"2.0.24"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>process.execPath,
  };
  const meta=new Map(),state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const messages=[];let nextId=0,closed=false;ws.on("message",raw=>messages.push(JSON.parse(String(raw))));
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++nextId,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==id||message.method)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id,method,params}));
  });
  t.after(async()=>{
    try{ws.close()}catch{}
    if(!closed)await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await fake.close();threadStore.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  });
  const policy={cwd:root,approvalPolicy:"on-request",sandbox:"workspace-write"};
  await rpc("thread/start",policy);
  const {thread}=await rpc("thread/start",policy);
  await rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Deploy the docs site"}]});
  await eventually(()=>messages.find(message=>message.method==="item/tool/requestApproval"),{message:"the approval card was not shown"});
  // The person quits Trebell while the card waits.
  closed=true;await relay.close();
  const turn=threadStore.get(thread.id).turns.at(-1);
  assert.equal(turn.status,"cancelled",`the turn is stored stopped (${JSON.stringify(turn.error)})`);
  assert.doesNotMatch(JSON.stringify(turn.error),/not answered in time/);
  assert.deepEqual(fake.called(DEPLOY_REPLY).map(call=>call.body),[{decision:"reject"}],"OpenCode's run is stopped as the app's close stops it, without telling the model the person declined it");
});
