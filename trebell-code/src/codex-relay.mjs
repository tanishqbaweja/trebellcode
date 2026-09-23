import { TREBELL_USER_AGENT } from "./version.mjs";
import { WebSocket, WebSocketServer } from "ws";

export async function probeCodexReady(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(900),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCodexReady(port, timeoutMs = 15000, fetchImpl = fetch) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeCodexReady(port, fetchImpl)) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

export function attachCodexRelay(httpServer, {
  targetUrl,
  resolveTarget = null,
  handleRequest = null,
  path = "/api/codex/ws",
  enabled = () => true,
  authorize = () => true,
  log = () => {},
  onClientMessage = () => {},
  onServerMessage = () => {},
} = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  function errorPayload(error, fallbackCode=-32000) {
    if(error?.error&&typeof error.error==="object") return error.error;
    return {code:Number(error?.code)||fallbackCode,message:error?.message||String(error||"Codex relay request failed")};
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== path) return;
    let authorized=false;
    try { authorized=Boolean(authorize(request,url)); } catch {}
    if (!authorized) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!enabled()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (browserSocket) => {
      const context={
        browserSocket,
        upstreams:new Map(),
        serverRequestRoutes:new Map(),
        initializeParams:null,
        initialized:false,
        primaryKey:null,
        nextServerRequestId:1,
        clientChain:Promise.resolve(),
        closed:false,
      };
      clients.add(context);

      const sendBrowser=(value,{binary=false}={})=>{
        if(browserSocket.readyState!==WebSocket.OPEN)return;
        browserSocket.send(typeof value==="string"||Buffer.isBuffer(value)?value:JSON.stringify(value),{binary});
      };
      const baseTarget=async(message=null)=>{
        const resolved=typeof targetUrl==="function"?await targetUrl(message,context):targetUrl;
        return {key:"default",url:resolved};
      };
      const routeFor=async(message=null)=>{
        const routed=resolveTarget?await resolveTarget(message,{request,url:new URL(request.url||"/","http://127.0.0.1"),primaryKey:context.primaryKey}):null;
        if(typeof routed==="string")return {key:routed,url:routed};
        if(routed?.url)return {key:String(routed.key||routed.url),url:String(routed.url)};
        return baseTarget(message);
      };
      const closeClient=(code=1000,reason="")=>{
        if(context.closed)return;context.closed=true;clients.delete(context);
        for(const record of context.upstreams.values()){
          for(const pending of record.internalPending.values()){clearTimeout(pending.timer);pending.reject(new Error("Codex relay disconnected"))}
          record.internalPending.clear();
          if(record.socket.readyState===WebSocket.OPEN||record.socket.readyState===WebSocket.CONNECTING)try{record.socket.close(code,reason.slice(0,120))}catch{}
        }
        context.upstreams.clear();context.serverRequestRoutes.clear();
        if(browserSocket.readyState===WebSocket.OPEN||browserSocket.readyState===WebSocket.CONNECTING)try{browserSocket.close(code,reason.slice(0,120))}catch{}
      };
      const initializeSecondary=async record=>{
        if(!context.initializeParams||record.initialized)return;
        const id=`trebell-relay-init-${record.key}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        const result=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{record.internalPending.delete(id);reject(new Error("Timed out initializing routed Codex app-server"))},12000);
          record.internalPending.set(id,{resolve,reject,timer});
        });
        record.socket.send(JSON.stringify({id,method:"initialize",params:context.initializeParams}));
        await result;
        if(context.initialized)record.socket.send(JSON.stringify({method:"initialized",params:{}}));
        record.initialized=true;
      };
      const ensureUpstream=async route=>{
        if(!route?.url)throw new Error("Codex app-server target URL is unavailable");
        let record=context.upstreams.get(route.key);
        if(record&&record.url!==route.url){
          try{record.socket.terminate()}catch{}context.upstreams.delete(route.key);record=null;
        }
        if(record){await record.ready;return record}
        const upstream=new WebSocket(route.url,{headers:{"User-Agent":TREBELL_USER_AGENT,"x-trebell-client":TREBELL_USER_AGENT}});
        record={key:route.key,url:route.url,socket:upstream,internalPending:new Map(),forwardedRequests:new Map(),initialized:false,ready:null};
        context.upstreams.set(route.key,record);
        record.ready=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error("Timed out connecting to routed Codex app-server")),12000);
          upstream.once("open",()=>{clearTimeout(timer);resolve()});
          upstream.once("error",error=>{clearTimeout(timer);reject(error)});
        });
        upstream.on("message",(data,isBinary)=>{
          if(isBinary){sendBrowser(data,{binary:true});return}
          let message;try{message=JSON.parse(String(data))}catch{sendBrowser(data);return}
          const pending=record.internalPending.get(message.id);
          if(pending&&!message.method){
            record.internalPending.delete(message.id);clearTimeout(pending.timer);
            if(message.error)pending.reject(Object.assign(new Error(message.error.message||"Codex initialization failed"),{error:message.error}));else pending.resolve(message.result);
            return;
          }
          const requestMethod=Object.prototype.hasOwnProperty.call(message,"id")&&!message.method?record.forwardedRequests.get(message.id)||null:null;
          if(requestMethod)record.forwardedRequests.delete(message.id);
          try{onServerMessage(message,{targetKey:record.key,targetUrl:record.url,requestMethod})}catch{}
          if(Object.prototype.hasOwnProperty.call(message,"id")&&message.method){
            const relayId=`trebell-server-${context.nextServerRequestId++}`;
            context.serverRequestRoutes.set(relayId,{record,originalId:message.id});
            sendBrowser({...message,id:relayId});return;
          }
          sendBrowser(message);
        });
        upstream.on("close",(code,reason)=>{
          context.upstreams.delete(record.key);
          for(const pending of record.internalPending.values()){clearTimeout(pending.timer);pending.reject(new Error("Codex app-server disconnected"))}
          record.internalPending.clear();
          if(record.key===context.primaryKey&&!context.closed)closeClient(code||1011,String(reason||"codex disconnected"));
        });
        upstream.on("error",error=>{log(`codex websocket error (${record.key}): ${error.message}`)});
        await record.ready;
        if(context.primaryKey!==null&&record.key!==context.primaryKey)await initializeSecondary(record);
        return record;
      };
      const forward=async(message,raw,isBinary=false)=>{
        if(isBinary){const record=await ensureUpstream(await baseTarget());record.socket.send(raw,{binary:true});return}
        try{onClientMessage(message,{primaryKey:context.primaryKey})}catch{}
        if(message&&Object.prototype.hasOwnProperty.call(message,"id")&&!message.method){
          const routed=context.serverRequestRoutes.get(message.id);
          if(routed){context.serverRequestRoutes.delete(message.id);const restored={...message,id:routed.originalId};routed.record.socket.send(JSON.stringify(restored));return}
        }
        if(message?.method&&Object.prototype.hasOwnProperty.call(message,"id")&&handleRequest){
          try{
            const handled=await handleRequest(message,{request,primaryKey:context.primaryKey,resolveTarget:routeFor});
            if(handled?.handled){
              if(handled.error)sendBrowser({id:message.id,error:handled.error});else sendBrowser({id:message.id,result:handled.result??null});
              return;
            }
          }catch(error){sendBrowser({id:message.id,error:errorPayload(error)});return}
        }
        const route=await routeFor(message);const record=await ensureUpstream(route);
        if(message?.method==="initialize"){
          context.initializeParams=message.params||{};if(context.primaryKey===null)context.primaryKey=record.key;
        }
        if(message?.method==="initialized"){
          context.initialized=true;record.initialized=true;
          for(const other of context.upstreams.values())if(other!==record&&!other.initialized)await initializeSecondary(other);
        }
        if(message?.method&&Object.prototype.hasOwnProperty.call(message,"id"))record.forwardedRequests.set(message.id,message.method);
        record.socket.send(raw,{binary:false});
      };

      browserSocket.on("message",(data,isBinary)=>{
        const raw=isBinary?data:String(data);let message=null;if(!isBinary)try{message=JSON.parse(raw)}catch{}
        context.clientChain=context.clientChain.then(()=>forward(message,raw,isBinary)).catch(error=>{
          log(`renderer websocket routing error: ${error.message}`);
          if(message&&Object.prototype.hasOwnProperty.call(message,"id")&&message.method)sendBrowser({id:message.id,error:errorPayload(error)});
        });
      });

      browserSocket.on("close",()=>closeClient());
      browserSocket.on("error", (error) => {
        log(`renderer websocket error: ${error.message}`);
        closeClient(1011,"renderer websocket error");
      });
    });
  });

  return {
    close() {
      for (const context of clients) {
        try { context.browserSocket.terminate(); } catch {}
        for(const record of context.upstreams.values())try{record.socket.terminate()}catch{}
      }
      clients.clear();
      try { wss.close(); } catch {}
    },
  };
}
