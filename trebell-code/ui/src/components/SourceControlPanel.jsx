import React,{useEffect,useState} from "react";
import { GitBranch, GitCommit, GitPullRequest, RefreshCw, Upload, Download, Plus, WandSparkles, ExternalLink, MessageSquare, CheckCircle2, Eye, EyeOff, Pencil, ShieldCheck, Layers3 } from "lucide-react";
import { api } from "../api.js";

export default function SourceControlPanel({projectPath,environmentId=null,remote=false,environmentName="Local machine",model,provider="freebuff",threadId=null,sourceControlSettings={},onProjectChange,onAttachPr,onLinkPr,onLinkPrUrl,onOpenLinkedThread,onSelectedPrChange,onLinkedPullRequestsChanged,linkedPullRequests=[]}){
  const [info,setInfo]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [sourceProvider,setSourceProvider]=useState("");
  const [capabilities,setCapabilities]=useState({create:true,comment:true,review:true,merge:true,updateBranch:true});
  const [prs,setPrs]=useState([]);
  const [selectedPr,setSelectedPr]=useState(null);
  const [commitMessage,setCommitMessage]=useState("");
  const [comment,setComment]=useState("");
  const defaultMergeMethod=["squash","merge","rebase"].includes(sourceControlSettings?.sourceControlMergeMethod)?sourceControlSettings.sourceControlMergeMethod:"squash";
  const [stackMergeMethod,setStackMergeMethod]=useState(defaultMergeMethod);
  const [linkedThreads,setLinkedThreads]=useState([]);
  const [viewed,setViewed]=useState({store:null,files:[],loading:false});
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  function query(values={}){
    const params=new URLSearchParams(values);params.set("environmentId",environmentId||"");return params.toString();
  }
  function environmentBody(values={}){return {...values,environmentId:environmentId||null}}

  async function refresh(providerOverride=sourceProvider){
    if(!projectPath)return;
    const [i,d]=await Promise.all([
      api("/api/git/info?"+query({path:projectPath})).catch(e=>({error:e.message,isGit:false})),
      api("/api/source-control/diagnostics?"+query({path:projectPath,...(providerOverride?{provider:providerOverride}:{})})).catch(()=>null),
    ]);
    setInfo(i);setDiagnostics(d);
    const chosen=providerOverride||d?.selectedProvider||(d?.detectedProvider&&d.detectedProvider!=="unknown"?d.detectedProvider:"");
    if(chosen&&!sourceProvider)setSourceProvider(chosen);
    const p=await api("/api/source-control/prs?"+query({path:projectPath,...(chosen?{provider:chosen}:{})})).catch(e=>({items:[],error:e.message}));
    setPrs(p.items||[]);if(p.capabilities)setCapabilities(p.capabilities);else if(chosen&&d?.capabilities?.[chosen])setCapabilities(d.capabilities[chosen]);if(p.error&&i?.remotes?.length)setError(p.error);
  }
  useEffect(()=>{setSourceProvider("");setSelectedPr(null);onSelectedPrChange?.(null);setViewed({store:null,files:[],loading:false});refresh("")},[projectPath,environmentId]);
  useEffect(()=>{setStackMergeMethod(defaultMergeMethod)},[defaultMergeMethod]);

  async function action(action,extra={}){
    setBusy(action);setError("");
    try{
      const data=await api("/api/git/action",{method:"POST",body:environmentBody({action,cwd:projectPath,...extra})});
      setInfo(data.result?.info||data.result||info);await refresh();
    }catch(e){setError(e.message)}finally{setBusy("")}
  }
  async function generate(){
    setBusy("generate");setError("");
    try{const d=await api("/api/git/commit-message",{method:"POST",body:environmentBody({cwd:projectPath,model})});setCommitMessage(d.message||"")}
    catch(e){setError(e.message)}finally{setBusy("")}
  }
  async function createReview({generateText=false}={}){
    setBusy(generateText?"generate-pr":"create-pr");setError("");
    try{
      let suggested={title:commitMessage||"Trebell Code changes",body:""};
      if(generateText)suggested=await api("/api/git/review-text",{method:"POST",body:environmentBody({cwd:projectPath,model})});
      const title=prompt("PR title",suggested.title||commitMessage||"Trebell Code changes");if(!title)return;
      const body=prompt("PR description",suggested.body||"");if(body==null)return;
      const d=await api("/api/source-control/pr",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,title:title.trim(),body})});
      if(d.url){if(threadId)await onLinkPrUrl?.(d.url,"created");window.open(d.url,"_blank")}
      await refresh();
    }catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  async function openPr(pr){
    const d=await api("/api/source-control/pr-detail?"+query({path:projectPath,number:String(pr.number),...(sourceProvider?{provider:sourceProvider}:{})})).catch(()=>null);
    const item=d?.item||pr;setSelectedPr(item);onSelectedPrChange?.(item);await loadViewed(item,d?.provider||sourceProvider||item.provider);
    if(item?.identity){
      const params=new URLSearchParams({provider:item.identity.provider||"",host:item.identity.host||"",repository:item.identity.repository||"",number:String(item.identity.number||item.number)});
      const reverse=await api("/api/source-control/thread-link?"+params).catch(()=>({threads:[]}));setLinkedThreads(reverse.threads||[]);
    }else setLinkedThreads([]);
  }
  async function syncLinkedPullRequests(){
    if(!threadId)return;
    const result=await api("/api/source-control/thread-link",{method:"POST",body:{action:"sync",threadId}}).catch(()=>null);
    if(result?.links)onLinkedPullRequestsChanged?.(result.links);
  }
  useEffect(()=>{if(threadId&&linkedPullRequests.length)syncLinkedPullRequests()},[threadId,projectPath,environmentId]);
  async function loadViewed(pr,providerOverride=sourceProvider){
    if(!pr?.number){setViewed({store:null,files:[],loading:false});return}
    setViewed(current=>({...current,loading:true}));
    const params={path:projectPath,number:String(pr.number)};if(providerOverride)params.provider=providerOverride;
    try{const result=await api("/api/source-control/pr-viewed?"+query(params));setViewed({store:result.store||null,files:result.files||[],loading:false})}
    catch(error){setViewed({store:null,files:[],loading:false});setError(error.message||String(error))}
  }
  async function setFileViewed(file,value){
    if(!selectedPr?.number)return;setBusy("viewed:"+file.path);setError("");
    try{const result=await api("/api/source-control/pr-viewed",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||selectedPr.provider||null,number:selectedPr.number,files:[{path:file.path,viewed:value}]})});setViewed({store:result.store||viewed.store,files:result.files||[],loading:false})}
    catch(error){setError(error.message||String(error))}finally{setBusy("")}
  }
  async function prAction(actionName,extra={}){
    setBusy(actionName);setError("");
    try{
      const result=await api("/api/source-control/pr-action",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,number:selectedPr.number,action:actionName,...extra})});
      await openPr(selectedPr);await refresh();
      return result;
    }catch(e){setError(e.message)}finally{setBusy("")}
  }

  function stackFor(pr){
    return Array.isArray(pr?.stack?.layers)?pr.stack.layers:[];
  }

  async function stackAction(kind){
    const stack=stackFor(selectedPr);
    if(stack.length<1||!selectedPr?.stack)return;
    const selectedPosition=Number(selectedPr.stack?.position)||stack.find(layer=>layer.number===selectedPr.number)?.position||stack.length;
    const mergeScope=stack.filter(layer=>layer.state==="OPEN"&&Number(layer.position)<=selectedPosition);
    const label=stack.map(pr=>"#"+pr.number).join(" → ");
    const promptText=kind==="merge"
      ?"Merge "+mergeScope.map(pr=>"#"+pr.number).join(" → ")+" using "+stackMergeMethod+" as one GitHub stack operation? GitHub will enforce branch rules and merge queues."
      :"Rebase stack "+label+"? This rewrites the remote stack branches bottom-to-top with force-with-lease and restarts checks. Your current checkout is not changed.";
    if(!confirm(promptText))return;
    setBusy(kind+"-stack");setError("");
    try{
      if(kind==="merge"){
        await api("/api/source-control/pr-action",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,number:selectedPr.number,action:"merge",method:stackMergeMethod})});
      }else{
        await api("/api/source-control/pr-action",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,number:selectedPr.number,action:"rebase-stack"})});
      }
      await refresh();
      if(selectedPr)await openPr(selectedPr);
    }catch(e){setError(e.message)}
    finally{setBusy("")}
  }
  const linkedGroups=(()=>{
    const groups=[];const byKey=new Map();
    for(const link of linkedPullRequests||[]){
      const key=link.stack?.kind==="native"&&link.stack?.number?"stack:"+link.identity?.host+":"+link.identity?.repository+":"+link.stack.number:"pr:"+pullLinkKey(link);
      if(!byKey.has(key)){const group={key,stack:link.stack||null,links:[]};byKey.set(key,group);groups.push(group)}
      byKey.get(key).links.push(link);
    }
    for(const group of groups)group.links.sort((a,b)=>{
      if(group.stack?.layers){const pos=new Map(group.stack.layers.map((layer,index)=>[Number(layer.number),index]));return (pos.get(Number(a.number))??999)-(pos.get(Number(b.number))??999)}
      return Number(a.number)-Number(b.number);
    });
    return groups;
  })();
  function pullLinkKey(link){const identity=link?.identity;return identity?.host&&identity?.repository&&identity?.number?[identity.host,String(identity.repository).toLowerCase(),identity.number].join("|"):String(link?.url||link?.number||"")}
  const branchPr=info?.branch?prs.find(pr=>pr.state==="OPEN"&&pr.headRefName===info.branch)||null:null;
  const branchPrLinked=branchPr?linkedPullRequests.some(link=>pullLinkKey(link)===pullLinkKey(branchPr)):false;

  if(!projectPath)return <div className="empty-state">Open a project to use source control.</div>;
  if(info&&!info.isGit)return <div className="source-control"><div className="empty-state"><GitBranch size={28}/><strong>Not a Git repository</strong><span>{projectPath}</span><button onClick={()=>action("init")} disabled={!!busy}><Plus size={13}/> Initialize Git</button></div></div>;

  return <div className="source-control">
    <div className="sc-toolbar">
      <div><GitBranch size={16}/><select value={info?.branch||""} onChange={e=>action("branch-switch",{name:e.target.value})}>{(info?.branches||[]).map(b=><option key={b}>{b}</option>)}</select><button onClick={()=>{const n=prompt("New branch name");if(n)action("branch-create",{name:n})}}><Plus size={13}/></button></div>
      <div><button onClick={()=>action("fetch")} disabled={!!busy}><RefreshCw size={13}/> Fetch</button><button onClick={()=>action("pull")} disabled={!!busy}><Download size={13}/> Pull</button><button onClick={()=>action("push",{setUpstream:!info?.upstream})} disabled={!!busy}><Upload size={13}/> Push</button></div>
    </div>
    {error&&<div className="inline-error">{error}</div>}
    {branchPr&&<div className="branch-pr-badge"><GitPullRequest size={13}/><span><strong>Branch PR #{branchPr.number}</strong><small>{branchPr.title}</small></span><button onClick={()=>openPr(branchPr)}>Review</button>{threadId&&!branchPrLinked&&<button onClick={()=>onLinkPr?.(branchPr)}>Link this PR</button>}{threadId&&branchPrLinked&&<em>Linked</em>}</div>}
    <div className="sc-grid">
      <section className="sc-card"><h3>Changes <span>{info?.status?.length||0}</span></h3><div className="status-list">{(info?.status||[]).map(s=><div key={s.path}><code>{s.code}</code><span>{s.path}</span></div>)}{!info?.status?.length&&<p>Working tree clean.</p>}</div>
        <div className="commit-box"><textarea value={commitMessage} onChange={e=>setCommitMessage(e.target.value)} placeholder="Commit message"/><button onClick={generate} disabled={busy==="generate"}><WandSparkles size={13}/> Generate with {{freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||provider}</button><button className="primary" onClick={()=>action("commit",{message:commitMessage})} disabled={!commitMessage.trim()||!!busy}><GitCommit size={13}/> Commit</button></div>
      </section>
      <section className="sc-card"><h3>Repository</h3><p>Root: <code>{info?.root}</code></p><p>Upstream: <code>{info?.upstream||"none"}</code></p><p>Git: {diagnostics?.git?.version||"not found"}</p><label className="source-provider-field"><span>Code host</span><select value={sourceProvider} onChange={e=>{setSourceProvider(e.target.value);setSelectedPr(null);onSelectedPrChange?.(null);setViewed({store:null,files:[],loading:false});refresh(e.target.value)}}><option value="">Auto detect</option><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="forgejo">Forgejo / Gitea</option><option value="bitbucket">Bitbucket</option><option value="azure-devops">Azure DevOps</option></select></label><p>{sourceProvider?diagnostics?.providers?.[sourceProvider]?.label||sourceProvider:"Detected: "+(diagnostics?.detectedProvider||"unknown")} · {sourceProvider?(diagnostics?.providers?.[sourceProvider]?.authenticated?"authenticated":diagnostics?.providers?.[sourceProvider]?.installed?"needs authentication":"client/credentials missing"):"choose a provider if auto-detection is ambiguous"}</p>
        {!info?.remotes?.some(remote=>remote.name==="origin")&&sourceProvider&&diagnostics?.capabilities?.[sourceProvider]?.publish&&<button onClick={async()=>{const localName=String(info?.root||projectPath).split(/[\\/]/).filter(Boolean).pop()||"repository";const labels={gitlab:"Repository path (group/project or project)",bitbucket:"Repository path (workspace/repository)","azure-devops":"Repository path (project/repository)"};const defaults={bitbucket:`workspace/${localName}`,"azure-devops":`project/${localName}`};const name=prompt(labels[sourceProvider]||"Repository name",defaults[sourceProvider]||localName);if(!name)return;const visibility=sourceProvider==="azure-devops"?"private":confirm("Make this repository public?\n\nOK = public\nCancel = private")?"public":"private";setBusy("publish");setError("");try{const result=await api("/api/source-control/publish",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider,name,visibility})});if(result.url)window.open(result.url,"_blank");await refresh();if(!result.pushed)setError("Repository created. Make the first commit, then push it to origin.")}catch(e){setError(e.message)}finally{setBusy("")}}} disabled={!!busy||!diagnostics?.providers?.[sourceProvider]?.authenticated}><Upload size={13}/> Publish repository</button>}
        <h4>Worktrees</h4>{(info?.worktrees||[]).map(w=><div className="worktree-row" key={w.path}><span>{w.branch||"detached"}</span><code>{w.path}</code>{w.path!==info?.root&&<button onClick={()=>onProjectChange?.(w.path,environmentId||null)}>Open</button>}</div>)}
        <button onClick={async()=>{const branch=prompt("New worktree branch");if(!branch)return;const path=remote?prompt("Remote worktree path",(String(projectPath).replace(/[\\/]?$/,"")+"-"+branch.replace(/[^a-zA-Z0-9._-]+/g,"-"))):await window.trebellDesktop?.pickDirectory?.();if(path){await action("worktree-create",{branch,path,baseBranch:info?.branch});onProjectChange?.(path,environmentId||null)}}}><Plus size={13}/> Add worktree</button>
      </section>
    </div>
    {threadId&&<section className="sc-card linked-pr-panel"><div className="linked-pr-panel-head"><h3>Linked pull requests <span>{linkedPullRequests.length}</span></h3><button onClick={syncLinkedPullRequests} disabled={!!busy}><RefreshCw size={12}/> Sync</button></div>{linkedGroups.length?linkedGroups.map(group=><div className="linked-pr-group" key={group.key}>{group.stack&&<div className="linked-pr-group-title"><Layers3 size={12}/><strong>Stack #{group.stack.number}</strong><span>{group.links.length} linked layer{group.links.length===1?"":"s"}</span></div>}<div>{group.links.map(link=><div className="linked-pr-row" key={pullLinkKey(link)}><button className="linked-pr-open" onClick={()=>window.open(link.url,"_blank")}><GitPullRequest size={12}/><span><strong>#{link.number} {link.snapshot?.title||link.title||"Pull request"}</strong><small>{link.identity?.repository||""} · {link.snapshot?.state||link.state||"unknown"}</small></span></button><button className="linked-pr-unlink" onClick={()=>onLinkPr?.(link)}>Unlink</button></div>)}</div></div>):<p>No pull requests linked to this thread.</p>}</section>}
    <section className="pr-card"><div className="pr-head"><h3>Pull requests</h3><button onClick={refresh}><RefreshCw size={13}/></button><button onClick={()=>createReview({generateText:true})} disabled={!!busy}><WandSparkles size={13}/> Generate PR</button><button onClick={()=>createReview()} disabled={!!busy}><Plus size={13}/> Create PR</button></div>
      {prs.length?<div className="pr-layout"><div className="pr-list">{prs.map(pr=><button key={pr.number} onClick={()=>openPr(pr)} className={selectedPr?.number===pr.number?"active":""}><GitPullRequest size={14}/><div><strong>#{pr.number} {pr.title}</strong><span>{pr.headRefName} → {pr.baseRefName}{pr.stack?.position&&pr.stack?.size?" · stack "+pr.stack.position+"/"+pr.stack.size:""}</span></div><em>{pr.state}</em></button>)}</div>
      <div className="pr-detail">{selectedPr?<>
        <h3>#{selectedPr.number} {selectedPr.title}</h3>{linkedThreads.length>0&&<div className="pr-linked-threads"><span>Linked threads</span>{linkedThreads.map(thread=><button key={thread.threadId} title={thread.threadId} onClick={()=>Promise.resolve(onOpenLinkedThread?.(thread)).catch(error=>setError(error.message||String(error)))}>{thread.title||thread.threadId.slice(0,8)}{thread.archived?" · archived":""}</button>)}</div>}<p>{selectedPr.body||"No description."}</p>
        {selectedPr.stack&&<div className="pr-stack"><div className="pr-stack-head"><strong><Layers3 size={12}/> GitHub stack #{selectedPr.stack.number}</strong><span>Layer {selectedPr.stack.position||stackFor(selectedPr).find(layer=>layer.number===selectedPr.number)?.position||"?"} of {selectedPr.stack.size||stackFor(selectedPr).length||"?"} · base {selectedPr.stack.baseRefName||"unknown"}</span></div>{stackFor(selectedPr).length>0&&<><div className="pr-stack-layers">{stackFor(selectedPr).map(layer=><button key={layer.number} className={layer.number===selectedPr.number?"active":""} onClick={()=>layer.number===selectedPr.number?null:openPr({...layer,provider:"github"})}><span>{layer.position}</span><strong>#{layer.number} {layer.title||layer.headRefName}</strong><em>{layer.state}{layer.isDraft?" · draft":""}</em></button>)}</div><div className="pr-stack-actions"><button onClick={()=>stackAction("rebase")} disabled={!!busy}>Rebase stack</button><select aria-label="Stack merge method" value={stackMergeMethod} onChange={event=>setStackMergeMethod(event.target.value)}><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase merge</option></select><button onClick={()=>stackAction("merge")} disabled={!!busy||selectedPr.mergedAt}>Merge through #{selectedPr.number}</button></div></>}</div>}
        <div className="pr-actions"><button onClick={()=>window.open(selectedPr.url,"_blank")}><ExternalLink size={12}/> Open</button><button onClick={()=>onAttachPr?.(selectedPr)}><MessageSquare size={12}/> Attach</button><button className={linkedPullRequests.some(x=>x.number===selectedPr.number&&x.url===selectedPr.url)?"linked":""} onClick={()=>onLinkPr?.(selectedPr)}><GitPullRequest size={12}/> {linkedPullRequests.some(x=>x.number===selectedPr.number&&x.url===selectedPr.url)?"Linked":"Link to thread"}</button>{capabilities.edit&&<button onClick={()=>{const title=prompt("PR title",selectedPr.title||"");if(title==null||!title.trim())return;const body=prompt("PR description",selectedPr.body||"");if(body==null)return;prAction("edit",{title:title.trim(),body})}} disabled={!!busy}><Pencil size={12}/> Edit</button>}{capabilities.checkout&&<button onClick={()=>prAction("checkout")} disabled={!!busy}><Download size={12}/> Checkout</button>}{capabilities.reviewers&&<button onClick={()=>{const reviewer=prompt("Reviewer username");if(reviewer?.trim())prAction("request-reviewer",{reviewer:reviewer.trim()})}} disabled={!!busy}>Request reviewer</button>}{capabilities.approveWorkflows&&selectedPr.awaitingWorkflowApproval?.length>0&&<button onClick={()=>prAction("approve-workflows")} disabled={!!busy}><ShieldCheck size={12}/> Approve workflows ({selectedPr.awaitingWorkflowApproval.length})</button>}{capabilities.revert&&selectedPr.mergedAt&&selectedPr.mergeCommitSha&&<button onClick={async()=>{if(!confirm("Open a new pull request that reverts #"+selectedPr.number+"?"))return;const result=await prAction("revert");if(result?.url)window.open(result.url,"_blank")}} disabled={!!busy}><GitPullRequest size={12}/> Revert PR</button>}{capabilities.review&&!selectedPr.mergedAt&&<button onClick={()=>prAction("review",{event:"APPROVE",body:"Reviewed in Trebell Code."})}><CheckCircle2 size={12}/> Approve</button>}{capabilities.autoMerge&&!selectedPr.mergedAt&&!selectedPr.stack&&<button onClick={()=>prAction("merge",{method:defaultMergeMethod,auto:true})} disabled={!!busy}>Auto-merge</button>}{capabilities.merge&&!selectedPr.mergedAt&&!selectedPr.stack&&<button onClick={()=>prAction("merge",{method:defaultMergeMethod})}>Merge</button>}</div>
        {capabilities.comment&&<div className="pr-comment"><textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="Write a change-request comment…"/><button disabled={!comment.trim()||!!busy} onClick={async()=>{await prAction("comment",{body:comment});setComment("")}}><MessageSquare size={12}/> Comment</button></div>}
        {(selectedPr.files||[]).length>0&&<><div className="pr-files-head"><h4>Files</h4><span>{viewed.files.filter(item=>item.state==="viewed").length} / {selectedPr.files.length} {viewed.store==="environment"?"viewed in Trebell Code":"viewed"}</span></div><div className="pr-files">{(selectedPr.files||[]).map(file=>{const state=viewed.files.find(item=>item.path===file.path)?.state||"unviewed";const isViewed=state==="viewed",stale=state==="dismissed";return <details key={file.path} className={"pr-file "+state}><summary><button type="button" className="pr-file-viewed" disabled={viewed.loading||busy==="viewed:"+file.path} onClick={event=>{event.preventDefault();event.stopPropagation();setFileViewed(file,!isViewed)}} aria-label={(isViewed?"Mark unviewed ":"Mark viewed ")+file.path}>{isViewed?<Eye size={12}/>:<EyeOff size={12}/>}</button><strong>{file.path}</strong><span>{stale?"changed since viewed":`${Number(file.additions||0)}+ ${Number(file.deletions||0)}−`}</span></summary>{stale&&<p>This file changed after you marked it viewed.</p>}{file.patch&&<pre>{file.patch}</pre>}</details>})}</div></>}
        <h4>Conversation</h4><div className="review-list">{(selectedPr.comments||[]).length?(selectedPr.comments||[]).map((entry,i)=><div key={entry.id||i}><strong>{entry.author?.login||entry.author?.name||"Commenter"}</strong><span>{entry.canEdit?"yours":"comment"}</span><p>{entry.body||""}</p>{capabilities.editComments&&entry.canEdit&&<button className="pr-comment-edit" onClick={()=>{const body=prompt("Edit comment",entry.body||"");if(body!=null&&body!==entry.body)prAction("edit-comment",{commentId:entry.id,body})}} disabled={!!busy}><Pencil size={11}/> Edit comment</button>}</div>):<p>No comments yet.</p>}</div>
        <h4>Reviews</h4><div className="review-list">{(selectedPr.reviews||[]).length?(selectedPr.reviews||[]).map((review,i)=><div key={review.id||i}><strong>{review.author?.login||review.author?.name||"Reviewer"}</strong><span>{review.state||"reviewed"}</span><p>{review.body||""}</p></div>):<p>No reviews yet.</p>}</div>
        <h4>Checks</h4><pre>{JSON.stringify(selectedPr.statusCheckRollup||[],null,2)}</pre>
      </>:<p>Select a pull request to inspect it.</p>}</div></div>:<div className="pr-empty-state"><GitPullRequest size={20}/><strong>No pull requests found</strong><span>Create a pull request or refresh after one is opened on the remote.</span></div>}
    </section>
  </div>;
}
