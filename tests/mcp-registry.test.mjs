import test from "node:test";
import assert from "node:assert/strict";
import { acpMcpServersForSession, claudeMcpServersForSession, nativeMcpServersForSession, normalizeMcpServers, supportsAcpMcpInjection, supportsMcpInjection } from "../src/mcp-registry.mjs";

test("MCP registry normalizes stdio servers and scopes them by runtime and environment",()=>{
  const normalized=normalizeMcpServers([
    {id:"remote-cursor",name:"Repo tools",runtime:"cursor",environmentId:"ssh-a",command:"/usr/local/bin/repo-mcp",args:["--stdio",4,"--token","hidden","--api-key=also-hidden","--safe","yes"],env:[{name:"TOKEN",value:"secret"},{name:"LOG_LEVEL",value:"debug"},{name:"TOKEN",value:"duplicate"}]},
    {id:"local-cursor",name:"Local tools",runtime:"cursor",command:"C:\\tools\\mcp.exe",enabled:false},
    {id:"grok",name:"Grok tools",runtime:"grok",command:"/opt/grok-mcp"},
    {id:"claude",name:"Claude tools",runtime:"claude",environmentId:"ssh-a",command:"/opt/claude-mcp",env:[{name:"API_KEY",value:"claude-secret"},{name:"NODE_ENV",value:"production"}]},
    {id:"native",name:"Native tools",runtime:"native",environmentId:"ssh-a",command:"/opt/native-mcp",env:[{name:"TOKEN",value:"hidden"},{name:"LOG_LEVEL",value:"debug"}]},
    {id:"ignored",name:"Unsupported runtime",runtime:"codex",command:"codex-mcp"},
    {id:"broken",runtime:"cursor",command:"missing-name"},
  ]);
  assert.equal(normalized.length,5);
  assert.deepEqual(normalized[0].args,["--stdio","4","--safe","yes"]);
  assert.deepEqual(normalized[0].env,[{name:"LOG_LEVEL",value:"debug"}]);
  assert.equal(normalized[0].type,"stdio");
  assert.deepEqual(acpMcpServersForSession(normalized,{runtime:"cursor",environmentId:"ssh-a"}),[
    {name:"Repo tools",command:"/usr/local/bin/repo-mcp",args:["--stdio","4","--safe","yes"],env:[{name:"LOG_LEVEL",value:"debug"}]},
  ]);
  assert.deepEqual(acpMcpServersForSession(normalized,{runtime:"cursor",environmentId:null}),[]);
  assert.deepEqual(acpMcpServersForSession(normalized,{runtime:"grok",environmentId:null}),[
    {name:"Grok tools",command:"/opt/grok-mcp",args:[],env:[]},
  ]);
  assert.deepEqual(claudeMcpServersForSession(normalized,{environmentId:"ssh-a"}),{
    "Claude tools":{type:"stdio",command:"/opt/claude-mcp",args:[],env:{NODE_ENV:"production"}},
  });
  assert.deepEqual(nativeMcpServersForSession(normalized,{environmentId:"ssh-a"}),[
    {id:"native",name:"Native tools",type:"stdio",runtime:"native",environmentId:"ssh-a",enabled:true,command:"/opt/native-mcp",args:[],env:[{name:"LOG_LEVEL",value:"debug"}]},
  ]);
  assert.equal(supportsAcpMcpInjection("cursor"),true);
  assert.equal(supportsAcpMcpInjection("claude"),false);
  assert.equal(supportsMcpInjection("claude"),true);
  assert.equal(supportsMcpInjection("native"),true);
});

test("MCP registry accepts local Native HTTP servers without persisting bearer tokens",()=>{
  const normalized=normalizeMcpServers([
    {id:"native-http",name:"Remote Docs",runtime:"native",type:"http",url:"https://mcp.example.test/api",bearerTokenEnv:"MCP_ACCESS_TOKEN"},
    {id:"native-http-disabled",name:"Disabled HTTP",runtime:"native",type:"http",url:"http://127.0.0.1:8080/mcp",enabled:false},
    {id:"remote-http",name:"Remote env HTTP",runtime:"native",environmentId:"ssh-a",type:"http",url:"https://mcp.example.test/remote"},
    {id:"claude-http",name:"Claude HTTP",runtime:"claude",type:"http",url:"https://mcp.example.test/claude"},
    {id:"bad-token",name:"Bad token env",runtime:"native",type:"http",url:"https://mcp.example.test/bad",bearerTokenEnv:"NOT VALID"},
    {id:"url-secret",name:"URL secret",runtime:"native",type:"http",url:"https://mcp.example.test/api?token=should-not-persist"},
    {id:"url-userinfo",name:"URL userinfo",runtime:"native",type:"http",url:"https://user:password@mcp.example.test/api"},
  ]);
  assert.equal(normalized.length,3);
  assert.deepEqual(normalized[0],{id:"native-http",name:"Remote Docs",type:"http",runtime:"native",environmentId:null,enabled:true,url:"https://mcp.example.test/api",bearerTokenEnv:"MCP_ACCESS_TOKEN"});
  assert.equal(normalized[1].enabled,false);assert.equal(normalized[1].type,"http");
  assert.equal(normalized[2].id,"bad-token");assert.equal(normalized[2].bearerTokenEnv,null);
  assert.deepEqual(nativeMcpServersForSession(normalized,{environmentId:null}),[normalized[0],normalized[2]]);
  assert.deepEqual(nativeMcpServersForSession(normalized,{environmentId:"ssh-a"}),[]);
  assert.doesNotMatch(JSON.stringify(normalized),/should-not-persist|password/);
});
