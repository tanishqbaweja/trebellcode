// How Trebell installs and updates a harness (AgentRuntimeManager installPlan, install, and the update reading each status of Settings'
// harness list carries), judged as T3 Code's maintenance resolver judges it, from where the binary the profile runs really is:
// - a table of real Windows, macOS and Linux install paths and what updates each (harnessInstallOwner), mirroring the cases of T3's
//   maintenanceResolver.test.ts: npm's global prefix, a harness's own updater, and the installs that are the person's to update;
// - with a runner of the test's own standing in for every command (the manager's runFn, a host's executeArgv) and a stand-in npm
//   registry: an npm Claude Code updates into its own prefix with its install script allowed (on an SSH host too, and Codex there), a
//   native one runs its `claude update`, Codex's standalone tree `codex update` with CODEX_HOME at the profile's shared home, Grok's
//   own install `grok update`, an OpenCode 2.x from npm the newest 2.x below 3.0.0; a WinGet one is refused with how to update it; an
//   update the version did not follow fails, as does a binary that does not start after it; a version Trebell cannot read installs
//   nothing; and Settings is offered Update only for a newer release Trebell installs itself.
// No real harness, npm or updater runs (Codex's account read talks to a script of the test's own), and nothing is installed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { harnessInstallOwner, manualUpdateText, newestListed, shownCommand } from "../src/harness-install-plan.mjs";

