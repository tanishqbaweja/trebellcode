import test from "node:test";
import assert from "node:assert/strict";
import { claudeMessagesToTurns, importClaudeHistory } from "../src/agent-history-import.mjs";

// A Claude Code session read back for import: its latest turns, as Claude resumes it, not its opening ones. getSessionMessages is
// answered as the Claude Agent SDK (0.3.276) answers it: the session's user and assistant messages in order, tool calls and tool
// results among them, cut from the start by offset and then limit.
function sessionMessagesFn(messages){
  const calls=[];
  const read=async(sessionId,options={})=>{
    calls.push({sessionId,options});
    const offset=options.offset??0;
    if(options.limit!==undefined&&options.limit>0)return messages.slice(offset,offset+options.limit);
    return offset>0?messages.slice(offset):messages;
  };
  return Object.assign(read,{calls});
}
const user=(uuid,content,extra={})=>({type:"user",uuid,session_id:"session-1",parent_tool_use_id:null,message:{role:"user",content},...extra});
const assistant=(uuid,content)=>({type:"assistant",uuid,session_id:"session-1",parent_tool_use_id:null,message:{role:"assistant",content}});
const toolUse=(id,command)=>({type:"tool_use",id,name:"Bash",input:{command}});
const toolResult=id=>[{type:"tool_result",tool_use_id:id,content:"ok"}];
// requests turns of 8 messages each: the request, three tool calls with their results (the first after a line of text), the answer.
function longSession(requests){
  const messages=[];
  for(let n=1;n<=requests;n++){
    messages.push(user("u"+n,"Request "+n));
    for(let step=1;step<=3;step++){
      const id=`toolu_${n}_${step}`;
      messages.push(assistant(`t${n}-${step}`,[...(step===1?[{type:"text",text:"Looking into request "+n}]:[]),toolUse(id,"npm test")]));
      messages.push(user(`r${n}-${step}`,toolResult(id)));
    }
    messages.push(assistant("a"+n,[{type:"text",text:"Answer "+n}]));
  }
  return messages;
}
const texts=turn=>turn.items.map(item=>item.type==="userMessage"?item.content[0].text:item.text);
const importer=()=>{const store={imported:null,findProviderSession:()=>null,importHistory:value=>(store.imported=value,{id:"imported-thread",...value})};return store};
const candidate={id:"claude-long",source:"claude",providerSessionId:"0f9b1c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e",cwd:"C:/repo",title:"Refactor the parser",preview:"Request 1",createdAt:Date.parse("2026-10-20T09:00:00Z"),updatedAt:Date.parse("2026-10-26T18:00:00Z")};

test("a long Claude session imports its latest 120 turns, ending on its last request, not its first 240 records",async()=>{
  const messages=longSession(250),read=sessionMessagesFn(messages),store=importer();
  assert.equal(messages.length,2000);
  const result=await importClaudeHistory(store,candidate,{getSessionMessagesFn:read});
  assert.equal(result.status,"imported");
  const turns=store.imported.turns;
  assert.equal(turns.length,120);
  assert.deepEqual(texts(turns.at(-1)),["Request 250","Looking into request 250","Answer 250"]);
  assert.deepEqual(texts(turns[0]),["Request 131","Looking into request 131","Answer 131"]);
  assert.ok(turns.every(turn=>turn.status==="completed"&&turn.items.length===3),"each turn holds its request and replies, and no tool record");
  // The whole session is asked for: an SDK limit counts from the session's start.
  assert.equal(read.calls.length,1);assert.equal(read.calls[0].options.limit,undefined);assert.equal(read.calls[0].options.offset,undefined);
  assert.equal(read.calls[0].options.dir,"C:/repo");
  assert.equal(store.imported.name,"Refactor the parser");assert.equal(store.imported.providerSessionId,candidate.providerSessionId);
});

test("tool records take no room: a session that is mostly tool results still imports its latest request",()=>{
  const messages=[
    user("first","First prompt"),assistant("first-reply",[{type:"text",text:"First reply"}]),
    ...Array.from({length:20_000},(_,index)=>user("result-"+index,toolResult("toolu_"+index))),
    user("latest","Latest prompt"),assistant("latest-tool",[toolUse("toolu_last","git status")]),
  ];
  const turns=claudeMessagesToTurns(messages,{createdAt:Date.parse("2026-10-26T18:00:00Z")});
  assert.deepEqual(turns.map(texts),[["First prompt","First reply"],["Latest prompt"]]);
});

test("a compacted session's summary is not imported as a request the person sent",()=>{
  // After a compaction Claude Code's chain starts at its summary, which the SDK marks isCompactSummary and is_meta.
  const turns=claudeMessagesToTurns([
    user("summary","This session is being continued from a previous conversation that ran out of context.",{isCompactSummary:true,is_meta:true}),
    user("next","Now run the integration tests"),assistant("next-reply",[{type:"text",text:"All 41 integration tests pass."}]),
  ],{createdAt:1000});
  assert.deepEqual(turns.map(texts),[["Now run the integration tests","All 41 integration tests pass."]]);
});

test("the import keeps a bounded amount of text, the newest turns whole and the newest one's request and latest replies",()=>{
  const MAX_IMPORTED_CHARS=8*1024*1024,long=n=>String(n).padEnd(32_000,".");
  // 12 requests of 41 messages each, every reply 32,000 characters long: 15.7M characters in all.
  const messages=[];
  for(let n=1;n<=12;n++){messages.push(user("u"+n,"Request "+n));for(let reply=1;reply<=40;reply++)messages.push(assistant(`a${n}-${reply}`,[{type:"text",text:long(n*100+reply)}]))}
  const turns=claudeMessagesToTurns(messages,{createdAt:1000});
  const chars=turns.flatMap(texts).reduce((total,text)=>total+text.length,0);
  assert.ok(chars<=MAX_IMPORTED_CHARS,`${chars} characters kept`);
  assert.ok(turns.length>1&&turns.length<12,`${turns.length} turns kept`);
  assert.equal(texts(turns.at(-1))[0],"Request 12");assert.equal(texts(turns.at(-1)).at(-1),long(1240));
  assert.ok(turns.every(turn=>turn.items.length===41),"older turns are kept whole or left out");
  // One request whose replies alone pass the bound keeps the request and its latest replies, up to its answer.
  const single=[user("only","Port the build to Bazel"),...Array.from({length:300},(_,index)=>assistant("r"+index,[{type:"text",text:long(index+1)}]))];
  const [turn,...rest]=claudeMessagesToTurns(single,{createdAt:1000});
  assert.equal(rest.length,0);
  assert.equal(texts(turn)[0],"Port the build to Bazel");assert.equal(texts(turn).at(-1),long(300));
  assert.ok(texts(turn).reduce((total,text)=>total+text.length,0)<=MAX_IMPORTED_CHARS+32_000);
  assert.ok(turn.items.length<301,"the earliest replies are left out");
});
