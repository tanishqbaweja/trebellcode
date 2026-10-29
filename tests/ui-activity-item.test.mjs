import test from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { RESTORED_LIST_LIMIT, RESTORED_TEXT_LIMIT, RETRY_RECOVERED_TITLE, RETRY_STOPPED_TITLE, activityRow, isCardItem, mergeLiveRow, restoredRow, retryActivityRow, retryRowId, settledRetryRows, settledRow } from "../ui/src/activity-item.js";
import { codexErrorNotice } from "../ui/src/codex-turn-options.js";
import { toolEventFailed } from "../ui/src/tool-event-status.js";
import { cardRowsFromItemEntries } from "../ui/src/turn-activity.js";
import { activityItemStatus } from "../ui/src/activity-details.js";
import { dynamicToolLabel } from "../ui/src/tool-activity.js";

// App's normalizeItem as it was before rows moved to activity-item.js: every title must read the same.
function previousNormalizeItem(item={}){
  const type=item.type||"tool";
  let title=item.title||item.name||item.description||"Agent activity";
  if(type==="plan")title="Plan";
  if(type==="commandExecution")title=Array.isArray(item.command)?item.command.join(" "):(item.command||"Running command");
  if(type==="fileChange")title="Editing files";
  if(type==="mcpToolCall")title=(item.server?item.server+" / ":"")+(item.tool||item.name||"MCP tool");
  if(type==="dynamicToolCall")title=item.namespace&&item.namespace!=="agent"?dynamicToolLabel(item)||item.namespace+" / "+(item.tool||"Dynamic tool"):item.tool||"Dynamic tool";
  if(type==="collabAgentToolCall")title="Collaboration · "+String(item.tool||"agent task").replace(/([a-z])([A-Z])/g,"$1 $2").toLowerCase();
  if(type==="subAgentActivity")title="Subagent · "+(item.kind||"activity");
  if(type==="webSearch")title=item.query||"Searching the web";
  if(type==="reasoning")title="Reasoning";
  if(type==="imageView")title="Viewing image";
  if(type==="imageGeneration")title="Generating image";
  if(type==="contextCompaction")title="Compacting context";
  if(type==="enteredReviewMode")title="Reviewing changes";
  if(type==="exitedReviewMode")title="Finished review";
  const output=type==="commandExecution"?String(item.aggregatedOutput??item.output??""):"";
  return {id:item.id||"generated",kind:type,title:String(title).split("\n")[0].slice(0,160),status:activityItemStatus(item),raw:item,output};
}

const ITEMS=[
  {id:"plan",type:"plan"},
  {id:"cmd-array",type:"commandExecution",command:["npm","test"],status:"completed",aggregatedOutput:"ok",exitCode:0},
  {id:"cmd-text",type:"commandExecution",command:"npm run build\nsecond line",status:"inProgress"},
  {id:"cmd-none",type:"commandExecution",status:"inProgress",output:"streamed"},
  {id:"change",type:"fileChange",changes:[{path:"a.js",kind:"update"}],status:"completed"},
  {id:"mcp",type:"mcpToolCall",server:"browser",tool:"navigate",status:"completed"},
  {id:"mcp-bare",type:"mcpToolCall",name:"lookup",status:"completed"},
  {id:"native-read",type:"dynamicToolCall",namespace:"trebell_workspace",tool:"read_file",arguments:{path:"src/app.js"},status:"completed"},
  {id:"native-other",type:"dynamicToolCall",namespace:"trebell_browser",tool:"snapshot",arguments:{},status:"completed"},
  {id:"agent-tool",type:"dynamicToolCall",namespace:"agent",tool:"Read README.md",status:"completed"},
  {id:"bare-tool",type:"dynamicToolCall",status:"completed"},
  {id:"collab",type:"collabAgentToolCall",tool:"spawnAgent",status:"completed"},
  {id:"sub",type:"subAgentActivity",kind:"explore",status:"completed"},
  {id:"web",type:"webSearch",query:"trebell cards",status:"completed"},
  {id:"web-bare",type:"webSearch",status:"completed"},
  {id:"thought",type:"reasoning"},
  {id:"image",type:"imageView"},
  {id:"generate",type:"imageGeneration"},
  {id:"compact",type:"contextCompaction"},
  {id:"review-in",type:"enteredReviewMode"},
  {id:"review-out",type:"exitedReviewMode"},
  {id:"titled",type:"customThing",title:"A ".repeat(120)},
  {id:"untyped",name:"Something"},
];

