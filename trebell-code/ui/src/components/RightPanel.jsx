import React from "react";
import { BrainCircuit, Cpu, FileCode2, FileDiff, GitBranch, Globe2, Smartphone, Target, X } from "lucide-react";

const TABS=[
  ["files",FileCode2,"Files"],
  ["diff",FileDiff,"Diff"],
  ["preview",Globe2,"Browser"],
  ["source",GitBranch,"Git"],
  ["device",Smartphone,"Device"],
  ["agents",BrainCircuit,"Agents"],
  ["goal",Target,"Goal"],
  ["runtime",Cpu,"Runtime"],
];

export default function RightPanel({active,onActive,onClose,children,disabledTabs=[]}){
  return <aside className="context-panel" data-testid="right-panel">
    <div className="context-panel-tabs">
      <div className="context-panel-tab-scroll">
        {TABS.map(([id,Icon,label])=><button
          key={id}
          type="button"
          className={active===id?"active":""}
          onClick={()=>onActive(id)}
          disabled={disabledTabs.includes(id)}
          aria-label={label}
          title={label}
        ><Icon size={14}/><span>{label}</span></button>)}
      </div>
      <button className="context-panel-close" type="button" onClick={onClose} aria-label="Close right panel" title="Close panel"><X size={15}/></button>
    </div>
    <div className="context-panel-body">{children}</div>
  </aside>;
}
