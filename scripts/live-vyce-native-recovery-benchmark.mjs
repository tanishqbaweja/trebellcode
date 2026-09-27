import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ContextEngine } from "../src/context-engine.mjs";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native recovery benchmark.");

async function writeFixture(root,files){
  for(const [path,content] of Object.entries(files)){
    const target=join(root,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,content,"utf8");
  }
}

function oversizedSource(){
  const marker="export const RECOVERY_UNINDEXED_MARKER = \"RECOVERY_UNINDEXED_OK\";\n";
  const filler="// recovery benchmark filler xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n";
  let text=marker;
  while(Buffer.byteLength(text,"utf8")<258_000)text+=filler;
  assert.ok(Buffer.byteLength(text,"utf8")>256_000);
  assert.ok(Buffer.byteLength(text,"utf8")<256*1024);
  return text;
}

const scenarios=[
  {
    name:"unindexed-read-source",
    marker:"RECOVERY_UNINDEXED_OK",
    files:{"src/oversized.mjs":oversizedSource()},
    prompt:[
      "Call trebell_repo.read_source on src/oversized.mjs starting at line 1.",
      "Inspect the returned source and then reply with exactly RECOVERY_UNINDEXED_OK.",
      "If that repository read fails, recover using the available workspace reader rather than guessing the file contents.",
    ].join(" "),
    toolAllowlist:["trebell_repo/read_source","trebell_workspace/read_file"],
    verify:async root=>assert.match(await readFile(join(root,"src/oversized.mjs"),"utf8"),/RECOVERY_UNINDEXED_OK/),
  },
  {
    name:"relative-workspace-path",
    marker:"RECOVERY_WORKSPACE_CONTENT_7F31C9",
    files:{"TASK.md":"RECOVERY_WORKSPACE_CONTENT_7F31C9\n"},
    prompt:[
      "First call trebell_workspace.read_file with path workspace/TASK.md exactly as written.",
      "The file contains one line whose value is not included in this prompt. Reply with only that exact line after you have successfully read it.",
      "If the first read fails, recover using another workspace read rather than guessing the file contents.",
    ].join(" "),
    toolAllowlist:["trebell_workspace/read_file"],
    forceFirstTool:{namespace:"trebell_workspace",name:"read_file"},
    verify:async root=>assert.equal(await readFile(join(root,"TASK.md"),"utf8"),"RECOVERY_WORKSPACE_CONTENT_7F31C9\n"),
  },
  {
    name:"app-workspace-path",
    marker:"RECOVERY_APP_CONTENT_91D4E2",
    files:{"TASK.md":"RECOVERY_APP_CONTENT_91D4E2\n"},
    prompt:[
      "First call trebell_workspace.read_file with path /app/TASK.md exactly as written.",
      "The file contains one line whose value is not included in this prompt. Reply with only that exact line after you have successfully read it.",
      "If the first read fails, recover using another workspace read rather than guessing the file contents.",
    ].join(" "),
    toolAllowlist:["trebell_workspace/read_file"],
    forceFirstTool:{namespace:"trebell_workspace",name:"read_file"},
    verify:async root=>assert.equal(await readFile(join(root,"TASK.md"),"utf8"),"RECOVERY_APP_CONTENT_91D4E2\n"),
  },
];

const env={...process.env,VYCEAI_API_KEY:apiKey};
const manager=new ProviderManager({env});
const catalog=await manager.models("vyceai");
const requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim();
const model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native recovery benchmark.");

