import test from "node:test";
import assert from "node:assert/strict";
import { nativeAgentBudget, nativeProviderRetryable, runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { attachNativePromptProvenance } from "../src/native-request-metrics.mjs";
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
  const requested=events.find(event=>event.name==="native.model.requested"),completed=events.find(event=>event.name==="native.model.completed");
  assert.equal(requested.data.inferenceId,"native:inference:1");assert.equal(completed.data.inferenceId,requested.data.inferenceId);
  assert.equal(typeof requested.data.requestMetrics.toolSchemaHash,"string");assert.equal(typeof requested.data.requestMetrics.stablePrefixHash,"string");
});

test("native agent gives one bounded recovery chance to an empty terminal provider response",async()=>{
  const requests=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"finish the task"}],onEvent:event=>events.push(event),
    providerTurn:async request=>{
      requests.push(structuredClone(request));
      if(requests.length===1)return {model:"test-model",provider:"fixture",text:"",toolCalls:[],finishReason:"stop",usage:{}};
      assert.equal(request.messages.at(-1).role,"developer");
      assert.match(request.messages.at(-1).content,/no user-visible assistant text/i);
      return {model:"test-model",provider:"fixture",text:"Done.",toolCalls:[],finishReason:"stop",usage:{}};
    },
    executeTool:async()=>{throw new Error("tool executor should not run")},
  });
  assert.equal(result.text,"Done.");assert.equal(result.modelTurns,2);
  assert.equal(events.filter(event=>event.name==="native.model.empty_completion").length,1);
});

test("native agent fails visibly when the bounded empty-completion recovery is also empty",async()=>{
  let turns=0;
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"finish the task"}],
    providerTurn:async()=>{turns++;return {model:"test-model",provider:"fixture",text:"",toolCalls:[],finishReason:"stop",usage:{}}},
    executeTool:async()=>"",
  }),error=>error?.code==="native_empty_completion");
  assert.equal(turns,2);
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

test("native agent repairs obvious protocol-corrupted names only for single-tool namespaces",async()=>{
  let turns=0;const executions=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"verify"}],onEvent:event=>events.push(event),
    tools:[{type:"namespace",name:"trebell_terminal",tools:[{name:"run",inputSchema:{type:"object",properties:{command:{type:"string"}}}}]}],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"bad-name",namespace:"trebell_terminal",name:"arg_key>cwd</arg_key><arg_value>.</arg_value>",arguments:'{"command":"node","args":["verify.mjs"]}'}],usage:{}};
      assert.equal(request.messages.at(-2).toolCalls[0].name,"run");
      assert.equal(request.messages.at(-1).role,"tool");
      return {text:"verified",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(call);return "PASS"},
  });
  assert.equal(result.text,"verified");assert.equal(result.modelTurns,2);assert.equal(result.toolCalls,1);
  assert.equal(executions[0].namespace,"trebell_terminal");assert.equal(executions[0].name,"run");
  const repaired=events.find(event=>event.name==="native.tool.call_repaired");assert.ok(repaired);assert.equal(repaired.data.name,"run");assert.equal(repaired.data.malformedNameLength,45);assert.equal("originalName" in repaired.data,false);
});

test("native agent repairs a uniquely identifiable flattened Trebell tool alias without guessing",async()=>{
  let turns=0;const executions=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"find the old symbol"}],onEvent:event=>events.push(event),
    tools:[
      {type:"namespace",name:"trebell_repo",tools:[{name:"search_code"},{name:"search_symbols"}]},
      {type:"namespace",name:"trebell_workspace",tools:[{name:"read_file"}]},
    ],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"alias",namespace:null,name:"trebell_search_code",arguments:'{"query":"sumNumbers"}'}],usage:{}};
      assert.equal(request.messages.at(-2).toolCalls[0].namespace,"trebell_repo");assert.equal(request.messages.at(-2).toolCalls[0].name,"search_code");
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(call);return {success:true,matches:[]}},
  });
  assert.equal(result.text,"done");assert.equal(result.toolCalls,1);
  assert.equal(executions[0].namespace,"trebell_repo");assert.equal(executions[0].name,"search_code");
  const repaired=events.find(event=>event.name==="native.tool.call_repaired");assert.ok(repaired);assert.equal(repaired.data.reason,"protocol_alias");assert.equal(repaired.data.repairedNamespace,"trebell_repo");assert.equal(repaired.data.name,"search_code");
});

