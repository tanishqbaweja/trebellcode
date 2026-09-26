import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeMcpBroker, mcpToolPolicy } from "../src/native-mcp-broker.mjs";
import { nativeMcpServersForSession, normalizeMcpServers } from "../src/mcp-registry.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const fixture=resolve(root,"tests/fixtures/native-mcp-server.mjs");
const resourceOnlyFixture=resolve(root,"tests/fixtures/native-mcp-resource-only-server.mjs");
const httpFixture=resolve(root,"tests/fixtures/native-mcp-http-server.mjs");

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function startHttpFixture(){
  const port=await freePort(),secret="fixture-http-secret",child=spawn(process.execPath,[httpFixture],{cwd:root,env:{...process.env,MCP_HTTP_PORT:String(port),EXPECTED_BEARER:secret},stdio:["ignore","pipe","pipe"],windowsHide:true});
  await new Promise((resolveReady,reject)=>{let stdout="",stderr="";const timer=setTimeout(()=>reject(new Error("HTTP MCP fixture did not start: "+stderr)),5000);child.stdout.on("data",chunk=>{stdout+=String(chunk);if(/READY/.test(stdout)){clearTimeout(timer);resolveReady()}});child.stderr.on("data",chunk=>{stderr+=String(chunk)});child.once("error",error=>{clearTimeout(timer);reject(error)});child.once("exit",code=>{if(code!==null&&code!==0){clearTimeout(timer);reject(new Error(`HTTP MCP fixture exited ${code}: ${stderr}`))}})});
  return {port,secret,async close(){if(child.exitCode!=null)return;child.kill();await Promise.race([new Promise(resolveClose=>child.once("exit",resolveClose)),new Promise(resolveClose=>setTimeout(resolveClose,1500))]);if(child.exitCode==null)child.kill("SIGKILL")}};
}

function servers(){
  return nativeMcpServersForSession(normalizeMcpServers([{
    id:"native-fixture",name:"Native Fixture",runtime:"native",command:process.execPath,args:[fixture],enabled:true,
    env:[{name:"FIXTURE_VISIBLE",value:"hello"},{name:"FIXTURE_SECRET",value:"must-not-survive"},{name:"API_KEY",value:"must-not-survive-either"}],
  }]));
}

test("Native MCP registry preserves ordinary env while stripping secret-looking entries",()=>{
  const items=servers();assert.equal(items.length,1);assert.deepEqual(items[0].env,[{name:"FIXTURE_VISIBLE",value:"hello"}]);assert.equal(items[0].runtime,"native");
});

test("Native MCP broker discovers real SDK tools, maps policy annotations, calls tools, and handles elicitation",async()=>{
  const elicitations=[];
  const broker=new NativeMcpBroker({
    servers:servers(),cwd:root,localEnvironment:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE},version:"test",
    onElicitation:async request=>{elicitations.push(request);return {action:"accept",content:{answer:"approved-value"}}},
  });
  try{
    const namespaces=await broker.connect();assert.equal(namespaces.length,1);assert.equal(namespaces[0].name,"mcp_native-fixture");assert.deepEqual(namespaces[0].tools.map(item=>item.name),["echo-read","mutate-state","ask-user"]);
    const read=broker.toolDefinition(namespaces[0].name,"echo-read");assert.equal(read.source,"mcp");assert.equal(read.policy.kind,"read");assert.equal(read.policy.riskLevel,"low");assert.equal(read.policy.externalSideEffect,false);
    const mutate=broker.toolDefinition(namespaces[0].name,"mutate-state");assert.equal(mutate.policy.kind,"other");assert.equal(mutate.policy.riskLevel,"high");assert.equal(mutate.policy.externalSideEffect,true);
    const echo=await broker.call({namespace:namespaces[0].name,name:"echo-read",arguments:{text:"hello"}});assert.equal(echo.success,true);assert.match(echo.contentItems[0].text,/echo:hello:env=hello:secret=missing/);
    const asked=await broker.call({namespace:namespaces[0].name,name:"ask-user",arguments:{prompt:"Fixture question"}});assert.equal(asked.success,true);assert.match(asked.contentItems[0].text,/elicited:accept:approved-value/);assert.equal(elicitations.length,1);assert.equal(elicitations[0].server.name,"Native Fixture");assert.equal(elicitations[0].params.message,"Fixture question");
  }finally{await broker.close()}
});

