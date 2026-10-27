import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HARNESS_TEXT_INSTRUCTIONS, generateTextWithHarness } from "../src/harness-text-generation.mjs";
import { MuseHost } from "../src/muse-host.mjs";
import { museModelCatalog } from "../src/muse-model-catalog.mjs";
import { FakeMuse, fakeChild, fakeStop, until } from "./fixtures/muse/fake-host.mjs";

// Git text (a commit subject, a pull request's title and body) written by Muse Code, as T3 Code's MuseTextGeneration writes it: one
// turn in a fresh session on a read-only host of Trebell's own in an empty folder. Meta's SDK (a real Connection) drives a fake
// `muse serve` (fixtures/muse/fake-host.mjs) whose frames follow Muse 1.4.13's schema; the cases follow T3's textGeneration.test.ts.
const CATALOG=museModelCatalog(JSON.parse(readFileSync(new URL("./fixtures/muse/model-list-1.4.13.json",import.meta.url),"utf8")).result);
const PROMPT="Write one Git commit subject for the current change.\n\nDiff:\n+login form";
const ACCEPTED=params=>({commandId:params.commandId,status:"accepted",turnId:params.commandId,startedNewTurn:true,disposition:"started"});

function museManager({catalog=CATALOG}={}){
  const calls={probes:0,rechecks:0};
  return {
    calls,
    definitions:()=>[{id:"muse",name:"Muse Code",protocol:"msp"}],
    activeInstance:()=>({id:"muse-default",kind:"muse"}),
    probe:async()=>{calls.probes++;return {available:true}},
    recheck:async()=>{calls.rechecks++;return {available:true}},
    executable:()=>"muse",
    childEnv:()=>({PATH:process.env.PATH||"",META_API_KEY:"a-key-the-profile-did-not-approve"}),
    processSpawner:()=>null,remoteIo:()=>null,runtimeCwd:cwd=>cwd,
    museModelCatalog:()=>catalog,
  };
}
// One Git text request on a fake host. turn(params, fake) answers turn/start (undefined: no answer) and plays the turn's events.
async function museText({turn=null,models=["muse-wonder-1.0"],catalog=CATALOG,signal=null,timeoutMs=undefined}={}){
  const child=fakeChild(),muse=new FakeMuse(child,{handlers:turn?{"turn/start":(params,fake)=>turn(params,fake)}:{}}),hosts=[],spawned=[];
  const manager=museManager({catalog});
  const deps={museHost:options=>{hosts.push(options);return new MuseHost({...options,stopTree:fakeStop,spawnFn:(command,args,spawnOptions)=>{spawned.push({command,args,options:spawnOptions});return child}})}};
  const result=generateTextWithHarness({runtimeManager:manager,prompt:PROMPT,cwd:process.cwd(),models,version:"1.6.0",deps,signal,...(timeoutMs?{timeoutMs}:{})});
  result.catch(()=>{});
  return {result,muse,child,hosts,spawned,manager};
}
const turnEvents=(fake,params,...events)=>setImmediate(()=>{for(const [method,extra] of events)fake.notify(method,{sessionId:params.sessionId,...extra})});
const reply=(params,itemId,revision,text,extra={})=>({item:{itemId,kind:"agentMessage",turnId:params.commandId,revision,status:extra.status||"completed",text,...extra}});
const completed=(params,terminal="completed",extra={})=>["turn/completed",{turnId:params.commandId,terminal,...extra}];
// A reply that streams, then its final revision, then the turn's end.
const answers=text=>(params,fake)=>{
  turnEvents(fake,params,["item/updated",reply(params,"answer",1,"partial",{status:"inProgress"})],["item/completed",reply(params,"answer",2,text)],completed(params));
  return ACCEPTED(params);
};

