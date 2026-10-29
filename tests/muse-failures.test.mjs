import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as muse from "../src/muse-agent-session.mjs";
import { itemFrame, settle, settlesWithin, startSession, until } from "./fixtures/muse/fake-host.mjs";
import { eventually, museRelay } from "./fixtures/muse/relay-harness.mjs";

// Muse Code's turn failures, usage limits and host recovery (T3 93ea95cf4, 4bf8b476f, 300a35670, d6f47ff97): a turn the subscription
// quota stopped says the usage limit was reached and when it resets, a retry Muse schedules is the turn's retry row, a delivery gap or
// a host that exits ends the turn once and takes its cards with it, a host that died between turns says so as no turn's and comes
// back on the next message, a message whose host fails is refused once in Muse's own words, and a notice Trebell cannot read is
// skipped with a log line.

// T3's usageLimits.test.ts: Muse's usage report, observed at nowMs, and the refusal Meta relayed through Muse.
const USAGE={observedAtMs:1791447762610,tier:"tier-1",window:{usedPercent:0,windowDurationMins:300,resetsAtMs:1791465557000},weekly:{usedPercent:5,resetsAtMs:1791763200000}};
const NOW=USAGE.observedAtMs;
const REAL_REFUSAL="API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.) (after 10 provider attempts)";
const QUOTA_MESSAGE="API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)";
const limited=(error,message)=>muse.museUsageLimited?.(error,message);
const resetAt=(...args)=>muse.museUsageLimitResetAt?.(...args);

async function runningTurn(fixture){
  const running=fixture.session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await fixture.muse.next("turn/start");
  return {running,turnId,sid:fixture.session.sessionId};
}
const complete=(fixture,turnId,terminal="completed",extra={})=>fixture.muse.notify("turn/completed",{sessionId:fixture.session.sessionId,viewCursor:"v",terminal,turnId,...extra});
const shellApproval=(sessionId,turnId,approvalId="ap-1",extra={})=>({sessionId,approvalId,turnId,itemId:approvalId,toolCallId:"call_"+approvalId,toolName:"bash",viewCursor:"v",sourceRange:{},subject:{kind:"shell",command:"touch result.txt",stages:[]},currentRequirementId:{approvalId,sourceIndex:0},availableChoices:[{choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"abort",label:"Reject",decision:"abort",scope:"once"}],...extra});
const question=(sessionId,turnId)=>({sessionId,userInputId:"q-1",turnId,itemId:"q-1",toolCallId:"call_q",toolName:"request_user_input",viewCursor:"v",questions:[{id:"approach",header:"Approach",question:"Which approach?",options:[{label:"Small"},{label:"Large"}],selection:{mode:"single"}}]});
const failure=async promise=>{try{await promise}catch(error){return error}assert.fail("the turn did not fail")};
const local=iso=>new Date(iso).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});

test("Meta's quota refusal is a usage limit, and no other failure is (T3 usageLimits.test.ts)",()=>{
  assert.equal(limited({},QUOTA_MESSAGE),true);
  assert.equal(limited({},REAL_REFUSAL),true);
  assert.equal(limited({},"API error 429: Rate limit exceeded. (rate_limit_error)"),false,"a plain 429 rate limit is an ordinary failure");
  assert.equal(limited({},"Subscription quota exhausted."),false,"the quota without a 429");
  assert.equal(limited({},""),false);
  assert.equal(limited({kind:"modelError",message:"Model request refused.",quota:{limitKind:"tierLimit",resetsAtMs:USAGE.window.resetsAtMs}},"Model request refused."),true,"one Muse types as quota");
});

