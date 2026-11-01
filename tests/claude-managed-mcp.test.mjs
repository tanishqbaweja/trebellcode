// An administrator's managed-mcp.json decides which MCP servers Claude Code may start, and Claude Code refuses to start when it is
// also given --strict-mcp-config (code.claude.com/docs/en/managed-mcp). Trebell's own Claude Code runs that want no MCP server, the
// capability read (models, slash commands, plan usage) and Git text, therefore start without that flag where the file is in force,
// and change nothing else. Making the real file takes administrator rights, so the tests answer the look for it themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { capabilityReadOptions, readClaudeCodeCapabilities } from "../src/claude-capabilities.mjs";
import { generateTextWithHarness } from "../src/harness-text-generation.mjs";

test("the managed-mcp.json check looks where Claude Code reads it on each platform, and a failed check counts as no file",async()=>{
  const { adminMcpFilePath, adminMcpFilePresent }=await import("../src/claude-managed-mcp.mjs");
  assert.equal(adminMcpFilePath("darwin"),"/Library/Application Support/ClaudeCode/managed-mcp.json");
  assert.equal(adminMcpFilePath("win32"),"C:\\Program Files\\ClaudeCode\\managed-mcp.json");
  assert.equal(adminMcpFilePath("linux"),"/etc/claude-code/managed-mcp.json");
  const asked=[];
  assert.equal(await adminMcpFilePresent({platform:"win32",exists:path=>{asked.push(path);return true}}),true);
  assert.equal(await adminMcpFilePresent({platform:"linux",exists:async path=>{asked.push(path);return false}}),false);
  assert.deepEqual(asked,["C:\\Program Files\\ClaudeCode\\managed-mcp.json","/etc/claude-code/managed-mcp.json"]);
  assert.equal(await adminMcpFilePresent({exists:()=>{throw new Error("EACCES")}}),false);
});

// Claude Code behind the SDK's query, as a read meets it: an initialize answer with one model, then the read stops it. Each
// read's options are kept in calls.
function oneModelClaude(){
  const calls=[];
  const query=({prompt,options})=>{
    calls.push(options);void (async()=>{for await(const _ of prompt);})();
    return {initializationResult:async()=>({models:[{value:"default",displayName:"Default"}],commands:[],agents:[]}),usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>null,close(){}};
  };
  return {query,calls};
}

test("beside an administrator's managed-mcp.json the capability read starts Claude Code without --strict-mcp-config and with every other option as elsewhere, and a Claude Code on another machine is not looked at",async()=>{
  // One read's input, once with the administrator's file in force and once without it.
  const input={command:"claude",abortController:new AbortController()};
  const [managed,strict]=[true,false].map(adminMcpFile=>capabilityReadOptions({...input,adminMcpFile}));
  assert.equal(Object.hasOwn(managed,"strictMcpConfig"),false,"Claude Code would stop before its initialize answer with the flag here");
  assert.equal(strict.strictMcpConfig,true,"with no administrator's file the read is strict");
  assert.deepEqual({...managed,strictMcpConfig:true},strict,"nothing else differs");
  assert.deepEqual(managed.mcpServers,{});assert.deepEqual(managed.allowedTools,[]);assert.deepEqual(managed.settings,{disableAllHooks:true});
  assert.equal(managed.env.ENABLE_CLAUDEAI_MCP_SERVERS,"false");
  const {query,calls}=oneModelClaude();
  const read=await readClaudeCodeCapabilities({command:"claude",withPlanUsage:false,query,managedMcpExists:()=>true});
  assert.deepEqual(read.models,[{value:"default",displayName:"Default"}],"the models are read");
  assert.equal(Object.hasOwn(calls[0],"strictMcpConfig"),false);assert.deepEqual(calls[0].mcpServers,{});
  await readClaudeCodeCapabilities({command:"claude",withPlanUsage:false,query,managedMcpExists:()=>false});
  assert.equal(calls[1].strictMcpConfig,true);
  // Started on another machine, Claude Code reads that machine's file, which no look from here can see: it stays strict.
  let looks=0;
  await readClaudeCodeCapabilities({command:"claude",withPlanUsage:false,query,spawnProcess:()=>{},managedMcpExists:()=>{looks++;return true}});
  assert.equal(calls[2].strictMcpConfig,true);assert.equal(looks,0);
});

function claudeRuntimeManager(){
  return {
    definitions:()=>[{id:"claude",name:"Claude Code",protocol:"claude"}],activeInstance:()=>({id:"claude-default",kind:"claude"}),
    probe:async()=>({available:true}),executable:()=>"fixture-cli",childEnv:()=>({}),processSpawner:()=>null,remoteIo:()=>null,runtimeCwd:cwd=>cwd,
  };
}

test("Git text written through Claude Code starts it without --strict-mcp-config beside an administrator's managed-mcp.json, its other settings unchanged",async()=>{
  const seen=[];
  const claudeQuery=({options})=>{seen.push(options);return (async function*(){yield {type:"result",subtype:"success",is_error:false,result:"fix: keep the managed servers"}})()};
  const run=exists=>generateTextWithHarness({runtimeManager:claudeRuntimeManager(),prompt:"PROMPT",deps:{claudeQuery,claudeManagedMcpExists:exists}});
  assert.equal((await run(()=>true)).text,"fix: keep the managed servers","the Git text is written");
  assert.equal(Object.prototype.hasOwnProperty.call(seen[0],"strictMcpConfig"),false);
  assert.deepEqual(seen[0].mcpServers,{});assert.deepEqual(seen[0].tools,[]);assert.equal(seen[0].permissionMode,"dontAsk");assert.deepEqual(seen[0].settings,{disableAllHooks:true});
  await run(()=>false);
  assert.equal(seen[1].strictMcpConfig,true);
});
