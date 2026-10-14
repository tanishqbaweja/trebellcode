import React,{useEffect,useMemo,useState} from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api.js";

const INHERIT="__inherit__";
const PERMISSIONS=[["supervised","Supervised"],["edits","Auto-accept edits"],["auto","Auto"],["full","Full access"],["read-only","Read only"]];
// Options of the scoped selects. The Inherit option reuses these labels, so it names the inherited value the way the select does ("Inherit · Current checkout", not "Inherit · current").
const OPTIONS={
  defaultPermissionMode:PERMISSIONS,
  defaultWorkspaceMode:[["current","Current checkout"],["worktree","New worktree"]],
  worktreeSubmodules:[["recursive","Recursive"],["top-level","Top level only"],["none","Skip"]],
  sourceControlMergeMethod:[["squash","Squash"],["merge","Merge commit"],["rebase","Rebase merge"]],
  sourceControlTextStyle:[["repository","Repository conventions"],["conventional","Conventional Commits"],["custom","Custom instructions"]],
  worktreeCleanup:[["off","Off"],["custom","Custom"]],
};
function optionLabel(key,id){return OPTIONS[key].find(([value])=>value===id)?.[1]||id}
function optionList(key){return OPTIONS[key].map(([id,label])=><option key={id} value={id}>{label}</option>)}
// Same normalization the server applies (whole days, 1-3650, anything else means "Never"), so the field shows what was saved.
function cleanupDays(value){const text=String(value??"").trim();if(!text)return null;const days=Math.trunc(Number(text));return Number.isFinite(days)&&days>=1?Math.min(3650,days):null}

