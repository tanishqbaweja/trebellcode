// A Codex goal command never stops a compaction the thread runs (T3 queues it after a maintenance run such as /compact): /goal with an
// objective, or /goal resume, waits for the compaction's turn to end, then sets the goal and starts its turn; /goal clear and pause
// leave the compaction running. Any other running turn is stopped as before (codex-goal-commands.test.mjs). The window's side is
// turn-support.js runSlashCommand, with App's parts faked: compacting is App's reading that the open thread compacts.
import test from "node:test";
import assert from "node:assert/strict";
import { runSlashCommand } from "../ui/src/turn-support.js";

function compactingWindow({goal=null}={}){
  const log=[],listeners=new Set();let current=goal;
  const rpc={
    async request(method,params){log.push([method]);if(method==="thread/goal/get")return {goal:current};if(method==="thread/goal/clear"){current=null;return {cleared:true}}if(method==="thread/goal/set"){current={...(current||{}),...params};return {goal:current}}return {}},
    subscribeNotifications(listener){listeners.add(listener);return ()=>listeners.delete(listener)},
  };
  const deps={agentRuntime:"codex",agentRuntimeLabel:"Codex",currentProject:null,projectPath:null,models:["gpt-test"],model:"gpt-test",attachments:[],contextChips:[],runtimeCapabilities:{},
    running:true,compacting:true,rpc,activeThread:{id:"goal-thread"},activeThreadRef:{current:{id:"goal-thread"}},
    async startTurn(text,paths,model,thread,cwd,focus,options={}){log.push(["startTurn",options.goalResume?"resume":text])},
    async stop(){log.push(["stop"])},
    setGoal:()=>{},openRightPanel:()=>{},setComposerAlert:()=>{},setEvents:()=>{}};
  // The compaction's turn ends as Codex ends it.
  const compactionEnds=()=>{log.push(["turn/completed"]);for(const listener of [...listeners])listener({method:"turn/completed",params:{threadId:"goal-thread",turn:{id:"compaction-turn",status:"completed"}}})};
  return {deps,log,steps:()=>log.map(([step])=>step),compactionEnds,listeners};
}

test("/goal with an objective sent while Codex compacts the thread waits for the compaction to end, then starts the goal",async()=>{
  const app=compactingWindow();
  const running=runSlashCommand(app.deps,"/goal Ship the release notes");
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(app.steps(),[],"nothing is stopped or started while the compaction runs");
  app.compactionEnds();
  assert.equal(await running,true);
  assert.deepEqual(app.steps(),["turn/completed","startTurn"],"the goal's turn starts once the compaction's has ended");
  assert.equal(app.listeners.size,0);
});

test("/goal resume waits for a compaction too, and /goal clear and pause leave it running",async()=>{
  const resume=compactingWindow({goal:{objective:"Ship it",status:"paused"}});
  const resuming=runSlashCommand(resume.deps,"/goal resume");
  await new Promise(resolve=>setImmediate(resolve));
  resume.compactionEnds();await resuming;
  assert.deepEqual(resume.steps(),["thread/goal/get","turn/completed","startTurn"]);
  for(const command of ["/goal clear","/goal pause"]){
    const app=compactingWindow({goal:{objective:"Ship it",status:"active"}});
    await runSlashCommand(app.deps,command);
    assert.ok(!app.steps().includes("stop"),command+" does not stop the compaction");
  }
});
