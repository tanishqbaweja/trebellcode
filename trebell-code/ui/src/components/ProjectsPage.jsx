import React,{useEffect,useState} from "react";
import { FolderCode, GitBranch, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../api.js";

export default function ProjectsPage({currentPath,onOpen}){
  const [projects,setProjects]=useState([]);
  const [cloneUrl,setCloneUrl]=useState("");
  const [busy,setBusy]=useState(false);
  async function refresh(){const d=await api("/api/projects").catch(()=>({projects:[]}));setProjects(d.projects||[])}
  useEffect(()=>{refresh()},[]);
  async function addLocal(){const path=await window.trebellDesktop?.pickDirectory?.();if(!path)return;await api("/api/projects",{method:"POST",body:{path}});await refresh();onOpen(path)}
  async function clone(){
    if(!cloneUrl.trim())return;const parent=await window.trebellDesktop?.pickDirectory?.();if(!parent)return;
    const name=cloneUrl.replace(/\/+$/,"").split("/").pop().replace(/\.git$/,"")||"repository";
    const sep=parent.includes("\\")?"\\":"/";const destination=parent.replace(/[\\/]$/,"")+sep+name;
    setBusy(true);try{await api("/api/git/action",{method:"POST",body:{action:"clone",url:cloneUrl.trim(),destination}});await refresh();onOpen(destination);setCloneUrl("")}finally{setBusy(false)}
  }
  return <div className="projects-page">
    <div className="page-actions"><button onClick={addLocal}><Plus size={14}/> Add local project</button><button onClick={refresh}><RefreshCw size={14}/></button></div>
    <div className="clone-card"><GitBranch size={20}/><div><strong>Clone repository</strong><span>HTTPS or SSH Git URL</span></div><input value={cloneUrl} onChange={e=>setCloneUrl(e.target.value)} placeholder="https://github.com/owner/repo.git"/><button onClick={clone} disabled={busy||!cloneUrl.trim()}>{busy?"Cloning…":"Clone"}</button></div>
    <div className="project-grid">{projects.map(p=><div className={p.path===currentPath?"project-card active":"project-card"} key={p.id}><button className="project-open" onClick={()=>onOpen(p.path)}><FolderCode size={22}/><div><strong>{p.name}</strong><span>{p.path}</span><small>{new Date(p.lastOpenedAt).toLocaleString()}</small></div></button><button className="project-remove" onClick={async()=>{await api("/api/projects?id="+encodeURIComponent(p.id),{method:"DELETE"});refresh()}}><Trash2 size={13}/></button></div>)}</div>
  </div>;
}
