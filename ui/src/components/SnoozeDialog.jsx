import React,{useEffect,useMemo,useRef,useState} from "react";
import { Clock3, X } from "lucide-react";
import { formatSnoozeUntil, localDateTimeValue, snoozeUntilFromDuration, timestampFromLocalDateTime } from "../thread-snooze.js";

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

// formatSnoozeUntil leaves the year out, so "1000 hours" and "1000000 hours" read the same; add it when it differs.
function wakeLabel(until){
  const date=new Date(until);
  if(date.getFullYear()===new Date().getFullYear())return formatSnoozeUntil(until);
  return date.toLocaleString(undefined,{weekday:"short",year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}

export default function SnoozeDialog({request,onSubmit,onCancel}){
  const [mode,setMode]=useState("duration");
  const [amount,setAmount]=useState(1);
  const [unit,setUnit]=useState("hours");
  const [dateTime,setDateTime]=useState(()=>localDateTimeValue(Date.now()+3_600_000));
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const amountRef=useRef(null);
  const dateRef=useRef(null);
  const formRef=useRef(null);
  useModalFocus(formRef,Boolean(request),false);
  const count=request?.threads?.length||0;
  const until=useMemo(()=>mode==="duration"?snoozeUntilFromDuration(amount,unit):timestampFromLocalDateTime(dateTime),[mode,amount,unit,dateTime]);
  useEffect(()=>{
    if(!request)return;
    const closeOnEscape=event=>{if(event.key!=="Escape")return;event.preventDefault();event.stopPropagation();onCancel?.()};
    window.addEventListener("keydown",closeOnEscape,true);
    return()=>window.removeEventListener("keydown",closeOnEscape,true);
  },[request,onCancel]);
  useEffect(()=>{if(!request)return;const t=setTimeout(()=>(mode==="duration"?amountRef:dateRef).current?.focus(),0);return()=>clearTimeout(t)},[request,mode]);
  // A new wake time is a new attempt: drop the previous failure message instead of leaving it next to a valid choice.
  useEffect(()=>{setError("")},[mode,amount,unit,dateTime]);
  if(!request)return null;
  // A wake time past the JavaScript date range would be stored but shown as "Invalid Date" in the sidebar.
  const outOfRange=Boolean(until)&&Number.isNaN(new Date(until).getTime());
  const invalid=!until||until<=Date.now()||outOfRange;
  const hint=outOfRange?"That is too far in the future. Choose an earlier time.":!until?(mode==="duration"?"Enter a duration greater than zero.":"Choose a date and time."):until<=Date.now()?"Choose a time in the future.":"Wakes "+wakeLabel(until)+".";
  async function submit(event){
    event?.preventDefault?.();
    if(invalid||busy)return;
    setBusy(true);setError("");
    try{
      await onSubmit(until);
      // App closes this dialog when the snooze succeeds (this update is then dropped with the unmount). If the dialog
      // is still open the move failed: App reports that only in the conversation behind this dialog, where nobody
      // could see it, and the dialog used to just sit there with no feedback.
      setError("Could not snooze "+(count>1?"these threads":"this thread")+". Close this dialog to see the error in the conversation, or try again.");
    }
    catch(err){setError(err?.message||String(err)||"Could not snooze.")}
    finally{setBusy(false)}
  }
  return <div className="modal-backdrop" data-testid="snooze-dialog">
    <form className="modal-card snooze-dialog" role="dialog" aria-modal="true" aria-labelledby="snooze-dialog-title" onSubmit={submit} noValidate ref={formRef} tabIndex={-1}>
      <div className="modal-head"><div><span className="modal-head-icon"><Clock3 size={16}/></span><strong id="snooze-dialog-title">Snooze {count>1?count+" threads":"thread"}</strong></div><button type="button" className="modal-close" onClick={onCancel} aria-label="Close snooze dialog"><X size={16}/></button></div>
      <p>Move {count>1?"these threads":"this thread"} out of Active until a specific time. You can wake {count>1?"them":"it"} early from the sidebar.</p>
      <div className="snooze-mode-tabs"><button type="button" className={mode==="duration"?"active":""} aria-pressed={mode==="duration"} onClick={()=>setMode("duration")}>For a duration</button><button type="button" className={mode==="datetime"?"active":""} aria-pressed={mode==="datetime"} onClick={()=>setMode("datetime")}>Until date & time</button></div>
      {mode==="duration"?<div className="snooze-duration"><label>Duration<input ref={amountRef} className="tb-input" aria-label="Snooze duration" type="number" min="1" step="1" value={amount} onChange={event=>setAmount(event.target.value)}/></label><label>Unit<select className="tb-select" aria-label="Snooze unit" value={unit} onChange={event=>setUnit(event.target.value)}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label></div>:<label>Wake at<input ref={dateRef} className="tb-input" aria-label="Snooze until" type="datetime-local" value={dateTime} min={localDateTimeValue(Date.now()+60_000)} onChange={event=>setDateTime(event.target.value)}/></label>}
      <p className={"snooze-hint"+(invalid?" invalid":"")} role="status" aria-live="polite">{hint}</p>
      {error&&<div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="tb-btn" onClick={onCancel}>Cancel</button><button type="submit" className="tb-btn tb-btn--primary primary" disabled={invalid||busy}>{busy?"Snoozing…":"Snooze"}</button></div>
    </form>
  </div>;
}
