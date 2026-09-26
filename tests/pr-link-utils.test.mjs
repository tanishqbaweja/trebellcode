import test from "node:test";
import assert from "node:assert/strict";
import { buildPullRequestLink, linkedPullRequestTerminalStatus, normalizePullRequestIdentity, parsePullRequestUrl, pullRequestForBranch, pullRequestIdentityKey } from "../src/pr-link-utils.mjs";

test("pull request URLs normalize to host-level identities",()=>{
  assert.deepEqual(parsePullRequestUrl("https://github.com/Acme/Widget/pull/17"),{provider:"github",host:"github.com",repository:"Acme/Widget",number:17,url:"https://github.com/Acme/Widget/pull/17"});
  assert.deepEqual(parsePullRequestUrl("https://gitlab.example.com/group/sub/repo/-/merge_requests/9"),{provider:"gitlab",host:"gitlab.example.com",repository:"group/sub/repo",number:9,url:"https://gitlab.example.com/group/sub/repo/-/merge_requests/9"});
  assert.deepEqual(parsePullRequestUrl("https://dev.azure.com/acme/platform/_git/widget/pullrequest/5"),{provider:"azure-devops",host:"dev.azure.com",repository:"acme/platform/widget",number:5,url:"https://dev.azure.com/acme/platform/_git/widget/pullrequest/5"});
  assert.deepEqual(parsePullRequestUrl("https://acme.visualstudio.com/platform/_git/widget/pullrequest/5"),{provider:"azure-devops",host:"acme.visualstudio.com",repository:"platform/widget",number:5,url:"https://acme.visualstudio.com/platform/_git/widget/pullrequest/5"});
  assert.equal(pullRequestIdentityKey({url:"https://github.com/Acme/Widget/pull/17"}),"github.com|acme/widget|17");
  assert.deepEqual(normalizePullRequestIdentity({provider:"github",host:"WWW.GitHub.com",repository:"Acme/Widget.git",number:"17"}),{provider:"github",host:"github.com",repository:"Acme/Widget",number:17});
});

test("linked PR payload persists snapshot and native stack metadata",()=>{
  const link=buildPullRequestLink({
    identity:{provider:"github",host:"github.com",repository:"acme/widget",number:2},
    number:2,title:"Layer two",state:"OPEN",url:"https://github.com/acme/widget/pull/2",headRefName:"layer-two",baseRefName:"layer-one",
    files:[{path:"a.js",additions:3,deletions:1}],reviewDecision:"APPROVED",
    stack:{id:900,number:42,baseRefName:"main",layers:[
      {number:1,headRefName:"layer-one",state:"OPEN"},
      {number:2,headRefName:"layer-two",state:"OPEN"},
    ]},
  },{source:"manual"});
  assert.equal(link.identity.repository,"acme/widget");
  assert.equal(link.snapshot.title,"Layer two");
  assert.equal(link.snapshot.additions,3);
  assert.equal(link.snapshot.changedFiles,1);
  assert.equal(link.stack.kind,"native");
  assert.deepEqual(link.stack.layers.map(layer=>layer.number),[1,2]);
});

test("auto-settle eligibility requires every linked pull request to be freshly terminal",()=>{
  const merged={identity:{provider:"github",host:"github.com",repository:"acme/widget",number:1},snapshot:{state:"MERGED",syncedAt:"2026-09-22T10:00:00Z",mergedAt:"2026-09-22T09:59:00Z"}};
  const closed={identity:{provider:"github",host:"github.com",repository:"acme/widget",number:2},snapshot:{state:"CLOSED",syncedAt:"2026-09-22T10:00:00Z",closedAt:"2026-09-22T09:58:00Z"}};
  const terminal=linkedPullRequestTerminalStatus([merged,closed]);
  assert.equal(terminal.terminal,true);assert.ok(terminal.signature.includes("github.com|acme/widget|1"));
  assert.equal(linkedPullRequestTerminalStatus([{...merged,snapshot:{...merged.snapshot,state:"OPEN"}}]).reason,"active");
  assert.equal(linkedPullRequestTerminalStatus([{...merged,snapshot:{...merged.snapshot,syncedAt:null}}]).reason,"unsynced");
  assert.equal(linkedPullRequestTerminalStatus([]).reason,"no-links");
});

test("saved branch discovery selects only the matching open pull request",()=>{
  const items=[
    {number:7,title:"Old",state:"CLOSED",url:"https://github.com/acme/widget/pull/7",headRefName:"feature/x",baseRefName:"main",identity:{provider:"github",host:"github.com",repository:"acme/widget",number:7}},
    {number:8,title:"Current",state:"OPEN",url:"https://github.com/acme/widget/pull/8",headRefName:"feature/x",baseRefName:"main",identity:{provider:"github",host:"github.com",repository:"acme/widget",number:8},stack:{number:42,layers:[]}},
    {number:9,title:"Other",state:"OPEN",url:"https://github.com/acme/widget/pull/9",headRefName:"feature/y",baseRefName:"main",identity:{provider:"github",host:"github.com",repository:"acme/widget",number:9}},
  ];
  const detected=pullRequestForBranch("feature/x",items);
  assert.equal(detected.number,8);assert.equal(detected.title,"Current");assert.equal(detected.identity.repository,"acme/widget");assert.equal(detected.stack.number,42);
  assert.equal(pullRequestForBranch("missing",items),null);
});
