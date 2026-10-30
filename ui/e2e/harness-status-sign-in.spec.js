import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// Which harness rows and runtime profiles in Settings offer Sign in once a status check did not go as a quick, signed-in CLI's does.
// An answer that read a sign-in says what it read: a Codex whose --version ran out of time is answered by its account read, which
// says whether sign-in is required, so its row offers Sign in when it is and shows its version once it is signed in. An answer that
// read none (a Claude Code whose --version did not answer, or one with a custom API endpoint) says what was found and offers none,
// and the Profiles list under the active harness reads its profiles' answers the same way as the rows above it. The lists are the
// server's own reading of these answers (AgentRuntimeManager's snapshot, each CLI's answers stubbed, and Codex's app-server a script
// of the test's own).
const shots=fileURLToPath(new URL("../../visual-audit/polish/harness-status-sign-in/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const TIMED_OUT={ok:false,code:null,error:"probe timed out",stdout:"",stderr:""};
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
async function openHarnessSettings(page){
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
}
const harnessRow=(page,name)=>page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
const profileRow=(page,name)=>page.locator(".runtime-profile-row").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
const said=row=>row.locator("button").first().locator("small");
const action=row=>row.locator("button").first().locator("em");
const signIn=row=>row.getByRole("button",{name:"Sign in",exact:true});

test("Settings offers Sign in on a Codex whose --version ran out of time and whose account read needs a sign-in, and shows its version once it is signed in",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-status-sign-in-")),account=join(home,"signed-in.json"),windows=process.platform==="win32";
  // Codex's app-server as far as its status check goes: its version in initialize's user agent, and no account (OpenAI's sign-in
  // required) until signed-in.json holds one, as a `codex login` in the person's own terminal would.
  const fixture=join(home,"codex-app-server.mjs"),launcher=join(home,windows?"codex.cmd":"codex");
  writeFileSync(fixture,String.raw`
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";
const account=${JSON.stringify(account)};
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;
  const result=m.method==="initialize"?{userAgent:"codex_cli_rs/0.162.0 (fixture)"}:m.method==="account/read"?{account:existsSync(account)?JSON.parse(readFileSync(account,"utf8")):null,requiresOpenaiAuth:true}:{};
  process.stdout.write(JSON.stringify({id:m.id,result})+"\n");
});
`,"utf8");
  writeFileSync(launcher,windows?["@echo off",`"${process.execPath}" "${fixture}" %*`,""].join("\r\n"):`#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,{encoding:"utf8",mode:0o755});
  // Codex's --version runs out of its 6 s (a cold start); the other harnesses are not there.
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true,binaryPath:launcher,environment:{}}]};
  const runFn=async(command,args)=>command===launcher&&args[0]==="--version"?TIMED_OUT:missing(command);
  const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,TEMP:home,TMP:home,HOME:home,USERPROFILE:home,APPDATA:join(home,"AppData","Roaming"),LOCALAPPDATA:join(home,"AppData","Local"),CODEX_HOME:join(home,"codex-home"),TREBELL_HOME:join(home,"trebell")};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},env,runFn});
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  // Each listing (Settings' open and its Refresh) checks every harness again, as the server's does.
  await page.route(/\/api\/agent-runtimes$/,async route=>route.request().method()==="GET"?json(route,await manager.snapshot()):route.continue());
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await openHarnessSettings(page);
    const codex=harnessRow(page,"Codex");
    // Its account read found no sign-in: Not ready, why, and Sign in.
    await expect(said(codex)).toHaveText("Codex CLI is signed out. Sign in with codex login and try again.");
    await expect(action(codex)).toHaveText("Not ready");
    await expect(signIn(codex)).toBeVisible();
    await expect(signIn(codex)).toBeEnabled();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await codex.scrollIntoViewIfNeeded();await expect(codex).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`codex-sign-in-required-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // Signed in outside Trebell, then Refresh: its version and a switch, as for a Codex whose --version answered, and no Sign in.
    writeFileSync(account,JSON.stringify({type:"chatgpt",planType:"plus"}),"utf8");
    const listed=page.waitForResponse(response=>/\/api\/agent-runtimes$/.test(response.url())&&response.request().method()==="GET");
    await page.getByRole("button",{name:"Refresh",exact:true}).click();
    await listed;
    await expect(said(codex)).toHaveText("0.162.0");
    await expect(action(codex)).toHaveText("Switch");
    await expect(signIn(codex)).toHaveCount(0);
    await codex.evaluate(node=>node.scrollIntoView({block:"center"}));await expect(codex).toBeInViewport({ratio:1});
    await page.screenshot({animations:"disabled",path:shots+"codex-signed-in-dark-1280.png"});
  }finally{
    await request.post("/api/settings",{data:{agentRuntimeInstances:before.agentRuntimeInstances||[],appearanceMode:before.appearanceMode||"dark"}});
    rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

test("the Profiles list under the active Claude Code offers no Sign in for a profile whose check read no sign-in, and keeps it for one that is signed out",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-status-profiles-"));
  // Three Claude Code profiles: the active one runs through a gateway, where `claude auth status` finds no sign-in of its own; one's
  // --version runs out of its 20 s (a cold start); one is on Anthropic's own API and signed out. The other harnesses are not there.
  const profile=(id,displayName,environment={})=>{const binaryPath=join(home,id);writeFileSync(binaryPath,id);return {id,kind:"claude",displayName,enabled:true,binaryPath,environment}};
  const instances=[profile("claude-default","Gateway",{ANTHROPIC_BASE_URL:"https://gateway.example"}),profile("claude-slow","Slow start"),profile("claude-signed-out","Signed out")];
  const answers={"claude-slow":()=>TIMED_OUT};
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",agentRuntimeInstances:instances};
  const runFn=async(command,args)=>{
    const id=instances.find(item=>item.binaryPath===command)?.id;if(!id)return missing(command);
    if(args[0]==="--version")return answers[id]?.()||answered("2.1.311 (Claude Code)\n");
    return {ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""};
  };
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},runFn});
  const list=await manager.snapshot(),active=list.statuses.find(item=>item.id==="claude-default");
  // The app runs Claude Code with that profile: what it loads says so, and the light and dark toggle saves its setting in the page.
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,{...settings,...saved})});
  await page.route(/\/api\/state$/,route=>json(route,{settings:{...settings,...saved},projects:[],threadMeta:{}}));
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",agentRuntimeReady:true,agentRuntimeStatus:active,appServerReady:false,wsUrl:"",cwd:home,platform:process.platform,version:"status-sign-in-fixture",runtimeCapabilities:list.capabilities,activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/runtime$/,route=>json(route,{agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",agentRuntimeStatus:active,provider:"openai",providerReady:true,appServerReady:false,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]}));
  await page.route(/\/api\/models$/,route=>json(route,{agentRuntime:"claude",ready:true,models:["claude-fixture"],metadata:{agentRuntime:"claude",models:[{id:"claude-fixture",name:"Claude Fixture",agent:"Claude Code"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/agent-runtimes$/,route=>route.request().method()==="GET"?json(route,list):route.continue());
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await openHarnessSettings(page);
    const ENDPOINT="Claude Code is configured for a custom API endpoint; authentication will be verified when a session starts.";
    // The Claude Code row says what its active profile's check found, with no Sign in, as `claude auth login` has nothing to do with
    // the gateway's credentials.
    const claude=harnessRow(page,"Claude Code");
    await expect(said(claude)).toHaveText(ENDPOINT);
    await expect(action(claude)).toHaveText("Active");
    await expect(signIn(claude)).toHaveCount(0);
    // The profile rows below it say the same of each profile.
    const gateway=profileRow(page,"Gateway"),slow=profileRow(page,"Slow start"),signedOut=profileRow(page,"Signed out");
    await expect(said(gateway)).toHaveText(ENDPOINT);
    await expect(action(gateway)).toHaveText("Active");
    await expect(signIn(gateway)).toHaveCount(0);
    await expect(said(slow)).toHaveText("Claude Code is installed but did not answer claude --version within 20 seconds.");
    await expect(said(slow).locator("code.run-command"),"the command it ran reads as code").toHaveText("claude --version");
    await expect(action(slow)).toHaveText("Use");
    await expect(signIn(slow)).toHaveCount(0);
    // One whose `claude auth status` says it is signed out is offered Sign in, as before.
    await expect(said(signedOut)).toHaveText("Claude Code is signed out. Sign in with claude auth login and try again.");
    await expect(said(signedOut).locator("code.run-command"),"the command it names reads as code").toHaveText("claude auth login");
    await expect(signIn(signedOut)).toBeVisible();
    await expect(signIn(signedOut)).toBeEnabled();
    for(const [mode,width] of [["dark",1280],["light",1280],["light",760]]){
      await page.setViewportSize({width,height:1000});
      await switchMode(page,mode);
      await signedOut.scrollIntoViewIfNeeded();
      for(const row of [gateway,slow,signedOut])await expect(row).toBeInViewport();
      const sideways=await page.locator(".settings-page").evaluate(node=>node.scrollWidth-node.clientWidth);
      expect(sideways,"no sideways scroll").toBeLessThanOrEqual(1);
      await page.screenshot({animations:"disabled",path:shots+`claude-profiles-${mode}-${width}.png`});
    }
  }finally{
    rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
