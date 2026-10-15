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

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const frames=(page,count)=>page.evaluate(total=>new Promise(resolve=>{let left=total;const tick=()=>--left>0?requestAnimationFrame(tick):resolve();requestAnimationFrame(tick)}),count);

// The Native relay with one imported thread of turnCount turns (each "Routine Native history message N." unless userText says
// otherwise, answered "Native historical answer N."), opened from the sidebar.
async function openNativeHistory(page,{turnCount,userText=index=>`Routine Native history message ${index}.`}){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-history-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const turns=Array.from({length:turnCount},(_,index)=>({id:`find-turn-${index}`,startedAt:1_700_000_000+index,completedAt:1_700_000_001+index,durationMs:1000,error:null,status:"completed",items:[{id:`find-user-${index}`,type:"userMessage",clientId:null,content:[{type:"text",text:userText(index)}]},{id:`find-answer-${index}`,type:"agentMessage",text:`Native historical answer ${index}.`}]}));
  const thread=threadStore.importHistory({runtime:"native",cwd:repo,providerSessionId:"native-history-session",model:"gpt-5.6",name:"Native long history",preview:"Long paginated Native history",turns,providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null}});
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async request=>({id:"unused-history-provider",provider:request.provider,model:request.model,text:"",toolCalls:[],finishReason:"stop",usage:{}}),version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const close=async()=>{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})};
  try{
    const project={id:"native-history-project",name:"Native History Project",path:repo,environmentId:null,effectiveSettings:{}};let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
    const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST")uiMeta={...uiMeta,...(route.request().postDataJSON()?.patch||{})};await json(route,uiMeta)});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,{checkpoints:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native long history"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    await expect(page.getByText(`Native historical answer ${turnCount-1}.`,{exact:true})).toBeVisible({timeout:10_000});
  }catch(error){await close();throw error}
  return {close};
}

