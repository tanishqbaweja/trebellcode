import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { trebellHome } from "./paths.mjs";

function clone(value){return JSON.parse(JSON.stringify(value))}

export class AgentThreadStore{
  constructor(env=process.env){
    this.path=join(trebellHome(env),"agent-threads.json");
    mkdirSync(dirname(this.path),{recursive:true});
    this.data=this.#load();
  }
  #load(){
    try{
      const parsed=JSON.parse(readFileSync(this.path,"utf8"));
      return {version:1,threads:Array.isArray(parsed?.threads)?parsed.threads:[]};
    }catch{return {version:1,threads:[]}}
  }
  #save(){
    const tmp=this.path+".tmp";
    writeFileSync(tmp,JSON.stringify(this.data,null,2),{encoding:"utf8",mode:0o600});
    renameSync(tmp,this.path);
  }
  reconcileRestart({continueAfterRestart=false}={}){
    const now=Math.floor(Date.now()/1000);const recoverable=[];let changed=false;
    for(const thread of this.data.threads){
      const activeTurn=[...(thread.turns||[])].reverse().find(turn=>["inProgress","running","starting"].includes(turn?.status));
      const stale=thread.status?.type==="active"||Boolean(activeTurn);
      if(!stale)continue;
      changed=true;
      if(activeTurn&&continueAfterRestart&&thread.providerSessionId){
        activeTurn.status="interrupted";activeTurn.completedAt=now;activeTurn.durationMs=activeTurn.startedAt?Math.max(0,(now-activeTurn.startedAt)*1000):null;
        activeTurn.error={message:"Trebell restarted while this turn was running. Recovery is queued."};
        thread.status={type:"idle"};thread.recovery={pending:true,turnId:activeTurn.id,createdAt:now};recoverable.push({threadId:thread.id,turnId:activeTurn.id,runtime:thread.runtime});
      }else{
        if(activeTurn){activeTurn.status="failed";activeTurn.completedAt=now;activeTurn.durationMs=activeTurn.startedAt?Math.max(0,(now-activeTurn.startedAt)*1000):null;activeTurn.error={message:"Agent session was interrupted by a Trebell restart. Send a new message to continue."}}
        thread.status={type:"systemError"};delete thread.recovery;
      }
      thread.updatedAt=now;
    }
    if(changed)this.#save();return clone(recoverable);
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
    this.data.threads.unshift(thread);this.#save();return clone(thread);
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
    this.data.threads.unshift(thread);this.#save();return clone(thread);
  }
  update(id,patch={}){
    const thread=this.data.threads.find(item=>item.id===id);if(!thread)return null;
    Object.assign(thread,patch,{updatedAt:Math.floor(Date.now()/1000)});this.#save();return clone(thread);
  }
  delete(id){const before=this.data.threads.length;this.data.threads=this.data.threads.filter(thread=>thread.id!==id);if(this.data.threads.length!==before)this.#save();return before!==this.data.threads.length}
  addTurn(threadId,{id=randomUUID(),inputText="",items=[],status="inProgress",startedAt=Math.floor(Date.now()/1000)}={}){
    const thread=this.data.threads.find(item=>item.id===threadId);if(!thread)return null;
    const turn={id,status,startedAt,completedAt:null,durationMs:null,error:null,items:[
      ...(inputText?[{type:"userMessage",id:`user-${id}`,clientId:null,content:[{type:"text",text:inputText}]}]:[]),
      ...items,
    ]};
    thread.turns.push(turn);thread.status={type:"active",activeFlags:[]};thread.updatedAt=Math.floor(Date.now()/1000);this.#save();return clone(turn);
  }
  updateTurn(threadId,turnId,patch={}){
    const thread=this.data.threads.find(item=>item.id===threadId);const turn=thread?.turns?.find(item=>item.id===turnId);if(!turn)return null;
    Object.assign(turn,patch);thread.updatedAt=Math.floor(Date.now()/1000);this.#save();return clone(turn);
  }
  restartTurn(threadId,turnId){
    const thread=this.data.threads.find(item=>item.id===threadId);const turn=thread?.turns?.find(item=>item.id===turnId);if(!turn)return null;
    turn.status="inProgress";turn.completedAt=null;turn.durationMs=null;turn.error=null;thread.status={type:"active",activeFlags:[]};
    if(thread.recovery)thread.recovery={...thread.recovery,pending:false,startedAt:Math.floor(Date.now()/1000)};
    thread.updatedAt=Math.floor(Date.now()/1000);this.#save();return clone(turn);
  }
  addItem(threadId,turnId,item){
    const thread=this.data.threads.find(entry=>entry.id===threadId);const turn=thread?.turns?.find(entry=>entry.id===turnId);if(!turn)return null;
    const index=turn.items.findIndex(entry=>entry.id===item.id);
    if(index>=0)turn.items[index]={...turn.items[index],...item};else turn.items.push(item);
    thread.updatedAt=Math.floor(Date.now()/1000);this.#save();return clone(item);
  }
  finishTurn(threadId,turnId,{status="completed",error=null}={}){
    const thread=this.data.threads.find(item=>item.id===threadId);const turn=thread?.turns?.find(item=>item.id===turnId);if(!turn)return null;
    const completedAt=Math.floor(Date.now()/1000);turn.status=status;turn.error=error;turn.completedAt=completedAt;
    turn.durationMs=turn.startedAt?Math.max(0,(completedAt-turn.startedAt)*1000):null;
    thread.status=status==="failed"?{type:"systemError"}:{type:"idle"};delete thread.recovery;thread.updatedAt=completedAt;this.#save();return clone(turn);
  }
  rename(id,name){return this.update(id,{name:String(name||"").trim()||null})}
}
