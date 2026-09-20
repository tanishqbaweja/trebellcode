import React,{useState} from "react";
import { ExternalLink, Globe2, RefreshCw } from "lucide-react";

export default function PreviewPage(){
  const [draft,setDraft]=useState("http://localhost:3000");
  const [url,setUrl]=useState("");
  const [key,setKey]=useState(0);
  function go(){let next=draft.trim();if(next&&!/^https?:\/\//i.test(next))next="http://"+next;setUrl(next)}
  return <div className="preview-page"><div className="preview-bar"><Globe2 size={15}/><input value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="http://localhost:3000"/><button onClick={go}>Go</button><button onClick={()=>setKey(k=>k+1)}><RefreshCw size={13}/></button>{url&&<button onClick={()=>window.open(url,"_blank")}><ExternalLink size={13}/></button>}</div>{url?<iframe key={key} title="Trebell preview" src={url}/>:<div className="empty-state">Enter a local or web URL to preview it.</div>}<p className="preview-note">Some sites block iframe embedding. Use the external-open button when they do.</p></div>;
}
