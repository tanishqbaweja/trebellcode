import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// What Settings shows for OpenCode as its own answer changes: the harness list is the server's (AgentRuntimeManager's snapshot, which
// Settings' listing and Refresh ask for), with OpenCode's catalog read stood in for (openCodeCatalogReader) and every CLI's --version
// answered here: only OpenCode's is there. OpenCode first has no provider connected; the person connects one with OpenCode's own sign-in
// and presses Refresh; then OpenCode lists no models for the provider it has; then the profile points at a server of its own that
// refuses the password.
const shots=fileURLToPath(new URL("../../visual-audit/polish/opencode-readiness/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const catalog=({connected=["anthropic"],models=["anthropic/claude-x"]}={})=>({models,metadata:models.map(id=>({id,name:id,provider:"opencode",agent:"OpenCode"})),preferred:models[0]||null,connectedProviders:connected,inventory:{commands:[],skills:[],agents:[]},source:"live-connected"});
function harness(home){
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"opencode-1.18.32"),serverUrl:null,environment:{}};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[instance]};
  const runFn=async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},runFn});
  const opencode={answer:catalog({connected:[],models:["anthropic/claude-x","openai/gpt"]}),reads:0};
  manager.openCodeCatalogReader=async()=>{opencode.reads++;if(opencode.answer instanceof Error)throw opencode.answer;return structuredClone(opencode.answer)};
  return {manager,instance,opencode};
}
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}

test("Settings shows OpenCode connected after a provider sign-in and Refresh, not ready while it lists no models, and a server that refuses its password as such",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-opencode-readiness-")),{manager,instance,opencode}=harness(home);
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  let listings=0;
  await page.route(/\/api\/agent-runtimes$/,async route=>{if(route.request().method()!=="GET")return route.continue();listings++;return json(route,await manager.snapshot({refresh:true}))});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
    const row=page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:/^OpenCode$/})});
    const said=row.locator("button").first().locator("small"),action=row.locator("button").first().locator("em");
    const refresh=async()=>{const asked=listings;await page.locator(".agent-runtime-settings").getByRole("button",{name:"Refresh",exact:true}).click();await expect.poll(()=>listings).toBeGreaterThan(asked)};
    // No provider connected yet: OpenCode runs, and Settings offers its sign-in.
    await expect(said).toHaveText("OpenCode is available, but it did not report any connected upstream providers.");
    await expect(action).toHaveText("Needs setup");await expect(row.getByRole("button",{name:"Sign in",exact:true})).toBeVisible();
    // The person connects a provider with OpenCode's own sign-in, then presses Refresh: Settings reads OpenCode again.
    opencode.answer=catalog();
    const reads=opencode.reads;await refresh();
    await expect(said).toHaveText("1.18.32");await expect(action).toHaveText("Switch");
    await expect(row.getByRole("button",{name:"Sign in",exact:true})).toHaveCount(0);
    expect(opencode.reads).toBeGreaterThan(reads);
    // OpenCode has the provider but lists no models for it: not ready over an empty model list, and the row says why.
    opencode.answer=catalog({models:[]});await refresh();
    await expect(said).toHaveText("1 upstream provider is connected through OpenCode, but it lists no models yet. Press Refresh to check again.");
    await expect(action).toHaveText("Needs setup");
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await expect(row).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`opencode-no-models-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // The profile runs on a server of its own, which asks for a password: Trebell sends none to an OpenCode 1.x server it did not start.
    instance.serverUrl="http://127.0.0.1:4010";opencode.answer=new Error("Unauthorized");await refresh();
    await expect(said).toHaveText("The configured OpenCode server asks for a password, which Trebell Code sends only to an OpenCode 1.x server it starts itself. Check this profile's server URL, or start that server without OPENCODE_SERVER_PASSWORD.");
    await expect(action).toHaveText("Not ready");
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await expect(row).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`opencode-server-refused-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
  }finally{
    await request.post("/api/settings",{data:{agentRuntimeInstances:before.agentRuntimeInstances||[],appearanceMode:before.appearanceMode||"dark"}});
    rmSync(home,{recursive:true,force:true});
  }
});
