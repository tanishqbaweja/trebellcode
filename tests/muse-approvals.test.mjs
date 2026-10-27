import test from "node:test";
import assert from "node:assert/strict";
import * as host from "../src/muse-host.mjs";
import * as muse from "../src/muse-agent-session.mjs";
import { FakeMuse, ReplayMuse, chunks, mspError, settle, startSession, until } from "./fixtures/muse/fake-host.mjs";
import { museRelay } from "./fixtures/muse/relay-harness.mjs";

// Muse Code's access modes, approvals and questions (T3 f87dd14da, d81afa0a6, a752363b1): each Trebell mode as Muse's launch flags,
// permission profile and approval mode; Muse's approvals as Trebell's approval card with Muse's own choices, answered through
// Trebell's policy and the person; its questions in Trebell's question dialog. Sessions run on a fake `muse serve` and T3's recorded
// permission session (fixtures/muse/permission-approved.ndjson), the relay tests on the stand-in Muse Code (fixtures/muse/fake-muse.cjs).

const MODES=[
  ["supervised",["serve","--trust-workspace"],":ask-me","promptUnmatched"],
  ["edits",["serve","--trust-workspace"],":ask-me","promptUnmatched"],
  ["auto",["serve","--trust-workspace"],":auto-review","promptUnmatched"],
  ["full",["serve","--trust-workspace","--disable-sandbox"],":unrestricted","allowAll"],
  ["read-only",["serve","--disable-shell","--disable-write"],":ask-me","promptUnmatched"],
];
// The shell approval T3 recorded with Muse 1.4.3 (muse_permission), with its three choices.
const RECORDED_CHOICES=[
  {choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},
  {choiceId:"allow_local_prefix",label:"Always allow in this workspace: touch ...",decision:"approvedPolicyAmendment",scope:"localPersistent",rulePreview:"Always allow in this workspace: touch ..."},
  {choiceId:"abort",label:"Reject",decision:"abort",scope:"once",acceptsFeedback:true},
];
const shellApproval=(sessionId,turnId,{approvalId="ap-1",sourceIndex=0,availableChoices=RECORDED_CHOICES,...extra}={})=>({
  sessionId,approvalId,turnId,taskId:approvalId,itemId:approvalId,toolCallId:"call_"+approvalId,toolName:"bash",rawArgs:"{\"command\":\"touch result.txt\"}",viewCursor:"v",sourceRange:{},
  subject:{kind:"shell",command:"touch result.txt",workspaceRoot:"\\\\?\\H:\\repo",stages:[]},currentRequirementId:{approvalId,sourceIndex},availableChoices,protectedWrite:false,judgeEscalated:false,...extra,
});
const childApproval=(sessionId,{approvalId="child-1",...extra}={})=>({...shellApproval(sessionId,"child-run-1",{approvalId,...extra}),subagentOrigin:{subagentId:"a7",childRunId:"child-run-1",childSessionId:"child-session"}});
const resolved=(sessionId,turnId,approvalId="ap-1",{decision="approved",resolvedBy="user"}={})=>({sessionId,approvalId,itemId:approvalId,turnId,decision,policyResult:decision==="abort"||decision==="denied"?"deny":"allow",resolvedBy,stageEvidence:[],sourceRange:{},viewCursor:"v"});
const QUESTIONS=[
  {id:"approach",header:"Approach",question:"Which approach?",options:[{label:"Small"},{label:"Large"}],selection:{mode:"single"}},
  {id:"checks",header:"Checks",question:"Which checks should run?",options:[{label:"Unit"},{label:"Lint"},{label:"E2E"}],selection:{mode:"multiple",minSelections:1,maxSelections:2}},
];
const question=(sessionId,turnId,{userInputId="q-1",questions=QUESTIONS}={})=>({sessionId,userInputId,turnId,itemId:userInputId,toolCallId:"call_"+userInputId,toolName:"request_user_input",viewCursor:"v",questions});
const settledQuestion=(sessionId,userInputId,outcome="answered",answers=[])=>({sessionId,userInputId,outcome,answers,clarification:null,decidedAt:null,decidedByCommandId:null,reason:null,sourceRange:{},viewCursor:"v"});
async function runningTurn(fixture){
  const running=fixture.session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await fixture.muse.next("turn/start");
  return {running,turnId,sid:fixture.session.sessionId};
}
const complete=(fixture,turnId,terminal="completed",extra={})=>fixture.muse.notify("turn/completed",{sessionId:fixture.session.sessionId,viewCursor:"v",terminal,turnId,...extra});
const accepted=params=>({commandId:params.commandId,status:"accepted",approvalId:params.approvalId,terminal:true});
// A stage's decision that leaves the approval's later stages to decide, as Muse acknowledges one (terminal false).
const staged=params=>({...accepted(params),terminal:false});

