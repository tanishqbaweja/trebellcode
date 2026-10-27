// Stand-ins for the OpenCode servers a catalog read and a session start talk to: an OpenCode 2 server's JSON API as @opencode/client
// 2.0.24 reads it. routes["GET /api/command"] answers a route in place of the stand-in, or holds it.
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
