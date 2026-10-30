// What a person does to threads from the sidebar's row menu and bulk bar, the keyboard, the Agents page and the Snooze dialog: pin,
// snooze, settle, wake, archive, fork and delete a thread, the same for several selected at once, Undo, and moving a thread up or down
// its section (and what App does the same way on its own: waking a snoozed thread, settling a merged one); and opening a thread a
// pull request links, from the Source panel. Drawing the first screen changes no thread, so App loads this module at idle after the
// first paint (B11), and an action made before then waits for it, App's own wake and settle at startup among them. Each function
// takes what it reads of App's render as deps, as App's own functions read it.
import { bulkActionFailure, movedSectionRanks, orderedSectionWithMove, sectionOrderWrites, threadMoveTarget, threadOrderGroup, threadPlacement, undoOrder } from "./thread-moves.js";
import { loadThreadListPages, threadSectionOrderParams } from "./thread-list-query.js";
import { threadTitle } from "./thread-catalog.js";

function titleOf(thread){return threadTitle(thread)}

// Where an undo puts the thread back: its section, and its place there only if it held one a person gave it (thread-moves.js).
function captureThreadPlacement({threads,threadMeta},thread){
  return {section:thread.section||null,...threadPlacement(threads,thread,threadMeta),snoozedUntil:threadMeta[thread.id]?.snoozedUntil??null};
}
// Back to its section: before the thread that followed it when it held a place a person gave it, at the end when it held the last
// one (entering a section with no thread to go before takes the place by recent activity, and a move within it with none goes to its
// end), and by recent activity when it held none, so a thread nobody moved still rises with its activity. placementAnchor (App's)
// reads the list as it is when the undo runs.
async function restoreSectionPlace({rpc,placementAnchor},thread,snapshot,restored=null){
  const sectionId=snapshot.section?.id||null,anchor=snapshot.placed?placementAnchor(snapshot,restored):null;
  await rpc.request("thread/section/move",{threadId:thread.id,sectionId,beforeThreadId:anchor});
  if(snapshot.placed&&!anchor)await rpc.request("thread/section/move",{threadId:thread.id,sectionId,beforeThreadId:null});
}
function restoreThreadLocally({setThreads,activeThread,setActiveThread},thread,snapshot){
  const restored={...thread,archived:false,section:snapshot.section||null,sectionEnteredAt:snapshot.section?Date.now()/1000:null};
  setThreads(prev=>{
    const without=prev.filter(item=>item.id!==thread.id);const beforeIndex=snapshot.beforeThreadId?without.findIndex(item=>item.id===snapshot.beforeThreadId):-1;
    if(beforeIndex>=0)without.splice(beforeIndex,0,restored);else without.push(restored);return without;
  });
  if(activeThread?.id===thread.id)setActiveThread(restored);
  return restored;
}
async function restoreThreadPlacement(deps,thread,snapshot,restored=null){
  const {rpc,rpcStatus,updateThreadMeta,loadThreads}=deps;
  if(!rpc||rpcStatus!=="connected")return;
  await restoreSectionPlace(deps,thread,snapshot,restored);restored?.set(thread.id,snapshot.section?.id||null);
  restoreThreadLocally(deps,thread,snapshot);await updateThreadMeta(thread.id,{snoozedUntil:snapshot.snoozedUntil??null});
  loadThreads(rpc);
}
// A thread moved into or out of a section takes its place there by recent activity, as it always has (nobody put it anywhere), except
// in a Codex section a person ordered, where every thread holds its place: it goes first there (sectionTop, App's, reads the list as
// it is now). The list is read again for the places the runtime gave. With the harness away nothing moves, and the move fails so that
// no Undo or wake time stands for it.
export async function moveThread(deps,thread,destination){
  const {rpc,rpcStatus,agentRuntimeLabel,sections,agentRuntime,orderedSectionsRef,sectionTop,setThreads,activeThread,setActiveThread,updateThreadMeta,loadThreads}=deps;
  if(!rpc||rpcStatus!=="connected")throw new Error(agentRuntimeLabel+" is not connected");
  const target=destination==="active"?null:sections[destination==="pin"?"Pinned":destination==="snooze"?"Snoozed":destination==="settle"?"Settled":destination];
  const first=target&&agentRuntime==="codex"&&orderedSectionsRef.current.includes(String(target.id))?sectionTop(target.id,thread.id):null;
  await rpc.request("thread/section/move",{threadId:thread.id,sectionId:target?.id||null,beforeThreadId:first?.id||null});
  const updated={...thread,section:target||null,sectionEnteredAt:target?Date.now()/1000:null,sectionRank:first?first.sectionRank-1:null,sectionPlaced:Boolean(first)};setThreads(prev=>prev.map(t=>t.id===thread.id?updated:t));if(activeThread?.id===thread.id)setActiveThread(updated);await updateThreadMeta(thread.id,{sectionName:target?.name||"Active"});
  loadThreads(rpc);
}
// wasActive: the thread is the one the sidebar and header name, which is the thread still opening when there is one.
export async function reversibleThreadAction(deps,thread,action,{snoozeUntil=null,offerUndo=true}={}){
  const {rpc,rpcStatus,agentRuntimeLabel,openingThreadRef,activeThreadRef,updateThreadMeta,newChat,setThreads,leaveRemovedThread,loadThreads,openThread,offerThreadUndo}=deps;
  const snapshot=captureThreadPlacement(deps,thread);const wasActive=String(openingThreadRef.current||activeThreadRef.current?.id||"")===String(thread.id);let label="Thread updated";let undo=null;
  if(action==="pin"){
    if(thread.section?.name==="Pinned")return null;
    await moveThread(deps,thread,"pin");label="Thread pinned";undo=restored=>restoreThreadPlacement(deps,thread,snapshot,restored);
  }else if(action==="settle"){
    if(thread.section?.name==="Settled")return null;
    await moveThread(deps,thread,"settle");label="Thread settled";undo=restored=>restoreThreadPlacement(deps,thread,snapshot,restored);
  }else if(action==="active"){
    const previous=thread.section?.name||"Active";if(previous==="Active"&&!snapshot.snoozedUntil)return null;
    await moveThread(deps,thread,"active");await updateThreadMeta(thread.id,{snoozedUntil:null});
    label=previous==="Pinned"?"Thread unpinned":previous==="Snoozed"?"Thread woken":previous==="Settled"?"Thread restored":"Thread moved to Active";
    undo=restored=>restoreThreadPlacement(deps,thread,snapshot,restored);
  }else if(action==="snooze"){
    if(!Number.isFinite(Number(snoozeUntil))||Number(snoozeUntil)<=Date.now())throw new Error("Choose a future snooze time.");
    // The wake time is saved first, so the thread shows it as it lands in Snoozed; a move the harness refuses takes it back.
    await updateThreadMeta(thread.id,{snoozedUntil:Number(snoozeUntil)});
    try{await moveThread(deps,thread,"snooze")}catch(error){await updateThreadMeta(thread.id,{snoozedUntil:snapshot.snoozedUntil??null});throw error}
    label="Thread snoozed";undo=restored=>restoreThreadPlacement(deps,thread,snapshot,restored);
  }else if(action==="archive"){
    if(!rpc||rpcStatus!=="connected")throw new Error(agentRuntimeLabel+" is not connected");
    // A thread still opening ends its open first, so that its answer cannot bring the archived thread back (nor save it un-archived).
    if(openingThreadRef.current===String(thread.id))await newChat();
    await rpc.request("thread/archive",{threadId:thread.id});await updateThreadMeta(thread.id,{archived:true});setThreads(prev=>prev.filter(t=>t.id!==thread.id));await leaveRemovedThread(thread.id);label="Thread archived";
    undo=async(restored=null)=>{
      const result=await rpc.request("thread/unarchive",{threadId:thread.id});
      const restoredThread=result?.thread||thread;
      // Unarchiving keeps a thread's section and its place there (Codex and the agent relay both do): it moves only if it came back elsewhere.
      if((restoredThread.section?.id||null)!==(snapshot.section?.id||null))await restoreSectionPlace(deps,thread,snapshot,restored);
      restored?.set(thread.id,snapshot.section?.id||null);
      await updateThreadMeta(thread.id,{snoozedUntil:snapshot.snoozedUntil??null,archived:false,sectionName:snapshot.section?.name||"Active"});const shown=restoreThreadLocally(deps,restoredThread,snapshot);
      loadThreads(rpc);if(wasActive)await openThread(shown);
    };
  }else return null;
  const result={label,undo,threadId:thread.id,title:titleOf(thread),anchorThreadId:snapshot.anchorThreadId,beforeThreadId:snapshot.beforeThreadId};if(offerUndo&&undo)offerThreadUndo(label,()=>undoThreadActions([result]));return result;
}
// An undo of several threads puts each back after the thread it goes before, when that one is put back too (thread-moves.js). It
// tries every thread, as the action did, and the error names the ones the harness would not put back, each with its reason
// ("Could not put back “X”: …"). The verb is the Undo's for every action: an Un-settle's Undo toast reads "Thread restored", so
// "restore" would name the opposite of what failed there.
async function undoThreadActions(results){
  const restored=new Map(),failed=[];
  for(const result of undoOrder(results)){try{await result.undo?.(restored)}catch(error){failed.push({title:result.title,error})}}
  if(failed.length)throw new Error(bulkActionFailure("put back",failed));
}
export async function threadAction(deps,thread,action){
  const {rpc,rpcStatus,agentRuntimeLabel,agentRuntime,setSnoozeRequest,presetFor,permissionMode,model,provider,projectPath,setThreads,openThread,askConfirm,openingThreadRef,newChat,leaveRemovedThread}=deps;
  // A refusal names the action and the thread with its reason, as a bulk action's does, so one made while the harness was away still
  // reads as that refusal once it is back ("Could not archive “X”: Trebell Native is not connected."), not as the harness away.
  const refused=(verb,error)=>new Error(bulkActionFailure(verb,[{title:titleOf(thread),error}]));
  if(action==="pin"||action==="settle"||action==="active"||action==="archive"){
    try{await reversibleThreadAction(deps,thread,action)}catch(error){throw refused(action!=="active"?action:{Pinned:"unpin",Snoozed:"wake",Settled:"un-settle"}[thread.section?.name]||"move",error)}
    return;
  }
  if(action==="snooze"){setSnoozeRequest({threads:[thread],bulk:false});return}
  if(action==="fork"){
    if(!rpc)return;
    const p=presetFor(permissionMode);let result;
    try{result=await rpc.request("thread/fork",{threadId:thread.id,...(agentRuntime==="codex"?{}:{model:model||null}),...(agentRuntime==="native"?{modelProvider:provider}:{}),cwd:thread.cwd||projectPath,approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,threadSource:"trebell-code",excludeTurns:true})}catch(error){throw refused("fork",error)}
    if(result?.thread){setThreads(prev=>[result.thread,...prev.filter(t=>t.id!==result.thread.id)]);await openThread(result.thread)}
    return;
  }
  if(action==="delete"){
    // As Archive: with the harness away, the delete could not happen, so it is refused before it asks or leaves the thread.
    if(!rpc||rpcStatus!=="connected")throw refused("delete",agentRuntimeLabel+" is not connected");
    if(!await askConfirm("Delete “"+titleOf(thread)+"” permanently? This cannot be undone.",{confirm:"Delete thread"}))return;
    if(openingThreadRef.current===String(thread.id))await newChat();
    try{await rpc.request("thread/delete",{threadId:thread.id})}catch(error){throw refused("delete",error)}
    setThreads(prev=>prev.filter(t=>t.id!==thread.id));
    await leaveRemovedThread(thread.id);
    return;
  }
}
// Moves are written to the runtime one at a time, in the order a person makes them, and each shows at once: the sidebar takes the new
// order before the runtime answers, so a move made while an earlier one is still being written or read back starts from the order on
// screen. A move that fails drops the moves queued after it (they started from its order) and the list is read again. A listing read
// while moves are queued keeps the places on screen (loadThreads); the last move's own listing brings the runtime's.
// The move steps past the neighbour the sidebar shows (a search's results while one filters it), as the menu's enabled state says.
export async function moveThreadOrder(deps,thread,direction){
  const {threads,threadMeta,displayThreads,agentRuntime,setThreads,setSearchResults,threadMovesRef,rpc,loadThreads}=deps;
  const move=threadMoveTarget(threads,thread,direction,threadMeta,displayThreads);if(!move)return;
  const sectionId=thread.section?.id||null,ordering=agentRuntime==="codex"&&Boolean(sectionId)&&!thread.sectionPlaced;
  const shown=threadOrderGroup(threads,thread,threadMeta).map(item=>item.id);
  const places=movedSectionRanks(threads,thread,move.beforeThreadId,threadMeta,{placeAll:ordering});
  const place=list=>list&&list.map(item=>places.has(item?.id)?{...item,...places.get(item.id)}:item);
  setThreads(place);setSearchResults(place);
  const queue=threadMovesRef.current,epoch=queue.epoch;queue.pending++;queue.made++;
  const write=queue.tail.then(async()=>{
    if(queue.epoch!==epoch)return;
    if(ordering)await orderCodexSection(deps,thread,sectionId,move.beforeThreadId,shown);
    else await rpc.request("thread/section/move",{threadId:thread.id,sectionId,beforeThreadId:move.beforeThreadId});
  });
  queue.tail=write.catch(()=>{});
  let failure=null;try{await write}catch(error){failure=error;queue.epoch++}
  queue.pending--;
  if(failure){
    await loadThreads(rpc);
    throw new Error("Could not move “"+titleOf(thread)+"”: "+String(failure?.message||failure||"Unknown error").replace(/[.\s]+$/,"")+".");
  }
  if(!queue.pending)await loadThreads(rpc,{strict:true});
}
// The first move in a Codex section shown by recent activity: Codex's order for it is the order threads entered it, so the section is
// first written in the order the sidebar showed (shown: ids, top first), with the move made, and is shown in Codex's order from then on.
// Only then is it saved as ordered: a write that fails part way leaves it shown by recent activity, and the next move writes it again.
// A failure names what could not be done to the section.
async function orderCodexSection({rpc,orderedSectionsRef,saveAppSettings},thread,sectionId,beforeThreadId,shown){
  const name=thread.section?.name||sectionId,detail=error=>String(error?.message||error||"Unknown error").replace(/[.\s]+$/,"");
  let listed;
  try{listed=await loadThreadListPages(rpc,{params:threadSectionOrderParams(sectionId),maxPages:100})}
  catch(error){throw new Error("the order of "+name+" could not be read ("+detail(error)+")")}
  if(listed.truncated)throw new Error(name+" holds too many threads to order");
  const members=listed.data.filter(item=>(item.section?.id||null)===sectionId);
  const desired=orderedSectionWithMove(shown,members,thread.id,beforeThreadId);
  for(const id of sectionOrderWrites(members.map(item=>item.id),desired))await rpc.request("thread/section/move",{threadId:id,sectionId,beforeThreadId:null});
  const ordered=[...new Set([...orderedSectionsRef.current,String(sectionId)])];
  try{await saveAppSettings({orderedThreadSections:ordered})}
  catch(error){throw new Error("the new order of "+name+" could not be saved ("+detail(error)+")")}
  orderedSectionsRef.current=ordered;
}
// A bulk action tries every thread, one at a time: the ones it changed share one Undo, and the ones the harness refused stay
// selected while the error names each with its reason (failed: {thread,title,error}).
async function eachThreadAction(list,act){
  const results=[],failed=[];
  for(const thread of list){try{const result=await act(thread);if(result)results.push(result)}catch(error){failed.push({thread,title:titleOf(thread),error})}}
  return {results,failed};
}
export async function bulkAction(deps,action){
  const {selectedThreadIds,threads,setSnoozeRequest,setSelectedThreadIds,offerThreadUndo}=deps;
  const selected=[...selectedThreadIds].map(id=>threads.find(thread=>thread.id===id)).filter(Boolean);if(!selected.length)return;
  if(action==="snooze"){setSnoozeRequest({threads:selected,bulk:true});return}
  const {results,failed}=await eachThreadAction(selected,thread=>reversibleThreadAction(deps,thread,action,{offerUndo:false}));
  setSelectedThreadIds(new Set(failed.map(item=>item.thread.id)));
  if(results.length){const noun=results.length===1?"Thread":results.length+" threads";const verb=action==="pin"?"pinned":action==="settle"?"settled":action==="archive"?"archived":"updated";offerThreadUndo(noun+" "+verb,()=>undoThreadActions(results))}
  if(failed.length)throw new Error(bulkActionFailure(action,failed));
}
// A thread the harness will not snooze keeps the dialog open on it, which says why: the open thread's activity is about another
// thread.
export async function submitSnooze(deps,until){
  const {snoozeRequest,setSelectedThreadIds,offerThreadUndo,setSnoozeRequest}=deps;
  const request=snoozeRequest;if(!request)return;
  const {results,failed}=await eachThreadAction(request.threads||[],thread=>reversibleThreadAction(deps,thread,"snooze",{snoozeUntil:until,offerUndo:false}));
  if(request.bulk)setSelectedThreadIds(new Set(failed.map(item=>item.thread.id)));
  if(results.length){const label=results.length===1?"Thread snoozed":results.length+" threads snoozed";offerThreadUndo(label,()=>undoThreadActions(results))}
  if(!failed.length){setSnoozeRequest(null);return}
  setSnoozeRequest({...request,threads:failed.map(item=>item.thread)});
  throw new Error(bulkActionFailure("snooze",failed));
}

