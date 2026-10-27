import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadHistoryHandoff } from "../src/thread-history-handoff.mjs";
import { FakeMuse, startSession, until, settlesWithin } from "./fixtures/muse/fake-host.mjs";
import { eventually, museRelay } from "./fixtures/muse/relay-harness.mjs";

// /compact, fork and revert on Muse Code threads (T3 Code's MuseAdapter compactThread, forkThread and rollbackThread, and
// docs/user/providers-muse.md): /compact is Muse's session/compact, settled by its compaction item; a fork is a thread of Trebell's own
// whose next message starts a fresh Muse Code session handed the earlier messages (Muse refuses a fork of completed turns); a revert
// does not rewind Muse's conversation. The session cases run Meta's SDK on a fake `muse serve` (fixtures/muse/fake-host.mjs), the
// relay cases the real relay and runtime manager on the stand-in Muse Code (fixtures/muse/fake-muse.cjs).
// Trebell's words (muse-agent-session.mjs MUSE_NOTHING_TO_COMPACT and MUSE_COMPACTION_STOPPED, worded as Native's and Grok's are).
const MUSE_NOTHING_TO_COMPACT="There is no Muse Code conversation history to compact yet.";
const MUSE_COMPACTION_STOPPED="Muse Code's context compaction was stopped before it finished.";
const compactionItem=(params,revision,status,extra={})=>({itemId:params.commandId+"-compaction",kind:"compaction",turnId:"turn-before",revision,status,trigger:"manual",...extra});
// session/compact answered with status, and the compaction's item played: ended (a function of the params), or only started.
function compactHandler({status="accepted",reason=null,end=params=>compactionItem(params,2,"completed",{outcome:"compacted"})}={}){
  return (params,fake)=>{
    if(status==="accepted")setImmediate(()=>{
      fake.notify("item/started",{sessionId:params.sessionId,item:compactionItem(params,1,"inProgress")});
      const ended=end?.(params);if(ended)setImmediate(()=>fake.notify("item/completed",{sessionId:params.sessionId,item:ended}));
    });
    return {commandId:params.commandId,status,...(reason?{reason}:{})};
  };
}
// Muse's refusal of the command, with the reason its error data carries (commandRejected, as Muse 1.4.13 answers it live).
const rejected=reason=>(params,fake)=>{
  const frame=fake.sent("session/compact").at(-1);
  fake.write({jsonrpc:"2.0",id:frame.id,error:{code:-32030,message:`session/compact command ${params.commandId} rejected: ${reason}`,data:{kind:"commandRejected",retryable:false,commandId:params.commandId,reason}}});
  return undefined;
};
const museSession=handlers=>startSession({muse:child=>new FakeMuse(child,{handlers})});

test("/compact on a Muse Code session sends session/compact and settles once its compaction item ends compacted, and the session goes on",async()=>{
  const {session,muse,updates}=await museSession({"session/compact":compactHandler()});
  await settlesWithin(session.compact(),2000,"the compaction");
  const [compact]=muse.sent("session/compact");
  assert.equal(compact.params.sessionId,session.sessionId);
  assert.ok(compact.params.commandId,"a command of its own");
  assert.equal(session.dead,false);assert.equal(session.busy,false);
  assert.equal(updates.some(update=>update.sessionUpdate==="runtime_error"),false);
  // The next message runs as usual on the same host.
  const turn=session.prompt([{type:"text",text:"Go on"}]);
  const start=await muse.next("turn/start");
  muse.notify("turn/completed",{sessionId:session.sessionId,turnId:start.params.commandId,terminal:"completed"});
  assert.equal((await settlesWithin(turn,2000,"the next turn")).stopReason,"end_turn");
  await session.close();
});

