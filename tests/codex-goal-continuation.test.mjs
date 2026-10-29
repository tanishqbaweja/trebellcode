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

// The windows a wait gathers can pause the goal (the server takes the first still there): the one that saw the turn end, another
// that hears of the same turn's end, and one that shows the thread meanwhile, none of which starts the 5 s again. A wait that ends
// with none of them there (expire answers false) owes the pause, once, until the next turn or a goal change ends it.
test("a goal's wait gathers the windows that can pause it, and one that ends with none of them there owes the pause",()=>{
  const clock=fakeClock(),expired=[];let gone=true;
  const continuations=createCodexGoalContinuations({timers:clock,expire:(threadId,{turnId,windows})=>{expired.push([threadId,turnId,windows.map(item=>item.name)]);return gone?false:undefined}});
  continuations.turnCompleted("goal",{turnId:"turn-1",windows:[{name:"first"}]});clock.advance(2000);
  continuations.turnCompleted("goal",{turnId:"turn-1",windows:[{name:"second"}]});continuations.follow("goal",{name:"reloaded"});continuations.follow("elsewhere",{name:"other"});
  clock.advance(2999);assert.deepEqual(expired,[]);
  clock.advance(1);assert.deepEqual(expired,[["goal","turn-1",["first","second","reloaded"]]],"5 s after the turn ended, with each window");
  assert.equal(continuations.take("goal")?.turnId,"turn-1","owed");assert.equal(continuations.take("goal"),null,"once");
  continuations.turnCompleted("goal",{turnId:"turn-2",windows:[]});clock.advance(5000);
  assert.equal(continuations.cancel("goal"),true,"the next turn ends what is owed");assert.equal(continuations.take("goal"),null);
  gone=false;continuations.turnCompleted("goal",{turnId:"turn-3",windows:[{name:"there"}]});clock.advance(5000);
  assert.deepEqual(expired.at(-1),["goal","turn-3",["there"]]);assert.equal(continuations.take("goal"),null,"paused on a window there: nothing owed");
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

// The window that saw a goal's turn end can go during the wait (reloaded, closed). The pause then goes on a window still there that
// showed the thread meanwhile (it resumed the thread or read its goal); with none there, the next window to read the goal makes it
// before that read answers, unless Codex says the thread runs a turn (one it started while no window was there to see it).
test("the server pauses a Codex goal Codex started no turn for after the window that saw its turn end has gone, on a window that showed the thread or at the next goal read",async()=>{
  const fixture=await startCodexGui("trebell-goal-continuation-gone-"),{upstream}=fixture,[reloadedId,closedId,unseenId]=["goal-reloaded","goal-window-closed","goal-continued-unseen"];
  const ids=[reloadedId,closedId,unseenId];
  try{
    for(const threadId of ids)await fixture.thread(threadId);
    const first=await fixture.window();await first.request("initialize",{clientInfo:{name:"goal-first-window"}});
    for(const threadId of ids)await first.request("thread/goal/set",{threadId,objective:"Make the release notes complete",status:"active"});
    const heard=(method,count)=>until(()=>first.notifications(method).length>=count,5000);
    mock.timers.enable({apis:["setTimeout"]});
    try{
      for(const threadId of ids)upstream.notify("turn/started",{threadId,turn:{id:threadId+"-turn-1",status:"inProgress",items:[]}});
      assert.ok(await heard("turn/started",ids.length));
      for(const threadId of ids)upstream.notify("turn/completed",{threadId,turn:{id:threadId+"-turn-1",status:"completed",items:[]}});
      assert.ok(await heard("turn/completed",ids.length),"the window has every turn's end, so the server started each wait");
      // The window is reloaded: the new one opens one of the threads, and the old one goes.
      const reloaded=await fixture.window();await reloaded.request("initialize",{clientInfo:{name:"goal-reloaded-window"}});
      await reloaded.request("thread/resume",{threadId:reloadedId});
      assert.equal((await reloaded.request("thread/goal/get",{threadId:reloadedId})).goal.status,"active");
      const open=upstream.connections();first.close();assert.ok(await until(()=>upstream.connections()<open),"the first window has gone");
      mock.timers.tick(4999);await sleep(80);
      assert.equal(upstream.calls("thread/goal/set").length,ids.length,"nothing within the grace");
      mock.timers.tick(1);
      assert.ok(await until(()=>upstream.goals.get(reloadedId)?.status==="paused"),"the goal of the thread the reloaded window opened is paused, on that window");
      assert.ok(await until(()=>reloaded.notifications("thread/goal/updated").some(item=>item.params?.threadId===reloadedId&&item.params.goal?.status==="paused"&&item.params.goal.pauseReason==="continuationExpired")),"the window is told, and why");
      mock.timers.tick(10_000);await sleep(150);
    }finally{mock.timers.reset()}
    assert.equal(upstream.goals.get(closedId).status,"active");assert.equal(upstream.goals.get(unseenId).status,"active");
    // No window showed the others as their waits ended: the next window to read one's goal pauses it first, and reads it paused.
    const later=await fixture.window();await later.request("initialize",{clientInfo:{name:"goal-later-window"}});
    const read=(await later.request("thread/goal/get",{threadId:closedId})).goal;
    assert.equal(read.status,"paused");assert.equal(read.pauseReason,"continuationExpired");
    assert.ok(upstream.calls("thread/read").some(call=>call.params?.threadId===closedId),"Codex was asked whether the thread runs a turn");
    assert.deepEqual(upstream.calls("thread/goal/set").slice(ids.length).map(call=>call.params),[{threadId:reloadedId,status:"paused"},{threadId:closedId,status:"paused"}]);
    // Codex started the third's next turn while no window was there: it runs, so its goal stays active.
    upstream.answerWith("thread/read",{thread:{id:unseenId,status:{type:"active",activeFlags:[]}}});
    assert.equal((await later.request("thread/goal/get",{threadId:unseenId})).goal.status,"active");assert.equal(upstream.goals.get(unseenId).status,"active");
    // A pause is made once: a later read reads the goal as it is.
    assert.equal((await later.request("thread/goal/get",{threadId:closedId})).goal.status,"paused");
    assert.equal(upstream.calls("thread/goal/set").length,ids.length+2);
    for(const threadId of [reloadedId,closedId])assert.equal((await fixture.traces(threadId)).find(item=>item.name==="goal.continuation_expired")?.status,"paused");
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
