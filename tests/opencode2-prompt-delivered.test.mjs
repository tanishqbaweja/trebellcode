import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// A turn Trebell ends (Stop, a stream gone silent) before OpenCode answers its prompt request no longer waits on that request. But the
// message still reached OpenCode once the request answers, and the relay counts on onDelivered for that: a thread whose conversation
// OpenCode had lost hands its earlier messages over with its next message, and marks that handoff delivered only then. Stopped before
// the answer, the handoff stayed pending, and the next message handed the earlier messages over a second time.
test("an OpenCode 2 prompt request answered after Trebell ended the turn still counts as delivered, and one OpenCode refused does not",async()=>{
  const answers=[];
  const fake=fakeOpenCode2Client({overrides:{"session.prompt":()=>new Promise((resolve,reject)=>answers.push({resolve,reject}))}});
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{}});
  await session.start({});
  try{
    let delivered=0;
    const turn=session.prompt([{type:"text",text:"Pick up where we left off"}],{onDelivered:()=>{delivered++}});
    await eventually(()=>answers.length===1);
    await session.cancel();
    assert.equal((await turn).stopReason,"cancelled","Stop does not wait on the prompt request");
    assert.equal(delivered,0);
    answers[0].resolve({id:"msg_user"});
    await eventually(()=>delivered===1,{message:"the answered request was not counted as delivered"});
    // A request OpenCode refuses delivered nothing.
    const next=session.prompt([{type:"text",text:"Again"}],{onDelivered:()=>{delivered++}});
    await eventually(()=>answers.length===2);
    answers[1].reject(Object.assign(new Error("Session is busy"),{name:"SessionBusyError"}));
    await assert.rejects(next,{message:"Session is busy"});
    for(let index=0;index<20;index++)await flush();
    assert.equal(delivered,1);
  }finally{await session.close()}
});
