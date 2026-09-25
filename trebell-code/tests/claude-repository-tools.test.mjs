import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeRepositoryMcp, repositoryToolHandlers } from "../src/claude-repository-tools.mjs";

test("Claude repository tool handlers reuse the shared Context Engine",async()=>{
  const calls=[];const io={id:"remote-io"};
  const contextEngine={
    async searchSymbols(args){calls.push(["symbols",args]);return {data:[{name:"ContextEngine"}]}}
    ,async fileRelations(args){calls.push(["relations",args]);return {path:args.path}}
    ,async searchCode(args){calls.push(["code",args]);return {data:[{path:"src/context-engine.mjs",line:1}]}}
    ,async readSourceRange(args){calls.push(["source",args]);return {path:args.path,startLine:args.startLine,endLine:args.endLine}}
    ,async gitContext(args){calls.push(["git",args]);return {isGit:true,changed:["src/context-engine.mjs"]}}
  };
  const handlers=repositoryToolHandlers({contextEngine,root:"/srv/app",io});
  assert.deepEqual(await handlers.searchSymbols({query:"ContextEngine",limit:7}),{data:[{name:"ContextEngine"}]});
  assert.deepEqual(await handlers.fileRelations({path:"src/context-engine.mjs"}),{path:"src/context-engine.mjs"});
  assert.deepEqual(await handlers.searchCode({query:"ContextEngine",regex:false,caseSensitive:true,limit:9}),{data:[{path:"src/context-engine.mjs",line:1}]});
  assert.deepEqual(await handlers.readSource({path:"src/context-engine.mjs",startLine:5,endLine:12,maxLines:20}),{path:"src/context-engine.mjs",startLine:5,endLine:12});
  assert.deepEqual(await handlers.gitContext(),{isGit:true,changed:["src/context-engine.mjs"]});
  assert.deepEqual(calls,[
    ["symbols",{root:"/srv/app",io,query:"ContextEngine",limit:7}],
    ["relations",{root:"/srv/app",io,path:"src/context-engine.mjs"}],
    ["code",{root:"/srv/app",io,query:"ContextEngine",regex:false,caseSensitive:true,limit:9}],
    ["source",{root:"/srv/app",io,path:"src/context-engine.mjs",startLine:5,endLine:12,maxLines:20}],
    ["git",{root:"/srv/app",io}],
  ]);
});

test("Claude repository MCP is an SDK-hosted server instead of a spawned duplicate index",()=>{
  const contextEngine={searchSymbols:async()=>({data:[]}),fileRelations:async()=>({}),searchCode:async()=>({data:[]}),readSourceRange:async()=>({}),gitContext:async()=>({})};
  const server=createClaudeRepositoryMcp({contextEngine,root:"/repo",version:"fixture"});
  assert.equal(server.type,"sdk");
  assert.equal(server.name,"trebell_repository");
  assert.ok(server.instance);
});
