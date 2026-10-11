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
  // A thread the list holds is shown as the list has it (a message match's own copy may have no place in its section), unless the list
  // holds only what Trebell saved of it (a thread beyond the listed page): the search's own copy is the thread as it is now.
  const shown=thread=>{const listed=order.has(thread?.id)?list[order.get(thread.id)]:null;return listed&&!listed.__trebellCatalog?listed:thread};
  return (found||[]).map((thread,index)=>({thread:shown(thread),index,at:order.has(thread?.id)?order.get(thread.id):Infinity}))
    .sort((a,b)=>a.at-b.at||a.index-b.index).map(item=>item.thread);
}

// The thread a thread sits before in its section, as the thread/section/move anchor that puts it back there: null at the end, or
// where the runtime keeps no place for it (it goes back to its place by recent activity).
export function threadPlacementAnchor(threads,thread,threadMeta={}){
  const group=threadOrderGroup(threads,thread,threadMeta),index=group.findIndex(item=>item.id===thread?.id);
  return index>=0?group[index+1]?.id||null:null;
}

// Where an undo puts a thread back. beforeThreadId: the thread after it in the group the sidebar shows, where the list puts it back
// right away. placed: whether it held a place a person gave it (sectionPlaced: a relay thread someone moved, any thread of a Codex
// section someone ordered); only then does the runtime get anchorThreadId, the thread after it in that order (null for the end). A
// thread nobody placed goes back with no thread to go before, so it takes its place by recent activity again and its activity still
// lifts it.
export function threadPlacement(threads,thread,threadMeta={}){
  const group=sidebarThreadGroups(threads||[],threadMeta||{}).find(item=>item.threads.some(other=>other?.id===thread?.id))?.threads||[];
  const index=group.findIndex(item=>item?.id===thread?.id),placed=Boolean(thread?.sectionPlaced)&&Number.isFinite(thread?.sectionRank);
  return {beforeThreadId:index>=0?group[index+1]?.id||null:null,anchorThreadId:placed?threadPlacementAnchor(threads,thread,threadMeta):null,placed};
}

// The places a move gives the threads of its group before the runtime answers, so the sidebar shows the move at once (thread id ->
// {sectionRank, sectionPlaced}): the thread goes before beforeThreadId (null: the end), and the group's threads take the places the group
// held, in their new order. The moved thread then holds its place; with placeAll every thread there does (a Codex section's first move
// writes them all in this order).
export function movedSectionRanks(threads,thread,beforeThreadId=null,threadMeta={},{placeAll=false}={}){
  const group=threadOrderGroup(threads,thread,threadMeta),moved=group.find(item=>item.id===thread?.id);if(!moved)return new Map();
  const ranks=group.map(item=>item.sectionRank).sort((a,b)=>a-b),order=group.filter(item=>item!==moved);
  const at=beforeThreadId==null?-1:order.findIndex(item=>item.id===beforeThreadId);order.splice(at<0?order.length:at,0,moved);
  return new Map(order.map((item,index)=>[item.id,{sectionRank:ranks[index],sectionPlaced:placeAll||item===moved||Boolean(item.sectionPlaced)}]));
}

// The order an undo of several threads puts them back in (items: {threadId, anchorThreadId, beforeThreadId}, as the action moved them):
// each one after the thread it goes back before when that thread is put back too, so that thread is in the section again by then (a
// thread to go before that is not there is dropped, and the thread would go to the end). The others go back last moved first.
export function undoOrder(items=[]){
  const list=[...(items||[])].filter(Boolean),byId=new Map(list.map(item=>[String(item.threadId),item])),done=new Set(),order=[];
  const visit=item=>{
    const id=String(item.threadId);if(done.has(id))return;done.add(id);
    const next=item.anchorThreadId??item.beforeThreadId,before=next==null?null:byId.get(String(next));if(before)visit(before);
    order.push(item);
  };
  for(const item of list.reverse())visit(item);
  return order;
}

// The order a Codex section shown by recent activity is written in when a person first moves a thread in it: the threads as the
// sidebar shows them (shown: ids, top first), then the section's other threads (members: Codex's listing of the section, which goes
// beyond the sidebar's page) newest first, with the thread moved before beforeThreadId (null: the end).
export function orderedSectionWithMove(shown=[],members=[],threadId,beforeThreadId=null){
  const ids=new Set(members.map(item=>String(item.id))),moved=String(threadId);
  if(!ids.has(moved))throw new Error("The thread is no longer in this section");
  const top=[...new Set(shown.map(String))].filter(id=>ids.has(id)),seen=new Set(top);
  const rest=members.map((item,index)=>({id:String(item.id),at:Number(item.updatedAt)||0,index})).filter(item=>!seen.has(item.id)).sort((a,b)=>b.at-a.at||a.index-b.index).map(item=>item.id);
  const order=[...top,...rest].filter(id=>id!==moved),at=beforeThreadId==null?order.length:order.indexOf(String(beforeThreadId));
  if(at<0)throw new Error("The thread to go before is no longer in this section");
  order.splice(at,0,moved);return order;
}

// The threads to move to the end of a section, in turn, so that its order (current: ids, top first) becomes desired (the same ids):
// the longest start of desired that current already holds in that order stays, and the rest goes to the end one by one.
export function sectionOrderWrites(current=[],desired=[]){
  let kept=0;for(const id of current)if(kept<desired.length&&String(id)===String(desired[kept]))kept++;
  return desired.slice(kept).map(String);
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
