// A stand-in for an OpenCode 2 server (`opencode serve`): its JSON API under /api, answered behind Basic auth as OpenCode 2.0.24
// answers @opencode/client (bodies {data}, 204 for empty answers, {_tag, message} for refusals), and its event stream. It checks a
// prompt's attachments as OpenCode 2.0.24 does: each file is {uri, name?}, and a prompt with one that has no uri is refused with
// OpenCode's own words. onPrompt({body, sessionID, emit}) plays a turn; emit(event) sends an event to every stream. A thread's
// managed `opencode serve` can be served.script (run as `node serve` in the thread's folder), which tells this server the password
// the session gave it and says it listens here, so the session treats the server as its own (attachments go as files).
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

export const FAKE_OPENCODE2_MODELS=Object.freeze([{providerID:"opencode",id:"big-pickle",name:"Big Pickle",enabled:true,limit:{context:200000},variants:[]}]);
const SERVE_SCRIPT=String.raw`
const url=process.env.FAKE_OPENCODE2_URL;
fetch(url+"/fake/password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:process.env.OPENCODE_PASSWORD||""})})
  .then(()=>{process.stdout.write("server listening on "+url+" \n");setInterval(()=>{},1<<30)},error=>{process.stderr.write(String(error));process.exit(1)});
`;
// Writes the `serve` stand-in into a folder (the thread's working folder, where `node serve --port=...` finds it).
export async function writeFakeOpenCode2Serve(folder){await writeFile(join(folder,"serve"),SERVE_SCRIPT,"utf8")}

