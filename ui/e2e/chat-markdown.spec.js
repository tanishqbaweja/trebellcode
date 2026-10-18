import { test,expect } from "@playwright/test";
import { chmodSync, closeSync, constants, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The harness end of the agent socket, as in reasoning-text.spec.js: it answers what the window asks and pushes what the test
// sends, as the relay (or Codex) would while a turn runs.
async function startHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"markdown-fixture"};
    else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="turn/start")result={turn:{id:"turn-"+(thread.turns.length+1),status:"inProgress",items:[]}};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  })});
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",
    push(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params:{threadId:thread.id,...params}}))},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

async function openApp(page,{harness,thread}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const meta={[thread.id]:{projectless:true,environmentId:null}},runtime="cursor";
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:thread.cwd,platform:process.platform,version:"markdown-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:meta}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:[thread.model],metadata:{provider:runtime,models:[{id:thread.model,name:"Fixture Model",provider:runtime,agent:"Cursor"}]}}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,route=>json(route,route.request().method()==="POST"?{...meta[thread.id],...(route.request().postDataJSON()?.patch||{})}:meta[thread.id]));
  await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,{checkpoints:[]}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.goto("/");
  await page.getByRole("button",{name:new RegExp(thread.name)}).first().click();
  await expect(page.locator(".user-bubble").first()).toContainText(thread.turns[0].items[0].content[0].text);
}

const CODE="export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n}";
const REPLY=[
  "Fixed `slugify` in `src/slug.js`: it now **trims** dashes at both ends.",
  "",
  "- `\"Hello, World!\"` gives `\"hello-world\"`",
  "- `\"  Trebell   Code  \"` gives `\"trebell-code\"`",
  "",
  "1. Read [the issue](https://github.com/tanishqbaweja/trebellcode/issues/1)",
  "2. Ran the tests in [slug.test.js](test/slug.test.js)",
  "",
  "| Input | Output |",
  "| --- | --- |",
  "| `a--b` | `a-b` |",
  "| `-x-` | `x` |",
  "",
  "```js",
  CODE,
  "```",
  "",
  "<img src=x onerror=\"window.__markdownXss=1\"> and [a script link](javascript:window.__markdownXss=2) stay inert.",
].join("\n");

function fixtureThread(id,name){
  return {id,name,preview:"Slug fix",cwd:process.cwd(),model:"fixture-model",runtime:"cursor",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"slugify leaves dashes at the ends. Fix it and run the tests."}]},
    {type:"agentMessage",id:"assistant-1",text:REPLY},
  ]}]};
}

