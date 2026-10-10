import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_BACKGROUND_WORK_BLOCKS_CHANGE,
  CLAUDE_PLAN_CAPTURED,
  ClaudeAgentSession,
  claudeExplainedApiError,
  claudePermissionPrompt,
  claudeQueryPolicy,
  claudeQuestionAnswers,
  claudeResultFailure,
  claudeSessionPermissionUpdates,
  claudeUserContent,
  describeClaudeUsageLimit,
} from "../src/claude-agent-session.mjs";
import { createClaudeRepositoryMcp } from "../src/claude-repository-tools.mjs";

const SOURCE="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// The SDK's Query as the session drives it: an async iterator of CLI messages fed by the streaming-input prompt.
class Channel{
  constructor(){this.items=[];this.waiters=[];this.done=false;this.error=null}
  push(value){if(this.done)return;const waiter=this.waiters.shift();if(waiter)waiter.resolve({value,done:false});else this.items.push(value)}
  end(error=null){if(this.done)return;this.done=true;this.error=error;for(const waiter of this.waiters.splice(0))error?waiter.reject(error):waiter.resolve({value:undefined,done:true})}
  next(){
    if(this.items.length)return Promise.resolve({value:this.items.shift(),done:false});
    if(this.done)return this.error?Promise.reject(this.error):Promise.resolve({value:undefined,done:true});
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
}

// A scripted Claude Code CLI: `turn` runs for every user message the session offers and emits the CLI's messages.
function fakeClaude({turn=replyWith("OK"),init={},sessionExists=true}={}){
  const calls=[];
  const query=({prompt,options})=>{
    const out=new Channel();
    const call={prompt,options,inputs:[],interrupts:0,closed:false,permissionModes:[],out,interrupted:null};
    let interruptNow;call.interrupted=new Promise(resolve=>{interruptNow=resolve});
    calls.push(call);
    const emit=message=>out.push(message);
    (async()=>{
      let index=0,initialized=false,chain=Promise.resolve();
      for await(const message of prompt){
        call.inputs.push(message);
        if(!initialized&&init!==false){initialized=true;emit({type:"system",subtype:"init",session_id:options.sessionId||options.resume,model:"claude-test",permissionMode:options.permissionMode,tools:["Read"],mcp_servers:[],slash_commands:["compact"],agents:["Plan"],capabilities:[],...init})}
        const run=()=>turn({call,message,index:index++,emit,options,out});
        // The running turn takes a "now" message up at once; any other message waits for the turns before it.
        const running=message.priority==="now"?Promise.resolve().then(run):(chain=chain.then(run));
        running.catch(error=>out.end(error));
      }
      await chain.catch(()=>{});
      out.end();
    })();
    return {
      next:()=>out.next(),
      return:()=>{call.closed=true;out.end();return Promise.resolve({value:undefined,done:true})},
      [Symbol.asyncIterator](){return this},
      async interrupt(){call.interrupts++;interruptNow()},
      close(){call.closed=true;out.end()},
      async setPermissionMode(mode){call.permissionModes.push(mode)},
      initializationResult:async()=>({commands:[{name:"review",description:"Review"}],agents:[{name:"Plan",description:"Plans"}],models:[{value:"default",displayName:"Default"}]}),
    };
  };
  const sdk={query,getSessionInfo:async()=>sessionExists?{sessionId:SOURCE}:undefined,forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  return {sdk,calls};
}
function result(message,extra={}){return {type:"result",subtype:"success",is_error:false,result:"OK",user_message_uuid:message.uuid,total_cost_usd:0.01,usage:{input_tokens:3,output_tokens:2},...extra}}
function replyWith(text,{streamed=true}={}){
  return ({message,index,emit})=>{
    const id=`msg-${index}`;
    if(streamed){
      emit({type:"stream_event",parent_tool_use_id:null,event:{type:"message_start",message:{id}}});
      emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_start",index:0,content_block:{type:"text"}}});
      for(const chunk of text.match(/.{1,2}/g)||[])emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:chunk}}});
    }
    emit({type:"assistant",uuid:`assistant-${index}`,parent_tool_use_id:null,message:{id,content:[{type:"text",text}]}});
    if(streamed)emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_stop",index:0}});
    emit(result(message,{result:text}));
  };
}
function session(sdk,options={}){
  const updates=[];
  const value=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:params=>updates.push(params.update),...options});
  value.updates=updates;
  return value;
}
function text(updates){return updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join("")}