test("Trebell Native finds an old conversation match that is not initially mounted",async({page})=>{
  test.setTimeout(45_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-thread-find-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),needle="ancient-zebra-marker-417";
  const turns=Array.from({length:65},(_,index)=>({
    id:`find-turn-${index}`,startedAt:1_700_000_000+index,completedAt:1_700_000_001+index,durationMs:1000,error:null,status:"completed",
    items:[
      {id:`find-user-${index}`,type:"userMessage",clientId:null,content:[{type:"text",text:index===0?`Please remember ${needle} from the oldest turn.`:`Routine Native history message ${index}.`}]},
      {id:`find-answer-${index}`,type:"agentMessage",text:`Native historical answer ${index}.`},
    ],
  }));
  const thread=threadStore.importHistory({runtime:"native",cwd:repo,providerSessionId:"native-thread-find-session",model:"gpt-5.6",name:"Native searchable history",preview:"Long paginated Native history",turns,providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null}});
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async request=>({id:"unused-find-provider",provider:request.provider,model:request.model,text:"",toolCalls:[],finishReason:"stop",usage:{}}),version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-find-project",name:"Native Find Project",path:repo,environmentId:null,effectiveSettings:{}};let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native searchable history"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    await expect(page.getByText("Native historical answer 64.",{exact:true})).toBeVisible({timeout:10_000});await expect(page.getByText(`Please remember ${needle} from the oldest turn.`,{exact:true})).toHaveCount(0);
    // The header names the project record, as the sidebar and Projects page do, not its folder ("repo").
    await expect(page.locator(".workspace-breadcrumb .project-crumb").filter({hasNot:page.locator(".sidebar-reopen")})).toHaveText("Native Find Project");
    await page.keyboard.press("Control+f");const find=page.getByTestId("thread-find-bar");await expect(find).toBeVisible();await page.getByTestId("thread-find-input").fill(needle);
    await expect(find.locator(".thread-find-count")).toHaveText("1 / 1",{timeout:10_000});const oldMessage=page.locator(".user-row").filter({hasText:`Please remember ${needle} from the oldest turn.`});await expect(oldMessage).toBeVisible();await expect(oldMessage).toHaveClass(/find-active/);
    // Turns 1-14 are not loaded: a marker in their place says how many, and nothing offers earlier messages above turn 0, the first.
    const gap=page.getByTestId("history-gap");await expect(gap).toContainText("14 turns not loaded");
    await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
    const placement=()=>page.locator(".conversation-history").evaluate(node=>[...node.querySelectorAll("[data-message-id],[data-testid=history-gap]")].slice(0,4).map(row=>row.dataset.messageId||"gap"));
    expect(await placement()).toEqual(["find-user-0","find-answer-0","gap","find-user-15"]);
    // The find bar covers neither the match it jumped to nor the marker below it.
    const clearOfFind=async target=>{const bar=await find.boundingBox(),box=await target.boundingBox();return box.y>=bar.y+bar.height||box.y+box.height<=bar.y||box.x>=bar.x+bar.width||box.x+box.width<=bar.x};
    expect(await clearOfFind(oldMessage.locator(".user-bubble"))).toBe(true);expect(await clearOfFind(gap)).toBe(true);
    let metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await expect(find).toBeVisible();await expect(oldMessage).toBeVisible();metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await oldMessage.evaluate(node=>node.scrollIntoView({block:"start"}));
    expect(await clearOfFind(oldMessage.locator(".user-bubble"))).toBe(true);expect(await clearOfFind(gap)).toBe(true);
    await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-light-1280x800.png",fullPage:true});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // The marker loads the missing turns in place; then the history runs unbroken from turn 0.
    await gap.getByRole("button").click();await expect(gap).toHaveCount(0);await expect(page.locator("[data-message-id]")).toHaveCount(130);
    expect(await placement()).toEqual(["find-user-0","find-answer-0","find-user-1","find-answer-1"]);
    await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-gap-loaded-1280x800.png",fullPage:true});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native global search finds conversation text outside the loaded sidebar page",async({page})=>{
  test.setTimeout(45_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-global-find-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),needle="buried-native-message-908";
  const hidden=threadStore.importHistory({
    runtime:"native",cwd:repo,providerSessionId:"native-hidden-search",model:"gpt-5.6",name:"Hidden Native history",preview:"Not in the first sidebar page",createdAt:1,updatedAt:1,
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null},
    turns:[{id:"hidden-turn",startedAt:1,completedAt:2,durationMs:1000,error:null,status:"completed",items:[{id:"hidden-user",type:"userMessage",clientId:null,content:[{type:"text",text:`The unique searchable phrase is ${needle}.`}]},{id:"hidden-answer",type:"agentMessage",text:"Stored far beyond the loaded sidebar page."}]}],
  });
  for(let index=0;index<100;index++)threadStore.create({runtime:"native",cwd:repo,providerSessionId:`native-dummy-${index}`,model:"gpt-5.6",name:`Recent Native thread ${index}`,preview:"Recent sidebar filler",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null}});
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async request=>({id:"unused-global-find-provider",provider:request.provider,model:request.model,text:"",toolCalls:[],finishReason:"stop",usage:{}}),version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-global-find-project",name:"Native Global Find Project",path:repo,environmentId:null,effectiveSettings:{}};const metas={};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:metas})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();metas[body.threadId]={...(metas[body.threadId]||{}),...(body.patch||{})};return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(metas[body.threadId])})}return route.fulfill({status:200,contentType:"application/json",body:"{}"})});
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:300,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");const hiddenRow=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Hidden Native history"]')});await expect(page.locator(".thread-row").first()).toBeVisible({timeout:10_000});await expect(hiddenRow).toHaveCount(0);
    await page.getByPlaceholder("Search").fill(needle);await expect(hiddenRow).toBeVisible({timeout:10_000});await expect(page.locator(".thread-row")).toHaveCount(1);
    // A decades-old thread reads in years, not as tens of thousands of days.
    await expect(hiddenRow.locator(".thread-main>div>span")).toHaveText(/^gpt-5\.6 · \d+y$/);
    let metrics=await page.locator(".app-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-global-thread-search-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await expect(hiddenRow).toBeVisible();metrics=await page.locator(".app-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-global-thread-search-1280x800.png",fullPage:true});
    expect(hidden.id).toBeTruthy();
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("opening, using and closing thread find never moves the rows being read",async({page})=>{
  test.setTimeout(45_000);
  const needle="window-heron-marker-318";
  const fixture=await openNativeHistory(page,{turnCount:65,userText:index=>index===40?`Turn ${index} talks about ${needle} today.`:`Routine Native history message ${index}.`});
  try{
    const scroller=page.locator(".conversation-scroll"),find=page.getByTestId("thread-find-bar"),input=page.getByTestId("thread-find-input");
    // A row well inside the view, and where it sits.
    const readRow=()=>scroller.evaluate(node=>{const root=node.getBoundingClientRect();const row=[...node.querySelectorAll("[data-message-id]")].find(item=>{const rect=item.getBoundingClientRect();return rect.top>root.top+150&&rect.bottom<root.bottom});return row?{id:row.dataset.messageId,offset:row.getBoundingClientRect().top-root.top}:null});
    const offsetOf=id=>scroller.evaluate((node,messageId)=>{const row=node.querySelector(`[data-message-id="${messageId}"]`);return row?row.getBoundingClientRect().top-node.getBoundingClientRect().top:null},id);
    const clearOfFind=async target=>{const bar=await find.boundingBox(),box=await target.boundingBox();return box.y>=bar.y+bar.height||box.y+box.height<=bar.y||box.x>=bar.x+bar.width||box.x+box.width<=bar.x};
    await scroller.evaluate(node=>{node.scrollTop=Math.round(node.scrollHeight*0.45)});await frames(page,4);
    let read=await readRow();expect(read).toBeTruthy();
    await page.keyboard.press("Control+f");await expect(find).toBeVisible();await frames(page,4);
    expect(Math.abs(await offsetOf(read.id)-read.offset)).toBeLessThanOrEqual(1);
    // The match and its snippet show; the jump lands clear of the taller bar.
    await input.fill(needle);await expect(find.locator(".thread-find-count")).toHaveText("1 / 1",{timeout:10_000});await expect(find.locator(".thread-find-snippet")).toBeVisible();
    const match=page.locator(".user-row").filter({hasText:needle});await expect(match).toHaveClass(/find-active/);await frames(page,8);
    expect(await clearOfFind(match.locator(".user-bubble"))).toBe(true);
    read=await readRow();expect(read).toBeTruthy();
    await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-mid-thread-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-mid-thread-light-1280x800.png"});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    await input.press("Escape");await expect(find).toBeHidden();await frames(page,4);
    expect(Math.abs(await offsetOf(read.id)-read.offset)).toBeLessThanOrEqual(1);
    await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-closed-mid-thread-1280x800.png"});
    // At the very top of the thread the opening strip pushes the first rows down instead, so nothing starts under the bar.
    await scroller.evaluate(node=>{node.scrollTop=0});await frames(page,4);
    await page.keyboard.press("Control+f");await expect(find).toBeVisible();await frames(page,4);
    const loadEarlier=page.getByRole("button",{name:"Load earlier messages"});await expect(loadEarlier).toBeVisible();
    expect(await clearOfFind(loadEarlier)).toBe(true);
    await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-top-1280x800.png"});
  }finally{await fixture.close()}
});

test("turns loaded above a find hit in an item-paged thread carry the done pills the rest of it shows",async({page})=>{
  test.setTimeout(45_000);
  const needle="middle-otter-marker-552";
  const fixture=await openNativeHistory(page,{turnCount:200,userText:index=>index===5?`Turn ${index} mentions ${needle} here.`:`Routine Native history message ${index}.`});
  try{
    // Every reply on screen has its done pill, from the outcome pages beside the item pages. The list is virtual, so the replies
    // are read where they show, not counted across its chunks.
    const pillsInView=()=>page.locator(".conversation-scroll").evaluate(node=>{
      const view=node.getBoundingClientRect();
      return [...node.querySelectorAll(".history-assistant[data-message-id]")].filter(row=>{const box=row.getBoundingClientRect();return box.height&&box.bottom>view.top&&box.top<view.bottom}).map(row=>row.querySelector("[data-testid=turn-outcome]")?.textContent||"none");
    });
    const expectDonePills=async()=>{const pills=await pillsInView();expect(pills.length).toBeGreaterThan(0);expect(pills).toEqual(pills.map(()=>"done · 1.0s"))};
    await expectDonePills();
    await page.keyboard.press("Control+f");const find=page.getByTestId("thread-find-bar");await page.getByTestId("thread-find-input").fill(needle);
    await expect(find.locator(".thread-find-count")).toHaveText("1 / 1",{timeout:10_000});await expect(page.locator('[data-message-id="find-user-5"]')).toHaveClass(/find-active/);
    await expect(page.getByTestId("history-gap")).toBeVisible();
    // The turn pages loaded above the hit carry theirs too: no turn lacks what the others show.
    await page.locator(".conversation-scroll").evaluate(node=>{node.scrollTop=0});await frames(page,4);
    await page.getByRole("button",{name:"Load earlier messages"}).click();
    await expect(page.locator('[data-message-id="find-user-0"]')).toBeAttached({timeout:10_000});await frames(page,8);
    await expect(page.locator('[data-message-id="find-answer-4"]')).toBeVisible();
    await expectDonePills();
    for(const index of [0,1,2,3,4])await expect(page.locator(`[data-message-id="find-answer-${index}"] [data-testid=turn-outcome]`)).toHaveText("done · 1.0s");
    await page.screenshot({animations:"disabled",path:auditDir+"native-thread-find-loaded-above-hit-1280x800.png"});
  }finally{await fixture.close()}
});

// Escape closes the find bar from its Previous and Next match buttons as from its field: after a click on one, and after the one in
// use turns off at the first or the last match, clicked or pressed from the keyboard, in a wide window and a narrow one.
test("Escape closes thread find after its Previous or Next match button was used, as it does from the find field",async({page})=>{
  test.setTimeout(60_000);
  const needle="tern-marker-614";
  const fixture=await openNativeHistory(page,{turnCount:30,userText:index=>[12,20,27].includes(index)?`Turn ${index} notes the ${needle} here.`:`Routine Native history message ${index}.`});
  try{
    const find=page.getByTestId("thread-find-bar"),input=page.getByTestId("thread-find-input"),count=find.locator(".thread-find-count");
    const previous=find.getByRole("button",{name:"Previous match"}),next=find.getByRole("button",{name:"Next match"});
    const openFind=async()=>{await page.keyboard.press("Control+f");await expect(input).toBeFocused();await page.keyboard.type(needle,{delay:8});await expect(count).toHaveText("1 / 3",{timeout:10_000})};
    for(const [mode,width] of [["dark",1280],["light",900]]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.setViewportSize({width,height:800});
      // Next match clicked: the keyboard is on it, and Escape closes the bar.
      await openFind();
      await next.click();await expect(count).toHaveText("2 / 3");await expect(next).toBeFocused();
      await page.keyboard.press("Escape");await expect(find).toBeHidden();
      // Previous match clicked back to the first match, where it turns off under the pointer.
      await openFind();
      await next.click();await expect(count).toHaveText("2 / 3");
      await previous.click();await expect(count).toHaveText("1 / 3");await expect(previous).toBeDisabled();
      await page.keyboard.press("Escape");await expect(find).toBeHidden();
      // From the keyboard: Tab from the field to Next match and Enter to the last match, where it turns off.
      await openFind();
      await page.keyboard.press("Tab");await expect(next).toBeFocused();
      await page.keyboard.press("Enter");await expect(count).toHaveText("2 / 3");
      await page.keyboard.press("Enter");await expect(count).toHaveText("3 / 3");await expect(next).toBeDisabled();
      await page.screenshot({animations:"disabled",path:auditDir+`native-thread-find-last-match-${mode}-${width}x800.png`});
      await page.keyboard.press("Escape");await expect(find).toBeHidden();
      await page.screenshot({animations:"disabled",path:auditDir+`native-thread-find-closed-from-buttons-${mode}-${width}x800.png`});
    }
  }finally{await fixture.close()}
});
