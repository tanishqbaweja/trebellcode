import test from "node:test";
import assert from "node:assert/strict";
import { matchingMessageExcerpt, matchingPullRequestExcerpt, searchableThreadMessage, sidebarSearchMatches } from "../ui/src/thread-message-search.js";

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
