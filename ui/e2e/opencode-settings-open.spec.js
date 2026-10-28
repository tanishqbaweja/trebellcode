import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// Entering Settings' Agents & models or Diagnostics section lists the harnesses, and each read of OpenCode's own answer starts an
// `opencode serve` per OpenCode profile and takes seconds. A person going from one section to the other and back keeps the answer
// OpenCode gave, and Refresh reads OpenCode again. The harness list is the server's (AgentRuntimeManager's snapshot, as the listing
// route asks for it), with OpenCode's catalog read counted and stood in for (openCodeCatalogReader); only OpenCode's --version answers.
const shots=fileURLToPath(new URL("../../visual-audit/opencode-settings-open/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const catalog=({models=["anthropic/claude-x"]}={})=>({models,metadata:models.map(id=>({id,name:id,provider:"opencode",agent:"OpenCode"})),preferred:models[0]||null,connectedProviders:["anthropic"],inventory:{commands:[],skills:[],agents:[]},source:"live-connected"});
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}

test("going between Settings' Agents & models and Diagnostics keeps OpenCode's answer, and Refresh asks OpenCode again",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-opencode-settings-open-"));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"opencode-1.18.32"),serverUrl:null,environment:{}};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[instance]};
  const runFn=async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},runFn});
  const opencode={answer:catalog(),reads:0};
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
    const said=row.locator("button").first().locator("small"),action=row.locator("button").first().locator("em");
    await expect(said).toHaveText("1.18.32");await expect(action).toHaveText("Switch");
    expect(opencode.reads,"the first open reads OpenCode").toBe(1);
    // The person looks at Diagnostics, then comes back to Agents & models: each lists the harnesses, and OpenCode's answer is kept.
    asked=listings;await page.getByRole("button",{name:/Diagnostics/}).click();await listed(asked);
    asked=listings;await page.getByRole("button",{name:/Agents & models/}).click();await listed(asked);
    await expect(said).toHaveText("1.18.32");
    expect(opencode.reads,"going between the sections starts no opencode serve").toBe(1);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await expect(row).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`opencode-settings-reopened-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // OpenCode lists no models for the provider now; Refresh asks OpenCode again, and the row says so.
    opencode.answer=catalog({models:[]});
    asked=listings;await page.locator(".agent-runtime-settings").getByRole("button",{name:"Refresh",exact:true}).click();await listed(asked);
    await expect(said).toHaveText("1 upstream provider is connected through OpenCode, but it lists no models yet. Press Refresh to check again.");
    expect(opencode.reads,"Refresh reads OpenCode again").toBe(2);
  }finally{
    await request.post("/api/settings",{data:{agentRuntimeInstances:before.agentRuntimeInstances||[],appearanceMode:before.appearanceMode||"dark"}});
    rmSync(home,{recursive:true,force:true});
  }
});
