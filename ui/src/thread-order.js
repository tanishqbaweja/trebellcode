import { sidebarThreadGroups } from "./thread-sidebar-groups.js";

// Threads are reordered within the group the sidebar shows them in (Pinned, General, Active, a named section, Snoozed, Settled), in
// that order, among the threads of one section whose runtime keeps their place there (a sectionRank from its listing): Codex keeps no
// place for a thread outside a section, so those threads cannot move, and neither can another harness's thread. A General chat and a
// project thread share the harness's unsectioned list but sit in different groups, so a move never steps over a thread the person
// cannot see next to the one they move. Where a move or an undo puts a thread is thread-moves.js's, which loads with the thread
// actions after the first paint (B11).
export function sidebarGroups(threads,threadMeta){
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

// The threads a search found, in the list's order (a message match the list holds earlier sits where the list has it), and any
// the list does not hold yet after them: a search filters the sidebar without reordering it, so a move made while searching
// shows where the thread went.
export function threadsInListOrder(found,threads){
  const list=threads||[],order=new Map(list.map((thread,index)=>[thread?.id,index]));
  // A thread the list holds is shown as the list has it (a message match's own copy may have no place in its section), unless the list
  // holds only what Trebell saved of it (a thread beyond the listed page): the search's own copy is the thread as it is now.
  const shown=thread=>{const listed=order.has(thread?.id)?list[order.get(thread.id)]:null;return listed&&!listed.__trebellCatalog?listed:thread};
  return (found||[]).map((thread,index)=>({thread:shown(thread),index,at:order.has(thread?.id)?order.get(thread.id):Infinity}))
    .sort((a,b)=>a.at-b.at||a.index-b.index).map(item=>item.thread);
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
