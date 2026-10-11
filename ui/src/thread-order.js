import { sidebarThreadGroups } from "./thread-sidebar-groups.js";

// Threads are reordered within the group the sidebar shows them in (Pinned, General, Active, a named section, Snoozed, Settled), in
// that order, among the threads of one section whose runtime keeps their place there (a sectionRank from its listing): Codex keeps no
// place for a thread outside a section, so those threads cannot move, and neither can another harness's thread. A General chat and a
// project thread share the harness's unsectioned list but sit in different groups, so a move never steps over a thread the person
// cannot see next to the one they move.
function sidebarGroups(threads,threadMeta){
  const groups=[];
  for(const group of sidebarThreadGroups(threads||[],threadMeta||{})){
    const sections=new Map();
    for(const thread of group.threads){
      if(!thread?.id||!Number.isFinite(thread.sectionRank))continue;
      const key=String(thread.section?.id??thread.section?.name??"");if(!sections.has(key))sections.set(key,[]);sections.get(key).push(thread);
    }
    groups.push(...sections.values());
  }
  return groups;
}

export function threadOrderGroup(threads,thread,threadMeta={}){
  if(!thread?.id)return [];
  return sidebarGroups(threads,threadMeta).find(group=>group.some(item=>item.id===thread.id))||[];
}

// The threads a search found, in the list's order (a message match the list holds earlier sits where the list has it), and any
// the list does not hold yet after them: a search filters the sidebar without reordering it, so a move made while searching
// shows where the thread went.
export function threadsInListOrder(found,threads){
  const list=threads||[],order=new Map(list.map((thread,index)=>[thread?.id,index]));
  // A thread the list holds is shown as the list has it (a message match's own copy has no place in its section).
  return (found||[]).map((thread,index)=>({thread:order.has(thread?.id)?list[order.get(thread.id)]:thread,index,at:order.has(thread?.id)?order.get(thread.id):Infinity}))
    .sort((a,b)=>a.at-b.at||a.index-b.index).map(item=>item.thread);
}

// The thread a thread sits before in its section, as the thread/section/move anchor that puts it back there: null at the end, or
// where the runtime keeps no place for it (it goes back to its place by recent activity).
export function threadPlacementAnchor(threads,thread,threadMeta={}){
  const group=threadOrderGroup(threads,thread,threadMeta),index=group.findIndex(item=>item.id===thread?.id);
  return index>=0?group[index+1]?.id||null:null;
}

// The first thread of a section, in the order its runtime keeps it: a thread moved into the section goes before it, so it shows first,
// as the thread a person just pinned, snoozed or settled. Null when the section shows no thread with a place.
export function sectionFirstThread(threads,sectionId,threadMeta={},exceptId=null){
  if(sectionId==null||sectionId==="")return null;
  for(const group of sidebarGroups(threads,threadMeta)){
    const first=group.find(item=>item.id!==exceptId);
    if(first&&String(first.section?.id??first.section?.name??"")===String(sectionId))return first;
  }
  return null;
}

// For every thread the sidebar shows (shown: every thread, or a search's results), whether "Move up" and "Move down" can do
// anything: the first thread of its shown group cannot move up, the last cannot move down, and a thread alone there can do
// neither.
export function threadMoveAvailability(threads,threadMeta={}){
  const moves=new Map();
  for(const group of sidebarGroups(threads,threadMeta))group.forEach((thread,index)=>moves.set(thread.id,{up:index>0,down:index<group.length-1}));
  return moves;
}

// Where "Move up" (direction -1) or "Move down" (1) puts a thread, as the thread/section/move anchor: {beforeThreadId}, the thread
// it goes before (null for the end of its section), or null when it cannot move that way. It steps past the thread the sidebar
// shows next to it (shown: a search's results while one filters the list). Up, it goes right before that neighbour; down, right
// after it in the full list, before the thread that follows it there, so threads a search hides keep their places.
export function threadMoveTarget(threads,thread,direction,threadMeta={},shown=threads){
  const group=threadOrderGroup(shown,thread,threadMeta),index=group.findIndex(item=>item.id===thread?.id);
  const target=index<0||!direction?null:group[index+Math.sign(direction)];
  if(!target)return null;
  if(direction<0)return {beforeThreadId:target.id};
  const full=threadOrderGroup(threads,target,threadMeta),at=full.findIndex(item=>item.id===target.id);
  const next=at>=0?full.slice(at+1).find(item=>item.id!==thread.id):group[index+2];
  return {beforeThreadId:next?.id||null};
}
