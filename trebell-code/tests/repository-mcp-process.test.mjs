import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mergeAcpMcpServers, repositoryMcpName, repositoryMcpProcessConfig } from "../src/repository-mcp-process.mjs";

const execFileAsync=promisify(execFile);

test("repository MCP process keeps safe baseline environment without forwarding provider secrets",()=>{
  const env={
    PATH:"C:\\Tools",
    SystemRoot:"C:\\Windows",
    TEMP:"C:\\Temp",
    HOME:"C:\\Users\\tester",
    TREBELL_HOME:"C:\\Users\\tester\\.trebell",
    OPENAI_API_KEY:"do-not-forward",
    ANTHROPIC_API_KEY:"do-not-forward-either",
    GITHUB_TOKEN:"also-secret",
  };
  const config=repositoryMcpProcessConfig({root:"C:\\repo",env,execPath:"C:\\node.exe",electron:true});
  const childEnv=Object.fromEntries(config.env.map(item=>[item.name,item.value]));
  assert.equal(config.name,repositoryMcpName);
  assert.equal(childEnv.PATH,env.PATH);
  assert.equal(childEnv.SystemRoot,env.SystemRoot);
  assert.equal(childEnv.TEMP,env.TEMP);
  assert.equal(childEnv.HOME,env.HOME);
  assert.equal(childEnv.TREBELL_HOME,env.TREBELL_HOME);
  assert.equal(childEnv.TREBELL_REPOSITORY_ROOT,"C:\\repo");
  assert.equal(childEnv.ELECTRON_RUN_AS_NODE,"1");
  assert.equal(childEnv.OPENAI_API_KEY,undefined);
  assert.equal(childEnv.ANTHROPIC_API_KEY,undefined);
  assert.equal(childEnv.GITHUB_TOKEN,undefined);
  assert.deepEqual(config.openCode.environment,childEnv);
});

test("repository MCP overrides a same-name user server without mutating other ACP MCP entries",()=>{
  const user=[{name:"docs",command:"docs-server",args:["--stdio"],env:[{name:"MODE",value:"read"}]},{name:repositoryMcpName,command:"spoofed",args:[],env:[]}];
  const internal={name:repositoryMcpName,command:"node",args:["repo.mjs"],env:[{name:"TREBELL_REPOSITORY_ROOT",value:"C:\\repo"}]};
  const merged=mergeAcpMcpServers(user,internal);
  assert.deepEqual(merged,[
    {name:"docs",command:"docs-server",args:["--stdio"],env:[{name:"MODE",value:"read"}]},
    internal,
  ]);
  assert.notEqual(merged[0],user[0]);
  assert.notEqual(merged[0].env,user[0].env);
});

test("repository MCP stdio server exposes real repository and Git intelligence",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-repository-mcp-")),home=join(root,".trebell-home");
  await mkdir(home,{recursive:true});
  await writeFile(join(root,"alpha.js"),"export function alpha() { return 42; }\n","utf8");
  await execFileAsync("git",["init"],{cwd:root,windowsHide:true});
  const config=repositoryMcpProcessConfig({root,env:{...process.env,TREBELL_HOME:home},electron:false});
  const transport=new StdioClientTransport({command:config.command,args:config.args,env:Object.fromEntries(config.env.map(item=>[item.name,item.value])),cwd:process.cwd(),stderr:"pipe"});
  const client=new Client({name:"trebell-repository-mcp-test",version:"1.0.0"},{capabilities:{}});
  t.after(async()=>{await client.close().catch(()=>{});await rm(root,{recursive:true,force:true})});
  await client.connect(transport);
  const listed=await client.listTools();
  assert.ok(listed.tools.some(tool=>tool.name==="search_files"));
  assert.ok(listed.tools.some(tool=>tool.name==="git_context"));
  const search=await client.callTool({name:"search_files",arguments:{query:"alpha"}});
  assert.equal(search.isError??false,false);
  const searchPayload=JSON.parse(search.content.find(item=>item.type==="text")?.text||"{}");
  assert.equal(searchPayload.data[0].path,"alpha.js");
  const git=await client.callTool({name:"git_context",arguments:{}});
  assert.equal(git.isError??false,false);
  const gitPayload=JSON.parse(git.content.find(item=>item.type==="text")?.text||"{}");
  assert.equal(gitPayload.isGit,true);
  assert.ok(gitPayload.changed.includes("alpha.js"));
});
