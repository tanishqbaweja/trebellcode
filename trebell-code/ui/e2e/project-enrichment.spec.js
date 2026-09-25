import { test,expect } from "@playwright/test";

function projects(count){
  return Array.from({length:count},(_,index)=>({
    id:"project-"+String(index).padStart(3,"0"),
    name:"Project "+String(index).padStart(3,"0"),
    path:"C:/repos/project-"+String(index).padStart(3,"0"),
    environmentId:null,
    environment:{id:"local",name:"Local machine",type:"local"},
    scripts:[],
    lastOpenedAt:Date.now()-index*1000,
  }));
}

test("large project lists paint before bounded enrichment finishes",async({page})=>{
  test.setTimeout(30_000);
  const items=projects(120);let projectLoads=0,activeEnrichment=0,maxActiveEnrichment=0,completedEnrichment=0;
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,cwd:"C:/empty",platform:"win32",version:"project-enrichment-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/models$/,route=>json(route,{provider:"freebuff",agentRuntime:"codex",ready:true,models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",agentRuntime:"codex",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>{projectLoads++;return json(route,{projects:projectLoads===1?[]:items})});
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/freebuff\/overview/,route=>json(route,{}));
  const enrich=async(route,value)=>{
    activeEnrichment++;maxActiveEnrichment=Math.max(maxActiveEnrichment,activeEnrichment);
    await new Promise(resolve=>setTimeout(resolve,80));
    activeEnrichment--;completedEnrichment++;return json(route,value);
  };
  await page.route(/\/api\/git\/info\?/,route=>{
    const path=new URL(route.request().url()).searchParams.get("path");
    if(!String(path||"").startsWith("C:/repos/project-"))return json(route,{isGit:false,root:path,branch:null,remotes:[]});
    return enrich(route,{isGit:true,root:path,branch:"main",remotes:[{name:"origin",kind:"fetch",url:"https://example.test/shared.git"}]});
  });
  await page.route(/\/api\/project-actions\/suggestions\?/,route=>enrich(route,{scripts:[{name:"Test",command:"npm test"}],t3:{present:false},packageManager:"npm"}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.locator(".project-card .project-open").filter({hasText:"Project 000"}).first()).toBeVisible({timeout:1500});
  expect(completedEnrichment).toBeLessThan(240);
  await expect(page.locator(".project-card")).toHaveCount(24);
  await expect.poll(()=>completedEnrichment,{timeout:10_000}).toBe(240);
  expect(maxActiveEnrichment).toBeLessThanOrEqual(12);
  expect(projectLoads).toBe(2);
  await expect(page.locator(".project-card .project-open small").filter({hasText:"main"}).first()).toBeVisible();
  await expect(page.locator(".project-group-head").first()).toContainText("120 checkouts");
  const search=page.getByRole("textbox",{name:"Search projects"});
  await search.fill("Project 099");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await expect(page.locator(".project-card .project-open").filter({hasText:"Project 099"})).toBeVisible();
  await search.fill("");
  await expect(page.locator(".project-card")).toHaveCount(24);
  await page.getByRole("button",{name:"Show 24 more"}).click();
  await expect(page.locator(".project-card")).toHaveCount(48);
  await page.locator(".secondary-page").evaluate(node=>{node.scrollTop=0});
  await page.screenshot({path:"visual-audit/projects-bounded-enrichment-dark-1280x800.png"});
});
