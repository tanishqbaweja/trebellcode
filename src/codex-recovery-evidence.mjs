import { isToolCallItem } from "./goal-state.mjs";

const MAX_UNCERTAIN_ITEMS=100;

function key(turnId,itemId){return `${String(turnId||"")}\0${String(itemId||"")}`}

function boundedItem(turnId,item={}){
  return {id:String(item.id||""),type:String(item.type||"toolCall").slice(0,120),turnId:String(turnId||"").slice(0,300),status:"inProgress"};
}

export function recordCodexRecoveryItemEvidence(state,message={}){
  const method=String(message?.method||"");if(!["item/started","item/completed"].includes(method))return false;
  const params=message?.params||{},threadId=String(params.threadId||""),turnId=String(params.turnId||""),item=params.item||{},itemId=String(item?.id||"");
  if(!threadId||!itemId)return false;
  const meta=state.threadMeta(threadId),recovery=meta?.restartRecovery;
  if(recovery?.runtime!=="codex"||recovery?.status!=="active"||!recovery.turnId)return false;
  if(turnId&&String(recovery.turnId)!==turnId)return false;
  const current=Array.isArray(recovery.uncertainTools)?recovery.uncertainTools:[],targetKey=key(recovery.turnId,itemId);
  let next=current.filter(entry=>key(entry.turnId,entry.id)!==targetKey);
  if(method==="item/started"){
    if(!isToolCallItem(item))return false;
    next=[...next,boundedItem(recovery.turnId,item)].slice(-MAX_UNCERTAIN_ITEMS);
  }
  if(next.length===current.length&&next.every((entry,index)=>entry===current[index]))return false;
  state.updateThreadMeta(threadId,{restartRecovery:{...recovery,uncertainTools:next}});return true;
}

export function staleCodexRecoveryState(recovery,{continueAfterRestart=false,detectedAt=Date.now()}={}){
  if(!recovery||recovery.runtime!=="codex"||recovery.status!=="active"||!recovery.turnId)return recovery;
  if(!continueAfterRestart)return {...recovery,status:"interrupted",detectedAt,message:"Codex work was interrupted by a Trebell restart. Send a new message to continue."};
  const uncertainTools=Array.isArray(recovery.uncertainTools)?recovery.uncertainTools:[];
  if(uncertainTools.length)return {...recovery,status:"blocked",blocked:true,reason:"uncertain_tool_action",detectedAt,message:"Automatic Codex restart continuation was blocked because a tool or action was still unresolved when Trebell stopped. Inspect its real-world state before repeating it.",uncertainTools};
  return {...recovery,status:"pending",blocked:false,detectedAt,uncertainTools:[]};
}
