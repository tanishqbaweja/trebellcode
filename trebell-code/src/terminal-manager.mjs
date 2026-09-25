import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { trebellHome } from "./paths.mjs";
import { redactSecretText } from "./secret-redactor.mjs";

const MAX_BYTES=8*1024*1024;
const MAX_LINES=5000;

function trimBuffer(text){
  let value=text;
  if(Buffer.byteLength(value,"utf8")>MAX_BYTES){
    let start=Math.max(0,value.length-MAX_BYTES);
    value=value.slice(start);
  }
  const lines=value.split("\n");
  if(lines.length>MAX_LINES) value=lines.slice(lines.length-MAX_LINES).join("\n");
  return value;
}

export class TerminalManager extends EventEmitter{
  constructor({env=process.env,persist=true}={}){
    super();
    this.env=env;this.persist=persist!==false;this.historyPath=join(trebellHome(env),"terminal-history.json");this.saveTimer=null;
    this.closed=false;
    this.sessions=new Map(); this.pending=new Map(); this.nextRid=1; this.clients=new Map(); this.exitWaiters=new Map();
    this.#loadHistory();
    this.#startWorker();
  }
  #loadHistory(){
    if(!this.persist)return;
    try{
      const parsed=JSON.parse(readFileSync(this.historyPath,"utf8"));
      for(const raw of Array.isArray(parsed?.sessions)?parsed.sessions:[]){
        if(!raw?.id)continue;
        const session={
          id:String(raw.id),name:String(raw.name||"Terminal"),cwd:String(raw.cwd||process.cwd()),cols:Number(raw.cols)||120,rows:Number(raw.rows)||32,pid:null,
          environmentId:raw.environmentId?String(raw.environmentId):null,environmentName:String(raw.environmentName||"Local machine"),environmentType:String(raw.environmentType||"local"),
          buffer:trimBuffer(String(raw.buffer||"")),running:false,exitCode:raw.exitCode==null?null:Number(raw.exitCode),createdAt:Number(raw.createdAt)||Date.now(),updatedAt:Number(raw.updatedAt)||Date.now(),restored:true,
        };
        this.sessions.set(session.id,session);
      }
    }catch{}
  }
  #saveHistory(){
    if(!this.persist)return;
    clearTimeout(this.saveTimer);this.saveTimer=null;
    const sessions=[...this.sessions.values()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).map(session=>({
      id:session.id,name:session.name,cwd:session.cwd,environmentId:session.environmentId||null,environmentName:session.environmentName||"Local machine",environmentType:session.environmentType||"local",cols:session.cols,rows:session.rows,buffer:trimBuffer(redactSecretText(session.buffer||"",{environment:this.env})),running:false,exitCode:session.exitCode,createdAt:session.createdAt,updatedAt:session.updatedAt,
    }));
    try{mkdirSync(dirname(this.historyPath),{recursive:true});const tmp=this.historyPath+".tmp";writeFileSync(tmp,JSON.stringify({version:1,sessions},null,2),{encoding:"utf8",mode:0o600});renameSync(tmp,this.historyPath)}catch{}
  }
  #scheduleSave(){if(!this.persist)return;clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.#saveHistory(),500);this.saveTimer.unref?.()}
  #startWorker(){
    const workerPath=fileURLToPath(new URL("./terminal-worker.mjs",import.meta.url));
    const childEnv={...this.env};
    if(this.env.TREBELL_ELECTRON_AS_NODE==="1"||process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE="1";
    this.child=spawn(process.execPath,[workerPath],{env:childEnv,stdio:["pipe","pipe","pipe"],windowsHide:true});
    readline.createInterface({input:this.child.stdout,crlfDelay:Infinity}).on("line",line=>{
      let msg; try{msg=JSON.parse(line)}catch{return}
      if(msg.type==="response"){
        const pending=this.pending.get(msg.rid); if(!pending) return; this.pending.delete(msg.rid);
        msg.ok?pending.resolve(msg.result):pending.reject(new Error(msg.error||"Terminal worker failed"));
      }else if(msg.type==="output"){
        const session=this.sessions.get(msg.id); if(!session) return;
        session.buffer=trimBuffer(session.buffer+msg.data); session.updatedAt=Date.now();
        this.#scheduleSave();
        this.emit("output",msg.id,msg.data);
        for(const ws of this.clients.get(msg.id)||[]) if(ws.readyState===ws.OPEN) ws.send(JSON.stringify({type:"output",data:msg.data}));
      }else if(msg.type==="exit"){
        const session=this.sessions.get(msg.id); if(session){session.running=false;session.exitCode=msg.exitCode;session.updatedAt=Date.now();}
        this.#saveHistory();
        const waiters=this.exitWaiters.get(msg.id)||[];
        this.exitWaiters.delete(msg.id);
        for(const resolve of waiters)resolve({exitCode:msg.exitCode,signal:msg.signal});
        for(const ws of this.clients.get(msg.id)||[]) if(ws.readyState===ws.OPEN) ws.send(JSON.stringify({type:"exit",exitCode:msg.exitCode,signal:msg.signal}));
      }
    });
    this.child.stderr?.on("data",chunk=>this.emit("workerError",String(chunk)));
    this.child.on("exit",()=>{for(const p of this.pending.values())p.reject(new Error("Terminal worker exited"));this.pending.clear();});
  }
  #rpc(action,payload={}){
    const rid=this.nextRid++;
    this.child.stdin.write(JSON.stringify({rid,action,...payload})+"\n");
    return new Promise((resolve,reject)=>{this.pending.set(rid,{resolve,reject});setTimeout(()=>{if(this.pending.delete(rid))reject(new Error("Terminal worker timed out"));},15000);});
  }
  async create({cwd,displayCwd=null,cols=120,rows=32,shell=null,args=null,name=null,env=null,environmentId=null,environmentName="Local machine",environmentType="local"}={}){
    const id=randomUUID();
    const result=await this.#rpc("create",{id,cwd,cols,rows,shell,args,env});
    const session={id,name:name||"Terminal",cwd:displayCwd||cwd||process.cwd(),environmentId:environmentId||null,environmentName:environmentName||"Local machine",environmentType:environmentType||"local",cols,rows,pid:result.pid,buffer:"",running:true,exitCode:null,createdAt:Date.now(),updatedAt:Date.now()};
    this.sessions.set(id,session);this.#saveHistory(); return this.snapshot(id);
  }
  list(environmentId=undefined){
    const wanted=environmentId===undefined?undefined:(environmentId||null);
    return [...this.sessions.values()].filter(session=>wanted===undefined||(session.environmentId||null)===wanted).map(s=>this.#public(s));
  }
  snapshot(id){const s=this.sessions.get(id);return s?this.#public(s):null;}
  #public(s){return {id:s.id,name:s.name,cwd:s.cwd,environmentId:s.environmentId||null,environmentName:s.environmentName||"Local machine",environmentType:s.environmentType||"local",cols:s.cols,rows:s.rows,pid:s.pid,running:s.running,exitCode:s.exitCode,createdAt:s.createdAt,updatedAt:s.updatedAt,buffer:s.buffer,restored:Boolean(s.restored)};}
  async write(id,data){const session=this.sessions.get(id);if(!session?.running)throw new Error("Terminal session is stopped; create a new terminal to run commands");await this.#rpc("write",{id,data});}
  async resize(id,cols,rows){const s=this.sessions.get(id);if(s?.running)await this.#rpc("resize",{id,cols,rows});if(s){s.cols=cols;s.rows=rows;this.#scheduleSave();}}
  async waitForExit(id,{timeoutMs=30*60_000}={}){
    const session=this.sessions.get(id);
    if(!session)return {exitCode:null,signal:null,missing:true};
    if(!session.running)return {exitCode:session.exitCode,signal:null};
    return new Promise(resolve=>{
      const list=this.exitWaiters.get(id)||[];
      const done=result=>{clearTimeout(timer);resolve(result)};
      list.push(done);this.exitWaiters.set(id,list);
      const timer=setTimeout(()=>{
        const current=this.exitWaiters.get(id)||[];
        this.exitWaiters.set(id,current.filter(item=>item!==done));
        resolve({exitCode:null,signal:null,timeout:true});
      },Math.max(1000,Number(timeoutMs)||30*60_000));
    });
  }
  async close(id){const session=this.sessions.get(id);if(session?.running)await this.#rpc("kill",{id}).catch(()=>{});this.sessions.delete(id);this.#saveHistory();}
  pruneStopped({before=0}={}){
    const cutoff=Math.max(0,Number(before)||0);let removed=0;
    for(const [id,session] of this.sessions.entries()){
      if(session.running)continue;
      if(cutoff&&Number(session.updatedAt||session.createdAt||0)>=cutoff)continue;
      this.sessions.delete(id);this.clients.delete(id);this.exitWaiters.delete(id);removed++;
    }
    if(removed)this.#saveHistory();
    return {removed,remaining:this.sessions.size};
  }
  attachWebSocket(server,path="/api/terminal/ws"){
    const wss=new WebSocketServer({noServer:true});
    const upgrade=(req,socket,head)=>{
      const url=new URL(req.url||"/","http://127.0.0.1"); if(url.pathname!==path)return;
      const id=url.searchParams.get("session"); const session=this.sessions.get(id);
      if(!session){socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");socket.destroy();return;}
      wss.handleUpgrade(req,socket,head,ws=>{
        if(!this.clients.has(id))this.clients.set(id,new Set());this.clients.get(id).add(ws);
        ws.send(JSON.stringify({type:"snapshot",session:this.#public(session)}));
        ws.on("message",raw=>{let msg;try{msg=JSON.parse(String(raw))}catch{return}
          if(msg.type==="input")this.write(id,msg.data||"").catch(()=>{});
          else if(msg.type==="resize")this.resize(id,msg.cols,msg.rows).catch(()=>{});
          else if(msg.type==="close")this.close(id).catch(()=>{});
        });
        ws.on("close",()=>this.clients.get(id)?.delete(ws));
      });
    };
    server.on("upgrade",upgrade);
    return {close:()=>{server.off("upgrade",upgrade);try{wss.close()}catch{}}};
  }
  async shutdown(){
    if(this.closed)return;this.closed=true;
    clearTimeout(this.saveTimer);this.saveTimer=null;
    for(const session of this.sessions.values()){
      if(session.running){
        await this.#rpc("kill",{id:session.id}).catch(()=>{});
        session.running=false;session.pid=null;session.restored=true;session.updatedAt=Date.now();
      }else{
        session.pid=null;session.restored=true;
      }
    }
    this.#saveHistory();
    await this.#rpc("shutdown").catch(()=>{});
    try{this.child.kill()}catch{}
  }
}