test("a usage limit lifts once every used-up window has reset, at the reset a refusal names or types when no report has one, and has no reset otherwise (T3 usageLimits.test.ts)",()=>{
  const sessionOut={...USAGE,window:{...USAGE.window,usedPercent:103}};
  assert.equal(resetAt(sessionOut,NOW),"2026-10-08T13:19:17.000Z");
  const bothOut={...sessionOut,weekly:{...USAGE.weekly,usedPercent:100}};
  assert.equal(resetAt(bothOut,NOW),"2026-10-12T00:00:00.000Z","with both windows out, the later reset wins");
  assert.equal(resetAt(undefined,NOW,{message:REAL_REFUSAL}),"2026-10-13T10:45:52.000Z","the recorded refusal is limited until the time it names");
  const quota={resetsAtMs:USAGE.window.resetsAtMs};
  assert.equal(resetAt(USAGE,NOW,{quota}),"2026-10-08T13:19:17.000Z");
  assert.equal(resetAt({...USAGE,weekly:{...USAGE.weekly,usedPercent:100}},NOW,{quota}),"2026-10-12T00:00:00.000Z");
  assert.equal(resetAt(undefined,NOW),null);
  assert.equal(resetAt(USAGE,NOW),null,"no window is used up");
  assert.equal(resetAt({...USAGE,window:{...USAGE.window,usedPercent:100}},USAGE.window.resetsAtMs),null,"a reset that has passed");
  assert.equal(resetAt(undefined,Date.parse("2026-10-14T00:00:00Z"),{message:REAL_REFUSAL}),null);
});

test("a turn the quota stopped says the Muse Code usage limit was reached and when it resets, the later of two used-up windows, with Muse's own words kept; a plain 429 stays Muse's own failure",async()=>{
  const fixture=await startSession();
  const hours=hours=>Date.now()+hours*3_600_000,windowReset=hours(2),weekReset=hours(50);
  fixture.muse.notify("usage/changed",{observedAtMs:Date.now(),tier:"tier-1",window:{usedPercent:103,windowDurationMins:300,resetsAtMs:windowReset},weekly:{usedPercent:100,resetsAtMs:weekReset}});
  let turn=await runningTurn(fixture);
  complete(fixture,turn.turnId,"failed",{reason:QUOTA_MESSAGE,error:{kind:"modelError",message:QUOTA_MESSAGE,retryable:false}});
  let error=await failure(turn.running);
  assert.equal(error.usageLimit,true);
  assert.equal(error.resetAt,new Date(weekReset).toISOString(),"usage/changed names no session, and the later reset wins");
  assert.equal(error.message,`Muse Code usage limit reached. Send the message again after it resets at ${local(error.resetAt)}.`);
  assert.equal(error.detail,QUOTA_MESSAGE);
  // A refusal relayed without error.quota names its own reset.
  const named=new Date(hours(30)).toISOString().replace(/\.\d{3}Z$/,"Z");
  turn=await runningTurn(fixture);
  fixture.muse.notify("usage/changed",{observedAtMs:Date.now(),tier:"tier-1",window:{usedPercent:10,windowDurationMins:300,resetsAtMs:windowReset},weekly:{usedPercent:10,resetsAtMs:weekReset}});
  const relayed=REAL_REFUSAL.replace("2026-10-13T10:45:52Z",named);
  complete(fixture,turn.turnId,"failed",{reason:relayed,error:{kind:"modelError",message:relayed,retryable:true}});
  error=await failure(turn.running);
  assert.deepEqual([error.usageLimit,error.resetAt],[true,named.replace("Z",".000Z")]);
  // A stop Muse types as quota, with no reset known.
  turn=await runningTurn(fixture);
  complete(fixture,turn.turnId,"failed",{error:{kind:"modelError",message:"Model request refused.",quota:{limitKind:"tierLimit",resetsAtMs:Date.now()-1000},retryable:true}});
  error=await failure(turn.running);
  assert.deepEqual([error.usageLimit,error.resetAt,error.message],[true,null,"Muse Code usage limit reached. Send the message again once it resets."]);
  // A plain rate limit is Muse's own failure.
  turn=await runningTurn(fixture);
  complete(fixture,turn.turnId,"failed",{error:{kind:"modelError",message:"API error 429: Rate limit exceeded. (rate_limit_error)",retryable:true}});
  error=await failure(turn.running);
  assert.deepEqual([error.usageLimit,error.message,error.code],[undefined,"API error 429: Rate limit exceeded. (rate_limit_error)","modelError"]);
  assert.equal(fixture.session.dead,false,"a refused turn leaves the session as it was");
  await fixture.session.close();
});

