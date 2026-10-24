import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { TerminalManager } from "../src/terminal-manager.mjs";
import { buildRuntimeEnvironment } from "../src/runtime-environment.mjs";
import { processesLeft, windowsProcesses } from "./fixtures/windows-processes.mjs";

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

// The worker can die under open terminals (it crashed, or something ended it), and their shells end with it. Each of its terminals
// then ends as on its program's own exit, and the next terminal starts a new worker: an open command line used to take input that
// vanished, and the next terminal waited for the dead worker until it timed out after 15 s, so no terminal worked again until the app
// restarted. These tests end only the worker their own manager started.
const until=async(check,timeoutMs)=>{for(const end=Date.now()+timeoutMs;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,50)))if(check())return true;return check()};
test("when the terminal worker dies its terminals end: an open socket hears the exit, waiting for it ends, and input is refused at once",{timeout:90000},async()=>{
  const { createServer } = await import("node:http");
  const { WebSocket } = await import("ws");
  const terminals=new TerminalManager({persist:false}),server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const attached=terminals.attachWebSocket(server);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  let socket=null;
  try{
    const session=await terminals.create({cwd:process.cwd()}),worker=terminals.child,heard=[];
    socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/terminal/ws?session=${encodeURIComponent(session.id)}`);socket.on("message",raw=>heard.push(JSON.parse(String(raw))));
    assert.ok(await until(()=>heard.some(message=>message.type==="snapshot"),10000),"the socket opens on the terminal");
    const ended=terminals.waitForExit(session.id,{timeoutMs:20000});
    worker.kill();
    assert.ok(await until(()=>heard.some(message=>message.type==="exit"),5000),"the open socket hears that its terminal ended: "+JSON.stringify(heard.map(message=>message.type)));
    assert.equal(terminals.snapshot(session.id).running,false,"the terminal is stopped history");
    assert.equal((await ended).timeout,undefined,"waiting for its exit ends with it");
    const asked=Date.now();
    await assert.rejects(()=>terminals.write(session.id,"echo after\r"),/stopped/i,"input to it is refused");
    assert.ok(Date.now()-asked<1000,"at once, not after the worker's timeout");
  }finally{try{socket?.terminate()}catch{}attached.close();await new Promise(resolve=>server.close(resolve));await terminals.shutdown()}
});

// A server that dies without its shutdown (it crashed, or a test run was cut short) leaves its end of the worker's stdin closed. The
// worker then ends its terminals' programs, and what they started, and exits: before, a cut-short test run left a project action's
// dev server running for a day.
test("a terminal worker whose server is gone ends its terminals' programs, and the programs they started, and exits",{timeout:60000},async()=>{
  const terminals=new TerminalManager({persist:false});
  const alive=pid=>{try{process.kill(pid,0);return true}catch(error){return error.code==="EPERM"}};
  try{
    // A program that starts one of its own and lives on, as a dev server a project action runs through a shell does.
    const script="const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('started '+c.pid);setInterval(()=>{},1000)";
    const session=await terminals.create({cwd:process.cwd(),shell:process.execPath,args:["-e",script]}),worker=terminals.child;
    assert.ok(await until(()=>/started \d+/.test(terminals.snapshot(session.id).buffer),10000),"the program starts its own");
    const started=Number(terminals.snapshot(session.id).buffer.match(/started (\d+)/)[1]);
    assert.ok(alive(worker.pid)&&alive(session.pid)&&alive(started),"all three run");
    const exited=new Promise(resolve=>worker.once("exit",()=>resolve(true)));
    worker.stdin.end();
    assert.equal(await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve(false),15000))]),true,"the worker exits");
    assert.ok(await until(()=>!alive(session.pid),5000),"the terminal's program has ended");
    assert.ok(await until(()=>!alive(started),5000),"and so has the program it started");
  }finally{await terminals.shutdown()}
});

// Each write of the history redacts and rewrites every terminal's scrollback (8 MB each at most) on the server's event loop, which in
// the desktop app is its main process. A worker that dies ends all of its terminals at once, so their history is written once, not
// once for each of them. The writes are counted where the manager makes them, through node:fs's renameSync.
test("when the terminal worker dies under several terminals, their history is written once",{timeout:90000},async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-worker-history-")),history=join(home,"terminal-history.json"),writes=[];
  const renameSync=fs.renameSync;
  fs.renameSync=(from,to)=>{if(String(to)===history)writes.push(String(from));return renameSync(from,to)};syncBuiltinESMExports();
  const terminals=new TerminalManager({env:{...process.env,TREBELL_HOME:home}});
  try{
    const sessions=[];for(let index=0;index<3;index++)sessions.push(await terminals.create({cwd:process.cwd(),name:"Terminal "+(index+1)}));
    // Each shell's prompt is in and its own save is done, so the writes counted below are the worker's death's.
    assert.ok(await until(()=>sessions.every(session=>terminals.snapshot(session.id).buffer.length>0),20000),"each shell shows its prompt");
    assert.ok(await until(()=>terminals.saveTimer===null,5000),"no save is waiting");
    const worker=terminals.child;writes.length=0;
    // The manager's own exit listener came first, so this one counts what it wrote.
    const written=new Promise(resolve=>worker.once("exit",()=>resolve(writes.length)));
    worker.kill();
    assert.equal(await written,1,"one write for the three terminals that ended");
    for(const session of sessions)assert.equal(terminals.snapshot(session.id).running,false);
    const saved=JSON.parse(fs.readFileSync(history,"utf8")).sessions;
    assert.deepEqual(saved.map(item=>item.id).sort(),sessions.map(session=>session.id).sort(),"the one write holds all of them");
    assert.ok(saved.every(item=>item.running===false&&item.exitCode===null));
  }finally{fs.renameSync=renameSync;syncBuiltinESMExports();await terminals.shutdown();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("after the terminal worker dies, the next terminal starts a new worker and runs commands",{timeout:90000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    const first=await terminals.create({cwd:process.cwd()}),worker=terminals.child;
    const gone=new Promise(resolve=>worker.once("exit",resolve));worker.kill();await gone;
    // The command prints the marker only when the shell runs it: the typed line holds the variable's name, not its value.
    const marker="trebell-new-worker-"+Date.now(),asked=Date.now();
    const next=await terminals.create({cwd:process.cwd(),env:{TREBELL_TEST_MARK:marker}});
    assert.ok(Date.now()-asked<10000,"the new terminal opens without waiting for the dead worker ("+(Date.now()-asked)+" ms)");
    assert.notEqual(terminals.child,worker,"a new worker runs it");assert.ok(terminals.child?.pid);
    await terminals.write(next.id,process.platform==="win32"?"echo %TREBELL_TEST_MARK%\r":"echo \"$TREBELL_TEST_MARK\"\n");
    assert.ok(await until(()=>terminals.snapshot(next.id).buffer.includes(marker),10000),"the command runs: "+JSON.stringify(terminals.snapshot(next.id).buffer.slice(-300)));
    assert.equal(terminals.snapshot(first.id).running,false,"the first terminal ended with its worker");
  }finally{await terminals.shutdown()}
});

// A tray Quit or Restart & install closes the GUI server while the window is still open, and the HTTP server's close waits for every
// socket on it. The terminal drawer's socket stayed open once the terminals' socket server had closed (ws leaves the sockets it
// accepted open), so with a terminal open the quit never finished and the app stayed running, hidden, without its tray icon.
test("closing the terminals' socket server ends the terminal sockets still open, so the HTTP server's close does not wait on them",{timeout:30000},async()=>{
  const { createServer } = await import("node:http");
  const { WebSocket } = await import("ws");
  const terminals=new TerminalManager({persist:false}),server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const attached=terminals.attachWebSocket(server);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  let socket=null;
  try{
    const session=await terminals.create({cwd:process.cwd()}),heard=[];
    socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/terminal/ws?session=${encodeURIComponent(session.id)}`);socket.on("message",raw=>heard.push(JSON.parse(String(raw)).type));
    assert.ok(await until(()=>heard.includes("snapshot"),10000),"the socket opens on the terminal, as the drawer's does");
    const socketClosed=new Promise(resolve=>socket.once("close",resolve));
    attached.close();
    const serverClosed=new Promise(resolve=>server.close(()=>resolve("closed")));
    assert.equal(await Promise.race([serverClosed,new Promise(resolve=>setTimeout(()=>resolve("still waiting on the terminal's socket"),5000))]),"closed","the HTTP server's close finishes");
    await socketClosed;
  }finally{try{socket?.terminate()}catch{}await terminals.shutdown()}
});

