import React from "react";
import { CheckCircle2, CircleAlert, GitBranch, LoaderCircle, SquareTerminal, X } from "lucide-react";

export default function WorktreeSetupCard({setup,onOpenTerminal,onDismiss}){
  if(!setup)return null;
  const phase=setup.phase||"creating";
  const live=phase==="creating"||phase==="running";
  return <section className={"worktree-setup-card "+phase}>
    <div className="worktree-setup-icon">
      {phase==="failed"?<CircleAlert size={17}/>:phase==="done"?<CheckCircle2 size={17}/>:<LoaderCircle className="spin" size={17}/>}
    </div>
    <div className="worktree-setup-copy">
      <strong>{phase==="creating"?"Creating worktree":phase==="running"?"Setting up worktree":phase==="failed"?"Worktree setup failed":"Worktree ready"}</strong>
      <span><GitBranch size={11}/>{setup.branch||"new branch"}{setup.scriptName?" · "+setup.scriptName:""}</span>
      {setup.detail&&<small>{setup.detail}</small>}
      {!setup.detail&&setup.path&&<small>{setup.path}</small>}
    </div>
    <div className="worktree-setup-actions">
      {setup.sessionId&&<button onClick={onOpenTerminal}><SquareTerminal size={12}/> Terminal</button>}
      {!live&&<button className="icon" onClick={onDismiss} aria-label="Dismiss worktree setup"><X size={12}/></button>}
    </div>
  </section>;
}
