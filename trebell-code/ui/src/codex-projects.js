function normalizedPath(value){
  const text=String(value||"").trim().replace(/\\/g,"/").replace(/\/+$/,"");
  return /^[a-z]:\//i.test(text)?text.toLowerCase():text;
}

export function sameWorkspacePath(left,right){
  const a=normalizedPath(left),b=normalizedPath(right);
  return Boolean(a&&b&&a===b);
}

export function matchingRuntimeProject(projects=[],{trebellProjectId=null,cwd=""}={}){
  const id=String(trebellProjectId||"").trim();
  if(id){
    const owned=(projects||[]).find(project=>String(project?.metadata?.trebellProjectId||"")===id);
    if(owned)return owned;
  }
  return (projects||[]).find(project=>(project?.roots||[]).some(root=>sameWorkspacePath(root?.path,cwd)))||null;
}

export async function ensureRuntimeProject(client,{trebellProject,cwd,maxPages=20}={}){
  if(!client||!cwd)return null;
  let cursor=null,pages=0;const projects=[];
  do{
    const page=await client.request("project/list",{cursor,limit:100});
    projects.push(...(page?.data||[]));cursor=page?.nextCursor||null;pages++;
  }while(cursor&&pages<Math.max(1,maxPages));
  const existing=matchingRuntimeProject(projects,{trebellProjectId:trebellProject?.id,cwd});
  if(existing)return existing;
  const projectId=String(trebellProject?.id||"").trim();
  const name=String(trebellProject?.name||String(cwd).split(/[\\/]/).filter(Boolean).pop()||"Trebell project").trim();
  const idempotencyKey=("trebell-code:"+(projectId||normalizedPath(cwd))).slice(0,512);
  const result=await client.request("project/create",{
    name,
    roots:[{path:cwd}],
    metadata:{trebellManaged:"true",...(projectId?{trebellProjectId:projectId}:{})},
    idempotencyKey,
  });
  return result?.project||null;
}

export const matchingCodexProject=matchingRuntimeProject;
export const ensureCodexProject=ensureRuntimeProject;
