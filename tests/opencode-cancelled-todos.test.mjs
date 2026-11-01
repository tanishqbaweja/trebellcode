import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { FAKE_OPENCODE1_MODEL, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";
import { eventuallyReal as eventually, openCode1Relay } from "./fixtures/opencode1-relay.mjs";

// OpenCode sends its whole todo list in each todo.updated event: every todo has an id, its content, a status (pending, in_progress,
// completed or cancelled) and a priority (high, medium or low), as the SDK's Todo type lists them. A plan step cannot be cancelled,
// so a cancelled todo used to show as a pending step, and a plan OpenCode had partly given up on never read as finished. The plan now
// leaves cancelled todos out.
const QUOTED={id:"todo-quote",content:"Quote fields that hold a comma",status:"completed",priority:"medium"};
const LIBRARY={id:"todo-library",content:"Switch the export to a CSV library",status:"cancelled",priority:"low"};
const COVERED={id:"todo-cover",content:"Cover a quoted field in the export test",status:"in_progress",priority:"high"};
const ASKED={id:"todo-ask",content:"Ask which spreadsheet app opens the file",status:"cancelled",priority:"medium"};

test("an OpenCode todo list leaves its cancelled todos out of the turn's plan",async()=>{
  const fake=await startFakeOpenCode1({onPrompt:async({sessionID,emit})=>{
    emit({type:"todo.updated",properties:{sessionID,todos:[QUOTED,LIBRARY,COVERED]}});
    emit({type:"todo.updated",properties:{sessionID,todos:[QUOTED,LIBRARY]}});
    emit({type:"todo.updated",properties:{sessionID,todos:[ASKED]}});
    await new Promise(resolve=>setTimeout(resolve,100));return "Fields with commas are quoted now.";
  }});
  const updates=[],session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fake.url,onUpdate:params=>updates.push(params.update)});
  try{
    await session.start({model:FAKE_OPENCODE1_MODEL});
    await eventually(()=>fake.streams.size>0,{message:"the session did not subscribe to OpenCode's events"});
    assert.equal((await session.prompt([{type:"text",text:"Commas in a name break the CSV export"}])).stopReason,"end_turn");
    const plans=await eventually(()=>{const found=updates.filter(update=>update.sessionUpdate==="plan");return found.length===3&&found.map(update=>update.entries)});
    assert.deepEqual(plans,[
      [{content:"Quote fields that hold a comma",status:"completed",priority:"medium"},{content:"Cover a quoted field in the export test",status:"in_progress",priority:"high"}],
      [{content:"Quote fields that hold a comma",status:"completed",priority:"medium"}],
      // Every todo cancelled: the plan has no steps left.
      [],
    ]);
  }finally{await session.close();await fake.close()}
});

test("the window's plan of an OpenCode turn has no pending step for a todo OpenCode cancelled",async t=>{
  const relay=await openCode1Relay(t,{onPrompt:async({sessionID,emit})=>{
    emit({type:"todo.updated",properties:{sessionID,todos:[QUOTED,LIBRARY]}});
    await new Promise(resolve=>setTimeout(resolve,100));return "Fields with commas are quoted now.";
  }});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Commas in a name break the CSV export"}]});
  const completed=await relay.completed();
  assert.equal(completed.turn.status,"completed",completed.turn.error?.message);
  const plans=relay.messages.filter(message=>message.method==="turn/plan/updated").map(message=>message.params.plan);
  assert.deepEqual(plans,[[{step:"Quote fields that hold a comma",status:"completed",priority:"medium"}]]);
});