const WINDOWS_ENV={LOCALAPPDATA:"C:\\Users\\me\\AppData\\Local",APPDATA:"C:\\Users\\me\\AppData\\Roaming",ProgramFiles:"C:\\Program Files","ProgramFiles(x86)":"C:\\Program Files (x86)"};
const PACKAGE={claude:"@anthropic-ai/claude-code",codex:"@openai/codex",grok:"@xai-official/grok",opencode:"opencode-ai"};
// What harnessInstallOwner makes of a binary: found (what the profile names or PATH finds), binary (what starts behind an npm
// launcher) and real (its real path), with files the only files there and scripts the text of small launchers.
const judged=(kind,{found,binary=found,real=binary,platform="win32",files=[],scripts={},packageName=PACKAGE[kind],codexHome=null,grokHome=null})=>harnessInstallOwner(kind,{paths:{found,binary,real},packageName,command:kind,platform,env:platform==="win32"?WINDOWS_ENV:{},codexHome,grokHome,exists:path=>files.includes(path),read:path=>scripts[path]||""});
const NATIVE={method:"native",args:["update"]};
const WINGET_CLAUDE={method:"manual",by:"WinGet",command:"winget upgrade Anthropic.ClaudeCode"};
const UNKNOWN={method:"manual",by:null,command:null};
const WINGET_PACKAGE="C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
const CASES=[
  ["Claude Code's own installer on Windows",{kind:"claude",found:"C:\\Users\\me\\.local\\bin\\claude.exe"},NATIVE],
  ["Claude Code's own installer on macOS, its launcher a link into its versions",{kind:"claude",platform:"darwin",found:"/Users/me/.local/bin/claude",real:"/Users/me/.local/share/claude/versions/2.1.300"},NATIVE],
  ["Claude Code's own installer on Linux",{kind:"claude",platform:"linux",found:"/home/me/.local/bin/claude"},NATIVE],
  ["WinGet's link for one user",{kind:"claude",found:"C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe",real:WINGET_PACKAGE},WINGET_CLAUDE],
  ["WinGet's package for the machine",{kind:"claude",found:"C:\\Program Files\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe"},WINGET_CLAUDE],
  ["WinGet's machine link alone, its package not known",{kind:"claude",found:"C:\\Program Files\\WinGet\\Links\\claude.exe"},{method:"manual",by:"WinGet",command:null}],
  ["a launcher where Claude Code's installer puts it that is WinGet's",{kind:"claude",found:"C:\\Users\\me\\.local\\bin\\claude.exe",real:WINGET_PACKAGE},WINGET_CLAUDE],
  ["a folder named WinGet outside WinGet's own",{kind:"claude",found:"C:\\Work\\Microsoft\\WinGet\\Links\\claude.exe"},UNKNOWN],
  ["npm's global prefix in %APPDATA%, the binary behind claude.cmd",{kind:"claude",found:"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",files:["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"]},{method:"npm",prefix:"C:\\Users\\me\\AppData\\Roaming\\npm"}],
  ["a node_modules folder with no npm launcher beside it",{kind:"claude",found:"C:\\work\\app\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"},UNKNOWN],
  ["npm's script launcher for Codex, proven by its package beside it",{kind:"codex",found:"D:\\tools\\npm\\codex.cmd",files:["D:\\tools\\npm\\node_modules\\@openai\\codex\\package.json"]},{method:"npm",prefix:"D:\\tools\\npm"}],
  ["npm's global prefix on Linux",{kind:"claude",platform:"linux",found:"/usr/local/bin/claude",real:"/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"},{method:"npm",prefix:"/usr/local"}],
  ["a global of Homebrew's Node, which is npm's",{kind:"codex",platform:"darwin",found:"/opt/homebrew/bin/codex",real:"/opt/homebrew/Cellar/node/22.1.0/lib/node_modules/@openai/codex/bin/codex.js"},{method:"npm",prefix:"/opt/homebrew/Cellar/node/22.1.0"}],
  // pnpm 10 runs Claude Code's install script, which puts its binary in place, only when told to (T3 a523b0036).
  ["pnpm's global store",{kind:"claude",platform:"linux",found:"/home/me/.local/share/pnpm/claude",real:"/home/me/.local/share/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.300/node_modules/@anthropic-ai/claude-code/cli.js"},{method:"manual",by:"pnpm",command:"pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest"}],
  ["bun's global bin",{kind:"claude",platform:"darwin",found:"/Users/me/.bun/bin/claude"},{method:"manual",by:"bun",command:"bun add -g @anthropic-ai/claude-code@latest"}],
  ["Vite+'s bin on Windows",{kind:"claude",found:"C:\\Users\\me\\AppData\\Local\\vite-plus\\bin\\claude.cmd",real:"C:\\Users\\me\\AppData\\Local\\vite-plus\\packages\\@anthropic-ai\\claude-code\\lib\\node_modules\\@anthropic-ai\\claude-code\\cli.js"},{method:"manual",by:"Vite+",command:"vp i -g @anthropic-ai/claude-code"}],
  ["a folder named vite-plus in a project",{kind:"claude",platform:"linux",found:"/work/vite-plus/bin/claude",real:"/work/vite-plus/node_modules/@anthropic-ai/claude-code/cli.js"},UNKNOWN],
  ["Yarn's global folder",{kind:"claude",platform:"linux",found:"/home/me/.yarn/bin/claude",real:"/home/me/.config/yarn/global/node_modules/@anthropic-ai/claude-code/cli.js"},{method:"manual",by:"Yarn",command:"yarn global add @anthropic-ai/claude-code@latest"}],
  ["Volta's shim",{kind:"claude",found:"C:\\Users\\me\\AppData\\Local\\Volta\\bin\\claude.exe",real:"C:\\Program Files\\Volta\\volta-shim.exe"},{method:"manual",by:"Volta",command:"volta install @anthropic-ai/claude-code@latest"}],
  ["a mise shim",{kind:"claude",platform:"linux",found:"/home/me/.local/share/mise/shims/claude"},{method:"manual",by:"mise",command:null}],
  ["a mise wrapper where Claude Code's installer puts its launcher",{kind:"claude",platform:"linux",found:"/home/me/.local/bin/claude",scripts:{"/home/me/.local/bin/claude":"#!/bin/sh\nexec mise x claude -- claude \"$@\"\n"}},{method:"manual",by:"mise",command:null}],
  ["a mise tool that looks like an npm global",{kind:"claude",platform:"linux",found:"/home/me/.local/bin/cc",real:"/home/me/.local/share/mise/installs/npm-anthropic-ai-claude-code/2.1.300/lib/node_modules/@anthropic-ai/claude-code/cli.js"},{method:"manual",by:"mise",command:null}],
  ["a Homebrew formula",{kind:"claude",platform:"darwin",found:"/opt/homebrew/bin/claude",real:"/opt/homebrew/Cellar/claude-code/2.1.0/bin/claude"},{method:"manual",by:"Homebrew",command:"brew upgrade claude-code"}],
  ["a Homebrew cask",{kind:"codex",platform:"darwin",found:"/usr/local/bin/codex",real:"/usr/local/Caskroom/codex/0.148.0/codex"},{method:"manual",by:"Homebrew",command:"brew upgrade --cask codex"}],
  ["Codex's standalone tree in the profile's home, through its Windows bin junction",{kind:"codex",found:"C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",real:"C:\\Users\\me\\.codex\\packages\\standalone\\releases\\0.163.0-x86_64\\bin\\codex.exe",codexHome:"C:\\Users\\me\\.codex"},{method:"native",args:["update"],env:{CODEX_HOME:"C:\\Users\\me\\.codex"}}],
  ["Codex's standalone tree in another home than the profile's",{kind:"codex",found:"C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",real:"D:\\other-codex\\packages\\standalone\\releases\\0.163.0-x86_64\\bin\\codex.exe",codexHome:"C:\\Users\\me\\.codex"},UNKNOWN],
  ["a Codex release folder no updater keeps",{kind:"codex",platform:"linux",found:"/usr/local/bin/codex",real:"/usr/local/lib/codex/releases/rust-v0.162.1-x86_64-unknown-linux-musl/bin/codex",codexHome:"/home/me/.codex"},UNKNOWN],
  ["a project's node_modules",{kind:"claude",platform:"linux",found:"/work/app/node_modules/.bin/claude",real:"/work/app/node_modules/@anthropic-ai/claude-code/cli.js"},UNKNOWN],
  ["a folder nothing proves",{kind:"claude",found:"C:\\tools\\claude.exe"},UNKNOWN],
  ["Grok Build's own install in its home",{kind:"grok",found:"C:\\Users\\me\\.grok\\bin\\grok.exe",grokHome:"C:\\Users\\me\\.grok"},NATIVE],
  ["Grok Build from WinGet",{kind:"grok",found:"C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\grok.exe",real:"C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\xAI.GrokBuild_Microsoft.Winget.Source_8wekyb3d8bbwe\\grok.exe",grokHome:"C:\\Users\\me\\.grok"},{method:"manual",by:"WinGet",command:"winget upgrade xAI.GrokBuild"}],
  ["OpenCode's own installer",{kind:"opencode",platform:"linux",found:"/home/me/.opencode/bin/opencode"},{method:"native",args:["upgrade"]}],
  ["OpenCode 2.x from npm",{kind:"opencode",packageName:"@opencode/cli",found:"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe",files:["C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd"]},{method:"npm",prefix:"C:\\Users\\me\\AppData\\Roaming\\npm"}],
  ["OpenCode 1.x's package for a 2.x version",{kind:"opencode",packageName:"@opencode/cli",found:"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",files:["C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd"]},UNKNOWN],
];
test("what updates a harness, judged from where the binary a profile runs really is: npm's prefix, the harness's own updater or the person",()=>{
  for(const [name,{kind,...fixture},expected] of CASES)assert.deepEqual(judged(kind,fixture),expected,name);
  // What Settings says of a newer release Trebell does not install itself, in Trebell's own words: the release, the file the profile
  // runs, and what installed it with the command that updates it.
  assert.equal(manualUpdateText({name:"Claude Code",latest:"2.1.320",binary:WINGET_PACKAGE,by:"WinGet",command:"winget upgrade Anthropic.ClaudeCode"}),`Claude Code 2.1.320 is available. This profile runs ${WINGET_PACKAGE}, installed by WinGet: run \`winget upgrade Anthropic.ClaudeCode\` to update it.`);
  assert.equal(manualUpdateText({name:"Claude Code",latest:"2.1.320",binary:"/home/me/.local/share/mise/shims/claude",by:"mise"}),"Claude Code 2.1.320 is available. This profile runs /home/me/.local/share/mise/shims/claude, installed by mise: update it with mise.");
  assert.equal(manualUpdateText({name:"Claude Code",latest:"2.1.320",binary:"C:\\tools\\claude.exe"}),"Claude Code 2.1.320 is available. This profile runs C:\\tools\\claude.exe, and Trebell Code cannot tell what installed it: update it the way you installed it.");
  assert.equal(manualUpdateText({name:"Claude Code",latest:"2.1.320",binary:"/home/me/.local/share/pnpm/claude",by:"pnpm",command:"pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest"}),"Claude Code 2.1.320 is available. This profile runs /home/me/.local/share/pnpm/claude, installed by pnpm: run `pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest` to update it.");
  // `npm view <package>@<range> version --json` lists every version in range, in no order to rely on: the newest by version wins.
  assert.equal(newestListed('["2.0.24","2.10.0","2.2.0"]\n'),"2.10.0");assert.equal(newestListed('"1.14.19"\n'),"1.14.19");assert.equal(newestListed(""),null);
});

