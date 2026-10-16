import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

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

// Every place Tab stops on the Usage page shows that it has focus, in dark and light: the environment filter, each choice in its
// menu, the period picker, the two buttons, and on the Codex account card its reset-credit button and the summary of what could not
// be read. Each stop's look with focus is read against its look once focus has moved on.
for(const mode of MODES){
  test(`every Tab stop on the Usage page shows where focus is (${mode})`,async({page})=>{
    const records=[usageRecord(0,"native","gpt-5.1",null,0.42),usageRecord(1,"codex","gpt-5.1-codex","polish-ssh",null)];
    const threads=historyThreads(1);
    const fixture=await startCodex(threads,{answers:{"account/rateLimits/read":{rateLimits:{planType:"plus"},rateLimitResetCredits:{availableCount:1,credits:[{id:"polish-credit",status:"available"}]}},"account/usage/read":{error:"Deliberate usage read failure"}}});
    try{
      await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,usageAnswer(records)):route.continue());
      await page.route(/\/api\/environments$/,route=>route.request().method()==="GET"?json(route,{profiles:[{id:"polish-ssh",name:"Build box",type:"ssh"}],activeEnvironmentId:null,activeEnvironment:null}):route.continue());
      await openCodexHistory(page,fixture,threads,{mode});
      await nav(page,"Usage").click();
      await expect(page.locator(".usage-recent .usage-table")).toContainText("gpt-5.1-codex");
      await expect(page.getByRole("button",{name:"Use reset credit"})).toBeVisible();
      await expect(page.getByText("Unavailable Codex account data",{exact:true})).toBeVisible();
      await page.getByRole("heading",{name:"Usage",level:2}).click();
      const look=()=>page.evaluate(()=>{
        const element=document.activeElement;for(const animation of element.getAnimations())animation.finish();
        const style=getComputedStyle(element),alpha=(String(style.outlineColor).match(/[\d.]+/g)||[]).map(Number)[3]??1;
        return {inPage:Boolean(element.closest(".usage-page")),name:(element.tagName+" "+(element.getAttribute("aria-label")||element.closest("label")?.textContent||element.textContent||"")).trim().slice(0,40),
          outline:style.outlineStyle!=="none"&&parseFloat(style.outlineWidth)>=1&&alpha>.3?style.outlineWidth+" "+style.outlineColor:"",shadow:style.boxShadow==="none"?"":style.boxShadow,border:style.borderTopColor};
      });
      const stops=[];let opened=false;
      for(let i=0;i<20;i++){
        await page.keyboard.press("Tab");
        const focused=await look();if(!focused.inPage)break;
        const element=await page.evaluateHandle(()=>document.activeElement);
        await page.screenshot({animations:"disabled",path:shots+`usage-tab-stop-${stops.length}-${mode}-1280.png`});
        await page.keyboard.press("Shift+Tab");
        const left=await element.evaluate(node=>{for(const animation of node.getAnimations())animation.finish();const style=getComputedStyle(node);return {focused:node===document.activeElement,shadow:style.boxShadow==="none"?"":style.boxShadow,border:style.borderTopColor}});
        await page.keyboard.press("Tab");
        expect(await element.evaluate(node=>node===document.activeElement),"Tab comes back to "+focused.name).toBe(true);
        const ring=Boolean(focused.outline)||Boolean(focused.shadow&&focused.shadow!==left.shadow);
        stops.push({...focused,left,ring});
        if(!opened&&focused.name.startsWith("SUMMARY")){opened=true;await page.keyboard.press("Enter");await expect(page.locator(".usage-environment-filter")).toHaveAttribute("open","")}
      }
      console.log("USAGE-TAB-STOPS "+mode+" "+JSON.stringify(stops,null,1));
      expect(stops.map(stop=>stop.name),"the stops Tab meets").toEqual(["SUMMARY All environments","BUTTON All environments","INPUT Local / legacylocal","INPUT Build boxssh","SELECT Period","BUTTON Refresh","BUTTON  Clear local history","BUTTON  Use reset credit","SUMMARY Unavailable Codex account data"]);
      for(const stop of stops)expect.soft(stop.ring,`${stop.name} shows a ring with focus`).toBe(true);
      // The summary's ring shows all round it, not cut away by the card it opens.
      const summary=page.locator(".codex-account-usage .capability-details>summary");
      const edges=await focusRingByTab(page,summary,page.getByRole("heading",{name:"Usage",level:2}));
      console.log("USAGE-DETAILS-RING "+mode+" "+JSON.stringify(edges));
      for(const [edge,share] of Object.entries(edges))expect.soft(share,`the ${edge} edge of the focused summary shows the ring`).toBeGreaterThan(.9);
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`usage-details-focus-${mode}-1280.png`});
      await page.setViewportSize({width:900,height:800});
      await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");
      await expect(summary).toBeFocused();
      await page.screenshot({animations:"disabled",path:shots+`usage-details-focus-${mode}-900.png`});
      // The Tools page draws the same card, and its summaries show the same ring.
      await page.setViewportSize({width:1280,height:800});
      await nav(page,"Tools").click();
      const config=page.locator(".capabilities-page .capability-details>summary",{hasText:"Effective config"});
      await config.scrollIntoViewIfNeeded();
      const configEdges=await focusRingByTab(page,config,page.getByText("Configuration layers",{exact:true}));
      console.log("TOOLS-DETAILS-RING "+mode+" "+JSON.stringify(configEdges));
      for(const [edge,share] of Object.entries(configEdges))expect.soft(share,`the ${edge} edge of the focused Tools summary shows the ring`).toBeGreaterThan(.9);
      await page.screenshot({animations:"disabled",path:shots+`tools-details-focus-${mode}-1280.png`});
      await page.setViewportSize({width:900,height:800});
      await config.scrollIntoViewIfNeeded();
      await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");
      await expect(config).toBeFocused();
      await page.screenshot({animations:"disabled",path:shots+`tools-details-focus-${mode}-900.png`});
    }finally{await fixture.close()}
  });
}

