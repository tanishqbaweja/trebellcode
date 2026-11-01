import test from "node:test";
import assert from "node:assert/strict";
import { retryNotice, retryReason } from "../src/retry-notice.mjs";
import { museRetryNotice } from "../src/muse-agent-session.mjs";

// The retry row of a harness that sends a failed model request again by itself: what failed, then who sends what again, in how
// many seconds, and which try it is.
test("a retry row says what failed, then who sends the request again, when, and which try it is",()=>{
  assert.equal(retryNotice({reason:"429 Too Many Requests",sender:"Muse Code",seconds:2.4,which:"try 2 of 3"}),"429 Too Many Requests. Muse Code sends the request again in 2 s, as try 2 of 3.");
  assert.equal(retryNotice({reason:"Overloaded",sender:"OpenCode",what:"it",seconds:0.2,which:"retry 4"}),"Overloaded. OpenCode sends it again in 1 s, as retry 4.","a wait under a second reads as 1 s");
  assert.equal(retryNotice({reason:"x",sender:"S",seconds:Number.NaN,which:"retry 1"}),"x. S sends the request again in 1 s, as retry 1.");
});

test("a reason is one line without the full stops it ends with",()=>{
  assert.equal(retryReason("  stream\n  closed  before\tdone...  "),"stream closed before done");
  assert.equal(retryReason("Version 2.1. Try later."),"Version 2.1. Try later");
  assert.equal(retryReason("Rate limited. .\n."),"Rate limited","full stops with blanks between them all go, so the row has one");
  assert.equal(retryReason("..."),"");
  assert.equal(retryReason(" . . "),"");
  assert.equal(retryReason(null),"");
});

test("Muse's turn/retryScheduled reads as a retry row, and one Trebell cannot read gives none",()=>{
  const notice={turnId:"t1",nextAttempt:2,maxAttempts:3,retryDelayMs:2_000,reason:"429 Too Many Requests"};
  assert.equal(museRetryNotice(notice),"429 Too Many Requests. Muse Code sends the request again in 2 s, as try 2 of 3.");
  assert.equal(museRetryNotice({...notice,retryDelayMs:0,reason:"Bad gateway.\n"}),"Bad gateway. Muse Code sends the request again in 1 s, as try 2 of 3.");
  for(const [label,change] of [["no turn",{turnId:""}],["no reason",{reason:"  "}],["a reason of full stops only",{reason:".."}],["a try of 0",{nextAttempt:0}],
    ["a try that is not whole",{maxAttempts:2.5}],["a wait below 0",{retryDelayMs:-1}],["a wait that is no number",{retryDelayMs:"2000"}],["an endless wait",{retryDelayMs:Infinity}]])
    assert.equal(museRetryNotice({...notice,...change}),null,label);
  assert.equal(museRetryNotice(),null);assert.equal(museRetryNotice(null),null);
});