const WINDOWS_ONLY={skip:process.platform!=="win32"&&"lays out Windows install folders"};
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const exited=(code,stderr)=>({ok:false,code,error:null,stdout:"",stderr});
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
const TIMED_OUT=Object.freeze({ok:false,code:null,error:"probe timed out",stdout:"",stderr:""});
// The Windows launcher npm writes for a package's native binary.
const npmShim=target=>["@ECHO off","GOTO start",":find_dp0","SET dp0=%~dp0","EXIT /b",":start","SETLOCAL","CALL :find_dp0",`"%dp0%\\${target}"   %*`,""].join("\r\n");
async function file(path,text=""){await mkdir(dirname(path),{recursive:true});await writeFile(path,text,"utf8");return path}
async function tempRoot(t,name){
  const root=await mkdtemp(join(tmpdir(),`trebell-install-plan-${name}-`));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  return root;
}
// A machine of the test's own under root: its home, %APPDATA% and %LOCALAPPDATA%, a PATH of path, a stand-in npm registry naming
// latest[package], and answer(command,args,options) giving every launch's answer (calls lists them). Every harness not answered for
// is not there.
function machine(root,{instances=[],answer,latest={},path="",extraEnv={}}){
  const env={USERPROFILE:join(root,"home"),HOME:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),LOCALAPPDATA:join(root,"AppData","Local"),ProgramFiles:join(root,"Program Files"),PATH:path,PATHEXT:".COM;.EXE;.BAT;.CMD",SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,TEMP:root,TMP:root,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"home",".codex"),...extraEnv};
  const calls=[],fetched=[],settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:instances};
  const state={settings:()=>({...settings}),updateSettings:patch=>Object.assign(settings,patch)};
  const runFn=async(command,args,options)=>{calls.push({command,args:[...args],env:options.env,timeoutMs:options.timeoutMs});return answer(command,args,options)};
  const fetchImpl=async url=>{
    fetched.push(String(url));const name=decodeURIComponent(String(url).split("/").slice(3,-1).join("/"));
    return name in latest?new Response(JSON.stringify({name,version:latest[name]}),{status:200,headers:{"content-type":"application/json"}}):new Response("{}",{status:404});
  };
  return {manager:new AgentRuntimeManager({state,env,platform:"win32",runFn,fetchImpl}),calls,fetched,env,latest};
}
const statusOf=(list,kind)=>list.statuses.find(item=>item.kind===kind);
const npmCalls=calls=>calls.filter(call=>call.command==="npm").map(call=>call.args.join(" "));

