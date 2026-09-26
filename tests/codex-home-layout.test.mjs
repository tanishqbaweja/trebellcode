import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareCodexHome, resolveCodexHomeLayout } from "../src/codex-home-layout.mjs";

test("Codex direct home preserves continuation identity",()=>{
  const layout=resolveCodexHomeLayout({homePath:"/tmp/shared-codex"});
  assert.equal(layout.mode,"direct");assert.equal(layout.sharedHomePath,resolve("/tmp/shared-codex"));assert.equal(layout.continuationKey,`codex:home:${resolve("/tmp/shared-codex")}`);
});

test("Codex shadow home shares state but keeps auth private",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-shadow-")),shared=join(root,"shared"),shadow=join(root,"shadow");
  try{
    await mkdir(shared,{recursive:true});await mkdir(shadow,{recursive:true});await writeFile(join(shared,"config.toml"),'model="shared"\n');await writeFile(join(shadow,"auth.json"),'{"shadow":true}\n');await writeFile(join(shadow,"models_cache.json"),"private-cache\n");
    const layout=await prepareCodexHome({homePath:shared,shadowHomePath:shadow});assert.equal(layout.mode,"authOverlay");assert.equal(layout.effectiveHomePath,resolve(shadow));
    const configPath=join(shadow,"config.toml"),sharedConfig=join(shared,"config.toml");
    if((await lstat(configPath)).isSymbolicLink())assert.equal(resolve(dirname(configPath),await readlink(configPath)),resolve(sharedConfig));
    else{const [a,b]=await Promise.all([lstat(configPath),lstat(sharedConfig)]);assert.equal(a.ino,b.ino)}
    const sessionsPath=join(shadow,"sessions");assert.equal(resolve(dirname(sessionsPath),await readlink(sessionsPath)),resolve(join(shared,"sessions")));
    assert.equal(await readFile(join(shadow,"auth.json"),"utf8"),'{"shadow":true}\n');
    assert.equal(await readFile(join(shadow,"models_cache.json"),"utf8"),"private-cache\n");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Codex shadow home refuses shared/private path conflicts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-shadow-conflict-")),shared=join(root,"shared"),shadow=join(root,"shadow");
  try{
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shared}),/must be different/i);
    await mkdir(shared,{recursive:true});await mkdir(shadow,{recursive:true});await writeFile(join(shared,"config.toml"),"shared\n");await writeFile(join(shadow,"config.toml"),"local\n");
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shadow}),/already exists and is not a symlink/i);
    await rm(join(shadow,"config.toml"),{force:true});
    const authTarget=join(root,"auth-target");await mkdir(authTarget,{recursive:true});await symlink(authTarget,join(shadow,"auth.json"),process.platform==="win32"?"junction":"dir");
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shadow}),/auth\.json.*real file/i);
  }finally{await rm(root,{recursive:true,force:true})}
});
