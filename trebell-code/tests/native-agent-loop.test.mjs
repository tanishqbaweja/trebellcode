import test from "node:test";
import assert from "node:assert/strict";
import { nativeAgentBudget, nativeProviderRetryable, runNativeAgentTurn } from "../src/native-agent-loop.mjs";
const IMAGE_DATA_URL="data:image/png;base64,iVBORw0KGgo=";

test("native agent completes a plain model turn without inventing tool work",async()=>{
  const requests=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",provider:"fixture",messages:[{role:"user",content:"hello"}],tools:[],onEvent:event=>events.push(event),
    providerTurn:async request=>{requests.push(request);return {model:"test-model",provider:"fixture",text:"hello back",toolCalls:[],finishReason:"stop",usage:{inputTokens:3,outputTokens:2,totalTokens:5}}},
    executeTool:async()=>{throw new Error("tool executor should not run")},
  });
  assert.equal(requests.length,1);assert.equal(result.text,"hello back");assert.equal(result.modelTurns,1);assert.equal(result.toolCalls,0);
  assert.deepEqual(result.usage,{inputTokens:3,outputTokens:2,totalTokens:5,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0});
  assert.deepEqual(events.map(event=>event.name),["native.turn.started","native.model.requested","native.model.completed","native.turn.completed"]);
});

test("native agent feeds namespaced tool observations back into the same model loop",async()=>{
  const requests=[],executions=[];
  const result=await runNativeAgentTurn({
    model:"test-model",provider:"fixture",messages:[{role:"user",content:"find Session"}],tools:[{type:"namespace",name:"trebell_repo",tools:[]}],
    providerTurn:async request=>{
      requests.push(structuredClone(request));
      if(requests.length===1)return {model:"test-model",provider:"fixture",text:"I will inspect it.",toolCalls:[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}],finishReason:"tool_calls",usage:{inputTokens:10,outputTokens:3,totalTokens:13}};
      return {model:"test-model",provider:"fixture",text:"Session is in src/session.js",toolCalls:[],finishReason:"stop",usage:{inputTokens:14,outputTokens:5,totalTokens:19,cachedInputTokens:4,reasoningOutputTokens:2}};
    },
    executeTool:async call=>{executions.push(call);return {success:true,content:"src/session.js"}},
  });
  assert.equal(executions.length,1);assert.equal(executions[0].namespace,"trebell_repo");assert.equal(executions[0].name,"search_symbols");assert.deepEqual(executions[0].arguments,{query:"Session"});
  assert.equal(requests.length,2);const second=requests[1].messages;
  assert.equal(second.at(-2).role,"assistant");assert.equal(second.at(-2).toolCalls[0].id,"call-1");assert.equal(second.at(-1).role,"tool");assert.equal(second.at(-1).toolCallId,"call-1");assert.equal(second.at(-1).content,"src/session.js");
  assert.equal(result.text,"Session is in src/session.js");assert.equal(result.modelTurns,2);assert.equal(result.toolCalls,1);
  assert.deepEqual(result.usage,{inputTokens:24,outputTokens:8,totalTokens:32,cachedInputTokens:4,cacheWriteInputTokens:0,reasoningOutputTokens:2});
});

test("native agent turns tool failures into bounded observations instead of crashing the whole loop",async()=>{
  let turns=0;
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"run it"}],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"call-fail",namespace:"trebell_repo",name:"search_symbols",arguments:"not-json"}],usage:{}};
      assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/deliberate tool failure/i);
      return {text:"I handled the tool error.",toolCalls:[],usage:{}};
    },
    executeTool:async()=>{throw new Error("deliberate tool failure")},
  });
  assert.equal(result.text,"I handled the tool error.");assert.equal(result.modelTurns,2);assert.equal(result.toolCalls,1);
});

test("native agent trace preserves uncertain external tool outcomes",async()=>{
  let turns=0;const events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"send it"}],onEvent:event=>events.push(event),
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"call-uncertain",namespace:"trebell_browser",name:"click",arguments:'{"ref":"send"}'}],usage:{}};
      const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.match(observation.content,/outcome uncertain/i);assert.match(observation.content,/retrySafe/i);
      return {text:"I will inspect state before retrying.",toolCalls:[],usage:{}};
    },
    executeTool:async()=>({success:false,error:"Outcome uncertain: RPC timed out. Inspect the real-world state before repeating this action.",uncertain:true,retrySafe:false}),
  });
  const completed=events.find(event=>event.name==="native.tool.completed");
  assert.equal(completed.status,"uncertain");assert.equal(completed.data.success,false);assert.equal(completed.data.uncertain,true);assert.equal(completed.data.retrySafe,false);
  assert.equal(result.text,"I will inspect state before retrying.");
});

test("native agent preserves image tool observations for the next model turn",async()=>{
  let turns=0;
  const result=await runNativeAgentTurn({
    model:"vision-model",messages:[{role:"user",content:"What is on screen?"}],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"shot-1",namespace:"trebell_browser",name:"screenshot",arguments:"{}"}],usage:{}};
      const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.ok(Array.isArray(observation.content));assert.equal(observation.content[1].type,"image_url");assert.equal(observation.content[1].image_url.url,IMAGE_DATA_URL);
      return {text:"I can see the screenshot.",toolCalls:[],usage:{}};
    },
    executeTool:async()=>({success:true,contentItems:[{type:"inputText",text:"screen metadata"},{type:"inputImage",imageUrl:IMAGE_DATA_URL}]}),
  });
  assert.equal(result.text,"I can see the screenshot.");assert.equal(result.modelTurns,2);
});

