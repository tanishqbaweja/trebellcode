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
// Text that may hold line breaks (`multiline`: a description, a comment) is always asked in the dialog, in a box where Enter adds a
// line and Ctrl+Enter gives OK: a one-line field drops the breaks, so a description came back as one run-on paragraph.
export function askText(message,defaultValue="",{multiline=false}={}){
  if(multiline)return askTextInApp(message,defaultValue,true);
  try{return Promise.resolve(window.prompt(message,defaultValue))}
  catch{return askTextInApp(message,defaultValue,false)}
}

function askTextInApp(message,defaultValue,multiline){
  return new Promise(resolve=>{
    const opener=document.activeElement;
    const dialog=document.createElement("dialog");
    dialog.className="inspector-text-prompt"+(multiline?" multiline":"");
    const form=document.createElement("form");
    const label=document.createElement("label");
    const text=document.createElement("span");text.textContent=message;
    text.id="inspector-text-prompt-"+Math.random().toString(36).slice(2);dialog.setAttribute("aria-labelledby",text.id);
    const input=document.createElement(multiline?"textarea":"input");
    Object.assign(input,{value:defaultValue??"",autocomplete:"off",spellcheck:multiline});if(!multiline)input.type="text";
    label.append(text,input);
    const actions=document.createElement("div");actions.className="inspector-text-prompt-actions";
    const cancel=document.createElement("button");Object.assign(cancel,{type:"button",textContent:"Cancel"});
    const ok=document.createElement("button");Object.assign(ok,{type:"submit",textContent:"OK",className:"primary"});
    if(multiline){const hint=document.createElement("small");hint.textContent="Ctrl+Enter for OK";actions.append(hint)}
    actions.append(cancel,ok);form.append(label,actions);dialog.append(form);
    let settled=false;
    const finish=value=>{
      if(settled)return;settled=true;
      if(dialog.open)dialog.close();dialog.remove();
      try{if(opener?.isConnected)opener.focus()}catch{}
      resolve(value);
    };
    // The box reads Windows line ends as "\n": text left as it was comes back exactly as given, so a caller can tell it is unchanged.
    const original=String(defaultValue??"");
    form.addEventListener("submit",event=>{event.preventDefault();finish(input.value===original.replace(/\r\n?/g,"\n")?original:input.value)});
    if(multiline)input.addEventListener("keydown",event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){event.preventDefault();form.requestSubmit()}});
    cancel.addEventListener("click",()=>finish(null));
    dialog.addEventListener("cancel",event=>{event.preventDefault();finish(null)});
    document.body.append(dialog);
    // A long text opens with the caret after it, ready to add to; one line opens selected, as window.prompt does.
    dialog.showModal();input.focus();if(multiline)input.setSelectionRange(input.value.length,input.value.length);else input.select();
  });
}

// Asks before something is dropped, in the same dialog with no field: resolves to true on the `confirm` button and to false on the
// `cancel` one or Escape. It opens with focus on `cancel`, so Enter keeps things as they are.
export function askConfirm(message,{confirm,cancel}){
  return new Promise(resolve=>{
    const opener=document.activeElement;
    const dialog=document.createElement("dialog");
    dialog.className="inspector-text-prompt";
    const form=document.createElement("form");
    const text=document.createElement("p");text.textContent=message;
    text.id="inspector-text-prompt-"+Math.random().toString(36).slice(2);dialog.setAttribute("aria-labelledby",text.id);
    const actions=document.createElement("div");actions.className="inspector-text-prompt-actions";
    const keep=document.createElement("button");Object.assign(keep,{type:"button",textContent:cancel});
    const drop=document.createElement("button");Object.assign(drop,{type:"button",textContent:confirm,className:"danger"});
    actions.append(keep,drop);form.append(text,actions);dialog.append(form);
    const finish=value=>{
      if(!dialog.isConnected)return;
      dialog.close();dialog.remove();
      try{if(opener?.isConnected)opener.focus()}catch{}
      resolve(value);
    };
    form.addEventListener("submit",event=>event.preventDefault());
    keep.addEventListener("click",()=>finish(false));
    drop.addEventListener("click",()=>finish(true));
    dialog.addEventListener("cancel",event=>{event.preventDefault();finish(false)});
    document.body.append(dialog);
    dialog.showModal();keep.focus();
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
