// Grok Build's model list as Trebell reads it from the harness's initialize answer (_meta.modelState): the rows, the preferred
// model, the reasoning levels each model offers and the level it starts at.
import test from "node:test";
import assert from "node:assert/strict";
import { grokModelCatalog } from "../src/acp-model-catalog.mjs";

const listed=(models,currentModelId)=>grokModelCatalog({protocolVersion:1,_meta:{modelState:{...(currentModelId===undefined?{}:{currentModelId}),availableModels:models}}});
const levelsOf=about=>listed([{modelId:"grok-fixture",name:"Grok fixture",_meta:about}]).metadata[0];
// A Grok Build row as the catalog gives it, with the fields that differ per model.
const grokRow=(id,fields)=>({id,provider:"grok",agent:"Grok Build",...fields});

test("a Grok Build model starts at the level it is on when it marks that level a default, else at its first marked default",()=>{
  const offered=[{value:"low",default:true},{value:"medium"},{value:"high",isDefault:true}];
  assert.equal(levelsOf({reasoningEffort:" HIGH ",reasoningEfforts:offered}).defaultReasoningEffort,"high","the second marked default, because the model is on it");
  assert.equal(levelsOf({reasoningEffort:"low",reasoningEfforts:offered}).defaultReasoningEffort,"low");
  assert.equal(levelsOf({reasoningEffort:"medium",reasoningEfforts:offered}).defaultReasoningEffort,"low","a level that is not marked never becomes the default by being current");
  assert.equal(levelsOf({reasoningEfforts:offered}).defaultReasoningEffort,"low","no current level: the first marked default");
  assert.equal(levelsOf({reasoningEffort:"ultra",reasoningEfforts:offered}).defaultReasoningEffort,"low","a current level the model does not offer");
  const unmarked=levelsOf({reasoningEffort:"high",reasoningEfforts:["low","high"]});
  assert.deepEqual([unmarked.reasoningEfforts,unmarked.defaultReasoningEffort],[["low","high"],null],"nothing marked: no default level");
  const none=levelsOf({reasoningEffort:"high"});
  assert.deepEqual([none.reasoningEfforts,none.defaultReasoningEffort],[[],null],"no offered levels at all");
});

test("a Grok Build model's levels are read from strings and objects, lowercased, each once and only by usable names",()=>{
  const row=levelsOf({reasoningEffort:"low",reasoningEfforts:[
    " High ",{value:"LOW"},{id:"x-high"},{value:null,id:"max"},{value:"",id:"medium"},
    "extra high","-low",".fast","y".repeat(33),"z".repeat(32),null,5,true,["minimal"],{},
    {value:"low",default:true},{value:"turbo.v2",default:"true"},{value:"deep_think",isDefault:1},
  ]});
  assert.deepEqual(row.reasoningEfforts,["high","low","x-high","max","z".repeat(32),"turbo.v2","deep_think"]);
  assert.equal(row.defaultReasoningEffort,null,"a repeated level's mark is not read, and only true marks a level");
  const marked=levelsOf({reasoningEfforts:[{value:"low"},{id:"HIGH",isDefault:true},{value:"high",default:false}]});
  assert.deepEqual([marked.reasoningEfforts,marked.defaultReasoningEffort],[["low","high"],"high"],"the first entry for a level decides its mark");
});

test("a Grok Build model without reasoning control offers no levels",()=>{
  const off=levelsOf({supportsReasoningEffort:false,reasoningEffort:"high",reasoningEfforts:[{value:"high",default:true}]});
  assert.deepEqual([off.reasoningEfforts,off.defaultReasoningEffort],[[],null]);
  const said=levelsOf({supportsReasoningEffort:"false",reasoningEfforts:[{value:"high",default:true}]});
  assert.deepEqual([said.reasoningEfforts,said.defaultReasoningEffort],[["high"],"high"],"only false itself turns the levels off");
  assert.deepEqual(levelsOf({reasoningEfforts:"high"}).reasoningEfforts,[],"levels that are not a list");
});

test("Grok Build's model rows keep its order, names, descriptions, context sizes and the model it is on",()=>{
  const catalog=listed([
    {_meta:{totalContextTokens:"131072.9"},modelId:" grok-5 ",name:"",description:" Deep "},
    {modelId:"grok-5",name:"Second grok-5"},
    {modelId:""},null,{name:"no id"},"grok-text",
    {modelId:"grok-code",name:" Grok Code ",description:"  ",_meta:{totalContextTokens:0}},
    {modelId:"grok-mini",_meta:"not an object"},
  ]," grok-code ");
  assert.deepEqual(catalog.models,["grok-5","grok-code","grok-mini"]);
  assert.equal(catalog.preferred,"grok-code");
  assert.deepEqual(catalog.metadata,[
    grokRow("grok-5",{name:"grok-5",description:"Deep",contextWindow:131072,reasoningEfforts:[],defaultReasoningEffort:null}),
    grokRow("grok-code",{name:"Grok Code",reasoningEfforts:[],defaultReasoningEffort:null,isDefault:true}),
    grokRow("grok-mini",{name:"grok-mini",reasoningEfforts:[],defaultReasoningEffort:null}),
  ]);
  assert.deepEqual(Object.keys(catalog.metadata[0]),["id","name","provider","agent","description","contextWindow","reasoningEfforts","defaultReasoningEffort"]);
  assert.deepEqual(Object.keys(catalog.metadata[1]),["id","name","provider","agent","reasoningEfforts","defaultReasoningEffort","isDefault"]);
});

test("Grok Build's preferred model is the first listed one when the model it is on is not listed, and none without models",()=>{
  const pair=["grok-a","grok-b"].map(modelId=>({modelId})),catalog=listed(pair,"grok-gone");
  assert.equal(catalog.preferred,"grok-a");
  assert.equal(catalog.metadata.some(row=>"isDefault" in row),false);
  assert.equal(listed(pair).preferred,"grok-a");
  for(const answer of [null,undefined,{},{_meta:null},{_meta:{modelState:"x"}},{_meta:{modelState:{currentModelId:"grok-a",availableModels:{modelId:"grok-a"}}}}]){
    assert.deepEqual(grokModelCatalog(answer),{models:[],metadata:[],preferred:null},JSON.stringify(answer)??"undefined");
  }
});
