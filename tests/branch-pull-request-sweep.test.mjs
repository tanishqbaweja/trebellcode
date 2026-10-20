import test from "node:test";
import assert from "node:assert/strict";
import { createBranchPullRequestSweep } from "../src/branch-pull-request-sweep.mjs";
import { pullRequestForBranch } from "../src/pr-link-utils.mjs";

const MINUTE=60_000;
const openReview=(number,branch)=>({identity:{provider:"github",host:"github.com",repository:"acme/widget",number},number,title:"Review "+number,state:"OPEN",url:"https://github.com/acme/widget/pull/"+number,headRefName:branch,baseRefName:"main"});

// A state store as the sweep sees it: thread meta to list and update, each update counted as the write to sqlite it is.
function fakeState(threadMeta){
  const meta=structuredClone(threadMeta),writes=[];
  return {meta,writes,listThreadMeta:()=>structuredClone(meta),updateThreadMeta(threadId,patch){writes.push({threadId,patch});meta[threadId]={...(meta[threadId]||{}),...patch};return structuredClone(meta[threadId])}};
}
function sweepOf(state,{reviews=[],identity=()=>({provider:"github",host:"github.com",repository:"acme/widget"})}={}){
  const clock={at:Date.parse("2026-10-20T09:00:00Z")},asked=[],listed=[];
  const sync=createBranchPullRequestSweep({
    state,pullRequestForBranch,now:()=>clock.at,
    repositoryIdentity:async cwd=>{asked.push(clock.at);return identity(cwd)},
    listPullRequests:async()=>{listed.push(clock.at);return {ok:true,items:reviews}},
  });
  return {sync,clock,asked,listed,reviews};
}
const projectThreads=()=>({
  "thread-a":{cwd:"H:/repo",environmentId:null,branch:"feature/a",sectionName:"Active"},
  "thread-b":{cwd:"H:/repo",environmentId:null,branch:"feature/b",sectionName:"Active"},
});

test("B21: a branch sweep that learns nothing new writes no thread meta",async()=>{
  const state=fakeState(projectThreads()),{sync,clock,listed}=sweepOf(state,{reviews:[openReview(21,"feature/a")]});
  assert.equal((await sync()).written,2);
  assert.equal(state.meta["thread-a"].branchPullRequest.number,21);assert.equal(state.meta["thread-b"].branchPullRequest,null);
  // Every minute after it asks again (the review can change on the host), but an answer like the last one is not written, though the
  // snapshot it builds carries a new detectedAt.
  for(let minute=1;minute<=5;minute++){clock.at+=MINUTE;assert.equal((await sync()).written,0)}
  assert.equal(listed.length,6);assert.equal(state.writes.length,2);
});

test("a branch sweep writes the review that changed, and only that thread's",async()=>{
  const state=fakeState(projectThreads()),{sync,clock,reviews}=sweepOf(state,{reviews:[openReview(21,"feature/a")]});
  await sync();state.writes.length=0;
  reviews.push(openReview(22,"feature/b"));clock.at+=MINUTE;
  assert.equal((await sync()).written,1);
  assert.deepEqual(state.writes.map(write=>write.threadId),["thread-b"]);assert.equal(state.meta["thread-b"].branchPullRequest.number,22);
  assert.equal(state.meta["thread-b"].lastBranchPullRequestSyncAt,clock.at);
  reviews.splice(0,1);clock.at+=MINUTE;
  assert.equal((await sync()).written,1);assert.equal(state.meta["thread-a"].branchPullRequest,null);
});

test("B21: a repository the sweep cannot read is asked again after 1, 2, 4 and 8 minutes, then every 10, and its reason is written once",async()=>{
  const state=fakeState({"thread-a":projectThreads()["thread-a"]});
  const {sync,clock,asked}=sweepOf(state,{identity:()=>{throw new Error("This repository has no remote.")}});
  const start=clock.at;
  for(let minute=0;minute<=40;minute++){await sync();clock.at+=MINUTE}
  assert.deepEqual(asked.map(at=>(at-start)/MINUTE),[0,1,3,7,15,25,35]);
  assert.equal(state.writes.length,1);assert.equal(state.meta["thread-a"].branchPullRequestSyncError,"This repository has no remote.");
});

test("a thread whose branch changes is asked at the next sweep, and a restart asks every thread once",async()=>{
  const state=fakeState({"thread-a":projectThreads()["thread-a"]});
  let failing=true;
  const {sync,clock,asked}=sweepOf(state,{reviews:[openReview(23,"feature/c")],identity:()=>{if(failing)throw new Error("offline");return {provider:"github",host:"github.com",repository:"acme/widget"}}});
  for(let minute=0;minute<=8;minute++){await sync();clock.at+=MINUTE}
  assert.equal(asked.length,4);
  failing=false;state.meta["thread-a"].branch="feature/c";
  await sync();
  assert.equal(asked.length,5);assert.equal(state.meta["thread-a"].branchPullRequest.number,23);assert.equal(state.meta["thread-a"].branchPullRequestSyncError,null);
  // A new server process keeps no checks: its first sweep asks again, and finds the same review, so writes nothing.
  const writes=state.writes.length;clock.at+=2*MINUTE;
  const restarted=sweepOf(state,{reviews:[openReview(23,"feature/c")]});restarted.clock.at=clock.at;
  assert.equal((await restarted.sync()).written,0);assert.equal(restarted.asked.length,1);assert.equal(state.writes.length,writes);
});

test("a branch sweep leaves archived, settled and deleted threads and threads without a branch alone",async()=>{
  const state=fakeState({
    archived:{cwd:"H:/repo",branch:"feature/a",archived:true},settled:{cwd:"H:/repo",branch:"feature/a",sectionName:"Settled"},
    deleted:{cwd:"H:/repo",branch:"feature/a",deletedAt:1},noBranch:{cwd:"H:/repo",branch:null},
  });
  const {sync,asked}=sweepOf(state,{reviews:[openReview(21,"feature/a")]});
  assert.deepEqual(await sync(),{checked:0,repositories:0,written:0});assert.equal(asked.length,0);assert.equal(state.writes.length,0);
});
