// How Trebell installs and updates a harness (AgentRuntimeManager installPlan, install, and the update reading each status of Settings'
// harness list carries), judged from where the binary the profile runs really is.
// - Who updates an install (harnessInstallOwner), one test per kind of answer: the harness's own updater, WinGet, npm's global
//   prefix, another package manager, mise, or nobody Trebell can name. The installs sit on three computers of the test's own (Ada's
//   Windows PC, Mac and Linux box), their paths built from the folders each tool's documentation names.
// - What Settings says of a release Trebell does not install itself, and what npm itself names (its newest listed release, the
//   version it recorded in a prefix).
// - Updates driven through a runner of the test's own standing in for every command (the manager's runFn, a host's executeArgv) and
//   a stand-in npm registry: an npm Claude Code updates into its own prefix with its install script allowed (on an SSH host too, and
//   Codex there), a native one runs its `claude update`, Codex's standalone tree `codex update` with CODEX_HOME at the profile's
//   shared home, Grok's own install `grok update`, an OpenCode 2.x from npm the newest 2.x below 3.0.0; a WinGet one is refused with
//   how to update it; an update the version did not follow fails, as does a binary that does not start after it; a version Trebell
//   cannot read installs nothing; and Settings is offered Update only for a newer release Trebell installs itself.
// No real harness, npm or updater runs (Codex's account read talks to a script of the test's own), and nothing is installed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { harnessInstallOwner, manualUpdateRefusal, manualUpdateText, newestListed, npmRecordedVersion, shownCommand } from "../src/harness-install-plan.mjs";

// The npm package each harness ships as.
const NPM_PACKAGE={claude:"@anthropic-ai/claude-code",codex:"@openai/codex",grok:"@xai-official/grok",opencode:"opencode-ai"};
// The arguments of npm's global install of a package, as an update runs them and Settings shows them: into prefix when the install
// has one, the package's install script allowed (npm 12 runs none unless told to), pinned to version when one is given.
const npmInstall=(name,version=null,prefix=null)=>["install","-g",...(prefix?["--prefix",prefix]:[]),`--allow-scripts=${name}`,version?`${name}@${version}`:name];

// Ada's three computers. at() spells a path from the top of the file system (on the PC, of drive C:), home() from her home, each
// through the computer's own path module.
function computer(platform,paths,top,homeFolders){
  const at=(...folders)=>paths.join(top,...folders);
  return {platform,at,home:(...folders)=>at(...homeFolders,...folders)};
}
const PC=computer("win32",win32,"C:\\",["Users","ada"]),MAC=computer("darwin",posix,"/",["Users","ada"]),LINUX=computer("linux",posix,"/",["home","ada"]);
// The PC's other drive, and the folders its environment names.
const D=(...folders)=>win32.join("D:\\",...folders);
const LOCAL=(...folders)=>PC.home("AppData","Local",...folders),ROAMING=(...folders)=>PC.home("AppData","Roaming",...folders);
const PROGRAMS=(...folders)=>PC.at("Program Files",...folders),PROGRAMS_X86=(...folders)=>PC.at("Program Files (x86)",...folders);
const PC_ENV={LOCALAPPDATA:LOCAL(),APPDATA:ROAMING(),ProgramFiles:PROGRAMS(),"ProgramFiles(x86)":PROGRAMS_X86()};
// The identifier WinGet gives its community source, the second part of a package folder's name.
const WINGET_COMMUNITY="Microsoft.Winget.Source_8wekyb3d8bbwe";
// Folders several of Ada's installs share.
const CLAUDE_LINK=LOCAL("Microsoft","WinGet","Links","claude.exe"),CLAUDE_PACKAGE=LOCAL("Microsoft","WinGet","Packages",`Anthropic.ClaudeCode_${WINGET_COMMUNITY}`,"claude.exe");
const OWN_PREFIX=D("node-global"),NPM_GLOBAL=LINUX.home(".npm-global"),NODE_TARBALL=LINUX.at("opt","node-v22.11.0-linux-x64"),MISE_NODE=LINUX.home(".local","share","mise","installs","node","22.11.0");
const MISE_WRAPPER=LINUX.home(".local","bin","claude"),MISE_NPM_TOOL=LINUX.home(".local","share","mise","installs","npm-openai-codex","0.171.0");
const CODEX_CASK=MAC.at("opt","homebrew","Caskroom","codex","0.171.0","codex-aarch64-apple-darwin");

// Who harnessInstallOwner says updates an install. found: what the profile names or PATH finds; behind: what starts behind an npm
// launcher; real: the real path of what runs. on: the computer (the PC unless said) and env its environment, present: the only
// files there besides those, scripts: the text of the small launchers it reads.
function ownerOf({kind,on=PC,env=on===PC?PC_ENV:{},found=null,behind=found,real=behind,present=[],scripts={},packageName=NPM_PACKAGE[kind],codexHome=null,grokHome=null}){
  return harnessInstallOwner(kind,{paths:{found,binary:behind,real},packageName,command:kind,platform:on.platform,env,codexHome,grokHome,
    exists:path=>present.includes(path),read:path=>scripts[path]??""});
}
// The three answers: the harness's own updater with its arguments (and its environment), npm in a prefix, or the person, with the
// tool that installed it and the command that updates it when they are known.
const updater=(args,env=null)=>env?{method:"native",args,env}:{method:"native",args};
const npmIn=prefix=>({method:"npm",prefix});
const person=(by=null,command=null)=>({method:"manual",by,command});
const CLAUDE_BY_WINGET=person("WinGet","winget upgrade Anthropic.ClaudeCode");

