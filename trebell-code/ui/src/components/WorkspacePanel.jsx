import React,{useEffect,useMemo,useState} from "react";
import { Check, FileCode2, FileDiff, Folder, Paperclip, RefreshCw, Save, Search, X } from "lucide-react";
import Prism from "prismjs";
import { api } from "../api.js";

function languageFor(name=""){
  const ext=name.split(".").pop()?.toLowerCase();
  if(["js","mjs","cjs","jsx","ts","tsx"].includes(ext)) return Prism.languages.javascript;
  if(["css","scss"].includes(ext)) return Prism.languages.css;
  if(["html","htm","xml","svg"].includes(ext)) return Prism.languages.markup;
  return Prism.languages.javascript;
}

export default function WorkspacePanel({projectPath,reviewedFiles=[],onReviewedChange,onAttachPath}){
  const [tab,setTab]=useState("files");
  const [entries,setEntries]=useState([]);
  const [query,setQuery]=useState("");
  const [searchResults,setSearchResults]=useState([]);
  const [file,setFile]=useState(null);
  const [edit,setEdit]=useState(false);
  const [draft,setDraft]=useState("");
  const [diff,setDiff]=useState({status:"",diff:""});
  const [loading,setLoading]=useState(false);

  async function refreshTree(){
    if(!projectPath)return;setLoading(true);
    const data=await api("/api/workspace/tree?path="+encodeURIComponent(projectPath)).catch(()=>({entries:[]}));
    setEntries(data.entries||[]);setLoading(false);
  }
  async function refreshDiff(){
    if(!projectPath)return;setLoading(true);
    const data=await api("/api/workspace/diff?path="+encodeURIComponent(projectPath)).catch(error=>({status:"",diff:"",error:error.message}));
    setDiff(data);setLoading(false);
  }
  useEffect(()=>{refreshTree();refreshDiff();setFile(null);},[projectPath]);

  useEffect(()=>{
    if(!query.trim()){setSearchResults([]);return;}
    const t=setTimeout(()=>api("/api/workspace/search?path="+encodeURIComponent(projectPath)+"&q="+encodeURIComponent(query)).then(d=>setSearchResults(d.items||[])).catch(()=>setSearchResults([])),180);
    return()=>clearTimeout(t);
  },[query,projectPath]);

  async function open(path){
    const data=await api("/api/workspace/file?path="+encodeURIComponent(path));
    setFile(data);setDraft(data.content);setEdit(false);
  }
  async function save(){
    const data=await api("/api/workspace/file",{method:"PUT",body:{path:file.path,content:draft}});
    setFile(data);setDraft(data.content);setEdit(false);refreshDiff();
  }
  const highlighted=useMemo(()=>file?Prism.highlight(file.content,languageFor(file.name),"javascript"):"",[file]);
  const changedPaths=useMemo(()=>String(diff.status||"").split(/\r?\n/).filter(Boolean).map(line=>line.slice(3)),[diff.status]);
  const source=query?searchResults:entries;

  return <div className="workspace-panel">
    <div className="panel-tabs"><button className={tab==="files"?"active":""} onClick={()=>setTab("files")}>Files</button><button className={tab==="diff"?"active":""} onClick={()=>{setTab("diff");refreshDiff()}}>Changes {changedPaths.length?"("+changedPaths.length+")":""}</button><button onClick={()=>{refreshTree();refreshDiff()}}><RefreshCw size={13}/></button></div>
    {tab==="files"&&<div className="workspace-files">
      <div className="workspace-search"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search files…"/></div>
      <div className="workspace-body">
        <div className="tree-list">{loading?<p>Loading…</p>:source.map(entry=><button key={entry.path} style={{paddingLeft:8+(entry.depth||0)*14}} onClick={()=>entry.isFile&&open(entry.path)}>{entry.isDirectory?<Folder size={14}/>:<FileCode2 size={14}/>}<span>{entry.relativePath||entry.name}</span>{entry.isFile&&<i onClick={e=>{e.stopPropagation();onAttachPath?.(entry.path)}}><Paperclip size={11}/></i>}</button>)}</div>
        <div className="file-view">{!file?<div className="file-empty">Select a file to inspect it.</div>:<>
          <div className="file-head"><strong>{file.name}</strong><div><button onClick={()=>onAttachPath?.(file.path)}><Paperclip size={13}/> Attach</button><button onClick={()=>setEdit(v=>!v)}>{edit?<X size={13}/>:<FileCode2 size={13}/>} {edit?"Cancel":"Edit"}</button>{edit&&<button onClick={save}><Save size={13}/> Save</button>}</div></div>
          {edit?<textarea className="file-editor" value={draft} onChange={e=>setDraft(e.target.value)}/>:<pre className="syntax-view"><code dangerouslySetInnerHTML={{__html:highlighted}}/></pre>}
        </>}</div>
      </div>
    </div>}
    {tab==="diff"&&<div className="changes-view">
      <div className="changed-files">{changedPaths.map(path=><button key={path} onClick={()=>onReviewedChange?.(path,!reviewedFiles.includes(path))} className={reviewedFiles.includes(path)?"reviewed":""}><span>{reviewedFiles.includes(path)?<Check size={12}/>:<FileDiff size={12}/>}</span>{path}</button>)}</div>
      <pre className="git-diff">{diff.diff||diff.error||"No unstaged diff."}</pre>
    </div>}
  </div>;
}
