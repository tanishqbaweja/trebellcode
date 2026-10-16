import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

function makeTurns(count){
  return Array.from({length:count},(_,index)=>({
    id:"turn-"+index,status:"completed",
    items:[
      {type:"userMessage",id:"user-"+index,content:[{type:"text",text:"User message "+index+" · "+"request ".repeat(4+(index%7))}]},
      {type:"agentMessage",id:"assistant-"+index,text:"Assistant message "+index+" · "+(index===120?"needle-target · ":"")+"response ".repeat(10+(index%11))},
    ],
  }));
}

async function startHarness(thread,{turnPages=null}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"long-conversation-fixture"};
    else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
    else if(message.method==="threadSection/list")result={data:["Pinned","Snoozed","Settled"].map(name=>({id:name,name})),nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns
      ?{thread:{...thread,turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:turnPages?"page-latest":null}
      :{thread};
    else if(message.method==="thread/turns/list"&&turnPages)result=turnPages[message.params?.cursor]||{data:[],nextCursor:null};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
    else if(message.method==="thread/searchOccurrences")result={data:[{itemId:"assistant-120",turnId:"turn-120",snippet:"Assistant message 120 · needle-target · response",snippetMatchRange:{start:24,end:37}}],nextCursor:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
    else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+port+"/rpc",async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

function makePagedTurns(count){
  return Array.from({length:count},(_,turnIndex)=>({
    id:"paged-turn-"+turnIndex,status:"completed",
    items:Array.from({length:3},(_,messageIndex)=>[
      {type:"userMessage",id:`paged-user-${turnIndex}-${messageIndex}`,content:[{type:"text",text:`Paged user ${turnIndex}.${messageIndex} · ${"request ".repeat(5)}`}]},
      {type:"agentMessage",id:`paged-assistant-${turnIndex}-${messageIndex}`,text:`Paged assistant ${turnIndex}.${messageIndex} · ${"response ".repeat(12)}`},
    ]).flat(),
  }));
}

async function installFixtureRoutes(page,{thread,meta,harness,cwd}){
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"long-conversation-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:meta})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({provider:"openai",agentRuntime:"codex",ready:true,models:[thread.model],metadata:{provider:"openai",agentRuntime:"codex",models:[{id:thread.model,name:"Coding Fast",agent:"Codex"}]}})}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,async route=>{
    if(route.request().method()==="POST"){
      const body=route.request().postDataJSON?.()||JSON.parse(route.request().postData()||"{}");meta[body.threadId]={...(meta[body.threadId]||{}),...(body.patch||{})};
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[body.threadId])});
    }
    const id=new URL(route.request().url()).searchParams.get("threadId");return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[id]||{})});
  });
  await page.route(/\/api\/checkpoints(?:\?|$)/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
  await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
}

test("long conversations keep only nearby message chunks mounted",async({page})=>{
  test.setTimeout(30_000);
  const cwd=process.cwd(),now=Date.now()/1000,turns=makeTurns(300);
  const thread={id:"long-thread",name:"Long conversation stress",preview:"600 messages",cwd,model:"test/coding-fast",status:{type:"idle"},createdAt:now-600,updatedAt:now,turns};
  const meta={[thread.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model:thread.model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}}};
  const harness=await startHarness(thread);
  try{
    await installFixtureRoutes(page,{thread,meta,harness,cwd});
    await page.goto("/");
    await page.locator('.thread-main[title="Long conversation stress"]').click();

    const rows=page.locator("[data-message-id]"),chunks=page.locator("[data-virtual-chunk]");
    await expect(chunks).toHaveCount(19);
    await expect.poll(()=>rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThan(180);
    await expect(page.locator('[data-message-id="assistant-299"]')).toBeVisible();

    await page.keyboard.press(process.platform==="darwin"?"Meta+f":"Control+f");
    await expect(page.getByTestId("thread-find-input")).toBeVisible();
    await page.getByTestId("thread-find-input").fill("needle-target");
    await expect(page.locator('[data-message-id="assistant-120"]')).toBeVisible({timeout:5000});
    await expect(page.locator('[data-message-id="assistant-120"]')).toHaveClass(/find-active/);
    expect(await rows.count()).toBeLessThan(180);
    await page.getByTestId("thread-find-bar").getByRole("button",{name:"Close find"}).click();

    const scroll=page.locator(".conversation-scroll");
    await scroll.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event("scroll",{bubbles:true}))});
    await expect(page.locator('[data-message-id="user-0"]')).toBeVisible({timeout:5000});
    expect(await rows.count()).toBeLessThan(180);

    await scroll.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event("scroll",{bubbles:true}))});
    await expect(page.locator('[data-message-id="assistant-299"]')).toBeVisible({timeout:5000});
    expect(await rows.count()).toBeLessThan(180);

    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"long-conversation-virtualized-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});