test("a usage report Trebell cannot read is skipped with a log line and the session goes on, and the limit then knows no reset (T3: skips an unreadable usage report)",async()=>{
  const fixture=await startSession();
  fixture.muse.notify("usage/changed",{window:"not usage"});
  fixture.muse.notify("usage/changed",{observedAtMs:Date.now(),tier:"tier-1",window:{usedPercent:103,windowDurationMins:300,resetsAtMs:1e16},weekly:{usedPercent:5,resetsAtMs:Date.now()+3_600_000}});
  const turn=await runningTurn(fixture);
  complete(fixture,turn.turnId,"failed",{error:{kind:"modelError",message:QUOTA_MESSAGE,retryable:false}});
  const error=await failure(turn.running);
  assert.deepEqual([error.usageLimit,error.resetAt],[true,null]);
  const skipped=fixture.updates.filter(update=>update.sessionUpdate==="protocol_warning"&&update.dropped===true);
  assert.deepEqual(skipped.map(update=>[update.method,update.message]),[["usage/changed","Trebell skipped Muse Code's usage/changed: it names no readable usage windows."],["usage/changed","Trebell skipped Muse Code's usage/changed: it names no readable usage windows."]]);
  assert.equal(fixture.session.dead,false);assert.equal(fixture.muse.stdinEnded,false,"the host is kept");
  await fixture.session.close();
});

test("a turn Muse could not run signed out says Muse Code is signed out and to sign in with muse login, keeping Muse's own words",async()=>{
  const fixture=await startSession();
  const turn=await runningTurn(fixture);
  // Muse 1.4.13's own answer to a Meta turn with no sign-in (live, signed out).
  complete(fixture,turn.turnId,"failed",{reason:"not logged in: run /login to add an API key",error:{kind:"authRequired",message:"not logged in: run /login to add an API key",retryable:false}});
  const error=await failure(turn.running);
  assert.equal(error.message,"Muse Code is signed out. Sign in with muse login, then send the message again.");
  assert.deepEqual([error.code,error.detail],["authRequired","not logged in: run /login to add an API key"]);
  await fixture.session.close();
});

test("turn/retryScheduled is the turn's retry row, and the turn goes on; one Trebell cannot read is skipped with a log line",async()=>{
  const fixture=await startSession();
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("turn/retryScheduled",{sessionId:sid,viewCursor:"v",sourceRange:{},turnId,attempt:1,nextAttempt:2,maxAttempts:3,reason:"429 Too Many Requests",retryDelayMs:2400,errorKind:"rateLimited",httpStatus:429,system:"meta"});
  fixture.muse.notify("turn/retryScheduled",{sessionId:sid,viewCursor:"v",sourceRange:{},turnId,attempt:2,nextAttempt:3,maxAttempts:3,retryDelayMs:1000});
  fixture.muse.write(itemFrame("item/completed",sid,{itemId:"say",kind:"agentMessage",turnId,revision:1,status:"completed",text:"Done after a retry."}));
  complete(fixture,turnId);
  assert.equal((await running).stopReason,"end_turn","the retry did not end the turn");
  assert.deepEqual(fixture.updates.filter(update=>update.sessionUpdate==="runtime_error"),[{sessionUpdate:"runtime_error",willRetry:true,message:"Muse Code is trying again in 2 s (attempt 2 of 3): 429 Too Many Requests"}]);
  assert.deepEqual(fixture.updates.filter(update=>update.dropped).map(update=>update.message),["Trebell skipped Muse Code's turn/retryScheduled: it names no readable attempt, delay or reason."]);
  assert.equal(fixture.session.dead,false);
  await fixture.session.close();
});

