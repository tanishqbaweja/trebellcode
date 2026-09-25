import React,{useEffect,useState} from "react";
import { api } from "../api.js";

function deliveryLabel(packet){
  if(packet?.delivery==="additionalContext")return "Codex additional context";
  if(packet?.delivery==="promptPreamble")return "Runtime prompt preamble";
  return "Not injected yet";
}

function scoreLabel(item,highest){
  if(!highest)return "related";
  const ratio=Number(item?.score||0)/highest;
  if(ratio>=0.72)return "high";
  if(ratio>=0.38)return "medium";
  return "supporting";
}

function ContextExplorer({root,environmentId=null}){
  const [query,setQuery]=useState("");
  const [results,setResults]=useState([]);
  const [searched,setSearched]=useState(false);
  const [selected,setSelected]=useState(null);
  const [relations,setRelations]=useState(null);
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  useEffect(()=>{setQuery("");setResults([]);setSearched(false);setSelected(null);setRelations(null);setBusy("");setError("")},[root,environmentId]);
  if(!root)return null;
  const params=extra=>{const value=new URLSearchParams({path:root,...extra});if(environmentId)value.set("environmentId",environmentId);return value};
  async function search(event){
    event?.preventDefault?.();const value=query.trim();if(!value||busy)return;
    setBusy("search");setError("");setSelected(null);setRelations(null);
    try{const response=await api("/api/context/symbols?"+params({q:value,limit:"40"}));setResults(response.data||[]);setSearched(true)}
    catch(searchError){setResults([]);setSearched(true);setError(searchError.message||String(searchError))}
    finally{setBusy("")}
  }
  async function inspect(path){
    if(!path||busy)return;setBusy("relations");setError("");setSelected(path);setRelations(null);
    try{setRelations(await api("/api/context/relations?"+params({file:path})))}
    catch(relationError){setError(relationError.message||String(relationError))}
    finally{setBusy("")}
  }
  const relationPaths=relations?[...new Set([
    ...(relations.imports||[]).map(item=>item.target).filter(Boolean),
    ...(relations.importers||[]).map(item=>item.path),
    ...(relations.referencedSymbols||[]).map(item=>item.target),
    ...(relations.referencedBy||[]).map(item=>item.path),
  ])].filter(path=>path!==relations.path).slice(0,16):[];
  return <section className="context-explorer" data-testid="context-explorer">
    <div className="context-inspector-section-head"><strong>Repository explorer</strong><span>deterministic index</span></div>
    <form className="context-explorer-search" onSubmit={search}>
      <input aria-label="Search repository symbols" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search symbols, e.g. ContextEngine"/>
      <button type="submit" disabled={!query.trim()||Boolean(busy)}>{busy==="search"?"Searching…":"Search"}</button>
    </form>
    {error&&<p className="context-explorer-error" role="alert">{error}</p>}
    {searched&&!results.length&&!error&&<p className="context-explorer-empty">No indexed symbols matched “{query.trim()}”.</p>}
    {results.length>0&&<div className="context-explorer-results" aria-label="Repository symbol results">{results.map((item,index)=><button type="button" key={`${item.path}:${item.line}:${item.name}:${index}`} className={selected===item.path?"active":""} onClick={()=>inspect(item.path)} disabled={busy==="relations"}>
      <span><strong>{item.name}</strong><small>{item.kind} · {item.path}:{item.line}</small></span><em>{item.parser||"index"}</em>
    </button>)}</div>}
    {selected&&busy==="relations"&&<p className="context-explorer-empty">Tracing imports and references for {selected}…</p>}
    {relations&&<div className="context-explorer-relations" data-testid="context-file-relations">
      <div><strong>{relations.path}</strong><span>{relations.definitions?.length||0} definitions · {relations.importers?.length||0} importers</span></div>
      {(relations.relatedTests||[]).length>0&&<p><b>Related tests</b>{relations.relatedTests.map(path=><button type="button" key={path} onClick={()=>inspect(path)}>{path}</button>)}</p>}
      {relationPaths.length>0&&<p><b>Related files</b>{relationPaths.map(path=><button type="button" key={path} onClick={()=>inspect(path)}>{path}</button>)}</p>}
      {!relationPaths.length&&!(relations.relatedTests||[]).length&&<p className="context-explorer-empty">No indexed imports or symbol references connect this file to another source file.</p>}
    </div>}
  </section>;
}

