import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
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

test("an assistant reply renders its Markdown: code, emphasis, lists, links, a table and a copyable code block",async({page,context})=>{
  test.setTimeout(45_000);
  await context.grantPermissions(["clipboard-read","clipboard-write"]);
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
    // The Windows clipboard stores text with CRLF line ends; the copied text is otherwise the code exactly.
    expect((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,"\n")).toBe(CODE);
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
