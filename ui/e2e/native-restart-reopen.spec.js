import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

// A Native thread across a reload and a Trebell restart, as the live tour used it (L10-F-2, L10-10, L10-7, L10-5): the reopened
// turn shows the time, the heading (harness, model, mode) and the context reading it showed live; a command whose approval card
// waited when Trebell restarted reads not run and says why; and a New task after the restart opens on the model the composer had,
// as it does while Trebell runs. The model is a scripted mock (no live call); the relay, the thread store, the approval and the
// restart's close are Trebell's own.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,body)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
const said=message=>typeof message?.content==="string"?message.content:JSON.stringify(message?.content??"");

test("a Native thread reopened after a reload and a restart shows its turns as it showed them live",async({page})=>{
  test.setTimeout(150_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-reopen-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),models=["model-a","model-b"];
  let threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-reopen",model:"model-a",name:"Native reopen",preview:"Reopen fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null}});
  const nativeProviderTurn=async request=>{
    const reply=(id,text,toolCalls=[],usage={})=>({id,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage});
    if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return reply("gate",JSON.stringify({status:"complete",progress:"uncertain",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"Done."}));
    const asked=said([...request.messages].reverse().find(message=>message.role==="user"));
    if(/count-lines/.test(asked)){
      if(request.messages.at(-1)?.role==="tool")return new Promise((_resolve,reject)=>{const stop=()=>reject(Object.assign(new Error("This operation was aborted"),{name:"AbortError"}));if(request.signal?.aborted)stop();else request.signal?.addEventListener("abort",stop,{once:true})});
      return reply("run","",[{id:"run-count",namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:"node",args:["count-lines.js"],cwd:"."})}],{inputTokens:5797,outputTokens:102,totalTokens:5899});
    }
    await new Promise(resolve=>setTimeout(resolve,1300));
    return reply("pong","PONG",[],{inputTokens:8422,outputTokens:20,totalTokens:8442,cachedInputTokens:8177});
  };
  const startRelay=async()=>{const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"reopen-fixture"}),port=await freePort();await new Promise((resolve,reject)=>server.listen(port,"127.0.0.1",resolve).once("error",reject));return {server,relay,port}};
  let current=await startRelay();
  const project={id:"native-reopen-project",name:"Native Reopen Project",path:repo,environmentId:null,effectiveSettings:{}},uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${current.port}/api/agent/ws`,cwd:repo,platform:process.platform,version:"reopen-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    const saved={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,saved)});
    await page.route(/\/api\/state$/,route=>json(route,{settings:saved,projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}}));
    // Two models and no default: a New task asks which one unless the composer has one (Native on Meta lists several, none named default).
    await page.route(/\/api\/models$/,route=>json(route,{provider:"agentrouter",agentRuntime:"native",ready:true,models,metadata:{provider:"agentrouter",models:[{id:"model-a",name:"Model A",provider:"agentrouter",agent:"Trebell Native"},{id:"model-b",name:"Model B",provider:"agentrouter",agent:"Trebell Native"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,uiMeta));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:`reopen-checkpoint-${Date.now()}`,threadId:thread.id}:{checkpoints:[]}));
    await page.route(/\/api\/checkpoints\/link$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"reopen-context",skipped:true,budget:{reserveTokens:1024}}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/verification\/plan-turn$/,route=>json(route,{supported:false}));
    await page.setViewportSize({width:1280,height:800});
    const openThread=async()=>{const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native reopen"]')});await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click()};
    const shot=async name=>{await page.screenshot({animations:"disabled",path:auditDir+`native-reopen-${name}-1280-dark.png`});await page.getByRole("button",{name:"Switch to light mode",exact:true}).click();await page.waitForTimeout(200);await page.screenshot({animations:"disabled",path:auditDir+`native-reopen-${name}-1280-light.png`});await page.getByRole("button",{name:"Switch to dark mode",exact:true}).click();await page.waitForTimeout(200)};
    const reply=page.locator(".history-assistant").filter({hasText:"PONG"}),heading=reply.getByTestId("assistant-heading"),pill=reply.getByTestId("turn-outcome"),context=page.locator(".composer-context");
    await page.goto("/");await openThread();
    const composer=page.getByTestId("composer");
    await composer.fill("Reply with exactly the word PONG.");await page.getByTestId("send").click();
    await expect(pill).toHaveText(/^done · \d\.\ds$/,{timeout:20_000});
    const live={heading:await heading.textContent(),pill:await pill.textContent(),context:await context.textContent()};
    expect(live.heading).toBe("Trebell Native · Model A · Supervised");expect(live.context).toMatch(/^Context 8,442 tokens/);
    await shot("live");

    // A reload opens the thread from what it keeps.
    await page.reload();await openThread();
    await expect.soft(pill).toHaveText(live.pill,{timeout:15_000});await expect.soft(heading).toHaveText(live.heading);await expect.soft(context).toHaveText(live.context);
    await shot("reloaded");

    // A command waits on its approval when Trebell restarts: the server closes the relay, and a new one starts on the same home.
    await composer.fill("Run node count-lines.js in the project and tell me what it printed.");await page.getByTestId("send").click();
    await expect(page.locator(".approval-card").filter({hasText:"node count-lines.js"})).toBeVisible({timeout:20_000});
    await current.relay.close();await new Promise(resolve=>current.server.close(()=>resolve()));threadStore.close();
    threadStore=new AgentThreadStore(env);threadStore.reconcileRestart();current=await startRelay();
    await page.reload();
    // Trebell opens on a New task, which opens on the model the composer had, as a New task does while Trebell runs.
    await expect.soft(page.getByTestId("model-picker")).toContainText("Model A",{timeout:10_000});
    await shot("new-task-after-restart");
    await openThread();
    await expect.soft(pill).toHaveText(live.pill,{timeout:15_000});await expect.soft(heading).toHaveText(live.heading);
    const command=page.locator(".tool-event").filter({hasText:"node count-lines.js"});
    if(!await command.isVisible())await page.locator(".activity-card").filter({hasText:"1 step"}).locator(".activity-card-head").click();
    await expect.soft(command.locator("summary em")).toHaveText("not run",{timeout:10_000});
    await expect.soft(page.locator(".activity-card").filter({hasText:"1 step"}).locator(".activity-card-failed")).toHaveCount(0);
    await command.locator("summary").click();await expect.soft(command).toContainText("Trebell closed before this was approved, so it did not run.");
    await shot("after-restart");
    const metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  }finally{await current.relay.close().catch(()=>{});await new Promise(resolve=>current.server.close(()=>resolve()));threadStore.close();state.close?.();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
