import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,utimes,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { publicHistoryCandidate,scanLocalAgentHistory } from "../../src/agent-history-import.mjs";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

// Tools > Conversation history on a Codex window, as a person scans it. The scan is the server's own (scanLocalAgentHistory, as
// /api/history-import runs it) over a Codex home of fixture sessions: three of the person's own, each opening with the setup text
// Codex records ahead of a request, their fork of a review's thread (which carries the review's session_meta after its own), and four
// newer ones Codex ran for itself (a child agent, a review, a guardian check and a compaction). The list shows the person's four,
// each named after what was asked.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// A Codex app-server behind the real relay that answers the Tools page's reads with empty lists.
async function startToolsFixture(){
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  const empty=["thread/list","threadSection/list","permissionProfile/list","mcpServerStatus/list","hooks/list","experimentalFeature/list","plugin/share/list","app/list","thread/loaded/list"];
  const answers={"initialize":{userAgent:"codex-history-fixture"},"skills/list":{data:[]},"externalAgentConfig/detect":{items:[],connectors:[]},"externalAgentConfig/import/readHistories":{data:[],connectors:[]},"plugin/list":{marketplaces:[],marketplaceLoadErrors:[],featuredPluginIds:[]},"app/installed":{apps:[]},"modelProvider/capabilities/read":{namespaceTools:true,webSearch:true,imageGeneration:false},"account/read":{account:null,requiresOpenaiAuth:false},"account/rateLimits/read":{rateLimits:{}},"account/usage/read":{},"config/read":{config:{},layers:[]},"configRequirements/read":{requirements:{}},"memory/status":{v2ConsolidatedThreads:0,v2Ready:false},"server/diagnostics":{process:{id:4242,residentMemoryBytes:67108864,physicalFootprintBytes:null},gauges:[]}};
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{const message=JSON.parse(String(data));if(message.id==null||!message.method)return;ws.send(JSON.stringify({id:message.id,result:empty.includes(message.method)?{data:[],nextCursor:null}:answers[message.method]||{}}))});
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",async close(){relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}};
}

// A Codex home with the person's sessions and Codex's own, each a rollout as Codex writes it, last written minutesAgo.
async function writeCodexHome(root,workspace){
  const home=join(root,"codex-home"),now=Date.now();
  const sessions=[
    {id:"own-vscode",source:"vscode",minutesAgo:10,messages:[`# AGENTS.md instructions for ${workspace}\n\n<INSTRUCTIONS>\nUse tabs.\n</INSTRUCTIONS>\n## My request for Codex:\nFix the flaky checkout test`]},
    {id:"own-cli",source:"cli",minutesAgo:20,messages:[`<environment_context>\n<cwd>${workspace}</cwd>\n<shell>bash</shell>\n</environment_context>\n\nAdd a dark mode toggle to the settings page`]},
    {id:"own-app",minutesAgo:30,messages:["<recommended_plugins>\nGitHub\n</recommended_plugins>\n<in-app-browser-context source=\"ambient-ui-state\">\nTab\n</in-app-browser-context>","Write the release notes for 2.4"]},
    // The person's fork of the review's thread: its own session_meta, then the review's, which a fork copies in after it.
    {id:"own-fork",source:"vscode",forkOf:{id:"review",source:{subagent:"review"}},minutesAgo:5,messages:["Apply the review's fixes in my fork"]},
    {id:"child-agent",source:{subagent:{thread_spawn:{parent_thread_id:"own-vscode",depth:1}}},minutesAgo:1,messages:["Investigate the failing checkout test"]},
    {id:"review",source:{subagent:"review"},minutesAgo:2,messages:["Review the current changes"]},
    {id:"guardian",source:{subagent:{other:"guardian"}},minutesAgo:3,messages:["Check whether this command is safe to run"]},
    {id:"compaction",source:{subAgent:"compact"},minutesAgo:4,messages:["Summarize the conversation so far"]},
  ];
  const day=join(home,"sessions","2026","10","26");await mkdir(day,{recursive:true});
  for(const session of sessions){
    const path=join(day,`rollout-2026-10-26T12-00-00-${session.id}.jsonl`);
    await writeFile(path,[
      {timestamp:"2026-10-26T12:00:00Z",type:"session_meta",payload:{id:session.id,cwd:workspace,...(session.source?{source:session.source}:{}),...(session.forkOf?{forked_from_id:session.forkOf.id}:{})}},
      ...(session.forkOf?[{timestamp:"2026-10-26T11:00:00Z",type:"session_meta",payload:{id:session.forkOf.id,cwd:workspace,source:session.forkOf.source}}]:[]),
      {type:"turn_context",payload:{cwd:workspace,model:"gpt-test"}},
      ...session.messages.map(message=>({type:"event_msg",payload:{type:"user_message",message}})),
    ].map(record=>JSON.stringify(record)).join("\n"));
    const at=new Date(now-session.minutesAgo*60_000);await utimes(path,at,at);
  }
  return home;
}

