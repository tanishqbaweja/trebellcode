import test from "node:test";
import assert from "node:assert/strict";
import { matchingMessageExcerpt, matchingPullRequestExcerpt, searchableThreadMessage } from "../ui/src/thread-message-search.js";

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
