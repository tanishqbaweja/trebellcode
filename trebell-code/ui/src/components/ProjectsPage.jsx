import React,{useEffect,useMemo,useState} from "react";
import { FolderCode, GitBranch, Plus, RefreshCw, Trash2, Layers3 } from "lucide-react";
import { api } from "../api.js";

export default function ProjectsPage({currentPath,onOpen,models=[]}){
  const [projects,setProjects]=useState([]);
  const [cloneUrl,setCloneUrl]=useState("");
  const [busy,setBusy]=useState(false);

  async function refresh(){
    const d=await api("/api/projects").catch(()=>({projects:[]}));
    const enriched=await Promise.all((d.projects||[]).map(async project=>{
      const git=await api("/api/git/info?path="+encodeURIComponent(project.path)).catch(()=>null);
      const remote=git?.remotes?.find(r=>r.kind==="fetch")?.url||null;
      return {...project,git,remote};
    }));
    setProjects(enriched);
  }
  useEffect(()=>{refresh()},[]);

  async function saveProject(project,patch){
    await api("/api/projects",{method:"POST",body:{path:project.path,...patch}});
    await refresh();
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
    const destination=parent.replace(/[\\/]$/,"")+sep+name;
    setBusy(true);
    try{
      await api("/api/git/action",{method:"POST",body:{action:"clone",url:cloneUrl.trim(),destination}});
      await refresh();
      onOpen(destination);
      setCloneUrl("");
    } finally { setBusy(false); }
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
    <div className="clone-card"><GitBranch size={20}/><div><strong>Clone repository</strong><span>HTTPS or SSH Git URL</span></div><input value={cloneUrl} onChange={e=>setCloneUrl(e.target.value)} placeholder="https://github.com/owner/repo.git"/><button onClick={clone} disabled={busy||!cloneUrl.trim()}>{busy?"Cloning…":"Clone"}</button></div>
    <div className="project-groups">{groups.map(group=><section className="project-group" key={group.key}>
      <div className="project-group-head"><Layers3 size={14}/><div><strong>{group.label}</strong><span>{group.projects.length} checkout{group.projects.length===1?"":"s"}</span></div></div>
      <div className="project-grid">{group.projects.map(p=><div className={p.path===currentPath?"project-card active":"project-card"} key={p.id}>
        <button className="project-open" onClick={()=>onOpen(p.path)}><FolderCode size={22}/><div><strong>{p.name}</strong><span>{p.path}</span><small>{p.git?.branch||"not a Git checkout"} · {new Date(p.lastOpenedAt).toLocaleString()}</small></div></button>
        <button className="project-remove" onClick={async()=>{await api("/api/projects?id="+encodeURIComponent(p.id),{method:"DELETE"});refresh()}}><Trash2 size={13}/></button>
        <div className="project-overrides">
          <label>Model<select value={p.defaultModel||""} onChange={e=>saveProject(p,{defaultModel:e.target.value||null})}><option value="">Inherit client default</option>{models.map(id=><option key={id} value={id}>{id.replace(/^freebuff\//,"")}</option>)}</select></label>
          <label>Permissions<select value={p.permissionMode||""} onChange={e=>saveProject(p,{permissionMode:e.target.value||null})}><option value="">Inherit</option><option value="supervised">Supervised</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></label>
          <label>Workspace<select value={p.workspaceMode||""} onChange={e=>saveProject(p,{workspaceMode:e.target.value||null})}><option value="">Inherit</option><option value="current">Current checkout</option><option value="worktree">New worktree</option></select></label>
        </div>
      </div>)}</div>
    </section>)}</div>
  </div>;
}
