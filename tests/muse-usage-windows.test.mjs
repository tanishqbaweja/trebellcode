// Muse Code's subscription windows on the Usage page, as AgentRuntimeManager answers /api/agent-runtime-usage for a Muse Code
// profile: the windows of the last usage/changed report Muse Code's sessions keep for the account (museUsageReport, which reads the
// sessions' own store by the Muse home the profile's status check found), a 5-hour row named by the window length Muse reports and a
// Weekly row, each with its reset and its percentage held to 0-100 (Meta's may exceed 100), and the time the report was observed;
// nothing before a report, and nothing of a window whose reset has passed since. No command runs and nothing is fetched for it: MSP's
// usage/read answers only the host's last report too, with no model call. The report has the shape of Muse 1.4's usage/changed.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";

const REPORT=Object.freeze({observedAtMs:1791447762610,tier:"tier-1",window:{usedPercent:0,windowDurationMins:300,resetsAtMs:1791465557000},weekly:{usedPercent:5,resetsAtMs:1791763200000}});
const OBSERVED="2026-10-08T08:22:42.610Z",WINDOW_RESET="2026-10-08T13:19:17.000Z",WEEKLY_RESET="2026-10-12T00:00:00.000Z";
const NOT_OBSERVED="Muse Code has not reported its subscription windows yet. They show here once a Muse Code turn in Trebell Code reports them.";
const ALL_RESET="Muse Code's subscription windows have reset since its last report. They show here again once a Muse Code turn in Trebell Code reports them.";
const report=(patch={})=>({...REPORT,...patch,window:{...REPORT.window,...patch.window},weekly:{...REPORT.weekly,...patch.weekly}});

// A manager with two Muse Code profiles, its clock at clock.now, that records every command it would run, every fetch, and each read
// of the sessions' store (asked: the Muse home it was asked for), which answers stored.
function museManager({environments=null,activeEnvironmentId=null}={}){
  const clock={now:REPORT.observedAtMs+60_000},ran=[],fetched=[],asked=[],store={report:null};
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",activeEnvironmentId,agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,environment:{}},{id:"muse-work",kind:"muse",displayName:"Muse work",enabled:true,environment:{}}]};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},environments,env:{PATH:""},platform:"win32",now:()=>clock.now,
    runFn:async command=>{ran.push(command);return {ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}},
    fetchImpl:async url=>{fetched.push(String(url));return new Response("{}",{status:404})}});
  manager.museUsageReport=({museHome=null}={})=>{asked.push(museHome);return store.report};
  const profile=id=>manager.instances().find(item=>item.id===id);
  return {manager,clock,ran,fetched,asked,store,limits:(id="muse-default")=>manager.usageLimits(profile(id))};
}

test("before a Muse Code turn reports its windows the Usage card says none came yet, and reading it runs and fetches nothing",async()=>{
  const fx=museManager();
  assert.deepEqual(await fx.limits(),{checkedAt:new Date(fx.clock.now).toISOString(),windows:[],unavailable:{reason:"notObserved",message:NOT_OBSERVED}});
  assert.deepEqual(await fx.manager.usageLimits("muse"),await fx.limits(),"by its kind it is the default profile's");
  // No status check found the profile's Muse home yet: the newest report of any is asked for.
  assert.deepEqual(fx.asked,[null,null,null]);
  assert.deepEqual([fx.ran,fx.fetched],[[],[]]);
});

test("the sessions' last usage/changed becomes a 5-hour row with the length Muse reports and a Weekly row, with their resets, the percentages held to 0-100 and the time it was observed",async()=>{
  const fx=museManager();fx.store.report=report({window:{usedPercent:103}});
  assert.deepEqual(await fx.limits(),{checkedAt:new Date(fx.clock.now).toISOString(),observedAt:OBSERVED,windows:[
    {id:"window",kind:"session",label:"5-hour",windowDurationMins:300,usedPercent:100,resetsAt:WINDOW_RESET},
    {id:"weekly",kind:"weekly",label:"Weekly",windowDurationMins:10_080,usedPercent:5,resetsAt:WEEKLY_RESET},
  ]});
  // The next report the sessions keep shows at the next read, its window named by the length it reports.
  fx.store.report=report({observedAtMs:REPORT.observedAtMs+1000,window:{usedPercent:42.5,windowDurationMins:240},weekly:{usedPercent:141}});
  const next=await fx.limits();
  assert.deepEqual(next.windows.map(row=>[row.label,row.windowDurationMins,row.usedPercent]),[["4-hour",240,42.5],["Weekly",10_080,100]]);
  assert.equal(next.observedAt,new Date(REPORT.observedAtMs+1000).toISOString());
  assert.deepEqual([fx.ran,fx.fetched],[[],[]],"no command and no fetch: the windows are the last report's");
});

test("a window whose reset has passed since the report is left out, and with both past the card says they have reset",async()=>{
  const fx=museManager();fx.store.report=report({window:{usedPercent:103}});
  fx.clock.now=REPORT.window.resetsAtMs;
  assert.deepEqual((await fx.limits()).windows.map(row=>row.label),["Weekly"]);
  fx.clock.now=REPORT.weekly.resetsAtMs+1;
  assert.deepEqual(await fx.limits(),{checkedAt:new Date(fx.clock.now).toISOString(),observedAt:OBSERVED,windows:[],unavailable:{reason:"notObserved",message:ALL_RESET}});
});

test("a Muse Code in a WSL or SSH environment has no windows of Trebell's: it runs only on this machine",async()=>{
  const environments={get:id=>id==="ssh-fixture"?{id,type:"ssh",cwd:"/srv/app"}:null,executeArgv:async()=>{throw new Error("nothing runs on the host")},spawnArgv:()=>{throw new Error("nothing starts on the host")}};
  const fx=museManager({environments,activeEnvironmentId:"ssh-fixture"});fx.store.report=REPORT;
  assert.deepEqual((await fx.limits()).unavailable,{reason:"unsupported",message:"Muse Code runs only on this machine in Trebell Code. Switch to the local environment to use it."});
  assert.deepEqual((await fx.manager.usageLimits(fx.manager.instances().find(item=>item.id==="muse-default"),{environmentId:null})).windows.map(row=>row.label),["5-hour","Weekly"],"the same profile on this machine");
});
