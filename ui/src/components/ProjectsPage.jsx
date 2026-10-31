import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import { Check, Download, ExternalLink, FolderCode, GitBranch, ImagePlus, Layers3, MessageSquareText, Pencil, Play, Plus, RefreshCw, Search, Settings2, SquareTerminal, Trash2, Workflow, X } from "lucide-react";
import { api } from "../api.js";
import { baseProjectRecord, enrichProjectRecords, projectCardDetail, projectEnvironmentLabel, summarizeProjectRefreshErrors } from "../project-enrichment.js";
import { PROJECT_PAGE_SIZE, projectGroupCounts, projectGroupKey, projectWindow } from "../project-window.js";
import { projectRemovalQuestion, projectRestoreBlocker, projectRestoreBody } from "../project-restore.js";
import { inkOn } from "../theme-utils.js";
import { startVisibilityPoll } from "../visibility-poll.js";
import { askConfirm } from "../ask-dialog.js";
import { terminalPresses } from "../terminal-keyboard.js";

// The Projects page on screen, if any. An Undo outlives the page that offered it (its toast stays while the person moves on,
// or leaves and comes back), so a restore reports to the page that shows now, or throws for the app's error toast.
let projectsOnScreen=null;
// A card's save outlives the page that sent it too: the person can leave and come back before it answers. What it did shows on the
// page on screen then. An action or hook editor whose save is on its way as they leave (editorSaves) shows again on the page they
// come back to, still saving, until the save lands (editorsLeft). One whose save fails while no Projects page is on screen shows
// there too, with what was typed, beside the failure (failureLeft). editorsSaved: what an editor's last save that landed sent, and
// the id it saved, so Save pressed once that save closed it sends nothing, and an editor it left open updates what it saved.
const editorSaves=new WeakSet(),editorsSaved=new WeakMap();let editorsLeft={action:null,hook:null},failureLeft=null;
// An action's or a hook's fields as its editor holds them.
const SCRIPT_FIELDS=["name","command","previewUrl","autoOpenPreview","runOnWorktreeCreate","waitForSetup"],HOOK_FIELDS=["name","event","command","failureMode","timeoutMs","actionsText"];
function scriptFields(value){return {name:value.name||"",command:value.command||"",previewUrl:value.previewUrl||"",autoOpenPreview:Boolean(value.autoOpenPreview),runOnWorktreeCreate:Boolean(value.runOnWorktreeCreate),waitForSetup:Boolean(value.waitForSetup)}}
function hookFields(value){return {name:value.name||"",event:value.event||"verification.required",command:value.command||"",failureMode:value.failureMode||"block",timeoutMs:Number(value.timeoutMs)||30000,actionsText:(value.actions||[]).join(", ")}}
const fieldsOf=(editor,names)=>Object.fromEntries(names.map(name=>[name,editor[name]]));
const sameFields=(editor,fields,names)=>names.every(name=>editor[name]===fields[name]);
// A save that lands closes the editor it saved, unless the person changed it since Save was pressed: it then stays open on what was
// saved with their change, so its Save updates that action or hook. An editor opened on the same action or hook while the save was on
// its way was filled from the list before it: it takes what was saved in the fields the person has not changed, so saving it does not
// put the old values back. Any other editor stays as it is.
function editorLanded(names,{opened,projectId,sent,id,saved}){
  return current=>{
    if(!current||current.projectId!==projectId)return current;
    const onSaved=reference=>Object.fromEntries(names.map(name=>[name,current[name]===reference[name]?saved[name]:current[name]]));
    if(current.opened===opened)return sameFields(current,sent,names)?null:{...current,...onSaved(sent),id,base:saved,saving:false};
    return current.id&&current.id===id?{...current,...onSaved(current.base||saved),base:saved}:current;
  };
}
// How long an Undo of a removal waits for the card saves still on their way before it puts the project back without them.
const UNDO_SAVE_WAIT_MS=4000;
// What card saves change, named as the card names it: "Permissions, name".
const SAVE_FIELD_NAMES={name:"name",icon:"icon",scripts:"actions",preferredScriptId:"actions",hooks:"hooks",recipes:"recipes",defaultModel:"Model",permissionMode:"Permissions",workspaceMode:"Workspace",worktreeSubmodules:"Submodules",worktreeCleanup:"worktree cleanup"};
function unsavedChangeNames(entries){return [...new Set(entries.flatMap(entry=>Object.keys(entry.patch||{}).map(key=>SAVE_FIELD_NAMES[key]||key)))].join(", ")}

function blankScript(){
  return {id:null,name:"",command:"",previewUrl:"",autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false};
}
function blankHook(){return {id:null,name:"",event:"verification.required",command:"",failureMode:"block",timeoutMs:30000,actionsText:""}}
// Same normalization the server applies (whole days, 1-3650, anything else means "Never"), so the field shows what was saved.
function cleanupDays(value){const text=String(value??"").trim();if(!text)return null;const days=Math.trunc(Number(text));return Number.isFinite(days)&&days>=1?Math.min(3650,days):null}
function hookEventLabel(event){return event==="verification.required"?"Required verification":event==="source-control.before"?"Before source control":"After source control"}
// A hook's Timeout (seconds) takes whole seconds from 1 to 300: what is typed beyond them is held to the nearer one, 0 as -5 is, and
// an empty field is the 30 s default.
function hookTimeoutMs(value){const text=String(value??"").trim();if(!text)return 30000;const seconds=Math.trunc(Number(text));return Number.isNaN(seconds)?30000:Math.max(1,Math.min(300,seconds))*1000}
// Cards keep their place while the page is open. The server lists projects by lastOpenedAt, which every settings save
// bumps, so without this the card being edited jumps to the top mid-edit. New projects (added or cloned) still lead.
function keepCardOrder(next,previous){
  if(!previous.length)return next;
  const rank=new Map(previous.map((project,index)=>[project.id,index]));
  return [...next.filter(project=>!rank.has(project.id)),...next.filter(project=>rank.has(project.id)).sort((a,b)=>rank.get(a.id)-rank.get(b.id))];
}

// Automatic monogram tiles carry white initials: each colour keeps them at 4.5:1 or better.
const ICON_COLORS=["#6a4df0","#2f6fe0","#1b7a57","#a8641f","#b04a69","#5b6b7f"];
function autoMonogram(name="Project"){
  const words=String(name).trim().split(/\s+/).filter(Boolean);
  const first=words[0]||"PR";if(/^[A-Za-z]\d/.test(first))return first.slice(0,2).toUpperCase();
  if(words.length>1)return (words[0][0]+words[1][0]).toUpperCase();
  const word=first;
  return (word[0]+(word[word.length-1]||word[0])).toUpperCase();
}
function autoColor(name="Project"){
  let hash=0;for(const ch of String(name))hash=(hash*31+ch.charCodeAt(0))>>>0;return ICON_COLORS[hash%ICON_COLORS.length];
}
// A field of a card as it is found again in the card drawn in its place: what names it (its label, placeholder or class), and
// which of the card's fields so named it is.
const cardFields=card=>[...card.querySelectorAll("input,select,textarea,button")];
const fieldName=field=>[field.tagName,field.type,field.getAttribute("aria-label")||field.getAttribute("placeholder")||field.getAttribute("title")||field.className||(field.closest("label")||field).textContent.trim()].join("|");
function ProjectIcon({project}){
  const icon=project.icon;
  if(icon?.kind==="image")return <span className="project-icon project-icon-image"><img src={icon.value} alt=""/></span>;
  // A colour a person picks can be light: the initials turn black where white would read under 4.5:1 on it.
  const color=icon?.color||autoColor(project.name),style={background:color,"--project-icon-ink":inkOn(color)||undefined};
  if(icon?.kind==="emoji")return <span className="project-icon project-icon-emoji" style={style}>{icon.value}</span>;
  const text=icon?.kind==="monogram"?icon.value:autoMonogram(project.name);
  return <span className="project-icon project-icon-monogram" style={style}>{text}</span>;
}