// Who updates each of Ada's installs, one test per kind of answer. Each row: what it shows, the install, the answer.
const OWNERS=[
  ["an install a harness's own installer made is updated by the harness itself",[
    ["Claude Code's launcher on Windows",{kind:"claude",found:PC.home(".local","bin","claude.exe")},updater(["update"])],
    ["Claude Code's launcher on Linux",{kind:"claude",on:LINUX,found:LINUX.home(".local","bin","claude")},updater(["update"])],
    ["Claude Code's launcher on macOS, a link to one of the versions it keeps",{kind:"claude",on:MAC,found:MAC.home(".local","bin","claude"),real:MAC.home(".local","share","claude","versions","2.1.307")},updater(["update"])],
    ["a profile naming one of those versions itself",{kind:"claude",on:LINUX,found:LINUX.home(".local","share","claude","versions","2.1.309")},updater(["update"])],
    ["OpenCode's own install on Windows",{kind:"opencode",found:PC.home(".opencode","bin","opencode.exe")},updater(["upgrade"])],
    ["OpenCode's own install on Linux",{kind:"opencode",on:LINUX,found:LINUX.home(".opencode","bin","opencode")},updater(["upgrade"])],
    ["Codex's standalone tree in the profile's Codex home, through the folder its installer puts on PATH",{kind:"codex",found:LOCAL("Programs","OpenAI","Codex","bin","codex.exe"),real:PC.home(".codex","packages","standalone","releases","0.171.0-x86_64","bin","codex.exe"),codexHome:PC.home(".codex")},updater(["update"],{CODEX_HOME:PC.home(".codex")})],
    ["Codex's standalone tree on Linux",{kind:"codex",on:LINUX,found:LINUX.home(".local","bin","codex"),real:LINUX.home(".codex","packages","standalone","releases","0.170.2-x86_64","bin","codex"),codexHome:LINUX.home(".codex")},updater(["update"],{CODEX_HOME:LINUX.home(".codex")})],
    ["Grok Build in its own home",{kind:"grok",found:PC.home(".grok","bin","grok.exe"),grokHome:PC.home(".grok")},updater(["update"])],
  ]],
  ["an install WinGet keeps is updated with winget upgrade, its id read from WinGet's package folder, wherever the profile finds it",[
    ["the link WinGet makes for one user, to its package",{kind:"claude",found:CLAUDE_LINK,real:CLAUDE_PACKAGE},CLAUDE_BY_WINGET],
    ["Claude Code's launcher folder holding a link to WinGet's package",{kind:"claude",found:PC.home(".local","bin","claude.exe"),real:CLAUDE_PACKAGE},CLAUDE_BY_WINGET],
    ["a package from a source of another name",{kind:"claude",found:LOCAL("Microsoft","WinGet","Packages","Anthropic.ClaudeCode_ada-mirror","claude.exe")},CLAUDE_BY_WINGET],
    ["a package for the whole machine",{kind:"codex",found:PROGRAMS("WinGet","Packages",`OpenAI.Codex_${WINGET_COMMUNITY}`,"codex.exe")},person("WinGet","winget upgrade OpenAI.Codex")],
    ["a package in the x86 Program Files",{kind:"claude",found:PROGRAMS_X86("WinGet","Packages",`Anthropic.ClaudeCode_${WINGET_COMMUNITY}`,"claude.exe")},CLAUDE_BY_WINGET],
    ["the machine's link alone, its package not named",{kind:"codex",found:PROGRAMS("WinGet","Links","codex.exe")},person("WinGet")],
    ["the user's link alone, its target not read",{kind:"claude",found:CLAUDE_LINK},person("WinGet")],
    // Windows does not tell names of its environment apart by letter case, and a copy of it keeps whatever spelling it was given.
    ["an environment spelling its names its own way",{kind:"claude",env:{localappdata:LOCAL(),PROGRAMFILES:PROGRAMS()},found:CLAUDE_LINK,real:CLAUDE_PACKAGE},CLAUDE_BY_WINGET],
    ["Grok Build linked by WinGet while its own home is there too",{kind:"grok",found:LOCAL("Microsoft","WinGet","Links","grok.exe"),real:LOCAL("Microsoft","WinGet","Packages",`xAI.GrokBuild_${WINGET_COMMUNITY}`,"grok.exe"),grokHome:PC.home(".grok")},person("WinGet","winget upgrade xAI.GrokBuild")],
  ]],
  ["an install in npm's global prefix is updated by npm in that prefix, and npm outranks the Node it runs on",[
    ["the binary behind claude.cmd in %APPDATA%\\npm",{kind:"claude",found:ROAMING("npm","node_modules","@anthropic-ai","claude-code","bin","claude.exe"),present:[ROAMING("npm","claude.cmd")]},npmIn(ROAMING("npm"))],
    ["claude.cmd itself, the package's manifest beside it",{kind:"claude",found:ROAMING("npm","claude.cmd"),present:[ROAMING("npm","node_modules","@anthropic-ai","claude-code","package.json")]},npmIn(ROAMING("npm"))],
    ["OpenCode 1.x in a prefix of the person's own on D:",{kind:"opencode",found:win32.join(OWN_PREFIX,"opencode.cmd"),behind:win32.join(OWN_PREFIX,"node_modules","opencode-ai","bin","opencode.exe"),present:[win32.join(OWN_PREFIX,"opencode.cmd")]},npmIn(OWN_PREFIX)],
    ["OpenCode 2.x there, its package @opencode/cli",{kind:"opencode",packageName:"@opencode/cli",found:win32.join(OWN_PREFIX,"opencode.cmd"),behind:win32.join(OWN_PREFIX,"node_modules","@opencode","cli","bin","opencode.exe"),present:[win32.join(OWN_PREFIX,"opencode.cmd")]},npmIn(OWN_PREFIX)],
    ["the prefix npm's own docs suggest on Linux",{kind:"claude",on:LINUX,found:posix.join(NPM_GLOBAL,"bin","claude"),real:posix.join(NPM_GLOBAL,"lib","node_modules","@anthropic-ai","claude-code","bin","claude.exe")},npmIn(NPM_GLOBAL)],
    ["a Node unpacked from its tarball",{kind:"codex",on:LINUX,found:posix.join(NODE_TARBALL,"bin","codex"),real:posix.join(NODE_TARBALL,"lib","node_modules","@openai","codex","bin","codex.js")},npmIn(NODE_TARBALL)],
    ["a Node mise installed",{kind:"codex",on:LINUX,found:posix.join(MISE_NODE,"bin","codex"),real:posix.join(MISE_NODE,"lib","node_modules","@openai","codex","bin","codex.js")},npmIn(MISE_NODE)],
    ["Homebrew's Node, its globals beside Homebrew's own",{kind:"claude",on:MAC,found:MAC.at("opt","homebrew","bin","claude"),real:MAC.at("opt","homebrew","lib","node_modules","@anthropic-ai","claude-code","cli.js")},npmIn(MAC.at("opt","homebrew"))],
    ["a global inside Homebrew's node keg",{kind:"claude",on:MAC,found:MAC.at("opt","homebrew","bin","claude"),real:MAC.at("opt","homebrew","Cellar","node","23.3.0","lib","node_modules","@anthropic-ai","claude-code","cli.js")},npmIn(MAC.at("opt","homebrew","Cellar","node","23.3.0"))],
  ]],
  ["an install another package manager keeps is the person's to update, with that manager's command for the harness's package",[
    ["Vite+ on Windows",{kind:"codex",found:LOCAL("vite-plus","bin","codex.cmd"),real:LOCAL("vite-plus","packages","@openai","codex","lib","node_modules","@openai","codex","bin","codex.js")},person("Vite+","vp install -g @openai/codex@latest")],
    ["Vite+ on Linux",{kind:"opencode",on:LINUX,found:LINUX.home(".local","share","vite-plus","bin","opencode")},person("Vite+","vp install -g opencode-ai@latest")],
    ["bun",{kind:"codex",on:LINUX,found:LINUX.home(".bun","bin","codex")},person("bun","bun add -g @openai/codex@latest")],
    // pnpm 10 runs no install script of a package unless told to, and Claude Code's puts its binary in place.
    ["pnpm on Windows",{kind:"claude",found:LOCAL("pnpm","claude.cmd"),real:LOCAL("pnpm","global","5","node_modules","@anthropic-ai","claude-code","cli.js")},person("pnpm","pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest")],
    ["pnpm on macOS",{kind:"codex",on:MAC,found:MAC.home("Library","pnpm","codex")},person("pnpm","pnpm add -g --allow-build=@openai/codex @openai/codex@latest")],
    ["pnpm on Linux",{kind:"opencode",on:LINUX,found:LINUX.home(".local","share","pnpm","opencode")},person("pnpm","pnpm add -g --allow-build=opencode-ai opencode-ai@latest")],
    ["Yarn's global folder on Windows",{kind:"codex",found:LOCAL("Yarn","bin","codex.cmd"),real:LOCAL("Yarn","Data","global","node_modules","@openai","codex","bin","codex.js")},person("Yarn","yarn global add @openai/codex@latest")],
    ["Yarn's global folder on Linux",{kind:"claude",on:LINUX,found:LINUX.home(".yarn","bin","claude"),real:LINUX.home(".config","yarn","global","node_modules","@anthropic-ai","claude-code","cli.js")},person("Yarn","yarn global add @anthropic-ai/claude-code@latest")],
    ["Volta's shim on macOS",{kind:"claude",on:MAC,found:MAC.home(".volta","bin","claude"),real:MAC.home(".volta","bin","volta-shim")},person("Volta","volta install @anthropic-ai/claude-code@latest")],
    ["Volta's shim on Windows",{kind:"codex",found:LOCAL("Volta","bin","codex.exe"),real:PROGRAMS("Volta","volta-shim.exe")},person("Volta","volta install @openai/codex@latest")],
    ["a Homebrew formula on Linux",{kind:"codex",on:LINUX,found:LINUX.at("home","linuxbrew",".linuxbrew","bin","codex"),real:LINUX.at("home","linuxbrew",".linuxbrew","Cellar","codex","0.171.0","bin","codex")},person("Homebrew","brew upgrade codex")],
    ["Codex's Homebrew cask on macOS",{kind:"codex",on:MAC,found:MAC.at("opt","homebrew","bin","codex"),real:CODEX_CASK},person("Homebrew","brew upgrade --cask codex")],
  ]],
  ["an install mise keeps is mise's to update, and Trebell names no command for it",[
    ["a mise shim",{kind:"codex",on:MAC,found:MAC.home(".local","share","mise","shims","codex")},person("mise")],
    ["a link to the mise Homebrew installed",{kind:"claude",on:MAC,found:MAC.home("bin","claude"),real:MAC.at("opt","homebrew","Cellar","mise","2025.10.4","bin","mise")},person("mise")],
    ["a wrapper where Claude Code's installer puts its launcher, running it through mise exec",{kind:"claude",on:LINUX,found:MISE_WRAPPER,scripts:{[MISE_WRAPPER]:"#!/usr/bin/env bash\nexec mise exec npm:@anthropic-ai/claude-code -- claude \"$@\"\n"}},person("mise")],
    ["a wrapper of the person's own running it through mise x",{kind:"codex",on:MAC,found:MAC.home("bin","codex"),scripts:{[MAC.home("bin","codex")]:"#!/bin/zsh\nexec mise x npm:@openai/codex@0.171.0 -- codex \"$@\"\n"}},person("mise")],
    ["a link to an npm package mise installed as a tool of its own, laid out like npm's prefix",{kind:"codex",on:LINUX,found:LINUX.home(".local","bin","codex"),real:posix.join(MISE_NPM_TOOL,"lib","node_modules","@openai","codex","bin","codex.js")},person("mise")],
  ]],
  ["an install nothing proves is the person's to update, with no tool or command named",[
    ["no path at all",{kind:"claude"},person()],
    ["a binary in a folder of the person's own",{kind:"codex",found:D("apps","codex","codex.exe")},person()],
    ["a copy of WinGet's folders on another drive",{kind:"claude",found:D("Backup","Microsoft","WinGet","Packages",`Anthropic.ClaudeCode_${WINGET_COMMUNITY}`,"claude.exe")},person()],
    ["a Codex tree in a folder whose name only starts like the profile's Codex home",{kind:"codex",on:LINUX,found:LINUX.home(".local","bin","codex"),real:LINUX.home(".codex-old","packages","standalone","releases","0.170.2-x86_64","bin","codex"),codexHome:LINUX.home(".codex")},person()],
    ["a Codex tree in another Codex home",{kind:"codex",found:LOCAL("Programs","OpenAI","Codex","bin","codex.exe"),real:D("codex-home","packages","standalone","releases","0.171.0-x86_64","bin","codex.exe"),codexHome:PC.home(".codex")},person()],
    ["Grok Build in a folder whose name only starts like its home",{kind:"grok",found:PC.home(".grok-old","bin","grok.exe"),grokHome:PC.home(".grok")},person()],
    ["a package in node_modules with no npm launcher beside it",{kind:"codex",found:D("projects","site","node_modules","@openai","codex","bin","codex.exe")},person()],
    ["a package inside another package, a launcher beside that package",{kind:"claude",found:D("tools","node_modules","agent-kit","node_modules","@anthropic-ai","claude-code","bin","claude.exe"),present:[D("tools","node_modules","agent-kit","claude.cmd")]},person()],
    ["a project's node_modules on macOS",{kind:"claude",on:MAC,found:MAC.home("code","site","node_modules",".bin","claude"),real:MAC.home("code","site","node_modules","@anthropic-ai","claude-code","cli.js")},person()],
    ["a project named vite-plus",{kind:"codex",on:MAC,found:MAC.home("code","vite-plus","bin","codex"),real:MAC.home("code","vite-plus","node_modules","@openai","codex","bin","codex.js")},person()],
    ["OpenCode 1.x's package where OpenCode 2.x's is asked for",{kind:"opencode",packageName:"@opencode/cli",found:win32.join(OWN_PREFIX,"opencode.cmd"),behind:win32.join(OWN_PREFIX,"node_modules","opencode-ai","bin","opencode.exe"),present:[win32.join(OWN_PREFIX,"opencode.cmd")]},person()],
  ]],
];
for(const [title,rows] of OWNERS)test(title,()=>{for(const [shows,install,answer] of rows)assert.deepEqual(ownerOf(install),answer,shows)});

