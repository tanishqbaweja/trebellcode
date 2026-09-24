import React from "react";

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

export default function ContextInspector({packet=null,error=null,remote=false}){
  if(!packet)return <div className="context-inspector empty">
    <section className="context-inspector-hero">
      <span>Trebell Context Engine</span>
      <strong>No repository context has been injected for this thread yet.</strong>
      <p>{error?.message||(
        remote
          ?"This thread uses a remote workspace. Trebell's local structural index does not pretend it can see that repository yet."
          :"Send a repository task and Trebell will build a bounded structural context packet before the model starts."
      )}</p>
    </section>
  </div>;

  const items=Array.isArray(packet.items)?packet.items:[],highest=Math.max(0,...items.map(item=>Number(item.score)||0));
  return <div className="context-inspector">
    {error?.message&&<div className="context-inspector-warning" role="alert"><strong>Latest context refresh failed.</strong><span>{error.message} The last successful packet is shown below.</span></div>}
    <section className="context-inspector-hero">
      <div className="context-inspector-kicker"><span>Trebell Context Engine</span><em>{deliveryLabel(packet)}</em></div>
      <strong>{items.length} selected file{items.length===1?"":"s"} · ~{Number(packet.tokenEstimate||0).toLocaleString()} tokens</strong>
      <p>{packet.task||"Repository structure selected for the latest turn."}</p>
      <div className="context-inspector-stats">
        <div><span>Indexed</span><strong>{packet.stats?.filesIndexed??"—"}</strong></div>
        <div><span>Reused</span><strong>{packet.stats?.reused??"—"}</strong></div>
        <div><span>Reparsed</span><strong>{packet.stats?.reparsed??"—"}</strong></div>
        <div><span>Relations</span><strong>{packet.stats?.graphEdges??"—"}</strong></div>
      </div>
    </section>

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
    <p className="context-inspector-note">This shows Trebell's own injection. An external harness may add private context of its own that Trebell cannot inspect.</p>
  </div>;
}
