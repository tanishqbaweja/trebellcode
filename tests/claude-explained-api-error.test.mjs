// The words of an API error Claude Code explains in its own reply (an unknown model, a bad request, a billing or account problem)
// keep no secret they repeat, as its result's "API Error: …" text keeps none. The
// turn's error and Git text written through Claude Code both read them through claudeExplainedApiError. The SDK is scripted.
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentSession, claudeExplainedApiError } from "../src/claude-agent-session.mjs";
import { scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const TOKEN="tok-live-5f2c9a81e7d34b06",KEY="sk-ant-api03-Zx81fixturekey0042";
const WORDS=`There's an issue with the selected model (claude-gone-9). It may not exist or you may not have access to it. {"error":{"request":{"token":"${TOKEN}"}},"headers":"Authorization: Bearer ${TOKEN}","api_key":"${KEY}"}`;
const frame={type:"assistant",uuid:"err-1",parent_tool_use_id:null,error:"model_not_found",message:{id:"m-err",content:[{type:"text",text:WORDS}]}};
const clean=text=>!text.includes(TOKEN)&&!text.includes(KEY);

test("an API error Claude Code explains keeps its words without the secrets they repeat",async()=>{
  const shown=claudeExplainedApiError(frame);
  assert.ok(clean(shown),shown);
  assert.match(shown,/^There's an issue with the selected model \(claude-gone-9\)\. It may not exist or you may not have access to it\. /);
  assert.match(shown,/"token":"\[redacted\]"/);
  for(const error of ["invalid_request","billing_error","oauth_org_not_allowed"])assert.ok(clean(claudeExplainedApiError({...frame,error})),error);
  assert.equal(claudeExplainedApiError({...frame,error:"server_error"}),null,"a retried failure is not explained");

  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{
    emit(frame);
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:404,result:WORDS,user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:0}});
  }});
  const claude=new ClaudeAgentSession({cwd:process.cwd(),sdk,onUpdate:()=>{}});await claude.start();
  await assert.rejects(()=>claude.prompt([{type:"text",text:"Summarize the parser"}]),error=>clean(error.message)&&error.message.startsWith("There's an issue with the selected model (claude-gone-9)."));
});
