import React,{useEffect,useState} from "react";
import { Globe2, Laptop2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { api } from "../api.js";

export default function EnvironmentsPage(){
  const [data,setData]=useState({profiles:[],capabilities:{local:{available:true},ssh:{available:false},wsl:{available:false,distros:[]}}});
  const [remote,setRemote]=useState({enabled:false,running:false,port:3211,token:"",urls:[]});
  const [draft,setDraft]=useState({type:"local",name:"",cwd:"",distro:"",host:"",user:"",port:22,identityFile:""});
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
      setDraft({type:"local",name:"",cwd:"",distro:"",host:"",user:"",port:22,identityFile:""});
      await refresh();
    }catch(e){setMessage(e.message)}finally{setBusy("")}
  }
  async function remove(id){await api("/api/environments?id="+encodeURIComponent(id),{method:"DELETE"});await refresh()}
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

  return <div className="environments-page">
    <div className="capabilities-toolbar"><div><h2>Environments & remote access</h2><p>Run Trebell against local Windows workspaces, WSL distributions or SSH machines. Remote access exposes the same desktop harness to another device on your LAN behind a bearer token.</p></div><button onClick={refresh}><RefreshCw size={13}/> Refresh</button></div>
    {message&&<div className="inline-status">{message}</div>}
    <div className="environment-grid">
      <section className="capability-card">
        <div className="capability-card-head"><span><Laptop2 size={15}/><strong>Configured environments</strong></span><em>{data.profiles.length}</em></div>
        <div className="environment-list">{data.profiles.map(profile=><div key={profile.id}><div><strong>{profile.name}</strong><span>{profile.type.toUpperCase()} · {profile.cwd||profile.host||profile.distro||"default"}</span></div><div><button onClick={()=>probe(profile.id)} disabled={!!busy}>Test</button><button className="danger" onClick={()=>remove(profile.id)}><Trash2 size={12}/></button></div></div>)}</div>
        {!data.profiles.length&&<p>No saved environments. Local project folders still work normally.</p>}
      </section>
      <section className="capability-card environment-create">
        <div className="capability-card-head"><span><Plus size={15}/><strong>Add environment</strong></span></div>
        <label>Type<select value={draft.type} onChange={e=>setDraft(d=>({...d,type:e.target.value}))}><option value="local">Local</option><option value="wsl" disabled={!data.capabilities?.wsl?.available}>WSL</option><option value="ssh" disabled={!data.capabilities?.ssh?.available}>SSH</option></select></label>
        <label>Name<input value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} placeholder="My environment"/></label>
        <label>Working directory<input value={draft.cwd} onChange={e=>setDraft(d=>({...d,cwd:e.target.value}))} placeholder={draft.type==="wsl"?"/home/me/project":draft.type==="ssh"?"/srv/project":"C:\\code\\project"}/></label>
        {draft.type==="wsl"&&<label>Distribution<select value={draft.distro} onChange={e=>setDraft(d=>({...d,distro:e.target.value}))}><option value="">Default WSL distro</option>{(data.capabilities?.wsl?.distros||[]).map(x=><option key={x}>{x}</option>)}</select></label>}
        {draft.type==="ssh"&&<><label>Host<input value={draft.host} onChange={e=>setDraft(d=>({...d,host:e.target.value}))} placeholder="dev.example.com"/></label><div className="environment-two"><label>User<input value={draft.user} onChange={e=>setDraft(d=>({...d,user:e.target.value}))}/></label><label>Port<input type="number" value={draft.port} onChange={e=>setDraft(d=>({...d,port:Number(e.target.value)||22}))}/></label></div><label>Identity file<input value={draft.identityFile} onChange={e=>setDraft(d=>({...d,identityFile:e.target.value}))} placeholder="C:\\Users\\me\\.ssh\\id_ed25519"/></label></>}
        <button className="primary" onClick={add} disabled={!!busy||(draft.type==="ssh"&&!draft.host.trim())}><Plus size={13}/> Add environment</button>
      </section>
      <section className="capability-card remote-access-card">
        <div className="capability-card-head"><span><Globe2 size={15}/><strong>LAN remote control</strong></span><em className={remote.running?"ok":""}>{remote.running?"running":"off"}</em></div>
        <label className="toggle-line"><input type="checkbox" checked={remote.enabled} onChange={e=>saveRemote({enabled:e.target.checked})}/> Enable remote access</label>
        <label>Port<input type="number" min="1024" max="65535" value={remote.port||3211} onChange={e=>setRemote(r=>({...r,port:Number(e.target.value)||3211}))} onBlur={()=>remote.enabled&&saveRemote({port:remote.port})}/></label>
        {remote.enabled&&<><label>Access token<input readOnly value={remote.token||""}/></label><button onClick={()=>saveRemote({regenerateToken:true})} disabled={!!busy}>Regenerate token</button><div className="remote-urls">{(remote.urls||[]).map(url=><code key={url}>{url}</code>)}</div></>}
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
