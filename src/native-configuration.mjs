// Trebell Native's one configuration. The owner, 2026-10-29: "The native we benchmark with and ship should be the same."
// The app (src/agent-relay.mjs building NativeAgentSession, src/native-agent-session.mjs, src/gui-server.mjs and ui/src) and the
// Harbor benchmark runner (benchmarks/harbor/native-harbor-run.mjs, run by trebell-native-runner.mjs) read every setting that
// changes what Native does from here: the loop's options, the per-message budgets, the completion check and its recovery, the long-
// context policy, the reasoning context, effort and tier defaults, the tool namespaces, the developer text, the first message's
// working context and the provider request's options. tests/native-one-config-parity.test.mjs builds both for the same task and
// compares what they send byte for byte, apart from NATIVE_CONTAINER_ONLY below.
//
// Each value is the one the benchmarks found best by the mission's rule (goal.md section 1: as many or more resolved tasks first, then
// lower cost); where nothing was measured it is the app's product default, marked unmeasured in NATIVE_SETTINGS_EVIDENCE.
//
// No imports and no work at load: the UI's first bundle reads the tool selection, the developer text and the effort default from
// here, so everything else must tree-shake away (B11, tests/bundle-budgets.test.mjs).

export const NATIVE_CONFIGURATION_VERSION="2026-10-29.1";

// The loop options every Native message runs with (runNativeAgentTurn in src/native-agent-loop.mjs). The semantic completion gate is
// off, and with it every mid-task controller checkpoint (midTaskProgressEnabled) and the gate's recovery; one recovery epoch is kept
// for when an experiment turns the gate on.
export const NATIVE_LOOP_OPTIONS=/*#__PURE__*/Object.freeze({
  semanticCompletionGate:false,
  midTaskProgressCheckpoints:false,
  maxCompletionRecoveryEpochs:1,
  autoRerunVerification:true,
  synthesizeTerminalReports:true,
  directTerminalStatusCommands:true,
  directExactReplacementStatus:true,
  directExactWriteStatus:true,
  directExactReadStatus:true,
  directExactListStatus:true,
  directGitStatus:true,
  directProcessRunningStatus:true,
  directBrowserRuntimeStatus:true,
  directBrowserScreenshot:true,
});

// Per-message ceilings. Deliberately non-binding, as no other harness in the app caps a message: Stop and a goal's budgets stay the
// person's controls. The loop clamps at the same values (nativeAgentBudget).
export const NATIVE_BUDGETS=/*#__PURE__*/Object.freeze({maxModelTurns:500,maxToolCalls:5000,maxWallTimeMs:null});

// A message's budgets: the shared ceilings, lowered (never raised) by what an active goal has left.
export function nativePromptBudgets(goal=null){
  const out={...NATIVE_BUDGETS};
  if(!goal||typeof goal!=="object")return out;
  if(goal.turnBudgetRemaining!=null)out.maxModelTurns=Math.max(1,Math.min(NATIVE_BUDGETS.maxModelTurns,Math.floor(Number(goal.turnBudgetRemaining)||1)));
  if(goal.timeBudgetRemainingMinutes!=null)out.maxWallTimeMs=Math.max(1,Math.floor(Number(goal.timeBudgetRemainingMinutes)*60_000));
  if(goal.toolCallBudget!=null&&goal.toolCallTelemetryComplete!==false)out.maxToolCalls=Math.max(0,Math.min(NATIVE_BUDGETS.maxToolCalls,Math.floor(Number(goal.toolCallBudget)-Number(goal.toolCallsUsed||0))||0));
  if(goal.tokenBudgetRemaining!=null)out.maxOutputTokens=Math.max(1,Math.floor(Number(goal.tokenBudgetRemaining)||1));
  return out;
}

// OpenAI's reasoning context, set on every OpenAI request (memory native-tuning-guardrails: auto and all_turns were conflicting and
// sometimes much costlier). Other providers get none, as before.
export const NATIVE_REASONING_CONTEXT="current_turn";

// What a model was measured with. A model without a row keeps the app's rule: the catalog's window, client-side read cooling and the
// provider's own effort.
export const NATIVE_MEASURED_MODELS=/*#__PURE__*/Object.freeze({
  "openai:gpt-6-luna":/*#__PURE__*/Object.freeze({reasoningEffort:"max",contextWindow:272_000,serverCompactionThreshold:245_000}),
});

