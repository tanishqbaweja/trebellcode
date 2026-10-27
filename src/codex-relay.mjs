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
  handleServerRequest = null,
  transformClientMessage = null,
  // Synchronous (message, {targetKey, targetUrl, requestUpstream, connected}) => message: rewrites a Codex notification before the
  // renderer gets it, so notifications keep their order. false keeps it from the renderer (a goal Trebell is still writing).
  // connected() says whether the renderer is still there: a request made for it later, once it has gone, opens a connection no one
  // closes.
  transformServerMessage = null,
  // Synchronous (message, {targetKey}) => message: rewrites a Codex request the renderer is to answer before it gets it.
  transformServerRequest = null,
  // (message, {method, params, targetKey}) => void: the renderer's answer to a Codex request, as it goes back to Codex. params are
  // the request's, the object handleServerRequest got.
  onServerRequestAnswered = () => {},
  // Synchronous (message, {requestMethod, requestParams, targetKey}) => message: rewrites the answer to a request the renderer sent
  // before the renderer gets it.
  transformServerResponse = null,
  // ({key, url}) => whether requests for that target still go to that URL: a routed connection that closes while they do lost a
  // process that died, not one that was released.
  targetLive = () => false,
  // (url, {key, url}) => the token the app-server at that address takes (codex --ws-auth), sent as Authorization: Bearer <token> when
  // the relay connects to it, or null for one that takes none. The route names the pool entry the connection is for (its key).
  upstreamToken = () => null,
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
        // The browser's requests not answered yet, by id ({method, params}): from the moment the relay reads one until its answer goes
        // back, or the connection that carried it closes (requestsInProgress).
        inProgress:new Map(),
        closed:false,
      };
      clients.add(context);

      const sendBrowser=(value,{binary=false}={})=>{
        if(value&&typeof value==="object"&&!Buffer.isBuffer(value)&&Object.prototype.hasOwnProperty.call(value,"id")&&!value.method)context.inProgress.delete(value.id);
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
        const token=upstreamToken(route.url,route);
        const upstream=new WebSocket(route.url,{headers:{"User-Agent":TREBELL_USER_AGENT,"x-trebell-client":TREBELL_USER_AGENT,...(token?{Authorization:`Bearer ${token}`}:{})}});
        record={key:route.key,url:route.url,socket:upstream,internalPending:new Map(),forwardedRequests:new Map(),autoHandledRequests:new Set(),initialized:false,ready:null};
        context.upstreams.set(route.key,record);
        record.ready=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error("Timed out connecting to routed Codex app-server")),12000);
          upstream.once("open",()=>{clearTimeout(timer);record.opened=true;resolve()});
          upstream.once("error",error=>{clearTimeout(timer);reject(error)});
        });
        upstream.on("message",async(data,isBinary)=>{
          if(isBinary){sendBrowser(data,{binary:true});return}
          let message;try{message=JSON.parse(String(data))}catch{sendBrowser(data);return}
          const pending=record.internalPending.get(message.id);
          if(pending&&!message.method){
            record.internalPending.delete(message.id);clearTimeout(pending.timer);
            if(message.error)pending.reject(Object.assign(new Error(message.error.message||"Codex initialization failed"),{error:message.error}));else pending.resolve(message.result);
            return;
          }
          const requestMeta=Object.prototype.hasOwnProperty.call(message,"id")&&!message.method?record.forwardedRequests.get(message.id)||null:null;
          if(requestMeta)record.forwardedRequests.delete(message.id);
          try{onServerMessage(message,{targetKey:record.key,targetUrl:record.url,requestMethod:requestMeta?.method||null,requestParams:requestMeta?.params||null})}catch{}
          if(Object.prototype.hasOwnProperty.call(message,"id")&&message.method){
            if(handleServerRequest){
              try{
                const handled=await handleServerRequest(message,{request,targetKey:record.key,targetUrl:record.url});
                if(handled?.handled){
                  record.autoHandledRequests.add(message.id);
                  while(record.autoHandledRequests.size>500)record.autoHandledRequests.delete(record.autoHandledRequests.values().next().value);
                  const reply={id:message.id};
                  if(handled.error)reply.error=handled.error;else reply.result=handled.result??null;
                  record.socket.send(JSON.stringify(reply));
                  return;
                }
              }catch(error){log("Codex server-request hook failed; using renderer confirmation: "+error.message)}
            }
            const relayId=`trebell-server-${context.nextServerRequestId++}`;
            context.serverRequestRoutes.set(relayId,{record,originalId:message.id,method:message.method,params:message.params});
            let asked=message;
            if(transformServerRequest)try{asked=transformServerRequest(message,{targetKey:record.key})||message}catch(error){log("Codex request hook failed: "+error.message)}
            sendBrowser({...asked,id:relayId});return;
          }
          if(message?.method==="serverRequest/resolved"&&message.params&&Object.prototype.hasOwnProperty.call(message.params,"requestId")){
            if(record.autoHandledRequests.has(message.params.requestId)){record.autoHandledRequests.delete(message.params.requestId);return}
            const route=[...context.serverRequestRoutes.entries()].find(([,value])=>value.record===record&&value.originalId===message.params.requestId);
            if(route){
              const [relayId]=route;context.serverRequestRoutes.delete(relayId);
              sendBrowser({...message,params:{...message.params,requestId:relayId}});return;
            }
          }
          if(transformServerMessage&&message?.method&&!Object.prototype.hasOwnProperty.call(message,"id")){
            try{const next=transformServerMessage(message,{targetKey:record.key,targetUrl:record.url,requestUpstream,connected:()=>!context.closed});if(next===false)return;message=next||message}
            catch(error){log("Codex notification hook failed: "+error.message)}
          }
          if(transformServerResponse&&requestMeta){
            try{message=transformServerResponse(message,{requestMethod:requestMeta.method,requestParams:requestMeta.params,targetKey:record.key})||message}
            catch(error){log("Codex answer hook failed: "+error.message)}
          }
          sendBrowser(message);
        });
        upstream.on("close",(code,reason)=>{
          context.upstreams.delete(record.key);
          for(const id of record.forwardedRequests.keys())context.inProgress.delete(id);
          for(const pending of record.internalPending.values()){clearTimeout(pending.timer);pending.reject(new Error("Codex app-server disconnected"))}
          record.internalPending.clear();
          // A connection that died has no close frame (1005, 1006 or 1015), and no close frame may carry those codes: ws throws for them,
          // which left the browser's socket open with nothing behind it. The browser is told 1011 instead.
          const sendable=(code>=1000&&code<=1014&&![1004,1005,1006].includes(code))||(code>=3000&&code<=4999);
          // A thread's own app-server that died (its target is still where the thread's requests go, so nothing released it) is told
          // the same way: the browser connects again and resumes the thread shown, which starts that app-server again and loads the
          // thread on it, as T3 resumes a thread on the next app-server after one exits. A connection that never opened fails only
          // the request it was made for.
          if((record.key===context.primaryKey||record.opened&&targetLive(record))&&!context.closed)closeClient(sendable?code:1011,String(reason||"codex disconnected"));
        });
        upstream.on("error",error=>{log(`codex websocket error (${record.key}): ${error.message}`)});
        await record.ready;
        if(context.primaryKey!==null&&record.key!==context.primaryKey)await initializeSecondary(record);
        return record;
      };
      const requestUpstream=async(method,params={},options={})=>{
        const routeMessage=options.routeMessage||{method,params};
        const route=await routeFor(routeMessage),record=await ensureUpstream(route);
        const id=`trebell-internal-${record.key}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        const result=new Promise((resolve,reject)=>{
          const timeoutMs=Math.max(1000,Math.min(10*60_000,Number(options.timeoutMs)||60_000));
          const timer=setTimeout(()=>{record.internalPending.delete(id);reject(new Error(`${method} timed out`))},timeoutMs);
          record.internalPending.set(id,{resolve,reject,timer});
        });
        let outbound={id,method};if(params&&typeof params==="object"&&Object.keys(params).length)outbound.params=params;
        if(transformClientMessage){
          const transformed=await transformClientMessage(outbound,{request,primaryKey:context.primaryKey,resolveTarget:routeFor,internal:true});
          if(transformed)outbound=transformed;
        }
        record.socket.send(JSON.stringify(outbound));
        return result;
      };
      const forward=async(message,raw,isBinary=false)=>{
        if(isBinary){const record=await ensureUpstream(await baseTarget());record.socket.send(raw,{binary:true});return}
        if(message&&Object.prototype.hasOwnProperty.call(message,"id")&&!message.method){
          const routed=context.serverRequestRoutes.get(message.id);
          if(routed){
            context.serverRequestRoutes.delete(message.id);const restored={...message,id:routed.originalId};
            try{onServerRequestAnswered(restored,{method:routed.method,params:routed.params,targetKey:routed.record.key})}catch(error){log("Codex request answer hook failed: "+error.message)}
            routed.record.socket.send(JSON.stringify(restored));return;
          }
        }
        if(message?.method&&transformClientMessage){
          const transformed=await transformClientMessage(message,{request,primaryKey:context.primaryKey,resolveTarget:routeFor});
          if(transformed&&transformed!==message){message=transformed;raw=JSON.stringify(transformed)}
        }
        try{onClientMessage(message,{primaryKey:context.primaryKey})}catch{}
        if(message?.method&&Object.prototype.hasOwnProperty.call(message,"id")&&handleRequest){
          try{
            const handled=await handleRequest(message,{request,primaryKey:context.primaryKey,resolveTarget:routeFor,requestUpstream});
            if(handled?.handled){
              if(handled.error)sendBrowser({id:message.id,error:handled.error});else sendBrowser({id:message.id,result:handled.result??null});
              return;
            }
          }catch(error){sendBrowser({id:message.id,error:errorPayload(error)});return}
        }
        const route=await routeFor(message);const record=await ensureUpstream(route);
        let forwardedMessage=message,forwardedRaw=raw;
        if(message?.params&&typeof message.params==="object"&&!Array.isArray(message.params)&&Object.prototype.hasOwnProperty.call(message.params,"_trebellThreadId")){
          const params={...message.params};delete params._trebellThreadId;
          forwardedMessage={...message};
          if(Object.keys(params).length)forwardedMessage.params=params;else delete forwardedMessage.params;
          forwardedRaw=JSON.stringify(forwardedMessage);
        }
        if(message?.method==="initialize"){
          context.initializeParams=message.params||{};if(context.primaryKey===null)context.primaryKey=record.key;
        }
        if(message?.method==="initialized"){
          context.initialized=true;record.initialized=true;
          for(const other of context.upstreams.values())if(other!==record&&!other.initialized)await initializeSecondary(other);
        }
        if(message?.method&&Object.prototype.hasOwnProperty.call(message,"id"))record.forwardedRequests.set(message.id,{method:message.method,params:forwardedMessage?.params||{}});
        record.socket.send(forwardedRaw,{binary:false});
      };

      browserSocket.on("message",(data,isBinary)=>{
        const raw=isBinary?data:String(data);let message=null;if(!isBinary)try{message=JSON.parse(raw)}catch{}
        if(message?.method&&Object.prototype.hasOwnProperty.call(message,"id"))context.inProgress.set(message.id,{method:String(message.method),params:message.params&&typeof message.params==="object"?message.params:{}});
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
    // How many requests of the open windows that match (({method, params}) => boolean) are on their way: read, not answered yet.
    requestsInProgress(match){
      let count=0;
      for(const context of clients)for(const request of context.inProgress.values())if(match(request))count++;
      return count;
    },
    broadcast(method,params={}){
      const payload=JSON.stringify({method,params});
      for(const context of clients){
        const socket=context.browserSocket;
        if(socket.readyState===WebSocket.OPEN)try{socket.send(payload)}catch{}
      }
    },
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
