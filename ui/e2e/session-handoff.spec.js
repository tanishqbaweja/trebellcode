import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";

// A thread whose harness lost its conversation, through the real relay and a scripted Cursor: the turn that continues it in a new
// session says so in a row of its own, and a send whose new session cannot start says why beside the composer that kept the draft.
const auditDir=fileURLToPath(new URL("../../visual-audit/session-handoff/",import.meta.url));
mkdirSync(auditDir,{recursive:true});
const frames=(page,count)=>page.evaluate(total=>new Promise(resolve=>{let left=total;const tick=()=>--left>0?requestAnimationFrame(tick):resolve();requestAnimationFrame(tick)}),count);
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}

// Cursor over ACP, scripted by a JSON file it reads at every request (so a test can change it between turns): it logs each request,
// answers session/load with config.lostError when set, numbers its new sessions (or fails them with config.newError), and answers
// a prompt with one file read and config.reply.
const FAKE_CURSOR=String.raw`
import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const [log,configPath]=process.argv.slice(2);
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function handle(m){
  if(!m.method||m.id==null)return;
  appendFileSync(log,JSON.stringify({method:m.method,params:m.params??null})+"\n");
  const config=JSON.parse(readFileSync(configPath,"utf8")),reply=result=>send({jsonrpc:"2.0",id:m.id,result}),fail=error=>send({jsonrpc:"2.0",id:m.id,error});
  if(m.method==="initialize")return reply({protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true}});
  const models={currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]};
  if(m.method==="session/load"||m.method==="session/resume")return config.lostError?fail(config.lostError):reply({models});
  if(m.method==="session/new"){
    if(config.newError)return fail(config.newError);
    const count=readFileSync(log,"utf8").split("\n").filter(line=>line.includes('"method":"session/new"')).length;
    return reply({sessionId:"fresh-"+count,models});
  }
  if(m.method==="session/prompt"){
    const sessionId=m.params.sessionId,call="read-"+Date.now(),update=value=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}});
    update({sessionUpdate:"tool_call",toolCallId:call,title:"Read notes.md",kind:"read",status:"in_progress",rawInput:{path:"notes.md"}});
    await delay(400);
    update({sessionUpdate:"tool_call_update",toolCallId:call,status:"completed",content:[{type:"content",content:{type:"text",text:"PELICAN\nHERON\n"}}]});
    update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:config.reply||"Done."}});
    return reply({stopReason:"end_turn"});
  }
  return reply({});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(()=>{})}catch{}});
`;
// What Cursor answers for a conversation it does not have.
const LOST={code:-32603,message:"Internal error",data:{message:"Session \"cursor-lost\" not found"}};
const HANDED_OVER="Cursor no longer had this conversation, so it continues in a new session with the earlier messages handed over.";

