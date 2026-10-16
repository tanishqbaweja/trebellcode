import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

function turn(index){
  const marker=[3,15,18].includes(index)?"needle ":"";
  const padding=`Message ${index} ${marker}`+"history ".repeat(34);
  return {id:`turn-${index}`,status:"completed",items:[
    {id:`user-${index}`,type:"userMessage",content:[{type:"inputText",text:`User ${padding}`}]},
    {id:`assistant-${index}`,type:"agentMessage",text:`Assistant ${padding}`},
  ]};
}

function entries(turns){
  return turns.flatMap(value=>value.items.map(item=>({turnId:value.id,item})));
}

const frames=(page,count)=>page.evaluate(total=>new Promise(resolve=>{let left=total;const tick=()=>--left>0?requestAnimationFrame(tick):resolve();requestAnimationFrame(tick)}),count);

// An OpenCode harness with one thread of turnCount short turns ("User history N", "Assistant history N"), served newest first in
// item pages of pageSize, opened from the sidebar.
async function openItemPagedThread(page,{turnCount,pageSize}){
  const thread={id:"item-paged-history",name:"Item paged history",preview:"paging fixture",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-100,updatedAt:Date.now()/1000,turns:[]};
  const newestFirst=Array.from({length:turnCount},(_,index)=>{const turnId="turn-"+String(index+1).padStart(3,"0");return [{turnId,item:{id:"user-"+turnId,type:"userMessage",text:"User history "+(index+1)}},{turnId,item:{id:"agent-"+turnId,type:"agentMessage",text:"Assistant history "+(index+1)}}]}).flat().reverse();
  const requests=[],http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"item-paged-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread:{...thread,turns:[]},itemsBackwardsCursor:"latest",turnsBackwardsCursor:null};
      else if(message.method==="thread/items/list"){
        const cursor=message.params?.cursor,start=cursor==="latest"||!cursor?0:Number(String(cursor).replace("older-",""))||0;
        result={data:newestFirst.slice(start,start+pageSize),nextCursor:start+pageSize<newestFirst.length?"older-"+(start+pageSize):null,backwardsCursor:"latest"};
      }
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  const close=async()=>{for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))};
  try{
    const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"opencode",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${port}`,cwd:process.cwd(),platform:process.platform,version:"item-paged-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["opencode/test-model"],metadata:{provider:"opencode",models:[{id:"opencode/test-model",name:"Test model",provider:"opencode"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/git\/info\?/,route=>json(route,{isGit:false,root:process.cwd(),branch:null,status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?route.request().postDataJSON()?.patch||{}:{}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,{supported:false}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await page.getByRole("button",{name:/Item paged history/}).click();
    await expect(page.getByText("Assistant history "+turnCount,{exact:true})).toBeVisible({timeout:10_000});
  }catch(error){await close();throw error}
  return {requests,close};
}

// Where each message row in view sits, by id.
const rowsInView=scroller=>scroller.evaluate(node=>{const root=node.getBoundingClientRect();return Object.fromEntries([...node.querySelectorAll("[data-message-id]")].filter(row=>{const rect=row.getBoundingClientRect();return rect.bottom>root.top&&rect.top<root.bottom}).map(row=>[row.dataset.messageId,Math.round(row.getBoundingClientRect().top-root.top)]))});

test("an older page above a newest page that fits the view keeps the rows in view where they were",async({page})=>{
  test.setTimeout(35_000);
  const fixture=await openItemPagedThread(page,{turnCount:20,pageSize:4});
  try{
    const scroller=page.locator(".conversation-scroll");await frames(page,4);
    expect(await scroller.evaluate(node=>node.scrollHeight<=node.clientHeight)).toBe(true);
    const before=await rowsInView(scroller);expect(Object.keys(before)).toEqual(["user-turn-019","agent-turn-019","user-turn-020","agent-turn-020"]);
    await page.getByRole("button",{name:"Load earlier messages",exact:true}).click();
    await expect.poll(()=>fixture.requests.filter(item=>item.method==="thread/items/list").length).toBe(2);
    await expect(page.locator('[data-message-id="user-turn-017"]')).toBeAttached();await frames(page,16);
    // The empty space that was below them stays, so they keep their spots; the older page sits above, out of view.
    const after=await rowsInView(scroller);
    for(const [id,offset] of Object.entries(before))expect(Math.abs(after[id]-offset),id).toBeLessThanOrEqual(1);
    await page.screenshot({animations:"disabled",path:auditDir+"item-paged-short-page-loaded-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({animations:"disabled",path:auditDir+"item-paged-short-page-loaded-light-1280x800.png"});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // Scrolling up gives the held space back: at the end again, the newest row ends where a thread's end always does.
    const held=await scroller.evaluate(node=>node.scrollHeight);
    await scroller.evaluate(node=>{node.scrollTop=0});await frames(page,4);await expect(page.getByRole("button",{name:"Load earlier messages",exact:true})).toBeInViewport();
    await scroller.evaluate(node=>{node.scrollTop=node.scrollHeight});await frames(page,4);
    expect(await scroller.evaluate(node=>node.scrollHeight)).toBeLessThan(held-100);
    const gapBelow=await scroller.evaluate(node=>node.getBoundingClientRect().bottom-node.querySelector('[data-message-id="agent-turn-020"]').getBoundingClientRect().bottom);
    expect(gapBelow).toBeLessThan(120);
  }finally{await fixture.close()}
});

test("a scroll right after an older page lands is kept, also when that page makes the list virtual",async({page})=>{
  test.setTimeout(35_000);
  const fixture=await openItemPagedThread(page,{turnCount:200,pageSize:100});
  try{
    const scroller=page.locator(".conversation-scroll");await scroller.evaluate(node=>{node.scrollTop=0});await frames(page,3);
    const before=await rowsInView(scroller);expect(before["user-turn-151"]).toBeGreaterThan(0);
    // The moment the page lands (the list turns into virtual chunks), scroll 400px down once, as a wheel notch would.
    await page.evaluate(()=>{
      const node=document.querySelector(".conversation-scroll"),history=node.querySelector(".conversation-history");window.__landing=null;
      const observer=new MutationObserver(()=>{
        if(!history.querySelector(".conversation-virtual-chunk"))return;observer.disconnect();
        window.__landing={anchorMounted:Boolean(node.querySelector('[data-message-id="user-turn-151"]'))};node.scrollTop+=400;
      });
      observer.observe(history,{childList:true,subtree:true});
    });
    await page.getByRole("button",{name:"Load earlier messages",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.__landing)).toBeTruthy();await frames(page,20);await page.waitForTimeout(300);
    // The page placed its anchor row exactly (its chunk mounted with it), and the scroll after it was not undone.
    expect((await page.evaluate(()=>window.__landing)).anchorMounted).toBe(true);
    const offset=await scroller.evaluate(node=>{const row=node.querySelector('[data-message-id="user-turn-151"]');return row?row.getBoundingClientRect().top-node.getBoundingClientRect().top:null});
    expect(Math.abs(offset-(before["user-turn-151"]-400))).toBeLessThan(6);
    await page.screenshot({animations:"disabled",path:auditDir+"item-paged-scroll-after-landing-1280x800.png"});
  }finally{await fixture.close()}
});

test("Codex thread history opens from bounded item pages and loads older items on demand",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"history-page-fixture",name:"Paginated history fixture",preview:"Bounded Codex history",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const legacyThread={id:"history-legacy-fixture",name:"Legacy history fixture",preview:"Fallback full history",historyMode:"legacy",cwd:process.cwd(),createdAt:Date.now()-2000,updatedAt:Date.now()-500,turns:[]};
  const latest=Array.from({length:10},(_,index)=>turn(index+11)).reverse();
  const older=Array.from({length:10},(_,index)=>turn(index+1)).reverse();
  const calls=[];
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"history-fixture"};
      else if(message.method==="thread/list")result={data:[thread,legacyThread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume"){
        if(message.params.threadId===legacyThread.id)result=message.params.excludeTurns===false?{thread:{...legacyThread,turns:[turn(99)]}}:{thread:legacyThread};
        else result={thread,itemsBackwardsCursor:"latest-items",turnsBackwardsCursor:"latest-turn"};
      }
      else if(message.method==="thread/turns/list"){
        const direct=String(message.params.cursor||"").match(/^cursor-turn-(\d+)$/);
        // Ascending from a find hit's turn: that turn and every later one (how the window counts the turns it skips).
        if(direct&&message.params.sortDirection==="asc")result={data:Array.from({length:21-Number(direct[1])},(_,index)=>turn(Number(direct[1])+index)),nextCursor:null,backwardsCursor:null};
        else result=direct?{data:[turn(Number(direct[1]))],nextCursor:null,backwardsCursor:null}:{data:message.params.cursor==="older-page"?older:[],nextCursor:null,backwardsCursor:"older-anchor"};
      }
      else if(message.method==="thread/searchOccurrences"){
        if(message.params.cursor==="find-page-2")result={data:[{turnId:"turn-18",itemId:"assistant-18",snippet:"Assistant Message 18 needle history",snippetMatchRange:{start:21,end:27},turnCursor:"cursor-turn-18"}],nextCursor:null};
        else result={data:[
          {turnId:"turn-3",itemId:"user-3",snippet:"User Message 3 needle history",snippetMatchRange:{start:15,end:21},turnCursor:"cursor-turn-3"},
          {turnId:"turn-15",itemId:"assistant-15",snippet:"Assistant Message 15 needle history",snippetMatchRange:{start:21,end:27},turnCursor:"cursor-turn-15"},
        ],nextCursor:"find-page-2"};
      }
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list"){
        result=message.params.threadId===thread.id?{data:[
          {type:"turnStarted",position:100,turnId:"turn-20",startedAt:Date.now()-1500},
          {type:"item",position:101,turnId:"turn-20",item:{id:"history-command-20",type:"commandExecution",command:"npm test -- --runInBand",cwd:process.cwd(),status:"completed",aggregatedOutput:"20 tests passed",exitCode:0,durationMs:1200}},
          {type:"turnCompleted",position:102,turnId:"turn-20",status:"completed",startedAt:Date.now()-1500,completedAt:Date.now()-300,durationMs:1200},
        ],nextCursor:null,activeRealtimeSessionAtPageStart:null}:{data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      }
      else if(message.method==="thread/items/list"){
        if(message.params.turnId){
          const direct=String(message.params.turnId).match(/^turn-(\d+)$/);result={data:direct?entries([turn(Number(direct[1]))]):[],nextCursor:null};
        }else if(message.params.cursor==="latest-items")result={data:entries([...latest].reverse()).reverse(),nextCursor:"older-items",backwardsCursor:"latest-items"};
        else if(message.params.cursor==="older-items")result={data:entries([...older].reverse()).reverse(),nextCursor:null,backwardsCursor:"older-items"};
        else result={data:[],nextCursor:null};
      }
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await keepThreadMeta(page);
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"history-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null},[legacyThread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:/Paginated history fixture/}).click();
    await expect(page.getByText(/User Message 11 history/)).toBeVisible();await expect(page.getByText(/Assistant Message 20 history/)).toBeVisible();
    await expect(page.getByText(/User Message 1 history/)).toHaveCount(0);
    expect(await page.locator("[data-message-id]").evaluateAll(nodes=>nodes.map(node=>node.dataset.messageId))).toEqual(
      Array.from({length:10},(_,index)=>["user-"+(index+11),"assistant-"+(index+11)]).flat()
    );
    const resumeCall=calls.find(call=>call.method==="thread/resume");
    expect(resumeCall?.params?.excludeTurns).toBe(true);expect(resumeCall?.params?.initialTurnsPage).toBeUndefined();
    const initialItems=calls.find(call=>call.method==="thread/items/list"&&call.params?.cursor==="latest-items");
    expect(initialItems?.params).toEqual({threadId:thread.id,cursor:"latest-items",limit:100,sortDirection:"desc"});
    // The rows come from item pages; the one turn page read beside them has no items, only how each turn ended.
    expect(calls.filter(call=>call.method==="thread/turns/list").map(call=>call.params)).toEqual([{threadId:thread.id,cursor:"latest-turn",limit:200,sortDirection:"desc",itemsView:"notLoaded"}]);
    const restoredCommand=page.locator(".tool-event").filter({hasText:"npm test -- --runInBand"});await expect(restoredCommand).toBeVisible();await restoredCommand.locator("summary").click();await expect(restoredCommand).toContainText("20 tests passed");
    // The expanded command shows the command and its output once each, not again inside a raw event dump.
    await expect(restoredCommand.locator(".tool-json")).toHaveCount(0);
    const timelineCall=calls.find(call=>call.method==="thread/timeline/list"&&call.params?.threadId===thread.id);expect(timelineCall?.params).toEqual({threadId:thread.id,cursor:null,limit:100});
    await page.setViewportSize({width:1280,height:800});await restoredCommand.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"chat-restored-activity-1280x800.png",fullPage:false});await page.setViewportSize({width:1600,height:980});
    await page.keyboard.press("Control+f");
    const findBar=page.getByTestId("thread-find-bar");await expect(findBar).toBeVisible();
    const findInput=page.getByTestId("thread-find-input");await findInput.fill("needle");
    await expect(findBar.locator(".thread-find-count")).toHaveText("1 / 2+");
    await expect(page.locator('[data-message-id="user-3"]')).toHaveClass(/find-active/);
    const directTurn=calls.find(call=>call.method==="thread/items/list"&&call.params?.turnId==="turn-3");expect(directTurn?.params).toEqual({threadId:thread.id,turnId:"turn-3",cursor:null,limit:100,sortDirection:"asc"});
    // Turn 3 sits apart from the loaded turns 11-20: the turns between them are marked, counted from metadata pages, not skipped.
    const gap=page.getByTestId("history-gap");await expect(gap).toContainText("7 turns not loaded");
    expect(await page.locator(".conversation-history").evaluate(node=>[...node.querySelectorAll("[data-message-id],[data-testid=history-gap]")].slice(0,4).map(row=>row.dataset.messageId||"gap"))).toEqual(["user-3","assistant-3","gap","user-11"]);
    expect(calls.find(call=>call.method==="thread/turns/list"&&call.params?.sortDirection==="asc")?.params).toEqual({threadId:thread.id,cursor:"cursor-turn-3",limit:200,sortDirection:"asc",itemsView:"notLoaded"});
    await page.screenshot({animations:"disabled",path:auditDir+"chat-thread-find-1600x980.png",fullPage:true});
    await findBar.getByRole("button",{name:"Next match"}).click();await expect(findBar.locator(".thread-find-count")).toHaveText("2 / 2+");await expect(page.locator('[data-message-id="assistant-15"]')).toHaveClass(/find-active/);
    await findBar.getByRole("button",{name:"Next match"}).click();await expect(findBar.locator(".thread-find-count")).toHaveText("3 / 3");await expect(page.locator('[data-message-id="assistant-18"]')).toHaveClass(/find-active/);
    expect(calls.some(call=>call.method==="thread/searchOccurrences"&&call.params?.cursor==="find-page-2")).toBe(true);
    await page.setViewportSize({width:1280,height:800});
    const findBox=await findBar.boundingBox(),workspaceBox=await page.locator(".chat-workspace").boundingBox();expect(findBox).toBeTruthy();expect(workspaceBox).toBeTruthy();expect(findBox.x+findBox.width).toBeLessThanOrEqual(workspaceBox.x+workspaceBox.width+1);
    await page.screenshot({animations:"disabled",path:auditDir+"chat-thread-find-1280x800.png",fullPage:true});
    await page.setViewportSize({width:1600,height:980});
    await findBar.getByRole("button",{name:"Close find"}).click();await expect(findBar).toBeHidden();
    const scroller=page.locator(".conversation-scroll");await scroller.evaluate(node=>{node.scrollTop=0});
    // Rows use content-visibility:auto, so ones that were off screen paint on the next frame after the jump: wait two frames
    // so the capture shows the history at the top rather than the frame before those rows paint.
    await expect(page.locator('[data-message-id="user-3"]')).toBeInViewport();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({animations:"disabled",path:auditDir+"chat-paginated-history-1600x980.png",fullPage:true});
    const before=await scroller.evaluate(node=>{
      const root=node.getBoundingClientRect();
      const anchor=[...node.querySelectorAll("[data-message-id]")].find(row=>{const rect=row.getBoundingClientRect();return rect.bottom>root.top&&rect.top<root.bottom});
      return {top:node.scrollTop,height:node.scrollHeight,anchorId:anchor?.dataset?.messageId||null,anchorOffset:anchor?anchor.getBoundingClientRect().top-root.top:null};
    });
    // The page before turn 11 reaches turn 3: the gap closes and the history runs unbroken from turn 1.
    await gap.getByRole("button").click();
    await expect(page.getByText(/User Message 1 history/)).toBeVisible();await expect(gap).toHaveCount(0);await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
    expect((await page.locator("[data-message-id]").evaluateAll(nodes=>nodes.map(node=>node.dataset.messageId))).slice(0,4)).toEqual(["user-1","assistant-1","user-2","assistant-2"]);
    const itemsCall=calls.find(call=>call.method==="thread/items/list"&&call.params?.cursor==="older-items");expect(itemsCall?.params).toEqual({threadId:thread.id,cursor:"older-items",limit:100,sortDirection:"desc"});
    const after=await scroller.evaluate((node,anchorId)=>{
      const root=node.getBoundingClientRect();
      const anchor=[...node.querySelectorAll("[data-message-id]")].find(row=>String(row.dataset?.messageId||"")===String(anchorId||""));
      return {top:node.scrollTop,height:node.scrollHeight,anchorFound:Boolean(anchor),anchorOffset:anchor?anchor.getBoundingClientRect().top-root.top:null};
    },before.anchorId);
    expect(after.height).toBeGreaterThan(before.height);expect(after.top).toBeGreaterThan(0);expect(after.anchorFound).toBe(true);expect(Math.abs(Number(after.anchorOffset)-Number(before.anchorOffset))).toBeLessThan(4);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({animations:"disabled",path:auditDir+"chat-paginated-history-loaded-1280x800.png",fullPage:true});

    await page.getByRole("button",{name:/Legacy history fixture/}).click();
    await expect(page.getByText(/User Message 99 history/)).toBeVisible();
    const legacyResumes=calls.filter(call=>call.method==="thread/resume"&&call.params?.threadId===legacyThread.id);
    expect(legacyResumes).toHaveLength(2);expect(legacyResumes[0].params.excludeTurns).toBe(true);expect(legacyResumes[1].params.excludeTurns).toBe(false);
    await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});

// A Codex thread of 20 turns that opens at turns 11-20, whose older item page fails while failOlder is above 0, with find hits in
// turns 3, 15 and 18 (turn 3 lies apart from the turns loaded, behind a gap of 7).
async function openFailingCodexHistory(page){
  const thread={id:"history-failure-fixture",name:"Failing history fixture",preview:"Older pages fail",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-1000,updatedAt:Date.now()/1000,turns:[]};
  const latest=Array.from({length:10},(_,index)=>turn(index+11)),older=Array.from({length:10},(_,index)=>turn(index+1)),fixture={failOlder:0};
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data)),params=message.params||{};if(message.id==null||!message.method)return;let result={};
      if(message.method==="thread/items/list"&&params.cursor==="older-items"&&fixture.failOlder>0){fixture.failOlder--;ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"The history page could not be read."}}));return}
      const direct=String(params.cursor||"").match(/^cursor-turn-(\d+)$/);
      if(message.method==="initialize")result={userAgent:"history-failure-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:"latest-items",turnsBackwardsCursor:"latest-turn"};
      else if(message.method==="thread/items/list")result=params.turnId?{data:entries([turn(Number(String(params.turnId).replace("turn-","")))]),nextCursor:null}:params.cursor==="older-items"?{data:entries(older).reverse(),nextCursor:null,backwardsCursor:"older-items"}:{data:entries(latest).reverse(),nextCursor:"older-items",backwardsCursor:"latest-items"};
      else if(message.method==="thread/turns/list")result=direct&&params.sortDirection==="asc"?{data:Array.from({length:21-Number(direct[1])},(_,index)=>turn(Number(direct[1])+index)),nextCursor:null}:direct?{data:[turn(Number(direct[1]))],nextCursor:null}:{data:[],nextCursor:null,backwardsCursor:"older-anchor"};
      else if(message.method==="thread/searchOccurrences")result={data:[3,15,18].map(index=>({turnId:"turn-"+index,itemId:(index===3?"user-":"assistant-")+index,snippet:`Message ${index} needle history`,snippetMatchRange:{start:11,end:17},turnCursor:"cursor-turn-"+index})),nextCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      else if(["thread/attachment/list","thread/queue/list","thread/timeline/list","threadSection/list","skills/list","collaborationMode/list"].includes(message.method))result={data:[],nextCursor:null};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  fixture.close=async()=>{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])};
  try{
    const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
    await keepThreadMeta(page);
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"history-failure-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await page.getByRole("button",{name:/Failing history fixture/}).click();await expect(page.getByText(/Assistant Message 20 history/)).toBeVisible({timeout:10_000});
  }catch(error){await fixture.close();throw error}
  return fixture;
}
const shootBothModes=async(page,name)=>{for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await frames(page,3);await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${page.viewportSize().width}x${page.viewportSize().height}.png`})}};

