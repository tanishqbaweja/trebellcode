import test from "node:test";
import assert from "node:assert/strict";
import { buildPullRequestLink, normalizePullRequestIdentity, parsePullRequestUrl, pullRequestIdentityKey } from "../src/pr-link-utils.mjs";

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
