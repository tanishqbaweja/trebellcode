import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { codexUpstreamToken } from "../src/codex-app-server-auth.mjs";
import { attachCodexRelay } from "../src/codex-relay.mjs";
import { sshRemotePorts, startRemoteAppServer } from "../src/environment-app-server.mjs";
import { EnvironmentManager, terminateHostProcessTree } from "../src/environment-manager.mjs";
import * as gui from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

// A Codex app-server Trebell starts in a WSL or SSH environment listened with no token: on WSL's ws://0.0.0.0:<port> the Windows host,
// the other distros and, in WSL's mirrored networking, the host's own interfaces reached it, and on an SSH host's 127.0.0.1 every user
// and program there did, so whoever connected drove that Codex, its commands and its edits. Each one now takes a random token of its
// own, as a local one does (codex-app-server-auth.mjs), but only the token's SHA-256 goes on the host's command line (--ws-auth
// capability-token --ws-token-sha256 <hex>, which the pinned Codex 0.155.1 and 0.162.0 take and enforce): nothing is written on the
// host, and the token stays in Trebell, whose relay, model list and Git text send it as they send a local app-server's.
const require=createRequire(import.meta.url);
const posixShell=await new Promise(resolve=>execFile("sh",["-c","printf ok"],{windowsHide:true,timeout:20_000},(error,stdout)=>resolve(!error&&String(stdout)==="ok")));
const windowsOnly=process.platform!=="win32"&&"WSL environments are Windows-only";
const sha256=text=>createHash("sha256").update(String(text),"utf8").digest("hex");
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
const slashes=path=>String(path).split("\\").join("/");
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const portFree=port=>new Promise(resolve=>{const server=createTcpServer();server.once("error",()=>resolve(false));server.listen(port,"127.0.0.1",()=>server.close(()=>resolve(true)))});
async function until(condition,what,timeoutMs=20_000){
  for(const deadline=Date.now()+timeoutMs;!await condition();){if(Date.now()>deadline)throw new Error("Timed out waiting until "+what);await new Promise(resolve=>setTimeout(resolve,50))}
}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const refusal=(url,headers={})=>new Promise(resolve=>{const ws=new WebSocket(url,{headers});ws.once("unexpected-response",(_req,res)=>{resolve(res.statusCode);ws.terminate()});ws.once("open",()=>{resolve("open");ws.terminate()});ws.once("error",()=>resolve("error"))});

