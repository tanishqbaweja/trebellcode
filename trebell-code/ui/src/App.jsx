import React,{useEffect,useMemo,useRef,useState} from "react";
import {
  BrainCircuit, Check, ChevronDown, CircleStop, Code2, Cpu, FileCode2, FileDiff, FolderCode,
  GitBranch, Globe2, HardDrive, Link2, ListTodo, MemoryStick, Network, Paperclip, Plus, Send,
  ShieldCheck, Sparkles, SquareTerminal, WandSparkles, X, Zap, Coins, Mic, Camera,
  PanelRight, PanelBottom, Command, Target, Play
} from "lucide-react";
import { CodexRpcClient } from "./rpc.js";
import { api } from "./api.js";
import ThreadSidebar from "./components/ThreadSidebar.jsx";
import TerminalPanel from "./components/TerminalPanel.jsx";
import WorkspacePanel from "./components/WorkspacePanel.jsx";
import SourceControlPanel from "./components/SourceControlPanel.jsx";
import QuestionModal from "./components/QuestionModal.jsx";
import ProjectsPage from "./components/ProjectsPage.jsx";
import AgentsPage from "./components/AgentsPage.jsx";
import PreviewPage from "./components/PreviewPage.jsx";
import SettingsPage from "./components/SettingsPage.jsx";
import FreebuffPage from "./components/FreebuffPage.jsx";
import RightPanel from "./components/RightPanel.jsx";
import HarnessToolsPage from "./components/HarnessToolsPage.jsx";
import EnvironmentsPage from "./components/EnvironmentsPage.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import GoalPanel from "./components/GoalPanel.jsx";
import OnboardingModal from "./components/OnboardingModal.jsx";
import OpenInPicker from "./components/OpenInPicker.jsx";
import WorktreeSetupCard from "./components/WorktreeSetupCard.jsx";
import DevicePanel from "./components/DevicePanel.jsx";
import UsagePage from "./components/UsagePage.jsx";
import LicensesPage from "./components/LicensesPage.jsx";
import { resolveKeybinding } from "./keybindings.js";
import { isVideoAttachment, restoreQueuedDraft } from "./composer-state.js";

const MAX_COMPOSER_ATTACHMENTS=100;
const MAX_COMPOSER_CHARS=120_000;

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

