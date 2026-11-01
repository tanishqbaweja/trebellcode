// What a Cursor turn shows when Cursor's own words are missing (cursor/create_plan and cursor/ask_question, as Cursor's ACP page
// documents them): a plan request without plan text shows its overview under the plan's name, or Trebell's note when it has
// neither, and is still accepted with its todos shown; a question without a prompt is still asked, in Trebell's words.
import test from "node:test";
import assert from "node:assert/strict";
import { acpSession, replyTo, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]}};
const planRequest=params=>({request:{method:"cursor/create_plan",params:{toolCallId:"plan-1",...params}}});
const replies=(log,method)=>log.filter(entry=>entry.reply===method).map(entry=>entry.message);
const shownText=updates=>updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text.trim());

test("a Cursor plan without plan text shows its overview under its name, or Trebell's note, and is still accepted",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[
    {steps:[planRequest({name:"Move the cache",overview:"  Keep the cache in one folder per project.  ",plan:"   "})]},
    {steps:[planRequest({overview:"Split the parser in two."})]},
    {steps:[planRequest({name:"Nothing written",todos:[{id:"a",content:"Read the parser",status:"pending"}]})]},
    {steps:[planRequest({name:"Ignored",overview:"Ignored too",plan:"## Steps\n\n1. Read the parser"})]},
  ]});
  const {session,updates}=acpSession(t,fx,{runtime:"cursor"});
  await session.start();
  for(const text of ["one","two","three","four"])await session.prompt([{type:"text",text}]);
  assert.deepEqual(shownText(updates),[
    "# Move the cache\n\nKeep the cache in one folder per project.",
    "# Cursor's plan\n\nSplit the parser in two.",
    "# No plan text from Cursor\n\nCursor proposed a plan but sent none of its text.",
    "## Steps\n\n1. Read the parser",
  ],"plan text first, then the overview, then Trebell's note");
  assert.deepEqual(replies(await fx.log(),"cursor/create_plan"),Array(4).fill({outcome:{outcome:"accepted"}}));
  assert.deepEqual(updates.filter(update=>update.sessionUpdate==="plan").map(update=>update.entries),[[{content:"Read the parser",status:"pending"}]],"a plan's todos show without its text");
});

test("a Cursor question without a prompt is asked in Trebell's words and answered as Cursor expects",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[{request:{method:"cursor/ask_question",params:{toolCallId:"q",questions:[
    {id:"db",options:[{id:"pg",label:"Postgres"},{id:"lite",label:"SQLite"}]},
    {id:"name",prompt:"  What should the table be called?  ",options:[]},
  ]}}}]}]});
  const asked=[];
  const {session}=acpSession(t,fx,{runtime:"cursor",onQuestion:async({input})=>{asked.push(input.questions);return {db:["SQLite"],name:["events"]}}});
  await session.start();await session.prompt([{type:"text",text:"ask"}]);
  assert.deepEqual(asked[0].map(question=>question.question),["Cursor sent this question without any words.","What should the table be called?"]);
  assert.deepEqual(replyTo(await fx.log(),"cursor/ask_question"),{outcome:{outcome:"answered",answers:[{questionId:"db",selectedOptionIds:["lite"]}]}});
});
