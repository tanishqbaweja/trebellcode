import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { processesLeft, windowsProcesses } from "./fixtures/windows-processes.mjs";

// A project action's runs that reach the server together: the two clicks of a double click on the header's action button (or its
// key pressed twice) both leave before either answers, since starting the terminal takes a moment. The action starts once.
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

async function actionServer(prefix,command=`node -e "console.log('dev server ready');setInterval(()=>{},1000)"`){
  const home=await mkdtemp(join(tmpdir(),prefix)),projectPath=join(home,"app");await mkdir(projectPath,{recursive:true});
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",onboardingComplete:true});state.close?.();
  const fetchFn=async input=>{throw new Error("Unexpected external request: "+String(input?.url||input))};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:false,env,fetchFn});
  const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(response=>response.json());
  const running=async()=>(await fetch(gui.url+"/api/terminal/sessions").then(response=>response.json())).sessions.filter(session=>session.running).map(session=>session.id);
  await post("/api/projects",{path:projectPath,scripts:[{id:"dev",name:"Dev server",command}]});
  const run=()=>post("/api/project-script/run",{path:projectPath,environmentId:null,scriptId:"dev"});
  const stop=()=>post("/api/project-script/stop",{path:projectPath,environmentId:null,scriptId:"dev"});
  return {gui,post,running,run,stop,async close(){
    // Whatever still runs (a copy nothing tracks) is ended, so no program outlives the test.
    for(const id of await running().catch(()=>[]))await fetch(gui.url+"/api/terminal/sessions?id="+encodeURIComponent(id),{method:"DELETE"}).catch(()=>{});
    await gui.close();await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }};
}

test("two runs of one project action sent together start it once, and its Stop leaves nothing running",{timeout:60_000},async()=>{
  const server=await actionServer("trebell-project-action-double-run-");
  try{
    const [first,second]=await Promise.all([server.run(),server.run()]);
    const runningNow=await server.running();
    console.log("first:",JSON.stringify({id:first.session?.id,alreadyRunning:first.alreadyRunning}),"second:",JSON.stringify({id:second.session?.id,alreadyRunning:second.alreadyRunning}),"running:",JSON.stringify(runningNow));
    assert.equal(first.ok,true);assert.equal(second.ok,true);
    assert.equal(runningNow.length,1,"one terminal runs the action");
    assert.equal(second.session?.id,first.session?.id,"both answers name the same terminal");
    assert.equal([first,second].filter(answer=>answer.alreadyRunning).length,1,"the later run says it was already running");
    const stopped=await server.stop();
    assert.equal(stopped.session?.running,false);
    assert.deepEqual(await server.running(),[],"Stop ends the action: no copy is left running");
  }finally{await server.close()}
});

// A project action's Stop on Windows, right as the action starts (the click after Run, on a loaded host) or once it runs: Stop ends
// the action's shell, its program and the programs that one started, one of them detached as a dev server's tools can start one, and
// the terminal's console host. The action's program was left running with its console host once its shell had ended, and the test
// above then waited on its folder (NF-1). Each process is found by a mark in its command line (the shell's holds the program's), the
// console host by its parent, the terminal worker; whatever is left is ended here by its pid.
test("a project action's Stop ends its program and the programs that one started, as the action starts or once it runs",{skip:process.platform!=="win32"&&"Windows process trees",timeout:180_000},async()=>{
  const mark="trebell-action-tree-"+randomUUID(),since=Date.now()-1000,workers=new Set();let left=null;
  const program=`/*${mark}*/const {spawn}=require('child_process');spawn(process.execPath,['-e','/*${mark}:console*/setInterval(()=>{},1000)'],{stdio:'inherit'});spawn(process.execPath,['-e','/*${mark}:detached*/setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}).unref();console.log('dev server ready');setInterval(()=>{},1000)`;
  const ours=rows=>rows.filter(row=>row.commandLine.includes(mark)||workers.has(row.ppid)&&row.created>=since&&row.name==="conhost.exe"&&row.commandLine.includes("--headless"));
  const named=rows=>rows.map(row=>(row.name==="cmd.exe"?"the shell":row.name==="conhost.exe"?"the console host":row.commandLine.includes("spawn(")?"the program":row.commandLine.includes(":detached")?"the program it started detached":"the program it started on its console")+" "+row.pid);
  const server=await actionServer("trebell-project-action-tree-",`node -e "${program}"`);
  try{
    // Once it runs: its shell's parent is the terminal worker, whose console hosts are then looked for too.
    const first=await server.run();assert.equal(first.ok,true);
    const ready=async()=>(await fetch(server.gui.url+"/api/terminal/sessions").then(response=>response.json())).sessions.find(session=>session.id===first.session.id)?.buffer.includes("dev server ready");
    for(const end=Date.now()+20000;!await ready();await new Promise(resolve=>setTimeout(resolve,100)))assert.ok(Date.now()<end,"the action's program starts");
    const shell=(await windowsProcesses()).find(row=>row.pid===first.session.pid);assert.ok(shell,"the action's shell runs");workers.add(shell.ppid);
    assert.equal(ours(await windowsProcesses()).length,5,"the shell, the program, its two and the console host run");
    assert.equal((await server.stop()).session?.running,false);
    left=await processesLeft(ours);
    assert.deepEqual(named(left),[],"Stop once the action runs leaves no shell, program, program it started or console host of it running");
    // As it starts: Stop sent as soon as Run answers, four times over.
    for(let round=0;round<4;round++){const run=await server.run();assert.equal(run.ok,true);assert.equal((await server.stop()).session?.running,false)}
    left=await processesLeft(ours);
    assert.deepEqual(named(left),[],"Stop as the action starts leaves no shell, program, program it started or console host of it running");
  }finally{
    for(const row of left??ours(await windowsProcesses().catch(()=>[])))try{process.kill(row.pid)}catch{}
    await server.close();
  }
});
