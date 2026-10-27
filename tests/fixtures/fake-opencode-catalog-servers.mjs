// Stand-ins for the OpenCode servers a catalog read and a session start talk to: an OpenCode 2 server's JSON API as @opencode/client
// 2.0.24 reads it, and an OpenCode 1.x `opencode serve` as @opencode-ai/sdk reads it. routes["GET /api/command"] (2.x) or
// routes["GET /command"] (1.x) answers a route in place of the stand-in, or holds it.
import { createServer } from "node:http";

// count models of one provider, each with the given reasoning variants.
export const openCodeModels=(count,{provider="opencode",variants=[]}={})=>Array.from({length:count},(_,index)=>({providerID:provider,id:`model-${index}`,name:`Model ${index}`,enabled:true,variants:variants.map(id=>({id}))}));

// models() gives each read of the model list.
export async function fakeOpenCode2Catalog({models:list=()=>openCodeModels(2),routes={}}={}){
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");for await(const _chunk of req);
    const key=`${req.method} ${url.pathname}`,send=value=>{if(res.writableEnded)return;res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    if(routes[key])return routes[key]({req,res,send});
    if(key==="GET /api/info")return send({version:"2.0.24",pid:process.pid,urls:[]});
    if(key==="GET /api/model")return send({data:list()});
    if(key==="GET /api/model/default")return send({data:null});
    if(key==="GET /api/command")return send({data:[{name:"review",description:"Review"}]});
    if(["GET /api/skill","GET /api/agent","GET /api/provider"].includes(key))return send({data:[]});
    res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({_tag:"NotFoundError",message:`No route for ${key}`}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>{server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))}};
}

export async function fakeOpenCode1Catalog({providers={connected:["opencode"],default:{opencode:"big-pickle"},all:[{id:"opencode",name:"OpenCode Zen",models:{pickle:{id:"big-pickle",name:"Big Pickle"}}}]},routes={},commands=[{name:"init"}],skills=[{name:"pdf"}],agents=[{name:"build",mode:"primary",permission:[{permission:"external_directory",pattern:"/tmp/opencode/*",action:"allow"}]}]}={}){
  const calls=[],streams=new Set();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");let text="";for await(const chunk of req)text+=chunk;
    const key=`${req.method} ${url.pathname}`,json=value=>{if(res.writableEnded)return;res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    calls.push(key);
    if(routes[key])return routes[key]({req,res,json});
    if(key==="GET /event"){res.writeHead(200,{"content-type":"text/event-stream"});res.write(`data: ${JSON.stringify({type:"server.connected",properties:{}})}\n\n`);streams.add(res);res.on("close",()=>streams.delete(res));return}
    if(key==="GET /provider")return json(providers);
    if(key==="GET /config")return json({});
    if(key==="GET /command")return json(commands);
    if(key==="GET /skill")return json(skills);
    if(key==="GET /agent")return json(agents);
    if(key==="POST /session")return json({id:"ses_fixture",permission:JSON.parse(text||"{}").permission||[]});
    if(key==="POST /instance/dispose"||/^POST \/session\/[^/]+\/abort$/.test(key))return json(true);
    res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({name:"NotFoundError",data:{message:`No route for ${key}`}}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,close:()=>{for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))}};
}
