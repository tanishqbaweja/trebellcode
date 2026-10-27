// What Claude Code still forwards to Trebell's canUseTool in Full access, in Plan mode or for an ask rule goes to the person with
// Claude's own reason (T3 Code's requiresClaudeApproval): nothing Claude Code asked about is approved for them by Trebell's policy.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const DANGEROUS_RM="\u001b[33mDangerous rm on a path built from a variable\u001b[39m";
const GIT_PUSH_RULE={source:"userSettings",toolName:"Bash",ruleContent:"git push:*"};

// A Claude session on a scripted SDK whose answers onPermission gives in turn; requests lists what the person was asked.
async function claudeSession({permissionMode,collaborationMode="default",answers=["accept"]}={}){
  const {sdk,calls}=scriptedClaudeSdk(),requests=[];
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,permissionMode,onUpdate:()=>{},onPermission:async request=>{requests.push(request);return answers.shift()??"decline"}});
  await session.start();session.setCollaborationMode(collaborationMode);
  await session.prompt([{type:"text",text:"go"}]);
  return {session,calls,requests,canUse:(...args)=>calls.at(-1).options.canUseTool(...args)};
}

test("in Full access a request Claude Code forwards goes to the person with Claude's reason, and their answer decides it",async()=>{
  const {session,requests,canUse}=await claudeSession({permissionMode:"full",answers:["decline","accept"]});
  const options={toolUseID:"tool-1",title:"Claude wants to run rm -rf ~/x",decisionReason:DANGEROUS_RM,suggestions:[]};
  const declined=await canUse("Bash",{command:"rm -rf ~/x"},options);
  assert.equal(requests.length,1,"the person is asked, not Trebell's Full access policy");
  assert.equal(requests[0].askUser,true,"the relay does not accept it for the thread's Full access either");
  assert.equal(requests[0].params.prompt,"Claude Code asks even in Full access: Claude wants to run rm -rf ~/x (Dangerous rm on a path built from a variable)");
  assert.deepEqual([declined.behavior,declined.message],["deny","User declined tool execution."]);
  const allowed=await canUse("Bash",{command:"rm -rf ~/x"},{...options,toolUseID:"tool-2"});
  assert.deepEqual([allowed.behavior,allowed.updatedInput,allowed.decisionClassification],["allow",{command:"rm -rf ~/x"},"user_temporary"]);
  assert.equal(requests.length,2);
  await session.close();
});

test("Plan mode asks before a write in Full access and in Auto, and an ask rule asks in any mode",async()=>{
  for(const permissionMode of ["full","auto","edits"]){
    const {session,requests,canUse}=await claudeSession({permissionMode,collaborationMode:"plan"});
    assert.equal(session.live.openedPermissionMode,"plan");
    const decision=await canUse("Edit",{file_path:"/repo/a.js",old_string:"a",new_string:"b"},{toolUseID:"edit-1",suggestions:[]});
    assert.equal(decision.behavior,"allow");
    assert.equal(requests.length,1,`Plan mode in ${permissionMode} asks before the edit`);assert.equal(requests[0].askUser,true);
    // Plan mode asks, whatever the profile: the card says so, not that Full access was overruled.
    assert.equal(requests[0].params.prompt,"Claude Code asks in Plan mode: Edit: /repo/a.js");
    await session.close();
  }
  // Claude can switch itself to Plan (EnterPlanMode): a Full access process it left there asks for Plan mode too.
  const {sdk:planning,calls:planned}=scriptedClaudeSdk({turn:({message,emit})=>{emit({type:"system",subtype:"status",status:null,permissionMode:"plan"});emit(claudeResult(message))}});
  const asked=[],full=new ClaudeAgentSession({cwd:"/repo",sdk:planning,permissionMode:"full",onUpdate:()=>{},onPermission:async request=>{asked.push(request);return "accept"}});
  await full.start();await full.prompt([{type:"text",text:"Look first"}]);
  assert.equal(full.live.permissionMode,"plan");
  await planned.at(-1).options.canUseTool("Write",{file_path:"/repo/b.js",content:"x"},{toolUseID:"write-1",suggestions:[]});
  assert.equal(asked[0].params.prompt,"Claude Code asks in Plan mode: Write: /repo/b.js");
  await full.close();
  const {session,requests,canUse}=await claudeSession({permissionMode:"auto"});
  const pushed=await canUse("Bash",{command:"git push origin main"},{toolUseID:"push-1",matchedAskRule:GIT_PUSH_RULE,suggestions:[]});
  assert.equal(pushed.behavior,"allow");
  assert.equal(requests.length,1,"Auto asks what the person's own ask rule asks for");assert.equal(requests[0].askUser,true);
  assert.equal(requests[0].params.prompt,"Claude Code asks, as its ask rule Bash(git push:*) says: Bash: git push origin main");
  // Auto still runs what no ask rule or plan mode holds back, as before.
  assert.equal((await canUse("Bash",{command:"npm test"},{toolUseID:"test-1",suggestions:[]})).behavior,"allow");
  assert.equal(requests.length,1);
  await session.close();
});