test("a click in one turn, the wheel far down and a Shift+click in a later turn select every turn between, the ones scrolled past too",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const cwd=process.cwd(),now=Date.now()/1000,turns=makeTurns(300);
  const thread={id:"long-select-thread",name:"Long selection",preview:"600 messages",cwd,model:"test/coding-fast",status:{type:"idle"},createdAt:now-600,updatedAt:now,turns};
  const meta={[thread.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model:thread.model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}}};
  const harness=await startHarness(thread);
  try{
    await installFixtureRoutes(page,{thread,meta,harness,cwd});
    await page.goto("/");await page.locator('.thread-main[title="Long selection"]').click();
    await expect(page.locator('[data-message-id="assistant-299"]')).toBeVisible();
    const scroll=page.locator(".conversation-scroll"),text=id=>page.locator(`[data-message-id="${id}"] :is(.user-bubble p,.assistant-message-text)`).first();
    // The wheel as a person turns it: long turns until the row is on the page (its chunk mounts near the view), then short ones
    // until it is in the upper half of the view, out of the composer's way.
    const wheelTo=async(id,down)=>{
      const where=()=>page.evaluate(id=>{const node=document.querySelector(`[data-message-id="${id}"]`),view=document.querySelector(".conversation-scroll").getBoundingClientRect();if(!node)return null;const top=node.getBoundingClientRect().top-view.top;return top>=0&&top<=view.height/2?"in":top<0?"above":"below"},id);
      for(let step=0;step<300;step++){
        const at=await where();if(at==="in")return;
        const before=await scroll.evaluate(node=>node.scrollTop);
        await page.mouse.wheel(0,at==="above"?-300:at==="below"?300:down?1200:-1200);await expect.poll(()=>scroll.evaluate(node=>node.scrollTop)).not.toBe(before);
      }
      throw new Error(id+" did not come into view");
    };
    // How many times the selection, or what was copied, names each turn from 148 to 192 ("User message N ·" and "Assistant message
    // N ·"): twice for turns 150 to 190 and never for the others.
    const named=text=>Object.fromEntries(Array.from({length:45},(_,index)=>[148+index,text.split(`message ${148+index} ·`).length-1]));
    const expected=Object.fromEntries(Array.from({length:45},(_,index)=>[148+index,index>=2&&index<=42?2:0]));
    // The wheel up to turn 150 and a click at the start of its message, then the wheel 40 turns down, past chunks of 32 rows that
    // leave the page while out of view (turn 160's among them).
    await scroll.hover();await wheelTo("user-150",false);
    await text("user-150").click({position:{x:1,y:8}});
    await scroll.hover();await wheelTo("assistant-190",true);
    await expect(page.locator('[data-message-id="user-160"]')).toHaveCount(0);
    // Shift+click at the end of turn 190's reply: the selection, and so a copy with Ctrl+C, hold turns 150 to 190 and no other.
    const end=await text("assistant-190").boundingBox();
    await text("assistant-190").click({modifiers:["Shift"],position:{x:end.width-3,y:end.height-5}});
    await expect.poll(async()=>named(await page.evaluate(()=>String(getSelection())))).toEqual(expected);
    await page.evaluate(()=>document.addEventListener("copy",()=>{window.__copied=String(getSelection())},{once:true}));
    await page.keyboard.press("Control+c");
    expect(named(await page.evaluate(()=>window.__copied||""))).toEqual(expected);
    for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:`${auditDir}long-conversation-shift-click-selection-${mode}-1280x800.png`})}
    // A click in the composer ends the selection, and the turns far from the view leave the page again.
    await page.getByTestId("composer").click();await expect(page.locator('[data-message-id="user-160"]')).toHaveCount(0);
  }finally{await harness.close()}
});