// The host's Codex: `app-server --listen ws://<address>:<port> --ws-auth capability-token --ws-token-sha256 <hex>` takes a handshake
// only with a Bearer token whose SHA-256 is <hex>, as Codex does, refusing any other with 401; started without --ws-auth it takes
// every handshake, as Codex does. It logs each start (its arguments), each refused handshake and the token of each one it took, and
// answers what the catalog, the app's connection and Git text ask. This machine stands in for the host, so the address it is given
// (WSL's 0.0.0.0) is listened on only on loopback.
const fakeCodexSource=({log,wsModule})=>`import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ws from ${JSON.stringify(wsModule)};
const args=process.argv.slice(2),at=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
const listen=args[0]==="app-server"?String(at("--listen")||""):"";
if(!listen.startsWith("ws://"))process.exit(1);
const digest=at("--ws-auth")==="capability-token"?at("--ws-token-sha256"):null;
const record=entry=>appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,...entry})+"\\n");
// The test's process: a host's exec chain leaves this process outside the tree a stop ends on Windows, so it ends with the test.
const owner=Number(process.env.TREBELL_TEST_PID)||0;if(owner)setInterval(()=>{try{process.kill(owner,0)}catch{process.exit(0)}},300);
record({event:"start",args,listen,digest});
process.stderr.write("codex app-server (WebSockets)\\n  listening on: "+listen+"\\n");
const server=createServer((req,res)=>{res.writeHead(req.url==="/readyz"?200:404);res.end()});
const wss=new ws.WebSocketServer({noServer:true});
server.on("upgrade",(req,socket,head)=>{
  const bearer=/^Bearer (.+)$/.exec(String(req.headers.authorization||""))?.[1]||null;
  if(digest&&(!bearer||createHash("sha256").update(bearer,"utf8").digest("hex")!==digest)){record({event:"refused",authorization:req.headers.authorization?"wrong":"none"});socket.end("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");return}
  record({event:"accepted",token:bearer});
  wss.handleUpgrade(req,socket,head,client=>client.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    const params=message.params||{},reply=result=>client.send(JSON.stringify({id:message.id,result})),notify=(method,value)=>client.send(JSON.stringify({method,params:value}));
    if(message.method==="initialize")return reply({userAgent:"fake-env-codex/"+process.pid});
    if(message.method==="account/read")return reply({account:{type:"chatgpt",email:"env@example.test",planType:"plus"},requiresOpenaiAuth:true});
    if(message.method==="model/list")return reply({data:[{id:"gpt-6-astra",model:"gpt-6-astra",displayName:"GPT-6 Astra",hidden:false,isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null});
    if(message.method==="config/read")return reply({config:{},origins:{},layers:null});
    if(message.method==="thread/start")return reply({thread:{id:"env-thread-"+process.pid,cwd:params.cwd||null},model:"gpt-6-astra"});
    if(message.method==="turn/start"){
      reply({turn:{id:"git-text-turn",status:"inProgress",items:[]}});
      setTimeout(()=>{notify("item/completed",{threadId:params.threadId,turnId:"git-text-turn",item:{type:"agentMessage",id:"m1",text:"chore: write Git text over a WSL app-server only Trebell can reach",phase:"final_answer"}});notify("turn/completed",{threadId:params.threadId,turn:{id:"git-text-turn",status:"completed",items:[]}})},20);
      return;
    }
    reply({data:[],nextCursor:null});
  }));
});
server.listen(Number(new URL(listen).port),"127.0.0.1");
`;
// The fake and its launcher, the codex a WSL or SSH profile runs (its codexPath). Node on Windows needs SYSTEMROOT to start, which the
// app-server's env -i passes on only in the host's own spelling, so the launcher sets it, and the test's pid. stop() ends every fake
// still running: sh's exec on Windows starts each program as a process of its own, so a stop of the host's first process (taskkill
// /t) does not reach the fake, as it reaches a WSL distro's or an SSH host's processes through wsl.exe or ssh.
async function hostCodex(root){
  const log=join(root,"codex.log"),script=join(root,"fake-codex.mjs"),launcher=join(root,"host-bin","codex");
  await mkdir(join(root,"host-bin"),{recursive:true});await writeFile(log,"");
  await writeFile(script,fakeCodexSource({log,wsModule:pathToFileURL(require.resolve("ws")).href}));
  const systemRoot=process.env.SystemRoot||process.env.SYSTEMROOT||"";
  await writeFile(launcher,"#!/bin/sh\n"+(systemRoot?"SYSTEMROOT="+quote(systemRoot)+"; export SYSTEMROOT\n":"")+"TREBELL_TEST_PID="+process.pid+"; export TREBELL_TEST_PID\nexec "+quote(slashes(process.execPath))+" "+quote(slashes(script))+' "$@"\n',{mode:0o755});
  const entries=async()=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const stop=async()=>{
    const pids=(await entries()).filter(entry=>entry.event==="start").map(entry=>entry.pid);
    for(const pid of pids)try{process.kill(pid)}catch{}
    await until(()=>!pids.some(alive),"the host's app-servers have ended");
  };
  return {launcher:slashes(launcher),entries,stop};
}
// ssh -L: connections to the local port go on to the host's.
function forward(localPort,remotePort){
  const sockets=new Set();
  const server=createTcpServer(socket=>{
    const upstream=tcpConnect(remotePort,"127.0.0.1"),end=()=>{socket.destroy();upstream.destroy()};
    for(const side of [socket,upstream]){sockets.add(side);side.on("error",end);side.on("close",end)}
    socket.pipe(upstream);upstream.pipe(socket);
  });
  const listening=new Promise((resolve,reject)=>{server.once("error",reject);server.listen(localPort,"127.0.0.1",resolve)});
  return {listening,close:()=>{for(const socket of sockets)socket.destroy();return new Promise(resolve=>server.close(()=>resolve()))}};
}
// A WSL distro or an SSH host as this machine's sh, in a home of its own, with only what a process needs from this machine to start;
// seen gets every command it is given. wsl.exe runs what bash -lc is given (sh stands in for bash) and answers its network probe
// (wslNetwork) with loopback as both the host's and the guest's address; ssh runs the command it is given last and forwards its -L
// port to the host's, as ssh -L does. Anything else runs on this machine.
function hostShell(home,{seen=[],forwards=[]}={}){
  const env={...Object.fromEntries(Object.keys(process.env).filter(name=>["PATH","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","TMPDIR"].includes(name.toUpperCase())).map(name=>[name,process.env[name]])),HOME:home};
  const run=(script,options)=>{seen.push(script);return spawn("sh",["-c",script],{...options,cwd:home,env,windowsHide:true})};
  return (file,args=[],options={})=>{
    const name=String(file).split(/[\\/]/).pop().toLowerCase();
    if(name==="wsl.exe"){
      const script=String(args[args.indexOf("--exec")+3]||"");
      return run(script.includes("ip route show default")?"printf 'HOST=127.0.0.1\\nGUEST=127.0.0.1\\n'":script,options);
    }
    if(name==="ssh"||name==="ssh.exe"){
      const tunnel=args.indexOf("-L");
      if(tunnel>=0){const [,local,,remote]=String(args[tunnel+1]).split(":");forwards.push(forward(Number(local),Number(remote)))}
      return run(String(args.at(-1)),options);
    }
    return spawn(file,args,options);
  };
}
async function stopHost(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once("exit",resolve));terminateHostProcessTree(child,{force:true});await exited;
}
// Every EnvironmentManager made while this is in place (the GUI server's) starts its processes with host, as its spawnProcess option
// would have them start; undo() puts it back.
function standInHost(host){
  const proto=EnvironmentManager.prototype,had=Object.getOwnPropertyDescriptor(proto,"spawnProcess");
  Object.defineProperty(proto,"spawnProcess",{configurable:true,get:()=>host,set(){}});
  return ()=>{if(had)Object.defineProperty(proto,"spawnProcess",had);else delete proto.spawnProcess};
}
// No harness CLI runs for a status check: each answers as a ready one.
function readyHarnesses(){
  const probe=AgentRuntimeManager.prototype.probe;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.kind===instanceOrKind):instanceOrKind;
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  return ()=>{AgentRuntimeManager.prototype.probe=probe};
}
async function filesText(folder){
  const entries=await readdir(folder,{withFileTypes:true,recursive:true}).catch(()=>[]);let text="";
  for(const entry of entries)if(entry.isFile())text+=await readFile(join(entry.parentPath||entry.path,entry.name),"latin1").catch(()=>"")+"\n";
  return text;
}
function guiEnvironment(root,home){
  return {...process.env,TREBELL_HOME:home,CODEX_HOME:join(root,"codex-home"),CLAUDE_CONFIG_DIR:join(root,"claude-config"),TREBELL_GUI_MOCK:"",TREBELL_E2E_OFFLINE:"",TREBELL_APP_SERVER_PORT:"",TREBELL_HISTORY_DISABLE_CLAUDE:"1",TREBELL_GUI_DEBUG:"",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
}
// A Trebell home whose active environment is a WSL distro named Ubuntu, whose Codex is codexPath, with Codex the active harness.
function wslHome(env,codexPath){
  const state=new TrebellStateStore(env);
  const profile=new EnvironmentManager({state,env}).upsert({type:"wsl",name:"Ubuntu",distro:"Ubuntu-X1",cwd:"",codexPath});
  state.updateSettings({agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",onboardingComplete:true,activeEnvironmentId:profile.id});state.close();
  return profile;
}

test("a WSL or SSH host's Codex app-server starts with only the SHA-256 of a random token of its own, which no command line or log line carries",async()=>{
  const wsl={id:"wsl-x1",name:"Ubuntu",type:"wsl",cwd:"/srv/app"},ssh={id:"ssh-x1",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example.test",user:"dev",port:22};
  const started=[];
  for(const profile of [wsl,wsl,ssh,ssh]){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let command="";
    const environments={get:id=>id===profile.id?profile:null,execute:async()=>({exitCode:0,stdout:"HOST=127.0.0.1\nGUEST=172.20.0.2\n",stderr:""}),spawnSession:(_id,options)=>{command=options.command;return child}};
    const remote=await startRemoteAppServer({environments,environmentId:profile.id,appPort:33470,hostEnvironment:{PATH:"/usr/bin"},spawnProcess:(_file,args)=>{command=args.join("\n");return child}});
    // A host that echoes what it runs into the app-server's log, as set -x does.
    child.stderr.write("+ "+command+"\n");child.stdout.write("codex app-server (WebSockets)\n");
    await new Promise(resolve=>setImmediate(resolve));
    started.push({profile,remote,command,logs:remote.logs.map(entry=>entry.text).join("")});
  }
  for(const {profile,remote,command,logs} of started){
    assert.match(String(remote.wsToken),/^[A-Za-z0-9_-]{43,}$/,"256 random bits");
    const listen=profile.type==="wsl"?"ws://0.0.0.0:33470":`ws://127.0.0.1:${sshRemotePorts(33470).appPort}`;
    assert.ok(command.includes(["app-server","--listen",listen,"--ws-auth","capability-token","--ws-token-sha256",sha256(remote.wsToken)].map(quote).join(" ")),command);
    assert.doesNotMatch(command,/--ws-token-file/,"nothing is written on the host");
    assert.equal(command.includes(remote.wsToken),false,"the host's command line never carries the token");
    assert.ok(logs.includes(sha256(remote.wsToken)));assert.equal(logs.includes(remote.wsToken),false,"nor does a log line");
  }
  assert.equal(new Set(started.map(item=>item.remote.wsToken)).size,started.length,"each app-server has a token of its own");
});

test("a WSL or SSH host's Codex app-server refuses a client without its token, and Trebell's Codex client and relay reach it with the token",{skip:!posixShell&&"no POSIX shell on this machine",timeout:120_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-ws-auth-")),codex=await hostCodex(root);
  const profiles=[
    {id:"wsl-x1",name:"Ubuntu",type:"wsl",distro:"Ubuntu",cwd:"",codexPath:codex.launcher,enabled:true},
    {id:"ssh-x1",name:"Build box",type:"ssh",host:"build.example.test",user:"dev",port:22,cwd:"",codexPath:codex.launcher,enabled:true},
  ];
  try{
    for(const profile of profiles){
      const home=join(root,"home-"+profile.type);await mkdir(home,{recursive:true});
      const forwards=[],host=hostShell(home,{forwards}),environments=new EnvironmentManager({state:{environments:()=>profiles},env:{},platform:"win32",spawnProcess:host});
      // An SSH host's app-server listens on its own port, which the tunnel forwards this machine's to: both free here.
      let appPort=await freePort();while(profile.type==="ssh"&&!await portFree(sshRemotePorts(appPort).appPort))appPort=await freePort();
      const remote=await startRemoteAppServer({
        environments:profile.type==="wsl"?{get:id=>environments.get(id),execute:async()=>({exitCode:0,stdout:"HOST=127.0.0.1\nGUEST=127.0.0.1\n",stderr:""}),spawnSession:(id,options)=>environments.spawnSession(id,options)}:environments,
        environmentId:profile.id,appPort,runtimeInstance:{id:"codex-default",kind:"codex"},hostEnvironment:{},spawnProcess:host,
      });
      const key=`catalog:${profile.id}:codex-default`,pool=new Map([[key,{...remote,poolKey:key}]]);
      const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});
      const relay=attachCodexRelay(relayHttp,{targetUrl:()=>remote.targetUrl,resolveTarget:()=>({key,url:remote.targetUrl}),upstreamToken:(url,route)=>codexUpstreamToken(pool,{key:route?.key,url})});
      await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
      let browser=null;
      try{
        await Promise.all(forwards.map(item=>item.listening));
        await until(()=>fetch(remote.readyUrl).then(response=>response.status===200,()=>false),profile.type+" app-server is ready");
        const digest=sha256(remote.wsToken),start=(await codex.entries()).find(entry=>entry.event==="start"&&entry.digest===digest);
        assert.ok(start,profile.type+": the host's Codex got the token's SHA-256");
        assert.equal(await refusal(remote.targetUrl),401,"no token: refused");
        assert.equal(await refusal(remote.targetUrl,{Authorization:"Bearer not-the-token"}),401,"another token: refused");
        assert.equal(await refusal(remote.targetUrl,{Authorization:"Bearer "+digest}),401,"the digest on the host's command line is no token");
        await assert.rejects(new CodexAppServerClient(remote.targetUrl,{clientVersion:"1"}).connect(),/401/);
        const client=new CodexAppServerClient(remote.targetUrl,{clientVersion:"1",token:remote.wsToken});
        await client.connect();assert.equal((await client.request("model/list",{})).data[0].id,"gpt-6-astra");client.close();
        // The app's connection, through the relay.
        browser=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`);
        await new Promise((resolve,reject)=>{browser.once("open",resolve);browser.once("error",reject)});
        const answered=new Promise(resolve=>browser.once("message",raw=>resolve(JSON.parse(String(raw)))));
        browser.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"env-ws-auth",version:"0"}}}));
        assert.equal((await answered).result?.userAgent,"fake-env-codex/"+start.pid,"the relay reached the host's app-server with its token");
        const mine=(await codex.entries()).filter(entry=>entry.pid===start.pid);
        assert.deepEqual(mine.filter(entry=>entry.event==="refused").map(entry=>entry.authorization),["none","wrong","wrong","none"]);
        assert.deepEqual(mine.filter(entry=>entry.event==="accepted").map(entry=>entry.token===remote.wsToken),[true,true],"the client's and the relay's");
      }finally{
        browser?.close();relay.close();await new Promise(resolve=>relayHttp.close(resolve));
        await stopHost(remote.child);await Promise.all(forwards.map(item=>item.close()));
      }
    }
    assert.equal((await codex.entries()).filter(entry=>entry.event==="start").length,2,"one app-server on each host");
  }finally{await codex.stop();await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});

test("with a WSL environment active, the app's Codex connection, a new thread, the model list and Git text reach that environment's Codex app-servers with each one's own token, which no log, setting or diagnostic holds",{skip:windowsOnly||(!posixShell&&"no POSIX shell on this machine"),timeout:180_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-ws-auth-gui-")),home=join(root,"home"),hostHome=join(root,"wsl-home");
  await mkdir(home,{recursive:true});await mkdir(hostHome,{recursive:true});
  const codex=await hostCodex(root),env=guiEnvironment(root,home),profile=wslHome(env,codex.launcher),seen=[];
  const undoHost=standInHost(hostShell(hostHome,{seen})),undoProbe=readyHarnesses();
  let server=null,browser=null;
  try{
    server=await gui.createGuiServer({port:await freePort(),mock:false,env});
    // The app's Codex connection: initialize reaches the catalog app-server, which runs in the environment, through the relay; a new
    // thread starts on an app-server of its own there.
    browser=new WebSocket(server.url.replace(/^http/,"ws")+"/api/codex/ws");
    await new Promise((resolve,reject)=>{browser.once("open",resolve);browser.once("error",reject)});
    const answers=new Map();browser.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&!message.method)answers.set(message.id,message)});
    const rpc=async(id,method,params)=>{browser.send(JSON.stringify({id,method,params}));await until(()=>answers.has(id),method+" is answered",60_000);return answers.get(id)};
    assert.match(String((await rpc(1,"initialize",{clientInfo:{name:"env-ws-auth-gui",version:"0"}})).result?.userAgent),/^fake-env-codex\//);
    assert.match(String((await rpc(2,"thread/start",{cwd:"/srv/app"})).result?.thread?.id),/^env-thread-/);
    // The model list, read by the catalog's own client.
    const catalog=await fetch(server.url+"/api/models").then(response=>response.json());
    assert.deepEqual(catalog.models,["gpt-6-astra"],JSON.stringify(catalog));
    // Git text, on an app-server of its own in the environment.
    const commit=await fetch(server.url+"/api/git/commit-message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:"/srv/app",environmentId:profile.id})});
    const commitBody=await commit.json();assert.equal(commit.status,200,JSON.stringify(commitBody));
    assert.equal(commitBody.message,"chore: write Git text over a WSL app-server only Trebell can reach");
    const entries=await codex.entries(),starts=entries.filter(entry=>entry.event==="start");
    assert.equal(starts.length,3,"the catalog's, the thread's and Git text's app-servers: "+JSON.stringify(starts.map(start=>start.args)));
    for(const start of starts){
      assert.match(start.listen,/^ws:\/\/0\.0\.0\.0:\d+$/);
      assert.deepEqual(start.args.slice(start.args.indexOf("--listen")+2),["--ws-auth","capability-token","--ws-token-sha256",start.digest]);
      assert.match(String(start.digest),/^[0-9a-f]{64}$/);
      assert.ok(seen.some(script=>script.includes(quote(start.digest))),"the digest went on the distro's command line");
    }
    assert.equal(new Set(starts.map(start=>start.digest)).size,3,"no two app-servers share a token");
    assert.deepEqual(entries.filter(entry=>entry.event==="refused"),[],"every Trebell client sent its app-server's token");
    const accepted=entries.filter(entry=>entry.event==="accepted");
    for(const start of starts)assert.ok(accepted.some(entry=>entry.pid===start.pid&&sha256(entry.token)===start.digest),"the app-server at "+start.listen+" was reached with its own token");
    // Another program that reaches the port has no token.
    const catalogUrl="ws://127.0.0.1:"+new URL(starts[0].listen).port;
    assert.equal(await refusal(catalogUrl),401);assert.equal(await refusal(catalogUrl,{Authorization:"Bearer guessed"}),401);
    // The tokens are in no log line, setting, snapshot or file of Trebell's, nor on a command line.
    const runtime=await fetch(server.url+"/api/runtime").then(response=>response.text());
    assert.match(runtime,/listening on: ws:\/\/0\.0\.0\.0:/,"the catalog app-server's log is there");
    const kept=[runtime,await fetch(server.url+"/api/diagnostics").then(response=>response.text()),await fetch(server.url+"/api/bootstrap").then(response=>response.text()),await filesText(home),await filesText(hostHome),seen.join("\n"),JSON.stringify(starts)].join("\n");
    const tokens=[...new Set(accepted.map(entry=>entry.token))];assert.equal(tokens.length,3);
    for(const token of tokens)assert.equal(kept.includes(token),false,"a token was found where Trebell keeps or shows what it ran");
  }finally{
    browser?.close();if(server)await server.close();undoHost();undoProbe();
    await codex.stop();await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

// A Codex from before --ws-auth stops on the argument as clap does, and its last line says only to try --help.
const OLD_HOST_CODEX=`#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = --ws-auth ]; then printf "error: unexpected argument '--ws-auth' found\\n\\n  tip: to pass '--ws-auth' as a value, use '-- --ws-auth'\\n\\nUsage: codex app-server [OPTIONS] [COMMAND]\\n\\nFor more information, try '--help'.\\n" >&2; exit 2; fi
done
exit 1
`;
test("a WSL environment's Codex too old for --ws-auth says so, naming the environment and that Codex is to be updated there",{skip:windowsOnly||(!posixShell&&"no POSIX shell on this machine"),timeout:120_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-ws-auth-old-")),home=join(root,"home"),hostHome=join(root,"wsl-home"),launcher=join(root,"host-bin","codex");
  await mkdir(home,{recursive:true});await mkdir(hostHome,{recursive:true});await mkdir(join(root,"host-bin"),{recursive:true});await writeFile(launcher,OLD_HOST_CODEX,{mode:0o755});
  const env=guiEnvironment(root,home);wslHome(env,slashes(launcher));
  const undoHost=standInHost(hostShell(hostHome)),undoProbe=readyHarnesses();
  let server=null;
  try{
    server=await gui.createGuiServer({port:await freePort(),mock:false,env});
    const boot=await fetch(server.url+"/api/bootstrap").then(response=>response.json());
    assert.equal(boot.appServerReady,false);
    assert.match(String(boot.appServerError),/^Codex app-server profile '.+' exited before it was ready in the WSL environment 'Ubuntu': this Codex has no --ws-auth, which Trebell Code starts each Codex app-server with so that only Trebell Code can connect to it\. Update Codex in 'Ubuntu' \(npm install -g @openai\/codex\), then try again\.$/);
  }finally{
    undoHost();undoProbe();if(server)await server.close();
    await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("a Codex too old for the token's arguments is named with its WSL or SSH environment, and a local one as before",()=>{
  assert.equal(typeof gui.appServerStartError,"function");
  const clap=flag=>`error: unexpected argument '${flag}' found\n\n  tip: to pass '${flag}' as a value, use '-- ${flag}'\n\nUsage: codex app-server [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n`;
  const exited=(text,environment=null)=>({child:{exitCode:2,signalCode:null},environment,logs:[{at:1,stream:"stderr",text},{at:2,stream:"stderr",text:(environment?"remote ":"")+"app-server exited code=2 signal=null\n"}]});
  const tail="which Trebell Code starts each Codex app-server with so that only Trebell Code can connect to it.";
  assert.equal(gui.appServerStartError(exited(clap("--ws-auth")),"Codex"),`Codex app-server profile 'Codex' exited before it was ready: this Codex has no --ws-auth, ${tail} Update Codex (npm install -g @openai/codex), then try again.`);
  assert.equal(gui.appServerStartError(exited(clap("--ws-auth"),{id:"ssh-x1",name:"Build box",type:"ssh",cwd:""}),"Work"),`Codex app-server profile 'Work' exited before it was ready in the SSH environment 'Build box': this Codex has no --ws-auth, ${tail} Update Codex in 'Build box' (npm install -g @openai/codex), then try again.`);
  assert.equal(gui.appServerStartError(exited(clap("--ws-token-sha256"),{id:"wsl-x1",name:"Ubuntu",type:"wsl",cwd:""}),"Codex"),`Codex app-server profile 'Codex' exited before it was ready in the WSL environment 'Ubuntu': this Codex has no --ws-token-sha256, ${tail} Update Codex in 'Ubuntu' (npm install -g @openai/codex), then try again.`);
});
