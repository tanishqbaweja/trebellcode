import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

// The fetch a provider's long stream is sent through (Native's Meta Responses stream, src/provider-manager.mjs). Node's fetch (undici)
// gives up on a response body after 300 s without a byte (its bodyTimeout) and on response headers after 300 s (headersTimeout), and Meta
// sends nothing while the model writes one output item, its reasoning or a tool call's arguments, so a long silent item failed at about
// 300 s on every attempt, before the lane's own idle bound. This one goes through Node's http client on a dedicated connection, which has
// no header or body deadline: the request's signal (the caller's header guard and stop) and the stream reader's idle bound
// (NATIVE_META_STREAM_IDLE_TIMEOUT_MS) are its only limits. openCodeLongRequestFetch (src/opencode-agent-session.mjs) does the same for
// OpenCode's long requests. A request that gets no answer fails as Node's fetch fails one, a TypeError "fetch failed" with the socket
// error as its cause, so the loop reads a dropped or refused connection as it always has.
export async function providerLongRequestFetch(input,init={}){
  const request=input instanceof Request?(init&&Object.keys(init).length?new Request(input,init):input):new Request(input,init);
  const url=new URL(request.url);
  if(url.protocol!=="http:"&&url.protocol!=="https:")throw new TypeError(`Unsupported provider URL protocol: ${url.protocol}`);
  const signal=init?.signal||(input instanceof Request?input.signal:null);
  const aborted=()=>signal?.reason instanceof Error?signal.reason:new DOMException("This operation was aborted","AbortError");
  if(signal?.aborted)throw aborted();
  const body=request.body?Buffer.from(await request.arrayBuffer()):null;
  if(signal?.aborted)throw aborted();
  const headers={};request.headers.forEach((value,key)=>{if(key!=="content-length")headers[key]=value});
  // identity: the body is read as it comes, with nothing to decompress.
  headers["accept-encoding"]="identity";if(body)headers["content-length"]=String(body.length);
  const send=url.protocol==="https:"?httpsRequest:httpRequest;
  return await new Promise((resolve,reject)=>{
    let answered=false;
    // agent:false: a dedicated connection, without the shared agent's idle-socket timeout.
    const req=send(url,{method:request.method,headers,agent:false},res=>{
      const status=res.statusCode||0;
      if(status<200||status>599){res.resume();answered=true;reject(new TypeError("fetch failed",{cause:new Error(`Unexpected HTTP status ${status}`)}));return}
      const responseHeaders=new Headers();
      for(const [key,value] of Object.entries(res.headers))for(const item of Array.isArray(value)?value:[value])if(item!=null)responseHeaders.append(key,String(item));
      const empty=request.method==="HEAD"||status===204||status===205||status===304;if(empty)res.resume();
      answered=true;
      resolve(new Response(empty?null:Readable.toWeb(res),{status,statusText:res.statusMessage||"",headers:responseHeaders}));
    });
    // A stop before the answer rejects with its reason; after it, the connection is closed and the body ends (the stream reader's own
    // abort handling and idle bound cancel it as well).
    const onAbort=()=>req.destroy(aborted());
    signal?.addEventListener?.("abort",onAbort,{once:true});
    req.once("error",error=>{if(answered)return;answered=true;reject(signal?.aborted?aborted():new TypeError("fetch failed",{cause:error}))});
    req.once("close",()=>signal?.removeEventListener?.("abort",onAbort));
    req.end(body||undefined);
  });
}

// Whether fetchFn is Node's own fetch: the global Node defines, which loads undici on its first call (Node 18 to 24 name it fetch and
// name undici in its source). A stand-in that replaced the global (a test's fake, the offline E2E guard, the perf tap) is not, so a
// ProviderManager sends through this transport only the streams that would have gone straight to Node's fetch, and whatever a
// stand-in guards it still guards for the Meta stream.
export function isNodeFetch(fetchFn){
  if(typeof fetchFn!=="function"||fetchFn.name!=="fetch")return false;
  try{return /undici/i.test(Function.prototype.toString.call(fetchFn))}catch{return false}
}