test("each Trebell mode launches Muse Code's host with its own flags and starts its session in its own permission profile and approval mode (T3 sdk.test.ts)",async()=>{
  for(const [mode,args,permissionProfile,approvalMode] of MODES){
    const {session,muse:fake,spawned}=await startSession({permissionMode:mode});
    assert.deepEqual(spawned[0].args,args,mode);
    const [start]=fake.sent("session/start");
    assert.deepEqual([start.params.permissionProfile,start.params.approvalMode],[permissionProfile,approvalMode],mode);
    assert.deepEqual(host.museLaunchPlan?.(mode),{args,permissionProfile,approvalMode},mode);
    await session.close();
  }
});

test("a saved conversation resumes in its mode's permission profile, and its approval mode is set after it (a resume replays the old one)",async()=>{
  const saved="01a17000-1111-7000-8000-000000000001";
  for(const [mode,args,permissionProfile,approvalMode] of MODES){
    const {session,muse:fake,spawned}=await startSession({permissionMode:mode,providerSessionId:saved});
    const [resume]=fake.sent("session/resume"),[set]=fake.sent("session/setApprovalMode");
    assert.deepEqual([resume.params.sessionId,resume.params.permissionProfile],[saved,permissionProfile],mode);
    assert.deepEqual([set.params.sessionId,set.params.mode],[saved,approvalMode],mode);
    assert.ok(fake.frames.indexOf(resume)<fake.frames.indexOf(set),mode);
    assert.deepEqual(spawned[0].args,args,mode);
    await session.close();
  }
});

test("a mode is fixed when its host launches: one with other flags or another session profile needs a new host, Auto-accept edits on a Supervised host does not",async()=>{
  const supervised=await startSession({permissionMode:"supervised"});
  assert.deepEqual(MODES.map(([mode])=>supervised.session.needsRelaunch(mode)),[false,false,true,true,true]);
  supervised.session.setPermissionMode("edits");
  assert.equal(supervised.session.needsRelaunch("supervised"),false,"the host launched for Supervised still serves it");
  await supervised.session.close();
  const full=await startSession({permissionMode:"full"});
  assert.deepEqual(MODES.map(([mode])=>full.session.needsRelaunch(mode)),[true,true,true,false,true]);
  await full.session.close();
});

test("T3's recorded permission session: Allow once sends Muse's allow_once, the stage update after it asks nothing more, and Reject in the next turn sends its abort",async()=>{
  let count=0;
  const fixture=await startSession({muse:child=>new ReplayMuse(child,"permission-approved"),approve:()=>++count===1?"accept":"decline"});
  assert.equal((await fixture.session.prompt([{type:"text",text:"Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE."}])).stopReason,"end_turn");
  assert.equal(chunks(fixture.updates),"DONE");
  fixture.updates.length=0;
  assert.equal((await fixture.session.prompt([{type:"text",text:"Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED."}])).stopReason,"end_turn");
  assert.equal(chunks(fixture.updates),"REJECTED");
  const decides=fixture.muse.frames.filter(frame=>frame.method==="approval/decide");
  assert.deepEqual(decides.map(frame=>frame.params.choiceId),["allow_once","abort"]);
  assert.deepEqual(decides.map(frame=>frame.params.requirementId),[{approvalId:"01a11a6d-4730-75f1-bc60-4e5df1a3cdc0",sourceIndex:0},{approvalId:"01a11a6d-9054-70c0-bf68-3ec59d37fbf8",sourceIndex:0}]);
  assert.equal(fixture.asks.length,2,"each approval is asked once: its request, its notification and its stage update ask nothing more");
  assert.deepEqual(fixture.asks.map(ask=>ask.request.params.toolCall.title),["touch muse-approved.txt","touch muse-declined.txt"]);
  assert.deepEqual(fixture.asks[0].request.approvalOptions,[{decision:"accept",label:"Allow once"},{decision:"acceptAlways",label:"Always allow in this workspace: touch ..."},{decision:"decline",label:"Reject"}]);
  assert.equal(fixture.asks[0].request.askUser,false,"Supervised: Trebell's policy answers first, the person the rest");
  assert.equal(fixture.session.requests.size,0,"Muse settled both");
  assert.deepEqual(fixture.muse.unexpected,[]);
  await fixture.session.close();
});

