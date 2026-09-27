import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";

const tools=[
  {type:"namespace",name:"trebell_terminal",description:"Terminal tools",tools:[{name:"run",description:"Run a command",inputSchema:{type:"object",properties:{command:{type:"string"},args:{type:"array",items:{type:"string"}}},required:["command","args"]}}]},
  {type:"namespace",name:"trebell_workspace",description:"Workspace tools",tools:[
    {name:"read_file",description:"Read a file",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"]}},
    {name:"replace_text",description:"Replace exact text",inputSchema:{type:"object",properties:{path:{type:"string"},old_text:{type:"string"},new_text:{type:"string"},expected_replacements:{type:"integer"}},required:["path","old_text","new_text"]}},
  ]},
];

function requestRecord(request={}){
  const messages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[];
  return {
    bytes:Buffer.byteLength(JSON.stringify({messages,tools:requestTools,toolChoice:request.toolChoice,parallelToolCalls:request.parallelToolCalls}),"utf8"),
    metrics:nativeRequestMetrics(messages,requestTools),
  };
}

async function runScenario({reusePriorFailure}){
  let config='export const mode="legacy";\n',providerCalls=0,toolCalls=0;
  const requests=[],priorTerminalRuns=[];
  const executeTool=async call=>{
    toolCalls++;
    if(call.namespace==="trebell_terminal"&&call.name==="run"){
      const exitCode=config.includes('mode="strict"')?0:1;
      priorTerminalRuns.push({arguments:structuredClone(call.arguments),exitCode});
      return {exitCode,stdout:exitCode===0?"BENCH_CROSS_TURN_PASS\n":"",stderr:exitCode===0?"":"expected strict mode\n"};
    }
    if(call.namespace==="trebell_workspace"&&call.name==="read_file")return {path:"src/config.mjs",content:config,size:Buffer.byteLength(config)};
    if(call.namespace==="trebell_workspace"&&call.name==="replace_text"){
      assert.equal(call.arguments.path,"src/config.mjs");assert.equal(call.arguments.old_text,"legacy");assert.equal(call.arguments.new_text,"strict");
      config=config.replace("legacy","strict");return {path:"src/config.mjs",replacements:1};
    }
    throw new Error("Unexpected tool "+call.namespace+"/"+call.name);
  };
  const provider=(responses)=>async request=>{
    providerCalls++;requests.push(requestRecord(request));
    const next=responses.shift();if(!next)throw new Error("Unexpected extra provider inference");return next;
  };
  const system={role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})};
  const firstResponses=[
    {text:"",toolCalls:[{id:"verify-1",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}],usage:{}},
    {text:"Verifier failed with the expected strict-mode assertion.",toolCalls:[],usage:{}},
  ];
  const first=await runNativeAgentTurn({
    model:"fixture",provider:"fixture",messages:[system,{role:"user",content:"Run node verify.mjs now. Do not read or edit project files in this turn. Report the result."}],tools,
    toolAllowlist:["trebell_terminal/run"],autoRerunVerification:true,providerTurn:provider(firstResponses),executeTool,maxModelTurns:4,maxToolCalls:8,
  });
  assert.equal(priorTerminalRuns.length,1);assert.equal(priorTerminalRuns[0].exitCode,1);
  const secondResponses=[
    {text:"",toolCalls:[{id:"read",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/config.mjs"}}],usage:{}},
    {text:"",toolCalls:[{id:"edit",namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/config.mjs",old_text:"legacy",new_text:"strict",expected_replacements:1}}],usage:{}},
    {text:"",toolCalls:[{id:"verify-2",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}],usage:{}},
    {text:"Fixed and verified.",toolCalls:[],usage:{}},
  ];
  const second=await runNativeAgentTurn({
    model:"fixture",provider:"fixture",messages:[...first.messages,{role:"user",content:"Now read src/config.mjs, replace only legacy with strict, and rerun node verify.mjs until it passes."}],tools,
    toolAllowlist:["trebell_terminal/run","trebell_workspace/read_file","trebell_workspace/replace_text"],autoRerunVerification:true,
    priorTerminalRuns:reusePriorFailure?priorTerminalRuns.slice(0,1):[],providerTurn:provider(secondResponses),executeTool,maxModelTurns:6,maxToolCalls:12,
  });
  assert.equal(config,'export const mode="strict";\n');
  const verification=await executeTool({namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}});toolCalls--;
  assert.equal(verification.exitCode,0);
  return {
    providerInferences:providerCalls,
    agentToolCalls:first.toolCalls+second.toolCalls,
    providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+Number(item.metrics?.totalLogical?.estimatedTokens||0),0),
    requestBytes:requests.reduce((sum,item)=>sum+item.bytes,0),
    requestCount:requests.length,
    verificationPassed:true,
    finalText:second.text,
  };
}

const baseline=await runScenario({reusePriorFailure:false});
const candidate=await runScenario({reusePriorFailure:true});
assert.equal(baseline.verificationPassed,true);assert.equal(candidate.verificationPassed,true);
assert.equal(baseline.agentToolCalls,candidate.agentToolCalls);
assert.ok(candidate.providerInferences<baseline.providerInferences);
console.log(JSON.stringify({ok:true,benchmark:"native-cross-turn-verifier-zero-latency",baseline,candidate,savings:{
  providerInferences:baseline.providerInferences-candidate.providerInferences,
  providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,
  requestBytes:baseline.requestBytes-candidate.requestBytes,
}},null,2));
