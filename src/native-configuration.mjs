// Trebell Native's one configuration. The owner, 2026-10-29: "The native we benchmark with and ship should be the same."
// The app (src/agent-relay.mjs building NativeAgentSession, src/native-agent-session.mjs, src/gui-server.mjs and ui/src) and the
// Harbor benchmark runner (benchmarks/harbor/native-harbor-run.mjs, run by trebell-native-runner.mjs) read every setting that
// changes what Native does from here: the loop's options, the per-message budgets, the completion check and its recovery, the long-
// context policy, the reasoning context, effort and tier defaults, the tool namespaces, the developer text, the first message's
// working context and the provider request's options. tests/native-one-config-parity.test.mjs builds both for the same task and
// compares what they send byte for byte, apart from NATIVE_CONTAINER_ONLY below.
//
// Each value is the one the benchmarks found best by the mission's rule (goal.md section 1: as many or more resolved tasks first, then
// lower cost) where it was compared on fresh tasks; otherwise it is what every readout ran, the app's product default or new, each
// marked unmeasured in NATIVE_SETTINGS_EVIDENCE.
//
// No imports and no work at load: the UI's first bundle reads the tool selection, the developer text and the effort default from
// here, so everything else must tree-shake away (B11, tests/bundle-budgets.test.mjs).

export const NATIVE_CONFIGURATION_VERSION="2026-10-30.2";

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

// OpenAI's reasoning context, set on every OpenAI request. It rests on the readouts, not on a fresh comparison: its fresh A/B against
// all_turns was withdrawn, as a one-message run shows the model the same reasoning under either (NATIVE_SETTINGS_EVIDENCE). Other
// providers get none, as before.
export const NATIVE_REASONING_CONTEXT="current_turn";

// What the benchmarks ran a model with: Max effort on gpt-6-luna was measured on fresh tasks, its window and server compaction rest on
// the readouts (NATIVE_SETTINGS_EVIDENCE). A model without a row keeps the app's rule: the catalog's window, client-side read cooling
// and the provider's own effort.
export const NATIVE_MEASURED_MODELS=/*#__PURE__*/Object.freeze({
  "openai:gpt-6-luna":/*#__PURE__*/Object.freeze({reasoningEffort:"max",contextWindow:272_000,serverCompactionThreshold:245_000}),
});

export function nativeMeasuredModel(provider,model){
  const key=String(provider||"").trim().toLowerCase()+":"+String(model||"").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(NATIVE_MEASURED_MODELS,key)?NATIVE_MEASURED_MODELS[key]:null;
}

// The model's settings for a session: its NATIVE_MEASURED_MODELS row's, else the catalog's window and no server compaction.
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

// The model a Native message runs when nobody picked one (no thread model, no project or app default): the provider's measured model
// when its catalog lists it, so a person who never picks runs what the benchmarks measured; else the catalog's own default.
export const NATIVE_DEFAULT_MODELS=/*#__PURE__*/Object.freeze({openai:"gpt-6-luna"});

export function nativeDefaultModel(provider,models=[],catalogDefault=null){
  const preferred=NATIVE_DEFAULT_MODELS[String(provider||"").trim().toLowerCase()]||null;
  return preferred&&Array.isArray(models)&&models.map(String).includes(preferred)?preferred:(catalogDefault||null);
}

// A between-turn compaction's brief (NativeAgentSession.compact: the window's Compact and its automatic compaction): the provider's own
// effort whatever the Thinking level, under a 4,096-token cap. OpenAI counts reasoning in that cap, so at Max a long thread's summary
// could spend it all and come back empty. What a thread with no Thinking pick sent before 2026-10-29 (unmeasured).
export const NATIVE_COMPACTION=/*#__PURE__*/Object.freeze({reasoningEffort:null,maxOutputTokens:4096});

