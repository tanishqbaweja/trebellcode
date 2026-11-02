import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as relay from "../../src/agent-relay.mjs";
import { acpToolFrame } from "../../src/acp-tool-state.mjs";
import { museItemRow } from "../../src/muse-rows.mjs";

// The conversation as a person reads it (tour lane L10): a step that was declined or not allowed, Native's approval cards, a reply
// written one item per line, a reply table in a narrow window, Muse Code's reads, a new thread's title while its first turn runs,
// and the Usage page's name for this computer. Items are made by the relay's own mapping (agentToolLifecycle, museItemRow), as the
// window gets them from Native and Muse Code.
const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function shoot(page,name){
  await settle(page);await page.screenshot({path:join(shotsDir,name+"-dark.png"),animations:"disabled"});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await settle(page);
  await page.screenshot({path:join(shotsDir,name+"-light.png"),animations:"disabled"});
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await settle(page);
}

// The harness end of the agent socket: it answers what the window asks, starts the turns it is sent (onTurn runs then), pushes
// what the test sends, and asks the window what the test asks (a server request), resolving with its answer.
async function startHarness(thread,{onTurn=null}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),started=[],answers=new Map();let nextId=1;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const harness={
    started,
    push(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params:{threadId:thread.id,...params}}))},
    ask(method,params){const id="ask-"+nextId++;return new Promise(resolve=>{answers.set(id,resolve);for(const ws of sockets)ws.send(JSON.stringify({id,method,params:{threadId:thread.id,...params}}))})},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.id!=null&&!message.method&&answers.has(message.id)){const resolve=answers.get(message.id);answers.delete(message.id);resolve(message.result);return}
    if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"conversation-words-fixture"};
    else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="turn/start"){started.push(message.params);result={turn:{id:"turn-new-"+started.length,status:"inProgress",items:[]}};setTimeout(()=>onTurn?.(harness,message.params,result.turn),50)}
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  })});
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  harness.wsUrl="ws://127.0.0.1:"+port+"/api/agent/ws";
  return harness;
}

const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
async function routeApp(page,{harness,cwd,model="muse-spark-1.3"}){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  let meta={projectless:true,environmentId:null};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"conversation-words-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:[model],metadata:{provider:"openai",models:[{id:model,name:"Fixture Model",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,route=>{if(route.request().method()==="POST")meta={...meta,...(route.request().postDataJSON()?.patch||{})};return json(route,meta)});
  await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,route.request().method()==="GET"?{checkpoints:[]}:{supported:false}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
}
async function openThread(page,{harness,thread,title=thread.name||thread.preview||"Untitled task"}){
  await routeApp(page,{harness,cwd:thread.cwd,model:thread.model});
  await page.goto("/");
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
  return row;
}
// Opens a turn's activity card, which a past turn's card may already be.
async function openCard(card){
  await expect(card).toBeVisible({timeout:15_000});
  await expect(async()=>{if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click();await expect(card).toHaveAttribute("data-state","open",{timeout:1000})}).toPass({timeout:10_000});
}
const baseThread=(id,extra={})=>({id,name:null,preview:null,cwd:process.cwd(),model:"muse-spark-1.3",status:{type:"idle"},createdAt:Date.now()/1000-120,updatedAt:Date.now()/1000-60,...extra});
// A Native tool's end as Native reports it (tool_call_update), mapped by the relay.
const {agentToolLifecycle}=relay;
// What the relay asks Native's card with: nativeApprovalCard's words (an earlier build sent the tool's id and the policy's reason).
const nativeCardParams=(call,authorization)=>{
  if(typeof relay.nativeApprovalCard!=="function")return {reason:relay.nativeApprovalReason(call,authorization)};
  const card=relay.nativeApprovalCard(call,authorization);return {reason:card.reason,trebellTitle:card.title,...(card.command?{command:card.command}:{}),trebellNotice:card.notice};
};
const nativeItem=(id,namespace,tool,args,status,rawOutput)=>agentToolLifecycle({sessionUpdate:"tool_call_update",toolCallId:id,namespace,tool,title:namespace+" / "+tool,kind:"other",rawInput:args,rawOutput,status}).item;

