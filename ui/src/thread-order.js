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

// For every thread, whether "Move up" and "Move down" can do anything: the first thread of its group cannot move up, the last
// cannot move down, and a thread alone in its group can do neither.
export function threadMoveAvailability(threads,threadMeta={}){
  const moves=new Map();
  for(const group of sidebarGroups(threads,threadMeta))group.forEach((thread,index)=>moves.set(thread.id,{up:index>0,down:index<group.length-1}));
  return moves;
}
