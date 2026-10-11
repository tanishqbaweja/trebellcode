import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NATIVE_REPLY_STREAM } from "../src/native-agent-session.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { nativeStreamOptions } from "../src/native-reply-streaming.mjs";
import { BENCHMARK_PATH_FIXTURE_URL, BENCHMARK_PATH_SCENARIOS, runBenchmarkPathScenario, stripTiming } from "./fixtures/native-benchmark-path-harness.mjs";

// The golden record (native-benchmark-path-parity.test.mjs, never edited) drops every key named like a time, so it also drops the
// retry delay the runner writes into its events, and the timeouts the provider path arms never reach a record at all: a halved
// request or idle timeout left it unchanged. This pins them on the same five scenarios and the same wiring, and again with drafts
// on: each setTimeout, setInterval and AbortSignal.timeout the path arms, read with performance.now held still so a deadline reads
// as its whole budget; each value the golden strip drops that is a setting rather than a measured time; and how long the
// WebSocket lane stays shut after a failed call.
const fixture=JSON.parse(await readFile(BENCHMARK_PATH_FIXTURE_URL,"utf8"));
// The harness's timing strip, and the keys under it that hold measured times, which differ from run to run.
const TIMING_KEY=/Ms$|Latency|At$|^at$|^created$/,MEASURED_KEY=/^(?:at|created|durationMs|timeToFirstTokenMs|totalLatencyMs|responseHeadersLatencyMs|responseBodyLatencyMs)$|At$/;
function settingsOf(value,path,out=[]){
  if(Array.isArray(value)){for(const child of value)settingsOf(child,path,out);return out}
  if(!value||typeof value!=="object")return out;
  for(const [key,child] of Object.entries(value)){if(!TIMING_KEY.test(key))settingsOf(child,path+"."+key,out);else if(!MEASURED_KEY.test(key))out.push([path+"."+key,child])}
  return out;
}

// With drafts on, the path is wired as the app wires it (as in native-reply-streaming.test.mjs): the hook leaves the request and
// rides in the turn options.
const DRAFTS_WIRING={
  sessionOptions:{streamDrafts:true},
  prepareRequest:request=>{const {[NATIVE_REPLY_STREAM]:_hook,...providerRequest}=request;return providerRequest},
  turnOptions:request=>nativeStreamOptions("openai",request[NATIVE_REPLY_STREAM]),
};

async function observe(name,{drafts=false}={}){
  const wiring=drafts?DRAFTS_WIRING:{},timers=[],webSocketShutSeconds=[],events=[],updates=[],held=performance.now(),turn=ProviderManager.prototype.turn;
  const realSetTimeout=globalThis.setTimeout,realSetInterval=globalThis.setInterval,realSignalTimeout=AbortSignal.timeout;
  const note=(api,ms)=>{const last=timers.at(-1);if(last&&last[0]===api&&last[1]===ms)last[2]++;else timers.push([api,ms,1])};
  globalThis.setTimeout=function(callback,ms,...rest){note("setTimeout",ms);return realSetTimeout.call(this,callback,ms,...rest)};
  globalThis.setInterval=function(callback,ms,...rest){note("setInterval",ms);return realSetInterval.call(this,callback,ms,...rest)};
  AbortSignal.timeout=function(ms){note("AbortSignal.timeout",ms);return realSignalTimeout.call(this,ms)};
  Object.defineProperty(performance,"now",{configurable:true,writable:true,value:()=>held});
  ProviderManager.prototype.turn=function(...args){return turn.apply(this,args).catch(error=>{webSocketShutSeconds.push(Math.ceil(Math.max(0,Number(this.openAiResponsesWebSocketDisabledUntil||0)-this.nowFn())/1000));throw error})};
  let record;
  try{record=await runBenchmarkPathScenario(name,{...wiring,sessionOptions:{...wiring.sessionOptions,onEvent:event=>events.push(JSON.parse(JSON.stringify(event))),onUpdate:update=>updates.push(JSON.parse(JSON.stringify(update)))}})}
  finally{globalThis.setTimeout=realSetTimeout;globalThis.setInterval=realSetInterval;AbortSignal.timeout=realSignalTimeout;delete performance.now;ProviderManager.prototype.turn=turn}
  // The raw events and updates replaced the harness's own recorders; its record is rebuilt from them the way it records them.
  record.events=events.map(stripTiming);record.updates=updates.map(stripTiming);
  return {record,timers,settings:[...events.flatMap(event=>settingsOf(event,event.name)),...updates.flatMap(update=>settingsOf(update,"update"))],webSocketShutSeconds};
}

