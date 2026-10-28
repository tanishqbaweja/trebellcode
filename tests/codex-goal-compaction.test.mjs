// A Codex goal command never stops a compaction of the thread's own (T3 queues it after a maintenance run such as /compact): /goal with
// an objective, or /goal resume, waits for the compaction's turn to end, then sets the goal and starts its turn; /goal clear and pause
// leave the compaction running. A turn that compacts as it works is stopped as any other running turn (codex-goal-commands.test.mjs):
// an ordinary turn, and a goal's own, also one that opens with a compaction. The window's side is turn-support.js runSlashCommand, with
// App's parts faked: compactionWaiters is the compaction this window waits for, turnItems the kinds of item the running turn has shown
// since its turn/started, and goal the thread's goal as the window last heard of it.
import test from "node:test";
import assert from "node:assert/strict";
import { runSlashCommand } from "../ui/src/turn-support.js";

const THREAD="goal-thread",TURN="running-turn";
function compactingWindow({goal=null,items=["contextCompaction"],own=false}={}){
  const log=[],listeners=new Set();let current=goal;
  const rpc={
    async request(method,params){log.push([method]);if(method==="thread/goal/get")return {goal:current};if(method==="thread/goal/clear"){current=null;return {cleared:true}}if(method==="thread/goal/set"){current={...(current||{}),...params};return {goal:current}}return {}},
    subscribeNotifications(listener){listeners.add(listener);return ()=>listeners.delete(listener)},
  };
  // The running turn ends as Codex ends it: by itself (a compaction), or once it is stopped.
  const turnEnds=()=>{log.push(["turn/completed"]);for(const listener of [...listeners])listener({method:"turn/completed",params:{threadId:THREAD,turn:{id:TURN,status:"completed"}}})};
  const deps={agentRuntime:"codex",agentRuntimeLabel:"Codex",currentProject:null,projectPath:null,models:["gpt-test"],model:"gpt-test",attachments:[],contextChips:[],runtimeCapabilities:{},
    running:true,activeTurnId:TURN,goal,compactionWaiters:new Map(own?[[THREAD,{}]]:[]),turnItems:{key:THREAD+"\u0000"+TURN,types:new Set(items)},
    rpc,activeThread:{id:THREAD},activeThreadRef:{current:{id:THREAD}},
    async startTurn(text,paths,model,thread,cwd,focus,options={}){log.push(["startTurn",options.goalResume?"resume":text])},
    async stop(){log.push(["stop"]);setImmediate(turnEnds)},
    setGoal:()=>{},openRightPanel:()=>{},setComposerAlert:()=>{},setEvents:()=>{}};
  return {deps,log,steps:()=>log.map(([step])=>step),turnEnds,listeners};
}

test("/goal with an objective sent while Codex compacts the thread waits for the compaction to end, then starts the goal",async()=>{
  const app=compactingWindow();
  const running=runSlashCommand(app.deps,"/goal Ship the release notes");
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(app.steps(),[],"nothing is stopped or started while the compaction runs");
  app.turnEnds();
  assert.equal(await running,true);
  assert.deepEqual(app.steps(),["turn/completed","startTurn"],"the goal's turn starts once the compaction's has ended");
  assert.equal(app.listeners.size,0);
});

test("/goal resume waits for a compaction too, and /goal clear and pause leave the compaction this window asked for running",async()=>{
  const resume=compactingWindow({goal:{objective:"Ship it",status:"paused"}});
  const resuming=runSlashCommand(resume.deps,"/goal resume");
  await new Promise(resolve=>setImmediate(resolve));
  resume.turnEnds();await resuming;
  assert.deepEqual(resume.steps(),["thread/goal/get","turn/completed","startTurn"]);
  for(const command of ["/goal clear","/goal pause"]){
    const app=compactingWindow({goal:{objective:"Ship it",status:"active"},own:true});
    await runSlashCommand(app.deps,command);
    assert.ok(!app.steps().includes("stop"),command+" does not stop the compaction");
  }
});

test("a turn that compacts as it works is stopped at once: an ordinary one for a new goal or a resume, and a goal's own for each goal command",async()=>{
  // An ordinary turn that Codex compacts on its way: /goal with an objective stops it, and the goal's turn starts once it has ended.
  const ordinary=compactingWindow({items:["userMessage","reasoning","contextCompaction"]});
  assert.equal(await runSlashCommand(ordinary.deps,"/goal Ship the release notes"),true);
  assert.deepEqual(ordinary.steps(),["stop","turn/completed","startTurn"]);
  const resumed=compactingWindow({goal:{objective:"Ship it",status:"paused"},items:["userMessage","contextCompaction"]});
  await runSlashCommand(resumed.deps,"/goal resume");
  assert.deepEqual(resumed.steps(),["thread/goal/get","stop","turn/completed","startTurn"]);
  // A goal's own turn, one that worked before it compacts and one that opens with a compaction: each goal command stops it.
  for(const items of [["agentMessage","commandExecution","contextCompaction"],["contextCompaction"]]){
    for(const command of ["/goal pause","/goal clear","/goal Ship the release notes"]){
      const app=compactingWindow({goal:{objective:"Ship it",status:"active"},items});
      await runSlashCommand(app.deps,command);
      assert.equal(app.steps().filter(step=>step==="stop").length,1,command+" stops the goal's turn that shows "+items.join(", "));
    }
  }
});
