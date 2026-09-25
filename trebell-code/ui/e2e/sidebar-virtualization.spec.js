import { test,expect } from "@playwright/test";

function catalogThreads(count,cwd){
  const now=Date.now()/1000,meta={};
  for(let index=0;index<count;index++){
    const id="sidebar-thread-"+String(index).padStart(4,"0"),name="Thread "+String(index).padStart(4,"0"),updatedAt=now-index;
    meta[id]={projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id,name,preview:"Saved task "+index,cwd,model:"freebuff/test/coding-fast",createdAt:updatedAt-100,updatedAt,status:{type:"idle"},runtime:"codex",provider:"freebuff"}};
  }
  return meta;
}

test("thousand-thread sidebar mounts bounded rows while search and active-thread navigation stay reachable",async({page})=>{
  test.setTimeout(30_000);
  const cwd=process.cwd(),threadMeta=catalogThreads(1000,cwd);
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,cwd,platform:process.platform,version:"sidebar-virtualization-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta}));
  await page.route(/\/api\/models$/,route=>json(route,{provider:"freebuff",agentRuntime:"codex",ready:true,models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",agentRuntime:"codex",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/freebuff\/overview/,route=>json(route,{}));
  await page.route(/\/api\/thread-meta$/,async route=>{
    const body=route.request().postDataJSON();threadMeta[body.threadId]={...(threadMeta[body.threadId]||{}),...(body.patch||{})};return json(route,threadMeta[body.threadId]);
  });
  await page.goto("/");

  const rows=page.locator(".thread-row"),chunks=page.locator("[data-sidebar-chunk]"),sections=page.locator(".thread-sections");
  await expect(chunks).toHaveCount(25);
  await expect.poll(()=>rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(180);
  await expect(page.locator('.thread-main[title="Thread 0000"]')).toBeVisible();

  const search=page.locator(".search-box input");
  await search.fill("Thread 0500");
  await expect(page.locator('.thread-main[title="Thread 0500"]')).toBeVisible();
  await page.locator('.thread-main[title="Thread 0500"]').click();
  await search.fill("");
  const active=page.locator('.thread-row.active[data-thread-id="sidebar-thread-0500"]');
  await expect(active).toBeVisible({timeout:5000});
  expect(await rows.count()).toBeLessThan(180);

  await sections.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event("scroll",{bubbles:true}))});
  await expect.poll(async()=>await chunks.last().getAttribute("class")).toContain("mounted");
  await expect(page.locator('.thread-main[title="Thread 0999"]')).toBeVisible({timeout:5000});
  expect(await rows.count()).toBeLessThan(180);

  await page.screenshot({path:"visual-audit/thousand-thread-sidebar-dark-1280x800.png",fullPage:true});
});
