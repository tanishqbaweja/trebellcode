import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

// A project action's runs that reach the server together: the two clicks of a double click on the header's action button (or its
// key pressed twice) both leave before either answers, since starting the terminal takes a moment. The action starts once.
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

async function actionServer(prefix){
  const home=await mkdtemp(join(tmpdir(),prefix)),projectPath=join(home,"app");await mkdir(projectPath,{recursive:true});
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",onboardingComplete:true});state.close?.();
  const fetchFn=async input=>{throw new Error("Unexpected external request: "+String(input?.url||input))};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:false,env,fetchFn});
  const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(response=>response.json());
  const running=async()=>(await fetch(gui.url+"/api/terminal/sessions").then(response=>response.json())).sessions.filter(session=>session.running).map(session=>session.id);
  await post("/api/projects",{path:projectPath,scripts:[{id:"dev",name:"Dev server",command:`node -e "console.log('dev server ready');setInterval(()=>{},1000)"`}]});
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
