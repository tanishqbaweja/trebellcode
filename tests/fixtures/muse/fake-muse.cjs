// A stand-in Muse Code CLI for tests: `--version` answers as Muse Code 1.4.13 does, and `serve ...` speaks the Muse Session Protocol
// (NDJSON JSON-RPC over stdio) the way Muse 1.4.13 answers it, with frames shaped like the recorded ones in this folder: initialize,
// model/list, session/start and session/resume, session/setApprovalMode and session/setModel, turn/start (a reply streamed and
// completed), turn/steer and turn/interrupt. Its environment steers it:
//   MUSE_FAKE_LOG          a file each start and each frame received is appended to, as JSON lines
//   MUSE_FAKE_MODELS       a file holding model/list's answer ({"result":...}); without it Muse lists no models, as signed out
//   MUSE_FAKE_VERSION      what --version prints (default "Muse Code 1.4.13 (1.4.13-R6996.1)"); MUSE_FAKE_VERSION_EXIT its exit code
//   MUSE_FAKE_REFUSE       a model id session/setModel refuses, as Muse does a model the account cannot use
//   MUSE_FAKE_HOLD         "1": a turn waits for a turn/steer (or a Stop) before it completes, as does a turn whose message says
//                          "hold until steered"
//   MUSE_FAKE_SERVE_FAIL   a file: while it is there, `serve` exits at once with the exit code it holds, after the line Muse writes
//                          for a malformed settings file (3: Muse could not load its settings)
const fs=require("node:fs"),readline=require("node:readline");
const log=entry=>{if(process.env.MUSE_FAKE_LOG)fs.appendFileSync(process.env.MUSE_FAKE_LOG,JSON.stringify(entry)+"\n")};
const argv=process.argv.slice(2);
log({start:argv,pid:process.pid,cwd:process.cwd(),env:{MUSE_NO_AUTO_UPDATE:process.env.MUSE_NO_AUTO_UPDATE??null,META_API_KEY:process.env.META_API_KEY?"set":null,MUSE_CHANNEL:process.env.MUSE_CHANNEL??null}});
if(argv[0]==="--version"){process.stdout.write((process.env.MUSE_FAKE_VERSION??"Muse Code 1.4.13 (1.4.13-R6996.1)")+"\n");process.exit(Number(process.env.MUSE_FAKE_VERSION_EXIT||0))}
if(argv[0]!=="serve"){process.stderr.write("fake muse: unknown command "+argv.join(" ")+"\n");process.exit(2)}
if(process.env.MUSE_FAKE_SERVE_FAIL&&fs.existsSync(process.env.MUSE_FAKE_SERVE_FAIL)){
  process.stderr.write("load settings for serve composition: malformed settings file at ~/.config/muse/settings.json\n");
  process.exit(Number(fs.readFileSync(process.env.MUSE_FAKE_SERVE_FAIL,"utf8").trim())||3);
}

const write=frame=>process.stdout.write(JSON.stringify(frame)+"\n");
let cursor=0;
const notify=(method,sessionId,params)=>write({jsonrpc:"2.0",method,params:{sessionId,viewCursor:`v:${sessionId}:${++cursor}`,...params},emittedAtMs:Date.now()});
const catalog=()=>{try{return JSON.parse(fs.readFileSync(process.env.MUSE_FAKE_MODELS,"utf8")).result}catch{return {providerId:"meta",profileId:"tbh",source:"bundledCatalog",models:[]}}};
const sessions=new Map(),running=new Map();
const sessionRecord=(sessionId,state)=>({sessionId,status:"idle",activeTurnId:null,workspaceRoot:state.workspaceRoot,providerId:"meta",modelId:state.modelId,turnCount:0,forkedFrom:null,kind:"root"});

