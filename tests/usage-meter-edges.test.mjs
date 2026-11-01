// The edges of the usage readers (src/agent-usage-limits.mjs) that the other usage tests leave open: which Grok period names and
// bound forms count, the Claude Code answers that are refusals or rows, the model rows' ids, the spend budget's scale and currency,
// and Cursor's plan fields.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeUsageResponseToLimits, cursorUsageResponseToLimits, grokUsageResponseToLimits } from "../src/agent-usage-limits.mjs";

const at="2026-11-02T12:00:00.000Z";
const grok=(config)=>grokUsageResponseToLimits({config},at);
const claude=(limits,available=true)=>claudeUsageResponseToLimits({rate_limits_available:available,rate_limits:limits},at);
const cursor=(answer)=>cursorUsageResponseToLimits(answer,at);
const FAILED={reason:"probeFailed",message:"Claude Code could not read usage limits."};

test("a Grok period is weekly or monthly only by those names, with or without the enum prefix; any other name is the subscription",()=>{
  const end="2026-11-30T00:00:00Z",resetsAt="2026-11-30T00:00:00.000Z";
  assert.deepEqual(grok({creditUsagePercent:12,currentPeriod:{type:"WEEKLY",end}}).windows,[{id:"subscription",kind:"weekly",label:"Weekly",usedPercent:12,resetsAt}]);
  assert.deepEqual(grok({creditUsagePercent:12,currentPeriod:{type:"USAGE_PERIOD_TYPE_MONTHLY",end}}).windows,[{id:"subscription",kind:"monthly",label:"Monthly",usedPercent:12,resetsAt}]);
  for(const type of ["weekly","constructor","toString","USAGE_PERIOD_TYPE_USAGE_PERIOD_TYPE_WEEKLY","USAGE_PERIOD_TYPE_","USAGE_PERIOD_TYPE_DAILY",""])
    assert.deepEqual(grok({creditUsagePercent:12,currentPeriod:{type,end}}).windows,[{id:"subscription",kind:"other",label:"Subscription",usedPercent:12,resetsAt}],type);
});

test("a Grok percentage is read as a number: null is 0, numeric text counts, and the reset is the period's end however it is written",()=>{
  assert.deepEqual(grok({creditUsagePercent:null,currentPeriod:{type:"USAGE_PERIOD_TYPE_DAILY"}}).windows,[{id:"subscription",kind:"other",label:"Subscription",usedPercent:0}]);
  assert.deepEqual(grok({creditUsagePercent:"42",currentPeriod:{type:"MONTHLY",end:"2026-12-01"}}).windows,[{id:"subscription",kind:"monthly",label:"Monthly",usedPercent:42,resetsAt:"2026-12-01T00:00:00.000Z"}]);
  assert.deepEqual(grok({creditUsagePercent:-0,currentPeriod:{type:"WEEKLY",end:1796083200000}}).windows,[{id:"subscription",kind:"weekly",label:"Weekly",usedPercent:0,resetsAt:"2026-12-01T00:00:00.000Z"}]);
  assert.ok(Object.is(grok({creditUsagePercent:-0}).windows[0].usedPercent,0),"zero is +0");
  // Nothing to meter is still a read that worked: no refusal.
  assert.deepEqual(grokUsageResponseToLimits({config:{currentPeriod:{type:"USAGE_PERIOD_TYPE_DAILY",start:"2026-11-01T00:00Z",end:"2026-11-02T00:00Z"}}},at),{checkedAt:at,windows:[]});
});

