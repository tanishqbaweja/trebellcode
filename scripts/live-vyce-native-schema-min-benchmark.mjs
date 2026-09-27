import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native schema-min benchmark.");
const model=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),manager=new ProviderManager({env:{...process.env,VYCEAI_API_KEY:apiKey}});
const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:false,terminal:false,browser:false,computer:false,sourceControl:false,delegation:false});
const requests=[],toolSequence=[];
const session=new NativeAgentSession({
  provider:"vyceai",model,tools,
  initialMessages:[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})}],
  providerTurn:async request=>{
    const messages=structuredClone(request.messages),wireTools=structuredClone(request.tools||[]),metrics=nativeRequestMetrics(messages,wireTools),schemaChars=JSON.stringify(wireTools).length;
    const response=await manager.turn("vyceai",{...request,provider:"vyceai",model,maxOutputTokens:192},{signal:request.signal});
    requests.push({metrics,schemaChars,usage:response.usage,telemetry:response.telemetry,text:String(response.text||"")});return response;
  },
  executeTool:async call=>{
    toolSequence.push(`${call.namespace}/${call.name}`);
    if(call.namespace!=="trebell_repo")throw new Error("Only repository tools are expected in this benchmark.");
    if(call.name==="discover")return {capabilities:[{name:"rename_preview",description:"Preview a semantic rename without editing files.",inputSchema:{type:"object",properties:{path:{type:"string"},line:{type:"integer"},newName:{type:"string"}},required:["path","line","newName"]}}]};
    if(call.name==="invoke"){
      assert.equal(call.arguments?.name,"rename_preview");
      return {supported:true,capability:"rename_preview",edits:[{path:"src/app.ts",oldText:"oldName",newText:"newName"}]};
    }
    throw new Error(`Unexpected repository tool: ${call.name}`);
  },
});
await session.start({providerSessionId:"schema-min-live",model});
const result=await session.prompt([{type:"text",text:"You need a semantic TypeScript rename capability that is not one of the visible core repository search/read tools. Use Trebell's on-demand repository capability gateway to find the advanced capability, then call it to preview renaming the symbol at src/app.ts line 10 to newName. Do not guess or edit files."}],{maxModelTurns:4,maxToolCalls:4,maxWallTimeMs:120000});
assert.deepEqual(toolSequence.slice(0,2),["trebell_repo/discover","trebell_repo/invoke"]);
const text=requests.map(row=>row.text).filter(Boolean).at(-1)||"";assert.match(text,/newName|rename/i);
const totals=requests.reduce((out,row)=>({inputTokens:out.inputTokens+Number(row.usage?.inputTokens||0),outputTokens:out.outputTokens+Number(row.usage?.outputTokens||0),requestBytes:out.requestBytes+Number(row.telemetry?.requestBytes||0)}),{inputTokens:0,outputTokens:0,requestBytes:0});
console.log(JSON.stringify({ok:true,runtime:"native",provider:"vyceai",model,modelTurns:requests.length,toolSequence,...totals,firstSchemaChars:requests[0]?.schemaChars||0,firstSchemaEstimatedTokens:requests[0]?.metrics?.toolSchemas?.estimatedTokens||0,finalAgentText:text.slice(-800)},null,2));
