import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
// A row with such a note, a refused switch or the sign-in choice's key fields under it keeps its buttons beside its badge. The
// commands in those notes (pnpm's and bun's too), in a row's status line and a refused switch, and in the Update question each read
// as one, in code whose words stay whole.
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
// The harness list Settings asks for is the manager's own listing; an Install or Update press is its install, and a switch its own,
// each answered as the server answers it. pressed: the bodies of the presses.
async function serve(page,manager,pressed=[]){
  await page.route(/\/api\/agent-runtimes$/,async route=>{
    const method=route.request().method(),body=method==="POST"?route.request().postDataJSON()||{}:{};
    if(method==="GET")return json(route,await manager.snapshot({refresh:true}));
    if(body.action==="select"){
      try{const selected=await manager.setActive({runtime:body.runtime,instanceId:body.instanceId});return json(route,{...await manager.snapshot(),selected})}
      catch(error){return json(route,{error:error.message},400)}
    }
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
// Where each harness row puts its own buttons (Sign in, Install, Update): beside, all on its first line to the right of its badge;
// under, all below that line, the first indented as far as the status above it; end, how far its last button, else its badge, ends
// from the row's right edge.
const laidOut=page=>page.locator(".agent-runtime-option:not(.agent-runtime-skeleton)").evaluateAll(rows=>rows.map(row=>{
  const box=row.getBoundingClientRect(),main=row.querySelector(":scope>button").getBoundingClientRect(),badge=row.querySelector(":scope>button em").getBoundingClientRect();
  const buttons=[...row.querySelectorAll(":scope>button~button")].map(button=>button.getBoundingClientRect());
  return {name:row.querySelector("strong").textContent,beside:buttons.every(button=>button.top<main.bottom&&button.left>=badge.right),
    under:buttons.every(button=>button.top>=main.bottom)&&(!buttons.length||Math.round(buttons[0].left-box.left)===42),end:Math.round(box.right-Math.max(badge.right,...buttons.map(button=>button.right)))};
}));
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
    await expect(note("Grok Build")).toHaveText(`Grok Build 1.0.70 is available. This profile runs ${grokFile}, installed by WinGet: run winget upgrade xAI.GrokBuild to update it.`);
    await expect(note("Grok Build").locator("code")).toHaveText("winget upgrade xAI.GrokBuild");
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
    await expect(row.locator("p.agent-runtime-option-note:not([role])")).toHaveText(`Claude Code 2.1.320 is available. This profile runs ${realpathSync.native(claude)}, installed by WinGet: run winget upgrade Anthropic.ClaudeCode to update it.`);
    await expect(row.locator("p.agent-runtime-option-note:not([role]) code")).toHaveText("winget upgrade Anthropic.ClaudeCode");
    await expect(row.getByRole("button",{name:"Update",exact:true})).toHaveCount(0);
    await expect(row.getByRole("button",{name:"Install",exact:true})).toHaveCount(0);
    await shootRows(page,"winget",["Claude Code"]);
    expect(pressed).toEqual([]);
  }finally{
    await restore();
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

test("a harness row with a note, a refused switch or its key fields under it keeps its Sign in or Install beside its badge, ending on the same right edge as every other row",async({page,request})=>{
  test.setTimeout(120_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-harness-rows-")),restore=await settled(page,request);
  try{
    // Claude Code from WinGet, signed out, 2.1.320 out: Sign in and the note. Grok Build from WinGet, 1.0.70 out: the note and no
    // button. Cursor, whose `about` does not tell its sign-in: Needs setup and Sign in. OpenCode, not there, set to its API keys:
    // Install and the key fields. Codex and Antigravity are not there (Install), nor is Muse Code.
    const folder=join(root,"AppData","Local","Microsoft","WinGet","Packages","Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe");write(join(folder,"claude.exe"));
    const grok=write(join(root,"AppData","Local","Microsoft","WinGet","Packages","xAI.GrokBuild_Microsoft.Winget.Source_8wekyb3d8bbwe","grok.exe"));
    const cursor=write(join(root,"AppData","Local","cursor-agent","cursor-agent.exe"));
    let cursorAccount="{}";
    const fx=machine(root,{path:folder,instances:[{id:"cursor-default",kind:"cursor",displayName:"Cursor",enabled:true,binaryPath:cursor,environment:{}},{id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,auth:"api-key",environment:{}}],latest:{"@anthropic-ai/claude-code":"2.1.320","@xai-official/grok":"1.0.70"},answer:(command,args)=>{
      if(/^claude(\.exe)?$/i.test(basename(command)))return args[0]==="--version"?answered("2.1.300 (Claude Code)\n"):{ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""};
      if(command===grok)return answered(args[0]==="models"?"You are logged in with grok.com.\n":"grok 1.0.41 (4220f3b224a6)\n");
      if(command===cursor)return args[0]==="--version"?answered("2026.10.22-5f1a2b3\n"):args[0]==="about"?answered(cursorAccount):missing(command);
      return missing(command);
    }});
    await serve(page,fx.manager);
    await openHarnesses(page);
    const claude=harnessRow(page,"Claude Code"),cursorRow=harnessRow(page,"Cursor");
    await expect(claude.getByRole("button",{name:"Sign in",exact:true})).toBeVisible();
    await expect(claude.locator("p.agent-runtime-option-note")).toContainText("Claude Code 2.1.320 is available.");
    await expect(harnessRow(page,"Grok Build").locator("p.agent-runtime-option-note")).toContainText("Grok Build 1.0.70 is available.");
    await expect(harnessRow(page,"OpenCode").getByLabel("Key for OpenCode",{exact:true})).toBeVisible();
    await expect(cursorRow.locator("button").first().locator("em")).toHaveText("Needs setup");
    // Signed out of Cursor elsewhere since the list was read: its own check refuses the switch, said under its row.
    cursorAccount=JSON.stringify({userEmail:null});
    await cursorRow.locator("button").first().click();
    await expect(cursorRow.getByRole("alert")).toHaveText("Could not switch to Cursor: Cursor Agent is installed but not authenticated. Run cursor-agent login.");
    await expect(cursorRow.getByRole("button",{name:"Sign in",exact:true})).toBeVisible();
    for(const width of [1280,900,700]){
      await page.setViewportSize({width,height:900});
      for(const mode of ["dark","light"]){
        await switchMode(page,mode);
        const rows=await laidOut(page);
        expect.soft(rows.map(row=>[row.name,row.beside,row.end]),`each row's buttons beside its badge, ending 13 px in, at ${width} in ${mode}`).toEqual(rows.map(row=>[row.name,true,13]));
        await cursorRow.scrollIntoViewIfNeeded();
        await page.screenshot({animations:"disabled",path:shots+`rows-cursor-${mode}-${width}.png`});
        await claude.scrollIntoViewIfNeeded();
        await page.screenshot({animations:"disabled",path:shots+`rows-claude-${mode}-${width}.png`});
      }
    }
    // At a phone's width every row takes two lines: its buttons under its name and status, indented as they are, its badge on the edge.
    await switchMode(page,"dark");await page.setViewportSize({width:560,height:900});
    const narrow=await laidOut(page);
    expect.soft(narrow.map(row=>[row.name,row.under,row.end]),"each row's buttons on a line of their own at 560").toEqual(narrow.map(row=>[row.name,true,13]));
    await cursorRow.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"rows-cursor-dark-560.png"});
  }finally{
    await restore();
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

// How command shows in container (a note's paragraph, the question's): whether its text is there (its last time there, with last),
// the words of it whose letters sit on more than one line, whether a code element holds it whole, and how far that code or the
// container reaches past the right edge of the box they are in (within: the harness row, the dialog).
const commandShown=(container,command,{last=false,within})=>container.evaluate((root,[command,last,within])=>{
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let text="";
  for(let node;(node=walker.nextNode());){nodes.push({node,at:text.length});text+=node.data}
  const at=last?text.lastIndexOf(command):text.indexOf(command);
  if(at<0)return {found:false,broken:[],code:false,past:0};
  const point=index=>{const entry=nodes.findLast(item=>item.at<=index);return [entry.node,index-entry.at]};
  const broken=[...command.matchAll(/\S+/g)].filter(word=>{
    const range=document.createRange(),[node,offset]=point(at+word.index+word[0].length-1);
    range.setStart(...point(at+word.index));range.setEnd(node,offset+1);
    return new Set([...range.getClientRects()].filter(rect=>rect.width>0).map(rect=>Math.round(rect.top))).size>1;
  }).map(word=>word[0]);
  const code=point(at)[0].parentElement.closest("code"),right=Math.max(root.getBoundingClientRect().right,code?.getBoundingClientRect().right??0);
  return {found:true,broken,code:Boolean(code&&root.contains(code)&&code.textContent.trim()===command),past:Math.round((right-root.closest(within).getBoundingClientRect().right)*10)/10,scrolls:Boolean(code&&code.scrollWidth>code.clientWidth)};
},[command,last,within]);

// The commands Trebell tells a person to run, in a harness's note (pnpm's and bun's installs, which Trebell does not update), in its
// status line and a refused switch (Claude Code signed out) and in the Update question (npm into the profile's prefix), each read as
// one: in code whose words stay whole, its lines breaking only between them (a word wider than its line scrolls the code instead).
// They broke at their hyphens, "pnpm add -" / "g", "--" / "allow-scripts=@anthropic-" / "ai/claude-code", so a person retyping one
// could split -g or a package's name; the status line and a refused switch showed their backticks as typed.
test("each command Trebell tells a person to run, in a harness's note, its status line, a refused switch and the Update question, reads as one, in code broken only between its words, at 1280, 900 and 700 wide, dark and light",async({page,request})=>{
  test.setTimeout(180_000);
  const root=mkdtempSync(join(tmpdir(),"trebell-e2e-harness-commands-")),restore=await settled(page,request);
  try{
    // Claude Code from pnpm's global bin and Grok Build from bun's, each with a newer release out: no Update, but a note with the
    // command that updates it.
    const notesRoot=join(root,"notes"),pnpm=join(notesRoot,"AppData","Local","pnpm"),bun=join(notesRoot,"home",".bun","bin");
    write(join(pnpm,"claude.cmd"),"@echo off\r\n");write(join(bun,"grok.exe"),"fixture");
    let claudeSignedIn=true;
    const managed=machine(notesRoot,{path:[pnpm,bun].join(";"),latest:{"@anthropic-ai/claude-code":"2.1.320","@xai-official/grok":"1.0.70"},answer:(command,args)=>{
      const name=basename(command).toLowerCase();
      if(name.startsWith("claude"))return args[0]==="--version"?answered("2.1.300 (Claude Code)\n"):claudeSignedIn?answered(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"})):{ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""};
      if(name.startsWith("grok"))return answered(args[0]==="models"?"You are logged in with grok.com.\n":"grok 1.0.41 (4220f3b224a6)\n");
      return missing(command);
    }});
    await serve(page,managed.manager);
    await openHarnesses(page);
    const note=name=>harnessRow(page,name).locator("p.agent-runtime-option-note:not([role])");
    await expect(note("Claude Code")).toContainText("installed by pnpm");await expect(note("Grok Build")).toContainText("installed by bun");
    // pnpm's note also names the option to leave out on an older pnpm.
    const notes=[["Claude Code","pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest"],["Claude Code","--allow-build",true],["Grok Build","bun add -g @xai-official/grok@latest"]];
    const seen=[];
    for(const width of [1280,900,700])for(const mode of ["dark","light"]){
      await page.setViewportSize({width,height:900});await switchMode(page,mode);
      for(const [name,command,last] of notes)seen.push({where:`${name}'s note at ${width} in ${mode}`,command,...await commandShown(note(name),command,{last,within:".agent-runtime-option"})});
      await harnessRow(page,"Grok Build").scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`commands-notes-${mode}-${width}.png`});
    }
    // Signed out of Claude Code since the list was read: its own check refuses the switch, said under its row with the command its
    // status names; and Refresh reads it signed out, its status line naming that command too (round 13's repair of GR13-25).
    claudeSignedIn=false;
    const claudeRow=harnessRow(page,"Claude Code"),refused=claudeRow.getByRole("alert"),status=claudeRow.locator("button").first().locator("small");
    await page.setViewportSize({width:1280,height:900});await switchMode(page,"dark");
    await claudeRow.locator("button").first().click();
    await expect(refused).toHaveText("Could not switch to Claude Code: Claude Code is signed out. Sign in with claude auth login and try again.");
    for(const width of [1280,900,700])for(const mode of ["dark","light"]){
      await page.setViewportSize({width,height:900});await switchMode(page,mode);
      seen.push({where:`Claude Code's refused switch at ${width} in ${mode}`,command:"claude auth login",...await commandShown(refused,"claude auth login",{within:".agent-runtime-option"})});
      await claudeRow.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`commands-refused-switch-${mode}-${width}.png`});
    }
    await page.setViewportSize({width:1280,height:900});await switchMode(page,"dark");
    await page.getByRole("button",{name:"Refresh",exact:true}).click();
    await expect(status).toHaveText("Claude Code is signed out. Sign in with claude auth login and try again.");
    for(const width of [1280,900,700])for(const mode of ["dark","light"]){
      await page.setViewportSize({width,height:900});await switchMode(page,mode);
      seen.push({where:`Claude Code's status line at ${width} in ${mode}`,command:"claude auth login",...await commandShown(status,"claude auth login",{within:".agent-runtime-option"})});
      await claudeRow.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`commands-status-line-${mode}-${width}.png`});
    }
    // Claude Code from npm, 2.1.300 with 2.1.320 out: Update asks first, naming what it runs. Its prefix is a path wider than the
    // question's lines, which the command's code scrolls to show whole.
    const npmRoot=join(root,"npm-on-a-machine-whose-profile-folder-has-a-name-long-enough-to-run-past-the-question"),prefix=join(npmRoot,"AppData","Roaming","npm"),claude=write(join(prefix,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));write(join(prefix,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
    const updated=machine(npmRoot,{latest:{"@anthropic-ai/claude-code":"2.1.320"},answer:(command,args)=>{
      if(command==="npm")return answered(args[0]==="--version"?"11.0.0\n":args[0]==="view"?"\"2.1.320\"\n":"changed 1 package in 12s\n");
      if(command===claude)return answered(args[0]==="--version"?"2.1.300 (Claude Code)\n":JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));
      return missing(command);
    }});
    const pressed=[];await page.unroute(/\/api\/agent-runtimes$/);await serve(page,updated.manager,pressed);
    await page.setViewportSize({width:1280,height:900});await openHarnesses(page);
    const update=harnessRow(page,"Claude Code").getByRole("button",{name:"Update",exact:true}),question=page.locator("dialog.inspector-text-prompt");
    const command=`npm install -g --prefix ${realpathSync.native(prefix)} --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.320`;
    for(const width of [1280,900,700])for(const mode of ["dark","light"]){
      await page.setViewportSize({width,height:900});await switchMode(page,mode);
      await update.click();
      await expect(question.locator("p")).toContainText("Trebell will run: "+command);
      seen.push({where:`the Update question at ${width} in ${mode}`,command,...await commandShown(question.locator("p"),command,{within:"dialog"})});
      await page.screenshot({animations:"disabled",path:shots+`commands-question-${mode}-${width}.png`});
      await question.getByRole("button",{name:"Cancel",exact:true}).click();await expect(question).toHaveCount(0);
    }
    expect(pressed).toEqual([]);
    // Each command where it is said, none of its words broken across lines, in code, and that code within its paragraph.
    expect(seen.filter(entry=>!entry.found).map(entry=>`${entry.where}: ${entry.command}`),"commands not said").toEqual([]);
    expect(seen.filter(entry=>entry.broken.length).map(entry=>`${entry.where}: ${entry.broken.join(" | ")}`),"words of a command broken across lines").toEqual([]);
    expect(seen.filter(entry=>!entry.code).map(entry=>`${entry.where}: ${entry.command}`),"commands not set as code").toEqual([]);
    expect(seen.filter(entry=>entry.past>0.5).map(entry=>`${entry.where}: ${entry.past} px`),"code reaching past its row or dialog").toEqual([]);
    expect(seen.filter(entry=>entry.where.startsWith("the Update question")&&!entry.scrolls).map(entry=>entry.where),"the question's command scrolling to its long path's end").toEqual([]);
  }finally{
    await restore();
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
