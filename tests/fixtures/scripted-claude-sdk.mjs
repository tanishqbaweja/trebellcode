// The Claude Agent SDK as a Claude Code session drives it, scripted: query() returns the Query, an async iterator of the CLI's
// messages fed by the streaming-input prompt. Claude Code reports its session (init) as it takes the first message in, and
// turn({message,index,options,emit,signal}) runs for each user message in turn; signal aborts once the query closes (Stop, close).
export function scriptedClaudeSdk({turn=({message,emit})=>emit(claudeResult(message))}={}){
  const calls=[];
  const query=({prompt,options})=>{
    const items=[],waiters=[],stop=new AbortController(),call={options,inputs:[],closed:false};let done=false;
    calls.push(call);
    const emit=value=>{if(done)return;const waiter=waiters.shift();if(waiter)waiter({value,done:false});else items.push(value)};
    const end=()=>{if(done)return;done=true;stop.abort();for(const waiter of waiters.splice(0))waiter({value:undefined,done:true})};
    void (async()=>{
      let index=0;
      for await(const message of prompt){
        call.inputs.push(message);
        if(index===0)emit({type:"system",subtype:"init",session_id:options.sessionId||options.resume,model:"claude-test",permissionMode:options.permissionMode,tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]});
        try{await turn({message,index:index++,options,emit,signal:stop.signal})}catch{end();return}
      }
      end();
    })();
    return {
      next:()=>items.length?Promise.resolve({value:items.shift(),done:false}):done?Promise.resolve({value:undefined,done:true}):new Promise(resolve=>waiters.push(resolve)),
      return:()=>{call.closed=true;end();return Promise.resolve({value:undefined,done:true})},
      [Symbol.asyncIterator](){return this},
      async interrupt(){},close(){call.closed=true;end()},async setPermissionMode(){},
      initializationResult:async()=>({commands:[],agents:[],models:[]}),
    };
  };
  const sdk={query,getSessionInfo:async()=>undefined,forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  return {sdk,calls};
}

// The result Claude Code ends a turn with, answering the user message it ran.
export function claudeResult(message,extra={}){
  return {type:"result",subtype:"success",is_error:false,result:"OK",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1},...extra};
}
