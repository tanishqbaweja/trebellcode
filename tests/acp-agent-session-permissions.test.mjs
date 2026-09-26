import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgentSession, acpPermissionChoice } from "../src/acp-agent-session.mjs";
import { TerminalManager } from "../src/terminal-manager.mjs";

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
  assert.equal(acpPermissionChoice(options,"full",null),"always");
  assert.equal(acpPermissionChoice(options,"auto","execute"),"always");
  assert.equal(acpPermissionChoice(options,"supervised","edit"),null);
  assert.equal(acpPermissionChoice(options,"read-only","read"),"reject");
});

test("ACP edits mode never fabricates approval when the provider exposes no allow option",()=>{
  const rejectOnly=[{kind:"reject_once",optionId:"reject",name:"Reject"}];
  assert.equal(acpPermissionChoice(rejectOnly,"edits","edit"),null);
});

test("ACP terminal execution is denied in edits mode unless Trebell approval allows it",async()=>{
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
  const terminals=new TerminalManager({persist:false}),approvals=[],updates=[];
  const session=new AcpAgentSession({runtime:"fixture",command:process.execPath,args:[fixture],cwd:root,terminals,permissionMode:"edits",onPermission:async request=>{approvals.push(request);return "decline"},onUpdate:update=>updates.push(update)});
  try{
    await session.start();await session.prompt([{type:"text",text:"run"}]);
    assert.equal(approvals.length,1);assert.equal(approvals[0].params.toolCall.kind,"execute");
    assert.ok(updates.some(item=>item.update?.content?.text==="DENIED"));
    await assert.rejects(()=>access(marker));
  }finally{await session.close().catch(()=>{});await terminals.shutdown().catch(()=>{});await rm(root,{recursive:true,force:true})}
});