test("Load earlier messages that fails says so under it, in view, and loads the page when pressed again",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await openFailingCodexHistory(page);
  try{
    const scroller=page.locator(".conversation-scroll"),earlier=page.getByRole("button",{name:"Load earlier messages",exact:true}),failures=page.locator(".conversation-history [role=alert]");
    // The wheel up to the top and a click there, which fails: the failure is said under the button, in view, and the button is there
    // to press again, with the keyboard still on it. Nothing of it goes to a turn's card at the end of the thread, out of view.
    await scroller.hover();for(let notch=0;notch<60&&await scroller.evaluate(node=>node.scrollTop>0);notch++)await page.mouse.wheel(0,-20_000);
    await expect(earlier).toBeInViewport();
    fixture.failOlder=1;await earlier.click();
    const topFailure=page.locator(".history-page-control").filter({has:earlier}).getByRole("alert");
    await expect(topFailure).toHaveText("Could not load earlier messages: The history page could not be read.");
    await expect(topFailure).toBeInViewport();await expect(earlier).toBeEnabled();await expect(earlier).toBeFocused();
    await expect(page.locator("[data-testid=activity-card]")).toHaveCount(0);await expect(page.locator(".tool-event")).toHaveCount(0);
    await shootBothModes(page,"history-earlier-page-failed");await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    await earlier.click();
    await expect(page.locator('[data-message-id="user-1"]')).toBeAttached();await expect(failures).toHaveCount(0);
    await expect(earlier).toHaveCount(0);
  }finally{await fixture.close()}
});

