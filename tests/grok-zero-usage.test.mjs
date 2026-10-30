// xAI's billing answer leaves the used percentage out until something is metered, while it still names the billing period. A
// weekly or monthly period whose start comes before its end is that period with nothing used yet, so Grok's meter shows it at 0%
// with the period's end as its reset. A period that is not whole, not ordered, not a real date or not weekly or
// monthly shows no meter, as before.
import test from "node:test";
import assert from "node:assert/strict";
import { grokUsageResponseToLimits } from "../src/agent-usage-limits.mjs";

const at="2026-09-16T00:00:00.000Z";
const WEEKLY={type:"USAGE_PERIOD_TYPE_WEEKLY",start:"2026-09-11T03:10:30.159171+00:00",end:"2026-09-18T03:10:30.159171+00:00"};
const windows=(currentPeriod,extra={})=>grokUsageResponseToLimits({config:{...extra,currentPeriod}},at).windows;

test("a whole weekly or monthly Grok period with no percentage is that period at 0%, resetting at its end",()=>{
  assert.deepEqual(windows(WEEKLY),[{id:"subscription",kind:"weekly",label:"Weekly",usedPercent:0,resetsAt:"2026-09-18T03:10:30.159Z"}]);
  assert.deepEqual(windows({type:"USAGE_PERIOD_TYPE_MONTHLY",start:"2026-09-01T00:00:00.000Z",end:"2026-10-01T00:00:00.000Z"}),
    [{id:"subscription",kind:"monthly",label:"Monthly",usedPercent:0,resetsAt:"2026-10-01T00:00:00.000Z"}]);
  assert.deepEqual(windows({type:"MONTHLY",start:"+002026-09-01T00:00Z",end:"2026-09-30T24:00:00Z"}),
    [{id:"subscription",kind:"monthly",label:"Monthly",usedPercent:0,resetsAt:"2026-10-01T00:00:00.000Z"}],"extended years, minutes-only times and 24:00 are ISO too");
});

test("a Grok period that is missing a bound, unordered, not a real date or not weekly or monthly shows no window",()=>{
  for(const currentPeriod of [
    undefined,
    {...WEEKLY,type:undefined},
    {...WEEKLY,type:"USAGE_PERIOD_TYPE_DAILY"},
    {...WEEKLY,start:undefined},
    {...WEEKLY,end:undefined},
    {...WEEKLY,start:"invalid"},
    {...WEEKLY,end:"invalid"},
    {...WEEKLY,start:" "+WEEKLY.start},
    {...WEEKLY,start:"2026-09-11"},
    {...WEEKLY,start:"2026-09-11T03:10:30"},
    {...WEEKLY,start:WEEKLY.end},
    {...WEEKLY,start:WEEKLY.end,end:WEEKLY.start},
    {...WEEKLY,start:"2026-02-30T00:00:00.000Z",end:"2026-03-09T00:00:00.000Z"},
    {...WEEKLY,start:"2026-02-23T00:00:00.000Z",end:"2026-02-30T00:00:00.000Z"},
    {...WEEKLY,start:null},
    {...WEEKLY,start:42},
  ])assert.deepEqual(windows(currentPeriod),[],JSON.stringify(currentPeriod));
});

test("a percentage Grok reports is shown as it is, whatever the period's start",()=>{
  for(const start of [WEEKLY.start,null,42,undefined])
    assert.deepEqual(windows({...WEEKLY,start},{creditUsagePercent:37.5}),[{id:"subscription",kind:"weekly",label:"Weekly",usedPercent:37.5,resetsAt:"2026-09-18T03:10:30.159Z"}],String(start));
  assert.deepEqual(windows(WEEKLY,{creditUsagePercent:120}).map(window=>window.usedPercent),[100]);
});
