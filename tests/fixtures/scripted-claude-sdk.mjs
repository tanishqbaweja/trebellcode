import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// The Claude Agent SDK as a Claude Code session drives it, scripted: query() returns the Query, an async iterator of the CLI's
// messages fed by the streaming-input prompt. Claude Code reports its session (init) as it takes the first message in, and
// turn({message,index,options,emit,signal,call}) runs for each user message in turn, a "now" message at once as Claude Code takes a
// steer into the running turn; signal aborts once the query closes (Stop, close). init adds to the init frame (or is a function of
// the options); control answers the Query's control requests by name (setMcpServers, setPermissionMode, backgroundTasks, and
// getContextUsage, which a Query without control.getContextUsage lacks, as an older SDK does), and
// control.return(call) is what the Query's return() waits on (the SDK waits there for the CLI to exit). Each call logs its inputs and
// control requests in order; call.emit sends a frame of its own and call.end(error) ends the stream, as a CLI that exits. With spawn,
// each Query starts its process as the SDK does (call.child); fakeClaudeChildren gives a session's spawnChild such processes.
export function scriptedClaudeSdk({turn=({message,emit})=>emit(claudeResult(message)),init=null,control={},spawn=false}={}){
  const calls=[];
  const query=({prompt,options})=>{
    const items=[],waiters=[],stop=new AbortController(),call={options,inputs:[],log:[],closed:false,index:calls.length};let done=false,failure=null;
    calls.push(call);
    // spawn: the Query starts its Claude Code through options.spawnClaudeCodeProcess, as the SDK does, and ends its stdin once closed.
    call.child=spawn?options.spawnClaudeCodeProcess?.({command:"claude",args:["--output-format","stream-json"],cwd:options.cwd,env:options.env||{},signal:stop.signal})||null:null;
    const emit=value=>{if(done)return;const waiter=waiters.shift();if(waiter)waiter.resolve({value,done:false});else items.push(value)};
    const end=(error=null)=>{if(done)return;done=true;failure=error;stop.abort();try{call.child?.stdin?.end?.()}catch{}for(const waiter of waiters.splice(0))error?waiter.reject(error):waiter.resolve({value:undefined,done:true})};
    call.emit=emit;call.end=end;
    void (async()=>{
      let index=0,chain=Promise.resolve();
      for await(const message of prompt){
        call.inputs.push(message);call.log.push(["input",message]);
        if(index===0)emit({type:"system",subtype:"init",session_id:options.sessionId||options.resume,model:"claude-test",permissionMode:options.permissionMode,tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[],...(typeof init==="function"?init(options):init)});
        const position=index++,run=()=>turn({message,index:position,options,emit,signal:stop.signal,call});
        (message.priority==="now"?Promise.resolve().then(run):(chain=chain.then(run))).catch(()=>end());
      }
      await chain.catch(()=>{});
      end();
    })();
    const answer=(name,args,otherwise)=>{call.log.push([name,...args]);return control[name]?control[name](...args,call):otherwise};
    return {
      next:()=>items.length?Promise.resolve({value:items.shift(),done:false}):done?(failure?Promise.reject(failure):Promise.resolve({value:undefined,done:true})):new Promise((resolve,reject)=>waiters.push({resolve,reject})),
      return:()=>{call.closed=true;end();return Promise.resolve(control.return?.(call)).then(()=>({value:undefined,done:true}))},
      [Symbol.asyncIterator](){return this},
      async interrupt(){},close(){call.closed=true;end()},
      async setPermissionMode(mode){return answer("setPermissionMode",[mode],undefined)},
      async setMcpServers(servers){return answer("setMcpServers",[servers],{added:Object.keys(servers),removed:[],errors:{}})},
      async backgroundTasks(toolUseId){return answer("backgroundTasks",[toolUseId],true)},
      initializationResult:async()=>({commands:[],agents:[],models:[]}),
      ...(control.getContextUsage?{async getContextUsage(options){return answer("getContextUsage",[options],undefined)}}:{}),
    };
  };
  const sdk={query,getSessionInfo:async()=>undefined,forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  return {sdk,calls};
}

// The result Claude Code ends a turn with, answering the user message it ran.
export function claudeResult(message,extra={}){
  return {type:"result",subtype:"success",is_error:false,result:"OK",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1},...extra};
}

// Claude Code processes as node's spawn starts them, for a session's spawnChild: each records how it was started and the signals it was
// sent, writes stderr (stderr: text written before it exits) and exits once its stdin ends (exitsOnStdinEnd) or a kill reaches it
// (exitsOnKill), with code (exitCode). A process that does neither stays running, as a stuck Claude Code does.
export function fakeClaudeChildren({exitsOnStdinEnd=true,exitsOnKill=true,exitCode=0,stderr=""}={}){
  const children=[];
  const spawnChild=(command,args,options)=>{
    const child=new EventEmitter();
    Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,exitCode:null,signalCode:null,started:{command,args,options},signals:[]});
    child.exit=(code=exitCode,signal=null)=>{
      if(child.exitCode!==null||child.signalCode!==null)return;
      if(stderr)child.stderr.write(stderr);
      child.stderr.end();child.stdout.end();child.exitCode=signal?null:code;child.signalCode=signal;child.emit("exit",child.exitCode,signal);
    };
    child.kill=signal=>{child.signals.push(signal);child.killed=true;if(exitsOnKill)setImmediate(()=>child.exit(null,signal||"SIGTERM"));return true};
    child.stdin.on("finish",()=>{if(exitsOnStdinEnd)setImmediate(()=>child.exit())});
    child.stdin.resume();
    children.push(child);return child;
  };
  return {spawnChild,children};
}
