import React,{lazy,Suspense,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {
  Check, ChevronDown, CircleStop, Code2, Cpu, FileCode2, FileDiff, FolderCode,
  GitBranch, Globe2, HardDrive, Link2, ListTodo, MemoryStick, Network, Paperclip, Plus, Send,
  ShieldCheck, Sparkles, SquareTerminal, WandSparkles, X, Zap, Coins, Mic, Camera, History,
  PanelRight, PanelBottom, PanelLeftOpen, Command, Target, Play, Search
} from "lucide-react";
import { CodexRpcClient } from "./rpc.js";
import { api } from "./api.js";
import ThreadSidebar from "./components/ThreadSidebar.jsx";
import QuestionModal from "./components/QuestionModal.jsx";
import McpElicitationModal from "./components/McpElicitationModal.jsx";
import AssistantSelectionToolbar from "./components/AssistantSelectionToolbar.jsx";
import SnoozeDialog from "./components/SnoozeDialog.jsx";
import RightPanel from "./components/RightPanel.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import AgentBackgroundTerminals from "./components/AgentBackgroundTerminals.jsx";
import { contextCompactionSignal } from "./provider-session-status.js";
import OnboardingModal from "./components/OnboardingModal.jsx";
import OpenInPicker from "./components/OpenInPicker.jsx";
import WorktreeSetupCard from "./components/WorktreeSetupCard.jsx";
import { resolveKeybinding } from "./keybindings.js";
import { isVideoAttachment, restoreQueuedDraft } from "./composer-state.js";
import { applyFileMention, fileMentionAt, rankFileMentions } from "./composer-mentions.js";
import { mergeNativeQueue, nativeQueueUnavailable, queuedSubmissionDraft, reorderQueue } from "./native-queue.js";
import { historyFromItemEntries, historyFromTurns, mergeHistoryMessages } from "./thread-history.js";
import { normalizeCustomTheme, themeCssVariables } from "./theme-utils.js";
import { approvalResponse } from "./approval-utils.js";
import { fanoutWorkspaceError, nextModelSelection, threadForWorktree } from "./fanout-utils.js";
import { matchingMessageExcerpt, matchingPullRequestExcerpt } from "./thread-message-search.js";
import { parseVisualizationMessage, visualizationUrl } from "./visualization-utils.js";
import { captureThreadScrollPosition, rememberThreadScrollPosition, restoredThreadScrollTop } from "./thread-scroll.js";
import { DEFAULT_LAYOUT, clampLayoutValue, normalizeLayoutPreferences } from "./layout-preferences.js";
import { nativeThreadSearchMatches, threadListParams } from "./thread-list-query.js";
import { resizeTextarea } from "./textarea-size.js";
import { guardianActionSummary, guardianDeniedEvent } from "./guardian-review.js";
import { collaborationModePayload, normalizeCollaborationModes } from "./collaboration-mode.js";
import { ensureCodexProject, sameWorkspacePath } from "./codex-projects.js";
import { writeClipboardText } from "./clipboard.js";

const TerminalPanel=lazy(()=>import("./components/TerminalPanel.jsx"));
const WorkspacePanel=lazy(()=>import("./components/WorkspacePanel.jsx"));
const SourceControlPanel=lazy(()=>import("./components/SourceControlPanel.jsx"));
const ProjectsPage=lazy(()=>import("./components/ProjectsPage.jsx"));
const AgentsPage=lazy(()=>import("./components/AgentsPage.jsx"));
const PreviewPage=lazy(()=>import("./components/PreviewPage.jsx"));
const SettingsPage=lazy(()=>import("./components/SettingsPage.jsx"));
const FreebuffPage=lazy(()=>import("./components/FreebuffPage.jsx"));
const HarnessToolsPage=lazy(()=>import("./components/HarnessToolsPage.jsx"));
const EnvironmentsPage=lazy(()=>import("./components/EnvironmentsPage.jsx"));
const GoalPanel=lazy(()=>import("./components/GoalPanel.jsx"));
const DevicePanel=lazy(()=>import("./components/DevicePanel.jsx"));
const UsagePage=lazy(()=>import("./components/UsagePage.jsx"));
const LicensesPage=lazy(()=>import("./components/LicensesPage.jsx"));

function DeferredSurface({children,label="Loading…",compact=false}){
  return <Suspense fallback={<div className={"surface-loading"+(compact?" compact":"")} role="status">{label}</div>}>{children}</Suspense>;
}

const MAX_COMPOSER_ATTACHMENTS=100;
const MAX_COMPOSER_CHARS=120_000;
const CODEX_HISTORY_ITEM_PAGE_LIMIT=100;
const CODEX_HISTORY_ITEM_SCAN_PAGES=4;
const CODEX_HISTORY_TURN_PAGE_LIMIT=40;

function visibleHistoryEntry(entry){
  const item=entry?.item;
  return item?.type==="userMessage"||item?.type==="agentMessage";
}

async function loadCodexItemHistoryPage(rpc,threadId,cursor){
  let nextCursor=cursor||null,backwardsCursor=null;const data=[];
  for(let pageIndex=0;nextCursor&&pageIndex<CODEX_HISTORY_ITEM_SCAN_PAGES;pageIndex++){
    const page=await rpc.request("thread/items/list",{threadId,cursor:nextCursor,limit:CODEX_HISTORY_ITEM_PAGE_LIMIT,sortDirection:"desc"});
    if(pageIndex===0)backwardsCursor=page?.backwardsCursor||null;
    data.push(...(page?.data||[]));nextCursor=page?.nextCursor||null;
    if(data.some(visibleHistoryEntry)||!nextCursor)break;
  }
  return {data,nextCursor,backwardsCursor};
}

async function resumeCodexWithBoundedHistory(rpc,params){
  try{
    const resumed=await rpc.request("thread/resume",{...params,excludeTurns:true});
    const itemCursor=resumed?.itemsBackwardsCursor||null;
    if(itemCursor){
      try{return {...resumed,__trebellHistoryPage:{kind:"items",...await loadCodexItemHistoryPage(rpc,params.threadId,itemCursor)}}}catch{}
    }
    const turnCursor=resumed?.turnsBackwardsCursor||null;
    if(turnCursor){
      try{
        const page=await rpc.request("thread/turns/list",{threadId:params.threadId,cursor:turnCursor,limit:CODEX_HISTORY_TURN_PAGE_LIMIT,sortDirection:"desc",itemsView:"full"});
        return {...resumed,__trebellHistoryPage:{kind:"turns",...(page||{})}};
      }catch{}
    }
    if(resumed?.thread?.historyMode==="paginated")return {...resumed,__trebellHistoryPage:{kind:"items",data:[],nextCursor:null,backwardsCursor:null}};
  }catch{}
  return rpc.request("thread/resume",{...params,excludeTurns:false}).then(result=>({...result,__trebellFullHistoryFallback:true}));
}

const TREBELL_BROWSER_TOOLS=[{
  type:"namespace",
  name:"trebell_browser",
  description:"Control Trebell Code's isolated desktop browser session for web research and testing.",
  tools:[
    {type:"function",name:"open",description:"Navigate the Trebell browser to a URL.",inputSchema:{type:"object",properties:{url:{type:"string"}},required:["url"],additionalProperties:false}},
    {type:"function",name:"snapshot",description:"Inspect current page text and interactive elements. Returns refs for click/type.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
    {type:"function",name:"click",description:"Click an element from the latest snapshot by ref.",inputSchema:{type:"object",properties:{ref:{type:"string"}},required:["ref"],additionalProperties:false}},
    {type:"function",name:"type",description:"Set text in an input or editable element from the latest snapshot.",inputSchema:{type:"object",properties:{ref:{type:"string"},text:{type:"string"}},required:["ref","text"],additionalProperties:false}},
    {type:"function",name:"screenshot",description:"Capture the current page as an image visible to the model.",inputSchema:{type:"object",properties:{},additionalProperties:false}}
  ]
}];

const TREBELL_COMPUTER_TOOLS=[{
  type:"namespace",
  name:"trebell_computer",
  description:"Control the Windows desktop on the primary display. Screenshot is always available; mouse and keyboard input require Trebell Full access mode.",
  tools:[
    {type:"function",name:"screenshot",description:"Capture the primary desktop and return it to the model with coordinate metadata.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
    {type:"function",name:"move",description:"Move the mouse to screenshot pixel coordinates.",inputSchema:{type:"object",properties:{x:{type:"integer"},y:{type:"integer"}},required:["x","y"],additionalProperties:false}},
    {type:"function",name:"click",description:"Click at screenshot pixel coordinates.",inputSchema:{type:"object",properties:{x:{type:"integer"},y:{type:"integer"},button:{type:"string",enum:["left","right","middle"]},count:{type:"integer",minimum:1,maximum:3}},required:["x","y"],additionalProperties:false}},
    {type:"function",name:"scroll",description:"Scroll at the current pointer position. Positive delta scrolls up; negative scrolls down.",inputSchema:{type:"object",properties:{delta:{type:"integer"}},required:["delta"],additionalProperties:false}},
    {type:"function",name:"type",description:"Type text into the focused desktop application.",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}},
    {type:"function",name:"key",description:"Send a supported key or shortcut such as ENTER, TAB, ESC, CTRL+A, CTRL+C, CTRL+V, ALT+TAB, UP, DOWN, LEFT, RIGHT.",inputSchema:{type:"object",properties:{key:{type:"string"}},required:["key"],additionalProperties:false}}
  ]
}];

const TREBELL_DEVICE_TOOLS=[{
  type:"namespace",
  name:"trebell_device",
  description:"Inspect and control local Android emulators or iOS simulators exposed by Trebell Code. Physical phones are never controlled by these tools.",
  tools:[
    {type:"function",name:"list",description:"List available Android emulators and iOS simulators.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
    {type:"function",name:"screenshot",description:"Capture a simulator screen as an image.",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}},
    {type:"function",name:"tap",description:"Tap simulator pixel coordinates from the latest screenshot.",inputSchema:{type:"object",properties:{id:{type:"string"},x:{type:"number"},y:{type:"number"}},required:["id","x","y"],additionalProperties:false}},
    {type:"function",name:"type",description:"Type text into the focused Android emulator control.",inputSchema:{type:"object",properties:{id:{type:"string"},text:{type:"string"}},required:["id","text"],additionalProperties:false}},
    {type:"function",name:"key",description:"Send Android emulator Back, Home, Recents, or Enter.",inputSchema:{type:"object",properties:{id:{type:"string"},key:{type:"string",enum:["back","home","recents","enter"]}},required:["id","key"],additionalProperties:false}},
    {type:"function",name:"foreground",description:"Read the foreground Android emulator app/activity.",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}}
  ]
}];
const TREBELL_SOURCE_CONTROL_TOOLS=[{
  type:"namespace",
  name:"trebell_source_control",
  description:"Link hosted pull requests to the current Trebell thread.",
  tools:[
    {type:"function",name:"link_pull_request",description:"Link a pull request URL to the current thread so Trebell can track its review state and native stack.",inputSchema:{type:"object",properties:{url:{type:"string"}},required:["url"],additionalProperties:false}}
  ]
}];

function titleOf(thread){return thread?.name||thread?.preview||"New Trebell task"}
function modelLabel(id,freebuff){
  const clean=String(id||"").replace(/^freebuff\//,"");
  const p=freebuff?.derived?.priceByModel?.[id]||(freebuff?.derived?.selectedModel===id?freebuff?.derived?.selectedPrice:null);
  if(p?.dynamic)return clean+" · dynamic";
  if(typeof p?.current==="number")return clean+" · "+p.current+" FB/h"+(p.offPeakActive?" off-peak":"");
  return clean;
}
function compactModelLabel(id,freebuff){
  const full=modelLabel(id,freebuff);const [qualified,...detail]=full.split(" · ");
  const short=qualified.includes("/")?qualified.split("/").filter(Boolean).pop():qualified;
  return [short,...detail].filter(Boolean).join(" · ");
}
function attachmentDisplayName(path){
  const name=String(path||"").split(/[\\/]/).pop()||"attachment";
  return name.replace(/^\d{10,}-[0-9a-f]{8}-(?=.)/i,"");
}
function historyFromThread(thread,checkpointByTurn={}){
  return historyFromTurns(thread?.turns||[],checkpointByTurn);
}
function normalizeItem(item={}){
  const type=item.type||"tool";
  let title=item.title||item.name||item.description||"Agent activity";
  if(type==="plan")title="Plan";
  if(type==="commandExecution")title=Array.isArray(item.command)?item.command.join(" "):(item.command||"Running command");
  if(type==="fileChange")title="Editing files";
  if(type==="mcpToolCall")title=(item.server?item.server+" / ":"")+(item.tool||item.name||"MCP tool");
  if(type==="dynamicToolCall")title=(item.namespace?item.namespace+" / ":"")+(item.tool||"Dynamic tool");
  if(type==="collabAgentToolCall")title="Collaboration · "+String(item.tool||"agent task").replace(/([a-z])([A-Z])/g,"$1 $2").toLowerCase();
  if(type==="subAgentActivity")title="Subagent · "+(item.kind||"activity");
  if(type==="webSearch")title=item.query||"Searching the web";
  if(type==="reasoning")title="Reasoning";
  if(type==="imageView")title="Viewing image";
  if(type==="imageGeneration")title="Generating image";
  if(type==="contextCompaction")title="Compacting context";
  if(type==="enteredReviewMode")title="Reviewing changes";
  if(type==="exitedReviewMode")title="Finished review";
  return {id:item.id||crypto.randomUUID(),kind:type,title:String(title).split("\n")[0].slice(0,160),status:item.status==="completed"?"done":item.status||"running",raw:item,output:""};
}
function presetFor(mode){
  if(mode==="full")return {sandbox:"danger-full-access",approvalPolicy:"never"};
  if(mode==="read-only")return {sandbox:"read-only",approvalPolicy:"on-request"};
  if(mode==="auto")return {sandbox:"workspace-write",approvalPolicy:"untrusted"};
  if(mode==="edits")return {sandbox:"workspace-write",approvalPolicy:"on-request"};
  return {sandbox:"workspace-write",approvalPolicy:"on-request"};
}
function pullRequestIdentity(pr){
  const identity=pr?.identity;
  if(identity?.host&&identity?.repository&&identity?.number)return [String(identity.host).toLowerCase(),String(identity.repository).toLowerCase(),Number(identity.number)].join("|");
  try{
    const url=new URL(pr?.url||"");
    const path=url.pathname.replace(/\/+$/,"").toLowerCase();
    return JSON.stringify([String(pr?.provider||"").toLowerCase(),url.hostname.toLowerCase(),path,Number(pr?.number)||0]);
  }catch{return JSON.stringify([String(pr?.provider||"").toLowerCase(),String(pr?.url||""),Number(pr?.number)||0])}
}
function tokenLabel(tokenUsage,price=null){
  const total=tokenUsage?.total?.totalTokens;
  const contextTokens=tokenUsage?.last?.inputTokens;
  const windowSize=tokenUsage?.modelContextWindow;
  const actual=Number(tokenUsage?.cost?.amount);
  let cost=Number.isFinite(actual)?actual:null;
  if(cost==null&&price){
    const usage=tokenUsage?.total||{};
    const input=Number(usage.inputTokens||0),output=Number(usage.outputTokens||0),cacheRead=Number(usage.cachedInputTokens||0),cacheWrite=Number(usage.cacheWriteInputTokens||0);
    const inputRate=price.inputPrice==null?null:Number(price.inputPrice),outputRate=price.outputPrice==null?null:Number(price.outputPrice);
    if(Number.isFinite(inputRate)||Number.isFinite(outputRate))cost=(input*(Number.isFinite(inputRate)?inputRate:0)+output*(Number.isFinite(outputRate)?outputRate:0)+cacheRead*(Number.isFinite(Number(price.cacheReadPrice))?Number(price.cacheReadPrice):(Number.isFinite(inputRate)?inputRate:0))+cacheWrite*(Number.isFinite(Number(price.cacheWritePrice))?Number(price.cacheWritePrice):(Number.isFinite(inputRate)?inputRate:0)))/1_000_000;
  }
  const suffix=cost!=null?` · $${cost<0.01?cost.toFixed(4):cost.toFixed(2)}`:"";
  if(total==null)return "Context —";
  if(windowSize&&contextTokens!=null)return "Context "+Math.round(contextTokens/windowSize*100)+"% · "+contextTokens.toLocaleString()+" input · "+total.toLocaleString()+" total"+suffix;
  return "Tokens "+total.toLocaleString()+suffix;
}

function EventIcon({event}){
  if(event.status==="done")return <Check size={13}/>;
  if(event.kind==="commandExecution")return <SquareTerminal size={13}/>;
  if(event.kind==="fileChange")return <FileDiff size={13}/>;
  if(event.kind==="plan")return <ListTodo size={13}/>;
  if(event.kind==="mcpToolCall")return <Zap size={13}/>;
  return <Sparkles size={13}/>;
}
function ActivityTimeline({events,assistantText,onOpenPanel}){
  if(!events.length&&!assistantText)return null;
  return <div className="agent-block"><div className="agent-heading"><div className="agent-star"><Sparkles size={16}/></div><span>Trebell agent activity</span></div><div className="timeline">
    {events.map(event=><details className={"tool-event status-"+event.status} key={event.id}><summary><span className="timeline-marker"><EventIcon event={event}/></span><strong>{event.title}</strong><em>{event.status}</em></summary>
      <div className="tool-event-body">{event.raw?.command&&<pre>{Array.isArray(event.raw.command)?event.raw.command.join(" "):event.raw.command}</pre>}{event.output&&<pre>{event.output}</pre>}{event.raw?.changes&&<button onClick={()=>onOpenPanel("workspace")}><FileDiff size={12}/> Inspect changes</button>}<pre className="tool-json">{event.kind==="reasoning"?"Reasoning activity":JSON.stringify(event.raw,null,2)}</pre></div>
    </details>)}
  </div>{assistantText&&<div className="assistant-answer">{assistantText}</div>}</div>;
}
function ThreadFindBar({state,inputRef,onQuery,onPrevious,onNext,onClose}){
  if(!state.open)return null;
  const current=state.index>=0?state.results[state.index]:null;
  const range=current?.snippetMatchRange||{};const start=Math.max(0,Number(range.start)||0),end=Math.max(start,Number(range.end)||0);
  const snippet=String(current?.snippet||"");
  return <div className="thread-find-bar" data-testid="thread-find-bar">
    <Search size={13}/><input ref={inputRef} data-testid="thread-find-input" value={state.query} onChange={event=>onQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();onClose()}else if(event.key==="Enter"){event.preventDefault();event.shiftKey?onPrevious():onNext()}}} placeholder="Find in this thread"/>
    <span className="thread-find-count">{state.loading?"Searching…":state.error?"Error":state.results.length?`${state.index+1} / ${state.results.length}${state.nextCursor?"+":""}`:state.query.trim().length>=2?"No matches":""}</span>
    <button type="button" onClick={onPrevious} disabled={state.loading||state.index<=0} aria-label="Previous match">↑</button><button type="button" onClick={onNext} disabled={state.loading||(!state.results.length)||(state.index>=state.results.length-1&&!state.nextCursor)} aria-label="Next match">↓</button><button type="button" onClick={onClose} aria-label="Close find">×</button>
    {(current||state.error)&&<div className="thread-find-snippet">{state.error?state.error:<>{snippet.slice(0,start)}<mark>{snippet.slice(start,end)}</mark>{snippet.slice(end)}</>}</div>}
  </div>;
}