test("Update on npm's global Claude Code installs into the prefix holding the binary the profile runs, its install script allowed, and checks what it then reports",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"npm-claude"),prefix=join(root,"AppData","Roaming","npm");
  const binary=await file(join(prefix,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));
  await file(join(prefix,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  let version="2.1.300",release="2.1.320",installTakes=true,startsAfter=true;
  const fx=machine(root,{latest:{"@anthropic-ai/claude-code":"2.1.320"},answer:(command,args)=>{
    if(command==="npm"){
      if(args[0]==="--version")return answered("11.0.0\n");
      if(args[0]==="view")return answered(JSON.stringify(release)+"\n");
      if(installTakes)version=args.at(-1).split("@").at(-1);
      if(!startsAfter)version=null;
      return answered("added 1 package in 9s\n");
    }
    if(command!==binary)return missing(command);
    if(args[0]==="--version")return version?answered(version+" (Claude Code)\n"):exited(1,"Error: Claude Code's native binary is not in place: its install script did not run.\n");
    return answered(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));
  }});
  const realPrefix=realpathSync.native(prefix),real=realpathSync.native(binary);
  // The listings that answer a switch or a save read no registry: until Settings' own listing has, no newer release is known.
  assert.deepEqual(statusOf(await fx.manager.snapshot(),"claude").update?.latest,null);
  assert.deepEqual(fx.fetched,[]);
  const update=statusOf(await fx.manager.snapshot({refresh:true}),"claude").update;
  const command=shownCommand("npm",["install","-g","--prefix",realPrefix,"--allow-scripts=@anthropic-ai/claude-code","@anthropic-ai/claude-code@2.1.320"],"win32");
  assert.deepEqual(update,{current:"2.1.300",latest:"2.1.320",newer:true,canUpdate:true,command,binary:real,message:null});
  assert.deepEqual(fx.fetched,["https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest"],"the registry is read for the one harness there");
  const installed=await fx.manager.install("claude");
  assert.deepEqual(npmCalls(fx.calls),["--version","view @anthropic-ai/claude-code version --json",`install -g --prefix ${realPrefix} --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.320`]);
  assert.deepEqual([installed.method,installed.packageName,installed.targetVersion,installed.status.version],["npm","@anthropic-ai/claude-code","2.1.320","2.1.320 (Claude Code)"]);
  // Now the newest: no Update, and pressing it from an older page installs nothing.
  const current=statusOf(await fx.manager.snapshot(),"claude").update;
  assert.deepEqual([current.current,current.newer,current.message],["2.1.320",false,null]);
  assert.match((await fx.manager.install("claude")).output,/^Claude Code 2\.1\.320 is already the newest Claude Code release\.$/);
  assert.equal(npmCalls(fx.calls).filter(line=>line.startsWith("install")).length,1);
  // An npm install the profile's binary did not follow fails, saying what it still reports.
  release="2.1.330";installTakes=false;
  await assert.rejects(()=>fx.manager.install("claude"),{message:`Claude Code 2.1.330 was installed, but the Claude Code this profile runs (${binary}) still reports 2.1.320.`});
  // So does one after which the binary does not start, with what its --version printed.
  release="2.1.340";installTakes=true;startsAfter=false;
  await assert.rejects(()=>fx.manager.install("claude"),{message:`Claude Code 2.1.340 was installed, but the Claude Code this profile runs (${binary}) did not start: Claude Code is installed but \`claude --version\` exited with code 1: Error: Claude Code's native binary is not in place: its install script did not run.`});
});

