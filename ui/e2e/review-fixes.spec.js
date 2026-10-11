import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The harness end of the agent socket (as in reasoning-text.spec.js): it answers what the window asks, starts the turns it is
// sent, and pushes what the test sends.
async function startHarness(thread,{continuity=null}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),started=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"review-fixes-fixture"};
    else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="turn/start"){started.push(message.params);result={turn:{id:"turn-"+started.length,status:"inProgress",items:[]}}}
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  })});
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",started,
    push(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params:{threadId:thread.id,...params}}))},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

// A thread in a project (so a sent turn builds a repository context packet) or a projectless one; thread metadata the window
// saves is kept, as the server keeps it.
async function openApp(page,{harness,thread,project=null}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  let meta={projectless:!project,environmentId:null};
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...(project?{activeProjectId:project.id}:{})};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:thread.cwd,platform:process.platform,version:"review-fixes-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:project?[project]:[],threadMeta:{[thread.id]:meta}}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:[thread.model],metadata:{provider:"openai",models:[{id:thread.model,name:"Fixture Model",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,route=>{if(route.request().method()==="POST")meta={...meta,...(route.request().postDataJSON()?.patch||{})};return json(route,meta)});
  await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,route.request().method()==="GET"?{checkpoints:[]}:{supported:false}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:project?[project]:[],...(project?{project}:{})}));
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/git\/info\?/,route=>json(route,{isGit:true,root:thread.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],remotes:[],worktrees:[{path:thread.cwd,branch:"main"}]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${thread.name}"]`)});
  await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}

// Waits two frames so a capture after a scroll jump or a theme switch shows the painted result.
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

test("an opened thought keeps one thought per line without blank lines in lists or after a hard break",async({page})=>{
  test.setTimeout(45_000);
  const thoughts=[
    ["newline","First thought on its own line\nSecond thought on the next line"],
    ["loose","- First loose item\n\n- Second loose item"],
    ["nested","- Parent item\n  - Child item\n- Sibling item"],
    ["hard-break","Hard break line one\\\nHard break line two"],
  ];
  const reply="The reply keeps Markdown's soft break\nas a space, on one line.";
  const thread={id:"review-reasoning-layout",name:"Reasoning layout fixture",preview:"Reasoning layout",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"Plan the login fix."}]},
    ...thoughts.map(([id,text])=>({type:"reasoning",id:"reasoning-"+id,summary:[],content:[text]})),
    {type:"agentMessage",id:"assistant-1",text:reply},
  ]}]};
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:1000});
    await openApp(page,{harness,thread});
    const rows=page.locator(".conversation-history [data-testid=reasoning-row]");
    await expect(rows).toHaveCount(thoughts.length);
    for(let index=0;index<thoughts.length;index++)await rows.nth(index).locator(".reasoning-toggle").click();
    const texts=page.locator(".conversation-history [data-testid=reasoning-text]");
    await expect(texts).toHaveCount(thoughts.length);
    await expect(texts.nth(1).locator("li")).toHaveText(["First loose item","Second loose item"]);
    // Each thought's rendered block, as shipped and with white-space:normal forced on its Markdown blocks (the layout with no
    // line-break rule at all), in lines of the thought's own line height.
    const measure=forceNormal=>texts.evaluateAll((nodes,forceNormal)=>{
      const style=document.createElement("style");style.textContent=".reasoning-text.chat-markdown :is(p,li,ul,ol){white-space:normal!important}";
      if(forceNormal)document.head.append(style);
      try{return nodes.map(node=>{const block=node.firstElementChild,height=block.getBoundingClientRect().height,line=parseFloat(getComputedStyle(block).lineHeight);return {tag:block.tagName,height,lines:Math.round(height/line)}})}
      finally{style.remove()}
    },forceNormal);
    const shipped=await measure(false),normal=await measure(true);
    const at=Object.fromEntries(thoughts.map(([id],index)=>[id,{shipped:shipped[index],normal:normal[index]}]));
    // A single newline in a thought stays a line break: two lines, not one run-on line.
    expect.soft(at.newline.shipped,JSON.stringify(at)).toMatchObject({tag:"P",lines:2});
    // A loose list, a nested list and a hard break take no more room than with white-space:normal (white-space:pre-line on
    // paragraphs and list items showed the newlines between their blocks as blank lines, and doubled the hard break).
    for(const id of ["loose","nested","hard-break"])expect.soft(at[id].shipped.height,id+" "+JSON.stringify(at[id])).toBeLessThanOrEqual(at[id].normal.height+0.5);
    expect.soft(at["hard-break"].shipped,JSON.stringify(at["hard-break"])).toMatchObject({tag:"P",lines:2});
    // The nested list's three items sit on three consecutive lines.
    const itemTops=await texts.nth(2).locator("li").evaluateAll(items=>items.map(item=>item.getBoundingClientRect().top));
    expect(itemTops).toHaveLength(3);
    const lineHeight=await texts.nth(2).evaluate(node=>parseFloat(getComputedStyle(node).lineHeight));
    for(let index=1;index<itemTops.length;index++)expect(itemTops[index]-itemTops[index-1]).toBeLessThan(lineHeight*1.6);
    // A reply renders exactly as before: Markdown's soft break is a space, so the paragraph is one line with no break.
    const answer=page.locator(".conversation-history .assistant-message-text").last();
    await expect(answer).toHaveText(reply.replace("\n"," "));
    await expect(answer.locator("br")).toHaveCount(0);
    expect(await answer.locator("p").evaluate(node=>Math.round(node.getBoundingClientRect().height/parseFloat(getComputedStyle(node).lineHeight)))).toBe(1);
    await rows.first().scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"review-reasoning-breaks-dark-1280x1000.png"),animations:"disabled"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await settle(page);
    await page.screenshot({path:join(shotsDir,"review-reasoning-breaks-light-1280x1000.png"),animations:"disabled"});
  }finally{await harness.close()}
});