test("a step that was declined or not allowed reads so and is not counted as failed, while a real failure still is (L10-F-4)",async({page})=>{
  test.setTimeout(60_000);
  const items=[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"Answer from my attached documents only."}]},
    nativeItem("call-ok","trebell_workspace","read_file",{path:"docs/secret-notes.md"},"completed",{path:"docs/secret-notes.md",content:"# Secret notes\n"}),
    // Deny on Native's card: its result says it needed approval.
    nativeItem("call-denied","trebell_terminal","run",{command:"bash",args:["-lc","ls ~/attachments/"]},"failed",{success:false,decision:"CONFIRM",confirmationRequired:true,error:"Tool execution was not approved.",uncertain:false,retrySafe:false}),
    // Its access level refused it unasked: a read outside the project, and a write in Read only.
    nativeItem("call-outside","trebell_workspace","read_file",{path:"/home/me/attachments/memo-ja.rtf"},"failed",{success:false,error:"Requested path is outside the active workspace boundary.",decision:"REJECT",confirmationRequired:false,uncertain:false,retrySafe:false}),
    nativeItem("call-readonly","trebell_workspace","write_file",{path:"notes.md",content:"x"},"failed",{success:false,decision:"REJECT",error:"Read Only profile rejects mutating or executable actions."}),
    // Codex reports a command the person declined as declined, and a command that ran and failed as failed.
    {type:"commandExecution",id:"codex-declined",command:"rm -rf build",cwd:process.cwd(),status:"declined",aggregatedOutput:"",exitCode:null,commandActions:[]},
    {type:"commandExecution",id:"codex-failed",command:"npm test",cwd:process.cwd(),status:"failed",aggregatedOutput:"1 failing\n",exitCode:1,commandActions:[]},
    {type:"agentMessage",id:"assistant-1",text:"The terminal probe was not approved, so I read only the project files."},
  ];
  const thread=baseThread("refused-steps",{name:"Refused steps",turns:[{id:"turn-1",status:"completed",items}]});
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:900});
    await openThread(page,{harness,thread});
    const card=page.getByTestId("activity-card").first();
    await openCard(card);
    // The head counts the one command that failed: not the declined or not allowed steps.
    await expect(card.locator(".activity-card-summary")).toHaveText("6 steps");
    await expect(card.locator(".activity-card-failed")).toHaveText("1 failed");
    const row=title=>card.locator(".tool-event").filter({has:page.locator(`summary strong[title="${title}"]`)});
    await expect(row("Read docs/secret-notes.md").locator("summary em")).toHaveText("done");
    await expect(row("bash -lc ls ~/attachments/").locator("summary em")).toHaveText("declined");
    await expect(row("bash -lc ls ~/attachments/")).not.toHaveClass(/status-error/);
    await expect(row("Read /home/me/attachments/memo-ja.rtf").locator("summary em")).toHaveText("not allowed");
    await expect(row("Write notes.md").locator("summary em")).toHaveText("not allowed");
    await expect(row("rm -rf build").locator("summary em")).toHaveText("declined");
    await expect(row("npm test").locator("summary em")).toHaveText("failed");
    await expect(row("npm test")).toHaveClass(/status-error/);
    // Each opens to why it did not run, in plain words, not the item's JSON.
    for(const [title,why] of [["bash -lc ls ~/attachments/","Not run: it was not approved."],["Read /home/me/attachments/memo-ja.rtf","Not run: it is outside the project folder, which this access level does not allow."],["Write notes.md","Not run: Read only does not allow changes or commands."],["rm -rf build","Not run: it was not approved."]]){
      await row(title).locator("summary").click();
      await expect(row(title).locator(".tool-event-body")).toContainText(why);
      await expect(row(title).locator(".tool-event-body .tool-json")).toHaveCount(0);
    }
    await expect(card).not.toContainText("Tool execution was not approved");
    await card.scrollIntoViewIfNeeded();
    await shoot(page,"l10-refused-steps-1280");
  }finally{await harness.close()}
});

