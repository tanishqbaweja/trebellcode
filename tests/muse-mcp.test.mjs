import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import * as muse from "../src/muse-agent-session.mjs";
import { acpMcpServersForSession, normalizeMcpServers, supportsMcpInjection } from "../src/mcp-registry.mjs";
import { repositoryMcpEntrypoint } from "../src/repository-mcp-process.mjs";
import { sharedRuntimeCapabilities } from "../src/runtime-capabilities.mjs";
import { FakeMuse, INIT, startSession } from "./fixtures/muse/fake-host.mjs";
import { museRelay } from "./fixtures/muse/relay-harness.mjs";

// Trebell's MCP servers inside Muse Code sessions: the repository tools and the person's own servers for Muse Code, as
// the ACP harnesses get them, in session/start's and session/resume's config.mcpServers, each optional, on a host that granted session
// MCP servers; a host that did not is refused with the update message.

const SERVERS=[
  {name:"trebell_repository",command:"C:\\node\\node.exe",args:["H:\\trebell\\src\\repository-mcp-stdio.mjs"],env:[{name:"TREBELL_REPOSITORY_ROOT",value:"H:\\repo"}]},
  {name:"docs",command:"docs-mcp",args:["--stdio"],env:[]},
  {type:"http",name:"remote docs",url:"https://mcp.example.test/mcp",headers:[{name:"Authorization",value:"Bearer from-the-environment"}]},
  {type:"sse",name:"old remote",url:"https://mcp.example.test/sse",headers:[]},
];
const MSP_SERVERS={
  trebell_repository:{transport:"stdio",command:"C:\\node\\node.exe",args:["H:\\trebell\\src\\repository-mcp-stdio.mjs"],env:{TREBELL_REPOSITORY_ROOT:"H:\\repo"},mode:"optional"},
  docs:{transport:"stdio",command:"docs-mcp",args:["--stdio"],env:{},mode:"optional"},
  "remote docs":{transport:"streamableHttp",url:"https://mcp.example.test/mcp",headers:{Authorization:"Bearer from-the-environment"},mode:"optional"},
};

test("Muse Code gets the person's local MCP servers for it, as the ACP harnesses get theirs; a remote one stays Trebell Native's",()=>{
  const normalized=normalizeMcpServers([
    {id:"muse-docs",name:"Docs",runtime:"muse",command:"docs-mcp",args:["--stdio","--token","hidden"],env:[{name:"LOG_LEVEL",value:"debug"},{name:"API_KEY",value:"secret"}]},
    {id:"muse-off",name:"Off",runtime:"muse",command:"off-mcp",enabled:false},
    {id:"muse-remote",name:"Remote",runtime:"muse",environmentId:"ssh-a",command:"remote-mcp"},
    {id:"muse-http",name:"HTTP",runtime:"muse",type:"http",url:"https://mcp.example.test/api"},
  ]);
  assert.deepEqual(normalized.map(item=>item.id),["muse-docs","muse-off","muse-remote"]);
  assert.deepEqual(acpMcpServersForSession(normalized,{runtime:"muse",environmentId:null}),[{name:"Docs",command:"docs-mcp",args:["--stdio"],env:[{name:"LOG_LEVEL",value:"debug"}]}]);
  assert.equal(supportsMcpInjection("muse"),true);
  assert.equal(sharedRuntimeCapabilities("muse").mcpInjection,true,"Settings lists MCP servers for Muse Code");
});

test("Trebell's MCP servers as Muse's session config names them: local ones over stdio and remote ones over streamable HTTP, each optional, and none over SSE",()=>{
  assert.deepEqual(muse.museMcpServers?.(SERVERS),MSP_SERVERS);
  assert.deepEqual(muse.museMcpServers?.([]),{});
});

test("session/start and session/resume carry Trebell's MCP servers in config.mcpServers, each optional",async()=>{
  const started=await startSession({options:{mcpServers:SERVERS}});
  const [start]=started.muse.sent("session/start");
  assert.deepEqual(start.params.config,{mcpServers:MSP_SERVERS});
  await started.session.close();
  const resumed=await startSession({providerSessionId:"01a17000-1111-7000-8000-000000000002",options:{mcpServers:SERVERS}});
  const [resume]=resumed.muse.sent("session/resume");
  assert.deepEqual(resume.params.config,{mcpServers:MSP_SERVERS});
  await resumed.session.close();
  // A session with no servers sends no config.
  const plain=await startSession();
  assert.equal("config" in plain.muse.sent("session/start")[0].params,false);
  await plain.session.close();
});

test("a host that did not grant session MCP servers is refused with the update message before any session opens, and stopped; with no servers to pass it starts",async()=>{
  const without=child=>new FakeMuse(child,{handlers:{initialize:()=>({...INIT,grantedCapabilities:[]})}});
  let fake=null;
  await assert.rejects(startSession({muse:child=>fake=without(child),options:{mcpServers:SERVERS}}),error=>error.message===muse.MUSE_SESSION_MCP_MESSAGE&&/Update Muse Code to a version that supports session MCP servers\./.test(error.message));
  assert.equal(fake.sent("session/start").length+fake.sent("session/resume").length,0,"no session was opened");
  assert.equal(fake.stdinEnded,true,"the host was stopped");
  const plain=await startSession({muse:without});
  assert.equal(plain.muse.sent("session/start").length,1);
  await plain.session.close();
});

test("through the relay, a Muse Code thread's session gets Trebell's repository tools and the person's own MCP server, on its start and on the resume a relaunch makes",{timeout:180_000},async()=>{
  const relay=await museRelay("trebell-muse-mcp-",{relayOptions:{contextEngine:{}},settings:{mcpServers:[{id:"muse-docs",name:"docs",runtime:"muse",command:process.execPath,args:["docs-mcp.mjs"],env:[{name:"DOCS_LOG",value:"debug"}]}]}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0",permissionProfile:"supervised"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello Muse"}],permissionProfile:"supervised"});
    await relay.completed(thread.id,1);
    // Full access runs on a host of its own: the conversation resumes there, with the same servers.
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Now with full access"}],permissionProfile:"full"});
    await relay.completed(thread.id,2);
    const [start]=await relay.frames("session/start"),[resume]=await relay.frames("session/resume");
    for(const frame of [start,resume]){
      const servers=frame.params.config?.mcpServers||{};
      assert.deepEqual(Object.keys(servers).sort(),["docs","trebell_repository"],frame.method);
      assert.deepEqual(servers.docs,{transport:"stdio",command:process.execPath,args:["docs-mcp.mjs"],env:{DOCS_LOG:"debug"},mode:"optional"});
      const repository=servers.trebell_repository;
      assert.deepEqual([repository.transport,repository.command,repository.args,repository.mode],["stdio",process.execPath,[repositoryMcpEntrypoint],"optional"]);
      assert.equal(resolve(repository.env.TREBELL_REPOSITORY_ROOT),resolve(relay.root));
    }
  }finally{await relay.close()}
});
