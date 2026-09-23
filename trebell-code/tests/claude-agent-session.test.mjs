import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";

function fakeQueryCapture(calls){
  return ({prompt,options})=>{
    calls.push({prompt,options});
    return {
      async *[Symbol.asyncIterator](){
        yield {type:"system",subtype:"init",session_id:options.sessionId||options.resume,model:"sonnet",models:[],tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]};
        yield {type:"assistant",uuid:"assistant-1",message:{content:[{type:"text",text:"ok"}]}};
        yield {type:"result",subtype:"success",session_id:options.sessionId||options.resume,result:"ok",usage:{}};
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

test("Claude forks materialize lazily through resume plus forkSession in the active runtime",async()=>{
  const calls=[],updates=[];
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:value=>updates.push(value)});
  await session.start({providerSessionId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"});
  const fork=await session.fork();
  const forkSession=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:value=>updates.push(value),forkFromSessionId:fork.lazyFork.sourceSessionId,resumeSessionAt:fork.lazyFork.resumeSessionAt});
  await forkSession.start({providerSessionId:fork.sessionId});
  await forkSession.prompt([{type:"text",text:"continue"}]);
  assert.equal(calls.at(-1).options.resume,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(calls.at(-1).options.forkSession,true);
  assert.equal(calls.at(-1).options.sessionId,fork.sessionId);
  assert.equal(forkSession.forkFromSessionId,null);
  assert.ok(updates.some(item=>item.update?.claudeForkMaterialized?.targetSessionId===fork.sessionId));
});

test("Claude rewind arms a lazy fork at the requested chain entry",async()=>{
  const calls=[];
  const sdk={query:fakeQueryCapture(calls),getSessionInfo:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  const session=new ClaudeAgentSession({cwd:"/repo",sdk});
  await session.start({providerSessionId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"});
  const rewind=await session.rewindConversation("message-kept");
  await session.prompt([{type:"text",text:"redo"}]);
  const options=calls.at(-1).options;
  assert.equal(options.resume,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(options.forkSession,true);
  assert.equal(options.sessionId,rewind.sessionId);
  assert.equal(options.resumeSessionAt,"message-kept");
});