// A Codex window on the fixture's relay, its app API answered here, and /api/history-import answered as src/gui-server.mjs answers the
// scan, over codexHome and without Claude Code's sessions. scans counts the scans answered.
async function routeCodexWindow(page,{fixture,root,workspace,codexHome}){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const counts={scans:0};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:fixture.wsUrl,cwd:workspace,platform:process.platform,version:"codex-history-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  // A setting the page saves (the light and dark toggle) holds for its later reads.
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/history-import$/,async route=>{
    if(route.request().method()!=="GET")return json(route,{ok:false,results:[]});
    counts.scans++;const candidates=await scanLocalAgentHistory({env:{...process.env,TREBELL_HOME:join(root,"trebell-home")},sourceHome:codexHome,includeClaude:false});
    return json(route,{sessions:candidates.map(candidate=>publicHistoryCandidate(candidate)),codexImportAvailable:true,codexImportUnavailable:null});
  });
  return counts;
}
// Opens Tools and presses Scan history, as a person does; the Conversation history card.
async function scanHistory(page){
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");await page.getByRole("button",{name:"Tools",exact:true}).click();
  const history=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Conversation history",{exact:true})}).first();
  await history.getByRole("button",{name:"Scan history",exact:true}).click();
  return history;
}

test("Conversation history lists a person's own Codex sessions, named after what was asked, and not the sessions Codex ran for itself",async({page})=>{
  test.setTimeout(45_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-history-")),workspace=join(root,"workspace");await mkdir(workspace,{recursive:true});
  const codexHome=await writeCodexHome(root,workspace),fixture=await startToolsFixture();
  try{
    const counts=await routeCodexWindow(page,{fixture,root,workspace,codexHome});
    const history=await scanHistory(page),scans=()=>counts.scans;
    const rows=history.locator(".history-import-list>div");
    await expect(rows.locator("strong")).toHaveText(["Apply the review's fixes in my fork","Fix the flaky checkout test","Add a dark mode toggle to the settings page","Write the release notes for 2.4"]);
    expect(scans()).toBe(1);
    await expect(history.locator(".capability-card-head em")).toHaveText("4");
    for(const text of ["Investigate the failing checkout test","Review the current changes","Check whether this command is safe to run","Summarize the conversation so far","AGENTS.md","environment_context"])await expect(history,text).not.toContainText(text);
    await expect(rows.first()).toContainText("Codex · "+workspace);
    await expect(rows.getByRole("button",{name:"Import",exact:true})).toHaveCount(4);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await history.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}codex-history-import-own-sessions-${mode}-1280x800.png`});
    }
  }finally{await fixture.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

// More sessions Codex ran for itself than the scan reads, all newer than the person's own: the scan reads each one's first
// session_meta before it counts, so they use none of it, and the person's sessions after them are still listed.
test("Conversation history still lists a person's Codex sessions behind more newer subagent sessions than the scan reads",async({page})=>{
  test.setTimeout(90_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-history-many-")),workspace=join(root,"workspace");await mkdir(workspace,{recursive:true});
  const home=join(root,"codex-home"),now=Date.now(),fixture=await startToolsFixture();
  const write=async(day,name,records,minutesAgo)=>{
    const folder=join(home,"sessions","2026","10",day);await mkdir(folder,{recursive:true});
    const path=join(folder,name);await writeFile(path,records.map(record=>JSON.stringify(record)).join("\n"));const at=new Date(now-minutesAgo*60_000);await utimes(path,at,at);
  };
  const SOURCES=[{subagent:{thread_spawn:{parent_thread_id:"own-1",depth:1}}},{subagent:"review"},{subagent:{other:"guardian"}},{subAgent:"compact"}];
  try{
    for(let index=0;index<300;index++)await write("26",`rollout-2026-10-26T12-00-00-sub-${String(index).padStart(3,"0")}.jsonl`,[
      {timestamp:"2026-10-26T12:00:00Z",type:"session_meta",payload:{id:"sub-"+index,cwd:workspace,source:SOURCES[index%4]}},
      {type:"event_msg",payload:{type:"user_message",message:"Codex's own work "+index}},
    ],index);
    const own=["Migrate the billing tables","Speed up the search index","Fix the login redirect"];
    for(const [index,request] of own.entries())await write("25",`rollout-2026-10-25T12-00-00-own-${index+1}.jsonl`,[
      {timestamp:"2026-10-25T12:00:00Z",type:"session_meta",payload:{id:"own-"+(index+1),cwd:workspace,source:"vscode"}},
      {type:"turn_context",payload:{cwd:workspace,model:"gpt-test"}},
      {type:"event_msg",payload:{type:"user_message",message:request}},
    ],400+index);
    await routeCodexWindow(page,{fixture,root,workspace,codexHome:home});
    const history=await scanHistory(page),rows=history.locator(".history-import-list>div");
    await expect(rows.locator("strong"),"the person's sessions behind Codex's 300").toHaveText(own,{timeout:30_000});
    await expect(history.locator(".capability-card-head em")).toHaveText("3");
    await expect(history).not.toContainText("Codex's own work");
    await expect(rows.getByRole("button",{name:"Import",exact:true})).toHaveCount(3);
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:`${auditDir}codex-history-import-behind-subagents-dark-1280x800.png`});
  }finally{await fixture.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