test("Update on Claude Code's own install runs its `claude update` as the profile runs Claude, and fails when the version stays where it was",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"native-claude"),binary=await file(join(root,"home",".local","bin","claude.exe")),home=join(root,"claude-config");
  let version="2.1.300",moves=true;
  const fx=machine(root,{instances:[{id:"claude-default",kind:"claude",homePath:home,environment:{}}],latest:{"@anthropic-ai/claude-code":"2.1.320"},answer:(command,args)=>{
    if(command!==binary)return missing(command);
    if(args[0]==="--version")return answered(version+" (Claude Code)\n");
    if(args[0]==="update"){const from=version;if(moves)version=fx.latest["@anthropic-ai/claude-code"];return answered(`Current version: ${from}\nSuccessfully updated from ${from} to version ${version}\n`)}
    return answered(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));
  }});
  const update=statusOf(await fx.manager.snapshot({refresh:true}),"claude").update;
  assert.deepEqual(update,{current:"2.1.300",latest:"2.1.320",newer:true,canUpdate:true,command:shownCommand(binary,["update"],"win32"),binary:realpathSync.native(binary),message:null});
  const installed=await fx.manager.install("claude");
  const ran=fx.calls.filter(call=>call.args[0]==="update");
  assert.deepEqual(ran.map(call=>[call.command,call.args,call.env.CLAUDE_CONFIG_DIR]),[[binary,["update"],home]],"Claude Code's own updater, in the profile's Claude home");
  assert.deepEqual([installed.method,installed.status.version],["native","2.1.320 (Claude Code)"]);
  assert.deepEqual(npmCalls(fx.calls),[],"no npm copy beside it");
  // A newer release that `claude update` did not install (its channel lags npm's, or it failed quietly) is said, not shown as done.
  fx.latest["@anthropic-ai/claude-code"]="2.1.330";moves=false;
  await assert.rejects(()=>fx.manager.install("claude"),{message:`\`claude.exe update\` finished, but the Claude Code this profile runs (${binary}) still reports 2.1.320.`});
});