test("a row reads as the conversation always named its step, tagged with its turn",()=>{
  for(const item of ITEMS){
    const row=activityRow(item,{turnId:"turn-1"}),before=previousNormalizeItem(item);
    assert.deepEqual({id:row.id,kind:row.kind,title:row.title,status:row.status,raw:row.raw,output:row.output},before,item.id);
    assert.equal(row.turnId,"turn-1");assert.equal(row.fromItem,true);
  }
  assert.equal(activityRow({id:"x",type:"plan"}).turnId,null);
  assert.equal(activityRow({id:"x",type:"plan"},{turnId:7}).turnId,"7");
  // A live item without an id still gets one, as before.
  assert.ok(activityRow({type:"commandExecution",command:"ls"}).id);
});

test("a command that exited non-zero reads failed whichever harness ran it",()=>{
  assert.equal(activityRow({id:"c",type:"commandExecution",command:"npm test",status:"completed",exitCode:1}).status,"failed");
  assert.equal(activityRow({id:"c",type:"commandExecution",command:"npm test",status:"completed",exitCode:"2"}).status,"failed");
  assert.equal(activityRow({id:"c",type:"commandExecution",command:"npm test",status:"completed",exitCode:0}).status,"done");
  assert.equal(activityRow({id:"c",type:"commandExecution",command:"npm test",status:"declined"}).status,"declined");
});

test("only steps make a card: messages and thoughts are the conversation's own rows",()=>{
  for(const type of ["userMessage","agentMessage","reasoning","sessionHandoff"])assert.equal(isCardItem({id:"m",type}),false,type);
  for(const type of ["commandExecution","fileChange","mcpToolCall","dynamicToolCall","webSearch","imageView","contextCompaction"])assert.equal(isCardItem({id:"s",type}),true,type);
  assert.equal(isCardItem(null),false);assert.equal(isCardItem(undefined),false);
});

test("a step of an ended turn is not running any more; other statuses stay",()=>{
  const running=activityRow({id:"s",type:"dynamicToolCall",namespace:"agent",tool:"Subtask"});
  assert.equal(running.status,"running");
  assert.equal(settledRow(running).status,"done");
  assert.equal(settledRow(activityRow({id:"s",type:"commandExecution",command:"x",status:"inProgress"})).status,"done");
  for(const status of ["done","failed","declined","error"]){const row={id:"s",status};assert.equal(settledRow(row),row)}
  assert.equal(settledRow(null),null);
});

test("a compaction reads compacting while it runs and compacted once done, also from a stored item with no status",()=>{
  assert.equal(activityRow({id:"k",type:"contextCompaction"}).title,"Compacting context");
  assert.equal(activityRow({id:"k",type:"contextCompaction",status:"inProgress"}).title,"Compacting context");
  assert.equal(activityRow({id:"k",type:"contextCompaction",status:"completed"}).title,"Context compacted");
  // Codex stores the item with no status, and only once it compacted: read from the history of a turn that ended, it reads
  // done and compacted.
  const [stored]=cardRowsFromItemEntries([{turnId:"t1",item:{id:"k",type:"contextCompaction"}}]).t1;
  assert.deepEqual({status:stored.status,title:stored.title},{status:"done",title:"Context compacted"});
  // A live compaction still running when its turn ended (stopped, or failed) did not compact: settled, it reads done but not
  // compacted.
  const cut=activityRow({id:"k",type:"contextCompaction",status:"inProgress"},{turnId:"t1"});
  assert.deepEqual(settledRow(cut),{...cut,status:"done",title:"Compacting context"});
});

