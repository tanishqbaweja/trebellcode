// Who installed a harness binary (harnessInstallOwner), for the layouts tests/harness-install-plan.test.mjs does not lay out:
// pnpm's homes on macOS and Windows and a global store elsewhere, Vite+'s homes on Linux and macOS, Yarn's global folder on
// Windows, mise (`mise exec`, a shim on Windows, mise itself from Homebrew, an npm global of mise's own Node, scripts that only
// look like a hand-over), Homebrew on Linux and in any letter case, the npm launchers that prove a Windows prefix, a prefix at the
// root, a package inside another global package, and the default read of a launcher, which stops at 16 KiB. Also npm's install
// arguments. Nothing is installed and nothing runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { harnessInstallOwner, npmInstallArgs } from "../src/harness-install-plan.mjs";

const PACKAGES={claude:"@anthropic-ai/claude-code",codex:"@openai/codex",grok:"@xai-official/grok",opencode:"opencode-ai"};
// found: what the profile names or PATH finds; real: its real path; files: the only files there; scripts: small launchers' text.
const owner=(kind,{found,real=found,platform="linux",files=[],scripts={},command=kind})=>harnessInstallOwner(kind,{paths:{found,binary:found,real},packageName:PACKAGES[kind],command,platform,env:{},exists:path=>files.includes(path),read:path=>scripts[path]||""});
const manual=(by,command=null)=>({method:"manual",by,command});
const NOBODY=manual(null);

test("pnpm, Vite+ and Yarn keep their own globals wherever their homes are, and say how to update them",()=>{
  const pnpm=name=>manual("pnpm",`pnpm add -g --allow-build=${name} ${name}@latest`);
  assert.deepEqual(owner("codex",{platform:"darwin",found:"/Users/ana/Library/pnpm/codex"}),pnpm("@openai/codex"),"PNPM_HOME on macOS");
  assert.deepEqual(owner("opencode",{platform:"win32",found:"C:\\Users\\ana\\AppData\\Local\\pnpm\\opencode.cmd"}),pnpm("opencode-ai"),"PNPM_HOME on Windows");
  assert.deepEqual(owner("claude",{found:"/usr/local/share/pnpm/claude"}),pnpm("@anthropic-ai/claude-code"),"a shared PNPM_HOME");
  assert.deepEqual(owner("grok",{found:"/srv/tools/grok",real:"/srv/pnpm/global/5/node_modules/@xai-official/grok/bin/grok"}),pnpm("@xai-official/grok"),"a global store elsewhere");
  const vitePlus=name=>manual("Vite+",`vp install -g ${name}@latest`);
  assert.deepEqual(owner("codex",{found:"/home/ana/.vite-plus/bin/codex"}),vitePlus(PACKAGES.codex));
  assert.deepEqual(owner("claude",{platform:"darwin",found:"/Users/ana/.local/share/vite-plus/bin/claude"}),vitePlus(PACKAGES.claude));
  // A Vite+ home is .vite-plus or vite-plus under .local/share or AppData\Local, with its bin folder: a bin elsewhere is not one.
  assert.deepEqual(owner("codex",{found:"/home/ana/.vite-plus/codex"}),NOBODY);
  // Yarn's global folder on Windows, under %LOCALAPPDATA%\Yarn\Data, before npm's reading of its node_modules.
  assert.deepEqual(owner("codex",{platform:"win32",found:"C:\\Users\\ana\\AppData\\Local\\Yarn\\bin\\codex.cmd",real:"C:\\Users\\ana\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@openai\\codex\\bin\\codex.js",files:["C:\\Users\\ana\\AppData\\Local\\Yarn\\Data\\global\\codex.cmd"]}),manual("Yarn","yarn global add @openai/codex@latest"));
});