// On Windows a terminal's shell runs in a pseudo-console, and closing it ends only the programs attached to it then: a program the
// shell was still starting (a project action stopped as it starts on a loaded host, or a terminal whose worker ended as it opened)
// missed the close and ran on with its console host and nothing left to stop it, and one started detached never gets it. A terminal
// that runs one command as its own program (endsTree: a project action, a worktree setup) ends all that its command started. Each
// test runs a program that starts two of its own, one on the terminal's console and one detached, as a dev server's tools can, ends
// its terminal one way, and looks for every process of it by a mark in its command line (the shell's holds the program's): the shell,
// the program and its two, and by its parent, the worker, the terminal's console host. Whatever a test finds left it ends by its pid.
const WINDOWS_TREE={skip:process.platform!=="win32"&&"Windows process trees",timeout:180_000};
const markedProgram=mark=>`/*${mark}*/const {spawn}=require('child_process');spawn(process.execPath,['-e','/*${mark}:console*/setInterval(()=>{},1000)'],{stdio:'inherit'});spawn(process.execPath,['-e','/*${mark}:detached*/setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}).unref();console.log('started');setInterval(()=>{},1000)`;
async function programTree(end,{running=false,rounds=1}={}){
  const terminals=new TerminalManager({persist:false}),mark="trebell-tree-"+randomUUID(),workers=new Set(),since=Date.now()-1000;let left=null;
  const program=markedProgram(mark);
  const shell=process.env.COMSPEC||"cmd.exe",args=`/d /s /c "node -e "${program}""`;
  const ours=rows=>rows.filter(row=>row.commandLine.includes(mark)||workers.has(row.ppid)&&row.created>=since&&row.name==="conhost.exe"&&row.commandLine.includes("--headless"));
  const named=rows=>rows.map(row=>(row.name==="cmd.exe"?"the shell":row.name==="conhost.exe"?"the console host":row.commandLine.includes("spawn(")?"the program":row.commandLine.includes(":detached")?"the program it started detached":"the program it started on its console")+" "+row.pid);
  try{
    for(let round=0;round<rounds;round++){
      const session=await terminals.create({cwd:process.cwd(),shell,args,name:"Dev server",endsTree:true});workers.add(terminals.child.pid);
      if(running){
        assert.ok(await until(()=>terminals.snapshot(session.id).buffer.includes("started"),20000),"the program starts its two");
        const runs=named(ours(await windowsProcesses())).map(name=>name.replace(/ \d+$/,"")).sort();
        assert.deepEqual(runs,["the console host","the program","the program it started detached","the program it started on its console","the shell"],"the shell, the program, its two and the console host run");
      }
      await end(terminals,session);
    }
    left=await processesLeft(ours);
    assert.deepEqual(named(left),[],"no shell, program, program it started or console host is left");
  }finally{
    await terminals.shutdown();
    for(const row of left??ours(await windowsProcesses().catch(()=>[])))try{process.kill(row.pid)}catch{}
  }
}
const workerEnds=how=>async terminals=>{const worker=terminals.child,exited=new Promise(resolve=>worker.once("exit",resolve));if(how==="killed")worker.kill();else worker.stdin.end();await exited};
test("on Windows, Stop ends a terminal's shell, its program and the programs that one started, also one started detached, and its console host",WINDOWS_TREE,()=>programTree((terminals,session)=>terminals.stop(session.id),{running:true}));
test("on Windows, a terminal stopped as it starts leaves none of its programs, nor its console host, running",WINDOWS_TREE,()=>programTree((terminals,session)=>terminals.stop(session.id),{rounds:5}));
test("on Windows, closing a terminal ends its shell, its program and the programs that one started, and its console host, without waiting for them",WINDOWS_TREE,()=>programTree(async(terminals,session)=>{const closed=terminals.close(session.id);assert.equal(terminals.snapshot(session.id),null,"the close forgets the terminal at once, not once its programs have ended");await closed},{running:true}));
test("on Windows, a terminal whose manager shuts down as it starts leaves none of its programs, nor its console host, running",WINDOWS_TREE,()=>programTree(terminals=>terminals.shutdown()));
test("on Windows, a terminal whose worker dies as it starts leaves none of its programs, nor its console host, running",WINDOWS_TREE,()=>programTree(workerEnds("killed")));
test("on Windows, a terminal whose server is gone leaves none of its programs, also one started detached, nor its console host, running",WINDOWS_TREE,()=>programTree(workerEnds("orphaned"),{running:true}));

