import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// What Settings offers for a newer release of each harness, read as the server reads it: the harness list and the installs are
// AgentRuntimeManager's own (its snapshot and install), run over folders laid out as each installer leaves them, with a stand-in
// for every command they run and for npm's registry, so it is the server's plan the page shows and presses:
// - Claude Code from npm (2.1.300, 2.1.320 out): Update, which runs npm into the prefix that holds the binary the profile runs with
//   Claude Code's install script allowed. An install the binary does not follow is said as a failure; the next one goes through
//   and the row says it is ready, with no Update left;
// - Codex from its own installer, already the newest: neither Update nor a note;
// - Grok Build from WinGet (1.0.41, 1.0.70 out): no Update, but the version, the file it runs and `winget upgrade xAI.GrokBuild`;
// - OpenCode, not there: Install;
// - and Claude Code from WinGet: the same note with `winget upgrade Anthropic.ClaudeCode`.
// Nothing real is installed, updated or started but a script of the test's own standing in for Codex's app-server.
const shots=fileURLToPath(new URL("../../visual-audit/polish/harness-updates/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
const write=(path,text="")=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text,"utf8");return path};
// The Windows launcher npm writes for a package's native binary.
const npmShim=target=>["@ECHO off","GOTO start",":find_dp0","SET dp0=%~dp0","EXIT /b",":start","SETLOCAL","CALL :find_dp0",`"%dp0%\\${target}"   %*`,""].join("\r\n");
// A `codex app-server` at launcher that answers as a signed-in Codex does.
function codexAppServer(launcher){
  const script=write(join(dirname(launcher),"codex-app-server.mjs"),String.raw`
import readline from "node:readline";
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;
  const result=m.method==="initialize"?{userAgent:"codex_cli_rs/0.164.0 (fixture)"}:m.method==="account/read"?{account:{type:"chatgpt",planType:"plus"},requiresOpenaiAuth:true}:{};
  process.stdout.write(JSON.stringify({id:m.id,result})+"\n");
});
`);
  return write(launcher,["@echo off",`"${process.execPath}" "${script}" %*`,""].join("\r\n"));
}
// A machine of the test's own under root, its harnesses where layout() put them and answering through answer(command,args), the
// npm registry naming latest[package]. calls: every command run.
function machine(root,{path="",instances=[],latest,answer}){
  const env={USERPROFILE:join(root,"home"),HOME:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),LOCALAPPDATA:join(root,"AppData","Local"),ProgramFiles:join(root,"Program Files"),PATH:path,PATHEXT:".COM;.EXE;.BAT;.CMD",SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,TEMP:root,TMP:root,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"home",".codex")};
  const calls=[],settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:instances};
  const fetchImpl=async url=>{
    const name=decodeURIComponent(String(url).split("/").slice(3,-1).join("/"));
    return name in latest?new Response(JSON.stringify({name,version:latest[name]}),{status:200,headers:{"content-type":"application/json"}}):new Response("{}",{status:404});
  };
  const runFn=async(command,args)=>{calls.push([command,...args]);return answer(command,args)};
  return {manager:new AgentRuntimeManager({state:{settings:()=>({...settings}),updateSettings:patch=>Object.assign(settings,patch)},env,platform:"win32",runFn,fetchImpl}),calls};
}
// The harness list Settings asks for is the manager's own listing; an Install or Update press is its install, answered as the server
// answers it. pressed: the bodies of the presses.
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
async function shootRows(page,name,rows){
  for(const mode of ["dark","light"]){
    await switchMode(page,mode);
    await harnessRow(page,rows.at(-1)).scrollIntoViewIfNeeded();
    for(const row of rows)await expect(harnessRow(page,row)).toBeInViewport();
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

test.skip(process.platform!=="win32","lays out the harnesses' Windows install folders");

test("Update shows only for a newer release Trebell installs itself: npm's Claude Code updates into its own prefix, a WinGet Grok Build says how, a current Codex offers nothing",async({page,request})=>{
  test.setTimeout(120_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-harness-updates-")),restore=await settled(page,request);
  try{
    const prefix=join(root,"AppData","Roaming","npm"),claude=write(join(prefix,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));write(join(prefix,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
    const grok=write(join(root,"AppData","Local","Microsoft","WinGet","Packages","xAI.GrokBuild_Microsoft.Winget.Source_8wekyb3d8bbwe","grok.exe"));
    const codex=codexAppServer(join(root,"home",".codex","packages","standalone","releases","0.164.0-x86_64","bin","codex.cmd"));
    let claudeVersion="2.1.300",installTakes=false;
    const fx=machine(root,{instances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true,binaryPath:codex,environment:{}}],latest:{"@anthropic-ai/claude-code":"2.1.320","@openai/codex":"0.164.0","@xai-official/grok":"1.0.70"},answer:(command,args)=>{
      if(command==="npm"){
        if(args[0]==="install"&&installTakes)claudeVersion=args.at(-1).split("@").at(-1);
        return answered(args[0]==="--version"?"11.0.0\n":args[0]==="view"?"\"2.1.320\"\n":"changed 1 package in 12s\n");
      }
      if(command===claude)return answered(args[0]==="--version"?claudeVersion+" (Claude Code)\n":JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));
      if(command===grok)return answered(args[0]==="models"?"You are logged in with grok.com.\n":"grok 1.0.41 (4220f3b224a6)\n");
      if(command===codex)return answered("codex-cli 0.164.0\n");
      return missing(command);
    }});
    const pressed=[];await serve(page,fx.manager,pressed);
    await openHarnesses(page);
    const claudeRow=harnessRow(page,"Claude Code"),update=claudeRow.getByRole("button",{name:"Update",exact:true});
    // The row's note of a newer release (an install's answer is said in a note with a role of its own).
    const note=name=>harnessRow(page,name).locator("p.agent-runtime-option-note:not([role])");
    // Claude Code: a newer release npm installs into the prefix the profile's binary is in.
    await expect(claudeRow.locator("button").first().locator("small")).toHaveText("2.1.300 (Claude Code)");
    await expect(update).toBeVisible();await expect(note("Claude Code")).toHaveCount(0);
    // Grok Build from WinGet: no Update, but what is out, the file the profile runs and how to update it.
    const grokFile=realpathSync.native(grok);
    await expect(harnessRow(page,"Grok Build").getByRole("button",{name:"Update",exact:true})).toHaveCount(0);
    await expect(note("Grok Build")).toHaveText(`Grok Build 1.0.70 is out. Trebell Code runs ${grokFile}, which WinGet installed: update it with \`winget upgrade xAI.GrokBuild\`.`);
    // Codex from its own installer is the newest: nothing to offer. OpenCode is not there: Install.
    await expect(harnessRow(page,"Codex").locator("button").first().locator("small")).toHaveText("codex-cli 0.164.0");
    await expect(harnessRow(page,"Codex").getByRole("button",{name:"Update",exact:true})).toHaveCount(0);await expect(note("Codex")).toHaveCount(0);
    await expect(harnessRow(page,"OpenCode").getByRole("button",{name:"Install",exact:true})).toBeVisible();
    await shootRows(page,"offered",["Codex","Claude Code","Grok Build","OpenCode"]);
    // Update asks first, naming the release and the command it runs.
    const question=page.locator("dialog.inspector-text-prompt"),realPrefix=realpathSync.native(prefix);
    const command=`npm install -g --prefix ${realPrefix} --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.320`;
    await update.click();
    await expect(question.locator("p")).toContainText("Update Claude Code to 2.1.320 in the selected environment?");
    await expect(question.locator("p")).toContainText("Trebell will run: "+command);
    await expect(question.getByRole("button")).toHaveText(["Cancel","Update Claude Code"]);
    await question.getByRole("button",{name:"Update Claude Code",exact:true}).click();
    // npm ran, but the binary the profile runs still reports 2.1.300: the row says so, and Update stays.
    const said=claudeRow.getByRole("alert");
    await expect(said).toHaveText(`Could not update Claude Code: Claude Code 2.1.320 was installed, but the Claude Code this profile runs (${claude}) still reports 2.1.300.`);
    await expect(update).toBeEnabled();
    await shootRows(page,"unchanged",["Claude Code"]);
    // From the keyboard this time: Enter on Update, Tab from Cancel to Update Claude Code, Enter. Now it takes.
    installTakes=true;
    await update.focus();await page.keyboard.press("Enter");
    await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Update Claude Code",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(claudeRow.getByRole("status")).toHaveText("Claude Code installed and ready.");
    await expect(claudeRow.locator("button").first().locator("small")).toHaveText("2.1.320 (Claude Code)");
    await expect(update).toHaveCount(0);
    await shootRows(page,"updated",["Claude Code","Grok Build"]);
    // Each press was for the row's own profile, and npm installed into that prefix with Claude Code's install script allowed.
    expect(pressed.map(body=>[body.runtime,body.instanceId])).toEqual([["claude","claude-default"],["claude","claude-default"]]);
    expect(fx.calls.filter(call=>call[0]==="npm"&&call[1]==="install").map(call=>call.slice(1).join(" "))).toEqual([command.slice(4),command.slice(4)]);
    expect(fx.calls.some(call=>call[0]===grok&&call[1]==="update")).toBe(false);
  }finally{
    await restore();
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

test("a WinGet Claude Code offers no Update, and says the release, the file Trebell runs and `winget upgrade Anthropic.ClaudeCode`",async({page,request})=>{
  test.setTimeout(90_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-harness-updates-winget-")),restore=await settled(page,request);
  try{
    const folder=join(root,"AppData","Local","Microsoft","WinGet","Packages","Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe"),claude=write(join(folder,"claude.exe"));
    const fx=machine(root,{path:folder,latest:{"@anthropic-ai/claude-code":"2.1.320"},answer:(command,args)=>command==="claude"?answered(args[0]==="--version"?"2.1.300 (Claude Code)\n":JSON.stringify({loggedIn:true})):missing(command)});
    const pressed=[];await serve(page,fx.manager,pressed);
    await openHarnesses(page);
    const row=harnessRow(page,"Claude Code");
    await expect(row.locator("p.agent-runtime-option-note:not([role])")).toHaveText(`Claude Code 2.1.320 is out. Trebell Code runs ${realpathSync.native(claude)}, which WinGet installed: update it with \`winget upgrade Anthropic.ClaudeCode\`.`);
    await expect(row.getByRole("button",{name:"Update",exact:true})).toHaveCount(0);
    await expect(row.getByRole("button",{name:"Install",exact:true})).toHaveCount(0);
    await shootRows(page,"winget",["Claude Code"]);
    expect(pressed).toEqual([]);
  }finally{
    await restore();
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
