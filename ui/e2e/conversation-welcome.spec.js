import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The welcome a conversation with nothing in it shows (a new task, a general chat, a thread with nothing in it): it comes up at its
// top, and the box that holds it keeps following the newest message of the conversations that have them. The desktop window's zoom
// lays the page out in a viewport smaller by the zoom in CSS pixels (a 1280x800 window at 150% is 853x533, at 200% 640x400), so these
// checks take those viewports, where the welcome is taller than its box as it is zoomed.
const auditDir=fileURLToPath(new URL("../../visual-audit/conversation-welcome/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const ZOOMED={150:{width:853,height:533},200:{width:640,height:400}};

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function makeTurns(count){
  return Array.from({length:count},(_,index)=>({
    id:"turn-"+index,status:"completed",
    items:[
      {type:"userMessage",id:"user-"+index,content:[{type:"text",text:"User message "+index+" · "+"request ".repeat(4+(index%7))}]},
      {type:"agentMessage",id:"assistant-"+index,text:"Assistant message "+index+" · "+"response ".repeat(10+(index%11))+"\n\n```js\n"+Array.from({length:6},(_,line)=>"const value"+line+" = ["+Array.from({length:12},(_,item)=>item*index+line).join(", ")+"].map(item => item + "+line+");").join("\n")+"\n```"},
    ],
  }));
}
// A Codex-protocol socket that lists the threads given and resumes each with its turns.
async function startHarness(threads){
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    const thread=threads.find(item=>item.id===message.params?.threadId);
    if(message.method==="initialize")result={userAgent:"conversation-welcome-fixture"};
    else if(message.method==="thread/list")result={data:threads.map(item=>({...item,turns:[]})),nextCursor:null};
    else if(message.method==="threadSection/list")result={data:["Pinned","Snoozed","Settled"].map(name=>({id:name,name})),nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:null}:{thread};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(["thread/attachment/list","thread/queue/list","thread/turns/list"].includes(message.method))result={data:[],nextCursor:null};
    else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
    else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+port+"/rpc",async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
// An empty thread and a long one, on a connected Codex harness: a thread opened resumes and lands as in the app (its scroll restored).
async function openApp(page,{viewport,before=null}){
  const cwd=process.cwd(),now=Date.now()/1000,model="test/coding-fast";
  const threads=[
    {id:"empty-thread",name:"Empty thread",preview:"",cwd,model,status:{type:"idle"},createdAt:now-300,updatedAt:now-10,turns:[]},
    {id:"long-thread",name:"Long thread",preview:"150 messages",cwd,model,status:{type:"idle"},createdAt:now-600,updatedAt:now-20,turns:makeTurns(75)},
  ];
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}}]));
  const harness=await startHarness(threads);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"conversation-welcome-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:meta}));
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{provider:"openai",agentRuntime:"codex",ready:true,models:[model],metadata:{provider:"openai",agentRuntime:"codex",models:[{id:model,name:"Coding Fast",agent:"Codex"}]}}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,route=>{
    if(route.request().method()==="POST"){const body=route.request().postDataJSON()||{};meta[body.threadId]={...(meta[body.threadId]||{}),...(body.patch||{})};return json(route,meta[body.threadId])}
    return json(route,meta[new URL(route.request().url()).searchParams.get("threadId")]||{});
  });
  for(const [path,value] of [[/\/api\/checkpoints(?:\?|$)/,{checkpoints:[]}],[/\/api\/projects$/,{projects:[]}],[/\/api\/general-workspace$/,{path:cwd,environmentId:null}],[/\/api\/stashes$/,{stashes:[]}],
    [/\/api\/environment\/themes$/,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}],[/\/api\/recovery$/,{enabled:false,items:[]}]])await page.route(path,route=>json(route,value));
  if(before)await page.addInitScript(before);
  await page.setViewportSize(viewport);
  await page.goto("/");
  await expect(page.locator(".welcome h1")).toBeVisible();
  return harness;
}
// Where the welcome shows: its picture's and title's tops against the header's bottom, and the box's scroll against how far it can.
const readWelcome=page=>page.evaluate(()=>{
  const box=selector=>document.querySelector(selector)?.getBoundingClientRect(),scroller=document.querySelector(".chat-workspace .conversation-scroll");
  return {title:document.querySelector(".welcome h1")?.textContent||null,header:Math.round(box(".chat-workspace .workspace-header").bottom),picture:Math.round(box(".welcome .welcome-mark").top),
    heading:Math.round(box(".welcome h1").top),scrollTop:Math.round(scroller.scrollTop),scrollRoom:scroller.scrollHeight-scroller.clientHeight};
});
const fromItsTop=({header,picture,heading,scrollTop,scrollRoom})=>({belowHeader:picture>=header&&heading>=header,fromTop:scrollTop===0,scrollsForTheRest:scrollRoom>0});
const atItsTop={belowHeader:true,fromTop:true,scrollsForTheRest:true};
// Every frame from now on: the box's scroll while it holds the welcome (frames that show a conversation are left out).
const watchFrames=page=>page.evaluate(()=>{const seen=window.__welcomeFrames=[];const tick=()=>{const box=document.querySelector(".chat-workspace .conversation-scroll"),last=box?.firstElementChild?.lastElementChild;if(last?.classList.contains("welcome"))seen.push(Math.round(box.scrollTop));if(seen.length<2000)requestAnimationFrame(tick)};requestAnimationFrame(tick)});
const framesAwayFromTop=page=>page.evaluate(()=>window.__welcomeFrames.filter(top=>top!==0));
async function openThread(page,name){
  await page.locator(`.thread-main[title="${name}"]`).click();
  await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title",name);
  await expect(page.getByTestId("thread-opening")).toHaveCount(0);
}
async function shoot(page,name,viewport){
  for(const mode of ["dark","light"]){
    const html=page.locator("html");
    if(await html.getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode)}
    await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${viewport.width}x${viewport.height}.png`});
  }
  await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
}

// A thread with nothing in it opened while zoomed came up on its welcome scrolled to its end, picture and title under the header: the
// open restores a thread's place (its end, for one never read), and from the new task's welcome the same element stayed, so nothing
// put it back at its top; from a thread scrolled to its end, its end showed for a frame or more before it moved.
test("a thread with nothing in it opens on its welcome at its top when zoomed in, from the new task and from a thread at its end",async({page})=>{
  test.setTimeout(90_000);
  const viewport=ZOOMED[150],harness=await openApp(page,{viewport});
  try{
    expect(fromItsTop(await readWelcome(page)),"the new task's welcome").toEqual(atItsTop);
    await watchFrames(page);
    await openThread(page,"Empty thread");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const fromNewTask=await readWelcome(page);
    expect.soft(fromItsTop(fromNewTask),"the empty thread opened from the new task: "+JSON.stringify(fromNewTask)).toEqual(atItsTop);
    expect.soft(await framesAwayFromTop(page),"frames that showed the welcome away from its top, opened from the new task").toEqual([]);
    await shoot(page,"empty-thread-opened-from-new-task-150",viewport);
    // The long thread opens at its end; the empty one opened from there comes up at its top, with no frame at the welcome's end first.
    await openThread(page,"Long thread");
    await expect.poll(()=>page.locator(".chat-workspace .conversation-scroll").evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop))).toBeLessThanOrEqual(1);
    await watchFrames(page);
    await openThread(page,"Empty thread");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const fromLong=await readWelcome(page);
    expect.soft(fromItsTop(fromLong),"the empty thread opened from a thread at its end: "+JSON.stringify(fromLong)).toEqual(atItsTop);
    expect.soft(await framesAwayFromTop(page),"frames that showed the welcome away from its top, opened from a thread at its end").toEqual([]);
    // Scrolled by the person, it stays where they put it when the window is resized.
    await page.mouse.move(viewport.width/2,viewport.height/2);await page.mouse.wheel(0,40);
    await expect.poll(async()=>(await readWelcome(page)).scrollTop).toBeGreaterThan(0);
    const scrolled=(await readWelcome(page)).scrollTop;
    await page.setViewportSize({width:viewport.width,height:viewport.height-10});await page.setViewportSize(viewport);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expect((await readWelcome(page)).scrollTop,"a welcome the person scrolled stays where they put it").toBe(scrolled);
  }finally{await harness.close()}
});

// New general chat from the palette over a new task's welcome scrolled down kept that scroll: the welcome stayed the same element with
// new words, so it came up with its picture and title under the header.
test("a general chat from the palette comes up on its welcome at its top, also in place of a welcome scrolled down",async({page})=>{
  test.setTimeout(60_000);
  const viewport=ZOOMED[200],harness=await openApp(page,{viewport});
  try{
    expect(fromItsTop(await readWelcome(page)),"the new task's welcome").toEqual(atItsTop);
    // Down to its suggestions with the wheel, as a person reads on.
    await page.mouse.move(viewport.width/2,viewport.height/2);
    await expect.poll(async()=>{const at=await readWelcome(page);if(at.scrollTop<at.scrollRoom)await page.mouse.wheel(0,40);return at.scrollTop>=at.scrollRoom},{intervals:[150]}).toBe(true);
    expect((await readWelcome(page)).scrollTop).toBeGreaterThan(0);
    await page.keyboard.press("Control+k");
    const palette=page.getByTestId("command-palette");await expect(palette).toBeVisible();
    await page.keyboard.type("New general chat",{delay:20});
    await expect(palette.locator(".command-palette-item.selected")).toContainText("New general chat");
    const scratch=page.waitForResponse(response=>/\/api\/general-workspace$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
    await page.keyboard.press("Enter");await scratch;
    await expect(palette).toHaveCount(0);await expect(page.locator(".welcome h1")).toHaveText("What do you want to think through?");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect.poll(async()=>fromItsTop(await readWelcome(page)),{message:"the general chat's welcome",timeout:3000}).toEqual(atItsTop);
    await shoot(page,"general-chat-from-palette-200",viewport);
  }finally{await harness.close()}
});

// Each resize of the conversation, and each growth of it as a reply streams, asks whether it shows the welcome. That was a selector
// query under the box; it reads the column's last child, with no query under the box. What each costs in this thread (150 messages
// with code, all mounted) is recorded as the test's "cost per check" annotation: in Chromium the query took about 0.2 µs, the read
// about 0.06 µs.
test("a long thread resized does not query its whole conversation to find the welcome it does not show",async({page})=>{
  test.setTimeout(60_000);
  // Every query made under the conversation's box from now on, by the method and selector asked.
  const before=()=>{
    window.__boxQueries=null;
    for(const name of ["querySelector","querySelectorAll"]){
      const original=Element.prototype[name];
      Element.prototype[name]=function(...args){if(window.__boxQueries&&this.classList?.contains("conversation-scroll"))window.__boxQueries.push(name+" "+args[0]);return original.apply(this,args)};
    }
  };
  const viewport={width:1280,height:800},harness=await openApp(page,{viewport,before});
  try{
    await openThread(page,"Long thread");
    const scroll=page.locator(".chat-workspace .conversation-scroll");
    await expect.poll(()=>scroll.evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop))).toBeLessThanOrEqual(1);
    await page.evaluate(()=>{window.__boxQueries=[]});
    for(const height of [760,720,680,800]){
      await page.setViewportSize({width:1280,height});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await expect.poll(()=>scroll.evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop)),{message:"the long thread keeps its end at "+height}).toBeLessThanOrEqual(1);
    }
    const queries=await page.evaluate(()=>window.__boxQueries);
    // What a query under the box costs here, against reading the column's last child, for the record.
    const cost=await scroll.evaluate(node=>{
      const time=read=>{const start=performance.now();for(let i=0;i<20000;i++)read();return (performance.now()-start)/20000};
      return {elements:node.getElementsByTagName("*").length,queryMs:time(()=>node.querySelector(":scope>.conversation-column>.welcome")),lastChildMs:time(()=>node.firstElementChild?.lastElementChild?.classList.contains("welcome"))};
    });
    test.info().annotations.push({type:"cost per check",description:JSON.stringify(cost)});
    console.log("WELCOME CHECK COST "+JSON.stringify(cost));
    expect(queries,"queries under the conversation's box while it was resized").toEqual([]);
  }finally{await harness.close()}
});
