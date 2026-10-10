import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgentSession, acpPermissionChoice } from "../src/acp-agent-session.mjs";

const options=[
  {kind:"allow_always",optionId:"always",name:"Always allow"},
  {kind:"allow_once",optionId:"once",name:"Allow once"},
  {kind:"reject_once",optionId:"reject",name:"Reject"},
];

test("ACP edits mode auto-allows only explicitly classified edit permissions",()=>{
  assert.equal(acpPermissionChoice(options,"edits","edit"),"once");
  assert.equal(acpPermissionChoice(options,"edits","write"),"once");
  assert.equal(acpPermissionChoice(options,"edits","workspace_write"),"once");
  assert.equal(acpPermissionChoice(options,"edits","execute"),null);
  assert.equal(acpPermissionChoice(options,"edits","network"),null);
  assert.equal(acpPermissionChoice(options,"edits","other"),null);
  assert.equal(acpPermissionChoice(options,"edits",null),null);
  assert.equal(acpPermissionChoice(options,"edits","mystery-tool"),null);
});

test("ACP full, auto, supervised and read-only modes preserve their approval contract",()=>{
  // An automatic yes is allow-once: an always answer can outlive the session (Grok saves it for the project; T3 picks
  // allow_once first). Allow-always is used only when the agent offers nothing else.
  assert.equal(acpPermissionChoice(options,"full",null),"once");
  assert.equal(acpPermissionChoice(options,"auto","execute"),"once");
  assert.equal(acpPermissionChoice(options.filter(option=>option.kind!=="allow_once"),"full",null),"always");
  assert.equal(acpPermissionChoice(options,"supervised","edit"),null);
  assert.equal(acpPermissionChoice(options,"read-only","edit"),"reject");
  assert.equal(acpPermissionChoice(options,"read-only","execute"),"reject");
});

test("ACP read, search and think requests are allowed unasked in every mode, Read Only included (T3 acpReadDisposition)",()=>{
  for(const mode of ["supervised","edits","auto","read-only","full"]){
    for(const kind of ["read","search","think"])assert.equal(acpPermissionChoice(options,mode,kind),"once",`${mode} ${kind}`);
  }
  // Only the ACP read kinds are reads: other labels that merely sound like reads keep the mode's answer.
  assert.equal(acpPermissionChoice(options,"read-only","grep"),"reject");
  assert.equal(acpPermissionChoice(options,"supervised","grep"),null);
});

test("ACP harness prompts append bounded Trebell runtime context once per session without replacing user messages",async()=>{
  const calls=[],session=new AcpAgentSession({runtime:"cursor",command:"fixture",cwd:process.cwd()});
  session.sessionId="session-1";session.model="cursor-default";
  session.client={prompt:async(sessionId,content,options)=>{calls.push({sessionId,content,options});return {stopReason:"end_turn"}}};
  await session.prompt([{type:"text",text:"Inspect the repo"}],{messageId:"message-1"});
  await session.prompt([{type:"text",text:"Now run the tests"}],{messageId:"message-2"});
  assert.equal(calls[0].content[0].text,"Inspect the repo");
  assert.match(calls[0].content[1].text,/Trebell Code/);
  assert.match(calls[0].content[1].text,/Cursor harness/);
  assert.match(calls[0].content[1].text,/cursor-default/);
  assert.deepEqual(calls[1].content,[{type:"text",text:"Now run the tests"}]);
});

test("ACP edits mode never fabricates approval when the provider exposes no allow option",()=>{
  const rejectOnly=[{kind:"reject_once",optionId:"reject",name:"Reject"}];
  assert.equal(acpPermissionChoice(rejectOnly,"edits","edit"),null);
});

test("ACP process cwd can differ from the coding workspace cwd",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-process-cwd-")),runtimeDir=join(root,"runtime"),workspace=join(root,"workspace"),fixture=join(runtimeDir,"fake-acp.mjs");
  const { mkdir }=await import("node:fs/promises");await mkdir(runtimeDir,{recursive:true});await mkdir(workspace,{recursive:true});
  await writeFile(fixture,String.raw`
import readline from "node:readline";
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{const message=JSON.parse(line);if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:process.cwd()},agentCapabilities:{sessionCapabilities:{close:{}}}}});if(message.method==="session/new")return send({jsonrpc:"2.0",id:message.id,result:{sessionId:"cwd-fixture",meta:{requestedCwd:message.params.cwd},models:{currentModelId:"fixture",availableModels:[]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}});if(message.method==="session/close")return send({jsonrpc:"2.0",id:message.id,result:{}})});
`,"utf8");
  const session=new AcpAgentSession({runtime:"fixture",command:process.execPath,args:[fixture],cwd:workspace,processCwd:runtimeDir});
  try{
    const started=await session.start();
    assert.equal(started.initialize.agentInfo.version,runtimeDir);
    assert.equal(started.session.meta.requestedCwd,workspace);
  }finally{await session.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
});

// No harness is offered the client's terminal (T3: ACP agents run their own shell behind their own permission requests),
// so a terminal/create request is refused outright: nothing runs and no second approval card appears.
test("ACP terminal requests are refused without running anything, since no harness is offered the client's terminal",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-permission-")),fixture=join(root,"fake-acp.mjs"),marker=join(root,"executed.txt");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
let next=1,sessionId="permission-fixture";const pending=new Map();
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
function request(method,params){const id="r"+(next++);send({jsonrpc:"2.0",id,method,params});return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}
async function handle(message){
  if(message.id!=null&&!message.method&&pending.has(message.id)){const entry=pending.get(message.id);pending.delete(message.id);return message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result)}
  if(!message.method||message.id==null)return;
  if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{sessionCapabilities:{close:{}}}}});
  if(message.method==="session/new")return send({jsonrpc:"2.0",id:message.id,result:{sessionId,models:{currentModelId:"fixture",availableModels:[]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}});
  if(message.method==="session/close")return send({jsonrpc:"2.0",id:message.id,result:{}});
  if(message.method==="session/prompt"){
    let denied=false;try{await request("terminal/create",{sessionId,command:process.execPath,args:["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"EXECUTED")`)}],cwd:${JSON.stringify(root)},env:[]})}catch{denied=true}
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:denied?"DENIED":"ALLOWED"}}}});
    return send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(error=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:error.message}}))}catch{}});
`,"utf8");
  const approvals=[],updates=[];
  const session=new AcpAgentSession({runtime:"fixture",command:process.execPath,args:[fixture],cwd:root,permissionMode:"edits",onPermission:async request=>{approvals.push(request);return "decline"},onUpdate:update=>updates.push(update)});
  try{
    const started=await session.start();
    assert.equal(started.initialize.protocolVersion,1);
    await session.prompt([{type:"text",text:"run"}]);
    assert.equal(approvals.length,0,"a request for a service the harness was not offered never reaches the user");
    assert.ok(updates.some(item=>item.update?.content?.text==="DENIED"));
    await assert.rejects(()=>access(marker));
  }finally{await session.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
});