// A terminal a person types into (a tab, a sign-in) ends as a terminal's close does: its console closes, which ends its shell and
// the programs on its console, and its console host goes. A program started from it off its console runs on, as a window program a
// person started from a tab must (Notepad with unsaved work, a browser a sign-in opened): only a terminal that runs one command as
// its own program ends everything its shell started. The stand-in for the window program is a detached Node process, which no
// console reaches either. The program is typed into the shell, as a person runs it; its shell is known by its pid and start time.
async function typedProgramTree(end){
  const terminals=new TerminalManager({persist:false}),mark="trebell-tab-"+randomUUID(),since=Date.now()-1000;let worker=0,shell=null;
  // It prints started-42 only once it runs: the typed line the shell echoes holds 'started-'+6*7.
  const program=markedProgram(mark).replace("console.log('started')","console.log('started-'+6*7)");
  const isShell=row=>Boolean(shell)&&row.pid===shell.pid&&row.created===shell.created;
  const ours=rows=>rows.filter(row=>row.commandLine.includes(mark)||isShell(row)||row.ppid===worker&&row.created>=since&&row.name==="conhost.exe"&&row.commandLine.includes("--headless"));
  const kept=row=>row.commandLine.includes(":detached")&&!row.commandLine.includes("spawn(");
  const named=rows=>rows.map(row=>(isShell(row)?"the shell":row.name==="conhost.exe"?"the console host":row.commandLine.includes("spawn(")?"the program":kept(row)?"the program it started off its console":"the program it started on its console")+" "+row.pid);
  try{
    const session=await terminals.create({cwd:process.cwd(),name:"Terminal"});worker=terminals.child.pid;
    await terminals.write(session.id,`node -e "${program}"\r`);
    assert.ok(await until(()=>terminals.snapshot(session.id).buffer.includes("started-42"),20000),"the program starts its two: "+JSON.stringify(terminals.snapshot(session.id).buffer.slice(-300)));
    const before=await windowsProcesses();shell=before.find(row=>row.pid===session.pid&&row.created>=since)||null;assert.ok(shell,"the shell runs");
    assert.deepEqual(named(ours(before)).map(name=>name.replace(/ \d+$/,"")).sort(),["the console host","the program","the program it started off its console","the program it started on its console","the shell"],"the shell, the program, its two and the console host run");
    await end(terminals,session);
    const left=await processesLeft(rows=>ours(rows).filter(row=>!kept(row)));
    assert.deepEqual(named(left),[],"its shell, its program, the program on its console and its console host end");
    assert.deepEqual(named(ours(await windowsProcesses()).filter(kept)).map(name=>name.replace(/ \d+$/,"")),["the program it started off its console"],"the program it started off its console runs on, as a window program started from a tab does");
  }finally{
    await terminals.shutdown();
    for(const row of ours(await windowsProcesses().catch(()=>[])))try{process.kill(row.pid)}catch{}
  }
}
test("on Windows, closing a terminal a person types into ends its shell, the programs on its console and its console host, and leaves a program started from it off its console running",WINDOWS_TREE,()=>typedProgramTree((terminals,session)=>terminals.close(session.id)));
test("on Windows, Stop of a terminal a person types into ends its shell, the programs on its console and its console host, and leaves a program started from it off its console running",WINDOWS_TREE,()=>typedProgramTree(async(terminals,session)=>assert.equal((await terminals.stop(session.id)).running,false)));
test("on Windows, Quit with a terminal a person types into ends its shell, the programs on its console and its console host, and leaves a program started from it off its console running",WINDOWS_TREE,()=>typedProgramTree(terminals=>terminals.shutdown()));

