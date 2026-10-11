import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

// The secondary pages met the way a person meets them: every Usage control has a name and shows where focus is, a long
// History title or delegated-agent name can be read in full without breaking the rows' columns, a focused History row
// shows its whole ring, and small labels and helper lines read at 4.5:1 in dark and light. Screenshots:
// visual-audit/polish/pages-polish/.
const shots=fileURLToPath(new URL("../../visual-audit/polish/pages-polish/",import.meta.url));mkdirSync(shots,{recursive:true});
const nav=(page,label)=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
const BASE={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"};
const MODES=["dark","light"];
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

async function open(page,request,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});
  await request.post("/api/settings",{data:{...BASE,appearanceMode:mode}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Polish Workspace",activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.dataset.mode)).toBe(mode);
}
test.afterEach(async({request})=>{await request.post("/api/settings",{data:BASE})});

async function tabTo(page,target,limit=20){
  for(let i=0;i<limit;i++){
    await page.keyboard.press("Tab");
    if(await target.evaluate(element=>element===document.activeElement))return;
  }
  throw new Error("Tab never reached the element");
}
const around=(box,pad)=>({x:Math.max(0,Math.floor(box.x-pad)),y:Math.max(0,Math.floor(box.y-pad)),width:Math.ceil(box.width+pad*2),height:Math.ceil(box.height+pad*2)});

// How much of each edge of a box changed between two screenshots of the same clip (before and after it took focus): a
// focus ring that shows all round changes about all of every edge, one covered by a neighbour leaves that edge unchanged.
// The PNGs are decoded in a blank page so the app page is left alone.
async function ringEdges(page,clip,box,before,after){
  const decoder=await page.context().newPage();
  try{
    return await decoder.evaluate(async({before,after,clip,box})=>{
      const pixels=async source=>{const image=new Image();image.src="data:image/png;base64,"+source;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext("2d");context.drawImage(image,0,0);return context.getImageData(0,0,image.width,image.height)};
      const a=await pixels(before),b=await pixels(after);
      const changed=(x,y)=>{if(x<0||y<0||x>=a.width||y>=a.height)return false;const i=(y*a.width+x)*4;return Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>36};
      const left=Math.round(box.x-clip.x),top=Math.round(box.y-clip.y),right=Math.round(box.x+box.width-clip.x)-1,bottom=Math.round(box.y+box.height-clip.y)-1;
      const band=4,corner=12;
      const share=(from,to,hit)=>{let hits=0,total=0;for(let p=from;p<=to;p++){total++;if(hit(p))hits++}return total?Math.round(hits/total*100)/100:0};
      const across=(y,x)=>{for(let d=-band;d<=band;d++)if(changed(x,y+d))return true;return false};
      const down=(x,y)=>{for(let d=-band;d<=band;d++)if(changed(x+d,y))return true;return false};
      return {
        top:share(left+corner,right-corner,x=>across(top,x)),
        bottom:share(left+corner,right-corner,x=>across(bottom,x)),
        left:share(top+corner,bottom-corner,y=>down(left,y)),
        right:share(top+corner,bottom-corner,y=>down(right,y)),
      };
    },{before:before.toString("base64"),after:after.toString("base64"),clip,box});
  }finally{await decoder.close()}
}
// Clicks a spot that is not a control (focus then starts there), screenshots the element, Tabs to it and screenshots it
// again: the share of each edge the focus ring covers.
async function focusRingByTab(page,target,startAt){
  await startAt.click();
  const box=await target.boundingBox();const clip=around(box,8);
  const before=await page.screenshot({animations:"disabled",clip});
  await tabTo(page,target);
  expect(await target.evaluate(element=>element.matches(":focus-visible")),"the element took keyboard focus").toBe(true);
  const after=await page.screenshot({animations:"disabled",clip});
  return ringEdges(page,clip,box,before,after);
}

// ============ Usage ============
test("the Usage period picker is named, so a screen reader says what it picks",async({page,request})=>{
  await open(page,request);
  await nav(page,"Usage").click();
  const period=page.getByRole("combobox",{name:"Period",exact:true});
  await expect(period).toBeVisible();
  await expect(period).toHaveValue("30");
  await period.selectOption("7");
  await expect(period).toHaveValue("7");
  await expect(page.locator(".usage-grid .capability-card-head em").first()).toHaveText("7d");
});

for(const mode of MODES){
  test(`Tab to the Usage environment filter shows a ring all round it, like the period picker beside it (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    await nav(page,"Usage").click();
    const filter=page.locator(".usage-environment-filter>summary");
    await expect(filter).toHaveText("All environments");
    const edges=await focusRingByTab(page,filter,page.getByRole("heading",{name:"Usage",level:2}));
    await page.screenshot({animations:"disabled",path:shots+`usage-filter-focus-${mode}-1280.png`});
    console.log("USAGE-FILTER-RING "+mode+" "+JSON.stringify(edges));
    for(const [edge,share] of Object.entries(edges))expect(share,`the ${edge} edge of the focused filter shows the ring`).toBeGreaterThan(.9);
    // The period picker's keyboard focus looks the same.
    const period=page.locator(".usage-toolbar select");
    await page.keyboard.press("Tab");
    await expect(period).toBeFocused();
    const look=element=>{for(const animation of element.getAnimations())animation.finish();const style=getComputedStyle(element);return {shadow:style.boxShadow,border:style.borderTopColor}};
    const periodLook=await period.evaluate(look);
    await page.keyboard.press("Shift+Tab");
    await expect(filter).toBeFocused();
    await expect.poll(()=>filter.evaluate(look)).toEqual(periodLook);
    // Enter opens the menu, and Enter again closes it with focus still on the filter.
    await page.keyboard.press("Enter");
    await expect(page.locator(".usage-environment-filter")).toHaveAttribute("open","");
    await page.keyboard.press("Enter");
    await expect(page.locator(".usage-environment-filter")).not.toHaveAttribute("open","");
    await expect(filter).toBeFocused();
    await page.setViewportSize({width:900,height:800});
    await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(filter).toBeFocused();
    await page.screenshot({animations:"disabled",path:shots+`usage-filter-focus-${mode}-900.png`});
  });
}

// ============ History (behind a fake Codex app-server) ============
const LONG_TITLE="Investigate why the nightly integration pipeline for the payments gateway keeps timing out on the reconciliation step after the database migration";
const LONG_PREVIEW="C:\\Users\\someone\\source\\repos\\a-very-long-folder-name-for-the-payments-gateway-service\\src\\reconciliation\\nightly-job.ts";
function historyThreads(count,{long=false}={}){
  const now=Date.now()/1000;
  return Array.from({length:count},(_,i)=>({id:"polish-thread-"+i,name:i===0&&long?LONG_TITLE:"Polish thread "+i,preview:i===0&&long?LONG_PREVIEW:"Preview of thread "+i,cwd:process.cwd(),createdAt:now-1000-i*60,updatedAt:now-i*60,turns:[]}));
}
async function startCodex(threads){
  const http=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      const m=message.method;let result={};
      if(m==="thread/list")result={data:threads,nextCursor:null};
      else if(m==="thread/resume"||m==="thread/read")result={thread:threads.find(t=>t.id===message.params?.threadId)||threads[0],itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(m==="initialize")result={userAgent:"polish-fixture"};
      else if(["threadSection/list","thread/loaded/list","thread/attachment/list","thread/queue/list","app/list","permissionProfile/list","hooks/list","experimentalFeature/list","plugin/share/list","collaborationMode/list","skills/list"].includes(m))result={data:[],nextCursor:null};
      else if(m==="thread/goal/get")result={goal:null};
      else if(m==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(m==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(m==="mcpServerStatus/list")result={data:[]};
      else if(m==="plugin/list")result={marketplaces:[]};
      else if(m==="app/installed")result={apps:[]};
      else if(m==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(m==="account/rateLimits/read")result={rateLimits:{}};
      else if(m==="config/read")result={config:{},layers:[]};
      else if(m==="thread/unsubscribe")result={status:"unsubscribed"};
      try{ws.send(JSON.stringify({id:message.id,result}))}catch{}
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {port,async close(){for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
async function openCodexHistory(page,fixture,threads,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${fixture.port}`,cwd:process.cwd(),platform:process.platform,version:"polish-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:Object.fromEntries(threads.map(t=>[t.id,{projectless:true,environmentId:null}]))}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/agent-runtimes$/,route=>json(route,{selectedRuntime:"codex",selectedInstanceId:"codex-default",definitions:[{id:"codex",name:"Codex",protocol:"codex",multipleInstances:true}],instances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true}],statuses:[{id:"codex-default",kind:"codex",name:"Codex",available:true,installed:true,authenticated:true,version:"fixture"}]}));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.dataset.mode)).toBe(mode);
  await nav(page,"History").click();
  await expect(page.getByRole("heading",{name:"Thread history",level:1})).toBeVisible();
  const rows=page.locator(".history-thread-row");
  await expect(rows).toHaveCount(threads.length);
  return rows;
}

for(const [mode,width] of [["dark",1600],["dark",1280],["light",1280],["dark",900],["light",900]]){
  test(`a long History title and path can be read in full and the rows keep their columns (${mode} ${width})`,async({page})=>{
    const threads=historyThreads(6,{long:true});
    const fixture=await startCodex(threads);
    try{
      const rows=await openCodexHistory(page,fixture,threads,{mode,width,height:width===1600?980:800});
      await page.waitForTimeout(300);
      await page.screenshot({animations:"disabled",path:shots+`history-long-title-${mode}-${width}.png`});
      const layout=await page.evaluate(()=>{
        const out=[];const root=document.documentElement;if(root.scrollWidth>root.clientWidth+1)out.push("page scrolls sideways");
        for(const node of document.querySelectorAll(".secondary-page"))if(node.scrollWidth>node.clientWidth+1)out.push("History scrolls sideways");
        const rows=[...document.querySelectorAll(".history-thread-row")];
        for(const row of rows){const b=row.getBoundingClientRect();for(const el of row.querySelectorAll("*")){const r=el.getBoundingClientRect();if(r.width&&(r.right>b.right+1||r.left<b.left-1||r.bottom>b.bottom+1||r.top<b.top-1))out.push(`"${(el.textContent||"").slice(0,40)}" runs outside its row`)}}
        // The text column starts, and the chip and time columns end, at the same x in every row.
        const edge=(selector,side)=>[...new Set(rows.map(row=>{const el=row.querySelector(selector);return el&&getComputedStyle(el).display!=="none"?Math.round(el.getBoundingClientRect()[side]):"none"}))];
        for(const [selector,side] of [["strong","left"],["em","right"],["time","right"]]){const xs=edge(selector,side);if(xs.length>1)out.push(`${selector} ${side} edges differ between rows: ${xs.join(", ")}`)}
        // The chip and time stay centred on their row, in a row with a two-line title as in a one-line row.
        for(const row of rows){const b=row.getBoundingClientRect();for(const el of row.querySelectorAll(":scope>em,:scope>time")){if(getComputedStyle(el).display==="none")continue;const r=el.getBoundingClientRect();if(Math.abs((r.top+r.height/2)-(b.top+b.height/2))>2)out.push(`${el.tagName.toLowerCase()} is off the middle of "${row.querySelector("strong").textContent.slice(0,30)}"`)}}
        return [...new Set(out)];
      });
      expect(layout).toEqual([]);
      // Each long text either shows whole or carries its whole text as a tooltip; the title also wraps instead of stopping
      // after one line.
      const read=async locator=>locator.evaluate(el=>{const s=getComputedStyle(el);return {cut:el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1,tooltip:el.getAttribute("title")||"",lines:Math.round(el.getBoundingClientRect().height/(parseFloat(s.lineHeight)||parseFloat(s.fontSize)*1.21))}});
      const title=await read(rows.first().locator("strong")),preview=await read(rows.first().locator("span"));
      console.log("HISTORY-LONG "+mode+" "+width+" "+JSON.stringify({title,preview}));
      expect(!title.cut||title.tooltip===LONG_TITLE,"the long thread title is cut with no way to read it").toBe(true);
      expect(!preview.cut||preview.tooltip===LONG_PREVIEW,"the long path is cut with no way to read it").toBe(true);
      expect(title.tooltip,"the title's tooltip has its whole text").toBe(LONG_TITLE);
      expect(preview.tooltip,"the path's tooltip has its whole text").toBe(LONG_PREVIEW);
      expect(title.lines,"the long title wraps onto a second line").toBe(2);
      // The row still opens its thread, and short rows stay one line each.
      expect((await read(rows.nth(1).locator("strong"))).lines).toBe(1);
      await rows.nth(2).click();
      await expect(page.locator("main")).toContainText("Polish thread 2",{timeout:5000});
    }finally{await fixture.close()}
  });
}

for(const mode of MODES){
  test(`a History row reached by Tab shows its whole focus ring, the bottom edge included (${mode})`,async({page})=>{
    const threads=historyThreads(4);
    const fixture=await startCodex(threads);
    try{
      const rows=await openCodexHistory(page,fixture,threads,{mode});
      const heading=page.getByRole("heading",{name:"Thread history",level:1});
      const first=await focusRingByTab(page,rows.first(),heading);
      await page.screenshot({animations:"disabled",path:shots+`history-row-focus-${mode}-1280.png`});
      const second=await focusRingByTab(page,rows.nth(1),heading);
      await page.screenshot({animations:"disabled",path:shots+`history-row-focus-second-${mode}-1280.png`});
      console.log("HISTORY-RING "+mode+" "+JSON.stringify({first,second}));
      for(const [name,edges] of [["first",first],["second",second]])for(const [edge,share] of Object.entries(edges))expect(share,`the ${edge} edge of the focused ${name} row shows the ring`).toBeGreaterThan(.9);
      await page.setViewportSize({width:900,height:800});
      await rows.nth(1).focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");
      await expect(rows.nth(1)).toBeFocused();
      await page.screenshot({animations:"disabled",path:shots+`history-row-focus-second-${mode}-900.png`});
      await page.keyboard.press("Enter");
      await expect(page.locator("main")).toContainText("Polish thread 1",{timeout:5000});
    }finally{await fixture.close()}
  });
}

