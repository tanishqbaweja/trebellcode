import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ContextEngine, createRemoteContextIo, pageRank } from "../src/context-engine.mjs";

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
    assert.ok(session.reasons.some(reason=>/task-related symbol|task terms|path matches/i.test(reason)));
    assert.ok(packet.stats.graphEdges>=3);
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
      if(command==="git"&&args.includes("status"))return ok(status);
      if(command==="git"&&args.includes("diff"))return ok(status?"diff --git a/src/auth/session.js b/src/auth/session.js\n":"");
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
  assert.ok(contentCalls>afterFirstContent,"selected excerpts are refreshed from the remote workspace");
  files.set("src/auth/session.js",files.get("src/auth/session.js")+"export const changed = true;\n");versions.set("src/auth/session.js","v2");status=" M src/auth/session.js\n";
  const third=await engine.buildPacket({root,io,task:"refresh session",maxTokens:1800,maxFiles:8});
  assert.equal(third.stats.reparsed,1);assert.ok(third.stats.reused>=3);
});
