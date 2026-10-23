import React,{forwardRef,lazy,memo,Suspense,useCallback,useEffect,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState} from "react";
import { flushSync } from "react-dom";
import {
  Check, ChevronDown, CircleStop, Code2, Cpu, FileCode2, FolderCode,
  GitBranch, Globe2, HardDrive, Link2, MemoryStick, Network, Paperclip, Plus, Send,
  ShieldCheck, Sparkles, SquareTerminal, WandSparkles, X, Mic, Camera, History,
  PanelRight, PanelBottom, PanelLeftOpen, Command, Target, Play, Search, Sun, Moon,
  BarChart3, ChevronLeft, ChevronRight, Folder, LoaderCircle, Minus, ScrollText, Server, Settings as SettingsIcon, Wrench
} from "lucide-react";
import { compactDateTime, fullDateTime, isoDateTime } from "./time-format.js";
import { CodexRpcClient } from "./rpc.js";
import { api, wsUrl } from "./api.js";
import ThreadSidebar,{ ignorePressRest } from "./components/ThreadSidebar.jsx";
import AssistantSelectionToolbar from "./components/AssistantSelectionToolbar.jsx";
import ChatMarkdown,{ StreamingMarkdown } from "./components/LazyChatMarkdown.jsx";
import RightPanel from "./components/RightPanel.jsx";
import { useBrowserRecording } from "./browser-recording.js";
import { contextCompactionSignal } from "./provider-session-status.js";
import OpenInControl, { useOpenInEditors } from "./components/OpenInControl.jsx";
import HeaderOverflowMenu from "./components/HeaderOverflowMenu.jsx";
import { normalizeKeybindingRules, projectKeybindingRules, resolveKeybinding, ruleRuns, shadowedKeybindings, shortcutHint } from "./keybindings.js";
import { NAVIGATION_STORE_KEY, browserEntryIndex, browserState, createNavigationHistory, movedDuringStep, navigationKey, recordLocation, settleLocation, startNavigationHistory, stepTarget, storedNavigation } from "./navigation-history.js";
import { isVideoAttachment, restoreQueuedDraft } from "./composer-state.js";
import { applyFileMention, fileMentionAt, rankFileMentions } from "./composer-mentions.js";
import { mergeNativeQueue, nativeQueueUnavailable, queuedSubmissionDraft, queuedSubmissionNeedsToolExpansion, reorderQueue, shouldUseRuntimeNativeQueue } from "./native-queue.js";
import { countUnloadedTurns, detachHistoryTurn, historyFromItemEntries, historyFromTurns, historyGapBeforeId, historyGapLabel, historyGapPage, mergeHistoryGapMessages, mergeHistoryMessages, resumedActiveTurnId, sessionHandoffMessage, withSessionHandoff } from "./thread-history.js";
import { appendTurnOrder, assistantRowDecorations, cardFailedTurnIds, mergeTurnOutcomes, permissionModeLabel, prependTurnOrder, recordTurnCompletion, turnFailureText, turnIdsOldestFirst, turnInfoKey, turnOutcomeStatus, turnStartedAgain, turnTrailers } from "./turn-outcome.js";
import { activityRow, isCardItem, mergeLiveRow, restoredRow, retryActivityRow, retryRowId, settledRetryRows, settledRow } from "./activity-item.js";
import { cardRowsFromItemEntries, cardRowsFromTurns, emptyTurnActivity, itemPageBoundaryTurnId, itemPageCompleteness, mergeTurnActivity, newestCardTurnId, storeCardTurnIds, storeCompactionTurnIds, storeIncompleteTurnIds } from "./turn-activity.js";
import { normalizeCustomTheme, themeCssVariables } from "./theme-utils.js";
import { answeringClick, approvalResponse } from "./approval-utils.js";
import { approvalForeignThreadId, approvalToShow, liveRequests, ownedRequest, requestResolvedBy } from "./approval-scope.js";
import { isListedThread, prependThread } from "./thread-list-state.js";
import { fanoutWorkspaceError, nextModelSelection, threadForWorktree } from "./fanout-utils.js";
import { matchingMessageExcerpt, matchingPullRequestExcerpt, sidebarSearchMatches } from "./thread-message-search.js";
import { parseVisualizationMessage, visualizationUrl } from "./visualization-utils.js";
import { THREAD_SCROLL_END_THRESHOLD, captureConversationPosition, captureHistoryPrependAnchor, captureThreadScrollPosition, conversationWelcome, historyAnchorDisturbed, historyAnchorShortfall, historyHoldAfterScroll, rememberThreadScrollPosition, restoreHistoryPrependAnchor, restoredThreadScrollTop } from "./thread-scroll.js";
import { runningThreadIds, settleTurnStates } from "./thread-sidebar-groups.js";
import { createThreadTurnNotes } from "./thread-turn-notes.js";
import { latestTurnRowsStart } from "./conversation-order.js";
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, clampLayoutValue, normalizeLayoutPreferences } from "./layout-preferences.js";
import { nativeThreadSearchMatches, rankSearchHits, rankThreadSections, threadListParams } from "./thread-list-query.js";
import { resizeTextarea } from "./textarea-size.js";
import { guardianActionSummary } from "./guardian-review.js";
import { completedItemStatus } from "./tool-event-status.js";
import { startupRuntimeOutcome } from "./startup-runtime.js";
import { collaborationModePayload, normalizeCollaborationModes } from "./collaboration-mode.js";
import { ensureRuntimeProject, sameWorkspacePath } from "./codex-projects.js";
import { writeClipboardText } from "./clipboard.js";
import { openWebLink } from "./web-link.js";
import { requestPreview } from "./preview-open.js";
import { createKeyedTextFrameBuffer, createTextFrameBuffer } from "./text-frame-buffer.js";
import { EMPTY_ASSISTANT_STREAM, assistantStreamDelta } from "./assistant-stream-sync.js";
import { createLatestValueBuffer } from "./latest-value-buffer.js";
import { autoCompactionDecision } from "./auto-compaction.js";
import { hasAutoSettleCandidates } from "./auto-settle.js";
import { sameConversationMessageRowProps } from "./conversation-row.js";
import { sectionFirstThread, threadMoveAvailability, threadsInListOrder } from "./thread-order.js";
import { nextSnoozeWakeAt } from "./thread-snooze.js";
import { startFocusPoll } from "./focus-poll.js";
import { userVerificationAvailability } from "./user-verification.js";
import { sharedRuntimeCapabilities } from "../../src/runtime-capabilities.mjs";
import { repositoryFocusPaths } from "./context-focus.js";
import { desktopBridgeToolAvailability } from "./desktop-tool-availability.js";
import { hydratePersistedQueue, persistedQueueItems } from "./persistent-queue.js";
import { catalogMetaPatch, mergeThreadCatalog, missingRuntimeThreadError, openThreadTitleSource, sameCatalogSnapshot, threadCatalogRuntime, threadOwnerElsewhere, threadsFromCatalogMeta, threadTitle, threadKeptBySwitch } from "./thread-catalog.js";
import { conversationChunkIndexForMessage, conversationVirtualChunks, shouldVirtualizeConversation } from "./conversation-virtualization.js";
import { finishedActivitySteps } from "./activity-details.js";
import { observeHeaderFit } from "./header-fit.js";
import { askTerminalKeyboard,terminalDrawerOpened,terminalKeyboardAsked,terminalPresses } from "./terminal-keyboard.js";
import { sidebarAutoCollapses } from "./sidebar-layout.js";
import { startVisibilityPoll } from "./visibility-poll.js";
import { DEFAULT_MODEL_PROVIDER, MISSING_PROVIDER_KEY, modelProviderLabel } from "./provider-labels.js";
import { specializedToolNamespaceNames, specializedToolSelection } from "./lazy-tool-exposure.js";
import { configuredReasoningEffort, modelReasoningEffortKey, supportedReasoningEfforts } from "../../src/model-reasoning-effort.mjs";
import { CODEX_STANDARD_SERVICE_TIER, configuredModelServiceTier, modelServiceTierKey, modelServiceTierLabel, supportedModelServiceTiers } from "../../src/model-service-tier.mjs";
import { configuredModelOptions, modelOptionSettingsWith, supportedModelOptions } from "../../src/model-options.mjs";
import { codexReasoningEffortLabel } from "../../src/codex-model-catalog.mjs";
import { codexErrorNotice, codexGoalsMissing, codexModelChoices, codexThreadSettings, codexTurnFailure, codexTurnInput, describeCodexGoal } from "./codex-turn-options.js";
import { harnessInventory, harnessThreadOptions, harnessTurnOptions, relayThreadPreferredModel, serviceTierPickerTitle } from "./harness-turn-options.js";
import ReasoningRow from "./components/ReasoningRow.jsx";
import TurnActivityCard from "./components/TurnActivityCard.jsx";
import { reasoningHistoryMessage } from "./reasoning-text.js";

const TerminalPanel=lazy(()=>import("./components/TerminalPanel.jsx"));
const WorkspacePanel=lazy(()=>import("./components/WorkspacePanel.jsx"));
const SourceControlPanel=lazy(()=>import("./components/SourceControlPanel.jsx"));
const ProjectsPage=lazy(()=>import("./components/ProjectsPage.jsx"));
const AgentsPage=lazy(()=>import("./components/AgentsPage.jsx"));
const PreviewPage=lazy(()=>import("./components/PreviewPage.jsx"));
const SettingsPage=lazy(()=>import("./components/SettingsPage.jsx"));
const HarnessToolsPage=lazy(()=>import("./components/HarnessToolsPage.jsx"));
const EnvironmentsPage=lazy(()=>import("./components/EnvironmentsPage.jsx"));
const GoalPanel=lazy(()=>import("./components/GoalPanel.jsx"));
// Shown only while a new worktree is set up, so it loads with its first setup instead of with the app (B11).
const WorktreeSetupCard=lazy(()=>import("./components/WorktreeSetupCard.jsx"));
const UsagePage=lazy(()=>import("./components/UsagePage.jsx"));
const LicensesPage=lazy(()=>import("./components/LicensesPage.jsx"));
const ContextInspector=lazy(()=>import("./components/ContextInspector.jsx"));
const RuntimeTrace=lazy(()=>import("./components/RuntimeTrace.jsx"));
// Shown only on the right panel's Runtime tab, so it loads when that tab first shows instead of with the app (B11).
const AgentBackgroundTerminals=lazy(()=>import("./components/AgentBackgroundTerminals.jsx"));
// Shown only once auto review has denied an action, so it loads with the first denial instead of with the app (B11). The approval
// card stays in App (ApprovalCard below): a harness waits on it, so it shows the moment the request comes, and no chunk that is
// slow or fails to load stands between the person and their answer.
const GuardianDenialCard=lazy(()=>import("./components/GuardianDenialCard.jsx"));
const QuestionModal=lazy(()=>import("./components/QuestionModal.jsx"));
const McpElicitationModal=lazy(()=>import("./components/McpElicitationModal.jsx"));
const SnoozeDialog=lazy(()=>import("./components/SnoozeDialog.jsx"));
const CommandPalette=lazy(()=>import("./components/CommandPalette.jsx"));
const OnboardingModal=lazy(()=>import("./components/OnboardingModal.jsx"));
// Trebell's own tool catalog (the dynamic tools a new thread gets, and how a tool's results are put) is not needed for the first
// paint, so it loads at idle after it instead of with the app (B11). An action that needs it before then waits for that load. A load
// that fails rejects, so the action fails and says so rather than waiting; the browser keeps a module that failed, so a reload brings
// it back.
let sharedToolCatalogLoad=null;
const loadSharedToolCatalog=()=>sharedToolCatalogLoad||=import("../../src/shared-tool-catalog.mjs").catch(error=>{
  sharedToolCatalogLoad=null;throw Object.assign(new Error("Part of Trebell could not load. Reload Trebell to get it back."),{cause:error});
});
// The app's question dialogs (ask-dialog.js) load the same way: nothing on the first screen asks anything. Every question is awaited
// already, so one asked before the load waits for it, and once loaded the dialog opens before the next click or key is handled.
let askDialogLoad=null;
const loadAskDialog=()=>askDialogLoad||=import("./ask-dialog.js").catch(error=>{
  askDialogLoad=null;throw Object.assign(new Error("Part of Trebell could not load. Reload Trebell to get it back."),{cause:error});
});
const askConfirm=(...args)=>loadAskDialog().then(dialog=>dialog.askConfirm(...args));
const askText=(...args)=>loadAskDialog().then(dialog=>dialog.askText(...args));
// What App does around an agent's turn beyond showing it (turn-support.js: a send's repository context and new worktree, a send that
// is a slash command or a project's recipe, the agent's calls to Trebell's own tools, a completed turn's verification, the turns a
// restart interrupted) and what a person does to threads (thread-actions.js: pin, snooze, settle, archive, fork, delete, Undo, a move
// up or down) load the same way: neither the first screen nor opening and reading a thread needs them. Each is kept once loaded
// (turnSupport, threadActions), so what needs it runs at once, as before; what comes before the load waits for it, and what cannot
// load it fails and says so.
let turnSupport=null,turnSupportLoad=null,threadActions=null,threadActionsLoad=null;
const loadTurnSupport=()=>turnSupportLoad||=import("./turn-support.js").then(module=>turnSupport=module,error=>{
  turnSupportLoad=null;throw Object.assign(new Error("Part of Trebell could not load. Reload Trebell to get it back."),{cause:error});
});
const loadThreadActions=()=>threadActionsLoad||=import("./thread-actions.js").then(module=>threadActions=module,error=>{
  threadActionsLoad=null;throw Object.assign(new Error("Part of Trebell could not load. Reload Trebell to get it back."),{cause:error});
});
// A send's context packet comes only from turn-support.js (prepareTurnContext), so a send with one has that module; one without
// carries no repository context.
function repositoryContextEntries(packet,options){return packet?turnSupport.repositoryContextEntries(packet,options):{}}
if(typeof window!=="undefined")requestAnimationFrame(()=>setTimeout(()=>(window.requestIdleCallback||(callback=>setTimeout(callback,200)))(()=>{loadSharedToolCatalog().catch(()=>{});loadAskDialog().catch(()=>{});loadTurnSupport().catch(()=>{});loadThreadActions().catch(()=>{})},{timeout:2000})));

// The command palette as it first appears while its code loads (on the first open only): its search box takes focus and the keys
// typed straight after Ctrl+K, which would otherwise go into the composer it was opened from. seed hands the palette what was typed,
// the arrow keys and Enter pressed (keys, which the palette applies to its results once they show) and where focus came from; closed
// before the palette came, the stand-in gives focus back there itself. After Enter the search stays as Enter ran it, as the palette's
// own search waits while its command runs.
function CommandPaletteLoading({seed,onClose}){
  const inputRef=useRef(null);
  useLayoutEffect(()=>{
    // A second run in React's development checks finds focus already in this box: the control it came from is the first run's.
    const active=document.activeElement,opener=active?.closest?.('[data-testid="command-palette"]')?seed.current?.opener||null:active;
    const handoff={opener,query:"",keys:[],adopted:false};seed.current=handoff;
    inputRef.current?.focus({preventScroll:true});
    return()=>queueMicrotask(()=>{
      if(handoff.adopted||seed.current!==handoff)return;
      seed.current=null;const focused=document.activeElement,opener=handoff.opener;
      if((!focused||focused===document.body)&&opener instanceof HTMLElement&&opener.isConnected&&opener.getClientRects().length)opener.focus({preventScroll:true});
    });
  },[seed]);
  useEffect(()=>{
    const closeOnEscape=event=>{if(event.key!=="Escape")return;event.preventDefault();event.stopPropagation();onClose?.()};
    window.addEventListener("keydown",closeOnEscape,true);
    return()=>window.removeEventListener("keydown",closeOnEscape,true);
  },[onClose]);
  return <div className="command-palette-backdrop" data-testid="command-palette" onMouseDown={event=>event.target===event.currentTarget&&onClose?.()}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" aria-busy="true">
      <div className="command-palette-search"><Search size={16}/><input ref={inputRef} defaultValue="" onChange={event=>{if(seed.current)seed.current.query=event.target.value}} onKeyDown={event=>{
        if(event.key==="Tab"){event.preventDefault();return}
        const keys=seed.current?.keys;
        if(!keys||keys.includes("Enter")||!["ArrowDown","ArrowUp","Enter"].includes(event.key))return;
        event.preventDefault();keys.push(event.key);
        if(event.key==="Enter")event.currentTarget.readOnly=true;
      }} placeholder="Search commands, threads, and messages…" spellCheck={false} autoComplete="off"/><kbd className="tb-kbd">Esc</kbd></div>
      <div className="command-palette-results"><div className="command-palette-empty" role="status">Loading commands…</div></div>
      <div className="command-palette-footer" aria-hidden="true"><span><kbd className="tb-kbd">↑</kbd><kbd className="tb-kbd">↓</kbd> navigate</span><span><kbd className="tb-kbd">↵</kbd> run</span><span><kbd className="tb-kbd">esc</kbd> close</span><span className="command-palette-hint"><kbd className="tb-kbd">&gt;</kbd> commands only</span></div>
    </div>
  </div>;
}

// Focus for a person whose control went away with the view a palette command left (the composer, when the command opens a page):
// the heading of the page now shown, once that page has loaded, so Tab carries on from the top of that page instead of from the start
// of the document. The chat has no heading; there it is the composer. Anything focused meanwhile keeps focus.
function focusShownView(){
  const started=performance.now();
  const attempt=()=>{
    const active=document.activeElement;if(active&&active!==document.body)return;
    const frame=document.querySelector(".main-frame"),page=frame?.querySelector(".secondary-page");
    const target=page?page.querySelector("h1,h2"):frame?.querySelector('[data-testid="composer"]');
    if(target){if(!target.matches("input,textarea,select,button,a[href],[tabindex]"))target.setAttribute("tabindex","-1");target.focus({preventScroll:true});return}
    if(performance.now()-started<4000)requestAnimationFrame(attempt);
  };
  attempt();
}

// Focus for a person who opened the terminal from the palette, which would otherwise give it back to where the palette was opened
// from, or with Focus terminal (Ctrl+`): the open terminal's command line, else Create terminal (or New, beside a stopped one), once
// the drawer's content shows (its sessions listed: TerminalPanel reads as loading until then) and the palette has gone. Focus
// already in the drawer (the terminal panel's own, as a running terminal comes up) stays, and so does focus a press outside the
// drawer put elsewhere meanwhile (terminal-keyboard.js). The ring shows where the keyboard went (data-ring, until it leaves): the
// browser draws none for focus a script moves after a mouse click and a shortcut with Ctrl.
function focusTerminalDrawer(){
  const started=performance.now();askTerminalKeyboard();
  const attempt=()=>{
    const drawer=document.querySelector('[data-testid="command-palette"]')?null:document.querySelector(".terminal-drawer");
    const target=drawer&&(drawer.querySelector(".terminal-pane.active .terminal-command-line input:not(:disabled)")||drawer.querySelector(".terminal-empty button")||drawer.querySelector(".terminal-new"));
    if(target){if(!drawer.contains(document.activeElement)&&terminalKeyboardAsked()){target.dataset.ring="";target.onblur=()=>delete target.dataset.ring;target.focus({preventScroll:true})}return}
    if(performance.now()-started<4000)requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

// Focus for a person who asked for a new task (Ctrl+N, New thread or New task in the sidebar, the palette, History, a General chat
// from Projects): its composer, once it takes typing and the palette has gone, so what they type next lands there instead of on the
// button they clicked, or nowhere. Focus they put somewhere else meanwhile stays.
function focusNewTask(){
  const started=performance.now();let from;
  const attempt=()=>{
    if(!document.querySelector('[data-testid="command-palette"]')){
      const focused=document.activeElement,composer=document.querySelector('[data-testid="composer"]');
      if(from===undefined)from=focused;else if(focused!==from&&focused!==document.body)return;
      if(composer&&!composer.disabled){composer.focus({preventScroll:true});if(document.activeElement===composer)return}
    }
    if(performance.now()-started<4000)requestAnimationFrame(attempt);
  };
  attempt();
}

// In a browser tab the app's pages are entries of the tab's history too (see the navigation history in App). The desktop window
// (window.trebellDesktop) has no browser Back or Forward and keeps that history in memory only.
const BROWSER_NAVIGATION=typeof window!=="undefined"&&!window.trebellDesktop&&typeof window.history?.pushState==="function";
// The tab history entry this page load opened on: another one when the app starts means Back or Forward was pressed meanwhile.
const LOADED_BROWSER_ENTRY_ID=BROWSER_NAVIGATION?window.history.state?.trebellNav?.id||null:null;

// A part loaded with lazy() whose code could not load (the UI was rebuilt or updated under an open page, or the link to a remote
// Trebell server dropped), or that failed as it drew, says so in its place: without a boundary React takes the whole app off the
// screen with it. The browser keeps a module that failed to load as failed, so a reload is what loads it again.
class LazySlot extends React.Component{
  state={error:null};
  static getDerivedStateFromError(error){return {error}}
  render(){
    const {error}=this.state;
    return error?<div className="lazy-slot-error" role="alert"><span>This part of Trebell could not be shown: {error.message||String(error)}</span><button type="button" className="tb-btn tb-btn--sm" onClick={()=>window.location.reload()}>Reload</button></div>:<Suspense fallback={this.props.fallback??null}>{this.props.children}</Suspense>;
  }
}
function DeferredSurface({children,label="Loading…",compact=false}){
  return <LazySlot fallback={<div className={"surface-loading"+(compact?" compact":"")} role="status">{label}</div>}>{children}</LazySlot>;
}

function capabilityStatus(value){
  if(value==="runtime")return "runtime";
  return value?"available":"not exposed";
}

function sameSnapshot(left,right){
  if(left===right)return true;
  try{return JSON.stringify(left)===JSON.stringify(right)}catch{return false}
}

function useLatestCallback(callback){
  const ref=useRef(callback);
  useLayoutEffect(()=>{ref.current=callback});
  return useCallback((...args)=>ref.current?.(...args),[]);
}

// The appearance this browser last applied. index.html reads the same key before the stylesheets load, so a light-mode user's
// first frame is light, and the first render starts from it instead of the dark default until /api/state answers.
const APPEARANCE_CACHE_KEY="trebell-appearance-v1";
function cachedAppearanceSettings(){
  try{
    const cached=JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY)||"null");
    if(!cached||typeof cached!=="object")return {};
    return {
      ...(["system","light","dark"].includes(cached.mode)?{appearanceMode:cached.mode}:{}),
      ...(["dark","midnight","black"].includes(cached.theme)?{appearance:cached.theme}:{}),
    };
  }catch{return {}}
}

// The harness transport state in the words the Runtime panel uses, with the status-dot tone that matches it.
function transportStatusCopy(status){
  if(status==="connected")return {label:"Connected",tone:"ok"};
  if(status==="connecting"||status==="reconnecting")return {label:"Connecting…",tone:"warn"};
  if(status==="error")return {label:"Connection failed",tone:"err"};
  return {label:"Not connected",tone:"off"};
}

// Full-page sections share the workspace topbar: its crumb names the page (Settings adds its open section), and its actions keep
// the sidebar, inspector, theme and palette reachable on every page.
const PAGE_CRUMBS=Object.freeze({
  projects:[Folder,"Projects"],history:[History,"History"],usage:[BarChart3,"Usage"],tools:[Wrench,"Tools"],
  environments:[Server,"Environments"],settings:[SettingsIcon,"Settings"],licenses:[ScrollText,"Open source licenses"],
});

const AGENT_RUNTIME_LABELS=Object.freeze({native:"Trebell Native",codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"});
// The short harness names the sidebar chips use.
const HISTORY_RUNTIME_LABELS=Object.freeze({native:"Native",codex:"Codex",claude:"Claude",cursor:"Cursor",grok:"Grok",opencode:"OpenCode",antigravity:"Antigravity"});
function agentRuntimeName(kind){return AGENT_RUNTIME_LABELS[kind]||String(kind||"")||"the agent harness"}
// A model catalog belongs to its harness, and to the inference provider only when Trebell manages inference for that harness.
function modelCatalogScope(runtime,provider){return String(runtime||"")+"\0"+(sharedRuntimeCapabilities(runtime).managedInference?String(provider||""):"")}

const MAX_COMPOSER_ATTACHMENTS=100;
// The GUI server keeps an attachment up to 50 MB and an image up to 10 MB. A larger file is refused from its size, which the browser
// knows before reading it, instead of being read and sent to be refused (one over about 54 MB was cut off mid-upload as "Failed to fetch").
function attachmentSizeError(file){
  const image=String(file?.type||"").toLowerCase().startsWith("image/"),megabytes=image?10:50;
  return Number(file?.size)>megabytes*1024*1024?new Error(`${image?"Image":"Attachment"} is larger than ${megabytes} MB`):null;
}
const MAX_COMPOSER_CHARS=120_000;
// A draft this long is a long one: the composer says so in its class (long-draft), and App in the workspace shell's (with-long-draft),
// for the error toast's place beside it where the browser cannot anchor the toast to the composer (styles.css).
const LONG_DRAFT_CHARS=32768;
const HISTORY_ITEM_PAGE_LIMIT=100;
const HISTORY_ITEM_SCAN_PAGES=4;
const HISTORY_TURN_PAGE_LIMIT=40;
// Turns per page of outcomes (turns without items) for an item-paged history: more than one item page can show.
const HISTORY_TURN_OUTCOME_LIMIT=200;
// How long a thread may take to open before its opening state covers the conversation. A quicker open (a warm harness answers in
// well under it) goes straight from the view before the click to the thread, so nothing flashes in between.
const OPENING_COVER_DELAY_MS=200;

function visibleHistoryEntry(entry){
  const item=entry?.item;
  return item?.type==="userMessage"||item?.type==="agentMessage";
}

async function loadItemHistoryPage(rpc,threadId,cursor){
  let nextCursor=cursor||null,backwardsCursor=null;const data=[];
  for(let pageIndex=0;nextCursor&&pageIndex<HISTORY_ITEM_SCAN_PAGES;pageIndex++){
    const page=await rpc.request("thread/items/list",{threadId,cursor:nextCursor,limit:HISTORY_ITEM_PAGE_LIMIT,sortDirection:"desc"});
    if(pageIndex===0)backwardsCursor=page?.backwardsCursor||null;
    data.push(...(page?.data||[]));nextCursor=page?.nextCursor||null;
    if(data.some(visibleHistoryEntry)||!nextCursor)break;
  }
  return {data,nextCursor,backwardsCursor};
}

// Item pages say nothing of how a turn ended, so an item-paged history reads it from turn pages without items, newest first:
// a page of them beside the first item page, and more as older item pages need them (turnOutcomesForItemPage). A harness
// that cannot list them leaves those turns without an outcome, as before.
async function loadTurnOutcomePage(rpc,threadId,cursor){
  if(!cursor)return {data:[],nextCursor:null};
  try{const page=await rpc.request("thread/turns/list",{threadId,cursor,limit:HISTORY_TURN_OUTCOME_LIMIT,sortDirection:"desc",itemsView:"notLoaded"});return {data:page?.data||[],nextCursor:page?.nextCursor||null}}
  catch{return {data:[],nextCursor:null}}
}
// The turns of an older item page that the turn pages read so far do not cover, read on from where they stopped (meta holds
// that cursor and the turn ids read, for one thread).
async function turnOutcomesForItemPage(rpc,threadId,meta,entries=[]){
  if(!meta||meta.threadId!==threadId)return [];
  const wanted=[...new Set((entries||[]).map(entry=>String(entry?.turnId||"")).filter(Boolean))],turns=[];
  for(let pageIndex=0;meta.cursor&&pageIndex<HISTORY_ITEM_SCAN_PAGES&&wanted.some(id=>!meta.covered.has(id));pageIndex++){
    const page=await loadTurnOutcomePage(rpc,threadId,meta.cursor);
    for(const turn of page.data)if(turn?.id){meta.covered.add(String(turn.id));turns.push(turn)}
    meta.cursor=page.nextCursor;
  }
  return turns;
}

// onAnswer runs once, as soon as the harness answers a resume, before any page of history is read.
async function resumeWithBoundedHistory(rpc,params,onAnswer=()=>{}){
  let answered=false;
  try{
    const resumed=await rpc.request("thread/resume",{...params,excludeTurns:true});answered=true;onAnswer();
    const itemCursor=resumed?.itemsBackwardsCursor||null;
    if(itemCursor){
      try{
        const [items,outcomes]=await Promise.all([loadItemHistoryPage(rpc,params.threadId,itemCursor),loadTurnOutcomePage(rpc,params.threadId,resumed?.turnsBackwardsCursor||null)]);
        return {...resumed,__trebellHistoryPage:{kind:"items",...items,turns:outcomes.data,turnsCursor:outcomes.nextCursor}};
      }catch{}
    }
    const turnCursor=resumed?.turnsBackwardsCursor||null;
    if(turnCursor){
      try{
        const page=await rpc.request("thread/turns/list",{threadId:params.threadId,cursor:turnCursor,limit:HISTORY_TURN_PAGE_LIMIT,sortDirection:"desc",itemsView:"full"});
        return {...resumed,__trebellHistoryPage:{kind:"turns",...(page||{})}};
      }catch{}
    }
    if(resumed?.thread?.historyMode==="paginated")return {...resumed,__trebellHistoryPage:{kind:"items",data:[],nextCursor:null,backwardsCursor:null}};
  }catch{}
  return rpc.request("thread/resume",{...params,excludeTurns:false}).then(result=>{if(!answered)onAnswer();return {...result,__trebellFullHistoryFallback:true}});
}

function titleOf(thread){return threadTitle(thread)}
// A message as a sentence: trimmed, with a full stop unless it already ends in one (or in ! ? …).
function sentenceText(value){const text=String(value||"").trim();return !text||/[.!?…]$/.test(text)?text:text+"."}
function modelLabel(id){return String(id||"")}
function compactModelLabel(id){
  const full=modelLabel(id);
  return (full.includes("/")?full.split("/").filter(Boolean).pop():full)||"";
}
function attachmentDisplayName(path){
  const name=String(path||"").split(/[\\/]/).pop()||"attachment";
  return name.replace(/^\d{10,}-[0-9a-f]{8}-(?=.)/i,"");
}
// Replaces the activity row with the event's id, or adds the event.
// Failures the worktree setup card already shows (the activity list does not repeat them).
const WORKTREE_CARD_ERRORS=new WeakSet();
// A send Stop ended before its turn existed (startTurn marks the error trebellSendStopped): its draft goes back with no note.
const sendStoppedError=()=>Object.assign(new Error("Stopped before the turn started."),{trebellSendStopped:true});
function upsertEvent(events,event){return events.some(item=>item.id===event.id)?events.map(item=>item.id===event.id?{...item,...event}:item):[...events,event]}
// What became of a thread's own Codex app-server that died, as the server noted it (trebellAppServerExit).
function appServerExitText(exit){
  const how=exit?.signal?"was stopped by "+exit.signal:Number.isInteger(exit?.code)?"exited with code "+exit.code:"exited";
  return "The Codex app-server running this thread "+how+(exit?.turnRunning?", so the turn that was running ended":"")+". Trebell started it again.";
}
function historyFromThread(thread,checkpointByTurn={}){
  return historyFromTurns(thread?.turns||[],checkpointByTurn);
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
  if(!(Number(total)>0))return "Context —";
  if(windowSize&&contextTokens>0)return "Context "+Math.round(contextTokens/windowSize*100)+"% · "+contextTokens.toLocaleString()+" input · "+total.toLocaleString()+" total"+suffix;
  return "Tokens "+total.toLocaleString()+suffix;
}
// The context value without the "Context" label, for places that already print the label next to a meter or in a stat cell:
// "—" before the harness reports usage, "50% · 1,444/120,000" with a known window, else the thread's token total. A cost
// joins when the harness reports one (or a custom model's prices give one).
function contextValueLabel(tokenUsage,price=null){
  const label=tokenLabel(tokenUsage,price);
  const total=tokenUsage?.total?.totalTokens,contextTokens=tokenUsage?.last?.inputTokens,windowSize=Number(tokenUsage?.modelContextWindow);
  const cost=/ · (\$[\d.]+)$/.exec(label)?.[1]||"";
  // A turn always sends some context, so a zero total means the provider reported no usage, not an empty window.
  if(!(Number(total)>0))return "—";
  if(windowSize&&contextTokens>0)return Math.round(contextTokens/windowSize*100)+"% · "+contextTokens.toLocaleString()+"/"+windowSize.toLocaleString()+(cost?" · "+cost:"");
  return total.toLocaleString()+" tokens"+(cost?" · "+cost:"");
}
// The share of the model's context window the last request used, or null when the harness has not reported both numbers.
function contextUsagePercent(tokenUsage){
  const used=tokenUsage?.last?.inputTokens,windowSize=Number(tokenUsage?.modelContextWindow);
  if(!(Number(tokenUsage?.total?.totalTokens)>0)||!(Number(used)>0)||!(windowSize>0))return null;
  return Math.max(0,Math.min(100,Math.round(Number(used)/windowSize*100)));
}

// The live turn's block: its activity card (TurnActivityCard, open until the person closes it) and, below the card, the reply as
// it streams, which stays in view while the card is closed. onShown hears whether the block shows, before the frame that draws it
// or takes it away (App names it in the conversation column's class, with-agent-block).
const ActivityTimeline=memo(forwardRef(function ActivityTimeline({events,threadId=null,turnId=null,initialAssistantText="",initialCommandOutputs,initialMcpProgress,onOpenPanel,canInspectChanges=true,onToggleLayout=null,onShown=null},ref){
  const [assistantText,setAssistantText]=useState(initialAssistantText);
  const [commandOutputs,setCommandOutputs]=useState(()=>new Map(initialCommandOutputs||[]));
  const [mcpProgress,setMcpProgress]=useState(()=>new Map(initialMcpProgress||[]));
  const openPanelRef=useRef(onOpenPanel);openPanelRef.current=onOpenPanel;
  const openWorkspace=useCallback(()=>openPanelRef.current?.("workspace"),[]);
  useImperativeHandle(ref,()=>({
    setText:value=>setAssistantText(String(value||"")),
    appendCommandOutputs:entries=>setCommandOutputs(previous=>{
      const next=new Map(previous);
      for(const [key,value] of entries||[]){const id=String(key||""),text=String(value||"");if(id&&text)next.set(id,(next.get(id)||"")+text)}
      return next;
    }),
    setCommandOutput:(key,text)=>setCommandOutputs(previous=>{const id=String(key||"");if(!id)return previous;const next=new Map(previous);next.set(id,String(text||""));return next}),
    clearCommandOutput:key=>setCommandOutputs(previous=>{const id=String(key||"");if(!previous.has(id))return previous;const next=new Map(previous);next.delete(id);return next}),
    setMcpProgress:(key,progress)=>setMcpProgress(previous=>{const id=String(key||"");if(!id)return previous;const next=new Map(previous);next.set(id,progress);return next}),
    clearMcpProgress:key=>setMcpProgress(previous=>{const id=String(key||"");if(!previous.has(id))return previous;const next=new Map(previous);next.delete(id);return next}),
    resetStreams:()=>{setAssistantText("");setCommandOutputs(new Map());setMcpProgress(new Map())},
  }),[]);
  const shown=events.length>0||Boolean(assistantText);
  useLayoutEffect(()=>{onShown?.(shown)},[shown,onShown]);
  if(!shown)return null;
  // A reply that streams without any tool or reasoning step has no activity to list, so it shows only its text.
  return <div className="agent-block">{events.length>0&&<TurnActivityCard live threadId={threadId} turnId={turnId} rows={events} defaultOpen onToggleLayout={onToggleLayout} onInspectChanges={canInspectChanges?openWorkspace:null} commandOutputs={commandOutputs} mcpProgress={mcpProgress}/>}{assistantText&&<div className="assistant-answer chat-markdown"><StreamingMarkdown text={assistantText}/></div>}</div>;
}));

// covered: another thread's opening state is up. The bar belongs to the thread being left, so it hides without closing (a failed open
// brings it back with its query) and cannot be used meanwhile. Escape closes it from its field and from its buttons alike.
// Previous and Next match only say they are off (aria-disabled), at the first or the last match and while more matches load, so the
// keyboard stays on the one in use: a press there does nothing (stepThreadFind), Space never types into the field, and Escape from
// it closes the bar. One that is off is out of Tab's order, as a disabled button is, so Tab from the field reaches one that steps.
function ThreadFindBar({state,covered=false,inputRef,barRef,onQuery,onPrevious,onNext,onClose}){
  if(!state.open)return null;
  const previousOff=state.loading||state.index<=0,nextOff=state.loading||!state.results.length||(state.index>=state.results.length-1&&!state.nextCursor);
  const current=state.index>=0?state.results[state.index]:null;
  const range=current?.snippetMatchRange||{};const start=Math.max(0,Number(range.start)||0),end=Math.max(start,Number(range.end)||0);
  const snippet=String(current?.snippet||"");
  return <div className={"thread-find-bar"+(covered?" opening-covered":"")} data-testid="thread-find-bar" ref={barRef} inert={covered} onKeyDown={event=>{if(event.key==="Escape"&&!event.defaultPrevented){event.preventDefault();onClose()}}}>
    <Search size={13}/><input ref={inputRef} data-testid="thread-find-input" value={state.query} onChange={event=>onQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();event.shiftKey?onPrevious():onNext()}}} placeholder="Find in this thread"/>
    <span className="thread-find-count">{state.loading?"Searching…":state.error?"Error":state.results.length?`${state.index+1} / ${state.results.length}${state.nextCursor?"+":""}`:state.query.trim().length>=2?"No matches":""}</span>
    <button type="button" onClick={onPrevious} aria-disabled={previousOff} tabIndex={previousOff?-1:undefined} aria-label="Previous match">↑</button><button type="button" onClick={onNext} aria-disabled={nextOff} tabIndex={nextOff?-1:undefined} aria-label="Next match">↓</button><button type="button" onClick={onClose} aria-label="Close find">×</button>
    {(current||state.error)&&<div className="thread-find-snippet">{state.error?state.error:<>{snippet.slice(0,start)}<mark>{snippet.slice(start,end)}</mark>{snippet.slice(end)}</>}</div>}
  </div>;
}

function TurnOutcomePill({label,tone}){
  return <span className={"turn-outcome tone-"+(tone||"ok")} data-testid="turn-outcome">{tone==="err"?<X size={11} aria-hidden="true"/>:tone==="warn"?<CircleStop size={11} aria-hidden="true"/>:<Check size={11} aria-hidden="true"/>}{label}</span>;
}
// A turn whose harness had lost the conversation says, once, that it goes on in a new session, before the turn's steps and
// reply: a quiet note in the reply column, not a failure (thread-history.js sessionHandoffMessage).
function SessionHandoffRow({message}){
  return <div className="session-handoff-row" data-testid="session-handoff" data-message-id={message.id} data-turn-id={message.turnId==null?undefined:String(message.turnId)}><History size={13} aria-hidden="true"/><p>{message.text}</p></div>;
}
// A visualization's frame opens once its file is known to be there (a HEAD request): one that is missing, or cannot be shown, is said
// in the card by its file name, instead of the server's error inside the frame. One whose content then cannot be read (removed, or
// held open, in between) is told to the card by the server's answer in the frame (gui-server.mjs), and said in the card the same way.
// Until the frame's content has loaded the card says it is loading, and the frame waits unseen under that line at the size it shows at
// (a chart lays itself out as it loads).
function InlineVisualization({visualization,src}){
  const label=String(visualization.path||visualization.file||"Visualization").split(/[\\/]/).pop();
  const [found,setFound]=useState(null),[loaded,setLoaded]=useState(false),frame=useRef(null);
  useEffect(()=>{let live=true;setFound(null);setLoaded(false);fetch(src,{method:"HEAD"}).then(response=>{if(live)setFound(response.ok?"yes":response.status===404?"missing":"failed")},()=>{if(live)setFound("failed")});return()=>{live=false}},[src]);
  useEffect(()=>{const told=event=>{const said=event.data?.trebellVisualization;if(event.source&&event.source===frame.current?.contentWindow&&(said==="missing"||said==="failed"))setFound(said)};window.addEventListener("message",told);return()=>window.removeEventListener("message",told)},[]);
  return <div className={"inline-visualization-card "+(visualization.mode==="wide"?"wide":"")}><div className="inline-visualization-head"><strong>{label}</strong><span>Interactive visualization</span></div>{found==="yes"&&<iframe ref={frame} title={label} src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" className={loaded?undefined:"loading"} onLoad={()=>setLoaded(true)}/>}{found&&found!=="yes"?<p className="inline-visualization-missing" data-testid="visualization-missing">{found==="missing"?"Visualization not found: ":"Could not show visualization "}{label}</p>:!loaded&&<p className="inline-visualization-wait" role="status">Loading visualization {label}…</p>}</div>;
}
const ConversationMessageRow=memo(function ConversationMessageRow({message,activeFind,allowRevert,projectPath,environmentId,threadId,onEditFromHere,heading="",outcomeLabel="",outcomeTone=""}){
  const parsed=useMemo(()=>message.role==="user"||message.role==="handoff"?null:parseVisualizationMessage(message.text),[message.role,message.text]);
  if(message.role==="reasoning")return <ReasoningRow id={message.id} messageId={message.id} text={message.text}/>;
  if(message.role==="handoff")return <SessionHandoffRow message={message}/>;
  // A message sent with files names them under its text, as the composer's chips did.
  if(message.role==="user")return <div className={"user-row"+(activeFind?" find-active":"")} data-message-id={message.id}><div className="user-bubble"><p>{message.text}</p>{message.attachments?.length>0&&<div className="user-attachments">{message.attachments.map(path=><span key={path} title={attachmentDisplayName(path)}><Paperclip size={11}/><bdi>{attachmentDisplayName(path)}</bdi></span>)}</div>}{allowRevert&&message.turnId&&<button className="message-action" onClick={()=>onEditFromHere(message)}>Edit from here</button>}</div></div>;
  return <div className={"history-assistant"+(activeFind?" find-active":"")} data-message-id={message.id}><div className="agent-star small"><Sparkles size={12}/></div><div className="history-assistant-body">{heading&&<div className="assistant-heading" data-testid="assistant-heading">{heading}</div>}{parsed?.text&&<div className="assistant-message-text chat-markdown" data-assistant-citation-source={message.id}><ChatMarkdown text={parsed.text}/></div>}{(parsed?.visualizations||[]).map((visualization,index)=><InlineVisualization key={(visualization.path||visualization.file)+":"+index} visualization={visualization} src={visualizationUrl(visualization,{projectPath,environmentId,threadId})}/>)}{outcomeLabel&&<TurnOutcomePill label={outcomeLabel} tone={outcomeTone}/>}</div></div>;
},sameConversationMessageRowProps);
// How a turn that failed, was stopped or completed before any reply ended (turn-outcome.js turnTrailers), where its reply would
// have been: the heading and pill on one line, then the error it ended with in full ("Finished without a reply." for a completed
// one). No message id: it is not a message, so find, scroll anchors and citations pass it by.
const TurnOutcomeRow=memo(function TurnOutcomeRow({turnId,heading="",outcomeLabel,outcomeTone,message="",latest=false}){
  return <div className={"history-assistant turn-outcome-row"+(latest?" latest-turn-end":"")} data-testid="turn-outcome-row" data-turn-id={turnId}><div className="agent-star small"><Sparkles size={12}/></div><div className="history-assistant-body"><div className="turn-outcome-head">{heading&&<div className="assistant-heading" data-testid="assistant-heading">{heading}</div>}<TurnOutcomePill label={outcomeLabel} tone={outcomeTone}/></div>{message&&<p className={"turn-outcome-message tone-"+outcomeTone}>{message}</p>}</div></div>;
});

const ConversationVirtualChunk=memo(function ConversationVirtualChunk({chunk,rootRef,forceMount=false,initialMount=false,renderMessage}){
  const ref=useRef(null),[mounted,setMounted]=useState(Boolean(initialMount||forceMount)),[placeholderHeight,setPlaceholderHeight]=useState(Math.max(1,Number(chunk.estimatedHeight)||1));
  useEffect(()=>{if(forceMount)setMounted(true)},[forceMount]);
  useLayoutEffect(()=>{
    if(!mounted||!ref.current)return;
    const measure=()=>{const height=Math.ceil(ref.current?.getBoundingClientRect?.().height||0);if(height>0)setPlaceholderHeight(height)};
    measure();
    if(typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(measure);observer.observe(ref.current);return()=>observer.disconnect();
  },[mounted,chunk.key]);
  useEffect(()=>{
    const node=ref.current,root=rootRef?.current;if(!node||!root||typeof IntersectionObserver==="undefined"){setMounted(true);return}
    let timer=null;
    const observer=new IntersectionObserver(entries=>{
      const visible=entries.some(entry=>entry.isIntersecting);
      if(visible||forceMount){
        if(timer){clearTimeout(timer);timer=null}
        setMounted(true);return;
      }
      const height=Math.ceil(node.getBoundingClientRect().height||0);if(height>0)setPlaceholderHeight(height);
      timer=setTimeout(()=>setMounted(false),120);
    },{root,rootMargin:"1400px 0px 1400px 0px",threshold:0});
    observer.observe(node);
    return()=>{if(timer)clearTimeout(timer);observer.disconnect()};
  },[rootRef,forceMount,chunk.key]);
  return <div ref={ref} className={"conversation-virtual-chunk"+(mounted?" mounted":" placeholder")} data-virtual-chunk={chunk.key} style={mounted?undefined:{height:placeholderHeight}}>{mounted?chunk.messages.map(renderMessage):null}</div>;
});

// cardFailedTurns: the turns whose failure the live activity card lists, one id per line (a string, so the memo holds while
// the card's events change around them). turnOrder: the thread's turn ids, oldest first, where a turn without rows ends.
// turnActivity: the open thread's activity card of every turn (turn-activity.js); liveCardTurnId: the one the live card shows,
// which has no card here; newestTurnId: the turn whose card is open until the person closes it.
const Conversation=memo(function Conversation({messages,onEditFromHere,onCite,allowRevert=true,projectPath,environmentId,threadId,canLoadEarlier=false,loadingEarlier=false,onLoadEarlier,historyGap=null,loadingGap=false,onLoadGap,historyBusy=false,historyError=null,activeFindItemId=null,anchorItemId=null,scrollContainerRef=null,harnessLabel="",turnInfo=null,cardTurnId=null,cardFailedTurns="",turnOrder=null,turnActivity=null,liveCardTurnId=null,newestTurnId=null,onToggleLayout=null}){
  const historyRef=useRef(null);
  const virtualized=shouldVirtualizeConversation(messages);
  // The rows of the live card's turn read below the card (shell.css orders the rows after this marker). A turn that started
  // without a user message (a goal continuing) leaves the previous turn's reply above the card.
  const latestStart=useMemo(()=>virtualized?-1:latestTurnRowsStart(messages,cardTurnId),[messages,cardTurnId,virtualized]);
  // A turn's first reply names the harness (and the mode this window sent it with); its last reply says how it ended.
  const decorations=useMemo(()=>assistantRowDecorations(messages,{harnessLabel,turnInfo,threadId}),[messages,harnessLabel,turnInfo,threadId]);
  // Each earlier turn's activity card, and the row that ends a turn which failed, was stopped or completed before any reply,
  // unless the live card lists that failure (one with no rows at all ends after the turn before it, or opens the thread); a turn
  // whose steps are not all loaded never reads as finished without a reply, nor does a compaction, whose card says it compacted.
  // The turn lists are strings, so the placement is worked out again only when they change, not with every step a card adds.
  const cardFailedTurnSet=useMemo(()=>new Set(String(cardFailedTurns||"").split("\n").filter(Boolean)),[cardFailedTurns]);
  const gapBeforeId=historyGap?.beforeId??null,boundaryTurnId=turnActivity?.boundaryTurnId??null;
  const cardTurns=useMemo(()=>storeCardTurnIds(turnActivity).join("\n"),[turnActivity]),incompleteTurns=useMemo(()=>storeIncompleteTurnIds(turnActivity).join("\n"),[turnActivity]),compactionTurns=useMemo(()=>storeCompactionTurnIds(turnActivity).join("\n"),[turnActivity]);
  const trailers=useMemo(()=>turnTrailers(messages,{harnessLabel,turnInfo,threadId,cardFailedTurnIds:cardFailedTurnSet,cardTurnId,reorder:!virtualized,turnOrder,gapBeforeId,startLoaded:!canLoadEarlier,cardTurnIds:cardTurns?cardTurns.split("\n"):[],liveCardTurnId,boundaryTurnId,incompleteTurnIds:new Set(incompleteTurns?incompleteTurns.split("\n"):[]),compactionTurnIds:compactionTurns?compactionTurns.split("\n"):[]}),[messages,harnessLabel,turnInfo,threadId,cardFailedTurnSet,cardTurnId,virtualized,turnOrder,gapBeforeId,canLoadEarlier,cardTurns,liveCardTurnId,boundaryTurnId,incompleteTurns,compactionTurns]);
  // A virtualized list estimates each chunk with the closed cards its rows carry (36px and the 22px below each); a chunk on
  // screen measures itself. The chunks holding the active find match and an older page's anchor row mount at once, so both can
  // be scrolled to exactly.
  const cardsAt=useMemo(()=>{const counts=new Map();for(const map of [trailers.before,trailers.after])for(const [id,entries] of map){const cards=entries.filter(entry=>entry.kind==="card").length;if(cards)counts.set(id,(counts.get(id)||0)+cards)}return counts},[trailers]);
  const chunks=useMemo(()=>virtualized?conversationVirtualChunks(messages,{extraHeight:message=>58*(cardsAt.get(String(message.id))||0)}):[],[messages,virtualized,cardsAt]),forcedChunk=virtualized?conversationChunkIndexForMessage(chunks,activeFindItemId):-1,anchorChunk=virtualized?conversationChunkIndexForMessage(chunks,anchorItemId):-1;
  // The chunks a selection reaches stay mounted too, the one a click left the caret in among them, so a Shift+click far below or a
  // drag the view scrolls with holds the text of every turn it covers, where a placeholder would hold none.
  const [selectedKeys,setSelectedKeys]=useState("");
  useEffect(()=>{
    if(!virtualized)return;
    const update=()=>{const selection=getSelection();setSelectedKeys([...historyRef.current?.querySelectorAll("[data-virtual-chunk]")||[]].filter(node=>selection.containsNode(node,true)).map(node=>node.dataset.virtualChunk).join("\n"))};
    document.addEventListener("selectionchange",update);return()=>document.removeEventListener("selectionchange",update);
  },[virtualized]);
  const selectedChunks=selectedKeys.split("\n");
  // A turn's card and end row, in their turns' order. A card has no message id: find, scroll anchors and citations pass it by.
  const renderTrailers=useCallback(entries=>(entries||[]).map(entry=>{
    if(entry.kind==="end")return <TurnOutcomeRow key={"turn-end:"+entry.turnId} turnId={entry.turnId} heading={entry.heading} outcomeLabel={entry.outcomeLabel} outcomeTone={entry.outcomeTone} message={entry.message} latest={entry.latest}/>;
    const turn=turnActivity?.turns?.[entry.turnId];if(!turn?.rows?.length)return null;
    return <div className="turn-card" key={"turn-card:"+entry.turnId} data-turn-id={entry.turnId}><TurnActivityCard threadId={threadId} turnId={entry.turnId} rows={turn.rows} complete={turn.complete} defaultOpen={entry.turnId===String(newestTurnId??"")} onToggleLayout={onToggleLayout}/></div>;
  }),[turnActivity,threadId,newestTurnId,onToggleLayout]);
  // One fragment per message whatever goes with it, so no row remounts when a gap marker, a card or its turn's outcome row comes
  // or goes.
  const renderMessage=useCallback(message=>{const id=String(message.id),decoration=decorations.get(id);return <React.Fragment key={message.id}>
    {/* The turns not loaded between a detached find hit and the newest pages are marked where they belong, and load from there. */}
    {historyGap&&id===String(historyGap.beforeId)&&<div className="history-page-control history-gap" data-testid="history-gap"><button type="button" aria-disabled={historyBusy||undefined} onClick={onLoadGap}>{loadingGap?"Loading turns…":<>{historyGapLabel(historyGap.missing)}<span className="history-gap-load">· Load</span></>}</button>{historyError?.at==="gap"&&<p className="history-page-error" role="alert">{historyError.text}</p>}</div>}
    {renderTrailers(trailers.before.get(id))}
    <ConversationMessageRow
      message={message}
      activeFind={id===String(activeFindItemId||"")}
      allowRevert={allowRevert}
      projectPath={projectPath}
      environmentId={environmentId}
      threadId={threadId}
      onEditFromHere={onEditFromHere}
      heading={decoration?.heading||""}
      outcomeLabel={decoration?.outcomeLabel||""}
      outcomeTone={decoration?.outcomeTone||""}
    />
    {renderTrailers(trailers.after.get(id))}
  </React.Fragment>},[activeFindItemId,allowRevert,projectPath,environmentId,threadId,onEditFromHere,decorations,trailers,renderTrailers,historyGap,historyBusy,historyError,loadingGap,onLoadGap]);
  // A thread that opens with turns that have no rows (a goal's first turn failing at once) starts with their cards and outcome rows.
  // A page that did not load says so under the button pressed, which stays there to try again, with the keyboard still on it.
  return <div className="conversation-history" ref={historyRef}>{canLoadEarlier&&<div className="history-page-control"><button type="button" aria-disabled={historyBusy||undefined} onClick={onLoadEarlier}>{loadingEarlier?"Loading earlier messages…":"Load earlier messages"}</button>{historyError?.at==="top"&&<p className="history-page-error" role="alert">{historyError.text}</p>}</div>}{renderTrailers(trailers.after.get(""))}{virtualized
    ?chunks.map((chunk,index)=><ConversationVirtualChunk key={chunk.key} chunk={chunk} rootRef={scrollContainerRef} forceMount={index===forcedChunk||index===anchorChunk||selectedChunks.includes(chunk.key)} initialMount={index>=chunks.length-2} renderMessage={renderMessage}/>)
    :latestStart<0?messages.map(renderMessage):[...messages.slice(0,latestStart).map(renderMessage),<span key="latest-turn-start" className="latest-turn-start" hidden/>,...messages.slice(latestStart).map(renderMessage)]}<AssistantSelectionToolbar containerRef={historyRef} onCite={({messageId,text})=>{const message=messages.find(item=>String(item.id)===String(messageId));return message?onCite?.(message,text):false}}/></div>;
});
// threadLabel names the task that asked when it is not the open thread, so nobody approves a command without knowing whose it is.
// A card answers once, and only to a click aimed at it: the second click of a double click (its click count is 2, or it lands where
// the first did, answeringClick) was aimed at the card before, which the first click answered, and the next card has come up under
// the pointer. The rest of that press does nothing either (ignorePressRest), as on an app request's buttons: with no card after it,
// the second click lands on the conversation, which slides under the pointer, and would select a word there.
function ApprovalCard({request,onResolve,threadLabel=""}){
  const answered=useRef(false);
  if(!request)return null;
  const answer=(event,decision)=>{if(answered.current||event.detail>1||!answeringClick(event))return;answered.current=true;Promise.resolve(onResolve(request,decision)).then(result=>{if(!result)answered.current=false})};
  const p=request.params||{};
  const permissions=request.method==="item/permissions/requestApproval";
  const network=permissions?p.permissions?.network:null;const fileSystem=permissions?p.permissions?.fileSystem:null;
  const title=permissions?"Additional access requested":request.method.includes("fileChange")||request.method==="applyPatchApproval"?"File changes need approval":p.networkApprovalContext?.host?"Network access needs approval":"Command needs approval";
  // The command is shown even when the harness gives a reason, so nobody approves "Run the tests" without seeing what runs.
  const commandText=Array.isArray(p.command)?p.command.map(part=>String(part)).join(" "):typeof p.command==="string"?p.command:"";
  const networkTarget=p.networkApprovalContext?.host?`${p.networkApprovalContext.protocol||"network"}://${p.networkApprovalContext.host}`:"";
  const detail=permissions?[network&&"Network access",fileSystem&&"Filesystem access"].filter(Boolean).join(" + "):(networkTarget||p.reason||commandText||p.path||request.method);
  const showCommand=!permissions&&Boolean(commandText.trim())&&detail!==commandText;
  const approvalOptions=Array.isArray(p.approvalOptions)?p.approvalOptions.filter(option=>option&&typeof option.decision==="string"&&option.label):[];
  return <div className="approval-card"><div className="card-title"><ShieldCheck size={16}/><strong>{title}</strong></div>{threadLabel&&<p className="approval-thread" data-testid="approval-thread">Waiting in {threadLabel}</p>}<p>{detail||p.reason||request.method}</p>{showCommand&&<pre className="approval-command" data-testid="approval-command"><code>{commandText}</code></pre>}{permissions&&<pre className="approval-permissions">{JSON.stringify(p.permissions||{},null,2)}</pre>}{approvalOptions.filter(option=>option.warning).map(option=><small key={"warning-"+option.decision}>{option.label}: {option.warning}</small>)}<div className="approval-actions" onClick={event=>{if(event.target.closest("button"))ignorePressRest(!event.detail)}}>{approvalOptions.length
    // An ACP harness's own choices, in its order and wording (T3 grokApprovalOptions / antigravityApprovalOptions).
    ?approvalOptions.map(option=><button key={option.decision} className={option.decision==="accept"?"approve":undefined} onClick={event=>answer(event,option.decision)}>{option.label}</button>)
    :<><button onClick={event=>answer(event,"decline")}>Deny</button><button onClick={event=>answer(event,"acceptForSession")}>Allow session</button><button className="approve" onClick={event=>answer(event,"accept")}>Allow once</button></>}</div></div>;
}
// The undo toast's remaining seconds, counting down with the timer that removes it. Hidden from the live region so it is
// not announced every second. Each toast counts with one of its own (keyed by the toast): a toast that replaced another went on
// from that one's last count, so it read 6s for its first quarter second.
function UndoCountdown({expiresAt}){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),250);return()=>clearInterval(timer)},[expiresAt]);
  return <em aria-hidden="true">{Math.max(1,Math.ceil((Number(expiresAt)-now)/1000))}s</em>;
}
// The desktop window's own buttons, named for what they do. Maximize is Restore while the window is maximised, however it got there
// (this button, a double click on the title bar, Win+Up, a snap): the shell says each change (desktop/main.mjs).
function WindowControls({desktop}){
  const [maximized,setMaximized]=useState(false);
  useEffect(()=>{let live=true;desktop.maximized?.().then(value=>{if(live)setMaximized(Boolean(value))},()=>{});const off=desktop.onMaximized?.(value=>setMaximized(Boolean(value)));return()=>{live=false;off?.()}},[desktop]);
  const middle=maximized?"Restore":"Maximize";
  return <div className="window-controls window-controls-pinned"><button onClick={()=>desktop.minimize()} title="Minimize" aria-label="Minimize">—</button><button onClick={()=>desktop.maximize()} title={middle} aria-label={middle}>{maximized?"❐":"□"}</button><button className="window-close" onClick={()=>desktop.close()} title="Close" aria-label="Close">×</button></div>;
}

// Scrolls a menu just enough to show its keyboard-highlighted row (without scrolling anything around the menu).
function keepActiveOptionVisible(menu){
  const active=menu?.querySelector("button.active");if(!active)return;
  const top=active.offsetTop,bottom=top+active.offsetHeight;
  if(top<menu.scrollTop)menu.scrollTop=top;else if(bottom>menu.scrollTop+menu.clientHeight)menu.scrollTop=bottom-menu.clientHeight;
}
const SLASH_COMMANDS=[
  ["/compact","Compact conversation context"],
  ["/ps","Show agent background processes"],
  ["/stop","Stop agent background processes"],
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

// A press on a button of the composer's footer runs it once, as a queued follow-up's buttons do: each goes at its first press (Compact
// while the compaction runs, Retry while it connects, the provider's setup to Settings), and the rest of the press (the second click
// of a double click, Enter held) would land on what took its place, selecting the meter's reading.
function footerPressOnce(event){if(event.target.closest("button"))ignorePressRest(!event.detail)}
// A press on a chip's remove button (an attachment's or a context's) removes that chip once. The chip goes at once and the next one
// in its row moves into its place, so the rest of the press would remove that one too: a double click's second click, where the
// next chip's button comes up under the pointer (chips with names too long for them are all one width, and Browser screenshots all
// read the same), and the repeats of Enter held, which go to the next chip's button that removeChip gives the keyboard.
function chipPressOnce(event){if(event.target.closest("button"))ignorePressRest(!event.detail)}

// What a refused or missing microphone means for dictation, by the browser's speech recognition error.
const DICTATION_ERRORS={
  "not-allowed":"The microphone is blocked. Allow microphone access for Trebell Code to dictate.",
  "service-not-allowed":"The microphone is blocked. Allow microphone access for Trebell Code to dictate.",
  "audio-capture":"No microphone was found to dictate with.",
};
const Composer=memo(function Composer({prompt,setPrompt,onPromptEdit,alert=null,historyIndex=-1,onSend,onBackgroundSend,canBackground=false,running,submitting=false,openingThread=false,starting=false,providerReady,transportReady=true,transportStatus="",transportReason="",onRetryTransport,runtimeSwitchLabel="",modelsLoading=false,provider,agentRuntime="codex",agentRuntimeLabel="Codex",runtimeCapabilities={},onConfigureProvider,models,modelMeta,model,setModel,selectedModels=[],onSelectedModels,allowMultiModel=false,modelError,attachments,uploadingFiles=[],contextChips,onRemoveAttachment,onRemoveContext,onPickFiles,onCaptureScreen,onPaste,onDrop,onFileMentionSearch,onFileMentionAttach,permissionMode,setPermissionMode,collaborationModes=[],collaborationMode="default",onCollaborationMode,collaborationModeBusy=false,threadSettingsWait=false,providerCommands=[],providerAgents=[],providerAgent="",onProviderAgent,recipes=[],settings,tokenUsage,workspaceMode,setWorkspaceMode,projectless=false,threadOpen=false,gitAvailable=false,canCompact=false,onCompact,runtimeProfiles=null,runtimeProfileBusy="",onRuntimeProfile,onReasoningEffort,onServiceTier,onModelOption,onModelPickerOpenChange,onMenuShown=null,codexThread=null,onCancelEdit=null}){
  const [modelOpen,setModelOpen]=useState(false);
  const [modelQuery,setModelQuery]=useState("");
  const [listening,setListening]=useState(false);
  // dictationAlert: why dictation could not start (a refused microphone), shown where the composer's alerts show until the next try,
  // edit or send. recognitionRef: the recognition listening now, which a second click on the mic stops.
  const [dictationAlert,setDictationAlert]=useState(null);
  const recognitionRef=useRef(null);
  // A send still unanswered after a few seconds is waiting on the harness, most often to start (a new session can take a minute),
  // so the composer says whom it waits for.
  const [sendWaiting,setSendWaiting]=useState(false);
  useEffect(()=>{if(!submitting){setSendWaiting(false);return}const timer=setTimeout(()=>setSendWaiting(true),5000);return()=>clearTimeout(timer)},[submitting]);
  const [caret,setCaret]=useState(0);
  const [mentionItems,setMentionItems]=useState([]);
  const [mentionIndex,setMentionIndex]=useState(0);
  const [mentionBusy,setMentionBusy]=useState(false);
  const [slashIndex,setSlashIndex]=useState(0);
  const [slashDismissed,setSlashDismissed]=useState(null);
  const composerRef=useRef(null),slashMenuRef=useRef(null),mentionMenuRef=useRef(null),modelMenuRef=useRef(null),modelButtonRef=useRef(null),wrapRef=useRef(null),shelfRef=useRef(null);
  const speechSupported=typeof window!=="undefined"&&Boolean(window.SpeechRecognition||window.webkitSpeechRecognition);
  useLayoutEffect(()=>{resizeTextarea(composerRef.current,{min:40,max:160})},[prompt]);
  // A send leaves the composer on, with the keyboard, so what the person types straight on while it goes (Sending…) lands there: only
  // Send and Enter wait for it to have gone. The draft sent leaves the composer as the send starts (App's dispatchSend), so no key
  // typed meanwhile is dropped. Send, which turns off with the send, gives the keyboard to the composer. A composer off (a harness not
  // ready, a thread opening) drops the keyboard on the page: it comes back once the composer is on again. Either way it stays where the
  // person put it meanwhile (a click outside the composer, another field, a shortcut). sentFromRef: what had the keyboard when the
  // draft was sent.
  const composerOff=!providerReady||openingThread,sentFromRef=useRef(null);
  useEffect(()=>{const away=event=>{if(!wrapRef.current?.contains(event.target))sentFromRef.current=null};window.addEventListener("pointerdown",away,true);return()=>window.removeEventListener("pointerdown",away,true)},[]);
  useLayoutEffect(()=>{
    const from=sentFromRef.current,active=document.activeElement;if(composerOff||!from)return;if(!submitting)sentFromRef.current=null;
    if(!active||active===document.body||active===from)composerRef.current?.focus();
  },[composerOff,submitting]);
  // The composer's height, on the workspace (--composer-height), ends the thread above it (shell.css) as a draft of several lines, a
  // second row of controls or context chips grow it, the rows of its context chips (--composer-chips) end the new task's welcome
  // above them, and the attachment shelf's height above the composer (--composer-shelf) ends both above its rows. It lands a frame
  // after the composer or the shelf resizes, so the thread's own resize observer, which keeps a thread at its end there, sees its
  // view resize in a frame of its own.
  useEffect(()=>{
    const wrap=wrapRef.current,host=wrap?.parentElement,shelf=shelfRef.current;if(!host||typeof ResizeObserver==="undefined")return;
    const set=(name,px)=>host.style.setProperty(name,px+"px");
    let frame=0;const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{set("--composer-height",wrap.offsetHeight);set("--composer-chips",wrap.querySelector(":scope>.context-chip-row")?.offsetHeight||0);set("--composer-shelf",shelf?.offsetHeight||0)})});
    observer.observe(wrap);if(shelf)observer.observe(shelf);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);host.style.removeProperty("--composer-height");host.style.removeProperty("--composer-chips");host.style.removeProperty("--composer-shelf")};
  },[]);
  // A chip added to a shelf of more rows than it shows brings the shelf's last row, the newest chips, into view, and so does a composer
  // drawn again with its chips (New task or the thread again after Settings, Projects or History): it opened on its oldest rows.
  const shelfCount=attachments.length+uploadingFiles.length,shelfCountRef=useRef(0);
  useLayoutEffect(()=>{const shelf=shelfRef.current,grew=shelfCount>shelfCountRef.current;shelfCountRef.current=shelfCount;if(grew&&shelf)shelf.scrollTop=shelf.scrollHeight},[shelfCount]);
  useEffect(()=>{onModelPickerOpenChange?.(modelOpen)},[modelOpen,onModelPickerOpenChange]);
  useEffect(()=>{if(!modelOpen)setModelQuery("")},[modelOpen]);
  // The menu opens on the checked model, centred, even far down a long catalog (gpt-6.1-sol is 65th of OpenAI's 79); the
  // search box keeps the focus.
  useLayoutEffect(()=>{
    const menu=modelOpen?modelMenuRef.current:null,selected=menu?.querySelector(":scope > button.selected");if(!selected)return;
    menu.scrollTop=Math.max(0,selected.offsetTop-(menu.clientHeight-selected.offsetHeight)/2);
  },[modelOpen]);
  useEffect(()=>{
    if(!modelOpen)return;
    // A press on a toast leaves the picker open too: the toasts stand under the header while it is open (with-composer-menu,
    // overlays.css), and closing it took them back down before the release, so a click on the undo toast's Undo reached the page.
    const pointerDown=event=>{
      const target=event.target;
      if(target instanceof Element&&target.closest(".model-picker-wrap,.thread-undo-toast,.app-action-error-toast"))return;
      setModelOpen(false);
    };
    const keyDown=event=>{
      if(event.key!=="Escape")return;
      // Escape from inside the list hands focus back to the picker button instead of dropping it on the page.
      const inside=document.activeElement instanceof Element&&Boolean(document.activeElement.closest(".model-picker-menu"));
      setModelOpen(false);if(inside)modelButtonRef.current?.focus();
    };
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
        if(id){setModel(id);onSelectedModels?.([id]);closeModelMenu()}
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
  const contextPercent=contextUsagePercent(tokenUsage);
  const priceConfig=(settings.customModels||[]).find(item=>item.id===model&&item.runtime===agentRuntime&&(!runtimeCapabilities.managedInference||item.provider===provider))||null;
  function dictate(){
    if(!speechSupported)return;
    if(recognitionRef.current){recognitionRef.current.stop();return}
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    const recognition=new Recognition();recognitionRef.current=recognition;setDictationAlert(null);
    recognition.lang=navigator.language||"en-US";
    recognition.interimResults=false;
    recognition.continuous=false;
    recognition.onstart=()=>setListening(true);
    recognition.onend=()=>{if(recognitionRef.current===recognition)recognitionRef.current=null;setListening(false)};
    recognition.onerror=event=>{if(recognitionRef.current===recognition)recognitionRef.current=null;setListening(false);const text=DICTATION_ERRORS[event?.error];if(text)setDictationAlert({kind:"dictation",text})};
    recognition.onresult=(event)=>{
      const text=[...event.results].map(result=>result[0]?.transcript||"").join(" ").trim();
      if(text)setPrompt(prev=>(prev&& !/\s$/.test(prev)?prev+" ":"")+text);
    };
    try{recognition.start()}catch(error){recognitionRef.current=null;setDictationAlert({kind:"dictation",text:"Dictation could not start: "+sentenceText(error?.message||String(error))})}
  }
  async function chooseMention(item){
    if(!activeMention||!item||mentionBusy)return;
    setMentionBusy(true);
    try{
      const attached=await onFileMentionAttach?.(item);
      if(!attached)return;
      const label=item.relativePath||item.name||item.path;
      const next=applyFileMention(prompt,activeMention,label);
      onPromptEdit?.();setPrompt(next.text);setMentionItems([]);setCaret(next.caret);
      requestAnimationFrame(()=>{composerRef.current?.focus();composerRef.current?.setSelectionRange(next.caret,next.caret)});
    }finally{setMentionBusy(false)}
  }
  function chooseSlash(cmd){
    onPromptEdit?.();setPrompt(cmd+" ");setSlashIndex(0);
    requestAnimationFrame(()=>{const node=composerRef.current;if(!node)return;node.focus();const end=node.value.length;node.setSelectionRange(end,end);setCaret(end)});
  }
  // The note about dictation goes once the draft is sent, and how the send went shows in its place.
  function sendDraft(send){setDictationAlert(null);sentFromRef.current=document.activeElement||document.body;send?.(prompt)}
  function keyDown(e){
    // A held Enter acts once: only its press completes a command, picks a file or sends, so its repeats do not send what the press
    // completed, or the message only begun with the file it picked.
    if(e.key==="Enter"&&e.repeat&&!e.shiftKey){e.preventDefault();return}
    if(slashMenuOpen){
      if(e.key==="ArrowDown"){e.preventDefault();setSlashIndex((slashActive+1)%slashItems.length);return}
      if(e.key==="ArrowUp"){e.preventDefault();setSlashIndex((slashActive-1+slashItems.length)%slashItems.length);return}
      if(e.key==="Escape"){e.preventDefault();setSlashDismissed(prompt);return}
      const chosen=slashItems[slashActive]?.[0];
      if(e.key==="Tab"&&!e.shiftKey&&chosen){e.preventDefault();chooseSlash(chosen);return}
      // Enter sends a command typed out in full; on a partial word ("/pl") it completes the highlighted command instead.
      if(e.key==="Enter"&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&chosen&&chosen.toLowerCase()!==prompt.trim().toLowerCase()){e.preventDefault();chooseSlash(chosen);return}
    }
    if(activeMention&&mentionItems.length){
      if(e.key==="ArrowDown"){e.preventDefault();setMentionIndex(index=>(index+1)%mentionItems.length);return}
      if(e.key==="ArrowUp"){e.preventDefault();setMentionIndex(index=>(index-1+mentionItems.length)%mentionItems.length);return}
      if((e.key==="Enter"||e.key==="Tab")&&!e.shiftKey){e.preventDefault();chooseMention(mentionItems[mentionIndex]);return}
      if(e.key==="Escape"){e.preventDefault();setMentionItems([]);return}
    }
    // Escape ends the edit of a queued follow-up, which stays queued as it was.
    if(e.key==="Escape"&&onCancelEdit){e.preventDefault();onCancelEdit();return}
    if(e.key==="Enter"&&!e.shiftKey){
      // Enter does what Send does: nothing while Send is off (a file still uploading, which the message would go without, a draft
      // over the limit, a harness switch or a harness away), where the line under the composer says why. An app command still runs,
      // once a send that goes (Sending…) has gone.
      if(draftOff||submitting||messageOff&&!appCommand){e.preventDefault();return}
      if((e.ctrlKey||e.metaKey)&&canBackground){e.preventDefault();sendDraft(onBackgroundSend);return}
      if(!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();sendDraft(onSend);return}
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
  const recipeByCommand=new Map((recipes||[]).map(recipe=>[String(recipe?.name||""),recipe]).filter(([name])=>name.startsWith("/")));
  const recipeSlash=[...recipeByCommand].map(([cmd,recipe])=>[cmd,recipe.description||recipe.title||"Project recipe"]);
  const allSlash=[...SLASH_COMMANDS.map(([cmd,desc])=>cmd==="/goal"&&agentRuntime==="codex"?[cmd,"Set a goal Codex keeps working toward (/goal, pause, resume, clear)"]:[cmd,desc]),...recipeSlash,...nativeSlash].filter(([cmd],index,array)=>array.findIndex(([candidate])=>candidate===cmd)===index);
  const slashAvailable=cmd=>{
    const recipe=recipeByCommand.get(cmd);
    if(recipe)return !projectless&&(!recipe.runtime||recipe.runtime===agentRuntime)&&(!recipe.model||(models||[]).includes(recipe.model));
    if(cmd==="/compact")return threadOpen&&Boolean(runtimeCapabilities.compaction);
    if(["/ps","/stop"].includes(cmd))return Boolean(runtimeCapabilities.backgroundProcesses)&&threadOpen;
    if(cmd==="/feedback")return agentRuntime==="codex"&&threadOpen;
    if(cmd==="/agents")return Boolean(runtimeCapabilities.delegation);
    if(cmd==="/goal")return threadOpen||agentRuntime==="codex";
    if(cmd==="/review")return threadOpen&&gitAvailable;
    if(["/diff","/git"].includes(cmd))return !projectless;
    return true;
  };
  const slashItems=slashOpen?allSlash.filter(([cmd])=>cmd.startsWith(slashQuery.split(/\s/)[0])&&slashAvailable(cmd)):[];
  // The menu picks the command word: it closes once a space follows it, on Escape, and after a command is chosen.
  const slashMenuOpen=slashOpen&&!/\s/.test(prompt)&&slashItems.length>0&&slashDismissed!==prompt;
  const slashActive=slashMenuOpen?Math.min(slashIndex,slashItems.length-1):0;
  useEffect(()=>{setSlashIndex(0)},[slashQuery]);
  // Keyboard choices stay in view in short windows, where the menus scroll.
  useEffect(()=>{keepActiveOptionVisible(slashMenuRef.current)},[slashActive,slashMenuOpen]);
  useEffect(()=>{keepActiveOptionVisible(mentionMenuRef.current)},[mentionIndex,mentionItems]);
  // Whether a menu that opens upward over the space above the composer shows (the slash commands, the file mentions, the model
  // picker): App names it in the workspace shell's class (with-composer-menu), which takes its error toast below the header meanwhile
  // (overlays.css), from the frame that draws the menu to the one that takes it away, or the composer with it.
  const menuShown=slashMenuOpen||Boolean(activeMention&&mentionItems.length>0)||(modelOpen&&models.length>0);
  useLayoutEffect(()=>{if(!menuShown||!onMenuShown)return;onMenuShown(true);return()=>onMenuShown(false)},[menuShown,onMenuShown]);
  const contextPaths=new Set((contextChips||[]).map(chip=>chip.path));
  const promptTooLong=prompt.length>MAX_COMPOSER_CHARS,tooLongNote=promptTooLong?`Draft is ${prompt.length.toLocaleString()} characters · maximum ${MAX_COMPOSER_CHARS.toLocaleString()}`:"";
  const chosenModels=selectedModels.length?selectedModels:(model?[model]:[]);
  const modelMenuIds=useMemo(()=>{
    const query=modelQuery.trim().toLowerCase();
    const matching=query?models.filter(id=>{
      const label=modelMeta?.[id]?.name||"";
      return String(id).toLowerCase().includes(query)||String(label).toLowerCase().includes(query);
    }):models;
    if(matching.length<=180)return matching;
    const pinned=chosenModels.filter(id=>matching.includes(id));
    return [...new Set([...pinned,...matching])].slice(0,180);
  },[models,modelMeta,modelQuery,chosenModels]);
  const runtimeProfileItems=runtimeProfiles?.items||[];
  const currentRuntimeProfile=runtimeProfileItems.find(item=>item.id===runtimeProfiles?.currentInstanceId)||null;
  const runtimeProfileLabel=runtimeProfiles?.label||`${agentRuntimeLabel} profile`;
  const steerFollowUps=Boolean(runtimeCapabilities.steering)&&settings.followUpMode==="steer";
  const modelProviderRuntime=Boolean(runtimeCapabilities.managedInference);
  const reasoningEffortOptions=supportedReasoningEfforts(agentRuntime,provider,model,modelMeta?.[model]||{});
  const serviceTierOptions=supportedModelServiceTiers(agentRuntime,provider,model,modelMeta?.[model]||{});
  // Codex shows the open thread's own effort and tier while it runs this model, and its Standard tier is "default", as
  // T3 Code's Codex selects do.
  const codexChoices=agentRuntime==="codex"?codexModelChoices({settings,provider,model,metadata:modelMeta?.[model]||{},custom:(settings.customModels||[]).find(item=>item.id===model&&item.runtime==="codex")||null,thread:codexThread}):null;
  const reasoningEffort=codexChoices?codexChoices.effort||"":configuredReasoningEffort(settings,agentRuntime,provider,model,modelMeta?.[model]||{})||"";
  const serviceTier=codexChoices?codexChoices.serviceTierPicker:configuredModelServiceTier(settings,agentRuntime,provider,model)||"";
  const effortChoices=reasoningEffort&&!reasoningEffortOptions.includes(reasoningEffort)?[...reasoningEffortOptions,reasoningEffort]:reasoningEffortOptions;
  // Every harness's effort ids read the same way (xhigh is Extra High); a harness's own names (OpenCode variants) stay as given.
  const effortLabel=effort=>codexReasoningEffortLabel(effort);
  // The model's other settings (Cursor's context size and thinking switch), each showing the user's pick or the harness's
  // current value.
  const modelOptionDescriptors=supportedModelOptions(modelMeta?.[model]||{});
  const modelOptionPicks=configuredModelOptions(settings,agentRuntime,provider,model,modelMeta?.[model]||{});
  const providerLabel=modelProviderLabel(provider)||"provider";
  function modelOptionButtons(){return [...(modelMenuRef.current?.querySelectorAll(":scope > button:not(:disabled)")||[])]}
  // Arrow keys reach the model list from the picker button and the search box, and move between its options.
  function focusModelOption(which){
    const pick=()=>{const options=modelOptionButtons();if(!options.length)return false;(which==="last"?options.at(-1):which==="first"?options[0]:(options.find(option=>option.classList.contains("selected"))||options[0])).focus();return true};
    if(!pick())requestAnimationFrame(pick);
  }
  function modelPickerKeyDown(event){
    if((event.key!=="ArrowDown"&&event.key!=="ArrowUp")||!models.length)return;
    event.preventDefault();if(!modelOpen)setModelOpen(true);
    focusModelOption(event.key==="ArrowUp"?"last":"current");
  }
  function modelMenuKeyDown(event){
    if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
    const options=modelOptionButtons(),index=options.indexOf(document.activeElement);if(!options.length||index<0)return;
    event.preventDefault();
    options[event.key==="Home"?0:event.key==="End"?options.length-1:event.key==="ArrowDown"?(index+1)%options.length:(index-1+options.length)%options.length].focus();
  }
  // A pick closes the menu with the keyboard back in the composer, where the draft is (on the picker while the composer waits),
  // not on the page with the option that had it; Escape gives it back to the picker.
  function closeModelMenu(){
    setModelOpen(false);const active=document.activeElement;
    if(!active||active===document.body||active.closest(".model-picker-wrap"))(composerRef.current?.disabled?modelButtonRef.current:composerRef.current)?.focus();
  }
  function pickModel(event,id){
    const next=nextModelSelection(chosenModels,id,{shiftKey:event.shiftKey,allowMulti:allowMultiModel});
    onSelectedModels?.(next);if(!next.includes(model))setModel(next[0]||id);
    if(!event.shiftKey||!allowMultiModel)closeModelMenu();
  }
  // The harness transport is down: the draft stays editable but nothing is sent until it is back.
  const transportError=!transportReady&&transportStatus==="error";
  const transportMessage=transportError?`Could not connect to ${agentRuntimeLabel}${transportReason?": "+transportReason:""}`:transportStatus==="reconnecting"?`Reconnecting to ${agentRuntimeLabel}…`:starting?"Starting Trebell Code…":`Connecting to ${agentRuntimeLabel}…`;
  // Every usable harness catalog lists at least one model; a prompt never goes out without one of the active runtime's models.
  // A running turn takes steers and queued follow-ups without a model (as Enter does); a queued one drains through startTurn, which checks the catalog.
  const modelReady=chosenModels.some(id=>(models||[]).includes(id));
  // While Trebell is starting it does not know which harness to set up yet: the model picker waits for the catalog instead. A
  // model provider without a key is set up first, also one whose catalog lists its fixed model anyway (JustWorker, HCNSec).
  const configureLabel="Configure "+(modelProviderRuntime?providerLabel:agentRuntimeLabel),setupRequired=!starting&&!providerReady&&(!models.length||modelProviderRuntime);
  const modelBlocker=runtimeSwitchLabel||(modelReady&&!setupRequired)||running?"":modelsLoading?"Loading models…":modelError||"No models available — check Settings";
  // Send is off, and Enter with it, while the draft cannot go; the line under the composer and Send's title say why. A message waits
  // for the harness and a model (messageOff), but an app command typed out in full (/model, /palette) needs neither: Enter runs it.
  const messageOff=!providerReady||!transportReady||Boolean(runtimeSwitchLabel)||Boolean(modelBlocker)||submitting||openingThread,draftOff=!prompt.trim()||promptTooLong||uploadingFiles.length>0;
  const sendOff=messageOff||draftOff,typedCommand=/^\s*(\/\S+)/.exec(prompt)?.[1],appCommand=Boolean(typedCommand)&&SLASH_COMMANDS.some(([name])=>name===typedCommand);
  // A model provider with no key yet is a next step (Configure), so its status line is not shown as an error until a key
  // check fails, when the catalog says why instead.
  const providerKeyStep=setupRequired&&modelProviderRuntime&&modelError===MISSING_PROVIDER_KEY;
  // Why dictation could not start, or where the last send or thread open left the draft (App's composerAlert), unless what keeps
  // the draft here now is a harness switch or a transport that is down, which the line says first.
  const shownAlert=!runtimeSwitchLabel&&transportReady?dictationAlert||alert:null;
  // A chip (an attachment or a context) removed from the keyboard takes its focused button with it, so focus moves on to the next
  // chip's remove button in its row, or the one before, or the composer once none is left, instead of falling to the page. A press of
  // the mouse takes no focus (onMouseDown), so after a click focus stays where it was, in the composer for a person writing, and the
  // next space types instead of removing a chip.
  const removeChip=(button,remove)=>{const buttons=[...button.closest(".attachment-shelf,.context-chip-row").querySelectorAll("button")],at=buttons.indexOf(button),focused=button===document.activeElement;remove();if(focused)(buttons[at+1]||buttons[at-1]||composerRef.current)?.focus()};
  // While a turn runs the same Send button queues or steers; its label and tooltip name which (the icon stays the send icon).
  const sendLabel=running&&!steerFollowUps?"Queue follow-up":running?"Steer agent":"Send message";
  // A draft typed while a send goes waits for it to have gone: the line under the composer says so, and Send's title.
  const sendingText=sendWaiting?`Sending · waiting for ${agentRuntimeLabel}…`:"Sending…",draftWaits=submitting&&Boolean(prompt.trim());
  // starting: Trebell's first load has not yet said which harness runs, so the composer names none. threadSettingsWait: another
  // thread's opening state covers the open thread, so the pickers that change the open thread's own mode and agent wait for it.
  const composerPlaceholder=openingThread?"Opening thread…":submitting?sendingText:starting?"Starting Trebell Code…"
    :providerReady?(runtimeSwitchLabel||(!transportReady?transportMessage:running?(steerFollowUps?"Steer the running agent…":"Queue a follow-up…"):"Ask Trebell Code anything…"))
    :modelProviderRuntime?`Configure ${providerLabel} in Settings…`
    :`Configure ${agentRuntimeLabel} in Settings…`;
  return <div ref={wrapRef} className={"composer-wrap"+(prompt.length>=LONG_DRAFT_CHARS?" long-draft":"")} onDragOver={e=>e.preventDefault()} onDrop={onDrop}>
    {slashMenuOpen&&<div className="slash-menu" ref={slashMenuRef}>{slashItems.map(([cmd,desc],index)=><button key={cmd} type="button" className={index===slashActive?"active":undefined} onMouseDown={e=>{e.preventDefault();chooseSlash(cmd)}}><strong>{cmd}</strong><span>{desc}</span></button>)}</div>}
    {activeMention&&mentionItems.length>0&&<div className="file-mention-menu" data-testid="file-mention-menu" ref={mentionMenuRef}>{mentionItems.map((item,index)=><button key={item.path||item.relativePath||index} className={index===mentionIndex?"active":""} disabled={mentionBusy} onMouseDown={event=>{event.preventDefault();chooseMention(item)}}><FileCode2 size={13}/><span><strong>{item.name||String(item.path||"").split(/[\\/]/).pop()}</strong><small>{item.relativePath||item.path}</small></span></button>)}</div>}
    {(contextChips||[]).length>0&&<div className="context-chip-row" data-testid="context-chips" onClick={chipPressOnce}>{contextChips.map(chip=><span className={"context-chip kind-"+(chip.kind||"context")} data-testid="context-chip" key={chip.id||chip.path} title={[[chip.label,chip.detail].filter(Boolean).join(" · "),chip.path].filter(Boolean).join("\n")}><Link2 size={11}/><strong>{chip.label||"Context"}</strong>{chip.detail&&<small>{chip.detail}</small>}<button onMouseDown={event=>event.preventDefault()} onClick={event=>removeChip(event.currentTarget,()=>onRemoveContext(chip.path))} title="Remove context"><X size={10}/></button></span>)}</div>}
    <div className="attachment-shelf" ref={shelfRef} onClick={chipPressOnce}>{attachments.filter(path=>!contextPaths.has(path)).map(path=><span key={path} title={attachmentDisplayName(path)}><Paperclip size={11}/><bdi>{attachmentDisplayName(path)}</bdi><button onMouseDown={event=>event.preventDefault()} onClick={event=>removeChip(event.currentTarget,()=>onRemoveAttachment(path))} title={"Remove "+attachmentDisplayName(path)}><X size={10}/></button></span>)}{uploadingFiles.map(file=><span key={file.id} className="uploading" aria-busy="true" title={"Uploading "+file.name+"…"}><LoaderCircle size={11} aria-hidden="true"/><bdi>{file.name}</bdi><small>Uploading…</small></span>)}</div>
    <textarea ref={composerRef} data-testid="composer" value={prompt} onChange={e=>{onPromptEdit?.();setDictationAlert(null);setPrompt(e.target.value);setCaret(e.target.selectionStart)}} onClick={e=>setCaret(e.currentTarget.selectionStart)} onKeyUp={e=>setCaret(e.currentTarget.selectionStart)} onKeyDown={keyDown} onPaste={onPaste} placeholder={composerPlaceholder} disabled={composerOff}/>
    <div className="composer-bar"><div className="composer-left">
      <button className="circle-btn" onClick={onPickFiles} title="Attach files" aria-label="Attach files"><Plus size={18}/></button>
      {window.trebellDesktop?.captureScreen&&<button className="circle-btn" onClick={onCaptureScreen} title="Capture desktop screenshot" aria-label="Capture desktop screenshot"><Camera size={15}/></button>}
      <select className="permission-picker" value={permissionMode} onChange={e=>setPermissionMode(e.target.value)}><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select>
      {reasoningEffortOptions.length>0&&<select data-testid="reasoning-effort-picker" className="permission-picker reasoning-effort-picker" value={reasoningEffort} disabled={running} onChange={e=>onReasoningEffort?.(e.target.value)} title="Model reasoning / thinking effort (Default: the provider's own level)"><option value="">Thinking · Default</option>{effortChoices.map(effort=><option key={effort} value={effort}>Thinking · {effortLabel(effort)}</option>)}</select>}
      {serviceTierOptions.length>0&&<select data-testid="service-tier-picker" className="permission-picker service-tier-picker" value={serviceTier} disabled={running} onChange={e=>onServiceTier?.(e.target.value)} title={serviceTierPickerTitle(agentRuntime)}><option value={agentRuntime==="codex"?CODEX_STANDARD_SERVICE_TIER:""}>Speed · Standard</option>{serviceTierOptions.map(tier=><option key={tier} value={tier}>Speed · {modelServiceTierLabel(agentRuntime,tier,modelMeta?.[model]||{})}</option>)}</select>}
      {modelOptionDescriptors.map(option=>{const value=modelOptionPicks[option.id]??option.defaultValue??"";return <select key={option.id} data-testid="model-option-picker" data-option-id={option.id} className="permission-picker model-option-picker" value={value} disabled={running} onChange={e=>onModelOption?.(option.id,e.target.value)} title={`${agentRuntimeLabel} model setting: ${option.label}`}>{!option.choices.some(choice=>choice.value===value)&&<option value="">{option.label} · {agentRuntimeLabel}'s setting</option>}{option.choices.map(choice=><option key={choice.value} value={choice.value}>{option.label} · {choice.label}</option>)}</select>})}
      {runtimeCapabilities.collaborationModes&&collaborationModes.length>0&&<select data-testid="collaboration-mode-picker" className="permission-picker collaboration-mode-picker" value={collaborationMode} disabled={running||collaborationModeBusy||threadSettingsWait} onChange={e=>onCollaborationMode?.(e.target.value)} title="Collaboration mode">{collaborationModes.map(item=><option key={item.mode} value={item.mode}>{item.name} mode</option>)}</select>}
      {!threadOpen&&!projectless&&<select className="workspace-mode" value={workspaceMode} onChange={e=>setWorkspaceMode(e.target.value)}><option value="current">Current workspace</option><option value="worktree">New worktree</option></select>}
    </div><div className="composer-right">
      {setupRequired?<button className="login-btn" onClick={onConfigureProvider}>{configureLabel}</button>:<>
        {agentRuntime!=="codex"&&providerAgents.length>0&&<select className="agent-picker" value={providerAgent||""} disabled={threadSettingsWait} onChange={e=>onProviderAgent?.(e.target.value)} title="Provider agent"><option value="">Default agent</option>{providerAgents.map(agent=>{const name=typeof agent==="string"?agent:agent.name;const mode=typeof agent==="string"?"":agent.mode;return <option key={name} value={name}>{name}{mode?` · ${mode}`:""}</option>})}</select>}
        <div className="model-picker-wrap"><button ref={modelButtonRef} data-testid="model-picker" className={"model-picker-button "+(chosenModels.length>1?"multi":"")} disabled={!models.length} onClick={()=>setModelOpen(value=>!value)} onKeyDown={modelPickerKeyDown} aria-haspopup="true" aria-expanded={modelOpen&&models.length>0?"true":"false"} title={!providerReady?"Provider reconnecting":running&&agentRuntime==="codex"?"Select model · applies live when Codex step model switching is enabled":allowMultiModel?"Shift-click models to run the same task in isolated worktrees":"Select model"}><span className="model-picker-current"><strong>{chosenModels.length>1?`${chosenModels.length} models`:(modelMeta?.[model]?.name||compactModelLabel(model)||(runtimeSwitchLabel||modelsLoading?"Loading models…":modelError?"Models unavailable":"No models"))}</strong>{runtimeProfileItems.length>1&&currentRuntimeProfile&&<small>{currentRuntimeProfile.displayName}</small>}</span><ChevronDown size={12}/></button>{modelOpen&&models.length>0&&<div className="model-picker-menu" ref={modelMenuRef} onKeyDown={modelMenuKeyDown}>{runtimeProfileItems.length>1&&<div className="model-runtime-profiles"><p>{runtimeProfileLabel}</p>{runtimeProfileItems.map(item=><button key={item.id} className={item.id===runtimeProfiles.currentInstanceId?"selected":""} disabled={!item.available||item.authenticated===false||Boolean(runtimeProfileBusy)||running} onClick={async()=>{const switched=await onRuntimeProfile?.(item.id);if(switched!==false)closeModelMenu()}}><span>{item.id===runtimeProfiles.currentInstanceId?<Check size={11}/>:<i/>}<strong>{item.displayName}</strong></span><small>{runtimeProfileBusy===item.id?"Switching…":item.available?(item.authenticated===false?"Sign-in required":item.version||"Ready"):item.message||"Unavailable"}</small></button>)}</div>}{models.length>24&&<div className="model-picker-search"><Search size={12}/><input data-testid="model-picker-search" autoFocus value={modelQuery} onChange={event=>setModelQuery(event.target.value)} onKeyDown={event=>{event.stopPropagation();if(event.key==="ArrowDown"){event.preventDefault();focusModelOption("first")}}} placeholder={`Search ${models.length.toLocaleString()} models…`}/></div>}{modelMenuIds.map(id=>{const selected=chosenModels.includes(id);return <button key={id} className={selected?"selected":""} onClick={event=>pickModel(event,id)}><span>{selected?<Check size={11}/>:<i/>}<strong>{modelMeta?.[id]?.name||modelLabel(id)}</strong></span><small>{modelMeta?.[id]?.custom?"custom":modelMeta?.[id]?.upstreamProvider||modelMeta?.[id]?.agent||""}</small></button>})}{modelMenuIds.length===0&&<p>No models match “{modelQuery.trim()}”.</p>}{modelMenuIds.length<models.length&&<p>Showing {modelMenuIds.length} of {models.length.toLocaleString()} models. Search to narrow the list.</p>}{allowMultiModel&&<p>Shift-click to select multiple models. Each runs in its own worktree.</p>}</div>}</div>
      </>}
      <button className={"mic-btn "+(listening?"active":"")} onClick={dictate} disabled={!speechSupported} aria-label="Voice dictation" aria-pressed={listening} title={speechSupported?(listening?"Listening… click to stop":"Voice dictation"):"Voice dictation is unavailable on this platform"}><Mic size={15}/></button>
      <button data-testid="send" className="send-btn" aria-label={sendLabel} onClick={()=>sendDraft(onSend)} disabled={sendOff} title={tooLongNote||runtimeSwitchLabel||(!transportReady?transportMessage:modelBlocker||(submitting?sendingText:uploadingFiles.length?"Waiting for attachments to upload":sendLabel))}><Send size={16}/></button>
    </div></div>
    <div className={"composer-status"+(promptTooLong||shownAlert||transportError||(modelBlocker?!modelsLoading&&!providerKeyStep:modelError)?" error":"")} onClick={footerPressOnce}><span>{promptTooLong?tooLongNote:shownAlert?<span data-testid="composer-alert" className="composer-alert" role={shownAlert.kind==="open"?"status":"alert"}>{shownAlert.text}</span>:runtimeSwitchLabel?<span data-testid="composer-runtime-switch" className="composer-transport">{runtimeSwitchLabel} · your draft stays here until it is ready.</span>:!transportReady?<span data-testid="composer-transport" className="composer-transport">{transportMessage}{transportError?". Your draft is kept.":" · your draft stays here until it connects."}{transportError&&<button className="context-compact-btn" type="button" onClick={onRetryTransport} title={"Reconnect to "+agentRuntimeLabel}>Retry</button>}</span>:draftWaits?<span data-testid="composer-sending" className="composer-transport">{sendingText} · your draft stays here until the last message has gone.</span>:modelBlocker?<span data-testid="composer-model-status" className="composer-transport">{modelBlocker}{!modelsLoading&&!setupRequired&&onConfigureProvider&&<button className="context-compact-btn" type="button" onClick={onConfigureProvider} title={configureLabel+" in Settings"}>{configureLabel}</button>}</span>:modelError||<span className="composer-context" title={tokenLabel(tokenUsage,priceConfig)}>Context{" "}<span className={"context-meter"+(contextPercent==null?" unknown":contextPercent>=90?" full":contextPercent>=75?" high":"")} {...(contextPercent!=null?{role:"meter","aria-label":"Context window used","aria-valuemin":0,"aria-valuemax":100,"aria-valuenow":contextPercent}:{"aria-hidden":"true"})}><i style={{width:(contextPercent||0)+"%"}}/></span>{contextValueLabel(tokenUsage,priceConfig)}{canCompact&&!running&&<button className="context-compact-btn" type="button" onClick={onCompact} title="Compact conversation context">Compact</button>}</span>}</span><span className="composer-hints">{prompt.length>=MAX_COMPOSER_CHARS*0.8&&!promptTooLong&&<span className="composer-draft-count">{prompt.length.toLocaleString()} / {MAX_COMPOSER_CHARS.toLocaleString()} chars · </span>}{onCancelEdit?<>Save edit<kbd className="tb-kbd" aria-hidden="true">Enter</kbd> · Cancel<kbd className="tb-kbd" aria-hidden="true">Esc</kbd></>:<>{canBackground?"Ctrl/Cmd+Enter background · ":""}{steerFollowUps?"Steer":"Queue"} follow-ups<kbd className="tb-kbd" aria-hidden="true">Enter</kbd></>}</span></div>
  </div>;
});

// The shortcuts a held key goes on running as the keyboard repeats it: the ones that step.
const REPEATING_SHORTCUTS=new Set(["navigationBack","navigationForward","threadPrevious","threadNext","previewZoomIn","previewZoomOut"]);
export default function App(){
  const [bootstrap,setBootstrap]=useState({mock:false,wsUrl:null,cwd:"",platform:""});
  const [rpc,setRpc]=useState(null); const [rpcStatus,setRpcStatus]=useState("disconnected"); const [transportReason,setTransportReason]=useState(""); const transportConnectedRef=useRef(false);
  const [threads,setThreads]=useState([]); const [sections,setSections]=useState({}); const [threadMeta,setThreadMeta]=useState({});
  // threadListError: the last thread-list load failed, so the sidebar says so instead of "No threads yet". threadListLoaded: the
  // harness has answered a thread-list load since it connected; until then an empty sidebar is waiting, not empty.
  // threadTurnStates: the turn starts and ends this window saw per thread (the sidebar's running dot).
  const [threadListError,setThreadListError]=useState(""); const [threadListLoaded,setThreadListLoaded]=useState(false); const [threadTurnStates,setThreadTurnStates]=useState({});
  // The turn states as of the last render, for a transport that reconnects (followedThreadIds).
  const threadTurnStatesRef=useRef(threadTurnStates);threadTurnStatesRef.current=threadTurnStates;
  const [activeThread,setActiveThread]=useState(null); const [activeTurnId,setActiveTurnId]=useState(null);
  // The turn the live activity card shows: the running turn, and once it ends the last one (the card stays until the next send,
  // which leaves it to no turn until its own starts). Layout effects, so the rows are ordered for the new turn before it paints.
  // A thread that shows with no turn running has no turn on the live card: one that ran or ended while it opened (its notifications
  // are handled as it shows) keeps its steps on its own card only, as one that ended before the open does.
  const [cardTurnId,setCardTurnId]=useState(null);
  useLayoutEffect(()=>{setCardTurnId(activeTurnId||null);if(!running)setEvents(current=>{const kept=current.filter(event=>!event.turnId);return kept.length===current.length?current:kept})},[activeThread?.id]);
  useLayoutEffect(()=>{if(activeTurnId)setCardTurnId(activeTurnId)},[activeTurnId]);
  const [messages,setMessages]=useState([]); const [events,setEvents]=useState([]);
  // The anchor row of an older page landing now: its virtual chunk mounts with the page, so the anchor is placed exactly.
  const [historyAnchorItemId,setHistoryAnchorItemId]=useState(null);
  const assistantTextRef=useRef("");const commandOutputRef=useRef(new Map());const mcpProgressRef=useRef(new Map());const activityTimelineRef=useRef(null);
  // The MCP progress of each running turn, by item id, and its diff (under ""), by thread and turn, kept whether the thread shows or
  // not: the harness's history has neither, so a thread opened again while the turn runs gets them back on its live card. The
  // turn's end drops its progress; its diff stays until the thread's next turn starts, for the turn's own card (withEndedDiffs), as
  // the bounded row that card shows.
  // liveRepliesRef: the reply each running turn streams, by thread and turn ({itemId,text,sync}), kept the same way as the live
  // reply shows it: Codex's history may not list a reply in progress, and an ACP harness's lists it once the turn ends. One marked
  // copy is the history's copy of the turn's latest reply, from a thread opened with no reply kept: its item's next delta goes on it.
  const liveExtrasRef=useRef(new Map());const liveRepliesRef=useRef(new Map());
  // assistantStreamSyncRef: how much of the live reply is shown, so a Native draft delta lands where its offset says.
  const assistantStreamBufferRef=useRef(null);const assistantStreamSyncRef=useRef(EMPTY_ASSISTANT_STREAM);
  // Per thread and turn: the mode this window sent the turn with, and how and how fast it ended (see turn-outcome.js).
  // turnOutcomePagesRef: for the open item-paged thread, where its turn outcome pages stopped and the turns they covered.
  // turnOrder: the open thread's turn ids, oldest first, so a turn with no rows of its own still ends in its place.
  const [turnInfo,setTurnInfo]=useState({});const turnClockRef=useRef(new Map());const turnOutcomePagesRef=useRef(null);const [turnOrder,setTurnOrder]=useState({threadId:null,ids:[]});
  // turnActivity: the open thread's activity card of every turn, by turn (turn-activity.js), read by the notification handlers through
  // turnActivityRef. liveItemRowsRef: the live card's steps by thread and turn (trackLiveRow), which a turn's card takes once the turn
  // ends; liveTurnKeyRef: the open thread's running turn, the one stored steps may still join the live card for.
  const [turnActivity,setTurnActivity]=useState(()=>emptyTurnActivity(null));const turnActivityRef=useRef(turnActivity);turnActivityRef.current=turnActivity;const liveItemRowsRef=useRef(new Map());const liveTurnKeyRef=useRef(null);
  // retryRowsRef: the live list's retry rows still retrying (retryActivityRow), by thread and row (retryRowKey), since turn ids are
  // only unique inside a thread; each is settled once its turn goes on or ends.
  const retryRowsRef=useRef(new Set());
  // Whether the live turn's block shows (ActivityTimeline says so), for the conversation column's class with-agent-block (shell.css).
  const [agentBlockShown,setAgentBlockShown]=useState(false);
  // Whether a composer menu that opens upward shows (Composer says so), for the workspace shell's class with-composer-menu.
  const [composerMenuShown,setComposerMenuShown]=useState(false);
  const [resolvedMode,setResolvedMode]=useState(()=>typeof document!=="undefined"&&document.documentElement.dataset.mode==="light"?"light":"dark");
  if(!assistantStreamBufferRef.current)assistantStreamBufferRef.current=createTextFrameBuffer({
    schedule:callback=>requestAnimationFrame(callback),
    cancel:handle=>cancelAnimationFrame(handle),
    onFlush:value=>{assistantTextRef.current+=value;activityTimelineRef.current?.setText(assistantTextRef.current)},
  });
  const commandStreamBufferRef=useRef(null);
  if(!commandStreamBufferRef.current)commandStreamBufferRef.current=createKeyedTextFrameBuffer({
    schedule:callback=>requestAnimationFrame(callback),
    cancel:handle=>cancelAnimationFrame(handle),
    onFlush:entries=>{
      for(const [key,value] of entries){const id=String(key||""),text=String(value||"");if(id&&text)commandOutputRef.current.set(id,(commandOutputRef.current.get(id)||"")+text)}
      activityTimelineRef.current?.appendCommandOutputs(entries);
    },
  });
  const diffEventBufferRef=useRef(null);
  if(!diffEventBufferRef.current)diffEventBufferRef.current=createLatestValueBuffer({
    schedule:callback=>setTimeout(callback,120),
    cancel:handle=>clearTimeout(handle),
    onFlush:entries=>setEvents(previous=>{
      let next=previous,changed=false;
      for(const [,event] of entries){
        const index=next.findIndex(item=>item.id===event.id);
        if(index>=0){
          if(sameSnapshot(next[index],event))continue;
          if(!changed)next=[...next];next[index]=event;changed=true;
        }else{
          if(!changed)next=[...next];next.push(event);changed=true;
        }
      }
      return changed?next:previous;
    }),
  });
  const [historyPage,setHistoryPage]=useState({threadId:null,nextCursor:null,paginated:false,loading:false});
  const [threadHistory,setThreadHistory]=useState({runtime:null,runtimePages:{},items:[],nextCursor:null,loading:false,error:""});
  const [threadCatalogCursor,setThreadCatalogCursor]=useState(null);
  const [threadFind,setThreadFind]=useState({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});
  // opening: the thread an open is fetching, from the click until the open is done (sends wait meanwhile): {thread, token (the
  // open's number), reopen (it was the open thread already), toChat (it lands in the chat), from (the section it was asked for
  // in), landed (its history shows)}. Until it lands the sidebar and the header name it; openingCover turns on once it has taken
  // longer than OPENING_COVER_DELAY_MS.
  const [running,setRunning]=useState(false); const [submitting,setSubmitting]=useState(false); const [opening,setOpening]=useState(null); const [openingCover,setOpeningCover]=useState(false); const [queued,setQueued]=useState([]); const [queueMode,setQueueMode]=useState("unknown"); const [queuedEditId,setQueuedEditId]=useState(null);
  // The threads whose local queue a Stop holds (stop()): nothing in it starts by itself, and its follow-ups say so, until the thread
  // runs a turn again (startTurn) or the Stop fails. The hold is saved with the thread's queue (trebellQueueHeld), so the thread opened
  // after a reload or a restart reads it held too (openThreadInternal, saved: it comes from there); a thread whose hold this window has
  // set or ended (holdKnownRef) keeps this window's. localQueueStartRef: the follow-ups of Trebell's queue on their way in this window,
  // from the queue or Send now, until what became of each is written.
  const localQueueStartRef=useRef(new Set());const [heldQueues,setHeldQueues]=useState(()=>new Set()),heldQueuesRef=useRef(heldQueues),holdKnownRef=useRef(new Set());
  const holdQueue=(threadId,held,{saved=false}={})=>{
    const id=String(threadId);holdKnownRef.current.add(id);if(heldQueuesRef.current.has(id)===held)return;
    const next=new Set(heldQueuesRef.current);if(held)next.add(id);else next.delete(id);heldQueuesRef.current=next;setHeldQueues(next);
    if(threadId&&!saved)api("/api/thread-meta",{method:"POST",body:{threadId:id,patch:{trebellQueueHeld:held}}}).catch(error=>showActionError(error,"Could not save the hold on the queued follow-ups"));
  };
  // The composer's draft set aside while a queued follow-up is edited there (editQueued): it comes back once the edit ends.
  const [queueEditDraft,setQueueEditDraft]=useState(null);
  // The queue shown and what Trebell keeps of each thread, as of the last render: what a send that ended reads its follow-up's thread
  // queue from (queueNow), not the copy it took when it began.
  const queueNowRef=useRef(null);queueNowRef.current={queued,threadMeta};
  const [query,setQuery]=useState(""); const [searchResults,setSearchResults]=useState(null); const [threadSearchError,setThreadSearchError]=useState(""); const [section,setSectionState]=useState("chat"); const [settingsEntry,setSettingsEntry]=useState(null); const [settingsSectionLabel,setSettingsSectionLabel]=useState("");
  const [prompt,setPrompt]=useState(""); const [promptHistoryIndex,setPromptHistoryIndex]=useState(-1); const [attachments,setAttachments]=useState([]); const [uploadingFiles,setUploadingFiles]=useState([]); const [contextChips,setContextChips]=useState([]);
  // What the composer says about where its draft went, next to the draft: a send, or a queued follow-up the queue started, that
  // failed before any turn existed ("send", kept until the next send, Send now included, or an edit of the draft), or a thread
  // that did not open ("open", kept until the next send), so the draft never goes to a thread the person did not see coming.
  // Another thread shown, or a new task, clears both.
  const [composerAlert,setComposerAlert]=useState(null);
  const [models,setModels]=useState([]); const [modelMeta,setModelMeta]=useState({}); const [model,setModel]=useState(""); const [selectedModels,setSelectedModels]=useState([]); const [modelError,setModelError]=useState(""); const [modelPickerOpen,setModelPickerOpen]=useState(false); const [modelsLoading,setModelsLoading]=useState(false);
  // runtimeSwitch is set from the moment a harness switch starts until the server answers it: nothing new is sent meanwhile, while the current transport stays open for running turns and approvals.
  const [runtimeSwitch,setRuntimeSwitch]=useState(null);
  const [collaborationModes,setCollaborationModes]=useState([]); const [collaborationMode,setCollaborationMode]=useState("default"); const [collaborationModeBusy,setCollaborationModeBusy]=useState(false);
  const [skills,setSkills]=useState([]); const [providerCommands,setProviderCommands]=useState([]); const [providerAgents,setProviderAgents]=useState([]); const [providerAgent,setProviderAgent]=useState("");
  // Where the skills list stands, so an empty `skills` is claimed as "none discovered" only for an answer that came back empty:
  // "loading" until Codex answers (again while it re-reads), "loaded", "failed" with the error, or "idle" with no workspace to list.
  // skillsPathRef is the workspace the list in `skills` was read for (undefined for a harness's own inventory).
  const [skillsLoad,setSkillsLoad]=useState({status:"loading",error:null}); const skillsReadRef=useRef(0); const skillsPathRef=useRef(null);
  const [threadRuntimeProfiles,setThreadRuntimeProfiles]=useState({threadId:null,supported:false,currentInstanceId:null,items:[]}); const [threadRuntimeProfileBusy,setThreadRuntimeProfileBusy]=useState("");
  // The model, effort and tier the open Codex thread runs with (thread/resume, thread/settings/updated), and the Codex
  // goal waiting to turn active after its first turn starts.
  const [codexThreadState,setCodexThreadState]=useState(null); const codexGoalActivationRef=useRef(null);
  const submittingRef=useRef(false);
  // The sends whose turn has not started yet, by thread: {threadId,requested,stopped,interrupted,view,message,turnId,startedTurnId}.
  // turn/start's answer ends one (startTurn), unless it names the turn queued (turnId), which then waits for its turn/started or
  // turn/completed; startedTurnId is a turn/started that came before the answer. Stop marks the shown thread's (stop()). A new task
  // can send while another thread's send waits, so each thread keeps its own, and its view (the composer hold of the send) and
  // message show it again when the thread is opened before it is through (openThread).
  const pendingSendsRef=useRef(new Map());
  // The draft and note of a send that failed while its thread was not shown, by thread, until the thread is opened again, and the
  // turns a Stop was sent for (thread-turn-notes.js): each goes with its thread or its turns, and both stay bounded.
  const turnNotesRef=useRef(null);if(!turnNotesRef.current)turnNotesRef.current=createThreadTurnNotes();
  // The draft of each send on its way, by its composer hold (send()): its files and context leave the composer when another thread
  // takes the view, and come back when the send's own thread is opened again before its turn starts (openThreadInternal).
  const sendDraftsRef=useRef(new WeakMap());
  // The Stop on its way (stop()): the turn or send it is for, so a second press sends nothing more, and the thread it stops, whose
  // Stop reads "Stopping…" until the turn has ended. The turn notes keep the turns a Stop was sent for until they end, for a
  // thread left and opened again meanwhile (openThread).
  const stopKeyRef=useRef(null); const [stoppingThreadId,setStoppingThreadId]=useState(null);
  const notificationHandlerRef=useRef(null); const serverRequestHandlerRef=useRef(null);
  const [settings,setSettings]=useState(()=>({followUpMode:"queue",defaultPermissionMode:"supervised",appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,customThemes:[],keyboardShortcuts:{},agentRuntime:"codex",modelProvider:DEFAULT_MODEL_PROVIDER,...cachedAppearanceSettings()}));
  const [environmentThemeCatalog,setEnvironmentThemeCatalog]=useState({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]});
  const [sidebarOpen,setSidebarOpen]=useState(()=>!sidebarAutoCollapses(typeof window!=="undefined"?window.innerWidth:1600));
  const [layoutPrefs,setLayoutPrefs]=useState(()=>{
    try{return normalizeLayoutPreferences(JSON.parse(localStorage.getItem("trebell-layout-v1")||"{}"))}
    catch{return {...DEFAULT_LAYOUT}}
  });
  const [permissionMode,setPermissionMode]=useState("supervised"); const [workspaceMode,setWorkspaceMode]=useState("current");
  // projectRecords: the projects this window knows (the list at startup, then each project as it opens, changes or goes), so a thread still
  // opening is named by its project's record before that project opens.
  const [projectRecords,setProjectRecords]=useState([]);
  // Counts the project choices applied (a project opened, a General chat started), so the start-up knows one came before it landed.
  const projectChoiceSeqRef=useRef(0);
  // The settings each save changed (in Settings, or the header's theme button), numbered in the order the saves answered, and the
  // composer's modes the person picked. A read of the settings sent before a save answered (the start-up, the refresh after a scoped
  // change, an environment switch) may hold the state before it, so whenever it lands it leaves what the save set (settingsRead).
  const settingsSavesRef=useRef({count:0,savedAt:new Map()}); const pickedModesRef=useRef({});
  function settingsSaved(keys){const saves=settingsSavesRef.current;saves.count++;for(const key of keys)saves.savedAt.set(key,saves.count)}
  // The update that applies settings read by a request sent when settingsSavesRef.current.count was sentAt.
  function settingsRead(read,sentAt){
    const keep=[...settingsSavesRef.current.savedAt].filter(([,at])=>at>sentAt).map(([key])=>key);
    return prev=>{const next={...prev,...(read||{})};for(const key of keep)next[key]=prev[key];return next};
  }
  // Settings applies a save's answer with the keys the save named, and its own view when it puts one back.
  const settingsPageSettings=useLatestCallback((next,savedKeys)=>{if(savedKeys)settingsSaved(savedKeys);setSettings(next)});
  const [projectPath,setProjectPath]=useState(""); const [currentProject,setCurrentProject]=useState(null); const [actionRuns,setActionRuns]=useState({}); const [projectlessMode,setProjectlessMode]=useState(false); const [generalEnvironmentId,setGeneralEnvironmentId]=useState(null); const [gitInfo,setGitInfo]=useState(null); const [cloneRefreshError,setCloneRefreshError]=useState(""); const [stats,setStats]=useState({}); const [runtime,setRuntime]=useState({});
  const [approvals,setApprovals]=useState([]); const [questions,setQuestions]=useState([]); const [elicitations,setElicitations]=useState([]); const [tokenUsage,setTokenUsage]=useState(null);
  const [guardianDenials,setGuardianDenials]=useState([]); const [guardianBusy,setGuardianBusy]=useState("");
  const [panel,setPanel]=useState(null); const [rightPanelOpen,setRightPanelOpen]=useState(false); const [rightPanelTab,setRightPanelTab]=useState("files"); const [rightPanelMaximized,setRightPanelMaximized]=useState(false); const [reviewedFiles,setReviewedFiles]=useState([]); const [checkpointByTurn,setCheckpointByTurn]=useState({});
  const [selectedThreadIds,setSelectedThreadIds]=useState(new Set()); const [runtimeTransportRevision,setRuntimeTransportRevision]=useState(0);
  const [snoozeRequest,setSnoozeRequest]=useState(null); const [threadUndo,setThreadUndo]=useState(null); const [actionError,setActionError]=useState("");
  const [goal,setGoal]=useState(null); const [continuity,setContinuity]=useState(null); const [linkedPullRequests,setLinkedPullRequests]=useState([]); const [sourceSelectedPr,setSourceSelectedPr]=useState(null);
  const [worktreeSetup,setWorktreeSetup]=useState(null);
  const [threadTelemetry,setThreadTelemetry]=useState({});const threadTelemetryRef=useRef({});
  // runtimeKnown: the first load or a landed harness switch has set settings.agentRuntime; until then it holds the app's default.
  const [runtimeKnown,setRuntimeKnown]=useState(false);
  const [paletteOpen,setPaletteOpen]=useState(false); const [initialLoaded,setInitialLoaded]=useState(false); const [initialLoadError,setInitialLoadError]=useState(""); const [initialLoadRevision,setInitialLoadRevision]=useState(0);
  const [paletteProjects,setPaletteProjects]=useState([]); const [paletteEnvironmentNames,setPaletteEnvironmentNames]=useState({local:"Local machine"}); const [paletteDataError,setPaletteDataError]=useState("");
  const sectionRef=useRef(section);sectionRef.current=section;
  // openRunRef: the last open asked for ({done} settles with it). resumedOnRef: the thread last resumed and the transport it was
  // resumed on. A reconnect waits for the one and does not resume again a thread the other says is resumed on it already.
  // heldNotificationsRef: the notifications of the thread an open has resumed, kept until it shows (see holdThreadNotifications).
  const rpcRef=useRef(null); const activeThreadRef=useRef(null); const openingThreadRef=useRef(null); const openSeqRef=useRef(0); const openRunRef=useRef(null); const resumedOnRef=useRef(null); const heldNotificationsRef=useRef(null); const modelRefreshSeqRef=useRef(0); const backgroundThreadsRef=useRef(new Set()); const threadUndoRef=useRef(null); const threadUndoTimerRef=useRef(null); const actionErrorTimerRef=useRef(null); const backgroundSyncErrorRef=useRef({settlements:"",branchReviews:""}); const threadMessageSearchCacheRef=useRef(new Map()); const navigationHistoryRef=useRef(null); if(!navigationHistoryRef.current)navigationHistoryRef.current=createNavigationHistory(); const paletteSeedRef=useRef(null); const skillOverridesRef=useRef(new Map()); const compactionWaitersRef=useRef(new Map()); const contextTaskRef=useRef(new Map()); const pendingRuntimeThreadRef=useRef(null); const catalogPersistRef=useRef(new Map()); const automaticVerificationRepairSeenRef=useRef(new Set()); const automaticVerificationContinuationSeenRef=useRef(new Set()); const editFromHereAskingRef=useRef(false);
  // The active harness's own slash commands and agents from its model catalog (Claude Code's capability probe): a new chat's
  // menus before its thread exists, as T3 Code lists provider slash commands.
  const runtimeInventoryRef=useRef(null);
  // Counts the new tasks and general chats shown (showNewTask): each comes up on its welcome at its top.
  const [newTaskView,setNewTaskView]=useState(0);
  const conversationScrollRef=useRef(null);const threadScrollPositionsRef=useRef(new Map());const pendingThreadScrollRestoreRef=useRef(null);const pendingHistoryPrependRef=useRef(null);const historyAnchorSettleRef=useRef(null);const historyHoldRef=useRef(0);const historyLoadRef=useRef(null);const threadFindBarRef=useRef(null);const followConversationEndRef=useRef(true);const conversationEndTopRef=useRef(0);const shownWelcomeRef=useRef(null);const modelCatalogScopeRef=useRef(null);const threadFindInputRef=useRef(null);const threadFindSeqRef=useRef(0);
  const modelsRef=useRef([]);const modelRef=useRef("");const modelsLoadingRef=useRef(false);const runtimeSwitchRef=useRef(null);const runtimeRequestRef=useRef(Promise.resolve());const runtimeSettledRef=useRef(Promise.resolve());const runtimeLandedRef=useRef(null);const runtimeSwitchSeqRef=useRef(0);const runtimeAppliedSeqRef=useRef(0);const agentRuntimeRef=useRef("codex");const providerRef=useRef(DEFAULT_MODEL_PROVIDER);
  modelsRef.current=models;modelRef.current=model;
  const autoSettleCandidates=useMemo(()=>hasAutoSettleCandidates(threads,threadMeta),[threads,threadMeta]);
  function resetAssistantStream(){assistantStreamSyncRef.current=EMPTY_ASSISTANT_STREAM;assistantStreamBufferRef.current?.reset();commandStreamBufferRef.current?.reset();diffEventBufferRef.current?.reset();assistantTextRef.current="";commandOutputRef.current.clear();mcpProgressRef.current.clear();activityTimelineRef.current?.resetStreams()}
  function appendAssistantStream(value){assistantStreamBufferRef.current?.push(value)}
  // Clears only the live reply text (a withdrawn Native draft), leaving command, diff and tool streams as they are.
  function clearAssistantText(){assistantStreamSyncRef.current=EMPTY_ASSISTANT_STREAM;assistantStreamBufferRef.current?.reset();assistantTextRef.current="";activityTimelineRef.current?.setText("")}
  // A compaction's item row, under the item's own id as the thread's history names it, takes the place of the row Compact put up for
  // its thread: one compaction is one row, and two in one turn are two. null when it has no such row to take.
  function takeCompactionPlace(prev,row,threadId){
    if(row.kind!=="contextCompaction"||prev.some(event=>event.id===row.id))return null;
    const index=prev.findIndex(event=>event.id==="context-compact-"+threadId&&event.kind==="contextCompaction"&&event.status==="running");
    return index<0?null:prev.map((event,at)=>at===index?row:event);
  }
  // The newest compaction row still running in the open thread's turn records (turnId's when given) ends as end says, so the card
  // its turn keeps says how it ended: compacted, failed, or (its turn ended first) neither.
  function endCompactionRecord(threadId,turnId,end){
    const owner=String(threadId||activeThreadRef.current?.id||"");
    for(const entry of [...liveItemRowsRef.current.values()].reverse()){
      if(entry.threadId!==owner||(turnId&&entry.turnId!==String(turnId)))continue;
      const row=[...entry.rows.values()].reverse().find(item=>item.kind==="contextCompaction"&&item.status==="running");
      if(row){entry.rows.set(String(row.id),end(row));return}
    }
  }
  // The live card's steps for each turn of the open thread, merged as the list merges them (the list cannot be read while a
  // notification is handled): what a turn's own card takes once the turn ends (sealLiveTurn). Card items only.
  function trackLiveRow(threadId,turnId,row,{phase,streamed=""}={}){
    const owner=threadId||activeThreadRef.current?.id,key=turnInfoKey(owner,turnId);if(!key)return;
    let entry=liveItemRowsRef.current.get(key);if(!entry){entry={threadId:String(owner),turnId:String(turnId),rows:new Map()};liveItemRowsRef.current.set(key,entry)}
    const id=String(row.id),next=mergeLiveRow(entry.rows.get(id)||null,row,{phase,streamed});
    if(phase==="started")entry.rows.delete(id);
    entry.rows.set(id,next);
  }
  function keepLiveExtra(threadId,turnId,id,value){
    const key=turnInfoKey(threadId,turnId),extras=liveExtrasRef.current;if(key)extras.set(key,(extras.get(key)||new Map()).set(id,value));
  }
  // A turn that ended keeps on its own card the diff its live card showed last, after its steps.
  function withEndedDiffs(threadId,rowsByTurn,runningTurnId){
    let next=rowsByTurn;
    for(const turnId of Object.keys(rowsByTurn||{})){
      const diff=turnId!==String(runningTurnId||"")&&liveExtrasRef.current.get(turnInfoKey(threadId,turnId))?.get("");
      if(diff){if(next===rowsByTurn)next={...rowsByTurn};next[turnId]=[...rowsByTurn[turnId].filter(row=>row.id!==diff.id),restoredRow(diff)]}
    }
    return next;
  }
  // A delta of a turn's reply goes on the reply kept for the turn as it goes on the live reply (assistantStreamDelta); a copy, only
  // when it is the delta's own reply. whole: the kept reply holds its start, kept from its item's item/started or its turn's
  // turn/started on this socket (keepReplyStart), or from the history's copy. One that a delta began is kept from partway: a
  // reconnect, or an open replaced before it landed, followed the thread from the middle of the reply.
  function keepLiveReply(threadId,turnId,itemId,delta,offset){
    const key=turnInfoKey(threadId,turnId);if(!key)return;
    let kept=liveRepliesRef.current.get(key);if(kept?.copy&&kept.itemId!==String(itemId||""))kept=null;
    const whole=Boolean(kept?.whole||kept?.copy);
    kept=kept||{itemId:null,text:"",sync:EMPTY_ASSISTANT_STREAM};const step=assistantStreamDelta(kept.sync,delta,offset);
    liveRepliesRef.current.set(key,{itemId:itemId?String(itemId):kept.itemId,text:(step.restart?"":kept.text)+step.append,sync:step.state,whole});
  }
  // A reply that starts on this socket is kept from its start: its turn's turn/started (a harness that sends no item/started for its
  // replies streams them from there) or its item's item/started, when no reply with text is kept for the turn yet.
  function keepReplyStart(threadId,turnId,{itemId=null,text=""}={}){
    const key=turnInfoKey(threadId,turnId),kept=key?liveRepliesRef.current.get(key):null;if(!key||kept?.text)return;
    liveRepliesRef.current.set(key,{itemId:itemId?String(itemId):null,text:String(text||""),sync:{chars:String(text||"").length,desynced:false},whole:true});
  }
  // The live reply shows a turn's reply so far from its start, and goes on from it.
  function showLiveReply(threadId,turnId,reply){
    const key=turnInfoKey(threadId,turnId);if(key)liveRepliesRef.current.set(key,reply);
    assistantStreamBufferRef.current?.reset();assistantStreamSyncRef.current=reply.sync;assistantTextRef.current=reply.text;activityTimelineRef.current?.setText(reply.text);
  }
  // Stored steps of the running turn (older than any live one) go in front of its live rows, in the list and in the record above:
  // the turn running when the thread opened, or one that starts again under its id (the relay's restart recovery).
  function seedLiveRows(threadId,turnId,rows){
    const key=turnInfoKey(threadId,turnId);if(!key||!rows?.length||liveTurnKeyRef.current!==key)return;
    const held=liveItemRowsRef.current.get(key)?.rows||new Map(),merged=new Map();
    for(const row of rows)if(!held.has(String(row.id)))merged.set(String(row.id),row);
    for(const [id,row] of held)merged.set(id,row);
    liveItemRowsRef.current.set(key,{threadId:String(threadId),turnId:String(turnId),rows:merged});
    setEvents(current=>{const liveIds=new Set(current.map(event=>String(event.id))),added=rows.filter(row=>!liveIds.has(String(row.id)));return added.length?[...added,...current]:current});
  }
  // A turn that ended, or that the live card left for another, keeps its steps as its own card: its live rows, settled and bounded,
  // after any older ones history pages stored meanwhile. A turn whose history is not all loaded (running when the thread opened,
  // cut by the first page) stays incomplete.
  function sealLiveTurn(threadId,turnId){
    const owner=threadId||activeThreadRef.current?.id,key=turnInfoKey(owner,turnId),entry=liveItemRowsRef.current.get(key);if(!entry)return;
    liveItemRowsRef.current.delete(key);
    const id=String(turnId),sealed=[...entry.rows.values()].map(row=>restoredRow(settledRow(row))),sealedIds=new Set(sealed.map(row=>String(row.id)));
    setTurnActivity(prev=>{
      if(prev.threadId!==entry.threadId)return prev;
      const known=prev.turns[id],older=(known?.rows||[]).filter(row=>!sealedIds.has(String(row.id)));
      return mergeTurnActivity(prev,{[id]:[...older,...sealed]},{mode:"replace",complete:!known||known.complete});
    });
  }
  // A turn whose harness retried its request goes on (outcome "recovered") or ends still retrying ("stopped"): the thread's current
  // activity is no longer the retry, and the turn's retry row says what became of it (settledRetryRows), as does a row of the thread
  // whose notice named no turn. Only the open thread's list holds retry rows (isCurrent).
  function retryRowKey(threadId,turnId){return String(threadId||activeThreadRef.current?.id||"")+"\0"+retryRowId(turnId,threadId)}
  function settleRetry(threadId,turnId,outcome,isCurrent){
    if(threadId&&threadTelemetryRef.current[threadId]?.currentActivity?.kind==="retry")updateThreadTelemetry(threadId,current=>current.currentActivity?.kind==="retry"?{currentActivity:null}:{});
    const ofTurn=turnId!=null&&retryRowsRef.current.delete(retryRowKey(threadId,turnId)),ofThread=retryRowsRef.current.delete(retryRowKey(threadId,null));
    if((ofTurn||ofThread)&&isCurrent)setEvents(prev=>settledRetryRows(prev,{turnId,outcome}));
  }
  useEffect(()=>()=>{assistantStreamBufferRef.current?.dispose();commandStreamBufferRef.current?.dispose();diffEventBufferRef.current?.dispose();for(const waiter of compactionWaitersRef.current.values()){clearTimeout(waiter.timer);waiter.reject?.(new Error("Trebell closed while context compaction was pending"))}compactionWaitersRef.current.clear()},[]);
  // Navigate back/forward (Ctrl+[ / Ctrl+]) and, in a browser tab, the browser's own Back and Forward move through one history
  // (navigation-history.js): each location shown adds an entry to it and to the tab's history (same URL), and Back or Forward from
  // either is shown when the browser reaches the entry (popstate), so nothing is shown twice. A reload opens the app as usual on the
  // entry it reloaded; the entries around it stay, kept for the tab in sessionStorage. The desktop window has no Back or Forward of
  // its own and keeps the history in memory only.
  const [navigationRevision,setNavigationRevision]=useState(0);
  // The threads a Back or Forward finds its entry's thread among: right after a reload the harness may not have listed them yet, and a
  // step to a thread waits for that list (navigationEntryThread). loaded: the harness has listed them; known: loaded, or no list is
  // coming (it failed, or there is no harness transport to list them). meta: what Trebell keeps of each thread (archived, hidden).
  const threadListKnown=threadListLoaded||Boolean(threadListError)||Boolean(bootstrap.mock)||!bootstrap.wsUrl||rpcStatus==="error";
  const navigationThreadsRef=useRef(null);navigationThreadsRef.current={threads,loaded:threadListLoaded,known:threadListKnown,meta:threadMeta};
  useEffect(()=>{navigationHistoryRef.current.applying?.wake?.()},[threads,threadListKnown]);
  const writeNavigationEntry=(mode,entry)=>{
    if(!BROWSER_NAVIGATION||!entry)return;
    try{if(mode==="push")window.history.pushState(browserState(entry),"");else window.history.replaceState(browserState(entry,window.history.state),"")}catch{}
    try{sessionStorage.setItem(NAVIGATION_STORE_KEY,JSON.stringify(storedNavigation(navigationHistoryRef.current)))}catch{}
  };
  useEffect(()=>{
    if(!initialLoaded)return;
    const nav=navigationHistoryRef.current;
    const location={section,threadId:activeThread?.id||null,rightPanelOpen:Boolean(rightPanelOpen),rightPanelTab:rightPanelTab||"files"};
    // A Back or Forward still opening its thread: the views passed on the way are not entries. A page, panel or thread the person
    // picks meanwhile is theirs, and the step leaves it as it is (see showNavigationEntry).
    if(nav.applying){const step=nav.applying;if(!step.moved&&movedDuringStep(step,location)){step.moved=true;step.wake?.()}return}
    if(nav.index<0){
      let stored=null;
      if(BROWSER_NAVIGATION)try{stored=JSON.parse(sessionStorage.getItem(NAVIGATION_STORE_KEY)||"null")}catch{}
      const browserEntryId=BROWSER_NAVIGATION?window.history.state?.trebellNav?.id||null:null,moved=Boolean(browserEntryId)&&browserEntryId!==LOADED_BROWSER_ENTRY_ID;
      const entry=startNavigationHistory(nav,location,{browserEntryId,loadedEntryId:LOADED_BROWSER_ENTRY_ID,stored});
      // Back or Forward pressed while the app was starting: show the page it went to rather than write this one over it.
      if(moved&&entry.id===browserEntryId&&navigationKey(entry)!==navigationKey(location))runUserAction(()=>showNavigationEntry(nav.index),"Could not navigate back");
      else writeNavigationEntry("replace",entry);
      return;
    }
    // A step that has shown its entry: the entry now names what it showed, unless its thread is only missing because no thread list
    // came ("kept"), so a later Back or Forward still tries for it.
    if(nav.landed){const kept=nav.landed==="kept";nav.landed=false;if(kept)return;const settled=settleLocation(nav,location);if(settled.action==="replace")writeNavigationEntry("replace",settled.entry);return}
    const recorded=recordLocation(nav,location);
    if(recorded.action==="push")writeNavigationEntry("push",recorded.entry);
  },[initialLoaded,section,activeThread?.id,rightPanelOpen,rightPanelTab,navigationRevision]);
  // Shows an entry of the history: the last one asked for wins over one still opening its thread. A page, panel, thread or new task
  // the person picks while that thread opens (moved) wins over the step: it leaves the view as the person left it (the thread may
  // still land behind a page, as any open does), and once the step ends that view is recorded as the entry after this one.
  async function showNavigationEntry(index){
    const nav=navigationHistoryRef.current,target=nav.entries[index];
    if(!target)return;
    const token={from:{section:sectionRef.current,threadId:activeThreadRef.current?.id||null,rightPanelOpen:Boolean(rightPanelOpen),rightPanelTab:rightPanelTab||"files"},threadId:target.threadId,moved:false,kept:false,wake:null};
    const replaced=nav.applying;nav.index=index;nav.applying=token;replaced?.wake?.();
    if(BROWSER_NAVIGATION)try{sessionStorage.setItem(NAVIGATION_STORE_KEY,JSON.stringify(storedNavigation(nav)))}catch{}
    try{
      if(target.threadId&&activeThreadRef.current?.id!==target.threadId){
        const thread=await navigationEntryThread(token,target.threadId);
        if(thread&&nav.applying===token&&!token.moved){
          const opening=openThread(thread),openNumber=openSeqRef.current;
          await opening;
          // Another thread or a new task asked for while this one opened has replaced it.
          if(openSeqRef.current!==openNumber)token.moved=true;
        }else if(!thread&&!navigationThreadsRef.current.loaded)token.kept=true;
      }else if(!target.threadId&&activeThreadRef.current?.id&&target.section==="chat"){
        await newChat();
      }
      if(nav.applying!==token||token.moved)return;
      setRightPanelTab(target.rightPanelTab||"files");
      setRightPanelOpen(Boolean(target.rightPanelOpen));
      if(!target.rightPanelOpen)setRightPanelMaximized(false);
      setSection(target.section||"chat");
    }finally{
      if(nav.applying===token){nav.applying=null;nav.landed=token.moved?false:token.kept?"kept":true;setNavigationRevision(value=>value+1)}
    }
  }
  // The thread of the entry a step goes to. Right after a reload the harness may not have listed its threads yet: the step waits for
  // that list, until a later step or a move of the person's own takes over. One the list does not hold (older than its first page) is
  // read from the harness, as History would list it. null: gone (archived or removed since, or the harness no longer has it), or no
  // list is coming.
  async function navigationEntryThread(token,threadId){
    for(;;){
      const {threads:listed,loaded,known}=navigationThreadsRef.current,thread=listed.find(item=>item.id===threadId);
      if(thread||navigationHistoryRef.current.applying!==token||token.moved)return thread||null;
      if(loaded)break;
      if(known)return null;
      await new Promise(resolve=>{token.wake=resolve});
    }
    const meta=navigationThreadsRef.current.meta[threadId]||{};
    if(meta.deletedAt||meta.archived||meta.ephemeral||meta.catalogHidden)return null;
    const read=await rpcRef.current?.request("thread/read",{threadId,includeTurns:false}).catch(()=>null);
    return read?.thread&&!read.thread.archived?read.thread:null;
  }
  async function navigateHistory(delta){
    const nav=navigationHistoryRef.current,next=stepTarget(nav,delta);
    if(next<0)return;
    // In a browser tab the browser takes the step, so its Back and Forward stay where the app is; popstate shows the entry. The step
    // goes to the tab's own entry for it (Navigation API): history.go counts the pages a frame moved through as well (the Browser
    // panel's preview, a document preview), and would step that frame instead of the app.
    if(BROWSER_NAVIGATION){
      nav.pending=next;
      const navigation=window.navigation,current=navigation?.currentEntry;
      const target=current&&current.index>=0&&typeof navigation.traverseTo==="function"?navigation.entries()[current.index+next-nav.index]:null;
      if(!target){window.history.go(delta);return}
      const traversal=navigation.traverseTo(target.key),dropped=()=>{if(nav.pending===next)nav.pending=null};
      traversal?.committed?.catch?.(dropped);traversal?.finished?.catch?.(dropped);
      return;
    }
    await showNavigationEntry(next);
  }
  const browserNavigated=useLatestCallback(event=>{
    const nav=navigationHistoryRef.current;
    if(nav.index<0)return;
    const from=nav.index,index=browserEntryIndex(nav,event.state);
    if(index<0)return;
    if(nav.pending===index)nav.pending=null;
    // An entry whose page changed while the tab was on another one (the entry a reload opened on, when Back came while the app was
    // starting) still holds its old page in the tab's state: it takes the one shown now.
    if(navigationKey(event.state.trebellNav)!==navigationKey(nav.entries[index]))writeNavigationEntry("replace",nav.entries[index]);
    runUserAction(()=>showNavigationEntry(index),index<from?"Could not navigate back":"Could not navigate forward");
  });
  useEffect(()=>{
    if(!BROWSER_NAVIGATION)return;
    window.addEventListener("popstate",browserNavigated);
    return()=>window.removeEventListener("popstate",browserNavigated);
  },[browserNavigated]);
  useEffect(()=>{try{localStorage.setItem("trebell-layout-v1",JSON.stringify(layoutPrefs))}catch{}},[layoutPrefs]);
  const [viewportWidth,setViewportWidth]=useState(()=>typeof window!=="undefined"?window.innerWidth:1600);
  useEffect(()=>{
    let frame=0;const resize=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>setViewportWidth(window.innerWidth))};
    window.addEventListener("resize",resize);return()=>{cancelAnimationFrame(frame);window.removeEventListener("resize",resize)};
  },[]);
  // A browser window too narrow for the sidebar beside a usable main column collapses the sidebar, as Ctrl+B does (the desktop
  // window is never that narrow). It comes back when the window widens past the breakpoint, unless the person had collapsed it.
  const narrowWindow=sidebarAutoCollapses(viewportWidth),sidebarAutoCollapsedRef=useRef(narrowWindow);
  useEffect(()=>{
    if(narrowWindow){if(sidebarOpen){sidebarAutoCollapsedRef.current=true;setSidebarOpen(false)}}
    else if(sidebarAutoCollapsedRef.current){sidebarAutoCollapsedRef.current=false;setSidebarOpen(true)}
  },[narrowWindow]);
  // The docked inspector (wider than 900px) never pushes the main column under 400px or past the window edge: it takes the stored
  // width when the window has room and shrinks toward its 340px minimum when it does not. The stored preference stays for wider
  // windows. The sidebar column follows the shell's own breakpoints (t3-workspace.css: 224px up to 1120px wide).
  const sidebarColumnWidth=!sidebarOpen?0:viewportWidth<=900?196:viewportWidth<=1120?224:layoutPrefs.sidebarWidth;
  const rightPanelWidth=Math.max(LAYOUT_LIMITS.rightPanelWidth[0],Math.min(layoutPrefs.rightPanelWidth,viewportWidth-sidebarColumnWidth-400));
  // The largest size a pane may take in this window; the pointer and keyboard resizers share these limits.
  function layoutMaximum(kind){
    if(kind==="sidebar")return Math.max(210,Math.min(420,window.innerWidth-620));
    if(kind==="right")return Math.max(340,Math.min(820,window.innerWidth-(sidebarOpen?layoutPrefs.sidebarWidth:0)-480));
    return Math.max(190,Math.min(620,window.innerHeight-260));
  }
  // Arrow keys move a separator (Shift for bigger steps): the sidebar grows rightward, the inspector leftward and the terminal
  // upward; Home and End jump to the smallest and largest size.
  function resizeLayoutFromKeyboard(kind,event){
    const key={sidebar:"sidebarWidth",right:"rightPanelWidth",terminal:"terminalHeight"}[kind];if(!key)return;
    const grow={sidebar:"ArrowRight",right:"ArrowLeft",terminal:"ArrowUp"}[kind],shrink={sidebar:"ArrowLeft",right:"ArrowRight",terminal:"ArrowDown"}[kind];
    const step=event.shiftKey?64:16,min=LAYOUT_LIMITS[key][0],max=layoutMaximum(kind),current=key==="rightPanelWidth"?rightPanelWidth:layoutPrefs[key];
    const target=event.key===grow?current+step:event.key===shrink?current-step:event.key==="Home"?min:event.key==="End"?max:null;
    if(target==null)return;
    event.preventDefault();
    setLayoutPrefs(prev=>({...prev,[key]:Math.min(max,clampLayoutValue(key,target))}));
  }
  function layoutSeparatorProps(kind){
    const key={sidebar:"sidebarWidth",right:"rightPanelWidth",terminal:"terminalHeight"}[kind];
    return {tabIndex:0,"aria-valuemin":LAYOUT_LIMITS[key][0],"aria-valuemax":layoutMaximum(kind),"aria-valuenow":key==="rightPanelWidth"?rightPanelWidth:layoutPrefs[key],onKeyDown:event=>resizeLayoutFromKeyboard(kind,event)};
  }
  function beginLayoutResize(kind,event){
    if(event.button!==0)return;
    event.preventDefault();
    const startX=event.clientX,startY=event.clientY,start={...layoutPrefs,rightPanelWidth};
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
    const position=captureConversationPosition(node);if(!position)return null;
    rememberThreadScrollPosition(threadScrollPositionsRef.current,threadId,position);
    followConversationEndRef.current=position.atEnd;
    return position;
  }
  // The column height that holds the rows in view after an older page landed above a short newest page (--history-hold).
  function setHistoryHold(node,value){
    const next=Math.max(0,Math.ceil(Number(value)||0));if(!node||next===historyHoldRef.current)return;
    historyHoldRef.current=next;if(next)node.style.setProperty("--history-hold",next+"px");else node.style.removeProperty("--history-hold");
  }
  function conversationScrolled(){
    const node=conversationScrollRef.current;if(!node)return;
    // Scrolling up uncovers less of the held space: only what still reaches the view's bottom edge stays held, and a hold the rows
    // have outgrown holds nothing any more.
    if(historyHoldRef.current){
      setHistoryHold(node,historyHoldAfterScroll(node,historyHoldRef.current));
      if(historyHoldRef.current&&(node.firstElementChild?.getBoundingClientRect().height||0)>historyHoldRef.current+0.5)setHistoryHold(node,0);
    }
    let position=captureConversationPosition(node);
    // Short of its end, a view that follows the end stops following only when its top is above where it was last at its end: the
    // person scrolled up. Otherwise the conversation grew under it after its move to the end, whose scroll event comes once what grew
    // is laid out (an approval card or a reply that came in the moment after that move, as OpenCode's do, which left the card's
    // buttons or the reply under the composer), and it goes back to the end.
    if(position&&!position.atEnd&&followConversationEndRef.current&&node.scrollTop>=conversationEndTopRef.current-1){keepConversationEnd(node);position=captureConversationPosition(node)}
    followConversationEndRef.current=position?.atEnd!==false;if(position?.atEnd)conversationEndTopRef.current=node.scrollTop;
    const threadId=activeThreadRef.current?.id;if(threadId&&position)rememberThreadScrollPosition(threadScrollPositionsRef.current,threadId,position);
  }
  function stopHistoryAnchorSettle(){
    const settle=historyAnchorSettleRef.current;historyAnchorSettleRef.current=null;
    if(settle?.frame)cancelAnimationFrame(settle.frame);
  }
  // A view that follows the end goes back to it. The welcome of a conversation with nothing in it has no end to follow: it comes up at
  // its top, in each view that shows it (a new task, a general chat, a thread with nothing in it: each one clears shownWelcomeRef as it
  // comes up), also in place of a conversation or another welcome scrolled down, and then stays where the person scrolls it, whatever
  // the zoom or size.
  function keepConversationEnd(node){
    const welcome=conversationWelcome(node);
    if(welcome){if(shownWelcomeRef.current!==welcome){shownWelcomeRef.current=welcome;node.scrollTop=0}return}
    shownWelcomeRef.current=null;if(followConversationEndRef.current){node.scrollTop=Math.max(0,node.scrollHeight-node.clientHeight);conversationEndTopRef.current=node.scrollTop}
  }
  // A send brings the newest message into view: the view follows the end again, and an older page's anchor stops holding it.
  function followConversationEnd(){stopHistoryAnchorSettle();pendingHistoryPrependRef.current=null;setHistoryAnchorItemId(null);setHistoryHold(conversationScrollRef.current,0);followConversationEndRef.current=true}
  // Puts the anchor row back on its spot. A newest page that did not fill the view ends inside it, so the view cannot scroll far
  // enough: the column then keeps the height the spot needs, the empty space that was below those rows.
  function placeHistoryAnchor(node,anchor){
    if(!restoreHistoryPrependAnchor(node,anchor))return false;
    const short=historyAnchorShortfall(node,anchor);
    if(short>0.5){const column=node.firstElementChild;setHistoryHold(node,(column?.getBoundingClientRect().height||0)+short);restoreHistoryPrependAnchor(node,anchor)}
    return true;
  }
  useLayoutEffect(()=>{
    const node=conversationScrollRef.current;const threadId=activeThread?.id;if(!node||!threadId)return;
    if(pendingHistoryPrependRef.current?.threadId===threadId){
      // The older page is placed once: its first row keeps the spot the anchor row had (its virtual chunk mounts with the page). Rows
      // above it can still change size for a few frames (content-visibility estimates, fonts, chunks mounting), so each frame puts
      // the anchor back until those settle or something else moves the view (the person scrolls, a send scrolls to the end). Later
      // message or event changes do not re-pin it.
      const pending=pendingHistoryPrependRef.current;pendingHistoryPrependRef.current=null;stopHistoryAnchorSettle();
      if(!placeHistoryAnchor(node,pending.anchor))node.scrollTop=Math.max(0,pending.scrollTop+(node.scrollHeight-pending.scrollHeight));
      followConversationEndRef.current=false;
      const settle={threadId,anchor:pending.anchor,top:node.scrollTop,frame:0,attempts:0};historyAnchorSettleRef.current=settle;
      const finish=()=>{historyAnchorSettleRef.current=null;const id=settle.anchor?.messageId??null;setHistoryAnchorItemId(current=>current===id?null:current)};
      const step=()=>{
        if(historyAnchorSettleRef.current!==settle)return;
        const live=conversationScrollRef.current;
        if(!live||activeThreadRef.current?.id!==settle.threadId||!pending.anchor||historyAnchorDisturbed(live,settle.anchor,settle.top)){finish();return}
        placeHistoryAnchor(live,settle.anchor);settle.top=live.scrollTop;
        if(++settle.attempts<12)settle.frame=requestAnimationFrame(step);else finish();
      };
      settle.frame=requestAnimationFrame(step);
      return;
    }
    if(pendingThreadScrollRestoreRef.current===threadId){
      const position=threadScrollPositionsRef.current.get(threadId)||null;
      // A thread with nothing in it opens on its welcome, at its top (keepConversationEnd), not at the welcome's end as a thread
      // opens at its newest message: from 150% zoom that end had the welcome's picture and title under the header.
      if(conversationWelcome(node))keepConversationEnd(node);else node.scrollTop=restoredThreadScrollTop(position,node);
      followConversationEndRef.current=position?.atEnd??true;if(followConversationEndRef.current)conversationEndTopRef.current=node.scrollTop;
      pendingThreadScrollRestoreRef.current=null;
      return;
    }
    // The live card takes its new turn a commit after its first row shows (cardTurnId), when the turn before's reply moves back
    // above it, and the browser's scroll anchoring keeps that reply where it was on screen: a view that follows the end goes back.
    keepConversationEnd(node);
  },[activeThread?.id,messages.length,events.length,cardTurnId]);
  // A new task or a general chat comes up on its welcome at its top, also in place of a welcome scrolled down. That welcome can be the
  // same element with new words (New general chat from the palette, over the new task), whose box need not resize, so the observer
  // below would not see it come up.
  useLayoutEffect(()=>{const node=conversationScrollRef.current;if(node&&newTaskView)keepConversationEnd(node)},[newTaskView]);
  useEffect(()=>{
    const node=conversationScrollRef.current;if(!node||typeof ResizeObserver==="undefined")return;
    const content=node.firstElementChild;if(!content)return;
    // A view that follows the end stays on the newest message when the messages grow and when the view itself is resized, as
    // when the terminal opens beneath it (T3 keeps the end on layout changes too). A view scrolled up stays where it is.
    const observer=new ResizeObserver(()=>keepConversationEnd(node));
    observer.observe(content);observer.observe(node);return()=>observer.disconnect();
  },[section,activeThread?.id]);
  useEffect(()=>{
    if(!threadFind.open)return;
    const id=requestAnimationFrame(()=>threadFindInputRef.current?.focus());
    return()=>cancelAnimationFrame(id);
  },[threadFind.open]);
  // The find bar floats over the top of the conversation, so while it is open the conversation keeps that strip clear: a jump
  // lands below the bar (scroll-padding) and the first rows and controls start below it (padding). The strip follows the bar's
  // height, which grows with the match snippet. Opening, growing or closing it never moves the rows being read: the scroll
  // position moves with the padding. Only a view at the very top of the thread lets the opening strip push the first rows down.
  useLayoutEffect(()=>{
    const scroller=conversationScrollRef.current,bar=threadFindBarRef.current;
    if(!scroller)return;
    const reserve=value=>{
      const next=value==null?"":Math.max(0,value)+"px";if(scroller.style.getPropertyValue("--thread-find-reserve")===next)return;
      const top=scroller.scrollTop,before=parseFloat(getComputedStyle(scroller).paddingTop)||0;
      if(next)scroller.style.setProperty("--thread-find-reserve",next);else scroller.style.removeProperty("--thread-find-reserve");
      const shift=(parseFloat(getComputedStyle(scroller).paddingTop)||0)-before;
      if(shift&&(top>0||shift<0))scroller.scrollTop=top+shift;
    };
    if(!threadFind.open||!bar){reserve(null);return}
    const measure=()=>reserve(Math.ceil(bar.getBoundingClientRect().bottom-scroller.getBoundingClientRect().top+12));
    measure();
    if(typeof ResizeObserver==="undefined")return;
    // The scroller's border box: its padding, which the reserve itself sets, must not re-trigger the measure.
    const observer=new ResizeObserver(measure);observer.observe(bar);observer.observe(scroller,{box:"border-box"});
    return()=>observer.disconnect();
  },[threadFind.open,section,activeThread?.id]);

  useEffect(()=>{
    const root=document.documentElement;const media=window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply=()=>{
      const requested=["system","light","dark"].includes(settings.appearanceMode)?settings.appearanceMode:"system";
      const resolved=requested==="system"?(media?.matches===false?"light":"dark"):requested;
      const custom=environmentThemes.find(theme=>theme.publishedId===selectedEnvironmentThemeId)||(settings.customThemes||[]).find(theme=>theme.id===settings.appearance);
      const theme=custom?.id||settings.appearance||"dark";
      // A mode or theme change swaps every token at once: transitions stay off for that frame, so buttons, chips and fields do
      // not fade from the old palette (or stall on it while a heavy first render runs).
      const switching=root.dataset.mode!==resolved||root.dataset.theme!==theme||root.dataset.customTheme!==(custom?"true":"false");
      if(switching)root.classList.add("tb-theme-switching");
      root.dataset.theme=theme;root.dataset.mode=resolved;root.dataset.customTheme=custom?"true":"false";root.dataset.environmentTheme=custom?.published?"true":"false";root.style.colorScheme=resolved;setResolvedMode(resolved);
      const variableNames=["--theme-canvas","--theme-foreground","--bg","--panel","--panel2","--line","--muted","--muted2","--purple","--purple2","--green","--theme-error","--theme-warning","--theme-terminal-selection"];
      for(const name of variableNames)root.style.removeProperty(name);
      if(custom){for(const [name,value] of Object.entries(themeCssVariables(custom,resolved)))root.style.setProperty(name,value)}
      try{localStorage.setItem(APPEARANCE_CACHE_KEY,JSON.stringify({mode:requested,theme:settings.appearance||"dark"}))}catch{}
      if(switching)requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.remove("tb-theme-switching")));
    };
    apply();media?.addEventListener?.("change",apply);return()=>media?.removeEventListener?.("change",apply);
  },[settings.appearance,settings.appearanceMode,settings.customThemes,environmentThemes,selectedEnvironmentThemeId]);
  useEffect(()=>{
    const root=document.documentElement;const media=window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const apply=()=>{const duration=media?.matches?0:Math.max(0,Math.min(400,Number(settings.panelAnimationMs)||0));root.style.setProperty("--panel-animation-ms",duration+"ms")};
    apply();media?.addEventListener?.("change",apply);return()=>media?.removeEventListener?.("change",apply);
  },[settings.panelAnimationMs]);
  useEffect(()=>{activeThreadRef.current=activeThread},[activeThread]);
  // An open the person waits on: the cover starts once it has taken longer than a moment, and stays while a later open replaces it.
  const openingPending=Boolean(opening&&!opening.reopen&&!opening.landed);
  useEffect(()=>{
    if(!openingPending){setOpeningCover(false);return}
    const timer=setTimeout(()=>setOpeningCover(true),OPENING_COVER_DELAY_MS);
    return()=>clearTimeout(timer);
  },[openingPending]);
  useEffect(()=>{
    if(!paletteOpen)return;
    let cancelled=false;setPaletteDataError("");
    Promise.allSettled([
      api("/api/projects"),
      api("/api/environments"),
    ]).then(([projectResult,environmentResult])=>{
      if(cancelled)return;
      const failures=[];
      if(projectResult.status==="fulfilled")setPaletteProjects(projectResult.value.projects||[]);
      else failures.push("projects: "+(projectResult.reason?.message||String(projectResult.reason)));
      if(environmentResult.status==="fulfilled")setPaletteEnvironmentNames(Object.fromEntries([["local","Local machine"],...(environmentResult.value.profiles||[]).map(profile=>[profile.id,profile.name||profile.id])]));
      else failures.push("environments: "+(environmentResult.reason?.message||String(environmentResult.reason)));
      setPaletteDataError(failures.length?"Could not refresh command palette data · "+failures.join(" · "):"");
    });
    return()=>{cancelled=true};
  },[paletteOpen]);

  function updateThreadTelemetry(threadId,patch,{render=rightPanelOpen&&rightPanelTab==="agents"}={}){
    if(!threadId)return;
    const current=threadTelemetryRef.current[threadId]||{};
    const delta=typeof patch==="function"?patch(current):patch;
    const next={...current,...delta};threadTelemetryRef.current[threadId]=next;
    if(render)setThreadTelemetry(prev=>({...prev,[threadId]:next}));
  }
  useEffect(()=>{if(rightPanelOpen&&rightPanelTab==="agents")setThreadTelemetry({...threadTelemetryRef.current})},[rightPanelOpen,rightPanelTab]);
  useEffect(()=>{
    const visible=section==="chat"||section==="new"||(rightPanelOpen&&rightPanelTab==="runtime");
    const threadId=activeThread?.id;if(!visible||!threadId)return;
    const latest=threadTelemetryRef.current[threadId];
    if(latest&&Object.prototype.hasOwnProperty.call(latest,"tokenUsage"))setTokenUsage(current=>current===latest.tokenUsage?current:latest.tokenUsage||null);
  },[section,rightPanelOpen,rightPanelTab,activeThread?.id]);
  function settleCompactionWaiter(threadId,error=null,result={ok:true}){
    const id=String(threadId||"");const waiter=compactionWaitersRef.current.get(id);if(!waiter)return false;
    compactionWaitersRef.current.delete(id);clearTimeout(waiter.timer);
    if(error)waiter.reject(error);else waiter.resolve(result);
    return true;
  }
  function requestThreadCompaction(threadId,{timeoutMs=45_000}={}){
    const id=String(threadId||"").trim(),client=rpcRef.current;
    if(!id||!client)return Promise.reject(new Error("Agent harness is not connected"));
    const existing=compactionWaitersRef.current.get(id);if(existing)return existing.promise;
    let resolvePromise,rejectPromise;
    const promise=new Promise((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject});
    const timer=setTimeout(()=>settleCompactionWaiter(id,new Error("Context compaction timed out")),Math.max(5000,Number(timeoutMs)||45_000));
    compactionWaitersRef.current.set(id,{promise,resolve:resolvePromise,reject:rejectPromise,timer});
    client.request("thread/compact/start",{threadId:id}).catch(error=>settleCompactionWaiter(id,error));
    return promise;
  }
  function notificationIsActive(threadId){return !threadId||threadId===activeThreadRef.current?.id}
  // Another thread is opening: the sidebar and the header name it already, so the open thread's own settings (mode, agent, model
  // setting, runtime profile) are not changed, nor is it compacted. Its opening state takes those controls away; before it shows, a
  // pick in them does nothing.
  function leavingThread(){return Boolean(openingThreadRef.current)&&openingThreadRef.current!==String(activeThreadRef.current?.id||"")}

  // With the preview open the desktop shell leaves Ctrl+=, Ctrl+- and Ctrl+0 to the page (desktop/main.mjs), for the preview's zoom
  // keys. Where the preview's binding does not apply (a question open, the terminal focused), they zoom the window, as elsewhere.
  const previewZoomKeys=Boolean(rightPanelOpen&&rightPanelTab==="preview");
  useEffect(()=>{window.trebellDesktop?.zoom?.previewKeys?.(previewZoomKeys)},[previewZoomKeys]);
  function desktopWindowZoomKey(event){
    const zoom=window.trebellDesktop?.zoom;if(!zoom||(!event.ctrlKey&&!event.metaKey)||event.altKey)return;
    const key=String(event.key||"").toLowerCase(),step=key==="+"||key==="="?0.1:key==="-"?-0.1:key==="0"?0:null;if(step==null)return;
    event.preventDefault();
    (step===0?zoom.reset():zoom.get().then(result=>zoom.set((Number(result?.factor)||1)+step))).catch(error=>showActionError(error,"Could not change desktop zoom"));
  }

  useEffect(()=>{
    const zoom=window.trebellDesktop?.zoom;if(!zoom)return;
    // Each notch steps from the window's zoom as it is then, which the shell's zoom keys and Ctrl+0 change too (desktop/main.mjs);
    // a notch that comes before the shell has answered the one before waits for it, so none is lost.
    let steps=Promise.resolve();
    const onWheel=(event)=>{
      if(!event.ctrlKey&&!event.metaKey)return;
      event.preventDefault();
      const direction=Math.sign(Number(event.deltaY)||0);
      if(direction===0)return;
      steps=steps.then(()=>zoom.get()).then(result=>zoom.set((Number(result?.factor)||1)+(direction<0?0.1:-0.1))).catch(error=>showActionError(error,"Could not change desktop zoom"));
    };
    window.addEventListener("wheel",onWheel,{capture:true,passive:false});
    return()=>window.removeEventListener("wheel",onWheel,{capture:true});
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
        setEvents(prev=>[...prev,{id:"snapshot-error-"+Date.now(),kind:"error",title:"Could not attach the SnapShot: "+(error.message||String(error)),status:"done",raw:{snapshotId:id}}]);
      }finally{handling.delete(id)}
    };
    snapshots.pending().then(items=>{for(const item of items||[])attachCapture(item.id)}).catch(error=>showActionError(error,"Could not load pending SnapShots"));
    const unsubscribe=snapshots.onCaptured?.(payload=>attachCapture(payload?.id));
    return()=>{disposed=true;unsubscribe?.()};
  },[]);

  const agentRuntime=settings.agentRuntime||bootstrap.agentRuntime||"codex";
  const runtimeCapabilities=useMemo(()=>bootstrap.agentRuntime===agentRuntime&&bootstrap.runtimeCapabilities
    ?bootstrap.runtimeCapabilities
    :sharedRuntimeCapabilities(agentRuntime),[bootstrap.agentRuntime,bootstrap.runtimeCapabilities,agentRuntime]);
  const managedInference=Boolean(runtimeCapabilities.managedInference);
  const provider=settings.modelProvider||bootstrap.provider||DEFAULT_MODEL_PROVIDER;
  agentRuntimeRef.current=agentRuntime;providerRef.current=provider;
  useEffect(()=>{
    const next=modelCatalogScope(agentRuntime,provider);
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
  };
  const workspaceEnvironmentType=currentProject?.environment?.type||(workspaceEnvironmentId&&(workspaceEnvironmentId===settings.activeEnvironmentId)?bootstrap.activeEnvironment?.type:null)||(workspaceEnvironmentId?"remote":"local");
  const workspaceRemote=Boolean(workspaceEnvironmentId&&workspaceEnvironmentType!=="local");
  const providerReady=bootstrap.mock||(managedInference?Boolean(bootstrap.providerReady):Boolean(bootstrap.agentRuntimeReady));
  useEffect(()=>{
    if(!threadFind.open)return;
    const term=threadFind.query.trim();
    if(term.length<2||!runtimeCapabilities.threadSearch||!activeThread?.id||!rpc||rpcStatus!=="connected"){
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
  },[threadFind.open,threadFind.query,runtimeCapabilities.threadSearch,activeThread?.id,rpc,rpcStatus]);
  useEffect(()=>{threadTelemetryRef.current={};setThreadTelemetry({})},[provider,agentRuntime]);
  // preferredModel may be a function, read when the catalog lands (a project opened meanwhile can name its default model).
  function applyModelCatalog(d,{preferredModel=modelRef.current}={}){
    const ids=Array.isArray(d?.models)?d.models:[],preferred=typeof preferredModel==="function"?preferredModel():preferredModel;
    setModelError(d?.error||"");
    setModelMeta(Object.fromEntries((d?.metadata?.models||[]).map(item=>[item.id,item])));
    // A new chat shows the harness's own menus, whole: what the new harness does not list (another harness's commands, agents
    // or skills) is cleared. Codex lists its skills itself (skills/list).
    const inventory=d?.inventory&&typeof d.inventory==="object"?d.inventory:null,previousInventory=runtimeInventoryRef.current;
    runtimeInventoryRef.current=inventory;
    if(!activeThreadRef.current&&(inventory||previousInventory))applyProviderInventory(harnessInventory(inventory,null,{withSkills:d?.agentRuntime!=="codex"}));
    const next=ids.includes(preferred)?preferred:(ids.includes(d?.defaultModel)?d.defaultModel:(ids[0]||""));
    setModels(ids);setModel(next);setSelectedModels(next?[next]:[]);
    return next;
  }
  function clearModelCatalog(){modelsLoadingRef.current=false;setModelsLoading(false);setModels([]);setModel("");setSelectedModels([]);setModelMeta({});setModelError("")}
  async function refreshProviderModels({provider:expectedProvider=null,agentRuntime:expectedRuntime=null,catalog=null,bootstrap:bootstrapSnapshot=null,refreshBootstrap=true,preferredModel=()=>relayThreadPreferredModel(agentRuntimeRef.current,activeThreadRef.current,modelRef.current)}={}){
    const seq=++modelRefreshSeqRef.current;
    // Scope checks read the latest committed runtime and provider, never a render closure: a harness switch may have landed since this refresh was requested.
    const currentRuntime=agentRuntimeRef.current,currentProvider=providerRef.current;
    const targetProvider=expectedProvider||currentProvider,targetRuntime=expectedRuntime||currentRuntime;
    const sameScope=modelCatalogScope(targetRuntime,targetProvider)===modelCatalogScope(currentRuntime,currentProvider);
    const bundledCatalogMatches=Boolean(catalog&&(!catalog.provider||catalog.provider===targetProvider)&&(!catalog.agentRuntime||catalog.agentRuntime===targetRuntime));
    if(!sameScope&&!bundledCatalogMatches){setModels([]);setModel("");setSelectedModels([]);setModelMeta({});setModelError("")}
    if(!catalog){modelsLoadingRef.current=true;setModelsLoading(true)}
    try{
      const [bootResult,modelResult]=await Promise.all([
        bootstrapSnapshot?Promise.resolve({value:bootstrapSnapshot,error:null}):refreshBootstrap?api("/api/bootstrap").then(value=>({value,error:null}),error=>({value:null,error})):Promise.resolve({value:null,error:null}),
        catalog?Promise.resolve({value:catalog,error:null}):api("/api/models").then(value=>({value,error:null}),error=>({value:null,error})),
      ]);
      if(seq!==modelRefreshSeqRef.current)return modelResult.value;
      if(modelResult.error){
        const message=modelResult.error.message||String(modelResult.error);
        if(bootResult.value)setBootstrap(bootResult.value);
        else if(bootResult.error)showActionError(bootResult.error,"Model catalog and provider status could not refresh");
        setModelError(message);
        return {provider:targetProvider,agentRuntime:targetRuntime,models:sameScope?modelsRef.current:[],error:message,stale:sameScope};
      }
      const d=modelResult.value||{models:[]};
      // Accept the catalog of the runtime this refresh targets or of the runtime shown now; any other catalog answers for a harness that is no longer active.
      const runtimeMatches=!d?.agentRuntime||d.agentRuntime===targetRuntime||d.agentRuntime===agentRuntimeRef.current;
      const providerMatches=!d?.provider||d.provider===targetProvider||d.provider===providerRef.current;
      if(!runtimeMatches||!providerMatches){
        if(!modelsRef.current.length)setModelError(`The model catalog came back for ${runtimeMatches?modelProviderLabel(d.provider):agentRuntimeName(d.agentRuntime)} instead. Select the harness again in Settings.`);
        return d;
      }
      if(bootResult.value)setBootstrap(bootResult.value);
      else if(!refreshBootstrap)setBootstrap(previous=>({...previous,...(d?.provider?{provider:d.provider}:{}),...(typeof d?.ready==="boolean"?{providerReady:d.ready}:{}),...(d?.agentRuntime?{agentRuntime:d.agentRuntime}:{})}));
      else if(bootResult.error)showActionError(bootResult.error,"Models refreshed, but provider status could not refresh");
      applyModelCatalog(d,{preferredModel});
      return d;
    }finally{if(seq===modelRefreshSeqRef.current){modelsLoadingRef.current=false;setModelsLoading(false)}}
  }
  function resetThreadView(runtime,capabilities){
    activeThreadRef.current=null;setActiveThread(null);setActiveTurnId(null);setRunning(false);setMessages([]);setEvents([]);setTurnActivity(emptyTurnActivity(null));liveItemRowsRef.current.clear();liveTurnKeyRef.current=null;setTokenUsage(null);resetAssistantStream();setQueued([]);setQueueMode(shouldUseRuntimeNativeQueue({agentRuntime:runtime,nativeQueue:capabilities?.nativeQueue,projectless:projectlessMode})?"unknown":"local");setQueuedEditId(null);
  }
  // The open thread when the person opened it while the switch ran and it belongs to the harness the switch lands on, else null. A
  // switch closes the thread it replaces (the one open when it began), not one the person has since opened under the landing harness.
  function threadOpenedDuringSwitch(pending,runtime){
    const thread=activeThreadRef.current;
    return threadKeptBySwitch(thread,threadMeta[thread?.id]||{},{switchThreadId:pending.threadId,landingRuntime:runtime,openedUnder:agentRuntimeRef.current})?thread:null;
  }
  // A harness switch clears the previous runtime's models at once and gates the composer until the server answers. Its transport stays open
  // until then (see the transport effect), so a rejected switch leaves running turns and open approvals of the active harness untouched.
  // threadId: the thread open when the switch began, the one resetThread closes.
  // A switch that replaces one still on its way keeps that one's catalog to put back, the catalog of the harness that runs.
  function beginRuntimeSwitch({runtime,instanceId=null,resetThread=true}={}){
    const pending={id:++runtimeSwitchSeqRef.current,from:agentRuntime,to:String(runtime||agentRuntime),instanceId:instanceId||null,resetThread,threadId:activeThreadRef.current?.id||null,previous:runtimeSwitchRef.current?.previous||{models,modelMeta,model,selectedModels,modelError,scope:modelCatalogScopeRef.current}};
    runtimeSwitchRef.current=pending;modelRefreshSeqRef.current++;
    setRuntimeSwitch({id:pending.id,from:pending.from,to:pending.to});
    clearModelCatalog();
    return pending;
  }
  async function completeRuntimeSwitch(pending,result){
    if(runtimeSwitchRef.current?.id!==pending.id)return false;
    // The switch response reports the runtime the server now runs; its bundled bootstrap and catalog belong to that runtime.
    const runtime=String(result?.selectedRuntime||result?.selected?.runtime||result?.kind||result?.bootstrap?.agentRuntime||pending.to);
    const instanceId=result?.selectedInstanceId||result?.selected?.instance?.id||result?.resetTo||pending.instanceId||`${runtime}-default`;
    let boot=result?.bootstrap||null;
    if(!boot){
      try{boot=await api("/api/bootstrap")}
      catch(error){showActionError(error,`${agentRuntimeName(runtime)} is selected, but its status could not refresh`)}
      if(runtimeSwitchRef.current?.id!==pending.id)return false;
    }
    const nextProvider=settings.modelProvider||boot?.provider||bootstrap.provider||DEFAULT_MODEL_PROVIDER;
    const capabilities=boot?.agentRuntime===runtime&&boot?.runtimeCapabilities?boot.runtimeCapabilities:sharedRuntimeCapabilities(runtime);
    const catalog=result?.catalog||null,catalogMatches=Boolean(catalog&&(!catalog.agentRuntime||catalog.agentRuntime===runtime)&&(!catalog.provider||catalog.provider===nextProvider));
    // Opening a thread of another harness lands on that thread's model rather than the harness default, as does a thread of this harness
    // opened while the switch ran.
    const pendingThread=pendingRuntimeThreadRef.current?.targetRuntime===runtime?pendingRuntimeThreadRef.current.thread:null;
    // A thread whose own switch a later one replaced, for another harness (one picked in Settings), cannot open on this one: its open
    // ends here instead of waiting for a reopen this transport never makes.
    if(pendingRuntimeThreadRef.current&&!pendingThread){if(openingThreadRef.current===String(pendingRuntimeThreadRef.current.thread?.id||"")){openingThreadRef.current=null;setOpening(null)}pendingRuntimeThreadRef.current=null}
    const keptThread=threadOpenedDuringSwitch(pending,runtime);
    const preferredModel=keptThread?.model||(runtime===pending.from?pending.previous.model:(pendingThread?.model||""));
    // One batch: the runtime, its bootstrap, exactly one transport reconnect and (when bundled) its catalog land together. Nothing reconnects after the catalog.
    runtimeSwitchRef.current=null;modelCatalogScopeRef.current=modelCatalogScope(runtime,nextProvider);
    // A refusal Settings keeps for this harness is over: the switch went through (SettingsPage listens).
    setRuntimeSwitch(null);runtimeAppliedSeqRef.current++;landRuntime(pending,runtime);window.dispatchEvent(new CustomEvent("trebell:runtime-switched",{detail:runtime}));
    setSettings(previous=>({...previous,agentRuntime:runtime,agentRuntimeInstanceId:instanceId}));setRuntimeKnown(true);
    if(boot)setBootstrap(boot);
    setRuntimeTransportRevision(value=>value+1);
    // The previous harness's thread never stays open under this one, even when opening another harness's thread (resetThread:false)
    // replaced a switch from Settings: its view, and a send from it, would go to that thread with this harness's model. A thread of
    // this harness opened while the switch ran stays open, and the new transport resumes it.
    if(!keptThread&&(pending.resetThread||threadOwnerElsewhere(activeThreadRef.current,threadMeta[activeThreadRef.current?.id],runtime)))resetThreadView(runtime,capabilities);
    if(catalogMatches){modelRefreshSeqRef.current++;applyModelCatalog(catalog,{preferredModel})}
    else refreshProviderModels({agentRuntime:runtime,provider:nextProvider,bootstrap:boot,refreshBootstrap:false,preferredModel}).catch(()=>{});
    return true;
  }
  async function abortRuntimeSwitch(pending){
    if(runtimeSwitchRef.current?.id!==pending.id)return;
    let boot=null;
    try{boot=await api("/api/bootstrap")}catch{}
    if(runtimeSwitchRef.current?.id!==pending.id)return;
    runtimeSwitchRef.current=null;
    setRuntimeSwitch(null);
    if(boot)setBootstrap(boot);
    const runtime=boot?.agentRuntime||pending.from;
    if(runtime===pending.from){
      // The server stayed on the previous harness: restore its catalog as it was. Its transport was never closed, so it does not reconnect.
      const previous=pending.previous;modelRefreshSeqRef.current++;modelCatalogScopeRef.current=previous.scope;
      setModels(previous.models);setModelMeta(previous.modelMeta);setModel(previous.model);setSelectedModels(previous.selectedModels);setModelError(previous.modelError);
      return;
    }
    // The server moved before the error surfaced: follow it so the transport and the catalog match what actually runs. The new agentRuntime
    // (with the bootstrap set above) reconnects the transport once through the transport effect.
    const nextProvider=settings.modelProvider||boot?.provider||bootstrap.provider||DEFAULT_MODEL_PROVIDER;
    modelCatalogScopeRef.current=modelCatalogScope(runtime,nextProvider);runtimeAppliedSeqRef.current++;landRuntime(pending,runtime);
    setSettings(previous=>({...previous,agentRuntime:runtime,agentRuntimeInstanceId:boot?.agentRuntimeInstanceId||`${runtime}-default`}));setRuntimeKnown(true);
    const keptThread=threadOpenedDuringSwitch(pending,runtime);
    if(!keptThread&&(pending.resetThread||threadOwnerElsewhere(activeThreadRef.current,threadMeta[activeThreadRef.current?.id],runtime)))resetThreadView(runtime,boot?.runtimeCapabilities||sharedRuntimeCapabilities(runtime));
    refreshProviderModels({agentRuntime:runtime,provider:nextProvider,bootstrap:boot,refreshBootstrap:false,...(keptThread?.model?{preferredModel:keptThread.model}:{})}).catch(()=>{});
  }
  // The harness a switch landed the app on, and the switch: agentRuntimeRef has it only once the app renders it, so rendered is what
  // agentRuntimeRef had then. runningAgentRuntime is the harness the app runs, rendered or not.
  function landRuntime(pending,runtime){runtimeLandedRef.current={id:pending.id,runtime,rendered:agentRuntimeRef.current}}
  function runningAgentRuntime(){const landed=runtimeLandedRef.current;return landed&&landed.rendered===agentRuntimeRef.current?landed.runtime:agentRuntimeRef.current}
  // perform() runs the server request that switches (or reloads) the active harness. gate:false leaves sends ungated while it runs and only
  // applies its result (e.g. after an install). Either way the transport reconnects once, in completeRuntimeSwitch. The server takes these
  // requests one at a time in the order asked: one asked while another is on its way waits for that one's answer, so the harness the
  // server ends on is the last one asked for, which is the one the app applies.
  // A reload (gate:false) is for the harness it names, and its answer can hold the harness list from before a switch. It decides once
  // every switch asked so far has settled (landed, refused or replaced), and applies only when that harness is the one the app then runs
  // and no switch asked after it has landed (that one reconnected). A switch that lands meanwhile, from Settings or by opening another
  // harness's thread, keeps its transport and open thread; a switch refused leaves the harness to reload in use, and it reloads.
  async function switchAgentRuntime(target={},perform,{gate=true}={}){
    const askedAt=runtimeSwitchSeqRef.current;
    let pending=gate?beginRuntimeSwitch(target):null;
    const request=runtimeRequestRef.current.then(()=>perform());runtimeRequestRef.current=request.catch(()=>{});
    const settled=(async()=>{
      let result;
      try{result=await request}
      catch(error){if(pending)await abortRuntimeSwitch(pending);throw error}
      if(!pending){
        for(let all=null;all!==runtimeSettledRef.current;)await (all=runtimeSettledRef.current);
        const runtime=String(result?.selectedRuntime||target.runtime||"");
        if(runtime!==String(target.runtime||runtime)||runningAgentRuntime()!==runtime||(runtimeLandedRef.current?.id||0)>askedAt)return result;
        pending=beginRuntimeSwitch(target);
      }
      await completeRuntimeSwitch(pending,result);
      return result;
    })();
    if(gate)runtimeSettledRef.current=Promise.all([runtimeSettledRef.current,settled.catch(()=>{})]);
    return settled;
  }
  useEffect(()=>{
    if(!initialLoaded||section!=="chat"||!providerReady||models.length||runtimeSwitchRef.current||modelsLoadingRef.current)return;
    refreshProviderModels().catch(()=>{});
  },[initialLoaded,section,providerReady,provider,agentRuntime,models.length]);
  // owns: for a thread's open, whether it still owns the view when the project answers (a later open's project wins).
  async function touchProject(path,environmentId=undefined,{activate=true,owns=null}={}){
    if(!path)return null;
    const previousProjectPath=projectPath;
    const previousEnvironmentId=currentProject?.environmentId??settings.activeEnvironmentId??null;
    const resolvedEnvironmentId=environmentId===undefined
      ?(activeThreadRef.current?.providerMeta?.environmentId??settings.activeEnvironmentId??null)
      :(environmentId||null);
    const response=await api("/api/projects",{method:"POST",body:{path,environmentId:resolvedEnvironmentId,activate}});
    const project=response?.project||null;
    if(!project)throw new Error("Project activation did not return a project.");
    setProjectRecords(previous=>[project,...previous.filter(item=>item.id!==project.id)]);
    if(owns&&!owns())return project;
    if(String(previousProjectPath||"")!==String(path||"")||String(previousEnvironmentId||"")!==String(resolvedEnvironmentId||""))setGitInfo(null);
    projectChoiceSeqRef.current++;setProjectlessMode(false);setGeneralEnvironmentId(null);setProjectPath(path);
    setCurrentProject(project);
    if(project&&activate)setSettings(prev=>({...prev,activeProjectId:project.id}));
    const scoped=project?.effectiveSettings||{};
    // The latest committed catalog, not this render's: opening a project in another environment reloads the catalog while this request runs.
    if(scoped.defaultModel&&modelsRef.current.includes(scoped.defaultModel)){setModel(scoped.defaultModel);setSelectedModels([scoped.defaultModel])}
    if(scoped.defaultPermissionMode)setPermissionMode(scoped.defaultPermissionMode);
    if(scoped.defaultWorkspaceMode)setWorkspaceMode(scoped.defaultWorkspaceMode);
    if(scoped.autoPull&&(!project?.cloneJob||project.cloneJob.status==="completed"))api("/api/git/action",{method:"POST",body:{action:"auto-pull",cwd:path,environmentId:resolvedEnvironmentId}}).catch(error=>showActionError(error,"Could not automatically pull project"));
    return project;
  }
  async function refreshCloneJob(id=currentProject?.cloneJob?.id){
    if(!id)return null;
    const result=await api("/api/clone-jobs?id="+encodeURIComponent(id));
    setCloneRefreshError("");
    if(result.project?.id===currentProject?.id||result.project?.path===projectPath)setCurrentProject(result.project);
    if(result.job?.status==="completed"&&result.project?.path){
      api("/api/git/info?path="+encodeURIComponent(result.project.path)+"&environmentId="+encodeURIComponent(result.project.environmentId||""))
        .then(setGitInfo)
        .catch(error=>showActionError(error,"Clone completed, but Git metadata could not refresh"));
    }
    return result;
  }
  async function cloneProjectAction(action){
    const id=currentProject?.cloneJob?.id;if(!id)return null;
    const result=await api("/api/clone-jobs",{method:"POST",body:{action,id}});
    setCloneRefreshError("");
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
    setCloneRefreshError("");
    const poll=startVisibilityPoll(()=>refreshCloneJob(job.id).catch(error=>setCloneRefreshError("Could not refresh clone progress: "+(error?.message||String(error)))),{intervalMs:750});
    return()=>poll.dispose();
  },[currentProject?.cloneJob?.id,currentProject?.cloneJob?.status,projectPath]);
  async function refreshEnvironmentThemes({strict=false}={}){
    try{
      const catalog=await api("/api/environment/themes");
      setEnvironmentThemeCatalog(catalog);
      return catalog;
    }catch(error){
      if(strict)throw error;
      return environmentThemeCatalog;
    }
  }

  // The model Trebell's first load lands on: the open thread's (one opened while its harness still listed its models), else the open
  // project's default, else the catalog's own.
  const startupModelChoice=useLatestCallback((ids,catalogDefault)=>{
    const thread=activeThreadRef.current;
    const threadModel=!thread?null:agentRuntime==="codex"?(codexThreadState?.threadId===thread.id?codexThreadState.model:null):thread.model;
    return [threadModel,currentProject?.effectiveSettings?.defaultModel,catalogDefault].find(id=>id&&ids.includes(id))||ids[0]||"";
  });
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      const switchSeqAtStart=runtimeSwitchSeqRef.current,appliedSeqAtStart=runtimeAppliedSeqRef.current,modelSeqAtStart=modelRefreshSeqRef.current,projectChoiceAtStart=projectChoiceSeqRef.current;
      // The startup catalog is this load's to show while no harness switch or other model refresh has begun since it was asked for.
      const ownsModels=()=>runtimeSwitchSeqRef.current===switchSeqAtStart&&modelRefreshSeqRef.current===modelSeqAtStart;
      const settleModels=()=>{if(ownsModels()){modelsLoadingRef.current=false;setModelsLoading(false)}};
      // A harness can take seconds to list its models (Cursor took 8 s live), so the first load does not wait for them: the harness that runs,
      // its threads and the project show once Trebell's own state is read, and the catalog lands when the harness answers. Waiting for it
      // left the default harness described meanwhile, and Settings offering to switch to the harness that already runs.
      modelsLoadingRef.current=true;setModelsLoading(true);
      const modelPromise=api("/api/models").then(value=>value||{models:[]},error=>({models:[],error:error?.message||String(error)}));
      const extrasPromise=Promise.allSettled([api("/api/environment/themes"),api("/api/projects")]);
      let boot,state;const settingsSentAt=settingsSavesRef.current.count;
      try{[boot,state]=await Promise.all([api("/api/bootstrap"),api("/api/state")])}
      catch(error){
        if(!cancelled){settleModels();setInitialLoadError(error?.message||String(error)||"Trebell startup failed.");setInitialLoaded(true)}
        return;
      }
      const [themeResult,projectResult]=await extrasPromise;
      const themeCatalog=themeResult.status==="fulfilled"?themeResult.value:environmentThemeCatalog;
      const projectData=projectResult.status==="fulfilled"?projectResult.value:{projects:state.projects||[]};
      if(cancelled)return;
      // A harness switch begun while Trebell was starting owns the runtime: the startup bootstrap, runtime and model catalog describe the
      // harness it replaces. A switch still pending applies its own when it lands; one that has landed already applied them.
      const startup=startupRuntimeOutcome({switchSeqAtStart,switchSeq:runtimeSwitchSeqRef.current,appliedSeqAtStart,appliedSeq:runtimeAppliedSeqRef.current});
      const activeEnvironmentId=state.settings?.activeEnvironmentId||null;
      // A project removed while Trebell was starting stays removed: the lists this load read were read before it went.
      const listedProjects=(projectData.projects||state.projects||[]).filter(project=>!removedProjectIdsRef.current.has(project.id));
      const projectsForEnvironment=listedProjects.filter(project=>(project.environmentId||null)===activeEnvironmentId);
      const activeProject=projectsForEnvironment.find(project=>project.id===state.settings?.activeProjectId)||null;
      const firstProject=projectsForEnvironment[0]||null;
      const environmentCwd=boot.activeEnvironment?.cwd||"";
      const initialProject=activeProject||(environmentCwd?projectsForEnvironment.find(project=>String(project.path)===String(environmentCwd)):null)||firstProject;
      const initialPath=initialProject?.path||environmentCwd||(!activeEnvironmentId?boot.cwd:"")||"";
      const initialScoped=initialProject?.effectiveSettings||{};
      // One synchronous commit, so the catalog that lands later is checked against the harness and provider this load shows.
      flushSync(()=>{
        setBootstrap(previous=>startup.keepLandedRuntime&&previous?.agentRuntime?previous:boot);
        const startupSettings=settingsRead(state.settings,settingsSentAt);
        // The startup catalog belongs to the runtime these settings resolve to: record its scope so the scope effect keeps it instead of loading it twice.
        setSettings(prev=>{const next=startupSettings(prev);if(startup.keepLandedRuntime){next.agentRuntime=prev.agentRuntime;next.agentRuntimeInstanceId=prev.agentRuntimeInstanceId}const runtime=next.agentRuntime||boot.agentRuntime||"codex";if(startup.applyCatalog)modelCatalogScopeRef.current=modelCatalogScope(runtime,next.modelProvider||boot.provider||DEFAULT_MODEL_PROVIDER);return next}); setRuntimeKnown(true); setThreadMeta(state.threadMeta||{});setThreads(threadsFromCatalogMeta(state.threadMeta||{}));setThreadCatalogCursor(state.threadMetaNextCursor||null);
        setEnvironmentThemeCatalog(themeCatalog);
        setProjectRecords(listedProjects);
        // A project the person opened (or a General chat they started) while Trebell was starting stays: the state this load read
        // names the project open before it, and replaced theirs once it landed.
        if(projectChoiceSeqRef.current!==projectChoiceAtStart)return;
        setCurrentProject(initialProject);setProjectPath(initialPath);
        if(!pickedModesRef.current.permission)setPermissionMode(initialProject?.permissionMode||initialScoped.defaultPermissionMode||state.settings?.defaultPermissionMode||"supervised");
        if(!pickedModesRef.current.workspace)setWorkspaceMode(initialProject?.workspaceMode||initialScoped.defaultWorkspaceMode||state.settings?.defaultWorkspaceMode||"current");
      });
      const partialErrors=[];
      if(window.trebellDesktop?.background&&state.settings?.backgroundMode!=null){
        try{await window.trebellDesktop.background.set(Boolean(state.settings.backgroundMode))}
        catch(error){partialErrors.push("desktop background mode: "+(error?.message||String(error)))}
      }
      if(themeResult.status==="rejected")partialErrors.push("themes: "+(themeResult.reason?.message||String(themeResult.reason)));
      if(projectResult.status==="rejected")partialErrors.push("projects: "+(projectResult.reason?.message||String(projectResult.reason)));
      if(partialErrors.length)showActionError(new Error(partialErrors.join(" · ")),"Started with partial data");
      const modelData=await modelPromise;
      if(cancelled)return;
      if(ownsModels()){
        // A catalog of another harness or provider (another window switched meanwhile) is not shown: the model refresh loads this one's.
        if((!modelData.agentRuntime||modelData.agentRuntime===agentRuntimeRef.current)&&(!modelData.provider||modelData.provider===providerRef.current)){
          const availableModels=modelData.models||[];
          const fallback=availableModels.length?availableModels:(boot.mock?["test/coding-fast","test/coding-large"]:[]);
          const initialModel=startupModelChoice(fallback,modelData.defaultModel);
          setModelError(modelData.error||"");setModelMeta(Object.fromEntries((modelData.metadata?.models||[]).map(item=>[item.id,item])));
          setModels(fallback);setModel(initialModel);setSelectedModels(initialModel?[initialModel]:[]);
        }
        settleModels();
      }
      setInitialLoadError("");setInitialLoaded(true);
    })().catch(error=>{if(!cancelled){setInitialLoadError(error?.message||String(error)||"Trebell startup failed.");setInitialLoaded(true)}}); return()=>{cancelled=true};
  },[initialLoadRevision]);

  async function ensureSections(client){
    if(agentRuntime!=="codex"){
      const local=Object.fromEntries(["Pinned","Snoozed","Settled"].map(name=>[name,{id:name,name}]));setSections(local);return local;
    }
    let listed;
    try{listed=await client.request("threadSection/list",{limit:50})}
    catch(error){showActionError(error,"Could not refresh thread sections");return sections}
    const map=Object.fromEntries((listed.data||[]).map(s=>[s.name,s]));
    const creationErrors=[];
    for(const name of ["Pinned","Snoozed","Settled"]){
      if(map[name])continue;
      try{const made=await client.request("threadSection/create",{name});if(made?.section)map[name]=made.section}
      catch(error){creationErrors.push(name+": "+(error?.message||String(error)))}
    }
    setSections(map);
    if(creationErrors.length)showActionError(new Error(creationErrors.join(" · ")),"Some thread sections could not be prepared");
    return map;
  }
  function rememberThreadCatalog(items,runtimeOwner=agentRuntime,providerOwner=provider){
    const updates=[];
    for(const thread of items||[]){
      if(!thread?.id)continue;
      const patch=catalogMetaPatch(thread,{runtime:runtimeOwner,provider:providerOwner,runtimeInstanceId:thread.runtimeInstanceId||thread.providerMeta?.runtimeInstanceId||null});
      if(!patch.threadSnapshot)continue;
      const current=threadMeta[thread.id]||{};
      const unchanged=sameCatalogSnapshot(current.threadSnapshot,patch.threadSnapshot)&&current.runtime===patch.runtime&&current.provider===patch.provider&&(current.runtimeInstanceId||null)===(patch.runtimeInstanceId||null);
      if(unchanged)continue;
      const fingerprint=JSON.stringify(patch);
      if(catalogPersistRef.current.get(thread.id)===fingerprint)continue;
      catalogPersistRef.current.set(thread.id,fingerprint);updates.push({threadId:String(thread.id),patch,fingerprint});
    }
    if(!updates.length)return;
    setThreadMeta(previous=>{
      const next={...previous};
      for(const update of updates)next[update.threadId]={...(next[update.threadId]||{}),...update.patch};
      return next;
    });
    void (async()=>{
      for(const update of updates){
        try{
          const saved=await api("/api/thread-meta",{method:"POST",body:{threadId:update.threadId,patch:update.patch}});
          setThreadMeta(previous=>({...previous,[update.threadId]:{...(previous[update.threadId]||{}),...saved}}));
        }catch{
          if(catalogPersistRef.current.get(update.threadId)===update.fingerprint)catalogPersistRef.current.delete(update.threadId);
        }
      }
    })();
  }
  // The Codex sections a person has ordered in Trebell (settings.orderedThreadSections), shown in Codex's own order; a ref, so a list
  // load an older render started reads the newest.
  const orderedSectionsRef=useRef([]);orderedSectionsRef.current=Array.isArray(settings.orderedThreadSections)?settings.orderedThreadSections.map(String):[];
  // The moves a person made that are queued or being written (moveThreadOrder): pending, made in all, and the epoch a failed move ends.
  const threadMovesRef=useRef({tail:Promise.resolve(),pending:0,made:0,epoch:0});
  // Each thread's meta, also a ref: a list load that an older render started (an Undo's, made in the render of its action) merges with
  // the newest, so a thread archived since that render, one whose Undo the harness refused, stays out of the list.
  const threadMetaRef=useRef(threadMeta);threadMetaRef.current=threadMeta;
  async function loadThreads(client,{strict=false}={}){
    const moves=threadMovesRef.current,madeBefore=moves.made;
    try{
      if(!client)throw new Error("Agent harness is not connected");
      const listed=await client.request("thread/list",threadListParams(100));
      // Each thread's place in its section (thread-list-query.js); a place from an earlier listing is dropped, so only this listing's
      // places are compared. A section whose order could not be read still lists its threads (the list did load): its threads say why
      // they cannot move.
      const {threads:ranked}=await rankThreadSections(client,listed.data||[],{orderedSections:orderedSectionsRef.current});rememberThreadCatalog(ranked);
      // A listing read while moves were queued, or before one was made, may not have them yet: its threads keep the places on screen.
      const keep=moves.pending>0||moves.made!==madeBefore;
      setThreads(previous=>{
        const shown=keep?new Map(previous.filter(thread=>Number.isFinite(thread?.sectionRank)).map(thread=>[String(thread.id),thread])):null;
        const incoming=shown?ranked.map(thread=>{const local=shown.get(String(thread.id));return local&&(local.section?.id||null)===(thread.section?.id||null)?{...thread,sectionRank:local.sectionRank,sectionPlaced:local.sectionPlaced,sectionOrderError:null}:thread}):ranked;
        return mergeThreadCatalog(previous.map(thread=>thread?.sectionRank==null&&!thread?.sectionOrderError?thread:{...thread,sectionRank:null,sectionOrderError:null}),incoming,{runtime:agentRuntime,provider,threadMeta:threadMetaRef.current});
      });
      setThreadListError("");setThreadListLoaded(true);setThreadTurnStates(previous=>settleTurnStates(previous,ranked));
      return mergeThreadCatalog([],ranked,{runtime:agentRuntime,provider});
    }catch(error){
      setThreadListError(error?.message||String(error)||"Unknown error");
      if(strict)throw error;
      return null;
    }
  }
  // The threads whose updates this window follows besides the one shown: those whose turn it saw start and not end, its background
  // tasks and its sends still on their way.
  function followedThreadIds(){
    const ids=new Set([...backgroundThreadsRef.current].map(String));
    for(const [id,runs] of Object.entries(threadTurnStatesRef.current||{}))if(runs)ids.add(id);
    for(const id of pendingSendsRef.current.keys())ids.add(String(id));
    return ids;
  }
  // Resumes those threads (all but the one shown, which its reopen resumed) on a new transport, and takes the status each has now.
  async function resumeFollowedThreads(client,ids){
    const shown=String(activeThreadRef.current?.id||"");
    await Promise.all([...ids].filter(id=>id&&id!==shown).map(async id=>{
      const resumed=await client.request("thread/resume",{threadId:id,excludeTurns:true}).catch(()=>null);
      if(!resumed?.thread||client!==rpcRef.current)return;
      markThreadTurn(id,resumed.thread.status?.type==="active"||pendingSendsRef.current.has(id));
      if(resumed.thread.status)setThreads(prev=>prev.map(thread=>thread.id===id?{...thread,status:resumed.thread.status}:thread));
    }));
  }
  function markThreadTurn(threadId,running){
    const id=String(threadId||"");if(!id)return;
    setThreadTurnStates(previous=>previous[id]===Boolean(running)?previous:{...previous,[id]:Boolean(running)});
  }
  // A turn/start reply can carry a turn that already ended (a harness that answers after the run); that one is not running.
  function turnStillRuns(turn){const status=String(turn?.status||"");return !status||status==="inProgress"||status==="running"}
  useEffect(()=>{
    // A Retry still reading when History is left ends there: History shown again starts over.
    if(section!=="history"){setThreadHistory(current=>current.retrying?{...current,retrying:false}:current);return}
    let cancelled=false;
    if(!rpc||rpcStatus!=="connected"){
      setThreadHistory(current=>({...current,runtime:"all",items:threads,nextCursor:null,loading:false,retrying:false,error:"",olderError:""}));
      return;
    }
    // The source is the runtime in the environment active (historySource): every environment's Codex has the one address.
    const sourceKey=historySource();
    // A first page that failed says so with Retry (retrying): its failure stays until the list answers, so the keyboard stays on
    // Retry, and one that fails again says it still could not, as a new message (failures keys it). Retry takes only a press of its
    // own (ignorePressRest): the repeats of Enter held on it asked again after each failure. While it is read, Load older threads
    // goes on reading this source's next page, which each source keeps (runtimePages) while History reads another's.
    setThreadHistory(current=>({...current,runtime:"all",items:mergeThreadCatalog(current.items?.length?current.items:threads,[],{threadMeta}),nextCursor:current.runtimePages?.[sourceKey]?.nextCursor||null,loading:true,error:current.retrying?current.error:"",olderError:""}));
    rpc.request("thread/list",threadListParams(100)).then(result=>{
      if(cancelled)return;
      const incoming=result?.data||[];rememberThreadCatalog(incoming);
      setThreads(previous=>mergeThreadCatalog(previous,incoming,{runtime:agentRuntime,provider,threadMeta}));
      setThreadListError("");setThreadListLoaded(true);setThreadTurnStates(previous=>settleTurnStates(previous,incoming));
      // Only older pages read to their end (Load older threads) mark every page of the source read. A first page with no next page
      // does not: a runtime that listed few threads, or none while it started, may list more than a page later in the session.
      // Older pages read (olderRead) keep the next page after them: the first page's own next page is shown already.
      setThreadHistory(current=>{
        const kept=current.runtimePages?.[sourceKey]||{},listed=result?.nextCursor||null,olderRead=Boolean(kept.olderRead&&kept.nextCursor&&listed),nextCursor=kept.exhausted?null:olderRead?kept.nextCursor:listed;
        return {...current,runtime:"all",runtimePages:{...current.runtimePages,[sourceKey]:{...kept,olderRead,nextCursor}},items:mergeThreadCatalog(current.items,incoming,{runtime:agentRuntime,provider,threadMeta}),nextCursor,loading:false,retrying:false,error:""};
      });
    }).catch(error=>{
      if(cancelled)return;
      setThreadHistory(current=>({...current,runtime:"all",items:current.items?.length?current.items:threads,loading:false,retrying:false,error:error?.message||String(error),failures:current.error?(current.failures||1)+1:1}));
    });
    return()=>{cancelled=true};
  },[section,rpc,rpcStatus,agentRuntime,provider,threadHistory.retries]);
  useEffect(()=>{
    if(section!=="history")return;
    setThreadHistory(current=>({...current,runtime:"all",items:mergeThreadCatalog(current.items,threads,{threadMeta})}));
  },[section,threads,threadMeta]);
  // What History's pages are read from: the runtime, its instance and its address, in the environment active, whose own catalog
  // answers there (the GUI server starts the catalog's harness again for an environment switched to). A next page kept from another
  // environment went to this one's runtime, which refused it or read from wherever it fell in its own list. Each source keeps its own
  // (runtimePages), so back in an environment Load older threads goes on after the pages of it shown.
  function historySource(){return [agentRuntime,settings.agentRuntimeInstanceId||"",bootstrap.wsUrl||"",settings.activeEnvironmentId||""].join("\0")}
  // An older page's read has a state of its own (loadingOlder), which its button says: the first page read again (loading) neither
  // makes the button say older threads are loading nor refuses its press, and the first page's failure stays. The button keeps the
  // keyboard, so it takes only a press of its own (ignorePressRest): the repeats of Enter held on it read every page after.
  async function loadOlderThreadHistory(){
    const runtimeCursor=threadHistory.nextCursor,catalogCursor=threadCatalogCursor;if((!runtimeCursor&&!catalogCursor)||threadHistory.loadingOlder)return;
    setThreadHistory(current=>({...current,loadingOlder:true}));
    // A press while the transport is not connected asks the runtime for nothing, so it reads no page and marks none read: it says why,
    // and the next page stays for a press once the transport is back. (A read the transport took with it as it closed, for a project
    // opened in another environment from the palette over History, puts its button back while the new transport connects; a press
    // there counted as reading the last page of the environment switched to, which then never offered its older threads again.)
    const asked=Boolean(runtimeCursor&&rpc&&rpcStatus==="connected");
    const nativeRequest=asked?rpc.request("thread/list",{...threadListParams(100),cursor:runtimeCursor}):runtimeCursor?Promise.reject(new Error(agentRuntimeName(agentRuntime)+" is not connected")):Promise.resolve(null);
    const catalogRequest=catalogCursor?api("/api/thread-meta?"+new URLSearchParams({view:"catalog",limit:"100",cursor:catalogCursor})):Promise.resolve(null);
    const [nativeResult,catalogResult]=await Promise.allSettled([nativeRequest,catalogRequest]);
    const errors=[];let nativePage=null,catalogPage=null;
    if(nativeResult.status==="fulfilled")nativePage=nativeResult.value;else errors.push("runtime history: "+(nativeResult.reason?.message||String(nativeResult.reason)));
    if(catalogResult.status==="fulfilled")catalogPage=catalogResult.value;else errors.push("Trebell catalog: "+(catalogResult.reason?.message||String(catalogResult.reason)));
    const incoming=nativePage?.data||[],catalogMeta=catalogPage?.threadMeta||{},catalogThreads=threadsFromCatalogMeta(catalogMeta),mergedMeta={...threadMeta,...catalogMeta};
    if(incoming.length)rememberThreadCatalog(incoming);
    if(Object.keys(catalogMeta).length)setThreadMeta(previous=>({...previous,...catalogMeta}));
    if(incoming.length||catalogThreads.length)setThreads(previous=>mergeThreadCatalog(previous,[...incoming,...catalogThreads],{runtime:agentRuntime,provider,threadMeta:mergedMeta}));
    if(catalogCursor&&catalogResult.status==="fulfilled")setThreadCatalogCursor(catalogPage?.nextCursor||null);
    // A next page the runtime refused (its answer an error: the thread it starts from archived since) is not kept past the next first
    // page, whose own next page History then reads; one it did not answer (a timeout, a connection lost) is still good, and stays. One
    // it was not asked for leaves the source's pages as they were.
    const sourceKey=historySource(),refused=Boolean(asked&&nativeResult.status==="rejected"&&nativeResult.reason?.trebellRpcResponse),read=Boolean(asked&&nativeResult.status==="fulfilled");
    const nextCursor=read?(nativePage?.nextCursor||null):runtimeCursor,pages=kept=>({exhausted:read?!nextCursor:Boolean(kept?.exhausted),olderRead:!refused&&(read||Boolean(kept?.olderRead)),nextCursor});
    setThreadHistory(current=>({
      ...current,
      runtime:"all",
      runtimePages:asked?{...current.runtimePages,[sourceKey]:pages(current.runtimePages?.[sourceKey])}:current.runtimePages,
      items:mergeThreadCatalog(current.items,[...incoming,...catalogThreads],{runtime:agentRuntime,provider,threadMeta:mergedMeta}),
      nextCursor:runtimeCursor?nextCursor:current.nextCursor,
      loadingOlder:false,
      olderError:errors.join(" · "),
    }));
  }
  async function loadCollaborationModes(client=rpcRef.current){
    if(!runtimeCapabilities.collaborationModes||!client){
      setCollaborationModes([]);setCollaborationMode("default");return[];
    }
    let result;
    try{result=await client.request("collaborationMode/list",{})}
    catch(error){showActionError(error,"Could not refresh collaboration modes");return null}
    const modes=normalizeCollaborationModes(result?.data||[]);
    setCollaborationModes(modes);
    setCollaborationMode(current=>modes.some(item=>item.mode===current)?current:(modes.some(item=>item.mode==="default")?"default":modes[0]?.mode||"default"));
    return modes;
  }
  function selectedCollaborationMode(modelId=model,{effort=null}={}){
    return runtimeCapabilities.collaborationModes?collaborationModePayload(collaborationModes,collaborationMode,modelId,{effort}):null;
  }
  // The effort and tier a Codex turn on this thread sends for the model (codex-turn-options.js).
  function codexChoicesFor(modelId=model,threadId=activeThreadRef.current?.id){
    const custom=(settings.customModels||[]).find(item=>item.id===modelId&&item.runtime==="codex")||null;
    return codexModelChoices({settings,provider,model:modelId,metadata:modelMeta?.[modelId]||{},custom,thread:threadId&&codexThreadState?.threadId===threadId?codexThreadState:null});
  }
  // A Codex thread is resumed without a model, so it keeps the model, effort and tier it runs with (T3 Code), and the
  // composer moves to that model.
  function applyCodexThreadSettings(threadId,resumed){
    const next=codexThreadSettings(threadId,resumed||{});setCodexThreadState(next);
    if(next&&modelsRef.current.includes(next.model)){setModel(next.model);setSelectedModels([next.model])}
  }
  // A pick for the model the open, idle Codex thread runs changes the thread's own setting too (thread/settings/update), but not while
  // another thread opens under a header that names it (see leavingThread).
  async function updateCodexThreadSetting(patch){
    const threadId=activeThreadRef.current?.id;
    if(agentRuntime!=="codex"||!threadId||!rpc||rpcStatus!=="connected"||running||leavingThread()||codexThreadState?.threadId!==threadId||codexThreadState.model!==model)return;
    const params={threadId};
    if(Object.prototype.hasOwnProperty.call(patch,"effort")){
      if(patch.effort)params.effort=patch.effort;
      const collaboration=selectedCollaborationMode(model,{effort:patch.effort||null});if(collaboration)params.collaborationMode=collaboration;
    }
    if(patch.serviceTier)params.serviceTier=patch.serviceTier;
    if(Object.keys(params).length===1)return;
    try{
      await rpc.request("thread/settings/update",params);
      setCodexThreadState(current=>current?.threadId===threadId?{...current,...(Object.prototype.hasOwnProperty.call(patch,"effort")?{effort:patch.effort||null}:{}),...(patch.serviceTier?{serviceTier:patch.serviceTier}:{})}:current);
    }catch(error){setEvents(prev=>[...prev,{id:"codex-settings-error-"+Date.now(),kind:"error",title:"Could not change this thread's Codex settings: "+(error.message||String(error)),status:"done",raw:{}}])}
  }
  async function changeCollaborationMode(nextMode){
    if(!collaborationModes.some(item=>item.mode===nextMode)||leavingThread())return;
    const previous=collaborationMode;setCollaborationMode(nextMode);
    if(!runtimeCapabilities.collaborationModes||!rpc||rpcStatus!=="connected"||!activeThread?.id||running)return;
    // Codex's collaboration mode carries the reasoning effort, so a mode change keeps the chosen effort.
    const payload=collaborationModePayload(collaborationModes,nextMode,model,{effort:agentRuntime==="codex"?codexChoicesFor(model,activeThread.id).effort:null});if(!payload)return;
    setCollaborationModeBusy(true);
    try{await rpc.request("thread/settings/update",{threadId:activeThread.id,collaborationMode:payload})}
    catch(error){
      setCollaborationMode(previous);
      setEvents(prev=>[...prev,{id:"collaboration-mode-error-"+Date.now(),kind:"error",title:`Could not change ${agentRuntimeLabel} mode: `+(error.message||String(error)),status:"done",raw:{}}]);
    }finally{setCollaborationModeBusy(false)}
  }
  async function loadThreadRuntimeProfiles(client=rpc,threadId=activeThreadRef.current?.id){
    if(!runtimeCapabilities.runtimeProfileSwitching||!client||rpcStatus!=="connected"||client?.isConnected?.()===false||!threadId){
      setThreadRuntimeProfiles({threadId:null,supported:false,currentInstanceId:null,items:[]});return {threadId:null,supported:false,currentInstanceId:null,items:[]};
    }
    try{
      const result=await client.request("thread/runtimeInstances/list",{threadId});
      if(client!==rpcRef.current)return null;
      const next={...(result||{supported:false,currentInstanceId:null,items:[]}),threadId};
      setThreadRuntimeProfiles(next);return next;
    }catch(error){
      if(client!==rpcRef.current||rpcStatus!=="connected"||client?.isConnected?.()===false)return null;
      const detail=error?.message||String(error);
      setThreadRuntimeProfiles(current=>current.threadId===threadId?current:{threadId,supported:false,currentInstanceId:null,items:[],reason:detail});
      showActionError(error,"Could not refresh runtime profiles");
      return null;
    }
  }
  async function switchThreadRuntimeProfile(instanceId){
    const threadId=activeThreadRef.current?.id;if(!runtimeCapabilities.runtimeProfileSwitching||!rpc||rpcStatus!=="connected"||!threadId||!instanceId||leavingThread())return false;
    setThreadRuntimeProfileBusy(instanceId);
    try{
      const result=await rpc.request("thread/runtimeInstance/set",{threadId,instanceId});
      let updated=result?.thread;
      if(agentRuntime==="codex"){
        const resumed=await rpc.request("thread/resume",{threadId,cwd:activeThreadRef.current?.cwd||null,excludeTurns:true});
        updated=resumed?.thread||updated;applyCodexThreadSettings(threadId,resumed);
      }
      if(updated){
        activeThreadRef.current=updated;
        setActiveThread(prev=>prev?.id===updated.id?updated:prev);
        setThreads(prev=>prev.map(thread=>thread.id===updated.id?{...thread,...updated}:thread));
      }
      const profiles=await loadThreadRuntimeProfiles(rpc,threadId);
      if(agentRuntime==="codex"){
        try{await loadSkills(rpc,projectPath,true,{strict:true})}
        catch(error){showActionError(error,"Profile switched, but skills could not refresh")}
      }
      const selected=(profiles?.items||[]).find(item=>item.id===instanceId);
      const label=agentRuntime==="codex"?"Codex":"Claude";
      setEvents(prev=>[...prev,{id:"runtime-profile-"+Date.now(),kind:"tool",title:`${label} profile switched to ${selected?.displayName||instanceId}`,status:"done",raw:{instanceId}}]);
      return true;
    }catch(error){
      const label=agentRuntime==="codex"?"Codex":"Claude";
      setEvents(prev=>[...prev,{id:"runtime-profile-error-"+Date.now(),kind:"error",title:`Could not switch ${label} profile: `+(error.message||String(error)),status:"done",raw:{instanceId}}]);
      showActionError(error,`Could not switch ${label} profile`);
      return false;
    }finally{setThreadRuntimeProfileBusy("")}
  }
  async function searchThreadMessages(queryText){
    const needle=String(queryText||"").trim();if(needle.length<2||!rpc||rpcStatus!=="connected")return{matches:[],warning:""};
    const candidates=threads.slice(0,50);const cache=threadMessageSearchCacheRef.current;let cursor=0;
    const results=[];const matched=new Set();let nativeError=null;const readErrors=[];
    for(const thread of candidates){
      const excerpt=matchingPullRequestExcerpt(threadMeta[thread.id]||{},needle);
      if(excerpt){results.push({threadId:thread.id,excerpt:"PR · "+excerpt,thread});matched.add(thread.id)}
    }
    if(runtimeCapabilities.threadSearch){
      try{
        const response=await rpc.request("thread/search",{searchTerm:needle,limit:50,sortKey:"recency_at",sortDirection:"desc",archived:false});
        if(response?.data){
          const native=nativeThreadSearchMatches(response);
          const merged=new Map(results.map(item=>[item.threadId,item]));
          for(const item of native)if(!merged.has(item.threadId))merged.set(item.threadId,item);
          if(native.length)setThreads(prev=>{
            const known=new Set(prev.map(thread=>thread.id));
            const extra=native.map(item=>item.thread).filter(thread=>thread?.id&&!known.has(thread.id));
            return extra.length?[...prev,...extra]:prev;
          });
          return{matches:[...merged.values()],warning:""};
        }
      }catch(error){nativeError=error}
    }
    const searchable=candidates.filter(thread=>!matched.has(thread.id));
    const workers=Array.from({length:Math.min(8,searchable.length)},async()=>{
      while(cursor<searchable.length){
        const thread=searchable[cursor++];const version=Number(thread.updatedAt||0);let cached=cache.get(thread.id);
        if(!cached||cached.updatedAt!==version){
          try{
            const response=await rpc.request("thread/items/list",{threadId:thread.id,limit:150,sortDirection:"desc"});
            cached={updatedAt:version,items:response.data||[]};cache.set(thread.id,cached);
          }catch(error){readErrors.push(error);continue}
        }
        const excerpt=matchingMessageExcerpt(cached.items,needle);if(excerpt)results.push({threadId:thread.id,excerpt,thread});
      }
    });
    await Promise.all(workers);
    if(cache.size>100){const keep=new Set(threads.slice(0,100).map(thread=>thread.id));for(const id of cache.keys())if(!keep.has(id))cache.delete(id)}
    const warnings=[];
    if(nativeError)warnings.push("Full thread search unavailable: "+(nativeError?.message||String(nativeError))+". Searching loaded threads only.");
    if(readErrors.length)warnings.push(`${readErrors.length} loaded thread${readErrors.length===1?"":"s"} could not be searched: ${readErrors[0]?.message||String(readErrors[0])}.`);
    return{matches:results,warning:warnings.join(" ")};
  }
  async function loadSkills(client,path=projectPath,forceReload=false,{strict=false}={}){
    if(agentRuntime!=="codex")return;
    // Only the latest read lands, so an answer for a project left meanwhile (or one a newer read replaced) never overwrites it.
    const read=++skillsReadRef.current,latest=()=>read===skillsReadRef.current;
    // Another workspace's list is not this one's: it goes (from the Tools page and the composer alike) rather than stand in while
    // this one loads or after it fails. A re-read of the same workspace keeps its list until the answer replaces it.
    if(skillsPathRef.current!==(path||null)){skillsPathRef.current=path||null;setSkills([])}
    if(!path){setSkillsLoad({status:"idle",error:null});return}
    setSkillsLoad({status:"loading",error:null});
    const threadId=activeThreadRef.current?.id||null;
    const params={cwds:[path],forceReload:Boolean(forceReload),...(threadId?{_trebellThreadId:threadId}:{})};
    try{
      const result=await client.request("skills/list",params);
      const next=(result.data||[]).flatMap(x=>x.skills||[]).map(skill=>{
        const skillPath=skill?.path;if(!skillPath||!skillOverridesRef.current.has(skillPath))return skill;
        const confirmedEnabled=Boolean(skillOverridesRef.current.get(skillPath));
        if((skill.enabled!==false)===confirmedEnabled){skillOverridesRef.current.delete(skillPath);return skill}
        return {...skill,enabled:confirmedEnabled};
      });
      if(latest()){setSkills(next);setSkillsLoad({status:"loaded",error:null})}
      return next;
    }catch(error){
      if(latest())setSkillsLoad({status:"failed",error});
      if(strict)throw error;
      return null;
    }
  }
  async function refreshSkillsAfterMutation(fallback){
    if(fallback?.path){
      const enabled=Boolean(fallback.enabled);
      skillOverridesRef.current.set(fallback.path,enabled);
      setSkills(current=>current.map(skill=>skill.path===fallback.path?{...skill,enabled}:skill));
    }
    return loadSkills(rpc,projectPath,true,{strict:true});
  }
  // The turns a restart interrupted. One that may already have done what it was doing is left to the person, whom the app tells at
  // once, with no module to wait for; the others are continued by turn-support.js (continueInterruptedTurns), which a connect waits
  // for only when the server names some.
  async function recoverCodexAfterRestart(client){
    if(agentRuntime!=="codex")return;
    let recovery,support;
    try{recovery=await api("/api/recovery")}
    catch(error){showActionError(error,"Could not check restart recovery");return}
    if(!recovery?.enabled)return;
    for(const item of recovery.blocked||[]){
      const error=new Error(item.message||"Automatic restart continuation was blocked because an interrupted tool or action may already have completed. Inspect its real-world state before continuing.");
      showActionError(error,"Restart recovery needs inspection");
    }
    if(!recovery.items?.length)return;
    try{support=await loadTurnSupport()}
    catch(error){showActionError(error,"Could not check restart recovery");return}
    await support.continueInterruptedTurns({client,recovery,showActionError});
  }

  function applyProviderInventory(update={}){
    if(Array.isArray(update.commands))setProviderCommands(update.commands);
    if(Array.isArray(update.skills)){skillsPathRef.current=undefined;setSkills(update.skills.filter(skill=>skill?.enabled!==false));setSkillsLoad({status:"loaded",error:null})}
    if(Array.isArray(update.agents)){
      const visible=update.agents.filter(agent=>typeof agent==="string"||agent?.hidden!==true).filter(agent=>typeof agent==="string"?agent:Boolean(agent?.name));
      setProviderAgents(visible);
      setProviderAgent(current=>current&&visible.some(agent=>(typeof agent==="string"?agent:agent.name)===current)?current:"");
    }
  }
  notificationHandlerRef.current=handleNotification;
  serverRequestHandlerRef.current=handleServerRequest;

  useEffect(()=>{
    if(!bootstrap.wsUrl||bootstrap.mock)return;
    transportConnectedRef.current=false;
    // A pending harness switch leaves this transport open (running turns and open approvals keep it) and only gates sends. The
    // transport reconnects once, when completeRuntimeSwitch applies the runtime the server confirmed; a failed switch never touches it.
    if(bootstrap.agentRuntime&&bootstrap.agentRuntime!==agentRuntime)return;
    // A new transport has listed nothing yet: until it does, an empty sidebar waits for it rather than saying there are no threads.
    setThreadListLoaded(false);
    // established: this transport connected at least once, so later attempts back off from 500ms to 5s. refusals counts the attempts in
    // a row whose initialize the server answered with an error: it is up but cannot reach the harness (its app-server could not start).
    // The third ends the attempts and the composer says why, with Retry, instead of connecting forever. reopenRefusals counts the same
    // for the reopen of the thread shown: a harness that answers that it cannot resume the thread (a thread's own Codex app-server
    // that cannot start again) is asked twice more, then the composer says why with Retry, and the thread's turn, which ran where the
    // harness can no longer reach, no longer shows as running.
    // followed: the threads this window followed on a socket that dropped (followedThreadIds), resumed once a connect is through.
    let disposed=false,retryTimer=null,client=null,established=false,refusals=0,reopenRefusals=0,followed=null;setTransportReason("");
    const retry=attempt=>{
      clearTimeout(retryTimer);retryTimer=null;if(disposed)return;
      if(attempt>=120){setRpcStatus("error");return}
      setRpcStatus("connecting");retryTimer=setTimeout(()=>connect(attempt),established?Math.min(5000,500*2**attempt):500);
    };
    const connect=async(attempt=0)=>{
      let ready=false,refused=false,reopenRefused=null;
      const current=new CodexRpcClient(bootstrap.wsUrl,{clientVersion:bootstrap.version||"0.0.0",name:agentRuntimeName(agentRuntime),onStatus:status=>{
        // A replaced client's late close must not overwrite the status of the transport that replaced it, nor a refused one's the
        // status its refusal set (an initialize or a reopen of the thread shown that the harness refused).
        if(current!==rpcRef.current||refused||reopenRefused)return;
        setRpcStatus(status);
        if(status==="disconnected"&&ready&&!disposed){ready=false;followed=followedThreadIds();retry(0)}
      },onNotification:message=>notificationHandlerRef.current?.(message,current),onServerRequest:message=>serverRequestHandlerRef.current?.(current,message)});
      client=current;rpcRef.current=current;setRpc(current);
      try{
        await current.connect().catch(error=>{refused=Boolean(error?.trebellRpcResponse);throw error});if(disposed)return;refusals=0;
        // A reconnect replaced the socket: the open approvals, questions and app requests of the old one died with it. So does what
        // was kept of the running turns' MCP progress, diffs and replies: an end sent while the socket was down never came, and a
        // thread opened again would show a step that ended as it was then, or a reply without what it streamed meanwhile.
        dropServerRequestsExcept(current);liveExtrasRef.current.clear();liveRepliesRef.current.clear();
        await recoverCodexAfterRestart(current);await ensureSections(current);
        const listed=await loadThreads(current);
        const pending=pendingRuntimeThreadRef.current;
        if(pending&&pending.targetRuntime===agentRuntime){
          pendingRuntimeThreadRef.current=null;
          const reopen=(listed||[]).find(thread=>thread.id===pending.thread.id)||pending.thread;
          // The person asked for this thread, so a thread that cannot open says why, as a sidebar click on it does; the transport it was
          // asked on stays up instead of reconnecting as if the socket had failed.
          try{await openThread(reopen,{client:current,preserveSection:pending.preserveSection,from:pending.pageAsked?"":pending.from})}
          catch(error){if(disposed||!current.isConnected())throw error;showActionError(error,"Could not open thread")}
        }else{
          // A thread the person opens meanwhile resumes on this transport and replaces the open one: rather than reopen the thread it
          // leaves (whose answer would then undo that open), the transport waits for it, and reopens the thread shown after it unless
          // an open has resumed that thread here already (one that failed leaves the thread from before, which still needs it). An
          // open asked for while that reopen runs replaces it the same way, so the transport waits for that one too and looks again.
          for(let waited=null;;){
            if(openingThreadRef.current&&openRunRef.current!==waited){waited=openRunRef.current;await waited.done;if(disposed)return;continue}
            const activeId=activeThreadRef.current?.id,cataloged=activeId?threads.find(thread=>thread.id===activeId)||activeThreadRef.current:null;
            const reopen=activeId?((listed||[]).find(thread=>thread.id===activeId)||cataloged):null;
            const resumedHere=resumedOnRef.current?.client===current&&resumedOnRef.current.threadId===activeId;
            if(!reopen||resumedHere||threadCatalogRuntime(reopen,threadMeta[reopen.id]||{},agentRuntime)!==agentRuntime)break;
            // A reopen that fails fails this transport, which connects again and reopens the thread shown (the composer says why
            // meanwhile), as a harness still starting after a restart needs.
            const asked=openSeqRef.current+1;await openThread(reopen,{client:current,preserveSection:true}).catch(error=>{if(error?.trebellRpcResponse)reopenRefused=reopen.id;throw error});if(disposed)return;
            if(openSeqRef.current===asked){reopenRefusals=0;break}
          }
        }
        // Each Codex thread runs on an app-server of its own, which sends a thread's updates only to the connections that resumed it: the
        // threads this window followed on the socket that dropped (a turn that runs, a background task, a send on its way) are resumed on
        // this one too, so their updates come again, and one whose turn ended meanwhile reads so.
        if(followed?.size&&agentRuntime==="codex"){const ids=followed;followed=null;await resumeFollowedThreads(current,ids);if(disposed)return}
        await Promise.all([loadSkills(current,projectPath),loadCollaborationModes(current)]);
        if(disposed)return;ready=established=true;reopenRefusals=0;
        if(!current.isConnected()){ready=false;retry(0)}
      }
      catch(error){
        current.close();if(disposed)return;
        if(refused&&++refusals>=3){setTransportReason(String(error?.message||"").replace(/[.\s]+$/,""));setRpcStatus("error");return}
        if(reopenRefused&&++reopenRefusals>=3){
          setTransportReason(String(error?.message||"").replace(/[.\s]+$/,""));setRpcStatus("error");
          if(String(activeThreadRef.current?.id||"")===String(reopenRefused)){setRunning(false);setActiveTurnId(null);setStoppingThreadId(null)}
          markThreadTurn(reopenRefused,false);return;
        }
        if(!reopenRefused)reopenRefusals=0;
        retry(attempt+1);
      }
    };
    // Tearing the transport down (harness or environment switch, retry) closes its socket, and with it every request it carried.
    connect(); return()=>{disposed=true;clearTimeout(retryTimer);client?.close();dropServerRequestsExcept(null)};
  },[bootstrap.wsUrl,bootstrap.mock,bootstrap.agentRuntime,agentRuntime,runtimeTransportRevision]);
  useEffect(()=>{if(rpcStatus==="connected"&&rpc)loadSkills(rpc,projectPath)},[projectPath,rpcStatus]);
  useEffect(()=>{
    if(runtimeCapabilities.runtimeProfileSwitching&&rpcStatus==="connected"&&rpc&&rpc===rpcRef.current&&activeThread?.id){loadThreadRuntimeProfiles(rpc,activeThread.id);return}
    setThreadRuntimeProfiles({threadId:null,supported:false,currentInstanceId:null,items:[]});setThreadRuntimeProfileBusy("");
  },[agentRuntime,rpc,rpcStatus,activeThread?.id]);

  useEffect(()=>{
    if(section!=="chat")return;
    let disposed=false,busy=false;
    const poll=async()=>{
      if(disposed||busy||document.hidden)return;busy=true;
      try{
        if(projectlessMode){setGitInfo(current=>current==null?current:null);return}
        if(!projectPath)return;
        const params=new URLSearchParams({path:projectPath});if(workspaceEnvironmentId)params.set("environmentId",workspaceEnvironmentId);
        const next=await api("/api/git/info?"+params).catch(()=>null);
        if(next&&!disposed)setGitInfo(current=>sameSnapshot(current,next)?current:next);
      }finally{busy=false}
    };
    // Every 3.5 s while the window has focus (15 s for a remote workspace), every 30 s without it, and at once when it comes back.
    const gitPoll=startFocusPoll(poll,{focusedMs:workspaceRemote?15_000:3500});
    return()=>{disposed=true;gitPoll.dispose()};
  },[section,projectPath,workspaceEnvironmentId,workspaceRemote,projectlessMode]);
  useEffect(()=>{
    const shouldPoll=section==="settings"||(rightPanelOpen&&rightPanelTab==="runtime");
    if(!shouldPoll)return;
    let disposed=false,busy=false;
    const poll=async()=>{
      if(disposed||busy||document.hidden)return;busy=true;
      try{
        const [nextStats,nextRuntime]=await Promise.all([api("/api/stats").catch(()=>null),api("/api/runtime").catch(()=>null)]);
        if(nextStats&&!disposed)setStats(current=>sameSnapshot(current,nextStats)?current:nextStats);
        if(nextRuntime&&!disposed)setRuntime(current=>sameSnapshot(current,nextRuntime)?current:nextRuntime);
      }finally{busy=false}
    };
    poll();const timer=setInterval(poll,5000);
    const visible=()=>{if(!document.hidden)poll()};document.addEventListener("visibilitychange",visible);
    return()=>{disposed=true;clearInterval(timer);document.removeEventListener("visibilitychange",visible)};
  },[section,rightPanelOpen,rightPanelTab]);

  // Threads being woken: the move reads the list again, and a listing that still shows the thread snoozed (one read before the move
  // landed) arrives before its deadline is cleared, so the wake-up it starts must not move the thread a second time.
  const wakingThreadsRef=useRef(new Set());
  useEffect(()=>{
    if(!rpc||rpcStatus!=="connected")return;
    const wakeAt=nextSnoozeWakeAt(threads,threadMeta);if(wakeAt==null)return;
    let disposed=false,timer=null;
    const wake=async()=>{
      if(disposed)return;
      const remaining=wakeAt-Date.now();
      if(remaining>0){timer=setTimeout(wake,Math.min(remaining,2_000_000_000));return}
      const now=Date.now(),waking=wakingThreadsRef.current;
      try{
        for(const thread of threads){
          const meta=threadMeta[thread.id];
          if(thread.section?.name!=="Snoozed"||!(Number(meta?.snoozedUntil)>0)||Number(meta.snoozedUntil)>now||waking.has(thread.id))continue;
          waking.add(thread.id);
          try{await moveThread(thread,"active");await updateThreadMeta(thread.id,{snoozedUntil:null})}finally{waking.delete(thread.id)}
        }
      }catch(error){if(!disposed)showActionError(error,"Could not wake snoozed thread")}
    };
    wake();
    return()=>{disposed=true;if(timer!=null)clearTimeout(timer)};
  },[rpc,rpcStatus,threads,threadMeta,sections]);
  useEffect(()=>{
    if(!settings.autoSettleMergedThreads||!autoSettleCandidates||!rpc||rpcStatus!=="connected")return;
    let disposed=false,busy=false;
    const applyPending=async()=>{
      if(disposed||busy)return;busy=true;
      try{
        const pending=await api("/api/source-control/settlements");
        for(const item of pending?.items||[]){
          if(disposed)break;
          const thread=threads.find(candidate=>candidate.id===item.threadId);
          if(!thread||thread.archived||thread.status?.type==="active")continue;
          if(thread.section?.name!=="Settled")await moveThread(thread,"settle");
          await updateThreadMeta(thread.id,{autoSettlePending:null,autoSettleAppliedSignature:item.signature,autoSettledAt:Date.now()});
        }
        backgroundSyncErrorRef.current.settlements="";
      }catch(error){
        const detail=error?.message||String(error);
        if(backgroundSyncErrorRef.current.settlements!==detail){
          backgroundSyncErrorRef.current.settlements=detail;
          showActionError(error,"Could not check merged-thread settlements");
        }
      }finally{busy=false}
    };
    applyPending();const timer=setInterval(applyPending,30000);
    return()=>{disposed=true;clearInterval(timer)};
  },[settings.autoSettleMergedThreads,autoSettleCandidates,rpc,rpcStatus,threads,sections]);
  useEffect(()=>{
    const visible=section==="chat"||section==="new"||(rightPanelOpen&&rightPanelTab==="source");
    if(!visible)return;
    let disposed=false,busy=false;
    const refreshBranchReviews=async()=>{
      if(disposed||busy||document.hidden)return;busy=true;
      try{
        const data=await api("/api/source-control/branch-reviews");if(disposed||!data?.items)return;
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
        backgroundSyncErrorRef.current.branchReviews="";
      }catch(error){
        if(disposed)return;
        const detail=error?.message||String(error);
        if(backgroundSyncErrorRef.current.branchReviews!==detail){
          backgroundSyncErrorRef.current.branchReviews=detail;
          showActionError(error,"Could not refresh branch review state");
        }
      }finally{busy=false}
    };
    refreshBranchReviews();const timer=setInterval(refreshBranchReviews,30_000);
    const onVisibilityChange=()=>{if(!document.hidden)refreshBranchReviews()};
    document.addEventListener("visibilitychange",onVisibilityChange);
    return()=>{disposed=true;clearInterval(timer);document.removeEventListener("visibilitychange",onVisibilityChange)};
  },[section,rightPanelOpen,rightPanelTab]);

  useEffect(()=>{
    if(!query.trim()){setSearchResults(null);setThreadSearchError("");return} const titleMatches=sidebarSearchMatches(threads,query.toLowerCase(),{threadMeta,projects:projectRecords});
    setThreadSearchError("");
    if(!rpc||rpcStatus!=="connected"||query.length<2){setSearchResults(titleMatches);return}
    let cancelled=false; const timer=setTimeout(async()=>{
      const found=new Map(titleMatches.map(t=>[t.id,t]));
      try{
        const outcome=await searchThreadMessages(query);
        for(const match of outcome.matches||[]){const thread=match.thread||threads.find(item=>item.id===match.threadId);if(thread)found.set(thread.id,thread)}
        // Message matches join the title matches where the list has them: the sidebar's order (and a move made in it) holds. Codex's
        // search gives a thread no place in its section, so one beyond the listed page takes the place its section gives it.
        const shown=threadsInListOrder([...found.values()],threads);
        const results=agentRuntime==="codex"?await rankSearchHits(rpc,shown,threads,{orderedSections:orderedSectionsRef.current}).catch(()=>shown):shown;
        if(!cancelled){setSearchResults(results);setThreadSearchError(outcome.warning||"")}
      }catch(error){
        if(!cancelled){setSearchResults(threadsInListOrder([...found.values()],threads));setThreadSearchError("Could not search thread messages: "+(error?.message||String(error)))}
      }
    },250);return()=>{cancelled=true;clearTimeout(timer)}
  },[query,threads,threadMeta,projectRecords,rpc,rpcStatus,agentRuntime,runtimeCapabilities.threadSearch]);

  // label: what could not be done, said before the error's own words; "" for an error that says it itself (a thread's Undo).
  function showActionError(error,label="Action failed"){
    const detail=error?.message||String(error)||"Unknown error";
    if(actionErrorTimerRef.current)clearTimeout(actionErrorTimerRef.current);
    setActionError(label?label+": "+detail:detail);
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
        // The chat, not the inspector beside it: Ctrl+S there (in the Files editor, the commit message) is not the composer's stash.
        chatFocus:(section==="chat"||section==="new")&&!active?.closest?.('[data-testid="right-panel"]'),
        codexRuntime:agentRuntime==="codex",
        threadSearch:Boolean(runtimeCapabilities.threadSearch),
        terminalFocus:Boolean(panel==="terminal"&&active?.closest?.(".terminal-drawer")),
        terminalOpen:panel==="terminal",
        previewFocus:Boolean(rightPanelOpen&&rightPanelTab==="preview"),
        modelPickerOpen:Boolean(modelPickerOpen),
        textInputFocus:Boolean(active&&["INPUT","TEXTAREA","SELECT"].includes(active.tagName)),
        projectOpen:Boolean(projectPath&&!projectlessMode),
        threadOpen:Boolean(activeThread?.id),
        running:Boolean(running),
        // Follow-ups a Stop holds (heldQueues) go as the oldest is sent now, as while a turn runs.
        queueHeld:Boolean(queued.length&&heldQueues.has(String(activeThread?.id||null))),
        // The app's own text questions and confirmations (askText, askConfirm) are <dialog>s outside React's state: one open covers
        // the app too, so Ctrl+N does not open New task behind a rename that then lands there.
        modalOpen:Boolean(paletteOpen||questions.length||elicitations.length||approvals.length||snoozeRequest||settings.onboardingComplete===false||document.querySelector("dialog[open]")),
        rightPanelOpen:Boolean(rightPanelOpen),
        sidebarOpen:Boolean(sidebarOpen),
        undoAvailable:Boolean(threadUndo),
        pullRequestOpen:Boolean(rightPanelOpen&&rightPanelTab==="source"&&sourceSelectedPr?.number),
        desktop:Boolean(window.trebellDesktop),
      };
      const command=resolveKeybinding(event,settings,context,{scripts:projectlessMode?[]:currentProject?.scripts||[]});
      if(!command){desktopWindowZoomKey(event);return}
      event.preventDefault();
      // A held key runs its shortcut once: a repeat would undo a toggle (Ctrl+S stashed the draft and the next repeat brought it
      // back) or run the command again. Only the shortcuts that step through threads, history or the preview's zoom go on.
      if(event.repeat&&!REPEATING_SHORTCUTS.has(command))return;
      if(command==="newChat")runUserAction(newTask,"Could not start a new thread");
      // The palette's key opens and closes it over anything but one of the app's own questions: the question stays on top, so the
      // palette would open, or close, unseen behind it.
      else if(command==="commandPalette"){if(!document.querySelector("dialog[open]"))setPaletteOpen(value=>!value)}
      else if(command==="navigationBack")runUserAction(()=>navigateHistory(-1),"Could not navigate back");
      else if(command==="navigationForward")runUserAction(()=>navigateHistory(1),"Could not navigate forward");
      else if(command==="sidebarToggle")setSidebarOpen(value=>!value);
      // While another thread opens, the sidebar and header already name it: stop, pin, settle, find and the goal wait for it rather
      // than act on the thread the view is leaving, and previous/next step from it.
      else if(command==="threadStop"&&!openingPending)runUserAction(stop,"Could not stop turn");
      else if(command==="threadSettle"&&activeThread?.id&&!openingPending)runUserAction(()=>reversibleThreadAction(activeThread,activeThread.section?.name==="Settled"?"active":"settle"),"Could not update thread");
      else if(command==="threadPin"&&activeThread?.id&&!openingPending)runUserAction(()=>reversibleThreadAction(activeThread,activeThread.section?.name==="Pinned"?"active":"pin"),"Could not update thread");
      else if(command==="threadPrevious"||command==="threadNext"){
        const selectedId=(openingPending?opening.thread:activeThread)?.id;const index=displayThreads.findIndex(thread=>thread.id===selectedId);
        const delta=command==="threadPrevious"?-1:1;const next=displayThreads[index>=0?index+delta:-1];
        if(next)runUserAction(()=>openThread(next),"Could not open thread");
      }
      else if(command==="threadFind"&&!openingPending)openThreadFind();
      else if(command.startsWith("threadJump")){
        const index=Number(command.slice("threadJump".length))-1;const target=displayThreads[index];
        if(target)runUserAction(()=>openThread(target),"Could not open thread");
      }
      else if(command==="stash")runUserAction(stashPrompt,"Could not stash or restore draft");
      else if(command==="terminal")setPanel(value=>value==="terminal"?null:"terminal");
      else if(command==="terminalFocus"){setPanel("terminal");focusTerminalDrawer()}
      else if(command==="composerFocus"){document.querySelector('[data-testid="composer"]')?.focus()}
      // The keys that start a terminal ask for its keyboard, pressed outside the drawer too (a condition set in Settings lets them).
      else if(command==="terminalSplit"){setPanel("terminal");askTerminalKeyboard();setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-split",{detail:{direction:"horizontal"}})),0)}
      else if(command==="terminalSplitVertical"){setPanel("terminal");askTerminalKeyboard();setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-split",{detail:{direction:"vertical"}})),0)}
      else if(command==="terminalNew"){setPanel("terminal");askTerminalKeyboard();setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-new")),0)}
      else if(command==="terminalClose")window.dispatchEvent(new CustomEvent("trebell:terminal-close"));
      else if(command==="rightPanelClose"){setRightPanelOpen(false);setRightPanelMaximized(false)}
      else if(command==="rightPanelToggle")toggleRightPanel();
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
      else if(command==="goal"&&activeThread?.id&&!openingPending)openRightPanel("goal");
      else if(command==="projects")navigateSection("projects");
      else if(command==="settings")navigateSection("settings");
      else if(command==="environments")navigateSection("environments");
      else if(command==="steerQueued"&&queued.length)runUserAction(()=>sendQueuedNow(queued[0]),"Could not send queued follow-up");
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
  },[settings,prompt,attachments,section,panel,paletteOpen,questions.length,elicitations.length,approvals.length,snoozeRequest,threadUndo,projectPath,projectlessMode,activeThread,running,rightPanelOpen,rightPanelTab,sourceSelectedPr,linkedPullRequests,queued,heldQueues,sidebarOpen,displayThreads,modelPickerOpen,currentProject,agentRuntime,opening]);
  // An edit of a queued follow-up ends once it is saved or Escape ends it, and when its message leaves the queue: the draft set aside
  // for it comes back, after whatever the composer holds then.
  useEffect(()=>{
    if(queuedEditId&&!queued.some(item=>item.id===queuedEditId)){setQueuedEditId(null);return}
    if(queuedEditId||!queueEditDraft)return;
    const aside=[queueEditDraft];setQueueEditDraft(null);
    setPrompt(current=>restoreQueuedDraft({prompt:current,queued:aside}).prompt);
    setAttachments(current=>restoreQueuedDraft({attachments:current,queued:aside,maxAttachments:MAX_COMPOSER_ATTACHMENTS}).attachments);
    setContextChips(current=>restoreQueuedDraft({contextChips:current,queued:aside,maxAttachments:MAX_COMPOSER_ATTACHMENTS}).contextChips);
  },[queuedEditId,queueEditDraft,queued]);
  // A follow-up being edited holds the local queue, so it goes as saved, and so does a Stop (heldQueues), unless it fails. One goes at
  // a time: none starts while one of the queue is on its way (localQueueStartRef), whatever the queue's order meanwhile. One marked on
  // its way that no send of this window has (a copy of the queue from before its send ended) may have gone already: it waits for the
  // person, marked to retry as one a reload left (hydratePersistedQueue), and is never started a second time by itself.
  useEffect(()=>{
    if(runtimeCapabilities.nativeQueue&&(queueMode==="native"||queued[0]?.native))return;
    const threadId=activeThreadRef.current?.id||null;
    if(running||!queued.length||queuedEditId||heldQueues.has(String(threadId)))return;
    const next=queued[0],onItsWay=localQueueStartRef.current;if(next?.autoStartFailed||queued.some(item=>onItsWay.has(item.id)))return;
    if(next.dispatchingAt){
      const retry=queueNow(threadId).map(item=>item.id===next.id&&item.dispatchingAt&&!onItsWay.has(item.id)?{...item,dispatchingAt:null,autoStartFailed:true}:item);
      persistLocalQueue(threadId,retry).catch(()=>{if(activeThreadRef.current?.id===threadId)setQueued(retry)});return;
    }
    onItsWay.add(next.id);
    (async()=>{
      const dispatching=queued.map(item=>item.id===next.id?{...item,dispatchingAt:Date.now(),autoStartFailed:false}:item);
      try{
        if(threadId)await persistLocalQueue(threadId,dispatching);else setQueued(dispatching);
        await startTurn(next.text,next.attachments,next.model||model,null,null,repositoryFocusPaths(next.attachments,next.contextChips),{sentChips:next.contextChips||[]});
        // Its turn exists: only it leaves the queue, as that is now (queueNow). Writing it back from this send's copy would drop a
        // follow-up queued meanwhile, here and below.
        await persistLocalQueue(threadId,queueNow(threadId).filter(item=>item.id!==next.id));
      }catch(error){
        // Stop ended it before its turn existed: the queue is left as it is, this follow-up first, held (stop()), and only its dispatch
        // mark goes (clearQueuedDispatch).
        if(error?.trebellSendStopped){setEvents([]);await clearQueuedDispatch(threadId,next.id);return}
        const failed=queueNow(threadId).map(item=>item.id===next.id?{...item,dispatchingAt:null,autoStartFailed:true}:item);
        try{await persistLocalQueue(threadId,failed)}catch{setQueued(failed)}
        // As a send that fails: no turn exists to show it on, so why goes beside the composer, under the queue that keeps the
        // follow-up, never onto the last turn's card (a worktree that could not be set up says why in its own card).
        setEvents([]);if(!(error&&typeof error==="object"&&WORKTREE_CARD_ERRORS.has(error)))setComposerAlert({kind:"send",text:"Queued follow-up not sent: "+sentenceText(error?.message||String(error)||"the harness refused the turn")});
      }finally{onItsWay.delete(next.id)}
    })();
  },[running,queued,queueMode,runtimeCapabilities.nativeQueue,queuedEditId,heldQueues]);
  useEffect(()=>{setQueueMode(shouldUseRuntimeNativeQueue({agentRuntime,nativeQueue:runtimeCapabilities.nativeQueue,projectless:projectlessMode})?"unknown":"local");setQueuedEditId(null)},[agentRuntime,runtimeCapabilities.nativeQueue,projectlessMode]);
  useEffect(()=>{if(!running){stopKeyRef.current=null;setStoppingThreadId(null)}},[running]);

  function handleServerRequest(client,message){
    if(message.method==="item/tool/requestUserInput"){setQuestions(prev=>[...prev,ownedRequest(message,client)]);desktopNotify("Trebell Code needs input","The running agent asked you a question.");return}
    if(message.method==="mcpServer/elicitation/request"){
      setElicitations(prev=>[...prev,{client,request:message}]);
      const meta=message.params?._meta||{};
      const actor=meta.connector_name||meta.connector_id||message.params?.serverName||"An app";
      const action=meta.tool_title||meta.tool_name||"needs input";
      desktopNotify("App approval required",`${actor}: ${action}`);
      return;
    }
    // Trebell's own tools answer from turn-support.js (answerToolCall). A call made before that module has loaded waits for it, and
    // one that cannot load it answers the harness with the reason, as a tool that fails does.
    if(message.method==="item/tool/call"){
      const deps={client,message,permissionMode,activeThread,linkPullRequestUrl,projectPath,workspaceEnvironmentId,runtimeCapabilities,delegateTask,loadSharedToolCatalog};
      loadTurnSupport().then(support=>support.answerToolCall(deps),error=>client.respond(message.id,{contentItems:[{type:"inputText",text:error.message}],success:false}));
      return;
    }
    if(permissionMode==="edits"&&message.method==="item/fileChange/requestApproval"){client.respond(message.id,{decision:"accept"});return}
    if(permissionMode==="edits"&&message.method==="applyPatchApproval"){client.respond(message.id,{decision:"approved"});return}
    if(message.method.includes("requestApproval")||message.method==="applyPatchApproval"||message.method==="execCommandApproval"){setApprovals(prev=>[...prev,ownedRequest(message,client)]);desktopNotify("Approval required",message.params?.reason||message.params?.command||"Trebell Code is waiting for permission.");return}
    client.reject(message.id,-32601,"Unsupported Trebell client request: "+message.method);
  }
  // A completed turn's verification is planned by turn-support.js (planCompletedTurnEvidence). A plan that cannot be made, also for
  // want of that module, says so in the open thread's activity.
  function verificationPlanFailed(threadId,turnId,error){
    if(activeThreadRef.current?.id===threadId)setEvents(previous=>[...previous,{id:"verification-plan-error-"+turnId,kind:"error",title:"Could not plan turn verification: "+(error?.message||String(error)),status:"done",raw:{threadId,turnId}}]);
  }
  function planCompletedTurnEvidence(threadId,turnId){
    if(!threadId||!turnId)return;
    loadTurnSupport().then(support=>support.planCompletedTurnEvidence({activeThreadRef,rpcRef,setEvents,setContinuity,setRunning,setActiveTurnId,automaticVerificationRepairSeenRef,automaticVerificationContinuationSeenRef,verificationPlanFailed},threadId,turnId),error=>verificationPlanFailed(threadId,turnId,error));
  }
  // receivedAt: when the notification arrived. A notification held while its thread opens is handled later, and a turn it
  // starts or ends is still timed from when it really came.
  function handleNotification(message,client=null,receivedAt=Date.now()){
    const p=message.params||{};
    const threadId=p.threadId||null;
    if(threadId&&heldNotificationsRef.current?.threadId===String(threadId)){heldNotificationsRef.current.messages.push([message,client,receivedAt]);return}
    turnNotesRef.current.notify(message);
    const isCurrent=notificationIsActive(threadId);
    // A request the harness retried got through once its turn goes on: an item of the turn, or its reply or thought streaming. The
    // person's own message (a steer sent while the harness still waits) is not the harness going on.
    if(p.turnId!=null&&String(message.method||"").startsWith("item/")&&p.item?.type!=="userMessage")settleRetry(threadId,p.turnId,"recovered",isCurrent);
    if(message.method==="serverRequest/resolved"){
      // Request ids restart on every socket: only the request of this id from the socket that resolved it goes.
      const resolved={requestId:p.requestId,threadId:p.threadId||null,client};
      setApprovals(prev=>prev.filter(request=>!requestResolvedBy(request,request.client,resolved)));
      setQuestions(prev=>prev.filter(request=>!requestResolvedBy(request,request.client,resolved)));
      setElicitations(prev=>prev.filter(item=>!requestResolvedBy(item.request,item.client,resolved)));
    }
    else if(message.method==="agentRuntime/models/updated"){
      // The harness's model list changed after the composer loaded it (Antigravity lists the account's models once a session
      // starts; T3 pushes provider snapshots the same way). The composer keeps its model while it is still offered.
      const runtime=String(p.runtime||"");
      if(runtime&&runtime===agentRuntimeRef.current&&!runtimeSwitchRef.current&&(!client||client===rpcRef.current))api("/api/models").then(catalog=>{
        if(agentRuntimeRef.current===runtime&&!runtimeSwitchRef.current)return refreshProviderModels({agentRuntime:runtime,catalog,refreshBootstrap:false});
      }).catch(()=>{});
    }
    else if(message.method==="thread/started"&&p.thread){
      // This notification arrives before the thread/start response, so whichever lands second replaces the first.
      if(isListedThread(p.thread))setThreads(prev=>prependThread(prev,p.thread));
      if(activeThreadRef.current?.id===p.thread.id)setActiveThread(p.thread);
    }
    else if(message.method==="thread/delegated"&&p.thread){
      const child=p.thread,childId=String(p.childThreadId||child.id||"");
      if(childId){
        backgroundThreadsRef.current.add(childId);
        setThreads(prev=>[child,...prev.filter(t=>t.id!==childId)]);
        api("/api/thread-meta?threadId="+encodeURIComponent(childId)).then(meta=>setThreadMeta(prev=>({...prev,[childId]:meta}))).catch(()=>{});
      }
      if(p.threadId&&activeThreadRef.current?.id===p.threadId)rpcRef.current?.request("thread/goal/get",{threadId:p.threadId}).then(result=>setGoal(result?.goal||null)).catch(()=>{});
      desktopNotify("Delegated task started",child.name||child.preview||"A child task is running in the background.");
    }
    else if(message.method==="thread/status/changed"&&threadId&&p.status){
      setThreads(prev=>prev.map(t=>t.id===threadId?{...t,status:p.status,updatedAt:Date.now()/1000}:t));markThreadTurn(threadId,p.status.type==="active");
      if(isCurrent)setActiveThread(prev=>prev?.id===threadId?{...prev,status:p.status,updatedAt:Date.now()/1000}:prev);
      updateThreadTelemetry(threadId,{status:p.status,lastActivityAt:Date.now()});
    }
    else if(message.method==="thread/name/updated"){
      setThreads(prev=>prev.map(t=>t.id===p.threadId?{...t,name:p.name}:t));
      if(isCurrent)setActiveThread(prev=>prev?.id===p.threadId?{...prev,name:p.name}:prev);
    }
    else if(message.method==="thread/tools/updated"&&p.thread){
      setThreads(prev=>prev.map(t=>t.id===p.thread.id?p.thread:t));
      if(isCurrent){setActiveThread(p.thread);activeThreadRef.current=p.thread}
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
      const codexSettings=agentRuntime==="codex"?codexThreadSettings(threadId,p):null;if(codexSettings)setCodexThreadState(codexSettings);
    }
    else if(message.method==="thread/reverted"&&isCurrent)reloadActiveThread();
    else if(message.method==="turn/started"){
      const id=p.turn?.id||p.turnId;
      const clockKey=turnInfoKey(threadId,id);if(clockKey&&!turnClockRef.current.has(clockKey))turnClockRef.current.set(clockKey,receivedAt);
      // The thread's earlier turns leave the diff each kept, as their rows leave the live card. The turn's reply is kept from its start.
      if(clockKey)for(const key of [...liveExtrasRef.current.keys()])if(key!==clockKey&&key.startsWith(String(threadId)+"\0"))liveExtrasRef.current.delete(key);
      keepReplyStart(threadId,id);
      // A turn that starts again (the relay's restart recovery) is running, not ended: its next completion is recorded whole.
      if(clockKey)setTurnInfo(prev=>{const known=turnStartedAgain(prev[clockKey]);return known===prev[clockKey]?prev:{...prev,[clockKey]:known}});
      // A new turn is not the last one's error: the thread reads as working, and as failed again only if this turn fails.
      updateThreadTelemetry(threadId,{turnId:id||null,turnStartedAtMs:p.turn?.startedAt?Number(p.turn.startedAt)*1000:receivedAt,lastActivityAt:Date.now(),lastError:null});markThreadTurn(threadId,true);
      // The turn of a send Stop was pressed for before its turn started: from here Codex can interrupt it, whether turn/start has
      // answered (a queued turn, which is through now) or not yet.
      const starting=pendingSendsRef.current.get(String(threadId||""));
      if(starting&&(!starting.turnId||starting.turnId===String(id||""))){if(!starting.turnId)starting.startedTurnId=String(id||"");interruptStoppedSend(starting,threadId,id)}
      if(starting?.turnId)pendingSendsRef.current.delete(String(threadId||""));
      if(isCurrent){
        // The open thread's turns in order, where one without rows ends (a thread this window started begins its order here).
        if(threadId&&id)setTurnOrder(prev=>prev.threadId===threadId?{...prev,ids:appendTurnOrder(prev.ids,[id])}:{threadId,ids:[String(id)]});
        // The live card moves to this turn: every other turn of this thread on it takes its rows into its own card and they leave the
        // list, as do the other rows that name the turn (its failure, a retry, its diff, its auto reviews); notices stay. A diff still
        // waiting to show goes in first, so one that came just before its turn ended (and Codex went on) leaves with the rest. A turn
        // that starts again under its id gets back the steps its card holds.
        const owner=threadId||activeThreadRef.current?.id;
        if(owner&&id){
          liveTurnKeyRef.current=turnInfoKey(owner,id);
          for(const entry of [...liveItemRowsRef.current.values()])if(entry.threadId===String(owner)&&entry.turnId!==String(id))sealLiveTurn(owner,entry.turnId);
          diffEventBufferRef.current?.flush();setEvents(prev=>{const next=prev.filter(event=>!event.turnId||event.turnId===String(id));return next.length===prev.length?prev:next});
          const stored=turnActivityRef.current;seedLiveRows(owner,id,stored.threadId===owner?stored.turns[String(id)]?.rows:null);
        }
        setRunning(true);setActiveTurnId(id);
        setMessages(prev=>{const index=[...prev].reverse().findIndex(m=>m.role==="user"&&!m.turnId);if(index<0)return prev;const real=prev.length-1-index;return prev.map((m,i)=>i===real?{...m,turnId:id}:m)});
      }
    }
    else if(message.method==="turn/completed"){
      const completedTurnId=p.turn?.id||p.turnId||null,completedAtMs=p.turn?.completedAt?Number(p.turn.completedAt)*1000:receivedAt;
      // The reply's "done · 3.2s": measured here when this window saw the turn start, else the harness's own duration.
      const outcomeKey=turnInfoKey(threadId,completedTurnId),outcomeStatus=turnOutcomeStatus(p.turn?.status||"completed");
      if(outcomeKey){
        const startedAtMs=turnClockRef.current.get(outcomeKey);turnClockRef.current.delete(outcomeKey);
        const measuredMs=startedAtMs?Math.max(0,receivedAt-startedAtMs):null,reportedMs=Number(p.turn?.durationMs);
        const durationMs=measuredMs||(Number.isFinite(reportedMs)&&reportedMs>0?reportedMs:null),error=turnFailureText(p.turn);
        // A repeated completion (a replay after a reconnect) keeps the time measured the first time; one that ends the turn anew
        // replaces it (recordTurnCompletion). The error is what a turn without a reply shows once the card moves on.
        if(outcomeStatus)setTurnInfo(prev=>({...prev,[outcomeKey]:recordTurnCompletion(prev[outcomeKey],{status:outcomeStatus,durationMs,completedAt:completedAtMs/1000,error})}));
      }
      updateThreadTelemetry(threadId,{turnId:null,turnStartedAtMs:null,currentActivity:null,lastTurn:{id:p.turn?.id||p.turnId||null,status:p.turn?.status||"completed",durationMs:p.turn?.durationMs??null,completedAtMs},lastActivityAt:completedAtMs});markThreadTurn(threadId,false);
      // The turn's reply and MCP progress end with it, whether its thread shows or not; the diff it showed last stays with it, as the
      // row its card shows (restoredRow), not the whole diff.
      const endedDiff=liveExtrasRef.current.get(outcomeKey)?.get("");liveRepliesRef.current.delete(outcomeKey);
      if(endedDiff)liveExtrasRef.current.set(outcomeKey,new Map([["",restoredRow(endedDiff)]]));else liveExtrasRef.current.delete(outcomeKey);
      // A queued turn that ends without having started takes its send with it.
      if(completedTurnId&&pendingSendsRef.current.get(String(threadId||""))?.turnId===String(completedTurnId))pendingSendsRef.current.delete(String(threadId||""));
      if(!p.turn?.status||p.turn.status==="completed")void planCompletedTurnEvidence(threadId,completedTurnId);
      // A failed Codex turn ends with its error (T3 Code); an active Codex goal goes on with a turn Codex starts itself.
      const codexFailure=agentRuntime==="codex"?codexTurnFailure(p.turn):null,codexGoalContinues=agentRuntime==="codex"&&isCurrent&&goal?.status==="active";
      // A retry the turn was still on when it ended: a turn that completed got its request through, any other one stopped retrying.
      settleRetry(threadId,completedTurnId,outcomeStatus==="completed"||!outcomeStatus?"recovered":"stopped",isCurrent);
      if(isCurrent){
        sealLiveTurn(threadId,completedTurnId);if(liveTurnKeyRef.current===turnInfoKey(threadId||activeThreadRef.current?.id,completedTurnId))liveTurnKeyRef.current=null;
        setRunning(false);setActiveTurnId(null);setEvents(prev=>{const done=prev.map(e=>e.status==="running"?{...e,status:"done"}:e);return codexFailure?upsertEvent(done,{id:"codex-error-"+(completedTurnId||threadId),kind:"error",title:codexFailure.title,status:"done",raw:p.turn?.error||{},turnId:completedTurnId?String(completedTurnId):null}):done});loadThreads(rpcRef.current,{strict:true}).catch(error=>showActionError(error,"Turn completed, but the thread list could not refresh"));
        if(codexFailure)desktopNotify("Trebell Code error",codexFailure.message);else if(!codexGoalContinues)desktopNotify("Trebell Code finished",titleOf(activeThreadRef.current)+" is ready for review.");
      }else if(threadId&&backgroundThreadsRef.current.has(threadId)){
        backgroundThreadsRef.current.delete(threadId);loadThreads(rpcRef.current,{strict:true}).catch(error=>showActionError(error,"Background task completed, but the thread list could not refresh"));const thread=threads.find(item=>item.id===threadId);desktopNotify("Background task finished",(thread?titleOf(thread):"A background Trebell task")+" is ready for review.");
      }
    }
    else if(message.method==="turn/plan/updated"&&isCurrent){const plan=(p.plan||[]).map((s,i)=>({id:"plan-"+i,kind:"plan",title:s.step||s.description||s.text||"Plan step",status:s.status==="completed"?"done":s.status==="inProgress"?"running":"pending",raw:s,turnId:p.turnId==null?null:String(p.turnId)}));setEvents(prev=>[...prev.filter(e=>e.kind!=="plan"),...plan])}
    else if(message.method==="item/started"&&p.item){
      if(p.item.type==="agentMessage")keepReplyStart(threadId,p.turnId,{itemId:p.item.id,text:p.item.text});
      const item=activityRow(p.item,{turnId:p.turnId});
      const isActivityItem=!["userMessage","agentMessage","sessionHandoff"].includes(p.item.type);
      if(isActivityItem)updateThreadTelemetry(threadId,{currentActivity:{id:item.id,kind:item.kind,title:item.title,startedAtMs:p.startedAtMs||Date.now()},lastActivityAt:p.startedAtMs||Date.now()});
      if(isCurrent&&isActivityItem)setEvents(prev=>takeCompactionPlace(prev,item,threadId)||[...prev.filter(e=>e.id!==item.id),item]);
      if(isCurrent&&isCardItem(p.item))trackLiveRow(threadId,p.turnId,item,{phase:"started"});
    }
    // A harness tool that is still running can name itself better as it goes (an ACP tool call first reports its bare tool
    // name, then its kind and command); the row follows it in place.
    else if(message.method==="item/tool/progress"&&p.item){
      // Output-only updates stream through outputDelta; only a changed name, kind or status touches the row and the telemetry.
      const item=activityRow(p.item,{turnId:p.turnId});
      const activity=threadTelemetryRef.current[threadId]?.currentActivity;
      if(activity?.id===item.id&&(activity.title!==item.title||activity.kind!==item.kind))updateThreadTelemetry(threadId,{currentActivity:{...activity,kind:item.kind,title:item.title}});
      if(isCurrent)setEvents(prev=>{
        const index=prev.findIndex(e=>e.id===item.id);
        if(index<0)return [...prev,item];
        const old=prev[index],merged=mergeLiveRow(old,item,{phase:"progress"});
        if(merged===old)return prev;
        const next=prev.slice();next[index]=merged;return next;
      });
      if(isCurrent&&isCardItem(p.item))trackLiveRow(threadId,p.turnId,item,{phase:"progress"});
      // A running command's progress (the agent relay's ACP steps) carries its whole output so far, after the delta it adds: that
      // replaces what streamed, which lacks what came before the thread was shown again, so the open step shows all of it as it goes.
      const full=p.item.type==="commandExecution"&&typeof p.item.aggregatedOutput==="string"?p.item.aggregatedOutput:"";
      if(isCurrent&&full&&item.status==="running"){
        const commandId=String(p.item.id);commandStreamBufferRef.current?.flushKey(commandId);
        if(full.length>(commandOutputRef.current.get(commandId)||"").length){commandOutputRef.current.set(commandId,full);activityTimelineRef.current?.setCommandOutput(commandId,full)}
      }
    }
    else if(message.method==="item/completed"&&p.item){
      let streamedCommandOutput="";
      if(isCurrent&&(p.item.type==="commandExecution"||p.item.type==="reasoning")){
        const commandId=String(p.item.id||"command");
        commandStreamBufferRef.current?.flushKey(commandId);
        streamedCommandOutput=commandOutputRef.current.get(commandId)||"";
        commandOutputRef.current.delete(commandId);
        activityTimelineRef.current?.clearCommandOutput(commandId);
      }
      if(p.item.type==="mcpToolCall"){
        const itemId=String(p.item.id||"");
        if(itemId){liveExtrasRef.current.get(turnInfoKey(threadId,p.turnId))?.delete(itemId);if(isCurrent){mcpProgressRef.current.delete(itemId);activityTimelineRef.current?.clearMcpProgress(itemId)}}
      }
      // A finished reply is the thread's history from here: what was kept of it is done with.
      if(p.item.type==="agentMessage"&&p.item.text?.trim())liveRepliesRef.current.delete(turnInfoKey(threadId,p.turnId));
      const item=activityRow({...p.item,status:completedItemStatus(p.item)},{turnId:p.turnId});
      const completedAtMs=p.completedAtMs||Date.now();
      const isActivityItem=!["userMessage","agentMessage","sessionHandoff"].includes(p.item.type);
      if(isActivityItem)updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?.id===item.id?null:current.currentActivity,lastActivity:{id:item.id,kind:item.kind,title:item.title,durationMs:p.item?.durationMs??null,completedAtMs},lastActivityAt:completedAtMs}));
      if(isCurrent){
        if(p.item.type==="userMessage"&&String(p.item.clientId||"").startsWith("trebell-queue-")){
          const draft=queuedSubmissionDraft({input:p.item.content||[]}),id=p.item.clientId,itemId=p.item.id?String(p.item.id):null;
          // History that already has the message lists it by its item id (a held completion replayed over a fresh history).
          setMessages(prev=>prev.some(message=>message.id===id||(itemId&&String(message.id)===itemId))?prev:[...prev,{id,role:"user",text:draft.draftText||draft.text,attachments:draft.attachments,turnId:p.turnId||null}]);
        }
        // A reply the history listed while it streamed reads as it ended.
        if(p.item.type==="agentMessage"&&p.item.text?.trim()){setMessages(prev=>{const at=prev.findIndex(m=>m.id===p.item.id);if(at<0)return [...prev,{id:p.item.id,role:"assistant",text:p.item.text,turnId:p.turnId||null}];if(prev[at].text===p.item.text)return prev;const next=prev.slice();next[at]={...prev[at],text:p.item.text};return next});resetAssistantStream()}
        // A fresh session took over a conversation the harness lost: the turn says so in its own row (a reload reads it from the turn).
        if(p.item.type==="sessionHandoff"){const handoff=sessionHandoffMessage(p.item,p.turnId);if(handoff)setMessages(prev=>withSessionHandoff(prev,handoff))}
        // A finished thought leaves the live activity for the conversation, where a reopened thread shows it too.
        if(p.item.type==="reasoning"){const thought=reasoningHistoryMessage(p.item,p.turnId,streamedCommandOutput);setEvents(prev=>prev.filter(e=>e.id!==item.id));if(thought)setMessages(prev=>prev.some(m=>m.id===thought.id)?prev:[...prev,thought])}
        else if(isActivityItem){
          setEvents(prev=>{
            if(prev.some(e=>e.id===item.id))return prev.map(e=>e.id===item.id?mergeLiveRow(e,item,{phase:"completed",streamed:streamedCommandOutput}):e);
            const row=mergeLiveRow(null,item,{phase:"completed",streamed:streamedCommandOutput});return takeCompactionPlace(prev,row,threadId)||[...prev,row];
          });
          if(isCardItem(p.item))trackLiveRow(threadId,p.turnId,item,{phase:"completed",streamed:streamedCommandOutput});
        }
      }
    }
    else if(message.method==="item/autoApprovalReview/started"){
      const id="auto-review-"+String(p.reviewId||Date.now()),title="Auto review · "+guardianActionSummary(p.action||{});
      updateThreadTelemetry(threadId,{currentActivity:{id,kind:"autoReview",title,startedAtMs:p.startedAtMs||Date.now()},lastActivityAt:p.startedAtMs||Date.now()});
      if(isCurrent)setEvents(prev=>{const event={id,kind:"autoReview",title,status:"running",raw:p,turnId:p.turnId?String(p.turnId):null};return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?event:item):[...prev,event]});
    }
    else if(message.method==="item/autoApprovalReview/completed"){
      const id="auto-review-"+String(p.reviewId||Date.now()),status=p.review?.status||"completed",title="Auto review · "+guardianActionSummary(p.action||{});
      updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?.id===id?null:current.currentActivity,lastActivity:{id,kind:"autoReview",title,durationMs:p.completedAtMs&&p.startedAtMs?Math.max(0,p.completedAtMs-p.startedAtMs):null,completedAtMs:p.completedAtMs||Date.now()},lastActivityAt:p.completedAtMs||Date.now()}));
      if(isCurrent){
        setEvents(prev=>{const failed=status==="denied"||status==="timedOut";const event={id,kind:failed?"error":"autoReview",title:status==="denied"?title+" · denied":status==="timedOut"?title+" · timed out":title,status:failed?"error":"done",raw:p,turnId:p.turnId?String(p.turnId):null};return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?event:item):[...prev,event]});
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
        setEvents(prev=>prev.some(item=>item.id===id)?prev:[...prev,{id,kind:"autoReview",title,status:"warning",raw:p,turnId:p.turnId?String(p.turnId):null}]);
        desktopNotify("Additional safety review",title);
      }
    }
    else if(message.method==="guardianWarning"){
      if(isCurrent){
        // A guardian warning is a warning about the auto-review policy, not a failed step: it reads as the strict-review row does.
        setEvents(prev=>[...prev,{id:"guardian-warning-"+Date.now(),kind:"autoReview",title:p.message||"Auto review warning",status:"warning",raw:p}]);
        desktopNotify("Auto review warning",p.message||"Codex reported an auto-review warning.");
      }
    }
    // A reply streams on the live reply of the thread shown, and on the reply kept for its turn whichever thread shows. The first
    // delta of a reply the history listed as it stood when the thread opened takes that copy's place: the live reply goes on from it.
    else if(message.method==="item/agentMessage/delta"){
      const delta=p.delta||p.text||"",copy=liveRepliesRef.current.get(turnInfoKey(threadId,p.turnId));
      if(isCurrent&&copy?.copy&&copy.itemId===String(p.itemId||"")&&!assistantStreamSyncRef.current.chars){setMessages(prev=>prev.filter(m=>String(m.id)!==copy.itemId));showLiveReply(threadId,p.turnId,{itemId:copy.itemId,text:copy.text,sync:copy.sync,whole:true})}
      keepLiveReply(threadId,p.turnId,p.itemId,delta,p.offset);
      if(isCurrent){const step=assistantStreamDelta(assistantStreamSyncRef.current,delta,p.offset);if(step.restart)clearAssistantText();assistantStreamSyncRef.current=step.state;if(step.append)appendAssistantStream(step.append)}
    }
    // A Native draft that went another way (a tool call, an error, steering, Stop) is taken off the screen.
    else if(message.method==="item/agentMessage/reset"){liveRepliesRef.current.delete(turnInfoKey(threadId,p.turnId));if(isCurrent)clearAssistantText()}
    else if(message.method==="item/commandExecution/outputDelta"&&isCurrent)commandStreamBufferRef.current?.push(p.itemId||"command",p.delta||"");
    // A thought streams like command output, by its item id (Codex's summary parts and raw text, a relay harness's thinking).
    else if((message.method==="item/reasoning/summaryTextDelta"||message.method==="item/reasoning/textDelta")&&isCurrent&&p.itemId)commandStreamBufferRef.current?.push(p.itemId,p.delta||"");
    else if(message.method==="item/reasoning/summaryPartAdded"&&isCurrent&&p.itemId&&Number(p.summaryIndex)>0)commandStreamBufferRef.current?.push(p.itemId,"\n\n");
    else if(message.method==="item/mcpToolCall/progress"){
      if(threadId)updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?{...current.currentActivity,title:p.message||current.currentActivity.title}:current.currentActivity,lastActivityAt:Date.now()}),{render:rightPanelOpen&&rightPanelTab==="agents"});
      if(p.itemId){
        const id=String(p.itemId),progress={title:p.message||"MCP progress",raw:p};
        keepLiveExtra(threadId,p.turnId,id,progress);
        if(isCurrent){mcpProgressRef.current.set(id,progress);activityTimelineRef.current?.setMcpProgress(id,progress)}
      }
    }
    else if(message.method==="turn/diff/updated"){
      const id="diff-"+String(p.turnId||activeTurnId||threadId||"current"),event={id,kind:"fileChange",title:"Workspace diff updated",status:"done",raw:p.diff||p,turnId:p.turnId?String(p.turnId):null};
      keepLiveExtra(threadId,p.turnId,"",event);
      if(isCurrent)diffEventBufferRef.current?.push(id,event);
    }
    else if(message.method==="thread/tokenUsage/updated"){
      updateThreadTelemetry(threadId,{tokenUsage:p.tokenUsage||null,lastActivityAt:Date.now()});
      if(isCurrent&&(section==="chat"||section==="new"||(rightPanelOpen&&rightPanelTab==="runtime")))setTokenUsage(p.tokenUsage||null);
    }
    else if(message.method==="thread/goal/updated"&&isCurrent){
      // Codex ends an active goal itself: complete, or stopped by a budget, a usage limit or a blocker.
      const next=p.goal||null;
      if(agentRuntime==="codex"&&goal?.status==="active"&&next&&!["active","paused"].includes(next.status))desktopNotify(next.status==="complete"?"Goal complete":"Goal stopped",describeCodexGoal(next));
      setGoal(next);
    }
    else if(message.method==="thread/goal/cleared"&&isCurrent)setGoal(null);
    else if(message.method==="thread/continuity/updated"&&isCurrent)setContinuity(p.continuity||null);
    else if(message.method==="thread/elicitation/completed"&&isCurrent){
      setEvents(prev=>[...prev,{id:"elicitation-complete-"+(p.elicitationId||Date.now()),kind:"tool",title:"External interaction completed",status:"done",raw:p}]);
    }
    else if(message.method==="thread/queue/changed"&&isCurrent)loadNativeQueue(rpcRef.current,p.threadId).catch(error=>setEvents(prev=>[...prev,{id:"queue-refresh-error-"+Date.now(),kind:"error",title:"Could not refresh queued follow-ups: "+(error.message||String(error)),status:"done",raw:{}}]));
    else if(message.method==="thread/sourceControl/updated"&&isCurrent&&p.gitInfo){
      setGitInfo(current=>({...current,...p.gitInfo}));
    }
    else if(message.method==="skills/changed")loadSkills(rpcRef.current,projectPath,true,{strict:true}).catch(error=>showActionError(error,"Could not refresh skills"));
    else if(message.method==="windowsSandbox/setupCompleted"){
      window.dispatchEvent(new CustomEvent("trebell:windows-sandbox-setup",{detail:p}));
      desktopNotify(p.success?"Windows sandbox ready":"Windows sandbox setup failed",p.success?`${p.mode==="elevated"?"Elevated":"Unelevated"} Codex sandbox setup completed.`:(p.error||"Codex could not complete Windows sandbox setup."));
    }
    else if(message.method==="windows/worldWritableWarning"){
      window.dispatchEvent(new CustomEvent("trebell:windows-sandbox-warning",{detail:p}));
      const count=(p.samplePaths||[]).length+(Number(p.extraCount)||0);const detail=p.failedScan?"Codex could not fully scan Windows writable paths.":`${count} Windows path${count===1?"":"s"} may not be protectable by the sandbox.`;
      setEvents(prev=>[...prev,{id:"windows-sandbox-warning-"+Date.now(),kind:"error",title:detail,status:"done",raw:p}]);desktopNotify("Windows sandbox warning",detail);
    }
    else if(message.method==="thread/attachment/updated"&&isCurrent)loadPersistentThreadData(p.threadId);
    else if(message.method==="thread/runtimeInstance/updated"){
      const updated=p.thread||null;
      setThreads(prev=>prev.map(thread=>thread.id===p.threadId?(updated?{...thread,...updated}:{...thread,runtimeInstanceId:p.runtimeInstanceId}):thread));
      if(isCurrent){
        setActiveThread(prev=>prev?.id===p.threadId?(updated||{...prev,runtimeInstanceId:p.runtimeInstanceId}):prev);
        loadThreadRuntimeProfiles(rpcRef.current,p.threadId);
      }
    }
    else if(message.method==="thread/providerMetadata/updated"){
      setThreads(prev=>prev.map(thread=>thread.id===p.threadId?{...thread,providerMeta:{...(thread.providerMeta||{}),[p.type]:p.update}}:thread));
      const compaction=(p.type==="session_info_update"||p.type==="compaction_update")?contextCompactionSignal(p.update):null;
      if(compaction&&threadId){
        const at=Date.now(),id="context-compact-"+threadId;
        if(compaction.phase==="running"){
          updateThreadTelemetry(threadId,{currentActivity:{id,kind:"contextCompaction",title:compaction.title,startedAtMs:at},lastActivityAt:at});
        }else if(compaction.phase==="done"){
          settleCompactionWaiter(threadId,null,{ok:true,source:"providerMetadata"});
          updateThreadTelemetry(threadId,{currentActivity:null,lastActivity:{id,kind:"contextCompaction",title:compaction.title,completedAtMs:at},lastActivityAt:at,lastError:null});
        }else{
          settleCompactionWaiter(threadId,new Error(compaction.detail||compaction.title));
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
      settleCompactionWaiter(threadId,null,{ok:true,source:"thread/compacted"});
      updateThreadTelemetry(threadId,{currentActivity:null,lastActivity:{id,kind:"contextCompaction",title:"Context compacted",completedAtMs:at},lastActivityAt:at,lastError:null});
      // The compaction's row ends compacted: its item's (the newest still running, else the newest), or the one Compact put up; a
      // harness that sends no item gets its row here. Its turn's record too, should the item not say so before the turn ends.
      const compacted={kind:"contextCompaction",title:"Context compacted",status:"done"};
      if(isCurrent){
        endCompactionRecord(threadId,p.turnId,row=>({...row,...compacted}));
        setEvents(prev=>{
          const rows=prev.filter(item=>item.kind==="contextCompaction"),row=rows.findLast(item=>item.status==="running")||rows.at(-1);
          return row?prev.map(item=>item===row?{...item,...compacted}:item):[...prev,{id,...compacted,raw:p,...(p.turnId?{turnId:String(p.turnId)}:{})}];
        });
      }
    }
    else if(message.method==="error"){
      // Codex sends {error:{message, codexErrorInfo, additionalDetails}, willRetry, turnId} (T3 Code reads it the same way);
      // other harnesses send {message}.
      const notice=codexErrorNotice(p),codexTurnError=Boolean(p.error&&typeof p.error==="object"&&p.turnId);
      if(notice.willRetry){
        // The harness retries the turn's request itself (Codex reconnecting, Native waiting for the network): the turn goes on, so
        // the retry is its current activity, not an error it ended with, and its one row reads as retrying until the turn goes on.
        const row=retryActivityRow(notice,{turnId:p.turnId??null,threadId,raw:p}),at=Date.now();
        updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?.id===row.id?{...current.currentActivity,title:row.title}:{id:row.id,kind:row.kind,title:row.title,startedAtMs:at},lastActivityAt:at}));
        if(isCurrent){retryRowsRef.current.add(retryRowKey(threadId,p.turnId??null));setEvents(prev=>upsertEvent(prev,row))}
        return;
      }
      settleRetry(threadId,p.turnId??null,"stopped",isCurrent);
      if(threadId&&compactionWaitersRef.current.has(String(threadId)))settleCompactionWaiter(threadId,new Error(notice.message||"Context compaction failed"));
      updateThreadTelemetry(threadId,{currentActivity:null,lastError:notice.message,lastActivityAt:Date.now()});
      // A Codex turn error ends the turn at turn/completed, which reports it once more and notifies.
      if(isCurrent&&codexTurnError)setEvents(prev=>upsertEvent(prev,{id:"codex-error-"+p.turnId,kind:"error",title:notice.title,status:"done",raw:p,turnId:String(p.turnId)}));
      else if(isCurrent){setEvents(prev=>[...prev,{id:"error-"+Date.now(),kind:"error",title:notice.title,status:"done",raw:p,turnId:p.turnId?String(p.turnId):null}]);setRunning(false);desktopNotify("Trebell Code error",notice.message||"The agent stopped with an error.")}
    }
  }

  async function updateThreadMeta(threadId,patch,{strict=false}={}){
    let meta;
    try{meta=await api("/api/thread-meta",{method:"POST",body:{threadId,patch}})}
    catch(error){
      if(strict)throw error;
      meta={...threadMeta[threadId],...patch};
    }
    setThreadMeta(prev=>({...prev,[threadId]:meta}));
    return meta;
  }
  async function persistLocalQueue(threadId,items){
    const stored=persistedQueueItems(items);
    if(!threadId){setQueued(stored);return stored}
    const meta=await updateThreadMeta(threadId,{trebellQueue:stored},{strict:true}),shown=activeThreadRef.current?.id===threadId;
    // What is read of the queue before the next render (queueNow, a thread that opens now) is what was written.
    const now=queueNowRef.current;queueNowRef.current={queued:shown?stored:now.queued,threadMeta:{...now.threadMeta,[threadId]:meta}};
    if(shown)setQueued(stored);
    return stored;
  }
  // A thread's queue as it is now (queueNowRef): what a send that ended writes its follow-up back into, by id, whether its turn
  // started, its start failed or Stop ended it, so a follow-up queued while it was on its way stays.
  function queueNow(threadId){const {queued:shown,threadMeta:meta}=queueNowRef.current;return !threadId||activeThreadRef.current?.id===threadId?shown:meta[threadId]?.trebellQueue||[]}
  // A follow-up whose send Stop ended before its turn existed is not on its way any more: its dispatch mark goes, by id, from its
  // thread's queue as that is now, so a follow-up queued meanwhile stays, and the thread opened again reads it queued, not as a send
  // that may have started (hydratePersistedQueue's retry needed), and starts it with the rest of the queue.
  // A write that fails still takes the mark off the queue shown, so its card does not read as being sent. The send waits for it before
  // it leaves localQueueStartRef, so the queue and that set agree for a thread opened meanwhile.
  function clearQueuedDispatch(threadId,id){
    const current=queueNow(threadId);if(!current.some(item=>item.id===id&&item.dispatchingAt))return Promise.resolve();
    const cleared=current.map(item=>item.id===id?{...item,dispatchingAt:null}:item);
    return persistLocalQueue(threadId,cleared).catch(error=>{if(activeThreadRef.current?.id===threadId)setQueued(cleared);showActionError(error,"Could not save the queued follow-ups")});
  }
  // A follow-up of Trebell's queue on its way (localQueueStartRef, or its dispatch mark) is sent whatever its card is pressed for: the
  // card says it is being sent, with its buttons off, and Send now, Edit, the moves and Remove leave it as it is.
  function queuedOnItsWay(item){return Boolean(item?.id&&!item.native&&(item.dispatchingAt||localQueueStartRef.current.has(item.id)))}
  async function persistThreadWorkspaceContext(thread,cwd=thread?.cwd,extra={},{strict=false}={}){
    if(!thread?.id||!cwd)return null;
    const existing=threadMeta[thread.id]||{};
    const environmentId=existing.environmentId??thread.providerMeta?.environmentId??workspaceEnvironmentId??null;
    const projectless=Object.prototype.hasOwnProperty.call(extra,"projectless")?Boolean(extra.projectless):Boolean(existing.projectless);
    let info=null;
    if(!projectless){
      const params=new URLSearchParams({path:String(cwd)});params.set("environmentId",environmentId||"");
      try{info=await api("/api/git/info?"+params)}
      catch(error){if(strict)throw new Error("Could not read Git metadata while saving thread context: "+(error?.message||String(error)))}
    }
    const catalog=catalogMetaPatch(thread,{
      runtime:threadCatalogRuntime(thread,existing,agentRuntime),
      provider:existing.provider||provider,
      runtimeInstanceId:existing.runtimeInstanceId||thread.runtimeInstanceId||thread.providerMeta?.runtimeInstanceId||null,
    });
    const patch={
      cwd:String(cwd),environmentId,branch:existing.branch||(info?.isGit?info.branch||null:null),
      projectless,sectionName:thread.section?.name||"Active",archived:Boolean(thread.archived),...catalog,...extra,
    };
    if(!strict)return updateThreadMeta(thread.id,patch);
    try{return await updateThreadMeta(thread.id,patch,{strict:true})}
    catch(error){
      setThreadMeta(prev=>({...prev,[thread.id]:{...(prev[thread.id]||{}),...patch}}));
      throw error;
    }
  }
  function clearThreadUndo(){
    if(threadUndoTimerRef.current)clearTimeout(threadUndoTimerRef.current);
    threadUndoTimerRef.current=null;threadUndoRef.current=null;setThreadUndo(null);
  }
  function offerThreadUndo(label,undo){
    if(threadUndoTimerRef.current)clearTimeout(threadUndoTimerRef.current);
    const id=crypto.randomUUID();threadUndoRef.current={id,undo};setThreadUndo({id,label,expiresAt:Date.now()+5000});
    threadUndoTimerRef.current=setTimeout(()=>{if(threadUndoRef.current?.id===id){threadUndoRef.current=null;setThreadUndo(null)}},5000);
  }
  // A Settings undo (a deleted custom theme) fails into the Settings alert while Settings is open. Once it is closed, the app's error
  // toast shows the failure, as it does a thread's (undoThreadAction).
  function offerSettingsUndo(label,undo){offerThreadUndo(label,()=>Promise.resolve().then(undo).catch(error=>{if(sectionRef.current!=="settings")showActionError(error,"Undo failed")}))}
  // A removed project or environment comes back the same way. Its page reports a failed restore while it is on screen; once it is
  // not, the restore throws and the app's error toast says so.
  // A page's Undo that went through with something left out (Projects: a save that did not answer in time) says so here when that
  // page is no longer on screen: it resolves to the note.
  function offerPageUndo(label,undo){offerThreadUndo(label,()=>Promise.resolve().then(undo).then(note=>{if(typeof note==="string"&&note)showActionError(new Error(note),"Undo")}).catch(error=>showActionError(error,"Undo failed")))}
  // A thread's Undo the harness refuses says so in the app's error toast, where the Undo was, naming the threads it could not put back
  // (thread-actions.js undoThreadActions): the open thread's conversation is about another thread.
  async function undoThreadAction(){
    const current=threadUndoRef.current;if(!current)return;
    clearThreadUndo();
    try{await current.undo()}
    catch(error){showActionError(error,"")}
  }
  useEffect(()=>()=>{if(threadUndoTimerRef.current)clearTimeout(threadUndoTimerRef.current)},[]);
  // The thread actions (thread-actions.js) read this render as App's own functions did. Once that module has loaded (from idle after
  // the first paint) an action runs at once, and one that cannot load it fails and says so where the action's own failure would. The
  // ones made before then wait for it and run once it is in, in the order they were made, each as a click made then would: from the
  // render that follows the one before it (flushSync), on the thread or the threads selected when it was made, as the sidebar shows
  // them then (or the open thread as it is then, for a key on the open thread). So two Move up clicks take a thread up two places,
  // and an action reads the thread open then.
  function threadActionDeps(){
    return {rpc,rpcStatus,agentRuntime,agentRuntimeLabel,sections,orderedSectionsRef,sectionTop,placementAnchor,threads,threadMeta,displayThreads,setThreads,setSearchResults,activeThread,setActiveThread,activeThreadRef,openingThreadRef,updateThreadMeta,loadThreads,newChat,leaveRemovedThread,openThread,offerThreadUndo,setSnoozeRequest,snoozeRequest,selectedThreadIds,setSelectedThreadIds,threadMovesRef,saveAppSettings,presetFor,permissionMode,model,provider,projectPath,askConfirm};
  }
  const latestThreadActionDeps=useLatestCallback(threadActionDeps),queuedThreadActionsRef=useRef(Promise.resolve());
  function runThreadAction(name,args){
    if(threadActions)return threadActions[name](threadActionDeps(),...args);
    const openThen=activeThread,selectedThen=selectedThreadIds,started=queuedThreadActionsRef.current.then(loadThreadActions).then(module=>{
      const deps={...latestThreadActionDeps(),selectedThreadIds:selectedThen},[thread,...rest]=args,id=thread?.id;let action;
      const shown=id==null?thread:thread===openThen?(deps.activeThread?.id===id?deps.activeThread:thread):deps.displayThreads.find(item=>item.id===id)||deps.threads.find(item=>item.id===id)||thread;
      flushSync(()=>{action=module[name](deps,...(id==null?args:[shown,...rest]))});
      return [action];
    });
    queuedThreadActionsRef.current=started.catch(()=>{});
    return started.then(([action])=>action);
  }
  function moveThread(...args){return runThreadAction("moveThread",args)}
  function reversibleThreadAction(...args){return runThreadAction("reversibleThreadAction",args)}
  function threadAction(...args){return runThreadAction("threadAction",args)}
  function moveThreadOrder(...args){return runThreadAction("moveThreadOrder",args)}
  function bulkAction(...args){return runThreadAction("bulkAction",args)}
  function submitSnooze(...args){return runThreadAction("submitSnooze",args)}
  // The anchor only while it is still in that section when the undo runs (Codex refuses a thread to go before that is not in the
  // destination section); an undo made seconds later reads the list as it is then, not as it was when the thread moved. restored: the
  // threads an undo of several has put back so far (id -> section id), which the list may not show yet.
  const placementAnchor=useLatestCallback((snapshot,restored=null)=>{
    const id=snapshot.anchorThreadId,sectionId=snapshot.section?.id||null;if(!id)return null;
    if(restored?.has(id))return restored.get(id)===sectionId?id:null;
    const anchor=threads.find(item=>item.id===id);
    return anchor&&(anchor.section?.id||null)===sectionId?anchor.id:null;
  });
  // The section's first thread as the list is now: a bulk action, auto-settle and snooze wake-up move threads from a loop whose list
  // is older, and a thread to go before must still be in the section.
  const sectionTop=useLatestCallback((sectionId,exceptId)=>sectionFirstThread(threads,sectionId,threadMeta,exceptId));

  async function loadPersistentThreadData(threadId){
    const client=rpcRef.current;if(!client||!threadId)return {goal:null,continuity:null,pullRequests:[]};
    const [goalResult,continuityResult,attachmentResult]=await Promise.allSettled([
      client.request("thread/goal/get",{threadId}),
      client.request("thread/continuity/get",{threadId}),
      client.request("thread/attachment/list",{threadId,limit:100}),
    ]);
    const goalData=goalResult.status==="fulfilled"?goalResult.value:null;
    const continuityData=continuityResult.status==="fulfilled"?continuityResult.value:null;
    const attachmentData=attachmentResult.status==="fulfilled"?attachmentResult.value:null;
    const pullRequests=attachmentData?(attachmentData?.data||[]).filter(item=>item.attachmentType==="pull_request").map(item=>({...item.payload,__identityKey:item.identityKey})):null;
    if(activeThreadRef.current?.id===threadId){
      if(goalResult.status==="fulfilled")setGoal(goalData?.goal||null);
      if(continuityResult.status==="fulfilled")setContinuity(continuityData?.continuity||null);
      if(attachmentResult.status==="fulfilled")setLinkedPullRequests(pullRequests||[]);
      const errors=[];
      if(goalResult.status==="rejected"&&!codexGoalsMissing(goalResult.reason))errors.push("goal: "+(goalResult.reason?.message||String(goalResult.reason)));
      if(continuityResult.status==="rejected")errors.push("continuity: "+(continuityResult.reason?.message||String(continuityResult.reason)));
      if(attachmentResult.status==="rejected")errors.push("linked attachments: "+(attachmentResult.reason?.message||String(attachmentResult.reason)));
      if(errors.length)setEvents(prev=>[...prev,{id:"persistent-refresh-error-"+Date.now(),kind:"error",title:"Could not refresh saved thread data: "+errors.join(" · "),status:"error",raw:{errors}}]);
    }
    return {goal:goalResult.status==="fulfilled"?goalData?.goal||null:null,continuity:continuityResult.status==="fulfilled"?continuityData?.continuity||null:null,pullRequests};
  }
  function releaseInactiveCodexThread(threadId){
    if(agentRuntime!=="codex"||!threadId||running||!rpc||rpcStatus!=="connected")return;
    const previous=threads.find(thread=>thread.id===threadId)||activeThreadRef.current;
    if(previous&&threadCatalogRuntime(previous,threadMeta[threadId]||{},agentRuntime)!=="codex")return;
    rpc.request("thread/unsubscribe",{threadId}).catch(()=>{});
  }
  // A switch still on its way lands on its own harness: a thread of the harness that runs now, opened meanwhile, switches back after
  // it rather than open on a transport that switch is about to replace. A switch that fails leaves alone the thread a later one is
  // to reopen.
  async function switchRuntimeForThread(thread,{preserveSection=false,from=null}={}){
    const meta=threadMeta[thread.id]||{},targetRuntime=threadCatalogRuntime(thread,meta,agentRuntime);
    if(!targetRuntime||targetRuntime===agentRuntime&&targetRuntime===(runtimeSwitchRef.current?.to||agentRuntime))return false;
    if(running)throw new Error("Stop the running turn before switching agent runtimes.");
    // A switch that crosses Codex also waits for the turns of threads left running: Codex is restarted when it is selected again, which
    // ends its turns, and a window on one side hears nothing of the other's, whose rows would go on saying Running (as in Settings).
    const waits=(targetRuntime==="codex"||agentRuntime==="codex")&&runningTasks.find(task=>(task.runtime==="codex")===(agentRuntime==="codex"));
    if(waits)throw new Error(`${agentRuntimeName(waits.runtime)} is running “${waits.title}”. Stop the running turn before switching agent runtimes.`);
    setSelectedThreadIds(new Set());
    const pending={thread,preserveSection,from,targetRuntime};pendingRuntimeThreadRef.current=pending;
    try{
      const instanceId=meta.runtimeInstanceId||null;
      await switchAgentRuntime({runtime:targetRuntime,instanceId,resetThread:false},()=>api("/api/agent-runtimes",{method:"POST",body:{action:"select",runtime:targetRuntime,instanceId}}));
      return true;
    }catch(error){
      if(pendingRuntimeThreadRef.current===pending)pendingRuntimeThreadRef.current=null;throw error;
    }
  }
  // A new task is asked for after any thread still opening, so it replaces that open (and a harness switch's reopen of it).
  async function newChat(){openSeqRef.current++;openingThreadRef.current=null;pendingRuntimeThreadRef.current=null;setOpening(null);showNewTask();releaseThreadNotifications(heldNotificationsRef.current?.token)}
  // A new task the person asks for has the keyboard in its composer (focusNewTask).
  async function newTask(){await newChat();focusNewTask()}
  // After the thread shown is archived or deleted: a new task, as newChat; under another thread still opening, only the view under
  // that open becomes the new task, and the open goes on (one that fails then comes back to the new task, not to a thread gone).
  async function leaveRemovedThread(threadId){
    turnNotesRef.current.threadEnded(threadId);
    if(String(activeThreadRef.current?.id||"")!==String(threadId))return;
    if(openingThreadRef.current&&openingThreadRef.current!==String(threadId))showNewTask();else await newChat();
  }
  // A turn of the thread left goes on behind the new task, which runs nothing itself: that turn shows in the thread's sidebar row,
  // and again once the thread is opened.
  // A new task asked for from the new task (on it, or back from a page opened from it) keeps its unsent draft with the agent and the
  // collaboration mode chosen for it, and a send still on its way in the thread left goes on there without holding the new task's
  // composer (send).
  function showNewTask(){const leftNewTask=!activeThreadRef.current;rememberConversationPosition();setComposerAlert(null);releaseInactiveCodexThread(activeThreadRef.current?.id);activeThreadRef.current=null;pendingThreadScrollRestoreRef.current=null;pendingHistoryPrependRef.current=null;stopHistoryAnchorSettle();setHistoryHold(conversationScrollRef.current,0);followConversationEndRef.current=true;shownWelcomeRef.current=null;setNewTaskView(view=>view+1);setSection("chat");setActiveThread(null);setActiveTurnId(null);setRunning(false);setMessages([]);setTurnActivity(emptyTurnActivity(null));liveItemRowsRef.current.clear();liveTurnKeyRef.current=null;setHistoryPage({threadId:null,nextCursor:null,paginated:false,loading:false});setThreadFind({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});setEvents([]);setGuardianDenials([]);setGuardianBusy("");resetAssistantStream();setQueued([]);setQueueMode(shouldUseRuntimeNativeQueue({agentRuntime,nativeQueue:runtimeCapabilities.nativeQueue,projectless:projectlessMode})?"unknown":"local");setQueuedEditId(null);setQueueEditDraft(null);if(!leftNewTask){submittingRef.current=null;setSubmitting(false);setPrompt("");setAttachments([]);setContextChips([]);setProviderAgent("");setCollaborationMode(collaborationModes.some(item=>item.mode==="default")?"default":collaborationModes[0]?.mode||"default")}setTokenUsage(null);setCheckpointByTurn({});setGoal(null);setContinuity(null);setLinkedPullRequests([]);setWorktreeSetup(null);setCodexThreadState(null);if(agentRuntime!=="codex"){setSkills([]);setProviderCommands([]);setProviderAgents([]);if(runtimeInventoryRef.current)applyProviderInventory(runtimeInventoryRef.current)}}
  async function newGeneralChat(){
    const environmentId=workspaceEnvironmentId;
    const scratch=await api("/api/general-workspace",{method:"POST",body:{environmentId}});
    await newTask();
    projectChoiceSeqRef.current++;setProjectlessMode(true);setGeneralEnvironmentId(scratch.environmentId||null);setCurrentProject(null);setProjectPath(scratch.path);setGitInfo(null);setWorkspaceMode("current");
    if(["files","diff","source"].includes(rightPanelTab)){setRightPanelTab("runtime");setRightPanelOpen(false);setRightPanelMaximized(false)}
    return scratch;
  }
  // Each open takes the next number, and only the last one asked for replaces the view: an open that a later one or a new task has
  // replaced stops where it is, so a late answer never brings its thread back (nor a late failure its error). Until the open lands,
  // the sidebar and the header name its thread and, once it takes long, its opening state covers the conversation (see opening); the
  // thread already open changes none of that. A thread the person asks for also replaces one a harness switch was still to reopen
  // for an earlier open (the transport's own reopens pass their client and keep it). from is the section it was asked for in: it
  // lands in the chat from there, but a page asked for since stays, the page it was asked from too (setSection), with the thread
  // open behind it.
  // A thread other than the one shown, asked for again the same way while it opens (a second click), waits for that open rather than
  // start it over, which would make the person wait for another resume.
  // A thread that did not open leaves the view it replaced, and the composer says so beside the draft, with where a message sent now
  // goes (the thread shown, or a new task), however the open was asked for: the draft never goes there unseen. reopen: the thread was
  // the one shown, which it still is.
  function noteOpenFailure(thread,error,{reopen=false}={}){
    const shown=activeThreadRef.current,detail=sentenceText(error?.message||String(error||"")||"The harness did not answer.");
    const where=reopen?"":shown?.id?` Sending now goes to “${titleOf(shown)}”.`:" Sending now starts a new task instead.";
    setComposerAlert({kind:"open",threadId:String(thread?.id||""),text:`Could not ${reopen?"reopen":"open"} “${titleOf(thread)}”: ${detail}${where}`});
  }
  // A page or view asked for while a thread opens shows (pageAsked): the open, and a harness switch's reopen of it, no longer land in
  // the chat. The opening state covers the page the open was asked from (openingOverPage), so that page asked for again shows too.
  function setSection(next){
    const run=openRunRef.current,pending=pendingRuntimeThreadRef.current;if(run)run.pageAsked=true;if(pending)pending.pageAsked=true;
    setOpening(current=>current?.from&&!current.pageAsked?{...current,pageAsked:true}:current);setSectionState(next);
  }
  async function openThread(thread,options={}){
    const threadId=String(thread?.id||""),client=options.client||rpc,from=options.from??sectionRef.current,toChat=!options.preserveSection,inFlight=openRunRef.current;
    // Asked for again the same way after a page was asked for meanwhile: the thread is wanted again, so its open lands in the chat
    // and covers the page it was asked from once more.
    if(threadId&&inFlight&&!inFlight.settled&&inFlight.threadId===threadId&&openingThreadRef.current===threadId&&String(activeThreadRef.current?.id||"")!==threadId&&inFlight.client===client&&inFlight.toChat===toChat&&inFlight.from===from){
      const pending=pendingRuntimeThreadRef.current;inFlight.pageAsked=false;if(String(pending?.thread?.id||"")===threadId)pending.pageAsked=false;
      setOpening(current=>current?.pageAsked&&String(current.thread?.id||"")===threadId?{...current,pageAsked:false}:current);
      return inFlight.done;
    }
    const token=++openSeqRef.current,pending=pendingRuntimeThreadRef.current;releaseThreadNotifications(heldNotificationsRef.current?.token);
    if(!options.client&&pending&&String(pending.thread?.id||"")!==threadId)pendingRuntimeThreadRef.current=null;
    const reopening=String(activeThreadRef.current?.id||"")===threadId;
    if(threadId){openingThreadRef.current=threadId;setOpening({thread,token,reopen:reopening,toChat,from,landed:false})}
    const run=openThreadInternal(thread,{...options,from,token}),record={threadId,client,toChat,from,settled:false,done:run.then(()=>{},()=>{})};
    record.done.then(()=>{record.settled=true});openRunRef.current=record;
    try{return await run}
    catch(error){if(openSeqRef.current!==token)return thread;noteOpenFailure(thread,error,{reopen:reopening});throw error}
    finally{
      releaseThreadNotifications(token);
      const pendingId=String(pendingRuntimeThreadRef.current?.thread?.id||"");
      if(openSeqRef.current===token&&!(threadId&&pendingId===threadId)){openingThreadRef.current=null;setOpening(null)}
    }
  }
  // From the answer of its resume (before any page of its history is read) until it shows, a thread being opened keeps its
  // notifications back: they are newer than that answer, so they are handled once the thread shows, as the open thread's, instead of
  // being undone by it (a turn that ended meanwhile stayed running). An open that ends without showing hands them on as it ends, and
  // one that a later open or a new task replaces hands them on then: from that moment its thread is a thread in the background.
  function holdThreadNotifications(token,threadId){heldNotificationsRef.current={token,threadId:String(threadId),messages:[]}}
  function releaseThreadNotifications(token){
    const held=heldNotificationsRef.current;if(!held||held.token!==token)return;
    heldNotificationsRef.current=null;for(const [message,client,receivedAt] of held.messages)notificationHandlerRef.current?.(message,client,receivedAt);
  }
  async function openThreadInternal(thread,{client=rpc,preserveSection=false,from=sectionRef.current,token=openSeqRef.current}={}){
    if(await switchRuntimeForThread(thread,{preserveSection,from}))return thread;
    const previousThreadId=activeThreadRef.current?.id;
    const reopeningCurrentThread=previousThreadId===thread.id;
    let savedMeta=threadMeta[thread.id]||{},metaReadError=null;
    if(savedMeta.__catalogOnly===true){
      try{
        const fullMeta=await api("/api/thread-meta?threadId="+encodeURIComponent(thread.id));
        if(fullMeta&&typeof fullMeta==="object"){
          savedMeta={...savedMeta,...fullMeta};delete savedMeta.__catalogOnly;
          setThreadMeta(previous=>({...previous,[thread.id]:savedMeta}));
        }
      }catch(error){metaReadError=error}
    }
    const threadEnvironmentId=savedMeta.environmentId??thread.providerMeta?.environmentId??null;
    const projectless=Object.prototype.hasOwnProperty.call(savedMeta,"projectless")?Boolean(savedMeta.projectless):Boolean(thread.providerMeta?.projectless);
    const useNativeQueue=shouldUseRuntimeNativeQueue({agentRuntime,nativeQueue:runtimeCapabilities.nativeQueue,projectless});
    const savedContextTask=savedMeta.trebellContext?.continuityTask||savedMeta.trebellContext?.userTask||savedMeta.trebellContext?.task||"";if(savedContextTask)contextTaskRef.current.set(thread.id,savedContextTask);
    if(thread.cwd&&!threadEnvironmentId&&!projectless)await api("/api/worktree/ensure",{method:"POST",body:{path:thread.cwd,environmentId:null}}).catch(error=>{throw new Error("Could not restore this managed worktree: "+error.message)});
    const connectedClient=Boolean(client&&!(client===rpc&&rpcStatus!=="connected"));
    let resumed=null,cp=null,goalData=null,continuityData=null,attachmentData=null;
    const persistentReadErrors=[];if(metaReadError)persistentReadErrors.push("thread metadata: "+(metaReadError.message||String(metaReadError)));
    // An open or a new task asked for since this one began owns the view: this one does not resume a thread nobody waits for.
    if(openSeqRef.current!==token)return thread;
    if(connectedClient){
      // A harness thread resumes on its own model (T3 keeps each thread's model selection); the composer then shows that model. A
      // Native thread asks for its own too: a session it starts runs on the model asked for, which became the thread's.
      const resumePromise=resumeWithBoundedHistory(client,{threadId:thread.id,...(agentRuntime==="native"?{model:thread.model||model||null,modelProvider:provider}:{}),cwd:thread.cwd||null},()=>{if(openSeqRef.current===token)holdThreadNotifications(token,thread.id)});
      const checkpointPromise=api("/api/checkpoints?threadId="+encodeURIComponent(thread.id)).then(value=>({value,error:null}),error=>({value:null,error}));
      const goalPromise=client.request("thread/goal/get",{threadId:thread.id}).then(value=>({value,error:null}),error=>({value:null,error}));
      const continuityPromise=client.request("thread/continuity/get",{threadId:thread.id}).then(value=>({value,error:null}),error=>({value:null,error}));
      const attachmentPromise=client.request("thread/attachment/list",{threadId:thread.id,limit:100}).then(value=>({value,error:null}),error=>({value:null,error}));
      try{resumed=await resumePromise}
      catch(error){
        if(missingRuntimeThreadError(error)){
          await updateThreadMeta(thread.id,{catalogHidden:true,missingRuntimeThreadAt:Date.now()},{strict:false}).catch(()=>{});
          setThreads(previous=>previous.filter(item=>item.id!==thread.id));
          throw new Error("This saved shortcut no longer has a matching conversation in the selected runtime, so Trebell removed the stale shortcut. Your other chats were not changed.");
        }
        throw error;
      }
      if(!resumed?.thread)throw new Error("The agent runtime did not return the requested thread.");
      const [checkpointResult,goalResult,continuityResult,attachmentResult]=await Promise.all([checkpointPromise,goalPromise,continuityPromise,attachmentPromise]);
      cp=checkpointResult.value;goalData=goalResult.value;continuityData=continuityResult.value;attachmentData=attachmentResult.value;
      if(checkpointResult.error)persistentReadErrors.push("checkpoints: "+(checkpointResult.error.message||String(checkpointResult.error)));
      // A Codex without goals has no goal to load, which is no error.
      if(goalResult.error&&!codexGoalsMissing(goalResult.error))persistentReadErrors.push("goal: "+(goalResult.error.message||String(goalResult.error)));
      if(continuityResult.error)persistentReadErrors.push("continuity: "+(continuityResult.error.message||String(continuityResult.error)));
      if(attachmentResult.error)persistentReadErrors.push("linked attachments: "+(attachmentResult.error.message||String(attachmentResult.error)));
    }
    const openedThread=resumed?.thread||thread,owns=()=>openSeqRef.current===token;
    // The same check after the answers came: a later open or a new task keeps the view, and this late answer never replaces it.
    if(!owns())return thread;
    // A project thread's project opens before the thread replaces the view, so both land in one frame: between them the view was
    // the empty new-task screen. One replaced while its project opened leaves the project of the view that replaced it; a project
    // that cannot open still fails the open where it always did, once the thread is selected.
    let projectError=null;
    if(!projectless&&openedThread.cwd)await touchProject(openedThread.cwd,threadEnvironmentId,{owns}).catch(error=>{projectError=error});
    if(!owns())return thread;
    rememberConversationPosition();
    if(previousThreadId&&previousThreadId!==thread.id)releaseInactiveCodexThread(previousThreadId);
    // A send of this thread still on its way (left for a new task meanwhile) shows again as when it was sent: its message below the
    // history until the harness has its turn (the history holds it then), the turn running with its Stop, and the composer held as
    // Sending until the send is through. A send whose turn Codex has queued counts while Codex runs the thread: one it no longer runs
    // missed its turn/started or turn/completed (a reconnect), and would keep the thread running with a Stop that waits for nothing.
    if(pendingSendsRef.current.get(String(thread.id))?.turnId&&openedThread.status?.type!=="active")pendingSendsRef.current.delete(String(thread.id));
    const pendingSend=pendingSendsRef.current.get(String(thread.id)),resumedRunning=openedThread.status?.type==="active"||Boolean(pendingSend),resumedTurnId=resumedActiveTurnId(resumed);
    // The reply the running turn streams shows under its live card from its start: the relay's so far (an ACP harness stores a reply
    // once its turn ends), else the one kept while the thread was not shown, and a copy the history lists of it gives way. With
    // neither, the history's copy of the turn's latest reply is the reply so far, and that reply's next delta goes on from it. A
    // reply kept from partway (not whole: its start came before this window followed the thread on this socket) gives way to the
    // history's copy of the same reply instead, which holds its start; it shows only while the history lists no copy of it.
    const relayReply=resumedTurnId&&String(resumed?.trebellLiveReply?.turnId||"")===resumedTurnId?String(resumed.trebellLiveReply.text||""):"";
    const replyKey=turnInfoKey(thread.id,resumedTurnId),keptReply=liveRepliesRef.current.get(replyKey);
    const liveReply=relayReply?{itemId:null,text:relayReply,sync:{chars:relayReply.length,desynced:false},whole:true}:keptReply?.text&&!keptReply.copy?keptReply:null;
    const shownHistory=history=>{
      const latest=replyKey&&!(liveReply?.text&&liveReply.whole)?history.findLast(message=>message.role==="assistant"&&String(message.turnId||"")===resumedTurnId):null;
      const copy=latest&&(!liveReply?.text||String(latest.id)===String(liveReply.itemId||""))?latest:null;
      if(copy){liveRepliesRef.current.set(replyKey,{itemId:String(copy.id),text:String(copy.text),sync:{chars:String(copy.text).length,desynced:false},copy:true});if(liveReply?.text)clearAssistantText()}
      const shown=liveReply?.itemId&&!copy?history.filter(message=>String(message.id)!==liveReply.itemId):history;
      return pendingSend?.message&&!resumedTurnId?[...shown,pendingSend.message]:shown;
    };
    // The composer is held only for a send of the thread shown: another thread opened releases it, as a new task does (showNewTask).
    // The send's files and context go with its hold: the thread opened does not show them (a send from it would carry them again),
    // and the send's own thread, opened again before its turn starts, has them back.
    if(previousThreadId!==thread.id&&submittingRef.current){dropSentDraft(sendDraftsRef.current.get(submittingRef.current));submittingRef.current=null;setSubmitting(false)}
    if(pendingSend?.view&&!submittingRef.current){submittingRef.current=pendingSend.view;setSubmitting(true);returnSentDraft(sendDraftsRef.current.get(pendingSend.view))}
    // A Stop already sent for the turn that still runs reads Stopping again, and a press sends no second one (stop()).
    const stoppedTurnKey=resumedRunning&&resumedTurnId?String(thread.id)+"\0"+resumedTurnId:null;
    if(pendingSend?.stopped){stopKeyRef.current=pendingSend;setStoppingThreadId(String(thread.id))}
    else if(stoppedTurnKey&&turnNotesRef.current.stopWasSent(thread.id,resumedTurnId)){stopKeyRef.current=stoppedTurnKey;setStoppingThreadId(String(thread.id))}
    // A thread that runs no turn has no Stop on its way, and one that runs the turn resumed has none for the turns before it (their
    // ends may have come while the window did not follow the thread).
    if(openedThread.status?.type!=="active")turnNotesRef.current.turnsEnded(thread.id);else if(resumedTurnId)turnNotesRef.current.turnsEnded(thread.id,resumedTurnId);
    // The queue shown is the thread's as it is now (queueNow's copy), not as it was when this open began: a follow-up whose send
    // ended while the open waited has left it, or is marked to retry, and only one still on its way now reads as being sent. A copy
    // read before would show the one that went as being sent, with its buttons off, and the queue would start it a second time.
    const restoredLocalQueue=useNativeQueue?[]:hydratePersistedQueue(queueNowRef.current.threadMeta[thread.id]?.trebellQueue||savedMeta.trebellQueue||[],localQueueStartRef.current);
    // The composer's note goes with the view it was about: another thread shown, or this one opening after all, ends it; the thread
    // shown opening again (a reconnect) keeps a note about its failed send or about another thread that did not open.
    activeThreadRef.current=openedThread;setComposerAlert(current=>current&&(previousThreadId!==thread.id||(current.kind==="open"&&current.threadId===String(thread.id)))?null:current);pendingThreadScrollRestoreRef.current=null;pendingHistoryPrependRef.current=null;stopHistoryAnchorSettle();setHistoryHold(conversationScrollRef.current,0);followConversationEndRef.current=threadScrollPositionsRef.current.get(thread.id)?.atEnd??true;if(!reopeningCurrentThread)shownWelcomeRef.current=null;if(!preserveSection&&sectionRef.current===from&&!openRunRef.current?.pageAsked)setSection("chat");setMessages([]);setTurnOrder({threadId:thread.id,ids:[]});setTurnActivity(emptyTurnActivity(thread.id));liveItemRowsRef.current.clear();liveTurnKeyRef.current=resumedRunning&&resumedTurnId?turnInfoKey(thread.id,resumedTurnId):null;setHistoryPage({threadId:thread.id,nextCursor:null,paginated:false,loading:false});setThreadFind({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});setEvents([]);setGuardianDenials([]);setGuardianBusy("");resetAssistantStream();setWorktreeSetup(null);setTokenUsage(threadTelemetryRef.current[thread.id]?.tokenUsage||null);setRunning(resumedRunning);setActiveTurnId(resumedTurnId);setActiveThread(openedThread);setThreads(previous=>{const existing=previous.findIndex(item=>item.id===openedThread.id);if(existing>=0)return previous.map(item=>item.id===openedThread.id?{...item,...openedThread}:item);return [openedThread,...previous].slice(0,100)});setQueueMode(useNativeQueue?"unknown":"local");setQueued(useNativeQueue?[]:restoredLocalQueue);persistThreadWorkspaceContext(openedThread,openedThread.cwd,{archived:false,projectless},{strict:true}).catch(error=>showActionError(error,"Could not save thread workspace context"));
    // A hold a Stop put on its queue holds it again after a reload or a restart, with the follow-ups it shows (holdQueue).
    if(!useNativeQueue&&savedMeta.trebellQueueHeld&&!holdKnownRef.current.has(String(thread.id)))holdQueue(thread.id,true,{saved:true});
    // The turn that still runs (resumedTurnId) gets back on its live card the MCP progress and the diff it had, those sent while the
    // thread was not shown among them; its stored steps go in front of the diff (seedLiveRows).
    for(const [id,value] of liveExtrasRef.current.get(turnInfoKey(thread.id,resumedTurnId))||[])if(id){mcpProgressRef.current.set(id,value);activityTimelineRef.current?.setMcpProgress(id,value)}else setEvents(prev=>upsertEvent(prev,value));
    if(liveReply?.text)showLiveReply(thread.id,resumedTurnId,liveReply);
    // A send of this thread that failed while another view was shown gives its draft and its note back here (dispatchSend).
    // A thread whose own Codex app-server died says so, in one row: its resumes name the death until its next turn, under one id.
    const appServerExit=resumed?.trebellAppServerExit;if(appServerExit?.id)setEvents(prev=>upsertEvent(prev,{id:"app-server-exit-"+appServerExit.id,kind:"error",title:appServerExitText(appServerExit),status:"done",raw:appServerExit}));
    const failedSend=turnNotesRef.current.takeFailedSend(thread.id);if(failedSend){restoreSentDraft(failedSend.draft);if(failedSend.alert)setComposerAlert(failedSend.alert)}
    if(restoredLocalQueue.some(item=>item.recoveredUncertainDispatch))updateThreadMeta(openedThread.id,{trebellQueue:persistedQueueItems(restoredLocalQueue)},{strict:true}).catch(error=>showActionError(error,"Recovered an uncertain queued follow-up, but could not save its retry state"));
    if(projectless){setProjectlessMode(true);setGeneralEnvironmentId(savedMeta.environmentId??threadEnvironmentId??null);setCurrentProject(null);setProjectPath(openedThread.cwd||projectPath);setGitInfo(null);setWorkspaceMode("current")}
    else if(projectError)throw projectError;else if(!openedThread.cwd)setProjectPath(projectPath);
    // The goal and notes read for the thread come in the frame that shows it, so a Goal panel open on it starts from them and puts
    // back a draft left unsaved on it against them: an empty goal for a moment read as the goal cleared elsewhere.
    if(!reopeningCurrentThread){setCheckpointByTurn({});setGoal(goalData?.goal||null);setContinuity(continuityData?.continuity||null);setLinkedPullRequests(savedMeta.linkedPullRequests||[])}
    if(!connectedClient){setReviewedFiles(savedMeta.reviewedFiles||[]);if(persistentReadErrors.length)showActionError(new Error(persistentReadErrors.join(" · ")),"Opened thread, but some saved state could not be loaded");return}
    const map=cp?Object.fromEntries((cp.checkpoints||[]).filter(x=>x.turnId).map(x=>[x.turnId,x])):(reopeningCurrentThread?checkpointByTurn:{});
    if(cp)setCheckpointByTurn(map);
    // openedCards: the turns' cards the first page (or the whole thread) holds. cutNewestTurnId: the newest turn when it alone filled
    // the first item page, whose earlier steps are read once more below.
    let openedCards=null,cutNewestTurnId=null;
    if(resumed?.thread){
      activeThreadRef.current=resumed.thread;resumedOnRef.current={threadId:resumed.thread.id,client};pendingThreadScrollRestoreRef.current=resumed.thread.id;setActiveThread(resumed.thread);
      if(runtimeCapabilities.collaborationModes&&resumed.collaborationMode?.mode&&collaborationModes.some(item=>item.mode===resumed.collaborationMode.mode))setCollaborationMode(resumed.collaborationMode.mode);
      if(agentRuntime==="codex")applyCodexThreadSettings(resumed.thread.id,resumed);
      else if(resumed.thread.model&&modelsRef.current.includes(resumed.thread.model)){setModel(resumed.thread.model);setSelectedModels([resumed.thread.model])}
      // An open thread never fans out: a pick of several models (one made for a new task) gives way to the one model a follow-up goes
      // to, also when the catalog does not list the thread's own, so the picker names it.
      const sendModel=modelRef.current;setSelectedModels(current=>current.length>1?(sendModel?[sendModel]:[]):current);
      if(resumed.__trebellHistoryPage&&!resumed.__trebellFullHistoryFallback){
        const page=resumed.__trebellHistoryPage;
        const history=page.kind==="items"?historyFromItemEntries([...(page.data||[])].reverse(),map):historyFromTurns([...(page.data||[])].reverse(),map);
        // An item-paged thread reads how its turns ended from its outcome pages, done ones too, so every reply has its pill.
        turnOutcomePagesRef.current=page.kind==="items"?{threadId:resumed.thread.id,cursor:page.turnsCursor||null,covered:new Set((page.turns||[]).map(turn=>String(turn?.id||"")).filter(Boolean))}:null;
        // The turns in order come from the same pages (item pages skip a turn that has no items), then any this window saw start.
        const orderIds=turnIdsOldestFirst(page.kind==="items"?page.turns||[]:page.data||[]);
        setTurnOrder(prev=>({threadId:resumed.thread.id,ids:appendTurnOrder(orderIds,prev.threadId===resumed.thread.id?prev.ids:[])}));
        // Each turn's card comes from the same page: an item page reads turns newest first and may cut its oldest (the boundary, whose
        // card heads the newest pages until older ones load); a turn page holds whole turns.
        if(page.kind==="items"){
          const boundaryTurnId=itemPageBoundaryTurnId(page.data||[],page.nextCursor||null);
          openedCards={rows:cardRowsFromItemEntries([...(page.data||[])].reverse(),{activeTurnId:resumedTurnId}),merge:{mode:"older",complete:itemPageCompleteness(page.data||[],page.nextCursor||null)},boundaryTurnId};
          if(boundaryTurnId&&String(page.data?.[0]?.turnId||"")===boundaryTurnId&&openedCards.rows[boundaryTurnId]?.length)cutNewestTurnId=boundaryTurnId;
        }else openedCards={rows:cardRowsFromTurns([...(page.data||[])].reverse(),{activeTurnId:resumedTurnId}),merge:{mode:"replace",complete:true},boundaryTurnId:null};
        setTurnInfo(prev=>mergeTurnOutcomes(prev,resumed.thread.id,page.kind==="items"?page.turns||[]:page.data||[]));setMessages(shownHistory(history));setHistoryPage({threadId:resumed.thread.id,nextCursor:page.nextCursor||null,paginated:true,itemPaging:page.kind==="items",itemHistory:page.kind==="items",loading:false});
      }else{
        // The whole thread: cards for its newest 200 turns.
        openedCards={rows:cardRowsFromTurns((resumed.thread.turns||[]).slice(-200),{activeTurnId:resumedTurnId}),merge:{mode:"replace",complete:true},boundaryTurnId:null};
        turnOutcomePagesRef.current=null;setTurnOrder(prev=>({threadId:resumed.thread.id,ids:appendTurnOrder((resumed.thread.turns||[]).map(turn=>String(turn?.id||"")).filter(Boolean),prev.threadId===resumed.thread.id?prev.ids:[])}));setTurnInfo(prev=>mergeTurnOutcomes(prev,resumed.thread.id,resumed.thread.turns||[]));setMessages(shownHistory(historyFromThread(resumed.thread,map)));setHistoryPage({threadId:resumed.thread.id,nextCursor:null,paginated:false,loading:false})
      }
      // The running turn's stored steps start its live card. The notifications handled as the thread shows read its cards from the
      // ref (a turn that starts again under its id gets its stored steps back), so the ref holds them from here, before the render.
      // A turn that ended, also while the thread was not shown, has the diff it showed last on its card.
      const cards=openedCards,opened={...mergeTurnActivity(emptyTurnActivity(thread.id),withEndedDiffs(thread.id,cards.rows,resumedTurnId),cards.merge),boundaryTurnId:cards.boundaryTurnId};turnActivityRef.current=opened;setTurnActivity(opened);
      if(resumedTurnId)seedLiveRows(thread.id,resumedTurnId,cards.rows[String(resumedTurnId)]);
      setProjectPath(resumed.thread.cwd||projectPath);setProviderAgent(resumed.thread.agent||"");if(agentRuntime!=="codex")applyProviderInventory(harnessInventory(runtimeInventoryRef.current,resumed.thread.providerMeta))
    }
    // The thread shows now (its history lands in this same frame), so its opening state ends; sends still wait for the reads below.
    // What it was sent since its answer is handled now, as the open thread's.
    releaseThreadNotifications(token);
    setOpening(current=>current?.token===token?{...current,landed:true}:current);
    if(runtimeCapabilities.projectOwnership&&!bootstrap.mock&&resumed?.thread&&!projectless&&!threadEnvironmentId&&resumed.thread.cwd){
      let listed={projects:[]};
      try{listed=await api("/api/projects")}
      catch(error){showActionError(error,"Could not sync runtime project identity")}
      const trebellProject=(listed.projects||[]).find(project=>!project.environmentId&&sameWorkspacePath(project.path,resumed.thread.cwd))||null;
      let nativeProject=null;
      try{nativeProject=await ensureRuntimeProject(client,{trebellProject,cwd:resumed.thread.cwd})}
      catch(error){showActionError(error,"Could not sync runtime project identity")}
      if(nativeProject?.id&&resumed.thread.projectId!==nativeProject.id){
        let updated=null;
        try{updated=await client.request("thread/metadata/update",{threadId:resumed.thread.id,projectId:nativeProject.id})}
        catch(error){showActionError(error,"Could not sync runtime project identity")}
        if(updated?.thread&&activeThreadRef.current?.id===updated.thread.id){
          activeThreadRef.current=updated.thread;setActiveThread(updated.thread);
          setThreads(prev=>prev.map(item=>item.id===updated.thread.id?updated.thread:item));
        }
      }
    }
    // The newest turn alone filled the first item page: its earlier steps are read once, so its card holds them all (failing that, it
    // says some steps are not loaded).
    if(cutNewestTurnId){
      const completeThreadId=thread.id,turnId=cutNewestTurnId;
      client.request("thread/items/list",{threadId:completeThreadId,turnId,sortDirection:"desc",limit:400}).then(result=>{
        if(activeThreadRef.current?.id!==completeThreadId)return;
        const entries=(result?.data||[]).filter(entry=>String(entry?.turnId||"")===turnId),rows=cardRowsFromItemEntries([...entries].reverse(),{activeTurnId:resumedTurnId,turnId});
        setTurnActivity(prev=>prev.threadId===completeThreadId?mergeTurnActivity(prev,rows,{mode:"older",complete:entries.length>0&&!result?.nextCursor}):prev);
        seedLiveRows(completeThreadId,turnId,rows[turnId]);
      },()=>{});
    }
    // A Codex thread whose pages hold no step (messages only, or a thread from before item paging) takes its latest turn's steps
    // from the timeline, into that turn's card, and into the live card too while that turn runs.
    if(agentRuntime==="codex"&&!bootstrap.mock&&resumed?.thread&&!Object.values(openedCards?.rows||{}).some(rows=>rows.length)){
      const timelineThreadId=thread.id;
      import("./thread-timeline.js")
        .then(({loadLatestTurnTimeline})=>loadLatestTurnTimeline(client,timelineThreadId))
        .then(timeline=>{
          if(activeThreadRef.current?.id!==timelineThreadId||!timeline.items.length||!timeline.turnId)return;
          const turnId=String(timeline.turnId),rows=cardRowsFromItemEntries(timeline.items.map(item=>({turnId,item})),{activeTurnId:resumedTurnId});
          setTurnActivity(prev=>prev.threadId===timelineThreadId?mergeTurnActivity(prev,withEndedDiffs(timelineThreadId,rows,resumedTurnId),timeline.complete?{mode:"replace",complete:true}:{mode:"older"}):prev);
          seedLiveRows(timelineThreadId,turnId,rows[turnId]);
        })
        .catch(error=>{
          const detail=error?.message||String(error);
          if(error?.rpcCode===-32601||/method not found|unknown method|unsupported|experimental method/i.test(detail))return;
          showActionError(error,"Could not restore latest activity timeline");
        });
    }
    if(useNativeQueue)await loadNativeQueue(client,thread.id).catch(error=>setEvents(prev=>[...prev,{id:"queue-load-error-"+Date.now(),kind:"error",title:"Could not load queued follow-ups: "+(error.message||String(error)),status:"done",raw:{}}]));
    // A thread opened or a new task started while these reads ran has the view: this thread's saved state does not go into it.
    if(activeThreadRef.current?.id!==openedThread.id)return thread;
    const meta=savedMeta;setReviewedFiles(meta.reviewedFiles||[]);
    if(goalData)setGoal(goalData?.goal||null);
    if(continuityData)setContinuity(continuityData?.continuity||null);
    if(attachmentData){
      const persisted=(attachmentData?.data||[]).filter(item=>item.attachmentType==="pull_request").map(item=>({...item.payload,__identityKey:item.identityKey}));
      setLinkedPullRequests(persisted.length?persisted:(meta.linkedPullRequests||[]));
    }
    if(persistentReadErrors.length)showActionError(new Error(persistentReadErrors.join(" · ")),"Opened thread, but some saved state could not be loaded");
  }
  // "top" loads the page above the first message shown; "gap" the newest history's next older page, which sits below the gap
  // under a detached find hit (with nothing detached the two are the same page). Above a detached hit, pages are turn pages.
  function loadEarlierMessages(target="top"){
    const threadId=activeThreadRef.current?.id;
    if(!rpc||rpcStatus!=="connected"||!threadId||historyPage.threadId!==threadId||historyPage.loading)return Promise.resolve();
    const detached=historyPage.detached||null,above=target==="top"&&Boolean(detached);
    const cursor=above?detached.cursor:historyPage.nextCursor;if(!cursor)return Promise.resolve();
    const itemPaging=!above&&Boolean(historyPage.itemPaging),detachedIds=new Set((detached?.ids||[]).map(String));
    const windowTurnIds=[...new Set(messages.filter(message=>!detachedIds.has(String(message.id))).map(message=>message.turnId).filter(Boolean).map(String))];
    // at: the button that loads, where a failure is said (Conversation), and which stays there to try again.
    const at=detached&&!above?"gap":"top";
    setHistoryPage(current=>current.threadId===threadId?{...current,loading:at,error:null}:current);
    const run=(async()=>{
      try{
        const page=itemPaging
          ?await loadItemHistoryPage(rpc,threadId,cursor)
          :await rpc.request("thread/turns/list",{threadId,cursor,limit:HISTORY_TURN_PAGE_LIMIT,sortDirection:"desc",itemsView:"full"});
        if(activeThreadRef.current?.id!==threadId)return;
        const outcomeTurns=itemPaging?await turnOutcomesForItemPage(rpc,threadId,turnOutcomePagesRef.current,page?.data):page?.data||[];
        if(activeThreadRef.current?.id!==threadId)return;
        const data=[...(page?.data||[])].reverse(),nextCursor=page?.nextCursor||null;
        const earlier=itemPaging?historyFromItemEntries(data,checkpointByTurn):historyFromTurns(data,checkpointByTurn);
        const pageTurnIds=[...new Set(data.map(entry=>itemPaging?entry?.turnId:entry?.id).filter(Boolean).map(String))];
        // The view is measured when the page lands, not when it was asked for (the person may have scrolled or sent meanwhile); a
        // view that follows the end keeps following it. A view whose rows all fit has no end to follow: its rows stay put.
        const node=conversationScrollRef.current;
        if(earlier.length&&node&&(!followConversationEndRef.current||node.scrollHeight-node.clientHeight<=THREAD_SCROLL_END_THRESHOLD)){
          const anchor=captureHistoryPrependAnchor(node);
          pendingHistoryPrependRef.current={threadId,scrollHeight:node.scrollHeight,scrollTop:node.scrollTop,anchor};setHistoryAnchorItemId(anchor?.messageId??null);
        }
        setTurnInfo(prev=>mergeTurnOutcomes(prev,threadId,outcomeTurns));
        // The page's turns take their steps into their cards: an item page adds older steps and may cut its oldest turn (the boundary
        // while older pages remain, none once the gap under a find hit joins), a turn page holds whole turns.
        const cards=itemPaging?cardRowsFromItemEntries(data,{activeTurnId}):cardRowsFromTurns(data,{activeTurnId}),cardMerge=itemPaging?{mode:"older",complete:itemPageCompleteness(page?.data||[],nextCursor)}:{mode:"replace",complete:true};
        const storeCards=boundaryTurnId=>setTurnActivity(prev=>{if(prev.threadId!==threadId)return prev;const next=mergeTurnActivity(prev,cards,cardMerge);return boundaryTurnId===undefined||next.boundaryTurnId===boundaryTurnId?next:{...next,boundaryTurnId}});
        // Older turns go in front of the turn order (a run that lies apart from it, above a find hit, is told apart by the gap).
        setTurnOrder(prev=>prev.threadId===threadId?{...prev,ids:prependTurnOrder(prev.ids,turnIdsOldestFirst(outcomeTurns))}:prev);
        if(above){
          // Older turns join the detached hit's group; the gap below it is unchanged.
          if(earlier.length)setMessages(current=>mergeHistoryMessages(earlier,current));storeCards(undefined);
          const grown={...detached,ids:[...detached.ids,...earlier.map(message=>String(message.id))],turnIds:[...detached.turnIds,...pageTurnIds],cursor:nextCursor};
          setHistoryPage(current=>current.threadId===threadId?{...current,loading:false,detached:grown}:current);
          return;
        }
        if(detached){
          const step=historyGapPage(detached,{earlier,pageTurnIds,nextCursor,windowTurnIds});
          setMessages(current=>mergeHistoryGapMessages(current,detached,earlier,step.joined));storeCards(itemPaging?(step.joined?null:itemPageBoundaryTurnId(page?.data||[],nextCursor)):undefined);
          setHistoryPage(current=>current.threadId===threadId?{...current,loading:false,nextCursor:step.nextCursor,itemPaging:step.itemPaging??current.itemPaging,detached:step.detached}:current);
          return;
        }
        if(earlier.length)setMessages(current=>mergeHistoryMessages(earlier,current));storeCards(itemPaging?itemPageBoundaryTurnId(page?.data||[],nextCursor):undefined);
        setHistoryPage(current=>({threadId,nextCursor,paginated:true,itemPaging,itemHistory:current.threadId===threadId&&Boolean(current.itemHistory),loading:false,detached:null}));
      }catch(error){
        setHistoryPage(current=>current.threadId===threadId?{...current,loading:false,error:{at,text:(at==="gap"?"Could not load these turns: ":"Could not load earlier messages: ")+(error.message||String(error))}}:current);
      }
    })();
    historyLoadRef.current=run;run.then(()=>{if(historyLoadRef.current===run)historyLoadRef.current=null});
    return run;
  }
  // A hit older than the loaded pages joins them when no turn lies between (paging then goes on above it). Otherwise it leads the
  // list apart from them, with a marker in the gap that counts the turns between (from metadata pages) and loads them.
  async function placeFoundHistory(threadId,occurrence,found,stale){
    const page=historyPage.threadId===threadId?historyPage:null,detached=page?.detached||null,detachedIds=new Set((detached?.ids||[]).map(String));
    const windowTurnIds=[...new Set(messages.filter(message=>!detachedIds.has(String(message.id))).map(message=>message.turnId).filter(Boolean).map(String))];
    const turnId=String(occurrence.turnId||found[0]?.turnId||"");
    if(!page?.nextCursor||!occurrence.turnCursor||windowTurnIds.includes(turnId)){setMessages(current=>mergeHistoryMessages(found,current));return}
    const [earlierCursor,missing]=await Promise.all([
      // The cursor of the turn before the hit, to load what lies above it (failing that, the hit's own cursor: its repeat is dropped).
      // The page holds the hit's own turn, which says how that turn ended.
      rpc.request("thread/turns/list",{threadId,cursor:occurrence.turnCursor,limit:1,sortDirection:"desc",itemsView:"notLoaded"}).then(result=>{setTurnInfo(prev=>mergeTurnOutcomes(prev,threadId,result?.data||[]));return result?.nextCursor||null},()=>occurrence.turnCursor),
      countUnloadedTurns((method,params)=>rpc.request(method,params),{threadId,turnCursor:occurrence.turnCursor,turnId,loadedTurnIds:windowTurnIds}).catch(()=>null),
    ]);
    if(stale())return;
    if(missing&&!missing.count&&!missing.more){
      setMessages(current=>mergeHistoryMessages(found,current.filter(message=>!detachedIds.has(String(message.id)))));
      setHistoryPage(current=>current.threadId===threadId?{...current,nextCursor:earlierCursor,itemPaging:false,detached:null,error:null}:current);
      return;
    }
    // What the buttons load changes with the hit, so a failure said at them before goes.
    setMessages(current=>detachHistoryTurn(current,detached?.ids,found));
    setHistoryPage(current=>current.threadId===threadId?{...current,detached:{ids:found.map(message=>String(message.id)),turnIds:turnId?[turnId]:[],cursor:earlierCursor,missing},error:null}:current);
  }
  function openThreadFind(){
    if(!runtimeCapabilities.threadSearch||!activeThreadRef.current?.id)return;
    setThreadFind(current=>({...current,open:true,error:""}));
  }
  function closeThreadFind(){
    threadFindSeqRef.current++;
    setThreadFind({open:false,query:"",results:[],index:-1,nextCursor:null,loading:false,error:"",activeItemId:null});
  }
  async function focusThreadFindOccurrence(occurrence,expectedSeq=null,afterPage=false){
    if(!occurrence||!runtimeCapabilities.threadSearch||!rpc||rpcStatus!=="connected")return;
    const threadId=activeThreadRef.current?.id;if(!threadId)return;
    const itemId=String(occurrence.itemId||"");
    const stale=()=>activeThreadRef.current?.id!==threadId||(expectedSeq!=null&&expectedSeq!==threadFindSeqRef.current);
    if(itemId&&!messages.some(message=>String(message.id)===itemId)){
      // A history page still loading changes where the hit belongs: place it once that page has landed and rendered.
      if(historyLoadRef.current&&!afterPage){await historyLoadRef.current;await new Promise(resolve=>requestAnimationFrame(resolve));return focusThreadFindLatest(occurrence,expectedSeq,true)}
      // Paging waits while the hit is placed, for the same reason.
      const holdPaging=historyPage.threadId===threadId&&!historyPage.loading;
      if(holdPaging)setHistoryPage(current=>current.threadId===threadId&&!current.loading?{...current,loading:"find"}:current);
      try{
        // The hit's turn's card: the steps its scan read, the turn's first ones (all of them when it reached the turn's end), or the whole
        // turn from its page.
        let found=[],scanned=[],scanEnded=false,foundTurns=null;
        if(historyPage.itemPaging){
          try{
            let cursor=null;
            for(let pageIndex=0;pageIndex<HISTORY_ITEM_SCAN_PAGES;pageIndex++){
              const page=await rpc.request("thread/items/list",{threadId,turnId:occurrence.turnId,cursor,limit:HISTORY_ITEM_PAGE_LIMIT,sortDirection:"asc"});
              found=mergeHistoryMessages(found,historyFromItemEntries(page?.data||[],checkpointByTurn));scanned.push(...(page?.data||[]));scanEnded=!page?.nextCursor;
              if(found.some(message=>String(message.id)===itemId)||!page?.nextCursor)break;
              cursor=page.nextCursor;
            }
          }catch{}
        }
        if(!found.some(message=>String(message.id)===itemId)&&occurrence.turnCursor){
          const page=await rpc.request("thread/turns/list",{threadId,cursor:occurrence.turnCursor,limit:1,itemsView:"full"});
          found=mergeHistoryMessages(found,historyFromTurns(page?.data||[],checkpointByTurn));foundTurns=page?.data||[];
          setTurnInfo(prev=>mergeTurnOutcomes(prev,threadId,page?.data||[]));
        }
        if(stale())return;
        if(scanned.length&&occurrence.turnId)setTurnActivity(prev=>prev.threadId===threadId?mergeTurnActivity(prev,cardRowsFromItemEntries(scanned,{activeTurnId,turnId:occurrence.turnId}),{mode:"first",complete:scanEnded}):prev);
        if(foundTurns?.length)setTurnActivity(prev=>prev.threadId===threadId?mergeTurnActivity(prev,cardRowsFromTurns(foundTurns,{activeTurnId}),{mode:"replace",complete:true}):prev);
        if(found.length)await placeFoundHistory(threadId,occurrence,found,stale);
      }finally{
        if(holdPaging)setHistoryPage(current=>current.loading==="find"?{...current,loading:false}:current);
      }
    }
    if(stale())return;
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
      if(threadFind.index<=0)return;
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
    let thread=threads.find(item=>item.id===reference.threadId)||null,readError=null;
    if(!thread){
      try{
        const read=await rpc.request("thread/read",{threadId:reference.threadId,includeTurns:false});
        thread=read?.thread||null;
      }catch(error){readError=error}
    }
    const archived=Boolean(reference.archived||thread?.archived);
    if(archived){
      let restored;
      try{restored=await rpc.request("thread/unarchive",{threadId:reference.threadId})}
      catch(error){throw new Error("Could not restore archived thread: "+(error?.message||String(error)),{cause:error})}
      if(!restored?.thread&&!thread)throw new Error("The agent runtime did not return the restored thread.");
      thread=restored?.thread||thread;
      if(!thread){
        const read=await rpc.request("thread/read",{threadId:reference.threadId,includeTurns:false});
        thread=read?.thread||null;
      }
      await updateThreadMeta(reference.threadId,{archived:false});
      if(thread)thread={...thread,archived:false};
    }
    if(!thread&&readError)throw new Error("Could not load linked thread: "+(readError?.message||String(readError)));
    if(!thread)throw new Error("Linked thread was not found.");
    setThreads(prev=>[thread,...prev.filter(item=>item.id!==thread.id)]);
    await openThread(thread);
  }
  async function reloadActiveThread(){if(activeThread)await openThread(activeThread)}
  // A send's new worktree, and a background send's, are made by turn-support.js: a send's in New worktree mode only, a background
  // send's also when it asks for one (force).
  async function prepareWorktree(basePath,modelId,options){
    if(workspaceMode!=="worktree")return basePath;
    return (await loadTurnSupport()).prepareWorktree({setWorktreeSetup,touchProject,setPanel,showActionError,worktreeCardErrors:WORKTREE_CARD_ERRORS},basePath,modelId,options);
  }
  async function prepareDetachedWorktree(basePath,modelId,{force=false,environmentId=workspaceEnvironmentId}={}){
    if(!force&&workspaceMode!=="worktree")return basePath;
    return (await loadTurnSupport()).prepareDetachedWorktree({showActionError},basePath,modelId,{environmentId});
  }
  function specializedToolAvailability({projectless=projectlessMode}={}){
    const desktopTools=desktopBridgeToolAvailability(window.trebellDesktop);
    return {
      browser:desktopTools.browser,
      computer:desktopTools.computer,
      sourceControl:!projectless,
      delegation:Boolean(runtimeCapabilities.delegation&&runtimeCapabilities.dynamicTools),
      process:Boolean(runtimeCapabilities.backgroundProcesses&&runtimeCapabilities.dynamicTools),
    };
  }
  function dynamicToolNamespacesForTask(taskText,{projectless=projectlessMode}={}){
    if(!runtimeCapabilities.dynamicToolExpansion)return [];
    return specializedToolNamespaceNames(taskText,specializedToolAvailability({projectless}));
  }
  async function createThreadFor(modelId,cwd,{projectless=projectlessMode,taskText=""}={}){
    const p=presetFor(permissionMode);
    const specializedTools=specializedToolSelection(taskText,specializedToolAvailability({projectless}));
    const {sharedDynamicToolNamespaces}=await loadSharedToolCatalog();
    const dynamicTools=sharedDynamicToolNamespaces(specializedTools);
    const researchInstruction="Web research is available when useful. Use it when current or external information materially improves the task."+(specializedTools.browser?" Use trebell_browser for interactive pages.":"")+(runtimeCapabilities.dynamicTools?" Use trebell_repo for deterministic symbol and structural repository lookups when that is faster than manual exploration.":"")+(specializedTools.delegation?" Trebell delegation is available for bounded parallel child tasks; use it only when parallelism materially helps, prefer explicit ownership and budgets, and do not create agent swarms.":"");
    const developerInstructions=projectless
      ?"This is a Trebell General chat with no attached project or repository. The working directory is an app-managed scratch workspace. Do not assume it is a codebase, repository, or user project. "+researchInstruction
      :researchInstruction;
    let nativeProjectId=null;
    if(runtimeCapabilities.projectOwnership&&!bootstrap.mock&&!projectless&&!workspaceEnvironmentId){
      let trebellProject=currentProject&&sameWorkspacePath(currentProject.path,cwd)?currentProject:null;
      if(!trebellProject){
        let listed={projects:[]};
        try{listed=await api("/api/projects")}
        catch(error){showActionError(error,"Could not sync runtime project identity")}
        trebellProject=(listed.projects||[]).find(project=>!project.environmentId&&sameWorkspacePath(project.path,cwd))||null;
      }
      try{nativeProjectId=(await ensureRuntimeProject(rpc,{trebellProject,cwd}))?.id||null}
      catch(error){showActionError(error,"Could not sync runtime project identity")}
    }
    const result=await rpc.request("thread/start",{model:modelId,...(agentRuntime==="native"?{modelProvider:provider}:{}),cwd,projectless,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...harnessThreadOptions(agentRuntime,{permissionMode}),...(nativeProjectId?{projectId:nativeProjectId}:{}),approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,ephemeral:false,threadSource:"trebell-code",dynamicTools,developerInstructions});
    if(agentRuntime!=="codex"&&result.thread?.providerMeta){setProviderAgent(result.thread.agent||providerAgent||"");applyProviderInventory(harnessInventory(runtimeInventoryRef.current,result.thread.providerMeta))}
    if(result.thread?.id)await persistThreadWorkspaceContext(result.thread,cwd,{sectionName:"Active",archived:false,projectless},{strict:true}).catch(error=>showActionError(error,"Could not save thread workspace context"));
    return result.thread;
  }
  // Codex reads attachments from the paths named in the prompt (T3 Code), with images and audio also sent as items.
  function inputsFor(text,paths){if(agentRuntime==="codex")return codexTurnInput(text,paths,{displayName:attachmentDisplayName});return [{type:"text",text,textElements:[]},...(paths||[]).map(path=>{const lower=String(path).toLowerCase();if(/\.(png|jpe?g|gif|webp|bmp)$/.test(lower))return{type:"localImage",path};if(/\.(mp3|wav|m4a|ogg|flac)$/.test(lower))return{type:"localAudio",path};return{type:"mention",name:String(path).split(/[\\/]/).pop(),path}})]}
  async function loadNativeQueue(client=rpcRef.current,threadId=activeThreadRef.current?.id){
    if(!runtimeCapabilities.nativeQueue||!client||!threadId)return false;
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
    if(!runtimeCapabilities.nativeQueue||!rpc||!activeThread?.id||queueMode==="local")return false;
    await validateAttachmentPaths(paths||[]);
    try{
      const input=inputsFor(text,paths);
      const dynamicToolNamespaces=dynamicToolNamespacesForTask(text,{projectless:Boolean(activeThread.providerMeta?.projectless??projectlessMode)});
      if(queuedId){
        const result=await rpc.request("thread/queue/update",{threadId:activeThread.id,queuedSubmissionId:queuedId,input,dynamicToolNamespaces});
        const draft={...queuedSubmissionDraft(result?.queuedSubmission||{}),contextChips:[...(chips||[])],model};
        setQueued(previous=>previous.map(item=>item.id===queuedId?draft:item));setQueuedEditId(null);
      }else{
        const clientUserMessageId="trebell-queue-"+crypto.randomUUID();
        const result=await rpc.request("thread/queue/add",{threadId:activeThread.id,input,clientUserMessageId,dynamicToolNamespaces});
        const draft={...queuedSubmissionDraft(result?.queuedSubmission||{}),contextChips:[...(chips||[])],model};
        setQueued(previous=>[...previous.filter(item=>item.id!==draft.id),draft]);
      }
      setQueueMode("native");return true;
    }catch(error){
      if(nativeQueueUnavailable(error)){setQueueMode("local");setQueuedEditId(null);return false}
      throw error;
    }
  }
  function reportCheckpointIssue(message,error,raw={}){
    const detail=error?.message||String(error)||"Unknown checkpoint error";
    setEvents(prev=>[...prev,{id:"checkpoint-error-"+Date.now()+"-"+Math.random().toString(36).slice(2,6),kind:"error",title:message+": "+detail,status:"error",raw:{...raw,error:detail}}]);
  }
  async function maybeAutoCompactBeforeTurn(thread){
    if(!thread?.id||!runtimeCapabilities.compaction||rpcStatus!=="connected")return {attempted:false,compacted:false,decision:null,error:null};
    const usage=threadTelemetryRef.current[thread.id]?.tokenUsage||(activeThread?.id===thread.id?tokenUsage:null);
    const decision=autoCompactionDecision(usage,{enabled:settings.autoCompactContext===true,thresholdPercent:settings.autoCompactThresholdPercent??85});
    if(!decision.shouldCompact)return {attempted:false,compacted:false,decision,error:null};
    try{
      await requestThreadCompaction(thread.id,agentRuntime==="grok"?{timeoutMs:10*60_000}:undefined);
      updateThreadTelemetry(thread.id,{tokenUsage:null,lastActivityAt:Date.now()});
      if(activeThreadRef.current?.id===thread.id)setTokenUsage(null);
      return {attempted:true,compacted:true,decision,error:null};
    }catch(error){
      return {attempted:true,compacted:false,decision,error};
    }
  }
  // A packet that could not be made, also for want of turn-support.js: the send goes on without it, and its activity says why.
  async function contextUnavailable(thread,error,{background=false}={}){
    const detail=error?.message||String(error)||"Unknown context error";
    await updateThreadMeta(thread.id,{trebellContextError:{message:detail,at:Date.now(),runtime:agentRuntime}}).catch(()=>{});
    if(!background)setEvents(prev=>[...prev,{id:"context-error-"+Date.now(),kind:"error",title:"Trebell repository context unavailable: "+detail,status:"error",raw:{error:detail}}]);
    return null;
  }
  // The repository context a send carries is made by turn-support.js. Once that module has loaded (from idle after the first paint)
  // the packet is asked for at once, while the send makes its checkpoint; a send made before then asks for it once the module has come.
  async function prepareTurnContext(thread,cwd,text,paths,{projectless=projectlessMode,background=false,ignoreUsage=false,ready=true}={}){
    if(projectless||bootstrap.mock||!thread?.id||!cwd)return null;
    let support=turnSupport;
    if(!support)try{support=await loadTurnSupport()}
    catch(error){if(!await ready)return null;return contextUnavailable(thread,error,{background})}
    return support.prepareTurnContext({agentRuntime,activeThread,tokenUsage,threadMeta,workspaceEnvironmentId,threadTelemetryRef,contextTaskRef,updateThreadMeta,showActionError,setEvents,contextUnavailable},thread,cwd,text,paths,{background,ignoreUsage,ready});
  }
  function assertTurnModel(modelId){
    if(runtimeSwitchRef.current)throw new Error(`Trebell is switching to ${agentRuntimeName(runtimeSwitchRef.current.to)}; send again once it is ready.`);
    if(!modelsRef.current.includes(modelId))throw new Error(`${agentRuntimeLabel} does not list the model ${modelId||"(none selected)"}. Choose one of its models and send again.`);
  }
  // T3 runGoalCommand: a Codex goal turns active once its first turn has started, unless Stop came first.
  async function activateCodexGoal(activation){
    try{
      if(activation.stopped)return;
      let current=(await rpc.request("thread/goal/set",{threadId:activation.threadId,status:"active"}))?.goal||null;
      if(activation.stopped)current=(await rpc.request("thread/goal/set",{threadId:activation.threadId,status:"paused"}))?.goal||current;
      if(activeThreadRef.current?.id===activation.threadId)setGoal(current);
    }catch(error){
      setEvents(prev=>[...prev,{id:"goal-start-error-"+Date.now(),kind:"error",title:"The turn started, but Codex could not make the goal active: "+(error.message||String(error)),status:"done",raw:{}}]);
    }finally{if(codexGoalActivationRef.current===activation)codexGoalActivationRef.current=null}
  }
  // A Stop pressed before its send's turn started is sent once to that turn, as soon as the harness can take it: turn/started, or
  // turn/start's answer for a turn it has not queued; one that fails gives the Stop back. The Stop is then the turn's, so a press for
  // the turn sends nothing more.
  function interruptStoppedSend(send,threadId,turnId){
    if(!send?.stopped||send.interrupted||!turnId||send.threadId!==String(threadId||""))return;send.interrupted=true;
    if(stopKeyRef.current===send)stopKeyRef.current=send.threadId+"\0"+turnId;
    turnNotesRef.current.stopSent(send.threadId,turnId);
    rpcRef.current?.request("turn/interrupt",{threadId,turnId}).catch(error=>{turnNotesRef.current.stopFailed(send.threadId,turnId);holdQueue(send.threadId,false);if(String(activeThreadRef.current?.id||"")===send.threadId){stopKeyRef.current=null;setStoppingThreadId(null)}showActionError(error,"Could not stop turn")});
  }
  // pressed: the presses counted at the press that sent it (terminal-keyboard.js), as of which its new worktree's setup terminal asks
  // for the keyboard when it opens the drawer, seconds later. sentChips: the context chips that went with it, which leave the composer
  // with its files once it has gone: a follow-up's own (the queue's, Send now's), none for a goal resumed, and otherwise the composer's
  // as the send was made (a recipe, a goal set). The composer's chips as the queue started a follow-up went, a chip cited there
  // meanwhile for the next message among them, and their files stayed on the shelf as plain attachments.
  async function startTurn(text,paths,modelId=model,threadOverride=null,cwdOverride=null,focusPathsOverride=null,{permissionModeOverride=null,additionalContext=null,goalPatch=null,toolAllowlist=null,goalResume=false,sentChips=goalResume?[]:contextChips,pressed=terminalPresses()}={}){
    // The view the send was made from: its composer's hold (send()) and the open count (openThread, newChat). A new task's send keeps
    // that view only while no thread is shown or opening and the hold is still its own (another thread opened, or a new task opened
    // from one, released it); with no hold, while nothing was opened since.
    const sendView=submittingRef.current,sendOpen=openSeqRef.current;
    const newTaskShown=()=>!activeThreadRef.current&&!openingThreadRef.current&&(sendView?submittingRef.current===sendView:openSeqRef.current===sendOpen);
    assertTurnModel(modelId);
    if(!projectlessMode&&!threadOverride&&(cwdOverride||projectPath)===projectPath)await waitForActiveClone();
    await validateAttachmentPaths(paths||[]);
    if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");let thread=threadOverride||activeThread;let cwd=cwdOverride||projectPath||bootstrap.cwd;
    const autoCompaction=thread?await maybeAutoCompactBeforeTurn(thread):{attempted:false,compacted:false,decision:null,error:null};
    // A thread the send creates keeps its turns' cards from its first turn on, as an opened thread does. Trebell's tool catalog comes
    // first: a send that cannot start for want of it sets nothing up (no worktree, no thread). A new task left while its thread was
    // being made (another thread opened meanwhile) stays as the person left it: the thread starts on its own in the sidebar, and its
    // send shows there when it is opened (openThread).
    if(!thread){
      await loadSharedToolCatalog();
      if(!projectlessMode)cwd=await prepareWorktree(cwd,modelId,{owns:newTaskShown,pressed});
      thread=await createThreadFor(modelId,cwd,{projectless:projectlessMode,taskText:text});
      setThreads(prev=>prependThread(prev,thread));
      if(newTaskShown()){activeThreadRef.current=thread;setActiveThread(thread);setTurnActivity(emptyTurnActivity(thread.id));setProjectPath(cwd)}
    }
    const shown=()=>activeThreadRef.current?.id===thread.id;
    // The live card leaves the last turn here: until the new turn starts it lists only this send's notices, under no turn's name.
    const clientId="user-"+Date.now()+"-"+Math.random().toString(36).slice(2,7),sentMessage={id:clientId,role:"user",text,attachments:paths};
    if(shown()){if(!goalResume){followConversationEnd();setMessages(prev=>[...prev,sentMessage])}setCardTurnId(null);setEvents(autoCompaction.attempted?[{id:"auto-compact-"+thread.id,kind:autoCompaction.error?"error":"contextCompaction",title:autoCompaction.error?"Automatic context compaction failed; continuing: "+(autoCompaction.error.message||String(autoCompaction.error)):"Context compacted automatically before this turn",status:"done",raw:autoCompaction.decision||{}}]:[]);resetAssistantStream();setRunning(true)}
    // Until turn/start answers the send has no turn for Stop to name, and a harness that has to start first can take a minute: Stop
    // meanwhile marks this send stopped (stop()), so it sends nothing more, and a turn the harness started before the Stop reached it
    // is stopped as soon as it is named.
    const pendingSend={threadId:String(thread.id),requested:false,stopped:false,interrupted:false,view:sendView,message:goalResume?null:sentMessage},pendingSends=pendingSendsRef.current;pendingSends.set(pendingSend.threadId,pendingSend);
    // The context packet only reads files, so the server builds it while the checkpoint is made and the goal set; reached says the
    // send got to it.
    let reached=()=>{};const contextReady=prepareTurnContext(thread,cwd,text,focusPathsOverride||repositoryFocusPaths(paths,contextChips),{projectless:projectlessMode,ignoreUsage:autoCompaction.compacted,ready:new Promise(resolve=>{reached=resolve})});
    try{
      let checkpoint=null;
      if(!projectlessMode){
        try{checkpoint=await api("/api/checkpoints",{method:"POST",body:{cwd,threadId:thread.id,label:text.slice(0,80)}})}
        catch(error){reportCheckpointIssue("Could not create file checkpoint; file restore for this turn is unavailable",error,{threadId:thread.id,cwd})}
      }
      // Codex runs an active goal's turns itself, so a Codex goal stays paused until this, its first turn, has started
      // (T3 Code's runGoalCommand); the turn still carries Trebell's guidance for the goal, and Stop cancels the activation.
      const goalActivation=goalPatch&&agentRuntime==="codex"&&(goalPatch.status??"active")==="active"?{threadId:thread.id,stopped:false}:null;
      let goalContext=null;
      if(goalPatch){
        if(goalActivation)codexGoalActivationRef.current=goalActivation;
        const goalResult=await rpc.request("thread/goal/set",{threadId:thread.id,...goalPatch,...(goalActivation?{status:"paused"}:{})});pendingSend.goalSet=true;
        if(activeThreadRef.current?.id===thread.id)setGoal(goalResult?.goal||null);
        // The goal's guidance loads only for this first turn of a Codex goal (goal-context.js); should it not load, the send fails as
        // any other send does after the goal is set.
        if(goalActivation&&goalResult?.goal){const {goalAdditionalContext}=await import("./goal-context.js");goalContext=goalAdditionalContext({},{...goalResult.goal,status:"active"})}
      }
      const p=presetFor(permissionModeOverride||permissionMode);
      const sandboxPolicy=p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:{type:"workspaceWrite",writableRoots:[cwd],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
      const reasoningEffort=configuredReasoningEffort(settings,agentRuntime,provider,modelId,modelMeta?.[modelId]||{});
      const serviceTier=configuredModelServiceTier(settings,agentRuntime,provider,modelId);
      const codexChoices=agentRuntime==="codex"?codexChoicesFor(modelId,thread.id):null,collaboration=selectedCollaborationMode(modelId,{effort:codexChoices?.effort||null});
      reached(true);const contextPacket=await contextReady;
      const turnContext={...repositoryContextEntries(contextPacket,{seedOnly:agentRuntime==="native",currentTask:text}),...(goalContext||{}),...(additionalContext||{})};
      const dynamicToolNamespaces=dynamicToolNamespacesForTask(text,{projectless:Boolean(thread.providerMeta?.projectless??projectlessMode)});
      if(pendingSend.stopped)throw sendStoppedError();pendingSend.requested=true;
      const result=await rpc.request("turn/start",{threadId:thread.id,model:modelId,...(agentRuntime==="native"?{modelProvider:provider,...(reasoningEffort?{reasoningEffort}:{}),...(serviceTier?{serviceTier}:{})}:{}),cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...(codexChoices?.effort?{effort:codexChoices.effort}:{}),...(codexChoices?.serviceTier?{serviceTier:codexChoices.serviceTier}:{}),...harnessTurnOptions(agentRuntime,{permissionMode:permissionModeOverride||permissionMode,reasoningEffort,serviceTier,modelOptions:configuredModelOptions(settings,agentRuntime,provider,modelId,modelMeta?.[modelId]||{})}),...(collaboration?{collaborationMode:collaboration}:{}),approvalPolicy:p.approvalPolicy,sandboxPolicy,input:goalResume?[]:inputsFor(text,paths),...(dynamicToolNamespaces.length?{dynamicToolNamespaces}:{}),...(Array.isArray(toolAllowlist)&&toolAllowlist.length?{toolAllowlist}:{}),...(Object.keys(turnContext).length?{additionalContext:turnContext}:{})});const turnId=result?.turn?.id||null;if(shown())setActiveTurnId(turnId);if(turnId&&turnStillRuns(result.turn))markThreadTurn(thread.id,true);
      // The thread runs a turn again, so a queue a Stop held goes on once it ends.
      if(!pendingSend.stopped)holdQueue(thread.id,false);
      // An answer with no start time names a turn Codex has queued, which it can interrupt only once it has started it (turn/started;
      // T3 Code waits for that too): the send stays until then, through as far as the composer goes. Any other answer ends it.
      const queued=Boolean(turnId)&&result.turn.startedAt===null&&!pendingSend.startedTurnId&&turnStillRuns(result.turn)&&pendingSends.get(pendingSend.threadId)===pendingSend;
      if(queued){pendingSend.turnId=String(turnId);pendingSend.view=null;pendingSend.message=null}
      else{if(pendingSends.get(pendingSend.threadId)===pendingSend)pendingSends.delete(pendingSend.threadId);if(turnStillRuns(result.turn))interruptStoppedSend(pendingSend,thread.id,turnId)}
      if(goalActivation)await activateCodexGoal(goalActivation);
      if(turnId){const key=turnInfoKey(thread.id,turnId),mode=permissionModeLabel(permissionModeOverride||permissionMode),sentModel=modelMeta?.[modelId]?.name||compactModelLabel(modelId);if(key&&(mode||sentModel))setTurnInfo(prev=>({...prev,[key]:{...prev[key],...(sentModel?{model:sentModel}:{}),...(mode?{mode}:{})}}))}
      // The files and context sent leave the composer once the send has gone; what the person added there meanwhile (a screenshot
      // pasted while it said Sending…) stays for the next message.
      setMessages(prev=>prev.map(m=>m.id===clientId?{...m,turnId,checkpointId:checkpoint?.id||null}:m));if(checkpoint?.id&&turnId){try{await api("/api/checkpoints/link",{method:"POST",body:{id:checkpoint.id,patch:{turnId}}});setCheckpointByTurn(prev=>({...prev,[turnId]:{...checkpoint,turnId}}))}catch(error){reportCheckpointIssue("File checkpoint was created but could not be linked to this turn; restore may be unavailable after reload",error,{threadId:thread.id,turnId,checkpointId:checkpoint.id})}}if(shown())dropSentDraft({attachments:paths,contextChips:sentChips});return{thread,turnId};
    }catch(error){
      if(pendingSends.get(pendingSend.threadId)===pendingSend)pendingSends.delete(pendingSend.threadId);
      if(pendingSend.stopped&&error&&typeof error==="object")error.trebellSendStopped=true;
      // A failure after the goal was set says so (runCodexGoalCommand): the goal stays set.
      if(pendingSend.goalSet&&error&&typeof error==="object")error.trebellGoalSet=true;
      if(error&&typeof error==="object")error.trebellSendThreadId=pendingSend.threadId;
      reached(false);setMessages(prev=>prev.filter(message=>message.id!==clientId));
      // A send that ends while another view is shown leaves that view as it is.
      if(activeThreadRef.current?.id===thread.id){setRunning(false);setActiveTurnId(null)}
      if(codexGoalActivationRef.current?.threadId===thread.id)codexGoalActivationRef.current=null;
      throw error;
    }
  }
  async function startDetachedTurn(text,paths,modelId=model,{forceWorktree=false,basePath=null,projectless=projectlessMode,focusPaths=null}={}){
    assertTurnModel(modelId);
    await validateAttachmentPaths(paths||[]);if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");
    let cwd=basePath||projectPath||bootstrap.cwd;if(!cwd)throw new Error(projectless?"Could not prepare the General chat workspace.":"Choose a project before starting background work.");
    // Trebell's tool catalog comes before the worktree, so a task that cannot start for want of it leaves no worktree behind.
    await loadSharedToolCatalog();
    if(!projectless)cwd=await prepareDetachedWorktree(cwd,modelId,{force:forceWorktree,environmentId:workspaceEnvironmentId});
    let thread=null;let turnRequestStarted=false;
    try{
      thread=await createThreadFor(modelId,cwd,{projectless,taskText:text});if(!thread?.id)throw new Error("Agent harness did not create a background thread");
      backgroundThreadsRef.current.add(thread.id);setThreads(prev=>[thread,...prev.filter(item=>item.id!==thread.id)]);
      // The context packet only reads files, so it is built while the checkpoint is made.
      const contextReady=prepareTurnContext(thread,cwd,text,focusPaths||repositoryFocusPaths(paths,contextChips),{projectless,background:true});
      let checkpoint=null;
      if(!projectless){
        try{checkpoint=await api("/api/checkpoints",{method:"POST",body:{cwd,threadId:thread.id,label:text.slice(0,80)}})}
        catch(error){reportCheckpointIssue("Could not create background file checkpoint; file restore for this turn is unavailable",error,{threadId:thread.id,cwd})}
      }
      const p=presetFor(permissionMode);
      const sandboxPolicy=p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:{type:"workspaceWrite",writableRoots:[cwd],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
      const reasoningEffort=configuredReasoningEffort(settings,agentRuntime,provider,modelId,modelMeta?.[modelId]||{});
      const serviceTier=configuredModelServiceTier(settings,agentRuntime,provider,modelId);
      turnRequestStarted=true;
      const codexChoices=agentRuntime==="codex"?codexChoicesFor(modelId,thread.id):null,collaboration=selectedCollaborationMode(modelId,{effort:codexChoices?.effort||null});
      const contextPacket=await contextReady,contextEntries=repositoryContextEntries(contextPacket,{seedOnly:agentRuntime==="native",currentTask:text});
      const result=await rpc.request("turn/start",{threadId:thread.id,model:modelId,...(agentRuntime==="native"?{modelProvider:provider,...(reasoningEffort?{reasoningEffort}:{}),...(serviceTier?{serviceTier}:{})}:{}),cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...(codexChoices?.effort?{effort:codexChoices.effort}:{}),...(codexChoices?.serviceTier?{serviceTier:codexChoices.serviceTier}:{}),...harnessTurnOptions(agentRuntime,{permissionMode,reasoningEffort,serviceTier,modelOptions:configuredModelOptions(settings,agentRuntime,provider,modelId,modelMeta?.[modelId]||{})}),...(collaboration?{collaborationMode:collaboration}:{}),approvalPolicy:p.approvalPolicy,sandboxPolicy,input:inputsFor(text,paths),...(Object.keys(contextEntries).length?{additionalContext:contextEntries}:{})});const turnId=result?.turn?.id||null;
      // The sidebar row shows the task running even when the harness sends no turn/started for a thread that is not open.
      if(turnId&&turnStillRuns(result.turn))markThreadTurn(thread.id,true);
      if(checkpoint?.id&&turnId)try{await api("/api/checkpoints/link",{method:"POST",body:{id:checkpoint.id,patch:{turnId}}})}catch(error){reportCheckpointIssue("Background file checkpoint was created but could not be linked to its turn; restore may be unavailable after reload",error,{threadId:thread.id,turnId,checkpointId:checkpoint.id})}
      return {thread,turnId,cwd};
    }catch(error){
      const mayHaveSucceeded=!error?.trebellRpcResponse;
      let uncertainThread=thread;const verificationErrors=[];
      if(mayHaveSucceeded&&!uncertainThread?.id){
        for(let attempt=0;attempt<3&&!uncertainThread;attempt++){
          if(attempt)await new Promise(resolve=>setTimeout(resolve,250));
          try{
            const listed=await rpc.request("thread/list",threadListParams(100));
            uncertainThread=threadForWorktree(listed.data||[],cwd);
          }catch(listError){verificationErrors.push(listError)}
        }
        if(uncertainThread?.id){backgroundThreadsRef.current.add(uncertainThread.id);setThreads(prev=>[uncertainThread,...prev.filter(item=>item.id!==uncertainThread.id)])}
      }
      const failure=error instanceof Error?error:new Error(String(error));
      if(mayHaveSucceeded&&(uncertainThread?.id||turnRequestStarted||verificationErrors.length))failure.trebellUncertain={threadId:uncertainThread?.id||null,cwd,model:modelId,phase:turnRequestStarted?"turn":"thread",verificationError:verificationErrors.at(-1)?.message||null};
      throw failure;
    }
  }
  async function delegateTask(rawSpec){
    if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");
    const parent=activeThreadRef.current;if(!parent?.id)throw new Error("Open a parent thread before delegating work.");
    if(rawSpec?.model&&!models.includes(rawSpec.model))throw new Error("Delegation model is not available in the active runtime: "+rawSpec.model);
    const result=await rpc.request("thread/delegate",{threadId:parent.id,...rawSpec});
    if(result?.thread?.id){
      backgroundThreadsRef.current.add(result.thread.id);
      setThreads(previous=>[result.thread,...previous.filter(item=>item.id!==result.thread.id)]);
      const meta=await api("/api/thread-meta?threadId="+encodeURIComponent(result.thread.id)).catch(()=>null);
      if(meta)setThreadMeta(previous=>({...previous,[result.thread.id]:meta}));
    }
    try{
      const refreshed=(await rpc.request("thread/goal/get",{threadId:parent.id}))?.goal||null;
      if(activeThreadRef.current?.id===parent.id)setGoal(refreshed);
    }catch{}
    return result;
  }
  // The files and context chips that went with a send leave the composer, each chip with its file (addContextPath), so a chip never
  // goes while its file stays on the shelf as a plain attachment.
  function dropSentDraft(draft){
    const sentChips=draft?.contextChips||[],files=new Set([...(draft?.attachments||[]),...sentChips.map(item=>item?.path).filter(Boolean)]),chips=new Set(sentChips.map(item=>typeof item==="string"?item:JSON.stringify(item)));
    if(files.size)setAttachments(current=>current.filter(path=>!files.has(path)));
    if(chips.size)setContextChips(current=>current.filter(item=>!chips.has(typeof item==="string"?item:JSON.stringify(item))));
  }
  // The files and context of a send still on its way, back beside what the composer holds (its text is in the conversation).
  function returnSentDraft(draft){if(draft&&(draft.attachments?.length||draft.contextChips?.length))restoreFailedDraft({attachments:draft.attachments,contextChips:draft.contextChips})}
  // A send from the composer that does not go (it failed, Stop ended it, or it was kept: a harness switch, a check that failed) gives
  // its draft back before what the person typed on meanwhile, a blank line between, its files and context beside the ones added
  // since. It went back only into an empty composer, so a follow-up typed on after was lost, and a send's under a note that called it
  // a failed background draft, which went into the next message.
  function restoreSentDraft(draft){restoreFailedDraft(draft,"\n\n")}
  function restoreFailedDraft(draft,between="\n\n--- recovered failed background draft ---\n"){
    setPrompt(current=>{
      const next=String(draft?.text||"");if(!next)return current;
      if(!String(current||"").trim())return next;
      if(String(current).includes(next))return current;
      return next.replace(/\s+$/,"")+between+current;
    });
    if(draft?.attachments?.length)setAttachments(current=>[...new Set([...draft.attachments,...(current||[])])]);
    if(draft?.contextChips?.length)setContextChips(current=>{
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
  // A fan-out that cannot start keeps the draft ("kept"): the composer gives it back (dispatchSend), or still holds it (sendInBackground).
  async function sendModelFanout(text){
    const fanout=[...new Set(selectedModels.filter(id=>models.includes(id)))];if(activeThread?.id||running||fanout.length<2)return false;
    if(!runtimeCapabilities.multiModelFanout)return false;
    const workspaceError=fanoutWorkspaceError(gitInfo);if(workspaceError){setEvents(prev=>[...prev,{id:"fanout-workspace-"+Date.now(),kind:"error",title:workspaceError,status:"done",raw:{}}]);return "kept"}
    if(prompt.length>MAX_COMPOSER_CHARS){setEvents(prev=>[...prev,{id:"fanout-long-"+Date.now(),kind:"error",title:`Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()} character limit`,status:"done",raw:{}}]);return "kept"}
    if(runtimeCapabilities.videoAttachments===false&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"fanout-video-"+Date.now(),kind:"error",title:agentRuntimeLabel+" does not accept video attachments",status:"done",raw:{}}]);return "kept"}
    try{await validateAttachmentPaths(attachments)}catch(error){setEvents(prev=>[...prev,{id:"fanout-attachment-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return "kept"}
    const draft={text,attachments:[...attachments],contextChips:[...contextChips],projectPath:projectPath||bootstrap.cwd};
    // Its text left the composer as the send started (dispatchSend), or leaves it once the fan-out has launched (sendInBackground); its
    // files and context leave it now, and what was added meanwhile stays.
    setPromptHistoryIndex(-1);dropSentDraft(draft);setEvents([]);resetAssistantStream();setSection("chat");
    const launches=fanout.map(modelId=>startDetachedTurn(draft.text,draft.attachments,modelId,{forceWorktree:true,basePath:draft.projectPath,focusPaths:repositoryFocusPaths(draft.attachments,draft.contextChips)}).then(result=>({ok:true,modelId,result})).catch(error=>({ok:false,modelId,error})));
    // What came of each launch is told once all have answered, by background-send-outcome.js, which loads then: should it not load,
    // the draft of a launch that failed goes back to the composer.
    Promise.all(launches).then(results=>import("./background-send-outcome.js").then(({settleModelFanout})=>settleModelFanout({results,fanout,draft,saveFailureStash,restoreFailedDraft,desktopNotify,addEvents:added=>setEvents(prev=>[...prev,...added])}),error=>{if(results.some(item=>!item.ok))restoreFailedDraft(draft);showActionError(error,"Could not show how the multi-model run went")}));
    return true;
  }
  // A send that starts with "/" may be a command rather than a message (a project's recipe or one of the composer's commands), which
  // turn-support.js runs (runSlashCommand): true when it ran, "kept" when the composer keeps the draft, which goes back (keepDraft), or
  // what the command put there (/plan), false for text that names no command. A send made before that module has loaded waits for it;
  // one that cannot load it is not sent, and the draft is kept. What the person typed while it ran stays, after what comes back.
  async function handleSpecial(text,keepDraft){
    if(!text.startsWith("/"))return null;
    let support;try{support=await loadTurnSupport()}
    catch(error){keepDraft();setComposerAlert({kind:"send",text:"Not sent: "+sentenceText(error.message)+" Your draft is kept."});return "kept"}
    let filled=false;const fill=value=>{filled=true;restoreSentDraft({text:typeof value==="function"?value(""):String(value??"")})};
    const result=await support.runSlashCommand({currentProject,projectPath,workspaceEnvironmentId,permissionMode,setPermissionMode,agentRuntime,agentRuntimeLabel,models,model,attachments,contextChips,running,runtimeCapabilities,rpc,activeThread,activeThreadRef,startTurn,compactContext,startReview,runUserAction,newChat,openRightPanel,openProviderSettings,setPanel,setPaletteOpen,setPrompt:fill,setGoal,setEvents,setComposerAlert},text);
    if(result==="kept"&&!filled)keepDraft();
    return result;
  }
  async function compactContext(){
    if(!runtimeCapabilities.compaction){setEvents(prev=>[...prev,{id:"compact-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not expose generic context compaction`,status:"done",raw:{}}]);return}
    if(!activeThread?.id||!rpc||leavingThread())return;
    const threadId=activeThread.id,id="context-compact-"+threadId;
    // A new compaction's row has no turn until its item names one: the turn of the last compaction, kept, would take it away.
    setEvents(prev=>{const event={id,kind:"contextCompaction",title:"Compacting context",status:"running",raw:{},turnId:null};return prev.some(item=>item.id===id)?prev.map(item=>item.id===id?{...item,...event}:item):[...prev,event]});
    try{
      // Grok compacts in a turn of its own (its /compact command), which takes as long as the model needs.
      await requestThreadCompaction(activeThread.id,agentRuntime==="grok"?{timeoutMs:10*60_000}:undefined);
    }catch(error){
      // The failure ends the compaction's own row, which no turn ends: it would say "Compacting context" beside its failure. That is
      // its item's row once the item came (in its turn's record too, so the turn's card says it failed), else the one Compact put up.
      const failed={kind:"error",title:"Context compaction failed: "+(error.message||String(error)),status:"done"};
      if(activeThreadRef.current?.id!==threadId)return;
      endCompactionRecord(threadId,null,row=>({...row,...failed}));
      setEvents(prev=>{const row=prev.findLast(item=>item.kind==="contextCompaction"&&item.status==="running");return row?prev.map(item=>item===row?{...item,...failed}:item):upsertEvent(prev,{id,...failed,raw:{}})});
    }
  }
  async function dispatchSend(promptOverride=null){
    const visiblePrompt=promptOverride==null?prompt:String(promptOverride),text=visiblePrompt.trim(),sendView=submittingRef.current,pressed=terminalPresses();if(!text)return;
    setComposerAlert(null);
    if(visiblePrompt.length>MAX_COMPOSER_CHARS){setEvents(prev=>[...prev,{id:"prompt-too-long-"+Date.now(),kind:"error",title:`Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()} character limit`,status:"done",raw:{length:visiblePrompt.length}}]);return}
    // The draft's text leaves the composer as the send starts, before the send first waits (a command such as /goal or /compact, a
    // clone that runs, its files checked with the server), so what the person types straight on lands there, for the next message, as
    // the line under the composer says. A send kept here (a harness switch, a check that failed) gives it back before what was typed
    // meanwhile (keepDraft), as one that fails does. The composer held it, read-only, through those waits, and dropped every key typed.
    setPrompt(current=>current===visiblePrompt?"":current);
    const keepDraft=()=>restoreSentDraft({text:visiblePrompt});
    if(text.startsWith("/")){const special=await handleSpecial(text,keepDraft);if(special)return}
    // Nothing new is sent while a harness switch is pending: the server may already run the new harness behind the current transport.
    if(runtimeSwitchRef.current){keepDraft();const label=agentRuntimeName(runtimeSwitchRef.current.to);setEvents(prev=>[...prev.filter(item=>item.id!=="runtime-switching"),{id:"runtime-switching",kind:"error",title:`Trebell is switching to ${label}. Your draft was kept; send it again once ${label} is ready.`,status:"done",raw:{}}]);return}
    // Never route a prompt elsewhere while the harness transport is down: keep the draft until it reconnects.
    if(!bootstrap.mock&&(!rpc||rpcStatus!=="connected")){keepDraft();setEvents(prev=>[...prev.filter(item=>item.id!=="transport-reconnecting"),{id:"transport-reconnecting",kind:"error",title:`${agentRuntimeLabel} is ${transportConnectedRef.current?"reconnecting":"not connected yet"}. Your draft was kept; send it again once ${agentRuntimeLabel} is connected.`,status:"done",raw:{}}]);return}
    // A started thread continues only on the harness that owns it (T3 Code locks a started thread to its provider).
    const threadOwner=threadOwnerElsewhere(activeThreadRef.current,threadMeta[activeThreadRef.current?.id],agentRuntime);
    if(threadOwner){keepDraft();const label=agentRuntimeName(threadOwner);setEvents(prev=>[...prev.filter(item=>item.id!=="thread-owned-elsewhere"),{id:"thread-owned-elsewhere",kind:"error",title:`This chat belongs to ${label}. Your draft was kept; open the chat from the sidebar to continue it in ${label}.`,status:"done",raw:{}}]);return}
    if(runtimeCapabilities.videoAttachments===false&&attachments.some(isVideoAttachment)){keepDraft();setEvents(prev=>[...prev,{id:"video-unsupported-"+Date.now(),kind:"error",title:agentRuntimeLabel+" does not accept video attachments",status:"done",raw:{}}]);return}
    // A follow-up's edit, a follow-up queued or one steered that does not go comes back before what was typed on meanwhile, with its
    // files and context (restoreSentDraft).
    if(runtimeCapabilities.nativeQueue&&queuedEditId&&rpc&&activeThread&&queueMode!=="local"){
      const draft={text,attachments:[...attachments],contextChips:[...contextChips]};setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);
      try{
        if(await saveNativeQueuedFollowup(draft.text,draft.attachments,draft.contextChips,{queuedId:queuedEditId}))return;
        restoreSentDraft(draft);setEvents(prev=>[...prev,{id:"queue-update-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not support editing native queued follow-ups.`,status:"done",raw:{}}]);return;
      }catch(error){restoreSentDraft(draft);setEvents(prev=>[...prev,{id:"queue-update-error-"+Date.now(),kind:"error",title:"Could not update queued follow-up: "+(error.message||String(error)),status:"done",raw:{}}]);return}
    }
    // An edit of a follow-up in Trebell's own queue is saved in its place there; its files and context leave the composer once it is.
    if(queuedEditId&&activeThread?.id&&queued.some(item=>item.id===queuedEditId&&!item.native)){
      const draft={text,attachments:[...attachments],contextChips:[...contextChips]};
      try{await validateAttachmentPaths(draft.attachments);await persistLocalQueue(activeThread.id,queued.map(item=>item.id===queuedEditId?{...item,...draft}:item));setPromptHistoryIndex(-1);dropSentDraft(draft);setQueuedEditId(null)}
      catch(error){keepDraft();setEvents(prev=>[...prev,{id:"queue-update-error-"+Date.now(),kind:"error",title:"Could not update queued follow-up: "+(error.message||String(error)),status:"done",raw:{}}])}
      return;
    }
    // A follow-up waits in the queue of the thread it follows, which sends it once the turn ends; with no thread shown there is no
    // such queue, and the draft starts a thread of its own. A steer that fails says why, as a queueing that fails does: it was thrown
    // to a send no one waited for, and nothing said it had not gone.
    if(running&&activeThread?.id){
      const draft={text,attachments:[...attachments],contextChips:[...contextChips],model};setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);
      if(runtimeCapabilities.steering&&settings.followUpMode==="steer"&&rpc&&activeThread&&activeTurnId){try{await validateAttachmentPaths(draft.attachments);await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(draft.text,draft.attachments)});followConversationEnd();setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:draft.text,attachments:draft.attachments,turnId:activeTurnId}])}catch(error){restoreSentDraft(draft);setEvents(prev=>[...prev,{id:"steer-error-"+Date.now(),kind:"error",title:"Could not steer the agent: "+(error.message||String(error)),status:"done",raw:{}}])}return}
      if(runtimeCapabilities.nativeQueue&&rpc&&activeThread&&queueMode!=="local"){
        try{
          if(await saveNativeQueuedFollowup(draft.text,draft.attachments,draft.contextChips))return;
          const item={id:crypto.randomUUID(),createdAt:Date.now(),...draft};await persistLocalQueue(activeThread.id,[...queued,item]);return;
        }
        catch(error){restoreSentDraft(draft);setEvents(prev=>[...prev,{id:"queue-add-error-"+Date.now(),kind:"error",title:"Could not queue follow-up: "+(error.message||String(error)),status:"done",raw:{}}]);return}
      }
      try{await validateAttachmentPaths(draft.attachments);const item={id:crypto.randomUUID(),createdAt:Date.now(),...draft};await persistLocalQueue(activeThread.id,[...queued,item])}
      catch(error){restoreSentDraft(draft);setEvents(prev=>[...prev,{id:"queue-local-error-"+Date.now(),kind:"error",title:"Could not queue follow-up: "+(error.message||String(error)),status:"done",raw:{}}])}return;
    }
    // Never start a turn with a model the active runtime does not list: a stale pick from another harness, or a catalog that is loading or failed.
    if(!modelsRef.current.includes(model)&&selectedModels.filter(id=>modelsRef.current.includes(id)).length<2){
      keepDraft();
      const reason=modelsLoadingRef.current||!initialLoaded?`${agentRuntimeLabel} models are still loading`:modelError?`${agentRuntimeLabel} has no usable model: ${modelError}`:`No ${agentRuntimeLabel} model is available`;
      setEvents(prev=>[...prev.filter(item=>item.id!=="model-unavailable"),{id:"model-unavailable",kind:"error",title:reason+". Your draft was kept; send it again once a model is selected.",status:"done",raw:{model:model||null}}]);return;
    }
    try{await waitForActiveClone()}catch(error){keepDraft();setEvents(prev=>[...prev,{id:"clone-wait-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
    const fanned=await sendModelFanout(text);if(fanned){if(fanned==="kept")keepDraft();return}
    try{await validateAttachmentPaths(attachments)}catch(e){keepDraft();setEvents(prev=>[...prev,{id:"attachment-error-"+Date.now(),kind:"error",title:e.message,status:"done",raw:{}}]);return}
    const draft={text,attachments:[...attachments],contextChips:[...contextChips],model};if(sendView)sendDraftsRef.current.set(sendView,draft);
    setPromptHistoryIndex(-1);setSection("chat");
    if(bootstrap.mock){
      if(draft.attachments.length||draft.contextChips.length){
        restoreSentDraft(draft);
        setEvents([{id:"error",kind:"error",title:"Direct fallback cannot send attachments or context. Reconnect the agent harness and retry.",status:"done",raw:{}}]);
        return;
      }
      const clientId="user-"+Date.now();followConversationEnd();setMessages(prev=>[...prev,{id:clientId,role:"user",text:draft.text}]);setRunning(true);
      try{
        const d=await api("/api/chat/direct",{method:"POST",body:{prompt:draft.text,model:draft.model}});
        setMessages(prev=>[...prev,{id:"assistant-"+Date.now(),role:"assistant",text:d.text||""}]);setEvents([{id:"fallback",kind:"tool",title:(modelProviderLabel(provider)||"Provider")+" direct response",status:"done",raw:{}}]);
      }catch(e){
        setMessages(prev=>prev.filter(message=>message.id!==clientId));restoreSentDraft(draft);setEvents([{id:"error",kind:"error",title:e.message,status:"done",raw:{}}]);
      }finally{setRunning(false)}
      return;
    }
    // A turn/start that fails has no turn to show it on: the error goes next to the composer that kept the draft, never onto the
    // last turn's card (a worktree that could not be set up says why in its own card).
    // A send Stop ended before its turn existed puts the draft back with no note: nothing went wrong.
    // A send whose thread another thread or a new task replaced on screen, or is replacing (an open on its way), leaves that view
    // alone: its draft and note wait for its own thread (openThread). One that failed before it had a thread puts its draft back
    // beside the composer's. The files and context of one that goes through left the composer with its hold when another view was
    // shown (openThread), so what the composer shown holds was added there and stays, the same workspace file too.
    await startTurn(draft.text,draft.attachments,draft.model,null,null,repositoryFocusPaths(draft.attachments,draft.contextChips),{pressed,sentChips:draft.contextChips}).catch(e=>{
      const alert=!e?.trebellSendStopped&&!(e&&typeof e==="object"&&WORKTREE_CARD_ERRORS.has(e))?{kind:"send",text:e?.rpcTimedOut?agentRuntimeLabel+" has not answered the send, so it may still start. Your draft is kept; check the conversation before sending it again.":"Not sent: "+sentenceText(e?.message||String(e)||"the harness refused the turn")+" Your draft is kept."}:null;
      if(e?.trebellSendThreadId&&String(openingThreadRef.current||activeThreadRef.current?.id||"")!==e.trebellSendThreadId){turnNotesRef.current.failSend(e.trebellSendThreadId,{draft,alert});return}
      restoreSentDraft(draft);if(submittingRef.current!==sendView)return;setRunning(false);setEvents([]);if(alert)setComposerAlert(alert);
    });
  }
  // A send belongs to the thread it was made in: a new task opened from there while it is on its way releases the composer
  // (showNewTask), and the send then ends without touching the new task (dispatchSend, startTurn).
  async function send(promptOverride=null){
    if(openingThreadRef.current)return;
    if(submittingRef.current)return;
    const token={};submittingRef.current=token;setSubmitting(true);
    try{return await dispatchSend(promptOverride)}
    finally{if(submittingRef.current===token){submittingRef.current=null;setSubmitting(false)}}
  }
  async function sendInBackground(promptOverride=null){
    if(!runtimeCapabilities.detachedTasks){await send(promptOverride);return}
    if(activeThread?.id||running||runtimeSwitchRef.current){await send(promptOverride);return}
    const visiblePrompt=promptOverride==null?prompt:String(promptOverride),text=visiblePrompt.trim();if(!text)return;
    if(visiblePrompt.length>MAX_COMPOSER_CHARS){setEvents(prev=>[...prev,{id:"prompt-too-long-"+Date.now(),kind:"error",title:`Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()} character limit`,status:"done",raw:{length:visiblePrompt.length}}]);return}
    if(text.startsWith("/")){await send(promptOverride);return}
    try{await waitForActiveClone()}catch(error){setEvents(prev=>[...prev,{id:"clone-wait-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
    // A fan-out that has launched takes the text it sent out of the composer, as Enter and Send take a draft out as its send starts
    // (dispatchSend): what the person typed on after it while the fan-out waited for a clone or checked its files stays there, for the
    // next message. The text stayed, and a second Enter launched the same fan-out again. One that cannot start ("kept") leaves it.
    const fanned=await sendModelFanout(text);if(fanned){if(fanned===true)setPrompt(current=>current.startsWith(visiblePrompt)?current.slice(visiblePrompt.length).replace(/^\s+/,""):current);return}
    if(bootstrap.mock||!rpc||rpcStatus!=="connected"||runtimeSwitchRef.current||!modelsRef.current.includes(model)){await send(promptOverride);return}
    if(runtimeCapabilities.videoAttachments===false&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"video-unsupported-"+Date.now(),kind:"error",title:agentRuntimeLabel+" does not accept video attachments",status:"done",raw:{}}]);return}
    try{await validateAttachmentPaths(attachments)}catch(error){setEvents(prev=>[...prev,{id:"background-attachment-error-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
    const draft={text,attachments:[...attachments],contextChips:[...contextChips],projectPath:projectPath||bootstrap.cwd,model,projectless:projectlessMode};
    setPrompt("");setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);setEvents([]);resetAssistantStream();setSection("chat");
    // A launch that fails is told by background-send-outcome.js, which loads then: should it not load, the draft goes back to the
    // composer.
    startDetachedTurn(draft.text,draft.attachments,draft.model,{basePath:draft.projectPath,projectless:draft.projectless,focusPaths:repositoryFocusPaths(draft.attachments,draft.contextChips)}).catch(error=>import("./background-send-outcome.js").then(({settleFailedBackgroundSend})=>settleFailedBackgroundSend({error,draft,saveFailureStash,restoreFailedDraft,desktopNotify,addEvents:added=>setEvents(prev=>[...prev,...added])}),()=>{restoreFailedDraft(draft);showActionError(error,"Background task failed")}));
  }
  // A follow-up's button pressed from the keyboard keeps the keyboard, as the sidebar's rows do, instead of dropping it on the page with
  // the button its action takes away or turns off: Edit gives it to the composer, where the edit is made; Send now and Remove, whose
  // follow-up leaves the queue, give it to the same button of the follow-up that comes up in its place, or of the one before, or to the
  // composer once none is left; a move keeps it on the moved follow-up's button, or its other move button once an end of the queue
  // turns that one off. A click leaves the focus to the browser, so a space typed next presses no button the person did not aim at.
  // queueKeysRef: the press, until its action has done what it does (queueKeysDone), which the layout effect below then acts on; one
  // whose action fails or does nothing is let go. A press waits for its own action only: Codex starting a follow-up meanwhile, which
  // moved the pressed one up, was taken for it, and a press Codex refused pulled the keyboard to its follow-up's button the next time
  // the queue moved that follow-up. queueShownRef: the queue as the last layout showed it.
  const queueKeysRef=useRef(null),queueShownRef=useRef(queued);
  function pressQueued(event,item,index,button,action,label){
    const press=event.detail?null:{id:item.id,at:index,button,threadId:activeThreadRef.current?.id,done:false};queueKeysRef.current=press;
    return runUserAction(async()=>{try{return await action()}finally{if(press&&!press.done&&queueKeysRef.current===press)queueKeysRef.current=null}},label);
  }
  function queueKeysDone(id){const press=queueKeysRef.current;if(press?.id===id)press.done=true}
  async function sendQueuedNow(item){
    // The follow-up being edited waits for its edit (its Send now is disabled, and the keyboard's steer skips it): sending it now
    // would send the text the composer is changing. One on its way is being sent already (queuedOnItsWay).
    if(item?.id&&(item.id===queuedEditId||queuedOnItsWay(item)))return;
    if(running&&!runtimeCapabilities.steering)throw new Error(cannotSteerReason);
    // Send now is the next send, so the composer's note about the last one ends.
    setComposerAlert(null);
    if(item?.native&&runtimeCapabilities.nativeQueue&&rpc&&activeThread?.id){
      const requiredToolNamespaces=Array.isArray(item.dynamicToolNamespaces)?item.dynamicToolNamespaces:[],needsToolExpansion=queuedSubmissionNeedsToolExpansion(item,activeThread.providerMeta?.dynamicToolNamespaces||[]);
      if(running&&activeTurnId&&runtimeCapabilities.steering&&!needsToolExpansion){
        const originalInput=item.input?.length?item.input:inputsFor(item.draftText||item.text,item.attachments);const originalClientId=item.clientUserMessageId||("trebell-queue-"+crypto.randomUUID());
        try{
          await rpc.request("thread/queue/delete",{threadId:activeThread.id,queuedSubmissionId:item.id});
          await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:originalInput});
          setQueued(prev=>prev.filter(q=>q.id!==item.id));queueKeysDone(item.id);followConversationEnd();setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.draftText||item.text,attachments:item.attachments,turnId:activeTurnId}]);return;
        }catch(error){
          let restored;
          try{
            restored=await rpc.request("thread/queue/add",{threadId:activeThread.id,input:originalInput,clientUserMessageId:originalClientId,dynamicToolNamespaces:requiredToolNamespaces});
          }catch(restoreError){
            setQueued(prev=>prev.filter(q=>q.id!==item.id));
            restoreFailedDraft({text:item.draftText||item.text,attachments:item.attachments||[],contextChips:item.contextChips||[]});
            throw new Error((error?.message||String(error))+" · Native queue restore also failed: "+(restoreError?.message||String(restoreError))+". The queued draft was restored to the composer.");
          }
          const restoredDraft={...queuedSubmissionDraft(restored?.queuedSubmission||{}),contextChips:[...(item.contextChips||[])],model:item.model||model};
          setQueued(prev=>prev.map(q=>q.id===item.id?restoredDraft:q));
          try{await loadNativeQueue(rpc,activeThread.id)}
          catch(refreshError){throw new Error((error?.message||String(error))+" · Queue was restored, but refresh failed: "+(refreshError?.message||String(refreshError))+".")}
          throw error;
        }
      }
      if(running)return;
      const result=await rpc.request("thread/queue/start",{threadId:activeThread.id,queuedSubmissionId:item.id});const turnId=result?.turn?.id||null;
      setRunning(Boolean(turnId));setActiveTurnId(turnId);setQueued(prev=>prev.filter(q=>q.id!==item.id));queueKeysDone(item.id);
      if(turnId){followConversationEnd();setMessages(prev=>[...prev,{id:item.clientUserMessageId||("queue-start-"+item.id),role:"user",text:item.draftText||item.text,attachments:item.attachments,turnId}])}return;
    }
    // From the press on it is on its way (localQueueStartRef), until what became of it is written: its files are checked and its
    // dispatch mark is written before its card says so, and a Remove, an Edit or a second Send now meanwhile would drop a follow-up
    // this send sends anyway, or send it twice. Nor does the queue start it as well, as it would once a start that failed has stopped
    // the thread running.
    const onItsWay=localQueueStartRef.current;onItsWay.add(item.id);
    try{
      await validateAttachmentPaths(item.attachments||[]);
      if(runtimeCapabilities.steering&&running&&rpc&&activeThread&&activeTurnId){
        // Steered into the turn, it is on its way until Codex has it: its card says so and leaves it be, and a steer that fails leaves
        // it queued as it was (clearQueuedDispatch).
        let steered=false;
        try{
          await persistLocalQueue(activeThread.id,queueNow(activeThread.id).map(q=>q.id===item.id?{...q,dispatchingAt:Date.now()}:q));
          await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(item.text,item.attachments)});steered=true;
          await persistLocalQueue(activeThread.id,queueNow(activeThread.id).filter(q=>q.id!==item.id));queueKeysDone(item.id);followConversationEnd();setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.text,attachments:item.attachments,turnId:activeTurnId}]);return;
        }catch(error){if(!steered)await clearQueuedDispatch(activeThread.id,item.id);throw error}
      }
      if(running)return;
      // Its dispatch mark goes into the queue as it is now (queueNow), not the copy taken at the press.
      const threadId=activeThread?.id||null,dispatching=queueNow(threadId).map(q=>q.id===item.id?{...q,dispatchingAt:Date.now(),autoStartFailed:false}:q);
      if(threadId)await persistLocalQueue(threadId,dispatching);else setQueued(dispatching);
      try{
        await startTurn(item.text,item.attachments,item.model||model,null,null,repositoryFocusPaths(item.attachments,item.contextChips),{sentChips:item.contextChips||[]});
        await persistLocalQueue(threadId,queueNow(threadId).filter(q=>q.id!==item.id));queueKeysDone(item.id);
      }catch(error){
        // Stop ended it before its turn existed: it stays in its place in the queue, which is left as it is but for its dispatch mark, as
        // when the queue starts it. A start that failed marks only it to retry, in the queue as that is now (queueNow).
        if(error?.trebellSendStopped){await clearQueuedDispatch(threadId,item.id);return}
        const failed=queueNow(threadId).map(q=>q.id===item.id?{...q,dispatchingAt:null,autoStartFailed:true}:q);try{await persistLocalQueue(threadId,failed)}catch{setQueued(failed)}throw error;
      }
    }finally{onItsWay.delete(item.id)}
  }
  // A queued follow-up is edited in the composer and stays queued as it was until the edit is saved (dispatchSend) or Escape ends it
  // (cancelQueuedEdit); the composer's draft is set aside meanwhile.
  async function editQueued(item){
    if(item?.native&&!item.editable){setEvents(prev=>[...prev,{id:"queue-edit-unavailable-"+Date.now(),kind:"error",title:"This queued follow-up contains input Trebell cannot safely edit yet.",status:"done",raw:{}}]);return}
    // One follow-up is edited at a time (the others' Edit waits until it is saved or Escape ends it), so an edit never replaces another;
    // one on its way goes as it is, so an edit of it would send it twice (queuedOnItsWay).
    if(queuedEditId||queuedOnItsWay(item))return;
    if(prompt.trim()||attachments.length||contextChips.length)setQueueEditDraft({text:prompt,attachments:[...attachments],contextChips:[...contextChips]});
    setQueuedEditId(item.id);setPrompt(item.draftText??item.text??"");setAttachments(item.attachments||[]);setContextChips(item.contextChips||[]);queueKeysDone(item.id);
  }
  function cancelQueuedEdit(){setPrompt("");setAttachments([]);setContextChips([]);setQueuedEditId(null)}
  async function removeQueued(item){
    if(queuedOnItsWay(item))return;
    if(item?.native&&rpc&&activeThread?.id){await rpc.request("thread/queue/delete",{threadId:activeThread.id,queuedSubmissionId:item.id});if(queuedEditId===item.id)cancelQueuedEdit();setQueued(prev=>prev.filter(entry=>entry.id!==item.id));queueKeysDone(item.id);return}
    if(activeThread?.id)await persistLocalQueue(activeThread.id,queued.filter(entry=>entry.id!==item.id));else setQueued(prev=>prev.filter(entry=>entry.id!==item.id));
    queueKeysDone(item.id);if(queuedEditId===item.id)cancelQueuedEdit();
  }
  async function moveQueued(item,direction){
    if(queuedOnItsWay(item))return;
    const next=reorderQueue(queued,item.id,direction);if(next===queued||next.map(entry=>entry.id).join("\0")===queued.map(entry=>entry.id).join("\0"))return;
    if(item?.native&&rpc&&activeThread?.id){await rpc.request("thread/queue/reorder",{threadId:activeThread.id,queuedSubmissionIds:next.map(entry=>entry.id)});setQueued(next);queueKeysDone(item.id);return}
    if(activeThread?.id)await persistLocalQueue(activeThread.id,next);else setQueued(next);
    queueKeysDone(item.id);
  }
  useLayoutEffect(()=>{
    const before=queueShownRef.current;queueShownRef.current=queued;
    const press=queueKeysRef.current;if(!press?.done)return;queueKeysRef.current=null;
    const active=document.activeElement,composer=document.querySelector('[data-testid="composer"]');
    if(press.threadId!==activeThreadRef.current?.id||active&&active!==document.body&&!active.closest(".queued-message"))return;
    if(press.button===1){if(queuedEditId===press.id&&composer){composer.focus();composer.setSelectionRange(composer.value.length,composer.value.length)}return}
    const cards=conversationScrollRef.current?.querySelectorAll(".queued-message")||[],button=(index,which)=>{const node=index<0?null:cards[index]?.querySelectorAll(":scope>.queued-message-actions>button")[which];return node&&!node.disabled?node:null};
    const at=queued.findIndex(item=>item.id===press.id);
    if(at>=0){(button(at,press.button)||(press.button===2||press.button===3?button(at,press.button===2?3:2):null))?.focus();return}
    // Gone: the follow-up after it that is still queued, or else the one before it, as the queue was just before it went.
    const was=before.findIndex(item=>item.id===press.id),ids=queued.map(item=>item.id),still=item=>ids.includes(item.id);
    const after=was<0?null:before.slice(was+1).find(still),previous=was<0?null:before.slice(0,was).reverse().find(still);
    const next=was<0?button(press.at,press.button)||button(press.at-1,press.button):button(after?ids.indexOf(after.id):-1,press.button)||button(previous?ids.indexOf(previous.id):-1,press.button);
    (next||composer)?.focus();
  },[queued,queuedEditId]);
  async function stop(){
    // A send whose turn has not started stops too. The agent relay ends it where it waits (for the harness to start, or before its
    // prompt) and the send puts its draft back; Codex can interrupt a turn only once it has started it (turn/started), so that Stop
    // waits for the turn to start (interruptStoppedSend), and until then the turn still runs here, as Stopping.
    const threadId=activeThread?.id?String(activeThread.id):null,pendingSend=threadId?pendingSendsRef.current.get(threadId)||null:null;
    // One Stop per turn: pressed again while it is on its way (a double click, the shortcut twice), it sends nothing more.
    const stopKey=activeTurnId?threadId+"\0"+activeTurnId:pendingSend;
    if(stopKey&&stopKeyRef.current===stopKey)return;
    // The thread's queue stays as it was, as Codex's does: nothing in it goes to the composer, and nothing in it starts by itself,
    // also when the stopped turn ends before the interrupt is answered, until the thread runs a turn again (startTurn).
    stopKeyRef.current=stopKey;setStoppingThreadId(threadId);holdQueue(threadId,true);
    // Stop pauses an active Codex goal first, so Codex starts no further goal turn, then stops the newest turn (T3 Code,
    // the Codex TUI).
    let turnId=activeTurnId;
    if(agentRuntime==="codex"&&rpc&&threadId){
      if(codexGoalActivationRef.current?.threadId===threadId)codexGoalActivationRef.current.stopped=true;
      if(goal?.status==="active"){
        try{const paused=await rpc.request("thread/goal/set",{threadId,status:"paused"});if(activeThreadRef.current?.id===threadId)setGoal(paused?.goal||null)}
        catch(error){showActionError(error,"Could not pause the goal")}
        const latest=threadTelemetryRef.current[threadId];if(latest&&Object.prototype.hasOwnProperty.call(latest,"turnId"))turnId=latest.turnId;
      }
    }
    if(pendingSend)pendingSend.stopped=true;
    const interruptNow=Boolean(turnId&&(!pendingSend||pendingSend.startedTurnId===String(turnId))||pendingSend?.requested&&agentRuntime!=="codex");if(pendingSend&&interruptNow)pendingSend.interrupted=true;
    const sentKey=rpc&&threadId&&interruptNow&&turnId?threadId+"\0"+turnId:null;if(sentKey)turnNotesRef.current.stopSent(threadId,turnId);
    try{if(rpc&&threadId&&interruptNow)await rpc.request("turn/interrupt",{threadId,...(turnId?{turnId}:{})})}
    catch(error){if(sentKey)turnNotesRef.current.stopFailed(threadId,turnId);if(stopKeyRef.current===stopKey){stopKeyRef.current=null;setStoppingThreadId(null);holdQueue(threadId,false)}throw error}
    // A send stopped before its turn started runs on until it ends: its turn/completed, or the send ending without a turn.
    const ended=!pendingSend;
    if(runtimeCapabilities.nativeQueue&&queueMode==="native"){if(ended){setRunning(false);setActiveTurnId(null)}await loadNativeQueue(rpc,threadId);return}
    if(ended)setRunning(false);
  }
  async function editFromHere(message){
    if(!runtimeCapabilities.rewind||!rpc||!activeThread?.id||!message.turnId)return;
    // One question at a time: a double click, or Enter held on the button, asks once.
    if(editFromHereAskingRef.current)return;
    const threadId=activeThread.id;
    const normalizePath=value=>String(value||"").replace(/\\/g,"/").replace(/\/+$/,"").toLowerCase();
    // In a worktree of its own the files go back with the conversation, to the checkpoint taken before this message; anywhere else
    // only the conversation does.
    const isolatedWorktree=Boolean(
      message.checkpointId&&currentProject?.managedWorktree&&!currentProject.managedWorktree.cleanedAt
      &&normalizePath(currentProject.path)===normalizePath(activeThread.cwd||projectPath)
    );
    // Files and conversation go back together or not at all: nothing is restored while a turn runs (the harness refuses that rewind),
    // and files that could not go back leave the conversation as it is.
    const refuseWhileRunning=()=>showActionError(new Error("Stop the running turn first."),"Could not edit from this message");
    if(running){refuseWhileRunning();return}
    // Asked once, before anything changes, saying what will go: Cancel, Escape or closing the question leaves the conversation, the
    // composer and the files as they are.
    editFromHereAskingRef.current=true;
    let confirmed=false;
    try{
      confirmed=await askConfirm("Edit from this message?\n\nThe messages after it are removed from this thread"+(isolatedWorktree
        ?", this message comes back to the composer to edit, and the files in this worktree go back to how they were before it."
        :", and this message comes back to the composer to edit."),{confirm:"Edit from here"});
    }finally{editFromHereAskingRef.current=false}
    if(!confirmed||String(activeThreadRef.current?.id||"")!==String(threadId))return;
    // A turn that started while the question was open, in this window or another, is refused the same way. Another window's turn may
    // not have reached this one yet, so before any file goes back the harness is asked whether the thread runs (the server refuses a
    // restore under a running turn too).
    if(turnRunsNow()){refuseWhileRunning();return}
    // The files and the conversation go back in edit-from-here.js, loaded now.
    const outcome=await import("./edit-from-here.js").then(({rewindToMessage})=>rewindToMessage({client:rpcRef.current||rpc,message,threadId,isolatedWorktree,turnRunsNow})).catch(error=>({error,title:"Could not edit from this message"}));
    if(outcome.refused){refuseWhileRunning();return}
    if(outcome.error){showActionError(outcome.error,outcome.title);return}
    // A draft already in the composer stays, below the message brought back to edit, and so do its files, with the message's own.
    setPrompt(current=>String(current||"").trim()&&current!==message.text?message.text+"\n\n"+current:message.text);if(message.attachments?.length)setAttachments(current=>[...new Set([...current,...message.attachments])]);await reloadActiveThread();
    // The message is the composer's to edit now, so the focus goes there, at its end: the button that had it left with the message.
    focusComposerAt(String(message.text||"").length);
  }
  // Waits a few frames for a composer that is still held (the thread reloading) and leaves the focus where the person put it meanwhile.
  function focusComposerAt(caret,frames=30){
    requestAnimationFrame(()=>{
      const node=document.querySelector('[data-testid="composer"]'),focused=document.activeElement;if(!node)return;
      if(focused&&focused!==document.body&&focused!==node&&focused.isConnected&&!focused.closest(".user-row"))return;
      if(node.disabled){if(frames>0)focusComposerAt(caret,frames-1);return}
      node.focus();node.setSelectionRange(caret,caret);
    });
  }
  async function stashPrompt(){
    if(prompt.trim()||attachments.length){await api("/api/stashes",{method:"POST",body:{text:prompt,attachments,contextChips,projectPath}});setPrompt("");setAttachments([]);setContextChips([]);return}
    const d=await api("/api/stashes");const stash=d.stashes?.[0];if(!stash)return;
    await api("/api/stashes?id="+encodeURIComponent(stash.id),{method:"DELETE"});
    setPrompt(stash.text||"");setAttachments(stash.attachments||[]);setContextChips(stash.contextChips||[]);
  }
  async function addFiles(paths){setAttachments(prev=>[...new Set([...prev,...paths])].slice(0,MAX_COMPOSER_ATTACHMENTS))}
  // A chip with a `key` (a pull request's identity) replaces the one attached before with that key, as a path attached again does:
  // the text behind it is written anew each time, so its path is new too.
  async function addContextPath(path,{kind="context",label="Context",detail="",sourcePath=null,key=null}={}){
    if(!path)return null;
    const replaced=key?contextChips.filter(chip=>chip.key===key&&chip.path!==path).map(chip=>chip.path):[];
    if(!attachments.includes(path)&&attachments.length-replaced.length>=MAX_COMPOSER_ATTACHMENTS)throw new Error(`Composer supports up to ${MAX_COMPOSER_ATTACHMENTS} attachments/context items.`);
    replaced.forEach(removeContext);
    await addFiles([path]);
    setContextChips(prev=>[...prev.filter(chip=>chip.path!==path),{id:crypto.randomUUID(),path,kind,label,detail,sourcePath:sourcePath||null,...(key?{key}:{})}].slice(-MAX_COMPOSER_ATTACHMENTS));
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
  async function addContextAttachment({name,text,kind="context",label="Context",detail="",key=null}){const d=await api("/api/attachments/text",{method:"POST",body:{name,text}});const [path]=await prepareAttachmentPaths([d.path]);return addContextPath(path,{kind,label,detail,key})}
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
    await addContextPath(path,{kind:"file",label:item.name||String(item.path).split(/[\\/]/).pop()||"File",detail:item.relativePath||item.path,sourcePath:item.path});
    return path;
  }
  // The files picked go into the composer's draft, as many as it has room for, and label is what its toast says could not be done
  // (uploadBrowserFiles). A question passes its own room and keep, so what it picks goes with its answer only.
  async function pickFiles(label="",{room=MAX_COMPOSER_ATTACHMENTS-attachments.length,keep=null}={}){
    const native=window.trebellDesktop?.pickFiles;
    if(native){const p=await native();if(p?.length){const prepared=await prepareAttachmentPaths(p.slice(0,Math.max(0,room)));await (keep||addFiles)(prepared);return prepared}return[]}
    const files=await new Promise(resolve=>{
      const input=document.createElement("input");input.type="file";input.multiple=true;input.hidden=true;document.body.appendChild(input);let settled=false;
      const done=value=>{if(settled)return;settled=true;input.remove();resolve(value)};
      input.addEventListener("change",()=>done([...(input.files||[])]),{once:true});
      input.addEventListener("cancel",()=>done([]),{once:true});
      window.addEventListener("focus",()=>setTimeout(()=>{if(!settled&&!input.files?.length)done([])},250),{once:true});
      input.click();
    });
    return uploadBrowserFiles(files,label,[],{room,keep});
  }
  // A file over the size limit is refused by its name before anything is read, together with what the caller could not take (refused:
  // its reasons, a dropped folder's). With label (what the composer's toast says could not be done) the refusal shows at once, while
  // the files taken upload, each on the shelf as uploading until the server has it and then as attached. What failed is thrown at the
  // end: an upload that failed, or else the refusal. A question's own picks (keep: where they go, room: how many it takes) go to
  // keep once uploaded, with nothing on the composer's shelf.
  async function uploadBrowserFiles(files,label="",refused=[],{room=MAX_COMPOSER_ATTACHMENTS-attachments.length,keep=null}={}){
    const picked=files.slice(0,Math.max(0,room)),uploaded=[];
    const reasons=[...refused,...picked.filter(file=>attachmentSizeError(file)).map(file=>(file.name||"A file")+": "+attachmentSizeError(file).message)],refusal=reasons.length?new Error(reasons.join("; ")):null;
    if(refusal&&label)showActionError(refusal,label);
    const taken=picked.filter(file=>!attachmentSizeError(file)).map(file=>({file,id:crypto.randomUUID(),name:file.name||"attachment"}));
    if(taken.length&&!keep)setUploadingFiles(prev=>[...prev,...taken.map(({id,name})=>({id,name}))]);
    let failure=null;
    for(const {file,id} of taken){
      try{const {path}=await blobAttachment(file);uploaded.push(path);if(!keep)addFiles([path])}
      catch(error){failure ||= error}
      finally{if(!keep)setUploadingFiles(prev=>prev.filter(item=>item.id!==id))}
    }
    if(keep)await keep(uploaded);
    if(failure||refusal)throw failure||refusal;
    return uploaded;
  }
  async function blobAttachment(file){const tooLarge=attachmentSizeError(file);if(tooLarge)throw tooLarge;const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=()=>reject(new Error((file.name||"The file")+": "+(reader.error?.message||"the browser could not read it")));reader.readAsDataURL(file)});const stored=await api("/api/attachments/blob",{method:"POST",body:{name:file.name,mime:file.type,dataBase64:data}});const [path]=await prepareAttachmentPaths([stored.path]);return {...stored,path}}
  async function captureDesktop(){
    const shot=await window.trebellDesktop?.captureScreen?.();
    if(!shot?.dataUrl)throw new Error("Desktop screenshot is unavailable.");
    const d=await api("/api/attachments/blob",{method:"POST",body:{name:"desktop-snapshot.png",mime:"image/png",dataBase64:String(shot.dataUrl).split(",")[1]||""}});
    const [path]=await prepareAttachmentPaths([d.path]);
    await addContextPath(path,{kind:"computer",label:"Desktop snapshot",detail:(shot.width&&shot.height)?shot.width+"×"+shot.height:"PNG capture"});
  }
  async function onPaste(e){
    const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();try{await uploadBrowserFiles(files,"Could not attach pasted files")}catch(error){showActionError(error,"Could not attach pasted files")}return}
    const text=e.clipboardData?.getData("text/plain")||"";const start=Number(e.currentTarget?.selectionStart)||0,end=Number(e.currentTarget?.selectionEnd)||start;const nextLength=prompt.length-(end-start)+text.length;
    if(text.length>=32768||nextLength>MAX_COMPOSER_CHARS){
      e.preventDefault();
      try{
        const d=await api("/api/attachments/text",{method:"POST",body:{name:"pasted-context.txt",text}});
        const prepared=await prepareAttachmentPaths([d.path]);await addFiles(prepared);
      }catch(error){
        setPrompt(current=>current===prompt?prompt.slice(0,start)+text+prompt.slice(end):current+"\n"+text);
        setPromptHistoryIndex(-1);
        showActionError(error,"Could not attach pasted text; kept it in the draft");
      }
    }
  }
  // A dropped folder comes as a file the browser cannot read: it is left out and named as a folder, with any file refused beside it,
  // and the files beside it attach.
  async function onDrop(e){e.preventDefault();const items=[...(e.dataTransfer?.items||[])].filter(item=>item.kind==="file"),isFolder=item=>Boolean(item.webkitGetAsEntry?.()?.isDirectory),folders=items.some(isFolder),files=items.filter(item=>!isFolder(item)).map(item=>item.getAsFile()).filter(Boolean);try{await uploadBrowserFiles(files,"Could not attach dropped files",folders?["Folders cannot be attached"]:[])}catch(error){showActionError(error,"Could not attach dropped files")}}
  async function attachExcerpt(text){if(!text.trim())return;await addContextAttachment({name:"terminal-context.txt",text,kind:"terminal",label:"Terminal excerpt",detail:text.split(/\r?\n/).length+" lines"});setPanel(null)}
  async function citeAssistant(message,excerpt=""){
    const selected=String(excerpt||"").trim();
    const source=selected||message?.text?.trim();if(!source)return;
    const threadLabel=activeThread?.name||activeThread?.id||"current thread";
    const text=[selected?"Assistant response excerpt":"Assistant response citation","Thread: "+threadLabel,message?.id?"Message: "+message.id:null,"",source].filter(value=>value!=null).join("\n");
    await addContextAttachment({name:"assistant-citation.txt",text,kind:"citation",label:selected?"Assistant excerpt":"Assistant citation",detail:selected?`${selected.length.toLocaleString()} chars · ${threadLabel}`:threadLabel});
    setPrompt(prev=>(prev?prev+" ":"")+(selected?"Use the cited assistant excerpt as context. ":"Use the attached assistant citation as context. "));
    return true;
  }
  async function attachReviewComment(path,comment){
    const text=["Code review comment","File: "+path,"",comment].join("\n");
    const filename=String(path).split(/[\\/]/).pop();
    await addContextAttachment({name:"review-"+filename+".txt",text,kind:"review",label:"Review: "+filename,detail:comment.slice(0,70)});
    setPrompt(prev=>(prev?prev+" ":"")+"Address the attached review comment. ");
    setPanel(null);setSection("chat");
  }
  async function attachPr(pr){const text=["Pull request #"+pr.number+": "+pr.title,pr.url,pr.headRefName+" -> "+pr.baseRefName,pr.body||""].join("\n");await addContextAttachment({name:"pr-"+pr.number+".txt",text,kind:"pr",label:"PR #"+pr.number,detail:pr.title,key:pullRequestIdentity(pr)});setSection("chat")}
  // Links answered for a thread update that thread's metadata, and the visible list only while that thread is still open: a link
  // or sync started in one thread can answer after another one was opened (the render that started it still names the old thread).
  function applyThreadPullRequestLinks(threadId,links){
    const next=Array.isArray(links)?links:[];if(activeThreadRef.current?.id===threadId)setLinkedPullRequests(next);
    setThreadMeta(previous=>({...previous,[threadId]:{...(previous[threadId]||{}),linkedPullRequests:next}}));
  }
  async function linkPr(pr){
    if(!activeThread?.id)throw new Error("Open a thread before linking a pull request.");
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
  async function toggleReviewed(path,value){
    const previous=reviewedFiles;
    const next=value?[...new Set([...reviewedFiles,path])]:reviewedFiles.filter(x=>x!==path);
    setReviewedFiles(next);
    if(activeThread?.id){
      try{await updateThreadMeta(activeThread.id,{reviewedFiles:next},{strict:true})}
      catch(error){setReviewedFiles(previous);throw error}
    }
  }
  // The answer goes back on the socket that asked: request ids restart on every socket, so a newer one can hold another request.
  function resolveApproval(request,decision){
    const client=request?.client||rpc;
    if(!client)throw new Error("Runtime is not connected.");
    if(!client.respond(request.id,approvalResponse(request,decision)))throw new Error("Runtime disconnected before the approval response could be sent.");
    setApprovals(prev=>prev.filter(item=>item!==request));return true;
  }
  // Server requests belong to the socket that asked. Once that socket is replaced or torn down its relay has already failed them,
  // so they leave the screen: only requests from `client` (the live socket, if any) stay answerable.
  function dropServerRequestsExcept(client){
    setApprovals(prev=>liveRequests(prev,client));
    setQuestions(prev=>liveRequests(prev,client));
    setElicitations(prev=>liveRequests(prev,client));
  }
  async function approveGuardianDenial(review){
    if(!rpc||!review?.threadId||guardianBusy)return;
    const reviewId=String(review.reviewId||crypto.randomUUID());setGuardianBusy(reviewId);
    try{
      // The denial's card has loaded its module, which builds the event (B11), so this import is already there.
      const {guardianDeniedEvent}=await import("./components/GuardianDenialCard.jsx");
      await rpc.request("thread/approveGuardianDeniedAction",{threadId:review.threadId,event:guardianDeniedEvent(review)});
      setGuardianDenials(prev=>prev.filter(item=>item.reviewId!==review.reviewId));
      setEvents(prev=>[...prev,{id:"auto-review-override-"+Date.now(),kind:"autoReview",title:"Auto review denial overridden by user",status:"done",raw:{reviewId:review.reviewId}}]);
    }catch(error){
      setEvents(prev=>[...prev,{id:"auto-review-override-error-"+Date.now(),kind:"error",title:"Could not override auto review: "+(error.message||String(error)),status:"done",raw:{reviewId:review.reviewId}}]);
    }finally{setGuardianBusy("")}
  }
  function dismissGuardianDenial(review){setGuardianDenials(prev=>prev.filter(item=>item.reviewId!==review.reviewId))}
  // Questions wait in the order they came, one per request and per thread: the modal shows the first, and the next once it is answered
  // or dismissed. Each answer goes back on the socket that asked.
  async function answerQuestion(answers,filesByQuestion={}){const current=questions[0];if(!current)return false;await validateAttachmentPaths(Object.values(filesByQuestion).flat());const result={};for(const q of current.params?.questions||[]){const values=[...(answers[q.id]||[])];const files=filesByQuestion[q.id]||[];if(files.length)values.push("Attached files:\n"+files.map(path=>"- "+path).join("\n"));result[q.id]={answers:values}}if(!current.client?.respond(current.id,{answers:result}))throw new Error("Runtime disconnected before the answer could be sent.");setQuestions(prev=>prev.filter(item=>item!==current));return true}
  async function cancelQuestion(){const current=questions[0];if(!current)return false;if(!current.client?.respond(current.id,{answers:{}}))throw new Error("Runtime disconnected before the question could be cancelled.");setQuestions(prev=>prev.filter(item=>item!==current));return true}
  function resolveElicitation(response){
    const current=elicitations[0];if(!current)return;
    if(!current.client.respond(current.request.id,response))throw new Error("Runtime disconnected before the app response could be sent.");
    setElicitations(prev=>prev.slice(1));return true;
  }
  async function verifyMcpUser(request){
    if(agentRuntime!=="codex"||!rpc)throw new Error("Device-backed user verification requires the Codex runtime.");
    if(workspaceEnvironmentId)throw new Error("Device verification is unavailable for remote workspaces.");
    const params=request?.params||{};
    if(params.mode!=="openai/userVerification")throw new Error("This request is not a Codex user-verification challenge.");
    const challenge=String(params.challenge||"").trim(),title=String(params.title||"").trim(),description=String(params.description||"");
    if(!challenge||!title)throw new Error("The verification challenge is incomplete.");
    const result=await rpc.request("userVerification/verify",{challenge,title,description});
    if(!result?.proof)throw new Error("Codex did not return a verification proof.");
    return result.proof;
  }
  // The name goes to the transport there is once the dialog closes; with none (the harness went away meanwhile) the rename names the
  // harness, as the title's tooltip does. It names the thread it was asked for, even when another view is open by then.
  async function renameThread(){if(!rpc||!activeThread)return;const name=await askText("Rename thread",titleOf(activeThread));if(!name?.trim())return;const client=rpcRef.current;if(!client?.isConnected())throw new Error(agentRuntimeLabel+" is not connected.");await client.request("thread/name/set",{threadId:activeThread.id,name:name.trim()});setActiveThread(prev=>prev?.id===activeThread.id?{...prev,name:name.trim()}:prev);setThreads(prev=>prev.map(t=>t.id===activeThread.id?{...t,name:name.trim()}:t))}
  async function shareThread(){const text=messages.filter(m=>m.role==="user"||m.role==="assistant").map(m=>(m.role==="user"?"You":"Trebell Code")+": "+m.text).join("\n\n");if(text&&!await writeClipboardText(text))throw new Error("Could not copy conversation.")}
  // A review on its way (the first click of a double click, or Enter pressed twice) is the one a second press waits for, as an
  // action's run is: the second starts nothing.
  const reviewStartsRef=useRef(new Set());
  async function startReview(){
    if(!rpc||!activeThread?.id)throw new Error("Start or open a thread before reviewing.");
    // A review is a turn, and no turn starts while a thread opens (sends wait the same way) or while another one runs.
    if(openingThreadRef.current)throw new Error("Wait for the thread to finish opening before reviewing.");
    if(running)throw new Error("Wait for the running turn to finish before reviewing.");
    const threadId=activeThread.id,starting=reviewStartsRef.current;if(starting.has(threadId))return;
    let result;try{starting.add(threadId);result=await rpc.request("review/start",{threadId,target:{type:"uncommittedChanges"}})}finally{starting.delete(threadId)}
    // A review runs only as the turn the harness started for it: an answer without one started nothing. Its step comes into view
    // as a sent message does, in the thread it was started for: another thread or a new task shown by then is left as it is (as
    // turn-support.js adoptAutomaticTurn leaves it), and the review's thread shows its running turn when it is opened again.
    if(!result?.turn?.id)throw new Error(agentRuntimeLabel+" did not start a review.");
    if(activeThreadRef.current?.id!==threadId)return result;
    followConversationEnd();setRunning(true);setActiveTurnId(result.turn.id);
    setEvents(prev=>[...prev,{id:"review-"+Date.now(),kind:"tool",title:"Reviewing uncommitted changes",status:"running",raw:result}]);
    return result;
  }
  // An action that runs already is not started again: its terminal is shown (the server answers the same for a run it knows of). A
  // run on its way (the first click of a double click, or the key pressed twice) is the one a second press waits for. starting holds
  // the presses counted at the last press that asked for the run on its way: its answer asks for the terminal's keyboard as of them,
  // so a press made elsewhere while the run starts keeps the keyboard where it went (terminal-keyboard.js).
  async function runProjectAction(script){
    if(!script||!projectPath)return;
    const key=actionRunKey(script),runningId=actionRuns[key],starting=actionStartsRef.current;
    if(!runningId&&starting.has(key)){starting.set(key,terminalPresses());return}
    let result,pressed=terminalPresses();
    if(runningId)result={alreadyRunning:true,session:{id:runningId,running:true}};
    else try{starting.set(key,pressed);result=await api("/api/project-script/run",{method:"POST",body:{path:projectPath,environmentId:workspaceEnvironmentId,scriptId:script.id}})}finally{pressed=starting.get(key);starting.delete(key)}
    showActionRun(key,result,pressed);
    if(!result?.alreadyRunning&&script.previewUrl&&script.autoOpenPreview){openRightPanel("preview");requestPreview(script.previewUrl)}
    return result;
  }
  // A run's answer, from the header, the palette, a key or the action's Projects card: the action runs (the header's button shows it)
  // and its terminal is shown, with the keyboard asked for as of the press that ran it (pressed), not as the drawer hears of it
  // (terminal-keyboard.js).
  function showActionRun(key,result,pressed){
    if(result?.session?.running)setActionRuns(current=>({...current,[key]:result.session.id}));
    setSection("chat");setPanel("terminal");askTerminalKeyboard(pressed);
    setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:result?.session?.id||null})),0);
  }
  async function onProjectOpen(path,environmentId=null){
    const targetEnvironmentId=environmentId||null;
    const currentEnvironmentId=settings.activeEnvironmentId||null;
    const shouldStartFresh=Boolean(activeThread?.id&&String(activeThread.cwd||"")!==String(path));
    // Each environment runs its own harness install with its own credentials and model discovery, so its catalog is loaded afresh in the
    // background (remote discovery can take 30 s; Send waits on "Loading models…"). The new catalog keeps the project's default model or the
    // current pick when it lists them.
    const previousModel=modelRef.current;let projectDefaultModel=null;
    const reloadModels=nextBootstrap=>{clearModelCatalog();refreshProviderModels({bootstrap:nextBootstrap,refreshBootstrap:false,preferredModel:()=>projectDefaultModel||previousModel}).catch(()=>{})};
    let switchedEnvironment=false;
    try{
      if(targetEnvironmentId!==currentEnvironmentId){
        // A switch that fails answers with an error status, which api() throws: one that answers has gone through.
        await api("/api/environment/activate",{method:"POST",body:{id:targetEnvironmentId}});
        switchedEnvironment=true;
        const settingsSentAt=settingsSavesRef.current.count,[nextSettings,nextBootstrap]=await Promise.all([api("/api/settings"),api("/api/bootstrap")]);
        setSettings(settingsRead(nextSettings,settingsSentAt));
        setBootstrap(nextBootstrap);
        setRuntimeTransportRevision(value=>value+1);
        reloadModels(nextBootstrap);
        await refreshEnvironmentThemes();
      }
      const project=await touchProject(path,targetEnvironmentId);projectDefaultModel=project?.effectiveSettings?.defaultModel||null;
      if(shouldStartFresh)await newChat();
      setSection("chat");
      if(targetEnvironmentId===currentEnvironmentId&&rpcStatus==="connected")loadSkills(rpc,path);
    }catch(error){
      if(switchedEnvironment){
        try{
          await api("/api/environment/activate",{method:"POST",body:{id:currentEnvironmentId}});
          const settingsSentAt=settingsSavesRef.current.count,[rollbackSettings,rollbackBootstrap]=await Promise.all([api("/api/settings"),api("/api/bootstrap")]);
          setSettings(settingsRead(rollbackSettings,settingsSentAt));
          setBootstrap(rollbackBootstrap);
          setRuntimeTransportRevision(value=>value+1);
          // Reload this environment's catalog too: the forward load is discarded, so a late answer cannot bring the other environment's models back.
          projectDefaultModel=null;reloadModels(rollbackBootstrap);
          await refreshEnvironmentThemes();
        }catch(rollbackError){
          throw new Error((error?.message||String(error))+" Environment rollback failed: "+(rollbackError?.message||String(rollbackError)));
        }
      }
      throw error;
    }
  }
  async function onScopedSettingsChanged(){
    const settingsSentAt=settingsSavesRef.current.count,[nextSettings,projectData]=await Promise.all([api("/api/settings"),api("/api/projects")]);
    setSettings(settingsRead(nextSettings,settingsSentAt));
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
    settingsSaved(["onboardingComplete","defaultPermissionMode"]);setSettings(prev=>({...prev,...next}));
    if(rpc&&rpcStatus==="connected"){
      try{await loadThreads(rpc,{strict:true})}
      catch(error){showActionError(error,"Onboarding finished, but the thread list could not refresh")}
    }
    if(openSettings)openProviderSettings();
  }
  async function historyImported(){
    if(!rpc||rpcStatus!=="connected")return;
    try{await loadThreads(rpc,{strict:true})}
    catch(error){throw new Error("Conversation import succeeded, but Trebell could not refresh the thread list: "+(error?.message||String(error))+". Imported chats may appear after reconnecting or refreshing.")}
  }
  async function pickWorkspace(){
    const path=await window.trebellDesktop?.pickDirectory?.();
    if(!path)return;
    await onProjectOpen(path);
  }
  function onSkill(skill){const prefix=agentRuntime==="codex"?"$":"/";setPrompt(prev=>(prev?prev+" ":"")+prefix+skill.name+" ")}
  async function changeProviderAgent(name){
    if(leavingThread())return;const previous=providerAgent;const next=name||"";setProviderAgent(next);
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
    if(agentRuntime!=="codex"||!running||!activeThread?.id||!activeTurnId||!rpc||rpcStatus!=="connected"||nextModel===previous||leavingThread())return;
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
        setEvents(prev=>[...prev,{id:"live-model-"+Date.now(),kind:"tool",title:"Running turn switched to "+(modelMeta?.[nextModel]?.name||modelLabel(nextModel)||nextModel),status:"done",raw:{model:nextModel}}]);
      }
    }catch(error){
      setEvents(prev=>[...prev,{id:"live-model-error-"+Date.now(),kind:"error",title:"Could not change the running turn's model. The new model will apply to the next turn: "+(error.message||String(error)),status:"done",raw:{model:nextModel}}]);
    }
  }

  function openRightPanel(tab="files"){
    // Said in the notice beside the conversation, which the next press replaces: each press used to add a row to the conversation.
    if(projectlessMode&&["diff","source"].includes(tab)){showActionError({message:"General chats do not have Git or repository changes."},tab==="diff"?"Changes":"Source control");return}
    setRightPanelTab(tab);setRightPanelOpen(true);setSection("chat");
  }
  // The header toggle and its key reopen the panel on the tab it was closed on (the toggle used to reopen it on Files); a General
  // chat, which has no Git or repository changes, reopens it on Files.
  function toggleRightPanel(){if(rightPanelOpen){setRightPanelOpen(false);setRightPanelMaximized(false)}else openRightPanel(projectlessMode&&["diff","source"].includes(rightPanelTab)?"files":rightPanelTab||"files")}
  // A page the person asks for (a destination, its shortcut, the palette or a crumb). While a Back or Forward still opens its thread,
  // that is a move of their own, which wins over the step (showNavigationEntry): the page the step's open covers too, which changes
  // no location the navigation effect could see.
  function navigateSection(next){
    const step=navigationHistoryRef.current.applying;if(step&&!step.moved){step.moved=true;step.wake?.()}
    if(next==="source"){openRightPanel("source");return}
    if(next==="preview"){openRightPanel("preview");return}
    if(next==="agents"){openRightPanel("agents");return}
    setSection(next);
  }
  const openProviderSettings=useCallback(()=>{setSettingsEntry({section:"agents",target:"agents-provider",nonce:Date.now()});navigateSection("settings")},[]);
  // The composer's Configure buttons ask for the provider's API key, so they land in its field.
  const configureProviderKey=useCallback(()=>{setSettingsEntry({section:"agents",target:"agents-provider",focus:"provider-api-key",nonce:Date.now()});navigateSection("settings")},[]);
  useEffect(()=>{if(section!=="settings")setSettingsEntry(null)},[section]);
  // At 900px and below the inspector is an overlay drawer over the main column. Opening a full page closes it (the page would
  // otherwise sit mostly under it); Escape and a click on the dimmed area close it too, and focus moves into the drawer when it
  // opens and back to the control that opened it when it closes.
  const narrowDrawer=viewportWidth<=900;
  const drawerOpenerRef=useRef(null);
  useEffect(()=>{
    if(!PAGE_CRUMBS[section]||!rightPanelOpen||!window.matchMedia?.("(max-width:900px)")?.matches)return;
    setRightPanelOpen(false);setRightPanelMaximized(false);
  },[section]);
  useEffect(()=>{
    if(!narrowDrawer)return;
    if(rightPanelOpen){
      const opener=document.activeElement;drawerOpenerRef.current=opener&&!opener.closest?.("[data-testid=right-panel]")?opener:null;
      const frame=requestAnimationFrame(()=>{const panel=document.querySelector("[data-testid=right-panel]");if(panel&&!panel.contains(document.activeElement))panel.querySelector(".context-panel-tab.active,.context-panel-tab")?.focus({preventScroll:true})});
      return()=>cancelAnimationFrame(frame);
    }
    const opener=drawerOpenerRef.current;drawerOpenerRef.current=null;
    if(opener?.isConnected&&!document.activeElement?.closest?.("input,textarea,select,[contenteditable=true]"))opener.focus({preventScroll:true});
  },[rightPanelOpen,narrowDrawer]);
  useEffect(()=>{
    if(!narrowDrawer||!rightPanelOpen)return;
    const keyDown=event=>{
      if(event.key!=="Escape"||event.defaultPrevented)return;
      if(document.querySelector("[aria-modal=true],dialog[open],[role=menu],[role=listbox]"))return;
      const target=event.target;
      if(target?.closest?.("[data-testid=right-panel]")&&target.closest("input,textarea,select,[contenteditable=true],.terminal-panel"))return;
      event.preventDefault();setRightPanelOpen(false);setRightPanelMaximized(false);
    };
    window.addEventListener("keydown",keyDown);return()=>window.removeEventListener("keydown",keyDown);
  },[narrowDrawer,rightPanelOpen]);
  async function saveAppSettings(patch){
    if("appearance" in patch&&environmentThemeCatalog?.environmentKey){
      const selections={...(settings.environmentThemeSelections||{})};
      delete selections[environmentThemeCatalog.environmentKey];
      patch={...patch,environmentThemeSelections:selections};
    }
    const next=await api("/api/settings",{method:"POST",body:patch});settingsSaved(Object.keys(patch));setSettings(prev=>({...prev,...next}));return next;
  }
  async function cycleTheme(){const themes=["dark","midnight","black",...(settings.customThemes||[]).map(theme=>theme.id)];const next=themes[(themes.indexOf(settings.appearance||"dark")+1)%themes.length];await saveAppSettings({appearance:next})}
  async function cycleAppearance(){const modes=["system","light","dark"];const next=modes[(modes.indexOf(settings.appearanceMode||"system")+1)%modes.length];await saveAppSettings({appearanceMode:next})}

  // While a thread other than the open one opens, the sidebar row and the header name it at once (the composer waits) and, once it
  // takes long, its opening state covers the conversation and the composer drops the open thread's own controls and context; a quick
  // open leaves those as they are until the thread shows rather than blank them for a few frames. Opened from a page such as History,
  // it shows in the chat view while that page waits hidden (the conversation it replaces is not mounted); a page asked for after the
  // click shows as usual. What is underneath stays the view before the click, so a failed open only ends this.
  const openingView=openingPending?opening.thread:null,openingShown=Boolean(openingView&&openingCover);
  const openingOverPage=openingShown&&opening.toChat&&section!=="chat"&&section!=="new"&&section===opening.from&&!opening.pageAsked,viewSection=openingOverPage?"chat":section;
  const headerThread=openingView||activeThread;
  const activeTitle=titleOf(openThreadTitleSource(headerThread,threads));
  // The approval of the thread the header names comes first; one from another thread says which task is asking, the thread being
  // left included while another opens.
  const shownApproval=approvalToShow(approvals,headerThread?.id);
  // The task that asked, named when it is not the open thread.
  const requestThreadLabel=request=>{const id=approvalForeignThreadId(request,headerThread?.id);if(!id)return "";const owner=threads.find(thread=>String(thread.id)===id);return owner?titleOf(owner):"another thread"};
  const shownApprovalThreadLabel=requestThreadLabel(shownApproval);
  // The crumb names the project as the sidebar and Projects page do (its record's name); a folder without a record, or one the
  // record does not describe yet, shows the folder name. A thread still opening is named with its own: General chat, the open
  // project when the thread is in it, else its project's record as this window knows it (see projectRecords), else its folder.
  const openingMeta=openingView?threadMeta[openingView.id]||{}:null;
  const crumbProjectless=openingView?(Object.prototype.hasOwnProperty.call(openingMeta,"projectless")?Boolean(openingMeta.projectless):Boolean(openingView.providerMeta?.projectless)):projectlessMode;
  const crumbPath=openingView&&!crumbProjectless&&openingView.cwd?openingView.cwd:projectPath;
  const projectFolderName=String(crumbPath||activeThread?.cwd||bootstrap.cwd||"Workspace").split(/[\\/]/).filter(Boolean).at(-1)||"Workspace";
  const openingEnvironmentId=openingView?openingMeta.environmentId??openingView.providerMeta?.environmentId??null:null;
  const crumbRecord=currentProject&&sameWorkspacePath(currentProject.path,crumbPath)?currentProject:openingView?projectRecords.find(project=>sameWorkspacePath(project.path,crumbPath)&&(project.environmentId||null)===(openingEnvironmentId||null)):null;
  const projectRecordName=String(crumbRecord?.name||"").trim();
  const projectLabel=crumbProjectless?"No project":projectRecordName||projectFolderName;
  // The header's branch, Open in and script belong to the project before the click: a thread of another workspace takes them away
  // while its opening state covers the conversation, as it does the open thread's own controls.
  const projectControlsShown=!(openingShown&&(crumbProjectless!==projectlessMode||!sameWorkspacePath(crumbPath,projectPath)));
  // The shown thread's queue a Stop holds: its follow-ups say so, as nothing in it starts by itself.
  const queueHeld=heldQueues.has(String(activeThread?.id||null));
  const providerLabel=modelProviderLabel(provider);
  const agentRuntimeLabel=AGENT_RUNTIME_LABELS[agentRuntime]||agentRuntime;
  // Why a follow-up cannot go now on a harness that cannot steer: Send now's title, and the shortcut's note (sendQueuedNow). It says
  // what the person can do, which holds for every follow-up: one held after a Stop, or one to retry, does not go by itself.
  const cannotSteerReason=agentRuntimeLabel+" cannot steer a running turn; Send now works once the turn ends";
  // Git text is written by the runtime the server runs (bootstrap), so the Source Control label names that harness.
  const sourceControlRuntime=bootstrap.agentRuntime||agentRuntime;
  const sourceControlRuntimeInstanceId=bootstrap.agentRuntimeInstanceId||(settings.agentRuntime===sourceControlRuntime?settings.agentRuntimeInstanceId:null)||null;
  const conversationEditFromHere=useLatestCallback(editFromHere);
  // Whether a turn runs now, for an action that waited on a question: the `running` of its own render is from before it asked.
  const turnRunsNow=useLatestCallback(()=>running);
  const conversationLoadEarlier=useLatestCallback(()=>loadEarlierMessages("top"));
  const conversationLoadGap=useLatestCallback(()=>loadEarlierMessages("gap"));
  const focusThreadFindLatest=useLatestCallback(focusThreadFindOccurrence);
  // The marker for turns not loaded between a detached find hit and the newest pages, before the first message of those pages.
  const historyDetached=historyPage.threadId===activeThread?.id?historyPage.detached||null:null;
  const conversationHistoryGap=useMemo(()=>historyDetached&&historyPage.nextCursor?{beforeId:historyGapBeforeId(messages,historyDetached),missing:historyDetached.missing||null}:null,[messages,historyDetached,historyPage.nextCursor]);
  const conversationCite=useLatestCallback((message,text)=>runUserAction(()=>citeAssistant(message,text),"Could not cite assistant text"));
  const composerPromptEdit=useLatestCallback(()=>{setPromptHistoryIndex(-1);setComposerAlert(current=>current?.kind==="send"?null:current)});
  const composerSend=useLatestCallback(send);
  const composerBackgroundSend=useLatestCallback(sendInBackground);
  const composerSetModel=useLatestCallback(changeComposerModel);
  const composerRemoveAttachment=useLatestCallback(path=>setAttachments(prev=>prev.filter(x=>x!==path)));
  const composerSetPermissionMode=useLatestCallback(mode=>{pickedModesRef.current.permission=true;setPermissionMode(mode)});
  const composerSetWorkspaceMode=useLatestCallback(mode=>{pickedModesRef.current.workspace=true;setWorkspaceMode(mode)});
  const composerRemoveContext=useLatestCallback(removeContext);
  const composerPickFiles=useLatestCallback(()=>runUserAction(()=>pickFiles("Could not attach files"),"Could not attach files"));
  const composerCaptureScreen=useLatestCallback(()=>runUserAction(captureDesktop,"Could not capture screen"));
  const composerPaste=useLatestCallback(onPaste);
  const composerDrop=useLatestCallback(onDrop);
  const composerFileMentionSearch=useLatestCallback(searchComposerFiles);
  const composerFileMentionAttach=useLatestCallback(item=>runUserAction(()=>attachComposerFileMention(item),"Could not attach file mention"));
  const composerCollaborationMode=useLatestCallback(changeCollaborationMode);
  const composerProviderAgent=useLatestCallback(changeProviderAgent);
  const composerCompact=useLatestCallback(compactContext);
  const composerCancelQueuedEdit=useLatestCallback(cancelQueuedEdit);
  const composerRuntimeProfile=useLatestCallback(switchThreadRuntimeProfile);
  const composerRetryTransport=useLatestCallback(()=>setRuntimeTransportRevision(value=>value+1));
  const settingsProviderChanging=useLatestCallback(nextProvider=>{modelRefreshSeqRef.current++;modelCatalogScopeRef.current=modelCatalogScope(agentRuntime,nextProvider);clearModelCatalog()});
  const settingsProviderUpdated=useLatestCallback((options={})=>refreshProviderModels(options));
  const settingsAgentRuntimeSwitch=useLatestCallback(switchAgentRuntime);
  const runtimeSwitchLabel=runtimeSwitch?(runtimeSwitch.to===runtimeSwitch.from?`Reloading ${agentRuntimeName(runtimeSwitch.to)}…`:`Switching to ${agentRuntimeName(runtimeSwitch.to)}…`):"";
  if(rpcStatus==="connected")transportConnectedRef.current=true;
  const composerReasoningEffort=useLatestCallback(async effort=>{
    if(!model)return;
    const key=modelReasoningEffortKey(agentRuntime,provider,model),next={...(settings.modelReasoningEfforts||{})},normalized=String(effort||"").trim().toLowerCase();
    if(normalized)next[key]=normalized;else delete next[key];
    await saveAppSettings({modelReasoningEfforts:next});
    if(agentRuntime==="codex")await updateCodexThreadSetting({effort:normalized||null});
  });
  const composerServiceTier=useLatestCallback(async tier=>{
    if(!model)return;
    const key=modelServiceTierKey(agentRuntime,provider,model),next={...(settings.modelServiceTiers||{})},normalized=String(tier||"").trim().toLowerCase();
    if(normalized)next[key]=normalized;else delete next[key];
    await saveAppSettings({modelServiceTiers:next});
    if(agentRuntime==="codex"&&normalized)await updateCodexThreadSetting({serviceTier:normalized});
  });
  const composerModelOption=useLatestCallback(async(id,value)=>{
    if(!model)return;
    await saveAppSettings({modelOptionValues:modelOptionSettingsWith(settings,agentRuntime,provider,model,id,value)});
  });
  const activityOpenPanel=useLatestCallback(name=>name==="workspace"?openRightPanel("diff"):setPanel(name));
  // The cards the conversation shows: the open thread's, less the turn the live card shows (it lists that turn's own steps). The
  // newest turn's card is open until the person closes it, none while a sent message waits for its turn.
  const shownTurnActivity=turnActivity.threadId&&turnActivity.threadId===activeThread?.id?turnActivity:null;
  const liveCardTurnId=useMemo(()=>cardTurnId&&events.some(event=>event.fromItem&&event.turnId===String(cardTurnId))?String(cardTurnId):null,[cardTurnId,events]);
  const shownTurnOrder=turnOrder.threadId===activeThread?.id?turnOrder.ids:null;
  const newestTurnId=useMemo(()=>newestCardTurnId({messages,turnOrder:shownTurnOrder,turns:shownTurnActivity?.turns}),[messages,shownTurnOrder,shownTurnActivity]);
  // An activity card's head stays where it was clicked as the card opens or closes: the view stops following the end and an older
  // page's anchor stops holding it, the toggle runs, and once the card has its new size the view moves by however far the head did.
  const activityCardToggleLayout=useLatestCallback((head,toggle)=>{
    const node=conversationScrollRef.current,top=head.getBoundingClientRect().top;
    followConversationEndRef.current=false;stopHistoryAnchorSettle();toggle();
    if(!node)return null;
    return ()=>{const moved=head.isConnected?head.getBoundingClientRect().top-top:0;if(moved)node.scrollTop+=moved;followConversationEndRef.current=captureThreadScrollPosition(node)?.atEnd===true};
  });
  const sidebarNavigate=useLatestCallback(navigateSection);
  const sidebarOpenThread=useLatestCallback(openThread);
  const sidebarNewThread=useLatestCallback(newTask);
  const sidebarOpenPalette=useCallback(()=>setPaletteOpen(true),[]);
  const closePalette=useCallback(()=>setPaletteOpen(false),[]);
  // The sidebar and the command palette show the user's own keybindings (Settings > Shortcuts), not the defaults. A command whose
  // key another command takes over everywhere it runs (Settings > Shortcuts says which) shows no key, since pressing it runs the
  // other command, and nor does one whose saved key or condition Settings flags as not working, since pressing it runs nothing.
  const commandKey=useMemo(()=>{
    const rules=projectKeybindingRules(normalizeKeybindingRules(settings),projectlessMode?[]:currentProject?.scripts||[]),shadowed=shadowedKeybindings(rules);
    return command=>{const rule=rules.find(rule=>rule.command===command);return rule&&!shadowed.has(command)&&ruleRuns(rule)?rule.key:""};
  },[settings.keybindingRules,settings.keyboardShortcuts,projectlessMode,currentProject?.scripts]);
  const sidebarShortcuts=useMemo(()=>({newChat:commandKey("newChat"),commandPalette:commandKey("commandPalette"),sidebarToggle:commandKey("sidebarToggle"),projects:commandKey("projects"),settings:commandKey("settings"),environments:commandKey("environments"),previewToggle:commandKey("previewToggle")}),[commandKey]);
  // The header's Open sidebar and Command palette buttons name the keys those commands are on, or none.
  const withKey=(label,key)=>shortcutHint(key)?label+" · "+shortcutHint(key):label;
  const sidebarThreadAction=useLatestCallback(threadAction);
  const sidebarMoveThread=useLatestCallback(moveThreadOrder);
  const threadMoves=useMemo(()=>threadMoveAvailability(displayThreads,threadMeta),[displayThreads,threadMeta]);
  // The sidebar runtime card's dot follows the harness connection as the composer and the Runtime panel report it: green only
  // while connected and set up, amber while starting or (re)connecting, red after a failed connection. One object per tone and
  // label, so the memoized sidebar does not re-render on every App render (each composer keystroke).
  const [sidebarConnectionTone,sidebarConnectionLabel]=bootstrap.mock?["ok","Ready"]:!runtimeKnown?["warn","Starting"]
    :rpcStatus==="connected"?(providerReady?["ok","Connected"]:["off","Setup required"])
    :rpcStatus==="error"?["err","Connection failed"]
    :["warn",transportConnectedRef.current?"Reconnecting…":"Connecting…"];
  const sidebarConnection=useMemo(()=>({tone:sidebarConnectionTone,label:sidebarConnectionLabel}),[sidebarConnectionTone,sidebarConnectionLabel]);
  const workspaceHeaderRef=useCallback(node=>observeHeaderFit(node),[]);
  // The header's actions, shared by its buttons and by the More actions menu they fold into at the tightest fit.
  const headerScript=(currentProject?.scripts||[]).find(item=>item.id===currentProject.preferredScriptId)||currentProject?.scripts?.[0]||null;
  const runHeaderScript=()=>runUserAction(()=>runProjectAction(headerScript),"Project action failed");
  // The actions that run now, by environment, project and action, as the server tells them when a project opens and as each run
  // answers (an answer that comes later never drops a run made meanwhile). A watch socket per running action hears its terminal end
  // (its command exited, or Stop), with none of its output; nothing is polled.
  const actionRunsKey=projectlessMode||!projectPath?"":(workspaceEnvironmentId||"")+"\0"+projectPath;
  const actionRunKey=script=>actionRunsKey+"\0"+script.id,actionStartsRef=useRef(new Map()),scriptButtonRef=useRef(null);
  // Stop goes with the run it ends (pressed, or the action ended on its own): a keyboard on it goes on from the action's button, not
  // from the top of the page.
  const scriptStopRef=useCallback(node=>()=>{if(document.activeElement===node)scriptButtonRef.current?.focus()},[]);
  useEffect(()=>{
    if(!actionRunsKey)return;let live=true;
    api("/api/project-script/runs?"+new URLSearchParams({path:projectPath,environmentId:workspaceEnvironmentId||""})).then(data=>{if(live)setActionRuns(current=>{const next={...current};for(const [scriptId,sessionId] of Object.entries(data?.runs||{}))next[actionRunsKey+"\0"+scriptId]??=sessionId;return next})},()=>{});
    return()=>{live=false};
  },[actionRunsKey]);
  const actionRunSessions=Object.values(actionRuns).join("|");
  useEffect(()=>{
    const sockets=[];
    for(const sessionId of new Set(Object.values(actionRuns))){
      const ws=new WebSocket(wsUrl("/api/terminal/ws?watch=1&session="+encodeURIComponent(sessionId)));sockets.push(ws);
      const ended=()=>setActionRuns(current=>Object.fromEntries(Object.entries(current).filter(([,id])=>id!==sessionId)));
      ws.onmessage=event=>{let message;try{message=JSON.parse(event.data)}catch{return}if(message.type==="exit"||(message.type==="state"&&!message.running))ended()};
      ws.onclose=()=>{if(!ws.trebellClosed)ended()};
    }
    return()=>{for(const ws of sockets){ws.trebellClosed=true;ws.close()}};
  },[actionRunSessions]);
  const headerRunning=Boolean(headerScript&&actionRuns[actionRunKey(headerScript)]);
  async function stopHeaderScript(){
    const script=headerScript;if(!script||!projectPath)return;const key=actionRunKey(script);
    const result=await api("/api/project-script/stop",{method:"POST",body:{path:projectPath,environmentId:workspaceEnvironmentId,scriptId:script.id}});
    if(!result?.session?.running)setActionRuns(current=>{const next={...current};delete next[key];return next});
  }
  const reviewFromHeader=()=>runUserAction(startReview,"Could not start review");
  const reviewHint=running?"Wait for the running turn to finish before reviewing":"Review uncommitted changes";
  // A rename the harness refuses says why, and the title keeps its name; with the harness away the title cannot rename at all.
  const renameFromHeader=()=>runUserAction(renameThread,"Could not rename thread");
  const renameReady=Boolean(rpc)&&rpcStatus==="connected";
  const toggleTerminalPanel=()=>setPanel(panel==="terminal"?null:"terminal");
  // Not a runUserAction, which first clears the last action's error: switching the mode leaves an error the person has not read yet.
  const toggleAppearanceMode=()=>saveAppSettings({appearanceMode:resolvedMode==="dark"?"light":"dark"}).catch(error=>showActionError(error,"Could not change appearance"));
  const appearanceToggleLabel=resolvedMode==="dark"?"Switch to light mode":"Switch to dark mode";
  // A Browser panel recording goes on with the panel closed: the header's panel button says so, with a red mark, until it stops.
  const browserRecording=useBrowserRecording(),panelToggleLabel=browserRecording?["Open files and diff, browser recording on","Toggle workspace panel · Browser recording on"]:["Open files and diff","Toggle workspace panel"];
  const recordingMark=browserRecording&&<i className="recording-mark" aria-hidden="true"/>;
  // One Open-in state for the row's picker and the menu's copy, so both open the editor last chosen in either, and an Open from
  // either replaces the failure the row's picker shows. The menu closes as Open runs, so a failure there is reported like the
  // menu's other actions, not beside a picker that has gone: in the shell's own sentence, as the row's picker shows it, which
  // already says what could not be opened ("Could not start Zed: …", "Could not open the folder: …").
  const headerOpenIn=useOpenInEditors(projectPath,viewSection==="chat"||viewSection==="new");
  const headerOpenInShown=!projectlessMode&&!workspaceRemote&&Boolean(projectPath)&&headerOpenIn.editors.length>0;
  const openProjectFromMenu=()=>runUserAction(()=>headerOpenIn.open(),"");
  const sidebarBulkAction=useLatestCallback(bulkAction);
  const sidebarCollapse=useLatestCallback(()=>setSidebarOpen(false));
  // A project's Undo on Projects can run after the person has left the page or opened another project (its toast outlives the
  // page), so both read the project that is open when they run, not the one open when the page last drew.
  const projectIsOpen=useLatestCallback(project=>!projectlessMode&&Boolean(project?.path)&&project.path===projectPath&&(project.environmentId||null)===(workspaceEnvironmentId||null));
  // Projects says at once when a project changes, is removed or is put back (under a new id), so the header, its action, the
  // palette's actions and projects (the list it read when last open, until it reads it again) and the crumb of a thread still
  // opening name what the list holds now. The open project's removal leaves its folder open.
  // A save that answers after its project was removed names a record that is gone (one put back has a new id), so it is let go.
  const removedProjectIdsRef=useRef(new Set());
  // A default of the open project changed there applies to the composer at once, as opening the project applies them, so a New
  // task uses it without a reload. Only a default that changed applies: a rename or an icon leaves a mode the person picked.
  const projectsPageUpdated=useLatestCallback(project=>{if(removedProjectIdsRef.current.has(project?.id))return;if(project?.id){setProjectRecords(previous=>[project,...previous.filter(item=>item.id!==project.id)]);setPaletteProjects(previous=>previous.some(item=>item.id===project.id)?previous.map(item=>item.id===project.id?project:item):[...previous,project])}if(!projectIsOpen(project))return;
    const before=currentProject?.effectiveSettings||{},after=project.effectiveSettings||{};
    if(after.defaultPermissionMode&&after.defaultPermissionMode!==before.defaultPermissionMode)setPermissionMode(after.defaultPermissionMode);
    if(after.defaultWorkspaceMode&&after.defaultWorkspaceMode!==before.defaultWorkspaceMode)setWorkspaceMode(after.defaultWorkspaceMode);
    if(after.defaultModel&&after.defaultModel!==before.defaultModel&&modelsRef.current.includes(after.defaultModel)){setModel(after.defaultModel);setSelectedModels([after.defaultModel])}
    setCurrentProject(project)});
  const projectsPageRemoved=useLatestCallback(project=>{removedProjectIdsRef.current.add(project?.id);setProjectRecords(previous=>previous.filter(item=>item.id!==project?.id));setPaletteProjects(previous=>previous.filter(item=>item.id!==project?.id));setCurrentProject(current=>current&&current.id===project?.id?null:current)});
  // Retry's outcome (the list, or the error again) shows in the sidebar itself.
  const sidebarRetryThreads=useLatestCallback(()=>loadThreads(rpcRef.current).then(()=>undefined));
  const stopping=running&&stoppingThreadId!=null&&stoppingThreadId===String(activeThread?.id||"");
  const runningSidebarIds=useMemo(()=>runningThreadIds(displayThreads,{activeThreadId:activeThread?.id,activeRunning:running,turnStates:threadTurnStates}),[displayThreads,activeThread?.id,running,threadTurnStates]);
  // The tasks whose turns run ({title,runtime,open}), the open thread's first, from every listed thread whatever the search shows:
  // Settings asks before a switch takes the open one off the screen, and a switch that crosses Codex waits for those on the side the
  // window is on (SettingsPage, switchRuntimeForThread).
  const runningTasks=useMemo(()=>{
    const ids=runningThreadIds(threads,{activeThreadId:activeThread?.id,activeRunning:running,turnStates:threadTurnStates}),shown=running&&activeThread?.id?[activeThread]:[];
    return [...shown,...threads.filter(thread=>thread.id!==activeThread?.id&&ids.has(String(thread.id)))].map(thread=>({title:thread===activeThread?activeTitle:titleOf(thread),runtime:threadCatalogRuntime(thread,threadMeta[thread.id]||{},agentRuntime),open:thread===activeThread}));
  },[threads,activeThread,running,threadTurnStates,threadMeta,agentRuntime,activeTitle]);
  const completedEvents=finishedActivitySteps(events);
  // The palette's thread actions are for the thread the header names: none while another one opens (its own are not loaded yet).
  const paletteThread=Boolean(activeThread?.id&&!openingView);
  // A welcome suggestion fills the composer and gives it the focus with the caret at the end, so Enter sends it and typing carries on.
  // It replaces the draft as an edit does, so a note about the draft it replaces goes.
  function suggestPrompt(text){composerPromptEdit();setPrompt(text);requestAnimationFrame(()=>{const node=document.querySelector('[data-testid="composer"]');if(!node)return;node.focus();node.setSelectionRange(text.length,text.length)})}
  // keywords: another name a command is found by, the one the sidebar gives its destination.
  const paletteActions=paletteOpen?[
    {id:"new",label:"New thread",detail:"Start a clean coding task",keywords:"New task",shortcut:shortcutHint(commandKey("newChat")),onRun:newTask},
    {id:"new-general",label:"New general chat",detail:"Start without attaching a project or repository",onRun:newGeneralChat},
    ...(window.trebellDesktop?.pickDirectory?[{id:"folder",label:"Open workspace folder",detail:projectPath||"Choose a local folder",onRun:pickWorkspace}]:[]),
    {id:"projects",label:"Recent projects",detail:"Switch checkouts or clone a repository",onRun:()=>navigateSection("projects")},
    {id:"files",label:"Files",detail:"Browse and edit the workspace",onRun:()=>openRightPanel("files")},
    ...(!projectlessMode?[{id:"diff",label:"Changes",detail:"Inspect the current Git diff",onRun:()=>openRightPanel("diff")},{id:"git",label:"Source control",detail:gitInfo?.branch||"Git and pull requests",onRun:()=>openRightPanel("source")}]:[]),
    ...(!projectlessMode?[{id:"context",label:"Trebell context",detail:"Inspect repository context supplied to the latest turn",onRun:()=>openRightPanel("context")}]:[]),
    ...(paletteThread?[{id:"link-pr",label:"Link pull request",detail:"Attach a hosted review to this thread",onRun:async()=>{const url=await askText("Pull request URL");if(url)await linkPullRequestUrl(url,"manual")}}]:[]),
    // Toggle terminal's key opens the terminal only while it is closed (it closes an open one), so this row offers it only then.
    {id:"terminal",label:"Terminal",detail:"Open the persistent PTY",shortcut:panel==="terminal"?"":shortcutHint(commandKey("terminal")),onRun:()=>{setPanel("terminal");focusTerminalDrawer()}},
    ...((currentProject?.scripts||[]).map(script=>({id:"project-action:"+script.id,label:"Run "+script.name,detail:script.command,onRun:()=>runProjectAction(script)}))),
    {id:"browser",label:"Browser",detail:window.trebellDesktop?.browser?"Open Trebell Agent Browser":"Open hosted preview and local dev-server tools",onRun:()=>openRightPanel("preview")},
    ...(runtimeCapabilities.delegation?[{id:"agents",label:"Agents & collaboration",detail:"Delegated threads and collaboration mode",onRun:()=>openRightPanel("agents")}]:[]),
    ...(paletteThread?[{id:"goal",label:"Thread goal",detail:goal?.objective||"Set a durable objective",onRun:()=>openRightPanel("goal")}]:[]),
    ...(paletteThread&&gitInfo?.isGit?[{id:"review",label:"Review changes",detail:`Ask ${agentRuntimeLabel} to review uncommitted changes`,onRun:()=>startReview()}]:[]),
    ...(runtimeCapabilities.harnessTools?[{id:"tools",label:"Harness capabilities",detail:"Skills, MCP, plugins, apps and hooks",onRun:()=>navigateSection("tools")}]:[]),
    {id:"environments",label:"Environments",detail:"Local, WSL and SSH",onRun:()=>navigateSection("environments")},
    {id:"usage",label:"Usage",detail:"Tokens and cost across recorded turns",onRun:()=>navigateSection("usage")},
    {id:"licenses",label:"Open source licenses",detail:"Third-party packages and installed license notices",onRun:()=>navigateSection("licenses")},
    // Cycle appearance mode and Cycle theme step on to the next choice, whatever it is, so no single row here offers their keys.
    {id:"appearance-system",label:"Appearance: System",detail:"Follow the operating system light/dark setting",onRun:()=>saveAppSettings({appearanceMode:"system"})},
    {id:"appearance-light",label:"Appearance: Light",detail:"Use light appearance",onRun:()=>saveAppSettings({appearanceMode:"light"})},
    {id:"appearance-dark",label:"Appearance: Dark",detail:"Use dark appearance",onRun:()=>saveAppSettings({appearanceMode:"dark"})},
    {id:"theme-trebell",label:"Theme: Trebell",detail:"Default purple Trebell palette",onRun:()=>saveAppSettings({appearance:"dark"})},
    {id:"theme-midnight",label:"Theme: Midnight",detail:"Cooler deep-blue Trebell palette",onRun:()=>saveAppSettings({appearance:"midnight"})},
    {id:"theme-black",label:"Theme: Black",detail:"OLED-friendly black Trebell palette",onRun:()=>saveAppSettings({appearance:"black"})},
    ...(settings.customThemes||[]).map(theme=>({id:"theme-custom:"+theme.id,label:"Theme: "+theme.name,detail:`Custom ${theme.appearance||"dark"} theme`,onRun:()=>saveAppSettings({appearance:theme.id})})),
    {id:"settings",label:"Settings",detail:window.trebellDesktop?"Providers, permissions and desktop behavior":"Providers, permissions and workspace behavior",onRun:()=>navigateSection("settings")},
    ...(paletteThread&&messages.length?[{id:"copy",label:"Copy conversation",detail:"Copy this thread as text",onRun:shareThread}]:[]),
  ]:null;

  const previewSurface=<PreviewPage
    projectPath={projectPath}
    onAttachText={async(name,text,meta={})=>addContextAttachment({name,text,kind:meta.kind||"browser",label:meta.label||"Browser context",detail:meta.detail||""})}
    onAttachImage={async(dataUrl)=>{const d=await api("/api/attachments/blob",{method:"POST",body:{name:"browser-screenshot.png",mime:"image/png",dataBase64:String(dataUrl).split(",")[1]||""}});const [path]=await prepareAttachmentPaths([d.path]);await addContextPath(path,{kind:"browser",label:"Browser screenshot",detail:"PNG capture"})}}
    onAttachFile={async(file,meta={})=>{const d=await blobAttachment(file);await addContextPath(d.path,{kind:meta.kind||"browser",label:meta.label||file.name,detail:meta.detail||`${Math.round(file.size/1024)} KB`})}}
    onError={error=>showActionError(error,"")}
  />;

  function rightPanelContent(){
    if(rightPanelTab==="files"||rightPanelTab==="diff")return <WorkspacePanel key={workspaceEnvironmentId||"local"} tab={rightPanelTab} onTabChange={setRightPanelTab} allowDiff={!projectlessMode} projectPath={projectPath} environmentId={workspaceEnvironmentId} remote={workspaceRemote} activeThreadId={activeThread?.id} reviewedFiles={reviewedFiles} onReviewedChange={toggleReviewed} onAttachPath={path=>addFiles([path])} onReviewComment={attachReviewComment}/>;
    if(rightPanelTab==="context")return <ContextInspector packet={activeThread?.id?threadMeta[activeThread.id]?.trebellContext||null:null} error={activeThread?.id?threadMeta[activeThread.id]?.trebellContextError||null:null} pressure={activeThread?.id?threadMeta[activeThread.id]?.trebellContextPressure||null:null} remote={workspaceRemote} root={projectPath||null} environmentId={workspaceEnvironmentId||null}/>;
    if(rightPanelTab==="preview")return previewSurface;
    if(rightPanelTab==="source")return projectlessMode?<div className="empty-state">General chats are not attached to source control.</div>:<SourceControlPanel projectPath={projectPath} environmentId={workspaceEnvironmentId} remote={workspaceRemote} environmentName={currentProject?.environment?.name||bootstrap.activeEnvironment?.name||"Local machine"} model={model} provider={provider} agentRuntime={sourceControlRuntime} agentRuntimeInstanceId={sourceControlRuntimeInstanceId} agentRuntimeLabel={agentRuntimeName(sourceControlRuntime)} threadId={activeThread?.id||null} sourceControlSettings={currentProject?.effectiveSettings||effectiveProjectSettings} onProjectChange={onProjectOpen} onAttachPr={attachPr} onLinkPr={linkPr} onLinkPrUrl={linkPullRequestUrl} onOpenLinkedThread={openLinkedThread} onSelectedPrChange={setSourceSelectedPr} onLinkedPullRequestsChanged={links=>activeThread?.id&&applyThreadPullRequestLinks(activeThread.id,links)} onGitInfo={next=>setGitInfo(current=>sameSnapshot(current,next)?current:next)} gitInfo={gitInfo} linkedPullRequests={activeThread?.id?linkedPullRequests:[]}/>;
    if(rightPanelTab==="agents"&&runtimeCapabilities.delegation)return <div className="panel-page"><AgentsPage threads={threads} threadMeta={threadMeta} activeThread={activeThread} onOpen={openThread} onAction={threadAction} onDelegate={delegateTask} onRefreshThreads={()=>rpc?loadThreads(rpc,{strict:true}):Promise.resolve([])} rpc={rpc} rpcStatus={rpcStatus} model={model} telemetry={threadTelemetry} canModelDelegate={Boolean(runtimeCapabilities.dynamicTools&&runtimeCapabilities.delegation)}/></div>;
    // Everything the goal panel holds (drafts, busy state and its last error) belongs to one thread: another thread, or a harness
    // switch, starts it from that thread's own saved goal, or from the draft left unsaved on it (GoalPanel keeps each thread's
    // until it is saved or discarded), never with the previous thread's draft or error. A save that answers after another thread
    // opened updates nothing on screen (that thread loads its own goal), like every other goal and continuity update here. While
    // another thread's opening state is up, the panel waits for that thread instead of offering the goal of the one being left,
    // which only hides: a failed open brings it back with what was being written in it.
    if(rightPanelTab==="goal"){
      const goalThreadId=activeThread?.id||null,forGoalThread=apply=>next=>{if(goalThreadId&&activeThreadRef.current?.id===goalThreadId)apply(next)};
      return <>{openingShown&&<div className="empty-state"><Target size={28}/><strong>{activeTitle}</strong><span>Opening thread…</span></div>}<GoalPanel key={goalThreadId?"goal:"+goalThreadId:"goal:none"} covered={openingShown} rpc={rpc} rpcStatus={rpcStatus} thread={activeThread} goal={goal} onGoal={forGoalThread(setGoal)} continuity={continuity} onContinuity={forGoalThread(setContinuity)}/></>;
    }
    return <div className="runtime-surface">
      <section className="runtime-summary">
        {(()=>{const transport=bootstrap.mock?{label:"Ready · replies use the direct provider route",tone:"ok"}:rpcStatus==="connected"?{label:"Connected locally",tone:"ok"}:transportStatusCopy(rpcStatus);return <div><span className={"runtime-dot tone-"+transport.tone+(transport.tone==="ok"?" online":"")}/><div><strong>{running?"Agent working":agentRuntimeLabel+" harness"}</strong><span>{transport.label}</span></div></div>})()}
        {/* Steps are counted only when there are some: an idle runtime has no step pending. */}
        <small data-testid="runtime-activity-steps">{events.length?`${completedEvents}/${events.length} current activity ${events.length===1?"step":"steps"} complete`:"No activity yet"}</small>
      </section>
      <ApprovalCard key={shownApproval?.id??"none"} request={shownApproval} threadLabel={shownApprovalThreadLabel} onResolve={(request,decision)=>runUserAction(()=>resolveApproval(request,decision),"Could not answer approval request")}/>
      <section className="runtime-grid">
        <div><span>Agent harness</span><strong>{agentRuntimeLabel}</strong></div>
        <div><span>Harness status</span><strong>{providerReady?"Ready":"Setup required"}</strong></div>
        <div><span>CPU</span><strong>{stats.cpu||"—"}</strong></div>
        <div><span>Memory</span><strong>{stats.memory||"—"}</strong></div>
        <div><span>Disk</span><strong>{stats.disk||"—"}</strong></div>
        <div><span>Context</span>{" "}<strong>{contextValueLabel(tokenUsage)}</strong></div>
      </section>
      <section className="runtime-capabilities" data-testid="runtime-capabilities">
        <div className="runtime-capabilities-head"><strong>Runtime capability matrix</strong><span>Only exposed controls should be usable.</span></div>
        <div className="runtime-capability-grid">
          {[
            ["Queue",runtimeCapabilities.queue],
            ["Fork",runtimeCapabilities.fork],
            ["Rewind",runtimeCapabilities.rewind],
            ["Compaction",runtimeCapabilities.compaction],
            ["MCP injection",runtimeCapabilities.mcpInjection],
            ["Language intelligence",runtimeCapabilities.languageIntelligence],
            ["Sandbox",runtimeCapabilities.nativeSandbox],
            ["Detached tasks",runtimeCapabilities.detachedTasks],
            ["Multi-model fan-out",runtimeCapabilities.multiModelFanout],
            ["Background processes",runtimeCapabilities.backgroundProcesses],
            ["Delegation",runtimeCapabilities.delegation],
            ["Harness tools",runtimeCapabilities.harnessTools],
            ["Steering",runtimeCapabilities.steering],
            ["Runtime profiles",runtimeCapabilities.runtimeProfileSwitching],
          ].map(([label,value])=><div key={label} className={value==="runtime"?"available runtime":value?"available":"unavailable"}>{value?<Check size={13} aria-hidden="true"/>:<Minus size={13} aria-hidden="true"/>}<span>{label}</span><strong>{capabilityStatus(value)}</strong></div>)}
        </div>
      </section>
      {/* The background processes and the trace are the open thread's: another thread starts each afresh, so an answer still on its
          way for the thread left lands nowhere. */}
      {runtimeCapabilities.backgroundProcesses&&activeThread?.id&&<LazySlot><AgentBackgroundTerminals key={activeThread.id} rpc={rpc} rpcStatus={rpcStatus} threadId={activeThread.id}/></LazySlot>}
      <RuntimeTrace key={activeThread?.id||""} threadId={activeThread?.id||null}/>
      <section className="runtime-activity"><strong>Latest activity</strong><p>{events.find(event=>event.status==="running")?.title||events.at(-1)?.title||"Waiting for a task"}</p></section>
    </div>;
  }

  if(initialLoadError)return <div className="startup-failure-shell">
    <div className="startup-failure-card" role="alert" aria-live="assertive" data-testid="startup-failure">
      <img src="/trebell-code-icon.svg" alt="" aria-hidden="true"/>
      <div>
        <span>Startup failed</span>
        <h1>Trebell Code could not load its local state</h1>
        <p>{initialLoadError}</p>
        <small>The normal workspace was not opened with fake or empty data.</small>
      </div>
      <button type="button" onClick={()=>{setInitialLoaded(false);setInitialLoadRevision(value=>value+1)}}>Retry startup</button>
    </div>
  </div>;

  const layoutStyle={
    "--sidebar-width":layoutPrefs.sidebarWidth+"px",
    "--right-panel-width":rightPanelWidth+"px",
    "--terminal-height":layoutPrefs.terminalHeight+"px",
  };
  // What the chat workspace holds, as classes its stylesheet reads (shell.css) instead of a :has() over its children: Chrome restyled
  // the whole workspace, the conversation with it, on every key typed under such a rule, as React rewrites the composer's text each key.
  // shelfChips: the composer's attachment shelf shows a chip (its attachments that are not context chips, and its uploads).
  const cloneBannerShown=Boolean(currentProject?.cloneJob&&currentProject.cloneJob.status!=="completed");
  const shelfChips=uploadingFiles.length>0||attachments.some(path=>!(contextChips||[]).some(chip=>chip.path===path));
  // And what the workspace shell holds, for the error toast's place (styles.css, overlays.css): :has() rules over all the shell or the
  // whole document read it, and Chrome restyled all of that for each element a streaming reply added while the toast showed (230
  // elements a delta, B23). The composer, its shelf and its menus show with the chat workspace; the terminal, beside any page.
  const composerShown=viewSection==="chat"||viewSection==="new";
  const workspaceHolds=(panel==="terminal"?" with-terminal":"")+(composerShown&&shelfChips?" with-shelf-chips":"")+(composerShown&&composerMenuShown?" with-composer-menu":"")+(composerShown&&prompt.length>=LONG_DRAFT_CHARS?" with-long-draft":"");
  return <div className={"app-shell"+(sidebarOpen?"":" sidebar-collapsed")+(window.trebellDesktop?" desktop-shell":" hosted-shell")} style={layoutStyle}>
    <ThreadSidebar runtimeStarting={!runtimeKnown} connection={sidebarConnection} threadMoves={threadMoves} section={viewSection} setSection={sidebarNavigate} threads={displayThreads} activeThreadId={headerThread?.id} query={query} setQuery={setQuery} searchError={threadSearchError} onOpen={sidebarOpenThread} onNew={sidebarNewThread} onThreadAction={sidebarThreadAction} onMove={sidebarMoveThread} selectedIds={selectedThreadIds} setSelectedIds={setSelectedThreadIds} onBulkAction={sidebarBulkAction} provider={provider} agentRuntime={agentRuntime} runtimeCapabilities={runtimeCapabilities} threadMeta={threadMeta} onCollapse={sidebarCollapse} onOpenProviderSettings={openProviderSettings} rightPanelOpen={rightPanelOpen} rightPanelTab={rightPanelTab} onOpenPalette={sidebarOpenPalette} shortcuts={sidebarShortcuts} listError={threadListError} onRetryList={sidebarRetryThreads} runningIds={runningSidebarIds} listLoaded={Boolean(bootstrap.mock)||threadListLoaded}/>
    {sidebarOpen&&<div className="layout-resizer sidebar-resizer" data-testid="sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" {...layoutSeparatorProps("sidebar")} onPointerDown={event=>beginLayoutResize("sidebar",event)}/>}

    <div className={"workspace-shell"+(rightPanelOpen?" right-open":"")+(rightPanelOpen&&rightPanelMaximized?" right-maximized":"")+workspaceHolds}>
      <main className={"main-frame"+(panel==="terminal"?" terminal-open":"")+(openingOverPage?" opening-over-page":"")}>
        <div className="window-bar">
          <span className="window-drag-space"/>
        </div>

        {(viewSection==="chat"||viewSection==="new")&&<div className={"chat-workspace"+(shelfChips?" with-shelf-chips":"")+(cloneBannerShown?" with-clone-banner":"")+(cloneBannerShown&&cloneRefreshError?" with-clone-error":"")}>
          <header className="workspace-header" ref={workspaceHeaderRef}>
            <div className="workspace-breadcrumb">
              {!sidebarOpen&&<button className="project-crumb sidebar-reopen" onClick={()=>setSidebarOpen(true)} aria-label="Open sidebar" title={withKey("Open sidebar",sidebarShortcuts.sidebarToggle)}><PanelLeftOpen size={14}/></button>}
              {/* The crumb opens Projects, in the desktop app too (its folder picker is on Projects and in the palette), and nothing beside
                  it looks like a menu. It goes with the chat view, so focus goes to the Projects heading instead of falling to the page. */}
              <button className={"project-crumb"+(crumbProjectless?" projectless":"")} onClick={()=>{navigateSection("projects");requestAnimationFrame(focusShownView)}} title={crumbProjectless?"No project · choose a project":projectLabel+" · Projects and workspaces"}>{crumbProjectless?<Sparkles size={14}/>:<FolderCode size={14}/>}<span>{projectLabel}</span></button>
              <span>/</span>
              {/* Renaming needs a thread: before the first message the title is plain text, not a button that does nothing. A thread
                  still opening keeps the button, disabled, so a quick open does not flash it away and back. The pull requests, Review,
                  Stop and the goal belong to the thread before the click: they go once its opening state covers it. The header cuts a
                  long title (and the branch name, which goes icon-only first), so their tooltips give them whole. */}
              {headerThread?.id?<button className="thread-title-button" onClick={renameFromHeader} disabled={Boolean(openingView)||!renameReady} title={openingView?undefined:activeTitle+" · "+(renameReady?"Rename thread":"Renaming needs "+agentRuntimeLabel+" to be connected")}><strong>{activeTitle}</strong><ChevronDown size={13}/></button>:<span className="thread-title-button is-static"><strong>{activeTitle}</strong></span>}
              {/* In a narrow header the first chip stands for every linked pull request ("#482 +1", then the icon and a count); its
                  tooltip names the others. */}
              {activeThread?.id&&!openingShown&&linkedPullRequests.map((pr,index,all)=><button className="header-pr" key={pr.url||pr.number} onClick={()=>openWebLink(pr.url)} aria-label={"Pull request #"+pr.number} title={"Open pull request #"+pr.number+(index===0&&all.length>1?" · also linked: "+all.slice(1).map(other=>"#"+other.number).join(", "):"")}><GitBranch size={11} aria-hidden="true"/><span className="header-pr-number">#{pr.number}</span>{index===0&&all.length>1&&<><span className="header-pr-more" aria-hidden="true">+{all.length-1}</span><span className="header-pr-count" aria-hidden="true">{all.length}</span></>}</button>)}
            </div>
            <div className="workspace-header-actions">
              {/* data-fold names the actions header-fit.js folds into the More actions menu when the title needs their room. */}
              {gitInfo?.isGit&&projectControlsShown&&<button className="header-control branch-control" data-fold="source" onClick={()=>openRightPanel("source")} title={(gitInfo.branch||"detached")+" · Source control"}><GitBranch size={14}/><span>{gitInfo.branch||"detached"}</span></button>}
              {headerOpenInShown&&projectControlsShown&&<OpenInControl openIn={headerOpenIn} fold="open-in"/>}
              {headerScript&&projectControlsShown&&<button ref={scriptButtonRef} className={"header-control script-control"+(headerRunning?" running":"")} data-fold="script" data-running={headerRunning||undefined} onClick={runHeaderScript} aria-label={headerScript.name} title={headerRunning?headerScript.name+" is running · Show its terminal":headerScript.command}>{headerRunning?<span className="script-running-dot" aria-hidden="true"/>:<Play size={13}/>}<span>{headerScript.name}</span></button>}
              {headerScript&&projectControlsShown&&headerRunning&&<button ref={scriptStopRef} className="header-control icon-only script-stop-control" data-fold="script" onClick={()=>runUserAction(stopHeaderScript,"Could not stop the project action")} aria-label={"Stop "+headerScript.name} title={"Stop "+headerScript.name}><CircleStop size={14}/></button>}
              {activeThread?.id&&!openingShown&&gitInfo?.isGit&&<button className="header-control review-control" data-fold="review" onClick={reviewFromHeader} disabled={running} aria-label="Review" title={reviewHint}><ShieldCheck size={14}/><span>Review</span></button>}
              {running&&!openingShown&&<button className={"header-control stop-control"+(stopping?" stopping":"")} disabled={stopping} onClick={()=>runUserAction(stop,"Could not stop turn")} aria-label={stopping?"Stopping":"Stop"} title={stopping?"Stopping the running turn…":"Stop the running turn"}><CircleStop size={14}/><span>{stopping?"Stopping…":"Stop"}</span></button>}
              <button data-testid="terminal-toggle" className={"header-control icon-only terminal-control "+(panel==="terminal"?"active":"")} data-fold="terminal" onClick={toggleTerminalPanel} aria-label="Toggle terminal" title="Toggle terminal"><PanelBottom size={16}/></button>
              {activeThread?.id&&!openingShown&&<button className={"header-control icon-only goal-control "+(rightPanelOpen&&rightPanelTab==="goal"?"active":"")} data-fold="goal" onClick={()=>openRightPanel("goal")} aria-label="Thread goal" title={goal?.objective||"Set thread goal"}><Target size={15}/></button>}
              <button data-testid="right-panel-toggle" className={"header-control icon-only panel-control "+(rightPanelOpen?"active":"")} onClick={toggleRightPanel} aria-label={panelToggleLabel[0]} title={panelToggleLabel[1]}><PanelRight size={16}/>{recordingMark}</button>
              <button className="header-control icon-only theme-toggle" data-testid="appearance-toggle" onClick={toggleAppearanceMode} aria-label={appearanceToggleLabel} title={appearanceToggleLabel}>{resolvedMode==="dark"?<Sun size={15}/>:<Moon size={15}/>}</button>
              <button className="header-control icon-only palette-control" onClick={()=>setPaletteOpen(true)} aria-label="Command palette" title={withKey("Command palette",sidebarShortcuts.commandPalette)}><Command size={15}/></button>
              {/* Shown from the fit level that sets the theme and palette buttons aside (data-fit 4): the folded actions in the row's
                  order, then those two. */}
              <HeaderOverflowMenu items={[
                gitInfo?.isGit&&projectControlsShown&&{id:"source",fold:"source",Icon:GitBranch,label:"Source control",detail:gitInfo.branch||"detached",onSelect:()=>openRightPanel("source")},
                headerOpenInShown&&projectControlsShown&&{id:"open-in",fold:"open-in",render:close=><OpenInControl openIn={headerOpenIn} onOpen={()=>{close();openProjectFromMenu()}}/>},
                headerScript&&projectControlsShown&&{id:"script",fold:"script",Icon:Play,label:headerScript.name,detail:headerRunning?"Running":undefined,title:headerRunning?headerScript.name+" is running · Show its terminal":headerScript.command,onSelect:runHeaderScript},
                // The row folds its Stop with the action button, so the menu holds it too while the action runs.
                headerScript&&projectControlsShown&&headerRunning&&{id:"script-stop",fold:"script",Icon:CircleStop,label:"Stop "+headerScript.name,onSelect:()=>runUserAction(stopHeaderScript,"Could not stop the project action")},
                activeThread?.id&&!openingShown&&gitInfo?.isGit&&{id:"review",fold:"review",Icon:ShieldCheck,label:"Review",title:reviewHint,disabled:running,onSelect:reviewFromHeader},
                {id:"terminal",fold:"terminal",Icon:PanelBottom,label:"Terminal",pressed:panel==="terminal",onSelect:toggleTerminalPanel},
                activeThread?.id&&!openingShown&&{id:"goal",fold:"goal",Icon:Target,label:"Thread goal",title:goal?.objective||"Set thread goal",pressed:rightPanelOpen&&rightPanelTab==="goal",onSelect:()=>openRightPanel("goal")},
                {id:"appearance",twin:"theme-toggle",Icon:resolvedMode==="dark"?Sun:Moon,label:appearanceToggleLabel,onSelect:toggleAppearanceMode},
                {id:"palette",twin:"palette-control",Icon:Command,label:"Command palette",hint:shortcutHint(sidebarShortcuts.commandPalette),onSelect:()=>setPaletteOpen(true)},
              ]}/>
            </div>
          </header>

          <ThreadFindBar state={threadFind} covered={openingShown} inputRef={threadFindInputRef} barRef={threadFindBarRef} onQuery={query=>setThreadFind(current=>({...current,query,error:""}))} onPrevious={()=>stepThreadFind(-1)} onNext={()=>stepThreadFind(1)} onClose={closeThreadFind}/>

          {!openingOverPage&&<div className={"conversation-scroll"+(openingShown?" opening-covered":"")} ref={conversationScrollRef} onScroll={conversationScrolled}>
            <div className={"conversation-column"+(agentBlockShown?" with-agent-block":"")}>
              {worktreeSetup&&<LazySlot><WorktreeSetupCard setup={worktreeSetup} onOpenTerminal={()=>{setPanel("terminal");askTerminalKeyboard();if(worktreeSetup?.sessionId)setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:worktreeSetup.sessionId})),0)}} onDismiss={()=>setWorktreeSetup(null)}/></LazySlot>}
              <Conversation messages={messages} harnessLabel={runtimeKnown?agentRuntimeLabel:""} turnInfo={turnInfo} onEditFromHere={conversationEditFromHere} onCite={conversationCite} allowRevert={Boolean(runtimeCapabilities.rewind)} projectPath={projectPath} environmentId={workspaceEnvironmentId} threadId={activeThread?.id||null} canLoadEarlier={historyPage.threadId===activeThread?.id&&Boolean(historyDetached?historyDetached.cursor:historyPage.nextCursor)} loadingEarlier={historyPage.loading==="top"} onLoadEarlier={conversationLoadEarlier} historyGap={conversationHistoryGap} loadingGap={historyPage.loading==="gap"} onLoadGap={conversationLoadGap} historyBusy={Boolean(historyPage.loading)} historyError={historyPage.error} activeFindItemId={threadFind.activeItemId} anchorItemId={historyAnchorItemId} scrollContainerRef={conversationScrollRef} cardTurnId={cardTurnId} cardFailedTurns={cardFailedTurnIds(events).join("\n")} turnOrder={shownTurnOrder} turnActivity={shownTurnActivity} liveCardTurnId={liveCardTurnId} newestTurnId={newestTurnId} onToggleLayout={activityCardToggleLayout}/>
              <ActivityTimeline ref={activityTimelineRef} events={events} threadId={activeThread?.id||null} turnId={cardTurnId} initialAssistantText={assistantTextRef.current} initialCommandOutputs={commandOutputRef.current} initialMcpProgress={mcpProgressRef.current} onOpenPanel={activityOpenPanel} canInspectChanges={!projectlessMode&&Boolean(gitInfo?.isGit)} onToggleLayout={activityCardToggleLayout} onShown={setAgentBlockShown}/>
              {guardianDenials.map(review=><LazySlot key={review.reviewId}><div className="inline-approval"><GuardianDenialCard review={review} busy={guardianBusy===String(review.reviewId)} onApprove={approveGuardianDenial} onDismiss={dismissGuardianDenial}/></div></LazySlot>)}
              {shownApproval&&<div className="inline-approval"><ApprovalCard key={shownApproval?.id??"none"} request={shownApproval} threadLabel={shownApprovalThreadLabel} onResolve={(request,decision)=>runUserAction(()=>resolveApproval(request,decision),"Could not answer approval request")}/></div>}
              {/* A follow-up's button runs once for a double click or Enter held on it, as a thread's menu item does: the rest of the press
                  does nothing, so the second click never lands on the next follow-up's button, which comes up in its place once the first
                  takes this one out or moves it. A follow-up on its way reads as being sent, its buttons off (queuedOnItsWay). Its buttons
                  pressed from the keyboard keep the keyboard (pressQueued): Edit in the composer, the others in the queue. */}
              {queued.map((item,index)=>{const sending=!item.native&&Boolean(item.dispatchingAt),sendingTitle=sending?"This follow-up is already being sent":undefined;return <div className={"queued-message"+(queuedEditId===item.id?" editing":"")} key={item.id}><span title={sending?"This follow-up is being sent: it leaves the queue once it has gone, and stays here if it cannot be sent.":queueHeld&&!item.native&&!item.autoStartFailed?"A Stop holds the queue: it goes on once this thread runs a turn again. Send now sends this follow-up now.":undefined}>{item.native?`Queued in ${agentRuntimeLabel}`:sending?"Sending…":item.autoStartFailed?"Queued · retry needed":queueHeld?"Queued · held after Stop":"Queued"}{queuedEditId===item.id?" · editing"+(queueEditDraft?" · your draft returns after":""):""}</span><p>{item.text}</p><div className="queued-message-actions" onClick={event=>{if(event.target.closest("button"))ignorePressRest(!event.detail)}}><button disabled={sending||(running&&!runtimeCapabilities.steering)||queuedEditId===item.id} title={sendingTitle||(queuedEditId===item.id?"Save the edit with Enter, or press Escape, before sending it":running&&!runtimeCapabilities.steering?cannotSteerReason:undefined)} onClick={event=>pressQueued(event,item,index,0,()=>sendQueuedNow(item),"Could not send queued follow-up")}>Send now</button><button onClick={event=>pressQueued(event,item,index,1,()=>editQueued(item),"Could not edit queued follow-up")} disabled={sending||Boolean(queuedEditId)||item.editable===false} title={sendingTitle||(queuedEditId&&queuedEditId!==item.id?"Save the follow-up you are editing, or press Escape, first":undefined)}>{queuedEditId===item.id?"Editing…":"Edit"}</button><button aria-label="Move queued follow-up up" title="Move up" disabled={sending||index===0} onClick={event=>pressQueued(event,item,index,2,()=>moveQueued(item,-1),"Could not reorder queued follow-up")}>↑</button><button aria-label="Move queued follow-up down" title="Move down" disabled={sending||index===queued.length-1} onClick={event=>pressQueued(event,item,index,3,()=>moveQueued(item,1),"Could not reorder queued follow-up")}>↓</button><button disabled={sending} title={sendingTitle} onClick={event=>pressQueued(event,item,index,4,()=>removeQueued(item),"Could not remove queued follow-up")}>Remove</button></div></div>})}
              {!messages.length&&!events.length&&!storeCardTurnIds(shownTurnActivity).length&&!guardianDenials.length&&!approvals.length&&!queued.length&&!worktreeSetup&&<div className="welcome">
                <div className="welcome-mark"><img src="/trebell-code-icon.svg" alt="" aria-hidden="true"/></div>
                <h1>{projectlessMode?"What do you want to think through?":"What do you want to build?"}</h1>
                <p>{projectlessMode?"This is a General chat with no attached project. Files and terminal commands stay inside a Trebell-managed scratch workspace.":<>{!runtimeKnown?"":managedInference?`${providerLabel} supplies inference to ${agentRuntimeLabel}. `:`${agentRuntimeLabel} is the active coding-agent harness. `}Trebell keeps files, terminal, Git, worktrees, previews and project actions in one workspace.</>}</p>
                <div className="suggestions">{projectlessMode?<><button onClick={()=>suggestPrompt("Help me plan the architecture for this idea before I choose a repository.")}>Plan an idea</button><button onClick={()=>suggestPrompt("Research this technical question and give me a practical recommendation: ")}>Research a topic</button><button onClick={()=>suggestPrompt("Turn this rough idea into a clear technical specification: ")}>Draft a spec</button></>:<><button onClick={()=>suggestPrompt("Inspect this project and explain the architecture.")}>Explain codebase</button><button onClick={()=>suggestPrompt("Find a useful bug, fix it, and run the relevant tests.")}>Fix a bug</button><button onClick={()=>suggestPrompt("Implement the next missing feature and validate it end-to-end.")}>Ship a feature</button></>}</div>
              </div>}
            </div>
          </div>}
          {openingShown&&<div className="thread-opening" role="status" aria-live="polite" data-testid="thread-opening"><div className="thread-opening-body"><strong>{activeTitle}</strong><span><i className="thread-opening-spinner" aria-hidden="true"/>Opening thread…</span></div></div>}
          {/* Only a running clone shows its progress: one stopping says so, and one stopped or failed says how it ended, not the percentage it stopped at. */}

          {cloneBannerShown&&<div className={"clone-banner "+currentProject.cloneJob.status} data-testid="clone-banner"><div><strong>{currentProject.cloneJob.phase||"Cloning repository"}</strong><span>{currentProject.cloneJob.status==="failed"?(currentProject.cloneJob.error||"Clone failed"):currentProject.cloneJob.status==="cancelled"?"Clone cancelled":currentProject.cloneJob.status==="cancelling"?"Stopping the clone…":"You can keep writing. Send waits until the repository is ready."}</span>{cloneRefreshError&&<span className="clone-refresh-error" role="alert">{cloneRefreshError}</span>}</div>{currentProject.cloneJob.status==="running"&&<i><b style={{width:Math.max(2,Number(currentProject.cloneJob.progress)||0)+"%"}}/></i>}<em>{currentProject.cloneJob.status==="running"?Math.round(currentProject.cloneJob.progress||0)+"%":""}</em>{currentProject.cloneJob.status==="running"&&<button onClick={()=>runUserAction(()=>cloneProjectAction("cancel"),"Could not cancel clone")}><X size={11}/> Cancel</button>}{["failed","cancelled"].includes(currentProject.cloneJob.status)&&<button onClick={()=>runUserAction(()=>cloneProjectAction("retry"),"Could not retry clone")}>Retry clone</button>}</div>}
  <Composer starting={!runtimeKnown} prompt={prompt} setPrompt={setPrompt} onPromptEdit={composerPromptEdit} alert={composerAlert} historyIndex={promptHistoryIndex} onSend={composerSend} onBackgroundSend={composerBackgroundSend} canBackground={Boolean(runtimeCapabilities.detachedTasks)&&!headerThread?.id&&!running&&!submitting&&!bootstrap.mock&&rpcStatus==="connected"} running={running} submitting={submitting} openingThread={Boolean(opening)} providerReady={providerReady} transportReady={Boolean(bootstrap.mock)||rpcStatus==="connected"} transportStatus={rpcStatus==="error"||rpcStatus==="connected"?rpcStatus:transportConnectedRef.current?"reconnecting":"connecting"} transportReason={transportReason} onRetryTransport={composerRetryTransport} runtimeSwitchLabel={runtimeSwitchLabel} modelsLoading={modelsLoading||!initialLoaded} provider={provider} agentRuntime={agentRuntime} agentRuntimeLabel={agentRuntimeLabel} runtimeCapabilities={runtimeCapabilities} onConfigureProvider={configureProviderKey} models={models} modelMeta={modelMeta} model={model} setModel={composerSetModel} selectedModels={selectedModels} onSelectedModels={setSelectedModels} allowMultiModel={Boolean(runtimeCapabilities.multiModelFanout)&&!headerThread?.id&&!running&&!submitting&&!bootstrap.mock&&rpcStatus==="connected"&&Boolean(gitInfo?.isGit)} modelError={modelError} attachments={attachments} uploadingFiles={uploadingFiles} contextChips={contextChips} onRemoveAttachment={composerRemoveAttachment} onRemoveContext={composerRemoveContext} onPickFiles={composerPickFiles} onCaptureScreen={composerCaptureScreen} onPaste={composerPaste} onDrop={composerDrop} onFileMentionSearch={composerFileMentionSearch} onFileMentionAttach={composerFileMentionAttach} permissionMode={permissionMode} setPermissionMode={composerSetPermissionMode} collaborationModes={collaborationModes} collaborationMode={collaborationMode} onCollaborationMode={composerCollaborationMode} collaborationModeBusy={collaborationModeBusy} threadSettingsWait={openingShown} providerCommands={providerCommands} providerAgents={providerAgents} providerAgent={providerAgent} onProviderAgent={composerProviderAgent} recipes={projectlessMode?[]:currentProject?.recipes||[]} settings={settings} tokenUsage={openingShown?null:tokenUsage} workspaceMode={workspaceMode} setWorkspaceMode={composerSetWorkspaceMode} projectless={projectlessMode} threadOpen={Boolean(headerThread?.id)} gitAvailable={Boolean(gitInfo?.isGit)} canCompact={Boolean(!openingShown&&activeThread?.id&&rpc&&rpcStatus==="connected"&&runtimeCapabilities.compaction)} onCompact={composerCompact} runtimeProfiles={openingShown?null:threadRuntimeProfiles} runtimeProfileBusy={threadRuntimeProfileBusy} onRuntimeProfile={composerRuntimeProfile} onReasoningEffort={composerReasoningEffort} onServiceTier={composerServiceTier} onModelOption={composerModelOption} onModelPickerOpenChange={setModelPickerOpen} onMenuShown={setComposerMenuShown} codexThread={agentRuntime==="codex"&&!openingShown&&activeThread?.id&&codexThreadState?.threadId===activeThread.id?codexThreadState:null} onCancelEdit={queuedEditId?composerCancelQueuedEdit:null}/>

          {/* The drawer opening asks for the keyboard its terminal takes as it comes up (terminal-keyboard.js). */}
          {panel==="terminal"&&<div className="terminal-drawer" data-testid="drawer" ref={terminalDrawerOpened}>
            <div className="layout-resizer terminal-resizer" data-testid="terminal-resizer" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" {...layoutSeparatorProps("terminal")} onPointerDown={event=>beginLayoutResize("terminal",event)}/>
            <div className="terminal-drawer-head"><span><SquareTerminal size={14}/> Terminal</span><div><button onClick={()=>setPanel(null)} aria-label="Close terminal"><X size={15}/></button></div></div>
            <DeferredSurface label="Loading terminal…" compact><TerminalPanel projectPath={projectPath} environmentId={workspaceEnvironmentId} environmentName={currentProject?.environment?.name||bootstrap.activeEnvironment?.name||"Local machine"} onAttachExcerpt={attachExcerpt}/></DeferredSurface>
          </div>}
        </div>}

        {PAGE_CRUMBS[section]&&(()=>{const [CrumbIcon,crumbLabel]=PAGE_CRUMBS[section];return <header className="workspace-header page-topbar" data-testid="page-topbar">
          <div className="workspace-breadcrumb">
            {!sidebarOpen&&<button className="project-crumb sidebar-reopen" onClick={()=>setSidebarOpen(true)} aria-label="Open sidebar" title={withKey("Open sidebar",sidebarShortcuts.sidebarToggle)}><PanelLeftOpen size={14}/></button>}
            {section==="licenses"&&<><a href="#settings" className="project-crumb page-crumb-back" onClick={event=>{event.preventDefault();navigateSection("settings")}} aria-label="Back to Settings" title="Back to Settings"><ChevronLeft size={14} aria-hidden="true"/><span>Settings</span></a><span>/</span></>}
            <span className="page-crumb"><CrumbIcon size={14} aria-hidden="true"/><strong>{crumbLabel}</strong>{section==="settings"&&settingsSectionLabel&&<><ChevronRight size={12} aria-hidden="true"/><em>{settingsSectionLabel}</em></>}</span>
          </div>
          <div className="workspace-header-actions">
            <button data-testid="right-panel-toggle" className={"header-control icon-only "+(rightPanelOpen?"active":"")} onClick={()=>{if(rightPanelOpen){setRightPanelOpen(false);setRightPanelMaximized(false)}else{setRightPanelTab(tab=>tab||"files");setRightPanelOpen(true)}}} aria-label={panelToggleLabel[0]} title={panelToggleLabel[1]}><PanelRight size={16}/>{recordingMark}</button>
            <button className="header-control icon-only theme-toggle" data-testid="appearance-toggle" onClick={toggleAppearanceMode} aria-label={appearanceToggleLabel} title={appearanceToggleLabel}>{resolvedMode==="dark"?<Sun size={15}/>:<Moon size={15}/>}</button>
            <button className="header-control icon-only" onClick={()=>setPaletteOpen(true)} aria-label="Command palette" title={withKey("Command palette",sidebarShortcuts.commandPalette)}><Command size={15}/></button>
          </div>
        </header>})()}
        {section==="projects"&&<div className="secondary-page"><div className="page-header"><div><h1>Projects</h1><p>Repositories and workspaces across local, WSL and SSH environments.</p></div></div><DeferredSurface label="Loading projects…"><ProjectsPage currentPath={projectlessMode?null:projectPath} currentEnvironmentId={workspaceEnvironmentId} onOpen={onProjectOpen} onGeneralChat={newGeneralChat} models={models} onOfferUndo={offerPageUndo} isProjectOpen={projectIsOpen} onProjectUpdated={projectsPageUpdated} onProjectRemoved={projectsPageRemoved} onRunScript={(result,run,pressed)=>showActionRun((run.environmentId||"")+"\0"+run.path+"\0"+run.scriptId,result,pressed)} onOpenPreview={previewUrl=>{openRightPanel("preview");requestPreview(previewUrl)}}/></DeferredSurface></div>}
        {section==="tools"&&runtimeCapabilities.harnessTools&&<div className="secondary-page full"><DeferredSurface label="Loading harness capabilities…"><HarnessToolsPage rpc={rpc} rpcStatus={rpcStatus} projectPath={projectPath} activeThread={activeThread} skills={skills} skillsLoad={skillsLoad} onHistoryImported={historyImported} onSkillsRefresh={refreshSkillsAfterMutation} onSkillsReload={()=>loadSkills(rpc,projectPath,true)} platform={bootstrap.platform}/></DeferredSurface></div>}
        {section==="environments"&&<div className="secondary-page full"><DeferredSurface label="Loading environments…"><EnvironmentsPage onOfferUndo={offerPageUndo}/></DeferredSurface></div>}
      {section==="usage"&&<div className="secondary-page full"><DeferredSurface label="Loading usage…"><UsagePage settings={settings} rpc={rpc} rpcStatus={rpcStatus} activeThread={activeThread} agentRuntime={agentRuntime}/></DeferredSurface></div>}
        {section==="licenses"&&<div className="secondary-page full"><div className="page-header"><div><h1>Open source licenses</h1><p>Installed third-party software, versions and license notices.</p></div></div><DeferredSurface label="Loading licenses…"><LicensesPage/></DeferredSurface></div>}
      {section==="settings"&&<div className="secondary-page full"><div className="page-header"><div><h1>Settings</h1><p>{window.trebellDesktop?"Agent harnesses, model providers, permissions and desktop behavior.":"Agent harnesses, model providers, permissions and workspace behavior."}</p></div></div><DeferredSurface label="Loading settings…"><SettingsPage entry={settingsEntry} onSectionChange={setSettingsSectionLabel} settings={settings} runtimeKnown={runtimeKnown} onSettings={settingsPageSettings} onProviderChanging={settingsProviderChanging} onProviderUpdated={settingsProviderUpdated} onAgentRuntimeSwitch={settingsAgentRuntimeSwitch} runningTasks={runningTasks} onActionError={showActionError} runtime={runtime} runtimeCapabilities={runtimeCapabilities} rpcStatus={rpcStatus} projectPath={projectlessMode?null:projectPath} runtimeEnvironmentId={workspaceEnvironmentId} onOpenRuntimeAuthTerminal={(session,pressed)=>{setSection("chat");setPanel("terminal");askTerminalKeyboard(pressed);setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:session?.id||null})),0)}} projectScripts={projectlessMode?[]:currentProject?.scripts||[]} modelError={modelError} onOpenLicenses={()=>navigateSection("licenses")} models={models} onScopedSettingsChanged={onScopedSettingsChanged} environmentThemeCatalog={environmentThemeCatalog} environmentThemes={environmentThemes} onRefreshEnvironmentThemes={refreshEnvironmentThemes} onOfferUndo={offerSettingsUndo}/></DeferredSurface></div>}
        {section==="history"&&<div className="secondary-page"><div className="page-header"><div><h1>Thread history</h1><p>Saved Trebell threads stay visible across agent runtimes. The active {agentRuntimeLabel} history is paged in 100 at a time.</p></div></div><div className="history-page">
          {threadHistory.error&&<div className="history-load-error provider-status-error" role="alert"><span key={threadHistory.failures}>{threadHistory.failures>1?"Still could not":"Could not"} load thread history: {threadHistory.error}</span><button type="button" className="tb-btn tb-btn--sm" aria-disabled={threadHistory.retrying||undefined} onClick={event=>{ignorePressRest(!event.detail);setThreadHistory(current=>current.loading?current:{...current,loading:true,retrying:true,retries:(current.retries||0)+1})}}>{threadHistory.retrying?"Retrying…":"Retry"}</button></div>}
          {threadHistory.items.length?threadHistory.items.map(t=>{const owner=threadCatalogRuntime(t,threadMeta[t.id]||{},agentRuntime)||agentRuntime;return <button className="history-thread-row" key={t.id} onClick={()=>runUserAction(()=>openThread(t),"Could not open thread")}><div><strong title={titleOf(t)}>{titleOf(t)}</strong><span title={t.preview||t.cwd||undefined}>{t.preview||t.cwd}</span></div><em className="history-runtime-chip" title={"Owned by "+agentRuntimeName(owner)}>{HISTORY_RUNTIME_LABELS[owner]||owner}</em><time dateTime={isoDateTime(t.updatedAt)} title={fullDateTime(t.updatedAt)}>{compactDateTime(t.updatedAt)}</time></button>}):!threadHistory.error&&<div className="history-empty"><History size={22}/><strong>{threadHistory.loading?"Loading thread history…":"No thread history yet"}</strong><span>{threadHistory.loading?"Fetching the newest threads from the active agent runtime.":"Start a task or General chat and it will appear here."}</span>{!threadHistory.loading&&<button onClick={()=>runUserAction(newTask,"Could not start a new thread")}>Start a new task</button>}</div>}
          {threadHistory.olderError&&!threadHistory.loadingOlder&&<div className="history-load-error provider-status-error" role="alert">Could not load older threads: {threadHistory.olderError}</div>}{(threadHistory.nextCursor||threadCatalogCursor)&&<div className="history-page-control history-load-more"><button type="button" aria-disabled={threadHistory.loadingOlder||undefined} onClick={event=>{ignorePressRest(!event.detail);loadOlderThreadHistory()}}>{threadHistory.loadingOlder?"Loading older threads…":"Load older threads"}</button></div>}
        </div></div>}
      </main>

      {rightPanelOpen&&!rightPanelMaximized&&<div className="layout-resizer right-panel-resizer" data-testid="right-panel-resizer" role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" {...layoutSeparatorProps("right")} onPointerDown={event=>beginLayoutResize("right",event)}/>}
      {rightPanelOpen&&narrowDrawer&&!rightPanelMaximized&&<div className="inspector-scrim" data-testid="inspector-scrim" aria-hidden="true" onClick={()=>{setRightPanelOpen(false);setRightPanelMaximized(false)}}/>}
      {rightPanelOpen&&<RightPanel active={rightPanelTab} disabledTabs={projectlessMode?["diff","context","source"]:[]} hiddenTabs={runtimeCapabilities.delegation?[]:["agents"]} maximized={rightPanelMaximized} onToggleMaximized={()=>setRightPanelMaximized(value=>!value)} onActive={tab=>openRightPanel(tab)} onClose={()=>{setRightPanelOpen(false);setRightPanelMaximized(false)}}><DeferredSurface label="Loading panel…" compact>{rightPanelContent()}</DeferredSurface></RightPanel>}
      {actionError&&<div className={"app-action-error-toast"+(threadUndo?" with-thread-undo":"")+(viewSection!=="chat"?" secondary-surface-error":"")} role="alert" aria-live="assertive" data-testid="app-action-error">{actionError}</div>}
    </div>

    {window.trebellDesktop?.minimize&&window.trebellDesktop?.maximize&&window.trebellDesktop?.close&&<WindowControls desktop={window.trebellDesktop}/>}
    {elicitations.length>0&&(()=>{const verification=userVerificationAvailability({runtime:agentRuntime,remote:Boolean(workspaceEnvironmentId)});return <LazySlot><McpElicitationModal key={elicitations[0]?.request?.id||"none"} request={elicitations[0]?.request} onResolve={resolveElicitation} onVerify={verifyMcpUser} verificationAvailable={verification.available} verificationUnavailableReason={verification.reason}/></LazySlot>})()}
    {!elicitations.length&&questions[0]&&<LazySlot><QuestionModal key={questions[0].id} request={questions[0]} threadLabel={requestThreadLabel(questions[0])} waiting={questions.length-1} onSubmit={answerQuestion} onCancel={cancelQuestion} pickFiles={(room,keep)=>pickFiles("",{room,keep})}/></LazySlot>}
    {snoozeRequest&&<LazySlot><SnoozeDialog request={snoozeRequest} onSubmit={submitSnooze} onCancel={()=>setSnoozeRequest(null)} focusFallback={focusShownView}/></LazySlot>}
    {threadUndo&&<div className="thread-undo-toast" role="status" aria-live="polite" data-testid="thread-undo-toast"><span>{threadUndo.label}</span><button onClick={undoThreadAction}>Undo</button><UndoCountdown key={threadUndo.id} expiresAt={threadUndo.expiresAt}/></div>}
    {paletteOpen&&<LazySlot fallback={<CommandPaletteLoading seed={paletteSeedRef} onClose={closePalette}/>}><CommandPalette open seed={paletteSeedRef} focusFallback={focusShownView} onClose={closePalette} actions={paletteActions} projects={paletteProjects} threads={threads} environmentNames={paletteEnvironmentNames} dataError={paletteDataError} onOpenProject={project=>onProjectOpen(project.path,project.environmentId||null)} onOpenThread={openThread} onSearchThreadMessages={searchThreadMessages}/></LazySlot>}
    {initialLoaded&&settings.onboardingComplete===false&&<LazySlot><OnboardingModal open projectPath={projectPath} onPickWorkspace={window.trebellDesktop?.pickDirectory?pickWorkspace:null} providerLabel={managedInference?providerLabel:agentRuntimeLabel} providerReady={providerReady} permissionMode={permissionMode} onPermissionMode={setPermissionMode} onHistoryImported={historyImported} onFinish={finishOnboarding}/></LazySlot>}
  </div>;
}