export function nativeMeasuredModel(provider,model){
  const key=String(provider||"").trim().toLowerCase()+":"+String(model||"").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(NATIVE_MEASURED_MODELS,key)?NATIVE_MEASURED_MODELS[key]:null;
}

// The model's settings for a session: the measured row's, else the catalog's window and no server compaction.
export function nativeModelSettings({provider=null,model=null,catalogContextWindow=null}={}){
  const measured=nativeMeasuredModel(provider,model),catalog=Math.trunc(Number(catalogContextWindow));
  return {
    measured:Boolean(measured),
    reasoningEffort:measured?.reasoningEffort??null,
    contextWindow:measured?.contextWindow??(Number.isFinite(catalog)&&catalog>0?catalog:null),
    serverCompactionThreshold:measured?.serverCompactionThreshold??null,
  };
}

// The session's own settings (NativeAgentSession's constructor) for a provider and model.
export function nativeSessionSettings({provider=null,model=null,catalogContextWindow=null}={}){
  const settings=nativeModelSettings({provider,model,catalogContextWindow});
  return {semanticCompletionGate:NATIVE_LOOP_OPTIONS.semanticCompletionGate,contextWindow:settings.contextWindow,openAiServerCompactionThreshold:settings.serverCompactionThreshold};
}

// No tier unless the person picks Speed > Fast (Standard: the cheaper of the two at the same model).
export const NATIVE_SERVICE_TIER_DEFAULT=null;

// The provider turn's transport options (src/native-provider-turn.mjs applies them, with the reasoning context).
export function nativeProviderTurnOptions(provider){
  return {promptCaching:provider==="anthropic",streamResponses:provider==="openai"};
}

// Specialized tool namespaces a message's text selects, where they are available. Background processes (trebell_process) are no
// longer selected: Native always has them.
const BROWSER_TASK=/\b(browser|website|web\s?page|webpage|playwright|dom|frontend|front-end|css|html|responsive|screenshot|browser console|network (?:request|error)|page load|url)\b/i;
const COMPUTER_TASK=/\b(computer use|desktop control|mouse|keyboard|screen coordinates?|primary display|desktop screenshot|windows desktop)\b/i;
const SOURCE_CONTROL_TASK=/\b(git|github|gitlab|branch|commit|push|pull request|merge request|source control|rebase|cherry-pick|upstream|remote branch|pr)\b/i;
const DELEGATION_TASK=/\b(delegate|delegation|parallel(?:ize|ized|ism)?|multi[- ]agent|fan[- ]out|independent subtasks?|in parallel)\b/i;

export function nativeSpecializedSelection(taskText,{browser=false,computer=false,sourceControl=false,delegation=false}={}){
  const task=String(taskText||"").toLowerCase();
  return {
    browser:Boolean(browser&&BROWSER_TASK.test(task)),
    computer:Boolean(computer&&COMPUTER_TASK.test(task)),
    sourceControl:Boolean(sourceControl&&SOURCE_CONTROL_TASK.test(task)),
    delegation:Boolean(delegation&&DELEGATION_TASK.test(task)),
  };
}

export function nativeSpecializedNamespaceNames(taskText,availability={}){
  const selected=nativeSpecializedSelection(taskText,availability),names=[];
  if(selected.browser)names.push("trebell_browser");
  if(selected.computer)names.push("trebell_computer");
  if(selected.sourceControl)names.push("trebell_source_control");
  if(selected.delegation)names.push("trebell_delegate");
  return names;
}

// The options of platformDynamicToolNamespaces (src/platform-tool-catalog.mjs) for a Native session. stableOutputTools: the provider
// caches prompts, so trebell_output is in the first request (otherwise it is added when an output is first stored).
export function nativeToolNamespaceOptions({projectless=false,stableOutputTools=true,selected={}}={}){
  const pick=selected&&typeof selected==="object"?selected:{};
  return {
    repository:!projectless,
    progressiveRepository:!projectless,
    output:Boolean(stableOutputTools),
    workspaceTools:true,
    terminal:true,
    process:true,
    browser:Boolean(pick.browser),
    computer:Boolean(pick.computer),
    sourceControl:!projectless&&Boolean(pick.sourceControl),
    delegation:Boolean(pick.delegation),
  };
}

