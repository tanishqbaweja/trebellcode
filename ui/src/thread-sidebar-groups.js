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

// A group keeps the order the list gives it (newest first), except that the threads whose runtime keeps their place in a section (the
// sectionRank their listing gave them) take the places those threads hold, in that order: a moved thread shows where it went, and a
// thread the runtime gives no place (Codex orders threads outside a section by recent activity; another harness's thread) stays put.
function inRuntimeOrder(threads){
  const slots=[],ranked=[];
  threads.forEach((thread,index)=>{if(Number.isFinite(thread?.sectionRank)){slots.push(index);ranked.push(thread)}});
  if(ranked.length<2)return threads;
  ranked.sort((left,right)=>left.sectionRank-right.sectionRank);
  const ordered=[...threads];slots.forEach((slot,index)=>{ordered[slot]=ranked[index]});return ordered;
}

// The sidebar's groups in the order it shows them, each {key,name,threads}: Pinned, General, Active, a group named after each other
// section a thread is in (a Codex section made or renamed in another Codex client, a section a relay thread was saved under), then
// Snoozed and Settled. Every thread is in exactly one group.
export function sidebarThreadGroups(threads=[],threadMeta={}){
  const fixed=Object.fromEntries(THREAD_GROUP_NAMES.map(name=>[name,{key:name,name,threads:[]}])),other=new Map();
  for(const thread of threads||[]){
    const section=thread?.section,id=section?.id??section?.name,name=String(section?.name||id||"");
    if(id==null||id===""){(threadMeta?.[thread?.id]?.projectless?fixed.General:fixed.Active).threads.push(thread);continue}
    if(name==="Pinned"||name==="Snoozed"||name==="Settled"){fixed[name].threads.push(thread);continue}
    const key="section:"+id;if(!other.has(key))other.set(key,{key,name,threads:[]});other.get(key).threads.push(thread);
  }
  return [fixed.Pinned,fixed.General,fixed.Active,...other.values(),fixed.Snoozed,fixed.Settled].map(group=>({...group,threads:inRuntimeOrder(group.threads)}));
}

// The same groups by key: the five named ones always, and "section:<id>" for each other section.
export function groupSidebarThreads(threads=[],threadMeta={}){
  return Object.fromEntries(sidebarThreadGroups(threads,threadMeta).map(group=>[group.key,group.threads]));
}