// A project action's end gives the programs on its console their close event first (CTRL_CLOSE_EVENT, which Node hears as SIGHUP
// and Go as SIGTERM), so each can shut down cleanly (a docker compose up stops its containers, a server runs its shutdown hook), and
// ends what is left of its tree only after that, also the program started detached, which no close event reaches. Its process tree
// ended first (taskkill /t /f) ended every program before any close event came. Here each program on the console notes its close
// event in a file; the action's program takes 1.5 s to shut down, as a server's shutdown hook can, and Stop answers once it has.
test("on Windows, Stop gives a project action's programs on its console their close event before it ends what is left of its tree",WINDOWS_TREE,async()=>{
  const terminals=new TerminalManager({persist:false}),mark="trebell-close-event-"+randomUUID(),since=Date.now()-1000,heard=join(tmpdir(),mark+".log");let worker=0,left=null;
  const noted=(who,ms=0)=>`process.on('SIGHUP',()=>{const fs=require('fs');fs.appendFileSync(process.env.TREBELL_TEST_HEARD,'${who} ');setTimeout(()=>{fs.appendFileSync(process.env.TREBELL_TEST_HEARD,'${who}-done ');process.exit(0)},${ms})});`;
  const notes=()=>{try{return fs.readFileSync(heard,"utf8").trim().split(/\s+/).filter(Boolean).sort()}catch{return []}};
  const child=`/*${mark}:console*/${noted("child")}setInterval(()=>{},1000)`;
  const program=`/*${mark}*/const {spawn}=require('child_process');${noted("program",1500)}spawn(process.execPath,['-e',process.env.TREBELL_TEST_CHILD],{stdio:'inherit'});spawn(process.execPath,['-e','/*${mark}:detached*/setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}).unref();console.log('started');setInterval(()=>{},1000)`;
  const ours=rows=>rows.filter(row=>row.commandLine.includes(mark)||row.ppid===worker&&row.created>=since&&row.name==="conhost.exe"&&row.commandLine.includes("--headless"));
  const named=rows=>rows.map(row=>(row.name==="cmd.exe"?"the shell":row.name==="conhost.exe"?"the console host":row.commandLine.includes("spawn(")?"the program":row.commandLine.includes(":detached")?"the program it started detached":"the program it started on its console")+" "+row.pid);
  try{
    const session=await terminals.create({cwd:process.cwd(),shell:process.env.COMSPEC||"cmd.exe",args:`/d /s /c "node -e "${program}""`,env:{TREBELL_TEST_HEARD:heard,TREBELL_TEST_CHILD:child},name:"Dev server",endsTree:true});worker=terminals.child.pid;
    assert.ok(await until(()=>terminals.snapshot(session.id).buffer.includes("started"),20000),"the program starts its two");
    assert.deepEqual(named(ours(await windowsProcesses())).map(name=>name.replace(/ \d+$/,"")).sort(),["the console host","the program","the program it started detached","the program it started on its console","the shell"],"the shell, the program, its two and the console host run");
    assert.equal((await terminals.stop(session.id)).running,false);
    const atStop=notes();
    left=await processesLeft(ours);
    assert.deepEqual(named(left),[],"Stop leaves no shell, program, program it started or console host of it running");
    assert.deepEqual(notes(),["child","child-done","program","program-done"],"the program and the program it started on its console each heard the close event and shut down before they were ended");
    assert.deepEqual(atStop,["child","child-done","program","program-done"],"Stop answers once the programs on its console have shut down");
  }finally{
    await terminals.shutdown();
    for(const row of left??ours(await windowsProcesses().catch(()=>[])))try{process.kill(row.pid)}catch{}
    await rm(heard,{force:true}).catch(()=>{});
  }
});