test("Claude prompts are SDK user messages with a uuid on one long-lived streaming query",async()=>{
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk);
  await claude.start({providerSessionId:SOURCE});
  const messageId="11111111-1111-4111-8111-111111111111";
  const first=await claude.prompt([{type:"text",text:"Fix the parser"}],{messageId});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].inputs[0],{type:"user",message:{role:"user",content:[{type:"text",text:"Fix the parser"}]},parent_tool_use_id:null,uuid:messageId});
  assert.equal(first.stopReason,"end_turn");assert.equal(first.userMessageId,messageId);assert.equal(first.providerMessageId,"assistant-0");
  const second=await claude.prompt([{type:"text",text:"Again"}]);
  assert.equal(calls.length,1,"the next prompt is offered to the same Claude Code process");
  assert.equal(calls[0].inputs.length,2);assert.equal(second.providerMessageId,"assistant-1");
  assert.notEqual(second.userMessageId,messageId);
  await claude.close();
  assert.equal(calls[0].closed,true);
});

test("Claude refuses a second prompt while one is opening or running, so two prompts never share a turn",async()=>{
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk);await claude.start();
  const first=claude.prompt([{type:"text",text:"one"}]);
  await assert.rejects(()=>claude.prompt([{type:"text",text:"two"}]),/still running a turn/);
  assert.equal((await first).stopReason,"end_turn");
  assert.equal(calls[0].inputs.length,1);
  assert.equal((await claude.prompt([{type:"text",text:"three"}])).stopReason,"end_turn");
  await claude.close();
});

test("Claude query options keep Claude Code's own prompt, settings sources, MCP servers and Trebell's runtime context",async()=>{
  const {sdk,calls}=fakeClaude();
  const mcpServers={"Workspace tools":{type:"stdio",command:"workspace-mcp",args:["--stdio"]}};
  const claude=session(sdk,{mcpServers,autoCompactWindow:300000});
  await claude.start();
  await claude.prompt([{type:"text",text:"hi"}]);
  const options=calls[0].options;
  assert.deepEqual(options.settingSources,["user","project","local"]);
  assert.equal(options.systemPrompt.type,"preset");assert.equal(options.systemPrompt.preset,"claude_code");
  assert.match(options.systemPrompt.append,/Trebell Code/);assert.match(options.systemPrompt.append,/Claude Code harness/);
  assert.deepEqual(options.mcpServers,mcpServers);
  assert.equal(options.settings.autoCompactWindow,300000);
  assert.equal(options.includePartialMessages,true);
  assert.deepEqual(options.thinking,{type:"adaptive",display:"summarized"});
  assert.equal(Object.prototype.hasOwnProperty.call(options,"model"),false,"with no model chosen Claude Code uses its own default");
  assert.equal(Object.prototype.hasOwnProperty.call(options,"effort"),false);
  assert.equal(options.env.CLAUDE_AGENT_SDK_CLIENT_APP,"trebell-code/0.0.0");
});

test("Claude preserves live SDK-hosted MCP server instances",async()=>{
  const {sdk,calls}=fakeClaude(),contextEngine={searchSymbols:async()=>({data:[]}),fileRelations:async()=>({})};
  const repository=createClaudeRepositoryMcp({contextEngine,root:"/repo",version:"fixture"});
  const claude=session(sdk,{mcpServers:{trebell_repository:repository}});
  await claude.start();await claude.prompt([{type:"text",text:"inspect symbols"}]);
  assert.equal(calls[0].options.mcpServers.trebell_repository.instance,repository.instance);
});

test("Claude user content sends images as base64 blocks and keeps the user's text last",()=>{
  const content=claudeUserContent([
    {type:"text",text:"<trebell_context>ctx</trebell_context>"},
    {type:"image",mimeType:"image/png",data:"iVBORw0KGgo="},
    {type:"resource_link",uri:"file://C:/repo/a.js",name:"a.js"},
    {type:"text",text:"/review what is in the picture?"},
  ]);
  assert.deepEqual(content,[
    {type:"image",source:{type:"base64",media_type:"image/png",data:"iVBORw0KGgo="}},
    {type:"text",text:"<trebell_context>ctx</trebell_context>"},
    {type:"text",text:"Attached file: C:/repo/a.js"},
    {type:"text",text:"/review what is in the picture?"},
  ]);
  assert.throws(()=>claudeUserContent([{type:"image",mimeType:"image/bmp",data:"Qk0="}]),/Unsupported Claude image attachment type 'image\/bmp'/);
});

test("Claude model, effort, speed and plan mode reach the query, and a changed policy reopens it",async()=>{
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk,{permissionMode:"full"});
  await claude.start({model:"opus"});
  claude.setReasoningEffort("xhigh");claude.setServiceTier("fast");
  await claude.prompt([{type:"text",text:"one"}]);
  let options=calls[0].options;
  assert.equal(options.model,"opus");assert.equal(options.effort,"xhigh");assert.equal(options.settings.fastMode,true);
  assert.equal(options.permissionMode,"bypassPermissions");assert.equal(options.allowDangerouslySkipPermissions,true);
  claude.setPermissionMode("supervised");
  await claude.prompt([{type:"text",text:"two"}]);
  assert.equal(calls.length,2,"a permission change starts a process with the new mode");
  assert.equal(calls[0].closed,true);
  options=calls[1].options;
  assert.equal(options.permissionMode,"default");assert.equal(options.allowDangerouslySkipPermissions,undefined);
  assert.equal(options.resume,calls[0].options.sessionId,"the new process resumes the same conversation");
  claude.setPermissionMode("edits");await claude.prompt([{type:"text",text:"three"}]);
  assert.equal(calls[2].options.permissionMode,"acceptEdits");
  claude.setCollaborationMode("plan");await claude.prompt([{type:"text",text:"four"}]);
  assert.equal(calls[3].options.permissionMode,"plan");
  claude.setReasoningEffort("bogus");assert.equal(claude.reasoningEffort,null);
  await claude.prompt([{type:"text",text:"five"}]);
  assert.equal(calls.length,5);
  await claude.prompt([{type:"text",text:"six"}]);
  assert.equal(calls.length,5,"an unchanged policy keeps the process");
  await claude.close();
});

