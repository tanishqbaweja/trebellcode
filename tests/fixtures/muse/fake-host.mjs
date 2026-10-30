import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { readFileSync } from "node:fs";
import { MuseAgentSession } from "../../../src/muse-agent-session.mjs";

// A fake `muse serve` for Muse Code's session tests: a child whose stdio carries MSP frames, driven through Meta's SDK (a real
// Connection), as tests/muse-agent-session.test.mjs drives it. FakeMuse answers each request with its handler and records every frame
// Trebell sends; ReplayMuse replays one of the recorded transcripts in this folder (*.ndjson, MIT, see THIRD_PARTY_NOTICES.md;
// recorded with Muse 1.4.3, whose frames match Muse 1.4.13's stable schema).
const FIXTURES=new URL("./",import.meta.url);
export const INIT=JSON.parse(readFileSync(new URL("initialize-1.4.13.json",FIXTURES),"utf8")).result;
export const settle=()=>new Promise(resolve=>setImmediate(resolve));
// Polls with the real timers, also while a test has Node's mock timers on.
const realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
export async function until(check,label="condition",ms=5000){
  const deadline=Date.now()+ms;
  while(!check()){if(Date.now()>deadline)throw new Error(`timed out waiting for ${label}`);await new Promise(resolve=>realSetTimeout(resolve,5))}
}
// Fails, instead of hanging, when a promise does not settle in time.
export async function settlesWithin(promise,ms,label){
  let timer;
  try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=realSetTimeout(()=>reject(new Error(`${label} did not settle within ${ms} ms`)),ms)})])}
  finally{realClearTimeout(timer)}
}

// A fake host never reaches the real tree stop: its pid, 4242, is no Windows process's either (those are multiples of 4).
export const fakeStop=async target=>{target.exit?.(1)};
export function fakeChild({pid=4242}={}){
  const child=new EventEmitter();
  child.pid=pid;child.exitCode=null;child.signals=[];
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=signal=>{child.signals.push(signal);return true};
  child.exit=(code=0,signal=null)=>{if(child.exitCode!==null)return;child.exitCode=code;child.stdout.end();child.stderr.end();child.emit("exit",code,signal);child.emit("close",code,signal)};
  return child;
}

export const DEFAULT_HANDLERS={
  initialize:()=>INIT,
  "session/start":params=>({session:{sessionId:params.sessionId,status:"idle",activeTurnId:null,workspaceRoot:params.workspaceRoot,providerId:params.providerId,modelId:params.modelId??null,kind:"root"},viewCursor:`v4:${params.sessionId}:1`}),
  "session/resume":params=>({session:{sessionId:params.sessionId,status:"idle",modelId:"muse-spark-1.3"},history:{mode:"none",items:null},pendingRequests:[],viewCursor:`v4:${params.sessionId}:9`}),
  "session/setApprovalMode":params=>({commandId:params.commandId,applyOutcome:"completed"}),
  "turn/start":params=>({commandId:params.commandId,status:"accepted",turnId:params.commandId,startedNewTurn:true,disposition:"started"}),
  "turn/steer":params=>({commandId:params.commandId,status:"accepted",turnId:params.expectedTurnId}),
  "turn/interrupt":params=>({commandId:params.commandId,status:"accepted",turnId:params.turnId}),
  "approval/decide":params=>({commandId:params.commandId,status:"accepted",approvalId:params.approvalId,terminal:true}),
  "userInput/answer":params=>({commandId:params.commandId,status:"accepted",userInputId:params.userInputId}),
  "userInput/cancel":params=>({commandId:params.commandId,status:"accepted",userInputId:params.userInputId}),
};