test("/compact with nothing to compact says so in Trebell's words and leaves the Muse Code session usable",async()=>{
  for(const handler of [compactHandler({status:"noop",reason:"no_compactable_history"}),rejected("missing_run"),compactHandler({end:params=>compactionItem(params,2,"completed",{outcome:"noop",reason:"no_compactable_history"})})]){
    const {session,muse}=await museSession({"session/compact":handler});
    await assert.rejects(settlesWithin(session.compact(),2000,"the compaction"),{message:MUSE_NOTHING_TO_COMPACT});
    assert.equal(session.dead,false);assert.equal(session.busy,false);
    const turn=session.prompt([{type:"text",text:"Still here"}]);
    const start=await muse.next("turn/start");
    muse.notify("turn/completed",{sessionId:session.sessionId,turnId:start.params.commandId,terminal:"completed"});
    assert.equal((await settlesWithin(turn,2000,"the turn after")).stopReason,"end_turn");
    await session.close();
  }
});

test("a compaction Muse could not make fails with Muse's reason as a sentence, and one Muse ran on its own does not settle /compact",async()=>{
  const unavailable=await museSession({"session/compact":rejected("compaction_unavailable")});
  await assert.rejects(unavailable.session.compact(),{message:"Muse Code could not compact the conversation: compaction unavailable."});
  await unavailable.session.close();
  const failed=await museSession({"session/compact":compactHandler({end:params=>compactionItem(params,2,"failed",{outcome:"failed",reason:"summarizer_failed"})})});
  await assert.rejects(failed.session.compact(),{message:"Muse Code could not compact the conversation: summarizer failed."});
  assert.equal(failed.session.dead,false);
  await failed.session.close();
  // An automatic compaction ending meanwhile is not this one; the manual one's end is.
  const both=await museSession({"session/compact":(params,fake)=>{
    setImmediate(()=>{
      fake.notify("item/completed",{sessionId:params.sessionId,item:{...compactionItem(params,2,"completed",{outcome:"compacted"}),itemId:"auto-one",trigger:"auto"}});
      setTimeout(()=>fake.notify("item/completed",{sessionId:params.sessionId,item:compactionItem(params,2,"completed",{outcome:"compacted"})}),60);
    });
    return {commandId:params.commandId,status:"accepted"};
  }});
  let settled=false;const compacting=both.session.compact().then(()=>{settled=true});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(settled,false,"the automatic compaction did not settle it");
  await settlesWithin(compacting,2000,"the manual compaction");
  await both.session.close();
});

test("Stop during a Muse Code compaction stops its host and leaves the session dead, and closing the session ends the compaction",async()=>{
  const {session,muse,child,updates}=await museSession({"session/compact":compactHandler({end:null})});
  const compacting=session.compact();compacting.catch(()=>{});
  await muse.next("session/compact");
  await until(()=>session.busy,"the compaction to run");
  await session.cancel();
  await assert.rejects(settlesWithin(compacting,2000,"the stopped compaction"),{message:MUSE_COMPACTION_STOPPED});
  assert.equal(session.dead,true,"the next message starts Muse Code again");
  await until(()=>muse.stdinEnded&&child.exitCode!==null,"the host to stop");
  assert.equal(updates.some(update=>update.sessionUpdate==="runtime_error"),false,"the compaction's own request reports it");
  assert.equal(muse.sent("turn/interrupt").length,0,"Muse has no stop for a compaction");
  await assert.rejects(session.compact(),{message:MUSE_COMPACTION_STOPPED});
  // A host that exits meanwhile ends the compaction with its reason; a close ends it as stopped.
  const exiting=await museSession({"session/compact":compactHandler({end:null})});
  const lost=exiting.session.compact();lost.catch(()=>{});
  await exiting.muse.next("session/compact");
  exiting.child.stderr.write("panic: summarizer crashed\n");setImmediate(()=>exiting.child.exit(1));
  await assert.rejects(settlesWithin(lost,4000,"the lost compaction"),/Muse Code exited unexpectedly \(code 1\): panic: summarizer crashed/);
  assert.equal(exiting.updates.some(update=>update.sessionUpdate==="runtime_error"),false);
  const closing=await museSession({"session/compact":compactHandler({end:null})});
  const closed=closing.session.compact();closed.catch(()=>{});
  await closing.muse.next("session/compact");
  await closing.session.close();
  await assert.rejects(settlesWithin(closed,2000,"the closed compaction"),{message:"Muse Code stopped before it finished compacting the conversation."});
});