// A thread a pull request links, opened from the Source panel: read when the list does not have it, restored first when archived.
export async function openLinkedThread(deps,reference){
  const {openThread,rpc,rpcStatus,setThreads,threads,updateThreadMeta}=deps;
  if(!rpc||rpcStatus!=="connected"||!reference?.threadId)throw new Error("The agent harness is not connected.");
  let thread=threads.find(item=>item.id===reference.threadId)||null,readError=null;
  if(!thread){
    try{
      const read=await rpc.request("thread/read",{threadId:reference.threadId,includeTurns:false});
      thread=read?.thread||null;
    }catch(error){readError=error}
  }
  const archived=Boolean(reference.archived||thread?.archived);
  if(archived){
    let restored;
    try{restored=await rpc.request("thread/unarchive",{threadId:reference.threadId})}
    catch(error){throw new Error("Could not restore archived thread: "+(error?.message||String(error)),{cause:error})}
    if(!restored?.thread&&!thread)throw new Error("The agent runtime did not return the restored thread.");
    thread=restored?.thread||thread;
    if(!thread){
      const read=await rpc.request("thread/read",{threadId:reference.threadId,includeTurns:false});
      thread=read?.thread||null;
    }
    await updateThreadMeta(reference.threadId,{archived:false});
    if(thread)thread={...thread,archived:false};
  }
  if(!thread&&readError)throw new Error("Could not load linked thread: "+(readError?.message||String(readError)));
  if(!thread)throw new Error("Linked thread was not found.");
  setThreads(prev=>[thread,...prev.filter(item=>item.id!==thread.id)]);
  await openThread(thread);
}
