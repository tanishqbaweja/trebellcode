import React,{useMemo,useState} from "react";
import { Clock3, X } from "lucide-react";
import { localDateTimeValue, snoozeUntilFromDuration, timestampFromLocalDateTime } from "../thread-snooze.js";

export default function SnoozeDialog({request,onSubmit,onCancel}){
  const [mode,setMode]=useState("duration");
  const [amount,setAmount]=useState(1);
  const [unit,setUnit]=useState("hours");
  const [dateTime,setDateTime]=useState(()=>localDateTimeValue(Date.now()+3_600_000));
  const count=request?.threads?.length||0;
  const until=useMemo(()=>mode==="duration"?snoozeUntilFromDuration(amount,unit):timestampFromLocalDateTime(dateTime),[mode,amount,unit,dateTime]);
  if(!request)return null;
  const invalid=!until||until<=Date.now();
  return <div className="modal-backdrop" data-testid="snooze-dialog">
    <div className="modal-card snooze-dialog">
      <div className="modal-head"><div><Clock3 size={16}/><strong>Snooze {count>1?count+" threads":"thread"}</strong></div><button onClick={onCancel} aria-label="Close snooze dialog"><X size={14}/></button></div>
      <p>Move {count>1?"these threads":"this thread"} out of Active until a specific time. You can wake {count>1?"them":"it"} early from the sidebar.</p>
      <div className="snooze-mode-tabs"><button className={mode==="duration"?"active":""} onClick={()=>setMode("duration")}>For a duration</button><button className={mode==="datetime"?"active":""} onClick={()=>setMode("datetime")}>Until date & time</button></div>
      {mode==="duration"?<div className="snooze-duration"><label>Duration<input aria-label="Snooze duration" type="number" min="1" step="1" value={amount} onChange={event=>setAmount(event.target.value)}/></label><label>Unit<select aria-label="Snooze unit" value={unit} onChange={event=>setUnit(event.target.value)}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label></div>:<label>Wake at<input aria-label="Snooze until" type="datetime-local" value={dateTime} min={localDateTimeValue(Date.now()+60_000)} onChange={event=>setDateTime(event.target.value)}/></label>}
      <div className="modal-actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={invalid} onClick={()=>onSubmit(until)}>Snooze</button></div>
    </div>
  </div>;
}
