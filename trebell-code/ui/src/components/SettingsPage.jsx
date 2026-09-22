import React,{useEffect,useState} from "react";
import { Activity, Bot, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../api.js";
import { KEYBINDING_COMMANDS, normalizeKeybindingRules } from "../keybindings.js";

const PROVIDER_LABELS={
  freebuff:"Freebuff",
  agentrouter:"AgentRouter",
  justworker:"JustWorker.icu",
  hcnsec:"HCNSec.cn",
  vyceai:"VyceAi",
};

export default function SettingsPage({settings,onSettings,onProviderUpdated,runtime,rpcStatus,loggedIn,login,logout,projectPath,modelError}){
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
      await onProviderUpdated?.({resetThread:true});
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
      await onProviderUpdated?.();
    }
    if("customModels" in patch)await onProviderUpdated?.();
    return next;
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
        <span className="about-version">v{diagnostics?.version||update?.current||"1.2.0"}</span>
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
      <div className="settings-card"><h3>Appearance</h3><div className="appearance-options">{["dark","midnight","black"].map(v=><button key={v} className={settings.appearance===v?"active":""} onClick={()=>save({appearance:v})}>{v}</button>)}</div></div>
      <div className="settings-card"><h3>Desktop notifications</h3><label className="toggle-line"><input type="checkbox" checked={settings.notifications!==false} onChange={e=>save({notifications:e.target.checked})}/> Notify when turns finish or need attention</label><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.notificationSound)} onChange={e=>save({notificationSound:e.target.checked})}/> Allow notification sound</label></div>
      <div className="settings-card"><h3>Background mode</h3><p>Keep Trebell's local harness running in the system tray after the window closes, and start it with Windows.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.backgroundMode)} onChange={async e=>{const enabled=e.target.checked;await window.trebellDesktop?.background?.set?.(enabled);await save({backgroundMode:enabled})}}/> Keep Trebell running in background</label></div>
      <div className="settings-card keybindings-settings"><h3>Keyboard shortcuts</h3><p>Shortcuts can be conditional. For example, <code>threadOpen && !modalOpen</code> means “only when a thread is open and no dialog is covering the app.”</p>{KEYBINDING_COMMANDS.map(command=>{const rule=keybindingRules.find(item=>item.command===command.id);return <div className="keybinding-row" key={command.id}><strong>{command.label}</strong><label>Shortcut<input value={rule?.key||""} onChange={e=>updateKeybinding(command.id,{key:e.target.value})}/></label><label>When<input value={rule?.when||""} placeholder="Always" onChange={e=>updateKeybinding(command.id,{when:e.target.value})}/></label></div>})}<p className="provider-note">Available contexts: chatFocus, terminalFocus, previewFocus, textInputFocus, projectOpen, threadOpen, running, modalOpen, rightPanelOpen, desktop. Combine them with <code>!</code>, <code>&&</code>, <code>||</code> and parentheses.</p></div>
      <div className="settings-card"><h3>Updates</h3>{update?.latest?<p>Current: <strong>{update.current}</strong><br/>Latest: <strong>{update.latest}</strong></p>:<p>{update?.error||"Checking releases…"}</p>}{update?.url&&<button onClick={()=>window.open(update.url,"_blank")}><Download size={13}/> Open latest release</button>}</div>
      <div className="settings-card"><h3>Diagnostics</h3><p>Runtime and project diagnostics are local to this machine.</p><div className="diag-badges"><span className={runtime?.agentRuntimeStatus?.available||selectedAgent==="codex"?"ok":""}><Activity size={12}/> {selectedAgentStatus?.name||selectedAgent}</span>{selectedAgent==="codex"&&<span className={diagnostics?.runtime?.providerReady?"ok":""}><ShieldCheck size={12}/> {PROVIDER_LABELS[diagnostics?.runtime?.provider||selected]||"Provider"}</span>}</div></div>
    </div>
    <div className="diagnostics-log"><div><strong>Runtime log</strong><button onClick={refresh} disabled={loading}><RefreshCw size={12}/></button></div><pre>{(diagnostics?.logs||[]).map(x=>"["+new Date(x.at).toLocaleTimeString()+"] "+x.stream+": "+x.text).join("")||"No runtime log entries."}</pre></div>
  </div>;
}