async function runScenario(scenario){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-recovery-")),events=[],updates=[],providerRequests=[];
  try{
    await writeFixture(root,scenario.files);
    const tools=platformDynamicToolNamespaces({
      repository:true,progressiveRepository:true,workspaceTools:true,terminal:false,
      browser:false,computer:false,sourceControl:false,delegation:false,
    });
    const contextEngine=new ContextEngine(),builtins=createNativeBuiltins({root,environment:env});
    const executor=createNativeToolExecutor({
      contextEngine,root,repository:true,environment:env,
      policyContext:{permissionProfile:"full",runtime:"native",workspace:root,projectAvailable:true},
      executeShared:call=>{
        if(call.namespace==="trebell_workspace")return builtins(call);
        throw new Error("Unsupported recovery benchmark shared tool: "+call.namespace+"/"+call.name);
      },
    });
    const session=new NativeAgentSession({
      cwd:root,provider:"vyceai",model,tools,executeTool:executor,
      initialMessages:[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})}],
      providerTurn:async request=>{
        const requestNumber=providerRequests.length+1;
        const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[];
        const record={
          messageChars:JSON.stringify(requestMessages).length,
          schemaChars:JSON.stringify(requestTools).length,
          functionCount:requestTools.reduce((sum,item)=>sum+(Array.isArray(item?.tools)?item.tools.length:1),0),
          requestMetrics:nativeRequestMetrics(requestMessages,requestTools),
        };
        providerRequests.push(record);
        const effectiveRequest=requestNumber===1&&scenario.forceFirstTool?{...request,toolChoice:scenario.forceFirstTool}:request;
        const response=await manager.turn("vyceai",{...effectiveRequest,provider:"vyceai",model},{signal:request.signal});
        record.usage=response.usage;record.telemetry=response.telemetry;return response;
      },
      onEvent:event=>events.push(event),onUpdate:update=>updates.push(update),
    });
    await session.start({providerSessionId:"recovery-"+scenario.name,model});
    const started=performance.now();
    let result=null,turnFailure=null;
    try{
      result=await session.prompt([{type:"text",text:scenario.prompt}],{
        maxModelTurns:6,maxToolCalls:12,maxWallTimeMs:180_000,toolAllowlist:scenario.toolAllowlist,
      });
    }catch(error){
      turnFailure={
        code:error?.code||null,message:String(error?.message||error).slice(0,1000),
        modelTurns:Number(error?.nativeModelTurns||0),toolCalls:Number(error?.nativeToolCalls||0),usage:error?.nativeUsage||null,
      };
    }
    const elapsedMs=Number((performance.now()-started).toFixed(3));
    let independentVerificationPassed=true,independentVerificationError=null;
    try{await scenario.verify(root)}catch(error){independentVerificationPassed=false;independentVerificationError=String(error?.message||error).slice(0,1000)}
    const toolUpdates=updates.filter(item=>item.update?.sessionUpdate==="tool_call_update");
    const aggregate=providerRequests.reduce((out,item)=>({
      inputTokens:out.inputTokens+Number(item.usage?.inputTokens||0),
      outputTokens:out.outputTokens+Number(item.usage?.outputTokens||0),
      cachedInputTokens:out.cachedInputTokens+Number(item.usage?.cachedInputTokens||0),
      providerLatencyMs:out.providerLatencyMs+Number(item.telemetry?.totalLatencyMs||0),
    }),{inputTokens:0,outputTokens:0,cachedInputTokens:0,providerLatencyMs:0});
    const finalText=String(result?.raw?.text||result?.text||updates.filter(item=>item.update?.sessionUpdate==="agent_message_chunk").map(item=>item.update?.content?.text||"").at(-1)||"");
    const markerPassed=finalText.includes(scenario.marker);
    return {
      name:scenario.name,
      ok:!turnFailure&&markerPassed&&independentVerificationPassed,
      elapsedMs,modelTurns:providerRequests.length,toolCalls:toolUpdates.length,
      failedToolCalls:toolUpdates.filter(item=>item.update?.status==="failed").length,
      fallbackEvents:events.filter(event=>event.name==="native.tool.read_fallback").length,
      repairedToolCalls:events.filter(event=>event.name==="native.tool.call_repaired").length,
      ...aggregate,
      firstFunctionCount:Number(providerRequests[0]?.functionCount||0),
      firstSchemaChars:Number(providerRequests[0]?.schemaChars||0),
      firstSchemaEstimatedTokens:Number(providerRequests[0]?.requestMetrics?.toolSchemas?.estimatedTokens||0),
      tools:toolUpdates.map(item=>({
        tool:String(item.update?.namespace||"")+"/"+String(item.update?.tool||""),
        status:item.update?.status||null,
        arguments:item.update?.rawInput&&typeof item.update.rawInput==="object"?item.update.rawInput:{},
        error:typeof item.update?.rawOutput?.error==="string"?item.update.rawOutput.error.slice(0,500):null,
      })),
      markerPassed,independentVerificationPassed,independentVerificationError,turnFailure,
      finalText:finalText.slice(-1000),
    };
  }finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}

const selectedName=String(process.env.TREBELL_NATIVE_RECOVERY_BENCH_SCENARIO||"").trim();
const selected=selectedName?scenarios.filter(item=>item.name===selectedName):scenarios;
if(!selected.length)throw new Error("Unknown TREBELL_NATIVE_RECOVERY_BENCH_SCENARIO: "+selectedName);
const results=[];
for(const scenario of selected){
  console.error("[recovery-benchmark] "+scenario.name);
  results.push(await runScenario(scenario));
}
const totals=results.reduce((out,row)=>({
  inputTokens:out.inputTokens+row.inputTokens,outputTokens:out.outputTokens+row.outputTokens,
  modelTurns:out.modelTurns+row.modelTurns,toolCalls:out.toolCalls+row.toolCalls,
  failedToolCalls:out.failedToolCalls+row.failedToolCalls,fallbackEvents:out.fallbackEvents+row.fallbackEvents,
  elapsedMs:out.elapsedMs+row.elapsedMs,
}),{inputTokens:0,outputTokens:0,modelTurns:0,toolCalls:0,failedToolCalls:0,fallbackEvents:0,elapsedMs:0});
console.log(JSON.stringify({ok:results.every(row=>row.ok),runtime:"native",provider:"vyceai",model,results,totals},null,2));