function titleOf(thread){return thread?.name||thread?.preview||"New Trebell task"}
function modelLabel(id,freebuff){
  const clean=String(id||"").replace(/^freebuff\//,"");
  const p=freebuff?.derived?.priceByModel?.[id]||(freebuff?.derived?.selectedModel===id?freebuff?.derived?.selectedPrice:null);
  if(p?.dynamic)return clean+" · dynamic";
  if(typeof p?.current==="number")return clean+" · "+p.current+" FB/h"+(p.offPeakActive?" off-peak":"");
  return clean;
}
function messageText(item){
  if(typeof item?.text==="string")return item.text;
  if(Array.isArray(item?.content))return item.content.map(x=>x?.text||x?.input_text||"").join("");
  return "";
}
function historyFromThread(thread,checkpointByTurn={}){
  const out=[];
  for(const turn of thread?.turns||[]){
    for(const item of turn.items||[]){
      if(item?.type==="userMessage"){
        const text=messageText(item).trim();
        if(text)out.push({id:item.id,role:"user",text,turnId:turn.id,checkpointId:checkpointByTurn[turn.id]?.id||null});
      }else if(item?.type==="agentMessage"&&item.text?.trim()){
        out.push({id:item.id,role:"assistant",text:item.text,turnId:turn.id});
      }
    }
  }
  return out;
}
function normalizeItem(item={}){
  const type=item.type||"tool";
  let title=item.title||item.name||item.description||"Agent activity";
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
function Conversation({messages,onEditFromHere,onCite,allowRevert=true}){
  return <div className="conversation-history">{messages.map(m=>m.role==="user"?<div className="user-row" key={m.id}><div className="user-bubble"><p>{m.text}</p>{allowRevert&&m.turnId&&<button className="message-action" onClick={()=>onEditFromHere(m)}>Edit from here</button>}</div></div>:<div className="history-assistant" key={m.id}><div className="agent-star small"><Sparkles size={12}/></div><div><div className="assistant-message-text">{m.text}</div><button className="message-action" onClick={()=>onCite?.(m)}>Cite response</button></div></div>)}</div>;
}
function ApprovalCard({request,onResolve}){
  if(!request)return null;
  const p=request.params||{};
  return <div className="approval-card"><div className="card-title"><ShieldCheck size={16}/><strong>Approval required</strong></div><p>{p.reason||p.command||p.path||request.method}</p><div className="approval-actions"><button onClick={()=>onResolve(request,"decline")}>Deny</button><button onClick={()=>onResolve(request,"acceptForSession")}>Allow session</button><button className="approve" onClick={()=>onResolve(request,"accept")}>Allow once</button></div></div>;
}
function FreebuffMini({freebuff,model,onOpen}){
  const balance=freebuff?.derived?.balance;
  const p=freebuff?.derived?.priceByModel?.[model]||freebuff?.derived?.selectedPrice;
  return <button className="freebuff-card" data-testid="freebuff-card" onClick={onOpen}><div className="freebuff-card-head"><span><Coins size={16}/> Freebucks</span><b>{balance??"—"}</b></div><div className="freebuff-mini-grid"><div><small>Model</small><strong>{model?.replace(/^freebuff\//,"").split("/").at(-1)||"—"}</strong></div><div><small>Price</small><strong>{p?.current!=null?p.current+" FB/h":"—"}</strong></div><div><small>Session</small><strong>{freebuff?.derived?.sessionStatus||"none"}</strong></div><div><small>Streak</small><strong>{freebuff?.streak?.streak??"—"}d</strong></div></div></button>;
}

const SLASH_COMMANDS=[
  ["/compact","Compact conversation context"],
  ["/plan","Create a plan, then execute it"],
  ["/model","Open model provider settings"],
  ["/terminal","Open persistent terminal"],
  ["/diff","Open workspace changes"],
  ["/git","Open source control"],
  ["/preview","Open browser preview"],
  ["/agents","Open delegated agents"],
  ["/review","Review uncommitted workspace changes"],
  ["/goal","Open the durable thread goal"],
  ["/palette","Open the command palette"],
  ["/new","Start a new thread"],
  ["/clear","Reset the current draft/thread view"],
];

function Composer({prompt,setPrompt,onPromptEdit,historyIndex=-1,onSend,running,providerReady,provider,agentRuntime="codex",agentRuntimeLabel="Codex",login,onConfigureProvider,models,modelMeta,model,setModel,modelError,freebuff,attachments,contextChips,onRemoveAttachment,onRemoveContext,onPickFiles,onCaptureScreen,onPaste,onDrop,permissionMode,setPermissionMode,webSearch,setWebSearch,skills,providerCommands=[],providerAgents=[],providerAgent="",onProviderAgent,onSkill,onFiles,settings,onStash,tokenUsage,workspaceMode,setWorkspaceMode}){
  const [skillsOpen,setSkillsOpen]=useState(false);
  const [listening,setListening]=useState(false);
  const speechSupported=typeof window!=="undefined"&&Boolean(window.SpeechRecognition||window.webkitSpeechRecognition);
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
  function keyDown(e){
    if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();onSend();return}
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
  const slashItems=slashOpen?allSlash.filter(([cmd])=>cmd.startsWith(slashQuery.split(/\s/)[0])&&(["codex","opencode","claude"].includes(agentRuntime)||cmd!=="/compact")&&(agentRuntime==="codex"||cmd!=="/agents")):[];
  const contextPaths=new Set((contextChips||[]).map(chip=>chip.path));
  const promptTooLong=prompt.length>MAX_COMPOSER_CHARS;
  return <div className="composer-wrap" onDragOver={e=>e.preventDefault()} onDrop={onDrop}>
    {slashOpen&&slashItems.length>0&&<div className="slash-menu">{slashItems.map(([cmd,desc])=><button key={cmd} onMouseDown={e=>{e.preventDefault();setPrompt(cmd+" ")}}><strong>{cmd}</strong><span>{desc}</span></button>)}</div>}
    {(contextChips||[]).length>0&&<div className="context-chip-row" data-testid="context-chips">{contextChips.map(chip=><span className={"context-chip kind-"+(chip.kind||"context")} data-testid="context-chip" key={chip.id||chip.path} title={chip.path}><Link2 size={11}/><strong>{chip.label||"Context"}</strong>{chip.detail&&<small>{chip.detail}</small>}<button onClick={()=>onRemoveContext(chip.path)} title="Remove context"><X size={10}/></button></span>)}</div>}
    <div className="attachment-shelf">{attachments.filter(path=>!contextPaths.has(path)).map(path=><span key={path}><Paperclip size={11}/>{String(path).split(/[\\/]/).pop()}<button onClick={()=>onRemoveAttachment(path)}><X size={10}/></button></span>)}</div>
    <textarea data-testid="composer" value={prompt} onChange={e=>{onPromptEdit?.();setPrompt(e.target.value)}} onKeyDown={keyDown} onPaste={onPaste} placeholder={providerReady?(running?(agentRuntime==="codex"&&settings.followUpMode==="steer"?"Steer the running agent…":"Queue a follow-up…"):"Ask Trebell Code anything…"):(agentRuntime!=="codex"?`Configure ${agentRuntimeLabel} in Settings…`:provider==="freebuff"?"Sign in to Freebuff to start…":"Configure the selected provider in Settings…")} disabled={!providerReady}/>
    <div className="composer-bar"><div className="composer-left">
      <button className="circle-btn" onClick={onPickFiles}><Plus size={18}/></button>
      {agentRuntime==="codex"&&<button className={"pill-btn "+(webSearch?"active":"")} onClick={()=>setWebSearch(!webSearch)}><Globe2 size={14}/> Web</button>}
      <button className="pill-btn" onClick={onFiles}><FileCode2 size={14}/> Files</button>
      {window.trebellDesktop?.captureScreen&&<button className="circle-btn" onClick={onCaptureScreen} title="Capture desktop screenshot" aria-label="Capture desktop screenshot"><Camera size={15}/></button>}
      {(agentRuntime==="codex"||skills.length>0)&&<div className="popover-wrap"><button className="pill-btn" onClick={()=>setSkillsOpen(!skillsOpen)}><WandSparkles size={14}/> Skills</button>{skillsOpen&&<div className="mini-popover">{skills.length?skills.map(s=><button key={s.path||s.location||s.name} onClick={()=>{onSkill(s);setSkillsOpen(false)}}><strong>{agentRuntime==="codex"?"$":"/"}{s.name}</strong><span>{s.description}</span></button>):<p>No enabled skills found.</p>}</div>}</div>}
      <select className="permission-picker" value={permissionMode} onChange={e=>setPermissionMode(e.target.value)}><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select>
      <select className="workspace-mode" value={workspaceMode} onChange={e=>setWorkspaceMode(e.target.value)}><option value="current">Current workspace</option><option value="worktree">New worktree</option></select>
    </div><div className="composer-right">
      {!providerReady?<button className="login-btn" onClick={agentRuntime==="codex"&&provider==="freebuff"?login:onConfigureProvider}>{agentRuntime!=="codex"?"Configure "+agentRuntimeLabel:provider==="freebuff"?"Sign in to Freebuff":"Configure "+({agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||"provider")}</button>:<>
        {agentRuntime!=="codex"&&providerAgents.length>0&&<select className="agent-picker" value={providerAgent||""} onChange={e=>onProviderAgent?.(e.target.value)} title="Provider agent"><option value="">Default agent</option>{providerAgents.map(agent=>{const name=typeof agent==="string"?agent:agent.name;const mode=typeof agent==="string"?"":agent.mode;return <option key={name} value={name}>{name}{mode?` · ${mode}`:""}</option>})}</select>}
        <select data-testid="model-picker" value={model} disabled={!models.length} onChange={e=>setModel(e.target.value)}>{models.length?models.map(id=><option key={id} value={id}>{modelMeta?.[id]?.name||modelLabel(id,freebuff)}{modelMeta?.[id]?.custom?" · custom":modelMeta?.[id]?.agent?" · "+modelMeta[id].agent:""}</option>):<option value="">{modelError?"Provider error":"No models available"}</option>}</select>
      </>}
      <button className={"mic-btn "+(listening?"active":"")} onClick={dictate} disabled={!speechSupported} title={speechSupported?(listening?"Listening…":"Voice dictation"):"Voice dictation is unavailable on this platform"}><Mic size={15}/></button>
      <button className="stash-btn" onClick={onStash} title="Stash or restore prompt">S</button>
      <button data-testid="send" className="send-btn" onClick={onSend} disabled={!providerReady||!prompt.trim()||promptTooLong}>{running&&settings.followUpMode==="queue"?<Plus size={16}/>:<Send size={16}/>}</button>
    </div></div>
    <div className={"composer-status"+(modelError||promptTooLong?" error":"")}><span>{promptTooLong?`Draft is ${prompt.length.toLocaleString()} characters · maximum ${MAX_COMPOSER_CHARS.toLocaleString()}`:modelError||tokenLabel(tokenUsage,priceConfig)}</span><span>{prompt.length.toLocaleString()}/{MAX_COMPOSER_CHARS.toLocaleString()} · {settings.followUpMode==="steer"?"Steer":"Queue"} follow-ups</span></div>
  </div>;
}

export default function App(){
  const [bootstrap,setBootstrap]=useState({mock:false,loggedIn:false,wsUrl:null,cwd:"",platform:""});
  const [rpc,setRpc]=useState(null); const [rpcStatus,setRpcStatus]=useState("disconnected");
  const [threads,setThreads]=useState([]); const [sections,setSections]=useState({}); const [threadMeta,setThreadMeta]=useState({});
  const [activeThread,setActiveThread]=useState(null); const [activeTurnId,setActiveTurnId]=useState(null);
  const [messages,setMessages]=useState([]); const [events,setEvents]=useState([]); const [assistantText,setAssistantText]=useState("");
  const [running,setRunning]=useState(false); const [queued,setQueued]=useState([]);
  const [query,setQuery]=useState(""); const [searchResults,setSearchResults]=useState(null); const [section,setSection]=useState("chat");
  const [prompt,setPrompt]=useState(""); const [promptHistoryIndex,setPromptHistoryIndex]=useState(-1); const [attachments,setAttachments]=useState([]); const [contextChips,setContextChips]=useState([]);
  const [models,setModels]=useState([]); const [modelMeta,setModelMeta]=useState({}); const [model,setModel]=useState(""); const [modelError,setModelError]=useState("");
  const [freebuff,setFreebuff]=useState({loggedIn:false}); const [skills,setSkills]=useState([]); const [providerCommands,setProviderCommands]=useState([]); const [providerAgents,setProviderAgents]=useState([]); const [providerAgent,setProviderAgent]=useState("");
  const [settings,setSettings]=useState({followUpMode:"queue",defaultPermissionMode:"supervised",appearance:"dark",appearanceMode:"system",keyboardShortcuts:{},agentRuntime:"codex",modelProvider:"freebuff"});
  const [permissionMode,setPermissionMode]=useState("supervised"); const [webSearch,setWebSearch]=useState(true); const [workspaceMode,setWorkspaceMode]=useState("current");
  const [projectPath,setProjectPath]=useState(""); const [currentProject,setCurrentProject]=useState(null); const [gitInfo,setGitInfo]=useState(null); const [stats,setStats]=useState({}); const [runtime,setRuntime]=useState({});
  const [approvals,setApprovals]=useState([]); const [question,setQuestion]=useState(null); const [tokenUsage,setTokenUsage]=useState(null);
  const [panel,setPanel]=useState(null); const [rightPanelOpen,setRightPanelOpen]=useState(false); const [rightPanelTab,setRightPanelTab]=useState("files"); const [reviewedFiles,setReviewedFiles]=useState([]); const [checkpointByTurn,setCheckpointByTurn]=useState({});
  const [selectedThreadIds,setSelectedThreadIds]=useState(new Set()); const [providerRevision,setProviderRevision]=useState(0);
  const [goal,setGoal]=useState(null); const [linkedPullRequests,setLinkedPullRequests]=useState([]);
  const [worktreeSetup,setWorktreeSetup]=useState(null);
  const [threadTelemetry,setThreadTelemetry]=useState({});
  const [paletteOpen,setPaletteOpen]=useState(false); const [initialLoaded,setInitialLoaded]=useState(false);
  const rpcRef=useRef(null); const activeThreadRef=useRef(null); const modelRefreshSeqRef=useRef(0); const timezone=useMemo(()=>Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",[]);
  const displayThreads=searchResults||threads;
  function desktopNotify(title,body){
    if(settings.notifications===false)return;
    window.trebellDesktop?.notify?.({title,body,silent:!settings.notificationSound});
  }

  useEffect(()=>{
    const root=document.documentElement;const media=window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply=()=>{
      const requested=["system","light","dark"].includes(settings.appearanceMode)?settings.appearanceMode:"system";
      const resolved=requested==="system"?(media?.matches===false?"light":"dark"):requested;
      root.dataset.theme=settings.appearance||"dark";root.dataset.mode=resolved;root.style.colorScheme=resolved;
    };
    apply();media?.addEventListener?.("change",apply);return()=>media?.removeEventListener?.("change",apply);
  },[settings.appearance,settings.appearanceMode]);
  useEffect(()=>{activeThreadRef.current=activeThread},[activeThread]);

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
  const providerReady=bootstrap.mock||(agentRuntime==="codex"?(provider==="freebuff"?Boolean(bootstrap.loggedIn):Boolean(bootstrap.providerReady)):Boolean(bootstrap.agentRuntimeReady));
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
    setModels(ids);setModel(next);
    if(resetThread){setActiveThread(null);setActiveTurnId(null);setMessages([]);setEvents([]);setAssistantText("");setQueued([])}
    if(targetRuntime==="codex"&&targetProvider==="freebuff"&&next){
      const params=new URLSearchParams({timezone,model:next});
      api("/api/freebuff/overview?"+params).then(data=>{if(seq===modelRefreshSeqRef.current&&data)setFreebuff(data)}).catch(()=>{});
    }
    return d;
  }
  async function touchProject(path){
    if(!path)return null;
    setProjectPath(path);
    const response=await api("/api/projects",{method:"POST",body:{path}}).catch(()=>null);
    const project=response?.project||null;
    setCurrentProject(project);
    if(project?.defaultModel&&models.includes(project.defaultModel))setModel(project.defaultModel)
    if(project?.permissionMode)setPermissionMode(project.permissionMode);
    if(project?.workspaceMode)setWorkspaceMode(project.workspaceMode);
    if(settings.autoPull)api("/api/git/action",{method:"POST",body:{action:"auto-pull",cwd:path}}).catch(()=>{});
    return project;
  }

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      const [boot,state,modelData]=await Promise.all([api("/api/bootstrap").catch(()=>({mock:true,loggedIn:true,cwd:"",platform:""})),api("/api/state").catch(()=>({settings:{},projects:[],threadMeta:{}})),api("/api/models").catch(error=>({models:[],error:error.message}))]);
      if(cancelled)return; setBootstrap(boot); setSettings(prev=>({...prev,...(state.settings||{})})); setPermissionMode(state.settings?.defaultPermissionMode||"supervised"); setThreadMeta(state.threadMeta||{});
      const firstProject=state.projects?.[0]||null;
      const environmentCwd=boot.activeEnvironment?.cwd||"";
      const initialPath=environmentCwd||firstProject?.path||boot.cwd||"";
      const initialProject=(state.projects||[]).find(project=>String(project.path)===String(initialPath))||firstProject;
      setCurrentProject(initialProject);
      setProjectPath(initialPath);
      const availableModels=modelData.models||[];
      setModelError(modelData.error||"");
      setModelMeta(Object.fromEntries((modelData.metadata?.models||[]).map(item=>[item.id,item]))); const fallback=availableModels.length?availableModels:(boot.mock?["freebuff/deepseek/deepseek-v4-flash","freebuff/test/coding-large","freebuff/test/coding-fast"]:[]);
      const initialModel=(initialProject?.defaultModel&&fallback.includes(initialProject.defaultModel))?initialProject.defaultModel:(fallback[0]||"");
      setModels(fallback); setModel(initialModel);
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
  async function loadThreads(client,providerId=provider){
    const listed=await client.request("thread/list",{limit:100,modelProviders:[providerId],sortKey:"updated_at",sortDirection:"desc"}).catch(()=>({data:[]})); setThreads(listed.data||[]); return listed.data||[];
  }
  async function loadSkills(client,path=projectPath){
    if(agentRuntime!=="codex")return;
    if(!path)return; const result=await client.request("skills/list",{cwds:[path]}).catch(()=>({data:[]})); setSkills((result.data||[]).flatMap(x=>x.skills||[]).filter(s=>s.enabled!==false));
  }
  async function recoverCodexAfterRestart(client){
    if(agentRuntime!=="codex")return;
    const recovery=await api("/api/recovery").catch(()=>null);if(!recovery?.enabled||!recovery.items?.length)return;
    for(const item of recovery.items){
      try{
        const resumed=await client.request("thread/resume",{threadId:item.threadId,modelProvider:provider,excludeTurns:false});
        const previous=(resumed?.thread?.turns||[]).find(turn=>turn.id===item.turnId);
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
      try{await client.connect();if(disposed)return;await recoverCodexAfterRestart(client);await ensureSections(client);await loadThreads(client);await loadSkills(client,projectPath)}
      catch(error){client.close();if(disposed)return;if(attempt<120){setRpcStatus("connecting");retryTimer=setTimeout(()=>connect(attempt+1),500)}else setRpcStatus("error")}
    };
    connect(); return()=>{disposed=true;clearTimeout(retryTimer);client?.close()};
  },[bootstrap.wsUrl,bootstrap.mock,provider,agentRuntime,providerRevision]);
  useEffect(()=>{if(rpcStatus==="connected"&&rpc)loadSkills(rpc,projectPath)},[projectPath,rpcStatus]);

  useEffect(()=>{const timer=setInterval(async()=>{const [s,r,g]=await Promise.all([api("/api/stats").catch(()=>null),api("/api/runtime").catch(()=>null),projectPath?api("/api/git/info?path="+encodeURIComponent(projectPath)).catch(()=>null):Promise.resolve(null)]);if(s)setStats(s);if(r)setRuntime(r);if(g)setGitInfo(g)},1800);return()=>clearInterval(timer)},[projectPath]);
  useEffect(()=>{if(agentRuntime!=="codex"||provider!=="freebuff"||!(bootstrap.loggedIn||bootstrap.mock))return;refreshFreebuff(model);const timer=setInterval(()=>refreshFreebuff(model),15000);return()=>clearInterval(timer)},[agentRuntime,provider,bootstrap.loggedIn,bootstrap.mock,model,timezone]);
  useEffect(()=>{if(agentRuntime!=="codex"||provider!=="freebuff"||!running||!(bootstrap.loggedIn||bootstrap.mock))return;const ping=()=>{const p=new URLSearchParams({timezone});if(model)p.set("model",model);fetch("/api/freebuff/heartbeat?"+p,{method:"POST"}).catch(()=>{})};ping();const timer=setInterval(ping,45000);return()=>clearInterval(timer)},[agentRuntime,provider,running,bootstrap.loggedIn,bootstrap.mock,model,timezone]);

  useEffect(()=>{const timer=setInterval(async()=>{if(!rpc||rpcStatus!=="connected")return;const now=Date.now();for(const thread of threads){const meta=threadMeta[thread.id];if(thread.section?.name==="Snoozed"&&meta?.snoozedUntil&&meta.snoozedUntil<=now){await moveThread(thread,"active");await updateThreadMeta(thread.id,{snoozedUntil:null})}}},30000);return()=>clearInterval(timer)},[rpc,rpcStatus,threads,threadMeta,sections]);

  useEffect(()=>{
    if(!query.trim()){setSearchResults(null);return} const q=query.toLowerCase(); const titleMatches=threads.filter(t=>titleOf(t).toLowerCase().includes(q)||(t.cwd||"").toLowerCase().includes(q));
    if(!rpc||rpcStatus!=="connected"||query.length<2){setSearchResults(titleMatches);return}
    let cancelled=false; const timer=setTimeout(async()=>{const found=new Map(titleMatches.map(t=>[t.id,t]));const rest=threads.filter(t=>!found.has(t.id)).slice(0,35);await Promise.all(rest.map(async t=>{const items=await rpc.request("thread/items/list",{threadId:t.id,limit:150,sortDirection:"desc"}).catch(()=>({data:[]}));if((items.data||[]).some(entry=>messageText(entry.item).toLowerCase().includes(q)))found.set(t.id,t)}));if(!cancelled)setSearchResults([...found.values()])},250);return()=>{cancelled=true;clearTimeout(timer)}
  },[query,threads,rpc,rpcStatus]);

  useEffect(()=>{const onHistory=event=>{const sent=messages.filter(m=>m.role==="user").map(m=>m.text);if(!sent.length)return;let next=promptHistoryIndex;if(event.detail<0)next=Math.min(sent.length-1,next+1);else next=Math.max(-1,next-1);setPromptHistoryIndex(next);setPrompt(next<0?"":sent[sent.length-1-next])};window.addEventListener("trebell:history",onHistory);return()=>window.removeEventListener("trebell:history",onHistory)},[messages,promptHistoryIndex]);
  useEffect(()=>{
    const key=event=>{
      const active=document.activeElement;
      const context={
        chatFocus:section==="chat"||section==="new",
        terminalFocus:Boolean(panel==="terminal"&&active?.closest?.(".terminal-drawer")),
        previewFocus:section==="preview",
        textInputFocus:Boolean(active&&["INPUT","TEXTAREA","SELECT"].includes(active.tagName)),
        projectOpen:Boolean(projectPath),
        threadOpen:Boolean(activeThread?.id),
        running:Boolean(running),
        modalOpen:Boolean(paletteOpen||question||approvals.length||settings.onboardingComplete===false),
        rightPanelOpen:Boolean(rightPanelOpen),
        desktop:Boolean(window.trebellDesktop),
      };
      const command=resolveKeybinding(event,settings,context);
      if(!command)return;
      event.preventDefault();
      if(command==="newChat")newChat();
      else if(command==="commandPalette")setPaletteOpen(value=>!value);
      else if(command==="stash")stashPrompt();
      else if(command==="terminal")setPanel(value=>value==="terminal"?null:"terminal");
      else if(command==="files")openRightPanel("files");
      else if(command==="source")openRightPanel("source");
      else if(command==="goal"&&activeThread?.id)openRightPanel("goal");
      else if(command==="projects")setSection("projects");
      else if(command==="settings")setSection("settings");
      else if(command==="environments")setSection("environments");
      else if(command==="steerQueued"&&queued.length)sendQueuedNow(queued[0]);
      else if(command==="cycleTheme")cycleTheme();
      else if(command==="cycleAppearance")cycleAppearance();
    };
    window.addEventListener("keydown",key);
    return()=>window.removeEventListener("keydown",key);
  },[settings,prompt,attachments,section,panel,paletteOpen,question,approvals.length,projectPath,activeThread?.id,running,rightPanelOpen,queued]);
  useEffect(()=>{if(!running&&queued.length){const next=queued[0];setQueued(prev=>prev.slice(1));startTurn(next.text,next.attachments,next.model||model).catch(error=>setEvents(prev=>[...prev,{id:"queue-error-"+Date.now(),kind:"error",title:error.message,status:"done"}]))}},[running,queued]);

  function handleServerRequest(client,message){
    if(message.method==="item/tool/requestUserInput"){setQuestion({client,request:message});desktopNotify("Trebell Code needs input","The running agent asked you a question.");return}
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
            if(!settings.agentDeviceAccess)throw new Error("Agent device access is disabled in Settings.");
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
    if(message.method==="thread/started"&&p.thread){
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
      }
    }
    else if(message.method==="turn/plan/updated"&&isCurrent){const plan=(p.plan||[]).map((s,i)=>({id:"plan-"+i,kind:"plan",title:s.step||s.description||s.text||"Plan step",status:s.status==="completed"?"done":s.status==="inProgress"?"running":"pending",raw:s}));setEvents(prev=>[...prev.filter(e=>e.kind!=="plan"),...plan])}
    else if(message.method==="item/started"&&p.item){
      const item=normalizeItem(p.item);
      updateThreadTelemetry(threadId,{currentActivity:{id:item.id,kind:item.kind,title:item.title,startedAtMs:p.startedAtMs||Date.now()},lastActivityAt:p.startedAtMs||Date.now()});
      if(isCurrent)setEvents(prev=>[...prev.filter(e=>e.id!==item.id),item]);
    }
    else if(message.method==="item/completed"&&p.item){
      const item=normalizeItem({...p.item,status:"completed"});
      const completedAtMs=p.completedAtMs||Date.now();
      updateThreadTelemetry(threadId,current=>({currentActivity:current.currentActivity?.id===item.id?null:current.currentActivity,lastActivity:{id:item.id,kind:item.kind,title:item.title,durationMs:p.item?.durationMs??null,completedAtMs},lastActivityAt:completedAtMs}));
      if(isCurrent){
        if(p.item.type==="agentMessage"&&p.item.text?.trim()){setMessages(prev=>prev.some(m=>m.id===p.item.id)?prev:[...prev,{id:p.item.id,role:"assistant",text:p.item.text,turnId:p.turnId||null}]);setAssistantText("")}
        setEvents(prev=>prev.some(e=>e.id===item.id)?prev.map(e=>e.id===item.id?{...e,...item}:e):[...prev,item]);
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
    else if(message.method==="thread/attachment/updated"&&isCurrent)loadPersistentThreadData(p.threadId).catch(()=>{});
    else if(message.method==="thread/providerMetadata/updated"){
      setThreads(prev=>prev.map(thread=>thread.id===p.threadId?{...thread,providerMeta:{...(thread.providerMeta||{}),[p.type]:p.update}}:thread));
      if(isCurrent){setActiveThread(prev=>prev?.id===p.threadId?{...prev,providerMeta:{...(prev.providerMeta||{}),[p.type]:p.update}}:prev);applyProviderInventory(p.update||{})}
    }
    else if(message.method==="thread/compacted"){
      updateThreadTelemetry(threadId,{lastActivity:{kind:"contextCompaction",title:"Context compacted",completedAtMs:Date.now()},lastActivityAt:Date.now()});
      if(isCurrent)setEvents(prev=>[...prev,{id:"compact-"+Date.now(),kind:"tool",title:"Context compacted",status:"done",raw:p}]);
    }
    else if(message.method==="error"){
      updateThreadTelemetry(threadId,{currentActivity:null,lastError:p.message||"Agent error",lastActivityAt:Date.now()});
      if(isCurrent){setEvents(prev=>[...prev,{id:"error-"+Date.now(),kind:"error",title:p.message||"Agent error",status:"done",raw:p}]);setRunning(false);desktopNotify("Trebell Code error",p.message||"The agent stopped with an error.")}
    }
  }

  async function updateThreadMeta(threadId,patch){const meta=await api("/api/thread-meta",{method:"POST",body:{threadId,patch}}).catch(()=>({...threadMeta[threadId],...patch}));setThreadMeta(prev=>({...prev,[threadId]:meta}));return meta}
  async function moveThread(thread,destination,beforeThreadId=null){
    if(!rpc||rpcStatus!=="connected")return;
    const target=destination==="active"?null:sections[destination==="pin"?"Pinned":destination==="snooze"?"Snoozed":destination==="settle"?"Settled":destination];
    await rpc.request("thread/section/move",{threadId:thread.id,sectionId:target?.id||null,beforeThreadId});
    const updated={...thread,section:target||null,sectionEnteredAt:target?Date.now()/1000:null};setThreads(prev=>prev.map(t=>t.id===thread.id?updated:t));if(activeThread?.id===thread.id)setActiveThread(updated);
  }
  async function threadAction(thread,action){
    if(action==="pin"){await moveThread(thread,"pin");return}
    if(action==="settle"){await moveThread(thread,"settle");return}
    if(action==="active"){await moveThread(thread,"active");await updateThreadMeta(thread.id,{snoozedUntil:null});return}
    if(action==="snooze"){const mins=Number(prompt("Snooze for how many minutes?","60"));if(!Number.isFinite(mins)||mins<=0)return;await updateThreadMeta(thread.id,{snoozedUntil:Date.now()+mins*60000});await moveThread(thread,"snooze");return}
    if(action==="fork"){
      if(!rpc)return;
      const p=presetFor(permissionMode);
      const result=await rpc.request("thread/fork",{threadId:thread.id,model:model||null,modelProvider:provider,cwd:thread.cwd||projectPath,approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,threadSource:"trebell-code",excludeTurns:false});
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
    if(action==="archive"){await rpc?.request("thread/archive",{threadId:thread.id});setThreads(prev=>prev.filter(t=>t.id!==thread.id));if(activeThread?.id===thread.id)newChat()}
  }
  async function moveThreadOrder(thread,direction){const group=threads.filter(t=>(t.section?.name||"Active")===(thread.section?.name||"Active"));const index=group.findIndex(t=>t.id===thread.id);const targetIndex=index+direction;if(targetIndex<0||targetIndex>=group.length)return;const before=direction<0?group[targetIndex].id:(group[targetIndex+1]?.id||null);await rpc.request("thread/section/move",{threadId:thread.id,sectionId:thread.section?.id||null,beforeThreadId:before});await loadThreads(rpc)}
  async function bulkAction(action){for(const id of selectedThreadIds){const thread=threads.find(t=>t.id===id);if(thread)await threadAction(thread,action)}setSelectedThreadIds(new Set())}

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
  async function newChat(){activeThreadRef.current=null;setSection("chat");setActiveThread(null);setActiveTurnId(null);setMessages([]);setEvents([]);setAssistantText("");setQueued([]);setPrompt("");setAttachments([]);setContextChips([]);setTokenUsage(null);setCheckpointByTurn({});setGoal(null);setLinkedPullRequests([]);setWorktreeSetup(null);setProviderAgent("");if(agentRuntime!=="codex"){setSkills([]);setProviderCommands([]);setProviderAgents([])}}
  async function openThread(thread){
    activeThreadRef.current=thread;setSection("chat");setEvents([]);setAssistantText("");setWorktreeSetup(null);setActiveThread(thread);
    if(thread.cwd)await touchProject(thread.cwd);else setProjectPath(projectPath);
    if(!rpc||rpcStatus!=="connected")return;
    const [resumed,cp,goalData,attachmentData]=await Promise.all([
      rpc.request("thread/resume",{threadId:thread.id,model:model||null,modelProvider:provider,cwd:thread.cwd||null,excludeTurns:false}).catch(()=>null),
      api("/api/checkpoints?threadId="+encodeURIComponent(thread.id)).catch(()=>({checkpoints:[]})),
      rpc.request("thread/goal/get",{threadId:thread.id}).catch(()=>({goal:null})),
      rpc.request("thread/attachment/list",{threadId:thread.id,limit:100}).catch(()=>({data:[]})),
    ]);
    const map=Object.fromEntries((cp.checkpoints||[]).filter(x=>x.turnId).map(x=>[x.turnId,x]));setCheckpointByTurn(map);
    if(resumed?.thread){activeThreadRef.current=resumed.thread;setActiveThread(resumed.thread);setMessages(historyFromThread(resumed.thread,map));setProjectPath(resumed.thread.cwd||projectPath);setProviderAgent(resumed.thread.agent||"");if(agentRuntime!=="codex"){const meta=resumed.thread.providerMeta||{};applyProviderInventory(meta.session_info_update||meta.available_commands_update||{})}}
    const meta=threadMeta[thread.id]||{};setReviewedFiles(meta.reviewedFiles||[]);setGoal(goalData?.goal||null);
    const persisted=(attachmentData?.data||[]).filter(item=>item.attachmentType==="pull_request").map(item=>({...item.payload,__identityKey:item.identityKey}));
    setLinkedPullRequests(persisted.length?persisted:(meta.linkedPullRequests||[]));
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
  async function createThreadFor(modelId,cwd){const p=presetFor(permissionMode);const dynamicTools=[...TREBELL_BROWSER_TOOLS,...TREBELL_COMPUTER_TOOLS,...(settings.agentDeviceAccess?TREBELL_DEVICE_TOOLS:[])];const result=await rpc.request("thread/start",{model:modelId,modelProvider:provider,cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,ephemeral:false,threadSource:"trebell-code",dynamicTools,developerInstructions:webSearch?"Web research is allowed when useful. You may use trebell_browser for interactive pages.":"Do not use web search or trebell_browser unless the user explicitly requests it."});if(agentRuntime!=="codex"&&result.thread?.providerMeta){setProviderAgent(result.thread.agent||providerAgent||"");const meta=result.thread.providerMeta;applyProviderInventory(meta.session_info_update||meta.available_commands_update||{})}return result.thread}
  function inputsFor(text,paths){return [{type:"text",text,text_elements:[]},...(paths||[]).map(path=>{const lower=String(path).toLowerCase();if(/\.(png|jpe?g|gif|webp|bmp)$/.test(lower))return{type:"localImage",path};if(/\.(mp3|wav|m4a|ogg|flac)$/.test(lower))return{type:"localAudio",path};return{type:"mention",name:String(path).split(/[\\/]/).pop(),path}})]}
  async function startTurn(text,paths,modelId=model,threadOverride=null,cwdOverride=null){
    if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");let thread=threadOverride||activeThread;let cwd=cwdOverride||projectPath||bootstrap.cwd;
    if(!thread){cwd=await prepareWorktree(cwd,modelId);thread=await createThreadFor(modelId,cwd);activeThreadRef.current=thread;setActiveThread(thread);setThreads(prev=>[thread,...prev]);setProjectPath(cwd)}
    const clientId="user-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);setMessages(prev=>[...prev,{id:clientId,role:"user",text}]);setEvents([]);setAssistantText("");setRunning(true);
    const checkpoint=await api("/api/checkpoints",{method:"POST",body:{cwd,threadId:thread.id,label:text.slice(0,80)}}).catch(()=>null);const p=presetFor(permissionMode);
    const sandboxPolicy=p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:{type:"workspaceWrite",writableRoots:[cwd],networkAccess:webSearch,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
    const custom=(settings.customModels||[]).find(item=>item.id===modelId&&item.runtime===agentRuntime&&(agentRuntime!=="codex"||item.provider===provider));
    const result=await rpc.request("turn/start",{threadId:thread.id,model:modelId,cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...(agentRuntime==="codex"&&custom?.effort?{effort:custom.effort}:{}),...(agentRuntime==="codex"&&custom?.serviceTier?{serviceTierForTurn:custom.serviceTier}:{}),approvalPolicy:p.approvalPolicy,sandboxPolicy,input:inputsFor(text,paths)});const turnId=result?.turn?.id||null;setActiveTurnId(turnId);
    setMessages(prev=>prev.map(m=>m.id===clientId?{...m,turnId,checkpointId:checkpoint?.id||null}:m));if(checkpoint?.id&&turnId){await api("/api/checkpoints/link",{method:"POST",body:{id:checkpoint.id,patch:{turnId}}}).catch(()=>{});setCheckpointByTurn(prev=>({...prev,[turnId]:{...checkpoint,turnId}}))}setAttachments([]);setContextChips([]);return{thread,turnId};
  }
  async function handleSpecial(text){
    if(!text.startsWith("/"))return null;const [command,...rest]=text.split(/\s+/);
    if(command==="/compact"){
      if(!["codex","opencode","claude"].includes(agentRuntime)){setEvents(prev=>[...prev,{id:"compact-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not expose generic context compaction`,status:"done",raw:{}}]);return true}
      if(activeThread?.id&&rpc)await rpc.request("thread/compact/start",{threadId:activeThread.id});setEvents(prev=>[...prev,{id:"compact-request",kind:"tool",title:"Compacting context",status:"running",raw:{}}]);return true
    }
    if(command==="/model"){setSection(provider==="freebuff"?"freebuff":"settings");return true}
    if(command==="/terminal"){setPanel("terminal");return true}
    if(command==="/diff"){openRightPanel("diff");return true}
    if(command==="/git"){openRightPanel("source");return true}
    if(command==="/preview"){openRightPanel("preview");return true}
    if(command==="/agents"){if(agentRuntime==="codex")openRightPanel("agents");else setEvents(prev=>[...prev,{id:"agents-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} collaboration controls are not exposed yet`,status:"done",raw:{}}]);return true}
    if(command==="/review"){await startReview();return true}
    if(command==="/goal"){if(activeThread?.id)openRightPanel("goal");return true}
    if(command==="/palette"){setPaletteOpen(true);return true}
    if(command==="/new"){await newChat();return true}
    if(command==="/clear"){await newChat();return true}
    if(command==="/plan"){setPrompt("Create a clear execution plan, then carry it out. "+rest.join(" "));return true}
    return false;
  }
  async function send(){
    const text=prompt.trim();if(!text)return;
    if(prompt.length>MAX_COMPOSER_CHARS){setEvents(prev=>[...prev,{id:"prompt-too-long-"+Date.now(),kind:"error",title:`Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()} character limit`,status:"done",raw:{length:prompt.length}}]);return}
    const special=await handleSpecial(text);if(special===true){setPrompt("");return}
    if(agentRuntime==="antigravity"&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"video-unsupported-"+Date.now(),kind:"error",title:"Antigravity does not accept video attachments",status:"done",raw:{}}]);return}
    if(running){
      if(agentRuntime==="codex"&&settings.followUpMode==="steer"&&rpc&&activeThread&&activeTurnId){await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(text,attachments)});setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text,turnId:activeTurnId}]);setPrompt("");setAttachments([]);setContextChips([]);return}
      setQueued(prev=>[...prev,{id:crypto.randomUUID(),text,attachments:[...attachments],contextChips:[...contextChips],model}]);setPrompt("");setAttachments([]);setContextChips([]);return;
    }
    setPrompt("");setPromptHistoryIndex(-1);setSection("chat");
    if(bootstrap.mock||!rpc||rpcStatus!=="connected"){setMessages(prev=>[...prev,{id:"user-"+Date.now(),role:"user",text}]);setRunning(true);try{const d=await api("/api/chat/direct",{method:"POST",body:{prompt:text,model}});setMessages(prev=>[...prev,{id:"assistant-"+Date.now(),role:"assistant",text:d.text||""}]);setEvents([{id:"fallback",kind:"tool",title:({freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||"Provider")+" direct response",status:"done",raw:{}}])}catch(e){setEvents([{id:"error",kind:"error",title:e.message,status:"done",raw:{}}])}finally{setRunning(false);setAttachments([]);setContextChips([])}return}
    await startTurn(text,attachments,model).catch(e=>{setRunning(false);setEvents([{id:"send-error",kind:"error",title:e.message,status:"done",raw:{}}])});
  }
  async function sendQueuedNow(item){setQueued(prev=>prev.filter(q=>q.id!==item.id));if(agentRuntime==="codex"&&running&&rpc&&activeThread&&activeTurnId){await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(item.text,item.attachments)});setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.text,turnId:activeTurnId}])}else if(running)setQueued(prev=>[item,...prev]);else await startTurn(item.text,item.attachments,item.model||model)}
  async function stop(){
    if(rpc&&activeThread?.id&&activeTurnId)await rpc.request("turn/interrupt",{threadId:activeThread.id,turnId:activeTurnId}).catch(()=>{});
    const restored=restoreQueuedDraft({prompt,attachments,contextChips,queued,maxAttachments:MAX_COMPOSER_ATTACHMENTS});
    setPrompt(restored.prompt);setAttachments(restored.attachments);setContextChips(restored.contextChips);
    setQueued([]);setRunning(false);
  }
  async function editFromHere(message){if(!["codex","opencode","claude"].includes(agentRuntime)||!rpc||!activeThread?.id||!message.turnId)return;const restoreFiles=agentRuntime==="codex"?confirm("Also restore workspace files to the checkpoint before this turn?\n\nOK = conversation + files\nCancel = conversation only"):false;if(restoreFiles&&message.checkpointId)await api("/api/checkpoints/restore",{method:"POST",body:{id:message.checkpointId}}).catch(e=>alert(e.message));await rpc.request("thread/revert",{threadId:activeThread.id,beforeTurnId:message.turnId});setPrompt(message.text);await reloadActiveThread()}
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
    const pinnedEnvironment=activeThreadRef.current?.providerMeta?.environmentId;
    if(pinnedEnvironment!==undefined)body.environmentId=pinnedEnvironment;
    const result=await api("/api/attachments/import",{method:"POST",body});
    return (result.files||[]).map(file=>file.path);
  }
  async function addContextAttachment({name,text,kind="context",label="Context",detail=""}){const d=await api("/api/attachments/text",{method:"POST",body:{name,text}});const [path]=await prepareAttachmentPaths([d.path]);return addContextPath(path,{kind,label,detail})}
  function removeContext(path){setContextChips(prev=>prev.filter(chip=>chip.path!==path));setAttachments(prev=>prev.filter(item=>item!==path))}
  async function pickFiles(){const p=await window.trebellDesktop?.pickFiles?.();if(p?.length){const prepared=await prepareAttachmentPaths(p);await addFiles(prepared);return prepared}return[]}
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
  async function citeAssistant(message){
    if(!message?.text?.trim())return;
    const text=["Assistant response citation",activeThread?.name||activeThread?.id||"current thread","",message.text].join("\n");
    await addContextAttachment({name:"assistant-citation.txt",text,kind:"citation",label:"Assistant citation",detail:activeThread?.name||"Current thread"});
    setPrompt(prev=>(prev?prev+" ":"")+"Use the attached assistant citation as context. ");
  }
  async function attachReviewComment(path,comment){
    const text=["Code review comment","File: "+path,"",comment].join("\n");
    const filename=String(path).split(/[\\/]/).pop();
    await addContextAttachment({name:"review-"+filename+".txt",text,kind:"review",label:"Review: "+filename,detail:comment.slice(0,70)});
    setPrompt(prev=>(prev?prev+" ":"")+"Address the attached review comment. ");
    setPanel(null);setSection("chat");
  }
  async function attachPr(pr){const text=["Pull request #"+pr.number+": "+pr.title,pr.url,pr.headRefName+" -> "+pr.baseRefName,pr.body||""].join("\n");await addContextAttachment({name:"pr-"+pr.number+".txt",text,kind:"pr",label:"PR #"+pr.number,detail:pr.title});setSection("chat")}
  async function linkPr(pr){
    if(!activeThread?.id)return;
    const current=linkedPullRequests||[];
    const existing=current.find(x=>x.number===pr.number&&x.url===pr.url);
    const identityKey=existing?.__identityKey||pullRequestIdentity(pr);
    const payload={number:pr.number,title:pr.title,url:pr.url,state:pr.state,headRefName:pr.headRefName,baseRefName:pr.baseRefName};
    if(rpc&&rpcStatus==="connected"){
      if(existing)await rpc.request("thread/attachment/remove",{threadId:activeThread.id,attachmentType:"pull_request",identityKey});
      else await rpc.request("thread/attachment/add",{threadId:activeThread.id,attachmentType:"pull_request",identityKey,payload});
    }
    const next=existing?current.filter(x=>!(x.number===pr.number&&x.url===pr.url)):[...current,{...payload,__identityKey:identityKey}];
    setLinkedPullRequests(next);
    await updateThreadMeta(activeThread.id,{linkedPullRequests:next.map(({__identityKey,...item})=>item)});
  }
  async function toggleReviewed(path,value){const next=value?[...new Set([...reviewedFiles,path])]:reviewedFiles.filter(x=>x!==path);setReviewedFiles(next);if(activeThread?.id)await updateThreadMeta(activeThread.id,{reviewedFiles:next})}
  function resolveApproval(request,decision){if(!rpc)return;let result={decision};if(request.method==="item/permissions/requestApproval")result={permissions:request.params?.permissions||{},scope:decision==="acceptForSession"?"session":"turn"};rpc.respond(request.id,result);setApprovals(prev=>prev.filter(x=>x.id!==request.id))}
  async function answerQuestion(answers,filesByQuestion={}){if(!question)return;const result={};for(const q of question.request.params?.questions||[]){const values=[...(answers[q.id]||[])];const files=filesByQuestion[q.id]||[];if(files.length)values.push("Attached files:\n"+files.map(path=>"- "+path).join("\n"));result[q.id]={answers:values}}question.client.respond(question.request.id,{answers:result});setQuestion(null)}
  function cancelQuestion(){if(question){question.client.respond(question.request.id,{answers:{}});setQuestion(null)}}
  async function login(){await fetch("/api/login/start",{method:"POST"}).catch(()=>{});const poll=setInterval(async()=>{const data=await api("/api/bootstrap").catch(()=>null);if(data?.loggedIn){clearInterval(poll);setBootstrap(data);await refreshProviderModels();}},1500);setTimeout(()=>clearInterval(poll),120000)}
  async function logout(){await api("/api/logout",{method:"POST"});setBootstrap(prev=>({...prev,loggedIn:false,providerReady:false}));setModels([]);setModel("");setFreebuff({loggedIn:false})}
  async function renameThread(){if(!rpc||!activeThread)return;const name=prompt("Rename thread",titleOf(activeThread));if(!name?.trim())return;await rpc.request("thread/name/set",{threadId:activeThread.id,name:name.trim()});setActiveThread(prev=>({...prev,name:name.trim()}));setThreads(prev=>prev.map(t=>t.id===activeThread.id?{...t,name:name.trim()}:t))}
  async function shareThread(){const text=messages.map(m=>(m.role==="user"?"You":"Trebell Code")+": "+m.text).join("\n\n");if(text)await navigator.clipboard?.writeText(text).catch(()=>{})}
  async function startReview(){
    if(!rpc||!activeThread?.id)throw new Error("Start or open a thread before reviewing.");
    const result=await rpc.request("review/start",{threadId:activeThread.id,target:{type:"uncommittedChanges"}});
    if(result?.turn?.id){setRunning(true);setActiveTurnId(result.turn.id)}
    setEvents(prev=>[...prev,{id:"review-"+Date.now(),kind:"tool",title:"Reviewing uncommitted changes",status:"running",raw:result||{}}]);
    return result;
  }
  async function runProjectAction(script){
    if(!script||!projectPath)return;
    const result=await api("/api/project-script/run",{method:"POST",body:{path:projectPath,scriptId:script.id}});
    setSection("chat");setPanel("terminal");
    setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:result?.session?.id||null})),0);
    if(script.previewUrl&&script.autoOpenPreview){
      openRightPanel("preview");
      setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:preview-open",{detail:script.previewUrl})),0);
    }
    return result;
  }
  async function onProjectOpen(path){await touchProject(path);setSection("chat");if(rpcStatus==="connected")loadSkills(rpc,path)}
  async function finishOnboarding({openSettings=false}={}){
    const next=await api("/api/settings",{method:"POST",body:{onboardingComplete:true,defaultPermissionMode:permissionMode}});
    setSettings(prev=>({...prev,...next}));
    if(openSettings)setSection("settings");
  }
  async function pickWorkspace(){
    const path=await window.trebellDesktop?.pickDirectory?.();
    if(!path)return;
    if(activeThread?.id&&String(activeThread.cwd||"")!==String(path)){
      await newChat();
    }
    await onProjectOpen(path);
  }
  function onSkill(skill){const prefix=agentRuntime==="codex"?"$":"/";setPrompt(prev=>(prev?prev+" ":"")+prefix+skill.name+" ")}
  async function changeProviderAgent(name){
    setProviderAgent(name||"");
    if(agentRuntime==="codex"||!activeThread?.id||!rpc||rpcStatus!=="connected")return;
    const result=await rpc.request("thread/settings/update",{threadId:activeThread.id,settings:{agent:name||null}}).catch(()=>null);
    if(result?.thread){setActiveThread(result.thread);setThreads(prev=>prev.map(thread=>thread.id===result.thread.id?result.thread:thread))}
  }

  function openRightPanel(tab="files"){setRightPanelTab(tab);setRightPanelOpen(true);setSection("chat")}
  function navigateSection(next){
    if(next==="source"){openRightPanel("source");return}
    if(next==="preview"){openRightPanel("preview");return}
    if(next==="agents"){openRightPanel("agents");return}
    setSection(next);
  }
  async function saveAppSettings(patch){const next=await api("/api/settings",{method:"POST",body:patch});setSettings(prev=>({...prev,...next}));return next}
  async function cycleTheme(){const themes=["dark","midnight","black"];const next=themes[(themes.indexOf(settings.appearance||"dark")+1)%themes.length];await saveAppSettings({appearance:next})}
  async function cycleAppearance(){const modes=["system","light","dark"];const next=modes[(modes.indexOf(settings.appearanceMode||"system")+1)%modes.length];await saveAppSettings({appearanceMode:next})}

  const activeTitle=titleOf(activeThread);
  const projectLabel=String(projectPath||activeThread?.cwd||bootstrap.cwd||"Workspace").split(/[\\/]/).filter(Boolean).at(-1)||"Workspace";
  const providerLabel=({freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||provider);
  const agentRuntimeLabel=({codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"}[agentRuntime]||agentRuntime);
  const completedEvents=events.filter(event=>event.status==="done").length;
  const paletteActions=[
    {id:"new",label:"New thread",detail:"Start a clean coding task",shortcut:"Ctrl+N",onRun:newChat},
    {id:"folder",label:"Open workspace folder",detail:projectPath||"Choose a local folder",onRun:pickWorkspace},
    {id:"projects",label:"Recent projects",detail:"Switch checkouts or clone a repository",onRun:()=>setSection("projects")},
    {id:"files",label:"Files",detail:"Browse and edit the workspace",onRun:()=>openRightPanel("files")},
    {id:"diff",label:"Changes",detail:"Inspect the current Git diff",onRun:()=>openRightPanel("diff")},
    {id:"git",label:"Source control",detail:gitInfo?.branch||"Git and pull requests",onRun:()=>openRightPanel("source")},
    {id:"terminal",label:"Terminal",detail:"Open the persistent PTY",shortcut:"Ctrl+Shift+T",onRun:()=>setPanel("terminal")},
    ...((currentProject?.scripts||[]).map(script=>({id:"project-action:"+script.id,label:"Run "+script.name,detail:script.command,onRun:()=>runProjectAction(script)}))),
    {id:"browser",label:"Browser",detail:"Open Trebell Agent Browser",onRun:()=>openRightPanel("preview")},
    ...(agentRuntime==="codex"?[{id:"agents",label:"Agents & collaboration",detail:"Delegated threads and collaboration mode",onRun:()=>openRightPanel("agents")}]:[]),
    ...(activeThread?.id?[{id:"goal",label:"Thread goal",detail:goal?.objective||"Set a durable objective",onRun:()=>openRightPanel("goal")}]:[]),
    ...(activeThread?.id&&gitInfo?.isGit?[{id:"review",label:"Review changes",detail:"Ask Codex to review uncommitted changes",onRun:()=>startReview()}]:[]),
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
    {id:"settings",label:"Settings",detail:"Providers, permissions and desktop behavior",onRun:()=>setSection("settings")},
    {id:"copy",label:"Copy conversation",detail:"Copy this thread as text",onRun:shareThread},
  ];

  const previewSurface=<PreviewPage
    projectPath={projectPath}
    onAttachText={async(name,text,meta={})=>addContextAttachment({name,text,kind:meta.kind||"browser",label:meta.label||"Browser context",detail:meta.detail||""})}
    onAttachImage={async(dataUrl)=>{const d=await api("/api/attachments/blob",{method:"POST",body:{name:"browser-screenshot.png",mime:"image/png",dataBase64:String(dataUrl).split(",")[1]||""}});const [path]=await prepareAttachmentPaths([d.path]);await addContextPath(path,{kind:"browser",label:"Browser screenshot",detail:"PNG capture"})}}
    onAttachFile={async(file,meta={})=>{const d=await blobAttachment(file);await addContextPath(d.path,{kind:meta.kind||"browser",label:meta.label||file.name,detail:meta.detail||`${Math.round(file.size/1024)} KB`})}}
  />;

  function rightPanelContent(){
    if(rightPanelTab==="files"||rightPanelTab==="diff")return <WorkspacePanel key={rightPanelTab} defaultTab={rightPanelTab==="diff"?"diff":"files"} projectPath={projectPath} activeThreadId={activeThread?.id} reviewedFiles={reviewedFiles} onReviewedChange={toggleReviewed} onAttachPath={path=>addFiles([path])} onReviewComment={attachReviewComment}/>;
    if(rightPanelTab==="preview")return previewSurface;
    if(rightPanelTab==="source")return <SourceControlPanel projectPath={projectPath} model={model} provider={provider} onProjectChange={onProjectOpen} onAttachPr={attachPr} onLinkPr={linkPr} linkedPullRequests={activeThread?.id?linkedPullRequests:[]}/>;
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
      {agentRuntime==="codex"&&provider==="freebuff"&&<FreebuffMini freebuff={freebuff} model={model} onOpen={()=>setSection("freebuff")}/>}
      <section className="runtime-activity"><strong>Latest activity</strong><p>{events.find(event=>event.status==="running")?.title||events.at(-1)?.title||"Waiting for a task"}</p></section>
    </div>;
  }

  return <div className="app-shell">
    <ThreadSidebar section={section} setSection={navigateSection} threads={displayThreads} activeThreadId={activeThread?.id} query={query} setQuery={setQuery} onOpen={openThread} onNew={newChat} onThreadAction={threadAction} onMove={moveThreadOrder} selectedIds={selectedThreadIds} setSelectedIds={setSelectedThreadIds} onBulkAction={bulkAction} provider={provider} agentRuntime={agentRuntime}/>

    <div className={"workspace-shell"+(rightPanelOpen?" right-open":"")}>
      <main className={"main-frame"+(panel==="terminal"?" terminal-open":"")}>
        <div className="window-bar">
          <span className="window-drag-space"/>
          <div className="window-controls"><button onClick={()=>window.trebellDesktop?.minimize?.()}>—</button><button onClick={()=>window.trebellDesktop?.maximize?.()}>□</button><button className="window-close" onClick={()=>window.trebellDesktop?.close?.()}>×</button></div>
        </div>

        {(section==="chat"||section==="new")&&<div className="chat-workspace">
          <header className="workspace-header">
            <div className="workspace-breadcrumb">
              <button className="project-crumb" onClick={pickWorkspace} title={projectPath||"Open folder"}><FolderCode size={14}/><span>{projectLabel}</span></button><button className="project-switcher" onClick={()=>setSection("projects")} title="Recent projects"><ChevronDown size={12}/></button>
              <span>/</span>
              <button className="thread-title-button" onDoubleClick={renameThread} onClick={renameThread} title="Rename thread"><strong>{activeTitle}</strong><ChevronDown size={13}/></button>
              {activeThread?.id&&linkedPullRequests.map(pr=><button className="header-pr" key={pr.url||pr.number} onClick={()=>window.open(pr.url,"_blank")}><GitBranch size={11}/>#{pr.number}</button>)}
            </div>
            <div className="workspace-header-actions">
              {gitInfo?.isGit&&<button className="header-control branch-control" onClick={()=>openRightPanel("source")} title="Source control"><GitBranch size={14}/><span>{gitInfo.branch||"detached"}</span></button>}
              <OpenInPicker path={projectPath}/>
              {(currentProject?.scripts||[]).length>0&&(()=>{const script=(currentProject.scripts||[]).find(item=>item.id===currentProject.preferredScriptId)||currentProject.scripts[0];return <button className="header-control" onClick={()=>runProjectAction(script).catch(error=>setEvents(prev=>[...prev,{id:"project-action-error-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]))} title={script.command}><Play size={13}/><span>{script.name}</span></button>})()}
              {activeThread?.id&&gitInfo?.isGit&&<button className="header-control" onClick={()=>startReview().catch(error=>setEvents(prev=>[...prev,{id:"review-error-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]))} title="Review uncommitted changes"><ShieldCheck size={14}/><span>Review</span></button>}
              {running&&<button className="header-control stop-control" onClick={stop}><CircleStop size={14}/><span>Stop</span></button>}
              <button data-testid="terminal-toggle" className={"header-control icon-only "+(panel==="terminal"?"active":"")} onClick={()=>setPanel(panel==="terminal"?null:"terminal")} aria-label="Toggle terminal" title="Toggle terminal"><PanelBottom size={16}/></button>
              {activeThread?.id&&<button className={"header-control icon-only "+(rightPanelOpen&&rightPanelTab==="goal"?"active":"")} onClick={()=>openRightPanel("goal")} aria-label="Thread goal" title={goal?.objective||"Set thread goal"}><Target size={15}/></button>}
              <button data-testid="right-panel-toggle" className={"header-control icon-only "+(rightPanelOpen?"active":"")} onClick={()=>rightPanelOpen?setRightPanelOpen(false):openRightPanel("files")} aria-label="Open files and diff" title="Toggle workspace panel"><PanelRight size={16}/></button>
              <button className="header-control icon-only" onClick={()=>setPaletteOpen(true)} aria-label="Command palette" title="Command palette · Ctrl+K"><Command size={15}/></button>
            </div>
          </header>

          <div className="conversation-scroll">
            <div className="conversation-column">
              <WorktreeSetupCard setup={worktreeSetup} onOpenTerminal={()=>{setPanel("terminal");if(worktreeSetup?.sessionId)setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:worktreeSetup.sessionId})),0)}} onDismiss={()=>setWorktreeSetup(null)}/>
              <Conversation messages={messages} onEditFromHere={editFromHere} onCite={citeAssistant} allowRevert={["codex","opencode","claude"].includes(agentRuntime)}/>
              <ActivityTimeline events={events} assistantText={assistantText} onOpenPanel={name=>name==="workspace"?openRightPanel("diff"):setPanel(name)}/>
              {approvals[0]&&<div className="inline-approval"><ApprovalCard request={approvals[0]} onResolve={resolveApproval}/></div>}
              {queued.map(item=><div className="queued-message" key={item.id}><span>Queued</span><p>{item.text}</p><button onClick={()=>sendQueuedNow(item)}>Send now</button><button onClick={()=>{setPrompt(item.text);setAttachments(item.attachments);setContextChips(item.contextChips||[]);setQueued(prev=>prev.filter(x=>x.id!==item.id))}}>Edit</button></div>)}
              {!messages.length&&!events.length&&<div className="welcome">
                <div className="welcome-mark"><img src="/trebell-code-icon.svg" alt="" aria-hidden="true"/></div>
                <h1>What do you want to build?</h1>
                <p>{agentRuntime==="codex"?`${providerLabel} supplies inference to the Codex harness.`:`${agentRuntimeLabel} is the active coding-agent harness.`} Trebell keeps files, terminal, Git, worktrees, previews and project actions in one workspace.</p>
                <div className="suggestions">
                  <button onClick={()=>setPrompt("Inspect this project and explain the architecture.")}>Explain codebase</button>
                  <button onClick={()=>setPrompt("Find a useful bug, fix it, and run the relevant tests.")}>Fix a bug</button>
                  <button onClick={()=>setPrompt("Implement the next missing feature and validate it end-to-end.")}>Ship a feature</button>
                </div>
              </div>}
            </div>
          </div>

          <Composer prompt={prompt} setPrompt={setPrompt} onPromptEdit={()=>setPromptHistoryIndex(-1)} historyIndex={promptHistoryIndex} onSend={send} running={running} providerReady={providerReady} provider={provider} agentRuntime={agentRuntime} agentRuntimeLabel={agentRuntimeLabel} login={login} onConfigureProvider={()=>setSection("settings")} models={models} modelMeta={modelMeta} model={model} setModel={setModel} modelError={modelError} freebuff={freebuff} attachments={attachments} contextChips={contextChips} onRemoveAttachment={path=>setAttachments(prev=>prev.filter(x=>x!==path))} onRemoveContext={removeContext} onPickFiles={pickFiles} onCaptureScreen={()=>captureDesktop().catch(error=>setEvents(prev=>[...prev,{id:"screen-error-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]))} onPaste={onPaste} onDrop={onDrop} permissionMode={permissionMode} setPermissionMode={setPermissionMode} webSearch={webSearch} setWebSearch={setWebSearch} skills={skills} providerCommands={providerCommands} providerAgents={providerAgents} providerAgent={providerAgent} onProviderAgent={changeProviderAgent} onSkill={onSkill} onFiles={()=>openRightPanel("files")} settings={settings} onStash={stashPrompt} tokenUsage={tokenUsage} workspaceMode={workspaceMode} setWorkspaceMode={setWorkspaceMode}/>

          {panel==="terminal"&&<div className="terminal-drawer" data-testid="drawer">
            <div className="terminal-drawer-head"><span><SquareTerminal size={14}/> Terminal</span><div><button onClick={()=>attachExcerpt("")} aria-hidden="true" tabIndex={-1} className="terminal-head-spacer"/><button onClick={()=>setPanel(null)} aria-label="Close terminal"><X size={15}/></button></div></div>
            <TerminalPanel projectPath={projectPath} onAttachExcerpt={attachExcerpt}/>
          </div>}
        </div>}

        {section==="projects"&&<div className="secondary-page"><div className="page-header"><div><h1>Projects</h1><p>Local repositories, checkouts, reusable actions and project defaults.</p></div></div><ProjectsPage currentPath={projectPath} onOpen={onProjectOpen} models={models} onProjectUpdated={project=>{if(project?.path===projectPath)setCurrentProject(project)}} onRunScript={result=>{setSection("chat");setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:result?.session?.id||null})),0)}} onOpenPreview={previewUrl=>{openRightPanel("preview");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:preview-open",{detail:previewUrl})),0)}}/></div>}
        {section==="templates"&&<div className="secondary-page"><h1>Templates</h1><p>Reusable starting points that become normal Trebell turns.</p><div className="template-grid">{[["Ship a feature","Inspect the project, plan a useful feature, implement it, run the relevant tests, fix failures, and summarize the result."],["Fix a bug","Reproduce a meaningful bug in this project, diagnose it, fix it, and validate the fix."],["Review codebase","Map this codebase architecture, important execution paths, risks, and highest-value improvements."],["Refactor safely","Choose a worthwhile refactor, preserve behavior, implement focused changes, and run tests."],["Autonomous build","Take this project to a working validated result. Continue through implementation and test failures until it passes."],["Security review","Review this project for concrete security weaknesses and propose or implement safe fixes."]].map(([name,text])=><button key={name} onClick={()=>{setPrompt(text);setSection("chat")}}><BrainCircuit size={20}/><strong>{name}</strong><span>{text}</span></button>)}</div></div>}
        {section==="freebuff"&&agentRuntime==="codex"&&provider==="freebuff"&&<div className="secondary-page"><div className="page-header"><div><h1>Freebuff</h1><p>Account, balance, model pricing and session state.</p></div></div><FreebuffPage freebuff={freebuff} model={model} modelMeta={modelMeta} onRefresh={()=>refreshFreebuff(model)}/></div>}
        {section==="tools"&&agentRuntime==="codex"&&<div className="secondary-page full"><HarnessToolsPage rpc={rpc} rpcStatus={rpcStatus} projectPath={projectPath} activeThread={activeThread} skills={skills}/></div>}
        {section==="environments"&&<div className="secondary-page full"><EnvironmentsPage/></div>}
        {section==="usage"&&<div className="secondary-page full"><UsagePage settings={settings}/></div>}
        {section==="licenses"&&<div className="secondary-page full"><div className="page-header"><div><h1>Open source licenses</h1><p>Installed third-party software, versions and license notices.</p></div></div><LicensesPage/></div>}
        {section==="settings"&&<div className="secondary-page full"><div className="page-header"><div><h1>Settings</h1><p>Agent harnesses, model providers, permissions and desktop behavior.</p></div></div><SettingsPage settings={settings} onSettings={setSettings} onProviderUpdated={(options={})=>{setProviderRevision(v=>v+1);return refreshProviderModels({resetThread:true,...options})}} runtime={runtime} rpcStatus={rpcStatus} loggedIn={bootstrap.loggedIn||bootstrap.mock} login={login} logout={logout} projectPath={projectPath} modelError={modelError} onOpenLicenses={()=>setSection("licenses")}/></div>}
        {section==="history"&&<div className="secondary-page"><div className="page-header"><div><h1>Thread history</h1><p>Every unarchived {agentRuntimeLabel} thread stored by Trebell on this machine.</p></div></div><div className="history-page">{threads.map(t=><button key={t.id} onClick={()=>openThread(t)}><FileCode2 size={15}/><div><strong>{titleOf(t)}</strong><span>{t.preview||t.cwd}</span></div><time>{new Date(t.updatedAt*1000).toLocaleString()}</time></button>)}</div></div>}
      </main>

      {rightPanelOpen&&<RightPanel active={rightPanelTab} onActive={setRightPanelTab} onClose={()=>setRightPanelOpen(false)}>{rightPanelContent()}</RightPanel>}
    </div>

    <QuestionModal request={question?.request} onSubmit={answerQuestion} onCancel={cancelQuestion} pickFiles={pickFiles}/>
    <CommandPalette open={paletteOpen} onClose={()=>setPaletteOpen(false)} actions={paletteActions} threads={threads} onOpenThread={openThread}/>
    <OnboardingModal open={initialLoaded&&settings.onboardingComplete===false} projectPath={projectPath} onPickWorkspace={pickWorkspace} providerLabel={agentRuntime==="codex"?providerLabel:agentRuntimeLabel} providerReady={providerReady} permissionMode={permissionMode} onPermissionMode={setPermissionMode} onFinish={finishOnboarding}/>
  </div>;
}