test("an assistant reply renders its Markdown: code, emphasis, lists, links, a table and a copyable code block",async({page})=>{
  test.setTimeout(45_000);
  // The copy goes to the page's own clipboard, which allows it here; the machine's clipboard is never written or read.
  await pageClipboard(page);await page.addInitScript(()=>{window.__clipboard.allowed=true});
  const thread=fixtureThread("markdown-reply","Markdown reply fixture"),harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    const reply=page.locator(".assistant-message-text").last();
    await expect(reply.locator("p code").first()).toHaveText("slugify");
    // No Markdown syntax is left on screen.
    expect(await reply.innerText()).not.toMatch(/`|\*\*|\| ---/);
    await expect(reply.locator("strong")).toHaveText("trims");
    await expect(reply.locator("ul > li")).toHaveCount(2);
    await expect(reply.locator("ol > li")).toHaveCount(2);
    const issue=reply.getByRole("link",{name:"the issue"});
    await expect(issue).toHaveAttribute("href","https://github.com/tanishqbaweja/trebellcode/issues/1");
    await expect(issue).toHaveAttribute("target","_blank");
    await expect(issue).toHaveAttribute("rel",/noopener/);
    // A file-path link would load inside the app: it stays text, with the path in its tooltip.
    await expect(reply.getByRole("link",{name:"slug.test.js"})).toHaveCount(0);
    await expect(reply.locator(".chat-markdown-link-text",{hasText:"slug.test.js"})).toHaveAttribute("title","test/slug.test.js");
    await expect(reply.locator("table th")).toHaveText(["Input","Output"]);
    await expect(reply.locator("table td code")).toHaveText(["a--b","a-b","-x-","x"]);
    await expect(reply.locator(".chat-markdown-code-head span")).toHaveText("js");
    await expect(reply.locator(".chat-markdown-code pre")).toHaveText(CODE);
    // Code keeps its characters: no font ligatures (|- would draw as one glyph), and runs of spaces stay.
    expect(await reply.locator(".chat-markdown-code pre").evaluate(node=>getComputedStyle(node).fontVariantLigatures)).toBe("none");
    expect(await reply.locator("p code").first().evaluate(node=>getComputedStyle(node).fontVariantLigatures)).toBe("none");
    expect(await reply.locator("ul > li").nth(1).locator("code").first().evaluate(node=>node.innerText)).toBe("\"  Trebell   Code  \"");
    // Raw HTML and script links are shown as text and never run.
    await expect(reply.locator("img")).toHaveCount(0);
    await expect(reply).toContainText("<img src=x onerror=\"window.__markdownXss=1\">");
    await expect(reply.getByRole("link",{name:"a script link"})).toHaveCount(0);
    expect(await page.evaluate(()=>window.__markdownXss)).toBeUndefined();
    // The code block and table scroll inside the reply; the conversation does not scroll sideways.
    const scroll=await page.locator(".conversation-scroll").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(scroll.scroll).toBeLessThanOrEqual(scroll.client+1);
    await reply.locator(".chat-markdown-code").scrollIntoViewIfNeeded();
    await page.screenshot({path:join(shotsDir,"chat-markdown-reply-dark-1280x800.png"),fullPage:true,animations:"disabled"});

    await reply.getByRole("button",{name:"Copy code"}).click();
    await expect(reply.getByRole("button",{name:"Copied"})).toBeVisible();
    // The copied text is the code exactly, written once.
    expect(await page.evaluate(()=>window.__clipboard.writes)).toEqual([CODE]);
    await expect(reply.getByRole("button",{name:"Copy code"})).toBeVisible({timeout:4000});

    // Selecting rendered text still offers the citation button.
    await reply.locator("strong").evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)});
    await expect(page.getByTestId("assistant-selection-cite")).toBeVisible();
    await page.evaluate(()=>window.getSelection().removeAllRanges());

    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    const inline=reply.locator("p code").first();
    const colors=await inline.evaluate(node=>{const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor}});
    expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");expect(colors.color).not.toBe(colors.background);
    await page.screenshot({path:join(shotsDir,"chat-markdown-reply-light-1280x800.png"),fullPage:true,animations:"disabled"});
  }finally{await harness.close()}
});

// A triple-click selects a paragraph; on a reply's last one the selection ends at the start of the reply's done pill, past the reply.
test("a triple-click on any paragraph of a reply, the last one too, offers Cite, and Cite takes that paragraph",async({page})=>{
  test.setTimeout(60_000);
  const PARAGRAPHS=["First paragraph about the session token.","Second paragraph about the refresh timer.","Third and last paragraph about signing out on a 401."];
  const thread=fixtureThread("cite-paragraphs","Cite paragraphs fixture");thread.turns[0].items[1].text=PARAGRAPHS.join("\n\n");
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    const reply=page.locator(".assistant-message-text").last(),paragraphs=reply.locator("p"),cite=page.getByTestId("assistant-selection-cite"),question=page.locator(".user-bubble p").first();
    await expect(paragraphs).toHaveText(PARAGRAPHS);await expect(page.locator(".history-assistant .turn-outcome")).toBeVisible();
    const tripleClick=async index=>{
      // A click on the question first leaves nothing selected, and no Cite.
      await question.click();await expect(cite).toHaveCount(0);
      await paragraphs.nth(index).click({clickCount:3});
      await expect.poll(()=>page.evaluate(()=>window.getSelection().toString().trim())).toBe(PARAGRAPHS[index]);
      await expect(cite,"Cite after a triple-click on paragraph "+(index+1)).toBeVisible();
    };
    for(const index of [0,1,2])await tripleClick(index);
    // At both widths and in both modes, over the last paragraph.
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await tripleClick(2);await page.screenshot({animations:"disabled",path:join(shotsDir,"chat-cite-triple-click-last-"+mode+"-"+width+"x800.png")})}
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1280,height:800});
    // Cite takes the last paragraph, as a drag over its words does.
    await tripleClick(2);await cite.click();
    const chip=page.getByTestId("context-chip");
    await expect(chip).toHaveCount(1);await expect(chip).toContainText("Assistant excerpt");await expect(chip).toContainText(PARAGRAPHS[2].length+" chars");
  }finally{await harness.close()}
});

// A clipboard of the page's own: a write is refused, as a browser that blocks copying refuses it, until the test allows writes, which
// it then records. Nothing reaches the machine's clipboard.
async function pageClipboard(page){
  await page.addInitScript(()=>{
    window.__clipboard={allowed:false,writes:[]};
    Object.defineProperty(navigator.clipboard,"writeText",{configurable:true,value:async text=>{if(!window.__clipboard.allowed)throw new DOMException("Write permission denied.","NotAllowedError");window.__clipboard.writes.push(String(text))}});
    const execCommand=Document.prototype.execCommand;
    Document.prototype.execCommand=function(command,...rest){return String(command).toLowerCase()==="copy"?false:execCommand.call(this,command,...rest)};
  });
}
// The header's theme button, as a person switches between dark and light; the setting stays in the page.
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}

test("Copy code says so when the clipboard refuses the copy, and copies once it is allowed",async({page})=>{
  test.setTimeout(60_000);
  await pageClipboard(page);
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().postDataJSON()||{})}):route.fallback());
  const thread=fixtureThread("markdown-copy-refused","Markdown copy fixture"),harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    const block=page.locator(".assistant-message-text").last().locator(".chat-markdown-code");
    await block.scrollIntoViewIfNeeded();
    await block.getByRole("button",{name:"Copy code"}).click();
    await expect(block.getByRole("alert")).toHaveText("Could not copy to clipboard.");
    await expect(block.getByRole("button",{name:"Copy code"})).toBeVisible();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});await block.scrollIntoViewIfNeeded();
        await expect(block.getByRole("alert")).toBeInViewport();
        await page.screenshot({path:join(shotsDir,`chat-markdown-copy-refused-${mode}-${width}x800.png`),animations:"disabled"});
      }
      await page.setViewportSize({width:1280,height:800});
    }
    // Once writes are allowed the same button copies the code, and the message goes.
    await page.evaluate(()=>{window.__clipboard.allowed=true});
    await block.getByRole("button",{name:"Copy code"}).click();
    await expect(block.getByRole("button",{name:"Copied"})).toBeVisible();
    await expect(block.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(()=>window.__clipboard.writes)).toEqual([CODE]);
  }finally{await harness.close()}
});

test("a streaming reply renders Markdown as it arrives and keeps it once the turn ends",async({page})=>{
  test.setTimeout(45_000);
  const thread=fixtureThread("markdown-stream","Markdown stream fixture"),harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    await page.getByTestId("composer").fill("Run the tests again.");await page.getByTestId("send").click();
    await expect(page.locator(".user-bubble").last()).toContainText("Run the tests again.");
    harness.push("turn/started",{turn:{id:"turn-2",status:"inProgress",startedAt:Date.now()/1000}});
    const item={type:"agentMessage",id:"assistant-live",text:""};
    harness.push("item/started",{turnId:"turn-2",item,startedAtMs:Date.now()});
    const live=page.locator(".agent-block .assistant-answer");
    // Half a code span is still plain text; it becomes code once its closing backtick arrives.
    harness.push("item/agentMessage/delta",{turnId:"turn-2",itemId:item.id,delta:"Running `npm"});
    await expect(live).toContainText("Running `npm");
    harness.push("item/agentMessage/delta",{turnId:"turn-2",itemId:item.id,delta:" test` now:\n\n- **3** tests"});
    await expect(live.locator("code")).toHaveText("npm test");
    await expect(live.locator("li strong")).toHaveText("3");
    await page.screenshot({path:join(shotsDir,"chat-markdown-streaming-dark-1280x800.png"),fullPage:true,animations:"disabled"});
    const text="Running `npm test` now:\n\n- **3** tests passed";
    harness.push("item/completed",{turnId:"turn-2",item:{...item,text},completedAtMs:Date.now()});
    harness.push("turn/completed",{turn:{id:"turn-2",status:"completed",completedAt:Date.now()/1000}});
    const final=page.locator(".assistant-message-text").last();
    await expect(final.locator("code")).toHaveText("npm test");
    await expect(final.locator("li")).toHaveText("3 tests passed");
  }finally{await harness.close()}
});

