// The order the agent relay keeps for each section of a runtime's threads, top first (thread/section/move puts a thread before another
// one or at the end of its section, and thread/list sorts a section by section_position, as Codex does). The relay also keeps an order
// for the threads outside a section, which Codex orders by recent activity only. A thread a person moved has a position; a thread nobody
// moved sits by its last update, newest first, so a new thread still comes first and a thread with new activity rises. Threads at the
// same place are told apart by the tiebreak a move gives them, then by id.

export function threadSectionId(thread){
  const section=thread?.section;if(!section)return null;
  const id=section.id??section.name;return id==null||id===""?null:String(id);
}

export function sectionOrderKey(thread){
  const position=thread?.sectionPosition;
  if(typeof position==="number"&&Number.isFinite(position))return position;
  return Number(thread?.updatedAt)||Number(thread?.createdAt)||0;
}

export function compareSectionOrder(left,right){
  const key=sectionOrderKey(right)-sectionOrderKey(left);if(key)return key;
  const tiebreak=(Number(right?.sectionTiebreak)||0)-(Number(left?.sectionTiebreak)||0);if(tiebreak)return tiebreak;
  const a=String(left?.id??""),b=String(right?.id??"");return a<b?1:a>b?-1:0;
}

// Whether a person put the thread where it is (a move gave it a position), so that its activity does not move it.
export function sectionPlaced(thread){
  const position=thread?.sectionPosition;return typeof position==="number"&&Number.isFinite(position);
}

// Each listed (unarchived) thread's place in its section, 0 for the top.
export function sectionRanks(threads=[]){
  const sections=new Map(),ranks=new Map();
  for(const thread of threads||[]){
    if(!thread?.id||thread.archived)continue;
    const key=threadSectionId(thread)??"";if(!sections.has(key))sections.set(key,[]);sections.get(key).push(thread);
  }
  for(const members of sections.values())members.sort(compareSectionOrder).forEach((thread,index)=>ranks.set(String(thread.id),index));
  return ranks;
}

// A listed thread with where it sits in its section (sectionRank, from sectionRanks) and whether a person put it there (sectionPlaced).
export function withSectionPlace(thread,ranks){
  return {...thread,sectionRank:ranks.get(String(thread?.id))??null,sectionPlaced:sectionPlaced(thread)};
}

// The order fields thread/section/move {threadId, sectionId, beforeThreadId} gives: a map of thread id to {sectionPosition,
// sectionTiebreak}, the moved thread first. The thread goes right before beforeThreadId, which must be in the destination section.
// Without one, a thread moved within its section goes to the end of it (Move down past the last thread), and a thread that enters or
// leaves a section (Pin, Snooze, Settle, Wake, Unpin, and their undo) takes its place there by recent activity: nobody put it anywhere.
export function sectionMovePlacement(threads=[],{threadId,sectionId=null,beforeThreadId=null}={}){
  const listed=(threads||[]).filter(thread=>thread?.id&&!thread.archived),thread=listed.find(item=>String(item.id)===String(threadId));
  if(!thread)throw new Error("Thread not found");
  const target=sectionId==null||sectionId===""?null:String(sectionId),before=beforeThreadId==null||beforeThreadId===""?null:String(beforeThreadId);
  const members=listed.filter(item=>String(item.id)!==String(thread.id)&&threadSectionId(item)===target).sort(compareSectionOrder);
  const placement=new Map(),place=(position,tiebreak=null)=>placement.set(String(thread.id),{sectionPosition:position,sectionTiebreak:tiebreak});
  if(!before){
    if(!members.length||threadSectionId(thread)!==target)place(null);
    else place(sectionOrderKey(members.at(-1))-1);
    return placement;
  }
  const index=members.findIndex(item=>String(item.id)===before);
  if(index<0)throw Object.assign(new Error(`before thread ${before} is not in ${target?"section "+target:"the threads outside a section"}`),{code:-32600});
  if(index===0){place(sectionOrderKey(members[0])+1);return placement}
  const above=sectionOrderKey(members[index-1]),below=sectionOrderKey(members[index]),middle=(above+below)/2;
  if(above>middle&&middle>below){place(middle);return placement}
  // No room between the two (the same last-update second, or positions halved this far): the moved thread joins the threads at the
  // lower one's place, and a tiebreak puts the moved thread right before it.
  const run=members.filter(item=>sectionOrderKey(item)===below),at=run.findIndex(item=>String(item.id)===before),ordered=[...run.slice(0,at),thread,...run.slice(at)];
  place(below,ordered.length-at);
  ordered.forEach((item,order)=>{if(item!==thread)placement.set(String(item.id),{sectionTiebreak:ordered.length-order})});
  return placement;
}