// What Settings says of a newer release Trebell does not install itself, and the refusal of an Update pressed for it. Each row: the
// install (its newest release, the file the profile runs, who installed it and the command that updates it when known), the note
// and the refusal. With nobody known, the refusal says which installs Trebell updates, "a" or "an" before the harness's name. pnpm
// takes --allow-build from 10.4 on and an older pnpm refuses an option it does not know, so only its command carries a note.
const PNPM_NOTE="(pnpm 10.4 or later; on an older pnpm, leave out `--allow-build`)",PNPM_SHIM=LOCAL("pnpm","claude.cmd"),YARN_SHIM=LOCAL("Yarn","bin","claude.cmd");
const MISE_SHIM=MAC.home(".local","share","mise","shims","codex"),STRAY_OPENCODE=D("apps","opencode","opencode.exe"),STRAY_CODEX=D("apps","codex","codex.exe");
const WORDS=[
  [{name:"Codex",latest:"0.172.0",binary:CODEX_CASK,by:"Homebrew",command:"brew upgrade --cask codex"},
    `Codex 0.172.0 is available. This profile runs ${CODEX_CASK}, installed by Homebrew: run \`brew upgrade --cask codex\` to update it.`,
    `Trebell Code does not update the Codex at ${CODEX_CASK}, installed by Homebrew: run \`brew upgrade --cask codex\` to update it. Nothing was installed.`],
  [{name:"Codex",latest:"0.172.0",binary:MISE_SHIM,by:"mise"},
    `Codex 0.172.0 is available. This profile runs ${MISE_SHIM}, installed by mise: update it with mise.`,
    `Trebell Code does not update the Codex at ${MISE_SHIM}, installed by mise: update it with mise. Nothing was installed.`],
  [{name:"OpenCode",latest:"1.19.4",binary:STRAY_OPENCODE},
    `OpenCode 1.19.4 is available. This profile runs ${STRAY_OPENCODE}, and Trebell Code cannot tell what installed it: update it the way you installed it.`,
    `Trebell Code updates an OpenCode installed by npm or by OpenCode's own installer, and cannot tell what installed ${STRAY_OPENCODE}: update it the way you installed it. Nothing was installed.`],
  [{name:"Codex",latest:"0.172.0",binary:STRAY_CODEX},
    `Codex 0.172.0 is available. This profile runs ${STRAY_CODEX}, and Trebell Code cannot tell what installed it: update it the way you installed it.`,
    `Trebell Code updates a Codex installed by npm or by Codex's own installer, and cannot tell what installed ${STRAY_CODEX}: update it the way you installed it. Nothing was installed.`],
  [{name:"Claude Code",latest:"2.1.312",binary:PNPM_SHIM,by:"pnpm",command:"pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest"},
    `Claude Code 2.1.312 is available. This profile runs ${PNPM_SHIM}, installed by pnpm: run \`pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest\` to update it ${PNPM_NOTE}.`,
    `Trebell Code does not update the Claude Code at ${PNPM_SHIM}, installed by pnpm: run \`pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest\` to update it ${PNPM_NOTE}. Nothing was installed.`],
  [{name:"Claude Code",latest:"2.1.312",binary:YARN_SHIM,by:"Yarn",command:"yarn global add @anthropic-ai/claude-code@latest"},
    `Claude Code 2.1.312 is available. This profile runs ${YARN_SHIM}, installed by Yarn: run \`yarn global add @anthropic-ai/claude-code@latest\` to update it.`,
    `Trebell Code does not update the Claude Code at ${YARN_SHIM}, installed by Yarn: run \`yarn global add @anthropic-ai/claude-code@latest\` to update it. Nothing was installed.`],
];
test("Settings' words for a newer release Trebell does not install itself, and for an Update it refuses",()=>{
  for(const [install,note,refusal] of WORDS)assert.deepEqual([manualUpdateText(install),manualUpdateRefusal(install)],[note,refusal],`${install.by} ${install.binary}`);
});

