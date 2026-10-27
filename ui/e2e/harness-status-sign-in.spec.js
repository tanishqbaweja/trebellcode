import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// Which harness rows in Settings offer Sign in once a status check did not go as a quick, signed-in CLI's does. An answer that read a
// sign-in says what it read: a Codex whose --version ran out of time is answered by its account read, which says whether sign-in is
// required, so its row offers Sign in when it is and shows its version once it is signed in. The list is the server's own reading of
// these answers (AgentRuntimeManager's snapshot, each CLI's answers stubbed, and Codex's app-server a script of the test's own).
const shots=fileURLToPath(new URL("../../visual-audit/polish/harness-status-sign-in/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
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
    await expect(said(codex)).toHaveText("Codex CLI is not authenticated. Run codex login and try again.");
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