test("Native's approval cards say what they ask in plain words, with no tool or policy names (L10-F-5)",async({page})=>{
  test.setTimeout(60_000);
  const thread=baseThread("native-cards",{name:"Native approval cards",turns:[{id:"turn-1",status:"inProgress",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Create data.txt and run node count-lines.js."}]}]}],status:{type:"active",activeFlags:[]}});
  const harness=await startHarness(thread);
  // As the relay asks: the card it makes of the call and the access level's answer.
  const supervised={decision:"CONFIRM",reason:"Supervised profile requires confirmation.",profile:"supervised"};
  const ask=call=>harness.ask("item/tool/requestApproval",{...nativeCardParams(call,supervised),toolCall:{toolCallId:call.id,title:call.namespace+"/"+call.name,kind:"other",rawInput:call.arguments}});
  try{
    await page.setViewportSize({width:1280,height:900});
    await openThread(page,{harness,thread});
    const approval=page.locator(".approval-card");
    const write=ask({id:"call-write",namespace:"trebell_workspace",name:"write_file",arguments:{path:"data.txt",content:"alpha\nbeta\ngamma\n"}});
    await expect(approval.locator(".card-title strong")).toHaveText("File write needs approval");
    await expect(approval.locator("p").first()).toHaveText("Write data.txt. Supervised asks before each change, command or web request.");
    await expect(approval).not.toContainText("trebell_");await expect(approval).not.toContainText("profile");
    await shoot(page,"l10-native-write-card-1280");
    await approval.getByRole("button",{name:"Allow once",exact:true}).click();
    expect((await write).decision).toBe("accept");
    const run=ask({id:"call-run",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["count-lines.js"],cwd:"."}});
    await expect(approval.locator(".card-title strong")).toHaveText("Command needs approval");
    await expect(approval.locator("p").first()).toHaveText("Supervised asks before each change, command or web request.");
    await expect(approval.getByTestId("approval-command")).toHaveText("node count-lines.js");
    await expect(approval).not.toContainText("trebell_");await expect(approval).not.toContainText("requires confirmation");
    await shoot(page,"l10-native-run-card-1280");
    await approval.getByRole("button",{name:"Deny",exact:true}).click();
    expect((await run).decision).toBe("decline");
  }finally{await harness.close()}
});

test("a reply written one item per line keeps its lines (L10-9)",async({page})=>{
  test.setTimeout(45_000);
  const reply="PNG image: 1309\nJPEG image: 9813\nGIF image: 77\nWebP image: 4410";
  const thread=baseThread("reply-lines",{name:"Reply lines",turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Each attached image shows one number. List them one per line, no bullets."}]},{type:"agentMessage",id:"assistant-1",text:reply}]}]});
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openThread(page,{harness,thread});
    const answer=page.locator(".conversation-history .assistant-message-text").last();
    await expect(answer.locator("p")).toHaveCount(1);
    await expect(answer.locator("p br")).toHaveCount(3);
    const lines=await answer.locator("p").evaluate(node=>Math.round(node.getBoundingClientRect().height/parseFloat(getComputedStyle(node).lineHeight)));
    expect(lines).toBe(4);
    await shoot(page,"l10-reply-lines-1280");
  }finally{await harness.close()}
});

test("a reply table in a 390 px window keeps words and numbers whole and scrolls sideways (L10-14)",async({page})=>{
  test.setTimeout(45_000);
  const table="| Bird | Count | Where | Note |\n| --- | ---: | --- | --- |\n| Juniper | 4200 | harbor_report_final_version_2026.docx | a very long note that goes on and on to make this table wide enough to need a scroll bar on a narrow window |\n| Heron | 310 | dock | short |";
  const thread=baseThread("reply-table",{name:"Reply table",turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"A three-column table with a long cell, please."}]},{type:"agentMessage",id:"assistant-1",text:"Here it is:\n\n"+table}]}]});
  const harness=await startHarness(thread);
  try{
    // Opened in a wide window, then read at 390 px, where the sidebar folds away.
    await page.setViewportSize({width:1280,height:844});
    await openThread(page,{harness,thread});
    await page.setViewportSize({width:390,height:844});
    const answer=page.locator(".conversation-history .assistant-message-text").last();
    await expect(answer.locator("table")).toBeVisible();
    // Each cell's words and numbers stay on one line: one line box per word.
    const lineCount=text=>answer.locator("td,th").filter({hasText:new RegExp("^"+text+"$")}).evaluate(cell=>{const range=document.createRange();range.selectNodeContents(cell);return new Set([...range.getClientRects()].map(rect=>Math.round(rect.top))).size});
    for(const word of ["Juniper","4200","Heron","310","Count"])expect(await lineCount(word),word).toBe(1);
    // The table is wider than the reply and scrolls in its own box, the page itself not sideways.
    const box=await answer.locator("table").evaluate(table=>({scroll:table.scrollWidth,client:table.clientWidth,overflow:getComputedStyle(table).overflowX,page:document.documentElement.scrollWidth,view:window.innerWidth}));
    expect(box.scroll,JSON.stringify(box)).toBeGreaterThan(box.client);
    expect(box.overflow).toBe("auto");
    expect(box.page,JSON.stringify(box)).toBeLessThanOrEqual(box.view);
    await answer.locator("table").scrollIntoViewIfNeeded();
    await shoot(page,"l10-reply-table-390");
    await answer.locator("table").evaluate(table=>{table.scrollLeft=table.scrollWidth});
    await shoot(page,"l10-reply-table-scrolled-390");
  }finally{await harness.close()}
});

