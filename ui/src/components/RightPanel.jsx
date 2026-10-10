import React,{useEffect,useRef} from "react";
import { BrainCircuit, Cpu, FileCode2, FileDiff, GitBranch, Globe2, Maximize2, Minimize2, Network, Target, X } from "lucide-react";

const TABS=[
  ["files",FileCode2,"Files"],
  ["diff",FileDiff,"Diff"],
  ["context",Network,"Context"],
  ["preview",Globe2,"Browser"],
  ["source",GitBranch,"Git"],
  ["agents",BrainCircuit,"Agents"],
  ["goal",Target,"Goal"],
  ["runtime",Cpu,"Runtime"],
];

// Asks for one line of text, like window.prompt: resolves to the text (possibly empty) on OK and to null on Cancel or Escape.
// Electron's renderer throws on window.prompt ("prompt() is not supported"), which left Create branch, Add worktree, Publish,
// PR edits and review comments doing nothing in the desktop app; there a small in-app dialog asks instead, while browsers keep
// the native prompt. A click outside the dialog does not cancel it, so a double click on the opening button cannot dismiss it.
export function askText(message,defaultValue=""){
  try{return Promise.resolve(window.prompt(message,defaultValue))}
  catch{return askTextInApp(message,defaultValue)}
}

function askTextInApp(message,defaultValue){
  return new Promise(resolve=>{
    const opener=document.activeElement;
    const dialog=document.createElement("dialog");
    dialog.className="inspector-text-prompt";
    const form=document.createElement("form");
    const label=document.createElement("label");
    const text=document.createElement("span");text.textContent=message;
    text.id="inspector-text-prompt-"+Math.random().toString(36).slice(2);dialog.setAttribute("aria-labelledby",text.id);
    const input=document.createElement("input");
    Object.assign(input,{type:"text",value:defaultValue??"",autocomplete:"off",spellcheck:false});
    label.append(text,input);
    const actions=document.createElement("div");actions.className="inspector-text-prompt-actions";
    const cancel=document.createElement("button");Object.assign(cancel,{type:"button",textContent:"Cancel"});
    const ok=document.createElement("button");Object.assign(ok,{type:"submit",textContent:"OK",className:"primary"});
    actions.append(cancel,ok);form.append(label,actions);dialog.append(form);
    let settled=false;
    const finish=value=>{
      if(settled)return;settled=true;
      if(dialog.open)dialog.close();dialog.remove();
      try{if(opener?.isConnected)opener.focus()}catch{}
      resolve(value);
    };
    form.addEventListener("submit",event=>{event.preventDefault();finish(input.value)});
    cancel.addEventListener("click",()=>finish(null));
    dialog.addEventListener("cancel",event=>{event.preventDefault();finish(null)});
    document.body.append(dialog);
    dialog.showModal();input.focus();input.select();
  });
}

export default function RightPanel({active,onActive,onClose,children,disabledTabs=[],hiddenTabs=[],maximized=false,onToggleMaximized}){
  const tabScrollRef=useRef(null);
  // The active tab stays in view when the strip is narrower than its tabs (keyboard and palette switches included).
  useEffect(()=>{tabScrollRef.current?.querySelector("button.active")?.scrollIntoView?.({block:"nearest",inline:"nearest"})},[active]);
  return <aside className={"context-panel"+(maximized?" maximized":"")} data-testid="right-panel">
    <div className="context-panel-tabs">
      <div className="context-panel-tab-scroll" ref={tabScrollRef}>
        {TABS.filter(([id])=>!hiddenTabs.includes(id)).map(([id,Icon,label])=><button
          key={id}
          type="button"
          className={"context-panel-tab"+(active===id?" active":"")}
          onClick={()=>onActive(id)}
          disabled={disabledTabs.includes(id)}
          aria-label={label}
          title={label}
        ><Icon size={14}/><span>{label}</span></button>)}
      </div>
      <div className="context-panel-actions">
        <button className="context-panel-close" type="button" onClick={onToggleMaximized} aria-label={maximized?"Restore right panel":"Maximize right panel"} title={maximized?"Restore panel":"Maximize panel"}>{maximized?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</button>
        <button className="context-panel-close" type="button" onClick={onClose} aria-label="Close right panel" title="Close panel"><X size={15}/></button>
      </div>
    </div>
    <div className="context-panel-body">{children}</div>
  </aside>;
}
