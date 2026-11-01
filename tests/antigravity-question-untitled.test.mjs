// An Antigravity question without a title asks in Trebell's own words (re-pinned on purpose: the earlier fallback sentence is gone);
// one whose options carry no id cannot be answered, so it is answered cancelled without asking the person; and an option is
// answered with the id Antigravity offered, as it offered it.
import test from "node:test";
import assert from "node:assert/strict";
import { acpSession, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const ANTIGRAVITY={initialize:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"agy-session",configOptions:[select("mode","mode","default",["default","auto_edit","yolo"])]}};
const ask=(toolCallId,options,title)=>({request:{method:"session/request_permission",params:{sessionId:"$sessionId",toolCall:{toolCallId,...(title?{title}:{})},options}}});

test("an untitled Antigravity question asks the person to pick one of its choices, and one without option ids is cancelled unasked",async t=>{
  const fx=await scriptedAcp(t,{...ANTIGRAVITY,prompts:[
    {steps:[ask("interaction_1",[{optionId:" blue ",name:" Blue "},{optionId:"red"}])]},
    {steps:[ask("interaction_2",[{optionId:"",name:"Nothing"},{name:"Neither"}],"Which colour?")]},
    {steps:[ask("interaction_3",[{optionId:"red"}],"Which colour?")]},
  ]});
  const asked=[],answers=[["Blue"],null];
  const {session}=acpSession(t,fx,{runtime:"antigravity",onQuestion:async({input})=>{asked.push(input.questions[0]);const answer=answers.shift();return answer&&{[input.questions[0].id]:answer}}});
  await session.start();
  for(const text of ["one","two","three"])await session.prompt([{type:"text",text}]);
  assert.deepEqual(asked[0],{id:"interaction_1",header:"Question",question:"Antigravity asks you to pick one of these.",multiSelect:false,allowCustomAnswer:false,options:[
    {value:"blue",label:"Blue",description:""},{value:"red",label:"red",description:""},
  ]},"a choice without a name is shown by its id");
  assert.equal(asked.length,2,"the question without option ids is never shown");
  const replies=(await fx.log()).filter(entry=>entry.reply==="session/request_permission").map(entry=>entry.message);
  assert.deepEqual(replies,[{outcome:{outcome:"selected",optionId:" blue "}},{outcome:{outcome:"cancelled"}},{outcome:{outcome:"cancelled"}}],
    "the chosen option by the id it was offered with; nothing to choose and a dismissed question are cancelled");
});