test("the newest message stays in view when the view shrinks, and a view scrolled up stays where it was",async({page})=>{
  test.setTimeout(30_000);
  await page.setViewportSize({width:1280,height:800});
  const cwd=process.cwd(),now=Date.now()/1000,turns=makeTurns(40);
  const thread={id:"resize-follow-thread",name:"Resize follow",preview:"80 messages",cwd,model:"test/coding-fast",status:{type:"idle"},createdAt:now-600,updatedAt:now,turns};
  const meta={[thread.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model:thread.model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}}};
  const harness=await startHarness(thread);
  try{
    await installFixtureRoutes(page,{thread,meta,harness,cwd});
    await page.goto("/");
    await page.locator('.thread-main[title="Resize follow"]').click();

    const scroll=page.locator(".conversation-scroll"),newest=page.locator('[data-message-id="assistant-39"]'),composer=page.locator(".composer-wrap");
    const distanceFromEnd=()=>scroll.evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop));
    // The newest message is wholly on screen: inside the view and above the composer floating over its foot.
    const newestInView=async()=>{
      const message=await newest.boundingBox(),view=await scroll.boundingBox(),compose=await composer.boundingBox();
      return Boolean(message&&view&&compose)&&message.y>=view.y-1&&message.y+message.height<=Math.min(view.y+view.height,compose.y)+1;
    };
    await expect(newest).toBeVisible();
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
    await expect.poll(newestInView).toBe(true);

    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByTestId("drawer")).toBeVisible();
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
    await expect.poll(newestInView).toBe(true);
    await page.screenshot({animations:"disabled",path:auditDir+"conversation-follows-end-terminal-open-dark-1280x800.png",fullPage:true});

    // Shrunk as far as the newest reply, its done pill under it included, still fits between the view's top and the composer.
    await page.setViewportSize({width:1280,height:760});
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
    await expect.poll(newestInView).toBe(true);
    await page.setViewportSize({width:1280,height:800});
    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByTestId("drawer")).toHaveCount(0);
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);

    // Read further up, then open the terminal again: the messages being read keep their place.
    await scroll.evaluate(node=>{node.scrollTop=Math.round((node.scrollHeight-node.clientHeight)/2);node.dispatchEvent(new Event("scroll",{bubbles:true}))});
    await expect.poll(distanceFromEnd).toBeGreaterThan(400);
    const firstRowInView=()=>scroll.evaluate(node=>{
      const top=node.getBoundingClientRect().top;
      const row=[...node.querySelectorAll("[data-message-id]")].find(element=>element.getBoundingClientRect().top>=top);
      return row?{id:row.dataset.messageId,top:Math.round(row.getBoundingClientRect().top),scrollTop:Math.round(node.scrollTop)}:null;
    });
    // Rows scrolled into view take their real height over the next frames (content-visibility); read once they hold still.
    let reading=null;
    await expect.poll(async()=>{const before=await firstRowInView();await page.waitForTimeout(150);reading=await firstRowInView();return Boolean(reading)&&JSON.stringify(before)===JSON.stringify(reading)}).toBe(true);
    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByTestId("drawer")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await firstRowInView()).toEqual(reading);
    expect(await distanceFromEnd()).toBeGreaterThan(400);
    await page.screenshot({animations:"disabled",path:auditDir+"conversation-keeps-place-terminal-open-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});

// A thread whose turns each ran a command, so a closed activity card sits between each message and its reply; the newest turn's
// card is open with 48 steps, taller than the view.
function workedThread(id,name,count){
  const cwd=process.cwd(),now=Date.now()/1000,command=(turn,step)=>({id:`command-${turn}-${step}`,type:"commandExecution",command:"npm run check -- --part "+(step+1),cwd,status:"completed",aggregatedOutput:"ok\n",exitCode:0});
  const turns=makeTurns(count).map((turn,index)=>({...turn,items:[turn.items[0],...Array.from({length:index===count-1?48:1},(_,step)=>command(index,step)),turn.items[1]]}));
  const thread={id,name,preview:count*2+" messages",cwd,model:"test/coding-fast",status:{type:"idle"},createdAt:now-600,updatedAt:now,turns};
  const meta={[thread.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model:thread.model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}}};
  return {thread,meta,cwd};
}
// Opens it at its end. The appearance toggle saves the mode, and the settings saved come back as they were sent.
async function openWorkedThread(page,{thread,meta,harness,cwd}){
  await installFixtureRoutes(page,{thread,meta,harness,cwd});
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().postDataJSON()||{})}):route.fallback());
  await page.goto("/");
  await page.locator(`.thread-main[title="${thread.name}"]`).click();
  await expect(page.locator(`[data-message-id="assistant-${thread.turns.length-1}"]`)).toBeVisible();
  await expect(page.locator(".turn-card [data-testid=activity-card][data-state=open] .tool-event")).toHaveCount(48);
}
// What the person sees: every message, card and step on screen ends inside the conversation's column, its text wrapped to it
// and its bubble whole, and nothing scrolls sideways.
function columnMisfits(page){
  return page.locator(".conversation-scroll").evaluate(node=>{
    const view=node.getBoundingClientRect(),edge=node.querySelector(".conversation-column").getBoundingClientRect().right,problems=[];
    if(node.scrollWidth>node.clientWidth+1)problems.push(`the conversation scrolls sideways (${node.scrollWidth} > ${node.clientWidth})`);
    for(const row of node.querySelectorAll(".conversation-column :is(.user-row,.history-assistant,.turn-card,.tool-event)")){
      const rect=row.getBoundingClientRect();if(!rect.height||rect.bottom<=view.top||rect.top>=view.bottom)continue;
      const name=row.dataset.messageId||row.querySelector(":scope>summary strong")?.textContent||row.className.split(" ")[0]+" "+(row.dataset.turnId||"");
      if(rect.right>edge+1)problems.push(`${name} ends at ${Math.round(rect.right)}, past the column's edge at ${Math.round(edge)}`);
    }
    return problems;
  });
}
const columnFits=(page,message)=>expect.poll(()=>columnMisfits(page),{message,timeout:2000}).toEqual([]);
const columnWidth=page=>page.locator(".conversation-column").evaluate(node=>Math.round(node.getBoundingClientRect().width));
// The wheel to the end, then back up: by up px, or with none until the open card spans the view.
async function wheelBackFromEnd(page,up=0){
  const scroll=page.locator(".conversation-scroll"),fromEnd=()=>scroll.evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop));
  await scroll.hover();await page.mouse.wheel(0,30000);await expect.poll(fromEnd).toBeLessThanOrEqual(1);
  if(up){await page.mouse.wheel(0,-up);await expect.poll(fromEnd).toBeGreaterThan(up-600);return}
  const card=page.locator(".turn-card [data-testid=activity-card][data-state=open]"),box=await card.boundingBox(),view=await scroll.boundingBox();
  await page.mouse.wheel(0,Math.round(box.y+box.height/2-view.y-view.height/2));
  await expect.poll(async()=>{const now=await card.boundingBox();return now.y<view.y&&now.y+now.height>view.y+view.height}).toBe(true);
}