test("Always allow in this workspace answers with Muse's own rule, and each choice keeps Muse's words and order on the card",async()=>{
  const fixture=await startSession({approve:()=>"acceptAlways"});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  assert.equal((await fixture.muse.next("approval/decide")).params.choiceId,"allow_local_prefix");
  complete(fixture,turnId);await running;await fixture.session.close();
  assert.deepEqual(muse.museApprovalOptions?.([{choiceId:"y",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"s",label:"Allow for this session",decision:"approvedForSession",scope:"session"},{choiceId:"n",label:"Deny",decision:"denied",scope:"once"},{choiceId:"x",label:"Stop",decision:"abort",scope:"once"}]),
    [{decision:"accept",label:"Allow once"},{decision:"acceptForSession",label:"Allow for this session"},{decision:"decline",label:"Deny"},{decision:"cancel",label:"Stop"}],"an abort beside a denied choice is its own button");
  assert.deepEqual(muse.museApprovalOptions([{choiceId:"keep",label:"Keep out",decision:"deniedPolicyAmendment",scope:"localPersistent"},{choiceId:"n",label:"Deny",decision:"denied",scope:"once"},{choiceId:"later",label:"Later",decision:"approvedSomeday",scope:"once"}]),[{decision:"decline",label:"Deny"}],"the narrowest Reject, and no choice of a decision Trebell does not know");
});

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test("a card answers the stage it shows: one Muse moves to its next stage meanwhile is withdrawn and that stage asked in its place, with its own choices, and a decided stage's next stage is asked in turn",async()=>{
  const fixture=await startSession({muse:child=>new FakeMuse(child,{handlers:{"approval/decide":staged}})});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  await until(()=>fixture.asks.length===1,"the card");
  // Muse's reviewer moves the approval to the command's next stage while its card shows: that card goes, and the next stage is asked
  // with its own rule, never the rule the first card showed.
  const nextChoices=[RECORDED_CHOICES[0],{...RECORDED_CHOICES[1],choiceId:"allow_local_prefix_rm",label:"Always allow in this workspace: rm ...",rulePreview:"Always allow in this workspace: rm ..."},RECORDED_CHOICES[2]];
  fixture.muse.notify("approval/updated",{...shellApproval(sid,turnId,{sourceIndex:1,availableChoices:nextChoices}),change:{kind:"reviewCompleted"}});
  await until(()=>fixture.asks.length===2,"the next stage's card");
  assert.equal(fixture.asks[0].withdrawn,true,"the card of the stage Muse moved past is withdrawn");
  assert.deepEqual(fixture.asks[1].request.approvalOptions.map(option=>option.label),["Allow once","Always allow in this workspace: rm ...","Reject"]);
  fixture.asks[1].answer("acceptAlways");
  const first=await fixture.muse.next("approval/decide");
  assert.deepEqual([first.params.choiceId,first.params.requirementId],["allow_local_prefix_rm",{approvalId:"ap-1",sourceIndex:1}]);
  // A staged shell review: Muse moves the approval to the command's next stage, which is asked again.
  fixture.muse.notify("approval/updated",{...shellApproval(sid,turnId,{sourceIndex:2}),change:{kind:"stageResolved",requirementId:{approvalId:"ap-1",sourceIndex:1},choiceId:"allow_local_prefix_rm",decision:"approvedPolicyAmendment"}});
  await until(()=>fixture.asks.length===3,"the stage after the decided one");
  fixture.asks[2].answer("decline");
  const second=await fixture.muse.next("approval/decide");
  assert.deepEqual([second.params.choiceId,second.params.requirementId],["abort",{approvalId:"ap-1",sourceIndex:2}]);
  fixture.muse.notify("approval/resolved",resolved(sid,turnId,"ap-1",{decision:"abort"}));
  complete(fixture,turnId);await running;
  assert.equal(fixture.muse.sent("approval/decide").length,2,"nothing was sent for the withdrawn card");
  assert.equal(fixture.asks.length,3);
  await fixture.session.close();
});

