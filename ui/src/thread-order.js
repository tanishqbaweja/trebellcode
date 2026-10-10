// Threads are reordered within their section (Active, Pinned, Snoozed, Settled), in the order the harness lists them.
export function threadOrderGroup(threads,thread){
  const section=thread?.section?.name||"Active";
  return (threads||[]).filter(item=>(item?.section?.name||"Active")===section);
}

// For every thread, whether "Move up" and "Move down" can do anything: the first thread of its section cannot move up, the
// last cannot move down, and a thread alone in its section can do neither.
export function threadMoveAvailability(threads){
  const groups=new Map(),moves=new Map();
  for(const thread of threads||[]){
    if(!thread?.id)continue;
    const section=thread.section?.name||"Active";
    if(!groups.has(section))groups.set(section,[]);
    groups.get(section).push(thread);
  }
  for(const group of groups.values())group.forEach((thread,index)=>moves.set(thread.id,{up:index>0,down:index<group.length-1}));
  return moves;
}
