import test from "node:test";
import assert from "node:assert/strict";
import { acpMcpServersForSession, normalizeMcpServers, supportsAcpMcpInjection } from "../src/mcp-registry.mjs";

test("MCP registry normalizes stdio servers and scopes them by runtime and environment",()=>{
  const normalized=normalizeMcpServers([
    {id:"remote-cursor",name:"Repo tools",runtime:"cursor",environmentId:"ssh-a",command:"/usr/local/bin/repo-mcp",args:["--stdio",4],env:[{name:"TOKEN",value:"secret"},{name:"TOKEN",value:"duplicate"}]},
    {id:"local-cursor",name:"Local tools",runtime:"cursor",command:"C:\\tools\\mcp.exe",enabled:false},
    {id:"grok",name:"Grok tools",runtime:"grok",command:"/opt/grok-mcp"},
    {id:"ignored",name:"Unsupported runtime",runtime:"claude",command:"claude-mcp"},
    {id:"broken",runtime:"cursor",command:"missing-name"},
  ]);
  assert.equal(normalized.length,3);
  assert.deepEqual(normalized[0].args,["--stdio","4"]);
  assert.deepEqual(normalized[0].env,[{name:"TOKEN",value:"secret"}]);
  assert.equal(normalized[0].type,"stdio");
  assert.deepEqual(acpMcpServersForSession(normalized,{runtime:"cursor",environmentId:"ssh-a"}),[
    {name:"Repo tools",command:"/usr/local/bin/repo-mcp",args:["--stdio","4"],env:[{name:"TOKEN",value:"secret"}]},
  ]);
  assert.deepEqual(acpMcpServersForSession(normalized,{runtime:"cursor",environmentId:null}),[]);
  assert.deepEqual(acpMcpServersForSession(normalized,{runtime:"grok",environmentId:null}),[
    {name:"Grok tools",command:"/opt/grok-mcp",args:[],env:[]},
  ]);
  assert.equal(supportsAcpMcpInjection("cursor"),true);
  assert.equal(supportsAcpMcpInjection("claude"),false);
});
