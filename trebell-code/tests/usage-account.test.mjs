import test from "node:test";
import assert from "node:assert/strict";
import {
  codexRateLimitEntries,
  formatRateReset,
  microsToCurrency,
  rateLimitReachedLabel,
  rateLimitRemainingPercent,
} from "../ui/src/usage-account.js";
import { estimateUsageCost } from "../ui/src/usage-pricing.js";

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

test("Native custom-model cost estimates stay scoped to the recorded inference provider",()=>{
  const settings={customModels:[
    {id:"shared-model",runtime:"native",provider:"agentrouter",inputPrice:1,outputPrice:2},
    {id:"shared-model",runtime:"native",provider:"hcnsec",inputPrice:10,outputPrice:20},
  ]};
  const base={runtime:"native",model:"shared-model",usage:{inputTokens:1_000_000,outputTokens:1_000_000}};
  assert.deepEqual(estimateUsageCost({...base,provider:"agentrouter"},settings),{amount:3,estimated:true});
  assert.deepEqual(estimateUsageCost({...base,provider:"hcnsec"},settings),{amount:30,estimated:true});
  assert.equal(estimateUsageCost({...base,provider:"vyceai"},settings),null);
  assert.deepEqual(estimateUsageCost({...base,provider:"vyceai",cost:{currency:"USD",amount:4.25}},settings),{amount:4.25,estimated:false});
});