test("native agent repairs an exact visible tool name placed under the wrong visible namespace only when unique",async()=>{
  let turns=0;const executions=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"replace the exact text"}],onEvent:event=>events.push(event),
    tools:[
      {type:"namespace",name:"trebell_repo",tools:[{name:"read_source"}]},
      {type:"namespace",name:"trebell_workspace",tools:[{name:"read_file"},{name:"replace_text"}]},
    ],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"misplaced",namespace:"trebell_repo",name:"replace_text",arguments:'{"path":"src/a.js","old_text":"1","new_text":"2"}'}],usage:{}};
      const repairedCall=request.messages.at(-2).toolCalls[0];assert.equal(repairedCall.namespace,"trebell_workspace");assert.equal(repairedCall.name,"replace_text");
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(call);return {success:true,replacements:1}},
  });
  assert.equal(result.text,"done");assert.equal(result.toolCalls,1);
  assert.equal(executions[0].namespace,"trebell_workspace");assert.equal(executions[0].name,"replace_text");
  const repaired=events.find(event=>event.name==="native.tool.call_repaired");assert.ok(repaired);assert.equal(repaired.data.reason,"unique_tool_namespace");assert.equal(repaired.data.repairedNamespace,"trebell_workspace");assert.equal(repaired.data.name,"replace_text");
});

test("native agent does not repair a wrong namespace when the exact tool name is ambiguous",async()=>{
  const executions=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"take a screenshot"}],
    tools:[
      {type:"namespace",name:"trebell_repo",tools:[{name:"read_source"}]},
      {type:"namespace",name:"trebell_browser",tools:[{name:"screenshot"}]},
      {type:"namespace",name:"trebell_computer",tools:[{name:"screenshot"}]},
    ],
    providerTurn:async request=>request.messages.some(message=>message.role==="tool")
      ?{text:"stopped",toolCalls:[],usage:{}}
      :{text:"",toolCalls:[{id:"ambiguous-namespace",namespace:"trebell_repo",name:"screenshot",arguments:"{}"}],usage:{}},
    executeTool:async call=>{executions.push(call);return {success:false,error:"unknown tool"}},
  });
  assert.equal(result.text,"stopped");assert.equal(executions[0].namespace,"trebell_repo");assert.equal(executions[0].name,"screenshot");
});

test("native agent never moves a misplaced Trebell call into an external namespace",async()=>{
  const executions=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"use the connected service"}],
    tools:[
      {type:"namespace",name:"trebell_repo",tools:[{name:"read_source"}]},
      {type:"namespace",name:"external_service",tools:[{name:"replace_text"}]},
    ],
    providerTurn:async request=>request.messages.some(message=>message.role==="tool")
      ?{text:"stopped",toolCalls:[],usage:{}}
      :{text:"",toolCalls:[{id:"external-misplaced",namespace:"trebell_repo",name:"replace_text",arguments:"{}"}],usage:{}},
    executeTool:async call=>{executions.push(call);return {success:false,error:"unknown tool"}},
  });
  assert.equal(result.text,"stopped");assert.equal(executions[0].namespace,"trebell_repo");assert.equal(executions[0].name,"replace_text");
});

