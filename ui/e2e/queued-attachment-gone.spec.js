import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

// A follow-up waiting in Trebell's own queue (a Codex project thread) whose attached file went while it waited (L10-F-1's review,
// 2026-11-02): the queue's start of it and each Send now refused it with the same words, and attaching the file again, as they
// advised, added it to the composer, not to the follow-up, which kept refusing. The file comes off the follow-up now, which waits for
// the person, and the composer says so once; the next Send now sends it.
const auditDir=fileURLToPath(new URL("../../visual-audit/attachment-unreadable/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("a queued follow-up whose attached file is gone loses that file, says so once and waits, and Send now then sends it",async({page})=>{
  test.setTimeout(60_000);
  const project={id:"queue-gone-project",name:"Queue Gone Project",path:process.cwd(),environmentId:null};
  const thread={id:"codex-queue-gone",name:"Queued file gone",preview:"Queued file gone",cwd:project.path,projectId:"native-project",createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const calls=[];let nextTurnId=1,socketShown=null;
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  const notify=(method,params)=>socketShown?.readyState===socketShown?.OPEN&&socketShown.send(JSON.stringify({method,params}));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);socketShown=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"queue-gone-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/items/list"||message.method==="thread/attachment/list"||message.method==="thread/timeline/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="project/list")result={data:[{id:"native-project",name:project.name,roots:[{path:project.path}],metadata:{trebellProjectId:project.id}}],nextCursor:null};
      else if(message.method==="turn/start"){
        const turn={id:"gone-turn-"+(nextTurnId++),status:"inProgress",items:[]};thread.status={type:"active",turnId:turn.id};result={turn};
        ws.send(JSON.stringify({id:message.id,result}));setTimeout(()=>notify("turn/started",{threadId:thread.id,turn}),0);return;
      }else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  let meta={projectless:false,environmentId:null,cwd:project.path};
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:project.path,platform:process.platform,version:"queue-gone-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue",activeProjectId:project.id},projects:[project],threadMeta:{[thread.id]:meta}}));
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[project],project}));
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/thread-meta$/,route=>{if(route.request().method()==="POST")meta={...meta,...(route.request().postDataJSON().patch||{})};return json(route,meta)});
    await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"ctx",skipped:true,budget:{reserveTokens:1024}}));
    await page.route(/\/api\/git\/info\?/,route=>json(route,{isGit:true,root:project.path,branch:"main",branches:["main"],upstream:"origin/main",status:[],remotes:[],worktrees:[{path:project.path,branch:"main"}]}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="GET"?{checkpoints:[]}:{supported:false}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({hasText:"Queued file gone"});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    const composer=page.getByTestId("composer");await composer.fill("Look at the release");await page.getByTestId("send").click();
    await expect.poll(()=>calls.filter(call=>call.method==="turn/start").length).toBe(1);
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible();
    // While the turn runs, the person queues a follow-up with a file, whose saved copy goes before the queue starts it.
    const imported=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/attachments/import");
    const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files"}).click()]);
    await chooser.setFiles({name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("release notes\n")});
    const saved=(await (await imported).json()).files[0].path;
    await expect(page.getByRole("button",{name:"Remove notes.txt"})).toBeVisible();
    await composer.fill("And the notes?");await page.getByTestId("send").click();
    const queued=page.locator(".queued-message").filter({hasText:"And the notes?"});await expect(queued).toBeVisible();
    await expect.poll(()=>meta.trebellQueue?.[0]?.attachments?.length||0).toBe(1);
    await rm(saved,{force:true});
    // The turn ends: the queue starts the follow-up, whose file is gone.
    thread.status={type:"idle"};notify("turn/completed",{threadId:thread.id,turn:{id:"gone-turn-1",status:"completed"}});
    const said=page.getByTestId("composer-alert");
    await expect(said).toHaveText('"notes.txt" is no longer on this computer, so it was taken off the queued follow-up. Edit the follow-up to attach it again, or send the follow-up without it.',{timeout:20_000});
    await expect(page.getByText(/Attach it again\.$|ENOENT|no such file/)).toHaveCount(0);
    await expect(queued,"it waits for the person").toContainText("retry needed");
    await expect.poll(()=>meta.trebellQueue?.[0]?.attachments?.length??-1,"the file is off the follow-up").toBe(0);
    expect(calls.filter(call=>call.method==="turn/start").length,"it did not go without the file unasked").toBe(1);
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").first().click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await page.screenshot({animations:"disabled",path:`${auditDir}queued-attachment-gone-${mode}-1280x800.png`});
    }
    // Send now sends it, without the file, and the note goes with it.
    await queued.getByRole("button",{name:"Send now"}).click();
    await expect.poll(()=>calls.filter(call=>call.method==="turn/start").length).toBe(2);
    expect(JSON.stringify(calls.filter(call=>call.method==="turn/start")[1].params.input)).not.toContain("notes.txt");
    await expect(queued).toHaveCount(0);await expect(said).toHaveCount(0);
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
