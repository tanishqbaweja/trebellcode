// What Claude Code still forwards to Trebell's canUseTool in Full access, in Plan mode or for an ask rule goes to the person with
// Claude's own reason: nothing Claude Code asked about is approved for them by Trebell's policy.
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

// Claude Code's reasons for its own safety checks, with the terminal colours its renderer gives them.
const colored=reason=>`\u001b[1;33m${reason}\u001b[0m`;
const OUTSIDE_PROJECT="Removes files outside the project folder";
const VARIABLE_PATH="Deletes a folder named only by shell variables";
const VARIABLE_RM={command:"rm -rf -- \"$OUT_DIR/$target\""};
// The person's own ask rule for publishing, from the project's Claude Code settings.
const PUBLISH_RULE={source:"projectSettings",toolName:"Bash",ruleContent:"npm publish:*"};
const PUBLISH={command:"npm publish --tag next"};
const EDIT={file_path:"/repo/src/limits.js",old_string:"max: 10",new_string:"max: 20"};
const ONCE_OPTIONS=[{decision:"decline",label:"Deny"},{decision:"accept",label:"Allow once"}];
// The card's lead for each case, as Trebell words it.
const LEAD={
  full:"Claude Code asks even in Full access",
  plan:"Claude Code asks in Plan mode",
  rule:"Claude Code asks, as its ask rule Bash(npm publish:*) says",
  fullRule:"Claude Code asks even in Full access, as its ask rule Bash(npm publish:*) says",
  supervised:"Claude Code asks, as it runs in Supervised mode, not Full access",
};

// A Claude session on a scripted SDK whose answers onPermission gives in turn; requests lists what the person was asked.
async function claudeSession({permissionMode,collaborationMode="default",answers=["accept"]}={}){
  const {sdk,calls}=scriptedClaudeSdk(),requests=[];
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,permissionMode,onUpdate:()=>{},onPermission:async request=>{requests.push(request);return answers.shift()??"decline"}});
  await session.start();session.setCollaborationMode(collaborationMode);
  await session.prompt([{type:"text",text:"go"}]);
  return {session,calls,requests,canUse:(...args)=>calls.at(-1).options.canUseTool(...args)};
}
// A once-only request's suggestion, which a session answer must not turn into a standing rule.
const allowToolSuggestion=toolName=>[{type:"addRules",rules:[{toolName}],behavior:"allow",destination:"localSettings"}];

test("in Full access a request Claude Code forwards goes to the person with Claude's reason, and their answer decides it",async()=>{
  const {session,requests,canUse}=await claudeSession({permissionMode:"full",answers:["decline","accept"]});
  const input={command:"rm -rf ~/old-builds"},options={toolUseID:"tool-1",title:"Claude wants to run rm -rf ~/old-builds",decisionReason:colored(OUTSIDE_PROJECT),suggestions:[]};
  const declined=await canUse("Bash",input,options);
  assert.equal(requests.length,1,"the person is asked, not Trebell's Full access policy");
  assert.equal(requests[0].askUser,true,"the relay does not accept it for the thread's Full access either");
  assert.equal(requests[0].params.prompt,`${LEAD.full}: Claude wants to run rm -rf ~/old-builds (${OUTSIDE_PROJECT})`);
  assert.deepEqual([declined.behavior,declined.message],["deny","The user denied this tool call in Trebell Code, so it did not run."]);
  const allowed=await canUse("Bash",input,{...options,toolUseID:"tool-2"});
  assert.deepEqual([allowed.behavior,allowed.updatedInput,allowed.decisionClassification],["allow",input,"user_temporary"]);
  assert.equal(requests.length,2);
  await session.close();
});

