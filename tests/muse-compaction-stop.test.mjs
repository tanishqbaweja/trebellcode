// Stop ends a Muse Code compaction also while the relay is still starting Muse Code's host for it: a thread opened since Trebell
// started, a host the idle sweep let go, or one an earlier Stop ended, which Muse Code's sessions start only when they are needed.
// The compaction ends there with Muse Code's own words, before Muse is asked to compact, and the host that started is kept for the
// thread's next message. Through the relay on the stand-in Muse Code (fake-muse.cjs), whose host can be held as it starts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUSE_COMPACTION_STOPPED } from "../src/muse-agent-session.mjs";
import { eventually, museRelay } from "./fixtures/muse/relay-harness.mjs";

// What a promise settles to within ms: its value, its error's message, or "pending".
async function within(promise,ms){
  let timer;const late=new Promise(resolve=>{timer=setTimeout(()=>resolve("pending"),ms)});
  try{return await Promise.race([promise.then(value=>({value}),error=>({error:error.message})),late])}finally{clearTimeout(timer)}
}

test("Stop while the relay starts Muse Code's host again for a compaction ends that compaction there, and the host goes on to run the next message",{timeout:120_000},async()=>{
  const holds=await mkdtemp(join(tmpdir(),"trebell-muse-start-hold-")),hold=join(holds,"start-hold");
  const relay=await museRelay("trebell-muse-compaction-stop-",{environment:{MUSE_FAKE_COMPACT:"hold",MUSE_FAKE_START_HOLD:hold}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"First message"}]});
    await relay.completed(thread.id,1);
    // A first compaction, stopped while Muse compacts: Stop ends Muse Code's host, which has no stop for a compaction.
    const first=relay.rpc("thread/compact/start",{threadId:thread.id});first.catch(()=>{});
    await eventually(async()=>(await relay.frames("session/compact")).length===1,"the first compaction");
    await relay.rpc("turn/interrupt",{threadId:thread.id});
    assert.deepEqual(await within(first,10_000),{error:MUSE_COMPACTION_STOPPED});
    // Compact again: the relay starts Muse Code's host again for it, which takes its time; Stop meanwhile ends the compaction there.
    await writeFile(hold,"");
    const second=relay.rpc("thread/compact/start",{threadId:thread.id});second.catch(()=>{});
    await eventually(async()=>(await relay.hosts()).length===2,"the host started again for the compaction");
    await relay.rpc("turn/interrupt",{threadId:thread.id});
    assert.deepEqual(await within(second,3000),{error:MUSE_COMPACTION_STOPPED},"stopped while the host still starts");
    // The host goes on starting, and Muse is never asked to compact.
    await rm(hold,{force:true});
    await eventually(async()=>(await relay.frames("session/resume")).length>=1,"the host to start");
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal((await relay.frames("session/compact")).length,1,"no compaction after the Stop");
    // The thread goes on: its next message runs on that host.
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"After the stop"}]});
    await relay.completed(thread.id,2);
    assert.match(relay.reply(thread.id),/Muse fixture reply/);
    assert.equal((await relay.hosts()).length,2,"on the host that started for the compaction");
  }finally{await rm(hold,{force:true}).catch(()=>{});await relay.close();await rm(holds,{recursive:true,force:true}).catch(()=>{})}
});