test("what npm itself names: the newest release it lists, and the version it recorded in a prefix",()=>{
  // `npm view <package>@<range> version --json` prints one quoted version, or a list in no order to rely on when several match: the
  // newest by version wins, its parts compared as numbers.
  assert.deepEqual(['[\n  "1.10.9",\n  "1.9.0",\n  "1.10.10"\n]\n','"2.1.307"\n',""].map(newestListed),["1.10.10","2.1.307",null]);
  // The manifest npm wrote for the package: <prefix>/lib/node_modules/<package> on Linux and macOS, <prefix>\node_modules\<package>
  // on Windows. A prerelease, which Trebell's checks cannot compare, is none, as is a package npm has no manifest of.
  const manifests=new Map([
    [posix.join(NPM_GLOBAL,"lib","node_modules","@anthropic-ai","claude-code","package.json"),{name:"@anthropic-ai/claude-code",version:"2.1.307"}],
    [posix.join(NODE_TARBALL,"lib","node_modules","@openai","codex","package.json"),{name:"@openai/codex",version:"0.172.0-alpha.3"}],
    [win32.join(OWN_PREFIX,"node_modules","opencode-ai","package.json"),{name:"opencode-ai",version:"1.18.30"}],
  ]);
  const read=path=>{if(!manifests.has(path))throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`),{code:"ENOENT"});return JSON.stringify(manifests.get(path))};
  const asked=[[NPM_GLOBAL,"@anthropic-ai/claude-code","linux"],[NODE_TARBALL,"@openai/codex","linux"],[NPM_GLOBAL,"@openai/codex","linux"],[OWN_PREFIX,"opencode-ai","win32"]];
  assert.deepEqual(asked.map(([prefix,name,platform])=>npmRecordedVersion(prefix,name,{platform,read})),["2.1.307",null,null,"1.18.30"]);
});

const WINDOWS_ONLY={skip:process.platform!=="win32"&&"lays out Windows install folders"};
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const exited=(code,stderr)=>({ok:false,code,error:null,stdout:"",stderr});
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
const TIMED_OUT=Object.freeze({ok:false,code:null,error:"probe timed out",stdout:"",stderr:""});
// A stand-in for what a signed-in Grok Build's `grok models` prints: its status check looks only for "you are logged in", and no
// install test is about signing in.
const GROK_SIGNED_IN="You are logged in to Grok Build.\n";
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
function machine(root,{instances=[],answer,latest={},path="",extraEnv={},fetchImpl:registry=null}){
  const env={USERPROFILE:join(root,"home"),HOME:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),LOCALAPPDATA:join(root,"AppData","Local"),ProgramFiles:join(root,"Program Files"),PATH:path,PATHEXT:".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,TEMP:root,TMP:root,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"home",".codex"),...extraEnv};
  const calls=[],fetched=[],settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:instances};
  const state={settings:()=>({...settings}),updateSettings:patch=>Object.assign(settings,patch)};
  const runFn=async(command,args,options)=>{calls.push({command,args:[...args],env:options.env,timeoutMs:options.timeoutMs});return answer(command,args,options)};
  const fetchImpl=async url=>{
    fetched.push(String(url));const name=decodeURIComponent(String(url).split("/").slice(3,-1).join("/"));
    return name in latest?new Response(JSON.stringify({name,version:latest[name]}),{status:200,headers:{"content-type":"application/json"}}):new Response("{}",{status:404});
  };
  return {manager:new AgentRuntimeManager({state,env,platform:"win32",runFn,fetchImpl:registry||fetchImpl}),calls,fetched,env,latest};
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
  // The listings that answer a switch or a save read no newest release: until Settings' own listing has, no newer release is known.
  assert.deepEqual(statusOf(await fx.manager.snapshot(),"claude").update?.latest,null);
  assert.deepEqual([fx.fetched,npmCalls(fx.calls)],[[],[]]);
  const update=statusOf(await fx.manager.snapshot({refresh:true}),"claude").update;
  const command=shownCommand("npm",npmInstall("@anthropic-ai/claude-code","2.1.320",realPrefix),"win32");
  assert.deepEqual(update,{current:"2.1.300",latest:"2.1.320",newer:true,canUpdate:true,command,binary:real,message:null});
  // npm itself names the newest release of an install it updates, as that update will (through the person's npm registry and proxy),
  // so nothing reads npm's public registry for it.
  assert.deepEqual([fx.fetched,npmCalls(fx.calls)],[[],["view @anthropic-ai/claude-code version --json"]]);
  const installed=await fx.manager.install("claude");
  assert.deepEqual(npmCalls(fx.calls),["view @anthropic-ai/claude-code version --json","--version","view @anthropic-ai/claude-code version --json",npmInstall("@anthropic-ai/claude-code","2.1.320",realPrefix).join(" ")]);
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

// A stand-in for Codex's app server, answering initialize and account/read as a signed-in Codex does, at launcher: a node script
// of the test's own behind it.
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
    return answered(args[0]==="models"?GROK_SIGNED_IN:`grok ${version} (4220f3b224a6)\n`);
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
  assert.deepEqual({method:plan.method,packageName:plan.packageName,installedVersion:plan.installedVersion,targetVersion:plan.targetVersion,command:plan.command,args:plan.args},{method:"npm",packageName:"@opencode/cli",installedVersion:"2.0.24",targetVersion:"2.10.1",command:"npm",args:npmInstall("@opencode/cli","2.10.1",realPrefix)});
  assert.deepEqual(npmCalls(fx.calls),["--version","view @opencode/cli@>=2.0.0 <3.0.0 version --json"],"npm names the 2.x releases only");
  // With the prefix's opencode command 1.x's, npm would refuse to replace it: nothing is asked of npm.
  await writeFile(shim,npmShim("node_modules\\opencode-ai\\bin\\opencode.exe"),"utf8");
  const before=fx.calls.length;
  await assert.rejects(()=>fx.manager.installPlan("opencode"),/^Error: npm cannot update @opencode\/cli in .*: the opencode command there runs opencode-ai, and npm does not replace another package's command\. Trebell Code changes neither install\. To update OpenCode 2\.x, uninstall opencode-ai/);
  // The forced install it names lets npm 12 run OpenCode's install script, which puts its binary in place, into that prefix, and
  // keeps to the 2.x line: npm installs the newest 2.x, never a 3.0 that has become @opencode/cli's latest.
  const refusal=`npm cannot update @opencode/cli in ${realPrefix}: the opencode command there runs opencode-ai, and npm does not replace another package's command. Trebell Code changes neither install. To update OpenCode 2.x, uninstall opencode-ai, or run \`${shownCommand("npm",[...npmInstall("@opencode/cli","2",realPrefix),"--force"],"win32")}\` yourself (the opencode command then runs OpenCode 2.x).`;
  await assert.rejects(()=>fx.manager.installPlan("opencode"),{message:refusal});
  assert.deepEqual(npmCalls(fx.calls.slice(before)),[]);
  // Settings' note says it once a newer 2.x is out.
  const noted=statusOf(await fx.manager.snapshot({refresh:true}),"opencode").update;
  assert.deepEqual([noted.current,noted.latest,noted.newer,noted.canUpdate,noted.message],["2.0.24","2.10.1",true,false,`OpenCode 2.10.1 is available. ${refusal}`]);
  // OpenCode's own installer keeps a 2.x in its line too: `opencode upgrade` to the newest 2.x, and nothing to a 3.x.
  const native=await file(join(root,"home",".opencode","bin","opencode.exe"));
  const own=machine(root,{instances:[{id:"opencode-default",kind:"opencode",binaryPath:native,environment:{}}],latest:{"@opencode/cli":"2.2.0"},answer:command=>command===native?answered("2.0.24\n"):missing(command)});
  const upgrade=await own.manager.installPlan("opencode");
  assert.deepEqual([upgrade.method,upgrade.command,upgrade.args,upgrade.targetVersion],["native",native,["upgrade","2.2.0"],"2.2.0"]);
  assert.deepEqual(npmCalls(own.calls),[]);
  // Once 3.0.0 is npm's latest, the newest 2.x is still what it updates to, as npm's own range does for one from npm: the package's
  // document lists every release, and is read only then.
  const asked=[],releases=["2.0.24","2.2.0","2.3.1","3.0.0","0.0.0-dev-96"];
  const registry=async url=>{
    asked.push(String(url));
    if(String(url).endsWith("/latest"))return Response.json({name:"@opencode/cli",version:"3.0.0"});
    return Response.json({name:"@opencode/cli","dist-tags":{latest:"3.0.0"},versions:Object.fromEntries(releases.map(version=>[version,{version}]))});
  };
  const later=machine(root,{instances:[{id:"opencode-default",kind:"opencode",binaryPath:native,environment:{}}],fetchImpl:registry,answer:command=>command===native?answered("2.0.24\n"):missing(command)});
  const second=await later.manager.installPlan("opencode");
  assert.deepEqual([second.method,second.args,second.targetVersion],["native",["upgrade","2.3.1"],"2.3.1"]);
  assert.deepEqual(asked,["https://registry.npmjs.org/%40opencode%2Fcli/latest","https://registry.npmjs.org/%40opencode%2Fcli"]);
  // Settings offers that update too.
  const offered=statusOf(await later.manager.snapshot({refresh:true}),"opencode").update;
  assert.deepEqual([offered.current,offered.latest,offered.newer,offered.canUpdate,offered.command],["2.0.24","2.3.1",true,true,shownCommand(native,["upgrade","2.3.1"],"win32")]);
});

// Only a 2.x looks for its line's newest release in its package's list of every release, as @opencode/cli's latest can be a 3.x.
// Any other OpenCode reads npm's latest alone, an update keeping it only in line: an OpenCode 0.x, which Trebell rates broken below
// 1.14.19, gets no Update and no note, and opencode-ai's list (some 15 MB) is never read for it, on this machine or on a host.
test("an OpenCode 0.x is offered no update to the newest 0.x, and nothing reads opencode-ai's list of every release for it",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"opencode0"),asked=[],releases=["0.15.0","0.15.31","1.14.19","1.19.4"];
  const registry=async url=>{
    asked.push(String(url));
    if(String(url).endsWith("/latest"))return Response.json({name:"opencode-ai",version:"1.19.4"});
    return Response.json({name:"opencode-ai","dist-tags":{latest:"1.19.4"},versions:Object.fromEntries(releases.map(version=>[version,{version}]))});
  };
  const listOnly=()=>asked.filter(url=>!url.endsWith("/latest"));
  // OpenCode's own installer: no `opencode upgrade 0.15.31`, and an Update pressed from an older page says why nothing was installed.
  const native=await file(join(root,"home",".opencode","bin","opencode.exe"));
  const own=machine(root,{instances:[{id:"opencode-default",kind:"opencode",binaryPath:native,environment:{}}],fetchImpl:registry,answer:command=>command===native?answered("0.15.0\n"):missing(command)});
  const update=statusOf(await own.manager.snapshot({refresh:true}),"opencode").update;
  assert.deepEqual([update.current,update.latest,update.newer,update.message],["0.15.0",null,false,null]);
  await assert.rejects(()=>own.manager.installPlan("opencode"),{message:"The newest OpenCode release, 1.19.4, is not an OpenCode 0.x like the one this profile runs (0.15.0), and Trebell Code updates an OpenCode only within its own line (2.x converts OpenCode's shared database in place). Nothing was installed."});
  // One in a folder nothing proves: no note naming a 0.x to update to.
  const loose=await file(join(root,"tools","opencode.exe"));
  const manual=machine(root,{instances:[{id:"opencode-default",kind:"opencode",binaryPath:loose,environment:{}}],fetchImpl:registry,answer:command=>command===loose?answered("0.15.0\n"):missing(command)});
  const note=statusOf(await manual.manager.snapshot({refresh:true}),"opencode").update;
  assert.deepEqual([note.current,note.latest,note.newer,note.message],["0.15.0",null,false,null]);
  // A host's: no `npm install -g opencode-ai@0.15.31` offered.
  const profile={id:"ssh-fixture",type:"ssh",cwd:"/srv/app"};
  const environments={get:id=>id===profile.id?profile:null,spawnArgv:()=>{throw new Error("nothing is started on the host")},executeArgv:async(_id,{command,args})=>command==="opencode"&&args[0]==="--version"?{exitCode:0,stdout:"0.15.0\n",stderr:""}:{exitCode:1,stdout:"",stderr:"unexpected command"}};
  const host=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/deploy"},fetchImpl:registry});
  const remote=statusOf(await host.snapshot({refresh:true}),"opencode").update;
  assert.deepEqual([remote.current,remote.latest,remote.newer,remote.message],["0.15.0",null,false,null]);
  assert.deepEqual(listOnly(),[],"only npm's latest was read");
});

