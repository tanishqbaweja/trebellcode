import test from "node:test";
import assert from "node:assert/strict";
import { hasAutoSettleCandidates } from "../ui/src/auto-settle.js";

test("auto-settle polling only runs when an eligible thread has pull requests",()=>{
  const threads=[
    {id:"plain"},
    {id:"active",status:{type:"active"}},
    {id:"settled",section:{name:"Settled"}},
    {id:"archived",archived:true},
  ];
  const meta={
    active:{linkedPullRequests:[{number:1}]},
    settled:{linkedPullRequests:[{number:2}]},
    archived:{linkedPullRequests:[{number:3}]},
  };
  assert.equal(hasAutoSettleCandidates(threads,meta),false);
  assert.equal(hasAutoSettleCandidates([...threads,{id:"idle"}],{...meta,idle:{linkedPullRequests:[{number:4}]}}),true);
  assert.equal(hasAutoSettleCandidates([{id:"attachment"}],{attachment:{attachments:[{attachmentType:"pull_request",payload:{number:5}}]}}),true);
});