test("a history gap whose turns fail to load says so under it, keeps the keyboard on it, and loads them on Enter again",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await openFailingCodexHistory(page);
  try{
    const scroller=page.locator(".conversation-scroll"),failures=page.locator(".conversation-history [role=alert]");
    // A find hit in turn 3 leaves a gap above turn 11. A click on its button fails: the gap says so under it and stays, with the
    // keyboard on its button, and Enter loads the turns.
    await page.getByTestId("composer").click();await page.keyboard.press("Control+f");await page.keyboard.type("needle",{delay:20});
    const gap=page.getByTestId("history-gap");await expect(gap).toContainText("7 turns not loaded");
    await page.keyboard.press("Escape");await expect(page.getByTestId("thread-find-bar")).toBeHidden();
    fixture.failOlder=1;await gap.getByRole("button").click();
    const gapFailure=gap.getByRole("alert");
    await expect(gapFailure).toHaveText("Could not load these turns: The history page could not be read.");
    await expect(gapFailure).toBeInViewport();await expect(gap.getByRole("button")).toContainText("7 turns not loaded");await expect(gap.getByRole("button")).toBeFocused();
    await expect(page.locator("[data-testid=activity-card]")).toHaveCount(0);await expect(page.locator(".tool-event")).toHaveCount(0);
    await shootBothModes(page,"history-gap-failed");
    // In a narrow window the failure wraps under the gap, with no sideways scroll.
    await page.setViewportSize({width:700,height:800});await gap.scrollIntoViewIfNeeded();
    await expect(gapFailure).toBeInViewport();expect(await scroller.evaluate(node=>node.scrollWidth-node.clientWidth)).toBeLessThanOrEqual(1);
    await shootBothModes(page,"history-gap-failed");await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    await page.keyboard.press("Enter");
    await expect(gap).toHaveCount(0);await expect(failures).toHaveCount(0);
    expect((await page.locator("[data-message-id]").evaluateAll(nodes=>nodes.map(node=>node.dataset.messageId))).slice(0,4)).toEqual(["user-1","assistant-1","user-2","assistant-2"]);
  }finally{await fixture.close()}
});
