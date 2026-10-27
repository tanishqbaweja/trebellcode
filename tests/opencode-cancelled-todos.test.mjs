import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { FAKE_OPENCODE1_MODEL, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";
import { eventuallyReal as eventually, openCode1Relay } from "./fixtures/opencode1-relay.mjs";

// OpenCode 1.x's todo list (todo.updated) can mark a step cancelled, which a plan step cannot be: the window showed it as pending, so
// a plan whose remaining steps OpenCode gave up read as unfinished for good. T3 Code's 2333f1688 leaves cancelled todos out.
const TODOS=[{content:"Write the fix",status:"completed",priority:"high"},{content:"Try another approach",status:"cancelled",priority:"medium"},{content:"Add a test",status:"in_progress",priority:"medium"}];

test("an OpenCode todo list leaves its cancelled todos out of the turn's plan",async()=>{
  const fake=await startFakeOpenCode1({onPrompt:async({sessionID,emit})=>{
    emit({type:"todo.updated",properties:{sessionID,todos:TODOS}});
    emit({type:"todo.updated",properties:{sessionID,todos:[TODOS[0],TODOS[1]]}});
    emit({type:"todo.updated",properties:{sessionID,todos:[{...TODOS[1],content:"Drop the cache"}]}});
    await new Promise(resolve=>setTimeout(resolve,100));return "Fixed.";
  }});
  const updates=[],session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fake.url,onUpdate:params=>updates.push(params.update)});
  try{
    await session.start({model:FAKE_OPENCODE1_MODEL});
    await eventually(()=>fake.streams.size>0,{message:"the session did not subscribe to OpenCode's events"});
    assert.equal((await session.prompt([{type:"text",text:"Fix the bug"}])).stopReason,"end_turn");
    const plans=await eventually(()=>{const found=updates.filter(update=>update.sessionUpdate==="plan");return found.length===3&&found.map(update=>update.entries)});
    assert.deepEqual(plans,[
      [TODOS[0],TODOS[2]],
      [TODOS[0]],
      // A list of only cancelled todos leaves no steps.
      [],
    ]);
  }finally{await session.close();await fake.close()}
});

test("the window's plan of an OpenCode turn has no pending step for a todo OpenCode cancelled",async t=>{
  const relay=await openCode1Relay(t,{onPrompt:async({sessionID,emit})=>{
    emit({type:"todo.updated",properties:{sessionID,todos:[TODOS[0],TODOS[1]]}});
    await new Promise(resolve=>setTimeout(resolve,100));return "Fixed.";
  }});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Fix the bug"}]});
  const completed=await relay.completed();
  assert.equal(completed.turn.status,"completed",completed.turn.error?.message);
  const plans=relay.messages.filter(message=>message.method==="turn/plan/updated").map(message=>message.params.plan);
  assert.deepEqual(plans,[[{step:"Write the fix",status:"completed",priority:"high"}]]);
});