// Settings' own harness list reads each harness's newest release beside its status check, and never waits long on a registry that
// does not answer (packets dropped): it answers about when the checks do, and the release, once read, is the next listing's.
test("Settings' harness list does not wait on a registry that does not answer, and its next listing has the release once it is read",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"slow-registry"),binary=await file(join(root,"home",".local","bin","claude.exe")),asked=[];
  // A registry whose answer comes only when the test gives it, and that gives up as fetch does when the request's time runs out.
  const fetchImpl=(url,{signal}={})=>new Promise((resolve,reject)=>{asked.push({url:String(url),resolve});signal?.addEventListener("abort",()=>reject(signal.reason||new Error("aborted")))});
  const fx=machine(root,{fetchImpl,answer:(command,args)=>command!==binary?missing(command):args[0]==="--version"?answered("2.1.300 (Claude Code)\n"):answered(JSON.stringify({loggedIn:true}))});
  const started=Date.now(),first=statusOf(await fx.manager.snapshot({refresh:true}),"claude"),took=Date.now()-started;
  assert.ok(took<3000,`the list answered in ${took} ms, not after the registry's 4 s`);
  assert.deepEqual([first.version,first.update.current,first.update.latest,first.update.newer],["2.1.300 (Claude Code)","2.1.300",null,false],"no release known yet, so no Update");
  assert.deepEqual(asked.map(item=>item.url),["https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest"],"read once, beside the check");
  // The registry answers later: the next listing has the release, and reads it no more.
  asked[0].resolve(new Response(JSON.stringify({version:"2.1.320"}),{status:200,headers:{"content-type":"application/json"}}));
  for(let round=0;round<50;round++)await new Promise(resolve=>setImmediate(resolve));
  const next=statusOf(await fx.manager.snapshot({refresh:true}),"claude").update;
  assert.deepEqual([next.latest,next.newer,next.canUpdate,next.command],["2.1.320",true,true,shownCommand(binary,["update"],"win32")]);
  assert.equal(asked.length,1);
});