test("a kept row holds bounded text: a command's output its end, other text its start, lists their first entries",()=>{
  const long="x".repeat(RESTORED_TEXT_LIMIT)+"TAIL",row=activityRow({id:"c",type:"commandExecution",command:"build",status:"completed",aggregatedOutput:"HEAD"+long,exitCode:0});
  const kept=restoredRow(row);
  assert.ok(kept.output.startsWith("… 8 earlier characters not shown\n"));assert.ok(kept.output.endsWith("TAIL"));
  assert.equal(kept.output.split("\n")[1].length,RESTORED_TEXT_LIMIT);
  assert.match(kept.raw.aggregatedOutput,/^HEADx+\n… 8 more characters$/);
  const listed=restoredRow(activityRow({id:"f",type:"fileChange",changes:Array.from({length:RESTORED_LIST_LIMIT+5},(_,index)=>({path:"f"+index,diff:index===0?"d".repeat(RESTORED_TEXT_LIMIT+1):"+a"}))}));
  assert.equal(listed.raw.changes.length,RESTORED_LIST_LIMIT);assert.match(listed.raw.changes[0].diff,/\n… 1 more characters$/);assert.equal(listed.raw.changes[1].diff,"+a");
  // Nothing to cut: the same row.
  const small=activityRow({id:"s",type:"commandExecution",command:"ls",status:"completed",aggregatedOutput:"a b"});
  assert.equal(restoredRow(small),small);
});

test("a row kept again reads as it was kept: each cut says how much it left out once",()=>{
  // A sealed card's row sealed again, or a turn's ended diff kept and then put on the turn's card, is kept twice.
  const command=activityRow({id:"c",type:"commandExecution",command:"build",status:"completed",aggregatedOutput:"HEAD"+"x".repeat(RESTORED_TEXT_LIMIT)+"TAIL",exitCode:0});
  const diff={id:"diff-t1",kind:"fileChange",title:"Workspace diff updated",status:"done",raw:"diff --git a/app.js b/app.js\n"+"+line\n".repeat(5000),turnId:"t1"};
  const tool=activityRow({id:"s",type:"dynamicToolCall",namespace:"trebell_repo",tool:"search_code",status:"completed",rawOutput:"HEAD"+"y".repeat(RESTORED_TEXT_LIMIT)+"TAIL"});
  for(const row of [command,diff,tool]){const kept=restoredRow(row);assert.notEqual(kept,row);assert.equal(restoredRow(kept),kept,row.id+" kept again")}
  assert.ok(restoredRow(command).output.startsWith("… 8 earlier characters not shown\n"));
  assert.match(restoredRow(diff).raw,new RegExp("\\n… "+(diff.raw.length-RESTORED_TEXT_LIMIT).toLocaleString("en-US")+" more characters$"));
  assert.ok(restoredRow(tool).output.endsWith("\n… 8 more characters"));
});

test("a kept row lets go of the long text it was cut from, holding only its cut",()=>{
  v8.setFlagsFromString("--expose-gc");const gc=vm.runInNewContext("gc");
  const heap=()=>{gc();gc();return process.memoryUsage().heapUsed};
  // A diff as a turn/diff/updated notification brings it: parsed from the frame, about 8 MB each.
  const diffOf=index=>JSON.parse(JSON.stringify({diff:`diff --git a/lock${index} b/lock${index}\n`+`+line ${index} of a long lockfile diff\n`.repeat(250_000)})).diff;
  const before=heap(),kept=[];
  for(let index=0;index<8;index++)kept.push(restoredRow({id:"diff-"+index,kind:"fileChange",title:"Workspace diff updated",status:"done",raw:diffOf(index),turnId:"t"+index}));
  const grown=heap()-before;
  assert.ok(kept.every(row=>row.raw.length<RESTORED_TEXT_LIMIT+40));
  assert.ok(grown<24*1024*1024,`8 kept diff rows hold ${Math.round(grown/1024/1024)} MB after a full collection`);
});

