// Source Control shows one context at a time:
// - repository: the project path in its environment;
// - writer: who writes the Git text (the active harness profile, or Trebell Native's model provider);
// - thread: the open thread, which owns the linked pull requests.
// Each error carries the scope it describes. A change of context clears exactly the errors about the old one, and a request that
// answers after its context changed is ignored (live: an OpenCode "Payment Required" Git-text error stayed after switching to Grok Build).
export const SOURCE_CONTROL_ERROR_SCOPES=Object.freeze(["repository","writer","thread"]);

// Windows paths compare without regard to case or slash direction; a remote (POSIX) path keeps its case.
export function sourceControlRepositoryKey(projectPath,environmentId=null){
  let path=String(projectPath??"").trim().replace(/\\/g,"/");
  if(path.length>1)path=path.replace(/\/+$/,"");
  if(/^[a-z]:(?:\/|$)/i.test(path))path=path.toLowerCase();
  return (environmentId?"environment:"+String(environmentId):"local")+"\u0000"+path;
}

// Every harness writes Git text with its own account and default model; Trebell Native writes it with its model provider.
export function gitTextWriterKey({agentRuntime="native",agentRuntimeInstanceId=null,provider=null}={}){
  const runtime=String(agentRuntime||"native");
  if(runtime==="native")return "native\u0000"+String(provider||"");
  return runtime+"\u0000"+String(agentRuntimeInstanceId||runtime+"-default");
}

export function sourceControlContext({projectPath="",environmentId=null,agentRuntime="native",agentRuntimeInstanceId=null,provider=null,threadId=null}={}){
  return {
    repository:sourceControlRepositoryKey(projectPath,environmentId),
    writer:gitTextWriterKey({agentRuntime,agentRuntimeInstanceId,provider}),
    thread:String(threadId||""),
  };
}

// Whether something that belongs to `started` (a request, or an error it produced) still describes `current`. Writer and thread
// state also belong to their repository.
export function sourceControlContextCurrent(started,current,scope="repository"){
  if(!started||!current||started.repository!==current.repository)return false;
  if(scope==="writer")return started.writer===current.writer;
  if(scope==="thread")return started.thread===current.thread;
  return true;
}

// The error left on screen when the context moves from `previous` to `next`: only one whose scope did not change.
export function sourceControlErrorAfterContextChange(error,previous,next){
  if(!error?.message)return null;
  return sourceControlContextCurrent(previous,next,error.scope||"repository")?error:null;
}

// Git text in flight, at most one request per kind (commit text, pull request text). The kinds are independent: asking for the
// commit text while the pull request text is still being written must not drop the pull request (its title and description
// prompts would never open). A newer request of a kind replaces the older one of that kind, and cancelAll (a change of writer or
// repository, or the panel closing) aborts every kind. A request whose answer may still land is `current`.
export function createGitTextRequests(){
  const pending=new Map();
  const current=request=>Boolean(request)&&pending.get(request.kind)===request;
  return {
    start(kind){
      const key=String(kind||"");
      pending.get(key)?.controller.abort();
      const request={kind:key,controller:new AbortController()};
      pending.set(key,request);return request;
    },
    current,
    // True once for a request that was still current: then its caller owns the busy state it set.
    finish(request){if(!current(request))return false;pending.delete(request.kind);return true},
    // The kinds that were cancelled, so their busy state can be released.
    cancelAll(){
      const cancelled=[...pending.values()];pending.clear();
      for(const request of cancelled)request.controller.abort();
      return cancelled.map(request=>request.kind);
    },
  };
}
