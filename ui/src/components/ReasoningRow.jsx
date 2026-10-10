import React,{memo,useState} from "react";
import { Brain, ChevronRight } from "lucide-react";
import { reasoningPreview } from "../reasoning-text.js";
import "./ReasoningRow.css";

// A row the person opened stays open when its finished thought moves from the live activity into the conversation.
const openRows=new Set();

// A harness's thinking as T3 Code shows it: a quiet "Thinking" line with the thought's latest line while it streams ("Thought"
// and its first line once done), which opens to the whole text. messageId marks a conversation row (scroll anchors, find).
const ReasoningRow=memo(function ReasoningRow({id,messageId,text="",active=false}){
  const key=String(id||""),body=String(text||"").trim(),[open,setOpen]=useState(()=>openRows.has(key));
  const line=reasoningPreview(body,{latest:active});
  const toggle=()=>{const next=!open;if(next)openRows.add(key);else openRows.delete(key);setOpen(next)};
  return <div className={"reasoning-row"+(active?" active":"")+(open?" open":"")} data-message-id={messageId||undefined} data-testid="reasoning-row">
    <button type="button" className="reasoning-toggle" aria-expanded={open} disabled={!body} onClick={toggle} title={body?(open?"Hide thinking":"Show thinking"):undefined}>
      <span className="reasoning-icon"><Brain size={13} aria-hidden="true"/></span>
      <span className="reasoning-label">{active?"Thinking":"Thought"}</span>
      <span className="reasoning-preview">{open?"":line}</span>
      {body&&<ChevronRight className="reasoning-chevron" size={13} aria-hidden="true"/>}
    </button>
    {open&&body&&<div className="reasoning-text" data-testid="reasoning-text">{body}</div>}
  </div>;
});

export default ReasoningRow;
