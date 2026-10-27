// "Allow session" on a Codex approval allows that kind of request for the rest of the thread's session (T3 39aeaf404): Codex's own
// acceptForSession only skips the exact command or patch it answered, so every new command asked again. The allowances are kept
// per thread and permission mode. A turn in another mode ends them, and so does the thread unloading (thread/unsubscribe, closed,
// archived or deleted) or its app-server ending, as with Codex's own session approvals. Network access and extra permissions
// stay per request.
const KINDS={
  "item/commandExecution/requestApproval":"command",execCommandApproval:"command",
  "item/fileChange/requestApproval":"fileChange",applyPatchApproval:"fileChange",
};
const LEGACY=new Set(["execCommandApproval","applyPatchApproval"]);

// The kind of an approval request that "Allow session" can cover, or null.
export function sessionApprovalKind(method,params={}){
  const kind=KINDS[method]||null;
  return kind==="command"&&params?.networkApprovalContext?null:kind;
}
// The thread an approval belongs to: Codex's v2 requests name it threadId, its legacy ones conversationId.
export function approvalThreadId(params={}){
  return String(params?.threadId||params?.conversationId||"").trim();
}
// Whether an answer allows the request's kind for the session.
export function allowsSession(method,result){
  return result?.decision===(LEGACY.has(method)?"approved_for_session":"acceptForSession");
}
// The answer Codex gets for a request the session already allows.
export function sessionApprovalResult(method){
  return {decision:LEGACY.has(method)?"approved_for_session":"acceptForSession"};
}

export function createCodexSessionApprovals(){
  const threads=new Map();
  return {
    // The kinds allowed in a thread for a request made in a permission mode, read as the request comes. The answer to it adds to this
    // same set, so one that comes after a turn in another mode ended the allowance adds nothing.
    allowance(threadId,mode){
      const id=String(threadId||"");if(!id)return new Set();
      const record=threads.get(id);
      if(record?.mode===mode)return record.kinds;
      if(record)return new Set();
      const kinds=new Set();threads.set(id,{mode,kinds});return kinds;
    },
    // A turn starts in a permission mode: another mode than the allowance's ends it.
    turnStarted(threadId,mode){
      const id=String(threadId||""),record=threads.get(id);
      if(record&&record.mode!==mode)threads.delete(id);
    },
    end(threadId){threads.delete(String(threadId||""))},
    clear(){threads.clear()},
    size:()=>threads.size,
  };
}
