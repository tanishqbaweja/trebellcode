// The sidebar's live thread list.
//
// A runtime announces a new thread (the thread/started notification) before it answers thread/start: the agent relay broadcasts the
// notification and then returns the response on the same socket. Whichever of the two the UI applies second must replace the first,
// or the new thread is listed twice until the next catalog refresh (live: two "Untitled task" rows while a turn waited on approval).
export function prependThread(threads,thread){
  const list=Array.isArray(threads)?threads:[];
  if(!thread?.id)return list;
  const id=String(thread.id);
  return [thread,...list.filter(item=>String(item?.id)!==id)];
}

// Trebell starts ephemeral threads only for one-shot Git text (commit and pull request text), on a private app-server that no UI
// socket shares. They are never saved and must never be listed, even if a runtime ever announces one.
export const GIT_TEXT_THREAD_SOURCE="trebell-git-text";
export function isListedThread(thread){
  if(!thread?.id)return false;
  if(thread.ephemeral===true)return false;
  return thread.threadSource!==GIT_TEXT_THREAD_SOURCE&&thread.providerMeta?.threadSource!==GIT_TEXT_THREAD_SOURCE;
}