// How long Native waits for the next byte of Meta's Responses stream before it gives the request up as stalled and the loop sends it
// again (a timed-out request's retry). Meta's stream has no keepalive and sends nothing while the model reasons or writes a tool call's
// arguments, which come whole in one delta; only a reply's text comes in small deltas. The live checks of 2026-10-30 (muse-spark-1.3-
// contributor at high, tests/fixtures/meta-responses-stream.json) saw no byte for 10.4 s of reasoning and 7.1 s of a 3,063-character
// write_file argument, and 17.9 s of reasoning before a 14,449-token answer whose text came in 1,536 deltas. So the bound must outlast
// the longest reasoning or tool call, not a gap between tokens. The Meta lane's 698 JSON turns on Terminal-Bench 2.0 took at most
// 200 s whole (circuit-fibsqrt: 14,950 reasoning tokens in one item), at 44 to 108 output tokens a second (median 85); only the two
// that hit the old 300 s whole-request timeout (regex-chess, adaptive-rejection-sampler) ran longer, and those 698 leave out exactly
// the turns that could not finish in 300 s, so they do not show how long the longest item runs. 600 s holds one silent item of about
// 40,000 tokens at the slowest tenth's rate (67 a second), 51,000 at the median; one item as long as max_output_tokens (65,536) would
// take 770 to 1,490 s at 85 to 44 a second. This bound is the stream's only one: the stream goes through a fetch with no body deadline
// (src/provider-long-request-fetch.mjs), as Node's fetch ends a body after 300 s without a byte, which held a silent item to about
// 20,000 tokens at 67 a second and 25,000 at the median whatever this bound said. A stream that breaks fails at once.
// Meta's docs: a stream has no server-side limit once its first event is sent (dev.meta.ai/docs/error-handling).
export const NATIVE_META_STREAM_IDLE_TIMEOUT_MS=600_000;

// The provider turn's transport options (src/native-provider-turn.mjs applies them, with the reasoning context). Meta's lane streams
// its Responses: a JSON reply comes only once the whole answer is written, under the provider's 300 s whole-request timeout, which a
// long answer exceeded on every attempt; a stream has its headers at once and is read with the idle bound above.
export function nativeProviderTurnOptions(provider){
  if(provider==="meta")return {promptCaching:false,streamResponses:true,streamIdleTimeoutMs:NATIVE_META_STREAM_IDLE_TIMEOUT_MS};
  return {promptCaching:provider==="anthropic",streamResponses:provider==="openai"};
}