// The developer message a thread starts with, after the system prompt (the app sends it for every harness it gives dynamic tools).
export function trebellDeveloperInstructions({projectless=false,dynamicTools=true,browser=false,delegation=false}={}){
  const research="Web research is available when useful. Use it when current or external information materially improves the task."+(browser?" Use trebell_browser for interactive pages.":"")+(dynamicTools?" Use trebell_repo for deterministic symbol and structural repository lookups when that is faster than manual exploration.":"")+(delegation?" Trebell delegation is available for bounded parallel child tasks; use it only when parallelism materially helps, prefer explicit ownership and budgets, and do not create agent swarms.":"");
  return projectless
    ?"This is a Trebell General chat with no attached project or repository. The working directory is an app-managed scratch workspace. Do not assume it is a codebase, repository, or user project. "+research
    :research;
}

// The working context a Native message carries (repositoryContextEntries in src/context-provenance.mjs): the seed only.
export function nativeTurnContextOptions(taskText){
  return {seedOnly:true,currentTask:String(taskText||"")};
}

// The checkpoints the continuity block lists: only those linked to a turn. The checkpoint the window makes before a message is
// linked once its turn exists, so a first message carries no block restating it as an artifact the work created.
export function continuityCheckpoints(rows=[]){
  return (Array.isArray(rows)?rows:[]).filter(row=>row&&typeof row==="object"&&String(row.turnId||"").trim());
}

// The executor's policy context.
export function nativePolicyContext({permissionProfile="supervised",workspace=null,projectAvailable=true,desktopAvailable=false,delegationAvailable=false,environmentType="local"}={}){
  return {permissionProfile,runtime:"native",workspace,projectAvailable:Boolean(projectAvailable),desktopAvailable:Boolean(desktopAvailable),delegationAvailable:Boolean(delegationAvailable),environmentType:environmentType||"local",environmentIsolated:false,provenance:"model"};
}

// Where the benchmark runner may differ from the app, and why: only what a task container cannot have at all.
export const NATIVE_CONTAINER_ONLY=/*#__PURE__*/Object.freeze([
  {what:"trebell_browser",app:"exposed when the desktop bridge has a browser and the message names browser or web-page work; the window runs its calls",runner:"off",reason:"A container has no Trebell window or browser panel. The developer text's browser sentence follows it."},
  {what:"trebell_computer",app:"desktop control, Windows desktop app only",runner:"off",reason:"No desktop in a container."},
  {what:"trebell_delegate",app:"exposed when the message names delegation or parallel work; the window runs the child threads",runner:"off",reason:"No window, and a benchmark of Native must not hand its task to another agent or another vendor's harness. The developer text's delegation sentence follows it."},
  {what:"trebell_source_control/link_pull_request",app:"sent to the window",runner:"refused",reason:"The one source-control tool the window serves; the rest of the namespace runs in both."},
  {what:"MCP servers",app:"the servers the person configured (trebell_mcp exists only when there are some)",runner:"none",reason:"A person's own servers; none in a container."},
  {what:"Permission mode",app:"the person's pick (a new thread starts Supervised)",runner:"Full access",reason:"The runner stands for a person who picked Full access: the system prompt's profile line and approvals follow the mode."},
  {what:"Reply drafts",app:"on",runner:"off",reason:"They change no request: the stream observer only reads the response (the parity test shows identical wire bytes)."},
  {what:"Model",app:"the person's pick",runner:"the model the benchmark names for every lane",reason:"A person's pick like the permission mode; the measured per-model rows apply to whichever model runs."},
  {what:"Reasoning effort and service tier picks",app:"the person's Thinking and Speed picks, else the shared defaults",runner:"TREBELL_REASONING_EFFORT and TREBELL_SERVICE_TIER, else the shared defaults",reason:"A person's picks; a readout must run the shared defaults (the pipeline refuses others)."},
  {what:"Machine data",app:"this machine's workspace, environment, SSH/WSL profiles, tool-output folder, session id, stored knowledge and journal, key store",runner:"the container's",reason:"Data, not configuration: the shared command-environment allowlist filters the environment in both."},
  {what:"The person's controls and later messages",app:"Stop, steering, the queue, goals and their budgets, recipe allowlists, between-turn compaction, restarts, approvals, tool expansion on later messages",runner:"not reached",reason:"A benchmark is one message."},
  {what:"Runner observation",app:"none",runner:"metrics, events, the tool-call log, the final diff, gate snapshots (gate switch only)",reason:"They only record; none changes a request."},
]);