// While a reply streams, the text before a code block is finished as more arrives, and the code block is drawn again after it
// (StreamingMarkdown). The refusal said beside its Copy code stays until the next copy, and the keyboard stays on the button. The
// copies go to the page's own clipboard, never the machine's.
test("Copy code on a reply still streaming keeps its refusal and the keyboard as more of the reply streams in",async({page})=>{
  test.setTimeout(60_000);
  await pageClipboard(page);
  const thread=fixtureThread("markdown-stream-copy","Markdown stream copy fixture"),harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    await page.getByTestId("composer").fill("Show the change.");await page.getByTestId("send").click();
    await expect(page.locator(".user-bubble").last()).toContainText("Show the change.");
    harness.push("turn/started",{turn:{id:"turn-2",status:"inProgress",startedAt:Date.now()/1000}});
    const item={type:"agentMessage",id:"assistant-live",text:""};
    harness.push("item/started",{turnId:"turn-2",item,startedAtMs:Date.now()});
    const live=page.locator(".agent-block .assistant-answer"),block=live.locator(".chat-markdown-code");
    const head="Here is the change the relay needs, so that each turn is written once, after the call returns, and a reader sees the same history after a reload:\n\n```js\nconst value = 1;\n```\n\n";
    const more="Then a second paragraph about it, long enough to be a block of its own.\n\n- one\n- two\n\n";
    harness.push("item/agentMessage/delta",{turnId:"turn-2",itemId:item.id,delta:head});
    await expect(block).toContainText("const value = 1;");
    await block.getByRole("button",{name:"Copy code"}).focus();
    await page.keyboard.press("Enter");
    await expect(block.getByRole("alert")).toHaveText("Could not copy to clipboard.");
    await block.evaluate(node=>{node.dataset.drawnBefore="yes"});
    harness.push("item/agentMessage/delta",{turnId:"turn-2",itemId:item.id,delta:more});
    await expect(live.locator("li")).toHaveText(["one","two"]);
    console.log("the code block after more streamed in:",await block.evaluate(node=>node.dataset.drawnBefore?"the same element":"drawn again"));
    await expect(block.getByRole("alert"),"the refusal as more streams in").toHaveText("Could not copy to clipboard.");
    await expect(block.getByRole("button",{name:"Copy code"}),"the keyboard on Copy code").toBeFocused();
    // Allowed now, Enter on the same button copies, and the message goes.
    await page.evaluate(()=>{window.__clipboard.allowed=true});
    await page.keyboard.press("Enter");
    await expect(block.getByRole("button",{name:"Copied"})).toBeVisible();
    await expect(block.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(()=>window.__clipboard.writes)).toEqual(["const value = 1;"]);
    const text=head+more+"Done.";
    harness.push("item/completed",{turnId:"turn-2",item:{...item,text},completedAtMs:Date.now()});
    harness.push("turn/completed",{turn:{id:"turn-2",status:"completed",completedAt:Date.now()/1000}});
    await expect(page.locator(".assistant-message-text").last().locator(".chat-markdown-code pre")).toHaveText("const value = 1;");
  }finally{await harness.close()}
});

