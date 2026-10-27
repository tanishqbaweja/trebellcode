import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// What Settings shows for harnesses whose status checks do not answer as a quick, signed-in CLI does. The harness list is the one
// the server's own status checks give (AgentRuntimeManager's snapshot, run here with each CLI's answers stubbed, as the server's
// harness runner is in offline E2E), so it is the server's reading of these answers the page shows:
// - Claude Code answers --version after 8 s (a cold Windows start) and runs through a gateway, where `claude auth status` finds no
//   sign-in of its own;
// - OpenCode's --version never answers, so it is installed but not ready (its version picks the client Trebell talks to it with);
//   Cursor's exits with an error;
// - Grok prints its logged-out line once, as it does for an access token it then refreshes;
// - Codex is not there.
// A check that did not answer, and a gateway, say nothing of a sign-in, so those rows show what was found and offer no Sign in.
const shots=fileURLToPath(new URL("../../visual-audit/polish/harness-status-checks/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const TIMED_OUT={ok:false,code:null,error:"probe timed out",stdout:"",stderr:""};
function harnessList(home){
  const grokModels=["You are not authenticated.\n","You are logged in with grok.com.\n"];
  const answer=(kind,args,timeoutMs)=>{
    if(kind==="claude")return args[0]==="--version"?(8000<=timeoutMs?answered("2.1.310 (Claude Code)\n"):TIMED_OUT):{ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""};
    if(kind==="opencode")return TIMED_OUT;
    if(kind==="cursor")return {ok:false,code:1,error:null,stdout:"",stderr:"Error: Cannot find module 'index.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1207:15)\n"};
    if(kind==="grok")return args[0]==="models"?answered(grokModels.shift()||"You are logged in with grok.com.\n"):answered("grok 1.0.41 (4220f3b224a6)\n");
    return {ok:false,code:null,error:"spawn codex ENOENT",stdout:"",stderr:""};
  };
  const instances=["codex","claude","cursor","grok","opencode"].map(kind=>{
    const binaryPath=join(home,kind);writeFileSync(binaryPath,kind);
    return {id:kind+"-default",kind,displayName:kind,enabled:true,binaryPath,environment:kind==="claude"?{ANTHROPIC_BASE_URL:"https://gateway.example"}:{}};
  });
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:instances};
  const runFn=async(command,args,{timeoutMs})=>answer(instances.find(item=>item.binaryPath===command)?.kind,args,timeoutMs);
  return new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},runFn}).snapshot();
}
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}

test("Settings shows a slow, hung or failing harness CLI as installed with what its check did and no Sign in, a gateway profile as one, and Grok signed in after its token refresh",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-status-checks-"));
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  const list=await harnessList(home);
  await page.route(/\/api\/agent-runtimes$/,route=>route.request().method()==="GET"?json(route,list):route.continue());
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
    const row=name=>page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
    const said=name=>row(name).locator("button").first().locator("small");
    const action=name=>row(name).locator("button").first().locator("em");
    const signIn=name=>row(name).getByRole("button",{name:"Sign in",exact:true});
    // Claude Code answered once it had time, and runs through a gateway: the row says so and offers a switch, and no Sign in, as
    // `claude auth login` has nothing to do with the gateway's credentials. It is installed, so Update, not Install.
    await expect(said("Claude Code")).toHaveText("Claude Code is configured for a custom API endpoint; authentication will be verified when a session starts.");
    await expect(action("Claude Code")).toHaveText("Switch");
    await expect(row("Claude Code").getByRole("button",{name:"Update",exact:true})).toBeVisible();
    await expect(row("Claude Code").getByRole("button",{name:"Install",exact:true})).toHaveCount(0);
    await expect(signIn("Claude Code")).toHaveCount(0);
    // Cursor's check exited with an error: what it said, and a switch, with neither Needs setup nor Sign in, as nothing is known of
    // its sign-in.
    await expect(said("Cursor")).toHaveText("Cursor is installed but `cursor-agent --version` exited with code 1: Error: Cannot find module 'index.js'");
    await expect(action("Cursor")).toHaveText("Switch");
    await expect(signIn("Cursor")).toHaveCount(0);
    // OpenCode's never answered: installed, never "not installed", but not ready until its version picks its client; Update, no
    // Sign in.
    await expect(said("OpenCode")).toHaveText("OpenCode is installed but did not answer `opencode --version` within 10 seconds. Trebell Code needs its version (1.x or 2.x) to start it.");
    await expect(action("OpenCode")).toHaveText("Not ready");
    await expect(row("OpenCode").getByRole("button",{name:"Update",exact:true})).toBeVisible();
    await expect(signIn("OpenCode")).toHaveCount(0);
    // Grok: its second `grok models` read the refreshed sign-in.
    await expect(said("Grok Build")).toHaveText("grok 1.0.41 (4220f3b224a6)");
    await expect(action("Grok Build")).toHaveText("Switch");
    await expect(row("Grok Build").getByRole("button",{name:"Sign in",exact:true})).toHaveCount(0);
    // Only a CLI that is not there reads not installed.
    await expect(action("Codex")).toHaveText("Not installed");
    await expect(row("Codex").getByRole("button",{name:"Install",exact:true})).toBeVisible();
    await page.setViewportSize({width:1280,height:900});
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await row("OpenCode").scrollIntoViewIfNeeded();
      for(const name of ["Codex","Claude Code","Cursor","Grok Build","OpenCode"])await expect(row(name)).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`harness-rows-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
  }finally{
    await request.post("/api/settings",{data:{agentRuntimeInstances:before.agentRuntimeInstances||[],appearanceMode:before.appearanceMode||"dark"}});
    rmSync(home,{recursive:true,force:true});
  }
});