export default function ScopedSettingsCard({settings={},models=[],onChanged,scopeEnvironmentId=null,scopeProjectId=null,onScopeChange,onCatalog,showScopeTargets=true}){
  const [environmentData,setEnvironmentData]=useState({profiles:[]});
  const [projects,setProjects]=useState([]);
  const [internalEnvironmentId,setInternalEnvironmentId]=useState(settings.activeEnvironmentId||"local");
  const [internalProjectId,setInternalProjectId]=useState("");
  const controlledScope=scopeEnvironmentId!=null;
  const environmentId=controlledScope?scopeEnvironmentId:internalEnvironmentId;
  const projectId=controlledScope?(scopeProjectId||""):internalProjectId;
  const [scope,setScope]=useState(null);
  // Failures are flagged where they are caught: server errors such as "Unknown project" do not always contain the word "error".
  const [message,setMessageState]=useState({text:"",error:false});
  function setMessage(text,error=false){setMessageState({text,error})}
  const [loading,setLoading]=useState(false);
  const writeQueueRef=React.useRef(Promise.resolve());
  const selectionRef=React.useRef({environmentId:"local",projectId:""});
  const envValue=environmentId==="local"?null:environmentId;
  selectionRef.current={environmentId,projectId};
  const envProjects=useMemo(()=>projects.filter(project=>(project.environmentId||null)===(envValue||null)),[projects,envValue]);
  const projectScope=Boolean(projectId);

  async function load(){
    const [environments,projectData]=await Promise.all([api("/api/environments"),api("/api/projects")]);
    const nextProjects=projectData.projects||[];
    setEnvironmentData(environments);setProjects(nextProjects);onCatalog?.({environmentData:environments,projects:nextProjects});
  }
  async function loadScope(nextEnvironment=environmentId,nextProject=projectId){
    setLoading(true);setMessage("");
    try{
      const params=new URLSearchParams({environmentId:nextEnvironment==="local"?"":nextEnvironment});
      if(nextProject)params.set("projectId",nextProject);
      setScope(await api("/api/scoped-settings?"+params.toString()));
    }catch(error){setMessage(error.message,true)}finally{setLoading(false)}
  }
  useEffect(()=>{load().catch(error=>setMessage(error.message,true))},[]);
  useEffect(()=>{loadScope()},[environmentId,projectId]);
  useEffect(()=>{
    if(!projectId||envProjects.some(project=>project.id===projectId))return;
    if(controlledScope)onScopeChange?.({environmentId,projectId:""});
    else setInternalProjectId("");
  },[environmentId,projectId,projects,controlledScope,onScopeChange]);

  function changeEnvironment(next){
    if(controlledScope)onScopeChange?.({environmentId:next,projectId:""});
    else{setInternalEnvironmentId(next);setInternalProjectId("")}
  }
  function changeProject(next){
    if(controlledScope)onScopeChange?.({environmentId,projectId:next});
    else setInternalProjectId(next);
  }

  function hasOverride(key){return projectScope&&Object.prototype.hasOwnProperty.call(scope?.overrides||{},key)}
  function value(key){return scope?.effective?.[key]}
  function write(key,next){
    const targetEnvironmentId=envValue,targetProjectId=projectId||null,targetProjectScope=projectScope;
    const body={environmentId:targetEnvironmentId,projectId:targetProjectId,patch:{},resetKeys:[]};
    if(targetProjectScope&&next===INHERIT)body.resetKeys=[key];else body.patch[key]=next;
    setLoading(true);setMessage("");
    const operation=writeQueueRef.current.catch(()=>{}).then(async()=>{
      const result=await api("/api/scoped-settings",{method:"POST",body});
      const current=selectionRef.current;
      const stillCurrent=(current.environmentId==="local"?null:current.environmentId)===targetEnvironmentId&&(current.projectId||null)===targetProjectId;
      if(stillCurrent)setScope(result);
      if(Array.isArray(result.projects)){
        setProjects(result.projects);
        onCatalog?.({environmentData,projects:result.projects});
      }else await load();
      onChanged?.(result);
      if(stillCurrent)setMessage(targetProjectScope&&next===INHERIT?"Project now inherits the environment default.":"Scoped default saved.");
      return result;
    });
    writeQueueRef.current=operation;
    operation.catch(error=>setMessage(error.message,true)).finally(()=>{if(writeQueueRef.current===operation)setLoading(false)});
    return operation;
  }
  function selectValue(key,fallback=""){return projectScope&&!hasOverride(key)?INHERIT:String(value(key)??fallback)}
  async function setCleanupMode(mode){
    if(projectScope&&mode===INHERIT)return write("worktreeCleanup",INHERIT);
    if(mode==="off")return write("worktreeCleanup",{mode:"off"});
    const current=value("worktreeCleanup")?.mode==="custom"?value("worktreeCleanup").rules:{};
    return write("worktreeCleanup",{mode:"custom",rules:{worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged)}});
  }
  // A rule starts from the rules still on their way for this scope, so a toggle clicked as the days field is left keeps the days
  // instead of sending the saved ones back over them.
  const sentRulesRef=React.useRef(null);
  async function setCleanupRule(key,next){
    const target=projectId||environmentId,sent=sentRulesRef.current?.target===target?sentRulesRef.current.rules:null;
    const current=sent||(value("worktreeCleanup")?.mode==="custom"?value("worktreeCleanup").rules:{});
    const rules={worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged),[key]:next};
    const mark={target,rules};sentRulesRef.current=mark;
    return write("worktreeCleanup",{mode:"custom",rules}).finally(()=>{if(sentRulesRef.current===mark)sentRulesRef.current=null});
  }
  // The days field is typed in freely and saved once it is left, as the Projects card's own field is: a save on every keystroke came
  // back while the person was still typing and put an earlier keystroke's value in the field (365 was saved as 35). A failed save
  // puts the saved value back. A saved value that changes while the field is not being typed in (a Refresh) is shown in it; one
  // that lands while the person is back in the field leaves what they type, and the keyboard, alone.
  const savedCleanupDays=value("worktreeCleanup")?.rules?.worktreeAfterDays??null,cleanupDaysRef=React.useRef(null);
  useEffect(()=>{const input=cleanupDaysRef.current;if(input&&document.activeElement!==input)input.value=savedCleanupDays??""},[savedCleanupDays]);
  function saveCleanupDays(input){
    const days=cleanupDays(input.value);input.value=days??"";
    if(days!==savedCleanupDays)setCleanupRule("worktreeAfterDays",days).catch(()=>{input.value=savedCleanupDays??""});
  }
  async function runCleanup(){
    setLoading(true);setMessage("Running cleanup…");
    try{
      const result=await api("/api/worktree/cleanup",{method:"POST",body:{}});
      setMessage(result.removed?"Removed "+result.removed+" safe managed worktree"+(result.removed===1?"":"s")+".":"No managed worktrees were eligible for cleanup.");
    }catch(error){setMessage("Cleanup failed: "+error.message,true)}finally{setLoading(false)}
  }

  const cleanupMode=projectScope&&!hasOverride("worktreeCleanup")?INHERIT:(value("worktreeCleanup")?.mode||"off");
  const modelValue=selectValue("defaultModel","");
  const sourceTextModelValue=selectValue("sourceControlTextModel","");
  return <div className="settings-card scoped-settings-card" data-testid="scoped-settings-card" aria-busy={loading?"true":"false"}>
    <h3>Project defaults</h3>
    <p>Environment defaults apply to new threads. A project can override only execution-scoped settings; providers, themes, keybindings and credentials stay environment-wide.</p>
    {showScopeTargets&&<div className="scoped-settings-targets">
      <label>Environment<select value={environmentId} onChange={event=>changeEnvironment(event.target.value)}><option value="local">Local machine</option>{(environmentData.profiles||[]).map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.type.toUpperCase()}</option>)}</select></label>
      <label>Project<select value={projectId} onChange={event=>changeProject(event.target.value)}><option value="">All projects / environment defaults</option>{envProjects.map(project=><option key={project.id} value={project.id}>{project.name} · {project.path}</option>)}</select></label>
    </div>}
    {scope&&<div className="scoped-settings-grid">
      <label>Default model<select value={modelValue} onChange={event=>write("defaultModel",event.target.value===INHERIT?INHERIT:(event.target.value||null))}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.defaultModel||"Provider default"}</option>}<option value="">Provider default</option>{value("defaultModel")&&!models.includes(value("defaultModel"))&&<option value={value("defaultModel")}>{value("defaultModel")}</option>}{models.map(id=><option key={id} value={id}>{id}</option>)}</select></label>
      <label>Permissions<select value={selectValue("defaultPermissionMode","supervised")} onChange={event=>write("defaultPermissionMode",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {optionLabel("defaultPermissionMode",scope.defaults.defaultPermissionMode)}</option>}{optionList("defaultPermissionMode")}</select></label>
      <label>Workspace<select value={selectValue("defaultWorkspaceMode","current")} onChange={event=>write("defaultWorkspaceMode",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {optionLabel("defaultWorkspaceMode",scope.defaults.defaultWorkspaceMode)}</option>}{optionList("defaultWorkspaceMode")}</select></label>
      <label>Worktree submodules<select value={selectValue("worktreeSubmodules","recursive")} onChange={event=>write("worktreeSubmodules",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {optionLabel("worktreeSubmodules",scope.defaults.worktreeSubmodules)}</option>}{optionList("worktreeSubmodules")}</select></label>
      <label>Automatic pull<select value={projectScope&&!hasOverride("autoPull")?INHERIT:String(Boolean(value("autoPull")))} onChange={event=>write("autoPull",event.target.value===INHERIT?INHERIT:event.target.value==="true")}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.autoPull?"On":"Off"}</option>}<option value="false">Off</option><option value="true">On</option></select></label>
      <label>Default PR merge<select value={selectValue("sourceControlMergeMethod","squash")} onChange={event=>write("sourceControlMergeMethod",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {optionLabel("sourceControlMergeMethod",scope.defaults.sourceControlMergeMethod)}</option>}{optionList("sourceControlMergeMethod")}</select></label>
      <label>Git text style<select value={selectValue("sourceControlTextStyle","repository")} onChange={event=>write("sourceControlTextStyle",event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {optionLabel("sourceControlTextStyle",scope.defaults.sourceControlTextStyle)}</option>}{optionList("sourceControlTextStyle")}</select></label>
      <label>Git text model<select value={sourceTextModelValue} onChange={event=>write("sourceControlTextModel",event.target.value===INHERIT?INHERIT:(event.target.value||null))}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.sourceControlTextModel||"Current model"}</option>}<option value="">Current model</option>{value("sourceControlTextModel")&&!models.includes(value("sourceControlTextModel"))&&<option value={value("sourceControlTextModel")}>{value("sourceControlTextModel")}</option>}{models.map(id=><option key={id} value={id}>{id}</option>)}</select></label>
      <label>Follow PR templates<select value={projectScope&&!hasOverride("sourceControlFollowTemplates")?INHERIT:String(Boolean(value("sourceControlFollowTemplates")))} onChange={event=>write("sourceControlFollowTemplates",event.target.value===INHERIT?INHERIT:event.target.value==="true")}>{projectScope&&<option value={INHERIT}>Inherit · {scope.defaults.sourceControlFollowTemplates?"On":"Off"}</option>}<option value="true">On</option><option value="false">Off</option></select></label>
      {value("sourceControlTextStyle")==="custom"&&<label className="scoped-settings-wide">Custom Git instructions<textarea key={(projectId||environmentId)+":"+(hasOverride("sourceControlCustomInstructions")?"override":"default")} defaultValue={value("sourceControlCustomInstructions")||""} placeholder="Keep titles concise. Use short bullet points in descriptions." onBlur={event=>write("sourceControlCustomInstructions",event.target.value)}/>{projectScope&&hasOverride("sourceControlCustomInstructions")&&<button type="button" onClick={()=>write("sourceControlCustomInstructions",INHERIT)}>Use inherited instructions</button>}</label>}
    </div>}
    {scope&&<div className="project-cleanup scoped-cleanup"><label>Automatic worktree cleanup<select value={cleanupMode} onChange={event=>setCleanupMode(event.target.value)}>{projectScope&&<option value={INHERIT}>Inherit · {optionLabel("worktreeCleanup",scope.defaults.worktreeCleanup?.mode||"off")}</option>}{optionList("worktreeCleanup")}</select></label>{cleanupMode==="custom"&&<div className="cleanup-rule-grid"><label>After inactive days<input ref={cleanupDaysRef} key={projectId||environmentId} type="number" min="1" max="3650" defaultValue={savedCleanupDays??""} placeholder="Never" onBlur={event=>saveCleanupDays(event.target)}/></label><label className="toggle-line"><input type="checkbox" checked={Boolean(value("worktreeCleanup")?.rules?.worktreeOnMerge)} onChange={event=>setCleanupRule("worktreeOnMerge",event.target.checked)}/> After merge</label><label className="toggle-line"><input type="checkbox" checked={Boolean(value("worktreeCleanup")?.rules?.worktreeOnDelete)} onChange={event=>setCleanupRule("worktreeOnDelete",event.target.checked)}/> After last thread deletion</label><label className="toggle-line"><input type="checkbox" checked={Boolean(value("worktreeCleanup")?.rules?.worktreeUnchanged)} onChange={event=>setCleanupRule("worktreeUnchanged",event.target.checked)}/> If unchanged</label></div>}</div>}
    <div className="provider-key-actions"><button onClick={()=>loadScope()} disabled={loading}><RefreshCw size={12}/> Refresh</button><button onClick={runCleanup} disabled={loading}>Clean up worktrees now</button></div>
    {message.text&&<p className={message.error?"provider-status-error":"provider-note"}>{message.text}</p>}
  </div>;
}
