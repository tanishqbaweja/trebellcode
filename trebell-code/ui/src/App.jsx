import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Archive, Bot, Box, BrainCircuit, Check, ChevronDown, CircleStop,
  Code2, Command, Cpu, ExternalLink, FileCode2, FileDiff, FilePlus2, Files,
  Folder, FolderCode, Gauge, Globe2, HardDrive, History, LayoutTemplate,
  Link2, ListTodo, MemoryStick, MessageSquarePlus, Mic, MonitorDot, MoreHorizontal,
  Network, PanelRight, Play, Plus, Search, Send, Settings, Share2, Shell,
  ShieldCheck, Sparkles, SquareTerminal, WandSparkles, Wifi, X, Zap,
  Coins, Flame, Clock3, RefreshCw, CircleDollarSign,
} from "lucide-react";
import { CodexRpcClient } from "./rpc.js";

const DEMO_THREADS = [
  { id: "demo-1", name: "Build private browser converter", preview: "Build a private browser converter", updatedAt: Date.now()/1000 - 120, modelProvider: "freebuff" },
  { id: "demo-2", name: "Fix PDF text regression", preview: "Fix PDF text regression", updatedAt: Date.now()/1000 - 14400, modelProvider: "freebuff" },
  { id: "demo-3", name: "Autonomous YouTube uploader", preview: "Autonomous YouTube uploader", updatedAt: Date.now()/1000 - 86400, modelProvider: "freebuff" },
  { id: "demo-4", name: "Video converter (10GB)", preview: "Video converter (10GB)", updatedAt: Date.now()/1000 - 172800, modelProvider: "freebuff" },
  { id: "demo-5", name: "RAG knowledge base", preview: "RAG knowledge base", updatedAt: Date.now()/1000 - 259200, modelProvider: "freebuff" },
];

const DEMO_EVENTS = [
  { id: "plan", kind: "plan", title: "Planning the implementation", status: "done", detail: "Break the work into an executable plan." },
  { id: "shell", kind: "commandExecution", title: "Setting up project structure", status: "running", command: "mkdir video-converter\ncd video-converter\nnpx create-vite@latest" },
  { id: "download", kind: "tool", title: "Downloading WebAssembly build", status: "pending" },
  { id: "pipeline", kind: "tool", title: "Implementing streaming pipeline", status: "pending" },
  { id: "opfs", kind: "fileChange", title: "Adding OPFS storage layer", status: "pending" },
  { id: "test", kind: "browser", title: "Testing with large file (2.8 GB)", status: "pending" },
  { id: "final", kind: "tool", title: "Finalizing and validating", status: "pending" },
];

const TOOL_META = [
  ["Shell", Shell],
  ["File System", FolderCode],
  ["Web Search", Search],
  ["Browser", Globe2],
  ["Edit Files", FileCode2],
];


function freebuffPrice(freebuff, model) {
  return freebuff?.derived?.priceByModel?.[model] || (freebuff?.derived?.selectedModel===model ? freebuff?.derived?.selectedPrice : null);
}

