import { randomUUID } from "node:crypto";
import { boundDiagnosticText, boundDiagnosticValue } from "./diagnostic-bounds.mjs";
import { redactSecretText, redactSecretValue } from "./secret-redactor.mjs";
import { isToolCallItem } from "./goal-state.mjs";
import { SqliteAgentThreadStore, threadFromRow } from "./sqlite-agent-thread-store.mjs";

function clone(value){return JSON.parse(JSON.stringify(value))}
const TERMINAL_TOOL_STATUSES=new Set(["completed","failed","cancelled","canceled","rejected","declined","skipped"]);
const REASONING_PART_LIMIT=64*1024;
// How much parsed history the store keeps: the 2 threads used last, at most 32 M characters of their stored JSON, each dropped after
// a minute unused.
const THREAD_CACHE=Object.freeze({entries:2,chars:32*1024*1024,idleMs:60_000});
// The items a turn's search rows come from: its user messages and its last agent message.
const searchedItem=item=>item?.type==="userMessage"||item?.type==="agentMessage";

function recoveryToolSummary(item={}){
  return {
    id:item.id==null?null:String(item.id),type:item.type==null?null:String(item.type),status:item.status==null?null:String(item.status),
    namespace:item.namespace==null?null:String(item.namespace),tool:item.tool==null?null:String(item.tool),command:item.command==null?null:String(item.command).slice(0,1000),
  };
}

export function interruptedTurnRecoverySafety(turn={}){
  const uncertainTools=[];
  for(const item of Array.isArray(turn?.items)?turn.items:[]){
    if(!isToolCallItem(item))continue;
    const status=String(item?.status||"").trim().toLowerCase();
    if(TERMINAL_TOOL_STATUSES.has(status))continue;
    uncertainTools.push(recoveryToolSummary(item));
  }
  return uncertainTools.length
    ?{safe:false,reason:"uncertain_tool_action",uncertainTools,message:"Automatic restart continuation is blocked because a tool or action was still unresolved when Trebell stopped. Inspect its real-world state before repeating it."}
    :{safe:true,reason:"no_uncertain_tool_action",uncertainTools:[]};
}
function persistedItem(item,environment){
  const next={...item};
  if(Object.prototype.hasOwnProperty.call(next,"aggregatedOutput")&&next.aggregatedOutput!=null)next.aggregatedOutput=redactSecretText(boundDiagnosticText(next.aggregatedOutput,256*1024),{environment});
  if(Object.prototype.hasOwnProperty.call(next,"rawInput"))next.rawInput=redactSecretValue(boundDiagnosticValue(next.rawInput,{maxChars:128*1024,maxFields:768,maxDepth:12}),{environment,maxDepth:12,maxArray:200,maxFields:768});
  if(Object.prototype.hasOwnProperty.call(next,"rawOutput")){
    next.rawOutput=typeof next.rawOutput==="string"
      ?redactSecretText(boundDiagnosticText(next.rawOutput,256*1024),{environment})
      :redactSecretValue(boundDiagnosticValue(next.rawOutput,{maxChars:256*1024,maxFields:1024,maxDepth:12}),{environment,maxDepth:12,maxArray:200,maxFields:1024});
  }
  if(Object.prototype.hasOwnProperty.call(next,"arguments"))next.arguments=redactSecretValue(boundDiagnosticValue(next.arguments,{maxChars:128*1024,maxFields:768,maxDepth:12}),{environment,maxDepth:12,maxArray:200,maxFields:768});
  if(Object.prototype.hasOwnProperty.call(next,"contentItems"))next.contentItems=redactSecretValue(boundDiagnosticValue(next.contentItems,{maxChars:128*1024,maxFields:768,maxDepth:12}),{environment,maxDepth:12,maxArray:200,maxFields:768});
  // A harness can think at length: each part of a reasoning item keeps its start and its end.
  if(next.type==="reasoning")for(const key of ["summary","content"])if(Array.isArray(next[key]))next[key]=next[key].map(part=>typeof part==="string"?redactSecretText(boundDiagnosticText(part,REASONING_PART_LIMIT),{environment}):part);
  return next;
}