test("a WinGet Claude Code gets no Update but the version, the file it runs and `winget upgrade`, and pressing Update from an older page installs nothing",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"winget-claude"),folder=join(root,"AppData","Local","Microsoft","WinGet","Packages","Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe");
  const binary=await file(join(folder,"claude.exe"));
  const fx=machine(root,{path:folder,latest:{"@anthropic-ai/claude-code":"2.1.320"},answer:(command,args)=>{
    if(command!=="claude")return missing(command);
    return args[0]==="--version"?answered("2.1.300 (Claude Code)\n"):answered(JSON.stringify({loggedIn:true}));
  }});
  const real=realpathSync.native(binary),update=statusOf(await fx.manager.snapshot({refresh:true}),"claude").update;
  assert.deepEqual(update,{current:"2.1.300",latest:"2.1.320",newer:true,canUpdate:false,command:"winget upgrade Anthropic.ClaudeCode",binary:real,message:`Claude Code 2.1.320 is available. This profile runs ${real}, installed by WinGet: run \`winget upgrade Anthropic.ClaudeCode\` to update it.`});
  const before=fx.calls.length;
  await assert.rejects(()=>fx.manager.install("claude"),{message:`Trebell Code does not update the Claude Code at ${real}, installed by WinGet: run \`winget upgrade Anthropic.ClaudeCode\` to update it. Nothing was installed.`});
  assert.deepEqual(fx.calls.slice(before).map(call=>call.args.join(" ")),["--version"],"only its version was read");
  // The newest already, or a registry that does not answer: nothing to say.
  const another=machine(root,{path:folder,latest:{"@anthropic-ai/claude-code":"2.1.300"},answer:(command,args)=>command!=="claude"?missing(command):args[0]==="--version"?answered("2.1.300 (Claude Code)\n"):answered(JSON.stringify({loggedIn:true}))});
  assert.deepEqual(statusOf(await another.manager.snapshot({refresh:true}),"claude").update.message,null);
  const offline=machine(root,{path:folder,answer:(command,args)=>command!=="claude"?missing(command):args[0]==="--version"?answered("2.1.300 (Claude Code)\n"):answered(JSON.stringify({loggedIn:true}))});
  const unknown=statusOf(await offline.manager.snapshot({refresh:true}),"claude").update;
  assert.deepEqual([unknown.latest,unknown.newer,unknown.message],[null,false,null]);
});

// A `codex app-server` that answers initialize and account/read as a signed-in Codex does, at launcher: a node script of the test's
// own behind it.
async function codexAppServer(launcher){
  const script=await file(join(dirname(launcher),"codex-app-server.mjs"),String.raw`
import readline from "node:readline";
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;
  const result=m.method==="initialize"?{userAgent:"codex_cli_rs/0.163.0 (fixture)"}:m.method==="account/read"?{account:{type:"chatgpt",planType:"plus"},requiresOpenaiAuth:true}:{};
  process.stdout.write(JSON.stringify({id:m.id,result})+"\n");
});
`);
  await file(launcher,["@echo off",`"${process.execPath}" "${script}" %*`,""].join("\r\n"));
  return launcher;
}
test("Codex in the standalone tree of the profile's shared home updates with `codex update`, CODEX_HOME at that home",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"codex-standalone"),shared=join(root,"codex-shared"),shadow=join(root,"codex-shadow");
  const launcher=await codexAppServer(join(shared,"packages","standalone","releases","0.163.0-x86_64","bin","codex.cmd"));
  let version="0.163.0";
  const fx=machine(root,{instances:[{id:"codex-default",kind:"codex",binaryPath:launcher,homePath:shared,shadowHomePath:shadow,environment:{}}],latest:{"@openai/codex":"0.164.0"},answer:(command,args)=>{
    if(command!==launcher)return missing(command);
    if(args[0]==="update"){version="0.164.0";return answered("Updated Codex to 0.164.0\n")}
    return answered("codex-cli "+version+"\n");
  }});
  const update=statusOf(await fx.manager.snapshot({refresh:true}),"codex").update;
  assert.deepEqual([update.current,update.latest,update.newer,update.canUpdate,update.command],["0.163.0","0.164.0",true,true,`${shownCommand(launcher,["update"],"win32")} (with CODEX_HOME set to ${shared})`]);
  const installed=await fx.manager.install("codex");
  const ran=fx.calls.filter(call=>call.args[0]==="update");
  assert.deepEqual(ran.map(call=>[call.command,call.env.CODEX_HOME]),[[launcher,shared]],"the shared home that keeps the tree, not the profile's own sign-in home");
  assert.equal(fx.manager.childEnv(fx.manager.instances().find(item=>item.id==="codex-default")).CODEX_HOME,shadow,"its sessions keep their own home");
  assert.deepEqual([installed.method,installed.status.version],["native","codex-cli 0.164.0"]);
  assert.deepEqual(npmCalls(fx.calls),[]);
});

