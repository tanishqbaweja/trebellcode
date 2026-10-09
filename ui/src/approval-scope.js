// Approvals (like questions and app elicitations) are server requests, answered on the socket that asked. The relays keep a socket's
// open requests with that socket, fail them all when it closes ("Agent client disconnected"), and number them per socket, so the
// next socket reuses the same ids (agent-1, agent-2, ...). Each request therefore keeps the client it arrived on:
// - its answer goes back on that client, never on a newer socket where the same id can name a different request;
// - once a newer socket is connected, or the transport is torn down, requests from older sockets can no longer be answered and
//   leave the screen (live: an Antigravity "git log -n 5" approval stayed on screen in the next harness's thread).
export function ownedRequest(message,client){return {...message,client:client||null}}

// The requests still answerable when `client` is the live socket; none when there is no live socket.
export function liveRequests(items,client,ownerOf=item=>item?.client){
  const list=Array.isArray(items)?items:[];
  const kept=client?list.filter(item=>ownerOf(item)===client):[];
  return kept.length===list.length?list:kept;
}

// serverRequest/resolved names a request id (and maybe its thread); it resolves only the request of that id from the same socket.
export function requestResolvedBy(request,owner,{requestId,threadId=null,client=null}={}){
  if(!request||String(request.id)!==String(requestId??""))return false;
  if(client&&owner&&owner!==client)return false;
  return !threadId||!request.params?.threadId||String(request.params.threadId)===String(threadId);
}

// The approval the conversation shows first: the open thread's own, then one not tied to any thread, then another thread's.
export function approvalToShow(approvals,threadId){
  const list=Array.isArray(approvals)?approvals:[];
  const id=threadId?String(threadId):"";
  return (id&&list.find(item=>String(item?.params?.threadId||"")===id))||list.find(item=>!item?.params?.threadId)||list[0]||null;
}

// The thread an approval belongs to when that is not the open thread, so its card can say which task is asking.
export function approvalForeignThreadId(approval,threadId){
  const owner=approval?.params?.threadId?String(approval.params.threadId):"";
  return owner&&owner!==String(threadId||"")?owner:null;
}
