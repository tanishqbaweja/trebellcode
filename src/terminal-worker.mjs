import pty from "node-pty";
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import { readNdjsonLines } from "./ndjson-lines.mjs";
import { listWindowsProcesses, processTree, treeLeft } from "./windows-process-tree.mjs";

const sessions=new Map();
// How long, at most, a project action's programs on its console have from their close event to end, before what is left of its
// process tree is ended.
const GRACE_MS=2000;

// Closes a terminal's pseudo-console on Windows (ClosePseudoConsole), once, through node-pty's own call for it rather than its
// kill. That kill also ended every program on the console about 200 ms later (its console-list agent, a process it forks, which
// a worker without a console would show in a console window of its own) and closed the console's output pipe, so only the program
// attached last got its close event in time. Now each program on the console gets its close event in turn, the last attached first
// (CTRL_CLOSE_EVENT: SIGHUP in Node, SIGTERM in Go, so a docker compose up stops its containers and a server runs its shutdown hook),
// Windows ends one that has not exited 5 s after its event, and the console host goes once they have, also when the worker has
// exited by then. A program started off the console (Notepad, a browser) is not reached and runs on, as when a terminal tab closes.
// The console's output is read until the console host closes it, as ClosePseudoConsole asks, so the terminal's exit comes once the
// programs on it have ended (a Stop answers then, not while a program still runs its shutdown hook), and node-pty's reader for it (a
// worker thread, which stays until it is disposed) goes after that exit. The input pipe is closed too: once the shell has gone
// node-pty no longer closes the console, and its console host stayed until the worker exited.
function closeConsole(term){
  if(term.consoleClosed)return;term.consoleClosed=true;
  const agent=term._agent;
  if(agent?._useConpty===true&&agent._useConptyDll===false&&typeof agent._ptyNative?.kill==="function"){
    try{agent._ptyNative.kill(agent._pty,false)}catch{}
    term.onExit(()=>{try{agent._conoutSocketWorker?.dispose()}catch{}});
  }else try{term.kill()}catch{}
  try{agent?._inSocket?.destroy()}catch{}
}
// Ends a shell with its process tree, as taskkill finds it (/t /f, hidden, at normal priority, waited for up to 5 s): a project
// action's end when its tree could not be listed.
function endTree(pid){
  return new Promise(resolve=>{
    const timer=setTimeout(resolve,5000),done=()=>{clearTimeout(timer);resolve()};
    try{
      const killer=spawn("taskkill",["/pid",String(pid),"/t","/f"],{windowsHide:true,stdio:"ignore"});killer.once("error",done);killer.once("exit",done);
      try{setPriority(killer.pid,constants.priority.PRIORITY_NORMAL)}catch{}
    }catch{done()}
  });
}
let listing=null;
// One process listing serves the terminals that end together (a Quit's), when it started at most 100 ms before.
function sharedListing(){
  if(!listing||Date.now()-listing.at>100){const current={at:Date.now(),rows:listWindowsProcesses({timeoutMs:3000})};listing=current;current.rows.catch(()=>{}).finally(()=>{if(listing===current)listing=null})}
  return listing.rows;
}
const running=pid=>{try{process.kill(pid,0);return true}catch(error){return error.code==="EPERM"}};
// Ends a terminal, once (a later call waits for the same end). Elsewhere than Windows node-pty's kill, a hangup to its shell, ends
// it. On Windows a terminal a person types into (a tab, a sign-in) has its console closed, and nothing more. A terminal that runs
// one command as its own program (endsTree: a project action, a worktree setup) ends all that its command started, also a program it
// started detached, which no console reaches, and one the shell was still starting as it was stopped (on a loaded host): its shell's
// process tree is listed (pids with creation times) while the shell still links it, its console closed, and once the programs on
// the console have ended (the terminal's exit, which comes when they have) or the grace period is over, what of the tree still runs
// is ended (TerminateProcess), with what its programs started since. A pid that a later process got is never ended. A tree that
// cannot be listed (in 3 s) is ended first, as taskkill finds it, and its console closed after, without the close event.
function end(term){
  return term.ending??=(async()=>{
    if(process.platform!=="win32"){try{term.kill()}catch{}return}
    if(!term.endsTree){closeConsole(term);return}
    const exited=new Promise(resolve=>term.onExit(()=>resolve()));
    const rows=await sharedListing().catch(()=>null);
    if(!rows){await endTree(term.pid);closeConsole(term);return}
    const tree=processTree(rows,{pid:term.pid,from:term.startedFrom-1000,to:term.startedTo+1000});
    closeConsole(term);
    let timer=null;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,GRACE_MS)})]);clearTimeout(timer);
    const later=await sharedListing().catch(()=>null);
    for(const row of later?treeLeft(tree,later):tree.filter(row=>running(row.pid)))try{process.kill(row.pid)}catch{}
  })();
}
function send(value){ process.stdout.write(JSON.stringify(value)+"\n"); }
function reply(rid,result){ send({type:"response",rid,ok:true,result}); }
function fail(rid,error){ send({type:"response",rid,ok:false,error:error instanceof Error?error.message:String(error)}); }
function shellSpec(){
  if(process.platform==="win32") return {file:process.env.COMSPEC||"powershell.exe",args:[]};
  return {file:process.env.SHELL||"/bin/bash",args:[]};
}
async function handle(msg){
  const {rid,action}=msg;
  try{
    if(action==="create"){
      const spec=shellSpec();
      const baseEnv=msg.replaceEnv?{}:process.env;
      const startedFrom=Date.now();
      const term=pty.spawn(msg.shell||spec.file,msg.args||spec.args,{
        name:"xterm-256color",cols:msg.cols||120,rows:msg.rows||32,cwd:msg.cwd||process.cwd(),
        env:{...baseEnv,...(msg.env||{}),TERM:"xterm-256color"},
      });
      // When its shell started (it starts within the spawn), so that a later process that gets its pid is not taken for it.
      Object.assign(term,{startedFrom,startedTo:Date.now(),endsTree:Boolean(msg.endsTree)});
      sessions.set(msg.id,term);
      term.onData(data=>send({type:"output",id:msg.id,data}));
      term.onExit(({exitCode,signal})=>{sessions.delete(msg.id);send({type:"exit",id:msg.id,exitCode,signal});});
      reply(rid,{pid:term.pid});
    }else if(action==="write"){
      const term=sessions.get(msg.id); if(!term) throw new Error("Terminal session not found");
      term.write(msg.data||""); reply(rid,{ok:true});
    }else if(action==="resize"){
      const term=sessions.get(msg.id); if(!term) throw new Error("Terminal session not found");
      term.resize(Math.max(2,msg.cols||120),Math.max(2,msg.rows||32)); reply(rid,{ok:true});
    }else if(action==="kill"){
      const term=sessions.get(msg.id); if(term) await end(term); sessions.delete(msg.id); reply(rid,{ok:true});
    }else if(action==="shutdown"){
      await Promise.all([...sessions.values()].map(end));
      sessions.clear(); reply(rid,{ok:true}); setTimeout(()=>process.exit(0),20);
    }else throw new Error("Unknown action");
  }catch(error){ fail(rid,error); }
}
// The server's end of stdin closed: the server is gone (it crashed, or something ended it before its shutdown), so its terminals
// and the programs they run end with it, as on its shutdown, instead of running on with nothing left to stop them (a test run that
// was cut short left a project action's dev server running for a day). On Windows the worker is detached (terminal-manager.mjs), so
// that it outlives a server that dies and gets here. The terminals get up to 2 s to end, 12 s on Windows, where a project action's
// tree is listed and its programs get their grace period first.
function ownerGone(){
  // The server's end of stdout and stderr is gone too: a terminal's exit told to it fails on the closed pipe, which must not end the
  // worker before the other terminals' programs have ended.
  process.stdout.on("error",()=>{});process.stderr.on("error",()=>{});
  const ended=[...sessions.values()].map(term=>Promise.all([new Promise(resolve=>term.onExit(()=>resolve())),end(term)]));
  sessions.clear();
  Promise.race([Promise.all(ended),new Promise(resolve=>setTimeout(resolve,process.platform==="win32"?12000:2000))]).then(()=>process.exit(0));
}
// The server's messages are JSON lines split on "\n" alone: readline also split one at a U+2028 or U+2029 in a person's input, and
// the input went nowhere. Its end, or a failure or close of the pipe, is the server gone.
readNdjsonLines(process.stdin,line=>{
  try{handle(JSON.parse(line));}catch(error){send({type:"workerError",error:String(error)})}
},{onEnd:ownerGone});
