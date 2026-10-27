// A Claude Code thread's MCP servers go to Claude Code over stdin once it runs (setMcpServers), as T3 Code's layerQueryRunner sends
// them, never on its command line (--mcp-config) where other local users can read the env values set for them, and where Claude Code
// exits at startup next to an administrator's managed-mcp.json. A registration that stalls is bounded, and a resumed conversation
// opens once more (T3 Code's 572cf7427).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as claudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";
import { createClaudeRepositoryMcp } from "../src/claude-repository-tools.mjs";
import { HarnessSessionLostError } from "../src/harness-session-lost.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const SOURCE="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TIMED_OUT="Claude Code did not finish connecting this thread's MCP servers within 90 seconds. Send the message again; if it keeps timing out, check the MCP servers in Settings.";
const TOKEN="workspace-token-7f3a91";
const WORKSPACE={type:"stdio",command:"workspace-mcp",args:["--stdio"],env:{WORKSPACE_TOKEN:TOKEN}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let round=0;round<200&&!check();round++)await tick();assert.ok(check(),"the session got there")}
const repositoryMcp=()=>createClaudeRepositoryMcp({contextEngine:{searchSymbols:async()=>({data:[]}),fileRelations:async()=>({})},root:"/repo",version:"fixture"});

// Claude Code's side of the SDK's stdin and stdout, scripted. It answers the SDK's control requests, opens an MCP session with
// Trebell's in-process repository server as Claude Code does with a server it registered, and answers each user message with a
// reply and the result that ends the turn. Each process records its command line, environment, what the SDK wrote to its stdin and
// the server that answered.
function fakeClaudeProcess(spawned){
  return ({command,args,env})=>{
    const events=new EventEmitter(),stdin=new PassThrough(),stdout=new PassThrough(),lines=[],asked=new Map(),run={command,args,env,lines,server:null};
    const child={stdin,stdout,killed:false,exitCode:null,signalCode:null,on:events.on.bind(events),once:events.once.bind(events),off:events.off.bind(events),
      kill(signal){exit(null,signal);child.killed=true;return true}};
    const exit=(code,signal=null)=>{if(child.exitCode!==null)return;child.exitCode=code??0;stdout.end();events.emit("exit",code,signal)};
    spawned.push(run);
    const send=value=>stdout.write(JSON.stringify(value)+"\n");
    let asks=0;
    const askSdk=request=>{const id=`cli-${++asks}`;send({type:"control_request",request_id:id,request});return new Promise(resolve=>asked.set(id,resolve))};
    const answerTurn=async message=>{
      const server="trebell_repository";
      const opened=await askSdk({subtype:"mcp_message",server_name:server,message:{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"fake-claude",version:"0"}}}});
      run.server=opened.response?.mcp_response?.result?.serverInfo?.name||null;
      const sessionId=(args.find(arg=>arg.startsWith("--session-id="))||"").slice("--session-id=".length);
      send({type:"system",subtype:"init",session_id:sessionId,model:"claude-test",permissionMode:"default",tools:[],mcp_servers:[{name:server,status:"connected"},{name:"Workspace tools",status:"connected"}],slash_commands:[],agents:[],capabilities:[]});
      send({type:"assistant",uuid:"assistant-1",parent_tool_use_id:null,message:{id:"msg-1",content:[{type:"text",text:"Done."}]}});
      send(claudeResult(message,{result:"Done."}));
    };
    let buffer="";
    stdin.setEncoding("utf8");
    stdin.on("data",chunk=>{
      buffer+=chunk;let end;
      while((end=buffer.indexOf("\n"))>=0){
        const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;
        const message=JSON.parse(line);lines.push(message);
        if(message.type==="control_response"){asked.get(message.response.request_id)?.(message.response);continue}
        if(message.type==="control_request"){
          const servers=message.request.subtype==="mcp_set_servers"?message.request.servers:null;
          send({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:servers?{added:Object.keys(servers),removed:[],errors:{}}:{commands:[],agents:[],models:[]}}});
        }else if(message.type==="user")void answerTurn(message);
      }
    });
    // Claude Code exits once the SDK ends its input (close()).
    stdin.on("end",()=>exit(0));
    return child;
  };
}

