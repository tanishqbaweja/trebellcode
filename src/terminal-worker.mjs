import pty from "node-pty";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";

const sessions=new Map();
// Ends a terminal, once (a later call waits for the same end). On Windows its shell's process tree goes first (taskkill /t /f,
// hidden), while the shell still links it, and then its pseudo-console: closing the pseudo-console ends only the programs attached
// to it then, so a program the shell was still starting (a project action stopped as it starts on a loaded host, or a terminal ended
// with its worker as it opened) missed the close and ran on with its console host, and one started detached never gets it. Elsewhere
// the kill alone ends them.
// taskkill runs at normal priority, since a program started between its look at the tree and its kills escapes it, and the
// pseudo-console closes only once it is done (or after 10 s): taskkill finds a program through the ones that started it, so closing
// the pseudo-console first ended those and left what they had started out of its reach.
// Once the shell has gone, node-pty's kill no longer closes the pseudo-console, and its console host stayed until the worker exited:
// the terminal's input pipe is closed too (node-pty's own end of it), which ends the console host and anything still attached to it.
function end(term){
  return term.ending??=new Promise(resolve=>{
    let done=false,timer=null;const finish=()=>{if(done)return;done=true;clearTimeout(timer);try{term.kill()}catch{}if(process.platform==="win32")try{term._agent?._inSocket?.destroy()}catch{}resolve()};
    if(process.platform!=="win32")return finish();
    timer=setTimeout(finish,10000);
    try{
      const killer=spawn("taskkill",["/pid",String(term.pid),"/t","/f"],{windowsHide:true,stdio:"ignore"});killer.once("error",finish);killer.once("exit",finish);
      try{setPriority(killer.pid,constants.priority.PRIORITY_NORMAL)}catch{}
    }catch{finish()}
  });
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
      const term=pty.spawn(msg.shell||spec.file,msg.args||spec.args,{
        name:"xterm-256color",cols:msg.cols||120,rows:msg.rows||32,cwd:msg.cwd||process.cwd(),
        env:{...baseEnv,...(msg.env||{}),TERM:"xterm-256color"},
      });
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
// was cut short left a project action's dev server running for a day). The terminals get up to 2 s to end, 12 s on Windows, where
// their process trees are ended first.
function ownerGone(){
  // The server's end of stdout is gone too: a terminal's exit told to it fails on the closed pipe, which must not end the worker
  // before the other terminals' programs have ended.
  process.stdout.on("error",()=>{});
  const ended=[...sessions.values()].map(term=>Promise.all([new Promise(resolve=>term.onExit(()=>resolve())),end(term)]));
  sessions.clear();
  Promise.race([Promise.all(ended),new Promise(resolve=>setTimeout(resolve,process.platform==="win32"?12000:2000))]).then(()=>process.exit(0));
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{
  try{handle(JSON.parse(line));}catch(error){send({type:"workerError",error:String(error)})}
}).on("close",ownerGone);
