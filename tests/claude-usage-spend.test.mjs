import test from "node:test";
import assert from "node:assert/strict";
import { claudeUsageResponseToLimits, readClaudeUsageLimits } from "../src/agent-usage-limits.mjs";

const at="2026-10-27T04:00:00.000Z";
// A Claude Code usage answer for an Enterprise seat with a monthly spend limit and no rolling windows (T3 Code's capture, #19433):
// $46.31 of $500.00, which the budget's own rounded percent calls 9.
const enterprise={
  rate_limits_available:true,
  rate_limits:{
    five_hour:null,seven_day:null,
    spend:{enabled:true,used:{amount_minor:4_631,currency:"USD",exponent:2},limit:{amount_minor:50_000,currency:"USD",exponent:2},percent:9},
    extra_usage:{is_enabled:true,used_credits:4_631,monthly_limit:50_000,utilization:9.261999999999999,currency:"USD",decimal_places:2},
  },
};
const withLimits=(limits,response=enterprise)=>({...response,rate_limits:{...response.rate_limits,...limits}});
const windowsOf=response=>claudeUsageResponseToLimits(response,at).windows;
function assertSpend(windows,percent,message){
  const spend=windows.find(window=>window.id==="monthly_spend");
  assert.ok(spend,message||"a Monthly spend row");
  assert.deepEqual({...spend,usedPercent:undefined},{id:"monthly_spend",kind:"monthly",label:"Monthly spend",usedPercent:undefined});
  assert.ok(Math.abs(spend.usedPercent-percent)<1e-9,`${spend.usedPercent} is ${percent}`);
}

test("Claude Code's plan usage that says limits apply but sent none is a read that failed, not an account without limits",async()=>{
  assert.deepEqual(claudeUsageResponseToLimits({rate_limits_available:true,rate_limits:null},at),{checkedAt:at,windows:[],unavailable:{reason:"probeFailed",message:"Claude Code could not read usage limits."}});
  assert.deepEqual(claudeUsageResponseToLimits({rate_limits_available:false,rate_limits:null},at),{checkedAt:at,windows:[],unavailable:{reason:"unsupported"}},"API keys, Bedrock and Vertex have no plan limits");
  const read=await readClaudeUsageLimits({readCapabilities:async()=>({usage:{session:{},rate_limits_available:true,rate_limits:null},usageError:null,checkedAt:at})});
  assert.deepEqual(read.unavailable,{reason:"probeFailed",message:"Claude Code could not read usage limits."});
  assert.deepEqual(claudeUsageResponseToLimits({rate_limits_available:true,rate_limits:{}},at),{checkedAt:at,windows:[]},"limits with nothing metered yet are an answer");
});

test("a Team or Enterprise monthly spend limit shows as a Monthly spend row, from the exact amounts beside the rolling windows",()=>{
  assert.deepEqual(claudeUsageResponseToLimits(enterprise,at).checkedAt,at);
  const alone=windowsOf(enterprise);
  assert.equal(alone.length,1);assertSpend(alone,9.262,"the spend budget alone fills the card");
  // The spend budget wins over extra usage, which here says something else, and follows the session window.
  const beside=windowsOf(withLimits({five_hour:{utilization:12,resets_at:null},extra_usage:{...enterprise.rate_limits.extra_usage,used_credits:30_000,utilization:60}}));
  assert.deepEqual(beside[0],{id:"five_hour",kind:"session",label:"Session",windowDurationMins:300,usedPercent:12});
  assert.equal(beside.length,2);assertSpend(beside,9.262);
  assertSpend(windowsOf(withLimits({spend:{...enterprise.rate_limits.spend,used:{amount_minor:80_000,currency:"USD",exponent:2}}})),100,"over the limit reads full");
});

test("without a usable spend budget the Monthly spend row comes from enabled extra usage: its credits, or else its utilization",()=>{
  // A disabled budget is not read, whatever it says.
  const disabled=withLimits({spend:{...enterprise.rate_limits.spend,enabled:false,used:{amount_minor:30_000,currency:"USD",exponent:2}},extra_usage:{...enterprise.rate_limits.extra_usage,utilization:9}});
  assertSpend(windowsOf(disabled),9.262,"extra usage's credits against its monthly limit");
  const utilizationOnly=withLimits({spend:{enabled:true,used:null,limit:null,percent:9},extra_usage:{...enterprise.rate_limits.extra_usage,used_credits:null,monthly_limit:null}});
  assertSpend(windowsOf(utilizationOnly),9.262,"extra usage's own utilization");
  // Amounts in two scales are not divided: 4631 cents is not 4631 of 50000 dollars.
  assertSpend(windowsOf(withLimits({spend:{...enterprise.rate_limits.spend,limit:{amount_minor:500,currency:"USD",exponent:0}},extra_usage:{...enterprise.rate_limits.extra_usage,used_credits:1_000}})),2,"another scale falls to extra usage");
});

test("no Monthly spend row for disabled budgets, money in two currencies or an empty limit without enabled extra usage",()=>{
  const noExtra={extra_usage:{...enterprise.rate_limits.extra_usage,is_enabled:false}};
  assert.deepEqual(windowsOf(withLimits({...noExtra,spend:{...enterprise.rate_limits.spend,enabled:false}})),[]);
  assert.deepEqual(windowsOf(withLimits({...noExtra,spend:{...enterprise.rate_limits.spend,limit:{...enterprise.rate_limits.spend.limit,currency:"EUR"}}})),[]);
  assert.deepEqual(windowsOf(withLimits({...noExtra,spend:{...enterprise.rate_limits.spend,limit:{...enterprise.rate_limits.spend.limit,amount_minor:0}}})),[]);
  assert.deepEqual(windowsOf(withLimits({spend:undefined,extra_usage:{is_enabled:true,used_credits:null,monthly_limit:null,utilization:null}})),[]);
  assert.deepEqual(windowsOf({rate_limits_available:true,rate_limits:{five_hour:{utilization:30,resets_at:null}}}).map(window=>window.id),["five_hour"],"a Pro or Max plan without spend data has no row for it");
});
