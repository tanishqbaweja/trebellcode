import { WebSocket } from "ws";
import { TREBELL_USER_AGENT } from "./version.mjs";

export class CodexAppServerClient{
  constructor(url,{clientVersion="0.0.0",timeoutMs=60_000}={}){
    this.url=url;this.clientVersion=clientVersion;this.timeoutMs=timeoutMs;
    this.ws=null;this.nextId=1;this.pending=new Map();
  }
  async connect(){
    if(!this.url)throw new Error("Codex app-server URL is required");
    const ws=new WebSocket(this.url,{headers:{"User-Agent":TREBELL_USER_AGENT,"x-trebell-client":TREBELL_USER_AGENT}});
    this.ws=ws;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Timed out connecting to Codex app-server")),12_000);
      ws.once("open",()=>{clearTimeout(timer);resolve()});
      ws.once("error",error=>{clearTimeout(timer);reject(error)});
    });
    ws.on("message",data=>this.#message(String(data)));
    ws.on("close",()=>this.#failPending(new Error("Codex app-server disconnected")));
    await this.request("initialize",{clientInfo:{name:"trebell-history-import",title:"Trebell Code",version:this.clientVersion},capabilities:{experimentalApi:true}});
    this.notify("initialized",{});
    return this;
  }
  request(method,params={}){
    if(!this.ws||this.ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error("Codex app-server is not connected"));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+" timed out"))},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.ws.send(JSON.stringify({id,method,params}))}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error)}
    });
  }
  notify(method,params={}){
    if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({method,params}));
  }
  async forkFromRollout({threadId,path,cwd=null,modelProvider=null,model=null}={}){
    if(!threadId||!path)throw new Error("Codex history import requires a source thread and rollout path");
    return this.request("thread/fork",{
      threadId:String(threadId),
      path:String(path),
      ...(cwd?{cwd:String(cwd)}:{}),
      ...(modelProvider?{modelProvider:String(modelProvider)}:{}),
      ...(model?{model:String(model)}:{}),
      threadSource:"trebell-code",
      ephemeral:false,
      excludeTurns:true,
    });
  }
  close(){
    this.#failPending(new Error("Codex app-server client closed"));
    try{this.ws?.close()}catch{}
    this.ws=null;
  }
  #message(raw){
    let message;try{message=JSON.parse(raw)}catch{return}
    if(Object.prototype.hasOwnProperty.call(message,"id")&&!message.method){
      const pending=this.pending.get(message.id);if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.error)pending.reject(new Error(message.error.message||"Codex RPC request failed"));else pending.resolve(message.result);
      return;
    }
    if(Object.prototype.hasOwnProperty.call(message,"id")&&message.method&&this.ws?.readyState===WebSocket.OPEN){
      this.ws.send(JSON.stringify({id:message.id,error:{code:-32601,message:"Trebell history import does not service app-server callbacks"}}));
    }
  }
  #failPending(error){
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error)}
    this.pending.clear();
  }
}