test("a Grok period with nothing used is at 0% for every whole zoned ISO form of its bounds",()=>{
  const zero=(start,end)=>grok({currentPeriod:{type:"USAGE_PERIOD_TYPE_WEEKLY",start,end}}).windows.map(window=>[window.usedPercent,window.resetsAt]);
  assert.deepEqual(zero("2026-11-01T00:00:00Z","2026-11-07T24:00:00.000Z"),[[0,"2026-11-08T00:00:00.000Z"]],"the day's end, with seconds and a zero fraction");
  assert.deepEqual(zero("2026-11-01T09:00+05:30","2026-11-08T09:00-05:30"),[[0,"2026-11-08T14:30:00.000Z"]],"offsets");
  assert.deepEqual(zero("2024-02-29T00:00Z","2024-03-07T00:00Z"),[[0,"2024-03-07T00:00:00.000Z"]],"a leap day");
  assert.deepEqual(zero("2000-02-29T23:59:59.999999Z","2000-03-07T00:00Z"),[[0,"2000-03-07T00:00:00.000Z"]],"a leap day of a year divisible by 400, and a fine fraction");
  assert.deepEqual(zero("-271821-04-20T00:00Z","+002026-11-08T00:00Z"),[[0,"2026-11-08T00:00:00.000Z"]],"the first day a JavaScript date holds, and signed years");
  assert.deepEqual(zero("-271821-04-19T23:00-05:00","2026-11-08T00:00Z"),[],"a day before it, even at a time after it");
});

test("a Grok bound that is not a whole zoned ISO date-time on a real day leaves the period without a meter",()=>{
  const start="2026-11-01T00:00:00Z",end="2026-11-08T00:00:00Z";
  for(const [from,to] of [
    ["2023-02-29T00:00Z",end],["1900-02-29T00:00Z",end],["2026-11-31T00:00Z","2026-12-08T00:00Z"],
    [start,"2026-11-07T24:00:00.5Z"],[start,"2026-11-07T24:01Z"],[start,"2026-11-08T00:00z"],["2026-11-01t00:00Z",end],
    ["-000000-11-01T00:00Z",end],[start,"+275760-09-14T00:00+05:00"],["2026-11-01T00:00.5Z",end],["2026-11-01T00:00:60Z",end],
    [start,"2026-11-08T00:00+24:00"],["2026-11-01T00:00:00+0530",end],[start,end+"\n"],[start,"2026-11-08T00:00:00.Z"],
    ["2026-11-01T0:00Z",end],["02026-11-01T00:00Z",end],["+2026-11-01T00:00Z",end],["2026-11-01T00:00:00+05:30Z",end],
  ])assert.deepEqual(grok({currentPeriod:{type:"WEEKLY",start:from,end:to}}).windows,[],from+" "+to);
});

test("Claude Code's answer is a refusal unless plan limits apply and came as an object",()=>{
  assert.deepEqual(claude({five_hour:{utilization:50,resets_at:null}},false),{checkedAt:at,windows:[],unavailable:{reason:"unsupported"}},"limits sent where none apply are not read");
  for(const limits of ["limits",7,()=>({}),true])assert.deepEqual(claude(limits),{checkedAt:at,windows:[],unavailable:FAILED},typeof limits);
  assert.deepEqual(claude({},"yes"),{checkedAt:at,windows:[]},"any true value says they apply");
  assert.deepEqual(claude([]),{checkedAt:at,windows:[]});
});

// Re-pinned: a model window's id was "seven_day_" and its name's ASCII letters and digits joined by "_"; it is now "weekly:" and
// the words of its name in any script joined by "-", and no two rows of one answer share an id.
test("Claude Code's rows: the session and weekly windows by type of utilization, then the model windows with ids made from their names",()=>{
  const windows=claude({
    seven_day_opus:{utilization:40,resets_at:null},seven_day_sonnet:{utilization:41,resets_at:null},
    five_hour:{utilization:Number.NaN,resets_at:"2026-11-02T15:00:00Z"},seven_day:{utilization:"12",resets_at:null},
    model_scoped:[
      {display_name:" Opus -- 4.7 ",utilization:-3,resets_at:null},
      {display_name:"Ünïcode Name",utilization:250,resets_at:"2026-11-07T00:00:00Z"},
      {display_name:7,utilization:1},{display_name:"Haiku",utilization:null},null,
    ],
  }).windows;
  assert.deepEqual(windows,[
    {id:"five_hour",kind:"session",label:"Session",windowDurationMins:300,usedPercent:null,resetsAt:"2026-11-02T15:00:00.000Z"},
    {id:"weekly:opus-4-7",kind:"weekly",label:"Weekly ·  Opus -- 4.7 ",windowDurationMins:10080,usedPercent:0},
    {id:"weekly:ünïcode-name",kind:"weekly",label:"Weekly · Ünïcode Name",windowDurationMins:10080,usedPercent:100,resetsAt:"2026-11-07T00:00:00.000Z"},
  ]);
  assert.deepEqual(claude({model_scoped:{display_name:"Fable",utilization:5}}).windows,[],"model windows come only as a list");
  const twice=claude({model_scoped:[{display_name:"Opus 4.7",utilization:1},{display_name:"opus-4.7",utilization:2},{display_name:"OPUS 4 7",utilization:3}]}).windows;
  assert.deepEqual(twice.map(window=>window.id),["weekly:opus-4-7","weekly:opus-4-7~2","weekly:opus-4-7~3"],"names with the same words still give each card its own id");
});