function modelLabel(model, freebuff) {
  const clean=model.replace(/^freebuff\//,"");
  const price=freebuffPrice(freebuff,model);
  if(!price) return clean;
  if(price.dynamic) return `${clean} · dynamic`;
  if(typeof price.current==="number") return `${clean} · ${price.current} FB/h${price.offPeakActive ? " off-peak" : ""}`;
  return clean;
}

function FreebuffSummary({freebuff, model, openDetails}) {
  const balance=freebuff?.derived?.balance;
  const price=freebuffPrice(freebuff,model);
  const status=freebuff?.derived?.sessionStatus || "none";
  const streak=freebuff?.streak?.streak;
  return (
    <button className="freebuff-card" onClick={openDetails} data-testid="freebuff-card">
      <div className="freebuff-card-head"><span><Coins size={17}/> Freebucks</span><b>{typeof balance==="number" ? balance : "—"}</b></div>
      <div className="freebuff-mini-grid">
        <div><small>Model</small><strong>{model ? model.replace(/^freebuff\//,"").split("/").at(-1) : "—"}</strong></div>
        <div><small>Price</small><strong>{price?.dynamic ? "Dynamic" : typeof price?.current==="number" ? `${price.current} FB/h` : "—"}</strong></div>
        <div><small>Session</small><strong className={status==="active" ? "good" : ""}>{status}</strong></div>
        <div><small>Streak</small><strong>{typeof streak==="number" ? `${streak}d` : "—"}</strong></div>
      </div>
      <span className="freebuff-detail-link">View Freebuff account <span>→</span></span>
    </button>
  );
}

function relativeTime(epoch) {
  if (!epoch) return "";
  const delta = Math.max(0, Date.now()/1000 - epoch);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta/60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta/3600)}h ago`;
  return `${Math.floor(delta/86400)}d ago`;
}

function historyFromThread(thread) {
  const out=[];
  for(const turn of thread?.turns || []){
    for(const item of turn?.items || []){
      if(item?.type==="userMessage"){
        const text=(item.content||[]).filter(x=>x?.type==="text").map(x=>x.text).join("\n").trim();
        if(text) out.push({id:item.id,role:"user",text});
      }else if(item?.type==="agentMessage" && item.text?.trim()){
        out.push({id:item.id,role:"assistant",text:item.text});
      }
    }
  }
  return out;
}

function titleOf(thread) {
  return thread.name || thread.preview || "Untitled task";
}

function normalizeItem(item = {}) {
  const type = item.type || item.kind || "tool";
  const title =
    item.command ||
    item.name ||
    item.title ||
    item.description ||
    (type === "commandExecution" ? "Running command" :
      type === "fileChange" ? "Editing files" :
      type === "mcpToolCall" ? "Using MCP tool" :
      type === "webSearch" ? "Searching the web" :
      type === "reasoning" ? "Reasoning" :
      "Agent activity");
  return {
    id: item.id || crypto.randomUUID(),
    kind: type,
    title: typeof title === "string" ? title.split("\n")[0].slice(0, 120) : "Agent activity",
    status: item.status === "completed" ? "done" : item.status || "running",
    command: typeof item.command === "string" ? item.command : null,
    raw: item,
  };
}

function Orb({ active=true }) {
  return <div className={`orb ${active ? "orb-active" : ""}`}><div className="orb-core" /></div>;
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark"><Sparkles size={22}/></div>
      <div>
        <div className="brand-name">Trebell <span>Code</span></div>
        <div className="brand-tag">Think <b>›</b> Plan <b>›</b> Build</div>
      </div>
    </div>
  );
}

function Sidebar({ section, setSection, threads, activeThreadId, openThread, query, setQuery, newChat, archiveThread }) {
  const nav = [
    ["new", MessageSquarePlus, "New Chat"],
    ["agent", Bot, "Agent Mode"],
    ["projects", Folder, "Projects"],
    ["templates", LayoutTemplate, "Templates"],
    ["freebuff", CircleDollarSign, "Freebuff"],
    ["settings", Settings, "Settings"],
  ];
  const filtered = threads.filter((thread) => titleOf(thread).toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="sidebar">
      <Brand />
      <div className="search-box">
        <Search size={18}/>
        <input aria-label="Search chats" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search chats..." />
        <kbd>Ctrl K</kbd>
      </div>
      <nav className="nav-stack">
        {nav.map(([id, Icon, label]) => (
          <button key={id} className={`nav-item ${section===id ? "active" : ""}`} onClick={() => id==="new" ? newChat() : setSection(id)}>
            <Icon size={18}/><span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-rule" />
      <div className="recent-head"><span>Recent</span><button title="Archive current thread" onClick={archiveThread}><Archive size={15}/></button></div>
      <div className="recent-list">
        {filtered.slice(0,7).map((thread) => (
          <button key={thread.id} className={`recent-item ${thread.id===activeThreadId ? "selected" : ""}`} onClick={()=>openThread(thread)}>
            <div className="recent-icon"><FileCode2 size={15}/></div>
            <div className="recent-copy">
              <strong>{titleOf(thread)}</strong>
              <span>{relativeTime(thread.updatedAt)}</span>
            </div>
            {thread.id===activeThreadId && <i />}
          </button>
        ))}
      </div>
      <button className="view-all" onClick={()=>setSection("history")}>View all <span>→</span></button>
      <div className="mountain" />
      <div className="profile-card">
        <div className="avatar">T</div>
        <div><strong>Tanishq</strong><span>Build what matters.</span></div>
        <button title="Open settings" onClick={()=>setSection("settings")}><MoreHorizontal size={18}/></button>
      </div>
    </aside>
  );
}

function Topbar({ title, running, stop, openPanel, renameThread, shareThread }) {
  return (
    <div className="topbar">
      <div className="task-icon"><Code2 size={26}/></div>
      <div className="task-title">
        <div><strong>{title}</strong><button className="ghost-icon" title="Rename" onClick={renameThread}><WandSparkles size={15}/></button></div>
        <span>{running ? "Agent is working…" : "Ready"}</span>
      </div>
      <div className="top-actions">
        <button className="btn secondary" onClick={shareThread}><Link2 size={16}/> Share</button>
        <button className="icon-btn" title="Open code panel" onClick={()=>openPanel("files")}><Code2 size={17}/></button>
        {running && <button className="btn stop" onClick={stop}><CircleStop size={15}/> Stop</button>}
      </div>
    </div>
  );
}

function UserBubble({ text }) {
  if (!text) return null;
  return (
    <div className="user-row">
      <div className="user-dot"><Bot size={17}/></div>
      <div className="user-bubble">
        <p>{text}</p>
        <span>{new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}</span>
      </div>
    </div>
  );
}

function ConversationMessages({messages}) {
  return <div className="conversation-history">{messages.map(message=>message.role==="user"
    ? <UserBubble key={message.id} text={message.text}/>
    : <div className="history-assistant" key={message.id}><div className="agent-star small"><Sparkles size={13}/></div><div>{message.text}</div></div>
  )}</div>;
}

function EventIcon({ kind, status }) {
  if (status==="done") return <Check size={15}/>;
  if (kind==="commandExecution") return <SquareTerminal size={14}/>;
  if (kind==="fileChange") return <FileDiff size={14}/>;
  if (kind==="browser") return <Globe2 size={14}/>;
  if (kind==="plan") return <ListTodo size={14}/>;
  return <Sparkles size={14}/>;
}

function Timeline({ events, assistantText, openPanel }) {
  return (
    <div className="agent-block">
      <div className="agent-heading">
        <div className="agent-star"><Sparkles size={17}/></div>
        <span>Trebell Code is working…</span>
      </div>
      <div className="timeline">
        {events.map((event, index) => (
          <div className={`timeline-row status-${event.status}`} key={event.id}>
            <div className="timeline-marker"><EventIcon kind={event.kind} status={event.status}/></div>
            <div className="timeline-content">
              <div className="timeline-line">
                <strong>{event.title}</strong>
                <span>{event.status==="running" ? "now" : event.status==="done" ? "done" : "…"}</span>
              </div>
              {event.command && (
                <button className="command-card" onClick={()=>openPanel("terminal")}>
                  <pre>{event.command}</pre>
                  <span>Bash <ChevronDown size={13}/></span>
                </button>
              )}
              {event.raw?.changes && (
                <button className="diff-summary" onClick={()=>openPanel("diff")}>
                  <FileDiff size={15}/> {event.raw.changes.length} file change{event.raw.changes.length===1?"":"s"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {assistantText && <div className="assistant-answer">{assistantText}</div>}
    </div>
  );
}

function Composer({ prompt, setPrompt, send, running, model, setModel, models, webSearch, setWebSearch, loggedIn, login, projectPath, freebuff, attachments, pickFiles, rpcStatus, openTools }) {
  return (
    <div className="composer-wrap">
      <textarea
        data-testid="composer"
        value={prompt}
        onChange={(e)=>setPrompt(e.target.value)}
        onKeyDown={(e)=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); } }}
        placeholder={loggedIn ? "Ask Trebell Code anything…" : "Sign in to Freebuff to start…"}
        disabled={!loggedIn}
      />
      <div className="composer-bar">
        <div className="composer-left">
          <button className="circle-btn" title="Attach files" onClick={pickFiles}><Plus size={20}/></button>
          <button className={`pill-btn ${webSearch ? "active" : ""}`} onClick={()=>setWebSearch(!webSearch)}><Globe2 size={16}/> Web Search</button>
          <button className="pill-btn" onClick={openTools}><WandSparkles size={16}/> Tools</button>
          <span className="project-chip" title={projectPath}><FolderCode size={14}/>{attachments.length ? `${attachments.length} attached` : projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : "workspace"}</span>
        </div>
        <div className="composer-right">
          {!loggedIn ? (
            <button className="login-btn" onClick={login}>Sign in to Freebuff</button>
          ) : (
            <select data-testid="model-picker" value={model} onChange={(e)=>setModel(e.target.value)} aria-label="Freebuff model">
              {models.map((id)=><option key={id} value={id}>{modelLabel(id,freebuff)}</option>)}
            </select>
          )}
          <button className="mic-btn" disabled title="Voice input is not configured yet"><Mic size={18}/></button>
          <button data-testid="send" className="send-btn" onClick={send} disabled={running || !loggedIn || !prompt.trim()}><Send size={18}/></button>
        </div>
      </div>
      <div className="composer-status"><span className={rpcStatus==="connected"?"ok":""}/>{rpcStatus==="connected" ? "Agent harness connected" : "Freebuff direct fallback available"}</div>
    </div>
  );
}

function RightRail({ running, stats, events, approvals, resolveApproval, openPanel, freebuff, model, setSection, rpcStatus }) {
  const completed = events.filter(e=>e.status==="done").length;
  const total = Math.max(events.length,1);
  return (
    <aside className="right-rail">
      <div className="agent-card">
        <Orb active={running}/>
        <div><strong>Trebell Agent</strong><span><i className={rpcStatus==="connected" ? "online" : ""}/>{running ? "Active" : rpcStatus==="connected" ? "Ready" : "Fallback"}</span></div>
      </div>
      <div className="progress-card">
        <div><strong>{running ? "Working on it…" : "Task progress"}</strong><span>{completed} / {total}</span></div>
        <div className="progress-track"><i style={{width:`${Math.max(8, completed/total*100)}%`}} /></div>
        <p>{events.find(e=>e.status==="running")?.title || events.at(-1)?.title || "Waiting for a task"}</p>
      </div>
      {approvals.length>0 && (
        <div className="approval-card">
          <div className="card-title"><ShieldCheck size={17}/><strong>Approval required</strong></div>
          <p>{approvals[0].params?.reason || approvals[0].params?.command || "Trebell needs permission to continue."}</p>
          <div className="approval-actions">
            <button onClick={()=>resolveApproval(approvals[0], "decline")}>Deny</button>
            <button className="approve" onClick={()=>resolveApproval(approvals[0], "accept")}>Allow</button>
          </div>
        </div>
      )}
      <FreebuffSummary freebuff={freebuff} model={model} openDetails={()=>setSection("freebuff")}/>
      <div className="stats-card">
        <Stat icon={Cpu} label="CPU" value={stats.cpu ?? "—"}/>
        <Stat icon={MemoryStick} label="Memory" value={stats.memory ?? "—"}/>
        <Stat icon={HardDrive} label="Disk (Temp)" value={stats.disk ?? "—"}/>
        <Stat icon={Network} label="Network" value={stats.network ?? "Local"}/>
      </div>
      <div className="tools-card">
        <div className="tools-head"><strong>Tools</strong><ChevronDown size={15}/></div>
        {TOOL_META.map(([name,Icon]) => {
          const target=name==="Shell"?"terminal":name==="File System"?"files":name==="Edit Files"?"diff":null;
          return <button key={name} onClick={()=>target && openPanel(target)} disabled={!target} title={target ? "Open "+name : name+" is invoked by the agent during a turn"}>
            <Icon size={17}/><span>{name}</span><i className={rpcStatus==="connected"?"tool-live":"tool-offline"}/>
          </button>;
        })}
      </div>
      <div className="privacy-line"><span/><b>Private</b> · Local · Powerful</div>
    </aside>
  );
}

function Stat({icon:Icon,label,value}) {
  return <div className="stat-row"><Icon size={17}/><span>{label}</span><strong>{value}</strong></div>;
}

function Panel({ panel, close, events, projectPath, freebuff, model, workspaceTree, diffText, panelLoading, filePreview, openFile, terminalCommand, setTerminalCommand, terminalOutput, runTerminal, terminalRunning }) {
  if (!panel) return null;
  const shellEvent = events.find(e=>e.command);
  return (
    <div className="drawer" data-testid="drawer">
      <div className="drawer-head">
        <div>
          {panel==="terminal" ? <SquareTerminal size={18}/> : panel==="diff" ? <FileDiff size={18}/> : panel==="freebuff" ? <Coins size={18}/> : <Files size={18}/>}
          <strong>{panel==="terminal" ? "Terminal" : panel==="diff" ? "Changes" : panel==="freebuff" ? "Freebuff" : "Workspace"}</strong>
        </div>
        <button onClick={close}><X size={18}/></button>
      </div>
      {panel==="terminal" && <div className="terminal-shell">
        <pre className="terminal-view">{terminalOutput || shellEvent?.command || "Trebell terminal ready."}</pre>
        <form className="terminal-input" onSubmit={(e)=>{e.preventDefault();runTerminal();}}>
          <span>$</span><input value={terminalCommand} onChange={(e)=>setTerminalCommand(e.target.value)} placeholder="Run a command in the current workspace…" autoFocus/>
          <button disabled={terminalRunning || !terminalCommand.trim()}>{terminalRunning ? "Running…" : "Run"}</button>
        </form>
      </div>}
      {panel==="diff" && <div className="diff-view">{panelLoading ? <p>Loading Git diff…</p> : <pre>{diffText || "Working tree has no unstaged diff, or this workspace is not a Git repository."}</pre>}</div>}
      {panel==="freebuff" && (
        <div className="freebuff-panel">
          <div className="fb-balance"><small>Available Freebucks</small><strong>{freebuff?.derived?.balance ?? "—"}</strong></div>
          <div className="fb-kpis">
            <div><span>Selected model</span><b>{model?.replace(/^freebuff\//,"") || "—"}</b></div>
            <div><span>Hourly price</span><b>{freebuffPrice(freebuff,model)?.current ?? "—"} FB</b></div>
            <div><span>Session</span><b>{freebuff?.derived?.sessionStatus || "none"}</b></div>
            <div><span>Streak</span><b>{freebuff?.streak?.streak ?? "—"} days</b></div>
          </div>
          <h4>Rate limit</h4>
          <pre className="fb-json">{freebuff?.derived?.rateLimit ? JSON.stringify(freebuff.derived.rateLimit,null,2) : "No live rate-limit data yet."}</pre>
        </div>
      )}
      {panel==="files" && (
        <div className="file-tree">
          <p className="path-label">{projectPath || "Current workspace"}</p>
          {panelLoading ? <p>Loading workspace…</p> : workspaceTree.map(entry=>(
            <button className="file-entry" key={entry.path} style={{paddingLeft:8+entry.depth*16}} onClick={()=>entry.isFile && openFile(entry.path)}>
              {entry.isDirectory ? <Folder size={15}/> : <FileCode2 size={15}/>}<span>{entry.name}</span>
            </button>
          ))}
          {filePreview && <pre className="file-preview">{filePreview.content}</pre>}
        </div>
      )}
    </div>
  );
}

function SecondaryView({ section, setSection, projectPath, setProjectPath, sandbox, setSandbox, approvalPolicy, setApprovalPolicy, loggedIn, login, logout, freebuff, model, refreshFreebuff, browseProject, useTemplate, rpcStatus, runtime, threads, openThread }) {
  if (section==="chat" || section==="new" || section==="agent") return null;
  const content = {
    projects: ["Projects", "Choose the local workspace Trebell Code should operate in."],
    templates: ["Templates", "Start common agentic workflows with sensible defaults."],
    settings: ["Settings", "Configure local execution, approvals, and Freebuff authentication."],
    freebuff: ["Freebuff", "Your live account, Freebucks, model pricing, session and usage state."],
    history: ["Conversation history", "Browse every Trebell Code thread stored by the Codex runtime."],
  }[section] || ["Trebell Code", ""];
  return (
    <div className="secondary-page">
      <button className="back-chat" onClick={()=>setSection("chat")}>← Back to agent</button>
      <h1>{content[0]}</h1><p>{content[1]}</p>
      {section==="projects" && (
        <div className="settings-card">
          <label>Workspace path<div className="project-picker"><input value={projectPath} onChange={(e)=>setProjectPath(e.target.value)} placeholder="/path/to/project"/><button onClick={browseProject}>Browse…</button></div></label>
          <div className="project-demo"><FolderCode size={24}/><div><strong>Current workspace</strong><span>{projectPath || "Not selected"}</span></div></div>
        </div>
      )}
      {section==="templates" && <div className="template-grid">
        {[
          ["Ship a feature", Zap, "Plan, implement, test, and summarize a feature."],
          ["Fix a bug", Activity, "Reproduce, diagnose, patch, and validate."],
          ["Review a codebase", Search, "Map architecture, risks, and improvement areas."],
          ["Refactor safely", FileDiff, "Refactor with tests and focused diffs."],
          ["Browser task", Globe2, "Research and interact with web resources."],
          ["Autonomous build", BrainCircuit, "Run a multi-step build until validation passes."],
        ].map(([name,Icon,desc])=><button key={name} onClick={()=>useTemplate(name)}><Icon size={22}/><strong>{name}</strong><span>{desc}</span></button>)}
      </div>}
      {section==="freebuff" && (
        <div className="freebuff-page">
          <div className="fb-hero">
            <div><span>Freebucks balance</span><strong>{freebuff?.derived?.balance ?? "—"}</strong><small>{freebuff?.user?.email || "Signed in to Freebuff"}</small></div>
            <button onClick={refreshFreebuff}><RefreshCw size={15}/> Refresh</button>
          </div>
          <div className="fb-dashboard-grid">
            <div className="fb-dashboard-card"><Coins size={19}/><span>Selected model</span><strong>{model?.replace(/^freebuff\//,"") || "—"}</strong><small>{freebuffPrice(freebuff,model)?.current != null ? `${freebuffPrice(freebuff,model).current} Freebucks/hour` : freebuffPrice(freebuff,model)?.dynamic ? "Server-priced offer" : "Price unavailable"}</small></div>
            <div className="fb-dashboard-card"><Clock3 size={19}/><span>Session</span><strong>{freebuff?.derived?.sessionStatus || "none"}</strong><small>{freebuff?.derived?.activeModel?.replace(/^freebuff\//,"") || "No active model"}</small></div>
            <div className="fb-dashboard-card"><Flame size={19}/><span>Usage streak</span><strong>{freebuff?.streak?.streak ?? "—"} days</strong><small>{freebuff?.streak?.freebucksDailyBonus != null ? `+${freebuff.streak.freebucksDailyBonus} daily bonus` : "Bonus data unavailable"}</small></div>
            <div className="fb-dashboard-card"><Gauge size={19}/><span>Rate limit</span><strong>{freebuff?.derived?.rateLimit?.remaining ?? "—"}</strong><small>{freebuff?.derived?.rateLimit?.limit != null ? `of ${freebuff.derived.rateLimit.limit} remaining` : "Live server limits"}</small></div>
          </div>
          {freebuff?.derived?.selectedPrice?.offPeakActive && <div className="fb-offpeak"><Zap size={15}/> Off-peak pricing is active for the selected model.</div>}
          {freebuff?.errors?.session && <div className="fb-warning">Session endpoint returned HTTP {freebuff.errors.session.status}. Account data may be incomplete.</div>}
          <div className="fb-model-table">
            <div className="fb-table-head"><span>Freebuff model</span><span>Freebucks/hour</span><span>Source</span></div>
            {Object.entries(freebuff?.derived?.priceByModel || {}).map(([id,price])=>(
              <div className={id===model ? "selected" : ""} key={id}><span>{id.replace(/^freebuff\//,"")}</span><span>{price.dynamic ? "Dynamic" : price.current ?? "—"}</span><span>{price.source==="server" ? "Live" : "Fallback"}</span></div>
            ))}
          </div>
          <div className="fb-raw">
            <h3>Session details</h3>
            <div><span>Instance</span><code>{freebuff?.instanceId || "—"}</code></div>
            <div><span>Admitted</span><code>{freebuff?.derived?.admittedAt || "—"}</code></div>
            <div><span>Timezone</span><code>{freebuff?.derived?.timezone || "—"}</code></div>
          </div>
        </div>
      )}
      {section==="settings" && (
        <div className="settings-grid">
          <div className="settings-card">
            <h3>Freebuff</h3>
            <p>{loggedIn ? "Signed in. Model traffic is routed through the local Freebuff bridge." : "Sign in to use Freebuff models."}</p>
            <button className="setting-action" onClick={loggedIn ? logout : login}>{loggedIn ? "Sign out" : "Sign in to Freebuff"}</button>
          </div>
          <div className="settings-card">
            <h3>Runtime</h3>
            <p>Harness: <strong>{rpcStatus}</strong><br/>Codex process: <strong>{runtime?.appServerReady ? "ready" : "not ready"}</strong><br/>Freebuff bridge: <strong>{runtime?.bridgeReady ? "ready" : "not ready"}</strong></p>
          </div>
          <div className="settings-card">
            <h3>Agent permissions</h3>
            <label>Sandbox<select value={sandbox} onChange={(e)=>setSandbox(e.target.value)}><option value="workspace-write">Workspace write</option><option value="read-only">Read only</option><option value="danger-full-access">Full access</option></select></label>
            <label>Approvals<select value={approvalPolicy} onChange={(e)=>setApprovalPolicy(e.target.value)}><option value="on-request">On request</option><option value="untrusted">Untrusted commands</option><option value="never">Never prompt</option></select></label>
          </div>
        </div>
      )}
      {section==="history" && <div className="history-page">
        {threads.length===0 ? <div className="empty-state"><History size={34}/><strong>No saved threads yet.</strong><span>Completed Trebell conversations will appear here.</span></div> :
          threads.map(thread=><button key={thread.id} onClick={()=>openThread(thread)}><FileCode2 size={16}/><div><strong>{titleOf(thread)}</strong><span>{thread.preview || thread.cwd || "Trebell Code thread"}</span></div><time>{relativeTime(thread.updatedAt)}</time></button>)}
      </div>}
    </div>
  );
}

export default function App() {
  const [bootstrap,setBootstrap]=useState({mock:false,loggedIn:false,wsUrl:null,cwd:""});
  const [rpcStatus,setRpcStatus]=useState("disconnected");
  const [rpc,setRpc]=useState(null);
  const [threads,setThreads]=useState([]);
  const [activeThread,setActiveThread]=useState(null);
  const [activeTurnId,setActiveTurnId]=useState(null);
  const [section,setSection]=useState("chat");
  const [query,setQuery]=useState("");
  const [prompt,setPrompt]=useState("");
  const [lastPrompt,setLastPrompt]=useState("");
  const [assistantText,setAssistantText]=useState("");
  const [events,setEvents]=useState([]);
  const [running,setRunning]=useState(false);
  const [models,setModels]=useState([]);
  const [model,setModel]=useState("");
  const [stats,setStats]=useState({});
  const [approvals,setApprovals]=useState([]);
  const [panel,setPanel]=useState(null);
  const [webSearch,setWebSearch]=useState(true);
  const [projectPath,setProjectPath]=useState("");
  const [sandbox,setSandbox]=useState("workspace-write");
  const [approvalPolicy,setApprovalPolicy]=useState("on-request");
  const [attachments,setAttachments]=useState([]);
  const [workspaceEntries,setWorkspaceEntries]=useState([]);
  const [diffText,setDiffText]=useState("");
  const [panelLoading,setPanelLoading]=useState(false);
  const [filePreview,setFilePreview]=useState(null);
  const [runtime,setRuntime]=useState(null);
  const [messages,setMessages]=useState([]);
  const [terminalCommand,setTerminalCommand]=useState("");
  const [terminalOutput,setTerminalOutput]=useState("");
  const [terminalRunning,setTerminalRunning]=useState(false);
  const [freebuff,setFreebuff]=useState({loggedIn:false,user:null,session:null,streak:null,derived:null});
  const demoTimers=useRef([]);

  const activeTitle = titleOf(activeThread || {name:lastPrompt || "New Trebell task"});
  const timezone = useMemo(()=>Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",[]);

  async function refreshFreebuff(modelOverride=model){
    if(!(bootstrap.loggedIn || bootstrap.mock)) return;
    const params=new URLSearchParams({timezone});
    if(modelOverride) params.set("model",modelOverride);
    const data=await fetch(`/api/freebuff/overview?${params}`).then(r=>r.json()).catch(()=>null);
    if(data) setFreebuff(data);
  }

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      const data=await fetch("/api/bootstrap").then(r=>r.json()).catch(()=>({mock:true,loggedIn:true,cwd:""}));
      if(cancelled) return;
      setBootstrap(data);
      setProjectPath(data.cwd || "");
      if(data.mock){
        setThreads(DEMO_THREADS);
        setActiveThread(DEMO_THREADS[0]);
        setLastPrompt("");
        setEvents([]);
      }
      const modelData=await fetch("/api/models").then(r=>r.json()).catch(()=>({models:[]}));
      if(cancelled) return;
      const freebuffModels=(modelData.models || []).filter(id=>id.startsWith("freebuff/"));
      const fallback=freebuffModels.length ? freebuffModels : data.mock ? [
        "freebuff/deepseek/deepseek-v4-flash",
        "freebuff/test/coding-large",
        "freebuff/test/coding-fast",
      ] : [];
      setModels(fallback);
      const first=fallback[0] || "";
      setModel(first);
      const params=new URLSearchParams({timezone});
      if(first) params.set("model",first);
      const overview=await fetch(`/api/freebuff/overview?${params}`).then(r=>r.json()).catch(()=>null);
      if(!cancelled && overview) setFreebuff(overview);
    })();
    return ()=>{cancelled=true; demoTimers.current.forEach(clearTimeout);};
  },[]);

  useEffect(()=>{
    if(!bootstrap.wsUrl || bootstrap.mock) return;
    let disposed=false;
    let client=null;
    let retryTimer=null;

    const connect=async(attempt=0)=>{
      if(disposed) return;
      client=new CodexRpcClient(bootstrap.wsUrl,{
        onStatus:setRpcStatus,
        onNotification:(message)=>handleNotification(message),
        onServerRequest:(message)=>handleServerRequest(client,message),
      });
      setRpc(client);
      try{
        await client.connect();
        if(disposed) return;
        const listed=await client.request("thread/list",{limit:40,modelProviders:["freebuff"],sortKey:"updated_at",sortDirection:"desc"}).catch(()=>({data:[]}));
        if(!disposed) setThreads(listed?.data || []);
      }catch(error){
        client.close();
        if(disposed) return;
        if(attempt<120){
          setRpcStatus("connecting");
          retryTimer=setTimeout(()=>connect(attempt+1),500);
        }else{
          console.error(error);
          setRpcStatus("error");
        }
      }
    };

    connect();
    return ()=>{
      disposed=true;
      clearTimeout(retryTimer);
      client?.close();
    };
  },[bootstrap.wsUrl, bootstrap.mock]);

  useEffect(()=>{
    const timer=setInterval(async()=>{
      const [value,rt]=await Promise.all([
        fetch("/api/stats").then(r=>r.json()).catch(()=>null),
        fetch("/api/runtime").then(r=>r.json()).catch(()=>null),
      ]);
      if(value) setStats(value);
      if(rt) setRuntime(rt);
    },1500);
    return ()=>clearInterval(timer);
  },[]);

  useEffect(()=>{
    if(!(bootstrap.loggedIn || bootstrap.mock)) return;
    refreshFreebuff(model);
    const timer=setInterval(()=>refreshFreebuff(model),15000);
    return ()=>clearInterval(timer);
  },[bootstrap.loggedIn,bootstrap.mock,model,timezone]);

  useEffect(()=>{
    if(!running || !(bootstrap.loggedIn || bootstrap.mock)) return;
    const ping=()=>{
      const params=new URLSearchParams({timezone});
      if(model) params.set("model",model);
      fetch(`/api/freebuff/heartbeat?${params}`,{method:"POST"}).catch(()=>{});
    };
    ping();
    const timer=setInterval(ping,45000);
    return ()=>clearInterval(timer);
  },[running,bootstrap.loggedIn,bootstrap.mock,model,timezone]);

  function handleServerRequest(client,message){
    if(message.method==="item/tool/requestUserInput"){
      const answers={};
      for(const question of message.params?.questions || []){
        const options=(question.options||[]).map(option=>option.label || option.value || String(option));
        const suffix=options.length ? "\nOptions: "+options.join(", ") : "";
        const answer=window.prompt((question.header ? question.header+"\n" : "")+question.question+suffix,"");
        if(answer===null){
          answers[question.id]={answers:[]};
        }else{
          answers[question.id]={answers:[answer]};
        }
      }
      client.respond(message.id,{answers});
      return;
    }
    if(message.method==="item/tool/call"){
      client.respond(message.id,{contentItems:[{type:"inputText",text:"Trebell Code does not expose a client-defined dynamic tool for this call."}],success:false});
      return;
    }
    if(message.method==="item/commandExecution/requestApproval" ||
       message.method==="item/fileChange/requestApproval" ||
       message.method==="item/permissions/requestApproval" ||
       message.method==="applyPatchApproval" ||
       message.method==="execCommandApproval"){
      setApprovals(prev=>[...prev,message]);
      return;
    }
    client.reject(message.id,-32601,"Unsupported Trebell client request: "+message.method);
  }

  function handleNotification(message){
    const p=message.params || {};
    if(message.method==="thread/started" && p.thread){
      setActiveThread(p.thread);
      setThreads(prev=>[p.thread,...prev.filter(t=>t.id!==p.thread.id)]);
    } else if(message.method==="thread/name/updated"){
      setThreads(prev=>prev.map(t=>t.id===p.threadId?{...t,name:p.name}:t));
    } else if(message.method==="turn/started"){
      setRunning(true);
      setActiveTurnId(p.turn?.id || p.turnId || null);
    } else if(message.method==="turn/completed"){
      setRunning(false);
      setActiveTurnId(null);
      setEvents(prev=>prev.map(e=>e.status==="running"?{...e,status:"done"}:e));
    } else if(message.method==="turn/plan/updated"){
      const plan=(p.plan || []).map((step,index)=>({
        id:`plan-${index}`,
        kind:"plan",
        title:step.step || step.description || step.text || `Plan step ${index+1}`,
        status:step.status==="completed"?"done":step.status==="inProgress"?"running":"pending",
        raw:step,
      }));
      setEvents(prev=>[...prev.filter(e=>e.kind!=="plan"),...plan]);
    } else if(message.method==="item/started" && p.item){
      const item=normalizeItem(p.item);
      setEvents(prev=>[...prev.filter(e=>e.id!==item.id),item]);
    } else if(message.method==="item/completed" && p.item){
      if(p.item.type==="agentMessage" && p.item.text?.trim()){
        setMessages(prev=>prev.some(m=>m.id===p.item.id)?prev:[...prev,{id:p.item.id,role:"assistant",text:p.item.text}]);
        setAssistantText("");
      }
      const item=normalizeItem({...p.item,status:"completed"});
      setEvents(prev=>{
        const exists=prev.some(e=>e.id===item.id);
        return exists?prev.map(e=>e.id===item.id?item:e):[...prev,item];
      });
    } else if(message.method==="item/agentMessage/delta"){
      const delta=p.delta || p.text || "";
      if(delta) setAssistantText(prev=>prev+delta);
    } else if(message.method==="item/commandExecution/outputDelta"){
      const id=p.itemId || "command";
      setEvents(prev=>prev.map(e=>e.id===id?{...e,command:(e.command||"")+(p.delta||"")}:e));
    } else if(message.method==="turn/diff/updated"){
      const changes=p.diff?.changes || p.changes || [];
      setEvents(prev=>[...prev,{id:`diff-${Date.now()}`,kind:"fileChange",title:"Updated working tree",status:"done",raw:{changes}}]);
    } else if(message.method==="error"){
      setEvents(prev=>[...prev,{id:`error-${Date.now()}`,kind:"error",title:p.message || "Agent error",status:"done"}]);
      setRunning(false);
    }
  }


  async function browseProject(){
    const picked=await window.trebellDesktop?.pickDirectory?.();
    if(picked) setProjectPath(picked);
  }

  async function pickFiles(){
    const picked=await window.trebellDesktop?.pickFiles?.();
    if(Array.isArray(picked) && picked.length) setAttachments(prev=>[...new Set([...prev,...picked])]);
  }

  function useTemplate(name){
    const prompts={
      "Ship a feature":"Implement a useful feature in this project. First inspect the codebase, make a plan, implement it, run the relevant tests, and summarize the changes.",
      "Fix a bug":"Inspect this project for a reproducible bug, diagnose the root cause, fix it, and run the relevant tests.",
      "Review a codebase":"Inspect this codebase and explain its architecture, important execution paths, risks, and the highest-value improvements.",
      "Refactor safely":"Find a worthwhile refactor, preserve behavior, implement it with focused changes, and run tests.",
      "Browser task":"Use web research where useful to solve the task I give you, and cite what you relied on.",
      "Autonomous build":"Take the project from its current state to a working validated result. Plan, implement, test, fix failures, and continue until validation passes.",
    };
    setPrompt(prompts[name]||"");
    setSection("chat");
  }

  async function renameThread(){
    if(!rpc || rpcStatus!=="connected" || !activeThread?.id) return;
    const next=window.prompt("Rename thread",titleOf(activeThread));
    if(!next?.trim()) return;
    await rpc.request("thread/name/set",{threadId:activeThread.id,name:next.trim()});
    setActiveThread(prev=>({...prev,name:next.trim()}));
    setThreads(prev=>prev.map(t=>t.id===activeThread.id?{...t,name:next.trim()}:t));
  }

  async function archiveThread(){
    if(!rpc || rpcStatus!=="connected" || !activeThread?.id) return;
    await rpc.request("thread/archive",{threadId:activeThread.id}).catch(()=>null);
    setThreads(prev=>prev.filter(t=>t.id!==activeThread.id));
    await newChat();
  }

  async function shareThread(){
    const content=[...messages,...(assistantText?[{role:"assistant",text:assistantText}]:[])].map(m=>(m.role==="user"?"You":"Trebell Code")+": "+m.text).join("\n\n");
    if(!content) return;
    await navigator.clipboard?.writeText(content).catch(()=>{});
  }

  async function openPanelReal(kind){
    setPanel(kind);
    setFilePreview(null);
    if(kind==="files"){
      setPanelLoading(true);
      const data=await fetch(`/api/workspace/tree?path=${encodeURIComponent(projectPath||bootstrap.cwd||"")}`).then(r=>r.json()).catch(()=>({entries:[]}));
      setWorkspaceEntries(data.entries||[]);
      setPanelLoading(false);
    }else if(kind==="diff"){
      setPanelLoading(true);
      const data=await fetch(`/api/workspace/diff?path=${encodeURIComponent(projectPath||bootstrap.cwd||"")}`).then(r=>r.json()).catch(()=>({diff:""}));
      setDiffText([data.status,data.diff].filter(Boolean).join("\n") || data.error || "");
      setPanelLoading(false);
    }
  }

  async function openFile(path){
    const data=await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`).then(r=>r.json()).catch(()=>null);
    if(data?.content!=null) setFilePreview(data);
  }

  async function runTerminal(){
    const command=terminalCommand.trim();
    if(!command || !rpc || rpcStatus!=="connected") return;
    setTerminalRunning(true);
    setTerminalOutput(prev=>prev ? prev+"\n\n$ "+command+"\n" : "$ "+command+"\n");
    try{
      const argv=bootstrap.platform==="win32"
        ? ["cmd.exe","/d","/s","/c",command]
        : ["sh","-lc",command];
      const cwd=projectPath||bootstrap.cwd||null;
      const sandboxPolicy=sandbox==="danger-full-access"
        ? {type:"dangerFullAccess"}
        : sandbox==="read-only"
          ? {type:"readOnly",networkAccess:false}
          : {type:"workspaceWrite",writableRoots:cwd?[cwd]:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
      const result=await rpc.request("command/exec",{
        command:argv,
        cwd,
        timeoutMs:120000,
        sandboxPolicy,
      });
      setTerminalOutput(prev=>prev+(result.stdout||"")+(result.stderr||"")+"\n[exit "+result.exitCode+"]");
    }catch(error){
      setTerminalOutput(prev=>prev+"\n"+error.message);
    }finally{
      setTerminalRunning(false);
      setTerminalCommand("");
    }
  }

  async function newChat(){
    setSection("chat");
    setActiveThread(null);
    setActiveTurnId(null);
    setEvents([]);
    setAssistantText("");
    setMessages([]);
    setLastPrompt("");
    setPrompt("");
  }

  async function openThread(thread){
    setSection("chat");
    setActiveThread(thread);
    setLastPrompt(thread.preview || "");
    setEvents([]);
    setAssistantText("");
    if(rpc){
      const resumed=await rpc.request("thread/resume",{threadId:thread.id,model:model||null,modelProvider:"freebuff",cwd:projectPath||null,excludeTurns:false}).catch(()=>null);
      if(resumed?.thread){
        setActiveThread(resumed.thread);
        setMessages(historyFromThread(resumed.thread));
      }
    }
  }

  async function ensureThread(){
    if(activeThread?.id) return activeThread.id;
    const result=await rpc.request("thread/start",{
      model:model||null,
      modelProvider:"freebuff",
      cwd:projectPath||null,
      approvalPolicy,
      sandbox,
      ephemeral:false,
      threadSource:"trebell-code",
      developerInstructions:webSearch
        ? "Web research is allowed when useful to the task."
        : "Do not use web search or browser research for this thread unless the user explicitly asks to re-enable it.",
    });
    const thread=result.thread;
    setActiveThread(thread);
    setThreads(prev=>[thread,...prev]);
    return thread.id;
  }

  async function send(){
    const text=prompt.trim();
    if(!text || running) return;
    setPrompt("");
    setLastPrompt(text);
    setAssistantText("");
    setMessages(prev=>[...prev,{id:"user-"+Date.now(),role:"user",text}]);
    setEvents([]);
    setRunning(true);
    setSection("chat");

    if(bootstrap.mock){
      try{
        const response=await fetch("/api/chat/direct",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:text,model:model||"freebuff/deepseek/deepseek-v4-flash"})});
        const data=await response.json();
        setAssistantText("");
        if(data.text) setMessages(prev=>[...prev,{id:"assistant-"+Date.now(),role:"assistant",text:data.text}]);
        setEvents([{id:"mock-direct",kind:"tool",title:"Freebuff direct path",status:"done"}]);
      }finally{setRunning(false);}
      return;
    }

    if(!rpc || rpcStatus!=="connected"){
      try{
        const response=await fetch("/api/chat/direct",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:text,model})});
        const data=await response.json();
        if(!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        setAssistantText("");
        if(data.text) setMessages(prev=>[...prev,{id:"assistant-"+Date.now(),role:"assistant",text:data.text}]);
        setEvents([{id:"direct-freebuff",kind:"tool",title:"Answered via Freebuff direct fallback",status:"done"}]);
      }catch(error){
        setEvents([{id:"send-error",kind:"error",title:error.message,status:"done"}]);
      }finally{
        setRunning(false);
        setAttachments([]);
      }
      return;
    }
    try{
      const threadId=await ensureThread();
      const result=await rpc.request("turn/start",{
        threadId,
        model:model||null,
        approvalPolicy,
        cwd:projectPath||null,
        input:[
        {type:"text",text,text_elements:[]},
        ...attachments.map(path=>{
          const lower=path.toLowerCase();
          if(/\.(png|jpe?g|gif|webp|bmp)$/.test(lower)) return {type:"localImage",path};
          if(/\.(mp3|wav|m4a|ogg|flac)$/.test(lower)) return {type:"localAudio",path};
          return {type:"mention",name:path.split(/[\\/]/).pop(),path};
        }),
      ],
      });
      setActiveTurnId(result?.turn?.id || null);
      setAttachments([]);
    }catch(error){
      setRunning(false);
      setEvents([{id:"send-error",kind:"error",title:error.message,status:"done"}]);
    }
  }

  async function stop(){
    if(bootstrap.mock){ setRunning(false); return; }
    if(rpc && activeThread?.id && activeTurnId){
      await rpc.request("turn/interrupt",{threadId:activeThread.id,turnId:activeTurnId}).catch(()=>{});
    }
    setRunning(false);
  }

  function resolveApproval(request, decision){
    if(!rpc) return;
    let result={decision};
    if(request.method==="item/permissions/requestApproval"){
      result={permissions:request.params?.permissions || {},scope:decision==="acceptForSession"?"session":"turn"};
    }
    rpc.respond(request.id,result);
    setApprovals(prev=>prev.filter(x=>x.id!==request.id));
  }

  async function login(){
    await fetch("/api/login/start",{method:"POST"}).catch(()=>{});
    const poll=setInterval(async()=>{
      const data=await fetch("/api/bootstrap").then(r=>r.json()).catch(()=>null);
      if(data?.loggedIn){
        clearInterval(poll);
        setBootstrap(data);
        const modelData=await fetch("/api/models").then(r=>r.json()).catch(()=>({models:[]}));
        const freebuff=(modelData.models||[]).filter(x=>x.startsWith("freebuff/"));
        setModels(freebuff);
        const first=freebuff[0]||"";
        setModel(first);
        const params=new URLSearchParams({timezone});
        if(first) params.set("model",first);
        const overview=await fetch(`/api/freebuff/overview?${params}`).then(r=>r.json()).catch(()=>null);
        if(overview) setFreebuff(overview);
      }
    },1500);
    setTimeout(()=>clearInterval(poll),120000);
  }

  async function logout(){
    await fetch("/api/logout",{method:"POST"});
    setBootstrap(prev=>({...prev,loggedIn:false}));
    setModels([]);
    setModel("");
    setFreebuff({loggedIn:false,user:null,session:null,streak:null,derived:null});
  }

  const statusLabel=bootstrap.mock?"Demo":rpcStatus==="connected"?"Local":"Connecting";
  return (
    <div className="app-shell">
      <Sidebar section={section} setSection={setSection} threads={threads} activeThreadId={activeThread?.id} openThread={openThread} query={query} setQuery={setQuery} newChat={newChat} archiveThread={archiveThread}/>
      <main className="main-frame">
        <div className="window-bar"><span>{statusLabel}</span><div><button aria-label="Minimize" onClick={()=>window.trebellDesktop?.minimize?.()}>—</button><button aria-label="Maximize" onClick={()=>window.trebellDesktop?.maximize?.()}>□</button><button aria-label="Close" className="window-close" onClick={()=>window.trebellDesktop?.close?.()}>×</button></div></div>
        <SecondaryView section={section} setSection={setSection} projectPath={projectPath} setProjectPath={setProjectPath} sandbox={sandbox} setSandbox={setSandbox} approvalPolicy={approvalPolicy} setApprovalPolicy={setApprovalPolicy} loggedIn={bootstrap.loggedIn||bootstrap.mock} login={login} logout={logout} freebuff={freebuff} model={model} refreshFreebuff={()=>refreshFreebuff(model)} browseProject={browseProject} useTemplate={useTemplate} rpcStatus={rpcStatus} runtime={runtime} threads={threads} openThread={openThread}/>
        {(section==="chat" || section==="agent" || section==="new") && <>
          <Topbar title={activeTitle} running={running} stop={stop} openPanel={openPanelReal} renameThread={renameThread} shareThread={shareThread}/>
          <div className="conversation-scroll">
            <ConversationMessages messages={messages}/>
            {(events.length>0 || running || assistantText) && <Timeline events={events} assistantText={assistantText} openPanel={openPanelReal}/>}
            {messages.length===0 && !lastPrompt && <div className="welcome">
              <div className="welcome-orb"><Sparkles size={28}/></div>
              <h1>What should Trebell build?</h1>
              <p>Give the agent a goal. It can plan, inspect files, run commands, edit code, use tools, and validate the result.</p>
              <div className="suggestions">
                <button onClick={()=>setPrompt("Inspect this project and explain the architecture.")}>Explain this codebase</button>
                <button onClick={()=>setPrompt("Find a useful bug, fix it, and run the relevant tests.")}>Fix a bug</button>
                <button onClick={()=>setPrompt("Implement the next missing feature and validate it end-to-end.")}>Ship a feature</button>
              </div>
            </div>}
          </div>
          <Composer prompt={prompt} setPrompt={setPrompt} send={send} running={running} model={model} setModel={setModel} models={models} webSearch={webSearch} setWebSearch={setWebSearch} loggedIn={bootstrap.loggedIn||bootstrap.mock} login={login} projectPath={projectPath} freebuff={freebuff} attachments={attachments} pickFiles={pickFiles} rpcStatus={rpcStatus} openTools={()=>setSection("settings")}/>
        </>}
      </main>
      <RightRail running={running} stats={stats} events={events} approvals={approvals} resolveApproval={resolveApproval} openPanel={openPanelReal} freebuff={freebuff} model={model} setSection={setSection} rpcStatus={rpcStatus}/>
      <Panel panel={panel} close={()=>setPanel(null)} events={events} projectPath={projectPath} freebuff={freebuff} model={model} workspaceTree={workspaceEntries} diffText={diffText} panelLoading={panelLoading} filePreview={filePreview} openFile={openFile} terminalCommand={terminalCommand} setTerminalCommand={setTerminalCommand} terminalOutput={terminalOutput} runTerminal={runTerminal} terminalRunning={terminalRunning}/>
    </div>
  );
}