test("Claude read-only offers only the read tools, pre-approved, so project allow rules cannot write",()=>{
  assert.deepEqual(claudeQueryPolicy("read-only"),{permissionMode:"dontAsk",tools:["Read","Glob","Grep"],allowedTools:["Read","Glob","Grep"]});
  assert.deepEqual(claudeQueryPolicy("supervised"),{permissionMode:"default",tools:{type:"preset",preset:"claude_code"}});
  assert.deepEqual(claudeQueryPolicy("auto"),{permissionMode:"auto",tools:{type:"preset",preset:"claude_code"}});
  assert.equal(claudeQueryPolicy("full").permissionMode,"bypassPermissions");
  assert.equal(claudeQueryPolicy("edits").permissionMode,"acceptEdits");
  assert.equal(claudeQueryPolicy("full","plan").permissionMode,"plan");
});

test("Claude permission prompts follow Trebell's policy and read-only denials cannot be approved",async()=>{
  const {sdk,calls}=fakeClaude();let approvals=0;
  const edits=session(sdk,{permissionMode:"edits",onPermission:async()=>{approvals++;return "decline"}});
  await edits.start();await edits.prompt([{type:"text",text:"edit"}]);
  const canUse=calls.at(-1).options.canUseTool,toolOptions={toolUseID:"tool-1",suggestions:[]};
  assert.equal((await canUse("Edit",{file_path:"a.js"},toolOptions)).behavior,"allow");
  assert.equal(approvals,0);
  const declined=await canUse("Bash",{command:"echo hi"},toolOptions);
  assert.equal(declined.behavior,"deny");assert.equal(declined.message,"User declined tool execution.");assert.equal(approvals,1);
  const readOnly=session(sdk,{permissionMode:"read-only",onPermission:async()=>{approvals++;return "accept"}});
  await readOnly.start();await readOnly.prompt([{type:"text",text:"look"}]);
  const readCanUse=calls.at(-1).options.canUseTool;
  assert.equal((await readCanUse("Read",{file_path:"a.js"},toolOptions)).behavior,"allow");
  assert.equal((await readCanUse("Write",{file_path:"a.js"},toolOptions)).behavior,"deny");
  assert.equal(approvals,1,"read-only denials never ask");
});

test("a Claude approval prompt says what is approved, as T3 Code's ClaudeAdapter",async()=>{
  assert.equal(claudePermissionPrompt("Bash",{command:"rm -rf build"},{title:"Claude wants to run rm -rf build",displayName:"Run command"}),"Claude wants to run rm -rf build");
  assert.equal(claudePermissionPrompt("PowerShell",{command:"node -e \"console.log('trebell-tour')\""},{displayName:"PowerShell"}),"PowerShell: node -e \"console.log('trebell-tour')\"");
  assert.equal(claudePermissionPrompt("Write",{file_path:"C:\\repo\\notes.txt",content:"hello"},{}),"Write: C:\\repo\\notes.txt");
  // The live tour: Claude Code's sentence for a PowerShell command was the model's description of it, so the card showed no command.
  assert.equal(claudePermissionPrompt("PowerShell",{command:"node -e \"console.log('trebell-tour')\"",description:"Run node one-liner printing trebell-tour"},{description:"Run node one-liner printing trebell-tour"}),
    "PowerShell: node -e \"console.log('trebell-tour')\" — Run node one-liner printing trebell-tour");
  assert.equal(claudePermissionPrompt("Write",{file_path:"C:\\repo\\notes.txt"},{title:"Claude wants to write C:\\repo\\notes.txt"}),"Claude wants to write C:\\repo\\notes.txt");
  assert.equal(claudePermissionPrompt("WebFetch",{url:"https://example.com"},{description:"Claude wants to fetch example.com"}),"Claude wants to fetch example.com");
  assert.equal(claudePermissionPrompt("WebFetch",{url:"https://example.com"},{decisionReason:"Network access needs approval"}),"Network access needs approval");
  assert.equal(claudePermissionPrompt("mcp__docs__search",{query:"x"},{}),'mcp__docs__search: {"query":"x"}');
  assert.equal(claudePermissionPrompt("Tool",{text:"y".repeat(500)},{}).length,"Tool: ".length+400);
  const {sdk,calls}=fakeClaude();const requests=[];
  const claude=session(sdk,{onPermission:async request=>{requests.push(request);return "accept"}});
  await claude.start();await claude.prompt([{type:"text",text:"run it"}]);
  const decision=await calls[0].options.canUseTool("PowerShell",{command:"node -v"},{toolUseID:"tool-1",displayName:"PowerShell",suggestions:[]});
  assert.equal(decision.behavior,"allow");
  assert.equal(requests[0].params.prompt,"PowerShell: node -v","the card shows the command");
  assert.equal(requests[0].params.toolCall.title,"PowerShell","the policy still classifies the tool by its own title");
  await claude.close();
});