test("/compact waits for no running Muse Code turn: it is refused while one runs, and sends nothing",async()=>{
  const {session,muse}=await museSession({"session/compact":compactHandler()});
  const turn=session.prompt([{type:"text",text:"Work"}]);
  const start=await muse.next("turn/start");
  await assert.rejects(session.compact(),{message:"Stop the running Muse Code turn before compacting its context."});
  assert.equal(muse.sent("session/compact").length,0);
  muse.notify("turn/completed",{sessionId:session.sessionId,turnId:start.params.commandId,terminal:"completed"});
  await turn;
  await settlesWithin(session.compact(),2000,"the compaction after the turn");
  await session.close();
});

// A message in another host's mode while Muse's own work holds this host (muse-agent-session.mjs, worded as Claude Code's refusal of a
// change that would end its background work).
const COMPACTION_BLOCKS_MODE="Muse Code is still compacting this conversation, and this mode needs a new Muse Code host, which would stop the compaction. Wait for it to finish, or keep the current mode, then send the message again.";
const REPORT_BLOCKS_MODE="Muse Code is still writing its report on the work it finished, and this mode needs a new Muse Code host, which would stop the report. Wait for it to finish (or stop it), or keep the current mode, then send the message again.";
test("while Muse's compaction or its own report holds the host, a message in a mode another host serves is refused with nothing sent, and one in the host's own mode still goes",async()=>{
  const {session,muse}=await startSession({permissionMode:"full",muse:child=>new FakeMuse(child,{handlers:{"session/compact":compactHandler({end:null})}})});
  const compacting=session.compact();compacting.catch(()=>{});
  await muse.next("session/compact");
  // The relay keeps a busy session and hands it the thread's new mode (startSession): the message is refused, never run with Full
  // access's unsandboxed host and allowAll.
  session.setPermissionMode("supervised");
  await assert.rejects(settlesWithin(session.prompt([{type:"text",text:"Go on in Supervised"}]),2000,"the message in Supervised"),error=>error?.name==="SessionRefusalError"&&error.message===COMPACTION_BLOCKS_MODE);
  assert.equal(muse.sent("turn/start").length,0,"no turn on the Full access host");
  // In the host's own mode Muse queues the message behind its compaction.
  session.setPermissionMode("full");
  const turn=session.prompt([{type:"text",text:"Go on"}]);
  const start=await muse.next("turn/start");
  muse.notify("turn/completed",{sessionId:session.sessionId,turnId:start.params.commandId,terminal:"completed"});
  assert.equal((await settlesWithin(turn,2000,"the turn")).stopReason,"end_turn");
  await session.close();
  // The report Muse writes itself once its work is done holds the host too: a message in another mode does not take it over.
  let report=null;
  const waking=await startSession({permissionMode:"supervised",options:{onWakeTurn:promise=>{report=promise}}});
  waking.muse.notify("turn/started",{sessionId:waking.session.sessionId,turnId:"report-1",viewCursor:"v"});
  await until(()=>report,"the report turn");
  waking.session.setPermissionMode("auto");
  await assert.rejects(settlesWithin(waking.session.prompt([{type:"text",text:"In Auto now"}]),2000,"the message in Auto"),error=>error?.name==="SessionRefusalError"&&error.message===REPORT_BLOCKS_MODE);
  assert.equal(waking.muse.sent("turn/start").length,0);
  // Back in the host's own mode the message takes the report over; while that message's turn runs, another mode is just a running turn.
  waking.session.setPermissionMode("supervised");
  const message=waking.session.prompt([{type:"text",text:"In Supervised"}]);
  assert.equal((await settlesWithin(report,2000,"the report")).stopReason,"end_turn","the report ends as its own turn");
  const {params:taken}=await waking.muse.next("turn/start");
  waking.session.setPermissionMode("auto");
  assert.equal(waking.session.modeRefusal(),null);
  await assert.rejects(waking.session.prompt([{type:"text",text:"Auto again"}]),{message:"Muse Code already has a running turn."});
  waking.session.setPermissionMode("supervised");
  waking.muse.notify("turn/completed",{sessionId:waking.session.sessionId,turnId:"report-1",terminal:"completed",viewCursor:"v"});
  waking.muse.notify("turn/completed",{sessionId:waking.session.sessionId,turnId:taken.commandId,terminal:"completed",viewCursor:"v"});
  assert.equal((await settlesWithin(message,2000,"the message's turn")).stopReason,"end_turn");
  await waking.session.close();
});