test("native agent does not repair a flattened alias when the target tool name is ambiguous",async()=>{
  const executions=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"open it"}],
    tools:[
      {type:"namespace",name:"trebell_browser",tools:[{name:"open"}]},
      {type:"namespace",name:"trebell_mcp",tools:[{name:"open"}]},
    ],
    providerTurn:async request=>request.messages.some(message=>message.role==="tool")
      ?{text:"stopped",toolCalls:[],usage:{}}
      :{text:"",toolCalls:[{id:"ambiguous",namespace:null,name:"trebell_open",arguments:"{}"}],usage:{}},
    executeTool:async call=>{executions.push(call);return {success:false,error:"unknown tool"}},
  });
  assert.equal(result.text,"stopped");assert.equal(executions[0].namespace,null);assert.equal(executions[0].name,"trebell_open");
});

test("native agent reuses one successful same-turn terminal command when a repeated call loses only command",async()=>{
  let turns=0;const executions=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Run the verifier, fix the issue, and rerun it."}],onEvent:event=>events.push(event),
    tools:[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"verify-before",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["verify.mjs"],"cwd":"."}'}],usage:{}};
      if(turns===2)return {text:"",toolCalls:[{id:"verify-after",namespace:"trebell_terminal",name:"run",arguments:'{"args":["verify.mjs"],"cwd":"."}'}],usage:{}};
      const prior=request.messages.find(message=>message.role==="assistant"&&message.toolCalls?.some(call=>call.id==="verify-after"));
      assert.match(String(prior.toolCalls.find(call=>call.id==="verify-after").arguments),/"command":"node"/);
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(structuredClone(call));return {success:true,exitCode:executions.length===1?1:0,timedOut:false,signal:null}},
  });
  assert.equal(result.text,"done");assert.equal(result.modelTurns,3);assert.equal(result.toolCalls,2);
  assert.deepEqual(executions.map(call=>call.arguments.command),["node","node"]);
  assert.ok(events.some(event=>event.name==="native.tool.call_repaired"&&event.data?.reason==="repeated_terminal_command"));
});

test("native agent does not reuse a timed-out terminal command as a missing-command repair source",async()=>{
  let turns=0;const executions=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Run the verifier twice."}],onEvent:event=>events.push(event),
    tools:[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}],
    providerTurn:async()=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"timeout",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["verify.mjs"],"cwd":"."}'}],usage:{}};
      if(turns===2)return {text:"",toolCalls:[{id:"missing",namespace:"trebell_terminal",name:"run",arguments:'{"args":["verify.mjs"],"cwd":"."}'}],usage:{}};
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(structuredClone(call));return executions.length===1?{exitCode:1,timedOut:true,signal:null}:{success:false,error:"command required"}},
  });
  assert.equal(result.text,"done");assert.equal(executions.at(-1).arguments.command,undefined);
  assert.equal(events.some(event=>event.name==="native.tool.call_repaired"&&event.data?.reason==="repeated_terminal_command"),false);
});

test("native agent does not guess a missing terminal command without one unique same-turn match",async()=>{
  let turns=0;const executions=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Run checks."}],onEvent:event=>events.push(event),
    tools:[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}],
    providerTurn:async()=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[
        {id:"node",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["verify.mjs"],"cwd":"."}'},
        {id:"bun",namespace:"trebell_terminal",name:"run",arguments:'{"command":"bun","args":["verify.mjs"],"cwd":"."}'},
      ],usage:{}};
      if(turns===2)return {text:"",toolCalls:[{id:"missing",namespace:"trebell_terminal",name:"run",arguments:'{"args":["verify.mjs"],"cwd":"."}'}],usage:{}};
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(structuredClone(call));return call.arguments.command?{success:true}:{success:false,error:"command required"}},
  });
  assert.equal(result.text,"done");assert.equal(executions.at(-1).arguments.command,undefined);
  assert.equal(events.some(event=>event.name==="native.tool.call_repaired"&&event.data?.reason==="repeated_terminal_command"),false);
});

