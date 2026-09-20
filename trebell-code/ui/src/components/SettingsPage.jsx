import React,{useEffect,useState} from "react";
import { Activity, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../api.js";

const PROVIDER_LABELS={
  freebuff:"Freebuff",
  agentrouter:"AgentRouter",
  justworker:"JustWorker.icu",
  hcnsec:"HCNSec.cn",
  vyceai:"VyceAi",
};

export default function SettingsPage({settings,onSettings,onProviderUpdated,runtime,rpcStatus,loggedIn,login,logout,projectPath}){
  const [update,setUpdate]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [loading,setLoading]=useState(false);
  const [providerInfo,setProviderInfo]=useState(null);
  const [apiKey,setApiKey]=useState("");
  const [providerMessage,setProviderMessage]=useState("");
  const selected=settings.modelProvider||"freebuff";

  async function loadProviders(){
    const info=await api("/api/providers").catch(e=>({error:e.message,providers:[]}));
    setProviderInfo(info);
    return info;
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
    return next;
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
    ]);
    setUpdate(u);setDiagnostics(d);setLoading(false);
  }
  useEffect(()=>{refresh()},[projectPath]);
  useEffect(()=>{loadProviders()},[selected]);

  const selectedStatus=providerInfo?.providers?.find(p=>p.id===selected)||providerInfo?.status;
  return <div className="settings-page">
    <div className="settings-grid">
      <div className="settings-card provider-settings-card">
        <h3>Model provider</h3>
        <p>Codex stays as the local agent harness. Choose which inference service powers its turns.</p>
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
          <p className="provider-note">{selected==="agentrouter"?"Available models: GPT-5.6 Sol, GPT-6 Astra, Claude Opus 4.8, Claude Opus 5, DeepSeek V4 Flash.":selected==="vyceai"?"Models are loaded live from Vyce AI /v1/models for this key.":selected==="justworker"?"Available model: claude-opus-4-8.":"Available model: glm-5.3."}</p>
        </>}
        <p data-testid="provider-status"><strong>{PROVIDER_LABELS[selected]}</strong> · {selectedStatus?.hasKey||selected==="freebuff"?(providerInfo?.ready?"ready":"configured"):"API key required"}{providerMessage?" · "+providerMessage:""}</p>
      </div>
      <div className="settings-card"><h3>Runtime</h3><p>Harness: <strong>{rpcStatus}</strong><br/>Codex app-server: <strong>{runtime?.appServerReady?"ready":"not ready"}</strong><br/>Provider: <strong>{PROVIDER_LABELS[runtime?.provider||selected]||runtime?.provider||selected}</strong>{(runtime?.provider||selected)==="freebuff"&&<><br/>Freebuff bridge: <strong>{runtime?.bridgeReady?"ready":"not ready"}</strong></>}</p><button onClick={refresh}><RefreshCw size={13}/> Refresh diagnostics</button></div>
      <div className="settings-card"><h3>Follow-up behavior</h3><label>While the agent is working<select value={settings.followUpMode||"queue"} onChange={e=>save({followUpMode:e.target.value})}><option value="queue">Queue after current turn</option><option value="steer">Steer current turn immediately</option></select></label></div>
      <div className="settings-card"><h3>Default permissions</h3><label>New threads<select value={settings.defaultPermissionMode||"supervised"} onChange={e=>save({defaultPermissionMode:e.target.value})}><option value="supervised">Supervised</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></label><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.autoPull)} onChange={e=>save({autoPull:e.target.checked})}/> Automatically fast-forward clean default branches</label></div>
      <div className="settings-card"><h3>Appearance</h3><div className="appearance-options">{["dark","midnight","black"].map(v=><button key={v} className={settings.appearance===v?"active":""} onClick={()=>save({appearance:v})}>{v}</button>)}</div></div>
      <div className="settings-card"><h3>Desktop notifications</h3><label className="toggle-line"><input type="checkbox" checked={settings.notifications!==false} onChange={e=>save({notifications:e.target.checked})}/> Notify when turns finish or need attention</label><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.notificationSound)} onChange={e=>save({notificationSound:e.target.checked})}/> Allow notification sound</label></div>
      <div className="settings-card"><h3>Background mode</h3><p>Keep Trebell's local harness running in the system tray after the window closes, and start it with Windows.</p><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.backgroundMode)} onChange={async e=>{const enabled=e.target.checked;await window.trebellDesktop?.background?.set?.(enabled);await save({backgroundMode:enabled})}}/> Keep Trebell running in background</label></div>
      <div className="settings-card"><h3>Keyboard shortcuts</h3><p>Shortcuts are stored locally and used by the desktop client.</p>{[
        ["newChat","New thread","Ctrl+N"],["search","Search","Ctrl+K"],["stash","Stash prompt","Ctrl+S"],["terminal","Terminal","Ctrl+Shift+T"]
      ].map(([key,label,fallback])=><label key={key}>{label}<input value={settings.keyboardShortcuts?.[key]||fallback} onChange={e=>save({keyboardShortcuts:{...(settings.keyboardShortcuts||{}),[key]:e.target.value}})}/></label>)}</div>
      <div className="settings-card"><h3>Updates</h3>{update?.latest?<p>Current: <strong>{update.current}</strong><br/>Latest: <strong>{update.latest}</strong></p>:<p>{update?.error||"Checking releases…"}</p>}{update?.url&&<button onClick={()=>window.open(update.url,"_blank")}><Download size={13}/> Open latest release</button>}</div>
      <div className="settings-card"><h3>Diagnostics</h3><p>Runtime and project diagnostics are local to this machine.</p><div className="diag-badges"><span className={diagnostics?.runtime?.appServerReady?"ok":""}><Activity size={12}/> Codex</span><span className={diagnostics?.runtime?.providerReady?"ok":""}><ShieldCheck size={12}/> {PROVIDER_LABELS[diagnostics?.runtime?.provider||selected]||"Provider"}</span></div></div>
    </div>
    <div className="diagnostics-log"><div><strong>Runtime log</strong><button onClick={refresh} disabled={loading}><RefreshCw size={12}/></button></div><pre>{(diagnostics?.logs||[]).map(x=>"["+new Date(x.at).toLocaleTimeString()+"] "+x.stream+": "+x.text).join("")||"No runtime log entries."}</pre></div>
  </div>;
}
