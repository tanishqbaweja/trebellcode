import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { readNdjsonLines } from "./ndjson-lines.mjs";
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

// Ends the shell of a terminal whose worker did not end it, on Windows (taskkill, hidden, at normal priority, waited for up to 3 s):
// the worker ends its terminals itself (terminal-worker.mjs), but one that ends first (it crashed, something ended it, or it did not
// answer the shutdown on a loaded host) can leave a shell to run on with its console host and the programs it started. The shell of
// a terminal that runs one command as its own program (endsTree: a project action, a worktree setup) goes with its process tree
// (/t); a person's tab or sign-in loses only its shell, whose console host then goes too, so a window program started from it
// (Notepad, a browser) runs on. Elsewhere the worker's end, which closes the terminals' ptys, ends them.
function endShell(session){
  const pid=Number(session?.pid);
  if(process.platform!=="win32"||!(pid>0))return Promise.resolve();
  return new Promise(resolve=>{
    const timer=setTimeout(resolve,3000),done=()=>{clearTimeout(timer);resolve()};
    try{
      const killer=spawn("taskkill",["/pid",String(pid),...(session.endsTree?["/t"]:[]),"/f"],{windowsHide:true,stdio:"ignore"});killer.once("error",done);killer.once("exit",done);
      try{setPriority(killer.pid,constants.priority.PRIORITY_NORMAL)}catch{}
    }catch{done()}
  });
}

