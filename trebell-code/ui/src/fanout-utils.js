export function nextModelSelection(current=[],id,{shiftKey=false,allowMulti=false}={}){
  const list=[...new Set((current||[]).filter(Boolean))];
  if(!shiftKey||!allowMulti)return [id];
  if(list.includes(id))return list.length>1?list.filter(value=>value!==id):list;
  return [...list,id];
}

export function normalizedPathKey(value=""){
  return String(value||"").replace(/\\/g,"/").replace(/\/+$/g,"").toLowerCase();
}

export function threadForWorktree(threads=[],cwd=""){
  const target=normalizedPathKey(cwd);if(!target)return null;
  return (threads||[]).find(item=>normalizedPathKey(item?.cwd)===target)||null;
}

export function fanoutWorkspaceError(info){
  if(!info?.isGit)return "Multi-model runs require a Git project so each model can use an isolated worktree";
  if(!info?.branch)return "Choose a base branch before starting multiple models; detached HEAD is not supported";
  return null;
}