test("Muse Code writes the Git text in a fresh session on a read-only host in an empty folder, its final reply read once at Low thinking",async()=>{
  const {result,muse,child,hosts,spawned}=await museText({turn:answers("feat: fix the login form")});
  const temp=await realpath(tmpdir());
  assert.deepEqual(await result,{text:"feat: fix the login form",model:"muse-wonder-1.0",runtime:"muse",name:"Muse Code"});
  // The host: Muse's own read-only serve, its session log kept (no --no-session-log), no workspace trust, hidden, in a temp folder.
  assert.deepEqual(hosts[0].args,["serve","--disable-shell","--disable-write"]);
  assert.equal(spawned.length,1);
  const folder=spawned[0].options.cwd;
  assert.notEqual(resolve(folder),resolve(process.cwd()),"never the repository");
  assert.equal(resolve(dirname(folder)),resolve(tmpdir()));assert.match(basename(folder),/^trebell-git-text-/);
  assert.equal(spawned[0].options.windowsHide,true);
  assert.equal("META_API_KEY" in spawned[0].options.env,false,"a key the profile did not approve never reaches Muse");
  assert.deepEqual(muse.sent("initialize")[0].params.capabilities,{requestedCapabilities:[]},"no session MCP servers");
  const [start]=muse.sent("session/start");
  assert.deepEqual({providerId:start.params.providerId,modelId:start.params.modelId,approvalMode:start.params.approvalMode},{providerId:"meta",modelId:"muse-wonder-1.0",approvalMode:"denyUnmatched"});
  assert.ok(start.params.sessionId,"a fresh session of Trebell's minting");
  assert.equal("permissionProfile" in start.params,false);
  const [turn]=muse.sent("turn/start");
  assert.equal(turn.params.sessionId,start.params.sessionId);
  assert.deepEqual(turn.params.input,[{type:"text",text:HARNESS_TEXT_INSTRUCTIONS+"\n\n"+PROMPT}],"one text part: Trebell's instructions, then the prompt");
  assert.equal(turn.params.reasoningEffort,"low");
  assert.equal("workspaceRoots" in turn.params,false);
  // Torn down: the host's input closed, its process ended, the folder removed.
  await until(()=>muse.stdinEnded&&child.exitCode!==null,"the host to close");
  await until(()=>!existsSync(folder),"the temp folder to be removed");
  // The session's folder is the temp folder as the disk spells it (Muse refuses a root whose case differs).
  assert.equal(start.params.workspaceRoot,join(temp,basename(folder)));
});

test("Muse Code's Git text runs on the thread's model when Muse lists it, else the list's default row, else Muse's own, at Low where the model offers it",async()=>{
  const cases=[
    {models:["gpt-5","muse-spark-1.3-contributor"],catalog:CATALOG,modelId:"muse-spark-1.3-contributor",effort:"low"},
    {models:["claude-opus","default"],catalog:CATALOG,modelId:"muse-spark-1.2",effort:"low"},
    {models:["muse-wonder-1.0"],catalog:null,modelId:undefined,effort:"low"},
    // A row that lists no Thinking levels gets none.
    {models:["silent"],catalog:{models:["silent"],metadata:[{id:"silent",reasoningEfforts:[],defaultReasoningEffort:null}],preferred:null},modelId:"silent",effort:undefined},
  ];
  for(const item of cases){
    const {result,muse}=await museText({turn:answers("chore: tidy"),models:item.models,catalog:item.catalog});
    const {model}=await result;
    assert.equal(muse.sent("session/start")[0].params.modelId,item.modelId,JSON.stringify(item.models));
    assert.equal(muse.sent("turn/start")[0].params.reasoningEffort,item.effort,JSON.stringify(item.models));
    assert.equal(model,item.modelId??null);
  }
});

test("Muse Code's Git text ignores the replies and the end of another turn",async()=>{
  const {result,muse}=await museText({turn:(params,fake)=>{
    turnEvents(fake,params,
      ["item/completed",{item:{itemId:"other-answer",kind:"agentMessage",turnId:"another-turn",revision:3,status:"completed",text:"Wrong subject"}}],
      ["turn/completed",{turnId:"another-turn",terminal:"completed"}],
      ["item/completed",{sessionId:"another-session",item:{itemId:"elsewhere",kind:"agentMessage",turnId:params.commandId,revision:9,status:"completed",text:"Another session's"}}],
      ["item/completed",reply(params,"commentary",1,"Reading the diff first.")],
      ["item/completed",reply(params,"answer",2,"fix: login form")],
      completed(params));
    return ACCEPTED(params);
  }});
  assert.equal((await result).text,"fix: login form","the turn's last reply, not another turn's or another session's");
  assert.equal(muse.sent("turn/start").length,1);
});