test("native agent does not reuse a terminal command from a failed tool execution",async()=>{
  let turns=0;const executions=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Run checks."}],onEvent:event=>events.push(event),
    tools:[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}],
    providerTurn:async()=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"failed",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["verify.mjs"],"cwd":"workspace"}'}],usage:{}};
      if(turns===2)return {text:"",toolCalls:[{id:"missing",namespace:"trebell_terminal",name:"run",arguments:'{"args":["verify.mjs"],"cwd":"workspace"}'}],usage:{}};
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(structuredClone(call));return {success:false,error:"working directory not found"}},
  });
  assert.equal(result.text,"done");assert.equal(executions[1].arguments.command,undefined);
  assert.equal(events.some(event=>event.name==="native.tool.call_repaired"&&event.data?.reason==="repeated_terminal_command"),false);
});

test("native agent does not guess ordinary unknown tool names",async()=>{
  let turns=0;const executions=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"do it"}],
    tools:[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}],
    providerTurn:async()=>{
      turns++;if(turns===1)return {text:"",toolCalls:[{id:"unknown",namespace:"trebell_terminal",name:"delete_everything",arguments:"{}"}],usage:{}};
      return {text:"stopped",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(call);return {success:false,error:"unknown tool"}},
  });
  assert.equal(result.text,"stopped");assert.equal(executions[0].name,"delete_everything");
});

test("native agent forces one exact exposed tool when the user explicitly names it and the model tries to skip it",async()=>{
  let turns=0;const executions=[],choices=[],visible=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Call trebell_browser.open exactly once with https://example.test, inspect its result, then reply BROWSER_OK."}],onEvent:event=>events.push(event),
    tools:[
      {type:"namespace",name:"trebell_browser",tools:[{name:"open",inputSchema:{type:"object",properties:{url:{type:"string"}},required:["url"]}},{name:"snapshot"}]},
      {type:"namespace",name:"trebell_computer",tools:[{name:"screenshot"}]},
    ],
    providerTurn:async request=>{
      turns++;choices.push(request.toolChoice);visible.push(request.tools.flatMap(namespace=>(namespace.tools||[]).map(tool=>namespace.name+"/"+tool.name)));
      if(turns===1)return {text:"BROWSER_OK",toolCalls:[],usage:{}};
      if(turns===2){assert.deepEqual(request.toolChoice,{namespace:"trebell_browser",name:"open"});return {text:"",toolCalls:[{id:"open-1",namespace:"trebell_browser",name:"open",arguments:'{"url":"https://example.test"}'}],usage:{}}}
      return {text:"BROWSER_OK",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(call);return {success:true,url:call.arguments.url}},
  });
  assert.equal(result.text,"BROWSER_OK");assert.equal(result.modelTurns,3);assert.equal(result.toolCalls,1);assert.equal(executions[0].name,"open");
  assert.equal(choices[0],"auto");assert.deepEqual(choices[1],{namespace:"trebell_browser",name:"open"});assert.equal(choices[2],"auto");
  assert.deepEqual(visible[0],["trebell_browser/open","trebell_browser/snapshot","trebell_computer/screenshot"]);assert.deepEqual(visible[1],["trebell_browser/open"]);assert.deepEqual(visible[2],visible[0]);
  assert.ok(events.some(event=>event.name==="native.model.required_tool_recovery"));
});

test("native agent does not force tools for negated or vague requests",async()=>{
  for(const prompt of ["Do not call trebell_browser.open; just explain what it does.","Open the page in a browser if useful."]){
    const choices=[];const result=await runNativeAgentTurn({
      model:"test-model",messages:[{role:"user",content:prompt}],tools:[{type:"namespace",name:"trebell_browser",tools:[{name:"open"}]}],
      providerTurn:async request=>{choices.push(request.toolChoice);return {text:"explained",toolCalls:[],usage:{}}},executeTool:async()=>{throw new Error("must not execute")},
    });
    assert.equal(result.text,"explained");assert.deepEqual(choices,["auto"]);
  }
});