function reply(sessionId,turn,text){
  turn.text+=text;
  notify("item/delta",sessionId,{itemId:turn.itemId,field:"text",delta:text});
}
function complete(sessionId,turnId,terminal="completed"){
  const turn=running.get(turnId);if(!turn)return;running.delete(turnId);
  notify("item/completed",sessionId,{item:{itemId:turn.itemId,kind:"agentMessage",turnId,revision:2,status:terminal==="completed"?"completed":"interrupted",text:turn.text}});
  notify("turn/completed",sessionId,{turnId,terminal});
}
function startTurn(sessionId,params){
  const state=sessions.get(sessionId),turnId=params.commandId,turn={itemId:turnId+"-reply",text:""};running.set(turnId,turn);
  const words=(params.input||[]).filter(part=>part.type==="text").map(part=>part.text).at(-1)||"";
  notify("turn/started",sessionId,{turnId,commandId:turnId});
  notify("item/completed",sessionId,{item:{itemId:turnId+"-user",kind:"userMessage",turnId,revision:1,status:"completed",text:words}});
  notify("item/started",sessionId,{item:{itemId:turn.itemId,kind:"agentMessage",turnId,revision:1,status:"inProgress",text:""}});
  reply(sessionId,turn,`Muse fixture reply on ${state?.modelId||"Muse's default model"} at ${params.reasoningEffort||"Muse's default"} effort.`);
  const hold=process.env.MUSE_FAKE_HOLD==="1"||(params.input||[]).some(part=>part.type==="text"&&/hold until steered/i.test(part.text));
  if(!hold)setTimeout(()=>complete(sessionId,turnId),20);
}

const answers={
  initialize:params=>({serverInfo:{name:"muse",version:"1.4.13"},userAgent:"muse-build/1.4.13 (serve; fake)",museHome:"~/.local/share/muse",platformFamily:process.platform==="win32"?"windows":"unix",platformOs:process.platform==="win32"?"windows":process.platform,schema:{version:1,fingerprint:"sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b"},grantedCapabilities:[...(params?.capabilities?.requestedCapabilities||[])],experimentalApi:false,sessionDurability:argv.includes("--no-session-log")?"ephemeral":"durable",sandboxAvailability:"unavailable"}),
  "model/list":()=>catalog(),
  "session/start":params=>{const state={modelId:params.modelId||"muse-spark-1.2",workspaceRoot:params.workspaceRoot};sessions.set(params.sessionId,state);return {session:sessionRecord(params.sessionId,state),viewCursor:`v:${params.sessionId}:${++cursor}`}},
  "session/resume":params=>{const state=sessions.get(params.sessionId)||{modelId:process.env.MUSE_FAKE_RESUMED_MODEL||"muse-spark-1.2",workspaceRoot:null};sessions.set(params.sessionId,state);return {session:sessionRecord(params.sessionId,state),history:{mode:"none",items:null},pendingRequests:[],viewCursor:`v:${params.sessionId}:${++cursor}`}},
  "session/setApprovalMode":params=>({commandId:params.commandId,applyOutcome:"noop"}),
  "session/setModel":params=>{
    const modelId=params?.model?.modelId;
    if(modelId&&modelId===process.env.MUSE_FAKE_REFUSE)throw Object.assign(new Error(`model ${modelId} does not exist or you lack access`),{code:-32030,kind:"commandRejected"});
    const state=sessions.get(params.sessionId);if(state)state.modelId=modelId;
    return {commandId:params.commandId,status:"accepted"};
  },
  "turn/start":params=>{setImmediate(()=>startTurn(params.sessionId,params));return {commandId:params.commandId,status:"accepted",turnId:params.commandId,startedNewTurn:true,disposition:"started"}},
  "turn/steer":params=>{
    const turn=running.get(params.expectedTurnId);if(!turn)throw Object.assign(new Error("no running turn"),{code:-32030,kind:"commandRejected"});
    const words=(params.input||[]).filter(part=>part.type==="text").map(part=>part.text).join(" ");
    setImmediate(()=>{reply(params.sessionId,turn,` Steered: ${words}.`);complete(params.sessionId,params.expectedTurnId)});
    return {commandId:params.commandId,status:"accepted",turnId:params.expectedTurnId};
  },
  "turn/interrupt":params=>{setImmediate(()=>complete(params.sessionId,params.turnId,"cancelled"));return {commandId:params.commandId,status:"accepted",turnId:params.turnId}},
};

readline.createInterface({input:process.stdin}).on("line",line=>{
  if(!line.trim())return;
  let frame;try{frame=JSON.parse(line)}catch{return}
  log({frame});
  if(frame.id===undefined||!frame.method)return;
  const answer=answers[frame.method];
  if(!answer)return write({jsonrpc:"2.0",id:frame.id,error:{code:-32601,message:`method not found: ${frame.method}`,data:{kind:"methodNotFound",retryable:false}}});
  try{write({jsonrpc:"2.0",id:frame.id,result:answer(frame.params||{})})}
  catch(error){write({jsonrpc:"2.0",id:frame.id,error:{code:error.code??-32000,message:error.message,data:{kind:error.kind||"internal",retryable:false}}})}
}).on("close",()=>process.exit(0));
