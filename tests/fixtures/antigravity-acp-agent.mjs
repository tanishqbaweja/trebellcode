// A stand-in for Antigravity's ACP server (agy_acp_server 1.4.3) over stdio, run by the tests in its place. It answers from the JSON
// scenario in the file TREBELL_AGY_SCENARIO names, read as it starts, and logs each request it receives, with what its environment
// holds of Google's credentials and homes (never a key itself: only whether GEMINI_API_KEY is the scenario's expectKey, and the name
// keyNames gives it) and its process id, to TREBELL_AGY_LOG.
// Scenario: {expectKey, keyNames, startDelayMs, exitAt, stderr, exitCode, authenticate, authenticateDelayMs, sessionNew}. startDelayMs
// holds every request until that long after the start, as a slow machine's start would. exitAt names a request ("start" for none) at
// which the process writes stderr and exits with exitCode; authenticate and sessionNew are "ok" (the default), "hang" (no answer
// ever) or a JSON-RPC error, and authenticateDelayMs answers authenticate that much later. As Antigravity does, session/new, load and
// resume refuse with auth_required (-32000) when GEMINI_API_KEY is not set. A chat's session/prompt answers "fixture reply" and ends
// its turn; one whose text holds "[hang]" waits for session/cancel and ends cancelled. session/set_config_option and session/close
// are answered. holdLoadUntil and holdCloseUntil name files: session/load and resume, and session/close, are answered once that file
// exists, as a slow Antigravity would answer them.
// `--version` prints a version and exits, as a status check asks it.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

if(process.argv.includes("--version")){process.stdout.write("antigravity-acp 1.4.3-fixture\n");process.exit(0)}
const scenario=process.env.TREBELL_AGY_SCENARIO?JSON.parse(readFileSync(process.env.TREBELL_AGY_SCENARIO,"utf8")):{};
const record=entry=>{if(process.env.TREBELL_AGY_LOG)appendFileSync(process.env.TREBELL_AGY_LOG,JSON.stringify(entry)+"\n")};
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const exit=()=>{process.stderr.write(String(scenario.stderr||""),()=>process.exit(scenario.exitCode??1))};
if(scenario.exitAt==="start")exit();
const METHODS=[["oauth-personal","Log in with Google"],["oauth-business","Log in with Gemini Enterprise"],["gemini-api-key","Gemini API key"],["agent-platform","Gemini Enterprise Agent Platform"]].map(([id,name])=>({id,name}));
const MODELS=[{id:"model",name:"Model",category:"model",type:"select",currentValue:"gemini-fixture-flash",options:[{value:"gemini-fixture-flash",name:"Gemini Fixture Flash"},{value:"gemini-fixture-pro",name:"Gemini Fixture Pro"}]}];
const SIGNED_OUT={code:-32000,message:"auth.type is set to 'gemini-api-key' in settings.json but the GEMINI_API_KEY environment variable is not set."};
const answer=(message,how,result)=>{
  if(how==="hang")return;
  if(how&&typeof how==="object")return send({jsonrpc:"2.0",id:message.id,error:how});
  send({jsonrpc:"2.0",id:message.id,result});
};
// Runs reply at once, or once the file `path` names exists (holdLoadUntil, holdCloseUntil).
const once=(path,reply)=>{if(!path||existsSync(path))return reply();const timer=setInterval(()=>{if(existsSync(path)){clearInterval(timer);reply()}},25)};
const ready=Date.now()+(Number(scenario.startDelayMs)||0);
let buffered="",hanging=null;
function handle(message){
  const key=process.env.GEMINI_API_KEY,keyName=key?(scenario.keyNames||{})[key]??null:null;
  if(message.method==="session/cancel"&&message.id==null){
    record({method:"session/cancel",keyName,pid:process.pid});
    if(hanging){send({jsonrpc:"2.0",id:hanging.id,result:{stopReason:"cancelled"}});hanging=null}
    return;
  }
  if(message.id==null||!message.method)return;
  record({method:message.method,params:message.params??null,geminiHome:process.env.GEMINI_HOME??null,fileStorage:process.env.AGY_ACP_FORCE_FILE_STORAGE??null,keySet:Boolean(key),keyIsExpected:Boolean(key)&&key===scenario.expectKey,keyName,googleApiKey:Boolean(process.env.GOOGLE_API_KEY),pid:process.pid});
  if(scenario.exitAt===message.method){exit();return}
  if(message.method==="initialize")answer(message,"ok",{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},resume:{}},auth:{logout:{}}},authMethods:METHODS,agentInfo:{name:"antigravity-acp",title:"Google Antigravity",version:"1.4.3-fixture"}});
  else if(message.method==="authenticate"){const reply=()=>answer(message,scenario.authenticate,{});if(scenario.authenticateDelayMs)setTimeout(reply,scenario.authenticateDelayMs);else reply()}
  else if(message.method==="session/new"){
    if(!key)answer(message,SIGNED_OUT);
    else answer(message,scenario.sessionNew,{sessionId:"agy-session",configOptions:MODELS});
  }
  else if(message.method==="session/load"||message.method==="session/resume")once(scenario.holdLoadUntil,()=>answer(message,key?"ok":SIGNED_OUT,{configOptions:MODELS}));
  else if(message.method==="session/set_config_option")answer(message,"ok",{configOptions:MODELS.map(option=>option.id===message.params?.configId?{...option,currentValue:message.params.value}:option)});
  else if(message.method==="session/prompt"){
    if(JSON.stringify(message.params?.prompt??"").includes("[hang]")){hanging=message;return}
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:message.params?.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"fixture reply"}}}});
    answer(message,"ok",{stopReason:"end_turn"});
  }
  else if(message.method==="session/close")once(scenario.holdCloseUntil,()=>answer(message,"ok",{}));
  else send({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:`Method not found: ${message.method}`}});
}
function drain(){
  let newline;
  while((newline=buffered.indexOf("\n"))>=0){
    const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);
    let message;try{message=JSON.parse(line)}catch{continue}
    handle(message);
  }
}
process.stdin.on("data",chunk=>{buffered+=chunk;setTimeout(drain,Math.max(0,ready-Date.now()))});