test("an answer to a stage Muse moved past before its card went is refused by Muse as stale and never asked again, and the stage Muse asks now is asked once",async()=>{
  const decide=async params=>{if(params.requirementId?.sourceIndex===0)throw mspError("approvalRequirementStale","the requirement is stale",-32053);return accepted(params)};
  const fixture=await startSession({muse:child=>new FakeMuse(child,{handlers:{"approval/decide":decide}})});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  await until(()=>fixture.asks.length===1,"the card");
  fixture.asks[0].answer("accept");
  assert.deepEqual((await fixture.muse.next("approval/decide")).params.requirementId,{approvalId:"ap-1",sourceIndex:0},"the answer names the stage it was given for");
  await pause(150);
  assert.equal(fixture.asks.length,1,"the stage Muse moved past is not asked again");
  fixture.muse.notify("approval/updated",{...shellApproval(sid,turnId,{sourceIndex:1}),change:{kind:"reviewCompleted"}});
  await until(()=>fixture.asks.length===2,"the stage Muse asks now");
  fixture.asks[1].answer("accept");
  assert.deepEqual((await fixture.muse.next("approval/decide")).params.requirementId,{approvalId:"ap-1",sourceIndex:1});
  fixture.muse.notify("approval/resolved",resolved(sid,turnId));
  complete(fixture,turnId);await running;
  assert.equal(fixture.asks.length,2);
  await fixture.session.close();
});

test("a decision Muse acknowledges as closing the whole approval (terminal) asks no later stage, though a trailing update still names one (Meta's SDK)",async()=>{
  let turnKey=null;
  const decide=(params,fake)=>{
    fake.notify("approval/updated",{...shellApproval(params.sessionId,turnKey,{sourceIndex:1}),change:{kind:"stageResolved",requirementId:{approvalId:"ap-1",sourceIndex:0},choiceId:params.choiceId,decision:"approvedPolicyAmendment"}});
    return {...accepted(params),terminal:true};
  };
  const fixture=await startSession({approve:()=>"acceptAlways",muse:child=>new FakeMuse(child,{handlers:{"approval/decide":decide}})});
  const {running,turnId,sid}=await runningTurn(fixture);turnKey=turnId;
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  assert.equal((await fixture.muse.next("approval/decide")).params.choiceId,"allow_local_prefix");
  await pause(150);
  assert.equal(fixture.asks.length,1,"no card for a stage the decision already closed");
  fixture.muse.notify("approval/resolved",resolved(sid,turnId,"ap-1",{decision:"approvedPolicyAmendment"}));
  complete(fixture,turnId);await running;
  assert.equal(fixture.muse.sent("approval/decide").length,1);
  assert.equal(fixture.session.requests.size,0);
  await fixture.session.close();
});

test("a resolve that arrives before Muse acknowledges the decision keeps it: one decision, no second card, and a late refusal of it asks nothing",async()=>{
  for(const ack of ["accepted","already resolved"]){
    let release;const held=new Promise(resolve=>{release=resolve});
    const fixture=await startSession({approve:()=>"decline",muse:child=>new FakeMuse(child,{handlers:{"approval/decide":async params=>{await held;if(ack!=="accepted")throw mspError("approvalAlreadyResolved","approval is already resolved",-32051);return accepted(params)}}})});
    const {running,turnId,sid}=await runningTurn(fixture);
    fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
    const decide=await fixture.muse.next("approval/decide");
    assert.equal(decide.params.choiceId,"abort",ack);
    // Muse settles the approval with the person's Reject before it answers the command.
    fixture.muse.notify("approval/resolved",{...resolved(sid,turnId,"ap-1",{decision:"abort"}),decidedByCommandId:decide.params.commandId});
    await until(()=>fixture.session.requests.size===0,"the approval to be settled");
    release();await settle();await settle();await settle();
    complete(fixture,turnId);await running;
    assert.equal(fixture.asks.length,1,ack);
    assert.equal(fixture.muse.sent("approval/decide").length,1,ack);
    await fixture.session.close();
  }
});