// When the reply finishes streaming it is drawn again as the finished reply, and each code block's copy outcome goes with it: Copied
// keeps its own 1.5 s from the copy, a refusal stays until the next copy, and the keyboard stays on Copy code. The copies go to the
// page's own clipboard, never the machine's.
test("Copy code's Copied and its refusal last through the end of the stream, with the keyboard on the button",async({page})=>{
  test.setTimeout(60_000);
  await pageClipboard(page);
  const thread=fixtureThread("markdown-stream-end-copy","Markdown stream end copy fixture"),harness=await startHarness(thread);
  // One streamed reply with a code block, its copy pressed from the keyboard while it streams, then the reply finished.
  async function streamAndCopy(turnId,code,allowed){
    await page.getByTestId("composer").fill("Show the change "+turnId+".");await page.getByTestId("send").click();
    await expect(page.locator(".user-bubble").last()).toContainText("Show the change "+turnId+".");
    harness.push("turn/started",{turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}});
    const item={type:"agentMessage",id:"assistant-"+turnId,text:""},head="Here is the change:\n\n```js\n"+code+"\n```\n\n";
    harness.push("item/started",{turnId,item,startedAtMs:Date.now()});
    harness.push("item/agentMessage/delta",{turnId,itemId:item.id,delta:head});
    const live=page.locator(".agent-block .assistant-answer .chat-markdown-code");
    await expect(live).toContainText(code);
    await page.evaluate(value=>{window.__clipboard.allowed=value},allowed);
    await live.getByRole("button",{name:"Copy code"}).focus();await page.keyboard.press("Enter");
    await expect(allowed?live.getByRole("button",{name:"Copied"}):live.getByRole("alert")).toBeVisible();
    harness.push("item/completed",{turnId,item:{...item,text:head+"Done."},completedAtMs:Date.now()});
    harness.push("turn/completed",{turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}});
    const finished=page.locator(".assistant-message-text").last().locator(".chat-markdown-code");
    await expect(finished.locator("pre")).toHaveText(code);await expect(page.locator(".agent-block .assistant-answer")).toHaveCount(0);
    thread.turns.push({id:turnId,status:"completed",items:[]});
    return finished;
  }
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    const copied=await streamAndCopy("turn-2","const copied = 1;",true);
    await expect(copied.getByRole("button",{name:"Copied"}),"Copied as the finished reply shows").toBeVisible({timeout:1000});
    await expect(copied.getByRole("button",{name:"Copied"}),"the keyboard on the button").toBeFocused();
    await page.screenshot({path:join(shotsDir,"chat-markdown-copied-after-stream-dark-1280x800.png"),animations:"disabled"});
    await expect(copied.getByRole("button",{name:"Copy code"}),"Copied ends on its own timer").toBeVisible({timeout:4000});
    const refused=await streamAndCopy("turn-3","const refused = 2;",false);
    await expect(refused.getByRole("alert"),"the refusal as the finished reply shows").toHaveText("Could not copy to clipboard.");
    await expect(refused.getByRole("button",{name:"Copy code"}),"the keyboard on the button").toBeFocused();
    await page.screenshot({path:join(shotsDir,"chat-markdown-refused-after-stream-dark-1280x800.png"),animations:"disabled"});
    await page.evaluate(()=>{window.__clipboard.allowed=true});await page.keyboard.press("Enter");
    await expect(refused.getByRole("button",{name:"Copied"})).toBeVisible();await expect(refused.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(()=>window.__clipboard.writes)).toEqual(["const copied = 1;","const refused = 2;"]);
  }finally{await harness.close()}
});