// ============ Invalid fields ============
// A field the page refuses keeps its red line in dark and in light: left, under the pointer and with the keyboard in it, whatever
// the shared field rules of that mode say. Its line is read once it has eased into place.
const reddish=value=>{
  const text=String(value),srgb=text.match(/^color\(srgb\s+([^)]+)\)$/);
  const parts=srgb?srgb[1].split(/[\s/]+/).filter(Boolean).map(Number).map((part,index)=>index<3?part*255:part):(text.match(/[\d.]+/g)||[]).map(Number);
  return parts.length>=3&&parts[0]-Math.max(parts[1],parts[2])>40&&(parts[3]??1)>=.2;
};
async function invalidLines(page,field,name){
  const line=()=>field.evaluate(node=>{for(const animation of node.getAnimations())animation.finish();return getComputedStyle(node).borderTopColor});
  const out={};
  for(const mode of MODES){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    await field.evaluate(node=>node.blur());await page.mouse.move(1,1);
    const left=await line();
    await field.hover();const hovered=await line();
    await field.focus();const focused=await line();
    await page.mouse.move(1,1);const focusedAway=await line();
    out[mode]={left,hovered,focused,focusedAway};
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});await field.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`invalid-${name}-${mode}-${width}.png`});
      await field.evaluate(node=>node.blur());
      await page.screenshot({animations:"disabled",path:shots+`invalid-${name}-left-${mode}-${width}.png`});
      await field.focus();
    }
    await page.setViewportSize({width:1280,height:800});
  }
  console.log("INVALID-LINES "+name+" "+JSON.stringify(out));
  for(const [mode,looks] of Object.entries(out))for(const [state,colour] of Object.entries(looks))expect.soft(reddish(colour),`${name} ${mode} ${state}: ${colour}`).toBe(true);
}

test("a refused field keeps its red line in both modes, with focus, without it and under the pointer: Environments, Clone and Shortcuts",async({page,request})=>{
  test.setTimeout(90_000);
  await page.route(/\/api\/environments$/,async route=>{
    if(route.request().method()!=="GET")return route.continue();
    const body=await (await route.fetch()).json();
    return json(route,{...body,profiles:[{id:"polish-ssh",name:"Build box",type:"ssh",host:"build.example.com",user:"dev",port:22,cwd:"",enabled:true}],capabilities:{...body.capabilities,ssh:{available:true,version:"OpenSSH fixture"}}});
  });
  await open(page,request);
  // The Environments port.
  await nav(page,"Environments").click();
  const form=page.locator(".environment-create");
  await form.getByRole("combobox",{name:"Type"}).selectOption("ssh");
  const port=form.getByRole("spinbutton",{name:"Port"});
  await port.fill("0");
  await expect(port).toHaveAttribute("aria-invalid","true");
  await expect(form.getByRole("alert")).toHaveText("Port must be a whole number from 1 to 65535.");
  await invalidLines(page,port,"environment-port");
  // The Clone parent directory.
  await nav(page,"Projects").click();
  const clone=page.locator(".clone-card");
  await clone.getByRole("textbox",{name:"Clone URL"}).fill("https://github.com/owner/repo.git");
  await clone.getByRole("button",{name:"Clone",exact:true}).click();
  const parent=clone.getByRole("textbox",{name:"Clone parent directory"});
  await expect(parent).toHaveAttribute("aria-invalid","true");
  await invalidLines(page,parent,"clone-parent");
  // A shortcut.
  await nav(page,"Settings").click();
  await page.getByRole("navigation",{name:"Settings categories"}).getByRole("button",{name:/^Shortcuts/}).click();
  const key=page.getByRole("textbox",{name:"Toggle main sidebar shortcut",exact:true});
  await key.click();await key.press("ControlOrMeta+A");await key.pressSequentially("Ctrl+",{delay:15});await key.press("Tab");
  await expect(key).toHaveAttribute("aria-invalid","true");
  await invalidLines(page,key,"shortcut");
});

test("a field an MCP server's form refuses keeps its red line in both modes, with focus, without it and under the pointer",async({page})=>{
  const threads=historyThreads(1);
  const fixture=await startCodex(threads);
  try{
    await openCodexHistory(page,fixture,threads);
    fixture.emit({id:"polish-elicitation",method:"mcpServer/elicitation/request",params:{threadId:threads[0].id,serverName:"polish_app",mode:"form",message:"Name the deployment",requestedSchema:{type:"object",properties:{label:{type:"string",title:"Deployment name"}},required:["label"]}}});
    const modal=page.getByTestId("mcp-elicitation");
    await expect(modal).toBeVisible();
    await modal.getByRole("button",{name:"Submit",exact:true}).click();
    const field=modal.getByRole("textbox",{name:/Deployment name/});
    await expect(field).toHaveAttribute("aria-invalid","true");
    await invalidLines(page,field,"mcp-form");
  }finally{await fixture.close()}
});

