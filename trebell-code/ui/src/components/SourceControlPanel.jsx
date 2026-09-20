import React,{useEffect,useState} from "react";
import { GitBranch, GitCommit, GitPullRequest, RefreshCw, Upload, Download, Plus, WandSparkles, ExternalLink, MessageSquare, CheckCircle2 } from "lucide-react";
import { api } from "../api.js";

export default function SourceControlPanel({projectPath,model,onProjectChange,onAttachPr,onLinkPr,linkedPullRequests=[]}){
  const [info,setInfo]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [prs,setPrs]=useState([]);
  const [selectedPr,setSelectedPr]=useState(null);
  const [commitMessage,setCommitMessage]=useState("");
  const [comment,setComment]=useState("");
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");

  async function refresh(){
    if(!projectPath)return;
    const [i,d,p]=await Promise.all([
      api("/api/git/info?path="+encodeURIComponent(projectPath)).catch(e=>({error:e.message,isGit:false})),
      api("/api/source-control/diagnostics?path="+encodeURIComponent(projectPath)).catch(()=>null),
      api("/api/source-control/prs?path="+encodeURIComponent(projectPath)).catch(()=>({items:[]})),
    ]);
    setInfo(i);setDiagnostics(d);setPrs(p.items||[]);
  }
  useEffect(()=>{refresh()},[projectPath]);

  async function action(action,extra={}){
    setBusy(action);setError("");
    try{
      const data=await api("/api/git/action",{method:"POST",body:{action,cwd:projectPath,...extra}});
      setInfo(data.result?.info||data.result||info);await refresh();
    }catch(e){setError(e.message)}finally{setBusy("")}
  }
  async function generate(){
    setBusy("generate");setError("");
    try{const d=await api("/api/git/commit-message",{method:"POST",body:{cwd:projectPath,model}});setCommitMessage(d.message||"")}
    catch(e){setError(e.message)}finally{setBusy("")}
  }
  async function openPr(pr){
    const d=await api("/api/source-control/pr-detail?path="+encodeURIComponent(projectPath)+"&number="+encodeURIComponent(pr.number)).catch(()=>null);
    setSelectedPr(d?.item||pr);
  }
  async function prAction(actionName,extra={}){
    setBusy(actionName);setError("");
    try{
      await api("/api/source-control/pr-action",{method:"POST",body:{cwd:projectPath,number:selectedPr.number,action:actionName,...extra}});
      await openPr(selectedPr);await refresh();
    }catch(e){setError(e.message)}finally{setBusy("")}
  }

  if(!projectPath)return <div className="empty-state">Open a project to use source control.</div>;
  if(info&&!info.isGit)return <div className="source-control"><div className="empty-state"><GitBranch size={28}/><strong>Not a Git repository</strong><span>{projectPath}</span></div></div>;

  return <div className="source-control">
    <div className="sc-toolbar">
      <div><GitBranch size={16}/><select value={info?.branch||""} onChange={e=>action("branch-switch",{name:e.target.value})}>{(info?.branches||[]).map(b=><option key={b}>{b}</option>)}</select><button onClick={()=>{const n=prompt("New branch name");if(n)action("branch-create",{name:n})}}><Plus size={13}/></button></div>
      <div><button onClick={()=>action("fetch")} disabled={!!busy}><RefreshCw size={13}/> Fetch</button><button onClick={()=>action("pull")} disabled={!!busy}><Download size={13}/> Pull</button><button onClick={()=>action("push",{setUpstream:!info?.upstream})} disabled={!!busy}><Upload size={13}/> Push</button></div>
    </div>
    {error&&<div className="inline-error">{error}</div>}
    <div className="sc-grid">
      <section className="sc-card"><h3>Changes <span>{info?.status?.length||0}</span></h3><div className="status-list">{(info?.status||[]).map(s=><div key={s.path}><code>{s.code}</code><span>{s.path}</span></div>)}{!info?.status?.length&&<p>Working tree clean.</p>}</div>
        <div className="commit-box"><textarea value={commitMessage} onChange={e=>setCommitMessage(e.target.value)} placeholder="Commit message"/><button onClick={generate} disabled={busy==="generate"}><WandSparkles size={13}/> Generate with Freebuff</button><button className="primary" onClick={()=>action("commit",{message:commitMessage})} disabled={!commitMessage.trim()||!!busy}><GitCommit size={13}/> Commit</button></div>
      </section>
      <section className="sc-card"><h3>Repository</h3><p>Root: <code>{info?.root}</code></p><p>Upstream: <code>{info?.upstream||"none"}</code></p><p>Git: {diagnostics?.git?.version||"not found"}</p><p>GitHub: {diagnostics?.github?.authenticated?"authenticated":diagnostics?.github?.installed?"not signed in":"gh not installed"}</p>
        <h4>Worktrees</h4>{(info?.worktrees||[]).map(w=><div className="worktree-row" key={w.path}><span>{w.branch||"detached"}</span><code>{w.path}</code>{w.path!==info?.root&&<button onClick={()=>onProjectChange?.(w.path)}>Open</button>}</div>)}
        <button onClick={async()=>{const branch=prompt("New worktree branch");if(!branch)return;const path=await window.trebellDesktop?.pickDirectory?.();if(path){await action("worktree-create",{branch,path,baseBranch:info?.branch});onProjectChange?.(path)}}}><Plus size={13}/> Add worktree</button>
      </section>
    </div>
    <section className="pr-card"><div className="pr-head"><h3>Pull requests</h3><button onClick={refresh}><RefreshCw size={13}/></button><button onClick={async()=>{const title=prompt("PR title",commitMessage||"Trebell Code changes");if(!title)return;const body=prompt("PR description","")||"";try{const d=await api("/api/source-control/pr",{method:"POST",body:{cwd:projectPath,title,body}});if(d.url)window.open(d.url,"_blank");await refresh()}catch(e){setError(e.message)}}}><Plus size={13}/> Create PR</button></div>
      <div className="pr-layout"><div className="pr-list">{prs.map(pr=><button key={pr.number} onClick={()=>openPr(pr)} className={selectedPr?.number===pr.number?"active":""}><GitPullRequest size={14}/><div><strong>#{pr.number} {pr.title}</strong><span>{pr.headRefName} → {pr.baseRefName}</span></div><em>{pr.state}</em></button>)}</div>
      <div className="pr-detail">{selectedPr?<>
        <h3>#{selectedPr.number} {selectedPr.title}</h3><p>{selectedPr.body||"No description."}</p><div className="pr-actions"><button onClick={()=>window.open(selectedPr.url,"_blank")}><ExternalLink size={12}/> Open</button><button onClick={()=>onAttachPr?.(selectedPr)}><MessageSquare size={12}/> Attach</button><button className={linkedPullRequests.some(x=>x.number===selectedPr.number)?"linked":""} onClick={()=>onLinkPr?.(selectedPr)}><GitPullRequest size={12}/> {linkedPullRequests.some(x=>x.number===selectedPr.number)?"Linked":"Link to thread"}</button><button onClick={()=>prAction("review",{event:"APPROVE",body:"Reviewed in Trebell Code."})}><CheckCircle2 size={12}/> Approve</button><button onClick={()=>prAction("merge",{method:"squash"})}>Merge</button></div>
        <div className="pr-comment"><textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="Write a pull-request comment…"/><button disabled={!comment.trim()||!!busy} onClick={async()=>{await prAction("comment",{body:comment});setComment("")}}><MessageSquare size={12}/> Comment</button></div>
        <h4>Reviews</h4><div className="review-list">{(selectedPr.reviews||[]).length?(selectedPr.reviews||[]).map((review,i)=><div key={review.id||i}><strong>{review.author?.login||review.author?.name||"Reviewer"}</strong><span>{review.state||"reviewed"}</span><p>{review.body||""}</p></div>):<p>No reviews yet.</p>}</div>
        <h4>Checks</h4><pre>{JSON.stringify(selectedPr.statusCheckRollup||[],null,2)}</pre>
      </>:<p>Select a pull request to inspect it.</p>}</div></div>
    </section>
  </div>;
}