test("Muse settling an approval itself withdraws its card, its reviewer deciding in Auto included, and nothing is sent for it; a late copy asks nothing",async()=>{
  const fixture=await startSession({permissionMode:"auto"});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId,{judgeEscalated:true}));
  await until(()=>fixture.asks.length===1,"the card");
  assert.equal(fixture.asks[0].request.askUser,true,"Auto: Muse's reviewer cleared what it could, so what it asks goes to the person");
  fixture.muse.notify("approval/resolved",resolved(sid,turnId,"ap-1",{resolvedBy:"llmJudge"}));
  await until(()=>fixture.asks[0].withdrawn,"the card to be withdrawn");
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  await settle();await settle();
  complete(fixture,turnId);await running;
  assert.equal(fixture.asks.length,1);
  assert.equal(fixture.muse.sent("approval/decide").length,0);
  await fixture.session.close();
});

test("in Full access a workflow child's approval is answered Allow once without a card, while its turn runs and after the turn ended (T3: Muse does not pass allowAll on to workflow children)",async()=>{
  for(const turnEnded of [false,true]){
    const fixture=await startSession({permissionMode:"full",muse:child=>new FakeMuse(child,{handlers:{"approval/decide":staged}})});
    const {running,turnId,sid}=await runningTurn(fixture);
    if(turnEnded){complete(fixture,turnId);await running}
    fixture.muse.notify("approval/requested",childApproval(sid));
    const decide=await fixture.muse.next("approval/decide");
    assert.deepEqual([decide.params.choiceId,decide.params.requirementId],["allow_once",{approvalId:"child-1",sourceIndex:0}],turnEnded?"after":"during");
    // Its next stage too.
    fixture.muse.notify("approval/updated",{...childApproval(sid,{sourceIndex:1}),change:{kind:"stageResolved"}});
    assert.deepEqual((await fixture.muse.next("approval/decide")).params.requirementId,{approvalId:"child-1",sourceIndex:1});
    fixture.muse.notify("approval/resolved",resolved(sid,"child-run-1","child-1"));
    if(!turnEnded){complete(fixture,turnId);await running}
    assert.equal(fixture.asks.length,0,"never shown");
    await fixture.session.close();
  }
});

test("a Full access child's approval is shown when Muse refuses the automatic answer, and never once Muse has settled it though that answer then fails",async()=>{
  let release;const held=new Promise(resolve=>{release=resolve});
  const decide=async params=>{
    if(params.approvalId==="child-1"&&params.choiceId==="allow_once")throw mspError("approvalChoiceInvalid","choice rejected",-32052);
    if(params.approvalId==="child-2"){await held;throw mspError("approvalAlreadyResolved","approval is already resolved",-32051)}
    return accepted(params);
  };
  const fixture=await startSession({permissionMode:"full",muse:child=>new FakeMuse(child,{handlers:{"approval/decide":decide}})});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("approval/requested",childApproval(sid));
  await until(()=>fixture.asks.length===1,"the card once Muse refused the automatic answer");
  assert.equal(fixture.asks[0].request.askUser,true,"only the person answers it");
  fixture.asks[0].answer("decline");
  await until(()=>fixture.muse.sent("approval/decide").length===2,"the person's decision");
  assert.deepEqual(fixture.muse.sent("approval/decide").map(frame=>frame.params.choiceId),["allow_once","abort"]);
  // A second child approval that Muse settles while the automatic answer waits: never shown.
  fixture.muse.notify("approval/requested",childApproval(sid,{approvalId:"child-2"}));
  await until(()=>fixture.muse.sent("approval/decide").length===3,"the automatic answer");
  fixture.muse.notify("approval/resolved",resolved(sid,"child-run-1","child-2"));
  release();await settle();await settle();await settle();
  complete(fixture,turnId);await running;
  assert.equal(fixture.asks.length,1);
  await fixture.session.close();
});

test("in Supervised a workflow child's approval waits for the person past its turn's end, and goes with the session's close",async()=>{
  const fixture=await startSession();
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("approval/requested",childApproval(sid));
  await until(()=>fixture.asks.length===1,"the card");
  assert.equal(fixture.asks[0].request.askUser,false);
  complete(fixture,turnId);await running;
  assert.equal(fixture.asks[0].withdrawn,false,"the turn's end leaves a workflow child's approval waiting");
  fixture.asks[0].answer("decline");
  assert.equal((await fixture.muse.next("approval/decide")).params.choiceId,"abort");
  fixture.muse.notify("approval/requested",childApproval(sid,{approvalId:"child-3"}));
  await until(()=>fixture.asks.length===2,"another card");
  await fixture.session.close();
  assert.equal(fixture.asks[1].withdrawn,true);
});

