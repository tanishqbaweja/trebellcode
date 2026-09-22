import React,{useEffect,useState} from "react";
import { GitBranch, GitCommit, GitPullRequest, RefreshCw, Upload, Download, Plus, WandSparkles, ExternalLink, MessageSquare, CheckCircle2 } from "lucide-react";
import { api } from "../api.js";

export default function SourceControlPanel({projectPath,model,provider="freebuff",onProjectChange,onAttachPr,onLinkPr,linkedPullRequests=[]}){
  const [info,setInfo]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [sourceProvider,setSourceProvider]=useState("");
  const [capabilities,setCapabilities]=useState({create:true,comment:true,review:true,merge:true,updateBranch:true});
  const [prs,setPrs]=useState([]);
  const [selectedPr,setSelectedPr]=useState(null);
  const [commitMessage,setCommitMessage]=useState("");
  const [comment,setComment]=useState("");
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");

  async function refresh(providerOverride=sourceProvider){
    if(!projectPath)return;
    const [i,d]=await Promise.all([
      api("/api/git/info?path="+encodeURIComponent(projectPath)).catch(e=>({error:e.message,isGit:false})),
      api("/api/source-control/diagnostics?path="+encodeURIComponent(projectPath)+(providerOverride?"&provider="+encodeURIComponent(providerOverride):"")).catch(()=>null),
    ]);
    setInfo(i);setDiagnostics(d);
    const chosen=providerOverride||d?.selectedProvider||(d?.detectedProvider&&d.detectedProvider!=="unknown"?d.detectedProvider:"");
    if(chosen&&!sourceProvider)setSourceProvider(chosen);
    const p=await api("/api/source-control/prs?path="+encodeURIComponent(projectPath)+(chosen?"&provider="+encodeURIComponent(chosen):"")).catch(e=>({items:[],error:e.message}));
    setPrs(p.items||[]);if(p.capabilities)setCapabilities(p.capabilities);else if(chosen&&d?.capabilities?.[chosen])setCapabilities(d.capabilities[chosen]);if(p.error&&i?.remotes?.length)setError(p.error);
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
    const d=await api("/api/source-control/pr-detail?path="+encodeURIComponent(projectPath)+"&number="+encodeURIComponent(pr.number)+(sourceProvider?"&provider="+encodeURIComponent(sourceProvider):"")).catch(()=>null);
    setSelectedPr(d?.item||pr);
  }
  async function prAction(actionName,extra={}){
    setBusy(actionName);setError("");
    try{
      await api("/api/source-control/pr-action",{method:"POST",body:{cwd:projectPath,provider:sourceProvider||null,number:selectedPr.number,action:actionName,...extra}});
      await openPr(selectedPr);await refresh();
    }catch(e){setError(e.message)}finally{setBusy("")}
  }

  function stackFor(pr){
    if(!pr)return[];
    const byHead=new Map(prs.map(x=>[x.headRefName,x]));
    const byBase=new Map();
    for(const item of prs){
      const list=byBase.get(item.baseRefName)||[];
      list.push(item);byBase.set(item.baseRefName,list);
    }
    const seen=new Set([pr.number]);
    const below=[];
    let cur=pr;
    while(cur?.baseRefName&&byHead.has(cur.baseRefName)){
      const parent=byHead.get(cur.baseRefName);
      if(seen.has(parent.number))break;
      seen.add(parent.number);below.unshift(parent);cur=parent;
    }
    const above=[];
    cur=pr;
    while(true){
      const children=(byBase.get(cur.headRefName)||[]).filter(x=>!seen.has(x.number));
      if(children.length!==1)break;
      const child=children[0];seen.add(child.number);above.push(child);cur=child;
    }
    return [...below,pr,...above];
  }

  async function stackAction(kind){
    const stack=stackFor(selectedPr);
    if(stack.length<2)return;
    const label=stack.map(pr=>"#"+pr.number).join(" → ");
    if(!confirm((kind==="merge"?"Merge":"Rebase")+" stack "+label+"?"))return;
    setBusy(kind+"-stack");setError("");
    try{
      if(kind==="merge"){
        for(const pr of stack){
          await api("/api/source-control/pr-action",{method:"POST",body:{cwd:projectPath,provider:sourceProvider||null,number:pr.number,action:"merge",method:"squash"}});
        }
      }else{
        for(const pr of stack.slice(1)){
          await api("/api/source-control/pr-action",{method:"POST",body:{cwd:projectPath,provider:sourceProvider||null,number:pr.number,action:"update-branch",rebase:true}});
        }
      }
      await refresh();
      if(selectedPr)await openPr(selectedPr);
    }catch(e){setError(e.message)}
    finally{setBusy("")}
  }

  if(!projectPath)return <div className="empty-state">Open a project to use source control.</div>;
  if(info&&!info.isGit)return <div className="source-control"><div className="empty-state"><GitBranch size={28}/><strong>Not a Git repository</strong><span>{projectPath}</span><button onClick={()=>action("init")} disabled={!!busy}><Plus size={13}/> Initialize Git</button></div></div>;

  return <div className="source-control">
    <div className="sc-toolbar">
      <div><GitBranch size={16}/><select value={info?.branch||""} onChange={e=>action("branch-switch",{name:e.target.value})}>{(info?.branches||[]).map(b=><option key={b}>{b}</option>)}</select><button onClick={()=>{const n=prompt("New branch name");if(n)action("branch-create",{name:n})}}><Plus size={13}/></button></div>
      <div><button onClick={()=>action("fetch")} disabled={!!busy}><RefreshCw size={13}/> Fetch</button><button onClick={()=>action("pull")} disabled={!!busy}><Download size={13}/> Pull</button><button onClick={()=>action("push",{setUpstream:!info?.upstream})} disabled={!!busy}><Upload size={13}/> Push</button></div>
    </div>
    {error&&<div className="inline-error">{error}</div>}
    <div className="sc-grid">
      <section className="sc-card"><h3>Changes <span>{info?.status?.length||0}</span></h3><div className="status-list">{(info?.status||[]).map(s=><div key={s.path}><code>{s.code}</code><span>{s.path}</span></div>)}{!info?.status?.length&&<p>Working tree clean.</p>}</div>
        <div className="commit-box"><textarea value={commitMessage} onChange={e=>setCommitMessage(e.target.value)} placeholder="Commit message"/><button onClick={generate} disabled={busy==="generate"}><WandSparkles size={13}/> Generate with {{freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||provider}</button><button className="primary" onClick={()=>action("commit",{message:commitMessage})} disabled={!commitMessage.trim()||!!busy}><GitCommit size={13}/> Commit</button></div>
      </section>
      <section className="sc-card"><h3>Repository</h3><p>Root: <code>{info?.root}</code></p><p>Upstream: <code>{info?.upstream||"none"}</code></p><p>Git: {diagnostics?.git?.version||"not found"}</p><label>Code host<select value={sourceProvider} onChange={e=>{setSourceProvider(e.target.value);setSelectedPr(null);refresh(e.target.value)}}><option value="">Auto detect</option><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="forgejo">Forgejo / Gitea</option><option value="bitbucket">Bitbucket</option><option value="azure-devops">Azure DevOps</option></select></label><p>{sourceProvider?diagnostics?.providers?.[sourceProvider]?.label||sourceProvider:"Detected: "+(diagnostics?.detectedProvider||"unknown")} · {sourceProvider?(diagnostics?.providers?.[sourceProvider]?.authenticated?"authenticated":diagnostics?.providers?.[sourceProvider]?.installed?"needs authentication":"client/credentials missing"):"choose a provider if auto-detection is ambiguous"}</p>
        {!info?.remotes?.some(remote=>remote.name==="origin")&&sourceProvider&&diagnostics?.capabilities?.[sourceProvider]?.publish&&<button onClick={async()=>{const name=prompt("Repository name",String(info?.root||projectPath).split(/[\\/]/).filter(Boolean).pop()||"");if(!name)return;const visibility=confirm("Make this repository public?\n\nOK = public\nCancel = private")?"public":"private";setBusy("publish");setError("");try{const result=await api("/api/source-control/publish",{method:"POST",body:{cwd:projectPath,provider:sourceProvider,name,visibility}});if(result.url)window.open(result.url,"_blank");await refresh()}catch(e){setError(e.message)}finally{setBusy("")}}} disabled={!!busy||!diagnostics?.providers?.[sourceProvider]?.authenticated}><Upload size={13}/> Publish repository</button>}
        <h4>Worktrees</h4>{(info?.worktrees||[]).map(w=><div className="worktree-row" key={w.path}><span>{w.branch||"detached"}</span><code>{w.path}</code>{w.path!==info?.root&&<button onClick={()=>onProjectChange?.(w.path)}>Open</button>}</div>)}
        <button onClick={async()=>{const branch=prompt("New worktree branch");if(!branch)return;const path=await window.trebellDesktop?.pickDirectory?.();if(path){await action("worktree-create",{branch,path,baseBranch:info?.branch});onProjectChange?.(path)}}}><Plus size={13}/> Add worktree</button>
      </section>
    </div>
    <section className="pr-card"><div className="pr-head"><h3>Pull requests</h3><button onClick={refresh}><RefreshCw size={13}/></button><button onClick={async()=>{const title=prompt("PR title",commitMessage||"Trebell Code changes");if(!title)return;const body=prompt("PR description","")||"";try{const d=await api("/api/source-control/pr",{method:"POST",body:{cwd:projectPath,provider:sourceProvider||null,title,body}});if(d.url)window.open(d.url,"_blank");await refresh()}catch(e){setError(e.message)}}}><Plus size={13}/> Create PR</button></div>
      <div className="pr-layout"><div className="pr-list">{prs.map(pr=><button key={pr.number} onClick={()=>openPr(pr)} className={selectedPr?.number===pr.number?"active":""}><GitPullRequest size={14}/><div><strong>#{pr.number} {pr.title}</strong><span>{pr.headRefName} → {pr.baseRefName}</span></div><em>{pr.state}</em></button>)}</div>
      <div className="pr-detail">{selectedPr?<>
        <h3>#{selectedPr.number} {selectedPr.title}</h3><p>{selectedPr.body||"No description."}</p>
        {stackFor(selectedPr).length>1&&<div className="pr-stack"><strong>Stack</strong><span>{stackFor(selectedPr).map(pr=>"#"+pr.number).join(" → ")}</span><div><button onClick={()=>stackAction("rebase")} disabled={!!busy}>Rebase stack</button><button onClick={()=>stackAction("merge")} disabled={!!busy}>Merge stack</button></div></div>}
        <div className="pr-actions"><button onClick={()=>window.open(selectedPr.url,"_blank")}><ExternalLink size={12}/> Open</button><button onClick={()=>onAttachPr?.(selectedPr)}><MessageSquare size={12}/> Attach</button><button className={linkedPullRequests.some(x=>x.number===selectedPr.number&&x.url===selectedPr.url)?"linked":""} onClick={()=>onLinkPr?.(selectedPr)}><GitPullRequest size={12}/> {linkedPullRequests.some(x=>x.number===selectedPr.number&&x.url===selectedPr.url)?"Linked":"Link to thread"}</button>{capabilities.checkout&&<button onClick={()=>prAction("checkout")} disabled={!!busy}><Download size={12}/> Checkout</button>}{capabilities.reviewers&&<button onClick={()=>{const reviewer=prompt("Reviewer username");if(reviewer?.trim())prAction("request-reviewer",{reviewer:reviewer.trim()})}} disabled={!!busy}>Request reviewer</button>}{capabilities.review&&<button onClick={()=>prAction("review",{event:"APPROVE",body:"Reviewed in Trebell Code."})}><CheckCircle2 size={12}/> Approve</button>}{capabilities.autoMerge&&<button onClick={()=>prAction("merge",{method:"squash",auto:true})} disabled={!!busy}>Auto-merge</button>}{capabilities.merge&&<button onClick={()=>prAction("merge",{method:"squash"})}>Merge</button>}</div>
        {capabilities.comment&&<div className="pr-comment"><textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="Write a change-request comment…"/><button disabled={!comment.trim()||!!busy} onClick={async()=>{await prAction("comment",{body:comment});setComment("")}}><MessageSquare size={12}/> Comment</button></div>}
        <h4>Reviews</h4><div className="review-list">{(selectedPr.reviews||[]).length?(selectedPr.reviews||[]).map((review,i)=><div key={review.id||i}><strong>{review.author?.login||review.author?.name||"Reviewer"}</strong><span>{review.state||"reviewed"}</span><p>{review.body||""}</p></div>):<p>No reviews yet.</p>}</div>
        <h4>Checks</h4><pre>{JSON.stringify(selectedPr.statusCheckRollup||[],null,2)}</pre>
      </>:<p>Select a pull request to inspect it.</p>}</div></div>
    </section>
  </div>;
}
