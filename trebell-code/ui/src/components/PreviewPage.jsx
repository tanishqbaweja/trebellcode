import React,{useState} from "react";
import { ExternalLink, Globe2, RefreshCw, Camera, MousePointer2, Eye, X } from "lucide-react";

export default function PreviewPage({onAttachText,onAttachImage}){
  const [draft,setDraft]=useState("http://localhost:3000");
  const [url,setUrl]=useState("");
  const [key,setKey]=useState(0);
  const [snapshot,setSnapshot]=useState(null);
  const [busy,setBusy]=useState("");
  const [selectedRef,setSelectedRef]=useState(null);
  const [annotation,setAnnotation]=useState("");
  const [lastAttached,setLastAttached]=useState("");

  function normalized(){let next=draft.trim();if(next&&!/^https?:\/\//i.test(next))next="http://"+next;return next}
  function go(){setUrl(normalized())}
  async function agentOpen(){
    const next=normalized();if(!next)return;setBusy("open");
    try{await window.trebellDesktop?.browser?.navigate?.(next);setUrl(next);setSnapshot(await window.trebellDesktop?.browser?.snapshot?.())}finally{setBusy("")}
  }
  async function inspect(){setBusy("inspect");try{const next=await window.trebellDesktop?.browser?.snapshot?.();setSnapshot(next);if(selectedRef&&!next?.elements?.some(el=>el.ref===selectedRef))setSelectedRef(null)}finally{setBusy("")}}
  async function capture(){setBusy("capture");try{const shot=await window.trebellDesktop?.browser?.screenshot?.();if(shot?.dataUrl)await onAttachImage?.(shot.dataUrl)}finally{setBusy("")}}
  async function attachElement(element,note=""){
    const cleanNote=String(note||"").trim();
    const lines=["Browser element context","URL: "+(snapshot?.url||url),"Title: "+(snapshot?.title||""),"Element ref: "+element.ref,"Tag: "+element.tag,"Text: "+(element.text||""),"Href: "+(element.href||"")];
    if(cleanNote)lines.push("","Annotation: "+cleanNote);
    await onAttachText?.((cleanNote?"browser-annotation-":"browser-element-")+element.ref+".txt",lines.join("\n"),{kind:"browser",label:(cleanNote?"Annotated ":"Browser ")+element.ref,detail:cleanNote||(element.text||element.tag||"").slice(0,70)});
    setLastAttached(cleanNote?"Annotation attached":"Element context attached");
  }
  const selectedElement=(snapshot?.elements||[]).find(el=>el.ref===selectedRef)||null;
  return <div className="preview-page">
    <div className="preview-bar"><Globe2 size={15}/><input value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="http://localhost:3000"/><button onClick={go}>Preview</button><button onClick={()=>setKey(k=>k+1)}><RefreshCw size={13}/></button>{url&&<button onClick={()=>window.open(url,"_blank")}><ExternalLink size={13}/></button>}</div>
    <div className="agent-browser-toolbar"><button onClick={agentOpen} disabled={!!busy}><Globe2 size={13}/> Open agent browser</button><button onClick={()=>window.trebellDesktop?.browser?.show?.()}><Eye size={13}/> Show browser</button><button onClick={inspect} disabled={!!busy}><MousePointer2 size={13}/> Inspect elements</button><button onClick={capture} disabled={!!busy}><Camera size={13}/> Attach screenshot</button><button onClick={()=>{window.trebellDesktop?.browser?.close?.();setSnapshot(null);setSelectedRef(null);setAnnotation("");setLastAttached("")}}><X size={13}/> Close</button></div>
    <div className="preview-layout"><div className="preview-frame">{url?<iframe key={key} title="Trebell preview" src={url}/>:<div className="empty-state">Enter a local or web URL to preview it.</div>}</div>
      <aside className="browser-inspector"><h3>Agent browser</h3>{snapshot?<><p><strong>{snapshot.title||"Untitled"}</strong><span>{snapshot.url}</span></p><div className="browser-elements">{(snapshot.elements||[]).map(el=><button className={selectedRef===el.ref?"active":""} key={el.ref} onClick={()=>{setSelectedRef(el.ref);setLastAttached("")}}><code>{el.ref}</code><span>{el.text||el.tag}</span><small>{el.tag}{el.href?" · link":""}</small></button>)}</div>{selectedElement&&<div className="browser-annotation" data-testid="preview-annotation"><div><strong>Annotate {selectedElement.ref}</strong><span>{selectedElement.text||selectedElement.tag}</span></div><textarea value={annotation} onChange={e=>setAnnotation(e.target.value)} placeholder="Add a note or instruction for the agent about this element…"/><div className="annotation-actions"><button onClick={()=>attachElement(selectedElement)}>Attach context</button><button className="primary" disabled={!annotation.trim()} onClick={async()=>{await attachElement(selectedElement,annotation);setAnnotation("")}}>Attach annotation</button>{lastAttached&&<span>{lastAttached}</span>}</div></div>}</>:<div className="empty-inspector">Open the agent browser and inspect the page to see model-addressable elements.</div>}</aside>
    </div>
    <p className="preview-note">The iframe is visual preview. The isolated Electron Agent Browser is what the Freebuff-backed Codex agent can inspect and control.</p>
  </div>;
}