// A status check slower than that wait (Muse Code's starts a host, OpenCode's a server) begins its release read only once it ends:
// the read still has its own time, so a registry that answers shows on the first listing.
test("a harness whose status check is slow still shows its newest release on Settings' first listing",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"slow-check"),binary=await file(join(root,"home",".local","bin","claude.exe"));
  const slowly=value=>new Promise(resolve=>setTimeout(()=>resolve(value),1800));
  const fx=machine(root,{latest:{"@anthropic-ai/claude-code":"2.1.320"},answer:(command,args)=>command!==binary?missing(command):args[0]==="--version"?slowly(answered("2.1.300 (Claude Code)\n")):answered(JSON.stringify({loggedIn:true}))});
  const update=statusOf(await fx.manager.snapshot({refresh:true}),"claude").update;
  assert.deepEqual([update.current,update.latest,update.newer],["2.1.300","2.1.320",true]);
});

// A read that answers while the listing still waits for a slower check (OpenCode's server, Muse Code's host, a cold start) is in
// that listing: no read gives up while the list is held by a check anyway, and none holds it longer.
test("a newest release that answers while another harness's status check still runs shows on that listing",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"slower-check"),claude=await file(join(root,"home",".local","bin","claude.exe")),grok=await file(join(root,"home",".grok","bin","grok.exe"));
  const later=(ms,value)=>new Promise(resolve=>setTimeout(()=>resolve(value),ms));
  // The registry names Claude Code's newest release after 2.5 s, past the 1.5 s a listing waits for a read; Grok Build's check takes 4 s.
  const fetchImpl=async url=>{
    const name=decodeURIComponent(String(url).split("/").slice(3,-1).join("/")),claudeCode=name==="@anthropic-ai/claude-code";
    return later(claudeCode?2500:0,new Response(JSON.stringify({version:claudeCode?"2.1.320":"1.0.41"}),{status:200,headers:{"content-type":"application/json"}}));
  };
  const fx=machine(root,{fetchImpl,answer:(command,args)=>{
    if(command===claude)return answered(args[0]==="--version"?"2.1.300 (Claude Code)\n":JSON.stringify({loggedIn:true}));
    if(command===grok)return args[0]==="--version"?later(4000,answered("grok 1.0.41 (4220f3b224a6)\n")):answered(GROK_SIGNED_IN);
    return missing(command);
  }});
  const started=Date.now(),listed=await fx.manager.snapshot({refresh:true}),took=Date.now()-started,update=statusOf(listed,"claude").update;
  assert.deepEqual([update.current,update.latest,update.newer,update.canUpdate],["2.1.300","2.1.320",true,true],"Claude Code's release came while Grok Build's check ran");
  assert.deepEqual([statusOf(listed,"grok").version,statusOf(listed,"grok").update.newer],["grok 1.0.41 (4220f3b224a6)",false]);
  assert.ok(took<5500,`the list answered once Grok Build's check had, in ${took} ms`);
});