test("Grok Build's own install updates with `grok update`, its updater on; one Trebell does not install is not installed by it",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"grok-native"),binary=await file(join(root,"home",".grok","bin","grok.exe"));
  let version="1.0.41";
  const fx=machine(root,{latest:{"@xai-official/grok":"1.0.70"},answer:(command,args)=>{
    if(command!==binary)return missing(command);
    if(args[0]==="update"){version="1.0.70";return answered("Updated to 1.0.70\n")}
    return answered(args[0]==="models"?"You are logged in with grok.com.\n":`grok ${version} (4220f3b224a6)\n`);
  }});
  const update=statusOf(await fx.manager.snapshot({refresh:true}),"grok").update;
  assert.deepEqual([update.current,update.latest,update.canUpdate,update.command],["1.0.41","1.0.70",true,shownCommand(binary,["update"],"win32")]);
  const installed=await fx.manager.install("grok");
  const ran=fx.calls.filter(call=>call.args[0]==="update");
  assert.deepEqual(ran.map(call=>[call.command,"GROK_DISABLE_AUTOUPDATER" in call.env]),[[binary,false]],"Grok's own updater, which its status checks keep off");
  assert.equal(installed.status.version,"grok 1.0.70 (4220f3b224a6)");
  // A Grok Build that is not there is not Trebell's to install.
  const none=machine(root,{answer:command=>missing(command)});
  await assert.rejects(()=>none.manager.install("grok"),/^Error: Grok Build is not installed, and Trebell Code only updates it/);
  assert.deepEqual(npmCalls(none.calls),[]);
});

test("an OpenCode 2.x from npm updates @opencode/cli in its own prefix to the newest 2.x below 3.0.0, and never while 1.x holds its command",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"opencode2"),prefix=join(root,"AppData","Roaming","npm");
  await file(join(prefix,"node_modules","@opencode","cli","bin","opencode.exe"));
  const shim=await file(join(prefix,"opencode.cmd"),npmShim("node_modules\\@opencode\\cli\\bin\\opencode.exe"));
  const fx=machine(root,{answer:(command,args)=>{
    if(command==="npm")return args[0]==="--version"?answered("11.0.0\n"):answered(JSON.stringify(["2.0.24","2.2.0","2.10.1"])+"\n");
    return command.endsWith("opencode.exe")?answered("2.0.24\n"):missing(command);
  }});
  const plan=await fx.manager.installPlan("opencode"),realPrefix=realpathSync.native(prefix);
  assert.deepEqual({method:plan.method,packageName:plan.packageName,installedVersion:plan.installedVersion,targetVersion:plan.targetVersion,command:plan.command,args:plan.args},{method:"npm",packageName:"@opencode/cli",installedVersion:"2.0.24",targetVersion:"2.10.1",command:"npm",args:["install","-g","--prefix",realPrefix,"--allow-scripts=@opencode/cli","@opencode/cli@2.10.1"]});
  assert.deepEqual(npmCalls(fx.calls),["--version","view @opencode/cli@>=2.0.0 <3.0.0 version --json"],"npm names the 2.x releases only");
  // With the prefix's opencode command 1.x's, npm would refuse to replace it: nothing is asked of npm.
  await writeFile(shim,npmShim("node_modules\\opencode-ai\\bin\\opencode.exe"),"utf8");
  const before=fx.calls.length;
  await assert.rejects(()=>fx.manager.installPlan("opencode"),/^Error: npm cannot update @opencode\/cli in .*: the opencode command there runs opencode-ai, and npm does not replace another package's command\. Trebell Code changes neither install\. To update OpenCode 2\.x, uninstall opencode-ai/);
  // The forced install it names lets npm 12 run OpenCode's install script, which puts its binary in place, into that prefix.
  await assert.rejects(()=>fx.manager.installPlan("opencode"),{message:`npm cannot update @opencode/cli in ${realPrefix}: the opencode command there runs opencode-ai, and npm does not replace another package's command. Trebell Code changes neither install. To update OpenCode 2.x, uninstall opencode-ai, or run \`${shownCommand("npm",["install","-g","--prefix",realPrefix,"--allow-scripts=@opencode/cli","@opencode/cli","--force"],"win32")}\` yourself (the opencode command then runs OpenCode 2.x).`});
  assert.deepEqual(npmCalls(fx.calls.slice(before)),[]);
  // OpenCode's own installer keeps a 2.x in its line too: `opencode upgrade` to the newest 2.x, and nothing to a 3.x.
  const native=await file(join(root,"home",".opencode","bin","opencode.exe"));
  const own=machine(root,{instances:[{id:"opencode-default",kind:"opencode",binaryPath:native,environment:{}}],latest:{"@opencode/cli":"2.2.0"},answer:command=>command===native?answered("2.0.24\n"):missing(command)});
  const upgrade=await own.manager.installPlan("opencode");
  assert.deepEqual([upgrade.method,upgrade.command,upgrade.args,upgrade.targetVersion],["native",native,["upgrade","2.2.0"],"2.2.0"]);
  own.latest["@opencode/cli"]="3.0.0";
  await assert.rejects(()=>own.manager.installPlan("opencode"),/^Error: This OpenCode version is outside Trebell Code's supported range\./);
  assert.deepEqual(npmCalls(own.calls),[]);
});