test("a reply's visualization whose file is missing says so by its file name in the card, without a local path",async({page})=>{
  test.setTimeout(45_000);
  const fixtureFile=fileURLToPath(new URL("../../visual-audit/chat-visualization-fixture.html",import.meta.url));
  writeFileSync(fixtureFile,"<!doctype html><meta charset=utf-8><body style=\"font:14px sans-serif\"><h1>Chart fixture</h1></body>");
  const text="Here are both charts.\n\n::codex-inline-vis{path=\"visual-audit/chat-visualization-fixture.html\"}\n\n::codex-inline-vis{path=\"missing-chart.html\"}";
  const thread={...fixtureThread("visualization-reply","Visualization reply fixture"),turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"Draw the two charts."}]},{type:"agentMessage",id:"assistant-1",text}]}]};
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    // The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
    const saved={};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
    await openApp(page,{harness,thread});
    const cards=page.locator(".inline-visualization-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).locator("iframe")).toBeVisible();
    await expect(cards.nth(0).frameLocator("iframe").getByRole("heading",{name:"Chart fixture"})).toBeVisible();
    await expect(cards.nth(1).getByTestId("visualization-missing")).toHaveText("Visualization not found: missing-chart.html");
    await expect(cards.nth(1).locator("iframe")).toHaveCount(0);
    expect(await page.locator(".conversation-column").innerText()).not.toMatch(/ENOENT|no such file|TrebellFix|visual-audit/i);
    for(const pass of [0,1]){
      await cards.nth(1).scrollIntoViewIfNeeded();
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        const mode=await page.locator("html").getAttribute("data-mode");
        await page.screenshot({path:join(shotsDir,`chat-visualization-missing-${mode}-${width}x800.png`),animations:"disabled"});
      }
      await page.setViewportSize({width:1280,height:800});
      if(!pass){const before=await page.locator("html").getAttribute("data-mode");await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"")}
    }
  }finally{await harness.close();rmSync(fixtureFile,{force:true})}
});

