import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { WebSocketServer } from "ws";
import { AcpAgentSession } from "./acp-agent-session.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { withProbeAdvice } from "./agent-runtime-manager.mjs";
import { fileUri } from "./file-uri.mjs";
import { isHarnessSessionLost } from "./harness-session-lost.mjs";
import { isSessionRefusal } from "./session-refusal.mjs";
import { threadHistoryHandoff } from "./thread-history-handoff.mjs";
import { runtimeHarnessLabel } from "./runtime-instructions.mjs";
import { OpenCodeAgentSession, remapOpenCodeTurns } from "./opencode-agent-session.mjs";
import { OpenCode2AgentSession } from "./opencode2-agent-session.mjs";
import { ClaudeAgentSession } from "./claude-agent-session.mjs";
import { NativeAgentSession, nativeCompactionMessage, nativeMessagesFromThread } from "./native-agent-session.mjs";
import { createNativeBuiltins, safeWorkspacePath } from "./native-builtins.mjs";
import { nativeProjectReadNeedsNoApproval } from "./native-read-approval.mjs";
import { NativeBackgroundProcessManager, highestProcessHandle } from "./native-background-processes.mjs";
import { createNativeSourceControl } from "./native-source-control.mjs";
import { NativeMcpBroker } from "./native-mcp-broker.mjs";
import { createNativeToolExecutor } from "./native-tool-executor.mjs";
import { nativeSystemPrompt } from "./native-system-prompt.mjs";
import { attachNativePromptProvenance } from "./native-request-metrics.mjs";
import { configuredReasoningEffort } from "./model-reasoning-effort.mjs";
import { configuredModelServiceTier } from "./model-service-tier.mjs";
import { discoverRepositoryCapabilities, exposedToolNamed, platformDynamicToolNamespaces } from "./platform-tool-catalog.mjs";
import { acpMcpServersForSession, claudeMcpServersForSession, nativeMcpServersForSession } from "./mcp-registry.mjs";
import { createRemoteContextIo } from "./context-engine.mjs";
import { withWorkingContext } from "./working-context-envelope.mjs";
import { createClaudeRepositoryMcp } from "./claude-repository-tools.mjs";
import { mergeAcpMcpServers, repositoryMcpProcessConfig } from "./repository-mcp-process.mjs";
import { enrichGoal, goalAdditionalContext, goalBudgetGate, normalizeGoal } from "./goal-state.mjs";
import { continuityAdditionalContext, continuityContextValue, continuitySnapshot, normalizeContinuityNotes } from "./continuity-state.mjs";
import { verificationRepairAttempt, verificationRepairChainState, verificationRepairContext, verificationRepairPrompt, verificationRepairState } from "./verification-repair.mjs";
import { verificationContinuationAttempt, verificationContinuationChainState, verificationContinuationContext, verificationContinuationPrompt, verificationContinuationState } from "./verification-continuation.mjs";
import { verificationAutomationAttempt, verificationAutomationChainState } from "./verification-automation.mjs";
import { normalizeBrowserVerificationReceipt } from "./browser-verification-evidence.mjs";
import { delegationContextValue, delegationGoalPatch, delegationPolicies } from "./delegation-state.mjs";
import { executeDelegation } from "./delegation-executor.mjs";
import { normalizePermissionMode } from "./permission-policy.mjs";
import { evaluatePolicy, POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT } from "./policy-engine.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { providerFeatureEnabled } from "./provider-capabilities.mjs";
import { normalizeProviderId } from "./provider-manager.mjs";
import { isRetiredModelProvider, isRetiredProviderModel, migrateLegacyNativeThread } from "./legacy-provider-migration.mjs";
import { NativeToolOutputStore } from "./native-tool-output-store.mjs";
import { threadTitleFromText } from "./agent-thread-store.mjs";
import { compareSectionOrder, sectionMovePlacement, sectionRanks, threadSectionId, withSectionPlace } from "./thread-section-order.mjs";
import { trebellHome } from "./paths.mjs";
import { dirname, join } from "node:path";

const IMAGE_MIME={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".bmp":"image/bmp"};
const LIVE_TOOL_OUTPUT_LIMIT=256*1024;
const TOOL_WRITE_MS=500;
const EXPANDABLE_NATIVE_TOOL_NAMESPACES=new Set(["trebell_process","trebell_browser","trebell_computer","trebell_source_control","trebell_delegate"]);
const RETIRED_NATIVE_TOOL_NAMESPACES=new Set(["trebell_device"]);
// ACP harnesses and OpenCode run processes per thread; reopening one of their threads does not start them (see thread/resume).
const LAZY_SESSION_RUNTIMES=new Set(["cursor","grok","antigravity","opencode"]);
// The tool kinds whose work ends with the call. A harness that ran any other (a command, a subagent, an MCP tool, a call of no kind)
// may have left it running past its turn: a dev server or a watcher, or a Grok background task that answers in a wake turn of its own.
const SETTLED_TOOL_KINDS=new Set(["read","edit","delete","move","search","fetch","switch_mode"]);
function expandableNativeToolNamespaces(values=[]){
  const requested=[...new Set((Array.isArray(values)?values:[]).map(value=>String(value||"").trim()).filter(Boolean))];
  const active=requested.filter(name=>!RETIRED_NATIVE_TOOL_NAMESPACES.has(name));
  const unsupported=active.find(name=>!EXPANDABLE_NATIVE_TOOL_NAMESPACES.has(name));if(unsupported)throw new Error("Unsupported dynamic tool namespace: "+unsupported);
  return active;
}
function agentProviderIdentity(thread){return thread?.runtime==="native"?(thread?.providerMeta?.modelProvider||null):(thread?.providerMeta?.runtimeInstanceId||thread?.runtimeInstanceId||null)}