test("Claude Code's spend budget is read in one trimmed currency and one scale, and extra usage stands in for it otherwise",()=>{
  const money=(amount_minor,currency="EUR",exponent=2)=>({amount_minor,currency,exponent});
  const spend=(used,limit)=>({spend:{enabled:true,used,limit,percent:30}});
  const off={extra_usage:{is_enabled:false,used_credits:1,monthly_limit:2,utilization:50}};
  const row=usedPercent=>[{id:"monthly_spend",kind:"monthly",label:"Monthly spend",usedPercent}];
  assert.deepEqual(claude({...spend(money(2500," EUR "),money(10000)),...off}).windows,row(25),"its exact amounts, not its rounded percent");
  assert.deepEqual(claude({...spend(money(2500,"EUR",2),money(10000,"EUR",3)),...off}).windows,[],"another scale");
  assert.deepEqual(claude({...spend(money(2500,"EUR"),money(10000,"USD")),...off}).windows,[],"another currency");
  assert.deepEqual(claude({...spend(money(2500,"  "),money(10000,"  ")),extra_usage:{is_enabled:true,used_credits:200,monthly_limit:0,utilization:250}}).windows,row(100),
    "a blank currency is not money; extra usage without a limit gives its utilization, held to 100");
  assert.deepEqual(claude({...spend(money(1.5),money(10000)),extra_usage:{is_enabled:true,used_credits:300,monthly_limit:1200,utilization:3}}).windows,row(25),
    "a fractional minor amount is not money; extra usage's credits against its limit come before its utilization");
  assert.deepEqual(claude({...spend(money(1),money(3)),...off}).windows,row(1/3*100),"used over limit, then times 100");
  assert.deepEqual(claude({extra_usage:{is_enabled:true,used_credits:null,monthly_limit:null,utilization:-4}}).windows,[]);
  assert.deepEqual(claude({extra_usage:{is_enabled:"true",used_credits:1,monthly_limit:2,utilization:50}}).windows,[],"enabled only by true");
});

test("Cursor's plan fields count as numbers, null as 0, and without a usable plan the meter is unsupported",()=>{
  assert.deepEqual(cursor({planUsage:{totalPercentUsed:null,autoPercentUsed:"abc",apiPercentUsed:"33.5"}}).windows,[
    {id:"totalPercentUsed",kind:"monthly",label:"Monthly",usedPercent:0},
    {id:"apiPercentUsed",kind:"monthly",label:"Monthly · API",usedPercent:33.5},
  ]);
  assert.deepEqual(cursor({billingCycleEnd:"2026-12-01T00:00:00Z",planUsage:{autoPercentUsed:-0}}).windows,[{id:"autoPercentUsed",kind:"monthly",label:"Monthly · Auto",usedPercent:0,resetsAt:"2026-12-01T00:00:00.000Z"}]);
  assert.ok(Object.is(cursor({planUsage:{autoPercentUsed:-0}}).windows[0].usedPercent,0),"zero is +0");
  for(const answer of [{planUsage:null,billingCycleEnd:"1796083200000"},{},{planUsage:{}},{planUsage:"72"},null])
    assert.deepEqual(cursor(answer),{checkedAt:at,windows:[],unavailable:{reason:"unsupported"}},JSON.stringify(answer));
});
