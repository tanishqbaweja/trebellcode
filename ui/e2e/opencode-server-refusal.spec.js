import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// What Settings shows for an OpenCode profile whose own server (its server URL) refuses Trebell, with that server answering as the real
// ones answer a wrong or missing password: OpenCode 1.18.32 with an empty 401 on every path, OpenCode 2
// with {"_tag":"UnauthorizedError","message":"Authentication required"}. Settings read those as "could not list its providers:
// provider list failed" and "...: Authentication required". The harness list is the server's (AgentRuntimeManager's snapshot), read
// through OpenCode's real discovery; only the profile's --version is answered here.
const shots=fileURLToPath(new URL("../../visual-audit/polish/opencode-server-refusal/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const REFUSED_1="The configured OpenCode server asks for a password, which Trebell Code sends only to an OpenCode 1.x server it starts itself. Check this profile's server URL, or leave it empty so Trebell Code starts OpenCode itself.";
const REFUSED_2="The configured OpenCode server rejected the password. Check this profile's server URL and the OPENCODE_SERVER_PASSWORD in its environment.";
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}

test("Settings says when an OpenCode profile's own server refuses Trebell, from the empty 401 of OpenCode 1.x and the UnauthorizedError of OpenCode 2",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  const refusing=createServer((req,res)=>{
    if(req.url.startsWith("/api/")){res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({_tag:"UnauthorizedError",message:"Authentication required"}));return}
    res.writeHead(401);res.end();
  });
  await new Promise(resolve=>refusing.listen(0,"127.0.0.1",resolve));
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-opencode-refusal-"));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"opencode"),serverUrl:`http://127.0.0.1:${refusing.address().port}`,environment:{}};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[instance]};
  let version="1.18.32";
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},
    runFn:async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:version+"\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}});
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  let listings=0;
  await page.route(/\/api\/agent-runtimes$/,async route=>{if(route.request().method()!=="GET")return route.continue();listings++;return json(route,await manager.snapshot({refresh:true,keepOpenCode:route.request().headers()["x-trebell-catalogs"]==="kept"}))});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
    const row=page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:/^OpenCode$/})});
    const said=row.locator("button").first().locator("small"),action=row.locator("button").first().locator("em");
    // OpenCode 1.18.32 refuses every request with an empty 401; Trebell sends no password to a 1.x server it did not start.
    await expect(said).toHaveText(REFUSED_1,{timeout:20_000});await expect(action).toHaveText("Not ready");
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await expect(row).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`opencode1-server-refused-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // The profile's OpenCode is 2.x now, whose server refuses with OpenCode 2's UnauthorizedError; the person presses Refresh.
    version="2.0.24";
    const asked=listings;await page.locator(".agent-runtime-settings").getByRole("button",{name:"Refresh",exact:true}).click();await expect.poll(()=>listings).toBeGreaterThan(asked);
    await expect(said).toHaveText(REFUSED_2,{timeout:20_000});await expect(action).toHaveText("Not ready");
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await expect(row).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`opencode2-server-refused-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
  }finally{
    await request.post("/api/settings",{data:{agentRuntimeInstances:before.agentRuntimeInstances||[],appearanceMode:before.appearanceMode||"dark"}});
    await new Promise(resolve=>{refusing.closeAllConnections?.();refusing.close(resolve)});
    rmSync(home,{recursive:true,force:true});
  }
});
