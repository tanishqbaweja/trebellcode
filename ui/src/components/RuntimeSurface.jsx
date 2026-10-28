import React from "react";
import { Check, Minus } from "lucide-react";

// The right panel's Runtime tab: the harness's transport and steps, the approval card, the harness grid, the capability matrix, the
// open thread's background processes and trace, and the latest activity. It shows once the person opens the tab, so App loads it at
// idle right after the first paint (idle-parts.js, B11): from then on the tab draws at once, and one opened before then asks for it at
// once and says "Loading panel…" until it is in, as every other tab of the panel does for its own. App hands it the parts it keeps
// (approval, backgroundTerminals, trace) as they are drawn there.
function capabilityStatus(value){
  if(value==="runtime")return "runtime";
  return value?"available":"not exposed";
}

// The harness transport state in the words the Runtime panel uses, with the status-dot tone that matches it.
function transportStatusCopy(status){
  if(status==="connected")return {label:"Connected",tone:"ok"};
  if(status==="connecting"||status==="reconnecting")return {label:"Connecting…",tone:"warn"};
  if(status==="error")return {label:"Connection failed",tone:"err"};
  return {label:"Not connected",tone:"off"};
}

export default function RuntimeSurface({mock,rpcStatus,running,agentRuntimeLabel,events,completedEvents,providerReady,stats,context,runtimeCapabilities,approval=null,backgroundTerminals=null,trace=null}){
  return <div className="runtime-surface">
    <section className="runtime-summary">
      {(()=>{const transport=mock?{label:"Ready · replies use the direct provider route",tone:"ok"}:rpcStatus==="connected"?{label:"Connected locally",tone:"ok"}:transportStatusCopy(rpcStatus);return <div><span className={"runtime-dot tone-"+transport.tone+(transport.tone==="ok"?" online":"")}/><div><strong>{running?"Agent working":agentRuntimeLabel+" harness"}</strong><span>{transport.label}</span></div></div>})()}
      {/* Steps are counted only when there are some: an idle runtime has no step pending. */}
      <small data-testid="runtime-activity-steps">{events.length?`${completedEvents}/${events.length} current activity ${events.length===1?"step":"steps"} complete`:"No activity yet"}</small>
    </section>
    {approval}
    <section className="runtime-grid">
      <div><span>Agent harness</span><strong>{agentRuntimeLabel}</strong></div>
      <div><span>Harness status</span><strong>{providerReady?"Ready":"Setup required"}</strong></div>
      <div><span>CPU</span><strong>{stats.cpu||"—"}</strong></div>
      <div><span>Memory</span><strong>{stats.memory||"—"}</strong></div>
      <div><span>Disk</span><strong>{stats.disk||"—"}</strong></div>
      <div><span>Context</span>{" "}<strong>{context}</strong></div>
    </section>
    <section className="runtime-capabilities" data-testid="runtime-capabilities">
      <div className="runtime-capabilities-head"><strong>Runtime capability matrix</strong><span>Only exposed controls should be usable.</span></div>
      <div className="runtime-capability-grid">
        {[
          ["Queue",runtimeCapabilities.queue],
          ["Fork",runtimeCapabilities.fork],
          ["Rewind",runtimeCapabilities.rewind],
          ["Compaction",runtimeCapabilities.compaction],
          ["MCP injection",runtimeCapabilities.mcpInjection],
          ["Language intelligence",runtimeCapabilities.languageIntelligence],
          ["Sandbox",runtimeCapabilities.nativeSandbox],
          ["Detached tasks",runtimeCapabilities.detachedTasks],
          ["Multi-model fan-out",runtimeCapabilities.multiModelFanout],
          ["Background processes",runtimeCapabilities.backgroundProcesses],
          ["Delegation",runtimeCapabilities.delegation],
          ["Harness tools",runtimeCapabilities.harnessTools],
          ["Steering",runtimeCapabilities.steering],
          ["Runtime profiles",runtimeCapabilities.runtimeProfileSwitching],
        ].map(([label,value])=><div key={label} className={value==="runtime"?"available runtime":value?"available":"unavailable"}>{value?<Check size={13} aria-hidden="true"/>:<Minus size={13} aria-hidden="true"/>}<span>{label}</span><strong>{capabilityStatus(value)}</strong></div>)}
      </div>
    </section>
    {backgroundTerminals}
    {trace}
    <section className="runtime-activity"><strong>Latest activity</strong><p>{events.find(event=>event.status==="running")?.title||events.at(-1)?.title||"Waiting for a task"}</p></section>
  </div>;
}