// ============ History (behind a fake Codex app-server) ============
const LONG_TITLE="Investigate why the nightly integration pipeline for the payments gateway keeps timing out on the reconciliation step after the database migration";
const LONG_PREVIEW="C:\\Users\\someone\\source\\repos\\a-very-long-folder-name-for-the-payments-gateway-service\\src\\reconciliation\\nightly-job.ts";
function historyThreads(count,{long=false}={}){
  const now=Date.now()/1000;
  return Array.from({length:count},(_,i)=>({id:"polish-thread-"+i,name:i===0&&long?LONG_TITLE:"Polish thread "+i,preview:i===0&&long?LONG_PREVIEW:"Preview of thread "+i,cwd:process.cwd(),createdAt:now-1000-i*60,updatedAt:now-i*60,turns:[]}));
}
// answers: results for further methods, or {error} for a method that fails. older: the threads of the page after the first, which
// then says there is one.
async function startCodex(threads,{answers={},older=[]}={}){
  const http=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      const m=message.method;let result={};
      if(answers[m]?.error){try{ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:answers[m].error}}))}catch{}return}
      if(answers[m])result=answers[m];
      else if(m==="thread/list")result=message.params?.cursor==="older-page"?{data:older,nextCursor:null}:{data:threads,nextCursor:older.length?"older-page":null};
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
  return {port,emit(message){for(const socket of sockets)socket.send(JSON.stringify(message))},async close(){for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
async function openCodexHistory(page,fixture,threads,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});await keepThreadMeta(page);
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

// Today's rows read "Today 12:20" and older ones a date ("Oct 12"), which is shorter: after Load older threads every chip still
// starts and ends, and every time ends, at the same x in all the rows, at 1280 and 900, and in a narrow window, where the chip is
// hidden, the times still end at the same x.
for(const mode of MODES){
  test(`History rows from today and from days before keep the chip and the time in columns (${mode})`,async({page})=>{
    const now=Date.now()/1000,thread=(id,name,ago)=>({id,name,preview:"Preview of "+name.toLowerCase(),cwd:process.cwd(),createdAt:now-ago-60,updatedAt:now-ago,turns:[]});
    const today=Array.from({length:4},(_,i)=>thread("today-"+i,"Today thread "+(i+1),i*60)),older=Array.from({length:3},(_,i)=>thread("older-"+i,"Older thread "+(i+1),86400*(3+i)));
    const fixture=await startCodex(today,{older});
    try{
      const rows=await openCodexHistory(page,fixture,today,{mode});
      await page.getByRole("button",{name:"Load older threads"}).click();
      await expect(rows).toHaveCount(7);
      const dates=await rows.locator("time").allTextContents();
      expect(dates[0]).toMatch(/^Today /);expect(dates[6]).not.toMatch(/^(Today|Yesterday) /);
      for(const width of [1280,900,600]){
        await page.setViewportSize({width,height:800});await rows.last().scrollIntoViewIfNeeded();
        await page.screenshot({animations:"disabled",path:shots+`history-older-dates-${mode}-${width}.png`});
        const edges=await page.evaluate(()=>{
          const rows=[...document.querySelectorAll(".history-thread-row")];
          const xs=(selector,side)=>[...new Set(rows.map(row=>{const el=row.querySelector(selector);return getComputedStyle(el).display==="none"?"hidden":Math.round(el.getBoundingClientRect()[side])}))];
          return {"title left":xs("strong","left"),"chip left":xs("em","left"),"chip right":xs("em","right"),"time right":xs("time","right")};
        });
        console.log("HISTORY-DATES "+mode+" "+width+" "+JSON.stringify(edges)+" "+JSON.stringify(dates));
        for(const [edge,xs] of Object.entries(edges))expect(xs,`${edge} at ${width}: ${xs.join(", ")}`).toHaveLength(1);
        if(width===600)expect(edges["chip left"]).toEqual(["hidden"]);
      }
    }finally{await fixture.close()}
  });
}

// A browser that cannot read subgrid (Chromium before 117, Safari before 16) drops that declaration. Each row then takes the
// columns declared before it: its title, chip and time in columns of its own, as before rows took the page's. Here the page's
// stylesheets are read again with the subgrid value made one the browser cannot read, as such a browser reads them: the History base
// rule's icon column (36px) must not take the title, at 1280 or in a narrow window.
test("History rows keep a title column, then the chip and the time, where a browser cannot read subgrid",async({page})=>{
  const now=Date.now()/1000,thread=(id,name,ago)=>({id,name,preview:"Preview of "+name.toLowerCase(),cwd:process.cwd(),createdAt:now-ago-60,updatedAt:now-ago,turns:[]});
  const threads=[...Array.from({length:3},(_,i)=>thread("today-"+i,"Today thread "+(i+1),i*60)),...Array.from({length:2},(_,i)=>thread("older-"+i,"Older thread "+(i+1),86400*(3+i)))];
  const fixture=await startCodex(threads);
  try{
    const rows=await openCodexHistory(page,fixture,threads);
    const unread=await page.evaluate(async()=>{
      let count=0;
      for(const link of [...document.querySelectorAll('link[rel="stylesheet"]')]){
        const text=await (await fetch(link.href)).text();
        if(!/grid-template-columns:\s*subgrid/.test(text))continue;
        const style=document.createElement("style");style.textContent=text.replace(/grid-template-columns:\s*subgrid/g,()=>{count++;return "grid-template-columns:unread-subgrid"});
        link.after(style);link.disabled=true;
      }
      return count;
    });
    expect(unread,"subgrid declarations read as a browser without subgrid reads them").toBeGreaterThan(0);
    expect(await rows.first().evaluate(row=>getComputedStyle(row).gridTemplateColumns),"a row's columns with subgrid unread").not.toContain("subgrid");
    for(const width of [1280,600]){
      await page.setViewportSize({width,height:800});await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
      await page.screenshot({animations:"disabled",path:shots+`history-no-subgrid-dark-${width}.png`});
      const layout=await page.evaluate(()=>[...document.querySelectorAll(".history-thread-row")].map(row=>{
        const box=row.getBoundingClientRect(),text=row.querySelector(":scope>div").getBoundingClientRect(),chip=row.querySelector(":scope>em"),time=row.querySelector(":scope>time").getBoundingClientRect();
        const chipBox=getComputedStyle(chip).display==="none"?null:chip.getBoundingClientRect(),before=chipBox||text;
        return {title:row.querySelector("strong").textContent,textWidth:Math.round(text.width),rowWidth:Math.round(box.width),chip:chipBox?Math.round(chipBox.left)>=Math.round(text.right):"hidden",time:Math.round(time.left)>=Math.round(before.right),timeToEdge:Math.round(box.right-time.right)};
      }));
      console.log("HISTORY-NO-SUBGRID "+width+" "+JSON.stringify(layout));
      for(const row of layout){
        expect(row.textWidth,`the title column of "${row.title}" at ${width}`).toBeGreaterThan(row.rowWidth/3);
        expect(row.chip,`the chip after the title in "${row.title}" at ${width}`).toBe(width===600?"hidden":true);
        expect(row.time,`the time after the chip in "${row.title}" at ${width}`).toBe(true);
        expect(row.timeToEdge,`the time at the row's end in "${row.title}" at ${width}`).toBeLessThanOrEqual(20);
      }
    }
  }finally{await fixture.close()}
});

// ============ Agents fleet (a Codex app-server behind the real relay) ============
const LONG_AGENT="Investigate the flaky reconciliation job across every payments microservice and summarise the root cause in detail";
async function startFleet(children){
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;let result={};
      if(message.method==="thread/list")result={data:children,nextCursor:null};
      else if(message.method==="initialize")result={userAgent:"polish-fleet"};
      else if(["threadSection/list","thread/loaded/list","thread/attachment/list","thread/queue/list","app/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="collaborationMode/list"||message.method==="skills/list")result={data:[]};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    async close(){relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}
function child(id,name,status,role="researcher"){return {id,parentThreadId:"fleet-parent-thread",name,preview:"Delegated: "+name,agentRole:role,status:{type:status},model:"test/coding-fast",cwd:process.cwd(),createdAt:Date.now()/1000-100,updatedAt:Date.now()/1000,turns:[]}}
async function openAgents(page,fixture,{mode="dark",width=1280,height=800}={}){
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:fixture.wsUrl,cwd:process.cwd(),platform:"linux",version:"polish-fleet",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.setViewportSize({width,height});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe(mode);
  await page.locator('.sidebar .sidebar-utility[aria-label="Agents"]').click();
  return page.locator(".agents-page");
}

for(const [mode,width] of [["dark",1600],["dark",1280],["light",1280],["dark",900],["light",900]]){
  test(`a long delegated-agent name and its whole meta line can be read and the rows keep their columns (${mode} ${width})`,async({page})=>{
    const fixture=await startFleet([child("c1",LONG_AGENT,"active"),child("c2","Write the migration","idle","worker"),child("c3","Review the docs","notLoaded","reviewer")]);
    try{
      const agents=await openAgents(page,fixture,{mode,width,height:width===1600?980:800});
      await expect(agents).toContainText("Write the migration",{timeout:10000});
      await page.waitForTimeout(400);
      await page.screenshot({animations:"disabled",path:shots+`agents-long-name-${mode}-${width}.png`});
      const problems=await agents.evaluate(node=>{
        const out=[];if(node.scrollWidth>node.clientWidth+1)out.push("agents page scrolls sideways "+node.scrollWidth+">"+node.clientWidth);
        for(const el of node.querySelectorAll(".agent-row :is(strong,span,em,small)")){const s=getComputedStyle(el);const cut=(el.scrollWidth>el.clientWidth+1&&/(hidden|clip)/.test(s.overflowX))||(el.scrollHeight>el.clientHeight+1&&/(hidden|clip)/.test(s.overflowY));if(cut&&el.getAttribute("title")!==el.textContent)out.push(`"${el.textContent.slice(0,50)}" cut with no full-text tooltip`)}
        const rows=[...node.querySelectorAll(".agent-row")];
        for(const row of rows){const b=row.getBoundingClientRect();for(const el of row.querySelectorAll("*")){const r=el.getBoundingClientRect();if(r.width&&(r.right>b.right+1||r.left<b.left-1||r.bottom>b.bottom+1))out.push(`"${(el.textContent||"").slice(0,40)}" runs outside its row`)}}
        // The status dot, the name and the action buttons start at the same x in every row.
        for(const [selector,side] of [[".agent-status-dot","left"],[".agent-open>div>strong","left"],[".agent-actions","left"]]){const xs=[...new Set(rows.map(row=>Math.round(row.querySelector(selector).getBoundingClientRect()[side])))];if(xs.length>1)out.push(`${selector} ${side} edges differ between rows: ${xs.join(", ")}`)}
        return [...new Set(out)];
      });
      expect(problems).toEqual([]);
      const row=agents.locator(".agent-row").filter({hasText:"Investigate the flaky"});
      const name=row.locator(".agent-open>div>strong"),meta=row.locator(".agent-open>div>small").first();
      await expect(name).toHaveAttribute("title",LONG_AGENT);
      expect(await name.evaluate(el=>{const s=getComputedStyle(el);return Math.round(el.getBoundingClientRect().height/(parseFloat(s.lineHeight)||parseFloat(s.fontSize)*1.21))}),"the long name wraps onto a second line").toBe(2);
      // The meta line ends with the parent thread, which used to be cut away.
      await expect(meta).toContainText("parent fleet-pa");
      expect(await meta.evaluate(el=>el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1),"the meta line shows whole").toBe(true);
    }finally{await fixture.close()}
  });
}

// ============ Contrast: small text on every secondary page ============
// Every text run needs 4.5:1 (3:1 from 24px, or 18.66px bold) against what is painted under it: its own and its
// ancestors' translucent backgrounds laid over the first opaque one, each stop of a gradient counted, and its opacity and
// its ancestors' applied. Disabled controls and code are left out, as in the explorer's audit this is adapted from.
// Given a selector it lists the text under the threshold in that part of the page; given an element it returns the lowest
// ratio of that element's own text.
function lowContrastText(target){
  const parse=value=>{
    const text=String(value).trim();let match=text.match(/^rgba?\(([^)]+)\)$/);
    if(match){const p=match[1].split(/[\s,/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}}
    match=text.match(/^color\(srgb\s+([^)]+)\)$/);
    if(match){const p=match[1].split(/[\s/]+/).filter(Boolean).map(Number);return {r:p[0]*255,g:p[1]*255,b:p[2]*255,a:p.length>3?p[3]:1}}
    return null;
  };
  const over=(top,base)=>({r:top.r*top.a+base.r*(1-top.a),g:top.g*top.a+base.g*(1-top.a),b:top.b*top.a+base.b*(1-top.a),a:1});
  const stops=image=>(String(image).match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g)||[]).map(parse).filter(Boolean);
  // The colors that can be under an element's text: one per gradient stop, or the one flat color.
  const backdrops=el=>{
    const layers=[];
    for(let node=el;node;node=node.parentElement){
      const style=getComputedStyle(node);
      const gradient=/gradient\(/.test(style.backgroundImage)?stops(style.backgroundImage):[];
      if(gradient.length){layers.push({stops:gradient});if(gradient.every(stop=>stop.a>=1))break}
      const color=parse(style.backgroundColor);
      if(color&&color.a>0){layers.push({stops:[color]});if(color.a>=1)break}
    }
    let bases=[{r:255,g:255,b:255,a:1}];
    for(const layer of layers.reverse())bases=layer.stops.flatMap(stop=>bases.map(base=>over(stop,base)));
    return bases;
  };
  const luminance=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)};
  const ratioOf=(a,b)=>{const x=luminance(a)+.05,y=luminance(b)+.05;return x>y?x/y:y/x};
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&s.visibility!=="hidden"&&s.display!=="none"&&(typeof el.checkVisibility!=="function"||el.checkVisibility({opacityProperty:true,visibilityProperty:true}))};
  // A brightness() filter (a hovered primary button) lightens the text and the fill under it alike; the fills it is measured
  // over here are the button's own opaque ones.
  const brightness=el=>{let factor=1;for(let p=el;p;p=p.parentElement){const match=getComputedStyle(p).filter.match(/brightness\(([\d.]+)\)/);if(match)factor*=Number(match[1])}return factor};
  const lit=(c,factor)=>factor===1?c:{...c,r:Math.min(255,c.r*factor),g:Math.min(255,c.g*factor),b:Math.min(255,c.b*factor)};
  const lowestOf=el=>{
    const fg=parse(getComputedStyle(el).color);if(!fg)return null;
    let opacity=1;for(let p=el;p&&p!==document.documentElement;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity||1);
    const factor=brightness(el);
    let lowest=Infinity,under=null;
    for(const raw of backdrops(el)){const base=lit(raw,factor);const ratio=ratioOf(over({...lit(fg,factor),a:fg.a*opacity},base),base);if(ratio<lowest){lowest=ratio;under=base}}
    return {lowest,under};
  };
  if(target instanceof Element)return Number(lowestOf(target).lowest.toFixed(2));
  const scope=document.querySelector(target)||document.body;
  const issues=[],seen=new Set();
  const walker=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()){
    const text=node.textContent.trim();if(text.length<2)continue;
    const el=node.parentElement;if(!el||!visible(el)||el.closest("[aria-hidden=true],[disabled],:disabled,svg,pre,code"))continue;
    const style=getComputedStyle(el);const measured=lowestOf(el);if(!measured)continue;
    const size=parseFloat(style.fontSize),bold=Number(style.fontWeight)>=700;
    const need=size>=24||(size>=18.66&&bold)?3:4.5;
    const {lowest,under}=measured;
    if(lowest>=need)continue;
    const where=`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0]||""} in ${el.parentElement?.tagName.toLowerCase()}.${String(el.parentElement?.className||"").trim().split(/\s+/)[0]||""}`;
    const key=where+"|"+text.slice(0,30);if(seen.has(key))continue;seen.add(key);
    issues.push(`${lowest.toFixed(2)}:1 (needs ${need}) "${text.slice(0,48)}" ${size}px ${style.color} on rgb(${Math.round(under.r)},${Math.round(under.g)},${Math.round(under.b)}) ${where}`);
  }
  return issues.slice(0,80);
}
async function settle(page){
  await expect(page.locator(".surface-loading")).toHaveCount(0,{timeout:15_000});
  await expect(page.locator(".tb-skeleton").filter({visible:true})).toHaveCount(0,{timeout:15_000});
  await page.waitForTimeout(400);
}
// Settings > Agents & models is read with its harness list answered, not while every row still says "Checking…": the
// active harness (with its profile), one to switch to, one that needs setup and offers Sign in, and one that is not
// installed and offers Install. The answer is fixed so the rows do not depend on what this machine has installed.
const HARNESS_ROWS=[
  ["native","Trebell Native","native",{},{available:true,installed:true,authenticated:true,version:"Built in"}],
  ["codex","Codex","codex",{},{available:true,installed:true,authenticated:true,version:"0.46.0"}],
  ["opencode","OpenCode","http",{canAuthenticate:true},{available:true,installed:true,authenticated:null,message:"Sign-in could not be checked"}],
  ["claude","Claude Code","claude",{installable:true},{available:false,installed:false,authenticated:false,message:"Not installed on this machine"}],
];
const harnessList={selectedRuntime:"native",selectedInstanceId:"native-default",definitions:HARNESS_ROWS.map(([id,name,protocol,flags])=>({id,name,protocol,multipleInstances:true,...flags})),instances:HARNESS_ROWS.map(([kind,name])=>({id:kind+"-default",kind,displayName:name,enabled:true})),statuses:HARNESS_ROWS.map(([kind,name,,,status])=>({id:kind+"-default",kind,name,...status}))};

