import React,{useEffect,useMemo,useState} from "react";
import { Check, Download, ExternalLink, FolderCode, GitBranch, ImagePlus, Layers3, Pencil, Play, Plus, RefreshCw, Settings2, SquareTerminal, Trash2, X } from "lucide-react";
import { api } from "../api.js";

function blankScript(){
  return {id:null,name:"",command:"",previewUrl:"",autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false};
}

const ICON_COLORS=["#7c5cff","#4f8cff","#2fa57d","#c57b32","#c45a7a","#6d7f93"];
function autoMonogram(name="Project"){
  const words=String(name).trim().split(/\s+/).filter(Boolean);
  const first=words[0]||"PR";if(/^[A-Za-z]\d/.test(first))return first.slice(0,2).toUpperCase();
  if(words.length>1)return (words[0][0]+words[1][0]).toUpperCase();
  const word=first;
  return (word[0]+(word[word.length-1]||word[0])).toUpperCase();
}
function autoColor(name="Project"){
  let hash=0;for(const ch of String(name))hash=(hash*31+ch.charCodeAt(0))>>>0;return ICON_COLORS[hash%ICON_COLORS.length];
}
function ProjectIcon({project}){
  const icon=project.icon;
  if(icon?.kind==="image")return <span className="project-icon project-icon-image"><img src={icon.value} alt=""/></span>;
  if(icon?.kind==="emoji")return <span className="project-icon project-icon-emoji" style={{background:icon.color||autoColor(project.name)}}>{icon.value}</span>;
  const text=icon?.kind==="monogram"?icon.value:autoMonogram(project.name);
  return <span className="project-icon project-icon-monogram" style={{background:icon?.color||autoColor(project.name)}}>{text}</span>;
}

