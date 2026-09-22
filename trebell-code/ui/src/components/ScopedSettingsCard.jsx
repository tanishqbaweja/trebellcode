import React,{useEffect,useMemo,useState} from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api.js";

const INHERIT="__inherit__";
const PERMISSIONS=[["supervised","Supervised"],["edits","Auto-accept edits"],["auto","Auto"],["full","Full access"],["read-only","Read only"]];

export default function ScopedSettingsCard({settings={},models=[],onChanged}){
  const [environmentData,setEnvironmentData]=useState({profiles:[]});
  const [projects,setProjects]=useState([]);
  const [environmentId,setEnvironmentId]=useState(settings.activeEnvironmentId||"local");
  const [projectId,setProjectId]=useState("");
  const [scope,setScope]=useState(null);
  const [message,setMessage]=useState("");
  const [loading,setLoading]=useState(false);
  const envValue=environmentId==="local"?null:environmentId;
  const envProjects=useMemo(()=>projects.filter(project=>(project.environmentId||null)===(envValue||null)),[projects,envValue]);
  const projectScope=Boolean(projectId);

  async function load(){
    const [environments,projectData]=await Promise.all([api("/api/environments"),api("/api/projects")]);
    setEnvironmentData(environments);setProjects(projectData.projects||[]);
  }
  async function loadScope(nextEnvironment=environmentId,nextProject=projectId){
    setLoading(true);setMessage("");
    try{
      const params=new URLSearchParams({environmentId:nextEnvironment==="local"?"":nextEnvironment});
      if(nextProject)params.set("projectId",nextProject);
      setScope(await api("/api/scoped-settings?"+params.toString()));
    }catch(error){setMessage(error.message)}finally{setLoading(false)}
  }
  useEffect(()=>{load().catch(error=>setMessage(error.message))},[]);
  useEffect(()=>{loadScope()},[environmentId,projectId]);
  useEffect(()=>{if(projectId&&!envProjects.some(project=>project.id===projectId))setProjectId("")},[environmentId,projects]);

  function hasOverride(key){return projectScope&&Object.prototype.hasOwnProperty.call(scope?.overrides||{},key)}
  function value(key){return scope?.effective?.[key]}
  async function write(key,next){
    setLoading(true);setMessage("");
    try{
      const body={environmentId:envValue,projectId:projectId||null,patch:{},resetKeys:[]};
      if(projectScope&&next===INHERIT)body.resetKeys=[key];else body.patch[key]=next;
      const result=await api("/api/scoped-settings",{method:"POST",body});setScope(result);await load();onChanged?.(result);
      setMessage(projectScope&&next===INHERIT?"Project now inherits the environment default.":"Scoped default saved.");
    }catch(error){setMessage(error.message)}finally{setLoading(false)}
  }
  function selectValue(key,fallback=""){return projectScope&&!hasOverride(key)?INHERIT:String(value(key)??fallback)}
  async function setCleanupMode(mode){
    if(projectScope&&mode===INHERIT)return write("worktreeCleanup",INHERIT);
    if(mode==="off")return write("worktreeCleanup",{mode:"off"});
    const current=value("worktreeCleanup")?.mode==="custom"?value("worktreeCleanup").rules:{};
    return write("worktreeCleanup",{mode:"custom",rules:{worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged)}});
  }
  async function setCleanupRule(key,next){
    const current=value("worktreeCleanup")?.mode==="custom"?value("worktreeCleanup").rules:{};
    return write("worktreeCleanup",{mode:"custom",rules:{worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged),[key]:next}});
  }
  async function runCleanup(){
    setLoading(true);setMessage("Running cleanup…");
    try{
      const result=await api("/api/worktree/cleanup",{method:"POST",body:{}});
      setMessage(result.removed?"Removed "+result.removed+" safe managed worktree"+(result.removed===1?"":"s")+".":"No managed worktrees were eligible for cleanup.");
    }catch(error){setMessage("Cleanup failed: "+error.message)}finally{setLoading(false)}
  }

  const cleanupMode=projectScope&&!hasOverride("worktreeCleanup")?INHERIT:(value("worktreeCleanup")?.mode||"off");
  const modelValue=selectValue("defaultModel","");
  return <div className="settings-card scoped-settings-card" data-testid="scoped-settings-card">
    <h3>Project defaults</h3>
    <p>Environment defaults apply to new threads. A project can override only execution-scoped settings; providers, themes, keybindings and credentials stay environment-wide.</p>
    <div className="scoped-settings-targets">
      <label>Environment<select value={environmentId} onChange={event=>{setEnvironmentId(event.target.value);setProjectId("")}}><option value="local">Local machine</option>{(environmentData.profiles||[]).map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.type.toUpperCase()}</option>)}</select></label>
      <label>Project<select value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">All projects / environment defaults</option>{envProjects.map(project=><option key={project.id} value={project.id}>{project.name} · {project.path}</option>)}</select></label>
    </div>
    {scope&&<div className="scoped-settings-grid">
      <label>Default model<select value={modelValue} onChange={event=>write("defaultModel",event.target.value===INHERIT?INHERIT:(event.target.value||null))}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.defaultModel||"provider default"}</option>}<option value="">Provider default</option>{value("defaultModel")&&!models.includes(value("defaultModel"))&&<option value={value("defaultModel")}>{value("defaultModel")}</option>}{models.map(id=><option key={id} value={id}>{id.replace(/^freebuff\//,"")}</option>)}</select></label>
      <label>Permissions<select value={selectValue("defaultPermissionMode","supervised")} onChange={event=>write("defaultPermissionMode",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.defaultPermissionMode}</option>}{PERMISSIONS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>Workspace<select value={selectValue("defaultWorkspaceMode","current")} onChange={event=>write("defaultWorkspaceMode",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.defaultWorkspaceMode}</option>}<option value="current">Current checkout</option><option value="worktree">New worktree</option></select></label>
      <label>Worktree submodules<select value={selectValue("worktreeSubmodules","recursive")} onChange={event=>write("worktreeSubmodules",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.worktreeSubmodules}</option>}<option value="recursive">Recursive</option><option value="top-level">Top level only</option><option value="none">Skip</option></select></label>
      <label>Automatic pull<select value={projectScope&&!hasOverride("autoPull")?INHERIT:String(Boolean(value("autoPull")))} onChange={event=>write("autoPull",event.target.value===INHERIT?INHERIT:event.target.value==="true")}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.autoPull?"On":"Off"}</option>}<option value="false">Off</option><option value="true">On</option></select></label>
      <label>Simulator tools<select value={projectScope&&!hasOverride("agentDeviceAccess")?INHERIT:String(Boolean(value("agentDeviceAccess")))} onChange={event=>write("agentDeviceAccess",event.target.value===INHERIT?INHERIT:event.target.value==="true")}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.agentDeviceAccess?"Allowed":"Blocked"}</option>}<option value="false">Blocked</option><option value="true">Allowed</option></select></label>
    </div>}
    {scope&&<div className="project-cleanup scoped-cleanup"><label>Automatic worktree cleanup<select value={cleanupMode} onChange={event=>setCleanupMode(event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.worktreeCleanup?.mode||"off"}</option>}<option value="off">Off</option><option value="custom">Custom</option></select></label>{cleanupMode==="custom"&&<div className="cleanup-rule-grid"><label>After inactive days<input type="number" min="1" max="3650" value={value("worktreeCleanup")?.rules?.worktreeAfterDays??""} placeholder="Never" onChange={event=>setCleanupRule("worktreeAfterDays",event.target.value?Number(event.target.value):null)}/></label><label className="toggle-line"><input type="checkbox" checked={Boolean(value("worktreeCleanup")?.rules?.worktreeOnMerge)} onChange={event=>setCleanupRule("worktreeOnMerge",event.target.checked)}/> After merge</label><label className="toggle-line"><input type="checkbox" checked={Boolean(value("worktreeCleanup")?.rules?.worktreeOnDelete)} onChange={event=>setCleanupRule("worktreeOnDelete",event.target.checked)}/> After last thread deletion</label><label className="toggle-line"><input type="checkbox" checked={Boolean(value("worktreeCleanup")?.rules?.worktreeUnchanged)} onChange={event=>setCleanupRule("worktreeUnchanged",event.target.checked)}/> If unchanged</label></div>}</div>}
    <div className="provider-key-actions"><button onClick={()=>loadScope()} disabled={loading}><RefreshCw size={12}/> Refresh</button><button onClick={runCleanup} disabled={loading}>Run safe cleanup now</button></div>
    {message&&<p className={/failed|error/i.test(message)?"provider-status-error":"provider-note"}>{message}</p>}
  </div>;
}
