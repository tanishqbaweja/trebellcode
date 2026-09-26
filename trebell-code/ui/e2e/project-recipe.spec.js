import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("project recipe slash command starts a bounded turn with stricter permissions",async({page})=>{
  test.setTimeout(30_000);await page.setViewportSize({width:1280,height:800});
  const cwd=process.cwd(),calls=[];
  const recipe={id:"recipe-fix-ci",name:"/fix-ci",title:"Fix CI",description:"Repair the failing CI workflow.",objective:"Fix the failing CI job.",permission:"workspace-write",allowedTools:["repo"],expectedArtifacts:["Green CI"],validation:["Run affected tests"],context:"Avoid unrelated refactors.",model:null,runtime:null,maxChildren:0};
  const project={id:"recipe-project",name:"Recipe fixture",path:cwd,environmentId:null,recipes:[recipe],scripts:[],effectiveSettings:{}};
  const nativeProject={id:"native-recipe-project",name:project.name,roots:[{path:cwd}],metadata:{trebellManaged:"true",trebellProjectId:project.id},position:0,createdAt:1,updatedAt:1,recencyAt:null};
  const thread={id:"recipe-thread",name:"Recipe thread",preview:"Run a project recipe",historyMode:"paginated",projectId:nativeProject.id,cwd,model:"freebuff/test/coding-fast",status:{type:"idle"},createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const meta={[thread.id]:{cwd,projectless:false,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default"}};

  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;calls.push(message);let result={};
    if(message.method==="initialize")result={userAgent:"project-recipe-fixture"};
    else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
    else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
    else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/goal/set")result={goal:{threadId:thread.id,...message.params,createdAt:Date.now(),updatedAt:Date.now(),childAgentsUsed:0,childAgentTelemetryComplete:true}};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="project/list")result={data:[nativeProject],nextCursor:null};
    else if(message.method==="turn/start")result={turn:{id:"recipe-turn",status:"inProgress",items:[]}};
    else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/rpc",cwd,platform:process.platform,version:"project-recipe-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",activeProjectId:project.id,defaultPermissionMode:"full",defaultWorkspaceMode:"current"},projects:[project],threadMeta:meta})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:[thread.model],metadata:{provider:"freebuff",models:[{id:thread.model,name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="GET"?{projects:[project]}:{project})}));
    await page.route(/\/api\/thread-meta(?:\?|$)/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[thread.id])}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/freebuff\/overview/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({})}));
    await page.route(/\/api\/checkpoints(?:\/link)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().url().endsWith("/link")?{checkpoint:{id:"recipe-checkpoint",turnId:"recipe-turn"}}:{id:"recipe-checkpoint",threadId:thread.id})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({injection:"RECIPE_REPO_CONTEXT",items:[],tokenEstimate:3})}));
    await page.route(/\/api\/project-recipe\/resolve$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({execution:{
      recipe,turnInput:"Fix the failing CI job.\n\nUser input for this recipe:\nLinux runner only",
      context:"Trebell project recipe /fix-ci\n\nObjective:\nFix the failing CI job.\n\nEnforced allowed tools (namespace, namespace/tool, or namespace/*):\n- repo\n\nValidation expectations:\n- Run affected tests\n\nDelegation limit: 0 child agents.\n\nCurrent Trebell permission profile: edits. The recipe does not silently elevate it.",
      goalPatch:{objective:"Fix the failing CI job. — Linux runner only",status:"active",completionConditions:["Green CI"],constraints:[],validationExpectations:["Run affected tests"],childAgentBudget:0},
      toolAllowlist:["repo"],permissionMode:"edits",model:null,runtime:"codex",
    }})}));

    await page.goto("/");await page.locator(".thread-main",{hasText:"Recipe thread"}).click();
    const composer=page.getByTestId("composer");await composer.fill("/fi");
    const recipeButton=page.locator(".slash-menu button").filter({hasText:"/fix-ci"});await expect(recipeButton).toBeVisible();
    await expect(recipeButton).toContainText("Repair the failing CI workflow.");
    await page.screenshot({path:auditDir+"project-recipe-slash-menu-dark-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"project-recipe-slash-menu-light-1280x800.png",fullPage:true});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});

    await composer.fill("/fix-ci Linux runner only");await page.getByTestId("send").click();
    await expect.poll(()=>calls.filter(call=>call.method==="thread/goal/set").length).toBe(1);
    await expect.poll(()=>calls.filter(call=>call.method==="turn/start").length).toBe(1);
    const goalCall=calls.find(call=>call.method==="thread/goal/set"),turnCall=calls.find(call=>call.method==="turn/start");
    expect(goalCall.params.childAgentBudget).toBe(0);expect(goalCall.params.validationExpectations).toEqual(["Run affected tests"]);expect(goalCall.params.completionConditions).toEqual(["Green CI"]);
    expect(turnCall.params.approvalPolicy).toBe("on-request");expect(turnCall.params.sandboxPolicy.type).toBe("workspaceWrite");
    expect(turnCall.params.toolAllowlist).toEqual(["repo"]);
    expect(turnCall.params.additionalContext["trebell.recipe"].value).toContain("Delegation limit: 0 child agents");
    expect(turnCall.params.additionalContext["trebell.repo_evidence"]).toEqual({kind:"untrusted",value:"RECIPE_REPO_CONTEXT"});
    expect(turnCall.params.input[0].text).toContain("Linux runner only");
    await expect(page.locator("select.permission-picker")).toHaveValue("edits");
    await expect(page.getByText("Fix the failing CI job.",{exact:false}).first()).toBeVisible();
    await page.screenshot({path:auditDir+"project-recipe-running-dark-1280x800.png",fullPage:true});
  }finally{for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}
});
