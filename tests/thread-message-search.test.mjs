import test from "node:test";
import assert from "node:assert/strict";
import { matchingMessageExcerpt, matchingPullRequestExcerpt, searchThreadMessages, searchableThreadMessage, sidebarSearchMatches } from "../ui/src/thread-message-search.js";

test("thread message search indexes only user and final agent messages",()=>{
  assert.equal(searchableThreadMessage({type:"userMessage",content:[{type:"text",text:"Fix the payment callback"}]}),"Fix the payment callback");
  assert.equal(searchableThreadMessage({type:"agentMessage",text:"Implemented the webhook retry."}),"Implemented the webhook retry.");
  assert.equal(searchableThreadMessage({type:"reasoning",text:"secret scratchpad"}),"");
  assert.equal(searchableThreadMessage({type:"commandExecution",text:"npm test"}),"");
});

test("thread message search returns a compact excerpt around the match",()=>{
  const items=[
    {item:{type:"agentMessage",text:"This is unrelated."}},
    {item:{type:"userMessage",content:[{type:"text",text:"Please investigate the incredibly annoying payment callback failure in checkout."}]}},
  ];
  const excerpt=matchingMessageExcerpt(items,"payment callback",{maxLength:70});
  assert.match(excerpt,/payment callback/i);
  assert.ok(excerpt.length<=72);
  assert.equal(matchingMessageExcerpt(items,"p"),null);
  assert.equal(matchingMessageExcerpt(items,"missing"),null);
});

