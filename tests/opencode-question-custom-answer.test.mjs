import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { FAKE_OPENCODE1_MODEL, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";
import { eventuallyReal as eventually, openCode1Relay } from "./fixtures/opencode1-relay.mjs";

// OpenCode 1.x's question tool says whether a question also takes the person's own words (custom, true unless it says false). Trebell
// dropped the flag, so the question card offered a typed answer OpenCode did not ask for (T3 Code's 04bd86951 keeps it).
const QUESTIONS=[
  {header:"Color",question:"Which color do you prefer?",options:[{label:"Red",description:"Warm"},{label:"Blue",description:"Cool"}],custom:false},
  {header:"Name",question:"What should the theme be called?",options:[{label:"Sunrise",description:"A morning theme"}]},
  {header:"Extras",question:"Which extras should it have?",options:[{label:"Icons",description:""},{label:"Fonts",description:""}],multiple:true,custom:true},
];

test("an OpenCode question that takes only its options reaches Trebell's question dialog as choices only, and its answers go back",async()=>{
  const asked=[];let reply=null;
  const fake=await startFakeOpenCode1({onPrompt:async({sessionID,emit,answered})=>{
    emit({type:"question.asked",properties:{id:"que_theme",sessionID,questions:QUESTIONS}});
    reply=await answered("que_theme");return "Theme made.";
  }});
  const session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fake.url,onUpdate:()=>{},onQuestion:async request=>{asked.push(request);return {q1:["Red"],q2:["Dawn"],q3:["Icons","Fonts"]}}});
  try{
    await session.start({model:FAKE_OPENCODE1_MODEL});
    await eventually(()=>fake.streams.size>0,{message:"the session did not subscribe to OpenCode's events"});
    assert.equal((await session.prompt([{type:"text",text:"Make a theme"}])).stopReason,"end_turn");
    assert.equal(asked.length,1);
    assert.deepEqual(asked[0].input.questions,[
      {id:"q1",header:"Color",question:"Which color do you prefer?",multiSelect:false,allowCustomAnswer:false,options:[{label:"Red",description:"Warm"},{label:"Blue",description:"Cool"}]},
      // Without the flag, or with custom true, the person's own words answer too.
      {id:"q2",header:"Name",question:"What should the theme be called?",multiSelect:false,options:[{label:"Sunrise",description:"A morning theme"}]},
      {id:"q3",header:"Extras",question:"Which extras should it have?",multiSelect:true,options:[{label:"Icons",description:""},{label:"Fonts",description:""}]},
    ]);
    assert.deepEqual(reply,{kind:"reply",answers:[["Red"],["Dawn"],["Icons","Fonts"]]});
  }finally{await session.close();await fake.close()}
});

test("an OpenCode question with custom false reaches the window's question card without a typed answer",async t=>{
  const relay=await openCode1Relay(t,{onPrompt:async({sessionID,emit,answered})=>{
    emit({type:"question.asked",properties:{id:"que_color",sessionID,questions:[QUESTIONS[0],QUESTIONS[1]]}});
    await answered("que_color");return "Noted.";
  }});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Ask me"}]});
  const asked=await eventually(()=>relay.messages.find(message=>message.method==="item/tool/requestUserInput"));
  assert.deepEqual(asked.params.questions,[
    {id:"q1",header:"Color",question:"Which color do you prefer?",required:true,allowMultiple:false,allowCustomAnswer:false,options:[{label:"Red",description:"Warm"},{label:"Blue",description:"Cool"}]},
    {id:"q2",header:"Name",question:"What should the theme be called?",required:true,allowMultiple:false,options:[{label:"Sunrise",description:"A morning theme"}]},
  ]);
  relay.ws.send(JSON.stringify({id:asked.id,result:{answers:{q1:{answers:["Blue"]},q2:{answers:["Nightfall"]}}}}));
  const completed=await relay.completed();
  assert.equal(completed.turn.status,"completed",completed.turn.error?.message);
  assert.deepEqual(relay.fake.called("POST /question/que_color/reply").map(call=>call.body),[{answers:[["Blue"],["Nightfall"]]}]);
});
