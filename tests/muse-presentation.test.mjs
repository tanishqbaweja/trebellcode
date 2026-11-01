import test from "node:test";
import assert from "node:assert/strict";
import { acpToolFrame } from "../src/acp-tool-state.mjs";
import { museCardButtons, museDecisionChoices, museDecisionToSend, museDialogQuestions } from "../src/muse-asking.mjs";
import { museLimitLiftsAt, museQuotaStop } from "../src/muse-quota.mjs";
import { museItemProgress, museItemRow, museLabel, museShowsNoRow, museTodoPlan, museWorkProgress, museWorkflowAgentRows } from "../src/muse-rows.mjs";

// The pure parts of Muse Code's presentation the session tests reach only in passing: how far an item got, which items show no row,
// the rows of a command's run record, an edit with no file and a fetch with nothing fetched, a workflow that names a child twice, the
// narrowest choice per decision, the question dialog's fallbacks, and the reset a quota refusal names.

// A tool call Muse completed, with the fields a case changes.
function toolCall(fields){return Object.assign({itemId:"row-1",kind:"toolCall",status:"completed"},fields)}

test("an item's progress: running, done, and failed for any other end; a compaction that did not compact failed, and so does nothing at all",()=>{
  assert.equal(museItemProgress({status:"inProgress"}),"in_progress");
  assert.equal(museItemProgress({status:"completed"}),"completed");
  for(const status of ["failed","cancelled","handedOff","timedOut","rejected",undefined])assert.equal(museItemProgress({status}),"failed",String(status));
  assert.equal(museItemProgress({kind:"compaction",status:"completed",outcome:"compacted"}),"completed");
  assert.equal(museItemProgress({kind:"compaction",status:"completed"}),"completed","no outcome named");
  assert.equal(museItemProgress({kind:"compaction",status:"completed",outcome:"noop"}),"failed");
  assert.equal(museItemProgress({kind:"toolCall",status:"completed",outcome:"noop"}),"completed","only a compaction has an outcome to miss");
  assert.equal(museItemProgress(),"failed");
  assert.equal(museWorkProgress({kind:"subagent",status:"inProgress",controlStatus:"resultReady"}),"completed");
  assert.equal(museWorkProgress({kind:"workflow",status:"inProgress",controlStatus:"resultReady"}),"in_progress","only a subagent's result ends it early");
});

test("items with no row: the person's message, reminder children and compactions, and the to-do, question and workflow calls unless they failed",()=>{
  for(const kind of ["userMessage","reminderChild","compaction"])assert.equal(museShowsNoRow({kind,status:"completed"}),true,kind);
  for(const tool of ["write_todos","request_user_input","workflow"]){
    assert.equal(museShowsNoRow(toolCall({tool})),true,tool);
    assert.equal(museShowsNoRow(toolCall({tool,status:"inProgress"})),true,tool+" running");
    assert.equal(museShowsNoRow(toolCall({tool,status:"failed"})),false,tool+" failed");
  }
  for(const item of [toolCall({tool:"bash"}),{kind:"agentMessage",status:"completed"},{kind:"workflow",status:"inProgress"},{kind:"userShell",status:"completed"}])assert.equal(museShowsNoRow(item),false,item.kind+" "+(item.tool||""));
});

test("a command's run record carries the failure before its output, a running command stays running, an edit with no file is a plain row and a fetch with nothing fetched has no results",()=>{
  const record=JSON.stringify({command:"npm test",exit_code:1,output:"1 failing\n"});
  const failed=museItemRow(toolCall({tool:"bash",status:"failed",failureReason:"The command failed.",args:JSON.stringify({command:"npm test"}),visibleOutput:record}));
  assert.deepEqual([failed.kind,failed.title,failed.status],["execute","npm test","failed"]);
  assert.deepEqual(failed.rawOutput,{command:"npm test",exit_code:1,output:"The command failed.\n1 failing\n"});
  assert.equal(acpToolFrame(failed).exitCode,1,"the record's exit code");
  const background=museItemRow(toolCall({tool:"exec_command",args:JSON.stringify({cmd:"npm run watch"}),visibleOutput:"watching"}),{running:true});
  assert.deepEqual([background.status,background.title,background.rawOutput],["in_progress","npm run watch","watching"]);
  const noFile=museItemRow(toolCall({tool:"edit_file",args:JSON.stringify({old_string:"a",new_string:"b"}),visibleOutput:"edited"}));
  assert.deepEqual([noFile.kind,noFile.title,noFile.rawOutput,noFile.content],["other","edit_file","edited",undefined]);
  const blank=museItemRow(toolCall({tool:"write_file",args:JSON.stringify({path:"   ",content:"x"})}));
  assert.equal(blank.kind,"other","a blank path names no file");
  const nothing=museItemRow(toolCall({tool:"web_fetch",args:JSON.stringify({url:" https://sqlite.org/ "}),visibleOutput:""}));
  assert.deepEqual([nothing.kind,nothing.title,nothing.rawOutput,nothing.content],["fetch","web_fetch: https://sqlite.org/",{query:"https://sqlite.org/",results:[]},[]]);
  const failedSearch=museItemRow(toolCall({tool:"web_search",status:"failed",failureReason:"offline",args:JSON.stringify({query:"wal"}),visibleOutput:JSON.stringify({results:[{url:"https://a"}]})}));
  assert.deepEqual(failedSearch.rawOutput,{query:"wal",results:[{snippet:"offline\n"+JSON.stringify({results:[{url:"https://a"}]})}]},"a failed search lists what it said, not hits");
  const patch=acpToolFrame(museItemRow(toolCall({tool:"apply_patch",args:JSON.stringify({path:"a.md",diff:"@@ -1 +1 @@"})})));
  assert.deepEqual([patch.kind,patch.locations,patch.changes],["edit",[{path:"a.md"}],[{path:"a.md",kind:"update",diff:"@@ -1 +1 @@"}]]);
});

