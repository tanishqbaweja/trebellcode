import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

function websocketUrl(baseUrl){
  const url=new URL(String(baseUrl||"https://api.openai.com/v1").replace(/\/+$/,"")+"/responses");
  url.protocol=url.protocol==="http:"?"ws:":url.protocol==="https:"?"wss:":url.protocol;
  return url.toString();
}

// Server-suggested wait before retrying a rate-limited request, from OpenAI's retry headers
// (also carried on WebSocket error events) or the "Please try again in 2.4s" message.
export function openAiRetryAfterMs({headers=null,message=""}={}){
  const header=name=>String((typeof headers?.get==="function"?headers.get(name):headers?.[name])??"").trim();
  const ms=header("retry-after-ms"),seconds=header("retry-after");
  if(ms&&Number.isFinite(Number(ms))&&Number(ms)>=0)return Math.ceil(Number(ms));
  if(seconds&&Number.isFinite(Number(seconds))&&Number(seconds)>=0)return Math.ceil(Number(seconds)*1000);
  const match=/\btry again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(String(message||""));
  return match?Math.ceil(Number(match[1])*(match[2].toLowerCase()==="ms"?1:1000)):null;
}

function responseError(event,message="OpenAI Responses WebSocket request failed",kind="api_error"){
  const providerError=event?.response?.error||event?.error||null,error=new Error(providerError?.message||event?.message||message);
  error.code=providerError?.code||event?.code||"openai_responses_websocket_error";
  const providerErrorType=String(providerError?.type||"").trim().toLowerCase(),providerErrorCode=String(providerError?.code||"").trim().toLowerCase(),providerMessage=String(providerError?.message||event?.message||"");
  const explicitTransientProcessingFailure=!providerErrorType&&!providerErrorCode&&(
    /\ban error occurred while processing your request\b[\s\S]*\byou can retry your request\b/i.test(providerMessage)||
    /\bthe server had an error while processing your request\b/i.test(providerMessage)
  );
  const rateLimited=providerErrorCode==="rate_limit_exceeded";
  error.webSocketEvent=event||null;error.webSocketFailureKind=kind;error.replaySafe=false;error.retryable=providerErrorType==="server_error"||providerErrorCode==="server_error"||explicitTransientProcessingFailure||rateLimited;
  if(rateLimited){error.rateLimited=true;const retryAfterMs=openAiRetryAfterMs({headers:providerError?.headers,message:providerMessage});if(retryAfterMs!=null)error.retryAfterMs=retryAfterMs}
  return error;
}

function transportError(message,cause=null,{replaySafe=false}={}){
  const error=new Error(message);error.code="openai_responses_websocket_transport";error.transportFailure=true;error.webSocketFailureKind="transport";error.replaySafe=replaySafe===true;error.retryable=false;if(cause)error.cause=cause;return error;
}

function protocolError(message,cause=null){
  const error=new Error(message);error.code="openai_responses_websocket_protocol";error.protocolFailure=true;error.webSocketFailureKind="protocol";error.replaySafe=false;error.retryable=false;if(cause)error.cause=cause;return error;
}

function terminateSocket(socket,SocketClass){
  if(!socket||socket.readyState===SocketClass.CLOSED)return;
  if(socket.readyState===SocketClass.CONNECTING)socket.once?.("error",()=>{});
  try{socket.terminate?.()}catch{try{socket.close?.()}catch{}}
}

function laneError(error){
  const copy=new Error(error?.message||"OpenAI Responses WebSocket failed.");copy.name=error?.name||"Error";
  for(const key of ["code","transportFailure","protocolFailure","webSocketFailureKind","replaySafe","retryable"])if(error?.[key]!==undefined)copy[key]=error[key];
  if(error?.cause!==undefined)copy.cause=error.cause;if(error?.webSocketEvent!==undefined)copy.webSocketEvent=error.webSocketEvent;
  return copy;
}

function abortBeforeSendError(signal){
  const error=signal?.reason instanceof Error?signal.reason:new DOMException("Aborted","AbortError");
  try{error.replaySafe=true;error.retryable=false;error.webSocketFailureKind=error?.name==="TimeoutError"?"timeout_before_send":"cancelled_before_send"}catch{}
  return error;
}

function terminalResponse(event,completedItems){
  const source=event?.response&&typeof event.response==="object"?structuredClone(event.response):{};
  if(!Array.isArray(source.output)&&completedItems.size){
    source.output=[...completedItems.entries()].sort((a,b)=>a[0]-b[0]).map(([,item])=>structuredClone(item));
  }
  return source;
}

function validOutputItem(item){
  if(!item||typeof item!=="object"||Array.isArray(item)||typeof item.type!=="string")return false;
  if(item.type!=="message")return true;
  if(!Array.isArray(item.content))return false;
  return item.content.every(part=>part&&typeof part==="object"&&!Array.isArray(part)&&typeof part.type==="string"&&(part.type!=="output_text"||typeof part.text==="string"));
}