// The environment knobs a benchmark run can carry. Every one is off unless set; the runner reads its environment only through
// nativeHarborRunConfiguration, writes the set ones to metrics.experimentSwitches with nativeConfigurationSnapshot's hash, and the
// launcher and the integrity audit refuse a readout lane that carries any (picks only when they differ from the shared defaults).
export const NATIVE_RUN_SWITCHES=/*#__PURE__*/Object.freeze([
  {name:"TREBELL_HARBOR_SEMANTIC_GATE",kind:"experiment",what:"semantic completion gate on (1)"},
  {name:"TREBELL_OPENAI_REASONING_CONTEXT",kind:"experiment",what:"another OpenAI reasoning context (auto, current_turn, all_turns)"},
  {name:"TREBELL_HARBOR_CONTEXT_WINDOW",kind:"experiment",what:"another operating context window"},
  {name:"TREBELL_HARBOR_COMPACT_THRESHOLD",kind:"experiment",what:"another server compaction threshold"},
  {name:"TREBELL_HARBOR_MAX_MODEL_TURNS",kind:"experiment",what:"a lower model-turn ceiling"},
  {name:"TREBELL_HARBOR_MAX_TOOL_CALLS",kind:"experiment",what:"a lower tool-call ceiling"},
  {name:"TREBELL_HARBOR_MAX_WALL_MS",kind:"experiment",what:"a wall-time ceiling"},
  {name:"TREBELL_OPENAI_RESPONSES_WEBSOCKET",kind:"experiment",what:"OpenAI over HTTPS only (0)"},
  {name:"TREBELL_HARBOR_PROBE",kind:"diagnostic",what:"request probe: no provider call"},
  {name:"TREBELL_HARBOR_LIVE_PROBE",kind:"diagnostic",what:"live probe: stop after the first responses"},
  {name:"TREBELL_HARBOR_LIVE_PROBE_TURNS",kind:"diagnostic",what:"responses a live probe allows"},
  {name:"TREBELL_REASONING_EFFORT",kind:"pick",what:"the Thinking pick"},
  {name:"TREBELL_SERVICE_TIER",kind:"pick",what:"the Speed pick (default or fast)"},
  {name:"TREBELL_MODEL",kind:"pick",what:"the model"},
  // Where the run writes what it observes; none changes a request.
  {name:"TREBELL_METRICS_PATH",kind:"observation",what:"metrics file"},
  {name:"TREBELL_EVENTS_PATH",kind:"observation",what:"events file"},
  {name:"TREBELL_TOOL_CALLS_PATH",kind:"observation",what:"tool-call log"},
  {name:"TREBELL_FINAL_DIFF_PATH",kind:"observation",what:"final diff"},
  {name:"TREBELL_TOOL_OUTPUT_DIR",kind:"observation",what:"the tool-output store's folder (machine data)"},
  {name:"TREBELL_HARBOR_GATE_SNAPSHOT_PATHS",kind:"observation",what:"gate snapshots (with the gate switch only)"},
  {name:"TREBELL_HARBOR_GATE_SNAPSHOT_DIR",kind:"observation",what:"gate snapshot folder"},
]);

const REASONING_CONTEXTS=["auto","current_turn","all_turns"],EFFORTS=["none","minimal","low","medium","high","xhigh","max"];
const setValue=(env,name)=>{const value=String(env?.[name]??"").trim();return value||null};

