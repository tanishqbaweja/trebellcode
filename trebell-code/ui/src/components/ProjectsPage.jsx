import React,{useEffect,useMemo,useState} from "react";
import { Check, ExternalLink, FolderCode, GitBranch, Layers3, Pencil, Play, Plus, RefreshCw, SquareTerminal, Trash2, X } from "lucide-react";
import { api } from "../api.js";

function blankScript(){
  return {id:null,name:"",command:"",previewUrl:"",autoOpenPreview:false,runOnWorktreeCreate:false};
}

export default function ProjectsPage({currentPath,onOpen,onRunScript,onOpenPreview,onProjectUpdated,models=[]}){
  const [projects,setProjects]=useState([]);
  const [cloneUrl,setCloneUrl]=useState("");
  const [busy,setBusy]=useState(false);
  const [editor,setEditor]=useState(null);
  const [error,setError]=useState("");

  async function refresh(){
    const d=await api("/api/projects").catch(()=>({projects:[]}));
    const enriched=await Promise.all((d.projects||[]).map(async project=>{
      const git=await api("/api/git/info?path="+encodeURIComponent(project.path)).catch(()=>null);
      const remote=git?.remotes?.find(r=>r.kind==="fetch")?.url||null;
      return {...project,scripts:Array.isArray(project.scripts)?project.scripts:[],git,remote};
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
        <button className="project-open" onClick={()=>onOpen(p.path)}><FolderCode size={22}/><div><strong>{p.name}</strong><span>{p.path}</span><small>{p.git?.branch||"not a Git checkout"} · {new Date(p.lastOpenedAt).toLocaleString()}</small></div></button>
        <button className="project-remove" onClick={async()=>{await api("/api/projects?id="+encodeURIComponent(p.id),{method:"DELETE"});refresh()}}><Trash2 size={13}/></button>
        <div className="project-overrides">
          <label>Model<select value={p.defaultModel||""} onChange={e=>saveProject(p,{defaultModel:e.target.value||null})}><option value="">Inherit client default</option>{models.map(id=><option key={id} value={id}>{id.replace(/^freebuff\//,"")}</option>)}</select></label>
          <label>Permissions<select value={p.permissionMode||""} onChange={e=>saveProject(p,{permissionMode:e.target.value||null})}><option value="">Inherit</option><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></label>
          <label>Workspace<select value={p.workspaceMode||""} onChange={e=>saveProject(p,{workspaceMode:e.target.value||null})}><option value="">Inherit</option><option value="current">Current checkout</option><option value="worktree">New worktree</option></select></label>
        </div>

        <div className="project-actions">
          <div className="project-actions-head"><span><SquareTerminal size={13}/> Project actions</span><button onClick={()=>editScript(p)}><Plus size={12}/> Add action</button></div>
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
            <label><input type="checkbox" checked={editor.autoOpenPreview} disabled={!editor.previewUrl.trim()} onChange={e=>setEditor({...editor,autoOpenPreview:e.target.checked})}/> Open preview when this action runs</label>
            <div><button className="primary" disabled={!editor.command.trim()} onClick={()=>submitScript(p)}><Check size={12}/> Save action</button><button onClick={()=>setEditor(null)}><X size={12}/> Cancel</button></div>
          </div>}
        </div>
      </div>)}</div>
    </section>)}</div>
  </div>;
}