test("Claude 'Allow for this session' stays in the session and holds for the thread's later processes",async()=>{
  assert.deepEqual(claudeSessionPermissionUpdates("Bash",[{type:"addRules",rules:[{toolName:"Bash",ruleContent:"npm test"}],behavior:"allow",destination:"localSettings"}]),[
    {type:"addRules",rules:[{toolName:"Bash",ruleContent:"npm test"}],behavior:"allow",destination:"session"},
  ]);
  assert.deepEqual(claudeSessionPermissionUpdates("WebFetch",[]),[{type:"addRules",rules:[{toolName:"WebFetch"}],behavior:"allow",destination:"session"}]);
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk,{onPermission:async()=>"acceptForSession"});
  await claude.start();await claude.prompt([{type:"text",text:"run tests"}]);
  const decision=await calls[0].options.canUseTool("Bash",{command:"npm test"},{toolUseID:"tool-1",suggestions:[{type:"addRules",rules:[{toolName:"Bash",ruleContent:"npm test"}],behavior:"allow",destination:"localSettings"},{type:"addDirectories",directories:["/shared"],destination:"localSettings"}]});
  assert.equal(decision.behavior,"allow");
  assert.ok(decision.updatedPermissions.every(update=>update.destination==="session"),"nothing is written to the project's settings");
  claude.setPermissionMode("auto");await claude.prompt([{type:"text",text:"again"}]);
  assert.deepEqual(calls[1].options.settings.permissions,{allow:["Bash(npm test)"]});
  assert.deepEqual(calls[1].options.additionalDirectories,["/shared"]);
  await claude.close();
});

test("Claude AskUserQuestion answers are keyed by question text with string values, and a cancel denies",async()=>{
  const questions=[{question:"Which color?",header:"Color",options:[{label:"Blue"},{label:"Red"}],multiSelect:false},{question:"Which sizes?",header:"Size",options:[{label:"S"},{label:"M"}],multiSelect:true}];
  assert.deepEqual(claudeQuestionAnswers(questions,{q1:["Blue"],q2:["S","M"]}),{"Which color?":"Blue","Which sizes?":"S, M"});
  assert.deepEqual(claudeQuestionAnswers(questions,{"Which color?":"Red"}),{"Which color?":"Red"});
  assert.equal(claudeQuestionAnswers(questions,{}),null);
  const {sdk,calls}=fakeClaude();let answer={q1:["Blue"],q2:["M"]};
  const claude=session(sdk,{onQuestion:async()=>answer});
  await claude.start();await claude.prompt([{type:"text",text:"ask"}]);
  const canUse=calls[0].options.canUseTool;
  const allowed=await canUse("AskUserQuestion",{questions},{toolUseID:"ask-1"});
  assert.deepEqual(allowed,{behavior:"allow",updatedInput:{questions,answers:{"Which color?":"Blue","Which sizes?":"M"}},toolUseID:"ask-1"});
  answer={};
  assert.deepEqual(await canUse("AskUserQuestion",{questions},{toolUseID:"ask-2"}),{behavior:"deny",message:"User cancelled tool execution.",toolUseID:"ask-2"});
});

test("Claude Stop interrupts the turn, ends the process and records a cancelled turn with its ids",async()=>{
  const {sdk,calls}=fakeClaude({turn:async({call,message,index,emit})=>{
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"message_start",message:{id:`msg-${index}`}}});
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_start",index:0,content_block:{type:"text"}}});
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"1 2 3"}}});
    await call.interrupted;
    emit({type:"result",subtype:"error_during_execution",is_error:true,terminal_reason:"aborted_streaming",errors:["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],user_message_uuid:message.uuid});
  }});
  const claude=session(sdk);
  await claude.start({providerSessionId:SOURCE});
  const running=claude.prompt([{type:"text",text:"count"}]);
  await tick();await tick();
  await claude.cancel();
  const outcome=await running;
  assert.equal(outcome.stopReason,"cancelled");
  assert.ok(outcome.userMessageId);assert.equal(outcome.providerMessageId,outcome.userMessageId,"with no assistant message yet the prompt is the cursor");
  assert.equal(calls[0].interrupts,1);assert.equal(calls[0].closed,true);
  assert.equal(text(claude.updates),"1 2 3","the partial reply stays");
});

