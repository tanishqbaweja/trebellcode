import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeRepositoryMcp, repositoryToolHandlers } from "../src/claude-repository-tools.mjs";

test("Claude repository tool handlers reuse the shared Context Engine",async()=>{
  const calls=[];const io={id:"remote-io"};
  const contextEngine={
    async searchSymbols(args){calls.push(["symbols",args]);return {data:[{name:"ContextEngine"}]}}
    ,async searchFiles(args){calls.push(["files",args]);return {data:[{path:"src/context-engine.mjs"}]}}
    ,async repositoryMap(args){calls.push(["map",args]);return {data:[{path:"src/context-engine.mjs"}]}}
    ,async projectCommands(args){calls.push(["commands",args]);return {declared:[{command:"npm run test"}]}}
    ,async fileRelations(args){calls.push(["relations",args]);return {path:args.path}}
    ,async relatedTests(args){calls.push(["tests",args]);return {data:[{path:"tests/context-engine.test.mjs"}]}}
    ,async callHierarchy(args){calls.push(["calls",args]);return {name:args.name,callers:[{path:"src/server.mjs"}]}}
    ,async diagnostics(args){calls.push(["diagnostics",args]);return {path:args.path,supported:true,diagnostics:[]}}
    ,async languageSymbol(args){calls.push(["language",args]);return {path:args.path,operation:args.operation,data:[{path:"src/context-engine.mjs"}]}}
    ,async codeActions(args){calls.push(["actions",args]);return {path:args.path,actions:[{description:"Fix it"}]}}
    ,async symbolReferences(args){calls.push(["references",args]);return {name:args.name,data:[{path:"src/context-engine.mjs",line:1}]}}
    ,async searchCode(args){calls.push(["code",args]);return {data:[{path:"src/context-engine.mjs",line:1}]}}
    ,async readSourceRange(args){calls.push(["source",args]);return {path:args.path,startLine:args.startLine,endLine:args.endLine}}
    ,async gitContext(args){calls.push(["git",args]);return {isGit:true,changed:["src/context-engine.mjs"]}}
    ,async gitHistory(args){calls.push(["history",args]);return {data:[{commit:"abc"}]}}
    ,async gitBlame(args){calls.push(["blame",args]);return {path:args.path,data:[{line:args.startLine}]}}
  };
  const handlers=repositoryToolHandlers({contextEngine,root:"/srv/app",io});
  assert.deepEqual(await handlers.searchSymbols({query:"ContextEngine",limit:7}),{data:[{name:"ContextEngine"}]});
  assert.deepEqual(await handlers.searchFiles({query:"context-engine",limit:8}),{data:[{path:"src/context-engine.mjs"}]});
  assert.deepEqual(await handlers.repositoryMap({query:"context engine",limit:6}),{data:[{path:"src/context-engine.mjs"}]});
  assert.deepEqual(await handlers.projectCommands({limit:5}),{declared:[{command:"npm run test"}]});
  assert.deepEqual(await handlers.fileRelations({path:"src/context-engine.mjs"}),{path:"src/context-engine.mjs"});
  assert.deepEqual(await handlers.relatedTests({path:"src/context-engine.mjs",name:null,limit:4}),{data:[{path:"tests/context-engine.test.mjs"}]});
  assert.deepEqual(await handlers.callHierarchy({name:"ContextEngine",path:"src/context-engine.mjs",limit:5}),{name:"ContextEngine",callers:[{path:"src/server.mjs"}]});
  assert.deepEqual(await handlers.diagnostics({path:"src/context-engine.mjs",limit:6}),{path:"src/context-engine.mjs",supported:true,diagnostics:[]});
  assert.deepEqual(await handlers.languageSymbol({path:"src/context-engine.mjs",line:50,column:3,operation:"definition",limit:4}),{path:"src/context-engine.mjs",operation:"definition",data:[{path:"src/context-engine.mjs"}]});
  assert.deepEqual(await handlers.codeActions({path:"src/context-engine.mjs",line:50,column:3,limit:4,codes:[2322]}),{path:"src/context-engine.mjs",actions:[{description:"Fix it"}]});
  assert.deepEqual(await handlers.symbolReferences({name:"ContextEngine",path:"src/context-engine.mjs",limit:11}),{name:"ContextEngine",data:[{path:"src/context-engine.mjs",line:1}]});
  assert.deepEqual(await handlers.searchCode({query:"ContextEngine",regex:false,caseSensitive:true,limit:9}),{data:[{path:"src/context-engine.mjs",line:1}]});
  assert.deepEqual(await handlers.readSource({path:"src/context-engine.mjs",startLine:5,endLine:12,maxLines:20}),{path:"src/context-engine.mjs",startLine:5,endLine:12});
  assert.deepEqual(await handlers.gitContext(),{isGit:true,changed:["src/context-engine.mjs"]});
  assert.deepEqual(await handlers.gitHistory({path:"src/context-engine.mjs",limit:3}),{data:[{commit:"abc"}]});
  assert.deepEqual(await handlers.gitBlame({path:"src/context-engine.mjs",startLine:5,endLine:8,maxLines:9}),{path:"src/context-engine.mjs",data:[{line:5}]});
  assert.deepEqual(calls,[
    ["symbols",{root:"/srv/app",io,query:"ContextEngine",limit:7}],
    ["files",{root:"/srv/app",io,query:"context-engine",limit:8}],
    ["map",{root:"/srv/app",io,query:"context engine",limit:6}],
    ["commands",{root:"/srv/app",io,limit:5}],
    ["relations",{root:"/srv/app",io,path:"src/context-engine.mjs"}],
    ["tests",{root:"/srv/app",io,path:"src/context-engine.mjs",name:null,limit:4}],
    ["calls",{root:"/srv/app",io,name:"ContextEngine",path:"src/context-engine.mjs",limit:5}],
    ["diagnostics",{root:"/srv/app",io,path:"src/context-engine.mjs",limit:6,semantic:false}],
    ["language",{root:"/srv/app",io,path:"src/context-engine.mjs",line:50,column:3,operation:"definition",limit:4}],
    ["actions",{root:"/srv/app",io,path:"src/context-engine.mjs",line:50,column:3,limit:4,codes:[2322]}],
    ["references",{root:"/srv/app",io,name:"ContextEngine",path:"src/context-engine.mjs",limit:11}],
    ["code",{root:"/srv/app",io,query:"ContextEngine",regex:false,caseSensitive:true,limit:9}],
    ["source",{root:"/srv/app",io,path:"src/context-engine.mjs",startLine:5,endLine:12,maxLines:20}],
    ["git",{root:"/srv/app",io}],
    ["history",{root:"/srv/app",io,path:"src/context-engine.mjs",limit:3}],
    ["blame",{root:"/srv/app",io,path:"src/context-engine.mjs",startLine:5,endLine:8,maxLines:9}],
  ]);
});

test("Claude repository MCP is an SDK-hosted server instead of a spawned duplicate index",()=>{
  const contextEngine={searchSymbols:async()=>({data:[]}),searchFiles:async()=>({data:[]}),repositoryMap:async()=>({data:[]}),projectCommands:async()=>({declared:[]}),fileRelations:async()=>({}),relatedTests:async()=>({data:[]}),callHierarchy:async()=>({callers:[],callees:[]}),diagnostics:async()=>({diagnostics:[]}),languageSymbol:async()=>({data:[]}),codeActions:async()=>({actions:[]}),symbolReferences:async()=>({data:[]}),searchCode:async()=>({data:[]}),readSourceRange:async()=>({}),gitContext:async()=>({}),gitHistory:async()=>({data:[]}),gitBlame:async()=>({data:[]})};
  const server=createClaudeRepositoryMcp({contextEngine,root:"/repo",version:"fixture"});
  assert.equal(server.type,"sdk");
  assert.equal(server.name,"trebell_repository");
  assert.ok(server.instance);
});