// The benchmark runner's whole configuration from its environment: the shared values, the picks, and every switch that is set.
export function nativeHarborRunConfiguration(env={}){
  const provider="openai",model=setValue(env,"TREBELL_MODEL")||"gpt-6-luna",measured=nativeModelSettings({provider,model});
  const effortPick=setValue(env,"TREBELL_REASONING_EFFORT")?.toLowerCase()||null;
  if(effortPick&&!EFFORTS.includes(effortPick))throw new Error("TREBELL_REASONING_EFFORT must be one of "+EFFORTS.join(", ")+".");
  const tierPick=setValue(env,"TREBELL_SERVICE_TIER")?.toLowerCase()||null;
  if(tierPick&&!["default","fast"].includes(tierPick))throw new Error("TREBELL_SERVICE_TIER must be default or fast.");
  const reasoningContext=setValue(env,"TREBELL_OPENAI_REASONING_CONTEXT")?.toLowerCase()||null;
  if(reasoningContext&&!REASONING_CONTEXTS.includes(reasoningContext))throw new Error("TREBELL_OPENAI_REASONING_CONTEXT must be auto, current_turn, or all_turns.");
  // A positive whole number, else null (unset, zero or not a number keeps the shared value, as the runner always read them).
  const positive=name=>{const raw=setValue(env,name);if(raw==null)return null;const value=Math.trunc(Number(raw));return Number.isFinite(value)&&value>0?value:null};
  const windowSwitch=positive("TREBELL_HARBOR_CONTEXT_WINDOW"),thresholdSwitch=positive("TREBELL_HARBOR_COMPACT_THRESHOLD");
  const contextWindow=windowSwitch??measured.contextWindow,compactionThreshold=thresholdSwitch??measured.serverCompactionThreshold;
  if(compactionThreshold&&contextWindow&&compactionThreshold>=contextWindow)throw new Error("TREBELL_HARBOR_COMPACT_THRESHOLD must be below TREBELL_HARBOR_CONTEXT_WINDOW.");
  const turns=positive("TREBELL_HARBOR_MAX_MODEL_TURNS"),calls=positive("TREBELL_HARBOR_MAX_TOOL_CALLS"),wall=positive("TREBELL_HARBOR_MAX_WALL_MS");
  const budgets={
    maxModelTurns:turns?Math.min(NATIVE_BUDGETS.maxModelTurns,turns):NATIVE_BUDGETS.maxModelTurns,
    maxToolCalls:calls?Math.min(NATIVE_BUDGETS.maxToolCalls,calls):NATIVE_BUDGETS.maxToolCalls,
    maxWallTimeMs:wall?Math.max(10_000,wall):NATIVE_BUDGETS.maxWallTimeMs,
  };
  const liveProbeTurns=Math.max(1,Math.min(8,positive("TREBELL_HARBOR_LIVE_PROBE_TURNS")||1));
  const experimentSwitches={};
  for(const knob of NATIVE_RUN_SWITCHES){
    const value=setValue(env,knob.name);if(value==null)continue;
    if(knob.kind==="experiment"||knob.kind==="diagnostic")experimentSwitches[knob.name]=value;
  }
  const reasoningEffort=effortPick||measured.reasoningEffort,serviceTier=tierPick||(NATIVE_SERVICE_TIER_DEFAULT??"default");
  const picks={model,reasoningEffort,serviceTier};
  const sharedDefaults={reasoningEffort:measured.reasoningEffort,serviceTier:NATIVE_SERVICE_TIER_DEFAULT??"default"};
  return {
    provider,model,reasoningEffort,serviceTier,
    semanticCompletionGate:setValue(env,"TREBELL_HARBOR_SEMANTIC_GATE")==="1"?true:NATIVE_LOOP_OPTIONS.semanticCompletionGate,
    reasoningContext,contextWindow,compactionThreshold,budgets,
    probeOnly:setValue(env,"TREBELL_HARBOR_PROBE")==="1",liveProbe:setValue(env,"TREBELL_HARBOR_LIVE_PROBE")==="1",liveProbeTurns,
    experimentSwitches,picks,
    picksDifferFromShared:reasoningEffort!==sharedDefaults.reasoningEffort||serviceTier!==sharedDefaults.serviceTier,
  };
}

// Why a benchmark readout cannot run a Native lane with this environment, or null. A readout runs the Native the app ships: no
// benchmark switch set, and the shared effort and tier (an experiment says so with the launcher's --native-experiment=<name>).
export function nativeReadoutRefusal(env={}){
  const config=nativeHarborRunConfiguration(env),switches=Object.keys(config.experimentSwitches);
  if(switches.length)return "a readout runs the shared Native configuration, but these benchmark switches are set: "+switches.join(", ")+".";
  if(config.picksDifferFromShared){
    const shared=nativeModelSettings({provider:config.provider,model:config.model}).reasoningEffort;
    return `a readout runs the shared Native configuration (effort ${shared??"the provider's default"}, tier ${NATIVE_SERVICE_TIER_DEFAULT??"default"}), not effort ${config.reasoningEffort??"the provider's default"} and tier ${config.serviceTier}.`;
  }
  return null;
}