test("through the relay, a message sent in Supervised while a Full access thread's compaction runs is refused before its turn starts and never runs on the Full access host, and after Stop it starts Muse Code in Supervised",{timeout:90_000},async()=>{
  const relay=await museRelay("trebell-muse-compact-mode-",{environment:{MUSE_FAKE_COMPACT:"hold"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0",permissionProfile:"full"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"First message"}],permissionProfile:"full"});
    await relay.completed(thread.id,1);
    const compacting=relay.rpc("thread/compact/start",{threadId:thread.id});compacting.catch(()=>{});
    await eventually(async()=>(await relay.frames("session/compact")).length===1,"the compaction to reach Muse");
    // Refused as the send, so the person keeps the draft; no turn of it is stored, and no error ends the compaction in the window.
    await assert.rejects(relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Now in Supervised"}],permissionProfile:"supervised"}),{message:COMPACTION_BLOCKS_MODE});
    assert.equal(relay.threadStore.get(thread.id).turns.length,1);
    assert.equal(relay.notifications.some(item=>item.method==="error"&&item.params.threadId===thread.id),false);
    assert.equal((await relay.frames("turn/start")).length,1,"no turn/start reached the Full access host");
    assert.deepEqual((await relay.hosts()).map(entry=>entry.start),[["serve","--trust-workspace","--disable-sandbox"]]);
    // The relay's Stop ends the compaction with its host (the window shows no Stop for a compaction, so its refusal says to wait); the
    // next message starts Muse Code for Supervised and resumes the conversation there.
    await relay.rpc("turn/interrupt",{threadId:thread.id});
    await assert.rejects(compacting,{message:MUSE_COMPACTION_STOPPED});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Supervised after the stop"}],permissionProfile:"supervised"});
    await relay.completed(thread.id,2);
    assert.equal(relay.threadStore.get(thread.id).turns.at(-1).status,"completed");
    assert.deepEqual((await relay.hosts()).map(entry=>entry.start),[["serve","--trust-workspace","--disable-sandbox"],["serve","--trust-workspace"]]);
    const resume=(await relay.frames("session/resume")).at(-1),mode=(await relay.frames("session/setApprovalMode")).at(-1);
    assert.deepEqual([resume?.params.permissionProfile,mode?.params.mode],[":ask-me","promptUnmatched"]);
  }finally{await relay.close()}
});

test("through the relay, a message sent in another mode while Muse writes its own report is refused before its turn starts, the report going on, and one in the thread's mode then takes the report over",{timeout:90_000},async()=>{
  const relay=await museRelay("trebell-muse-report-mode-",{environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0",permissionProfile:"supervised"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}],permissionProfile:"supervised"});
    await relay.completed(thread.id,1);
    await eventually(()=>relay.threadStore.get(thread.id).turns.length===2,"Muse's report turn");
    await assert.rejects(relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"In Full access now"}],permissionProfile:"full"}),{message:REPORT_BLOCKS_MODE});
    assert.deepEqual(relay.threadStore.get(thread.id).turns.map(turn=>turn.status),["completed","inProgress"],"the report goes on");
    assert.equal((await relay.frames("turn/start")).length,1);
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"And one more thing"}],permissionProfile:"supervised"});
    await relay.completed(thread.id,3);
    assert.deepEqual(relay.threadStore.get(thread.id).turns.map(turn=>turn.status),["completed","completed","completed"]);
    assert.equal((await relay.hosts()).length,1);
  }finally{await relay.close()}
});