test("Trebell's policy answers a Supervised approval first; a protected write, a subject Trebell does not know and a stage with no Allow once go to the person only",async()=>{
  const fixture=await startSession({permissionMode:"edits"});
  const {running,turnId,sid}=await runningTurn(fixture);
  const fileWrite=extra=>shellApproval(sid,turnId,{approvalId:"file-"+Object.keys(extra).join(""),subject:{kind:"fileAccess",access:"write",path:"src/app.js"},toolName:"write_file",availableChoices:[{choiceId:"yes",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"no",label:"Reject",decision:"denied",scope:"once"}],...extra});
  fixture.muse.notify("approval/requested",fileWrite({}));
  fixture.muse.notify("approval/requested",fileWrite({protectedWrite:true}));
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId,{approvalId:"odd",subject:{kind:"screenRecording",target:"the whole screen"}}));
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId,{approvalId:"no-once",availableChoices:[RECORDED_CHOICES[1],RECORDED_CHOICES[2]]}));
  await until(()=>fixture.asks.length===4,"four asks");
  assert.deepEqual(fixture.asks.map(ask=>[ask.request.params.toolCall.kind,ask.request.params.toolCall.title,ask.request.askUser]),[
    ["edit","src/app.js",false],["edit","src/app.js",true],["other","the whole screen",true],["execute","touch result.txt",true],
  ]);
  assert.deepEqual(fixture.asks[0].request.params.toolCall.rawInput,{path:"src/app.js",access:"write"},"the path Trebell's policy places in the workspace");
  complete(fixture,turnId);await running;
  assert.ok(fixture.asks.every(ask=>ask.withdrawn),"the turn's end withdraws what it left open");
  await fixture.session.close();
});

test("Stop withdraws the turn's own open approval and question without answering them for the person, and a workflow child's card waits",async()=>{
  const fixture=await startSession();
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  fixture.muse.notify("userInput/requested",question(sid,turnId));
  fixture.muse.notify("approval/requested",childApproval(sid));
  await until(()=>fixture.asks.length===3,"three asks");
  const stopping=fixture.session.cancel();
  await fixture.muse.next("turn/interrupt");
  complete(fixture,turnId,"cancelled");
  await stopping;
  assert.equal((await running).stopReason,"cancelled");
  assert.deepEqual(fixture.asks.map(ask=>[ask.kind,ask.withdrawn]),[["approval",true],["question",true],["approval",false]]);
  assert.deepEqual(["approval/decide","userInput/answer","userInput/cancel"].map(method=>fixture.muse.sent(method).length),[0,0,0],"Muse settles them as it stops the turn");
  await fixture.session.close();
  assert.equal(fixture.asks[2].withdrawn,true,"closing the session takes the child's too");
});

test("answers go back as Muse takes them: one choice by its label, several within their bounds, and the person's own words as a free-text answer or a note beside the choices (T3 respondToRuntimeRequest)",async()=>{
  assert.deepEqual(muse.museUserInputAnswers?.(QUESTIONS,{approach:["Small","Keep tests focused"],checks:["Unit","Lint"]}),{answers:[{questionId:"approach",selectedLabel:"Small",note:"Keep tests focused"},{questionId:"checks",selectedLabels:["Unit","Lint"]}]});
  assert.deepEqual(muse.museUserInputAnswers(QUESTIONS,{approach:["Something else entirely"],checks:["E2E"]}),{answers:[{questionId:"approach",freeText:"Something else entirely"},{questionId:"checks",selectedLabels:["E2E"]}]});
  const fixture=await startSession({reply:()=>({approach:["Large"],checks:["Unit","E2E","Unit"]})});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.write({jsonrpc:"2.0",id:71,method:"userInput/request",params:question(sid,turnId)});
  fixture.muse.notify("userInput/requested",question(sid,turnId));
  const answer=await fixture.muse.next("userInput/answer");
  assert.deepEqual({...answer.params,commandId:"C"},{sessionId:sid,userInputId:"q-1",answers:[{questionId:"approach",selectedLabel:"Large"},{questionId:"checks",selectedLabels:["Unit","E2E"]}],commandId:"C"});
  assert.equal(fixture.asks.length,1,"its request and its notification ask once");
  assert.deepEqual(fixture.asks[0].request.input.questions.map(item=>[item.id,item.header,item.question,item.multiSelect,item.allowCustomAnswer,item.options.map(option=>option.label)]),[
    ["approach","Approach","Which approach?",false,true,["Small","Large"]],["checks","Checks","Which checks should run?",true,true,["Unit","Lint","E2E"]],
  ]);
  fixture.muse.notify("userInput/settled",settledQuestion(sid,"q-1","answered",answer.params.answers));
  complete(fixture,turnId);await running;
  assert.equal(fixture.session.requests.size,0);
  await fixture.session.close();
});