test("an opened thought keeps the lines of raw HTML in it, and an HTML block is spaced like a paragraph",async({page})=>{
  test.setTimeout(45_000);
  // Raw HTML stays text in a thought (no rehype-raw). Each case lists the lines it was written in, in order: an XML-style block
  // with a paragraph after a blank line, one in a quote, an HTML block that interrupts a tight list item's paragraph and one
  // that is a whole item, and inline HTML that spans a line.
  const thoughts=[
    ["block","<plan>\nstep 1\nstep 2\n</plan>\n\nAfter the plan\nnext line",["<plan>","step 1","step 2","</plan>","After the plan","next line"]],
    ["quote","> <note>\n> keep this line\n> </note>",["<note>","keep this line","</note>"]],
    ["list","- Check the config\n  <details>\n  more detail\n  </details>\n- <answer>\n- Next item",["Check the config","<details>","more detail","</details>","<answer>","Next item"]],
    ["inline","Use <span\nclass=\"note\">this</span> here",["Use <span","class=\"note\">this</span> here"]],
  ];
  const thread={id:"review-reasoning-html",name:"Reasoning HTML fixture",preview:"Reasoning HTML",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"Plan the config check."}]},
    ...thoughts.map(([id,text])=>({type:"reasoning",id:"reasoning-"+id,summary:[],content:[text]})),
    {type:"agentMessage",id:"assistant-1",text:"Done."},
  ]}]};
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:1000});
    await openApp(page,{harness,thread});
    const rows=page.locator(".conversation-history [data-testid=reasoning-row]");
    await expect(rows).toHaveCount(thoughts.length);
    for(let index=0;index<thoughts.length;index++)await rows.nth(index).locator(".reasoning-toggle").click();
    const texts=page.locator(".conversation-history [data-testid=reasoning-text]");
    await expect(texts).toHaveCount(thoughts.length);
    for(const [index,[id,,lines]] of thoughts.entries()){
      // The top of each written line as laid out (found in the rendered text in order, across text nodes), the thought's line
      // height and a paragraph's bottom margin.
      const layout=await texts.nth(index).evaluate((node,lines)=>{
        const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),spans=[];let all="";
        for(let text=walker.nextNode();text;text=walker.nextNode()){spans.push({text,start:all.length});all+=text.data}
        const at=offset=>{const span=spans.findLast(span=>span.start<=offset);return [span.text,offset-span.start]};
        let from=0;
        const tops=lines.map(line=>{
          const start=all.indexOf(line,from);if(start<0)return null;from=start+line.length;
          const range=document.createRange();range.setStart(...at(start));range.setEnd(...at(start+line.length-1));range.setEnd(range.endContainer,range.endOffset+1);
          return Math.round([...range.getClientRects()].find(rect=>rect.width>0)?.top??NaN);
        });
        const probe=document.createElement("p");node.prepend(probe);const margin=parseFloat(getComputedStyle(probe).marginBottom);probe.remove();
        return {tops,lineHeight:parseFloat(getComputedStyle(node).lineHeight),margin};
      },lines);
      const detail=id+" "+JSON.stringify({lines,...layout});
      expect(layout.tops.every(Number.isFinite),detail).toBe(true);
      // Every written line is its own line, and none is followed by a blank line.
      for(let line=1;line<lines.length;line++){
        const step=layout.tops[line]-layout.tops[line-1];
        expect.soft(step,detail+" before "+JSON.stringify(lines[line])).toBeGreaterThanOrEqual(layout.lineHeight-1);
        expect.soft(step,detail+" before "+JSON.stringify(lines[line])).toBeLessThan(layout.lineHeight*1.6);
      }
      // The block written before a blank line keeps a paragraph's spacing below it, as a paragraph there would.
      if(id==="block")expect.soft(layout.tops[4]-layout.tops[3],detail).toBeGreaterThanOrEqual(layout.lineHeight+layout.margin-1);
    }
    await expect(texts.first()).toContainText("<plan>");
    await rows.first().scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"review-reasoning-html-dark-1280x1000.png"),animations:"disabled"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await settle(page);
    await page.screenshot({path:join(shotsDir,"review-reasoning-html-light-1280x1000.png"),animations:"disabled"});
  }finally{await harness.close()}
});