test("through the relay, a message refused in Full access while Muse writes its report on a Supervised thread leaves the thread in Supervised: what the report asks next goes to the person on the card, never answered by Full access's policy",{timeout:90_000},async()=>{
  const holds=await mkdtemp(join(tmpdir(),"trebell-muse-report-ask-")),ask=join(holds,"report-ask");
  const relay=await museRelay("trebell-muse-report-mode-policy-",{environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1",MUSE_FAKE_REPORT_ASK_HOLD:ask}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0",permissionProfile:"supervised"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}],permissionProfile:"supervised"});
    await relay.completed(thread.id,1);
    await eventually(()=>relay.threadStore.get(thread.id).turns.length===2,"Muse's report turn");
    await assert.rejects(relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"In Full access now"}],permissionProfile:"full"}),{message:REPORT_BLOCKS_MODE});
    // The report then asks to run a command: in Supervised, the person answers it.
    await writeFile(ask,"");
    const asked=()=>relay.requests.some(request=>request.method==="item/tool/requestApproval");
    await eventually(async()=>asked()||(await relay.frames("approval/decide")).length>0,"the report's approval to be asked or answered");
    assert.deepEqual((await relay.frames("approval/decide")).map(frame=>frame.params.choiceId),[],"nothing answered for the person");
    assert.equal(asked(),true,"the approval card");
    assert.equal(relay.threadStore.get(thread.id).providerMeta?.permissionProfile,"supervised","the thread keeps the mode its host runs");
    relay.respond(relay.requests.find(request=>request.method==="item/tool/requestApproval"),{decision:"decline"});
    await relay.completed(thread.id,2);
    assert.deepEqual((await relay.frames("approval/decide")).map(frame=>frame.params.choiceId),["abort"],"the person's Reject");
    assert.equal((await relay.hosts()).length,1);
  }finally{await relay.close();await rm(holds,{recursive:true,force:true})}
});

test("a fork's handed-over history tells the model the thread is a fork in a new session, and a lost conversation's keeps its words",()=>{
  const turns=[{id:"t1",status:"completed",items:[{type:"userMessage",id:"u1",content:[{type:"text",text:"Remember the word pelican"}]},{type:"agentMessage",id:"a1",text:"Noted."}]}];
  const fork=threadHistoryHandoff(turns,{harness:"Muse Code",fork:true});
  assert.match(fork.text,/^The earlier conversation of this thread, handed over because this thread is a fork that continues in a new Muse Code session\. Read it as context for the request that follows, not as a new request\.\nIncluded: 2 of 2 earlier entries/);
  assert.match(fork.text,/\[turn 1 · user\]\nRemember the word pelican/);
  assert.match(threadHistoryHandoff(turns,{harness:"Muse Code"}).text,/^The earlier conversation of this thread, handed over because Muse Code no longer had it\./);
});