test("mise runs a binary from its installs or shims, from Homebrew's mise, or through a shebang script that hands over to it",()=>{
  const MISE=manual("mise");
  assert.deepEqual(owner("codex",{platform:"win32",found:"C:\\Users\\ana\\AppData\\Local\\mise\\shims\\codex.cmd"}),MISE,"a shim on Windows");
  // mise's shims are links to mise itself: one where Claude Code's installer puts its launcher is still mise's.
  assert.deepEqual(owner("claude",{platform:"darwin",found:"/Users/ana/.local/bin/claude",real:"/opt/homebrew/Cellar/mise/2026.10.1/bin/mise"}),MISE);
  const launcher="/home/ana/.local/bin/claude",script=text=>owner("claude",{found:launcher,scripts:{[launcher]:text}});
  assert.deepEqual(script("#!/usr/bin/env bash\nexec /usr/local/bin/mise exec claude@2 -- claude \"$@\"\n"),MISE,"mise exec");
  assert.deepEqual(script("#!/bin/sh\n$(mise\tx claude) \"$@\"\n"),MISE,"mise x after other characters");
  // Only a whole word mise followed by x or exec counts, and only in a script with a shebang.
  const OWN={method:"native",args:["update"]};
  for(const text of ["exec mise x claude -- claude","#!/bin/sh\nexec promise x claude","#!/bin/sh\nexec mise xclaude","#!/bin/sh\nexec mise executable","#!/bin/sh\nexec MISE X claude",""])assert.deepEqual(script(text),OWN,JSON.stringify(text));
  // A global of mise's own Node is npm's, in that Node's prefix; a mise tool of npm's backend is mise's.
  assert.deepEqual(owner("codex",{found:"/home/ana/.local/share/mise/installs/node/22.11.0/bin/codex",real:"/home/ana/.local/share/mise/installs/node/22.11.0/lib/node_modules/@openai/codex/bin/codex.js"}),{method:"npm",prefix:"/home/ana/.local/share/mise/installs/node/22.11.0"});
  assert.deepEqual(owner("codex",{found:"/home/ana/.local/share/mise/installs/npm-openai-codex/0.170.0/lib/node_modules/@openai/codex/bin/codex.js"}),MISE);
});

test("a Homebrew keg is read in any letter case and on Linux, and npm's global of Homebrew's Node stays npm's",()=>{
  assert.deepEqual(owner("codex",{platform:"darwin",found:"/usr/local/opt/codex/bin/codex",real:"/usr/local/cellar/codex/0.170.0/bin/codex"}),manual("Homebrew","brew upgrade codex"));
  assert.deepEqual(owner("opencode",{found:"/home/linuxbrew/.linuxbrew/bin/opencode",real:"/home/linuxbrew/.linuxbrew/Cellar/opencode/1.18.0/bin/opencode"}),manual("Homebrew","brew upgrade opencode"));
  assert.deepEqual(owner("claude",{platform:"darwin",found:"/opt/homebrew/bin/claude",real:"/opt/homebrew/CASKROOM/claude-code/2.1.0/claude"}),manual("Homebrew","brew upgrade --cask claude-code"));
  // A Cellar folder with no version folder inside is not a keg.
  assert.deepEqual(owner("codex",{platform:"darwin",found:"/opt/homebrew/Cellar/codex"}),NOBODY);
});

test("npm's prefix: a Windows one needs npm's launcher for the command beside it, and a package inside another package is not a global",()=>{
  const prefix="E:\\npm-global",real=prefix+"\\node_modules\\@openai\\codex\\bin\\codex.js",NPM={method:"npm",prefix};
  assert.deepEqual(owner("codex",{platform:"win32",found:real,files:[prefix+"\\codex.ps1"]}),NPM,"PowerShell's launcher");
  assert.deepEqual(owner("codex",{platform:"win32",found:real,files:[prefix+"\\codex"]}),NPM,"the sh launcher");
  assert.deepEqual(owner("codex",{platform:"win32",found:real,files:[prefix+"\\claude.cmd"]}),NOBODY,"another command's launcher");
  assert.deepEqual(owner("codex",{platform:"win32",found:real,files:[prefix+"\\codex.cmd"],command:null}),NOBODY,"no command to look for");
  assert.deepEqual(owner("codex",{platform:"win32",found:"C:\\npm\\node_modules\\some-tool\\node_modules\\@openai\\codex\\bin\\codex.js",files:["C:\\npm\\codex.cmd","C:\\npm\\node_modules\\some-tool\\codex.cmd"]}),NOBODY,"a package in a package");
  // A package at the root of the file system has the prefix /; the prefix keeps the path's own spelling.
  assert.deepEqual(owner("opencode",{found:"/lib/node_modules/opencode-ai/bin/opencode"}),{method:"npm",prefix:"/"});
  assert.deepEqual(owner("codex",{found:"/home/\u0130lkay/lib/node_modules/@openai/codex/bin/codex.js"}),{method:"npm",prefix:"/home/\u0130lkay"});
  // A package name is compared in any letter case, and nothing is judged without paths.
  assert.deepEqual(owner("codex",{found:"/usr/local/lib/node_modules/@OpenAI/Codex/bin/codex.js"}),{method:"npm",prefix:"/usr/local"});
  assert.deepEqual(harnessInstallOwner("codex",{paths:{},packageName:"@openai/codex"}),NOBODY);
  assert.deepEqual(harnessInstallOwner("codex",{packageName:"@openai/codex"}),NOBODY);
});