// A thread's title from its first message: one line of at most 50 characters (T3 Code titles a new thread by its first message).
export function threadTitleFromText(value){
  const message=String(value??"").trim().replace(/\s+/g," ");
  return message?(message.length<=50?message:message.slice(0,50)+"..."):null;
}

export class AgentThreadStore{
  // The threads read or written last, parsed, so a streamed chunk or a page of history does not read and parse the whole stored
  // thread (a chunk into a 0.5 MB thread parsed 1 MB). This store is the only writer of the agent tables (one GUI server per home;
  // the CLI and the benchmarks only read them), and an entry changes only once sqlite has the write, built from the JSON text and
  // the row written, in sqlite's turn order, and is dropped on a failed write, so an entry is what a read of sqlite gives. Callers
  // of peek() share the entry and must not change it; every write builds new objects, so a peeked thread stays as it was.
  #cache=new Map();#cacheChars=0;#cacheTimer=null;
  constructor(env=process.env,{keepConnection=false}={}){
    this.env=env;
    this.storage=new SqliteAgentThreadStore(env,{keepConnection});
    this.path=this.storage.path;
    this.legacyPath=this.storage.legacyPath;
    this.data={version:2,threads:this.storage.listMetadata()};
    this.#titleUntitledThreads();
  }
  // A thread saved with no title, as every harness thread was before a new thread took its first message as its title, is titled
  // by its first message now (the sidebar listed them all as "Untitled task"); its place in the list does not change.
  #titleUntitledThreads(){
    let first=[];try{first=this.storage.untitledFirstMessages()}catch{return}
    for(const {id,text} of first){
      const thread=this.data.threads.find(item=>item.id===id),preview=threadTitleFromText(text);
      if(!thread||thread.name||thread.preview||!preview)continue;
      thread.preview=preview;this.storage.putThread(this.#safe(thread));
    }
  }
  #safe(value){return redactSecretValue(value,{environment:this.env,maxDepth:20,maxArray:10000,maxFields:5000})}
  // A write that replaces every turn drops the thread's entry (sqlite then holds the turns in the order they were written, with any
  // repeated or id-less turn as sqlite resolves it); the next read takes them from sqlite.
  #persistThread(thread,{replaceTurns=false}={}){
    // A meta write leaves the turns as they are, so they are neither redacted again nor sent.
    if(replaceTurns)this.#forget(thread.id);
    let row;try{row=this.storage.putThread(this.#safe(replaceTurns?thread:{...thread,turns:undefined}),{replaceTurns})}catch(error){this.#forget(thread.id);throw error}
    if(!replaceTurns)this.#written(thread.id,row);
  }
  #persistTurn(thread,turn,options={}){
    let written;try{written=this.storage.putThreadAndTurn(this.#safe({...thread,turns:undefined}),this.#safe(turn),options)}catch(error){this.#forget(thread.id);throw error}
    this.#written(thread.id,written.thread,written.turn);
  }
  // The stored thread, shared and read-only: no sqlite read and no parse once it is held. Callers must not change it.
  peek(id){
    const key=String(id);let entry=this.#cache.get(key);
    if(entry){this.#cache.delete(key);this.#cache.set(key,entry)}
    else{
      const read=this.storage.read(key);if(!read)return null;
      const chars=read.metaChars+read.order.reduce((sum,turn)=>sum+turn.chars,0);
      // A thread with a turn that did not parse, or one larger than the whole bound, is served as read and not kept.
      if(!read.complete||chars>THREAD_CACHE.chars)return read.thread;
      entry={thread:read.thread,order:read.order,metaChars:read.metaChars,chars,usedAt:0};
      this.#cache.set(key,entry);this.#cacheChars+=chars;this.#trimCache();
    }
    entry.usedAt=Date.now();this.#armCacheTimer();return entry.thread;
  }
  // After a write sqlite took: the entry takes the meta row and the turn as written. A new turn goes after every turn that sorts
  // at or before it (its rowid is the largest); a turn whose start time changed would move among equal times by a rowid the entry
  // does not know, so that drops the entry.
  #written(id,row,turnRow=null){
    const key=String(id),entry=this.#cache.get(key);if(!entry)return;
    let turns=entry.thread.turns,order=entry.order,chars=entry.chars-entry.metaChars+row.payload_json.length;
    if(turnRow){
      const turn=JSON.parse(turnRow.payload_json),place={id:turnRow.id,key:turnRow.started_at??0,chars:turnRow.payload_json.length},index=order.findIndex(item=>item.id===place.id);
      if(index>=0&&order[index].key!==place.key)return this.#forget(key);
      turns=turns.slice();order=order.slice();
      if(index>=0){chars+=place.chars-order[index].chars;turns[index]=turn;order[index]=place}
      else{let at=order.findIndex(item=>item.key>place.key);if(at<0)at=order.length;turns.splice(at,0,turn);order.splice(at,0,place);chars+=place.chars}
    }
    this.#cacheChars+=chars-entry.chars;
    Object.assign(entry,{thread:threadFromRow(row,turns),order,metaChars:row.payload_json.length,chars,usedAt:Date.now()});
    this.#cache.delete(key);this.#cache.set(key,entry);this.#trimCache();
  }
  #forget(id){const key=String(id),entry=this.#cache.get(key);if(!entry)return;this.#cache.delete(key);this.#cacheChars-=entry.chars}
  #trimCache(){for(const key of this.#cache.keys()){if(this.#cache.size<=THREAD_CACHE.entries&&this.#cacheChars<=THREAD_CACHE.chars)break;this.#forget(key)}}
  // One timer for the entry used longest ago; it does not keep the process alive.
  #armCacheTimer(){
    if(this.#cacheTimer||!this.#cache.size)return;
    const oldest=Math.min(...[...this.#cache.values()].map(entry=>entry.usedAt));
    this.#cacheTimer=setTimeout(()=>{
      this.#cacheTimer=null;const now=Date.now();
      for(const [key,entry] of this.#cache)if(now-entry.usedAt>=THREAD_CACHE.idleMs)this.#forget(key);
      this.#armCacheTimer();
    },Math.max(0,oldest+THREAD_CACHE.idleMs-Date.now())+1);
    this.#cacheTimer.unref?.();
  }
  // Drops the parsed threads and closes the sqlite connection a store built with keepConnection holds. Later calls open their own.
  close(){clearTimeout(this.#cacheTimer);this.#cacheTimer=null;this.#cache.clear();this.#cacheChars=0;this.storage.close()}
  #metadata(thread){const next={...thread,turns:[]};return next}
  #cacheMetadata(thread){
    const next=this.#metadata(thread),index=this.data.threads.findIndex(item=>item.id===thread.id);
    if(index>=0)this.data.threads[index]=next;else this.data.threads.unshift(next);return next;
  }
  reconcileRestart({continueAfterRestart=false}={}){
    const now=Math.floor(Date.now()/1000),recoverable=[],changed=[],candidateIds=new Set(this.storage.activeThreadIds());
    for(const thread of this.data.threads)if(thread.status?.type==="active")candidateIds.add(thread.id);
    for(const id of candidateIds){
      const thread=this.storage.get(id);if(!thread)continue;
      const activeTurn=[...(thread.turns||[])].reverse().find(turn=>["inProgress","running","starting"].includes(turn?.status));
      const stale=thread.status?.type==="active"||Boolean(activeTurn);
      if(!stale)continue;
      changed.push(thread);
      const recoverySafety=activeTurn?interruptedTurnRecoverySafety(activeTurn):{safe:true,uncertainTools:[]};
      if(activeTurn&&continueAfterRestart&&thread.providerSessionId&&recoverySafety.safe){
        activeTurn.status="interrupted";activeTurn.completedAt=now;activeTurn.durationMs=activeTurn.startedAt?Math.max(0,(now-activeTurn.startedAt)*1000):null;
        activeTurn.error={message:"Trebell restarted while this turn was running. Recovery is queued."};
        thread.status={type:"idle"};thread.recovery={pending:true,turnId:activeTurn.id,createdAt:now};recoverable.push({threadId:thread.id,turnId:activeTurn.id,runtime:thread.runtime});
      }else if(activeTurn&&continueAfterRestart&&thread.providerSessionId&&!recoverySafety.safe){
        activeTurn.status="interrupted";activeTurn.completedAt=now;activeTurn.durationMs=activeTurn.startedAt?Math.max(0,(now-activeTurn.startedAt)*1000):null;
        activeTurn.error={message:recoverySafety.message};
        thread.status={type:"systemError"};thread.recovery={pending:false,blocked:true,turnId:activeTurn.id,createdAt:now,reason:recoverySafety.reason,message:recoverySafety.message,uncertainTools:recoverySafety.uncertainTools};
      }else{
        if(activeTurn){activeTurn.status="failed";activeTurn.completedAt=now;activeTurn.durationMs=activeTurn.startedAt?Math.max(0,(now-activeTurn.startedAt)*1000):null;activeTurn.error={message:"Agent session was interrupted by a Trebell restart. Send a new message to continue."}}
        thread.status={type:"systemError"};delete thread.recovery;
      }
      thread.updatedAt=now;
    }
    for(const thread of changed){this.#persistThread(thread,{replaceTurns:true});this.#cacheMetadata(thread)}return clone(recoverable);
  }
  list(runtime=null){
    return clone(this.data.threads.filter(thread=>!runtime||thread.runtime===runtime).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)));
  }
  getMetadata(id){
    const thread=this.data.threads.find(item=>item.id===id);return thread?clone(thread):null;
  }
  searchCandidates(runtime,searchTerm,{archived=false}={}){return clone(this.storage.searchCandidates({runtime,term:searchTerm,archived}))}
  get(id){const thread=this.peek(id);return thread?clone(thread):null}
  findProviderSession(runtime,providerSessionId){
    const id=String(providerSessionId||"");if(!id)return null;
    return clone(this.storage.findProviderSession(runtime,id));
  }
  create({runtime,cwd,providerSessionId,model=null,agent=null,name=null,preview=null,providerMeta=null}={}){
    const now=Math.floor(Date.now()/1000);
    const thread={
      id:randomUUID(),runtime:String(runtime||"external"),providerSessionId:String(providerSessionId||""),cwd:String(cwd||process.cwd()),
      model:model||null,agent:agent||null,name:name||null,preview:preview||null,providerMeta:providerMeta||null,createdAt:now,updatedAt:now,
      status:{type:"idle"},turns:[],archived:false,section:null,
    };
    this.#cacheMetadata(thread);this.#persistThread(thread,{replaceTurns:true});return clone(thread);
  }
  importHistory({runtime,cwd,providerSessionId,model=null,agent=null,name=null,preview=null,providerMeta=null,turns=[],createdAt=null,updatedAt=null}={}){
    const existing=this.findProviderSession(runtime,providerSessionId);if(existing)return existing;
    const now=Math.floor(Date.now()/1000);
    const normalizeTime=value=>{const number=Number(value)||0;return number>10_000_000_000?Math.floor(number/1000):Math.floor(number)};
    const created=normalizeTime(createdAt)||now,updated=normalizeTime(updatedAt)||created;
    const thread={
      id:randomUUID(),runtime:String(runtime||"external"),providerSessionId:String(providerSessionId||""),cwd:String(cwd||process.cwd()),
      model:model||null,agent:agent||null,name:name||null,preview:preview||null,providerMeta:providerMeta||null,createdAt:created,updatedAt:updated,
      status:{type:"idle"},turns:clone(turns).map(turn=>({...turn,status:"completed"})),archived:false,section:null,
    };
    this.#cacheMetadata(thread);this.#persistThread(thread,{replaceTurns:true});return clone(thread);
  }
  // touch:false keeps the thread's last-update time: a place in a section is not activity (Codex does not change it either).
  update(id,patch={},{touch=true}={}){
    const current=this.peek(id);if(!current)return null;
    const thread={...current,...patch,...(touch?{updatedAt:Math.floor(Date.now()/1000)}:{})};this.#persistThread(thread,{replaceTurns:Object.prototype.hasOwnProperty.call(patch,"turns")});this.#cacheMetadata(thread);return clone(thread);
  }
  delete(id){this.#forget(id);const before=this.data.threads.length;this.data.threads=this.data.threads.filter(thread=>thread.id!==id);if(this.data.threads.length!==before)this.storage.delete(id);return before!==this.data.threads.length}
  // The thread and its turn turnId, from the shared copy; a write changes neither.
  #turnOf(threadId,turnId){
    const thread=this.peek(threadId),turn=thread?.turns?.find(item=>item.id===turnId);return turn?{thread,turn}:null;
  }
  addTurn(threadId,{id=randomUUID(),inputText="",items=[],status="inProgress",startedAt=Math.floor(Date.now()/1000)}={}){
    const current=this.peek(threadId);if(!current)return null;
    const turn={id,status,startedAt,completedAt:null,durationMs:null,error:null,items:[
      ...(inputText?[{type:"userMessage",id:`user-${id}`,clientId:null,content:[{type:"text",text:redactSecretText(inputText,{environment:this.env})}]}]:[]),
      ...items,
    ]};
    const thread={...current,status:{type:"active",activeFlags:[]},updatedAt:Math.floor(Date.now()/1000)};this.#persistTurn(thread,turn);this.#cacheMetadata(thread);return clone(turn);
  }
  updateTurn(threadId,turnId,patch={}){
    const found=this.#turnOf(threadId,turnId);if(!found)return null;
    const turn={...found.turn,...patch},thread={...found.thread,updatedAt:Math.floor(Date.now()/1000)};this.#persistTurn(thread,turn);this.#cacheMetadata(thread);return clone(turn);
  }
  restartTurn(threadId,turnId){
    const found=this.#turnOf(threadId,turnId);if(!found)return null;
    const turn={...found.turn,status:"inProgress",completedAt:null,durationMs:null,error:null},thread={...found.thread,status:{type:"active",activeFlags:[]}};
    if(thread.recovery)thread.recovery={...thread.recovery,pending:false,startedAt:Math.floor(Date.now()/1000)};
    thread.updatedAt=Math.floor(Date.now()/1000);this.#persistTurn(thread,turn);this.#cacheMetadata(thread);return clone(turn);
  }
  addItem(threadId,turnId,item){
    const found=this.#turnOf(threadId,turnId);if(!found)return null;
    const index=found.turn.items.findIndex(entry=>entry.id===item.id),previous=index>=0?found.turn.items[index]:null;
    const stored=persistedItem(previous?{...previous,...item}:item,this.env),items=found.turn.items.slice();
    if(index>=0)items[index]=stored;else items.push(stored);
    // A tool's item leaves the turn's searched items where they were, so its search rows are not rewritten.
    const thread={...found.thread,updatedAt:Math.floor(Date.now()/1000)};this.#persistTurn(thread,{...found.turn,items},{searchUnchanged:!searchedItem(previous)&&!searchedItem(stored)});this.#cacheMetadata(thread);return clone(stored);
  }
  finishTurn(threadId,turnId,{status="completed",error=null}={}){
    const found=this.#turnOf(threadId,turnId);if(!found)return null;
    const completedAt=Math.floor(Date.now()/1000),turn={...found.turn,status,error,completedAt};
    turn.durationMs=turn.startedAt?Math.max(0,(completedAt-turn.startedAt)*1000):null;
    const thread={...found.thread,status:status==="failed"?{type:"systemError"}:{type:"idle"}};delete thread.recovery;thread.updatedAt=completedAt;this.#persistTurn(thread,turn);this.#cacheMetadata(thread);return clone(turn);
  }
  rename(id,name){return this.update(id,{name:String(name||"").trim()||null})}
}
