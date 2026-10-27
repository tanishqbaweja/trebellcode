import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexHistoryPrefix, scanCodexHistory } from "../src/agent-history-import.mjs";

// Codex history as the import lists it: the person's own Codex sessions, named after what they asked. A subagent's session (a
// spawned child agent, a review, a compaction or a guardian check) is Codex's own and is left out before it counts toward the
// recent-session limit, and the setup text Codex records ahead of a request does not become the title. Fixtures after T3 Code's
// AgentSessionScanner tests (002ef3652, 0b896d9ff).
const rollout=(records)=>records.map(record=>JSON.stringify(record)).join("\n");
const SUBAGENT_SOURCES=[
  {subagent:{thread_spawn:{parent_thread_id:"session-100",depth:1}}},
  {subagent:"review"},
  {subagent:{other:"guardian"}},
  {subAgent:"compact"},
];

test("Codex history leaves out subagent sessions before they use up the recent-session limit",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-subagents-")),workspace=join(root,"workspace"),home=join(root,"codex-home");
  try{
    await mkdir(workspace,{recursive:true});
    // 100 subagent sessions newer than any of the person's own (scanned first, from the newest day), then 4 of the person's own.
    const sources=[...Array.from({length:100},(_,index)=>SUBAGENT_SOURCES[index%4]),"vscode",undefined,null,{custom:"launcher"}];
    const now=Date.now();
    for(const [index,source] of sources.entries()){
      const day=join(home,"sessions","2026","10",index<100?"26":"25");await mkdir(day,{recursive:true});
      const path=join(day,`rollout-2026-10-${index<100?"26":"25"}T12-00-00-${String(index).padStart(3,"0")}.jsonl`);
      await writeFile(path,rollout([
        {timestamp:"2026-10-25T12:00:00Z",type:"session_meta",payload:{id:"session-"+index,cwd:workspace,...(source===undefined?{}:{source})}},
        {type:"turn_context",payload:{cwd:workspace,model:"gpt-test"}},
        {type:"event_msg",payload:{type:"user_message",message:"Import this prompt"}},
      ]));
      const at=new Date(now-index*60_000);await utimes(path,at,at);
    }
    const found=await scanCodexHistory({env:{...process.env,TREBELL_HOME:join(root,"trebell-home")},sourceHome:home,maxSessions:60});
    assert.deepEqual(found.map(item=>item.providerSessionId),["session-100","session-101","session-102","session-103"]);
    assert.ok(found.every(item=>item.title==="Import this prompt"&&item.cwd===workspace));
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("only a subagent or subAgent key in a session's source marks it as Codex's own",()=>{
  const parse=source=>parseCodexHistoryPrefix(rollout([
    {type:"session_meta",payload:{id:"codex-session",cwd:"C:\\repo",source}},
    {type:"event_msg",payload:{type:"user_message",message:"Fix the thing"}},
  ]));
  for(const source of SUBAGENT_SOURCES)assert.equal(parse(source),null,JSON.stringify(source));
  for(const source of ["cli","vscode","exec",undefined,null,{custom:"launcher"},["subagent"]])assert.equal(parse(source)?.title,"Fix the thing",JSON.stringify(source)??"undefined");
});

// A Codex fork copies its ancestors' session_meta records in after its own (T3 Code's "uses the first valid Codex session ID when a
// fork copies ancestor metadata"): the person's fork of a review or child-agent thread is theirs, under its own id.
test("a person's fork of a subagent's thread is listed under its own id, whatever ancestor session_meta it copied",()=>{
  const fork=parseCodexHistoryPrefix(rollout([
    {type:"session_meta",payload:{id:"fork-session",forked_from_id:"review-session",cwd:"C:\\repo",source:"vscode"}},
    {type:"session_meta",payload:{id:"review-session",cwd:"C:\\repo",source:{subagent:"review"}}},
    {type:"session_meta",payload:{id:"parent-session",cwd:"C:\\other",source:"cli"}},
    {type:"event_msg",payload:{type:"user_message",message:"Continue in the fork"}},
  ]));
  assert.deepEqual([fork?.providerSessionId,fork?.cwd,fork?.title],["fork-session","C:\\repo","Continue in the fork"]);
  const plain=parseCodexHistoryPrefix(rollout([
    {type:"session_meta",payload:{id:"fork-session",forked_from_id:"parent-session"}},
    {type:"session_meta",payload:{id:"parent-session",cwd:"C:\\repo"}},
    {type:"event_msg",payload:{type:"user_message",message:"Continue in the fork"}},
  ]));
  assert.equal(plain?.providerSessionId,"fork-session","the first valid id, not an ancestor's");
  // A subagent's own session that copied a person's session_meta after its own is still the subagent's.
  assert.equal(parseCodexHistoryPrefix(rollout([
    {type:"session_meta",payload:{id:"review-session",cwd:"C:\\repo",source:{subagent:"review"}}},
    {type:"session_meta",payload:{id:"person-session",cwd:"C:\\repo",source:"vscode"}},
    {type:"event_msg",payload:{type:"user_message",message:"Review the change"}},
  ])),null);
});

test("Codex history names a session after the request, not the setup text Codex records ahead of it",()=>{
  const title=(...messages)=>parseCodexHistoryPrefix(rollout([
    {type:"session_meta",payload:{id:"codex-session",cwd:"C:\\repo"}},
    ...messages.map(message=>({type:"event_msg",payload:{type:"user_message",message}})),
  ]))?.title;
  assert.equal(title("<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>\n\nCreate a useful project."),"Create a useful project.");
  assert.equal(title("\n  ## My request for Codex:\n\nFix the visible bug"),"Fix the visible bug");
  assert.equal(title([
    "<recommended_plugins>\nGitHub\n</recommended_plugins>",
    "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>",
    "<in-app-browser-context source=\"ambient-ui-state\">\nTab\n</in-app-browser-context>",
    "Fix the import titles",
  ].join("\n")),"Fix the import titles");
  assert.equal(title("<user_instructions>\nAnswer briefly.\n</user_instructions>\nRename the config loader"),"Rename the config loader");
  // A message that is only setup text names nothing: the next request does.
  assert.equal(title("<environment_context>\n<cwd>/repo</cwd>\n</environment_context>","Add retries to the uploader"),"Add retries to the uploader");
  // Setup text quoted inside the request stays part of it.
  assert.equal(title("Do not remove this example:\n<environment_context>\n<cwd>/tmp/example</cwd>\n</environment_context>"),"Do not remove this example: <environment_context> <cwd>/tmp/example</cwd> </environment_context>");
  assert.equal(title("<environment_context>\n<cwd>/repo</cwd>\n</environment_context>"),"Imported Codex session");
});