// The explorer met these at 1600x980; the audit also runs at 1280x800 (where the screenshots are taken) and 900x800, where
// the pages and panels lay out differently.
for(const [width,height] of [[1600,980],[1280,800],[900,800]])for(const mode of MODES){
  test(`small labels and helper lines read at 4.5:1 on every secondary page and panel (${mode} ${width})`,async({page,request})=>{
    test.setTimeout(240_000);
    await page.route(/\/api\/agent-runtimes$/,route=>route.request().method()==="GET"?json(route,harnessList):route.continue());
    await open(page,request,{mode,width,height});
    const found={};
    const check=async(name,scope="main")=>{
      await settle(page);
      if(width===1280)await page.screenshot({animations:"disabled",path:shots+`contrast-${name}-${mode}-1280.png`});
      found[name]=await page.evaluate(lowContrastText,scope);
    };
    // The tiers stay in order: a field label or a sub-line still reads quieter than the value or the name it goes with.
    const tiers=[];
    const quieter=async(what,quiet,loud)=>{
      const low=await quiet.first().evaluate(lowContrastText),high=await loud.first().evaluate(lowContrastText);
      tiers.push(`${what}: ${low} under ${high}`);
      expect.soft(low,`${mode} ${what} reads quieter than what it goes with`).toBeLessThan(high);
    };
    for(const label of ["Projects","History","Usage","Environments"]){await nav(page,label).click();await check(label.toLowerCase())}
    await quieter("Environments field label",page.locator(".environments-page .environment-create>label"),page.locator(".environments-page .environment-create select"));
    await quieter("Environments card sub-line",page.locator(".environments-page .capability-card span").filter({hasText:/^This machine$/}),page.locator(".environments-page .capability-card strong").filter({hasText:/^Local$/}));
    // A primary button keeps its white label readable while hovered, when its fill brightens: Add environment, which a name typed
    // in its empty Local form makes pressable.
    const add=page.locator(".environments-page .environment-create .primary");
    await page.locator(".environments-page .environment-create").getByRole("textbox",{name:"Name",exact:true}).fill("Contrast box");
    await add.hover();
    await add.evaluate(el=>{for(const animation of el.getAnimations())animation.finish()});
    await expect.poll(()=>add.evaluate(el=>getComputedStyle(el).filter)).toContain("brightness");
    const hovered=await add.evaluate(lowContrastText);
    tiers.push(`hovered primary button: ${hovered}`);
    expect.soft(hovered,`${mode} hovered "Add environment" text`).toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(0,0);
    await nav(page,"Projects").click();
    await quieter("Projects field label",page.locator(".projects-page .project-overrides label"),page.locator(".projects-page .project-overrides select"));
    for(const label of ["Agents","Browser"]){
      await nav(page,label).click();
      await expect(page.getByTestId("right-panel")).toBeVisible();
      await check(label.toLowerCase(),"[data-testid=right-panel]");
    }
    const close=page.getByRole("button",{name:"Close right panel"});
    if(await close.count())await close.click();
    await nav(page,"Settings").click();
    const sections=page.getByRole("navigation",{name:"Settings categories"}).getByRole("button");
    await expect(sections.first()).toBeVisible({timeout:15_000});
    const count=await sections.count();expect(count).toBeGreaterThanOrEqual(6);
    const harness=name=>page.locator(".agent-runtime-option").filter({hasText:name});
    for(let i=0;i<count;i++){
      const section=sections.nth(i);const label=(await section.locator("strong").textContent()).trim();
      await section.click();
      await expect(section).toHaveAttribute("aria-current","page");
      if(label==="Agents & models"){
        await expect(page.getByTestId("agent-runtime-skeleton")).toHaveCount(0,{timeout:15_000});
        await expect(harness("Trebell Native").locator("em")).toHaveText("Active");
        await expect(harness("Codex").locator("em")).toHaveText("Switch");
        await expect(harness("OpenCode").locator("em")).toHaveText("Needs setup");
        await expect(harness("OpenCode").getByRole("button",{name:"Sign in",exact:true})).toBeVisible();
        await expect(harness("Claude Code").getByRole("button",{name:"Install",exact:true})).toBeVisible();
        await expect(page.locator(".runtime-profile-row>button.active em")).toHaveText("Active");
      }
      await check("settings-"+label.toLowerCase().replace(/[^a-z]+/g,"-").replace(/-$/,""));
      if(label==="Agents & models"){
        await quieter("Settings harness status line",harness("Codex").locator("small"),harness("Codex").locator("strong"));
        await quieter("active harness status line",harness("Trebell Native").locator("small"),harness("Trebell Native").locator("strong"));
      }
      if(i===0)await quieter("open Settings section description",section.locator("small"),section.locator("strong"));
      if(i===1)await quieter("Settings section description",sections.first().locator("small"),sections.first().locator("strong"));
      if(label==="Workspace")await quieter("Settings field label",page.locator(".settings-page .settings-card label:has(>select)"),page.locator(".settings-page .settings-card label>select"));
    }
    await sections.first().click();
    await page.getByRole("button",{name:"View licenses"}).click();
    await expect(page.locator(".licenses-list>button").first()).toBeVisible({timeout:15_000});
    await check("licenses");
    console.log("CONTRAST "+mode+" "+width+" "+JSON.stringify(found,null,1));
    console.log("TIERS "+mode+" "+width+" "+JSON.stringify(tiers,null,1));
    for(const [name,issues] of Object.entries(found))expect.soft(issues,`${mode} ${width} ${name}: text under 4.5:1`).toEqual([]);
  });
}

