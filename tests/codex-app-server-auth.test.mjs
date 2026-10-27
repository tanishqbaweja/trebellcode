import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { codexAppServerToken } from "../src/codex-app-server-auth.mjs";
import { attachCodexRelay } from "../src/codex-relay.mjs";
import { git } from "../src/git-service.mjs";

// Trebell starts `codex app-server --listen ws://127.0.0.1:<port>`, which took any program on the machine that connected. Each one it
// starts now asks for a token of its own (--ws-auth capability-token --ws-token-file, OpenAI's app-server docs; checked against the
// pinned Codex 0.155.1, which refuses a handshake without it with 401), and every Trebell client sends it: the relay the app's Codex
// connection goes through, the catalog's and history import's client, and Git text's.
const require=createRequire(import.meta.url);
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const exists=path=>access(path).then(()=>true,()=>false);
async function until(condition,what,timeoutMs=20_000){
  for(const deadline=Date.now()+timeoutMs;!await condition();){if(Date.now()>deadline)throw new Error("Timed out waiting until "+what);await new Promise(resolve=>setTimeout(resolve,50))}
}
// A Codex app-server stand-in that, as Codex with --ws-auth capability-token, refuses a handshake without its token with 401.
async function guardedServer(token){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),seen=[];
  http.on("upgrade",(req,socket,head)=>{
    seen.push(req.headers.authorization||null);
    if(req.headers.authorization!==`Bearer ${token}`){socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");return}
    wss.handleUpgrade(req,socket,head,ws=>ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&message.method)ws.send(JSON.stringify({id:message.id,result:message.method==="initialize"?{userAgent:"guarded"}:{echo:message.method}}))}));
  });
  await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));
  return {url:"ws://127.0.0.1:"+http.address().port,seen,close:()=>new Promise(resolve=>wss.close(()=>http.close(resolve)))};
}
const refusal=(url,headers={})=>new Promise(resolve=>{const ws=new WebSocket(url,{headers});ws.once("unexpected-response",(_req,res)=>{resolve(res.statusCode);ws.terminate()});ws.once("open",()=>{resolve("open");ws.terminate()});ws.once("error",()=>resolve("error"))});