// A chart the card found (its HEAD) whose content then cannot be read as its frame asks for it (its GET): one the agent still holds
// open, which a read refuses on Windows (EBUSY) while a look at the file still finds it, and one removed in between. The server's
// answer opened in the frame, raw JSON with Node's error and the file's full local path, on a white panel in dark mode too. The card
// says each by its file name, as it says a file missing when it asked, with no frame and no local path.
test("a reply's chart whose content cannot be read once its file was found says so by its file name in the card, without a local path",async({page})=>{
  test.skip(process.platform!=="win32"&&process.getuid?.()===0,"a file of no permissions is still read by root");
  test.setTimeout(45_000);
  const busyFile=fileURLToPath(new URL("../../visual-audit/chart-busy.html",import.meta.url)),goneFile=fileURLToPath(new URL("../../visual-audit/chart-gone.html",import.meta.url));
  const text="Here are both charts.\n\n::codex-inline-vis{path=\"visual-audit/chart-busy.html\"}\n\n::codex-inline-vis{path=\"visual-audit/chart-gone.html\"}";
  const thread={...fixtureThread("visualization-unread","Unread visualization fixture"),turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"Draw the two charts."}]},{type:"agentMessage",id:"assistant-1",text}]}]};
  const harness=await startHarness(thread);let held=null;
  try{
    for(const file of [busyFile,goneFile])writeFileSync(file,"<!doctype html><meta charset=utf-8><body style=\"font:14px sans-serif\"><h1>Chart fixture</h1></body>");
    // The busy chart is held open with no sharing (libuv's UV_FS_O_EXLOCK), as the agent holds a file it still writes on Windows;
    // elsewhere it is made unreadable. A stat finds it either way, and a read fails.
    if(process.platform==="win32")held=openSync(busyFile,constants.O_RDONLY|0x10000000);else chmodSync(busyFile,0);
    await page.setViewportSize({width:1280,height:800});
    const saved={};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
    // The gone chart is removed once the card has found it, as its frame asks for its content.
    await page.route(/\/api\/visualization\?.*chart-gone/,route=>{if(route.request().method()==="GET")rmSync(goneFile,{force:true});return route.continue()});
    await openApp(page,{harness,thread});
    const cards=page.locator(".inline-visualization-card");
    await expect(cards).toHaveCount(2);
    await expect.soft(cards.nth(0).getByTestId("visualization-missing"),"the chart held open").toHaveText("Could not show visualization chart-busy.html");
    await expect.soft(cards.nth(1).getByTestId("visualization-missing"),"the chart removed in between").toHaveText("Visualization not found: chart-gone.html");
    await expect.soft(cards.locator("iframe"),"no frame shows the server's answer").toHaveCount(0);
    expect.soft(await page.locator(".conversation-column").innerText()).not.toMatch(/EBUSY|EACCES|ENOENT|TrebellFix|visual-audit/i);
    for(const pass of [0,1]){
      await cards.nth(0).scrollIntoViewIfNeeded();
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        const mode=await page.locator("html").getAttribute("data-mode");
        await page.screenshot({path:join(shotsDir,`chat-visualization-unread-${mode}-${width}x800.png`),animations:"disabled"});
      }
      await page.setViewportSize({width:1280,height:800});
      if(!pass){const before=await page.locator("html").getAttribute("data-mode");await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"")}
    }
  }finally{if(held!==null)closeSync(held);await harness.close();rmSync(busyFile,{force:true});rmSync(goneFile,{force:true})}
});