test("labels are one line of at most 72 characters, and a workflow that names a child twice keeps its first place and its last entry",()=>{
  assert.equal(museLabel("  Review the parser\nthen the tests "),"Review the parser");
  assert.equal(museLabel("x".repeat(80)),"x".repeat(71)+"…");
  assert.equal(museLabel("y".repeat(72)),"y".repeat(72));
  assert.equal(museLabel(null),"");
  const workflow={itemId:"wf",kind:"workflow",status:"inProgress",entryId:"Checks",children:[{childId:"a",label:"first",status:"scheduled"},{childId:"b",label:"second",status:"started"},{childId:"a",status:"started",attempt:2}]};
  const rows=museWorkflowAgentRows(workflow);
  assert.deepEqual(rows.map(row=>[row.toolCallId,row.status,row.title,row.rawInput.attempt]),[["wf:agent:a","in_progress","Workflow Checks · agent 1",2],["wf:agent:b","in_progress","Workflow Checks · second",null]]);
  const done=museWorkflowAgentRows({...workflow,status:"completed"});
  assert.deepEqual(done.map(row=>row.status),["completed","completed"],"an agent with no end of its own ends as its workflow did");
  assert.deepEqual(museTodoPlan("not a list"),[]);
});

test("each decision keeps Muse's narrowest choice: a plain saved denial before a saved rule, approvedForSession before a session rule, the first at a tie",()=>{
  const saved=museDecisionChoices([{choiceId:"rule",decision:"deniedPolicyAmendment",scope:"localPersistent"},{choiceId:"plain",decision:"denied",scope:"localPersistent"}]);
  assert.equal(saved.get("declineAlways").choiceId,"plain");
  assert.equal(saved.has("decline"),false,"a saved denial is no plain Reject");
  const session=museDecisionChoices([{choiceId:"rule",decision:"approvedPolicyAmendment",scope:"session"},{choiceId:"grant",decision:"approvedForSession",scope:"session"}]);
  assert.equal(session.get("acceptForSession").choiceId,"grant");
  const tie=museDecisionChoices([{choiceId:"one",decision:"approved",scope:"once"},{choiceId:"two",decision:"approved",scope:"once"}]);
  assert.equal(tie.get("accept").choiceId,"one");
  assert.deepEqual([...museDecisionChoices([{choiceId:"",decision:"approved",scope:"once"},{decision:"denied",scope:"once"},null]).keys()],[],"a choice needs its id");
  assert.deepEqual(museCardButtons([{choiceId:"x",decision:"abort",scope:"once"}]),[{decision:"decline",label:"decline"}],"an abort alone is the Reject, under its decision when it has no words");
  assert.equal(museDecisionToSend("cancel",museDecisionChoices([{choiceId:"n",decision:"denied",scope:"once"}])),"decline","a stop with no abort to send declines");
  assert.equal(museDecisionToSend("cancel",museDecisionChoices([{choiceId:"x",decision:"abort",scope:"once"}])),"cancel");
  assert.equal(museDecisionToSend("allowEverything",new Map()),"decline","a decision Trebell does not know declines");
});

test("the question dialog's header, question and options: Question by default, the header or a stand-in for a missing question, and what an answer lacked beside it",()=>{
  const asked=museDialogQuestions([
    {id:"a",question:"  Which file? ",options:[{label:"one.md",description:"the first"},{label:""},{description:"no label"},{label:"two.md",description:7}]},
    {id:"b",header:" Scope "},
    {id:"c"},
    {header:"no id"},
  ],{a:"Choose one option."});
  assert.deepEqual(asked,[
    {id:"a",header:"Question",question:"Which file? (Choose one option.)",multiSelect:false,allowCustomAnswer:true,options:[{label:"one.md",description:"the first"},{label:"two.md",description:"7"}]},
    {id:"b",header:"Scope",question:"Scope",multiSelect:false,allowCustomAnswer:true,options:[]},
    {id:"c",header:"Question",question:"Muse Code asks a question.",multiSelect:false,allowCustomAnswer:true,options:[]},
  ]);
});

test("the reset a quota refusal names: in any case, with a fraction and an offset, the first one that is a whole time, and never inside another word",()=>{
  const now=Date.parse("2026-11-01T00:00:00Z");
  assert.equal(museLimitLiftsAt(undefined,now,{message:"429: quota spent; RESETS AT 2026-11-03T06:30:00.250+05:30."}),"2026-11-03T01:00:00.250Z");
  assert.equal(museLimitLiftsAt(undefined,now,{message:"resets at noon, or rather resets at 2026-11-02T10:00:00Z"}),"2026-11-02T10:00:00.000Z");
  assert.equal(museLimitLiftsAt(undefined,now,{message:"presets at 2026-11-02T10:00:00Z"}),null);
  assert.equal(museLimitLiftsAt(undefined,now,{message:"resets at 2026-11-02T10:00:00"}),null,"a time with no zone");
  assert.equal(museLimitLiftsAt(undefined,now,{quota:{resetsAtMs:now+60_000},message:"resets at 2026-11-02T10:00:00Z"}),"2026-11-02T10:00:00.000Z","the later of the quota's and the named one");
  assert.equal(museQuotaStop({},"HTTP 429 USAGE LIMIT reached"),true);
  assert.equal(museQuotaStop({},"HTTP 4290 quota"),false,"429 as a number of its own");
});