function Conversation({messages,onEditFromHere,onCite,allowRevert=true,projectPath,environmentId,threadId,canLoadEarlier=false,loadingEarlier=false,onLoadEarlier,activeFindItemId=null}){
  const historyRef=useRef(null);
  return <div className="conversation-history" ref={historyRef}>{canLoadEarlier&&<div className="history-page-control"><button type="button" disabled={loadingEarlier} onClick={onLoadEarlier}>{loadingEarlier?"Loading earlier messages…":"Load earlier messages"}</button></div>}{messages.map(m=>{
    const activeFind=String(m.id)===String(activeFindItemId||"");
    if(m.role==="user")return <div className={"user-row"+(activeFind?" find-active":"")} data-message-id={m.id} key={m.id}><div className="user-bubble"><p>{m.text}</p>{allowRevert&&m.turnId&&<button className="message-action" onClick={()=>onEditFromHere(m)}>Edit from here</button>}</div></div>;
    const parsed=parseVisualizationMessage(m.text);
    return <div className={"history-assistant"+(activeFind?" find-active":"")} data-message-id={m.id} key={m.id}><div className="agent-star small"><Sparkles size={12}/></div><div>{parsed.text&&<div className="assistant-message-text" data-assistant-citation-source={m.id}>{parsed.text}</div>}{parsed.visualizations.map((visualization,index)=>{
      const label=String(visualization.path||visualization.file||"Visualization").split(/[\\/]/).pop();
      return <div className={"inline-visualization-card "+(visualization.mode==="wide"?"wide":"")} key={label+":"+index}><div className="inline-visualization-head"><strong>{label}</strong><span>Interactive visualization</span></div><iframe title={label} src={visualizationUrl(visualization,{projectPath,environmentId,threadId})} sandbox="allow-scripts" referrerPolicy="no-referrer"/></div>;
    })}</div></div>;
  })}<AssistantSelectionToolbar containerRef={historyRef} onCite={({messageId,text})=>{const message=messages.find(item=>String(item.id)===String(messageId));if(message)onCite?.(message,text)}}/></div>;
}
function ApprovalCard({request,onResolve}){
  if(!request)return null;
  const p=request.params||{};
  const permissions=request.method==="item/permissions/requestApproval";
  const network=permissions?p.permissions?.network:null;const fileSystem=permissions?p.permissions?.fileSystem:null;
  const title=permissions?"Additional access requested":request.method.includes("fileChange")||request.method==="applyPatchApproval"?"File changes need approval":p.networkApprovalContext?.host?"Network access needs approval":"Command needs approval";
  const detail=permissions?[network&&"Network access",fileSystem&&"Filesystem access"].filter(Boolean).join(" + "):(p.networkApprovalContext?.host?`${p.networkApprovalContext.protocol||"network"}://${p.networkApprovalContext.host}`:p.reason||p.command||p.path||request.method);
  return <div className="approval-card"><div className="card-title"><ShieldCheck size={16}/><strong>{title}</strong></div><p>{detail||p.reason||request.method}</p>{permissions&&<pre className="approval-permissions">{JSON.stringify(p.permissions||{},null,2)}</pre>}<div className="approval-actions"><button onClick={()=>onResolve(request,"decline")}>Deny</button><button onClick={()=>onResolve(request,"acceptForSession")}>Allow session</button><button className="approve" onClick={()=>onResolve(request,"accept")}>Allow once</button></div></div>;
}
function GuardianDenialCard({review,busy,onApprove,onDismiss}){
  if(!review)return null;
  const detail=guardianActionSummary(review.action||{});
  const risk=review.review?.riskLevel;
  return <div className="approval-card guardian-denial-card" data-testid="guardian-denial-card"><div className="card-title"><ShieldCheck size={16}/><strong>Auto review denied this action</strong></div><p>{detail}</p>{review.review?.rationale&&<p>{review.review.rationale}</p>}{risk&&<small>Risk assessment: {risk}</small>}<div className="approval-actions"><button onClick={()=>onDismiss(review)} disabled={busy}>Dismiss</button><button className="approve" onClick={()=>onApprove(review)} disabled={busy}>{busy?"Allowing…":"Allow anyway"}</button></div></div>;
}
function FreebuffMini({freebuff,model,onOpen}){
  const balance=freebuff?.derived?.balance;
  const p=freebuff?.derived?.priceByModel?.[model]||freebuff?.derived?.selectedPrice;
  return <button className="freebuff-card" data-testid="freebuff-card" onClick={onOpen}><div className="freebuff-card-head"><span><Coins size={16}/> Freebucks</span><b>{balance??"—"}</b></div><div className="freebuff-mini-grid"><div><small>Model</small><strong>{model?.replace(/^freebuff\//,"").split("/").at(-1)||"—"}</strong></div><div><small>Price</small><strong>{p?.current!=null?p.current+" FB/h":"—"}</strong></div><div><small>Session</small><strong>{freebuff?.derived?.sessionStatus||"none"}</strong></div><div><small>Streak</small><strong>{freebuff?.streak?.streak??"—"}d</strong></div></div></button>;
}

const SLASH_COMMANDS=[
  ["/compact","Compact conversation context"],
  ["/ps","Show Codex background processes"],
  ["/stop","Stop Codex background processes"],
  ["/plan","Create a plan, then execute it"],
  ["/model","Open model provider settings"],
  ["/terminal","Open persistent terminal"],
  ["/diff","Open workspace changes"],
  ["/git","Open source control"],
  ["/preview","Open browser preview"],
  ["/agents","Open delegated agents"],
  ["/review","Review uncommitted workspace changes"],
  ["/feedback","Send this Codex thread and logs as feedback"],
  ["/goal","Open the durable thread goal"],
  ["/palette","Open the command palette"],
  ["/new","Start a new thread"],
  ["/clear","Reset the current draft/thread view"],
];

function Composer({prompt,setPrompt,onPromptEdit,historyIndex=-1,onSend,onBackgroundSend,canBackground=false,running,submitting=false,providerReady,provider,agentRuntime="codex",agentRuntimeLabel="Codex",login,onConfigureProvider,models,modelMeta,model,setModel,selectedModels=[],onSelectedModels,allowMultiModel=false,modelError,freebuff,attachments,contextChips,onRemoveAttachment,onRemoveContext,onPickFiles,onCaptureScreen,onPaste,onDrop,onFileMentionSearch,onFileMentionAttach,permissionMode,setPermissionMode,collaborationModes=[],collaborationMode="default",onCollaborationMode,collaborationModeBusy=false,providerCommands=[],providerAgents=[],providerAgent="",onProviderAgent,settings,tokenUsage,workspaceMode,setWorkspaceMode,projectless=false,threadOpen=false,gitAvailable=false,canCompact=false,onCompact,runtimeProfiles=null,runtimeProfileBusy="",onRuntimeProfile,onModelPickerOpenChange}){
  const [modelOpen,setModelOpen]=useState(false);
  const [listening,setListening]=useState(false);
  const [caret,setCaret]=useState(0);
  const [mentionItems,setMentionItems]=useState([]);
  const [mentionIndex,setMentionIndex]=useState(0);
  const [mentionBusy,setMentionBusy]=useState(false);
  const composerRef=useRef(null);
  const speechSupported=typeof window!=="undefined"&&Boolean(window.SpeechRecognition||window.webkitSpeechRecognition);
  useLayoutEffect(()=>{resizeTextarea(composerRef.current,{min:40,max:160})},[prompt]);
  useEffect(()=>{onModelPickerOpenChange?.(modelOpen)},[modelOpen,onModelPickerOpenChange]);
  useEffect(()=>{
    if(!modelOpen)return;
    const pointerDown=event=>{
      const target=event.target;
      if(target instanceof Element&&target.closest(".model-picker-wrap"))return;
      setModelOpen(false);
    };
    const keyDown=event=>{if(event.key==="Escape")setModelOpen(false)};
    window.addEventListener("pointerdown",pointerDown,true);
    window.addEventListener("keydown",keyDown,true);
    return()=>{window.removeEventListener("pointerdown",pointerDown,true);window.removeEventListener("keydown",keyDown,true)};
  },[modelOpen]);
  useEffect(()=>{
    const onPicker=event=>{
      const action=event.detail?.action;
      if(action==="toggle"){setModelOpen(value=>!value);return}
      if(action==="open"){setModelOpen(true);return}
      if(action==="jump"){
        const index=Math.max(0,Number(event.detail?.index)||0);const id=models[index];
        if(id){setModel(id);onSelectedModels?.([id]);setModelOpen(false)}
      }
    };
    window.addEventListener("trebell:model-picker",onPicker);
    return()=>window.removeEventListener("trebell:model-picker",onPicker);
  },[models,setModel,onSelectedModels]);
  const activeMention=useMemo(()=>fileMentionAt(prompt,caret),[prompt,caret]);
  useEffect(()=>{
    let disposed=false;const query=activeMention?.query||"";
    if(!onFileMentionSearch||!query){setMentionItems([]);setMentionIndex(0);return}
    const timer=setTimeout(async()=>{
      try{
        const items=await onFileMentionSearch(query);if(disposed)return;
        setMentionItems(rankFileMentions(items,query,{limit:8}));setMentionIndex(0);
      }catch{if(!disposed)setMentionItems([])}
    },120);
    return()=>{disposed=true;clearTimeout(timer)};
  },[activeMention?.query,onFileMentionSearch]);
  const priceConfig=(settings.customModels||[]).find(item=>item.id===model&&item.runtime===agentRuntime&&(agentRuntime!=="codex"||item.provider===provider))||null;
  function dictate(){
    if(!speechSupported||listening)return;
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    const recognition=new Recognition();
    recognition.lang=navigator.language||"en-US";
    recognition.interimResults=false;
    recognition.continuous=false;
    recognition.onstart=()=>setListening(true);
    recognition.onend=()=>setListening(false);
    recognition.onerror=()=>setListening(false);
    recognition.onresult=(event)=>{
      const text=[...event.results].map(result=>result[0]?.transcript||"").join(" ").trim();
      if(text)setPrompt(prev=>(prev&& !/\s$/.test(prev)?prev+" ":"")+text);
    };
    recognition.start();
  }
  async function chooseMention(item){
    if(!activeMention||!item||mentionBusy)return;
    setMentionBusy(true);
    try{
      await onFileMentionAttach?.(item);
      const label=item.relativePath||item.name||item.path;
      const next=applyFileMention(prompt,activeMention,label);
      onPromptEdit?.();setPrompt(next.text);setMentionItems([]);setCaret(next.caret);
      requestAnimationFrame(()=>{composerRef.current?.focus();composerRef.current?.setSelectionRange(next.caret,next.caret)});
    }finally{setMentionBusy(false)}
  }
  function keyDown(e){
    if(activeMention&&mentionItems.length){
      if(e.key==="ArrowDown"){e.preventDefault();setMentionIndex(index=>(index+1)%mentionItems.length);return}
      if(e.key==="ArrowUp"){e.preventDefault();setMentionIndex(index=>(index-1+mentionItems.length)%mentionItems.length);return}
      if((e.key==="Enter"||e.key==="Tab")&&!e.shiftKey){e.preventDefault();chooseMention(mentionItems[mentionIndex]);return}
      if(e.key==="Escape"){e.preventDefault();setMentionItems([]);return}
    }
    if(e.key==="Enter"&&!e.shiftKey){
      if((e.ctrlKey||e.metaKey)&&canBackground){e.preventDefault();onBackgroundSend?.();return}
      if(!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();onSend();return}
    }
    const noExtras=!attachments.length&&!(contextChips||[]).length;
    if(e.key==="ArrowUp"&&noExtras&&(!prompt||historyIndex>=0)){
      const before=prompt.slice(0,e.currentTarget.selectionStart);if(before.includes("\n"))return;
      e.preventDefault();window.dispatchEvent(new CustomEvent("trebell:history",{detail:-1}));return;
    }
    if(e.key==="ArrowDown"&&noExtras&&historyIndex>=0){
      const after=prompt.slice(e.currentTarget.selectionEnd);if(after.includes("\n"))return;
      e.preventDefault();window.dispatchEvent(new CustomEvent("trebell:history",{detail:1}));
    }
  }
  const slashOpen=prompt.startsWith("/")&&!prompt.includes("\n");
  const slashQuery=prompt.toLowerCase();
  const nativeSlash=(providerCommands||[]).map(command=>{
    const raw=typeof command==="string"?command:command?.name||command?.command||"";if(!raw)return null;
    const cmd=raw.startsWith("/")?raw:"/"+raw;const desc=typeof command==="string"?`${agentRuntimeLabel} command`:command?.description||`${agentRuntimeLabel} command`;return [cmd,desc];
  }).filter(Boolean);
  const allSlash=[...SLASH_COMMANDS,...nativeSlash].filter(([cmd],index,array)=>array.findIndex(([candidate])=>candidate===cmd)===index);
  const slashAvailable=cmd=>{
    if(cmd==="/compact")return threadOpen&&["codex","opencode","claude"].includes(agentRuntime);
    if(["/ps","/stop","/feedback"].includes(cmd))return agentRuntime==="codex"&&threadOpen;
    if(cmd==="/agents")return agentRuntime==="codex";
    if(cmd==="/goal")return threadOpen;
    if(cmd==="/review")return threadOpen&&gitAvailable;
    if(["/diff","/git"].includes(cmd))return !projectless;
    return true;
  };
  const slashItems=slashOpen?allSlash.filter(([cmd])=>cmd.startsWith(slashQuery.split(/\s/)[0])&&slashAvailable(cmd)):[];
  const contextPaths=new Set((contextChips||[]).map(chip=>chip.path));
  const promptTooLong=prompt.length>MAX_COMPOSER_CHARS;
  const chosenModels=selectedModels.length?selectedModels:(model?[model]:[]);
  const runtimeProfileItems=runtimeProfiles?.items||[];
  const currentRuntimeProfile=runtimeProfileItems.find(item=>item.id===runtimeProfiles?.currentInstanceId)||null;
  const runtimeProfileLabel=runtimeProfiles?.label||`${agentRuntimeLabel} profile`;
  function pickModel(event,id){
    const next=nextModelSelection(chosenModels,id,{shiftKey:event.shiftKey,allowMulti:allowMultiModel});
    onSelectedModels?.(next);if(!next.includes(model))setModel(next[0]||id);
    if(!event.shiftKey||!allowMultiModel)setModelOpen(false);
  }
  return <div className="composer-wrap" onDragOver={e=>e.preventDefault()} onDrop={onDrop}>
    {slashOpen&&slashItems.length>0&&<div className="slash-menu">{slashItems.map(([cmd,desc])=><button key={cmd} onMouseDown={e=>{e.preventDefault();setPrompt(cmd+" ")}}><strong>{cmd}</strong><span>{desc}</span></button>)}</div>}
    {activeMention&&mentionItems.length>0&&<div className="file-mention-menu" data-testid="file-mention-menu">{mentionItems.map((item,index)=><button key={item.path||item.relativePath||index} className={index===mentionIndex?"active":""} disabled={mentionBusy} onMouseDown={event=>{event.preventDefault();chooseMention(item)}}><FileCode2 size={13}/><span><strong>{item.name||String(item.path||"").split(/[\\/]/).pop()}</strong><small>{item.relativePath||item.path}</small></span></button>)}</div>}
    {(contextChips||[]).length>0&&<div className="context-chip-row" data-testid="context-chips">{contextChips.map(chip=><span className={"context-chip kind-"+(chip.kind||"context")} data-testid="context-chip" key={chip.id||chip.path} title={chip.path}><Link2 size={11}/><strong>{chip.label||"Context"}</strong>{chip.detail&&<small>{chip.detail}</small>}<button onClick={()=>onRemoveContext(chip.path)} title="Remove context"><X size={10}/></button></span>)}</div>}
    <div className="attachment-shelf">{attachments.filter(path=>!contextPaths.has(path)).map(path=><span key={path} title={attachmentDisplayName(path)}><Paperclip size={11}/>{attachmentDisplayName(path)}<button onClick={()=>onRemoveAttachment(path)}><X size={10}/></button></span>)}</div>
    <textarea ref={composerRef} data-testid="composer" value={prompt} onChange={e=>{onPromptEdit?.();setPrompt(e.target.value);setCaret(e.target.selectionStart)}} onClick={e=>setCaret(e.currentTarget.selectionStart)} onKeyUp={e=>setCaret(e.currentTarget.selectionStart)} onKeyDown={keyDown} onPaste={onPaste} placeholder={submitting?"Sending…":providerReady?(running?(agentRuntime==="codex"&&settings.followUpMode==="steer"?"Steer the running agent…":"Queue a follow-up…"):"Ask Trebell Code anything…"):(agentRuntime!=="codex"?`Configure ${agentRuntimeLabel} in Settings…`:provider==="freebuff"?"Sign in to Freebuff to start…":"Configure the selected provider in Settings…")} disabled={!providerReady||submitting}/>
    <div className="composer-bar"><div className="composer-left">
      <button className="circle-btn" onClick={onPickFiles} title="Attach files" aria-label="Attach files"><Plus size={18}/></button>
      {window.trebellDesktop?.captureScreen&&<button className="circle-btn" onClick={onCaptureScreen} title="Capture desktop screenshot" aria-label="Capture desktop screenshot"><Camera size={15}/></button>}
      <select className="permission-picker" value={permissionMode} onChange={e=>setPermissionMode(e.target.value)}><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select>
      {agentRuntime==="codex"&&collaborationModes.length>0&&<select data-testid="collaboration-mode-picker" className="permission-picker collaboration-mode-picker" value={collaborationMode} disabled={running||collaborationModeBusy} onChange={e=>onCollaborationMode?.(e.target.value)} title="Codex collaboration mode">{collaborationModes.map(item=><option key={item.mode} value={item.mode}>{item.name} mode</option>)}</select>}
      {!threadOpen&&!projectless&&<select className="workspace-mode" value={workspaceMode} onChange={e=>setWorkspaceMode(e.target.value)}><option value="current">Current workspace</option><option value="worktree">New worktree</option></select>}
    </div><div className="composer-right">
      {!providerReady&&!models.length?<button className="login-btn" onClick={agentRuntime==="codex"&&provider==="freebuff"?login:onConfigureProvider}>{agentRuntime!=="codex"?"Configure "+agentRuntimeLabel:provider==="freebuff"?"Sign in to Freebuff":"Configure "+({agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||"provider")}</button>:<>
        {agentRuntime!=="codex"&&providerAgents.length>0&&<select className="agent-picker" value={providerAgent||""} onChange={e=>onProviderAgent?.(e.target.value)} title="Provider agent"><option value="">Default agent</option>{providerAgents.map(agent=>{const name=typeof agent==="string"?agent:agent.name;const mode=typeof agent==="string"?"":agent.mode;return <option key={name} value={name}>{name}{mode?` · ${mode}`:""}</option>})}</select>}
        <div className="model-picker-wrap"><button data-testid="model-picker" className={"model-picker-button "+(chosenModels.length>1?"multi":"")} disabled={!models.length} onClick={()=>setModelOpen(value=>!value)} title={!providerReady?"Provider reconnecting":running&&agentRuntime==="codex"?"Select model · applies live when Codex step model switching is enabled":allowMultiModel?"Shift-click models to run the same task in isolated worktrees":"Select model"}><span className="model-picker-current"><strong>{chosenModels.length>1?`${chosenModels.length} models`:(modelMeta?.[model]?.name||compactModelLabel(model,freebuff)||modelError||"No models")}</strong>{runtimeProfileItems.length>1&&currentRuntimeProfile&&<small>{currentRuntimeProfile.displayName}</small>}</span><ChevronDown size={12}/></button>{modelOpen&&models.length>0&&<div className="model-picker-menu">{runtimeProfileItems.length>1&&<div className="model-runtime-profiles"><p>{runtimeProfileLabel}</p>{runtimeProfileItems.map(item=><button key={item.id} className={item.id===runtimeProfiles.currentInstanceId?"selected":""} disabled={!item.available||item.authenticated===false||Boolean(runtimeProfileBusy)||running} onClick={()=>{onRuntimeProfile?.(item.id);setModelOpen(false)}}><span>{item.id===runtimeProfiles.currentInstanceId?<Check size={11}/>:<i/>}<strong>{item.displayName}</strong></span><small>{runtimeProfileBusy===item.id?"Switching…":item.available?(item.authenticated===false?"Sign-in required":item.version||"Ready"):item.message||"Unavailable"}</small></button>)}</div>}{models.map(id=>{const selected=chosenModels.includes(id);return <button key={id} className={selected?"selected":""} onClick={event=>pickModel(event,id)}><span>{selected?<Check size={11}/>:<i/>}<strong>{modelMeta?.[id]?.name||modelLabel(id,freebuff)}</strong></span><small>{modelMeta?.[id]?.custom?"custom":modelMeta?.[id]?.agent||""}</small></button>})}{allowMultiModel&&<p>Shift-click to select multiple models. Each runs in its own worktree.</p>}</div>}</div>
      </>}
      <button className={"mic-btn "+(listening?"active":"")} onClick={dictate} disabled={!speechSupported} title={speechSupported?(listening?"Listening…":"Voice dictation"):"Voice dictation is unavailable on this platform"}><Mic size={15}/></button>
      <button data-testid="send" className="send-btn" onClick={onSend} disabled={!providerReady||submitting||!prompt.trim()||promptTooLong}>{running&&settings.followUpMode==="queue"?<Plus size={16}/>:<Send size={16}/>}</button>
    </div></div>
    <div className={"composer-status"+(modelError||promptTooLong?" error":"")}><span>{promptTooLong?`Draft is ${prompt.length.toLocaleString()} characters · maximum ${MAX_COMPOSER_CHARS.toLocaleString()}`:modelError||<>{tokenLabel(tokenUsage,priceConfig)}{canCompact&&!running&&<button className="context-compact-btn" type="button" onClick={onCompact} title="Compact conversation context">Compact</button>}</>}</span><span>{prompt.length.toLocaleString()}/{MAX_COMPOSER_CHARS.toLocaleString()} · {canBackground?"Ctrl/Cmd+Enter background · ":""}{settings.followUpMode==="steer"?"Steer":"Queue"} follow-ups</span></div>
  </div>;
}

export default function App(){
  const [bootstrap,setBootstrap]=useState({mock:false,loggedIn:false,wsUrl:null,cwd:"",platform:""});
  const [rpc,setRpc]=useState(null); const [rpcStatus,setRpcStatus]=useState("disconnected");
  const [threads,setThreads]=useState([]); const [sections,setSections]=useState({}); const [threadMeta,setThreadMeta]=useState({});
  const [activeThread,setActiveThread]=useState(null); const [activeTurnId,setActiveTurnId]=useState(null);
  const [messages,setMessages]=useState([]); const [events,setEvents]=useState([]); const [assistantText,setAssistantText]=useState("");
  const [historyPage,setHistoryPage]=useState({threadId:null,nextCursor:null,paginated:false,loading:false});
  const [threadFind,setThreadFind]=useState({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});
  const [running,setRunning]=useState(false); const [submitting,setSubmitting]=useState(false); const [queued,setQueued]=useState([]); const [queueMode,setQueueMode]=useState("unknown"); const [queuedEditId,setQueuedEditId]=useState(null);
  const [query,setQuery]=useState(""); const [searchResults,setSearchResults]=useState(null); const [section,setSection]=useState("chat");
  const [prompt,setPrompt]=useState(""); const [promptHistoryIndex,setPromptHistoryIndex]=useState(-1); const [attachments,setAttachments]=useState([]); const [contextChips,setContextChips]=useState([]);
  const [models,setModels]=useState([]); const [modelMeta,setModelMeta]=useState({}); const [model,setModel]=useState(""); const [selectedModels,setSelectedModels]=useState([]); const [modelError,setModelError]=useState(""); const [modelPickerOpen,setModelPickerOpen]=useState(false);
  const [collaborationModes,setCollaborationModes]=useState([]); const [collaborationMode,setCollaborationMode]=useState("default"); const [collaborationModeBusy,setCollaborationModeBusy]=useState(false);
  const [freebuff,setFreebuff]=useState({loggedIn:false}); const [skills,setSkills]=useState([]); const [providerCommands,setProviderCommands]=useState([]); const [providerAgents,setProviderAgents]=useState([]); const [providerAgent,setProviderAgent]=useState("");
  const [threadRuntimeProfiles,setThreadRuntimeProfiles]=useState({supported:false,currentInstanceId:null,items:[]}); const [threadRuntimeProfileBusy,setThreadRuntimeProfileBusy]=useState("");
  const submittingRef=useRef(false);
  const [settings,setSettings]=useState({followUpMode:"queue",defaultPermissionMode:"supervised",appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,customThemes:[],keyboardShortcuts:{},agentRuntime:"codex",modelProvider:"freebuff"});
  const [environmentThemeCatalog,setEnvironmentThemeCatalog]=useState({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]});
  const [sidebarOpen,setSidebarOpen]=useState(true);
  const [layoutPrefs,setLayoutPrefs]=useState(()=>{
    try{return normalizeLayoutPreferences(JSON.parse(localStorage.getItem("trebell-layout-v1")||"{}"))}
    catch{return {...DEFAULT_LAYOUT}}
  });
  const [permissionMode,setPermissionMode]=useState("supervised"); const [workspaceMode,setWorkspaceMode]=useState("current");
  const [projectPath,setProjectPath]=useState(""); const [currentProject,setCurrentProject]=useState(null); const [projectlessMode,setProjectlessMode]=useState(false); const [generalEnvironmentId,setGeneralEnvironmentId]=useState(null); const [gitInfo,setGitInfo]=useState(null); const [stats,setStats]=useState({}); const [runtime,setRuntime]=useState({});
  const [approvals,setApprovals]=useState([]); const [question,setQuestion]=useState(null); const [elicitations,setElicitations]=useState([]); const [tokenUsage,setTokenUsage]=useState(null);
  const [guardianDenials,setGuardianDenials]=useState([]); const [guardianBusy,setGuardianBusy]=useState("");
  const [panel,setPanel]=useState(null); const [rightPanelOpen,setRightPanelOpen]=useState(false); const [rightPanelTab,setRightPanelTab]=useState("files"); const [rightPanelMaximized,setRightPanelMaximized]=useState(false); const [reviewedFiles,setReviewedFiles]=useState([]); const [checkpointByTurn,setCheckpointByTurn]=useState({});
  const [selectedThreadIds,setSelectedThreadIds]=useState(new Set()); const [providerRevision,setProviderRevision]=useState(0);
  const [snoozeRequest,setSnoozeRequest]=useState(null); const [threadUndo,setThreadUndo]=useState(null); const [actionError,setActionError]=useState("");
  const [goal,setGoal]=useState(null); const [linkedPullRequests,setLinkedPullRequests]=useState([]); const [sourceSelectedPr,setSourceSelectedPr]=useState(null);
  const [worktreeSetup,setWorktreeSetup]=useState(null);
  const [threadTelemetry,setThreadTelemetry]=useState({});
  const [paletteOpen,setPaletteOpen]=useState(false); const [initialLoaded,setInitialLoaded]=useState(false);
  const [paletteProjects,setPaletteProjects]=useState([]); const [paletteEnvironmentNames,setPaletteEnvironmentNames]=useState({local:"Local machine"});
  const rpcRef=useRef(null); const activeThreadRef=useRef(null); const modelRefreshSeqRef=useRef(0); const backgroundThreadsRef=useRef(new Set()); const threadUndoRef=useRef(null); const threadUndoTimerRef=useRef(null); const actionErrorTimerRef=useRef(null); const threadMessageSearchCacheRef=useRef(new Map()); const navigationHistoryRef=useRef({entries:[],index:-1,expectedKey:null}); const timezone=useMemo(()=>Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",[]);
  const conversationScrollRef=useRef(null);const threadScrollPositionsRef=useRef(new Map());const pendingThreadScrollRestoreRef=useRef(null);const pendingHistoryPrependRef=useRef(null);const followConversationEndRef=useRef(true);const modelCatalogScopeRef=useRef(null);const threadFindInputRef=useRef(null);const threadFindSeqRef=useRef(0);
  const navigationKey=location=>[location.section,location.threadId||"",location.rightPanelOpen?location.rightPanelTab||"files":""].join("|");
  useEffect(()=>{
    if(!initialLoaded)return;
    const history=navigationHistoryRef.current;
    const location={section,threadId:activeThread?.id||null,rightPanelOpen:Boolean(rightPanelOpen),rightPanelTab:rightPanelTab||"files"};
    const key=navigationKey(location);
    if(history.expectedKey){
      if(key===history.expectedKey)history.expectedKey=null;
      return;
    }
    if(history.entries[history.index]&&navigationKey(history.entries[history.index])===key)return;
    history.entries=history.entries.slice(0,history.index+1);
    history.entries.push(location);
    if(history.entries.length>80)history.entries.shift();
    history.index=history.entries.length-1;
  },[initialLoaded,section,activeThread?.id,rightPanelOpen,rightPanelTab]);
  async function navigateHistory(delta){
    const history=navigationHistoryRef.current;
    const nextIndex=history.index+delta;
    if(nextIndex<0||nextIndex>=history.entries.length)return;
    const target=history.entries[nextIndex];
    history.index=nextIndex;history.expectedKey=navigationKey(target);
    if(target.threadId&&activeThreadRef.current?.id!==target.threadId){
      const thread=threads.find(item=>item.id===target.threadId);
      if(thread)await openThread(thread);
    }else if(!target.threadId&&activeThreadRef.current?.id&&target.section==="chat"){
      await newChat();
    }
    setRightPanelTab(target.rightPanelTab||"files");
    setRightPanelOpen(Boolean(target.rightPanelOpen));
    if(!target.rightPanelOpen)setRightPanelMaximized(false);
    setSection(target.section||"chat");
  }
  useEffect(()=>{try{localStorage.setItem("trebell-layout-v1",JSON.stringify(layoutPrefs))}catch{}},[layoutPrefs]);
  function beginLayoutResize(kind,event){
    if(event.button!==0)return;
    event.preventDefault();
    const startX=event.clientX,startY=event.clientY,start={...layoutPrefs};
    document.documentElement.classList.add("layout-resizing");
    const move=moveEvent=>{
      if(kind==="sidebar"){
        const maxByViewport=Math.max(210,Math.min(420,window.innerWidth-620));
        setLayoutPrefs(prev=>({...prev,sidebarWidth:Math.min(maxByViewport,clampLayoutValue("sidebarWidth",start.sidebarWidth+(moveEvent.clientX-startX)))}));
      }else if(kind==="right"){
        const maxByViewport=Math.max(340,Math.min(820,window.innerWidth-(sidebarOpen?layoutPrefs.sidebarWidth:0)-480));
        setLayoutPrefs(prev=>({...prev,rightPanelWidth:Math.min(maxByViewport,clampLayoutValue("rightPanelWidth",start.rightPanelWidth-(moveEvent.clientX-startX)))}));
      }else if(kind==="terminal"){
        const maxByViewport=Math.max(190,Math.min(620,window.innerHeight-260));
        setLayoutPrefs(prev=>({...prev,terminalHeight:Math.min(maxByViewport,clampLayoutValue("terminalHeight",start.terminalHeight-(moveEvent.clientY-startY)))}));
      }
    };
    const up=()=>{document.documentElement.classList.remove("layout-resizing");window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up)};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up,{once:true});
  }
  const displayThreads=searchResults||threads;
  const environmentThemes=useMemo(()=>(environmentThemeCatalog.themes||[]).flatMap(theme=>{
    try{return [{...normalizeCustomTheme(theme,{id:`environment-${environmentThemeCatalog.environmentKey}-${theme.id}`}),publishedId:theme.id,published:true}]}
    catch{return []}
  }),[environmentThemeCatalog]);
  const selectedEnvironmentThemeId=settings.environmentThemeSelections?.[environmentThemeCatalog.environmentKey]||null;
  function desktopNotify(title,body){
    if(settings.notifications===false)return;
    window.trebellDesktop?.notify?.({title,body,silent:!settings.notificationSound});
  }
  function rememberConversationPosition(threadId=activeThreadRef.current?.id){
    const node=conversationScrollRef.current;if(!threadId||!node)return null;
    const position=captureThreadScrollPosition(node);if(!position)return null;
    rememberThreadScrollPosition(threadScrollPositionsRef.current,threadId,position);
    followConversationEndRef.current=position.atEnd;
    return position;
  }
  function conversationScrolled(){
    const node=conversationScrollRef.current;if(!node)return;
    const position=captureThreadScrollPosition(node);followConversationEndRef.current=position?.atEnd!==false;
    const threadId=activeThreadRef.current?.id;if(threadId&&position)rememberThreadScrollPosition(threadScrollPositionsRef.current,threadId,position);
  }
  useLayoutEffect(()=>{
    const node=conversationScrollRef.current;const threadId=activeThread?.id;if(!node||!threadId)return;
    if(pendingHistoryPrependRef.current?.threadId===threadId){
      const pending=pendingHistoryPrependRef.current;node.scrollTop=Math.max(0,pending.scrollTop+(node.scrollHeight-pending.scrollHeight));
      followConversationEndRef.current=false;pendingHistoryPrependRef.current=null;return;
    }
    if(pendingThreadScrollRestoreRef.current===threadId){
      const position=threadScrollPositionsRef.current.get(threadId)||null;
      node.scrollTop=restoredThreadScrollTop(position,node);
      followConversationEndRef.current=position?.atEnd??true;
      pendingThreadScrollRestoreRef.current=null;
      return;
    }
    if(followConversationEndRef.current)node.scrollTop=Math.max(0,node.scrollHeight-node.clientHeight);
  },[activeThread?.id,messages.length,events.length,assistantText]);
  useEffect(()=>{
    const node=conversationScrollRef.current;if(!node||typeof ResizeObserver==="undefined")return;
    const content=node.firstElementChild;if(!content)return;
    const observer=new ResizeObserver(()=>{if(followConversationEndRef.current)node.scrollTop=Math.max(0,node.scrollHeight-node.clientHeight)});
    observer.observe(content);return()=>observer.disconnect();
  },[section,activeThread?.id]);
  useEffect(()=>{
    if(!threadFind.open)return;
    const id=requestAnimationFrame(()=>threadFindInputRef.current?.focus());
    return()=>cancelAnimationFrame(id);
  },[threadFind.open]);

  useEffect(()=>{
    const root=document.documentElement;const media=window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply=()=>{
      const requested=["system","light","dark"].includes(settings.appearanceMode)?settings.appearanceMode:"system";
      const resolved=requested==="system"?(media?.matches===false?"light":"dark"):requested;
      const custom=environmentThemes.find(theme=>theme.publishedId===selectedEnvironmentThemeId)||(settings.customThemes||[]).find(theme=>theme.id===settings.appearance);
      root.dataset.theme=custom?.id||settings.appearance||"dark";root.dataset.mode=resolved;root.dataset.customTheme=custom?"true":"false";root.dataset.environmentTheme=custom?.published?"true":"false";root.style.colorScheme=resolved;
      const variableNames=["--theme-canvas","--theme-foreground","--bg","--panel","--panel2","--line","--muted","--muted2","--purple","--purple2","--green","--theme-error","--theme-warning","--theme-terminal-selection"];
      for(const name of variableNames)root.style.removeProperty(name);
      if(custom){for(const [name,value] of Object.entries(themeCssVariables(custom,resolved)))root.style.setProperty(name,value)}
    };
    apply();media?.addEventListener?.("change",apply);return()=>media?.removeEventListener?.("change",apply);
  },[settings.appearance,settings.appearanceMode,settings.customThemes,environmentThemes,selectedEnvironmentThemeId]);
  useEffect(()=>{
    const root=document.documentElement;const media=window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const apply=()=>{const duration=media?.matches?0:Math.max(0,Math.min(400,Number(settings.panelAnimationMs)||0));root.style.setProperty("--panel-animation-ms",duration+"ms")};
    apply();media?.addEventListener?.("change",apply);return()=>media?.removeEventListener?.("change",apply);
  },[settings.panelAnimationMs]);
  useEffect(()=>{activeThreadRef.current=activeThread},[activeThread]);
  useEffect(()=>{
    if(!paletteOpen)return;
    let cancelled=false;
    Promise.all([
      api("/api/projects").catch(()=>({projects:[]})),
      api("/api/environments").catch(()=>({profiles:[]})),
    ]).then(([projectData,environmentData])=>{
      if(cancelled)return;
      setPaletteProjects(projectData.projects||[]);
      setPaletteEnvironmentNames(Object.fromEntries([["local","Local machine"],...(environmentData.profiles||[]).map(profile=>[profile.id,profile.name||profile.id])]));
    });
    return()=>{cancelled=true};
  },[paletteOpen]);

  function updateThreadTelemetry(threadId,patch){
    if(!threadId)return;
    setThreadTelemetry(prev=>{
      const current=prev[threadId]||{};
      const next=typeof patch==="function"?patch(current):patch;
      return {...prev,[threadId]:{...current,...next}};
    });
  }
  function notificationIsActive(threadId){return !threadId||threadId===activeThreadRef.current?.id}

  useEffect(()=>{
    if(!window.trebellDesktop?.zoom)return;
    let disposed=false;
    let factor=1;
    window.trebellDesktop.zoom.get().then(result=>{if(!disposed&&Number.isFinite(Number(result?.factor)))factor=Number(result.factor)}).catch(()=>{});
    const onWheel=(event)=>{
      if(!event.ctrlKey&&!event.metaKey)return;
      event.preventDefault();
      const direction=Math.sign(Number(event.deltaY)||0);
      if(direction===0)return;
      factor=Math.min(2.5,Math.max(0.7,Math.round((factor+(direction<0?0.1:-0.1))*100)/100));
      window.trebellDesktop.zoom.set(factor).then(result=>{
        if(!disposed&&Number.isFinite(Number(result?.factor)))factor=Number(result.factor);
      }).catch(()=>{});
    };
    window.addEventListener("wheel",onWheel,{capture:true,passive:false});
    return()=>{disposed=true;window.removeEventListener("wheel",onWheel,{capture:true})};
  },[]);

  useEffect(()=>{
    const snapshots=window.trebellDesktop?.snapshots;if(!snapshots)return;
    let disposed=false;const handling=new Set();
    const attachCapture=async id=>{
      if(disposed||!id||handling.has(id))return;handling.add(id);
      try{
        const capture=await snapshots.read(id);
        const safeProcess=String(capture.process||"window").replace(/[^a-zA-Z0-9._-]+/g,"-").slice(0,60)||"window";
        const uploaded=await api("/api/attachments/blob",{method:"POST",body:{name:`snapshot-${safeProcess}-${capture.createdAt||Date.now()}.png`,mime:"image/png",dataBase64:capture.dataBase64}});
        const [imagePath]=await prepareAttachmentPaths([uploaded.path]);
        setAttachments(prev=>[...new Set([...prev,imagePath])].slice(-MAX_COMPOSER_ATTACHMENTS));
        setContextChips(prev=>[...prev.filter(chip=>chip.path!==imagePath),{id:crypto.randomUUID(),path:imagePath,kind:"snapshot",label:`SnapShot: ${capture.process||"App"}`,detail:capture.title||`${capture.width||"?"}×${capture.height||"?"}`}].slice(-MAX_COMPOSER_ATTACHMENTS));
        if(capture.hasAccessibility&&Array.isArray(capture.accessibility)&&capture.accessibility.length){
          const context={app:capture.process||null,windowTitle:capture.title||null,bounds:capture.bounds||null,controls:capture.accessibility};
          try{
            const metadata=await api("/api/attachments/text",{method:"POST",body:{name:`snapshot-${safeProcess}-ui.json`,text:JSON.stringify(context,null,2)}});
            const [metadataPath]=await prepareAttachmentPaths([metadata.path]);
            setAttachments(prev=>[...new Set([...prev,metadataPath])].slice(-MAX_COMPOSER_ATTACHMENTS));
            setContextChips(prev=>[...prev.filter(chip=>chip.path!==metadataPath),{id:crypto.randomUUID(),path:metadataPath,kind:"snapshot",label:"SnapShot app text",detail:capture.title||capture.process||"Accessibility context"}].slice(-MAX_COMPOSER_ATTACHMENTS));
          }catch{}
        }
        setSection("chat");await snapshots.ack(id);
      }catch(error){
        setEvents(prev=>[...prev,{id:"snapshot-error-"+Date.now(),kind:"error",title:error.message||String(error),status:"done",raw:{snapshotId:id}}]);
      }finally{handling.delete(id)}
    };
    snapshots.pending().then(items=>{for(const item of items||[])attachCapture(item.id)}).catch(()=>{});
    const unsubscribe=snapshots.onCaptured?.(payload=>attachCapture(payload?.id));
    return()=>{disposed=true;unsubscribe?.()};
  },[]);

  const agentRuntime=settings.agentRuntime||bootstrap.agentRuntime||"codex";
  const provider=settings.modelProvider||bootstrap.provider||"freebuff";
  useEffect(()=>{
    const next=agentRuntime+"\0"+provider;
    if(modelCatalogScopeRef.current&&modelCatalogScopeRef.current!==next){
      setModels([]);setModel("");setSelectedModels([]);setModelMeta({});setModelError("");
    }
    modelCatalogScopeRef.current=next;
  },[agentRuntime,provider]);
  const workspaceEnvironmentId=activeThread?.providerMeta?.environmentId??(projectlessMode?generalEnvironmentId:(currentProject?currentProject.environmentId||null:settings.activeEnvironmentId||null));
  const effectiveProjectSettings=currentProject?.effectiveSettings||{
    defaultModel:settings.defaultModel||null,
    defaultPermissionMode:settings.defaultPermissionMode||"supervised",
    defaultWorkspaceMode:settings.defaultWorkspaceMode||"current",
    worktreeSubmodules:settings.worktreeSubmodules||"recursive",
    worktreeCleanup:settings.worktreeCleanup||{mode:"off"},
    autoPull:Boolean(settings.autoPull),
    agentDeviceAccess:Boolean(settings.agentDeviceAccess),
  };
  const workspaceEnvironmentType=currentProject?.environment?.type||(workspaceEnvironmentId&&(workspaceEnvironmentId===settings.activeEnvironmentId)?bootstrap.activeEnvironment?.type:null)||(workspaceEnvironmentId?"remote":"local");
  const workspaceRemote=Boolean(workspaceEnvironmentId&&workspaceEnvironmentType!=="local");
  const providerReady=bootstrap.mock||(agentRuntime==="codex"?(provider==="freebuff"?Boolean(bootstrap.loggedIn):Boolean(bootstrap.providerReady)):Boolean(bootstrap.agentRuntimeReady));
  useEffect(()=>{
    if(!threadFind.open)return;
    const term=threadFind.query.trim();
    if(term.length<2||agentRuntime!=="codex"||!activeThread?.id||!rpc||rpcStatus!=="connected"){
      threadFindSeqRef.current++;
      setThreadFind(current=>({...current,results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null}));
      return;
    }
    const seq=++threadFindSeqRef.current;let disposed=false;
    const timer=setTimeout(async()=>{
      setThreadFind(current=>current.query.trim()===term?{...current,loading:true,error:"",activeItemId:null}:current);
      try{
        const result=await rpc.request("thread/searchOccurrences",{threadId:activeThread.id,searchTerm:term,limit:50});
        if(disposed||seq!==threadFindSeqRef.current||activeThreadRef.current?.id!==activeThread.id)return;
        const results=result?.data||[];
        setThreadFind(current=>current.query.trim()===term?{...current,results,index:results.length?0:-1,nextCursor:result?.nextCursor||null,loading:false,error:"",activeItemId:results[0]?.itemId||null}:current);
        if(results[0])await focusThreadFindOccurrence(results[0],seq);
      }catch(error){
        if(disposed||seq!==threadFindSeqRef.current)return;
        setThreadFind(current=>current.query.trim()===term?{...current,results:[],index:-1,nextCursor:null,loading:false,error:error.message||String(error),activeItemId:null}:current);
      }
    },160);
    return()=>{disposed=true;clearTimeout(timer)};
  },[threadFind.open,threadFind.query,agentRuntime,activeThread?.id,rpc,rpcStatus]);
  useEffect(()=>{setThreadTelemetry({})},[provider,agentRuntime]);
  async function refreshFreebuff(modelOverride=model){
    if(agentRuntime!=="codex"||provider!=="freebuff"||!(bootstrap.loggedIn||bootstrap.mock))return;
    const params=new URLSearchParams({timezone}); if(modelOverride)params.set("model",modelOverride);
    const data=await api("/api/freebuff/overview?"+params).catch(()=>null); if(data)setFreebuff(data);
  }
  async function refreshProviderModels({resetThread=false,provider:expectedProvider=null,agentRuntime:expectedRuntime=null}={}){
    const seq=++modelRefreshSeqRef.current;
    const targetProvider=expectedProvider||provider;
    const targetRuntime=expectedRuntime||agentRuntime;
    if(targetProvider!==provider||targetRuntime!==agentRuntime){setModels([]);setModel("");setSelectedModels([]);setModelMeta({});setModelError("")}
    const [boot,d]=await Promise.all([
      api("/api/bootstrap").catch(()=>null),
      api("/api/models").catch(error=>({models:[],error:error.message})),
    ]);
    if(seq!==modelRefreshSeqRef.current)return d;
    if((d?.provider&&d.provider!==targetProvider)||(d?.agentRuntime&&d.agentRuntime!==targetRuntime))return d;
    if(boot)setBootstrap(boot);
    const ids=d?.models||[];
    setModelError(d?.error||"");
    setModelMeta(Object.fromEntries((d?.metadata?.models||[]).map(item=>[item.id,item])));
    const next=ids.includes(model)?model:(ids[0]||"");
    setModels(ids);setModel(next);setSelectedModels(next?[next]:[]);
    if(resetThread){activeThreadRef.current=null;setActiveThread(null);setActiveTurnId(null);setMessages([]);setEvents([]);setAssistantText("");setQueued([]);setQueueMode(agentRuntime==="codex"?"unknown":"local");setQueuedEditId(null)}
    if(targetRuntime==="codex"&&targetProvider==="freebuff"&&next){
      const params=new URLSearchParams({timezone,model:next});
      api("/api/freebuff/overview?"+params).then(data=>{if(seq===modelRefreshSeqRef.current&&data)setFreebuff(data)}).catch(()=>{});
    }
    return d;
  }
  useEffect(()=>{
    if(!initialLoaded||section!=="chat"||!providerReady||models.length)return;
    refreshProviderModels().catch(()=>{});
  },[initialLoaded,section,providerReady,provider,agentRuntime,models.length]);
  async function touchProject(path,environmentId=undefined,{activate=true}={}){
    if(!path)return null;
    const resolvedEnvironmentId=environmentId===undefined
      ?(activeThreadRef.current?.providerMeta?.environmentId??settings.activeEnvironmentId??null)
      :(environmentId||null);
    const response=await api("/api/projects",{method:"POST",body:{path,environmentId:resolvedEnvironmentId,activate}});
    const project=response?.project||null;
    if(!project)throw new Error("Project activation did not return a project.");
    setProjectlessMode(false);setGeneralEnvironmentId(null);setProjectPath(path);
    setCurrentProject(project);
    if(project&&activate)setSettings(prev=>({...prev,activeProjectId:project.id}));
    const scoped=project?.effectiveSettings||{};
    if(scoped.defaultModel&&models.includes(scoped.defaultModel)){setModel(scoped.defaultModel);setSelectedModels([scoped.defaultModel])}
    if(scoped.defaultPermissionMode)setPermissionMode(scoped.defaultPermissionMode);
    if(scoped.defaultWorkspaceMode)setWorkspaceMode(scoped.defaultWorkspaceMode);
    if(scoped.autoPull&&(!project?.cloneJob||project.cloneJob.status==="completed"))api("/api/git/action",{method:"POST",body:{action:"auto-pull",cwd:path,environmentId:resolvedEnvironmentId}}).catch(()=>{});
    return project;
  }
  async function refreshCloneJob(id=currentProject?.cloneJob?.id){
    if(!id)return null;
    const result=await api("/api/clone-jobs?id="+encodeURIComponent(id));
    if(result.project?.id===currentProject?.id||result.project?.path===projectPath)setCurrentProject(result.project);
    if(result.job?.status==="completed"&&result.project?.path){
      api("/api/git/info?path="+encodeURIComponent(result.project.path)+"&environmentId="+encodeURIComponent(result.project.environmentId||"")).then(setGitInfo).catch(()=>{});
    }
    return result;
  }
  async function cloneProjectAction(action){
    const id=currentProject?.cloneJob?.id;if(!id)return null;
    const result=await api("/api/clone-jobs",{method:"POST",body:{action,id}});
    if(result.project)setCurrentProject(result.project);
    return result;
  }
  async function waitForActiveClone(){
    let job=currentProject?.cloneJob;
    if(!job||job.status==="completed")return;
    if(job.status==="failed")throw new Error(job.error||"Repository clone failed. Retry the clone before sending.");
    if(job.status==="cancelled")throw new Error("Repository clone was cancelled. Retry the clone before sending.");
    while(["running","cancelling"].includes(job.status)){
      await new Promise(resolveWait=>setTimeout(resolveWait,400));
      const result=await refreshCloneJob(job.id);job=result?.job||job;
    }
    if(job.status!=="completed")throw new Error(job.error||("Repository clone "+job.status+"."));
  }
  useEffect(()=>{
    const job=currentProject?.cloneJob;if(!job||!["running","cancelling"].includes(job.status))return;
    const timer=setInterval(()=>refreshCloneJob(job.id).catch(()=>{}),750);
    return()=>clearInterval(timer);
  },[currentProject?.cloneJob?.id,currentProject?.cloneJob?.status,projectPath]);
  async function refreshEnvironmentThemes(){
    const catalog=await api("/api/environment/themes").catch(()=>({environmentKey:bootstrap.activeEnvironmentId||"local",environmentName:bootstrap.activeEnvironment?.name||"Local machine",directory:"",themes:[]}));
    setEnvironmentThemeCatalog(catalog);
    return catalog;
  }

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      const [boot,state,modelData,themeCatalog,projectData]=await Promise.all([api("/api/bootstrap").catch(()=>({mock:true,loggedIn:true,cwd:"",platform:""})),api("/api/state").catch(()=>({settings:{},projects:[],threadMeta:{}})),api("/api/models").catch(error=>({models:[],error:error.message})),api("/api/environment/themes").catch(()=>({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})),api("/api/projects").catch(()=>({projects:[]}))]);
      if(cancelled)return; setBootstrap(boot); setSettings(prev=>({...prev,...(state.settings||{})})); setPermissionMode(state.settings?.defaultPermissionMode||"supervised"); setThreadMeta(state.threadMeta||{});
      setEnvironmentThemeCatalog(themeCatalog);
      const activeEnvironmentId=state.settings?.activeEnvironmentId||null;
      const projectsForEnvironment=(projectData.projects||state.projects||[]).filter(project=>(project.environmentId||null)===activeEnvironmentId);
      const activeProject=projectsForEnvironment.find(project=>project.id===state.settings?.activeProjectId)||null;
      const firstProject=projectsForEnvironment[0]||null;
      const environmentCwd=boot.activeEnvironment?.cwd||"";
      const initialProject=activeProject||(environmentCwd?projectsForEnvironment.find(project=>String(project.path)===String(environmentCwd)):null)||firstProject;
      const initialPath=initialProject?.path||environmentCwd||(!activeEnvironmentId?boot.cwd:"")||"";
      setCurrentProject(initialProject);
      setProjectPath(initialPath);
      const availableModels=modelData.models||[];
      setModelError(modelData.error||"");
      setModelMeta(Object.fromEntries((modelData.metadata?.models||[]).map(item=>[item.id,item]))); const fallback=availableModels.length?availableModels:(boot.mock?["freebuff/deepseek/deepseek-v4-flash","freebuff/test/coding-large","freebuff/test/coding-fast"]:[]);
      const initialScoped=initialProject?.effectiveSettings||{};
      const initialModel=(initialScoped.defaultModel&&fallback.includes(initialScoped.defaultModel))?initialScoped.defaultModel:(fallback[0]||"");
      setModels(fallback); setModel(initialModel);setSelectedModels(initialModel?[initialModel]:[]);
      setPermissionMode(initialScoped.defaultPermissionMode||state.settings?.defaultPermissionMode||"supervised");
      setWorkspaceMode(initialScoped.defaultWorkspaceMode||state.settings?.defaultWorkspaceMode||"current");
      if(initialProject?.permissionMode)setPermissionMode(initialProject.permissionMode);
      if(initialProject?.workspaceMode)setWorkspaceMode(initialProject.workspaceMode);
      if(window.trebellDesktop?.background&&state.settings?.backgroundMode!=null)window.trebellDesktop.background.set(Boolean(state.settings.backgroundMode)).catch?.(()=>{});
      if((state.settings?.agentRuntime||boot.agentRuntime||"codex")==="codex"&&(state.settings?.modelProvider||boot.provider||"freebuff")==="freebuff"&&initialModel){const p=new URLSearchParams({timezone,model:initialModel});const fb=await api("/api/freebuff/overview?"+p).catch(()=>null);if(fb&&!cancelled)setFreebuff(fb)}
      if(!cancelled)setInitialLoaded(true);
    })().catch(()=>{if(!cancelled)setInitialLoaded(true)}); return()=>{cancelled=true};
  },[]);

  async function ensureSections(client){
    if(agentRuntime!=="codex"){
      const local=Object.fromEntries(["Pinned","Snoozed","Settled"].map(name=>[name,{id:name,name}]));setSections(local);return local;
    }
    const listed=await client.request("threadSection/list",{limit:50}).catch(()=>({data:[]})); const map=Object.fromEntries((listed.data||[]).map(s=>[s.name,s]));
    for(const name of ["Pinned","Snoozed","Settled"]){if(!map[name]){const made=await client.request("threadSection/create",{name}).catch(()=>null);if(made?.section)map[name]=made.section}}
    setSections(map); return map;
  }
  async function loadThreads(client){
    const listed=await client.request("thread/list",threadListParams(100)).catch(()=>({data:[]})); setThreads(listed.data||[]); return listed.data||[];
  }
  async function loadCollaborationModes(client=rpcRef.current){
    if(agentRuntime!=="codex"||!client){
      setCollaborationModes([]);setCollaborationMode("default");return[];
    }
    const result=await client.request("collaborationMode/list",{}).catch(()=>({data:[]}));
    const modes=normalizeCollaborationModes(result?.data||[]);
    setCollaborationModes(modes);
    setCollaborationMode(current=>modes.some(item=>item.mode===current)?current:(modes.some(item=>item.mode==="default")?"default":modes[0]?.mode||"default"));
    return modes;
  }
  function selectedCollaborationMode(modelId=model){
    return agentRuntime==="codex"?collaborationModePayload(collaborationModes,collaborationMode,modelId):null;
  }
  async function changeCollaborationMode(nextMode){
    if(!collaborationModes.some(item=>item.mode===nextMode))return;
    const previous=collaborationMode;setCollaborationMode(nextMode);
    if(agentRuntime!=="codex"||!rpc||rpcStatus!=="connected"||!activeThread?.id||running)return;
    const payload=collaborationModePayload(collaborationModes,nextMode,model);if(!payload)return;
    setCollaborationModeBusy(true);
    try{await rpc.request("thread/settings/update",{threadId:activeThread.id,collaborationMode:payload})}
    catch(error){
      setCollaborationMode(previous);
      setEvents(prev=>[...prev,{id:"collaboration-mode-error-"+Date.now(),kind:"error",title:"Could not change Codex mode: "+(error.message||String(error)),status:"done",raw:{}}]);
    }finally{setCollaborationModeBusy(false)}
  }
  async function loadThreadRuntimeProfiles(client=rpc,threadId=activeThreadRef.current?.id){
    if(!["codex","claude"].includes(agentRuntime)||!client||rpcStatus!=="connected"||!threadId){
      setThreadRuntimeProfiles({supported:false,currentInstanceId:null,items:[]});return {supported:false,currentInstanceId:null,items:[]};
    }
    const result=await client.request("thread/runtimeInstances/list",{threadId}).catch(error=>({supported:false,currentInstanceId:null,items:[],reason:error.message||String(error)}));
    setThreadRuntimeProfiles(result||{supported:false,currentInstanceId:null,items:[]});return result;
  }
  async function switchThreadRuntimeProfile(instanceId){
    const threadId=activeThreadRef.current?.id;if(!["codex","claude"].includes(agentRuntime)||!rpc||rpcStatus!=="connected"||!threadId||!instanceId)return;
    setThreadRuntimeProfileBusy(instanceId);
    try{
      const result=await rpc.request("thread/runtimeInstance/set",{threadId,instanceId});
      let updated=result?.thread;
      if(agentRuntime==="codex"){
        const resumed=await rpc.request("thread/resume",{threadId,model:model||null,modelProvider:provider,cwd:activeThreadRef.current?.cwd||null,excludeTurns:true});
        updated=resumed?.thread||updated;
      }
      if(updated){
        activeThreadRef.current=updated;
        setActiveThread(prev=>prev?.id===updated.id?updated:prev);
        setThreads(prev=>prev.map(thread=>thread.id===updated.id?{...thread,...updated}:thread));
      }
      const profiles=await loadThreadRuntimeProfiles(rpc,threadId);
      if(agentRuntime==="codex")await loadSkills(rpc,projectPath,true).catch(()=>{});
      const selected=(profiles?.items||[]).find(item=>item.id===instanceId);
      const label=agentRuntime==="codex"?"Codex":"Claude";
      setEvents(prev=>[...prev,{id:"runtime-profile-"+Date.now(),kind:"tool",title:`${label} profile switched to ${selected?.displayName||instanceId}`,status:"done",raw:{instanceId}}]);
    }catch(error){
      const label=agentRuntime==="codex"?"Codex":"Claude";
      setEvents(prev=>[...prev,{id:"runtime-profile-error-"+Date.now(),kind:"error",title:`Could not switch ${label} profile: `+(error.message||String(error)),status:"done",raw:{instanceId}}]);
    }finally{setThreadRuntimeProfileBusy("")}
  }
  async function searchThreadMessages(queryText){
    const needle=String(queryText||"").trim();if(needle.length<2||!rpc||rpcStatus!=="connected")return[];
    const candidates=threads.slice(0,50);const cache=threadMessageSearchCacheRef.current;let cursor=0;
    const results=[];const matched=new Set();
    for(const thread of candidates){
      const excerpt=matchingPullRequestExcerpt(threadMeta[thread.id]||{},needle);
      if(excerpt){results.push({threadId:thread.id,excerpt:"PR · "+excerpt,thread});matched.add(thread.id)}
    }
    if(agentRuntime==="codex"){
      const response=await rpc.request("thread/search",{searchTerm:needle,limit:50,sortKey:"recency_at",sortDirection:"desc",archived:false}).catch(()=>null);
      if(response?.data){
        const native=nativeThreadSearchMatches(response);
        const merged=new Map(results.map(item=>[item.threadId,item]));
        for(const item of native)if(!merged.has(item.threadId))merged.set(item.threadId,item);
        if(native.length)setThreads(prev=>{
          const known=new Set(prev.map(thread=>thread.id));
          const extra=native.map(item=>item.thread).filter(thread=>thread?.id&&!known.has(thread.id));
          return extra.length?[...prev,...extra]:prev;
        });
        return [...merged.values()];
      }
    }
    const searchable=candidates.filter(thread=>!matched.has(thread.id));
    const workers=Array.from({length:Math.min(8,searchable.length)},async()=>{
      while(cursor<searchable.length){
        const thread=searchable[cursor++];const version=Number(thread.updatedAt||0);let cached=cache.get(thread.id);
        if(!cached||cached.updatedAt!==version){
          const response=await rpc.request("thread/items/list",{threadId:thread.id,limit:150,sortDirection:"desc"}).catch(()=>({data:[]}));
          cached={updatedAt:version,items:response.data||[]};cache.set(thread.id,cached);
        }
        const excerpt=matchingMessageExcerpt(cached.items,needle);if(excerpt)results.push({threadId:thread.id,excerpt,thread});
      }
    });
    await Promise.all(workers);
    if(cache.size>100){const keep=new Set(threads.slice(0,100).map(thread=>thread.id));for(const id of cache.keys())if(!keep.has(id))cache.delete(id)}
    return results;
  }
  async function loadSkills(client,path=projectPath,forceReload=false){
    if(agentRuntime!=="codex")return;
    if(!path)return;
    const threadId=activeThreadRef.current?.id||null;
    const params={cwds:[path],forceReload:Boolean(forceReload),...(threadId?{_trebellThreadId:threadId}:{})};
    const result=await client.request("skills/list",params).catch(()=>({data:[]}));
    setSkills((result.data||[]).flatMap(x=>x.skills||[]));
  }
  async function recoverCodexAfterRestart(client){
    if(agentRuntime!=="codex")return;
    const recovery=await api("/api/recovery").catch(()=>null);if(!recovery?.enabled||!recovery.items?.length)return;
    for(const item of recovery.items){
      try{
        await client.request("thread/resume",{threadId:item.threadId,modelProvider:provider,excludeTurns:true});
        let recent;
        try{recent=await client.request("thread/turns/list",{threadId:item.threadId,limit:20,sortDirection:"desc",itemsView:"notLoaded"})}
        catch{const legacy=await client.request("thread/read",{threadId:item.threadId,includeTurns:true}).catch(()=>({thread:{turns:[]}}));recent={data:legacy?.thread?.turns||[]}}
        const previous=(recent?.data||[]).find(turn=>turn.id===item.turnId);
        if(previous&&["completed","failed","cancelled","interrupted"].includes(previous.status)){
          await api("/api/recovery",{method:"POST",body:{threadId:item.threadId,action:"clear"}}).catch(()=>{});continue;
        }
        await client.request("turn/start",{threadId:item.threadId,input:[],turnTrigger:"trebell-restart-continuation"});
      }catch(error){
        await api("/api/recovery",{method:"POST",body:{threadId:item.threadId,action:"failed",message:error.message||String(error)}}).catch(()=>{});
      }
    }
  }

  function applyProviderInventory(update={}){
    if(Array.isArray(update.commands))setProviderCommands(update.commands);
    if(Array.isArray(update.skills))setSkills(update.skills.filter(skill=>skill?.enabled!==false));
    if(Array.isArray(update.agents)){
      const visible=update.agents.filter(agent=>typeof agent==="string"||agent?.hidden!==true).filter(agent=>typeof agent==="string"?agent:Boolean(agent?.name));
      setProviderAgents(visible);
      setProviderAgent(current=>current&&visible.some(agent=>(typeof agent==="string"?agent:agent.name)===current)?current:"");
    }
  }

  useEffect(()=>{
    if(!bootstrap.wsUrl||bootstrap.mock)return; let disposed=false,retryTimer=null,client=null;
    const connect=async(attempt=0)=>{
      client=new CodexRpcClient(bootstrap.wsUrl,{clientVersion:bootstrap.version||"0.0.0",onStatus:setRpcStatus,onNotification:handleNotification,onServerRequest:m=>handleServerRequest(client,m)}); rpcRef.current=client;setRpc(client);
      try{
        await client.connect();if(disposed)return;await recoverCodexAfterRestart(client);await ensureSections(client);
        const listed=await loadThreads(client);const activeId=activeThreadRef.current?.id;const reopen=activeId?(listed||[]).find(thread=>thread.id===activeId):null;
        if(reopen)await openThread(reopen,{client,preserveSection:true});
        await Promise.all([loadSkills(client,projectPath),loadCollaborationModes(client)]);
      }
      catch(error){client.close();if(disposed)return;if(attempt<120){setRpcStatus("connecting");retryTimer=setTimeout(()=>connect(attempt+1),500)}else setRpcStatus("error")}
    };
    connect(); return()=>{disposed=true;clearTimeout(retryTimer);client?.close()};
  },[bootstrap.wsUrl,bootstrap.mock,provider,agentRuntime,providerRevision]);
  useEffect(()=>{if(rpcStatus==="connected"&&rpc)loadSkills(rpc,projectPath)},[projectPath,rpcStatus]);
  useEffect(()=>{
    if(["codex","claude"].includes(agentRuntime)&&rpcStatus==="connected"&&rpc&&activeThread?.id){loadThreadRuntimeProfiles(rpc,activeThread.id);return}
    setThreadRuntimeProfiles({supported:false,currentInstanceId:null,items:[]});setThreadRuntimeProfileBusy("");
  },[agentRuntime,rpc,rpcStatus,activeThread?.id]);

  useEffect(()=>{const timer=setInterval(async()=>{const [s,r,g]=await Promise.all([api("/api/stats").catch(()=>null),api("/api/runtime").catch(()=>null),!projectlessMode&&projectPath&&!workspaceRemote?api("/api/git/info?path="+encodeURIComponent(projectPath)).catch(()=>null):Promise.resolve(null)]);if(s)setStats(s);if(r)setRuntime(r);setGitInfo(projectlessMode?null:g)},1800);return()=>clearInterval(timer)},[projectPath,workspaceRemote,projectlessMode]);
  useEffect(()=>{if(agentRuntime!=="codex"||provider!=="freebuff"||!(bootstrap.loggedIn||bootstrap.mock))return;refreshFreebuff(model);const timer=setInterval(()=>refreshFreebuff(model),15000);return()=>clearInterval(timer)},[agentRuntime,provider,bootstrap.loggedIn,bootstrap.mock,model,timezone]);
  useEffect(()=>{if(agentRuntime!=="codex"||provider!=="freebuff"||!running||!(bootstrap.loggedIn||bootstrap.mock))return;const ping=()=>{const p=new URLSearchParams({timezone});if(model)p.set("model",model);fetch("/api/freebuff/heartbeat?"+p,{method:"POST"}).catch(()=>{})};ping();const timer=setInterval(ping,45000);return()=>clearInterval(timer)},[agentRuntime,provider,running,bootstrap.loggedIn,bootstrap.mock,model,timezone]);

  useEffect(()=>{const timer=setInterval(async()=>{if(!rpc||rpcStatus!=="connected")return;const now=Date.now();for(const thread of threads){const meta=threadMeta[thread.id];if(thread.section?.name==="Snoozed"&&meta?.snoozedUntil&&meta.snoozedUntil<=now){await moveThread(thread,"active");await updateThreadMeta(thread.id,{snoozedUntil:null})}}},30000);return()=>clearInterval(timer)},[rpc,rpcStatus,threads,threadMeta,sections]);
  useEffect(()=>{
    if(!settings.autoSettleMergedThreads||!rpc||rpcStatus!=="connected")return;
    let disposed=false,busy=false;
    const applyPending=async()=>{
      if(disposed||busy)return;busy=true;
      try{
        const pending=await api("/api/source-control/settlements").catch(()=>null);
        for(const item of pending?.items||[]){
          if(disposed)break;
          const thread=threads.find(candidate=>candidate.id===item.threadId);
          if(!thread||thread.archived||thread.status?.type==="active")continue;
          if(thread.section?.name!=="Settled")await moveThread(thread,"settle");
          await updateThreadMeta(thread.id,{autoSettlePending:null,autoSettleAppliedSignature:item.signature,autoSettledAt:Date.now()});
        }
      }finally{busy=false}
    };
    applyPending();const timer=setInterval(applyPending,30000);
    return()=>{disposed=true;clearInterval(timer)};
  },[settings.autoSettleMergedThreads,rpc,rpcStatus,threads,sections]);
  useEffect(()=>{
    let disposed=false;
    const refreshBranchReviews=async()=>{
      const data=await api("/api/source-control/branch-reviews").catch(()=>null);if(disposed||!data?.items)return;
      setThreadMeta(previous=>{
        let changed=false;const next={...previous};
        for(const item of data.items){
          const current=previous[item.threadId]||{};
          const review=item.review||null;
          const sameReview=JSON.stringify(current.branchPullRequest||null)===JSON.stringify(review);
          const sameSync=Number(current.lastBranchPullRequestSyncAt||0)===Number(item.lastSyncedAt||0);
          const sameError=(current.branchPullRequestSyncError||null)===(item.error||null);
          if(sameReview&&sameSync&&sameError)continue;
          changed=true;next[item.threadId]={...current,branch:item.branch||current.branch||null,branchPullRequest:review,lastBranchPullRequestSyncAt:item.lastSyncedAt||null,branchPullRequestSyncError:item.error||null};
        }
        return changed?next:previous;
      });
    };
    refreshBranchReviews();const timer=setInterval(refreshBranchReviews,30_000);
    return()=>{disposed=true;clearInterval(timer)};
  },[]);

  useEffect(()=>{
    if(!query.trim()){setSearchResults(null);return} const q=query.toLowerCase(); const titleMatches=threads.filter(t=>titleOf(t).toLowerCase().includes(q)||(t.cwd||"").toLowerCase().includes(q)||Boolean(matchingPullRequestExcerpt(threadMeta[t.id]||{},q)));
    if(!rpc||rpcStatus!=="connected"||query.length<2){setSearchResults(titleMatches);return}
    let cancelled=false; const timer=setTimeout(async()=>{const found=new Map(titleMatches.map(t=>[t.id,t]));const matches=await searchThreadMessages(query);for(const match of matches){const thread=match.thread||threads.find(item=>item.id===match.threadId);if(thread)found.set(thread.id,thread)}if(!cancelled)setSearchResults([...found.values()])},250);return()=>{cancelled=true;clearTimeout(timer)}
  },[query,threads,threadMeta,rpc,rpcStatus,agentRuntime]);

  function showActionError(error,label="Action failed"){
    const detail=error?.message||String(error)||"Unknown error";
    if(actionErrorTimerRef.current)clearTimeout(actionErrorTimerRef.current);
    setActionError(label+": "+detail);
    actionErrorTimerRef.current=setTimeout(()=>{actionErrorTimerRef.current=null;setActionError("")},6000);
  }
  function runUserAction(action,label){
    if(actionErrorTimerRef.current)clearTimeout(actionErrorTimerRef.current);
    actionErrorTimerRef.current=null;setActionError("");
    return Promise.resolve().then(action).catch(error=>{showActionError(error,label);return null});
  }
  useEffect(()=>()=>{if(actionErrorTimerRef.current)clearTimeout(actionErrorTimerRef.current)},[]);
  async function copyText(value){const text=String(value||"").trim();return text?writeClipboardText(text):false}
  async function copyActiveReference(){
    const selectedUrl=rightPanelOpen&&rightPanelTab==="source"?sourceSelectedPr?.url:null;if(selectedUrl){if(!await copyText(selectedUrl))throw new Error("Could not copy to clipboard.");return}
    const linkedUrl=linkedPullRequests.find(link=>link?.url)?.url;
    if(!await copyText(linkedUrl||activeThread?.id||""))throw new Error("Could not copy to clipboard.");
  }
  async function copyActivePullRequestNumber(){if(rightPanelOpen&&rightPanelTab==="source"&&sourceSelectedPr?.number&&!await copyText("#"+sourceSelectedPr.number))throw new Error("Could not copy to clipboard.")}

  useEffect(()=>{const onHistory=event=>{const sent=messages.filter(m=>m.role==="user").map(m=>m.text);if(!sent.length)return;let next=promptHistoryIndex;if(event.detail<0)next=Math.min(sent.length-1,next+1);else next=Math.max(-1,next-1);setPromptHistoryIndex(next);setPrompt(next<0?"":sent[sent.length-1-next])};window.addEventListener("trebell:history",onHistory);return()=>window.removeEventListener("trebell:history",onHistory)},[messages,promptHistoryIndex]);
  useEffect(()=>{
    const key=event=>{
      const active=document.activeElement;
      const context={
        chatFocus:section==="chat"||section==="new",
        codexRuntime:agentRuntime==="codex",
        terminalFocus:Boolean(panel==="terminal"&&active?.closest?.(".terminal-drawer")),
        terminalOpen:panel==="terminal",
        previewFocus:Boolean(rightPanelOpen&&rightPanelTab==="preview"),
        modelPickerOpen:Boolean(modelPickerOpen),
        textInputFocus:Boolean(active&&["INPUT","TEXTAREA","SELECT"].includes(active.tagName)),
        projectOpen:Boolean(projectPath&&!projectlessMode),
        threadOpen:Boolean(activeThread?.id),
        running:Boolean(running),
        modalOpen:Boolean(paletteOpen||question||elicitations.length||approvals.length||snoozeRequest||settings.onboardingComplete===false),
        rightPanelOpen:Boolean(rightPanelOpen),
        sidebarOpen:Boolean(sidebarOpen),
        undoAvailable:Boolean(threadUndo),
        pullRequestOpen:Boolean(rightPanelOpen&&rightPanelTab==="source"&&sourceSelectedPr?.number),
        desktop:Boolean(window.trebellDesktop),
      };
      const command=resolveKeybinding(event,settings,context);
      if(!command)return;
      event.preventDefault();
      if(command==="newChat")runUserAction(newChat,"Could not start a new thread");
      else if(command==="commandPalette")setPaletteOpen(value=>!value);
      else if(command==="navigationBack")runUserAction(()=>navigateHistory(-1),"Could not navigate back");
      else if(command==="navigationForward")runUserAction(()=>navigateHistory(1),"Could not navigate forward");
      else if(command==="sidebarToggle")setSidebarOpen(value=>!value);
      else if(command==="threadStop")runUserAction(stop,"Could not stop turn");
      else if(command==="threadSettle"&&activeThread?.id)runUserAction(()=>reversibleThreadAction(activeThread,activeThread.section?.name==="Settled"?"active":"settle"),"Could not update thread");
      else if(command==="threadPin"&&activeThread?.id)runUserAction(()=>reversibleThreadAction(activeThread,activeThread.section?.name==="Pinned"?"active":"pin"),"Could not update thread");
      else if(command==="threadPrevious"||command==="threadNext"){
        const index=displayThreads.findIndex(thread=>thread.id===activeThread?.id);
        const delta=command==="threadPrevious"?-1:1;const next=displayThreads[index>=0?index+delta:-1];
        if(next)runUserAction(()=>openThread(next),"Could not open thread");
      }
      else if(command==="threadFind")openThreadFind();
      else if(command.startsWith("threadJump")){
        const index=Number(command.slice("threadJump".length))-1;const target=displayThreads[index];
        if(target)runUserAction(()=>openThread(target),"Could not open thread");
      }
      else if(command==="stash")stashPrompt();
      else if(command==="terminal")setPanel(value=>value==="terminal"?null:"terminal");
      else if(command==="terminalFocus"){setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-focus")),0)}
      else if(command==="composerFocus"){document.querySelector('[data-testid="composer"]')?.focus()}
      else if(command==="terminalSplit"){setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-split",{detail:{direction:"horizontal"}})),0)}
      else if(command==="terminalSplitVertical"){setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-split",{detail:{direction:"vertical"}})),0)}
      else if(command==="terminalNew"){setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-new")),0)}
      else if(command==="terminalClose")window.dispatchEvent(new CustomEvent("trebell:terminal-close"));
      else if(command==="rightPanelClose"){setRightPanelOpen(false);setRightPanelMaximized(false)}
      else if(command==="rightPanelToggle"){if(rightPanelOpen){setRightPanelOpen(false);setRightPanelMaximized(false)}else openRightPanel(rightPanelTab||"files")}
      else if(command==="rightPanelMaximize")setRightPanelMaximized(value=>!value);
      else if(command==="diffToggle"){
        if(rightPanelOpen&&rightPanelTab==="diff"){setRightPanelOpen(false);setRightPanelMaximized(false)}else openRightPanel("diff");
      }
      else if(command==="previewToggle"){
        if(rightPanelOpen&&rightPanelTab==="preview"){setRightPanelOpen(false);setRightPanelMaximized(false)}else openRightPanel("preview");
      }
      else if(command==="previewRefresh")window.dispatchEvent(new CustomEvent("trebell:preview-command",{detail:{action:"refresh"}}));
      else if(command==="previewFocusUrl")window.dispatchEvent(new CustomEvent("trebell:preview-command",{detail:{action:"focusUrl"}}));
      else if(command==="previewZoomIn")window.dispatchEvent(new CustomEvent("trebell:preview-command",{detail:{action:"zoomIn"}}));
      else if(command==="previewZoomOut")window.dispatchEvent(new CustomEvent("trebell:preview-command",{detail:{action:"zoomOut"}}));
      else if(command==="previewResetZoom")window.dispatchEvent(new CustomEvent("trebell:preview-command",{detail:{action:"resetZoom"}}));
      else if(command==="projectSearch"){setSidebarOpen(true);setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:sidebar-search")),0)}
      else if(command==="files")openRightPanel("files");
      else if(command==="source")openRightPanel("source");
      else if(command==="goal"&&activeThread?.id)openRightPanel("goal");
      else if(command==="projects")setSection("projects");
      else if(command==="settings")setSection("settings");
      else if(command==="environments")setSection("environments");
      else if(command==="steerQueued"&&queued.length)sendQueuedNow(queued[0]);
      else if(command==="undoThreadAction")undoThreadAction();
      else if(command==="copyReference")runUserAction(copyActiveReference,"Copy failed");
      else if(command==="copyPullRequestNumber")runUserAction(copyActivePullRequestNumber,"Copy failed");
      else if(command==="modelPicker")window.dispatchEvent(new CustomEvent("trebell:model-picker",{detail:{action:"toggle"}}));
      else if(command.startsWith("modelJump"))window.dispatchEvent(new CustomEvent("trebell:model-picker",{detail:{action:"jump",index:Number(command.slice("modelJump".length))-1}}));
      else if(/^script\..+\.run$/.test(command)){
        const scriptId=command.slice(7,-4);const script=(currentProject?.scripts||[]).find(item=>item.id===scriptId);
        if(script)runUserAction(()=>runProjectAction(script),"Project action failed")
      }
      else if(command==="cycleTheme")cycleTheme();
      else if(command==="cycleAppearance")cycleAppearance();
    };
    window.addEventListener("keydown",key);
    return()=>window.removeEventListener("keydown",key);
  },[settings,prompt,attachments,section,panel,paletteOpen,question,elicitations.length,approvals.length,snoozeRequest,threadUndo,projectPath,projectlessMode,activeThread,running,rightPanelOpen,rightPanelTab,sourceSelectedPr,linkedPullRequests,queued,sidebarOpen,displayThreads,modelPickerOpen,currentProject,agentRuntime]);
  useEffect(()=>{if(agentRuntime==="codex"&&(queueMode==="native"||queued[0]?.native))return;if(!running&&queued.length){const next=queued[0];setQueued(prev=>prev.slice(1));startTurn(next.text,next.attachments,next.model||model).catch(error=>setEvents(prev=>[...prev,{id:"queue-error-"+Date.now(),kind:"error",title:error.message,status:"done"}]))}},[running,queued,queueMode,agentRuntime]);
  useEffect(()=>{setQueueMode(agentRuntime==="codex"?"unknown":"local");setQueuedEditId(null)},[agentRuntime]);

  function handleServerRequest(client,message){
    if(message.method==="item/tool/requestUserInput"){setQuestion({client,request:message});desktopNotify("Trebell Code needs input","The running agent asked you a question.");return}
    if(message.method==="mcpServer/elicitation/request"){
      setElicitations(prev=>[...prev,{client,request:message}]);
      const meta=message.params?._meta||{};
      const actor=meta.connector_name||meta.connector_id||message.params?.serverName||"An app";
      const action=meta.tool_title||meta.tool_name||"needs input";
      desktopNotify("App approval required",`${actor}: ${action}`);
      return;
    }
    if(message.method==="item/tool/call"){
      const p=message.params||{};
      if(p.namespace==="trebell_browser"){
        (async()=>{
          try{
            if(!window.trebellDesktop?.browser)throw new Error("Agent browser is only available in the desktop app.");
            let result;
            if(p.tool==="open")result=await window.trebellDesktop.browser.navigate(p.arguments?.url);
            else if(p.tool==="snapshot")result=await window.trebellDesktop.browser.snapshot();
            else if(p.tool==="click")result=await window.trebellDesktop.browser.click(p.arguments?.ref);
            else if(p.tool==="type")result=await window.trebellDesktop.browser.type(p.arguments?.ref,p.arguments?.text);
            else if(p.tool==="screenshot"){
              const shot=await window.trebellDesktop.browser.screenshot();
              client.respond(message.id,{contentItems:[{type:"inputImage",imageUrl:shot.dataUrl},{type:"inputText",text:JSON.stringify({url:shot.url,title:shot.title})}],success:true});
              return;
            }else throw new Error("Unknown Trebell browser tool: "+p.tool);
            client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true});
          }catch(error){
            client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false});
          }
        })();
        return;
      }
      if(p.namespace==="trebell_computer"){
        (async()=>{
          try{
            if(!window.trebellDesktop?.computer)throw new Error("Computer use is only available in the Windows desktop app.");
            const args=p.arguments||{};
            if(p.tool!=="screenshot"&&permissionMode!=="full")throw new Error("Desktop mouse and keyboard control requires Full access mode.");
            if(p.tool==="screenshot"){
              const shot=await window.trebellDesktop.computer.screenshot();
              client.respond(message.id,{contentItems:[{type:"inputImage",imageUrl:shot.dataUrl},{type:"inputText",text:JSON.stringify({width:shot.width,height:shot.height,displayId:shot.displayId,originX:shot.originX,originY:shot.originY,scaleFactor:shot.scaleFactor})}],success:true});
              return;
            }
            let result;
            if(p.tool==="move")result=await window.trebellDesktop.computer.move(args.x,args.y);
            else if(p.tool==="click")result=await window.trebellDesktop.computer.click(args);
            else if(p.tool==="scroll")result=await window.trebellDesktop.computer.scroll(args.delta);
            else if(p.tool==="type")result=await window.trebellDesktop.computer.type(args.text);
            else if(p.tool==="key")result=await window.trebellDesktop.computer.key(args.key);
            else throw new Error("Unknown Trebell computer tool: "+p.tool);
            client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true});
          }catch(error){
            client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false});
          }
        })();
        return;
      }
      if(p.namespace==="trebell_device"){
        (async()=>{
          try{
            if(!effectiveProjectSettings.agentDeviceAccess)throw new Error("Agent device access is disabled for this project.");
            const args=p.arguments||{};
            if(p.tool==="list"){
              const result=await api("/api/devices");
              client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true});return;
            }
            if(p.tool==="screenshot"){
              const shot=await api("/api/device/screenshot?id="+encodeURIComponent(args.id||""));
              client.respond(message.id,{contentItems:[{type:"inputImage",imageUrl:shot.dataUrl},{type:"inputText",text:JSON.stringify({id:shot.id,platform:shot.platform,width:shot.width,height:shot.height})}],success:true});return;
            }
            let result;
            if(p.tool==="tap")result=await api("/api/device/action",{method:"POST",body:{id:args.id,action:"tap",args:{x:args.x,y:args.y}}});
            else if(p.tool==="type")result=await api("/api/device/action",{method:"POST",body:{id:args.id,action:"type",args:{text:args.text}}});
            else if(p.tool==="key")result=await api("/api/device/action",{method:"POST",body:{id:args.id,action:"key",args:{key:args.key}}});
            else if(p.tool==="foreground")result=await api("/api/device/action",{method:"POST",body:{id:args.id,action:"foreground",args:{}}});
            else throw new Error("Unknown Trebell device tool: "+p.tool);
            client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true});
          }catch(error){client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false})}
        })();
        return;
      }
      if(p.namespace==="trebell_source_control"){
        (async()=>{
          try{
            if(p.tool!=="link_pull_request")throw new Error("Unknown Trebell source-control tool: "+p.tool);
            if(!activeThread?.id)throw new Error("A Trebell thread must be open before linking a pull request.");
            const result=await linkPullRequestUrl(p.arguments?.url,"agent");
            client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify({linked:true,number:result?.link?.number,url:result?.link?.url})}],success:true});
          }catch(error){client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false})}
        })();
        return;
      }
      client.respond(message.id,{contentItems:[{type:"inputText",text:"No client-defined dynamic tool is registered for "+(p.namespace||"default")+"/"+p.tool}],success:false});
      return;
    }
    if(permissionMode==="edits"&&message.method==="item/fileChange/requestApproval"){client.respond(message.id,{decision:"accept"});return}
    if(permissionMode==="edits"&&message.method==="applyPatchApproval"){client.respond(message.id,{decision:"approved"});return}
    if(message.method.includes("requestApproval")||message.method==="applyPatchApproval"||message.method==="execCommandApproval"){setApprovals(prev=>[...prev,message]);desktopNotify("Approval required",message.params?.reason||message.params?.command||"Trebell Code is waiting for permission.");return}
    client.reject(message.id,-32601,"Unsupported Trebell client request: "+message.method);
  }
  function handleNotification(message){
    const p=message.params||{};
    const threadId=p.threadId||null;
    const isCurrent=notificationIsActive(threadId);
    if(message.method==="serverRequest/resolved"){
      const requestId=String(p.requestId??"");
      const matches=request=>request&&String(request.id)===requestId&&(!p.threadId||!request.params?.threadId||request.params.threadId===p.threadId);
      setApprovals(prev=>prev.filter(request=>!matches(request)));
      setQuestion(current=>current&&matches(current.request)?null:current);
      setElicitations(prev=>prev.filter(item=>!matches(item.request)));
    }
    else if(message.method==="thread/started"&&p.thread){
      setThreads(prev=>[p.thread,...prev.filter(t=>t.id!==p.thread.id)]);
      if(activeThreadRef.current?.id===p.thread.id)setActiveThread(p.thread);
    }
    else if(message.method==="thread/status/changed"&&threadId&&p.status){
      setThreads(prev=>prev.map(t=>t.id===threadId?{...t,status:p.status,updatedAt:Date.now()/1000}:t));
      if(isCurrent)setActiveThread(prev=>prev?.id===threadId?{...prev,status:p.status,updatedAt:Date.now()/1000}:prev);
      updateThreadTelemetry(threadId,{status:p.status,lastActivityAt:Date.now()});
    }
    else if(message.method==="thread/name/updated"){
      setThreads(prev=>prev.map(t=>t.id===p.threadId?{...t,name:p.name}:t));
      if(isCurrent)setActiveThread(prev=>prev?.id===p.threadId?{...prev,name:p.name}:prev);
    }
    else if(message.method==="thread/project/updated"){
      setThreads(prev=>prev.map(t=>t.id===p.threadId?{...t,projectId:p.projectId||null}:t));
      if(isCurrent){
        setActiveThread(prev=>prev?.id===p.threadId?{...prev,projectId:p.projectId||null}:prev);
        if(activeThreadRef.current?.id===p.threadId)activeThreadRef.current={...activeThreadRef.current,projectId:p.projectId||null};
      }
    }
    else if(message.method==="thread/settings/updated"&&isCurrent){
      const nextMode=p.threadSettings?.collaborationMode?.mode;
      if(nextMode)setCollaborationMode(nextMode);
    }
    else if(message.method==="thread/reverted"&&isCurrent)reloadActiveThread();
    else if(message.method==="turn/started"){
      const id=p.turn?.id||p.turnId;
      updateThreadTelemetry(threadId,{turnId:id||null,turnStartedAtMs:p.turn?.startedAt?Number(p.turn.startedAt)*1000:Date.now(),lastActivityAt:Date.now()});
      if(isCurrent){
        setRunning(true);setActiveTurnId(id);
        setMessages(prev=>{const index=[...prev].reverse().findIndex(m=>m.role==="user"&&!m.turnId);if(index<0)return prev;const real=prev.length-1-index;return prev.map((m,i)=>i===real?{...m,turnId:id}:m)});
      }
    }
    else if(message.method==="turn/completed"){
      const completedAtMs=p.turn?.completedAt?Number(p.turn.completedAt)*1000:Date.now();
      updateThreadTelemetry(threadId,{turnId:null,turnStartedAtMs:null,currentActivity:null,lastTurn:{id:p.turn?.id||p.turnId||null,status:p.turn?.status||"completed",durationMs:p.turn?.durationMs??null,completedAtMs},lastActivityAt:completedAtMs});
      if(isCurrent){
        setRunning(false);setActiveTurnId(null);setEvents(prev=>prev.map(e=>e.status==="running"?{...e,status:"done"}:e));loadThreads(rpcRef.current).catch(()=>{});desktopNotify("Trebell Code finished",titleOf(activeThreadRef.current)+" is ready for review.");
      }else if(threadId&&backgroundThreadsRef.current.has(threadId)){
        backgroundThreadsRef.current.delete(threadId);loadThreads(rpcRef.current).catch(()=>{});const thread=threads.find(item=>item.id===threadId);desktopNotify("Background task finished",(thread?titleOf(thread):"A background Trebell task")+" is ready for review.");
      }
    }
    else if(message.method==="turn/plan/updated"&&isCurrent){const plan=(p.plan||[]).map((s,i)=>({id:"plan-"+i,kind:"plan",title:s.step||s.description||s.text||"Plan step",status:s.status==="completed"?"done":s.status==="inProgress"?"running":"pending",raw:s}));setEvents(prev=>[...prev.filter(e=>e.kind!=="plan"),...plan])}
    else if(message.method==="item/started"&&p.item){
      const item=normalizeItem(p.item);
      const isActivityItem=!["userMessage","agentMessage"].includes(p.item.type);
      if(isActivityItem)updateThreadTelemetry(threadId,{currentActivity:{id:item.id,kind:item.kind,title:item.title,startedAtMs:p.startedAtMs||Date.now()},lastActivityAt:p.startedAtMs||Date.now()});
      if(isCurrent&&isActivityItem)setEvents(prev=>[...prev.filter(e=>e.id!==item.id),item]);
    }
    else if(message.method==="item/completed"&&p.item){
      const item=normalizeItem({...p.item,status:"completed"});
      const completedAtMs=p.completedAtMs||Date.now();
      const isActivityItem=!["userMessage","agentMessage"].includes(p.item.type);
      if(isActivityItem)updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?.id===item.id?null:current.currentActivity,lastActivity:{id:item.id,kind:item.kind,title:item.title,durationMs:p.item?.durationMs??null,completedAtMs},lastActivityAt:completedAtMs}));
      if(isCurrent){
        if(p.item.type==="userMessage"&&String(p.item.clientId||"").startsWith("trebell-queue-")){
          const draft=queuedSubmissionDraft({input:p.item.content||[]});const id=p.item.clientId;
          setMessages(prev=>prev.some(message=>message.id===id)?prev:[...prev,{id,role:"user",text:draft.draftText||draft.text,turnId:p.turnId||null}]);
        }
        if(p.item.type==="agentMessage"&&p.item.text?.trim()){setMessages(prev=>prev.some(m=>m.id===p.item.id)?prev:[...prev,{id:p.item.id,role:"assistant",text:p.item.text,turnId:p.turnId||null}]);setAssistantText("")}
        if(isActivityItem)setEvents(prev=>prev.some(e=>e.id===item.id)?prev.map(e=>e.id===item.id?{...e,...item}:e):[...prev,item]);
      }
    }
    else if(message.method==="item/autoApprovalReview/started"){
      const id="auto-review-"+String(p.reviewId||Date.now()),title="Auto review · "+guardianActionSummary(p.action||{});
      updateThreadTelemetry(threadId,{currentActivity:{id,kind:"autoReview",title,startedAtMs:p.startedAtMs||Date.now()},lastActivityAt:p.startedAtMs||Date.now()});
      if(isCurrent)setEvents(prev=>{const event={id,kind:"autoReview",title,status:"running",raw:p};return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?event:item):[...prev,event]});
    }
    else if(message.method==="item/autoApprovalReview/completed"){
      const id="auto-review-"+String(p.reviewId||Date.now()),status=p.review?.status||"completed",title="Auto review · "+guardianActionSummary(p.action||{});
      updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?.id===id?null:current.currentActivity,lastActivity:{id,kind:"autoReview",title,durationMs:p.completedAtMs&&p.startedAtMs?Math.max(0,p.completedAtMs-p.startedAtMs):null,completedAtMs:p.completedAtMs||Date.now()},lastActivityAt:p.completedAtMs||Date.now()}));
      if(isCurrent){
        setEvents(prev=>{const failed=status==="denied"||status==="timedOut";const event={id,kind:failed?"error":"autoReview",title:status==="denied"?title+" · denied":status==="timedOut"?title+" · timed out":title,status:failed?"error":"done",raw:p};return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?event:item):[...prev,event]});
        if(status==="denied"){
          setGuardianDenials(prev=>[...prev.filter(item=>item.reviewId!==p.reviewId),p].slice(-5));
          desktopNotify("Auto review denied an action",titleOf(activeThreadRef.current)+" needs your decision.");
        }
      }
    }
    else if(message.method==="autoApprovalReview/strictReviewRequired"){
      if(isCurrent){
        const id="strict-review-"+String(p.turnId||p.startedAtMs||Date.now());
        const title="Additional safety checks are running; some tool calls may take extra time";
        setEvents(prev=>prev.some(item=>item.id===id)?prev:[...prev,{id,kind:"autoReview",title,status:"warning",raw:p}]);
        desktopNotify("Additional safety review",title);
      }
    }
    else if(message.method==="guardianWarning"){
      if(isCurrent){
        setEvents(prev=>[...prev,{id:"guardian-warning-"+Date.now(),kind:"error",title:p.message||"Auto review warning",status:"done",raw:p}]);
        desktopNotify("Auto review warning",p.message||"Codex reported an auto-review warning.");
      }
    }
    else if(message.method==="item/agentMessage/delta"&&isCurrent)setAssistantText(prev=>prev+(p.delta||p.text||""));
    else if(message.method==="item/commandExecution/outputDelta"&&isCurrent){const id=p.itemId||"command";setEvents(prev=>prev.map(e=>e.id===id?{...e,output:(e.output||"")+(p.delta||"")}:e))}
    else if(message.method==="item/mcpToolCall/progress"){
      if(threadId)updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?{...current.currentActivity,title:p.message||current.currentActivity.title}:current.currentActivity,lastActivityAt:Date.now()}));
      if(isCurrent)setEvents(prev=>[...prev,{id:"mcp-"+Date.now(),kind:"mcpToolCall",title:p.message||"MCP progress",status:"running",raw:p}]);
    }
    else if(message.method==="turn/diff/updated"&&isCurrent)setEvents(prev=>[...prev,{id:"diff-"+Date.now(),kind:"fileChange",title:"Workspace diff updated",status:"done",raw:p.diff||p}]);
    else if(message.method==="thread/tokenUsage/updated"){
      updateThreadTelemetry(threadId,{tokenUsage:p.tokenUsage||null,lastActivityAt:Date.now()});
      if(isCurrent)setTokenUsage(p.tokenUsage||null);
    }
    else if(message.method==="thread/goal/updated"&&isCurrent)setGoal(p.goal||null);
    else if(message.method==="thread/goal/cleared"&&isCurrent)setGoal(null);
    else if(message.method==="thread/queue/changed"&&isCurrent)loadNativeQueue(rpcRef.current,p.threadId).catch(error=>setEvents(prev=>[...prev,{id:"queue-refresh-error-"+Date.now(),kind:"error",title:"Could not refresh queued follow-ups: "+(error.message||String(error)),status:"done",raw:{}}]));
    else if(message.method==="skills/changed")loadSkills(rpcRef.current,projectPath,true).catch(()=>{});
    else if(message.method==="windowsSandbox/setupCompleted"){
      window.dispatchEvent(new CustomEvent("trebell:windows-sandbox-setup",{detail:p}));
      desktopNotify(p.success?"Windows sandbox ready":"Windows sandbox setup failed",p.success?`${p.mode==="elevated"?"Elevated":"Unelevated"} Codex sandbox setup completed.`:(p.error||"Codex could not complete Windows sandbox setup."));
    }
    else if(message.method==="windows/worldWritableWarning"){
      window.dispatchEvent(new CustomEvent("trebell:windows-sandbox-warning",{detail:p}));
      const count=(p.samplePaths||[]).length+(Number(p.extraCount)||0);const detail=p.failedScan?"Codex could not fully scan Windows writable paths.":`${count} Windows path${count===1?"":"s"} may not be protectable by the sandbox.`;
      setEvents(prev=>[...prev,{id:"windows-sandbox-warning-"+Date.now(),kind:"error",title:detail,status:"done",raw:p}]);desktopNotify("Windows sandbox warning",detail);
    }
    else if(message.method==="thread/attachment/updated"&&isCurrent)loadPersistentThreadData(p.threadId).catch(()=>{});
    else if(message.method==="thread/runtimeInstance/updated"){
      const updated=p.thread||null;
      setThreads(prev=>prev.map(thread=>thread.id===p.threadId?(updated?{...thread,...updated}:{...thread,runtimeInstanceId:p.runtimeInstanceId}):thread));
      if(isCurrent){
        setActiveThread(prev=>prev?.id===p.threadId?(updated||{...prev,runtimeInstanceId:p.runtimeInstanceId}):prev);
        loadThreadRuntimeProfiles(rpcRef.current,p.threadId).catch(()=>{});
      }
    }
    else if(message.method==="thread/providerMetadata/updated"){
      setThreads(prev=>prev.map(thread=>thread.id===p.threadId?{...thread,providerMeta:{...(thread.providerMeta||{}),[p.type]:p.update}}:thread));
      const compaction=p.type==="session_info_update"?contextCompactionSignal(p.update):null;
      if(compaction&&threadId){
        const at=Date.now(),id="context-compact-"+threadId;
        if(compaction.phase==="running"){
          updateThreadTelemetry(threadId,{currentActivity:{id,kind:"contextCompaction",title:compaction.title,startedAtMs:at},lastActivityAt:at});
        }else if(compaction.phase==="done"){
          updateThreadTelemetry(threadId,{currentActivity:null,lastActivity:{id,kind:"contextCompaction",title:compaction.title,completedAtMs:at},lastActivityAt:at,lastError:null});
        }else{
          updateThreadTelemetry(threadId,{currentActivity:null,lastActivity:{id,kind:"contextCompaction",title:compaction.title,completedAtMs:at},lastError:compaction.detail||compaction.title,lastActivityAt:at});
        }
        if(isCurrent)setEvents(prev=>{
          const event={id,kind:compaction.phase==="error"?"error":"contextCompaction",title:compaction.detail?compaction.title+": "+compaction.detail:compaction.title,status:compaction.phase==="running"?"running":"done",raw:p.update||{}};
          return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?{...item,...event}:item):[...prev,event];
        });
      }
      if(isCurrent){setActiveThread(prev=>prev?.id===p.threadId?{...prev,providerMeta:{...(prev.providerMeta||{}),[p.type]:p.update}}:prev);applyProviderInventory(p.update||{})}
    }
    else if(message.method==="thread/compacted"){
      const at=Date.now(),id="context-compact-"+threadId;
      updateThreadTelemetry(threadId,{currentActivity:null,lastActivity:{id,kind:"contextCompaction",title:"Context compacted",completedAtMs:at},lastActivityAt:at,lastError:null});
      if(isCurrent)setEvents(prev=>{const event={id,kind:"contextCompaction",title:"Context compacted",status:"done",raw:p};return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?{...item,...event}:item):[...prev,event]});
    }
    else if(message.method==="error"){
      updateThreadTelemetry(threadId,{currentActivity:null,lastError:p.message||"Agent error",lastActivityAt:Date.now()});
      if(isCurrent){setEvents(prev=>[...prev,{id:"error-"+Date.now(),kind:"error",title:p.message||"Agent error",status:"done",raw:p}]);setRunning(false);desktopNotify("Trebell Code error",p.message||"The agent stopped with an error.")}
    }
  }

  async function updateThreadMeta(threadId,patch){const meta=await api("/api/thread-meta",{method:"POST",body:{threadId,patch}}).catch(()=>({...threadMeta[threadId],...patch}));setThreadMeta(prev=>({...prev,[threadId]:meta}));return meta}
  async function persistThreadWorkspaceContext(thread,cwd=thread?.cwd,extra={}){
    if(!thread?.id||!cwd)return null;
    const existing=threadMeta[thread.id]||{};
    const environmentId=existing.environmentId??thread.providerMeta?.environmentId??workspaceEnvironmentId??null;
    const projectless=Object.prototype.hasOwnProperty.call(extra,"projectless")?Boolean(extra.projectless):Boolean(existing.projectless);
    let info=null;
    if(!projectless){const params=new URLSearchParams({path:String(cwd)});params.set("environmentId",environmentId||"");info=await api("/api/git/info?"+params).catch(()=>null)}
    return updateThreadMeta(thread.id,{
      cwd:String(cwd),environmentId,branch:existing.branch||(info?.isGit?info.branch||null:null),
      projectless,sectionName:thread.section?.name||"Active",archived:Boolean(thread.archived),...extra,
    });
  }
  function clearThreadUndo(){
    if(threadUndoTimerRef.current)clearTimeout(threadUndoTimerRef.current);
    threadUndoTimerRef.current=null;threadUndoRef.current=null;setThreadUndo(null);
  }
  function offerThreadUndo(label,undo){
    if(threadUndoTimerRef.current)clearTimeout(threadUndoTimerRef.current);
    const id=crypto.randomUUID();threadUndoRef.current={id,undo};setThreadUndo({id,label});
    threadUndoTimerRef.current=setTimeout(()=>{if(threadUndoRef.current?.id===id){threadUndoRef.current=null;setThreadUndo(null)}},5000);
  }
  async function undoThreadAction(){
    const current=threadUndoRef.current;if(!current)return;
    clearThreadUndo();
    try{await current.undo()}
    catch(error){setEvents(prev=>[...prev,{id:"thread-undo-error-"+Date.now(),kind:"error",title:"Undo failed: "+(error.message||String(error)),status:"done",raw:{}}])}
  }
  useEffect(()=>()=>{if(threadUndoTimerRef.current)clearTimeout(threadUndoTimerRef.current)},[]);
  function captureThreadPlacement(thread){
    const sectionId=thread.section?.id||null;const group=threads.filter(item=>(item.section?.id||null)===sectionId);const index=group.findIndex(item=>item.id===thread.id);
    return {section:thread.section||null,beforeThreadId:index>=0?group[index+1]?.id||null:null,snoozedUntil:threadMeta[thread.id]?.snoozedUntil??null};
  }
  function restoreThreadLocally(thread,snapshot){
    const restored={...thread,archived:false,section:snapshot.section||null,sectionEnteredAt:snapshot.section?Date.now()/1000:null};
    setThreads(prev=>{
      const without=prev.filter(item=>item.id!==thread.id);const beforeIndex=snapshot.beforeThreadId?without.findIndex(item=>item.id===snapshot.beforeThreadId):-1;
      if(beforeIndex>=0)without.splice(beforeIndex,0,restored);else without.push(restored);return without;
    });
    if(activeThread?.id===thread.id)setActiveThread(restored);
    return restored;
  }
  async function restoreThreadPlacement(thread,snapshot){
    if(!rpc||rpcStatus!=="connected")return;
    await rpc.request("thread/section/move",{threadId:thread.id,sectionId:snapshot.section?.id||null,beforeThreadId:snapshot.beforeThreadId||null});
    restoreThreadLocally(thread,snapshot);await updateThreadMeta(thread.id,{snoozedUntil:snapshot.snoozedUntil??null});
  }
  async function moveThread(thread,destination,beforeThreadId=null){
    if(!rpc||rpcStatus!=="connected")return;
    const target=destination==="active"?null:sections[destination==="pin"?"Pinned":destination==="snooze"?"Snoozed":destination==="settle"?"Settled":destination];
    await rpc.request("thread/section/move",{threadId:thread.id,sectionId:target?.id||null,beforeThreadId});
    const updated={...thread,section:target||null,sectionEnteredAt:target?Date.now()/1000:null};setThreads(prev=>prev.map(t=>t.id===thread.id?updated:t));if(activeThread?.id===thread.id)setActiveThread(updated);await updateThreadMeta(thread.id,{sectionName:target?.name||"Active"});
  }
  async function reversibleThreadAction(thread,action,{snoozeUntil=null,offerUndo=true}={}){
    const snapshot=captureThreadPlacement(thread);const wasActive=activeThread?.id===thread.id;let label="Thread updated";let undo=null;
    if(action==="pin"){
      if(thread.section?.name==="Pinned")return null;
      await moveThread(thread,"pin");label="Thread pinned";undo=()=>restoreThreadPlacement(thread,snapshot);
    }else if(action==="settle"){
      if(thread.section?.name==="Settled")return null;
      await moveThread(thread,"settle");label="Thread settled";undo=()=>restoreThreadPlacement(thread,snapshot);
    }else if(action==="active"){
      const previous=thread.section?.name||"Active";if(previous==="Active"&&!snapshot.snoozedUntil)return null;
      await moveThread(thread,"active");await updateThreadMeta(thread.id,{snoozedUntil:null});
      label=previous==="Pinned"?"Thread unpinned":previous==="Snoozed"?"Thread woken":previous==="Settled"?"Thread restored":"Thread moved to Active";
      undo=()=>restoreThreadPlacement(thread,snapshot);
    }else if(action==="snooze"){
      if(!Number.isFinite(Number(snoozeUntil))||Number(snoozeUntil)<=Date.now())throw new Error("Choose a future snooze time.");
      await updateThreadMeta(thread.id,{snoozedUntil:Number(snoozeUntil)});await moveThread(thread,"snooze");label="Thread snoozed";undo=()=>restoreThreadPlacement(thread,snapshot);
    }else if(action==="archive"){
      if(!rpc)return null;
      await rpc.request("thread/archive",{threadId:thread.id});await updateThreadMeta(thread.id,{archived:true});setThreads(prev=>prev.filter(t=>t.id!==thread.id));if(wasActive)await newChat();label="Thread archived";
      undo=async()=>{
        const result=await rpc.request("thread/unarchive",{threadId:thread.id});
        const restoredThread=result?.thread||thread;
        await rpc.request("thread/section/move",{threadId:thread.id,sectionId:snapshot.section?.id||null,beforeThreadId:snapshot.beforeThreadId||null});
        await updateThreadMeta(thread.id,{snoozedUntil:snapshot.snoozedUntil??null,archived:false,sectionName:snapshot.section?.name||"Active"});const restored=restoreThreadLocally(restoredThread,snapshot);
        if(wasActive)await openThread(restored);
      };
    }else return null;
    const result={label,undo};if(offerUndo&&undo)offerThreadUndo(label,undo);return result;
  }
  async function threadAction(thread,action){
    if(action==="pin"||action==="settle"||action==="active"||action==="archive"){await reversibleThreadAction(thread,action);return}
    if(action==="snooze"){setSnoozeRequest({threads:[thread],bulk:false});return}
    if(action==="fork"){
      if(!rpc)return;
      const p=presetFor(permissionMode);
      const result=await rpc.request("thread/fork",{threadId:thread.id,model:model||null,modelProvider:provider,cwd:thread.cwd||projectPath,approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,threadSource:"trebell-code",excludeTurns:true});
      if(result?.thread){setThreads(prev=>[result.thread,...prev.filter(t=>t.id!==result.thread.id)]);await openThread(result.thread)}
      return;
    }
    if(action==="delete"){
      if(!rpc||!confirm("Delete this thread permanently?"))return;
      await rpc.request("thread/delete",{threadId:thread.id});
      setThreads(prev=>prev.filter(t=>t.id!==thread.id));
      if(activeThread?.id===thread.id)await newChat();
      return;
    }
  }
  async function moveThreadOrder(thread,direction){const group=threads.filter(t=>(t.section?.name||"Active")===(thread.section?.name||"Active"));const index=group.findIndex(t=>t.id===thread.id);const targetIndex=index+direction;if(targetIndex<0||targetIndex>=group.length)return;const before=direction<0?group[targetIndex].id:(group[targetIndex+1]?.id||null);await rpc.request("thread/section/move",{threadId:thread.id,sectionId:thread.section?.id||null,beforeThreadId:before});await loadThreads(rpc)}
  async function bulkAction(action){
    const selected=[...selectedThreadIds].map(id=>threads.find(thread=>thread.id===id)).filter(Boolean);if(!selected.length)return;
    if(action==="snooze"){setSnoozeRequest({threads:selected,bulk:true});return}
    const results=[];for(const thread of selected){const result=await reversibleThreadAction(thread,action,{offerUndo:false});if(result)results.push(result)}
    setSelectedThreadIds(new Set());
    if(results.length){const noun=results.length===1?"thread":results.length+" threads";const verb=action==="pin"?"pinned":action==="settle"?"settled":action==="archive"?"archived":"updated";offerThreadUndo(noun+" "+verb,async()=>{for(const result of [...results].reverse())await result.undo?.()})}
  }
  async function submitSnooze(until){
    const request=snoozeRequest;if(!request)return;const results=[];
    try{
      for(const thread of request.threads||[]){const result=await reversibleThreadAction(thread,"snooze",{snoozeUntil:until,offerUndo:false});if(result)results.push(result)}
      if(request.bulk)setSelectedThreadIds(new Set());setSnoozeRequest(null);
      if(results.length){const label=results.length===1?"Thread snoozed":results.length+" threads snoozed";offerThreadUndo(label,async()=>{for(const result of [...results].reverse())await result.undo?.()})}
    }catch(error){setEvents(prev=>[...prev,{id:"snooze-error-"+Date.now(),kind:"error",title:error.message||String(error),status:"done",raw:{}}])}
  }

  async function loadPersistentThreadData(threadId){
    if(!rpc||rpcStatus!=="connected"||!threadId)return {goal:null,pullRequests:[]};
    const [goalData,attachmentData]=await Promise.all([
      rpc.request("thread/goal/get",{threadId}).catch(()=>({goal:null})),
      rpc.request("thread/attachment/list",{threadId,limit:100}).catch(()=>({data:[]})),
    ]);
    const pullRequests=(attachmentData?.data||[]).filter(item=>item.attachmentType==="pull_request").map(item=>({...item.payload,__identityKey:item.identityKey}));
    if(activeThread?.id===threadId){setGoal(goalData?.goal||null);setLinkedPullRequests(pullRequests)}
    return {goal:goalData?.goal||null,pullRequests};
  }
  function releaseInactiveCodexThread(threadId){
    if(agentRuntime!=="codex"||!threadId||running||!rpc||rpcStatus!=="connected")return;
    rpc.request("thread/unsubscribe",{threadId}).catch(()=>{});
  }
  async function newChat(){rememberConversationPosition();releaseInactiveCodexThread(activeThreadRef.current?.id);activeThreadRef.current=null;pendingThreadScrollRestoreRef.current=null;pendingHistoryPrependRef.current=null;followConversationEndRef.current=true;setSection("chat");setActiveThread(null);setActiveTurnId(null);setMessages([]);setHistoryPage({threadId:null,nextCursor:null,paginated:false,loading:false});setThreadFind({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});setEvents([]);setGuardianDenials([]);setGuardianBusy("");setAssistantText("");setQueued([]);setQueueMode(agentRuntime==="codex"?"unknown":"local");setQueuedEditId(null);setPrompt("");setAttachments([]);setContextChips([]);setTokenUsage(null);setCheckpointByTurn({});setGoal(null);setLinkedPullRequests([]);setWorktreeSetup(null);setProviderAgent("");setCollaborationMode(collaborationModes.some(item=>item.mode==="default")?"default":collaborationModes[0]?.mode||"default");if(agentRuntime!=="codex"){setSkills([]);setProviderCommands([]);setProviderAgents([])}}
  async function newGeneralChat(){
    const environmentId=workspaceEnvironmentId;
    const scratch=await api("/api/general-workspace",{method:"POST",body:{environmentId}});
    await newChat();
    setProjectlessMode(true);setGeneralEnvironmentId(scratch.environmentId||null);setCurrentProject(null);setProjectPath(scratch.path);setGitInfo(null);setWorkspaceMode("current");
    if(["files","diff","source"].includes(rightPanelTab)){setRightPanelTab("runtime");setRightPanelOpen(false);setRightPanelMaximized(false)}
    return scratch;
  }
  async function openThread(thread,{client=rpc,preserveSection=false}={}){
    const previousThreadId=activeThreadRef.current?.id;
    const threadEnvironmentId=thread.providerMeta?.environmentId||null;
    const savedMeta=threadMeta[thread.id]||{};const projectless=Boolean(savedMeta.projectless);
    if(thread.cwd&&!threadEnvironmentId&&!projectless)await api("/api/worktree/ensure",{method:"POST",body:{path:thread.cwd,environmentId:null}}).catch(error=>{throw new Error("Could not restore this managed worktree: "+error.message)});
    const connectedClient=Boolean(client&&!(client===rpc&&rpcStatus!=="connected"));
    let resumed=null,cp={checkpoints:[]},goalData={goal:null},attachmentData={data:[]};
    if(connectedClient){
      const resumePromise=agentRuntime==="codex"
        ?resumeCodexWithBoundedHistory(client,{threadId:thread.id,model:model||null,modelProvider:provider,cwd:thread.cwd||null})
        :client.request("thread/resume",{threadId:thread.id,model:model||null,modelProvider:provider,cwd:thread.cwd||null,excludeTurns:false});
      [resumed,cp,goalData,attachmentData]=await Promise.all([
        resumePromise,
        api("/api/checkpoints?threadId="+encodeURIComponent(thread.id)).catch(()=>({checkpoints:[]})),
        client.request("thread/goal/get",{threadId:thread.id}).catch(()=>({goal:null})),
        client.request("thread/attachment/list",{threadId:thread.id,limit:100}).catch(()=>({data:[]})),
      ]);
      if(!resumed?.thread)throw new Error("The agent runtime did not return the requested thread.");
    }
    const openedThread=resumed?.thread||thread;
    rememberConversationPosition();
    if(previousThreadId&&previousThreadId!==thread.id)releaseInactiveCodexThread(previousThreadId);
    activeThreadRef.current=openedThread;pendingThreadScrollRestoreRef.current=null;pendingHistoryPrependRef.current=null;followConversationEndRef.current=threadScrollPositionsRef.current.get(thread.id)?.atEnd??true;if(!preserveSection)setSection("chat");setMessages([]);setHistoryPage({threadId:thread.id,nextCursor:null,paginated:false,loading:false});setThreadFind({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});setEvents([]);setGuardianDenials([]);setGuardianBusy("");setAssistantText("");setWorktreeSetup(null);setActiveThread(openedThread);persistThreadWorkspaceContext(openedThread,openedThread.cwd,{archived:false,projectless}).catch(()=>{});
    if(projectless){setProjectlessMode(true);setGeneralEnvironmentId(savedMeta.environmentId??threadEnvironmentId??null);setCurrentProject(null);setProjectPath(openedThread.cwd||projectPath);setGitInfo(null);setWorkspaceMode("current")}
    else if(openedThread.cwd)await touchProject(openedThread.cwd,threadEnvironmentId);else setProjectPath(projectPath);
    if(!connectedClient)return;
    const map=Object.fromEntries((cp.checkpoints||[]).filter(x=>x.turnId).map(x=>[x.turnId,x]));setCheckpointByTurn(map);
    if(resumed?.thread){
      activeThreadRef.current=resumed.thread;pendingThreadScrollRestoreRef.current=resumed.thread.id;setActiveThread(resumed.thread);
      if(agentRuntime==="codex"&&resumed.collaborationMode?.mode&&collaborationModes.some(item=>item.mode===resumed.collaborationMode.mode))setCollaborationMode(resumed.collaborationMode.mode);
      if(agentRuntime==="codex"&&resumed.__trebellHistoryPage&&!resumed.__trebellFullHistoryFallback){
        const page=resumed.__trebellHistoryPage;
        const history=page.kind==="items"?historyFromItemEntries([...(page.data||[])].reverse(),map):historyFromTurns([...(page.data||[])].reverse(),map);
        setMessages(history);setHistoryPage({threadId:resumed.thread.id,nextCursor:page.nextCursor||null,paginated:true,itemPaging:page.kind==="items",loading:false});
      }else{setMessages(historyFromThread(resumed.thread,map));setHistoryPage({threadId:resumed.thread.id,nextCursor:null,paginated:false,loading:false})}
      setProjectPath(resumed.thread.cwd||projectPath);setProviderAgent(resumed.thread.agent||"");if(agentRuntime!=="codex"){const meta=resumed.thread.providerMeta||{};applyProviderInventory(meta.session_info_update||meta.available_commands_update||{})}
    }
    if(agentRuntime==="codex"&&!bootstrap.mock&&resumed?.thread&&!projectless&&!threadEnvironmentId&&resumed.thread.cwd){
      const listed=await api("/api/projects").catch(()=>({projects:[]}));
      const trebellProject=(listed.projects||[]).find(project=>!project.environmentId&&sameWorkspacePath(project.path,resumed.thread.cwd))||null;
      const nativeProject=await ensureCodexProject(client,{trebellProject,cwd:resumed.thread.cwd}).catch(()=>null);
      if(nativeProject?.id&&resumed.thread.projectId!==nativeProject.id){
        const updated=await client.request("thread/metadata/update",{threadId:resumed.thread.id,projectId:nativeProject.id}).catch(()=>null);
        if(updated?.thread){
          activeThreadRef.current=updated.thread;setActiveThread(updated.thread);
          setThreads(prev=>prev.map(item=>item.id===updated.thread.id?updated.thread:item));
        }
      }
    }
    if(agentRuntime==="codex"&&!bootstrap.mock&&resumed?.thread){
      const timelineThreadId=thread.id;
      import("./thread-timeline.js")
        .then(({loadLatestTurnTimeline})=>loadLatestTurnTimeline(client,timelineThreadId))
        .then(timeline=>{
          if(activeThreadRef.current?.id!==timelineThreadId||!timeline.items.length)return;
          const restored=timeline.items.map(item=>{
            const event=normalizeItem(item);
            return {...event,status:item.status?event.status:"done",output:item.aggregatedOutput||""};
          });
          setEvents(current=>{
            const liveIds=new Set(current.map(event=>String(event.id)));
            return [...restored.filter(event=>!liveIds.has(String(event.id))),...current];
          });
        })
        .catch(()=>{});
    }
    if(agentRuntime==="codex")await loadNativeQueue(client,thread.id).catch(error=>setEvents(prev=>[...prev,{id:"queue-load-error-"+Date.now(),kind:"error",title:"Could not load queued follow-ups: "+(error.message||String(error)),status:"done",raw:{}}]));else{setQueueMode("local");setQueued([])}
    const meta=threadMeta[thread.id]||{};setReviewedFiles(meta.reviewedFiles||[]);setGoal(goalData?.goal||null);
    const persisted=(attachmentData?.data||[]).filter(item=>item.attachmentType==="pull_request").map(item=>({...item.payload,__identityKey:item.identityKey}));
    setLinkedPullRequests(persisted.length?persisted:(meta.linkedPullRequests||[]));
  }
  async function loadEarlierMessages(){
    const threadId=activeThreadRef.current?.id;const cursor=historyPage.threadId===threadId?historyPage.nextCursor:null;
    if(agentRuntime!=="codex"||!rpc||rpcStatus!=="connected"||!threadId||!cursor||historyPage.loading)return;
    const node=conversationScrollRef.current;setHistoryPage(current=>current.threadId===threadId?{...current,loading:true}:current);
    try{
      const page=historyPage.itemPaging
        ?await loadCodexItemHistoryPage(rpc,threadId,cursor)
        :await rpc.request("thread/turns/list",{threadId,cursor,limit:CODEX_HISTORY_TURN_PAGE_LIMIT,sortDirection:"desc",itemsView:"full"});
      if(activeThreadRef.current?.id!==threadId)return;
      const earlier=historyPage.itemPaging
        ?historyFromItemEntries([...(page?.data||[])].reverse(),checkpointByTurn)
        :historyFromTurns([...(page?.data||[])].reverse(),checkpointByTurn);
      if(earlier.length&&node)pendingHistoryPrependRef.current={threadId,scrollHeight:node.scrollHeight,scrollTop:node.scrollTop};
      if(earlier.length)setMessages(current=>mergeHistoryMessages(earlier,current));
      setHistoryPage({threadId,nextCursor:page?.nextCursor||null,paginated:true,itemPaging:Boolean(historyPage.itemPaging),loading:false});
    }catch(error){
      if(activeThreadRef.current?.id===threadId){setHistoryPage(current=>current.threadId===threadId?{...current,loading:false}:current);setEvents(prev=>[...prev,{id:"history-page-error-"+Date.now(),kind:"error",title:"Could not load earlier messages: "+(error.message||String(error)),status:"done",raw:{}}])}
    }
  }
  function openThreadFind(){
    if(agentRuntime!=="codex"||!activeThreadRef.current?.id)return;
    setThreadFind(current=>({...current,open:true,error:""}));
  }
  function closeThreadFind(){
    threadFindSeqRef.current++;
    setThreadFind({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});
  }
  async function focusThreadFindOccurrence(occurrence,expectedSeq=null){
    if(!occurrence||agentRuntime!=="codex"||!rpc||rpcStatus!=="connected")return;
    const threadId=activeThreadRef.current?.id;if(!threadId)return;
    const itemId=String(occurrence.itemId||"");
    if(itemId&&!messages.some(message=>String(message.id)===itemId)){
      let found=[];
      if(historyPage.itemPaging){
        try{
          let cursor=null;
          for(let pageIndex=0;pageIndex<CODEX_HISTORY_ITEM_SCAN_PAGES;pageIndex++){
            const page=await rpc.request("thread/items/list",{threadId,turnId:occurrence.turnId,cursor,limit:CODEX_HISTORY_ITEM_PAGE_LIMIT,sortDirection:"asc"});
            found=mergeHistoryMessages(found,historyFromItemEntries(page?.data||[],checkpointByTurn));
            if(found.some(message=>String(message.id)===itemId)||!page?.nextCursor)break;
            cursor=page.nextCursor;
          }
        }catch{}
      }
      if(!found.some(message=>String(message.id)===itemId)&&occurrence.turnCursor){
        const page=await rpc.request("thread/turns/list",{threadId,cursor:occurrence.turnCursor,limit:1,itemsView:"full"});
        found=mergeHistoryMessages(found,historyFromTurns(page?.data||[],checkpointByTurn));
      }
      if(activeThreadRef.current?.id!==threadId||(expectedSeq!=null&&expectedSeq!==threadFindSeqRef.current))return;
      if(found.length)setMessages(current=>mergeHistoryMessages(found,current));
    }
    if(activeThreadRef.current?.id!==threadId||(expectedSeq!=null&&expectedSeq!==threadFindSeqRef.current))return;
    setThreadFind(current=>({...current,activeItemId:itemId||current.activeItemId}));
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const node=conversationScrollRef.current;if(!node)return;
      const target=[...node.querySelectorAll("[data-message-id]")].find(element=>String(element.dataset.messageId)===itemId);
      if(target){followConversationEndRef.current=false;target.scrollIntoView({block:"center",behavior:"auto"})}
    }));
  }
  async function stepThreadFind(direction){
    if(!threadFind.results.length||threadFind.loading)return;
    if(direction<0){
      const index=Math.max(0,threadFind.index-1);const occurrence=threadFind.results[index];
      setThreadFind(current=>({...current,index,activeItemId:occurrence?.itemId||null}));await focusThreadFindOccurrence(occurrence);return;
    }
    if(threadFind.index<threadFind.results.length-1){
      const index=threadFind.index+1;const occurrence=threadFind.results[index];
      setThreadFind(current=>({...current,index,activeItemId:occurrence?.itemId||null}));await focusThreadFindOccurrence(occurrence);return;
    }
    if(!threadFind.nextCursor||!activeThreadRef.current?.id)return;
    const threadId=activeThreadRef.current.id;setThreadFind(current=>({...current,loading:true,error:""}));
    try{
      const result=await rpc.request("thread/searchOccurrences",{threadId,searchTerm:threadFind.query.trim(),cursor:threadFind.nextCursor,limit:50});
      if(activeThreadRef.current?.id!==threadId)return;
      const added=result?.data||[];const index=threadFind.results.length;const occurrence=added[0]||null;
      setThreadFind(current=>({...current,results:[...current.results,...added],index:occurrence?index:current.index,nextCursor:result?.nextCursor||null,loading:false,error:"",activeItemId:occurrence?.itemId||current.activeItemId}));
      if(occurrence)await focusThreadFindOccurrence(occurrence);
    }catch(error){if(activeThreadRef.current?.id===threadId)setThreadFind(current=>({...current,loading:false,error:error.message||String(error)}))}
  }
  async function openLinkedThread(reference){
    if(!rpc||rpcStatus!=="connected"||!reference?.threadId)throw new Error("The agent harness is not connected.");
    let thread=threads.find(item=>item.id===reference.threadId)||null;
    if(!thread){
      const read=await rpc.request("thread/read",{threadId:reference.threadId,includeTurns:false}).catch(()=>null);
      thread=read?.thread||null;
    }
    const archived=Boolean(reference.archived||thread?.archived);
    if(archived){
      const restored=await rpc.request("thread/unarchive",{threadId:reference.threadId}).catch(()=>null);
      await updateThreadMeta(reference.threadId,{archived:false});
      thread=restored?.thread||thread;
      if(!thread){
        const read=await rpc.request("thread/read",{threadId:reference.threadId,includeTurns:false});
        thread=read?.thread||null;
      }
      if(thread)thread={...thread,archived:false};
    }
    if(!thread)throw new Error("Linked thread was not found.");
    setThreads(prev=>[thread,...prev.filter(item=>item.id!==thread.id)]);
    await openThread(thread);
  }
  async function reloadActiveThread(){if(activeThread)await openThread(activeThread)}
  async function monitorWorktreeSetup(sessionId,{timeoutMs=30*60_000}={}){
    const started=Date.now();
    while(Date.now()-started<timeoutMs){
      const data=await api("/api/terminal/sessions").catch(()=>({sessions:[]}));
      const session=(data.sessions||[]).find(item=>item.id===sessionId);
      if(session&&!session.running){
        const failed=session.exitCode!==0;
        setWorktreeSetup(prev=>prev?.sessionId===sessionId?{...prev,phase:failed?"failed":"done",detail:failed?`Setup exited with code ${session.exitCode??"unknown"}`:"Setup completed",exitCode:session.exitCode}:prev);
        return {exitCode:session.exitCode};
      }
      await new Promise(resolve=>setTimeout(resolve,700));
    }
    setWorktreeSetup(prev=>prev?.sessionId===sessionId?{...prev,phase:"failed",detail:"Setup is still running after 30 minutes."}:prev);
    return {timeout:true,exitCode:null};
  }
  async function waitForDetachedSetup(sessionId,{timeoutMs=30*60_000}={}){
    const started=Date.now();
    while(Date.now()-started<timeoutMs){
      const data=await api("/api/terminal/sessions").catch(()=>({sessions:[]}));const session=(data.sessions||[]).find(item=>item.id===sessionId);
      if(session&&!session.running)return {exitCode:session.exitCode};
      await new Promise(resolve=>setTimeout(resolve,700));
    }
    return {timeout:true,exitCode:null};
  }

  async function prepareWorktree(basePath,modelId){
    if(workspaceMode!=="worktree")return basePath;
    const info=await api("/api/git/info?path="+encodeURIComponent(basePath));
    if(!info.isGit)throw new Error("New worktree mode requires a Git project.");
    const slug=String(modelId||"model").replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-|-$/g,"").slice(-24)||"agent";
    const stamp=Date.now().toString(36);
    const branch="trebell/"+slug+"-"+stamp;
    const path=info.root+"-trebell-"+slug+"-"+stamp;
    setWorktreeSetup({phase:"creating",branch,path,scriptName:null,sessionId:null,detail:"Creating an isolated Git worktree"});
    try{
      const response=await api("/api/git/action",{method:"POST",body:{action:"worktree-create",cwd:info.root,branch,path,baseBranch:info.branch}});
      const worktree=response.result?.worktree||path;
      await touchProject(worktree);
      const setup=response.result?.setup||null;
      if(setup?.session?.id){
        setWorktreeSetup({
          phase:"running",
          branch,
          path:worktree,
          scriptName:setup.scriptName||"Setup",
          sessionId:setup.session.id,
          waitForSetup:Boolean(setup.waitForSetup),
          detail:setup.waitForSetup?"Agent will start after setup completes":"Setup is running in the background",
        });
        setPanel("terminal");
        setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:setup.session.id})),0);
        const completion=monitorWorktreeSetup(setup.session.id);
        if(setup.waitForSetup){
          const settled=await completion;
          if(settled.timeout)throw new Error("Worktree setup is still running after 30 minutes. The agent was not started.");
          if(settled.exitCode!==0)throw new Error(`Worktree setup failed with exit code ${settled.exitCode??"unknown"}. Fix the setup terminal, then retry.`);
        }else{
          completion.catch(()=>{});
        }
      }else{
        setWorktreeSetup({phase:"done",branch,path:worktree,scriptName:null,sessionId:null,detail:"Worktree created"});
      }
      return worktree;
    }catch(error){
      setWorktreeSetup(prev=>({...prev,phase:"failed",detail:error.message||String(error)}));
      throw error;
    }
  }
  async function prepareDetachedWorktree(basePath,modelId,{force=false}={}){
    if(!force&&workspaceMode!=="worktree")return basePath;
    const info=await api("/api/git/info?path="+encodeURIComponent(basePath));if(!info.isGit)throw new Error("Background worktree mode requires a Git project.");if(!info.branch)throw new Error("Background worktrees require a checked-out base branch; detached HEAD is not supported.");
    const slug=String(modelId||"model").replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-|-$/g,"").slice(-24)||"agent";const stamp=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    const branch="trebell/"+slug+"-"+stamp;const path=info.root+"-trebell-"+slug+"-"+stamp;
    const response=await api("/api/git/action",{method:"POST",body:{action:"worktree-create",cwd:info.root,branch,path,baseBranch:info.branch}});const worktree=response.result?.worktree||path;
    await api("/api/projects",{method:"POST",body:{path:worktree}}).catch(()=>{});
    const setup=response.result?.setup||null;
    if(setup?.session?.id&&setup.waitForSetup){const settled=await waitForDetachedSetup(setup.session.id);if(settled.timeout)throw new Error("Background worktree setup is still running after 30 minutes.");if(settled.exitCode!==0)throw new Error(`Background worktree setup failed with exit code ${settled.exitCode??"unknown"}.`)}
    return worktree;
  }
  async function createThreadFor(modelId,cwd,{projectless=projectlessMode}={}){
    const p=presetFor(permissionMode);
    const dynamicTools=[...TREBELL_BROWSER_TOOLS,...TREBELL_COMPUTER_TOOLS,...TREBELL_SOURCE_CONTROL_TOOLS,...(effectiveProjectSettings.agentDeviceAccess?TREBELL_DEVICE_TOOLS:[])];
    const researchInstruction="Web research is available when useful. Use it when current or external information materially improves the task; use trebell_browser for interactive pages.";
    const developerInstructions=projectless
      ?"This is a Trebell General chat with no attached project or repository. The working directory is an app-managed scratch workspace. Do not assume it is a codebase, repository, or user project. "+researchInstruction
      :researchInstruction;
    let nativeProjectId=null;
    if(agentRuntime==="codex"&&!bootstrap.mock&&!projectless&&!workspaceEnvironmentId){
      let trebellProject=currentProject&&sameWorkspacePath(currentProject.path,cwd)?currentProject:null;
      if(!trebellProject){
        const listed=await api("/api/projects").catch(()=>({projects:[]}));
        trebellProject=(listed.projects||[]).find(project=>!project.environmentId&&sameWorkspacePath(project.path,cwd))||null;
      }
      nativeProjectId=(await ensureCodexProject(rpc,{trebellProject,cwd}).catch(()=>null))?.id||null;
    }
    const result=await rpc.request("thread/start",{model:modelId,modelProvider:provider,cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...(nativeProjectId?{projectId:nativeProjectId}:{}),approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,ephemeral:false,threadSource:"trebell-code",dynamicTools,developerInstructions});
    if(agentRuntime!=="codex"&&result.thread?.providerMeta){setProviderAgent(result.thread.agent||providerAgent||"");const meta=result.thread.providerMeta;applyProviderInventory(meta.session_info_update||meta.available_commands_update||{})}
    if(result.thread?.id)await persistThreadWorkspaceContext(result.thread,cwd,{sectionName:"Active",archived:false,projectless}).catch(()=>{});
    return result.thread;
  }
  function inputsFor(text,paths){return [{type:"text",text,textElements:[]},...(paths||[]).map(path=>{const lower=String(path).toLowerCase();if(/\.(png|jpe?g|gif|webp|bmp)$/.test(lower))return{type:"localImage",path};if(/\.(mp3|wav|m4a|ogg|flac)$/.test(lower))return{type:"localAudio",path};return{type:"mention",name:String(path).split(/[\\/]/).pop(),path}})]}
  async function loadNativeQueue(client=rpcRef.current,threadId=activeThreadRef.current?.id){
    if(agentRuntime!=="codex"||!client||!threadId)return false;
    try{
      let cursor=null;const submissions=[];
      do{
        const result=await client.request("thread/queue/list",{threadId,cursor,limit:100});
        submissions.push(...(result?.data||[]));cursor=result?.nextCursor||null;
      }while(cursor&&submissions.length<1000);
      if(activeThreadRef.current?.id===threadId){setQueued(previous=>mergeNativeQueue(previous,submissions));setQueueMode("native");setQueuedEditId(current=>submissions.some(item=>item.id===current)?current:null)}
      return true;
    }catch(error){
      if(nativeQueueUnavailable(error)){if(activeThreadRef.current?.id===threadId)setQueueMode("local");return false}
      throw error;
    }
  }
  async function saveNativeQueuedFollowup(text,paths,chips,{queuedId=null}={}){
    if(agentRuntime!=="codex"||!rpc||!activeThread?.id||queueMode==="local")return false;
    await validateAttachmentPaths(paths||[]);
    try{
      const input=inputsFor(text,paths);
      if(queuedId){
        const result=await rpc.request("thread/queue/update",{threadId:activeThread.id,queuedSubmissionId:queuedId,input});
        const draft={...queuedSubmissionDraft(result?.queuedSubmission||{}),contextChips:[...(chips||[])],model};
        setQueued(previous=>previous.map(item=>item.id===queuedId?draft:item));setQueuedEditId(null);
      }else{
        const clientUserMessageId="trebell-queue-"+crypto.randomUUID();
        const result=await rpc.request("thread/queue/add",{threadId:activeThread.id,input,clientUserMessageId});
        const draft={...queuedSubmissionDraft(result?.queuedSubmission||{}),contextChips:[...(chips||[])],model};
        setQueued(previous=>[...previous.filter(item=>item.id!==draft.id),draft]);
      }
      setQueueMode("native");return true;
    }catch(error){
      if(nativeQueueUnavailable(error)){setQueueMode("local");setQueuedEditId(null);return false}
      throw error;
    }
  }
  async function startTurn(text,paths,modelId=model,threadOverride=null,cwdOverride=null){
    if(!projectlessMode&&!threadOverride&&(cwdOverride||projectPath)===projectPath)await waitForActiveClone();
    await validateAttachmentPaths(paths||[]);
    if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");let thread=threadOverride||activeThread;let cwd=cwdOverride||projectPath||bootstrap.cwd;
    if(!thread){if(!projectlessMode)cwd=await prepareWorktree(cwd,modelId);thread=await createThreadFor(modelId,cwd,{projectless:projectlessMode});activeThreadRef.current=thread;setActiveThread(thread);setThreads(prev=>[thread,...prev]);setProjectPath(cwd)}
    const clientId="user-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);setMessages(prev=>[...prev,{id:clientId,role:"user",text}]);setEvents([]);setAssistantText("");setRunning(true);
    const checkpoint=projectlessMode?null:await api("/api/checkpoints",{method:"POST",body:{cwd,threadId:thread.id,label:text.slice(0,80)}}).catch(()=>null);const p=presetFor(permissionMode);
    const sandboxPolicy=p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:{type:"workspaceWrite",writableRoots:[cwd],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
    const custom=(settings.customModels||[]).find(item=>item.id===modelId&&item.runtime===agentRuntime&&(agentRuntime!=="codex"||item.provider===provider));
    const collaboration=selectedCollaborationMode(modelId);
    const result=await rpc.request("turn/start",{threadId:thread.id,model:modelId,cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...(agentRuntime==="codex"&&custom?.effort?{effort:custom.effort}:{}),...(agentRuntime==="codex"&&custom?.serviceTier?{serviceTierForTurn:custom.serviceTier}:{}),...(collaboration?{collaborationMode:collaboration}:{}),approvalPolicy:p.approvalPolicy,sandboxPolicy,input:inputsFor(text,paths)});const turnId=result?.turn?.id||null;setActiveTurnId(turnId);
    setMessages(prev=>prev.map(m=>m.id===clientId?{...m,turnId,checkpointId:checkpoint?.id||null}:m));if(checkpoint?.id&&turnId){await api("/api/checkpoints/link",{method:"POST",body:{id:checkpoint.id,patch:{turnId}}}).catch(()=>{});setCheckpointByTurn(prev=>({...prev,[turnId]:{...checkpoint,turnId}}))}setAttachments([]);setContextChips([]);return{thread,turnId};
  }
  async function startDetachedTurn(text,paths,modelId=model,{forceWorktree=false,basePath=null,projectless=projectlessMode}={}){
    await validateAttachmentPaths(paths||[]);if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");
    let cwd=basePath||projectPath||bootstrap.cwd;if(!cwd)throw new Error(projectless?"Could not prepare the General chat workspace.":"Choose a project before starting background work.");if(!projectless)cwd=await prepareDetachedWorktree(cwd,modelId,{force:forceWorktree});
    let thread=null;let turnRequestStarted=false;
    try{
      thread=await createThreadFor(modelId,cwd,{projectless});if(!thread?.id)throw new Error("Agent harness did not create a background thread");
      backgroundThreadsRef.current.add(thread.id);setThreads(prev=>[thread,...prev.filter(item=>item.id!==thread.id)]);
      const checkpoint=projectless?null:await api("/api/checkpoints",{method:"POST",body:{cwd,threadId:thread.id,label:text.slice(0,80)}}).catch(()=>null);const p=presetFor(permissionMode);
      const sandboxPolicy=p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:{type:"workspaceWrite",writableRoots:[cwd],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
      const custom=(settings.customModels||[]).find(item=>item.id===modelId&&item.runtime===agentRuntime&&(agentRuntime!=="codex"||item.provider===provider));
      turnRequestStarted=true;
      const collaboration=selectedCollaborationMode(modelId);
      const result=await rpc.request("turn/start",{threadId:thread.id,model:modelId,cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...(agentRuntime==="codex"&&custom?.effort?{effort:custom.effort}:{}),...(agentRuntime==="codex"&&custom?.serviceTier?{serviceTierForTurn:custom.serviceTier}:{}),...(collaboration?{collaborationMode:collaboration}:{}),approvalPolicy:p.approvalPolicy,sandboxPolicy,input:inputsFor(text,paths)});const turnId=result?.turn?.id||null;
      if(checkpoint?.id&&turnId)await api("/api/checkpoints/link",{method:"POST",body:{id:checkpoint.id,patch:{turnId}}}).catch(()=>{});
      return {thread,turnId,cwd};
    }catch(error){
      let uncertainThread=thread;
      if(!uncertainThread?.id){
        for(let attempt=0;attempt<3&&!uncertainThread;attempt++){
          if(attempt)await new Promise(resolve=>setTimeout(resolve,250));
          const listed=await rpc.request("thread/list",threadListParams(100)).catch(()=>({data:[]}));
          uncertainThread=threadForWorktree(listed.data||[],cwd);
        }
        if(uncertainThread?.id){backgroundThreadsRef.current.add(uncertainThread.id);setThreads(prev=>[uncertainThread,...prev.filter(item=>item.id!==uncertainThread.id)])}
      }
      const failure=error instanceof Error?error:new Error(String(error));
      if(uncertainThread?.id||turnRequestStarted)failure.trebellUncertain={threadId:uncertainThread?.id||null,cwd,model:modelId,phase:turnRequestStarted?"turn":"thread"};
      throw failure;
    }
  }
  function restoreFailedDraft(draft){
    setPrompt(current=>{
      const next=String(draft?.text||"");if(!next)return current;
      if(!String(current||"").trim())return next;
      if(String(current).includes(next))return current;
      return next+"\n\n--- recovered failed background draft ---\n"+current;
    });
    setAttachments(current=>[...new Set([...(draft?.attachments||[]),...(current||[])])]);
    setContextChips(current=>{
      const merged=[];const seen=new Set();
      for(const item of [...(draft?.contextChips||[]),...(current||[])]){
        const key=typeof item==="string"?item:JSON.stringify(item);
        if(seen.has(key))continue;seen.add(key);merged.push(item);
      }
      return merged;
    });
  }
  async function saveFailureStash(draft){
    try{await api("/api/stashes",{method:"POST",body:draft});return{ok:true,error:""}}
    catch(error){return{ok:false,error:error?.message||String(error)||"Unknown stash error"}}
  }
  async function sendModelFanout(text){
    const fanout=[...new Set(selectedModels.filter(id=>models.includes(id)))];if(activeThread?.id||running||fanout.length<2)return false;
    const workspaceError=fanoutWorkspaceError(gitInfo);if(workspaceError){setEvents(prev=>[...prev,{id:"fanout-workspace-"+Date.now(),kind:"error",title:workspaceError,status:"done",raw:{}}]);return true}
    if(prompt.length>MAX_COMPOSER_CHARS){setEvents(prev=>[...prev,{id:"fanout-long-"+Date.now(),kind:"error",title:`Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()} character limit`,status:"done",raw:{}}]);return true}
    if(agentRuntime==="antigravity"&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"fanout-video-"+Date.now(),kind:"error",title:"Antigravity does not accept video attachments",status:"done",raw:{}}]);return true}
    try{await validateAttachmentPaths(attachments)}catch(error){setEvents(prev=>[...prev,{id:"fanout-attachment-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return true}
    const draft={text,attachments:[...attachments],contextChips:[...contextChips],projectPath:projectPath||bootstrap.cwd};
    setPrompt("");setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);setEvents([]);setAssistantText("");setSection("chat");
    const launches=fanout.map(modelId=>startDetachedTurn(draft.text,draft.attachments,modelId,{forceWorktree:true,basePath:draft.projectPath}).then(result=>({ok:true,modelId,result})).catch(error=>({ok:false,modelId,error})));
    Promise.all(launches).then(async results=>{
      const started=results.filter(item=>item.ok);const failed=results.filter(item=>!item.ok);const uncertain=failed.filter(item=>item.error?.trebellUncertain);
      const summary=[];
      if(started.length)summary.push({id:"fanout-started-"+Date.now(),kind:"tool",title:`Started ${started.length}/${fanout.length} model${started.length===1?"":"s"} in isolated worktrees`,status:"done",raw:{models:started.map(item=>item.modelId),threads:started.map(item=>item.result?.thread?.id).filter(Boolean)}});
      let stashSaved=0;const stashErrors=[];
      for(const item of failed){
        const guard=item.error?.trebellUncertain;const prefix=guard?`[CHECK EXISTING THREAD BEFORE RETRY · ${item.modelId}] `:`[${item.modelId}] `;
        const stash=await saveFailureStash({...draft,text:prefix+draft.text});
        if(stash.ok)stashSaved++;else stashErrors.push(`${item.modelId}: ${stash.error}`);
      }
      if(stashErrors.length)restoreFailedDraft(draft);
      if(failed.length){
        const detail=failed.map(item=>{const guard=item.error?.trebellUncertain;return `${item.modelId}: ${item.error?.message||item.error}${guard?.threadId?` · possible thread ${guard.threadId}`:guard?" · request may already have started":""}`}).join(" · ");
        const stashNote=stashErrors.length
          ?`${stashSaved}/${failed.length} failed draft${failed.length===1?"":"s"} stashed; ${stashErrors.length} restored to the composer because saving failed`
          :`${stashSaved} failed draft${stashSaved===1?" was":"s were"} stashed for retry`;
        summary.push({id:"fanout-error-"+Date.now(),kind:"error",title:uncertain.length?`${failed.length} model run${failed.length===1?" needs":"s need"} attention; ${uncertain.length} may already have started · ${stashNote}`:`${failed.length}/${fanout.length} model runs failed · ${stashNote}`,status:"done",raw:{detail,stashErrors}});
        desktopNotify("Multi-model run needs attention",uncertain.length?`${uncertain.length} request${uncertain.length===1?" may":"s may"} already have started. ${stashNote}.`:`${stashNote}.`);
      }else desktopNotify("Multi-model run started",`${started.length} background threads are running in isolated worktrees.`);
      if(summary.length)setEvents(prev=>[...prev,...summary]);
    });
    return true;
  }
  async function handleSpecial(text){
    if(!text.startsWith("/"))return null;const [command,...rest]=text.split(/\s+/);
    if(command==="/compact"){
      await compactContext();return true
    }
    if(command==="/ps"){
      if(agentRuntime==="codex"&&activeThread?.id)openRightPanel("runtime");
      else setEvents(prev=>[...prev,{id:"ps-unavailable-"+Date.now(),kind:"error",title:"Background process controls require an open Codex thread",status:"done",raw:{}}]);
      return true
    }
    if(command==="/stop"){
      if(agentRuntime!=="codex"||!activeThread?.id||!rpc){setEvents(prev=>[...prev,{id:"stop-unavailable-"+Date.now(),kind:"error",title:"Background process controls require an open Codex thread",status:"done",raw:{}}]);return true}
      try{await rpc.request("thread/backgroundTerminals/clean",{threadId:activeThread.id});setEvents(prev=>[...prev,{id:"background-stop-"+Date.now(),kind:"tool",title:"Stopped agent background processes",status:"done",raw:{}}])}
      catch(error){setEvents(prev=>[...prev,{id:"background-stop-error-"+Date.now(),kind:"error",title:"Could not stop background processes: "+(error.message||String(error)),status:"done",raw:{}}])}
      return true
    }
    if(command==="/model"){setSection(provider==="freebuff"?"freebuff":"settings");return true}
    if(command==="/terminal"){setPanel("terminal");return true}
    if(command==="/diff"){openRightPanel("diff");return true}
    if(command==="/git"){openRightPanel("source");return true}
    if(command==="/preview"){openRightPanel("preview");return true}
    if(command==="/agents"){if(agentRuntime==="codex")openRightPanel("agents");else setEvents(prev=>[...prev,{id:"agents-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} collaboration controls are not exposed yet`,status:"done",raw:{}}]);return true}
    if(command==="/review"){await startReview();return true}
    if(command==="/feedback"){
      if(agentRuntime!=="codex"||!activeThread?.id||!rpc){setEvents(prev=>[...prev,{id:"feedback-unavailable-"+Date.now(),kind:"error",title:"Codex feedback requires an existing Codex thread",status:"done",raw:{}}]);return true}
      try{
        const result=await rpc.request("feedback/upload",{classification:"bug",reason:rest.join(" ").trim()||null,threadId:activeThread.id,includeLogs:true});
        setEvents(prev=>[...prev,{id:"feedback-"+Date.now(),kind:"tool",title:`Feedback uploaded${result?.threadId?` · ${result.threadId}`:""}`,status:"done",raw:result||{}}]);
      }catch(error){setEvents(prev=>[...prev,{id:"feedback-error-"+Date.now(),kind:"error",title:"Feedback upload failed: "+(error.message||String(error)),status:"done",raw:{}}])}
      return true;
    }
    if(command==="/goal"){if(activeThread?.id)openRightPanel("goal");return true}
    if(command==="/palette"){setPaletteOpen(true);return true}
    if(command==="/new"){await newChat();return true}
    if(command==="/clear"){await newChat();return true}
    if(command==="/plan"){setPrompt("Create a clear execution plan, then carry it out. "+rest.join(" "));return true}
    return false;
  }
  async function compactContext(){
    if(!["codex","opencode","claude"].includes(agentRuntime)){setEvents(prev=>[...prev,{id:"compact-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not expose generic context compaction`,status:"done",raw:{}}]);return}
    if(!activeThread?.id||!rpc)return;
    try{
      await rpc.request("thread/compact/start",{threadId:activeThread.id});
      const id="context-compact-"+activeThread.id;
      setEvents(prev=>{const event={id,kind:"contextCompaction",title:"Compacting context",status:"running",raw:{}};return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?{...item,...event}:item):[...prev,event]});
    }catch(error){
      setEvents(prev=>[...prev,{id:"compact-error-"+Date.now(),kind:"error",title:"Context compaction failed: "+(error.message||String(error)),status:"done",raw:{}}]);
    }
  }
  async function dispatchSend(){
    const text=prompt.trim();if(!text)return;
    if(prompt.length>MAX_COMPOSER_CHARS){setEvents(prev=>[...prev,{id:"prompt-too-long-"+Date.now(),kind:"error",title:`Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()} character limit`,status:"done",raw:{length:prompt.length}}]);return}
    if(text.startsWith("/")){const special=await handleSpecial(text);if(special===true){setPrompt("");return}}
    if(agentRuntime==="antigravity"&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"video-unsupported-"+Date.now(),kind:"error",title:"Antigravity does not accept video attachments",status:"done",raw:{}}]);return}
    if(agentRuntime==="codex"&&queuedEditId&&rpc&&activeThread&&queueMode!=="local"){
      const draft={text,attachments:[...attachments],contextChips:[...contextChips]};setPrompt("");setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);
      try{
        if(await saveNativeQueuedFollowup(draft.text,draft.attachments,draft.contextChips,{queuedId:queuedEditId}))return;
        setPrompt(current=>current||draft.text);setAttachments(current=>current.length?current:draft.attachments);setContextChips(current=>current.length?current:draft.contextChips);setEvents(prev=>[...prev,{id:"queue-update-unavailable-"+Date.now(),kind:"error",title:"This Codex runtime does not support editing native queued follow-ups.",status:"done",raw:{}}]);return;
      }catch(error){setPrompt(current=>current||draft.text);setAttachments(current=>current.length?current:draft.attachments);setContextChips(current=>current.length?current:draft.contextChips);setEvents(prev=>[...prev,{id:"queue-update-error-"+Date.now(),kind:"error",title:"Could not update queued follow-up: "+(error.message||String(error)),status:"done",raw:{}}]);return}
    }
    if(running){
      const draft={text,attachments:[...attachments],contextChips:[...contextChips],model};setPrompt("");setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);
      if(agentRuntime==="codex"&&settings.followUpMode==="steer"&&rpc&&activeThread&&activeTurnId){try{await validateAttachmentPaths(draft.attachments);await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(draft.text,draft.attachments)});setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:draft.text,turnId:activeTurnId}])}catch(error){setPrompt(current=>current||draft.text);setAttachments(current=>current.length?current:draft.attachments);setContextChips(current=>current.length?current:draft.contextChips);throw error}return}
      if(agentRuntime==="codex"&&rpc&&activeThread&&queueMode!=="local"){
        try{if(await saveNativeQueuedFollowup(draft.text,draft.attachments,draft.contextChips))return;setQueued(prev=>[...prev,{id:crypto.randomUUID(),...draft}]);return}
        catch(error){setPrompt(current=>current||draft.text);setAttachments(current=>current.length?current:draft.attachments);setContextChips(current=>current.length?current:draft.contextChips);setEvents(prev=>[...prev,{id:"queue-add-error-"+Date.now(),kind:"error",title:"Could not queue follow-up: "+(error.message||String(error)),status:"done",raw:{}}]);return}
      }
      try{await validateAttachmentPaths(draft.attachments);setQueued(prev=>[...prev,{id:crypto.randomUUID(),...draft}])}
      catch(error){setPrompt(current=>current||draft.text);setAttachments(current=>current.length?current:draft.attachments);setContextChips(current=>current.length?current:draft.contextChips);setEvents(prev=>[...prev,{id:"queue-local-error-"+Date.now(),kind:"error",title:"Could not queue follow-up: "+(error.message||String(error)),status:"done",raw:{}}])}return;
    }
    try{await waitForActiveClone()}catch(error){setEvents(prev=>[...prev,{id:"clone-wait-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
    if(await sendModelFanout(text))return;
    try{await validateAttachmentPaths(attachments)}catch(e){setEvents(prev=>[...prev,{id:"attachment-error-"+Date.now(),kind:"error",title:e.message,status:"done",raw:{}}]);return}
    setPrompt("");setPromptHistoryIndex(-1);setSection("chat");
    if(bootstrap.mock||!rpc||rpcStatus!=="connected"){setMessages(prev=>[...prev,{id:"user-"+Date.now(),role:"user",text}]);setRunning(true);try{const d=await api("/api/chat/direct",{method:"POST",body:{prompt:text,model}});setMessages(prev=>[...prev,{id:"assistant-"+Date.now(),role:"assistant",text:d.text||""}]);setEvents([{id:"fallback",kind:"tool",title:({freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||"Provider")+" direct response",status:"done",raw:{}}])}catch(e){setEvents([{id:"error",kind:"error",title:e.message,status:"done",raw:{}}])}finally{setRunning(false);setAttachments([]);setContextChips([])}return}
    await startTurn(text,attachments,model).catch(e=>{setRunning(false);setEvents([{id:"send-error",kind:"error",title:e.message,status:"done",raw:{}}])});
  }
  async function send(){
    if(submittingRef.current)return;
    submittingRef.current=true;setSubmitting(true);
    try{return await dispatchSend()}
    finally{submittingRef.current=false;setSubmitting(false)}
  }
  async function sendInBackground(){
    if(activeThread?.id||running){await send();return}
    const text=prompt.trim();if(!text)return;
    if(prompt.length>MAX_COMPOSER_CHARS){setEvents(prev=>[...prev,{id:"prompt-too-long-"+Date.now(),kind:"error",title:`Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()} character limit`,status:"done",raw:{length:prompt.length}}]);return}
    if(text.startsWith("/")){await send();return}
    try{await waitForActiveClone()}catch(error){setEvents(prev=>[...prev,{id:"clone-wait-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
    if(await sendModelFanout(text))return;
    if(bootstrap.mock||!rpc||rpcStatus!=="connected"){await send();return}
    if(agentRuntime==="antigravity"&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"video-unsupported-"+Date.now(),kind:"error",title:"Antigravity does not accept video attachments",status:"done",raw:{}}]);return}
    try{await validateAttachmentPaths(attachments)}catch(error){setEvents(prev=>[...prev,{id:"background-attachment-error-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
    const draft={text,attachments:[...attachments],contextChips:[...contextChips],projectPath:projectPath||bootstrap.cwd,model,projectless:projectlessMode};
    setPrompt("");setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);setEvents([]);setAssistantText("");setSection("chat");
    startDetachedTurn(draft.text,draft.attachments,draft.model,{basePath:draft.projectPath,projectless:draft.projectless}).catch(async error=>{
      const stash=await saveFailureStash(draft);
      if(stash.ok){
        setEvents(prev=>[...prev,{id:"background-error-"+Date.now(),kind:"error",title:"Background task failed; draft was stashed: "+(error.message||String(error)),status:"done",raw:{}}]);
        desktopNotify("Background task failed","The draft was saved to Trebell stash.");
      }else{
        restoreFailedDraft(draft);
        setEvents(prev=>[...prev,{id:"background-error-"+Date.now(),kind:"error",title:"Background task failed; stash save also failed, so the draft was restored to the composer: "+(error.message||String(error))+" · Stash error: "+stash.error,status:"done",raw:{taskError:error?.message||String(error),stashError:stash.error}}]);
        desktopNotify("Background task failed","The draft could not be saved to Trebell stash, so it was restored to the composer.");
      }
    });
  }
  async function sendQueuedNow(item){
    if(item?.native&&agentRuntime==="codex"&&rpc&&activeThread?.id){
      if(running&&activeTurnId){
        const originalInput=item.input?.length?item.input:inputsFor(item.draftText||item.text,item.attachments);const originalClientId=item.clientUserMessageId||("trebell-queue-"+crypto.randomUUID());
        try{
          await rpc.request("thread/queue/delete",{threadId:activeThread.id,queuedSubmissionId:item.id});
          await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:originalInput});
          setQueued(prev=>prev.filter(q=>q.id!==item.id));setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.draftText||item.text,turnId:activeTurnId}]);return;
        }catch(error){
          await rpc.request("thread/queue/add",{threadId:activeThread.id,input:originalInput,clientUserMessageId:originalClientId}).catch(()=>{});await loadNativeQueue(rpc,activeThread.id).catch(()=>{});throw error;
        }
      }
      const result=await rpc.request("thread/queue/start",{threadId:activeThread.id,queuedSubmissionId:item.id});const turnId=result?.turn?.id||null;
      setRunning(Boolean(turnId));setActiveTurnId(turnId);setQueued(prev=>prev.filter(q=>q.id!==item.id));
      if(turnId)setMessages(prev=>[...prev,{id:item.clientUserMessageId||("queue-start-"+item.id),role:"user",text:item.draftText||item.text,turnId}]);return;
    }
    await validateAttachmentPaths(item.attachments||[]);setQueued(prev=>prev.filter(q=>q.id!==item.id));if(agentRuntime==="codex"&&running&&rpc&&activeThread&&activeTurnId){await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(item.text,item.attachments)});setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.text,turnId:activeTurnId}])}else if(running)setQueued(prev=>[item,...prev]);else await startTurn(item.text,item.attachments,item.model||model)
  }
  async function editQueued(item){
    if(item?.native){if(!item.editable){setEvents(prev=>[...prev,{id:"queue-edit-unavailable-"+Date.now(),kind:"error",title:"This queued follow-up contains input Trebell cannot safely edit yet.",status:"done",raw:{}}]);return}setQueuedEditId(item.id)}else setQueued(prev=>prev.filter(entry=>entry.id!==item.id));
    setPrompt(item.draftText??item.text??"");setAttachments(item.attachments||[]);setContextChips(item.contextChips||[]);
  }
  async function removeQueued(item){
    if(item?.native&&rpc&&activeThread?.id){await rpc.request("thread/queue/delete",{threadId:activeThread.id,queuedSubmissionId:item.id});if(queuedEditId===item.id)setQueuedEditId(null)}
    setQueued(prev=>prev.filter(entry=>entry.id!==item.id));
  }
  async function moveQueued(item,direction){
    const next=reorderQueue(queued,item.id,direction);if(next===queued||next.map(entry=>entry.id).join("\0")===queued.map(entry=>entry.id).join("\0"))return;
    if(item?.native&&rpc&&activeThread?.id)await rpc.request("thread/queue/reorder",{threadId:activeThread.id,queuedSubmissionIds:next.map(entry=>entry.id)});
    setQueued(next);
  }
  async function stop(){
    if(rpc&&activeThread?.id&&activeTurnId)await rpc.request("turn/interrupt",{threadId:activeThread.id,turnId:activeTurnId});
    if(agentRuntime==="codex"&&queueMode==="native"){setRunning(false);setActiveTurnId(null);await loadNativeQueue(rpc,activeThread?.id);return}
    const restored=restoreQueuedDraft({prompt,attachments,contextChips,queued,maxAttachments:MAX_COMPOSER_ATTACHMENTS});
    setPrompt(restored.prompt);setAttachments(restored.attachments);setContextChips(restored.contextChips);
    setQueued([]);setRunning(false);
  }
  async function editFromHere(message){
    if(!["codex","opencode","claude"].includes(agentRuntime)||!rpc||!activeThread?.id||!message.turnId)return;
    const normalizePath=value=>String(value||"").replace(/\\/g,"/").replace(/\/+$/,"").toLowerCase();
    const isolatedWorktree=Boolean(
      agentRuntime==="codex"&&message.checkpointId&&currentProject?.managedWorktree&&!currentProject.managedWorktree.cleanedAt
      &&normalizePath(currentProject.path)===normalizePath(activeThread.cwd||projectPath)
    );
    const restoreFiles=isolatedWorktree?confirm("Also restore workspace files to the checkpoint before this turn?\n\nOK = conversation + files\nCancel = conversation only"):false;
    if(restoreFiles)await api("/api/checkpoints/restore",{method:"POST",body:{id:message.checkpointId,threadId:activeThread.id}}).catch(e=>alert(e.message));
    await rpc.request("thread/revert",{threadId:activeThread.id,beforeTurnId:message.turnId});setPrompt(message.text);await reloadActiveThread();
  }
  async function stashPrompt(){
    if(prompt.trim()||attachments.length){await api("/api/stashes",{method:"POST",body:{text:prompt,attachments,contextChips,projectPath}});setPrompt("");setAttachments([]);setContextChips([]);return}
    const d=await api("/api/stashes").catch(()=>({stashes:[]}));const stash=d.stashes?.[0];if(stash){setPrompt(stash.text||"");setAttachments(stash.attachments||[]);setContextChips(stash.contextChips||[]);await api("/api/stashes?id="+encodeURIComponent(stash.id),{method:"DELETE"})}
  }
  async function addFiles(paths){setAttachments(prev=>[...new Set([...prev,...paths])].slice(0,MAX_COMPOSER_ATTACHMENTS))}
  async function addContextPath(path,{kind="context",label="Context",detail=""}={}){
    if(!path)return null;
    if(!attachments.includes(path)&&attachments.length>=MAX_COMPOSER_ATTACHMENTS)throw new Error(`Composer supports up to ${MAX_COMPOSER_ATTACHMENTS} attachments/context items.`);
    await addFiles([path]);
    setContextChips(prev=>[...prev.filter(chip=>chip.path!==path),{id:crypto.randomUUID(),path,kind,label,detail}].slice(-MAX_COMPOSER_ATTACHMENTS));
    return path;
  }
  async function prepareAttachmentPaths(paths){
    if(!paths?.length)return [];
    const body={paths};
    const pinnedEnvironment=activeThreadRef.current?.providerMeta?.environmentId??settings.activeEnvironmentId;
    if(pinnedEnvironment!==undefined)body.environmentId=pinnedEnvironment;
    const result=await api("/api/attachments/import",{method:"POST",body});
    return (result.files||[]).map(file=>file.path);
  }
  async function validateAttachmentPaths(paths){
    if(!paths?.length)return {files:[],count:0,imageBytes:0};
    const body={paths};const environmentId=activeThreadRef.current?.providerMeta?.environmentId??settings.activeEnvironmentId;
    if(environmentId!==undefined)body.environmentId=environmentId;
    return api("/api/attachments/validate",{method:"POST",body});
  }
  async function addContextAttachment({name,text,kind="context",label="Context",detail=""}){const d=await api("/api/attachments/text",{method:"POST",body:{name,text}});const [path]=await prepareAttachmentPaths([d.path]);return addContextPath(path,{kind,label,detail})}
  function removeContext(path){setContextChips(prev=>prev.filter(chip=>chip.path!==path));setAttachments(prev=>prev.filter(item=>item!==path))}
  const searchComposerFiles=useCallback(async query=>{
    if(projectlessMode||!projectPath||!String(query||"").trim())return [];
    const params=new URLSearchParams({path:projectPath,q:String(query).trim()});
    if(workspaceEnvironmentId)params.set("environmentId",workspaceEnvironmentId);
    const result=await api("/api/workspace/search?"+params.toString());
    return result.items||[];
  },[projectlessMode,projectPath,workspaceEnvironmentId]);
  async function attachComposerFileMention(item){
    if(!item?.path)return null;
    const body={paths:[item.path]};if(workspaceEnvironmentId!==undefined)body.environmentId=workspaceEnvironmentId;
    const imported=await api("/api/attachments/import",{method:"POST",body});
    const path=imported.files?.[0]?.path||item.path;
    await addContextPath(path,{kind:"file",label:item.name||String(item.path).split(/[\\/]/).pop()||"File",detail:item.relativePath||item.path});
    return path;
  }
  async function pickFiles(){
    const native=window.trebellDesktop?.pickFiles;
    if(native){const p=await native();if(p?.length){const prepared=await prepareAttachmentPaths(p);await addFiles(prepared);return prepared}return[]}
    const files=await new Promise(resolve=>{
      const input=document.createElement("input");input.type="file";input.multiple=true;input.hidden=true;document.body.appendChild(input);let settled=false;
      const done=value=>{if(settled)return;settled=true;input.remove();resolve(value)};
      input.addEventListener("change",()=>done([...(input.files||[])]),{once:true});
      input.addEventListener("cancel",()=>done([]),{once:true});
      window.addEventListener("focus",()=>setTimeout(()=>{if(!settled&&!input.files?.length)done([])},250),{once:true});
      input.click();
    });
    const uploaded=[];for(const file of files.slice(0,Math.max(0,MAX_COMPOSER_ATTACHMENTS-attachments.length))){try{uploaded.push((await blobAttachment(file)).path)}catch{}}
    await addFiles(uploaded);return uploaded;
  }
  async function blobAttachment(file){const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=reject;reader.readAsDataURL(file)});const stored=await api("/api/attachments/blob",{method:"POST",body:{name:file.name,mime:file.type,dataBase64:data}});const [path]=await prepareAttachmentPaths([stored.path]);return {...stored,path}}
  async function captureDesktop(){
    const shot=await window.trebellDesktop?.captureScreen?.();
    if(!shot?.dataUrl)throw new Error("Desktop screenshot is unavailable.");
    const d=await api("/api/attachments/blob",{method:"POST",body:{name:"desktop-snapshot.png",mime:"image/png",dataBase64:String(shot.dataUrl).split(",")[1]||""}});
    const [path]=await prepareAttachmentPaths([d.path]);
    await addContextPath(path,{kind:"computer",label:"Desktop snapshot",detail:(shot.width&&shot.height)?shot.width+"×"+shot.height:"PNG capture"});
  }
  async function onPaste(e){
    const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();const uploaded=[];for(const f of files.slice(0,Math.max(0,MAX_COMPOSER_ATTACHMENTS-attachments.length))){try{uploaded.push((await blobAttachment(f)).path)}catch{}}await addFiles(uploaded);return}
    const text=e.clipboardData?.getData("text/plain")||"";const start=Number(e.currentTarget?.selectionStart)||0,end=Number(e.currentTarget?.selectionEnd)||start;const nextLength=prompt.length-(end-start)+text.length;
    if(text.length>=32768||nextLength>MAX_COMPOSER_CHARS){e.preventDefault();const d=await api("/api/attachments/text",{method:"POST",body:{name:"pasted-context.txt",text}});const prepared=await prepareAttachmentPaths([d.path]);await addFiles(prepared)}
  }
  async function onDrop(e){e.preventDefault();const files=[...(e.dataTransfer?.files||[])];const uploaded=[];for(const f of files.slice(0,Math.max(0,MAX_COMPOSER_ATTACHMENTS-attachments.length))){try{uploaded.push((await blobAttachment(f)).path)}catch{}}await addFiles(uploaded)}
  async function attachExcerpt(text){if(!text.trim())return;await addContextAttachment({name:"terminal-context.txt",text,kind:"terminal",label:"Terminal excerpt",detail:text.split(/\r?\n/).length+" lines"});setPanel(null)}
  async function citeAssistant(message,excerpt=""){
    const selected=String(excerpt||"").trim();
    const source=selected||message?.text?.trim();if(!source)return;
    const threadLabel=activeThread?.name||activeThread?.id||"current thread";
    const text=[selected?"Assistant response excerpt":"Assistant response citation","Thread: "+threadLabel,message?.id?"Message: "+message.id:null,"",source].filter(value=>value!=null).join("\n");
    await addContextAttachment({name:"assistant-citation.txt",text,kind:"citation",label:selected?"Assistant excerpt":"Assistant citation",detail:selected?`${selected.length.toLocaleString()} chars · ${threadLabel}`:threadLabel});
    setPrompt(prev=>(prev?prev+" ":"")+(selected?"Use the cited assistant excerpt as context. ":"Use the attached assistant citation as context. "));
  }
  async function attachReviewComment(path,comment){
    const text=["Code review comment","File: "+path,"",comment].join("\n");
    const filename=String(path).split(/[\\/]/).pop();
    await addContextAttachment({name:"review-"+filename+".txt",text,kind:"review",label:"Review: "+filename,detail:comment.slice(0,70)});
    setPrompt(prev=>(prev?prev+" ":"")+"Address the attached review comment. ");
    setPanel(null);setSection("chat");
  }
  async function attachPr(pr){const text=["Pull request #"+pr.number+": "+pr.title,pr.url,pr.headRefName+" -> "+pr.baseRefName,pr.body||""].join("\n");await addContextAttachment({name:"pr-"+pr.number+".txt",text,kind:"pr",label:"PR #"+pr.number,detail:pr.title});setSection("chat")}
  function applyThreadPullRequestLinks(threadId,links){
    const next=Array.isArray(links)?links:[];if(activeThread?.id===threadId)setLinkedPullRequests(next);
    setThreadMeta(previous=>({...previous,[threadId]:{...(previous[threadId]||{}),linkedPullRequests:next}}));
  }
  async function linkPr(pr){
    if(!activeThread?.id)return;
    const current=linkedPullRequests||[];
    const key=pullRequestIdentity(pr);const existing=current.find(item=>pullRequestIdentity(item)===key);
    const result=await api("/api/source-control/thread-link",{method:"POST",body:{
      action:existing?"unlink":"link",threadId:activeThread.id,pr,cwd:projectPath,environmentId:workspaceEnvironmentId,source:"manual",
    }});
    applyThreadPullRequestLinks(activeThread.id,result.links||[]);
  }
  async function linkPullRequestUrl(url,source="manual"){
    if(!activeThread?.id)throw new Error("Open a thread before linking a pull request.");
    const value=String(url||"").trim();if(!value)throw new Error("Pull request URL is required.");
    const resolved=await api("/api/source-control/thread-link",{method:"POST",body:{action:"resolve",url:value,cwd:projectPath,environmentId:workspaceEnvironmentId}});
    const result=await api("/api/source-control/thread-link",{method:"POST",body:{action:"link",threadId:activeThread.id,pr:resolved.pr,cwd:resolved.project?.path||projectPath,environmentId:resolved.project?.environmentId||workspaceEnvironmentId,source,refresh:false}});
    applyThreadPullRequestLinks(activeThread.id,result.links||[]);return result;
  }
  async function toggleReviewed(path,value){const next=value?[...new Set([...reviewedFiles,path])]:reviewedFiles.filter(x=>x!==path);setReviewedFiles(next);if(activeThread?.id)await updateThreadMeta(activeThread.id,{reviewedFiles:next})}
  function resolveApproval(request,decision){
    if(!rpc)return;rpc.respond(request.id,approvalResponse(request,decision));setApprovals(prev=>prev.filter(x=>x.id!==request.id));
  }
  async function approveGuardianDenial(review){
    if(!rpc||!review?.threadId||guardianBusy)return;
    const reviewId=String(review.reviewId||crypto.randomUUID());setGuardianBusy(reviewId);
    try{
      await rpc.request("thread/approveGuardianDeniedAction",{threadId:review.threadId,event:guardianDeniedEvent(review)});
      setGuardianDenials(prev=>prev.filter(item=>item.reviewId!==review.reviewId));
      setEvents(prev=>[...prev,{id:"auto-review-override-"+Date.now(),kind:"autoReview",title:"Auto review denial overridden by user",status:"done",raw:{reviewId:review.reviewId}}]);
    }catch(error){
      setEvents(prev=>[...prev,{id:"auto-review-override-error-"+Date.now(),kind:"error",title:"Could not override auto review: "+(error.message||String(error)),status:"done",raw:{reviewId:review.reviewId}}]);
    }finally{setGuardianBusy("")}
  }
  function dismissGuardianDenial(review){setGuardianDenials(prev=>prev.filter(item=>item.reviewId!==review.reviewId))}
  async function answerQuestion(answers,filesByQuestion={}){if(!question)return;await validateAttachmentPaths(Object.values(filesByQuestion).flat());const result={};for(const q of question.request.params?.questions||[]){const values=[...(answers[q.id]||[])];const files=filesByQuestion[q.id]||[];if(files.length)values.push("Attached files:\n"+files.map(path=>"- "+path).join("\n"));result[q.id]={answers:values}}question.client.respond(question.request.id,{answers:result});setQuestion(null)}
  function cancelQuestion(){if(question){question.client.respond(question.request.id,{answers:{}});setQuestion(null)}}
  function resolveElicitation(response){
    const current=elicitations[0];if(!current)return;
    current.client.respond(current.request.id,response);
    setElicitations(prev=>prev.slice(1));
  }
  async function verifyMcpUser(request){
    if(agentRuntime!=="codex"||!rpc)throw new Error("Native user verification requires the Codex runtime.");
    if(workspaceEnvironmentId)throw new Error("Device verification is unavailable for remote workspaces.");
    const params=request?.params||{};
    if(params.mode!=="openai/userVerification")throw new Error("This request is not a Codex user-verification challenge.");
    const challenge=String(params.challenge||"").trim(),title=String(params.title||"").trim(),description=String(params.description||"");
    if(!challenge||!title)throw new Error("The verification challenge is incomplete.");
    const result=await rpc.request("userVerification/verify",{challenge,title,description});
    if(!result?.proof)throw new Error("Codex did not return a verification proof.");
    return result.proof;
  }
  async function login(){
    const started=await api("/api/login/start",{method:"POST"});
    if(started?.started!==true)throw new Error("Freebuff sign-in could not be started.");
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,data)=>{
        if(settled)return;settled=true;clearInterval(poll);clearTimeout(timeout);
        error?reject(error):resolve(data);
      };
      const check=async()=>{
        const data=await api("/api/bootstrap").catch(()=>null);
        if(!data?.loggedIn)return;
        try{setBootstrap(data);await refreshProviderModels();finish(null,data)}
        catch(error){finish(error)}
      };
      const poll=setInterval(check,1500);
      const timeout=setTimeout(()=>finish(new Error("Freebuff sign-in timed out. Try again.")),120000);
      check();
    });
  }
  async function logout(){await api("/api/logout",{method:"POST"});setBootstrap(prev=>({...prev,loggedIn:false,providerReady:false}));setModels([]);setModel("");setSelectedModels([]);setFreebuff({loggedIn:false})}
  async function renameThread(){if(!rpc||!activeThread)return;const name=prompt("Rename thread",titleOf(activeThread));if(!name?.trim())return;await rpc.request("thread/name/set",{threadId:activeThread.id,name:name.trim()});setActiveThread(prev=>({...prev,name:name.trim()}));setThreads(prev=>prev.map(t=>t.id===activeThread.id?{...t,name:name.trim()}:t))}
  async function shareThread(){const text=messages.map(m=>(m.role==="user"?"You":"Trebell Code")+": "+m.text).join("\n\n");if(text&&!await writeClipboardText(text))throw new Error("Could not copy conversation.")}
  async function startReview(){
    if(!rpc||!activeThread?.id)throw new Error("Start or open a thread before reviewing.");
    const result=await rpc.request("review/start",{threadId:activeThread.id,target:{type:"uncommittedChanges"}});
    if(result?.turn?.id){setRunning(true);setActiveTurnId(result.turn.id)}
    setEvents(prev=>[...prev,{id:"review-"+Date.now(),kind:"tool",title:"Reviewing uncommitted changes",status:"running",raw:result||{}}]);
    return result;
  }
  async function runProjectAction(script){
    if(!script||!projectPath)return;
    const result=await api("/api/project-script/run",{method:"POST",body:{path:projectPath,environmentId:workspaceEnvironmentId,scriptId:script.id}});
    setSection("chat");setPanel("terminal");
    setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:result?.session?.id||null})),0);
    if(script.previewUrl&&script.autoOpenPreview){
      openRightPanel("preview");
      setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:preview-open",{detail:script.previewUrl})),0);
    }
    return result;
  }
  async function onProjectOpen(path,environmentId=null){
    const targetEnvironmentId=environmentId||null;
    const currentEnvironmentId=settings.activeEnvironmentId||null;
    const shouldStartFresh=Boolean(activeThread?.id&&String(activeThread.cwd||"")!==String(path));
    if(targetEnvironmentId!==currentEnvironmentId){
      const switched=await api("/api/environment/activate",{method:"POST",body:{id:targetEnvironmentId}});
      if(switched.error)throw new Error(switched.error);
      const [nextSettings,nextBootstrap]=await Promise.all([api("/api/settings"),api("/api/bootstrap")]);
      setSettings(prev=>({...prev,...nextSettings}));
      setBootstrap(nextBootstrap);
      setProviderRevision(value=>value+1);
      await refreshEnvironmentThemes();
    }
    await touchProject(path,targetEnvironmentId);
    if(shouldStartFresh)await newChat();
    setSection("chat");
    if(targetEnvironmentId===currentEnvironmentId&&rpcStatus==="connected")loadSkills(rpc,path);
  }
  async function onScopedSettingsChanged(){
    const [nextSettings,projectData]=await Promise.all([api("/api/settings"),api("/api/projects")]);
    setSettings(prev=>({...prev,...nextSettings}));
    const project=(projectData.projects||[]).find(item=>item.id===currentProject?.id)||null;
    if(project){
      setCurrentProject(project);
      const scoped=project.effectiveSettings||{};
      if(scoped.defaultModel&&models.includes(scoped.defaultModel)){setModel(scoped.defaultModel);setSelectedModels([scoped.defaultModel])}
      if(scoped.defaultPermissionMode)setPermissionMode(scoped.defaultPermissionMode);
      if(scoped.defaultWorkspaceMode)setWorkspaceMode(scoped.defaultWorkspaceMode);
    }
  }
  async function finishOnboarding({openSettings=false}={}){
    const next=await api("/api/settings",{method:"POST",body:{onboardingComplete:true,defaultPermissionMode:permissionMode}});
    setSettings(prev=>({...prev,...next}));
    if(rpc&&rpcStatus==="connected")await loadThreads(rpc).catch(()=>{});
    if(openSettings)setSection("settings");
  }
  async function historyImported(){
    if(rpc&&rpcStatus==="connected")await loadThreads(rpc).catch(()=>{});
  }
  async function pickWorkspace(){
    const path=await window.trebellDesktop?.pickDirectory?.();
    if(!path)return;
    await onProjectOpen(path);
  }
  function onSkill(skill){const prefix=agentRuntime==="codex"?"$":"/";setPrompt(prev=>(prev?prev+" ":"")+prefix+skill.name+" ")}
  async function changeProviderAgent(name){
    const previous=providerAgent;const next=name||"";setProviderAgent(next);
    if(agentRuntime==="codex"||!activeThread?.id||!rpc||rpcStatus!=="connected")return;
    try{
      const result=await rpc.request("thread/settings/update",{threadId:activeThread.id,settings:{agent:next||null}});
      if(!result?.thread)throw new Error("The active agent runtime did not confirm the agent change.");
      setProviderAgent(result.thread.agent||next);
      setActiveThread(result.thread);setThreads(prev=>prev.map(thread=>thread.id===result.thread.id?result.thread:thread));
    }catch(error){
      setProviderAgent(previous);
      showActionError(error,"Could not change provider agent");
    }
  }
  async function changeComposerModel(nextModel){
    const previous=model;
    setModel(nextModel);
    if(agentRuntime!=="codex"||!running||!activeThread?.id||!activeTurnId||!rpc||rpcStatus!=="connected"||nextModel===previous)return;
    try{
      const features=await rpc.request("experimentalFeature/list",{limit:200,threadId:activeThread.id});
      const liveSwitch=(features?.data||[]).find(feature=>feature.name==="step_model_switching");
      if(!liveSwitch?.enabled){
        setEvents(prev=>[...prev,{id:"live-model-next-turn-"+Date.now(),kind:"tool",title:"Model changed for the next turn. Live model switching is disabled in Codex experimental features.",status:"done",raw:{model:nextModel}}]);
        return;
      }
      const result=await rpc.request("turn/settings/update",{threadId:activeThread.id,turnId:activeTurnId,model:nextModel});
      if(result?.status==="targetUnavailable"){
        setEvents(prev=>[...prev,{id:"live-model-unavailable-"+Date.now(),kind:"tool",title:"Model changed for the next turn; the current turn was already finishing.",status:"done",raw:{model:nextModel}}]);
      }else{
        setEvents(prev=>[...prev,{id:"live-model-"+Date.now(),kind:"tool",title:"Running turn switched to "+(modelMeta?.[nextModel]?.name||modelLabel(nextModel,freebuff)||nextModel),status:"done",raw:{model:nextModel}}]);
      }
    }catch(error){
      setEvents(prev=>[...prev,{id:"live-model-error-"+Date.now(),kind:"error",title:"Could not change the running turn's model. The new model will apply to the next turn: "+(error.message||String(error)),status:"done",raw:{model:nextModel}}]);
    }
  }

  function openRightPanel(tab="files"){
    if(projectlessMode&&["diff","source"].includes(tab)){
      setEvents(prev=>[...prev,{id:"general-panel-"+Date.now(),kind:"tool",title:"General chats do not have Git or repository changes.",status:"done",raw:{tab}}]);
      return;
    }
    setRightPanelTab(tab);setRightPanelOpen(true);setSection("chat");
  }
  function navigateSection(next){
    if(next==="source"){openRightPanel("source");return}
    if(next==="preview"){openRightPanel("preview");return}
    if(next==="agents"){openRightPanel("agents");return}
    setSection(next);
  }
  async function saveAppSettings(patch){
    if("appearance" in patch&&environmentThemeCatalog?.environmentKey){
      const selections={...(settings.environmentThemeSelections||{})};
      delete selections[environmentThemeCatalog.environmentKey];
      patch={...patch,environmentThemeSelections:selections};
    }
    const next=await api("/api/settings",{method:"POST",body:patch});setSettings(prev=>({...prev,...next}));return next;
  }
  async function cycleTheme(){const themes=["dark","midnight","black",...(settings.customThemes||[]).map(theme=>theme.id)];const next=themes[(themes.indexOf(settings.appearance||"dark")+1)%themes.length];await saveAppSettings({appearance:next})}
  async function cycleAppearance(){const modes=["system","light","dark"];const next=modes[(modes.indexOf(settings.appearanceMode||"system")+1)%modes.length];await saveAppSettings({appearanceMode:next})}

  const activeTitle=titleOf(activeThread);
  const projectLabel=projectlessMode?"No project":String(projectPath||activeThread?.cwd||bootstrap.cwd||"Workspace").split(/[\\/]/).filter(Boolean).at(-1)||"Workspace";
  const providerLabel=({freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||provider);
  const agentRuntimeLabel=({codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"}[agentRuntime]||agentRuntime);
  const completedEvents=events.filter(event=>event.status==="done").length;
  const paletteActions=[
    {id:"new",label:"New thread",detail:"Start a clean coding task",shortcut:"Ctrl+N",onRun:newChat},
    {id:"new-general",label:"New general chat",detail:"Start without attaching a project or repository",onRun:newGeneralChat},
    ...(window.trebellDesktop?.pickDirectory?[{id:"folder",label:"Open workspace folder",detail:projectPath||"Choose a local folder",onRun:pickWorkspace}]:[]),
    {id:"projects",label:"Recent projects",detail:"Switch checkouts or clone a repository",onRun:()=>setSection("projects")},
    {id:"files",label:"Files",detail:"Browse and edit the workspace",onRun:()=>openRightPanel("files")},
    ...(!projectlessMode?[{id:"diff",label:"Changes",detail:"Inspect the current Git diff",onRun:()=>openRightPanel("diff")},{id:"git",label:"Source control",detail:gitInfo?.branch||"Git and pull requests",onRun:()=>openRightPanel("source")}]:[]),
    ...(activeThread?.id?[{id:"link-pr",label:"Link pull request",detail:"Attach a hosted review to this thread",onRun:async()=>{const url=prompt("Pull request URL");if(url)await linkPullRequestUrl(url,"manual")}}]:[]),
    {id:"terminal",label:"Terminal",detail:"Open the persistent PTY",shortcut:"Ctrl+Shift+T",onRun:()=>setPanel("terminal")},
    ...((currentProject?.scripts||[]).map(script=>({id:"project-action:"+script.id,label:"Run "+script.name,detail:script.command,onRun:()=>runProjectAction(script)}))),
    {id:"browser",label:"Browser",detail:window.trebellDesktop?.browser?"Open Trebell Agent Browser":"Open hosted preview and local dev-server tools",onRun:()=>openRightPanel("preview")},
    ...(agentRuntime==="codex"?[{id:"agents",label:"Agents & collaboration",detail:"Delegated threads and collaboration mode",onRun:()=>openRightPanel("agents")}]:[]),
    ...(activeThread?.id?[{id:"goal",label:"Thread goal",detail:goal?.objective||"Set a durable objective",onRun:()=>openRightPanel("goal")}]:[]),
    ...(activeThread?.id&&gitInfo?.isGit?[{id:"review",label:"Review changes",detail:`Ask ${agentRuntimeLabel} to review uncommitted changes`,onRun:()=>startReview()}]:[]),
    ...(agentRuntime==="codex"?[{id:"tools",label:"Harness capabilities",detail:"Skills, MCP, plugins, apps and hooks",onRun:()=>setSection("tools")}]:[]),
    {id:"environments",label:"Environments",detail:"Local, WSL, SSH and remote access",onRun:()=>setSection("environments")},
    {id:"usage",label:"Usage",detail:"Tokens and cost across recorded turns",onRun:()=>setSection("usage")},
    {id:"licenses",label:"Open source licenses",detail:"Third-party packages and installed license notices",onRun:()=>setSection("licenses")},
    {id:"appearance-system",label:"Appearance: System",detail:"Follow the operating system light/dark setting",shortcut:"Ctrl+Alt+Shift+A",onRun:()=>saveAppSettings({appearanceMode:"system"})},
    {id:"appearance-light",label:"Appearance: Light",detail:"Use light appearance",onRun:()=>saveAppSettings({appearanceMode:"light"})},
    {id:"appearance-dark",label:"Appearance: Dark",detail:"Use dark appearance",onRun:()=>saveAppSettings({appearanceMode:"dark"})},
    {id:"theme-trebell",label:"Theme: Trebell",detail:"Default purple Trebell palette",shortcut:"Ctrl+Alt+A",onRun:()=>saveAppSettings({appearance:"dark"})},
    {id:"theme-midnight",label:"Theme: Midnight",detail:"Cooler deep-blue Trebell palette",onRun:()=>saveAppSettings({appearance:"midnight"})},
    {id:"theme-black",label:"Theme: Black",detail:"OLED-friendly black Trebell palette",onRun:()=>saveAppSettings({appearance:"black"})},
    ...(settings.customThemes||[]).map(theme=>({id:"theme-custom:"+theme.id,label:"Theme: "+theme.name,detail:`Custom ${theme.appearance||"dark"} theme`,onRun:()=>saveAppSettings({appearance:theme.id})})),
    {id:"settings",label:"Settings",detail:window.trebellDesktop?"Providers, permissions and desktop behavior":"Providers, permissions and workspace behavior",onRun:()=>setSection("settings")},
    ...(activeThread?.id&&messages.length?[{id:"copy",label:"Copy conversation",detail:"Copy this thread as text",onRun:shareThread}]:[]),
  ];

  const previewSurface=<PreviewPage
    projectPath={projectPath}
    onAttachText={async(name,text,meta={})=>addContextAttachment({name,text,kind:meta.kind||"browser",label:meta.label||"Browser context",detail:meta.detail||""})}
    onAttachImage={async(dataUrl)=>{const d=await api("/api/attachments/blob",{method:"POST",body:{name:"browser-screenshot.png",mime:"image/png",dataBase64:String(dataUrl).split(",")[1]||""}});const [path]=await prepareAttachmentPaths([d.path]);await addContextPath(path,{kind:"browser",label:"Browser screenshot",detail:"PNG capture"})}}
    onAttachFile={async(file,meta={})=>{const d=await blobAttachment(file);await addContextPath(d.path,{kind:meta.kind||"browser",label:meta.label||file.name,detail:meta.detail||`${Math.round(file.size/1024)} KB`})}}
  />;

  function rightPanelContent(){
    if(rightPanelTab==="files"||rightPanelTab==="diff")return <WorkspacePanel key={rightPanelTab+":"+(workspaceEnvironmentId||"local")} defaultTab={rightPanelTab==="diff"&&!projectlessMode?"diff":"files"} allowDiff={!projectlessMode} projectPath={projectPath} environmentId={workspaceEnvironmentId} remote={workspaceRemote} activeThreadId={activeThread?.id} reviewedFiles={reviewedFiles} onReviewedChange={toggleReviewed} onAttachPath={path=>addFiles([path])} onReviewComment={attachReviewComment}/>;
    if(rightPanelTab==="preview")return previewSurface;
    if(rightPanelTab==="source")return projectlessMode?<div className="empty-state">General chats are not attached to source control.</div>:<SourceControlPanel projectPath={projectPath} environmentId={workspaceEnvironmentId} remote={workspaceRemote} environmentName={currentProject?.environment?.name||bootstrap.activeEnvironment?.name||"Local machine"} model={model} provider={provider} threadId={activeThread?.id||null} sourceControlSettings={currentProject?.effectiveSettings||effectiveProjectSettings} onProjectChange={onProjectOpen} onAttachPr={attachPr} onLinkPr={linkPr} onLinkPrUrl={linkPullRequestUrl} onOpenLinkedThread={openLinkedThread} onSelectedPrChange={setSourceSelectedPr} onLinkedPullRequestsChanged={links=>activeThread?.id&&applyThreadPullRequestLinks(activeThread.id,links)} linkedPullRequests={activeThread?.id?linkedPullRequests:[]}/>;
    if(rightPanelTab==="device")return <DevicePanel/>;
    if(rightPanelTab==="agents"&&agentRuntime==="codex")return <div className="panel-page"><AgentsPage threads={threads} activeThread={activeThread} onOpen={openThread} onAction={threadAction} onRefreshThreads={()=>rpc?loadThreads(rpc):Promise.resolve([])} rpc={rpc} rpcStatus={rpcStatus} model={model} telemetry={threadTelemetry}/></div>;
    if(rightPanelTab==="goal")return <GoalPanel rpc={rpc} rpcStatus={rpcStatus} thread={activeThread} goal={goal} onGoal={setGoal}/>;
    return <div className="runtime-surface">
      <section className="runtime-summary">
        <div><span className={"runtime-dot "+(rpcStatus==="connected"?"online":"")}/><div><strong>{running?"Agent working":agentRuntimeLabel+" harness"}</strong><span>{rpcStatus==="connected"?"Connected locally":rpcStatus}</span></div></div>
        <small>{completedEvents}/{events.length||1} current activity steps complete</small>
      </section>
      <ApprovalCard request={approvals[0]} onResolve={resolveApproval}/>
      <section className="runtime-grid">
        <div><span>Agent harness</span><strong>{agentRuntimeLabel}</strong></div>
        <div><span>Harness status</span><strong>{providerReady?"Ready":"Setup required"}</strong></div>
        <div><span>CPU</span><strong>{stats.cpu||"—"}</strong></div>
        <div><span>Memory</span><strong>{stats.memory||"—"}</strong></div>
        <div><span>Disk</span><strong>{stats.disk||"—"}</strong></div>
        <div><span>Context</span><strong>{tokenLabel(tokenUsage)}</strong></div>
      </section>
      {agentRuntime==="codex"&&activeThread?.id&&<AgentBackgroundTerminals rpc={rpc} rpcStatus={rpcStatus} threadId={activeThread.id}/>}
      {agentRuntime==="codex"&&provider==="freebuff"&&<FreebuffMini freebuff={freebuff} model={model} onOpen={()=>setSection("freebuff")}/>}
      <section className="runtime-activity"><strong>Latest activity</strong><p>{events.find(event=>event.status==="running")?.title||events.at(-1)?.title||"Waiting for a task"}</p></section>
    </div>;
  }

  const layoutStyle={
    "--sidebar-width":layoutPrefs.sidebarWidth+"px",
    "--right-panel-width":layoutPrefs.rightPanelWidth+"px",
    "--terminal-height":layoutPrefs.terminalHeight+"px",
  };
  return <div className={"app-shell"+(sidebarOpen?"":" sidebar-collapsed")+(window.trebellDesktop?" desktop-shell":" hosted-shell")} style={layoutStyle}>
    <ThreadSidebar section={section} setSection={navigateSection} threads={displayThreads} activeThreadId={activeThread?.id} query={query} setQuery={setQuery} onOpen={openThread} onNew={newChat} onThreadAction={threadAction} onMove={moveThreadOrder} selectedIds={selectedThreadIds} setSelectedIds={setSelectedThreadIds} onBulkAction={bulkAction} provider={provider} agentRuntime={agentRuntime} threadMeta={threadMeta} onCollapse={()=>setSidebarOpen(false)} rightPanelOpen={rightPanelOpen} rightPanelTab={rightPanelTab}/>
    {sidebarOpen&&<div className="layout-resizer sidebar-resizer" data-testid="sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" onPointerDown={event=>beginLayoutResize("sidebar",event)}/>}

    <div className={"workspace-shell"+(rightPanelOpen?" right-open":"")+(rightPanelOpen&&rightPanelMaximized?" right-maximized":"")}>
      <main className={"main-frame"+(panel==="terminal"?" terminal-open":"")}>
        <div className="window-bar">
          <span className="window-drag-space"/>
          {window.trebellDesktop?.minimize&&window.trebellDesktop?.maximize&&window.trebellDesktop?.close&&<div className="window-controls"><button onClick={()=>window.trebellDesktop.minimize()}>—</button><button onClick={()=>window.trebellDesktop.maximize()}>□</button><button className="window-close" onClick={()=>window.trebellDesktop.close()}>×</button></div>}
        </div>

        {(section==="chat"||section==="new")&&<div className="chat-workspace">
          <header className="workspace-header">
            <div className="workspace-breadcrumb">
              {!sidebarOpen&&<button className="project-crumb sidebar-reopen" onClick={()=>setSidebarOpen(true)} aria-label="Open sidebar" title="Open sidebar · Ctrl+B"><PanelLeftOpen size={14}/></button>}
              <button className={"project-crumb"+(projectlessMode?" projectless":"")} onClick={projectlessMode||!window.trebellDesktop?.pickDirectory?()=>setSection("projects"):()=>runUserAction(pickWorkspace,"Could not open workspace")} title={projectlessMode?"No project · choose a project":window.trebellDesktop?.pickDirectory?(projectPath||"Open folder"):"Projects and workspaces"}>{projectlessMode?<Sparkles size={14}/>:<FolderCode size={14}/>}<span>{projectLabel}</span></button><button className="project-switcher" onClick={()=>setSection("projects")} title="Projects and General chat"><ChevronDown size={12}/></button>
              <span>/</span>
              <button className="thread-title-button" onDoubleClick={renameThread} onClick={renameThread} title="Rename thread"><strong>{activeTitle}</strong><ChevronDown size={13}/></button>
              {activeThread?.id&&linkedPullRequests.map(pr=><button className="header-pr" key={pr.url||pr.number} onClick={()=>window.open(pr.url,"_blank")}><GitBranch size={11}/>#{pr.number}</button>)}
            </div>
            <div className="workspace-header-actions">
              {gitInfo?.isGit&&<button className="header-control branch-control" onClick={()=>openRightPanel("source")} title="Source control"><GitBranch size={14}/><span>{gitInfo.branch||"detached"}</span></button>}
              {!projectlessMode&&!workspaceRemote&&<OpenInPicker path={projectPath}/>}
              {(currentProject?.scripts||[]).length>0&&(()=>{const script=(currentProject.scripts||[]).find(item=>item.id===currentProject.preferredScriptId)||currentProject.scripts[0];return <button className="header-control" onClick={()=>runUserAction(()=>runProjectAction(script),"Project action failed")} title={script.command}><Play size={13}/><span>{script.name}</span></button>})()}
              {activeThread?.id&&gitInfo?.isGit&&<button className="header-control" onClick={()=>runUserAction(startReview,"Could not start review")} title="Review uncommitted changes"><ShieldCheck size={14}/><span>Review</span></button>}
              {running&&<button className="header-control stop-control" onClick={()=>runUserAction(stop,"Could not stop turn")}><CircleStop size={14}/><span>Stop</span></button>}
              <button data-testid="terminal-toggle" className={"header-control icon-only "+(panel==="terminal"?"active":"")} onClick={()=>setPanel(panel==="terminal"?null:"terminal")} aria-label="Toggle terminal" title="Toggle terminal"><PanelBottom size={16}/></button>
              {activeThread?.id&&<button className={"header-control icon-only "+(rightPanelOpen&&rightPanelTab==="goal"?"active":"")} onClick={()=>openRightPanel("goal")} aria-label="Thread goal" title={goal?.objective||"Set thread goal"}><Target size={15}/></button>}
              <button data-testid="right-panel-toggle" className={"header-control icon-only "+(rightPanelOpen?"active":"")} onClick={()=>{if(rightPanelOpen){setRightPanelOpen(false);setRightPanelMaximized(false)}else openRightPanel("files")}} aria-label="Open files and diff" title="Toggle workspace panel"><PanelRight size={16}/></button>
              <button className="header-control icon-only" onClick={()=>setPaletteOpen(true)} aria-label="Command palette" title="Command palette · Ctrl+K"><Command size={15}/></button>
            </div>
          </header>

          <ThreadFindBar state={threadFind} inputRef={threadFindInputRef} onQuery={query=>setThreadFind(current=>({...current,query,error:""}))} onPrevious={()=>stepThreadFind(-1)} onNext={()=>stepThreadFind(1)} onClose={closeThreadFind}/>

          <div className="conversation-scroll" ref={conversationScrollRef} onScroll={conversationScrolled}>
            <div className="conversation-column">
              <WorktreeSetupCard setup={worktreeSetup} onOpenTerminal={()=>{setPanel("terminal");if(worktreeSetup?.sessionId)setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:worktreeSetup.sessionId})),0)}} onDismiss={()=>setWorktreeSetup(null)}/>
              <Conversation messages={messages} onEditFromHere={editFromHere} onCite={citeAssistant} allowRevert={["codex","opencode","claude"].includes(agentRuntime)} projectPath={projectPath} environmentId={workspaceEnvironmentId} threadId={activeThread?.id||null} canLoadEarlier={agentRuntime==="codex"&&historyPage.threadId===activeThread?.id&&Boolean(historyPage.nextCursor)} loadingEarlier={historyPage.loading} onLoadEarlier={loadEarlierMessages} activeFindItemId={threadFind.activeItemId}/>
              <ActivityTimeline events={events} assistantText={assistantText} onOpenPanel={name=>name==="workspace"?openRightPanel("diff"):setPanel(name)}/>
              {guardianDenials.map(review=><div className="inline-approval" key={review.reviewId}><GuardianDenialCard review={review} busy={guardianBusy===String(review.reviewId)} onApprove={approveGuardianDenial} onDismiss={dismissGuardianDenial}/></div>)}
              {approvals[0]&&<div className="inline-approval"><ApprovalCard request={approvals[0]} onResolve={resolveApproval}/></div>}
              {queued.map((item,index)=><div className={"queued-message"+(queuedEditId===item.id?" editing":"")} key={item.id}><span>{item.native?"Queued in Codex":"Queued"}{queuedEditId===item.id?" · editing":""}</span><p>{item.text}</p><div className="queued-message-actions"><button onClick={()=>runUserAction(()=>sendQueuedNow(item),"Could not send queued follow-up")}>Send now</button><button onClick={()=>editQueued(item)} disabled={queuedEditId===item.id||item.editable===false}>{queuedEditId===item.id?"Editing…":"Edit"}</button><button aria-label="Move queued follow-up up" title="Move up" disabled={index===0} onClick={()=>runUserAction(()=>moveQueued(item,-1),"Could not reorder queued follow-up")}>↑</button><button aria-label="Move queued follow-up down" title="Move down" disabled={index===queued.length-1} onClick={()=>runUserAction(()=>moveQueued(item,1),"Could not reorder queued follow-up")}>↓</button><button onClick={()=>runUserAction(()=>removeQueued(item),"Could not remove queued follow-up")}>Remove</button></div></div>)}
              {!messages.length&&!events.length&&<div className="welcome">
                <div className="welcome-mark"><img src="/trebell-code-icon.svg" alt="" aria-hidden="true"/></div>
                <h1>{projectlessMode?"What do you want to think through?":"What do you want to build?"}</h1>
                <p>{projectlessMode?"This is a General chat with no attached project. Files and terminal commands stay inside a Trebell-managed scratch workspace.":<>{agentRuntime==="codex"?`${providerLabel} supplies inference to the Codex harness.`:`${agentRuntimeLabel} is the active coding-agent harness.`} Trebell keeps files, terminal, Git, worktrees, previews and project actions in one workspace.</>}</p>
                <div className="suggestions">{projectlessMode?<><button onClick={()=>setPrompt("Help me plan the architecture for this idea before I choose a repository.")}>Plan an idea</button><button onClick={()=>setPrompt("Research this technical question and give me a practical recommendation: ")}>Research a topic</button><button onClick={()=>setPrompt("Turn this rough idea into a clear technical specification: ")}>Draft a spec</button></>:<><button onClick={()=>setPrompt("Inspect this project and explain the architecture.")}>Explain codebase</button><button onClick={()=>setPrompt("Find a useful bug, fix it, and run the relevant tests.")}>Fix a bug</button><button onClick={()=>setPrompt("Implement the next missing feature and validate it end-to-end.")}>Ship a feature</button></>}</div>
              </div>}
            </div>
          </div>

          {currentProject?.cloneJob&&currentProject.cloneJob.status!=="completed"&&<div className={"clone-banner "+currentProject.cloneJob.status} data-testid="clone-banner"><div><strong>{currentProject.cloneJob.phase||"Cloning repository"}</strong><span>{currentProject.cloneJob.status==="failed"?(currentProject.cloneJob.error||"Clone failed"):currentProject.cloneJob.status==="cancelled"?"Clone cancelled":"You can keep writing. Send waits until the repository is ready."}</span></div>{["running","cancelling"].includes(currentProject.cloneJob.status)&&<i><b style={{width:Math.max(2,Number(currentProject.cloneJob.progress)||0)+"%"}}/></i>}<em>{Math.round(currentProject.cloneJob.progress||0)}%</em>{currentProject.cloneJob.status==="running"&&<button onClick={()=>runUserAction(()=>cloneProjectAction("cancel"),"Could not cancel clone")}><X size={11}/> Cancel</button>}{["failed","cancelled"].includes(currentProject.cloneJob.status)&&<button onClick={()=>runUserAction(()=>cloneProjectAction("retry"),"Could not retry clone")}>Retry clone</button>}</div>}
          <Composer prompt={prompt} setPrompt={setPrompt} onPromptEdit={()=>setPromptHistoryIndex(-1)} historyIndex={promptHistoryIndex} onSend={send} onBackgroundSend={sendInBackground} canBackground={!activeThread?.id&&!running&&!submitting&&!bootstrap.mock&&rpcStatus==="connected"} running={running} submitting={submitting} providerReady={providerReady} provider={provider} agentRuntime={agentRuntime} agentRuntimeLabel={agentRuntimeLabel} login={login} onConfigureProvider={()=>setSection("settings")} models={models} modelMeta={modelMeta} model={model} setModel={changeComposerModel} selectedModels={selectedModels} onSelectedModels={setSelectedModels} allowMultiModel={!activeThread?.id&&!running&&!submitting&&!bootstrap.mock&&rpcStatus==="connected"&&Boolean(gitInfo?.isGit)} modelError={modelError} freebuff={freebuff} attachments={attachments} contextChips={contextChips} onRemoveAttachment={path=>setAttachments(prev=>prev.filter(x=>x!==path))} onRemoveContext={removeContext} onPickFiles={pickFiles} onCaptureScreen={()=>runUserAction(captureDesktop,"Could not capture screen")} onPaste={onPaste} onDrop={onDrop} onFileMentionSearch={searchComposerFiles} onFileMentionAttach={attachComposerFileMention} permissionMode={permissionMode} setPermissionMode={setPermissionMode} collaborationModes={collaborationModes} collaborationMode={collaborationMode} onCollaborationMode={changeCollaborationMode} collaborationModeBusy={collaborationModeBusy} providerCommands={providerCommands} providerAgents={providerAgents} providerAgent={providerAgent} onProviderAgent={changeProviderAgent} settings={settings} tokenUsage={tokenUsage} workspaceMode={workspaceMode} setWorkspaceMode={setWorkspaceMode} projectless={projectlessMode} threadOpen={Boolean(activeThread?.id)} gitAvailable={Boolean(gitInfo?.isGit)} canCompact={Boolean(activeThread?.id&&rpc&&rpcStatus==="connected"&&["codex","opencode","claude"].includes(agentRuntime))} onCompact={compactContext} runtimeProfiles={threadRuntimeProfiles} runtimeProfileBusy={threadRuntimeProfileBusy} onRuntimeProfile={switchThreadRuntimeProfile} onModelPickerOpenChange={setModelPickerOpen}/>

          {panel==="terminal"&&<div className="terminal-drawer" data-testid="drawer">
            <div className="layout-resizer terminal-resizer" data-testid="terminal-resizer" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" onPointerDown={event=>beginLayoutResize("terminal",event)}/>
            <div className="terminal-drawer-head"><span><SquareTerminal size={14}/> Terminal</span><div><button onClick={()=>attachExcerpt("")} aria-hidden="true" tabIndex={-1} className="terminal-head-spacer"/><button onClick={()=>setPanel(null)} aria-label="Close terminal"><X size={15}/></button></div></div>
            <DeferredSurface label="Loading terminal…" compact><TerminalPanel projectPath={projectPath} environmentId={workspaceEnvironmentId} environmentName={currentProject?.environment?.name||bootstrap.activeEnvironment?.name||"Local machine"} onAttachExcerpt={attachExcerpt}/></DeferredSurface>
          </div>}
        </div>}

        {section==="projects"&&<div className="secondary-page"><div className="page-header"><div><h1>Projects</h1><p>Repositories and workspaces across local, WSL and SSH environments.</p></div></div><DeferredSurface label="Loading projects…"><ProjectsPage currentPath={projectlessMode?null:projectPath} currentEnvironmentId={workspaceEnvironmentId} onOpen={onProjectOpen} onGeneralChat={newGeneralChat} models={models} onProjectUpdated={project=>{if(project?.path===projectPath&&(project?.environmentId||null)===(workspaceEnvironmentId||null))setCurrentProject(project)}} onRunScript={result=>{setSection("chat");setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:result?.session?.id||null})),0)}} onOpenPreview={previewUrl=>{openRightPanel("preview");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:preview-open",{detail:previewUrl})),0)}}/></DeferredSurface></div>}
        {section==="freebuff"&&agentRuntime==="codex"&&provider==="freebuff"&&<div className="secondary-page"><div className="page-header"><div><h1>Freebuff</h1><p>Account, balance, model pricing and session state.</p></div></div><DeferredSurface label="Loading Freebuff…"><FreebuffPage freebuff={freebuff} model={model} modelMeta={modelMeta} onRefresh={()=>refreshFreebuff(model)}/></DeferredSurface></div>}
        {section==="tools"&&agentRuntime==="codex"&&<div className="secondary-page full"><DeferredSurface label="Loading harness capabilities…"><HarnessToolsPage rpc={rpc} rpcStatus={rpcStatus} projectPath={projectPath} activeThread={activeThread} skills={skills} onHistoryImported={historyImported} onSkillsRefresh={()=>loadSkills(rpc,projectPath,true)} platform={bootstrap.platform}/></DeferredSurface></div>}
        {section==="environments"&&<div className="secondary-page full"><DeferredSurface label="Loading environments…"><EnvironmentsPage/></DeferredSurface></div>}
      {section==="usage"&&<div className="secondary-page full"><DeferredSurface label="Loading usage…"><UsagePage settings={settings} rpc={rpc} rpcStatus={rpcStatus} activeThread={activeThread} agentRuntime={agentRuntime}/></DeferredSurface></div>}
        {section==="licenses"&&<div className="secondary-page full"><div className="page-header"><div><h1>Open source licenses</h1><p>Installed third-party software, versions and license notices.</p></div></div><DeferredSurface label="Loading licenses…"><LicensesPage/></DeferredSurface></div>}
      {section==="settings"&&<div className="secondary-page full"><div className="page-header"><div><h1>Settings</h1><p>{window.trebellDesktop?"Agent harnesses, model providers, permissions and desktop behavior.":"Agent harnesses, model providers, permissions and workspace behavior."}</p></div></div><DeferredSurface label="Loading settings…"><SettingsPage settings={settings} onSettings={setSettings} onProviderChanging={nextProvider=>{modelRefreshSeqRef.current++;modelCatalogScopeRef.current=agentRuntime+"\0"+nextProvider;setModels([]);setModel("");setSelectedModels([]);setModelMeta({});setModelError("")}} onProviderUpdated={(options={})=>{setProviderRevision(v=>v+1);return refreshProviderModels({...options,resetThread:options.resetThread??false})}} runtime={runtime} rpcStatus={rpcStatus} loggedIn={bootstrap.loggedIn||bootstrap.mock} login={login} logout={logout} projectPath={projectlessMode?null:projectPath} runtimeEnvironmentId={workspaceEnvironmentId} onOpenRuntimeAuthTerminal={session=>{setSection("chat");setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:session?.id||null})),0)}} projectScripts={projectlessMode?[]:currentProject?.scripts||[]} modelError={modelError} onOpenLicenses={()=>setSection("licenses")} models={models} onScopedSettingsChanged={onScopedSettingsChanged} environmentThemeCatalog={environmentThemeCatalog} environmentThemes={environmentThemes} onRefreshEnvironmentThemes={refreshEnvironmentThemes}/></DeferredSurface></div>}
        {section==="history"&&<div className="secondary-page"><div className="page-header"><div><h1>Thread history</h1><p>Every unarchived {agentRuntimeLabel} thread stored by Trebell on this machine.</p></div></div><div className="history-page">{threads.length?threads.map(t=><button key={t.id} onClick={()=>runUserAction(()=>openThread(t),"Could not open thread")}><FileCode2 size={15}/><div><strong>{titleOf(t)}</strong><span>{t.preview||t.cwd}</span></div><time>{new Date(t.updatedAt*1000).toLocaleString()}</time></button>):<div className="history-empty"><History size={22}/><strong>No thread history yet</strong><span>Start a task or General chat and it will appear here.</span><button onClick={()=>runUserAction(newChat,"Could not start a new thread")}>Start a new task</button></div>}</div></div>}
      </main>

      {rightPanelOpen&&!rightPanelMaximized&&<div className="layout-resizer right-panel-resizer" data-testid="right-panel-resizer" role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" onPointerDown={event=>beginLayoutResize("right",event)}/>}
      {rightPanelOpen&&<RightPanel active={rightPanelTab} disabledTabs={projectlessMode?["diff","source"]:[]} hiddenTabs={agentRuntime==="codex"?[]:["agents"]} maximized={rightPanelMaximized} onToggleMaximized={()=>setRightPanelMaximized(value=>!value)} onActive={tab=>openRightPanel(tab)} onClose={()=>{setRightPanelOpen(false);setRightPanelMaximized(false)}}><DeferredSurface label="Loading panel…" compact>{rightPanelContent()}</DeferredSurface></RightPanel>}
    </div>

    <McpElicitationModal key={elicitations[0]?.request?.id||"none"} request={elicitations[0]?.request} onResolve={resolveElicitation} onVerify={verifyMcpUser} verificationAvailable={!workspaceEnvironmentId}/>
    {!elicitations.length&&<QuestionModal request={question?.request} onSubmit={answerQuestion} onCancel={cancelQuestion} pickFiles={pickFiles}/>}
    <SnoozeDialog request={snoozeRequest} onSubmit={submitSnooze} onCancel={()=>setSnoozeRequest(null)}/>
    {actionError&&<div className={"app-action-error-toast"+(threadUndo?" with-thread-undo":"")} role="alert" aria-live="assertive" data-testid="app-action-error">{actionError}</div>}
    {threadUndo&&<div className="thread-undo-toast" role="status" aria-live="polite" data-testid="thread-undo-toast"><span>{threadUndo.label}</span><button onClick={undoThreadAction}>Undo</button><em>5s</em></div>}
    <CommandPalette open={paletteOpen} onClose={()=>setPaletteOpen(false)} actions={paletteActions} projects={paletteProjects} threads={threads} environmentNames={paletteEnvironmentNames} onOpenProject={project=>onProjectOpen(project.path,project.environmentId||null)} onOpenThread={openThread} onSearchThreadMessages={searchThreadMessages}/>
    <OnboardingModal open={initialLoaded&&settings.onboardingComplete===false} projectPath={projectPath} onPickWorkspace={window.trebellDesktop?.pickDirectory?pickWorkspace:null} providerLabel={agentRuntime==="codex"?providerLabel:agentRuntimeLabel} providerReady={providerReady} permissionMode={permissionMode} onPermissionMode={setPermissionMode} onHistoryImported={historyImported} onFinish={finishOnboarding}/>
  </div>;
}
