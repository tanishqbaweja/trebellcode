import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client } from "./fixtures/fake-opencode2-client.mjs";

// OpenCode 2 keeps the MCP servers a client adds at runtime per folder, and drops them when it evicts a folder that sat idle: a
// thread left idle lost Trebell's repository tools for good, as Trebell added them once, when the session started.
const REPOSITORY_MCP={name:"trebell_repository",command:"node",args:["repository-mcp-stdio.mjs"],openCode:{type:"local",command:["node","repository-mcp-stdio.mjs"],environment:{TREBELL_REPOSITORY_ROOT:"/repo",PORT:3000},enabled:true,timeout:15_000}};
const ADDED={server:"trebell_repository",location:{directory:"/repo"},config:{type:"local",command:["node","repository-mcp-stdio.mjs"],environment:{TREBELL_REPOSITORY_ROOT:"/repo",PORT:"3000"},disabled:false,timeout:{startup:15_000}}};
const ended=fake=>fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
const order=fake=>fake.calls.map(entry=>entry.name).filter(name=>name==="mcp.add"||name==="session.prompt");

async function startedSession(fake){
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,repositoryMcp:REPOSITORY_MCP,onUpdate:()=>{}});
  await session.start({});
  return session;
}

test("an OpenCode 2 thread adds Trebell's repository MCP again, with the same config, before each of its turns",async()=>{
  const fake=fakeOpenCode2Client(),session=await startedSession(fake);
  try{
    assert.deepEqual(fake.called("mcp.add"),[ADDED],"the session adds it as it starts");
    for(const [index,text] of ["First","Second"].entries()){
      const turn=session.prompt([{type:"text",text}]);
      await eventually(()=>fake.called("session.prompt").length===index+1);
      ended(fake);assert.equal((await turn).stopReason,"end_turn");
    }
    // Each turn's add comes before its prompt, so a folder OpenCode evicted while the thread sat idle has the tools again.
    assert.deepEqual(order(fake),["mcp.add","mcp.add","session.prompt","mcp.add","session.prompt"]);
    assert.deepEqual(fake.called("mcp.add"),[ADDED,ADDED,ADDED]);
    assert.deepEqual(session.repositoryMcpStatus,[{name:"trebell_repository",configured:true,status:"connected"}]);
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose MCP add fails is still sent, and the session's MCP status says why until an add works again",async()=>{
  let refuse=false;
  const fake=fakeOpenCode2Client({overrides:{"mcp.add":async()=>{if(refuse)throw Object.assign(new Error("MCP server trebell_repository could not be added"),{name:"McpError"})}}});
  const session=await startedSession(fake);
  try{
    const first=session.prompt([{type:"text",text:"First"}]);
    await eventually(()=>fake.called("session.prompt").length===1);ended(fake);await first;
    refuse=true;
    const second=session.prompt([{type:"text",text:"Second"}]);
    await eventually(()=>fake.called("session.prompt").length===2);
    assert.deepEqual(order(fake),["mcp.add","mcp.add","session.prompt","mcp.add","session.prompt"]);
    assert.deepEqual(fake.called("session.prompt")[1],{sessionID:"ses_main",text:"Second"});
    assert.deepEqual(session.repositoryMcpStatus,[{name:"trebell_repository",configured:false,error:"MCP server trebell_repository could not be added"}]);
    assert.deepEqual(session.sessionSetup.trebellRepositoryMcp,{name:"trebell_repository",configured:false,error:"MCP server trebell_repository could not be added"});
    ended(fake);assert.equal((await second).stopReason,"end_turn","the turn goes on without the tools");
    refuse=false;
    const third=session.prompt([{type:"text",text:"Third"}]);
    await eventually(()=>fake.called("session.prompt").length===3);ended(fake);await third;
    assert.deepEqual(session.repositoryMcpStatus,[{name:"trebell_repository",configured:true,status:"connected"}]);
  }finally{await session.close()}
});