test("the rows being read take the narrower column at once when the inspector opens or is dragged wider, or the window narrows",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const {thread,meta,cwd}=workedThread("narrowing-thread","Narrowing column",40),harness=await startHarness(thread);
  try{
    await openWorkedThread(page,{thread,meta,harness,cwd});
    await expect(page.locator(".turn-card")).toHaveCount(40);
    const inspector=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle"),panelKey=process.platform==="darwin"?"Meta+Alt+B":"Control+Alt+B";
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      // A click on the header's toggle opens the inspector beside the middle of the conversation.
      await wheelBackFromEnd(page,2600);let width=await columnWidth(page);
      await toggle.click();await expect(inspector).toBeVisible();await expect.poll(()=>columnWidth(page)).toBeLessThan(width-150);
      await columnFits(page,`the rows in view follow the column when the inspector opens (${mode})`);
      await page.screenshot({animations:"disabled",path:`${auditDir}conversation-rows-fit-inspector-opened-${mode}-1280x800.png`});
      // Its edge dragged to the left, the inspector grows and the column narrows again.
      if(mode==="dark"){
        const grip=await page.getByTestId("right-panel-resizer").boundingBox();width=await columnWidth(page);
        await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await page.mouse.down();await page.mouse.move(grip.x-120,grip.y+grip.height/2,{steps:6});await page.mouse.up();
        await expect.poll(()=>columnWidth(page)).toBeLessThan(width-40);
        await columnFits(page,`the rows in view follow the column when the inspector is dragged wider (${mode})`);
      }
      // Ctrl+Alt+B closes it, and opens it again beside the open card's steps.
      await page.keyboard.press(panelKey);await expect(inspector).toBeHidden();
      await columnFits(page,`the rows in view follow the column when the inspector closes (${mode})`);
      await wheelBackFromEnd(page);width=await columnWidth(page);
      await page.keyboard.press(panelKey);await expect(inspector).toBeVisible();await expect.poll(()=>columnWidth(page)).toBeLessThan(width-150);
      await columnFits(page,`the open card's steps follow the column when the inspector opens (${mode})`);
      await page.screenshot({animations:"disabled",path:`${auditDir}conversation-steps-fit-inspector-opened-${mode}-1280x800.png`});
      // With the inspector closed, the window narrows to 700 px while the middle is read.
      await toggle.click();await expect(inspector).toBeHidden();
      await wheelBackFromEnd(page,2600);width=await columnWidth(page);
      await page.setViewportSize({width:700,height:800});await expect.poll(()=>columnWidth(page)).toBeLessThan(width-50);
      await columnFits(page,`the rows in view follow the column when the window narrows (${mode})`);
      await page.screenshot({animations:"disabled",path:`${auditDir}conversation-rows-fit-narrowed-${mode}-700x800.png`});
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{await harness.close()}
});

