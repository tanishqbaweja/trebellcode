import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "../src/context-engine.mjs";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the output-inspect benchmark.");
const model=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),manager=new ProviderManager({env:{...process.env,VYCEAI_API_KEY:apiKey}});
const mode=String(process.env.TREBELL_OUTPUT_INSPECT_MODE||"search").trim().toLowerCase()==="read"?"read":"search";
const root=await mkdtemp(join(tmpdir(),"trebell-output-inspect-")),requests=[],updates=[],virtualized=[];
try{
  const lines=[];for(let i=0;i<1800;i++)lines.push(`ordinary-${String(i).padStart(4,"0")} ${"x".repeat(40)}`);
  lines.splice(900,0,"ARCHIVE_MARKER=kiwi-314159");
  await mkdir(root,{recursive:true});await writeFile(join(root,"emit.mjs"),`console.log(${JSON.stringify(lines.join("\n"))});\n`,"utf8");
  const tools=platformDynamicToolNamespaces({repository:false,workspaceTools:false,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
  const outputStore=new NativeToolOutputStore({directory:join(root,"output"),maxHotBytes:4096,environment:process.env,onVirtualized:info=>{
    virtualized.push(info);if(!tools.some(item=>item?.name==="trebell_output"))tools.push(...platformDynamicToolNamespaces({repository:false,output:true,workspaceTools:false,terminal:false,browser:false,computer:false,sourceControl:false,delegation:false}));
  }});
  const builtins=createNativeBuiltins({root,environment:process.env}),contextEngine=new ContextEngine();
  const executor=createNativeToolExecutor({contextEngine,root,repository:false,outputStore,environment:process.env,policyContext:{permissionProfile:"full",runtime:"native",workspace:root,projectAvailable:true},executeShared:call=>builtins(call)});
  const session=new NativeAgentSession({provider:"vyceai",model,tools,toolOutputStore:outputStore,executeTool:executor,initialMessages:[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})}],onUpdate:update=>updates.push(update),providerTurn:async request=>{
    const wireTools=structuredClone(request.tools||[]),metrics=nativeRequestMetrics(request.messages||[],wireTools),schemaChars=JSON.stringify(wireTools).length;
    const response=await manager.turn("vyceai",{...request,provider:"vyceai",model,maxOutputTokens:160},{signal:request.signal});requests.push({usage:response.usage,telemetry:response.telemetry,metrics,schemaChars,toolCalls:response.toolCalls||[]});return response;
  }});
  await session.start({providerSessionId:"output-inspect-live",model});
  const prompt=mode==="read"
    ?"Run node emit.mjs. Its large output contains ARCHIVE_MARKER around virtualized-output line 915, hidden away from the preview head/tail. Use Trebell's virtualized-output retrieval capability to read a bounded line range around 910-920; do not use search and do not rerun the command. Answer with the marker value."
    :"Run node emit.mjs. Its large output contains a line named ARCHIVE_MARKER hidden away from the preview head/tail. Use Trebell's virtualized-output retrieval capability to find the exact marker value. Do not read project files. Answer with the marker value.";
  await session.prompt([{type:"text",text:prompt}],{maxModelTurns:5,maxToolCalls:5,maxWallTimeMs:120000,toolAllowlist:["trebell_terminal/run","trebell_output"]});
  const text=updates.filter(item=>item.update?.sessionUpdate==="agent_message_chunk").map(item=>String(item.update?.content?.text||"")).filter(Boolean).at(-1)||"";assert.match(text,/kiwi-314159/);assert.ok(virtualized.length>0);
  const toolNames=updates.filter(item=>item.update?.sessionUpdate==="tool_call_update").map(item=>`${item.update.namespace}/${item.update.tool}`);
  assert.ok(toolNames.some(name=>name.startsWith("trebell_output/")),"model must use virtualized-output retrieval");
  const totals=requests.reduce((out,row)=>({inputTokens:out.inputTokens+Number(row.usage?.inputTokens||0),outputTokens:out.outputTokens+Number(row.usage?.outputTokens||0),requestBytes:out.requestBytes+Number(row.telemetry?.requestBytes||0)}),{inputTokens:0,outputTokens:0,requestBytes:0});
  console.log(JSON.stringify({ok:true,runtime:"native",provider:"vyceai",model,mode,modelTurns:requests.length,toolNames,...totals,requestBreakdown:requests.map((row,index)=>({turn:index+1,inputTokens:Number(row.usage?.inputTokens||0),schemaChars:row.schemaChars,schemaEstimatedTokens:row.metrics.toolSchemas.estimatedTokens,providerToolNames:(row.toolCalls||[]).map(call=>`${call.namespace}/${call.name}`)})),finalAgentText:text.slice(-400)},null,2));
}finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