test("Claude Code gets the thread's MCP servers over stdin, never on its command line where other local users can read them",async()=>{
  const spawned=[],repository=await repositoryMcp(),cwd=await mkdtemp(join(tmpdir(),"trebell-claude-mcp-"));
  const claude=new ClaudeAgentSession({cwd,env:{PATH:process.env.PATH||""},sdk:claudeAgentSdk,spawnProcess:fakeClaudeProcess(spawned),onUpdate:()=>{},mcpServers:{trebell_repository:repository,"Workspace tools":WORKSPACE}});
  try{
    await claude.start();
    assert.equal((await claude.prompt([{type:"text",text:"Look around"}])).stopReason,"end_turn");
    assert.equal(spawned.length,1);
    const [{args,env,lines,server}]=spawned;
    assert.equal(args.includes("--mcp-config"),false,"no --mcp-config: the person's servers are not on the command line");
    assert.equal(JSON.stringify(args).includes(TOKEN),false,"nor the token set for one of them");
    assert.equal(JSON.stringify(env).includes(TOKEN),false,"nor in Claude Code's environment");
    const registration=lines.findIndex(line=>line.type==="control_request"&&line.request.subtype==="mcp_set_servers"),prompt=lines.findIndex(line=>line.type==="user");
    assert.ok(registration>=0,"the servers went over stdin");
    assert.deepEqual(lines[registration].request.servers,{trebell_repository:{type:"sdk",name:"trebell_repository"},"Workspace tools":WORKSPACE});
    assert.ok(registration<prompt,"before the first prompt, so its tools are there when the turn starts");
    // Trebell's own repository server, registered the same way, still answers Claude Code in this process.
    assert.equal(server,"trebell_repository");
  }finally{await claude.close();await rm(cwd,{recursive:true,force:true})}
});

test("the query opens without MCP servers and each process gets the whole map before its first prompt, Trebell's own servers in it",async()=>{
  const repository=await repositoryMcp(),{sdk,calls}=scriptedClaudeSdk();
  const claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{},mcpServers:{trebell_repository:repository,"Workspace tools":WORKSPACE}});
  await claude.start();
  await claude.prompt([{type:"text",text:"one"}]);
  claude.setPermissionMode("auto");await claude.prompt([{type:"text",text:"two"}]);
  assert.equal(calls.length,2,"a changed policy opens a new process");
  for(const call of calls){
    assert.equal(Object.prototype.hasOwnProperty.call(call.options,"mcpServers"),false,"nothing for the SDK to put on the command line");
    assert.deepEqual(call.log.map(entry=>entry[0]),["setMcpServers","input"],"registered before the prompt reached Claude Code");
    const servers=call.log[0][1];
    assert.deepEqual(Object.keys(servers),["trebell_repository","Workspace tools"],"setMcpServers replaces the whole set, so every server goes each time");
    assert.equal(servers.trebell_repository.instance,repository.instance,"Trebell's in-process server itself");
    assert.deepEqual(servers["Workspace tools"],WORKSPACE);
  }
  await claude.close();
  // A thread with no MCP servers asks Claude Code nothing more.
  const {sdk:bare,calls:bareCalls}=scriptedClaudeSdk(),plain=new ClaudeAgentSession({cwd:"/repo",sdk:bare,onUpdate:()=>{}});
  await plain.start();await plain.prompt([{type:"text",text:"hi"}]);
  assert.deepEqual(bareCalls[0].log.map(entry=>entry[0]),["input"]);
  await plain.close();
});

test("a resumed conversation whose MCP registration stalls opens once more after the stalled process is closed, and the prompt goes there",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const {sdk:base,calls}=scriptedClaudeSdk({control:{setMcpServers:(servers,call)=>calls.indexOf(call)===0?new Promise(()=>{}):{added:Object.keys(servers),removed:[],errors:{}}}});
  const claude=new ClaudeAgentSession({cwd:"/repo",sdk:{...base,getSessionInfo:async()=>({sessionId:SOURCE})},onUpdate:()=>{},mcpServers:{"Workspace tools":WORKSPACE}});
  await claude.start({providerSessionId:SOURCE});
  const prompting=claude.prompt([{type:"text",text:"Continue"}]);
  await until(()=>calls[0]?.log.length===1);
  t.mock.timers.tick(89_999);await tick();
  assert.equal(calls.length,1,"Claude Code has 90 seconds to connect them");
  t.mock.timers.tick(1);
  await until(()=>calls.length===2);
  assert.equal(calls[0].closed,true,"the stalled process is closed first");
  assert.equal((await prompting).stopReason,"end_turn");
  assert.deepEqual(calls.map(call=>call.options.resume),[SOURCE,SOURCE],"both resume the conversation");
  assert.deepEqual(calls.map(call=>call.inputs.length),[0,1],"the stalled process never took the prompt");
  assert.equal(calls.length,2,"exactly one reopen");
  await claude.close();
});

