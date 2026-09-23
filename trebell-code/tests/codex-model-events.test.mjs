import test from "node:test";
import assert from "node:assert/strict";
import { codexModelEvent } from "../ui/src/codex-model-events.js";

const label=id=>({"gpt-a":"Model A","gpt-b":"Model B","gpt-fast":"Fast Model"}[id]||id);

test("Codex model reroutes stay explicit about source, target and protocol reason",()=>{
  assert.deepEqual(codexModelEvent({method:"model/rerouted",params:{threadId:"t1",turnId:"turn1",fromModel:"gpt-a",toModel:"gpt-b",reason:"highRiskCyberActivity"}},label),{
    id:"model-rerouted-turn1",
    kind:"modelRouting",
    title:"Model rerouted: Model A → Model B · high risk cyber activity",
    status:"done",
    raw:{fromModel:"gpt-a",toModel:"gpt-b",reason:"highRiskCyberActivity"},
  });
});

test("Codex safety buffering updates one bounded activity event",()=>{
  const active=codexModelEvent({method:"model/safetyBuffering/updated",params:{threadId:"t1",turnId:"turn1",model:"gpt-b",useCases:["cyber","cyber"],reasons:["user_risk"],showBufferingUi:true,fasterModel:"gpt-fast"}},label);
  assert.equal(active.id,"model-safety-buffer-turn1");assert.equal(active.status,"running");
  assert.equal(active.title,"Safety buffering active · Model B · faster option Fast Model");
  assert.deepEqual(active.raw,{model:"gpt-b",useCases:["cyber"],reasons:["user_risk"],showBufferingUi:true,fasterModel:"gpt-fast"});
  const cleared=codexModelEvent({method:"model/safetyBuffering/updated",params:{threadId:"t1",turnId:"turn1",model:"gpt-b",useCases:[],reasons:[],showBufferingUi:false,fasterModel:null}},label);
  assert.equal(cleared.id,active.id);assert.equal(cleared.status,"done");assert.equal(cleared.title,"Safety buffering cleared · Model B");
});

test("verification is humanized while opaque moderation metadata is never exposed",()=>{
  const verification=codexModelEvent({method:"model/verification",params:{threadId:"t1",turnId:"turn1",verifications:["trustedAccessForCyber"]}},label);
  assert.equal(verification.title,"Model verification: trusted access for cyber");
  const secretMetadata={internalReason:"do-not-render",nested:{score:0.91}};
  const moderation=codexModelEvent({method:"turn/moderationMetadata",params:{threadId:"t1",turnId:"turn1",metadata:secretMetadata}},label);
  assert.deepEqual(moderation.raw,{metadataAvailable:true});
  assert.doesNotMatch(JSON.stringify(moderation),/do-not-render|0\.91/);
});

test("unrelated or malformed notifications do not create activity",()=>{
  assert.equal(codexModelEvent({method:"model/rerouted",params:{threadId:"t1"}}),null);
  assert.equal(codexModelEvent({method:"account/updated",params:{threadId:"t1",turnId:"turn1"}}),null);
});
