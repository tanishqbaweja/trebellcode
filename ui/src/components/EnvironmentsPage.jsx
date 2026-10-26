import React,{useEffect,useLayoutEffect,useRef,useState} from "react";
import { Laptop2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { ignorePressRest } from "./ThreadSidebar.jsx";

// The Environments page on screen, if any. An Undo outlives the page that offered it (its toast stays while the person moves
// on, or leaves and comes back), so a restore reports to the page that shows now, or throws for the app's error toast.
let environmentsOnScreen=null;
// An add outlives the page that sent it too ({draft, name}: the form as it was sent). The page the person comes back to before it
// answers shows that form, is busy with it as the one they left was, and says it is adding it; once it lands the page on screen shows
// what it did. A failure said while no Environments page is on screen waits for the next one, with the form that failed (failureLeft).
let adding=null,failureLeft=null;
const BLANK_DRAFT={type:"local",name:"",cwd:"",distro:"",host:"",user:"",port:22,identityFile:"",codexPath:"",themeDirectory:""};
const addingMessage=name=>({text:`Adding “${name}”…`,tone:"notice",adding:true});
// A press runs one of the page's buttons once, as a thread's menu item runs: the rest of it (the repeats of Enter held, the second
// click of a double click) does nothing. The keyboard goes back to the button pressed once its action is done, so the repeats landed
// on it again: Switch off held saved again and again, switching the environment off and on with each save.
function pressOnce(event){if(event.target.closest("button"))ignorePressRest(!event.detail)}

export default function EnvironmentsPage({onOfferUndo}={}){
  const [data,setData]=useState({profiles:[],activeEnvironmentId:null,activeEnvironment:null,capabilities:{local:{available:true},ssh:{available:false},wsl:{available:false,distros:[]}}});
  const [startedWith]=useState(()=>adding);
  const [draft,setDraft]=useState(()=>adding?.draft||BLANK_DRAFT);
  // Every button is disabled while an action runs, which drops the keyboard on the page body; once the page is idle again it goes
  // back to the button that started the action, if that is still there (a removed environment's row is not).
  const [busy,setBusyState]=useState(()=>adding?"add":"");
  const busyFocusRef=useRef(null);
  const setBusy=value=>{if(value&&!busyFocusRef.current)busyFocusRef.current=document.activeElement;setBusyState(value)};
  useEffect(()=>{if(busy)return;const button=busyFocusRef.current;busyFocusRef.current=null;if(button&&button!==document.body&&button.isConnected&&!button.disabled&&document.activeElement===document.body)button.focus()},[busy]);
  // A notice reports what an action did; an error says what failed and is styled as one. An add on its way says so (adding).
  const [message,setMessageState]=useState(()=>adding?addingMessage(adding.name):{text:"",tone:"notice"});
  const setMessage=(text,tone="notice")=>setMessageState({text:String(text||""),tone});
  const setError=text=>setMessage(text,"error");
  // Host discovery (ssh -V, wsl --list) can take seconds: until /api/environments first answers, the page says it is checking and
  // loading instead of showing its starting values (no saved environment, Local machine active, no WSL, no SSH, no platform) as
  // results, and after a first read that failed, that they are not checked or loaded.
  const [discovery,setDiscovery]=useState("checking");
  const localPlatformLabel={win32:"Windows",linux:"Linux",darwin:"macOS"}[data.capabilities?.local?.platform]||"";
  // The port is kept as typed so the field can be cleared and retyped; it is sent as a number.
  // A TCP port is a whole number from 1 to 65535; anything else would be saved and only fail at connect time.
  const portNumber=String(draft.port).trim()===""?NaN:Number(draft.port);
  const portInvalid=draft.type==="ssh"&&!(Number.isInteger(portNumber)&&portNumber>=1&&portNumber<=65535);
  // An empty Local form would add only a second "Local machine" under the host's own, so Add environment waits for a name, a working
  // directory or a themes directory. The form starts over after an add, so a press after it (Enter twice or held) adds nothing.
  const emptyLocal=draft.type==="local"&&![draft.name,draft.cwd,draft.themeDirectory].some(value=>value.trim());

  // A read that reports its errors also clears what the page said before (clear), except that an add is on its way. The page's first
  // read keeps what the page starts with: a failure said while no Environments page was on screen stays until the next action.
  async function refresh({reportErrors=false,clear=reportErrors}={}){
    try{setData(await api("/api/environments"));setDiscovery("done");if(clear)setMessageState(current=>current.adding?current:{text:"",tone:"notice"});return true}
    catch(error){setDiscovery(state=>state==="done"?"done":"failed");if(reportErrors)setError("Could not refresh environments: "+(error?.message||String(error)));return false}
  }
  useEffect(()=>{refresh({reportErrors:true,clear:false})},[]);

  async function add(){
    const sent=draft,name=draft.name||({local:"Local machine",wsl:"WSL",ssh:"SSH"}[draft.type]);
    setBusy("add");setMessageState(addingMessage(name));
    const record=adding={draft:sent,name};let failure=null;
    try{await api("/api/environments",{method:"POST",body:{...draft,port:Number.isInteger(portNumber)?portNumber:22,name}})}
    catch(e){failure=e.message||String(e)}
    if(adding===record)adding=null;
    const page=environmentsOnScreen?.current;
    if(page)await page.addLanded(record,failure);else if(failure)failureLeft={draft:sent,text:failure};
  }
  // What an add did, on the page on screen: a failure is said, with the form as it is; an add that went through is listed, and the
  // form starts over if it still holds what was sent (one the person changed meanwhile keeps their changes).
  async function addLanded(record,failure){
    if(failure)setError(failure);
    else{
      setDraft(current=>current===record.draft?BLANK_DRAFT:current);setMessageState(current=>current.adding?{text:"",tone:"notice"}:current);
      await refresh();
    }
    setBusy("");
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
  screenRef.current={showError:setError,refresh,addLanded};
  // This is the page on screen from the commit that draws it. An add it started busy with that landed while it was being drawn, and
  // a failure said while no Environments page was on screen, show then.
  useLayoutEffect(()=>{
    const page=screenRef;environmentsOnScreen=page;
    if(failureLeft){const left=failureLeft;failureLeft=null;setDraft(left.draft);setError(left.text);setBusyState("")}
    else if(startedWith&&adding!==startedWith)void addLanded(startedWith,null);
    return()=>{if(environmentsOnScreen===page)environmentsOnScreen=null};
  },[]);
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
  // names the environment that was not used. A host is checked first, which takes seconds when it does not answer (ssh waits 8 s
  // for it), so the page says so right away.
  async function activate(id){
    const name=id?(data.profiles.find(profile=>profile.id===id)?.name||"this environment"):"Local machine";
    setBusy("activate:"+(id||"local"));setMessage(id?`Checking ${name}…`:`Switching to ${name}…`);
    try{
      const result=await api("/api/environment/activate",{method:"POST",body:{id:id||null}});
      const labels={native:"Trebell Native",codex:"Codex",claude:"Claude Code",opencode:"OpenCode",cursor:"Cursor",grok:"Grok Build",antigravity:"Antigravity",muse:"Muse Code"};
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
  return <div className="environments-page" onClick={pressOnce}>
    <div className="capabilities-toolbar"><div><h2>Environments</h2><p>Run the active coding-agent runtime on this {localPlatformLabel?localPlatformLabel+" ":""}host, inside WSL when available, or on an SSH machine.</p></div><button onClick={()=>refresh({reportErrors:true})} disabled={!!busy}><RefreshCw size={13}/> Refresh</button></div>
    {message.text&&(message.tone==="error"?<div className="inline-error" role="alert">{message.text}</div>:<div className="inline-status" role="status" aria-live="polite">{message.text}</div>)}
    <div className="environment-grid">
      <section className="capability-card">
        <div className="capability-card-head"><span><Laptop2 size={15}/><strong>Configured environments</strong></span>{discovery==="done"&&<em title={"Local machine and "+data.profiles.length+" saved"}>{data.profiles.length+1}</em>}</div>
        {discovery!=="done"?<p role="status">{discovery==="checking"?"Loading environments…":"Not loaded: the environments could not be read."}</p>:<><div className="environment-list">
          <div><div><strong>Local machine</strong><span>{localPlatformLabel?localPlatformLabel.toUpperCase()+" · ":""}{window.trebellDesktop?"Trebell desktop host":"Trebell host"}</span></div><div>{!data.activeEnvironmentId?<em className="ok">Active</em>:<button onClick={()=>activate(null)} disabled={!!busy}>Use for agent</button>}</div></div>
          {data.profiles.map(profile=>{const enabled=profile.enabled!==false;return <div key={profile.id}><div><strong>{profile.name}</strong><span>{profile.type.toUpperCase()} · {profile.cwd||profile.host||profile.distro||"default"}{profile.themeDirectory?" · themes "+profile.themeDirectory:""}{enabled?"":" · switched off"}</span></div><div>{data.activeEnvironmentId===profile.id?<em className="ok">Agent active</em>:<button onClick={()=>activate(profile.id)} disabled={!!busy||!enabled}>Use for agent</button>}<button onClick={()=>probe(profile.id)} disabled={!!busy||!enabled}>Test</button><button onClick={()=>setEnabled(profile.id,!enabled)} disabled={!!busy}>{enabled?"Switch off":"Switch on"}</button><button className="danger" aria-label={"Remove "+profile.name} onClick={()=>remove(profile)} disabled={!!busy||data.activeEnvironmentId===profile.id}><Trash2 size={12}/></button></div></div>})}</div>
        {!data.profiles.length&&<p>No saved remote environments. The local {localPlatformLabel?localPlatformLabel+" ":""}agent is active by default.</p>}</>}
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
        <button className="primary" onClick={add} disabled={!!busy||emptyLocal||(draft.type==="ssh"&&!draft.host.trim())||portInvalid}><Plus size={13}/> Add environment</button>
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