test("a stalled MCP registration on a new conversation, or a second stall, fails the prompt saying what Claude Code did not finish",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const stalled={control:{setMcpServers:()=>new Promise(()=>{})}};
  // A new conversation's id may already name a transcript the stalled process started, so it is not opened under it again.
  const {sdk,calls}=scriptedClaudeSdk(stalled),fresh=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{},mcpServers:{"Workspace tools":WORKSPACE}});
  await fresh.start();
  const first=fresh.prompt([{type:"text",text:"hi"}]).then(()=>null,error=>error);
  await until(()=>calls[0]?.log.length===1);
  t.mock.timers.tick(90_000);
  const failure=await first;
  assert.equal(failure?.message,TIMED_OUT);
  assert.equal(calls.length,1);assert.equal(calls[0].closed,true);assert.equal(calls[0].inputs.length,0);
  await fresh.close();
  // A resumed one that stalls twice stops after its one reopen.
  const {sdk:base,calls:resumedCalls}=scriptedClaudeSdk(stalled);
  const resumed=new ClaudeAgentSession({cwd:"/repo",sdk:{...base,getSessionInfo:async()=>({sessionId:SOURCE})},onUpdate:()=>{},mcpServers:{"Workspace tools":WORKSPACE}});
  await resumed.start({providerSessionId:SOURCE});
  const second=resumed.prompt([{type:"text",text:"Continue"}]).then(()=>null,error=>error);
  await until(()=>resumedCalls[0]?.log.length===1);
  t.mock.timers.tick(90_000);
  await until(()=>resumedCalls[1]?.log.length===1);
  t.mock.timers.tick(90_000);
  assert.equal((await second)?.message,TIMED_OUT);
  assert.equal(resumedCalls.length,2);assert.ok(resumedCalls.every(call=>call.closed&&!call.inputs.length));
  await resumed.close();
});

// Stop pressed once the 90 s are up, while the stalled process is still closing, finds no process and no turn of the prompt: the
// opening is marked, so no other Claude Code opens and the prompt, which never reached Claude Code, ends cancelled.
for(const resumed of [true,false])test(`Stop while a stalled MCP registration's process closes opens no other process and ends the prompt cancelled (${resumed?"a resumed":"a new"} conversation)`,async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  // The stalled process takes its time to exit: the SDK's return() waits on it.
  const stalling={control:{setMcpServers:(servers,call)=>call.index===0?new Promise(()=>{}):{added:Object.keys(servers),removed:[],errors:{}},return:call=>call.index===0?new Promise(()=>{}):undefined}};
  {
    const {sdk:base,calls}=scriptedClaudeSdk(stalling);
    const sdk={...base,query:(...args)=>{const query=base.query(...args);calls.at(-1).index=calls.length-1;return query},...(resumed?{getSessionInfo:async()=>({sessionId:SOURCE})}:{})};
    const claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{},mcpServers:{"Workspace tools":WORKSPACE}});
    await claude.start(resumed?{providerSessionId:SOURCE}:{});
    const prompting=claude.prompt([{type:"text",text:"Continue"}]).then(result=>result,error=>error);
    await until(()=>calls[0]?.log.length===1);
    t.mock.timers.tick(90_000);
    await until(()=>calls[0].closed);
    await claude.cancel();
    t.mock.timers.tick(5_000);
    const outcome=await prompting;
    assert.equal(outcome?.stopReason,"cancelled",`${resumed?"resumed":"new"}: ${outcome?.message||""}`);
    assert.equal(calls.length,1,`${resumed?"resumed":"new"}: no other Claude Code opened after Stop`);
    assert.equal(calls[0].inputs.length,0,"the prompt never reached Claude Code");
    await claude.close();
  }
});

test("Claude Code that exits while it registers the servers ends the prompt as it would have, a conversation it lost as a lost session",async()=>{
  const lost=new Error(`Claude Code process exited with code 1. stderr: No conversation found with session ID: ${SOURCE}`);
  const {sdk:base}=scriptedClaudeSdk({control:{setMcpServers:(servers,call)=>{call.end(lost);return new Promise(()=>{})}}});
  const claude=new ClaudeAgentSession({cwd:"/repo",sdk:{...base,getSessionInfo:async()=>({sessionId:SOURCE})},onUpdate:()=>{},mcpServers:{"Workspace tools":WORKSPACE}});
  await claude.start({providerSessionId:SOURCE});
  await assert.rejects(claude.prompt([{type:"text",text:"Continue"}]),error=>error instanceof HarnessSessionLostError&&error.sessionId===SOURCE);
  await claude.close();
  // Stop while the servers register ends the prompt cancelled.
  const {sdk:slow,calls}=scriptedClaudeSdk({control:{setMcpServers:()=>new Promise(()=>{})}});
  const stopped=new ClaudeAgentSession({cwd:"/repo",sdk:slow,onUpdate:()=>{},mcpServers:{"Workspace tools":WORKSPACE}});
  await stopped.start();
  const prompting=stopped.prompt([{type:"text",text:"hi"}]);
  await until(()=>calls[0]?.log.length===1);
  await stopped.cancel();
  assert.equal((await prompting).stopReason,"cancelled");
  assert.equal(calls[0].inputs.length,0);
  await stopped.close();
});
