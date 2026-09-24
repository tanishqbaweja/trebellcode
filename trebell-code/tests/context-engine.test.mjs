import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ContextEngine, pageRank } from "../src/context-engine.mjs";

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

test("weighted PageRank makes depended-on files more central",()=>{
  const nodes=["server.js","session.js","token.js"];
  const edges=new Map([
    ["server.js",new Map([["session.js",4]])],
    ["session.js",new Map([["token.js",4]])],
  ]);
  const rank=pageRank(nodes,edges,new Map(nodes.map(node=>[node,1])));
  assert.ok(rank.get("token.js")>rank.get("server.js"));
});
