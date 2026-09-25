import { randomUUID } from "node:crypto";
import { normalizeDelegationRequest } from "./delegation-state.mjs";

export async function executeDelegation({
  parentThreadId,
  request,
  reserve,
  prepareWorkspace,
  startThread,
  configureChild,
  startTurn,
  cleanupWorkspace,
  markFailed,
  onStarted,
  makeId=()=>randomUUID(),
}={}){
  const parentId=String(parentThreadId||"").trim();if(!parentId)throw new Error("parentThreadId is required");
  const spec=normalizeDelegationRequest(request||{});
  const delegationId=String(makeId()||randomUUID());
  const release=await reserve?.({parentThreadId:parentId,spec,delegationId})||(()=>{});
  let workspace=null,childThread=null,turn=null;
  try{
    workspace=await prepareWorkspace({parentThreadId:parentId,spec,delegationId});
    childThread=await startThread({parentThreadId:parentId,spec,delegationId,workspace});
    if(!childThread?.id)throw new Error("Delegation did not create a child thread");
    await configureChild?.({parentThreadId:parentId,spec,delegationId,workspace,childThread});
    turn=await startTurn({parentThreadId:parentId,spec,delegationId,workspace,childThread});
    const result={
      delegationId,parentThreadId:parentId,thread:childThread,turn:turn||null,turnId:turn?.id||null,workspace,spec,
      cwd:workspace?.cwd||null,branch:workspace?.branch||null,
      permission:spec.permissions,isolation:spec.isolation==="inherit"?"shared":"worktree",
      model:spec.model||childThread?.model||null,budget:spec.budget,
    };
    await onStarted?.(result);
    return result;
  }catch(error){
    if(childThread?.id)await markFailed?.({error,parentThreadId:parentId,spec,delegationId,workspace,childThread,turn});
    else if(workspace)await cleanupWorkspace?.({error,parentThreadId:parentId,spec,delegationId,workspace});
    throw error;
  }finally{
    await release?.();
  }
}