function textOfInput(input=[]){return input.filter(item=>item?.type==="text").map(item=>item.text||"").join("\n")}
// The files a message went with (an image, audio, a file), which its stored message keeps after its text as Codex keeps a message's
// input: a thread opened again names them under the message, as its bubble did when it was sent. Only text reaches the model from
// a stored message (native-agent-session itemText), so what the model reads of a thread is as before.
const FILE_INPUTS=new Set(["localImage","localAudio","mention"]);
function fileInputs(input=[]){return (Array.isArray(input)?input:[]).filter(item=>FILE_INPUTS.has(item?.type)&&item.path).map(item=>({type:item.type,...(item.name?{name:String(item.name)}:{}),path:String(item.path)}))}
// A new thread is listed by its first message until it is renamed, as T3 Code seeds a thread's title (deriveThreadTitleSeed: the
// message's text, else its first image) and as Codex lists its own threads.
export function agentThreadTitleSeed(input=[],text=textOfInput(Array.isArray(input)?input:[])){
  const message=threadTitleFromText(text);if(message)return message;
  const image=(Array.isArray(input)?input:[]).find(item=>item?.type==="localImage"||item?.type==="image");
  const name=String((image?.path?basename(String(image.path)):image?.name)||"").trim().replace(/\s+/g," ");
  return name?threadTitleFromText("Image: "+name):null;
}
// Text a harness writes after a tool call starts a new paragraph, as T3 Code starts a new assistant message there; without the
// break a turn's text ran together (the live tour's Cursor reply "…report the output.```" met the command output's code fence).
export function agentTextAfterToolCall(session,text){
  if(!text||!session)return text;
  const before=String(session.__assistant||""),resumes=Boolean(session.__assistantBreak)&&Boolean(before.trim())&&!/\n\s*$/.test(before)&&!/^\s*\n/.test(text);
  session.__assistantBreak=false;
  return resumes?"\n\n"+text:text;
}
export function agentPermissionModeFromStart(params={}){
  if(params.permissionProfile)return normalizePermissionMode(params.permissionProfile);
  const sandboxType=String(params.sandboxPolicy?.type||params.sandbox||"").toLowerCase();
  if(sandboxType==="readonly"||sandboxType==="read-only")return "read-only";
  if(sandboxType==="dangerfullaccess"||sandboxType==="danger-full-access"){
    if(params.approvalPolicy==="never")return "full";
    if(params.approvalPolicy==="untrusted")return "auto";
    return "supervised";
  }
  if(sandboxType==="workspacewrite"||sandboxType==="workspace-write"){
    if(params.approvalPolicy==="untrusted"||params.approvalPolicy==="never")return "auto";
    return "supervised";
  }
  if(params.approvalPolicy==="never"||params.approvalPolicy==="untrusted")return "auto";
  return "supervised";
}
export function agentPermissionProfilePatch(params={}){
  const hasPolicy=Object.prototype.hasOwnProperty.call(params,"permissionProfile")
    ||Object.prototype.hasOwnProperty.call(params,"approvalPolicy")
    ||Object.prototype.hasOwnProperty.call(params,"sandbox")
    ||Object.prototype.hasOwnProperty.call(params,"sandboxPolicy");
  return hasPolicy?{permissionProfile:agentPermissionModeFromStart(params)}:{};
}
// The approval card's text: the harness's own prompt for the request (Claude's, as T3 Code's ClaudeAdapter), else its tool title.
export function agentApprovalReason(params={}){
  return String(params?.prompt||"").trim()||String(params?.toolCall?.title||"").trim()||"Agent requests permission";
}
function stableJson(value){
  if(Array.isArray(value))return "["+value.map(stableJson).join(",")+"]";
  if(value&&typeof value==="object")return "{"+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+":"+stableJson(value[key])).join(",")+"}";
  return JSON.stringify(value??null);
}
function nativeToolArguments(call={},authorization={}){
  const source=authorization?.arguments&&typeof authorization.arguments==="object"?authorization.arguments:call?.arguments;
  if(source&&typeof source==="object"&&!Array.isArray(source))return source;
  if(typeof source==="string"){try{const parsed=JSON.parse(source);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed}catch{}}
  return {};
}
const NATIVE_GRANT_BOUNDS=new Set(["timeout_ms","max_output_bytes"]);
// "Allow session" approves a Trebell Native action and the same action again for the rest of its session, as Codex's
// approved_for_session remembers the exact command: the tool and its arguments, without the output and time bounds.
export function nativeApprovalGrantKey(call={},authorization={}){
  const args=Object.fromEntries(Object.entries(nativeToolArguments(call,authorization)).filter(([key])=>!NATIVE_GRANT_BOUNDS.has(key)));
  return `${call?.namespace||""}/${call?.name||""} ${stableJson(args)}`;
}
// The approval card names what a Trebell Native tool would do (its command or path, else its input), then why the profile asks.
export function nativeApprovalReason(call={},authorization={}){
  const args=nativeToolArguments(call,authorization),tool=`${call?.namespace||"trebell"}/${call?.name||"tool"}`;
  const quote=part=>/[\s"]/.test(part)||!part?JSON.stringify(part):part;
  const command=typeof args.command==="string"&&args.command.trim()?[args.command.trim(),...(Array.isArray(args.args)?args.args.map(String):[])].map(quote).join(" "):null;
  const path=["path","file_path","filePath"].map(key=>args[key]).find(value=>typeof value==="string"&&value.trim());
  let target=command||(path?path.trim():null);
  if(!target){let serialized="";try{serialized=JSON.stringify(args)??""}catch{}if(serialized&&serialized!=="{}")target=serialized}
  const what=target?`${tool}: ${target.length>400?target.slice(0,397)+"...":target}`:tool,why=String(authorization?.reason||"").trim();
  return why?`${what} (${why})`:what;
}
// A turn the person sends continues a thread only on the harness that owns it. A client that still shows another harness's thread
// after a switch sends this harness's model with it, which the owning harness cannot run and must not save as the thread's model
// (T3 Code locks a started thread to its provider, and its server stays authoritative).
export function agentTurnOwnerError(thread,activeRuntime){
  const owner=String(thread?.runtime||""),active=String(activeRuntime||"");
  if(!owner||!active||owner===active)return null;
  const label=runtimeHarnessLabel(owner);
  return Object.assign(new Error(`This chat belongs to ${label}, not ${runtimeHarnessLabel(active)}. Open it from the sidebar to continue it in ${label}.`),{code:-32602});
}
export function agentPermissionPolicyDecision(thread,request={},settings={}){
  const params=request?.params||{},toolCall=params.toolCall||{},policy=params.policy||toolCall.policy||{};
  return evaluatePolicy({
    profile:thread?.providerMeta?.permissionProfile||"supervised",
    runtime:thread?.runtime||null,workspace:thread?.cwd||null,
    action:toolCall.title||params.title||request?.method||"Agent tool",
    kind:toolCall.kind||params.kind||params.permissionType||"other",
    rawInput:toolCall.rawInput||params.rawInput||{},
    requestedPath:policy.requestedPath||params.path||null,networkTarget:policy.networkTarget||params.url||null,
    externalSideEffect:policy.externalSideEffect??policy.externalSideEffects,
    riskLevel:policy.riskLevel||policy.risk,reversibility:policy.reversibility,idempotent:policy.idempotent,
    provenance:policy.provenance||params.provenance||"unknown",
    requestedPermissionEscalation:Boolean(policy.requestedPermissionEscalation),
    environmentType:thread?.providerMeta?.environmentType||null,environmentIsolated:Boolean(thread?.providerMeta?.environmentIsolated),
    rules:Array.isArray(settings?.policyRules)?settings.policyRules:[],
  });
}

async function acpPrompt(input=[]){
  const out=[];
  for(const item of input){
    if(item?.type==="text")out.push({type:"text",text:String(item.text||"")});
    else if(item?.type==="localImage"){
      const mime=IMAGE_MIME[extname(String(item.path||"")).toLowerCase()]||"image/png";
      const data=await readFile(item.path);
      out.push({type:"image",mimeType:mime,data:data.toString("base64")});
    }else if(item?.type==="mention"){
      out.push({type:"resource_link",uri:fileUri(item.path),name:String(item.name||item.path||"file")});
    }else if(item?.type==="localAudio"){
      // Audio is named by its saved path, as T3 Code names every attachment it does not send as content, and the harness opens it
      // with its own tools.
      const path=String(item.path||"");
      out.push({type:"text",text:`[Attached audio "${basename(path)}" is saved at: ${path}]`});
    }
  }
  return out;
}

// Every harness gets its working context fenced the same way (working-context-envelope.mjs), Trebell Native on every provider.
export async function contextualAgentPrompt(input=[],additionalContext={}){
  const prompt=await acpPrompt(input);
  for(const item of prompt)attachNativePromptProvenance(item,{kind:"user_input"});
  return withWorkingContext(prompt,Object.entries(additionalContext||{}));
}

function acpToolItem(update){
  const id=String(update.toolCallId||randomUUID());
  const status=update.status==="completed"?"completed":update.status==="failed"?"failed":"inProgress";
  if(update.namespace)return {type:"dynamicToolCall",id,namespace:String(update.namespace),tool:String(update.tool||update.title||update.kind||"tool"),arguments:update.rawInput??{},status,contentItems:update.content||null,success:update.status==="completed"?true:update.status==="failed"?false:null,durationMs:null,locations:update.locations||[],rawOutput:update.rawOutput};
  // ACP sessions merge each tool update into the tool's last state and normalize its output (acp-tool-state.mjs): aggregatedOutput and
  // exitCode for commands, changes with paths and text for diffs.
  if(update.kind==="execute")return {type:"commandExecution",id,command:update.title||"Command",cwd:"",processId:null,source:"agent",status,commandActions:[],aggregatedOutput:typeof update.rawOutput==="string"?update.rawOutput:typeof update.aggregatedOutput==="string"?update.aggregatedOutput:null,exitCode:Number.isInteger(update.exitCode)?update.exitCode:null,durationMs:null,rawInput:update.rawInput,locations:update.locations||[]};
  if(update.kind==="edit"||update.kind==="delete"||update.kind==="move")return {type:"fileChange",id,status,changes:Array.isArray(update.changes)&&update.changes.length?update.changes:(update.locations||[]).map(location=>({path:location.path||location.uri||"",kind:update.kind})),rawInput:update.rawInput,rawOutput:update.rawOutput};
  return {type:"dynamicToolCall",id,namespace:"agent",tool:update.title||update.kind||"tool",arguments:update.rawInput??{},status,contentItems:update.content||null,success:update.status==="completed"?true:update.status==="failed"?false:null,durationMs:null,locations:update.locations||[],rawOutput:update.rawOutput};
}

export function agentToolLifecycle(update,previousOutput=""){
  const item=acpToolItem(update);
  const terminal=item.status==="completed"||item.status==="failed";
  let output="",outputDelta="";
  if(item.type==="commandExecution"&&typeof item.aggregatedOutput==="string"){
    output=item.aggregatedOutput.slice(0,LIVE_TOOL_OUTPUT_LIMIT);
    const previous=String(previousOutput||"").slice(0,LIVE_TOOL_OUTPUT_LIMIT);
    if(output.startsWith(previous))outputDelta=output.slice(previous.length);
    else if(!previous)outputDelta=output;
  }
  return {item,terminal,output,outputDelta};
}

function planSteps(update){return (update.entries||update.plan||[]).map(entry=>({step:entry.content||entry.step||entry.text||"Plan step",status:entry.status==="in_progress"?"inProgress":entry.status||"pending",priority:entry.priority||null}))}
export function acpPlanEvent(update={}){
  const type=String(update.sessionUpdate||"");
  if(type==="plan_removed")return {planId:update.planId||null,plan:[]};
  if(type==="plan")return {planId:update.planId||null,plan:planSteps(update)};
  if(type==="plan_update"){
    const content=update.plan||{};
    if(content.type==="items")return {planId:content.planId||null,plan:planSteps(content)};
    if(content.type==="markdown")return {planId:content.planId||null,plan:[{step:String(content.content||"Plan updated"),status:"pending",format:"markdown"}]};
    if(content.type==="file")return {planId:content.planId||null,plan:[{step:"Plan file · "+String(content.uri||"unknown"),status:"pending",format:"file",uri:content.uri||null}]};
    return {planId:content.planId||update.planId||null,plan:planSteps(content)};
  }
  return null;
}

function usageFromPromptResult(result,fallback=null){
  const openCode=result?.raw?.info?.tokens;
  if(openCode){
    const input=Number(openCode.input||0),output=Number(openCode.output||0),reasoning=Number(openCode.reasoning||0),cached=Number(openCode.cache?.read||0),cacheWrite=Number(openCode.cache?.write||0);
    return {usage:{totalTokens:Number(openCode.total)||(input+output+reasoning+cached+cacheWrite),inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:cacheWrite,outputTokens:output,reasoningOutputTokens:reasoning},cost:result.raw?.info?.cost!=null?{amount:Number(result.raw.info.cost),currency:"USD"}:null,at:Date.now()};
  }
  const native=result?.raw?.usage;
  if(native&&(Object.prototype.hasOwnProperty.call(native,"inputTokens")||Object.prototype.hasOwnProperty.call(native,"outputTokens")||Object.prototype.hasOwnProperty.call(native,"totalTokens"))){
    const input=Number(native.inputTokens||0),output=Number(native.outputTokens||0),cached=Number(native.cachedInputTokens||0),cacheWrite=Number(native.cacheWriteInputTokens||0),reasoning=Number(native.reasoningOutputTokens||0);
    return {usage:{totalTokens:Number(native.totalTokens)||(input+output+reasoning),inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:cacheWrite,outputTokens:output,reasoningOutputTokens:reasoning},cost:null,at:Date.now()};
  }
  const claude=result?.raw?.usage;
  if(claude){
    const input=Number(claude.input_tokens||0),output=Number(claude.output_tokens||0),cached=Number(claude.cache_read_input_tokens||0),cacheWrite=Number(claude.cache_creation_input_tokens||0);
    return {usage:{totalTokens:input+output+cached+cacheWrite,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:cacheWrite,outputTokens:output,reasoningOutputTokens:0},cost:result.raw?.total_cost_usd!=null?{amount:Number(result.raw.total_cost_usd),currency:"USD"}:null,at:Date.now()};
  }
  return fallback;
}

function threadItemEntries(thread,turnId=null){
  const data=[];
  for(const turn of thread?.turns||[]){
    if(turnId&&turn.id!==turnId)continue;
    for(const item of turn.items||[])data.push({turnId:turn.id,item});
  }
  return data;
}

function turnCursor(turn){
  if(!turn?.id)return null;
  return "agent-turn-v1:"+Buffer.from(String(turn.id),"utf8").toString("base64url");
}

function parseTurnCursor(cursor){
  const raw=String(cursor||"");if(!raw.startsWith("agent-turn-v1:"))return null;
  try{const id=Buffer.from(raw.slice("agent-turn-v1:".length),"base64url").toString("utf8");return id||null}catch{return null}
}

function turnWithItemsView(turn,itemsView="summary"){
  const view=String(itemsView||"summary");
  if(view==="full")return {...turn,items:[...(turn.items||[])],itemsView:"full"};
  if(view==="notLoaded")return {...turn,items:[],itemsView:"notLoaded"};
  const items=turn.items||[];const users=items.filter(item=>item?.type==="userMessage");const agents=items.filter(item=>item?.type==="agentMessage");
  return {...turn,items:[...users,...(agents.length?[agents.at(-1)]:[])],itemsView:"summary"};
}

function agentSearchText(item){
  if(item?.type==="userMessage"){
    if(typeof item.text==="string")return item.text;
    return (item.content||[]).filter(part=>part?.type==="text"&&typeof part.text==="string").map(part=>part.text).join("");
  }
  if(item?.type==="agentMessage"&&typeof item.text==="string")return item.text.replace(/\s+/g," ").trim();
  return "";
}

function literalRanges(text,needle){
  const lowerNeedle=String(needle||"").toLowerCase();if(!lowerNeedle)return [];
  let lowered="";const spans=[];let originalOffset=0;
  for(const character of String(text||"")){
    const lower=character.toLowerCase(),lowerStart=lowered.length;lowered+=lower;
    spans.push({lowerStart,lowerEnd:lowered.length,originalStart:originalOffset,originalEnd:originalOffset+character.length});
    originalOffset+=character.length;
  }
  const ranges=[];let from=0;
  while(from<=lowered.length-lowerNeedle.length){
    const start=lowered.indexOf(lowerNeedle,from);if(start<0)break;const end=start+lowerNeedle.length;
    const first=spans.find(span=>span.lowerEnd>start),last=[...spans].reverse().find(span=>span.lowerStart<end);
    if(first&&last)ranges.push({start:first.originalStart,end:last.originalEnd});
    from=start+Math.max(1,lowerNeedle.length);
  }
  return ranges;
}

function snippetForRange(text,range){
  const before=48,after=96;let start=Math.max(0,range.start-before),end=Math.min(text.length,range.end+after);
  if(start>0&&/[\uDC00-\uDFFF]/.test(text[start]))start--;
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end++;
  const leading=start>0,trailing=end<text.length,prefix=leading?"... ":"",suffix=trailing?" ...":"";
  return {snippet:prefix+text.slice(start,end)+suffix,snippetMatchRange:{start:prefix.length+range.start-start,end:prefix.length+range.end-start}};
}

function searchCursor({threadId,searchTerm,turnId,itemId,matchStart}){
  const payload={threadId:String(threadId),searchTerm:String(searchTerm),turnId:String(turnId),itemId:String(itemId),matchStart:Number(matchStart)||0};
  return "agent-search-v1:"+Buffer.from(JSON.stringify(payload),"utf8").toString("base64url");
}

function parseSearchCursor(cursor){
  const raw=String(cursor||"");if(!raw.startsWith("agent-search-v1:"))return null;
  try{return JSON.parse(Buffer.from(raw.slice("agent-search-v1:".length),"base64url").toString("utf8"))}catch{return null}
}

function threadListSignature(params={}){
  const cwd=Array.isArray(params.cwd)?params.cwd.map(String):params.cwd==null?null:String(params.cwd);
  return JSON.stringify({
    archived:params.archived===true,
    cwd,
    section:Object.prototype.hasOwnProperty.call(params,"sectionId")?(params.sectionId??null):"__all__",
    searchTerm:String(params.searchTerm||""),
    sortKey:String(params.sortKey||"created_at"),
    sortDirection:String(params.sortDirection||"desc"),
  });
}

function threadListCursor(thread,signature){
  if(!thread?.id)return null;
  return "agent-thread-v1:"+Buffer.from(JSON.stringify({id:String(thread.id),signature}),"utf8").toString("base64url");
}

function parseThreadListCursor(cursor){
  const raw=String(cursor||"");if(!raw.startsWith("agent-thread-v1:"))return null;
  try{return JSON.parse(Buffer.from(raw.slice("agent-thread-v1:".length),"base64url").toString("utf8"))}catch{return null}
}

export function paginateAgentThreads(threads=[],params={}){
  const archived=params.archived===true;let data=(threads||[]).filter(thread=>Boolean(thread?.archived)===archived);
  const cwdFilters=(Array.isArray(params.cwd)?params.cwd:[params.cwd]).filter(value=>value!=null&&String(value)!=="").map(String);
  if(cwdFilters.length)data=data.filter(thread=>cwdFilters.includes(String(thread?.cwd||"")));
  if(Object.prototype.hasOwnProperty.call(params,"sectionId")){
    const sectionId=params.sectionId==null||params.sectionId===""?null:String(params.sectionId);
    data=data.filter(thread=>threadSectionId(thread)===sectionId);
  }
  const term=String(params.searchTerm||"").trim().toLowerCase();
  if(term)data=data.filter(thread=>String(thread?.name||thread?.preview||"").toLowerCase().includes(term));
  const sortKey=String(params.sortKey||"created_at"),direction=String(params.sortDirection||"desc").toLowerCase()==="asc"?1:-1;
  const sortValue=thread=>sortKey==="created_at"?Number(thread?.createdAt||0):Number(thread?.updatedAt||thread?.createdAt||0);
  // section_position ascending is a section's order from the top, as Codex sorts it.
  if(sortKey==="section_position")data.sort((left,right)=>compareSectionOrder(left,right)*direction);
  else data.sort((left,right)=>{const delta=sortValue(left)-sortValue(right);if(delta)return delta*direction;return String(left?.id||"").localeCompare(String(right?.id||""))*direction});
  const signature=threadListSignature(params);let start=0;
  if(params.cursor){
    const anchor=parseThreadListCursor(params.cursor);
    if(!anchor||anchor.signature!==signature)throw Object.assign(new Error("Invalid thread list cursor"),{code:-32602});
    start=data.findIndex(thread=>String(thread.id)===String(anchor.id));if(start<0)throw Object.assign(new Error("Thread list cursor no longer exists"),{code:-32602});
  }
  const pageSize=Math.max(1,Math.min(200,Number(params.limit)||100)),next=data[start+pageSize]||null;let selected=data.slice(start,start+pageSize);
  // Every listed thread says where it sits in its section and whether a person put it there (Codex's listing says neither).
  if(!archived){const ranks=sectionRanks(threads);selected=selected.map(thread=>withSectionPlace(thread,ranks))}
  return {data:selected,nextCursor:next?threadListCursor(next,signature):null,backwardsCursor:selected.length?threadListCursor(selected[0],signature):null};
}

function searchThreadSnippet(thread,term){
  const title=String(thread?.name||thread?.preview||"");const titleRanges=literalRanges(title,term);
  if(titleRanges.length)return snippetForRange(title,titleRanges[0]).snippet;
  for(const turn of thread?.turns||[]){
    const items=turn.items||[],finalAgent=[...items].reverse().find(item=>item?.type==="agentMessage")||null;
    for(const item of items){
      if(item?.type!=="userMessage"&&item!==finalAgent)continue;
      const text=agentSearchText(item),ranges=literalRanges(text,term);if(ranges.length)return snippetForRange(text,ranges[0]).snippet;
    }
  }
  return null;
}

function threadSearchPageCursor(thread,signature){
  if(!thread?.id)return null;
  return "agent-thread-search-v1:"+Buffer.from(JSON.stringify({id:String(thread.id),signature}),"utf8").toString("base64url");
}

function parseThreadSearchPageCursor(cursor){
  const raw=String(cursor||"");if(!raw.startsWith("agent-thread-search-v1:"))return null;
  try{return JSON.parse(Buffer.from(raw.slice("agent-thread-search-v1:".length),"base64url").toString("utf8"))}catch{return null}
}

// ranks: every listed thread's place in its section (sectionRanks over all the runtime's threads), which a found thread carries as
// thread/list gives it, so a thread found beyond the sidebar's first page can still be moved.
export function searchAgentThreads(threads=[],params={},{ranks=null}={}){
  const term=String(params.searchTerm||"").trim();if(!term)throw Object.assign(new Error("thread/search requires a non-empty searchTerm"),{code:-32602});
  const archived=params.archived===true,sortKey=String(params.sortKey||"created_at"),direction=String(params.sortDirection||"desc").toLowerCase()==="asc"?1:-1;
  const matches=(threads||[]).filter(thread=>Boolean(thread?.archived)===archived).map(thread=>({thread,snippet:searchThreadSnippet(thread,term)})).filter(item=>item.snippet);
  const sortValue=item=>sortKey==="created_at"?Number(item.thread?.createdAt||0):Number(item.thread?.updatedAt||item.thread?.createdAt||0);
  matches.sort((left,right)=>{const delta=sortValue(left)-sortValue(right);if(delta)return delta*direction;return String(left.thread?.id||"").localeCompare(String(right.thread?.id||""))*direction});
  const signature=JSON.stringify({term,archived,sortKey,sortDirection:String(params.sortDirection||"desc")});let start=0;
  if(params.cursor){
    const anchor=parseThreadSearchPageCursor(params.cursor);
    if(!anchor||anchor.signature!==signature)throw Object.assign(new Error("Invalid thread search cursor"),{code:-32602});
    start=matches.findIndex(item=>String(item.thread.id)===String(anchor.id));if(start<0)throw Object.assign(new Error("Thread search cursor no longer exists"),{code:-32602});
  }
  const pageSize=Math.max(1,Math.min(200,Number(params.limit)||50)),selected=matches.slice(start,start+pageSize),next=matches[start+pageSize]||null;
  return {
    data:selected.map(item=>({thread:{...(ranks&&!archived?withSectionPlace(item.thread,ranks):item.thread),turns:[],historyMode:"paginated"},snippet:item.snippet})),
    nextCursor:next?threadSearchPageCursor(next.thread,signature):null,
    backwardsCursor:selected.length?threadSearchPageCursor(selected[0].thread,signature):null,
  };
}

export function searchAgentThreadOccurrences(thread,{threadId=thread?.id,searchTerm="",cursor=null,limit=50}={}){
  const term=String(searchTerm||"");if(!term.trim())throw Object.assign(new Error("thread/searchOccurrences requires a non-empty searchTerm"),{code:-32602});
  const occurrences=[];
  for(const turn of thread?.turns||[]){
    const items=turn.items||[],finalAgent=[...items].reverse().find(item=>item?.type==="agentMessage")||null;
    for(const item of items){
      if(item?.type!=="userMessage"&&item!==finalAgent)continue;
      const text=agentSearchText(item);if(!text)continue;
      for(const range of literalRanges(text,term)){
        const snippet=snippetForRange(text,range);
        occurrences.push({
          turnId:turn.id,itemId:item.id,snippet:snippet.snippet,snippetMatchRange:snippet.snippetMatchRange,
          turnCursor:turnCursor(turn),__matchStart:range.start,
        });
      }
    }
  }
  let start=0;
  if(cursor){
    const anchor=parseSearchCursor(cursor);
    if(!anchor||String(anchor.threadId)!==String(threadId)||String(anchor.searchTerm)!==term)throw Object.assign(new Error("Invalid thread search cursor"),{code:-32602});
    start=occurrences.findIndex(item=>String(item.turnId)===String(anchor.turnId)&&String(item.itemId)===String(anchor.itemId)&&item.__matchStart===Number(anchor.matchStart));
    if(start<0)throw Object.assign(new Error("Thread search cursor no longer exists"),{code:-32602});
  }
  const pageSize=Math.max(1,Math.min(200,Number(limit)||50)),selected=occurrences.slice(start,start+pageSize),next=occurrences[start+pageSize]||null;
  return {
    data:selected.map(({__matchStart,...item})=>item),
    nextCursor:next?searchCursor({threadId,searchTerm:term,turnId:next.turnId,itemId:next.itemId,matchStart:next.__matchStart}):null,
  };
}

export function paginateAgentThreadTurns(thread,{cursor=null,limit=40,sortDirection="desc",itemsView="summary"}={}){
  const turns=thread?.turns||[];const descending=String(sortDirection||"desc").toLowerCase()!=="asc";
  const pageSize=Math.max(1,Math.min(200,Number(limit)||40));let start=descending?turns.length-1:0;
  if(cursor){
    const anchor=parseTurnCursor(cursor);if(!anchor)throw Object.assign(new Error("Invalid thread turn cursor"),{code:-32602});
    start=turns.findIndex(turn=>String(turn.id||"")===anchor);if(start<0)throw Object.assign(new Error("Thread turn cursor no longer exists"),{code:-32602});
  }
  if(start<0||start>=turns.length)return {data:[],nextCursor:null,backwardsCursor:null};
  const indexes=[];for(let index=start;index>=0&&index<turns.length&&indexes.length<pageSize;index+=descending?-1:1)indexes.push(index);
  const data=indexes.map(index=>turnWithItemsView(turns[index],itemsView));
  const nextIndex=indexes.length?(indexes.at(-1)+(descending?-1:1)):null;
  return {
    data,
    nextCursor:nextIndex!=null&&nextIndex>=0&&nextIndex<turns.length?turnCursor(turns[nextIndex]):null,
    backwardsCursor:data.length?turnCursor(data[0]):null,
  };
}

function itemCursor(entry){
  if(!entry?.turnId||!entry?.item?.id)return null;
  return "agent-item-v1:"+Buffer.from(JSON.stringify([String(entry.turnId),String(entry.item.id)]),"utf8").toString("base64url");
}

function parseItemCursor(cursor){
  const raw=String(cursor||"");if(!raw.startsWith("agent-item-v1:"))return null;
  try{
    const value=JSON.parse(Buffer.from(raw.slice("agent-item-v1:".length),"base64url").toString("utf8"));
    return Array.isArray(value)&&value.length===2?value.map(String):null;
  }catch{return null}
}

export function paginateAgentThreadItems(thread,{turnId=null,cursor=null,limit=150,sortDirection="asc"}={}){
  const entries=threadItemEntries(thread,turnId||null);
  const descending=String(sortDirection||"asc").toLowerCase()==="desc";
  const pageSize=Math.max(1,Math.min(500,Number(limit)||150));
  let start=descending?entries.length-1:0;
  if(cursor){
    const anchor=parseItemCursor(cursor);
    if(!anchor)throw Object.assign(new Error("Invalid thread item cursor"),{code:-32602});
    start=entries.findIndex(entry=>entry.turnId===anchor[0]&&String(entry.item?.id||"")===anchor[1]);
    if(start<0)throw Object.assign(new Error("Thread item cursor no longer exists"),{code:-32602});
  }
  if(start<0||start>=entries.length)return {data:[],nextCursor:null,backwardsCursor:null};
  const indexes=[];for(let index=start;index>=0&&index<entries.length&&indexes.length<pageSize;index+=descending?-1:1)indexes.push(index);
  const data=indexes.map(index=>entries[index]);
  const nextIndex=indexes.length?(indexes.at(-1)+(descending?-1:1)):null;
  return {
    data,
    nextCursor:nextIndex!=null&&nextIndex>=0&&nextIndex<entries.length?itemCursor(entries[nextIndex]):null,
    backwardsCursor:data.length?itemCursor(data[0]):null,
  };
}

export function agentThreadResumePayload(thread,{excludeTurns=false}={}){
  if(!thread)return null;
  if(!excludeTurns)return {thread};
  const entries=threadItemEntries(thread);
  return {
    thread:{...thread,turns:[],historyMode:"paginated"},
    itemsBackwardsCursor:entries.length?itemCursor(entries.at(-1)):null,
    turnsBackwardsCursor:thread.turns?.length?turnCursor(thread.turns.at(-1)):null,
  };
}

export function materializeAgentFork(threadStore,source,{runtime,providerSessionId,providerMeta=null,excludeTurns=false}={}){
  if(!threadStore||!source?.id||!providerSessionId)throw new Error("Fork materialization requires a source thread and provider session");
  const created=threadStore.create({
    runtime:runtime||source.runtime,
    cwd:source.cwd,
    providerSessionId,
    model:source.model||null,
    agent:source.agent||null,
    name:source.name?source.name+" (fork)":null,
    preview:source.preview||null,
    providerMeta:providerMeta||source.providerMeta||null,
  });
  const stored=threadStore.update(created.id,{turns:source.turns||[],forkedFromId:source.id,status:{type:"idle"},archived:false});
  return {stored,thread:excludeTurns?{...stored,turns:[],historyMode:"paginated"}:stored};
}

function agentQueue(state,threadId){
  const queue=state?.threadMeta?.(threadId)?.queuedSubmissions;
  return Array.isArray(queue)?queue.map(item=>({...item,input:[...(item.input||[])]})):[];
}

function saveAgentQueue(state,threadId,queue){
  state?.updateThreadMeta?.(threadId,{queuedSubmissions:queue});
  return queue;
}

export function paginateAgentQueue(queue=[],{cursor=null,limit=100}={}){
  let offset=0;
  if(cursor!=null){
    offset=Number(cursor);
    if(!Number.isInteger(offset)||offset<0)throw Object.assign(new Error("Invalid queue cursor"),{code:-32602});
  }
  const pageSize=Math.max(1,Math.min(200,Number(limit)||100)),data=(queue||[]).slice(offset,offset+pageSize);
  const next=offset+data.length;
  return {data,nextCursor:next<(queue||[]).length?String(next):null};
}

function agentAttachments(state,threadId){
  const current=state?.threadMeta?.(threadId)?.attachments;
  const source=Array.isArray(current)?current:[];let changed=false;
  const attachments=source.map(item=>{
    const next={...item};
    if(!next.id){next.id=randomUUID();changed=true}
    if(!Number.isFinite(Number(next.createdAt))){next.createdAt=Math.floor(Date.now()/1000);changed=true}
    return next;
  });
  if(changed)state?.updateThreadMeta?.(threadId,{attachments});
  return attachments;
}

export function paginateAgentAttachments(attachments=[],{cursor=null,limit=100}={}){
  let offset=0;
  if(cursor!=null){
    offset=Number(cursor);
    if(!Number.isInteger(offset)||offset<0)throw Object.assign(new Error("Invalid attachment cursor"),{code:-32602});
  }
  const pageSize=Math.max(1,Math.min(200,Number(limit)||100)),data=(attachments||[]).slice(offset,offset+pageSize),next=offset+data.length;
  return {data,nextCursor:next<(attachments||[]).length?String(next):null};
}

export function agentPermissionTraceData({toolCall=null,options=[]}={}){
  const kinds=[...new Set((Array.isArray(options)?options:[]).map(option=>String(option?.kind||"").trim()).filter(Boolean))].slice(0,20);
  return {
    toolCallId:toolCall?.toolCallId||toolCall?.id||null,
    title:String(toolCall?.title||"Agent tool").slice(0,300),
    kind:String(toolCall?.kind||"other").slice(0,80),
    optionKinds:kinds,
  };
}

export function restoreClaudeRejectedRewind(threadStore,threadId,error){
  const current=threadStore.get(threadId);if(!current)return null;
  const backup=current.providerMeta?.claudeRewindBackup;
  if(!backup||!Array.isArray(backup.removedTurns))return null;
  const providerMeta={...(current.providerMeta||{})};delete providerMeta.claudeFork;delete providerMeta.claudeRewindBackup;
  // A rewind made before an earlier fork ran puts that fork back as well.
  if(backup.claudeFork)providerMeta.claudeFork=backup.claudeFork;
  const retained=(current.turns||[]).slice(0,Math.max(0,Number(backup.retainedCount)||0));
  return threadStore.update(threadId,{
    providerSessionId:backup.sourceSessionId||error?.claudeFork?.sourceSessionId||current.providerSessionId,
    turns:[...retained,...backup.removedTurns],
    providerMeta,
  });
}

// Edit from here keeps the turns before the target. Claude Code resumes at the newest kept turn that reached its transcript
// (that turn's last assistant message, T3 Code's rollback cursor); with none, the thread starts a fresh Claude Code session
// (T3 Code's rollback to the thread start). A turn from before the conversation Claude Code holds now (heldConversationStart)
// reached only a transcript it lost, so it is no cursor.
export function claudeRewindCheckpoint(thread,beforeTurnId){
  const turns=Array.isArray(thread?.turns)?thread.turns:[],index=turns.findIndex(item=>item.id===beforeTurnId);
  if(index<0)throw new Error("Claude rewind target turn was not found.");
  const kept=turns.slice(heldConversationStart(thread),index).findLast(turn=>turn?.providerMessageId)||null;
  return {index,providerMessageId:kept?.providerMessageId||null};
}

// Where the conversation the harness holds now starts in the thread (an index into its turns): the first turn, or, after a fresh
// session took over a conversation the harness had lost, the turn whose prompt handed the earlier messages over (no turn while
// they wait to go over). The harness has the turns before it only as that handoff, and their messages only in the lost conversation.
export function heldConversationStart(thread){
  const turns=Array.isArray(thread?.turns)?thread.turns:[],handoff=thread?.providerMeta?.historyHandoff;
  if(!handoff)return 0;
  const index=handoff.status==="delivered"?turns.findIndex(turn=>turn?.id===handoff.turnId):-1;
  return index<0?turns.length:index;
}

// The handoff after Edit from here keeps `retained`. The conversation the thread goes on in (sessionId) holds the earlier messages
// only when it continues from the turn that handed them over or a later one (holdsHandoff; by default, that turn is kept). Else
// (a fork from before that turn, or a fresh conversation) they wait again for the next prompt, which hands the kept turns over;
// with no turn kept, nothing is left to hand over.
export function revertedHistoryHandoff(providerMeta,retained,{sessionId=null,holdsHandoff=null}={}){
  const meta={...(providerMeta||{})},handoff=meta.historyHandoff,kept=Array.isArray(retained)?retained:[];
  if(!handoff||(handoff.status==="delivered"&&(holdsHandoff??kept.some(turn=>turn?.id===handoff.turnId))))return meta;
  delete meta.historyHandoff;
  if(kept.length){const {turnId,deliveredAt,included,omitted,...waiting}=handoff;meta.historyHandoff={...waiting,status:"pending",sessionId:sessionId||null}}
  return meta;
}

// Provider metadata after a rewind: the fork the next prompt runs, and a backup of the thread's previous provider state and
// removed turns that restoreClaudeRejectedRewind puts back if Claude Code rejects that fork. A fresh session needs neither.
export function claudeRewindProviderMeta(thread,index,rewind,now=Date.now()){
  const previous=thread?.providerMeta||{},meta={...previous};delete meta.claudeFork;delete meta.claudeRewindBackup;
  if(!rewind?.lazyFork)return meta;
  meta.claudeFork=rewind.lazyFork;
  meta.claudeRewindBackup={sourceSessionId:thread.providerSessionId,...(previous.claudeFork?{claudeFork:previous.claudeFork}:{}),retainedCount:index,removedTurns:(thread.turns||[]).slice(index),createdAt:now};
  return meta;
}

// Whether Claude Code recorded turns of the thread's current conversation (ClaudeAgentSession persistedTurns). After a fresh
// session took over a lost one, the turns before the one that handed the earlier messages over were in the lost transcript.
export function claudePersistedTurns(thread){
  return (Array.isArray(thread?.turns)?thread.turns:[]).slice(heldConversationStart(thread)).some(turn=>turn?.providerMessageId||turn?.providerUserMessageId);
}

function formQuestions(params){
  const schema=params?.requestedSchema||params?.schema||params?.form||{};
  const properties=schema.properties||{};
  const required=new Set(schema.required||[]);
  return Object.entries(properties).map(([id,def])=>({
    id,header:def.title||id,question:def.description||def.title||id,required:required.has(id),allowMultiple:Array.isArray(def.items?.enum),
    options:(def.enum||def.items?.enum||def.oneOf?.map(item=>item.const).filter(Boolean)||[]).map(value=>({label:String(value),description:""})),
  }));
}

// The turn's retry row while a Native request waits for the network to come back: what failed, and when it is sent again.
export function nativeNetworkWaitMessage(data={}){
  const seconds=Math.max(1,Math.round(Number(data?.delayMs||0)/1000)),detail=String(data?.detail||data?.message||"").replace(/\s+/g," ").trim();
  return `Waiting for the network${detail?` (${detail})`:""}. Trying again in ${seconds} s.`;
}

// claudeSdk: the Claude Agent SDK the relay's Claude Code sessions drive, when not the installed one (tests pass a scripted one).
export function attachAgentRelay(server,{runtimeManager,threadStore,state,environments=null,contextEngine=null,repositoryKnowledge=null,nativeProviderTurn=null,nativeModelContextWindow=null,version="0.0.0",path="/api/agent/ws",log=()=>{},onThreadDeleted=null,journal=null,checkpoints=null,prepareDelegationWorkspace=null,cleanupDelegationWorkspace=null,claudeSdk=null}={}){
  const wss=new WebSocketServer({noServer:true});
  // Each change to sessions arms or stops the idle sweep below (armSessionSweep), as does a session the sweep comes to keep (keepSession).
  const sessions=new (class extends Map{set(key,value){super.set(key,value);armSessionSweep();return this}delete(key){const had=super.delete(key);if(had)armSessionSweep();return had}clear(){super.clear();armSessionSweep()}})();
  // A harness session idle for SESSION_IDLE_MS (no turn running, no approval, question or form waiting) is closed by a sweep every
  // SESSION_SWEEP_MS: each held its harness's processes (Grok 4 processes and 141 MB, Cursor 5 and 307 MB, OpenCode 4 and 499 MB),
  // none of them released before the server stopped. The thread's next turn starts the harness again and resumes its conversation
  // through ensureSession, as a reopened lazy thread does. Trebell Native's session runs in this process, and Claude Code releases its
  // own after 30 minutes (CLAUDE_IDLE_RELEASE_MS), so neither is swept. TREBELL_AGENT_SESSION_IDLE_MS and
  // TREBELL_AGENT_SESSION_SWEEP_MS shorten both for a test.
  // A session whose harness ran a tool that can outlive its turn (sessionLeftWork, see SETTLED_TOOL_KINDS) is kept until its thread
  // closes, as every session was: closing it stops the harness's whole process tree, and with it what the harness left running, and
  // nothing in ACP says when that work ends. So is one whose harness can neither load nor resume a conversation, whose thread could
  // not go on in a new one. threadRequests counts the requests about each thread still being answered (see request).
  const sessionEnv=runtimeManager?.env||process.env,sessionUsed=new WeakMap(),sessionLeftWork=new WeakSet(),threadRequests=new Map();
  const SESSION_IDLE_MS=Number(sessionEnv.TREBELL_AGENT_SESSION_IDLE_MS)>0?Number(sessionEnv.TREBELL_AGENT_SESSION_IDLE_MS):10*60_000;
  const SESSION_SWEEP_MS=Number(sessionEnv.TREBELL_AGENT_SESSION_SWEEP_MS)>0?Number(sessionEnv.TREBELL_AGENT_SESSION_SWEEP_MS):60_000;
  let sessionSweep=null;
  const socketContexts=new Set();
  // The approvals, questions, forms and app tool calls a harness asked of the person, until they are answered. They wait here, not with
  // the socket that showed them: a window that reloads or loses its socket leaves them waiting, and they are asked again, under the same
  // id, of another window still open or of the next one to connect (T3 keeps a pending approval in its thread for the next client). An
  // app tool call waits that way only until a window has been given it (see the socket's close).
  const pendingServer=new Map();let nextServerId=1;
  const isOpen=context=>Boolean(context)&&context.ws.readyState===context.ws.OPEN;
  const openContext=preferred=>isOpen(preferred)?preferred:[...socketContexts].reverse().find(isOpen)||null;
  function askAgain(context){
    if(!context)return;
    for(const [id,pending] of pendingServer)if(!pending.holder){pending.holder=context;context.ws.send(JSON.stringify({id,method:pending.method,params:pending.params}))}
  }
  // Whether an approval, a question or a form of the thread waits on the person (the idle sweep keeps its session).
  const waitsOn=threadId=>[...pendingServer.values()].some(pending=>pending.threadId===String(threadId||""));
  // Stop, an ACP process that died, or a session the relay closes (closeSession) answers the thread's open approvals, questions and form
  // requests as cancelled and takes them off the screen, and refuses the app tool calls it waits on (Native's browser, desktop and
  // delegation tools, which the app runs), so none is asked again of a window that opens later (T3 settles a session's pending
  // approvals and user input when its turn is interrupted or the process exits).
  function cancelThreadRequests(threadId){
    const owner=String(threadId||""),cancelled={"item/tool/requestApproval":{decision:"cancel"},"item/tool/requestUserInput":{answers:{}},"mcpServer/elicitation/request":{action:"cancel"}};
    if(!owner)return;
    for(const [id,pending] of [...pendingServer]){
      const answer=Object.prototype.hasOwnProperty.call(cancelled,pending.method)?cancelled[pending.method]:null;
      if(pending.threadId!==owner||(!answer&&pending.method!=="item/tool/call"))continue;
      pendingServer.delete(id);clearTimeout(pending.timer);
      if(answer)pending.resolve(answer);else pending.reject(new Error("The turn ended before the app answered this tool call."));
      if(isOpen(pending.holder))pending.holder.ws.send(JSON.stringify({method:"serverRequest/resolved",params:{requestId:id,threadId:owner}}));
    }
  }
  const recoveryInFlight=new Set();
  const liveToolOutput=new Map();
  // A running tool's latest item waiting to be stored, per thread and tool call: {turnId,at,item,timer}.
  const toolWrites=new Map();
  // The reasoning segment each thread's harness is thinking in: {id,turnId,messageId,text}.
  const liveReasoning=new Map();
  const pendingDelegations=new Map();
  const promptSettlements=new Set();
  // Antigravity sessions report the account's model list to the runtime manager when they start and when their model option changes.
  const sessionModelReports=new WeakMap();
  let closing=false;
  // A harness's model list that changed after the app read it (Antigravity's first session) reaches every open window, whose
  // composer then takes it (T3 pushes provider snapshots as they change).
  const stopModelUpdates=typeof runtimeManager?.onModelsChanged==="function"?runtimeManager.onModelsChanged(change=>{if(!closing)emit("agentRuntime/models/updated",change)}):()=>{};
  const threadMetadata=id=>typeof threadStore.getMetadata==="function"?threadStore.getMetadata(id):threadStore.get(id);
  // The store's shared copy of a thread (AgentThreadStore.peek), for a handler that only reads it: no sqlite read, no parse and no
  // copy of its history. It must not be changed, nor kept past the handler.
  const peekThread=id=>typeof threadStore.peek==="function"?threadStore.peek(id):threadStore.get(id);
  // The id and status of a thread's last turn (AgentThreadStore.lastTurn), or null for no such thread.
  const lastTurnOf=id=>{if(typeof threadStore.lastTurn==="function")return threadStore.lastTurn(id);const thread=peekThread(id),turn=thread?.turns?.at(-1);return thread?{id:turn?.id??null,status:turn?.status??null}:null};
  async function createVerificationCheckpoint(thread,label){
    if(!checkpoints?.create||!thread?.cwd)return null;
    try{
      const checkpoint=await checkpoints.create({cwd:thread.cwd,threadId:thread.id,label,environmentId:thread.providerMeta?.environmentId??null});
      journal?.record?.({runtime:thread.runtime||runtimeManager.activeRuntime(),provider:thread.providerMeta?.modelProvider||thread.providerMeta?.runtimeInstanceId||null,environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,category:"checkpoint",name:checkpoint?.supported===false?"checkpoint.skipped":"checkpoint.created",status:checkpoint?.supported===false?"unsupported":"completed",data:{checkpointId:checkpoint?.id||null,root:checkpoint?.root||null,label:checkpoint?.label||null,reason:checkpoint?.reason||null}});
      return checkpoint?.supported===false?null:checkpoint;
    }catch(error){journal?.record?.({runtime:thread.runtime||runtimeManager.activeRuntime(),provider:thread.providerMeta?.modelProvider||thread.providerMeta?.runtimeInstanceId||null,environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,category:"checkpoint",name:"checkpoint.create_failed",status:"error",data:{message:redactSecretText(error?.message||String(error),{environment:runtimeManager.env||process.env})}});return null}
  }
  function linkVerificationCheckpoint(thread,checkpoint,turnId){
    if(!checkpoints?.link||!checkpoint?.id||!turnId)return null;
    try{const linked=checkpoints.link(checkpoint.id,{turnId});journal?.record?.({runtime:thread.runtime||runtimeManager.activeRuntime(),provider:thread.providerMeta?.modelProvider||thread.providerMeta?.runtimeInstanceId||null,environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,turnId,category:"checkpoint",name:"checkpoint.linked",status:"completed",data:{checkpointId:checkpoint.id}});return linked}
    catch(error){journal?.record?.({runtime:thread.runtime||runtimeManager.activeRuntime(),provider:thread.providerMeta?.modelProvider||thread.providerMeta?.runtimeInstanceId||null,environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,turnId,category:"checkpoint",name:"checkpoint.link_failed",status:"error",data:{checkpointId:checkpoint.id,message:redactSecretText(error?.message||String(error),{environment:runtimeManager.env||process.env})}});return null}
  }
  const nativeQueueStarting=new Set();
  const nativeBackgroundProcesses=new NativeBackgroundProcessManager({
    environments,environment:runtimeManager?.env||process.env,platform:runtimeManager?.platform||process.platform,
    onEvent:event=>{const thread=threadMetadata(event.threadId);journal?.record?.({runtime:"native",provider:agentProviderIdentity(thread),environmentId:thread?.providerMeta?.environmentId??null,threadId:event.threadId,category:"process",name:event.name,status:event.status,data:event.data||{}})},
  });
  // A command's output comes as one tool_call_update per piece of output. Each update still goes to the windows at once, but the
  // thread stores a running tool's item at most every TOOL_WRITE_MS, with a trailing write of the last one: each update rewrote the
  // whole turn in a write transaction of its own. A crash loses at most that much of a running command's output, and the restart
  // marks the turn interrupted. The tool's start, its end and the turn's end write at once, and a request about the thread first
  // writes what waits, so a read never serves an older item than the windows were sent.
  function writeToolItem(threadId,toolCallId,turnId,item,{done=false}={}){
    const entry=toolWrites.get(threadId)?.get(toolCallId);
    if(entry){if(entry.item&&entry.turnId===turnId){clearTimeout(entry.timer);entry.timer=null;item={...entry.item,...item};entry.item=null}else flushToolItem(threadId,toolCallId)}
    threadStore.addItem(threadId,turnId,item);
    if(done)return forgetToolItem(threadId,toolCallId);
    let calls=toolWrites.get(threadId);if(!calls)toolWrites.set(threadId,calls=new Map());
    calls.set(toolCallId,{turnId,at:Date.now(),item:null,timer:null});
  }
  function deferToolItem(threadId,toolCallId,turnId,item){
    const entry=toolWrites.get(threadId)?.get(toolCallId),now=Date.now();
    if(!entry||entry.turnId!==turnId||(!entry.item&&now-entry.at>=TOOL_WRITE_MS))return writeToolItem(threadId,toolCallId,turnId,item);
    // Each update is the item merged over the stored one, so the waiting updates merged in order store as the last of them would.
    entry.item=entry.item?{...entry.item,...item}:item;
    if(!entry.timer){entry.timer=setTimeout(()=>flushToolItem(threadId,toolCallId),Math.max(0,entry.at+TOOL_WRITE_MS-now));entry.timer.unref?.()}
  }
  function flushToolItem(threadId,toolCallId){
    const entry=toolWrites.get(threadId)?.get(toolCallId);if(!entry)return;
    clearTimeout(entry.timer);entry.timer=null;if(!entry.item)return;
    const item=entry.item;entry.item=null;entry.at=Date.now();
    try{threadStore.addItem(threadId,entry.turnId,item)}catch(error){log("Could not store a tool's output: "+(error?.message||String(error)))}
  }
  function forgetToolItem(threadId,toolCallId){
    const calls=toolWrites.get(threadId),entry=calls?.get(toolCallId);if(!entry)return;
    clearTimeout(entry.timer);calls.delete(toolCallId);if(!calls.size)toolWrites.delete(threadId);
  }
  function flushToolWrites(threadId){for(const toolCallId of [...(toolWrites.get(threadId)?.keys()||[])])flushToolItem(threadId,toolCallId)}
  // At a turn's end what waits is written and the thread's tool calls are let go; a deleted thread's are dropped unwritten.
  function settleToolWrites(threadId,{write=true}={}){
    if(write)flushToolWrites(threadId);
    for(const toolCallId of [...(toolWrites.get(threadId)?.keys()||[])])forgetToolItem(threadId,toolCallId);
  }
  function clearLiveToolOutput(threadId){
    const prefix=String(threadId||"")+":";
    for(const key of liveToolOutput.keys())if(key.startsWith(prefix))liveToolOutput.delete(key);
  }
  // A harness's thinking streams as one Codex-shaped reasoning item per run of thought chunks; the run ends at the reply's text,
  // a tool call, a thought of another message or the turn's end (T3 Code's ACP adapter closes its reasoning segment there), and
  // the thread keeps its text.
  const reasoningItem=live=>({type:"reasoning",id:live.id,summary:[],content:[live.text]});
  function appendReasoning(threadId,turnId,text,messageId){
    let live=liveReasoning.get(threadId);
    if(live&&(live.turnId!==turnId||(messageId&&live.messageId&&messageId!==live.messageId))){endReasoning(threadId);live=null}
    if(!live){live={id:"reasoning-"+randomUUID(),turnId,messageId:messageId||null,text:""};liveReasoning.set(threadId,live);emit("item/started",{threadId,turnId,item:reasoningItem(live),startedAtMs:Date.now()})}
    live.text+=text;live.messageId||=messageId||null;
    emit("item/reasoning/textDelta",{threadId,turnId,itemId:live.id,delta:text,contentIndex:0});
  }
  function endReasoning(threadId,turnId=null){
    const live=liveReasoning.get(threadId);if(!live||(turnId&&live.turnId!==turnId))return;liveReasoning.delete(threadId);
    const item=reasoningItem(live);threadStore.addItem(threadId,live.turnId,item);
    emit("item/completed",{threadId,turnId:live.turnId,item,completedAtMs:Date.now()});
  }
  // The goal and the continuity read only the thread's turn times, ids and statuses and its recovery state, and return objects of
  // their own, so they read the store's shared copy (each took a full copy of the thread, on every open and every turn start).
  function durableGoal(threadId){
    const raw=state?.threadMeta?.(threadId)?.goal;if(!raw)return null;
    const thread=peekThread(threadId),createdAt=Number(raw.createdAt)||(Number(thread?.createdAt)||Math.floor(Date.now()/1000))*1000;
    const goal=normalizeGoal({threadId,previous:{...raw,createdAt},patch:{},now:Number(raw.updatedAt)||Date.now()});
    const childAgentsUsed=threadStore.list().filter(item=>item?.parentThreadId===threadId).length;
    return enrichGoal(goal,{usage:state?.threadUsage?.(threadId,{since:goal.createdAt}),turns:thread?.turns||[],childAgentsUsed,childAgentTelemetryComplete:true});
  }
  function durableContinuity(threadId){
    const thread=peekThread(threadId),meta=state?.threadMeta?.(threadId)||{};
    return continuitySnapshot({
      threadId,thread,meta,goal:durableGoal(threadId),
      verificationRecords:state?.verificationRecords?.({threadId,limit:10})||[],
      checkpoints:state?.checkpoints?.(threadId)||[],
      traces:journal?.list?.({threadId,limit:80})||[],
    });
  }
  async function withDurableContext(threadId,additionalContext={},query=""){
    const withGoal=goalAdditionalContext(additionalContext,durableGoal(threadId));
    const withContinuity=continuityAdditionalContext(withGoal,durableContinuity(threadId));
    if(!repositoryKnowledge)return withContinuity;
    const thread=threadMetadata(threadId),projectPath=thread?.cwd;if(!projectPath)return withContinuity;
    try{
      const environmentId=thread?.providerMeta?.environmentId??null;
      const knowledge=await repositoryKnowledge.context({projectPath,environmentId,query,limit:12,refresh:true});
      if(!knowledge?.context)return withContinuity;
      return {...withContinuity,"trebell.repository_knowledge":{kind:"application",value:knowledge.context}};
    }catch(error){
      log("Repository knowledge context unavailable: "+(error?.message||String(error)));
      return withContinuity;
    }
  }
  function assertGoalBudget(threadId){
    const goal=durableGoal(threadId),gate=goalBudgetGate(goal,{includeChildAgents:false});if(gate.allowed)return goal;
    const thread=threadMetadata(threadId),meta=thread?.providerMeta||{};
    journal?.record?.({runtime:thread?.runtime||runtimeManager.activeRuntime(),provider:meta.runtimeInstanceId||null,environmentId:meta.environmentId??state?.settings?.().activeEnvironmentId??null,threadId,category:"budget",name:"goal.budget_blocked",status:"blocked",data:{goalStatus:goal?.status||null,tokenBudget:goal?.tokenBudget??null,tokensUsed:goal?.tokensUsed??0,timeBudgetMinutes:goal?.timeBudgetMinutes??null,timeUsedSeconds:goal?.timeUsedSeconds??0,turnBudget:goal?.turnBudget??null,turnsUsed:goal?.turnsUsed??0,toolCallBudget:goal?.toolCallBudget??null,toolCallsUsed:goal?.toolCallsUsed??0,toolCallTelemetryComplete:goal?.toolCallTelemetryComplete??true,childAgentBudget:goal?.childAgentBudget??null,childAgentsUsed:goal?.childAgentsUsed??null,childAgentTelemetryComplete:goal?.childAgentTelemetryComplete??false,costBudgetUsd:goal?.costBudgetUsd??null,costUsedUsd:goal?.costUsedUsd??null,costTelemetryComplete:goal?.costTelemetryComplete??true,tokenExhausted:gate.tokenExhausted,timeExhausted:gate.timeExhausted,turnExhausted:gate.turnExhausted,toolCallExhausted:gate.toolCallExhausted,childAgentExhausted:gate.childAgentExhausted,costExhausted:gate.costExhausted}});
    throw Object.assign(new Error(gate.reason),{code:-32001});
  }
  function nativeGoalPromptOptions(goal){
    const options={};if(!goal)return options;
    if(goal.turnBudgetRemaining!=null)options.maxModelTurns=Math.max(1,Math.min(500,Math.floor(Number(goal.turnBudgetRemaining)||1)));
    if(goal.timeBudgetRemainingMinutes!=null)options.maxWallTimeMs=Math.max(1,Math.floor(Number(goal.timeBudgetRemainingMinutes)*60_000));
    if(goal.toolCallBudget!=null&&goal.toolCallTelemetryComplete!==false)options.maxToolCalls=Math.max(0,Number(goal.toolCallBudget)-Number(goal.toolCallsUsed||0));
    if(goal.tokenBudgetRemaining!=null)options.maxOutputTokens=Math.max(1,Math.floor(Number(goal.tokenBudgetRemaining)||1));
    return options;
  }
  function reserveDelegation(threadId){
    const goal=durableGoal(threadId),pending=Math.max(0,Number(pendingDelegations.get(threadId))||0);
    if(goal?.childAgentBudget!=null&&Number(goal.childAgentsUsed||0)+pending>=Number(goal.childAgentBudget)){
      throw Object.assign(new Error(`Goal budget exhausted: child-agent budget exhausted (${Number(goal.childAgentsUsed||0)+pending}/${goal.childAgentBudget}). Increase the exhausted budget before delegating more work.`),{code:-32001});
    }
    assertGoalBudget(threadId);
    pendingDelegations.set(threadId,pending+1);
    return ()=>{const next=Math.max(0,(Number(pendingDelegations.get(threadId))||1)-1);if(next)pendingDelegations.set(threadId,next);else pendingDelegations.delete(threadId)};
  }

  // Native threads persisted under a retired model provider are re-pointed at the selected provider and
  // lose their model, so resuming one never ships its transcript to a different vendor unattended.
  function migrateRetiredNativeThread(thread){
    if(thread?.runtime!=="native")return {thread,retiredProvider:false};
    const retiredProvider=isRetiredModelProvider(thread.providerMeta?.modelProvider),legacy=migrateLegacyNativeThread(thread,{provider:normalizeProviderId(state?.settings?.().modelProvider)});
    if(!legacy.changed)return {thread,retiredProvider};
    return {thread:threadStore.update(thread.id,{model:legacy.thread.model,providerMeta:legacy.thread.providerMeta},{touch:false})||legacy.thread,retiredProvider};
  }

  // Whether a revert starts the thread's harness conversation over (T3's ACP rollbackThread): Grok and Antigravity, and
  // OpenCode where it runs on its ACP server (a remote environment; the local OpenCode server forks at the turn instead).
  // Cursor offers no rollback (T3 canRollbackThread false).
  function acpRestartsOnRevert(thread){
    if(thread?.runtime==="grok"||thread?.runtime==="antigravity")return true;
    if(thread?.runtime!=="opencode")return false;
    const live=sessions.get(thread.id);if(live)return live instanceof AcpAgentSession;
    const environmentId=thread.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null;
    return Boolean(runtimeManager.remoteIo?.(runtimeManager.runtimeCwd?.(thread.cwd,environmentId)??thread.cwd,environmentId));
  }

  // A harness thread's session starts once at a time: a call while it starts (a second window sending, restart recovery racing a
  // send) waits for that start and then goes on as a later call would, so the thread never runs two harness processes or two
  // fresh sessions for a conversation the harness lost. Native threads keep their own path. Each call counts as use of the
  // session it returns, which the idle sweep reads (sessionUsed).
  const sessionStarts=new Map();
  const usedSession=session=>{sessionUsed.set(session,Date.now());return session};
  async function ensureSession(thread,context,options={}){
    if(thread?.runtime==="native")return usedSession(await startSession(thread,context,options));
    const starting=sessionStarts.get(thread?.id);
    if(starting){
      // A close or reset while this call waited ended the start it waited on: the call fails as that start's own did, instead of
      // starting the harness again after the relay closed or in the environment it left.
      const generation=sessionGeneration;await starting.catch(()=>{});
      if(generation!==sessionGeneration)throw restartedWhileStarting();
      return ensureSession(threadStore.get(thread.id)||thread,context,options);
    }
    const run=startSession(thread,context,options);sessionStarts.set(thread.id,run);
    try{return usedSession(await run)}finally{if(sessionStarts.get(thread.id)===run)sessionStarts.delete(thread.id)}
  }
  // The sessions the sweep may let go: an ACP or OpenCode harness's, but not one it keeps until its thread closes (see sessionLeftWork
  // above), whose harness ran a tool that can outlive its turn or can neither load nor resume a conversation. An ACP session's
  // capabilities are known from its start, before it enters sessions.
  const sweptSession=session=>(session instanceof OpenCodeAgentSession||session instanceof AcpAgentSession&&session.resumable)&&!sessionLeftWork.has(session);
  function keepSession(session){if(sessionLeftWork.has(session))return;sessionLeftWork.add(session);armSessionSweep()}
  function sweepIdleSessions(){
    const now=Date.now();
    for(const [threadId,session] of sessions){
      if(!sweptSession(session)||session.busy||session.activePrompt||threadRequests.has(threadId))continue;
      if(now-(sessionUsed.get(session)||0)<SESSION_IDLE_MS||threadMetadata(threadId)?.status?.type==="active")continue;
      if(waitsOn(threadId))continue;
      sessions.delete(threadId);releaseSession(session,error=>log("Could not close an idle harness session: "+(error?.message||String(error))));
      // The windows hear it as Codex tells them of a thread it unloads: what they keep of the thread's turns (the Stops they sent,
      // thread-turn-notes.js) goes.
      emit("thread/closed",{threadId});
    }
  }
  // The sweep runs only while sessions holds a session it may let go: the first such session arms it, and the last one to leave, or
  // to become one it keeps (keepSession), stops it. Armed for good, it fired every minute on an idle server with no harness session at
  // all, and armed by any harness session, every minute for one it keeps, as for most harness chats, whose turns run a command (B22).
  function armSessionSweep(){
    const held=!closing&&[...sessions.values()].some(sweptSession);
    if(held&&!sessionSweep){sessionSweep=setInterval(sweepIdleSessions,SESSION_SWEEP_MS);sessionSweep.unref?.()}
    else if(!held&&sessionSweep){clearInterval(sessionSweep);sessionSweep=null}
  }
  // A session the relay lets go on its own (the idle sweep, a harness that died, a rewind that starts the conversation over) leaves
  // sessions at once and closes after: an ACP harness gets up to 5 s to answer session/close before its process tree is stopped. A
  // close or reset of the relay waits for those closes too (closeSessions), so no harness outlives the relay.
  const sessionReleases=new Set();
  function releaseSession(session,onError=()=>{}){
    const release=(async()=>session.close())().catch(onError).finally(()=>sessionReleases.delete(release));
    sessionReleases.add(release);return release;
  }
  // A close or reset of the relay (shutdown, another environment) ends the sessions still starting as well as the ones that run:
  // the harness processes they started stop, and a start that returns afterwards is closed, never kept, so the turn waiting on it
  // fails instead of running in a session of the harness as it was. A start that has not launched its harness by then never does,
  // and once the relay closes no start begins.
  const startingSessions=new Set();let sessionGeneration=0;
  const restartedWhileStarting=()=>new Error("The harness was restarted while this conversation was starting.");
  async function startTracked(runtime,options,generation){
    if(generation!==sessionGeneration)throw restartedWhileStarting();
    startingSessions.add(runtime);
    try{return await runtime.start(options)}finally{startingSessions.delete(runtime)}
  }
  // A harness that failed where it runs (its session did not start, or a turn ended in its error) is asked again, once
  // (AgentRuntimeManager.recheck): the probe answer it started on is kept for a minute and may be one it no longer gives, as after a
  // `claude auth logout` in the person's own terminal. That check's answer replaces the kept one, so the next poll and the next
  // session start read it. harness: the runtime profile and environment a session runs in (sessionHarnesses); Trebell Native has
  // none. Only an error from the harness counts: a conversation the harness lost is no such failure (the harness ran to say so), nor
  // is a prompt that Trebell's own session refused (SessionRefusalError), nor a turn that the relay ended by closing its session
  // (closeThreadSession) or by a close or reset of the relay, and closeSessions stops waiting for a check still running (resetWaits).
  const sessionHarnesses=new WeakMap(),resetWaits=new Set(),closedSessions=new WeakSet();
  const failedWhereItRuns=(harness,error,generation,session=null)=>Boolean(harness)&&typeof runtimeManager.recheck==="function"&&!isHarnessSessionLost(error)&&!isSessionRefusal(error)&&!(session&&closedSessions.has(session))&&!closing&&generation===sessionGeneration;
  // The relay closes a thread's session whose turn may still run (an archive, a delete, a profile switch): whatever error the harness
  // ends that prompt with, the relay caused it. What that session still asked of the person goes with it (closeSession).
  function closeThreadSession(session,threadId){closedSessions.add(session);return closeSession(session,threadId)}
  // A session the relay closes takes its thread's waiting approvals, questions and forms with it: they are answered as cancelled and
  // leave every window, so the next window to open is not asked them (T3 ends the pending requests of a session it releases). They go
  // once the close has begun, so the harness already knows its turn is ending when their answers reach it.
  function closeSession(session,threadId){const closed=session.close();cancelThreadRequests(threadId);return closed}
  // The message a harness failure shows: the harness's own, and after it the advice of an answer that the harness cannot run or is
  // not signed in (withProbeAdvice); a check that still finds it ready leaves the message as it was.
  async function harnessFailureMessage(harness,error){
    let wake,status=null;const reset=new Promise(resolve=>{wake=resolve});resetWaits.add(wake);
    try{status=await Promise.race([runtimeManager.recheck(harness.instance,{environmentId:harness.environmentId}),reset])}catch{}
    finally{resetWaits.delete(wake)}
    return withProbeAdvice(error?.message,status);
  }
  // The same failure with another message: its code and the rest of what it carries go with it.
  function withMessage(error,message){
    if(message===error?.message)return error;
    const next=Object.assign(new Error(message,{cause:error}),error&&typeof error==="object"?error:{});next.message=message;return next;
  }
  // freshIfLost: a turn is about to run, so a conversation the harness lost continues in a fresh session (see below); opening,
  // forking, compacting and rewinding a thread keep the lost-session error.
  async function startSession(thread,context,{permissionMode=null,model=null,freshIfLost=false}={}){
    if(closing)throw new Error("The relay closed before the harness started.");
    const generation=sessionGeneration;
    if(thread?.runtime==="native"){
      const storedNamespaces=Array.isArray(thread.providerMeta?.dynamicToolNamespaces)?thread.providerMeta.dynamicToolNamespaces:[],activeNamespaces=expandableNativeToolNamespaces(storedNamespaces);
      if(activeNamespaces.length!==storedNamespaces.length){
        thread=threadStore.update(thread.id,{providerMeta:{...(thread.providerMeta||{}),dynamicToolNamespaces:activeNamespaces}},{touch:false});
      }
      const legacy=migrateRetiredNativeThread(thread);thread=legacy.thread;
      if(legacy.retiredProvider||isRetiredProviderModel(model))model=null;
    }
    let session=sessions.get(thread.id);
    if(session instanceof NativeAgentSession){
      const environmentId=thread.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null;
      const currentServers=nativeMcpServersForSession(state?.settings?.().mcpServers||[],{environmentId}),currentFingerprint=JSON.stringify(currentServers);
      if(session.__trebellMcpFingerprint!==currentFingerprint&&!session.turnActive){
        await session.close().catch(()=>{});sessions.delete(thread.id);session=null;
        journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"mcp",name:"native.mcp.reloaded",status:"completed",data:{serverCount:currentServers.length}});
      }
    }
    // An ACP harness whose process exited or was stopped starts again and resumes its conversation; one launched with another
    // permission mode (Cursor's and Grok's are launch arguments) is relaunched the same way, as T3 detaches such sessions.
    if(session instanceof AcpAgentSession){
      const accessLevel=normalizePermissionMode(permissionMode||thread.providerMeta?.permissionProfile||"supervised");
      if(session.dead||(!session.busy&&session.needsRelaunch(accessLevel))){await session.close().catch(()=>{});sessions.delete(thread.id);session=null}
      else session.setPermissionMode(accessLevel);
    }
    if(session)return session;
    // A session keeps the thread it starts from (its history, and the handlers that answer its requests), so it is built from a copy
    // of its own, never the store's shared one.
    if(threadStore.isShared?.(thread))thread=threadStore.get(thread.id)||thread;
    const effectivePermissionMode=normalizePermissionMode(permissionMode||thread.providerMeta?.permissionProfile||"supervised");
    const instances=runtimeManager.instances();
    const instance=instances.find(item=>item.id===thread.runtimeInstanceId)||instances.find(item=>item.kind===thread.runtime)||runtimeManager.activeInstance();
    if(instance.kind==="codex")throw new Error("Codex uses the native Codex relay");
    const environmentId=thread.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null;
    const status=await runtimeManager.probe(instance,{environmentId});if(!status.available)throw new Error(status.message||`${status.name} is unavailable`);
    const runtimeCwd=runtimeManager.runtimeCwd(thread.cwd,environmentId);const spawnProcess=runtimeManager.processSpawner(instance,environmentId);const remoteIo=runtimeManager.remoteIo(runtimeCwd,environmentId);
    const common={cwd:runtimeCwd,env:runtimeManager.childEnv(instance),permissionMode:effectivePermissionMode,onPermission:request=>context.permission(thread,request),onQuestion:request=>context.userQuestion(thread,request),onUpdate:params=>handleUpdate(thread.id,params),version};
    if(instance.kind==="native"){
      if(typeof nativeProviderTurn!=="function")throw new Error("Trebell Native provider transport is unavailable");
      const namespaceNames=new Set(thread.providerMeta?.dynamicToolNamespaces||[]),projectless=Boolean(thread.providerMeta?.projectless);
      const nativeProviderId=thread.providerMeta?.modelProvider||state?.settings?.().modelProvider||null;
      const stableOutputTools=providerFeatureEnabled(nativeProviderId,"promptCaching")||providerFeatureEnabled(nativeProviderId,"explicitCacheControl");
      const platformTools=platformDynamicToolNamespaces({
        repository:!projectless,
        progressiveRepository:!projectless,
        output:stableOutputTools,workspaceTools:true,terminal:true,process:namespaceNames.has("trebell_process"),
        browser:namespaceNames.has("trebell_browser"),computer:namespaceNames.has("trebell_computer"),
        sourceControl:!projectless&&namespaceNames.has("trebell_source_control"),delegation:namespaceNames.has("trebell_delegate"),
      });
      const repoIo=remoteIo?createRemoteContextIo({environments,environmentId,root:runtimeCwd}):null;
      const environmentProfile=environmentId&&environments?environments.get(environmentId):null;
      const mcpServers=nativeMcpServersForSession(state?.settings?.().mcpServers||[],{environmentId});
      const tools=[...platformTools];
      const exposeToolNamespaces=namespaces=>{
        for(const namespace of Array.isArray(namespaces)?namespaces:[]){
          if(!namespace?.name)continue;
          const index=tools.findIndex(item=>item?.name===namespace.name);
          if(index<0){tools.push(namespace);continue}
          const current=tools[index],byName=new Map((current.tools||[]).map(item=>[item.name,item]));for(const item of namespace.tools||[])byName.set(item.name,item);
          tools[index]={...current,...namespace,tools:[...byName.values()]};
        }
      };
      const outputStore=new NativeToolOutputStore({
        directory:join(trebellHome(runtimeManager.env||process.env),"tool-outputs",String(thread.id).replace(/[^a-zA-Z0-9._-]/g,"_")),
        onVirtualized:info=>{
          if(!stableOutputTools)exposeToolNamespaces(platformDynamicToolNamespaces({repository:false,output:true,workspaceTools:false,terminal:false,browser:false,computer:false,sourceControl:false,delegation:false}));
          journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"tool",name:info.archived?"native.tool_output.archived":"native.tool_output.virtualized",status:"completed",data:{handle:info.handle,totalBytes:info.totalBytes,namespace:info.namespace||null,name:info.name||null}});
        },
      });
      const mcpBroker=new NativeMcpBroker({
        servers:mcpServers,cwd:runtimeCwd,environments,environmentId,localEnvironment:runtimeManager.childEnv(instance),remoteEnvironmentNames:runtimeManager.childEnvironmentKeys(instance),version,
        onElicitation:async({server,params})=>context.serverRequest("mcpServer/elicitation/request",{
          ...params,threadId:thread.id,serverName:server.name,_meta:{...(params?._meta||{}),trebell_source:"native",mcp_server_id:server.id},
        }),
        onEvent:event=>journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"mcp",name:event.name,status:event.status,data:event.data||{}}),
      });
      const mcpTools=await mcpBroker.connect();
      const mcpDiscovery=mcpBroker.discoveryNamespace();if(mcpDiscovery)tools.push(mcpDiscovery);
      // The thread's history may name process handles from before a restart; the processes it starts now get later ones.
      nativeBackgroundProcesses.reserveHandles(thread.id,highestProcessHandle(thread));
      const nativeBuiltins=createNativeBuiltins({
        root:runtimeCwd,environments,environmentId,environment:runtimeManager.env||process.env,platform:runtimeManager.platform||process.platform,
        backgroundProcesses:nativeBackgroundProcesses,threadId:thread.id,environmentNames:runtimeManager.childEnvironmentKeys(instance),
      });
      const nativeSourceControl=!projectless&&namespaceNames.has("trebell_source_control")?createNativeSourceControl({
        root:runtimeCwd,environments,environmentId,environment:runtimeManager.env||process.env,platform:runtimeManager.platform||process.platform,environmentNames:runtimeManager.childEnvironmentKeys(instance),
      }):null;
      const discoverRepositoryTools=!projectless?({query,limit=8}={})=>{
        const result=discoverRepositoryCapabilities(tools,{query,limit});
        journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"tool",name:"native.repository.discovered",status:"completed",data:{query:result.query.slice(0,300),count:result.capabilities.length,tools:result.capabilities.map(item=>item.name)}});
        return result;
      }:null;
      const nativeSessionGrants=new Set();
      const executeTool=createNativeToolExecutor({
        contextEngine,root:runtimeCwd,repository:!projectless,io:repoIo,knowledgeService:repositoryKnowledge,environmentId,mcpBroker,
        discoverRepositoryTools,directTool:requested=>exposedToolNamed(tools,requested),outputStore,
        projectAvailable:!projectless,
        policyContext:()=>({
          permissionProfile:normalizePermissionMode((threadMetadata(thread.id)||thread)?.providerMeta?.permissionProfile||effectivePermissionMode),runtime:"native",workspace:runtimeCwd,projectAvailable:!projectless,
          desktopAvailable:namespaceNames.has("trebell_browser")||namespaceNames.has("trebell_computer"),delegationAvailable:namespaceNames.has("trebell_delegate"),
          environmentType:environmentProfile?.type||"local",environmentIsolated:false,provenance:"model",
        }),
        executeShared:async call=>{
          if(["trebell_workspace","trebell_terminal","trebell_process"].includes(call.namespace))return nativeBuiltins(call);
          if(call.namespace==="trebell_source_control"&&call.name!=="link_pull_request"){
            if(!nativeSourceControl)throw new Error("Native source control is unavailable for this thread");
            const startedAt=Date.now();journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"source-control",name:`source_control.${call.name}`,status:"running",data:{tool:call.name}});
            try{
              const result=await nativeSourceControl(call),gitInfo=result?.info||result;
              journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"source-control",name:`source_control.${call.name}`,status:"completed",data:{tool:call.name,durationMs:Date.now()-startedAt}});
              emit("thread/sourceControl/updated",{threadId:thread.id,tool:call.name,gitInfo:gitInfo&&typeof gitInfo==="object"?gitInfo:null});
              return result;
            }
            catch(error){journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"source-control",name:`source_control.${call.name}`,status:"failed",data:{tool:call.name,durationMs:Date.now()-startedAt,message:redactSecretText(error?.message||String(error),{environment:runtimeManager.env||process.env})}});throw error}
          }
          const liveThread=threadStore.get(thread.id)||thread,activeTurn=[...(liveThread.turns||[])].reverse().find(item=>item?.status==="inProgress")||null;
          return context.serverRequest("item/tool/call",{threadId:thread.id,turnId:activeTurn?.id||null,callId:call.id||randomUUID(),namespace:call.namespace,tool:call.name,arguments:call.arguments});
        },
        confirm:async({call,authorization})=>{
          // A session grant lives as long as this Native session: a new thread, or a restarted server, asks again.
          const grant=nativeApprovalGrantKey(call,authorization);if(nativeSessionGrants.has(grant))return "accept";
          // A read, listing or search inside the project runs without asking in Supervised and Auto-accept edits, as in the other
          // harnesses; its path is placed as the workspace tools place it, so one that leads out of the project still asks.
          const inside=path=>safeWorkspacePath(runtimeCwd,path,{environments,environmentId,mustExist:false}).then(()=>true);
          if(await nativeProjectReadNeedsNoApproval(call,authorization,{inside}))return "accept";
          const result=await context.serverRequest("item/tool/requestApproval",{threadId:thread.id,reason:nativeApprovalReason(call,authorization),toolCall:{toolCallId:call.id||randomUUID(),title:`${call.namespace}/${call.name}`,kind:authorization.action?.kind||"other",rawInput:call.arguments,policy:{riskLevel:authorization.action?.riskLevel,reversibility:authorization.action?.reversibility,externalSideEffect:authorization.action?.externalSideEffect}}});
          const decision=result?.decision||"decline";
          if(decision==="acceptForSession"){nativeSessionGrants.add(grant);return "accept"}
          return decision;
        },
        onEvent:event=>journal?.record?.({runtime:"native",provider:thread.providerMeta?.modelProvider||null,environmentId,threadId:thread.id,category:"tool",name:event.name,status:event.status,data:event.data||{}}),
      });
      const storedCompaction=thread.providerMeta?.nativeCompaction||null;
      const compactionBoundary=storedCompaction?.throughTurnId&&thread.turns?.some(turn=>String(turn.id)===String(storedCompaction.throughTurnId))?storedCompaction:null;
      const compactedMessage=compactionBoundary?nativeCompactionMessage(compactionBoundary.summary):null;
      // Native updates name the session that sent them, so a draft's frames belong to the turn that session is running.
      const runtime=new NativeAgentSession({
        ...common,streamDrafts:true,onUpdate:params=>handleUpdate(thread.id,params,runtime),provider:thread.providerMeta?.modelProvider||state?.settings?.().modelProvider||null,model:model||thread.model||null,reasoningEffort:configuredReasoningEffort(state?.settings?.()||{},"native",thread.providerMeta?.modelProvider||state?.settings?.().modelProvider||null,model||thread.model||null),serviceTier:configuredModelServiceTier(state?.settings?.()||{},"native",thread.providerMeta?.modelProvider||state?.settings?.().modelProvider||null,model||thread.model||null),semanticCompletionGate:true,tools,executeTool,toolOutputStore:outputStore,
        onClose:()=>mcpBroker.close(),
        providerTurn:request=>nativeProviderTurn(request),initialMessages:[
          {role:"system",content:nativeSystemPrompt({tools,permissionMode:effectivePermissionMode,projectless})},
          ...(thread.providerMeta?.developerInstructions?[{role:"developer",content:String(thread.providerMeta.developerInstructions)}]:[]),
          ...(compactedMessage?[compactedMessage]:[]),
          ...nativeMessagesFromThread(thread,{afterTurnId:compactionBoundary?.throughTurnId||null}),
        ],onEvent:event=>{
          const current=threadStore.get(thread.id)||thread,providerId=current?.providerMeta?.modelProvider||state?.settings?.().modelProvider||null;
          const category=String(event?.name||"").startsWith("native.model.")?"model":String(event?.name||"").startsWith("native.tool.")?"tool":"turn";
          const active=[...(current?.turns||[])].reverse().find(item=>item?.status==="inProgress"),activeTurnId=active?.id||null;
          if(event?.name==="native.model.requested"){
            const count=Math.max(0,Math.floor(Number(event?.data?.modelTurn)||0));
            if(active&&count>Number(active.modelTurns||0))threadStore.updateTurn(thread.id,active.id,{modelTurns:count});
          }
          // The turn goes on while the request waits for the network, and its retry row says so, as Codex's does.
          if(event?.name==="native.model.retrying"&&event.data?.waitingForNetwork===true&&activeTurnId)emit("error",{threadId:thread.id,turnId:activeTurnId,willRetry:true,error:{message:nativeNetworkWaitMessage(event.data)}});
          journal?.record?.({runtime:"native",provider:providerId,environmentId:current?.providerMeta?.environmentId??null,threadId:thread.id,turnId:activeTurnId,category,name:event.name,status:event.status,data:event.data||{}});
        },
      });
      runtime.__trebellMcpFingerprint=JSON.stringify(mcpServers);
      const started=await runtime.start({providerSessionId:thread.providerSessionId||null,model:model||thread.model||null});
      if(generation!==sessionGeneration){await runtime.close().catch(()=>{});throw restartedWhileStarting()}
      const discoveredMeta=threadMetadata(thread.id)?.providerMeta||{};
      // A started session is not activity: opening a thread starts it, and the thread keeps its place in the list.
      threadStore.update(thread.id,{providerSessionId:started.session.sessionId,providerMeta:{...discoveredMeta,initialize:started.initialize,setup:started.session,nativeMcp:{namespaces:mcpTools.map(item=>item.name),failures:mcpBroker.failures()}},model:model||started.session.models?.currentModelId||thread.model||null},{touch:false});
      sessions.set(thread.id,runtime);return runtime;
    }
    const projectless=Boolean(thread.providerMeta?.projectless),repositoryMcp=!projectless&&!remoteIo&&contextEngine?repositoryMcpProcessConfig({root:runtimeCwd,env:runtimeManager.env||process.env}):null;
    const acpMcpServers=mergeAcpMcpServers(acpMcpServersForSession(state?.settings?.().mcpServers||[],{runtime:instance.kind,environmentId}),repositoryMcp);
    const claudeMcpServers=claudeMcpServersForSession(state?.settings?.().mcpServers||[],{environmentId});
    if(instance.kind==="claude"&&contextEngine){
      const repoIo=remoteIo?createRemoteContextIo({environments,environmentId,root:runtimeCwd}):null;
      claudeMcpServers.trebell_repository=await createClaudeRepositoryMcp({contextEngine,root:runtimeCwd,io:repoIo,knowledgeService:repositoryKnowledge,environmentId,version});
    }
    const create=()=>instance.kind==="claude"
      ?new ClaudeAgentSession({...common,command:runtimeManager.executable(instance),spawnProcess,capabilityScope:environmentId||"",autoCompactWindow:instance.autoCompactWindow||null,forkFromSessionId:thread.providerMeta?.claudeFork?.sourceSessionId||null,resumeSessionAt:thread.providerMeta?.claudeFork?.resumeSessionAt||null,persistedTurns:claudePersistedTurns(threadStore.get(thread.id)||thread),onWakeTurn:promise=>startWakeTurn(thread.id,promise,context),mcpServers:claudeMcpServers,...(claudeSdk?{sdk:claudeSdk}:{})})
      :instance.kind==="opencode"
      ?(remoteIo
        ?new AcpAgentSession({...common,runtime:"opencode",command:runtimeManager.executable(instance),args:["acp"],spawnProcess,remoteIo,version,onElicitation:request=>context.elicitation(thread,request),mcpServers:acpMcpServers})
        :(/(?:^|\s)v?2\./i.test(String(status.version||""))
          ?new OpenCode2AgentSession({...common,version:status.version,command:runtimeManager.executable(instance),serverUrl:instance.serverUrl||null,repositoryMcp})
          :new OpenCodeAgentSession({...common,command:runtimeManager.executable(instance),serverUrl:instance.serverUrl||null,repositoryMcp})))
      :new AcpAgentSession({...common,runtime:instance.kind,command:runtimeManager.executable(instance),args:runtimeManager.acpArgs(instance,effectivePermissionMode,runtimeCwd),argsForPermission:mode=>runtimeManager.acpArgs(instance,mode,runtimeCwd),processCwd:instance.kind==="antigravity"&&!remoteIo?dirname(runtimeManager.executable(instance)):null,runTempRoot:instance.kind==="antigravity"&&!remoteIo?acpRuntimeTempRoot(runtimeManager.childEnv(instance),"antigravity"):null,attachmentsDir:instance.kind==="antigravity"&&!remoteIo?join(trebellHome(runtimeManager.env||process.env),"attachments"):null,onWakeTurn:promise=>startWakeTurn(thread.id,promise,context),spawnProcess,remoteIo,version,onElicitation:request=>context.elicitation(thread,request),mcpServers:acpMcpServers});
    let runtime=create(),started,lost=null;
    // A Cursor thread runs in the Plan mode it last ran in until a turn names another (also after a restart).
    const prepare=()=>{if(runtime instanceof AcpAgentSession&&instance.kind==="cursor")runtime.setCollaborationMode((threadMetadata(thread.id)||thread)?.settings?.collaborationMode?.mode||"default")};
    prepare();
    // Antigravity's model list is the one its sessions report (T3), also when the thread's model turns out not to be offered.
    const reportModels=()=>{if(runtime instanceof AcpAgentSession&&instance.kind==="antigravity"&&runtime.sessionSetup)runtimeManager.rememberAcpSessionModels?.(instance,runtime.sessionSetup,{environmentId})};
    const savedSessionId=thread.providerSessionId||null,requestedModel=model||thread.model||null;
    // A start that failed asks the harness again once (harnessFailureMessage), also after the fresh session a lost conversation
    // took, and fails with that check's advice beside the harness's own message.
    const harness={instance,environmentId};
    const startFailure=async error=>failedWhereItRuns(harness,error,generation)?withMessage(error,await harnessFailureMessage(harness,error)):error;
    try{started=await startTracked(runtime,{providerSessionId:savedSessionId,model:requestedModel},generation)}
    catch(error){
      reportModels();await runtime.close().catch(()=>{});
      if(generation!==sessionGeneration)throw restartedWhileStarting();
      // A harness that no longer has the thread's conversation continues it in one fresh session, whose first prompt hands the
      // earlier messages over (T3's provider resume fallback). A harness that cannot run at all fails as it is, and so does the
      // fresh session's start: a lost conversation never loops.
      if(!freshIfLost||!savedSessionId||!isHarnessSessionLost(error))throw await startFailure(error);
      lost={previousSessionId:String(savedSessionId),reason:error.message};
      runtime=create();prepare();
      try{started=await startTracked(runtime,{providerSessionId:null,model:requestedModel},generation)}
      catch(freshError){reportModels();await runtime.close().catch(()=>{});if(generation!==sessionGeneration)throw restartedWhileStarting();recordResumeFallback(thread,{...lost,sessionId:null,error:freshError});throw await startFailure(freshError)}
    }
    if(generation!==sessionGeneration){await runtime.close().catch(()=>{});throw restartedWhileStarting()}
    sessionHarnesses.set(runtime,harness);
    reportModels();sessionModelReports.set(runtime,reportModels);
    const discoveredMeta=threadMetadata(thread.id)?.providerMeta||{};
    // A resumed session keeps the thread's id; an ACP session reports the model it actually runs (an alias resolves to the real id).
    // The start is not activity either: opening a Claude Code thread starts its session and keeps the thread's place in the list.
    threadStore.update(thread.id,{providerSessionId:started.session.sessionId||(lost?"":thread.providerSessionId)||"",providerMeta:{...discoveredMeta,initialize:started.initialize,setup:started.session},model:(runtime instanceof AcpAgentSession?runtime.model:null)||model||started.session.models?.currentModelId||thread.model||null},{touch:false});
    if(lost)beginHistoryHandoff(thread,{...lost,sessionId:started.session.sessionId||""});
    sessions.set(thread.id,runtime);return runtime;
  }

  function diagnosticText(value){return redactSecretText(String(value||""),{environment:runtimeManager.env||process.env}).slice(0,500)}
  function recordResumeFallback(thread,{previousSessionId,sessionId,reason,error=null}){
    journal?.record?.({runtime:thread.runtime,provider:agentProviderIdentity(thread),environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,category:"turn",name:"agent.session.resume_fallback",status:error?"error":"completed",data:{lostSessionId:previousSessionId||null,sessionId:sessionId||null,reason:diagnosticText(reason),...(error?{error:diagnosticText(error?.message||error)}:{})}});
  }
  // A fresh session took over a conversation its harness lost. The thread's earlier messages wait on the thread (a restart keeps
  // them waiting) for the first prompt that reaches the new session; a turn that fails before then leaves them waiting.
  function beginHistoryHandoff(thread,{previousSessionId,sessionId,reason}){
    const meta=threadMetadata(thread.id)?.providerMeta||{};
    threadStore.update(thread.id,{providerMeta:{...meta,historyHandoff:{status:"pending",runtime:thread.runtime,previousSessionId,sessionId,reason:diagnosticText(reason),at:Date.now()}}});
    recordResumeFallback(thread,{previousSessionId,sessionId,reason});
  }
  // The waiting handoff as the prompt's trebell.thread_history entry for turnId's prompt: the thread's earlier conversation, without
  // the turn's own message (excludeTurnId), or null when nothing waits. One turn at a time carries it (handoffTurns): a turn started
  // while that one still runs (a second window, restart recovery racing a send) sends without it, so it goes over once.
  const handoffTurns=new Map();
  function pendingHistoryHandoff(threadId,turnId,{excludeTurnId=null}={}){
    const meta=threadMetadata(threadId);if(!meta||meta.runtime==="native"||meta.providerMeta?.historyHandoff?.status!=="pending")return null;
    const thread=threadStore.get(threadId);if(!thread)return null;
    const carrier=handoffTurns.get(threadId);if(carrier!==turnId&&thread.turns.some(turn=>turn?.id===carrier&&turn.status==="inProgress"))return null;
    handoffTurns.set(threadId,turnId);
    const history=threadHistoryHandoff(thread.turns,{harness:runtimeHarnessLabel(thread.runtime),excludeTurnId});
    return {history,context:history?{"trebell.thread_history":{kind:"application",value:history.text}}:{}};
  }
  // The prompt options that tell when the prompt carrying a waiting handoff reached the harness.
  function handoffDelivery(threadId,turnId,pending){return pending?{onDelivered:()=>deliverHistoryHandoff(threadId,turnId,pending.history)}:{}}
  // The row a turn keeps when its prompt handed a thread's earlier messages to a fresh session, live and after a reload: what
  // happened, in Trebell's words. It is not a failure.
  function sessionHandoffItem(turnId,handoff,history){
    const harness=runtimeHarnessLabel(handoff.runtime),included=history?.included||0,omitted=history?.omitted||0;
    const title=`${harness} no longer had this conversation, so it continues in a new session`+(included?` with the earlier messages handed over${omitted?`, except ${omitted} that did not fit`:""}.`:omitted?"; the earlier messages were too long to hand over.":".");
    return {type:"sessionHandoff",id:`session-handoff-${turnId}`,status:"completed",title,runtime:handoff.runtime,harness,previousSessionId:handoff.previousSessionId||null,sessionId:handoff.sessionId||null,reason:handoff.reason||null,handedOver:{included,omitted}};
  }
  function deliverHistoryHandoff(threadId,turnId,history){
    const meta=threadMetadata(threadId)?.providerMeta||{},handoff=meta.historyHandoff;if(handoff?.status!=="pending")return;
    handoffTurns.delete(threadId);
    threadStore.update(threadId,{providerMeta:{...meta,historyHandoff:{...handoff,status:"delivered",turnId,deliveredAt:Date.now(),included:history?.included||0,omitted:history?.omitted||0}}});
    const item=sessionHandoffItem(turnId,handoff,history);
    if(threadStore.addItem(threadId,turnId,item))emit("item/completed",{threadId,turnId,item,completedAtMs:Date.now()});
  }
  // Claude Code says it has no conversation under the thread's id only when the turn's query opens, before any output: the same
  // session starts a fresh conversation and the turn goes there once more, with the earlier messages handed over and whatever was
  // steered into the turn meanwhile after its own message (the error's steered). The thread keeps each user message once, and the
  // second send never sends again.
  function claudeLostSessionResend({thread,turn,session,input,durable,promptOptions,excludeTurnId=null}){
    if(!(session instanceof ClaudeAgentSession))return null;
    return async error=>{
      const previousSessionId=error?.sessionId||session.sessionId||thread.providerSessionId||"",started=await session.startFresh(),sessionId=started.session.sessionId;
      const meta=threadMetadata(thread.id)?.providerMeta||{};
      threadStore.update(thread.id,{providerSessionId:sessionId,providerMeta:{...meta,setup:started.session}});
      beginHistoryHandoff(thread,{previousSessionId,sessionId,reason:error?.message});
      const pending=pendingHistoryHandoff(thread.id,turn.id,{excludeTurnId});
      const prompt=await contextualAgentPrompt(input,{...durable,...pending?.context});
      return session.prompt([...prompt,...(Array.isArray(error?.steered)?error.steered:[]).flat()],{...promptOptions,messageId:randomUUID(),...handoffDelivery(thread.id,turn.id,pending)});
    };
  }

  function emit(method,params){
    const thread=params?.threadId?threadMetadata(params.threadId):null;
    journal?.recordProtocol?.({
      runtime:thread?.runtime||runtimeManager.activeRuntime(),
      provider:agentProviderIdentity(thread),
      environmentId:thread?.providerMeta?.environmentId??null,
      direction:"runtime",
      method,params,
    });
    for(const context of socketContexts)if(context.ws.readyState===context.ws.OPEN)context.ws.send(JSON.stringify({method,params}));
  }

  async function autoStartNextNativeQueue(threadId,context){
    const id=String(threadId||"");if(closing||!id||!context||nativeQueueStarting.has(id))return false;
    const current=threadMetadata(id);if(!current||current.runtime!=="native"||current.status?.type==="active")return false;
    const queue=agentQueue(state,id);if(!queue.length)return false;
    nativeQueueStarting.add(id);
    try{
      await request(context,"thread/queue/start",{threadId:id,queuedSubmissionId:queue[0].id});return true;
    }catch(error){
      journal?.record?.({runtime:"native",provider:agentProviderIdentity(current),environmentId:current.providerMeta?.environmentId??null,threadId:id,category:"queue",name:"queue.auto_start_failed",status:"error",data:{queuedSubmissionId:queue[0].id,message:String(error?.message||error).slice(0,500)}});
      emit("error",{threadId:id,message:"Could not start queued Native follow-up: "+(error?.message||String(error))});return false;
    }finally{nativeQueueStarting.delete(id)}
  }

  // resend: what sends the turn once more when the harness turned out not to have the conversation (claudeLostSessionResend);
  // that second send settles without one. generation: the relay's sessions the turn began in (a close or reset ends them).
  function settlePrompt({thread,turn,session,promptPromise,model=null,context=null,resend=null,generation=sessionGeneration}){
    const persistUsage=result=>{
      const usage=usageFromPromptResult(result,session.__usage);if(!usage)return;const current=threadMetadata(thread.id)||thread;
      state?.recordUsage?.({runtime:current.runtime||runtimeManager.activeRuntime(),provider:agentProviderIdentity(current),model:current.model||model||null,environmentId:current.providerMeta?.environmentId??null,threadId:thread.id,turnId:turn.id,usage:usage.usage,cost:usage.cost,at:usage.at||Date.now()});
    };
    const persistModelTurns=value=>{
      if(thread.runtime!=="native")return;const count=Number(value);if(!Number.isFinite(count)||count<0)return;
      threadStore.updateTurn(thread.id,turn.id,{modelTurns:Math.max(0,Math.floor(count))});
    };
    const settlement=promptPromise.then(result=>{
      settleToolWrites(thread.id);endNativeDraft(session,thread.id,turn.id);
      endReasoning(thread.id,turn.id);persistUsage(result);persistModelTurns(result?.raw?.modelTurns);
      const providerMessageId=result?.providerMessageId||result?.userMessageId||null;
      const providerUserMessageId=result?.userMessageId||null;
      if(providerMessageId||providerUserMessageId)threadStore.updateTurn(thread.id,turn.id,{...(providerMessageId?{providerMessageId}:{}),...(providerUserMessageId?{providerUserMessageId}:{})});
      const assistant=String(session.__assistant||"").trim();if(assistant){const item={type:"agentMessage",id:`assistant-${turn.id}`,text:assistant,phase:null,memoryCitation:null,delivery:null,questions:null};threadStore.addItem(thread.id,turn.id,item);emit("item/completed",{threadId:thread.id,turnId:turn.id,item,completedAtMs:Date.now()})}
      const status=result?.stopReason==="cancelled"?"cancelled":result?.stopReason==="refusal"?"failed":"completed";const completed=threadStore.finishTurn(thread.id,turn.id,{status,error:status==="failed"?{message:"Agent refused the turn"}:null});
      emit("turn/completed",{threadId:thread.id,turn:completed});emit("thread/status/changed",{threadId:thread.id,status:threadMetadata(thread.id)?.status||{type:"idle"}});
      if(status==="completed"&&thread.runtime==="native")queueMicrotask(()=>void autoStartNextNativeQueue(thread.id,context));
    }).catch(error=>{
      if(resend&&isHarnessSessionLost(error))return settlePrompt({thread,turn,session,promptPromise:resend(error),model,context,generation});
      settleToolWrites(thread.id);endNativeDraft(session,thread.id,turn.id);
      endReasoning(thread.id,turn.id);
      if(error?.code==="CLAUDE_REWIND_REJECTED"){
        // The next turn rebuilds the Claude session from the thread's restored provider state.
        if(sessions.get(thread.id)===session){sessions.delete(thread.id);releaseSession(session)}
        const restored=restoreClaudeRejectedRewind(threadStore,thread.id,error);
        if(restored){
          emit("error",{threadId:thread.id,turnId:turn.id,message:"Claude could not safely rewind because the provider transcript changed. The original conversation was restored."});
          emit("thread/reverted",{threadId:thread.id,thread:restored,recovered:true});
          emit("thread/status/changed",{threadId:thread.id,status:restored?.status||{type:"idle"}});
          return;
        }
        // A fork of another thread that Claude Code cannot continue: this thread goes on in a conversation of its own.
        const current=threadMetadata(thread.id)?.providerMeta||{};
        if(current.claudeFork){const next={...current};delete next.claudeFork;threadStore.update(thread.id,{providerMeta:next})}
      }
      // A Claude Code turn that failed after its prompt reached the transcript keeps its ids, so a later turn can be edited.
      if(error?.providerMessageId||error?.userMessageId)threadStore.updateTurn(thread.id,turn.id,{...(error.providerMessageId?{providerMessageId:error.providerMessageId}:{}),...(error.userMessageId?{providerUserMessageId:error.userMessageId}:{})});
      persistUsage(null);persistModelTurns(error?.nativeModelTurns);
      const fail=message=>{const completed=threadStore.finishTurn(thread.id,turn.id,{status:"failed",error:{message}});emit("error",{threadId:thread.id,turnId:turn.id,message});emit("turn/completed",{threadId:thread.id,turn:completed})};
      // A turn its harness failed asks the harness again before it ends (harnessFailureMessage); one the person stopped did not fail.
      const harness=sessionHarnesses.get(session);
      if(stoppedTurns.get(session)===turn.id||!failedWhereItRuns(harness,error,generation,session))return fail(error.message);
      // Stop, the thread's next turn, an archive or a delete ends that wait at once with the harness's own message (failureWaits), so
      // no turn of the thread ends under a later one; the check goes on, and the next poll and session start read what it finds.
      const threadId=String(thread.id);let settle,refuse;const ended=new Promise((resolve,reject)=>{settle=resolve;refuse=reject});
      const wait={end:(message=error.message)=>{if(failureWaits.get(threadId)!==wait)return;failureWaits.delete(threadId);try{fail(message);settle()}catch(failure){refuse(failure)}}};
      endFailureWait(threadId);failureWaits.set(threadId,wait);
      void harnessFailureMessage(harness,error).then(message=>wait.end(message),()=>wait.end());
      return ended;
    }).finally(()=>{clearLiveToolOutput(thread.id);recoveryInFlight.delete(thread.id);if(sessions.get(thread.id)===session)sessionUsed.set(session,Date.now())});
    promptSettlements.add(settlement);
    void settlement.finally(()=>promptSettlements.delete(settlement)).catch(error=>log(error?.stack||String(error)));
    return settlement;
  }

  // A Plan-capable harness (Claude Code, Cursor) runs the turn in the composer's collaboration mode, else the one the thread last
  // ran in; the thread remembers a changed mode, so reopening it shows that mode.
  function applyCollaborationMode(thread,session,params){
    const current=threadMetadata(thread.id)||thread,requested=params.collaborationMode?.mode?params.collaborationMode:null;
    session.setCollaborationMode(requested?.mode||current?.settings?.collaborationMode?.mode||"default");
    if(requested&&requested.mode!==current?.settings?.collaborationMode?.mode)threadStore.update(thread.id,{settings:{...(current?.settings||{}),collaborationMode:requested}});
  }

  // A harness answers on its own when background work it started finishes (T3 Code's wake turns: Claude Code's background
  // tasks, Grok's task prompts): that answer is a turn of its own, with no user message.
  function startWakeTurn(threadId,promptPromise,context){
    const thread=threadStore.get(threadId),session=sessions.get(threadId);
    if(!thread||!session){promptPromise.catch(()=>{});return}
    endFailureWait(thread.id);
    const turn=threadStore.addTurn(thread.id,{inputText:"",status:"inProgress"});session.__assistant="";session.__usage=null;
    emit("turn/started",{threadId:thread.id,turn});emit("thread/status/changed",{threadId:thread.id,status:{type:"active",activeFlags:[]}});
    settlePrompt({thread,turn,session,promptPromise,model:thread.model||null,context});
  }

  async function recoverPending(context){
    if(!state?.settings?.().continueThreadsAfterRestart)return;
    for(const thread of threadStore.list()){
      const recovery=thread.recovery;if(!recovery?.pending||!thread.providerSessionId||recoveryInFlight.has(thread.id))continue;
      recoveryInFlight.add(thread.id);
      try{
        const goal=assertGoalBudget(thread.id),session=await ensureSession(thread,context,{model:thread.model||null,freshIfLost:true});const turn=threadStore.restartTurn(thread.id,recovery.turnId);
        if(!turn)throw new Error("Interrupted turn was not found");
        if(session instanceof NativeAgentSession)session.__liveTurnId=turn.id;
        session.__assistant="";session.__usage=null;emit("turn/started",{threadId:thread.id,turn});emit("thread/status/changed",{threadId:thread.id,status:{type:"active",activeFlags:[]}});
        // A conversation the harness lost goes on in a fresh session that is handed the interrupted turn's message too, since
        // the prompt only says to continue.
        const continueText="Continue where you left off.",input=[{type:"text",text:continueText}];
        const durable=await withDurableContext(thread.id,{},continueText),pending=pendingHistoryHandoff(thread.id,turn.id);
        const prompt=await contextualAgentPrompt(input,{...durable,...pending?.context});
        const promptOptions={messageId:randomUUID(),agent:thread.agent||null,...(thread.runtime==="native"?nativeGoalPromptOptions(goal):{}),...handoffDelivery(thread.id,turn.id,pending)};
        settlePrompt({thread,turn,session,promptPromise:session.prompt(prompt,promptOptions),model:thread.model||null,context,resend:claudeLostSessionResend({thread,turn,session,input,durable,promptOptions})});
      }catch(error){
        // The open window says what the turn stores, so the error reads the same live and after a reload.
        const message=`Could not continue after restart: ${error.message}`;
        const failed=threadStore.finishTurn(thread.id,recovery.turnId,{status:"failed",error:{message}});emit("error",{threadId:thread.id,turnId:recovery.turnId,message});if(failed)emit("turn/completed",{threadId:thread.id,turn:failed});recoveryInFlight.delete(thread.id);
      }
    }
    for(const thread of threadStore.list()){
      if(thread.runtime!=="native"||thread.status?.type!=="idle"||thread.recovery?.pending||!agentQueue(state,thread.id).length)continue;
      await autoStartNextNativeQueue(thread.id,context);
    }
  }

  // A Native draft is the reply of one provider call shown while it streams, as deltas of the turn's assistant item with the
  // offset each one starts at. The first piece goes out at once and later ones at most every 50 ms; a draft the session
  // withdraws after showing anything is cleared with a reset frame, which carries no text. Drafts are checked against the
  // turn the emitting session runs, so they never read the stored thread.
  function handleNativeDraft(threadId,update,source){
    const turnId=source?.__liveTurnId;if(!turnId)return;
    if(update.sessionUpdate==="agent_message_draft_reset"){if(source.__nativeDraft&&source.__nativeDraft.draftId===update.draftId)dropNativeDraft(source,threadId,String(update.reason||"withdrawn"));return}
    const text=update.content?.type==="text"?String(update.content.text||""):"";if(!text||!update.draftId)return;
    let state=source.__nativeDraft;
    if(state&&(state.draftId!==update.draftId||state.turnId!==turnId)){dropNativeDraft(source,threadId,"replaced");state=null}
    if(!state)state=source.__nativeDraft={draftId:update.draftId,turnId,itemId:"assistant-"+turnId,emitted:"",pending:"",timer:null};
    state.pending+=text;
    if(!state.emitted){endReasoning(threadId);flushNativeDraft(source,threadId);return}
    if(!state.timer){state.timer=setTimeout(()=>{if(source.__nativeDraft===state){state.timer=null;flushNativeDraft(source,threadId)}},50);state.timer.unref?.()}
  }
  function flushNativeDraft(source,threadId){
    const state=source?.__nativeDraft;if(!state)return;if(state.timer){clearTimeout(state.timer);state.timer=null}if(!state.pending)return;
    emit("item/agentMessage/delta",{threadId,turnId:state.turnId,itemId:state.itemId,delta:state.pending,offset:state.emitted.length});state.emitted+=state.pending;state.pending="";
  }
  function dropNativeDraft(source,threadId,reason){
    const state=source?.__nativeDraft;if(!state)return;if(state.timer)clearTimeout(state.timer);delete source.__nativeDraft;
    if(state.emitted)emit("item/agentMessage/reset",{threadId,turnId:state.turnId,itemId:state.itemId,reason,chars:state.emitted.length});
  }
  // The turn's last draft ends with it; a session that already runs a later turn keeps that turn's draft.
  function endNativeDraft(session,threadId,turnId){
    if(!session||session.__liveTurnId!==turnId)return;dropNativeDraft(session,threadId,"turn_end");delete session.__liveTurnId;
  }

  function handleUpdate(threadId,params,source=null){
    const draftType=params?.update?.sessionUpdate;
    if(draftType==="agent_message_draft_delta"||draftType==="agent_message_draft_reset")return handleNativeDraft(threadId,params.update,source);
    // A chunk needs only the last turn's id and status; reading the stored thread for each one read and parsed all of its history.
    const update=params?.update||{};const lastTurn=lastTurnOf(threadId);if(!lastTurn)return;const turnId=lastTurn.id||null;
    const type=update.sessionUpdate;
    if(type==="tool_call"||type==="tool_call_update"){endReasoning(threadId);if(!SETTLED_TOOL_KINDS.has(update.kind)){const live=sessions.get(threadId);if(live)keepSession(live)}}
    if(type==="agent_message_chunk"){
      const session=sessions.get(threadId),text=agentTextAfterToolCall(session,update.content?.type==="text"?update.content.text||"":"");
      if(text)endReasoning(threadId);
      // The final reply after a shown draft sends only what the draft did not show, or clears the draft and sends it whole.
      const holder=source||session,draft=holder?.__nativeDraft?holder.__nativeDraft:null;
      if(draft){flushNativeDraft(holder,threadId);delete holder.__nativeDraft}
      if(draft?.emitted&&text.startsWith(draft.emitted)){const rest=text.slice(draft.emitted.length);if(rest)emit("item/agentMessage/delta",{threadId,turnId:draft.turnId,itemId:draft.itemId,delta:rest,offset:draft.emitted.length})}
      else{
        if(draft?.emitted)emit("item/agentMessage/reset",{threadId,turnId:draft.turnId,itemId:draft.itemId,reason:"replaced",chars:draft.emitted.length});
        if(text&&turnId)emit("item/agentMessage/delta",{threadId,turnId,delta:text});
      }
      if(session)session.__assistant=(session.__assistant||"")+text;
    }else if(type==="agent_thought_chunk"){
      const text=update.content?.type==="text"?String(update.content.text||""):"";
      if(text&&turnId&&lastTurn.status==="inProgress")appendReasoning(threadId,turnId,text,update.messageId?String(update.messageId):null);
    }else if(type==="tool_call"){
      const toolSession=sessions.get(threadId);if(toolSession)toolSession.__assistantBreak=true;
      const key=threadId+":"+String(update.toolCallId||"");
      const lifecycle=agentToolLifecycle(update,liveToolOutput.get(key)||"");const {item}=lifecycle;
      if(turnId)writeToolItem(threadId,String(update.toolCallId||""),turnId,item,{done:lifecycle.terminal});
      emit("item/started",{threadId,turnId,item,startedAtMs:Date.now()});
      if(lifecycle.outputDelta)emit("item/commandExecution/outputDelta",{threadId,turnId,itemId:item.id,delta:lifecycle.outputDelta});
      if(lifecycle.terminal){liveToolOutput.delete(key);emit("item/completed",{threadId,turnId,item,completedAtMs:Date.now()})}
      else if(lifecycle.output)liveToolOutput.set(key,lifecycle.output);
    }else if(type==="tool_call_update"){
      const key=threadId+":"+String(update.toolCallId||"");
      const lifecycle=agentToolLifecycle(update,liveToolOutput.get(key)||"");const {item}=lifecycle;
      if(turnId){if(lifecycle.terminal)writeToolItem(threadId,String(update.toolCallId||""),turnId,item,{done:true});else deferToolItem(threadId,String(update.toolCallId||""),turnId,item)}
      if(lifecycle.outputDelta)emit("item/commandExecution/outputDelta",{threadId,turnId,itemId:item.id,delta:lifecycle.outputDelta});
      if(lifecycle.terminal){liveToolOutput.delete(key);emit("item/completed",{threadId,turnId,item,completedAtMs:Date.now()})}
      else{if(lifecycle.output)liveToolOutput.set(key,lifecycle.output);emit("item/tool/progress",{threadId,turnId,item})}
    }else if(type==="plan"||type==="plan_update"||type==="plan_removed"){
      const planEvent=acpPlanEvent(update);
      if(turnId&&planEvent)emit("turn/plan/updated",{threadId,turnId,...planEvent});
    }else if(type==="usage_update"){
      const usage=update.usage||{};
      const input=Number(usage.input_tokens??usage.inputTokens??0)||0;
      const output=Number(usage.output_tokens??usage.outputTokens??0)||0;
      const cached=Number(usage.cache_read_input_tokens??usage.cacheReadInputTokens??0)||0;
      const cacheWrite=Number(usage.cache_write_input_tokens??usage.cache_creation_input_tokens??usage.cacheWriteInputTokens??0)||0;
      const reasoning=Number(usage.reasoning_tokens??usage.reasoningOutputTokens??0)||0;
      const used=Number(update.used)||(input+output+cached+cacheWrite+reasoning),size=Number(update.size)||0;
      const snapshot={totalTokens:used,inputTokens:input||Math.max(0,used-output-reasoning),cachedInputTokens:cached,cacheWriteInputTokens:cacheWrite,outputTokens:output,reasoningOutputTokens:reasoning};
      const runtimeSession=sessions.get(threadId);if(runtimeSession)runtimeSession.__usage={usage:snapshot,cost:update.cost||null,at:Date.now()};
      emit("thread/tokenUsage/updated",{threadId,turnId,tokenUsage:{total:snapshot,last:snapshot,modelContextWindow:size||null,cost:update.cost||null}});
    }else if(type==="diff"){
      emit("turn/diff/updated",{threadId,turnId,diff:update.diff||[]});
    }else if(type==="claude_fork_materialized"){
      const current=threadMetadata(threadId)?.providerMeta||{};const next={...current};delete next.claudeFork;delete next.claudeRewindBackup;
      threadStore.update(threadId,{providerMeta:next});
      emit("thread/providerMetadata/updated",{threadId,type,update});
    }else if(type==="compaction_update"||type==="compaction_summary_chunk"){
      const current=threadMetadata(threadId)?.providerMeta||{};
      const key=String(update.compactionId||"current");
      const previous=current.compactions?.[key]||{};
      const summaryChunk=type==="compaction_summary_chunk"&&update.content?.type==="text"?String(update.content.text||""):"";
      const nextEntry=type==="compaction_update"
        ?{...previous,...update,summaryText:Array.isArray(update.summary)?update.summary.filter(item=>item?.type==="text").map(item=>item.text||"").join(""):(update.summary===null?"":previous.summaryText||"")}
        :{...previous,compactionId:update.compactionId,summaryText:String(previous.summaryText||"")+summaryChunk};
      const compactions={...(current.compactions||{}),[key]:nextEntry};
      threadStore.update(threadId,{providerMeta:{...current,compactions,compaction_update:nextEntry}});
      emit("thread/providerMetadata/updated",{threadId,type:"compaction_update",update:nextEntry});
    }else if(type==="elicitation_complete"){
      emit("thread/elicitation/completed",{threadId,turnId,elicitationId:update.elicitationId||null});
    }else if(type==="available_commands_update"||type==="config_option_update"||type==="current_mode_update"||type==="session_info_update"){
      const current=threadMetadata(threadId)?.providerMeta||{};
      threadStore.update(threadId,{providerMeta:{...current,[type]:update}});
      emit("thread/providerMetadata/updated",{threadId,type,update});
      // A changed model option carries the account's current model list (T3 AntigravityProvider onConfigOptionsUpdated).
      if(type==="config_option_update"){const live=sessions.get(threadId);if(live)sessionModelReports.get(live)?.()}
    }else if(type==="runtime_error"){
      // A dead ACP process leaves the thread: the next turn starts the harness again and resumes the conversation (T3 releases
      // an errored session), and its open approval or question cards are withdrawn.
      const runtimeSession=sessions.get(threadId);
      if(runtimeSession instanceof AcpAgentSession&&runtimeSession.dead){sessions.delete(threadId);releaseSession(runtimeSession);cancelThreadRequests(threadId)}
      emit("error",{threadId,turnId,message:update.message||"Agent runtime stopped"});
    }
  }

  async function ensureNativeToolNamespaces(thread,requestedNamespaces=[]){
    if(!thread)return {supported:false,reason:"thread_missing",thread:null,added:[],namespaces:[]};
    if(thread.runtime!=="native")return {supported:false,reason:"runtime_does_not_support_dynamic_tool_expansion",thread,added:[],namespaces:[]};
    if(thread.status?.type==="active")throw new Error("Stop the running turn before expanding thread tools.");
    const requested=expandableNativeToolNamespaces(requestedNamespaces);
    const current=expandableNativeToolNamespaces(thread.providerMeta?.dynamicToolNamespaces||[]),currentSet=new Set(current),added=requested.filter(name=>!currentSet.has(name));
    if(!added.length)return {supported:true,thread,added:[],namespaces:current};
    const activeSession=sessions.get(thread.id);if(activeSession instanceof NativeAgentSession&&activeSession.turnActive)throw new Error("Stop the running turn before expanding thread tools.");
    const namespaces=[...current,...added],providerMeta={...(thread.providerMeta||{}),dynamicToolNamespaces:namespaces};
    const updated=threadStore.update(thread.id,{providerMeta});
    if(activeSession instanceof NativeAgentSession){await activeSession.close().catch(()=>{});sessions.delete(thread.id)}
    journal?.record?.({runtime:"native",provider:providerMeta.modelProvider||null,environmentId:providerMeta.environmentId??null,threadId:thread.id,category:"tool",name:"native.tools.expanded",status:"completed",data:{added,namespaces}});
    emit("thread/tools/updated",{threadId:thread.id,added,namespaces,thread:updated});return {supported:true,thread:updated,added,namespaces};
  }

  // A send (turn/start) waits before its prompt reaches the harness: for the thread's harness to start, which now follows every ten
  // idle minutes and takes Cursor 15-60 s and Antigravity about a minute, and for what it gathers first. Stop (turn/interrupt) has no
  // prompt to cancel then, so it marks the thread's waiting sends and each ends where it is: one whose turn does not exist yet fails
  // before it does, and one whose turn exists ends it cancelled, never sending the prompt. A harness start a stopped send leaves goes
  // on, and the thread's next send runs in its session.
  const waitingSends=new Map();
  // The running turn the person stopped, by the session it runs in: a harness that ends it with an error did not fail (settlePrompt).
  const stoppedTurns=new WeakMap();
  // A turn its harness failed, waiting on that harness's recheck before it ends (settlePrompt), by thread. endFailureWait ends it at
  // once with the harness's own message: Stop, the thread's next turn, an archive and a delete do not wait for the check.
  const failureWaits=new Map();
  function endFailureWait(threadId){failureWaits.get(String(threadId??""))?.end()}
  const stoppedBeforeTurn=()=>new Error("Stopped before the turn started.");
  function waitingSend(threadId){
    let sends=waitingSends.get(threadId);if(!sends)waitingSends.set(threadId,sends=new Set());
    let stop;const send={stopped:false,stop:new Promise(resolve=>{stop=resolve})};
    send.interrupt=()=>{send.stopped=true;stop()};
    send.done=()=>{sends.delete(send);if(!sends.size&&waitingSends.get(threadId)===sends)waitingSends.delete(threadId)};
    sends.add(send);return send;
  }
  // An archive or a delete ends the thread's sends still waiting for its harness, as Stop does: no turn starts in a thread the person
  // put away. A harness start still running for it is closed once it is done, since no turn of that thread will run in it.
  function endWaitingSends(threadId){
    const id=String(threadId||"");if(!id)return;
    for(const send of waitingSends.get(id)||[])send.interrupt();
    sessionStarts.get(id)?.then(session=>{
      const current=threadStore.get(id);
      if(session&&sessions.get(id)===session&&(!current||current.archived)){sessions.delete(id);releaseSession(session,error=>log("Could not close the harness session of a thread put away: "+(error?.message||String(error))))}
    },()=>{});
  }
  async function sessionUnlessStopped(send,starting){
    if(!send)return starting;
    const session=await Promise.race([starting,send.stop.then(()=>null)]);
    if(send.stopped)throw stoppedBeforeTurn();
    return session;
  }
  function endStoppedTurn(threadId,turnId){
    const turn=threadStore.finishTurn(threadId,turnId,{status:"cancelled"});
    emit("turn/completed",{threadId,turn});emit("thread/status/changed",{threadId,status:threadMetadata(threadId)?.status||{type:"idle"}});
    return turn;
  }
  // A request about a thread holds its session from the idle sweep until it is answered, and its answer counts as use: a fork, a
  // compaction or a rewind waits on the live session with no prompt running, and the sweep closed the session under it ("ACP runtime
  // stopped").
  async function request(context,method,params={}){
    const threadId=params?.threadId?String(params.threadId):"";if(!threadId)return serveRequest(context,method,params);
    threadRequests.set(threadId,(threadRequests.get(threadId)||0)+1);
    const send=method==="turn/start"?waitingSend(threadId):null;
    try{return await serveRequest(context,method,params,send)}
    finally{
      send?.done();
      const left=threadRequests.get(threadId)-1;if(left>0)threadRequests.set(threadId,left);else threadRequests.delete(threadId);
      const live=sessions.get(threadId);if(live)sessionUsed.set(live,Date.now());
    }
  }
  // send: a turn/start's place among the thread's waiting sends (waitingSends).
  async function serveRequest(context,method,params={},send=null){
    if(method==="initialize")return {userAgent:"trebell-agent-relay",capabilities:{experimentalApi:true}};
    if(params?.threadId)flushToolWrites(String(params.threadId));
    const runtime=runtimeManager.activeRuntime();
    const target=params?.threadId?threadMetadata(params.threadId):null;
    journal?.recordProtocol?.({
      runtime:target?.runtime||runtime,
      provider:agentProviderIdentity(target),
      environmentId:target?.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null,
      direction:"client",
      method,params,
    });
    // A model of a retired provider (or one named alongside a retired provider by a stale client or stale
    // thread metadata) can never be valid for the replacement provider: drop it instead of sending it on.
    if(runtime==="native"&&(method==="thread/start"||method==="turn/start")&&params?.model&&(isRetiredModelProvider(params.modelProvider)||isRetiredProviderModel(params.model)))params={...params,model:null};
    if(method==="thread/list")return paginateAgentThreads(threadStore.list(runtime),params);
    if(method==="thread/search")return searchAgentThreads(typeof threadStore.searchCandidates==="function"?threadStore.searchCandidates(runtime,params.searchTerm,{archived:params.archived===true}):threadStore.list(runtime),params,{ranks:params.archived===true?null:sectionRanks(threadStore.list(runtime))});
    if(method==="thread/read"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");
      return {thread:params.includeTurns===false?{...thread,turns:[]}:thread};
    }
    if(method==="thread/runtimeInstances/list"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.runtime!=="claude")return {supported:false,currentInstanceId:thread.runtimeInstanceId||null,items:[],reason:"Thread profile switching is currently supported only for Claude Code threads."};
      const instances=runtimeManager.instances();
      const savedInstanceId=thread.runtimeInstanceId||thread.providerMeta?.runtimeInstanceId||null;
      const current=instances.find(item=>item.id===savedInstanceId&&item.kind===thread.runtime)||instances.find(item=>item.kind===thread.runtime)||null;
      const environmentId=thread.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null;
      const compatibleIds=new Set(runtimeManager.compatibleInstanceIds(current));
      const compatible=instances.filter(instance=>instance.kind===thread.runtime&&compatibleIds.has(instance.id));
      const items=await Promise.all(compatible.map(async instance=>{
        const status=await runtimeManager.probe(instance,{environmentId}).catch(error=>({available:false,message:error.message||String(error)}));
        return {id:instance.id,displayName:instance.displayName||instance.id,current:instance.id===current?.id,available:Boolean(status?.available),authenticated:status?.authenticated??null,version:status?.version||null,message:status?.message||null};
      }));
      return {supported:true,currentInstanceId:current?.id||compatible[0]?.id||null,items};
    }
    if(method==="thread/runtimeInstance/set"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      const instances=runtimeManager.instances();const target=instances.find(item=>item.id===params.instanceId&&item.kind===thread.runtime);
      if(!target)throw new Error("Runtime profile not found");
      if(thread.runtime!=="claude")throw new Error("Thread profile switching is currently supported only for Claude Code threads.");
      if(thread.status?.type==="active")throw new Error("Stop the running turn before switching Claude profiles.");
      const savedInstanceId=thread.runtimeInstanceId||thread.providerMeta?.runtimeInstanceId||null;
      const current=instances.find(item=>item.id===savedInstanceId&&item.kind===thread.runtime)||instances.find(item=>item.kind===thread.runtime)||null;
      const compatibleIds=new Set(runtimeManager.compatibleInstanceIds(current));
      if(!compatibleIds.has(target.id))throw new Error("This Claude profile uses a different config directory, so it cannot continue this thread.");
      if(thread.runtimeInstanceId===target.id)return {thread};
      const environmentId=thread.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null;
      const status=await runtimeManager.probe(target,{environmentId});if(!status.available)throw new Error(status.message||"The selected Claude profile is unavailable");
      if(status.authenticated===false)throw new Error("Sign in to the selected Claude profile before switching this thread.");
      const existing=sessions.get(thread.id);if(existing){await closeThreadSession(existing,thread.id).catch(()=>{});sessions.delete(thread.id)}
      const providerMeta={...(thread.providerMeta||{}),runtimeInstanceId:target.id};
      const updated=threadStore.update(thread.id,{runtimeInstanceId:target.id,providerMeta});
      emit("thread/runtimeInstance/updated",{threadId:thread.id,runtimeInstanceId:target.id,thread:updated});
      return {thread:updated};
    }
    if(method==="thread/start"){
      const instances=runtimeManager.instances(),requestedId=String(params.runtimeInstanceId||"").trim();
      const instance=(requestedId?instances.find(item=>item.id===requestedId&&item.kind===runtime):null)||runtimeManager.activeInstance();
      if(instance.kind!==runtime)throw new Error("Requested runtime profile does not match the active external runtime");
      const environmentId=Object.prototype.hasOwnProperty.call(params,"environmentId")?(params.environmentId||null):(state?.settings?.().activeEnvironmentId||null);
      const permissionMode=agentPermissionModeFromStart(params),effectiveCwd=runtimeManager.runtimeCwd(params.cwd||process.cwd(),environmentId);
      const dynamicToolNamespaces=runtime==="native"?expandableNativeToolNamespaces((params.dynamicTools||[]).filter(item=>item?.type==="namespace"&&item.name).map(item=>String(item.name))):[];
      const seed=threadStore.create({runtime,cwd:effectiveCwd,providerSessionId:"",model:params.model||null,agent:params.agent||null,providerMeta:{
        runtimeInstanceId:instance.id,environmentId,permissionProfile:permissionMode,
        ...(runtime==="native"?{
          modelProvider:normalizeProviderId(params.modelProvider||state?.settings?.().modelProvider),
          dynamicToolNamespaces,projectless:Boolean(params.projectless),developerInstructions:String(params.developerInstructions||""),threadSource:String(params.threadSource||"trebell-code"),
        }:{}),
      }});
      threadStore.update(seed.id,{runtimeInstanceId:instance.id});
      // A thread whose session never started is not kept: the composer keeps the message and shows why, and no empty
      // "Untitled task" is left in the sidebar (the live tour's Cursor start that failed to set its model left one).
      let session;
      try{session=await ensureSession(threadStore.get(seed.id),context,{permissionMode,model:params.model||null})}
      catch(error){sessions.delete(seed.id);threadStore.delete(seed.id);throw error}
      // ensureSession recorded the model the session runs: an ACP session resolves an alias, or no choice, to its real model.
      const thread=threadStore.update(seed.id,{providerSessionId:session.sessionId,model:threadStore.get(seed.id)?.model||params.model||session.sessionSetup?.models?.currentModelId||null});
      emit("thread/started",{thread});return {thread};
    }
    // An open reads the thread's shared copy: one read and parse of its history on the first open, none on the pages after it or
    // the next open, and only a page is copied (each request read and parsed the whole stored thread, 4 to 5 times per open).
    if(method==="thread/resume"){
      const thread=peekThread(params.threadId);if(!thread)throw new Error("Thread not found");
      // An ACP harness's conversation opens with the thread's next turn, as T3 Code opens a provider session lazily ("a later
      // user command ... opens a session"): the reopened thread shows its saved transcript at once, where Cursor's start and
      // session/load kept it blank for half a minute in the live tour, and browsing threads starts no harness process. A harness
      // that no longer has the thread's conversation does not fail the open either: the saved transcript shows, and the next
      // turn continues the thread in a fresh session, as it does for the lazy harnesses.
      if(!LAZY_SESSION_RUNTIMES.has(thread.runtime))await ensureSession(thread,context,{model:params.model||thread.model}).catch(error=>{if(!isHarnessSessionLost(error))throw error});
      const resumed=agentThreadResumePayload(peekThread(thread.id),params),collaborationMode=thread.runtime==="claude"||thread.runtime==="cursor"?resumed?.thread?.settings?.collaborationMode:null;
      // A turn still running gives its reply so far, which the thread stores only once the turn ends: the thread opened again shows
      // it from its start, and the deltas sent after this answer go on from it. A Native draft on show is that reply meanwhile.
      const turn=lastTurnOf(thread.id),session=sessions.get(thread.id),draft=session?.__nativeDraft?.turnId===turn?.id?session.__nativeDraft:null;
      const liveText=turn?.status==="inProgress"&&session?(draft?draft.emitted:String(session.__assistant||"")):"";
      // The composer shows the collaboration mode the thread last ran in (Claude Code's and Cursor's Plan mode).
      return {...resumed,...(collaborationMode?.mode?{collaborationMode}:{}),...(liveText?{trebellLiveReply:{turnId:turn.id,text:liveText}}:{})};
    }
    if(method==="thread/items/list"){
      const thread=peekThread(params.threadId);if(!thread)throw new Error("Thread not found");
      return paginateAgentThreadItems(thread,params);
    }
    if(method==="thread/turns/list"){
      const thread=peekThread(params.threadId);if(!thread)throw new Error("Thread not found");
      return paginateAgentThreadTurns(thread,params);
    }
    if(method==="thread/searchOccurrences"){
      const thread=peekThread(params.threadId);if(!thread)throw new Error("Thread not found");
      return searchAgentThreadOccurrences(thread,params);
    }
    if(method==="thread/name/set"){
      const runtimeSession=sessions.get(params.threadId);if(runtimeSession instanceof ClaudeAgentSession)await runtimeSession.rename(params.name).catch(()=>{});
      const thread=threadStore.rename(params.threadId,params.name);emit("thread/name/updated",{threadId:params.threadId,name:thread?.name||null});return {thread}
    }
    if(method==="thread/delete"){
      const deletedThread=threadStore.get(params.threadId);
      endWaitingSends(params.threadId);
      if(deletedThread?.runtime==="native")await nativeBackgroundProcesses.clean(params.threadId).catch(()=>{});
      endFailureWait(params.threadId);
      // Claude Code's delete closes its session, then removes the transcript: the relay closed that session too (closedSessions).
      const runtimeSession=sessions.get(params.threadId);
      if(runtimeSession instanceof ClaudeAgentSession){closedSessions.add(runtimeSession);const deleted=runtimeSession.delete();cancelThreadRequests(params.threadId);await deleted.catch(()=>{})}else if(runtimeSession)await closeThreadSession(runtimeSession,params.threadId).catch(()=>{});
      sessions.delete(params.threadId);settleToolWrites(params.threadId,{write:false});threadStore.delete(params.threadId);if(state?.removeThreadMeta)state.removeThreadMeta(params.threadId);else state?.updateThreadMeta?.(params.threadId,{deletedAt:Date.now(),archived:true});emit("thread/deleted",{threadId:params.threadId});if(onThreadDeleted)try{await onThreadDeleted(deletedThread)}catch{}return {ok:true}
    }
    if(method==="thread/section/move"){
      // The thread goes where beforeThreadId says (thread-section-order.mjs), and the place is kept with the thread. Neither a move nor
      // the tiebreak it gives the threads beside it changes their last-update time, so it moves nothing else in the list.
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      const sectionId=params.sectionId==null||params.sectionId===""?null:String(params.sectionId),entering=threadSectionId(thread)!==sectionId;
      const placement=sectionMovePlacement(threadStore.list(thread.runtime),{threadId:thread.id,sectionId,beforeThreadId:params.beforeThreadId});
      let moved=null;
      for(const [id,order] of placement){
        const patch=id===String(thread.id)?{...order,section:sectionId?{id:sectionId,name:sectionId}:null,...(entering?{sectionEnteredAt:sectionId?Math.floor(Date.now()/1000):null}:{})}:order;
        const updated=threadStore.update(id,patch,{touch:false});if(id===String(thread.id))moved=updated;
      }
      return {thread:moved};
    }
    if(method==="thread/settings/update"){
      // The composer sends a collaboration mode change as a top-level collaborationMode (the shape Codex takes).
      const current=threadMetadata(params.threadId);const nextSettings={...(current?.settings||{}),...(params.settings||{}),...(params.collaborationMode?.mode?{collaborationMode:params.collaborationMode}:{})};
      return {thread:threadStore.update(params.threadId,{settings:nextSettings,...(Object.prototype.hasOwnProperty.call(params.settings||{},"agent")?{agent:params.settings.agent||null}:{})})}
    }
    if(method==="thread/tools/ensure"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");
      return ensureNativeToolNamespaces(thread,params.namespaces);
    }
    if(method==="thread/goal/get")return {goal:durableGoal(params.threadId)};
    if(method==="thread/goal/set"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      const previous=state.threadMeta(params.threadId)?.goal||null,goal=normalizeGoal({threadId:params.threadId,previous,patch:params});
      state.updateThreadMeta(params.threadId,{goal});const enriched=durableGoal(params.threadId);emit("thread/goal/updated",{threadId:params.threadId,goal:enriched});return {goal:enriched}
    }
    if(method==="thread/goal/clear"){state.updateThreadMeta(params.threadId,{goal:null});emit("thread/goal/cleared",{threadId:params.threadId});return {ok:true}}
    if(method==="thread/continuity/get"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      return {continuity:durableContinuity(params.threadId)};
    }
    if(method==="thread/continuity/set"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      const meta=state.threadMeta(params.threadId),continuityNotes=normalizeContinuityNotes(meta?.continuityNotes||null,params);
      state.updateThreadMeta(params.threadId,{continuityNotes});const continuity=durableContinuity(params.threadId);
      emit("thread/continuity/updated",{threadId:params.threadId,continuity});return {continuity};
    }
    if(method==="thread/continuity/clear"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      state.updateThreadMeta(params.threadId,{continuityNotes:undefined});const continuity=durableContinuity(params.threadId);
      emit("thread/continuity/updated",{threadId:params.threadId,continuity});return {ok:true,continuity};
    }
    if(method==="thread/verification/get"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      const records=state?.verificationRecords?.({threadId:thread.id,limit:50})||[];
      if(!records.length)return {record:null,nextAction:null};
      return verificationRepairState(records,params.recordId||null);
    }
    if(method==="thread/verification/evidence/record"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");const turnId=String(params.turnId||"").trim();if(!turnId)throw new Error("turnId is required");
      const evidence=normalizeBrowserVerificationReceipt(params.evidence||{});journal?.record?.({runtime:thread.runtime||runtime,provider:thread.providerMeta?.modelProvider||thread.providerMeta?.runtimeInstanceId||null,environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,turnId,category:"verification",name:"verification.browser_evidence",status:evidence.success?"completed":"failed",data:evidence});return {ok:true};
    }
    if(method==="thread/verification/repair"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.status?.type==="active")throw new Error("Stop the running turn before starting verification repair.");
      const records=state?.verificationRecords?.({threadId:thread.id,limit:50})||[];
      if(!records.length)throw new Error("No persisted verification record is available for this thread.");
      const prepared=verificationRepairState(records,params.recordId||null),{record,nextAction}=prepared;
      if(nextAction.action!=="repair")throw new Error("Latest verification does not require repair (next action: "+nextAction.action+").");
      const meta=state?.threadMeta?.(thread.id)||{},repairAttempt=verificationRepairAttempt(meta.verificationRepairChain,record,{automatic:Boolean(params.auto)}),automationAttempt=verificationAutomationAttempt(meta.verificationAutomationChain,record,{automatic:Boolean(params.auto),action:"repair"});
      if(!repairAttempt.allowed)throw Object.assign(new Error(`Automatic verification repair stopped after ${repairAttempt.limit} attempts. Review the remaining failure before continuing.`),{code:-32001});
      if(!automationAttempt.allowed)throw Object.assign(new Error(`Automatic verification workflow stopped after ${automationAttempt.limit} actions. Review the remaining verification state before continuing.`),{code:-32001});
      const repairContext=verificationRepairContext(prepared),repairPrompt=verificationRepairPrompt();
      const checkpoint=await createVerificationCheckpoint(thread,"Verification repair before "+String(record.id||"").slice(0,80));
      const started=await request(context,"turn/start",{
        threadId:thread.id,model:thread.model||undefined,
        ...(thread.runtime==="native"&&thread.providerMeta?.modelProvider?{modelProvider:thread.providerMeta.modelProvider}:{}),
        input:[{type:"text",text:repairPrompt}],additionalContext:{"trebell.verification_repair":{kind:"application",value:repairContext}},
      });
      if(started?.turn?.id){linkVerificationCheckpoint(thread,checkpoint,started.turn.id);state?.updateThreadMeta?.(thread.id,{verificationRepairChain:verificationRepairChainState(repairAttempt,started.turn.id),...(params.auto?{verificationAutomationChain:verificationAutomationChainState(automationAttempt,started.turn.id)}:{})})}
      journal?.record?.({runtime:thread.runtime||runtime,provider:thread.providerMeta?.modelProvider||thread.providerMeta?.runtimeInstanceId||null,environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,turnId:started?.turn?.id||null,category:"verification",name:"verification.repair_started",status:"running",data:{recordId:record.id,nextAction:nextAction.action,failedSteps:nextAction.failedSteps||[],automatic:Boolean(params.auto),attempt:repairAttempt.attempts}});
      return {record,nextAction,turn:started?.turn||null};
    }
    if(method==="thread/verification/continue"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.status?.type==="active")throw new Error("Stop the running turn before continuing verification.");
      const records=state?.verificationRecords?.({threadId:thread.id,limit:50})||[];if(!records.length)throw new Error("No persisted verification record is available for this thread.");
      const prepared=verificationContinuationState(records,params.recordId||null),{record,nextAction}=prepared;if(nextAction.action!=="verify"||!nextAction.nextStep)throw new Error("Latest verification does not require another verification step (next action: "+nextAction.action+").");
      const meta=state?.threadMeta?.(thread.id)||{},continuationAttempt=verificationContinuationAttempt(meta.verificationContinuationChain,record,{automatic:Boolean(params.auto)}),automationAttempt=verificationAutomationAttempt(meta.verificationAutomationChain,record,{automatic:Boolean(params.auto),action:"verify"});
      if(!continuationAttempt.allowed)throw Object.assign(new Error(`Automatic verification continuation stopped after ${continuationAttempt.limit} attempts. Review the remaining verification state before continuing.`),{code:-32001});
      if(!automationAttempt.allowed)throw Object.assign(new Error(`Automatic verification workflow stopped after ${automationAttempt.limit} actions. Review the remaining verification state before continuing.`),{code:-32001});
      const verificationContext=verificationContinuationContext(prepared),verificationPrompt=verificationContinuationPrompt(),started=await request(context,"turn/start",{
        threadId:thread.id,model:thread.model||undefined,
        ...(thread.runtime==="native"&&thread.providerMeta?.modelProvider?{modelProvider:thread.providerMeta.modelProvider}:{}),
        input:[{type:"text",text:verificationPrompt}],additionalContext:{"trebell.verification_continue":{kind:"application",value:verificationContext}},
      });
      if(started?.turn?.id)state?.updateThreadMeta?.(thread.id,{verificationContinuationChain:verificationContinuationChainState(continuationAttempt,started.turn.id),...(params.auto?{verificationAutomationChain:verificationAutomationChainState(automationAttempt,started.turn.id)}:{})});
      journal?.record?.({runtime:thread.runtime||runtime,provider:thread.providerMeta?.modelProvider||thread.providerMeta?.runtimeInstanceId||null,environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,turnId:started?.turn?.id||null,category:"verification",name:"verification.continuation_started",status:"running",data:{recordId:record.id,nextStepId:nextAction.nextStep?.id||null,automatic:Boolean(params.auto),attempt:continuationAttempt.attempts}});
      return {record,nextAction,turn:started?.turn||null};
    }
    if(method==="thread/delegate"){
      const parent=threadStore.get(params.threadId||params.parentThreadId);if(!parent)throw new Error("Parent thread not found");
      const result=await executeDelegation({
        parentThreadId:parent.id,request:params,
        reserve:()=>reserveDelegation(parent.id),
        prepareWorkspace:async({spec,delegationId})=>{
          if(prepareDelegationWorkspace)return prepareDelegationWorkspace({parentThreadId:parent.id,parentThread:parent,spec,delegationId});
          if(spec.isolation==="inherit")return {cwd:parent.cwd,branch:null,isolation:"inherit",worktree:false};
          throw new Error("This Trebell host does not expose isolated delegation workspaces");
        },
        startThread:async({spec,workspace})=>{
          const policy=delegationPolicies(spec.permissions,workspace.cwd),model=spec.model||parent.model||null;
          const parentNamespaces=Array.isArray(parent.providerMeta?.dynamicToolNamespaces)?parent.providerMeta.dynamicToolNamespaces:[];
          const childNamespaces=parent.runtime==="native"&&!(Number(spec.budget?.childAgentBudget)>0)
            ?parentNamespaces.filter(name=>name!=="trebell_delegate")
            :parentNamespaces;
          const started=await request(context,"thread/start",{
            cwd:workspace.cwd,model,agent:parent.agent||null,approvalPolicy:policy.approvalPolicy,sandbox:policy.sandbox,
            runtimeInstanceId:parent.runtimeInstanceId||parent.providerMeta?.runtimeInstanceId||null,
            environmentId:parent.providerMeta?.environmentId??null,threadSource:"trebell-delegate",
            ...(parent.runtime==="native"?{
              modelProvider:parent.providerMeta?.modelProvider||state?.settings?.().modelProvider||null,
              projectless:Boolean(parent.providerMeta?.projectless),
              dynamicTools:childNamespaces.map(name=>({type:"namespace",name})),
              developerInstructions:String(parent.providerMeta?.developerInstructions||""),
            }:{}),
          });
          return started?.thread||null;
        },
        configureChild:async({spec,workspace,childThread,delegationId})=>{
          const childId=String(childThread.id),model=spec.model||parent.model||childThread.model||null;
          const updated=threadStore.update(childId,{
            parentThreadId:parent.id,agentRole:"delegate",name:spec.label||childThread.name||null,
            providerMeta:{...(childThread.providerMeta||{}),delegationPermissionProfile:spec.permissions},
          });
          Object.assign(childThread,updated||{});
          const goal=normalizeGoal({threadId:childId,patch:delegationGoalPatch(spec)});
          state.updateThreadMeta(childId,{
            cwd:workspace.cwd,branch:workspace.branch||null,runtime:parent.runtime,runtimeInstanceId:parent.runtimeInstanceId||parent.providerMeta?.runtimeInstanceId||null,
            environmentId:parent.providerMeta?.environmentId??null,parentThreadId:parent.id,
            delegation:{id:delegationId,parentThreadId:parent.id,task:spec.task,permission:spec.permissions,requestedPermission:spec.permission,isolation:spec.isolation==="inherit"?"shared":"worktree",requestedIsolation:spec.requestedIsolation,ownership:spec.ownership,model,createdAt:Date.now(),status:"running"},
            goal,
          });
        },
        startTurn:async({spec,workspace,childThread})=>{
          const policy=delegationPolicies(spec.permissions,workspace.cwd),model=spec.model||parent.model||childThread.model||null;
          const delegationContext=delegationContextValue({parentThreadId:parent.id,spec});
          const started=await request(context,"turn/start",{
            threadId:String(childThread.id),cwd:workspace.cwd,model,...(parent.runtime==="native"&&parent.providerMeta?.modelProvider?{modelProvider:parent.providerMeta.modelProvider}:{}),approvalPolicy:policy.approvalPolicy,sandboxPolicy:policy.sandboxPolicy,
            input:[{type:"text",text:spec.task}],additionalContext:{"trebell.delegation":{kind:"application",value:delegationContext}},
          });
          state.updateThreadMeta(String(childThread.id),{delegation:{...state.threadMeta(String(childThread.id)).delegation,turnId:started?.turn?.id||null}});
          return started?.turn||null;
        },
        cleanupWorkspace:async payload=>{if(cleanupDelegationWorkspace)await cleanupDelegationWorkspace({...payload,parentThread:parent})},
        markFailed:async({childThread,error})=>{
          const childId=String(childThread.id),meta=state.threadMeta(childId);
          state.updateThreadMeta(childId,{delegation:{...(meta.delegation||{}),status:"failed",error:error.message||String(error),failedAt:Date.now()}});
        },
        onStarted:async result=>{
          const child=threadStore.get(result.thread.id)||result.thread;result.thread=child;
          journal?.record?.({runtime:parent.runtime,provider:agentProviderIdentity(parent),environmentId:parent.providerMeta?.environmentId??null,threadId:parent.id,turnId:result.turn?.id||null,category:"delegation",name:"delegation.started",status:"running",data:{delegationId:result.delegationId,childThreadId:child.id,isolation:result.isolation,permissions:result.permission,branch:result.workspace?.branch||null}});
          emit("thread/delegated",{threadId:parent.id,delegationId:result.delegationId,childThreadId:child.id,thread:child,turn:result.turn||null,workspace:result.workspace});
        },
      });
      return result;
    }
    if(method==="thread/attachment/list"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      return paginateAgentAttachments(agentAttachments(state,params.threadId),params);
    }
    if(method==="thread/attachment/add"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      const attachmentType=String(params.attachmentType||"").trim(),identityKey=String(params.identityKey||"").trim();
      if(!attachmentType||!identityKey)throw Object.assign(new Error("attachmentType and identityKey are required"),{code:-32602});
      const attachments=agentAttachments(state,params.threadId),existing=attachments.find(item=>item.attachmentType===attachmentType&&item.identityKey===identityKey);
      if(existing)return {outcome:"existing",attachment:existing};
      const attachment={id:randomUUID(),attachmentType,identityKey,payload:params.payload,createdAt:Math.floor(Date.now()/1000)};
      attachments.push(attachment);state.updateThreadMeta(params.threadId,{attachments});emit("thread/attachment/updated",{threadId:params.threadId,attachmentType,identityKey,attachmentId:attachment.id,operation:"created"});return {outcome:"created",attachment};
    }
    if(method==="thread/attachment/remove"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      const attachments=agentAttachments(state,params.threadId),target=attachments.find(item=>item.attachmentType===params.attachmentType&&item.identityKey===params.identityKey);
      if(!target)return {};
      state.updateThreadMeta(params.threadId,{attachments:attachments.filter(item=>item.id!==target.id)});emit("thread/attachment/updated",{threadId:params.threadId,attachmentType:target.attachmentType,identityKey:target.identityKey,attachmentId:target.id,operation:"deleted"});return {};
    }
    if(method==="thread/queue/list"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      return paginateAgentQueue(agentQueue(state,params.threadId),params);
    }
    if(method==="thread/queue/add"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(!Array.isArray(params.input)||!params.input.length)throw Object.assign(new Error("Queued submission input is required"),{code:-32602});
      const dynamicToolNamespaces=thread.runtime==="native"?expandableNativeToolNamespaces(params.dynamicToolNamespaces):[];
      const queue=agentQueue(state,params.threadId),queuedSubmission={id:randomUUID(),input:params.input,clientUserMessageId:String(params.clientUserMessageId||""),...(dynamicToolNamespaces.length?{dynamicToolNamespaces}:{})};
      queue.push(queuedSubmission);saveAgentQueue(state,params.threadId,queue);emit("thread/queue/changed",{threadId:params.threadId});return {queuedSubmission};
    }
    if(method==="thread/queue/update"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(!Array.isArray(params.input)||!params.input.length)throw Object.assign(new Error("Queued submission input is required"),{code:-32602});
      const queue=agentQueue(state,params.threadId),index=queue.findIndex(item=>item.id===params.queuedSubmissionId);if(index<0)throw Object.assign(new Error("Queued submission not found: "+params.queuedSubmissionId),{code:-32602});
      queue[index]={...queue[index],input:params.input};
      if(thread.runtime==="native"&&Object.prototype.hasOwnProperty.call(params,"dynamicToolNamespaces")){
        const dynamicToolNamespaces=expandableNativeToolNamespaces(params.dynamicToolNamespaces);if(dynamicToolNamespaces.length)queue[index].dynamicToolNamespaces=dynamicToolNamespaces;else delete queue[index].dynamicToolNamespaces;
      }
      saveAgentQueue(state,params.threadId,queue);emit("thread/queue/changed",{threadId:params.threadId});return {queuedSubmission:queue[index]};
    }
    if(method==="thread/queue/delete"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      const queue=agentQueue(state,params.threadId),next=queue.filter(item=>item.id!==params.queuedSubmissionId),deleted=next.length!==queue.length;
      if(deleted){saveAgentQueue(state,params.threadId,next);emit("thread/queue/changed",{threadId:params.threadId})}
      return {deleted};
    }
    if(method==="thread/queue/reorder"){
      if(!threadMetadata(params.threadId))throw new Error("Thread not found");
      const queue=agentQueue(state,params.threadId),ids=(params.queuedSubmissionIds||[]).map(String),known=new Map(queue.map(item=>[item.id,item]));
      if(ids.length!==queue.length||new Set(ids).size!==ids.length||ids.some(id=>!known.has(id)))throw Object.assign(new Error("Queued submission order must contain every queued submission exactly once"),{code:-32602});
      const next=ids.map(id=>known.get(id));saveAgentQueue(state,params.threadId,next);emit("thread/queue/changed",{threadId:params.threadId});return {};
    }
    if(method==="thread/queue/start"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.status?.type==="active")throw Object.assign(new Error("Thread already has an active or pending turn"),{code:-32602});
      const queue=agentQueue(state,params.threadId),index=params.queuedSubmissionId?queue.findIndex(item=>item.id===params.queuedSubmissionId):0;
      if(index<0||!queue[index])throw Object.assign(new Error("Queued submission not found"),{code:-32602});
      // A Native thread without a model (e.g. one migrated off a retired provider) would fail its queued turn and lose
      // the submission with its attachments and tool scope: keep it queued until the user continues with a model.
      if(thread.runtime==="native"&&!migrateRetiredNativeThread(thread).thread?.model)throw Object.assign(new Error("Choose a model for this thread before its queued follow-up can run."),{code:-32602});
      const submission=queue[index],started=await request(context,"turn/start",{threadId:params.threadId,input:submission.input,...(submission.clientUserMessageId?{clientUserMessageId:submission.clientUserMessageId}:{}),...(Array.isArray(submission.dynamicToolNamespaces)&&submission.dynamicToolNamespaces.length?{dynamicToolNamespaces:submission.dynamicToolNamespaces}:{})});
      const next=queue.filter((_,itemIndex)=>itemIndex!==index);saveAgentQueue(state,params.threadId,next);emit("thread/queue/changed",{threadId:params.threadId});return {turn:started.turn};
    }
    if(method==="thread/backgroundTerminals/list"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.runtime!=="native")throw Object.assign(new Error(`${thread.runtime||runtime} does not expose Trebell-managed background processes`),{code:-32601});
      return nativeBackgroundProcesses.list(thread.id,params);
    }
    if(method==="thread/backgroundTerminals/terminate"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.runtime!=="native")throw Object.assign(new Error(`${thread.runtime||runtime} does not expose Trebell-managed background processes`),{code:-32601});
      return {process:await nativeBackgroundProcesses.terminate(thread.id,params.processId)};
    }
    if(method==="thread/backgroundTerminals/clean"){
      const thread=threadMetadata(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.runtime!=="native")throw Object.assign(new Error(`${thread.runtime||runtime} does not expose Trebell-managed background processes`),{code:-32601});
      return await nativeBackgroundProcesses.clean(thread.id);
    }
    // Archiving is not activity: the thread keeps its last-update time, so one brought back (an undo) takes its old place by recent activity.
    if(method==="thread/archive"){endWaitingSends(params.threadId);endFailureWait(params.threadId);const live=sessions.get(params.threadId);if(live)await closeThreadSession(live,params.threadId).catch(()=>{});sessions.delete(params.threadId);const thread=threadStore.update(params.threadId,{archived:true},{touch:false});if(!thread)throw new Error("Thread not found");emit("thread/archived",{threadId:params.threadId});return {thread}}
    if(method==="thread/unarchive"){const thread=threadStore.update(params.threadId,{archived:false},{touch:false});if(!thread)throw new Error("Thread not found");emit("thread/unarchived",{threadId:params.threadId});return {thread}}
    if(method==="thread/fork"){
      const source=threadStore.get(params.threadId);if(!source)throw new Error("Thread not found");
      if(source.runtime==="native"){
        if(source.status?.type==="active")throw new Error("Stop the running Native turn before forking this thread.");
        const providerSessionId=`native_${randomUUID()}`;
        const providerMeta={...(source.providerMeta||{}),nativeFork:{sourceThreadId:source.id,sourceSessionId:source.providerSessionId||null,createdAt:Date.now()}};
        const materialized=materializeAgentFork(threadStore,source,{runtime:"native",providerSessionId,providerMeta,excludeTurns:Boolean(params.excludeTurns)});
        emit("thread/started",{thread:materialized.thread});return {thread:materialized.thread};
      }
      const runtimeSession=sessions.get(source.id)||await ensureSession(source,context,{});
      let fork,forkSource=source;
      // OpenCode gives every copied message a new ID: the forked thread's turns point at their copies, so they can still be rewound.
      if(runtimeSession instanceof OpenCodeAgentSession){const {messageIds,tailId,...forked}=await runtimeSession.fork();fork=forked;forkSource={...source,turns:remapOpenCodeTurns(source.turns,{messageIds,tailId})}}
      else if(runtimeSession instanceof ClaudeAgentSession)fork=await runtimeSession.fork();
      else{
        const init=runtimeSession.initializeResult?.agentCapabilities?.sessionCapabilities||{};if(init.fork==null)throw Object.assign(new Error(`${runtime} does not advertise session forking`),{code:-32601});
        fork=await runtimeSession.client.forkSession({sessionId:source.providerSessionId,cwd:source.cwd,mcpServers:runtimeSession.mcpServers||[]});
      }
      const providerSessionId=fork.sessionId||fork.id;
      const providerMeta={...(source.providerMeta||{}),setup:fork};
      // A Claude fork carries only its own pending fork: the source's rewind backup belongs to the source thread.
      if(runtimeSession instanceof ClaudeAgentSession){delete providerMeta.claudeFork;delete providerMeta.claudeRewindBackup;if(fork.lazyFork)providerMeta.claudeFork=fork.lazyFork}
      const materialized=materializeAgentFork(threadStore,forkSource,{runtime,providerSessionId,providerMeta,excludeTurns:Boolean(params.excludeTurns)});
      emit("thread/started",{thread:materialized.thread});return {thread:materialized.thread};
    }
    if(method==="turn/start"){
      let thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");const turnGoal=assertGoalBudget(thread.id);
      thread=migrateRetiredNativeThread(thread).thread;
      const permissionPatch=agentPermissionProfilePatch(params),requestedProvider=runtime==="native"&&params.modelProvider?normalizeProviderId(params.modelProvider):null;
      const providerPatch=requestedProvider?{modelProvider:requestedProvider}:{};
      if(Object.keys(permissionPatch).length||Object.keys(providerPatch).length)thread=threadStore.update(thread.id,{providerMeta:{...(thread.providerMeta||{}),...permissionPatch,...providerPatch}});
      if(thread.runtime==="native"&&Array.isArray(params.dynamicToolNamespaces)&&params.dynamicToolNamespaces.length)thread=(await ensureNativeToolNamespaces(thread,params.dynamicToolNamespaces)).thread;
      const session=await sessionUnlessStopped(send,ensureSession(thread,context,{model:params.model||thread.model,freshIfLost:true}));
      if(requestedProvider&&typeof session.setProvider==="function")session.setProvider(requestedProvider);
      if(runtime==="native"&&typeof session.setReasoningEffort==="function"){const providerId=requestedProvider||thread.providerMeta?.modelProvider||state?.settings?.().modelProvider||null,nextModel=params.model||thread.model||null;session.setReasoningEffort(Object.prototype.hasOwnProperty.call(params,"reasoningEffort")?params.reasoningEffort:configuredReasoningEffort(state?.settings?.()||{},"native",providerId,nextModel))}
      if(runtime==="native"&&typeof session.setServiceTier==="function"){const providerId=requestedProvider||thread.providerMeta?.modelProvider||state?.settings?.().modelProvider||null,nextModel=params.model||thread.model||null;session.setServiceTier(Object.prototype.hasOwnProperty.call(params,"serviceTier")?params.serviceTier:configuredModelServiceTier(state?.settings?.()||{},"native",providerId,nextModel))}
      if(runtime==="native"&&typeof session.setPermissionMode==="function")session.setPermissionMode((threadMetadata(thread.id)||thread)?.providerMeta?.permissionProfile||"supervised");
      // Claude Code runs each turn with the thread's permission and collaboration modes and the composer's effort and speed
      // (T3 Code's per-turn runtime policy); a changed launch policy reopens its query.
      if(session instanceof ClaudeAgentSession){
        session.setPermissionMode((threadMetadata(thread.id)||thread)?.providerMeta?.permissionProfile||"supervised");
        applyCollaborationMode(thread,session,params);
        if(Object.prototype.hasOwnProperty.call(params,"reasoningEffort"))session.setReasoningEffort(params.reasoningEffort);
        if(Object.prototype.hasOwnProperty.call(params,"serviceTier"))session.setServiceTier(params.serviceTier);
      }
      // OpenCode runs each turn with the thread's permission mode (its session rules) and the composer's reasoning level (its model's
      // variant), as T3 Code applies a turn's runtime policy and model options.
      if(session instanceof OpenCodeAgentSession){
        await session.setPermissionMode((threadMetadata(thread.id)||thread)?.providerMeta?.permissionProfile||"supervised");
        if(Object.prototype.hasOwnProperty.call(params,"reasoningEffort"))session.setReasoningEffort(params.reasoningEffort);
      }
      // ACP harnesses apply the composer's effort before the prompt (Grok's set_model _meta, Cursor's thought_level option), and
      // Cursor its Fast switch from the composer's speed and the model settings picked in the composer (context, thinking). A
      // model switch the harness refuses fails the turn with its reason and leaves the thread's model unchanged (T3).
      if(session instanceof AcpAgentSession){
        if(Object.prototype.hasOwnProperty.call(params,"reasoningEffort"))session.setReasoningEffort(params.reasoningEffort);
        if(Object.prototype.hasOwnProperty.call(params,"serviceTier"))session.setServiceTier(params.serviceTier);
        if(Object.prototype.hasOwnProperty.call(params,"modelOptions"))session.setModelOptions(params.modelOptions);
        // Cursor's Plan mode is the composer's collaboration mode (T3 interactionMode), as Claude Code's is.
        if(thread.runtime==="cursor")applyCollaborationMode(thread,session,params);
        if(params.model&&params.model!==thread.model){await session.setModel(params.model);threadStore.update(thread.id,{model:session.model||params.model})}
      }
      else if(params.model&&params.model!==thread.model){await session.setModel(params.model).catch(()=>{});threadStore.update(thread.id,{model:params.model})}
      if(runtime==="native"&&typeof session.setContextWindow==="function"){
        let contextWindow=null;
        if(typeof nativeModelContextWindow==="function")try{contextWindow=await nativeModelContextWindow({provider:requestedProvider||thread.providerMeta?.modelProvider||null,model:params.model||thread.model||null,thread:threadStore.get(thread.id)||thread})}catch(error){log("Native model context metadata unavailable: "+(error?.message||String(error)))}
        session.setContextWindow(contextWindow);
      }
      if(send?.stopped)throw stoppedBeforeTurn();
      // An earlier turn that failed and still waits on its harness's recheck ends before this one starts.
      endFailureWait(thread.id);
      const turn=threadStore.addTurn(thread.id,{inputText:textOfInput(params.input),inputFiles:fileInputs(params.input),status:"inProgress"});session.__assistant="";
      if(session instanceof NativeAgentSession)session.__liveTurnId=turn.id;
      // The stored message is the redacted one: a secret pasted into the first message never reaches the thread list.
      if(!thread.name&&!thread.preview){const stored=turn?.items?.find(item=>item?.type==="userMessage")?.content?.[0]?.text||"",preview=agentThreadTitleSeed(params.input||[],stored);if(preview)threadStore.update(thread.id,{preview})}
      session.__usage=null;
      emit("turn/started",{threadId:thread.id,turn});
      // A follow-up the queue starts tells its message as Codex does, under the client id it was queued with, so the window shows it
      // above its answer as it shows one it sent itself.
      const asked=params.clientUserMessageId?turn.items?.find(item=>item?.type==="userMessage"):null;if(asked)emit("item/completed",{threadId:thread.id,turnId:turn.id,item:{...asked,clientId:String(params.clientUserMessageId)},completedAtMs:Date.now()});
      // A fresh session that took over a lost conversation is handed the thread's earlier messages (the turn's own goes as the request).
      const input=params.input||[],durable=await withDurableContext(thread.id,params.additionalContext||{},textOfInput(input)),pending=pendingHistoryHandoff(thread.id,turn.id,{excludeTurnId:turn.id});
      const prompt=await contextualAgentPrompt(input,{...durable,...pending?.context});
      const selectedAgent=Object.prototype.hasOwnProperty.call(params,"agent")?(params.agent||null):(thread.agent||null);
      if(selectedAgent!==thread.agent)threadStore.update(thread.id,{agent:selectedAgent});
      const promptOptions={messageId:randomUUID(),agent:selectedAgent,...handoffDelivery(thread.id,turn.id,pending)};
      if(session instanceof NativeAgentSession&&Array.isArray(params.toolAllowlist)&&params.toolAllowlist.length)promptOptions.toolAllowlist=params.toolAllowlist.map(item=>String(item||"").trim()).filter(Boolean).slice(0,100);
      if(session instanceof NativeAgentSession)Object.assign(promptOptions,nativeGoalPromptOptions(turnGoal));
      // A thread deleted meanwhile has no turn left to end.
      if(send?.stopped){if(!threadStore.get(thread.id))throw stoppedBeforeTurn();return {turn:endStoppedTurn(thread.id,turn.id)}}
      settlePrompt({thread,turn,session,promptPromise:session.prompt(prompt,promptOptions),model:params.model||thread.model||null,context,resend:claudeLostSessionResend({thread,turn,session,input,durable,promptOptions,excludeTurnId:turn.id})});
      return {turn};
    }
    if(method==="turn/interrupt"){
      for(const send of waitingSends.get(String(params.threadId||""))||[])send.interrupt();
      // A turn that already failed and waits on its harness's recheck ends now, before this answers.
      endFailureWait(params.threadId);
      const target=sessions.get(params.threadId),running=target?lastTurnOf(String(params.threadId||"")):null;
      if(running?.id&&running.status==="inProgress")stoppedTurns.set(target,running.id);
      target?.cancel();
      // Stop answers a harness's waiting approvals, questions and form requests as cancelled and withdraws their cards, for Claude Code,
      // OpenCode and Trebell Native as for the ACP harnesses (T3 cancels every pending runtime request of an interrupted run). A Native
      // turn ends only once the tool it runs returns, and a tool waiting on its approval returns only once that is answered.
      cancelThreadRequests(params.threadId);
      return {ok:true};
    }
    if(method==="turn/steer"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");
      // Claude Code and OpenCode take the message into the running turn at once (T3 Code's steerTurn): Claude Code as a "now" priority
      // user message, OpenCode as a message sent into its busy session. OpenCode in a remote environment runs over ACP, which has none.
      const steerable=thread.runtime==="claude"?ClaudeAgentSession:thread.runtime==="opencode"&&!(sessions.get(thread.id) instanceof AcpAgentSession)?OpenCodeAgentSession:null;
      if(steerable){
        const label=runtimeHarnessLabel(thread.runtime);
        const activeTurn=[...(thread.turns||[])].reverse().find(turn=>turn?.status==="inProgress");if(!activeTurn)throw new Error(`${label} has no active turn to steer.`);
        if(params.expectedTurnId&&String(params.expectedTurnId)!==String(activeTurn.id))throw new Error(`The active ${label} turn changed before steering could be applied.`);
        const session=sessions.get(thread.id);if(!(session instanceof steerable))throw new Error(`The active ${label} session is unavailable for steering.`);
        const text=textOfInput(params.input||[]),result=await session.steer(await contextualAgentPrompt(params.input||[],{}));
        const item={type:"userMessage",id:`steer-${randomUUID()}`,clientId:null,content:[{type:"text",text:redactSecretText(text||"Mid-turn steering input",{environment:threadStore.env||process.env})},...fileInputs(params.input)]};
        threadStore.addItem(thread.id,activeTurn.id,item);emit("item/completed",{threadId:thread.id,turnId:activeTurn.id,item,completedAtMs:Date.now()});
        return {turnId:activeTurn.id,accepted:Boolean(result?.accepted),pending:Number(result?.pending)||0};
      }
      if(thread.runtime!=="native")throw Object.assign(new Error(`${thread.runtime||runtime} does not expose in-flight steering through ACP`),{code:-32601});
      const activeTurn=[...(thread.turns||[])].reverse().find(turn=>["inProgress","running","starting"].includes(turn?.status));if(!activeTurn)throw new Error("Trebell Native has no active turn to steer.");
      if(params.expectedTurnId&&String(params.expectedTurnId)!==String(activeTurn.id))throw new Error("The active Native turn changed before steering could be applied.");
      const session=sessions.get(thread.id);if(!(session instanceof NativeAgentSession))throw new Error("The active Native session is unavailable for steering.");
      const prompt=await contextualAgentPrompt(params.input||[],{}),result=session.steer(prompt),text=textOfInput(params.input||[]);
      const safeText=redactSecretText(text||"Mid-turn steering input",{environment:threadStore.env||process.env});
      const item={type:"userMessage",id:`steer-${randomUUID()}`,clientId:null,content:[{type:"text",text:safeText},...fileInputs(params.input)]};threadStore.addItem(thread.id,activeTurn.id,item);
      emit("item/completed",{threadId:thread.id,turnId:activeTurn.id,item,completedAtMs:Date.now()});
      journal?.record?.({runtime:"native",provider:agentProviderIdentity(thread),environmentId:thread.providerMeta?.environmentId??null,threadId:thread.id,turnId:activeTurn.id,category:"turn",name:"native.steering.requested",status:"pending",data:{messageChars:text.length}});
      return {turnId:activeTurn.id,accepted:Boolean(result?.accepted),pending:Number(result?.pending)||0};
    }
    if(method==="thread/compact/start"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");
      const session=sessions.get(thread.id)||await ensureSession(thread,context,{});
      if(session instanceof NativeAgentSession){
        if(thread.status?.type==="active")throw new Error("Stop the running turn before compacting Native context.");
        const turns=Array.isArray(thread.turns)?thread.turns:[];if(!turns.length)throw new Error("There is no Native conversation history to compact yet.");
        const retainTurnCount=Math.min(2,Math.max(0,turns.length-1)),throughIndex=turns.length-retainTurnCount-1,throughTurn=turns[throughIndex];
        const retainedTurns=retainTurnCount?turns.slice(throughIndex+1):[],recentMessages=retainTurnCount?nativeMessagesFromThread(thread,{afterTurnId:throughTurn.id}):[];
        const deterministicContext=continuityContextValue(durableContinuity(thread.id));
        const result=await session.compact({maxOutputTokens:params.maxOutputTokens||4096,recentMessages,deterministicContext});
        const compaction={id:`native-compact-${randomUUID()}`,summary:result.summary,throughTurnId:throughTurn.id,retainedTurnIds:retainedTurns.map(item=>item.id),createdAt:Date.now(),model:result.model||thread.model||null,provider:result.provider||thread.providerMeta?.modelProvider||null,sourceMessageCount:result.sourceMessageCount||0,retainedRecentMessageCount:result.retainedRecentMessageCount||0,continuityChars:result.continuityChars||0};
        const current=threadMetadata(thread.id)||thread;threadStore.update(thread.id,{providerMeta:{...(current.providerMeta||{}),nativeCompaction:compaction}});
        if(result.usage)state?.recordUsage?.({id:`native:${thread.id}:compaction:${compaction.id}`,runtime:"native",provider:compaction.provider,model:compaction.model,environmentId:current.providerMeta?.environmentId??null,threadId:thread.id,turnId:`compaction:${compaction.id}`,usage:result.usage,at:compaction.createdAt});
        journal?.record?.({runtime:"native",provider:compaction.provider,environmentId:current.providerMeta?.environmentId??null,threadId:thread.id,category:"context",name:"native.compaction.completed",status:"completed",data:{compactionId:compaction.id,throughTurnId:compaction.throughTurnId,retainedTurnIds:compaction.retainedTurnIds,sourceMessageCount:compaction.sourceMessageCount,retainedRecentMessageCount:compaction.retainedRecentMessageCount,continuityChars:compaction.continuityChars,summaryChars:compaction.summary.length}});
        emit("thread/compacted",{threadId:thread.id,compaction:{id:compaction.id,throughTurnId:compaction.throughTurnId,createdAt:compaction.createdAt}});return {ok:true,compaction};
      }
      if(session instanceof OpenCodeAgentSession||session instanceof ClaudeAgentSession){await session.compact();emit("thread/compacted",{threadId:thread.id});return {ok:true}}
      // Grok compacts with its own /compact command, run as a turn (T3 compactThread); a completed one adds the compaction item.
      // OpenCode in a remote environment runs on its ACP server, which answers /compact by summarizing the session, as the
      // local OpenCode server's compaction does (T3's OpenCode compactThread also sends /compact).
      if(session instanceof AcpAgentSession&&(thread.runtime==="grok"||thread.runtime==="opencode")){
        const label=session.label||runtimeHarnessLabel(thread.runtime);
        if(thread.status?.type==="active"||session.busy)throw new Error(`Stop the running ${label} turn before compacting its context.`);
        const turn=threadStore.addTurn(thread.id,{inputText:"/compact",status:"inProgress"});session.__assistant="";session.__usage=null;
        emit("turn/started",{threadId:thread.id,turn});
        const promptPromise=session.prompt([{type:"text",text:"/compact"}],{messageId:randomUUID()}).then(result=>{
          if(result?.stopReason==="cancelled"||result?.stopReason==="refusal"){
            emit("error",{threadId:thread.id,turnId:turn.id,message:result.stopReason==="cancelled"?`${label}'s context compaction was stopped before it finished.`:`${label} declined to compact its context.`});
            return result;
          }
          const item={type:"contextCompaction",id:`compaction-${turn.id}`,status:"completed"};
          threadStore.addItem(thread.id,turn.id,item);emit("item/completed",{threadId:thread.id,turnId:turn.id,item,completedAtMs:Date.now()});
          emit("thread/compacted",{threadId:thread.id,turnId:turn.id});
          return result;
        });
        settlePrompt({thread,turn,session,promptPromise,model:thread.model||null,context});
        return {ok:true,turn};
      }
      throw Object.assign(new Error(`${runtime} does not expose a generic compaction RPC`),{code:-32601});
    }
    if(method==="thread/revert"){
      const thread=threadStore.get(params.threadId);if(!thread)throw new Error("Thread not found");
      if(thread.runtime==="native"){
        if(thread.status?.type==="active")throw new Error("Stop the running Native turn before rewinding this thread.");
        const index=thread.turns.findIndex(item=>item.id===params.beforeTurnId);if(index<0)throw new Error("Native rewind target turn was not found.");
        const retained=thread.turns.slice(0,index),currentMeta={...(thread.providerMeta||{})};
        if(currentMeta.nativeCompaction&&!retained.some(turn=>String(turn.id)===String(currentMeta.nativeCompaction.throughTurnId)))delete currentMeta.nativeCompaction;
        const session=sessions.get(thread.id);if(session)await session.close().catch(()=>{});sessions.delete(thread.id);
        const updated=threadStore.update(thread.id,{turns:retained,status:{type:"idle"},providerMeta:currentMeta});emit("thread/reverted",{threadId:thread.id,thread:updated});return {thread:updated};
      }
      // ACP defines no conversation truncation, so Grok, Antigravity and a remote OpenCode (its ACP server) revert the way T3's
      // ACP rollbackThread does: the thread is cut before the turn and its next turn starts a fresh session. Files come back
      // through the checkpoint restore the app offers before this call.
      if(acpRestartsOnRevert(thread)){
        const live=sessions.get(thread.id),label=runtimeHarnessLabel(thread.runtime);
        if(thread.status?.type==="active"||live?.busy)throw new Error(`Stop the running ${label} turn before reverting this thread.`);
        const index=(thread.turns||[]).findIndex(item=>item.id===params.beforeTurnId);if(index<0)throw new Error(`${label} revert target turn was not found.`);
        if(live){sessions.delete(thread.id);await releaseSession(live)}
        const updated=threadStore.update(thread.id,{turns:thread.turns.slice(0,index),providerSessionId:"",status:{type:"idle"}});
        emit("thread/reverted",{threadId:thread.id,thread:updated});return {thread:updated};
      }
      const session=sessions.get(thread.id)||await ensureSession(thread,context,{});
      if(session instanceof OpenCodeAgentSession){
        const turn=thread.turns?.find(item=>item.id===params.beforeTurnId);const providerMessageId=turn?.providerMessageId||turn?.items?.find(item=>item.providerMessageId)?.providerMessageId;if(!providerMessageId)throw new Error("This OpenCode turn does not have a provider message checkpoint yet");
        // The thread continues in OpenCode's copy of the conversation before this turn; files stay as they are (T3 Code's rollbackThread).
        const rewound=await session.rewind(providerMessageId);const index=thread.turns.findIndex(item=>item.id===params.beforeTurnId),retained=index>=0?thread.turns.slice(0,index):thread.turns;
        const providerMeta=revertedHistoryHandoff(threadMetadata(thread.id)?.providerMeta||thread.providerMeta,retained,{sessionId:rewound.sessionId});
        threadStore.update(thread.id,{providerSessionId:rewound.sessionId,turns:remapOpenCodeTurns(retained,rewound),providerMeta});emit("thread/reverted",{threadId:thread.id});return {thread:threadStore.get(thread.id)};
      }
      if(session instanceof ClaudeAgentSession){
        const current={...thread,providerMeta:threadMetadata(thread.id)?.providerMeta||thread.providerMeta},{index,providerMessageId}=claudeRewindCheckpoint(current,params.beforeTurnId);
        const forked=await session.rewindConversation(providerMessageId);
        // A cursor is a turn of the conversation Claude Code holds now, so the fork keeps whatever it was handed over.
        const providerMeta=revertedHistoryHandoff(claudeRewindProviderMeta(current,index,forked),thread.turns.slice(0,index),{sessionId:forked.sessionId,holdsHandoff:Boolean(providerMessageId)});
        threadStore.update(thread.id,{providerSessionId:forked.sessionId,turns:thread.turns.slice(0,index),providerMeta});
        emit("thread/reverted",{threadId:thread.id});return {thread:threadStore.get(thread.id)};
      }
      throw Object.assign(new Error(`${runtime} does not expose conversation rewind`),{code:-32601});
    }
    if(method==="review/start"){
      return request(context,"turn/start",{threadId:params.threadId,input:[{type:"text",text:"Review the current workspace changes. Focus on correctness, regressions, security and missing tests. Return actionable findings."}]});
    }
    // Claude Code's and Cursor's Plan mode (T3's interaction mode; Cursor runs a Plan turn in its plan mode).
    if(method==="collaborationMode/list")return {data:runtime==="claude"||runtime==="cursor"?[{mode:"default",name:"Default"},{mode:"plan",name:"Plan"}]:[]};
    throw Object.assign(new Error(`Unsupported external-agent RPC method: ${method}`),{code:-32601});
  }

  const upgrade=(req,socket,head)=>{
    const url=new URL(req.url||"/","http://127.0.0.1");if(url.pathname!==path)return;
    wss.handleUpgrade(req,socket,head,ws=>{
      const context={
        ws,
        // Asked of this window, or of the newest one open once this one has gone (pendingServer).
        serverRequest(method,params,owner=params?.threadId){
          const id=`agent-${nextServerId++}`,holder=openContext(context);
          return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{pendingServer.delete(id);reject(new Error(`${method} user response timed out`))},5*60_000);
            pendingServer.set(id,{resolve,reject,timer,method,params,threadId:owner?String(owner):null,holder});
            holder?.ws.send(JSON.stringify({id,method,params}));
          });
        },
        async permission(thread,{params,options,askUser=false,approvalOptions=null}){
          const current=threadStore.get(thread.id)||thread,turnId=current?.turns?.at(-1)?.id||null,traceData=agentPermissionTraceData({toolCall:params.toolCall,options});
          const traceBase={runtime:current?.runtime||runtimeManager.activeRuntime(),provider:agentProviderIdentity(current),environmentId:current?.providerMeta?.environmentId??state?.settings?.().activeEnvironmentId??null,threadId:thread.id,turnId,category:"policy"};
          journal?.record?.({...traceBase,name:"permission.requested",status:"pending",data:traceData});
          const policy=agentPermissionPolicyDecision(current,{params,options},state?.settings?.()||{});
          const policyData={
            decision:policy.decision,reason:policy.reason,profile:policy.profile,action:policy.action.action,kind:policy.action.kind,
            riskLevel:policy.action.riskLevel,reversibility:policy.action.reversibility,idempotent:policy.action.idempotent,
            externalSideEffect:policy.action.externalSideEffect,pathInsideWorkspace:policy.action.pathInsideWorkspace,
            networkHost:policy.action.networkHost||null,provenance:policy.action.provenance,
          };
          journal?.record?.({...traceBase,name:"policy.decision",status:policy.decision.toLowerCase(),data:policyData});
          // Grok's Auto mode has already decided what it could itself: what it still asks about goes to the user (T3), never auto-allowed.
          if(policy.decision===POLICY_ALLOW&&!askUser){
            journal?.record?.({...traceBase,name:"permission.resolved",status:"accept",data:{...traceData,decision:"accept",policyDecision:policy.decision}});
            return "accept";
          }
          if(policy.decision===POLICY_REJECT){
            journal?.record?.({...traceBase,name:"permission.resolved",status:"decline",data:{...traceData,decision:"decline",policyDecision:policy.decision}});
            return "decline";
          }
          try{
            // An ACP harness's own choices (approvalOptions) are shown as the card's buttons; each answers with its decision.
            const result=await context.serverRequest("item/tool/requestApproval",{threadId:thread.id,reason:agentApprovalReason(params),toolCall:params.toolCall,options,...(Array.isArray(approvalOptions)&&approvalOptions.length?{approvalOptions}:{})}),decision=result?.decision||"decline";
            journal?.record?.({...traceBase,name:"permission.resolved",status:decision,data:{...traceData,decision,policyDecision:POLICY_CONFIRM}});return decision;
          }catch(error){
            journal?.record?.({...traceBase,name:"permission.resolved",status:"error",data:{...traceData,message:error?.message||String(error)}});throw error;
          }
        },
        async userQuestion(thread,{input}){
          const questions=(input?.questions||[]).map((question,index)=>({
            id:String(question.id||`q${index+1}`),
            header:String(question.header||question.question||`Question ${index+1}`),
            question:String(question.question||question.header||"Provide input"),
            required:true,
            allowMultiple:Boolean(question.multiSelect||question.allowMultiple),
            // A question only its own choices answer (Antigravity's) says so, and a choice with a value (its option id) answers with it;
            // without the flag the person's own words answer too.
            ...(question.allowCustomAnswer===false?{allowCustomAnswer:false}:{}),
            options:(question.options||[]).map(option=>typeof option==="string"?{label:option,description:""}:{label:String(option.label||option.value||""),description:String(option.description||""),...(option.value!=null&&String(option.value)!==""?{value:String(option.value)}:{})}),
          }));
          if(!questions.length)return {};
          const result=await context.serverRequest("item/tool/requestUserInput",{threadId:thread.id,questions});
          const answers={};for(const [id,value] of Object.entries(result?.answers||{}))answers[id]=Array.isArray(value?.answers)?value.answers:value;
          return answers;
        },
        async elicitation(thread,{params}){
          const mode=String(params?.mode||"form");
          if(!["form","url"].includes(mode))return {action:"cancel"};
          return context.serverRequest("mcpServer/elicitation/request",{
            ...params,
            mode,
            serverName:thread.runtime==="opencode"?"OpenCode":thread.runtime==="cursor"?"Cursor":thread.runtime==="grok"?"Grok Build":thread.runtime==="antigravity"?"Antigravity":"ACP agent",
            _meta:{...(params?._meta||{}),trebell_source:"acp",trebell_runtime:thread.runtime},
          },thread.id);
        },
      };
      socketContexts.add(context);
      ws.on("message",async raw=>{
        let message;try{message=JSON.parse(String(raw))}catch{return}
        if(Object.prototype.hasOwnProperty.call(message,"id")&&!message.method&&typeof message.id==="string"&&pendingServer.has(message.id)){
          const pending=pendingServer.get(message.id);if(pending.holder!==context)return;pendingServer.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error(message.error.message||"Request declined")):pending.resolve(message.result);return;
        }
        if(!message.method)return;
        if(!Object.prototype.hasOwnProperty.call(message,"id")){
          if(message.method==="initialized"){askAgain(context);recoverPending(context).catch(error=>log(error?.stack||String(error)))}
          return;
        }
        try{
          // Only the person's own turns are checked: Trebell's continuations of a thread (queues, goals, recovery) run on its owner.
          if(message.method==="turn/start"){const ownerError=agentTurnOwnerError(threadStore.get(message.params?.threadId),runtimeManager.activeRuntime());if(ownerError)throw ownerError}
          const result=await request(context,message.method,message.params||{});ws.send(JSON.stringify({id:message.id,result}))}
        catch(error){log(error?.stack||String(error));ws.send(JSON.stringify({id:message.id,error:{code:Number(error?.code)||-32000,message:error instanceof Error?error.message:String(error)}}))}
      });
      // An app tool call this window was given may have run already (a click, typed text, a delegated task), so it is refused rather
      // than asked of another window, which would run it a second time: the model is told the window closed before it answered.
      // Approvals, questions and forms change nothing until answered, so they wait for the next window.
      ws.on("close",()=>{
        socketContexts.delete(context);
        for(const [id,pending] of [...pendingServer]){
          if(pending.holder!==context)continue;
          if(pending.method==="item/tool/call"){pendingServer.delete(id);clearTimeout(pending.timer);pending.reject(new Error("The Trebell window running this tool closed before it answered, so the tool may or may not have run."));continue}
          pending.holder=null;
        }
        askAgain(openContext(null));
      });
    });
  };
  server.on("upgrade",upgrade);
  async function closeSessions(){
    sessionGeneration++;for(const wake of resetWaits)wake();
    for(const runtime of [...startingSessions])await runtime.close().catch(()=>{});
    for(const [threadId,session] of sessions)await closeSession(session,threadId).catch(()=>{});sessions.clear();
    if(sessionReleases.size)await Promise.allSettled([...sessionReleases]);
    if(promptSettlements.size)await Promise.allSettled([...promptSettlements]);
    for(const threadId of [...toolWrites.keys()])settleToolWrites(threadId);
  }
  return {reset:closeSessions,close:async()=>{
    closing=true;stopModelUpdates();clearInterval(sessionSweep);sessionSweep=null;
    server.off("upgrade",upgrade);
    for(const context of socketContexts){try{context.ws.terminate()}catch{}}
    socketContexts.clear();
    for(const pending of pendingServer.values()){clearTimeout(pending.timer);pending.reject(new Error("The relay closed"))}pendingServer.clear();
    for(const client of wss.clients){try{client.terminate()}catch{}}
    await closeSessions();await nativeBackgroundProcesses.closeAll();
    try{wss.close()}catch{}
  }};
}
