import pty from "node-pty";
import readline from "node:readline";

const sessions=new Map();
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
      const term=sessions.get(msg.id); if(term) term.kill(); sessions.delete(msg.id); reply(rid,{ok:true});
    }else if(action==="shutdown"){
      for(const term of sessions.values()) try{term.kill();}catch{}
      sessions.clear(); reply(rid,{ok:true}); setTimeout(()=>process.exit(0),20);
    }else throw new Error("Unknown action");
  }catch(error){ fail(rid,error); }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{
  try{handle(JSON.parse(line));}catch(error){send({type:"workerError",error:String(error)})}
});
