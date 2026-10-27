import test,{ mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { attachCodexRelay } from "../src/codex-relay.mjs";
import { CODEX_GOAL_CONTINUATION_GRACE_MS, createCodexGoalContinuations } from "../src/codex-goal-continuation.mjs";
import { sleep, startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

test("the Codex relay keeps a notification the server holds back from the window, and says once the window has gone",async()=>{
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{sockets.add(ws);ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method&&message.id!=null)ws.send(JSON.stringify({id:message.id,result:{}}))})});
  await new Promise(resolve=>upstreamHttp.listen(0,"127.0.0.1",resolve));
  const relayHttp=createServer((_req,res)=>{res.statusCode=404;res.end()}),probes=[];
  const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamHttp.address().port}`,
    transformServerMessage:(message,{connected})=>{probes.push(connected);return message.method==="thread/goal/cleared"?false:message}});
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  const client=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`),messages=[];
  try{
    await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});client.on("message",raw=>messages.push(JSON.parse(String(raw))));
    client.send(JSON.stringify({id:1,method:"initialize",params:{}}));await until(()=>messages.some(item=>item.id===1));
    const upstream=[...sockets][0];
    upstream.send(JSON.stringify({method:"thread/goal/cleared",params:{threadId:"t1"}}));
    upstream.send(JSON.stringify({method:"thread/goal/updated",params:{threadId:"t1",goal:{objective:"Ship",status:"active"}}}));
    await until(()=>messages.some(item=>item.method==="thread/goal/updated"));
    assert.deepEqual(messages.filter(item=>item.method).map(item=>item.method),["thread/goal/updated"],"the one held back never reaches the window");
    assert.equal(probes.length,2);assert.equal(probes[0](),true,"the window is there");
    client.close();await until(()=>probes[0]()===false);
    assert.equal(probes[0](),false,"the window has gone");
  }finally{client.terminate();relay.close();for(const ws of sockets)ws.terminate();upstreamWss.close();await new Promise(resolve=>relayHttp.close(resolve));await new Promise(resolve=>upstreamHttp.close(resolve))}
});

// A clock of the test's own: timers run only when it is moved on.
function fakeClock(){
  let now=0,nextId=1;const timers=new Map();
  return {
    setTimeout(callback,ms){const id=nextId++;timers.set(id,{at:now+ms,callback});return id},
    clearTimeout(id){timers.delete(id)},
    advance(ms){now+=ms;for(const [id,timer] of [...timers].sort((a,b)=>a[1].at-b[1].at))if(timer.at<=now&&timers.has(id)){timers.delete(id);timer.callback()}},
    pending:()=>timers.size,
  };
}

test("a goal whose completed turn Codex follows with no turn for 5 s expires, and one Codex goes on with does not",()=>{
  const clock=fakeClock(),expired=[];
  const continuations=createCodexGoalContinuations({timers:clock,expire:(threadId,context)=>expired.push({threadId,...context})});
  assert.equal(CODEX_GOAL_CONTINUATION_GRACE_MS,5000);
  continuations.turnCompleted("idle-goal",{turnId:"turn-1"});
  clock.advance(4999);assert.deepEqual(expired,[],"within the grace nothing happens");
  clock.advance(1);assert.deepEqual(expired,[{threadId:"idle-goal",turnId:"turn-1"}],"no next turn in 5 s: the goal expires");
  assert.equal(continuations.waiting("idle-goal"),false);
  continuations.turnCompleted("busy-goal",{turnId:"turn-2"});clock.advance(3000);
  continuations.cancel("busy-goal");clock.advance(10_000);
  assert.equal(expired.length,1,"a turn that started cancels the wait");
  // A later completed turn waits anew, from its own end.
  continuations.turnCompleted("again",{turnId:"turn-3"});clock.advance(4000);continuations.turnCompleted("again",{turnId:"turn-4"});clock.advance(4000);
  assert.equal(expired.length,1);clock.advance(1000);assert.deepEqual(expired.at(-1),{threadId:"again",turnId:"turn-4"});
  continuations.turnCompleted("closed",{});continuations.clear();clock.advance(10_000);assert.equal(expired.length,2);assert.equal(clock.pending(),0);
});