// A scripted `muse serve`: answers each request with its handler (undefined: no answer; a thrown error: an MSP error with its kind),
// and records every frame Trebell sends.
export class FakeMuse{
  constructor(child,{handlers={},exitOnEof=true}={}){
    this.child=child;this.frames=[];this.taken=new Map();this.waiters=new Set();this.handlers={...DEFAULT_HANDLERS,...handlers};this.stdinEnded=false;
    readline.createInterface({input:child.stdin}).on("line",line=>{if(line.trim())this.#receive(JSON.parse(line))});
    child.stdin.on("end",()=>{this.stdinEnded=true;if(exitOnEof)setImmediate(()=>child.exit(0))});
  }
  #receive(frame){
    this.frames.push(frame);for(const waiter of [...this.waiters])waiter();
    const handler=frame.method&&frame.id!==undefined?this.handlers[frame.method]:null;
    if(handler)Promise.resolve().then(()=>handler(frame.params||{},this)).then(
      result=>{if(result!==undefined)this.write({jsonrpc:"2.0",id:frame.id,result})},
      error=>this.write({jsonrpc:"2.0",id:frame.id,error:{code:error.code??-32000,message:error.message,data:{kind:error.kind||"internal",retryable:false}}}),
    );
  }
  sent(method){return this.frames.filter(frame=>frame.method===method)}
  // The next frame of this method Trebell sends (each call takes the next one).
  next(method){
    return new Promise(resolve=>{
      const look=()=>{const index=this.taken.get(method)||0,list=this.sent(method);if(list.length<=index)return;this.taken.set(method,index+1);this.waiters.delete(look);resolve(list[index])};
      this.waiters.add(look);look();
    });
  }
  write(frame){this.child.stdout.write(JSON.stringify(frame)+"\n")}
  notify(method,params){this.write({jsonrpc:"2.0",method,params})}
}
// An MSP error a handler throws, as Muse answers it ({code, message, data:{kind}}).
export const mspError=(kind,message,code=-32000)=>Object.assign(new Error(message),{code,kind});

// Replays one recorded transcript: each group of frames Trebell sends (in any order within the group) is followed by the
// frames Muse sent then, with the recorded session, turn and command ids replaced by the ones Trebell minted.
export class ReplayMuse{
  constructor(child,name,{exitOnEof=true}={}){
    this.child=child;this.frames=[];this.unexpected=[];this.tokens=new Map();this.turns=0;this.commands=0;this.lastId=null;
    this.steps=readFileSync(new URL(`${name}.ndjson`,FIXTURES),"utf8").split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(step=>step.send||step.emit);
    this.position=0;this.pending=this.#group();
    readline.createInterface({input:child.stdin}).on("line",line=>{if(line.trim())this.#receive(JSON.parse(line))});
    child.stdin.on("end",()=>{if(exitOnEof)setImmediate(()=>child.exit(0))});
  }
  #group(){const sends=[];while(this.position<this.steps.length&&this.steps[this.position].send)sends.push(this.steps[this.position++].send);return sends}
  #receive(frame){
    this.frames.push(frame);
    const params=frame.params||{},method=frame.method||("result" in frame||"error" in frame?"reply":"?");
    if(frame.method==="session/start"){this.tokens.set("$SESSION_COMMAND",params.commandId);this.tokens.set("$SESSION",params.sessionId)}
    else if(frame.method==="turn/start")this.tokens.set("$TURN"+(++this.turns),params.commandId);
    else if(params.commandId)this.tokens.set("$COMMAND"+(++this.commands),params.commandId);
    if(frame.method&&frame.id!==undefined)this.lastId=frame.id;
    const index=this.pending.indexOf(method);
    if(index<0){this.unexpected.push(method);return}
    this.pending.splice(index,1);
    if(this.pending.length)return;
    while(this.position<this.steps.length&&this.steps[this.position].emit)this.child.stdout.write(JSON.stringify(this.#fill(this.steps[this.position++].emit))+"\n");
    this.pending=this.#group();
  }
  #fill(value){
    if(value==="$ID")return this.lastId;
    if(typeof value==="string"){let out=value;for(const [token,id] of [...this.tokens].sort((a,b)=>b[0].length-a[0].length))out=out.split(token).join(id);return out}
    if(Array.isArray(value))return value.map(item=>this.#fill(item));
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.#fill(item)]));
    return value;
  }
  get finished(){return this.position>=this.steps.length&&!this.pending.length}
}

// A session on a fake host. asks: every approval (onPermission) and question (onQuestion) the session asked, each with the answer
// the test gives (answer(request) → a decision, or the answers by question id) or held until the test answers it (answer: null).
export async function startSession({muse=child=>new FakeMuse(child),platform=undefined,cwd=process.cwd(),model=null,providerSessionId=null,permissionMode="supervised",approve=null,reply=null,options={}}={}){
  const child=fakeChild(),fake=muse(child),spawned=[],updates=[],asks=[];
  const ask=(kind,answer)=>request=>{
    let resolve;const answered=new Promise(done=>{resolve=done});
    const entry={kind,request,answered,withdrawn:false,answer:value=>resolve(value)};
    request.signal?.addEventListener("abort",()=>{entry.withdrawn=true;resolve(kind==="approval"?"cancel":{})},{once:true});
    asks.push(entry);
    const given=typeof answer==="function"?answer(request):undefined;if(given!==undefined)resolve(given);
    return answered;
  };
  const session=new MuseAgentSession({command:"muse",cwd,env:{PATH:process.env.PATH||""},version:"1.6.0",permissionMode,...(platform?{platform}:{}),
    spawnFn:(command,args,spawnOptions)=>{spawned.push({command,args,options:spawnOptions});return child},
    onUpdate:params=>updates.push(params.update),onPermission:ask("approval",approve),onQuestion:ask("question",reply),stopTree:fakeStop,...options});
  const started=await session.start({model,providerSessionId});
  return {session,child,muse:fake,spawned,updates,asks,started};
}
export const chunks=(updates,type="agent_message_chunk")=>updates.filter(update=>update.sessionUpdate===type).map(update=>update.content.text).join("");
export const event=(method,sessionId,params)=>({jsonrpc:"2.0",method,params:{sessionId,viewCursor:`v4:${sessionId}:7`,...params}});
export const itemFrame=(method,sessionId,item)=>event(method,sessionId,{item});
