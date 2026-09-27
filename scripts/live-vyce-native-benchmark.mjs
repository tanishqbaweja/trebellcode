import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ContextEngine } from "../src/context-engine.mjs";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";
import { repositoryDynamicToolNamespace, searchRepositoryToolDefinitions } from "../src/repository-tool-catalog.mjs";
import { repositoryContextEntries } from "../ui/src/context-provenance.js";
import { nativeToolTiming, optionalFiniteMetric, optionalMetricTotal } from "./native-benchmark-timing.mjs";

const execFileAsync=promisify(execFile);
const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native benchmark.");

async function writeFixture(root,files){
  for(const [path,content] of Object.entries(files)){
    const target=join(root,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,content,"utf8");
  }
}

async function verifyNode(root,file,marker,extraEnv={}){
  const {stdout,stderr}=await execFileAsync(process.execPath,[file],{cwd:root,env:{...process.env,...extraEnv},timeout:30_000,windowsHide:true,maxBuffer:2*1024*1024});
  const text=String(stdout||"")+String(stderr||"");assert.match(text,new RegExp(marker));
  return text.trim().slice(-1000);
}

const scenarios=[
  {
    name:"multi-file-refactor",
    files:{
      "TASK.md":[
        "# Task",
        "Rename the exported function sumNumbers in src/math.mjs to addNumbers.",
        "Update every project usage. Do not leave a compatibility alias.",
        "Run node verify.mjs and keep working until it passes.",
        "",
      ].join("\n"),
      "src/math.mjs":"export function sumNumbers(a,b){ return a+b; }\n",
      "src/report.mjs":"import { sumNumbers } from \"./math.mjs\";\nexport function report(a,b){ return \"total=\"+sumNumbers(a,b); }\n",
      "verify.mjs":[
        'import { addNumbers } from "./src/math.mjs";',
        'import { report } from "./src/report.mjs";',
        'if(addNumbers(2,3)!==5) throw new Error("addNumbers failed");',
        'if(report(4,5)!=="total=9") throw new Error("report failed");',
        'console.log("BENCH_MULTI_PASS");',
        "",
      ].join("\n"),
    },
    prompt:"Complete the coding task in TASK.md. Inspect the repository, make the required edits, and run the requested verification. Do not merely explain.",
    verify:async root=>{
      await verifyNode(root,"verify.mjs","BENCH_MULTI_PASS");
      const math=await readFile(join(root,"src/math.mjs"),"utf8"),report=await readFile(join(root,"src/report.mjs"),"utf8");
      assert.match(math,/addNumbers/);assert.doesNotMatch(math,/sumNumbers/);assert.match(report,/addNumbers/);assert.doesNotMatch(report,/sumNumbers/);
    },
  },
  {
    name:"test-failure-repair",
    requireVerificationBeforeEdit:true,
    files:{
      "TASK.md":[
        "# Task",
        "Run node verify.mjs first.",
        "Diagnose the failing behavior and fix the implementation.",
        "Do not modify verify.mjs.",
        "Re-run the verification until it passes.",
        "",
      ].join("\n"),
      "src/slug.mjs":"export function slugify(value){ return String(value).toLowerCase().replace(/\\s+/g,\"_\"); }\n",
      "verify.mjs":[
        'import { slugify } from "./src/slug.mjs";',
        'if(slugify(" Hello   World ")!=="hello-world") throw new Error("slugify should trim and use hyphens");',
        'console.log("BENCH_REPAIR_PASS");',
        "",
      ].join("\n"),
    },
    prompt:"Run node verify.mjs before making any edit. Then complete TASK.md as an autonomous coding agent: use the failing verification as evidence, repair the implementation without changing verify.mjs, and rerun node verify.mjs until it passes.",
    verify:async root=>{
      const verifyBefore=[
        'import { slugify } from "./src/slug.mjs";',
        'if(slugify(" Hello   World ")!=="hello-world") throw new Error("slugify should trim and use hyphens");',
        'console.log("BENCH_REPAIR_PASS");',
        "",
      ].join("\n");
      await verifyNode(root,"verify.mjs","BENCH_REPAIR_PASS");
      assert.equal(await readFile(join(root,"verify.mjs"),"utf8"),verifyBefore);
    },
  },
  {
    name:"large-tool-output",
    requireVerificationBeforeEdit:true,
    requireVirtualizedOutput:true,
    files:{
      "TASK.md":[
        "# Task",
        "Run node noisy-verify.mjs.",
        "Use the evidence from the failing run to diagnose the problem, fix the project, and run it again.",
        "Do not weaken or edit noisy-verify.mjs.",
        "",
      ].join("\n"),
      "src/config.mjs":"export const mode=\"legacy\";\n",
      "expected-mode.txt":"strict\n",
      "noisy-verify.mjs":[
        'import { readFileSync } from "node:fs";',
        'import { mode } from "./src/config.mjs";',
        'const expected=readFileSync(new URL("./expected-mode.txt", import.meta.url),"utf8").trim();',
        'if(mode===expected){ console.log("BENCH_NOISY_PASS"); process.exit(0); }',
        'for(let i=0;i<900;i++) console.log("setup-noise-"+String(i).padStart(4,"0")+" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");',
        'console.error("CRITICAL_ASSERTION expected mode="+expected+" but received "+mode+"; inspect src/config.mjs");',
        'for(let i=0;i<900;i++) console.log("cleanup-noise-"+String(i).padStart(4,"0")+" yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy");',
        'process.exit(1);',
        "",
      ].join("\n"),
    },
    turns:[
      {
        prompt:"Run node noisy-verify.mjs now. Do not read or edit project files in this turn. Inspect only the command evidence Trebell returns; if output is virtualized, use the output handle only when the preview is insufficient.",
        toolAllowlist:["trebell_terminal/run","trebell_output"],
        maxModelTurns:8,maxToolCalls:1,
      },
      {
        prompt:"Now diagnose the failure you just observed, fix the project without weakening noisy-verify.mjs, and re-run node noisy-verify.mjs until it passes.",
        maxModelTurns:6,maxToolCalls:24,
      },
    ],
    requiredFirstTurnCommand:{command:"node",args:["noisy-verify.mjs"]},
    verify:async root=>{await verifyNode(root,"noisy-verify.mjs","BENCH_NOISY_PASS");assert.match(await readFile(join(root,"src/config.mjs"),"utf8"),/strict/)},
  },
  {
    name:"implicit-rerun-completion",
    default:false,
    requireVerificationBeforeEdit:true,
    forceOnlyToolSchema:true,
    forceSingleToolCall:true,
    forceToolSequence:[
      {namespace:"trebell_terminal",name:"run"},
      {namespace:"trebell_workspace",name:"read_file"},
      {namespace:"trebell_workspace",name:"replace_text"},
      {namespace:"trebell_terminal",name:"run"},
      false,
    ],
    toolAllowlist:["trebell_terminal/run","trebell_workspace/read_file","trebell_workspace/replace_text"],
    files:{
      "src/config.mjs":"export const mode=\"legacy\";\n",
      "verify.mjs":[
        'import { mode } from "./src/config.mjs";',
        'if(mode!=="strict") throw new Error("expected strict mode");',
        'console.log("BENCH_IMPLICIT_PASS");',
        "",
      ].join("\n"),
    },
    prompt:"Do not edit verify.mjs or any other file. Run node verify.mjs first. Then read src/config.mjs, replace only legacy with strict, and rerun it until it passes.",
    verify:async root=>{await verifyNode(root,"verify.mjs","BENCH_IMPLICIT_PASS");assert.equal(await readFile(join(root,"src/config.mjs"),"utf8"),'export const mode="strict";\n')},
  },
  {
    name:"cross-turn-verifier-replay",
    default:false,
    requireVerificationBeforeEdit:true,
    forceOnlyToolSchema:true,
    forceSingleToolCall:true,
    forceToolSequence:[
      {namespace:"trebell_terminal",name:"run"},
      false,
      {namespace:"trebell_workspace",name:"replace_text"},
      {namespace:"trebell_terminal",name:"run"},
      false,
    ],
    files:{
      "src/config.mjs":"export const mode=\"legacy\";\n",
      "verify.mjs":[
        'import { mode } from "./src/config.mjs";',
        'if(mode!=="strict") throw new Error("expected strict mode");',
        'console.log("BENCH_CROSS_TURN_PASS");',
        "",
      ].join("\n"),
    },
    turns:[
      {
        prompt:"Run node verify.mjs now and report the failure. Do not edit anything in this turn.",
        toolAllowlist:["trebell_terminal/run"],
        maxModelTurns:4,maxToolCalls:4,
      },
      {
        prompt:"Now replace only legacy with strict in src/config.mjs, then rerun node verify.mjs until it passes.",
        toolAllowlist:["trebell_terminal/run","trebell_workspace/replace_text"],
        maxModelTurns:5,maxToolCalls:6,
      },
    ],
    verify:async root=>{await verifyNode(root,"verify.mjs","BENCH_CROSS_TURN_PASS");assert.equal(await readFile(join(root,"src/config.mjs"),"utf8"),'export const mode="strict";\n')},
  },
  {
    name:"large-tool-output-same-turn",
    default:false,
    requireVerificationBeforeEdit:true,
    requireVirtualizedOutput:true,
    forceToolSequence:[
      {namespace:"trebell_terminal",name:"run"},
      {namespace:"trebell_workspace",name:"read_file"},
      {namespace:"trebell_workspace",name:"replace_text"},
      {namespace:"trebell_terminal",name:"run"},
      false,
    ],
    toolAllowlist:["trebell_terminal/run","trebell_workspace/read_file","trebell_workspace/replace_text"],
    files:{
      "TASK.md":[
        "# Task",
        "Run node noisy-verify.mjs first.",
        "Use the failure evidence to diagnose and fix the project, then rerun the same verifier until it passes.",
        "Do not weaken or edit noisy-verify.mjs.",
        "",
      ].join("\n"),
      "src/config.mjs":"export const mode=\"legacy\";\n",
      "expected-mode.txt":"strict\n",
      "noisy-verify.mjs":[
        'import { readFileSync } from "node:fs";',
        'import { mode } from "./src/config.mjs";',
        'const expected=readFileSync(new URL("./expected-mode.txt", import.meta.url),"utf8").trim();',
        'if(mode===expected){ console.log("BENCH_NOISY_PASS"); process.exit(0); }',
        'for(let i=0;i<900;i++) console.log("setup-noise-"+String(i).padStart(4,"0")+" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");',
        'console.error("CRITICAL_ASSERTION expected mode="+expected+" but received "+mode+"; inspect src/config.mjs");',
        'for(let i=0;i<900;i++) console.log("cleanup-noise-"+String(i).padStart(4,"0")+" yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy");',
        'process.exit(1);',
        "",
      ].join("\n"),
    },
    prompt:"Complete this exact workflow in one turn. First run node noisy-verify.mjs. Then read src/config.mjs. Then replace only legacy with strict in src/config.mjs. Then run node noisy-verify.mjs again. After the passing verifier, answer with a concise summary. Do not edit noisy-verify.mjs or TASK.md and do not use other files.",
    verify:async root=>{await verifyNode(root,"noisy-verify.mjs","BENCH_NOISY_PASS");assert.match(await readFile(join(root,"src/config.mjs"),"utf8"),/strict/)},
  },
  {
    name:"cross-turn-verifier-replay",
    default:false,
    requireVerificationBeforeEdit:true,
    forceOnlyToolSchema:true,
    forceSingleToolCall:true,
    forceToolSequence:[
      {namespace:"trebell_terminal",name:"run"},
      false,
      {namespace:"trebell_workspace",name:"read_file"},
      {namespace:"trebell_workspace",name:"replace_text"},
      {namespace:"trebell_terminal",name:"run"},
      false,
    ],
    files:{
      "src/config.mjs":"export const mode=\"legacy\";\n",
      "verify.mjs":[
        'import { mode } from "./src/config.mjs";',
        'if(mode!=="strict") throw new Error("expected strict mode");',
        'console.log("BENCH_CROSS_TURN_PASS");',
        "",
      ].join("\n"),
    },
    turns:[
      {
        prompt:"Run node verify.mjs now. Do not read or edit project files in this turn. Report the result.",
        toolAllowlist:["trebell_terminal/run"],maxModelTurns:4,maxToolCalls:8,
      },
      {
        prompt:"Now read src/config.mjs, replace only legacy with strict, and rerun node verify.mjs until it passes.",
        toolAllowlist:["trebell_terminal/run","trebell_workspace/read_file","trebell_workspace/replace_text"],maxModelTurns:6,maxToolCalls:12,
      },
    ],
    verify:async root=>{await verifyNode(root,"verify.mjs","BENCH_CROSS_TURN_PASS");assert.equal(await readFile(join(root,"src/config.mjs"),"utf8"),'export const mode="strict";\n')},
  },
];