// On a fake clock: of six threads with an active goal whose turn ends, only the one Codex starts no next turn for is paused. One Codex
// goes on with, one whose window has a follow-up's start on its way, one whose goal was paused or cleared meanwhile, and one whose turn
// failed (T3 waits only after a completed turn) are left as they are.
test("the server pauses an active Codex goal Codex started no turn for within 5 s of a completed one, and leaves the others",async()=>{
  const fixture=await startCodexGui("trebell-goal-continuation-"),{upstream}=fixture,[idleId,busyId,sendingId,pausedId,failedId,clearedId]=["goal-stalls","goal-continues","goal-follow-up","goal-paused","goal-failed","goal-cleared"];
  const ids=[idleId,busyId,sendingId,pausedId,failedId,clearedId];
  try{
    for(const threadId of ids)await fixture.thread(threadId);
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"goal-continuation"}});
    for(const threadId of ids)await window.request("thread/goal/set",{threadId,objective:"Make the release notes complete",status:"active"});
    await window.request("thread/goal/set",{threadId:pausedId,status:"paused"});
    assert.equal(upstream.goals.get(idleId).status,"active");
    const setsBefore=upstream.calls("thread/goal/set").length;
    // The person's follow-up in one thread: its start is on its way to Codex, which has not answered it yet.
    const release=upstream.hold("turn/start");
    window.request("turn/start",{threadId:sendingId,input:[{type:"text",text:"Also list the breaking changes.",textElements:[]}]}).catch(()=>{});
    assert.ok(await until(()=>upstream.calls("turn/start").length===1));
    // The server has handled a notification once the window has it (the relay hands it on after its hooks ran), so each step waits
    // for the window to have them all before the clock moves: a fixed wait let a late one start its 5 s on the moved clock.
    const heard=(method,count)=>until(()=>window.notifications(method).length>=count,5000);
    mock.timers.enable({apis:["setTimeout"]});
    try{
      for(const threadId of ids)upstream.notify("turn/started",{threadId,turn:{id:threadId+"-turn-1",status:"inProgress",items:[]}});
      assert.ok(await heard("turn/started",ids.length));
      for(const threadId of ids)upstream.notify("turn/completed",{threadId,turn:{id:threadId+"-turn-1",status:threadId===failedId?"failed":"completed",items:[],...(threadId===failedId?{error:{message:"The model is overloaded"}}:{})}});
      assert.ok(await heard("turn/completed",ids.length),"the window has every turn's end, so the server started each wait");
      // Codex goes on with one goal at once, another is cleared within the grace; the rest get no turn.
      upstream.notify("turn/started",{threadId:busyId,turn:{id:busyId+"-turn-2",status:"inProgress",items:[]}});
      upstream.notify("thread/goal/cleared",{threadId:clearedId});
      assert.ok(await heard("turn/started",ids.length+1));assert.ok(await heard("thread/goal/cleared",1));
      mock.timers.tick(4999);await sleep(80);
      assert.equal(upstream.calls("thread/goal/set").length,setsBefore,"nothing within the grace");
      mock.timers.tick(1);
      assert.ok(await until(()=>upstream.goals.get(idleId)?.status==="paused"),"the goal Codex stopped working toward is paused");
      mock.timers.tick(10_000);await sleep(150);
    }finally{mock.timers.reset();release()}
    assert.deepEqual(upstream.calls("thread/goal/set").slice(setsBefore).map(call=>call.params),[{threadId:idleId,status:"paused"}],"only that one");
    assert.equal(upstream.goals.get(busyId).status,"active");assert.equal(upstream.goals.get(sendingId).status,"active");assert.equal(upstream.goals.get(failedId).status,"active");
    const expired=(await fixture.traces(idleId)).find(item=>item.name==="goal.continuation_expired");
    assert.equal(expired?.status,"paused");assert.equal(expired?.data?.completedTurnId,idleId+"-turn-1");
    assert.equal((await window.request("thread/goal/get",{threadId:idleId})).goal.status,"paused","the thread's goal reads paused");
    assert.ok(await until(()=>window.notifications("thread/goal/updated").some(item=>item.params?.threadId===idleId&&item.params?.goal?.status==="paused")),"the window is told");
  }finally{await fixture.close()}
});

test("a new Codex goal reaches every window as it ends up, never through the cleared and paused steps Codex took on the way",async()=>{
  const fixture=await startCodexGui("trebell-goal-final-"),{upstream}=fixture,threadId="goal-replaced";
  try{
    await fixture.thread(threadId);
    const writer=await fixture.window(),observer=await fixture.window();
    await writer.request("initialize",{clientInfo:{name:"goal-writer"}});await observer.request("initialize",{clientInfo:{name:"goal-observer"}});
    await writer.request("thread/goal/set",{threadId,objective:"First objective",status:"active"});
    // Both windows have heard of the first goal before what they hear of the second is counted.
    const told=(socket,objective)=>socket.notifications("thread/goal/updated").some(item=>item.params?.goal?.objective===objective);
    assert.ok(await until(()=>told(writer,"First objective")&&told(observer,"First objective")));
    const seen=socket=>socket.received.filter(item=>item.id==null&&/^thread\/goal\//.test(item.method||"")).length;
    const marks=[seen(writer),seen(observer)];
    const replaced=(await writer.request("thread/goal/set",{threadId,objective:"Second objective",status:"paused"})).goal;
    assert.equal(replaced.objective,"Second objective");
    assert.deepEqual(upstream.requests.filter(item=>/^thread\/goal\/(set|clear)$/.test(item.method)).slice(-2).map(item=>item.method),["thread/goal/clear","thread/goal/set"],"Codex cleared and set the goal");
    assert.ok(await until(()=>told(writer,"Second objective")&&told(observer,"Second objective")),"each window gets the new goal");
    // Codex tells each window of its own steps too, and one it tells after the write ended says the goal as it ended up as well.
    for(const [index,socket] of [writer,observer].entries()){
      const after=socket.received.filter(item=>item.id==null&&/^thread\/goal\//.test(item.method||"")).slice(marks[index]);
      assert.equal(after.some(item=>item.method==="thread/goal/cleared"||!item.params?.goal),false,"no window reads the goal cleared on the way");
      assert.ok(after.length>=1,"each window gets the new goal");
      assert.deepEqual([...new Set(after.map(item=>JSON.stringify([item.method,item.params?.goal?.objective,item.params?.goal?.status])))],[JSON.stringify(["thread/goal/updated","Second objective","paused"])],"only as it ended up");
    }
    // Codex's own notifications pass again once the write is done.
    const updates=()=>observer.notifications("thread/goal/updated").length,before=updates();
    upstream.notify("thread/goal/updated",{threadId,goal:{...upstream.goals.get(threadId),tokensUsed:42}});
    assert.ok(await until(()=>updates()===before+1),"Codex's next goal update reaches the window");
  }finally{await fixture.close()}
});
