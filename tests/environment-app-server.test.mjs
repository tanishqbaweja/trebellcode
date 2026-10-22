import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { remoteCodexArgs, remoteCodexProfileSetup, sshRemotePorts, startRemoteAppServer } from "../src/environment-app-server.mjs";
import { EnvironmentManager, remoteToolPathPrelude } from "../src/environment-manager.mjs";

// A POSIX shell, as a WSL or SSH host has, where this machine has one (Git for Windows' sh, or the system's).
const posixShell=await new Promise(resolve=>execFile("sh",["-c","printf ok"],{windowsHide:true,timeout:20_000},(error,stdout)=>resolve(!error&&String(stdout)==="ok")));
function finished(child){
  return new Promise(resolve=>{
    let stdout="",stderr="";child.stdout?.on("data",chunk=>{stdout+=chunk});child.stderr?.on("data",chunk=>{stderr+=chunk});
    child.once("error",error=>resolve({code:-1,stdout,stderr:stderr+error.message}));child.once("close",code=>resolve({code,stdout,stderr}));
  });
}

test("remote harness PATH bootstrap covers Linuxbrew and common Node version managers",()=>{
  const script=remoteToolPathPrelude();
  assert.match(script,/\/home\/linuxbrew\/\.linuxbrew\/bin/);
  assert.match(script,/VOLTA_HOME/);
  assert.match(script,/\.asdf\/shims/);
  assert.match(script,/\.local\/share\/mise\/shims/);
  assert.match(script,/\.nodenv\/shims/);
  assert.match(script,/\.nvm\/versions\/node/);
  assert.match(script,/export PATH/);
});

test("remote Codex app-server always preserves Codex-native inference",()=>{
  const args=remoteCodexArgs({
    provider:"vyceai",
    baseUrl:"http://172.20.0.1:32123/v1",
    listen:"ws://0.0.0.0:23456",
  });
  assert.deepEqual(args,["app-server","--listen","ws://0.0.0.0:23456"]);
  assert.doesNotMatch(args.join(" "),/model_provider|model_providers|base_url/);
});

test("remote Codex profiles honor custom binaries, homes, overlays and environment",()=>{
  const direct=remoteCodexProfileSetup({
    profile:{codexPath:"codex-default"},
    runtimeInstance:{binaryPath:"/opt/codex/bin/codex",homePath:"~/.codex-shared",environment:{TREBELL_FIXTURE:"yes"}},
  });
  assert.equal(direct.command,"/opt/codex/bin/codex");
  assert.match(direct.prelude,/export TREBELL_FIXTURE='yes'/);
  assert.match(direct.prelude,/export CODEX_HOME/);
  assert.match(direct.prelude,/\.codex-shared/);

  const overlay=remoteCodexProfileSetup({
    profile:{},
    runtimeInstance:{homePath:"~/.codex-shared",shadowHomePath:"~/.codex-work"},
  });
  assert.match(overlay.prelude,/trebell_codex_shared/);
  assert.match(overlay.prelude,/sessions/);
  assert.match(overlay.prelude,/ln -s/);
  assert.match(overlay.prelude,/\.codex-work/);
});

test("SSH remote Codex servers derive deterministic app tunnel ports",()=>{
  const first=sshRemotePorts(23456),second=sshRemotePorts(23457);
  assert.notDeepEqual(first,second);
  for(const port of [first.appPort,second.appPort])assert.ok(port>1024&&port<65536);
  assert.equal(Object.prototype.hasOwnProperty.call(first,"providerPort"),false);
});

test("remote app-server logs redact runtime credentials before entering Trebell diagnostics",async()=>{
  const credential=["opaque","runtime","log","credential"].join("-"),child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const profile={id:"wsl-a",name:"WSL",type:"wsl",cwd:"/srv/app"};
  const environments={
    get:id=>id===profile.id?profile:null,
    execute:async()=>({exitCode:0,stdout:"HOST=127.0.0.1\nGUEST=127.0.0.1\n",stderr:""}),
    spawnSession:()=>child,
  };
  const remote=await startRemoteAppServer({environments,environmentId:profile.id,appPort:33456,runtimeInstance:{environment:{CUSTOM_RUNTIME_TOKEN:credential}}});
  try{
    child.stderr.write(`runtime failed with ${credential}\n`);child.stdout.write("safe output\n");
    await new Promise(resolve=>setImmediate(resolve));
    const text=remote.logs.map(item=>item.text).join("\n");
    assert.doesNotMatch(text,new RegExp(credential));assert.match(text,/\[redacted\]/);assert.match(text,/safe output/);
  }finally{await remote.close()}
});

