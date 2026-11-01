import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { FAKE_OPENCODE1_MODEL, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";
import { eventuallyReal as eventually, openCode1Relay } from "./fixtures/opencode1-relay.mjs";

// OpenCode 1.x's question tool says whether a question also takes the person's own words (custom, true unless it says false). Trebell
// dropped the flag, so the question card offered a typed answer OpenCode did not ask for.
// Three questions about publishing a build: one that takes only its options (custom false), one without the flag, and one with
// several answers and custom true.
const QUESTIONS=[
  {header:"Channel",question:"Which release channel should this build go out on?",options:[{label:"Stable",description:"Everyone gets it"},{label:"Beta",description:"Testers only"}],custom:false},
  {header:"Version",question:"What version number should the build carry?",options:[{label:"2.2.0",description:"The next minor release"}]},
  {header:"Notes",question:"What should the release notes cover?",options:[{label:"Fixes",description:""},{label:"Features",description:""}],multiple:true,custom:true},
];

test("an OpenCode question that takes only its options reaches Trebell's question dialog as choices only, and its answers go back",async()=>{
  const asked=[];let reply=null;
  const fake=await startFakeOpenCode1({onPrompt:async({sessionID,emit,answered})=>{
    emit({type:"question.asked",properties:{id:"que_release",sessionID,questions:QUESTIONS}});
    reply=await answered("que_release");return "Build published.";
  }});
  const session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fake.url,onUpdate:()=>{},onQuestion:async request=>{asked.push(request);return {q1:["Stable"],q2:["2.2.1"],q3:["Fixes","Features"]}}});
  try{
    await session.start({model:FAKE_OPENCODE1_MODEL});
    await eventually(()=>fake.streams.size>0,{message:"the session did not subscribe to OpenCode's events"});
    assert.equal((await session.prompt([{type:"text",text:"Publish the build"}])).stopReason,"end_turn");
    assert.equal(asked.length,1);
    assert.deepEqual(asked[0].input.questions,[
      {id:"q1",header:"Channel",question:"Which release channel should this build go out on?",multiSelect:false,allowCustomAnswer:false,options:[{label:"Stable",description:"Everyone gets it"},{label:"Beta",description:"Testers only"}]},
      // Without the flag, or with custom true, the person's own words answer too.
      {id:"q2",header:"Version",question:"What version number should the build carry?",multiSelect:false,options:[{label:"2.2.0",description:"The next minor release"}]},
      {id:"q3",header:"Notes",question:"What should the release notes cover?",multiSelect:true,options:[{label:"Fixes",description:""},{label:"Features",description:""}]},
    ]);
    assert.deepEqual(reply,{kind:"reply",answers:[["Stable"],["2.2.1"],["Fixes","Features"]]});
  }finally{await session.close();await fake.close()}
});

test("an OpenCode question with custom false reaches the window's question card without a typed answer",async t=>{
  const relay=await openCode1Relay(t,{onPrompt:async({sessionID,emit,answered})=>{
    emit({type:"question.asked",properties:{id:"que_channel",sessionID,questions:[QUESTIONS[0],QUESTIONS[1]]}});
    await answered("que_channel");return "Noted.";
  }});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Ask me"}]});
  const asked=await eventually(()=>relay.messages.find(message=>message.method==="item/tool/requestUserInput"));
  assert.deepEqual(asked.params.questions,[
    {id:"q1",header:"Channel",question:"Which release channel should this build go out on?",required:true,allowMultiple:false,allowCustomAnswer:false,options:[{label:"Stable",description:"Everyone gets it"},{label:"Beta",description:"Testers only"}]},
    {id:"q2",header:"Version",question:"What version number should the build carry?",required:true,allowMultiple:false,options:[{label:"2.2.0",description:"The next minor release"}]},
  ]);
  relay.ws.send(JSON.stringify({id:asked.id,result:{answers:{q1:{answers:["Beta"]},q2:{answers:["2.3.0-beta.1"]}}}}));
  const completed=await relay.completed();
  assert.equal(completed.turn.status,"completed",completed.turn.error?.message);
  assert.deepEqual(relay.fake.called("POST /question/que_channel/reply").map(call=>call.body),[{answers:[["Beta"],["2.3.0-beta.1"]]}]);
});