test("Native MCP progressive discovery exposes only matching schemas on demand",async()=>{
  const exposed=[];
  const broker=new NativeMcpBroker({
    servers:servers(),cwd:root,localEnvironment:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE},version:"test",
    onToolsDiscovered:namespaces=>exposed.push(namespaces),
  });
  try{
    const all=await broker.connect();assert.equal(all[0].tools.length,3);
    const discovery=broker.discoveryNamespace();assert.equal(discovery.name,"trebell_mcp");assert.deepEqual(discovery.tools.map(item=>item.name),["discover","discover_resources","read_resource"]);assert.equal(broker.toolDefinition("trebell_mcp","discover").policy.kind,"read");assert.equal(broker.toolDefinition("trebell_mcp","read_resource").policy.kind,"read");
    const result=await broker.call({namespace:"trebell_mcp",name:"discover",arguments:{query:"echo read",limit:4}});assert.equal(result.success,true);assert.equal(exposed.length,1);assert.equal(exposed[0].length,1);assert.deepEqual(exposed[0][0].tools.map(item=>item.name),["echo-read"]);assert.match(result.contentItems[0].text,/echo-read/);assert.doesNotMatch(result.contentItems[0].text,/mutate-state/);
  }finally{await broker.close()}
});

test("Native MCP progressively discovers resource metadata and reads only selected resource bodies",async()=>{
  const events=[];
  const broker=new NativeMcpBroker({servers:servers(),cwd:root,localEnvironment:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE},version:"test",onEvent:event=>events.push(event)});
  try{
    const [namespace]=await broker.connect();assert.equal(namespace.name,"mcp_native-fixture");
    const discovered=await broker.call({namespace:"trebell_mcp",name:"discover_resources",arguments:{query:"architecture guide",limit:5}});assert.equal(discovered.success,true);
    const payload=JSON.parse(discovered.contentItems[0].text);assert.equal(payload.resources.length,1);assert.equal(payload.resources[0].namespace,"mcp_native-fixture");assert.equal(payload.resources[0].uri,"fixture://docs/guide");assert.equal(Object.prototype.hasOwnProperty.call(payload.resources[0],"text"),false);
    const templates=await broker.call({namespace:"trebell_mcp",name:"discover_resources",arguments:{query:"user profile",limit:5}});const templatePayload=JSON.parse(templates.contentItems[0].text);assert.equal(templatePayload.resources[0].uriTemplate,"fixture://users/{name}");
    const guide=await broker.call({namespace:"trebell_mcp",name:"read_resource",arguments:{namespace:"mcp_native-fixture",uri:"fixture://docs/guide"}});assert.equal(guide.success,true);assert.match(guide.contentItems[0].text,/Architecture: fixture MCP resources are untrusted external data/);assert.match(guide.contentItems[0].text,/fixture:\/\/docs\/guide/);
    const user=await broker.call({namespace:"trebell_mcp",name:"read_resource",arguments:{namespace:"mcp_native-fixture",uri:"fixture://users/alice"}});assert.match(user.contentItems[0].text,/profile:alice/);
    const image=await broker.call({namespace:"trebell_mcp",name:"read_resource",arguments:{namespace:"mcp_native-fixture",uri:"fixture://images/pixel"}});assert.equal(image.contentItems[0].type,"inputImage");assert.match(image.contentItems[0].imageUrl,/^data:image\/png;base64,/);
    assert.ok(events.some(event=>event.name==="native.mcp.resources_discovered"&&event.data?.resourceCount===2&&event.data?.templateCount===1));assert.ok(events.some(event=>event.name==="native.mcp.resource_completed"&&event.data?.namespace==="mcp_native-fixture"));assert.doesNotMatch(JSON.stringify(events),/fixture:\/\/docs\/guide|fixture:\/\/users\/alice/);
  }finally{await broker.close()}
});