test("a Trebell tool that answered with text shows that text as its output, and a kept row keeps the text's start",()=>{
  const text="2 matches in 1 file (path: src, glob: *.js)\nsrc/auth/session.js\n  1: import { rotateRefreshToken } from \"./token.js\";\n  3:   refresh(token) { return rotateRefreshToken(token); }";
  const search={id:"native-search",type:"dynamicToolCall",namespace:"trebell_repo",tool:"search_code",arguments:{query:"rotateRefreshToken",path:"src",glob:"*.js"},status:"completed",success:true,contentItems:[{type:"inputText",text}],rawOutput:text};
  const row=activityRow(search,{turnId:"t1"});
  assert.equal(row.title,"Searched rotateRefreshToken in src");
  assert.equal(row.output,text,"the expanded row shows the grouped lines as written, not inside the item's JSON");
  assert.equal(restoredRow(row),row);
  // A result object keeps the JSON view, and another harness's tool keeps its own rendering.
  assert.equal(activityRow({...search,rawOutput:{query:"x",data:[]}}).output,"");
  assert.equal(activityRow({...search,namespace:"agent",tool:"Grep"}).output,"");
  // Text that is not a command's output keeps its start when the row is kept, where a search's counts and first hits are.
  const long=activityRow({...search,rawOutput:"HEAD"+"y".repeat(RESTORED_TEXT_LIMIT)+"TAIL"});
  const kept=restoredRow(long);
  assert.ok(kept.output.startsWith("HEAD"));assert.ok(kept.output.endsWith("\n… 8 more characters"));
  assert.equal(kept.output.split("\n")[0].length,RESTORED_TEXT_LIMIT);
});

test("a harness's tool whose item says its output is text (an OpenCode read) shows that text, and other harnesses' tools keep the item's JSON",()=>{
  const read={id:"oc-read",type:"dynamicToolCall",namespace:"agent",tool:"Read notes.txt",arguments:{filePath:"/repo/notes.txt"},status:"completed",contentItems:null,success:true,durationMs:null,locations:[],rawOutput:"1: alpha line\n2: beta line",textOutput:true};
  const row=activityRow(read,{turnId:"t1"});
  assert.equal(row.title,"Read notes.txt");
  assert.equal(row.output,"1: alpha line\n2: beta line","the expanded row shows the lines as written, not inside the item's JSON");
  assert.equal(activityRow({...read,textOutput:undefined}).output,"");
  assert.equal(activityRow({...read,rawOutput:{lines:2}}).output,"");
});

