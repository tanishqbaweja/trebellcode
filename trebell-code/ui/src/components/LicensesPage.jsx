import React,{useEffect,useMemo,useState} from "react";
import { FileText, Search, X } from "lucide-react";
import { api } from "../api.js";

export default function LicensesPage(){
  const [items,setItems]=useState([]);const [query,setQuery]=useState("");const [selected,setSelected]=useState(null);const [detail,setDetail]=useState(null);const [error,setError]=useState("");
  useEffect(()=>{api("/api/licenses").then(result=>setItems(result.items||[])).catch(err=>setError(err.message))},[]);
  const filtered=useMemo(()=>{const q=query.trim().toLowerCase();return q?items.filter(item=>`${item.name} ${item.version} ${item.license} ${item.component}`.toLowerCase().includes(q)):items},[items,query]);
  async function open(item){setSelected(item.id);setDetail(null);setError("");try{setDetail(await api("/api/licenses/detail?id="+encodeURIComponent(item.id)))}catch(err){setError(err.message)}}
  return <div className="licenses-page">
    <div className="licenses-toolbar"><div className="licenses-search"><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search package, version or license"/></div><span>{filtered.length} of {items.length}</span></div>
    <div className="licenses-layout"><div className="licenses-list">{filtered.map(item=><button key={item.id} className={selected===item.id?"active":""} onClick={()=>open(item)}><FileText size={13}/><span><strong>{item.name}</strong><small>{item.version||"unknown version"} · {item.license||"Unknown"}</small></span><em>{item.component}</em></button>)}{!filtered.length&&<div className="license-list-empty"><FileText size={17}/><strong>No matching packages</strong><span>Try a package name, version, or license type.</span></div>}</div>
      <div className="license-detail">{detail?<><div className="license-detail-head"><div><strong>{detail.name}</strong><span>{detail.version} · {detail.license}</span></div><button onClick={()=>{setSelected(null);setDetail(null)}}><X size={13}/></button></div>{detail.homepage&&<p>{detail.homepage}</p>}<pre>{detail.text}</pre></>:<div className="license-empty-state"><FileText size={20}/><strong>Select a package</strong><span>Its installed license notice will appear here.</span></div>}{error&&<div className="inline-error">{error}</div>}</div>
    </div>
  </div>;
}
