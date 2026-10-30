import test from "node:test";
import assert from "node:assert/strict";
import { codexErrorNotice, codexTurnFailure } from "../ui/src/codex-turn-options.js";
import { turnFailureText } from "../ui/src/turn-outcome.js";

// Codex retries a request that fails, and when its retries run out it says why only with the last attempt's HTTP status
// (codexErrorInfo {responseTooManyFailedAttempts:{httpStatusCode}}). One that ended on 429 is a usage or rate limit, which
// Trebell said as a plain provider error, without pointing the person to Usage.
const exhausted=httpStatusCode=>({message:`exceeded retry limit, last status: ${httpStatusCode} Too Many Requests`,codexErrorInfo:{responseTooManyFailedAttempts:{httpStatusCode}},additionalDetails:null});
const USAGE=" · See Usage for your Codex limits.";

test("a Codex turn whose retries ran out on HTTP 429 fails as a usage limit and points to Usage",()=>{
  const notice=codexErrorNotice({threadId:"t",turnId:"u",willRetry:false,error:exhausted(429)});
  assert.equal(notice.code,"responseTooManyFailedAttempts");
  assert.equal(notice.kind,"usage_limit");
  assert.equal(notice.hint,"See Usage for your Codex limits.");
  assert.equal(notice.title,"exceeded retry limit, last status: 429 Too Many Requests"+USAGE);
  assert.equal(codexTurnFailure({id:"u",status:"failed",error:exhausted(429)}).title,"exceeded retry limit, last status: 429 Too Many Requests"+USAGE);
  // The row the turn leaves once its card moves on, and after a reload, says the same.
  assert.equal(turnFailureText({status:"failed",error:exhausted(429)}),"exceeded retry limit, last status: 429 Too Many Requests"+USAGE);
  assert.equal(turnFailureText({status:"failed",error:{message:"",codexErrorInfo:{responseTooManyFailedAttempts:{httpStatusCode:429}}}}),"Agent error"+USAGE);
});

test("retries that ran out on another status, or on none, stay a provider error, and a retry still on its way reads as one",()=>{
  for(const httpStatusCode of [500,503,401,null,undefined]){
    const error={message:"exceeded retry limit",codexErrorInfo:{responseTooManyFailedAttempts:httpStatusCode===undefined?{}:{httpStatusCode}}};
    const notice=codexErrorNotice({willRetry:false,error});
    assert.deepEqual({kind:notice.kind,hint:notice.hint,title:notice.title},{kind:"provider",hint:"",title:"exceeded retry limit"},String(httpStatusCode));
    assert.equal(turnFailureText({status:"failed",error}),"exceeded retry limit",String(httpStatusCode));
  }
  assert.equal(codexErrorNotice({error:{message:"exceeded retry limit",codexErrorInfo:"responseTooManyFailedAttempts"}}).kind,"provider","a bare code says no status");
  // Codex still retrying the request: the turn goes on, so the notice reads as the retry it is, with no hint.
  const retrying=codexErrorNotice({willRetry:true,error:{...exhausted(429),message:"Reconnecting... 2/5"}});
  assert.equal(retrying.title,"Retrying (2/5): Reconnecting... 2/5");
  // Usage and rate limits and transport failures read as before.
  assert.equal(codexErrorNotice({error:{message:"You've hit your usage limit.",codexErrorInfo:"usageLimitExceeded"}}).kind,"usage_limit");
  assert.equal(codexErrorNotice({error:{message:"stream error",codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:429}}}}).kind,"transport");
});
