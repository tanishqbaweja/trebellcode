// Muse Code's subscription windows, as its host reports them in usage/changed (T3 Code's MuseSubscriptionUsage): account-wide, with
// no session, the windows the latest model response came with: {observedAtMs, tier, window {usedPercent, windowDurationMins,
// resetsAtMs}, weekly {usedPercent, resetsAtMs}}. Meta's percentages are verbatim and may exceed 100.

// The latest instant a JavaScript Date holds (T3 LATEST_DATE_MS).
const LATEST_DATE_MS=8.64e15;
const instant=value=>typeof value==="number"&&Number.isFinite(value)&&value>0&&value<=LATEST_DATE_MS;
const share=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0;
const clamped=value=>Math.max(0,Math.min(100,value));
const iso=ms=>new Date(ms).toISOString();

// A usage/changed report in Muse's form, or null for anything else, which is skipped (T3 decodes it, and keeps the last report).
export function museSubscriptionUsage(params){
  const window=params?.window,weekly=params?.weekly;
  if(!instant(params?.observedAtMs)||typeof params.tier!=="string")return null;
  if(!share(window?.usedPercent)||!(typeof window.windowDurationMins==="number"&&Number.isFinite(window.windowDurationMins)&&window.windowDurationMins>0)||!instant(window.resetsAtMs))return null;
  if(!share(weekly?.usedPercent)||!instant(weekly.resetsAtMs))return null;
  return {observedAtMs:params.observedAtMs,tier:params.tier,window:{usedPercent:window.usedPercent,windowDurationMins:window.windowDurationMins,resetsAtMs:window.resetsAtMs},weekly:{usedPercent:weekly.usedPercent,resetsAtMs:weekly.resetsAtMs}};
}

// A window's length as its row is named: Muse's 300 minutes are 5-hour.
const lengthLabel=minutes=>minutes%1440===0?`${minutes/1440}-day`:minutes%60===0?`${minutes/60}-hour`:`${minutes}-minute`;
const NOT_OBSERVED="Muse Code has not reported its subscription windows yet. They show here once a Muse Code turn in Trebell Code reports them.";
const ALL_RESET="Muse Code's subscription windows have reset since its last report. They show here again once a Muse Code turn in Trebell Code reports them.";

// What the Usage page shows of the last report, in the form every harness's windows take (agent-usage-limits.mjs): the rolling
// window, named by the length Muse reports, and the weekly one, each with its reset and its percentage held to 0-100 for the meter,
// and observedAt, the time the report was observed: it reflects only the latest model response, and no read asks Muse again (MSP's
// usage/read answers only the host's last report, with no model call). A window whose reset has passed since is left out, as what it
// holds now was never reported. Without a report it says that none came yet.
export function museUsageLimits(usage,{now=Date.now()}={}){
  const checkedAt=iso(now);
  if(!usage)return {checkedAt,windows:[],unavailable:{reason:"notObserved",message:NOT_OBSERVED}};
  const windows=[
    {id:"window",kind:"session",label:lengthLabel(usage.window.windowDurationMins),windowDurationMins:usage.window.windowDurationMins,usedPercent:clamped(usage.window.usedPercent),resetsAt:iso(usage.window.resetsAtMs),resetsAtMs:usage.window.resetsAtMs},
    {id:"weekly",kind:"weekly",label:"Weekly",windowDurationMins:7*24*60,usedPercent:clamped(usage.weekly.usedPercent),resetsAt:iso(usage.weekly.resetsAtMs),resetsAtMs:usage.weekly.resetsAtMs},
  ].filter(row=>row.resetsAtMs>now).map(({resetsAtMs,...row})=>row);
  const observedAt=iso(usage.observedAtMs);
  return windows.length?{checkedAt,observedAt,windows}:{checkedAt,observedAt,windows:[],unavailable:{reason:"notObserved",message:ALL_RESET}};
}