test("the default read of a launcher takes a script of up to 16 KiB, and a larger file is not read as one",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-install-owner-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  const wrapper="#!/bin/sh\nexec mise x claude -- claude \"$@\"\n";
  const judge=async(name,text)=>{
    const folder=join(root,name,".local","bin");await mkdir(folder,{recursive:true});
    const file=join(folder,"claude");await writeFile(file,text,"utf8");
    return harnessInstallOwner("claude",{paths:{found:file},packageName:PACKAGES.claude,platform:"linux"});
  };
  const padded=size=>wrapper+"#".repeat(size-wrapper.length);
  assert.deepEqual(await judge("small",wrapper),manual("mise"));
  assert.deepEqual(await judge("limit",padded(16*1024)),manual("mise"),"16 KiB is still a launcher");
  assert.deepEqual(await judge("large",padded(16*1024+1)),{method:"native",args:["update"]},"one byte more is not read");
  assert.deepEqual(harnessInstallOwner("claude",{paths:{found:join(root,"none",".local","bin","claude")},packageName:PACKAGES.claude,platform:"linux"}),{method:"native",args:["update"]},"a file that is not there reads as no script");
});

test("npm's install arguments: global, into the install's own prefix when it has one, the package's script allowed, pinned when asked",()=>{
  const allowed=name=>"--allow-scripts="+name,{codex,opencode}=PACKAGES;
  assert.deepEqual(npmInstallArgs(opencode),["install","-g",allowed(opencode),opencode]);
  assert.deepEqual(npmInstallArgs(codex,"0.170.0"),["install","-g",allowed(codex),codex+"@0.170.0"]);
  assert.deepEqual(npmInstallArgs(codex,"0.170.0","/opt/npm"),["install","-g","--prefix","/opt/npm",allowed(codex),codex+"@0.170.0"]);
  // An empty prefix is no prefix.
  assert.deepEqual(npmInstallArgs(opencode,"1.18.0",""),["install","-g",allowed(opencode),opencode+"@1.18.0"]);
});

// Each manager's home as its own variable names it, wherever that is, and the default folders its documentation gives that the
// layouts above do not show: Yarn's global bin alone, bun's global packages, Vite+ in Windows' roaming application data.
test("a manager's home is also where its own variable puts it, and its documented bin and package folders show it",()=>{
  const inEnv=(kind,found,env,platform="linux")=>harnessInstallOwner(kind,{paths:{found,binary:found,real:found},packageName:PACKAGES[kind],platform,env,exists:()=>false,read:()=>""});
  assert.deepEqual(inEnv("codex","/opt/tools/pnpm-home/codex",{PNPM_HOME:"/opt/tools/pnpm-home"}),manual("pnpm","pnpm add -g --allow-build=@openai/codex @openai/codex@latest"),"PNPM_HOME");
  assert.deepEqual(inEnv("claude","D:/tools/bun/bin/claude.exe",{bun_install:"D:\\tools\\bun"},"win32"),manual("bun","bun add -g @anthropic-ai/claude-code@latest"),"BUN_INSTALL, its name in any case");
  assert.deepEqual(inEnv("opencode","/srv/vp/bin/opencode",{VP_HOME:"/srv/vp/"}),manual("Vite+","vp install -g opencode-ai@latest"),"VP_HOME");
  assert.deepEqual(inEnv("codex","/opt/tools/pnpm-home/codex",{}),NOBODY,"the same folder with no variable naming it");
  assert.deepEqual(owner("claude",{found:"/home/ana/.yarn/bin/claude"}),manual("Yarn","yarn global add @anthropic-ai/claude-code@latest"),"Yarn's global bin");
  assert.deepEqual(owner("codex",{found:"/home/ana/.bun/install/global/node_modules/@openai/codex/bin/codex.js"}),manual("bun","bun add -g @openai/codex@latest"),"bun's global packages");
  assert.deepEqual(owner("codex",{platform:"win32",found:"C:/Users/ana/AppData/Roaming/vite-plus/bin/codex.cmd"}),manual("Vite+","vp install -g @openai/codex@latest"),"Vite+ in roaming application data");
  // Volta's shim decides before any folder: a shim inside a pnpm home is still Volta's.
  assert.deepEqual(owner("claude",{found:"/home/ana/.local/share/pnpm/claude",real:"/home/ana/.volta/bin/volta-shim"}),manual("Volta","volta install @anthropic-ai/claude-code@latest"));
});