// Every value above, as data: the runner records its sha256 in the run's metrics (configurationHash).
export function nativeConfigurationSnapshot(){
  return {
    version:NATIVE_CONFIGURATION_VERSION,
    loop:{...NATIVE_LOOP_OPTIONS},
    budgets:{...NATIVE_BUDGETS},
    reasoningContext:NATIVE_REASONING_CONTEXT,
    measuredModels:JSON.parse(JSON.stringify(NATIVE_MEASURED_MODELS)),
    serviceTierDefault:NATIVE_SERVICE_TIER_DEFAULT,
    providerTurnOptions:{openai:nativeProviderTurnOptions("openai"),anthropic:nativeProviderTurnOptions("anthropic")},
    specializedTaskPatterns:{browser:BROWSER_TASK.source,computer:COMPUTER_TASK.source,sourceControl:SOURCE_CONTROL_TASK.source,delegation:DELEGATION_TASK.source},
    toolNamespaces:nativeToolNamespaceOptions({}),
    developerInstructions:trebellDeveloperInstructions({}),
    turnContext:nativeTurnContextOptions(""),
    containerOnly:NATIVE_CONTAINER_ONLY.map(item=>item.what),
    switches:NATIVE_RUN_SWITCHES.map(item=>item.name+":"+item.kind),
  };
}

// The evidence behind each setting, measured or not (the owner's rule: measured-better first, else the app's default, marked).
export const NATIVE_SETTINGS_EVIDENCE=/*#__PURE__*/Object.freeze([
  {setting:"Semantic completion gate, its recovery and the mid-task checkpoints",value:"off",measured:true,evidence:"3906e454 (2026-10-09): 8 fresh SWE-bench Verified pairs, gate off 6/8 at $0.252 vs gate on 5/8 at $0.366 (-31%); the gate overturned a correct sympy-20801 fix. Recovery: 0 of ~35 runs that entered it reached reward 1 (memory recovery-cost-findings)."},
  {setting:"Per-message ceilings",value:"500 model turns / 5,000 tool calls / no wall cap",measured:true,evidence:"79c8b056: ceilings made non-binding so hard tasks are not scored under a smaller private budget than Codex (TB4 make-mips-interpreter lost at a 48-turn ceiling); every readout ran 500/5000."},
  {setting:"OpenAI long context for gpt-6-luna",value:"272,000-token window, server compaction at 245,000 armed at half",measured:true,evidence:"ba0c8e69 (2026-10-01); retroactive read cooling broke response continuation (cache hit 3.9%); every readout since ran this policy. Other models: the catalog window and client read cooling (unmeasured)."},
  {setting:"Background processes (trebell_process)",value:"always on",measured:true,evidence:"38c76f98 (2026-10-02); readout 6: kv-store-grpc and pypi-server resolved by Native through trebell_process where every Codex try failed."},
  {setting:"Default reasoning effort for gpt-6-luna",value:"max",measured:true,evidence:"Adaptive reasoning evaluation (2026-10-13, 32 fresh SWE-bench tasks): lower effort lost resolved tasks (17 or 18 v 20). Other models: the provider default (unmeasured)."},
  {setting:"Reasoning context",value:"current_turn",measured:true,evidence:"Memory native-tuning-guardrails: auto and all_turns were conflicting and sometimes much costlier."},
  {setting:"Source control tools (trebell_source_control)",value:"when the message names git, commit, branch, PR and similar",measured:false,evidence:"The app's product default; never benchmarked. The integrity audit reviews its fetch, pull_ff and push calls."},
  {setting:"Developer text",value:"trebellDeveloperInstructions",measured:false,evidence:"The app's product default. Native's 'web research' is its terminal's network access."},
  {setting:"Default service tier",value:"none (Standard)",measured:false,evidence:"The app's product default; Fast changes serving speed, not the model, and bills 2x. Benchmarks run every lane at the same tier."},
  {setting:"Repository knowledge",value:"the project's store (empty for a fresh project or a container)",measured:false,evidence:"The app's product default."},
  {setting:"First message's continuity block",value:"no checkpoint not yet linked to a turn",measured:false,evidence:"A defect fix toward the measured runner shape: the block restated the window's own pre-turn checkpoint as an artifact created."},
]);
