import React,{useEffect,useState} from "react";
import { Activity, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../api.js";

export default function SettingsPage({settings,onSettings,runtime,rpcStatus,loggedIn,login,logout,projectPath}){
  const [update,setUpdate]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [loading,setLoading]=useState(false);
  async function save(patch){const next=await api("/api/settings",{method:"POST",body:patch});onSettings(next)}
  async function refresh(){
    setLoading(true);
    const [u,d]=await Promise.all([
      api("/api/update/check").catch(e=>({error:e.message})),
      api("/api/diagnostics?path="+encodeURIComponent(projectPath||"")).catch(e=>({error:e.message})),
    ]);
    setUpdate(u);setDiagnostics(d);setLoading(false);
  }
  useEffect(()=>{refresh()},[projectPath]);
  return <div className="settings-page">
    <div className="settings-grid">
      <div className="settings-card"><h3>Freebuff</h3><p>{loggedIn?"Signed in. Freebuff is the only model provider used by Trebell.":"Sign in to use Freebuff inference."}</p><button className="setting-action" onClick={loggedIn?logout:login}>{loggedIn?"Sign out":"Sign in to Freebuff"}</button></div>
      <div className="settings-card"><h3>Runtime</h3><p>Harness: <strong>{rpcStatus}</strong><br/>Codex app-server: <strong>{runtime?.appServerReady?"ready":"not ready"}</strong><br/>Freebuff bridge: <strong>{runtime?.bridgeReady?"ready":"not ready"}</strong></p><button onClick={refresh}><RefreshCw size={13}/> Refresh diagnostics</button></div>
      <div className="settings-card"><h3>Follow-up behavior</h3><label>While the agent is working<select value={settings.followUpMode||"queue"} onChange={e=>save({followUpMode:e.target.value})}><option value="queue">Queue after current turn</option><option value="steer">Steer current turn immediately</option></select></label></div>
      <div className="settings-card"><h3>Default permissions</h3><label>New threads<select value={settings.defaultPermissionMode||"supervised"} onChange={e=>save({defaultPermissionMode:e.target.value})}><option value="supervised">Supervised</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></label><label className="toggle-line"><input type="checkbox" checked={Boolean(settings.autoPull)} onChange={e=>save({autoPull:e.target.checked})}/> Automatically fast-forward clean default branches</label></div>
      <div className="settings-card"><h3>Appearance</h3><div className="appearance-options">{["dark","midnight","black"].map(v=><button key={v} className={settings.appearance===v?"active":""} onClick={()=>save({appearance:v})}>{v}</button>)}</div></div>
      <div className="settings-card"><h3>Keyboard shortcuts</h3><p>Shortcuts are stored locally and used by the desktop client.</p>{[
        ["newChat","New thread","Ctrl+N"],["search","Search","Ctrl+K"],["stash","Stash prompt","Ctrl+S"],["terminal","Terminal","Ctrl+Shift+T"]
      ].map(([key,label,fallback])=><label key={key}>{label}<input value={settings.keyboardShortcuts?.[key]||fallback} onChange={e=>save({keyboardShortcuts:{...(settings.keyboardShortcuts||{}),[key]:e.target.value}})}/></label>)}</div>
      <div className="settings-card"><h3>Updates</h3>{update?.latest?<p>Current: <strong>{update.current}</strong><br/>Latest: <strong>{update.latest}</strong></p>:<p>{update?.error||"Checking releases…"}</p>}{update?.url&&<button onClick={()=>window.open(update.url,"_blank")}><Download size={13}/> Open latest release</button>}</div>
      <div className="settings-card"><h3>Diagnostics</h3><p>Runtime and project diagnostics are local to this machine.</p><div className="diag-badges"><span className={diagnostics?.runtime?.appServerReady?"ok":""}><Activity size={12}/> Codex</span><span className={diagnostics?.runtime?.bridgeReady?"ok":""}><ShieldCheck size={12}/> Freebuff</span></div></div>
    </div>
    <div className="diagnostics-log"><div><strong>Runtime log</strong><button onClick={refresh} disabled={loading}><RefreshCw size={12}/></button></div><pre>{(diagnostics?.logs||[]).map(x=>"["+new Date(x.at).toLocaleTimeString()+"] "+x.stream+": "+x.text).join("")||"No runtime log entries."}</pre></div>
  </div>;
}
