import React,{useEffect,useMemo,useRef,useState} from "react";
import { Check, FolderCode, History, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "../api.js";

// Modal focus: move focus into the dialog when it opens and keep Tab/Shift+Tab inside it, so keyboard users cannot
// reach (and activate) controls behind the backdrop. Focus that sits inside another open modal is left alone.
function useModalFocus(ref,active,focusOnOpen=true){
  useEffect(()=>{
    const node=ref.current;if(!active||!node)return;
    if(focusOnOpen&&!node.contains(document.activeElement))node.focus({preventScroll:true});
    const onKey=event=>{
      if(event.key!=="Tab"||event.defaultPrevented)return;
      const current=document.activeElement,owner=current?.closest?.('[aria-modal="true"]');
      if(owner&&owner!==node)return;
      const items=[...node.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")].filter(item=>item.tabIndex>=0&&!item.disabled&&item.getClientRects().length);
      if(!items.length){event.preventDefault();node.focus();return}
      const first=items[0],last=items[items.length-1];
      if(!node.contains(current)||current===node){event.preventDefault();(event.shiftKey?last:first).focus()}
      else if(event.shiftKey&&current===first){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&current===last){event.preventDefault();first.focus()}
    };
    document.addEventListener("keydown",onKey,true);
    return()=>document.removeEventListener("keydown",onKey,true);
  },[ref,active,focusOnOpen]);
}

function pathKey(value){
  const normalized=String(value||"").replace(/\\/g,"/").replace(/\/+$/,"");
  return /^[A-Za-z]:\//.test(normalized)?normalized.toLowerCase():normalized;
}

export default function OnboardingModal({open,projectPath,onPickWorkspace,providerLabel,providerReady,permissionMode,onPermissionMode,onHistoryImported,onFinish}){
  const [history,setHistory]=useState({sessions:[],codexImportAvailable:false});
  const [historyBusy,setHistoryBusy]=useState("");
  const [historyMessage,setHistoryMessage]=useState("");
  const [historyFailed,setHistoryFailed]=useState(false);
  const [actionBusy,setActionBusy]=useState("");
  const cardRef=useRef(null);
  useModalFocus(cardRef,open);
  const [actionError,setActionError]=useState("");
  const workspaceName=String(projectPath||"").split(/[\\/]/).filter(Boolean).at(-1)||"No folder selected";
  const workspaceHistory=useMemo(()=>{
    const key=pathKey(projectPath);if(!key)return [];
    return (history.sessions||[]).filter(item=>pathKey(item.cwd)===key);
  },[history,projectPath]);
  const pendingHistory=workspaceHistory.filter(item=>!item.alreadyImported&&(item.source!=="codex"||history.codexImportAvailable));
  const unavailableCodex=workspaceHistory.some(item=>item.source==="codex"&&!item.alreadyImported&&!history.codexImportAvailable);
  function showHistoryMessage(text,failed=false){setHistoryMessage(text);setHistoryFailed(failed)}
  async function scanHistory(){
    setHistoryBusy("scan");showHistoryMessage("");
    try{setHistory(await api("/api/history-import"));return true}
    catch(error){showHistoryMessage(error.message||String(error),true);return false}
    finally{setHistoryBusy("")}
  }
  async function importHistory(){
    if(!pendingHistory.length)return;
    setHistoryBusy("import");showHistoryMessage("");
    try{
      const result=await api("/api/history-import",{method:"POST",body:{sessionIds:pendingHistory.slice(0,50).map(item=>item.id)}});
      const imported=(result.results||[]).filter(item=>item.status==="imported").length;
      const failed=(result.results||[]).filter(item=>item.status==="error").length;
      const summary=imported?`Imported ${imported} conversation${imported===1?"":"s"}${failed?`; ${failed} could not be imported`:""}.`:failed?"Conversation import failed.":"Nothing new to import.";
      // The rescan clears the message when it starts, so show the import summary after it (it used to be wiped
      // immediately, leaving no feedback about what was imported or what failed).
      if(await scanHistory())showHistoryMessage(summary,!imported&&failed>0);
      else setHistoryMessage(current=>summary+" "+current);
      await onHistoryImported?.(result);
    }catch(error){showHistoryMessage(error.message||String(error),true)}
    finally{setHistoryBusy("")}
  }
  async function chooseWorkspace(){
    if(!onPickWorkspace||actionBusy)return;
    setActionBusy("workspace");setActionError("");
    try{await onPickWorkspace()}
    catch(error){setActionError(error?.message||String(error)||"Could not choose workspace.")}
    finally{setActionBusy("")}
  }
  async function finish(){
    if(!onFinish||actionBusy)return;
    setActionBusy("finish");setActionError("");
    try{await onFinish({openSettings:!providerReady})}
    catch(error){setActionError(error?.message||String(error)||"Could not finish setup.")}
    finally{setActionBusy("")}
  }
  useEffect(()=>{if(open)scanHistory()},[open]);
  if(!open)return null;
  return <div className="onboarding-backdrop" data-testid="onboarding"><div className="onboarding-card" role="dialog" aria-modal="true" aria-label="Set up Trebell Code" ref={cardRef} tabIndex={-1}>
    <div className="onboarding-brand"><span className="onboarding-mark"><img src="/trebell-code-icon.svg" alt=""/></span><div><h2>Set up Trebell Code</h2><p>Four quick choices, then get out of your way.</p></div></div>
    <div className="onboarding-steps">
      <section><span className="onboarding-step-icon"><FolderCode size={16}/></span><div><strong>1. Workspace</strong><p>{projectPath?workspaceName:onPickWorkspace?"Choose the folder Trebell should work in.":"Choose or clone a project after setup."}</p></div>{onPickWorkspace?<button className="tb-btn tb-btn--sm onboarding-step-action" onClick={chooseWorkspace} disabled={!!actionBusy}>{actionBusy==="workspace"?"Choosing…":projectPath?"Change":"Choose folder"}</button>:<span className="onboarding-static-workspace">{projectPath?"Hosted workspace":"Projects after setup"}</span>}</section>
      <section><span className="onboarding-step-icon"><KeyRound size={16}/></span><div><strong>2. Inference provider</strong><p>{providerLabel} · {providerReady?"ready":"setup still required"}</p></div><em className={"onboarding-step-status"+(providerReady?" ready":"")} aria-hidden="true">{providerReady?<Check size={13}/>:"!"}</em></section>
      <section><span className="onboarding-step-icon"><ShieldCheck size={16}/></span><div><strong>3. Default permissions</strong><p>You can change this per task from the composer.</p></div><select className="tb-select onboarding-permission-select" aria-label="Default permissions" value={permissionMode} onChange={e=>onPermissionMode?.(e.target.value)}><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></section>
      <section className="onboarding-history-step"><span className="onboarding-step-icon"><History size={16}/></span><div><strong>4. Conversation history</strong><p>{historyBusy==="scan"?"Looking for recent Codex and Claude conversations…":!projectPath?"Choose a workspace to match its history.":pendingHistory.length?`${pendingHistory.length} recent conversation${pendingHistory.length===1?"":"s"} can be copied into Trebell.`:workspaceHistory.length?"This workspace's recent conversations are already imported.":"No recent Codex or Claude history found for this workspace."}{unavailableCodex?" Codex imports need the Codex harness on Local machine.":""}</p>{historyMessage&&<small className={"onboarding-history-message"+(historyFailed?" error":"")} role="status">{historyMessage}</small>}</div><button className="tb-btn tb-btn--sm onboarding-step-action" onClick={pendingHistory.length?importHistory:scanHistory} disabled={!!historyBusy}>{historyBusy==="import"?"Importing…":pendingHistory.length?"Import history":"Rescan"}</button></section>
    </div>
    {actionError&&<p className="onboarding-action-error" role="alert">{actionError}</p>}
    <p className={"onboarding-note"+(providerReady?" ready":"")}>{providerReady?"Everything required to start is ready.":"Finish setup and Trebell will open Settings so you can connect your provider."}</p>
    <button className="tb-btn tb-btn--primary onboarding-finish" onClick={finish} disabled={!!actionBusy}>{actionBusy==="finish"?"Finishing…":"Finish setup"}</button>
  </div></div>;
}
