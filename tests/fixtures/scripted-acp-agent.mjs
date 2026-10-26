// A scripted ACP agent over stdio, run by the tests as the harness: it answers from the JSON scenario named by
// TREBELL_ACP_SCENARIO and logs each message it receives, and each answer to a request of its own, to TREBELL_ACP_LOG.
// Scenario: {initialize, sessionNew, prompts:[{steps:[{update} | {request:{method,params}}], stopReason}]}; "$sessionId" in a
// step is the session's id. errors: {method: JSON-RPC error} answers that method with the error every time. signIn: {methodId,
// env, keepRefusing} plays a signed-out harness: session/new, load and resume answer ACP's auth_required (-32000) until an
// authenticate with methodId arrives, with the variable env set in the agent's own environment when one is named; keepRefusing
// accepts that authenticate and stays signed out.
import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";

const config=JSON.parse(readFileSync(process.env.TREBELL_ACP_SCENARIO,"utf8"));
const record=entry=>{if(process.env.TREBELL_ACP_LOG)appendFileSync(process.env.TREBELL_ACP_LOG,JSON.stringify(entry)+"\n")};
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
let next=1,promptIndex=0,options=Array.isArray(config.sessionNew?.configOptions)?config.sessionNew.configOptions:null;
const pending=new Map(),SETUPS=new Set(["session/new","session/load","session/resume"]);let signedIn=!config.signIn;
function signIn(message){
  const {methodId,env,keepRefusing}=config.signIn,asked=message.params?.methodId;
  if(asked!==methodId)return {error:{code:-32602,message:"Invalid params",data:{message:`Unknown authentication method: ${asked}`}}};
  if(env&&!process.env[env])return {error:{code:-32000,message:`${env} is not set`}};
  if(!keepRefusing)signedIn=true;
  return {result:{}};
}
function request(method,params){const id="agent-"+(next++);send({jsonrpc:"2.0",id,method,params});return new Promise(resolve=>pending.set(id,resolve))}
async function runPrompt(message){
  const script=(config.prompts||[])[promptIndex++]||{},sessionId=message.params.sessionId;
  for(const raw of script.steps||[]){
    const step=JSON.parse(JSON.stringify(raw).replaceAll("$sessionId",sessionId));
    if(step.update)send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:step.update}});
    if(step.request)record({reply:step.request.method,message:await request(step.request.method,step.request.params)});
  }
  send({jsonrpc:"2.0",id:message.id,result:{stopReason:script.stopReason||"end_turn"}});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{
  let message;try{message=JSON.parse(line)}catch{return}
  record({method:message.method??null,id:message.id??null,params:message.params??null});
  if(message.id!=null&&!message.method){const resolve=pending.get(message.id);pending.delete(message.id);resolve?.(message.error?{error:message.error}:message.result);return}
  if(message.id==null)return;
  const reply=result=>send({jsonrpc:"2.0",id:message.id,result});
  if(config.errors?.[message.method])return send({jsonrpc:"2.0",id:message.id,error:config.errors[message.method]});
  if(message.method==="authenticate"&&config.signIn)return send({jsonrpc:"2.0",id:message.id,...signIn(message)});
  if(!signedIn&&SETUPS.has(message.method))return send({jsonrpc:"2.0",id:message.id,error:{code:-32000,message:"Authentication required"}});
  if(message.method==="initialize")return reply(config.initialize||{protocolVersion:1,agentCapabilities:{}});
  if(message.method==="session/new")return reply({sessionId:"scripted-session",...(config.sessionNew||{}),...(options?{configOptions:options}:{})});
  // A loaded or resumed session answers with the same options, and no sessionId (ACP).
  if(message.method==="session/load"||message.method==="session/resume")return reply(options?{configOptions:options}:{});
  if(message.method==="session/set_config_option"){
    if(options)options=options.map(option=>option.id===message.params.configId?{...option,currentValue:message.params.value}:option);
    return reply({configOptions:options||[]});
  }
  if(message.method==="session/prompt")return void runPrompt(message);
  reply({});
});
