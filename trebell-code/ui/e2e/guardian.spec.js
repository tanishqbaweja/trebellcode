import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Codex auto-review denial can be explicitly overridden through the native RPC",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"guardian-fixture",name:"Auto review fixture",preview:"Guardian recovery",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const calls=[];let notificationSocket=null;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"guardian-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/approveGuardianDeniedAction")result={};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"guardian-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:/Auto review fixture/}).click();await expect(page.getByRole("heading",{name:"What do you want to think through?"})).toBeVisible();

    const startedAt=Date.now(),completedAt=startedAt+125;
    notificationSocket.send(JSON.stringify({id:"approval-other-client",method:"item/commandExecution/requestApproval",params:{threadId:thread.id,turnId:"turn-approval",itemId:"cmd-approval",command:["echo","approval"],reason:"Approve this fixture command"}}));
    const approvalCard=page.locator(".approval-card").filter({hasText:"Approve this fixture command"});await expect(approvalCard).toBeVisible();
    notificationSocket.send(JSON.stringify({method:"serverRequest/resolved",params:{threadId:thread.id,requestId:"approval-other-client"}}));
    await expect(approvalCard).toHaveCount(0);

    const action={type:"command",source:"unifiedExec",command:"rm generated.tmp",cwd:process.cwd()};
    notificationSocket.send(JSON.stringify({method:"item/autoApprovalReview/started",params:{threadId:thread.id,turnId:"turn-1",startedAtMs:startedAt,reviewId:"review-1",targetItemId:"cmd-1",review:{status:"inProgress",riskLevel:null,userAuthorization:null,rationale:null},action}}));
    await expect(page.getByText(/Auto review · rm generated\.tmp/)).toBeVisible();
    notificationSocket.send(JSON.stringify({method:"autoApprovalReview/strictReviewRequired",params:{threadId:thread.id,turnId:"turn-1",startedAtMs:startedAt}}));
    await expect(page.getByText("Additional safety checks are running; some tool calls may take extra time",{exact:true})).toBeVisible();
    notificationSocket.send(JSON.stringify({method:"item/autoApprovalReview/completed",params:{threadId:thread.id,turnId:"turn-1",startedAtMs:startedAt,completedAtMs:completedAt,reviewId:"review-1",targetItemId:"cmd-1",decisionSource:"agent",review:{status:"denied",riskLevel:"high",userAuthorization:"low",rationale:"Deleting this file needs explicit user approval."},action}}));
    const card=page.getByTestId("guardian-denial-card");await expect(card).toBeVisible();await expect(card).toContainText("Auto review denied this action");await expect(card).toContainText("Deleting this file needs explicit user approval.");await expect(card).toContainText("Risk assessment: high");
    await page.screenshot({path:auditDir+"chat-auto-review-denied-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"chat-auto-review-denied-light-1280x800.png",fullPage:true});
    await page.setViewportSize({width:1600,height:980});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    await card.getByRole("button",{name:"Allow anyway"}).click();await expect(card).toHaveCount(0);
    const approve=calls.find(call=>call.method==="thread/approveGuardianDeniedAction");expect(approve?.params).toEqual({
      threadId:thread.id,
      event:{id:"review-1",target_item_id:"cmd-1",turn_id:"turn-1",started_at_ms:startedAt,completed_at_ms:completedAt,status:"denied",risk_level:"high",user_authorization:"low",rationale:"Deleting this file needs explicit user approval.",decision_source:"agent",action:{type:"command",source:"unified_exec",command:"rm generated.tmp",cwd:process.cwd()}},
    });
    await expect(page.getByText("Auto review denial overridden by user")).toBeVisible();
    notificationSocket.send(JSON.stringify({method:"guardianWarning",params:{threadId:thread.id,message:"Auto review policy is running in degraded mode."}}));
    await expect(page.getByText("Auto review policy is running in degraded mode.",{exact:true})).toBeVisible();
    await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="light"});const bounds=await page.locator(".chat-workspace").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    await page.screenshot({path:auditDir+"chat-auto-review-override-light-1280x800.png",fullPage:true});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
