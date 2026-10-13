// What a window keeps about threads it may not be showing: a send that failed in one while another view was shown (its draft and note,
// given back when the thread is opened again), and the turns a Stop was sent for (read as Stopping until they end, so a press sends no
// second interrupt). A thread archived or deleted, here or in another window, takes both with it. A thread whose session closes (Codex
// unloads a thread the window left, the agent relay's idle sweep lets its harness go) or that reads idle has no turn left to stop; its
// failed send is the person's text, and waits for the thread to open again. Both stay bounded, the oldest going first, so a window
// open for days does not collect them.
const FAILED_SEND_LIMIT=20,SENT_STOP_LIMIT=100;
const stopKey=(threadId,turnId)=>String(threadId||"")+"\0"+String(turnId||"");
// A Map or a Set keeps the order its entries came in: the first is the oldest.
function keepWithin(collection,limit){while(collection.size>limit)collection.delete(collection.keys().next().value)}
export function createThreadTurnNotes({failedSendLimit=FAILED_SEND_LIMIT,sentStopLimit=SENT_STOP_LIMIT}={}){
  const failedSends=new Map(),sentStops=new Set();
  // The Stops sent for a thread's turns, but for keepTurnId's.
  function endStops(threadId,keepTurnId=null){
    const prefix=String(threadId||"")+"\0",kept=keepTurnId==null?null:stopKey(threadId,keepTurnId);
    for(const key of sentStops)if(key.startsWith(prefix)&&key!==kept)sentStops.delete(key);
  }
  function endThread(threadId){failedSends.delete(String(threadId||""));endStops(threadId)}
  return {
    sizes:()=>({failedSends:failedSends.size,sentStops:sentStops.size}),
    // A send that fails again in the same thread replaces its note, as the newest.
    failSend(threadId,value){const id=String(threadId||"");failedSends.delete(id);failedSends.set(id,value);keepWithin(failedSends,failedSendLimit)},
    takeFailedSend(threadId){const id=String(threadId||""),value=failedSends.get(id)||null;failedSends.delete(id);return value},
    stopSent(threadId,turnId){const key=stopKey(threadId,turnId);sentStops.delete(key);sentStops.add(key);keepWithin(sentStops,sentStopLimit)},
    stopFailed(threadId,turnId){sentStops.delete(stopKey(threadId,turnId))},
    stopWasSent(threadId,turnId){return sentStops.has(stopKey(threadId,turnId))},
    // A thread this window archived or deleted.
    threadEnded:endThread,
    // A thread that runs no turn, or only keepTurnId (as a thread reads when it opens): no Stop is on its way for the others.
    turnsEnded:endStops,
    // Each notification the window handles. A status of "notLoaded" says nothing of a turn (thread-sidebar-groups.js): the server that
    // unloads a thread says so with thread/closed.
    notify(message){
      const params=message?.params||{},threadId=params.threadId?String(params.threadId):"";if(!threadId)return;
      const method=message.method,status=params.status?.type;
      if(method==="turn/completed"){const turnId=params.turn?.id||params.turnId;if(turnId)sentStops.delete(stopKey(threadId,turnId))}
      else if(method==="thread/archived"||method==="thread/deleted")endThread(threadId);
      else if(method==="thread/closed"||method==="thread/status/changed"&&status&&status!=="active"&&status!=="notLoaded")endStops(threadId);
    },
  };
}