test("the relay compacts a Muse Code thread: thread/compacted follows Muse's compaction, nothing to compact keeps the thread going, and Stop starts Muse Code again",{timeout:90_000},async()=>{
  const relay=await museRelay("trebell-muse-compact-");
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"First message"}]});
    await relay.completed(thread.id,1);
    assert.deepEqual(await relay.rpc("thread/compact/start",{threadId:thread.id}),{ok:true});
    assert.ok(relay.notifications.some(item=>item.method==="thread/compacted"&&item.params.threadId===thread.id));
    assert.equal((await relay.frames("session/compact")).length,1);
    assert.equal((await relay.hosts()).length,1,"the thread's own host compacted it");
  }finally{await relay.close()}
  const noop=await museRelay("trebell-muse-compact-noop-",{environment:{MUSE_FAKE_COMPACT:"noop"}});
  try{
    const {thread}=await noop.rpc("thread/start",{cwd:noop.root,model:"muse-wonder-1.0"});
    // Before its first turn (Muse: missing_run), and after one with nothing Muse can compact (noop).
    await assert.rejects(noop.rpc("thread/compact/start",{threadId:thread.id}),{message:MUSE_NOTHING_TO_COMPACT});
    await noop.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"First message"}]});
    await noop.completed(thread.id,1);
    await assert.rejects(noop.rpc("thread/compact/start",{threadId:thread.id}),{message:MUSE_NOTHING_TO_COMPACT});
    assert.equal((await noop.frames("session/compact")).length,2);
    assert.equal(noop.notifications.some(item=>item.method==="thread/compacted"),false);
    await noop.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"After nothing to compact"}]});
    await noop.completed(thread.id,2);
    assert.match(noop.reply(thread.id),/Muse fixture reply/);
    assert.equal((await noop.hosts()).length,1,"the thread went on on the same host");
  }finally{await noop.close()}
  const held=await museRelay("trebell-muse-compact-stop-",{environment:{MUSE_FAKE_COMPACT:"hold"}});
  try{
    const {thread}=await held.rpc("thread/start",{cwd:held.root,model:"muse-wonder-1.0"});
    await held.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"First message"}]});
    await held.completed(thread.id,1);
    const compacting=held.rpc("thread/compact/start",{threadId:thread.id});compacting.catch(()=>{});
    await eventually(async()=>(await held.frames("session/compact")).length===1,"the compaction to reach Muse");
    await held.rpc("turn/interrupt",{threadId:thread.id});
    await assert.rejects(compacting,{message:MUSE_COMPACTION_STOPPED});
    // The next message starts Muse Code again on the thread's conversation.
    await held.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"After the stop"}]});
    await held.completed(thread.id,2);
    assert.equal((await held.hosts()).length,2);
    assert.equal((await held.frames("session/resume")).at(-1)?.params.sessionId,held.threadStore.get(thread.id).providerSessionId);
  }finally{await held.close()}
});

