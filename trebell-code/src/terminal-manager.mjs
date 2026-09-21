import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

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
  constructor({env=process.env}={}){
    super();
    this.env=env; this.sessions=new Map(); this.pending=new Map(); this.nextRid=1; this.clients=new Map(); this.exitWaiters=new Map();
    this.#startWorker();
  }
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
        this.emit("output",msg.id,msg.data);
        for(const ws of this.clients.get(msg.id)||[]) if(ws.readyState===ws.OPEN) ws.send(JSON.stringify({type:"output",data:msg.data}));
      }else if(msg.type==="exit"){
        const session=this.sessions.get(msg.id); if(session){session.running=false;session.exitCode=msg.exitCode;session.updatedAt=Date.now();}
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
  async create({cwd,cols=120,rows=32,shell=null,args=null,name=null}={}){
    const id=randomUUID();
    const result=await this.#rpc("create",{id,cwd,cols,rows,shell,args});
    const session={id,name:name||"Terminal",cwd:cwd||process.cwd(),cols,rows,pid:result.pid,buffer:"",running:true,exitCode:null,createdAt:Date.now(),updatedAt:Date.now()};
    this.sessions.set(id,session); return this.snapshot(id);
  }
  list(){return [...this.sessions.values()].map(s=>this.#public(s));}
  snapshot(id){const s=this.sessions.get(id);return s?this.#public(s):null;}
  #public(s){return {id:s.id,name:s.name,cwd:s.cwd,cols:s.cols,rows:s.rows,pid:s.pid,running:s.running,exitCode:s.exitCode,createdAt:s.createdAt,updatedAt:s.updatedAt,buffer:s.buffer};}
  async write(id,data){await this.#rpc("write",{id,data});}
  async resize(id,cols,rows){await this.#rpc("resize",{id,cols,rows});const s=this.sessions.get(id);if(s){s.cols=cols;s.rows=rows;}}
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
  async close(id){await this.#rpc("kill",{id}).catch(()=>{});this.sessions.delete(id);}
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
    for(const id of [...this.sessions.keys()]) await this.close(id).catch(()=>{});
    await this.#rpc("shutdown").catch(()=>{});
    try{this.child.kill()}catch{}
  }
}
