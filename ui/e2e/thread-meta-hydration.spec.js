import { test,expect } from "@playwright/test";

test("opening a catalog-only thread hydrates its full durable metadata on demand",async({page})=>{
  const now=Date.now()/1000,thread={
    id:"catalog-hydration-thread",name:"Hydrate saved thread",preview:"Catalog-only startup",cwd:process.cwd(),model:"claude-test",
    runtime:"claude",status:{type:"idle"},createdAt:now-30,updatedAt:now-5,turns:[],
  };
  const catalogMeta={
    __catalogOnly:true,
    runtime:"claude",runtimeInstanceId:"claude-default",provider:"claude",projectless:true,environmentId:null,
    threadSnapshot:{...thread,runtime:"claude",provider:"claude"},
  };
  let fullMeta={...catalogMeta,trebellQueue:[{id:"saved-followup",createdAt:Date.now()-1000,text:"Hydrated queued follow-up",attachments:[],contextChips:[]}]};
  let metadataReads=0;
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"freebuff",followUpMode:"queue",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};

  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    mock:true,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:false,wsUrl:"",
    cwd:process.cwd(),platform:process.platform,version:"thread-meta-hydration-fixture",runtimeCapabilities:{nativeQueue:false,steering:false},activeEnvironmentId:null,activeEnvironment:null,
  })}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[thread.id]:catalogMeta}})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})}));
  await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,async route=>{
    if(route.request().method()==="POST"){
      const body=route.request().postDataJSON?.()||JSON.parse(route.request().postData()||"{}");
      fullMeta={...fullMeta,...(body.patch||{})};
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(fullMeta)});
    }
    metadataReads++;
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(fullMeta)});
  });

  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Hydrate saved thread"]')});
  await expect(row).toBeVisible();
  await expect(page.locator(".queued-message")).toHaveCount(0);

  await row.locator(".thread-main").click();
  await expect.poll(()=>metadataReads).toBeGreaterThan(0);
  await expect(page.locator(".queued-message")).toContainText("Hydrated queued follow-up");
  await expect(row).toHaveClass(/active/);
});
