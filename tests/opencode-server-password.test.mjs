import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAgentSession, discoverOpenCodeModelCatalog } from "../src/opencode-agent-session.mjs";
import { generateTextWithHarness } from "../src/harness-text-generation.mjs";

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=5000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(20)}
}
const PROVIDERS={all:[{id:"opencode",name:"OpenCode Zen",models:{pickle:{id:"big-pickle",name:"Big Pickle"}}}],connected:["opencode"],default:{opencode:"big-pickle"}};

// `opencode serve` of OpenCode 1.x as the tests run it: a launcher (a .cmd on Windows, a shell script elsewhere) runs this script, which
// answers only Basic auth with OPENCODE_SERVER_USERNAME ("opencode" when unset) and OPENCODE_SERVER_PASSWORD when the password is set,
// as OpenCode 1.x does, and logs what every request carried.
const FAKE_SERVE=String.raw`
const http=require("node:http"),fs=require("node:fs");
const port=Number((process.argv.find(arg=>arg.startsWith("--port="))||"").slice(7));
const password=process.env.OPENCODE_SERVER_PASSWORD||"",username=process.env.OPENCODE_SERVER_USERNAME||"opencode";
const expected=password?"Basic "+Buffer.from(username+":"+password,"utf8").toString("base64"):null;
http.createServer((req,res)=>{
  let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{
    const url=new URL(req.url,"http://127.0.0.1"),key=req.method+" "+url.pathname;
    fs.appendFileSync(process.env.FAKE_OPENCODE_LOG,JSON.stringify({key,authorization:req.headers.authorization||null})+"\n");
    if(expected&&req.headers.authorization!==expected){res.writeHead(401,{"content-type":"text/plain","www-authenticate":"Basic realm=\"opencode\""});res.end("Unauthorized");return}
    const json=value=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    if(key==="GET /provider")return json(${JSON.stringify(PROVIDERS)});
    if(key==="GET /config")return json({});
    if(["GET /command","GET /agent","GET /skill"].includes(key))return json([]);
    if(key==="POST /session")return json({id:"ses_auth"});
    if(key==="GET /event"){res.writeHead(200,{"content-type":"text/event-stream"});res.write("data: "+JSON.stringify({type:"server.connected",properties:{}})+"\n\n");return}
    if(/^POST \/session\/[^/]+\/message$/.test(key))return json({info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",providerID:"opencode",modelID:"big-pickle",tokens:{}},parts:[{id:"prt_1",type:"text",text:"Fix the parser"}]});
    if(/^(POST \/session\/[^/]+\/abort|DELETE \/session\/[^/]+|POST \/instance\/dispose)$/.test(key))return json(true);
    res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({name:"NotFoundError",data:{message:"not found"}}));
  });
}).listen(port,"127.0.0.1",()=>process.stdout.write("opencode server listening on http://127.0.0.1:"+port+"\n"));
`;
async function fakeOpenCodeLauncher(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-password-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const script=join(root,"fake-opencode-serve.cjs"),log=join(root,"requests.jsonl");await writeFile(script,FAKE_SERVE,"utf8");await writeFile(log,"","utf8");
  let launcher;
  if(process.platform==="win32"){launcher=join(root,"opencode.cmd");await writeFile(launcher,`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,"utf8")}
  else{launcher=join(root,"opencode");await writeFile(launcher,`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,"utf8");await chmod(launcher,0o755)}
  const requests=async()=>(await readFile(log,"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line));
  return {root,launcher,requests,env:(extra={})=>({...process.env,FAKE_OPENCODE_LOG:log,OPENCODE_SERVER_PASSWORD:"",OPENCODE_SERVER_USERNAME:"",...extra})};
}
const basic=(username,password)=>"Basic "+Buffer.from(`${username}:${password}`,"utf8").toString("base64");

test("an OpenCode 1.x server Trebell starts with the profile's OPENCODE_SERVER_PASSWORD gets that password from every client: the chat, the model list and Git text",async t=>{
  const fake=await fakeOpenCodeLauncher(t),env=fake.env({OPENCODE_SERVER_PASSWORD:"hunter2-secret"});
  const session=new OpenCodeAgentSession({command:fake.launcher,cwd:fake.root,env});
  try{
    const started=await session.start({});
    assert.equal(started.session.sessionId,"ses_auth");
    await eventually(async()=>(await fake.requests()).some(request=>request.key==="GET /event"),{message:"the session's event stream did not open"});
  }finally{await session.close()}
  const catalog=await discoverOpenCodeModelCatalog({command:fake.launcher,cwd:fake.root,env});
  assert.deepEqual(catalog.models,["opencode/big-pickle"]);
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode"};
  const runtimeManager={activeInstance:()=>instance,executable:()=>fake.launcher,childEnv:()=>env,remoteIo:()=>null,definitions:()=>[],probe:async()=>({available:true,version:"1.18.32"}),recheck:async()=>null};
  const text=await generateTextWithHarness({runtimeManager,prompt:"Write a commit subject",cwd:fake.root,models:["opencode/big-pickle"]});
  assert.equal(text.text,"Fix the parser");
  const requests=await fake.requests();
  assert.ok(requests.length>=8,"the session, the catalog and Git text all asked the server");
  assert.deepEqual(requests.filter(request=>request.authorization!==basic("opencode","hunter2-secret")),[],"every request carried the password");
});

test("OpenCode 1.x's own username goes with the password, and a server started without a password is sent none",async t=>{
  const fake=await fakeOpenCodeLauncher(t);
  const named=await discoverOpenCodeModelCatalog({command:fake.launcher,cwd:fake.root,env:fake.env({OPENCODE_SERVER_PASSWORD:"pw",OPENCODE_SERVER_USERNAME:"admin"})});
  assert.deepEqual(named.models,["opencode/big-pickle"]);
  const before=(await fake.requests()).length;
  assert.ok(before>0);assert.ok((await fake.requests()).every(request=>request.authorization===basic("admin","pw")));
  await discoverOpenCodeModelCatalog({command:fake.launcher,cwd:fake.root,env:fake.env()});
  const open=(await fake.requests()).slice(before);
  assert.ok(open.length>0);assert.ok(open.every(request=>request.authorization===null),"no password, no Authorization header");
});