test("Claude aborted or interrupted results are cancellations, never errors",async()=>{
  const {sdk}=fakeClaude({turn:({message,emit})=>emit({type:"result",subtype:"error_during_execution",is_error:true,terminal_reason:"aborted_tools",errors:["[ede_diagnostic] x"],user_message_uuid:message.uuid})});
  const claude=session(sdk);await claude.start();
  assert.equal((await claude.prompt([{type:"text",text:"x"}])).stopReason,"cancelled");
  const {sdk:sdk2}=fakeClaude({turn:({message,emit})=>emit({type:"result",subtype:"error_during_execution",is_error:true,errors:["Request was interrupted by the user"],user_message_uuid:message.uuid})});
  const other=session(sdk2);await other.start();
  assert.equal((await other.prompt([{type:"text",text:"x"}])).stopReason,"cancelled");
});

test("Claude errors read like T3 Code's: no SDK wrapper, no diagnostics, no API error streamed as the reply",async()=>{
  assert.equal(claudeResultFailure({subtype:"error_during_execution",errors:["[ede_diagnostic] result_type=user","Real failure"]}),"Real failure");
  assert.equal(claudeResultFailure({subtype:"success",is_error:false,result:"fine"}),null);
  assert.equal(claudeResultFailure({subtype:"success",is_error:true,api_error_status:529,result:"overloaded"}),"Claude API is overloaded (529). Try again shortly.");
  assert.equal(claudeResultFailure({subtype:"success",is_error:true,terminal_reason:"blocking_limit",result:""}),"Claude stopped: a usage limit blocked the request.");
  const apiError="There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.";
  const {sdk}=fakeClaude({turn:({message,emit})=>{
    emit({type:"assistant",uuid:"err-1",parent_tool_use_id:null,error:"model_not_found",message:{id:"m",content:[{type:"text",text:apiError}]}});
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:404,result:apiError,user_message_uuid:message.uuid});
  }});
  const claude=session(sdk);await claude.start();
  const failure=await claude.prompt([{type:"text",text:"x"}]).then(()=>null,error=>error);
  assert.equal(failure.message,apiError);
  assert.equal(text(claude.updates),"","the API error is not shown as Claude's reply");
  assert.ok(failure.userMessageId,"a failed turn that reached the transcript keeps its ids");
  assert.equal(claudeExplainedApiError({error:"server_error",message:{content:[{type:"text",text:"API Error: 500"}]}}),null,"a retried failure keeps T3 Code's wording");
  const {sdk:retried}=fakeClaude({turn:({message,emit})=>{
    emit({type:"assistant",uuid:"err-2",parent_tool_use_id:null,error:"server_error",message:{id:"m",content:[{type:"text",text:"API Error: 500"}]}});
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:500,result:"API Error: 500",user_message_uuid:message.uuid});
  }});
  const gaveUp=session(retried);await gaveUp.start();
  await assert.rejects(()=>gaveUp.prompt([{type:"text",text:"x"}]),error=>error.message==="Claude gave up after repeated API errors.");
  const {sdk:crashing}=fakeClaude({turn:()=>{throw new Error("Claude Code returned an error result: Invalid API key")}});
  const crashed=session(crashing);await crashed.start();
  await assert.rejects(()=>crashed.prompt([{type:"text",text:"x"}]),error=>error.message==="Invalid API key");
});

test("Claude sign-in failures and usage limits get T3 Code's explanations",async()=>{
  const {sdk}=fakeClaude({turn:({message,emit})=>{
    emit({type:"assistant",uuid:"err",parent_tool_use_id:null,error:"authentication_failed",message:{id:"m",content:[{type:"text",text:"Invalid API key"}]}});
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:401,result:"Invalid API key",user_message_uuid:message.uuid});
  }});
  const claude=session(sdk);await claude.start();
  await assert.rejects(()=>claude.prompt([{type:"text",text:"x"}]),/claude auth login/);
  const resetsAt=Math.floor(Date.now()/1000)+90*60;
  assert.match(describeClaudeUsageLimit({rateLimitType:"five_hour",resetsAt},Date.now()),/^Claude usage limit reached\. This turn is paused until the 5-hour limit resets in 1h 3\dm\.$/);
  const {sdk:limited}=fakeClaude({turn:({message,emit})=>{
    emit({type:"rate_limit_event",rate_limit_info:{status:"rejected",rateLimitType:"five_hour",resetsAt}});
    emit({type:"rate_limit_event",rate_limit_info:{status:"rejected",rateLimitType:"five_hour",resetsAt}});
    emit({type:"assistant",uuid:"err",parent_tool_use_id:null,error:"rate_limit",message:{id:"m",content:[{type:"text",text:"limit"}]}});
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:429,result:"limit",user_message_uuid:message.uuid});
  }});
  const capped=session(limited);await capped.start();
  await assert.rejects(()=>capped.prompt([{type:"text",text:"x"}]),/Claude API rate limit reached/);
  const notices=capped.updates.filter(update=>update.sessionUpdate==="tool_call"&&String(update.toolCallId).startsWith("usage-limit:"));
  assert.equal(notices.length,1,"one notice per window and reset");
  assert.match(notices[0].title,/5-hour limit resets in/);
});