test("in a thread long enough to mount its messages in chunks, the rows and steps being read take the narrower column at once",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const {thread,meta,cwd}=workedThread("narrowing-chunked-thread","Narrowing chunked column",100),harness=await startHarness(thread);
  try{
    await openWorkedThread(page,{thread,meta,harness,cwd});
    await expect.poll(()=>page.locator("[data-virtual-chunk]").count()).toBeGreaterThan(1);
    const inspector=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle");
    // The open card's steps, a little above the end, share their chunk with cards laid out at the wider column.
    await wheelBackFromEnd(page);let width=await columnWidth(page);
    await toggle.click();await expect(inspector).toBeVisible();await expect.poll(()=>columnWidth(page)).toBeLessThan(width-150);
    await columnFits(page,"the rows and steps in view follow the column when the inspector opens");
    await page.screenshot({animations:"disabled",path:auditDir+"conversation-chunked-fit-inspector-opened-dark-1280x800.png"});
    await toggle.click();await expect(inspector).toBeHidden();
    await wheelBackFromEnd(page,1200);width=await columnWidth(page);
    await page.setViewportSize({width:700,height:800});await expect.poll(()=>columnWidth(page)).toBeLessThan(width-50);
    await columnFits(page,"the rows and steps in view follow the column when the window narrows");
    await page.screenshot({animations:"disabled",path:auditDir+"conversation-chunked-fit-narrowed-dark-700x800.png"});
  }finally{await harness.close()}
});

test("loading earlier virtualized history preserves the visible anchor",async({page})=>{
  test.setTimeout(30_000);
  await page.setViewportSize({width:1280,height:800});
  const cwd=process.cwd(),now=Date.now()/1000,turns=makePagedTurns(80);
  const thread={id:"paged-long-thread",name:"Paged long conversation",preview:"480 messages",cwd,model:"test/coding-fast",status:{type:"idle"},createdAt:now-600,updatedAt:now,turns};
  const turnPages={
    "page-latest":{data:[...turns.slice(40)].reverse(),nextCursor:"page-older"},
    "page-older":{data:[...turns.slice(0,40)].reverse(),nextCursor:null},
  };
  const meta={[thread.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model:thread.model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}}};
  const harness=await startHarness(thread,{turnPages});
  try{
    await installFixtureRoutes(page,{thread,meta,harness,cwd});
    await page.goto("/");
    await page.locator('.thread-main[title="Paged long conversation"]').click();

    const rows=page.locator("[data-message-id]"),scroll=page.locator(".conversation-scroll"),anchor=page.locator('[data-message-id="paged-user-40-0"]');
    await expect(page.getByRole("button",{name:"Load earlier messages"})).toBeVisible();
    expect(await rows.count()).toBeLessThan(180);
    await scroll.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event("scroll",{bubbles:true}))});
    await expect(anchor).toBeVisible({timeout:5000});
    const beforeTop=await anchor.evaluate(node=>node.getBoundingClientRect().top);
    const beforeScrollTop=await scroll.evaluate(node=>node.scrollTop);

    await page.getByRole("button",{name:"Load earlier messages"}).click();
    await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
    await expect(page.locator("[data-virtual-chunk]")).toHaveCount(15);
    await expect.poll(()=>scroll.evaluate(node=>node.scrollTop)).toBeGreaterThan(beforeScrollTop+500);
    await expect(anchor).toBeVisible({timeout:5000});
    await expect.poll(async()=>Math.abs((await anchor.evaluate(node=>node.getBoundingClientRect().top))-beforeTop),{timeout:3000}).toBeLessThan(80);
    const afterTop=await anchor.evaluate(node=>node.getBoundingClientRect().top);
    const afterScrollTop=await scroll.evaluate(node=>node.scrollTop);
    expect(Math.abs(afterTop-beforeTop)).toBeLessThan(80);
    expect(afterScrollTop).toBeGreaterThan(beforeScrollTop+500);
    expect(await rows.count()).toBeLessThan(180);

    await page.screenshot({animations:"disabled",path:auditDir+"long-conversation-prepend-preserved-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});
