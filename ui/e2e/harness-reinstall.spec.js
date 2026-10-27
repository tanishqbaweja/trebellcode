import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// A harness in npm's prefix whose binary does not start, as Settings shows it and repairs it: the placeholder claude.exe an install
// whose install script never ran leaves there exits with its own error, so its version cannot be read. Its row offers Update, which
// installs the Claude Code npm recorded there again with its install script allowed, and the row then says it is ready with the
// version it now reports. A Grok Build there whose check fails on its own config file is not the install's to mend: its row offers no
// Update. The harness list and the install are AgentRuntimeManager's own (its snapshot and install), over a prefix laid out as npm
// leaves it, with a stand-in for every command it runs: nothing real is installed or started.
const shots=fileURLToPath(new URL("../../visual-audit/polish/harness-updates/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const exited=(code,stderr)=>({ok:false,code,error:null,stdout:"",stderr});
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
const write=(path,text="")=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text,"utf8");return path};
// The Windows launcher npm writes for a package's native binary.
const npmShim=target=>["@ECHO off","GOTO start",":find_dp0","SET dp0=%~dp0","EXIT /b",":start","SETLOCAL","CALL :find_dp0",`"%dp0%\\${target}"   %*`,""].join("\r\n");
// A machine of the test's own under root, with a PATH of path, whose commands answer through answer(command,args); calls: every
// command run.
function machine(root,{answer,path=""}){
  const env={USERPROFILE:join(root,"home"),HOME:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),LOCALAPPDATA:join(root,"AppData","Local"),ProgramFiles:join(root,"Program Files"),PATH:path,PATHEXT:".COM;.EXE;.BAT;.CMD",SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,TEMP:root,TMP:root,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"home",".codex")};
  const calls=[],settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[]};
  const runFn=async(command,args)=>{calls.push([command,...args]);return answer(command,args)};
  // npm's public registry is never read here: the newest release is what the stand-in npm names.
  const fetchImpl=async url=>{throw new Error("fetched "+url)};
  return {manager:new AgentRuntimeManager({state:{settings:()=>({...settings}),updateSettings:patch=>Object.assign(settings,patch)},env,platform:"win32",runFn,fetchImpl}),calls};
}
// The harness list Settings asks for is the manager's own listing; an Update press is its install, answered as the server answers it.
async function serve(page,manager,pressed){
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
const harnessRow=(page,name)=>page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
async function shootRow(page,name,harness="Claude Code"){
  for(const mode of ["dark","light"]){
    await switchMode(page,mode);
    await harnessRow(page,harness).scrollIntoViewIfNeeded();await expect(harnessRow(page,harness)).toBeInViewport();
    await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-1280.png`});
  }
  await switchMode(page,"dark");
}
async function openHarnesses(page){
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
}

test.skip(process.platform!=="win32","lays out npm's Windows prefix");

test("a Claude Code in npm's prefix whose binary does not start offers Update, which installs it there again with its install script allowed until it starts",async({page,request})=>{
  test.setTimeout(120_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-harness-reinstall-"));
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  await page.setViewportSize({width:1280,height:900});
  try{
    // The placeholder npm left in place of Claude Code's native binary, behind npm's launcher, with the manifest npm recorded.
    const prefix=join(root,"AppData","Roaming","npm"),claude=write(join(prefix,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));
    write(join(prefix,"node_modules","@anthropic-ai","claude-code","package.json"),JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.320"}));
    write(join(prefix,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
    let installed=null;
    const fx=machine(root,{answer:(command,args)=>{
      if(command==="npm"){
        if(args[0]==="install"&&args.includes("--allow-scripts=@anthropic-ai/claude-code"))installed=args.at(-1).split("@").at(-1);
        return answered(args[0]==="--version"?"11.0.0\n":args[0]==="view"?"\"2.1.320\"\n":"changed 1 package in 12s\n");
      }
      if(command===claude){
        if(args[0]==="--version")return installed?answered(installed+" (Claude Code)\n"):exited(1,"Error: claude native binary not installed.\n");
        return answered(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));
      }
      return missing(command);
    }});
    const pressed=[];await serve(page,fx.manager,pressed);
    await openHarnesses(page);
    const row=harnessRow(page,"Claude Code"),update=row.getByRole("button",{name:"Update",exact:true});
    // The row says what its check did, and offers Update.
    await expect(row.locator("button").first().locator("small")).toHaveText("Claude Code is installed but `claude --version` exited with code 1: Error: claude native binary not installed.");
    await expect(update).toBeVisible();
    await shootRow(page,"reinstall-offered");
    // Update asks first, naming the release npm recorded there and the install it runs in that prefix.
    const question=page.locator("dialog.inspector-text-prompt");
    const command=`npm install -g --prefix ${realpathSync.native(prefix)} --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.320`;
    await update.click();
    await expect(question.locator("p")).toContainText("Update Claude Code to 2.1.320 in the selected environment?");
    await expect(question.locator("p")).toContainText("Trebell will run: "+command);
    await question.getByRole("button",{name:"Update Claude Code",exact:true}).click();
    // npm put the binary in place: the row says it is ready, with the version it now reports, and has no Update left.
    await expect(row.getByRole("status")).toHaveText("Claude Code installed and ready.");
    await expect(row.locator("button").first().locator("small")).toHaveText("2.1.320 (Claude Code)");
    await expect(update).toHaveCount(0);
    await shootRow(page,"reinstalled");
    expect(pressed.map(body=>[body.runtime,body.instanceId])).toEqual([["claude","claude-default"]]);
    expect(fx.calls.filter(call=>call[0]==="npm"&&call[1]==="install").map(call=>call.slice(1).join(" "))).toEqual([command.slice(4)]);
  }finally{
    await request.post("/api/settings",{data:{appearanceMode:before.appearanceMode||"dark"}});
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

test("a Grok Build in npm's prefix whose check fails on its own config file offers no Update, and its row says what the check printed",async({page,request})=>{
  test.setTimeout(120_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-harness-no-reinstall-"));
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  await page.setViewportSize({width:1280,height:900});
  try{
    // Grok Build as npm installs it: npm's launcher for its bootstrap script, and the manifest npm recorded.
    const prefix=join(root,"AppData","Roaming","npm");
    write(join(prefix,"node_modules","@xai-official","grok","bin","grok"),"#!/usr/bin/env node\nrequire('./grok-bootstrap.js');\n");
    write(join(prefix,"node_modules","@xai-official","grok","package.json"),JSON.stringify({name:"@xai-official/grok",version:"1.0.70"}));
    write(join(prefix,"grok.cmd"),"@ECHO off\r\nnode \"%~dp0\\node_modules\\@xai-official\\grok\\bin\\grok\" %*\r\n");
    const fx=machine(root,{path:prefix,answer:(command,args)=>{
      if(command==="npm")return answered(args[0]==="view"?"\"1.0.70\"\n":"11.0.0\n");
      if(command==="grok")return args[0]==="--version"?exited(2,"error: config file is not valid TOML\n"):answered("You are logged in with grok.com.\n");
      return missing(command);
    }});
    const pressed=[];await serve(page,fx.manager,pressed);
    await openHarnesses(page);
    const row=harnessRow(page,"Grok Build");
    // The row says what its check printed, with neither an Update nor a note: installing Grok Build again mends no config file.
    await expect(row.locator("button").first().locator("small")).toHaveText("Grok Build is installed but `grok --version` exited with code 2: error: config file is not valid TOML");
    await expect(row.getByRole("button",{name:"Update",exact:true})).toHaveCount(0);
    await expect(row.locator(".agent-runtime-option-note")).toHaveCount(0);
    await shootRow(page,"reinstall-not-offered","Grok Build");
    expect(pressed).toEqual([]);
    expect(fx.calls.filter(call=>call[0]==="npm")).toEqual([]);
  }finally{
    await request.post("/api/settings",{data:{appearanceMode:before.appearanceMode||"dark"}});
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
