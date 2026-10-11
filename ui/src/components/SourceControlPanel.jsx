import React,{useEffect,useMemo,useRef,useState} from "react";
import { GitBranch, GitCommit, GitPullRequest, RefreshCw, Upload, Download, Plus, WandSparkles, ExternalLink, MessageSquare, Eye, EyeOff, Pencil, ShieldCheck, Layers3, LoaderCircle } from "lucide-react";
import { api } from "../api.js";
import { actionError, actionErrorUnlessNamed, distinctPathParts, distinctTextParts, gitStatusBadge, gitStatusPath } from "../inspector-labels.js";
import { SOURCE_CONTROL_PAGE_SIZE, sourceControlWindow } from "../source-control-window.js";
import { DEFAULT_MODEL_PROVIDER, modelProviderLabel } from "../provider-labels.js";
import { createGitTextRequests, sourceControlContext, sourceControlContextCurrent, sourceControlErrorAfterContextChange } from "../source-control-context.js";
import PullRequestComposer from "./PullRequestComposer.jsx";
import { askText } from "./RightPanel.jsx";

// Errors that already say what failed: a harness writer names the Git text it could not write, and opening a linked thread can fail
// with "Could not restore archived thread: …", "Could not load linked thread: …" or "Linked thread was not found."; anything else
// gets the action first.
const NAMES_GIT_TEXT=/\bGit text\b/i,NAMES_LINKED_THREAD=/\b(?:linked|archived) thread\b/i;
// A worktree folder or branch that starts like a sibling's, in two parts: the shared start gives way to an ellipsis before the part
// that tells it apart does (`keep` characters of it; see distinctTextParts and inspector.css).
function DistinctText({lead,tail,keep}){return <>{lead&&<span className="worktree-lead" style={{"--keep":String(keep)}}>{lead}</span>}<span className="worktree-tail">{tail}</span></>}
// A worktree's path and branch are drawn in parts (the folder even before its parent), which the browser would copy onto separate
// lines without the hidden separator. Each is selected whole (inspector.css), and a selection of nothing but a row's branch and/or
// path copies them as written. The browser may start that selection at the end of the text before the path, so the row listens.
// A selection holding more (the Open button, other rows) is left to the browser.
function copyAsWritten(event){
  const selection=window.getSelection(),range=selection?.rangeCount?selection.getRangeAt(0):null;
  if(!range||range.collapsed)return;
  const parts=[...event.currentTarget.querySelectorAll(".worktree-branch,code")].map(part=>{
    const inside=document.createRange();inside.selectNodeContents(part);
    if(range.compareBoundaryPoints(Range.START_TO_START,inside)>0)inside.setStart(range.startContainer,range.startOffset);
    if(range.compareBoundaryPoints(Range.END_TO_END,inside)<0)inside.setEnd(range.endContainer,range.endOffset);
    return inside.toString();
  }).filter(Boolean);
  if(!parts.length||parts.join("")!==range.toString())return;
  event.clipboardData.setData("text/plain",parts.join(" "));event.preventDefault();
}