test("each Codex app-server token is random, in an owner-only file under Trebell's run folder, and its file goes on release",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-token-")),env={TREBELL_HOME:join(root,"home with space")};
  try{
    const first=await codexAppServerToken({env}),second=await codexAppServerToken({env,quote:true});
    assert.notEqual(first.token,second.token);assert.ok(first.token.length>=43,"256 bits of randomness");
    for(const auth of [first,second]){
      assert.equal(relative(join(env.TREBELL_HOME,"run"),auth.path).includes(".."),false);assert.equal(isAbsolute(auth.path),true);
      assert.equal(await readFile(auth.path,"utf8"),auth.token);
      if(process.platform!=="win32")assert.equal((await stat(auth.path)).mode&0o777,0o600);
    }
    assert.deepEqual(first.args,["--ws-auth","capability-token","--ws-token-file",first.path]);
    // Through cmd.exe (a codex.cmd launcher) the path, which has a space here, goes in quotes.
    assert.deepEqual(second.args,["--ws-auth","capability-token","--ws-token-file",`"${second.path}"`]);
    await first.release();assert.equal(await exists(first.path),false);assert.equal(await exists(second.path),true);
    await second.release();await second.release();assert.equal(await exists(second.path),false);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("the Codex client and the relay send the app-server's token, and an app-server that wants one refuses a client without it",async()=>{
  const token="codex-token-for-this-test",server=await guardedServer(token);
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachCodexRelay(relayHttp,{targetUrl:server.url,upstreamToken:url=>url===server.url?token:null});
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  try{
    assert.equal(await refusal(server.url),401,"no token: refused");
    assert.equal(await refusal(server.url,{Authorization:"Bearer not-the-token"}),401,"another token: refused");
    const client=new CodexAppServerClient(server.url,{clientVersion:"1",token});
    await client.connect();assert.deepEqual(await client.request("model/list",{}),{echo:"model/list"});client.close();
    // Without a token the client connects as before, and this app-server refuses it.
    await assert.rejects(new CodexAppServerClient(server.url,{clientVersion:"1"}).connect(),/401/);
    const browser=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`);
    await new Promise((resolve,reject)=>{browser.once("open",resolve);browser.once("error",reject)});
    const answer=new Promise(resolve=>browser.once("message",raw=>resolve(JSON.parse(String(raw)))));
    browser.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"t",version:"0"}}}));
    assert.equal((await answer).result?.userAgent,"guarded","the relay reached the app-server with its token");
    browser.close();
    assert.deepEqual(server.seen,[null,"Bearer not-the-token",`Bearer ${token}`,null,`Bearer ${token}`]);
  }finally{relay.close();await new Promise(resolve=>relayHttp.close(resolve));await server.close()}
});

// A Codex CLI stand-in: `app-server --listen ws://127.0.0.1:<port> --ws-auth capability-token --ws-token-file <path>` reads its token
// from the file, logs each start and each refused handshake, refuses a handshake without the token with 401, and answers what the
// catalog, the app's connection and Git text ask, a Git text turn with its reply.
const fakeCodexSource=({log,wsModule})=>`import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ws from ${JSON.stringify(wsModule)};
const args=process.argv.slice(2),at=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
const listen=args[0]==="app-server"?String(at("--listen")||""):"";
if(!listen.startsWith("ws://"))process.exit(1);
const tokenFile=at("--ws-token-file"),token=at("--ws-auth")==="capability-token"&&tokenFile?readFileSync(tokenFile,"utf8").trim():null;
const record=entry=>appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,...entry})+"\\n");
record({event:"start",args,listen,tokenFile,token:token?createHash("sha256").update(token).digest("hex"):null});
const server=createServer((req,res)=>{res.writeHead(req.url==="/readyz"?200:404);res.end()});
const wss=new ws.WebSocketServer({noServer:true});
server.on("upgrade",(req,socket,head)=>{
  if(!token||req.headers.authorization!=="Bearer "+token){record({event:"refused",authorization:req.headers.authorization?"wrong":"none"});socket.end("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");return}
  wss.handleUpgrade(req,socket,head,client=>client.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    const params=message.params||{},reply=result=>client.send(JSON.stringify({id:message.id,result})),notify=(method,value)=>client.send(JSON.stringify({method,params:value}));
    if(message.method==="initialize")return reply({userAgent:"fake-codex-auth/"+process.pid});
    if(message.method==="account/read")return reply({account:{type:"chatgpt",email:"auth@example.test",planType:"plus"},requiresOpenaiAuth:true});
    if(message.method==="model/list")return reply({data:[{id:"gpt-6-astra",model:"gpt-6-astra",displayName:"GPT-6 Astra",hidden:false,isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null});
    if(message.method==="config/read")return reply({config:{},origins:{},layers:null});
    if(message.method==="thread/start")return reply({thread:{id:"git-text-thread"},model:"gpt-6-astra"});
    if(message.method==="thread/fork")return reply({thread:{id:"imported-thread"}});
    if(message.method==="turn/start"){
      reply({turn:{id:"git-text-turn",status:"inProgress",items:[]}});
      setTimeout(()=>{notify("item/completed",{threadId:params.threadId,turnId:"git-text-turn",item:{type:"agentMessage",id:"m1",text:"chore: write Git text over an app-server only Trebell can reach",phase:"final_answer"}});notify("turn/completed",{threadId:params.threadId,turn:{id:"git-text-turn",status:"completed",items:[]}})},20);
      return;
    }
    reply({data:[],nextCursor:null});
  }));
});
server.listen(Number(new URL(listen).port),"127.0.0.1");
`;

// A Codex from before --ws-auth stops on the argument as clap does, and its last line said only to try --help.
const OLD_CODEX=String.raw`
const args=process.argv.slice(2);
if(args.includes("--ws-auth")){process.stderr.write("error: unexpected argument '--ws-auth' found\n\n  tip: to pass '--ws-auth' as a value, use '-- --ws-auth'\n\nUsage: codex app-server [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n");process.exit(2)}
process.exit(1);
`;
test("a Codex too old for --ws-auth says so, and to update Codex, when its app-server cannot start",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-ws-auth-old-")),script=join(root,"old-codex.mjs"),home=join(root,"home");
  await mkdir(home,{recursive:true});await mkdir(join(root,"codex-home"),{recursive:true});await writeFile(script,OLD_CODEX);
  const bin=join(root,process.platform==="win32"?"old-codex.cmd":"old-codex");
  await writeFile(bin,process.platform==="win32"?`@"${process.execPath}" "${script}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,{mode:0o755});
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",onboardingComplete:true}}));
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:join(root,"codex-home"),CLAUDE_CONFIG_DIR:join(root,"claude-config"),TREBELL_CODEX_BIN:bin,TREBELL_GUI_MOCK:"",TREBELL_E2E_OFFLINE:"",TREBELL_APP_SERVER_PORT:"",TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const probe=AgentRuntimeManager.prototype.probe;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.kind===instanceOrKind):instanceOrKind;
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  let gui=null;
  try{
    gui=await createGuiServer({port:await freePort(),mock:false,env});
    const boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());
    assert.equal(boot.appServerReady,false);
    assert.match(String(boot.appServerError),/^Codex app-server profile '.+' exited before it was ready: this Codex has no --ws-auth, which Trebell Code starts each Codex app-server with so that only Trebell Code can connect to it\. Update Codex \(npm install -g @openai\/codex\), then try again\.$/);
    await until(async()=>(await readdir(join(home,"run")).catch(()=>[])).length===0,"the token file of the app-server that never started is gone");
  }finally{
    AgentRuntimeManager.prototype.probe=probe;
    if(gui)await gui.close();
    await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("every Codex app-server Trebell starts takes only its own token, and the app's connection, the model list and Git text all send it",async()=>{
  // Trebell's home has a space in its path, so the token file's path goes through the codex.cmd launcher in quotes.
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-ws-auth-")),home=join(root,"trebell home"),log=join(root,"codex.log"),script=join(root,"fake-codex.mjs");
  const repo=join(root,"repo");await mkdir(repo,{recursive:true});await mkdir(home,{recursive:true});await mkdir(join(root,"codex-home"),{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","ws-auth@example.test"]);await git(repo,["config","user.name","Ws Auth"]);
  await writeFile(join(repo,"notes.txt"),"before\n");await git(repo,["add","notes.txt"]);await git(repo,["commit","-m","Initial notes"]);await writeFile(join(repo,"notes.txt"),"after\n");
  await writeFile(log,"");await writeFile(script,fakeCodexSource({log,wsModule:pathToFileURL(require.resolve("ws")).href}));
  const bin=join(root,process.platform==="win32"?"fake-codex.cmd":"fake-codex");
  await writeFile(bin,process.platform==="win32"?`@"${process.execPath}" "${script}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,{mode:0o755});
  // The Codex profile runs on a home of its own, so the session in CODEX_HOME is one to import.
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",onboardingComplete:true,agentRuntimeInstances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true,homePath:join(root,"codex-profile-home"),shadowHomePath:"",environment:{}}]}}));
  const sessions=join(root,"codex-home","sessions","2026","10","27");await mkdir(sessions,{recursive:true});
  await writeFile(join(sessions,"rollout-ws-auth.jsonl"),[
    {timestamp:"2026-10-27T08:00:00.000Z",type:"session_meta",payload:{id:"codex-session-ws-auth",cwd:repo}},
    {timestamp:"2026-10-27T08:00:01.000Z",type:"event_msg",payload:{type:"user_message",message:"Fix the release notes"}},
  ].map(line=>JSON.stringify(line)).join("\n")+"\n");
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:join(root,"codex-home"),CLAUDE_CONFIG_DIR:join(root,"claude-config"),TREBELL_CODEX_BIN:bin,TREBELL_GUI_MOCK:"",TREBELL_E2E_OFFLINE:"",TREBELL_APP_SERVER_PORT:"",TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const entries=async()=>(await readFile(log,"utf8")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  // No harness CLI runs for a status check: each answers as a ready one.
  const probe=AgentRuntimeManager.prototype.probe;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.kind===instanceOrKind):instanceOrKind;
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  let gui=null,browser=null;
  try{
    gui=await createGuiServer({port:await freePort(),mock:false,env});
    // The app's Codex connection: initialize reaches the catalog app-server through the relay.
    browser=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/codex/ws");
    await new Promise((resolve,reject)=>{browser.once("open",resolve);browser.once("error",reject)});
    const answered=new Promise(resolve=>browser.once("message",raw=>resolve(JSON.parse(String(raw)))));
    browser.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"ws-auth-test",version:"0"}}}));
    assert.match(String((await answered).result?.userAgent),/^fake-codex-auth\//);
    // The model list, read by the catalog's own client.
    const catalog=await fetch(gui.url+"/api/models").then(response=>response.json());
    assert.deepEqual(catalog.models,["gpt-6-astra"],JSON.stringify(catalog));
    // Git text, on an app-server of its own.
    const commit=await fetch(gui.url+"/api/git/commit-message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:repo,environmentId:null})});
    const commitBody=await commit.json();assert.equal(commit.status,200,JSON.stringify(commitBody));
    assert.equal(commitBody.message,"chore: write Git text over an app-server only Trebell can reach");
    // History import, through its own client to the catalog app-server.
    const listed=(await fetch(gui.url+"/api/history-import").then(response=>response.json())).sessions.find(item=>item.providerSessionId==="codex-session-ws-auth");
    assert.ok(listed,"the Codex session is offered for import");
    const imported=await fetch(gui.url+"/api/history-import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionIds:[listed.id]})}).then(response=>response.json());
    assert.deepEqual(imported.results.map(item=>[item.status,item.threadId,item.error]),[["imported","imported-thread",undefined]],JSON.stringify(imported.results));
    const starts=(await entries()).filter(entry=>entry.event==="start");
    assert.ok(starts.length>=2,"the catalog's and Git text's app-servers");
    for(const start of starts){
      const at=start.args.indexOf("--ws-auth");
      assert.deepEqual(start.args.slice(at,at+3),["--ws-auth","capability-token","--ws-token-file"],JSON.stringify(start.args));
      assert.equal(start.tokenFile,start.args[at+3]);assert.equal(isAbsolute(start.tokenFile),true);
      assert.equal(relative(join(home,"run"),start.tokenFile).startsWith(".."),false,"the token file is under Trebell's run folder");
      assert.ok(start.token,"the app-server read its token");
    }
    assert.equal(new Set(starts.map(start=>start.token)).size,starts.length,"no two app-servers share a token");
    assert.deepEqual((await entries()).filter(entry=>entry.event==="refused"),[],"every Trebell client sent the token");
    // Another program on the machine without the token is refused.
    const catalogUrl=starts[0].listen;
    assert.equal(await refusal(catalogUrl),401);assert.equal(await refusal(catalogUrl,{Authorization:"Bearer guessed"}),401);
    assert.equal((await entries()).filter(entry=>entry.event==="refused").length,2);
    browser.close();browser=null;await gui.close();gui=null;
    // An app-server that has ended takes its token file with it.
    await until(async()=>(await readdir(join(home,"run")).catch(()=>[])).length===0,"every token file is gone");
  }finally{
    AgentRuntimeManager.prototype.probe=probe;
    browser?.close();if(gui)await gui.close();
    await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