// routes["GET /api/command"]({req, res, body, send, active, messages, emit}) answers a route in place of the stand-in. Every event
// stream gets OpenCode 2.0.24's heartbeat (a comment, no event) every heartbeatMs, 15 s as OpenCode sends it; 0 sends none, a stream
// gone silent. dropStreams() ends every open event stream, as a dropped connection does. The session's history (GET
// /api/session/<id>/message, newest first) is kept as OpenCode 2.0.24 keeps it (live): each prompt's user message under the id its
// answer gave, the replies onPrompt's reply(text) keeps, and an idle item with the outcome for each run's end (an execution event).
export async function startFakeOpenCode2({models=FAKE_OPENCODE2_MODELS,sessions={},onPrompt=null,routes={},heartbeatMs=15_000}={}){
  // active: the sessions OpenCode runs, from a prompt until an execution event ends the run (GET /api/session/active).
  const calls=[],streams=new Set(),forms=new Map(),messages=[],active=new Set();let password=null,events=0,prompts=0;
  const heartbeat=heartbeatMs>0?setInterval(()=>{for(const res of streams)res.write(": heartbeat\n\n")},heartbeatMs):null;heartbeat?.unref?.();
  const known=new Map([["ses_main",{id:"ses_main",agent:"build"}],...Object.entries(sessions)]);
  const emit=event=>{
    const value={id:`evt_${++events}`,created:Date.now(),...event};
    if(value.type==="form.created"&&value.data?.form)forms.set(String(value.data.form.id),{settled:false});
    const end=/^session\.execution\.(succeeded|failed|interrupted)$/.exec(String(value.type));
    if(end){active.delete(String(value.data?.sessionID||""));messages.push({id:`msg_idle_${events}`,type:"idle",outcome:end[1]})}
    for(const res of streams)res.write(`data: ${JSON.stringify(value)}\n\n`);
    return value;
  };
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");let text="";for await(const chunk of req)text+=chunk;
    let body=null;try{body=text?JSON.parse(text):null}catch{body=text}
    const key=`${req.method} ${url.pathname}`;
    const send=(status,value)=>{if(res.writableEnded)return;if(value===undefined){res.writeHead(status);res.end();return}res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    if(key==="POST /fake/password"){password=String(body?.password??"");return send(204)}
    if(password!==null&&req.headers.authorization!==`Basic ${Buffer.from(`opencode:${password}`,"utf8").toString("base64")}`)return send(401,{_tag:"UnauthorizedError",message:"Unauthorized"});
    calls.push({key,body,authorization:req.headers.authorization||null,query:Object.fromEntries(url.searchParams)});
    if(routes[key])return routes[key]({req,res,body,send,active,messages,emit});
    if(key==="GET /api/event"){
      res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});res.write(`data: ${JSON.stringify({id:"evt_0",type:"server.connected",data:{}})}\n\n`);
      streams.add(res);res.on("close",()=>streams.delete(res));return;
    }
    if(key==="GET /api/info")return send(200,{version:"2.0.24",pid:process.pid,urls:[`http://127.0.0.1:${server.address().port}`]});
    if(key==="GET /api/model")return send(200,{data:models});
    if(key==="GET /api/model/default")return send(200,{data:models[0]||null});
    if(["GET /api/command","GET /api/skill","GET /api/agent","GET /api/provider"].includes(key))return send(200,{data:[]});
    if(key==="POST /api/session")return send(200,{data:known.get("ses_main")});
    if(key==="GET /api/session/active")return send(200,{data:Object.fromEntries([...active].map(id=>[id,{type:"running"}]))});
    if(/^PUT \/api\/experimental\/session\/[^/]+\/instructions\/entries\//.test(key))return send(204);
    const match=/^\/api\/session\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if(match){
      const sessionID=decodeURIComponent(match[1]),rest=match[2]||"",session=known.get(sessionID);
      if(!session)return send(404,{_tag:"SessionNotFoundError",message:`Session not found: ${sessionID}`});
      if(req.method==="GET"&&!rest)return send(200,{data:session});
      if(req.method==="PATCH"&&!rest)return send(204);
      if(req.method==="POST"&&(rest==="/model"||rest==="/agent"))return send(204);
      if(req.method==="GET"&&rest==="/message")return send(200,{data:[...messages].reverse()});
      if(req.method==="GET"&&(rest==="/permission"||rest==="/form"))return send(200,{data:[]});
      // As OpenCode answers it: a session that runs nothing has nothing to stop.
      if(req.method==="POST"&&rest==="/interrupt"){const running=active.has(sessionID);if(running)emit({type:"session.execution.interrupted",data:{sessionID,reason:"interrupt"}});return send(200,{data:{interrupted:running}})}
      if(req.method==="POST"&&rest==="/prompt"){
        const files=Array.isArray(body?.files)?body.files:[];
        const missing=files.findIndex(file=>!file||typeof file!=="object"||typeof file.uri!=="string");
        if(missing>=0)return send(400,{_tag:"InvalidRequestError",message:`Missing key\n  at ["files"][${missing}]["uri"]`});
        const id=`msg_user_${++prompts}`;active.add(sessionID);messages.push({id,type:"user",text:String(body?.text||""),...(files.length?{files}:{})});
        send(200,{data:{id,sessionID,type:"user",payload:{text:body?.text||"",files}}});
        // reply(text, messageID) keeps the run's assistant message with that text, or writes on one already kept, as OpenCode does while
        // the model streams.
        const reply=(text,messageID=`msg_assistant_${prompts}`)=>{
          const kept=messages.find(message=>message.id===messageID),content=[{type:"text",text}];
          if(kept)kept.content=content;else messages.push({id:messageID,type:"assistant",content});
        };
        if(typeof onPrompt==="function")void Promise.resolve().then(()=>onPrompt({body,sessionID,id,emit,reply})).catch(()=>{});
        return;
      }
      const form=/^\/form\/([^/]+)(\/reply)?$/.exec(rest);
      if(form){
        const formID=decodeURIComponent(form[1]),entry=forms.get(formID);
        if(!entry)return send(404,{_tag:"FormNotFoundError",message:`Form not found: ${formID}`});
        if(entry.settled)return send(409,{_tag:"FormAlreadySettledError",message:`Form already settled: ${formID}`});
        entry.settled=true;
        if(req.method==="POST"&&form[2]){emit({type:"form.replied",data:{id:formID,sessionID,answer:body?.answer||{}}});return send(204)}
        if(req.method==="DELETE"&&!form[2]){emit({type:"form.cancelled",data:{id:formID,sessionID}});return send(204)}
      }
    }
    send(404,{_tag:"NotFoundError",message:`No fake route for ${key}`});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  return {
    url,calls,emit,forms,active,messages,
    dropStreams:()=>{for(const res of streams)res.end();streams.clear()},
    called:key=>calls.filter(call=>call.key===key),
    prompts:()=>calls.filter(call=>/^POST \/api\/session\/[^/]+\/prompt$/.test(call.key)).map(call=>call.body),
    close:()=>{clearInterval(heartbeat);for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))},
  };
}
