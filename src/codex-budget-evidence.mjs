import { isToolCallItem } from "./goal-state.mjs";

export function recordCodexToolCallEvidence(state,{threadId=null,turnId=null,item=null}={}){
  const id=threadId?String(threadId):"";if(!id||!isToolCallItem(item))return false;
  const meta=state.threadMeta(id),itemId=item?.id==null?null:String(item.id),key=itemId?`${String(turnId||"")}:${itemId}`:null;
  const seen=Array.isArray(meta?.codexToolCallIds)?meta.codexToolCallIds:[];
  if(key&&seen.includes(key))return false;
  state.updateThreadMeta(id,{
    codexToolCallCount:Math.max(0,Number(meta?.codexToolCallCount)||0)+1,
    codexToolCallIds:key?[...seen,key].slice(-1500):seen,
  });
  return true;
}

export function recordCodexChildAgentEvidence(state,thread={}){
  const parentThreadId=thread?.parentThreadId?String(thread.parentThreadId):"",childId=thread?.id?String(thread.id):"";
  if(!parentThreadId||!childId)return false;
  const meta=state.threadMeta(parentThreadId),seen=Array.isArray(meta?.codexChildAgentIds)?meta.codexChildAgentIds:[];
  if(seen.includes(childId))return false;
  state.updateThreadMeta(parentThreadId,{
    codexChildAgentCount:Math.max(0,Number(meta?.codexChildAgentCount)||0)+1,
    codexChildAgentIds:[...seen,childId].slice(-200),
  });
  return true;
}

export function recordCodexBudgetEvidence(state,message={}){
  const params=message?.params||{};
  if(message?.method==="item/started")return recordCodexToolCallEvidence(state,{threadId:params.threadId,turnId:params.turnId,item:params.item});
  if(message?.method==="thread/started")return recordCodexChildAgentEvidence(state,params.thread);
  return false;
}