const env={...process.env,VYCEAI_API_KEY:apiKey};
const streamVyce=["1","true","yes"].includes(String(process.env.TREBELL_VYCE_STREAMING||"").trim().toLowerCase());
const manager=new ProviderManager({env}),catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native benchmark.");

async function runScenario(scenario){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bench-")),events=[],updates=[],virtualized=[];
  try{
    await writeFixture(root,scenario.files);
    const scenarioEnv={...env,...(scenario.environment||{})};
    const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
    const outputStore=new NativeToolOutputStore({
      directory:join(root,".trebell-output"),
      onVirtualized:info=>{
        virtualized.push(info);
        if(!tools.some(item=>item?.name==="trebell_output"))tools.push(...platformDynamicToolNamespaces({repository:false,output:true,workspaceTools:false,terminal:false,browser:false,computer:false,sourceControl:false,delegation:false}));
      },
      environment:scenarioEnv,
    });
    const contextEngine=new ContextEngine(),builtins=createNativeBuiltins({root,environment:scenarioEnv});
    const discoverRepositoryTools=({query,limit=8}={})=>{
      const matches=searchRepositoryToolDefinitions({query,limit,exclude:(tools.find(item=>item?.name==="trebell_repo")?.tools||[]).map(item=>item.name)});
      const capabilities=matches.map(item=>{
        const [namespace]=repositoryDynamicToolNamespace({names:[item.name],includeDiscovery:false}),tool=namespace?.tools?.[0];
        return {name:item.name,description:item.description,inputSchema:tool?.inputSchema||{type:"object",properties:{}}};
      });
      return {success:true,query:String(query||""),capabilities,instruction:capabilities.length?"Call trebell_repo/invoke with one returned capability name and matching arguments.":"No matching advanced capability."};
    };
    const executor=createNativeToolExecutor({
      contextEngine,root,repository:true,discoverRepositoryTools,outputStore,environment:scenarioEnv,
      policyContext:{permissionProfile:"full",runtime:"native",workspace:root,projectAvailable:true},
      executeShared:call=>{
        if(["trebell_workspace","trebell_terminal"].includes(call.namespace))return builtins(call);
        throw new Error("Unsupported benchmark shared tool: "+call.namespace+"/"+call.name);
      },
    });
    const providerRequests=[];
    const session=new NativeAgentSession({
      cwd:root,provider:"vyceai",model,tools,toolOutputStore:outputStore,executeTool:executor,
      initialMessages:[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})}],
      providerTurn:async request=>{
        const requestNumber=providerRequests.length+1;
        const forcedSequence=Array.isArray(scenario.forceToolSequence)?scenario.forceToolSequence:null;
        const forcedChoice=forcedSequence&&requestNumber<=forcedSequence.length?forcedSequence[requestNumber-1]:requestNumber===1&&scenario.forceFirstTool?scenario.forceFirstTool:null;
        const forcedTools=forcedChoice&&scenario.forceOnlyToolSchema===true
          ?(Array.isArray(request.tools)?request.tools:[]).flatMap(namespace=>{
            if(namespace?.type!=="namespace"||namespace?.name!==forcedChoice.namespace)return [];
            const selected=(Array.isArray(namespace.tools)?namespace.tools:[]).filter(tool=>tool?.name===forcedChoice.name);
            return selected.length?[{...namespace,tools:selected}]:[];
          })
          :request.tools;
        const effectiveRequest=forcedChoice===false
          ?{...request,tools:[],toolChoice:"none",parallelToolCalls:false}
          :forcedChoice
            ?{...request,tools:forcedTools,toolChoice:forcedChoice,parallelToolCalls:false}
            :request;
        const requestMessages=Array.isArray(effectiveRequest.messages)?effectiveRequest.messages:[],requestTools=Array.isArray(effectiveRequest.tools)?effectiveRequest.tools:[];
        const wireChat=providerTurnToChat({...effectiveRequest,model}),wireTools=Array.isArray(wireChat.tools)?wireChat.tools:[],wireMessages=Array.isArray(wireChat.messages)?wireChat.messages:[];
        const record={
          messageChars:JSON.stringify(requestMessages).length,
          toolSchemaChars:JSON.stringify(requestTools).length,
          wireMessageChars:JSON.stringify(wireMessages).length,
          wireToolSchemaChars:JSON.stringify(wireTools).length,
          wireRequestBytes:Buffer.byteLength(JSON.stringify(wireChat),"utf8"),
          functionCount:requestTools.reduce((sum,item)=>sum+(Array.isArray(item?.tools)?item.tools.length:1),0),
          toolNamespaces:requestTools.map(item=>String(item?.name||item?.function?.name||"")).filter(Boolean),
          functionNames:requestTools.flatMap(item=>Array.isArray(item?.tools)?item.tools.map(tool=>String(item?.name||"")+"/"+String(tool?.name||"")):[String(item?.function?.name||item?.name||"")]).filter(Boolean),
          requestMetrics:nativeRequestMetrics(requestMessages,requestTools),
        };
        providerRequests.push(record);
        try{
          const response=await manager.turn("vyceai",{...effectiveRequest,provider:"vyceai",model},{signal:request.signal,streamChat:streamVyce});
          const normalizedResponse=forcedChoice&&scenario.forceSingleToolCall===true&&Array.isArray(response.toolCalls)
            ?{...response,toolCalls:response.toolCalls.filter(call=>call?.namespace===forcedChoice.namespace&&call?.name===forcedChoice.name).slice(0,1)}
            :response;
          record.usage=response.usage;record.telemetry=response.telemetry;record.toolCalls=normalizedResponse.toolCalls||[];record.responseTextChars=String(normalizedResponse.text||"").length;record.finishReason=normalizedResponse.finishReason||null;
          return normalizedResponse;
        }catch(error){
          record.telemetry=error?.telemetry||null;record.error={status:Number(error?.status||0)||null,code:error?.code||null,retryable:Boolean(error?.retryable)};throw error;
        }
      },
      onEvent:event=>events.push(event),onUpdate:update=>updates.push(update),
    });
    await session.start({providerSessionId:"bench-"+scenario.name,model});
    const turnSpecs=Array.isArray(scenario.turns)&&scenario.turns.length?scenario.turns:[{prompt:scenario.prompt,maxModelTurns:10,maxToolCalls:80,toolAllowlist:scenario.toolAllowlist}],turnResults=[],turnToolDetails=[];let turnFailure=null;
    const started=performance.now();
    for(const turn of turnSpecs){
      const beforeToolUpdates=updates.filter(item=>item.update?.sessionUpdate==="tool_call_update").length;
      const packet=await contextEngine.buildPacket({root,task:turn.prompt,focusPaths:Object.prototype.hasOwnProperty.call(scenario.files,"TASK.md")?["TASK.md"]:[]});
      const additionalContext=repositoryContextEntries(packet,{seedOnly:true,currentTask:turn.prompt});
      const prompt=await contextualAgentPrompt([{type:"text",text:turn.prompt}],additionalContext);
      try{
        turnResults.push(await session.prompt(prompt,{
          maxModelTurns:turn.maxModelTurns||10,maxToolCalls:turn.maxToolCalls||80,maxWallTimeMs:240_000,
          toolAllowlist:Array.isArray(turn.toolAllowlist)?turn.toolAllowlist:null,
        }));
        const completedToolUpdates=updates.filter(item=>item.update?.sessionUpdate==="tool_call_update").slice(beforeToolUpdates);
        turnToolDetails.push(completedToolUpdates.map(item=>({
          tool:String(item.update?.namespace||"")+"/"+String(item.update?.tool||""),
          arguments:item.update?.rawInput&&typeof item.update.rawInput==="object"?item.update.rawInput:{},
          status:item.update?.status||null,
        })));
      }catch(error){
        turnFailure={code:error?.code||null,message:String(error?.message||error).slice(0,2000),modelTurns:Number(error?.nativeModelTurns||0),toolCalls:Number(error?.nativeToolCalls||0),usage:error?.nativeUsage||null};
        break;
      }
    }
    const elapsedMs=Number((performance.now()-started).toFixed(3));
    let independentVerificationPassed=true,independentVerificationError=null;
    try{await scenario.verify(root)}catch(error){independentVerificationPassed=false;independentVerificationError=String(error?.stderr||error?.message||error).slice(0,2000)}
    const requested=events.filter(event=>event.name==="native.model.requested"),completed=events.filter(event=>event.name==="native.model.completed"),retryEvents=events.filter(event=>event.name==="native.model.retrying"),toolUpdates=updates.filter(item=>item.update?.sessionUpdate==="tool_call_update");
    const firstRequest=providerRequests[0]||{};
    const repairedToolCalls=events.filter(event=>event.name==="native.tool.call_repaired").length;
    const sameTurnCooling=events.filter(event=>event.name==="native.tool.history_cooled"&&event.data?.phase==="same_turn");
    const failedToolCalls=toolUpdates.filter(item=>item.update?.status==="failed").length;
    const aggregate=providerRequests.reduce((out,item)=>{
      const ttft=optionalFiniteMetric(item.telemetry?.timeToFirstTokenMs);
      return {
        inputTokens:out.inputTokens+Number(item.usage?.inputTokens||0),
        outputTokens:out.outputTokens+Number(item.usage?.outputTokens||0),
        cachedInputTokens:out.cachedInputTokens+Number(item.usage?.cachedInputTokens||0),
        requestBytes:out.requestBytes+Number(item.telemetry?.requestBytes||0),
        responseBytes:out.responseBytes+Number(item.telemetry?.responseBytes||0),
        responseHeadersLatencyMs:out.responseHeadersLatencyMs+Number(item.telemetry?.responseHeadersLatencyMs||0),
        responseBodyLatencyMs:out.responseBodyLatencyMs+Number(item.telemetry?.responseBodyLatencyMs||0),
        timeToFirstTokenMs:out.timeToFirstTokenMs+(ttft??0),
        ttftSamples:out.ttftSamples+(ttft==null?0:1),
        providerLatencyMs:out.providerLatencyMs+Number(item.telemetry?.totalLatencyMs||0),
      };
    },{inputTokens:0,outputTokens:0,cachedInputTokens:0,requestBytes:0,responseBytes:0,responseHeadersLatencyMs:0,responseBodyLatencyMs:0,timeToFirstTokenMs:0,ttftSamples:0,providerLatencyMs:0});
    aggregate.timeToFirstTokenMs=optionalMetricTotal(aggregate.timeToFirstTokenMs,aggregate.ttftSamples);
    const toolTiming=nativeToolTiming(events,{elapsedMs,providerLatencyMs:aggregate.providerLatencyMs});
    const toolNames=toolUpdates.map(item=>item.update?.namespace+"/"+item.update?.tool);
    const firstVerifyIndex=toolNames.indexOf("trebell_terminal/run");
    const firstEditIndex=toolNames.findIndex(name=>name==="trebell_workspace/replace_text"||name==="trebell_workspace/write_file");
    const verificationBeforeEdit=!scenario.requireVerificationBeforeEdit||(firstVerifyIndex>=0&&(firstEditIndex<0||firstVerifyIndex<firstEditIndex));
    const requiredFirstTurn=scenario.requiredFirstTurnCommand;
    const firstTurnExactCommand=!requiredFirstTurn||(()=>{
      const first=turnToolDetails[0]||[];if(first.length!==1)return false;
      const detail=first[0],args=detail.arguments||{};
      return detail.tool==="trebell_terminal/run"&&detail.status==="completed"&&String(args.command||"")===String(requiredFirstTurn.command||"")&&JSON.stringify(Array.isArray(args.args)?args.args.map(String):[])===JSON.stringify((requiredFirstTurn.args||[]).map(String));
    })();
    const virtualizationSatisfied=!scenario.requireVirtualizedOutput||virtualized.length>0;
    const agentMessages=updates.filter(item=>item.update?.sessionUpdate==="agent_message_chunk").map(item=>String(item.update?.content?.text||"")).filter(Boolean);
    const toolDetails=toolUpdates.map(item=>{
      const update=item.update||{},raw=update.rawOutput&&typeof update.rawOutput==="object"?update.rawOutput:{};
      return {
        tool:String(update.namespace||"")+"/"+String(update.tool||""),
        arguments:update.rawInput&&typeof update.rawInput==="object"?update.rawInput:{},
        status:update.status||null,
        outputHandle:raw?._trebell_output?.handle||null,
        outputBytes:raw?._trebell_output?.totalBytes||null,
        previewTail:typeof raw?.preview==="string"?raw.preview.slice(-1200):null,
        error:typeof raw?.error==="string"?raw.error.slice(0,1000):null,
      };
    });
    return {
      name:scenario.name,ok:!turnFailure&&independentVerificationPassed&&verificationBeforeEdit&&virtualizationSatisfied&&firstTurnExactCommand,elapsedMs,userTurns:turnResults.length,modelTurns:requested.length,providerAttempts:providerRequests.length,providerRetryAttempts:retryEvents.length,toolCalls:toolUpdates.length,
      ...aggregate,...toolTiming,cacheHitPercent:aggregate.inputTokens?Number((aggregate.cachedInputTokens/aggregate.inputTokens*100).toFixed(2)):0,
      stablePrefixVariants:new Set(completed.map(event=>event.data?.requestMetrics?.stablePrefixHash).filter(Boolean)).size,
      toolSchemaVariants:new Set(completed.map(event=>event.data?.requestMetrics?.toolSchemaHash).filter(Boolean)).size,
      firstSchemaEstimatedTokens:completed[0]?.data?.requestMetrics?.toolSchemas?.estimatedTokens||0,
      firstSchemaChars:Number(firstRequest.toolSchemaChars||0),
      firstWireSchemaChars:Number(firstRequest.wireToolSchemaChars||0),
      firstFunctionCount:Number(firstRequest.functionCount||0),
      finalLogicalEstimatedTokens:completed.at(-1)?.data?.requestMetrics?.totalLogical?.estimatedTokens||0,
      requestBreakdown:providerRequests.map((item,index)=>({
        providerAttempt:index+1,
        providerToolCalls:Array.isArray(item.toolCalls)?item.toolCalls.length:0,
        providerToolNames:(Array.isArray(item.toolCalls)?item.toolCalls:[]).map(call=>String(call?.namespace||"")+"/"+String(call?.name||"")),
        providerInputTokens:Number(item.usage?.inputTokens||0),
        providerResponseHeadersLatencyMs:Number(item.telemetry?.responseHeadersLatencyMs||0),
        providerResponseBodyLatencyMs:Number(item.telemetry?.responseBodyLatencyMs||0),
        providerTimeToFirstTokenMs:optionalFiniteMetric(item.telemetry?.timeToFirstTokenMs),
        providerTotalLatencyMs:Number(item.telemetry?.totalLatencyMs||0),
        providerStreaming:Boolean(item.telemetry?.streaming),
        providerError:item.error||null,
        providerResponseTextChars:Number(item.responseTextChars||0),
        providerFinishReason:item.finishReason||null,
        providerResponseEmpty:!Number(item.responseTextChars||0)&&!(Array.isArray(item.toolCalls)&&item.toolCalls.length),
        providerFunctionCount:Number(item.functionCount||0),
        providerToolNamespaces:Array.isArray(item.toolNamespaces)?item.toolNamespaces:[],
        providerVisibleFunctions:Array.isArray(item.functionNames)?item.functionNames:[],
        messageChars:Number(item.messageChars||0),
        schemaChars:Number(item.toolSchemaChars||0),
        wireMessageChars:Number(item.wireMessageChars||0),
        wireSchemaChars:Number(item.wireToolSchemaChars||0),
        wireRequestBytes:Number(item.wireRequestBytes||0),
        systemTokens:Number(item.requestMetrics?.system?.estimatedTokens||0),
        currentUserTokens:Number(item.requestMetrics?.currentUser?.estimatedTokens||0),
        workingContextTokens:Number(item.requestMetrics?.workingContext?.estimatedTokens||0),
        conversationHistoryTokens:Number(item.requestMetrics?.conversationHistory?.estimatedTokens||0),
        toolResultTokens:Number(item.requestMetrics?.toolResults?.estimatedTokens||0),
        compactedContextTokens:Number(item.requestMetrics?.compactedContext?.estimatedTokens||0),
        toolSchemaTokens:Number(item.requestMetrics?.toolSchemas?.estimatedTokens||0),
        logicalTokens:Number(item.requestMetrics?.totalLogical?.estimatedTokens||0),
      })),
      virtualizedOutputs:virtualized.length,repairedToolCalls,failedToolCalls,
      sameTurnCooledOutputs:sameTurnCooling.reduce((sum,event)=>sum+Number(event.data?.count||0),0),
      sameTurnCooledChars:sameTurnCooling.reduce((sum,event)=>sum+Number(event.data?.savedChars||0),0),
      priorTerminalEvidence:events.filter(event=>event.name==="native.verification.prior_terminal_evidence").reduce((sum,event)=>sum+Number(event.data?.count||0),0),
      directTerminalStatusExecutions:events.filter(event=>event.name==="native.terminal.direct_status_executed").length,
      autoVerifierReruns:events.filter(event=>event.name==="native.verification.auto_rerun").length,
      synthesizedVerificationCompletions:events.filter(event=>event.name==="native.verification.completion_synthesized").length,
      virtualizedBytes:virtualized.reduce((sum,item)=>sum+Number(item.totalBytes||0),0),
      usedOutputRetrieval:toolUpdates.some(item=>item.update?.namespace==="trebell_output"),
      turnFailure,independentVerificationPassed,independentVerificationError,verificationBeforeEdit,virtualizationSatisfied,firstTurnExactCommand,turnToolDetails,
      finalAgentMessage:agentMessages.at(-1)?.slice(-2000)||"",
      tools:toolNames,
      toolDetails,
    };
  }finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}