test("thread search matches linked pull requests by number, repository, title and URL",()=>{
  const meta={attachments:[{attachmentType:"pull_request",identityKey:"github.com|acme/widget|17",payload:{
    identity:{provider:"github",host:"github.com",repository:"acme/widget",number:17},
    url:"https://github.com/acme/widget/pull/17",title:"Fix payment callback",state:"OPEN",
    snapshot:{title:"Fix payment callback",state:"OPEN",headBranch:"fix/payments",baseBranch:"main"},
  }}]};
  assert.match(matchingPullRequestExcerpt(meta,"#17"),/#17/);
  assert.match(matchingPullRequestExcerpt(meta,"acme/widget"),/acme\/widget/);
  assert.match(matchingPullRequestExcerpt(meta,"payment callback"),/Fix payment callback/);
  assert.match(matchingPullRequestExcerpt(meta,"github.com/acme/widget/pull/17"),/#17/);
  assert.equal(matchingPullRequestExcerpt(meta,"#99"),null);
});

test("the sidebar search matches a thread's title and its project's name, not the folders around the project",()=>{
  const projects=[{name:"Atlas",path:"C:\\work\\fixtures\\atlas",environmentId:null},{name:"Beacon",path:"C:/work/fixtures/b-repo/",environmentId:null},{name:"Remote Beacon",path:"/srv/b-repo",environmentId:"wsl"}];
  const threads=[
    {id:"a",name:"Fix login redirect",cwd:"c:/work/fixtures/atlas"},
    {id:"b",name:"Write release notes",cwd:"C:\\work\\fixtures\\b-repo"},
    {id:"c",preview:"Untitled remote task",cwd:"/srv/b-repo"},
    {id:"d",name:"Plan the roadmap",cwd:"C:/work/fixtures/scratch/beacon-notes"},
    {id:"e",name:"Loose folder task",cwd:"C:/work/fixtures/side-project"},
  ];
  const threadMeta={c:{environmentId:"wsl"},d:{projectless:true}};
  const ids=query=>sidebarSearchMatches(threads,query,{threadMeta,projects}).map(thread=>thread.id);
  // "fixtures" and "work" sit in every path; only titles and project names count.
  assert.deepEqual(ids("fix"),["a"]);
  assert.deepEqual(ids("work"),[]);
  // A project's record names it, whatever its folder is called and however the path is written; the same path in another
  // environment is another project. A General chat has no project, whatever its folder.
  assert.deepEqual(ids("beacon"),["b","c"]);
  assert.deepEqual(ids("remote"),["c"]);
  assert.deepEqual(ids("atlas"),["a"]);
  // A folder with no record is named after itself, as the header crumb names it.
  assert.deepEqual(ids("side-project"),["e"]);
  assert.deepEqual(ids("   "),[]);
});

// The search of the threads' messages App loads at idle (idle-parts.js): it reads what App's render hands it, and nothing else.
function searchDeps({threads,threadMeta={},threadSearch=false,answer}){
  const calls=[],added=[];let listed=threads;
  const rpc={request:async(method,params)=>{calls.push({method,params});return answer(method,params)}};
  const setThreads=update=>{const next=update(listed);if(next!==listed)added.push(...next.slice(listed.length));listed=next};
  return {deps:{rpc,threads,threadMeta,runtimeCapabilities:{threadSearch},setThreads,cache:new Map()},calls,added};
}

test("the message search reads each thread's last items, keeps them while the thread is unchanged, and finds linked pull requests first",async()=>{
  const threads=[{id:"a",name:"Payments",updatedAt:10},{id:"b",name:"Docs",updatedAt:20},{id:"c",name:"Release",updatedAt:30}];
  const threadMeta={c:{linkedPullRequests:[{url:"https://github.com/acme/widget/pull/7",title:"Fix payment callback",identity:{host:"github.com",repository:"acme/widget",number:7}}]}};
  const items={a:[{item:{type:"userMessage",content:[{type:"text",text:"The payment callback fails in checkout."}]}}],b:[{item:{type:"agentMessage",text:"Wrote the guide."}}]};
  const {deps,calls}=searchDeps({threads,threadMeta,answer:(method,params)=>{assert.equal(method,"thread/items/list");return {data:items[params.threadId]}}});
  const first=await searchThreadMessages(deps,"payment callback");
  assert.deepEqual(first.matches.map(match=>match.threadId).sort(),["a","c"]);
  assert.match(first.matches.find(match=>match.threadId==="c").excerpt,/^PR · acme\/widget · #7 Fix payment callback$/);
  assert.equal(first.warning,"");
  // A thread whose pull request matched is not read; the others are read with their last 150 items, newest first.
  assert.deepEqual(calls.map(call=>call.params.threadId).sort(),["a","b"]);
  assert.ok(calls.every(call=>call.params.limit===150&&call.params.sortDirection==="desc"));
  // Searched again with the threads unchanged, it reads nothing; a thread updated since is read again.
  const again=await searchThreadMessages(deps,"payment");assert.equal(calls.length,2);
  assert.deepEqual(again.matches.map(match=>match.threadId).sort(),["a","c"]);
  await searchThreadMessages({...deps,threads:[{...threads[0],updatedAt:11},threads[1],threads[2]]},"payment");
  assert.deepEqual(calls.slice(2).map(call=>call.params.threadId),["a"]);
});

test("the message search takes the harness's own thread search where it has one, adding the threads it finds that the list does not hold",async()=>{
  const threads=[{id:"a",name:"Payments",updatedAt:10}];
  const {deps,calls,added}=searchDeps({threads,threadSearch:true,answer:method=>{assert.equal(method,"thread/search");return {data:[{thread:{id:"a"},snippet:"the payment   callback"},{thread:{id:"z",name:"Older"},snippet:"payment callback again"}]}}});
  const found=await searchThreadMessages(deps,"payment callback");
  assert.deepEqual(found,{matches:[{threadId:"a",excerpt:"the payment callback",thread:{id:"a"}},{threadId:"z",excerpt:"payment callback again",thread:{id:"z",name:"Older"}}],warning:""});
  assert.deepEqual(calls.map(call=>call.params.searchTerm),["payment callback"]);
  assert.deepEqual(added.map(thread=>thread.id),["z"]);
});

test("a message search that could not read everything says so, and still gives what it found",async()=>{
  const threads=[{id:"a",name:"Payments",updatedAt:10},{id:"b",name:"Docs",updatedAt:20}];
  const {deps}=searchDeps({threads,threadSearch:true,answer:(method,params)=>{
    if(method==="thread/search")throw new Error("search index offline");
    if(params.threadId==="b")throw new Error("thread b is gone");
    return {data:[{item:{type:"agentMessage",text:"Fixed the payment callback."}}]};
  }});
  const found=await searchThreadMessages(deps,"payment");
  assert.deepEqual(found.matches.map(match=>match.threadId),["a"]);
  assert.equal(found.warning,"Full thread search unavailable: search index offline. Searching loaded threads only. 1 loaded thread could not be searched: thread b is gone.");
});
