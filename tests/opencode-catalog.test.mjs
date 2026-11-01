import test from "node:test";
import assert from "node:assert/strict";
import { discoverOpenCode2ModelCatalog, waitForOpenCode2Models } from "../src/opencode-agent-session.mjs";
import { fakeOpenCode2Catalog, openCodeModels as models } from "./fixtures/fake-opencode-catalog-servers.mjs";

// OpenCode 2's model list as a cold server gives it: part of the catalog first.
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

test("two reads of an OpenCode 2 model list agree only on the same providers, ids, names, enabled states and variants",async()=>{
  const base=models(2,{variants:["low","high"]});
  const changed=(index,change)=>base.map((model,at)=>at===index?{...model,...change}:model);
  // Each change makes the second read differ from the first, so the wait reads a third time, which agrees with the second.
  for(const [what,second] of [
    ["a name",changed(1,{name:"Model 1 (preview)"})],["an enabled state",changed(0,{enabled:false})],["a provider",changed(1,{providerID:"openai"})],
    ["an id",changed(0,{id:"model-9"})],["a variant",changed(1,{variants:[{id:"low"}]})],["a repeated model",[...base,base[0]]],
  ]){
    const reads=listing([base,second,second]);
    const result=await waitForOpenCode2Models(reads,{directory:"/repo"},{intervalMs:1});
    assert.deepEqual([result.settled,reads.calls.length,result.data],[true,3,second],what);
  }
  // A model listed twice counts twice: the same models in other numbers are another list.
  const twice=listing([[base[0],base[0],base[1]],[base[0],base[1],base[1]],[base[0],base[1],base[1]]]);
  assert.deepEqual([(await waitForOpenCode2Models(twice,{directory:"/repo"},{intervalMs:1})).settled,twice.calls.length],[true,3]);
  // A model without an enabled flag counts as enabled, and a missing value as empty text, so these reads agree at once.
  const loose=[{providerID:"opencode",id:"model-0",name:"Model 0",variants:[]}];
  const same=listing([loose,[{...loose[0],enabled:true}],[]]);
  assert.deepEqual([(await waitForOpenCode2Models(same,{directory:"/repo"},{intervalMs:1})).settled,same.calls.length],[true,2]);
  const blank=listing([[{providerID:"opencode",id:"model-0",name:null}],[{providerID:"opencode",id:"model-0"}]]);
  assert.deepEqual([(await waitForOpenCode2Models(blank,{directory:"/repo"},{intervalMs:1})).settled,blank.calls.length],[true,2]);
});

test("an OpenCode 2 model list that keeps changing ends with its latest list, a failed read keeps the last list, and a failure before any list is the wait's",async()=>{
  let count=0;const changing=listing([()=>models(++count)]);
  const startedAt=Date.now(),latest=await waitForOpenCode2Models(changing,{directory:"/repo"},{intervalMs:5,settleMs:60});
  assert.equal(latest.settled,false);assert.equal(latest.data.length,changing.calls.length,"the latest list, not the first");
  assert.ok(latest.data.length>1);assert.ok(Date.now()-startedAt<2000);
  const failing=listing([models(3),Object.assign(new Error("read ECONNRESET"),{code:"ECONNRESET"})]);
  const kept=await waitForOpenCode2Models(failing,{directory:"/repo"},{intervalMs:1});
  assert.deepEqual([kept.data.length,kept.settled],[3,false]);
  await assert.rejects(waitForOpenCode2Models(listing([[],new Error("model catalog unavailable: providers still loading")]),{directory:"/repo"},{intervalMs:1}),/providers still loading/);
  // A list that never has models ends empty, as before.
  const empty=await waitForOpenCode2Models(listing([[]]),{directory:"/repo"},{intervalMs:5,timeoutMs:40});
  assert.deepEqual([empty.data,empty.settled],[[],false]);
});

test("an OpenCode 2 model wait counts only usable answers in a row, bounds itself from the first usable one, and keeps what each answer carried",async()=>{
  // An empty answer between two equal lists breaks the pair, so a fourth read is needed.
  const gap=listing([models(2),[],models(2),models(2)]);
  assert.deepEqual([(await waitForOpenCode2Models(gap,{directory:"/repo"},{intervalMs:1})).settled,gap.calls.length],[true,4]);
  // A list without the thread's model never counts, however steady: the wait runs to its bound and ends with that answer, unsettled.
  const without=listing([models(2)]);
  const missing=await waitForOpenCode2Models(without,{directory:"/repo"},{intervalMs:2,timeoutMs:40,requiredModel:"opencode/model-9"});
  assert.deepEqual([missing.data.length,missing.settled],[2,false]);assert.ok(without.calls.length>2);
  // settleMs counts from the first usable answer: three empty answers first, then a list that keeps changing.
  let count=0,reads=0;const late={model:{list:async()=>(++reads<=3?{data:[]}:{data:models(++count)})}};
  const startedAt=Date.now(),changed=await waitForOpenCode2Models(late,{directory:"/repo"},{intervalMs:20,settleMs:100,timeoutMs:5000});
  assert.equal(changed.settled,false);assert.ok(Date.now()-startedAt>=150,"three reads 20 ms apart came before the 100 ms began");
  assert.ok(Date.now()-startedAt<3000);
  // The answer comes back with every field it had, plus settled.
  const fields=listing([()=>models(1)]);fields.model.list=async input=>{fields.calls.push(input);return {data:models(1),response:{status:200}}};
  assert.deepEqual(await waitForOpenCode2Models(fields,{directory:"/repo"},{intervalMs:1}),{data:models(1),response:{status:200},settled:true});
  // Each read asks for the given folder's models.
  assert.deepEqual(fields.calls,[{location:{directory:"/repo"}},{location:{directory:"/repo"}}]);
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