export class TerminalManager extends EventEmitter{
  constructor({env=process.env,persist=true}={}){
    super();
    this.env=env;this.persist=persist!==false;this.historyPath=join(trebellHome(env),"terminal-history.json");this.saveTimer=null;
    this.closed=false;this.child=null;
    this.sessions=new Map(); this.pending=new Map(); this.nextRid=1; this.clients=new Map(); this.exitWaiters=new Map();
    // The worker (a Node process with node-pty and a console host, about 60 MB) starts with the first terminal: the history and
    // the session listings need none.
    this.#loadHistory();
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
    // Detached on Windows, where a process Node starts otherwise ends at once with the one that started it (it is put in a job that
    // closes with it): a server that crashed or was ended (the desktop app's main process holds it) took the worker with it before
    // the worker could end anything, and its terminals' shells, programs and console hosts ran on. A detached worker outlives it,
    // sees its input close and ends its terminals (terminal-worker.mjs). Without a console of its own it starts nothing that opens a
    // console window: its shells run in pseudo-consoles, what it runs itself is hidden, and it closes a console without node-pty's
    // kill, whose console-list agent would get one.
    this.child=spawn(process.execPath,[workerPath],{env:childEnv,stdio:["pipe","pipe","pipe"],windowsHide:true,detached:process.platform==="win32"});
    // Its messages are JSON lines split on "\n" alone: readline also split one at a U+2028 or U+2029 in a terminal's output.
    readNdjsonLines(this.child.stdout,line=>{
      let msg; try{msg=JSON.parse(line)}catch{return}
      if(msg.type==="response"){
        const pending=this.pending.get(msg.rid); if(!pending) return; this.pending.delete(msg.rid);
        msg.ok?pending.resolve(msg.result):pending.reject(new Error(msg.error||"Terminal worker failed"));
      }else if(msg.type==="output"){
        const session=this.sessions.get(msg.id); if(!session) return;
        // Output is appended as it comes and the buffer cut back to its limits only once it is a tenth over them: cutting on
        // every message re-split the whole buffer each time, which held the event loop for up to a second on a long run of output.
        session.bufferLines??=session.buffer.split("\n").length; session.bufferBytes??=Buffer.byteLength(session.buffer,"utf8");
        session.buffer+=msg.data; session.bufferBytes+=Buffer.byteLength(msg.data,"utf8"); session.updatedAt=Date.now();
        for(let at=msg.data.indexOf("\n");at>=0;at=msg.data.indexOf("\n",at+1))session.bufferLines++;
        if(session.bufferLines>MAX_LINES*1.1||session.bufferBytes>MAX_BYTES*1.1){session.buffer=trimBuffer(session.buffer);session.bufferLines=session.buffer.split("\n").length;session.bufferBytes=Buffer.byteLength(session.buffer,"utf8")}
        this.#scheduleSave();
        this.emit("output",msg.id,msg.data);
        for(const ws of this.clients.get(msg.id)||[]) if(ws.readyState===ws.OPEN&&!ws.watchOnly) ws.send(JSON.stringify({type:"output",data:msg.data}));
      }else if(msg.type==="exit")this.#exited(msg.id,msg.exitCode,msg.signal);
    });
    this.child.stderr?.on("data",chunk=>this.emit("workerError",String(chunk)));
    const child=this.child;
    // A write to a worker that has just died can fail on its closed pipe: the call fails with the worker's exit below, and the pipe's
    // error, which nothing else handles, would end the server.
    child.stdin.on("error",()=>{});
    // A worker that dies (it crashed, or something ended it) takes its shells with it: its calls fail, its terminals end as on their
    // program's own exit, and the next call starts a new worker. It used to stay the worker, so its terminals took input that went
    // nowhere and every later call waited for it until it timed out.
    child.on("exit",()=>{
      if(this.child===child)this.child=null;
      for(const p of this.pending.values())p.reject(new Error("Terminal worker exited"));this.pending.clear();
      // Its terminals all end at once, so their history is written once: each write redacts and rewrites every terminal's scrollback
      // (8 MB each at most) on the server's event loop, in the desktop app its main process, which a write for each terminal held
      // that many times over. Their shells are ended here, as the worker could not end them.
      let ended=0;
      for(const session of this.sessions.values())if(session.running){void endShell(session);this.#exited(session.id,null,null,{save:false});ended++}
      if(ended)this.#saveHistory();
    });
  }
  // A session's program ended: the session stays as stopped history, and its waiters and open sockets hear the exit.
  #exited(id,exitCode,signal,{save=true}={}){
    const session=this.sessions.get(id); if(session){session.running=false;session.exitCode=exitCode;session.updatedAt=Date.now();}
    if(save)this.#saveHistory();
    const waiters=this.exitWaiters.get(id)||[];
    this.exitWaiters.delete(id);
    for(const resolve of waiters)resolve({exitCode,signal});
    for(const ws of this.clients.get(id)||[]) if(ws.readyState===ws.OPEN) ws.send(JSON.stringify({type:"exit",exitCode,signal}));
  }
  #rpc(action,payload={},timeoutMs=15000){
    if(!this.child){if(this.closed)return Promise.reject(new Error("Terminal worker is shut down"));this.#startWorker()}
    const rid=this.nextRid++;
    this.child.stdin.write(JSON.stringify({rid,action,...payload})+"\n");
    return new Promise((resolve,reject)=>{this.pending.set(rid,{resolve,reject});setTimeout(()=>{if(this.pending.delete(rid))reject(new Error("Terminal worker timed out"));},timeoutMs);});
  }
  // endsTree: the terminal runs one command as its own program (a project action, a worktree setup), so ending it ends all that the
  // command started (on Windows, its shell's process tree, also a program started off its console). A terminal a person types into
  // (a tab, a sign-in) ends as a terminal's close does: the programs on its console end, and a window program started from it runs on.
  async create({cwd,displayCwd=null,cols=120,rows=32,shell=null,args=null,name=null,env=null,replaceEnv=false,endsTree=false,environmentId=null,environmentName="Local machine",environmentType="local"}={}){
    const id=randomUUID();
    const result=await this.#rpc("create",{id,cwd,cols,rows,shell,args,env,replaceEnv:Boolean(replaceEnv),endsTree:Boolean(endsTree)});
    const session={id,name:name||"Terminal",cwd:displayCwd||cwd||process.cwd(),environmentId:environmentId||null,environmentName:environmentName||"Local machine",environmentType:environmentType||"local",cols,rows,pid:result.pid,endsTree:Boolean(endsTree),buffer:"",running:true,exitCode:null,createdAt:Date.now(),updatedAt:Date.now()};
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
  // Ends a session's program and forgets the session at once: the worker's kill, which on Windows ends a project action's process
  // tree after its programs' grace period, goes on without the closed tab waiting for it.
  async close(id){const session=this.sessions.get(id);if(session?.running)this.#rpc("kill",{id}).catch(()=>{});this.sessions.delete(id);this.#saveHistory();}
  // Ends a session's program and keeps the session, with its output and exit, as stopped history, as the program's own exit does
  // (close also forgets it). It answers once the exit has come, or after 5 s with the session as it is then, also while the worker's
  // kill, which on Windows ends what is left of a project action's process tree after its programs' grace period, takes longer.
  async stop(id){
    const session=this.sessions.get(id);if(!session)return null;
    if(session.running){const exited=this.waitForExit(id,{timeoutMs:5000});this.#rpc("kill",{id}).catch(()=>{});await exited}
    return this.snapshot(id);
  }
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
      const id=url.searchParams.get("session"); const session=this.sessions.get(id),watchOnly=url.searchParams.get("watch")==="1";
      if(!session){socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");socket.destroy();return;}
      wss.handleUpgrade(req,socket,head,ws=>{
        if(!this.clients.has(id))this.clients.set(id,new Set());this.clients.get(id).add(ws);
        ws.watchOnly=watchOnly;
        ws.send(JSON.stringify(watchOnly?{type:"state",running:session.running,exitCode:session.exitCode}:{type:"snapshot",session:this.#public(session)}));
        ws.on("message",raw=>{if(watchOnly)return;let msg;try{msg=JSON.parse(String(raw))}catch{return}
          if(msg.type==="input")this.write(id,msg.data||"").catch(()=>{});
          else if(msg.type==="resize")this.resize(id,msg.cols,msg.rows).catch(()=>{});
          else if(msg.type==="close")this.close(id).catch(()=>{});
        });
        ws.on("close",()=>this.clients.get(id)?.delete(ws));
      });
    };
    server.on("upgrade",upgrade);
    // ws leaves the sockets it accepted open when it closes, and the HTTP server's close waits for each of them (a tray Quit or an
    // install waited on the terminal drawer's for good): they are ended here, as the Codex and agent relays end theirs.
    return {close:()=>{server.off("upgrade",upgrade);for(const ws of wss.clients)try{ws.terminate()}catch{}try{wss.close()}catch{}}};
  }
  // The worker's shutdown ends every terminal, as its kill does, and exits. It answers within 10 s: on Windows a project action's
  // end lists its process tree (up to 3 s), gives its programs their grace period (up to 2 s) and lists it again (up to 3 s). One
  // that does not answer by then (a loaded host) may have ended none of them, so on Windows the shells of the terminals whose exit it
  // has not told are ended from here before it is. The terminals are stopped history before the worker goes, so its exit does not
  // end them again.
  async shutdown(){
    if(this.closed)return;this.closed=true;
    clearTimeout(this.saveTimer);this.saveTimer=null;
    const child=this.child;
    if(child){
      const answered=await this.#rpc("shutdown",{},10000).then(()=>true,()=>false);
      const running=[...this.sessions.values()].filter(session=>session.running);
      for(const session of running){session.running=false;session.updatedAt=Date.now()}
      if(!answered)await Promise.all(running.map(session=>endShell(session)));
      try{child.kill()}catch{}
    }
    for(const session of this.sessions.values()){session.pid=null;session.restored=true}
    this.#saveHistory();
  }
}
