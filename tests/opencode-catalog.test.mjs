import test from "node:test";
import assert from "node:assert/strict";
import { discoverOpenCode2ModelCatalog, waitForOpenCode2Models } from "../src/opencode-agent-session.mjs";
import { fakeOpenCode2Catalog, openCodeModels as models } from "./fixtures/fake-opencode-catalog-servers.mjs";

// OpenCode 2's model list as a cold server gives it: part of the catalog first (T3 Code's makeOpenCode2ModelLoader settles it).
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Fails a wait that the code under test would never end.
const within=(promise,ms,what)=>Promise.race([promise,delay(ms).then(()=>{throw new Error(`${what} took longer than ${ms} ms`)})]);
// The model list read by read: each entry of reads is one answer (an Error is thrown), the last one repeated.
function listing(reads){
  const calls=[];let index=0;
  return {calls,model:{list:async input=>{calls.push(input);const next=reads[Math.min(index++,reads.length-1)];if(next instanceof Error)throw next;return {data:typeof next==="function"?next():next}}}};
}

test("an OpenCode 2 model list counts once two reads in a row agree, so a cold server's partial list is not the one kept",async()=>{
  const growing=listing([models(3),models(40),models(40)]);
  const settled=await waitForOpenCode2Models(growing,{directory:"/repo"},{intervalMs:1});
  assert.deepEqual([settled.data.length,settled.settled,growing.calls.length],[40,true,3]);
  const steady=listing([models(3),models(3)]);
  const same=await waitForOpenCode2Models(steady,{directory:"/repo"},{intervalMs:1});
  assert.deepEqual([same.data.length,same.settled,steady.calls.length],[3,true,2],"two agreeing reads are enough");
  // The models' order and their variants' order do not matter.
  const reordered=listing([models(2,{variants:["low","high"]}),[...models(2,{variants:["high","low"]})].reverse()]);
  assert.equal((await waitForOpenCode2Models(reordered,{directory:"/repo"},{intervalMs:1})).settled,true);
  assert.equal(reordered.calls.length,2);
  // At a session's start the thread's model must be in the list, and the list must still settle.
  const required="opencode/model-5",late=listing([models(3),models(6),models(6)]);
  const found=await waitForOpenCode2Models(late,{directory:"/repo"},{intervalMs:1,requiredModel:required});
  assert.deepEqual([found.data.length,found.settled,late.calls.length],[6,true,3]);
});

test("an OpenCode 2 model list that keeps changing ends with its latest list, a failed read keeps the last list, and a failure before any list is the wait's",async()=>{
  let count=0;const changing=listing([()=>models(++count)]);
  const startedAt=Date.now(),latest=await waitForOpenCode2Models(changing,{directory:"/repo"},{intervalMs:5,settleMs:60});
  assert.equal(latest.settled,false);assert.equal(latest.data.length,changing.calls.length,"the latest list, not the first");
  assert.ok(latest.data.length>1);assert.ok(Date.now()-startedAt<2000);
  const failing=listing([models(3),new Error("socket hang up")]);
  const kept=await waitForOpenCode2Models(failing,{directory:"/repo"},{intervalMs:1});
  assert.deepEqual([kept.data.length,kept.settled],[3,false]);
  await assert.rejects(waitForOpenCode2Models(listing([[],new Error("The OpenCode server could not list its models")]),{directory:"/repo"},{intervalMs:1}),/could not list its models/);
  // A list that never has models ends empty, as before.
  const empty=await waitForOpenCode2Models(listing([[]]),{directory:"/repo"},{intervalMs:5,timeoutMs:40});
  assert.deepEqual([empty.data,empty.settled],[[],false]);
});

test("an OpenCode 2 catalog whose model list was still changing when the wait ended is marked pending, and a settled one is not",async()=>{
  let count=0;const changing=await fakeOpenCode2Catalog({models:()=>models(1+(count++%7))}),steady=await fakeOpenCode2Catalog();
  try{
    const partial=await within(discoverOpenCode2ModelCatalog({cwd:"/repo",serverUrl:changing.url,env:{}}),15_000,"the changing list");
    assert.deepEqual(partial.pending,["models"]);assert.ok(partial.models.length>0);
    const settled=await discoverOpenCode2ModelCatalog({cwd:"/repo",serverUrl:steady.url,env:{}});
    assert.equal(settled.pending,undefined);assert.deepEqual(settled.models,["opencode/model-0","opencode/model-1"]);
    assert.deepEqual(settled.inventory.commands.map(item=>item.name),["review"]);
  }finally{await changing.close();await steady.close()}
});
