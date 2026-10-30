import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { fakeMetaMuse } from "../../tests/fixtures/muse/fake-muse-launcher.mjs";

// What Settings offers for a newer Muse Code release, read as the server reads it: the harness list and the update are
// AgentRuntimeManager's own (its snapshot and install), over a Muse Code laid out as Meta's installer leaves it in
// %LOCALAPPDATA%\Programs\muse: Meta's own muse.cmd, run through cmd.exe and Windows PowerShell as Meta's is, beside a stand-in for
// Meta's launcher that updates as Meta's does (tests/fixtures/muse/fake-muse-launcher.mjs), and a stand-in for Meta's channel
// manifest naming a newer release:
// - Update shows, asks first naming the release and the launcher's own synchronous update it runs; a launcher whose update leaves
//   the version where it was is said as a failure, and the next one goes through: the row says it is ready, with no Update left;
// - a Muse Code that Meta's launcher does not run offers no Update, but says the release, the file it runs and to update it the way
//   it was installed.
// Nothing of Meta's runs, and no Muse Code on this machine is touched.
const shots=fileURLToPath(new URL("../../visual-audit/polish/muse-updates/",import.meta.url));mkdirSync(shots,{recursive:true});
const FAKE_MUSE=fileURLToPath(new URL("../../tests/fixtures/muse/fake-muse.cjs",import.meta.url));
const MODEL_LIST=fileURLToPath(new URL("../../tests/fixtures/muse/model-list-1.4.13.json",import.meta.url));
const STABLE="https://api.meta.ai/muse-code/channels/muse-stable";
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
// The CLI runs of the manager, made as its own runner makes them for the files in runnable only: any other harness is not there.
function runOnly(runnable,calls){
  return (command,args=[],{env={},cwd,timeoutMs=6000}={})=>new Promise(resolve=>{
    calls.push({command,args:[...args],sync:env.MUSE_SYNC_UPDATE==="1"});
    if(!runnable.has(command))return resolve({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
    const child=spawn(command,args,{env,cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    const timer=setTimeout(()=>child.kill(),timeoutMs);
    child.once("error",error=>{clearTimeout(timer);resolve({ok:false,code:null,error:error.message,stdout,stderr})});
    child.once("close",code=>{clearTimeout(timer);resolve({ok:code===0,code,error:null,stdout,stderr})});
  });
}
// A machine of the test's own under root with Meta's Muse Code at 1.4.13-R6996.1 and a muse-stable channel naming 1.4.14-R7010.1.
async function machine(root,{binaryPath=null}={}){
  const folder=join(root,"AppData","Local","Programs","muse"),launcher=await fakeMetaMuse(folder);
  const env={USERPROFILE:join(root,"home"),HOME:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),LOCALAPPDATA:join(root,"AppData","Local"),PATH:"",PATHEXT:".COM;.EXE;.BAT;.CMD",SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,TEMP:root,TMP:root,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"home",".codex")};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath,environment:{MUSE_FAKE_MODELS:MODEL_LIST}}]};
  const calls=[],fetched=[],runnable=new Set([launcher,...(binaryPath?[binaryPath]:[])]);
  const fetchImpl=async url=>{fetched.push(String(url));return String(url)===STABLE?Response.json({channel:"muse-stable",version:"1.4.14-R7010.1"}):new Response("{}",{status:404})};
  const manager=new AgentRuntimeManager({state:{settings:()=>({...settings}),updateSettings:patch=>Object.assign(settings,patch)},env,platform:"win32",runFn:runOnly(runnable,calls),fetchImpl});
  return {folder,launcher,manager,calls,fetched,updates:()=>{try{return readFileSync(join(folder,"updates.log"),"utf8").split(/\r?\n/).filter(Boolean)}catch{return []}}};
}
// The harness list Settings asks for is the manager's own listing; an Update press is its install, answered as the server answers it.
async function serve(page,manager,pressed=[]){
  await page.route(/\/api\/agent-runtimes$/,async route=>{
    const method=route.request().method(),body=method==="POST"?route.request().postDataJSON()||{}:{};
    if(method==="GET")return json(route,await manager.snapshot({refresh:true}));
    if(body.action!=="install")return route.continue();
    pressed.push(body);
    try{const installed=await manager.install(body.runtime,{id:body.id,instanceId:body.instanceId});return json(route,{installed,...await manager.snapshot()})}
    catch(error){return json(route,{error:error.message},400)}
  });
}
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
async function openHarnesses(page){
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
}
const harnessRow=(page,name)=>page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
async function shootRow(page,name){
  for(const mode of ["dark","light"]){
    await switchMode(page,mode);
    await harnessRow(page,"Muse Code").scrollIntoViewIfNeeded();await expect(harnessRow(page,"Muse Code")).toBeInViewport();
    await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-1280.png`});
  }
  await switchMode(page,"dark");
}
async function settled(page,request){
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  await page.setViewportSize({width:1280,height:900});
  return ()=>request.post("/api/settings",{data:{appearanceMode:before.appearanceMode||"dark"}});
}

test.skip(process.platform!=="win32","lays out Meta's Windows install of Muse Code and runs it through Windows PowerShell");

test("Update shows for a newer Muse Code release when Meta's launcher runs it, runs the launcher's own synchronous update and says when the version did not move",async({page,request})=>{
  test.setTimeout(150_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-muse-updates-")),restore=await settled(page,request);
  try{
    const fx=await machine(root),pressed=[];await serve(page,fx.manager,pressed);
    await openHarnesses(page);
    const row=harnessRow(page,"Muse Code"),update=row.getByRole("button",{name:"Update",exact:true});
    await expect(row.locator("button").first().locator("small")).toHaveText("1.4.13-R6996.1",{timeout:30_000});
    await expect(update).toBeVisible();await expect(row.locator("p.agent-runtime-option-note:not([role])")).toHaveCount(0);
    await shootRow(page,"offered");
    // Update asks first, naming the release and the launcher's own update it runs.
    const question=page.locator("dialog.inspector-text-prompt"),command=`${fx.launcher} --version (with MUSE_NO_AUTO_UPDATE=0, MUSE_SYNC_UPDATE=1 and MUSE_UPDATE_INTERVAL_SECONDS=0)`;
    await update.click();
    await expect(question.locator("p")).toContainText("Update Muse Code to 1.4.14-R7010.1 in the selected environment?");
    await expect(question.locator("p")).toContainText("Trebell will run: "+command);
    await expect(question.getByRole("button")).toHaveText(["Cancel","Update Muse Code"]);
    await page.screenshot({animations:"disabled",path:shots+"question-dark-1280.png"});
    await question.getByRole("button",{name:"Update Muse Code",exact:true}).click();
    // The launcher's channel read had nothing newer for it this time (it lags the manifest): the version stayed, and the row says so.
    const said=row.getByRole("alert");
    await expect(said).toHaveText(`Could not update Muse Code: muse.cmd --version finished, but the Muse Code this profile runs (${fx.launcher}) still reports 1.4.13-R6996.1.`,{timeout:60_000});
    await expect(said.locator("code")).toHaveText("muse.cmd --version");
    await expect(update).toBeEnabled();
    await shootRow(page,"unchanged");
    // Now the launcher finds the release. From the keyboard this time: Enter on Update, Tab from Cancel to Update Muse Code, Enter.
    writeFileSync(join(fx.folder,"release-muse-stable.txt"),"1.4.14-R7010.1\n");
    await update.focus();await page.keyboard.press("Enter");
    await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Update Muse Code",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row.getByRole("status")).toHaveText("Muse Code installed and ready.",{timeout:60_000});
    await expect(row.locator("button").first().locator("small")).toHaveText("1.4.14-R7010.1");
    await expect(update).toHaveCount(0);
    await shootRow(page,"updated");
    // Each press was for the row's own profile, and each ran Meta's launcher once with its synchronous update on.
    expect(pressed.map(body=>[body.runtime,body.instanceId])).toEqual([["muse","muse-default"],["muse","muse-default"]]);
    expect(fx.calls.filter(call=>call.sync).map(call=>[call.command,...call.args])).toEqual([[fx.launcher,"--version"],[fx.launcher,"--version"]]);
    expect(fx.updates()).toEqual(["muse-stable interval=0","muse-stable interval=0"]);
    expect(fx.fetched.every(url=>url===STABLE)).toBe(true);
  }finally{
    await restore();
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

test("a Muse Code that Meta's launcher does not run offers no Update, and says the release, the file Trebell runs and to update it the way it was installed",async({page,request})=>{
  test.setTimeout(90_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-muse-updates-manual-")),restore=await settled(page,request);
  try{
    // The profile runs a wrapper of its own instead of Meta's muse.cmd.
    const wrapper=join(root,"tools","muse","muse.cmd");mkdirSync(dirname(wrapper),{recursive:true});
    writeFileSync(wrapper,`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    const fx=await machine(root,{binaryPath:wrapper}),pressed=[];await serve(page,fx.manager,pressed);
    await openHarnesses(page);
    const row=harnessRow(page,"Muse Code");
    await expect(row.locator("p.agent-runtime-option-note:not([role])")).toHaveText(`Muse Code 1.4.14-R7010.1 is available. This profile runs ${realpathSync.native(wrapper)}, and Trebell Code cannot tell what installed it: update it the way you installed it.`,{timeout:30_000});
    await expect(row.getByRole("button",{name:"Update",exact:true})).toHaveCount(0);
    await expect(row.getByRole("button",{name:"Install",exact:true})).toHaveCount(0);
    await shootRow(page,"manual");
    expect(pressed).toEqual([]);expect(fx.calls.some(call=>call.sync)).toBe(false);
  }finally{
    await restore();
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
