import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeMcpBroker, mcpToolPolicy } from "../src/native-mcp-broker.mjs";
import { nativeMcpServersForSession, normalizeMcpServers } from "../src/mcp-registry.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const fixture=resolve(root,"tests/fixtures/native-mcp-server.mjs");

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
