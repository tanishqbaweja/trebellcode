import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession, discoverOpenCode2ModelCatalog, discoverOpenCodeModelCatalog } from "../src/opencode-agent-session.mjs";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { fakeOpenCode1Catalog, fakeOpenCode2Catalog, openCodeModels as models } from "./fixtures/fake-opencode-catalog-servers.mjs";

// OpenCode's command, skill and agent lists. OpenCode lists MCP prompts among its commands, which can take long (an MCP server that is
// slow to start): a catalog read waits for each list at most ten seconds, and a session's start waits for none but the agents.
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=5000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(10)}
}
// Fails a wait that the code under test would never end.
const within=(promise,ms,what)=>Promise.race([promise,delay(ms).then(()=>{throw new Error(`${what} took longer than ${ms} ms`)})]);

test("an OpenCode command list that does not answer holds discovery at most ten seconds and is marked pending, for both server generations",async()=>{
  const never=()=>{};
  const v1=await fakeOpenCode1Catalog({routes:{"GET /command":never}}),v2=await fakeOpenCode2Catalog({routes:{"GET /api/command":never}});
  try{
    const startedAt=Date.now();
    const [first,second]=await within(Promise.all([
      discoverOpenCodeModelCatalog({cwd:"/repo",serverUrl:v1.url,env:{},readText:async()=>null}),
      discoverOpenCode2ModelCatalog({cwd:"/repo",serverUrl:v2.url,env:{}}),
    ]),20_000,"discovery with a command list that never answers");
    const elapsed=Date.now()-startedAt;assert.ok(elapsed>=9_000&&elapsed<15_000,`discovery took ${elapsed} ms`);
    assert.deepEqual([first.pending,first.inventory.commands,first.inventory.skills.map(item=>item.name),first.inventory.agents.map(item=>item.name)],[["commands"],[],["pdf"],["build"]]);
    assert.deepEqual([second.pending,second.inventory.commands,second.models.length],[["commands"],[],2]);
  }finally{await v1.close();await v2.close()}
});

test("an OpenCode session starts without waiting for its command list, and the list reaches the composer once OpenCode answers it",async()=>{
  let answer=null;const held=new Promise(resolve=>{answer=resolve});
  const fixture=await fakeOpenCode1Catalog({routes:{"GET /command":async({json})=>json(await held)}});
  const updates=[],session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fixture.url,onUpdate:params=>updates.push(params.update)});
  try{
    const startedAt=Date.now();
    await within(session.start({model:"opencode/big-pickle"}),5000,"the session's start");
    assert.ok(Date.now()-startedAt<5000);
    const info=()=>updates.filter(update=>update.sessionUpdate==="session_info_update");
    // The agents' folders are in the session's rules; the first update has the agents and skills, and no commands yet.
    await eventually(()=>info().some(update=>update.skills));
    const first=info()[0];
    assert.deepEqual([first.agents.map(agent=>agent.name),"commands" in first,first.status],[["build"],false,{type:"idle"}]);
    assert.ok(session.trustedDirectories.includes("/tmp/opencode/*"));
    answer([{name:"review",description:"Review the diff"}]);
    const listed=await eventually(()=>info().find(update=>update.commands));
    assert.deepEqual([listed.commands.map(item=>item.name),listed.agents.map(agent=>agent.name),listed.skills.map(item=>item.name)],[["review"],["build"],["pdf"]]);
  }finally{answer?.([]);await session.close();await fixture.close()}
});

test("an OpenCode 2 session starts without waiting for its command, skill and agent lists, and each reaches the composer once listed",async()=>{
  let answerCommands=null;const commands=new Promise(resolve=>{answerCommands=resolve});
  const client={
    server:{info:async()=>({version:"2.0.24"})},
    model:{list:async()=>({data:models(1)}),default:async()=>({data:null})},
    command:{list:()=>commands},skill:{list:async()=>({data:[{id:"pdf",name:"pdf"}]})},agent:{list:async()=>({data:[{id:"build",name:"Build",mode:"primary"}]})},
    session:{create:async()=>({id:"ses_main",agent:"build"}),instructions:{entry:{put:async()=>undefined}},switchAgent:async()=>undefined,switchModel:async()=>undefined,update:async()=>undefined,prompt:async()=>({id:"msg_user"}),interrupt:async()=>({})},
    message:{list:async()=>({data:[]})},
    event:{subscribe:({signal}={})=>({async*[Symbol.asyncIterator](){await new Promise(resolve=>signal?.addEventListener("abort",resolve,{once:true}))}})},
  };
  const updates=[],session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:async()=>({OpenCode:{make:()=>client}}),onUpdate:params=>updates.push(params.update)});
  try{
    await within(session.start({}),5000,"the OpenCode 2 session's start");
    const info=()=>updates.filter(update=>update.sessionUpdate==="session_info_update");
    await eventually(()=>info().some(update=>update.agents&&update.skills));
    assert.equal(info().some(update=>update.commands),false);
    assert.equal(session.agentIds.get("Build"),"build","a turn's agent goes by its id");
    answerCommands({data:[{name:"review"}]});
    const listed=await eventually(()=>info().find(update=>update.commands));
    assert.deepEqual([listed.commands.map(item=>item.name),listed.agents.map(agent=>agent.name),listed.skills.map(item=>item.name)],[["review"],["Build"],["pdf"]]);
  }finally{answerCommands?.({data:[]});await session.close()}
});