// An administrator's disableBypassPermissionsMode: Claude Code opens a Full access thread in a lower mode and says so at init, and asks
// for what that mode holds back. The card names the mode it runs in, not Full access, which it does not run in.
test("a Full access thread whose Claude Code runs in another mode names that mode on the card, not Full access",async()=>{
  const asked=async sdk=>{
    const requests=[],session=new ClaudeAgentSession({cwd:"/repo",sdk:sdk.sdk,permissionMode:"full",onUpdate:()=>{},onPermission:async request=>{requests.push(request);return "accept"}});
    await session.start();await session.prompt([{type:"text",text:"go"}]);
    return {session,requests,canUse:(...args)=>sdk.calls.at(-1).options.canUseTool(...args)};
  };
  const edit=[{file_path:"/repo/a.js",old_string:"a",new_string:"b"},{toolUseID:"edit-1",suggestions:[]}];
  {
    const {session,requests,canUse}=await asked(scriptedClaudeSdk({init:{permissionMode:"default"}}));
    assert.equal(session.live.permissionMode,"default");
    assert.equal((await canUse("Edit",...edit)).behavior,"allow");
    assert.equal(requests[0].askUser,true,"asked, not allowed for the thread's Full access");
    assert.equal(requests[0].params.prompt,"Claude Code asks, as it runs in Supervised mode, not Full access: Edit: /repo/a.js");
    await canUse("Bash",{command:"git push origin main"},{toolUseID:"push-1",matchedAskRule:GIT_PUSH_RULE,suggestions:[]});
    assert.equal(requests[1].params.prompt,"Claude Code asks, as its ask rule Bash(git push:*) says: Bash: git push origin main");
    await session.close();
  }
  // Full access Claude Code could not take back after Plan (bypass turned off since the process opened) runs in Supervised too.
  {
    const sdk=scriptedClaudeSdk({turn:({message,index,emit})=>{if(index===0)emit({type:"system",subtype:"status",status:null,permissionMode:"plan"});emit(claudeResult(message))},control:{setPermissionMode:mode=>{if(mode==="bypassPermissions")throw new Error("Bypass permissions mode is disabled")}}});
    const {session,requests,canUse}=await asked(sdk);
    await session.prompt([{type:"text",text:"Now fix it"}]);
    assert.equal(session.live.permissionMode,"default");
    await canUse("Edit",...edit);
    assert.equal(requests[0].params.prompt,"Claude Code asks, as it runs in Supervised mode, not Full access: Edit: /repo/a.js");
    await session.close();
  }
  // Where Claude Code runs in Full access, the card still says it asks even there.
  const {session,requests,canUse}=await asked(scriptedClaudeSdk());
  await canUse("Edit",...edit);
  assert.equal(requests[0].params.prompt,"Claude Code asks even in Full access: Edit: /repo/a.js");
  await session.close();
});

test("a request Claude Code wants decided once offers no session choice, and an answer for the session allows it once",async()=>{
  for(const flag of ["suppressAlwaysAllowRule","defaultToNo"]){
    const {session,calls,requests,canUse}=await claudeSession({permissionMode:"full",answers:["acceptForSession"]});
    const decision=await canUse("Bash",{command:"rm -r -- \"$rr/$h\""},{toolUseID:"rm-1",[flag]:true,decisionReason:DANGEROUS_RM,suggestions:[{type:"addRules",rules:[{toolName:"Bash"}],behavior:"allow",destination:"localSettings"}]});
    assert.deepEqual(requests[0].approvalOptions,[{decision:"decline",label:"Deny"},{decision:"accept",label:"Allow once"}],`${flag}: only Deny and Allow once`);
    assert.deepEqual(requests[0].options.map(option=>option.optionId),["allow_once","reject_once"]);
    assert.equal(decision.behavior,"allow");assert.equal(decision.decisionClassification,"user_temporary");assert.equal(decision.updatedPermissions,undefined);
    session.setPermissionMode("auto");await session.prompt([{type:"text",text:"again"}]);
    assert.equal(calls.at(-1).options.settings.permissions,undefined,"no session rule allows every Bash command afterwards");
    await session.close();
  }
  // An ordinary request keeps its session choice and Trebell's own buttons.
  const {session,requests,canUse}=await claudeSession({permissionMode:"full"});
  await canUse("Bash",{command:"git push"},{toolUseID:"push-1",matchedAskRule:GIT_PUSH_RULE,suggestions:[]});
  assert.equal(requests[0].approvalOptions,undefined);
  assert.deepEqual(requests[0].options.map(option=>option.optionId),["allow_once","allow_always","reject_once"]);
  assert.equal(requests[0].params.prompt,"Claude Code asks even in Full access, as its ask rule Bash(git push:*) says: Bash: git push");
  await session.close();
});