test("a delivery gap (view/gap) fails the running turn and leaves the session dead, its host stopped; one while idle says so once",async()=>{
  const fixture=await startSession();
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"sh",kind:"toolCall",tool:"bash",turnId,revision:1,status:"inProgress",args:"{\"command\":\"npm test\"}"}));
  fixture.muse.notify("view/gap",{sessionId:sid,after:"v4:x:3",next:"v4:x:9"});
  const error=await settlesWithin(failure(running),5000,"the turn");
  assert.equal(error.message,"Muse Code dropped some of this conversation's updates before they reached Trebell, so Trebell stopped it. The next message starts it again.");
  assert.equal(fixture.session.dead,true);
  await until(()=>fixture.muse.stdinEnded,"the host to be stopped");
  assert.deepEqual(fixture.updates.filter(update=>update.toolCallId==="sh").map(update=>[update.sessionUpdate,update.status]),[["tool_call","in_progress"],["tool_call_update","failed"]],"its running tool ends failed");
  assert.equal(fixture.updates.filter(update=>update.sessionUpdate==="runtime_error").length,0,"the turn carries the reason, once");
  await assert.rejects(fixture.session.prompt([{type:"text",text:"again"}]),/dropped some of this conversation's updates/);
  await fixture.session.close();
  const idle=await startSession();
  idle.muse.notify("view/gap",{sessionId:idle.session.sessionId,after:"a",next:"b"});
  idle.muse.notify("view/gap",{sessionId:idle.session.sessionId,after:"b",next:"c"});
  await until(()=>idle.session.dead,"the idle session to be dead");
  await settle();
  assert.deepEqual(idle.updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>[update.message,update.turnless]),[[error.message,true]],"as no turn's, once");
  await idle.session.close();
});

test("a host that exits during a turn fails it once with its exit, settles its running tools failed, and withdraws its approvals and questions, a workflow child's too",async()=>{
  const fixture=await startSession();
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"sh",kind:"toolCall",tool:"bash",turnId,revision:1,status:"inProgress",args:"{\"command\":\"npm test\"}"}));
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"say",kind:"agentMessage",turnId,revision:1,status:"inProgress",text:"Working"}));
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  fixture.muse.notify("userInput/requested",question(sid,turnId));
  fixture.muse.notify("approval/requested",{...shellApproval(sid,"child-run-1","child-1"),subagentOrigin:{subagentId:"a7",childRunId:"child-run-1",childSessionId:"child-session"}});
  await until(()=>fixture.asks.length===3,"the cards");
  fixture.child.stderr.write("panic: lost the model stream\n");
  // The connection closes and the process exits: one failure.
  setImmediate(()=>fixture.child.exit(1));
  const error=await failure(running);
  assert.equal(error.message,"Muse Code exited unexpectedly (code 1): panic: lost the model stream");
  assert.equal(fixture.session.dead,true);
  assert.deepEqual(fixture.asks.map(ask=>ask.withdrawn),[true,true,true],"every card goes with the host");
  assert.deepEqual(fixture.updates.filter(update=>update.toolCallId==="sh").map(update=>[update.sessionUpdate,update.status,update.rawOutput]),[["tool_call","in_progress",""],["tool_call_update","failed","The turn ended before this finished."]]);
  await settle();await settle();
  assert.equal(fixture.updates.filter(update=>update.sessionUpdate==="runtime_error").length,0,"the turn carries the reason, once");
  assert.deepEqual(["approval/decide","userInput/answer","userInput/cancel"].map(method=>fixture.muse.sent(method).length),[0,0,0]);
  await fixture.session.close();
});

test("a failed turn settles its running tools failed and withdraws the approvals and questions it left open",async()=>{
  const fixture=await startSession();
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"sh",kind:"toolCall",tool:"bash",turnId,revision:1,status:"inProgress",args:"{\"command\":\"npm test\"}"}));
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  await until(()=>fixture.asks.length===1,"the card");
  complete(fixture,turnId,"failed",{error:{kind:"modelError",message:"Provider rejected this turn",retryable:false}});
  assert.equal((await failure(running)).message,"Provider rejected this turn");
  assert.equal(fixture.asks[0].withdrawn,true);
  assert.equal(fixture.updates.filter(update=>update.toolCallId==="sh").at(-1).status,"failed");
  assert.equal(fixture.session.dead,false,"Muse's own failure leaves the host for the next turn");
  await fixture.session.close();
});

