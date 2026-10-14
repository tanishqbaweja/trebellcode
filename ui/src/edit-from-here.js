import { api } from "./api.js";

// Edit from here once the person has said yes (App.jsx editFromHere), loaded then: nothing else needs it. In a worktree of its own
// the files go back to the checkpoint taken before the message, and then the conversation goes back to it; files and conversation go
// back together or not at all. The answer: {ok}, {refused} for a turn that runs, or {error,title} to show.
export async function rewindToMessage({client,message,threadId,isolatedWorktree,turnRunsNow}){
  let undoId=null;
  if(isolatedWorktree){
    // Another window's turn may not have reached this one yet, so before any file goes back the harness is asked whether the thread
    // runs. The server refuses (409) a thread whose turn started after that read, in any window, and puts back the files of one that
    // started while they went back. A restore that fails part-way leaves the files as they were before it (filesPutBack).
    const current=await client.request("thread/read",{threadId,includeTurns:false}).catch(()=>null);
    if(current?.thread?.status?.type==="active"||turnRunsNow())return {refused:true};
    try{undoId=(await api("/api/checkpoints/restore",{method:"POST",body:{id:message.checkpointId,threadId}}))?.undoId||null}
    catch(error){
      if(error?.status===409&&error?.data?.filesPutBack!==false)return {refused:true};
      const putBack=error?.data?.filesPutBack;
      return {error,title:putBack===true?"Could not restore the files, so they and the conversation were left as they were":putBack===false?"Could not restore the files, and some may not be as they were; the conversation was not changed":"Could not restore the files, so the conversation was not changed"};
    }
  }
  // A rewind the harness refuses (a running turn, a turn it has no checkpoint for) leaves the conversation as it is. The files it
  // restored go back to how they were before Edit from here, so files and conversation stay in step; a server that cannot take the
  // restore back (no undoId) leaves them at the checkpoint, and says so.
  try{await client.request("thread/revert",{threadId,beforeTurnId:message.turnId})}
  catch(error){
    if(!isolatedWorktree)return {error,title:"Could not edit from this message"};
    if(!undoId)return {error,title:"Restored the files to the checkpoint, but could not edit from this message"};
    const undone=await api("/api/checkpoints/undo",{method:"POST",body:{undoId,threadId}}).then(()=>null,undoError=>undoError);
    return {error,title:undone?"Could not edit from this message, and the files stay at the checkpoint ("+(undone.message||String(undone))+")":"Could not edit from this message, so the files were put back as they were"};
  }
  return {ok:true};
}
