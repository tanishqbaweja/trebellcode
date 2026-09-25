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
  const [mode,setMode]=useState("symbols");
  const [query,setQuery]=useState("");
  const [results,setResults]=useState([]);
  const [searched,setSearched]=useState(false);
  const [selected,setSelected]=useState(null);
  const [relations,setRelations]=useState(null);
  const [view,setView]=useState(null);
  const [viewData,setViewData]=useState(null);
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  useEffect(()=>{setMode("symbols");setQuery("");setResults([]);setSearched(false);setSelected(null);setRelations(null);setView(null);setViewData(null);setBusy("");setError("")},[root,environmentId]);
  if(!root)return null;
  const params=extra=>{const value=new URLSearchParams({path:root,...extra});if(environmentId)value.set("environmentId",environmentId);return value};
  const modeMeta={
    symbols:{label:"Symbols",placeholder:"Search symbols, e.g. ContextEngine",endpoint:"/api/context/symbols",empty:"No indexed symbols matched"},
    files:{label:"Files",placeholder:"Find files, e.g. session",endpoint:"/api/context/files",empty:"No repository files matched"},
    code:{label:"Code",placeholder:"Search source text or regex",endpoint:"/api/context/search",empty:"No source matches found"},
  }[mode];
  function chooseMode(next){if(next===mode)return;setMode(next);setResults([]);setSearched(false);setSelected(null);setRelations(null);setError("")}
  async function search(event){
    event?.preventDefault?.();const value=query.trim();if(!value||busy)return;
    setBusy("search");setError("");setSelected(null);setRelations(null);
    try{const response=await api(modeMeta.endpoint+"?"+params({q:value,limit:"40"}));setResults(response.data||[]);setSearched(true)}
    catch(searchError){setResults([]);setSearched(true);setError(searchError.message||String(searchError))}
    finally{setBusy("")}
  }
  async function inspect(path){
    if(!path||busy)return;setBusy("relations");setError("");setSelected(path);setRelations(null);
    try{setRelations(await api("/api/context/relations?"+params({file:path})))}
    catch(relationError){setError(relationError.message||String(relationError))}
    finally{setBusy("")}
  }
  async function loadView(next){
    if(busy)return;if(view===next){setView(null);setViewData(null);return}
    setBusy("view");setError("");setView(next);setViewData(null);
    try{
      const endpoint=next==="commands"?"/api/context/commands":"/api/context/map";
      const extra=next==="commands"?{limit:"80"}:{q:query.trim(),limit:"24"};
      setViewData(await api(endpoint+"?"+params(extra)));
    }catch(viewError){setError(viewError.message||String(viewError));setView(null)}
    finally{setBusy("")}
  }
  const relationPaths=relations?[...new Set([
    ...(relations.imports||[]).map(item=>item.target).filter(Boolean),
    ...(relations.importers||[]).map(item=>item.path),
    ...(relations.referencedSymbols||[]).map(item=>item.target),
    ...(relations.referencedBy||[]).map(item=>item.path),
  ])].filter(path=>path!==relations.path).slice(0,16):[];
  const resultLabel=item=>mode==="symbols"?item.name:mode==="files"?item.path:`${item.path}:${item.line}`;
  const resultDetail=item=>mode==="symbols"?`${item.kind} · ${item.path}:${item.line}`:mode==="files"?`${item.indexedSource?"indexed source":"repository file"}${item.extension?` · ${item.extension}`:""}`:String(item.text||"").trim();
  const resultMeta=item=>mode==="symbols"?(item.parser||"index"):mode==="files"?String(item.score??""):item.line?`L${item.line}`:"match";
  return <section className="context-explorer" data-testid="context-explorer">
    <div className="context-inspector-section-head"><strong>Repository explorer</strong><span>deterministic index</span></div>
    <div className="context-explorer-modes" role="group" aria-label="Repository search mode">{["symbols","files","code"].map(item=><button type="button" key={item} className={mode===item?"active":""} onClick={()=>chooseMode(item)}>{({symbols:"Symbols",files:"Files",code:"Code"})[item]}</button>)}</div>
    <form className="context-explorer-search" onSubmit={search}>
      <input aria-label={`Search repository ${mode}`} value={query} onChange={event=>setQuery(event.target.value)} placeholder={modeMeta.placeholder}/>
      <button type="submit" disabled={!query.trim()||Boolean(busy)}>{busy==="search"?"Searching…":"Search"}</button>
    </form>
    <div className="context-explorer-actions" aria-label="Repository intelligence views">
      <button type="button" className={view==="architecture"?"active":""} onClick={()=>loadView("architecture")} disabled={Boolean(busy)}>Architecture</button>
      <button type="button" className={view==="commands"?"active":""} onClick={()=>loadView("commands")} disabled={Boolean(busy)}>Commands</button>
      <span>{busy==="view"?"Loading…":"on demand"}</span>
    </div>
    {error&&<p className="context-explorer-error" role="alert">{error}</p>}
    {searched&&!results.length&&!error&&<p className="context-explorer-empty">{modeMeta.empty} “{query.trim()}”.</p>}
    {results.length>0&&<div className="context-explorer-results" aria-label={`Repository ${mode} results`}>{results.map((item,index)=><button type="button" key={`${mode}:${item.path}:${item.line||0}:${item.name||""}:${index}`} className={selected===item.path?"active":""} onClick={()=>inspect(item.path)} disabled={busy==="relations"}>
      <span><strong>{resultLabel(item)}</strong><small>{resultDetail(item)}</small></span><em>{resultMeta(item)}</em>
    </button>)}</div>}
    {view==="architecture"&&viewData&&<div className="context-explorer-view" data-testid="context-architecture-view">
      <div><strong>Architecture map</strong><span>{viewData.indexedFiles??0} indexed · {viewData.graphEdges??0} relations</span></div>
      {(viewData.data||[]).slice(0,12).map(item=><button type="button" key={item.path} onClick={()=>inspect(item.path)}><span><b>{item.path}</b><small>{item.incoming||0} incoming · {item.outgoing||0} outgoing · {(item.definitions||[]).length} definitions</small></span><em>{Number(item.centrality||0).toFixed(3)}</em></button>)}
      {!(viewData.data||[]).length&&<p className="context-explorer-empty">No indexed source files are available for the architecture map.</p>}
    </div>}
    {view==="commands"&&viewData&&<div className="context-explorer-view" data-testid="context-command-view">
      <div><strong>Project commands</strong><span>{(viewData.declared||[]).length} declared · {(viewData.conventional||[]).length} conventional</span></div>
      {(viewData.declared||[]).slice(0,12).map((item,index)=><article key={`declared:${item.path}:${item.command}:${index}`}><code>{item.command}</code><span>{item.kind} · declared in {item.path}</span></article>)}
      {(viewData.conventional||[]).slice(0,8).map((item,index)=><article key={`conventional:${item.path}:${item.command}:${index}`}><code>{item.command}</code><span>{item.kind} · convention · {item.reason}</span></article>)}
      {!(viewData.declared||[]).length&&!(viewData.conventional||[]).length&&<p className="context-explorer-empty">No build, test, lint, or run commands were discovered.</p>}
    </div>}
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