test("native explicit-tool recovery ignores old tool names carried only in Trebell working context",async()=>{
  const current=attachNativePromptProvenance({role:"user",content:"Call trebell_browser.open exactly once.\nPrior continuity: Call trebell_computer.screenshot exactly once."},{
    userParts:["Call trebell_browser.open exactly once."],contextText:"Prior continuity: Call trebell_computer.screenshot exactly once.",contextEntries:[],
  });
  let turns=0;const executions=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[current],tools:[
      {type:"namespace",name:"trebell_browser",tools:[{name:"open"}]},
      {type:"namespace",name:"trebell_computer",tools:[{name:"screenshot"}]},
    ],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"done",toolCalls:[],usage:{}};
      if(turns===2){assert.deepEqual(request.toolChoice,{namespace:"trebell_browser",name:"open"});return {text:"",toolCalls:[{id:"open",namespace:"trebell_browser",name:"open",arguments:"{}"}],usage:{}}}
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{executions.push(call);return {success:true}},
  });
  assert.equal(result.text,"done");assert.deepEqual(executions.map(call=>call.namespace+"/"+call.name),["trebell_browser/open"]);
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

test("native agent runs explicitly parallel-safe tool reads concurrently while preserving model observation order",async()=>{
  let providerTurns=0,active=0,maxActive=0;const completed=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"inspect both"}],parallelToolCalls:true,isToolParallelSafe:()=>true,maxParallelToolCalls:4,
    providerTurn:async request=>{
      providerTurns++;
      if(providerTurns===1)return {text:"",toolCalls:[
        {id:"slow",namespace:"trebell_repo",name:"read_source",arguments:'{"path":"slow.js"}'},
        {id:"fast",namespace:"trebell_repo",name:"read_source",arguments:'{"path":"fast.js"}'},
      ],usage:{}};
      const observations=request.messages.filter(message=>message.role==="tool");
      assert.deepEqual(observations.map(message=>message.toolCallId),["slow","fast"],"provider-visible observations must retain model call order");
      assert.deepEqual(observations.map(message=>message.content),["result-slow","result-fast"]);
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{
      active++;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,call.id==="slow"?40:5));
      completed.push(call.id);active--;return "result-"+call.id;
    },
  });
  assert.equal(maxActive,2,"parallel-safe reads should overlap");assert.deepEqual(completed,["fast","slow"],"fixture must prove completion order differed from model order");assert.equal(result.toolCalls,2);assert.equal(result.text,"done");
});

test("native parallel-safe batching never starts work beyond the exact tool-call budget",async()=>{
  const executed=[];
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"bounded parallel reads"}],maxToolCalls:1,isToolParallelSafe:()=>true,
    providerTurn:async()=>({text:"",toolCalls:[{id:"one",name:"read",arguments:"{}"},{id:"two",name:"read",arguments:"{}"}],usage:{}}),
    executeTool:async call=>{executed.push(call.id);return "ok"},
  }),error=>error?.code==="native_tool_call_budget");
  assert.deepEqual(executed,["one"]);
});

test("native agent finalizes without tool schemas after spending the exact tool-call budget",async()=>{
  let turns=0,executions=0;const seen=[],events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Inspect once, then answer."}],maxToolCalls:1,onEvent:event=>events.push(event),
    tools:[{type:"namespace",name:"trebell_repo",tools:[{name:"search_code",inputSchema:{type:"object",properties:{query:{type:"string"}}}}]}],
    providerTurn:async request=>{
      turns++;seen.push({tools:structuredClone(request.tools),toolChoice:structuredClone(request.toolChoice),messages:structuredClone(request.messages)});
      if(turns===1)return {text:"",toolCalls:[{id:"search",namespace:"trebell_repo",name:"search_code",arguments:'{"query":"needle"}'}],usage:{}};
      assert.deepEqual(request.tools,[]);assert.equal(request.toolChoice,"none");assert.match(String(request.messages.at(-1)?.content||""),/tool-call budget .* exhausted/i);
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async()=>{executions++;return {matches:["needle"]}},
  });
  assert.equal(result.text,"done");assert.equal(result.modelTurns,2);assert.equal(result.toolCalls,1);assert.equal(executions,1);
  assert.ok(seen[0].tools.length>0);assert.equal(seen[0].toolChoice,"auto");
  assert.ok(events.some(event=>event.name==="native.tool_budget.finalizing"&&event.data?.maxToolCalls===1));
});

