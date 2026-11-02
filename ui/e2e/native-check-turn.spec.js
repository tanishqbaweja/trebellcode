import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";
import { assessVerification } from "../../src/verification-assessor.mjs";
import { verificationCheckTurnReading } from "../../src/verification-continuation.mjs";
import { mergeVerificationEvidence, nextVerificationAction } from "../../src/verification-loop.mjs";

// A Supervised Native turn's automatic check: its command waits for the person's approval, which does not count toward the command's
// time limit; the check turn ends with Stop gone and its card done; a step its check turn left unchecked, and a check the person
// denied, start no further check turn; the card says what it checks in plain words, the check that ran is kept (the plan reads
// verified), and a denied check's card and plan say checking stopped. The model is a scripted mock (no live call), the relay, policy,
// approval and command run are Trebell's own, and the server's reading of each turn (plan-turn) is played here with the helpers the
// server uses (verificationCheckTurnReading, which reads the turn with collectVerificationEvidence, and mergeVerificationEvidence).
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,body)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
const CHECK_LIMIT_MS=2000,PAST_LIMIT_MS=6500;

test("a Supervised Native check waits for approval outside its time limit, ends cleanly, and stops once denied",async({page})=>{
  test.setTimeout(120_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-check-turn-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  // The check's command takes 1.2 s of its 2 s limit.
  await writeFile(join(repo,"check.js"),"setTimeout(()=>console.log('checked'),1200);\n");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),model="model-a";
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-check-turn",model,name:"Native check turn",preview:"Check turn fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null}});
  const checkCalls=[],checkResults=[];
  const nativeProviderTurn=async request=>{
    const reply=(id,text,toolCalls=[])=>({id,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}});
    if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return reply("gate",JSON.stringify({status:"complete",progress:"uncertain",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The fixture turn is done."}));
    const said=message=>typeof message.content==="string"?message.content:JSON.stringify(message.content??"");
    const asked=[...request.messages].reverse().find(message=>message.role==="user"&&/Describe the parser|Continue verification for this task/.test(said(message)));
    const last=request.messages.at(-1),check=/Continue verification for this task/.test(asked?said(asked):"");
    if(!check)return reply("user-turn","The parser reads key=value lines.");
    if(last?.role!=="tool"){checkCalls.push(Date.now());return reply("check-run","",[{id:"check-call-"+checkCalls.length,namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:"node",args:["check.js"],timeout_ms:CHECK_LIMIT_MS})}])}
    // The model reads the tool's result after Trebell's provenance line.
    const text=said(last),output=JSON.parse(text.slice(text.indexOf("{"),text.lastIndexOf("}")+1));checkResults.push(output);
    return reply("check-done",output.exitCode===0&&!output.timedOut?"The check ran: node check.js printed checked.":"The check could not run: "+String(output.error||"it failed").replace(/[.]$/,"")+".");
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"check-turn-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-check-project",name:"Native Check Project",path:repo,environmentId:null,effectiveSettings:{}},uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  const plan={risk:"low",steps:[{id:"focused_behavior",kind:"behavioral",scope:"changed-behavior",cost:"medium",required:true,evidence:["stated-acceptance-behavior"],reason:"Run a focused executable check for the task's stated acceptance behavior."}]};
  const readings=[];
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"check-turn-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    // The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
    const saved={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,saved)});
    await page.route(/\/api\/state$/,route=>json(route,{settings:saved,projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}}));
    await page.route(/\/api\/models$/,route=>json(route,{provider:"agentrouter",agentRuntime:"native",ready:true,models:[model],metadata:{provider:"agentrouter",models:[{id:model,name:"Model A",provider:"agentrouter",agent:"Trebell Native"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,uiMeta));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:`check-checkpoint-${Date.now()}`,threadId:thread.id}:{checkpoints:[]}));
    await page.route(/\/api\/checkpoints\/link$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"check-context",skipped:true,budget:{reserveTokens:1024}}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    // The server's reading of a finished turn: a turn of the person's plans the check; a check turn's reading keeps the plan, names the
    // chain's first record and says when its check was not allowed (as gui-server's plan-turn does).
    await page.route(/\/api\/verification\/plan-turn$/,async route=>{
      const {threadId,turnId}=route.request().postDataJSON(),chain=state.threadMeta(threadId)?.verificationContinuationChain||null;
      if(chain?.lastContinuationTurnId===turnId&&chain.sourceRecordId){
        const source=state.verificationRecords({threadId,limit:100}).find(item=>item.id===chain.sourceRecordId),turn=threadStore.get(threadId)?.turns?.find(item=>String(item.id)===String(turnId));
        const {observed,stopped}=verificationCheckTurnReading({plan:source.plan,evidence:source.evidence,turnItems:turn?.items||[],traces:[]}),evidence=mergeVerificationEvidence(source.evidence,observed);
        const record=state.recordVerification({threadId,turnId,projectPath:repo,plan:source.plan,evidence,assessment:assessVerification({plan:source.plan,evidence})});
        if(stopped)state.updateThreadMeta(threadId,{verificationContinuationChain:{...chain,stopped}});
        readings.push({turnId,check:true,stopped,status:record.assessment?.status||null});
        return json(route,{supported:true,continuation:true,sourceRecordId:source.id,rootRecordId:String(chain.rootRecordId||source.id),...(stopped?{stopped}:{}),threadId,turnId,changedPaths:[],record,nextAction:nextVerificationAction({plan:record.plan,evidence:record.evidence})});
      }
      const record=state.recordVerification({threadId,turnId,projectPath:repo,plan,evidence:[],assessment:assessVerification({plan,evidence:[]})});readings.push({turnId,check:false});
      return json(route,{supported:true,threadId,turnId,changedPaths:["parse-kv.js"],record,nextAction:nextVerificationAction({plan,evidence:[]})});
    });
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native check turn"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    const composer=page.getByTestId("composer"),stop=page.getByRole("button",{name:"Stop",exact:true}),approval=page.locator(".approval-card").filter({hasText:"node check.js"});
    const card=page.locator(".tool-event.kind-verification").filter({hasText:"Automatic check · trying the changed behavior"});
    // Each state in both themes, switched with the header's own button as a person does.
    const shot=async name=>{await page.screenshot({animations:"disabled",path:auditDir+`native-check-turn-${name}-1280-dark.png`});await page.getByRole("button",{name:"Switch to light mode",exact:true}).click();await page.waitForTimeout(200);await page.screenshot({animations:"disabled",path:auditDir+`native-check-turn-${name}-1280-light.png`});await page.getByRole("button",{name:"Switch to dark mode",exact:true}).click();await page.waitForTimeout(200)};
    await expect(page.locator(".permission-picker").first()).toHaveValue("supervised");
    await composer.fill("Describe the parser");await page.getByTestId("send").click();
    await expect(page.getByText("The parser reads key=value lines.",{exact:true})).toBeVisible({timeout:15_000});

    // 1. The check turn starts by itself and says in plain words what it checks; its command asks first.
    await expect(card).toBeVisible({timeout:15_000});await expect(card.locator("summary em")).toHaveText("running");await expect(stop).toBeVisible();
    await expect(approval).toBeVisible({timeout:15_000});const askedAt=Date.now();
    await expect(page.getByText(/focused_behavior|same-thread check turn/)).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();await shot("running");
    // The person waits past the command's limit and its grace (2 s + 3.5 s): nothing times out while they are asked.
    await page.waitForTimeout(Math.max(0,PAST_LIMIT_MS-(Date.now()-askedAt)));
    expect(checkResults).toEqual([]);await expect(approval).toBeVisible();
    await approval.getByRole("button",{name:"Allow once",exact:true}).click();
    // 2. Once allowed, the command runs with its whole limit and finishes.
    await expect(page.getByText("The check ran: node check.js printed checked.",{exact:true})).toBeVisible({timeout:15_000});
    expect(checkResults).toHaveLength(1);expect(checkResults[0]).toMatchObject({exitCode:0,timedOut:false,signal:null});expect(String(checkResults[0].stdout)).toMatch(/^checked/);
    // 3. The check's end ends the running state: Stop goes, the card reads done, the check that ran is kept (the plan reads verified),
    // and no second check turn starts for the same step.
    await expect(card.locator("summary em")).toHaveText("done",{timeout:10_000});await expect(stop).toHaveCount(0);
    const verified=page.locator(".tool-event.kind-verification").filter({hasText:"Verified · low risk · 1 required check passed"});await expect(verified).toHaveCount(1,{timeout:10_000});await expect(verified.locator("summary em")).toHaveText("done");
    await expect.poll(()=>readings.filter(item=>item.check).length,{timeout:10_000}).toBe(1);await page.waitForTimeout(1500);
    expect(checkCalls).toHaveLength(1);await expect(stop).toHaveCount(0);
    await expect(page.locator(".tool-event.kind-verification summary em",{hasText:/^(pending|running)$/})).toHaveCount(0);
    await expect(page.getByText(/focused_behavior|same-thread check turn/)).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();await shot("done");

    // 4. The next turn's check is denied: its turn ends, and no further check turn starts, by the window or by the server.
    await composer.fill("Describe the parser again");await page.getByTestId("send").click();
    await expect(page.getByText("The parser reads key=value lines.",{exact:true})).toHaveCount(2,{timeout:15_000});
    await expect(approval).toBeVisible({timeout:15_000});await approval.getByRole("button",{name:"Deny",exact:true}).click();
    await expect(page.getByText("The check could not run: Tool execution was not approved.",{exact:true})).toBeVisible({timeout:15_000});
    await expect.poll(()=>readings.filter(item=>item.check).map(item=>item.stopped),{timeout:10_000}).toEqual([null,"not-approved"]);expect(readings.filter(item=>item.check).map(item=>item.status)).toEqual(["verified","incomplete"]);
    await page.waitForTimeout(1500);expect(checkCalls).toHaveLength(2);await expect(stop).toHaveCount(0);
    await expect(page.locator(".tool-event.kind-verification summary em",{hasText:/^(pending|running)$/})).toHaveCount(0);
    // Its card says the check was not allowed, as a warning, and its plan says checking stopped instead of naming a next check.
    const denied=page.locator(".tool-event.kind-verification").filter({hasText:"Automatic check · trying the changed behavior · not allowed"});await expect(denied).toHaveCount(1,{timeout:10_000});await expect(denied.locator("summary em")).toHaveText("warning");
    const stoppedPlan=page.locator(".tool-event.kind-verification").filter({hasText:"Verification planned · low risk · 1 required check · checking stopped"});await expect(stoppedPlan).toHaveCount(1);await expect(stoppedPlan.locator("summary em")).toHaveText("incomplete");
    await expect(stoppedPlan).not.toContainText("next:");
    await stoppedPlan.scrollIntoViewIfNeeded();await shot("denied");
    // The server refuses an automatic check after the denied one, whoever asks.
    const ws=new WebSocket(`ws://127.0.0.1:${relayPort}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    const refused=await new Promise(resolve=>{ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id==="check-again")resolve(message)});ws.send(JSON.stringify({id:"check-again",method:"thread/verification/continue",params:{threadId:thread.id,auto:true}}))});ws.close();
    expect(refused.error?.message).toBe("The last check was not allowed to run.");expect(checkCalls).toHaveLength(2);
    const metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
