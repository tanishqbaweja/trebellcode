import React,{useEffect,useRef,useState} from "react";
import { Activity, Bot, Download, FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../api.js";
import { KEYBINDING_COMMANDS, normalizeKeybindingRules } from "../keybindings.js";
import { normalizeCustomTheme } from "../theme-utils.js";

const PROVIDER_LABELS={
  freebuff:"Freebuff",
  agentrouter:"AgentRouter",
  justworker:"JustWorker.icu",
  hcnsec:"HCNSec.cn",
  vyceai:"VyceAi",
};

export default function SettingsPage({settings,onSettings,onProviderUpdated,runtime,rpcStatus,loggedIn,login,logout,projectPath,modelError,onOpenLicenses}){
  const [update,setUpdate]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [loading,setLoading]=useState(false);
  const [providerInfo,setProviderInfo]=useState(null);
  const [apiKey,setApiKey]=useState("");
  const [providerMessage,setProviderMessage]=useState("");
  const [agentInfo,setAgentInfo]=useState(null);
  const [agentMessage,setAgentMessage]=useState("");
  const [instanceDraft,setInstanceDraft]=useState(null);
  const [modelDraft,setModelDraft]=useState({id:"",name:"",effort:"",serviceTier:"",inputPrice:"",outputPrice:"",cacheReadPrice:"",cacheWritePrice:""});
  const [snapshotInfo,setSnapshotInfo]=useState({enabled:false,shortcut:"CommandOrControl+Shift+S",includeText:false,registered:false,pending:0});
  const [snapshotMessage,setSnapshotMessage]=useState("");
  const [browserImport,setBrowserImport]=useState({sources:[],platform:null});
  const [browserImportProfile,setBrowserImportProfile]=useState("");
  const [browserImportMessage,setBrowserImportMessage]=useState("");
  const [browserImportBusy,setBrowserImportBusy]=useState(false);
  const [themeDraft,setThemeDraft]=useState(null);
  const [themeMessage,setThemeMessage]=useState("");
  const themeImportRef=useRef(null);
  const selected=settings.modelProvider||"freebuff";
  const selectedAgent=settings.agentRuntime||runtime?.agentRuntime||"codex";
  const keybindingRules=normalizeKeybindingRules(settings);
  function updateKeybinding(command,patch){
    const next=keybindingRules.map(rule=>rule.command===command?{...rule,...patch}:rule);
    return save({keybindingRules:next});
  }

  async function loadProviders(){
    const info=await api("/api/providers").catch(e=>({error:e.message,providers:[]}));
    setProviderInfo(info);
    return info;
  }
  async function loadAgentRuntimes(){
    const info=await api("/api/agent-runtimes").catch(e=>({error:e.message,definitions:[],instances:[],statuses:[]}));
    setAgentInfo(info);return info;
  }
  async function selectAgentRuntime(kind,instanceId=null){
    setAgentMessage("Switching…");
    try{
      const result=await api("/api/agent-runtimes",{method:"POST",body:{action:"select",runtime:kind,instanceId}});
      setAgentInfo(result);
      onSettings(await api("/api/settings"));
      setAgentMessage(`${result.selected?.status?.name||kind} selected.`);
      await onProviderUpdated?.({agentRuntime:result.selectedRuntime||kind,provider:selected});
    }catch(error){setAgentMessage(error.message)}
  }
  function editInstance(instance=null){
    setInstanceDraft(instance?{...instance}:{
      id:`${selectedAgent}-${crypto.randomUUID()}`,kind:selectedAgent,displayName:`${(agentInfo?.definitions||[]).find(item=>item.id===selectedAgent)?.name||selectedAgent} profile`,binaryPath:"",homePath:"",serverUrl:"",
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
  async function save(patch){
    const next=await api("/api/settings",{method:"POST",body:patch});
    onSettings(next);
    if("modelProvider" in patch){
      setApiKey("");
      setProviderMessage("");
      await loadProviders();
      await onProviderUpdated?.({provider:next.modelProvider||patch.modelProvider,agentRuntime:next.agentRuntime||selectedAgent});
    }
    if("customModels" in patch)await onProviderUpdated?.();
    return next;
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
    await save({customModels:next});setModelDraft({id:"",name:"",effort:"",serviceTier:"",inputPrice:"",outputPrice:"",cacheReadPrice:"",cacheWritePrice:""});setAgentMessage("Custom model saved.");
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
  async function refresh(){
    setLoading(true);
    const [u,d]=await Promise.all([
      api("/api/update/check").catch(e=>({error:e.message})),
      api("/api/diagnostics?path="+encodeURIComponent(projectPath||"")).catch(e=>({error:e.message})),
      loadProviders(),
      loadAgentRuntimes(),
    ]);
    setUpdate(u);setDiagnostics(d);setLoading(false);
    if(window.trebellDesktop?.snapshots)window.trebellDesktop.snapshots.get().then(setSnapshotInfo).catch(()=>{});
    if(window.trebellDesktop?.browser?.importSources)loadBrowserImportSources().catch(()=>{});
  }
  async function loadBrowserImportSources(){
    const info=await window.trebellDesktop?.browser?.importSources?.();if(!info)return;
    setBrowserImport(info);const profiles=info.sources?.flatMap(source=>source.profiles||[])||[];
    setBrowserImportProfile(current=>profiles.some(profile=>profile.id===current)?current:(profiles[0]?.id||""));
    return info;
  }
  async function importBrowserProfile(){
    const source=browserImport.sources?.find(item=>item.profiles?.some(profile=>profile.id===browserImportProfile));if(!source||!browserImportProfile)return;
    setBrowserImportBusy(true);setBrowserImportMessage("Importing…");
    try{
      const result=await window.trebellDesktop.browser.importProfile(source.id,browserImportProfile);
      setBrowserImportMessage(`Imported ${result.imported} cookie${result.imported===1?"":"s"}${result.skipped?` · ${result.skipped} encrypted/partitioned skipped`:""}${result.failed?` · ${result.failed} failed`:""}.`);
      await loadBrowserImportSources();
    }catch(error){setBrowserImportMessage(error.message||String(error));await loadBrowserImportSources().catch(()=>{})}
    finally{setBrowserImportBusy(false)}
  }
  async function configureSnapshots(patch){
    if(!window.trebellDesktop?.snapshots)return;
    setSnapshotMessage("Saving…");
    try{
      const next=await window.trebellDesktop.snapshots.configure({...snapshotInfo,...patch});
      setSnapshotInfo(next);setSnapshotMessage(next.enabled?"SnapShots ready.":"SnapShots disabled.");
    }catch(error){setSnapshotMessage(error.message||String(error));const current=await window.trebellDesktop.snapshots.get().catch(()=>null);if(current)setSnapshotInfo(current)}
  }
  useEffect(()=>{refresh()},[projectPath]);
  useEffect(()=>{loadProviders()},[selected]);
  useEffect(()=>{loadAgentRuntimes()},[selectedAgent]);

  const selectedStatus=providerInfo?.providers?.find(p=>p.id===selected)||providerInfo?.status;
  const selectedAgentStatus=agentInfo?.statuses?.find(item=>item.id===agentInfo?.selectedInstanceId)||agentInfo?.statuses?.find(item=>item.kind===selectedAgent);
  const selectedInstances=(agentInfo?.instances||[]).filter(item=>item.kind===selectedAgent);
  const customModels=(settings.customModels||[]).filter(item=>item.runtime===selectedAgent&&(selectedAgent!=="codex"||item.provider===selected));
  return <div className="settings-page">
    <div className="settings-grid">
      <div className="settings-card about-card">
        <div className="about-brand"><img src="/trebell-code-icon.svg" alt="" aria-hidden="true"/><div><h3>Trebell Code</h3><p>Desktop coding-agent harness</p></div></div>
        <span className="about-version">v{diagnostics?.version||update?.current||"1.2.0"}</span><button onClick={onOpenLicenses}><FileText size={12}/> View licenses</button>
      </div>
      <div className="settings-card agent-runtime-settings">
        <h3>Agent harness</h3>
        <p>Choose the coding-agent runtime. Only installed and ready runtimes can be activated.</p>
        <div className="agent-runtime-list">{(agentInfo?.definitions||[]).map(def=>{
          const status=(selectedAgent===def.id?agentInfo?.statuses?.find(item=>item.id===agentInfo?.selectedInstanceId):null)||agentInfo?.statuses?.find(item=>item.kind===def.id&&item.available)||agentInfo?.statuses?.find(item=>item.kind===def.id);
          const active=selectedAgent===def.id;
          return <button key={def.id} className={active?"active":""} disabled={!active&&!status?.available} onClick={()=>!active&&status?.available&&selectAgentRuntime(def.id,status.id)}>
            <Bot size={14}/><span><strong>{def.name}</strong><small>{status?.available?status?.version||"Ready":status?.message||"Unavailable"}</small></span><em>{active?"Active":status?.available?"Use":"Unavailable"}</em>
          </button>;
        })}</div>
        <div className="runtime-profiles">
          <div className="runtime-profiles-head"><strong>Profiles</strong><button onClick={()=>editInstance()} disabled={selectedAgent==="antigravity"}>Add profile</button></div>
          {selectedInstances.map(instance=>{
            const status=agentInfo?.statuses?.find(item=>item.id===instance.id);const active=agentInfo?.selectedInstanceId===instance.id;
            return <div className="runtime-profile-row" key={instance.id}>
              <button className={active?"active":""} disabled={!active&&!status?.available} onClick={()=>!active&&status?.available&&selectAgentRuntime(instance.kind,instance.id)}><span><strong>{instance.displayName||instance.id}</strong><small>{status?.available?status.version||"Ready":status?.message||"Unavailable"}</small></span><em>{active?"Active":"Use"}</em></button>
              <button onClick={()=>editInstance(instance)}>Edit</button>
              {instance.id!==`${instance.kind}-default`&&<button onClick={()=>removeInstance(instance)}>Remove</button>}
            </div>;
          })}
        </div>
        {instanceDraft&&<div className="runtime-profile-editor">
          <label>Profile name<input value={instanceDraft.displayName||""} onChange={e=>setInstanceDraft({...instanceDraft,displayName:e.target.value})}/></label>
          <label>Executable path<input value={instanceDraft.binaryPath||""} onChange={e=>setInstanceDraft({...instanceDraft,binaryPath:e.target.value})} placeholder="Leave blank to use the detected CLI"/></label>
          {(instanceDraft.kind==="codex"||instanceDraft.kind==="claude")&&<label>{instanceDraft.kind==="codex"?"CODEX_HOME":"Claude config directory"}<input value={instanceDraft.homePath||""} onChange={e=>setInstanceDraft({...instanceDraft,homePath:e.target.value})} placeholder="Leave blank for Trebell/default profile"/></label>}
          {instanceDraft.kind==="opencode"&&<label>Existing OpenCode server URL<input value={instanceDraft.serverUrl||""} onChange={e=>setInstanceDraft({...instanceDraft,serverUrl:e.target.value})} placeholder="Optional, e.g. http://127.0.0.1:4096"/></label>}
          <div className="provider-key-actions"><button className="setting-action" onClick={saveInstance}>Save profile</button><button onClick={()=>setInstanceDraft(null)}>Cancel</button></div>
        </div>}
        <p className={selectedAgentStatus?.available?"provider-note":"provider-status-error"}><strong>{selectedAgentStatus?.name||selectedAgent}</strong> · {selectedAgentStatus?.available?"ready":selectedAgentStatus?.message||"setup required"}{agentMessage?" · "+agentMessage:""}</p>
      </div>
      {selectedAgent==="codex"&&<div className="settings-card provider-settings-card">
        <h3>Model provider</h3>
        <p>Choose the OpenAI-compatible inference service used by the Codex harness.</p>
        <label>Provider
          <select data-testid="provider-selector" value={selected} onChange={e=>save({modelProvider:e.target.value})}>
            <option value="freebuff">Freebuff</option>
            <option value="agentrouter">AgentRouter</option>
            <option value="justworker">JustWorker.icu</option>
            <option value="hcnsec">HCNSec.cn</option>
            <option value="vyceai">VyceAi</option>
          </select>
        </label>
        {selected==="freebuff"?<>
          <p>{loggedIn?"Signed in to Freebuff.":"Sign in to use Freebuff inference."}</p>
          <button className="setting-action" onClick={loggedIn?logout:login}>{loggedIn?"Sign out":"Sign in to Freebuff"}</button>
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
        <p data-testid="provider-status" className={modelError?"provider-status-error":""}><strong>{PROVIDER_LABELS[selected]}</strong> · {selectedStatus?.hasKey||selected==="freebuff"?(modelError?"provider error":(providerInfo?.ready?"ready":"configured")):"API key required"}{providerMessage?" · "+providerMessage:""}{modelError?" · "+modelError:""}</p>
      </div>}
      {["codex","claude","opencode"].includes(selectedAgent)&&<div className="settings-card custom-model-settings">
        <h3>Custom models</h3>
        <p>Add a model that this harness/provider supports even when discovery does not list it. Prices are optional USD estimates per million tokens.</p>
        <div className="custom-model-list">{customModels.map(item=><div key={`${item.runtime}:${item.provider||""}:${item.id}`}><span><strong>{item.name||item.id}</strong><small>{item.id}{item.effort?` · ${item.effort}`:""}{item.serviceTier?` · ${item.serviceTier}`:""}</small></span><button onClick={()=>removeCustomModel(item)}>Remove</button></div>)}</div>
        <label>Model ID<input value={modelDraft.id} onChange={e=>setModelDraft({...modelDraft,id:e.target.value})} placeholder={selectedAgent==="opencode"?"provider/model-id":"model-id"}/></label>
        <label>Display name<input value={modelDraft.name} onChange={e=>setModelDraft({...modelDraft,name:e.target.value})} placeholder="Optional friendly name"/></label>
        {selectedAgent==="codex"&&<div className="environment-two"><label>Reasoning effort<select value={modelDraft.effort} onChange={e=>setModelDraft({...modelDraft,effort:e.target.value})}><option value="">Provider default</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label><label>Service tier<input value={modelDraft.serviceTier} onChange={e=>setModelDraft({...modelDraft,serviceTier:e.target.value})} placeholder="default / priority / flex"/></label></div>}
        <div className="custom-price-grid"><label>Input / 1M<input type="number" step="0.001" min="0" value={modelDraft.inputPrice} onChange={e=>setModelDraft({...modelDraft,inputPrice:e.target.value})}/></label><label>Output / 1M<input type="number" step="0.001" min="0" value={modelDraft.outputPrice} onChange={e=>setModelDraft({...modelDraft,outputPrice:e.target.value})}/></label><label>Cache read / 1M<input type="number" step="0.001" min="0" value={modelDraft.cacheReadPrice} onChange={e=>setModelDraft({...modelDraft,cacheReadPrice:e.target.value})}/></label><label>Cache write / 1M<input type="number" step="0.001" min="0" value={modelDraft.cacheWritePrice} onChange={e=>setModelDraft({...modelDraft,cacheWritePrice:e.target.value})}/></label></div>
        <button className="setting-action" onClick={addCustomModel} disabled={!modelDraft.id.trim()}>Save custom model</button>
      </div>}
      <div className="settings-card"><h3>Runtime</h3><p>Harness connection: <strong>{rpcStatus}</strong><br/>Agent: <strong>{selectedAgentStatus?.name||selectedAgent}</strong><br/>Agent runtime: <strong>{runtime?.agentRuntimeStatus?.available||selectedAgent==="codex"?"ready":"not ready"}</strong>{selectedAgent==="codex"&&<><br/>Codex app-server: <strong>{runtime?.appServerReady?"ready":"not ready"}</strong><br/>Inference: <strong>{PROVIDER_LABELS[runtime?.provider||selected]||runtime?.provider||selected}</strong>{(runtime?.provider||selected)==="freebuff"&&<><br/>Freebuff bridge: <strong>{runtime?.bridgeReady?"ready":"not ready"}</strong></>}</>}</p><button onClick={refresh}><RefreshCw size={13}/> Refresh diagnostics</button></div>
      <div className="settings-card"><h3>Follow-up behavior</h3>{selectedAgent==="codex"?<label>While the agent is working<select value={settings.followUpMode||"queue"} onChange={e=>save({followUpMode:e.target.value})}><option value="queue">Queue after current turn</option><option value="steer">Steer current turn immediately</option></select></label>:<p>Follow-ups are queued until the current {selectedAgentStatus?.name||selectedAgent} turn finishes. ACP does not define in-flight steering.</p>}</div>
      <div className="settings-card"><h3>Default permissions</h3><label>New threads<select value={settings.defaultPermissionMode||"supervised"} onChange={e=>save({defaultPermissionMode:e.target.value})}><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></label><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.autoPull)} onChange={e=>save({autoPull:e.target.checked})}/> Automatically fast-forward clean default branches</label></div>
      {selectedAgent==="codex"&&<div className="settings-card"><h3>Computer use</h3><p>The agent can always inspect a desktop screenshot. Mouse and keyboard control are exposed only when the current thread is in <strong>Full access</strong> mode. This keeps desktop automation explicit instead of silently escalating permissions.</p></div>}
      <div className="settings-card theme-settings"><h3>Appearance</h3><p>Appearance controls light/dark behavior. Theme controls the palette independently. Trebell themes and VS Code color-theme JSON can be imported.</p><label>Mode<div className="appearance-options">{["system","light","dark"].map(v=><button key={v} className={(settings.appearanceMode||"system")===v?"active":""} onClick={()=>save({appearanceMode:v})}>{v}</button>)}</div></label><label>Theme<div className="appearance-options">{[["dark","Trebell"],["midnight","Midnight"],["black","Black"]].map(([value,label])=><button key={value} className={(settings.appearance||"dark")===value?"active":""} onClick={()=>save({appearance:value})}>{label}</button>)}{(settings.customThemes||[]).map(theme=><button key={theme.id} className={settings.appearance===theme.id?"active":""} onClick={()=>save({appearance:theme.id})}>{theme.name}</button>)}</div></label><div className="theme-actions"><button onClick={createTheme}>Create theme</button><button onClick={()=>themeImportRef.current?.click()}>Import JSON</button>{(settings.customThemes||[]).find(theme=>theme.id===settings.appearance)&&<><button onClick={()=>setThemeDraft((settings.customThemes||[]).find(theme=>theme.id===settings.appearance))}>Edit selected</button><button onClick={()=>exportTheme((settings.customThemes||[]).find(theme=>theme.id===settings.appearance))}>Export selected</button><button onClick={()=>removeTheme((settings.customThemes||[]).find(theme=>theme.id===settings.appearance))}>Delete selected</button></>}<input ref={themeImportRef} type="file" accept=".json,application/json" hidden onChange={importThemeFile}/></div>{themeDraft&&<div className="theme-editor"><label>Name<input value={themeDraft.name||""} onChange={e=>setThemeDraft({...themeDraft,name:e.target.value})}/></label><div className="theme-editor-grid"><label>Base appearance<select value={themeDraft.appearance||"dark"} onChange={e=>setThemeDraft({...themeDraft,appearance:e.target.value})}><option value="dark">Dark</option><option value="light">Light</option></select></label><label>Canvas<input type="color" value={themeDraft.canvas||"#0c0f16"} onChange={e=>setThemeDraft({...themeDraft,canvas:e.target.value})}/></label><label>Accent<input type="color" value={themeDraft.accent||"#9c6cff"} onChange={e=>setThemeDraft({...themeDraft,accent:e.target.value})}/></label></div><div className="theme-editor-actions"><button className="setting-action" onClick={saveTheme}>Save & apply</button><button onClick={()=>setThemeDraft(null)}>Close editor</button></div></div>}{themeMessage&&<p className={/failed|error/i.test(themeMessage)?"provider-status-error":"provider-note"}>{themeMessage}</p>}</div>
      <div className="settings-card"><h3>Desktop notifications</h3><label className="toggle-line"><input type="checkbox" checked={settings.notifications!==false} onChange={e=>save({notifications:e.target.checked})}/> Notify when turns finish or need attention</label><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.notificationSound)} onChange={e=>save({notificationSound:e.target.checked})}/> Allow notification sound</label></div>
      <div className="settings-card"><h3>Restart recovery</h3><p>When Trebell restarts during active work, reconnect saved provider sessions and continue the interrupted turn. Codex uses native promptless continuation; other supported harnesses resume their saved session and continue from there. Off by default to avoid unexpected background work after a restart.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.continueThreadsAfterRestart)} onChange={e=>save({continueThreadsAfterRestart:e.target.checked})}/> Continue supported active threads after restarts</label></div>
      {window.trebellDesktop?.browser?.importSources&&<div className="settings-card browser-profile-settings"><h3>Browser profiles</h3><p>Copy a supported browser session into Trebell Agent Browser. This is a one-time local copy; the source browser and Trebell stay separate afterward.</p>{browserImport.sources?.length?<>{browserImport.sources.map(source=><div className="browser-import-source" key={source.id}><div><strong>{source.name}</strong><span>{source.profiles?.length||0} profile{source.profiles?.length===1?"":"s"}{source.running?" · running":""}</span></div>{source.running&&<em>Close {source.name} before importing</em>}</div>)}<label>Profile<select value={browserImportProfile} onChange={e=>setBrowserImportProfile(e.target.value)}>{browserImport.sources.flatMap(source=>(source.profiles||[]).map(profile=><option key={profile.id} value={profile.id}>{source.name} · {profile.name}</option>))}</select></label><div className="provider-key-actions"><button className="setting-action" onClick={importBrowserProfile} disabled={browserImportBusy||!browserImportProfile||browserImport.sources.some(source=>source.running&&source.profiles?.some(profile=>profile.id===browserImportProfile))}>{browserImportBusy?"Importing…":"Import selected profile"}</button><button onClick={()=>loadBrowserImportSources()} disabled={browserImportBusy}><RefreshCw size={12}/> Rescan</button></div></>:<p className="provider-note">No directly importable browser profile was found. On Windows, Trebell supports Firefox and Helium. Other Chromium browsers use app-bound encryption and are intentionally not imported; JSON cookie import remains available in Agent Browser.</p>}<p className={browserImportMessage&&/close|failed|error/i.test(browserImportMessage)?"provider-status-error":"provider-note"}>{browserImportMessage}</p></div>}
      {window.trebellDesktop?.snapshots&&<div className="settings-card snapshot-settings"><h3>SnapShots</h3><p>Capture the foreground window from anywhere and attach it to the current draft. Captures are stored locally until Trebell successfully attaches them.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(snapshotInfo.enabled)} onChange={e=>configureSnapshots({enabled:e.target.checked})}/> Enable global SnapShot shortcut</label><label>Shortcut<input value={snapshotInfo.shortcut||""} onChange={e=>setSnapshotInfo(info=>({...info,shortcut:e.target.value}))} onBlur={()=>snapshotInfo.enabled&&configureSnapshots({shortcut:snapshotInfo.shortcut})} placeholder="CommandOrControl+Shift+S"/></label><label className="toggle-line"><input type="checkbox" checked={Boolean(snapshotInfo.includeText)} onChange={e=>configureSnapshots({includeText:e.target.checked})}/> Include accessibility text and control positions</label><p className="provider-note">App text is off by default because visible UI can contain sensitive information. {snapshotInfo.pending?`${snapshotInfo.pending} capture${snapshotInfo.pending===1?"":"s"} waiting to attach. `:""}{snapshotMessage}</p><div className="provider-key-actions"><button onClick={()=>window.trebellDesktop.snapshots.capture().catch(error=>setSnapshotMessage(error.message))}>Capture now</button><button onClick={()=>configureSnapshots({shortcut:snapshotInfo.shortcut})} disabled={!snapshotInfo.enabled}>Save shortcut</button></div></div>}
      <div className="settings-card"><h3>Devices</h3><p>The Device panel can inspect and control local Android emulators or iOS simulators. Physical phones are not controlled. Agent access is separate and off by default.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.agentDeviceAccess)} onChange={e=>save({agentDeviceAccess:e.target.checked})}/> Allow newly started Codex threads to use simulator tools</label></div>
      <div className="settings-card"><h3>Background mode</h3><p>Keep Trebell's local harness running in the system tray after the window closes, and start it with Windows.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.backgroundMode)} onChange={async e=>{const enabled=e.target.checked;await window.trebellDesktop?.background?.set?.(enabled);await save({backgroundMode:enabled})}}/> Keep Trebell running in background</label></div>
      <div className="settings-card keybindings-settings"><h3>Keyboard shortcuts</h3><p>Shortcuts can be conditional. For example, <code>threadOpen && !modalOpen</code> means “only when a thread is open and no dialog is covering the app.”</p>{KEYBINDING_COMMANDS.map(command=>{const rule=keybindingRules.find(item=>item.command===command.id);return <div className="keybinding-row" key={command.id}><strong>{command.label}</strong><label>Shortcut<input value={rule?.key||""} onChange={e=>updateKeybinding(command.id,{key:e.target.value})}/></label><label>When<input value={rule?.when||""} placeholder="Always" onChange={e=>updateKeybinding(command.id,{when:e.target.value})}/></label></div>})}<p className="provider-note">Available contexts: chatFocus, terminalFocus, previewFocus, textInputFocus, projectOpen, threadOpen, running, modalOpen, rightPanelOpen, desktop. Combine them with <code>!</code>, <code>&&</code>, <code>||</code> and parentheses.</p></div>
      <div className="settings-card"><h3>Updates</h3>{update?.latest?<p>Current: <strong>{update.current}</strong><br/>Latest: <strong>{update.latest}</strong></p>:<p>{update?.error||"Checking releases…"}</p>}{update?.url&&<button onClick={()=>window.open(update.url,"_blank")}><Download size={13}/> Open latest release</button>}</div>
      <div className="settings-card"><h3>Diagnostics</h3><p>Runtime and project diagnostics are local to this machine.</p><div className="diag-badges"><span className={runtime?.agentRuntimeStatus?.available||selectedAgent==="codex"?"ok":""}><Activity size={12}/> {selectedAgentStatus?.name||selectedAgent}</span>{selectedAgent==="codex"&&<span className={diagnostics?.runtime?.providerReady?"ok":""}><ShieldCheck size={12}/> {PROVIDER_LABELS[diagnostics?.runtime?.provider||selected]||"Provider"}</span>}</div></div>
    </div>
    <div className="diagnostics-log"><div><strong>Runtime log</strong><button onClick={refresh} disabled={loading}><RefreshCw size={12}/></button></div><pre>{(diagnostics?.logs||[]).map(x=>"["+new Date(x.at).toLocaleTimeString()+"] "+x.stream+": "+x.text).join("")||"No runtime log entries."}</pre></div>
  </div>;
}
