import test from "node:test";
import assert from "node:assert/strict";
import { acpMcpServersForSession, claudeMcpServersForSession, normalizeMcpServers, supportsAcpMcpInjection, supportsMcpInjection } from "../src/mcp-registry.mjs";

test("MCP registry normalizes stdio servers and scopes them by runtime and environment",()=>{
  const normalized=normalizeMcpServers([
    {id:"remote-cursor",name:"Repo tools",runtime:"cursor",environmentId:"ssh-a",command:"/usr/local/bin/repo-mcp",args:["--stdio",4,"--token","hidden","--api-key=also-hidden","--safe","yes"],env:[{name:"TOKEN",value:"secret"},{name:"LOG_LEVEL",value:"debug"},{name:"TOKEN",value:"duplicate"}]},
    {id:"local-cursor",name:"Local tools",runtime:"cursor",command:"C:\\tools\\mcp.exe",enabled:false},
    {id:"grok",name:"Grok tools",runtime:"grok",command:"/opt/grok-mcp"},
    {id:"claude",name:"Claude tools",runtime:"claude",environmentId:"ssh-a",command:"/opt/claude-mcp",env:[{name:"API_KEY",value:"claude-secret"},{name:"NODE_ENV",value:"production"}]},
    {id:"ignored",name:"Unsupported runtime",runtime:"codex",command:"codex-mcp"},
    {id:"broken",runtime:"cursor",command:"missing-name"},
  ]);
  assert.equal(normalized.length,4);
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
  assert.equal(supportsAcpMcpInjection("cursor"),true);
  assert.equal(supportsAcpMcpInjection("claude"),false);
  assert.equal(supportsMcpInjection("claude"),true);
});
