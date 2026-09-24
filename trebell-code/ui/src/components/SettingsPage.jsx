import React,{useEffect,useRef,useState} from "react";
import { Activity, Bot, Download, FileText, HardDrive, Keyboard, MonitorCog, Palette, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { api } from "../api.js";
import { KEYBINDING_COMMANDS, normalizeKeybindingRules } from "../keybindings.js";
import { searchSettings } from "../settings-search.js";
import { normalizeCustomTheme } from "../theme-utils.js";
import ScopedSettingsCard from "./ScopedSettingsCard.jsx";

const PROVIDER_LABELS={
  freebuff:"Freebuff",
  agentrouter:"AgentRouter",
  justworker:"JustWorker.icu",
  hcnsec:"HCNSec.cn",
  vyceai:"VyceAi",
};

export default function SettingsPage({settings,onSettings,onProviderChanging,onProviderUpdated,runtime,rpcStatus,loggedIn,login,logout,projectPath,runtimeEnvironmentId=null,onOpenRuntimeAuthTerminal,projectScripts=[],modelError,onOpenLicenses,models=[],onScopedSettingsChanged,environmentThemeCatalog={environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]},environmentThemes=[],onRefreshEnvironmentThemes}){
  const [settingsSection,setSettingsSection]=useState("general");
  const [settingsSearch,setSettingsSearch]=useState("");
  const [workspaceScope,setWorkspaceScope]=useState({environmentId:settings.activeEnvironmentId||"local",projectId:""});
  const [workspaceScopeCatalog,setWorkspaceScopeCatalog]=useState({environmentData:{profiles:[]},projects:[]});
  const [update,setUpdate]=useState(null);
  const [desktopUpdate,setDesktopUpdate]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [loading,setLoading]=useState(false);
  const [providerInfo,setProviderInfo]=useState(null);
  const [apiKey,setApiKey]=useState("");
  const [providerMessage,setProviderMessage]=useState("");
  const [settingsError,setSettingsError]=useState("");
  const [environmentThemeRefreshing,setEnvironmentThemeRefreshing]=useState(false);
  const [providerSwitching,setProviderSwitching]=useState(false);
  const [freebuffAuthBusy,setFreebuffAuthBusy]=useState(false);
  const [freebuffAuthError,setFreebuffAuthError]=useState(false);
  const [agentInfo,setAgentInfo]=useState(null);
  const [agentMessage,setAgentMessage]=useState("");
  const [installingAgent,setInstallingAgent]=useState(null);
  const [authenticatingAgent,setAuthenticatingAgent]=useState(null);
  const [instanceDraft,setInstanceDraft]=useState(null);
  const [modelDraft,setModelDraft]=useState({id:"",name:"",effort:"",serviceTier:"",inputPrice:"",outputPrice:"",cacheReadPrice:"",cacheWritePrice:""});
  const [customModelEditorOpen,setCustomModelEditorOpen]=useState(false);
  const [snapshotInfo,setSnapshotInfo]=useState({enabled:false,shortcut:"CommandOrControl+Shift+S",includeText:false,playSound:true,sound:"soft-pop",flash:true,animations:true,registered:false,pending:0});
  const [snapshotMessage,setSnapshotMessage]=useState("");
  const [browserImport,setBrowserImport]=useState({sources:[],platform:null});
  const [browserImportProfile,setBrowserImportProfile]=useState("");
  const [browserImportMessage,setBrowserImportMessage]=useState("");
  const [browserImportBusy,setBrowserImportBusy]=useState(false);
  const [storageInfo,setStorageInfo]=useState(null);
  const [storageMessage,setStorageMessage]=useState("");
  const [storageBusy,setStorageBusy]=useState(false);
  const [themeDraft,setThemeDraft]=useState(null);
  const [themeMessage,setThemeMessage]=useState("");
  const themeImportRef=useRef(null);
  const selected=settings.modelProvider||"freebuff";
  const selectedAgent=settings.agentRuntime||runtime?.agentRuntime||"codex";
  const keybindingRules=normalizeKeybindingRules(settings);
  function updateKeybinding(command,patch){
    const found=keybindingRules.some(rule=>rule.command===command);
    const next=found?keybindingRules.map(rule=>rule.command===command?{...rule,...patch}:rule):[...keybindingRules,{command,key:String(patch.key||""),when:String(patch.when||"projectOpen && !modalOpen")}];
    return save({keybindingRules:next});
  }

  async function loadProviders({strict=false}={}){
    try{
      const info=await api("/api/providers");
      setProviderInfo(info);
      return info;
    }catch(error){
      if(strict)throw error;
      const fallback=providerInfo||{error:error?.message||String(error),providers:[]};
      if(!providerInfo)setProviderInfo(fallback);
      return fallback;
    }
  }
  async function loadAgentRuntimes({strict=false}={}){
    try{
      const info=await api("/api/agent-runtimes");
      setAgentInfo(info);return info;
    }catch(error){
      if(strict)throw error;
      const fallback=agentInfo||{error:error?.message||String(error),definitions:[],instances:[],statuses:[]};
      if(!agentInfo)setAgentInfo(fallback);
      return fallback;
    }
  }
  async function selectAgentRuntime(kind,instanceId=null){
    setAgentMessage("Switching…");
    try{
      const result=await api("/api/agent-runtimes",{method:"POST",body:{action:"select",runtime:kind,instanceId}});
      setAgentInfo(result);
      onSettings(await api("/api/settings"));
      setAgentMessage(`${result.selected?.status?.name||kind} selected.`);
      await onProviderUpdated?.({agentRuntime:result.selectedRuntime||kind,provider:selected,resetThread:true});
    }catch(error){setAgentMessage(error.message)}
  }
  function editInstance(instance=null){
    setInstanceDraft(instance?{...instance}:{
      id:`${selectedAgent}-${crypto.randomUUID()}`,kind:selectedAgent,displayName:`${(agentInfo?.definitions||[]).find(item=>item.id===selectedAgent)?.name||selectedAgent} profile`,binaryPath:"",homePath:"",serverUrl:"",autoCompactWindow:"",
    });
  }
  async function saveInstance(){
    if(!instanceDraft)return;
    setAgentMessage("Saving runtime profile…");
    try{
      const instance={...instanceDraft};delete instance.environmentKeys;
      const result=await api("/api/agent-runtimes",{method:"POST",body:{action:"upsert",instance}});
      setAgentInfo(result);setInstanceDraft(null);setAgentMessage("Runtime profile saved.");
      if(result.selectedInstanceId===instance.id){onSettings(await api("/api/settings"));await onProviderUpdated?.({resetThread:true})}
    }catch(error){setAgentMessage(error.message)}
  }
  async function removeInstance(instance){
    if(!instance||instance.id===`${instance.kind}-default`)return;
    setAgentMessage("Removing runtime profile…");
    try{
      const result=await api("/api/agent-runtimes?id="+encodeURIComponent(instance.id),{method:"DELETE"});
      setAgentInfo(result);setInstanceDraft(null);onSettings(await api("/api/settings"));setAgentMessage("Runtime profile removed.");
      if(result.resetTo)await onProviderUpdated?.({resetThread:true});
    }catch(error){setAgentMessage(error.message)}
  }
  async function installAgentRuntime(kind){
    const definition=(agentInfo?.definitions||[]).find(item=>item.id===kind);if(!definition?.installable)return;
    const label=definition.name||kind;const packageName=definition.packageName||"the official package";
    if(!confirm("Install or update "+label+" in the selected environment?\n\nTrebell will run: npm install -g "+packageName))return;
    setInstallingAgent(kind);setAgentMessage("Installing "+label+"…");
    try{
      const result=await api("/api/agent-runtimes",{method:"POST",body:{action:"install",runtime:kind,environmentId:settings.activeEnvironmentId||null}});
      setAgentInfo(result);
      const status=result.installed?.status;
      setAgentMessage(status?.installed&&!status?.authenticated?label+" installed. Sign in with the CLI, then refresh diagnostics.":label+" installed and ready.");
      await onProviderUpdated?.({resetThread:true});
    }catch(error){setAgentMessage(error.message)}finally{setInstallingAgent(null)}
  }
  async function authenticateAgentRuntime(kind,instanceId){
    const definition=(agentInfo?.definitions||[]).find(item=>item.id===kind);if(!definition?.canAuthenticate)return;
    setAuthenticatingAgent(instanceId||kind);setAgentMessage("Opening "+(definition.name||kind)+" sign in…");
    try{
      const result=await api("/api/agent-runtime-auth",{method:"POST",body:{action:"login",runtime:kind,instanceId:instanceId||null,environmentId:runtimeEnvironmentId||null,cwd:projectPath||null}});
      setAgentMessage("Complete sign in in the terminal, then refresh runtime status.");
      onOpenRuntimeAuthTerminal?.(result.session);
    }catch(error){setAgentMessage(error.message)}
    finally{setAuthenticatingAgent(null)}
  }
  async function save(patch){
    setSettingsError("");
    if("appearance" in patch&&environmentThemeCatalog?.environmentKey){
      const selections={...(settings.environmentThemeSelections||{})};
      delete selections[environmentThemeCatalog.environmentKey];
      patch={...patch,environmentThemeSelections:selections};
    }
    const providerChange="modelProvider" in patch&&patch.modelProvider!==settings.modelProvider;
    const optimistic=providerChange?{...settings,modelProvider:patch.modelProvider}:null;
    if(providerChange)setProviderSwitching(true);
    if(optimistic){onProviderChanging?.(patch.modelProvider);onSettings(optimistic)}
    let next;
    try{next=await api("/api/settings",{method:"POST",body:patch})}
    catch(error){
      if(optimistic){onProviderChanging?.(settings.modelProvider||"freebuff");onSettings(settings)}
      if(providerChange)setProviderSwitching(false);
      setSettingsError(error?.message||String(error)||"Could not save settings.");
      throw error;
    }
    onSettings(next);
    if("modelProvider" in patch){
      setApiKey("");
      setProviderMessage("");
      setFreebuffAuthError(false);
      try{
        const refreshPromise=onProviderUpdated?.({provider:next.modelProvider||patch.modelProvider,agentRuntime:next.agentRuntime||selectedAgent});
        await Promise.all([loadProviders(),refreshPromise]);
      }finally{if(providerChange)setProviderSwitching(false)}
    }
    if("customModels" in patch)await onProviderUpdated?.();
    return next;
  }
  async function setBackgroundMode(enabled){
    const previous=Boolean(settings.backgroundMode);setSettingsError("");
    try{
      await window.trebellDesktop.background.set(enabled);
      await save({backgroundMode:enabled});
    }catch(error){
      if(enabled!==previous){
        try{await window.trebellDesktop.background.set(previous)}catch{}
      }
      setSettingsError(error?.message||String(error)||"Could not update background mode.");
    }
  }
  async function changeFreebuffAuth(){
    if(freebuffAuthBusy)return;
    setFreebuffAuthBusy(true);setFreebuffAuthError(false);setProviderMessage(loggedIn?"Signing out…":"Waiting for Freebuff sign-in…");
    try{
      if(loggedIn){await logout?.();setProviderMessage("Signed out.")}
      else{await login?.();setProviderMessage("Signed in.")}
      await loadProviders();
    }catch(error){setFreebuffAuthError(true);setProviderMessage(error?.message||String(error)||"Freebuff authentication failed.")}
    finally{setFreebuffAuthBusy(false)}
  }
  async function selectEnvironmentTheme(theme){
    if(!theme?.publishedId||!environmentThemeCatalog?.environmentKey)return;
    const selections={...(settings.environmentThemeSelections||{}),[environmentThemeCatalog.environmentKey]:theme.publishedId};
    await save({environmentThemeSelections:selections});
  }
  async function refreshPublishedThemes(){
    if(environmentThemeRefreshing)return;
    setSettingsError("");setEnvironmentThemeRefreshing(true);
    try{await onRefreshEnvironmentThemes?.({strict:true})}
    catch(error){setSettingsError("Could not refresh published themes: "+(error?.message||String(error)))}
    finally{setEnvironmentThemeRefreshing(false)}
  }
  async function stopFollowingEnvironmentTheme(){
    if(!environmentThemeCatalog?.environmentKey)return;
    const selections={...(settings.environmentThemeSelections||{})};delete selections[environmentThemeCatalog.environmentKey];
    await save({environmentThemeSelections:selections});
  }
  async function duplicateEnvironmentTheme(theme){
    if(!theme)return;
    const copy=normalizeCustomTheme({...theme,name:`${theme.name} copy`},{id:`custom-${crypto.randomUUID()}`});
    const selections={...(settings.environmentThemeSelections||{})};delete selections[environmentThemeCatalog.environmentKey];
    const current=Array.isArray(settings.customThemes)?settings.customThemes:[];
    await save({customThemes:[...current,copy],appearance:copy.id,environmentThemeSelections:selections});
    setThemeDraft(copy);setThemeMessage("Published theme duplicated as an editable local theme.");
  }
  function createTheme(){
    const light=(settings.appearanceMode||"system")==="light";
    setThemeDraft({id:`custom-${crypto.randomUUID()}`,name:"Custom theme",appearance:light?"light":"dark",canvas:light?"#f3f5f9":"#0c0f16",accent:"#9c6cff",colors:{}});setThemeMessage("");
  }
  async function saveTheme(){
    if(!themeDraft)return;
    try{
      const theme=normalizeCustomTheme(themeDraft,{id:themeDraft.id});const current=Array.isArray(settings.customThemes)?settings.customThemes:[];
      await save({customThemes:[...current.filter(item=>item.id!==theme.id),theme],appearance:theme.id});setThemeDraft(theme);setThemeMessage("Theme saved and applied.");
    }catch(error){setThemeMessage(error.message||String(error))}
  }
  async function removeTheme(theme){
    const current=Array.isArray(settings.customThemes)?settings.customThemes:[];const patch={customThemes:current.filter(item=>item.id!==theme.id)};
    if(settings.appearance===theme.id)patch.appearance="dark";
    await save(patch);if(themeDraft?.id===theme.id)setThemeDraft(null);setThemeMessage("Theme removed.");
  }
  async function importThemeFile(event){
    const file=event.target.files?.[0];event.target.value="";if(!file)return;
    try{
      const parsed=JSON.parse(await file.text());const source=Array.isArray(parsed)?parsed[0]:parsed;const theme=normalizeCustomTheme(source,{id:`custom-${crypto.randomUUID()}`});const current=Array.isArray(settings.customThemes)?settings.customThemes:[];
      await save({customThemes:[...current,theme],appearance:theme.id});setThemeDraft(theme);setThemeMessage(`Imported ${theme.name}.`);
    }catch(error){setThemeMessage("Import failed: "+(error.message||String(error)))}
  }
  function exportTheme(theme){
    const blob=new Blob([JSON.stringify(theme,null,2)+"\n"],{type:"application/json"});const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download=(theme.name||"trebell-theme").replace(/[^a-z0-9._-]+/gi,"-").replace(/^-|-$/g,"")+".json";anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);
  }
  async function addCustomModel(){
    const id=modelDraft.id.trim();if(!id)return;
    if(selectedAgent==="opencode"&&!id.includes("/")){setAgentMessage("OpenCode custom models must use provider/model format.");return}
    const provider=selectedAgent==="codex"?selected:null;
    const entry={
      id,name:modelDraft.name.trim()||id,runtime:selectedAgent,provider,
      effort:modelDraft.effort||null,serviceTier:modelDraft.serviceTier||null,
      inputPrice:modelDraft.inputPrice===""?null:Number(modelDraft.inputPrice),
      outputPrice:modelDraft.outputPrice===""?null:Number(modelDraft.outputPrice),
      cacheReadPrice:modelDraft.cacheReadPrice===""?null:Number(modelDraft.cacheReadPrice),
      cacheWritePrice:modelDraft.cacheWritePrice===""?null:Number(modelDraft.cacheWritePrice),
    };
    for(const key of ["inputPrice","outputPrice","cacheReadPrice","cacheWritePrice"])if(entry[key]!=null&&!Number.isFinite(entry[key])){setAgentMessage("Custom model prices must be valid numbers.");return}
    const current=Array.isArray(settings.customModels)?settings.customModels:[];
    const next=[...current.filter(item=>!(item.id===id&&item.runtime===selectedAgent&&(selectedAgent!=="codex"||item.provider===selected))),entry];
    await save({customModels:next});setModelDraft({id:"",name:"",effort:"",serviceTier:"",inputPrice:"",outputPrice:"",cacheReadPrice:"",cacheWritePrice:""});setCustomModelEditorOpen(false);setAgentMessage("Custom model saved.");
  }
  async function removeCustomModel(item){
    const current=Array.isArray(settings.customModels)?settings.customModels:[];
    await save({customModels:current.filter(candidate=>!(candidate.id===item.id&&candidate.runtime===item.runtime&&candidate.provider===item.provider))});
  }
  async function saveProviderKey(){
    if(selected==="freebuff")return;
    setProviderMessage("Saving…");
    try{
      const result=await api("/api/providers",{method:"POST",body:{provider:selected,apiKey}});
      setApiKey("");
      setProviderInfo(result);
      setProviderMessage(result.ready?"API key saved. Harness ready.":"API key saved.");
      await onProviderUpdated?.();
    }catch(error){setProviderMessage(error.message)}
  }
  async function clearProviderKey(){
    if(selected==="freebuff")return;
    setProviderMessage("Removing…");
    try{
      const result=await api("/api/providers",{method:"POST",body:{provider:selected,apiKey:""}});
      setApiKey("");
      setProviderInfo(result);
      setProviderMessage("API key removed.");
      await onProviderUpdated?.();
    }catch(error){setProviderMessage(error.message)}
  }
  async function refresh({reportErrors=false}={}){
    setLoading(true);if(reportErrors)setSettingsError("");
    const results=await Promise.allSettled([
      api("/api/update/check"),
      api("/api/diagnostics?path="+encodeURIComponent(projectPath||"")),
      loadProviders({strict:reportErrors}),
      loadAgentRuntimes({strict:reportErrors}),
      loadStorageInfo({strict:reportErrors}),
    ]);
    const failures=results.filter(item=>item.status==="rejected").map(item=>item.reason);
    if(results[0].status==="fulfilled")setUpdate(results[0].value);
    else if(!update)setUpdate({error:results[0].reason?.message||String(results[0].reason)});
    if(results[1].status==="fulfilled")setDiagnostics(results[1].value);
    else if(!diagnostics)setDiagnostics({error:results[1].reason?.message||String(results[1].reason)});
    if(reportErrors&&failures.length)setSettingsError("Could not refresh diagnostics: "+failures.map(error=>error?.message||String(error)).join(" · "));
    setLoading(false);
    if(window.trebellDesktop?.updates)window.trebellDesktop.updates.get().then(info=>{setDesktopUpdate(info);setSettingsError(current=>/^Could not load desktop update state:/.test(current)?"":current)}).catch(error=>setSettingsError("Could not load desktop update state: "+(error?.message||String(error))));
    if(window.trebellDesktop?.snapshots)window.trebellDesktop.snapshots.get().then(info=>{setSnapshotInfo(info);setSnapshotMessage(current=>/^Could not load SnapShot settings:/.test(current)?"":current)}).catch(error=>setSnapshotMessage("Could not load SnapShot settings: "+(error?.message||String(error))));
    if(window.trebellDesktop?.browser?.importSources)loadBrowserImportSources();
    return failures.length===0;
  }
  async function loadStorageInfo({strict=false}={}){
    try{
      const info=await api("/api/storage-cleanup");
      setStorageInfo(info);return info;
    }catch(error){
      if(strict)throw error;
      const fallback=storageInfo||{error:error?.message||String(error)};
      if(!storageInfo)setStorageInfo(fallback);
      return fallback;
    }
  }
  async function saveStorageRetention(key,raw){
    const text=String(raw??"").trim();
    const value=text?Math.max(1,Math.min(3650,Math.trunc(Number(text)||0))):null;
    const current=settings.storageCleanup||{};
    await save({storageCleanup:{...current,[key]:value||null}});
    await loadStorageInfo();
  }
  async function runStorageCleanup(){
    setStorageBusy(true);setStorageMessage("Running safe cleanup…");
    try{
      const result=await api("/api/storage-cleanup",{method:"POST",body:{}});
      const worktrees=Number(result.worktrees?.removed)||0,attachments=Number(result.attachments?.removed)||0,terminals=Number(result.terminalHistory?.removed)||0;
      setStorageMessage(`Removed ${worktrees} managed worktree${worktrees===1?"":"s"}, ${attachments} attachment cache file${attachments===1?"":"s"}, and ${terminals} stopped terminal histor${terminals===1?"y":"ies"}.`);
      await loadStorageInfo();
    }catch(error){setStorageMessage("Cleanup failed: "+error.message)}
    finally{setStorageBusy(false)}
  }
  async function loadBrowserImportSources({strict=false}={}){
    try{
      const info=await window.trebellDesktop?.browser?.importSources?.();if(!info)return null;
      setBrowserImport(info);const profiles=info.sources?.flatMap(source=>source.profiles||[])||[];
      setBrowserImportProfile(current=>profiles.some(profile=>profile.id===current)?current:(profiles[0]?.id||""));
      setBrowserImportMessage(current=>/^Could not scan browser profiles:/.test(current)?"":current);
      return info;
    }catch(error){
      setBrowserImportMessage("Could not scan browser profiles: "+(error?.message||String(error)));
      if(strict)throw error;
      return null;
    }
  }
  async function importBrowserProfile(){
    const source=browserImport.sources?.find(item=>item.profiles?.some(profile=>profile.id===browserImportProfile));if(!source||!browserImportProfile)return;
    setBrowserImportBusy(true);setBrowserImportMessage("Importing…");
    try{
      const result=await window.trebellDesktop.browser.importProfile(source.id,browserImportProfile);
      setBrowserImportMessage(`Imported ${result.imported} cookie${result.imported===1?"":"s"}${result.skipped?` · ${result.skipped} encrypted/partitioned skipped`:""}${result.failed?` · ${result.failed} failed`:""}.`);
      await loadBrowserImportSources();
    }catch(error){
      const primary=error?.message||String(error);
      const refreshed=await loadBrowserImportSources();
      setBrowserImportMessage(refreshed?primary:primary+" · Browser profile state could not be refreshed.");
    }
    finally{setBrowserImportBusy(false)}
  }
  async function configureSnapshots(patch){
    if(!window.trebellDesktop?.snapshots)return;
    setSnapshotMessage("Saving…");
    try{
      const next=await window.trebellDesktop.snapshots.configure({...snapshotInfo,...patch});
      setSnapshotInfo(next);setSnapshotMessage(next.enabled?"SnapShots ready.":"SnapShots disabled.");
    }catch(error){
      const primary=error?.message||String(error);
      try{
        const current=await window.trebellDesktop.snapshots.get();
        if(current)setSnapshotInfo(current);
        setSnapshotMessage(primary);
      }catch(reloadError){
        setSnapshotMessage(primary+" · Could not reload SnapShot settings: "+(reloadError?.message||String(reloadError)));
      }
    }
  }
  useEffect(()=>{refresh()},[projectPath]);
  useEffect(()=>{loadProviders()},[selected]);
  useEffect(()=>{loadAgentRuntimes()},[selectedAgent]);
  useEffect(()=>{
    setInstanceDraft(null);
    setCustomModelEditorOpen(false);
  },[selectedAgent]);
  useEffect(()=>{
    const unsubscribe=window.trebellDesktop?.updates?.onState?.(setDesktopUpdate);
    return typeof unsubscribe==="function"?unsubscribe:undefined;
  },[]);

  async function checkDesktopUpdate(){
    if(!window.trebellDesktop?.updates)return;
    try{setDesktopUpdate(await window.trebellDesktop.updates.check())}catch(error){setDesktopUpdate(prev=>({...prev,status:"error",error:error.message||String(error)}))}
  }
  async function downloadDesktopUpdate(){
    if(!window.trebellDesktop?.updates)return;
    try{setDesktopUpdate(await window.trebellDesktop.updates.download())}catch(error){setDesktopUpdate(prev=>({...prev,status:"error",error:error.message||String(error)}))}
  }
  async function installDesktopUpdate(){
    if(!window.trebellDesktop?.updates)return;
    const version=desktopUpdate?.availableVersion?` ${desktopUpdate.availableVersion}`:"";
    if(!window.confirm(`Install update${version} and restart Trebell Code?\n\nRunning agent tasks and terminal commands may be interrupted. ${settings.continueThreadsAfterRestart?"Supported active threads are configured to resume after restart.":"Restart recovery is off, so active threads will not automatically resume."}`))return;
    try{await window.trebellDesktop.updates.install()}catch(error){setDesktopUpdate(prev=>({...prev,status:"error",error:error.message||String(error)}))}
  }

  const updateStatusLabel={idle:"Ready to check",checking:"Checking…",available:"Update available",downloading:"Downloading…",downloaded:"Ready to install",installing:"Restarting…",current:"Up to date",error:"Update failed",development:"Development build"}[desktopUpdate?.status]||desktopUpdate?.status||"idle";

  const selectedStatus=providerInfo?.providers?.find(p=>p.id===selected)||providerInfo?.status;
  const selectedAgentStatus=agentInfo?.statuses?.find(item=>item.id===agentInfo?.selectedInstanceId)||agentInfo?.statuses?.find(item=>item.kind===selectedAgent);
  const selectedInstances=(agentInfo?.instances||[]).filter(item=>item.kind===selectedAgent);
  const customModels=(settings.customModels||[]).filter(item=>item.runtime===selectedAgent&&(selectedAgent!=="codex"||item.provider===selected));
  const desktopAvailable=Boolean(window.trebellDesktop);
  const settingsSections=[
    ["general",Settings2,"General","Everyday behavior, notifications and updates"],
    ["agents",Bot,"Agents & models","Harnesses, providers and model configuration"],
    ["workspace",HardDrive,"Workspace","Project defaults, storage and review lifecycle"],
    ["appearance",Palette,"Appearance","Theme, color mode and motion"],
    ...(desktopAvailable?[["desktop",MonitorCog,"Desktop","Computer use, browser profiles and SnapShots"]]:[]),
    ["shortcuts",Keyboard,"Shortcuts","Keyboard commands and conditions"],
    ["diagnostics",Activity,"Diagnostics","Runtime health and local logs"],
  ];
  const activeSettingsSection=settingsSections.find(item=>item[0]===settingsSection)||settingsSections[0];
  const availableSettingsSections=new Set(settingsSections.map(item=>item[0]));
  const searchResults=searchSettings(settingsSearch,{keybindings:KEYBINDING_COMMANDS,projectScripts}).filter(item=>availableSettingsSections.has(item.section)).slice(0,18);
  const settingsSectionLabels=Object.fromEntries(settingsSections.map(([id,,label])=>[id,label]));
  const workspaceEnvironmentValue=workspaceScope.environmentId==="local"?null:workspaceScope.environmentId;
  const workspaceProjects=workspaceScopeCatalog.projects.filter(project=>(project.environmentId||null)===(workspaceEnvironmentValue||null));
  const workspaceEnvironment=workspaceScope.environmentId==="local"?null:(workspaceScopeCatalog.environmentData.profiles||[]).find(profile=>profile.id===workspaceScope.environmentId);
  const workspaceProject=workspaceProjects.find(project=>project.id===workspaceScope.projectId)||null;
  function targetProps(id){return {"data-setting-target":id}}
  function openSearchResult(item){
    setSettingsSection(item.section);setSettingsSearch("");
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const exact=document.querySelector(`[data-setting-target="${item.id}"]`);
      const candidates=[...document.querySelectorAll(".settings-card,.settings-section-slot,.diagnostics-log,.keybinding-row")];
      const wanted=String(item.title||"").trim().toLowerCase();
      const fallback=candidates.find(node=>{
        const heading=node.querySelector("h3,strong");
        return String(heading?.textContent||"").trim().toLowerCase()===wanted;
      });
      const target=exact||fallback||document.querySelector(".settings-section-head");
      target?.scrollIntoView({block:"center",behavior:"smooth"});
      target?.classList.add("settings-search-hit");
      setTimeout(()=>target?.classList.remove("settings-search-hit"),1600);
    }));
  }
  return <div className="settings-page redesigned-settings">
    <aside className="settings-rail">
      <label className="settings-search-box"><Search size={13}/><input aria-label="Search settings" value={settingsSearch} onChange={event=>setSettingsSearch(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();setSettingsSearch("")}}} placeholder="Search settings…"/></label>
      {settingsSearch.trim()?<div className="settings-search-results" data-testid="settings-search-results">
        {searchResults.length?searchResults.map(item=><button key={item.id} type="button" onClick={()=>openSearchResult(item)}><strong>{item.title}</strong><span>{settingsSectionLabels[item.section]||item.section}</span>{item.description&&<small>{item.description}</small>}</button>):<p>No settings match “{settingsSearch.trim()}”.</p>}
      </div>:<nav className="settings-nav" aria-label="Settings categories">
        {settingsSections.map(([id,Icon,label,description])=><button key={id} type="button" className={settingsSection===id?"active":""} onClick={()=>setSettingsSection(id)} aria-current={settingsSection===id?"page":undefined}>
          <Icon size={15}/><span><strong>{label}</strong><small>{description}</small></span>
        </button>)}
      </nav>}
    </aside>
    <section className="settings-stage">
      <div className="settings-section-head"><div><h2>{activeSettingsSection[2]}</h2><p>{activeSettingsSection[3]}</p></div><span>{settingsSections.findIndex(item=>item[0]===settingsSection)+1} / {settingsSections.length}</span></div>
      {settingsError&&<p className="settings-action-error" role="alert">{settingsError}</p>}
      {settingsSection==="workspace"&&<div className="settings-scope-sentence" data-testid="settings-scope-sentence">
        <span>Applying settings for</span>
        <select aria-label="Project scope" value={workspaceScope.projectId} onChange={event=>setWorkspaceScope(current=>({...current,projectId:event.target.value}))}>
          <option value="">All projects</option>
          {workspaceProjects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <span>on</span>
        <select aria-label="Environment scope" value={workspaceScope.environmentId} onChange={event=>setWorkspaceScope({environmentId:event.target.value,projectId:""})}>
          <option value="local">Local machine</option>
          {(workspaceScopeCatalog.environmentData.profiles||[]).map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.type.toUpperCase()}</option>)}
        </select>
        <small>{workspaceProject?workspaceProject.path:(workspaceEnvironment?workspaceEnvironment.name+" defaults":"Local environment defaults")}</small>
      </div>}
      <div className="settings-grid">
      <div className="settings-card about-card" {...targetProps("general-about")} hidden={settingsSection!=="general"}>
        <div className="about-brand"><img src="/trebell-code-icon.svg" alt="" aria-hidden="true"/><div><h3>Trebell Code</h3><p>{desktopAvailable?"Desktop coding-agent harness":"Coding-agent workspace"}</p></div></div>
        <span className="about-version">v{diagnostics?.version||update?.current||"unknown"}</span><button onClick={onOpenLicenses}><FileText size={12}/> View licenses</button>
      </div>
      <div className="settings-card agent-runtime-settings" {...targetProps("agents-harness")} hidden={settingsSection!=="agents"}>
        <h3>Agent harness</h3>
        <p>Choose the coding-agent runtime. Only installed and ready runtimes can be activated.</p>
        <div className="agent-runtime-list">{(agentInfo?.definitions||[]).map(def=>{
          const status=(selectedAgent===def.id?agentInfo?.statuses?.find(item=>item.id===agentInfo?.selectedInstanceId):null)||agentInfo?.statuses?.find(item=>item.kind===def.id&&item.available)||agentInfo?.statuses?.find(item=>item.kind===def.id);
          const active=selectedAgent===def.id;
          const compatibility=status?.compatibility;const incompatible=["broken","unsupported"].includes(compatibility?.status);
          const unverified=status?.authenticated==null&&["cursor","grok","opencode"].includes(def.id)&&status?.message;
          const statusText=incompatible?(compatibility.message||"Incompatible runtime version"):unverified?status.message:status?.available?status?.version||"Ready":status?.message||"Unavailable";
          return <div className="agent-runtime-option" key={def.id}><button className={active?"active":""} disabled={!active&&!status?.available} onClick={()=>!active&&status?.available&&selectAgentRuntime(def.id,status.id)}>
            <Bot size={14}/><span><strong>{def.name}</strong><small>{statusText}</small></span><em>{active?(incompatible||unverified?"Warning":"Active"):status?.available?(incompatible||unverified?"Warning":"Use"):"Unavailable"}</em>
          </button>{def.canAuthenticate&&status?.installed&&status?.authenticated!==true&&<button className="agent-runtime-install" disabled={!!authenticatingAgent} onClick={()=>authenticateAgentRuntime(def.id,status?.id)}>{authenticatingAgent===(status?.id||def.id)?"Opening…":"Sign in"}</button>}{def.installable&&<button className="agent-runtime-install" disabled={installingAgent===def.id} onClick={()=>installAgentRuntime(def.id)}>{installingAgent===def.id?"Installing…":status?.installed?"Update":"Install"}</button>}</div>;
        })}</div>
        <div className="runtime-profiles" {...targetProps("agents-profiles")}>
          <div className="runtime-profiles-head"><strong>Profiles</strong><button onClick={()=>editInstance()} disabled={selectedAgent==="antigravity"}>Add profile</button></div>
          {selectedInstances.map(instance=>{
            const status=agentInfo?.statuses?.find(item=>item.id===instance.id);const active=agentInfo?.selectedInstanceId===instance.id;
            return <div className="runtime-profile-row" key={instance.id}>
              <button className={active?"active":""} disabled={!active&&!status?.available} onClick={()=>!active&&status?.available&&selectAgentRuntime(instance.kind,instance.id)}><span><strong>{instance.displayName||instance.id}</strong><small>{status?.available?status.version||"Ready":status?.message||"Unavailable"}</small></span><em>{active?"Active":"Use"}</em></button>
              {(agentInfo?.definitions||[]).find(item=>item.id===instance.kind)?.canAuthenticate&&status?.installed&&status?.authenticated!==true&&<button onClick={()=>authenticateAgentRuntime(instance.kind,instance.id)} disabled={!!authenticatingAgent}>{authenticatingAgent===instance.id?"Opening…":"Sign in"}</button>}
              <button onClick={()=>editInstance(instance)}>Edit</button>
              {instance.id!==`${instance.kind}-default`&&<button onClick={()=>removeInstance(instance)}>Remove</button>}
            </div>;
          })}
        </div>
        {instanceDraft&&<div className="runtime-profile-editor">
          <label>Profile name<input value={instanceDraft.displayName||""} onChange={e=>setInstanceDraft({...instanceDraft,displayName:e.target.value})}/></label>
          <label>Executable path<input value={instanceDraft.binaryPath||""} onChange={e=>setInstanceDraft({...instanceDraft,binaryPath:e.target.value})} placeholder="Leave blank to use the detected CLI"/></label>
          {(instanceDraft.kind==="codex"||instanceDraft.kind==="claude")&&<label>{instanceDraft.kind==="codex"?"CODEX_HOME":"Claude config directory"}<input value={instanceDraft.homePath||""} onChange={e=>setInstanceDraft({...instanceDraft,homePath:e.target.value})} placeholder="Leave blank for Trebell/default profile"/></label>}
          {instanceDraft.kind==="codex"&&<><label>Shadow home path<input value={instanceDraft.shadowHomePath||""} onChange={e=>setInstanceDraft({...instanceDraft,shadowHomePath:e.target.value})} placeholder="Optional account-specific home, e.g. ~/.codex_personal"/></label><p>Optional. Keeps this account's <code>auth.json</code> private while sharing sessions, config, skills, plugins and worktrees from the CODEX_HOME above. Use the same CODEX_HOME across compatible accounts.</p></>}
          {instanceDraft.kind==="claude"&&<><label>Auto-compact after<input type="number" min="100000" max="1000000" step="1000" value={instanceDraft.autoCompactWindow??""} onChange={e=>setInstanceDraft({...instanceDraft,autoCompactWindow:e.target.value})} placeholder="Claude default"/></label><p>Optional. Compact automatically after 100,000–1,000,000 tokens. Leave blank to use Claude Code's default threshold.</p></>}
          {instanceDraft.kind==="opencode"&&<label>Existing OpenCode server URL<input value={instanceDraft.serverUrl||""} onChange={e=>setInstanceDraft({...instanceDraft,serverUrl:e.target.value})} placeholder="Optional, e.g. http://127.0.0.1:4096"/></label>}
          <div className="provider-key-actions"><button className="setting-action" onClick={saveInstance}>Save profile</button><button onClick={()=>setInstanceDraft(null)}>Cancel</button></div>
        </div>}
        <p className={selectedAgentStatus?.available?"provider-note":"provider-status-error"}><strong>{selectedAgentStatus?.name||selectedAgent}</strong> · {selectedAgentStatus?.authenticated==null&&selectedAgentStatus?.message?selectedAgentStatus.message:selectedAgentStatus?.available?"ready":selectedAgentStatus?.message||"setup required"}{agentMessage?" · "+agentMessage:""} <button onClick={loadAgentRuntimes} disabled={!!authenticatingAgent}><RefreshCw size={11}/> Refresh</button></p>
      </div>
      {selectedAgent==="codex"&&<div className="settings-card provider-settings-card" {...targetProps("agents-provider")} data-testid="provider-settings-card" aria-busy={providerSwitching?"true":"false"} hidden={settingsSection!=="agents"}>
        <h3>Model provider</h3>
        <p>Choose the OpenAI-compatible inference service used by the Codex harness.</p>
        <label>Provider
          <select data-testid="provider-selector" value={selected} disabled={providerSwitching} onChange={e=>save({modelProvider:e.target.value})}>
            <option value="freebuff">Freebuff</option>
            <option value="agentrouter">AgentRouter</option>
            <option value="justworker">JustWorker.icu</option>
            <option value="hcnsec">HCNSec.cn</option>
            <option value="vyceai">VyceAi</option>
          </select>
        </label>
        {selected==="freebuff"?<>
          <p>{loggedIn?"Signed in to Freebuff.":"Sign in to use Freebuff inference."}</p>
          <button className="setting-action" onClick={changeFreebuffAuth} disabled={freebuffAuthBusy}>{freebuffAuthBusy?(loggedIn?"Signing out…":"Waiting for sign-in…"):(loggedIn?"Sign out":"Sign in to Freebuff")}</button>
        </>:<>
          <label>API key
            <input data-testid="provider-api-key" type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={selectedStatus?.hasKey?"Saved key ••••••••":"Paste API key"}/>
          </label>
          <div className="provider-key-actions">
            <button data-testid="save-provider-key" className="setting-action" onClick={saveProviderKey} disabled={!apiKey.trim()}>Save API key</button>
            {selectedStatus?.hasKey&&<button onClick={clearProviderKey}>Remove key</button>}
          </div>
          <p className="provider-note">{selected==="agentrouter"?"Models are loaded live from AgentRouter /v1/models for this key.":selected==="vyceai"?"Models are loaded live from Vyce AI /v1/models for this key.":selected==="justworker"?"Available model: claude-opus-4-8.":"Available model: glm-5.3."}</p>
        </>}
        <p data-testid="provider-status" className={modelError||freebuffAuthError?"provider-status-error":""}><strong>{PROVIDER_LABELS[selected]}</strong> · {providerSwitching?"switching provider…":selectedStatus?.hasKey||selected==="freebuff"?(modelError||freebuffAuthError?"provider error":(providerInfo?.ready?"ready":"configured")):"API key required"}{providerMessage?" · "+providerMessage:""}{modelError?" · "+modelError:""}</p>
      </div>}
      {["codex","claude","opencode"].includes(selectedAgent)&&<div className="settings-card custom-model-settings" {...targetProps("agents-models")} hidden={settingsSection!=="agents"}>
        <h3>Custom models</h3>
        <p>Add a model that this harness/provider supports even when discovery does not list it. Prices are optional USD estimates per million tokens.</p>
        <div className="custom-model-list">{customModels.map(item=><div key={`${item.runtime}:${item.provider||""}:${item.id}`}><span><strong>{item.name||item.id}</strong><small>{item.id}{item.effort?` · ${item.effort}`:""}{item.serviceTier?` · ${item.serviceTier}`:""}</small></span><button onClick={()=>removeCustomModel(item)}>Remove</button></div>)}</div>
        {!customModelEditorOpen?<button className="setting-action" onClick={()=>setCustomModelEditorOpen(true)}>Add custom model</button>:<div className="custom-model-editor">
          <label>Model ID<input value={modelDraft.id} onChange={e=>setModelDraft({...modelDraft,id:e.target.value})} placeholder={selectedAgent==="opencode"?"provider/model-id":"model-id"}/></label>
          <label>Display name<input value={modelDraft.name} onChange={e=>setModelDraft({...modelDraft,name:e.target.value})} placeholder="Optional friendly name"/></label>
          {selectedAgent==="codex"&&<div className="environment-two"><label>Reasoning effort<select value={modelDraft.effort} onChange={e=>setModelDraft({...modelDraft,effort:e.target.value})}><option value="">Provider default</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label><label>Service tier<input value={modelDraft.serviceTier} onChange={e=>setModelDraft({...modelDraft,serviceTier:e.target.value})} placeholder="default / priority / flex"/></label></div>}
          <div className="custom-price-grid"><label>Input / 1M<input type="number" step="0.001" min="0" value={modelDraft.inputPrice} onChange={e=>setModelDraft({...modelDraft,inputPrice:e.target.value})}/></label><label>Output / 1M<input type="number" step="0.001" min="0" value={modelDraft.outputPrice} onChange={e=>setModelDraft({...modelDraft,outputPrice:e.target.value})}/></label><label>Cache read / 1M<input type="number" step="0.001" min="0" value={modelDraft.cacheReadPrice} onChange={e=>setModelDraft({...modelDraft,cacheReadPrice:e.target.value})}/></label><label>Cache write / 1M<input type="number" step="0.001" min="0" value={modelDraft.cacheWritePrice} onChange={e=>setModelDraft({...modelDraft,cacheWritePrice:e.target.value})}/></label></div>
          <div className="provider-key-actions"><button className="setting-action" onClick={addCustomModel} disabled={!modelDraft.id.trim()}>Save custom model</button><button onClick={()=>setCustomModelEditorOpen(false)}>Cancel</button></div>
        </div>}
      </div>}
      <div className="settings-card" {...targetProps("agents-runtime")} hidden={settingsSection!=="agents"}><h3>Runtime</h3><p>Harness connection: <strong>{rpcStatus}</strong><br/>Agent: <strong>{selectedAgentStatus?.name||selectedAgent}</strong><br/>Agent runtime: <strong>{runtime?.agentRuntimeStatus?.available||selectedAgent==="codex"?"ready":"not ready"}</strong>{selectedAgent==="codex"&&<><br/>Codex app-server: <strong>{runtime?.appServerReady?"ready":"not ready"}</strong><br/>Inference: <strong>{PROVIDER_LABELS[runtime?.provider||selected]||runtime?.provider||selected}</strong>{(runtime?.provider||selected)==="freebuff"&&<><br/>Freebuff bridge: <strong>{runtime?.bridgeReady?"ready":"not ready"}</strong></>}</>}</p><button onClick={()=>refresh({reportErrors:true})} disabled={loading}><RefreshCw size={13}/> {loading?"Refreshing…":"Refresh diagnostics"}</button></div>
      <div className="settings-card" {...targetProps("general-followups")} hidden={settingsSection!=="general"}><h3>Follow-up behavior</h3>{selectedAgent==="codex"?<label>While the agent is working<select value={settings.followUpMode||"queue"} onChange={e=>save({followUpMode:e.target.value})}><option value="queue">Queue after current turn</option><option value="steer">Steer current turn immediately</option></select></label>:<p>Follow-ups are queued until the current {selectedAgentStatus?.name||selectedAgent} turn finishes. ACP does not define in-flight steering.</p>}</div>
      <div className="settings-section-slot" {...targetProps("workspace-defaults")} hidden={settingsSection!=="workspace"}><ScopedSettingsCard settings={settings} models={models} onChanged={onScopedSettingsChanged} scopeEnvironmentId={workspaceScope.environmentId} scopeProjectId={workspaceScope.projectId} onScopeChange={setWorkspaceScope} onCatalog={setWorkspaceScopeCatalog} showScopeTargets={false}/></div>
      <div className="settings-card storage-settings" {...targetProps("workspace-storage")} hidden={settingsSection!=="workspace"}>
        <h3>Storage cleanup</h3>
        <p>Automatic cleanup is opt-in. Trebell only removes its own local attachment cache, stopped terminal history, and managed worktrees that already pass the safe worktree cleanup rules. User project files and Git branches are never deleted by these retention fields.</p>
        <div className="environment-two">
          <label>Attachment cache retention
            <input key={"attachment-retention-"+(settings.storageCleanup?.attachmentsAfterDays??"off")} type="number" min="1" max="3650" defaultValue={settings.storageCleanup?.attachmentsAfterDays??""} placeholder="Off" onBlur={event=>saveStorageRetention("attachmentsAfterDays",event.target.value)}/>
            <small>Days · blank means off</small>
          </label>
          <label>Stopped terminal history
            <input key={"terminal-retention-"+(settings.storageCleanup?.terminalHistoryAfterDays??"off")} type="number" min="1" max="3650" defaultValue={settings.storageCleanup?.terminalHistoryAfterDays??""} placeholder="Off" onBlur={event=>saveStorageRetention("terminalHistoryAfterDays",event.target.value)}/>
            <small>Days · running terminals are never pruned</small>
          </label>
        </div>
        <p className="provider-note">{storageInfo?.error?storageInfo.error:`${storageInfo?.attachments?.count??0} cached attachment${storageInfo?.attachments?.count===1?"":"s"} · ${((storageInfo?.attachments?.bytes||0)/1024/1024).toFixed(1)} MB · ${storageInfo?.terminalHistory?.count??0} stopped terminal histor${storageInfo?.terminalHistory?.count===1?"y":"ies"} · ${storageInfo?.worktrees?.managed??0} live managed worktree${storageInfo?.worktrees?.managed===1?"":"s"}`}</p>
        <div className="provider-key-actions"><button className="setting-action" onClick={runStorageCleanup} disabled={storageBusy}>{storageBusy?"Cleaning…":"Run safe cleanup now"}</button><button onClick={loadStorageInfo} disabled={storageBusy}><RefreshCw size={12}/> Refresh storage</button></div>
        {storageMessage&&<p className={/failed|error/i.test(storageMessage)?"provider-status-error":"provider-note"}>{storageMessage}</p>}
      </div>
      {selectedAgent==="codex"&&<div className="settings-card" hidden={settingsSection!=="desktop"}><h3>Computer use</h3><p>The agent can always inspect a desktop screenshot. Mouse and keyboard control are exposed only when the current thread is in <strong>Full access</strong> mode. This keeps desktop automation explicit instead of silently escalating permissions.</p></div>}
      <div className="settings-card environment-theme-settings" hidden={settingsSection!=="appearance"}>
        <h3>Environment themes</h3>
        <p><strong>{environmentThemeCatalog.environmentName||"Local machine"}</strong> can publish theme JSON files from <code>{environmentThemeCatalog.directory||"the environment theme directory"}</code>. Published themes stay owned by that environment, so edits on the machine can flow into Trebell after refresh.</p>
        <div className="appearance-options">
          {(environmentThemes||[]).map(theme=><button key={theme.id} className={settings.environmentThemeSelections?.[environmentThemeCatalog.environmentKey]===theme.publishedId?"active":""} onClick={()=>selectEnvironmentTheme(theme)}>{theme.name}</button>)}
        </div>
        {!environmentThemes?.length&&<p className="provider-note">No valid published themes found. Theme files are bounded to 32 KB each and must define a canvas color (or VS Code editor background).</p>}
        <div className="theme-actions">
          <button onClick={refreshPublishedThemes} disabled={environmentThemeRefreshing}><RefreshCw size={12}/> {environmentThemeRefreshing?"Refreshing…":"Refresh published themes"}</button>
          {settings.environmentThemeSelections?.[environmentThemeCatalog.environmentKey]&&<button onClick={stopFollowingEnvironmentTheme}>Use my normal theme</button>}
          {environmentThemes.find(theme=>theme.publishedId===settings.environmentThemeSelections?.[environmentThemeCatalog.environmentKey])&&<button onClick={()=>duplicateEnvironmentTheme(environmentThemes.find(theme=>theme.publishedId===settings.environmentThemeSelections?.[environmentThemeCatalog.environmentKey]))}>Duplicate as editable</button>}
        </div>
      </div>
      <div className="settings-card theme-settings" hidden={settingsSection!=="appearance"}><h3>Appearance</h3><p>Appearance controls light/dark behavior. Theme controls the palette independently. Trebell themes and VS Code color-theme JSON can be imported.</p><label>Mode<div className="appearance-options">{["system","light","dark"].map(v=><button key={v} className={(settings.appearanceMode||"dark")===v?"active":""} onClick={()=>save({appearanceMode:v})}>{v}</button>)}</div></label><label>Panel animations <span>{Math.max(0,Math.min(400,Number(settings.panelAnimationMs)||0))} ms</span><input aria-label="Panel animations" type="range" min="0" max="400" step="25" value={Math.max(0,Math.min(400,Number(settings.panelAnimationMs)||0))} onChange={e=>save({panelAnimationMs:Number(e.target.value)})}/></label><p>Sidebar, right panel and terminal movement uses this duration. Operating-system reduced motion always disables it.</p><label>Theme<div className="appearance-options">{[["dark","Trebell"],["midnight","Midnight"],["black","Black"]].map(([value,label])=><button key={value} className={(settings.appearance||"dark")===value?"active":""} onClick={()=>save({appearance:value})}>{label}</button>)}{(settings.customThemes||[]).map(theme=><button key={theme.id} className={settings.appearance===theme.id?"active":""} onClick={()=>save({appearance:theme.id})}>{theme.name}</button>)}</div></label><div className="theme-actions"><button onClick={createTheme}>Create theme</button><button onClick={()=>themeImportRef.current?.click()}>Import JSON</button>{(settings.customThemes||[]).find(theme=>theme.id===settings.appearance)&&<><button onClick={()=>setThemeDraft((settings.customThemes||[]).find(theme=>theme.id===settings.appearance))}>Edit selected</button><button onClick={()=>exportTheme((settings.customThemes||[]).find(theme=>theme.id===settings.appearance))}>Export selected</button><button onClick={()=>removeTheme((settings.customThemes||[]).find(theme=>theme.id===settings.appearance))}>Delete selected</button></>}<input ref={themeImportRef} type="file" accept=".json,application/json" hidden onChange={importThemeFile}/></div>{themeDraft&&<div className="theme-editor"><label>Name<input value={themeDraft.name||""} onChange={e=>setThemeDraft({...themeDraft,name:e.target.value})}/></label><div className="theme-editor-grid"><label>Base appearance<select value={themeDraft.appearance||"dark"} onChange={e=>setThemeDraft({...themeDraft,appearance:e.target.value})}><option value="dark">Dark</option><option value="light">Light</option></select></label><label>Canvas<input type="color" value={themeDraft.canvas||"#0c0f16"} onChange={e=>setThemeDraft({...themeDraft,canvas:e.target.value})}/></label><label>Accent<input type="color" value={themeDraft.accent||"#9c6cff"} onChange={e=>setThemeDraft({...themeDraft,accent:e.target.value})}/></label></div><div className="theme-editor-actions"><button className="setting-action" onClick={saveTheme}>Save & apply</button><button onClick={()=>setThemeDraft(null)}>Close editor</button></div></div>}{themeMessage&&<p className={/failed|error/i.test(themeMessage)?"provider-status-error":"provider-note"}>{themeMessage}</p>}</div>
      {window.trebellDesktop?.notify&&<div className="settings-card" hidden={settingsSection!=="general"}><h3>Desktop notifications</h3><label className="toggle-line"><input type="checkbox" checked={settings.notifications!==false} onChange={e=>save({notifications:e.target.checked})}/> Notify when turns finish or need attention</label><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.notificationSound)} onChange={e=>save({notificationSound:e.target.checked})}/> Allow notification sound</label></div>}
      <div className="settings-card" hidden={settingsSection!=="workspace"}><h3>Pull request lifecycle</h3><p>When every pull request linked to a thread has a fresh synced terminal state (merged or closed), move the idle thread to Settled. Open, unsynced, running, and archived threads are never auto-settled.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.autoSettleMergedThreads)} onChange={e=>save({autoSettleMergedThreads:e.target.checked})}/> Auto-settle threads after all linked reviews finish</label></div>
      <div className="settings-card" hidden={settingsSection!=="general"}><h3>Restart recovery</h3><p>When Trebell restarts during active work, reconnect saved provider sessions and continue the interrupted turn. Codex uses native promptless continuation; other supported harnesses resume their saved session and continue from there. Off by default to avoid unexpected background work after a restart.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.continueThreadsAfterRestart)} onChange={e=>save({continueThreadsAfterRestart:e.target.checked})}/> Continue supported active threads after restarts</label></div>
      {window.trebellDesktop?.browser?.importSources&&<div className="settings-card browser-profile-settings" hidden={settingsSection!=="desktop"}><h3>Browser profiles</h3><p>Copy a supported browser session into Trebell Agent Browser. This is a one-time local copy; the source browser and Trebell stay separate afterward.</p>{browserImport.sources?.length?<>{browserImport.sources.map(source=><div className="browser-import-source" key={source.id}><div><strong>{source.name}</strong><span>{source.profiles?.length||0} profile{source.profiles?.length===1?"":"s"}{source.running?" · running":""}</span></div>{source.running&&<em>Close {source.name} before importing</em>}</div>)}<label>Profile<select value={browserImportProfile} onChange={e=>setBrowserImportProfile(e.target.value)}>{browserImport.sources.flatMap(source=>(source.profiles||[]).map(profile=><option key={profile.id} value={profile.id}>{source.name} · {profile.name}</option>))}</select></label><div className="provider-key-actions"><button className="setting-action" onClick={importBrowserProfile} disabled={browserImportBusy||!browserImportProfile||browserImport.sources.some(source=>source.running&&source.profiles?.some(profile=>profile.id===browserImportProfile))}>{browserImportBusy?"Importing…":"Import selected profile"}</button><button onClick={()=>loadBrowserImportSources()} disabled={browserImportBusy}><RefreshCw size={12}/> Rescan</button></div></>:<p className="provider-note">No directly importable browser profile was found. On Windows, Trebell supports Firefox and Helium. Other Chromium browsers use app-bound encryption and are intentionally not imported; JSON cookie import remains available in Agent Browser.</p>}<p className={browserImportMessage&&/close|failed|error/i.test(browserImportMessage)?"provider-status-error":"provider-note"}>{browserImportMessage}</p></div>}
      {window.trebellDesktop?.snapshots&&<div className="settings-card snapshot-settings" hidden={settingsSection!=="desktop"}><h3>SnapShots</h3><p>Capture the foreground window from anywhere and attach it to the current draft. Captures are stored locally until Trebell successfully attaches them.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(snapshotInfo.enabled)} onChange={e=>configureSnapshots({enabled:e.target.checked})}/> Enable global SnapShot shortcut</label><label>Shortcut<input value={snapshotInfo.shortcut||""} onChange={e=>setSnapshotInfo(info=>({...info,shortcut:e.target.value}))} onBlur={()=>snapshotInfo.enabled&&configureSnapshots({shortcut:snapshotInfo.shortcut})} placeholder="CommandOrControl+Shift+S"/></label><label className="toggle-line"><input type="checkbox" checked={Boolean(snapshotInfo.includeText)} onChange={e=>configureSnapshots({includeText:e.target.checked})}/> Include accessibility text and control positions</label><label className="toggle-line"><input type="checkbox" checked={snapshotInfo.playSound!==false} onChange={e=>configureSnapshots({playSound:e.target.checked})}/> Play capture sound</label>{snapshotInfo.playSound!==false&&<label>Capture sound<select value={snapshotInfo.sound||"soft-pop"} onChange={e=>configureSnapshots({sound:e.target.value})}><option value="soft-pop">Soft pop</option><option value="camera-shutter">Camera shutter</option></select></label>}<label className="toggle-line"><input type="checkbox" checked={snapshotInfo.flash!==false} onChange={e=>configureSnapshots({flash:e.target.checked})}/> Flash captured window</label><label className="toggle-line"><input type="checkbox" checked={snapshotInfo.animations!==false} onChange={e=>configureSnapshots({animations:e.target.checked})}/> Animate capture feedback</label><p className="provider-note">App text is off by default because visible UI can contain sensitive information. Sound, flash and animation are local capture feedback only. {snapshotInfo.pending?`${snapshotInfo.pending} capture${snapshotInfo.pending===1?"":"s"} waiting to attach. `:""}{snapshotMessage}</p><div className="provider-key-actions"><button onClick={()=>window.trebellDesktop.snapshots.capture().catch(error=>setSnapshotMessage(error.message))}>Capture now</button><button onClick={()=>configureSnapshots({shortcut:snapshotInfo.shortcut})} disabled={!snapshotInfo.enabled}>Save shortcut</button></div></div>}
      {window.trebellDesktop?.background&&<div className="settings-card" hidden={settingsSection!=="desktop"}><h3>Background mode</h3><p>Keep Trebell's local harness running in the system tray after the window closes, and start it with Windows.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.backgroundMode)} onChange={e=>setBackgroundMode(e.target.checked)}/> Keep Trebell running in background</label></div>}
      <div className="settings-card keybindings-settings" hidden={settingsSection!=="shortcuts"}><h3>Keyboard shortcuts</h3><p>Shortcuts can be conditional. For example, <code>threadOpen && !modalOpen</code> means “only when a thread is open and no dialog is covering the app.”</p>{KEYBINDING_COMMANDS.map(command=>{const rule=keybindingRules.find(item=>item.command===command.id);return <div className="keybinding-row" key={command.id}><strong>{command.label}</strong><label>Shortcut<input value={rule?.key||""} onChange={e=>updateKeybinding(command.id,{key:e.target.value})}/></label><label>When<input value={rule?.when||""} placeholder="Always" onChange={e=>updateKeybinding(command.id,{when:e.target.value})}/></label></div>})}{projectScripts.length>0&&<><h4>Project actions</h4>{projectScripts.map(script=>{const command="script."+script.id+".run";const rule=keybindingRules.find(item=>item.command===command);return <div className="keybinding-row" key={command}><strong>Run {script.name}</strong><label>Shortcut<input value={rule?.key||""} onChange={e=>updateKeybinding(command,{key:e.target.value})}/></label><label>When<input value={rule?.when||"projectOpen && !modalOpen"} onChange={e=>updateKeybinding(command,{when:e.target.value})}/></label></div>})}</>}<p className="provider-note">Available contexts: chatFocus, terminalFocus, terminalOpen, previewFocus, textInputFocus, modelPickerOpen, projectOpen, threadOpen, pullRequestOpen, running, modalOpen, rightPanelOpen, desktop. Combine them with <code>!</code>, <code>&&</code>, <code>||</code> and parentheses. Blank shortcuts stay unbound until you assign one.</p></div>
      <div className="settings-card update-settings" hidden={settingsSection!=="general"}><h3>Updates</h3>{desktopUpdate?.supported?<><p>Current: <strong>{desktopUpdate.currentVersion||update?.current||"unknown"}</strong>{desktopUpdate.availableVersion&&<><br/>Available: <strong>{desktopUpdate.availableVersion}</strong></>}<br/>Status: <strong>{updateStatusLabel}</strong></p>{desktopUpdate.status==="downloading"&&<div className="update-progress"><span style={{width:`${Math.max(0,Math.min(100,desktopUpdate.percent||0))}%`}}/></div>}{desktopUpdate.status==="downloading"&&<p className="provider-note">{Math.round(desktopUpdate.percent||0)}% downloaded</p>}{desktopUpdate.error&&<p className="provider-status-error">{desktopUpdate.error}</p>}<div className="provider-key-actions"><button onClick={checkDesktopUpdate} disabled={["checking","downloading","installing"].includes(desktopUpdate.status)}><RefreshCw size={12}/> Check now</button>{desktopUpdate.status==="available"&&<button className="setting-action" onClick={downloadDesktopUpdate}><Download size={12}/> Download update</button>}{desktopUpdate.status==="downloaded"&&<button className="setting-action" onClick={installDesktopUpdate}>Restart & install</button>}</div>{desktopUpdate.status==="downloaded"&&!settings.continueThreadsAfterRestart&&<p className="provider-note">Restart recovery is off. Finish active work first, or enable Restart recovery before installing.</p>}</>:<>{update?.latest?<p>Current: <strong>{update.current}</strong><br/>Latest: <strong>{update.latest}</strong></p>:<p>{update?.error||"Checking releases…"}</p>}{update?.url&&<button onClick={()=>window.open(update.url,"_blank")}><Download size={13}/> Open latest release</button>}{desktopUpdate?.status==="development"&&<p className="provider-note">In-app installation is available in packaged Trebell builds.</p>}</>}</div>
      <div className="settings-card" hidden={settingsSection!=="diagnostics"}><h3>Diagnostics</h3><p>Runtime and project diagnostics are local to this machine.</p><div className="diag-badges"><span className={runtime?.agentRuntimeStatus?.available||selectedAgent==="codex"?"ok":""}><Activity size={12}/> {selectedAgentStatus?.name||selectedAgent}</span>{selectedAgent==="codex"&&<span className={diagnostics?.runtime?.providerReady?"ok":""}><ShieldCheck size={12}/> {PROVIDER_LABELS[diagnostics?.runtime?.provider||selected]||"Provider"}</span>}</div></div>
    </div>
    <div className="diagnostics-log" hidden={settingsSection!=="diagnostics"}><div><strong>Runtime log</strong><button aria-label="Refresh diagnostics" onClick={()=>refresh({reportErrors:true})} disabled={loading}><RefreshCw size={12}/></button></div>{diagnostics?.logs?.length?<pre>{diagnostics.logs.map(x=>"["+new Date(x.at).toLocaleTimeString()+"] "+x.stream+": "+x.text).join("")}</pre>:<div className="diagnostics-empty"><Activity size={22}/><strong>No runtime activity yet</strong><span>Provider and harness diagnostics will appear here when Trebell has something useful to report.</span></div>}</div>
    </section>
  </div>;
}
