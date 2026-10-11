import React,{useEffect,useMemo,useRef,useState} from "react";
import { FileText, LoaderCircle, Search, X } from "lucide-react";
import { api } from "../api.js";

const versionLine=item=>`${item.version||"unknown version"} · ${item.license||"Unknown"}`;
const reason=error=>error?.message||String(error||"")||"Unknown error";

export default function LicensesPage(){
  const [items,setItems]=useState([]);const [query,setQuery]=useState("");const [listError,setListError]=useState("");
  // The open package: the row picked last and where its notice read stands ({item,status:"loading"|"ready"|"failed",detail,error}).
  // The pane names that row straight away. Reads are numbered, so a late answer for a row picked before, or for a pane that was
  // closed meanwhile, is dropped instead of filling the pane under another row's highlight.
  const [opened,setOpened]=useState(null);const noticeRead=useRef(0);
  useEffect(()=>{api("/api/licenses").then(result=>setItems(result.items||[])).catch(err=>setListError(err.message))},[]);
  const filtered=useMemo(()=>{const q=query.trim().toLowerCase();return q?items.filter(item=>`${item.name} ${item.version} ${item.license} ${item.component}`.toLowerCase().includes(q)):items},[items,query]);
  async function open(item){
    const read=++noticeRead.current;
    setOpened({item,status:"loading",detail:null,error:""});
    try{const detail=await api("/api/licenses/detail?id="+encodeURIComponent(item.id));if(read===noticeRead.current)setOpened({item,status:"ready",detail,error:""})}
    catch(error){if(read===noticeRead.current)setOpened({item,status:"failed",detail:null,error:reason(error)})}
  }
  function close(){noticeRead.current++;setOpened(null)}
  return <div className="licenses-page">
    <div className="licenses-toolbar"><div className="licenses-search"><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"&&query){e.preventDefault();e.stopPropagation();setQuery("")}}} placeholder="Search package, version or license"/></div><span>{filtered.length} of {items.length}</span></div>
    <div className="licenses-layout"><div className="licenses-list">{filtered.map(item=><button key={item.id} className={opened?.item.id===item.id?"active":""} onClick={()=>open(item)}><FileText size={13}/><span><strong>{item.name}</strong><small>{versionLine(item)}</small></span><em>{item.component}</em></button>)}{!filtered.length&&<div className="license-list-empty"><FileText size={17}/><strong>No matching packages</strong><span>Try a package name, version, or license type.</span></div>}</div>
      <div className="license-detail">{opened?<>
        <div className="license-detail-head"><div><strong>{opened.item.name}</strong><span>{versionLine(opened.item)}</span></div><button type="button" aria-label="Close license" title="Close license" onClick={close}><X size={13}/></button></div>
        {opened.status==="ready"?<>{opened.detail?.homepage&&<p>{opened.detail.homepage}</p>}<pre>{opened.detail?.text||""}</pre></>
          :opened.status==="failed"?<div className="inline-error license-notice-failed" role="alert">Could not load this notice: {opened.error}</div>
          :<div className="license-notice-loading" role="status" aria-busy="true"><LoaderCircle size={14} aria-hidden="true"/>Loading the notice…</div>}
      </>:<div className="license-empty-state"><FileText size={20}/><strong>Select a package</strong><span>Its installed license notice will appear here.</span></div>}{listError&&<div className="inline-error">{listError}</div>}</div>
    </div>
  </div>;
}
