import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ContextEngine, createRemoteContextIo, pageRank, parseSource, planContextBudget } from "../src/context-engine.mjs";

test("JavaScript and TypeScript structure uses a real parser with graceful regex fallback",()=>{
  const parsed=parseSource(`
import {
  rotateRefreshToken as rotate,
  type Token,
} from "./token.js";
export { verifyToken } from "./token.js";
export interface SessionOptions { token: Token }
export type SessionState = "fresh" | "expired";
export enum SessionMode { Strict, Relaxed }
export const createSession =
  (options: SessionOptions) => rotate(options.token);
const misleading = "GhostSymbol";
// GhostComment should not become a reference either.
`,"src/session.ts");
  assert.equal(parsed.parser,"babel");
  assert.deepEqual(parsed.imports,["./token.js"]);
  const definitions=new Map(parsed.definitions.map(item=>[item.name,item.kind]));
  assert.equal(definitions.get("SessionOptions"),"interface");
  assert.equal(definitions.get("SessionState"),"type");
  assert.equal(definitions.get("SessionMode"),"enum");
  assert.equal(definitions.get("createSession"),"function");
  assert.ok(parsed.references.has("rotateRefreshToken"),"aliased import should retain the exported symbol relationship");
  assert.equal(parsed.references.has("GhostSymbol"),false,"string contents must not create structural references");
  assert.equal(parsed.references.has("GhostComment"),false,"comments must not create structural references");

  const fallback=parseSource("function broken( {", "src/broken.js");
  assert.equal(fallback.parser,"regex");
  assert.ok(fallback.definitions.some(item=>item.name==="broken"));
});

test("context budgeting is deterministic and shrinks repository injection as the active context fills",()=>{
  const focused=planContextBudget({task:"Rename the save button"});
  assert.equal(focused.mode,"focused");assert.equal(focused.maxTokens,2800);assert.equal(focused.maxFiles,12);
  const broad=planContextBudget({task:"Refactor the repository architecture end-to-end across the codebase, integrations, tests, and runtime adapters so the system-wide context flow is consistent.",focusPaths:["a.js","b.js","c.js","d.js","e.js"]});
  assert.equal(broad.mode,"broad");assert.equal(broad.maxTokens,7000);assert.equal(broad.maxFiles,24);
  const tight=planContextBudget({task:"Continue the refactor",tokensUsed:75_000,contextWindow:100_000});
  assert.equal(tight.mode,"tight");assert.equal(tight.maxTokens,2800);assert.equal(tight.maxFiles,12);assert.equal(tight.utilizationPercent,75);
  const critical=planContextBudget({task:"Continue",tokensUsed:90_000,contextWindow:100_000});
  assert.equal(critical.mode,"critical");assert.equal(critical.maxTokens,1600);assert.equal(critical.maxFiles,8);assert.equal(critical.skip,false);
  const exhausted=planContextBudget({task:"Continue",tokensUsed:93_000,contextWindow:100_000});
  assert.equal(exhausted.mode,"exhausted");assert.equal(exhausted.maxTokens,0);assert.equal(exhausted.maxFiles,0);assert.equal(exhausted.skip,true);
  assert.equal(exhausted.remainingTokens,7000);assert.equal(exhausted.reserveTokens,8000);
  const explicit=planContextBudget({task:"Continue",tokensUsed:90_000,contextWindow:100_000,maxTokens:1900,maxFiles:9});
  assert.equal(explicit.maxTokens,1600);assert.equal(explicit.maxFiles,8);assert.equal(explicit.cappedByCaller,false);
  const capped=planContextBudget({task:"Refactor repository architecture",maxTokens:1200,maxFiles:6});
  assert.equal(capped.maxTokens,1200);assert.equal(capped.maxFiles,6);assert.equal(capped.cappedByCaller,true);
});