test("a Muse Code fork is a new thread whose first message starts a fresh Muse Code session on the source's profile, handed the earlier messages, once, with no Muse Code started for the fork itself",{timeout:90_000},async()=>{
  const relay=await museRelay("trebell-muse-fork-");
  try{
    // A second Muse Code profile, as a person adds one in Settings: the source thread runs on it, and so does its fork.
    const instances=relay.state.settings().agentRuntimeInstances;
    instances.push({...instances[0],id:"muse-work",displayName:"Muse work",environment:{...instances[0].environment,MUSE_CHANNEL:"work-profile"}});
    const {thread:source}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0",runtimeInstanceId:"muse-work"});
    await relay.rpc("turn/start",{threadId:source.id,input:[{type:"text",text:"Remember the word pelican"}]});
    await relay.completed(source.id,1);
    const sourceSession=relay.threadStore.get(source.id).providerSessionId,hostsBefore=(await relay.hosts()).length;
    const {thread:fork}=await relay.rpc("thread/fork",{threadId:source.id,excludeTurns:true});
    assert.notEqual(fork.id,source.id);
    assert.equal(fork.runtime,"muse");
    assert.equal(fork.providerSessionId,"","no Muse Code session yet");
    const stored=relay.threadStore.get(fork.id);
    assert.equal(stored.forkedFromId,source.id);
    assert.equal(stored.turns.length,1,"the fork keeps the source's turns");
    assert.equal(stored.providerMeta.historyHandoff.status,"pending");
    assert.equal("setup" in stored.providerMeta,false,"the source's session setup is not the fork's");
    assert.equal(stored.runtimeInstanceId,"muse-work","the fork keeps the source's Muse Code profile");
    assert.ok(relay.notifications.some(item=>item.method==="thread/started"&&item.params.thread.id===fork.id));
    assert.equal((await relay.hosts()).length,hostsBefore,"no Muse Code started for the fork");
    assert.equal((await relay.frames("session/fork")).length,0,"never Muse's own session/fork");
    // The fork's first message: a fresh session, the earlier messages handed over with the turn.
    const startsBefore=(await relay.frames("session/start")).length;
    await relay.rpc("turn/start",{threadId:fork.id,input:[{type:"text",text:"Which word did I give you?"}]});
    await relay.completed(fork.id,1);
    assert.equal((await relay.frames("session/start")).length,startsBefore+1,"a fresh Muse Code session");
    assert.equal((await relay.frames("session/resume")).length,0);
    const forkSession=relay.threadStore.get(fork.id).providerSessionId;
    assert.ok(forkSession&&forkSession!==sourceSession,"the fork runs a session of its own");
    const first=(await relay.frames("turn/start")).at(-1),sent=JSON.stringify(first.params.input);
    assert.equal(first.params.sessionId,forkSession);
    assert.equal((await relay.hosts()).at(-1).env.MUSE_CHANNEL,"work-profile","the fork's session runs on the source's profile");
    // The model is told the thread is a fork, not that Muse Code lost the conversation.
    assert.match(sent,/The earlier conversation of this thread, handed over because this thread is a fork that continues in a new Muse Code session\./);
    assert.match(sent,/Remember the word pelican/);
    assert.match(first.params.displayText,/^Which word did I give you\?$/,"Muse's transcript shows the person's own words");
    const handoff=relay.threadStore.get(fork.id).turns.at(-1).items.find(item=>item.type==="sessionHandoff");
    assert.equal(handoff.title,"This fork continues in a new Muse Code session with the earlier messages handed over.");
    assert.equal(relay.threadStore.get(fork.id).providerMeta.historyHandoff.status,"delivered");
    // Once: the fork's next message carries only itself.
    await relay.rpc("turn/start",{threadId:fork.id,input:[{type:"text",text:"Thanks"}]});
    await relay.completed(fork.id,2);
    assert.doesNotMatch(JSON.stringify((await relay.frames("turn/start")).at(-1).params.input),/The earlier conversation of this thread, handed over/);
    // The source goes on in its own conversation.
    assert.equal(relay.threadStore.get(source.id).providerSessionId,sourceSession);
    assert.equal(relay.threadStore.get(source.id).providerMeta.historyHandoff,undefined);
  }finally{await relay.close()}
});

test("a Muse Code thread is not rewound: a revert is refused at once, with no Muse Code started, and the thread stays as it was",{timeout:60_000},async()=>{
  const relay=await museRelay("trebell-muse-revert-");
  try{
    // A saved Muse Code thread opened again: its session starts with its next message.
    const saved=relay.threadStore.create({runtime:"muse",cwd:relay.root,providerSessionId:"01a11a6a-bbb5-7000-ad0b-0c9e728406e5",model:"muse-wonder-1.0",providerMeta:{runtimeInstanceId:"muse-default"}});
    const turn=relay.threadStore.addTurn(saved.id,{inputText:"Earlier message",status:"completed"});
    relay.threadStore.updateTurn?.(saved.id,turn.id,{status:"completed"});
    await assert.rejects(relay.rpc("thread/revert",{threadId:saved.id,beforeTurnId:turn.id}),{message:"Muse Code cannot rewind its conversation, so this thread cannot go back to an earlier message."});
    assert.equal((await relay.hosts()).length,0,"no Muse Code started to refuse it");
    const after=relay.threadStore.get(saved.id);
    assert.equal(after.turns.length,1);assert.equal(after.providerSessionId,"01a11a6a-bbb5-7000-ad0b-0c9e728406e5");
    assert.equal(relay.notifications.some(item=>item.method==="thread/reverted"),false);
  }finally{await relay.close()}
});