export default function ProjectsPage({currentPath,onOpen,onRunScript,onOpenPreview,onProjectUpdated,models=[]}){
  const [projects,setProjects]=useState([]);
  const [cloneUrl,setCloneUrl]=useState("");
  const [busy,setBusy]=useState(false);
  const [editor,setEditor]=useState(null);
  const [error,setError]=useState("");
  const [suggestionsOpen,setSuggestionsOpen]=useState({});
  const [identityOpen,setIdentityOpen]=useState({});
  const [iconDraft,setIconDraft]=useState({});

  async function refresh(){
    const d=await api("/api/projects").catch(()=>({projects:[]}));
    const enriched=await Promise.all((d.projects||[]).map(async project=>{
      const [git,suggested]=await Promise.all([
        api("/api/git/info?path="+encodeURIComponent(project.path)).catch(()=>null),
        api("/api/project-actions/suggestions?path="+encodeURIComponent(project.path)).catch(()=>({scripts:[],t3:{present:false},packageManager:null})),
      ]);
      const remote=git?.remotes?.find(r=>r.kind==="fetch")?.url||null;
      return {...project,scripts:Array.isArray(project.scripts)?project.scripts:[],git,remote,suggested};
    }));
    setProjects(enriched);
  }
  useEffect(()=>{refresh()},[]);

  async function saveProject(project,patch){
    setError("");
    try{
      const result=await api("/api/projects",{method:"POST",body:{path:project.path,...patch}});
      onProjectUpdated?.(result.project);
      await refresh();
    }catch(err){setError(err.message||String(err));throw err}
  }
  async function openProject(project){
    if(project.managedWorktree?.cleanedAt){
      setBusy(true);setError("");
      try{await api("/api/worktree/ensure",{method:"POST",body:{path:project.path}});await refresh()}
      catch(err){setError("Could not restore managed worktree: "+(err.message||String(err)));return}
      finally{setBusy(false)}
    }
    onOpen(project.path);
  }
  function cleanupValue(project){return project.worktreeCleanup||null}
  async function setCleanupMode(project,mode){
    if(mode==="inherit")return saveProject(project,{worktreeCleanup:null});
    if(mode==="off")return saveProject(project,{worktreeCleanup:{mode:"off"}});
    const current=cleanupValue(project)?.mode==="custom"?cleanupValue(project).rules:{};
    return saveProject(project,{worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged)}}});
  }
  async function setCleanupRule(project,key,value){
    const current=cleanupValue(project)?.mode==="custom"?cleanupValue(project).rules:{};
    return saveProject(project,{worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged),[key]:value}}});
  }

  async function addLocal(){
    const path=await window.trebellDesktop?.pickDirectory?.();
    if(!path)return;
    await api("/api/projects",{method:"POST",body:{path}});
    await refresh();
    onOpen(path);
  }

  async function clone(){
    if(!cloneUrl.trim())return;
    const parent=await window.trebellDesktop?.pickDirectory?.();
    if(!parent)return;
    const name=cloneUrl.replace(/\/+$/,"").split("/").pop().replace(/\.git$/,"")||"repository";
    const sep=parent.includes("\\")?"\\":"/";
    const destination=parent.replace(/[\\\/]$/,"")+sep+name;
    setBusy(true);setError("");
    try{
      await api("/api/git/action",{method:"POST",body:{action:"clone",url:cloneUrl.trim(),destination}});
      await refresh();
      onOpen(destination);
      setCloneUrl("");
    } catch(err){setError(err.message||String(err))}
    finally { setBusy(false); }
  }

  function editScript(project,script=null){
    const value=script||blankScript();
    setEditor({
      projectId:project.id,
      id:value.id||null,
      name:value.name||"",
      command:value.command||"",
      previewUrl:value.previewUrl||"",
      autoOpenPreview:Boolean(value.autoOpenPreview),
      runOnWorktreeCreate:Boolean(value.runOnWorktreeCreate),
      waitForSetup:Boolean(value.waitForSetup),
    });
  }

  async function submitScript(project){
    if(!editor?.command.trim())return;
    const item={
      id:editor.id||crypto.randomUUID(),
      name:editor.name.trim()||"Project action",
      command:editor.command.trim(),
      previewUrl:editor.previewUrl.trim()||null,
      autoOpenPreview:Boolean(editor.autoOpenPreview),
      runOnWorktreeCreate:Boolean(editor.runOnWorktreeCreate),
      waitForSetup:Boolean(editor.runOnWorktreeCreate&&editor.waitForSetup),
    };
    const scripts=editor.id
      ? project.scripts.map(script=>script.id===editor.id?item:script)
      : [...project.scripts,item];
    await saveProject(project,{scripts,preferredScriptId:project.preferredScriptId||item.id});
    setEditor(null);
  }

  async function deleteScript(project,id){
    const scripts=project.scripts.filter(script=>script.id!==id);
    await saveProject(project,{scripts,preferredScriptId:project.preferredScriptId===id?(scripts[0]?.id||null):project.preferredScriptId});
    if(editor?.projectId===project.id&&editor?.id===id)setEditor(null);
  }

  async function runScript(project,script){
    setBusy(true);setError("");
    try{
      const result=await api("/api/project-script/run",{method:"POST",body:{path:project.path,scriptId:script.id}});
      onRunScript?.(result);
      if(script.previewUrl&&script.autoOpenPreview)onOpenPreview?.(script.previewUrl);
    }catch(err){setError(err.message||String(err))}
    finally{setBusy(false)}
  }

  function importableScripts(project){
    const existingCommands=new Set(project.scripts.map(script=>script.command));
    const existingNames=new Set(project.scripts.map(script=>script.name.toLowerCase()));
    return (project.suggested?.scripts||[]).filter(script=>!existingCommands.has(script.command)&&!existingNames.has(String(script.name||"").toLowerCase()));
  }

  async function importScript(project,suggestion){
    const item={
      id:crypto.randomUUID(),
      name:suggestion.name,
      command:suggestion.command,
      previewUrl:suggestion.previewUrl||null,
      autoOpenPreview:Boolean(suggestion.autoOpenPreview),
      runOnWorktreeCreate:Boolean(suggestion.runOnWorktreeCreate),
      waitForSetup:Boolean(suggestion.waitForSetup),
    };
    await saveProject(project,{scripts:[...project.scripts,item],preferredScriptId:project.preferredScriptId||item.id});
  }

  async function importAll(project){
    const items=importableScripts(project).map(suggestion=>({
      id:crypto.randomUUID(),
      name:suggestion.name,
      command:suggestion.command,
      previewUrl:suggestion.previewUrl||null,
      autoOpenPreview:Boolean(suggestion.autoOpenPreview),
      runOnWorktreeCreate:Boolean(suggestion.runOnWorktreeCreate),
      waitForSetup:Boolean(suggestion.waitForSetup),
    })).slice(0,Math.max(0,30-project.scripts.length));
    if(!items.length)return;
    await saveProject(project,{scripts:[...project.scripts,...items],preferredScriptId:project.preferredScriptId||items[0].id});
  }

  async function importProjectImage(project,file){
    if(!file)return;if(file.size>1_400_000){setError("Project icon images must be under 1.4 MB.");return}
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||""));reader.onerror=()=>reject(reader.error||new Error("Could not read image"));reader.readAsDataURL(file)});
    await saveProject(project,{icon:{kind:"image",value:dataUrl,color:autoColor(project.name)}});
  }

  const groups=useMemo(()=>{
    const map=new Map();
    for(const project of projects){
      const key=project.remote||project.path;
      if(!map.has(key)) map.set(key,{key,label:project.remote||project.name,projects:[]});
      map.get(key).projects.push(project);
    }
    return [...map.values()];
  },[projects]);

  return <div className="projects-page">
    <div className="page-actions"><button onClick={addLocal}><Plus size={14}/> Add local project</button><button onClick={refresh}><RefreshCw size={14}/></button></div>
    {error&&<p className="provider-status-error">{error}</p>}
    <div className="clone-card"><GitBranch size={20}/><div><strong>Clone repository</strong><span>HTTPS or SSH Git URL</span></div><input value={cloneUrl} onChange={e=>setCloneUrl(e.target.value)} placeholder="https://github.com/owner/repo.git"/><button onClick={clone} disabled={busy||!cloneUrl.trim()}>{busy?"Working…":"Clone"}</button></div>
    <div className="project-groups">{groups.map(group=><section className="project-group" key={group.key}>
      <div className="project-group-head"><Layers3 size={14}/><div><strong>{group.label}</strong><span>{group.projects.length} checkout{group.projects.length===1?"":"s"}</span></div></div>
      <div className="project-grid">{group.projects.map(p=><div className={p.path===currentPath?"project-card active":"project-card"} key={p.id}>
        <button className="project-open" onClick={()=>openProject(p)}><ProjectIcon project={p}/><div><strong>{p.name}</strong><span>{p.path}</span><small>{p.managedWorktree?.cleanedAt?"managed worktree cleaned · click to restore":(p.git?.branch||"not a Git checkout")+" · "+new Date(p.lastOpenedAt).toLocaleString()}</small></div></button>
        <button className="project-remove" onClick={async()=>{await api("/api/projects?id="+encodeURIComponent(p.id),{method:"DELETE"});refresh()}}><Trash2 size={13}/></button>
        <div className="project-overrides">
          <label>Model<select value={p.defaultModel||""} onChange={e=>saveProject(p,{defaultModel:e.target.value||null})}><option value="">Inherit client default</option>{models.map(id=><option key={id} value={id}>{id.replace(/^freebuff\//,"")}</option>)}</select></label>
          <label>Permissions<select value={p.permissionMode||""} onChange={e=>saveProject(p,{permissionMode:e.target.value||null})}><option value="">Inherit</option><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></label>
          <label>Workspace<select value={p.workspaceMode||""} onChange={e=>saveProject(p,{workspaceMode:e.target.value||null})}><option value="">Inherit</option><option value="current">Current checkout</option><option value="worktree">New worktree</option></select></label>
          <label>Submodules<select value={p.worktreeSubmodules||""} onChange={e=>saveProject(p,{worktreeSubmodules:e.target.value||null})}><option value="">Inherit</option><option value="recursive">Recursive</option><option value="top-level">Top level only</option><option value="none">Skip</option></select></label>
        </div>
        <div className="project-identity-toggle"><button onClick={()=>setIdentityOpen(current=>({...current,[p.id]:!current[p.id]}))}><Settings2 size={12}/> Project identity</button></div>
        {identityOpen[p.id]&&<div className="project-identity-editor"><label>Name<input defaultValue={p.name} onBlur={e=>{const value=e.target.value.trim();if(value&&value!==p.name)saveProject(p,{name:value})}}/></label><div className="project-icon-actions"><button onClick={()=>saveProject(p,{icon:null})}>Automatic</button><button onClick={()=>setIconDraft(current=>({...current,[p.id]:{kind:"emoji",value:p.icon?.kind==="emoji"?p.icon.value:"🚀",color:p.icon?.color||autoColor(p.name)}}))}>Emoji</button><button onClick={()=>setIconDraft(current=>({...current,[p.id]:{kind:"monogram",value:p.icon?.kind==="monogram"?p.icon.value:autoMonogram(p.name),color:p.icon?.color||autoColor(p.name)}}))}>Monogram</button><label className="project-image-button"><ImagePlus size={12}/> Image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e=>importProjectImage(p,e.target.files?.[0])}/></label></div>{iconDraft[p.id]&&<div className="project-icon-draft"><input maxLength={iconDraft[p.id].kind==="monogram"?2:16} value={iconDraft[p.id].value} onChange={e=>setIconDraft(current=>({...current,[p.id]:{...current[p.id],value:e.target.value}}))}/><input type="color" value={iconDraft[p.id].color||autoColor(p.name)} onChange={e=>setIconDraft(current=>({...current,[p.id]:{...current[p.id],color:e.target.value}}))}/><button onClick={async()=>{await saveProject(p,{icon:iconDraft[p.id]});setIconDraft(current=>({...current,[p.id]:null}))}}>Save icon</button></div>}</div>}
        <div className="project-cleanup"><label>Automatic worktree cleanup<select value={p.worktreeCleanup?.mode||"inherit"} onChange={e=>setCleanupMode(p,e.target.value)}><option value="inherit">Inherit</option><option value="off">Off</option><option value="custom">Custom</option></select></label>{p.worktreeCleanup?.mode==="custom"&&<div className="project-cleanup-rules"><label>After inactive days<input type="number" min="1" max="3650" defaultValue={p.worktreeCleanup.rules?.worktreeAfterDays??""} placeholder="Never" onBlur={e=>setCleanupRule(p,"worktreeAfterDays",e.target.value?Number(e.target.value):null)}/></label><label><input type="checkbox" checked={Boolean(p.worktreeCleanup.rules?.worktreeOnMerge)} onChange={e=>setCleanupRule(p,"worktreeOnMerge",e.target.checked)}/> After merge</label><label><input type="checkbox" checked={Boolean(p.worktreeCleanup.rules?.worktreeOnDelete)} onChange={e=>setCleanupRule(p,"worktreeOnDelete",e.target.checked)}/> After last thread deletion</label><label><input type="checkbox" checked={Boolean(p.worktreeCleanup.rules?.worktreeUnchanged)} onChange={e=>setCleanupRule(p,"worktreeUnchanged",e.target.checked)}/> If unchanged from base</label></div>}</div>

        <div className="project-actions">
          <div className="project-actions-head"><span><SquareTerminal size={13}/> Project actions</span><div>{importableScripts(p).length>0&&<button onClick={()=>setSuggestionsOpen(current=>({...current,[p.id]:!current[p.id]}))}><Download size={12}/> Import {importableScripts(p).length}</button>}<button onClick={()=>editScript(p)}><Plus size={12}/> Add action</button></div></div>
          {p.suggested?.t3?.present&&<div className="project-config-hint"><strong>t3.json detected</strong><span>{[p.suggested.t3.defaultThreadEnvMode&&("workspace "+p.suggested.t3.defaultThreadEnvMode),p.suggested.t3.worktreeSubmodules&&("submodules "+p.suggested.t3.worktreeSubmodules)].filter(Boolean).join(" · ")||"Shared project actions available"}</span>{p.suggested.t3.defaultThreadEnvMode&&p.workspaceMode!==p.suggested.t3.defaultThreadEnvMode&&<button onClick={()=>saveProject(p,{workspaceMode:p.suggested.t3.defaultThreadEnvMode})}>Use workspace</button>}{p.suggested.t3.worktreeSubmodules&&p.worktreeSubmodules!==p.suggested.t3.worktreeSubmodules&&<button onClick={()=>saveProject(p,{worktreeSubmodules:p.suggested.t3.worktreeSubmodules})}>Use submodules</button>}</div>}
          {suggestionsOpen[p.id]&&importableScripts(p).length>0&&<div className="project-import-list">
            <div className="project-import-head"><span>Discovered actions</span><button onClick={()=>importAll(p)}>Import all</button></div>
            {importableScripts(p).map(script=><div key={script.source+":"+script.id}><span><strong>{script.name}</strong><small>{script.command}</small></span><em>{script.source}</em><button onClick={()=>importScript(p,script)}><Download size={11}/> Import</button></div>)}
          </div>}
          {p.scripts.length?<div className="project-action-list">{p.scripts.map(script=><div className="project-action-row" key={script.id}>
            <button className="project-action-run" disabled={busy} onClick={()=>runScript(p,script)}><Play size={12}/><span><strong>{script.name}</strong><small>{script.command}</small></span>{script.runOnWorktreeCreate&&<em>setup</em>}</button>
            {script.previewUrl&&<button title="Open preview" onClick={()=>onOpenPreview?.(script.previewUrl)}><ExternalLink size={12}/></button>}
            <button title="Edit action" onClick={()=>editScript(p,script)}><Pencil size={12}/></button>
            <button className="danger" title="Delete action" onClick={()=>deleteScript(p,script.id)}><Trash2 size={12}/></button>
          </div>)}</div>:<p className="project-actions-empty">Save repeatable commands here—dev server, tests, setup, migrations, whatever you run constantly.</p>}
          {editor?.projectId===p.id&&<div className="project-action-editor">
            <input value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})} placeholder="Action name (e.g. Dev server)"/>
            <input value={editor.command} onChange={e=>setEditor({...editor,command:e.target.value})} placeholder="Command (e.g. npm run dev)"/>
            <input value={editor.previewUrl} onChange={e=>setEditor({...editor,previewUrl:e.target.value})} placeholder="Optional preview URL (e.g. http://localhost:5173)"/>
            <label><input type="checkbox" checked={editor.runOnWorktreeCreate} onChange={e=>setEditor({...editor,runOnWorktreeCreate:e.target.checked})}/> Run automatically when Trebell creates a worktree</label>
            <label><input type="checkbox" checked={editor.waitForSetup} disabled={!editor.runOnWorktreeCreate} onChange={e=>setEditor({...editor,waitForSetup:e.target.checked})}/> Wait for setup to finish before starting the agent</label>
            <label><input type="checkbox" checked={editor.autoOpenPreview} disabled={!editor.previewUrl.trim()} onChange={e=>setEditor({...editor,autoOpenPreview:e.target.checked})}/> Open preview when this action runs</label>
            <div><button className="primary" disabled={!editor.command.trim()} onClick={()=>submitScript(p)}><Check size={12}/> Save action</button><button onClick={()=>setEditor(null)}><X size={12}/> Cancel</button></div>
          </div>}
        </div>
      </div>)}</div>
    </section>)}</div>
  </div>;
}
