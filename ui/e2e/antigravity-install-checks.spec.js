import { test,expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { ACP_REGISTRY_URL, installAntigravityRuntime } from "../../src/antigravity-runtime-installer.mjs";

// Installing Antigravity from Settings refuses a download that is not the one the ACP registry lists, and a drive without room for
// it, and says why under the Antigravity row, as the server words it: the answers to the row's Install are the server's own install
// (AgentRuntimeManager.install, then installAntigravityRuntime) in a home of the test's own, with only the registry and Google's
// download played by the test. Nothing is installed either time, and the row still offers Install.
const shots=fileURLToPath(new URL("../../visual-audit/polish/antigravity-install-checks/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
const MB=1048576;
// Google's Windows x64 download of Antigravity 1.4.3, as the registry lists it, and the size dl.google.com says it has.
const ARCHIVE="https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.3-windows-x86_64.zip",SHA256="54c2e16378d9a4952e1da70e355f3c33c4f284308d6de48ab3e6e34a127bd325",SIZE=131_267_135;
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
const harnessRow=(page,name)=>page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});

test("Settings says why an Antigravity install was refused: a download that is not the registry's, and a drive without room for it",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-agy-install-")),trebell=join(home,"trebell"),runtimes=join(trebell,"agent-runtimes","antigravity");
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:home,USERPROFILE:home,TEMP:join(home,"tmp"),TMP:join(home,"tmp"),TREBELL_HOME:trebell};
  // Google's download: its bytes are not the archive the registry hashed, so a full read fails the SHA-256 check; the read is counted.
  const reads={download:0};
  const fetchImpl=async url=>{
    if(url===ACP_REGISTRY_URL)return {ok:true,json:async()=>({agents:[{id:"antigravity-acp",version:"1.4.3",distribution:{binary:{"windows-x86_64":{archive:ARCHIVE,cmd:"./agy_acp_server.exe",sha256:SHA256}}}}]})};
    return {ok:true,status:200,headers:new Headers({"content-length":String(SIZE)}),body:new ReadableStream({pull(controller){reads.download++;controller.enqueue(new TextEncoder().encode("not the archive Google published"));controller.close()}},{highWaterMark:0})};
  };
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},env,platform:"win32",arch:"x64",fetchImpl,runFn:async command=>missing(command)});
  const native=(await manager.snapshot()).statuses.find(item=>item.kind==="native");
  // Settings the app saves (the light and dark toggle) are kept, as the server keeps them.
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeReady:true,agentRuntimeStatus:native,appServerReady:false,wsUrl:"",cwd:home,platform:process.platform,version:"antigravity-install-checks",settings,logs:[]}));
  await page.route(/\/api\/runtime$/,route=>json(route,{agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeStatus:native,provider:"openai",providerReady:true,appServerReady:false,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]}));
  await page.route(/\/api\/models$/,route=>json(route,{provider:"openai",agentRuntime:"native",ready:true,models:["gpt-fixture"],metadata:{provider:"openai",models:[{id:"gpt-fixture",name:"GPT Fixture",provider:"openai"}]}}));
  await page.route(/\/api\/providers$/,route=>json(route,{selected:"openai",providers:[{id:"openai",name:"OpenAI API",official:true,hasKey:true}],status:{id:"openai",hasKey:true},ready:true}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  // The harness list is the server's reading, and each Install is answered as the server answers one that fails (gui-server.mjs):
  // first the install itself, then one on a drive with 120 MB free (the free space is the only thing the test sets).
  const installs=[];let plan=["install","full drive"];
  await page.route(/\/api\/agent-runtimes$/,async route=>{
    const request=route.request();
    if(request.method()==="GET")return json(route,await manager.snapshot());
    const body=request.postDataJSON();if(body?.action!=="install")return route.continue();
    installs.push(body.runtime);
    try{
      if(plan.shift()==="install")await manager.install(body.runtime,{environmentId:body.environmentId,id:body.id});
      else await installAntigravityRuntime({env,fetchImpl,platform:"win32",arch:"x64",freeBytes:()=>120*MB+4321});
      return json(route,{error:"the install was expected to be refused"},500);
    }catch(error){return json(route,{error:error.message},400)}
  });
  const nothingInstalled=()=>{expect(existsSync(join(runtimes,"current")),"no runtime was installed").toBe(false);expect(existsSync(runtimes)?readdirSync(runtimes):[],"no install folder was left").toEqual([])};
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    const antigravity=harnessRow(page,"Antigravity"),install=antigravity.getByRole("button",{name:"Install",exact:true});
    await expect(antigravity.locator("button").first().locator("small")).toHaveText("Antigravity ACP runtime is not installed");
    // Install asks first, saying where the runtime comes from; the person confirms.
    const confirmInstall=async()=>{
      await install.click();
      const asked=page.getByRole("dialog",{name:/^Install or update Antigravity ACP runtime on this machine\?/});
      await expect(asked).toBeVisible();await asked.getByRole("button",{name:"Install Antigravity",exact:true}).click();await expect(asked).toHaveCount(0);
    };
    // A download that is not the archive the registry hashed: read in full, then refused.
    await confirmInstall();
    const refusal=antigravity.getByRole("alert");
    await expect(refusal).toHaveText("Could not install Antigravity: The Google Antigravity 1.4.3 download does not match the SHA-256 the ACP registry lists for it. Nothing was installed.");
    expect(reads.download,"the download was read").toBe(1);nothingInstalled();
    await expect(install).toBeEnabled();
    for(const mode of ["dark","light"]){await switchMode(page,mode);await expect(refusal).toBeInViewport();await page.screenshot({animations:"disabled",path:shots+`sha256-refused-${mode}-1280.png`})}
    // A drive with 120 MB free: refused before the download is read, naming what it needs.
    await confirmInstall();
    await expect(refusal).toHaveText(`Could not install Antigravity: Google Antigravity 1.4.3 needs 508 MB free on the drive that holds ${runtimes} to install (its 126 MB download and at least as much again once unpacked, and 256 MB to spare), and 120 MB is free there. Free some space on that drive, then try again. Nothing was installed.`);
    expect(reads.download,"the second download was not read").toBe(1);nothingInstalled();
    expect(installs).toEqual(["antigravity","antigravity"]);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await expect(refusal).toBeInViewport();await page.screenshot({animations:"disabled",path:shots+`no-room-${mode}-1280.png`})}
    // A narrow window wraps the refusal under the row, whole.
    await page.setViewportSize({width:820,height:900});await refusal.scrollIntoViewIfNeeded();await expect(refusal).toBeInViewport({ratio:1});
    const box=await refusal.boundingBox(),row=await antigravity.boundingBox();
    expect(box.x+box.width,"the refusal stays inside its row").toBeLessThanOrEqual(row.x+row.width+0.5);
    await page.screenshot({animations:"disabled",path:shots+"no-room-light-820.png"});
  }finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