test("Claude streams text and summarized thinking as they arrive without repeating them from the final message",async()=>{
  const {sdk}=fakeClaude({turn:({message,emit})=>{
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"message_start",message:{id:"m1"}}});
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_start",index:0,content_block:{type:"thinking"}}});
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_delta",index:0,delta:{type:"thinking_delta",thinking:"Considering"}}});
    emit({type:"assistant",uuid:"a-think",parent_tool_use_id:null,message:{id:"m1",content:[{type:"thinking",thinking:"Considering"}]}});
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_start",index:1,content_block:{type:"text"}}});
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_delta",index:1,delta:{type:"text_delta",text:"Hel"}}});
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_delta",index:1,delta:{type:"text_delta",text:"lo"}}});
    emit({type:"assistant",uuid:"a-text",parent_tool_use_id:null,message:{id:"m1",content:[{type:"text",text:"Hello"}]}});
    emit({type:"stream_event",parent_tool_use_id:"tool-x",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"subagent"}}});
    emit(result(message,{result:"Hello"}));
  }});
  const claude=session(sdk);await claude.start();
  const outcome=await claude.prompt([{type:"text",text:"hi"}]);
  const chunks=claude.updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text);
  assert.deepEqual(chunks,["Hel","lo"]);
  assert.deepEqual(claude.updates.filter(update=>update.sessionUpdate==="agent_thought_chunk").map(update=>update.content.text),["Considering"]);
  assert.equal(outcome.providerMessageId,"a-text");
});

test("Claude offers slash commands and agents before the first message from the capability probe",async()=>{
  const machine={commands:["compact"],agents:["Plan"],models:[]},workspace={commands:[{name:"deploy",description:"Project command"}],agents:[{name:"Explore"}],models:[]};
  const peeks=[],loads=[];let release;
  const capabilities={
    peek:(input,options)=>{peeks.push({cwd:input.cwd,options});return input.cwd===null?machine:null},
    load:input=>{loads.push(input);return new Promise(resolve=>{release=()=>resolve(workspace)})},
  };
  const {sdk}=fakeClaude();
  const claude=session(sdk,{capabilities});
  await claude.start();
  const inventory=()=>claude.updates.filter(update=>update.sessionUpdate==="session_info_update").at(-1);
  assert.deepEqual(inventory().commands,["compact"],"the machine-wide probe shows at once");
  assert.equal(loads[0].cwd,"/repo");assert.equal(loads[0].includeUsage,false);
  release();await tick();
  assert.deepEqual(inventory().commands,[{name:"deploy",description:"Project command"}],"this folder's probe replaces it");
});

test("Claude steering offers a 'now' priority message to the running turn",async()=>{
  let steered;const steeredSeen=new Promise(resolve=>{steered=resolve});
  const {sdk,calls}=fakeClaude({turn:async({message,emit,index})=>{
    if(message.priority==="now"){steered(message);return}
    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"message_start",message:{id:`m${index}`}}});
    const steer=await steeredSeen;
    emit({type:"result",subtype:"error_during_execution",is_error:true,terminal_reason:"aborted_streaming",errors:[],user_message_uuid:message.uuid});
    emit({type:"assistant",uuid:"after-steer",parent_tool_use_id:null,message:{id:"m-steer",content:[{type:"text",text:"Steered"}]}});
    emit({type:"result",subtype:"success",is_error:false,result:"Steered",user_message_uuids:[message.uuid,steer.uuid]});
  }});
  const claude=session(sdk);await claude.start();
  await assert.rejects(()=>claude.steer([{type:"text",text:"nothing running"}]),/no running turn/);
  const running=claude.prompt([{type:"text",text:"start"}]);
  await tick();await tick();
  assert.deepEqual(await claude.steer([{type:"text",text:"use tabs"}]),{accepted:true,pending:0});
  const outcome=await running;
  assert.equal(outcome.stopReason,"end_turn");assert.equal(outcome.providerMessageId,"after-steer");
  const steer=calls[0].inputs.find(item=>item.priority==="now");
  assert.deepEqual(steer.message.content,[{type:"text",text:"use tabs"}]);
  assert.equal(text(claude.updates),"Steered");
});