test("Muse Code's Git text refuses a reply Muse cut short, and never one it took back",async()=>{
  const truncated=await museText({turn:(params,fake)=>{turnEvents(fake,params,["item/completed",reply(params,"answer",2,"fix: incomplete answ",{truncated:true})],completed(params));return ACCEPTED(params)}});
  await assert.rejects(truncated.result,error=>error.code==="HARNESS_TEXT_FAILED"&&/^Muse Code could not write the Git text: Muse Code cut its reply short, so Trebell did not use it\. Try again\./.test(error.message));
  await until(()=>truncated.muse.stdinEnded,"the host to close");
  const retracted=await museText({turn:(params,fake)=>{turnEvents(fake,params,["item/completed",reply(params,"first",1,"fix: kept answer")],["item/completed",reply(params,"second",1,"withdrawn",{retracted:true})],completed(params));return ACCEPTED(params)}});
  assert.equal((await retracted.result).text,"fix: kept answer");
});

test("Muse Code's Git text settles once the turn ends, even when its start is never acknowledged",async()=>{
  const {result,muse}=await museText({turn:(params,fake)=>{turnEvents(fake,params,["item/completed",reply(params,"answer",2,"feat: settle without the ack")],completed(params));return undefined}});
  assert.equal((await result).text,"feat: settle without the ack");
  await until(()=>muse.stdinEnded,"the host to close");
});

test("Muse Code's Git text fails when Muse's connection closes or its host exits before the answer, naming why Muse exited",async()=>{
  const closing=await museText({turn:(params,fake)=>{setImmediate(()=>fake.child.stdout.end());return ACCEPTED(params)}});
  await assert.rejects(closing.result,/Muse Code could not write the Git text: Muse Code closed its connection to Trebell before it returned the Git text\. Try again\./);
  await until(()=>closing.muse.stdinEnded,"the host to close after its connection closed");
  const exiting=await museText({turn:(params,fake)=>{setImmediate(()=>{fake.child.stderr.write("panic: the model stream went away\n");setImmediate(()=>fake.child.exit(1))});return ACCEPTED(params)}});
  await assert.rejects(exiting.result,/Muse Code could not write the Git text: Muse Code exited unexpectedly \(code 1\): panic: the model stream went away/);
  // Its output ends first and the process a moment later, as a crashed Muse's do: the exit names the reason.
  const crashed=await museText({turn:(params,fake)=>{setImmediate(()=>{fake.child.stderr.write("panic: summarizer crashed\n");fake.child.stdout.end();setTimeout(()=>fake.child.exit(101),100)});return ACCEPTED(params)}});
  await assert.rejects(crashed.result,/Muse Code could not write the Git text: Muse Code exited unexpectedly \(code 101\): panic: summarizer crashed/);
  const gap=await museText({turn:(params,fake)=>{turnEvents(fake,params,["view/gap",{after:"v4:1",next:"v4:9"}]);return ACCEPTED(params)}});
  await assert.rejects(gap.result,/Muse Code dropped part of its reply before it reached Trebell\. Try again\./);
  await until(()=>gap.muse.stdinEnded,"the host to close after the gap");
});