test("Plan mode asks before a write in Full access and in Auto, and an ask rule asks in any mode",async()=>{
  for(const permissionMode of ["full","auto","edits"]){
    const {session,requests,canUse}=await claudeSession({permissionMode,collaborationMode:"plan"});
    assert.equal(session.live.openedPermissionMode,"plan");
    const decision=await canUse("Edit",EDIT,{toolUseID:"edit-1",suggestions:[]});
    assert.equal(decision.behavior,"allow");
    assert.equal(requests.length,1,`Plan mode in ${permissionMode} asks before the edit`);assert.equal(requests[0].askUser,true);
    // Plan mode asks, whatever the profile: the card says so, not that Full access was overruled.
    assert.equal(requests[0].params.prompt,`${LEAD.plan}: Edit: /repo/src/limits.js`);
    await session.close();
  }
  // Claude can switch itself to Plan (EnterPlanMode): a Full access process it left there asks for Plan mode too.
  const {sdk:planning,calls:planned}=scriptedClaudeSdk({turn:({message,emit})=>{emit({type:"system",subtype:"status",status:null,permissionMode:"plan"});emit(claudeResult(message))}});
  const asked=[],full=new ClaudeAgentSession({cwd:"/repo",sdk:planning,permissionMode:"full",onUpdate:()=>{},onPermission:async request=>{asked.push(request);return "accept"}});
  await full.start();await full.prompt([{type:"text",text:"Read the limits first"}]);
  assert.equal(full.live.permissionMode,"plan");
  await planned.at(-1).options.canUseTool("Write",{file_path:"/repo/notes/plan.md",content:"# Plan\n"},{toolUseID:"write-1",suggestions:[]});
  assert.equal(asked[0].params.prompt,`${LEAD.plan}: Write: /repo/notes/plan.md`);
  await full.close();
  const {session,requests,canUse}=await claudeSession({permissionMode:"auto"});
  const published=await canUse("Bash",PUBLISH,{toolUseID:"publish-1",matchedAskRule:PUBLISH_RULE,suggestions:[]});
  assert.equal(published.behavior,"allow");
  assert.equal(requests.length,1,"Auto asks what the person's own ask rule asks for");assert.equal(requests[0].askUser,true);
  assert.equal(requests[0].params.prompt,`${LEAD.rule}: Bash: npm publish --tag next`);
  // Auto still runs what no ask rule or plan mode holds back, as before.
  assert.equal((await canUse("Bash",{command:"node scripts/check-limits.mjs"},{toolUseID:"check-1",suggestions:[]})).behavior,"allow");
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
  const editOptions={toolUseID:"edit-1",suggestions:[]};
  {
    const {session,requests,canUse}=await asked(scriptedClaudeSdk({init:{permissionMode:"default"}}));
    assert.equal(session.live.permissionMode,"default");
    assert.equal((await canUse("Edit",EDIT,editOptions)).behavior,"allow");
    assert.equal(requests[0].askUser,true,"asked, not allowed for the thread's Full access");
    assert.equal(requests[0].params.prompt,`${LEAD.supervised}: Edit: /repo/src/limits.js`);
    await canUse("Bash",PUBLISH,{toolUseID:"publish-1",matchedAskRule:PUBLISH_RULE,suggestions:[]});
    assert.equal(requests[1].params.prompt,`${LEAD.rule}: Bash: npm publish --tag next`);
    await session.close();
  }
  // Full access Claude Code could not take back after Plan (bypass turned off since the process opened) runs in Supervised too.
  {
    const sdk=scriptedClaudeSdk({turn:({message,index,emit})=>{if(index===0)emit({type:"system",subtype:"status",status:null,permissionMode:"plan"});emit(claudeResult(message))},control:{setPermissionMode:mode=>{if(mode==="bypassPermissions")throw new Error("Bypass permissions mode is disabled")}}});
    const {session,requests,canUse}=await asked(sdk);
    await session.prompt([{type:"text",text:"Now raise the limit"}]);
    assert.equal(session.live.permissionMode,"default");
    await canUse("Edit",EDIT,editOptions);
    assert.equal(requests[0].params.prompt,`${LEAD.supervised}: Edit: /repo/src/limits.js`);
    await session.close();
  }
  // Where Claude Code runs in Full access, the card still says it asks even there.
  const {session,requests,canUse}=await asked(scriptedClaudeSdk());
  await canUse("Edit",EDIT,editOptions);
  assert.equal(requests[0].params.prompt,`${LEAD.full}: Edit: /repo/src/limits.js`);
  await session.close();
});

test("a request Claude Code wants decided once offers no session choice, and an answer for the session allows it once",async()=>{
  for(const flag of ["suppressAlwaysAllowRule","defaultToNo"]){
    const {session,calls,requests,canUse}=await claudeSession({permissionMode:"full",answers:["acceptForSession"]});
    const decision=await canUse("Bash",VARIABLE_RM,{toolUseID:"rm-1",[flag]:true,decisionReason:colored(VARIABLE_PATH),suggestions:allowToolSuggestion("Bash")});
    assert.deepEqual(requests[0].approvalOptions,ONCE_OPTIONS,`${flag}: only Deny and Allow once`);
    assert.deepEqual(requests[0].options.map(option=>option.optionId),["allow_once","reject_once"]);
    assert.equal(decision.behavior,"allow");assert.equal(decision.decisionClassification,"user_temporary");assert.equal(decision.updatedPermissions,undefined);
    session.setPermissionMode("auto");await session.prompt([{type:"text",text:"again"}]);
    assert.equal(calls.at(-1).options.settings.permissions,undefined,"no session rule allows every Bash command afterwards");
    await session.close();
  }
  // An ordinary request keeps its session choice and Trebell's own buttons.
  const {session,requests,canUse}=await claudeSession({permissionMode:"full"});
  await canUse("Bash",{command:"npm publish"},{toolUseID:"publish-1",matchedAskRule:PUBLISH_RULE,suggestions:[]});
  assert.equal(requests[0].approvalOptions,undefined);
  assert.deepEqual(requests[0].options.map(option=>option.optionId),["allow_once","allow_always","reject_once"]);
  assert.equal(requests[0].params.prompt,`${LEAD.fullRule}: Bash: npm publish`);
  await session.close();
});

