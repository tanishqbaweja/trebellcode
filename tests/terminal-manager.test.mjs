import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { TerminalManager } from "../src/terminal-manager.mjs";
import { buildRuntimeEnvironment } from "../src/runtime-environment.mjs";

test("the terminal worker starts with the first terminal, and a manager that ran none shuts down without one",{timeout:20000},async()=>{
  const idle=new TerminalManager({persist:false});
  assert.equal(idle.child,null,"no worker before a terminal");assert.deepEqual(idle.list(),[]);
  await idle.shutdown();assert.equal(idle.child,null,"shutting down starts none");
  await assert.rejects(()=>idle.create({cwd:process.cwd()}),/shut down/,"a shut down manager starts no worker");
  const terminals=new TerminalManager({persist:false});
  try{
    const shell=process.platform==="win32"?(process.env.COMSPEC||"cmd.exe"):(process.env.SHELL||"/bin/bash");
    const args=process.platform==="win32"?["/d","/s","/c","exit /b 0"]:["-lc","exit 0"];
    const first=await terminals.create({cwd:process.cwd(),shell,args});const worker=terminals.child;
    assert.ok(worker?.pid,"the first terminal starts the worker");
    await terminals.waitForExit(first.id,{timeoutMs:10000});
    await terminals.create({cwd:process.cwd(),shell,args});assert.equal(terminals.child,worker,"later terminals share it");
  }finally{await terminals.shutdown()}
});

test("persistent terminal worker starts a PTY and retains output",{timeout:20000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    const session=await terminals.create({cwd:process.cwd(),cols:100,rows:30});
    const marker="trebell-terminal-"+Date.now();
    const output=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("terminal output timeout")),10000);
      const listener=(id,data)=>{if(id===session.id&&data.includes(marker)){clearTimeout(timer);terminals.off("output",listener);resolve(data);}};
      terminals.on("output",listener);
    });
    const command=process.platform==="win32"?`echo ${marker}\r`:`printf '${marker}\\n'\n`;
    await terminals.write(session.id,command);
    await output;
    assert.match(terminals.snapshot(session.id).buffer,new RegExp(marker));
  }finally{await terminals.shutdown();}
});


test("terminal manager can await a dedicated command PTY",{timeout:20000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    const marker="trebell-setup-"+Date.now();
    const shell=process.platform==="win32"?(process.env.COMSPEC||"cmd.exe"):(process.env.SHELL||"/bin/bash");
    const args=process.platform==="win32"
      ? ["/d","/s","/c",`echo ${marker} & exit /b 7`]
      : ["-lc",`printf '${marker}\\n'; exit 7`];
    const session=await terminals.create({cwd:process.cwd(),shell,args,name:"Setup test"});
    const completion=await terminals.waitForExit(session.id,{timeoutMs:10000});
    assert.equal(completion.exitCode,7);
    assert.match(terminals.snapshot(session.id).buffer,new RegExp(marker));
    assert.equal(terminals.snapshot(session.id).running,false);
  }finally{await terminals.shutdown();}
});

test("exact terminal environments do not re-inherit secrets from the terminal worker",{timeout:20000},async()=>{
  const secret="terminal-worker-secret-"+Date.now(),env={...process.env,TERMINAL_PRIVATE_SECRET:secret};
  const terminals=new TerminalManager({env,persist:false});
  try{
    const childEnv=buildRuntimeEnvironment("native",{parent:env,platform:process.platform});
    const source="process.stdout.write(JSON.stringify({secret:process.env.TERMINAL_PRIVATE_SECRET||null,hasPath:Boolean(process.env.PATH||process.env.Path)}))";
    const session=await terminals.create({cwd:process.cwd(),shell:process.execPath,args:["-e",source],env:childEnv,replaceEnv:true,name:"Exact env"});
    const completion=await terminals.waitForExit(session.id,{timeoutMs:10000});assert.equal(completion.exitCode,0);
    const output=terminals.snapshot(session.id).buffer;assert.doesNotMatch(output,new RegExp(secret));assert.match(output,/"secret":null/);assert.match(output,/"hasPath":true/);
  }finally{await terminals.shutdown()}
});

