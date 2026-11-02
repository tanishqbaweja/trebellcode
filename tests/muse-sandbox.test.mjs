import test from "node:test";
import assert from "node:assert/strict";
import { acpToolFrame } from "../src/acp-tool-state.mjs";
import { museHostCannotSandbox, museLaunchPlan } from "../src/muse-host.mjs";
import { MUSE_SANDBOX_UNAVAILABLE_CARD, museApprovalCard } from "../src/muse-agent-session.mjs";
import { MUSE_SANDBOX_REFUSED_COMMAND, museItemRow } from "../src/muse-rows.mjs";
import { FakeMuse, INIT, startSession, until } from "./fixtures/muse/fake-host.mjs";

// Muse Code's host saying it cannot use its sandbox. Muse Code 1.4.13's `muse serve` answers initialize with sandboxAvailability
// "unavailable" on Windows (the recorded fixtures/muse/initialize-1.4.13.json, and every host started on 2026-11-02 the way Trebell
// starts it, though `muse sandbox windows check` reported the sandbox ready), and then never starts a command, one the person allowed
// too. Trebell says so on the command's card before the person answers, and on its row in its own words when it fails.

// Muse's words for the command it never started: its own shell's (the 2026-11-02 live run's session log) and the person's.
const TOOL_REFUSAL="tool failed: environment failure: sandbox enforcement unavailable: windows_elevated setup_required: windows elevated sandbox setup has not run\nThe execution environment is broken: the command was never started and every later command will fail the same way. Do not retry and do not fabricate command output; report this environment failure.";
const SHELL_REFUSAL="tool failed: environment failure: managed shell sandbox is unavailable\nThe execution environment is broken: the command was never started and every later command will fail the same way. Do not retry and do not fabricate command output; report this environment failure.";
const CHOICES=[{choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"abort",label:"Reject",decision:"abort",scope:"once",acceptsFeedback:true}];
const shellApproval=(sessionId,turnId,extra={})=>({sessionId,approvalId:"ap-1",turnId,taskId:"ap-1",itemId:"ap-1",toolCallId:"call_ap-1",toolName:"powershell",rawArgs:JSON.stringify({command:"node parse-kv.js sample.env"}),viewCursor:"v",sourceRange:{},
  subject:{kind:"shell",command:"node parse-kv.js sample.env",workspaceRoot:"\\\\?\\H:\\repo",stages:[]},currentRequirementId:{approvalId:"ap-1",sourceIndex:0},availableChoices:CHOICES,protectedWrite:false,judgeEscalated:false,...extra});

test("a host cannot run its commands when its initialize says its sandbox is unavailable and it launched with its shell and its sandbox: Supervised, Auto-accept edits and Auto, not Full access or Read only",()=>{
  assert.equal(INIT.sandboxAvailability,"unavailable","Muse Code 1.4.13's recorded answer on Windows");
  const expected={supervised:true,edits:true,auto:true,full:false,"read-only":false};
  for(const [mode,cannot] of Object.entries(expected))assert.equal(museHostCannotSandbox(INIT,museLaunchPlan(mode).args),cannot,mode);
  const supervised=museLaunchPlan("supervised").args;
  assert.equal(museHostCannotSandbox({...INIT,sandboxAvailability:"available"},supervised),false);
  assert.equal(museHostCannotSandbox({serverInfo:INIT.serverInfo},supervised),false,"a host older than the field is taken as able to");
  assert.equal(museHostCannotSandbox({...INIT,sandboxAvailability:"degraded"},supervised),false,"only unavailable says it cannot");
  for(const answer of [null,undefined,"unavailable"])assert.equal(museHostCannotSandbox(answer,supervised),false,String(answer));
  assert.equal(museHostCannotSandbox(INIT,undefined),true,"no flags: the host keeps its shell and its sandbox");
});

test("a command's card says before the person answers that allowing it will not run it and what will, with the command and its stage still shown, and the notification says what is asked; other approvals and a host that can use its sandbox read as before",()=>{
  const card=(extra={},options={})=>museApprovalCard({...shellApproval("s-1","t-1"),...extra},{sandboxUnavailable:true,...options});
  assert.deepEqual(card(),{reason:MUSE_SANDBOX_UNAVAILABLE_CARD,command:"node parse-kv.js sample.env",notice:"node parse-kv.js sample.env"});
  assert.match(MUSE_SANDBOX_UNAVAILABLE_CARD,/fail even if you allow it.*switch this task to Full access/);
  assert.doesNotMatch(MUSE_SANDBOX_UNAVAILABLE_CARD+MUSE_SANDBOX_REFUSED_COMMAND,/\u2014|windows_elevated|setup_required/,"plain words, no em dash and none of Muse's own");
  const stage=(index,argv)=>({requirementId:{approvalId:"ap-1",sourceIndex:index},position:index+1,totalStages:2,argv,argvComplete:true,resolution:{kind:"unresolved"}});
  const staged={subject:{kind:"shell",command:"npm ci && npm test",stages:[stage(0,["npm","ci"]),stage(1,["npm","test"])]},currentRequirementId:{approvalId:"ap-1",sourceIndex:1}};
  assert.deepEqual(card(staged),{reason:`Stage 2 of 2: npm test ${MUSE_SANDBOX_UNAVAILABLE_CARD}`,command:"npm ci && npm test",notice:"Stage 2 of 2: npm test"});
  const origin={subagentOrigin:{subagentId:"a7",childRunId:"child-run-1",childSessionId:"child-session"}};
  assert.deepEqual(card(origin,{agent:"subagent counter"}),{reason:`Asked by the subagent counter. ${MUSE_SANDBOX_UNAVAILABLE_CARD}`,command:"node parse-kv.js sample.env",notice:"node parse-kv.js sample.env"});
  // A file access or network approval runs nothing in the sandbox, and a host that can use it asks as before.
  assert.deepEqual(card({subject:{kind:"fileAccess",access:"write",path:"src/app.js"},toolName:"write_file"}),{title:"File write needs approval",reason:"src/app.js"});
  assert.deepEqual(card({subject:{kind:"network",host:"example.com",port:443}}),{title:"Network access needs approval",reason:"example.com"});
  assert.deepEqual(card({},{sandboxUnavailable:false}),{reason:"node parse-kv.js sample.env"});
  assert.deepEqual(museApprovalCard(shellApproval("s-1","t-1")),{reason:"node parse-kv.js sample.env"},"no host report given");
});