export default function SourceControlPanel({projectPath,environmentId=null,remote=false,environmentName="Local machine",model,provider=DEFAULT_MODEL_PROVIDER,agentRuntime="native",agentRuntimeInstanceId=null,agentRuntimeLabel="",threadId=null,sourceControlSettings={},onProjectChange,onAttachPr,onLinkPr,onLinkPrUrl,onOpenLinkedThread,onSelectedPrChange,onLinkedPullRequestsChanged,linkedPullRequests=[]}){
  const [info,setInfo]=useState(null);
  const [diagnostics,setDiagnostics]=useState(null);
  const [sourceProvider,setSourceProvider]=useState("");
  const [capabilities,setCapabilities]=useState({create:true,comment:true,review:true,merge:true,updateBranch:true});
  const [prs,setPrs]=useState([]);
  const [selectedPr,setSelectedPr]=useState(null);
  const [commitMessage,setCommitMessage]=useState("");
  const defaultMergeMethod=["squash","merge","rebase"].includes(sourceControlSettings?.sourceControlMergeMethod)?sourceControlSettings.sourceControlMergeMethod:"squash";
  const [stackMergeMethod,setStackMergeMethod]=useState(defaultMergeMethod);
  const [linkedThreads,setLinkedThreads]=useState([]);
  const [linkedThreadsKey,setLinkedThreadsKey]=useState(null);
  const [viewed,setViewed]=useState({prNumber:null,store:null,files:[],loading:false});
  const [busy,setBusy]=useState("");
  // An error carries the scope it describes (repository, writer or thread); see source-control-context.js.
  const [errorState,setErrorState]=useState(null);
  const error=errorState?.message||"";
  // What each read last said for the repository on screen: null until it answers, then {ok:true} or {error}. A part whose read has
  // not answered says it is loading rather than drawing an empty answer ("Changes 0", "Git: not found", "No pull requests found"),
  // and a part that could not be read says so. A later refresh keeps the last answer on screen until its own lands.
  const [reads,setReads]=useState({info:null,diagnostics:null,prs:null});
  const infoRef=useRef(info);infoRef.current=info;
  const [statusLimit,setStatusLimit]=useState(SOURCE_CONTROL_PAGE_SIZE);
  const [prLimit,setPrLimit]=useState(SOURCE_CONTROL_PAGE_SIZE);
  const [fileLimit,setFileLimit]=useState(SOURCE_CONTROL_PAGE_SIZE);
  const prDetailRef=useRef(null);
  // What the last refresh could not load: "info" (the repository itself) or "prs" (only the pull-request list, after the
  // repository view was refreshed), so a successful action reports the part that actually failed.
  const refreshFailureRef=useRef(null);
  // The context on screen. A request remembers the context it was made in, and its result or error only lands while that is still shown.
  const context=sourceControlContext({projectPath,environmentId,agentRuntime,agentRuntimeInstanceId,provider,threadId});
  const contextRef=useRef(context);contextRef.current=context;
  const shownContextRef=useRef(context);
  // Commit text ("generate") and PR text ("generate-pr") in flight, one of each kind; see createGitTextRequests.
  const [textRequests]=useState(createGitTextRequests);
  function setError(message,scope="repository"){const text=String(message||"");setErrorState(text?{message:text,scope}:null)}
  function stillShown(started,scope="repository"){return sourceControlContextCurrent(started,contextRef.current,scope)}
  function reportError(started,message,scope="repository"){if(stillShown(started,scope))setError(message,scope)}
  function startTextRequest(kind){const request=textRequests.start(kind);setBusy(kind);return request}
  // Cancelled when the writer or the repository changes: Generate is free at once, and nothing a cancelled request produces lands.
  function cancelTextRequests(){
    const kinds=textRequests.cancelAll();
    if(kinds.length)setBusy(current=>kinds.includes(current)?"":current);
  }
  useEffect(()=>{
    const previous=shownContextRef.current;shownContextRef.current=context;
    if(previous.repository===context.repository&&previous.writer===context.writer&&previous.thread===context.thread)return;
    // Text the old writer was writing, or text about the old repository, is cancelled; Generate is free for the new context.
    if(!sourceControlContextCurrent(previous,context,"writer"))cancelTextRequests();
    if(previous.repository!==context.repository)setCommitMessage("");
    setErrorState(current=>sourceControlErrorAfterContextChange(current,previous,context));
  },[context.repository,context.writer,context.thread]);
  useEffect(()=>()=>{textRequests.cancelAll()},[]);
  function query(values={}){
    const params=new URLSearchParams(values);params.set("environmentId",environmentId||"");return params.toString();
  }
  function environmentBody(values={}){return {...values,environmentId:environmentId||null}}

  // A refresh answered after the repository changed describes the old one: it is dropped, data and errors alike.
  async function refresh(providerOverride=sourceProvider,{reportErrors=false}={}){
    if(!projectPath)return;
    const started=contextRef.current;
    if(reportErrors)setError("");
    refreshFailureRef.current=null;
    const reason=error=>String(error?.message??error??"").trim()||"No reason was given.";
    const settle=(part,outcome)=>{if(stillShown(started))setReads(current=>({...current,[part]:outcome}))};
    let i;
    try{i=await api("/api/git/info?"+query({path:projectPath}))}
    catch(error){
      refreshFailureRef.current={stage:"info"};
      if(stillShown(started)&&(reportErrors||!infoRef.current))setError(actionError("Could not refresh repository information",error));
      // Nothing else is read without the repository, so a part that never answered could not be read either.
      if(stillShown(started))setReads(current=>({info:{error:reason(error)},diagnostics:current.diagnostics||{error:reason(error)},prs:current.prs||{error:reason(error)}}));
      return false;
    }
    if(!stillShown(started))return false;
    // The repository shows as soon as it answers; Git and the code host are checked after it.
    setInfo(i);settle("info",{ok:true});
    let d=null;
    try{d=await api("/api/source-control/diagnostics?"+query({path:projectPath,...(providerOverride?{provider:providerOverride}:{})}))}
    catch(error){
      if(reportErrors)reportError(started,actionError("Could not refresh source-control diagnostics",error));
      settle("diagnostics",{error:reason(error)});
    }
    if(!stillShown(started))return false;
    if(d){setDiagnostics(d);settle("diagnostics",{ok:true})}
    const chosen=providerOverride||d?.selectedProvider||(d?.detectedProvider&&d.detectedProvider!=="unknown"?d.detectedProvider:"");
    if(chosen&&!sourceProvider)setSourceProvider(chosen);
    try{
      const p=await api("/api/source-control/prs?"+query({path:projectPath,...(chosen?{provider:chosen}:{})}));
      if(!stillShown(started))return false;
      setPrs(p.items||[]);if(p.capabilities)setCapabilities(p.capabilities);else if(chosen&&d?.capabilities?.[chosen])setCapabilities(d.capabilities[chosen]);
      // A host whose client could not list them answers ok:false with its reason: that is a failure, not an empty list.
      settle("prs",p.ok===false?{error:reason(p.error)}:{ok:true});
    }catch(error){
      refreshFailureRef.current={stage:"prs",message:error.message||String(error)||"Could not refresh pull requests."};
      if(stillShown(started)&&(reportErrors||i?.remotes?.length))setError(actionError("Could not refresh pull requests",error));
      settle("prs",{error:reason(error)});
      return false;
    }
    return true;
  }
  function partialSuccess(label,issues=[],started=contextRef.current){
    const details=(Array.isArray(issues)?issues:[]).map(item=>String(item||"").trim()).filter(Boolean);
    if(details.length)reportError(started,label+", but "+details.join(" "));
  }
  async function refreshAfterSuccess(label,providerOverride=sourceProvider,started=contextRef.current){
    const refreshed=await refresh(providerOverride);
    const failure=refreshFailureRef.current;
    if(!refreshed)partialSuccess(label,[failure?.stage==="prs"?"pull requests could not be listed: "+failure.message:"the latest source-control state could not be refreshed. The last valid view is still shown."],started);
    return refreshed;
  }
  function gitActionSuccessLabel(action){
    return ({init:"Git repository was initialized","branch-create":"Branch was created","branch-switch":"Branch was switched",commit:"Commit was created",fetch:"Fetch completed",pull:"Pull completed",push:"Push completed","worktree-create":"Worktree was created"}[action]||"Git action completed");
  }
  // A failure names the action before the server's reason, so a bare git or host error never arrives without context.
  function gitActionFailureLabel(action){
    return ({init:"Could not initialize the Git repository","branch-create":"Could not create the branch","branch-switch":"Could not switch the branch",commit:"Could not commit",fetch:"Could not fetch",pull:"Could not pull",push:"Could not push","worktree-create":"Could not create the worktree"}[action]||"Git action "+action+" failed");
  }
  function prActionFailureLabel(action,extra={}){
    if(action==="merge"&&extra.auto)return "Could not turn on auto-merge";
    return ({edit:"Could not edit the pull request",checkout:"Could not check out the pull request","request-reviewer":"Could not request the reviewer","approve-workflows":"Could not approve the workflows",revert:"Could not revert the pull request",merge:"Could not merge the pull request",comment:"Could not add the comment",review:"Could not submit the review","edit-comment":"Could not edit the comment"}[action]||"Pull request action "+action+" failed");
  }
  // Another repository starts unread: what the last one answered does not describe it.
  useEffect(()=>{infoRef.current=null;setInfo(null);setDiagnostics(null);setPrs([]);setReads({info:null,diagnostics:null,prs:null});setSourceProvider("");setSelectedPr(null);onSelectedPrChange?.(null);setViewed({prNumber:null,store:null,files:[],loading:false});setLinkedThreads([]);setLinkedThreadsKey(null);refresh("")},[projectPath,environmentId]);
  useEffect(()=>{setStackMergeMethod(defaultMergeMethod)},[defaultMergeMethod]);
  useEffect(()=>{setStatusLimit(SOURCE_CONTROL_PAGE_SIZE);setPrLimit(SOURCE_CONTROL_PAGE_SIZE)},[projectPath,environmentId,sourceProvider]);
  useEffect(()=>{setFileLimit(SOURCE_CONTROL_PAGE_SIZE)},[selectedPr?.number]);

  async function action(action,extra={}){
    const started=contextRef.current;
    setBusy(action);setError("");
    try{
      const data=await api("/api/git/action",{method:"POST",body:environmentBody({action,cwd:projectPath,...extra})});
      if(!stillShown(started))return null;
      setInfo(data.result?.info||data.result||info);await refreshAfterSuccess(gitActionSuccessLabel(action),sourceProvider,started);return data;
    }catch(e){reportError(started,actionError(gitActionFailureLabel(action),e));return null}finally{setBusy("")}
  }
  // The text is written by the writer on screen when Generate was pressed. A switch of harness, profile or repository cancels it,
  // so neither its text nor its error ever shows under the next one; Generate clears the last error before it starts.
  async function generate(){
    const request=startTextRequest("generate");setError("");
    try{
      const d=await api("/api/git/commit-message",{method:"POST",body:environmentBody({cwd:projectPath,model}),signal:request.controller.signal});
      if(textRequests.current(request))setCommitMessage(d.message||"");
    }catch(e){if(textRequests.current(request))setError(actionErrorUnlessNamed("Could not generate the commit message",e,NAMES_GIT_TEXT),"writer")}
    finally{if(textRequests.finish(request))setBusy("")}
  }
  async function createReview({generateText=false}={}){
    const started=contextRef.current,text=generateText?startTextRequest("generate-pr"):null;
    if(!text)setBusy("create-pr");
    setError("");
    let ownsBusy=true;
    try{
      let suggested={title:commitMessage||"Trebell Code changes",body:""};
      if(text){
        try{suggested=await api("/api/git/review-text",{method:"POST",body:environmentBody({cwd:projectPath,model}),signal:text.controller.signal})}
        catch(e){if(!textRequests.finish(text)){ownsBusy=false;return}setError(actionErrorUnlessNamed("Could not generate the pull request text",e,NAMES_GIT_TEXT),"writer");return}
        if(!textRequests.finish(text)){ownsBusy=false;return}
      }
      const title=await askText("PR title",suggested.title||commitMessage||"Trebell Code changes");if(!title)return;
      const body=await askText("PR description",suggested.body||"");if(body==null)return;
      const d=await api("/api/source-control/pr",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,title:title.trim(),body})});
      const issues=[];
      if(d.url){
        if(threadId)try{await onLinkPrUrl?.(d.url,"created")}catch(error){issues.push("it could not be linked to this thread: "+(error.message||String(error))+".")}
        try{window.open(d.url,"_blank")}catch(error){issues.push("its browser tab could not be opened: "+(error.message||String(error))+".")}
      }
      const refreshed=await refresh();if(!refreshed)issues.push("the latest source-control state could not be refreshed. The last valid view is still shown.");
      partialSuccess("Pull request was created",issues,started);
    }catch(e){reportError(started,actionError("Could not create the pull request",e))}finally{if(ownsBusy)setBusy("")}
  }
  async function openPr(pr){
    const started=contextRef.current;
    setError("");
    let d=null;
    // The banner names what could not load; a caller that reports the failure in its own sentence gets the bare reason.
    let nextError="",nextReason="";
    const failed=(label,error)=>{nextError=actionError(label,error);nextReason=String(error?.message??error??"").trim()||nextError};
    try{d=await api("/api/source-control/pr-detail?"+query({path:projectPath,number:String(pr.number),...(sourceProvider?{provider:sourceProvider}:{})}))}
    catch(error){failed("Could not load pull request details",error)}
    if(!stillShown(started))return "";
    const item=d?.item||pr;setSelectedPr(item);onSelectedPrChange?.(item);setTimeout(()=>prDetailRef.current?.scrollIntoView({block:"start",behavior:"auto"}),0);
    const viewedError=await loadViewed(item,d?.provider||sourceProvider||item.provider);if(viewedError)failed("Could not load viewed files",viewedError);
    if(item?.identity){
      const params=new URLSearchParams({provider:item.identity.provider||"",host:item.identity.host||"",repository:item.identity.repository||"",number:String(item.identity.number||item.number)});
      const linkKey=params.toString();
      try{const reverse=await api("/api/source-control/thread-link?"+params);if(stillShown(started)){setLinkedThreads(reverse.threads||[]);setLinkedThreadsKey(linkKey)}}
      catch(error){if(stillShown(started)&&linkedThreadsKey!==linkKey){setLinkedThreads([]);setLinkedThreadsKey(linkKey)}failed("Could not load linked threads",error)}
    }else{setLinkedThreads([]);setLinkedThreadsKey(null)}
    if(!stillShown(started))return "";
    setError(nextError);return nextReason;
  }
  // Linked pull requests belong to the thread that was open when the sync started. Its links are always reported (the callback
  // of that render names that thread, and App shows them only while it is still open); its error only while it is still shown.
  async function syncLinkedPullRequests(reportErrors=false){
    if(!threadId)return;
    const started=contextRef.current;
    if(reportErrors){setBusy("sync-links");setError("")}
    try{
      const result=await api("/api/source-control/thread-link",{method:"POST",body:{action:"sync",threadId}});
      if(result?.links)onLinkedPullRequestsChanged?.(result.links);
    }catch(error){
      if(reportErrors||linkedPullRequests.length)reportError(started,"Could not sync linked pull requests: "+(error.message||String(error)||"Unknown error"),"thread");
    }finally{
      if(reportErrors)setBusy("");
    }
  }
  useEffect(()=>{if(threadId&&linkedPullRequests.length)syncLinkedPullRequests(false)},[threadId,projectPath,environmentId]);
  async function loadViewed(pr,providerOverride=sourceProvider){
    if(!pr?.number){setViewed({prNumber:null,store:null,files:[],loading:false});return ""}
    const prNumber=pr.number;
    setViewed(current=>String(current.prNumber)===String(prNumber)?{...current,loading:true}:{prNumber,store:null,files:[],loading:true});
    const params={path:projectPath,number:String(pr.number)};if(providerOverride)params.provider=providerOverride;
    try{const result=await api("/api/source-control/pr-viewed?"+query(params));setViewed({prNumber,store:result.store||null,files:result.files||[],loading:false});return ""}
    catch(error){setViewed(current=>String(current.prNumber)===String(prNumber)?{...current,loading:false}:{prNumber,store:null,files:[],loading:false});return error||new Error("")}
  }
  async function setFileViewed(file,value){
    if(!selectedPr?.number)return;const started=contextRef.current;setBusy("viewed:"+file.path);setError("");
    try{const result=await api("/api/source-control/pr-viewed",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||selectedPr.provider||null,number:selectedPr.number,files:[{path:file.path,viewed:value}]})});if(stillShown(started))setViewed({prNumber:selectedPr.number,store:result.store||viewed.store,files:result.files||[],loading:false})}
    catch(error){reportError(started,actionError("Could not mark "+file.path+(value?" viewed":" unviewed"),error))}finally{setBusy("")}
  }
  async function prAction(actionName,extra={}){
    const started=contextRef.current;
    setBusy(actionName);setError("");
    try{
      const result=await api("/api/source-control/pr-action",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,number:selectedPr.number,action:actionName,...extra})});
      if(!stillShown(started))return result;
      const issues=[];const detailError=await openPr(selectedPr);if(detailError)issues.push("the pull-request detail could not refresh: "+detailError+".");
      const refreshed=await refresh();if(!refreshed)issues.push("the latest source-control state could not be refreshed. The last valid view is still shown.");
      partialSuccess("Pull request action "+actionName+" succeeded",issues,started);
      return result;
    }catch(e){reportError(started,actionError(prActionFailureLabel(actionName,extra),e));return null}finally{setBusy("")}
  }
  async function openProjectPath(path){
    if(!path||!onProjectChange)return false;
    setBusy("open-project");setError("");
    try{await Promise.resolve(onProjectChange(path,environmentId||null));return true}
    catch(error){setError(actionError("Could not open the worktree",error));return false}
    finally{setBusy("")}
  }
  async function addWorktree(){
    const branch=await askText("New worktree branch");if(!branch)return;
    let path="";
    try{
      path=remote
        ?await askText("Remote worktree path",(String(projectPath).replace(/[\/]?$/,"")+"-"+branch.replace(/[^a-zA-Z0-9._-]+/g,"-")))
        :await window.trebellDesktop?.pickDirectory?.();
    }catch(error){setError(actionError("Could not choose a worktree folder",error));return}
    if(!path)return;
    const created=await action("worktree-create",{branch,path,baseBranch:info?.branch});
    if(created)await openProjectPath(path);
  }
  // Attaching or linking a pull request acts on the open thread, so its error belongs to that thread.
  async function runCallback(label,callback){
    if(!callback||busy)return false;
    const started=contextRef.current;
    setBusy(label);setError("");
    try{await Promise.resolve(callback());return true}
    catch(error){reportError(started,actionError(({"attach-pr":"Could not attach the pull request","link-pr":"Could not link the pull request","unlink-pr":"Could not unlink the pull request"})[label]||"Could not update the pull request",error),"thread");return false}
    finally{setBusy("")}
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
    const started=contextRef.current;
    setBusy(kind+"-stack");setError("");
    try{
      if(kind==="merge"){
        await api("/api/source-control/pr-action",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,number:selectedPr.number,action:"merge",method:stackMergeMethod})});
      }else{
        await api("/api/source-control/pr-action",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider||null,number:selectedPr.number,action:"rebase-stack"})});
      }
      if(!stillShown(started))return;
      const issues=[];const refreshed=await refresh();if(!refreshed)issues.push("the latest source-control state could not be refreshed. The last valid view is still shown.");
      if(selectedPr){const detailError=await openPr(selectedPr);if(detailError)issues.push("the pull-request detail could not refresh: "+detailError+".")}
      partialSuccess("Stack "+kind+" succeeded",issues,started);
    }catch(e){reportError(started,actionError(kind==="merge"?"Could not merge the stack":"Could not rebase the stack",e))}
    finally{setBusy("")}
  }
  async function publishRepository(){
    const localName=String(info?.root||projectPath).split(/[\\/]/).filter(Boolean).pop()||"repository";
    const labels={gitlab:"Repository path (group/project or project)",forgejo:"Repository path (owner/repository or repository)",bitbucket:"Repository path (workspace/repository)","azure-devops":"Repository path (project/repository)"};
    const defaults={bitbucket:"workspace/"+localName,"azure-devops":"project/"+localName};
    const name=await askText(labels[sourceProvider]||"Repository name",defaults[sourceProvider]||localName);if(!name)return;
    const visibility=sourceProvider==="azure-devops"?"private":confirm("Make this repository public?\n\nOK = public\nCancel = private")?"public":"private";
    const started=contextRef.current;
    setBusy("publish");setError("");
    try{
      const result=await api("/api/source-control/publish",{method:"POST",body:environmentBody({cwd:projectPath,provider:sourceProvider,name,visibility})});
      const issues=[];
      if(result.url)try{window.open(result.url,"_blank")}catch(error){issues.push("its browser tab could not be opened: "+(error.message||String(error))+".")}
      if(!stillShown(started))return;
      const refreshed=await refresh();if(!refreshed)issues.push("the latest source-control state could not be refreshed. The last valid view is still shown.");
      if(!result.pushed)issues.push("no commit was pushed yet; make the first commit, then push it to origin.");
      partialSuccess(result.pushed?"Repository was published":"Repository was created",issues,started);
    }catch(e){reportError(started,"Could not publish repository: "+(e.message||String(e)))}finally{setBusy("")}
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
  const statusWindow=useMemo(()=>sourceControlWindow(info?.status||[],{limit:statusLimit,keyOf:item=>item?.path}),[info?.status,statusLimit]);
  const prWindow=useMemo(()=>sourceControlWindow(prs,{limit:prLimit,activeKey:selectedPr?.number,keyOf:item=>item?.number}),[prs,prLimit,selectedPr?.number]);
  const fileWindow=useMemo(()=>sourceControlWindow(selectedPr?.files||[],{limit:fileLimit,keyOf:item=>item?.path}),[selectedPr?.files,fileLimit]);
  // Worktrees often share one long parent folder, so each row leads with the part of its path that tells it apart, and folder and
  // branch names that start alike ("<repo>-<branch>" folders) keep the end where they differ in view.
  const worktreeRows=useMemo(()=>{
    const worktrees=info?.worktrees||[],paths=distinctPathParts(worktrees.map(w=>w.path));
    const names=distinctTextParts(paths.map(path=>path.name)),branches=distinctTextParts(worktrees.map(w=>w.branch||"detached"));
    return worktrees.map((worktree,index)=>({worktree,path:paths[index],name:names[index],branch:branches[index]}));
  },[info?.worktrees]);
  // Commit and PR text comes from the active harness; only Trebell Native calls the model provider directly.
  const textGeneratorLabel=agentRuntime&&agentRuntime!=="native"?(agentRuntimeLabel||agentRuntime):modelProviderLabel(provider);
  // Until a read answers its parts say so; a failed one leaves them unknown (the banner, or the title, names the failure).
  const infoLoading=!info&&!reads.info?.error,infoPending=infoLoading?"checking…":"unknown";
  const diagnosticsLoading=!diagnostics&&!reads.diagnostics?.error;
  const gitVersion=diagnostics?diagnostics.git?.version||"not found":diagnosticsLoading?"checking…":"unknown";

  if(!projectPath)return <div className="empty-state">Open a project to use source control.</div>;
  if(info&&!info.isGit)return <div className="source-control"><div className="empty-state"><GitBranch size={28}/><strong>Not a Git repository</strong><span>{projectPath}</span><button onClick={()=>action("init")} disabled={!!busy}><Plus size={13}/> Initialize Git</button></div></div>;

  return <div className="source-control">
    <div className="sc-toolbar">
      <div className="sc-branch"><GitBranch size={16}/><select aria-label="Current branch" title={info?.branch?info.branch+" · switch branch":"Switch branch"} value={info?.branch||""} disabled={!info} aria-busy={infoLoading||undefined} onChange={e=>action("branch-switch",{name:e.target.value})}>{!info&&<option value="">{infoLoading?"Loading branches…":"Branches unavailable"}</option>}{(info?.branches||[]).map(b=><option key={b}>{b}</option>)}</select><button aria-label="Create branch" title="Create branch" onClick={async()=>{const n=await askText("New branch name");if(n)action("branch-create",{name:n})}}><Plus size={13}/></button></div>
      <div><button onClick={()=>action("fetch")} disabled={!!busy}><RefreshCw size={13}/> Fetch</button><button onClick={()=>action("pull")} disabled={!!busy}><Download size={13}/> Pull</button><button onClick={()=>action("push",{setUpstream:!info?.upstream})} disabled={!!busy}><Upload size={13}/> Push</button></div>
    </div>
    {error&&<div className="inline-error source-control-error" role="alert">{error}</div>}
    {branchPr&&<div className="branch-pr-badge"><GitPullRequest size={13}/><span><strong>Branch PR #{branchPr.number}</strong><small>{branchPr.title}</small></span><button onClick={()=>openPr(branchPr)}>Review</button>{threadId&&!branchPrLinked&&<button onClick={()=>runCallback("link-pr",()=>onLinkPr?.(branchPr))} disabled={!!busy}>Link this PR</button>}{threadId&&branchPrLinked&&<em>Linked</em>}</div>}
    <div className="sc-grid">
      <section className="sc-card"><h3>Changes {info&&<span>{info.status?.length||0}</span>}</h3><div className="status-list" aria-busy={infoLoading||undefined}>{statusWindow.visible.map(s=>{const badge=gitStatusBadge(s.code),path=gitStatusPath(s.path);return <div key={s.path} title={path}><code data-state={badge.kind} title={badge.title}>{badge.label}</code><span>{path}</span></div>})}{!info?(infoLoading?<p className="sc-loading">Loading changes…</p>:<p className="sc-unavailable">Changes unavailable.</p>):!info.status?.length&&<p className="sc-clean">Working tree clean.</p>}</div>
        {statusWindow.hasMore&&<div className="source-window-footer"><button onClick={()=>setStatusLimit(limit=>limit+SOURCE_CONTROL_PAGE_SIZE)}>Show {statusWindow.nextCount} more changes</button><span>{statusWindow.shown} of {statusWindow.total} shown</span></div>}
        <div className="commit-box"><textarea value={commitMessage} onChange={e=>setCommitMessage(e.target.value)} placeholder="Commit message"/><button onClick={generate} disabled={busy==="generate"}><WandSparkles size={13}/> Generate with {textGeneratorLabel}</button><button className="primary" onClick={()=>action("commit",{message:commitMessage})} disabled={!commitMessage.trim()||!!busy}><GitCommit size={13}/> Commit</button></div>
      </section>
      <section className="sc-card"><h3>Repository</h3><p>Root: {info?<code>{info.root||"—"}</code>:infoPending}</p><p>Upstream: {info?<code>{info.upstream||"none"}</code>:infoPending}</p><p title={!diagnostics&&reads.diagnostics?.error?"Could not check Git: "+reads.diagnostics.error:undefined}>Git: {gitVersion}</p><label className="source-provider-field"><span>Code host</span><select value={sourceProvider} onChange={e=>{setSourceProvider(e.target.value);setSelectedPr(null);onSelectedPrChange?.(null);setViewed({prNumber:null,store:null,files:[],loading:false});refresh(e.target.value,{reportErrors:true})}}><option value="">Auto detect</option><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="forgejo">Forgejo / Gitea</option><option value="bitbucket">Bitbucket</option><option value="azure-devops">Azure DevOps</option></select></label><p>{sourceProvider?(diagnostics?.providers?.[sourceProvider]?.label||sourceProvider)+" · "+(diagnostics?(diagnostics.providers?.[sourceProvider]?.authenticated?"authenticated":diagnostics.providers?.[sourceProvider]?.installed?"needs authentication":"client/credentials missing"):diagnosticsLoading?"checking…":"status unknown"):diagnosticsLoading?"Detecting the code host…":"Detected: "+(diagnostics?.detectedProvider||"unknown")+" · choose a provider if auto-detection is ambiguous"}</p>
        {!info?.remotes?.some(remote=>remote.name==="origin")&&sourceProvider&&diagnostics?.capabilities?.[sourceProvider]?.publish&&<button onClick={publishRepository} disabled={!!busy||!diagnostics?.providers?.[sourceProvider]?.authenticated}><Upload size={13}/> Publish repository</button>}
        {info&&<h4>Worktrees</h4>}{worktreeRows.map(({worktree:w,path,name,branch})=><div className="worktree-row" key={w.path} title={w.path} onCopy={copyAsWritten}><span className="worktree-branch" title={w.branch||undefined}><DistinctText {...branch}/></span><code><bdi className="worktree-dir">{path.dir}</bdi><span className="worktree-sep">{path.sep}</span><bdi className="worktree-name"><DistinctText {...name}/></bdi></code>{w.path!==info?.root&&<button onClick={()=>openProjectPath(w.path)} disabled={busy==="open-project"}>Open</button>}</div>)}
        {(remote||window.trebellDesktop?.pickDirectory)&&<button onClick={addWorktree} disabled={!!busy}><Plus size={13}/> Add worktree</button>}
      </section>
    </div>
    {threadId&&<section className="sc-card linked-pr-panel"><div className="linked-pr-panel-head"><h3>Linked pull requests <span>{linkedPullRequests.length}</span></h3><button onClick={()=>syncLinkedPullRequests(true)} disabled={!!busy}><RefreshCw size={12}/> Sync</button></div>{linkedGroups.length?linkedGroups.map(group=><div className="linked-pr-group" key={group.key}>{group.stack&&<div className="linked-pr-group-title"><Layers3 size={12}/><strong>Stack #{group.stack.number}</strong><span>{group.links.length} linked layer{group.links.length===1?"":"s"}</span></div>}<div>{group.links.map(link=><div className="linked-pr-row" key={pullLinkKey(link)}><button className="linked-pr-open" onClick={()=>window.open(link.url,"_blank")}><GitPullRequest size={12}/><span><strong>#{link.number} {link.snapshot?.title||link.title||"Pull request"}</strong><small>{link.identity?.repository||""} · {link.snapshot?.state||link.state||"unknown"}</small></span></button><button className="linked-pr-unlink" onClick={()=>runCallback("unlink-pr",()=>onLinkPr?.(link))} disabled={!!busy}>Unlink</button></div>)}</div></div>):<p>No pull requests linked to this thread.</p>}</section>}
    <section className="pr-card"><div className="pr-head"><h3>Pull requests</h3><button aria-label="Refresh pull requests" onClick={()=>refresh(sourceProvider,{reportErrors:true})}><RefreshCw size={13}/></button><button onClick={()=>createReview({generateText:true})} disabled={!!busy} title={"Generate the pull request text with "+textGeneratorLabel}><WandSparkles size={13}/> Generate PR</button><button onClick={()=>createReview()} disabled={!!busy}><Plus size={13}/> Create PR</button></div>
      {prs.length?<div className="pr-layout"><div className="pr-list">{prWindow.visible.map(pr=><button key={pr.number} onClick={()=>openPr(pr)} className={selectedPr?.number===pr.number?"active":""}><GitPullRequest size={14}/><div><strong>#{pr.number} {pr.title}</strong><span>{pr.headRefName} → {pr.baseRefName}{pr.stack?.position&&pr.stack?.size?" · stack "+pr.stack.position+"/"+pr.stack.size:""}</span></div><em data-state={String(pr.state||"").toLowerCase()}>{pr.state}</em></button>)}{prWindow.hasMore&&<div className="source-window-footer"><button onClick={()=>setPrLimit(limit=>limit+SOURCE_CONTROL_PAGE_SIZE)}>Show {prWindow.nextCount} more PRs</button><span>{prWindow.shown} of {prWindow.total} shown</span></div>}</div>
      <div className="pr-detail" ref={prDetailRef}>{selectedPr?<>
        <h3>#{selectedPr.number} {selectedPr.title}</h3>{linkedThreads.length>0&&<div className="pr-linked-threads"><span>Linked threads</span>{linkedThreads.map(thread=><button key={thread.threadId} title={thread.threadId} onClick={()=>Promise.resolve(onOpenLinkedThread?.(thread)).catch(error=>setError(actionErrorUnlessNamed("Could not open the linked thread",error,NAMES_LINKED_THREAD)))}>{thread.title||thread.threadId.slice(0,8)}{thread.archived?" · archived":""}</button>)}</div>}<p>{selectedPr.body||"No description."}</p>
        {selectedPr.stack&&<div className="pr-stack"><div className="pr-stack-head"><strong><Layers3 size={12}/> GitHub stack #{selectedPr.stack.number}</strong><span>Layer {selectedPr.stack.position||stackFor(selectedPr).find(layer=>layer.number===selectedPr.number)?.position||"?"} of {selectedPr.stack.size||stackFor(selectedPr).length||"?"} · base {selectedPr.stack.baseRefName||"unknown"}</span></div>{stackFor(selectedPr).length>0&&<><div className="pr-stack-layers">{stackFor(selectedPr).map(layer=><button key={layer.number} className={layer.number===selectedPr.number?"active":""} onClick={()=>layer.number===selectedPr.number?null:openPr({...layer,provider:"github"})}><span>{layer.position}</span><strong>#{layer.number} {layer.title||layer.headRefName}</strong><em>{layer.state}{layer.isDraft?" · draft":""}</em></button>)}</div><div className="pr-stack-actions"><button onClick={()=>stackAction("rebase")} disabled={!!busy}>Rebase stack</button><select aria-label="Stack merge method" value={stackMergeMethod} onChange={event=>setStackMergeMethod(event.target.value)}><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase merge</option></select><button onClick={()=>stackAction("merge")} disabled={!!busy||selectedPr.mergedAt}>Merge through #{selectedPr.number}</button></div></>}</div>}
        <div className="pr-actions"><button onClick={()=>window.open(selectedPr.url,"_blank")}><ExternalLink size={12}/> Open</button><button onClick={()=>runCallback("attach-pr",()=>onAttachPr?.(selectedPr))} disabled={!!busy}><MessageSquare size={12}/> Attach</button><button className={linkedPullRequests.some(x=>x.number===selectedPr.number&&x.url===selectedPr.url)?"linked":""} onClick={()=>runCallback(linkedPullRequests.some(x=>x.number===selectedPr.number&&x.url===selectedPr.url)?"unlink-pr":"link-pr",()=>onLinkPr?.(selectedPr))} disabled={!!busy}><GitPullRequest size={12}/> {linkedPullRequests.some(x=>x.number===selectedPr.number&&x.url===selectedPr.url)?"Linked":"Link to thread"}</button>{capabilities.edit&&<button onClick={async()=>{const title=await askText("PR title",selectedPr.title||"");if(title==null||!title.trim())return;const body=await askText("PR description",selectedPr.body||"");if(body==null)return;prAction("edit",{title:title.trim(),body})}} disabled={!!busy}><Pencil size={12}/> Edit</button>}{capabilities.checkout&&<button onClick={()=>prAction("checkout")} disabled={!!busy}><Download size={12}/> Checkout</button>}{capabilities.reviewers&&<button onClick={async()=>{const reviewer=await askText("Reviewer username");if(reviewer?.trim())prAction("request-reviewer",{reviewer:reviewer.trim()})}} disabled={!!busy}>Request reviewer</button>}{capabilities.approveWorkflows&&selectedPr.awaitingWorkflowApproval?.length>0&&<button onClick={()=>prAction("approve-workflows")} disabled={!!busy}><ShieldCheck size={12}/> Approve workflows ({selectedPr.awaitingWorkflowApproval.length})</button>}{capabilities.revert&&selectedPr.mergedAt&&selectedPr.mergeCommitSha&&<button onClick={async()=>{if(!confirm("Open a new pull request that reverts #"+selectedPr.number+"?"))return;const result=await prAction("revert");if(result?.url)window.open(result.url,"_blank")}} disabled={!!busy}><GitPullRequest size={12}/> Revert PR</button>}{capabilities.autoMerge&&!selectedPr.mergedAt&&!selectedPr.stack&&<button onClick={()=>prAction("merge",{method:defaultMergeMethod,auto:true})} disabled={!!busy}>Auto-merge</button>}{capabilities.merge&&!selectedPr.mergedAt&&!selectedPr.stack&&<button onClick={()=>prAction("merge",{method:defaultMergeMethod})} disabled={!!busy}>Merge</button>}</div>
        {(capabilities.comment||(capabilities.review&&!selectedPr.mergedAt))&&<PullRequestComposer key={(sourceProvider||selectedPr.provider||"host")+":"+selectedPr.number} canComment={Boolean(capabilities.comment)} canReview={Boolean(capabilities.review&&!selectedPr.mergedAt)} canRequestChanges={Boolean(capabilities.requestChanges)} busy={!!busy} onComment={async body=>Boolean(await prAction("comment",{body}))} onReview={async({event,body})=>Boolean(await prAction("review",{event,body}))}/>}
        {(selectedPr.files||[]).length>0&&(()=>{const currentViewed=String(viewed.prNumber)===String(selectedPr.number)?viewed:{prNumber:selectedPr.number,store:null,files:[],loading:viewed.loading};return <><div className="pr-files-head"><h4>Files</h4><span>{currentViewed.files.filter(item=>item.state==="viewed").length} / {selectedPr.files.length} {currentViewed.store==="environment"?"viewed in Trebell Code":"viewed"}</span></div><div className="pr-files">{fileWindow.visible.map(file=>{const state=currentViewed.files.find(item=>item.path===file.path)?.state||"unviewed";const isViewed=state==="viewed",stale=state==="dismissed";return <details key={file.path} className={"pr-file "+state}><summary><button type="button" className="pr-file-viewed" disabled={currentViewed.loading||busy==="viewed:"+file.path} onClick={event=>{event.preventDefault();event.stopPropagation();setFileViewed(file,!isViewed)}} aria-label={(isViewed?"Mark unviewed ":"Mark viewed ")+file.path}>{isViewed?<Eye size={12}/>:<EyeOff size={12}/>}</button><strong>{file.path}</strong><span>{stale?"changed since viewed":`${Number(file.additions||0)}+ ${Number(file.deletions||0)}−`}</span></summary>{stale&&<p>This file changed after you marked it viewed.</p>}{file.patch&&<pre>{file.patch}</pre>}</details>})}</div>{fileWindow.hasMore&&<div className="source-window-footer"><button onClick={()=>setFileLimit(limit=>limit+SOURCE_CONTROL_PAGE_SIZE)}>Show {fileWindow.nextCount} more files</button><span>{fileWindow.shown} of {fileWindow.total} shown</span></div>}</>})()}
        <h4>Conversation</h4><div className="review-list">{(selectedPr.comments||[]).length?(selectedPr.comments||[]).map((entry,i)=><div key={entry.id||i}><strong>{entry.author?.login||entry.author?.name||"Commenter"}</strong><span>{entry.canEdit?"yours":"comment"}</span><p>{entry.body||""}</p>{capabilities.editComments&&entry.canEdit&&<button className="pr-comment-edit" onClick={async()=>{const body=await askText("Edit comment",entry.body||"");if(body!=null&&body!==entry.body)prAction("edit-comment",{commentId:entry.id,body})}} disabled={!!busy}><Pencil size={11}/> Edit comment</button>}</div>):<p>No comments yet.</p>}</div>
        <h4>Reviews</h4><div className="review-list">{(selectedPr.reviews||[]).length?(selectedPr.reviews||[]).map((review,i)=><div key={review.id||i}><strong>{review.author?.login||review.author?.name||"Reviewer"}</strong><span>{review.state||"reviewed"}</span><p>{review.body||""}</p></div>):<p>No reviews yet.</p>}</div>
        <h4>Checks</h4><pre>{JSON.stringify(selectedPr.statusCheckRollup||[],null,2)}</pre>
      </>:<p>Select a pull request to inspect it.</p>}</div></div>
        :!reads.prs?<div className="pr-loading" role="status" aria-busy="true"><LoaderCircle size={18} aria-hidden="true"/><strong>Loading pull requests…</strong></div>
        :reads.prs.error&&info&&!info.remotes?.length?<div className="pr-empty-state"><GitPullRequest size={20}/><strong>No remote yet</strong><span>Pull requests are listed once this repository has a remote on a code host.</span></div>
        :reads.prs.error?<div className="pr-empty-state error"><GitPullRequest size={20}/><strong>Could not list pull requests</strong><span>{reads.prs.error}</span></div>
        :<div className="pr-empty-state"><GitPullRequest size={20}/><strong>No pull requests found</strong><span>Create a pull request or refresh after one is opened on the remote.</span></div>}
    </section>
  </div>;
}
