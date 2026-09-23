import React,{useEffect,useState} from "react";
import { Quote } from "lucide-react";

export const MAX_ASSISTANT_CITATION_CHARS=8_000;

function citationSource(node,container){
  if(!node||!container)return null;
  const element=node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;
  const source=element?.closest?.("[data-assistant-citation-source]")||null;
  return source&&container.contains(source)?source:null;
}

export default function AssistantSelectionToolbar({containerRef,onCite}){
  const [selection,setSelection]=useState(null);

  useEffect(()=>{
    const container=containerRef.current;
    if(!container)return;
    let frame=0;
    const clear=()=>setSelection(null);
    const update=()=>{
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(()=>{
        const nativeSelection=window.getSelection();
        if(!nativeSelection||nativeSelection.isCollapsed||nativeSelection.rangeCount===0){clear();return}
        const range=nativeSelection.getRangeAt(0);
        const start=citationSource(range.startContainer,container);
        const end=citationSource(range.endContainer,container);
        if(!start||start!==end){clear();return}
        const text=nativeSelection.toString().trim();
        if(!text){clear();return}
        const rect=range.getBoundingClientRect();
        if(!rect.width&&!rect.height){clear();return}
        const x=Math.max(54,Math.min(window.innerWidth-54,rect.left+rect.width/2));
        const y=Math.max(38,Math.min(window.innerHeight-8,rect.top-7));
        setSelection({messageId:start.dataset.assistantCitationSource,text,x,y});
      });
    };
    const onKey=event=>{if(event.key==="Escape")clear()};
    const scrollHost=container.closest(".conversation-scroll");
    document.addEventListener("selectionchange",update);
    container.addEventListener("pointerup",update);
    document.addEventListener("keydown",onKey,true);
    scrollHost?.addEventListener("scroll",clear,{passive:true});
    window.addEventListener("resize",clear);
    return()=>{
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange",update);
      container.removeEventListener("pointerup",update);
      document.removeEventListener("keydown",onKey,true);
      scrollHost?.removeEventListener("scroll",clear);
      window.removeEventListener("resize",clear);
    };
  },[containerRef]);

  if(!selection)return null;
  const tooLong=selection.text.length>MAX_ASSISTANT_CITATION_CHARS;
  return <button
    type="button"
    className="assistant-selection-cite"
    data-testid="assistant-selection-cite"
    style={{left:selection.x,top:selection.y}}
    disabled={tooLong}
    aria-label={tooLong?"Selection is too long to cite":"Cite selected assistant text"}
    title={tooLong?`Select ${MAX_ASSISTANT_CITATION_CHARS.toLocaleString()} characters or fewer`:"Cite selected assistant text"}
    onPointerDown={event=>event.preventDefault()}
    onClick={()=>{
      if(tooLong)return;
      onCite?.(selection);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    }}
  ><Quote size={13}/>{tooLong?"Shorten selection":"Cite"}</button>;
}