// Specialized tool namespaces a message's text selects, where they are available. Background processes (trebell_process) are no
// longer selected: Native always has them.
const BROWSER_TASK=/\b(browser|website|web\s?page|webpage|playwright|dom|frontend|front-end|css|html|responsive|screenshot|browser console|network (?:request|error)|page load|url)\b/i;
const COMPUTER_TASK=/\b(computer use|desktop control|mouse|keyboard|screen coordinates?|primary display|desktop screenshot|windows desktop)\b/i;
// Source-control work the message asks for: a git command, source control or version control in Git's sense (under version control, a
// version control system, setting it up for a project), a pull or merge request to open, a commit, branch, push, rebase or merge said as Git work, and the everyday
// asks (commit, push it, fix it and commit, commit and push, commit this, new branch, PR this, amend, undo or revert the last commit, what
// changed in it, which branch am I on), also after a comma or "you", "now", "ok" or "just" ("Looks good, commit it", "Can you commit
// this?") or ending a line ("Fix the failing test and commit\nThanks!") or before a comma and thanks or an if, when or once clause ("commit, thanks",
// "commit if the tests pass"), and commit these or now, push now, push to a fork or remote,
// link this to the PR. A link (an issue on GitHub) is read without its address, and these other senses of the words select nothing: a
// commit an issue cites, a database transaction's commit, branch prediction, an nginx upstream, push notifications, a data store's
// version control (Terminal-Bench Pro's build-grpc-user-profile-service). An ask's shape said of something else still selects (a stack's
// "pop and push" ending a line or the message, "then commit." of a database write); no benchmark task has one. A new rule, narrowed on 2026-10-29 from the product's word rule, which gave a
// benchmark task the namespace whenever its issue text linked GitHub (review of native-one-config); with the second and third reviews'
// everyday asks it selects 23 of 300 SWE-bench Multilingual, 1 of 89 Terminal-Bench 2.0 and 3 of 200 Terminal-Bench Pro tasks (Git
// tasks). "commit that" and "force push" stay out: they would add two Terminal-Bench Pro Git-history tasks. Linear in the message's
// length: a sentence starts after punctuation or a line break and spaces or tabs. A line break ends an ask that starts the message or
// follows . ! ? , or a word such as and, then or please, not one after a line break, colon, semicolon or & (a list of opcodes, one a
// line, selects nothing).
const SOURCE_CONTROL_TASK=/\bgit\s+(?:add|am|apply|bisect|blame|branch|checkout|cherry-pick|commit|diff|fetch|init|log|merge|pull|push|rebase|remote|reset|restore|revert|show|stash|status|switch|tag)\b|\bsource control\b|\b(?:under|in|into|to|from) version control\b|\bversion control (?:system|repo|history)|\b(?:set up|setup|initiali[sz]e|enable)\s+version control\b|\bversion control (?:to|for|on|in) (?:this|the|my|our) (?:project|repo|repository|folder|directory|codebase)\b|\bcherry-pick|\b(?:open|create|make|submit|raise|draft|file|send|prepare|update|push|for)\s+(?:(?:a|an|the|this|that|my|your|our|new)\s+)*(?:pr|pull request|merge request)s?\b|\b(?:commit|stage)\s+(?:(?:a|an|the|this|that|these|those|all|my|your|our)\s+)*(?:changes?|fix(?:es)?|work|edits?|files?|patch|updates?)\b|\b(?:make|create|add|amend)\s+(?:(?:a|an|the|new)\s+)*commits?\b|\b(?:create|make|open|start|switch to|check ?out|cut|delete|rename|publish)\s+(?:(?:a|an|the|this|that|my|your|new)\s+)?(?:[\w./-]+\s+)?branch(?:es)?\b|\b(?:on|to|from|off)\s+(?:(?:a|an|the)\s+)?(?:new|separate|feature|topic|release|remote|local)\s+branch\b|\bpush\s+(?:(?:a|an|the|this|that|these|those|all|my|your|our)\s+)*(?:changes?|commits?|branch(?:es)?|tags?|fix(?:es)?|work)\b|\bpush(?:ed)?\s+(?:it\s+|them\s+)?(?:to\s+)?(?:origin|upstream|the remote|github|gitlab|main|master)\b|\bpush\s+(?:it\s+)?to\s+(?:(?:my|the|your|our)\s+)?(?:fork|remote)\b|\brebase\s+(?:onto|on top of|against|on main|on master|the branch|this branch|my branch)\b|\b(?:commit|stage|add)\s+(?:and|&)\s+(?:then\s+)?(?:commit|push)\b|(?:^|[.!?;:,\n&][ \t]*|\b(?:and|then|please|now|just|also|so|you|ok)\s+)(?:new branch\b|commit\s+(?:it|this|these|them|everything|all)\b(?!\s+(?:transactions?|tx|writes?|records?|offsets?|sessions?|batch(?:es)?)\b)|(?:commit|push|rebase)(?:\s+(?:it|this|these|them|everything|all))?(?:\s+now)?(?:,?\s+please)?(?:\s*(?:[.!?]|$)|,\s*(?:thanks|thank you|thx|cheers)\b|\s+(?:if|when|once)\s))|(?:^|[.!?,][ \t]*|\b(?:and|then|please|now|just|also|so|you|ok)\s+)(?:commit|push|rebase)(?:\s+(?:it|this|these|them|everything|all))?(?:\s+now)?(?:,?\s+please)?[ \t]*\r?\n|\b(?:undo|amend|squash|reword|revert)\s+(?:(?:the|my|your|our|that|this|last|latest|previous|recent|two|three|\d+)\s+)*commits?\b|\bmerge\s+(?:origin\/|upstream\/)?(?:main|master|develop|trunk)\s+into\b|\bmerge\s+(?:the|this|that|my|your|a)\s+(?:(?:feature|topic|release|remote|local|current|other)\s+)?branch\b|\b(?:what|which)\s+branch\s+(?:am\s+i|are\s+we|is\s+(?:this|checked\s+out))\b|\bcurrent\s+git\s+branch\b|\bpr\s+(?:it|this|that)\b|\blink\s+(?:it|this)\s+to\s+(?:the|a|my|this)\s+(?:pr|pull request)\b|\b(?:in|since|show(?: me)?)\s+(?:the|my)\s+(?:last|latest|previous)\s+commits?\b|\bsync with (?:upstream|origin)\b|\bcommit (?:it )?with (?:a |the )?message\b/i;
const DELEGATION_TASK=/\b(delegate|delegation|parallel(?:ize|ized|ism)?|multi[- ]agent|fan[- ]out|independent subtasks?|in parallel)\b/i;