// A tile colour the person picks for a project can be light (harness.spec.js picks #4f8cff, which the audit above then meets on
// the workspace's own project): its initials turn black where white would read under 4.5:1, and stay white on a dark pick.
for(const mode of MODES){
  test(`a project tile in a colour the person picked keeps its initials at 4.5:1 (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    const boot=await (await request.get("/api/bootstrap")).json();
    const tile=page.locator(".projects-page .project-open .project-icon").first();
    const ratios={};
    try{
      for(const [value,color] of [["E2","#4f8cff"],["PY","#ffe680"],["DK","#1d2a6b"]]){
        await request.post("/api/projects",{data:{path:boot.cwd,name:"Polish Workspace",icon:{kind:"monogram",value,color}}});
        await page.goto("/");
        await expect(page.getByTestId("composer")).toBeVisible();
        await nav(page,"Projects").click();
        await expect(tile).toHaveText(value);
        ratios[color]={ratio:await tile.evaluate(lowContrastText),ink:await tile.evaluate(el=>getComputedStyle(el).color)};
        await page.locator(".projects-page .project-card").first().screenshot({animations:"disabled",path:shots+`project-tile-${value}-${mode}.png`});
      }
      await page.screenshot({animations:"disabled",path:shots+`project-tile-${mode}-1280.png`});
    }finally{await request.post("/api/projects",{data:{path:boot.cwd,name:"Polish Workspace",icon:null}})}
    console.log("PROJECT-TILES "+mode+" "+JSON.stringify(ratios));
    for(const [color,{ratio}] of Object.entries(ratios))expect.soft(ratio,`initials on a ${color} tile`).toBeGreaterThanOrEqual(4.5);
    expect(ratios["#1d2a6b"].ink,"a dark pick keeps white initials").toBe("rgb(255, 255, 255)");
  });
}

// The same audit over the pages with content in them, which the walk above can meet empty: History rows, delegated agents
// in every state, and recorded usage with the environment menu open.
const DAY=86_400_000;
function usageAnswer(records){
  const total={totalTokens:0,inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,costUsd:0,costKnown:0};
  const models={},runtimes={},daily={},environments={};
  for(const record of records){
    for(const key of Object.keys(record.usage))total[key]+=record.usage[key];
    if(record.cost){total.costUsd+=record.cost.amount;total.costKnown++}
    for(const [bucket,key] of [[models,record.model],[runtimes,record.runtime],[daily,new Date(record.at).toISOString().slice(0,10)],[environments,record.environmentId||"local"]]){bucket[key]||={tokens:0,costUsd:0,turns:0};bucket[key].tokens+=record.usage.totalTokens;bucket[key].turns++;bucket[key].costUsd+=record.cost?.amount||0}
  }
  return {days:30,total,models,runtimes,daily,environments,environmentIds:null,records};
}
const usageRecord=(i,runtime,model,environmentId,cost)=>({id:"polish-usage-"+i,runtime,provider:"openai",model,environmentId,threadId:"polish-thread-"+i,turnId:"turn-"+i,at:Date.now()-i*DAY/3,usage:{totalTokens:42_000+i*1000,inputTokens:30_000,cachedInputTokens:12_000,cacheWriteInputTokens:2_000,outputTokens:12_000+i*1000,reasoningOutputTokens:3_000},cost:cost==null?null:{amount:cost,currency:"USD"}});

for(const mode of MODES){
  test(`recorded usage reads at 4.5:1, the environment menu included (${mode})`,async({page,request})=>{
    const records=[usageRecord(0,"native","gpt-5.1",null,0.42),usageRecord(1,"codex","gpt-5.1-codex","polish-ssh",null),usageRecord(2,"claude","claude-sonnet-4.5",null,1.08),usageRecord(3,"native","gpt-5.1-mini","polish-ssh",0.07)];
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,usageAnswer(records)):route.continue());
    await page.route(/\/api\/environments$/,route=>route.request().method()==="GET"?json(route,{profiles:[{id:"polish-ssh",name:"Build box",type:"ssh"}],activeEnvironmentId:null,activeEnvironment:null}):route.continue());
    await open(page,request,{mode});
    await nav(page,"Usage").click();
    await expect(page.locator(".usage-recent .usage-table")).toContainText("claude-sonnet-4.5");
    await page.locator(".usage-environment-filter>summary").click();
    await expect(page.locator(".usage-environment-filter>div")).toContainText("Build box");
    await settle(page);
    await page.screenshot({animations:"disabled",path:shots+`contrast-usage-records-${mode}-1280.png`});
    const issues=await page.evaluate(lowContrastText,".usage-page");
    console.log("USAGE-CONTRAST "+mode+" "+JSON.stringify(issues,null,1));
    expect(issues).toEqual([]);
    // A model row's token count and cost take the page's sizes, not the 9px the old shell stylesheet left them at.
    const model=page.locator(".usage-models>div").filter({hasText:"claude-sonnet-4.5"});
    await expect(model.locator("em")).toHaveText("$1.08");
    expect(await model.locator("b").evaluate(el=>getComputedStyle(el).fontSize)).toBe("12.5px");
    expect(await model.locator("em").evaluate(el=>getComputedStyle(el).fontSize)).toBe("11.5px");
    // At 900 wide the model rows keep the name, the count and the cost inside the card, with no sideways scroll.
    await page.locator(".usage-environment-filter>summary").click();
    await expect(page.locator(".usage-environment-filter")).not.toHaveAttribute("open","");
    await page.setViewportSize({width:900,height:800});
    await model.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+`contrast-usage-records-${mode}-900.png`});
    const narrow=await page.evaluate(()=>{
      const out=[];const root=document.documentElement;if(root.scrollWidth>root.clientWidth+1)out.push("page scrolls sideways");
      for(const node of document.querySelectorAll(".secondary-page,.usage-page"))if(node.scrollWidth>node.clientWidth+1)out.push(node.className+" scrolls sideways");
      for(const row of document.querySelectorAll(".usage-models>div")){const box=row.getBoundingClientRect();for(const el of row.querySelectorAll("strong,small,b,em")){const r=el.getBoundingClientRect();if(r.right>box.right+1||r.left<box.left-1)out.push(`"${el.textContent}" runs outside its row`)}}
      return out;
    });
    expect(narrow).toEqual([]);
    expect(await page.evaluate(lowContrastText,".usage-page")).toEqual([]);
  });

  test(`History rows read at 4.5:1 (${mode})`,async({page})=>{
    const threads=historyThreads(4,{long:true});
    const fixture=await startCodex(threads);
    try{
      await openCodexHistory(page,fixture,threads,{mode});
      await settle(page);
      const issues=await page.evaluate(lowContrastText,".history-page");
      console.log("HISTORY-CONTRAST "+mode+" "+JSON.stringify(issues,null,1));
      expect(issues).toEqual([]);
    }finally{await fixture.close()}
  });

  test(`delegated agents read at 4.5:1 in every state (${mode})`,async({page})=>{
    const fixture=await startFleet([child("c1","Map the payment retries","active"),child("c2","Write the migration","idle","worker"),child("c3","Review the docs","notLoaded","reviewer"),child("c4","Rebuild the search index","systemError","worker")]);
    try{
      const agents=await openAgents(page,fixture,{mode});
      await expect(agents).toContainText("Rebuild the search index",{timeout:10_000});
      await settle(page);
      await page.screenshot({animations:"disabled",path:shots+`contrast-agents-fleet-${mode}-1280.png`});
      const issues=await page.evaluate(lowContrastText,".agents-page");
      console.log("FLEET-CONTRAST "+mode+" "+JSON.stringify(issues,null,1));
      expect(issues).toEqual([]);
    }finally{await fixture.close()}
  });
}