test("Claude plan mode captures ExitPlanMode as a proposed plan and keeps Claude from implementing it",async()=>{
  const {sdk,calls}=fakeClaude({turn:async({call,message,index,emit,options})=>{
    call.planDecision=await options.canUseTool("ExitPlanMode",{plan:"1. Inspect\n2. Fix"},{toolUseID:"plan-1"});
    await replyWith("Waiting for your go-ahead.")({message,index,emit});
  }});
  const claude=session(sdk);await claude.start();
  claude.setCollaborationMode("plan");
  await claude.prompt([{type:"text",text:"plan it"}]);
  assert.equal(calls[0].options.permissionMode,"plan");
  assert.deepEqual(calls[0].planDecision,{behavior:"deny",message:CLAUDE_PLAN_CAPTURED,toolUseID:"plan-1"});
  assert.deepEqual(claude.updates.find(update=>update.sessionUpdate==="plan_update").plan,{type:"markdown",content:"1. Inspect\n2. Fix"});
  assert.equal(text(claude.updates),"1. Inspect\n2. Fix\n\nWaiting for your go-ahead.","the plan is shown in the reply");
  claude.setCollaborationMode("default");
  await claude.prompt([{type:"text",text:"implement it"}]);
  assert.equal(calls[1].options.permissionMode,"default","leaving plan mode reopens the process in the thread's mode");
  await claude.close();
});

test("Claude threads whose first prompt never ran start their session instead of resuming a missing transcript",async()=>{
  const {sdk,calls}=fakeClaude({sessionExists:false});
  const claude=session(sdk);
  await claude.start({providerSessionId:SOURCE});
  assert.equal(claude.startedOnce,false);
  await claude.prompt([{type:"text",text:"first"}]);
  assert.equal(calls[0].options.sessionId,SOURCE);assert.equal(calls[0].options.resume,undefined);
  const {sdk:existing,calls:resumed}=fakeClaude({sessionExists:true});
  const again=session(existing);await again.start({providerSessionId:SOURCE});
  await again.prompt([{type:"text",text:"next"}]);
  assert.equal(resumed[0].options.resume,SOURCE);assert.equal(resumed[0].options.sessionId,undefined);
  // A thread with turns Claude recorded resumes even when the host has no transcript for it (Claude Code removed an old one):
  // a fresh session would answer without the conversation the thread shows.
  const {sdk:gone,calls:goneCalls}=fakeClaude({sessionExists:false});
  const recorded=session(gone,{persistedTurns:true});await recorded.start({providerSessionId:SOURCE});
  assert.equal(recorded.startedOnce,true);
  await recorded.prompt([{type:"text",text:"continue"}]);
  assert.equal(goneCalls[0].options.resume,SOURCE);assert.equal(goneCalls[0].options.sessionId,undefined);
  // A thread whose turns Claude never recorded still starts its own session.
  const {sdk:unrecorded,calls:unrecordedCalls}=fakeClaude({sessionExists:false});
  const fresh=session(unrecorded,{persistedTurns:false});await fresh.start({providerSessionId:SOURCE});
  await fresh.prompt([{type:"text",text:"first"}]);
  assert.equal(unrecordedCalls[0].options.sessionId,SOURCE);assert.equal(unrecordedCalls[0].options.resume,undefined);
  await Promise.all([claude.close(),again.close(),recorded.close(),fresh.close()]);
});

test("custom or remote Claude homes decide resume from the thread's saved turns, not the host transcript store",async()=>{
  let infoCalls=0,deleteCalls=0;
  const {sdk:base}=fakeClaude();
  const sdk={...base,getSessionInfo:async()=>{infoCalls++;return undefined},deleteSession:async()=>{deleteCalls++}};
  const remote=new ClaudeAgentSession({cwd:"/srv/app",env:{...process.env,CLAUDE_CONFIG_DIR:"/remote/.claude"},spawnProcess:()=>{},sdk,persistedTurns:true});
  await remote.start({providerSessionId:SOURCE});
  assert.equal(infoCalls,0);assert.equal(remote.startedOnce,true);
  const empty=new ClaudeAgentSession({cwd:"/srv/app",env:{...process.env,CLAUDE_CONFIG_DIR:"/remote/.claude"},spawnProcess:()=>{},sdk,persistedTurns:false});
  await empty.start({providerSessionId:SOURCE});
  assert.equal(empty.startedOnce,false);
  await assert.rejects(()=>remote.rename("Remote"),/custom or remote Claude home/);
  await assert.rejects(()=>remote.history(),/custom or remote Claude home/);
  await assert.rejects(()=>remote.delete(),/custom or remote Claude home/);
  assert.equal(deleteCalls,0);
});