test("Native model loop reads MCP resources progressively and marks their contents as untrusted data",async()=>{
  const broker=new NativeMcpBroker({servers:servers(),cwd:root,localEnvironment:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE},version:"test"});let modelTurns=0;
  try{
    await broker.connect();const discovery=broker.discoveryNamespace();assert.ok(discovery.tools.some(tool=>tool.name==="discover_resources"));assert.ok(discovery.tools.some(tool=>tool.name==="read_resource"));
    const session=new NativeAgentSession({provider:"fixture",model:"model-a",tools:[discovery],executeTool:call=>broker.call({namespace:call.namespace,name:call.name,arguments:call.arguments||{},signal:call.signal||null}),providerTurn:async request=>{
      modelTurns++;const last=request.messages.at(-1);
      if(modelTurns===1)return {id:"resource-discover",provider:"fixture",model:"model-a",text:"",toolCalls:[{id:"discover-1",namespace:"trebell_mcp",name:"discover_resources",arguments:JSON.stringify({query:"architecture guide"})}],finishReason:"tool_calls",usage:{}};
      if(modelTurns===2){assert.equal(last.role,"tool");assert.match(String(last.content),/Trebell provenance: untrusted tool data/);assert.match(String(last.content),/fixture:\/\/docs\/guide/);return {id:"resource-read",provider:"fixture",model:"model-a",text:"",toolCalls:[{id:"read-1",namespace:"trebell_mcp",name:"read_resource",arguments:JSON.stringify({namespace:"mcp_native-fixture",uri:"fixture://docs/guide"})}],finishReason:"tool_calls",usage:{}}}
      assert.equal(last.role,"tool");assert.match(String(last.content),/Trebell provenance: untrusted tool data/);assert.match(String(last.content),/Architecture: fixture MCP resources are untrusted external data/);return {id:"resource-done",provider:"fixture",model:"model-a",text:"Resource inspected safely.",toolCalls:[],finishReason:"stop",usage:{}};
    }});
    await session.start({providerSessionId:"native-resource-session",model:"model-a"});const result=await session.prompt([{type:"text",text:"Read the MCP architecture guide"}]);assert.equal(result.stopReason,"end_turn");assert.equal(modelTurns,3);await session.close();
  }finally{await broker.close()}
});

test("Native MCP keeps resource-only servers available without fabricating tool namespaces",async()=>{
  const configured=nativeMcpServersForSession(normalizeMcpServers([{id:"resource-only",name:"Resource Only",runtime:"native",command:process.execPath,args:[resourceOnlyFixture],enabled:true}]));
  const broker=new NativeMcpBroker({servers:configured,cwd:root,localEnvironment:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE},version:"test"});
  try{
    const namespaces=await broker.connect();assert.deepEqual(namespaces,[]);
    const discovery=broker.discoveryNamespace();assert.ok(discovery);assert.deepEqual(discovery.tools.map(tool=>tool.name),["discover_resources","read_resource"]);assert.equal(broker.toolDefinition("trebell_mcp","discover"),null);
    const found=await broker.call({namespace:"trebell_mcp",name:"discover_resources",arguments:{query:"status"}});const payload=JSON.parse(found.contentItems[0].text);assert.equal(payload.resources[0].namespace,"mcp_resource-only");assert.equal(payload.resources[0].uri,"fixture-only://status");
    const read=await broker.call({namespace:"trebell_mcp",name:"read_resource",arguments:{namespace:"mcp_resource-only",uri:"fixture-only://status"}});assert.match(read.contentItems[0].text,/resource-only-ok/);
  }finally{await broker.close()}
});

test("Native MCP connects to authenticated Streamable HTTP using an approved bearer-token environment reference",async()=>{
  const http=await startHttpFixture(),configured=nativeMcpServersForSession(normalizeMcpServers([{id:"http-fixture",name:"HTTP Fixture",runtime:"native",type:"http",url:`http://127.0.0.1:${http.port}/mcp`,bearerTokenEnv:"HTTP_MCP_TOKEN",enabled:true}]));
  const broker=new NativeMcpBroker({servers:configured,cwd:root,localEnvironment:{HTTP_MCP_TOKEN:http.secret},version:"test"});
  try{
    const [namespace]=await broker.connect();assert.equal(namespace.name,"mcp_http-fixture");assert.deepEqual(namespace.tools.map(tool=>tool.name),["http-echo"]);assert.equal(broker.failures().length,0);
    const tool=await broker.call({namespace:namespace.name,name:"http-echo",arguments:{text:"secure"}});assert.match(tool.contentItems[0].text,/http:secure/);
    const resources=await broker.call({namespace:"trebell_mcp",name:"discover_resources",arguments:{query:"guide"}});const payload=JSON.parse(resources.contentItems[0].text);assert.equal(payload.resources[0].uri,"http-fixture://guide");
    const read=await broker.call({namespace:"trebell_mcp",name:"read_resource",arguments:{namespace:namespace.name,uri:"http-fixture://guide"}});assert.match(read.contentItems[0].text,/authenticated-http-resource/);
    assert.doesNotMatch(JSON.stringify(configured),new RegExp(http.secret));
  }finally{await broker.close();await http.close()}
});