test("both Context Inspector notices stay readable while the panel scrolls",async({page})=>{
  test.setTimeout(45_000);
  const project={id:"review-context-project",name:"Review Context Project",path:process.cwd(),environmentId:null};
  const thread={id:"review-context-notices",name:"Context notices fixture",preview:"Context notices",cwd:project.path,model:"fixture-model",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const files=["src/auth/session.js","src/auth/token.js","src/auth/cookies.js","src/server.js","tests/auth-refresh.test.js","tests/session.test.js"];
  const packet={id:"ctx-review",root:project.path,task:"Fix refresh token session bug",generatedAt:Date.now(),tokenEstimate:640,maxTokens:7000,injection:"Repository evidence",untrustedInjection:"Repository evidence",
    budget:{mode:"focused",maxTokens:2800,maxFiles:12,reason:"short/focused task"},stats:{filesIndexed:138,reparsed:3,reused:135,graphEdges:412},
    items:files.map((path,index)=>({path,score:90-index*12,reasons:["contains task terms: refresh, token","structurally central in repository graph"],symbols:[{name:"refreshSession"+index,kind:"function",line:8+index}],tokenEstimate:100}))};
  // The first turn gets a packet, the second skips injection under context pressure, and the third fails to refresh: the
  // window then keeps the pressure notice and adds the failure notice above it.
  const responses=[
    {status:200,body:packet},
    {status:200,body:{id:"ctx-pressure",root:project.path,generatedAt:Date.now(),tokenEstimate:0,maxTokens:0,items:[],injection:"",skipped:true,budget:{mode:"exhausted",pressure:"exhausted",maxTokens:0,maxFiles:0,skip:true,remainingTokens:7000,reserveTokens:8000,reason:"context window only has the response safety reserve left"},stats:{filesIndexed:0,skippedByPressure:true}}},
    {status:500,body:{error:"Deliberate context refresh failure"}},
  ];
  let contextCalls=0;
  await page.route(/\/api\/context\/packet$/,route=>{const response=responses[Math.min(contextCalls++,responses.length-1)];return route.fulfill({status:response.status,contentType:"application/json",body:JSON.stringify(response.body)})});
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread,project});
    for(const [index,text] of ["Fix refresh token session bug","Continue without crowding the context window","Continue even if the context refresh fails"].entries()){
      await page.getByTestId("composer").fill(text);await page.getByTestId("send").click();
      await expect.poll(()=>harness.started.length).toBe(index+1);
      harness.push("turn/completed",{turn:{id:"turn-"+(index+1),status:"completed"}});
      await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);
    }
    expect(contextCalls).toBe(3);
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel");
    await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Context",exact:true}).click();
    const inspector=panel.locator(".context-inspector");
    const warning=inspector.getByRole("alert").filter({hasText:"Latest context refresh failed."}),pressure=inspector.getByRole("status").filter({hasText:"Latest turn preserved response space."});
    await expect(warning).toContainText("Deliberate context refresh failure");
    await expect(pressure).toContainText("7,000 context tokens remained");
    await expect(inspector).toContainText("6 selected files");
    // Scrolled down to the selected files, each notice is still on screen and on top at its own centre: neither covers the other,
    // and no scrolled row shows between them.
    const body=panel.locator(".context-panel-body");
    for(const scroll of ["middle","end"]){
      const scrollTop=await body.evaluate((node,scroll)=>{node.scrollTop=scroll==="end"?node.scrollHeight:Math.round((node.scrollHeight-node.clientHeight)/2);return node.scrollTop},scroll);
      expect(scrollTop,scroll).toBeGreaterThan(150);await settle(page);
      const hits=await inspector.evaluate(node=>{
        const view=node.closest(".context-panel-body").getBoundingClientRect();
        return [".context-inspector-warning",".context-inspector-pressure"].map(selector=>{
          const notice=node.querySelector(selector),box=notice.getBoundingClientRect(),hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
          return {selector,top:Math.round(box.top-view.top),bottom:Math.round(box.bottom-view.top),onTop:notice.contains(hit)};
        });
      });
      expect.soft(hits.map(hit=>hit.onTop),scroll+" "+JSON.stringify(hits)).toEqual([true,true]);
      expect.soft(hits[0].top,scroll+" "+JSON.stringify(hits)).toBeGreaterThanOrEqual(0);
      expect.soft(hits[0].bottom,scroll+" "+JSON.stringify(hits)).toBeLessThanOrEqual(hits[1].top);
      const gap=await inspector.evaluate(node=>{
        const first=node.querySelector(".context-inspector-warning").getBoundingClientRect(),second=node.querySelector(".context-inspector-pressure").getBoundingClientRect();
        const hit=document.elementFromPoint(first.left+first.width/2,(first.bottom+second.top)/2);
        return {height:second.top-first.bottom,underRow:Boolean(hit?.closest(".context-inspector-hero,.context-explorer,.context-inspector-list,.context-inspector-payload,.context-inspector-note"))};
      });
      expect.soft(gap.underRow,scroll+" "+JSON.stringify(gap)).toBe(false);
    }
    await expect(warning).toBeInViewport();await expect(pressure).toBeInViewport();
    await page.screenshot({path:join(shotsDir,"review-context-notices-scrolled-dark-1280x800.png"),animations:"disabled"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await settle(page);
    await page.screenshot({path:join(shotsDir,"review-context-notices-scrolled-light-1280x800.png"),animations:"disabled"});
    await body.evaluate(node=>{node.scrollTop=0});await settle(page);
    await page.screenshot({path:join(shotsDir,"review-context-notices-top-light-1280x800.png"),animations:"disabled"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await settle(page);
    await page.screenshot({path:join(shotsDir,"review-context-notices-top-dark-1280x800.png"),animations:"disabled"});
    const bounds=await body.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
  }finally{await harness.close()}
});

test("the goal panel names a workspace at a filesystem root by its path",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"review-goal-root",name:"Root workspace fixture",preview:"Root workspace",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const continuity={
    threadId:thread.id,notes:{completedWork:[],unresolvedFailures:[],importantDecisions:[],artifactsCreated:[],pendingNextActions:[],updatedAt:0},
    workspace:{cwd:"/",branch:null,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default"},verification:null,
    completedTurnIds:["turn-1"],unresolvedFailures:[],recentFailures:[],artifactsCreated:[],pendingNextActions:[],completedWork:[],importantDecisions:[],meaningful:true,updatedAt:Date.now(),
  };
  const harness=await startHarness(thread,{continuity});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    await page.locator(".workspace-header").getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel");await expect(panel).toBeVisible();
    await panel.locator(".goal-continuity-details>summary").click();
    // The cwd is known: a root has no folder name, so the cell shows the path itself instead of "No workspace metadata".
    const workspaceCell=panel.getByTestId("continuity-derived").locator("div").filter({hasText:"Workspace"}).locator("strong");
    await expect.soft(workspaceCell).toHaveText("/");await expect(workspaceCell).toHaveAttribute("title","/");
    await panel.getByTestId("continuity-derived").scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"review-goal-root-workspace-dark-1280x800.png"),animations:"disabled"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await settle(page);
    await page.screenshot({path:join(shotsDir,"review-goal-root-workspace-light-1280x800.png"),animations:"disabled"});
  }finally{await harness.close()}
});