test("Muse Code's Git text denies an approval with Muse's own denied choice and cancels a question, and each ends the request",async()=>{
  const choices=[{choiceId:"allow-1",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"deny-amend",label:"Reject always",decision:"deniedPolicyAmendment",scope:"localPersistent"},{choiceId:"deny-1",label:"Reject",decision:"denied",scope:"once"}];
  const approval=await museText({turn:(params,fake)=>{
    const request={sessionId:params.sessionId,approvalId:"approval-1",turnId:params.commandId,currentRequirementId:{approvalId:"approval-1",sourceIndex:0},availableChoices:choices,subject:{kind:"shell",command:"cat secrets.txt"}};
    setImmediate(()=>{fake.write({jsonrpc:"2.0",id:901,method:"approval/request",params:request});fake.notify("approval/requested",request)});
    return ACCEPTED(params);
  }});
  await assert.rejects(approval.result,/Muse Code could not write the Git text: Muse Code asked for permission \(cat secrets\.txt\) while writing the Git text, and Trebell declined it: Git text generation is read-only and tool-less\./);
  await until(()=>approval.muse.sent("approval/decide").length>0,"the denial");
  const decided=approval.muse.sent("approval/decide");
  assert.equal(decided.length,1,"one answer for the request and its notification");
  assert.deepEqual({approvalId:decided[0].params.approvalId,requirementId:decided[0].params.requirementId,choiceId:decided[0].params.choiceId},{approvalId:"approval-1",requirementId:{approvalId:"approval-1",sourceIndex:0},choiceId:"deny-1"},"the narrowest denied choice, never a rule");
  assert.deepEqual(approval.muse.frames.find(frame=>frame.id===901&&"result" in frame)?.result,{},"the server request gets its presentation receipt");
  await until(()=>approval.muse.stdinEnded,"the host to close");
  const question=await museText({turn:(params,fake)=>{setImmediate(()=>fake.notify("userInput/requested",{sessionId:params.sessionId,userInputId:"question-1",turnId:params.commandId,questions:[{id:"style",question:"Which style?",options:[{label:"Short"}],selection:{mode:"single"}}]}));return ACCEPTED(params)}});
  await assert.rejects(question.result,/Muse Code asked a question while writing the Git text, and Trebell cancelled it: Git text generation cannot ask the user\./);
  await until(()=>question.muse.sent("userInput/cancel").length>0,"the question's cancel");
  assert.equal(question.muse.sent("userInput/cancel")[0].params.userInputId,"question-1");
});

test("Muse Code's Git text never saves a rule that keeps a command out: with no plain Reject among Muse's choices it declines with Muse's abort",async()=>{
  const choices=[{choiceId:"allow-1",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"deny-amend",label:"Always reject in this workspace: cat ...",decision:"deniedPolicyAmendment",scope:"localPersistent"},{choiceId:"abort",label:"Reject",decision:"abort",scope:"once"}];
  const approval=await museText({turn:(params,fake)=>{
    const request={sessionId:params.sessionId,approvalId:"approval-1",turnId:params.commandId,currentRequirementId:{approvalId:"approval-1",sourceIndex:0},availableChoices:choices,subject:{kind:"shell",command:"cat secrets.txt"}};
    setImmediate(()=>fake.notify("approval/requested",request));
    return ACCEPTED(params);
  }});
  await assert.rejects(approval.result,/Trebell declined it: Git text generation is read-only and tool-less\./);
  await until(()=>approval.muse.sent("approval/decide").length>0,"the denial");
  assert.deepEqual(approval.muse.sent("approval/decide").map(frame=>frame.params.choiceId),["abort"]);
  await until(()=>approval.muse.stdinEnded,"the host to close");
});

test("Muse Code's Git text says Muse Code is signed out for a turn it could not run signed out, and gives Muse's own words for another failure",async()=>{
  const signedOut=await museText({turn:(params,fake)=>{turnEvents(fake,params,completed(params,"failed",{error:{kind:"authRequired",message:"not logged in: run /login to add an API key"}}));return ACCEPTED(params)}});
  await assert.rejects(signedOut.result,{message:"Muse Code could not write the Git text: Muse Code is signed out. Sign in with muse login, then try again."});
  assert.equal(signedOut.manager.calls.rechecks,1,"a failed request checks Muse Code again, as a failed turn does");
  const refused=await museText({turn:(params,fake)=>{turnEvents(fake,params,completed(params,"failed",{error:{kind:"modelError",message:"model muse-wonder-1.0 is not available on this plan"}}));return ACCEPTED(params)}});
  await assert.rejects(refused.result,/Muse Code could not write the Git text: model muse-wonder-1\.0 is not available on this plan/);
});

test("a Git text request stopped while Muse Code writes it closes Muse Code's host",async()=>{
  const controller=new AbortController();
  const {result,muse}=await museText({signal:controller.signal,turn:params=>{setImmediate(()=>controller.abort());return ACCEPTED(params)}});
  await assert.rejects(result,error=>error.code==="HARNESS_TEXT_CANCELLED");
  await until(()=>muse.stdinEnded,"the host to close");
});
