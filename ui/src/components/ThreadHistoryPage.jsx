import React from "react";
import { History } from "lucide-react";
import { threadCatalogRuntime, threadTitle } from "../thread-catalog.js";
import { compactDateTime, fullDateTime, isoDateTime } from "../time-format.js";
import { ignorePressRest } from "./ThreadSidebar.jsx";

// The short harness names the sidebar chips use, which History's rows give each thread's owner.
const HISTORY_RUNTIME_LABELS=Object.freeze({native:"Native",codex:"Codex",claude:"Claude",cursor:"Cursor",grok:"Grok",opencode:"OpenCode",antigravity:"Antigravity",muse:"Muse"});

// The list of the History page under its heading, which App keeps: the threads History has read (App's threadHistory), a first page
// that failed with its Retry, and Load older threads. It shows once the person opens History, so App loads it at idle right after the
// first paint (idle-parts.js, B11): from then on History draws at once, and History opened before then asks for it at once and says
// "Loading thread history…" under its heading until it is in. What History reads, and when, stays in App (the History effects,
// loadOlderThreadHistory).
export default function ThreadHistoryPage({threadHistory,threadCatalogCursor,threadMeta,agentRuntime,agentRuntimeName,onRetry,onOpen,onNewTask,onLoadOlder}){
  return <div className="history-page">
    {threadHistory.error&&<div className="history-load-error provider-status-error" role="alert"><span key={threadHistory.failures}>{threadHistory.failures>1?"Still could not":"Could not"} load thread history: {threadHistory.error}</span><button type="button" className="tb-btn tb-btn--sm" aria-disabled={threadHistory.retrying||undefined} onClick={event=>{ignorePressRest(!event.detail);onRetry()}}>{threadHistory.retrying?"Retrying…":"Retry"}</button></div>}
    {threadHistory.items.length?threadHistory.items.map(t=>{const owner=threadCatalogRuntime(t,threadMeta[t.id]||{},agentRuntime)||agentRuntime;return <button className="history-thread-row" key={t.id} onClick={()=>onOpen(t)}><div><strong title={threadTitle(t)}>{threadTitle(t)}</strong><span title={t.preview||t.cwd||undefined}>{t.preview||t.cwd}</span></div><em className="history-runtime-chip" title={"Owned by "+agentRuntimeName(owner)}>{HISTORY_RUNTIME_LABELS[owner]||owner}</em><time dateTime={isoDateTime(t.updatedAt)} title={fullDateTime(t.updatedAt)}>{compactDateTime(t.updatedAt)}</time></button>}):!threadHistory.error&&<div className="history-empty"><History size={22}/><strong>{threadHistory.loading?"Loading thread history…":"No thread history yet"}</strong><span>{threadHistory.loading?"Fetching the newest threads from the active agent runtime.":"Start a task or General chat and it will appear here."}</span>{!threadHistory.loading&&<button onClick={()=>onNewTask()}>Start a new task</button>}</div>}
    {threadHistory.olderError&&!threadHistory.loadingOlder&&<div className="history-load-error provider-status-error" role="alert">Could not load older threads: {threadHistory.olderError}</div>}{(threadHistory.nextCursor||threadCatalogCursor)&&<div className="history-page-control history-load-more"><button type="button" aria-disabled={threadHistory.loadingOlder||undefined} onClick={event=>{ignorePressRest(!event.detail);onLoadOlder()}}>{threadHistory.loadingOlder?"Loading older threads…":"Load older threads"}</button></div>}
  </div>;
}