export default function ProjectsPage({currentPath,currentEnvironmentId=null,isProjectOpen=null,onOpen,onGeneralChat,onRunScript,onOpenPreview,onProjectUpdated,onProjectRemoved,onOfferUndo,models=[]}){
  const [projects,setProjects]=useState([]);
  const [cloneUrl,setCloneUrl]=useState("");
  const hasDesktopPicker=Boolean(window.trebellDesktop?.pickDirectory);
  const [cloneEnvironmentId,setCloneEnvironmentId]=useState(()=>hasDesktopPicker?"local":"");
  const [cloneParent,setCloneParent]=useState("");
  // A remote clone needs a parent directory: the field or the environment's working directory. Without one, Clone says so on
  // the field instead of doing nothing.
  const [cloneParentError,setCloneParentError]=useState("");
  const cloneParentRef=useRef(null);
  const [environmentData,setEnvironmentData]=useState({profiles:[]});
  // What the page is busy with: true, or "general" or "clone" while that one starts. Only the one starting reads "Starting…".
  const [busy,setBusy]=useState(false);
  const [editor,setEditor]=useState(()=>editorsLeft.action);
  const [hookEditor,setHookEditor]=useState(()=>editorsLeft.hook);
  const [error,setError]=useState("");
  // A failure of a card's own control is said in that card, at the end of the part the control is in (cardAlert), where the person
  // is looking: at the top of the page it was out of view of every card but the first. The page's own failures stay at its top.
  const [cardError,setCardError]=useState(null);
  const [suggestionsOpen,setSuggestionsOpen]=useState({});
  const [identityOpen,setIdentityOpen]=useState({});
  // Per project: an emptied Name field was given back its saved name, and the editor says why until the name is edited again.
  const [nameNote,setNameNote]=useState({});
  const [iconDraft,setIconDraft]=useState({});
  const [projectQuery,setProjectQuery]=useState("");
  const [projectLimit,setProjectLimit]=useState(PROJECT_PAGE_SIZE);
  // Until the list first answers there is nothing to call empty: the page says it is loading, and a failed first read says it
  // failed, with Retry, instead of "No projects yet." and "0 / 0". A later failed refresh keeps the list it has.
  const [listState,setListState]=useState("loading");
  // A read that fails again says it still could not, and is a new message (loadFailures keys it), so it is seen and said again.
  const [loadError,setLoadError]=useState("");
  const [loadFailures,setLoadFailures]=useState(0);
  const [retrying,setRetrying]=useState(false);
  const loadedRef=useRef(false);
  const projectsRef=useRef([]);
  const refreshInFlightRef=useRef(null);
  const refreshPendingRef=useRef(false);
  const refreshPendingErrorsRef=useRef(false);

  // Cleanup-rule edits that are still saving, shown on top of whatever the server last returned.
  const pendingCleanupRef=useRef(new Map());

  function commitProjects(next){
    projectsRef.current=next;setProjects(next);
  }
  function withPendingCleanup(list){
    const pending=pendingCleanupRef.current;if(!pending.size)return list;
    return list.map(project=>pending.has(project.id)?{...project,worktreeCleanup:pending.get(project.id).value}:project);
  }
  async function performRefresh({reportErrors=false}={}){
    // Environments apply the moment they answer (the Clone card and environment names need nothing else), instead of
    // waiting for every project's Git probe, which kept the Clone card out for seconds on long lists.
    const environmentPromise=api("/api/environments").then(value=>{if(value)setEnvironmentData(value);return {value,error:null}},error=>({value:null,error}));
    let d;
    try{d=await api("/api/projects")}
    catch(err){
      if(loadedRef.current)setError("Could not refresh projects: "+(err.message||String(err)));
      else{const detail=err.message||String(err);setLoadError(current=>(current?"Still could not":"Could not")+" load projects: "+detail);setLoadFailures(count=>count+1);setListState("failed")}
      await environmentPromise;
      return false;
    }
    loadedRef.current=true;setListState("ready");setLoadError("");
    const refreshErrors=[];
    const previousById=new Map(projectsRef.current.map(project=>[project.id,project]));
    const base=keepCardOrder(d.projects||[],projectsRef.current).map(project=>baseProjectRecord(project,previousById.get(project.id)||null));
    commitProjects(withPendingCleanup(base));
    const enrichmentPromise=enrichProjectRecords(base,{
      concurrency:6,
      fetchGit:project=>api("/api/git/info?path="+encodeURIComponent(project.path)),
      fetchSuggestions:project=>api("/api/project-actions/suggestions?path="+encodeURIComponent(project.path)),
      onError:(project,kind,error)=>{
        if(!reportErrors)return;
        const label=project.name||project.path,detail=error?.message||String(error);
        refreshErrors.push(label+" "+(kind==="git"?"Git":"actions")+": "+detail);
      },
    });
    const [enriched,environmentResult]=await Promise.all([enrichmentPromise,environmentPromise]);
    if(environmentResult.error&&reportErrors)refreshErrors.push("Environments: "+(environmentResult.error?.message||String(environmentResult.error)));
    commitProjects(withPendingCleanup(enriched));
    if(reportErrors){
      const summary=summarizeProjectRefreshErrors(refreshErrors);
      setError(current=>{
        if(summary)return "Projects refreshed with partial errors: "+summary;
        return /^(Could not refresh projects:|Projects refreshed with partial errors:)/.test(current)?"":current;
      });
    }
    else setError(current=>/^Could not refresh projects:/.test(current)?"":current);
    return true;
  }
  function refresh({reportErrors=false}={}){
    const inFlight=refreshInFlightRef.current;
    if(inFlight){
      refreshPendingRef.current=true;
      refreshPendingErrorsRef.current=refreshPendingErrorsRef.current||reportErrors;
      return inFlight;
    }
    const run=performRefresh({reportErrors});
    refreshInFlightRef.current=run;
    void run.finally(()=>{
      if(refreshInFlightRef.current!==run)return;
      refreshInFlightRef.current=null;
      if(!refreshPendingRef.current)return;
      const trailingReportErrors=refreshPendingErrorsRef.current;
      refreshPendingRef.current=false;refreshPendingErrorsRef.current=false;
      queueMicrotask(()=>{void refresh({reportErrors:trailingReportErrors}).catch(error=>setError("Could not refresh projects: "+(error?.message||String(error))))});
    }).catch(()=>{});
    return run;
  }
  function partialSuccess(label,issues=[]){
    const details=(Array.isArray(issues)?issues:[]).map(item=>String(item||"").trim()).filter(Boolean);
    if(details.length)setError(`${label}, but ${details.join(" ")}`);
  }
  async function freshRefresh({reportErrors=false}={}){
    const active=refreshInFlightRef.current;if(active)await active.catch(()=>false);
    return refresh({reportErrors});
  }
  async function refreshAfterSuccess(label){
    const refreshed=await freshRefresh({reportErrors:true});
    if(!refreshed)partialSuccess(label,["the project list could not refresh. The last valid project data is still shown."]);
    return refreshed;
  }
  useEffect(()=>{refresh({reportErrors:true})},[]);
  // An environment Undo can land while this page shows (its toast outlives Environments): the cards stop calling the
  // environment unavailable, and removing one of its projects offers the Undo again.
  useEffect(()=>{const changed=()=>{void refresh()};window.addEventListener("trebell:environments-changed",changed);return()=>window.removeEventListener("trebell:environments-changed",changed)},[]);
  // Retry stays focusable while it reads (aria-disabled, not disabled), so the keyboard is still on it when the read fails again.
  async function retryLoad(){if(retrying)return;setRetrying(true);try{await refresh({reportErrors:true})}finally{setRetrying(false)}}
  useEffect(()=>{
    if(hasDesktopPicker||cloneEnvironmentId||!environmentData.profiles?.length)return;
    const first=environmentData.profiles[0];setCloneEnvironmentId(first.id);setCloneParent(first.cwd||"");
  },[hasDesktopPicker,cloneEnvironmentId,environmentData.profiles]);
  useEffect(()=>setProjectLimit(PROJECT_PAGE_SIZE),[projectQuery]);
  const cloning=projects.some(project=>["running","cancelling"].includes(project.cloneJob?.status));
  useEffect(()=>{if(!cloning)return;const poll=startVisibilityPoll(()=>refresh(),{intervalMs:750});return()=>poll.dispose()},[cloning]);

  // The part of a card a save's failure is said in: the one whose control sent it. A run or delete of one action is said under
  // that action's row ("action:" and its id): at the end of a long action list it was out of view of the row.
  function cardArea(patch){return patch.scripts?"actions":patch.hooks?"hooks":"worktreeCleanup" in patch?"cleanup":"name" in patch||"icon" in patch?"identity":"overrides"}
  function failInCard(project,area,text){setError("");setCardError({id:project.id,area,text})}
  // It is brought into view when it shows: under a control at the bottom of the window it would start below it. One a save said while
  // no Projects page was on screen shows once the cards are listed.
  const cardErrorRef=useRef(null);
  useEffect(()=>{if(cardError)cardErrorRef.current?.scrollIntoView({block:"nearest"})},[cardError,listState]);
  const cardAlert=(project,area)=>cardError?.id===project.id&&cardError.area===area&&<p ref={cardErrorRef} className="provider-status-error project-card-error" role="alert">{cardError.text}</p>;
  // A card's save names its project (id), so the server applies it to that project only: one still on its way when the person
  // removes the project reaches the server after the removal and is refused, instead of creating the project again under its
  // folder's name. Each save is kept here per project until it is answered, and one refused because this page removed the project
  // (removingRef) stays: Undo waits for the first and puts the second back with the project, so a setting changed or a name typed
  // just before Remove is not lost.
  const savesRef=useRef(new Map()),removingRef=useRef(new Set());
  // The page a save reports to once it is answered: this one, or the one the person came back to after leaving it. A failure said
  // while no Projects page is on screen waits for the next one (failureLeft).
  const onScreen=()=>projectsOnScreen?.current||screenRef.current;
  function failSave(project,area,text){const page=projectsOnScreen?.current;if(page)page.failInCard(project,area,text);else failureLeft={id:project.id,area,text}}
  async function saveProject(project,patch,area=cardArea(patch)){
    setError("");setCardError(null);
    const saves=savesRef.current.get(project.id)||new Set(),entry={patch,gone:false};let settle=()=>{};entry.settled=new Promise(resolve=>{settle=resolve});
    savesRef.current.set(project.id,saves);saves.add(entry);
    let result;
    try{
      result=await api("/api/projects",{method:"POST",body:{id:project.id,path:project.path,environmentId:project.environmentId||null,...patch}});
    }catch(err){
      if(err?.status===404&&removingRef.current.has(project.id)){entry.gone=true;return null}
      failSave(project,area,err.message||String(err));return null;
    }finally{if(!entry.gone)saves.delete(entry);entry.answered=true;settle()}
    const issues=[],page=onScreen();
    try{onProjectUpdated?.(result.project)}catch(err){issues.push("the local project view could not apply the saved update: "+(err.message||String(err))+".")}
    const refreshed=await page.freshRefresh({reportErrors:true});if(!refreshed)issues.push("the project list could not refresh. The last valid project data is still shown.");
    page.partialSuccess("Project settings were saved",issues);
    return result.project||project;
  }
  async function openProject(project){
    setCardError(null);
    if(project.managedWorktree?.cleanedAt){
      setBusy(true);setError("");
      try{await api("/api/worktree/ensure",{method:"POST",body:{path:project.path}});await refresh()}
      catch(err){failInCard(project,"open","Could not restore managed worktree: "+(err.message||String(err)));return}
      finally{setBusy(false)}
    }
    try{await Promise.resolve(onOpen(project.path,project.environmentId||null))}
    catch(err){failInCard(project,"open","Could not open project: "+(err.message||String(err)))}
  }
  async function startGeneralChat(){
    if(!onGeneralChat||busy)return;
    setBusy("general");setError("");
    try{await Promise.resolve(onGeneralChat())}
    catch(err){setError("Could not start General chat: "+(err.message||String(err)))}
    finally{setBusy(false)}
  }
  function cleanupValue(project){return project.worktreeCleanup||null}
  // The Name field saves on Enter and when it is left. An emptied field gets the saved name back and says why; a name already
  // on its way is not sent twice, and once that save ends (or fails) the field can send again. Until then the name on its way
  // is the saved one, so an emptied field (or Escape) does not bring back the name before it for leaving the field to send. It is
  // kept per project, not on the field: a card that moves into its repository's group once Git answers is drawn again, field
  // and all, and the new field starts from it.
  const sendingNamesRef=useRef(new Map());
  function savedProjectName(project){return sendingNamesRef.current.get(project.id)||latestProject(project).name}
  function commitProjectName(project,input){
    const saved=savedProjectName(project),value=input.value.trim();
    if(!value){input.value=saved;setNameNote(current=>({...current,[project.id]:true}));return}
    if(value===saved)return;
    const sending=sendingNamesRef.current;sending.set(project.id,value);
    void saveProject(project,{name:value}).finally(()=>{if(sending.get(project.id)===value)sending.delete(project.id)});
  }
  // That redraw also took the keyboard out of the card, and with it a name typed but not yet saved. The field that has focus as the
  // old card goes is found again in the new one (fieldName) and gets back its text, its caret and the keyboard, so a person who
  // starts typing in a card straight away carries on where they were. What a card leaves that no new card takes in the same
  // commit (it was removed, or the page left) is dropped.
  const movedFieldRef=useRef(null),cardRefs=useRef(new Map());
  useLayoutEffect(()=>{movedFieldRef.current=null});
  function cardRef(id){
    if(!cardRefs.current.has(id))cardRefs.current.set(id,card=>{
      const moved=movedFieldRef.current;
      if(moved?.id===id){
        movedFieldRef.current=null;
        const field=cardFields(card).filter(item=>fieldName(item)===moved.name)[moved.index];
        if(field){if(moved.text!=null)field.value=moved.text;field.focus();if(moved.start!=null)try{field.setSelectionRange(moved.start,moved.end,moved.direction)}catch{}}
      }
      return()=>{
        const active=document.activeElement;if(!card.contains(active)||active===card)return;
        const name=fieldName(active),typed=/^(INPUT|TEXTAREA)$/.test(active.tagName)&&!/^(checkbox|radio|file|color)$/.test(active.type);
        movedFieldRef.current={id,name,index:cardFields(card).filter(item=>fieldName(item)===name).indexOf(active),text:typed?active.value:null,start:typed?active.selectionStart:null,end:typed?active.selectionEnd:null,direction:typed?active.selectionDirection:null};
      };
    });
    return cardRefs.current.get(id);
  }
  // Each edit starts from the newest cleanup value (including edits still saving) and shows at once, so two quick
  // clicks on a slow server both stick instead of the second save overwriting the first with stale rules.
  function latestProject(project){return projectsRef.current.find(item=>item.id===project.id)||project}
  async function saveCleanup(project,worktreeCleanup){
    const token={value:worktreeCleanup};pendingCleanupRef.current.set(project.id,token);
    commitProjects(withPendingCleanup(projectsRef.current));
    let saved=null;
    try{saved=await saveProject(project,{worktreeCleanup})}
    finally{if(pendingCleanupRef.current.get(project.id)===token)pendingCleanupRef.current.delete(project.id)}
    if(!saved)void refresh();
    return saved;
  }
  async function setCleanupMode(project,mode){
    const latest=latestProject(project);
    if(mode==="inherit")return saveCleanup(latest,null);
    if(mode==="off")return saveCleanup(latest,{mode:"off"});
    const current=cleanupValue(latest)?.mode==="custom"?cleanupValue(latest).rules:{};
    return saveCleanup(latest,{mode:"custom",rules:{worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged)}});
  }
  async function setCleanupRule(project,key,value){
    const latest=latestProject(project);
    const current=cleanupValue(latest)?.mode==="custom"?cleanupValue(latest).rules:{};
    return saveCleanup(latest,{mode:"custom",rules:{worktreeAfterDays:current?.worktreeAfterDays??30,worktreeOnMerge:Boolean(current?.worktreeOnMerge),worktreeOnDelete:Boolean(current?.worktreeOnDelete),worktreeUnchanged:Boolean(current?.worktreeUnchanged),[key]:value}});
  }

  async function addLocal(){
    setBusy(true);setError("");
    try{
      let path=null;
      try{
        path=await window.trebellDesktop?.pickDirectory?.();
        if(!path)return;
        await api("/api/projects",{method:"POST",body:{path,environmentId:null,activate:true}});
      }catch(err){setError("Could not add local project: "+(err.message||String(err)));return}
      const issues=[];const refreshed=await freshRefresh({reportErrors:true});if(!refreshed)issues.push("the project list could not refresh. The last valid project data is still shown.");
      try{await Promise.resolve(onOpen(path,null))}catch(err){issues.push("the project could not be opened: "+(err.message||String(err))+".")}
      partialSuccess("Project was added",issues);
    }finally{setBusy(false)}
  }

  async function clone(){
    if(!cloneUrl.trim())return;
    const environmentId=cloneEnvironmentId==="local"?null:(cloneEnvironmentId||null);
    if(!hasDesktopPicker&&!environmentId)return;
    const remoteProfile=environmentId?environmentData.profiles?.find(item=>item.id===environmentId)||null:null;
    if(environmentId&&!(cloneParent.trim()||remoteProfile?.cwd)){
      setCloneParentError("Enter a parent directory on "+(remoteProfile?.name||"this environment")+".");
      cloneParentRef.current?.focus();
      return;
    }
    setBusy("clone");setError("");
    try{
      let result=null,destination="";
      try{
        const profile=environmentData.profiles?.find(item=>item.id===environmentId)||null;
        const parent=environmentId?(cloneParent.trim()||profile?.cwd||""):await window.trebellDesktop?.pickDirectory?.();
        if(!parent)return;
        const name=cloneUrl.replace(/\/+$/,"").split("/").pop().replace(/\.git$/,"")||"repository";
        const sep=environmentId?"/":parent.includes("\\")?"\\":"/";
        destination=parent.replace(/[\\\/]$/,"")+sep+name;
        result=await api("/api/clone-jobs",{method:"POST",body:{action:"start",url:cloneUrl.trim(),destination,environmentId}});
      }catch(err){setError(err.message||String(err));return}
      const issues=[];const refreshed=await freshRefresh({reportErrors:true});if(!refreshed)issues.push("the project list could not refresh. The last valid project data is still shown.");
      try{await Promise.resolve(onOpen(result.project?.path||destination,environmentId))}catch(err){issues.push("the cloned project could not be opened: "+(err.message||String(err))+".")}
      setCloneUrl("");partialSuccess("Clone was started",issues);
    }finally{setBusy(false)}
  }
  // A cancel or retry on its way (Enter pressed twice, or a second click) is the one a second press waits for until the list shows
  // what it did: the second sends nothing. The second click of a double click does nothing either way (pressRest): once the list
  // shows a Retry's new clone running, its Cancel is where Retry was, and that click would cancel the clone just started.
  const cloneActionsRef=useRef(new Set());
  const pressRest=event=>event.detail>1;
  async function cloneAction(project,action){
    const key=action+":"+project.cloneJob?.id,sending=cloneActionsRef.current;if(sending.has(key))return;
    setError("");setCardError(null);sending.add(key);
    try{await api("/api/clone-jobs",{method:"POST",body:{action,id:project.cloneJob?.id}});await refreshAfterSuccess("Clone "+action+" was accepted")}
    catch(err){failInCard(project,"clone",err.message||String(err))}
    finally{sending.delete(key)}
  }
  // A removal is undone from the app's toast when the listed record can put the project back as it was; when it cannot
  // (projectRestoreBlocker), the page asks first and says what goes with it.
  async function removeProject(project){
    const shown=latestProject(project),blocker=projectRestoreBlocker(shown),undoable=Boolean(onOfferUndo)&&!blocker;
    if(!undoable&&!await askConfirm(projectRemovalQuestion(shown,blocker),{confirm:"Remove project"}))return;
    const index=projectsRef.current.findIndex(item=>item.id===shown.id),name=savedProjectName(shown);
    setBusy(true);setError("");setCardError(null);
    removingRef.current.add(shown.id);
    let answer;
    try{answer=await api("/api/projects?id="+encodeURIComponent(shown.id),{method:"DELETE"})}
    catch(err){removingRef.current.delete(shown.id);failInCard(shown,"remove","Could not remove project: "+(err.message||String(err)));setBusy(false);return}
    try{
      // The server answers with the record as it removed it, with every save that reached it first: this page's copy has a save's
      // change only once the list is read again after its answer.
      const removed=answer?.project||shown;
      try{onProjectRemoved?.(removed)}catch{}
      if(undoable)onOfferUndo(`Project “${name}” removed`,()=>restoreProject(removed,{index,shown}));
      await refreshAfterSuccess("Project was removed");
    }finally{setBusy(false)}
  }
  // Undo of a removal: the removed record goes back (the server gives it a new id), with the card saves the server refused because
  // they reached it after the removal, once those still on their way are answered; the page on screen shows the card where it
  // was. A project still open when Undo runs is the active one again; one the person left meanwhile (they opened another project)
  // stays in the list only, so Undo does not take them out of where they are.
  // Undo waits for those saves a few seconds at most: one that never answers held the Undo for good. The project then comes back
  // without it, and the card says so (the app's toast, from another page, through the note this returns).
  async function restoreProject(removed,{index,shown=removed}){
    const activate=Boolean(isProjectOpen?.(removed)),saves=[...(savesRef.current.get(removed.id)||[])];
    let timer=null;
    await Promise.race([Promise.all(saves.map(entry=>entry.settled)),new Promise(resolve=>{timer=setTimeout(resolve,UNDO_SAVE_WAIT_MS)})]);
    clearTimeout(timer);
    savesRef.current.delete(removed.id);
    const record=Object.assign({},removed,...saves.filter(entry=>entry.gone).map(entry=>entry.patch));
    const missing=unsavedChangeNames(saves.filter(entry=>!entry.answered));
    const note=missing?`Project restored, but a change still saving when it was removed (${missing}) did not answer in time and is not in it.`:"";
    let restored;
    try{restored=(await api("/api/projects",{method:"POST",body:{...projectRestoreBody(record),...(activate?{activate:true}:{})}}))?.project||null}
    catch(err){const page=projectsOnScreen?.current;if(!page)throw err;page.showError("Could not restore project: "+(err.message||String(err)));return}
    const page=projectsOnScreen?.current;
    try{(page?.onProjectUpdated||onProjectUpdated)?.(restored)}catch{}
    // The note shows with the restored card as it is placed, not once the list has been read again: that read waits for every
    // card's Git state and actions, which takes seconds on a busy machine, with the card back and the change missing unexplained.
    const placed=page?.placeRestored(restored,shown,index),inCard=Boolean(note&&page&&restored?.id);
    if(inCard)page.noteInCard(restored,"remove",note);
    await placed;
    if(note&&!inCard)return note;
  }
  // The restored card takes the removed one's place (with its new id it would lead the list as a new project) and keeps
  // the removed card's Git state until the refresh reads it again. It is placed again once a refresh that began before the
  // restore lands, since that refresh's list has no such card.
  async function placeRestored(restored,removed,index){
    const place=()=>{
      if(!restored?.id)return;
      const list=projectsRef.current.filter(item=>item.id!==restored.id&&item.id!==removed.id);
      list.splice(Math.max(0,Math.min(index,list.length)),0,baseProjectRecord(restored,removed));
      commitProjects(withPendingCleanup(list));
    };
    place();
    const earlier=refreshInFlightRef.current;
    if(earlier){await earlier.catch(()=>false);place()}
    await refreshAfterSuccess("Project was restored");
  }
  const screenRef=useRef(null);
  screenRef.current={showError:setError,placeRestored,onProjectUpdated,noteInCard:(project,area,text)=>setCardError({id:project.id,area,text}),freshRefresh,failInCard,partialSuccess,updateEditor:(kind,update)=>(kind==="hook"?setHookEditor:setEditor)(update)};
  // This is the page on screen from the commit that draws it. What a save did meanwhile to the editors kept for it (editorsLeft) is
  // taken in then, and so is a failure said while no Projects page was on screen.
  useLayoutEffect(()=>{
    const page=screenRef;projectsOnScreen=page;setEditor(editorsLeft.action);setHookEditor(editorsLeft.hook);
    if(failureLeft){setCardError(failureLeft);failureLeft=null}
    return()=>{if(projectsOnScreen===page)projectsOnScreen=null};
  },[]);

  // Each editor opened is its own (opened). Its save on its way (Save pressed with Enter twice or held, or double-clicked) is the one
  // a second press waits for: the second sends nothing, and Save says it is saving (aria-disabled, so the keyboard stays on it). What
  // the save did reaches the editors wherever they are shown when it is answered (settleEditors): on the page on screen, and in those
  // kept for the next one. The editors still saving as this page goes are the next one's.
  const editorsRef=useRef(null);editorsRef.current={action:editor,hook:hookEditor};
  useEffect(()=>()=>{const saving=value=>editorSaves.has(value?.opened)?value:null;editorsLeft={action:saving(editorsRef.current.action),hook:saving(editorsRef.current.hook)}},[]);
  function settleEditors(kind,update){editorsLeft={...editorsLeft,[kind]:update(editorsLeft[kind])};projectsOnScreen?.current?.updateEditor(kind,update)}
  // Sends an editor's action or hook (item, with the list saved as patch(id, item)) once: a press while its save is on its way sends
  // nothing, and so does one with nothing changed since its last save landed, which closes it as that save did. A save that fails
  // leaves the editor open with what was typed.
  async function saveEditor(kind,editorValue,project,names,itemOf,patchOf,fieldsOfItem){
    const opened=editorValue.opened;if(editorSaves.has(opened))return;
    const landed=editorsSaved.get(opened),sent=fieldsOf(editorValue,names);
    if(landed&&sameFields(editorValue,landed.sent,names)){settleEditors(kind,current=>current?.opened===opened?null:current);return}
    const id=landed?.id||editorValue.id||crypto.randomUUID(),item=itemOf(id);
    editorSaves.add(opened);settleEditors(kind,current=>current?.opened===opened?{...current,saving:true}:current);
    let saved=null;
    try{saved=await saveProject(project,patchOf(id,item))}finally{editorSaves.delete(opened)}
    if(!saved){settleEditors(kind,current=>current?.opened===opened?{...current,saving:false}:current);return}
    editorsSaved.set(opened,{sent,id});
    settleEditors(kind,editorLanded(names,{opened,projectId:project.id,sent,id,saved:fieldsOfItem(item)}));
  }
  // The list with item in its place, or added: an action or hook saved since its editor opened (or one the list no longer has) is
  // the one this save updates.
  const withItem=(list=[],id,item)=>list.some(entry=>entry.id===id)?list.map(entry=>entry.id===id?item:entry):[...list,item];
  function editScript(project,script=null){
    const fields=scriptFields(script||blankScript());
    setEditor({opened:{},projectId:project.id,id:script?.id||null,...fields,base:fields});
  }

  function submitScript(project){
    if(!editor?.command.trim())return;
    const value=editor;
    return saveEditor("action",value,project,SCRIPT_FIELDS,id=>({
      id,
      name:value.name.trim()||"Project action",
      command:value.command.trim(),
      previewUrl:value.previewUrl.trim()||null,
      autoOpenPreview:Boolean(value.autoOpenPreview),
      runOnWorktreeCreate:Boolean(value.runOnWorktreeCreate),
      waitForSetup:Boolean(value.runOnWorktreeCreate&&value.waitForSetup),
    }),(id,item)=>({scripts:withItem(project.scripts,id,item),preferredScriptId:project.preferredScriptId||id}),scriptFields);
  }

  // A deleted action cannot be brought back, so Delete asks first, in the app's dialog; Cancel keeps it. The list saved without it is
  // the card's as it is once the person answers.
  async function deleteScript(project,id){
    const name=(project.scripts||[]).find(script=>script.id===id)?.name||"Project action";
    if(!await askConfirm(`Delete the action “${name}”? This cannot be undone: its command and settings are lost.`,{confirm:"Delete action"}))return;
    const current=latestProject(project),scripts=(current.scripts||[]).filter(script=>script.id!==id);
    const saved=await saveProject(current,{scripts,preferredScriptId:current.preferredScriptId===id?(scripts[0]?.id||null):current.preferredScriptId},"action:"+id);
    if(saved&&editor?.projectId===project.id&&editor?.id===id)setEditor(null);
  }

  function editHook(project,hook=null){
    const fields=hookFields(hook||blankHook());setHookEditor({opened:{},projectId:project.id,id:hook?.id||null,...fields,base:fields});
  }

  function submitHook(project){
    if(!hookEditor?.command.trim())return;
    const value=hookEditor,event=value.event;
    return saveEditor("hook",value,project,HOOK_FIELDS,id=>({id,name:value.name.trim()||hookEventLabel(event),event,command:value.command.trim(),enabled:true,failureMode:event==="source-control.after"?"warn":value.failureMode,timeoutMs:Math.max(1000,Math.min(300000,Number(value.timeoutMs)||30000)),actions:event.startsWith("source-control.")?value.actionsText.split(",").map(text=>text.trim()).filter(Boolean):[]}),(id,item)=>({hooks:withItem(project.hooks,id,item)}),hookFields);
  }

  // A deleted hook cannot be brought back either, so Delete asks first as Delete action does.
  async function deleteHook(project,id){
    const name=(project.hooks||[]).find(hook=>hook.id===id)?.name||"Lifecycle hook";
    if(!await askConfirm(`Delete the hook “${name}”? This cannot be undone: its command and settings are lost.`,{confirm:"Delete hook"}))return;
    const current=latestProject(project),saved=await saveProject(current,{hooks:(current.hooks||[]).filter(hook=>hook.id!==id)});
    if(saved&&hookEditor?.projectId===project.id&&hookEditor?.id===id)setHookEditor(null);
  }

  async function runScript(project,script){
    const pressed=terminalPresses();
    setBusy(true);setError("");setCardError(null);
    try{
      const run={path:project.path,environmentId:project.environmentId||null,scriptId:script.id};
      // The app shows the run as the header's does: its terminal, and the action running on the header's button with its Stop. The
      // terminal asks for the keyboard as of this press (pressed), so one made while the run starts keeps it (terminal-keyboard.js).
      onRunScript?.(await api("/api/project-script/run",{method:"POST",body:run}),run,pressed);
      if(script.previewUrl&&script.autoOpenPreview)onOpenPreview?.(script.previewUrl);
    }catch(err){failInCard(project,"action:"+script.id,err.message||String(err))}
    finally{setBusy(false)}
  }

  function importableScripts(project){
    const existingCommands=new Set(project.scripts.map(script=>script.command));
    const existingNames=new Set(project.scripts.map(script=>script.name.toLowerCase()));
    return (project.suggested?.scripts||[]).filter(script=>!existingCommands.has(script.command)&&!existingNames.has(String(script.name||"").toLowerCase()));
  }

  async function importScript(project,suggestion){
    const item={
      id:crypto.randomUUID(),
      name:suggestion.name,
      command:suggestion.command,
      previewUrl:suggestion.previewUrl||null,
      autoOpenPreview:Boolean(suggestion.autoOpenPreview),
      runOnWorktreeCreate:Boolean(suggestion.runOnWorktreeCreate),
      waitForSetup:Boolean(suggestion.waitForSetup),
    };
    await saveProject(project,{scripts:[...project.scripts,item],preferredScriptId:project.preferredScriptId||item.id});
  }

  async function importAll(project){
    const items=importableScripts(project).map(suggestion=>({
      id:crypto.randomUUID(),
      name:suggestion.name,
      command:suggestion.command,
      previewUrl:suggestion.previewUrl||null,
      autoOpenPreview:Boolean(suggestion.autoOpenPreview),
      runOnWorktreeCreate:Boolean(suggestion.runOnWorktreeCreate),
      waitForSetup:Boolean(suggestion.waitForSetup),
    })).slice(0,Math.max(0,30-project.scripts.length));
    if(!items.length)return;
    await saveProject(project,{scripts:[...project.scripts,...items],preferredScriptId:project.preferredScriptId||items[0].id});
  }

  // Only a picture the card can show becomes the icon: a file of another type (a .bmp) or one that does not decode (a text file
  // named .png) is refused with a message, and the icon stays as it was.
  async function importProjectImage(project,file){
    if(!file)return;setCardError(null);if(file.size>1_400_000){failInCard(project,"identity","Project icon images must be under 1.4 MB.");return}
    try{
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||""));reader.onerror=()=>reject(reader.error||new Error("Could not read image"));reader.readAsDataURL(file)});
      const image=new Image();image.src=dataUrl;
      if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)||!await image.decode().then(()=>true,()=>false)){failInCard(project,"identity",`Could not use ${file.name} as the icon: choose a png, jpeg, webp or gif image.`);return}
      await saveProject(project,{icon:{kind:"image",value:dataUrl,color:autoColor(project.name)}});
    }catch(err){failInCard(project,"identity","Could not import project image: "+(err.message||String(err)))}
  }

  const projectView=useMemo(()=>projectWindow(projects,{query:projectQuery,limit:projectLimit,currentPath,currentEnvironmentId}),[projects,projectQuery,projectLimit,currentPath,currentEnvironmentId]);
  const groupTotals=useMemo(()=>projectGroupCounts(projectView.filtered),[projectView.filtered]);
  // A section is keyed by its first project, not by its group key: that names the repository only once Git has answered, and its
  // change drew the section again, every card in it a new element, a moment after the page opened. The list keeps its order when
  // Git answers, so a repository's first checkout keeps its section and its card; a second checkout still moves into it.
  const groups=useMemo(()=>{
    const map=new Map();
    for(const project of projectView.visible){
      const environmentLabel=projectEnvironmentLabel(project,environmentData.profiles);
      const key=projectGroupKey(project);
      if(!map.has(key)) map.set(key,{key,label:project.remote||project.name,environmentLabel,projects:[],totalCount:groupTotals.get(key)||0});
      map.get(key).projects.push(project);
    }
    return [...map.values()];
  },[projectView.visible,groupTotals,environmentData.profiles]);

  return <div className="projects-page">
    <div className="page-actions project-page-actions"><div className="project-search-field"><Search size={14}/><input className="project-search" aria-label="Search projects" value={projectQuery} onChange={event=>setProjectQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"&&projectQuery){event.preventDefault();event.stopPropagation();setProjectQuery("")}}} placeholder="Search projects"/></div><span className="project-window-count">{listState==="ready"?projectView.shown+" / "+projectView.total:""}</span>{hasDesktopPicker&&<button className="project-add-local" onClick={addLocal} disabled={busy}><Plus size={14}/> Add local project</button>}<button className="project-refresh" aria-label="Refresh projects" title="Refresh projects" onClick={()=>refresh({reportErrors:true})} disabled={busy}><RefreshCw size={14}/></button></div>
    {loadError&&<div className="provider-status-error project-load-error" role="alert"><span key={loadFailures}>{loadError}</span><button type="button" className="tb-btn tb-btn--sm" onClick={retryLoad} aria-disabled={retrying?"true":undefined}>{retrying?"Retrying…":"Retry"}</button></div>}
    {error&&<p className="provider-status-error" role="alert">{error}</p>}
    <button className="general-chat-card" onClick={startGeneralChat} disabled={busy}><MessageSquareText size={22}/><span><strong>No project · General chat</strong><small>Plan, research, troubleshoot, or draft in a Trebell-managed scratch workspace.</small></span><em>{busy==="general"?"Starting…":"Start chat"}</em></button>
    {(hasDesktopPicker||(environmentData.profiles||[]).length>0)&&<div className="clone-card"><GitBranch size={20}/><div><strong>Clone repository</strong><span>Starts in the background</span></div><select aria-label="Clone environment" value={cloneEnvironmentId} onChange={e=>{const id=e.target.value;setCloneEnvironmentId(id);const profile=environmentData.profiles?.find(item=>item.id===id);setCloneParent(profile?.cwd||"");setCloneParentError("")}}>{hasDesktopPicker&&<option value="local">Local machine</option>}{!hasDesktopPicker&&!cloneEnvironmentId&&<option value="" disabled>Select environment</option>}{(environmentData.profiles||[]).map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.type.toUpperCase()}</option>)}</select><div className={"clone-inputs "+(cloneEnvironmentId==="local"?"":"remote")}><input aria-label="Clone URL" value={cloneUrl} onChange={e=>setCloneUrl(e.target.value)} placeholder="https://github.com/owner/repo.git"/>{cloneEnvironmentId!=="local"&&<input ref={cloneParentRef} aria-label="Clone parent directory" aria-invalid={cloneParentError?"true":undefined} aria-describedby={cloneParentError?"clone-parent-error":undefined} value={cloneParent} onChange={e=>{setCloneParent(e.target.value);setCloneParentError("")}} placeholder="Parent directory" title="Remote parent directory"/>}{cloneParentError&&<p id="clone-parent-error" className="clone-field-error" role="alert">{cloneParentError}</p>}</div><button onClick={clone} disabled={busy||!cloneUrl.trim()||(!hasDesktopPicker&&!cloneEnvironmentId)}>{busy==="clone"?"Starting…":"Clone"}</button></div>}
    <div className="project-groups">{groups.map(group=><section className="project-group" key={group.projects[0].id}>
      <div className="project-group-head"><Layers3 size={14}/><div><strong>{group.label}</strong><span>{group.environmentLabel} · {group.totalCount} checkout{group.totalCount===1?"":"s"}</span></div></div>
      <div className="project-grid">{group.projects.map(p=><div className={p.path===currentPath&&(p.environmentId||null)===(currentEnvironmentId||null)?"project-card active":"project-card"} key={p.id} ref={cardRef(p.id)}>
        <button className="project-open" onClick={()=>openProject(p)}><ProjectIcon project={p}/><div><strong title={p.name}>{p.name}</strong><span title={projectEnvironmentLabel(p,environmentData.profiles)+" · "+p.path}>{projectEnvironmentLabel(p,environmentData.profiles)} · {p.path}</span><small title={projectCardDetail(p)||undefined}>{projectCardDetail(p)}</small></div></button>
        <button className="project-remove" aria-label={"Remove "+p.name} onClick={()=>removeProject(p)} disabled={busy}><Trash2 size={13}/></button>
        {cardAlert(p,"open")}{cardAlert(p,"remove")}
        {p.cloneJob&&p.cloneJob.status!=="completed"&&<div className={"project-clone-status "+p.cloneJob.status}><div><strong>{p.cloneJob.phase||"Cloning repository"}</strong><span>{p.cloneJob.status==="failed"?(p.cloneJob.error||"Clone failed"):p.cloneJob.status==="cancelled"?"Clone cancelled":Math.round(p.cloneJob.progress||0)+"%"}</span></div>{["running","cancelling"].includes(p.cloneJob.status)&&<i><b style={{width:Math.max(2,Number(p.cloneJob.progress)||0)+"%"}}/></i>}<div>{p.cloneJob.status==="running"&&<button onClick={event=>{if(!pressRest(event))cloneAction(p,"cancel")}}><X size={11}/> Cancel</button>}{["failed","cancelled"].includes(p.cloneJob.status)&&<button onClick={event=>{if(!pressRest(event))cloneAction(p,"retry")}}><RefreshCw size={11}/> Retry</button>}</div>{cardAlert(p,"clone")}</div>}
        <div className="project-overrides">
          <label>Model<select value={p.defaultModel||""} onChange={e=>saveProject(p,{defaultModel:e.target.value||null})}><option value="">Inherit client default</option>{models.map(id=><option key={id} value={id}>{id}</option>)}</select></label>
          <label>Permissions<select value={p.permissionMode||""} onChange={e=>saveProject(p,{permissionMode:e.target.value||null})}><option value="">Inherit</option><option value="supervised">Supervised</option><option value="edits">Auto-accept edits</option><option value="auto">Auto</option><option value="full">Full access</option><option value="read-only">Read only</option></select></label>
          <label>Workspace<select value={p.workspaceMode||""} onChange={e=>saveProject(p,{workspaceMode:e.target.value||null})}><option value="">Inherit</option><option value="current">Current checkout</option><option value="worktree">New worktree</option></select></label>
          <label>Submodules<select value={p.worktreeSubmodules||""} onChange={e=>saveProject(p,{worktreeSubmodules:e.target.value||null})}><option value="">Inherit</option><option value="recursive">Recursive</option><option value="top-level">Top level only</option><option value="none">Skip</option></select></label>
          {cardAlert(p,"overrides")}
        </div>
        <div className="project-identity-toggle"><button onClick={()=>{setIdentityOpen(current=>({...current,[p.id]:!current[p.id]}));setNameNote(current=>({...current,[p.id]:false}))}} title="Project identity · name and icon" aria-expanded={Boolean(identityOpen[p.id])}><Settings2 size={13}/><span>Project identity</span></button></div>
        {identityOpen[p.id]&&<div className="project-identity-editor"><label>Name<input defaultValue={savedProjectName(p)} aria-describedby={nameNote[p.id]?"project-name-note-"+p.id:undefined}
          onChange={()=>{if(nameNote[p.id])setNameNote(current=>({...current,[p.id]:false}))}}
          onKeyDown={e=>{
            // Enter saves as leaving the field does, and Escape gives up the edit; either way the field keeps focus.
            if(e.key==="Enter"&&!e.nativeEvent.isComposing){e.preventDefault();commitProjectName(p,e.currentTarget)}
            else if(e.key==="Escape"){e.preventDefault();e.currentTarget.value=savedProjectName(p)}
          }}
          onBlur={e=>commitProjectName(p,e.currentTarget)}/></label>{nameNote[p.id]&&<p id={"project-name-note-"+p.id} className="project-name-note" role="status">A project needs a name, so the saved one is back.</p>}<div className="project-icon-actions"><button onClick={()=>saveProject(p,{icon:null})}>Automatic</button><button onClick={()=>setIconDraft(current=>({...current,[p.id]:{kind:"emoji",value:p.icon?.kind==="emoji"?p.icon.value:"🚀",color:p.icon?.color||autoColor(p.name)}}))}>Emoji</button><button onClick={()=>setIconDraft(current=>({...current,[p.id]:{kind:"monogram",value:p.icon?.kind==="monogram"?p.icon.value:autoMonogram(p.name),color:p.icon?.color||autoColor(p.name)}}))}>Monogram</button><button className="project-image-button" onClick={e=>e.currentTarget.nextElementSibling.click()}><ImagePlus size={12}/> Image</button><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e=>importProjectImage(p,e.target.files?.[0])}/></div>{iconDraft[p.id]&&<div className="project-icon-draft"><input maxLength={iconDraft[p.id].kind==="monogram"?2:16} value={iconDraft[p.id].value} onChange={e=>setIconDraft(current=>({...current,[p.id]:{...current[p.id],value:e.target.value}}))}/><input type="color" value={iconDraft[p.id].color||autoColor(p.name)} onChange={e=>setIconDraft(current=>({...current,[p.id]:{...current[p.id],color:e.target.value}}))}/><button onClick={async()=>{const saved=await saveProject(p,{icon:iconDraft[p.id]});if(saved)setIconDraft(current=>({...current,[p.id]:null}))}}>Save icon</button></div>}{cardAlert(p,"identity")}</div>}
        <div className="project-cleanup"><label>Automatic worktree cleanup<select value={p.worktreeCleanup?.mode||"inherit"} onChange={e=>setCleanupMode(p,e.target.value)}><option value="inherit">Inherit</option><option value="off">Off</option><option value="custom">Custom</option></select></label>{p.worktreeCleanup?.mode==="custom"&&<div className="project-cleanup-rules"><label>After inactive days<input type="number" min="1" max="3650" defaultValue={p.worktreeCleanup.rules?.worktreeAfterDays??""} placeholder="Never" onBlur={e=>{const days=cleanupDays(e.target.value);e.target.value=days==null?"":String(days);setCleanupRule(p,"worktreeAfterDays",days)}}/></label><label><input type="checkbox" checked={Boolean(p.worktreeCleanup.rules?.worktreeOnMerge)} onChange={e=>setCleanupRule(p,"worktreeOnMerge",e.target.checked)}/> After merge</label><label><input type="checkbox" checked={Boolean(p.worktreeCleanup.rules?.worktreeOnDelete)} onChange={e=>setCleanupRule(p,"worktreeOnDelete",e.target.checked)}/> After last thread deletion</label><label><input type="checkbox" checked={Boolean(p.worktreeCleanup.rules?.worktreeUnchanged)} onChange={e=>setCleanupRule(p,"worktreeUnchanged",e.target.checked)}/> If unchanged from base</label></div>}{cardAlert(p,"cleanup")}</div>

        <div className="project-actions">
          <div className="project-actions-head"><span><SquareTerminal size={13}/> Project actions</span><div>{importableScripts(p).length>0&&<button onClick={()=>setSuggestionsOpen(current=>({...current,[p.id]:!current[p.id]}))}><Download size={12}/> Import {importableScripts(p).length}</button>}<button onClick={()=>editScript(p)}><Plus size={12}/> Add action</button></div></div>
          {p.suggested?.projectFile?.present&&<div className="project-config-hint"><strong>trebell.json detected</strong><span>{[p.suggested.projectFile.defaultThreadEnvMode&&("workspace "+p.suggested.projectFile.defaultThreadEnvMode),p.suggested.projectFile.worktreeSubmodules&&("submodules "+p.suggested.projectFile.worktreeSubmodules)].filter(Boolean).join(" · ")||"Shared project actions available"}</span>{p.suggested.projectFile.defaultThreadEnvMode&&p.workspaceMode!==p.suggested.projectFile.defaultThreadEnvMode&&<button onClick={()=>saveProject(p,{workspaceMode:p.suggested.projectFile.defaultThreadEnvMode})}>Use workspace</button>}{p.suggested.projectFile.worktreeSubmodules&&p.worktreeSubmodules!==p.suggested.projectFile.worktreeSubmodules&&<button onClick={()=>saveProject(p,{worktreeSubmodules:p.suggested.projectFile.worktreeSubmodules})}>Use submodules</button>}</div>}
          {suggestionsOpen[p.id]&&importableScripts(p).length>0&&<div className="project-import-list">
            <div className="project-import-head"><span>Discovered actions</span><button onClick={()=>importAll(p)}>Import all</button></div>
            {importableScripts(p).map(script=><div key={script.source+":"+script.id}><span><strong>{script.name}</strong><small>{script.command}</small></span><em>{script.source}</em><button onClick={()=>importScript(p,script)}><Download size={11}/> Import</button></div>)}
          </div>}
          {p.scripts.length?<div className="project-action-list">{p.scripts.map(script=><React.Fragment key={script.id}><div className="project-action-row">
            <button className="project-action-run" disabled={busy} onClick={()=>runScript(p,script)}><Play size={12}/><span><strong>{script.name}</strong><small>{script.command}</small></span>{script.runOnWorktreeCreate&&<em>setup</em>}</button>
            {script.previewUrl&&<button title="Open preview" onClick={()=>onOpenPreview?.(script.previewUrl)}><ExternalLink size={12}/></button>}
            <button title="Edit action" onClick={()=>editScript(p,script)}><Pencil size={12}/></button>
            <button className="danger" title="Delete action" onClick={()=>deleteScript(p,script.id)}><Trash2 size={12}/></button>
          </div>{cardAlert(p,"action:"+script.id)}</React.Fragment>)}</div>:<p className="project-actions-empty">Save repeatable commands here: dev server, tests, setup, migrations, whatever you run constantly.</p>}
          {editor?.projectId===p.id&&<div className="project-action-editor">
            <input value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})} placeholder="Action name (e.g. Dev server)"/>
            <input value={editor.command} onChange={e=>setEditor({...editor,command:e.target.value})} placeholder="Command (e.g. npm run dev)"/>
            <input value={editor.previewUrl} onChange={e=>setEditor({...editor,previewUrl:e.target.value})} placeholder="Optional preview URL (e.g. http://localhost:5173)"/>
            <label><input type="checkbox" checked={editor.runOnWorktreeCreate} onChange={e=>setEditor({...editor,runOnWorktreeCreate:e.target.checked})}/> Run automatically when Trebell creates a worktree</label>
            <label><input type="checkbox" checked={editor.waitForSetup} disabled={!editor.runOnWorktreeCreate} onChange={e=>setEditor({...editor,waitForSetup:e.target.checked})}/> Wait for setup to finish before starting the agent</label>
            <label><input type="checkbox" checked={editor.autoOpenPreview} disabled={!editor.previewUrl.trim()} onChange={e=>setEditor({...editor,autoOpenPreview:e.target.checked})}/> Open preview when this action runs</label>
            <div><button className="primary" disabled={!editor.command.trim()} aria-disabled={editor.saving||undefined} onClick={()=>submitScript(p)}><Check size={12}/> {editor.saving?"Saving…":"Save action"}</button><button onClick={()=>setEditor(null)}><X size={12}/> Cancel</button></div>
          </div>}
          {cardAlert(p,"actions")}
        </div>
        <div className="project-hooks">
          <div className="project-actions-head"><span><Workflow size={13}/> Lifecycle hooks</span><button onClick={()=>editHook(p)}><Plus size={12}/> Add hook</button></div>
          <p className="project-hook-note">Hooks are installed explicitly here. Repository <code>trebell.json</code> files cannot silently install executable hooks.</p>
          {(p.hooks||[]).length?<div className="project-hook-list">{(p.hooks||[]).map(hook=><div className="project-hook-row" key={hook.id}>
            <span><strong>{hook.name}</strong><small>{hookEventLabel(hook.event)} · {hook.command}</small>{hook.actions?.length>0&&<em>{hook.actions.join(", ")}</em>}</span>
            <b className={hook.event==="source-control.after"?"warn":hook.failureMode}>{hook.event==="source-control.after"?"warn":hook.failureMode}</b><button title="Edit hook" onClick={()=>editHook(p,hook)}><Pencil size={12}/></button><button className="danger" title="Delete hook" onClick={()=>deleteHook(p,hook.id)}><Trash2 size={12}/></button>
          </div>)}</div>:<p className="project-actions-empty">No automatic lifecycle hooks are installed for this project.</p>}
          {hookEditor?.projectId===p.id&&<div className="project-hook-editor">
            <input value={hookEditor.name} onChange={e=>setHookEditor({...hookEditor,name:e.target.value})} placeholder="Hook name (e.g. Lint gate)"/>
            <select value={hookEditor.event} onChange={e=>setHookEditor({...hookEditor,event:e.target.value,failureMode:e.target.value==="source-control.after"?"warn":hookEditor.failureMode})}><option value="verification.required">Required verification</option><option value="source-control.before">Before source control</option><option value="source-control.after">After source control</option></select>
            <input value={hookEditor.command} onChange={e=>setHookEditor({...hookEditor,command:e.target.value})} placeholder="Command (e.g. npm run lint)"/>
            {hookEditor.event.startsWith("source-control.")&&<input value={hookEditor.actionsText} onChange={e=>setHookEditor({...hookEditor,actionsText:e.target.value})} placeholder="Optional actions: push, git.commit (blank = all)"/>}
            <div className="project-hook-options"><label>Timeout (seconds)<input type="number" min="1" max="300" value={hookEditor.timeoutText??Math.round(hookEditor.timeoutMs/1000)} onChange={e=>setHookEditor({...hookEditor,timeoutText:e.target.value,timeoutMs:hookTimeoutMs(e.target.value)})} onBlur={()=>setHookEditor(current=>current&&{...current,timeoutText:undefined})}/></label>{hookEditor.event==="source-control.before"&&<label>On failure<select value={hookEditor.failureMode} onChange={e=>setHookEditor({...hookEditor,failureMode:e.target.value})}><option value="block">Block mutation</option><option value="warn">Warn and continue</option></select></label>}</div>
            <div><button className="primary" disabled={!hookEditor.command.trim()} aria-disabled={hookEditor.saving||undefined} onClick={()=>submitHook(p)}><Check size={12}/> {hookEditor.saving?"Saving…":"Save hook"}</button><button onClick={()=>setHookEditor(null)}><X size={12}/> Cancel</button></div>
          </div>}
          {cardAlert(p,"hooks")}
        </div>
      </div>)}</div>
    </section>)}</div>
    {listState==="loading"&&<div className="project-window-empty project-window-loading" role="status"><span>Loading projects…</span></div>}
    {listState==="ready"&&!projectView.total&&<div className="project-window-empty"><FolderCode size={22}/><span>{projectQuery?"No projects match this search.":"No projects yet."}</span><small>{projectQuery?"Try a name, path, branch or action.":hasDesktopPicker?"Add a local folder or clone a repository to get started.":(environmentData.profiles||[]).length?"Clone a repository above to get started.":"Projects you open appear here."}</small></div>}
    {projectView.hasMore&&<div className="project-window-footer"><button onClick={()=>setProjectLimit(limit=>limit+PROJECT_PAGE_SIZE)}>Show {Math.min(PROJECT_PAGE_SIZE,projectView.total-projectView.shown)} more</button><span>{projectView.shown} of {projectView.total} projects mounted</span></div>}
  </div>;
}