// A chart card's head as a person sees it once a mode switch has finished fading the colours: whether its band is light or dark,
// and each of its texts with its size and its contrast against the band.
const readCardHead=head=>head.evaluate(async node=>{
  await Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>null)));
  const rgb=value=>value.match(/[\d.]+/g).map(Number);
  const luminance=channels=>channels.slice(0,3).reduce((sum,value,index)=>{value/=255;return sum+[0.2126,0.7152,0.0722][index]*(value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4)},0);
  let back=node;while(back.parentElement&&rgb(getComputedStyle(back).backgroundColor)[3]===0)back=back.parentElement;
  const band=luminance(rgb(getComputedStyle(back).backgroundColor));
  return {band:band>0.5?"light":band<0.2?"dark":"between",texts:[...node.querySelectorAll("strong,span")].map(item=>{
    const style=getComputedStyle(item),[lighter,darker]=[luminance(rgb(style.color)),band].sort((a,b)=>b-a);
    return {text:item.textContent,size:parseFloat(style.fontSize),contrast:Math.round((lighter+0.05)/(darker+0.05)*10)/10};
  })};
});

// The chart card's head follows the mode the header switches to, as a code block's head does: a light band in light mode (it stayed
// the one black band on a light page), its file name and label at the chat's small text size (11.5px and up) and readable against
// it (4.5:1) in both modes.
test("a reply's chart card head follows light and dark mode, its file name and label at the chat's small text size",async({page})=>{
  test.setTimeout(45_000);
  const text="Here is the chart.\n\n::codex-inline-vis{path=\"charts/latency.html\"}";
  const thread={...fixtureThread("visualization-head","Visualization head fixture"),turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"Draw the latency chart."}]},{type:"agentMessage",id:"assistant-1",text}]}]};
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    const saved={};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
    await page.route(/\/api\/visualization\?/,route=>route.fulfill({status:200,contentType:"text/html",body:"<!doctype html><meta charset=utf-8><body style=\"font:14px sans-serif\"><h1>Latency chart</h1></body>"}));
    await openApp(page,{harness,thread});
    const card=page.locator(".inline-visualization-card"),head=card.locator(".inline-visualization-head");
    await expect(card.frameLocator("iframe").getByRole("heading",{name:"Latency chart"})).toBeVisible();
    for(const mode of ["light","dark"]){
      await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      const look=await readCardHead(head);
      expect(look.band,`the head's band in ${mode} mode`).toBe(mode);
      expect(look.texts.map(item=>item.text)).toEqual(["latency.html","Interactive visualization"]);
      for(const item of look.texts){
        expect(item.size,`the size of "${item.text}" in ${mode} mode`).toBeGreaterThanOrEqual(11.5);
        expect(item.contrast,`the contrast of "${item.text}" against the head in ${mode} mode`).toBeGreaterThanOrEqual(4.5);
      }
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({path:join(shotsDir,`chat-visualization-head-${mode}-1280x800.png`),animations:"disabled"});
    }
  }finally{await harness.close()}
});

