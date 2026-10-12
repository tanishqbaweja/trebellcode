import React,{useCallback,useEffect,useMemo,useRef,useState} from "react";
import { CircleAlert, FileText, LoaderCircle, Search, X } from "lucide-react";
import { api } from "../api.js";

const versionLine=item=>`${item.version||"unknown version"} · ${item.license||"Unknown"}`;
const reason=error=>error?.message||String(error||"")||"Unknown error";

export default function LicensesPage(){
  // The list says where its read stands: a list still loading or that failed is not an empty search, so it never reads as
  // "No matching packages" or "0 of 0". Retry asks again; reads are numbered so only the latest one lands.
  const [list,setList]=useState({status:"loading",items:[],error:""});const [query,setQuery]=useState("");
  const listRead=useRef(0),retried=useRef(false),listRef=useRef(null),searchRef=useRef(null),retryRef=useRef(null);
  const items=list.items;
  // The open package: the row picked last and where its notice read stands ({item,status:"loading"|"ready"|"failed",detail,error}).
  // The pane names that row straight away. Reads are numbered, so a late answer for a row picked before, or for a pane that was
  // closed meanwhile, is dropped instead of filling the pane under another row's highlight.
  const [opened,setOpened]=useState(null);const noticeRead=useRef(0);
  const loadList=useCallback(async()=>{
    const read=++listRead.current;
    setList({status:"loading",items:[],error:""});
    try{const result=await api("/api/licenses");if(read===listRead.current)setList({status:"ready",items:Array.isArray(result?.items)?result.items:[],error:""})}
    catch(error){if(read===listRead.current)setList({status:"failed",items:[],error:reason(error)})}
  },[]);
  useEffect(()=>{loadList()},[loadList]);
  // Retry goes away while the list loads, so focus then lands on the first package (the search field when none shows), or on
  // Retry again when it failed again, instead of falling to the page. Focus the person has put somewhere meanwhile (the search,
  // as they type) stays there.
  useEffect(()=>{
    if(!retried.current||list.status==="loading")return;
    retried.current=false;
    const focused=document.activeElement;
    if(focused&&focused!==document.body&&focused.isConnected)return;
    (list.status==="failed"?retryRef.current:listRef.current?.querySelector(":scope>button")||searchRef.current)?.focus();
  },[list.status]);
  function retry(){retried.current=true;loadList()}
  const searched=Boolean(query.trim());
  const filtered=useMemo(()=>{const q=query.trim().toLowerCase();return q?items.filter(item=>`${item.name} ${item.version} ${item.license} ${item.component}`.toLowerCase().includes(q)):items},[items,query]);
  async function open(item){
    const read=++noticeRead.current;
    setOpened({item,status:"loading",detail:null,error:""});
    try{const detail=await api("/api/licenses/detail?id="+encodeURIComponent(item.id));if(read===noticeRead.current)setOpened({item,status:"ready",detail,error:""})}
    catch(error){if(read===noticeRead.current)setOpened({item,status:"failed",detail:null,error:reason(error)})}
  }
  function close(){noticeRead.current++;setOpened(null)}
  return <div className="licenses-page">
    <div className="licenses-toolbar"><div className="licenses-search"><Search size={13}/><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"&&query){e.preventDefault();e.stopPropagation();setQuery("")}}} placeholder="Search package, version or license"/></div>{/* Until the list is read the count is a dash the list's own status explains, so a screen reader skips it. */}<span aria-hidden={list.status==="ready"?undefined:"true"}>{list.status==="ready"?`${filtered.length} of ${items.length}`:"—"}</span></div>
    <div className="licenses-layout"><div className="licenses-list" ref={listRef} aria-busy={list.status==="loading"?"true":undefined}>{list.status==="loading"?<div className="license-list-empty license-list-loading" role="status"><LoaderCircle size={17} aria-hidden="true"/><strong>Loading licenses…</strong></div>
      :list.status==="failed"?<div className="license-list-empty license-list-failed" role="alert"><CircleAlert size={17} aria-hidden="true"/><strong>Could not load the license list</strong><span>{list.error}</span><button type="button" ref={retryRef} onClick={retry}>Retry</button></div>
      :filtered.length?filtered.map(item=><button key={item.id} className={opened?.item.id===item.id?"active":""} onClick={()=>open(item)}><FileText size={13}/><span className="license-row-text"><strong>{item.name}</strong><span className="license-row-meta"><small>{versionLine(item)}</small><em>{item.component}</em></span></span></button>)
      :<div className="license-list-empty"><FileText size={17} aria-hidden="true"/><strong>{searched?"No matching packages":"No packages found"}</strong><span>{searched?"Try a package name, version, or license type.":"This installation has no third-party packages to list."}</span></div>}</div>
      <div className="license-detail">{opened?<>
        <div className="license-detail-head"><div><strong>{opened.item.name}</strong><span>{versionLine(opened.item)}</span></div><button type="button" aria-label="Close license" title="Close license" onClick={close}><X size={13}/></button></div>
        {opened.status==="ready"?<>{opened.detail?.homepage&&<p>{opened.detail.homepage}</p>}<pre>{opened.detail?.text||""}</pre></>
          :opened.status==="failed"?<div className="inline-error license-notice-failed" role="alert">Could not load this notice: {opened.error}</div>
          :<div className="license-notice-loading" role="status" aria-busy="true"><LoaderCircle size={14} aria-hidden="true"/>Loading the notice…</div>}
      </>:<div className="license-empty-state"><FileText size={20}/><strong>Select a package</strong><span>Its installed license notice will appear here.</span></div>}</div>
    </div>
  </div>;
}
