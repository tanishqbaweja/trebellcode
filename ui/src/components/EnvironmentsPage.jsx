import React,{useEffect,useRef,useState} from "react";
import { Laptop2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { api } from "../api.js";

// The Environments page on screen, if any. An Undo outlives the page that offered it (its toast stays while the person moves
// on, or leaves and comes back), so a restore reports to the page that shows now, or throws for the app's error toast.
let environmentsOnScreen=null;

export default function EnvironmentsPage({onOfferUndo}={}){
  const [data,setData]=useState({profiles:[],activeEnvironmentId:null,activeEnvironment:null,capabilities:{local:{available:true},ssh:{available:false},wsl:{available:false,distros:[]}}});
  const [draft,setDraft]=useState({type:"local",name:"",cwd:"",distro:"",host:"",user:"",port:22,identityFile:"",codexPath:"",themeDirectory:""});
  const [busy,setBusy]=useState("");
  // A notice reports what an action did; an error says what failed and is styled as one.
  const [message,setMessageState]=useState({text:"",tone:"notice"});
  const setMessage=(text,tone="notice")=>setMessageState({text:String(text||""),tone});
  const setError=text=>setMessage(text,"error");
  // Host discovery (ssh -V, wsl --list) can take seconds: until /api/environments first answers, the page says it is checking
  // instead of showing its starting values (no WSL, no SSH, no platform) as results.
  const [discovery,setDiscovery]=useState("checking");
  const localPlatformLabel={win32:"Windows",linux:"Linux",darwin:"macOS"}[data.capabilities?.local?.platform]||"";
  // The port is kept as typed so the field can be cleared and retyped; it is sent as a number.
  // A TCP port is a whole number from 1 to 65535; anything else would be saved and only fail at connect time.
  const portNumber=String(draft.port).trim()===""?NaN:Number(draft.port);
  const portInvalid=draft.type==="ssh"&&!(Number.isInteger(portNumber)&&portNumber>=1&&portNumber<=65535);

  async function refresh({reportErrors=false}={}){
    try{setData(await api("/api/environments"));setDiscovery("done");if(reportErrors)setMessage("");return true}
    catch(error){setDiscovery(state=>state==="done"?"done":"failed");if(reportErrors)setError("Could not refresh environments: "+(error?.message||String(error)));return false}
  }
  useEffect(()=>{refresh({reportErrors:true})},[]);

  async function add(){
    setBusy("add");setMessage("");
    try{
      const body={...draft,port:Number.isInteger(portNumber)?portNumber:22,name:draft.name||({local:"Local machine",wsl:"WSL",ssh:"SSH"}[draft.type])};
      await api("/api/environments",{method:"POST",body});
      setDraft({type:"local",name:"",cwd:"",distro:"",host:"",user:"",port:22,identityFile:"",codexPath:"",themeDirectory:""});
      await refresh();
    }catch(e){setError(e.message)}finally{setBusy("")}
  }
  // The listed profile is the whole saved environment, and POST /api/environments keeps its id, so Undo puts back the same
  // environment: projects that use it find it again.
  async function remove(profile){
    setBusy("remove:"+profile.id);setMessage("");
    try{
      const result=await api("/api/environments?id="+encodeURIComponent(profile.id),{method:"DELETE"});
      setData(current=>({...current,profiles:(current.profiles||[]).filter(item=>item.id!==profile.id)}));
      if(onOfferUndo&&result?.ok!==false)onOfferUndo(`Environment “${profile.name}” removed`,()=>restoreEnvironment(profile));
      else setMessage("Environment removed.");
      await refresh();
    }catch(e){setError("Could not remove environment: "+(e.message||String(e)))}
    finally{setBusy("")}
  }
  async function restoreEnvironment(profile){
    try{await api("/api/environments",{method:"POST",body:profile})}
    catch(e){const page=environmentsOnScreen?.current;if(!page)throw e;page.showError("Could not restore environment: "+(e.message||String(e)));return}
    // Projects may be the page on screen: its cards and the removals they offer read the environment again.
    window.dispatchEvent(new CustomEvent("trebell:environments-changed"));
    await environmentsOnScreen?.current?.refresh({reportErrors:true});
  }
  const screenRef=useRef(null);
  screenRef.current={showError:setError,refresh};
  useEffect(()=>{const page=screenRef;environmentsOnScreen=page;return()=>{if(environmentsOnScreen===page)environmentsOnScreen=null}},[]);
  async function setEnabled(id,enabled){
    setBusy("enabled:"+id);setMessage("");
    try{
      const wasActive=data.activeEnvironmentId===id;
      const result=await api("/api/environment/enabled",{method:"POST",body:{id,enabled}});
      await refresh();
      setMessage(enabled?"Environment switched on.":"Environment switched off. Its configuration is still saved.");
      if(wasActive&&!enabled&&result.activeEnvironmentId!==id)setTimeout(()=>window.location.reload(),120);
    }catch(e){setError(e.message)}finally{setBusy("")}
  }
  // A switch the runtime cannot run in fails with an error status and leaves the active environment as it was, so the message
  // names the environment that was not used.
  async function activate(id){
    setBusy("activate:"+(id||"local"));setMessage("");
    const name=id?(data.profiles.find(profile=>profile.id===id)?.name||"this environment"):"Local machine";
    try{
      const result=await api("/api/environment/activate",{method:"POST",body:{id:id||null}});
      const labels={native:"Trebell Native",codex:"Codex",claude:"Claude Code",opencode:"OpenCode",cursor:"Cursor",grok:"Grok Build",antigravity:"Antigravity"};
      const runtimeName=result.agentRuntimeStatus?.name||labels[result.agentRuntime]||"active agent runtime";
      const ready=result.agentRuntimeReady??result.appServerReady;
      setMessage(ready?`Environment switched for ${runtimeName}. Reconnecting…`:`Environment selected, but ${runtimeName} is not ready.`);
      setTimeout(()=>window.location.reload(),120);
    }catch(e){setError(`Could not use ${name} for agents: ${e.message||String(e)}`)}finally{setBusy("")}
  }
  async function probe(id){
    setBusy("probe:"+id);setMessage("");
    try{const r=await api("/api/environment/probe",{method:"POST",body:{id}});setMessage((r.ok?"Connected":"Probe failed")+" · "+(r.stdout||r.stderr||"").trim(),r.ok?"notice":"error")}
    catch(e){setError(e.message)}finally{setBusy("")}
  }
  return <div className="environments-page">
    <div className="capabilities-toolbar"><div><h2>Environments</h2><p>Run the active coding-agent runtime on this {localPlatformLabel?localPlatformLabel+" ":""}host, inside WSL when available, or on an SSH machine.</p></div><button onClick={()=>refresh({reportErrors:true})} disabled={!!busy}><RefreshCw size={13}/> Refresh</button></div>
    {message.text&&(message.tone==="error"?<div className="inline-error" role="alert">{message.text}</div>:<div className="inline-status" role="status" aria-live="polite">{message.text}</div>)}
    <div className="environment-grid">
      <section className="capability-card">
        <div className="capability-card-head"><span><Laptop2 size={15}/><strong>Configured environments</strong></span><em title={"Local machine and "+data.profiles.length+" saved"}>{data.profiles.length+1}</em></div>
        <div className="environment-list">
          <div><div><strong>Local machine</strong><span>{localPlatformLabel?localPlatformLabel.toUpperCase()+" · ":""}{window.trebellDesktop?"Trebell desktop host":"Trebell host"}</span></div><div>{!data.activeEnvironmentId?<em className="ok">Active</em>:<button onClick={()=>activate(null)} disabled={!!busy}>Use for agent</button>}</div></div>
          {data.profiles.map(profile=>{const enabled=profile.enabled!==false;return <div key={profile.id}><div><strong>{profile.name}</strong><span>{profile.type.toUpperCase()} · {profile.cwd||profile.host||profile.distro||"default"}{profile.themeDirectory?" · themes "+profile.themeDirectory:""}{enabled?"":" · switched off"}</span></div><div>{data.activeEnvironmentId===profile.id?<em className="ok">Agent active</em>:<button onClick={()=>activate(profile.id)} disabled={!!busy||!enabled}>Use for agent</button>}<button onClick={()=>probe(profile.id)} disabled={!!busy||!enabled}>Test</button><button onClick={()=>setEnabled(profile.id,!enabled)} disabled={!!busy}>{enabled?"Switch off":"Switch on"}</button><button className="danger" aria-label={"Remove "+profile.name} onClick={()=>remove(profile)} disabled={!!busy||data.activeEnvironmentId===profile.id}><Trash2 size={12}/></button></div></div>})}</div>
        {!data.profiles.length&&<p>No saved remote environments. The local {localPlatformLabel?localPlatformLabel+" ":""}agent is active by default.</p>}
      </section>
      <section className="capability-card environment-create">
        <div className="capability-card-head"><span><Plus size={15}/><strong>Add environment</strong></span></div>
        <label>Type<select value={draft.type} onChange={e=>setDraft(d=>({...d,type:e.target.value}))}><option value="local">Local</option><option value="wsl" disabled={!data.capabilities?.wsl?.available}>WSL</option><option value="ssh" disabled={!data.capabilities?.ssh?.available}>SSH</option></select></label>
        <label>Name<input value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} placeholder="My environment"/></label>
        <label>Working directory<input value={draft.cwd} onChange={e=>setDraft(d=>({...d,cwd:e.target.value}))} placeholder={draft.type==="wsl"?"/home/me/project":draft.type==="ssh"?"/srv/project":"C:\\code\\project"}/></label>
        <label>Published themes directory<input value={draft.themeDirectory} onChange={e=>setDraft(d=>({...d,themeDirectory:e.target.value}))} placeholder={draft.type==="local"?"Default Trebell themes folder":"Default .trebell/themes"}/></label>
        {draft.type==="wsl"&&<label>Distribution<select value={draft.distro} onChange={e=>setDraft(d=>({...d,distro:e.target.value}))}><option value="">Default WSL distro</option>{(data.capabilities?.wsl?.distros||[]).map(x=><option key={x}>{x}</option>)}</select></label>}
        {draft.type!=="local"&&<label>Codex executable<input value={draft.codexPath} onChange={e=>setDraft(d=>({...d,codexPath:e.target.value}))} placeholder={"Default codex on the host's PATH"}/></label>}
        {draft.type==="ssh"&&<><label>Host<input value={draft.host} onChange={e=>setDraft(d=>({...d,host:e.target.value}))} placeholder="dev.example.com"/></label><div className="environment-two"><label>User<input value={draft.user} onChange={e=>setDraft(d=>({...d,user:e.target.value}))}/></label><label>Port<input type="number" min="1" max="65535" aria-invalid={portInvalid?"true":undefined} value={draft.port} onChange={e=>setDraft(d=>({...d,port:e.target.value}))}/></label></div>{portInvalid&&<p className="environment-field-error" role="alert">Port must be a whole number from 1 to 65535.</p>}<label>Identity file<input value={draft.identityFile} onChange={e=>setDraft(d=>({...d,identityFile:e.target.value}))} placeholder={"C:\\Users\\me\\.ssh\\id_ed25519"}/></label></>}
        <button className="primary" onClick={add} disabled={!!busy||(draft.type==="ssh"&&!draft.host.trim())||portInvalid}><Plus size={13}/> Add environment</button>
      </section>
      <section className="capability-card">
        <div className="capability-card-head"><span><Server size={15}/><strong>Host capabilities</strong></span></div>
        <div className="capability-list">
          <div><div><strong>Local</strong><span>This machine</span></div><em className="ok">Ready</em></div>
          {discovery==="done"?<>
            <div><div><strong>WSL</strong><span>{data.capabilities?.wsl?.distros?.join(", ")||data.capabilities?.wsl?.error||"No distributions detected"}</span></div><em className={data.capabilities?.wsl?.available?"ok":""}>{data.capabilities?.wsl?.available?"Ready":"Unavailable"}</em></div>
            <div><div><strong>SSH</strong><span>{data.capabilities?.ssh?.version||data.capabilities?.ssh?.error||"OpenSSH client"}</span></div><em className={data.capabilities?.ssh?.available?"ok":""}>{data.capabilities?.ssh?.available?"Ready":"Unavailable"}</em></div>
          </>:<>
            <div data-testid="host-discovery-pending"><div><strong>WSL</strong><span>{discovery==="checking"?"Checking for distributions…":"Not checked: host discovery failed"}</span></div><em>{discovery==="checking"?"Checking":"Unknown"}</em></div>
            <div><div><strong>SSH</strong><span>{discovery==="checking"?"Checking for an OpenSSH client…":"Not checked: host discovery failed"}</span></div><em>{discovery==="checking"?"Checking":"Unknown"}</em></div>
          </>}
        </div>
      </section>
    </div>
  </div>;
}
