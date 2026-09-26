import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { remoteCodexArgs, remoteCodexProfileSetup, sshRemotePorts, startRemoteAppServer } from "../src/environment-app-server.mjs";
import { remoteToolPathPrelude } from "../src/environment-manager.mjs";

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

test("remote Codex app-server receives Trebell provider overrides before the subcommand",()=>{
  const args=remoteCodexArgs({
    provider:"vyceai",
    baseUrl:"http://172.20.0.1:32123/v1",
    listen:"ws://0.0.0.0:23456",
  });
  const appIndex=args.indexOf("app-server");
  assert.ok(appIndex>0);
  assert.equal(args[appIndex+1],"--listen");
  assert.equal(args[appIndex+2],"ws://0.0.0.0:23456");
  const joined=args.slice(0,appIndex).join("\n");
  assert.match(joined,/model_provider="vyceai"/);
  assert.match(joined,/model_providers\.vyceai\.base_url="http:\/\/172\.20\.0\.1:32123\/v1"/);
  assert.match(joined,/wire_api="responses"/);
  assert.match(joined,/requires_openai_auth=false/);
});

test("remote Freebuff session can point at a tunneled local bridge",()=>{
  const args=remoteCodexArgs({
    provider:"freebuff",
    baseUrl:"http://127.0.0.1:23335/v1",
    listen:"ws://127.0.0.1:23456",
  });
  assert.ok(args.includes('model_provider="freebuff"'));
  assert.ok(args.includes('model_providers.freebuff.base_url="http://127.0.0.1:23335/v1"'));
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

test("SSH remote Codex servers derive distinct app and provider tunnel ports",()=>{
  const first=sshRemotePorts(23456),second=sshRemotePorts(23457);
  assert.notEqual(first.appPort,first.providerPort);
  assert.notDeepEqual(first,second);
  for(const port of [first.appPort,first.providerPort,second.appPort,second.providerPort])assert.ok(port>1024&&port<65536);
});

test("remote app-server logs redact runtime credentials before entering Trebell diagnostics",async()=>{
  const credential=["opaque","runtime","log","credential"].join("-"),child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const profile={id:"wsl-a",name:"WSL",type:"wsl",cwd:"/srv/app"};
  const environments={
    get:id=>id===profile.id?profile:null,
    execute:async()=>({exitCode:0,stdout:"HOST=127.0.0.1\nGUEST=127.0.0.1\n",stderr:""}),
    spawnSession:()=>child,
  };
  const remote=await startRemoteAppServer({environments,environmentId:profile.id,appPort:33456,provider:"freebuff",localProviderPort:9,runtimeInstance:{environment:{CUSTOM_RUNTIME_TOKEN:credential}}});
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
    environments,environmentId:profile.id,appPort:33457,provider:"freebuff",localProviderPort:9,
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
    environments,environmentId:profile.id,appPort:33458,provider:"freebuff",localProviderPort:9,
    hostEnvironment:{PATH:"/usr/bin",HOME:"/home/local",SSH_AUTH_SOCK:"/tmp/agent.sock",TREBELL_PRIVATE_SECRET:"hidden"},
    spawnProcess:(command,args,options)=>{launch={command,args,options};return child},
  });
  assert.ok(remote);assert.equal(launch.command,process.platform==="win32"?"ssh.exe":"ssh");
  assert.equal(launch.options.env.PATH,"/usr/bin");assert.equal(launch.options.env.HOME,"/home/local");assert.equal(launch.options.env.SSH_AUTH_SOCK,"/tmp/agent.sock");
  assert.equal(launch.options.env.TREBELL_PRIVATE_SECRET,undefined);
});
