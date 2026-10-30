// Antigravity asks its multiple-choice questions through session/request_permission (an interaction_* tool call) and takes only one
// of the choices it offered as the answer. The question goes to the app marked as
// taking no words of the person's own, each choice carrying its option id, so the person picks one of them and two choices of one
// name stay apart. Other harnesses' questions keep taking the person's own words.
import test from "node:test";
import assert from "node:assert/strict";
import { acpRelay, acpSession, replyTo, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const ANTIGRAVITY={initialize:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"agy-session",configOptions:[select("mode","mode","default",["default","auto_edit","yolo"])]}};
const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]}};
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"grok-session"}};
const ask=(toolCallId,title,options)=>({request:{method:"session/request_permission",params:{sessionId:"$sessionId",toolCall:{toolCallId,title},options}}});
// Two choices of one name, an id offered twice and an option without one.
const DATABASES=[
  {optionId:"pg-15",name:"Postgres",kind:"allow_once"},{optionId:"pg-16",name:"Postgres",kind:"allow_once"},{optionId:"sqlite",name:"SQLite",kind:"allow_once"},
  {optionId:"pg-15",name:"Postgres again",kind:"allow_once"},{optionId:"",name:"Nothing",kind:"allow_once"},
];

test("an Antigravity question takes only its own choices, each answered by its option id, even when two share a name",async t=>{
  const fx=await scriptedAcp(t,{...ANTIGRAVITY,prompts:["interaction_1","interaction_2","interaction_3"].map(id=>({steps:[ask(id,"Which database?",DATABASES)]}))});
  const asked=[],answers=[["pg-16"],["SQLite"],["Postgres"]];let permissions=0;
  const {session}=acpSession(t,fx,{runtime:"antigravity",permissionMode:"full",onPermission:async()=>{permissions++;return "accept"},onQuestion:async({input})=>{asked.push(input.questions);return {[input.questions[0].id]:answers.shift()}}});
  await session.start();
  for(const text of ["one","two","three"])await session.prompt([{type:"text",text}]);
  assert.deepEqual(asked[0],[{id:"interaction_1",header:"Question",question:"Which database?",multiSelect:false,allowCustomAnswer:false,options:[
    {value:"pg-15",label:"Postgres",description:""},{value:"pg-16",label:"Postgres",description:""},{value:"sqlite",label:"SQLite",description:""},
  ]}],"each choice carries its id once, and the question takes no words of the person's own");
  const replies=(await fx.log()).filter(entry=>entry.reply==="session/request_permission").map(entry=>entry.message);
  assert.deepEqual(replies,[
    {outcome:{outcome:"selected",optionId:"pg-16"}},
    {outcome:{outcome:"selected",optionId:"sqlite"}},
    {outcome:{outcome:"cancelled"}},
  ],"the chosen id is the answer; a name answers only when one choice has it");
  assert.equal(permissions,0,"even full access never answers Antigravity's question for the person");
});

test("Cursor's and Grok's questions still take the person's own words and carry no option ids",async t=>{
  const cursor=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[{request:{method:"cursor/ask_question",params:{toolCallId:"q",title:"Setup",questions:[{id:"lang",prompt:"Which language?",options:[{id:"js",label:"JavaScript"},{id:"py",label:"Python"}],allowMultiple:false}]}}}]}]});
  const asked=[];
  const c=acpSession(t,cursor,{runtime:"cursor",onQuestion:async({input})=>{asked.push(input.questions[0]);return {lang:["Python"]}}});
  await c.session.start();await c.session.prompt([{type:"text",text:"set up"}]);
  assert.deepEqual(replyTo(await cursor.log(),"cursor/ask_question"),{outcome:{outcome:"answered",answers:[{questionId:"lang",selectedOptionIds:["py"]}]}});
  const grok=await scriptedAcp(t,{...GROK,prompts:[{steps:[{request:{method:"_x.ai/ask_user_question",params:{questions:[{question:"Proceed?",options:[{label:"Yes"},{label:"No"}]}]}}}]}]});
  const g=acpSession(t,grok,{runtime:"grok",onQuestion:async({input})=>{asked.push(input.questions[0]);return {"Proceed?":["Not yet"]}}});
  await g.session.start();await g.session.prompt([{type:"text",text:"go"}]);
  assert.deepEqual(replyTo(await grok.log(),"_x.ai/ask_user_question"),{outcome:"accepted",answers:{"Proceed?":["Other"]},annotations:{"Proceed?":{notes:"Not yet"}}});
  for(const question of asked){
    assert.equal("allowCustomAnswer" in question,false,question.question);
    assert.ok(question.options.every(option=>!("value" in option)),question.question);
  }
});

test("the relay asks the app an Antigravity question as one that takes only its choices, and the chosen id reaches Antigravity",async t=>{
  const fx=await scriptedAcp(t,{...ANTIGRAVITY,prompts:[{steps:[ask("interaction_1","Which database?",DATABASES.slice(0,3))]}]});
  const {ws,rpc,next}=await acpRelay(t,"antigravity",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  const asked=next(message=>message.method==="item/tool/requestUserInput"),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"set up the database"}]});
  const request=await asked;
  assert.deepEqual(request.params.questions,[{id:"interaction_1",header:"Question",question:"Which database?",required:true,allowMultiple:false,allowCustomAnswer:false,options:[
    {label:"Postgres",description:"",value:"pg-15"},{label:"Postgres",description:"",value:"pg-16"},{label:"SQLite",description:"",value:"sqlite"},
  ]}]);
  ws.send(JSON.stringify({id:request.id,result:{answers:{interaction_1:{answers:["pg-16"]}}}}));
  assert.equal((await completed).params.turn.status,"completed");
  assert.deepEqual(replyTo(await fx.log(),"session/request_permission"),{outcome:{outcome:"selected",optionId:"pg-16"}});
});

test("the relay asks the app a Cursor question as before: the person's own words allowed and no option ids",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[{request:{method:"cursor/ask_question",params:{toolCallId:"q",title:"Setup",questions:[{id:"lang",prompt:"Which language?",options:[{id:"js",label:"JavaScript"},{id:"py",label:"Python"}],allowMultiple:false}]}}}]}]});
  const {ws,rpc,next}=await acpRelay(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  const asked=next(message=>message.method==="item/tool/requestUserInput"),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"set up"}]});
  const request=await asked;
  assert.deepEqual(request.params.questions,[{id:"lang",header:"Setup",question:"Which language?",required:true,allowMultiple:false,options:[{label:"JavaScript",description:""},{label:"Python",description:""}]}]);
  ws.send(JSON.stringify({id:request.id,result:{answers:{lang:{answers:["Python"]}}}}));
  assert.equal((await completed).params.turn.status,"completed");
  assert.deepEqual(replyTo(await fx.log(),"cursor/ask_question"),{outcome:{outcome:"answered",answers:[{questionId:"lang",selectedOptionIds:["py"]}]}});
});
