import React,{useEffect,useState} from "react";
import { Globe2, Laptop2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { writeClipboardText } from "../clipboard.js";

export default function EnvironmentsPage(){
  const [data,setData]=useState({profiles:[],activeEnvironmentId:null,activeEnvironment:null,capabilities:{local:{available:true},ssh:{available:false},wsl:{available:false,distros:[]}}});
  const [remote,setRemote]=useState({enabled:false,running:false,port:3211,urls:[],devices:[]});
  const [pairing,setPairing]=useState(null);
  const [draft,setDraft]=useState({type:"local",name:"",cwd:"",distro:"",host:"",user:"",port:22,identityFile:"",codexPath:"codex",themeDirectory:""});
  const [busy,setBusy]=useState("");
  const [message,setMessage]=useState("");

  async function refresh(){
    const [e,r]=await Promise.all([api("/api/environments"),api("/api/remote-access")]);
    setData(e);setRemote(r);
  }
  useEffect(()=>{refresh().catch(e=>setMessage(e.message))},[]);

  async function add(){
    setBusy("add");setMessage("");
    try{
      const body={...draft,name:draft.name||({local:"Local machine",wsl:"WSL",ssh:"SSH"}[draft.type])};
      await api("/api/environments",{method:"POST",body});
      setDraft({type:"local",name:"",cwd:"",distro:"",host:"",user:"",port:22,identityFile:"",codexPath:"codex",themeDirectory:""});
      await refresh();
    }catch(e){setMessage(e.message)}finally{setBusy("")}
  }
  async function remove(id){await api("/api/environments?id="+encodeURIComponent(id),{method:"DELETE"});await refresh()}
  async function setEnabled(id,enabled){
    setBusy("enabled:"+id);setMessage("");
    try{
      const wasActive=data.activeEnvironmentId===id;
      const result=await api("/api/environment/enabled",{method:"POST",body:{id,enabled}});
      await refresh();
      setMessage(enabled?"Environment switched on.":"Environment switched off. Its configuration is still saved.");
      if(wasActive&&!enabled&&result.activeEnvironmentId!==id)setTimeout(()=>window.location.reload(),120);
    }catch(e){setMessage(e.message)}finally{setBusy("")}
  }
  async function activate(id){
    setBusy("activate:"+(id||"local"));setMessage("");
    try{
      const result=await api("/api/environment/activate",{method:"POST",body:{id:id||null}});
      if(result.error)throw new Error(result.error);
      const labels={codex:"Codex",claude:"Claude Code",opencode:"OpenCode",cursor:"Cursor",grok:"Grok Build",antigravity:"Antigravity"};
      const runtimeName=result.agentRuntimeStatus?.name||labels[result.agentRuntime]||"active agent runtime";
      const ready=result.agentRuntimeReady??result.appServerReady;
      setMessage(ready?`Environment switched for ${runtimeName}. Reconnecting…`:`Environment selected, but ${runtimeName} is not ready.`);
      setTimeout(()=>window.location.reload(),120);
    }catch(e){setMessage(e.message)}finally{setBusy("")}
  }
  async function probe(id){
    setBusy("probe:"+id);setMessage("");
    try{const r=await api("/api/environment/probe",{method:"POST",body:{id}});setMessage((r.ok?"Connected":"Probe failed")+" · "+(r.stdout||r.stderr||"").trim())}
    catch(e){setMessage(e.message)}finally{setBusy("")}
  }
  async function saveRemote(patch){
    setBusy("remote");setMessage("");
    try{const r=await api("/api/remote-access",{method:"POST",body:patch});setRemote(r)}
    catch(e){setMessage(e.message)}finally{setBusy("")}
  }
  async function createPairing(){
    setBusy("pair");setMessage("");
    try{const result=await api("/api/remote-access/pair",{method:"POST",body:{}});setPairing(result);const first=result.urls?.[0];if(first){const copied=await writeClipboardText(first);setMessage(copied?"Pairing link created and copied. It can be used once before it expires.":"Pairing link created. Copy it below before it expires.")}}
    catch(e){setMessage(e.message)}finally{setBusy("")}
  }
  async function revokeDevice(id){
    setBusy("device:"+id);setMessage("");
    try{const result=await api("/api/remote-access/device?id="+encodeURIComponent(id),{method:"DELETE"});setRemote(current=>({...current,devices:result.devices||[]}));setMessage(result.ok?"Remote device revoked.":"Device was already removed.")}
    catch(e){setMessage(e.message)}finally{setBusy("")}
  }

  return <div className="environments-page">
    <div className="capabilities-toolbar"><div><h2>Environments & remote access</h2><p>Run the active coding-agent runtime on local Windows, inside WSL, or on an SSH machine. LAN remote control pairs another device with a one-time link and gives it a revocable session.</p></div><button onClick={refresh}><RefreshCw size={13}/> Refresh</button></div>
    {message&&<div className="inline-status">{message}</div>}
    <div className="environment-grid">
      <section className="capability-card">
        <div className="capability-card-head"><span><Laptop2 size={15}/><strong>Configured environments</strong></span><em>{data.profiles.length}</em></div>
        <div className="environment-list">
          <div><div><strong>Local machine</strong><span>WINDOWS · Trebell desktop host</span></div><div>{!data.activeEnvironmentId?<em className="ok">active</em>:<button onClick={()=>activate(null)} disabled={!!busy}>Use for agent</button>}</div></div>
          {data.profiles.map(profile=>{const enabled=profile.enabled!==false;return <div key={profile.id}><div><strong>{profile.name}</strong><span>{profile.type.toUpperCase()} · {profile.cwd||profile.host||profile.distro||"default"}{profile.themeDirectory?" · themes "+profile.themeDirectory:""}{enabled?"":" · switched off"}</span></div><div>{data.activeEnvironmentId===profile.id?<em className="ok">agent active</em>:<button onClick={()=>activate(profile.id)} disabled={!!busy||!enabled}>Use for agent</button>}<button onClick={()=>probe(profile.id)} disabled={!!busy||!enabled}>Test</button><button onClick={()=>setEnabled(profile.id,!enabled)} disabled={!!busy}>{enabled?"Switch off":"Switch on"}</button><button className="danger" onClick={()=>remove(profile.id)} disabled={data.activeEnvironmentId===profile.id}><Trash2 size={12}/></button></div></div>})}</div>
        {!data.profiles.length&&<p>No saved remote environments. The local Windows agent is active by default.</p>}
      </section>
      <section className="capability-card environment-create">
        <div className="capability-card-head"><span><Plus size={15}/><strong>Add environment</strong></span></div>
        <label>Type<select value={draft.type} onChange={e=>setDraft(d=>({...d,type:e.target.value}))}><option value="local">Local</option><option value="wsl" disabled={!data.capabilities?.wsl?.available}>WSL</option><option value="ssh" disabled={!data.capabilities?.ssh?.available}>SSH</option></select></label>
        <label>Name<input value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} placeholder="My environment"/></label>
        <label>Working directory<input value={draft.cwd} onChange={e=>setDraft(d=>({...d,cwd:e.target.value}))} placeholder={draft.type==="wsl"?"/home/me/project":draft.type==="ssh"?"/srv/project":"C:\\code\\project"}/></label>
        <label>Published themes directory<input value={draft.themeDirectory} onChange={e=>setDraft(d=>({...d,themeDirectory:e.target.value}))} placeholder={draft.type==="local"?"Default Trebell themes folder":"Default .trebell/themes"}/></label>
        {draft.type==="wsl"&&<label>Distribution<select value={draft.distro} onChange={e=>setDraft(d=>({...d,distro:e.target.value}))}><option value="">Default WSL distro</option>{(data.capabilities?.wsl?.distros||[]).map(x=><option key={x}>{x}</option>)}</select></label>}
        {draft.type!=="local"&&<label>Codex executable<input value={draft.codexPath||"codex"} onChange={e=>setDraft(d=>({...d,codexPath:e.target.value}))} placeholder="/usr/local/bin/codex"/></label>}
        {draft.type==="ssh"&&<><label>Host<input value={draft.host} onChange={e=>setDraft(d=>({...d,host:e.target.value}))} placeholder="dev.example.com"/></label><div className="environment-two"><label>User<input value={draft.user} onChange={e=>setDraft(d=>({...d,user:e.target.value}))}/></label><label>Port<input type="number" value={draft.port} onChange={e=>setDraft(d=>({...d,port:Number(e.target.value)||22}))}/></label></div><label>Identity file<input value={draft.identityFile} onChange={e=>setDraft(d=>({...d,identityFile:e.target.value}))} placeholder="C:\\Users\\me\\.ssh\\id_ed25519"/></label></>}
        <button className="primary" onClick={add} disabled={!!busy||(draft.type==="ssh"&&!draft.host.trim())}><Plus size={13}/> Add environment</button>
      </section>
      <section className="capability-card remote-access-card">
        <div className="capability-card-head"><span><Globe2 size={15}/><strong>LAN remote control</strong></span><em className={remote.running?"ok":""}>{remote.running?"running":"off"}</em></div>
        <label className="toggle-line"><input type="checkbox" checked={remote.enabled} onChange={e=>saveRemote({enabled:e.target.checked})}/> Enable remote access</label>
        <label>Port<input type="number" min="1024" max="65535" value={remote.port||3211} onChange={e=>setRemote(r=>({...r,port:Number(e.target.value)||3211}))} onBlur={()=>remote.enabled&&saveRemote({port:remote.port})}/></label>
        {remote.enabled&&<><div className="capability-actions"><button onClick={createPairing} disabled={!!busy}>Create one-time pairing link</button></div>{pairing&&<div className="remote-pairing"><span>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</span>{(pairing.urls||[]).map(url=><div key={url}><code>{url}</code><button onClick={async()=>setMessage(await writeClipboardText(url)?"Pairing link copied.":"Copy failed. Select the pairing link and copy it manually.")}>Copy</button></div>)}</div>}<div className="remote-devices"><strong>Paired devices</strong>{(remote.devices||[]).length?(remote.devices||[]).map(device=><div key={device.id}><span><b>{device.name}</b><small>Last seen {new Date(device.lastSeenAt||device.createdAt).toLocaleString()}</small></span><button className="danger" onClick={()=>revokeDevice(device.id)} disabled={!!busy}><Trash2 size={12}/> Revoke</button></div>):<p>No paired devices yet.</p>}</div><div className="remote-urls">{(remote.urls||[]).map(url=><code key={url}>{url}</code>)}</div></>}
      </section>
      <section className="capability-card">
        <div className="capability-card-head"><span><Server size={15}/><strong>Host capabilities</strong></span></div>
        <div className="capability-list">
          <div><div><strong>Local</strong><span>This machine</span></div><em className="ok">ready</em></div>
          <div><div><strong>WSL</strong><span>{data.capabilities?.wsl?.distros?.join(", ")||data.capabilities?.wsl?.error||"No distributions detected"}</span></div><em className={data.capabilities?.wsl?.available?"ok":""}>{data.capabilities?.wsl?.available?"ready":"unavailable"}</em></div>
          <div><div><strong>SSH</strong><span>{data.capabilities?.ssh?.version||data.capabilities?.ssh?.error||"OpenSSH client"}</span></div><em className={data.capabilities?.ssh?.available?"ok":""}>{data.capabilities?.ssh?.available?"ready":"unavailable"}</em></div>
        </div>
      </section>
    </div>
  </div>;
}
