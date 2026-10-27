import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client } from "./fixtures/fake-opencode2-client.mjs";

// How an OpenCode 2 turn that OpenCode failed ends (T3 Code's 9b0435369 and 2f021ee7d): a provider's usage window or budget
// (provider.quota with HTTP 429, or provider.rate-limit) is a usage limit, whose failure says where to check it; an empty balance
// (provider.quota with HTTP 402) never resets, so it keeps OpenCode's own message, as does any other failure.
async function failedWith(error){
  const fake=fakeOpenCode2Client(),session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{}});
  await session.start({});
  try{
    const turn=session.prompt([{type:"text",text:"Hello"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"session.execution.failed",data:{sessionID:"ses_main",error}});
    return await turn.then(()=>assert.fail("the turn should have failed"),failure=>failure);
  }finally{await session.close()}
}

test("an OpenCode 2 quota stop or rate limit fails the turn as a usage limit that says to see Usage",async()=>{
  const quota=await failedWith({type:"provider.quota",status:429,message:"You have reached your OpenCode Go usage limit for this 5-hour window."});
  assert.equal(quota.message,"You have reached your OpenCode Go usage limit for this 5-hour window. See Usage for your OpenCode limits.");
  assert.equal(quota.usageLimit,true);
  // A quota stop OpenCode sent without a status is one too.
  const unstated=await failedWith({type:"provider.quota",message:"Monthly budget exhausted"});
  assert.equal(unstated.message,"Monthly budget exhausted. See Usage for your OpenCode limits.");assert.equal(unstated.usageLimit,true);
  const limited=await failedWith({type:"provider.rate-limit",status:429,message:"429 Too Many Requests"});
  assert.equal(limited.message,"429 Too Many Requests. See Usage for your OpenCode limits.");assert.equal(limited.usageLimit,true);
});

test("an OpenCode 2 empty balance (HTTP 402) and other failures keep OpenCode's own message, with no usage limit",async()=>{
  const balance=await failedWith({type:"provider.quota",status:402,message:"Insufficient balance. Add credits at https://opencode.ai/workspace/billing to keep going."});
  assert.equal(balance.message,"Insufficient balance. Add credits at https://opencode.ai/workspace/billing to keep going.");
  assert.equal(balance.usageLimit,undefined);
  const auth=await failedWith({type:"provider.auth",status:401,message:"Invalid API key"});
  assert.equal(auth.message,"Invalid API key");assert.equal(auth.usageLimit,undefined);
});
