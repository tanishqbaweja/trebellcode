import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// Each read of OpenCode's own answer starts an `opencode serve` per OpenCode profile, so Settings keeps the last one while a person goes
// between its sections. It kept a complete one with no age limit: a person who came back to Settings an hour later, after OpenCode's
// providers changed (a sign-out in a terminal), still saw the answer from an hour before until they pressed Refresh. Now entering a
// section reads an answer older than ten seconds again. The harness list is the server's (AgentRuntimeManager's snapshot, as the
// listing route asks for it), with OpenCode's catalog read counted and stood in for (openCodeCatalogReader) and the manager's clock
// moved on by the test; only OpenCode's --version answers.
const shots=fileURLToPath(new URL("../../visual-audit/opencode-catalog-age/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const catalog=connected=>({models:connected.map(id=>`${id}/model`),metadata:connected.map(id=>({id:`${id}/model`,name:id,provider:"opencode",agent:"OpenCode"})),preferred:connected.length?`${connected[0]}/model`:null,connectedProviders:connected,inventory:{commands:[],skills:[],agents:[]},source:"live-connected"});
const NONE="OpenCode runs, but no upstream provider is connected through it.";
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}

test("Settings reads OpenCode's answer again when a person comes back to its sections an hour later, instead of showing the old one",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-opencode-catalog-age-"));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"opencode-1.18.32"),serverUrl:null,environment:{}};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[instance]};
  const runFn=async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""};
  let clock=Date.now();
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},runFn,now:()=>clock});
  const opencode={answer:catalog(["anthropic"]),reads:0};
  manager.openCodeCatalogReader=async()=>{opencode.reads++;return structuredClone(opencode.answer)};
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  // The listing route as the server answers it: a section's open asks with x-trebell-catalogs: kept.
  let listings=0;
  await page.route(/\/api\/agent-runtimes$/,async route=>{
    if(route.request().method()!=="GET")return route.continue();
    listings++;return json(route,await manager.snapshot({refresh:true,keepOpenCode:route.request().headers()["x-trebell-catalogs"]==="kept"}));
  });
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    const listed=async asked=>expect.poll(()=>listings).toBeGreaterThan(asked);
    let asked=listings;await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();await listed(asked);
    const row=page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:/^OpenCode$/})});
    const said=row.locator("button").first().locator("small");
    await expect(said).toHaveText("1.18.32");
    expect(opencode.reads).toBe(1);
    // An hour on, OpenCode no longer reports the provider (the person signed out of it in a terminal).
    opencode.answer=catalog([]);clock+=60*60_000;
    asked=listings;await page.getByRole("button",{name:/Diagnostics/}).click();await listed(asked);
    asked=listings;await page.getByRole("button",{name:/Agents & models/}).click();await listed(asked);
    await expect(said,"Settings shows what OpenCode says now").toHaveText(NONE);
    expect(opencode.reads,"the hour-old answer is read again once, not on every section").toBe(2);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await expect(row).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`opencode-catalog-age-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
  }finally{
    await request.post("/api/settings",{data:{agentRuntimeInstances:before.agentRuntimeInstances||[],appearanceMode:before.appearanceMode||"dark"}});
    rmSync(home,{recursive:true,force:true});
  }
});
