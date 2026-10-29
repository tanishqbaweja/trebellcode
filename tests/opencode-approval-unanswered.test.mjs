import test from "node:test";
import assert from "node:assert/strict";
import { openCode1Relay } from "./fixtures/opencode1-relay.mjs";

// An OpenCode 1.x approval the window leaves unanswered until the relay stops waiting for it (five minutes). OpenCode was told the person
// declined the command ("The bash request (npm run deploy) was declined."), the same words as their Deny, though nobody answered it.
// OpenCode 1.x keeps going after a refused request, as before, and is now told the request was not answered in time. A request whose
// wait ends otherwise (the app closing) is still declined. The real relay and OpenCode 1.x session run against the fake OpenCode 1.x
// server (tests/fixtures/fake-opencode1-server.mjs), on mocked timers for the relay's wait.

// Polls on setImmediate, which mocked timers leave alone, while the relay and the fake server talk over the network.
async function settled(check,{turns=200_000,message="condition was not met"}={}){
  for(let turn=0;turn<turns;turn++){const value=check();if(value)return value;await new Promise(resolve=>setImmediate(resolve))}
  throw new Error(message);
}

test("an OpenCode 1.x approval left unanswered until the relay stops waiting tells OpenCode it was not answered in time, not that the person declined it",async t=>{
  const relay=await openCode1Relay(t,{onPrompt:async({sessionID,emit,answered})=>{
    emit({type:"permission.asked",properties:{id:"per_deploy",sessionID,permission:"bash",patterns:["npm run deploy"],metadata:{},always:[]}});
    await answered("per_deploy");return "I did not deploy the docs site.";
  }});
  t.mock.timers.enable({apis:["setTimeout"]});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Deploy the docs site"}]});
  const approval=await settled(()=>relay.messages.find(message=>message.method==="item/tool/requestApproval"),{message:"the window was not asked"});
  t.mock.timers.tick(5*60_000);
  const reply=await settled(()=>relay.fake.called("POST /permission/per_deploy/reply")[0]?.body,{message:"OpenCode was not told"});
  assert.deepEqual(reply,{reply:"reject",message:"The bash request (npm run deploy) was not answered in time, so it was declined. Do not retry it; continue without it, and tell the user what it would need."});
  // The card leaves the window, where it could no longer be answered, and the turn goes on to OpenCode's answer.
  const resolved=await settled(()=>relay.messages.find(message=>message.method==="serverRequest/resolved"),{message:"the card was left on the window"});
  assert.deepEqual(resolved.params,{requestId:approval.id,threadId:relay.threadId});
  t.mock.timers.reset();
  assert.equal((await relay.completed()).turn.status,"completed");
});