test("an answer Muse would refuse is asked again, saying what it lacked: over 500 characters of the person's own words, two choices for one, too many or too few",async()=>{
  const refusals=[
    [{approach:["x".repeat(501)],checks:["Unit"]},"approach",/^Muse Code takes at most 500 characters of your own words; the last answer had 501\.$/],
    [{approach:["Small","Large"],checks:["Unit"]},"approach",/^Choose one option\.$/],
    [{approach:["Small"],checks:["Unit","Lint","E2E"]},"checks",/^Choose at most 2 options\.$/],
    [{approach:["Small"],checks:[]},"checks",/^Answer this question to go on\.$/],
  ];
  for(const [answers,questionId,message] of refusals){const {error}=muse.museUserInputAnswers?.(QUESTIONS,answers)||{};assert.equal(error?.questionId,questionId);assert.match(error?.message,message)}
  assert.match(muse.museUserInputAnswers([{...QUESTIONS[1],selection:{mode:"multiple",minSelections:2}}],{checks:["Unit"]}).error.message,/^Choose at least 2 options\.$/);
  assert.equal(muse.museUserInputAnswers(QUESTIONS,{approach:["x".repeat(500)],checks:["Unit"]}).answers[0].freeText.length,500,"500 characters go");
  let count=0;
  const fixture=await startSession({reply:()=>++count===1?{approach:["x".repeat(501)],checks:["Unit"]}:{approach:["Small"],checks:["Unit"]}});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("userInput/requested",question(sid,turnId));
  const answer=await fixture.muse.next("userInput/answer");
  assert.equal(fixture.asks.length,2,"asked again");
  assert.equal(fixture.asks[1].request.input.questions[0].question,"Which approach? (Muse Code takes at most 500 characters of your own words; the last answer had 501.)");
  assert.equal(fixture.asks[1].request.input.questions[1].question,"Which checks should run?");
  assert.deepEqual(answer.params.answers,[{questionId:"approach",selectedLabel:"Small"},{questionId:"checks",selectedLabels:["Unit"]}]);
  assert.equal(fixture.muse.sent("userInput/answer").length,1,"the refused answer never went to Muse");
  complete(fixture,turnId);await running;
  await fixture.session.close();
});

test("a question the person closes is cancelled with a reason, and one Muse settles itself withdraws its dialog with nothing sent",async()=>{
  let first=true;
  const fixture=await startSession({reply:()=>{if(!first)return undefined;first=false;return {}}});
  const {running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.notify("userInput/requested",question(sid,turnId));
  const cancel=await fixture.muse.next("userInput/cancel");
  assert.equal(cancel.params.userInputId,"q-1");
  assert.equal(cancel.params.reason,"The user closed the question without answering. Continue without the answer.");
  fixture.muse.notify("userInput/settled",settledQuestion(sid,"q-1","cancelled"));
  fixture.muse.notify("userInput/requested",question(sid,turnId,{userInputId:"q-2"}));
  await until(()=>fixture.asks.length===2,"the second dialog");
  fixture.muse.notify("userInput/settled",settledQuestion(sid,"q-2","timedOut"));
  await until(()=>fixture.asks[1].withdrawn,"the dialog to be withdrawn");
  complete(fixture,turnId);await running;
  assert.deepEqual(["userInput/answer","userInput/cancel"].map(method=>fixture.muse.sent(method).length),[0,1]);
  await fixture.session.close();
});

test("through the relay, Muse's approval is the approval card with Muse's own choices, the person's Allow once reaches Muse as allow_once, and Muse's reviewer deciding takes the card off the screen",{timeout:120_000},async()=>{
  let answering={decision:"accept"};
  const relay=await museRelay("trebell-muse-approvals-",{answer:()=>answering});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please ask approval to touch the file"}],permissionProfile:"supervised"});
    await relay.completed(thread.id,1);
    const [card]=relay.requests;
    assert.equal(card.method,"item/tool/requestApproval");
    assert.deepEqual(card.params.approvalOptions,[{decision:"accept",label:"Allow once"},{decision:"acceptAlways",label:"Always allow in this workspace: touch ..."},{decision:"decline",label:"Reject"}]);
    assert.deepEqual([card.params.threadId,card.params.reason,card.params.toolCall.title,card.params.toolCall.kind],[thread.id,"touch muse-approved.txt","touch muse-approved.txt","execute"]);
    const [decide]=await relay.frames("approval/decide");
    assert.deepEqual([decide.params.choiceId,decide.params.requirementId.sourceIndex],["allow_once",0]);
    assert.equal(relay.reply(thread.id),"APPROVED");
    // Muse's reviewer decides the next one while its card shows, and the card goes.
    answering=undefined;
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Muse's reviewer decides this one"}]});
    await relay.completed(thread.id,2);
    const second=relay.requests[1];
    assert.equal(second.method,"item/tool/requestApproval");
    assert.ok(relay.notifications.some(item=>item.method==="serverRequest/resolved"&&item.params.requestId===second.id&&item.params.threadId===thread.id),"the card goes once Muse's reviewer decided");
    assert.equal(relay.reply(thread.id),"THE REVIEWER ALLOWED IT");
    assert.equal((await relay.frames("approval/decide")).length,1,"nothing was sent for it");
  }finally{await relay.close()}
});

