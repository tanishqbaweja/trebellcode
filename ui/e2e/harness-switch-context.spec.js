import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

// What a harness switch, and the turn that runs before it, may leave behind on screen: the previous harness's Git text error or
// in-flight Git text, a second sidebar row for a thread announced before its thread/start answer, and the previous socket's approval.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const HARNESSES=[["opencode","OpenCode","sdk","opencode/fixture-fast"],["grok","Grok Build","acp","grok-fixture"],["antigravity","Antigravity","acp","antigravity-fixture"],["cursor","Cursor","acp","cursor-fixture"]];
const NAMES=Object.fromEntries(HARNESSES.map(([id,name])=>[id,name]));
const CATALOGS=Object.fromEntries(HARNESSES.map(([id,name,,model])=>[id,{agentRuntime:id,ready:true,models:[model],defaultModel:model,metadata:{models:[{id:model,name:name+" Fixture",agent:id}]},error:null}]));
const PAYMENT_REQUIRED="OpenCode could not write the Git text: Payment Required: Insufficient balance. Add credits to continue.";
const GOAL_REJECTED="The fixture harness could not save this thread goal.";
const ACP_PERMISSION_OPTIONS=[{optionId:"allow_once",kind:"allow_once",name:"Allow once"},{optionId:"allow_always",kind:"allow_always",name:"Allow always"},{optionId:"reject_once",kind:"reject_once",name:"Reject"}];

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The GUI server's /api/agent/ws as the agent relay runs it: one socket URL for every non-Codex harness, each request served by the runtime
// active when it arrives. Like the relay it announces a new thread to every socket (thread/started) before it answers thread/start, numbers
// its server requests per socket (agent-1, agent-2, …, so a new socket's first approval reuses an id of the old one) and fails the requests
// of a socket that closes. approvalCommands[runtime] makes each of that runtime's turns wait on an ACP permission request for the command.
// thread/goal/set fails with GOAL_REJECTED, unless goalSet is a promise: then the goal is saved once it settles.
async function startAgentRelay(activeRuntime,{approvalCommands={},goalSet="reject"}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Map(),requests=[],threads=[],responses=[],failed=[],savedGoals=[];let connections=0;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const broadcast=value=>{for(const {ws} of sockets.values())if(ws.readyState===1)ws.send(JSON.stringify(value))};
  wss.on("connection",ws=>{
    const connection=++connections,pending=new Map();let nextServerId=1;
    sockets.set(connection,{ws,pending});
    ws.on("close",()=>{sockets.delete(connection);for(const [id,waiting] of pending){failed.push({connection,id});waiting.reject(new Error("Agent client disconnected"))}pending.clear()});
    const send=value=>{if(ws.readyState===1)ws.send(JSON.stringify(value))};
    const serverRequest=(method,params)=>{const id="agent-"+nextServerId++;send({id,method,params});return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))};
    ws.on("message",async raw=>{
      const message=JSON.parse(String(raw));
      if(message.id!=null&&!message.method){
        // An answer to a server request, recorded with the socket it arrived on; only that socket's request of this id is answered.
        responses.push({connection,id:message.id,result:message.result??null,error:message.error??null});
        const waiting=pending.get(message.id);pending.delete(message.id);
        if(waiting)message.error?waiting.reject(new Error(message.error.message||"Request declined")):waiting.resolve(message.result);
        return;
      }
      if(message.id==null||!message.method)return;
      const runtime=activeRuntime(),params=message.params||{};requests.push({connection,runtime,method:message.method,params});
      if(message.method==="turn/start"){
        const threadId=params.threadId,turnId=runtime+"-turn-"+requests.length,command=approvalCommands[runtime];
        send({id:message.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});
        send({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});
        let outcome="done";
        if(command){
          // An ACP permission request as the relay forwards it: item/tool/requestApproval with the tool call's title as the reason.
          try{outcome=(await serverRequest("item/tool/requestApproval",{threadId,reason:command,toolCall:{toolCallId:"call-"+turnId,title:command,kind:"execute"},options:ACP_PERMISSION_OPTIONS}))?.decision||"decline"}
          catch{return}
        }
        send({method:"item/completed",params:{threadId,turnId,item:{id:"reply-"+turnId,type:"agentMessage",text:`Fixture reply from ${runtime}: ${outcome}`}}});
        send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}}});
        return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"harness-switch-context-fixture"};
      else if(message.method==="thread/start"){
        const now=Date.now()/1000,thread={id:runtime+"-thread-"+(threads.length+1),name:"",preview:"",model:params.model||null,runtime,cwd:params.cwd||process.cwd(),createdAt:now,updatedAt:now,status:{type:"idle"},turns:[]};
        threads.push(thread);
        broadcast({method:"thread/started",params:{thread}});
        result={thread};
      }
      else if(message.method==="thread/list")result={data:threads,nextCursor:null};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread:threads.find(item=>item.id===params.threadId)||{id:params.threadId,turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(["thread/turns/list","thread/queue/list","thread/attachment/list","thread/timeline/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(["threadSection/list","skills/list","collaborationMode/list"].includes(message.method))result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/goal/set"){
        if(goalSet==="reject"){send({id:message.id,error:{code:-32000,message:GOAL_REJECTED}});return}
        await goalSet;
        result={goal:{threadId:params.threadId,objective:params.objective,status:params.status||"active",tokensUsed:0,timeUsedSeconds:0,turnsUsed:0}};
        savedGoals.push(result.goal);
      }
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      send({id:message.id,result});
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",requests,responses,threads,failed,savedGoals,broadcast,
    connections:()=>connections,openConnections:()=>[...sockets.keys()],
    calls:(...methods)=>requests.filter(item=>methods.includes(item.method)),
    async close(){for(const {ws} of sockets.values())try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

// The GUI server around the relay, as in runtime-switch.spec.js: POST /api/agent-runtimes {action:"select"} switches the active runtime and
// answers with its bootstrap and catalog. With projectPath the app starts in that project, and /api/git/commit-message answers as the
// active harness writes Git text: OpenCode's account is out of credits, the others write a message. holdGitText[runtime] delays the answer,
// and holdReviewText[runtime] delays the pull request text of /api/git/review-text; /api/source-control/pr records the created PR.
async function startHarness(page,{runtime,approvalCommands={},goalSet="reject",projectPath=null,holdGitText={},holdReviewText={}}={}){
  const server={runtime,counts:{select:0,direct:0},gitText:[],gitTextAnswered:0,reviewText:[],pullRequests:[]};
  const relay=await startAgentRelay(()=>server.runtime,{approvalCommands,goalSet});
  const project=projectPath?{id:"harness-switch-project",name:"Harness switch project",path:projectPath,environmentId:null,effectiveSettings:{}}:null;
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeProjectId:project?.id||null});
  const bootstrap=()=>({mock:false,provider:"openai",providerReady:true,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:relay.wsUrl,cwd:process.cwd(),platform:process.platform,version:"harness-switch-context-fixture",activeEnvironmentId:null,activeEnvironment:null});
  const snapshot=()=>{
    const statuses=HARNESSES.map(([kind,name])=>({id:kind+"-default",kind,name,available:true,installed:true,authenticated:true,version:"1.0.0-fixture"}));
    return {selectedRuntime:server.runtime,selectedInstanceId:server.runtime+"-default",definitions:HARNESSES.map(([id,name,protocol])=>({id,name,protocol,multipleInstances:false})),instances:statuses.map(({id,kind,name})=>({id,kind,displayName:name,enabled:true})),statuses};
  };
  await page.route(/\/api\/bootstrap$/,route=>json(route,bootstrap()));
  await page.route(/\/api\/state$/,route=>json(route,{settings:settings(),projects:project?[project]:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>json(route,settings()));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,CATALOGS[server.runtime]));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,route=>{
    if(route.request().method()==="GET")return json(route,snapshot());
    const body=route.request().postDataJSON()||{};
    if(body.action!=="select")return json(route,{error:"Unexpected agent runtime action in the harness switch fixture: "+body.action},400);
    server.counts.select++;server.runtime=body.runtime;
    const current=snapshot();
    return json(route,{...current,selected:{runtime:server.runtime,instance:current.instances.find(item=>item.kind===server.runtime),status:current.statuses.find(item=>item.kind===server.runtime)},bootstrap:bootstrap(),catalog:CATALOGS[server.runtime]});
  });
  await page.route(/\/api\/providers$/,route=>json(route,{selected:"openai",providers:[{id:"openai",name:"OpenAI API",official:true,hasKey:true}],status:{id:"openai",hasKey:true},ready:true}));
  await page.route(/\/api\/projects$/,route=>route.request().method()==="GET"?json(route,{projects:project?[project]:[]}):json(route,{project}));
  await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
  await page.route(/\/api\/stashes$/,route=>json(route,{stashes:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/chat\/direct$/,route=>{server.counts.direct++;return json(route,{error:"The direct route must not be used outside mock mode"},500)});
  if(project){
    const gitInfo={isGit:true,root:project.path,branch:"main",branches:["main"],upstream:"origin/main",status:[{code:" M",path:"notes.txt"}],worktrees:[{path:project.path,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git"}]};
    const capabilities={create:true,comment:true,review:true,merge:true};
    await page.route(/\/api\/git\/info\?/,route=>json(route,gitInfo));
    await page.route(/\/api\/source-control\/diagnostics\?/,route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:capabilities}}));
    await page.route(/\/api\/source-control\/prs\?/,route=>json(route,{provider:"github",capabilities,items:[]}));
    await page.route(/\/api\/git\/commit-message$/,async route=>{
      const writer=server.runtime,label=NAMES[writer];server.gitText.push({runtime:writer,body:route.request().postDataJSON()});
      try{
        await holdGitText[writer];
        if(writer==="opencode")return await json(route,{error:PAYMENT_REQUIRED},400);
        // Git text is written in a one-shot session outside the conversation. Were it ever announced, it must still not be listed.
        relay.broadcast({method:"thread/started",params:{thread:{id:"git-text-"+writer,name:"Write a commit message",preview:"",ephemeral:true,threadSource:"trebell-git-text",runtime:writer,cwd:project.path,createdAt:Date.now()/1000,updatedAt:Date.now()/1000,status:{type:"idle"},turns:[]}}});
        return await json(route,{message:label+" fixture commit message",runtime:writer,generatedWith:label});
      }finally{server.gitTextAnswered++}
    });
    await page.route(/\/api\/git\/review-text$/,async route=>{
      const writer=server.runtime,label=NAMES[writer];server.reviewText.push({runtime:writer,body:route.request().postDataJSON()});
      await holdReviewText[writer];
      if(writer==="opencode")return json(route,{error:PAYMENT_REQUIRED},400);
      return json(route,{title:label+" fixture PR title",body:"Written by "+label+".",runtime:writer,generatedWith:label});
    });
    await page.route(/\/api\/source-control\/pr$/,route=>{server.pullRequests.push(route.request().postDataJSON());return json(route,{number:7,provider:"github"})});
  }
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  return {server,relay,close:()=>relay.close()};
}

async function projectDirectory(){
  const path=await mkdtemp(join(tmpdir(),"trebell-harness-switch-"));
  return {path,close:()=>rm(path,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
}
async function openGeneralChat(page,relay){
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.locator(".general-chat-card").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect.poll(()=>relay.calls("thread/list").length,{timeout:15_000}).toBeGreaterThan(0);
  await expect(page.getByTestId("composer-transport")).toHaveCount(0);
}
async function openProjectGitPanel(page,relay){
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect.poll(()=>relay.calls("thread/list").length,{timeout:15_000}).toBeGreaterThan(0);
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  await right.getByRole("button",{name:"Git",exact:true}).click();
  await expect(right.getByPlaceholder("Commit message")).toBeVisible({timeout:10_000});
  return right;
}
async function selectHarness(page,name){
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
  const option=page.locator(".agent-runtime-option").filter({hasText:name}).locator("button").first();
  await expect(option).toBeEnabled({timeout:10_000});await option.click();
  await expect(page.locator(".agent-runtime-option").filter({hasText:name}).getByText("Active",{exact:true})).toBeVisible({timeout:15_000});
}
const backToThreads=page=>page.getByRole("button",{name:"Threads",exact:true}).click();

test("a Git text error from the previous harness clears on a harness switch, and the next harness writes the text without a thread",async({page})=>{
  test.setTimeout(60_000);
  const directory=await projectDirectory(),{server,relay,close}=await startHarness(page,{runtime:"opencode",projectPath:directory.path});
  try{
    const right=await openProjectGitPanel(page,relay),alert=right.locator(".source-control-error"),message=right.getByPlaceholder("Commit message");
    await right.getByRole("button",{name:"Generate with OpenCode",exact:true}).click();
    await expect(alert).toHaveText(PAYMENT_REQUIRED);

    await selectHarness(page,"Grok Build");
    expect(server.counts.select).toBe(1);
    // The panel stays open beside Settings: the OpenCode error leaves as soon as Grok Build writes the Git text.
    const generate=right.getByRole("button",{name:"Generate with Grok Build",exact:true});
    await expect(generate).toBeVisible({timeout:15_000});
    await expect(alert).toHaveCount(0);
    await backToThreads(page);
    await expect(alert).toHaveCount(0);
    await page.screenshot({path:auditDir+"harness-switch-git-text-error-cleared-1600x980.png",fullPage:true});

    await expect(generate).toBeEnabled();await generate.click();
    await expect(message).toHaveValue("Grok Build fixture commit message");
    await expect(alert).toHaveCount(0);
    expect(server.gitText.map(item=>item.runtime)).toEqual(["opencode","grok"]);
    expect(server.gitText.every(item=>item.body?.cwd===directory.path)).toBe(true);
    // The Git text never went through the conversation transport, and the one-shot thread announced for it is not in the sidebar.
    await page.waitForTimeout(500);
    expect(relay.calls("thread/start","turn/start")).toEqual([]);
    await expect(page.locator('.thread-row[data-thread-id="git-text-grok"]')).toHaveCount(0);
    await expect(page.locator(".thread-row")).toHaveCount(0);
    expect(server.counts.direct).toBe(0);
  }finally{await close();await directory.close()}
});

test("a harness switch cancels Git text the previous harness is still writing, so its late failure never shows",async({page})=>{
  test.setTimeout(60_000);
  let releaseOpenCode=()=>{};const openCodeAnswer=new Promise(resolve=>{releaseOpenCode=resolve});
  const directory=await projectDirectory(),{server,relay,close}=await startHarness(page,{runtime:"opencode",projectPath:directory.path,holdGitText:{opencode:openCodeAnswer}});
  const aborted=[];page.on("requestfailed",request=>{if(new URL(request.url()).pathname==="/api/git/commit-message")aborted.push(request.failure()?.errorText||"failed")});
  try{
    const right=await openProjectGitPanel(page,relay),alert=right.locator(".source-control-error"),message=right.getByPlaceholder("Commit message");
    const openCodeGenerate=right.getByRole("button",{name:"Generate with OpenCode",exact:true});
    await openCodeGenerate.click();
    await expect.poll(()=>server.gitText.length).toBe(1);
    await expect(openCodeGenerate).toBeDisabled();

    await selectHarness(page,"Grok Build");
    await backToThreads(page);
    // OpenCode's request is cancelled with the switch: Generate is free at once for Grok Build.
    const grokGenerate=right.getByRole("button",{name:"Generate with Grok Build",exact:true});
    await expect(grokGenerate).toBeEnabled({timeout:15_000});
    await expect.poll(()=>aborted.length,{timeout:10_000}).toBe(1);
    releaseOpenCode();
    await expect.poll(()=>server.gitTextAnswered).toBe(1);
    await page.waitForTimeout(500);
    await expect(alert).toHaveCount(0);
    await expect(message).toHaveValue("");

    await grokGenerate.click();
    await expect(message).toHaveValue("Grok Build fixture commit message");
    await expect(alert).toHaveCount(0);
    expect(server.gitText.map(item=>item.runtime)).toEqual(["opencode","grok"]);
  }finally{releaseOpenCode();await close();await directory.close()}
});

test("asking for the commit text while the pull request text is still being written keeps both",async({page})=>{
  test.setTimeout(60_000);
  let releaseReview=()=>{};const reviewAnswer=new Promise(resolve=>{releaseReview=resolve});
  const directory=await projectDirectory(),{server,relay,close}=await startHarness(page,{runtime:"grok",projectPath:directory.path,holdReviewText:{grok:reviewAnswer}});
  const dialogs=[];page.on("dialog",async dialog=>{dialogs.push([dialog.type(),dialog.message(),dialog.defaultValue()]);await dialog.accept(dialog.defaultValue())});
  try{
    const right=await openProjectGitPanel(page,relay),alert=right.locator(".source-control-error"),message=right.getByPlaceholder("Commit message");
    await right.getByRole("button",{name:"Generate PR",exact:true}).click();
    await expect.poll(()=>server.reviewText.length).toBe(1);
    // Generate (commit text) stays available while Grok Build writes the pull request text, and asking for it must not drop that text.
    const generate=right.getByRole("button",{name:"Generate with Grok Build",exact:true});
    await expect(generate).toBeEnabled();await generate.click();
    await expect(message).toHaveValue("Grok Build fixture commit message");
    releaseReview();
    // The pull request text still lands: its title and description prompts open with it, and the pull request is created.
    await expect.poll(()=>server.pullRequests.length,{timeout:10_000}).toBe(1);
    expect(dialogs).toEqual([["prompt","PR title","Grok Build fixture PR title"],["prompt","PR description","Written by Grok Build."]]);
    expect(server.pullRequests[0]).toMatchObject({cwd:directory.path,title:"Grok Build fixture PR title",body:"Written by Grok Build."});
    await expect(alert).toHaveCount(0);
    expect(server.gitText.map(item=>item.runtime)).toEqual(["grok"]);
  }finally{releaseReview();await close();await directory.close()}
});

test("a thread announced before thread/start answers is listed once while its turn waits, and Deny, Allow session and Allow once answer it",async({page})=>{
  test.setTimeout(60_000);
  const {server,relay,close}=await startHarness(page,{runtime:"antigravity",approvalCommands:{antigravity:"git log -n 5"}});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),approval=page.locator(".inline-approval .approval-card");
    await expect(page.getByTestId("model-picker")).toContainText("Antigravity Fixture");
    await composer.fill("Show the last five commits.");await expect(send).toBeEnabled();await send.click();
    await expect(approval).toContainText("git log -n 5",{timeout:15_000});
    expect(relay.threads).toHaveLength(1);
    const [thread]=relay.threads,[turnStart]=relay.calls("turn/start"),connection=turnStart.connection;
    // thread/started reached the app before the thread/start answer; the waiting turn's thread is still one row.
    const row=page.locator(`.thread-row[data-thread-id="${thread.id}"]`);
    await expect(row).toHaveCount(1);
    await expect(page.locator(".thread-row")).toHaveCount(1);
    await expect(approval.getByTestId("approval-thread")).toHaveCount(0);
    await expect(composer).toHaveAttribute("placeholder","Queue a follow-up…");
    await page.screenshot({path:auditDir+"harness-switch-waiting-approval-single-row-1600x980.png",fullPage:true});

    const answers=[["Deny","decline"],["Allow session","acceptForSession"],["Allow once","accept"]];
    for(const [index,[button,decision]] of answers.entries()){
      if(index){
        await composer.fill("Show the last five commits again.");await expect(send).toBeEnabled();await send.click();
        await expect(approval).toContainText("git log -n 5",{timeout:15_000});
        await expect(composer).toHaveAttribute("placeholder","Queue a follow-up…");
      }
      await approval.getByRole("button",{name:button,exact:true}).click();
      await expect.poll(()=>relay.responses.length,{timeout:10_000}).toBe(index+1);
      expect(relay.responses[index]).toEqual({connection,id:"agent-"+(index+1),result:{decision},error:null});
      await expect(page.getByText("Fixture reply from antigravity: "+decision,{exact:true})).toBeVisible({timeout:15_000});
      await expect(approval).toHaveCount(0);
      await expect(composer).toHaveAttribute("placeholder","Ask Trebell Code anything…");
      await expect(row).toHaveCount(1);
    }
    expect(relay.calls("thread/start")).toHaveLength(1);
    expect(relay.calls("turn/start").map(call=>call.params.threadId)).toEqual([thread.id,thread.id,thread.id]);
    await expect(page.getByText(/Could not answer approval request/)).toHaveCount(0);
    expect(server.counts.direct).toBe(0);
  }finally{await close()}
});

test("a harness switch drops the previous socket's open approval, and the new harness's approval is answered on its own socket",async({page})=>{
  test.setTimeout(60_000);
  const {server,relay,close}=await startHarness(page,{runtime:"antigravity",approvalCommands:{antigravity:"git log -n 5",cursor:"npm test"}});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),approval=page.locator(".inline-approval .approval-card");
    await expect(page.getByTestId("model-picker")).toContainText("Antigravity Fixture");
    await composer.fill("Show the last five commits.");await expect(send).toBeEnabled();await send.click();
    await expect(approval).toContainText("git log -n 5",{timeout:15_000});
    const first=relay.calls("turn/start")[0].connection;

    await selectHarness(page,"Cursor");
    await backToThreads(page);
    // The relay failed the Antigravity request when its socket closed, so nothing may answer it any more: it leaves the screen.
    await expect.poll(()=>relay.failed,{timeout:10_000}).toEqual([{connection:first,id:"agent-1"}]);
    await expect(approval).toHaveCount(0);
    await expect(page.getByTestId("model-picker")).toContainText("Cursor Fixture",{timeout:15_000});

    await composer.fill("Run the tests.");await expect(send).toBeEnabled({timeout:15_000});await send.click();
    // The Cursor socket numbers its requests from agent-1 again: the card shows Cursor's command and answers on Cursor's socket.
    await expect(approval).toContainText("npm test",{timeout:15_000});
    await expect(approval).not.toContainText("git log");
    await expect(approval).toHaveCount(1);
    const second=relay.calls("turn/start").at(-1).connection;
    expect(second).not.toBe(first);
    expect(relay.openConnections()).toEqual([second]);
    const cursorThread=relay.threads.find(item=>item.runtime==="cursor");
    await expect(page.locator(`.thread-row[data-thread-id="${cursorThread.id}"]`)).toHaveCount(1);
    await expect(composer).toHaveAttribute("placeholder","Queue a follow-up…");
    await page.screenshot({path:auditDir+"harness-switch-new-harness-approval-1600x980.png",fullPage:true});

    await approval.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect.poll(()=>relay.responses.length,{timeout:10_000}).toBe(1);
    expect(relay.responses).toEqual([{connection:second,id:"agent-1",result:{decision:"accept"},error:null}]);
    await expect(page.getByText("Fixture reply from cursor: accept",{exact:true})).toBeVisible({timeout:15_000});
    await expect(approval).toHaveCount(0);
    await expect(composer).toHaveAttribute("placeholder","Ask Trebell Code anything…");
    await expect(page.getByText(/Could not answer approval request/)).toHaveCount(0);
    expect(server.counts.direct).toBe(0);
  }finally{await close()}
});