test("an update whose version check times out or fails installs nothing, for every harness",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"unread"),claude=await file(join(root,"home",".local","bin","claude.exe")),grok=await file(join(root,"home",".grok","bin","grok.exe"));
  const fx=machine(root,{answer:command=>command===claude?TIMED_OUT:command===grok?exited(2,"error: config file is not valid TOML\n"):missing(command)});
  await assert.rejects(()=>fx.manager.installPlan("claude"),{message:"Trebell Code could not read the version of the Claude Code it would update: `claude --version` did not answer within 20 seconds. Nothing was installed."});
  await assert.rejects(()=>fx.manager.installPlan("grok"),{message:"Trebell Code could not read the version of the Grok Build it would update: `grok --version` exited with code 2: error: config file is not valid TOML. Nothing was installed."});
  assert.deepEqual(fx.calls.map(call=>[call.command,call.args.join(" "),call.timeoutMs]),[[claude,"--version",20_000],[grok,"--version",6000]],"nothing but the version checks ran");
  // Nor does Settings offer an Update for them, or say anything of a release, with no version to start from.
  const listed=await fx.manager.snapshot({refresh:true});
  for(const kind of ["claude","grok"]){
    const status=statusOf(listed,kind);
    assert.deepEqual([status.installed,status.versionCheckFailed,status.update.current,status.update.canUpdate,status.update.newer,status.update.message],[true,true,null,false,false,null],kind);
  }
  assert.deepEqual(fx.fetched,[],"no registry read for them");
});

test("on an SSH host npm updates Claude Code and Codex with their install scripts allowed, to the release npm names there",async()=>{
  const profile={id:"ssh-fixture",type:"ssh",cwd:"/srv/app"},asked=[],versions={claude:"2.0.0",codex:"0.163.0"};
  const releases={"@anthropic-ai/claude-code":"2.1.320","@openai/codex":"0.164.0"},kinds={"@anthropic-ai/claude-code":"claude","@openai/codex":"codex"};
  const environments={
    get:id=>id===profile.id?profile:null,
    executeArgv:async(_id,{command,args})=>{
      asked.push([command,...args].join(" "));
      if(command==="npm"&&args[0]==="--version")return {exitCode:0,stdout:"11.0.0\n",stderr:""};
      if(command==="npm"&&args[0]==="view")return {exitCode:0,stdout:JSON.stringify(releases[args[1]])+"\n",stderr:""};
      if(command==="npm"&&args[0]==="install"){const [name,version]=[args.at(-1).slice(0,args.at(-1).lastIndexOf("@")),args.at(-1).split("@").at(-1)];versions[kinds[name]]=version;return {exitCode:0,stdout:"changed 1 package\n",stderr:""}}
      if(args[0]==="--version")return {exitCode:0,stdout:(command==="codex"?"codex-cli ":"")+versions[command]+"\n",stderr:""};
      if(command==="claude"&&args[0]==="auth")return {exitCode:0,stdout:JSON.stringify({loggedIn:true}),stderr:""};
      return {exitCode:1,stdout:"",stderr:"unexpected command"};
    },
    spawnArgv:()=>{throw new Error("nothing is started on the host")},
  };
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"}});
  assert.equal((await manager.install("claude")).status.version,"2.1.320");
  assert.equal((await manager.install("codex")).status.version,"codex-cli 0.164.0");
  assert.deepEqual(asked.filter(line=>line.startsWith("npm install")),["npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.320","npm install -g --allow-scripts=@openai/codex @openai/codex@0.164.0"]);
});