// The session choice Claude Code wants left out is left out wherever the person is asked: Supervised and Auto-accept edits asked about
// such a request before Full access did, and offered "Allow for this session" for it.
test("outside Full access too, a request Claude Code wants decided once offers no session choice, and an answer for the session allows it once",async()=>{
  const rm={command:"rm -r -- \"$rr/$h\""},edit={file_path:"/repo/a.js",old_string:"a",new_string:"b"};
  for(const [permissionMode,toolName,input] of [["supervised","Bash",rm],["edits","Bash",rm],["supervised","Edit",edit]])for(const flag of ["suppressAlwaysAllowRule","defaultToNo"]){
    const {session,requests,canUse}=await claudeSession({permissionMode,answers:["acceptForSession"]});
    const decision=await canUse(toolName,input,{toolUseID:"once-1",[flag]:true,decisionReason:DANGEROUS_RM,suggestions:[{type:"addRules",rules:[{toolName}],behavior:"allow",destination:"localSettings"}]});
    const label=`${permissionMode} ${toolName} ${flag}`;
    assert.equal(requests.length,1,label);
    assert.deepEqual(requests[0].options.map(option=>option.optionId),["allow_once","reject_once"],`${label}: no Allow for this session`);
    assert.deepEqual(requests[0].approvalOptions,[{decision:"decline",label:"Deny"},{decision:"accept",label:"Allow once"}],`${label}: only Deny and Allow once`);
    assert.deepEqual([decision.behavior,decision.decisionClassification,decision.updatedPermissions],["allow","user_temporary",undefined],`${label}: allowed once`);
    await session.close();
  }
});

test("read-only still denies what it denies, whatever Claude Code asks or plan mode",async()=>{
  for(const collaborationMode of ["default","plan"]){
    const {session,requests,canUse}=await claudeSession({permissionMode:"read-only",collaborationMode});
    const denied=await canUse("Write",{file_path:"/repo/a.js",content:"x"},{toolUseID:"write-1",matchedAskRule:{source:"userSettings",toolName:"Write"},suggestions:[]});
    assert.deepEqual([denied.behavior,denied.message],["deny","Trebell read-only mode denied this tool."]);
    assert.equal(requests.length,0,"a denial is never put to the person");
    await session.close();
  }
});

// The real relay with a scripted Claude Code: the window that sent the turn is asked, as a person sees the card.
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
function client(url){
  const ws=new WebSocket(url),messages=[],waiters=[];let id=0;
  ws.on("message",raw=>{const message=JSON.parse(String(raw));messages.push(message);for(const waiter of [...waiters])if(waiter.match(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message)}});
  const next=match=>{const seen=messages.find(match);if(seen)return Promise.resolve(seen);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("timed out waiting for a relay message")),15_000);waiters.push({match,resolve:value=>{clearTimeout(timer);resolve(value)}})})};
  return {
    ws,messages,next,opened:new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)}),
    rpc:(method,params={})=>{const requestId=++id;ws.send(JSON.stringify({id:requestId,method,params}));return next(message=>message.id===requestId&&!message.method).then(message=>{if(message.error)throw new Error(message.error.message);return message.result})},
    answer:(request,result)=>ws.send(JSON.stringify({id:request.id,result})),
  };
}

test("the relay puts a request Claude Code forwards in Full access to the window, and runs it once the person allows it",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-claude-forwarded-")),decisions=[];
  const {sdk}=scriptedClaudeSdk({turn:async({message,options,emit,signal})=>{
    decisions.push(await options.canUseTool("Bash",{command:"git push origin main"},{toolUseID:"push-1",signal,title:"Claude wants to run git push origin main",matchedAskRule:GIT_PUSH_RULE,suppressAlwaysAllowRule:true,suggestions:[]}));
    emit({type:"assistant",uuid:"reply-1",parent_tool_use_id:null,message:{id:"m-1",content:[{type:"text",text:"Pushed."}]}});
    emit(claudeResult(message,{result:"Pushed."}));
  }});
  const instance={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"claude",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"Claude Code",available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"claude",
  };
  const meta=new Map(),state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore:new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")}),terminals:{},state,version:"test",claudeSdk:sdk});
  const window=client("ws://127.0.0.1:"+await listen(server)+"/api/agent/ws");
  t.after(async()=>{try{window.ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  await window.opened;
  const {thread}=await window.rpc("thread/start",{cwd:root,model:"claude-test",permissionProfile:"full"});
  await window.rpc("turn/start",{threadId:thread.id,model:"claude-test",input:[{type:"text",text:"push the release"}],permissionProfile:"full"});
  const shown=await window.next(message=>message.method==="item/tool/requestApproval"||(message.method==="turn/completed"&&message.params?.threadId===thread.id));
  assert.equal(shown.method,"item/tool/requestApproval","the card comes before the turn ends");
  assert.equal(decisions.length,0,"nothing ran before the person answered");
  assert.equal(shown.params.reason,"Claude Code asks even in Full access, as its ask rule Bash(git push:*) says: Claude wants to run git push origin main");
  assert.deepEqual(shown.params.approvalOptions,[{decision:"decline",label:"Deny"},{decision:"accept",label:"Allow once"}]);
  window.answer(shown,{decision:"accept"});
  const completed=await window.next(message=>message.method==="turn/completed"&&message.params?.threadId===thread.id);
  assert.equal(completed.params.turn.status,"completed");
  assert.deepEqual(decisions.map(decision=>decision.behavior),["allow"]);
});
