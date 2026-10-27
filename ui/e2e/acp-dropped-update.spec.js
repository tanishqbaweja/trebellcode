import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { keepThreadMeta } from "./test-home.js";

// A Cursor tool call whose first frame the relay cannot map (a location that is no object) and whose next update it can. The frame is
// dropped with a warning (acp-client.mjs), and it no longer joins the call's state, as T3 drops an update it cannot decode: the update
// shows the call in the turn's card. Kept in that state, the frame's fields went with the update, which the relay dropped as well, so
// the call never showed.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// Dark and light screenshots at 1280x800 and 900x800, switched with the header's toggle as a person switches them.
async function shots(page,name){
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    for(const mode of ["dark","light"]){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x800.png`});
    }
  }
  await page.setViewportSize({width:1280,height:800});
}

// A Cursor of the test's own over ACP.
const FAKE_CURSOR=String.raw`
import readline from "node:readline";
const send=value=>process.stdout.write(JSON.stringify(value)+"\n");
const select=(id,category,currentValue,values)=>({id,name:id,category,type:"select",currentValue,options:values.map(([value,name])=>({value,name}))});
let options=[select("mode","mode","agent",[["agent","Agent"],["plan","Plan"],["ask","Ask"]]),select("model","model","default",[["default","Auto"]])];
const update=(sessionId,update)=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update}});
readline.createInterface({input:process.stdin}).on("line",line=>{
  let m;try{m=JSON.parse(line)}catch{return}
  if(m.id==null||!m.method)return;
  const reply=result=>send({jsonrpc:"2.0",id:m.id,result});
  if(m.method==="initialize")return reply({protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true}});
  if(m.method==="session/new"||m.method==="session/load")return reply({sessionId:"fixture-session",configOptions:options});
  if(m.method==="session/set_config_option"){options=options.map(option=>option.id===m.params.configId?{...option,currentValue:m.params.value}:option);return reply({configOptions:options})}
  if(m.method==="session/prompt"){
    const id=m.params.sessionId;
    update(id,{sessionUpdate:"tool_call",toolCallId:"delete-notes",title:"Delete old-notes.txt",kind:"delete",status:"pending",locations:[null]});
    update(id,{sessionUpdate:"tool_call_update",toolCallId:"delete-notes",title:"Delete old-notes.txt",status:"completed"});
    update(id,{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Removed the old notes."}});
    return reply({stopReason:"end_turn"});
  }
  reply({});
});
`;

// A Cursor thread over the real relay, with the fake Cursor behind it; relayOptions go to the relay (a journal).
async function cursorThread(page,{name,relayOptions={}}){
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-dropped-")),fixture=join(root,"fake-cursor.mjs");
  await writeFile(fixture,FAKE_CURSOR,"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")},threadStore=new AgentThreadStore(env);
  const seed=threadStore.create({runtime:"cursor",cwd:root,providerSessionId:"",model:"default",name});
  const instance={id:"cursor-default",kind:"cursor",displayName:"Cursor",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"cursor",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[fixture],compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture",...relayOptions});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await keepThreadMeta(page);
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"cursor",agentRuntimeInstanceId:"cursor-default",modelProvider:"openai",defaultPermissionMode:"full",defaultWorkspaceMode:"current"};
  // The page's settings stay in the page: a change (the appearance toggle) is kept here, not on the shared mock server.
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"cursor",agentRuntimeInstanceId:"cursor-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:"win32",version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:["default"],metadata:{provider:"cursor",models:[{id:"default",name:"Auto",provider:"cursor",agent:"Cursor"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  return {seed,threadStore,close:async()=>{await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}};
}
// Opens the thread and sends one message as a person does, then waits for the reply.
async function sendAndWait(page,name,message){
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:new RegExp(name)}).click();
  const composer=page.getByTestId("composer");await expect(composer).toBeEnabled();
  await composer.click();await page.keyboard.type(message,{delay:8});await page.getByTestId("send").click();
  await expect(page.locator(".assistant-message-text").filter({hasText:"Removed the old notes."})).toBeVisible({timeout:20_000});
  await expect(page.locator(".history-assistant-body").last().getByText(/^done/),"the turn shows as done").toBeVisible();
}

test("a Cursor tool call whose first frame Trebell cannot map shows in the turn's card from its next update",async({page})=>{
  test.setTimeout(60_000);
  const thread=await cursorThread(page,{name:"Old notes"});
  try{
    await sendAndWait(page,"Old notes","Remove the old notes file.");
    const row=page.locator(".agent-block .tool-event").filter({hasText:"Delete old-notes.txt"});
    await expect(row,"the call shows in the card").toHaveCount(1);await expect(row).toContainText("done");
    expect(thread.threadStore.get(thread.seed.id).turns.at(-1).items.find(item=>item.id==="delete-notes")?.status,"the thread keeps the call").toBe("completed");
    await shots(page,"acp-dropped-update-tool");
  }finally{await thread.close()}
});