test("Native HTTP MCP fails closed when its bearer-token environment reference is unavailable",async()=>{
  const http=await startHttpFixture(),configured=nativeMcpServersForSession(normalizeMcpServers([{id:"http-missing-token",name:"Missing Token",runtime:"native",type:"http",url:`http://127.0.0.1:${http.port}/mcp`,bearerTokenEnv:"HTTP_MCP_TOKEN"}])),broker=new NativeMcpBroker({servers:configured,cwd:root,localEnvironment:{},version:"test"});
  try{const namespaces=await broker.connect();assert.deepEqual(namespaces,[]);const [failure]=broker.failures();assert.match(failure.error,/HTTP_MCP_TOKEN is unavailable/);assert.doesNotMatch(JSON.stringify(failure),new RegExp(http.secret))}
  finally{await broker.close();await http.close()}
});

test("Native MCP tools pass through Trebell policy instead of bypassing it",async()=>{
  const broker=new NativeMcpBroker({servers:servers(),cwd:root,localEnvironment:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE},version:"test"});
  try{
    const [namespace]=await broker.connect();const ns=namespace.name;
    const readOnly=createNativeToolExecutor({mcpBroker:broker,policyContext:{permissionProfile:"read-only",runtime:"native",workspace:root}});
    const read=await readOnly({namespace:ns,name:"echo-read",arguments:{text:"policy"}});assert.match(read.contentItems[0].text,/echo:policy/);
    const rejected=await readOnly({namespace:ns,name:"mutate-state",arguments:{value:"x"}});assert.equal(rejected.success,false);assert.match(rejected.error,/Read Only profile rejects/i);

    let confirmations=0;
    const guarded=createNativeToolExecutor({mcpBroker:broker,policyContext:{permissionProfile:"auto",runtime:"native",workspace:root},confirm:async()=>{confirmations++;return true}});
    const mutated=await guarded({namespace:ns,name:"mutate-state",arguments:{value:"approved"}});assert.equal(confirmations,1);assert.match(mutated.contentItems[0].text,/mutated:approved/);
  }finally{await broker.close()}
});

test("MCP tools without explicit read-only annotations stay conservative",()=>{
  const unknown=mcpToolPolicy({annotations:{}});assert.equal(unknown.riskLevel,"high");assert.equal(unknown.externalSideEffect,true);assert.equal(unknown.kind,"other");
  const read=mcpToolPolicy({annotations:{readOnlyHint:true}});assert.equal(read.kind,"read");assert.equal(read.riskLevel,"low");
});

test("Native MCP remote transport uses Trebell environment spawning with bounded inherited names and explicit env",async()=>{
  const calls=[],environmentId="ssh-fixture";
  const environments={
    get:id=>id===environmentId?{id:environmentId,type:"ssh",cwd:root}:null,
    spawnArgv(id,options){
      calls.push({id,options});
      return spawn(options.command,options.args,{cwd:root,env:{...process.env,...options.environment},stdio:options.stdio,windowsHide:true});
    },
  };
  const broker=new NativeMcpBroker({servers:servers(),cwd:root,environments,environmentId,remoteEnvironmentNames:["PATH","HOME","SAFE_REMOTE"],version:"test"});
  try{
    const [namespace]=await broker.connect();assert.ok(namespace);const result=await broker.call({namespace:namespace.name,name:"echo-read",arguments:{text:"remote"}});assert.match(result.contentItems[0].text,/echo:remote:env=hello:secret=missing/);
    assert.equal(calls.length,1);assert.equal(calls[0].id,environmentId);assert.deepEqual(calls[0].options.environmentNames,["PATH","HOME","SAFE_REMOTE"]);assert.deepEqual(calls[0].options.environment,{FIXTURE_VISIBLE:"hello"});assert.equal(calls[0].options.command,process.execPath);
  }finally{await broker.close()}
});