test("a Muse Code host that died between turns is relaunched on the next message, which resumes its conversation; one Muse no longer has continues in a fresh session with the earlier messages handed over",{timeout:180_000},async()=>{
  const relay=await museRelay("trebell-muse-relaunch-");
  try{
    // While this file is there, the stand-in's session/resume answers that the session was not found.
    const forget=join(relay.root,"forget");relay.state.settings().agentRuntimeInstances[0].environment.MUSE_FAKE_FORGET=forget;
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Reply, then exit when idle"}]});
    await relay.completed(thread.id,1);
    await eventually(()=>relay.notifications.some(item=>item.method==="error"&&item.params.threadId===thread.id&&/exited unexpectedly \(code 1\): panic: the model stream went away/.test(item.params.message)),"the idle host's exit");
    // No turn failed: the exit names none, and says what the next message does.
    const exit=relay.notifications.find(item=>item.method==="error"&&item.params.threadId===thread.id);
    assert.deepEqual([exit.params.turnId,exit.params.message],[null,"Muse Code exited unexpectedly (code 1): panic: the model stream went away. The next message starts it again."]);
    assert.equal(relay.threadStore.get(thread.id).turns.at(-1).status,"completed","the turn it came after stays completed");
    const sessionId=relay.threadStore.get(thread.id).providerSessionId;
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Are you back?"}]});
    await relay.completed(thread.id,2);
    assert.equal(relay.threadStore.get(thread.id).turns.at(-1).status,"completed");
    assert.match(relay.reply(thread.id),/Muse fixture reply/);
    assert.equal((await relay.hosts()).length,2,"a new host");
    assert.deepEqual((await relay.frames("session/resume")).map(frame=>frame.params.sessionId),[sessionId],"which resumed the conversation");
    // Muse's store no longer has the conversation: the next host starts a fresh session, handed the thread's earlier messages.
    await writeFile(forget,"1");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Reply, then exit when idle"}]});
    await relay.completed(thread.id,3);
    await eventually(()=>relay.notifications.filter(item=>item.method==="error"&&item.params.threadId===thread.id).length>=2,"the second exit");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Still there?"}]});
    await relay.completed(thread.id,4);
    assert.equal(relay.threadStore.get(thread.id).turns.at(-1).status,"completed");
    const starts=await relay.frames("session/start"),turns=await relay.frames("turn/start");
    assert.equal(starts.length,2,"a fresh session");
    assert.notEqual(relay.threadStore.get(thread.id).providerSessionId,sessionId);
    assert.match(JSON.stringify(turns.at(-1).params.input),/Are you back\?/,"the earlier messages went with the fresh session's first turn");
    assert.equal(relay.threadStore.get(thread.id).providerMeta.historyHandoff?.status,"delivered");
  }finally{await relay.close()}
});

