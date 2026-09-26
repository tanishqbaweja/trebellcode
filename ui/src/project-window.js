export const PROJECT_PAGE_SIZE=24;

function text(value){return String(value??"").trim().toLowerCase()}

export function projectMatches(project,query=""){
  const needle=text(query);if(!needle)return true;
  return [
    project?.name,project?.path,project?.remote,project?.environment?.name,project?.environment?.type,
    project?.git?.branch,...(project?.scripts||[]).flatMap(script=>[script?.name,script?.command]),
  ].some(value=>text(value).includes(needle));
}

export function projectWindow(projects=[],{
  query="",
  limit=PROJECT_PAGE_SIZE,
  currentPath=null,
  currentEnvironmentId=null,
}={}){
  const filtered=(Array.isArray(projects)?projects:[]).filter(project=>projectMatches(project,query));
  const cap=Math.max(1,Math.min(1000,Math.trunc(Number(limit)||PROJECT_PAGE_SIZE)));
  let visible=filtered.slice(0,cap);
  if(!text(query)&&currentPath){
    const active=filtered.find(project=>String(project?.path||"")===String(currentPath)&&(project?.environmentId||null)===(currentEnvironmentId||null));
    if(active&&!visible.some(project=>project.id===active.id))visible=[active,...visible.filter(project=>project.id!==active.id)].slice(0,cap);
  }
  return {filtered,visible,total:filtered.length,shown:visible.length,hasMore:filtered.length>visible.length,limit:cap};
}

export function projectGroupKey(project){
  return (project?.environmentId||"local")+":"+(project?.remote||project?.path||project?.id||"project");
}

export function projectGroupCounts(projects=[]){
  const counts=new Map();
  for(const project of projects||[]){
    const key=projectGroupKey(project);counts.set(key,(counts.get(key)||0)+1);
  }
  return counts;
}