test("Claude edit-from-here resumes at the kept turn's cursor in a new session, or starts fresh before the first turn",async()=>{
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk);
  await claude.start({providerSessionId:SOURCE});
  await claude.prompt([{type:"text",text:"one"}]);
  const later=await claude.rewindConversation("assistant-0");
  assert.equal(calls[0].closed,true);
  await claude.prompt([{type:"text",text:"edited two"}]);
  const options=calls[1].options;
  assert.equal(options.resume,SOURCE);assert.equal(options.forkSession,true);assert.equal(options.sessionId,later.sessionId);
  assert.equal(options.resumeSessionAt,"assistant-0");assert.equal(options.resumeDropsTurn,undefined);
  assert.ok(claude.updates.some(update=>update.sessionUpdate==="claude_fork_materialized"&&update.fork.targetSessionId===later.sessionId));
  await claude.prompt([{type:"text",text:"three"}]);
  assert.equal(calls.length,2,"the materialized fork keeps its process");
  const start=await claude.rewindConversation(null);
  assert.equal(start.lazyFork,null);
  await claude.prompt([{type:"text",text:"edited one"}]);
  assert.equal(calls[2].options.sessionId,start.sessionId);assert.equal(calls[2].options.resume,undefined);assert.equal(calls[2].options.forkSession,undefined);
});

test("Claude rewind rejection returns the session to the conversation it left",async()=>{
  const {sdk,calls}=fakeClaude({init:false,turn:({message,emit,options})=>{
    if(options.forkSession){emit({type:"result",subtype:"error_during_execution",is_error:true,errors:["No message found with message.uuid of: gone"]});throw new Error("Claude Code returned an error result: No message found with message.uuid of: gone")}
    emit({type:"system",subtype:"init",session_id:options.sessionId||options.resume});
    replyWith("OK")({message,emit,index:0});
  }});
  const claude=session(sdk);
  await claude.start({providerSessionId:SOURCE});
  await claude.rewindConversation("gone");
  const failure=await claude.prompt([{type:"text",text:"retry"}]).then(()=>null,error=>error);
  assert.equal(failure?.code,"CLAUDE_REWIND_REJECTED");
  assert.equal(failure.message,"No message found with message.uuid of: gone");
  assert.equal(claude.sessionId,SOURCE);assert.equal(claude.startedOnce,true);assert.equal(claude.pendingFork,null);
  await claude.prompt([{type:"text",text:"continue"}]);
  assert.equal(calls.at(-1).options.resume,SOURCE);assert.equal(calls.at(-1).options.forkSession,undefined);
});

test("Claude forks materialize lazily from the source, and a thread with no transcript yet forks fresh",async()=>{
  const {sdk,calls}=fakeClaude();
  const source=session(sdk);await source.start({providerSessionId:SOURCE});
  const fork=await source.fork();
  assert.deepEqual(fork.lazyFork,{sourceSessionId:SOURCE,targetSessionId:fork.sessionId,resumeSessionAt:null});
  const forked=session(sdk,{forkFromSessionId:SOURCE});await forked.start({providerSessionId:fork.sessionId});
  await forked.prompt([{type:"text",text:"continue"}]);
  assert.equal(calls[0].options.resume,SOURCE);assert.equal(calls[0].options.forkSession,true);assert.equal(calls[0].options.sessionId,fork.sessionId);
  assert.equal(forked.pendingFork,null);
  const {sdk:emptySdk}=fakeClaude({sessionExists:false});
  const empty=session(emptySdk);await empty.start({providerSessionId:SOURCE});
  assert.equal((await empty.fork()).lazyFork,null);
});

test("Claude output with no prompt running (finished background work) becomes a wake turn",async()=>{
  const wakes=[];
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk,{onWakeTurn:promise=>wakes.push(promise)});
  await claude.start();await claude.prompt([{type:"text",text:"start a background task"}]);
  calls[0].out.push({type:"assistant",uuid:"wake-1",parent_tool_use_id:null,message:{id:"w",content:[{type:"text",text:"The task finished."}]}});
  calls[0].out.push({type:"result",subtype:"success",is_error:false,result:"The task finished.",origin:{kind:"task-notification"}});
  await tick();await tick();
  assert.equal(wakes.length,1);
  const outcome=await wakes[0];
  assert.equal(outcome.stopReason,"end_turn");assert.equal(outcome.providerMessageId,"wake-1");
});

test("Claude refuses a launch-policy change that would end running background work",async()=>{
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk);await claude.start();await claude.prompt([{type:"text",text:"spawn"}]);
  calls[0].out.push({type:"system",subtype:"background_tasks_changed",tasks:[{task_id:"bg-1",description:"npm run watch"}]});
  await tick();
  claude.setModel("opus");
  await assert.rejects(()=>claude.prompt([{type:"text",text:"switch"}]),error=>error.message===CLAUDE_BACKGROUND_WORK_BLOCKS_CHANGE);
  assert.equal(calls.length,1);
});

test("Claude manual compact sends Claude Code's /compact command through the session",async()=>{
  const {sdk,calls}=fakeClaude();
  const claude=session(sdk);await claude.start({providerSessionId:SOURCE});
  await claude.compact();
  assert.deepEqual(calls[0].inputs[0].message.content,[{type:"text",text:"/compact"}]);
  assert.equal(calls[0].options.resume,SOURCE);
});
