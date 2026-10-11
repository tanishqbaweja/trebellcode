import test from "node:test";
import assert from "node:assert/strict";
import { RESTORED_LIST_LIMIT, RESTORED_TEXT_LIMIT, activityRow, isCardItem, mergeLiveRow, restoredRow, settledRow } from "../ui/src/activity-item.js";
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
