import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeRepositoryMcp, repositoryToolHandlers } from "../src/claude-repository-tools.mjs";

test("Claude repository tool handlers reuse the shared Context Engine",async()=>{
  const calls=[];const io={id:"remote-io"};
  const contextEngine={
    async searchSymbols(args){calls.push(["symbols",args]);return {data:[{name:"ContextEngine"}]}}
    ,async fileRelations(args){calls.push(["relations",args]);return {path:args.path}}
  };
  const handlers=repositoryToolHandlers({contextEngine,root:"/srv/app",io});
  assert.deepEqual(await handlers.searchSymbols({query:"ContextEngine",limit:7}),{data:[{name:"ContextEngine"}]});
  assert.deepEqual(await handlers.fileRelations({path:"src/context-engine.mjs"}),{path:"src/context-engine.mjs"});
  assert.deepEqual(calls,[
    ["symbols",{root:"/srv/app",io,query:"ContextEngine",limit:7}],
    ["relations",{root:"/srv/app",io,path:"src/context-engine.mjs"}],
  ]);
});

test("Claude repository MCP is an SDK-hosted server instead of a spawned duplicate index",()=>{
  const contextEngine={searchSymbols:async()=>({data:[]}),fileRelations:async()=>({})};
  const server=createClaudeRepositoryMcp({contextEngine,root:"/repo",version:"fixture"});
  assert.equal(server.type,"sdk");
  assert.equal(server.name,"trebell_repository");
  assert.ok(server.instance);
});
