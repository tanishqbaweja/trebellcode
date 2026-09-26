import { isToolCallItem } from "./goal-state.mjs";

function text(value,max=2000){return String(value??"").trim().slice(0,max)}
function normalizedName(value){return text(value,200).replace(/\//g,".").toLowerCase()}
function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:null}

export function reduceThreadEvents(events=[],options={}){
  const threadId=options.threadId==null?null:String(options.threadId);
  const source=(Array.isArray(events)?events:[])
    .filter(event=>!threadId||String(event?.threadId||"")===threadId)
    .slice()
    .sort((a,b)=>(Number(a?.at)||0)-(Number(b?.at)||0));
  const state={
    threadId:threadId||String(source.find(event=>event?.threadId)?.threadId||"")||null,
    runtime:null,provider:null,environmentId:null,status:"unknown",activeTurnId:null,
    lastActivityAt:null,eventCount:0,
    turns:{started:0,completed:0,failed:0,cancelled:0,last:null},
    checkpoint:null,verification:null,
    budget:{blocked:false,lastBlockedAt:null,reason:null},
    policy:{lastDecision:null,lastReason:null,blockedCount:0,confirmedCount:0},
    recovery:{blocked:false,reason:null,uncertainTools:[]},
    delegation:{started:0,lastChildThreadId:null,lastAt:null},
    recentFailures:[],
  };
  const uncertainTools=new Map();
  const toolKey=(turnId,itemId)=>String(turnId||"")+"\0"+String(itemId||"");
  const syncRecovery=()=>{const items=[...uncertainTools.values()].slice(-100);state.recovery={blocked:items.length>0,reason:items.length?"uncertain_tool_action":null,uncertainTools:items}};
  const failureKeys=new Set();
  function failure(event,message,kind="error"){
    const value=text(message,1600);if(!value)return;
    const key=kind+"|"+value;if(failureKeys.has(key))return;failureKeys.add(key);
    state.recentFailures.push({at:number(event.at),turnId:event.turnId||null,kind,message:value});
    if(state.recentFailures.length>20)state.recentFailures.shift();
  }
  for(const event of source){
    const name=normalizedName(event?.name),data=event?.data&&typeof event.data==="object"?event.data:{},at=number(event?.at);
    state.eventCount++;if(at!=null)state.lastActivityAt=at;
    if(event.runtime)state.runtime=String(event.runtime);if(event.provider)state.provider=String(event.provider);if(event.environmentId!=null)state.environmentId=event.environmentId?String(event.environmentId):null;
    if(name==="turn.started"){
      state.status="active";state.activeTurnId=String(event.turnId||data.turn?.id||"")||null;state.turns.started++;
      state.turns.last={id:state.activeTurnId,status:"active",startedAt:at,completedAt:null,durationMs:null};
    }else if(name==="turn.completed"){
      const id=String(event.turnId||data.turn?.id||state.activeTurnId||"")||null,status=text(event.status||data.turn?.status||"completed",80).toLowerCase();
      state.turns.completed++;if(status==="failed")state.turns.failed++;if(status==="cancelled"||status==="canceled")state.turns.cancelled++;
      state.status=status==="failed"?"failed":"idle";if(!id||state.activeTurnId===id)state.activeTurnId=null;
      state.turns.last={id,status,startedAt:state.turns.last?.id===id?state.turns.last.startedAt:null,completedAt:at,durationMs:number(data.turn?.durationMs)};
      if(id){for(const [key,item] of uncertainTools)if(item.turnId===id)uncertainTools.delete(key);syncRecovery()}
      if(status==="failed")failure(event,data.message||"Turn failed.","turn");
    }else if(name==="item.started"){
      const item=data.item&&typeof data.item==="object"?data.item:{},itemId=text(item.id,300),turnId=text(event.turnId||data.turn?.id,300)||null;
      if(itemId&&isToolCallItem(item)){uncertainTools.set(toolKey(turnId,itemId),{id:itemId,type:text(item.type,120)||"toolCall",turnId,status:"inProgress",tool:text(item.tool||item.name,200)||null,server:text(item.server,200)||null});syncRecovery()}
    }else if(name==="item.completed"){
      const item=data.item&&typeof data.item==="object"?data.item:{},itemId=text(item.id,300),turnId=text(event.turnId||data.turn?.id,300)||null;
      if(itemId){uncertainTools.delete(toolKey(turnId,itemId));syncRecovery()}
    }else if(name==="thread.status.changed"){
      const status=text(data.status||event.status,80).toLowerCase();if(status)state.status=status==="inprogress"?"active":status;
    }else if(name==="error"){
      failure(event,data.message||event.status||"Runtime error.","error");if(state.status==="active")state.status="failed";
    }else if(name==="checkpoint.created"){
      state.checkpoint={id:text(data.id||data.checkpointId,300)||null,at,status:event.status||"completed",root:text(data.root,2000)||null,label:text(data.label,500)||null};
    }else if(name==="checkpoint.skipped"){
      state.checkpoint={id:null,at,status:"skipped",root:null,label:null,reason:text(data.reason,1200)||null};
    }else if(name==="verification.completed"){
      state.verification={
        recordId:text(data.recordId,300)||null,at,status:text(event.status||data.status,120)||null,
        verified:Boolean(data.verified),risk:text(data.risk,120)||null,nextAction:text(data.nextAction,120)||null,summary:data.summary||null,
      };
      if(state.verification.status==="failed")failure(event,"Verification failed.","verification");
    }else if(name==="verification.repair_started"){
      if(state.verification)state.verification={...state.verification,repairStartedAt:at,repairTurnId:event.turnId||null};
      state.status="active";state.activeTurnId=event.turnId||state.activeTurnId;
    }else if(name==="goal.budget_blocked"){
      state.budget={blocked:true,lastBlockedAt:at,reason:text(data.reason||event.status,1200)||"Goal budget blocked new work."};
    }else if(name==="policy.decision"){
      const decision=text(data.decision||event.status,80).toUpperCase();
      state.policy.lastDecision=decision||null;state.policy.lastReason=text(data.reason,1200)||null;
      if(decision==="REJECT")state.policy.blockedCount++;if(decision==="CONFIRM")state.policy.confirmedCount++;
    }else if(name==="delegation.started"){
      state.delegation.started++;state.delegation.lastChildThreadId=text(data.childThreadId,300)||null;state.delegation.lastAt=at;
    }
    if(["failed","error","blocked"].includes(String(event?.status||"").toLowerCase())&&!["turn.completed","verification.completed","goal.budget_blocked","policy.decision","error"].includes(name)){
      failure(event,data.message||data.reason||name,event.category||"event");
    }
  }
  return state;
}

export function reduceEventJournal(events=[]){
  const byThread=new Map();
  for(const event of Array.isArray(events)?events:[]){
    const threadId=String(event?.threadId||"").trim();if(!threadId)continue;
    if(!byThread.has(threadId))byThread.set(threadId,[]);byThread.get(threadId).push(event);
  }
  return Object.fromEntries([...byThread.entries()].map(([threadId,items])=>[threadId,reduceThreadEvents(items,{threadId})]));
}
