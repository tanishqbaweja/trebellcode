import React from "react";
import { Check, FolderCode, KeyRound, ShieldCheck } from "lucide-react";
export default function OnboardingModal({open,projectPath,onPickWorkspace,providerLabel,providerReady,permissionMode,onPermissionMode,onFinish}){
  if(!open)return null;
  const workspaceName=String(projectPath||"").split(/[\\/]/).filter(Boolean).at(-1)||"No folder selected";
  return <div className="onboarding-backdrop" data-testid="onboarding"><div className="onboarding-card" role="dialog" aria-modal="true" aria-label="Set up Trebell Code">
    <div className="onboarding-brand"><img src="/trebell-code-icon.svg" alt=""/><div><h2>Set up Trebell Code</h2><p>Three basics, then get out of your way.</p></div></div>
    <div className="onboarding-steps">
      <section><span><FolderCode size={17}/></span><div><strong>1. Workspace</strong><p>{projectPath?workspaceName:"Choose the folder Trebell should work in."}</p></div><button onClick={onPickWorkspace}>{projectPath?"Change":"Choose folder"}</button></section>
      <section><span><KeyRound size={17}/></span><div><strong>2. Inference provider</strong><p>{providerLabel} · {providerReady?"ready":"setup still required"}</p></div><em className={providerReady?"ready":""}>{providerReady?<Check size={13}/>:"!"}</em></section>
      <section><span><ShieldCheck size={17}/></span><div><strong>3. Default permissions</strong><p>You can change this per task from the composer.</p></div><select value={permissionMode} onChange={e=>onPermissionMode?.(e.target.value)}><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></section>
    </div>
    <p className="onboarding-note">{providerReady?"Everything required to start is ready.":"Finish setup and Trebell will open Settings so you can connect your provider."}</p>
    <button className="onboarding-finish" onClick={()=>onFinish?.({openSettings:!providerReady})}>Finish setup</button>
  </div></div>;
}