// The session choice Claude Code wants left out is left out wherever the person is asked: Supervised and Auto-accept edits asked about
// such a request before Full access did, and offered a choice for the whole session for it.
test("outside Full access too, a request Claude Code wants decided once offers no session choice, and an answer for the session allows it once",async()=>{
  const cases=[["supervised","Bash",VARIABLE_RM],["edits","Bash",VARIABLE_RM],["supervised","Edit",EDIT]];
  for(const [permissionMode,toolName,input] of cases)for(const flag of ["suppressAlwaysAllowRule","defaultToNo"]){
    const {session,requests,canUse}=await claudeSession({permissionMode,answers:["acceptForSession"]});
    const decision=await canUse(toolName,input,{toolUseID:"once-1",[flag]:true,decisionReason:colored(VARIABLE_PATH),suggestions:allowToolSuggestion(toolName)});
    const label=`${permissionMode} ${toolName} ${flag}`;
    assert.equal(requests.length,1,label);
    assert.deepEqual(requests[0].options.map(option=>option.optionId),["allow_once","reject_once"],`${label}: no choice for the session`);
    assert.deepEqual(requests[0].approvalOptions,ONCE_OPTIONS,`${label}: only Deny and Allow once`);
    assert.deepEqual([decision.behavior,decision.decisionClassification,decision.updatedPermissions],["allow","user_temporary",undefined],`${label}: allowed once`);
    await session.close();
  }
});

test("read-only still denies what it denies, whatever Claude Code asks or plan mode",async()=>{
  for(const collaborationMode of ["default","plan"]){
    const {session,requests,canUse}=await claudeSession({permissionMode:"read-only",collaborationMode});
    const denied=await canUse("Write",{file_path:"/repo/notes/plan.md",content:"# Plan\n"},{toolUseID:"write-1",matchedAskRule:{source:"projectSettings",toolName:"Write"},suggestions:[]});
    assert.deepEqual([denied.behavior,denied.message],["deny","Trebell read-only mode denied this tool."]);
    assert.equal(requests.length,0,"a denial is never put to the person");
    await session.close();
  }
});

// The real relay with a scripted Claude Code: the window that sent the turn is asked, as a person sees the card.
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
const RELAY_WAIT_MS=15_000;
// The window's side of the relay socket: what came in so far, and waits for the first message a test looks for.
function client(url){
  const ws=new WebSocket(url),inbox=[],waits=new Set();
  let lastRequest=0;
  ws.on("message",data=>{
    const message=JSON.parse(data.toString());
    inbox.push(message);
    for(const wait of waits)if(wait.wants(message))wait.settle(message);
  });
  function next(wants){
    const already=inbox.find(wants);
    if(already)return Promise.resolve(already);
    return new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{waits.delete(wait);reject(new Error(`no relay message the test waited for came in ${RELAY_WAIT_MS/1000} s`))},RELAY_WAIT_MS);
      const wait={wants,settle:message=>{waits.delete(wait);clearTimeout(deadline);resolve(message)}};
      waits.add(wait);
    });
  }
  async function rpc(method,params={}){
    const id=++lastRequest;
    ws.send(JSON.stringify({id,method,params}));
    const response=await next(message=>message.id===id&&!message.method);
    if(response.error)throw new Error(response.error.message);
    return response.result;
  }
  const opened=new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  return {ws,opened,next,rpc,answer:(request,result)=>ws.send(JSON.stringify({id:request.id,result}))};
}

test("the relay puts a request Claude Code forwards in Full access to the window, and runs it once the person allows it",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-claude-forwarded-")),decisions=[];
  const {sdk}=scriptedClaudeSdk({turn:async({message,options,emit,signal})=>{
    decisions.push(await options.canUseTool("Bash",PUBLISH,{toolUseID:"publish-1",signal,title:"Claude wants to run npm publish --tag next",matchedAskRule:PUBLISH_RULE,suppressAlwaysAllowRule:true,suggestions:[]}));
    emit({type:"assistant",uuid:"reply-1",parent_tool_use_id:null,message:{id:"m-1",content:[{type:"text",text:"Published."}]}});
    emit(claudeResult(message,{result:"Published."}));
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
  await window.rpc("turn/start",{threadId:thread.id,model:"claude-test",input:[{type:"text",text:"publish the package"}],permissionProfile:"full"});
  const shown=await window.next(message=>message.method==="item/tool/requestApproval"||(message.method==="turn/completed"&&message.params?.threadId===thread.id));
  assert.equal(shown.method,"item/tool/requestApproval","the card comes before the turn ends");
  assert.equal(decisions.length,0,"nothing ran before the person answered");
  assert.equal(shown.params.reason,`${LEAD.fullRule}: Claude wants to run npm publish --tag next`);
  assert.deepEqual(shown.params.approvalOptions,ONCE_OPTIONS);
  window.answer(shown,{decision:"accept"});
  const completed=await window.next(message=>message.method==="turn/completed"&&message.params?.threadId===thread.id);
  assert.equal(completed.params.turn.status,"completed");
  assert.deepEqual(decisions.map(decision=>decision.behavior),["allow"]);
});
