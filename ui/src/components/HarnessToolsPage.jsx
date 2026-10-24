import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import { Blocks, Brain, CheckCircle2, ChevronRight, FlaskConical, PlugZap, RefreshCw, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { api } from "../api.js";
import { openWebLink } from "../web-link.js";
import { agentName, countLabel, failureText, humanizeIdentifier, importFailures, importResultSummary, listCount, mcpAuthLabel } from "../display-labels.js";
import { formatBytes } from "../format-bytes.js";
import { allowedWindowsSetupModes, windowsSandboxStatus, worldWritableWarningText } from "../windows-sandbox.js";
import { askConfirm } from "../ask-dialog.js";
import { ignorePressRest } from "./ThreadSidebar.jsx";

// What each runtime read on this page loads, so its error line names what could not be loaded before the reason Codex gave.
const LOAD_FAILURES={
  "permissionProfile/list":"Could not load permission profiles","mcpServerStatus/list":"Could not load MCP servers","plugin/list":"Could not load the plugin catalog",
  "app/list":"Could not load app connectors","app/installed":"Could not load installed apps","hooks/list":"Could not load hooks",
  "experimentalFeature/list":"Could not load experimental features","plugin/share/list":"Could not load shared plugins","thread/loaded/list":"Could not list loaded sessions",
  "modelProvider/capabilities/read":"Could not load provider capabilities","account/read":"Could not load the account","account/rateLimits/read":"Could not load rate limits",
  "account/usage/read":"Could not load account usage","config/read":"Could not load the configuration","configRequirements/read":"Could not load configuration requirements",
  "memory/status":"Could not load memory readiness","server/diagnostics":"Could not load process diagnostics","externalAgentConfig/import/readHistories":"Could not load the import history",
  "windowsSandbox/readiness":"Could not check Windows sandbox readiness",
};
const loadFailure=(name,error)=>failureText(LOAD_FAILURES[name]||"Could not load "+name,error);
const pluginLabel=plugin=>plugin?.interface?.displayName||plugin?.name||plugin?.id||"the plugin";
const shareId=item=>item?.plugin?.remotePluginId||item?.plugin?.shareContext?.remotePluginId;
const listedPlugin=(marketplaces,id)=>marketplaces.flatMap(m=>m.plugins||[]).find(item=>item.id===id);
// The action running on the page (what busy names) and the page drawn now, kept outside the page as the server keeps a harness
// install: a page drawn again while an action runs (back from Settings or another page) says so on the action's button, with its
// other actions waiting, so a second press sends nothing until the action lands; it then reads Codex again and says why the action
// failed, as the page that sent it would. The action went with the page that sent it, so the page drawn again offered every action,
// a second Share privately shared again, and once the action was done the page drawn again still offered it.
let running="",shown=null;
// How the lists show each action done (shareDone, read by refresh), kept with the action outside the page too.
const shareDone={};
// What an action says while no page is shown (a refusal that lands while Settings shows), kept for the next page drawn, which says
// it and keeps it through its first read of Codex, as the read once Codex is back keeps what the actions said: it was said nowhere.
// And what Codex runs once its request has answered, until it says it is done: a Windows sandbox setup (setup) and an agent
// configuration import (importing), on the connection they were started on, as one dropped since may never say so. A page drawn
// again meanwhile waits for them as the page that started them does: it offered a second setup, which can raise a second
// elevation prompt, and a second import, and passed over the first one's end. And what a history import did (told), which the next
// page drawn says once it has scanned the history again: the page drawn after showed only Scan history.
let said={},setup={},importing={},told=null;
window.addEventListener("trebell:windows-sandbox-setup",event=>{setup={};if(!shown)said={...said,"windowsSandbox/setupStart":event.detail?.success?null:failureText("Windows sandbox setup failed",event.detail?.error)}});

// A header badge is a bare count, or a label that says what it counts when the card lists more than one kind of row.
function Section({title,icon:Icon,count,badge,children}){
  return <section className="capability-card"><div className="capability-card-head"><span><Icon size={15}/><strong>{title}</strong></span>{badge?<em>{badge}</em>:Number.isFinite(count)&&<em>{count}</em>}</div>{children}</section>;
}
function ErrorLine({value}){return value?<p className="capability-error">{value}</p>:null}
// The button of an action Codex answers. While Codex answers it, it says what it is doing (doing), marked busy, and only says it is
// off (aria-disabled), so the keyboard stays on it: disabled, it dropped the focus on the page. A press meanwhile does nothing, nor
// does the rest of the press that started it (Enter held, a double click's second click), as a thread's menu item runs. While any
// action runs (busy) the page's other actions wait.
function ActionButton({busy,doing,off=false,onPress,children}){
  return <button onClick={event=>{ignorePressRest(!event.detail);if(!busy)onPress()}} disabled={!doing&&(off||!!busy)} aria-disabled={doing?true:undefined} aria-busy={doing?true:undefined}>{doing||children}</button>;
}
// A card's empty state. It claims the runtime reported nothing only for an answer that has loaded empty; while a read is in flight
// the card says it is loading, and beside an error line, which says why the answer is missing, it says nothing.
function EmptyState({loaded,loading,error,pending,children}){
  if(error)return null;
  if(loading)return <p aria-busy="true">{pending}</p>;
  return loaded&&children?<p>{children}</p>:null;
}
function ImportFailureList({failures}){
  return <ul className="import-failure-list" aria-label="Import failures">{failures.map((failure,index)=><li key={index}><strong>{failure.type}</strong><span>{failure.message}{failure.stage?" · "+failure.stage+" stage":""}</span></li>)}</ul>;
}
function titleCaseWords(value){
  return String(value||"").trim().split(/[-_\s]+/).filter(Boolean).map(part=>part.slice(0,1).toUpperCase()+part.slice(1)).join(" ");
}
function shortConfigVersion(value){
  const version=String(value||"").trim();
  return version.startsWith("sha256:")&&version.length>24?version.slice(0,20)+"…":version;
}
function configLayerPresentation(layer,index){
  const rawName=layer?.name;
  let label="",file="",profile="";
  if(typeof rawName==="string")label=rawName.trim();
  else if(rawName&&typeof rawName==="object"){
    const type=titleCaseWords(rawName.type);
    label=type?type+" config":"";
    file=String(rawName.file||"").trim().replace(/\\/g,"/").split("/").filter(Boolean).at(-1)||"";
    profile=String(rawName.profile||"").trim();
  }
  if(!label)label="Configuration layer "+(index+1);
  const version=shortConfigVersion(layer?.version);
  const detail=[profile?"profile "+profile:"",file,version?"version "+version:""].filter(Boolean).join(" · ");
  return {label,detail:String(layer?.disabledReason||detail||"Loaded")};
}

// skillsLoad says where the app's skills list stands ({status:"loading"|"loaded"|"failed"|"idle",error}), as `skills` alone cannot
// tell a list that loaded empty from one still loading or one that failed.
export default function HarnessToolsPage({rpc,rpcStatus,projectPath,activeThread,skills=[],skillsLoad={status:"loaded",error:null},onHistoryImported,onSkillsRefresh,onSkillsReload,platform=""}){
  // Each runtime list stays null until its first answer, so a card tells a list that loaded empty from one not loaded yet.
  const [data,setData]=useState({permissions:null,mcp:null,marketplaces:null,apps:null,installedApps:null,hooks:null,features:null,sharedPlugins:null,loadedThreads:null,loadedThreadsMore:false,capabilities:null,account:null,rateLimits:null,usage:null,config:null,requirements:null,memory:null,diagnostics:null,windowsSandbox:null});
  const [errors,showErrors]=useState({});
  // The page loads as it opens, so it starts out loading: the first paint already waits for the runtime's answers.
  const [loading,setLoading]=useState(true);
  const refreshRun=useRef(0);
  // Whether the page has shown its not-connected state since its last refresh. The refresh run as Codex is back reads the lists again
  // but keeps what the actions said, so an action the dropped connection cut off is told once the page is back. A dropped connection
  // loses only Codex's answer, so that refresh drops the line of an action the list read again shows done (shareDone holds, for each
  // such action's line, the read that lists it and how that list shows the action done: a plugin shared, installed or uninstalled, a
  // marketplace removed, or a shared plugin checked out, its visibility set or its share deleted): the line said it failed beside a
  // row that showed it done, as Lane G Local offered Update share under "Could not share Lane G Local: Codex disconnected". A page's
  // first read keeps them too: the lines said while no page was shown (said).
  const away=useRef(true);
  // The control an action was pressed on keeps the keyboard while Codex answers it (ActionButton). One the action took away with the
  // keyboard still on it hands the keyboard on, as a thread's row does, instead of dropping it on the page, and leaves the page where
  // the person has scrolled it meanwhile: a Checkout once checked out to the control now in its place in its row, and the row of a
  // deleted share or of a removed marketplace to the first control of the row after it, or of the one before (in Remove's place
  // there stood the next marketplace's Remove, which removes at once). A control pressed with the mouse (its focus not shown), or one
  // the person moved the focus from meanwhile, to blank page space too, leaves the focus where it falls: the select in the place of a
  // Checkout clicked with the mouse took it, with its focus ring. On a page drawn again while an action runs, the control the keyboard
  // comes to (onFocus, its focus shown) stands for the one pressed: Removing… reached with Tab dropped the keyboard on the page as its
  // row went, as only the page that sent the Remove knew where the keyboard was.
  const [busy,showBusy]=useState(()=>running),pressed=useRef(null);
  // This page as an action reaches it (running, shown): one pressed on a page since gone says what it does, and reads Codex again, on
  // the page drawn now (page), and a refresh the page gone had under way lands on nothing. With no page shown, its lines wait (said).
  const self=useRef({}).current;
  const page=()=>self.gone?shown:self,setErrors=update=>{const to=page();if(to)to.showErrors(update);else said=update(said)};
  useEffect(()=>{self.gone=false;shown=self;showBusy(running);if(Object.keys(said).length){const lines=said;said={};showErrors(prev=>({...prev,...lines}))}if(told){const line=told;told=null;tell(line,true)}return()=>{self.gone=true;if(shown===self)shown=null}},[]);
  const hold=node=>{
    const row=node?.closest?.(".capability-list>div");
    if(!self.gone&&row&&!pressed.current&&node.matches(":focus-visible")){
      const from=pressed.current={node,row,list:row.parentElement,at:[...row.parentElement.children].indexOf(row),index:[...row.querySelectorAll("button,select")].indexOf(node)};
      // The focus moved off the control while it is still on the page is the person's; moved back, it is the keyboard's again. Read
      // once the event is over: Chromium fires focusout on the control as it is taken away, still on the page then.
      from.note=()=>queueMicrotask(()=>{from.left=node.isConnected&&document.activeElement!==node});
      for(const type of ["focusin","focusout"])node.addEventListener(type,from.note);
    }
  };
  const setBusy=value=>{if(value)hold(document.activeElement);running=value;page()?.showBusy(value)};
  useLayoutEffect(()=>{
    const from=pressed.current;if(busy||!from)return;pressed.current=null;
    for(const type of ["focusin","focusout"])from.node.removeEventListener(type,from.note);
    if(from.left||from.node.isConnected||document.activeElement!==document.body)return;
    const stays=from.row.isConnected,row=stays?from.row:from.list.children[from.at]||from.list.children[from.at-1],controls=row?[...row.querySelectorAll("button,select")]:[];
    (stays?controls[from.index]||controls.at(-1):controls[0])?.focus({preventScroll:true});
  },[busy]);
  const [marketplaceSource,setMarketplaceSource]=useState("");
  const [migrations,setMigrations]=useState(null);
  const [migrationHistory,setMigrationHistory]=useState({data:[],connectors:[]});
  const [migrationMessage,setMigrationMessage]=useState("");
  const [migrationFailures,setMigrationFailures]=useState([]);
  const [migrationImportId,showImport]=useState(()=>importing.rpc===rpc&&importing.id||null);
  const setMigrationImportId=id=>{importing=id?{id,rpc}:{};page()?.showImport(id)};
  const [historyImport,setHistoryImport]=useState(null);
  // Whether the latest history scan failed. Sessions an earlier scan listed stay on screen beside the failure, but an earlier
  // empty answer is not claimed there.
  const [historyScanFailed,setHistoryScanFailed]=useState(false);
  const [historyMessage,setHistoryMessage]=useState("");
  const historyMessageRef=useRef(null);
  const [mcpResult,setMcpResult]=useState(null);
  const [appDetail,setAppDetail]=useState(null);
  const [toolArgs,setToolArgs]=useState({});
  useEffect(()=>{
    if(!historyMessage||!/failed|could not|error/i.test(historyMessage))return;
    const frame=requestAnimationFrame(()=>historyMessageRef.current?.scrollIntoView({block:"center"}));
    return()=>cancelAnimationFrame(frame);
  },[historyMessage]);
  const [memoryMessage,setMemoryMessage]=useState("");
  const [memoryResetArmed,setMemoryResetArmed]=useState(false);
  const [sandboxPending,showSandbox]=useState(()=>setup.rpc===rpc&&setup.mode||"");
  const setSandboxPending=mode=>{setup=mode?{mode,rpc}:{};page()?.showSandbox(mode)};
  const [sandboxMessage,setSandboxMessage]=useState("");
  const [sandboxWarning,setSandboxWarning]=useState("");
  const [skillRootsText,setSkillRootsText]=useState("");
  const [skillMessage,setSkillMessage]=useState("");
  const [pluginSearchTerm,setPluginSearchTerm]=useState("");
  const [pluginSearchScope,setPluginSearchScope]=useState("global");
  const [pluginSearchResults,setPluginSearchResults]=useState([]);
  const [pluginSearchCursor,setPluginSearchCursor]=useState(null);
  const [pluginSearchRan,setPluginSearchRan]=useState(false);
  const [pluginDetail,setPluginDetail]=useState(null);
  const [pluginSkillDetail,setPluginSkillDetail]=useState(null);
  const [pluginMessage,setPluginMessage]=useState("");
  const [configWarnings,setConfigWarnings]=useState([]);
  const [runtimeNotices,setRuntimeNotices]=useState([]);
  const [hookRuns,setHookRuns]=useState([]);
  const [authRecovery,setAuthRecovery]=useState(null);
  const [modelNotices,setModelNotices]=useState([]);
  Object.assign(self,{showBusy,showErrors,refresh,showSandbox,showImport,scanHistory,setHistoryMessage,setHistoryImport,setHistoryScanFailed});

  function routedParams(params){
    const threadId=activeThread?.id;
    if(!threadId)return params;
    return {...(params&&typeof params==="object"&&!Array.isArray(params)?params:{}),_trebellThreadId:threadId};
  }
  async function request(name,params){return rpc.request(name,routedParams(params))}
  async function call(name,params){
    try{return await request(name,params)}
    catch(error){showErrors(prev=>({...prev,[name]:loadFailure(name,error)}));return null}
  }
  async function refresh(){
    if(page()!==self)return page()?.refresh();
    // Not connected, the page shows no cards. It waits as loading, so as Codex connects the cards say what is loading rather than
    // that the runtime reported nothing, and a refresh begun on a connection that has since closed does not land.
    if(!rpc||rpcStatus!=="connected"){refreshRun.current++;away.current=true;setLoading(true);return}
    // Only the latest refresh lands: one started for an earlier thread or project neither writes its answers nor ends loading.
    const run=++refreshRun.current,latest=()=>run===refreshRun.current,back=away.current;away.current=false;
    setLoading(true);showErrors(prev=>back?Object.fromEntries(Object.entries(prev).filter(([name])=>!LOAD_FAILURES[name])):{});
    const threadId=activeThread?.id||null;
    const load=(name,params)=>request(name,params).catch(error=>{if(latest())showErrors(prev=>({...prev,[name]:loadFailure(name,error)}));return null});
    const [permissions,mcp,plugins,apps,installedApps,hooks,features,sharedPlugins,loadedThreads,capabilities,account,rateLimits,usage,config,requirements,memory,diagnostics,importHistories,windowsSandbox]=await Promise.all([
      load("permissionProfile/list",{limit:100,cwd:projectPath||null}),
      load("mcpServerStatus/list",{limit:100,detail:"full",threadId}),
      load("plugin/list",{cwds:projectPath?[projectPath]:[],forceRefetch:false}),
      load("app/list",{limit:100,threadId,forceRefetch:false}),
      load("app/installed",{threadId,forceRefresh:false}),
      load("hooks/list",{cwds:projectPath?[projectPath]:[]}),
      load("experimentalFeature/list",{limit:200,threadId}),
      load("plugin/share/list",{}),
      load("thread/loaded/list",{limit:100}),
      load("modelProvider/capabilities/read",{}),
      load("account/read",{refreshToken:false}),
      load("account/rateLimits/read",{excludeResetCreditDetails:true}),
      load("account/usage/read",threadId?{threadId}:{}),
      load("config/read",{includeLayers:true,cwd:projectPath||null}),
      load("configRequirements/read",{}),
      load("memory/status",{minConsolidatedThreads:20}),
      load("server/diagnostics",{}),
      load("externalAgentConfig/import/readHistories",{}),
      platform==="win32"?load("windowsSandbox/readiness",undefined):Promise.resolve(null),
    ]);
    if(!latest())return;
    if(back){
      const catalog=plugins&&(plugins.marketplaces||[]),listed={"plugin/list":catalog,"plugin/share/list":sharedPlugins&&(sharedPlugins.data||[])};
      showErrors(prev=>Object.fromEntries(Object.entries(prev).filter(([name])=>{const [read,done]=shareDone[name]||[];return !(listed[read]&&done(listed[read]))})));
      // A search result shows its plugin installed or not as the catalog read again does, so an Install cut off shows done there too.
      if(catalog)setPluginSearchResults(current=>current.map(result=>{const item=listedPlugin(catalog,result.plugin?.id);return item?{...result,plugin:{...result.plugin,installed:item.installed}}:result}));
    }
    setData(current=>({
      ...current,
      ...(permissions!==null?{permissions:permissions?.data||[]}:{}),
      ...(mcp!==null?{mcp:mcp?.data||[]}:{}),
      ...(plugins!==null?{marketplaces:plugins?.marketplaces||[]}:{}),
      ...(apps!==null?{apps:apps?.data||[]}:{}),
      ...(installedApps!==null?{installedApps:installedApps?.apps||[]}:{}),
      ...(hooks!==null?{hooks:hooks?.data||[]}:{}),
      ...(features!==null?{features:features?.data||[]}:{}),
      ...(sharedPlugins!==null?{sharedPlugins:sharedPlugins?.data||[]}:{}),
      ...(loadedThreads!==null?{loadedThreads:loadedThreads?.data||[],loadedThreadsMore:Boolean(loadedThreads?.nextCursor)}:{}),
      ...(capabilities!==null?{capabilities}:{}),
      ...(account!==null?{account}:{}),
      ...(rateLimits!==null?{rateLimits}:{}),
      ...(usage!==null?{usage}:{}),
      ...(config!==null?{config}:{}),
      ...(requirements!==null?{requirements:requirements?.requirements||null}:{}),
      ...(memory!==null?{memory}:{}),
      ...(diagnostics!==null?{diagnostics}:{}),
      ...(platform==="win32"&&windowsSandbox!==null?{windowsSandbox}:{}),
    }));
    // An import Codex lists done ended while no page was shown to hear it end. One started on a connection since gone, and a setup,
    // end where no page hears them: the page waits no more, as a page drawn since does, and says their end is unknown unless what it
    // read shows them done (the import listed, the sandbox ready). The page that stayed waited for good.
    if(importHistories)setMigrationHistory({data:importHistories.data||[],connectors:importHistories.connectors||[]});
    const ended=!!importing.id&&!!importHistories?.data?.some(entry=>entry.importId===importing.id),unknown=what=>`Codex disconnected before reporting how the ${what} ended, so it may still be running.`;
    if(ended||importing.rpc&&importing.rpc!==rpc){setMigrationImportId(null);setMigrationMessage(ended?"":unknown("agent configuration import"))}
    if(setup.rpc&&setup.rpc!==rpc){setSandboxMessage(windowsSandbox?.status==="ready"?"":unknown(setup.mode+" Windows sandbox setup"));setSandboxPending("")}
    setLoading(false);
  }
  useEffect(()=>{refresh()},[rpc,rpcStatus,projectPath,activeThread?.id,platform]);
  useEffect(()=>{
    if(!rpc?.subscribeNotifications||rpcStatus!=="connected")return;
    let timer=null;const pending=new Set();let disposed=false;
    const flush=async()=>{
      timer=null;if(disposed)return;
      const kinds=[...pending];pending.clear();const threadId=activeThread?.id||null;
      if(kinds.includes("apps")){
        const installed=await call("app/installed",{threadId,forceRefresh:false});
        if(!disposed&&installed)setData(current=>({...current,installedApps:installed.apps||[]}));
      }
      if(kinds.includes("mcp")){
        const status=await call("mcpServerStatus/list",{limit:100,detail:"full",threadId});
        if(!disposed&&status)setData(current=>({...current,mcp:status.data||[]}));
      }
      if(kinds.includes("rateLimits")){
        const rateLimits=await call("account/rateLimits/read",{excludeResetCreditDetails:true});
        if(!disposed&&rateLimits)setData(current=>({...current,rateLimits}));
      }
      if(kinds.includes("account")){
        const account=await call("account/read",{refreshToken:false});
        if(!disposed&&account)setData(current=>({...current,account}));
      }
    };
    const schedule=kind=>{pending.add(kind);if(timer)clearTimeout(timer);timer=setTimeout(flush,100)};
    const unsubscribe=rpc.subscribeNotifications(message=>{
      if(message.method==="app/list/updated"){
        const apps=message.params?.data;
        if(Array.isArray(apps))setData(current=>({...current,apps}));
        schedule("apps");
      }else if(message.method==="mcpServer/startupStatus/updated"||message.method==="mcpServer/oauthLogin/completed"){
        schedule("mcp");
      }else if(message.method==="account/rateLimits/updated"){
        schedule("rateLimits");
      }else if(message.method==="account/updated"){
        schedule("account");
      }else if(message.method==="modelProvider/authRecoveryStarted"||message.method==="modelProvider/authRecoveryCompleted"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const active=message.method==="modelProvider/authRecoveryStarted";
        setAuthRecovery({active,provider:params.provider||"provider",message:params.message||""});
        if(!active)schedule("account");
      }else if(message.method==="model/rerouted"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const notice={id:"reroute:"+(params.turnId||Date.now()),kind:"reroute",title:(params.fromModel||"model")+" → "+(params.toModel||"model"),detail:humanizeIdentifier(params.reason)||"Model rerouted"};
        setModelNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="model/safetyBuffering/updated"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const detail=[...(params.reasons||[]).map(humanizeIdentifier),params.fasterModel?"faster model: "+params.fasterModel:null].filter(Boolean).join(" · ");
        const notice={id:"safety:"+(params.turnId||Date.now()),kind:"safety",title:(params.model||"Model")+" safety buffering "+(params.showBufferingUi?"active":"cleared"),detail};
        setModelNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="model/verification"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const notice={id:"verify:"+(params.turnId||Date.now()),kind:"verification",title:"Model access verified",detail:(params.verifications||[]).map(humanizeIdentifier).join(", ")||"Verification completed"};
        setModelNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="configWarning"){
        const warning=message.params||{};
        setConfigWarnings(current=>[
          warning,
          ...current.filter(item=>!(item.summary===warning.summary&&item.path===warning.path&&item.details===warning.details)),
        ].slice(0,5));
      }else if(message.method==="warning"){
        const params=message.params||{};
        if(params.threadId&&activeThread?.id&&params.threadId!==activeThread.id)return;
        const notice={id:"warning:"+(params.threadId||"global")+":"+(params.message||""),kind:"warning",summary:params.message||"Codex warning",details:null};
        setRuntimeNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="deprecationNotice"){
        const params=message.params||{};
        const notice={id:"deprecation:"+(params.summary||""),kind:"deprecated",summary:params.summary||"Deprecated Codex capability",details:params.details||null};
        setRuntimeNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="externalAgentConfig/import/progress"&&message.params?.importId===migrationImportId){
        setMigrationMessage(importResultSummary(message.params?.itemTypeResults,"Importing"));
      }else if(message.method==="externalAgentConfig/import/completed"&&message.params?.importId===migrationImportId){
        setMigrationMessage(importResultSummary(message.params?.itemTypeResults,"Import complete"));
        setMigrationFailures(importFailures(message.params?.itemTypeResults));
        setMigrationImportId(null);
        Promise.all([loadMigrationHistory(),loadExternalConfig()]).catch(error=>setErrors(prev=>({...prev,"externalAgentConfig/import":failureText("Could not reload the agent configuration after the import",error)})));
      }else if((message.method==="hook/started"||message.method==="hook/completed")&&message.params?.run){
        const params=message.params;
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        setHookRuns(current=>{
          const next=[params.run,...current.filter(run=>run.id!==params.run.id)];
          return next.sort((a,b)=>Number(b.startedAt||0)-Number(a.startedAt||0)).slice(0,8);
        });
      }
    });
    return()=>{disposed=true;if(timer)clearTimeout(timer);unsubscribe?.()};
  },[rpc,rpcStatus,activeThread?.id,migrationImportId,projectPath]);
  useEffect(()=>{
    const completed=event=>{
      const detail=event.detail||{};setSandboxPending("");
      // The refresh clears every error line as it starts, so it starts first: a failure set after it stays on screen.
      refresh();
      if(detail.success){setSandboxMessage(`${detail.mode==="elevated"?"Elevated":"Unelevated"} Windows sandbox setup completed.`);setErrors(prev=>({...prev,"windowsSandbox/setupStart":null}))}
      else{setSandboxMessage("");setErrors(prev=>({...prev,"windowsSandbox/setupStart":failureText("Windows sandbox setup failed",detail.error)}))}
    };
    const warning=event=>setSandboxWarning(worldWritableWarningText(event.detail||{}));
    window.addEventListener("trebell:windows-sandbox-setup",completed);window.addEventListener("trebell:windows-sandbox-warning",warning);
    return()=>{window.removeEventListener("trebell:windows-sandbox-setup",completed);window.removeEventListener("trebell:windows-sandbox-warning",warning)};
  },[rpc,rpcStatus,projectPath,activeThread?.id,platform]);
  // While Codex is away the page says it is not connected and keeps its cards hidden as the person left them: drawn again as Codex came
  // back, they came back with what the person had opened closed, shorter above the card they were at, which so stood higher. The short
  // not-connected state takes the page to its top, so the place the person scrolled to is noted as they scroll the cards and given
  // back as the cards show again.
  const pageRef=useRef(null),place=useRef(0),connected=rpcStatus==="connected";
  useLayoutEffect(()=>{
    const scroller=pageRef.current?.parentElement;if(!scroller||!connected)return;
    scroller.scrollTop=place.current;const note=()=>{place.current=scroller.scrollTop};
    scroller.addEventListener("scroll",note);return()=>scroller.removeEventListener("scroll",note);
  },[connected]);

  const plugins=useMemo(()=>(data.marketplaces||[]).flatMap(m=>(m.plugins||[]).map(p=>({...p,marketplace:m}))),[data.marketplaces]);
  // What a plugin's Install or Uninstall says while Codex answers it. busy names which one runs: a search result shows the plugin
  // installed as soon as Codex answers, before the refresh after it ends.
  const toggling=plugin=>busy==="install:"+plugin.id?"Installing…":busy==="uninstall:"+plugin.id&&"Uninstalling…";
  const installedAppsById=useMemo(()=>Object.fromEntries((data.installedApps||[]).map(app=>[app.id,app])),[data.installedApps]);
  const hookCount=(data.hooks||[]).reduce((n,x)=>n+(x.hooks?.length||0),0);
  // A runtime list's head count waits for its list on every refresh, not only the first: while an empty list is read again its
  // card says it is loading, so the head shows no "0" beside that.
  const counted=(list,name,count)=>listCount(list,{loading,error:errors[name],count});
  const layerCount=counted(data.config&&(data.config.layers||[]),"config/read");
  // The app reads the skills list, not this page. A failure names the load, or the refresh when an earlier list is still shown
  // (only this workspace's: the app drops another workspace's list as it reads this one).
  const skillsFailure=skillsLoad?.status==="failed"?failureText(skills.length?"Could not refresh skills":"Could not load skills",skillsLoad.error):"";

  async function reloadMcp(){
    if(!rpc)return;setBusy("mcp");setErrors(prev=>({...prev,"config/mcpServer/reload":null}));
    try{await request("config/mcpServer/reload",undefined);await refresh()}
    catch(error){setErrors(prev=>({...prev,"config/mcpServer/reload":failureText("Could not reload MCP servers",error)}))}
    finally{setBusy("")}
  }
  async function loginMcp(name){
    if(!rpc)return;setBusy("mcp:"+name);setErrors(prev=>({...prev,"mcpServer/oauth/login":null}));
    try{await request("mcpServer/oauth/login",{name,threadId:activeThread?.id||null});await refresh()}
    catch(error){setErrors(prev=>({...prev,"mcpServer/oauth/login":failureText("Could not sign in to "+name,error)}))}
    finally{setBusy("")}
  }
  async function togglePlugin(plugin){
    if(!rpc)return;const action=plugin.installed?"plugin/uninstall":"plugin/install",nextInstalled=!plugin.installed;setBusy((plugin.installed?"uninstall:":"install:")+plugin.id);setErrors(prev=>({...prev,[action]:null}));
    try{
      if(plugin.installed)await request(action,{pluginId:plugin.id});
      else await request("plugin/install",{
        pluginName:plugin.name,
        marketplacePath:plugin.marketplace?.path||null,
        remoteMarketplaceName:plugin.marketplace?.path?null:(plugin.marketplace?.name||null),
        installAttemptId:crypto.randomUUID(),
      });
      setPluginSearchResults(current=>current.map(result=>result.plugin?.id===plugin.id?{...result,plugin:{...result.plugin,installed:nextInstalled}}:result));
      setPluginDetail(current=>current?.summary?.id===plugin.id?{...current,summary:{...current.summary,installed:nextInstalled}}:current);
      await refresh();
    }catch(error){shareDone[action]=["plugin/list",list=>{const item=listedPlugin(list,plugin.id);return !!item&&!!item.installed===nextInstalled}];setErrors(prev=>({...prev,[action]:failureText((plugin.installed?"Could not uninstall ":"Could not install ")+pluginLabel(plugin),error)}))}
    finally{setBusy("")}
  }
  async function searchPlugins({append=false}={}){
    const searchTerm=pluginSearchTerm.trim();if(!rpc||searchTerm.length<2)return;
    setBusy(append?"plugin:more":"plugin:search");setErrors(prev=>({...prev,"plugin/search":null}));if(!append)setPluginSearchRan(false);
    try{
      const result=await request("plugin/search",{searchTerm,scope:pluginSearchScope,cwds:projectPath?[projectPath]:null,cursor:append?pluginSearchCursor:null,limit:20});
      setPluginSearchResults(current=>append?[...current,...(result?.data||[])]:result?.data||[]);
      setPluginSearchCursor(result?.nextCursor||null);setPluginSearchRan(true);
    }catch(error){setErrors(prev=>({...prev,"plugin/search":failureText("Could not search plugins",error)}))}
    finally{setBusy("")}
  }
  async function readPlugin(plugin,marketplace={}){
    if(!rpc||!plugin?.name)return;setBusy("plugin:read:"+plugin.id);setErrors(prev=>({...prev,"plugin/read":null}));setPluginSkillDetail(null);
    try{
      const result=await request("plugin/read",{marketplacePath:marketplace.path||null,remoteMarketplaceName:marketplace.path?null:(marketplace.name||null),pluginName:plugin.name});
      setPluginDetail(result?.plugin||null);
    }catch(error){setErrors(prev=>({...prev,"plugin/read":failureText("Could not load details for "+pluginLabel(plugin),error)}))}
    finally{setBusy("")}
  }
  async function readPluginSkill(skill){
    const remotePluginId=pluginDetail?.summary?.remotePluginId,remoteMarketplaceName=pluginDetail?.marketplaceName;
    if(!rpc||!remotePluginId||!remoteMarketplaceName||!skill?.name)return;
    setBusy("plugin:skill:"+skill.name);setErrors(prev=>({...prev,"plugin/skill/read":null}));
    try{const result=await request("plugin/skill/read",{remoteMarketplaceName,remotePluginId,skillName:skill.name});setPluginSkillDetail({name:skill.name,contents:result?.contents||""})}
    catch(error){setErrors(prev=>({...prev,"plugin/skill/read":failureText("Could not read the skill "+skill.name,error)}))}finally{setBusy("")}
  }
  async function refreshInstalledApps(){
    if(!rpc)return;setBusy("apps:installed");setErrors(prev=>({...prev,"app/installed":null}));
    try{
      const result=await request("app/installed",{threadId:activeThread?.id||null,forceRefresh:true});
      setData(current=>({...current,installedApps:result?.apps||[]}));
    }catch(error){setErrors(prev=>({...prev,"app/installed":failureText("Could not refresh installed apps",error)}))}
    finally{setBusy("")}
  }
  async function reconcilePlugins(){
    if(!rpc)return;setBusy("plugin:reconcile");setPluginMessage("");setErrors(prev=>({...prev,"plugin/reconcile":null}));
    try{const result=await request("plugin/reconcile",{reason:"trebell-tools-refresh"});const changed=result?.changedPlugins?.length||0,failed=result?.failedRemotePluginIds?.length||0;setPluginMessage(`${changed} plugin change${changed===1?"":"s"} reconciled${failed?` · ${failed} failed`:""}.`);await refresh()}
    catch(error){setErrors(prev=>({...prev,"plugin/reconcile":failureText("Could not reconcile plugins",error)}))}finally{setBusy("")}
  }
  // A first share done lists the plugin shared; an Update share looks the same done or not, so its line stays (shareDone).
  async function shareLocalPlugin(plugin){
    const pluginPath=plugin?.source?.type==="local"?plugin.source.path:null;if(!rpc||!pluginPath)return;
    setBusy("share:"+plugin.id);setErrors(prev=>({...prev,"plugin/share/save":null}));
    try{await request("plugin/share/save",{pluginPath,...(plugin.remotePluginId?{remotePluginId:plugin.remotePluginId}:{}),discoverability:plugin.shareContext?.discoverability||"PRIVATE",shareTargets:(plugin.shareContext?.sharePrincipals||[]).filter(principal=>principal.role!=="owner"&&["reader","editor"].includes(principal.role)).map(principal=>({principalType:principal.principalType,principalId:principal.principalId,role:principal.role}))});await refresh()}
    catch(error){shareDone["plugin/share/save"]=!plugin.shareContext?.remotePluginId&&["plugin/list",list=>!!listedPlugin(list,plugin.id)?.shareContext?.remotePluginId];setErrors(prev=>({...prev,"plugin/share/save":failureText("Could not share "+pluginLabel(plugin),error)}))}finally{setBusy("")}
  }
  // A Shared plugins action clears its line as it starts, as the page's other actions do (the line saying the last try failed stayed
  // beside Checking out…), and a failure notes how the list shows the action done (done).
  async function shareAction(name,busyKey,params,failure,done){
    setBusy(busyKey);setErrors(prev=>({...prev,[name]:null}));
    try{await request(name,params);await refresh()}
    catch(error){shareDone[name]=["plugin/share/list",done];setErrors(prev=>({...prev,[name]:failureText(failure,error)}))}finally{setBusy("")}
  }
  async function checkoutSharedPlugin(item){
    const remotePluginId=item?.plugin?.remotePluginId;if(!rpc||!remotePluginId)return;
    await shareAction("plugin/share/checkout","checkout:"+remotePluginId,{remotePluginId},"Could not check out "+pluginLabel(item.plugin),list=>list.some(entry=>shareId(entry)===remotePluginId&&entry.localPluginPath));
  }
  // A deleted share is gone from the account for everyone it was shared with, so Delete share asks first, in the app's dialog.
  async function deleteSharedPlugin(item){
    const remotePluginId=item?.plugin?.remotePluginId;if(!rpc||!remotePluginId)return;
    const named=pluginLabel(item.plugin)!=="the plugin"?`“${pluginLabel(item.plugin)}”`:"this plugin";
    if(!await askConfirm(`Delete the share of ${named}? Everyone it was shared with loses it, and this cannot be undone.`,{confirm:"Delete share"}))return;
    await shareAction("plugin/share/delete","delete-share:"+remotePluginId,{remotePluginId},"Could not delete the share of "+pluginLabel(item.plugin),list=>!list.some(entry=>shareId(entry)===remotePluginId));
  }
  // The visibility chosen is in busy, so the row shows it while Codex answers.
  async function updateShareDiscoverability(item,discoverability){
    const context=item?.plugin?.shareContext;const remotePluginId=item?.plugin?.remotePluginId||context?.remotePluginId;if(!rpc||!remotePluginId)return;
    const shareTargets=(context?.sharePrincipals||[]).filter(principal=>principal.role!=="owner"&&["reader","editor"].includes(principal.role)).map(principal=>({principalType:principal.principalType,principalId:principal.principalId,role:principal.role}));
    await shareAction("plugin/share/updateTargets","share-visibility:"+remotePluginId+"="+discoverability,{remotePluginId,discoverability,shareTargets},"Could not change who can find "+pluginLabel(item.plugin),list=>list.some(entry=>shareId(entry)===remotePluginId&&entry.plugin?.shareContext?.discoverability===discoverability));
  }
  async function toggleFeature(feature){
    if(!rpc)return;setBusy("feature:"+feature.name);setErrors(prev=>({...prev,"experimentalFeature/enablement/set":null}));
    try{
      const result=await request("experimentalFeature/enablement/set",{enablement:{[feature.name]:!feature.enabled}});
      if(!Object.prototype.hasOwnProperty.call(result?.enablement||{},feature.name)){
        setErrors(prev=>({...prev,"experimentalFeature/enablement/set":feature.name+" is read-only through the app-server. Enable it in Codex config, then restart or refresh the runtime."}));
        return;
      }
      await refresh();
    }catch(error){setErrors(prev=>({...prev,"experimentalFeature/enablement/set":failureText((feature.enabled?"Could not turn off ":"Could not turn on ")+(feature.displayName||feature.name),error)}))}
    finally{setBusy("")}
  }
  async function addMarketplace(){
    const source=marketplaceSource.trim();if(!source||!rpc)return;setBusy("marketplace:add");setErrors(prev=>({...prev,"marketplace/add":null}));
    try{await request("marketplace/add",{source});setMarketplaceSource("");await refresh()}
    catch(error){setErrors(prev=>({...prev,"marketplace/add":failureText("Could not add the marketplace",error)}))}
    finally{setBusy("")}
  }
  async function removeMarketplace(name){
    if(!rpc||!name)return;setBusy("remove:"+name);setErrors(prev=>({...prev,"marketplace/remove":null}));
    try{await request("marketplace/remove",{marketplaceName:name});await refresh()}
    catch(error){shareDone["marketplace/remove"]=["plugin/list",list=>!list.some(marketplace=>marketplace.name===name)];setErrors(prev=>({...prev,"marketplace/remove":failureText("Could not remove "+name,error)}))}
    finally{setBusy("")}
  }
  async function upgradeMarketplace(name=null){
    if(!rpc)return;setBusy(name?"upgrade:"+name:"upgrade-all");setErrors(prev=>({...prev,"marketplace/upgrade":null}));
    try{await request("marketplace/upgrade",{marketplaceName:name});await refresh()}
    catch(error){setErrors(prev=>({...prev,"marketplace/upgrade":failureText(name?"Could not upgrade "+name:"Could not upgrade the marketplaces",error)}))}
    finally{setBusy("")}
  }
  async function loadExternalConfig(){
    const result=await request("externalAgentConfig/detect",{includeHome:true,cwds:projectPath?[projectPath]:[],maxSessionAgeDays:90,maxSessions:100});
    setMigrations(result);return result;
  }
  async function loadMigrationHistory(){
    const result=await request("externalAgentConfig/import/readHistories",{});
    setMigrationHistory({data:result?.data||[],connectors:result?.connectors||[]});return result;
  }
  async function detectExternalConfig(){
    if(!rpc)return;setBusy("migration:detect");setMigrationMessage("");setMigrationFailures([]);setErrors(prev=>({...prev,"externalAgentConfig/detect":null}));
    try{await Promise.all([loadExternalConfig(),loadMigrationHistory()])}
    catch(error){setErrors(prev=>({...prev,"externalAgentConfig/detect":failureText("Could not scan for agent configuration",error)}))}finally{setBusy("")}
  }
  async function importExternalConfig(){
    if(!rpc||!migrations?.items?.length)return;setBusy("migration:import");setMigrationMessage("");setMigrationFailures([]);setErrors(prev=>({...prev,"externalAgentConfig/import":null}));
    try{
      const started=await request("externalAgentConfig/import",{migrationItems:migrations.items,source:"trebell-code"});
      const importId=started?.importId;if(!importId)throw new Error("Codex did not return an import id.");
      setMigrationImportId(importId);
      setMigrationMessage("Import started. Waiting for Codex to finish…");
    }catch(error){setMigrationImportId(null);setErrors(prev=>({...prev,"externalAgentConfig/import":failureText("Could not import the agent configuration",error)}))}
    finally{setBusy("")}
  }
  // A scan's answer lands on the page drawn now, as busy does.
  async function scanHistory(){
    setBusy("history:scan");setHistoryMessage("");setHistoryScanFailed(false);
    try{const found=await api("/api/history-import");page()?.setHistoryImport(found)}
    catch(error){const to=page();to?.setHistoryScanFailed(true);to?.setHistoryMessage(failureText("Could not scan conversation history",error))}
    finally{setBusy("")}
  }
  // What an import did (line) is said, once the history is scanned again (scan), on the page drawn now, so a page drawn again while it
  // runs says it: both went with the page that sent it. With no page shown both wait for the next page drawn (told): they went
  // nowhere. The summary is said once the scan is read again, as the scan clears the line as it starts: it took the summary with it,
  // so no page said what was imported. A scan that fails says so instead.
  async function tell(line,scan){let to=page();if(to&&scan){await to.scanHistory();to=page()}if(to)to.setHistoryMessage(line);else told=line}
  async function importHistory(sessionIds){
    const ids=(sessionIds||[]).filter(Boolean);if(!ids.length)return;
    setBusy("history:import");setHistoryMessage("");
    let result;
    // A refusal leaves the page that sent it as it was, offering the conversations again; a page drawn since reads them again.
    try{result=await api("/api/history-import",{method:"POST",body:{sessionIds:ids.slice(0,50)}})}
    catch(error){await tell(failureText("Could not import conversations",error),page()!==self);setBusy("");return}
    // A failure after the import itself (refreshing the thread list) is worded by the app, which says the import succeeded.
    try{
      const imported=(result.results||[]).filter(item=>item.status==="imported").length;
      const skipped=(result.results||[]).filter(item=>item.status==="skipped").length;
      const failed=(result.results||[]).filter(item=>item.status==="error").length;
      await tell(scan=>scan||[imported&&`${imported} imported`,skipped&&`${skipped} already imported`,failed&&`${failed} failed`].filter(Boolean).join(" · ")||"Nothing changed",true);
      await onHistoryImported?.(result);
    }catch(error){tell(error.message||String(error))}
    finally{setBusy("")}
  }
  async function readResource(server,resource){
    if(!rpc)return;setBusy("resource:"+resource.uri);
    try{const result=await request("mcpServer/resource/read",{threadId:activeThread?.id||null,server:server.name,uri:resource.uri});setMcpResult({title:`${server.name} · ${resource.name||resource.uri}`,value:result})}
    catch(error){setMcpResult({title:`Could not read ${resource.name||resource.uri} from ${server.name}`,value:{error:error.message}})}finally{setBusy("")}
  }
  async function runMcpTool(server,toolName){
    if(!rpc||!activeThread?.id)return;
    let args={};const raw=toolArgs[server.name+":"+toolName]?.trim();if(raw){try{args=JSON.parse(raw)}catch{setMcpResult({title:"Invalid tool arguments",value:{error:"Arguments must be valid JSON."}});return}}
    setBusy("tool:"+server.name+":"+toolName);
    try{const result=await request("mcpServer/tool/call",{threadId:activeThread.id,server:server.name,tool:toolName,arguments:args});setMcpResult({title:`${server.name} · ${toolName}`,value:result})}
    catch(error){setMcpResult({title:`Could not run ${toolName} on ${server.name}`,value:{error:error.message}})}finally{setBusy("")}
  }
  async function readApp(app){
    if(!rpc||!app?.id)return;setBusy("app:"+app.id);setErrors(prev=>({...prev,"app/read":null}));
    try{
      const result=await request("app/read",{appIds:[app.id],threadId:activeThread?.id||null,includeTools:true});
      const detail=result?.apps?.[0];if(!detail)throw new Error(result?.missingAppIds?.includes(app.id)?"Connector metadata is unavailable":"Codex did not return connector metadata");setAppDetail({...app,...detail});
    }catch(error){setErrors(prev=>({...prev,"app/read":failureText("Could not load details for "+(app.name||app.id),error)}))}finally{setBusy("")}
  }
  async function setThreadMemoryMode(mode){
    if(!rpc||!activeThread?.id)return;
    setBusy("memory:"+mode);setMemoryMessage("");setErrors(prev=>({...prev,"thread/memoryMode/set":null}));
    try{
      await request("thread/memoryMode/set",{threadId:activeThread.id,mode});
      setMemoryMessage(`Memory ${mode} for this thread.`);
    }catch(error){setErrors(prev=>({...prev,"thread/memoryMode/set":failureText((mode==="enabled"?"Could not enable":"Could not disable")+" memory for this thread",error)}))}
    finally{setBusy("")}
  }
  async function resetMemory(){
    if(!rpc)return;
    if(!memoryResetArmed){setMemoryResetArmed(true);setMemoryMessage("Click Confirm reset to clear the current Codex memory store.");return}
    setBusy("memory:reset");setErrors(prev=>({...prev,"memory/reset":null}));setMemoryMessage("");
    try{await request("memory/reset",undefined);setMemoryMessage("Codex memory was reset.");setMemoryResetArmed(false);await refresh()}
    catch(error){setErrors(prev=>({...prev,"memory/reset":failureText("Could not reset memory",error)}))}
    finally{setBusy("")}
  }
  async function setupWindowsSandbox(mode){
    if(!rpc||platform!=="win32"||sandboxPending)return;
    setBusy("windows-sandbox:"+mode);setSandboxMessage("");setErrors(prev=>({...prev,"windowsSandbox/setupStart":null}));
    try{
      const result=await request("windowsSandbox/setupStart",{mode,cwd:projectPath||null});
      if(result?.started!==true)throw new Error("Codex did not report that it started.");
      setSandboxPending(mode);setSandboxMessage(`${mode==="elevated"?"Elevated":"Unelevated"} setup started. Windows may ask for permission; Trebell will wait for Codex to report completion.`);
    }catch(error){setErrors(prev=>({...prev,"windowsSandbox/setupStart":failureText(`Could not start ${mode==="elevated"?"elevated":"unelevated"} Windows sandbox setup`,error)}))}
    finally{setBusy("")}
  }
  async function toggleSkill(skill){
    if(!rpc||!skill?.path)return;
    const next=skill.enabled===false;setBusy("skill:"+skill.path);setSkillMessage("");setErrors(prev=>({...prev,"skills/config/write":null}));
    try{
      const result=await request("skills/config/write",{path:skill.path,name:null,enabled:next});
      const effectiveEnabled=result?.effectiveEnabled!==false;
      setSkillMessage(`${skill.name||"Skill"} is now ${effectiveEnabled?"enabled":"disabled"}. This setting is saved in Codex config.`);
      // A failed re-read is named by the card from skillsLoad, once, however the read was started.
      try{await onSkillsRefresh?.({path:skill.path,enabled:effectiveEnabled})}catch{}
    }catch(error){setErrors(prev=>({...prev,"skills/config/write":failureText((next?"Could not turn on ":"Could not turn off ")+(skill.interface?.displayName||skill.name||"the skill"),error)}))}
    finally{setBusy("")}
  }
  async function applySkillRoots(){
    if(!rpc)return;
    const extraRoots=[...new Set(skillRootsText.split(/\r?\n/).map(value=>value.trim()).filter(Boolean))];
    setBusy("skill-roots");setSkillMessage("");setErrors(prev=>({...prev,"skills/extraRoots/set":null}));
    try{
      await request("skills/extraRoots/set",{extraRoots});
      setSkillMessage(extraRoots.length?`${extraRoots.length} runtime skill root${extraRoots.length===1?"":"s"} applied. They reset when this Codex app-server restarts.`:"Runtime-only extra skill roots cleared.");
      try{await onSkillsRefresh?.()}catch{}
    }catch(error){setErrors(prev=>({...prev,"skills/extraRoots/set":failureText("Could not apply the runtime skill roots",error)}))}
    finally{setBusy("")}
  }

  return <>
    {!connected&&<div className="empty-state capabilities-empty-state"><Wrench size={24}/><strong>Codex harness is not connected</strong><span>Capabilities will appear when app-server is ready.</span></div>}
    <div className="capabilities-page" ref={pageRef} hidden={!connected} onFocus={event=>{if(busy)hold(event.target)}}>
    <div className="capabilities-toolbar"><div><h2>Harness capabilities</h2><p>Live inventory from the bundled Codex app-server. These are real runtime capabilities, not a hard-coded parity list.</p></div><button onClick={()=>{refresh();onSkillsReload?.()}} disabled={loading}><RefreshCw size={13}/>{loading?"Refreshing…":"Refresh"}</button></div>

    <div className="capability-grid">
      <Section title="Account & usage" icon={Sparkles}>
        {data.account?<div className="capability-kv">
          <div><span>Authentication</span><strong>{data.account.account?.type|| (data.account.requiresOpenaiAuth?"Sign-in required":"External provider")}</strong></div>
          {data.account.account?.email&&<div><span>Account</span><strong>{data.account.account.email}</strong></div>}
          {data.account.account?.planType&&<div><span>Plan</span><strong>{data.account.account.planType}</strong></div>}
          {data.usage?.summary?.lifetimeTokens!=null&&<div><span>Lifetime tokens</span><strong>{Number(data.usage.summary.lifetimeTokens).toLocaleString()}</strong></div>}
          {data.usage?.summary?.currentStreakDays!=null&&<div><span>Active streak</span><strong>{String(data.usage.summary.currentStreakDays)} days</strong></div>}
          {data.rateLimits?.rateLimits?.primary&&<div><span>Primary usage</span><strong>{Math.round(Number(data.rateLimits.rateLimits.primary.usedPercent)||0)}%</strong></div>}
          {data.rateLimits?.rateLimits?.secondary&&<div><span>Secondary usage</span><strong>{Math.round(Number(data.rateLimits.rateLimits.secondary.usedPercent)||0)}%</strong></div>}
        </div>:<EmptyState loaded loading={loading} error={errors["account/read"]} pending="Loading account…">Codex did not return account metadata for this inference route.</EmptyState>}
        {authRecovery&&<p className="capability-status">{authRecovery.active?"Recovering":"Recovered"} {authRecovery.provider} authentication{authRecovery.message?": "+authRecovery.message:""}</p>}
        <ErrorLine value={errors["account/read"]}/><ErrorLine value={errors["account/rateLimits/read"]}/><ErrorLine value={errors["account/usage/read"]}/>
      </Section>

      <Section title="Codex memory" icon={Brain}>
        {data.memory?<div className="capability-kv">
          <div><span>Consolidated threads</span><strong>{Number(data.memory.v2ConsolidatedThreads||0).toLocaleString()}</strong></div>
          <div><span>V2 memory readiness</span><strong>{data.memory.v2Ready?"Ready":"Building"}</strong></div>
        </div>:<EmptyState loaded loading={loading} error={errors["memory/status"]} pending="Loading memory readiness…">Memory readiness is unavailable from this Codex runtime.</EmptyState>}
        <p>Readiness uses Codex's default threshold of 20 consolidated threads. This status reports readiness only; it does not expose memory contents.</p>
        <div className="capability-actions">
          <button onClick={()=>setThreadMemoryMode("enabled")} disabled={!!busy||!activeThread?.id}>Enable for this thread</button>
          <button onClick={()=>setThreadMemoryMode("disabled")} disabled={!!busy||!activeThread?.id}>Disable for this thread</button>
          <button onClick={resetMemory} disabled={!!busy}>{memoryResetArmed?"Confirm reset":"Reset memory"}</button>
          {memoryResetArmed&&<button onClick={()=>{setMemoryResetArmed(false);setMemoryMessage("")}} disabled={!!busy}>Cancel</button>}
        </div>
        {!activeThread?.id&&<p>Select a thread to change its memory mode.</p>}
        {memoryMessage&&<p className="capability-status">{memoryMessage}</p>}
        <ErrorLine value={errors["memory/status"]}/><ErrorLine value={errors["thread/memoryMode/set"]}/><ErrorLine value={errors["memory/reset"]}/>
      </Section>

      <Section title="Codex runtime health" icon={Sparkles}>
        {data.diagnostics?<div className="capability-kv">
          <div><span>Process</span><strong>{data.diagnostics.process?.id?"PID "+data.diagnostics.process.id:"Unavailable"}</strong></div>
          <div><span>Resident memory</span><strong>{formatBytes(data.diagnostics.process?.residentMemoryBytes)}</strong></div>
          {data.diagnostics.process?.physicalFootprintBytes!=null&&<div><span>Physical footprint</span><strong>{formatBytes(data.diagnostics.process.physicalFootprintBytes)}</strong></div>}
          <div><span>Loaded sessions</span><strong>{data.loadedThreads?data.loadedThreads.length.toLocaleString()+(data.loadedThreadsMore?"+":""):"Unavailable"}</strong></div>
          {["core.threads.live","core.turns.active","mcp.connections.live"].map(name=>{const gauge=(data.diagnostics.gauges||[]).find(item=>item.name===name);return gauge?<div key={name}><span>{name==="core.threads.live"?"Live threads":name==="core.turns.active"?"Active turns":"MCP connections"}</span><strong>{Number(gauge.value||0).toLocaleString()}</strong></div>:null})}
        </div>:<EmptyState loaded loading={loading} error={errors["server/diagnostics"]} pending="Loading process diagnostics…">Process diagnostics are unavailable from this Codex runtime.</EmptyState>}
        {data.loadedThreads?.length>0&&<details className="capability-details"><summary>Loaded session IDs</summary><pre>{data.loadedThreads.join("\n")}{data.loadedThreadsMore?"\n…more loaded sessions not shown":""}</pre></details>}
        {data.diagnostics?.gauges?.length>0&&<details className="capability-details"><summary>All runtime gauges</summary><pre>{data.diagnostics.gauges.map(gauge=>gauge.name+": "+Number(gauge.value||0).toLocaleString()).join("\n")}</pre></details>}
        <ErrorLine value={errors["server/diagnostics"]}/><ErrorLine value={errors["thread/loaded/list"]}/>
      </Section>

      {platform==="win32"&&<Section title="Windows sandbox" icon={ShieldCheck}>
        {data.windowsSandbox?(()=>{const status=windowsSandboxStatus(data.windowsSandbox.status);return <div className="capability-kv"><div><span>Native sandbox</span><strong>{status.label}</strong></div><div><span>Managed setup modes</span><strong>{allowedWindowsSetupModes(data.requirements).length?allowedWindowsSetupModes(data.requirements).map(mode=>mode==="elevated"?"Elevated":"Unelevated").join(" · "):"Policy-managed"}</strong></div></div>})():<EmptyState loaded loading={loading} error={errors["windowsSandbox/readiness"]} pending="Checking Windows sandbox readiness…">Windows sandbox readiness is unavailable from this Codex runtime.</EmptyState>}
        {data.windowsSandbox&&<p>{windowsSandboxStatus(data.windowsSandbox.status).detail}</p>}
        {/* Setup is offered once readiness says it is needed, or when readiness could not be read; not while the first read runs. */}
        {(data.windowsSandbox?data.windowsSandbox.status!=="ready":!loading)&&<div className="capability-actions">
          <button onClick={()=>setupWindowsSandbox("unelevated")} disabled={!!busy||!!sandboxPending||!allowedWindowsSetupModes(data.requirements).includes("unelevated")}>{sandboxPending==="unelevated"?"Setting up…":"Set up unelevated"}</button>
          <button onClick={()=>setupWindowsSandbox("elevated")} disabled={!!busy||!!sandboxPending||!allowedWindowsSetupModes(data.requirements).includes("elevated")}>{sandboxPending==="elevated"?"Setting up…":"Set up elevated"}</button>
        </div>}
        {sandboxMessage&&<p className="capability-status">{sandboxMessage}</p>}
        {sandboxWarning&&<p className="capability-error">{sandboxWarning}</p>}
        <ErrorLine value={errors["windowsSandbox/readiness"]}/><ErrorLine value={errors["windowsSandbox/setupStart"]}/><ErrorLine value={errors["configRequirements/read"]}/>
      </Section>}

      {/* The card lists layers and then the warnings and notices Codex sent, so its badge counts each by name. */}
      <Section title="Configuration layers" icon={ShieldCheck} badge={[layerCount!==undefined?countLabel(layerCount,"layer"):"",configWarnings.length+runtimeNotices.length?countLabel(configWarnings.length+runtimeNotices.length,"notice"):""].filter(Boolean).join(" · ")}>
        {!(data.config?.layers||[]).length&&<EmptyState loaded={!!data.config} loading={loading} error={errors["config/read"]} pending="Loading configuration layers…">Codex reported no configuration layers.</EmptyState>}
        <div className="capability-list">{(data.config?.layers||[]).map((layer,index)=>{const presentation=configLayerPresentation(layer,index);return <div key={presentation.label+":"+String(layer.version||index)}><div><strong>{presentation.label}</strong><span>{presentation.detail}</span></div><em className={layer.disabledReason?"":"ok"}>{layer.disabledReason?"disabled":"active"}</em></div>})}</div>
        {configWarnings.length>0&&<div className="capability-list config-warning-list">{configWarnings.map((warning,index)=><div key={(warning.path||"global")+":"+(warning.summary||index)}><div><strong>{warning.summary||"Configuration warning"}</strong><span>{warning.details||warning.path||"Codex reported a configuration warning."}</span></div><em className="warn">warning</em></div>)}</div>}
        {runtimeNotices.length>0&&<div className="capability-list runtime-notice-list">{runtimeNotices.map(notice=><div key={notice.id}><div><strong>{notice.summary}</strong><span>{notice.details||"Reported by the Codex runtime."}</span></div><em className={notice.kind==="warning"?"warn":""}>{notice.kind}</em></div>)}</div>}
        {data.config&&<details className="capability-details"><summary>Effective config</summary><pre>{JSON.stringify(data.config.config,null,2)}</pre></details>}
        <ErrorLine value={errors["config/read"]}/>
      </Section>

      <Section title="Provider capabilities" icon={Sparkles}>
        {data.capabilities?<div className="capability-badges">
          <span className={data.capabilities.namespaceTools?"ok":""}>Namespace tools</span>
          <span className={data.capabilities.webSearch?"ok":""}>Web search</span>
          <span className={data.capabilities.imageGeneration?"ok":""}>Image generation</span>
        </div>:<EmptyState loaded loading={loading} error={errors["modelProvider/capabilities/read"]} pending="Loading provider capabilities…">No capability report available.</EmptyState>}
        {modelNotices.length>0&&<><p className="capability-status">{modelNotices[0].title}{modelNotices[0].detail?" · "+modelNotices[0].detail:""}</p><details className="capability-details"><summary>Recent model routing & safety · {modelNotices.length}</summary><div className="capability-list">{modelNotices.map(notice=><div key={notice.id}><div><strong>{notice.title}</strong><span>{notice.detail||notice.kind}</span></div><em>{notice.kind}</em></div>)}</div></details></>}
        <ErrorLine value={errors["modelProvider/capabilities/read"]}/>
      </Section>

      <Section title="Permission profiles" icon={ShieldCheck} count={counted(data.permissions,"permissionProfile/list")}>
        {!data.permissions?.length&&<EmptyState loaded={!!data.permissions} loading={loading} error={errors["permissionProfile/list"]} pending="Loading permission profiles…">This runtime reported no permission profiles.</EmptyState>}
        <div className="capability-list">{(data.permissions||[]).map(p=><div key={p.id}><div><strong>{p.id}</strong><span>{p.description||"Codex permission profile"}</span></div><em className={p.allowed?"ok":""}>{p.allowed?"allowed":"blocked"}</em></div>)}</div>
        <ErrorLine value={errors["permissionProfile/list"]}/>
      </Section>

      <Section title="MCP servers" icon={PlugZap} count={counted(data.mcp,"mcpServerStatus/list")}>
        <div className="capability-actions"><button onClick={reloadMcp} disabled={!!busy}><RefreshCw size={12}/> Reload MCP</button></div>
        {!data.mcp?.length&&<EmptyState loaded={!!data.mcp} loading={loading} error={errors["mcpServerStatus/list"]} pending="Loading MCP servers…">No MCP servers are configured for this runtime.</EmptyState>}
        <div className="capability-list">{(data.mcp||[]).map(server=><div className="mcp-server-row" key={server.name}><div><strong>{server.name}</strong><span>{server.runtimeStatus||"unknown"} · {countLabel(Object.keys(server.tools||{}).length,"tool")} · {countLabel((server.resources||[]).length,"resource")}</span></div><div className="capability-inline-actions"><em className={server.authStatus==="notLoggedIn"?"warn":server.runtimeStatus==="connected"?"ok":""}>{mcpAuthLabel(server.authStatus)}</em>{server.authStatus==="notLoggedIn"&&<button onClick={()=>loginMcp(server.name)} disabled={!!busy}>Sign in</button>}</div>{((server.resources||[]).length>0||Object.keys(server.tools||{}).length>0)&&<details className="mcp-server-details"><summary>Resources & tools</summary>
          {(server.resources||[]).map(resource=><div className="mcp-resource" key={resource.uri}><span>{resource.name||resource.uri}</span><button onClick={()=>readResource(server,resource)} disabled={!!busy}>Read</button></div>)}
          {Object.entries(server.tools||{}).map(([toolName,tool])=><div className="mcp-tool" key={toolName}><div><strong>{toolName}</strong><span>{tool?.description||"MCP tool"}</span></div><input value={toolArgs[server.name+":"+toolName]||""} onChange={e=>setToolArgs(prev=>({...prev,[server.name+":"+toolName]:e.target.value}))} placeholder='JSON arguments, e.g. {"query":"..."}'/><button onClick={()=>runMcpTool(server,toolName)} disabled={!!busy||!activeThread?.id}>Run</button></div>)}
        </details>}</div>)}</div>
        {mcpResult&&<details className="capability-details" open><summary>{mcpResult.title}</summary><pre>{JSON.stringify(mcpResult.value,null,2)}</pre></details>}
        <ErrorLine value={errors["mcpServerStatus/list"]}/><ErrorLine value={errors["config/mcpServer/reload"]}/><ErrorLine value={errors["mcpServer/oauth/login"]}/>
      </Section>

      <Section title="Skills" icon={Wrench} count={listCount(skills,{loading:skillsLoad?.status!=="loaded"})}>
        <p>Enable or disable discovered skills with Codex's native config API. Disabled skills stay visible so they can be turned back on.</p>
        <div className="capability-list skill-list">{skills.map(s=><div key={s.path||s.name}><div><strong>{s.interface?.displayName||s.name}</strong><span>{s.interface?.shortDescription||s.shortDescription||s.description||s.path}{s.scope?` · ${s.scope}`:""}</span></div><button className={s.enabled!==false?"active":""} onClick={()=>toggleSkill(s)} disabled={!!busy||!s.path}>{busy==="skill:"+s.path?"Saving…":s.enabled===false?"Off":"On"}</button></div>)}</div>
        {!skills.length&&(skillsLoad?.status==="idle"?<p>Open a workspace to list its skills.</p>:<EmptyState loaded={skillsLoad?.status==="loaded"} loading={skillsLoad?.status==="loading"} error={skillsFailure} pending="Loading skills…">No skills were discovered for this workspace.</EmptyState>)}
        <div className="skill-roots-editor"><label><strong>Runtime-only extra roots</strong><span>One absolute skill-directory path per line. Applying replaces this Codex process's extra roots; restarting the app-server clears them.</span></label><textarea value={skillRootsText} onChange={e=>setSkillRootsText(e.target.value)} placeholder={platform==="win32"?"C:\\Users\\me\\skills\nD:\\shared-skills":"/home/me/skills\n/opt/shared-skills"}/><div className="capability-actions"><button onClick={applySkillRoots} disabled={!!busy}>{busy==="skill-roots"?"Applying…":"Apply runtime roots"}</button>{skillRootsText&&<button onClick={()=>setSkillRootsText("")} disabled={!!busy}>Clear draft</button>}</div></div>
        {skillMessage&&<p className="capability-status">{skillMessage}</p>}
        <ErrorLine value={skillsFailure}/><ErrorLine value={errors["skills/config/write"]}/><ErrorLine value={errors["skills/extraRoots/set"]}/>
      </Section>

      <Section title="Plugins" icon={Blocks} count={counted(data.marketplaces,"plugin/list",plugins.length)}>
        <div className="plugin-search-controls"><input value={pluginSearchTerm} onChange={e=>{setPluginSearchTerm(e.target.value);setPluginSearchResults([]);setPluginSearchCursor(null);setPluginSearchRan(false);setPluginDetail(null);setPluginSkillDetail(null)}} onKeyDown={e=>{if(e.key==="Enter"&&!busy)searchPlugins()}} placeholder="Search plugins" title="Search the plugin catalog"/><select value={pluginSearchScope} onChange={e=>{setPluginSearchScope(e.target.value);setPluginSearchResults([]);setPluginSearchCursor(null);setPluginSearchRan(false);setPluginDetail(null);setPluginSkillDetail(null)}}><option value="global">Global</option><option value="workspace">Workspace</option><option value="personal">Personal</option></select><ActionButton busy={busy} doing={busy==="plugin:search"&&"Searching…"} off={pluginSearchTerm.trim().length<2} onPress={()=>searchPlugins()}>Search</ActionButton><ActionButton busy={busy} doing={busy==="plugin:reconcile"&&"Reconciling…"} onPress={reconcilePlugins}>Reconcile</ActionButton></div>
        {/* A plugin action Codex is still answering says what it is doing on its button, marked busy; the page's other actions wait. */}
        {pluginSearchResults.length>0&&<div className="capability-list plugin-search-results">{pluginSearchResults.map(result=>{const plugin=result.plugin||{};const marketplace={name:result.marketplaceName,path:result.marketplacePath};return <div key={(result.marketplaceName||"")+":"+(plugin.id||plugin.name)}><div><strong>{plugin.interface?.displayName||plugin.name}</strong><span>{plugin.interface?.shortDescription||plugin.interface?.longDescription||result.marketplaceName}{plugin.version?" · "+plugin.version:""}</span></div><div className="capability-inline-actions"><ActionButton busy={busy} doing={busy==="plugin:read:"+plugin.id&&"Loading…"} onPress={()=>readPlugin(plugin,marketplace)}>Details</ActionButton><ActionButton busy={busy} doing={toggling(plugin)} off={plugin.availability==="unavailable"} onPress={()=>togglePlugin({...plugin,marketplace})}>{plugin.installed?"Uninstall":"Install"}</ActionButton></div></div>})}</div>}
        {pluginSearchCursor&&<div className="capability-actions"><ActionButton busy={busy} doing={busy==="plugin:more"&&"Loading…"} onPress={()=>searchPlugins({append:true})}>Load more</ActionButton></div>}
        {pluginSearchRan&&!pluginSearchResults.length&&!busy&&!errors["plugin/search"]&&<p>No plugins matched this search.</p>}
        {!pluginSearchRan&&<div className="capability-list">{plugins.map(plugin=><div key={plugin.marketplace.name+":"+plugin.id}><div><strong>{plugin.interface?.displayName||plugin.name}</strong><span>{plugin.marketplace.name}{plugin.version?" · "+plugin.version:""}{plugin.shareContext?.shareUrl?" · shared":""}</span></div><div className="capability-inline-actions"><ActionButton busy={busy} doing={busy==="plugin:read:"+plugin.id&&"Loading…"} onPress={()=>readPlugin(plugin,plugin.marketplace)}>Details</ActionButton>{plugin.source?.type==="local"&&<ActionButton busy={busy} doing={busy==="share:"+plugin.id&&(plugin.shareContext?.remotePluginId?"Updating…":"Sharing…")} onPress={()=>shareLocalPlugin(plugin)}>{plugin.shareContext?.remotePluginId?"Update share":"Share privately"}</ActionButton>}<ActionButton busy={busy} doing={toggling(plugin)} off={plugin.availability==="unavailable"} onPress={()=>togglePlugin(plugin)}>{plugin.installed?"Uninstall":"Install"}</ActionButton></div></div>)}</div>}
        {!pluginSearchRan&&!plugins.length&&<EmptyState loaded={!!data.marketplaces} loading={loading} error={errors["plugin/list"]} pending="Loading the plugin catalog…">No plugin catalog is available in this runtime.</EmptyState>}
        {pluginDetail&&<div className="plugin-detail"><div className="plugin-detail-head"><div><strong>{pluginDetail.summary?.interface?.displayName||pluginDetail.summary?.name}</strong><span>{pluginDetail.marketplaceName}{pluginDetail.summary?.version?` · ${pluginDetail.summary.version}`:""}{pluginDetail.summary?.interface?.developerName?` · ${pluginDetail.summary.interface.developerName}`:""}</span></div><button onClick={()=>{setPluginDetail(null);setPluginSkillDetail(null)}}>Close</button></div>{(pluginDetail.description||pluginDetail.summary?.interface?.longDescription)&&<p>{pluginDetail.description||pluginDetail.summary.interface.longDescription}</p>}{pluginDetail.summary?.interface?.capabilities?.length>0&&<div className="capability-badges">{pluginDetail.summary.interface.capabilities.map(capability=><span className="ok" key={capability}>{capability}</span>)}</div>}<div className="plugin-detail-counts"><span>{countLabel(pluginDetail.skills?.length,"skill")}</span><span>{countLabel(pluginDetail.hooks?.length,"hook")}</span><span>{countLabel(pluginDetail.apps?.length,"app")}</span><span>{countLabel(pluginDetail.mcpServers?.length,"MCP server")}</span><span>{countLabel(pluginDetail.scheduledTasks?.length,"scheduled task")}</span></div>{pluginDetail.skills?.length>0&&<div className="plugin-detail-skills">{pluginDetail.skills.map(skill=><div key={skill.name}><div><strong>{skill.interface?.displayName||skill.name}</strong><span>{skill.interface?.shortDescription||skill.shortDescription||skill.description}</span></div>{pluginDetail.summary?.remotePluginId&&pluginDetail.marketplaceName&&<ActionButton busy={busy} doing={busy==="plugin:skill:"+skill.name&&"Reading…"} onPress={()=>readPluginSkill(skill)}>Read skill</ActionButton>}</div>)}</div>}{pluginSkillDetail&&<details className="capability-details" open><summary>{pluginSkillDetail.name} · SKILL.md</summary><pre>{pluginSkillDetail.contents||"No skill contents were returned."}</pre></details>}</div>}
        {pluginMessage&&<p className="capability-status">{pluginMessage}</p>}
        <ErrorLine value={errors["plugin/list"]}/><ErrorLine value={errors["plugin/install"]}/><ErrorLine value={errors["plugin/uninstall"]}/><ErrorLine value={errors["plugin/search"]}/><ErrorLine value={errors["plugin/read"]}/><ErrorLine value={errors["plugin/skill/read"]}/><ErrorLine value={errors["plugin/reconcile"]}/><ErrorLine value={errors["plugin/share/save"]}/>
      </Section>

      <Section title="Shared plugins" icon={Blocks} count={counted(data.sharedPlugins,"plugin/share/list")}>
        <p>Codex plugin sharing is account-backed. Local plugins are first shared privately; visibility can then be changed without inventing recipients.</p>
        {/* The checkout, delete or visibility change Codex is still answering says so on its row, marked busy, and a visibility change
            shows the visibility chosen (it showed the old one, as if refused); the page's other actions wait. Its control keeps the
            keyboard (it only says it is off): disabled under it, it dropped the focus on the page, where a second arrow key scrolled. */}
        <div className="capability-list shared-plugin-list">{(data.sharedPlugins||[]).map(item=>{const plugin=item.plugin||{};const context=plugin.shareContext||{};const remotePluginId=plugin.remotePluginId||context.remotePluginId,checking=busy==="checkout:"+remotePluginId,deleting=busy==="delete-share:"+remotePluginId,visibilityKey="share-visibility:"+remotePluginId+"=",changing=busy.startsWith(visibilityKey)&&busy.slice(visibilityKey.length);return <div key={remotePluginId||plugin.id}><div><strong>{plugin.name||plugin.id}</strong><span>{plugin.version||plugin.localVersion||"shared plugin"}{context.creatorName?` · ${context.creatorName}`:""}</span></div><div className="capability-inline-actions">{context.shareUrl&&<button onClick={()=>openWebLink(context.shareUrl)}>Open</button>}{!item.localPluginPath&&remotePluginId&&<ActionButton busy={busy} doing={checking&&"Checking out…"} onPress={()=>checkoutSharedPlugin(item)}>Checkout</ActionButton>}{context.discoverability&&<select value={changing||context.discoverability} onChange={e=>{if(!busy)updateShareDiscoverability(item,e.target.value)}} disabled={!!busy&&!changing} aria-disabled={!!changing||undefined} aria-busy={!!changing||undefined}><option value="PRIVATE">Private</option><option value="UNLISTED">Unlisted</option><option value="LISTED">Listed</option></select>}{changing&&<em>saving…</em>}{remotePluginId&&<ActionButton busy={busy} doing={deleting&&"Deleting…"} onPress={()=>deleteSharedPlugin(item)}>Delete share</ActionButton>}</div></div>})}</div>
        {!data.sharedPlugins?.length&&<EmptyState loaded={!!data.sharedPlugins} loading={loading} error={errors["plugin/share/list"]} pending="Loading shared plugins…">No shared plugins were returned for this account.</EmptyState>}
        <ErrorLine value={errors["plugin/share/list"]}/><ErrorLine value={errors["plugin/share/checkout"]}/><ErrorLine value={errors["plugin/share/delete"]}/><ErrorLine value={errors["plugin/share/updateTargets"]}/>
      </Section>

      <Section title="Marketplaces" icon={Blocks} count={counted(data.marketplaces,"plugin/list")}>
        <div className="capability-actions marketplace-add"><input value={marketplaceSource} onChange={e=>setMarketplaceSource(e.target.value)} placeholder="Git URL or local path" title="Marketplace source: a Git URL or a local path"/><ActionButton busy={busy} doing={busy==="marketplace:add"&&"Adding…"} off={!marketplaceSource.trim()} onPress={addMarketplace}>Add</ActionButton><ActionButton busy={busy} doing={busy==="upgrade-all"&&"Upgrading…"} off={!data.marketplaces?.length} onPress={()=>upgradeMarketplace(null)}>Upgrade all</ActionButton></div>
        <div className="capability-list">{(data.marketplaces||[]).map(marketplace=><div key={marketplace.name}><div><strong>{marketplace.interface?.displayName||marketplace.name}</strong><span>{marketplace.path||countLabel((marketplace.plugins||[]).length,"catalog plugin")}</span></div><div className="capability-inline-actions"><ActionButton busy={busy} doing={busy==="upgrade:"+marketplace.name&&"Upgrading…"} onPress={()=>upgradeMarketplace(marketplace.name)}>Upgrade</ActionButton>{marketplace.path&&<ActionButton busy={busy} doing={busy==="remove:"+marketplace.name&&"Removing…"} onPress={()=>removeMarketplace(marketplace.name)}>Remove</ActionButton>}</div></div>)}</div>
        <ErrorLine value={errors["marketplace/add"]}/><ErrorLine value={errors["marketplace/remove"]}/><ErrorLine value={errors["marketplace/upgrade"]}/>
      </Section>

      <Section title="Apps / connectors" icon={CheckCircle2} count={counted(data.apps,"app/list")}>
        <div className="connector-runtime-summary"><span>{data.installedApps?`${data.installedApps.length} installed · ${data.installedApps.filter(app=>app.callable).length} callable now`:""}</span><button onClick={refreshInstalledApps} disabled={!!busy}>{busy==="apps:installed"?"Refreshing…":"Refresh runtime"}</button></div>
        <div className="capability-list">{(data.apps||[]).map(app=>{const runtime=installedAppsById[app.id];const status=runtime?(runtime.callable?"callable":runtime.enabled?"installed":"disabled"):(app.isEnabled?"catalog only":"disabled");return <div key={app.id}><div><strong>{app.name}</strong><span>{app.description||app.id}</span></div><div className="capability-inline-actions"><em className={runtime?.callable?"ok":""}>{status}</em><button onClick={()=>readApp(app)} disabled={busy==="app:"+app.id}>Details</button></div></div>})}</div>
        {!data.apps?.length&&<EmptyState loaded={!!data.apps} loading={loading} error={errors["app/list"]} pending="Loading app connectors…">No app connectors reported by Codex.</EmptyState>}
        {appDetail&&<div className="app-detail"><div className="app-detail-head"><div><strong>{appDetail.name}</strong><span>{appDetail.distributionChannel||appDetail.id}</span></div><button onClick={()=>setAppDetail(null)}>Close</button></div>{appDetail.description&&<p>{appDetail.description}</p>}{appDetail.pluginDisplayNames?.length>0&&<p>Provided by: {appDetail.pluginDisplayNames.join(", ")}</p>}{appDetail.installUrl&&<button className="setting-action" onClick={()=>openWebLink(appDetail.installUrl)}>Open install page</button>}{appDetail.toolSummaries?.length>0&&<div className="app-tools">{appDetail.toolSummaries.map(tool=><div key={tool.name}><div><strong>{tool.title||tool.name}</strong><span>{tool.description||tool.name}</span></div><em className={tool.isEnabled?"ok":""}>{tool.isEnabled?(tool.isReadOnly?"read only":"enabled"):(tool.disabledReason||"disabled")}</em></div>)}</div>}</div>}
        <ErrorLine value={errors["app/list"]}/><ErrorLine value={errors["app/installed"]}/><ErrorLine value={errors["app/read"]}/>
      </Section>

      <Section title="Hooks" icon={Wrench} count={counted(data.hooks,"hooks/list",hookCount)}>
        <div className="capability-list">{(data.hooks||[]).flatMap(entry=>(entry.hooks||[]).map((hook,index)=><div key={entry.cwd+":"+index}><div><strong>{hook.name||hook.event||"Hook"}</strong><span>{entry.cwd}</span></div><em className="ok">loaded</em></div>))}</div>
        {!hookCount&&<EmptyState loaded={!!data.hooks} loading={loading} error={errors["hooks/list"]} pending="Loading hooks…">No project hooks loaded.</EmptyState>}
        {hookRuns.length>0&&<details className="capability-details" open><summary>Recent hook runs · {hookRuns.length}</summary><div className="capability-list hook-run-list">{hookRuns.map(run=><div key={run.id}><div><strong>{run.eventName||run.id}</strong><span>{run.statusMessage||run.sourcePath||run.handlerType||"Hook execution"}</span></div><em className={run.status==="completed"||run.status==="success"?"ok":""}>{run.durationMs!=null?`${Number(run.durationMs).toLocaleString()} ms`:run.status||"running"}</em></div>)}</div></details>}
        <ErrorLine value={errors["hooks/list"]}/>
      </Section>

      <Section title="Experimental features" icon={FlaskConical} count={counted(data.features,"experimentalFeature/list")}>
        {!data.features?.length&&<EmptyState loaded={!!data.features} loading={loading} error={errors["experimentalFeature/list"]} pending="Loading experimental features…">This runtime reported no experimental features.</EmptyState>}
        <div className="capability-list feature-list">{(data.features||[]).map(feature=><div key={feature.name}><div><strong>{feature.displayName||feature.name}</strong><span>{feature.description||feature.stage}</span></div><button className={feature.enabled?"active":""} onClick={()=>toggleFeature(feature)} disabled={!!busy}>{feature.enabled?"On":"Off"}</button></div>)}</div>
        <ErrorLine value={errors["experimentalFeature/list"]}/><ErrorLine value={errors["experimentalFeature/enablement/set"]}/>
      </Section>

      <Section title="Conversation history" icon={RefreshCw} count={listCount(historyImport&&(historyImport.sessions||[]),{loading:busy==="history:scan",error:historyScanFailed})}>
        <p>Copy recent local Codex and Claude conversations into Trebell. Source transcripts stay untouched; imported Codex sessions become independent Trebell forks.</p>
        <div className="capability-actions">
          <button onClick={scanHistory} disabled={!!busy}>{busy==="history:scan"?"Scanning…":"Scan history"}</button>
          {/* A page drawn again while an import runs has no scan to offer it from, and says Importing… all the same. */}
          {(busy==="history:import"||(historyImport?.sessions||[]).some(item=>!item.alreadyImported&&(item.source!=="codex"||historyImport.codexImportAvailable)))&&<button onClick={()=>importHistory((historyImport.sessions||[]).filter(item=>!item.alreadyImported&&(item.source!=="codex"||historyImport.codexImportAvailable)).map(item=>item.id))} disabled={!!busy}>{busy==="history:import"?"Importing…":"Import available"}</button>}
        </div>
        {historyMessage&&<p ref={historyMessageRef} className={/failed|could not|error/i.test(historyMessage)?"provider-status-error":"capability-status"} role={/failed|could not|error/i.test(historyMessage)?"alert":undefined}>{historyMessage}</p>}
        <div className="capability-list history-import-list">{(historyImport?.sessions||[]).slice(0,30).map(item=><div key={item.id}><div><strong>{item.title||"Untitled conversation"}</strong><span>{item.source==="codex"?"Codex":"Claude"} · {item.cwd}</span></div><div className="capability-inline-actions"><em className={item.alreadyImported?"ok":""} title={!item.alreadyImported&&item.source==="codex"&&!historyImport.codexImportAvailable?historyImport.codexImportUnavailable?.message||undefined:undefined}>{item.alreadyImported?"imported":item.source==="codex"&&!historyImport.codexImportAvailable?"needs local Codex":"available"}</em>{!item.alreadyImported&&(item.source!=="codex"||historyImport.codexImportAvailable)&&<button onClick={()=>importHistory([item.id])} disabled={!!busy}>Import</button>}</div></div>)}</div>
        {/* Claimed only for the latest scan: not while the next one runs (its button says so) and not beside a failed one. */}
        {historyImport&&!(historyImport.sessions||[]).length&&busy!=="history:scan"&&!historyScanFailed&&<p>No recent local agent history was found.</p>}
      </Section>

      <Section title="Import agent configuration" icon={RefreshCw} count={migrations?(migrations.items||[]).length:undefined}>
        <p>Detect reusable configuration from supported external coding agents in your home directory and this workspace.</p>
        <div className="capability-actions"><button onClick={detectExternalConfig} disabled={!!busy||!!migrationImportId}>Scan</button>{(migrationImportId||migrations?.items?.length>0)&&<button onClick={importExternalConfig} disabled={!!busy||!!migrationImportId}>{migrationImportId?"Importing…":"Import "+migrations.items.length+(migrations.items.length===1?" item":" items")}</button>}</div>
        <div className="capability-list">{(migrations?.items||[]).map((item,index)=><div key={index}><div><strong>{item.description||humanizeIdentifier(item.itemType)}</strong><span>{item.cwd||"User scope"}</span></div><em>{humanizeIdentifier(item.itemType)}</em></div>)}</div>
        {(migrations?.connectors||[]).length>0&&<p>{migrations.connectors.length} connector candidate{migrations.connectors.length===1?"":"s"} detected.</p>}
        {migrationMessage&&<p className="capability-status">{migrationMessage}</p>}
        {migrationFailures.length>0&&<ImportFailureList failures={migrationFailures}/>}
        {/* A history row with failures opens to list them; its badge names how many failed and is the toggle. */}
        {(migrationHistory.data||[]).length>0&&<details className="capability-details"><summary>Previous native imports · {migrationHistory.data.length}</summary><div className="capability-list migration-history-list">{migrationHistory.data.slice(0,8).map(entry=>{const successes=entry.successes?.length||0,failures=importFailures([{failures:entry.failures}]),completed=Number(entry.completedAtMs)>0?new Date(Number(entry.completedAtMs)).toLocaleString():"";const head=<div><strong>{entry.providerId?agentName(entry.providerId):"External agent import"}</strong><span>{[completed,successes+" imported"].filter(Boolean).join(" · ")}</span></div>;return failures.length?<details key={entry.importId}><summary>{head}<em className="warn"><ChevronRight size={11} aria-hidden="true"/>{failures.length} failed</em></summary><ImportFailureList failures={failures}/></details>:<div key={entry.importId}>{head}<em className="ok">done</em></div>})}</div></details>}
        {(migrationHistory.connectors||[]).length>0&&<details className="capability-details"><summary>Imported connector candidates · {migrationHistory.connectors.length}</summary><div className="capability-list">{migrationHistory.connectors.map(item=><div key={item.name}><div><strong>{item.name}</strong><span>{Number(item.sessionCount||0).toLocaleString()} imported session{Number(item.sessionCount||0)===1?"":"s"}</span></div><em>candidate</em></div>)}</div></details>}
        <ErrorLine value={errors["externalAgentConfig/detect"]}/><ErrorLine value={errors["externalAgentConfig/import"]}/><ErrorLine value={errors["externalAgentConfig/import/readHistories"]}/>
      </Section>
    </div>
    </div>
  </>;
}