test("Muse Code's read rows name the file and the part of a long file they read (L10-F-6)",async({page})=>{
  test.setTimeout(45_000);
  const home="C:\\Users\\me\\.trebell\\attachments\\";
  // Muse's items as the Muse session rows them (museItemRow) and the relay files them (agentToolLifecycle).
  const read=(id,args,extra={})=>agentToolLifecycle({sessionUpdate:"tool_call_update",...acpToolFrame(museItemRow({itemId:id,kind:"toolCall",tool:"read_file",status:"completed",revision:2,args:JSON.stringify(args),visibleOutput:"Read text file `x`.\n1|alpha",...extra}))}).item;
  const items=[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"What do my attached documents say?"}]},
    read("r1",{path:home+"1793618267521-6fbe65d0-harbor-report.docx.txt"}),
    read("r2",{path:"docs/notes.md"}),
    read("r3",{path:home+"1793618868946-f28073b7-long-log.docx.txt",offset:500,limit:2000}),
    read("r4",{path:home+"1793618868946-f28073b7-long-log.docx.txt",offset:2226,limit:2000}),
    {type:"agentMessage",id:"assistant-1",text:"The harbor report names its vault code."},
  ];
  const thread=baseThread("muse-reads",{name:"Muse reads",turns:[{id:"turn-1",status:"completed",items}]});
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openThread(page,{harness,thread});
    const card=page.getByTestId("activity-card").first();
    await openCard(card);
    await expect(card.locator(".tool-event summary strong")).toHaveText(["Read the text of harbor-report.docx","Read docs/notes.md","Read the text of long-log.docx from line 500","Read the text of long-log.docx from line 2,226"]);
    await expect(card).not.toContainText("read_file");
    await card.scrollIntoViewIfNeeded();
    await shoot(page,"l10-muse-reads-1280");
  }finally{await harness.close()}
});

test("a new thread reads its first message as its title while its first turn runs (L10-F-8)",async({page})=>{
  test.setTimeout(45_000);
  const message="Count the non-empty lines in data.txt and tell me the number it printed";
  const thread=baseThread("first-title",{turns:[]});
  // As the relay does on the thread's first turn/start: the title goes out at once, and the turn keeps running.
  const harness=await startHarness(thread,{onTurn:(h,params,turn)=>{h.push("turn/started",{turn});h.push("thread/preview/updated",{preview:message})}});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openThread(page,{harness,thread,title:"Untitled task"});
    await expect(page.locator(".thread-title-button strong")).toHaveText("Untitled task");
    await page.getByTestId("composer").fill(message);await page.getByTestId("send").click();
    await expect.poll(()=>harness.started.length).toBe(1);
    await expect(page.locator(".thread-title-button strong")).toHaveText(message);
    await expect(page.locator(`.thread-row .thread-main[title="${message}"]`)).toHaveCount(1);
    await expect(page.locator(".thread-row .thread-main",{hasText:"Untitled task"})).toHaveCount(0);
    await shoot(page,"l10-first-title-1280");
  }finally{await harness.close()}
});

test("Usage names the environment of turns run on this computer plainly (L10-F-9)",async({page})=>{
  test.setTimeout(45_000);
  const thread=baseThread("usage-thread",{name:"Usage thread",turns:[]});
  const harness=await startHarness(thread);
  const record={id:"usage-local-record",at:new Date().toISOString(),environmentId:null,runtime:"native",provider:"meta",model:"muse-spark-1.3-contributor",usage:{inputTokens:44893,outputTokens:815,cachedInputTokens:36149,totalTokens:45708}};
  try{
    await page.setViewportSize({width:1280,height:800});
    await routeApp(page,{harness,cwd:process.cwd()});
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>json(route,{records:[record],total:{inputTokens:44893,outputTokens:815,totalTokens:45708},models:{},runtimes:{},daily:{}}));
    await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();
    const rows=page.locator(".usage-recent .usage-table>div:not(.usage-table-head)");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator("span").nth(1)).toHaveText("Local machine");
    await expect(page.locator(".usage-page")).not.toContainText("legacy");
    await page.locator(".usage-recent").scrollIntoViewIfNeeded();
    await shoot(page,"l10-usage-local-1280");
  }finally{await harness.close()}
});