// The server's own death on Windows. The desktop app's main process holds the GUI server, and when it crashes or is ended from
// outside, Windows ends with it each process it started that is not detached (Node puts them in a job that closes with it). The
// terminal worker went with it before it could end anything, and every terminal's shell, programs and console host ran on: the tests
// above close only the worker's input, which a server's death does only once the worker outlives it. Here the server is a Node
// process of its own with a terminal manager, a project action's terminal and a person's tab, and the test ends it as Task Manager
// does.
test("on Windows, terminals whose server dies leave none of their programs, nor their console hosts, nor the terminal worker, running",WINDOWS_TREE,async()=>{
  const mark="trebell-server-dies-"+randomUUID(),since=Date.now()-1000,dir=await mkdtemp(join(tmpdir(),"trebell-server-dies-"));let server=null,ids=null,known=[],left=null;
  const script=join(dir,"server.mjs");
  await writeFile(script,[
    `import { TerminalManager } from ${JSON.stringify(new URL("../src/terminal-manager.mjs",import.meta.url).href)};`,
    `const terminals=new TerminalManager({persist:false});`,
    `const action=await terminals.create({cwd:process.cwd(),shell:process.env.COMSPEC||"cmd.exe",args:process.env.TREBELL_TEST_ARGS,name:"Dev server",endsTree:true});`,
    `const tab=await terminals.create({cwd:process.cwd(),name:"Terminal"});`,
    `for(const end=Date.now()+20000;!terminals.snapshot(action.id).buffer.includes("started")||!terminals.snapshot(tab.id).buffer.length;await new Promise(resolve=>setTimeout(resolve,50)))if(Date.now()>end)throw new Error("the terminals did not start");`,
    `process.stdout.write(JSON.stringify({worker:terminals.child.pid,tab:tab.pid})+"\\n");`,
    `setInterval(()=>{},1000);`,
  ].join("\n"));
  const isKnown=row=>known.some(item=>item.pid===row.pid&&item.created===row.created);
  const ours=rows=>rows.filter(row=>row.commandLine.includes(mark)||isKnown(row)||ids&&row.ppid===ids.worker&&row.created>=since&&row.name==="conhost.exe"&&row.commandLine.includes("--headless"));
  const named=rows=>rows.map(row=>(ids&&row.pid===ids.worker?"the terminal worker":ids&&row.pid===ids.tab?"the tab's shell":row.name==="cmd.exe"?"the action's shell":row.name==="conhost.exe"?"a console host":row.commandLine.includes("spawn(")?"the action's program":row.commandLine.includes(":detached")?"the program it started detached":"the program it started on its console")+" "+row.pid);
  try{
    server=spawn(process.execPath,[script],{cwd:process.cwd(),env:{...process.env,TREBELL_TEST_ARGS:`/d /s /c "node -e "${markedProgram(mark)}""`},stdio:["ignore","pipe","pipe"],windowsHide:true});
    let out="",err="";server.stdout.on("data",data=>{out+=data});server.stderr.on("data",data=>{err+=data});
    assert.ok(await until(()=>/^\{.*\}$/m.test(out)||server.exitCode!==null,30000),"the server starts its terminals: "+err.slice(-500));
    ids=JSON.parse(out.match(/^\{.*\}$/m)[0]);
    const before=await windowsProcesses();known=before.filter(row=>(row.pid===ids.worker||row.pid===ids.tab)&&row.created>=since);
    assert.deepEqual(named(ours(before)).map(name=>name.replace(/ \d+$/,"")).sort(),["a console host","a console host","the action's program","the action's shell","the program it started detached","the program it started on its console","the tab's shell","the terminal worker"],"the worker, both terminals' shells and console hosts, and the action's program and its two run");
    const gone=new Promise(resolve=>server.once("exit",resolve));server.kill();await gone;
    left=await processesLeft(ours);
    assert.deepEqual(named(left),[],"once the server is gone, nothing of its terminals runs, and the worker has exited");
  }finally{
    try{server?.kill()}catch{}
    for(const row of left??ours(await windowsProcesses().catch(()=>[])))try{process.kill(row.pid)}catch{}
    await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{});
  }
});
