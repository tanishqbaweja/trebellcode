// A stand-in for Antigravity's ACP server (agy_acp_server 1.4.3) over stdio, run by the tests in its place. It answers from the JSON
// scenario in the file TREBELL_AGY_SCENARIO names, read as it starts, and logs each request it receives, with what its environment
// holds of Google's credentials and homes (never a key itself: only whether GEMINI_API_KEY is the scenario's expectKey), to
// TREBELL_AGY_LOG.
// Scenario: {expectKey, exitAt, stderr, exitCode, authenticate, sessionNew}. exitAt names a request ("start" for none) at which the
// process writes stderr and exits with exitCode; authenticate and sessionNew are "ok" (the default), "hang" (no answer ever) or a
// JSON-RPC error. As Antigravity does, session/new refuses with auth_required (-32000) when GEMINI_API_KEY is not set.
// `--version` prints a version and exits, as a status check asks it.
import { appendFileSync, readFileSync } from "node:fs";

if(process.argv.includes("--version")){process.stdout.write("antigravity-acp 1.4.3-fixture\n");process.exit(0)}
const scenario=process.env.TREBELL_AGY_SCENARIO?JSON.parse(readFileSync(process.env.TREBELL_AGY_SCENARIO,"utf8")):{};
const record=entry=>{if(process.env.TREBELL_AGY_LOG)appendFileSync(process.env.TREBELL_AGY_LOG,JSON.stringify(entry)+"\n")};
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const exit=()=>{process.stderr.write(String(scenario.stderr||""),()=>process.exit(scenario.exitCode??1))};
if(scenario.exitAt==="start")exit();
const METHODS=[["oauth-personal","Log in with Google"],["oauth-business","Log in with Gemini Enterprise"],["gemini-api-key","Gemini API key"],["agent-platform","Gemini Enterprise Agent Platform"]].map(([id,name])=>({id,name}));
const answer=(message,how,result)=>{
  if(how==="hang")return;
  if(how&&typeof how==="object")return send({jsonrpc:"2.0",id:message.id,error:how});
  send({jsonrpc:"2.0",id:message.id,result});
};
let buffered="";
process.stdin.on("data",chunk=>{
  buffered+=chunk;let newline;
  while((newline=buffered.indexOf("\n"))>=0){
    const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);
    let message;try{message=JSON.parse(line)}catch{continue}
    if(message.id==null||!message.method)continue;
    const key=process.env.GEMINI_API_KEY;
    record({method:message.method,params:message.params??null,geminiHome:process.env.GEMINI_HOME??null,fileStorage:process.env.AGY_ACP_FORCE_FILE_STORAGE??null,keySet:Boolean(key),keyIsExpected:Boolean(key)&&key===scenario.expectKey,googleApiKey:Boolean(process.env.GOOGLE_API_KEY)});
    if(scenario.exitAt===message.method){exit();return}
    if(message.method==="initialize")answer(message,"ok",{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},resume:{}},auth:{logout:{}}},authMethods:METHODS,agentInfo:{name:"antigravity-acp",title:"Google Antigravity",version:"1.4.3-fixture"}});
    else if(message.method==="authenticate")answer(message,scenario.authenticate,{});
    else if(message.method==="session/new"){
      if(!key)answer(message,{code:-32000,message:"auth.type is set to 'gemini-api-key' in settings.json but the GEMINI_API_KEY environment variable is not set."});
      else answer(message,scenario.sessionNew,{sessionId:"agy-session",configOptions:[{id:"model",name:"Model",category:"model",type:"select",currentValue:"gemini-fixture-flash",options:[{value:"gemini-fixture-flash",name:"Gemini Fixture Flash"},{value:"gemini-fixture-pro",name:"Gemini Fixture Pro"}]}]});
    }
    else send({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:`Method not found: ${message.method}`}});
  }
});
