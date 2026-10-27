import test,{ mock } from "node:test";
import assert from "node:assert/strict";
import { runSlashCommand } from "../ui/src/turn-support.js";

// The window's side of a Codex /goal (turn-support.js), with App's own parts faked: rpc answers the goal requests from `goal`, stop()
// is the composer's Stop and ends the running turn with Codex's turn/completed after endAfterMs, unless it is left running.
function codexWindow({running=false,goal=null,endAfterMs=20,turnEnds=true,stopFails=null}={}){
  const log=[],listeners=new Set(),alerts=[],notes=[];let current=goal;
  const rpc={
    async request(method,params){
      log.push([method,params]);
      if(method==="thread/goal/get")return {goal:current};
      if(method==="thread/goal/clear"){const cleared=Boolean(current);current=null;return {cleared}}
      if(method==="thread/goal/set"){current={...(current||{}),...params};return {goal:current}}
      return {};
    },
    subscribeNotifications(listener){listeners.add(listener);return ()=>listeners.delete(listener)},
  };
  const deps={
    agentRuntime:"codex",agentRuntimeLabel:"Codex",currentProject:null,projectPath:null,models:["gpt-test"],model:"gpt-test",attachments:[],contextChips:[],
    runtimeCapabilities:{},running,rpc,activeThread:{id:"goal-thread"},activeThreadRef:{current:{id:"goal-thread"}},
    async startTurn(text,paths,model,thread,cwd,focus,options={}){log.push(["startTurn",{text,...(options.inputText?{inputText:options.inputText}:{}),goalPatch:options.goalPatch||null,goalResume:Boolean(options.goalResume)}])},
    async stop(){
      log.push(["stop"]);if(stopFails)throw new Error(stopFails);
      if(current?.status==="active")current={...current,status:"paused"};
      if(turnEnds)setTimeout(()=>{log.push(["turn/completed"]);for(const listener of [...listeners])listener({method:"turn/completed",params:{threadId:"goal-thread",turn:{id:"running-turn",status:"interrupted"}}})},endAfterMs);
    },
    setGoal:()=>{},openRightPanel:()=>{},setComposerAlert:alert=>alerts.push(alert),
    setEvents:update=>{const added=update([]);notes.push(...added.map(item=>item.title))},
  };
  return {deps,log,alerts,notes,steps:()=>log.map(([step])=>step),listeners};
}

test("a new Codex goal's first turn asks for the work toward it, and the Goal panel keeps the objective as written",async()=>{
  const app=codexWindow();
  assert.equal(await runSlashCommand(app.deps,"/goal Make the login tests pass"),true);
  assert.deepEqual(app.log,[["startTurn",{text:"Make the login tests pass",inputText:"Start working toward this goal: Make the login tests pass",goalPatch:{objective:"Make the login tests pass",status:"active"},goalResume:false}]]);
});

test("/goal with an objective sent while a turn runs stops that turn and sets and starts the goal once it has ended",async()=>{
  const app=codexWindow({running:true,goal:{objective:"Old goal",status:"active"}});
  assert.equal(await runSlashCommand(app.deps,"/goal Ship the release notes"),true);
  assert.deepEqual(app.steps(),["stop","turn/completed","startTurn"],"the goal starts after the stopped turn ended");
  assert.deepEqual(app.log.at(-1)[1].goalPatch,{objective:"Ship the release notes",status:"active"});
  assert.equal(app.listeners.size,0,"nothing is left listening");
  assert.deepEqual(app.alerts,[]);
});

test("/goal resume sent while a turn runs stops that turn and resumes the goal in a turn of its own",async()=>{
  const app=codexWindow({running:true,goal:{objective:"Ship it",status:"paused"}});
  assert.equal(await runSlashCommand(app.deps,"/goal resume"),true);
  assert.deepEqual(app.steps(),["thread/goal/get","stop","turn/completed","startTurn"]);
  assert.deepEqual(app.log.at(-1)[1],{text:"",goalPatch:{status:"active"},goalResume:true});
});

test("/goal clear and /goal pause stop a running turn only when the goal drives it",async()=>{
  const driving=codexWindow({running:true,goal:{objective:"Ship it",status:"active"},turnEnds:false});
  await runSlashCommand(driving.deps,"/goal clear");
  assert.deepEqual(driving.steps(),["thread/goal/get","stop","thread/goal/clear"],"a goal turn is stopped, its goal paused first by Stop, then cleared");
  assert.deepEqual(driving.notes,["Goal cleared."]);
  const pausing=codexWindow({running:true,goal:{objective:"Ship it",status:"active"},turnEnds:false});
  await runSlashCommand(pausing.deps,"/goal pause");
  assert.deepEqual(pausing.steps(),["thread/goal/get","stop","thread/goal/set"]);
  const other=codexWindow({running:true,goal:{objective:"Ship it",status:"paused"}});
  await runSlashCommand(other.deps,"/goal clear");
  assert.deepEqual(other.steps(),["thread/goal/get","thread/goal/clear"],"a turn the goal does not drive goes on");
  const idle=codexWindow({running:false,goal:{objective:"Ship it",status:"active"}});
  await runSlashCommand(idle.deps,"/goal pause");
  assert.deepEqual(idle.steps(),["thread/goal/get","thread/goal/set"]);
});

test("a goal whose running turn could not be stopped keeps the draft and says why",async()=>{
  const app=codexWindow({running:true,stopFails:"Codex refused the interrupt"});
  assert.equal(await runSlashCommand(app.deps,"/goal Ship the release notes"),"kept");
  assert.deepEqual(app.steps(),["stop"]);
  assert.deepEqual(app.alerts,[{kind:"send",text:"Could not set the goal: Codex refused the interrupt. Your draft is kept."}]);
});

test("a stopped turn whose end does not come within 10 s leaves the goal's start to Codex",async()=>{
  mock.timers.enable({apis:["setTimeout"]});
  try{
    const app=codexWindow({running:true,turnEnds:false});
    const sent=runSlashCommand(app.deps,"/goal Ship the release notes");
    for(let round=0;round<20;round++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(app.steps(),["stop"],"it waits for the turn's end");
    mock.timers.tick(10_000);
    assert.equal(await sent,true);assert.deepEqual(app.steps(),["stop","startTurn"]);
  }finally{mock.timers.reset()}
});
