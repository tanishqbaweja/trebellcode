import test from "node:test";
import assert from "node:assert/strict";
import {
  codexRateLimitEntries,
  formatRateReset,
  microsToCurrency,
  rateLimitReachedLabel,
  rateLimitRemainingPercent,
} from "../ui/src/usage-account.js";

test("Codex rate-limit helpers prefer named multi-bucket snapshots",()=>{
  const response={
    rateLimits:{limitId:"legacy",limitName:"Legacy"},
    rateLimitsByLimitId:{
      codex:{limitId:"codex",limitName:"Codex",primary:{usedPercent:37}},
      review:{limitId:"review",primary:{usedPercent:80}},
    },
  };
  assert.deepEqual(codexRateLimitEntries(response).map(item=>[item.id,item.label]),[["codex","Codex"],["review","review"]]);
  assert.equal(rateLimitRemainingPercent(response.rateLimitsByLimitId.codex.primary),63);
  assert.equal(rateLimitRemainingPercent({usedPercent:140}),0);
});

test("Codex usage helpers format protocol values without inventing missing data",()=>{
  assert.equal(formatRateReset(1060,1_000_000),"resets in 1m");
  assert.equal(formatRateReset(null,1_000_000),"reset time unavailable");
  assert.equal(microsToCurrency(2_500_000),2.5);
  assert.equal(microsToCurrency(null),null);
  assert.equal(rateLimitReachedLabel("workspaceMemberUsageLimitReached"),"Workspace usage limit reached");
});