// An OpenCode profile on a server of its own still runs this machine's opencode, whose version its row shows and its Update installs:
// Settings offers that Update only for a newer release of it, as for any other profile, never for every listing.
test("an OpenCode profile with a server of its own is offered Update only for a newer release of the opencode it runs here",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"opencode-server"),prefix=join(root,"AppData","Roaming","npm");
  await file(join(prefix,"node_modules","opencode-ai","bin","opencode.exe"));
  await file(join(prefix,"opencode.cmd"),npmShim("node_modules\\opencode-ai\\bin\\opencode.exe"));
  const instances=[{id:"opencode-server",kind:"opencode",displayName:"OpenCode server",serverUrl:"http://127.0.0.1:1",environment:{}}];
  const listed=async release=>{
    const fx=machine(root,{instances,latest:{"opencode-ai":release},answer:(command,args)=>{
      if(command==="npm")return args[0]==="view"?answered(JSON.stringify(release)+"\n"):answered("11.0.0\n");
      return command.endsWith("opencode.exe")?answered("1.18.30\n"):missing(command);
    }});
    return {fx,status:(await fx.manager.snapshot({refresh:true})).statuses.find(item=>item.id==="opencode-server")};
  };
  const {status}=await listed("1.19.4"),realPrefix=realpathSync.native(prefix);
  assert.deepEqual([status.installed,status.version],[true,"1.18.30"]);
  assert.deepEqual(status.update,{current:"1.18.30",latest:"1.19.4",newer:true,canUpdate:true,command:shownCommand("npm",npmInstall("opencode-ai","1.19.4",realPrefix),"win32"),binary:realpathSync.native(join(prefix,"node_modules","opencode-ai","bin","opencode.exe")),message:null});
  // The newest already: no Update for it.
  const current=(await listed("1.18.30")).status.update;
  assert.deepEqual([current.current,current.latest,current.newer,current.message],["1.18.30","1.18.30",false,null]);
});

// The placeholder claude.exe an install whose script never ran leaves (F1) does not start, so its version cannot be read: when npm's
// prefix proves who installed it, Update installs the version npm recorded there again, its install script allowed, and the binary
// must then start. Its package needs no version, as Codex's and Grok Build's do not; a check that only ran out of time says nothing of
// it. npm's newest release is not what it installs: the person's channel (Claude Code's stable, Grok Build's alpha) stays theirs.
test("a Claude Code, Codex or Grok Build in npm's prefix that does not start is offered Update, which installs the version npm recorded there again and checks it then starts",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"npm-repair"),prefix=join(root,"AppData","Roaming","npm");
  const claude=await file(join(prefix,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));
  await file(join(prefix,"node_modules","@anthropic-ai","claude-code","package.json"),JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.308"}));
  await file(join(prefix,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  // npm's Codex keeps its binary in its platform package inside its own.
  const [platformPackage,triple]=process.arch==="arm64"?["codex-win32-arm64","aarch64-pc-windows-msvc"]:["codex-win32-x64","x86_64-pc-windows-msvc"];
  const codex=await file(join(prefix,"node_modules","@openai","codex","node_modules","@openai",platformPackage,"vendor",triple,"codex","codex.exe"));
  await file(join(prefix,"node_modules","@openai","codex","package.json"),JSON.stringify({name:"@openai/codex",version:"0.163.0"}));
  await file(join(prefix,"codex.cmd"),"@ECHO off\r\nnode \"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n");
  let claudeVersion=null,timesOut=false;
  const fx=machine(root,{answer:(command,args)=>{
    if(command==="npm"){
      if(args[0]==="view")return answered(JSON.stringify(args[1]==="@openai/codex"?"0.164.0":"2.1.320")+"\n");
      if(args[0]==="install"&&args.at(-1)==="@anthropic-ai/claude-code@2.1.308")claudeVersion="2.1.308";
      return answered(args[0]==="--version"?"11.0.0\n":"added 1 package in 9s\n");
    }
    if(command===claude){
      if(timesOut)return TIMED_OUT;
      if(args[0]==="--version")return claudeVersion?answered(claudeVersion+" (Claude Code)\n"):exited(1,"Error: claude native binary not installed.\n");
      return answered(JSON.stringify({loggedIn:true}));
    }
    // A placeholder Windows cannot start.
    if(command===codex)return {ok:false,code:null,error:"spawn UNKNOWN",stdout:"",stderr:""};
    return missing(command);
  }});
  const realPrefix=realpathSync.native(prefix),listed=await fx.manager.snapshot({refresh:true});
  const reinstall=(name,version)=>shownCommand("npm",npmInstall(name,version,realPrefix),"win32");
  assert.deepEqual(statusOf(listed,"claude").update,{current:null,latest:"2.1.308",newer:true,canUpdate:true,command:reinstall("@anthropic-ai/claude-code","2.1.308"),binary:realpathSync.native(claude),message:null});
  assert.deepEqual(statusOf(listed,"codex").update,{current:null,latest:"0.163.0",newer:true,canUpdate:true,command:reinstall("@openai/codex","0.163.0"),binary:realpathSync.native(codex),message:null});
  const installed=await fx.manager.install("claude");
  assert.deepEqual([installed.method,installed.targetVersion,installed.status.version],["npm","2.1.308","2.1.308 (Claude Code)"]);
  assert.deepEqual(npmCalls(fx.calls).filter(line=>line.startsWith("install")),[npmInstall("@anthropic-ai/claude-code","2.1.308",realPrefix).join(" ")]);
  // A reinstall after which the binary still does not start says so.
  await assert.rejects(()=>fx.manager.install("codex"),{message:`Codex 0.163.0 was installed, but the Codex this profile runs (${codex}) did not start: spawn UNKNOWN.`});
  assert.deepEqual(npmCalls(fx.calls).filter(line=>line.startsWith("view")),[],"npm's newest release was never asked for");
  // One whose check only ran out of time is not reinstalled.
  timesOut=true;
  await assert.rejects(()=>fx.manager.installPlan("claude"),{message:"Trebell Code could not read the version of the Claude Code it would update: `claude --version` did not answer within 30 seconds. Nothing was installed."});
});

// Grok Build from npm (@xai-official/grok, which PATH finds through npm's launcher) whose bootstrap finds no platform binary, as when
// npm did not download its platform package, is installed there again the same way, at the version npm recorded (1.0.71 from its
// alpha tag, never npm's older latest 1.0.70), and must then start.
test("a Grok Build in npm's prefix that does not start is offered Update too, which installs the @xai-official/grok npm recorded there again",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"npm-repair-grok"),prefix=join(root,"AppData","Roaming","npm");
  const grok=await file(join(prefix,"node_modules","@xai-official","grok","bin","grok.exe"));
  await file(join(prefix,"node_modules","@xai-official","grok","package.json"),JSON.stringify({name:"@xai-official/grok",version:"1.0.71"}));
  await file(join(prefix,"grok.cmd"),npmShim("node_modules\\@xai-official\\grok\\bin\\grok.exe"));
  let grokVersion=null;
  const fx=machine(root,{path:prefix,answer:(command,args)=>{
    if(command==="npm"){
      if(args[0]==="view")return answered("\"1.0.70\"\n");
      if(args[0]==="install"&&args.at(-1)==="@xai-official/grok@1.0.71")grokVersion="1.0.71";
      return answered(args[0]==="--version"?"11.0.0\n":"added 1 package in 9s\n");
    }
    if(command==="grok"){
      if(args[0]==="--version")return grokVersion?answered(`grok ${grokVersion} (4220f3b224a6)\n`):exited(1,"@xai-official/grok: no platform binary installed for win32-x64.\n  Expected sibling package @xai-official/grok-win32-x64.\n");
      return answered(GROK_SIGNED_IN);
    }
    return missing(command);
  }});
  const realPrefix=realpathSync.native(prefix),update=statusOf(await fx.manager.snapshot({refresh:true}),"grok").update;
  const command=shownCommand("npm",npmInstall("@xai-official/grok","1.0.71",realPrefix),"win32");
  assert.deepEqual(update,{current:null,latest:"1.0.71",newer:true,canUpdate:true,command,binary:realpathSync.native(grok),message:null});
  const installed=await fx.manager.install("grok");
  assert.deepEqual([installed.method,installed.targetVersion,installed.status.version],["npm","1.0.71","grok 1.0.71 (4220f3b224a6)"]);
  assert.deepEqual(npmCalls(fx.calls).filter(line=>line.startsWith("install")),[command.slice(4)]);
  assert.equal(fx.calls.some(call=>call.command==="grok"&&call.args[0]==="update"),false,"Grok's own updater is not what installed it");
});

