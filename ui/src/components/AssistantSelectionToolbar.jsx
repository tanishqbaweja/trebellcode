import React,{useEffect,useRef,useState} from "react";
import { Quote } from "lucide-react";
import { focusBesideSelection } from "../selection-focus.js";

export const MAX_ASSISTANT_CITATION_CHARS=8_000;

function citationSource(node,container){
  if(!node||!container)return null;
  const element=node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;
  const source=element?.closest?.("[data-assistant-citation-source]")||null;
  return source&&container.contains(source)?source:null;
}

export default function AssistantSelectionToolbar({containerRef,onCite}){
  const [selection,setSelection]=useState(null);
  const [busy,setBusy]=useState(false);
  const button=useRef(null);

  useEffect(()=>{
    const container=containerRef.current;
    if(!container)return;
    let frame=0;
    const scrollHost=container.closest(".conversation-scroll");
    const clear=()=>setSelection(null);
    const update=()=>{
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(()=>{
        const nativeSelection=window.getSelection();
        if(!nativeSelection||nativeSelection.isCollapsed||nativeSelection.rangeCount===0){clear();return}
        const range=nativeSelection.getRangeAt(0);
        const start=citationSource(range.startContainer,container);
        if(!start){clear();return}
        // A selection that takes nothing beyond the reply it starts in is the reply's, as a triple-click on its last paragraph,
        // which ends at the start of what follows the reply (its outcome pill). One that ends in the reply leaves nothing beyond.
        const beyond=range.cloneRange();beyond.setStart(start,start.childNodes.length);
        if(beyond.toString().trim()){clear();return}
        const text=nativeSelection.toString().trim();
        if(!text){clear();return}
        const rect=range.getBoundingClientRect();
        if(!rect.width&&!rect.height){clear();return}
        // Keep the button inside the visible conversation: a selection that starts above the fold would otherwise
        // pin it to the window top, on top of the header controls.
        const host=(scrollHost||container).getBoundingClientRect();
        const top=Math.max(0,host.top),bottom=Math.min(window.innerHeight,host.bottom);
        const x=Math.max(54,Math.min(window.innerWidth-54,rect.left+rect.width/2));
        const y=Math.max(top+38,Math.min(bottom-8,rect.top-7));
        setSelection({messageId:start.dataset.assistantCitationSource,text,x,y});
      });
    };
    // Tab and Shift+Tab from the selection (nothing else has the keyboard) reach Cite above it, whichever reply it is in, and from Cite
    // go on beside the selection (focusBesideSelection): in the page's order Cite comes after the conversation's last message, so it
    // is no stop in that order. Not while Cite is off (too long, citing) or gone (Escape).
    const onKey=event=>{
      if(event.key==="Escape")clear();
      else if(event.key==="Tab"&&button.current&&document.activeElement===button.current){if(focusBesideSelection(button.current,event.shiftKey))event.preventDefault()}
      else if(event.key==="Tab"&&document.activeElement?.contains(window.getSelection()?.anchorNode)){button.current?.focus();if(document.activeElement===button.current)event.preventDefault()}
    };
    document.addEventListener("selectionchange",update);
    container.addEventListener("pointerup",update);
    document.addEventListener("keydown",onKey,true);
    scrollHost?.addEventListener("scroll",clear,{passive:true});
    window.addEventListener("resize",clear);
    // App loads this at idle after the first paint (idle-parts.js): text selected in a reply before it came gets its button now.
    update();
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
    ref={button}
    type="button"
    tabIndex={-1}
    className="assistant-selection-cite"
    data-testid="assistant-selection-cite"
    style={{left:selection.x,top:selection.y}}
    disabled={tooLong||busy}
    aria-label={tooLong?"Selection is too long to cite":busy?"Citing selected assistant text":"Cite selected assistant text"}
    title={tooLong?`Select ${MAX_ASSISTANT_CITATION_CHARS.toLocaleString()} characters or fewer`:"Cite selected assistant text"}
    onPointerDown={event=>event.preventDefault()}
    onClick={async()=>{
      if(tooLong||busy)return;
      setBusy(true);
      try{
        const cited=await onCite?.(selection);
        if(cited!==true)return;
        window.getSelection()?.removeAllRanges();
        setSelection(null);
      }finally{setBusy(false)}
    }}
  ><Quote size={13}/>{tooLong?"Shorten selection":busy?"Citing…":"Cite"}</button>;
}