// A variable can name a folder other installers share too (bun's installer into /usr/local, a Docker image's PNPM_HOME of
// /usr/local/bin). So a home it names counts only in the manager's own folders there, and gives way when npm's own layout, mise
// or a Homebrew keg explains the binary: Trebell keeps updating its npm globals, and never suggests a second copy beside them.
test("a home a manager's variable names counts only in its own folders, and npm's layout, mise and Homebrew come first",()=>{
  const judged=(kind,{found,real=found,env,platform="linux",files=[],scripts={}})=>harnessInstallOwner(kind,{paths:{found,binary:real,real},packageName:PACKAGES[kind],platform,env,exists:path=>files.includes(path),read:path=>scripts[path]||""});
  // Codex put in /usr/local by npm, as npm's folders documentation lays a global out: the command's link in <prefix>/bin, the
  // package in <prefix>/lib/node_modules, where Codex's package runs its bin/codex.js.
  const usrLocal="/usr/local",codexFile=["bin","codex.js"],codexLink=posix.join(usrLocal,"bin","codex");
  const npmCodex={found:codexLink,real:posix.join(usrLocal,"lib","node_modules",PACKAGES.codex,...codexFile)},NPM={method:"npm",prefix:usrLocal};
  for(const env of [{},{BUN_INSTALL:"/usr/local"},{PNPM_HOME:"/usr/local/bin"},{VP_HOME:"/usr/local"},{BUN_INSTALL:"/usr/local",PNPM_HOME:"/usr/local/bin"}])
    assert.deepEqual(judged("codex",{...npmCodex,env}),NPM,"npm's global under /usr/local with "+JSON.stringify(env));
  // On Windows npm's launcher in the prefix is its layout: a PNPM_HOME naming that prefix does not take it.
  const prefix="D:\\node-global";
  assert.deepEqual(judged("codex",{platform:"win32",found:prefix+"\\codex.cmd",real:prefix+"\\node_modules\\@openai\\codex\\bin\\codex.js",files:[prefix+"\\codex.cmd"],env:{PNPM_HOME:prefix}}),{method:"npm",prefix},"npm's prefix on Windows");
  // Each manager's own folders under the home its variable names.
  const bun=manual("bun","bun add -g @openai/codex@latest"),pnpm=manual("pnpm","pnpm add -g --allow-build=@openai/codex @openai/codex@latest"),vitePlus=manual("Vite+","vp install -g @openai/codex@latest");
  assert.deepEqual(judged("codex",{found:codexLink,real:posix.join(usrLocal,"install","global","node_modules",PACKAGES.codex,...codexFile),env:{BUN_INSTALL:usrLocal}}),bun,"bun's own global under /usr/local");
  assert.deepEqual(judged("codex",{found:"/srv/js-tools/bin/codex",env:{PNPM_HOME:"/srv/js-tools"}}),pnpm,"pnpm 11's bin folder in its home");
  assert.deepEqual(judged("codex",{found:"/srv/tools/codex",real:"/srv/js-tools/global/5/node_modules/@openai/codex/bin/codex.js",env:{PNPM_HOME:"/srv/js-tools"}}),pnpm,"pnpm's global folder in its home");
  // Each Vite+ global package is laid out like an npm prefix of its own, npm's launcher in it on Windows, but its link is in
  // VP_HOME's bin: Vite+'s.
  assert.deepEqual(judged("codex",{found:"/srv/vp/bin/codex",real:posix.join("/srv/vp","packages",PACKAGES.codex,"lib","node_modules",PACKAGES.codex,...codexFile),env:{VP_HOME:"/srv/vp"}}),vitePlus,"a Vite+ global");
  const vpPackage="D:\\vp\\packages\\@openai\\codex";
  assert.deepEqual(judged("codex",{platform:"win32",found:"D:\\vp\\bin\\codex.cmd",real:vpPackage+"\\node_modules\\@openai\\codex\\bin\\codex.js",files:[vpPackage+"\\codex.cmd"],env:{VP_HOME:"D:\\vp"}}),vitePlus,"a Vite+ global on Windows");
  // Elsewhere under a home, or a home of the root alone, says nothing.
  assert.deepEqual(judged("codex",{found:"/opt/js/tools/codex",env:{BUN_INSTALL:"/opt/js"}}),NOBODY,"outside bun's bin and global folders");
  assert.deepEqual(judged("codex",{found:"/srv/vp/bin/extra/codex",env:{VP_HOME:"/srv/vp"}}),NOBODY,"a folder below Vite+'s bin");
  assert.deepEqual(judged("codex",{found:"/bin/codex",env:{BUN_INSTALL:"/"}}),NOBODY,"BUN_INSTALL naming the root");
  // Homebrew's keg and mise explain a binary before a home a variable names.
  assert.deepEqual(judged("codex",{platform:"darwin",found:codexLink,real:posix.join(usrLocal,"Cellar","codex","0.171.0","bin","codex"),env:{PNPM_HOME:posix.join(usrLocal,"bin")}}),manual("Homebrew","brew upgrade codex"),"a Homebrew formula");
  const wrapper="/home/ana/tools/bin/claude";
  assert.deepEqual(judged("claude",{found:wrapper,env:{VP_HOME:"/home/ana/tools"},scripts:{[wrapper]:"#!/bin/sh\nexec mise x claude -- claude \"$@\"\n"}}),manual("mise"),"a script that hands over to mise");
});
