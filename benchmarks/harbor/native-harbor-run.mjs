import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { ContextEngine } from "../../src/context-engine.mjs";
import { NativeBackgroundProcessManager } from "../../src/native-background-processes.mjs";
import { createNativeBuiltins } from "../../src/native-builtins.mjs";
import { NativeAgentSession, openAiServerCompactionArmTokens } from "../../src/native-agent-session.mjs";
import { NATIVE_CONFIGURATION_VERSION, NATIVE_REASONING_CONTEXT, nativeConfigurationSnapshot, nativeHarborRunConfiguration, nativePolicyContext, nativeSessionSettings, nativeSpecializedSelection, nativeToolNamespaceOptions, nativeTurnContextOptions, trebellDeveloperInstructions } from "../../src/native-configuration.mjs";
import { nativeProviderTurn } from "../../src/native-provider-turn.mjs";
import { nativeCacheCarryover } from "../../src/native-request-metrics.mjs";
import { createNativeSourceControl } from "../../src/native-source-control.mjs";
import { nativeSystemPrompt } from "../../src/native-system-prompt.mjs";
import { NativeToolOutputStore } from "../../src/native-tool-output-store.mjs";
import { createNativeToolExecutor } from "../../src/native-tool-executor.mjs";
import { discoverRepositoryCapabilities, exposedToolNamed, platformDynamicToolNamespaces } from "../../src/platform-tool-catalog.mjs";
import { providerFeatureEnabled } from "../../src/provider-capabilities.mjs";
import { ProviderManager } from "../../src/provider-manager.mjs";
import { providerTurnToResponses } from "../../src/provider-turn.mjs";
import { RepositoryKnowledgeService } from "../../src/repository-knowledge-service.mjs";
import { withWorkingContext } from "../../src/working-context-envelope.mjs";
import { repositoryContextEntries } from "../../ui/src/context-provenance.js";
import { createNativeStrategyMetrics, observeNativeStrategyEvent } from "./native-strategy-metrics.mjs";
import { createGateSnapshotter, parseGateSnapshotArtifacts } from "./native-gate-snapshots.mjs";
import { captureFinalDiff, createToolCallLogger } from "./native-audit-artifacts.mjs";

export const HARBOR_NATIVE_VERSION="trebell-native-harbor/1";

// The sha256 of every value of the shared configuration, recorded in each run's metrics.
export function nativeConfigurationHash(){
  return createHash("sha256").update(JSON.stringify(nativeConfigurationSnapshot())).digest("hex");
}

// Repository knowledge as the app keeps it for a project with none stored yet: the same service over an empty store, so
// trebell_repo knowledge_list and knowledge_context answer in a container exactly as they do for a fresh project.
function emptyRepositoryKnowledge(){
  return new RepositoryKnowledgeService({state:{repositoryKnowledge:()=>[],upsertRepositoryKnowledge:entry=>entry,removeRepositoryKnowledge:()=>false}});
}

