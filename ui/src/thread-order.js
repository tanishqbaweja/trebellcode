import { groupSidebarThreads } from "./thread-sidebar-groups.js";

// Threads are reordered within the group the sidebar shows them in (Pinned, General, Active, Snoozed, Settled), in the order the
// harness lists them. A General chat and a project thread share the harness's unsectioned list but sit in different groups, so a
// move never steps over a thread the person cannot see next to the one they move.
function sidebarGroups(threads,threadMeta){
  return Object.values(groupSidebarThreads(threads||[],threadMeta||{})).map(group=>group.filter(thread=>thread?.id));
}

export function threadOrderGroup(threads,thread,threadMeta={}){
  if(!thread?.id)return [];
  return sidebarGroups(threads,threadMeta).find(group=>group.some(item=>item.id===thread.id))||[];
}

// The threads a search found, in the list's order (a message match the list holds earlier sits where the list has it), and any
// the list does not hold yet after them: a search filters the sidebar without reordering it, so a move made while searching
// shows where the thread went.
export function threadsInListOrder(found,threads){
  const order=new Map((threads||[]).map((thread,index)=>[thread?.id,index]));
  return (found||[]).map((thread,index)=>({thread,index,at:order.has(thread?.id)?order.get(thread.id):Infinity}))
    .sort((a,b)=>a.at-b.at||a.index-b.index).map(item=>item.thread);
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