test("terminal scrollback survives manager restart as stopped history",{timeout:30000},async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-history-"));const env={...process.env,TREBELL_HOME:home};let first=null,second=null;
  try{
    first=new TerminalManager({env});
    const marker="trebell-history-"+Date.now();
    const shell=process.platform==="win32"?(process.env.COMSPEC||"cmd.exe"):(process.env.SHELL||"/bin/bash");
    const args=process.platform==="win32"?["/d","/s","/c",`echo ${marker}`]:["-lc",`printf '${marker}\\n'`];
    const session=await first.create({cwd:process.cwd(),displayCwd:"/srv/app",shell,args,name:"History fixture",environmentId:"ssh-a",environmentName:"Build box",environmentType:"ssh"});
    await first.waitForExit(session.id,{timeoutMs:10000});assert.match(first.snapshot(session.id).buffer,new RegExp(marker));
    await first.shutdown();first=null;
    second=new TerminalManager({env});const restored=second.snapshot(session.id);
    assert.ok(restored);assert.equal(restored.running,false);assert.equal(restored.restored,true);assert.equal(restored.name,"History fixture");assert.equal(restored.cwd,"/srv/app");assert.equal(restored.environmentId,"ssh-a");assert.equal(restored.environmentName,"Build box");assert.equal(restored.environmentType,"ssh");assert.match(restored.buffer,new RegExp(marker));
    assert.equal(second.list("ssh-a").length,1);assert.equal(second.list(null).length,0);
    await assert.rejects(()=>second.write(session.id,"echo should-not-run\r"),/stopped/i);
    await second.close(session.id);assert.equal(second.snapshot(session.id),null);
  }finally{await first?.shutdown().catch(()=>{});await second?.shutdown().catch(()=>{});await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("terminal history redacts persisted credentials without changing live scrollback",{timeout:30000},async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-redaction-")),credential=["opaque","terminal","credential"].join("-");
  const env={...process.env,TREBELL_HOME:home,CUSTOM_TERMINAL_TOKEN:credential};let first=null,second=null;
  try{
    first=new TerminalManager({env});
    const shell=process.platform==="win32"?(process.env.COMSPEC||"cmd.exe"):(process.env.SHELL||"/bin/bash");
    const args=process.platform==="win32"?["/d","/s","/c",`echo ${credential}`]:["-lc",`printf '${credential}\\n'`];
    const session=await first.create({cwd:process.cwd(),shell,args,name:"Redaction fixture"});
    await first.waitForExit(session.id,{timeoutMs:10000});
    assert.match(first.snapshot(session.id).buffer,new RegExp(credential),"live terminal output should remain unchanged");
    await first.shutdown();first=null;
    const storedText=await import("node:fs/promises").then(fs=>fs.readFile(join(home,"terminal-history.json"),"utf8"));
    assert.doesNotMatch(storedText,new RegExp(credential));assert.match(storedText,/\[redacted\]/);
    second=new TerminalManager({env});const restored=second.snapshot(session.id);
    assert.ok(restored);assert.doesNotMatch(restored.buffer,new RegExp(credential));assert.match(restored.buffer,/\[redacted\]/);
  }finally{await first?.shutdown().catch(()=>{});await second?.shutdown().catch(()=>{});await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("terminal history pruning removes only stopped sessions older than the cutoff",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-prune-"));const env={...process.env,TREBELL_HOME:home};
  const manager=new TerminalManager({env,persist:false});
  try{
    manager.sessions.set("old",{id:"old",name:"Old",cwd:home,running:false,updatedAt:100,createdAt:100,buffer:"",exitCode:0});
    manager.sessions.set("fresh",{id:"fresh",name:"Fresh",cwd:home,running:false,updatedAt:900,createdAt:900,buffer:"",exitCode:0});
    manager.sessions.set("live",{id:"live",name:"Live",cwd:home,running:true,updatedAt:10,createdAt:10,buffer:"",exitCode:null});
    const result=manager.pruneStopped({before:500});
    assert.deepEqual(result,{removed:1,remaining:2});
    assert.equal(manager.snapshot("old"),null);
    assert.equal(manager.snapshot("fresh").running,false);
    assert.equal(manager.snapshot("live").running,true);
  }finally{await manager.shutdown().catch(()=>{});await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("shutdown preserves the age of already-stopped terminal history",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-age-"));const env={...process.env,TREBELL_HOME:home};
  const manager=new TerminalManager({env});
  try{
    manager.sessions.set("old",{id:"old",name:"Old",cwd:home,running:false,updatedAt:1234,createdAt:1000,buffer:"history",exitCode:0});
    await manager.shutdown();
    const stored=JSON.parse(await import("node:fs/promises").then(fs=>fs.readFile(join(home,"terminal-history.json"),"utf8")));
    assert.equal(stored.sessions.find(item=>item.id==="old").updatedAt,1234);
  }finally{await manager.shutdown().catch(()=>{});await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a long run of output leaves the terminal manager's event loop free and its history bounded",{timeout:120000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    const session=await terminals.create({cwd:process.cwd(),cols:120,rows:32});
    const command=process.platform==="win32"?"for /L %i in (1,1,30000) do @echo line %i\r":"i=1; while [ $i -le 30000 ]; do echo line $i; i=$((i+1)); done\n";
    const delay=monitorEventLoopDelay({resolution:10});delay.enable();
    await terminals.write(session.id,command);
    const started=Date.now();
    while(!/line 30000\s/.test(terminals.snapshot(session.id).buffer.slice(-400))){
      assert.ok(Date.now()-started<90000,"the 30,000 lines arrive");
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    delay.disable();
    // Cutting the buffer back on every message held the loop for seconds at a time: its longest waits (the 99.9th percentile)
    // ran from 0.7 to 1.4 s, against about 25 ms now, while its 99th percentile sometimes stayed under 200 ms.
    assert.ok(delay.percentile(99.9)/1e6<300,"event loop delay p99.9 "+Math.round(delay.percentile(99.9)/1e6)+" ms");
    assert.ok(terminals.snapshot(session.id).buffer.split("\n").length<=5501);
  }finally{await terminals.shutdown()}
});

// A project action's terminal runs its command as its own program, so the session runs exactly while the action does. Stop ends the
// program and keeps the session as stopped history, as its own exit does; a watch socket (the header's action button) hears only
// whether it runs, never its output.
test("stop ends a session's program and keeps its history, and a watch socket hears its state and exit without its output",{timeout:30000},async()=>{
  const { createServer } = await import("node:http");
  const { WebSocket } = await import("ws");
  const terminals=new TerminalManager({persist:false}),server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const attached=terminals.attachWebSocket(server);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  let watch=null;
  try{
    const marker="trebell-action-"+Date.now();
    const shell=process.platform==="win32"?(process.env.COMSPEC||"cmd.exe"):(process.env.SHELL||"/bin/bash");
    const command=`node -e "console.log('${marker}');setInterval(()=>console.log('tick'),200)"`;
    const args=process.platform==="win32"?`/d /s /c "${command}"`:["-lc",command];
    const session=await terminals.create({cwd:process.cwd(),shell,args,name:"Dev server"});
    const heard=[];watch=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/terminal/ws?watch=1&session=${encodeURIComponent(session.id)}`);
    const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("no exit heard")),15000);watch.on("message",raw=>{const message=JSON.parse(String(raw));heard.push(message);if(message.type==="exit"){clearTimeout(timer);resolve(message)}});watch.once("error",reject)});exited.catch(()=>{});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("no output")),10000);const listener=(id,data)=>{if(id===session.id&&terminals.snapshot(id).buffer.includes("tick")){clearTimeout(timer);terminals.off("output",listener);resolve()}};terminals.on("output",listener)});
    const stopped=await terminals.stop(session.id);
    assert.equal(stopped.running,false,"stopped");
    assert.match(stopped.buffer,new RegExp(marker),"its output is kept");
    assert.equal(terminals.list().some(item=>item.id===session.id),true,"the session stays as stopped history");
    await exited;
    assert.deepEqual(heard[0],{type:"state",running:true,exitCode:null},"the watch socket starts with the state alone");
    assert.equal(heard.some(message=>message.type==="output"||message.type==="snapshot"),false,"and hears no output");
    assert.equal((await terminals.stop(session.id)).running,false,"stopping it again changes nothing");
  }finally{try{watch?.terminate()}catch{}attached.close();await new Promise(resolve=>server.close(resolve));await terminals.shutdown()}
});
