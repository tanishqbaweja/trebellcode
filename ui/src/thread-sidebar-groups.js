export const THREAD_GROUP_NAMES=Object.freeze(["Pinned","General","Active","Snoozed","Settled"]);

// The threads whose turn is running. The open thread knows from its own state; another thread from the turn events this
// window saw (turnStates: thread id -> true while a turn runs, false once it ended), else from the status its listing gave.
export function runningThreadIds(threads=[],{activeThreadId=null,activeRunning=false,turnStates={}}={}){
  const ids=new Set(),active=String(activeThreadId||"");
  for(const thread of threads||[]){
    const id=String(thread?.id||"");if(!id)continue;
    const running=id===active?Boolean(activeRunning):Object.prototype.hasOwnProperty.call(turnStates||{},id)?Boolean(turnStates[id]):thread?.status?.type==="active";
    if(running)ids.add(id);
  }
  return ids;
}

// A listing that reports a thread's status is newer than the turn events seen before it, so its status takes over.
export function settleTurnStates(turnStates={},listed=[]){
  const reported=(listed||[]).filter(thread=>thread?.id&&thread?.status?.type).map(thread=>String(thread.id));
  if(!reported.some(id=>Object.prototype.hasOwnProperty.call(turnStates||{},id)))return turnStates;
  const next={...turnStates};for(const id of reported)delete next[id];
  return next;
}

export function groupSidebarThreads(threads=[],threadMeta={}){
  const groups={Pinned:[],General:[],Active:[],Snoozed:[],Settled:[]};
  for(const thread of threads||[]){
    const section=thread?.section?.name;
    if(section==="Pinned"||section==="Snoozed"||section==="Settled"){groups[section].push(thread);continue}
    if(!section&&threadMeta?.[thread?.id]?.projectless)groups.General.push(thread);
    else if(!section)groups.Active.push(thread);
  }
  return groups;
}