export function openAiResponsesWebSocketStreamId(value){
  const raw=String(value||"").trim();if(!raw)return null;
  const normalized=raw.replace(/[^A-Za-z0-9_.-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,256);
  return normalized||null;
}

export class OpenAiResponsesWebSocket{
  constructor({apiKey,baseUrl="https://api.openai.com/v1",userAgent="Trebell",WebSocketClass=WebSocket,onReset=null,connectTimeoutMs=12_000}={}){
    if(!String(apiKey||"").trim())throw new Error("OpenAI Responses WebSocket requires an API key.");
    this.apiKey=String(apiKey).trim();this.baseUrl=baseUrl;this.userAgent=userAgent;this.WebSocketClass=WebSocketClass;this.onReset=onReset;this.connectTimeoutMs=Math.max(1000,Math.trunc(Number(connectTimeoutMs)||12_000));
    this.socket=null;this.connecting=null;this.pending=new Map();this.closed=false;this.generation=0;
  }

  connectionState(){
    return {generation:this.generation,open:this.socket?.readyState===this.WebSocketClass.OPEN};
  }

  async #connect(signal=null){
    if(this.closed)throw transportError("OpenAI Responses WebSocket is closed.",null,{replaySafe:true});
    if(this.socket?.readyState===this.WebSocketClass.OPEN)return this.socket;
    if(!this.connecting){
      const generation=++this.generation,Socket=this.WebSocketClass,url=websocketUrl(this.baseUrl);
      this.connecting=new Promise((resolve,reject)=>{
        let settled=false;
        const socket=new Socket(url,{headers:{Authorization:`Bearer ${this.apiKey}`,"User-Agent":this.userAgent},followRedirects:false});this.socket=socket;
        const cleanup=()=>{clearTimeout(timer);socket.off?.("open",open);socket.off?.("error",initialError);socket.off?.("close",initialClose)};
        const finishError=error=>{if(settled)return;settled=true;cleanup();reject(error)};
        const open=()=>{if(settled)return;settled=true;cleanup();socket.on?.("message",data=>this.#message(generation,data));socket.on?.("error",error=>this.#socketFailure(generation,transportError("OpenAI Responses WebSocket transport error.",error)));socket.on?.("close",(code,reason)=>this.#socketFailure(generation,transportError(`OpenAI Responses WebSocket closed (${Number(code)||0}${reason?`: ${String(reason)}`:""}).`)));resolve(socket)};
        const initialError=error=>finishError(transportError("OpenAI Responses WebSocket failed to connect.",error,{replaySafe:true}));
        const initialClose=code=>finishError(transportError(`OpenAI Responses WebSocket closed before opening (${Number(code)||0}).`,null,{replaySafe:true}));
        const timer=setTimeout(()=>{terminateSocket(socket,this.WebSocketClass);finishError(transportError("OpenAI Responses WebSocket connection timed out.",null,{replaySafe:true}))},this.connectTimeoutMs);
        socket.once?.("open",open);socket.once?.("error",initialError);socket.once?.("close",initialClose);
      }).finally(()=>{this.connecting=null});
    }
    try{
      if(!signal)return await this.connecting;
      if(signal.aborted)throw abortBeforeSendError(signal);
      return await new Promise((resolve,reject)=>{
        const aborted=()=>{cleanup();reject(abortBeforeSendError(signal))},cleanup=()=>signal.removeEventListener?.("abort",aborted);
        signal.addEventListener?.("abort",aborted,{once:true});this.connecting.then(value=>{cleanup();resolve(value)},error=>{cleanup();reject(error)});
      });
    }catch(error){if(error?.webSocketFailureKind!=="timeout_before_send"&&error?.webSocketFailureKind!=="cancelled_before_send")this.#resetSocket({notify:true,reason:"connect_failure"});throw error}
  }

  #message(generation,data){
    if(generation!==this.generation)return;
    const raw=typeof data==="string"?data:Buffer.isBuffer(data)?data.toString("utf8"):String(data),bytes=Buffer.byteLength(raw,"utf8");let event;
    try{event=JSON.parse(raw)}catch{this.#socketFailure(generation,protocolError("OpenAI Responses WebSocket returned invalid JSON."),"protocol_failure");return}
    const streamId=typeof event?.stream_id==="string"?event.stream_id:null,pending=streamId?this.pending.get(streamId):null;if(!pending)return;
    pending.armIdle?.();
    pending.responseBytes+=bytes;
    if(event.type==="response.output_text.delta"&&event.delta&&pending.timeToFirstTokenMs==null)pending.timeToFirstTokenMs=Number((performance.now()-pending.started).toFixed(3));
    if(event.type==="response.output_item.done"){
      if(!Number.isSafeInteger(event.output_index)||event.output_index<0||!validOutputItem(event.item))return this.#socketFailure(generation,protocolError("OpenAI Responses WebSocket returned a malformed output item."),"protocol_failure");
      pending.completedItems.set(event.output_index,structuredClone(event.item));return;
    }
    if(event.type==="error"){this.#finish(streamId,{error:responseError(event,"OpenAI Responses WebSocket API error","api_error")});return}
    if(event.type==="response.failed"){this.#finish(streamId,{error:responseError(event,"OpenAI Responses WebSocket response failed","response_failed")});return}
    if(event.type==="response.completed"||event.type==="response.incomplete"){
      if(!event.response||typeof event.response!=="object"||Array.isArray(event.response)||(event.response.output!=null&&(!Array.isArray(event.response.output)||!event.response.output.every(validOutputItem))))return this.#socketFailure(generation,protocolError("OpenAI Responses WebSocket returned a malformed terminal response."),"protocol_failure");
      this.#finish(streamId,{response:terminalResponse(event,pending.completedItems)});
    }
  }

  #finish(streamId,{response=null,error=null}={}){
    const pending=this.pending.get(streamId);if(!pending)return;this.pending.delete(streamId);if(pending.idleTimer)clearTimeout(pending.idleTimer);pending.signal?.removeEventListener?.("abort",pending.abort);const telemetry={responseBytes:pending.responseBytes,timeToFirstTokenMs:pending.timeToFirstTokenMs,totalLatencyMs:Number((performance.now()-pending.started).toFixed(3))};
    if(error){error.webSocketTelemetry={...telemetry,requestBytes:Number(pending.requestBytes||0)};pending.reject(error)}else pending.resolve({response,telemetry});
  }

  #socketFailure(generation,error,reason="transport_failure"){
    if(generation!==this.generation)return;
    for(const streamId of [...this.pending.keys()])this.#finish(streamId,{error:laneError(error)});
    this.#resetSocket({notify:true,reason});
  }

  #resetSocket({notify=false,reason="reset"}={}){
    const socket=this.socket;this.socket=null;this.connecting=null;this.generation++;
    terminateSocket(socket,this.WebSocketClass);
    if(notify)try{this.onReset?.({reason})}catch{}
  }

  async request(body,{streamId,signal=null,idleTimeoutMs=null}={}){
    const lane=openAiResponsesWebSocketStreamId(streamId);if(!lane)throw new Error("OpenAI Responses WebSocket requires a stable stream ID.");
    if(this.pending.has(lane))throw new Error("OpenAI Responses WebSocket stream already has an active response.");
    if(signal?.aborted)throw abortBeforeSendError(signal);
    let socket;try{socket=await this.#connect(signal)}catch(error){if(signal?.aborted)this.#resetSocket({notify:true,reason:"abort"});throw error}if(signal?.aborted){this.#resetSocket({notify:true,reason:"abort"});throw abortBeforeSendError(signal)}
    const event={...body,type:"response.create",stream_id:lane,store:false};delete event.stream;delete event.background;
    const payload=JSON.stringify(event),requestBytes=Buffer.byteLength(payload,"utf8"),started=performance.now(),idleMs=Math.max(0,Math.trunc(Number(idleTimeoutMs)||0));
    return await new Promise((resolve,reject)=>{
      const abort=()=>{const pending=this.pending.get(lane),error=signal?.reason instanceof Error?signal.reason:new DOMException("Aborted","AbortError");if(error&&typeof error==="object"){error.replaySafe=pending?.sent!==true;error.retryable=false;error.webSocketFailureKind=error?.name==="TimeoutError"?"timeout":"cancelled"}this.#finish(lane,{error});for(const other of [...this.pending.keys()])if(other!==lane)this.#finish(other,{error:transportError("OpenAI Responses WebSocket reset after cancellation.")});this.#resetSocket({notify:true,reason:"abort"})};
      let pending=null;
      const expire=()=>{const current=this.pending.get(lane);if(!current||current!==pending)return;const error=new DOMException("OpenAI Responses WebSocket idle timeout exceeded.","TimeoutError");error.replaySafe=current.sent!==true;error.retryable=false;error.webSocketFailureKind="timeout";this.#finish(lane,{error});for(const other of [...this.pending.keys()])if(other!==lane)this.#finish(other,{error:transportError("OpenAI Responses WebSocket reset after response timeout.")});this.#resetSocket({notify:true,reason:"timeout_failure"})};
      const armIdle=()=>{if(!pending||idleMs<=0)return;if(pending.idleTimer)clearTimeout(pending.idleTimer);pending.idleTimer=setTimeout(expire,idleMs);pending.idleTimer.unref?.()};
      pending={resolve:value=>resolve({...value,requestBytes}),reject,started,requestBytes,responseBytes:0,timeToFirstTokenMs:null,completedItems:new Map(),signal,abort,sent:false,idleTimer:null,armIdle};this.pending.set(lane,pending);signal?.addEventListener?.("abort",abort,{once:true});
      try{socket.send(payload);pending.sent=true;armIdle()}catch(error){this.#finish(lane,{error:transportError("OpenAI Responses WebSocket send failed.",error,{replaySafe:true})});this.#resetSocket({notify:true,reason:"send_failure"})}
    });
  }

  close(){
    this.closed=true;const error=transportError("OpenAI Responses WebSocket closed.");for(const streamId of [...this.pending.keys()])this.#finish(streamId,{error});this.#resetSocket({notify:false,reason:"close"});
  }
}