test("remote Codex app-server clears the remote login environment before launch",async()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let command="";
  const profile={id:"wsl-safe",name:"WSL safe",type:"wsl",cwd:"/srv/app"};
  const environments={
    get:id=>id===profile.id?profile:null,
    execute:async()=>({exitCode:0,stdout:"HOST=127.0.0.1\nGUEST=127.0.0.1\n",stderr:""}),
    spawnSession:(_id,options)=>{command=options.command;return child},
  };
  const remote=await startRemoteAppServer({
    environments,environmentId:profile.id,appPort:33457,
    runtimeInstance:{homePath:"~/.codex-safe",environment:{CUSTOM_MODE:"safe"}},
    runtimeEnvironmentNames:["PATH","HOME","OPENAI_API_KEY","TEAM_PROXY"],
  });
  try{
    assert.match(command,/exec env -i /);assert.match(command,/PATH="\$\{PATH-\}"/);assert.match(command,/HOME="\$\{HOME-\}"/);
    assert.match(command,/OPENAI_API_KEY="\$\{OPENAI_API_KEY-\}"/);assert.match(command,/TEAM_PROXY="\$\{TEAM_PROXY-\}"/);
    assert.match(command,/CUSTOM_MODE='safe'/);assert.match(command,/CODEX_HOME="\$\{CODEX_HOME-\}"/);
    assert.doesNotMatch(command,/GITHUB_TOKEN|TREBELL_PRIVATE_SECRET/);
  }finally{await remote.close()}
});

test("SSH app-server transport does not inherit unrelated host secrets",async()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let launch=null;
  const profile={id:"ssh-safe",name:"SSH safe",type:"ssh",cwd:"/srv/app",host:"example.test",user:"dev",port:22};
  const environments={get:id=>id===profile.id?profile:null};
  const remote=await startRemoteAppServer({
    environments,environmentId:profile.id,appPort:33458,
    hostEnvironment:{PATH:"/usr/bin",HOME:"/home/local",SSH_AUTH_SOCK:"/tmp/agent.sock",TREBELL_PRIVATE_SECRET:"hidden"},
    spawnProcess:(command,args,options)=>{launch={command,args,options};return child},
  });
  assert.ok(remote);assert.equal(launch.command,process.platform==="win32"?"ssh.exe":"ssh");
  assert.equal(launch.options.env.PATH,"/usr/bin");assert.equal(launch.options.env.HOME,"/home/local");assert.equal(launch.options.env.SSH_AUTH_SOCK,"/tmp/agent.sock");
  assert.equal(launch.options.env.TREBELL_PRIVATE_SECRET,undefined);
});

test("SSH native Codex transport omits Trebell provider reverse tunnels and overrides",async()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let launch=null;
  const profile={id:"ssh-native",name:"SSH native",type:"ssh",cwd:"/srv/app",host:"example.test",user:"dev",port:22};
  const environments={get:id=>id===profile.id?profile:null};
  const remote=await startRemoteAppServer({
    environments,environmentId:profile.id,appPort:33459,
    hostEnvironment:{PATH:"/usr/bin",HOME:"/home/local",SSH_AUTH_SOCK:"/tmp/agent.sock"},
    spawnProcess:(command,args,options)=>{launch={command,args,options};return child},
  });
  assert.ok(remote);
  assert.equal(launch.args.includes("-R"),false,"native Codex must not tunnel Trebell's provider bridge");
  const remoteCommand=String(launch.args.at(-1)||"");
  assert.match(remoteCommand,/app-server/);
  assert.doesNotMatch(remoteCommand,/model_provider|model_providers\./);
});

