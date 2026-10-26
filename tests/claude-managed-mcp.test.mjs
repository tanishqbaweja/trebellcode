// Next to an administrator's managed-mcp.json Claude Code exits at startup on --strict-mcp-config (code.claude.com/docs/en/managed-mcp),
// so the capability probe (models, slash commands, plan usage) and Git text leave that flag out there, and only that (T3 Code's
// hasClaudeManagedMcpConfig). Creating the real file needs administrator rights, so the check's exists() is injected.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeCapabilitiesProbeOptions, probeClaudeCapabilities } from "../src/claude-capabilities.mjs";
import { generateTextWithHarness } from "../src/harness-text-generation.mjs";

test("the managed-mcp.json check looks where Claude Code reads it on each platform, and a failed check counts as no file",async()=>{
  const { claudeManagedMcpPath, hasClaudeManagedMcpConfig }=await import("../src/claude-managed-mcp.mjs");
  assert.equal(claudeManagedMcpPath("darwin"),"/Library/Application Support/ClaudeCode/managed-mcp.json");
  assert.equal(claudeManagedMcpPath("win32"),"C:\\Program Files\\ClaudeCode\\managed-mcp.json");
  assert.equal(claudeManagedMcpPath("linux"),"/etc/claude-code/managed-mcp.json");
  const asked=[];
  assert.equal(await hasClaudeManagedMcpConfig({platform:"win32",exists:path=>{asked.push(path);return true}}),true);
  assert.equal(await hasClaudeManagedMcpConfig({platform:"linux",exists:async path=>{asked.push(path);return false}}),false);
  assert.deepEqual(asked,["C:\\Program Files\\ClaudeCode\\managed-mcp.json","/etc/claude-code/managed-mcp.json"]);
  assert.equal(await hasClaudeManagedMcpConfig({exists:()=>{throw new Error("EACCES")}}),false);
});

// The SDK's query as the probe drives it: the initialize answer, read once, then the process is stopped.
function fakeProbeQuery(){
  const calls=[];
  const query=({prompt,options})=>{
    calls.push(options);void (async()=>{for await(const _ of prompt);})();
    return {initializationResult:async()=>({models:[{value:"default",displayName:"Default"}],commands:[],agents:[]}),usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>null,close(){}};
  };
  return {query,calls};
}

test("the capability probe drops strict MCP mode, and only that, next to an administrator's managed-mcp.json",async()=>{
  const managed=claudeCapabilitiesProbeOptions({command:"claude",abortController:new AbortController(),managedMcpConfig:true});
  assert.equal(Object.prototype.hasOwnProperty.call(managed,"strictMcpConfig"),false,"Claude Code exits before initializing when handed --strict-mcp-config here");
  assert.deepEqual(managed.mcpServers,{});assert.deepEqual(managed.allowedTools,[]);assert.deepEqual(managed.settings,{disableAllHooks:true});
  assert.equal(managed.env.ENABLE_CLAUDEAI_MCP_SERVERS,"false");
  assert.equal(claudeCapabilitiesProbeOptions({command:"claude",abortController:new AbortController()}).strictMcpConfig,true,"without the file the probe stays strict");
  const {query,calls}=fakeProbeQuery();
  const probe=await probeClaudeCapabilities({command:"claude",includeUsage:false,query,managedMcpExists:()=>true});
  assert.deepEqual(probe.models,[{value:"default",displayName:"Default"}],"the model list loads");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0],"strictMcpConfig"),false);assert.deepEqual(calls[0].mcpServers,{});
  await probeClaudeCapabilities({command:"claude",includeUsage:false,query,managedMcpExists:()=>false});
  assert.equal(calls[1].strictMcpConfig,true);
  // A Claude Code started elsewhere reads its own machine's managed file, which this check cannot see.
  let checked=0;
  await probeClaudeCapabilities({command:"claude",includeUsage:false,query,spawnProcess:()=>{},managedMcpExists:()=>{checked++;return true}});
  assert.equal(calls[2].strictMcpConfig,true);assert.equal(checked,0);
});

function claudeRuntimeManager(){
  return {
    definitions:()=>[{id:"claude",name:"Claude Code",protocol:"claude"}],activeInstance:()=>({id:"claude-default",kind:"claude"}),
    probe:async()=>({available:true}),executable:()=>"fixture-cli",childEnv:()=>({}),processSpawner:()=>null,remoteIo:()=>null,runtimeCwd:cwd=>cwd,
  };
}

test("Git text through Claude Code drops strict MCP mode, and only that, next to an administrator's managed-mcp.json",async()=>{
  const seen=[];
  const claudeQuery=({options})=>{seen.push(options);return (async function*(){yield {type:"result",subtype:"success",is_error:false,result:"fix: keep the managed servers"}})()};
  const run=exists=>generateTextWithHarness({runtimeManager:claudeRuntimeManager(),prompt:"PROMPT",deps:{claudeQuery,claudeManagedMcpExists:exists}});
  assert.equal((await run(()=>true)).text,"fix: keep the managed servers","the Git text is written");
  assert.equal(Object.prototype.hasOwnProperty.call(seen[0],"strictMcpConfig"),false);
  assert.deepEqual(seen[0].mcpServers,{});assert.deepEqual(seen[0].tools,[]);assert.equal(seen[0].permissionMode,"dontAsk");assert.deepEqual(seen[0].settings,{disableAllHooks:true});
  await run(()=>false);
  assert.equal(seen[1].strictMcpConfig,true);
});
