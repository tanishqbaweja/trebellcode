// A stand-in for @opencode/client 2.0.24 that an OpenCode2AgentSession drives through its loadClient option: every call it makes is
// recorded and answered as OpenCode 2.0.24 answers it, overrides[name](input, requestOptions) answers a call in its place, and the event
// stream plays what the test emits. heartbeat() is OpenCode's keepalive, a chunk that carries no event, which the client reports
// through the subscription's onActivity. Polling uses setImmediate, so a test can run on mocked timers.
export const FAKE_OPENCODE2_CLIENT_MODELS=Object.freeze([{providerID:"opencode",id:"big-pickle",name:"Big Pickle",enabled:true,limit:{context:200000},variants:[]}]);
export const flush=()=>new Promise(resolve=>setImmediate(resolve));
export async function eventually(check,{tries=5000,message="condition was not met in time"}={}){
  for(let attempt=0;attempt<tries;attempt++){let value=null;try{value=await check()}catch{}if(value)return value;await flush()}
  throw new Error(message);
}

export function fakeOpenCode2Client({sessions={},overrides={},models=FAKE_OPENCODE2_CLIENT_MODELS}={}){
  const calls=[],queue=[],subscriptions=[];let wake=null;
  const known={ses_main:{id:"ses_main",agent:"build"},...sessions};
  const call=(name,answer)=>async(input,options)=>{calls.push({name,input});if(overrides[name])return overrides[name](input,options);return typeof answer==="function"?answer(input):answer};
  const client={
    server:{info:async options=>{calls.push({name:"server.info",input:null});if(overrides["server.info"])return overrides["server.info"](null,options);return {version:"2.0.24"}}},
    model:{list:call("model.list",{data:models}),default:call("model.default",{data:models[0]||null})},
    command:{list:call("command.list",{data:[]})},skill:{list:call("skill.list",{data:[]})},agent:{list:call("agent.list",{data:[]})},
    mcp:{add:call("mcp.add",undefined)},
    session:{
      create:call("session.create",known.ses_main),
      get:call("session.get",({sessionID})=>{if(known[sessionID])return known[sessionID];throw Object.assign(new Error(`Session not found: ${sessionID}`),{name:"SessionNotFoundError"})}),
      update:call("session.update",undefined),switchModel:call("session.switchModel",undefined),switchAgent:call("session.switchAgent",undefined),
      instructions:{entry:{put:call("session.instructions.entry.put",undefined)}},
      prompt:call("session.prompt",({delivery})=>({id:delivery==="steer"?"msg_steer":"msg_user"})),
      interrupt:call("session.interrupt",{}),synthetic:call("session.synthetic",{}),
      fork:call("session.fork",{id:"ses_fork"}),
      form:{list:call("session.form.list",[]),reply:call("session.form.reply",undefined),cancel:call("session.form.cancel",undefined)},
    },
    message:{list:call("message.list",{data:[]})},
    permission:{list:call("permission.list",[]),reply:call("permission.reply",undefined)},
    // An aborted subscription throws as @opencode/client 2.0.24's sse() does when its read is aborted: its ClientError, Transport.
    event:{subscribe:({signal,onActivity}={})=>{
      const subscription={signal,onActivity};subscriptions.push(subscription);
      return {async*[Symbol.asyncIterator](){
        for(;;){
          if(signal?.aborted)throw Object.assign(new Error("Transport: This operation was aborted"),{name:"ClientError",reason:"Transport"});
          if(queue.length){yield queue.shift();continue}
          await new Promise(resolve=>{wake=resolve;signal?.addEventListener("abort",resolve,{once:true})});
        }
      }};
    }},
  };
  return {
    client,calls,
    loadClient:async()=>({OpenCode:{make:()=>client}}),
    called:name=>calls.filter(entry=>entry.name===name).map(entry=>entry.input),
    emit(event){queue.push({id:`evt_${calls.length}_${queue.length+1}`,created:Date.now(),...event});const next=wake;wake=null;next?.()},
    heartbeat(){for(const subscription of subscriptions)if(!subscription.signal?.aborted)subscription.onActivity?.()},
    // The subscriptions still listening, and every one the session opened.
    listening:()=>subscriptions.filter(subscription=>!subscription.signal?.aborted).length,
    subscriptions:()=>subscriptions.length,
  };
}