// The Codex executable typed for an SSH or WSL environment is saved with it, and it is the command that environment's Codex
// app-server starts; left blank, the host's codex on PATH is used.
// A Codex home or executable under a named user's home (~bob/...) is placed by the host's shell in that user's home; one under a user
// the host does not know is refused before anything is made, rather than a folder named ~bob being made where the server starts.
test("remote Codex homes and executables under a named user's home are expanded by the host, and an unknown user is refused before anything is made",async()=>{
  const named=remoteCodexProfileSetup({profile:{codexPath:"~bob/.local/bin/codex"},runtimeInstance:{homePath:"~bob/.codex-shared",shadowHomePath:"~bob/.codex-work"}});
  assert.match(named.prelude,/^trebell_codex_shared=~bob\/'\.codex-shared'$/m);
  assert.match(named.prelude,/^trebell_codex_effective=~bob\/'\.codex-work'$/m);
  assert.match(named.prelude,/case "\$trebell_codex_shared" in "~"\*\) printf '%s\\n' 'Trebell could not find the home folder of the user bob on this host, so it cannot use ~bob\/\.codex-shared\.' >&2; exit 127;; esac/);
  assert.ok(named.prelude.indexOf("exit 127")<named.prelude.indexOf("mkdir -p"),"the guard comes before anything is made");
  const environments=new EnvironmentManager({state:{environments:()=>[{id:"ssh-named",type:"ssh",name:"Named box",host:"named.example.test",user:"dev",port:22,cwd:"/srv/app",codexPath:"~bob/.local/bin/codex",enabled:true}]}});
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let launch=null;
  await startRemoteAppServer({environments,environmentId:"ssh-named",appPort:33460,hostEnvironment:{PATH:"/usr/bin"},spawnProcess:(command,args,options)=>{launch={command,args,options};return child}});
  assert.match(String(launch.args.at(-1)),/exec env -i .*'sh' '-c' 'trebell_command=~bob\/[\s\S]*' 'trebell' 'app-server' '--listen'/,"the app-server runs from bob's home");
  const shell=await new Promise(resolve=>execFile("sh",["-c","printf ok"],{windowsHide:true},(error,stdout)=>resolve(!error&&stdout==="ok")));
  if(!shell)return;
  const work=await mkdtemp(join(tmpdir(),"trebell-named-home-"));
  try{
    const unknown=remoteCodexProfileSetup({profile:{},runtimeInstance:{homePath:"~trebell_no_such_user/.codex"}});
    const ran=await new Promise(resolve=>execFile("sh",["-c",unknown.prelude],{cwd:work,windowsHide:true,timeout:20_000},(error,stdout,stderr)=>resolve({code:error?error.code:0,stderr:String(stderr)})));
    assert.equal(ran.code,127);
    assert.match(ran.stderr,/^Trebell could not find the home folder of the user trebell_no_such_user on this host, so it cannot use ~trebell_no_such_user\/\.codex\.\r?\n?$/);
    assert.deepEqual(await readdir(work),[],"nothing was made where the shell ran");
  }finally{await rm(work,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("an environment's Codex executable is saved and starts its Codex app-server",async()=>{
  const saved=[],state={environments:()=>saved,upsertEnvironment:value=>{const index=saved.findIndex(item=>item.id===value.id);if(index>=0)saved[index]=value;else saved.push(value);return value}};
  const environments=new EnvironmentManager({state});
  const ssh=environments.upsert({id:"ssh-codex",type:"ssh",name:"Build box",host:"build.example.test",user:"dev",port:22,cwd:"/srv/app",codexPath:" /opt/lane/bin/codex "});
  assert.equal(ssh.codexPath,"/opt/lane/bin/codex");
  assert.equal(environments.upsert({type:"wsl",name:"WSL",distro:"Ubuntu",codexPath:"~/bin/codex"}).codexPath,"~/bin/codex");
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let launch=null;
  const remote=await startRemoteAppServer({environments,environmentId:"ssh-codex",appPort:33460,hostEnvironment:{PATH:"/usr/bin"},spawnProcess:(command,args,options)=>{launch={command,args,options};return child}});
  assert.ok(remote);
  assert.match(String(launch.args.at(-1)),/exec .*'\/opt\/lane\/bin\/codex' 'app-server' '--listen'/);
  // One typed under the home folder is expanded by the host's shell, not looked up as a file named ~.
  environments.upsert({id:"ssh-codex",type:"ssh",name:"Build box",host:"build.example.test",user:"dev",port:22,cwd:"/srv/app",codexPath:"~/.local/bin/codex"});
  await startRemoteAppServer({environments,environmentId:"ssh-codex",appPort:33460,hostEnvironment:{PATH:"/usr/bin"},spawnProcess:(command,args,options)=>{launch={command,args,options};return child}});
  assert.match(String(launch.args.at(-1)),/exec .*"\$HOME"\/'\.local\/bin\/codex' 'app-server' '--listen'/);
  const blank=environments.upsert({id:"ssh-codex",type:"ssh",name:"Build box",host:"build.example.test",codexPath:""});
  assert.equal(remoteCodexProfileSetup({profile:blank}).command,"codex");
});

// Codex as a test host has it in ~/bin: each run notes its arguments and the CODEX_HOME it has, and the host's home; `codex login`
// writes auth.json into its home (CODEX_HOME, else ~/.codex); `codex app-server` on stdio answers initialize and account/read,
// signed in when auth.json is in its home; `codex app-server --listen` says whether it is.
const HOST_CODEX=`#!/bin/sh
home=\${CODEX_HOME:-$HOME/.codex}
printf '%s|%s|%s\\n' "$*" "\${CODEX_HOME-}" "$HOME" >> "$HOME/codex-runs"
case $1 in
  --version) echo codex-cli 0.0.0-fixture;;
  login) mkdir -p "$home" && printf '{}' > "$home/auth.json";;
  app-server)
    if [ "$2" = --listen ]; then if [ -f "$home/auth.json" ]; then echo signed-in; else echo signed-out; fi; exit 0; fi
    while IFS= read -r line; do
      id=\${line#'{"id":'}; id=\${id%%,*}
      case $line in
        *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"codex_cli_rs/0.0.0"}}\\n' "$id";;
        *'"method":"account/read"'*)
          if [ -f "$home/auth.json" ]; then printf '{"id":%s,"result":{"account":{"type":"chatgpt","planType":"plus"},"requiresOpenaiAuth":true}}\\n' "$id"
          else printf '{"id":%s,"result":{"account":null,"requiresOpenaiAuth":true}}\\n' "$id"; fi;;
      esac
    done;;
esac
`;
// A WSL or SSH host as this machine's sh: the command ssh is given last, as the host's shell runs it, or the one wsl.exe --exec
// bash -lc is given (sh stands in for bash: bash looked up by name on Windows can be System32's, which starts WSL). It has a home
// of its own and only what a process needs from this machine to start; MSYS makes Git for Windows' ln -s a link, as a host's is.
function codexHost(home){
  const env={...Object.fromEntries(Object.keys(process.env).filter(name=>["PATH","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","TMPDIR"].includes(name.toUpperCase())).map(name=>[name,process.env[name]])),HOME:home,MSYS:"winsymlinks:nativestrict"};
  return (_file,args,options={})=>{
    const at=args.indexOf("--exec");
    if(at>=0)assert.deepEqual(args.slice(at+1,at+3),["bash","-lc"],"wsl.exe runs bash -lc");
    return spawn("sh",["-c",at>=0?args[at+3]:args.at(-1)],{...options,env,windowsHide:true});
  };
}

// A WSL or SSH Codex profile with its own Codex home (CODEX_HOME in Settings) or a shadow home signs in, checks its account and runs
// its app-server in that one home, as its sessions run there: a sign-in or an account check in the host's default home read as signed
// in while the sessions ran in a home with no auth.json, and Sign in did not fix it. A profile with no home of its own keeps the host's
// default home (~/.codex) for all three, as before.
test("a WSL or SSH Codex profile with its own or a shadow Codex home signs in, checks its account and runs its app-server in that home",{skip:!posixShell&&"no POSIX shell on this machine"},async()=>{
  const work=await mkdtemp(join(tmpdir(),"trebell-remote-codex-home-"));
  const profiles={
    ssh:{id:"ssh-codex",name:"Build box",type:"ssh",host:"build.example.test",user:"dev",port:22,cwd:"",enabled:true},
    wsl:{id:"wsl-codex",name:"Ubuntu",type:"wsl",distro:"Ubuntu",cwd:"",enabled:true},
  };
  const instances=[
    [{id:"codex-own",kind:"codex",displayName:"Own home",homePath:"~/.codex-own"},".codex-own"],
    [{id:"codex-shadow",kind:"codex",displayName:"Shadow home",homePath:"~/.codex-shared",shadowHomePath:"~/.codex-work"},".codex-work"],
    [{id:"codex-plain",kind:"codex",displayName:"Default home"},null],
  ];
  const seen={},wanted={};
  try{
    for(const profile of Object.values(profiles))for(const [instance,folder] of instances){
      const label=profile.type+" "+instance.id,home=join(work,profile.type+"-"+instance.id);
      await mkdir(join(home,"bin"),{recursive:true});await writeFile(join(home,"bin","codex"),HOST_CODEX,{mode:0o755});
      const host=codexHost(home),environments=new EnvironmentManager({state:{environments:()=>[profile]},env:{},platform:"win32",spawnProcess:host});
      const settings={activeEnvironmentId:profile.id,agentRuntime:"codex",agentRuntimeInstanceId:instance.id,agentRuntimeInstances:[instance]};
      const runtimes=new AgentRuntimeManager({state:{settings:()=>settings},environments,env:{},platform:process.platform});
      // Sign in, as Settings' Sign in opens its terminal (gui-server /api/agent-runtime-auth).
      const auth=runtimes.authCommand(instance,{action:"login",environmentId:profile.id});
      const spec=environments.terminalArgvSpec(profile.id,{command:auth.command,args:auth.args,cwd:"",prelude:auth.prelude});
      const signIn=await finished(host(spec.shell,spec.args,{stdio:["ignore","pipe","pipe"]}));
      assert.equal(signIn.code,0,label+": "+signIn.stderr);
      // The account check Settings and a chat start make.
      const status=await runtimes.probe(instance,{environmentId:profile.id,fresh:true});
      // The app-server the profile's sessions run on; a WSL host's addresses as wslNetwork reads them.
      const remote=await startRemoteAppServer({
        environments:profile.type==="wsl"?{get:id=>environments.get(id),execute:async()=>({exitCode:0,stdout:"HOST=127.0.0.1\nGUEST=127.0.0.1\n",stderr:""}),spawnSession:(id,options)=>environments.spawnSession(id,options)}:environments,
        environmentId:profile.id,appPort:33461,runtimeInstance:instance,hostEnvironment:{},spawnProcess:host,
      });
      await new Promise(resolve=>remote.child.once("close",resolve));
      const runs=(await readFile(join(home,"codex-runs"),"utf8")).split("\n").filter(Boolean).map(line=>{const [args,codexHome,hostHome]=line.split("|");return {args,codexHome,hostHome}});
      // The sign-in, the account check's app-server and the sessions' app-server, each with the CODEX_HOME it ran with ("" for none);
      // whether auth.json is in the profile's home; what the account check said; and whether the sessions' app-server is signed in.
      const expected=folder?runs[0].hostHome+"/"+folder:"";
      seen[label]={
        runs:runs.filter(run=>run.args!=="--version").map(run=>[run.args.replace(/ ws:\/\/\S+$/,""),run.codexHome]),
        authJson:existsSync(join(home,folder||".codex","auth.json")),check:[status.available,status.authenticated],
        appServer:remote.logs.map(entry=>entry.text).join("").match(/signed-(?:in|out)/)?.[0]||null,
      };
      wanted[label]={runs:[["login",expected],["app-server",expected],["app-server --listen",expected]],authJson:true,check:[true,true],appServer:"signed-in"};
    }
  }finally{await rm(work,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  assert.deepEqual(seen,wanted);
});
