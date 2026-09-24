import React,{useEffect,useMemo,useState} from "react";
import { Check, FileCode2, FileDiff, FileImage, FileText, Folder, Music2, Paperclip, RefreshCw, Save, Search, Video, X } from "lucide-react";
import Prism from "prismjs";
import { api } from "../api.js";
import OpenInPicker from "./OpenInPicker.jsx";

const IMAGE_EXT=new Set(["png","jpg","jpeg","gif","webp","bmp","svg","ico"]);
const VIDEO_EXT=new Set(["mp4","webm","mov"]);
const AUDIO_EXT=new Set(["mp3","wav","m4a","ogg","flac"]);
const TABLE_EXT=new Set(["csv","tsv"]);

function extension(name=""){return name.split(".").pop()?.toLowerCase()||""}
function previewKind(name=""){
  const ext=extension(name);
  if(IMAGE_EXT.has(ext))return "image";
  if(VIDEO_EXT.has(ext))return "video";
  if(AUDIO_EXT.has(ext))return "audio";
  if(ext==="pdf")return "pdf";
  if(ext==="html"||ext==="htm")return "html";
  if(ext==="md"||ext==="markdown")return "markdown";
  if(TABLE_EXT.has(ext))return "table";
  return "text";
}
function languageFor(name=""){
  const ext=extension(name);
  if(["js","mjs","cjs","jsx","ts","tsx","json"].includes(ext)) return Prism.languages.javascript;
  if(["css","scss"].includes(ext)) return Prism.languages.css;
  if(["html","htm","xml","svg"].includes(ext)) return Prism.languages.markup;
  return Prism.languages.javascript;
}
function parseDelimited(text,delimiter=","){
  const rows=[];let row=[],cell="",quoted=false;
  const value=String(text||"");
  for(let i=0;i<value.length;i++){
    const ch=value[i],next=value[i+1];
    if(ch==='"'){
      if(quoted&&next==='"'){cell+='"';i++}
      else quoted=!quoted;
    }else if(ch===delimiter&&!quoted){row.push(cell);cell=""}
    else if((ch==="\n"||ch==="\r")&&!quoted){
      if(ch==="\r"&&next==="\n")i++;
      row.push(cell);rows.push(row);row=[];cell="";
      if(rows.length>=300)break;
    }else cell+=ch;
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows;
}
function MarkdownPreview({content}){
  const lines=String(content||"").split(/\r?\n/);
  let fenced=false;
  return <div className="markdown-preview">{lines.map((line,index)=>{
    if(line.trim().startsWith("```")){fenced=!fenced;return <div className="md-fence" key={index}>{fenced?"code":""}</div>}
    if(fenced)return <pre key={index}>{line||" "}</pre>;
    const h=line.match(/^(#{1,6})\s+(.+)$/);if(h)return React.createElement("h"+h[1].length,{key:index},h[2]);
    const item=line.match(/^\s*[-*+]\s+(.+)$/);if(item)return <div className="md-list" key={index}>• <span>{item[1]}</span></div>;
    if(line.startsWith(">"))return <blockquote key={index}>{line.replace(/^>\s?/,"")}</blockquote>;
    if(!line.trim())return <div className="md-gap" key={index}/>;
    return <p key={index}>{line}</p>;
  })}</div>;
}
function fileIcon(name){
  const kind=previewKind(name);
  if(kind==="image")return <FileImage size={14}/>;
  if(kind==="video")return <Video size={14}/>;
  if(kind==="audio")return <Music2 size={14}/>;
  if(kind==="pdf"||kind==="markdown"||kind==="table")return <FileText size={14}/>;
  return <FileCode2 size={14}/>;
}

export default function WorkspacePanel({projectPath,environmentId=null,remote=false,defaultTab="files",allowDiff=true,activeThreadId=null,reviewedFiles=[],onReviewedChange,onAttachPath,onReviewComment}){
  const [tab,setTab]=useState(defaultTab==="diff"?"diff":"files");
  const [entries,setEntries]=useState([]);
  const [query,setQuery]=useState("");
  const [searchResults,setSearchResults]=useState([]);
  const [file,setFile]=useState(null);
  const [edit,setEdit]=useState(false);
  const [draft,setDraft]=useState("");
  const [diff,setDiff]=useState({status:"",diff:""});
  const [diffError,setDiffError]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [treeError,setTreeError]=useState("");
  const [searchError,setSearchError]=useState("");
  const [actionError,setActionError]=useState("");
  const [actionBusy,setActionBusy]=useState("");
  function params(values={}){
    const query=new URLSearchParams(values);
    query.set("environmentId",environmentId||"");
    return query.toString();
  }

  async function refreshTree(){
    if(!projectPath)return;setLoading(true);setTreeError("");
    try{
      const data=await api("/api/workspace/tree?"+params({path:projectPath}));
      setEntries(data.entries||[]);
    }catch(err){setTreeError(err.message||String(err)||"Could not refresh workspace files.")}
    finally{setLoading(false)}
  }
  async function refreshDiff(){
    if(!projectPath)return;setLoading(true);setDiffError("");
    try{
      const data=await api("/api/workspace/diff?"+params({path:projectPath}));
      setDiff(data);setDiffError(data.error||"");
    }catch(error){setDiffError(error.message||String(error)||"Could not refresh workspace changes.")}
    finally{setLoading(false)}
  }
  useEffect(()=>{setDiff({status:"",diff:""});setDiffError("");refreshTree();refreshDiff();setFile(null);setError("");},[projectPath,environmentId]);
  useEffect(()=>{setTab(defaultTab==="diff"?"diff":"files")},[defaultTab]);
  useEffect(()=>{
    let timer=null;
    const changed=event=>{
      const message=event.detail||{},params=message.params||{};
      const fileChange=message.method==="item/fileChange/outputDelta"||message.method==="item/fileChange/patchUpdated"||(message.method==="item/completed"&&params.item?.type==="fileChange");
      const settled=message.method==="turn/diff/updated"||message.method==="turn/completed";
      if(!fileChange&&!settled)return;
      if(activeThreadId&&params.threadId&&params.threadId!==activeThreadId)return;
      if(!activeThreadId&&params.threadId)return;
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{
        refreshTree();
        if(allowDiff)refreshDiff();
        if(file?.path&&!edit)open(file.path);
      },120);
    };
    window.addEventListener("trebell:rpc-notification",changed);
    return()=>{if(timer)clearTimeout(timer);window.removeEventListener("trebell:rpc-notification",changed)};
  },[activeThreadId,projectPath,environmentId,allowDiff,file?.path,edit]);

  useEffect(()=>{
    if(!query.trim()){setSearchResults([]);setSearchError("");return;}
    const t=setTimeout(async()=>{
      try{
        const data=await api("/api/workspace/search?"+params({path:projectPath,q:query}));
        setSearchResults(data.items||[]);setSearchError("");
      }catch(err){setSearchResults([]);setSearchError(err.message||String(err)||"Could not search workspace files.")}
    },180);
    return()=>clearTimeout(t);
  },[query,projectPath,environmentId]);

  async function open(path){
    setError("");
    const name=String(path).split(/[\\/]/).pop()||path;
    const kind=previewKind(name);
    if(["image","video","audio","pdf"].includes(kind)){
      setFile({path,name,kind,content:null});setDraft("");setEdit(false);return;
    }
    try{
      const data=await api("/api/workspace/file?"+params({root:projectPath,path}));
      setFile({...data,kind});setDraft(data.content);setEdit(false);
    }catch(err){setFile({path,name,kind:"unsupported",content:null});setDraft("");setEdit(false);setError(err.message||String(err))}
  }
  async function save(){
    setError("");
    try{
      const data=await api("/api/workspace/file",{method:"PUT",body:{root:projectPath,path:file.path,content:draft,environmentId}});
      setFile({...data,kind:previewKind(data.name)});setDraft(data.content);setEdit(false);await refreshDiff();
    }catch(err){setError(err.message||String(err)||"Could not save file.")}
  }
  async function changeReviewed(path,value){
    if(!onReviewedChange||actionBusy)return;
    setActionBusy("reviewed:"+path);setActionError("");
    try{await Promise.resolve(onReviewedChange(path,value))}
    catch(err){setActionError("Could not update reviewed state: "+(err?.message||String(err)))}
    finally{setActionBusy("")}
  }
  async function addReviewComment(path){
    const comment=prompt("Review comment for "+path);if(!comment?.trim()||!onReviewComment||actionBusy)return;
    setActionBusy("comment:"+path);setActionError("");
    try{await Promise.resolve(onReviewComment(path,comment.trim()))}
    catch(err){setActionError("Could not attach review comment: "+(err?.message||String(err)))}
    finally{setActionBusy("")}
  }
  const highlighted=useMemo(()=>file?.content!=null?Prism.highlight(file.content,languageFor(file.name),"javascript"):"",[file]);
  const changedPaths=useMemo(()=>String(diff.status||"").split(/\r?\n/).filter(Boolean).map(line=>line.slice(3)),[diff.status]);
  const diffPanelError=[diffError,actionError].filter(Boolean).join(" · ");
  const source=query?searchResults:entries;
  const rawUrl=file&&projectPath?"/api/workspace/raw?"+params({root:projectPath,path:file.path}):"";
  const table=useMemo(()=>file?.kind==="table"?parseDelimited(file.content,extension(file.name)==="tsv"?"\t":","):[],[file]);

  function preview(){
    if(!file)return <div className="file-empty">Select a file to inspect it.</div>;
    if(edit)return <textarea className="file-editor" value={draft} onChange={e=>setDraft(e.target.value)}/>;
    if(file.kind==="image")return <div className="media-preview image"><img src={rawUrl} alt={file.name}/></div>;
    if(file.kind==="video")return <div className="media-preview"><video src={rawUrl} controls preload="metadata"/></div>;
    if(file.kind==="audio")return <div className="media-preview audio"><Music2 size={34}/><audio src={rawUrl} controls preload="metadata"/></div>;
    if(file.kind==="pdf")return <div className="document-preview"><iframe title={file.name} src={rawUrl}/></div>;
    if(file.kind==="html")return <div className="document-preview"><iframe title={file.name} src={rawUrl} sandbox="" referrerPolicy="no-referrer"/></div>;
    if(file.kind==="markdown")return <MarkdownPreview content={file.content}/>;
    if(file.kind==="table")return <div className="table-preview"><table><tbody>{table.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,colIndex)=>rowIndex===0?<th key={colIndex}>{cell}</th>:<td key={colIndex}>{cell}</td>)}</tr>)}</tbody></table>{table.length>=300&&<p>Preview limited to 300 rows.</p>}</div>;
    if(file.kind==="unsupported")return <div className="file-empty"><strong>Preview unavailable</strong><span>{error||"This file is binary or too large for the text editor."}</span><button onClick={()=>onAttachPath?.(file.path)}><Paperclip size={13}/> Attach to chat</button></div>;
    return <pre className="syntax-view"><code dangerouslySetInnerHTML={{__html:highlighted}}/></pre>;
  }

  const editable=Boolean(file&&["text","html","markdown","table"].includes(file.kind));
  return <div className="workspace-panel">
    <div className="panel-tabs"><button className={tab==="files"?"active":""} onClick={()=>setTab("files")}>Files</button>{allowDiff&&<button className={tab==="diff"?"active":""} onClick={()=>{setTab("diff");refreshDiff()}}>Changes {changedPaths.length?"("+changedPaths.length+")":""}</button>}<button aria-label="Refresh workspace files" onClick={()=>{refreshTree();if(allowDiff)refreshDiff()}}><RefreshCw size={13}/></button></div>
    {tab==="files"&&<div className="workspace-files">
      <div className="workspace-search"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search files…"/></div>
      <div className="workspace-body">
        <div className="tree-list">{(searchError||treeError)&&<p className="workspace-tree-error" role="alert">{searchError||treeError}</p>}{loading?<p>Loading…</p>:source.map(entry=><button key={entry.path} style={{paddingLeft:8+(entry.depth||0)*14}} onClick={()=>entry.isFile&&open(entry.path)}>{entry.isDirectory?<Folder size={14}/>:fileIcon(entry.name)}<span>{entry.relativePath||entry.name}</span>{entry.isFile&&<i onClick={e=>{e.stopPropagation();onAttachPath?.(entry.path)}}><Paperclip size={11}/></i>}</button>)}</div>
        <div className={"file-view"+(error?" has-error":"")}>{file&&<div className="file-head"><strong>{file.name}</strong><div>{!remote&&<OpenInPicker path={file.path} compact/>}<button onClick={()=>onAttachPath?.(file.path)}><Paperclip size={13}/> Attach</button>{editable&&<button onClick={()=>{setError("");setEdit(v=>!v)}}>{edit?<X size={13}/>:<FileCode2 size={13}/>} {edit?"Cancel":"Edit"}</button>}{edit&&<button onClick={save}><Save size={13}/> Save</button>}</div></div>}{error&&file?.kind!=="unsupported"&&<div className="workspace-file-error" role="alert">{error}</div>}{preview()}</div>
      </div>
    </div>}
    {tab==="diff"&&(changedPaths.length?<div className={"changes-view"+(diffPanelError?" has-action-error":"")}>
      {diffPanelError&&<div className="inline-error workspace-diff-error" role="alert">{diffPanelError}</div>}
      <div className="changed-files">{changedPaths.map(path=><div className={reviewedFiles.includes(path)?"changed-file-row reviewed":"changed-file-row"} key={path}><button onClick={()=>changeReviewed(path,!reviewedFiles.includes(path))} disabled={actionBusy==="reviewed:"+path}><span>{reviewedFiles.includes(path)?<Check size={12}/>:<FileDiff size={12}/>}</span>{path}</button><button className="review-comment" title="Add review comment as context" onClick={()=>addReviewComment(path)} disabled={actionBusy==="comment:"+path}>+</button></div>)}</div>
      <pre className="git-diff">{diff.diff||diff.error||"No unstaged diff."}</pre>
    </div>:<div className={"changes-empty"+((diffError||diff.error)?" error":"")}><FileDiff size={20}/><strong>{(diffError||diff.error)?"Could not load changes":"Working tree clean"}</strong><span>{diffError||diff.error||"No unstaged changes to review."}</span></div>)}
  </div>;
}
