export const THREAD_GROUP_NAMES=Object.freeze(["Pinned","General","Active","Snoozed","Settled"]);

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