// The benchmark runner's Native for one task: the app's Native (src/native-configuration.mjs) with the container's differences only
// (NATIVE_CONTAINER_ONLY there). Its environment is read only through nativeHarborRunConfiguration. trebell-native-runner.mjs runs
// it; tests/native-one-config-parity.test.mjs builds it beside the app's for the same task with a scripted provider.
export async function createHarborNativeRun({root=process.cwd(),instruction,env=process.env,manager:givenManager=null}={}){
  const task=String(instruction||"").trim();if(!task)throw new Error("Benchmark instruction is empty.");
  const config=nativeHarborRunConfiguration(env),{provider,model,probeOnly,liveProbe,liveProbeTurns}=config;
  const metricsPath=String(env.TREBELL_METRICS_PATH||"/logs/agent/trebell-native-metrics.json");
  const eventsPath=String(env.TREBELL_EVENTS_PATH||"/logs/agent/trebell-native-events.jsonl");
  const toolCallsPath=String(env.TREBELL_TOOL_CALLS_PATH||"/logs/agent/trebell-native-tool-calls.jsonl");
  const finalDiffPath=String(env.TREBELL_FINAL_DIFF_PATH||"/logs/agent/trebell-native-final.diff");
  const manager=givenManager||new ProviderManager({env});
  if(!probeOnly&&!manager.status(provider).hasKey)throw new Error("OPENAI_API_KEY is not configured.");

  // The tools a new Native thread in a project gets for this message: browser, desktop control and delegation are the window's, which
  // a container has none of; source control follows the task's text as in the app.
  const selected=nativeSpecializedSelection(task,{sourceControl:true,browser:false,computer:false,delegation:false});
  const stableOutputTools=providerFeatureEnabled(provider,"promptCaching")||providerFeatureEnabled(provider,"explicitCacheControl");
  const tools=platformDynamicToolNamespaces(nativeToolNamespaceOptions({projectless:false,stableOutputTools,selected}));
  // Not in /tmp, which a task's own cleanup can empty under the running agent: the Harbor adapter makes this folder beside the
  // runner and opens it to the agent's user.
  const outputDirectory=String(env.TREBELL_TOOL_OUTPUT_DIR||"/installed-agent/tool-output");
  const outputStore=new NativeToolOutputStore({directory:outputDirectory,environment:env});
  const toolCallLog=createToolCallLogger({path:toolCallsPath,environment:env});
  const contextEngine=new ContextEngine();
  const requests=[],assistantChunks=[],eventStarted=performance.now(),strategyMetrics=createNativeStrategyMetrics();let eventWrites=Promise.resolve();
  const gateSnapshots=createGateSnapshotter({artifacts:parseGateSnapshotArtifacts(env.TREBELL_HARBOR_GATE_SNAPSHOT_PATHS),directory:String(env.TREBELL_HARBOR_GATE_SNAPSHOT_DIR||"/logs/agent/gate-snapshots")});
  const onEvent=event=>{
    const row={atMs:Math.round(performance.now()-eventStarted),name:event?.name||null,status:event?.status||null,data:event?.data||null};
    observeNativeStrategyEvent(strategyMetrics,event,row.atMs);
    // Synchronous on purpose: capture the exact deliverable state the gate is about to judge.
    if(gateSnapshots.enabled&&row.name==="native.completion.gate_requested"){try{gateSnapshots.snapshot({atMs:row.atMs,modelTurn:row.data?.modelTurn??null,editRevision:row.data?.editRevision??null,toolCalls:row.data?.toolCalls??null})}catch{}}
    eventWrites=eventWrites.then(()=>appendFile(eventsPath,JSON.stringify(row)+"\n","utf8")).catch(()=>{});
  };
  const backgroundProcesses=new NativeBackgroundProcessManager({environment:env,onEvent});
  const builtins=createNativeBuiltins({root,environment:env,backgroundProcesses,threadId:"trebell-harbor"});
  const sourceControl=selected.sourceControl?createNativeSourceControl({root,environment:env}):null;
  // trebell_repo/discover answers as in the app (platform-tool-catalog.mjs).
  const discoverRepositoryTools=({query,limit=8}={})=>discoverRepositoryCapabilities(tools,{query,limit});
  const executor=createNativeToolExecutor({
    contextEngine,
    root,
    repository:true,
    knowledgeService:emptyRepositoryKnowledge(),
    discoverRepositoryTools,
    directTool:requested=>exposedToolNamed(tools,requested),
    outputStore,
    environment:env,
    projectAvailable:true,
    // The runner stands for a person who picked Full access, with no desktop and no delegation (container-only).
    policyContext:nativePolicyContext({permissionProfile:"full",workspace:root,projectAvailable:true}),
    executeShared:call=>{
      if(["trebell_workspace","trebell_terminal","trebell_process"].includes(call.namespace))return builtins(call);
      // link_pull_request is the one source-control tool the app's window serves.
      if(call.namespace==="trebell_source_control"&&call.name!=="link_pull_request"&&sourceControl)return sourceControl(call);
      throw new Error("Unsupported Harbor benchmark tool: "+call.namespace+"/"+call.name);
    },
  });
  const reasoningContext=config.reasoningContext||NATIVE_REASONING_CONTEXT;
  const session=new NativeAgentSession({
    cwd:root,
    provider,
    model,
    ...nativeSessionSettings({provider,model}),
    // Registered experiment switches (off unless set; written to metrics.experimentSwitches).
    semanticCompletionGate:config.semanticCompletionGate,
    contextWindow:config.contextWindow,
    openAiServerCompactionThreshold:config.compactionThreshold,
    reasoningEffort:config.reasoningEffort,
    serviceTier:config.serviceTier==="default"?null:config.serviceTier,
    tools,
    permissionMode:"full",
    toolOutputStore:outputStore,
    onEvent,
    onUpdate:update=>{if(update?.update?.sessionUpdate==="agent_message_chunk"&&typeof update.update.content?.text==="string")assistantChunks.push(update.update.content.text)},
    executeTool:toolCallLog.wrap(executor),
    initialMessages:[
      {role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},
      {role:"developer",content:trebellDeveloperInstructions({projectless:false,dynamicTools:true,browser:selected.browser,delegation:selected.delegation})},
    ],
    providerTurn:async request=>{
      const sent={...request,provider,model,...(config.reasoningContext?{reasoningContext:config.reasoningContext}:{})};
      if(probeOnly){
        const wire=providerTurnToResponses({...sent,reasoningContext},{flattenToolCallNames:true,preserveInstructionOrder:true});
        const probe={
          model,reasoningEffort:config.reasoningEffort,serviceTier:config.serviceTier,reasoningContext,
          messageCount:request.messages?.length||0,
          toolNamespaceCount:request.tools?.length||0,
          messageBytes:Buffer.byteLength(JSON.stringify(request.messages||[]),"utf8"),
          toolBytes:Buffer.byteLength(JSON.stringify(request.tools||[]),"utf8"),
          wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8"),
          messageChars:(request.messages||[]).reduce((n,item)=>n+(typeof item?.content==="string"?item.content.length:JSON.stringify(item?.content||"").length),0),
          systemChars:typeof request.messages?.[0]?.content==="string"?request.messages[0].content.length:0,
          userChars:typeof request.messages?.at?.(-1)?.content==="string"?request.messages.at(-1).content.length:JSON.stringify(request.messages?.at?.(-1)?.content||"").length,
        };
        console.log("TREBELL_HARBOR_PROBE "+JSON.stringify(probe));
        return {id:"probe",provider,model,text:"probe complete",toolCalls:[],usage:{inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0}};
      }
      const requestStarted=performance.now();
      // The app's provider turn (native-provider-turn.mjs), without a draft observer: the runner shows no drafts.
      const response=await nativeProviderTurn(manager,sent);
      requests.push({elapsedMs:Math.round(performance.now()-requestStarted),usage:response.usage||{},telemetry:response.telemetry||{}});
      if(liveProbe){
        console.log("TREBELL_HARBOR_LIVE_PROBE "+JSON.stringify({
          providerTurn:requests.length,
          elapsedMs:Math.round(performance.now()-requestStarted),
          usage:response.usage||{},
          toolCalls:(response.toolCalls||[]).map(call=>({namespace:call.namespace||null,name:call.name||null})),
          textChars:String(response.text||"").length,
          telemetry:response.telemetry||{},
        }));
        if(requests.length>=liveProbeTurns)return {...response,text:"probe complete",toolCalls:[]};
      }
      return response;
    },
  });
  await session.start({providerSessionId:"trebell-harbor",model});

  const packet=await contextEngine.buildPacket({root,task,focusPaths:[]});
  // The task reaches Native as the app sends a person's message: with its working context fenced in front of it.
  const prompt=withWorkingContext([{type:"text",text:task}],Object.entries(repositoryContextEntries(packet,nativeTurnContextOptions(task))));
  const promptOptions={...config.budgets};

  async function run(){
    const started=performance.now();
    let result,error=null;
    try{
      result=await session.prompt(prompt,promptOptions);
    }catch(failure){
      error=failure;
    }
    const elapsedMs=Math.round(performance.now()-started);
    const finalDiff=probeOnly||liveProbe?null:await captureFinalDiff({root,path:finalDiffPath,environment:env});
    await toolCallLog.flush();
    const raw=result?.raw||{};
    const failureUsage=error?.nativeUsage&&typeof error.nativeUsage==="object"?error.nativeUsage:null;
    const {contextWindow,compactionThreshold}=config;
    const metrics={
      version:HARBOR_NATIVE_VERSION,
      model,
      reasoningEffort:config.reasoningEffort,
      serviceTier:config.serviceTier,
      reasoningContext,
      // The shared configuration this run ran (src/native-configuration.mjs) and every benchmark switch that was set: a readout lane
      // carries none (the launcher refuses one, the integrity audit fails one).
      configurationVersion:NATIVE_CONFIGURATION_VERSION,
      configurationHash:nativeConfigurationHash(),
      experimentSwitches:config.experimentSwitches,
      picksDifferFromShared:config.picksDifferFromShared,
      effectiveServiceTiers:[...new Set(requests.map(item=>String(item?.telemetry?.serviceTier||"").trim()).filter(Boolean))],
      // Requests carry context_management only once the largest observed input (main or gate) reaches
      // armAtMaxObservedInputTokens; the session then keeps it armed. native.model.requested reports serverCompactionArmed.
      contextPolicy:{operatingContextWindow:contextWindow,serverCompactionThreshold:compactionThreshold,serverCompactionArming:{armAtMaxObservedInputTokens:openAiServerCompactionArmTokens(compactionThreshold),staysArmed:true},retroactiveOpenAiReadCooling:!compactionThreshold},
      effectiveReasoningContexts:[...new Set(requests.map(item=>String(item?.telemetry?.reasoningContext||"").trim()).filter(Boolean))],
      budgets:{maxModelTurns:promptOptions.maxModelTurns,maxToolCalls:promptOptions.maxToolCalls,maxWallTimeMs:promptOptions.maxWallTimeMs},
      semanticCompletionGate:config.semanticCompletionGate,
      toolNamespaces:tools.map(item=>item.name),
      elapsedMs,
      modelTurns:Number(raw.modelTurns)||Number(error?.nativeModelTurns)||requests.length,
      toolCalls:Number(raw.toolCalls)||Number(error?.nativeToolCalls)||0,
      usage:raw.usage||failureUsage||{},
      providerRequests:requests.length,
      providerRequestElapsedMs:requests.reduce((total,item)=>total+Number(item?.elapsedMs||0),0),
      cacheCarryover:nativeCacheCarryover(requests.map(item=>item?.usage||{})),
      strategy:strategyMetrics,
      gateSnapshots:gateSnapshots.count,
      // The agent's background processes still running at the end, which the run leaves running (releaseAll below).
      backgroundProcessesAtEnd:backgroundProcesses.list("trebell-harbor",{limit:200}).data.map(item=>({handle:item.handle,command:item.command})),
      auditArtifacts:{toolCalls:toolCallsPath,finalDiff:finalDiff?{path:finalDiffPath,...finalDiff}:null},
      finalReply:assistantChunks.join("").trim().slice(-4000),
      error:error?String(error?.stack||error?.message||error).slice(-8000):null,
    };
    await eventWrites;
    try{
      await writeFile(metricsPath,JSON.stringify(metrics,null,2)+"\n","utf8");
      if(metrics.finalReply)console.log(metrics.finalReply);
      console.log("TREBELL_HARBOR_METRICS "+JSON.stringify(metrics));
    }finally{
      // The processes the agent started and left running stay up after the run, as they do after a turn in the app: a server,
      // watcher or daemon the task asked for is part of the result. Only remote ones are stopped.
      const released=await backgroundProcesses.releaseAll().catch(()=>[]);
      if(released.length)console.error(`Trebell Native left ${released.length===1?"1 background process":released.length+" background processes"} running: ${released.map(item=>`${item.handle} (pid ${item.osPid}) ${item.command}`).join("; ")}`);
      await eventWrites;
      await session.close().catch(()=>{});
      manager.close();
    }
    if(error)throw error;
    return metrics;
  }
  return {config,tools,session,prompt,promptOptions,selected,executor,run};
}
