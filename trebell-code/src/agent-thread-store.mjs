import { randomUUID } from "node:crypto";
import { boundDiagnosticText, boundDiagnosticValue } from "./diagnostic-bounds.mjs";
import { redactSecretText, redactSecretValue } from "./secret-redactor.mjs";
import { isToolCallItem } from "./goal-state.mjs";
import { SqliteAgentThreadStore } from "./sqlite-agent-thread-store.mjs";

function clone(value){return JSON.parse(JSON.stringify(value))}
const TERMINAL_TOOL_STATUSES=new Set(["completed","failed","cancelled","canceled","rejected","declined","skipped"]);

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
  return next;
}

export class AgentThreadStore{
  constructor(env=process.env){
    this.env=env;
    this.storage=new SqliteAgentThreadStore(env);
    this.path=this.storage.path;
    this.legacyPath=this.storage.legacyPath;
    this.data={version:2,threads:this.storage.list()};
  }
  #safe(value){return redactSecretValue(value,{environment:this.env,maxDepth:20,maxArray:10000,maxFields:5000})}
  #persistThread(thread,{replaceTurns=false}={}){this.storage.putThread(this.#safe(thread),{replaceTurns})}
  #persistTurn(thread,turn){this.storage.putThreadAndTurn(this.#safe({...thread,turns:undefined}),this.#safe(turn))}
  reconcileRestart({continueAfterRestart=false}={}){
    const now=Math.floor(Date.now()/1000);const recoverable=[],changed=[];
    for(const thread of this.data.threads){
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
    for(const thread of changed)this.#persistThread(thread,{replaceTurns:true});return clone(recoverable);
  }
  list(runtime=null){
    return clone(this.data.threads.filter(thread=>!runtime||thread.runtime===runtime).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)));
  }
  get(id){return clone(this.data.threads.find(thread=>thread.id===id)||null)}
  findProviderSession(runtime,providerSessionId){
    const id=String(providerSessionId||"");if(!id)return null;
    return clone(this.data.threads.find(thread=>thread.runtime===runtime&&thread.providerSessionId===id)||null);
  }
  create({runtime,cwd,providerSessionId,model=null,agent=null,name=null,preview=null,providerMeta=null}={}){
    const now=Math.floor(Date.now()/1000);
    const thread={
      id:randomUUID(),runtime:String(runtime||"external"),providerSessionId:String(providerSessionId||""),cwd:String(cwd||process.cwd()),
      model:model||null,agent:agent||null,name:name||null,preview:preview||null,providerMeta:providerMeta||null,createdAt:now,updatedAt:now,
      status:{type:"idle"},turns:[],archived:false,section:null,
    };
    this.data.threads.unshift(thread);this.#persistThread(thread,{replaceTurns:true});return clone(thread);
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
    this.data.threads.unshift(thread);this.#persistThread(thread,{replaceTurns:true});return clone(thread);
  }
  update(id,patch={}){
    const thread=this.data.threads.find(item=>item.id===id);if(!thread)return null;
    Object.assign(thread,patch,{updatedAt:Math.floor(Date.now()/1000)});this.#persistThread(thread,{replaceTurns:Object.prototype.hasOwnProperty.call(patch,"turns")});return clone(thread);
  }
  delete(id){const before=this.data.threads.length;this.data.threads=this.data.threads.filter(thread=>thread.id!==id);if(this.data.threads.length!==before)this.storage.delete(id);return before!==this.data.threads.length}
  addTurn(threadId,{id=randomUUID(),inputText="",items=[],status="inProgress",startedAt=Math.floor(Date.now()/1000)}={}){
    const thread=this.data.threads.find(item=>item.id===threadId);if(!thread)return null;
    const turn={id,status,startedAt,completedAt:null,durationMs:null,error:null,items:[
      ...(inputText?[{type:"userMessage",id:`user-${id}`,clientId:null,content:[{type:"text",text:redactSecretText(inputText,{environment:this.env})}]}]:[]),
      ...items,
    ]};
    thread.turns.push(turn);thread.status={type:"active",activeFlags:[]};thread.updatedAt=Math.floor(Date.now()/1000);this.#persistTurn(thread,turn);return clone(turn);
  }
  updateTurn(threadId,turnId,patch={}){
    const thread=this.data.threads.find(item=>item.id===threadId);const turn=thread?.turns?.find(item=>item.id===turnId);if(!turn)return null;
    Object.assign(turn,patch);thread.updatedAt=Math.floor(Date.now()/1000);this.#persistTurn(thread,turn);return clone(turn);
  }
  restartTurn(threadId,turnId){
    const thread=this.data.threads.find(item=>item.id===threadId);const turn=thread?.turns?.find(item=>item.id===turnId);if(!turn)return null;
    turn.status="inProgress";turn.completedAt=null;turn.durationMs=null;turn.error=null;thread.status={type:"active",activeFlags:[]};
    if(thread.recovery)thread.recovery={...thread.recovery,pending:false,startedAt:Math.floor(Date.now()/1000)};
    thread.updatedAt=Math.floor(Date.now()/1000);this.#persistTurn(thread,turn);return clone(turn);
  }
  addItem(threadId,turnId,item){
    const thread=this.data.threads.find(entry=>entry.id===threadId);const turn=thread?.turns?.find(entry=>entry.id===turnId);if(!turn)return null;
    const index=turn.items.findIndex(entry=>entry.id===item.id);
    const stored=persistedItem(index>=0?{...turn.items[index],...item}:item,this.env);
    if(index>=0)turn.items[index]=stored;else turn.items.push(stored);
    thread.updatedAt=Math.floor(Date.now()/1000);this.#persistTurn(thread,turn);return clone(stored);
  }
  finishTurn(threadId,turnId,{status="completed",error=null}={}){
    const thread=this.data.threads.find(item=>item.id===threadId);const turn=thread?.turns?.find(item=>item.id===turnId);if(!turn)return null;
    const completedAt=Math.floor(Date.now()/1000);turn.status=status;turn.error=error;turn.completedAt=completedAt;
    turn.durationMs=turn.startedAt?Math.max(0,(completedAt-turn.startedAt)*1000):null;
    thread.status=status==="failed"?{type:"systemError"}:{type:"idle"};delete thread.recovery;thread.updatedAt=completedAt;this.#persistTurn(thread,turn);return clone(turn);
  }
  rename(id,name){return this.update(id,{name:String(name||"").trim()||null})}
}