test("through the relay, Muse's question opens Trebell's question dialog, and the person's choice and own words reach Muse as its answer",{timeout:120_000},async()=>{
  const relay=await museRelay("trebell-muse-questions-",{answer:request=>request.method==="item/tool/requestUserInput"?{answers:{approach:{answers:["Small","Keep the tests focused"]}}}:undefined});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please ask question about the approach"}]});
    await relay.completed(thread.id,1);
    const [dialog]=relay.requests;
    assert.equal(dialog.method,"item/tool/requestUserInput");
    assert.deepEqual(dialog.params.questions,[{id:"approach",header:"Approach",question:"Which approach should I take?",required:true,allowMultiple:false,options:[{label:"Small",description:"One file at a time"},{label:"Large",description:"Everything at once"}]}]);
    const [answer]=await relay.frames("userInput/answer");
    assert.deepEqual(answer.params.answers,[{questionId:"approach",selectedLabel:"Small",note:"Keep the tests focused"}]);
    assert.equal(relay.reply(thread.id),"ANSWERED: Small — Keep the tests focused");
  }finally{await relay.close()}
});

test("a Muse Code thread whose mode changes is relaunched on its next message: the conversation resumes on a host launched for the new mode, in its profile and approval mode",{timeout:180_000},async()=>{
  const relay=await museRelay("trebell-muse-modes-");
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0",permissionProfile:"supervised"});
    const steps=[["Hello Muse","supervised"],["Now with full access","full"],["Still full access","full"],["Auto now","auto"],["Auto-accept edits","edits"],["Supervised again","supervised"]];
    for(const [index,[text,permissionProfile]] of steps.entries()){
      await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text}],permissionProfile});
      await relay.completed(thread.id,index+1);
    }
    assert.deepEqual((await relay.hosts()).map(entry=>entry.start),[["serve","--trust-workspace"],["serve","--trust-workspace","--disable-sandbox"],["serve","--trust-workspace"],["serve","--trust-workspace"]],"Full access and Auto each need a host of their own; Auto-accept edits and Supervised share one");
    const [start]=await relay.frames("session/start"),resumes=await relay.frames("session/resume"),modes=await relay.frames("session/setApprovalMode");
    assert.deepEqual([start.params.permissionProfile,start.params.approvalMode],[":ask-me","promptUnmatched"]);
    assert.deepEqual(resumes.map(frame=>[frame.params.sessionId,frame.params.permissionProfile]),[[start.params.sessionId,":unrestricted"],[start.params.sessionId,":auto-review"],[start.params.sessionId,":ask-me"]]);
    assert.deepEqual(modes.map(frame=>frame.params.mode),["allowAll","promptUnmatched","promptUnmatched"]);
    assert.equal(relay.threadStore.get(thread.id).providerSessionId,start.params.sessionId,"one conversation throughout");
    assert.ok(relay.threadStore.get(thread.id).turns.every(turn=>turn.status==="completed"));
  }finally{await relay.close()}
});