const selectedName=String(process.env.TREBELL_NATIVE_BENCH_SCENARIO||"").trim();
const selectedScenarios=selectedName?scenarios.filter(item=>item.name===selectedName):scenarios.filter(item=>item.default!==false);
if(!selectedScenarios.length)throw new Error("Unknown TREBELL_NATIVE_BENCH_SCENARIO: "+selectedName);
const results=[];
for(const scenario of selectedScenarios){
  console.error("[benchmark] "+scenario.name);
  results.push(await runScenario(scenario));
}
const totals=results.reduce((out,row)=>({
  inputTokens:out.inputTokens+row.inputTokens,outputTokens:out.outputTokens+row.outputTokens,modelTurns:out.modelTurns+row.modelTurns,providerAttempts:out.providerAttempts+row.providerAttempts,providerRetryAttempts:out.providerRetryAttempts+row.providerRetryAttempts,toolCalls:out.toolCalls+row.toolCalls,elapsedMs:out.elapsedMs+row.elapsedMs,
  providerLatencyMs:out.providerLatencyMs+row.providerLatencyMs,responseHeadersLatencyMs:out.responseHeadersLatencyMs+row.responseHeadersLatencyMs,responseBodyLatencyMs:out.responseBodyLatencyMs+row.responseBodyLatencyMs,timeToFirstTokenMs:out.timeToFirstTokenMs+row.timeToFirstTokenMs,ttftSamples:out.ttftSamples+row.ttftSamples,
  toolExecutionMs:out.toolExecutionMs+row.toolExecutionMs,toolWallMs:out.toolWallMs+row.toolWallMs,parallelToolOverlapMs:out.parallelToolOverlapMs+row.parallelToolOverlapMs,otherElapsedMs:out.otherElapsedMs+row.otherElapsedMs,
}),{inputTokens:0,outputTokens:0,modelTurns:0,providerAttempts:0,providerRetryAttempts:0,toolCalls:0,elapsedMs:0,providerLatencyMs:0,responseHeadersLatencyMs:0,responseBodyLatencyMs:0,timeToFirstTokenMs:0,ttftSamples:0,toolExecutionMs:0,toolWallMs:0,parallelToolOverlapMs:0,otherElapsedMs:0});
totals.timeToFirstTokenMs=optionalMetricTotal(totals.timeToFirstTokenMs,totals.ttftSamples);
console.log(JSON.stringify({ok:results.every(row=>row.ok),runtime:"native",provider:"vyceai",model,streamingRequested:streamVyce,results,totals},null,2));

