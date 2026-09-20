import React from "react";
import { Bot, GitBranch } from "lucide-react";

export default function AgentsPage({threads,onOpen}){
  const children=threads.filter(t=>t.parentThreadId);
  return <div className="agents-page">
    <div className="agent-summary"><Bot size={24}/><div><strong>Delegated agents</strong><span>Subagents created by Codex appear here with their own durable threads.</span></div></div>
    {children.length===0?<div className="empty-state">No subagent threads yet.</div>:<div className="agent-list">{children.map(t=><button key={t.id} onClick={()=>onOpen(t)}><Bot size={17}/><div><strong>{t.name||t.agentNickname||t.preview||"Subagent"}</strong><span>{t.agentRole||"agent"} · parent {t.parentThreadId?.slice(0,8)}</span></div><GitBranch size={13}/></button>)}</div>}
  </div>;
}