test("through the relay, a message whose Muse Code host fails is refused in Muse's own words once, and once Muse Code works again the next message goes, within the minute the polls keep the failed check",{timeout:120_000},async()=>{
  const relay=await museRelay("trebell-muse-host-fails-");
  try{
    // While this file is there, the stand-in's host exits as Muse does with a malformed settings file.
    const failing=join(relay.root,"serve-fails");relay.state.settings().agentRuntimeInstances[0].environment.MUSE_FAKE_SERVE_FAIL=failing;
    assert.equal((await relay.manager.probe("muse",{fresh:true})).available,true,"Muse Code listed its models while it worked");
    await writeFile(failing,"3");
    const said="Muse Code could not load its settings; check ~/.config/muse/settings.json (exit code 3): load settings for serve composition: malformed settings file at ~/.config/muse/settings.json";
    const refused=async()=>{try{await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"})}catch(error){return error.message}assert.fail("the thread started")};
    const serves=async()=>(await readFile(relay.log,"utf8")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.start?.[0]==="serve").length;
    // The session's host fails, and so does the model list the check after it reads: said once.
    assert.equal(await refused(),said);
    // Sent again while Muse Code still fails: the start reads its list again, and says the same once.
    const asked=await serves();
    assert.equal(await refused(),said);
    assert.equal(await serves(),asked+1,"the start read Muse Code's list again");
    // Settings' poll keeps the failure for its minute, in its own words with its Refresh, and starts no host.
    assert.equal((await relay.manager.probe("muse")).message,`Muse Code could not list its models: ${said}. Press Refresh to check it again.`);
    assert.equal(await serves(),asked+1);
    // Muse Code works again (its settings mended outside Trebell): the next message goes at once.
    await rm(failing);
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello again"}]});
    await relay.completed(thread.id,1);
    assert.equal(relay.threadStore.get(thread.id).turns.at(-1).status,"completed");
    assert.match(relay.reply(thread.id),/Muse fixture reply/);
  }finally{await relay.close()}
});

test("through the relay, Muse retrying the turn's request is the turn's retry row (an error with willRetry) and the turn goes on, and a turn the quota stopped fails with the usage limit",{timeout:120_000},async()=>{
  const relay=await museRelay("trebell-muse-retry-");
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    const {turn}=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please retry once"}]});
    await relay.completed(thread.id,1);
    const errors=relay.notifications.filter(item=>item.method==="error"&&item.params.threadId===thread.id);
    assert.deepEqual(errors.map(item=>item.params),[{threadId:thread.id,turnId:turn.id,willRetry:true,message:"Muse Code is trying again in 2 s (attempt 2 of 3): 429 Too Many Requests"}]);
    assert.equal(relay.threadStore.get(thread.id).turns.at(-1).status,"completed");
    assert.equal(relay.reply(thread.id),"Muse fixture reply after a retry.");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"This one hits the quota"}]});
    await relay.completed(thread.id,2);
    const failed=relay.threadStore.get(thread.id).turns.at(-1);
    assert.equal(failed.status,"failed");
    assert.match(failed.error.message,new RegExp("^Muse Code usage limit reached\\. Send the message again after it resets at "+local("2031-05-04T10:45:52Z").replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\."));
  }finally{await relay.close()}
});

test("through the relay, a turn Muse could not run signed out says once how to sign in, though the check after it finds that Muse Code now lists no models",{timeout:120_000},async()=>{
  const lists=await mkdtemp(join(tmpdir(),"trebell-muse-models-")),models=join(lists,"model-list.json");
  await copyFile(fileURLToPath(new URL("./fixtures/muse/model-list-1.4.13.json",import.meta.url)),models);
  const relay=await museRelay("trebell-muse-signed-out-",{environment:{MUSE_FAKE_MODELS:models}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello Muse"}]});
    await relay.completed(thread.id,1);
    // Signed out since: Muse lists no models any more, and its next turn cannot run.
    await rm(models);
    const {turn}=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Now I am signed out"}]});
    await relay.completed(thread.id,2);
    const failed=relay.threadStore.get(thread.id).turns.at(-1);
    assert.equal(failed.status,"failed");
    assert.equal(failed.error.message,muse.MUSE_SIGNED_OUT_MESSAGE,"one sign-in instruction");
    assert.equal(relay.notifications.filter(item=>item.method==="error"&&item.params.turnId===turn.id).at(-1)?.params.message,muse.MUSE_SIGNED_OUT_MESSAGE);
    const status=await relay.manager.probe("muse");
    assert.deepEqual([status.available,status.message],[false,"Muse Code listed no models. Sign in with muse login, then press Refresh."],"the check after the failure still ran, so the next poll shows it");
  }finally{await relay.close();await rm(lists,{recursive:true,force:true})}
});