// A --version that fails for the harness's own reasons says nothing of its install, which no reinstall mends: a Grok Build in npm's
// prefix whose config file is not valid TOML, or a Claude Code there stopped by a signal, is offered no Update and installs nothing,
// as before; nor is a placeholder whose version npm did not record (no package manifest), which Trebell cannot install again.
test("a harness in npm's prefix whose check fails for its own reasons, not its install's, is offered no reinstall, nor one whose version npm did not record",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"npm-no-repair"),prefix=join(root,"AppData","Roaming","npm");
  const grok=await file(join(prefix,"node_modules","@xai-official","grok","bin","grok.exe"));
  await file(join(prefix,"node_modules","@xai-official","grok","package.json"),JSON.stringify({name:"@xai-official/grok",version:"1.0.70"}));
  await file(join(prefix,"grok.cmd"),npmShim("node_modules\\@xai-official\\grok\\bin\\grok.exe"));
  const claude=await file(join(prefix,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));
  await file(join(prefix,"node_modules","@anthropic-ai","claude-code","package.json"),JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.312"}));
  await file(join(prefix,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  const fx=machine(root,{path:prefix,answer:(command,args)=>{
    if(command==="npm")return answered(args[0]==="view"?"\"1.0.70\"\n":"11.0.0\n");
    if(command==="grok")return exited(2,"error: config file is not valid TOML\n");
    if(command===claude)return {ok:false,code:null,signal:"SIGKILL",error:null,stdout:"",stderr:""};
    return missing(command);
  }});
  const listed=await fx.manager.snapshot({refresh:true});
  for(const [kind,binary,said] of [["grok",grok,"Grok Build is installed but `grok --version` exited with code 2: error: config file is not valid TOML"],["claude",claude,"Claude Code is installed but `claude --version` was stopped by SIGKILL."]]){
    const status=statusOf(listed,kind);
    assert.deepEqual([status.installed,status.versionCheckFailed,status.message],[true,true,said],kind);
    assert.deepEqual(status.update,{current:null,latest:null,newer:false,canUpdate:false,command:null,binary:realpathSync.native(binary),message:null},kind);
  }
  await assert.rejects(()=>fx.manager.installPlan("grok"),{message:"Trebell Code could not read the version of the Grok Build it would update: `grok --version` exited with code 2: error: config file is not valid TOML. Nothing was installed."});
  await assert.rejects(()=>fx.manager.installPlan("claude"),{message:"Trebell Code could not read the version of the Claude Code it would update: `claude --version` was stopped by SIGKILL. Nothing was installed."});
  assert.deepEqual(npmCalls(fx.calls),[],"npm was not asked for anything");
  // The placeholder's own words, but no version npm recorded: nothing to install again.
  const bare=join(root,"bare","npm"),placeholder=await file(join(bare,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));
  await file(join(bare,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  const unrecorded=machine(root,{instances:[{id:"claude-default",kind:"claude",binaryPath:placeholder,environment:{}}],answer:(command,args)=>command==="npm"?answered(args[0]==="view"?"\"2.1.312\"\n":"11.0.0\n"):command===placeholder?exited(1,"Error: claude native binary not installed.\n"):missing(command)});
  const offered=statusOf(await unrecorded.manager.snapshot({refresh:true}),"claude").update;
  assert.deepEqual([offered.current,offered.latest,offered.newer,offered.canUpdate],[null,null,false,false]);
  await assert.rejects(()=>unrecorded.manager.installPlan("claude"),{message:"Trebell Code could not read the version of the Claude Code it would update: `claude --version` exited with code 1: Error: claude native binary not installed. Nothing was installed."});
  assert.deepEqual(npmCalls(unrecorded.calls),[]);
});

test("an update whose version check times out or fails installs nothing, for every harness",WINDOWS_ONLY,async t=>{
  const root=await tempRoot(t,"unread"),claude=await file(join(root,"home",".local","bin","claude.exe")),grok=await file(join(root,"home",".grok","bin","grok.exe"));
  const fx=machine(root,{answer:command=>command===claude?TIMED_OUT:command===grok?exited(2,"error: config file is not valid TOML\n"):missing(command)});
  await assert.rejects(()=>fx.manager.installPlan("claude"),{message:"Trebell Code could not read the version of the Claude Code it would update: `claude --version` did not answer within 30 seconds. Nothing was installed."});
  await assert.rejects(()=>fx.manager.installPlan("grok"),{message:"Trebell Code could not read the version of the Grok Build it would update: `grok --version` exited with code 2: error: config file is not valid TOML. Nothing was installed."});
  assert.deepEqual(fx.calls.map(call=>[call.command,call.args.join(" "),call.timeoutMs]),[[claude,"--version",30_000],[grok,"--version",6000]],"nothing but the version checks ran");
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
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/deploy"}});
  assert.equal((await manager.install("claude")).status.version,"2.1.320");
  assert.equal((await manager.install("codex")).status.version,"codex-cli 0.164.0");
  assert.deepEqual(asked.filter(line=>line.startsWith("npm install")),[["npm",...npmInstall("@anthropic-ai/claude-code","2.1.320")].join(" "),["npm",...npmInstall("@openai/codex","0.164.0")].join(" ")]);
});
