export const PROJECT_ENRICH_CONCURRENCY=6;

function defaultSuggested(){
  return {scripts:[],projectFile:{present:false},packageManager:null};
}

// What a project card says about its checkout: the branch, a detached HEAD, or that the folder is not a Git checkout.
// Nothing until the Git probe has answered, instead of calling a checkout that is still loading "not a Git checkout".
export function projectGitLabel(git){
  if(!git)return "";
  if(!git.isGit)return "not a Git checkout";
  return git.branch||"detached HEAD";
}

// The one rule for where a project lives, used by its card, its group and enrichment alike: an environment of another
// type than "local" is remote, and a project sent without environment details is remote only if it names one.
export function projectIsRemote(project){
  const type=String(project?.environment?.type||"").trim();
  return type?type!=="local":Boolean(project?.environmentId);
}

// The environment a project card and its group name: the server's name, else the profile /api/environments listed.
export function projectEnvironmentLabel(project,profiles=[]){
  const name=String(project?.environment?.name||"").trim();if(name)return name;
  if(!projectIsRemote(project))return "Local machine";
  return String((Array.isArray(profiles)?profiles:[]).find(profile=>profile?.id===project?.environmentId)?.name||"").trim()||"Remote environment";
}

// When a project was last opened, or nothing for a missing or unreadable time (instead of "Invalid Date").
export function projectOpenedLabel(value){
  if(value==null||value===""||typeof value==="boolean")return "";
  const date=new Date(value);
  return Number.isNaN(date.getTime())?"":date.toLocaleString();
}

// A project card's detail line: remote or local by projectIsRemote, then the Git state (nothing while it loads) and time.
export function projectCardDetail(project){
  const opened=projectOpenedLabel(project?.lastOpenedAt);
  if(projectIsRemote(project))return ["remote workspace",opened].filter(Boolean).join(" · ");
  if(project?.managedWorktree?.cleanedAt)return "managed worktree cleaned · click to restore";
  return [projectGitLabel(project?.git),opened].filter(Boolean).join(" · ");
}

export function baseProjectRecord(project,previous=null){
  const scripts=Array.isArray(project?.scripts)?project.scripts:[];
  if(projectIsRemote(project))return {...project,scripts,git:null,remote:null,suggested:defaultSuggested()};
  return {
    ...project,
    scripts,
    git:previous?.git??null,
    remote:previous?.remote??null,
    suggested:previous?.suggested??defaultSuggested(),
  };
}

export async function mapWithConcurrency(items=[],limit=PROJECT_ENRICH_CONCURRENCY,worker){
  const source=Array.isArray(items)?items:[],cap=Math.max(1,Math.min(32,Math.trunc(Number(limit)||PROJECT_ENRICH_CONCURRENCY))),results=new Array(source.length);
  let next=0;
  const runner=async()=>{
    while(true){
      const index=next++;
      if(index>=source.length)return;
      results[index]=await worker(source[index],index);
    }
  };
  await Promise.all(Array.from({length:Math.min(cap,source.length)},runner));
  return results;
}

export async function enrichProjectRecords(projects=[],{
  fetchGit,
  fetchSuggestions,
  concurrency=PROJECT_ENRICH_CONCURRENCY,
  onError=()=>{},
}={}){
  if(typeof fetchGit!=="function"||typeof fetchSuggestions!=="function")throw new Error("Project enrichment requires Git and action-suggestion loaders.");
  return mapWithConcurrency(projects,concurrency,async project=>{
    if(projectIsRemote(project))return project;
    const [gitResult,suggestedResult]=await Promise.allSettled([fetchGit(project),fetchSuggestions(project)]);
    if(gitResult.status==="rejected")onError(project,"git",gitResult.reason);
    if(suggestedResult.status==="rejected")onError(project,"suggestions",suggestedResult.reason);
    const git=gitResult.status==="fulfilled"?gitResult.value:(project.git??null);
    const suggested=suggestedResult.status==="fulfilled"?suggestedResult.value:(project.suggested??defaultSuggested());
    const detectedRemote=git?.remotes?.find(remote=>remote.kind==="fetch")?.url||null;
    return {
      ...project,
      git,
      remote:gitResult.status==="fulfilled"?detectedRemote:(project.remote??detectedRemote),
      suggested,
    };
  });
}

export function summarizeProjectRefreshErrors(errors=[],limit=8){
  const source=(Array.isArray(errors)?errors:[]).filter(Boolean);
  if(!source.length)return "";
  const cap=Math.max(1,Math.min(50,Math.trunc(Number(limit)||8))),shown=source.slice(0,cap),remaining=source.length-shown.length;
  return shown.join(" · ")+(remaining>0?" · +"+remaining+" more":"");
}
