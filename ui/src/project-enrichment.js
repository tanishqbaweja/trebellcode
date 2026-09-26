export const PROJECT_ENRICH_CONCURRENCY=6;

function defaultSuggested(){
  return {scripts:[],t3:{present:false},packageManager:null};
}

export function baseProjectRecord(project,previous=null){
  const scripts=Array.isArray(project?.scripts)?project.scripts:[];
  const remoteEnvironment=Boolean(project?.environment?.type&&project.environment.type!=="local");
  if(remoteEnvironment)return {...project,scripts,git:null,remote:null,suggested:defaultSuggested()};
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
    if(project?.environment?.type&&project.environment.type!=="local")return project;
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