test("live rows merge the same way in the list and in the record a card is sealed from",()=>{
  const started=activityRow({id:"c",type:"commandExecution",command:"npm test",status:"inProgress"},{turnId:"t1"});
  assert.equal(mergeLiveRow(null,started,{phase:"started"}),started);
  assert.equal(mergeLiveRow({id:"c",title:"old"},started,{phase:"started"}),started);
  // A progress update that changes nothing shown keeps the row itself, so nothing re-renders.
  const same=activityRow({id:"c",type:"commandExecution",command:"npm test",status:"inProgress",aggregatedOutput:"more"},{turnId:"t1"});
  assert.equal(mergeLiveRow(started,same,{phase:"progress"}),started);
  const renamed=activityRow({id:"c",type:"commandExecution",command:"npm test -- --watch",status:"inProgress"},{turnId:"t1"});
  const withOutput={...started,output:"line one\n"};
  assert.deepEqual(mergeLiveRow(withOutput,renamed,{phase:"progress"}),{...withOutput,...renamed,output:"line one\n"});
  assert.equal(mergeLiveRow(null,renamed,{phase:"progress"}),renamed);
  // Completion: the item's output, else what streamed for it, else what the row held.
  const done=activityRow({id:"c",type:"commandExecution",command:"npm test",status:"completed",exitCode:0},{turnId:"t1"});
  assert.equal(mergeLiveRow(withOutput,done,{phase:"completed",streamed:"all of it\n"}).output,"all of it\n");
  assert.equal(mergeLiveRow(withOutput,done,{phase:"completed"}).output,"line one\n");
  assert.equal(mergeLiveRow(withOutput,{...done,output:"final"},{phase:"completed",streamed:"streamed"}).output,"final");
  assert.equal(mergeLiveRow(withOutput,done,{phase:"completed"}).status,"done");
  assert.deepEqual(mergeLiveRow(null,done,{phase:"completed",streamed:"s"}),{...done,output:"s"});
  assert.equal(mergeLiveRow(undefined,done,{phase:"completed"}).output,"");
});

test("a harness's own retry is one running row per turn, not a failed step, and it settles once the turn goes on or ends",()=>{
  // Native waiting for the network, and Codex reconnecting its stream, as their `error` notifications with willRetry read.
  const native=codexErrorNotice({threadId:"th",turnId:"t1",willRetry:true,error:{message:"Waiting for the network (getaddrinfo ENOTFOUND api.openai.com). Trying again in 15 s."}});
  const row=retryActivityRow(native,{turnId:"t1",threadId:"th",raw:{turnId:"t1"}});
  assert.deepEqual(row,{id:"retry-t1",kind:"retry",title:"Retrying: Waiting for the network (getaddrinfo ENOTFOUND api.openai.com). Trying again in 15 s.",status:"running",output:"Waiting for the network (getaddrinfo ENOTFOUND api.openai.com). Trying again in 15 s.",raw:{turnId:"t1"},turnId:"t1"});
  assert.equal(toolEventFailed(row),false);
  const codex=retryActivityRow(codexErrorNotice({willRetry:true,error:{message:"Reconnecting... 2/5"}}),{turnId:7});
  assert.equal(codex.title,"Retrying (2/5): Reconnecting... 2/5");assert.equal(codex.turnId,"7");assert.equal(codex.id,"retry-7");
  // A notice with no turn is the thread's.
  assert.equal(retryRowId(null,"th"),"retry-th");assert.equal(retryActivityRow({},{threadId:"th"}).title,"Retrying");
  const other={...row,id:"retry-t0",turnId:"t0"},step={id:"c",kind:"commandExecution",status:"running",turnId:"t1"};
  const rows=[other,row,step];
  // The turn went on: its retry row says the request got through and keeps the last retry's text; other turns' rows and steps stay.
  const recovered=settledRetryRows(rows,{turnId:"t1",outcome:"recovered"});
  assert.deepEqual(recovered[1],{...row,status:"done",title:RETRY_RECOVERED_TITLE});
  assert.equal(recovered[0],other);assert.equal(recovered[2],step);
  // A turn that ended while it still retried (stopped, or failed) says it stopped.
  assert.deepEqual(settledRetryRows(rows,{turnId:"t1",outcome:"stopped"})[1],{...row,status:"stopped",title:RETRY_STOPPED_TITLE});
  assert.equal(toolEventFailed(settledRetryRows(rows,{turnId:"t1",outcome:"stopped"})[1]),false);
  // Nothing to settle is the same list, so nothing re-renders: no retry row of the turn, or one settled already.
  assert.equal(settledRetryRows(rows,{turnId:"t9"}),rows);
  assert.equal(settledRetryRows(recovered,{turnId:"t1",outcome:"stopped"}),recovered);
  const steps=[step];assert.equal(settledRetryRows(steps),steps);
});
