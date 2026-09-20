import React,{useEffect,useMemo,useRef,useState} from "react";
import {
  BrainCircuit, Check, ChevronDown, CircleStop, Code2, Cpu, FileCode2, FileDiff, FolderCode,
  GitBranch, Globe2, HardDrive, Link2, ListTodo, MemoryStick, Network, Paperclip, Plus, Send,
  ShieldCheck, Sparkles, SquareTerminal, WandSparkles, X, Zap, Coins
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
  if(type==="mcpToolCall")title=item.tool||item.name||"Using MCP tool";
  if(type==="webSearch")title=item.query||"Searching the web";
  if(type==="reasoning")title="Reasoning";
  return {id:item.id||crypto.randomUUID(),kind:type,title:String(title).split("\n")[0].slice(0,160),status:item.status==="completed"?"done":item.status||"running",raw:item,output:""};
}
function presetFor(mode){
  if(mode==="full")return {sandbox:"danger-full-access",approvalPolicy:"never"};
  if(mode==="read-only")return {sandbox:"read-only",approvalPolicy:"on-request"};
  if(mode==="auto")return {sandbox:"workspace-write",approvalPolicy:"untrusted"};
  return {sandbox:"workspace-write",approvalPolicy:"on-request"};
}
function shortcutMatch(e,value){
  if(!value)return false;
  const parts=value.toLowerCase().split("+").map(x=>x.trim());
  const key=parts.pop();
  if(Boolean(parts.includes("ctrl"))!==Boolean(e.ctrlKey))return false;
  if(Boolean(parts.includes("cmd")||parts.includes("meta"))!==Boolean(e.metaKey))return false;
  if(Boolean(parts.includes("shift"))!==Boolean(e.shiftKey))return false;
  if(Boolean(parts.includes("alt"))!==Boolean(e.altKey))return false;
  return e.key.toLowerCase()===key;
}
function tokenLabel(tokenUsage){
  const total=tokenUsage?.total?.totalTokens;
  const windowSize=tokenUsage?.modelContextWindow;
  if(total==null)return "Context —";
  if(windowSize)return "Context "+Math.round(total/windowSize*100)+"% · "+total.toLocaleString()+" / "+windowSize.toLocaleString();
  return "Tokens "+total.toLocaleString();
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
function Conversation({messages,onEditFromHere,onCite}){
  return <div className="conversation-history">{messages.map(m=>m.role==="user"?<div className="user-row" key={m.id}><div className="user-bubble"><p>{m.text}</p>{m.turnId&&<button className="message-action" onClick={()=>onEditFromHere(m)}>Edit from here</button>}</div></div>:<div className="history-assistant" key={m.id}><div className="agent-star small"><Sparkles size={12}/></div><div><div className="assistant-message-text">{m.text}</div><button className="message-action" onClick={()=>onCite?.(m)}>Cite response</button></div></div>)}</div>;
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
  ["/model","Open Freebuff model/account page"],
  ["/terminal","Open persistent terminal"],
  ["/diff","Open workspace changes"],
  ["/git","Open source control"],
  ["/preview","Open browser preview"],
  ["/agents","Open delegated agents"],
  ["/new","Start a new thread"],
  ["/clear","Reset the current draft/thread view"],
];

function Composer({prompt,setPrompt,onSend,running,loggedIn,login,models,model,setModel,selectedModels,setSelectedModels,freebuff,attachments,onRemoveAttachment,onPickFiles,onPaste,onDrop,permissionMode,setPermissionMode,webSearch,setWebSearch,skills,onSkill,onFiles,settings,onStash,tokenUsage,workspaceMode,setWorkspaceMode}){
  const [modelsOpen,setModelsOpen]=useState(false);
  const [skillsOpen,setSkillsOpen]=useState(false);
  function keyDown(e){
    if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();onSend();return}
    if(e.key==="ArrowUp"&&!prompt){e.preventDefault();window.dispatchEvent(new CustomEvent("trebell:history",{detail:-1}))}
    if(e.key==="ArrowDown"){window.dispatchEvent(new CustomEvent("trebell:history",{detail:1}))}
  }
  const slashOpen=prompt.startsWith("/")&&!prompt.includes("\n");
  const slashQuery=prompt.toLowerCase();
  const slashItems=slashOpen?SLASH_COMMANDS.filter(([cmd])=>cmd.startsWith(slashQuery.split(/\s/)[0])):[];
  return <div className="composer-wrap" onDragOver={e=>e.preventDefault()} onDrop={onDrop}>
    {slashOpen&&slashItems.length>0&&<div className="slash-menu">{slashItems.map(([cmd,desc])=><button key={cmd} onMouseDown={e=>{e.preventDefault();setPrompt(cmd+" ")}}><strong>{cmd}</strong><span>{desc}</span></button>)}</div>}
    <div className="attachment-shelf">{attachments.map(path=><span key={path}><Paperclip size={11}/>{String(path).split(/[\\/]/).pop()}<button onClick={()=>onRemoveAttachment(path)}><X size={10}/></button></span>)}</div>
    <textarea data-testid="composer" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={keyDown} onPaste={onPaste} placeholder={loggedIn?(running?(settings.followUpMode==="steer"?"Steer the running agent…":"Queue a follow-up…"):"Ask Trebell Code anything…"):"Sign in to Freebuff to start…"} disabled={!loggedIn}/>
    <div className="composer-bar"><div className="composer-left">
      <button className="circle-btn" onClick={onPickFiles}><Plus size={18}/></button>
      <button className={"pill-btn "+(webSearch?"active":"")} onClick={()=>setWebSearch(!webSearch)}><Globe2 size={14}/> Web</button>
      <button className="pill-btn" onClick={onFiles}><FileCode2 size={14}/> Files</button>
      <div className="popover-wrap"><button className="pill-btn" onClick={()=>setSkillsOpen(!skillsOpen)}><WandSparkles size={14}/> Skills</button>{skillsOpen&&<div className="mini-popover">{skills.length?skills.map(s=><button key={s.path} onClick={()=>{onSkill(s);setSkillsOpen(false)}}><strong>{"$"}{s.name}</strong><span>{s.description}</span></button>):<p>No enabled skills found.</p>}</div>}</div>
      <select className="permission-picker" value={permissionMode} onChange={e=>setPermissionMode(e.target.value)}><option value="supervised">Supervised</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select>
      <select className="workspace-mode" value={workspaceMode} onChange={e=>setWorkspaceMode(e.target.value)}><option value="current">Current workspace</option><option value="worktree">New worktree</option></select>
    </div><div className="composer-right">
      {!loggedIn?<button className="login-btn" onClick={login}>Sign in to Freebuff</button>:<>
        <select data-testid="model-picker" value={model} onChange={e=>{setModel(e.target.value);setSelectedModels([e.target.value])}}>{models.map(id=><option key={id} value={id}>{modelLabel(id,freebuff)}</option>)}</select>
        <div className="popover-wrap"><button className="model-count" onClick={()=>setModelsOpen(!modelsOpen)}>{selectedModels.length} model{selectedModels.length===1?"":"s"}</button>{modelsOpen&&<div className="mini-popover models">{models.map(id=><label key={id}><input type="checkbox" checked={selectedModels.includes(id)} onChange={()=>setSelectedModels(prev=>prev.includes(id)?(prev.length===1?prev:prev.filter(x=>x!==id)):[...prev,id])}/><span>{modelLabel(id,freebuff)}</span></label>)}</div>}</div>
      </>}
      <button className="stash-btn" onClick={onStash} title="Stash or restore prompt">S</button>
      <button data-testid="send" className="send-btn" onClick={onSend} disabled={!loggedIn||!prompt.trim()}>{running&&settings.followUpMode==="queue"?<Plus size={16}/>:<Send size={16}/>}</button>
    </div></div>
    <div className="composer-status"><span>{tokenLabel(tokenUsage)}</span><span>{settings.followUpMode==="steer"?"Steer":"Queue"} follow-ups</span></div>
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
  const [prompt,setPrompt]=useState(""); const [promptHistoryIndex,setPromptHistoryIndex]=useState(-1); const [attachments,setAttachments]=useState([]);
  const [models,setModels]=useState([]); const [model,setModel]=useState(""); const [selectedModels,setSelectedModels]=useState([]);
  const [freebuff,setFreebuff]=useState({loggedIn:false}); const [skills,setSkills]=useState([]);
  const [settings,setSettings]=useState({followUpMode:"queue",defaultPermissionMode:"supervised",appearance:"dark",keyboardShortcuts:{}});
  const [permissionMode,setPermissionMode]=useState("supervised"); const [webSearch,setWebSearch]=useState(true); const [workspaceMode,setWorkspaceMode]=useState("current");
  const [projectPath,setProjectPath]=useState(""); const [gitInfo,setGitInfo]=useState(null); const [stats,setStats]=useState({}); const [runtime,setRuntime]=useState({});
  const [approvals,setApprovals]=useState([]); const [question,setQuestion]=useState(null); const [tokenUsage,setTokenUsage]=useState(null);
  const [panel,setPanel]=useState(null); const [reviewedFiles,setReviewedFiles]=useState([]); const [checkpointByTurn,setCheckpointByTurn]=useState({});
  const [selectedThreadIds,setSelectedThreadIds]=useState(new Set());
  const rpcRef=useRef(null); const timezone=useMemo(()=>Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",[]);
  const displayThreads=searchResults||threads;
  function desktopNotify(title,body){
    if(settings.notifications===false)return;
    window.trebellDesktop?.notify?.({title,body,silent:!settings.notificationSound});
  }

  useEffect(()=>{document.documentElement.dataset.theme=settings.appearance||"dark"},[settings.appearance]);

  async function refreshFreebuff(modelOverride=model){
    if(!(bootstrap.loggedIn||bootstrap.mock))return;
    const params=new URLSearchParams({timezone}); if(modelOverride)params.set("model",modelOverride);
    const data=await api("/api/freebuff/overview?"+params).catch(()=>null); if(data)setFreebuff(data);
  }
  async function touchProject(path){
    if(!path)return null;
    setProjectPath(path);
    const response=await api("/api/projects",{method:"POST",body:{path}}).catch(()=>null);
    const project=response?.project||null;
    if(project?.defaultModel&&models.includes(project.defaultModel)){setModel(project.defaultModel);setSelectedModels([project.defaultModel])}
    if(project?.permissionMode)setPermissionMode(project.permissionMode);
    if(project?.workspaceMode)setWorkspaceMode(project.workspaceMode);
    if(settings.autoPull)api("/api/git/action",{method:"POST",body:{action:"auto-pull",cwd:path}}).catch(()=>{});
    return project;
  }

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      const [boot,state,modelData]=await Promise.all([api("/api/bootstrap").catch(()=>({mock:true,loggedIn:true,cwd:"",platform:""})),api("/api/state").catch(()=>({settings:{},projects:[],threadMeta:{}})),api("/api/models").catch(()=>({models:[]}))]);
      if(cancelled)return; setBootstrap(boot); setSettings(prev=>({...prev,...(state.settings||{})})); setPermissionMode(state.settings?.defaultPermissionMode||"supervised"); setThreadMeta(state.threadMeta||{});
      const firstProject=state.projects?.[0]||null;
      setProjectPath(firstProject?.path||boot.cwd||"");
      const freeModels=(modelData.models||[]).filter(x=>x.startsWith("freebuff/")); const fallback=freeModels.length?freeModels:(boot.mock?["freebuff/deepseek/deepseek-v4-flash","freebuff/test/coding-large","freebuff/test/coding-fast"]:[]);
      const initialModel=(firstProject?.defaultModel&&fallback.includes(firstProject.defaultModel))?firstProject.defaultModel:(fallback[0]||"");
      setModels(fallback); setModel(initialModel); setSelectedModels(initialModel?[initialModel]:[]);
      if(firstProject?.permissionMode)setPermissionMode(firstProject.permissionMode);
      if(firstProject?.workspaceMode)setWorkspaceMode(firstProject.workspaceMode);
      if(initialModel){const p=new URLSearchParams({timezone,model:initialModel});const fb=await api("/api/freebuff/overview?"+p).catch(()=>null);if(fb&&!cancelled)setFreebuff(fb)}
    })(); return()=>{cancelled=true};
  },[]);

  async function ensureSections(client){
    const listed=await client.request("threadSection/list",{limit:50}).catch(()=>({data:[]})); const map=Object.fromEntries((listed.data||[]).map(s=>[s.name,s]));
    for(const name of ["Pinned","Snoozed","Settled"]){if(!map[name]){const made=await client.request("threadSection/create",{name}).catch(()=>null);if(made?.section)map[name]=made.section}}
    setSections(map); return map;
  }
  async function loadThreads(client){
    const listed=await client.request("thread/list",{limit:100,modelProviders:["freebuff"],sortKey:"updated_at",sortDirection:"desc"}).catch(()=>({data:[]})); setThreads(listed.data||[]); return listed.data||[];
  }
  async function loadSkills(client,path=projectPath){
    if(!path)return; const result=await client.request("skills/list",{cwds:[path]}).catch(()=>({data:[]})); setSkills((result.data||[]).flatMap(x=>x.skills||[]).filter(s=>s.enabled!==false));
  }

  useEffect(()=>{
    if(!bootstrap.wsUrl||bootstrap.mock)return; let disposed=false,retryTimer=null,client=null;
    const connect=async(attempt=0)=>{
      client=new CodexRpcClient(bootstrap.wsUrl,{onStatus:setRpcStatus,onNotification:handleNotification,onServerRequest:m=>handleServerRequest(client,m)}); rpcRef.current=client;setRpc(client);
      try{await client.connect();if(disposed)return;await ensureSections(client);await loadThreads(client);await loadSkills(client,projectPath)}
      catch(error){client.close();if(disposed)return;if(attempt<120){setRpcStatus("connecting");retryTimer=setTimeout(()=>connect(attempt+1),500)}else setRpcStatus("error")}
    };
    connect(); return()=>{disposed=true;clearTimeout(retryTimer);client?.close()};
  },[bootstrap.wsUrl,bootstrap.mock]);
  useEffect(()=>{if(rpcStatus==="connected"&&rpc)loadSkills(rpc,projectPath)},[projectPath,rpcStatus]);

  useEffect(()=>{const timer=setInterval(async()=>{const [s,r,g]=await Promise.all([api("/api/stats").catch(()=>null),api("/api/runtime").catch(()=>null),projectPath?api("/api/git/info?path="+encodeURIComponent(projectPath)).catch(()=>null):Promise.resolve(null)]);if(s)setStats(s);if(r)setRuntime(r);if(g)setGitInfo(g)},1800);return()=>clearInterval(timer)},[projectPath]);
  useEffect(()=>{if(!(bootstrap.loggedIn||bootstrap.mock))return;refreshFreebuff(model);const timer=setInterval(()=>refreshFreebuff(model),15000);return()=>clearInterval(timer)},[bootstrap.loggedIn,bootstrap.mock,model,timezone]);
  useEffect(()=>{if(!running||!(bootstrap.loggedIn||bootstrap.mock))return;const ping=()=>{const p=new URLSearchParams({timezone});if(model)p.set("model",model);fetch("/api/freebuff/heartbeat?"+p,{method:"POST"}).catch(()=>{})};ping();const timer=setInterval(ping,45000);return()=>clearInterval(timer)},[running,bootstrap.loggedIn,bootstrap.mock,model,timezone]);

  useEffect(()=>{const timer=setInterval(async()=>{if(!rpc||rpcStatus!=="connected")return;const now=Date.now();for(const thread of threads){const meta=threadMeta[thread.id];if(thread.section?.name==="Snoozed"&&meta?.snoozedUntil&&meta.snoozedUntil<=now){await moveThread(thread,"active");await updateThreadMeta(thread.id,{snoozedUntil:null})}}},30000);return()=>clearInterval(timer)},[rpc,rpcStatus,threads,threadMeta,sections]);

  useEffect(()=>{
    if(!query.trim()){setSearchResults(null);return} const q=query.toLowerCase(); const titleMatches=threads.filter(t=>titleOf(t).toLowerCase().includes(q)||(t.cwd||"").toLowerCase().includes(q));
    if(!rpc||rpcStatus!=="connected"||query.length<2){setSearchResults(titleMatches);return}
    let cancelled=false; const timer=setTimeout(async()=>{const found=new Map(titleMatches.map(t=>[t.id,t]));const rest=threads.filter(t=>!found.has(t.id)).slice(0,35);await Promise.all(rest.map(async t=>{const items=await rpc.request("thread/items/list",{threadId:t.id,limit:150,sortDirection:"desc"}).catch(()=>({data:[]}));if((items.data||[]).some(entry=>messageText(entry.item).toLowerCase().includes(q)))found.set(t.id,t)}));if(!cancelled)setSearchResults([...found.values()])},250);return()=>{cancelled=true;clearTimeout(timer)}
  },[query,threads,rpc,rpcStatus]);

  useEffect(()=>{const onHistory=event=>{const sent=messages.filter(m=>m.role==="user").map(m=>m.text);if(!sent.length)return;let next=promptHistoryIndex;if(event.detail<0)next=Math.min(sent.length-1,next+1);else next=Math.max(-1,next-1);setPromptHistoryIndex(next);setPrompt(next<0?"":sent[sent.length-1-next])};window.addEventListener("trebell:history",onHistory);return()=>window.removeEventListener("trebell:history",onHistory)},[messages,promptHistoryIndex]);
  useEffect(()=>{const key=e=>{const sc=settings.keyboardShortcuts||{};if(shortcutMatch(e,sc.newChat||"Ctrl+N")){e.preventDefault();newChat()}else if(shortcutMatch(e,sc.search||"Ctrl+K")){e.preventDefault();document.querySelector(".search-box input")?.focus()}else if(shortcutMatch(e,sc.stash||"Ctrl+S")){e.preventDefault();stashPrompt()}else if(shortcutMatch(e,sc.terminal||"Ctrl+Shift+T")){e.preventDefault();setPanel("terminal")}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)},[settings,prompt,attachments]);
  useEffect(()=>{if(!running&&queued.length){const next=queued[0];setQueued(prev=>prev.slice(1));startTurn(next.text,next.attachments,next.model||model).catch(error=>setEvents(prev=>[...prev,{id:"queue-error-"+Date.now(),kind:"error",title:error.message,status:"done"}]))}},[running,queued]);

  function handleServerRequest(client,message){
    if(message.method==="item/tool/requestUserInput"){setQuestion({client,request:message});desktopNotify("Trebell Code needs input","The running agent asked you a question.");return}
    if(message.method==="item/tool/call"){client.respond(message.id,{contentItems:[{type:"inputText",text:"No client-defined dynamic tool is registered."}],success:false});return}
    if(message.method.includes("requestApproval")||message.method==="applyPatchApproval"||message.method==="execCommandApproval"){setApprovals(prev=>[...prev,message]);desktopNotify("Approval required",message.params?.reason||message.params?.command||"Trebell Code is waiting for permission.");return}
    client.reject(message.id,-32601,"Unsupported Trebell client request: "+message.method);
  }
  function handleNotification(message){
    const p=message.params||{};
    if(message.method==="thread/started"&&p.thread){setActiveThread(p.thread);setThreads(prev=>[p.thread,...prev.filter(t=>t.id!==p.thread.id)])}
    else if(message.method==="thread/name/updated")setThreads(prev=>prev.map(t=>t.id===p.threadId?{...t,name:p.name}:t));
    else if(message.method==="thread/reverted"&&activeThread?.id===p.threadId)reloadActiveThread();
    else if(message.method==="turn/started"){const id=p.turn?.id||p.turnId;setRunning(true);setActiveTurnId(id);setMessages(prev=>{const index=[...prev].reverse().findIndex(m=>m.role==="user"&&!m.turnId);if(index<0)return prev;const real=prev.length-1-index;return prev.map((m,i)=>i===real?{...m,turnId:id}:m)})}
    else if(message.method==="turn/completed"){setRunning(false);setActiveTurnId(null);setEvents(prev=>prev.map(e=>e.status==="running"?{...e,status:"done"}:e));loadThreads(rpcRef.current).catch(()=>{});desktopNotify("Trebell Code finished",titleOf(activeThread)+" is ready for review.")}
    else if(message.method==="turn/plan/updated"){const plan=(p.plan||[]).map((s,i)=>({id:"plan-"+i,kind:"plan",title:s.step||s.description||s.text||"Plan step",status:s.status==="completed"?"done":s.status==="inProgress"?"running":"pending",raw:s}));setEvents(prev=>[...prev.filter(e=>e.kind!=="plan"),...plan])}
    else if(message.method==="item/started"&&p.item){const item=normalizeItem(p.item);setEvents(prev=>[...prev.filter(e=>e.id!==item.id),item])}
    else if(message.method==="item/completed"&&p.item){if(p.item.type==="agentMessage"&&p.item.text?.trim()){setMessages(prev=>prev.some(m=>m.id===p.item.id)?prev:[...prev,{id:p.item.id,role:"assistant",text:p.item.text,turnId:p.turnId||activeTurnId}]);setAssistantText("")}const item=normalizeItem({...p.item,status:"completed"});setEvents(prev=>prev.some(e=>e.id===item.id)?prev.map(e=>e.id===item.id?{...e,...item}:e):[...prev,item])}
    else if(message.method==="item/agentMessage/delta")setAssistantText(prev=>prev+(p.delta||p.text||""));
    else if(message.method==="item/commandExecution/outputDelta"){const id=p.itemId||"command";setEvents(prev=>prev.map(e=>e.id===id?{...e,output:(e.output||"")+(p.delta||"")}:e))}
    else if(message.method==="item/mcpToolCall/progress")setEvents(prev=>[...prev,{id:"mcp-"+Date.now(),kind:"mcpToolCall",title:p.message||"MCP progress",status:"running",raw:p}]);
    else if(message.method==="turn/diff/updated")setEvents(prev=>[...prev,{id:"diff-"+Date.now(),kind:"fileChange",title:"Workspace diff updated",status:"done",raw:p.diff||p}]);
    else if(message.method==="thread/tokenUsage/updated")setTokenUsage(p.tokenUsage||null);
    else if(message.method==="thread/compacted")setEvents(prev=>[...prev,{id:"compact-"+Date.now(),kind:"tool",title:"Context compacted",status:"done",raw:p}]);
    else if(message.method==="error"){setEvents(prev=>[...prev,{id:"error-"+Date.now(),kind:"error",title:p.message||"Agent error",status:"done",raw:p}]);setRunning(false);desktopNotify("Trebell Code error",p.message||"The agent stopped with an error.")}
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
    if(action==="archive"){await rpc?.request("thread/archive",{threadId:thread.id});setThreads(prev=>prev.filter(t=>t.id!==thread.id));if(activeThread?.id===thread.id)newChat()}
  }
  async function moveThreadOrder(thread,direction){const group=threads.filter(t=>(t.section?.name||"Active")===(thread.section?.name||"Active"));const index=group.findIndex(t=>t.id===thread.id);const targetIndex=index+direction;if(targetIndex<0||targetIndex>=group.length)return;const before=direction<0?group[targetIndex].id:(group[targetIndex+1]?.id||null);await rpc.request("thread/section/move",{threadId:thread.id,sectionId:thread.section?.id||null,beforeThreadId:before});await loadThreads(rpc)}
  async function bulkAction(action){for(const id of selectedThreadIds){const thread=threads.find(t=>t.id===id);if(thread)await threadAction(thread,action)}setSelectedThreadIds(new Set())}

  async function newChat(){setSection("chat");setActiveThread(null);setActiveTurnId(null);setMessages([]);setEvents([]);setAssistantText("");setQueued([]);setPrompt("");setTokenUsage(null);setCheckpointByTurn({})}
  async function openThread(thread){
    setSection("chat");setEvents([]);setAssistantText("");setActiveThread(thread);setProjectPath(thread.cwd||projectPath);if(!rpc||rpcStatus!=="connected")return;
    const [resumed,cp]=await Promise.all([rpc.request("thread/resume",{threadId:thread.id,model:model||null,modelProvider:"freebuff",cwd:thread.cwd||null,excludeTurns:false}).catch(()=>null),api("/api/checkpoints?threadId="+encodeURIComponent(thread.id)).catch(()=>({checkpoints:[]}))]);
    const map=Object.fromEntries((cp.checkpoints||[]).filter(x=>x.turnId).map(x=>[x.turnId,x]));setCheckpointByTurn(map);
    if(resumed?.thread){setActiveThread(resumed.thread);setMessages(historyFromThread(resumed.thread,map));setProjectPath(resumed.thread.cwd||projectPath)}
    const meta=threadMeta[thread.id]||{};setReviewedFiles(meta.reviewedFiles||[]);
  }
  async function reloadActiveThread(){if(activeThread)await openThread(activeThread)}
  async function prepareWorktree(basePath,modelId){
    if(workspaceMode!=="worktree")return basePath;const info=await api("/api/git/info?path="+encodeURIComponent(basePath));if(!info.isGit)throw new Error("New worktree mode requires a Git project.");
    const slug=String(modelId||"model").replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-|-$/g,"").slice(-24)||"agent";const stamp=Date.now().toString(36);const branch="trebell/"+slug+"-"+stamp;const path=info.root+"-trebell-"+slug+"-"+stamp;
    const result=await api("/api/git/action",{method:"POST",body:{action:"worktree-create",cwd:info.root,branch,path,baseBranch:info.branch}});return result.result?.worktree||path;
  }
  async function createThreadFor(modelId,cwd){const p=presetFor(permissionMode);const result=await rpc.request("thread/start",{model:modelId,modelProvider:"freebuff",cwd,approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,ephemeral:false,threadSource:"trebell-code",developerInstructions:webSearch?"Web research is allowed when useful.":"Do not use web search unless the user explicitly requests it."});return result.thread}
  function inputsFor(text,paths){return [{type:"text",text,text_elements:[]},...(paths||[]).map(path=>{const lower=String(path).toLowerCase();if(/\.(png|jpe?g|gif|webp|bmp)$/.test(lower))return{type:"localImage",path};if(/\.(mp3|wav|m4a|ogg|flac)$/.test(lower))return{type:"localAudio",path};return{type:"mention",name:String(path).split(/[\\/]/).pop(),path}})]}
  async function startTurn(text,paths,modelId=model,threadOverride=null,cwdOverride=null){
    if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");let thread=threadOverride||activeThread;let cwd=cwdOverride||projectPath||bootstrap.cwd;
    if(!thread){cwd=await prepareWorktree(cwd,modelId);thread=await createThreadFor(modelId,cwd);setActiveThread(thread);setThreads(prev=>[thread,...prev]);setProjectPath(cwd)}
    const clientId="user-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);setMessages(prev=>[...prev,{id:clientId,role:"user",text}]);setEvents([]);setAssistantText("");setRunning(true);
    const checkpoint=await api("/api/checkpoints",{method:"POST",body:{cwd,threadId:thread.id,label:text.slice(0,80)}}).catch(()=>null);const p=presetFor(permissionMode);
    const sandboxPolicy=p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:{type:"workspaceWrite",writableRoots:[cwd],networkAccess:webSearch,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
    const result=await rpc.request("turn/start",{threadId:thread.id,model:modelId,cwd,approvalPolicy:p.approvalPolicy,sandboxPolicy,input:inputsFor(text,paths)});const turnId=result?.turn?.id||null;setActiveTurnId(turnId);
    setMessages(prev=>prev.map(m=>m.id===clientId?{...m,turnId,checkpointId:checkpoint?.id||null}:m));if(checkpoint?.id&&turnId){await api("/api/checkpoints/link",{method:"POST",body:{id:checkpoint.id,patch:{turnId}}}).catch(()=>{});setCheckpointByTurn(prev=>({...prev,[turnId]:{...checkpoint,turnId}}))}setAttachments([]);return{thread,turnId};
  }
  async function handleSpecial(text){
    if(!text.startsWith("/"))return null;const [command,...rest]=text.split(/\s+/);
    if(command==="/compact"){if(activeThread?.id&&rpc)await rpc.request("thread/compact/start",{threadId:activeThread.id});setEvents(prev=>[...prev,{id:"compact-request",kind:"tool",title:"Compacting context",status:"running",raw:{}}]);return true}
    if(command==="/model"){setSection("freebuff");return true}
    if(command==="/terminal"){setPanel("terminal");return true}
    if(command==="/diff"){setPanel("workspace");return true}
    if(command==="/git"){setSection("source");return true}
    if(command==="/preview"){setSection("preview");return true}
    if(command==="/agents"){setSection("agents");return true}
    if(command==="/new"){await newChat();return true}
    if(command==="/clear"){await newChat();return true}
    if(command==="/plan"){setPrompt("Create a clear execution plan, then carry it out. "+rest.join(" "));return true}
    return false;
  }
  async function send(){
    const text=prompt.trim();if(!text)return;const special=await handleSpecial(text);if(special===true){setPrompt("");return}
    if(running){
      if(settings.followUpMode==="steer"&&rpc&&activeThread&&activeTurnId){await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(text,attachments)});setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text,turnId:activeTurnId}]);setPrompt("");setAttachments([]);return}
      setQueued(prev=>[...prev,{id:crypto.randomUUID(),text,attachments:[...attachments],model}]);setPrompt("");setAttachments([]);return;
    }
    setPrompt("");setPromptHistoryIndex(-1);setSection("chat");
    if(bootstrap.mock||!rpc||rpcStatus!=="connected"){setMessages(prev=>[...prev,{id:"user-"+Date.now(),role:"user",text}]);setRunning(true);try{const d=await api("/api/chat/direct",{method:"POST",body:{prompt:text,model}});setMessages(prev=>[...prev,{id:"assistant-"+Date.now(),role:"assistant",text:d.text||""}]);setEvents([{id:"fallback",kind:"tool",title:"Freebuff direct response",status:"done",raw:{}}])}catch(e){setEvents([{id:"error",kind:"error",title:e.message,status:"done",raw:{}}])}finally{setRunning(false);setAttachments([])}return}
    if(!activeThread&&selectedModels.length>1){
      const info=await api("/api/git/info?path="+encodeURIComponent(projectPath));if(!info.isGit){setEvents([{id:"multi-error",kind:"error",title:"Multi-model fan-out requires a Git project so each model gets its own worktree.",status:"done",raw:{}}]);return}
      const created=[];for(const id of selectedModels){const cwd=await prepareWorktree(projectPath,id);const thread=await createThreadFor(id,cwd);created.push(thread);await startTurn(text,attachments,id,thread,cwd)}setThreads(prev=>[...created,...prev.filter(t=>!created.some(c=>c.id===t.id))]);if(created[0])await openThread(created[0]);return;
    }
    await startTurn(text,attachments,model).catch(e=>{setRunning(false);setEvents([{id:"send-error",kind:"error",title:e.message,status:"done",raw:{}}])});
  }
  async function sendQueuedNow(item){setQueued(prev=>prev.filter(q=>q.id!==item.id));if(running&&rpc&&activeThread&&activeTurnId){await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(item.text,item.attachments)});setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.text,turnId:activeTurnId}])}else await startTurn(item.text,item.attachments,item.model||model)}
  async function stop(){if(rpc&&activeThread?.id&&activeTurnId)await rpc.request("turn/interrupt",{threadId:activeThread.id,turnId:activeTurnId}).catch(()=>{});const returned=queued.map(q=>q.text).join("\n\n");if(returned)setPrompt(prev=>prev?prev+"\n\n"+returned:returned);setQueued([]);setRunning(false)}
  async function editFromHere(message){if(!rpc||!activeThread?.id||!message.turnId)return;const restoreFiles=confirm("Also restore workspace files to the checkpoint before this turn?\n\nOK = conversation + files\nCancel = conversation only");if(restoreFiles&&message.checkpointId)await api("/api/checkpoints/restore",{method:"POST",body:{id:message.checkpointId}}).catch(e=>alert(e.message));await rpc.request("thread/revert",{threadId:activeThread.id,beforeTurnId:message.turnId});setPrompt(message.text);await reloadActiveThread()}
  async function stashPrompt(){if(prompt.trim()||attachments.length){await api("/api/stashes",{method:"POST",body:{text:prompt,attachments,projectPath}});setPrompt("");setAttachments([]);return}const d=await api("/api/stashes").catch(()=>({stashes:[]}));const stash=d.stashes?.[0];if(stash){setPrompt(stash.text||"");setAttachments(stash.attachments||[]);await api("/api/stashes?id="+encodeURIComponent(stash.id),{method:"DELETE"})}}
  async function addFiles(paths){setAttachments(prev=>[...new Set([...prev,...paths])].slice(0,8))}
  async function pickFiles(){const p=await window.trebellDesktop?.pickFiles?.();if(p?.length){await addFiles(p);return p}return[]}
  async function blobAttachment(file){const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=reject;reader.readAsDataURL(file)});return api("/api/attachments/blob",{method:"POST",body:{name:file.name,mime:file.type,dataBase64:data}})}
  async function onPaste(e){const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();const uploaded=[];for(const f of files.slice(0,8-attachments.length)){try{uploaded.push((await blobAttachment(f)).path)}catch{}}await addFiles(uploaded);return}const text=e.clipboardData?.getData("text/plain")||"";if(text.length>=32768){e.preventDefault();const d=await api("/api/attachments/text",{method:"POST",body:{name:"pasted-context.txt",text}});await addFiles([d.path])}}
  async function onDrop(e){e.preventDefault();const files=[...(e.dataTransfer?.files||[])];const uploaded=[];for(const f of files.slice(0,8-attachments.length)){try{uploaded.push((await blobAttachment(f)).path)}catch{}}await addFiles(uploaded)}
  async function attachExcerpt(text){if(!text.trim())return;const d=await api("/api/attachments/text",{method:"POST",body:{name:"terminal-context.txt",text}});await addFiles([d.path]);setPanel(null)}
  async function citeAssistant(message){
    if(!message?.text?.trim())return;
    const text=["Assistant response citation",activeThread?.name||activeThread?.id||"current thread","",message.text].join("\n");
    const d=await api("/api/attachments/text",{method:"POST",body:{name:"assistant-citation.txt",text}});
    await addFiles([d.path]);
    setPrompt(prev=>(prev?prev+" ":"")+"Use the attached assistant citation as context. ");
  }
  async function attachReviewComment(path,comment){
    const text=["Code review comment","File: "+path,"",comment].join("\n");
    const d=await api("/api/attachments/text",{method:"POST",body:{name:"review-"+String(path).split(/[\\/]/).pop()+".txt",text}});
    await addFiles([d.path]);
    setPrompt(prev=>(prev?prev+" ":"")+"Address the attached review comment. ");
    setPanel(null);setSection("chat");
  }
  async function attachPr(pr){const text=["Pull request #"+pr.number+": "+pr.title,pr.url,pr.headRefName+" -> "+pr.baseRefName,pr.body||""].join("\n");const d=await api("/api/attachments/text",{method:"POST",body:{name:"pr-"+pr.number+".txt",text}});await addFiles([d.path]);setSection("chat")}
  async function linkPr(pr){
    if(!activeThread?.id)return;
    const current=threadMeta[activeThread.id]?.linkedPullRequests||[];
    const exists=current.some(x=>x.number===pr.number&&x.url===pr.url);
    const next=exists?current.filter(x=>!(x.number===pr.number&&x.url===pr.url)):[...current,{number:pr.number,title:pr.title,url:pr.url,state:pr.state,headRefName:pr.headRefName,baseRefName:pr.baseRefName}];
    await updateThreadMeta(activeThread.id,{linkedPullRequests:next});
  }
  async function toggleReviewed(path,value){const next=value?[...new Set([...reviewedFiles,path])]:reviewedFiles.filter(x=>x!==path);setReviewedFiles(next);if(activeThread?.id)await updateThreadMeta(activeThread.id,{reviewedFiles:next})}
  function resolveApproval(request,decision){if(!rpc)return;let result={decision};if(request.method==="item/permissions/requestApproval")result={permissions:request.params?.permissions||{},scope:decision==="acceptForSession"?"session":"turn"};rpc.respond(request.id,result);setApprovals(prev=>prev.filter(x=>x.id!==request.id))}
  async function answerQuestion(answers,files){if(!question)return;const result={};for(const q of question.request.params?.questions||[]){const values=[...(answers[q.id]||[])];if(files.length)values.push("Attached files: "+files.join(", "));result[q.id]={answers:values}}question.client.respond(question.request.id,{answers:result});setQuestion(null)}
  function cancelQuestion(){if(question){question.client.respond(question.request.id,{answers:{}});setQuestion(null)}}
  async function login(){await fetch("/api/login/start",{method:"POST"}).catch(()=>{});const poll=setInterval(async()=>{const data=await api("/api/bootstrap").catch(()=>null);if(data?.loggedIn){clearInterval(poll);setBootstrap(data);const d=await api("/api/models").catch(()=>({models:[]}));const ids=(d.models||[]).filter(x=>x.startsWith("freebuff/"));setModels(ids);if(ids[0]){setModel(ids[0]);setSelectedModels([ids[0]])}refreshFreebuff(ids[0]||model)}},1500);setTimeout(()=>clearInterval(poll),120000)}
  async function logout(){await api("/api/logout",{method:"POST"});setBootstrap(prev=>({...prev,loggedIn:false}));setModels([]);setModel("");setFreebuff({loggedIn:false})}
  async function renameThread(){if(!rpc||!activeThread)return;const name=prompt("Rename thread",titleOf(activeThread));if(!name?.trim())return;await rpc.request("thread/name/set",{threadId:activeThread.id,name:name.trim()});setActiveThread(prev=>({...prev,name:name.trim()}));setThreads(prev=>prev.map(t=>t.id===activeThread.id?{...t,name:name.trim()}:t))}
  async function shareThread(){const text=messages.map(m=>(m.role==="user"?"You":"Trebell Code")+": "+m.text).join("\n\n");if(text)await navigator.clipboard?.writeText(text).catch(()=>{})}
  async function onProjectOpen(path){await touchProject(path);setSection("chat");if(rpcStatus==="connected")loadSkills(rpc,path)}
  function onSkill(skill){setPrompt(prev=>(prev?prev+" ":"")+"$"+skill.name+" ")}

  const activeTitle=titleOf(activeThread);

  return <div className="app-shell">
    <ThreadSidebar section={section} setSection={setSection} threads={displayThreads} activeThreadId={activeThread?.id} query={query} setQuery={setQuery} onOpen={openThread} onNew={newChat} onThreadAction={threadAction} onMove={moveThreadOrder} selectedIds={selectedThreadIds} setSelectedIds={setSelectedThreadIds} onBulkAction={bulkAction}/>
    <main className="main-frame">
      <div className="window-bar"><span>{rpcStatus==="connected"?"Local harness connected":rpcStatus}</span><div><button onClick={()=>window.trebellDesktop?.minimize?.()}>—</button><button onClick={()=>window.trebellDesktop?.maximize?.()}>□</button><button className="window-close" onClick={()=>window.trebellDesktop?.close?.()}>×</button></div></div>
      {(section==="chat"||section==="new")&&<>
        <div className="topbar"><div className="task-icon"><Code2 size={24}/></div><div className="task-title"><div><strong>{activeTitle}</strong><button className="ghost-icon" onClick={renameThread}><WandSparkles size={14}/></button></div><span>{gitInfo?.isGit?(gitInfo.branch||"detached")+" · ":""}{running?"Agent working":"Ready"} · {tokenLabel(tokenUsage)}</span>{activeThread?.id&&(threadMeta[activeThread.id]?.linkedPullRequests||[]).length>0&&<div className="linked-prs">{threadMeta[activeThread.id].linkedPullRequests.map(pr=><button key={pr.url} onClick={()=>window.open(pr.url,"_blank")}><GitBranch size={10}/> #{pr.number}</button>)}</div>}</div><div className="top-actions"><button className="btn secondary" onClick={shareThread}><Link2 size={14}/> Copy thread</button><button className="icon-btn" onClick={()=>setPanel("workspace")}><FileCode2 size={15}/></button>{running&&<button className="btn stop" onClick={stop}><CircleStop size={14}/> Stop</button>}</div></div>
        <div className="conversation-scroll"><Conversation messages={messages} onEditFromHere={editFromHere} onCite={citeAssistant}/><ActivityTimeline events={events} assistantText={assistantText} onOpenPanel={setPanel}/>
          {queued.map(item=><div className="queued-message" key={item.id}><span>Queued</span><p>{item.text}</p><button onClick={()=>sendQueuedNow(item)}>Send now</button><button onClick={()=>{setPrompt(item.text);setAttachments(item.attachments);setQueued(prev=>prev.filter(x=>x.id!==item.id))}}>Edit</button></div>)}
          {!messages.length&&!events.length&&<div className="welcome"><div className="welcome-orb"><Sparkles size={27}/></div><h1>What should Trebell build?</h1><p>Freebuff supplies the model. Codex supplies the local agent harness: files, shell, Git, approvals, skills, MCP and durable threads.</p><div className="suggestions"><button onClick={()=>setPrompt("Inspect this project and explain the architecture.")}>Explain codebase</button><button onClick={()=>setPrompt("Find a useful bug, fix it, and run the relevant tests.")}>Fix a bug</button><button onClick={()=>setPrompt("Implement the next missing feature and validate it end-to-end.")}>Ship a feature</button></div></div>}
        </div>
        <Composer prompt={prompt} setPrompt={setPrompt} onSend={send} running={running} loggedIn={bootstrap.loggedIn||bootstrap.mock} login={login} models={models} model={model} setModel={setModel} selectedModels={selectedModels} setSelectedModels={setSelectedModels} freebuff={freebuff} attachments={attachments} onRemoveAttachment={path=>setAttachments(prev=>prev.filter(x=>x!==path))} onPickFiles={pickFiles} onPaste={onPaste} onDrop={onDrop} permissionMode={permissionMode} setPermissionMode={setPermissionMode} webSearch={webSearch} setWebSearch={setWebSearch} skills={skills} onSkill={onSkill} onFiles={()=>setPanel("workspace")} settings={settings} onStash={stashPrompt} tokenUsage={tokenUsage} workspaceMode={workspaceMode} setWorkspaceMode={setWorkspaceMode}/>
      </>}
      {section==="projects"&&<div className="secondary-page"><h1>Projects</h1><p>Local repositories and workspaces owned by this machine.</p><ProjectsPage currentPath={projectPath} onOpen={onProjectOpen} models={models}/></div>}
      {section==="source"&&<div className="secondary-page full"><h1>Source Control</h1><p>Branch, commit, worktree and pull-request actions execute locally.</p><SourceControlPanel projectPath={projectPath} model={model} onProjectChange={onProjectOpen} onAttachPr={attachPr} onLinkPr={linkPr} linkedPullRequests={activeThread?.id?(threadMeta[activeThread.id]?.linkedPullRequests||[]):[]}/></div>}
      {section==="agents"&&<div className="secondary-page"><h1>Agents</h1><p>Delegated Codex subagent threads.</p><AgentsPage threads={threads} activeThread={activeThread} onOpen={openThread}/></div>}
      {section==="preview"&&<div className="secondary-page full"><h1>Preview</h1><p>Preview local development servers or web pages beside the agent.</p><PreviewPage/></div>}
      {section==="templates"&&<div className="secondary-page"><h1>Templates</h1><p>Real prompts that start normal Trebell turns.</p><div className="template-grid">{[["Ship a feature","Inspect the project, plan a useful feature, implement it, run the relevant tests, fix failures, and summarize the result."],["Fix a bug","Reproduce a meaningful bug in this project, diagnose it, fix it, and validate the fix."],["Review codebase","Map this codebase architecture, important execution paths, risks, and highest-value improvements."],["Refactor safely","Choose a worthwhile refactor, preserve behavior, implement focused changes, and run tests."],["Autonomous build","Take this project to a working validated result. Continue through implementation and test failures until it passes."],["Security review","Review this project for concrete security weaknesses and propose or implement safe fixes."]].map(([name,text])=><button key={name} onClick={()=>{setPrompt(text);setSection("chat")}}><BrainCircuit size={20}/><strong>{name}</strong><span>{text}</span></button>)}</div></div>}
      {section==="freebuff"&&<div className="secondary-page"><h1>Freebuff</h1><p>Live account, model, Freebucks and session state.</p><FreebuffPage freebuff={freebuff} model={model} onRefresh={()=>refreshFreebuff(model)}/></div>}
      {section==="settings"&&<div className="secondary-page full"><h1>Settings</h1><p>Client, project and runtime preferences.</p><SettingsPage settings={settings} onSettings={setSettings} runtime={runtime} rpcStatus={rpcStatus} loggedIn={bootstrap.loggedIn||bootstrap.mock} login={login} logout={logout} projectPath={projectPath}/></div>}
      {section==="history"&&<div className="secondary-page"><h1>Thread history</h1><p>Every unarchived Freebuff-backed Codex thread on this machine.</p><div className="history-page">{threads.map(t=><button key={t.id} onClick={()=>openThread(t)}><FileCode2 size={15}/><div><strong>{titleOf(t)}</strong><span>{t.preview||t.cwd}</span></div><time>{new Date(t.updatedAt*1000).toLocaleString()}</time></button>)}</div></div>}
    </main>
    <aside className="right-rail">
      <div className="agent-card"><div className={"orb "+(running?"orb-active":"")}></div><div><strong>Trebell Agent</strong><span><i className={rpcStatus==="connected"?"online":""}/>{running?"Active":rpcStatus==="connected"?"Ready":"Fallback"}</span></div></div>
      <div className="progress-card"><div><strong>{running?"Working on it…":"Task progress"}</strong><span>{events.filter(e=>e.status==="done").length} / {events.length||1}</span></div><div className="progress-track"><i style={{width:(events.length?events.filter(e=>e.status==="done").length/events.length*100:8)+"%"}}/></div><p>{events.find(e=>e.status==="running")?.title||events.at(-1)?.title||"Waiting for a task"}</p></div>
      <ApprovalCard request={approvals[0]} onResolve={resolveApproval}/>
      <FreebuffMini freebuff={freebuff} model={model} onOpen={()=>setSection("freebuff")}/>
      <div className="stats-card"><div className="stat-row"><Cpu size={15}/><span>CPU</span><strong>{stats.cpu||"—"}</strong></div><div className="stat-row"><MemoryStick size={15}/><span>Memory</span><strong>{stats.memory||"—"}</strong></div><div className="stat-row"><HardDrive size={15}/><span>Disk</span><strong>{stats.disk||"—"}</strong></div><div className="stat-row"><Network size={15}/><span>Runtime</span><strong>{rpcStatus}</strong></div></div>
      <div className="tools-card"><div className="tools-head"><strong>Workspace</strong><ChevronDown size={14}/></div><button onClick={()=>setPanel("terminal")}><SquareTerminal size={16}/><span>Terminal</span><i className="tool-live"/></button><button onClick={()=>setPanel("workspace")}><FolderCode size={16}/><span>Files & diff</span><i className="tool-live"/></button><button onClick={()=>setSection("source")}><GitBranch size={16}/><span>Source control</span><i className="tool-live"/></button><button onClick={()=>setSection("preview")}><Globe2 size={16}/><span>Preview</span><i className="tool-live"/></button></div>
      <div className="privacy-line"><span/><b>Local harness</b> · Freebuff inference</div>
    </aside>
    {panel&&<div className="drawer wide" data-testid="drawer"><div className="drawer-head"><strong>{panel==="terminal"?"Terminal":"Workspace"}</strong><button onClick={()=>setPanel(null)}><X size={17}/></button></div>{panel==="terminal"?<TerminalPanel projectPath={projectPath} onAttachExcerpt={attachExcerpt}/>:<WorkspacePanel projectPath={projectPath} activeThreadId={activeThread?.id} reviewedFiles={reviewedFiles} onReviewedChange={toggleReviewed} onAttachPath={path=>addFiles([path])} onReviewComment={attachReviewComment}/>}</div>}
    <QuestionModal request={question?.request} onSubmit={answerQuestion} onCancel={cancelQuestion} pickFiles={pickFiles}/>
  </div>;
}