test("native agent can preserve tool schemas while disabling tool use during cache-friendly finalization",async()=>{
  let turns=0;const seen=[];
  const tools=[{type:"namespace",name:"trebell_repo",tools:[{name:"search_code",inputSchema:{type:"object",properties:{query:{type:"string"}}}}]}];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Inspect once, then answer."}],maxToolCalls:1,preserveToolSchemasOnFinalization:true,tools,
    providerTurn:async request=>{
      turns++;seen.push({tools:structuredClone(request.tools),toolChoice:structuredClone(request.toolChoice)});
      if(turns===1)return {text:"",toolCalls:[{id:"search",namespace:"trebell_repo",name:"search_code",arguments:'{"query":"needle"}'}],usage:{}};
      assert.deepEqual(request.tools,tools);assert.equal(request.toolChoice,"none");
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async()=>({matches:["needle"]}),
  });
  assert.equal(result.text,"done");assert.equal(result.toolCalls,1);assert.deepEqual(seen[1].tools,seen[0].tools);
});

test("native agent retries one textual tool-call imitation during budget finalization",async()=>{
  let turns=0;const events=[];
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Inspect once, then answer."}],maxToolCalls:1,maxModelTurns:3,onEvent:event=>events.push(event),
    tools:[{type:"namespace",name:"trebell_workspace",tools:[{name:"read_file"}]}],
    providerTurn:async request=>{
      turns++;
      if(turns===1)return {text:"",toolCalls:[{id:"read",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"a.txt"}'}],usage:{}};
      assert.deepEqual(request.tools,[]);assert.equal(request.toolChoice,"none");
      if(turns===2)return {text:"<tool_call>read_file<arg_key>path</arg_key><arg_value>a.txt</arg_value></tool_call>",toolCalls:[],usage:{}};
      assert.match(String(request.messages.at(-1)?.content||""),/do not imitate a tool call/i);
      return {text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async()=>({path:"a.txt",content:"evidence"}),
  });
  assert.equal(result.text,"done");assert.equal(result.modelTurns,3);assert.equal(result.toolCalls,1);
  assert.equal(events.filter(event=>event.name==="native.tool_budget.finalization_retry").length,1);
});

test("native agent omits tools from the first request when the tool budget is zero",async()=>{
  let executions=0,providerCalls=0;
  const result=await runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Answer from existing context."}],maxToolCalls:0,
    tools:[{type:"namespace",name:"trebell_repo",tools:[{name:"search_code"}]}],
    providerTurn:async request=>{providerCalls++;assert.deepEqual(request.tools,[]);assert.equal(request.toolChoice,"none");return {text:"done",toolCalls:[],usage:{}}},
    executeTool:async()=>{executions++;return "must not run"},
  });
  assert.equal(result.text,"done");assert.equal(providerCalls,1);assert.equal(executions,0);
});

test("native agent fails before inference when zero tool budget cannot satisfy an explicitly required tool",async()=>{
  let providerCalls=0;
  await assert.rejects(()=>runNativeAgentTurn({
    model:"test-model",messages:[{role:"user",content:"Call trebell_browser.open exactly once."}],maxToolCalls:0,
    tools:[{type:"namespace",name:"trebell_browser",tools:[{name:"open"}]}],
    providerTurn:async()=>{providerCalls++;return {text:"",toolCalls:[],usage:{}}},
    executeTool:async()=>"must not run",
  }),error=>error?.code==="native_tool_call_budget"&&/required tool trebell_browser\/open/i.test(error.message));
  assert.equal(providerCalls,0);
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
