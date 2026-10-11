import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { NATIVE_REPLY_STREAM } from "../../src/native-agent-session.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

// Trebell Native showing a reply while its provider call streams. The real agent relay runs the real Native session; only the
// provider is faked: each scripted call gets the session's stream hook and is driven by the test, as native-queue.spec.js does.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function gate(){let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}}
const untilAborted=signal=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("provider request aborted"),{name:"AbortError"})),{once:true}));
const reply=(request,text,extra={})=>({id:"stream-"+Math.random().toString(36).slice(2,8),provider:request.provider,model:request.model,text,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:40,totalTokens:52},...extra});
const searchCall=id=>({id,namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"SessionManager"}'});

const ANSWER_HEAD="Trebell Native answers with the model its thread names. When you start a thread, the composer's model and provider are stored with it, and every turn sends its request to that pair.\n\n";
const ANSWER_TAIL="Changing the model in the composer changes the next request only. Replies already written stay as they were, and the thread keeps the new choice for the turns after it.";
const PREAMBLE="I'll start by searching the repository for the SessionManager class, since the question is where it is defined and how it is used.\n\nThen I will read the file that defines it and summarise what it does.";
const SENTINEL="SENTINEL-7f3a: this first attempt streams a reply that the provider then abandons with an HTTP 503 error.\n\nIt must not stay on screen once the attempt fails, because the retry writes its own answer from the start.";
const RETRIED="The retried attempt answered on its own. The provider failed once with a 503 and Trebell Native retried the call.\n\nOnly this second answer is shown, streamed again from its first character.";
const ALPHA_ONE="ALPHA-ONE: the alpha thread starts its answer while you are looking at it, and this first part is long enough to show as a draft.\n\nIt goes on for a second paragraph before the next part.";
const ALPHA_TWO="ALPHA-TWO: this part arrives while another thread is open, so the alpha thread never received it on screen.";
const ALPHA_THREE=" ALPHA-THREE: this part arrives while the alpha thread opens again, after its draft began, so it cannot be placed.";
const ALPHA_FINAL="ALPHA-FINAL: after its search the alpha thread writes its answer again from the first character.\n\nThis is the reply the thread keeps, and nothing of the first draft is left in front of it.";
const STEER_ONE="STEER-ONE: the first call starts answering the original question and streams this draft.\n\nSteering stops this call, so the draft goes before the steered call answers.";
const STEER_TWO="STEER-TWO: the steered call answers the redirected question from its first character.\n\nOnly this answer stays on screen, and it is the message the turn keeps once the call ends.";

// The Native relay, its threads and the GUI server's HTTP API for one page. script holds one function per provider call
// (request, hook) => reply; requests records whether each call carried the stream hook. holdOpening(threadId), once armed,
// holds the relay's answers about that thread after its next thread/resume until the function it returns is called, so the
// app keeps that thread's notifications back while it opens.
async function startStreamingFixture(page,{mode="dark",threads=[{name:"Native streaming",preview:"Live reply"}]}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-reply-stream-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"session.js"),"export class SessionManager { refresh(){ return true; } }\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const created=threads.map((item,index)=>threadStore.create({
    runtime:"native",cwd:repo,providerSessionId:"native-reply-stream-"+index,model:"gpt-5.6",name:item.name,preview:item.preview,
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"openai",permissionProfile:"auto",projectless:false,environmentId:null},
  }));
  const script=[],requests=[];
  const nativeProviderTurn=async request=>{
    const hook=request[NATIVE_REPLY_STREAM];requests.push({hooked:typeof hook==="function",gate:request.metadata?.completionGate===true});
    const step=script.shift();if(!step)throw new Error("unexpected provider call");return step(request,typeof hook==="function"?hook:()=>{});
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const wsUrl=`ws://127.0.0.1:${relayPort}/api/agent/ws`;
  let opening=null;
  await page.routeWebSocket(wsUrl,ws=>{
    const server=ws.connectToServer(),sent=new Map();
    ws.onMessage(message=>{try{const parsed=JSON.parse(String(message));if(parsed?.id!=null&&parsed.method)sent.set(parsed.id,{method:parsed.method,threadId:String(parsed.params?.threadId||"")})}catch{}server.send(message)});
    server.onMessage(async message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const asked=parsed?.id!=null&&!parsed.method?sent.get(parsed.id):null;
      if(asked&&opening&&asked.threadId===opening.threadId){
        if(asked.method==="thread/resume"&&!opening.resumed)opening.resumed=true;
        else if(opening.resumed)await opening.released;
      }
      ws.send(message);
    });
  });
  const project={id:"native-stream-project",name:"Native Stream Project",path:repo,environmentId:null,effectiveSettings:{}};
  const meta=Object.fromEntries(created.map(thread=>[thread.id,{projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"}]));
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    mock:false,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null,
  })}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    settings:{onboardingComplete:true,appearance:mode,appearanceMode:mode,panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},
    projects:[project],activeProjectId:project.id,threadMeta:meta,
  })}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"openai",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"openai",agent:"Trebell Native"}]}})}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
  await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,branch:"main",root:repo})}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{
    const url=new URL(route.request().url()),id=url.searchParams.get("threadId")||route.request().postDataJSON?.()?.threadId||created[0].id;
    if(route.request().method()==="POST"){const body=route.request().postDataJSON();meta[id]={...(meta[id]||{}),...(body?.patch||{})}}
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[id]||{})});
  });
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"stream-checkpoint",threadId:created[0].id}:{checkpoints:[]})}));
  await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
  await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"stream-context",skipped:true,budget:{reserveTokens:1024}})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  const open=async name=>{const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();await expect(page.getByTestId("composer")).toBeEnabled({timeout:10_000})};
  const send=async text=>{const composer=page.getByTestId("composer");await composer.fill(text);await page.getByTestId("send").click()};
  // A second client of the relay, for what the app itself does not send (steering a Native turn).
  const rpc=async(method,params)=>{
    const socket=new WebSocket(wsUrl);await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject)});
    try{return await new Promise((resolve,reject)=>{socket.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id===1)message.error?reject(new Error(message.error.message)):resolve(message.result)});socket.send(JSON.stringify({id:1,method,params}))})}
    finally{socket.close()}
  };
  return {
    page,repo,threadStore,threads:created,script,requests,open,send,rpc,
    holdOpening(threadId){const held=gate();opening={threadId:String(threadId),resumed:false,released:held.promise};return ()=>{held.open();opening=null}},
    async close(){opening=null;await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}

const live=page=>page.locator(".assistant-answer");
const stop=page=>page.getByRole("button",{name:"Stop",exact:true});
// Records every text the live reply showed from now on, so a check can say what was on screen between two assertions.
async function watchLiveReply(page){
  await page.evaluate(()=>{
    const seen=window.__liveReplySeen=[];const note=()=>{for(const node of document.querySelectorAll(".assistant-answer")){const text=node.textContent||"";if(text&&seen.at(-1)!==text)seen.push(text)}};
    window.__liveReplyObserver?.disconnect();window.__liveReplyObserver=new MutationObserver(note);window.__liveReplyObserver.observe(document.body,{subtree:true,childList:true,characterData:true});note();
  });
  return ()=>page.evaluate(()=>window.__liveReplySeen.slice());
}
async function assertNoHorizontalScroll(page){
  const metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
}

for(const mode of ["dark","light"]){
  test(`a Native reply shows while its provider call streams and becomes the finished message once (${mode})`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const fixture=await startStreamingFixture(page,{mode});const tail=gate(),finish=gate(),streamed=gate();
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:ANSWER_HEAD});streamed.open();await tail.promise;for(const word of ANSWER_TAIL.split(/(?<= )/))hook({type:"text",delta:word});await finish.promise;return reply(request,ANSWER_HEAD+ANSWER_TAIL)});
    try{
      await fixture.open("Native streaming");await fixture.send("Explain how a Native thread picks the model it answers with. Do not change any files.");await streamed.promise;
      // The head of the reply is on screen while the call is still running.
      await expect(live(page)).toContainText("Trebell Native answers with the model its thread names.");await expect(stop(page)).toBeVisible();
      await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-mid-${mode}-1280x800.png`});
      tail.open();await expect(live(page)).toContainText("the thread keeps the new choice for the turns after it.");await expect(stop(page)).toBeVisible();
      await page.setViewportSize({width:390,height:844});await expect(live(page)).toBeVisible();await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-mid-${mode}-390x844.png`});
      await page.setViewportSize({width:1280,height:800});
      finish.open();
      const message=page.locator(".history-assistant").filter({hasText:"Trebell Native answers with the model its thread names."});
      await expect(message).toHaveCount(1,{timeout:10_000});await expect(message).toContainText("the thread keeps the new choice for the turns after it.");
      await expect(live(page)).toHaveCount(0);await expect(stop(page)).toHaveCount(0);
      await expect(page.getByText("Changing the model in the composer changes the next request only.",{exact:false})).toHaveCount(1);
      expect(fixture.requests).toEqual([{hooked:true,gate:false}]);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-final-${mode}-1280x800.png`});
    }finally{tail.open();finish.open();await fixture.close()}
  });
}

test("a Native draft that goes another way leaves the screen: a tool call, a failed attempt and a short preamble",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page);
  try{
    await fixture.open("Native streaming");
    // A preamble long enough to show, then a tool call: the preamble goes, the tool row shows and the reply is the final one.
    const preambleShown=gate(),toTool=gate();
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:PREAMBLE});preambleShown.open();await toTool.promise;hook({type:"tool_call"});return reply(request,"",{toolCalls:[searchCall("stream-search-1")],finishReason:"tool_calls"})},
      async request=>reply(request,"SessionManager is defined in session.js, where refresh() returns true."));
    await fixture.send("Where is SessionManager defined? Do not change any files.");await preambleShown.promise;
    await expect(live(page)).toContainText("searching the repository for the SessionManager class");
    toTool.open();
    await expect(page.locator(".history-assistant").filter({hasText:"SessionManager is defined in session.js"})).toHaveCount(1,{timeout:10_000});
    await expect(page.locator(".tool-event").filter({hasText:"Searched SessionManager"}).first()).toBeVisible();
    await expect(page.getByText("searching the repository for the SessionManager class",{exact:false})).toHaveCount(0);await expect(live(page)).toHaveCount(0);

    // A failed attempt: its sentinel draft is cleared and the reply is the retry's.
    const sentinelShown=gate(),fail=gate();
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:SENTINEL});sentinelShown.open();await fail.promise;throw Object.assign(new Error("HTTP 503: upstream unavailable"),{status:503,retryable:true})},
      async(request,hook)=>{hook({type:"text",delta:RETRIED});return reply(request,RETRIED)});
    await fixture.send("Explain why the retry happened.");await sentinelShown.promise;
    await expect(live(page)).toContainText("SENTINEL-7f3a");
    const seenRetry=await watchLiveReply(page);fail.open();
    await expect(page.locator(".history-assistant").filter({hasText:"The retried attempt answered on its own."})).toHaveCount(1,{timeout:10_000});
    await expect(page.getByText("SENTINEL-7f3a",{exact:false})).toHaveCount(0);await expect(live(page)).toHaveCount(0);
    const retrySeen=await seenRetry();expect(retrySeen.some(text=>text.includes("SENTINEL-7f3a")&&text.includes("retried attempt")),JSON.stringify(retrySeen)).toBe(false);

    // A short preamble before a tool call never shows.
    const seenShort=await watchLiveReply(page);
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:"Let me look at the session file first."});hook({type:"tool_call"});return reply(request,"",{toolCalls:[searchCall("stream-search-2")],finishReason:"tool_calls"})},
      async request=>reply(request,"session.js exports SessionManager."));
    await fixture.send("Explain session.js in one paragraph.");
    await expect(page.locator(".history-assistant").filter({hasText:"session.js exports SessionManager."})).toHaveCount(1,{timeout:10_000});
    const shortSeen=await seenShort();expect(shortSeen.filter(text=>text.includes("Let me look")),JSON.stringify(shortSeen)).toEqual([]);
    expect(shortSeen.every(text=>"session.js exports SessionManager.".startsWith(text.trim())),JSON.stringify(shortSeen)).toBe(true);
    expect(fixture.script).toHaveLength(0);
  }finally{await fixture.close()}
});

test("Stop clears a streaming Native draft and the turn shows as stopped without a reply",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page),streamed=gate();
  fixture.script.push(async(request,hook)=>{hook({type:"text",delta:ANSWER_HEAD});streamed.open();await untilAborted(request.signal)});
  try{
    await fixture.open("Native streaming");await fixture.send("Explain what happens when I press Stop.");await streamed.promise;
    await expect(live(page)).toContainText("Trebell Native answers with the model its thread names.");
    await stop(page).click();
    await expect(page.getByTestId("turn-outcome").last()).toContainText("stopped",{timeout:10_000});
    await expect(live(page)).toHaveCount(0);
    await expect(page.locator(".history-assistant:not(.turn-outcome-row)").filter({hasText:"Trebell Native answers with the model its thread names."})).toHaveCount(0);
    await expect(page.getByText("Trebell Native answers with the model its thread names.",{exact:false})).toHaveCount(0);
  }finally{await fixture.close()}
});

test("a coding prompt the completion gate judges is never streamed",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page);
  fixture.script.push(
    async(request,hook)=>{hook({type:"text",delta:PREAMBLE});return reply(request,"",{toolCalls:[{id:"stream-edit",namespace:"trebell_workspace",name:"replace_text",arguments:JSON.stringify({path:"session.js",old_text:"return true",new_text:"return false"})}],finishReason:"tool_calls"})},
    async(request,hook)=>{hook({type:"text",delta:ANSWER_HEAD});return reply(request,"refresh() in session.js now returns false.")},
    async request=>reply(request,'{"status":"complete","unresolved":[],"reason":"session.js now returns false from refresh()."}'),
  );
  try{
    await fixture.open("Native streaming");const seen=await watchLiveReply(page);
    await fixture.send("Fix the bug in session.js so refresh returns false.");
    await expect(page.locator(".history-assistant").filter({hasText:"refresh() in session.js now returns false."})).toHaveCount(1,{timeout:15_000});
    expect(fixture.requests.length).toBeGreaterThanOrEqual(3);expect(fixture.requests.every(request=>request.hooked===false),JSON.stringify(fixture.requests)).toBe(true);
    const shown=await seen();expect(shown.every(text=>"refresh() in session.js now returns false.".startsWith(text.trim())),JSON.stringify(shown)).toBe(true);
    await expect(page.getByText("searching the repository for the SessionManager class",{exact:false})).toHaveCount(0);
  }finally{await fixture.close()}
});

test("a Native thread left and reopened mid-stream shows no stale draft, replays a draft that began while it opened, and keeps the final reply",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Alpha stream",preview:"Alpha"},{name:"Beta quiet",preview:"Beta"}]});
  const oneShown=gate(),toTwo=gate(),twoSent=gate(),toThree=gate(),threeSent=gate(),toTool=gate(),finalSent=gate(),finish=gate();
  fixture.script.push(
    async(request,hook)=>{
      hook({type:"text",delta:ALPHA_ONE});oneShown.open();await toTwo.promise;hook({type:"text",delta:ALPHA_TWO});twoSent.open();
      await toThree.promise;hook({type:"text",delta:ALPHA_THREE});threeSent.open();await toTool.promise;hook({type:"tool_call"});
      return reply(request,"",{toolCalls:[searchCall("alpha-search")],finishReason:"tool_calls"});
    },
    async(request,hook)=>{hook({type:"text",delta:ALPHA_FINAL});finalSent.open();await finish.promise;return reply(request,ALPHA_FINAL)},
  );
  try{
    await fixture.open("Alpha stream");await fixture.send("Explain how the alpha thread answers.");await oneShown.promise;
    await expect(live(page)).toContainText("ALPHA-ONE");
    // Away to the other thread: the alpha draft goes with it, and its next part arrives while beta is open.
    await fixture.open("Beta quiet");await expect(live(page)).toHaveCount(0);
    toTwo.open();await twoSent.promise;await page.waitForTimeout(150);await expect(page.getByText("ALPHA-TWO",{exact:false})).toHaveCount(0);
    // Back to alpha while the relay holds its history. During the hold the old draft goes on (it began before the hold, so
    // its frames cannot be placed), then the call turns to its search and the next call's draft begins; all of it replays.
    const release=fixture.holdOpening(fixture.threads[0].id);
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Alpha stream"]')});await row.locator(".thread-main").click();
    await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Opening thread…",{timeout:10_000});
    const seen=await watchLiveReply(page);
    toThree.open();await threeSent.promise;toTool.open();await finalSent.promise;await page.waitForTimeout(150);
    await expect(page.getByText("ALPHA-FINAL",{exact:false})).toHaveCount(0);
    release();
    await expect(live(page)).toContainText("ALPHA-FINAL",{timeout:10_000});await expect(live(page)).not.toContainText("ALPHA-ONE");
    finish.open();
    await expect(page.locator(".history-assistant").filter({hasText:"ALPHA-FINAL"})).toHaveCount(1,{timeout:10_000});await expect(live(page)).toHaveCount(0);
    const shown=await seen();expect(shown.filter(text=>/ALPHA-(?:ONE|TWO|THREE)/.test(text)),JSON.stringify(shown)).toEqual([]);
    for(const marker of ["ALPHA-ONE","ALPHA-TWO","ALPHA-THREE"])await expect(page.getByText(marker,{exact:false})).toHaveCount(0);
  }finally{toTwo.open();toThree.open();toTool.open();finish.open();await fixture.close()}
});

test("steering a streaming Native turn withdraws its draft and the steered call streams from its first character",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page),oneShown=gate(),twoShown=gate(),finish=gate();
  fixture.script.push(
    async(request,hook)=>{hook({type:"text",delta:STEER_ONE});oneShown.open();await untilAborted(request.signal)},
    async(request,hook)=>{hook({type:"text",delta:STEER_TWO});twoShown.open();await finish.promise;return reply(request,STEER_TWO)},
  );
  try{
    await fixture.open("Native streaming");await fixture.send("Describe how a steered turn continues.");await oneShown.promise;
    await expect(live(page)).toContainText("STEER-ONE");
    const thread=fixture.threads[0],turnId=fixture.threadStore.get(thread.id).turns.at(-1).id;
    const steered=await fixture.rpc("turn/steer",{threadId:thread.id,expectedTurnId:turnId,input:[{type:"text",text:"Answer the redirected question instead."}]});expect(steered.accepted).toBe(true);
    await twoShown.promise;
    await expect(live(page)).toContainText("STEER-TWO");await expect(live(page)).not.toContainText("STEER-ONE");
    finish.open();
    await expect(page.locator(".history-assistant").filter({hasText:"STEER-TWO"})).toHaveCount(1,{timeout:10_000});
    await expect(page.getByText("STEER-ONE",{exact:false})).toHaveCount(0);await expect(live(page)).toHaveCount(0);
  }finally{finish.open();await fixture.close()}
});
