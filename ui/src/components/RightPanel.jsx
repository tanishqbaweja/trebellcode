import React,{useEffect,useRef} from "react";
import { BrainCircuit, Cpu, FileCode2, FileDiff, GitBranch, Globe2, Maximize2, Minimize2, Network, Target, X } from "lucide-react";
import { useBrowserRecording } from "../browser-recording.js";

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

export default function RightPanel({active,onActive,onClose,children,disabledTabs=[],hiddenTabs=[],maximized=false,onToggleMaximized}){
  const tabScrollRef=useRef(null),recording=useBrowserRecording();
  // The active tab stays in view when the strip is narrower than its tabs (keyboard and palette switches included).
  useEffect(()=>{tabScrollRef.current?.querySelector("button.active")?.scrollIntoView?.({block:"nearest",inline:"nearest"})},[active]);
  return <aside className={"context-panel"+(maximized?" maximized":"")} data-testid="right-panel">
    <div className="context-panel-tabs">
      <div className="context-panel-tab-scroll" ref={tabScrollRef}>
        {/* A recording goes on while another tab is shown: the Browser tab says so, with a red mark, until it stops. */}
        {TABS.filter(([id])=>!hiddenTabs.includes(id)).map(([id,Icon,label])=>{const marked=id==="preview"&&recording;return <button
          key={id}
          type="button"
          className={"context-panel-tab"+(active===id?" active":"")}
          onClick={()=>onActive(id)}
          disabled={disabledTabs.includes(id)}
          aria-label={marked?label+", recording":label}
          title={marked?label+" · Recording":label}
        ><Icon size={14}/><span>{label}</span>{marked&&<i className="recording-mark" aria-hidden="true"/>}</button>})}
      </div>
      <div className="context-panel-actions">
        <button className="context-panel-close" type="button" onClick={onToggleMaximized} aria-label={maximized?"Restore right panel":"Maximize right panel"} title={maximized?"Restore panel":"Maximize panel"}>{maximized?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</button>
        <button className="context-panel-close" type="button" onClick={onClose} aria-label="Close right panel" title="Close panel"><X size={15}/></button>
      </div>
    </div>
    <div className="context-panel-body">{children}</div>
  </aside>;
}
