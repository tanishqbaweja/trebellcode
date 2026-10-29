import React,{memo,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from "react";
import { Check, ChevronDown, FileDiff, ListTodo, RefreshCw, Sparkles, SquareTerminal, X, Zap } from "lucide-react";
import ReasoningRow from "./ReasoningRow.jsx";
import { activityWindow, nextActivityWindowEnd, previousActivityWindowEnd } from "../activity-window.js";
import { commandFacts, commandLine, fileChangeRows, nativeEditChanges, turnDiffLines } from "../activity-details.js";
import { reasoningItemText } from "../reasoning-text.js";
import { toolEventFailed } from "../tool-event-status.js";
import { activitySummary } from "../turn-activity.js";
import { turnInfoKey } from "../turn-outcome.js";

// Whether the person opened or closed a turn's card, by thread and turn. The live and the past card of a turn share the choice,
// so it holds when the turn ends and when the thread opens again in this window; past 500 choices the oldest is dropped.
const openCards=new Map(),OPEN_CARDS_LIMIT=500;
function rememberCardOpen(key,open){
  openCards.delete(key);openCards.set(key,open);
  if(openCards.size>OPEN_CARDS_LIMIT)openCards.delete(openCards.keys().next().value);
}

// A turn's activity: a head that names it and counts its steps (and the failed ones), which opens and closes the steps. The live
// card (ActivityTimeline) lists the turn's notices and thinking too and streams command output and MCP progress into its rows; a
// past card lists the steps its turn stored (turn-activity.js), with no "Inspect changes", since today's workspace diff is not that
// turn's. Closed, a card is its head alone. onToggleLayout(head, toggle) keeps the head where it was clicked: it runs the toggle
// and returns what settles the scroll once the card has its new size.
const TurnActivityCard=memo(function TurnActivityCard({threadId,turnId,rows,live=false,defaultOpen=false,complete=true,onToggleLayout=null,onInspectChanges=null,commandOutputs=null,mcpProgress=null}){
  const key=turnInfoKey(threadId,turnId),bodyId="activity-steps-"+useId().replace(/[^A-Za-z0-9_-]/g,"");
  // choice: the person's last click here; one made while the card had no turn (a send waiting for its turn to start) becomes that
  // turn's once it starts.
  const [choice,setChoice]=useState(null),[windowEnd,setWindowEnd]=useState(null),headRef=useRef(null),settleRef=useRef(null);
  const steps=Array.isArray(rows)?rows:[],open=key&&openCards.has(key)?openCards.get(key):choice&&(choice.key===key||!choice.key)?choice.open:Boolean(defaultOpen);
  const summary=useMemo(()=>activitySummary(steps,{complete:live||complete}),[steps,live,complete]);
  useEffect(()=>{if(key&&choice&&!choice.key){rememberCardOpen(key,choice.open);setChoice({key,open:choice.open})}},[key,choice]);
  useEffect(()=>{
    if(windowEnd==null)return;
    if(!steps.length){setWindowEnd(null);return}
    if(windowEnd>steps.length)setWindowEnd(steps.length);
  },[steps.length,windowEnd]);
  useLayoutEffect(()=>{const settle=settleRef.current;settleRef.current=null;settle?.()},[open]);
  const toggle=()=>{
    const next=!open,run=()=>{if(key)rememberCardOpen(key,next);setChoice({key,open:next})};
    if(onToggleLayout&&headRef.current){const settle=onToggleLayout(headRef.current,run);settleRef.current=typeof settle==="function"?settle:null}
    else run();
  };
  const visible=open?activityWindow(steps,{end:windowEnd}):null;
  return <div className={"activity-card"+(open?"":" closed")} data-testid="activity-card" data-turn-id={turnId==null?undefined:String(turnId)} data-state={open?"open":"closed"}>
    <button type="button" ref={headRef} className="activity-card-head" aria-expanded={open} aria-controls={open?bodyId:undefined} onClick={toggle}>
      <span className="agent-star"><Sparkles size={13} aria-hidden="true"/></span><span className="activity-card-label">Trebell agent activity</span>
      <span className="activity-card-meta"><span className="activity-card-summary" title={summary.text}>{summary.text}</span>{summary.failed>0&&<em className="activity-card-failed">{summary.failed.toLocaleString("en-US")} failed</em>}<ChevronDown className="activity-card-chevron" size={13} aria-hidden="true"/></span>
    </button>
    {visible&&<div className="timeline" id={bodyId}>
      {steps.length>visible.size&&<div className="timeline-window-controls"><span>{visible.start+1}–{visible.end} of {visible.total}</span><div><button disabled={!visible.hasOlder} onClick={()=>setWindowEnd(previousActivityWindowEnd(visible))}>Earlier</button><button disabled={!visible.hasNewer} onClick={()=>setWindowEnd(nextActivityWindowEnd(visible))}>Newer</button>{!visible.latest&&<button onClick={()=>setWindowEnd(null)}>Latest</button>}</div></div>}
      {visible.items.map(event=>{
        const id=String(event.id),streamedOutput=commandOutputs?.get(id)||"",progress=mcpProgress?.get(id);
        if(event.kind==="reasoning")return <ReasoningRow key={event.id} id={id} text={streamedOutput||reasoningItemText(event.raw)} active={event.status==="running"}/>;
        // The streamed output shows once it goes on from the row's own: an ACP command's row starts with its first chunk, and the
        // rest only streams.
        const own=event.output||"";
        let rowEvent=streamedOutput.length>own.length&&streamedOutput.startsWith(own)?{...event,output:streamedOutput}:event;
        // An MCP call's progress names it while it runs; one that ended reads as it ended, whatever progress was kept for it.
        if(progress&&event.status==="running")rowEvent={...rowEvent,title:progress.title||rowEvent.title,raw:{...(rowEvent.raw||{}),progress:progress.raw||progress}};
        return <ActivityEventRow key={event.id} event={rowEvent} onInspectChanges={onInspectChanges}/>;
      })}
    </div>}
  </div>;
});

function EventIcon({event}){
  // A retry is not a failed step (activity-item.js retryActivityRow): it retries, then went on or stopped with its turn.
  if(event.kind==="retry")return event.status==="done"?<Check size={13}/>:<RefreshCw size={13}/>;
  if(toolEventFailed(event))return <X size={13}/>;
  if(event.status==="done")return <Check size={13}/>;
  if(event.kind==="commandExecution")return <SquareTerminal size={13}/>;
  if(event.kind==="fileChange")return <FileDiff size={13}/>;
  if(event.kind==="plan")return <ListTodo size={13}/>;
  if(event.kind==="mcpToolCall")return <Zap size={13}/>;
  return <Sparkles size={13}/>;
}
// A row's pill: an error says error, a retry what became of it, a call that never started that it did not run, any other step its
// status.
function eventPill(event){
  if(event.kind==="error")return "error";
  if(event.kind==="retry")return event.status==="running"?"retrying":event.status==="done"?"recovered":event.status;
  return event.status==="notRun"?"not run":event.status;
}
const ActivityEventRow=React.memo(function ActivityEventRow({event,onInspectChanges}){
  const [expanded,setExpanded]=useState(false);
  return <details className={"tool-event status-"+(toolEventFailed(event)?"error":event.status)+" kind-"+(event.kind||"event")} onToggle={toggle=>setExpanded(toggle.currentTarget.open)}><summary><span className="timeline-marker"><EventIcon event={event}/></span><strong>{event.title}</strong><em>{eventPill(event)}</em></summary>
    {expanded&&<ActivityEventBody event={event} onInspectChanges={onInspectChanges}/>}
  </details>;
});
function DiffBlock({lines}){
  return <pre className="tool-event-diff">{lines.map((line,index)=><span key={index} className={"diff-"+line.tone}>{line.text||" "}</span>)}</pre>;
}
// A path cut at its start, so its last folders and file name stay in view (the tooltip has all of it).
function PathTail({as:Tag="code",path,title=path,className=""}){
  return <Tag className={"path-tail"+(className?" "+className:"")} title={title}><bdi>{path}</bdi></Tag>;
}
// An expanded row shows what the step did, once each: a command's line (the one it ran, when the harness titled it with a
// description) with its exit code, folder and duration, then its output; a change's files with what happened to each and its
// diff, which a General chat or a folder without Git has no other place to show. The raw event is shown only for a step that
// has none of those (an MCP call, for example), not as a third copy of the command under its output.
function ActivityEventBody({event,onInspectChanges}){
  const raw=event.raw&&typeof event.raw==="object"?event.raw:null;
  const command=raw?.command?commandLine(raw):"",facts=command?commandFacts(raw):[];
  // Worked out once per version of the step: an open row re-renders as the turn goes on (a turn diff on every update).
  const changes=useMemo(()=>{
    if(Array.isArray(raw?.changes))return fileChangeRows(raw.changes);
    const nativeEdit=nativeEditChanges(raw);return nativeEdit?fileChangeRows(nativeEdit):null;
  },[raw]);
  // A turn's diff update carries the diff itself.
  const turnDiff=useMemo(()=>event.kind==="fileChange"&&typeof event.raw==="string"?turnDiffLines(event.raw):[],[event.kind,event.raw]);
  return <div className="tool-event-body">
    {command&&<pre>{command}</pre>}
    {facts.length>0&&<div className="tool-event-facts" data-testid="tool-event-facts">{facts.map((fact,index)=><React.Fragment key={fact.key}>{index>0&&<i className="fact-sep" aria-hidden="true">·</i>}{fact.key==="cwd"?<PathTail as="span" className="fact-cwd" path={fact.label} title={fact.title}/>:<span className={"fact-"+fact.key+(fact.tone?" tone-"+fact.tone:"")} title={fact.title}>{fact.label}</span>}</React.Fragment>)}</div>}
    {event.output&&<pre>{event.output}</pre>}
    {changes?.length>0&&<div className="tool-event-changes" data-testid="tool-event-changes">{changes.map((change,index)=><div className="tool-event-change" key={change.path+":"+index}><div className="tool-event-change-head"><FileDiff size={12} aria-hidden="true"/><PathTail path={change.path||"Unnamed file"}/>{change.kind&&<em className={"change-kind kind-"+change.kind}>{change.kind}</em>}{change.movePath&&<><span className="change-move-to">to</span><PathTail path={change.movePath}/></>}</div>{change.lines.length>0&&<DiffBlock lines={change.lines}/>}</div>)}</div>}
    {turnDiff.length>0&&<DiffBlock lines={turnDiff}/>}
    {(changes||turnDiff.length>0)&&onInspectChanges&&<button onClick={onInspectChanges}><FileDiff size={12}/> Inspect changes</button>}
    {!(command||event.output||changes?.length||turnDiff.length)&&<pre className="tool-json">{event.kind==="reasoning"?"Reasoning activity":JSON.stringify(event.raw,null,2)}</pre>}
  </div>;
}

export default TurnActivityCard;