test("native agent enforces model-turn and tool-call budgets before extra work starts",async()=>{
  let executions=0;
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"loop"}],maxToolCalls:0,
    providerTurn:async()=>({text:"",toolCalls:[{id:"call-1",name:"tool",arguments:"{}"}],usage:{}}),
    executeTool:async()=>{executions++;return "ok"},
  }),error=>error?.code==="native_tool_call_budget");
  assert.equal(executions,0);

  let turns=0;
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"loop"}],maxModelTurns:2,maxToolCalls:10,
    providerTurn:async()=>{turns++;return {text:"",toolCalls:[{id:"call-"+turns,name:"tool",arguments:"{}"}],usage:{}}},
    executeTool:async()=>"continue",
  }),error=>error?.code==="native_model_turn_budget");
  assert.equal(turns,2);
});

test("native agent wall-time budget aborts in-flight provider work and reports a budget failure",async()=>{
  const events=[];let providerAborted=false;
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"take too long"}],maxWallTimeMs:30,onEvent:event=>events.push(event),
    providerTurn:async({signal})=>new Promise((resolve,reject)=>{
      const aborted=()=>{providerAborted=true;const error=new Error("provider aborted");error.name="AbortError";reject(error)};
      if(signal.aborted)return aborted();signal.addEventListener("abort",aborted,{once:true});
      setTimeout(()=>resolve({text:"too late",toolCalls:[],usage:{}}),5_000);
    }),
    executeTool:async()=>"",
  }),error=>error?.code==="native_wall_time_budget"&&/wall-time budget exhausted/i.test(error.message));
  assert.equal(providerAborted,true);const blocked=events.find(event=>event.name==="native.turn.blocked"&&event.data?.reason==="native_wall_time_budget");assert.ok(blocked);assert.equal(blocked.data.maxWallTimeMs,30);
});

test("native agent cancellation stops before provider or later tool work",async()=>{
  const pre=new AbortController();pre.abort();let providerCalls=0;
  await assert.rejects(()=>runNativeAgentTurn({model:"test-model",messages:[],signal:pre.signal,providerTurn:async()=>{providerCalls++;return{text:"done",toolCalls:[]}},executeTool:async()=>""}),error=>error?.name==="AbortError");
  assert.equal(providerCalls,0);

  const during=new AbortController();let executions=0;
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[],signal:during.signal,
    providerTurn:async()=>({text:"",toolCalls:[{id:"one",name:"tool",arguments:"{}"},{id:"two",name:"tool",arguments:"{}"}],usage:{}}),
    executeTool:async()=>{executions++;during.abort();return "done"},
  }),error=>error?.name==="AbortError");
  assert.equal(executions,1);
});

test("native agent retries only transient provider inference failures",async()=>{
  const events=[];let attempts=0;
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"retry please"}],retryBaseDelayMs:0,onEvent:event=>events.push(event),
    providerTurn:async()=>{
      attempts++;
      if(attempts===1){const error=new Error("rate limited");error.status=429;throw error}
      if(attempts===2){const error=new Error("temporarily unavailable");error.status=503;throw error}
      return {text:"recovered",toolCalls:[],usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
    },executeTool:async()=>"",
  });
  assert.equal(attempts,3);assert.equal(result.text,"recovered");assert.equal(events.filter(event=>event.name==="native.model.retrying").length,2);

  let authAttempts=0;
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[],retryBaseDelayMs:0,
    providerTurn:async()=>{authAttempts++;const error=new Error("unauthorized");error.status=401;throw error},executeTool:async()=>"",
  }),/unauthorized/i);
  assert.equal(authAttempts,1);
  assert.equal(nativeProviderRetryable(Object.assign(new Error("reset"),{code:"ECONNRESET"})),true);
  assert.equal(nativeProviderRetryable(new DOMException("The operation was aborted due to timeout","TimeoutError")),true);
  assert.equal(nativeProviderRetryable(new DOMException("cancelled by caller","AbortError")),false);
  assert.equal(nativeProviderRetryable(Object.assign(new Error("bad request"),{status:400})),false);
});

test("native agent cancellation during provider retry backoff prevents the next request",async()=>{
  const controller=new AbortController();let attempts=0;
  const pending=runNativeAgentTurn({
    model:"test-model",messages:[],signal:controller.signal,retryBaseDelayMs:500,
    providerTurn:async()=>{attempts++;const error=new Error("service unavailable");error.status=503;throw error},executeTool:async()=>"",
  });
  setTimeout(()=>controller.abort(),20);
  await assert.rejects(pending,error=>error?.name==="AbortError");assert.equal(attempts,1);
});

test("native agent budget normalization stays bounded",()=>{
  assert.deepEqual(nativeAgentBudget({maxModelTurns:0,maxToolCalls:-5}),{maxModelTurns:1,maxToolCalls:0,maxWallTimeMs:null});
  assert.deepEqual(nativeAgentBudget({maxModelTurns:9999,maxToolCalls:99999,maxWallTimeMs:1234.9}),{maxModelTurns:500,maxToolCalls:5000,maxWallTimeMs:1234});
});