// Timers are [api, ms, how many in a row]: 12 s to open the WebSocket; the 300 s request budget, as the WebSocket idle timer
// (armed at the send and again at each event), the HTTPS headers deadline and the SSE idle timer (armed for each chunk); and the
// loop's first 250 ms retry wait. A failed call shuts the WebSocket lane for 30 s, which is why each retry goes over HTTPS.
const NO_WALL_TIME=["native.turn.started.data.maxWallTimeMs",null],RETRY_WAIT=[["native.model.retrying.data.delayMs",250],["native.model.retrying.data.retryAfterMs",null]];
const EXPECTED={
  websocket_tool_then_answer:{timers:[["setTimeout",12_000,1],["setTimeout",300_000,28]],settings:[NO_WALL_TIME],webSocketShutSeconds:[]},
  sse_tool_then_answer:{timers:[["setTimeout",300_000,30]],settings:[NO_WALL_TIME],webSocketShutSeconds:[]},
  websocket_server_error_then_https:{timers:[["setTimeout",12_000,1],["setTimeout",300_000,2],["setTimeout",250,1],["setTimeout",300_000,15]],settings:[NO_WALL_TIME,...RETRY_WAIT],webSocketShutSeconds:[30]},
  gate_lane_verdict:{timers:[["setTimeout",12_000,1],["setTimeout",300_000,38]],settings:[NO_WALL_TIME],webSocketShutSeconds:[]},
  websocket_drop_after_text_then_https:{timers:[["setTimeout",12_000,1],["setTimeout",300_000,10],["setTimeout",250,1],["setTimeout",300_000,15]],settings:[NO_WALL_TIME,...RETRY_WAIT],webSocketShutSeconds:[30]},
};

test("the timing pin covers every golden scenario",()=>{
  assert.deepEqual(Object.keys(EXPECTED).sort(),Object.keys(BENCHMARK_PATH_SCENARIOS).sort());
});

for(const name of Object.keys(BENCHMARK_PATH_SCENARIOS)){
  test("Harbor Native runner provider path keeps its timeouts and retry delays: "+name,async()=>{
    const observed=await observe(name);
    assert.deepEqual(observed.record,fixture[name]);
    assert.deepEqual(observed.timers,EXPECTED[name].timers);
    assert.deepEqual(observed.settings,EXPECTED[name].settings);
    assert.deepEqual(observed.webSocketShutSeconds,EXPECTED[name].webSocketShutSeconds);
  });
  // Spec C1: drafts change no OpenAI retry or timeout.
  test("with Native drafts on, the runner's provider path keeps the same timeouts and retry delays: "+name,async()=>{
    const observed=await observe(name,{drafts:true}),drafted=observed.record.updates.some(update=>String(update?.update?.sessionUpdate||"").startsWith("agent_message_draft_"));
    assert.equal(drafted,BENCHMARK_PATH_SCENARIOS[name].semanticCompletionGate!==true,"drafts stream unless the gate judges the prompt");
    assert.deepEqual(observed.timers,EXPECTED[name].timers);
    assert.deepEqual(observed.settings,EXPECTED[name].settings);
    assert.deepEqual(observed.webSocketShutSeconds,EXPECTED[name].webSocketShutSeconds);
  });
}

// The case the golden record missed: a provider whose request timeout is halved for every turn.
test("the timing pin notices a halved provider request timeout on the runner's path",async()=>{
  const turn=ProviderManager.prototype.turn;
  ProviderManager.prototype.turn=function(...args){this.requestTimeoutMs=150_000;return turn.apply(this,args)};
  try{
    for(const name of ["websocket_tool_then_answer","sse_tool_then_answer"]){
      const observed=await observe(name);
      assert.deepEqual(observed.timers,EXPECTED[name].timers.map(([api,ms,count])=>[api,ms===300_000?150_000:ms,count]),name);
    }
  }finally{ProviderManager.prototype.turn=turn}
});