test("a goal panel error belongs to its thread and is gone in the next thread",async({page})=>{
  test.setTimeout(60_000);
  const {relay,close}=await startHarness(page,{runtime:"grok"});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),reply=page.getByText("Fixture reply from grok: done",{exact:true});
    await composer.fill("First task.");await expect(send).toBeEnabled();await send.click();
    await expect(reply).toBeVisible({timeout:15_000});
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const goalPanel=page.getByTestId("right-panel").getByTestId("goal-panel"),goalError=goalPanel.locator(".inline-error");
    await goalPanel.getByLabel("Objective",{exact:true}).fill("Keep the fixture green");
    await goalPanel.getByRole("button",{name:"Set goal",exact:true}).click();
    await expect(goalError).toHaveText(GOAL_REJECTED);
    expect(relay.calls("thread/goal/set").map(call=>call.params.threadId)).toEqual([relay.threads[0].id]);

    // The panel stays open while another thread starts: the first thread's error does not describe the second one.
    await page.getByRole("button",{name:"New thread",exact:true}).click();
    await composer.fill("Second task.");await expect(send).toBeEnabled();await send.click();
    await expect.poll(()=>relay.threads.length,{timeout:15_000}).toBe(2);
    await expect(reply).toBeVisible({timeout:15_000});
    await expect(goalPanel).toBeVisible();
    await expect(goalError).toHaveCount(0);
    // Nor does the first thread's unsaved objective: both threads have no saved goal, so nothing else would replace the draft.
    await expect(goalPanel.getByLabel("Objective",{exact:true})).toHaveValue("");
  }finally{await close()}
});

