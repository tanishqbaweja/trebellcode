import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";
import { createClaudeRepositoryMcp } from "../src/claude-repository-tools.mjs";

function fakeQueryCapture(calls){
  return ({prompt,options})=>{
    calls.push({prompt,options});
    return {
      async *[Symbol.asyncIterator](){
        yield {type:"system",subtype:"init",session_id:options.sessionId||options.resume,model:"sonnet",models:[],tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]};
        yield {type:"assistant",uuid:"assistant-1",message:{content:[{type:"text",text:"ok"}]}};
        yield {type:"user",uuid:"tool-result-1",parent_tool_use_id:null,message:{content:[{type:"tool_result",tool_use_id:"tool-1",content:"done"}]}};
        yield {type:"assistant",uuid:"assistant-final",message:{content:[{type:"text",text:"done"}]}};
        yield {type:"result",subtype:"success",session_id:options.sessionId||options.resume,result:"ok",usage:{},user_message_uuid:"prompt-1"};
      },
      async setModel(){},async interrupt(){},close(){},
    };
  };
}

test("custom or remote Claude continuation defers host-side transcript validation",async()=>{
  let infoCalls=0,deleteCalls=0;
  const sdk={query:fakeQueryCapture([]),getSessionInfo:async()=>{infoCalls++;return undefined},renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{deleteCalls++}};
  const session=new ClaudeAgentSession({cwd:"/srv/app",env:{...process.env,CLAUDE_CONFIG_DIR:"/remote/.claude"},spawnProcess:()=>{},sdk});
  await session.start({providerSessionId:"12345678-1234-4abc-8123-123456789abc"});
  assert.equal(infoCalls,0);
  assert.equal(session.startedOnce,true);
  await assert.rejects(()=>session.rename("Remote"),/custom or remote Claude home/);
  await assert.rejects(()=>session.history(),/custom or remote Claude home/);
  await assert.rejects(()=>session.delete(),/custom or remote Claude home/);
  assert.equal(deleteCalls,0);
});

test("Claude auto-compact threshold is forwarded to the SDK query",async()=>{
  const calls=[];
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,autoCompactWindow:300000});
  await session.start();
  await session.prompt([{type:"text",text:"keep context tidy"}]);
  assert.equal(calls.at(-1).options.autoCompactWindow,300000);
});

test("Claude MCP servers are forwarded to every SDK query",async()=>{
  const calls=[];
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const mcpServers={"Workspace tools":{type:"stdio",command:"workspace-mcp",args:["--stdio"],env:{TOKEN:"secret"}}};
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,mcpServers});
  await session.start();
  await session.prompt([{type:"text",text:"use repository tools"}]);
  assert.deepEqual(calls.at(-1).options.mcpServers,mcpServers);
});

test("Claude preserves live SDK-hosted MCP server instances",async()=>{
  const calls=[],contextEngine={searchSymbols:async()=>({data:[]}),fileRelations:async()=>({})};
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const repository=createClaudeRepositoryMcp({contextEngine,root:"/repo",version:"fixture"});
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,mcpServers:{trebell_repository:repository}});
  await session.start();await session.prompt([{type:"text",text:"inspect symbols"}]);
  assert.equal(calls.at(-1).options.mcpServers.trebell_repository.instance,repository.instance);
});

test("Claude manual compact sends the native compact command through the active session",async()=>{
  const calls=[];
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const session=new ClaudeAgentSession({cwd:"/repo",sdk});
  await session.start({providerSessionId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"});
  await session.compact();
  assert.equal(calls.at(-1).prompt,"/compact");
  assert.equal(calls.at(-1).options.resume,"dddddddd-dddd-4ddd-8ddd-dddddddddddd");
});

test("Claude forks materialize lazily through resume plus forkSession in the active runtime",async()=>{
  const calls=[],updates=[];
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:value=>updates.push(value)});
  await session.start({providerSessionId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"});
  const fork=await session.fork();
  const forkSession=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:value=>updates.push(value),forkFromSessionId:fork.lazyFork.sourceSessionId,resumeSessionAt:fork.lazyFork.resumeSessionAt});
  await forkSession.start({providerSessionId:fork.sessionId});
  const result=await forkSession.prompt([{type:"text",text:"continue"}]);
  assert.equal(calls.at(-1).options.resume,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(calls.at(-1).options.forkSession,true);
  assert.equal(calls.at(-1).options.sessionId,fork.sessionId);
  assert.equal(result.providerMessageId,"assistant-final");
  assert.equal(result.userMessageId,"prompt-1");
  assert.equal(forkSession.forkFromSessionId,null);
  assert.ok(updates.some(item=>item.update?.sessionUpdate==="claude_fork_materialized"&&item.update?.fork?.targetSessionId===fork.sessionId));
});

test("Claude rewind arms a validated lazy fork at the requested chain entry",async()=>{
  const calls=[];
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const session=new ClaudeAgentSession({cwd:"/repo",sdk});
  await session.start({providerSessionId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"});
  const rewind=await session.rewindConversation("message-kept",{dropsTurn:"prompt-removed"});
  await session.prompt([{type:"text",text:"redo"}]);
  const options=calls.at(-1).options;
  assert.equal(options.resume,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(options.forkSession,true);
  assert.equal(options.sessionId,rewind.sessionId);
  assert.equal(options.resumeSessionAt,"message-kept");
  assert.equal(options.resumeDropsTurn,"prompt-removed");
});

test("Claude rewind rejection returns the session to its original continuation",async()=>{
  const calls=[];
  const sdk={
    query:({prompt,options})=>{
      calls.push({prompt,options});
      return {
        async *[Symbol.asyncIterator](){
          yield {type:"system",subtype:"init",session_id:options.sessionId,model:"sonnet",models:[],tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]};
          yield {type:"result",subtype:"error_during_execution",session_id:options.sessionId,errors:["Resume rejected by --resume-drops-turn: transcript changed"],usage:{}};
        },
        async setModel(){},async interrupt(){},close(){},
      };
    },
    getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{},
  };
  const source="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const session=new ClaudeAgentSession({cwd:"/repo",sdk});
  await session.start({providerSessionId:source});
  await session.rewindConversation("kept-entry",{dropsTurn:"removed-prompt"});
  let failure=null;try{await session.prompt([{type:"text",text:"retry"}])}catch(error){failure=error}
  assert.equal(failure?.code,"CLAUDE_REWIND_REJECTED");
  assert.equal(session.sessionId,source);
  assert.equal(session.startedOnce,true);
  assert.equal(session.forkFromSessionId,null);
  assert.equal(calls.at(-1).options.resumeDropsTurn,"removed-prompt");
});