// A chart whose content the server is slow to send: until the content arrives the card says it is loading, in the card's own colours,
// both before the server has said the file is there and while the frame's content is on its way, instead of an empty box and then a
// blank white one (a bright panel in dark mode). The content then shows in the card, laid out at the width it shows at.
test("a reply's chart whose content is slow says it is loading until the content shows",async({page})=>{
  test.setTimeout(45_000);
  const text="Here is the chart.\n\n::codex-inline-vis{path=\"charts/slow.html\"}";
  const thread={...fixtureThread("visualization-slow","Slow visualization fixture"),turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"Draw the slow chart."}]},{type:"agentMessage",id:"assistant-1",text}]}]};
  const harness=await startHarness(thread);
  // The server says the file is there (its HEAD) when the test lets it, and sends the content (its GET) when the test releases it.
  let answerHead,sendContent;const headHeld=new Promise(resolve=>{answerHead=resolve}),contentHeld=new Promise(resolve=>{sendContent=resolve});
  try{
    await page.setViewportSize({width:1280,height:800});
    const saved={};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
    await page.route(/\/api\/visualization\?/,async route=>{
      if(route.request().method()==="HEAD"){await headHeld;return route.fulfill({status:200,contentType:"text/html",body:""})}
      await contentHeld;return route.fulfill({status:200,contentType:"text/html",body:"<!doctype html><meta charset=utf-8><body style=\"font:14px sans-serif\"><h1>Slow chart</h1><p id=width></p><script>document.getElementById(\"width\").textContent=\"Laid out at \"+innerWidth+\"px\"</script></body>"});
    });
    await openApp(page,{harness,thread});
    const card=page.locator(".inline-visualization-card"),loading=card.getByRole("status"),frame=card.locator("iframe");
    // What a person sees in the middle of the card's body, where the chart goes: a light or a dark surface.
    const surface=()=>card.evaluate(node=>{
      const head=node.querySelector(".inline-visualization-head").getBoundingClientRect(),box=node.getBoundingClientRect(),rgb=value=>value.match(/[\d.]+/g).map(Number);
      let item=document.elementFromPoint(box.left+box.width/2,(head.bottom+box.bottom)/2);
      while(item.parentElement&&rgb(getComputedStyle(item).backgroundColor)[3]===0)item=item.parentElement;
      const [r,g,b]=rgb(getComputedStyle(item).backgroundColor);return (0.2126*r+0.7152*g+0.0722*b)/255>0.5?"light":"dark";
    });
    await card.scrollIntoViewIfNeeded();
    await expect(loading,"before the server has said the file is there").toHaveText("Loading visualization slow.html…");
    expect(await surface(),"the card's body in dark mode before the server has said the file is there").toBe("dark");
    const contentAsked=page.waitForRequest(request=>/\/api\/visualization\?/.test(request.url())&&request.method()==="GET");
    answerHead();await contentAsked;
    await expect(loading,"while the frame's content is on its way").toHaveText("Loading visualization slow.html…");
    await expect(frame).toBeHidden();
    expect(await surface(),"the card's body in dark mode while the content is on its way").toBe("dark");
    await page.screenshot({path:join(shotsDir,"chat-visualization-loading-dark-1280x800.png"),animations:"disabled"});
    await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    await expect(loading).toBeVisible();
    await page.screenshot({path:join(shotsDir,"chat-visualization-loading-light-1280x800.png"),animations:"disabled"});
    sendContent();
    await expect(card.frameLocator("iframe").getByRole("heading",{name:"Slow chart"})).toBeVisible();
    await expect(frame).toBeVisible();
    await expect(loading).toHaveCount(0);
    // The chart read its width as it loaded unseen: the width it shows at.
    await expect(card.frameLocator("iframe").locator("#width")).toHaveText("Laid out at "+await frame.evaluate(node=>node.clientWidth)+"px");
    await page.screenshot({path:join(shotsDir,"chat-visualization-arrived-light-1280x800.png"),animations:"disabled"});
  }finally{answerHead?.();sendContent?.();await harness.close()}
});
