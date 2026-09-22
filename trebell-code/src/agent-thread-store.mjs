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
  list(runtime=null){
    return clone(this.data.threads.filter(thread=>!runtime||thread.runtime===runtime).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)));
  }
  get(id){return clone(this.data.threads.find(thread=>thread.id===id)||null)}
  create({runtime,cwd,providerSessionId,model=null,agent=null,name=null,preview=null,providerMeta=null}={}){
    const now=Math.floor(Date.now()/1000);
    const thread={
      id:randomUUID(),runtime:String(runtime||"external"),providerSessionId:String(providerSessionId||""),cwd:String(cwd||process.cwd()),
      model:model||null,agent:agent||null,name:name||null,preview:preview||null,providerMeta:providerMeta||null,createdAt:now,updatedAt:now,
      status:{type:"idle"},turns:[],archived:false,section:null,
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
    thread.status=status==="failed"?{type:"systemError"}:{type:"idle"};thread.updatedAt=completedAt;this.#save();return clone(turn);
  }
  rename(id,name){return this.update(id,{name:String(name||"").trim()||null})}
}