test("a command Muse never started because its host cannot use its sandbox says so on its row in Trebell's words, its own shell's and the person's alike; any other failed or finished command keeps Muse's",()=>{
  const call=fields=>museItemRow({itemId:"row-1",kind:"toolCall",tool:"powershell",args:JSON.stringify({command:"node parse-kv.js sample.env",description:"Run it"}),...fields});
  const refused=call({status:"failed",visibleOutput:TOOL_REFUSAL});
  assert.deepEqual([refused.kind,refused.title,refused.status,refused.rawOutput],["execute","node parse-kv.js sample.env","failed",MUSE_SANDBOX_REFUSED_COMMAND]);
  assert.equal(acpToolFrame(refused).rawOutput,MUSE_SANDBOX_REFUSED_COMMAND);
  assert.equal(call({status:"failed",failureReason:"environment failure: sandbox enforcement unavailable: windows_elevated setup_required: windows elevated sandbox setup has not run"}).rawOutput,MUSE_SANDBOX_REFUSED_COMMAND,"Muse's reason alone");
  const shell=museItemRow({itemId:"shell-1",kind:"userShell",status:"failed",commandText:"echo trebell-probe",visibleOutput:SHELL_REFUSAL,turnId:null});
  assert.deepEqual([shell.kind,shell.title,shell.rawOutput],["execute","echo trebell-probe",MUSE_SANDBOX_REFUSED_COMMAND]);
  // A command that ran and failed, or whose output only mentions the sandbox, keeps what Muse said; so does one that finished.
  const record=JSON.stringify({command:"grep sandbox log.txt",exit_code:1,output:"sandbox enforcement unavailable: seen in the log\n"});
  assert.deepEqual(call({status:"failed",failureReason:"The command failed.",visibleOutput:record}).rawOutput,{command:"grep sandbox log.txt",exit_code:1,output:"The command failed.\nsandbox enforcement unavailable: seen in the log\n"});
  assert.equal(call({status:"completed",visibleOutput:TOOL_REFUSAL}).rawOutput,TOOL_REFUSAL,"only a failed command was refused");
  assert.equal(call({status:"failed",visibleOutput:"exit code 1"}).rawOutput,"Muse Code reported failed.\nexit code 1");
});

test("a Supervised session on a host that says it cannot use its sandbox asks for its command with that said on the card, sends the person's Allow once, and shows the command Muse never started as failed in Trebell's words; Full access on the same host and a host that can use its sandbox say nothing",async()=>{
  const recorded=child=>new FakeMuse(child,{handlers:{initialize:()=>INIT}});
  const fixture=await startSession({muse:recorded,approve:()=>"accept"});
  assert.equal(fixture.session.sandboxUnavailable,true);
  const running=fixture.session.prompt([{type:"text",text:"run the parser"}]);
  const {params:{commandId:turnId}}=await fixture.muse.next("turn/start");
  const sid=fixture.session.sessionId;
  fixture.muse.notify("approval/requested",shellApproval(sid,turnId));
  assert.equal((await fixture.muse.next("approval/decide")).params.choiceId,"allow_once","the person's answer still reaches Muse");
  assert.deepEqual(fixture.asks[0].request.card,{reason:MUSE_SANDBOX_UNAVAILABLE_CARD,command:"node parse-kv.js sample.env",notice:"node parse-kv.js sample.env"});
  const item=(revision,status,extra={})=>({itemId:"call-1",kind:"toolCall",turnId,revision,status,tool:"powershell",args:JSON.stringify({command:"node parse-kv.js sample.env"}),...extra});
  fixture.muse.notify("item/started",{sessionId:sid,viewCursor:"v",item:item(1,"inProgress")});
  fixture.muse.notify("item/completed",{sessionId:sid,viewCursor:"v",item:item(2,"failed",{visibleOutput:TOOL_REFUSAL})});
  await until(()=>fixture.updates.some(update=>update.toolCallId==="call-1"&&update.status==="failed"),"the failed row");
  const row=fixture.updates.filter(update=>update.toolCallId==="call-1").at(-1);
  assert.deepEqual([row.sessionUpdate,row.title,row.rawOutput],["tool_call_update","node parse-kv.js sample.env",MUSE_SANDBOX_REFUSED_COMMAND]);
  fixture.muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId});
  await running;await fixture.session.close();
  for(const [label,options] of [["Full access",{muse:recorded,permissionMode:"full"}],["Read only",{muse:recorded,permissionMode:"read-only"}],["a host that can",{}]]){
    const other=await startSession(options);
    assert.equal(other.session.sandboxUnavailable,false,label);
    await other.session.close();
  }
});
