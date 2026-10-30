import test from "node:test";
import assert from "node:assert/strict";
import { landingModel, newestModelsFirst } from "../ui/src/model-choice.js";

// Meta's chat models as the Meta Model API lists them for a key (the catalog sorts the ids; the rows keep the provider's order).
const META=["muse-spark-1.1","muse-spark-1.2","muse-spark-1.3","muse-spark-1.3-contributor","muse-wonder-1.0"];

test("Native on a provider that names no default lands on no model, so the composer asks, unless a saved choice is listed",()=>{
  assert.equal(landingModel(META,{ask:true}),"","several models and no default: none is assumed (it was muse-spark-1.1, the first sorted)");
  assert.equal(landingModel(META,{saved:[""],catalogDefault:null,ask:true}),"");
  // A saved choice wins as before: the thread's own model, the project's default, a pick made earlier in the window.
  assert.equal(landingModel(META,{saved:["muse-spark-1.3"],ask:true}),"muse-spark-1.3");
  assert.equal(landingModel(META,{saved:["muse-gone-9",null,"muse-wonder-1.0"],ask:true}),"muse-wonder-1.0","the first saved choice the catalog lists");
  assert.equal(landingModel(META,{saved:["gpt-6-luna"],ask:true}),"","a pick from another provider's list is not this one's");
  // A provider that lists exactly one model uses it (JustWorker, HCNSec, a one-model key).
  assert.equal(landingModel(["glm-5.3"],{ask:true}),"glm-5.3");
  assert.equal(landingModel([],{ask:true}),"");
});

test("a catalog's own default lands as before: OpenAI's measured gpt-6-luna, and a harness's default or first model",()=>{
  const openai=["gpt-5","gpt-6-luna","gpt-6.1-sol"];
  assert.equal(landingModel(openai,{catalogDefault:"gpt-6-luna",ask:false}),"gpt-6-luna");
  assert.equal(landingModel(openai,{saved:["gpt-5"],catalogDefault:"gpt-6-luna"}),"gpt-5","a saved choice still wins over the default");
  // Muse Code names muse-spark-1.2 itself (Meta's choice for its CLI), shown as the harness gives it.
  assert.equal(landingModel(["muse-wonder-1.0","muse-spark-1.3","muse-spark-1.2"],{catalogDefault:"muse-spark-1.2"}),"muse-spark-1.2");
  assert.equal(landingModel(["claude-opus-5","claude-sonnet-5"],{}),"claude-opus-5","a harness catalog without a default lands on its first model, as before");
  assert.equal(landingModel(["a","b"],{catalogDefault:"c"}),"a","a default the catalog does not list is not landed on");
});

test("a provider's models are offered newest first: a model's versions highest first, its families in the provider's order",()=>{
  const rows=META.map(id=>({id,object:"model",created:1777000000,owned_by:"meta"}));
  assert.deepEqual(newestModelsFirst(META,rows),["muse-spark-1.3","muse-spark-1.2","muse-spark-1.1","muse-spark-1.3-contributor","muse-wonder-1.0"]);
  // The provider's own order of families stands when it dates none of them, whatever order the catalog sorted the ids in.
  const listedOrder=["muse-wonder-1.0","muse-spark-1.2","muse-spark-1.3","muse-spark-1.3-contributor"].map(id=>({id}));
  assert.deepEqual(newestModelsFirst([...listedOrder.map(row=>row.id)].sort(),listedOrder),["muse-wonder-1.0","muse-spark-1.3","muse-spark-1.2","muse-spark-1.3-contributor"]);
  // Numbers compare as numbers (1.10 is after 1.9), and only ids that differ in nothing but their numbers are one family.
  assert.deepEqual(newestModelsFirst(["muse-spark-1.9","muse-spark-1.10","muse-spark-2"]),["muse-spark-1.10","muse-spark-1.9","muse-spark-2"]);
  assert.deepEqual(newestModelsFirst(["model-a","model-b"]),["model-a","model-b"],"names without numbers keep the provider's order");
});

test("families the provider dates go newest first, and every model listed is offered once",()=>{
  const ids=["grok-4.5","grok-4.7","latest","zeta-1"];
  const rows=[{id:"grok-4.7",created:1776556800},{id:"grok-4.5",created:1770000000},{id:"latest",created:1776556800},{id:"zeta-1",created:1779000000}];
  assert.deepEqual(newestModelsFirst(ids,rows),["zeta-1","grok-4.7","grok-4.5","latest"],"zeta is the newest family; grok and latest tie and keep the provider's order");
  // A model the rows do not list (a custom model added in Settings) keeps its place after them.
  assert.deepEqual(newestModelsFirst(["b-2","a-1","custom-x"],[{id:"a-1"},{id:"b-2"}]),["a-1","b-2","custom-x"]);
  assert.deepEqual(newestModelsFirst([],[]),[]);
  assert.deepEqual(newestModelsFirst(undefined),[]);
  const many=["m-1","m-3","m-2","n","o-1.0","o-1.1"];
  assert.deepEqual([...newestModelsFirst(many)].sort(),[...many].sort());
});