export default function ContextInspector({packet=null,error=null,pressure=null,remote=false,root=null,environmentId=null}){
  if(!packet)return <div className="context-inspector empty">
    <section className="context-inspector-hero">
      <span>Trebell Context Engine</span>
      <strong>No repository context has been injected for this thread yet.</strong>
      <p>{error?.message||(pressure?.skipped
        ?"The latest turn skipped repository injection to preserve about "+Number(pressure.reserveTokens||0).toLocaleString()+" tokens for the model response."
        :"Send a repository task and Trebell will build a bounded structural context packet before the model starts.")}</p>
    </section>
    <ContextExplorer root={root} environmentId={environmentId}/>
  </div>;

  const items=Array.isArray(packet.items)?packet.items:[],highest=Math.max(0,...items.map(item=>Number(item.score)||0));
  return <div className="context-inspector">
    {error?.message&&<div className="context-inspector-warning" role="alert"><strong>Latest context refresh failed.</strong><span>{error.message} The last successful packet is shown below.</span></div>}
    {pressure?.skipped&&<div className="context-inspector-pressure" role="status"><strong>Latest turn preserved response space.</strong><span>Trebell skipped repository injection because only about {Number(pressure.remainingTokens||0).toLocaleString()} context tokens remained. About {Number(pressure.reserveTokens||0).toLocaleString()} were reserved for the response and harness overhead. The last successful packet is shown below.</span></div>}
    <section className="context-inspector-hero">
      <div className="context-inspector-kicker"><span>Trebell Context Engine</span><em>{deliveryLabel(packet)}</em></div>
      <strong>{items.length} selected file{items.length===1?"":"s"} · ~{Number(packet.tokenEstimate||0).toLocaleString()} tokens</strong>
      <p>{packet.task||"Repository structure selected for the latest turn."}</p>
      <div className="context-inspector-stats">
        <div><span>Indexed</span><strong>{packet.stats?.filesIndexed??"—"}</strong></div>
        <div><span>Reused</span><strong>{packet.stats?.reused??"—"}</strong></div>
        <div><span>Reparsed</span><strong>{packet.stats?.reparsed??"—"}</strong></div>
        <div><span>Relations</span><strong>{packet.stats?.graphEdges??"—"}</strong></div>
        <div><span>Workspace</span><strong>{packet.stats?.remote||remote?"Remote":"Local"}</strong></div>
        <div><span>Budget</span><strong>{packet.budget?.mode||"Fixed"}</strong></div>
      </div>
    </section>

    <ContextExplorer root={root} environmentId={environmentId}/>

    <section className="context-inspector-list" aria-label="Selected repository context">
      <div className="context-inspector-section-head"><strong>Selected context</strong><span>why Trebell included it</span></div>
      {items.map(item=><article className="context-inspector-item" key={item.path}>
        <div className="context-inspector-path">
          <code title={item.path}>{item.path}</code>
          <span className={"context-rank "+scoreLabel(item,highest)}>{scoreLabel(item,highest)}</span>
        </div>
        <p>{(item.reasons||[]).join(" · ")||"Related through repository structure."}</p>
        {(item.symbols||[]).length>0&&<div className="context-symbols">{item.symbols.slice(0,6).map(symbol=><span key={symbol.name+":"+symbol.line}>{symbol.name}<small>L{symbol.line}</small></span>)}</div>}
        <small className="context-token-cost">~{item.tokenEstimate||0} tokens in packet</small>
      </article>)}
    </section>

    <details className="context-inspector-payload">
      <summary>Exact injected context</summary>
      <pre>{packet.injection||"No stored injection text."}</pre>
    </details>
    <p className="context-inspector-note">{packet.budget?.reason?("Budget: "+packet.budget.reason+" · up to "+Number(packet.budget.maxTokens||packet.maxTokens||0).toLocaleString()+" tokens / "+(packet.budget.maxFiles||"—")+" files. "):""}This shows Trebell's own injection. An external harness may add private context of its own that Trebell cannot inspect.</p>
  </div>;
}
