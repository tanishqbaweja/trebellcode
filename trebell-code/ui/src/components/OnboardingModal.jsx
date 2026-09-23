import React,{useEffect,useMemo,useState} from "react";
import { Check, FolderCode, History, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "../api.js";

function pathKey(value){
  const normalized=String(value||"").replace(/\\/g,"/").replace(/\/+$/,"");
  return /^[A-Za-z]:\//.test(normalized)?normalized.toLowerCase():normalized;
}

export default function OnboardingModal({open,projectPath,onPickWorkspace,providerLabel,providerReady,permissionMode,onPermissionMode,onHistoryImported,onFinish}){
  const [history,setHistory]=useState({sessions:[],codexImportAvailable:false});
  const [historyBusy,setHistoryBusy]=useState("");
  const [historyMessage,setHistoryMessage]=useState("");
  const workspaceName=String(projectPath||"").split(/[\\/]/).filter(Boolean).at(-1)||"No folder selected";
  const workspaceHistory=useMemo(()=>{
    const key=pathKey(projectPath);if(!key)return [];
    return (history.sessions||[]).filter(item=>pathKey(item.cwd)===key);
  },[history,projectPath]);
  const pendingHistory=workspaceHistory.filter(item=>!item.alreadyImported&&(item.source!=="codex"||history.codexImportAvailable));
  const unavailableCodex=workspaceHistory.some(item=>item.source==="codex"&&!item.alreadyImported&&!history.codexImportAvailable);
  async function scanHistory(){
    setHistoryBusy("scan");setHistoryMessage("");
    try{setHistory(await api("/api/history-import"))}
    catch(error){setHistoryMessage(error.message||String(error))}
    finally{setHistoryBusy("")}
  }
  async function importHistory(){
    if(!pendingHistory.length)return;
    setHistoryBusy("import");setHistoryMessage("");
    try{
      const result=await api("/api/history-import",{method:"POST",body:{sessionIds:pendingHistory.slice(0,50).map(item=>item.id)}});
      const imported=(result.results||[]).filter(item=>item.status==="imported").length;
      const failed=(result.results||[]).filter(item=>item.status==="error").length;
      setHistoryMessage(imported?`Imported ${imported} conversation${imported===1?"":"s"}${failed?`; ${failed} could not be imported`:""}.`:failed?"Conversation import failed.":"Nothing new to import.");
      await scanHistory();await onHistoryImported?.(result);
    }catch(error){setHistoryMessage(error.message||String(error))}
    finally{setHistoryBusy("")}
  }
  useEffect(()=>{if(open)scanHistory()},[open]);
  if(!open)return null;
  return <div className="onboarding-backdrop" data-testid="onboarding"><div className="onboarding-card" role="dialog" aria-modal="true" aria-label="Set up Trebell Code">
    <div className="onboarding-brand"><img src="/trebell-code-icon.svg" alt=""/><div><h2>Set up Trebell Code</h2><p>Four quick choices, then get out of your way.</p></div></div>
    <div className="onboarding-steps">
      <section><span><FolderCode size={17}/></span><div><strong>1. Workspace</strong><p>{projectPath?workspaceName:onPickWorkspace?"Choose the folder Trebell should work in.":"Choose or clone a project after setup."}</p></div>{onPickWorkspace?<button onClick={onPickWorkspace}>{projectPath?"Change":"Choose folder"}</button>:<span className="onboarding-static-workspace">{projectPath?"Hosted workspace":"Projects after setup"}</span>}</section>
      <section><span><KeyRound size={17}/></span><div><strong>2. Inference provider</strong><p>{providerLabel} · {providerReady?"ready":"setup still required"}</p></div><em className={providerReady?"ready":""}>{providerReady?<Check size={13}/>:"!"}</em></section>
      <section><span><ShieldCheck size={17}/></span><div><strong>3. Default permissions</strong><p>You can change this per task from the composer.</p></div><select value={permissionMode} onChange={e=>onPermissionMode?.(e.target.value)}><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></section>
      <section className="onboarding-history-step"><span><History size={17}/></span><div><strong>4. Conversation history</strong><p>{historyBusy==="scan"?"Looking for recent Codex and Claude conversations…":!projectPath?"Choose a workspace to match its history.":pendingHistory.length?`${pendingHistory.length} recent conversation${pendingHistory.length===1?"":"s"} can be copied into Trebell.`:workspaceHistory.length?"This workspace's recent conversations are already imported.":"No recent Codex or Claude history found for this workspace."}{unavailableCodex?" Codex imports need the Codex harness on Local machine.":""}</p>{historyMessage&&<small>{historyMessage}</small>}</div><button onClick={pendingHistory.length?importHistory:scanHistory} disabled={!!historyBusy}>{historyBusy==="import"?"Importing…":pendingHistory.length?"Import history":"Rescan"}</button></section>
    </div>
    <p className="onboarding-note">{providerReady?"Everything required to start is ready.":"Finish setup and Trebell will open Settings so you can connect your provider."}</p>
    <button className="onboarding-finish" onClick={()=>onFinish?.({openSettings:!providerReady})}>Finish setup</button>
  </div></div>;
}