test("exhausted context budget skips repository I/O entirely",async()=>{
  const engine=new ContextEngine();let touched=false;
  const io={
    root:"/srv/app",cacheKey:"fixture:/srv/app",
    discoverFiles:async()=>{touched=true;return []},
    metadata:async()=>{touched=true;return new Map()},
    readMany:async()=>{touched=true;return new Map()},
    readText:async()=>{touched=true;return ""},
    gitState:async()=>{touched=true;return {isGit:true,changed:new Set(),status:"",diff:""}},
    relativeFocus:path=>path,
  };
  const packet=await engine.buildPacket({root:"/srv/app",io,task:"Continue",tokensUsed:93_000,contextWindow:100_000});
  assert.equal(packet.skipped,true);assert.equal(packet.injection,"");assert.equal(packet.tokenEstimate,0);
  assert.equal(packet.stats.skippedByPressure,true);assert.equal(touched,false);
});

const execFileAsync=promisify(execFile);

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"trebell-context-"));
  await mkdir(join(root,"src","auth"),{recursive:true});
  await mkdir(join(root,"tests"),{recursive:true});
  await writeFile(join(root,"AGENTS.md"),"Keep authentication changes covered by tests.\n","utf8");
  await writeFile(join(root,"src","auth","token.js"),`export function rotateRefreshToken(token) {\n  return token + "-rotated";\n}\nexport function verifyToken(token) { return Boolean(token); }\n`,"utf8");
  await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession {\n  refresh(token) { return rotateRefreshToken(token); }\n}\n`,"utf8");
  await writeFile(join(root,"src","server.js"),`import { RefreshSession } from "./auth/session.js";\nexport function startServer() { return new RefreshSession(); }\n`,"utf8");
  await writeFile(join(root,"tests","auth-refresh.test.js"),`import { RefreshSession } from "../src/auth/session.js";\nexport function testRefresh() { return new RefreshSession().refresh("x"); }\n`,"utf8");
  await execFileAsync("git",["init","-q"],{cwd:root});
  await execFileAsync("git",["add","."],{cwd:root});
  return root;
}

test("context engine ranks task-relevant code, instructions and tests under a hard budget",async()=>{
  const root=await fixture();
  try{
    const engine=new ContextEngine();
    const packet=await engine.buildPacket({root,task:"Fix the refresh token session bug",maxTokens:1800,maxFiles:8});
    assert.ok(packet.tokenEstimate<=1800,`packet used ${packet.tokenEstimate} tokens`);
    assert.match(packet.injection,/Keep authentication changes covered by tests/);
    const paths=packet.items.map(item=>item.path);
    assert.ok(paths.includes("src/auth/session.js"),paths.join(", "));
    assert.ok(paths.includes("src/auth/token.js"),paths.join(", "));
    assert.ok(paths.includes("tests/auth-refresh.test.js"),paths.join(", "));
    const session=packet.items.find(item=>item.path==="src/auth/session.js");
    assert.equal(session.parser,"babel");
    assert.ok(session.reasons.some(reason=>/task-related symbol|task terms|path matches/i.test(reason)));
    assert.ok(packet.stats.graphEdges>=3);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine exposes deterministic symbol and file relationship queries",async()=>{
  const root=await fixture();
  try{
    const engine=new ContextEngine();
    const symbols=await engine.searchSymbols({root,query:"RefreshSession"});
    assert.equal(symbols.data[0].path,"src/auth/session.js");
    assert.equal(symbols.data[0].name,"RefreshSession");
    assert.equal(symbols.data[0].kind,"class");
    assert.equal(symbols.data[0].parser,"babel");

    const files=await engine.searchFiles({root,query:"session"});
    assert.ok(files.data.some(item=>item.path==="src/auth/session.js"&&item.indexedSource===true));
    const repoMap=await engine.repositoryMap({root,query:"refresh session",limit:8});
    assert.ok(repoMap.graphEdges>=3);
    assert.ok(repoMap.data.some(item=>item.path==="src/auth/session.js"&&item.definitions.some(definition=>definition.name==="RefreshSession")));
    assert.ok(repoMap.data.some(item=>item.path==="src/auth/token.js"));

    const relations=await engine.fileRelations({root,path:"src/auth/session.js"});
    assert.ok(relations.imports.some(item=>item.specifier==="./token.js"&&item.target==="src/auth/token.js"));
    assert.ok(relations.importers.some(item=>item.path==="src/server.js"));
    assert.ok(relations.importers.some(item=>item.path==="tests/auth-refresh.test.js"));
    assert.ok(relations.referencedSymbols.some(item=>item.name==="rotateRefreshToken"&&item.target==="src/auth/token.js"));
    assert.ok(relations.referencedBy.some(item=>item.name==="RefreshSession"&&item.path==="src/server.js"));
    assert.deepEqual(relations.relatedTests,["tests/auth-refresh.test.js"]);
    const references=await engine.symbolReferences({root,name:"RefreshSession"});
    assert.ok(references.data.some(item=>item.path==="src/auth/session.js"&&item.definition===true&&item.precision==="ast"));
    assert.ok(references.data.some(item=>item.path==="src/server.js"&&item.line===2&&item.definition===false&&item.precision==="ast"));
    assert.ok(references.data.some(item=>item.path==="tests/auth-refresh.test.js"&&item.precision==="ast"));
    const relatedByPath=await engine.relatedTests({root,path:"src/auth/session.js"});
    assert.deepEqual(relatedByPath.data.map(item=>item.path),["tests/auth-refresh.test.js"]);
    const relatedBySymbol=await engine.relatedTests({root,name:"RefreshSession"});
    assert.deepEqual(relatedBySymbol.data.map(item=>item.path),["tests/auth-refresh.test.js"]);
    await assert.rejects(()=>engine.relatedTests({root}),/path or symbol name/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine exposes bounded code search, source ranges, and Git context",async()=>{
  const root=await fixture();
  try{
    const padding="// filler line\n".repeat(5200),marker="export const DistantNeedle = 42;\n";
    await writeFile(join(root,"src","large.js"),padding+marker,"utf8");
    await execFileAsync("git",["add","src/large.js"],{cwd:root});
    const engine=new ContextEngine();
    const literal=await engine.searchCode({root,query:"distantneedle",limit:10});
    assert.equal(literal.source,"git-grep");
    assert.equal(literal.data.length,1);
    assert.equal(literal.data[0].path,"src/large.js");
    assert.ok(literal.data[0].line>5000,"search must inspect the full indexed file, not only the 64 KB cache sample");
    const regex=await engine.searchCode({root,query:"DistantNeedle\\s*=\\s*42",regex:true,caseSensitive:true,limit:10});
    assert.equal(regex.data[0].line,literal.data[0].line);

    const source=await engine.readSourceRange({root,path:"src/large.js",startLine:literal.data[0].line,endLine:literal.data[0].line+20,maxLines:4});
    assert.equal(source.startLine,literal.data[0].line);
    assert.ok(source.endLine-source.startLine<4);
    assert.match(source.content,/DistantNeedle = 42/);
    await assert.rejects(()=>engine.readSourceRange({root,path:"../outside.js",startLine:1}),/not indexed/i);

    await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession { refresh(token) { return rotateRefreshToken(token); } }\nexport const gitContextMarker = true;\n`,"utf8");
    const git=await engine.gitContext({root});
    assert.equal(git.isGit,true);
    assert.ok(git.changed.includes("src/auth/session.js"));
    assert.match(git.status,/src\/auth\/session\.js/);
    assert.match(git.diff,/gitContextMarker/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine exposes bounded Git history and blame",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-qm","Initial fixture"],{cwd:root});
    await writeFile(join(root,"src","auth","session.js"),"import { rotateRefreshToken } from \"./token.js\";\nexport class RefreshSession {\n  refresh(token) { return rotateRefreshToken(token); }\n}\n// second revision\n","utf8");
    await execFileAsync("git",["add","src/auth/session.js"],{cwd:root});
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-qm","Update refresh session"],{cwd:root});
    const engine=new ContextEngine(),history=await engine.gitHistory({root,path:"src/auth/session.js",limit:5});
    assert.equal(history.data.length,2);assert.equal(history.data[0].subject,"Update refresh session");assert.equal(history.data[1].subject,"Initial fixture");
    const blame=await engine.gitBlame({root,path:"src/auth/session.js",startLine:1,endLine:5,maxLines:5});
    assert.equal(blame.data.length,5);assert.equal(blame.data[0].author,"Trebell Test");assert.equal(blame.data.at(-1).text,"// second revision");assert.equal(blame.data.at(-1).summary,"Update refresh session");
    await assert.rejects(()=>engine.gitHistory({root,path:"../outside.txt"}),/outside or unknown/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("large scoped repository instructions are bounded without dropping nested guidance",async()=>{
  const root=await fixture();
  try{
    await writeFile(join(root,"AGENTS.md"),"ROOT_SENTINEL keep authentication behavior safe.\n"+"root guidance filler\n".repeat(900),"utf8");
    await writeFile(join(root,"src","auth","AGENTS.md"),"NESTED_SENTINEL auth files require refresh-token coverage.\n"+"nested guidance filler\n".repeat(500),"utf8");
    const packet=await new ContextEngine().buildPacket({root,task:"Fix the refresh token session bug",maxTokens:1200,maxFiles:6});
    assert.ok(packet.tokenEstimate<=1200,`packet used ${packet.tokenEstimate} tokens`);
    assert.match(packet.injection,/ROOT_SENTINEL/);
    assert.match(packet.injection,/NESTED_SENTINEL/);
    assert.match(packet.injection,/nested files override broader guidance/);
    assert.match(packet.injection,/truncated by Trebell context budget/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine reuses unchanged files and reparses only changed files",async()=>{
  const root=await fixture();
  try{
    const engine=new ContextEngine();
    const first=await engine.buildPacket({root,task:"refresh session"});
    assert.ok(first.stats.reparsed>=4);
    const second=await engine.buildPacket({root,task:"refresh session"});
    assert.equal(second.stats.reparsed,0);
    assert.ok(second.stats.reused>=4);
    await new Promise(resolve=>setTimeout(resolve,20));
    await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession { refresh(token) { return rotateRefreshToken(token); } }\nexport const changed = true;\n`,"utf8");
    const third=await engine.buildPacket({root,task:"refresh session"});
    assert.equal(third.stats.reparsed,1);
    assert.ok(third.stats.reused>=3);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("clean Git workspaces skip per-file metadata scans after the first context packet",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","baseline","-q"],{cwd:root});
    const engine=new ContextEngine();
    const first=await engine.buildPacket({root,task:"refresh session"});
    assert.ok(first.stats.inspected>=4);
    const second=await engine.buildPacket({root,task:"refresh session"});
    assert.equal(second.stats.inspected,0);
    assert.equal(second.stats.reparsed,0);
    assert.ok(second.stats.reused>=4);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context cache invalidates clean tracked files when Git HEAD changes",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","baseline","-q"],{cwd:root});
    const engine=new ContextEngine();
    const first=await engine.buildPacket({root,task:"refresh session revision marker",maxTokens:1800,maxFiles:8});
    assert.equal(first.stats.revisionChanged,false);
    await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession { refresh(token) { return rotateRefreshToken(token); } }\nexport const revisionMarker = "HEAD_TWO_MARKER";\n`,"utf8");
    await execFileAsync("git",["add","src/auth/session.js"],{cwd:root});
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","second","-q"],{cwd:root});
    const second=await engine.buildPacket({root,task:"refresh session revisionMarker",maxTokens:1800,maxFiles:8});
    assert.equal(second.stats.revisionChanged,true);
    assert.equal(second.stats.revisionDiffUsed,true);
    assert.equal(second.stats.inspected,1,"a clean one-file revision change should only inspect the changed source path");
    assert.equal(second.stats.reparsed,1);
    assert.match(second.injection,/HEAD_TWO_MARKER/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context cache rechecks files that were dirty when they become clean at the same HEAD",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","baseline","-q"],{cwd:root});
    const engine=new ContextEngine();
    await engine.buildPacket({root,task:"refresh session reset marker",maxTokens:1800,maxFiles:8});
    await writeFile(join(root,"src","auth","session.js"),`export class RefreshSession {}\nexport const dirtyResetMarker = "DIRTY_CACHE_MARKER";\n`,"utf8");
    const dirty=await engine.buildPacket({root,task:"refresh session dirtyResetMarker",maxTokens:1800,maxFiles:8});
    assert.match(dirty.injection,/DIRTY_CACHE_MARKER/);
    await execFileAsync("git",["checkout","--","src/auth/session.js"],{cwd:root});
    const restored=await engine.buildPacket({root,task:"refresh session dirtyResetMarker",maxTokens:1800,maxFiles:8});
    assert.equal(restored.stats.revisionChanged,false);
    assert.equal(restored.stats.reparsed,1,"the previously dirty path must be re-read after reset");
    assert.doesNotMatch(restored.injection,/DIRTY_CACHE_MARKER/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("weighted PageRank makes depended-on files more central",()=>{
  const nodes=["server.js","session.js","token.js"];
  const edges=new Map([
    ["server.js",new Map([["session.js",4]])],
    ["session.js",new Map([["token.js",4]])],
  ]);
  const rank=pageRank(nodes,edges,new Map(nodes.map(node=>[node,1])));
  assert.ok(rank.get("token.js")>rank.get("server.js"));
});

test("remote context indexing uses bounded environment I/O and reuses unchanged source files",async()=>{
  const root="/srv/app";
  const files=new Map([
    ["AGENTS.md","Keep authentication changes covered by tests.\n"],
    ["src/auth/token.js",'export function rotateRefreshToken(token) {\n  return token + "-rotated";\n}\n'],
    ["src/auth/session.js",'import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession {\n  refresh(token) { return rotateRefreshToken(token); }\n}\n'],
    ["src/server.js",'import { RefreshSession } from "./auth/session.js";\nexport function startServer() { return new RefreshSession(); }\n'],
    ["tests/auth-refresh.test.js",'import { RefreshSession } from "../src/auth/session.js";\nexport function testRefresh() { return new RefreshSession().refresh("x"); }\n'],
  ]);
  const versions=new Map([...files.keys()].map(path=>[path,"v1"]));let status="",metadataCalls=0,contentCalls=0;
  const ok=stdout=>({exitCode:0,stdout,stderr:"",timedOut:false});
  const environments={
    async executeArgv(_id,{command,args=[]}){
      if(command==="git"&&args.includes("ls-files"))return ok([...files.keys()].join("\0")+"\0");
      if(command==="git"&&args.includes("grep")){
        const pattern=String(args[args.indexOf("-e")+1]||"").toLowerCase();
        const matches=[...files].filter(([,content])=>String(content).toLowerCase().includes(pattern)).map(([path])=>path);
        return matches.length?ok(matches.join("\0")+"\0"):{exitCode:1,stdout:"",stderr:"",timedOut:false};
      }
      if(command==="git"&&args.includes("log"))return ok("\x1e"+"a".repeat(40)+"\x1fRemote Tester\x1fremote@example.test\x1f1700000000\x1fRemote history\n");
      if(command==="git"&&args.includes("blame"))return ok("b".repeat(40)+" 1 1 1\nauthor Remote Tester\nauthor-mail <remote@example.test>\nauthor-time 1700000000\nsummary Remote history\nfilename src/auth/session.js\n\timport { rotateRefreshToken } from \"./token.js\";\n");
      if(command==="git"&&args.includes("status"))return ok(status);
      if(command==="git"&&args.includes("diff"))return ok(status?"diff --git a/src/auth/session.js b/src/auth/session.js\n":"");
      if(command==="git"&&args.includes("rev-parse"))return ok("remote-head-1\n");
      if(command==="head"){
        const target=String(args.at(-1)||""),relativePath=target.slice(root.length+1);
        return files.has(relativePath)?ok(files.get(relativePath)):({exitCode:1,stdout:"",stderr:"missing",timedOut:false});
      }
      return {exitCode:1,stdout:"",stderr:"unexpected "+command,timedOut:false};
    },
    async executeArgvInput(_id,{command,args=[],input=""}){
      assert.equal(command,"bash");const script=String(args[1]||"");
      const paths=String(input).split("\0").filter(Boolean).map(path=>path.replace(/^\.\//,""));
      if(script.includes("stat -c")){
        metadataCalls++;
        return ok(paths.filter(path=>files.has(path)).map(path=>[
          Buffer.byteLength(files.get(path),"utf8"),
          versions.get(path),
          Buffer.from(path,"utf8").toString("base64"),
        ].join("\t")).join("\n")+"\n");
      }
      contentCalls++;
      return ok(paths.filter(path=>files.has(path)).map(path=>[
        Buffer.from(path,"utf8").toString("base64"),
        Buffer.from(files.get(path),"utf8").toString("base64"),
      ].join("\t")).join("\n")+"\n");
    },
  };
  const io=createRemoteContextIo({environments,environmentId:"ssh-fixture",root});
  const engine=new ContextEngine();
  const first=await engine.buildPacket({root,io,task:"Fix the refresh token session bug",maxTokens:1800,maxFiles:8});
  assert.equal(first.stats.remote,true);assert.ok(first.stats.reparsed>=4);assert.match(first.injection,/Keep authentication changes covered by tests/);
  assert.ok(first.items.some(item=>item.path==="src/auth/session.js"));
  const afterFirstMetadata=metadataCalls,afterFirstContent=contentCalls;
  const second=await engine.buildPacket({root,io,task:"Fix the refresh token session bug",maxTokens:1800,maxFiles:8});
  assert.equal(second.stats.reparsed,0);assert.ok(second.stats.reused>=4);
  assert.equal(metadataCalls,afterFirstMetadata,"clean Git state should not restat cached remote source files");
  assert.equal(contentCalls,afterFirstContent,"clean remote packets should reuse indexed source samples instead of rereading candidate files");
  const remoteSearch=await engine.searchCode({root,io,query:"rotateRefreshToken",limit:10});
  assert.equal(remoteSearch.source,"git-grep");assert.ok(remoteSearch.data.some(item=>item.path==="src/auth/session.js"));
  const remoteFiles=await engine.searchFiles({root,io,query:"session"});
  assert.ok(remoteFiles.data.some(item=>item.path==="src/auth/session.js"));
  const remoteMap=await engine.repositoryMap({root,io,query:"refresh session",limit:8});
  assert.ok(remoteMap.graphEdges>=3);assert.ok(remoteMap.data.some(item=>item.path==="src/auth/session.js"));
  const remoteTests=await engine.relatedTests({root,io,path:"src/auth/session.js"});
  assert.deepEqual(remoteTests.data.map(item=>item.path),["tests/auth-refresh.test.js"]);
  const remoteSource=await engine.readSourceRange({root,io,path:"src/auth/session.js",startLine:1,endLine:2});
  assert.match(remoteSource.content,/rotateRefreshToken/);assert.equal(remoteSource.endLine,2);
  const remoteReferences=await engine.symbolReferences({root,io,name:"RefreshSession",limit:10});
  assert.ok(remoteReferences.data.some(item=>item.path==="src/server.js"&&item.precision==="ast"));
  const remoteHistory=await engine.gitHistory({root,io,path:"src/auth/session.js",limit:3});
  assert.equal(remoteHistory.data[0].subject,"Remote history");
  const remoteBlame=await engine.gitBlame({root,io,path:"src/auth/session.js",startLine:1,endLine:1,maxLines:1});
  assert.equal(remoteBlame.data[0].author,"Remote Tester");
  files.set("src/auth/session.js",files.get("src/auth/session.js")+"export const changed = true;\n");versions.set("src/auth/session.js","v2");status=" M src/auth/session.js\n";
  const third=await engine.buildPacket({root,io,task:"refresh session",maxTokens:1800,maxFiles:8});
  assert.equal(third.stats.reparsed,1);assert.ok(third.stats.reused>=3);
  const remoteGit=await engine.gitContext({root,io});assert.equal(remoteGit.isGit,true);assert.ok(remoteGit.changed.includes("src/auth/session.js"));
});

test("context excerpts fall back to the full file when a relevant symbol is beyond the cached sample",async()=>{
  const root="/srv/large",padding="// padding\n".repeat(7000),content=padding+"export function distantTarget() { return 42; }\n";
  let fullReads=0;
  const io={
    root,cacheKey:"large-fixture",
    discoverFiles:async()=>["src/large.js"],
    metadata:async()=>new Map([["src/large.js",{size:Buffer.byteLength(content),version:"v1"}]]),
    readMany:async()=>new Map([["src/large.js",content]]),
    readText:async()=>{fullReads++;return content},
    gitState:async()=>({isGit:true,changed:new Set(),status:"",diff:""}),
    relativeFocus:path=>path,
  };
  const packet=await new ContextEngine().buildPacket({root,io,task:"Fix distantTarget",maxTokens:1600,maxFiles:4});
  assert.equal(fullReads,1);
  assert.match(packet.injection,/distantTarget/);
  assert.ok(packet.items.some(item=>item.path==="src/large.js"));
});
