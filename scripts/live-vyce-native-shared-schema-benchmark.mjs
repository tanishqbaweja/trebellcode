import assert from "node:assert/strict";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the shared-schema benchmark.");
const manager=new ProviderManager({env:{...process.env,VYCEAI_API_KEY:apiKey}});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the shared-schema benchmark.");

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
const messages=[
  {role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},
  {role:"user",content:"Run node verify.mjs exactly once using the terminal tool. Use the normal argv contract, not shell syntax. Do not call or discuss anything else."},
];
const response=await manager.turn("vyceai",{
  provider:"vyceai",model,messages,tools,
  toolChoice:{namespace:"trebell_terminal",name:"run"},parallelToolCalls:false,maxOutputTokens:96,
});
const call=(response.toolCalls||[])[0]||null;
let args={};
try{args=typeof call?.arguments==="string"?JSON.parse(call.arguments):call?.arguments||{}}catch{}
const correct=call?.namespace==="trebell_terminal"&&call?.name==="run"&&args.command==="node"&&Array.isArray(args.args)&&args.args.length===1&&args.args[0]==="verify.mjs";
assert.equal(correct,true,"model must preserve the terminal argv contract");
console.log(JSON.stringify({
  ok:true,runtime:"native",provider:"vyceai",model,
  arguments:args,
  inputTokens:Number(response.usage?.inputTokens||0),
  outputTokens:Number(response.usage?.outputTokens||0),
  requestBytes:Number(response.telemetry?.requestBytes||0),
  schema:nativeRequestMetrics([],tools).toolSchemas,
},null,2));