export function nativeSpecializedSelection(taskText,{browser=false,computer=false,sourceControl=false,delegation=false}={}){
  const task=String(taskText||"").toLowerCase();
  return {
    browser:Boolean(browser&&BROWSER_TASK.test(task)),
    computer:Boolean(computer&&COMPUTER_TASK.test(task)),
    sourceControl:Boolean(sourceControl&&SOURCE_CONTROL_TASK.test(task.replace(/\S+/g,word=>word.includes("://")?" ":word))),
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
// Native's, the app's and the runner's alike, has no web-research sentence (dropped 2026-10-29, NATIVE_SETTINGS_EVIDENCE); the window
// passes webResearch for other harnesses' threads, which keep it as before.
export function trebellDeveloperInstructions({projectless=false,dynamicTools=true,browser=false,delegation=false,webResearch=false}={}){
  return [
    projectless&&"This is a Trebell General chat with no attached project or repository. The working directory is an app-managed scratch workspace. Do not assume it is a codebase, repository, or user project.",
    webResearch&&"Web research is available when useful. Use it when current or external information materially improves the task.",
    browser&&"Use trebell_browser for interactive pages.",
    dynamicTools&&"Use trebell_repo for deterministic symbol and structural repository lookups when that is faster than manual exploration.",
    delegation&&"Trebell delegation is available for bounded parallel child tasks; use it only when parallelism materially helps, prefer explicit ownership and budgets, and do not create agent swarms.",
  ].filter(Boolean).join(" ");
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
  {what:"Model pick",app:"the person's pick, else the shared default model (nativeDefaultModel: gpt-6-luna on OpenAI when the catalog lists it)",runner:"TREBELL_MODEL, else the shared default (gpt-6-luna)",reason:"A person's pick like the permission mode; with no pick both run the shared default. Only gpt-6-luna has measured rows (NATIVE_MEASURED_MODELS): another pick runs the app's unmeasured defaults (the catalog window, client read cooling, the provider's effort)."},
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
  const provider="openai",model=setValue(env,"TREBELL_MODEL")||NATIVE_DEFAULT_MODELS[provider],measured=nativeModelSettings({provider,model});
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
    defaultModels:{...NATIVE_DEFAULT_MODELS},
    compaction:{...NATIVE_COMPACTION},
    serviceTierDefault:NATIVE_SERVICE_TIER_DEFAULT,
    providerTurnOptions:{openai:nativeProviderTurnOptions("openai"),anthropic:nativeProviderTurnOptions("anthropic"),meta:nativeProviderTurnOptions("meta")},
    specializedTaskPatterns:{browser:BROWSER_TASK.source,computer:COMPUTER_TASK.source,sourceControl:SOURCE_CONTROL_TASK.source,delegation:DELEGATION_TASK.source},
    toolNamespaces:nativeToolNamespaceOptions({}),
    developerInstructions:trebellDeveloperInstructions({}),
    turnContext:nativeTurnContextOptions(""),
    containerOnly:NATIVE_CONTAINER_ONLY.map(item=>item.what),
    switches:NATIVE_RUN_SWITCHES.map(item=>item.name+":"+item.kind),
  };
}

// The evidence behind each setting (the owner's rule: measured better on fresh tasks first, else the app's default, marked). basis says
// which: "fresh tasks" (compared on fresh benchmark tasks: measured), "readouts" (what every readout ran, supported by their results but
// never compared with the app's old value: kept on that and the owner's word, not measured better), "app default" (unmeasured) or "new"
// (neither benchmarked nor the app's product default before this configuration: unmeasured).
export const NATIVE_SETTINGS_EVIDENCE=/*#__PURE__*/Object.freeze([
  {setting:"Semantic completion gate, its recovery and the mid-task checkpoints",value:"off",measured:true,basis:"fresh tasks",evidence:"3906e454 (2026-10-09): 8 fresh SWE-bench Verified pairs, gate off 6/8 at $0.252 vs gate on 5/8 at $0.366 (-31%); the gate overturned a correct sympy-20801 fix. Recovery: 0 of ~35 runs that entered it reached reward 1 (memory recovery-cost-findings)."},
  {setting:"Per-message ceilings",value:"500 model turns / 5,000 tool calls / no wall cap",measured:false,basis:"readouts",evidence:"Every readout ran 500/5000 and the owner chose them for the app on 2026-10-29 (no other harness in the app caps a message); never compared with the app's 24/100 on fresh tasks. 79c8b056 made them non-binding after a consumed TB4 task (make-mips-interpreter) was lost at a 48-turn ceiling, a causal loss but not a fresh A/B. The turn-36 budget checkpoint they bring into the app is unvalidated."},
  {setting:"OpenAI long context for gpt-6-luna",value:"272,000-token window, server compaction at 245,000 armed at half",measured:false,basis:"readouts",evidence:"ba0c8e69 (2026-10-01), a runner change with no A/B: every readout since 2026-10-01 ran this policy, but it was never compared on fresh tasks with the client read cooling the app ran (postfix-r1's: from 160K input when the window is unknown, about 70% of a known one). Only its arming at half (C4) had a fresh A/B, inside cost v1's bundled one (2026-10-09, 12 SWE-bench Verified tasks, 6/12 v 6/12 at -25.9%), and that compared two arming points of server compaction, not server compaction with cooling. The 3.9% cache hit (cooling that rewrote history broke response continuation) came from cache-pressure r1, an intermediate cooling configuration since replaced. Other models: the catalog window and client read cooling (unmeasured)."},
  {setting:"Background processes (trebell_process)",value:"always on",measured:false,basis:"readouts",evidence:"38c76f98 (2026-10-02): every readout since had it; readout 6: kv-store-grpc and pypi-server resolved by Native through trebell_process where every Codex try failed. Never compared with the app's text-selected exposure. Seen on OpenAI gpt-6-luna only, a prompt-caching provider; on providers without prompt caching (local models, some OpenRouter or xAI rows) it is unmeasured, and its ~1.6 KB of tool JSON goes uncached in every request."},
  {setting:"Default reasoning effort for gpt-6-luna",value:"max",measured:true,basis:"fresh tasks",evidence:"Adaptive reasoning evaluation (2026-10-13, 32 fresh SWE-bench tasks): lower effort lost resolved tasks (17 or 18 v 20). Other models: the provider default (unmeasured)."},
  {setting:"Reasoning context",value:"current_turn",measured:false,basis:"readouts",evidence:"521937a2 (2026-10-02) set it after one trace (freight-dispatch-shift, where an aged-out continuation cut billed input). The later probes of 2-3 requests disagreed with each other (one found all_turns costlier, another 29% cheaper with half the reasoning), and a 3 v 3 control on the already inspected cargo-flight-dispatch was mixed (all_turns 66/81 checks, current_turn 63/81). The fresh A/B registered against all_turns (ranks 274-289) was withdrawn on 2026-10-12 before any run: a run with one user message shows the model the same reasoning under either setting, so the benchmarks cannot tell the two apart. Every readout since ran current_turn. The app's multi-message threads, where it drops a turn's reasoning at each new message, were never measured."},
  {setting:"Default model",value:"gpt-6-luna on OpenAI when the catalog lists it, else the catalog's default",measured:false,basis:"readouts",evidence:"Every readout ran gpt-6-luna, the one model with measured rows; never compared with another model. The default since 2026-10-29 so a person who picks no model runs the measured configuration, where the catalog's newest flagship (gpt-6.1-sol) ran none of it."},
  {setting:"Source control tools (trebell_source_control)",value:"when the message asks for Git work: a git command, source control or version control in Git's sense, a pull or merge request to open, a commit, branch, push, rebase or merge said as such, or an everyday ask (commit, push it, fix it and commit, commit and push, new branch, PR this, revert or amend the last commit, what changed in the last commit, which branch am I on, looks good, commit it, can you commit this?, push to my fork, link this to the PR), also at a line's end or before a comma and thanks or an if, when or once clause (commit, thanks; commit if the tests pass), and setting up version control",measured:false,basis:"new",evidence:"A new rule, narrowed from the product's word rule on 2026-10-29 and unmeasured: the word rule (git, branch, commit, push, PR and the like anywhere) selected all 300 SWE-bench Multilingual task texts (a GitHub link, a cited commit); links and the words' other senses (a cited commit, a transaction's commit, branch prediction, push notifications, a data store's version control) now select nothing, though an ask's shape said of a stack or a database (pop and push ending a line, then commit.) still selects, in no benchmark task. It selects 23 of 300 SWE-bench Multilingual tasks (issue texts that offer or ask for a PR or quote a git command), 1 of 89 Terminal-Bench 2.0 (configure-git-webserver) and 3 of 200 Terminal-Bench Pro tasks, all Git tasks (merge-git-bundles-and-implement-transform, recover-and-sanitize-git-db-credential, recover-git-reflog-commits). Version control counts only in Git's sense since the third review (2026-10-30): build-grpc-user-profile-service, a gRPC service whose in-memory store keeps record versions, no longer selects. The everyday asks the second, third and fourth reviews found it dropped were added back and select none of them; commit that and force push stay out, as they would add the Git-history tasks recover-git-history-secrets and recover-prod-db-password-from-git-history. The window also picks every harness's first-message tools with it, so whether a Codex thread gets trebell_source_control is decided from its first message only (Codex takes its tools once, at thread/start, and has no tool expansion). The integrity audit reviews Native's fetch, pull_ff and push calls."},
  {setting:"Automatic between-turn compaction",value:"before a message once the last request's input reaches the person's threshold (on at 85% by default) of a known window",measured:false,basis:"app default",evidence:"The app's product default (Settings, src/trebell-state.mjs); never benchmarked, as a benchmark is one message. It reads the last request's input (NativeAgentSession's context reading), not the turn's summed input."},
  {setting:"Between-turn compaction brief",value:"the provider's own effort, 4,096-token cap (NATIVE_COMPACTION)",measured:false,basis:"app default",evidence:"What a thread with no Thinking pick sent before 2026-10-29; never benchmarked. A Max level could spend the cap on reasoning and return no brief."},
  {setting:"Developer text",value:"trebellDeveloperInstructions: the repository-lookup sentence and those of the namespaces the message selected",measured:false,basis:"app default",evidence:"The app's product default, never benchmarked: the runner sent no developer text before 2026-10-29. Without its web-research sentence (the next row)."},
  {setting:"Web research sentence in the developer text",value:"dropped for Native, in the app and the runner alike; other harnesses' threads keep it",measured:false,basis:"new",evidence:"The lead's decision on the second review of native-one-config (2026-10-29): 'Web research is available when useful. Use it when current or external information materially improves the task.' was an unmeasured app default and no benchmark ran with it (the runner sent no developer text before 2026-10-29); Native has no web search tool, only its terminal's network access; and it invites looking up the upstream fix, which voided a benchmark lane before (arm J1, 2026-10-21: a caddy-6370 lane curled the upstream pull request's diff)."},
  {setting:"Default service tier",value:"none (Standard)",measured:false,basis:"app default",evidence:"The app's product default; Fast changes serving speed, not the model, and bills 2x. Benchmarks run every lane at the same tier."},
  {setting:"Repository knowledge",value:"the project's store (empty for a fresh project or a container)",measured:false,basis:"app default",evidence:"The app's product default."},
  {setting:"First message's continuity block",value:"no checkpoint not yet linked to a turn",measured:false,basis:"app default",evidence:"A defect fix toward the measured runner shape: the block restated the window's own pre-turn checkpoint as an artifact created."},
  {setting:"Meta Responses streaming",value:"stream: true, read with a 600 s idle bound (no byte) through a fetch without Node fetch's 300 s body timeout, a stalled or broken stream sent again as a timed-out request is",measured:false,basis:"new",evidence:"A defect fix found by the Muse Code comparison (2026-10-30, Terminal-Bench 2.0, muse-spark-1.3-contributor at high): Native's JSON request has a 300 s whole-request timeout and Meta's JSON reply comes only once the whole answer is written, so regex-chess timed out on all three attempts (302.8 s, 603.1 s and the third) and adaptive-rejection-sampler lost 300 s of a turn; Muse Code streams. Only the stream flag changes in the request; usage comes from the stream's final event (response.completed), the same object the JSON reply is. Meta sends no byte while one output item is written, and Node's fetch ends a body after 300 s without one, so the stream goes through Node's http client (src/provider-long-request-fetch.mjs) and the idle bound is its only limit; the bound's reasons are at NATIVE_META_STREAM_IDLE_TIMEOUT_MS. The 600 s rests on turns that finished under the old 300 s limit, which leave out the longest. Not compared on fresh tasks."},
]);
