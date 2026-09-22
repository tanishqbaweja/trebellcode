import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { TerminalManager } from "../src/terminal-manager.mjs";

test("agent runtime registry exposes real harnesses and capability-gates configured instances", async () => {
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-runtime-"));
  try{
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});
    const manager=new AgentRuntimeManager({state,env:{...process.env,TREBELL_HOME:home}});
    assert.deepEqual(manager.definitions().map(item=>item.id),["codex","claude","cursor","grok","opencode","antigravity"]);
    const fake=manager.upsertInstance({id:"cursor-fixture",kind:"cursor",displayName:"Fixture Cursor",binaryPath:process.execPath});
    const status=await manager.probe(fake);
    assert.equal(status.installed,true);
    assert.equal(status.available,true);
    const selected=await manager.setActive({runtime:"cursor",instanceId:fake.id});
    assert.equal(selected.runtime,"cursor");
    assert.equal(state.settings().agentRuntimeInstanceId,fake.id);
    const models=await manager.models(fake);
    assert.deepEqual(models.models,["cursor-default"]);
  }finally{
    await rm(home,{recursive:true,force:true});
  }
});

test("ACP agent session serves bounded filesystem and terminal capabilities end to end", async () => {
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-session-"));
  const fixture=join(root,"fake-acp.mjs");
  const input=join(root,"input.txt");
  const output=join(root,"output.txt");
  await writeFile(input,"INPUT_OK","utf8");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
let next=1000; const pending=new Map(); let sessionId="fixture-session";
function send(x){process.stdout.write(JSON.stringify(x)+"\n")}
function request(method,params){const id="s"+(next++);send({jsonrpc:"2.0",id,method,params});return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}
async function handle(m){
  if(m.id!=null&&!m.method&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(!m.method||m.id==null)return;
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}}});
  if(m.method==="session/new"||m.method==="session/resume"||m.method==="session/load")return send({jsonrpc:"2.0",id:m.id,result:{sessionId,models:{currentModelId:"fake-model",availableModels:[{modelId:"fake-model",name:"Fake"}]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}});
  if(m.method==="session/set_model")return send({jsonrpc:"2.0",id:m.id,result:{}});
  if(m.method==="session/close")return send({jsonrpc:"2.0",id:m.id,result:{}});
  if(m.method==="session/prompt"){
    const read=await request("fs/read_text_file",{sessionId,path:${JSON.stringify(input)}});
    await request("fs/write_text_file",{sessionId,path:${JSON.stringify(output)},content:"READ:"+read.content});
    const created=await request("terminal/create",{sessionId,command:process.execPath,args:["-e","process.stdout.write('TERM_OK')"],cwd:${JSON.stringify(root)},env:[]});
    await request("terminal/wait_for_exit",{sessionId,terminalId:created.terminalId});
    const terminal=await request("terminal/output",{sessionId,terminalId:created.terminalId});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"tool-1",title:"Fixture command",kind:"execute",status:"completed",rawOutput:terminal.output}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"usage_update",used:12,size:128}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"FAKE_OK"}}}});
    return send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(e=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:e.message}}))}catch{}});
`,"utf8");
  const terminals=new TerminalManager();
  const updates=[];
  const session=new AcpAgentSession({runtime:"fixture",command:process.execPath,args:[fixture],cwd:root,terminals,permissionMode:"full",onUpdate:update=>updates.push(update)});
  try{
    const started=await session.start({model:"fake-model"});
    assert.equal(started.session.sessionId,"fixture-session");
    const result=await session.prompt([{type:"text",text:"run"}]);
    assert.equal(result.stopReason,"end_turn");
    assert.equal(await readFile(output,"utf8"),"READ:INPUT_OK");
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="agent_message_chunk"&&item.update.content?.text==="FAKE_OK"));
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="tool_call"&&String(item.update.rawOutput||"").includes("TERM_OK")));
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="usage_update"&&item.update.used===12));
    await assert.rejects(()=>session.client.request("fs/read_text_file",{sessionId:"fixture-session",path:join(root,"..","escape.txt")},1000));
  }finally{
    await session.close().catch(()=>{});
    await terminals.shutdown().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});