test("a goal saved in one thread never shows in the thread opened while it was saving",async({page})=>{
  test.setTimeout(60_000);
  let releaseGoal=()=>{};const goalSet=new Promise(resolve=>{releaseGoal=resolve});
  const {relay,close}=await startHarness(page,{runtime:"grok",goalSet});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),reply=page.getByText("Fixture reply from grok: done",{exact:true});
    await composer.fill("First task.");await expect(send).toBeEnabled();await send.click();
    await expect(reply).toBeVisible({timeout:15_000});
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const goalPanel=page.getByTestId("right-panel").getByTestId("goal-panel"),objective=goalPanel.getByLabel("Objective",{exact:true});
    await objective.fill("Ship the first thread");
    await goalPanel.getByRole("button",{name:"Set goal",exact:true}).click();
    await expect.poll(()=>relay.calls("thread/goal/set").length).toBe(1);

    // The first thread's goal is still being saved when the second thread starts.
    await page.getByRole("button",{name:"New thread",exact:true}).click();
    await composer.fill("Second task.");await expect(send).toBeEnabled();await send.click();
    await expect.poll(()=>relay.threads.length,{timeout:15_000}).toBe(2);
    await expect(reply).toBeVisible({timeout:15_000});
    releaseGoal();
    await expect.poll(()=>relay.savedGoals.map(goal=>goal.threadId)).toEqual([relay.threads[0].id]);
    await page.waitForTimeout(300);
    // The saved goal is the first thread's: the second thread still has none.
    await expect(goalPanel.locator(".goal-status")).toHaveText("not set");
    await expect(objective).toHaveValue("");
    await expect(goalPanel.getByRole("button",{name:"Set goal",exact:true})).toBeVisible();
  }finally{releaseGoal();await close()}
});