// The relay with the scripted Cursor and a saved thread as a restart leaves it: one finished turn (a command and a reply) in the
// conversation Cursor keeps under providerSessionId.
async function cursorFixture(name,{providerSessionId,config}){
  const root=await mkdtemp(join(tmpdir(),"trebell-session-handoff-")),fixture=join(root,"cursor.mjs"),log=join(root,"log.jsonl"),configPath=join(root,"config.json");
  await writeFile(fixture,FAKE_CURSOR,"utf8");
  const configure=value=>writeFile(configPath,JSON.stringify(value),"utf8");await configure(config);
  const env={...process.env,TREBELL_HOME:join(root,"home")},threadStore=new AgentThreadStore(env);
  const instance={id:"cursor-default",kind:"cursor",displayName:"Cursor",enabled:true};
  const thread=threadStore.create({runtime:"cursor",cwd:root,providerSessionId,model:"fixture-model",name,providerMeta:{runtimeInstanceId:instance.id,permissionProfile:"supervised",projectless:true,environmentId:null}});
  threadStore.update(thread.id,{runtimeInstanceId:instance.id});
  const earlier=threadStore.addTurn(thread.id,{inputText:"Remember the word PELICAN",items:[{type:"commandExecution",id:"cmd-1",command:"echo PELICAN",aggregatedOutput:"PELICAN\n",exitCode:0,status:"completed"},{type:"agentMessage",id:"answer-1",text:"REMEMBERED"}]});
  threadStore.finishTurn(thread.id,earlier.id);
  const runtimeManager={
    activeRuntime:()=>"cursor",activeInstance:()=>({...instance}),instances:()=>[{...instance}],compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"Cursor",available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>process.execPath,
    // Cursor takes the permission mode as a launch argument, so another mode starts it again (and it resumes its conversation).
    acpArgs:(_instance,mode)=>[fixture,log,configPath,String(mode||"supervised")],
  };
  const meta=new Map([[thread.id,{projectless:true,environmentId:null}]]);
  const state={
    settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),
    threadMeta:id=>meta.get(id)||{},
    updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},
    recordUsage:()=>{},
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  const port=await listen(server);
  const requests=async()=>(await readFile(log,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
  return {
    root,thread,threadStore,meta,port,configure,requests,
    async close(){await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}

async function routeApp(page,fx){
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"cursor",agentRuntimeInstanceId:"cursor-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+fx.port+"/api/agent/ws",cwd:fx.root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"cursor",agentRuntimeInstanceId:"cursor-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[],threadMeta:Object.fromEntries(fx.meta)}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:["fixture-model"],metadata:{provider:"cursor",models:[{id:"fixture-model",name:"Fixture Model",provider:"cursor",agent:"Cursor"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
}
async function openThreadRow(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
  await expect(page.getByText("REMEMBERED",{exact:true})).toBeVisible({timeout:15_000});
}
const reply=(page,text)=>page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:text});
const userRow=(page,text)=>page.locator(".user-row").filter({hasText:text});
const box=async locator=>{const value=await locator.boundingBox();expect(value).toBeTruthy();return value};
// Each box ends where the next one starts or above it: the order the rows read in on screen, whatever the layout reorders.
async function expectReadingOrder(...locators){
  const boxes=[];for(const locator of locators)boxes.push(await box(locator));
  for(let index=1;index<boxes.length;index++)expect(boxes[index-1].y+boxes[index-1].height,"row "+index+" reads after row "+(index-1)).toBeLessThanOrEqual(boxes[index].y+1);
}
// The handoff row is a quiet note of its turn: the secondary text colour (never the failure colour), in the reply column where
// the turn's card and reply start, whole inside the conversation column, and the page never scrolls sideways.
function handoffFit(page){
  return page.getByTestId("session-handoff").evaluate(row=>{
    const probe=document.createElement("span");document.body.append(probe);
    const colour=value=>{probe.style.color=value;return getComputedStyle(probe).color};
    const text=getComputedStyle(row.querySelector("p")).color,tx2=colour("var(--tx2)"),err=colour("var(--err)");probe.remove();
    const column=document.querySelector(".conversation-column").getBoundingClientRect(),rect=row.getBoundingClientRect(),shell=document.querySelector(".workspace-shell");
    const body=[...document.querySelectorAll(".history-assistant-body")].find(node=>node.getBoundingClientRect().width)?.getBoundingClientRect();
    return {
      secondaryText:text===tx2,failureColour:text===err,
      inColumn:rect.left>=column.left-1&&rect.right<=column.right+1,
      replyColumn:Boolean(body)&&Math.abs(body.left-rect.left)<=1,
      clipped:row.scrollWidth>row.clientWidth+1||row.querySelector("p").scrollWidth>row.querySelector("p").clientWidth+1,
      sideways:shell.scrollWidth>shell.clientWidth+1,
    };
  });
}
const FIT={secondaryText:true,failureColour:false,inColumn:true,replyColumn:true,clipped:false,sideways:false};
async function auditHandoff(page,name){
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    for(const [width,height] of [[1280,800],[900,800]]){
      await page.setViewportSize({width,height});await frames(page,3);
      await page.getByTestId("session-handoff").scrollIntoViewIfNeeded();await frames(page,3);
      expect(await handoffFit(page),`${name} ${mode} ${width}x${height}`).toEqual(FIT);
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x${height}.png`});
    }
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1280,height:800});
}

test("a turn that continues a conversation Cursor lost says so once in that turn, live, after a reload on item pages and on turn pages",async({page})=>{
  test.setTimeout(150_000);
  const fx=await cursorFixture("Cursor lost conversation",{providerSessionId:"cursor-lost",config:{lostError:LOST,reply:"You asked me to remember PELICAN."}});
  // Every request the window sends, and a switch that has thread/resume answer without an item cursor, as a harness that pages
  // its history only by turns does.
  const sent=[];let turnPages=false;
  try{
    await routeApp(page,fx);
    await page.routeWebSocket(/\/api\/agent\/ws$/,ws=>{
      const server=ws.connectToServer(),resumes=new Set();
      ws.onMessage(message=>{try{const value=JSON.parse(String(message));if(value?.method){sent.push(value);if(value.method==="thread/resume")resumes.add(value.id)}}catch{}server.send(message)});
      server.onMessage(message=>{
        let value=null;try{value=JSON.parse(String(message))}catch{}
        if(turnPages&&value?.result&&resumes.has(value.id)){resumes.delete(value.id);ws.send(JSON.stringify({...value,result:{...value.result,itemsBackwardsCursor:null}}));return}
        ws.send(message);
      });
    });
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await openThreadRow(page,"Cursor lost conversation");
    const composer=page.getByTestId("composer"),handoff=page.getByTestId("session-handoff");
    await expect(composer).toBeEnabled();
    await composer.fill("What word did I ask you to remember?");await page.getByTestId("send").click();

    // Live: the row comes with the turn, in the relay's words, before the turn's card and reply.
    await expect(handoff).toHaveText(HANDED_OVER,{timeout:15_000});
    await expect(reply(page,"You asked me to remember PELICAN.")).toBeVisible({timeout:15_000});
    const turnId=fx.threadStore.get(fx.thread.id).turns.at(-1).id;
    await expect(handoff).toHaveCount(1);await expect(handoff).toHaveAttribute("data-turn-id",turnId);
    expect((await fx.requests()).map(entry=>[entry.method,entry.params?.sessionId??null]).filter(([method])=>["session/load","session/resume","session/new","session/prompt"].includes(method))).toEqual([["session/load","cursor-lost"],["session/new",null],["session/prompt","fresh-1"]]);
    const liveCard=page.locator(".agent-block [data-testid=activity-card]");
    await expect(liveCard).toContainText("Read notes.md");
    await expectReadingOrder(userRow(page,"What word did I ask you to remember?"),handoff,liveCard,reply(page,"You asked me to remember PELICAN."));
    // Not a step, not a failure and not a turn's end.
    await expect(page.locator(".tool-event").filter({hasText:"no longer had this conversation"})).toHaveCount(0);
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);await expect(page.getByTestId("turn-outcome-row")).toHaveCount(0);
    await expect(reply(page,"You asked me to remember PELICAN.").getByTestId("turn-outcome")).toHaveText(/^done/);
    await auditHandoff(page,"session-handoff-live");

    // A reload opens the thread on item pages: the row is the turn's, once, where it was.
    const pages=()=>sent.filter(message=>message.method==="thread/items/list"||message.method==="thread/turns/list").map(message=>message.method+(message.params?.itemsView?":"+message.params.itemsView:""));
    sent.length=0;await page.reload();await openThreadRow(page,"Cursor lost conversation");
    await expect(reply(page,"You asked me to remember PELICAN.")).toBeVisible();
    expect(pages()).toContain("thread/items/list");
    await expect(handoff).toHaveCount(1);await expect(handoff).toHaveText(HANDED_OVER);await expect(handoff).toHaveAttribute("data-turn-id",turnId);
    const card=page.locator(`.turn-card [data-testid=activity-card][data-turn-id="${turnId}"]`);
    await expect(card).toBeVisible();
    await expectReadingOrder(page.getByText("REMEMBERED",{exact:true}),userRow(page,"What word did I ask you to remember?"),handoff,card,reply(page,"You asked me to remember PELICAN."));
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);await expect(page.getByTestId("turn-outcome-row")).toHaveCount(0);
    await auditHandoff(page,"session-handoff-reloaded");

    // The same on turn pages.
    turnPages=true;sent.length=0;await page.reload();await openThreadRow(page,"Cursor lost conversation");
    await expect(reply(page,"You asked me to remember PELICAN.")).toBeVisible();
    expect(pages()).toContain("thread/turns/list:full");expect(pages()).not.toContain("thread/items/list");
    await expect(handoff).toHaveCount(1);await expect(handoff).toHaveText(HANDED_OVER);await expect(handoff).toHaveAttribute("data-turn-id",turnId);
    await expectReadingOrder(userRow(page,"What word did I ask you to remember?"),handoff,card,reply(page,"You asked me to remember PELICAN."));
    expect(await handoffFit(page)).toEqual(FIT);
    await page.screenshot({animations:"disabled",path:auditDir+"session-handoff-turn-pages-dark-1280x800.png"});

    // The next turn runs in the new session with nothing handed over again, so it has no row of its own.
    await fx.configure({reply:"You are welcome."});
    await composer.fill("Thanks");await page.getByTestId("send").click();
    await expect(reply(page,"You are welcome.")).toBeVisible({timeout:15_000});
    await expect(handoff).toHaveCount(1);await expect(handoff).toHaveAttribute("data-turn-id",turnId);
    expect((await fx.requests()).filter(entry=>entry.method==="session/prompt").map(entry=>entry.params.sessionId)).toEqual(["fresh-1","fresh-1"]);
    await expectReadingOrder(handoff,card,reply(page,"You asked me to remember PELICAN."),userRow(page,"Thanks"));
  }finally{await fx.close()}
});

test("a send whose new session cannot start says why beside the composer that kept the draft, never on the last turn's card",async({page})=>{
  test.setTimeout(150_000);
  const fx=await cursorFixture("Cursor cannot start",{providerSessionId:"cursor-live",config:{reply:"Noted: HERON."}});
  try{
    await routeApp(page,fx);await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await openThreadRow(page,"Cursor cannot start");
    const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert"),send=page.getByTestId("send");
    await expect(composer).toBeEnabled();
    await composer.fill("Also remember HERON.");await send.click();
    await expect(reply(page,"Noted: HERON.")).toBeVisible({timeout:15_000});
    const previous=fx.threadStore.get(fx.thread.id).turns.at(-1).id;
    await expect(page.locator(".agent-block [data-testid=activity-card]")).toContainText("Read notes.md");

    // Cursor starts again (another permission mode is another launch) without the conversation, and its new session cannot start.
    await fx.configure({lostError:LOST,newError:{code:-32603,message:"Internal error",data:{message:"No space left on device"}},reply:"You asked me to remember PELICAN and HERON."});
    await page.locator(".permission-picker").first().selectOption("read-only");
    const draft="Which words did I ask you to remember?";
    await composer.fill(draft);await send.click();
    await expect(alert).toHaveText("Not sent: No space left on device. Your draft is kept.",{timeout:15_000});
    await expect(alert).toHaveAttribute("role","alert");
    await expect(page.locator(".composer-status")).toHaveClass(/error/);
    await expect(composer).toHaveValue(draft);await expect(composer).toBeEnabled();
    expect(fx.threadStore.get(fx.thread.id).turns.length).toBe(2);
    expect((await fx.requests()).filter(entry=>entry.method==="session/prompt").length).toBe(1);
    // The turn before keeps its card as it was, with its step and no error, and its reply below it; the message the harness
    // refused is not in the conversation, and no live card holds the failure.
    const card=page.locator(`.turn-card [data-testid=activity-card][data-turn-id="${previous}"]`);
    await expect(card).toBeVisible();await expect(card).toContainText("Read notes.md");
    await expect(page.locator(".agent-block")).toHaveCount(0);await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    await expect(page.getByTestId("turn-outcome-row")).toHaveCount(0);await expect(userRow(page,draft)).toHaveCount(0);
    await expectReadingOrder(userRow(page,"Also remember HERON."),card,reply(page,"Noted: HERON."));
    await expect(page.getByTestId("session-handoff")).toHaveCount(0);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      for(const [width,height] of [[1280,800],[900,800]]){
        await page.setViewportSize({width,height});await frames(page,3);
        const fit=await alert.evaluate(node=>{const status=node.closest(".composer-status"),wrap=node.closest(".composer-wrap").getBoundingClientRect(),rect=node.getBoundingClientRect(),shell=document.querySelector(".workspace-shell");return {inside:rect.left>=wrap.left-1&&rect.right<=wrap.right+1,clipped:status.scrollWidth>status.clientWidth+1,sideways:shell.scrollWidth>shell.clientWidth+1}});
        expect(fit,`${mode} ${width}x${height}`).toEqual({inside:true,clipped:false,sideways:false});
        await page.screenshot({animations:"disabled",path:`${auditDir}send-failed-${mode}-${width}x${height}.png`});
      }
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1280,height:800});

    // A change to the draft ends the note; a send that fails again says so again, and the next send ends it.
    await composer.press("End");await composer.pressSequentially(" Both");
    await expect(alert).toHaveCount(0);await expect(page.locator(".composer-status")).not.toHaveClass(/error/);
    await send.click();
    await expect(alert).toHaveText("Not sent: No space left on device. Your draft is kept.",{timeout:15_000});
    await expect(composer).toHaveValue(draft+" Both");
    // With room again, the send continues the conversation in a new session, which the turn says.
    await fx.configure({lostError:LOST,reply:"You asked me to remember PELICAN and HERON."});
    await send.click();
    await expect(alert).toHaveCount(0);
    await expect(reply(page,"You asked me to remember PELICAN and HERON.")).toBeVisible({timeout:15_000});
    await expect(composer).toHaveValue("");
    const handoff=page.getByTestId("session-handoff");
    await expect(handoff).toHaveCount(1);await expect(handoff).toHaveText(HANDED_OVER);
    await expect(userRow(page,draft+" Both")).toHaveCount(1);
    await expectReadingOrder(reply(page,"Noted: HERON."),userRow(page,draft+" Both"),handoff,page.locator(".agent-block [data-testid=activity-card]"),reply(page,"You asked me to remember PELICAN and HERON."));
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"send-failed-then-handed-over-dark-1280x800.png"});
  }finally{await fx.close()}
});
