import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}

// The frames Grok Build 1.0.41 sends for run_terminal_command, as recorded from a live session: the tool call names only the
// bare tool (no kind, no status), an update then gives its kind and command while it still runs, and a last update completes
// it with Grok's Bash output. A second tool call never reports its end before the turn does.
test("a harness tool reads as running, takes its better name in place while it runs, and settles with the turn",async({page})=>{
  test.setTimeout(45_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-rename-"));
  const fixture=join(root,"fake-acp-rename.mjs");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let sessionId="fixture-session";
const command="node -e \"console.log('trebell-tour')\"";
const tool={version:1,name:"run_terminal_command",kind:"execute",namespace:"grok_build",label:"Run Command",read_only:false};
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
function update(value){send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}})}
async function handle(message){
  if(!message.method||message.id==null)return;
  if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}}});
  if(message.method==="session/new"||message.method==="session/resume"||message.method==="session/load")return send({jsonrpc:"2.0",id:message.id,result:{sessionId,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]},configOptions:[],modes:{currentModeId:"build",availableModes:[{id:"build",name:"Build"}]}}});
  if(message.method==="session/set_model"||message.method==="session/close")return send({jsonrpc:"2.0",id:message.id,result:{}});
  if(message.method==="session/prompt"){
    update({sessionUpdate:"tool_call",toolCallId:"call-run",title:"run_terminal_command",rawInput:{command,description:"Print trebell-tour via node"},_meta:{"x.ai/tool":tool}});
    await delay(1500);
    update({sessionUpdate:"tool_call_update",toolCallId:"call-run",kind:"execute",title:"Execute \u0060"+command+"\u0060",content:[{type:"content",content:{type:"text",text:"Print trebell-tour via node"}}],locations:[],rawInput:{variant:"Bash",command,description:"Print trebell-tour via node",is_background:false},_meta:{"x.ai/tool":{...tool,input:{command}}}});
    await delay(1500);
    update({sessionUpdate:"tool_call_update",toolCallId:"call-run",status:"completed",content:[{type:"content",content:{type:"text",text:"trebell-tour\n"}}],rawOutput:{type:"Bash",output:[...Buffer.from("trebell-tour\n")],output_for_prompt:"exit: 0\ntrebell-tour\n",exit_code:0,command,truncated:false,signal:null,timed_out:false}});
    update({sessionUpdate:"tool_call",toolCallId:"call-read",title:"read_file",rawInput:{path:"greet.py"},status:"in_progress"});
    await delay(1500);
    update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"The command printed trebell-tour."}});
    return send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(error=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:error.message}}))}catch{}});
`,"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")};const threadStore=new AgentThreadStore(env);
  const seed=threadStore.create({runtime:"gemini",cwd:root,providerSessionId:"",model:"fixture-model",name:"ACP rename fixture"});
  const instance={id:"gemini-default",kind:"gemini",displayName:"Fixture ACP",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"gemini",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[fixture],compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={
    settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),
    threadMeta:id=>meta.get(id)||{},
    updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},
    recordUsage:()=>{},
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  const port=await listen(server);
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",modelProvider:"openai",defaultPermissionMode:"full",defaultWorkspaceMode:"current"},projects:[],threadMeta:Object.fromEntries(meta)}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:["fixture-model"],metadata:{provider:"gemini",models:[{id:"fixture-model",name:"Fixture Model",provider:"gemini",agent:"Gemini"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:/ACP rename fixture/}).click();
    const composer=page.getByTestId("composer");await expect(composer).toBeEnabled();
    await composer.fill("Run node -e \"console.log('trebell-tour')\" and tell me its output.");await page.getByTestId("send").click();

    const rows=page.locator(".agent-block .tool-event");
    // While Grok has named only the bare tool: its own name, without the relay's placeholder namespace, and "running".
    const bare=rows.filter({hasText:"run_terminal_command"});
    await expect(bare.locator("summary strong")).toHaveText("run_terminal_command");
    await expect(bare.locator("summary em")).toHaveText("running");
    await expect(bare).toHaveClass(/status-running/);
    await page.screenshot({path:auditDir+"tool-progress-bare-running-1280x800.png",fullPage:true,animations:"disabled"});

    // Still running, the update's kind and command rename the same row in place.
    const renamed=rows.filter({hasText:"Execute `node -e \"console.log('trebell-tour')\"`"});
    await expect(renamed.locator("summary em")).toHaveText("running");
    await expect(rows.filter({hasText:"run_terminal_command"})).toHaveCount(0);
    await expect(renamed).toHaveCount(1);
    await expect(renamed).toHaveClass(/kind-commandExecution/);
    await page.screenshot({path:auditDir+"tool-progress-renamed-running-1280x800.png",fullPage:true,animations:"disabled"});

    await expect(renamed.locator("summary em")).toHaveText("done");
    const read=rows.filter({hasText:"read_file"});
    await expect(read.locator("summary strong")).toHaveText("read_file");
    await expect(read.locator("summary em")).toHaveText("running");

    // The turn ends without the read reporting its end; the row settles with the turn.
    await expect(page.locator(".assistant-message-text")).toContainText("The command printed trebell-tour.");
    await expect(read.locator("summary em")).toHaveText("done");
    await expect(rows).toHaveCount(2);
    await expect(rows.locator("summary em").filter({hasText:/inProgress/})).toHaveCount(0);
    // Opened, the finished command shows the output Grok sent as Bash bytes.
    await renamed.locator("summary").click();
    await expect(renamed.locator(".tool-event-body pre").filter({hasText:/^trebell-tour\s*$/})).toBeVisible();
    await page.screenshot({path:auditDir+"tool-progress-turn-done-1280x800.png",fullPage:true,animations:"disabled"});
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});
